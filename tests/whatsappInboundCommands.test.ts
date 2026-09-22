import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleInboundMessage, parseInboundCommand, isAuthorizedSender } from "@/lib/agent/whatsappInboundCommands";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { ScriptedWhatsAppClient } from "@/tests/support/fakeWhatsAppClient";
import type { InboundMessageEvent } from "@/lib/agent/whatsappWebhook";

// AlexAgent — WhatsApp Inbound Phase 1 behavioral tests. Uses the REAL
// approveDraft/rejectDraft (lib/agent/approvals.ts) against a fake db —
// this module has zero content_drafts SQL/state-guard logic of its own,
// so exercising it end-to-end against the real domain functions is the
// most direct proof that no business rule is duplicated. A separate
// mock-based suite below additionally proves exact delegation.

const DESTINATION = "+573001234567";
const SENDER_DIGITS_ONLY = "573001234567"; // Meta's `from` typically omits the leading "+"

function buildEvent(overrides: Partial<InboundMessageEvent> = {}): InboundMessageEvent {
  return {
    providerMessageId: "wamid.in-1",
    from: SENDER_DIGITS_ONLY,
    type: "text",
    occurredAt: "2026-09-21T10:00:00.000Z",
    textBody: "Aprobar",
    contextId: null,
    ...overrides,
  };
}

function seedPendingDraft(db: ReturnType<typeof createFakeDb>, overrides: Partial<Record<string, unknown>> = {}) {
  db.seed("content_drafts", [
    { id: "draft-1", brand: "solardesk", status: "pending_approval", version: 1, created_at: "2026-09-21T09:00:00.000Z", ...overrides },
  ]);
}

describe("parseInboundCommand", () => {
  it("1. recognizes exact 'aprobar'", () => {
    expect(parseInboundCommand("aprobar")).toBe("aprobar");
  });

  it("2. normalizes outer whitespace and capitalization", () => {
    expect(parseInboundCommand("  Aprobar  ")).toBe("aprobar");
    expect(parseInboundCommand("APROBAR")).toBe("aprobar");
  });

  it("3. recognizes exact 'rechazar'", () => {
    expect(parseInboundCommand("Rechazar")).toBe("rechazar");
  });

  it.each(["si", "sí", "no", "ok", "approve", "reject", "yes", "Apruebo el borrador", "aprobar por favor", "aprovar"])(
    "4. does NOT recognize unsupported/fuzzy/alias text: %s",
    (text) => {
      expect(parseInboundCommand(text)).toBeNull();
    }
  );
});

describe("isAuthorizedSender", () => {
  it("5. accepts the configured destination number (digit-only comparison)", () => {
    expect(isAuthorizedSender(SENDER_DIGITS_ONLY, DESTINATION)).toBe(true);
  });

  it("6. rejects an unknown sender", () => {
    expect(isAuthorizedSender("15550001234", DESTINATION)).toBe(false);
  });

  it("7. fails closed on a missing sender", () => {
    expect(isAuthorizedSender(null, DESTINATION)).toBe(false);
  });

  it("8. fails closed on missing destination configuration", () => {
    expect(isAuthorizedSender(SENDER_DIGITS_ONLY, null)).toBe(false);
  });
});

