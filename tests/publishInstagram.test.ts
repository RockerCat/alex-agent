import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { publishAssetToInstagram, publishAssetToFacebook, getPublication } from "@/lib/agent/publish";
import { generateAsset, approveAsset } from "@/lib/agent/assetGenerator";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { FakeAssetStorage } from "@/tests/support/fakeAssetStorage";
import { ScriptedInstagramClient, instagramRejection } from "@/tests/support/fakeInstagramClient";
import { ScriptedFacebookClient } from "@/tests/support/fakeFacebookClient";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentDraftRow } from "@/lib/types/database";

// AlexAgent — Instagram publication service checkpoint. Behavioral
// tests only: no real Meta Graph API call is ever made — Meta is a
// ScriptedInstagramClient fake (mirrors tests/publish.test.ts's
// ScriptedFacebookClient pattern), and Supabase Storage is the existing
// FakeAssetStorage. Mirrors the structure of tests/publish.test.ts,
// which remains untouched and passes unmodified as the adjacent
// Facebook regression check.

const PLAN_ID = "plan-1";
const ACCESS_TOKEN = "fake-ig-token-for-tests-only";
const ACCOUNT_ID = "17841417848021831";

// Injected in place of the real timer-based default so readiness-polling
// tests below never actually wait between IN_PROGRESS checks.
const noDelay = async () => {};

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
    channel: "instagram" as const,
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

