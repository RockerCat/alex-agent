import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { publishAssetToFacebook, getPublication } from "@/lib/agent/publish";
import { generateAsset, approveAsset } from "@/lib/agent/assetGenerator";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { FakeAssetStorage } from "@/tests/support/fakeAssetStorage";
import { ScriptedFacebookClient, facebookRejection } from "@/tests/support/fakeFacebookClient";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentDraftRow } from "@/lib/types/database";

// AlexAgent v0.2 — Facebook manual publishing (checkpoint 1). Behavioral
// tests only: no real Meta Graph API call is ever made — the Meta side
// is a ScriptedFacebookClient fake, matching the ScriptedAiClient /
// ScriptedImageGenerationClient pattern already used for the AI and
// image-generation seams.

const PLAN_ID = "plan-1";

function seedPlan(fake: ReturnType<typeof createFakeDb>) {
  fake.seed("marketing_plans", [
    {
      id: PLAN_ID,
      brand: "solardesk",
      period_start: "2026-09-08",
      period_end: "2026-09-15",
      primary_objective: "ACTIVATION",
      primary_objective_reason: "r",
      primary_objective_success_signal: "s",
      supporting_objectives: [],
      strategy_summary: "sum",
      strategy_audience: "aud",
      strategy_approach: "app",
      rationale: "rat",
      status: "active",
      created_by_run: null,
      created_at: new Date().toISOString(),
    },
  ]);
}

function buildDraft(id: string, overrides: Partial<ContentDraftRow> = {}) {
  return {
    id,
    plan_id: PLAN_ID,
    brand: "solardesk",
    created_by_run: null,
    channel: "facebook" as const,
    content_type: "image_post" as const,
    purpose: "activation",
    topic: "Comienza gratis en SolarDesk",
    audience: "Instaladores",
    cta: "Comenzar gratis",
    target_date: "2026-09-12",
    status: "approved" as const,
    version: 1,
    title: "Comienza gratis en SolarDesk",
    hook: "¿Sigues armando propuestas solares en hojas de cálculo?",
    body: { slides: [] },
    caption: "Cotiza proyectos solares y presenta propuestas profesionales con la marca de tu empresa.",
    cta_text: "Crea tu primera cotización",
    visual_direction: "SaaS B2B limpio, azul oscuro y ámbar.",
    hashtags: ["#energiasolar", "#solardesk"],
    created_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    ...overrides,
  };
}

function seedDraft(fake: ReturnType<typeof createFakeDb>, id: string, overrides: Partial<ContentDraftRow> = {}) {
  const row = buildDraft(id, overrides);
  fake.seed("content_drafts", [row]);
  return row;
}

/** Runs the real generateAsset+approveAsset flow so tests publish an asset produced the same way production does, not a hand-crafted row. */
async function seedReadyToPublishAsset(fake: ReturnType<typeof createFakeDb>, db: SupabaseClient<Database>, storage: FakeAssetStorage, draftId: string) {
  const generated = await generateAsset({ db, storage, draftId });
  if (generated.status !== "success" || !generated.asset) throw new Error("test setup: asset generation failed");
  const approved = await approveAsset(db, generated.asset.id);
  if (!approved.ok || !approved.asset) throw new Error("test setup: asset approval failed");
  return approved.asset;
}

function setup() {
  const fake = createFakeDb();
  seedPlan(fake);
  const db = asSupabaseClient<SupabaseClient<Database>>(fake);
  const storage = new FakeAssetStorage();
  return { fake, db, storage };
}

const REAL_TOKEN = "sneaky-real-page-access-token-value";

