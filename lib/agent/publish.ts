import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, AssetPublicationRow, PublicationChannel } from "@/lib/types/database";
import type { AssetStorage } from "@/lib/agent/assetStorage";
import { FacebookPublishError, facebookPublishingCapabilityAvailable, type FacebookPageClient } from "@/lib/agent/facebookClient";
import { InstagramPublishError, instagramPublishingCapabilityAvailable, type InstagramGraphClient } from "@/lib/agent/instagramClient";
import { isUniqueViolation } from "@/lib/agent/runLock";
import { resolveCtaLabelAndUrl } from "@/lib/agent/cta";

// AlexAgent v0.2 — Facebook manual publishing (checkpoint 1), extended
// (checkpoint: Instagram publication service) with
// publishAssetToInstagram() reusing the same claim/reclaim/idempotency
// mechanism, parametrized by channel.
//
// publishAssetToFacebook() / publishAssetToInstagram() are the single
// entry points behind their respective explicit "Publish to ..."
// buttons on a Ready-to-publish image_post asset. Manual-only: never
// invoked from runMarketingCycle, approveDraft, or generateAsset.
// Consume exactly the already-approved caption/hook and the
// already-approved image — never regenerate or call the
// Planner/Executor/Visual Director.
//
// Idempotency / no-double-publish: before ever calling the Meta Graph
// API, this claims a row in asset_publications keyed by (asset_id,
// channel) — the unique constraint added in
// supabase/migrations/0006_asset_publications.sql (widened to allow
// 'instagram' in 0008_asset_publications_instagram_channel.sql) is the
// actual concurrency guarantee (mirrors the agent_runs / content_assets
// lock patterns elsewhere in this codebase), not just a disabled UI
// button. If Meta succeeds but the follow-up local UPDATE fails, this
// deliberately does NOT retry Meta — it surfaces the real post/media id
// so Alex can reconcile manually rather than risk a duplicate post.

function channelLabel(channel: PublicationChannel): string {
  return channel === "facebook" ? "Facebook" : "Instagram";
}

/**
 * Deterministic append-if-missing caption composition shared by
 * Facebook and Instagram publishing (see cta.ts): appends the resolved
 * CTA destination exactly once when the approved draft has one and the
 * human-written caption doesn't already contain it verbatim. Never
 * invents copy, never sends cta_text itself as a caption substitute,
 * never duplicates the URL if it's already present.
 */
function composeCaptionWithCtaDestination(baseCaption: string, draft: { cta_text: string | null; cta_url: string | null }): string {
  const { url: ctaDestination } = resolveCtaLabelAndUrl(draft);
  return ctaDestination && !baseCaption.includes(ctaDestination) ? `${baseCaption}\n\n${ctaDestination}` : baseCaption;
}

export interface PublishAssetOutcome {
  status: "success" | "ineligible" | "failed" | "concurrent";
  message?: string;
  publication?: AssetPublicationRow;
}

async function getExistingPublication(
  db: SupabaseClient<Database>,
  assetId: string,
  channel: PublicationChannel
): Promise<AssetPublicationRow | null> {
  const { data } = await db
    .from("asset_publications")
    .select("*")
    .eq("asset_id", assetId)
    .eq("channel", channel)
    .maybeSingle();
  return data ?? null;
}

async function markPublicationFailed(db: SupabaseClient<Database>, id: string, message: string) {
  await db
    .from("asset_publications")
    .update({ status: "failed", error_message: message, updated_at: new Date().toISOString() })
    .eq("id", id);
}

type ClaimResult =
  | { ok: true; row: AssetPublicationRow }
  | { ok: false; outcome: PublishAssetOutcome };

/**
 * Atomically claims the (asset_id, channel) publish slot. Only one
 * concurrent caller can win: either the INSERT succeeds outright, or
 * it hits the unique constraint and this inspects the existing row —
 * a 'failed' row (a previous attempt that never reached Meta, or that
 * Meta itself rejected) can be safely reclaimed via a conditional
 * UPDATE; a 'publishing' or 'published' row blocks outright.
 */
