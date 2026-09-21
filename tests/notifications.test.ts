import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { notifyAttentionIfNeeded } from "@/lib/agent/notifications";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { ScriptedWhatsAppClient, whatsappRejection } from "@/tests/support/fakeWhatsAppClient";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

// AlexAgent — WhatsApp outbound attention notifications (Autonomy v1,
// outbound only). Behavioral tests only: no real Meta Graph API call is
// ever made — Meta is a ScriptedWhatsAppClient fake (mirrors
// tests/publishInstagram.test.ts's pattern), so notifyAttentionIfNeeded's
// idempotency/failure/brand-isolation behavior is testable without
// depending on the real Meta template ever being approved.

const REAL_TOKEN = "fake-whatsapp-token-for-tests-only";
const RUN_ID = "run-1";

function buildDraft(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    plan_id: "plan-1",
    brand: "solardesk",
    created_by_run: null,
    channel: "instagram",
    content_type: "image_post",
    purpose: "activation",
    topic: "Comienza gratis en SolarDesk",
    audience: "Instaladores",
    cta: "Comenzar gratis",
    cta_url: null,
    target_date: "2026-09-20",
    status: "pending_approval",
    version: 1,
    title: "Comienza gratis en SolarDesk",
    hook: "¿Sigues armando propuestas solares en hojas de cálculo?",
    body: { slides: [] },
    caption: null,
    cta_text: null,
    visual_direction: null,
    hashtags: [],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildQuestion(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    brand: "solardesk",
    question: "¿Cuál es el precio actual del plan Pro de SolarDesk?",
    reason: "No verificado en Product Truth.",
    status: "open",
    blocks_progress: true,
    answer: null,
    context_run_id: RUN_ID,
    context_plan_id: null,
    context_draft_id: null,
    created_at: new Date().toISOString(),
    answered_at: null,
    ...overrides,
  };
}

function setup() {
  const fake = createFakeDb();
  const db = asSupabaseClient<SupabaseClient<Database>>(fake);
  return { fake, db };
}

