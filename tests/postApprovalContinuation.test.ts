import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentDraftRow } from "@/lib/types/database";
import {
  continueApprovedImagePost,
  runPostApprovalContinuationSweep,
  runContinuationSafely,
  type ContinuationDeps,
} from "@/lib/agent/postApprovalContinuation";
import { generateAsset } from "@/lib/agent/assetGenerator";
import { confirmEmailAction } from "@/lib/agent/emailActions";
import { composeFinalSocialCaption } from "@/lib/agent/finalCaption";
import { createFakeDb, asSupabaseClient, type FakeDb } from "@/tests/support/fakeDb";
import { FakeAssetStorage } from "@/tests/support/fakeAssetStorage";
import { ScriptedAiClient, visualPlan } from "@/tests/support/fakeAiClient";
import { ScriptedImageGenerationClient } from "@/tests/support/fakeImageGenerationClient";
import { ScriptedEmailClient, emailRejection } from "@/tests/support/fakeEmailClient";
import { seedDefaultSettings } from "@/tests/support/seed";

// Approved single-channel image_post → first asset via the canonical
// generateAsset() → finished-publication review email. Every test uses
// scripted AI/image/email fakes: no paid image, no real email, no Meta.

const PLAN_ID = "plan-1";
const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const BASE_URL = "https://agent.alexsosa.me";

function draftRow(overrides: Partial<ContentDraftRow> = {}): Record<string, unknown> {
  return {
    id: DRAFT_ID,
    plan_id: PLAN_ID,
    brand: "solardesk",
    created_by_run: null,
    channel: "instagram",
    content_type: "image_post",
    purpose: "activation",
    topic: "Comienza gratis en SolarDesk",
    audience: "Instaladores",
    cta: "Comenzar gratis",
    cta_url: "https://solardesk.co/register",
    target_date: "2026-09-25",
    status: "approved",
    version: 1,
    title: "Tu primera propuesta en minutos",
    hook: "¿Sigues armando propuestas en hojas de cálculo?",
    body: { slides: [{ slide: 1, text: "Texto" }] },
    caption: "Cotiza proyectos solares y presenta propuestas profesionales.",
    cta_text: "Crea tu primera cotización",
    visual_direction: "SaaS B2B limpio.",
    hashtags: ["#energiasolar", "#solardesk"],
    blocked_on_question_id: null,
    approved_at: "2026-09-23T19:00:00Z",
    rejected_at: null,
    created_at: "2026-09-23T18:00:00Z",
    updated_at: "2026-09-23T18:00:00Z",
    ...overrides,
  };
}

/** A sent email content-review notification for the draft's current version = "entered the email lifecycle". */
function enrollmentRow(draftId = DRAFT_ID, version = 1): Record<string, unknown> {
  return {
    id: `outbox-content-${draftId}-${version}`,
    brand: "solardesk",
    channel: "email",
    notification_type: "draft_pending_approval",
    subject_type: "content_draft",
    subject_id: draftId,
    subject_version: version,
    status: "sent",
    updated_at: "2026-09-23T18:30:00Z",
  };
}

interface Harness {
  fake: FakeDb;
  deps: ContinuationDeps;
  aiClient: ScriptedAiClient;
  imageClient: ScriptedImageGenerationClient;
  emailClient: ScriptedEmailClient;
  storage: FakeAssetStorage;
}

