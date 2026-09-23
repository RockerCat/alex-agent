import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentDraftRow } from "@/lib/types/database";
import {
  publishEmailAuthorizedAsset,
  runPublicationRecoverySweep,
  runAutoPublicationSafely,
  hasEmailPublicationAuthorization,
  type PublicationDeps,
} from "@/lib/agent/postApprovalPublication";
import { publishAssetToFacebook, publishAssetToInstagram, RETRY_SAFE_FAILURE_MARKER } from "@/lib/agent/publish";
import { MetaGraphFacebookClient, FacebookPublishError } from "@/lib/agent/facebookClient";
import { MetaGraphInstagramClient, InstagramPublishError } from "@/lib/agent/instagramClient";
import { composeFinalSocialCaption } from "@/lib/agent/finalCaption";
import { confirmEmailAction, createEmailActionTokens } from "@/lib/agent/emailActions";
import { createFakeDb, asSupabaseClient, type FakeDb } from "@/tests/support/fakeDb";
import { FakeAssetStorage } from "@/tests/support/fakeAssetStorage";
import { ScriptedFacebookClient, facebookRejection, facebookUncertainFailure } from "@/tests/support/fakeFacebookClient";
import { ScriptedInstagramClient, instagramRejection, instagramUncertainFailure } from "@/tests/support/fakeInstagramClient";

// Automatic exact-channel publication after the FINAL human authorization
// ("Aprobar publicación"), plus the conservative provider-outcome model it
// depends on: only provably-failed attempts are ever retried automatically;
// uncertain outcomes are held. Scripted Meta clients / stubbed fetch only.

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "44444444-4444-4444-8444-444444444444";
const NOTIFICATION_ID = "55555555-5555-4555-8555-555555555555";
const noDelay = async () => {};

function draftRow(overrides: Partial<ContentDraftRow> = {}): Record<string, unknown> {
  return {
    id: DRAFT_ID,
    plan_id: "plan-1",
    brand: "solardesk",
    created_by_run: null,
    channel: "instagram",
    content_type: "image_post",
    purpose: "p",
    topic: "t",
    audience: "a",
    cta: "Comenzar gratis",
    cta_url: "https://solardesk.co/register",
    target_date: "2026-09-26",
    status: "approved",
    version: 1,
    title: "Título",
    hook: "Hook",
    body: { slides: [{ slide: 1, text: "x" }] },
    caption: "Caption aprobado.",
    cta_text: "Comenzar gratis",
    visual_direction: "v",
    hashtags: ["#energiasolar", "#solardesk"],
    blocked_on_question_id: null,
    approved_at: "2026-09-25T13:00:00Z",
    rejected_at: null,
    created_at: "2026-09-25T13:00:00Z",
    updated_at: "2026-09-25T13:00:00Z",
    ...overrides,
  };
}

function assetRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ASSET_ID,
    draft_id: DRAFT_ID,
    brand: "solardesk",
    asset_version: 1,
    source_draft_version: 1,
    status: "ready_to_publish",
    format: "image_post",
    width: 1080,
    height: 1350,
    mime_type: "image/png",
    storage_bucket: "solardesk-assets",
    storage_path: "solardesk/asset-v1.png",
    render_provenance: {},
    error_message: null,
    created_at: "2026-09-25T14:00:00Z",
    approved_at: "2026-09-25T15:00:00Z",
    ...overrides,
  };
}

/** An APPLIED approve_asset email authorization for exactly this asset version. */
function authorizationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tok-" + Math.random().toString(36).slice(2),
    token_hash: "a".repeat(64),
    notification_id: NOTIFICATION_ID,
    action: "approve_asset",
    subject_type: "content_asset",
    subject_id: ASSET_ID,
    subject_version: 1,
    brand: "solardesk",
    expires_at: "2026-10-02T00:00:00Z",
    consumed_at: "2026-09-25T15:00:00Z",
    outcome: "applied",
    created_at: "2026-09-25T14:30:00Z",
    updated_at: "2026-09-25T15:00:00Z",
    ...overrides,
  };
}

