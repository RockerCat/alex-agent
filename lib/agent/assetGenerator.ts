import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentAssetRow } from "@/lib/types/database";
import { renderImagePostAsset, AssetRenderError } from "@/lib/agent/assetRenderer";
import { AssetStorageError, type AssetStorage } from "@/lib/agent/assetStorage";

export interface GenerateAssetOutcome {
  status: "success" | "ineligible" | "failed" | "concurrent";
  asset?: ContentAssetRow;
  message?: string;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505");
}

export async function getLatestAsset(
  db: SupabaseClient<Database>,
  draftId: string
): Promise<ContentAssetRow | null> {
  const { data } = await db
    .from("content_assets")
    .select("*")
    .eq("draft_id", draftId)
    .order("asset_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

export async function listAssets(db: SupabaseClient<Database>, draftId: string): Promise<ContentAssetRow[]> {
  const { data } = await db
    .from("content_assets")
    .select("*")
    .eq("draft_id", draftId)
    .order("asset_version", { ascending: false });
  return data ?? [];
}

/**
 * Manual-only entry point: this must be called ONLY from an explicit
 * Alex-initiated UI action (Generate Asset / Regenerate). It is never
 * wired into runMarketingCycle or approveDraft — no background job and
 * no content approval automatically produces an asset (spec section 4
 * of the v0.2 vertical-slice task).
 *
 * Always re-reads the draft fresh from the DB rather than trusting any
 * client-supplied state, so a stale/changed draft is caught here. Never
 * mutates content_drafts. Always inserts a new content_assets row (never
 * updates/overwrites an existing one) so history — including failed
 * attempts — is preserved; the highest asset_version for a draft is the
 * current candidate by construction.
 */
export async function generateAsset(params: {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  draftId: string;
}): Promise<GenerateAssetOutcome> {
  const { db, storage, draftId } = params;

  const { data: draft, error: draftError } = await db.from("content_drafts").select("*").eq("id", draftId).single();
  if (draftError || !draft) {
    return { status: "ineligible", message: "Draft not found." };
  }
  if (draft.brand !== "solardesk") {
    return { status: "ineligible", message: "Asset generation is only supported for SolarDesk." };
  }
  if (draft.status !== "approved") {
    return { status: "ineligible", message: `Draft is in status "${draft.status}" — only an approved draft can generate an asset.` };
  }
  if (draft.content_type !== "image_post") {
    return { status: "ineligible", message: `Content type "${draft.content_type}" is not supported yet — only image_post.` };
  }
  if (!draft.hook || !draft.cta_text) {
    return { status: "ineligible", message: "The approved draft does not have enough approved text (hook/CTA) to render a safe asset." };
  }

  const existing = await listAssets(db, draftId);
  const nextVersion = (existing[0]?.asset_version ?? 0) + 1;

  let rendered;
  try {
    rendered = await renderImagePostAsset({
      headline: draft.hook,
      ctaText: draft.cta_text,
      assetVersion: nextVersion,
    });
  } catch (err) {
    const message = err instanceof AssetRenderError ? err.message : `Unexpected render error: ${err instanceof Error ? err.message : String(err)}`;
    const { data: failedRow, error: insertError } = await db
      .from("content_assets")
      .insert({
        draft_id: draftId,
        brand: draft.brand,
        asset_version: nextVersion,
        source_draft_version: draft.version,
        status: "generation_failed",
        error_message: message,
        render_provenance: {},
      })
      .select("*")
      .single();
    if (insertError) {
      if (isUniqueViolation(insertError)) {
        return { status: "concurrent", message: "Another generation for this draft is already in progress. Please try again." };
      }
      return { status: "failed", message: `Render failed (${message}) and the failure could not be recorded: ${insertError.message}` };
    }
    return { status: "failed", asset: failedRow, message };
  }

  const storagePath = `${draftId}/v${nextVersion}.png`;
  try {
    await storage.upload(storagePath, rendered.png, "image/png");
  } catch (err) {
    const message = err instanceof AssetStorageError ? err.message : `Unexpected storage error: ${err instanceof Error ? err.message : String(err)}`;
    const { data: failedRow, error: insertError } = await db
      .from("content_assets")
      .insert({
        draft_id: draftId,
        brand: draft.brand,
        asset_version: nextVersion,
        source_draft_version: draft.version,
        status: "generation_failed",
        error_message: `Storage upload failed: ${message}`,
        render_provenance: rendered.provenance,
      })
      .select("*")
      .single();
    if (insertError) {
      if (isUniqueViolation(insertError)) {
        return { status: "concurrent", message: "Another generation for this draft is already in progress. Please try again." };
      }
      return { status: "failed", message: `Storage upload failed (${message}) and the failure could not be recorded: ${insertError.message}` };
    }
    return { status: "failed", asset: failedRow, message: `Storage upload failed: ${message}` };
  }

  const { data: asset, error: insertError } = await db
    .from("content_assets")
    .insert({
      draft_id: draftId,
      brand: draft.brand,
      asset_version: nextVersion,
      source_draft_version: draft.version,
      status: "pending_review",
      format: "image_post",
      width: rendered.width,
      height: rendered.height,
      mime_type: "image/png",
      storage_bucket: "solardesk-assets",
      storage_path: storagePath,
      render_provenance: rendered.provenance,
    })
    .select("*")
    .single();

  if (insertError || !asset) {
    if (isUniqueViolation(insertError)) {
      return { status: "concurrent", message: "Another generation for this draft is already in progress. Please try again." };
    }
    return { status: "failed", message: `Generated asset could not be persisted: ${insertError?.message ?? "unknown error"}` };
  }

  return { status: "success", asset };
}

export interface ApproveAssetOutcome {
  ok: boolean;
  message?: string;
  asset?: ContentAssetRow;
}

export async function approveAsset(db: SupabaseClient<Database>, assetId: string): Promise<ApproveAssetOutcome> {
  const { data: asset, error } = await db.from("content_assets").select("*").eq("id", assetId).single();
  if (error || !asset) {
    return { ok: false, message: "Asset not found." };
  }
  if (asset.status !== "pending_review") {
    return { ok: false, message: `Asset is in status "${asset.status}" and cannot be approved right now.` };
  }

  const { data: updated, error: updateError } = await db
    .from("content_assets")
    .update({ status: "ready_to_publish", approved_at: new Date().toISOString() })
    .eq("id", assetId)
    .eq("status", "pending_review")
    .select("*")
    .single();

  if (updateError || !updated) {
    return { ok: false, message: updateError?.message ?? "Asset could not be approved (it may have changed state concurrently)." };
  }

  return { ok: true, asset: updated };
}
