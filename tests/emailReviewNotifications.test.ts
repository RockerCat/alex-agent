import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { prepareContentReviewNotification, prepareAssetReviewNotification, deliverPreparedReviewEmail } from "@/lib/agent/emailReviewNotifications";
import { confirmEmailAction, hashActionToken } from "@/lib/agent/emailActions";
import { createFakeDb, asSupabaseClient, type FakeDb } from "@/tests/support/fakeDb";
import { FakeAssetStorage } from "@/tests/support/fakeAssetStorage";
import { ScriptedEmailClient, emailRejection } from "@/tests/support/fakeEmailClient";

// Email HITL Phase 2B — preparing actionable review notifications:
// durable outbox identity first, then hashed tokens bound to it, then the
// rendered email with action URLs. Nothing here is wired to cron or the
// marketing cycle; sending only happens via an explicit deliver call.

const BASE_URL = "https://agent.alexsosa.me";
const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "44444444-4444-4444-8444-444444444444";
const ADDRESSING = { from: "AlexAgent <review@mail.agent.alexsosa.me>", to: "owner@example.test" };

function setup(draftOverrides: Record<string, unknown> = {}) {
  const fake = createFakeDb();
  fake.seed("marketing_plans", [{ id: "plan-1", brand: "solardesk", primary_objective: "SIGNUPS", status: "active" }]);
  fake.seed("content_drafts", [
    {
      id: DRAFT_ID,
      plan_id: "plan-1",
      brand: "solardesk",
      created_by_run: null,
      channel: "instagram",
      content_type: "image_post",
      purpose: "Generar registros",
      topic: "Propuestas",
      audience: "Instaladores",
      cta: "Comenzar gratis",
      cta_url: "https://solardesk.co/register",
      target_date: "2026-09-25",
      status: "pending_approval",
      version: 2,
      title: "Título v2",
      hook: "Hook v2",
      body: { slides: [{ slide: 1, text: "Texto" }] },
      caption: "Caption",
      cta_text: "Comenzar gratis",
      visual_direction: "Visual",
      hashtags: ["#solar"],
      blocked_on_question_id: null,
      approved_at: null,
      rejected_at: null,
      created_at: "2026-09-23T13:00:00Z",
      updated_at: "2026-09-23T13:00:00Z",
      ...draftOverrides,
    },
  ]);
  return { fake, db: asSupabaseClient<SupabaseClient<Database>>(fake) };
}