async function claimPublicationSlot(
  db: SupabaseClient<Database>,
  params: { assetId: string; draftId: string; brand: string; channel: PublicationChannel }
): Promise<ClaimResult> {
  const label = channelLabel(params.channel);
  const { data: inserted, error: insertError } = await db
    .from("asset_publications")
    .insert({ asset_id: params.assetId, draft_id: params.draftId, brand: params.brand, channel: params.channel, status: "publishing" })
    .select("*")
    .single();

  if (!insertError && inserted) {
    return { ok: true, row: inserted };
  }

  if (!isUniqueViolation(insertError)) {
    return { ok: false, outcome: { status: "failed", message: insertError?.message ?? "Could not start the publish attempt." } };
  }

  const existing = await getExistingPublication(db, params.assetId, params.channel);
  if (!existing) {
    return { ok: false, outcome: { status: "concurrent", message: "Could not verify this asset's publish state. Please retry shortly." } };
  }

  if (existing.status === "published") {
    return {
      ok: false,
      outcome: {
        status: "ineligible",
        message: `This asset was already published to ${label} (post ${existing.meta_post_id}).`,
        publication: existing,
      },
    };
  }

  if (existing.status === "publishing") {
    return {
      ok: false,
      outcome: {
        status: "concurrent",
        message: `A publish attempt for this asset is already in progress or ended in an uncertain state. Check ${label} manually before retrying.`,
      },
    };
  }

  // existing.status === "failed": no real post/media resulted from that
  // attempt — safe to reclaim. Guarded update so only one racing retry
  // actually wins the reclaim.
  const { data: reclaimed, error: reclaimError } = await db
    .from("asset_publications")
    .update({ status: "publishing", error_message: null, updated_at: new Date().toISOString() })
    .eq("id", existing.id)
    .eq("status", "failed")
    .select("*")
    .single();

  if (reclaimError || !reclaimed) {
    return {
      ok: false,
      outcome: { status: "concurrent", message: `Another publish attempt for this asset just started. Check ${label} manually before retrying.` },
    };
  }

  return { ok: true, row: reclaimed };
}