interface Harness {
  fake: FakeDb;
  deps: PublicationDeps;
  facebookClient: ScriptedFacebookClient;
  instagramClient: ScriptedInstagramClient;
}

function setup(opts: { draft?: Partial<ContentDraftRow>; assets?: Record<string, unknown>[]; tokens?: Record<string, unknown>[]; publications?: Record<string, unknown>[]; facebookClient?: ScriptedFacebookClient; instagramClient?: ScriptedInstagramClient } = {}): Harness {
  const fake = createFakeDb();
  fake.seed("content_drafts", [draftRow(opts.draft)]);
  fake.seed("content_assets", opts.assets ?? [assetRow()]);
  fake.seed("email_action_tokens", opts.tokens ?? [authorizationRow()]);
  if (opts.publications) fake.seed("asset_publications", opts.publications);
  const storage = new FakeAssetStorage();
  storage.files.set("solardesk/asset-v1.png", Buffer.from([1, 2, 3]));
  storage.files.set("solardesk/asset-v2.png", Buffer.from([4, 5, 6]));
  const facebookClient = opts.facebookClient ?? new ScriptedFacebookClient({ postId: "fb-post-auto" });
  const instagramClient = opts.instagramClient ?? new ScriptedInstagramClient({ mediaId: "ig-media-auto" });
  const deps: PublicationDeps = { db: asSupabaseClient<SupabaseClient<Database>>(fake), storage, facebookClient, instagramClient, delay: noDelay };
  return { fake, deps, facebookClient, instagramClient };
}

const providerMutations = (h: Harness) => h.facebookClient.calls.length + h.instagramClient.publishCalls.length;
const publicationRow = (h: Harness) => h.fake.getAll("asset_publications")[0];