describe("handleInboundMessage", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.META_WHATSAPP_DESTINATION_NUMBER = DESTINATION;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("9. non-text message types are ignored — no claim, no mutation, no reply", async () => {
    const db = createFakeDb();
    const whatsappClient = new ScriptedWhatsAppClient();
    seedPendingDraft(db);

    const result = await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent({ type: "image", textBody: null }) });

    expect(result).toEqual({ processed: false, outcome: "ignored_non_text" });
    expect(db.getAll("whatsapp_inbound_events")).toHaveLength(0);
    expect(db.getAll("content_drafts")[0].status).toBe("pending_approval");
    expect(whatsappClient.textCalls).toHaveLength(0);
  });

  it("10. an unauthorized sender is rejected — no mutation, no reply, but the message id is still claimed", async () => {
    const db = createFakeDb();
    const whatsappClient = new ScriptedWhatsAppClient();
    seedPendingDraft(db);

    const result = await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent({ from: "19995550000" }) });

    expect(result).toEqual({ processed: true, outcome: "unauthorized_sender" });
    expect(db.getAll("content_drafts")[0].status).toBe("pending_approval");
    expect(whatsappClient.textCalls).toHaveLength(0);
    const rows = db.getAll("whatsapp_inbound_events");
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("unauthorized_sender");
  });

  it("11. missing destination configuration fails closed — no mutation", async () => {
    delete process.env.META_WHATSAPP_DESTINATION_NUMBER;
    const db = createFakeDb();
    const whatsappClient = new ScriptedWhatsAppClient();
    seedPendingDraft(db);

    const result = await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent() });

    expect(result.outcome).toBe("unauthorized_sender");
    expect(db.getAll("content_drafts")[0].status).toBe("pending_approval");
  });

  it("12. an unsupported command sends exactly one deterministic reply and mutates nothing", async () => {
    const db = createFakeDb();
    const whatsappClient = new ScriptedWhatsAppClient();
    seedPendingDraft(db);

    const result = await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent({ textBody: "sí" }) });

    expect(result).toEqual({ processed: true, outcome: "unsupported_command" });
    expect(db.getAll("content_drafts")[0].status).toBe("pending_approval");
    expect(whatsappClient.textCalls).toHaveLength(1);
    expect(whatsappClient.textCalls[0].to).toBe(SENDER_DIGITS_ONLY);
  });

  it("13. no-context + zero/multiple candidates sends a deterministic ambiguity reply and mutates nothing", async () => {
    const db = createFakeDb();
    const whatsappClient = new ScriptedWhatsAppClient();

    const zeroResult = await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent({ providerMessageId: "wamid.a" }) });
    expect(zeroResult.outcome).toBe("no_candidate");

    db.seed("content_drafts", [
      { id: "draft-1", brand: "solardesk", status: "pending_approval", version: 1, created_at: "2026-09-21T09:00:00.000Z" },
      { id: "draft-2", brand: "solardesk", status: "pending_approval", version: 1, created_at: "2026-09-21T09:05:00.000Z" },
    ]);
    const multiResult = await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent({ providerMessageId: "wamid.b" }) });
    expect(multiResult.outcome).toBe("ambiguous_candidates");

    expect(db.getAll("content_drafts").every((d) => d.status === "pending_approval")).toBe(true);
    expect(whatsappClient.textCalls).toHaveLength(2);
  });

  it("14. an unresolvable context.id sends a deterministic reply and mutates nothing", async () => {
    const db = createFakeDb();
    const whatsappClient = new ScriptedWhatsAppClient();
    seedPendingDraft(db);

    const result = await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent({ contextId: "wamid.unknown" }) });

    expect(result.outcome).toBe("unresolved_context");
    expect(db.getAll("content_drafts")[0].status).toBe("pending_approval");
  });

  it("15. a successful approval calls the real approveDraft, updates the draft, and sends one confirmation", async () => {
    const db = createFakeDb();
    const whatsappClient = new ScriptedWhatsAppClient();
    seedPendingDraft(db);

    const result = await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent({ textBody: "Aprobar" }) });

    expect(result).toEqual({ processed: true, outcome: "approved" });
    expect(db.getAll("content_drafts")[0].status).toBe("approved");
    expect(whatsappClient.textCalls).toHaveLength(1);
    expect(whatsappClient.textCalls[0].body.toLowerCase()).toContain("aprobado");
  });

  it("16. a successful rejection calls the real rejectDraft, updates the draft, and sends one confirmation", async () => {
    const db = createFakeDb();
    const whatsappClient = new ScriptedWhatsAppClient();
    seedPendingDraft(db);

    const result = await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent({ textBody: "Rechazar" }) });

    expect(result).toEqual({ processed: true, outcome: "rejected" });
    expect(db.getAll("content_drafts")[0].status).toBe("rejected");
    expect(whatsappClient.textCalls[0].body.toLowerCase()).toContain("rechazado");
  });

  it("17. an already-resolved (no longer pending) draft surfaces the authoritative state-guard failure, not a mutation", async () => {
    const db = createFakeDb();
    const whatsappClient = new ScriptedWhatsAppClient();
    // Correlated via context.id (which doesn't filter by status) so the
    // draft the reply refers to is looked up even though it's already
    // approved — exercising approveDraft's own state guard rather than
    // the fallback's "no pending candidates" path (a different, already
    // separately-tested outcome).
    seedPendingDraft(db, { status: "approved" });
    db.seed("notification_outbox", [
      { id: "outbox-1", brand: "solardesk", channel: "whatsapp", notification_type: "draft_pending_approval", subject_type: "content_draft", subject_id: "draft-1", subject_version: 1, status: "sent", provider_message_id: "wamid.original-1", created_at: "2026-09-21T09:00:00.000Z" },
    ]);

    const result = await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent({ textBody: "Aprobar", contextId: "wamid.original-1" }) });

    expect(result).toEqual({ processed: true, outcome: "state_guard_failed" });
    expect(db.getAll("content_drafts")[0].status).toBe("approved");
    expect(whatsappClient.textCalls).toHaveLength(1);
  });

  it("18. context.id resolves the exact draft it was sent for, not any newer pending draft", async () => {
    const db = createFakeDb();
    const whatsappClient = new ScriptedWhatsAppClient();
    db.seed("content_drafts", [
      { id: "draft-old", brand: "solardesk", status: "pending_approval", version: 1, created_at: "2026-09-20T09:00:00.000Z" },
      { id: "draft-new", brand: "solardesk", status: "pending_approval", version: 1, created_at: "2026-09-21T09:00:00.000Z" },
    ]);
    db.seed("notification_outbox", [
      { id: "outbox-old", brand: "solardesk", channel: "whatsapp", notification_type: "draft_pending_approval", subject_type: "content_draft", subject_id: "draft-old", subject_version: 1, status: "sent", provider_message_id: "wamid.old", created_at: "2026-09-20T09:00:00.000Z" },
    ]);

    const result = await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent({ contextId: "wamid.old", textBody: "Aprobar" }) });

    expect(result).toEqual({ processed: true, outcome: "approved" });
    const drafts = db.getAll("content_drafts");
    expect(drafts.find((d) => d.id === "draft-old")!.status).toBe("approved");
    expect(drafts.find((d) => d.id === "draft-new")!.status).toBe("pending_approval");
  });

  describe("idempotency", () => {
    it("19. the first delivery of an inbound message id is claimed and processed", async () => {
      const db = createFakeDb();
      const whatsappClient = new ScriptedWhatsAppClient();
      seedPendingDraft(db);

      const result = await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent() });

      expect(result.processed).toBe(true);
      expect(db.getAll("whatsapp_inbound_events")).toHaveLength(1);
    });

    it("20. a duplicate delivery of the same inbound message id does not process again", async () => {
      const db = createFakeDb();
      const whatsappClient = new ScriptedWhatsAppClient();
      seedPendingDraft(db);

      await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent() });
      const secondResult = await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent() });

      expect(secondResult).toEqual({ processed: false, outcome: "duplicate" });
      // Only ever approved once — the draft is not re-mutated (and
      // approveDraft's own state guard would safely no-op it anyway).
      expect(db.getAll("content_drafts")[0].status).toBe("approved");
    });

    it("21. a duplicate delivery never sends a second confirmation message", async () => {
      const db = createFakeDb();
      const whatsappClient = new ScriptedWhatsAppClient();
      seedPendingDraft(db);

      await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent() });
      await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent() });

      expect(whatsappClient.textCalls).toHaveLength(1);
    });

    it("22. a duplicate delivery never creates a second idempotency row", async () => {
      const db = createFakeDb();
      const whatsappClient = new ScriptedWhatsAppClient();
      seedPendingDraft(db);

      await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent() });
      await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent() });

      expect(db.getAll("whatsapp_inbound_events")).toHaveLength(1);
    });
  });

  describe("confirmation-send failure isolation", () => {
    it("23. a confirmation-send failure never rolls back an already-successful draft mutation", async () => {
      const db = createFakeDb();
      const whatsappClient = new ScriptedWhatsAppClient({ textFailWith: new Error("simulated transport failure") });
      seedPendingDraft(db);

      const result = await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent({ textBody: "Aprobar" }) });

      expect(result).toEqual({ processed: true, outcome: "approved" });
      expect(db.getAll("content_drafts")[0].status).toBe("approved");
    });

    it("24. a confirmation-send failure never throws out of handleInboundMessage", async () => {
      const db = createFakeDb();
      const whatsappClient = new ScriptedWhatsAppClient({ textFailWith: new Error("simulated transport failure") });
      seedPendingDraft(db);

      await expect(handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent({ textBody: "Aprobar" }) })).resolves.toBeDefined();
    });
  });

  it("25. no sensitive identifiers appear in the persisted idempotency row", async () => {
    const db = createFakeDb();
    const whatsappClient = new ScriptedWhatsAppClient();
    seedPendingDraft(db);

    await handleInboundMessage({ db: asSupabaseClient(db), whatsappClient, event: buildEvent({ from: "19995550000" }) });

    const row = db.getAll("whatsapp_inbound_events")[0];
    expect(JSON.stringify(row)).not.toContain("19995550000");
    expect(JSON.stringify(row)).not.toContain(DESTINATION);
  });
});

