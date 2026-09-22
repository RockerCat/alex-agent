import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  verifyWebhookChallenge,
  verifyWebhookSignature,
  parseStatusEvents,
  recordProviderStatus,
  parseInboundMessages,
  resolveDraftForInboundCommand,
} from "@/lib/agent/whatsappWebhook";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

// AlexAgent — WhatsApp Cloud API webhook, diagnostics-only pure logic.
// No real Meta call and no Next.js route involved here — see
// tests/whatsappWebhookRoute.test.ts for the thin route-adaptor tests.
// Fixtures below are sanitized/representative Meta payload shapes, never
// real tokens/phone numbers/provider ids.

const EXPECTED_TOKEN = "fake-verify-token-for-tests-only";

function seedOutboxRow(db: ReturnType<typeof createFakeDb>, overrides: Partial<Record<string, unknown>> = {}) {
  db.seed("notification_outbox", [
    {
      id: "outbox-1",
      brand: "solardesk",
      channel: "whatsapp",
      notification_type: "draft_pending_approval",
      subject_type: "content_draft",
      subject_id: "draft-1",
      subject_version: 1,
      status: "sent",
      provider_message_id: "wamid.HBgLNTczMDAxMjM0NTY=",
      error_message: null,
      agent_run_id: "run-1",
      created_at: "2026-09-21T10:00:00.000Z",
      updated_at: "2026-09-21T10:00:00.000Z",
      sent_at: "2026-09-21T10:00:00.000Z",
      provider_status: null,
      provider_status_at: null,
      provider_error_code: null,
      provider_error_detail: null,
      ...overrides,
    },
  ]);
}

function statusPayload(status: string, extra: Record<string, unknown> = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "REDACTED", phone_number_id: "REDACTED" },
              statuses: [
                {
                  id: "wamid.HBgLNTczMDAxMjM0NTY=",
                  status,
                  timestamp: "1758452400",
                  recipient_id: "REDACTED",
                  ...extra,
                },
              ],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

describe("verifyWebhookChallenge", () => {
  it("1. returns the challenge for a valid subscribe + matching token", () => {
    const result = verifyWebhookChallenge({
      mode: "subscribe",
      token: EXPECTED_TOKEN,
      challenge: "challenge-abc-123",
      expectedToken: EXPECTED_TOKEN,
    });
    expect(result).toBe("challenge-abc-123");
  });

  it("2. rejects a mismatched token", () => {
    const result = verifyWebhookChallenge({
      mode: "subscribe",
      token: "wrong-token",
      challenge: "challenge-abc-123",
      expectedToken: EXPECTED_TOKEN,
    });
    expect(result).toBeNull();
  });

  it("3. rejects a non-subscribe mode", () => {
    const result = verifyWebhookChallenge({
      mode: "unsubscribe",
      token: EXPECTED_TOKEN,
      challenge: "challenge-abc-123",
      expectedToken: EXPECTED_TOKEN,
    });
    expect(result).toBeNull();
  });

  it("4. rejects a missing token/challenge", () => {
    expect(verifyWebhookChallenge({ mode: "subscribe", token: null, challenge: "x", expectedToken: EXPECTED_TOKEN })).toBeNull();
    expect(verifyWebhookChallenge({ mode: "subscribe", token: EXPECTED_TOKEN, challenge: null, expectedToken: EXPECTED_TOKEN })).toBeNull();
  });

  it("5. never leaks the expected token even when it mismatches", () => {
    const result = verifyWebhookChallenge({
      mode: "subscribe",
      token: "wrong-token",
      challenge: "challenge-abc-123",
      expectedToken: EXPECTED_TOKEN,
    });
    expect(JSON.stringify(result)).not.toContain(EXPECTED_TOKEN);
  });
});

describe("parseStatusEvents", () => {
  it("6. extracts a sent/delivered/read status event", () => {
    const events = parseStatusEvents(statusPayload("delivered"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      providerMessageId: "wamid.HBgLNTczMDAxMjM0NTY=",
      status: "delivered",
      errorCode: null,
      errorDetail: null,
    });
    expect(events[0].occurredAt).toBe(new Date(1758452400 * 1000).toISOString());
  });

  it("7. extracts a sanitized error code/detail from a failed status", () => {
    const events = parseStatusEvents(
      statusPayload("failed", {
        errors: [{ code: 131047, title: "Message failed to send because more than 24 hours have passed", message: "Re-engagement message" }],
      })
    );
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("failed");
    expect(events[0].errorCode).toBe(131047);
    expect(events[0].errorDetail).toContain("Message failed to send");
  });

  it("8. ignores inbound messages and unrelated/unknown event shapes", () => {
    const inbound = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ id: "wamid.inbound", from: "REDACTED", text: { body: "hola" } }],
              },
            },
          ],
        },
      ],
    };
    expect(parseStatusEvents(inbound)).toEqual([]);
    expect(parseStatusEvents({})).toEqual([]);
    expect(parseStatusEvents(null)).toEqual([]);
    expect(parseStatusEvents("not an object")).toEqual([]);
  });

  it("9. ignores a status value outside the recognized set", () => {
    const events = parseStatusEvents(statusPayload("some_future_status"));
    expect(events).toEqual([]);
  });
});