describe("publishAssetToInstagram", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.META_INSTAGRAM_ACCESS_TOKEN = ACCESS_TOKEN;
    process.env.META_INSTAGRAM_ACCOUNT_ID = ACCOUNT_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("1. an eligible approved Instagram image_post asset claims the slot, creates a signed URL, and publishes via the two-step Graph flow", async () => {
    const { fake, db, storage } = setup();
    const draft = seedDraft(fake, "draft-1");
    const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
    const instagramClient = new ScriptedInstagramClient({ creationId: "container-1", mediaId: "ig-media-123" });

    const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id });

    expect(outcome.status).toBe("success");
    expect(instagramClient.createCalls).toHaveLength(1);
    expect(instagramClient.createCalls[0].imageUrl).toBe(`https://fake-storage.local/${asset.storage_path}?signed=1`);
    expect(instagramClient.createCalls[0].caption).toBe(draft.caption);
    expect(instagramClient.publishCalls).toEqual(["container-1"]);
    expect(outcome.publication?.channel).toBe("instagram");
    expect(outcome.publication?.meta_post_id).toBe("ig-media-123");
    expect(outcome.publication?.status).toBe("published");
    expect(outcome.publication?.published_at).toBeTruthy();

    const publications = fake.getAll("asset_publications");
    expect(publications).toHaveLength(1);
    expect(publications[0].channel).toBe("instagram");
  });

  it("2. never downloads the asset bytes — only a signed URL reaches the Instagram client", async () => {
    const { fake, db, storage } = setup();
    const draft = seedDraft(fake, "draft-1");
    const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
    const instagramClient = new ScriptedInstagramClient();
    const originalDownload = storage.download.bind(storage);
    let downloadCalled = false;
    storage.download = async (path: string) => {
      downloadCalled = true;
      return originalDownload(path);
    };

    await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id });

    expect(downloadCalled).toBe(false);
  });

  describe("caption destination", () => {
    it("3. appends the destination exactly once when the caption doesn't already contain it", async () => {
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1", {
        caption: "Una propuesta profesional, lista para compartir con tu cliente.",
        cta_text: "Comenzar gratis",
        cta_url: "https://solardesk.co/register",
      });
      const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
      const instagramClient = new ScriptedInstagramClient();

      const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id });

      expect(outcome.status).toBe("success");
      const caption = instagramClient.createCalls[0].caption;
      expect(caption).toContain("https://solardesk.co/register");
      expect(caption.split("https://solardesk.co/register")).toHaveLength(2);
      expect(caption).toContain(draft.caption);
    });

    it("4. does not duplicate the destination when the caption already contains it", async () => {
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1", {
        caption: "Regístrate gratis aquí: https://solardesk.co/register — sin tarjeta de crédito.",
        cta_text: "Comenzar gratis",
        cta_url: "https://solardesk.co/register",
      });
      const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
      const instagramClient = new ScriptedInstagramClient();

      const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id });

      expect(outcome.status).toBe("success");
      const caption = instagramClient.createCalls[0].caption;
      expect(caption).toBe(draft.caption);
      expect(caption.split("https://solardesk.co/register")).toHaveLength(2);
    });

    it("5. never sends the visual cta_text label as a substitute for the caption", async () => {
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1", {
        caption: "Caption humano aprobado.",
        cta_text: "Comenzar gratis",
        cta_url: "https://solardesk.co/register",
      });
      const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
      const instagramClient = new ScriptedInstagramClient();

      const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id });

      expect(outcome.status).toBe("success");
      expect(instagramClient.createCalls[0].caption).not.toContain("Comenzar gratis");
    });
  });

  describe("ineligible", () => {
    it("6. a Facebook-channel draft is rejected before calling Instagram", async () => {
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1", { channel: "facebook" });
      const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
      const instagramClient = new ScriptedInstagramClient();

      const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id });

      expect(outcome.status).toBe("ineligible");
      expect(instagramClient.createCalls).toHaveLength(0);
    });

    it("7. a carousel content_type draft is rejected — single-image image_post only", async () => {
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1", { content_type: "carousel" });
      // generateAsset itself already refuses non-image_post drafts
      // (lib/agent/assetGenerator.ts), so a carousel draft can never
      // naturally reach a "ready_to_publish" asset — seed the row
      // directly to exercise publishAssetToInstagram's own defense-in-depth
      // content_type guard rather than the asset-generation guard.
      fake.seed("content_assets", [
        {
          id: "asset-carousel-1",
          draft_id: draft.id,
          brand: "solardesk",
          asset_version: 1,
          source_draft_version: 1,
          status: "ready_to_publish",
          format: "image_post",
          storage_path: `solardesk/${draft.id}/v1.png`,
          width: 1080,
          height: 1080,
          mime_type: "image/png",
          storage_bucket: null,
          render_provenance: {},
          error_message: null,
          created_at: new Date().toISOString(),
          approved_at: new Date().toISOString(),
        },
      ]);
      const instagramClient = new ScriptedInstagramClient();

      const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: "asset-carousel-1" });

      expect(outcome.status).toBe("ineligible");
      expect(instagramClient.createCalls).toHaveLength(0);
    });

    it("8. an asset that is not yet approved/ready is rejected before calling Instagram", async () => {
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1");
      const generated = await generateAsset({ db, storage, draftId: draft.id });
      if (generated.status !== "success" || !generated.asset) throw new Error("setup failed");
      // Deliberately not approved — asset is still "pending_review".
      const instagramClient = new ScriptedInstagramClient();

      const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: generated.asset.id });

      expect(outcome.status).toBe("ineligible");
      expect(instagramClient.createCalls).toHaveLength(0);
    });

    it("9. missing Instagram configuration fails safely before touching storage or Instagram", async () => {
      delete process.env.META_INSTAGRAM_ACCESS_TOKEN;
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1");
      const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
      const instagramClient = new ScriptedInstagramClient();
      let signedUrlCalled = false;
      const originalCreateSignedUrl = storage.createSignedUrl.bind(storage);
      storage.createSignedUrl = async (path: string) => {
        signedUrlCalled = true;
        return originalCreateSignedUrl(path);
      };

      const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id });

      expect(outcome.status).toBe("failed");
      expect(outcome.message).not.toContain(ACCESS_TOKEN);
      expect(signedUrlCalled).toBe(false);
      expect(instagramClient.createCalls).toHaveLength(0);
      expect(fake.getAll("asset_publications")).toHaveLength(0);
    });
  });

  describe("media delivery failure", () => {
    it("10. a signed URL failure marks the publication failed and never calls Instagram", async () => {
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1");
      const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
      storage.failNextSignedUrl = true;
      const instagramClient = new ScriptedInstagramClient();

      const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id });

      expect(outcome.status).toBe("failed");
      expect(instagramClient.createCalls).toHaveLength(0);
      const publication = await getPublication(db, asset.id, "instagram");
      expect(publication?.status).toBe("failed");
      expect(publication?.meta_post_id).toBeNull();
    });
  });

  describe("create-container failure", () => {
    it("11. a media container failure never calls publish and leaves the slot retryable", async () => {
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1");
      const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
      const instagramClient = new ScriptedInstagramClient({ failCreateWith: instagramRejection("Invalid parameter: image_url could not be fetched.") });

      const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id });

      expect(outcome.status).toBe("failed");
      expect(instagramClient.publishCalls).toHaveLength(0);
      const publication = await getPublication(db, asset.id, "instagram");
      expect(publication?.status).toBe("failed");
      expect(publication?.meta_post_id).toBeNull();

      // Retryable: no real container/post exists yet.
      const retryClient = new ScriptedInstagramClient({ creationId: "container-retry", mediaId: "ig-media-retry" });
      const retryOutcome = await publishAssetToInstagram({ db, storage, instagramClient: retryClient, draftId: draft.id, assetId: asset.id });
      expect(retryOutcome.status).toBe("success");
    });
  });

  describe("media-publish failure", () => {
    it("12. a publish-container failure ends in a failed, retryable state", async () => {
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1");
      const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
      const instagramClient = new ScriptedInstagramClient({ creationId: "container-x", failPublishWith: instagramRejection("Media ID is not available.") });

      const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id });

      expect(outcome.status).toBe("failed");
      const publication = await getPublication(db, asset.id, "instagram");
      expect(publication?.status).toBe("failed");
      expect(publication?.meta_post_id).toBeNull();

      const retryClient = new ScriptedInstagramClient({ creationId: "container-y", mediaId: "ig-media-retry-2" });
      const retryOutcome = await publishAssetToInstagram({ db, storage, instagramClient: retryClient, draftId: draft.id, assetId: asset.id });
      expect(retryOutcome.status).toBe("success");
    });
  });

  describe("idempotency", () => {
    it("13. a second publish attempt for an already-published asset never calls Instagram again", async () => {
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1");
      const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
      const instagramClient = new ScriptedInstagramClient({ mediaId: "ig-media-first" });

      const first = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id });
      expect(first.status).toBe("success");

      const second = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id });

      expect(second.status).toBe("ineligible");
      expect(instagramClient.createCalls).toHaveLength(1);
      expect(fake.getAll("asset_publications")).toHaveLength(1);
    });

    it("14. Facebook and Instagram publish independently — a Facebook publication does not block Instagram for the same asset", async () => {
      // Two separate drafts pointing at the same brand/topic, each on
      // its own channel with its own approved asset — mirrors real
      // usage (one draft per channel), while proving the (asset_id,
      // channel) slot is genuinely per-channel, not per-asset only.
      const { fake, db, storage } = setup();
      const fbDraft = seedDraft(fake, "draft-fb", { channel: "facebook" });
      const igDraft = buildDraft("draft-ig", { channel: "instagram" });
      fake.seed("content_drafts", [{ ...fbDraft }, igDraft]);
      const fbAsset = await seedReadyToPublishAsset(fake, db, storage, fbDraft.id);
      const igAsset = await seedReadyToPublishAsset(fake, db, storage, igDraft.id);

      process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN = "fake-fb-token";
      process.env.META_FACEBOOK_PAGE_ID = "1225292840656707";
      const facebookClient = new ScriptedFacebookClient({ postId: "fb-post-1" });
      const instagramClient = new ScriptedInstagramClient({ mediaId: "ig-media-1" });

      const fbOutcome = await publishAssetToFacebook({ db, storage, facebookClient, draftId: fbDraft.id, assetId: fbAsset.id });
      const igOutcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: igDraft.id, assetId: igAsset.id });

      expect(fbOutcome.status).toBe("success");
      expect(igOutcome.status).toBe("success");
      expect(fake.getAll("asset_publications")).toHaveLength(2);
    });
  });

  describe("container readiness polling", () => {
    it("15. a FINISHED container on the first check publishes immediately, exactly once", async () => {
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1");
      const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
      const instagramClient = new ScriptedInstagramClient({ creationId: "container-1", mediaId: "ig-media-1", statusSequence: ["FINISHED"] });

      const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id, delay: noDelay });

      expect(outcome.status).toBe("success");
      expect(instagramClient.statusCalls).toEqual(["container-1"]);
      expect(instagramClient.publishCalls).toEqual(["container-1"]);
      expect(outcome.publication?.meta_post_id).toBe("ig-media-1");
    });

    it("16. IN_PROGRESS then FINISHED waits/polls and then publishes exactly once", async () => {
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1");
      const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
      const instagramClient = new ScriptedInstagramClient({ creationId: "container-1", mediaId: "ig-media-1", statusSequence: ["IN_PROGRESS", "FINISHED"] });

      const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id, delay: noDelay });

      expect(outcome.status).toBe("success");
      expect(instagramClient.statusCalls).toEqual(["container-1", "container-1"]);
      expect(instagramClient.publishCalls).toEqual(["container-1"]);
    });

    it("17. several IN_PROGRESS checks before FINISHED still publishes exactly once", async () => {
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1");
      const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
      const instagramClient = new ScriptedInstagramClient({
        creationId: "container-1",
        mediaId: "ig-media-1",
        statusSequence: ["IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "FINISHED"],
      });

      const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id, delay: noDelay });

      expect(outcome.status).toBe("success");
      expect(instagramClient.statusCalls).toHaveLength(4);
      expect(instagramClient.publishCalls).toHaveLength(1);
    });

    it("18. an ERROR status never calls media_publish and marks the publication failed, retryably", async () => {
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1");
      const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
      const instagramClient = new ScriptedInstagramClient({ creationId: "container-1", statusSequence: ["ERROR"] });

      const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id, delay: noDelay });

      expect(outcome.status).toBe("failed");
      expect(instagramClient.publishCalls).toHaveLength(0);
      const publication = await getPublication(db, asset.id, "instagram");
      expect(publication?.status).toBe("failed");
      expect(publication?.meta_post_id).toBeNull();

      const retryClient = new ScriptedInstagramClient({ creationId: "container-2", mediaId: "ig-media-retry" });
      const retryOutcome = await publishAssetToInstagram({ db, storage, instagramClient: retryClient, draftId: draft.id, assetId: asset.id, delay: noDelay });
      expect(retryOutcome.status).toBe("success");
    });

    it("19. an EXPIRED status never calls media_publish and marks the publication failed", async () => {
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1");
      const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
      const instagramClient = new ScriptedInstagramClient({ creationId: "container-1", statusSequence: ["EXPIRED"] });

      const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id, delay: noDelay });

      expect(outcome.status).toBe("failed");
      expect(instagramClient.publishCalls).toHaveLength(0);
      const publication = await getPublication(db, asset.id, "instagram");
      expect(publication?.status).toBe("failed");
    });

    it("20. a PUBLISHED status (already published by an earlier attempt) never calls media_publish again and fails conservatively", async () => {
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1");
      const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
      const instagramClient = new ScriptedInstagramClient({ creationId: "container-1", statusSequence: ["PUBLISHED"] });

      const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id, delay: noDelay });

      expect(outcome.status).toBe("failed");
      expect(instagramClient.publishCalls).toHaveLength(0);
      const publication = await getPublication(db, asset.id, "instagram");
      expect(publication?.status).toBe("failed");
    });

    it("21. a container stuck IN_PROGRESS past the bounded attempt limit times out safely without ever publishing", async () => {
      const { fake, db, storage } = setup();
      const draft = seedDraft(fake, "draft-1");
      const asset = await seedReadyToPublishAsset(fake, db, storage, draft.id);
      const instagramClient = new ScriptedInstagramClient({ creationId: "container-1", statusSequence: ["IN_PROGRESS"] });

      const outcome = await publishAssetToInstagram({ db, storage, instagramClient, draftId: draft.id, assetId: asset.id, delay: noDelay });

      expect(outcome.status).toBe("failed");
      expect(instagramClient.publishCalls).toHaveLength(0);
      expect(instagramClient.statusCalls.length).toBeGreaterThan(1);
      const publication = await getPublication(db, asset.id, "instagram");
      expect(publication?.status).toBe("failed");

      // Retryable: no real container was ever published.
      const retryClient = new ScriptedInstagramClient({ creationId: "container-2", mediaId: "ig-media-retry-2" });
      const retryOutcome = await publishAssetToInstagram({ db, storage, instagramClient: retryClient, draftId: draft.id, assetId: asset.id, delay: noDelay });
      expect(retryOutcome.status).toBe("success");
    });
  });
});
