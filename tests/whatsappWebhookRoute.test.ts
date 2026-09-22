import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// AlexAgent — thin route-adaptor tests for
// app/api/webhooks/whatsapp/route.ts. Domain logic (parsing/correlation/
// signature HMAC math/inbound command handling) is already covered by
// tests/whatsappWebhook.test.ts and
// tests/whatsappInboundCommands.test.ts against a fake db — this file
// only proves the route's own job: verify-token gating on GET, signature
// gating on POST (before any parsing/DB work), and delegating recognized
// POST events to recordProviderStatus / handleInboundMessage without
// ever touching Planner/Executor/publishing.

const { parseStatusEventsMock, recordProviderStatusMock, verifyWebhookChallengeMock, verifyWebhookSignatureMock, parseInboundMessagesMock, handleInboundMessageMock } = vi.hoisted(() => ({
  parseStatusEventsMock: vi.fn(),
  recordProviderStatusMock: vi.fn(),
  verifyWebhookChallengeMock: vi.fn(),
  verifyWebhookSignatureMock: vi.fn(),
  parseInboundMessagesMock: vi.fn(),
  handleInboundMessageMock: vi.fn(),
}));

vi.mock("@/lib/agent/whatsappWebhook", () => ({
  verifyWebhookChallenge: verifyWebhookChallengeMock,
  verifyWebhookSignature: verifyWebhookSignatureMock,
  parseStatusEvents: parseStatusEventsMock,
  parseInboundMessages: parseInboundMessagesMock,
  recordProviderStatus: recordProviderStatusMock,
}));

vi.mock("@/lib/agent/whatsappInboundCommands", () => ({
  handleInboundMessage: handleInboundMessageMock,
}));

vi.mock("@/lib/agent/whatsappClient", () => ({
  MetaGraphWhatsAppClient: vi.fn().mockImplementation(function FakeWhatsAppClient() {
    return { __fake: "whatsappClient" };
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: vi.fn(() => ({ __fake: "db" })),
}));

import * as route from "@/app/api/webhooks/whatsapp/route";
const { GET, POST } = route;

const TOKEN = "test-webhook-verify-token-do-not-use-in-prod";
const APP_SECRET = "test-app-secret-do-not-use-in-prod";
const VALID_SIGNATURE = "sha256=deterministic-fake-signature-for-tests";

function getVerificationRequest(params: Record<string, string>): Request {
  const url = new URL("http://localhost/api/webhooks/whatsapp");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url, { method: "GET" });
}

function postRequest(body: unknown, signature: string | null = VALID_SIGNATURE): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  return new Request("http://localhost/api/webhooks/whatsapp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("GET /api/webhooks/whatsapp", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    verifyWebhookChallengeMock.mockReset();
    process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN = TOKEN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("1. missing server-side verify token fails closed", async () => {
    delete process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    const response = await GET(getVerificationRequest({ "hub.mode": "subscribe", "hub.verify_token": TOKEN, "hub.challenge": "abc" }));
    expect(response.status).toBe(503);
    expect(verifyWebhookChallengeMock).not.toHaveBeenCalled();
  });

  it("2. a valid verification echoes Meta's exact challenge as plain text", async () => {
    verifyWebhookChallengeMock.mockReturnValue("challenge-xyz");
    const response = await GET(getVerificationRequest({ "hub.mode": "subscribe", "hub.verify_token": TOKEN, "hub.challenge": "challenge-xyz" }));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("challenge-xyz");
  });

  it("3. an invalid verification token is rejected with a non-2xx response", async () => {
    verifyWebhookChallengeMock.mockReturnValue(null);
    const response = await GET(getVerificationRequest({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "abc" }));

    expect(response.status).toBe(403);
  });

  it("4. never echoes the configured verify token in any response", async () => {
    verifyWebhookChallengeMock.mockReturnValue(null);
    const response = await GET(getVerificationRequest({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "abc" }));
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
  });
});