function extractTokens(text: string): string[] {
  return [...text.matchAll(/#t=([A-Za-z0-9_-]{43})/g)].map((m) => m[1]);
}

const outboxRows = (fake: FakeDb) => fake.getAll("notification_outbox");

describe("prepareContentReviewNotification", () => {
  it("creates the email outbox identity, hashed approve/reject tokens bound to it, and an email with working URLs", async () => {
    const { fake, db } = setup();
    const prepared = await prepareContentReviewNotification(db, { draftId: DRAFT_ID, baseUrl: BASE_URL });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;

    const [outbox] = outboxRows(fake);
    expect(outbox).toMatchObject({ channel: "email", notification_type: "draft_pending_approval", subject_type: "content_draft", subject_id: DRAFT_ID, subject_version: 2, status: "pending" });
    expect(prepared.notificationId).toBe(outbox.id);

    const tokens = extractTokens(prepared.email.text);
    expect(tokens).toHaveLength(2);
    const rows = fake.getAll("email_action_tokens");
    expect(rows.map((r) => r.notification_id)).toEqual([outbox.id, outbox.id]);
    expect(rows.map((r) => r.token_hash).sort()).toEqual(tokens.map(hashActionToken).sort());
    expect(JSON.stringify(rows)).not.toContain(tokens[0]);
    expect(JSON.stringify(rows)).not.toContain(tokens[1]);

    expect(prepared.email.text).toContain(`Aprobar: ${BASE_URL}/email/action#t=`);
    expect(prepared.email.text).toContain(`Rechazar: ${BASE_URL}/email/action#t=`);
    expect(prepared.email.html).not.toContain(DRAFT_ID);
    expect(prepared.email.text).not.toContain(DRAFT_ID);
  });

  it("the prepared approve link decides exactly the reviewed version", async () => {
    const { fake, db } = setup();
    const prepared = await prepareContentReviewNotification(db, { draftId: DRAFT_ID, baseUrl: BASE_URL });
    if (prepared.status !== "prepared") throw new Error("not prepared");
    const [approveToken] = extractTokens(prepared.email.text);
    expect((await confirmEmailAction(db, approveToken)).result).toBe("applied");
    expect(fake.getAll("content_drafts")[0].status).toBe("approved");
  });

  it("never prepares a second logical review for the same draft version once sent", async () => {
    const { fake, db } = setup();
    const first = await prepareContentReviewNotification(db, { draftId: DRAFT_ID, baseUrl: BASE_URL });
    if (first.status !== "prepared") throw new Error("not prepared");
    const client = new ScriptedEmailClient();
    expect(await deliverPreparedReviewEmail(db, client, first, ADDRESSING)).toEqual({ status: "sent", providerMessageId: "email-fake-1" });

    expect(await prepareContentReviewNotification(db, { draftId: DRAFT_ID, baseUrl: BASE_URL })).toEqual({ status: "already_sent" });
    expect(outboxRows(fake)).toHaveLength(1);
    expect(fake.getAll("email_action_tokens")).toHaveLength(2);
  });

  it("a new draft version is a new, independently notifiable identity", async () => {
    const { fake, db } = setup();
    await prepareContentReviewNotification(db, { draftId: DRAFT_ID, baseUrl: BASE_URL });
    await db.from("content_drafts").update({ version: 3 }).eq("id", DRAFT_ID);
    expect((await prepareContentReviewNotification(db, { draftId: DRAFT_ID, baseUrl: BASE_URL })).status).toBe("prepared");
    expect(outboxRows(fake).map((r) => r.subject_version).sort()).toEqual([2, 3]);
  });

  it("a failed send is reclaimable with fresh tokens and a fresh idempotency key", async () => {
    const { fake, db } = setup();
    const first = await prepareContentReviewNotification(db, { draftId: DRAFT_ID, baseUrl: BASE_URL, now: new Date("2026-09-23T15:00:00Z") });
    if (first.status !== "prepared") throw new Error("not prepared");
    const failed = await deliverPreparedReviewEmail(db, new ScriptedEmailClient({ failWith: emailRejection("Resend rejected the email send request: boom") }), first, ADDRESSING);
    expect(failed).toEqual({ status: "failed", message: "Resend rejected the email send request: boom" });
    expect(outboxRows(fake)[0]).toMatchObject({ status: "failed", error_message: "Resend rejected the email send request: boom" });

    const second = await prepareContentReviewNotification(db, { draftId: DRAFT_ID, baseUrl: BASE_URL, now: new Date("2026-09-23T16:00:00Z") });
    if (second.status !== "prepared") throw new Error("not reclaimed");
    expect(second.notificationId).toBe(first.notificationId);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(extractTokens(second.email.text)).not.toEqual(extractTokens(first.email.text));
    expect(outboxRows(fake)).toHaveLength(1);
  });

  it("delivery records provider id and passes the idempotency key; failure never touches the draft", async () => {
    const { fake, db } = setup();
    const prepared = await prepareContentReviewNotification(db, { draftId: DRAFT_ID, baseUrl: BASE_URL });
    if (prepared.status !== "prepared") throw new Error("not prepared");
    const client = new ScriptedEmailClient();
    await deliverPreparedReviewEmail(db, client, prepared, ADDRESSING);
    expect(client.sendCalls[0]).toMatchObject({ ...ADDRESSING, subject: prepared.email.subject, idempotencyKey: prepared.idempotencyKey });
    expect(outboxRows(fake)[0]).toMatchObject({ status: "sent", provider_message_id: "email-fake-1", rfc_message_id: "<email-fake-1@example.test>" });
    expect(fake.getAll("content_drafts")[0].status).toBe("pending_approval");
  });

  it("refuses drafts that are not pending approval, and never creates tokens for them", async () => {
    const { fake, db } = setup({ status: "approved" });
    expect((await prepareContentReviewNotification(db, { draftId: DRAFT_ID, baseUrl: BASE_URL })).status).toBe("not_eligible");
    expect(outboxRows(fake)).toHaveLength(0);
    expect(fake.getAll("email_action_tokens")).toHaveLength(0);
  });

  it("an invalid (non-https) base URL fails preparation closed and marks the notification failed", async () => {
    const { fake, db } = setup();
    const outcome = await prepareContentReviewNotification(db, { draftId: DRAFT_ID, baseUrl: "http://agent.alexsosa.me" });
    expect(outcome.status).toBe("not_eligible");
    expect(outboxRows(fake)[0].status).toBe("failed");
  });
});

describe("prepareAssetReviewNotification", () => {
  function seedAsset(fake: FakeDb, overrides: Record<string, unknown> = {}) {
    fake.seed("content_assets", [
      {
        id: ASSET_ID,
        draft_id: DRAFT_ID,
        brand: "solardesk",
        asset_version: 3,
        source_draft_version: 2,
        status: "pending_review",
        format: "image_post",
        width: 1080,
        height: 1350,
        mime_type: "image/png",
        storage_bucket: "solardesk-assets",
        storage_path: "solardesk/v3.png",
        render_provenance: {},
        error_message: null,
        created_at: "2026-09-23T13:00:00Z",
        approved_at: null,
        ...overrides,
      },
    ]);
  }

  it("prepares a finished-post email with an inline CID image and an exact-version Aprobar publicación link", async () => {
    const { fake, db } = setup({ status: "approved" });
    seedAsset(fake);
    const storage = new FakeAssetStorage();
    storage.files.set("solardesk/v3.png", Buffer.from([1, 2, 3]));

    const prepared = await prepareAssetReviewNotification(db, storage, { assetId: ASSET_ID, baseUrl: BASE_URL });
    if (prepared.status !== "prepared") throw new Error("not prepared");
    expect(outboxRows(fake)[0]).toMatchObject({ notification_type: "asset_pending_review", subject_type: "content_asset", subject_id: ASSET_ID, subject_version: 3 });
    expect(prepared.email.html).toContain('src="cid:solardesk-asset-v3"');
    expect(prepared.email.inlineAttachments).toHaveLength(1);
    expect(prepared.email.text).toContain(`Aprobar publicación: ${BASE_URL}/email/action#t=`);
    expect(fake.getAll("email_action_tokens")).toEqual([expect.objectContaining({ action: "approve_asset", subject_version: 3 })]);

    const [token] = extractTokens(prepared.email.text);
    expect((await confirmEmailAction(db, token)).result).toBe("applied");
    expect(fake.getAll("content_assets")[0].status).toBe("ready_to_publish");
  });

  it("refuses a superseded or non-pending asset", async () => {
    const { fake, db } = setup({ status: "approved" });
    seedAsset(fake, { status: "ready_to_publish" });
    expect((await prepareAssetReviewNotification(db, new FakeAssetStorage(), { assetId: ASSET_ID, baseUrl: BASE_URL })).status).toBe("not_eligible");
    expect(outboxRows(fake)).toHaveLength(0);
  });
});