describe("publishAssetToFacebook", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN = REAL_TOKEN;
    process.env.META_FACEBOOK_PAGE_ID = "1225292840656707";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("1. a Ready to publish image_post asset produces a correct request to Meta and succeeds", async () => {
    const { fake, db, storage } = setup();
    const draft = seedDraft(fake, "draft-1");
    const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
    const facebookClient = new ScriptedFacebookClient({ postId: "fb-post-123" });

    const outcome = await publishAssetToFacebook({ db, storage, facebookClient, draftId: draft.id, assetId: asset.id });

    expect(outcome.status).toBe("success");
    expect(facebookClient.calls).toHaveLength(1);
    expect(facebookClient.calls[0].message).toBe(draft.caption);
    expect(facebookClient.calls[0].imageBuffer.length).toBeGreaterThan(0);
  });

  it("2. an asset that is not Ready to publish is blocked before ever calling Meta", async () => {
    const { fake, db, storage } = setup();
    const draft = seedDraft(fake, "draft-1");
    const generated = await generateAsset({ db, storage, draftId: draft.id });
    if (generated.status !== "success" || !generated.asset) throw new Error("setup failed");
    // Deliberately not approved — asset is still "pending_review".
    const facebookClient = new ScriptedFacebookClient();

    const outcome = await publishAssetToFacebook({ db, storage, facebookClient, draftId: draft.id, assetId: generated.asset.id });

    expect(outcome.status).toBe("ineligible");
    expect(facebookClient.calls).toHaveLength(0);
  });

  it("3. missing Meta configuration fails safely without calling Meta", async () => {
    delete process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN;
    const { fake, db, storage } = setup();
    const draft = seedDraft(fake, "draft-1");
    const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
    const facebookClient = new ScriptedFacebookClient();

    const outcome = await publishAssetToFacebook({ db, storage, facebookClient, draftId: draft.id, assetId: asset.id });

    expect(outcome.status).toBe("failed");
    expect(facebookClient.calls).toHaveLength(0);
    expect(outcome.message).not.toContain(REAL_TOKEN);
  });

  it("4. a Meta failure does not mark the asset as published and leaves it retryable", async () => {
    const { fake, db, storage } = setup();
    const draft = seedDraft(fake, "draft-1");
    const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
    const facebookClient = new ScriptedFacebookClient({ failWith: facebookRejection("Meta Graph API rejected the publish request: Invalid OAuth access token.") });

    const outcome = await publishAssetToFacebook({ db, storage, facebookClient, draftId: draft.id, assetId: asset.id });

    expect(outcome.status).toBe("failed");
    const publication = await getPublication(db, asset.id);
    expect(publication?.status).toBe("failed");
    expect(publication?.meta_post_id).toBeNull();

    // Retry after a real Meta failure must be allowed (no real post exists yet).
    const retryClient = new ScriptedFacebookClient({ postId: "fb-post-999" });
    const retryOutcome = await publishAssetToFacebook({ db, storage, facebookClient: retryClient, draftId: draft.id, assetId: asset.id });
    expect(retryOutcome.status).toBe("success");
  });

  it("5. a Meta success persists post id, timestamp, and channel", async () => {
    const { fake, db, storage } = setup();
    const draft = seedDraft(fake, "draft-1");
    const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
    const facebookClient = new ScriptedFacebookClient({ postId: "fb-post-456" });

    const outcome = await publishAssetToFacebook({ db, storage, facebookClient, draftId: draft.id, assetId: asset.id });

    expect(outcome.status).toBe("success");
    expect(outcome.publication?.meta_post_id).toBe("fb-post-456");
    expect(outcome.publication?.channel).toBe("facebook");
    expect(outcome.publication?.published_at).toBeTruthy();
    expect(outcome.publication?.status).toBe("published");
  });

  it("6. a second publish attempt for the same asset/destination never creates a second post", async () => {
    const { fake, db, storage } = setup();
    const draft = seedDraft(fake, "draft-1");
    const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
    const facebookClient = new ScriptedFacebookClient({ postId: "fb-post-789" });

    const first = await publishAssetToFacebook({ db, storage, facebookClient, draftId: draft.id, assetId: asset.id });
    expect(first.status).toBe("success");

    const second = await publishAssetToFacebook({ db, storage, facebookClient, draftId: draft.id, assetId: asset.id });

    expect(second.status).toBe("ineligible");
    expect(facebookClient.calls).toHaveLength(1);
    expect(fake.getAll("asset_publications")).toHaveLength(1);
  });

  it("6b. a concurrent double-click (racing insert) also never creates a second post", async () => {
    const { fake, db, storage } = setup();
    const draft = seedDraft(fake, "draft-1");
    const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
    const clientA = new ScriptedFacebookClient({ postId: "fb-post-aaa" });
    const clientB = new ScriptedFacebookClient({ postId: "fb-post-bbb" });

    const [a, b] = await Promise.all([
      publishAssetToFacebook({ db, storage, facebookClient: clientA, draftId: draft.id, assetId: asset.id }),
      publishAssetToFacebook({ db, storage, facebookClient: clientB, draftId: draft.id, assetId: asset.id }),
    ]);

    // Timing decides whether the loser sees the winner's row as
    // "publishing" (still in flight) or "published" (already done) —
    // either way it must never be "success" itself, and the actual
    // invariant (never two Facebook calls, never two persisted rows)
    // must hold regardless of which race outcome landed.
    const successCount = [a.status, b.status].filter((s) => s === "success").length;
    const blockedCount = [a.status, b.status].filter((s) => s === "concurrent" || s === "ineligible").length;
    expect(successCount).toBe(1);
    expect(blockedCount).toBe(1);
    expect(clientA.calls.length + clientB.calls.length).toBe(1);
    expect(fake.getAll("asset_publications")).toHaveLength(1);
  });

  // 7. Direct request-construction/token-safety coverage for the real
  // MetaGraphFacebookClient (URL, multipart fields, binary payload,
  // post_id/id fallback, rejection handling, token-hygiene regression)
  // now lives in tests/facebookClient.test.ts, which tests the
  // production client in isolation rather than through this
  // orchestration-focused fake-client suite.

  it("guard: a non-facebook draft is rejected before calling Meta", async () => {
    const { fake, db, storage } = setup();
    const draft = seedDraft(fake, "draft-1", { channel: "instagram" });
    const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
    const facebookClient = new ScriptedFacebookClient();

    const outcome = await publishAssetToFacebook({ db, storage, facebookClient, draftId: draft.id, assetId: asset.id });

    expect(outcome.status).toBe("ineligible");
    expect(facebookClient.calls).toHaveLength(0);
  });

  it("guard: an asset that does not belong to the given draft is rejected", async () => {
    const { fake, db, storage } = setup();
    const draftA = buildDraft("draft-a");
    const draftB = buildDraft("draft-b");
    fake.seed("content_drafts", [draftA, draftB]);
    const assetA = await seedReadyToPublishAsset(fake, db, storage, draftA.id);
    const facebookClient = new ScriptedFacebookClient();

    const outcome = await publishAssetToFacebook({ db, storage, facebookClient, draftId: draftB.id, assetId: assetA.id });

    expect(outcome.status).toBe("ineligible");
    expect(facebookClient.calls).toHaveLength(0);
  });
});