describe("POST /api/webhooks/whatsapp — signature gating", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    parseStatusEventsMock.mockReset();
    recordProviderStatusMock.mockReset();
    verifyWebhookSignatureMock.mockReset();
    parseInboundMessagesMock.mockReset();
    handleInboundMessageMock.mockReset();
    parseStatusEventsMock.mockReturnValue([]);
    parseInboundMessagesMock.mockReturnValue([]);
    process.env.META_WHATSAPP_APP_SECRET = APP_SECRET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("5. missing app secret fails closed (503) before any parsing/DB work", async () => {
    delete process.env.META_WHATSAPP_APP_SECRET;
    const response = await POST(postRequest({ entry: [] }));

    expect(response.status).toBe(503);
    expect(verifyWebhookSignatureMock).not.toHaveBeenCalled();
    expect(parseStatusEventsMock).not.toHaveBeenCalled();
    expect(parseInboundMessagesMock).not.toHaveBeenCalled();
  });

  it("6. missing signature header is rejected (401) before any parsing/DB work", async () => {
    verifyWebhookSignatureMock.mockReturnValue(false);
    const response = await POST(postRequest({ entry: [] }, null));

    expect(response.status).toBe(401);
    expect(parseStatusEventsMock).not.toHaveBeenCalled();
    expect(parseInboundMessagesMock).not.toHaveBeenCalled();
  });

  it("7. an invalid signature is rejected (401) before any parsing/DB work", async () => {
    verifyWebhookSignatureMock.mockReturnValue(false);
    const response = await POST(postRequest({ entry: [] }, "sha256=wrong"));

    expect(response.status).toBe(401);
    expect(parseStatusEventsMock).not.toHaveBeenCalled();
  });

  it("8. verifyWebhookSignature is called with the raw body and configured app secret", async () => {
    verifyWebhookSignatureMock.mockReturnValue(true);
    await POST(postRequest({ entry: [] }));

    expect(verifyWebhookSignatureMock).toHaveBeenCalledTimes(1);
    const call = verifyWebhookSignatureMock.mock.calls[0][0];
    expect(call.appSecret).toBe(APP_SECRET);
    expect(call.signatureHeader).toBe(VALID_SIGNATURE);
    expect(JSON.parse(call.rawBody)).toEqual({ entry: [] });
  });

  it("9. a correctly signed request never exposes the app secret in the response", async () => {
    verifyWebhookSignatureMock.mockReturnValue(true);
    const response = await POST(postRequest({ entry: [] }));
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain(APP_SECRET);
  });

  it("10. an unsigned request never exposes the app secret in the response", async () => {
    verifyWebhookSignatureMock.mockReturnValue(false);
    const response = await POST(postRequest({ entry: [] }, null));
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain(APP_SECRET);
  });
});