describe("domain reuse — delegates to the existing authoritative mutation, never reimplements it", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.META_WHATSAPP_DESTINATION_NUMBER = DESTINATION;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock("@/lib/agent/approvals");
  });

  it("26. approval calls the real exported approveDraft(db, draftId) — not a reimplementation", async () => {
    const approveDraftMock = vi.fn().mockResolvedValue({ ok: true });
    const rejectDraftMock = vi.fn();
    vi.doMock("@/lib/agent/approvals", () => ({ approveDraft: approveDraftMock, rejectDraft: rejectDraftMock }));

    const { handleInboundMessage: freshHandle } = await import("@/lib/agent/whatsappInboundCommands");
    const db = createFakeDb();
    seedPendingDraft(db);
    const whatsappClient = new ScriptedWhatsAppClient();

    await freshHandle({ db: asSupabaseClient(db), whatsappClient, event: buildEvent({ textBody: "Aprobar" }) });

    expect(approveDraftMock).toHaveBeenCalledTimes(1);
    expect(approveDraftMock).toHaveBeenCalledWith(expect.anything(), "draft-1");
    expect(rejectDraftMock).not.toHaveBeenCalled();
  });

  it("27. rejection calls the real exported rejectDraft(db, draftId) — not a reimplementation", async () => {
    const approveDraftMock = vi.fn();
    const rejectDraftMock = vi.fn().mockResolvedValue({ ok: true });
    vi.doMock("@/lib/agent/approvals", () => ({ approveDraft: approveDraftMock, rejectDraft: rejectDraftMock }));

    const { handleInboundMessage: freshHandle } = await import("@/lib/agent/whatsappInboundCommands");
    const db = createFakeDb();
    seedPendingDraft(db);
    const whatsappClient = new ScriptedWhatsAppClient();

    await freshHandle({ db: asSupabaseClient(db), whatsappClient, event: buildEvent({ textBody: "Rechazar" }) });

    expect(rejectDraftMock).toHaveBeenCalledTimes(1);
    expect(rejectDraftMock).toHaveBeenCalledWith(expect.anything(), "draft-1");
    expect(approveDraftMock).not.toHaveBeenCalled();
  });
});