export async function publishAssetToFacebook(params: {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  facebookClient: FacebookPageClient;
  draftId: string;
  assetId: string;
}): Promise<PublishAssetOutcome> {
  const { db, storage, facebookClient, draftId, assetId } = params;

  if (!facebookPublishingCapabilityAvailable()) {
    return {
      status: "failed",
      message: "Facebook publishing is not configured (missing META_FACEBOOK_PAGE_ACCESS_TOKEN / META_FACEBOOK_PAGE_ID).",
    };
  }

  const { data: draft, error: draftError } = await db.from("content_drafts").select("*").eq("id", draftId).single();
  if (draftError || !draft) {
    return { status: "ineligible", message: "Draft not found." };
  }

  const { data: asset, error: assetError } = await db.from("content_assets").select("*").eq("id", assetId).single();
  if (assetError || !asset) {
    return { status: "ineligible", message: "Asset not found." };
  }
  if (asset.draft_id !== draft.id) {
    return { status: "ineligible", message: "Asset does not belong to the specified draft." };
  }
  if (draft.brand !== "solardesk") {
    return { status: "ineligible", message: "Facebook publishing is only supported for SolarDesk." };
  }
  if (draft.channel !== "facebook") {
    return { status: "ineligible", message: `Draft channel is "${draft.channel}" — this checkpoint only publishes to Facebook.` };
  }
  if (draft.content_type !== "image_post") {
    return { status: "ineligible", message: `Content type "${draft.content_type}" is not supported by Facebook publishing yet.` };
  }
  if (asset.format !== "image_post") {
    return { status: "ineligible", message: `Asset format "${asset.format}" is not supported by Facebook publishing yet.` };
  }
  if (asset.status !== "ready_to_publish") {
    return { status: "ineligible", message: `Asset is in status "${asset.status}" — only a Ready to publish asset can be published.` };
  }
  if (!asset.storage_path) {
    return { status: "ineligible", message: "Asset has no stored image file to publish." };
  }
  const baseCaption = (draft.caption ?? draft.hook ?? "").trim();
  if (!baseCaption) {
    return { status: "ineligible", message: "Draft has no approved caption or hook to publish." };
  }

  // Ensure the CTA destination reaches the actual published text (real
  // production gap, 2026-09-17): this endpoint never sends cta/cta_text
  // or a separate link field to Meta (see facebookClient.ts) — the
  // caption is the only text Facebook ever receives. composeCaptionWithCtaDestination
  // appends the destination deterministically (see its doc comment).
  const caption = composeCaptionWithCtaDestination(baseCaption, draft);

  const claim = await claimPublicationSlot(db, { assetId: asset.id, draftId: draft.id, brand: draft.brand, channel: "facebook" });
  if (!claim.ok) {
    return claim.outcome;
  }
  const lockRow = claim.row;

  let imageBuffer: Buffer;
  try {
    imageBuffer = await storage.download(asset.storage_path);
  } catch (err) {
    const message = `Could not read the stored asset image: ${err instanceof Error ? err.message : "unknown error"}`;
    await markPublicationFailed(db, lockRow.id, message);
    return { status: "failed", message };
  }

  let result;
  try {
    result = await facebookClient.publishImagePost({ message: caption, imageBuffer });
  } catch (err) {
    const message = err instanceof FacebookPublishError ? err.message : `Unexpected error publishing to Facebook: ${err instanceof Error ? err.message : "unknown error"}`;
    await markPublicationFailed(db, lockRow.id, message);
    return { status: "failed", message };
  }

  const { data: updated, error: updateError } = await db
    .from("asset_publications")
    .update({ status: "published", meta_post_id: result.postId, published_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", lockRow.id)
    .eq("status", "publishing")
    .select("*")
    .single();

  if (updateError || !updated) {
    // Meta already created the real post — never retry it. This is
    // the conservative-over-duplicate path the checkpoint requires.
    return {
      status: "failed",
      message: `Facebook published the post successfully (post ID: ${result.postId}) but AlexAgent could not record it locally (${updateError?.message ?? "unknown error"}). Do NOT retry publishing this asset — verify on Facebook and reconcile manually.`,
    };
  }

  return { status: "success", publication: updated };
}

// Instagram publishing readiness checkpoint (service layer only — no
// UI/server action/live smoke yet). Same manual-only, no-regenerate
// contract as publishAssetToFacebook, reusing the exact same
// claim/reclaim/idempotency mechanism (channel = "instagram") and the
// same deterministic CTA-destination caption composition. Instagram's
// two-step Graph flow (create media container, then publish it) means
// a create-container failure never reaches Meta's publish step, and a
// publish-container failure leaves no live post behind (an unpublished
// container isn't visible on the account), so both failure points are
// safely retryable via the existing 'failed' → reclaim path — unlike
// Facebook's single-call /photos upload, there is no "Meta already
// created the real post" ambiguity before the final publish call
// succeeds.
const INSTAGRAM_IMAGE_URL_TTL_SECONDS = 300;

// Meta processes a newly-created single-image container asynchronously
// (fetching + validating image_url) before it can be published;
// publishing before it reaches FINISHED is exactly what produces the
// real "Media ID is not available" failure this polling closes. 6
// attempts x 1500ms = at most ~7.5s of extra wait, well within a
// synchronous manual "Confirm & Publish" click — a single image
// container normally finishes in low single-digit seconds.
const INSTAGRAM_CONTAINER_POLL_INTERVAL_MS = 1500;
const INSTAGRAM_CONTAINER_MAX_POLL_ATTEMPTS = 6;

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded readiness gate between create and publish. Only a FINISHED
 * status is safe to publish; ERROR/EXPIRED are terminal Meta-side
 * failures, and PUBLISHED means some earlier call already published
 * this exact container — never call media_publish on it again. Any
 * non-FINISHED outcome throws InstagramPublishError so it flows
 * through publishAssetToInstagram's existing markPublicationFailed
 * path exactly like a create/publish rejection does today.
 */
async function waitForInstagramContainerReady(
  instagramClient: InstagramGraphClient,
  containerId: string,
  delay: (ms: number) => Promise<void>
): Promise<void> {
  for (let attempt = 1; attempt <= INSTAGRAM_CONTAINER_MAX_POLL_ATTEMPTS; attempt++) {
    const { statusCode } = await instagramClient.getMediaContainerStatus(containerId);

    if (statusCode === "FINISHED") {
      return;
    }
    if (statusCode === "ERROR") {
      throw new InstagramPublishError("The Instagram media container failed processing (status ERROR) — it cannot be published.");
    }
    if (statusCode === "EXPIRED") {
      throw new InstagramPublishError("The Instagram media container expired before it could be published (status EXPIRED).");
    }
    if (statusCode === "PUBLISHED") {
      throw new InstagramPublishError("The Instagram media container was already published by an earlier attempt — refusing to publish it again.");
    }

    // statusCode === "IN_PROGRESS": wait and poll again, unless this was the last attempt.
    if (attempt < INSTAGRAM_CONTAINER_MAX_POLL_ATTEMPTS) {
      await delay(INSTAGRAM_CONTAINER_POLL_INTERVAL_MS);
    }
  }

  throw new InstagramPublishError(
    `The Instagram media container did not finish processing after ${INSTAGRAM_CONTAINER_MAX_POLL_ATTEMPTS} status checks (still IN_PROGRESS) — publish aborted.`
  );
}

export async function publishAssetToInstagram(params: {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  instagramClient: InstagramGraphClient;
  draftId: string;
  assetId: string;
  /** Injectable for deterministic fast tests; defaults to a real timer-based wait. */
  delay?: (ms: number) => Promise<void>;
}): Promise<PublishAssetOutcome> {
  const { db, storage, instagramClient, draftId, assetId, delay = defaultDelay } = params;

  if (!instagramPublishingCapabilityAvailable()) {
    return {
      status: "failed",
      message: "Instagram publishing is not configured (missing META_INSTAGRAM_ACCESS_TOKEN / META_INSTAGRAM_ACCOUNT_ID).",
    };
  }

  const { data: draft, error: draftError } = await db.from("content_drafts").select("*").eq("id", draftId).single();
  if (draftError || !draft) {
    return { status: "ineligible", message: "Draft not found." };
  }

  const { data: asset, error: assetError } = await db.from("content_assets").select("*").eq("id", assetId).single();
  if (assetError || !asset) {
    return { status: "ineligible", message: "Asset not found." };
  }
  if (asset.draft_id !== draft.id) {
    return { status: "ineligible", message: "Asset does not belong to the specified draft." };
  }
  if (draft.brand !== "solardesk") {
    return { status: "ineligible", message: "Instagram publishing is only supported for SolarDesk." };
  }
  if (draft.channel !== "instagram") {
    return { status: "ineligible", message: `Draft channel is "${draft.channel}" — this checkpoint only publishes to Instagram.` };
  }
  if (draft.content_type !== "image_post") {
    return { status: "ineligible", message: `Content type "${draft.content_type}" is not supported by Instagram publishing yet.` };
  }
  if (asset.format !== "image_post") {
    return { status: "ineligible", message: `Asset format "${asset.format}" is not supported by Instagram publishing yet.` };
  }
  if (asset.status !== "ready_to_publish") {
    return { status: "ineligible", message: `Asset is in status "${asset.status}" — only a Ready to publish asset can be published.` };
  }
  if (!asset.storage_path) {
    return { status: "ineligible", message: "Asset has no stored image file to publish." };
  }
  const baseCaption = (draft.caption ?? draft.hook ?? "").trim();
  if (!baseCaption) {
    return { status: "ineligible", message: "Draft has no approved caption or hook to publish." };
  }

  const caption = composeCaptionWithCtaDestination(baseCaption, draft);

  const claim = await claimPublicationSlot(db, { assetId: asset.id, draftId: draft.id, brand: draft.brand, channel: "instagram" });
  if (!claim.ok) {
    return claim.outcome;
  }
  const lockRow = claim.row;

  // Meta fetches the image itself from this URL — never downloaded or
  // re-uploaded by this service. Short TTL: only needs to outlive the
  // immediate create-container + publish-container round trip, not the
  // UI preview lifetime (see app/(app)/approvals/[id]/page.tsx's 3600s
  // preview signed URL, a different use case).
  const imageUrl = await storage.createSignedUrl(asset.storage_path, INSTAGRAM_IMAGE_URL_TTL_SECONDS);
  if (!imageUrl) {
    const message = "Could not create a signed URL for the stored asset image.";
    await markPublicationFailed(db, lockRow.id, message);
    return { status: "failed", message };
  }

  let creationId: string;
  try {
    const container = await instagramClient.createMediaContainer({ imageUrl, caption });
    creationId = container.creationId;
  } catch (err) {
    const message =
      err instanceof InstagramPublishError ? err.message : `Unexpected error creating the Instagram media container: ${err instanceof Error ? err.message : "unknown error"}`;
    await markPublicationFailed(db, lockRow.id, message);
    return { status: "failed", message };
  }

  try {
    await waitForInstagramContainerReady(instagramClient, creationId, delay);
  } catch (err) {
    const message =
      err instanceof InstagramPublishError ? err.message : `Unexpected error checking Instagram media container readiness: ${err instanceof Error ? err.message : "unknown error"}`;
    await markPublicationFailed(db, lockRow.id, message);
    return { status: "failed", message };
  }

  let mediaId: string;
  try {
    const published = await instagramClient.publishMediaContainer(creationId);
    mediaId = published.mediaId;
  } catch (err) {
    const message =
      err instanceof InstagramPublishError ? err.message : `Unexpected error publishing the Instagram media container: ${err instanceof Error ? err.message : "unknown error"}`;
    await markPublicationFailed(db, lockRow.id, message);
    return { status: "failed", message };
  }

  const { data: updated, error: updateError } = await db
    .from("asset_publications")
    .update({ status: "published", meta_post_id: mediaId, published_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", lockRow.id)
    .eq("status", "publishing")
    .select("*")
    .single();

  if (updateError || !updated) {
    // Meta already published the real media — never retry it. Same
    // conservative-over-duplicate path as Facebook's equivalent gap.
    return {
      status: "failed",
      message: `Instagram published the post successfully (media ID: ${mediaId}) but AlexAgent could not record it locally (${updateError?.message ?? "unknown error"}). Do NOT retry publishing this asset — verify on Instagram and reconcile manually.`,
    };
  }

  return { status: "success", publication: updated };
}

export async function getPublication(
  db: SupabaseClient<Database>,
  assetId: string,
  channel: PublicationChannel = "facebook"
): Promise<AssetPublicationRow | null> {
  return getExistingPublication(db, assetId, channel);
}
