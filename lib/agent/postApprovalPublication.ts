import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentAssetRow, AssetPublicationRow } from "@/lib/types/database";
import type { AssetStorage } from "@/lib/agent/assetStorage";
import { SupabaseAssetStorage } from "@/lib/agent/assetStorage";
import type { FacebookPageClient } from "@/lib/agent/facebookClient";
import { MetaGraphFacebookClient } from "@/lib/agent/facebookClient";
import type { InstagramGraphClient } from "@/lib/agent/instagramClient";
import { MetaGraphInstagramClient } from "@/lib/agent/instagramClient";
import { publishAssetToFacebook, publishAssetToInstagram, getPublication, isRetrySafeFailure } from "@/lib/agent/publish";
import { getLatestAsset } from "@/lib/agent/assetGenerator";
import { supabaseAdmin } from "@/lib/supabase/admin";

// AlexAgent — automatic publication after the FINAL human authorization:
// the finished-publication email's "Aprobar publicación" (an applied,
// version-bound approve_asset email action). No third approval, no
// dashboard step. Publishes ONLY to the draft's exact channel, ONLY the
// exact approved asset/version, ONLY through the existing canonical
// publishers (publishAssetToFacebook / publishAssetToInstagram) — which
// already enforce every guard, send exactly composeFinalSocialCaption(draft),
// and claim the unique (asset_id, channel) publication slot before any
// Meta call, so the post-response trigger and the cron recovery can race
// without ever producing two Meta mutations.
//
// Authorization is DURABLE and exact: an asset may be auto-published only
// if an email_action_tokens row proves an APPLIED approve_asset for this
// exact asset id AND asset_version. A ready_to_publish asset approved in
// the dashboard (or any legacy one) has no such row and is never touched.
//
// Retry safety: automatic retries happen only for a 'failed' publication
// marked retry-safe (the provider definitely did not create the post —
// see RETRY_SAFE_FAILURE_MARKER in lib/agent/publish.ts). A 'publishing'
// row — an in-flight attempt, or an UNCERTAIN provider outcome held for
// manual verification — is never reclaimed, regardless of age. Older
// 'failed' rows without the marker can't be proven safe and are held.
// A publication failure never revokes the human approval.

export interface PublicationDeps {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  facebookClient: FacebookPageClient;
  instagramClient: InstagramGraphClient;
  /** Instagram container-readiness polling delay; injectable for tests. */
  delay?: (ms: number) => Promise<void>;
}

export type AutoPublishOutcome =
  | { status: "published"; channel: "facebook" | "instagram" }
  | { status: "not_authorized"; reason: string }
  | { status: "not_eligible"; reason: string }
  | { status: "already_published" }
  | { status: "held"; reason: string }
  | { status: "failed_retryable"; message: string }
  | { status: "failed_uncertain_held"; message: string }
  | { status: "concurrent" };

/** Durable proof that THIS exact asset version received an applied "Aprobar publicación" email action. */
export async function hasEmailPublicationAuthorization(
  db: SupabaseClient<Database>,
  asset: Pick<ContentAssetRow, "id" | "asset_version">
): Promise<boolean> {
  const { data } = await db
    .from("email_action_tokens")
    .select("id, consumed_at")
    .eq("action", "approve_asset")
    .eq("subject_type", "content_asset")
    .eq("subject_id", asset.id)
    .eq("subject_version", asset.asset_version)
    .eq("outcome", "applied");
  return (data ?? []).some((row) => row.consumed_at !== null);
}

/** What the existing publication record (if any) allows us to do automatically. */
function publicationGate(existing: AssetPublicationRow | null): { proceed: true } | { proceed: false; outcome: AutoPublishOutcome } {
  if (!existing) return { proceed: true };
  if (existing.status === "published") return { proceed: false, outcome: { status: "already_published" } };
  if (existing.status === "publishing") {
    return { proceed: false, outcome: { status: "held", reason: "a publication attempt is in flight or its provider outcome is uncertain (manual verification required)" } };
  }
  if (isRetrySafeFailure(existing)) return { proceed: true };
  return { proceed: false, outcome: { status: "held", reason: "a previous failed attempt predates retry-safe classification and can't be proven safe to retry" } };
}

/**
 * Publishes one email-authorized asset to its draft's exact channel through
 * the canonical publisher. Idempotent and race-safe; never throws for
 * expected conditions.
 */