function setup(opts: { drafts?: Record<string, unknown>[]; emailClient?: ScriptedEmailClient; outbox?: Record<string, unknown>[] } = {}): Harness {
  const fake = createFakeDb();
  seedDefaultSettings(fake);
  fake.seed("marketing_plans", [{ id: PLAN_ID, brand: "solardesk", primary_objective: "ACTIVATION", status: "active" }]);
  fake.seed("content_drafts", opts.drafts ?? [draftRow()]);
  fake.seed("notification_outbox", opts.outbox ?? [enrollmentRow()]);
  const db = asSupabaseClient<SupabaseClient<Database>>(fake);
  const storage = new FakeAssetStorage();
  // A generative strategy: every first generation makes exactly one PAID
  // Visual Director call and one PAID image call — so the counters below
  // prove no path ever pays twice.
  const aiClient = new ScriptedAiClient([], [], [], [
    visualPlan({ strategy: "generated_photo", verifiedSourceCategory: "none", generativeSceneDescription: "Un instalador solar revisando una propuesta." }),
  ]);
  const imageClient = new ScriptedImageGenerationClient();
  const emailClient = opts.emailClient ?? new ScriptedEmailClient();
  const deps: ContinuationDeps = {
    db,
    storage,
    aiClient,
    imageGenerationClient: imageClient,
    emailClient,
    addressing: { from: "AlexAgent <review@mail.agent.alexsosa.me>", to: "owner@example.test" },
    baseUrl: BASE_URL,
  };
  return { fake, deps, aiClient, imageClient, emailClient, storage };
}

const assets = (h: Harness) => h.fake.getAll("content_assets");
const assetReviewRows = (h: Harness) => h.fake.getAll("notification_outbox").filter((r) => r.notification_type === "asset_pending_review");
const paidCalls = (h: Harness) => ({ director: h.aiClient.visualDirectorCalls.length, image: h.imageClient.calls.length });

function seedAsset(h: Harness, overrides: Record<string, unknown> = {}) {
  h.fake.seed("content_assets", [
    {
      id: "44444444-4444-4444-8444-444444444444",
      draft_id: DRAFT_ID,
      brand: "solardesk",
      asset_version: 1,
      source_draft_version: 1,
      status: "pending_review",
      format: "image_post",
      width: 1080,
      height: 1350,
      mime_type: "image/png",
      storage_bucket: "solardesk-assets",
      storage_path: "solardesk/existing.png",
      render_provenance: {},
      error_message: null,
      created_at: "2026-09-23T19:05:00Z",
      approved_at: null,
      ...overrides,
    },
  ]);
  h.storage.files.set("solardesk/existing.png", Buffer.from([1, 2, 3]));
}

const originalImageModel = process.env.OPENAI_IMAGE_MODEL;
beforeEach(() => {
  process.env.OPENAI_IMAGE_MODEL = "gpt-image-1"; // enables the (scripted) generative capability
});
afterEach(() => {
  if (originalImageModel === undefined) delete process.env.OPENAI_IMAGE_MODEL;
  else process.env.OPENAI_IMAGE_MODEL = originalImageModel;
});