describe("POST /api/webhooks/whatsapp — status callbacks (regression, now behind signature check)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    parseStatusEventsMock.mockReset();
    recordProviderStatusMock.mockReset();
    verifyWebhookSignatureMock.mockReset();
    parseInboundMessagesMock.mockReset();
    handleInboundMessageMock.mockReset();
    verifyWebhookSignatureMock.mockReturnValue(true);
    parseInboundMessagesMock.mockReturnValue([]);
    process.env.META_WHATSAPP_APP_SECRET = APP_SECRET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("11. a correctly signed status callback is still forwarded to recordProviderStatus and acked", async () => {
    parseStatusEventsMock.mockReturnValue([{ providerMessageId: "wamid.1", status: "delivered", occurredAt: "2026-09-21T10:00:00.000Z", errorCode: null, errorDetail: null }]);
    recordProviderStatusMock.mockResolvedValue({ matched: true, applied: true });

    const response = await POST(postRequest({ entry: [] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(recordProviderStatusMock).toHaveBeenCalledTimes(1);
  });

  it("12. an unknown/unrelated webhook event still returns success with no recording call", async () => {
    parseStatusEventsMock.mockReturnValue([]);

    const response = await POST(postRequest({ entry: [{ changes: [{ value: { contacts: [] } }] }] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(recordProviderStatusMock).not.toHaveBeenCalled();
    expect(handleInboundMessageMock).not.toHaveBeenCalled();
  });

  it("13. malformed JSON (but validly signed) is rejected with 400 without throwing", async () => {
    verifyWebhookSignatureMock.mockReturnValue(true);
    const response = await POST(new Request("http://localhost/api/webhooks/whatsapp", { method: "POST", headers: { "x-hub-signature-256": VALID_SIGNATURE }, body: "not json" }));
    expect(response.status).toBe(400);
  });

  it("14. a recordProviderStatus failure never fails the ack", async () => {
    parseStatusEventsMock.mockReturnValue([{ providerMessageId: "wamid.1", status: "failed", occurredAt: "2026-09-21T10:00:00.000Z", errorCode: 1, errorDetail: "x" }]);
    recordProviderStatusMock.mockRejectedValue(new Error("simulated db failure with a raw stack trace"));

    const response = await POST(postRequest({ entry: [] }));
    expect(response.status).toBe(200);
  });

  it("15. never exposes secret values in any response, even on failure paths", async () => {
    process.env.META_WHATSAPP_ACCESS_TOKEN = "super-secret-token-value";
    parseStatusEventsMock.mockReturnValue([]);

    const response = await POST(postRequest({ entry: [] }));
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("super-secret-token-value");
    delete process.env.META_WHATSAPP_ACCESS_TOKEN;
  });
});

describe("POST /api/webhooks/whatsapp — inbound message routing", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    parseStatusEventsMock.mockReset();
    recordProviderStatusMock.mockReset();
    verifyWebhookSignatureMock.mockReset();
    parseInboundMessagesMock.mockReset();
    handleInboundMessageMock.mockReset();
    verifyWebhookSignatureMock.mockReturnValue(true);
    parseStatusEventsMock.mockReturnValue([]);
    process.env.META_WHATSAPP_APP_SECRET = APP_SECRET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("16. a recognized inbound message is forwarded to handleInboundMessage and acked", async () => {
    const event = { providerMessageId: "wamid.in-1", from: "573001234567", type: "text", occurredAt: "2026-09-21T10:00:00.000Z", textBody: "Aprobar", contextId: null };
    parseInboundMessagesMock.mockReturnValue([event]);
    handleInboundMessageMock.mockResolvedValue({ processed: true, outcome: "approved" });

    const response = await POST(postRequest({ entry: [] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(handleInboundMessageMock).toHaveBeenCalledTimes(1);
    const call = handleInboundMessageMock.mock.calls[0][0];
    expect(call.event).toEqual(event);
    expect(call.db).toBeDefined();
    expect(call.whatsappClient).toBeDefined();
  });

  it("17. a handleInboundMessage failure never fails the ack", async () => {
    parseInboundMessagesMock.mockReturnValue([{ providerMessageId: "wamid.in-1", from: "573001234567", type: "text", occurredAt: "2026-09-21T10:00:00.000Z", textBody: "Aprobar", contextId: null }]);
    handleInboundMessageMock.mockRejectedValue(new Error("simulated failure"));

    const response = await POST(postRequest({ entry: [] }));
    expect(response.status).toBe(200);
  });

  it("18. an unauthenticated (unsigned) request never reaches handleInboundMessage", async () => {
    verifyWebhookSignatureMock.mockReturnValue(false);
    parseInboundMessagesMock.mockReturnValue([{ providerMessageId: "wamid.in-1", from: "573001234567", type: "text", occurredAt: "2026-09-21T10:00:00.000Z", textBody: "Aprobar", contextId: null }]);

    const response = await POST(postRequest({ entry: [] }, null));

    expect(response.status).toBe(401);
    expect(handleInboundMessageMock).not.toHaveBeenCalled();
  });
});
