import { describe, it, expect } from "vitest";
import { verifyWebhookChallenge, parseStatusEvents, recordProviderStatus } from "@/lib/agent/whatsappWebhook";
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