describe("continueApprovedImagePost — happy path", () => {
  it("generates the first asset through the canonical generateAsset() and sends one finished-publication review email", async () => {
    const h = setup();
    const outcome = await continueApprovedImagePost(h.deps, DRAFT_ID);

    expect(outcome).toEqual({ status: "review_sent", generated: true, providerMessageId: "email-fake-1" });
    expect(paidCalls(h)).toEqual({ director: 1, image: 1 });
    expect(assets(h)).toHaveLength(1);
    expect(assets(h)[0]).toMatchObject({ status: "pending_review", asset_version: 1, source_draft_version: 1 });

    expect(h.emailClient.sendCalls).toHaveLength(1);
    const sent = h.emailClient.sendCalls[0];
    expect(sent.subject).toContain("Pieza lista para publicar en Instagram");
    expect(sent.text).toContain("Destino: Instagram");
    expect(sent.text).toContain(composeFinalSocialCaption(h.fake.getAll("content_drafts")[0] as unknown as ContentDraftRow));
    expect(sent.text).toContain("Aprobar publicación: https://agent.alexsosa.me/email/action#t=");
    expect(sent.inlineAttachments).toHaveLength(1);
    expect(sent.html).toContain(`src="cid:${sent.inlineAttachments![0].contentId}"`);

    expect(assetReviewRows(h)).toEqual([expect.objectContaining({ status: "sent", subject_version: 1 })]);
    expect(h.fake.getAll("email_action_tokens")).toEqual([expect.objectContaining({ action: "approve_asset", subject_version: 1 })]);
    expect(h.fake.getAll("content_drafts")[0].status).toBe("approved"); // approval untouched
  });

  it("confirming the finished-publication email ends at ready_to_publish — nothing is published", async () => {
    const h = setup();
    await continueApprovedImagePost(h.deps, DRAFT_ID);
    const token = h.emailClient.sendCalls[0].text.match(/#t=([A-Za-z0-9_-]{43})/)![1];

    expect((await confirmEmailAction(h.deps.db, token)).result).toBe("applied");
    expect(assets(h)[0].status).toBe("ready_to_publish");
    expect(h.fake.getAll("asset_publications")).toHaveLength(0);
  });
});

describe("continueApprovedImagePost — eligibility", () => {
  it("never continues a carousel, a non-approved draft, or a draft without hook/CTA", async () => {
    for (const overrides of [{ content_type: "carousel" }, { status: "pending_approval" }, { status: "rejected" }, { hook: null }] as Partial<ContentDraftRow>[]) {
      const h = setup({ drafts: [draftRow(overrides)] });
      const outcome = await continueApprovedImagePost(h.deps, DRAFT_ID);
      expect(outcome.status).toBe("not_eligible");
      expect(paidCalls(h)).toEqual({ director: 0, image: 0 });
      expect(assets(h)).toHaveLength(0);
      expect(h.emailClient.sendCalls).toHaveLength(0);
    }
  });
});

describe("continueApprovedImagePost — idempotency and recovery", () => {
  it("a retry after success never regenerates or re-sends", async () => {
    const h = setup();
    await continueApprovedImagePost(h.deps, DRAFT_ID);
    const second = await continueApprovedImagePost(h.deps, DRAFT_ID);

    expect(second).toEqual({ status: "review_already_sent" });
    expect(paidCalls(h)).toEqual({ director: 1, image: 1 });
    expect(assets(h)).toHaveLength(1);
    expect(h.emailClient.sendCalls).toHaveLength(1);
  });

  it("concurrent continuation attempts produce one asset, one paid generation, and one email", async () => {
    const h = setup();
    const outcomes = await Promise.all([continueApprovedImagePost(h.deps, DRAFT_ID), continueApprovedImagePost(h.deps, DRAFT_ID)]);

    expect(assets(h)).toHaveLength(1);
    expect(paidCalls(h)).toEqual({ director: 1, image: 1 });
    expect(h.emailClient.sendCalls).toHaveLength(1);
    expect(outcomes.map((o) => o.status)).toContain("review_sent");
  });

  it("an existing pending asset is never regenerated — only its missing review email is sent", async () => {
    const h = setup();
    seedAsset(h);
    const outcome = await continueApprovedImagePost(h.deps, DRAFT_ID);

    expect(outcome).toEqual({ status: "review_sent", generated: false, providerMessageId: "email-fake-1" });
    expect(paidCalls(h)).toEqual({ director: 0, image: 0 });
    expect(assets(h)).toHaveLength(1);
  });

  it("an already-approved (ready_to_publish) asset: nothing generated, nothing sent", async () => {
    const h = setup();
    seedAsset(h, { status: "ready_to_publish" });
    expect((await continueApprovedImagePost(h.deps, DRAFT_ID)).status).toBe("asset_not_reviewable");
    expect(paidCalls(h)).toEqual({ director: 0, image: 0 });
    expect(h.emailClient.sendCalls).toHaveLength(0);
  });

  it("a recorded generation failure is not retried automatically (no repeated paid failures)", async () => {
    const h = setup();
    seedAsset(h, { status: "generation_failed", storage_path: null });
    expect(await continueApprovedImagePost(h.deps, DRAFT_ID)).toMatchObject({ status: "asset_not_reviewable" });
    expect(paidCalls(h)).toEqual({ director: 0, image: 0 });
    expect(assets(h)).toHaveLength(1);
  });

  it("a stale asset (generated from another content version) is never emailed or regenerated", async () => {
    const h = setup({ drafts: [draftRow({ version: 2 })], outbox: [enrollmentRow(DRAFT_ID, 2)] });
    seedAsset(h, { source_draft_version: 1 });
    expect(await continueApprovedImagePost(h.deps, DRAFT_ID)).toMatchObject({ status: "asset_not_reviewable" });
    expect(paidCalls(h)).toEqual({ director: 0, image: 0 });
    expect(h.emailClient.sendCalls).toHaveLength(0);
  });

  it("generation failure leaves the approval intact and is recoverable later", async () => {
    const h = setup();
    // Budget exhausted: the Budget Guard blocks the paid call — no asset row is recorded.
    h.fake.seed("agent_settings", [{ ...h.fake.getAll("agent_settings")[0], monthly_budget_usd: 0, safety_reserve_usd: 0 }]);
    const failed = await continueApprovedImagePost(h.deps, DRAFT_ID);
    expect(failed).toMatchObject({ status: "generation_failed", budgetBlocked: true });
    expect(h.fake.getAll("content_drafts")[0].status).toBe("approved");
    expect(assets(h)).toHaveLength(0);
    expect(h.emailClient.sendCalls).toHaveLength(0);

    seedDefaultSettings(h.fake); // budget restored
    expect((await continueApprovedImagePost(h.deps, DRAFT_ID)).status).toBe("review_sent");
    expect(assets(h)).toHaveLength(1);
  });

  it("email delivery failure is recoverable WITHOUT regenerating the image", async () => {
    const emailClient = new ScriptedEmailClient({ failSequence: [emailRejection("Resend rejected the email send request: boom"), null] });
    const h = setup({ emailClient });

    const first = await continueApprovedImagePost(h.deps, DRAFT_ID);
    expect(first).toEqual({ status: "review_delivery_failed", generated: true, message: "Resend rejected the email send request: boom" });
    expect(assetReviewRows(h)[0].status).toBe("failed");

    const retry = await continueApprovedImagePost(h.deps, DRAFT_ID);
    expect(retry).toEqual({ status: "review_sent", generated: false, providerMessageId: "email-fake-2" });
    expect(paidCalls(h)).toEqual({ director: 1, image: 1 }); // never paid again
    expect(assets(h)).toHaveLength(1);
    expect(assetReviewRows(h)).toHaveLength(1);
  });
});

describe("generateAsset — first-generation-only guarantees used by continuation", () => {
  it("firstGenerationOnly never takes the Regenerate path when an asset exists", async () => {
    const h = setup();
    seedAsset(h);
    const outcome = await generateAsset({ db: h.deps.db, storage: h.storage, draftId: DRAFT_ID, aiClient: h.aiClient, imageGenerationClient: h.imageClient, firstGenerationOnly: true });
    expect(outcome).toMatchObject({ status: "ineligible", assetAlreadyExists: true });
    expect(assets(h)).toHaveLength(1);
  });

  it("re-checks under the brand lock: an asset created after the pre-lock read means no paid call at all", async () => {
    const h = setup();
    const originalFrom = h.fake.from.bind(h.fake);
    let injected = false;
    h.fake.from = ((table: string) => {
      if (table === "agent_runs" && !injected) {
        injected = true; // a concurrent first generation lands right before we take the lock
        seedAsset(h);
      }
      return originalFrom(table);
    }) as typeof h.fake.from;

    const outcome = await generateAsset({ db: h.deps.db, storage: h.storage, draftId: DRAFT_ID, aiClient: h.aiClient, imageGenerationClient: h.imageClient });
    expect(outcome.status).toBe("concurrent");
    expect(paidCalls(h)).toEqual({ director: 0, image: 0 });
    expect(h.fake.getAll("agent_runs").every((r) => r.status !== "running")).toBe(true);
  });
});

describe("runPostApprovalContinuationSweep — cron catch-up", () => {
  const OTHER = "22222222-2222-4222-8222-222222222222";
  const CAROUSEL = "33333333-3333-4333-8333-333333333333";

  it("continues only email-lifecycle image_post drafts; never dashboard-only drafts or carousels", async () => {
    const h = setup({
      drafts: [draftRow(), draftRow({ id: OTHER }), draftRow({ id: CAROUSEL, content_type: "carousel" })],
      outbox: [enrollmentRow(DRAFT_ID), enrollmentRow(CAROUSEL)], // OTHER was reviewed only in the dashboard
    });
    const sweep = await runPostApprovalContinuationSweep(h.deps);

    expect(sweep.outcomes).toEqual(["review_sent"]);
    expect(assets(h).map((a) => a.draft_id)).toEqual([DRAFT_ID]);
    expect(h.emailClient.sendCalls).toHaveLength(1);
  });

  it("is a no-op for drafts already finished (asset reviewed-sent or ready to publish), so reruns never duplicate", async () => {
    const h = setup();
    await runPostApprovalContinuationSweep(h.deps);
    const again = await runPostApprovalContinuationSweep(h.deps);
    expect(again.outcomes).toEqual([]);
    expect(paidCalls(h)).toEqual({ director: 1, image: 1 });
    expect(h.emailClient.sendCalls).toHaveLength(1);
  });

  it("retries a failed review email on a later run without regenerating", async () => {
    const emailClient = new ScriptedEmailClient({ failSequence: [emailRejection("Resend rejected the email send request: boom"), null] });
    const h = setup({ emailClient });
    expect((await runPostApprovalContinuationSweep(h.deps)).outcomes).toEqual(["review_delivery_failed"]);
    expect((await runPostApprovalContinuationSweep(h.deps)).outcomes).toEqual(["review_sent"]);
    expect(paidCalls(h)).toEqual({ director: 1, image: 1 });
  });

  it("is bounded per run", async () => {
    const ids = ["a", "b", "c", "d"].map((c) => `${c.repeat(8)}-1111-4111-8111-111111111111`);
    const h = setup({ drafts: ids.map((id) => draftRow({ id })), outbox: ids.map((id) => enrollmentRow(id)) });
    const sweep = await runPostApprovalContinuationSweep(h.deps, { limit: 2 });
    expect(sweep.outcomes).toHaveLength(2);
  });
});

describe("runContinuationSafely", () => {
  it("does nothing (and never throws) when email/app origin isn't configured", async () => {
    await expect(runContinuationSafely(DRAFT_ID, () => null)).resolves.toBeUndefined();
  });

  it("never throws even if the continuation itself crashes", async () => {
    const h = setup();
    const broken = { ...h.deps, db: { from: () => { throw new Error("db down"); } } as unknown as ContinuationDeps["db"] };
    await expect(runContinuationSafely(DRAFT_ID, () => broken)).resolves.toBeUndefined();
  });
});

describe("structural guarantees", () => {
  it("the continuation path never imports or calls a social publisher", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of ["lib/agent/postApprovalContinuation.ts", "lib/agent/emailActions.ts", "lib/agent/emailReviewNotifications.ts", "app/api/email-actions/confirm/route.ts"]) {
      const source = await readFile(file, "utf-8");
      expect(source).not.toMatch(/publishAssetTo|agent\/publish"|facebookClient|instagramClient/);
    }
  });

  it("the continuation only ever requests a FIRST generation through the canonical generateAsset()", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("lib/agent/postApprovalContinuation.ts", "utf-8");
    expect(source).toMatch(/generateAsset\(\{[^}]*firstGenerationOnly: true/);
    expect(source).not.toMatch(/renderImagePostAsset|callVisualDirector|\.generate\(/);
  });
});

describe("final-caption guard — an unpublishable Instagram caption is never presented as ready to publish", () => {
  // 2,190 chars: valid as draft.caption, but + CTA link + hashtags exceeds Instagram's 2,200.
  const LONG_CAPTION = "a".repeat(2190);
  const noReviewArtifacts = (h: Harness) => {
    expect(assetReviewRows(h)).toHaveLength(0);
    expect(h.fake.getAll("email_action_tokens")).toHaveLength(0);
    expect(h.emailClient.sendCalls).toHaveLength(0);
  };

  it("checks BEFORE generation: no paid work, no asset, no email, nothing durable", async () => {
    const h = setup({ drafts: [draftRow({ caption: LONG_CAPTION })] });
    const outcome = await continueApprovedImagePost(h.deps, DRAFT_ID);

    expect(outcome.status).toBe("final_caption_invalid");
    if (outcome.status === "final_caption_invalid") {
      expect(outcome.reason).toContain("Instagram allows at most 2200");
      expect(outcome.reason).not.toContain(LONG_CAPTION.slice(0, 50));
    }
    expect(paidCalls(h)).toEqual({ director: 0, image: 0 });
    expect(assets(h)).toHaveLength(0);
    noReviewArtifacts(h);
    expect(h.fake.getAll("content_drafts")[0].status).toBe("approved");
  });

  it("an already-generated asset is preserved (not regenerated), and no misleading review is sent — retries repeat nothing", async () => {
    const h = setup({ drafts: [draftRow({ caption: LONG_CAPTION })] });
    seedAsset(h);
    const before = JSON.stringify(assets(h));

    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await continueApprovedImagePost(h.deps, DRAFT_ID)).status).toBe("final_caption_invalid");
    }
    expect(JSON.stringify(assets(h))).toBe(before); // intact, still pending_review
    expect(paidCalls(h)).toEqual({ director: 0, image: 0 });
    noReviewArtifacts(h);
  });

  it("prepareAssetReviewNotification itself refuses before claiming an outbox row or minting tokens", async () => {
    const h = setup({ drafts: [draftRow({ caption: LONG_CAPTION })] });
    seedAsset(h);
    const { prepareAssetReviewNotification } = await import("@/lib/agent/emailReviewNotifications");
    const prepared = await prepareAssetReviewNotification(h.deps.db, h.storage, { assetId: "44444444-4444-4444-8444-444444444444", baseUrl: BASE_URL });
    expect(prepared).toMatchObject({ status: "not_eligible", finalCaptionInvalid: true });
    noReviewArtifacts(h);
  });

  it("the cron sweep skips it without consuming the per-run limit, so other drafts still continue", async () => {
    const OTHER = "22222222-2222-4222-8222-222222222222";
    const h = setup({
      drafts: [draftRow({ caption: LONG_CAPTION, approved_at: "2026-09-23T18:00:00Z" }), draftRow({ id: OTHER, approved_at: "2026-09-23T19:00:00Z" })],
      outbox: [enrollmentRow(DRAFT_ID), enrollmentRow(OTHER)],
    });
    const sweep = await runPostApprovalContinuationSweep(h.deps, { limit: 1 });

    expect(sweep.outcomes).toEqual(["review_sent"]);
    expect(assets(h).map((a) => a.draft_id)).toEqual([OTHER]);
    expect(paidCalls(h)).toEqual({ director: 1, image: 1 });
  });

  it("Facebook is unchanged: the same long caption continues normally", async () => {
    const h = setup({ drafts: [draftRow({ caption: LONG_CAPTION, channel: "facebook" })] });
    const outcome = await continueApprovedImagePost(h.deps, DRAFT_ID);
    expect(outcome.status).toBe("review_sent");
    expect(h.emailClient.sendCalls[0].text).toContain("Destino: Facebook");
  });
});