describe("recordProviderStatus", () => {
  it("10. correlates by provider_message_id and updates the matching row", async () => {
    const db = createFakeDb();
    seedOutboxRow(db);

    const result = await recordProviderStatus(asSupabaseClient<SupabaseClient<Database>>(db), {
      providerMessageId: "wamid.HBgLNTczMDAxMjM0NTY=",
      status: "sent",
      occurredAt: "2026-09-21T10:01:00.000Z",
      errorCode: null,
      errorDetail: null,
    });

    expect(result).toEqual({ matched: true, applied: true });
    const [row] = db.getAll("notification_outbox");
    expect(row.provider_status).toBe("sent");
    expect(row.provider_status_at).toBe("2026-09-21T10:01:00.000Z");
  });

  it("11. a delivered callback updates provider delivery state", async () => {
    const db = createFakeDb();
    seedOutboxRow(db, { provider_status: "sent", provider_status_at: "2026-09-21T10:01:00.000Z" });

    await recordProviderStatus(asSupabaseClient<SupabaseClient<Database>>(db), {
      providerMessageId: "wamid.HBgLNTczMDAxMjM0NTY=",
      status: "delivered",
      occurredAt: "2026-09-21T10:02:00.000Z",
      errorCode: null,
      errorDetail: null,
    });

    const [row] = db.getAll("notification_outbox");
    expect(row.provider_status).toBe("delivered");
    expect(row.provider_status_at).toBe("2026-09-21T10:02:00.000Z");
  });

  it("12. a read callback updates provider delivery state", async () => {
    const db = createFakeDb();
    seedOutboxRow(db, { provider_status: "delivered", provider_status_at: "2026-09-21T10:02:00.000Z" });

    await recordProviderStatus(asSupabaseClient<SupabaseClient<Database>>(db), {
      providerMessageId: "wamid.HBgLNTczMDAxMjM0NTY=",
      status: "read",
      occurredAt: "2026-09-21T10:03:00.000Z",
      errorCode: null,
      errorDetail: null,
    });

    const [row] = db.getAll("notification_outbox");
    expect(row.provider_status).toBe("read");
    expect(row.provider_status_at).toBe("2026-09-21T10:03:00.000Z");
  });

  it("13. a failed callback persists sanitized failure information", async () => {
    const db = createFakeDb();
    seedOutboxRow(db, { provider_status: "sent", provider_status_at: "2026-09-21T10:01:00.000Z" });

    await recordProviderStatus(asSupabaseClient<SupabaseClient<Database>>(db), {
      providerMessageId: "wamid.HBgLNTczMDAxMjM0NTY=",
      status: "failed",
      occurredAt: "2026-09-21T10:02:00.000Z",
      errorCode: 131047,
      errorDetail: "Message failed to send because more than 24 hours have passed",
    });

    const [row] = db.getAll("notification_outbox");
    expect(row.provider_status).toBe("failed");
    expect(row.provider_error_code).toBe(131047);
    expect(row.provider_error_detail).toBe("Message failed to send because more than 24 hours have passed");
  });

  it("14. an out-of-order (older) callback is ignored rather than regressing state", async () => {
    const db = createFakeDb();
    seedOutboxRow(db, { provider_status: "read", provider_status_at: "2026-09-21T10:03:00.000Z" });

    const result = await recordProviderStatus(asSupabaseClient<SupabaseClient<Database>>(db), {
      providerMessageId: "wamid.HBgLNTczMDAxMjM0NTY=",
      status: "sent",
      occurredAt: "2026-09-21T10:01:00.000Z",
      errorCode: null,
      errorDetail: null,
    });

    expect(result).toEqual({ matched: true, applied: false });
    const [row] = db.getAll("notification_outbox");
    expect(row.provider_status).toBe("read");
  });

  it("15. an unrelated/unknown provider_message_id is safely dropped — no row is created or mutated", async () => {
    const db = createFakeDb();
    seedOutboxRow(db);

    const result = await recordProviderStatus(asSupabaseClient<SupabaseClient<Database>>(db), {
      providerMessageId: "wamid.some-other-message-id",
      status: "delivered",
      occurredAt: "2026-09-21T10:02:00.000Z",
      errorCode: null,
      errorDetail: null,
    });

    expect(result).toEqual({ matched: false, applied: false });
    expect(db.getAll("notification_outbox")).toHaveLength(1);
    expect(db.getAll("notification_outbox")[0].provider_status).toBeNull();
  });

  it("16. never creates a duplicate outbox row for a status callback", async () => {
    const db = createFakeDb();
    seedOutboxRow(db);

    await recordProviderStatus(asSupabaseClient<SupabaseClient<Database>>(db), {
      providerMessageId: "wamid.HBgLNTczMDAxMjM0NTY=",
      status: "sent",
      occurredAt: "2026-09-21T10:01:00.000Z",
      errorCode: null,
      errorDetail: null,
    });
    await recordProviderStatus(asSupabaseClient<SupabaseClient<Database>>(db), {
      providerMessageId: "wamid.HBgLNTczMDAxMjM0NTY=",
      status: "delivered",
      occurredAt: "2026-09-21T10:02:00.000Z",
      errorCode: null,
      errorDetail: null,
    });

    expect(db.getAll("notification_outbox")).toHaveLength(1);
  });

  it("17. never mutates the draft/question workflow — only notification_outbox is touched", async () => {
    const db = createFakeDb();
    seedOutboxRow(db);
    db.seed("content_drafts", [{ id: "draft-1", status: "pending_approval", version: 1 }]);

    await recordProviderStatus(asSupabaseClient<SupabaseClient<Database>>(db), {
      providerMessageId: "wamid.HBgLNTczMDAxMjM0NTY=",
      status: "read",
      occurredAt: "2026-09-21T10:02:00.000Z",
      errorCode: null,
      errorDetail: null,
    });

    expect(db.getAll("content_drafts")).toEqual([{ id: "draft-1", status: "pending_approval", version: 1 }]);
  });
});

