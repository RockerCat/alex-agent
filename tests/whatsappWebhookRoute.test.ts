import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// AlexAgent — thin route-adaptor tests for
// app/api/webhooks/whatsapp/route.ts. Domain logic (parsing/correlation)
// is already covered by tests/whatsappWebhook.test.ts against a fake db
// — this file only proves the route's own job: verify-token gating on
// GET, and delegating recognized POST events to recordProviderStatus
// without ever touching Planner/Executor/publishing.

const { parseStatusEventsMock, recordProviderStatusMock, verifyWebhookChallengeMock } = vi.hoisted(() => ({
  parseStatusEventsMock: vi.fn(),
  recordProviderStatusMock: vi.fn(),
  verifyWebhookChallengeMock: vi.fn(),
}));

vi.mock("@/lib/agent/whatsappWebhook", () => ({
  verifyWebhookChallenge: verifyWebhookChallengeMock,
  parseStatusEvents: parseStatusEventsMock,
  recordProviderStatus: recordProviderStatusMock,
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: vi.fn(() => ({ __fake: "db" })),
}));

import * as route from "@/app/api/webhooks/whatsapp/route";
const { GET, POST } = route;

const TOKEN = "test-webhook-verify-token-do-not-use-in-prod";

function getVerificationRequest(params: Record<string, string>): Request {
  const url = new URL("http://localhost/api/webhooks/whatsapp");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url, { method: "GET" });
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/webhooks/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json" },
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

describe("POST /api/webhooks/whatsapp", () => {
  beforeEach(() => {
    parseStatusEventsMock.mockReset();
    recordProviderStatusMock.mockReset();
  });

  it("5. a status callback is forwarded to recordProviderStatus and acked", async () => {
    parseStatusEventsMock.mockReturnValue([{ providerMessageId: "wamid.1", status: "delivered", occurredAt: "2026-09-21T10:00:00.000Z", errorCode: null, errorDetail: null }]);
    recordProviderStatusMock.mockResolvedValue({ matched: true, applied: true });

    const response = await POST(postRequest({ entry: [] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(recordProviderStatusMock).toHaveBeenCalledTimes(1);
  });

  it("6. an unknown/unrelated webhook event (no recognized status) still returns success with no recording call", async () => {
    parseStatusEventsMock.mockReturnValue([]);

    const response = await POST(postRequest({ entry: [{ changes: [{ value: { messages: [{ id: "wamid.inbound" }] } }] }] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(recordProviderStatusMock).not.toHaveBeenCalled();
  });

  it("7. malformed JSON is rejected with 400 without throwing", async () => {
    const response = await POST(new Request("http://localhost/api/webhooks/whatsapp", { method: "POST", body: "not json" }));
    expect(response.status).toBe(400);
  });

  it("8. a recordProviderStatus failure never fails the ack (Meta retries aggressively on non-2xx)", async () => {
    parseStatusEventsMock.mockReturnValue([{ providerMessageId: "wamid.1", status: "failed", occurredAt: "2026-09-21T10:00:00.000Z", errorCode: 1, errorDetail: "x" }]);
    recordProviderStatusMock.mockRejectedValue(new Error("simulated db failure with a raw stack trace"));

    const response = await POST(postRequest({ entry: [] }));
    expect(response.status).toBe(200);
  });

  it("9. never exposes secret values in any response, even on failure paths", async () => {
    process.env.META_WHATSAPP_ACCESS_TOKEN = "super-secret-token-value";
    parseStatusEventsMock.mockReturnValue([]);

    const response = await POST(postRequest({ entry: [] }));
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("super-secret-token-value");
    delete process.env.META_WHATSAPP_ACCESS_TOKEN;
  });
});