export async function publishEmailAuthorizedAsset(deps: PublicationDeps, assetId: string): Promise<AutoPublishOutcome> {
  const { data: asset } = await deps.db.from("content_assets").select("*").eq("id", assetId).maybeSingle();
  if (!asset) return { status: "not_eligible", reason: "asset not found" };
  if (asset.status !== "ready_to_publish") return { status: "not_eligible", reason: `asset is "${asset.status}", not ready_to_publish` };
  if (!(await hasEmailPublicationAuthorization(deps.db, asset))) {
    return { status: "not_authorized", reason: "no applied email publication approval for this exact asset version" };
  }
  // The approval covers exactly this asset; if a newer one now exists the
  // approved piece is no longer the current one — hold rather than guess.
  const latest = await getLatestAsset(deps.db, asset.draft_id);
  if (!latest || latest.id !== asset.id) return { status: "not_eligible", reason: "a newer asset version exists for this draft" };

  const { data: draft } = await deps.db.from("content_drafts").select("*").eq("id", asset.draft_id).maybeSingle();
  if (!draft || draft.brand !== asset.brand) return { status: "not_eligible", reason: "asset's draft not found" };
  if (draft.status !== "approved") return { status: "not_eligible", reason: `draft is "${draft.status}", not approved` };
  if (draft.channel !== "facebook" && draft.channel !== "instagram") return { status: "not_eligible", reason: `unsupported channel "${draft.channel}"` };

  const gate = publicationGate(await getPublication(deps.db, asset.id, draft.channel));
  if (!gate.proceed) return gate.outcome;

  // Exact channel only — the canonical publisher re-checks draft.channel,
  // format, status, asset ownership, and the final caption itself.
  const outcome =
    draft.channel === "facebook"
      ? await publishAssetToFacebook({ db: deps.db, storage: deps.storage, facebookClient: deps.facebookClient, draftId: draft.id, assetId: asset.id })
      : await publishAssetToInstagram({ db: deps.db, storage: deps.storage, instagramClient: deps.instagramClient, draftId: draft.id, assetId: asset.id, delay: deps.delay });

  if (outcome.status === "success") return { status: "published", channel: draft.channel };
  if (outcome.status === "concurrent") return { status: "concurrent" };
  if (outcome.providerOutcomeUncertain) return { status: "failed_uncertain_held", message: outcome.message ?? "uncertain provider outcome" };
  if (outcome.status === "ineligible") {
    return outcome.publication?.status === "published" ? { status: "already_published" } : { status: "not_eligible", reason: outcome.message ?? "ineligible" };
  }
  return { status: "failed_retryable", message: outcome.message ?? "publication failed" };
}

const DEFAULT_PUBLICATION_SWEEP_LIMIT = 3;

/**
 * Cron recovery (normal wake): publishes email-authorized ready_to_publish
 * assets that still lack a successful publication on their draft's
 * channel. Driven ONLY by applied approve_asset email tokens, so dashboard-
 * approved/legacy assets never enter it. Bounded; held/published/in-flight
 * items are skipped without consuming the limit; one failure never stops
 * the others.
 */
export async function runPublicationRecoverySweep(
  deps: PublicationDeps,
  options: { limit?: number } = {}
): Promise<{ outcomes: AutoPublishOutcome["status"][] }> {
  const limit = options.limit ?? DEFAULT_PUBLICATION_SWEEP_LIMIT;
  const { data: tokens } = await deps.db
    .from("email_action_tokens")
    .select("subject_id, subject_version, consumed_at")
    .eq("action", "approve_asset")
    .eq("subject_type", "content_asset")
    .eq("outcome", "applied")
    .order("consumed_at", { ascending: true });

  const outcomes: AutoPublishOutcome["status"][] = [];
  const seen = new Set<string>();
  for (const token of tokens ?? []) {
    if (outcomes.length >= limit) break;
    if (!token.consumed_at || seen.has(token.subject_id)) continue;
    seen.add(token.subject_id);

    // Cheap pre-filter: only current, ready assets whose publication is
    // missing or retry-safe-failed may consume the per-run limit.
    const { data: asset } = await deps.db.from("content_assets").select("*").eq("id", token.subject_id).maybeSingle();
    if (!asset || asset.status !== "ready_to_publish" || asset.asset_version !== token.subject_version) continue;
    const { data: draft } = await deps.db.from("content_drafts").select("channel").eq("id", asset.draft_id).maybeSingle();
    if (!draft) continue;
    if (!publicationGate(await getPublication(deps.db, asset.id, draft.channel)).proceed) continue;

    try {
      outcomes.push((await publishEmailAuthorizedAsset(deps, asset.id)).status);
    } catch (err) {
      console.error("Automatic publication failed for one asset:", err instanceof Error ? err.message : "unknown error");
      outcomes.push("failed_retryable");
    }
  }
  return { outcomes };
}

/** Production dependencies. The canonical publishers themselves fail closed when a channel isn't configured. Never throws. */
export function createProductionPublicationDeps(): PublicationDeps | null {
  try {
    const db = supabaseAdmin();
    return { db, storage: new SupabaseAssetStorage(db), facebookClient: new MetaGraphFacebookClient(), instagramClient: new MetaGraphInstagramClient() };
  } catch {
    return null;
  }
}

/** For post-response use after an applied "Aprobar publicación": one attempt, never throws, logs a status only. */
export async function runAutoPublicationSafely(assetId: string, depsFactory: () => PublicationDeps | null = createProductionPublicationDeps): Promise<void> {
  try {
    const deps = depsFactory();
    if (!deps) {
      console.warn("Automatic publication skipped: dependencies unavailable.");
      return;
    }
    const outcome = await publishEmailAuthorizedAsset(deps, assetId);
    console.log(`Automatic publication: ${outcome.status}`);
  } catch (err) {
    console.error("Automatic publication crashed:", err instanceof Error ? err.message : "unknown error");
  }
}