beforeEach(() => {
  vi.stubEnv("META_FACEBOOK_PAGE_ACCESS_TOKEN", "fake-fb-token");
  vi.stubEnv("META_FACEBOOK_PAGE_ID", "123");
  vi.stubEnv("META_INSTAGRAM_ACCESS_TOKEN", "fake-ig-token");
  vi.stubEnv("META_INSTAGRAM_ACCOUNT_ID", "456");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Provider outcome classification — at the raw client boundary (stubbed fetch)
// ---------------------------------------------------------------------------

function stubFetch(impl: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(impl));
}
const json = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function facebookError(): Promise<FacebookPublishError> {
  return new MetaGraphFacebookClient().publishImagePost({ message: "m", imageBuffer: Buffer.from([1]) }).then(
    () => {
      throw new Error("expected a failure");
    },
    (e) => e
  );
}
async function instagramPublishError(): Promise<InstagramPublishError> {
  return new MetaGraphInstagramClient().publishMediaContainer("container-1").then(
    () => {
      throw new Error("expected a failure");
    },
    (e) => e
  );
}

describe("provider outcome classification — Facebook POST /{page}/photos", () => {
  it("an authoritative Meta rejection (4xx + Graph error) is retry-safe", async () => {
    stubFetch(json(400, { error: { message: "Invalid OAuth access token.", code: 190 } }));
    expect((await facebookError()).retrySafe).toBe(true);
  });

  it("a network/timeout failure after the request may have been sent is uncertain", async () => {
    stubFetch(async () => {
      throw new Error("socket hang up");
    });
    expect((await facebookError()).retrySafe).toBe(false);
  });

  it("a malformed (non-JSON) response is uncertain", async () => {
    stubFetch(async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    expect((await facebookError()).retrySafe).toBe(false);
  });

  it("a 5xx response, even with a Graph error body, is uncertain", async () => {
    stubFetch(json(500, { error: { message: "An unknown error occurred", code: 1 } }));
    expect((await facebookError()).retrySafe).toBe(false);
  });

  it("a success-like response without a post/photo id is uncertain", async () => {
    stubFetch(json(200, {}));
    expect((await facebookError()).retrySafe).toBe(false);
  });

  it("missing configuration (nothing sent) is retry-safe", async () => {
    vi.stubEnv("META_FACEBOOK_PAGE_ACCESS_TOKEN", "");
    stubFetch(async () => {
      throw new Error("must not be called");
    });
    expect((await facebookError()).retrySafe).toBe(true);
  });
});

describe("provider outcome classification — Instagram media_publish", () => {
  it("an explicit authoritative rejection is retry-safe", async () => {
    stubFetch(json(400, { error: { message: "Media ID is not available", code: 9007 } }));
    expect((await instagramPublishError()).retrySafe).toBe(true);
  });

  it("a network/timeout failure is uncertain", async () => {
    stubFetch(async () => {
      throw new Error("ETIMEDOUT");
    });
    expect((await instagramPublishError()).retrySafe).toBe(false);
  });

  it("a malformed response or a missing publication id is uncertain", async () => {
    stubFetch(async () => new Response("not json", { status: 200 }));
    expect((await instagramPublishError()).retrySafe).toBe(false);
    stubFetch(json(200, {}));
    expect((await instagramPublishError()).retrySafe).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Provider outcome classification — publisher persistence
// ---------------------------------------------------------------------------

describe("publishers persist definite failures as retry-safe 'failed' and hold uncertain outcomes", () => {
  it("Facebook: authoritative rejection → failed + retry-safe marker (reclaimable)", async () => {
    const h = setup({ draft: { channel: "facebook" }, facebookClient: new ScriptedFacebookClient({ failWith: facebookRejection("Meta Graph API rejected the publish request: Invalid OAuth access token.") }) });
    await publishAssetToFacebook({ db: h.deps.db, storage: h.deps.storage, facebookClient: h.facebookClient, draftId: DRAFT_ID, assetId: ASSET_ID });
    expect(publicationRow(h)).toMatchObject({ status: "failed" });
    expect(String(publicationRow(h).error_message).startsWith(RETRY_SAFE_FAILURE_MARKER)).toBe(true);
  });

  it("Facebook: uncertain outcome → row HELD in 'publishing' (never reclaimable), with a manual-verification diagnostic", async () => {
    const h = setup({ draft: { channel: "facebook" }, facebookClient: new ScriptedFacebookClient({ failWith: facebookUncertainFailure() }) });
    const outcome = await publishAssetToFacebook({ db: h.deps.db, storage: h.deps.storage, facebookClient: h.facebookClient, draftId: DRAFT_ID, assetId: ASSET_ID });
    expect(outcome).toMatchObject({ status: "failed", providerOutcomeUncertain: true });
    expect(publicationRow(h).status).toBe("publishing");
    expect(publicationRow(h).error_message).toContain("never retried automatically");

    const retry = await publishAssetToFacebook({ db: h.deps.db, storage: h.deps.storage, facebookClient: new ScriptedFacebookClient(), draftId: DRAFT_ID, assetId: ASSET_ID });
    expect(retry.status).toBe("concurrent"); // no second mutation, even manually
  });

  it("Facebook: an unexpected (unclassified) error during the provider call is treated as uncertain", async () => {
    const h = setup({ draft: { channel: "facebook" }, facebookClient: new ScriptedFacebookClient({ failWith: new Error("boom") }) });
    const outcome = await publishAssetToFacebook({ db: h.deps.db, storage: h.deps.storage, facebookClient: h.facebookClient, draftId: DRAFT_ID, assetId: ASSET_ID });
    expect(outcome.providerOutcomeUncertain).toBe(true);
    expect(publicationRow(h).status).toBe("publishing");
  });

  it("Instagram: any container-creation failure (pre-media_publish, nothing public) stays retry-safe", async () => {
    const h = setup({ instagramClient: new ScriptedInstagramClient({ failCreateWith: instagramUncertainFailure() }) });
    await publishAssetToInstagram({ db: h.deps.db, storage: h.deps.storage, instagramClient: h.instagramClient, draftId: DRAFT_ID, assetId: ASSET_ID, delay: noDelay });
    expect(publicationRow(h).status).toBe("failed");
    expect(String(publicationRow(h).error_message).startsWith(RETRY_SAFE_FAILURE_MARKER)).toBe(true);
    expect(h.instagramClient.publishCalls).toHaveLength(0);
  });

  it("Instagram: explicit media_publish rejection → retry-safe failed; uncertain media_publish → held", async () => {
    const rejected = setup({ instagramClient: new ScriptedInstagramClient({ failPublishWith: instagramRejection("Media ID is not available") }) });
    await publishAssetToInstagram({ db: rejected.deps.db, storage: rejected.deps.storage, instagramClient: rejected.instagramClient, draftId: DRAFT_ID, assetId: ASSET_ID, delay: noDelay });
    expect(publicationRow(rejected).status).toBe("failed");

    const uncertain = setup({ instagramClient: new ScriptedInstagramClient({ failPublishWith: instagramUncertainFailure() }) });
    const outcome = await publishAssetToInstagram({ db: uncertain.deps.db, storage: uncertain.deps.storage, instagramClient: uncertain.instagramClient, draftId: DRAFT_ID, assetId: ASSET_ID, delay: noDelay });
    expect(outcome.providerOutcomeUncertain).toBe(true);
    expect(publicationRow(uncertain).status).toBe("publishing");
  });
});

// ---------------------------------------------------------------------------
// Automatic publication after the email authorization
// ---------------------------------------------------------------------------

describe("publishEmailAuthorizedAsset — exact asset, exact channel, durable authorization", () => {
  it("Instagram draft → Instagram only, with the exact reviewed canonical caption and the exact approved asset", async () => {
    const h = setup();
    expect(await publishEmailAuthorizedAsset(h.deps, ASSET_ID)).toEqual({ status: "published", channel: "instagram" });
    expect(h.facebookClient.calls).toHaveLength(0);
    expect(h.instagramClient.publishCalls).toHaveLength(1);
    expect(h.instagramClient.createCalls[0].caption).toBe(composeFinalSocialCaption(h.fake.getAll("content_drafts")[0] as unknown as ContentDraftRow));
    expect(h.instagramClient.createCalls[0].imageUrl).toContain("solardesk/asset-v1.png");
    expect(publicationRow(h)).toMatchObject({ asset_id: ASSET_ID, channel: "instagram", status: "published", meta_post_id: "ig-media-auto" });
  });

  it("Facebook draft → Facebook only", async () => {
    const h = setup({ draft: { channel: "facebook" } });
    expect(await publishEmailAuthorizedAsset(h.deps, ASSET_ID)).toEqual({ status: "published", channel: "facebook" });
    expect(h.instagramClient.createCalls).toHaveLength(0);
    expect(h.facebookClient.calls).toHaveLength(1);
    expect(h.facebookClient.calls[0].message).toBe(composeFinalSocialCaption(h.fake.getAll("content_drafts")[0] as unknown as ContentDraftRow));
  });

  it("a dashboard-approved (or legacy) ready_to_publish asset without an applied email authorization is never published", async () => {
    for (const tokens of [[], [authorizationRow({ outcome: "stale" })], [authorizationRow({ consumed_at: null, outcome: null })], [authorizationRow({ subject_version: 2 })], [authorizationRow({ action: "approve_draft", subject_type: "content_draft" })]]) {
      const h = setup({ tokens });
      expect((await publishEmailAuthorizedAsset(h.deps, ASSET_ID)).status).toBe("not_authorized");
      expect(providerMutations(h)).toBe(0);
      expect(h.fake.getAll("asset_publications")).toHaveLength(0);
    }
  });

  it("never publishes a pending_review asset, a superseded asset, or an unsupported format", async () => {
    const pending = setup({ assets: [assetRow({ status: "pending_review" })] });
    expect((await publishEmailAuthorizedAsset(pending.deps, ASSET_ID)).status).toBe("not_eligible");

    const superseded = setup({ assets: [assetRow(), assetRow({ id: "66666666-6666-4666-8666-666666666666", asset_version: 2, status: "pending_review", storage_path: "solardesk/asset-v2.png" })] });
    expect((await publishEmailAuthorizedAsset(superseded.deps, ASSET_ID)).status).toBe("not_eligible");

    const carousel = setup({ draft: { content_type: "carousel" } });
    expect((await publishEmailAuthorizedAsset(carousel.deps, ASSET_ID)).status).toBe("not_eligible");

    for (const h of [pending, superseded, carousel]) expect(providerMutations(h)).toBe(0);
  });

  it("a successful publication is never repeated", async () => {
    const h = setup();
    await publishEmailAuthorizedAsset(h.deps, ASSET_ID);
    expect((await publishEmailAuthorizedAsset(h.deps, ASSET_ID)).status).toBe("already_published");
    expect(providerMutations(h)).toBe(1);
  });

  it("concurrent after() + cron attempts produce at most one provider mutation", async () => {
    const h = setup();
    const results = await Promise.all([publishEmailAuthorizedAsset(h.deps, ASSET_ID), publishEmailAuthorizedAsset(h.deps, ASSET_ID), runPublicationRecoverySweep(h.deps)]);
    expect(providerMutations(h)).toBe(1);
    expect(h.fake.getAll("asset_publications")).toHaveLength(1);
    expect(results.slice(0, 2).map((r) => (r as { status: string }).status)).toContain("published");
  });

  it("an uncertain provider outcome leaves the human approval intact and is held — never retried", async () => {
    const h = setup({ instagramClient: new ScriptedInstagramClient({ failPublishWith: instagramUncertainFailure() }) });
    expect((await publishEmailAuthorizedAsset(h.deps, ASSET_ID)).status).toBe("failed_uncertain_held");
    expect(h.fake.getAll("content_assets")[0].status).toBe("ready_to_publish");
    expect(await hasEmailPublicationAuthorization(h.deps.db, { id: ASSET_ID, asset_version: 1 })).toBe(true);

    expect((await publishEmailAuthorizedAsset(h.deps, ASSET_ID)).status).toBe("held");
    expect((await runPublicationRecoverySweep(h.deps)).outcomes).toEqual([]);
    expect(h.instagramClient.publishCalls).toHaveLength(1);
  });

  it("a definite failure is recovered later without any second human approval", async () => {
    const h = setup({ draft: { channel: "facebook" }, facebookClient: new ScriptedFacebookClient({ failWith: facebookRejection("Meta Graph API rejected the publish request: (#200) permissions") }) });
    expect((await publishEmailAuthorizedAsset(h.deps, ASSET_ID)).status).toBe("failed_retryable");
    expect(h.fake.getAll("email_action_tokens")).toHaveLength(1); // no new approval/token

    expect((await runPublicationRecoverySweep(h.deps)).outcomes).toEqual(["published"]);
    expect(publicationRow(h).status).toBe("published");
    expect(h.facebookClient.calls).toHaveLength(2);
  });
});

describe("runPublicationRecoverySweep", () => {
  it("publishes an email-authorized asset with no publication record", async () => {
    const h = setup();
    expect((await runPublicationRecoverySweep(h.deps)).outcomes).toEqual(["published"]);
  });

  it("never sweeps dashboard-approved/legacy ready_to_publish assets", async () => {
    const h = setup({ tokens: [] });
    expect((await runPublicationRecoverySweep(h.deps)).outcomes).toEqual([]);
    expect(providerMutations(h)).toBe(0);
  });

  it("skips published, holds in-flight/uncertain 'publishing', and holds historical failures without the retry-safe marker", async () => {
    for (const publication of [
      { status: "published", meta_post_id: "ig-1", error_message: null },
      { status: "publishing", meta_post_id: null, error_message: null },
      { status: "failed", meta_post_id: null, error_message: "Network error calling the Meta Graph API: socket hang up" }, // pre-classification row
    ]) {
      const h = setup({ publications: [{ id: "pub-1", asset_id: ASSET_ID, draft_id: DRAFT_ID, brand: "solardesk", channel: "instagram", ...publication }] });
      expect((await runPublicationRecoverySweep(h.deps)).outcomes).toEqual([]);
      expect((await publishEmailAuthorizedAsset(h.deps, ASSET_ID)).status).toMatch(/already_published|held/);
      expect(providerMutations(h)).toBe(0);
    }
  });

  it("retries a retry-safe failed publication", async () => {
    const h = setup({ publications: [{ id: "pub-1", asset_id: ASSET_ID, draft_id: DRAFT_ID, brand: "solardesk", channel: "instagram", status: "failed", meta_post_id: null, error_message: `${RETRY_SAFE_FAILURE_MARKER} Meta Graph API rejected the media request: Media ID is not available` }] });
    expect((await runPublicationRecoverySweep(h.deps)).outcomes).toEqual(["published"]);
  });

  it("is bounded, and one failure does not stop the others", async () => {
    const ids = ["a", "b", "c", "d"].map((c) => `${c.repeat(8)}-4444-4444-8444-444444444444`);
    const draftIds = ids.map((_, i) => `${String(i + 1).repeat(8)}-1111-4111-8111-111111111111`);
    const fake = createFakeDb();
    fake.seed("content_drafts", draftIds.map((id) => draftRow({ id, channel: "facebook" })));
    fake.seed("content_assets", ids.map((id, i) => assetRow({ id, draft_id: draftIds[i] })));
    fake.seed("email_action_tokens", ids.map((id, i) => authorizationRow({ id: `tok-${i}`, token_hash: String(i).repeat(64), subject_id: id, consumed_at: `2026-09-25T15:0${i}:00Z` })));
    const storage = new FakeAssetStorage();
    storage.files.set("solardesk/asset-v1.png", Buffer.from([1]));
    const facebookClient = new ScriptedFacebookClient({ failWith: facebookRejection("Meta Graph API rejected the publish request: rate limited") });
    const deps: PublicationDeps = { db: asSupabaseClient<SupabaseClient<Database>>(fake), storage, facebookClient, instagramClient: new ScriptedInstagramClient(), delay: noDelay };

    expect((await runPublicationRecoverySweep(deps, { limit: 3 })).outcomes).toEqual(["failed_retryable", "published", "published"]);
  });
});

describe("end-to-end: confirming 'Aprobar publicación' is the final authorization", () => {
  it("an applied approve_asset email action authorizes publication; a replay or stale action never does", async () => {
    const h = setup({ assets: [assetRow({ status: "pending_review", approved_at: null })], tokens: [] });
    const tokens = await createEmailActionTokens(h.deps.db, {
      notificationId: NOTIFICATION_ID,
      brand: "solardesk",
      subjectType: "content_asset",
      subjectId: ASSET_ID,
      subjectVersion: 1,
      actions: ["approve_asset"],
    });
    const applied: string[] = [];
    const confirm = () => confirmEmailAction(h.deps.db, tokens.approve_asset, undefined, { onApplied: (a) => applied.push(`${a.action}:${a.subjectId}`) });

    expect((await confirm()).result).toBe("applied");
    expect(applied).toEqual([`approve_asset:${ASSET_ID}`]);
    expect((await confirm()).result).toBe("already_processed"); // replay: no second trigger
    expect(applied).toHaveLength(1);

    // The route's post-response step, with injected (scripted) dependencies:
    await runAutoPublicationSafely(ASSET_ID, () => h.deps);
    expect(publicationRow(h)).toMatchObject({ channel: "instagram", status: "published" });
    expect(providerMutations(h)).toBe(1);
  });

  it("runAutoPublicationSafely never throws", async () => {
    await expect(runAutoPublicationSafely(ASSET_ID, () => null)).resolves.toBeUndefined();
    const h = setup();
    const broken = { ...h.deps, db: { from: () => { throw new Error("db down"); } } as unknown as PublicationDeps["db"] };
    await expect(runAutoPublicationSafely(ASSET_ID, () => broken)).resolves.toBeUndefined();
  });
});

describe("structural guarantees", () => {
  it("publication uses only the canonical publishers — no Planner/Executor/image generation/email approval", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("lib/agent/postApprovalPublication.ts", "utf-8");
    const imports = source.split("\n").filter((l) => l.startsWith("import "));
    for (const line of imports) {
      expect(line).not.toMatch(/aiClient|planner|executor|runtime|imageGeneration|emailClient|resend|emailReviewNotifications|emailTemplates/i);
    }
    expect(source).toMatch(/publishAssetToFacebook\(/);
    expect(source).toMatch(/publishAssetToInstagram\(/);
    expect(source).not.toMatch(/generateAsset\(|sendEmail\(|callPlanner\(|callExecutor\(/);
  });
});
