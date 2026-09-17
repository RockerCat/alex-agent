import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, AssetPublicationRow } from "@/lib/types/database";
import type { AssetStorage } from "@/lib/agent/assetStorage";
import { FacebookPublishError, facebookPublishingCapabilityAvailable, type FacebookPageClient } from "@/lib/agent/facebookClient";
import { isUniqueViolation } from "@/lib/agent/runLock";
import { resolveCtaLabelAndUrl } from "@/lib/agent/cta";

// AlexAgent v0.2 — Facebook manual publishing (checkpoint 1).
//
// publishAssetToFacebook() is the single entry point behind the
// explicit "Publish to Facebook" button on a Ready-to-publish
// image_post asset. Manual-only: never invoked from runMarketingCycle,
// approveDraft, or generateAsset. Consumes exactly the already-approved
// caption/hook and the already-approved image — never regenerates or
// calls the Planner/Executor/Visual Director.
//
// Idempotency / no-double-publish: before ever calling the Meta Graph
// API, this claims a row in asset_publications keyed by (asset_id,
// channel) — the unique constraint added in
// supabase/migrations/0006_asset_publications.sql is the actual
// concurrency guarantee (mirrors the agent_runs / content_assets lock
// patterns elsewhere in this codebase), not just a disabled UI button.
// If Meta succeeds but the follow-up local UPDATE fails, this
// deliberately does NOT retry Meta — it surfaces the real post id so
// Alex can reconcile manually rather than risk a duplicate post.

const CHANNEL = "facebook" as const;

export interface PublishAssetOutcome {
  status: "success" | "ineligible" | "failed" | "concurrent";
  message?: string;
  publication?: AssetPublicationRow;
}

async function getExistingPublication(
  db: SupabaseClient<Database>,
  assetId: string
): Promise<AssetPublicationRow | null> {
  const { data } = await db
    .from("asset_publications")
    .select("*")
    .eq("asset_id", assetId)
    .eq("channel", CHANNEL)
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
  params: { assetId: string; draftId: string; brand: string }
): Promise<ClaimResult> {
  const { data: inserted, error: insertError } = await db
    .from("asset_publications")
    .insert({ asset_id: params.assetId, draft_id: params.draftId, brand: params.brand, channel: CHANNEL, status: "publishing" })
    .select("*")
    .single();

  if (!insertError && inserted) {
    return { ok: true, row: inserted };
  }

  if (!isUniqueViolation(insertError)) {
    return { ok: false, outcome: { status: "failed", message: insertError?.message ?? "Could not start the publish attempt." } };
  }

  const existing = await getExistingPublication(db, params.assetId);
  if (!existing) {
    return { ok: false, outcome: { status: "concurrent", message: "Could not verify this asset's publish state. Please retry shortly." } };
  }

  if (existing.status === "published") {
    return {
      ok: false,
      outcome: {
        status: "ineligible",
        message: `This asset was already published to Facebook (post ${existing.meta_post_id}).`,
        publication: existing,
      },
    };
  }

  if (existing.status === "publishing") {
    return {
      ok: false,
      outcome: {
        status: "concurrent",
        message: "A publish attempt for this asset is already in progress or ended in an uncertain state. Check Facebook manually before retrying.",
      },
    };
  }

  // existing.status === "failed": no real Facebook post resulted from
  // that attempt — safe to reclaim. Guarded update so only one racing
  // retry actually wins the reclaim.
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
      outcome: { status: "concurrent", message: "Another publish attempt for this asset just started. Check Facebook manually before retrying." },
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
  // caption is the only text Facebook ever receives. If the approved
  // draft has a valid destination and the human-written caption doesn't
  // already include it verbatim, append it deterministically. Never
  // invents copy, never sends cta_text as a caption substitute, and
  // never duplicates the URL if it's already present.
  const { url: ctaDestination } = resolveCtaLabelAndUrl(draft);
  const caption =
    ctaDestination && !baseCaption.includes(ctaDestination) ? `${baseCaption}\n\n${ctaDestination}` : baseCaption;

  const claim = await claimPublicationSlot(db, { assetId: asset.id, draftId: draft.id, brand: draft.brand });
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

export async function getPublication(
  db: SupabaseClient<Database>,
  assetId: string
): Promise<AssetPublicationRow | null> {
  return getExistingPublication(db, assetId);
}