const APP_SECRET = "fake-app-secret-for-tests-only";

function signBody(body: string, secret: string = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

describe("verifyWebhookSignature", () => {
  it("18. accepts a correctly signed body", () => {
    const rawBody = JSON.stringify({ entry: [] });
    const signatureHeader = signBody(rawBody);
    expect(verifyWebhookSignature({ rawBody, signatureHeader, appSecret: APP_SECRET })).toBe(true);
  });

  it("19. rejects a missing signature header", () => {
    const rawBody = JSON.stringify({ entry: [] });
    expect(verifyWebhookSignature({ rawBody, signatureHeader: null, appSecret: APP_SECRET })).toBe(false);
  });

  it("20. rejects a malformed signature header (no sha256= prefix)", () => {
    const rawBody = JSON.stringify({ entry: [] });
    expect(verifyWebhookSignature({ rawBody, signatureHeader: "not-a-valid-signature", appSecret: APP_SECRET })).toBe(false);
  });

  it("21. rejects an invalid signature (wrong secret)", () => {
    const rawBody = JSON.stringify({ entry: [] });
    const signatureHeader = signBody(rawBody, "a-different-secret");
    expect(verifyWebhookSignature({ rawBody, signatureHeader, appSecret: APP_SECRET })).toBe(false);
  });

  it("22. rejects a signature computed over a different body (tampered payload)", () => {
    const signatureHeader = signBody(JSON.stringify({ entry: [{ tampered: true }] }));
    const rawBody = JSON.stringify({ entry: [] });
    expect(verifyWebhookSignature({ rawBody, signatureHeader, appSecret: APP_SECRET })).toBe(false);
  });

  it("23. rejects a non-hex signature body without throwing", () => {
    const rawBody = JSON.stringify({ entry: [] });
    expect(verifyWebhookSignature({ rawBody, signatureHeader: `sha256=${"z".repeat(64)}`, appSecret: APP_SECRET })).toBe(false);
  });

  it("24. never leaks the app secret in its return value", () => {
    const rawBody = JSON.stringify({ entry: [] });
    const result = verifyWebhookSignature({ rawBody, signatureHeader: "sha256=wrong", appSecret: APP_SECRET });
    expect(JSON.stringify(result)).not.toContain(APP_SECRET);
  });
});

function inboundPayload(message: Record<string, unknown>) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

describe("parseInboundMessages", () => {
  it("25. extracts a text message with id/sender/type/body", () => {
    const events = parseInboundMessages(inboundPayload({ id: "wamid.in-1", from: "573000000001", type: "text", timestamp: "1758452400", text: { body: "Aprobar" } }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ providerMessageId: "wamid.in-1", from: "573000000001", type: "text", textBody: "Aprobar", contextId: null });
    expect(events[0].occurredAt).toBe(new Date(1758452400 * 1000).toISOString());
  });

  it("26. extracts context.id when the message is a reply", () => {
    const events = parseInboundMessages(inboundPayload({ id: "wamid.in-1", from: "573000000001", type: "text", timestamp: "1758452400", text: { body: "Rechazar" }, context: { id: "wamid.original-1" } }));
    expect(events[0].contextId).toBe("wamid.original-1");
  });

  it("27. a non-text message type carries no textBody but is still extracted (id/from/type)", () => {
    const events = parseInboundMessages(inboundPayload({ id: "wamid.in-2", from: "573000000001", type: "image", timestamp: "1758452400" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "image", textBody: null });
  });

  it("28. an unrelated webhook payload (status callback shape) yields no inbound events", () => {
    const statusPayload = { entry: [{ changes: [{ value: { statuses: [{ id: "wamid.1", status: "delivered", timestamp: "1" }] } }] }] };
    expect(parseInboundMessages(statusPayload)).toEqual([]);
    expect(parseInboundMessages({})).toEqual([]);
    expect(parseInboundMessages(null)).toEqual([]);
  });

  it("29. malformed/missing required fields are skipped, not thrown", () => {
    expect(parseInboundMessages(inboundPayload({ from: "573000000001", type: "text", text: { body: "Aprobar" } }))).toEqual([]);
    expect(parseInboundMessages(inboundPayload({ id: "wamid.in-1", type: "text", text: { body: "Aprobar" } }))).toEqual([]);
  });
});

function seedPendingDraft(db: ReturnType<typeof createFakeDb>, overrides: Partial<Record<string, unknown>> = {}) {
  db.seed("content_drafts", [
    { id: "draft-1", brand: "solardesk", status: "pending_approval", version: 1, created_at: "2026-09-21T09:00:00.000Z", ...overrides },
  ]);
}

describe("resolveDraftForInboundCommand", () => {
  it("30. context.id resolves the exact draft via provider_message_id correlation", async () => {
    const db = createFakeDb();
    seedOutboxRow(db, { provider_message_id: "wamid.original-1", subject_id: "draft-1" });
    const result = await resolveDraftForInboundCommand(asSupabaseClient<SupabaseClient<Database>>(db), "wamid.original-1");
    expect(result).toEqual({ outcome: "resolved", draftId: "draft-1" });
  });

  it("31. a reply to an OLDER notification resolves that exact draft, not a newer one", async () => {
    const db = createFakeDb();
    db.seed("notification_outbox", [
      { id: "outbox-old", brand: "solardesk", channel: "whatsapp", notification_type: "draft_pending_approval", subject_type: "content_draft", subject_id: "draft-old", subject_version: 1, status: "sent", provider_message_id: "wamid.old", created_at: "2026-09-20T09:00:00.000Z" },
      { id: "outbox-new", brand: "solardesk", channel: "whatsapp", notification_type: "draft_pending_approval", subject_type: "content_draft", subject_id: "draft-new", subject_version: 1, status: "sent", provider_message_id: "wamid.new", created_at: "2026-09-21T09:00:00.000Z" },
    ]);
    const result = await resolveDraftForInboundCommand(asSupabaseClient<SupabaseClient<Database>>(db), "wamid.old");
    expect(result).toEqual({ outcome: "resolved", draftId: "draft-old" });
  });

  it("32. a context.id that cannot be resolved mutates nothing and reports unresolved_context", async () => {
    const db = createFakeDb();
    const result = await resolveDraftForInboundCommand(asSupabaseClient<SupabaseClient<Database>>(db), "wamid.unknown");
    expect(result).toEqual({ outcome: "unresolved_context" });
  });

  it("33. no context + exactly one pending candidate resolves it", async () => {
    const db = createFakeDb();
    seedPendingDraft(db);
    const result = await resolveDraftForInboundCommand(asSupabaseClient<SupabaseClient<Database>>(db), null);
    expect(result).toEqual({ outcome: "resolved", draftId: "draft-1" });
  });

  it("34. no context + zero pending candidates mutates nothing", async () => {
    const db = createFakeDb();
    const result = await resolveDraftForInboundCommand(asSupabaseClient<SupabaseClient<Database>>(db), null);
    expect(result).toEqual({ outcome: "no_candidate" });
  });

  it("35. no context + multiple pending candidates mutates nothing (never guesses)", async () => {
    const db = createFakeDb();
    seedPendingDraft(db, { id: "draft-1" });
    db.seed("content_drafts", [
      { id: "draft-1", brand: "solardesk", status: "pending_approval", version: 1, created_at: "2026-09-21T09:00:00.000Z" },
      { id: "draft-2", brand: "solardesk", status: "pending_approval", version: 1, created_at: "2026-09-21T09:05:00.000Z" },
    ]);
    const result = await resolveDraftForInboundCommand(asSupabaseClient<SupabaseClient<Database>>(db), null);
    expect(result).toEqual({ outcome: "ambiguous_candidates" });
  });
});