describe("notifyAttentionIfNeeded", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.META_WHATSAPP_ACCESS_TOKEN = REAL_TOKEN;
    process.env.META_WHATSAPP_PHONE_NUMBER_ID = "111222333444555";
    process.env.META_WHATSAPP_DESTINATION_NUMBER = "+573001234567";
    process.env.NEXT_PUBLIC_APP_URL = "https://alexagent.example.com";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("pending draft approval", () => {
    it("1. sends one notification for a pending draft, with the correct template variables and destination", async () => {
      const { fake, db } = setup();
      fake.seed("content_drafts", [buildDraft("draft-1")]);
      const whatsappClient = new ScriptedWhatsAppClient({ messageId: "wamid.1" });

      const summary = await notifyAttentionIfNeeded({ db, whatsappClient, brand: "solardesk", runId: RUN_ID, runDecision: "WAIT_FOR_APPROVAL" });

      expect(summary.attempted).toBe(1);
      expect(summary.sent).toBe(1);
      expect(whatsappClient.sendCalls).toHaveLength(1);
      const call = whatsappClient.sendCalls[0];
      expect(call.to).toBe("+573001234567");
      expect(call.templateName).toBe("alexagent_attention_required");
      expect(call.languageCode).toBe("es_CO");
      expect(call.bodyParameters).toHaveLength(3);
      expect(call.bodyParameters[0]).toBe("SolarDesk");
      expect(call.bodyParameters[1]).toBe("un contenido pendiente de aprobación");
      expect(call.bodyParameters[2]).toContain("Comienza gratis en SolarDesk");
      expect(call.bodyParameters[2]).toContain("/approvals/draft-1");

      const outboxRows = fake.getAll("notification_outbox");
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0].status).toBe("sent");
      expect(outboxRows[0].provider_message_id).toBe("wamid.1");
    });

    it("2. a second invocation for the same unchanged pending draft sends nothing — no daily spam", async () => {
      const { fake, db } = setup();
      fake.seed("content_drafts", [buildDraft("draft-1")]);
      const whatsappClient = new ScriptedWhatsAppClient({ messageId: "wamid.1" });

      await notifyAttentionIfNeeded({ db, whatsappClient, brand: "solardesk", runId: RUN_ID, runDecision: "WAIT_FOR_APPROVAL" });
      const second = await notifyAttentionIfNeeded({ db, whatsappClient, brand: "solardesk", runId: "run-2", runDecision: "WAIT_FOR_APPROVAL" });

      expect(second.attempted).toBe(1);
      expect(second.sent).toBe(0);
      expect(second.alreadySent).toBe(1);
      expect(whatsappClient.sendCalls).toHaveLength(1); // still just the first call
      expect(fake.getAll("notification_outbox")).toHaveLength(1);
    });

    it("3. a real revision (version increments) produces a new, independent notification", async () => {
      const { fake, db } = setup();
      fake.seed("content_drafts", [buildDraft("draft-1", { version: 1 })]);
      const whatsappClient = new ScriptedWhatsAppClient({ messageId: "wamid.v1" });
      await notifyAttentionIfNeeded({ db, whatsappClient, brand: "solardesk", runId: RUN_ID, runDecision: "WAIT_FOR_APPROVAL" });

      // Simulate a "Request Changes" revision cycle bumping the version
      // and returning to pending_approval.
      fake.seed("content_drafts", [buildDraft("draft-1", { version: 2, title: "Revised title" })]);
      const summary = await notifyAttentionIfNeeded({ db, whatsappClient, brand: "solardesk", runId: "run-2", runDecision: "WAIT_FOR_APPROVAL" });

      expect(summary.sent).toBe(1);
      expect(whatsappClient.sendCalls).toHaveLength(2);
      expect(whatsappClient.sendCalls[1].bodyParameters[2]).toContain("Revised title");
      expect(fake.getAll("notification_outbox")).toHaveLength(2);
    });

    it("4. a provider failure is persisted as failed, and never leaks the access token into the stored error", async () => {
      const { fake, db } = setup();
      fake.seed("content_drafts", [buildDraft("draft-1")]);
      const whatsappClient = new ScriptedWhatsAppClient({ failWith: whatsappRejection("Template alexagent_attention_required is not approved yet.") });

      const summary = await notifyAttentionIfNeeded({ db, whatsappClient, brand: "solardesk", runId: RUN_ID, runDecision: "WAIT_FOR_APPROVAL" });

      expect(summary.failed).toBe(1);
      const outboxRows = fake.getAll("notification_outbox");
      expect(outboxRows[0].status).toBe("failed");
      expect(outboxRows[0].error_message).toContain("not approved yet");
      expect(outboxRows[0].error_message).not.toContain(REAL_TOKEN);
    });

    it("5. a failed notification is retried and can succeed on a later invocation", async () => {
      const { fake, db } = setup();
      fake.seed("content_drafts", [buildDraft("draft-1")]);
      const failingClient = new ScriptedWhatsAppClient({ failWith: whatsappRejection("Temporary Meta error.") });
      await notifyAttentionIfNeeded({ db, whatsappClient: failingClient, brand: "solardesk", runId: RUN_ID, runDecision: "WAIT_FOR_APPROVAL" });
      expect(fake.getAll("notification_outbox")[0].status).toBe("failed");

      const retryClient = new ScriptedWhatsAppClient({ messageId: "wamid.retry" });
      const summary = await notifyAttentionIfNeeded({ db, whatsappClient: retryClient, brand: "solardesk", runId: "run-2", runDecision: "WAIT_FOR_APPROVAL" });

      expect(summary.sent).toBe(1);
      expect(fake.getAll("notification_outbox")).toHaveLength(1);
      expect(fake.getAll("notification_outbox")[0].status).toBe("sent");
      expect(fake.getAll("notification_outbox")[0].provider_message_id).toBe("wamid.retry");
    });
  });

  describe("blocking question", () => {
    it("6. sends one notification for an open blocking question with the question text as content", async () => {
      const { fake, db } = setup();
      fake.seed("agent_questions", [buildQuestion("q-1")]);
      const whatsappClient = new ScriptedWhatsAppClient({ messageId: "wamid.q1" });

      const summary = await notifyAttentionIfNeeded({ db, whatsappClient, brand: "solardesk", runId: RUN_ID, runDecision: "NEEDS_HUMAN_INPUT" });

      expect(summary.sent).toBe(1);
      const call = whatsappClient.sendCalls[0];
      expect(call.bodyParameters[1]).toBe("una pregunta pendiente de tu respuesta");
      expect(call.bodyParameters[2]).toContain("precio actual del plan Pro");
    });

    it("7. the same still-open question is not renotified on a later invocation", async () => {
      const { fake, db } = setup();
      fake.seed("agent_questions", [buildQuestion("q-1")]);
      const whatsappClient = new ScriptedWhatsAppClient({ messageId: "wamid.q1" });

      await notifyAttentionIfNeeded({ db, whatsappClient, brand: "solardesk", runId: RUN_ID, runDecision: "NEEDS_HUMAN_INPUT" });
      const second = await notifyAttentionIfNeeded({ db, whatsappClient, brand: "solardesk", runId: "run-2", runDecision: "NEEDS_HUMAN_INPUT" });

      expect(second.alreadySent).toBe(1);
      expect(whatsappClient.sendCalls).toHaveLength(1);
    });

    it("8. a non-blocking (blocks_progress: false) open question is not notified", async () => {
      const { fake, db } = setup();
      fake.seed("agent_questions", [buildQuestion("q-1", { blocks_progress: false })]);
      const whatsappClient = new ScriptedWhatsAppClient();

      const summary = await notifyAttentionIfNeeded({ db, whatsappClient, brand: "solardesk", runId: RUN_ID, runDecision: "NEEDS_HUMAN_INPUT" });

      expect(summary.attempted).toBe(0);
      expect(whatsappClient.sendCalls).toHaveLength(0);
    });
  });

  describe("no attention needed", () => {
    it("9. NO_ACTION never attempts a notification", async () => {
      const { fake, db } = setup();
      fake.seed("content_drafts", [buildDraft("draft-1")]); // present but irrelevant — decision gates everything
      const whatsappClient = new ScriptedWhatsAppClient();

      const summary = await notifyAttentionIfNeeded({ db, whatsappClient, brand: "solardesk", runId: RUN_ID, runDecision: "NO_ACTION" });

      expect(summary.attempted).toBe(0);
      expect(whatsappClient.sendCalls).toHaveLength(0);
    });

    it("10. a null decision (e.g. BUDGET_BLOCKED skip) never attempts a notification", async () => {
      const { db } = setup();
      const whatsappClient = new ScriptedWhatsAppClient();

      const summary = await notifyAttentionIfNeeded({ db, whatsappClient, brand: "solardesk", runId: RUN_ID, runDecision: null });

      expect(summary.attempted).toBe(0);
    });
  });

  describe("not configured", () => {
    it("11. missing WhatsApp configuration skips cleanly without attempting a send or throwing", async () => {
      delete process.env.META_WHATSAPP_ACCESS_TOKEN;
      const { fake, db } = setup();
      fake.seed("content_drafts", [buildDraft("draft-1")]);
      const whatsappClient = new ScriptedWhatsAppClient();

      const summary = await notifyAttentionIfNeeded({ db, whatsappClient, brand: "solardesk", runId: RUN_ID, runDecision: "WAIT_FOR_APPROVAL" });

      expect(summary.skippedNotConfigured).toBe(true);
      expect(whatsappClient.sendCalls).toHaveLength(0);
      expect(fake.getAll("notification_outbox")).toHaveLength(0);
    });
  });

  describe("brand isolation", () => {
    it("12. a pending draft for a different brand never triggers a notification for solardesk's idempotency key, and vice versa", async () => {
      const { fake, db } = setup();
      fake.seed("content_drafts", [buildDraft("draft-1", { brand: "solardesk" }), buildDraft("draft-2", { brand: "mipadel" })]);
      const whatsappClient = new ScriptedWhatsAppClient({ messageId: "wamid.1" });

      const summary = await notifyAttentionIfNeeded({ db, whatsappClient, brand: "solardesk", runId: RUN_ID, runDecision: "WAIT_FOR_APPROVAL" });

      // Only the solardesk draft is queried/notified — the notification
      // service itself is invoked per-brand by its caller (the cron
      // route), so this proves the query is brand-scoped, not global.
      expect(summary.attempted).toBe(1);
      expect(whatsappClient.sendCalls).toHaveLength(1);
      const outboxRows = fake.getAll("notification_outbox");
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0].brand).toBe("solardesk");
      expect(outboxRows[0].subject_id).toBe("draft-1");
    });
  });
});
