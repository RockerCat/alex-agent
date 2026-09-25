import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentAssetRow } from "@/lib/types/database";
import type { AssetStorage } from "@/lib/agent/assetStorage";
import { SupabaseAssetStorage } from "@/lib/agent/assetStorage";
import type { AiClient } from "@/lib/agent/aiClient";
import { OpenAiClient } from "@/lib/agent/aiClient";
import type { ImageGenerationClient } from "@/lib/agent/imageGenerationClient";
import { OpenAiImageGenerationClient } from "@/lib/agent/imageGenerationClient";
import type { EmailClient } from "@/lib/agent/emailClient";
import { ResendEmailClient } from "@/lib/agent/resendEmailClient";
import { emailOutboundCapabilityAvailable, resolveReviewEmailAddressing, type ReviewEmailAddressing } from "@/lib/agent/emailConfig";
import { generateAsset, getLatestAsset } from "@/lib/agent/assetGenerator";
import { prepareAssetReviewNotification, deliverPreparedReviewEmail } from "@/lib/agent/emailReviewNotifications";
import { SUPPORTED_BRANDS } from "@/lib/agent/constants";
import { checkFinalSocialCaption } from "@/lib/agent/finalCaption";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { env } from "@/lib/env";

// AlexAgent — email lifecycle continuation: approved single-channel
// image_post → first asset (canonical generateAsset) → finished-
// publication review email. DELIBERATE product change: an email content
// approval now continues automatically into asset generation. The
// approval itself (approveDraft) is unchanged and never generates
// anything; this adapter runs only after it has already been applied.
//
// One canonical helper, two callers:
//   - app/api/email-actions/confirm/route.ts, post-response (after()),
//     right after an approve_draft email action is applied;
//   - app/api/cron/marketing-cycle/route.ts, as an idempotent catch-up
//     sweep (recovery only) for drafts that entered the email lifecycle.
//
// Safety properties (durable state, not in-memory flags, makes retries safe):
//   - Never regenerates: generateAsset({ firstGenerationOnly: true }) is
//     only called when the draft has NO asset, and generateAsset itself
//     re-checks under the brand lock, so a retry/race can never pay for a
//     second image. A recorded generation_failed attempt is NOT retried
//     automatically (a repeat could pay again for the same failure).
//   - Never sends a duplicate review email: prepareAssetReviewNotification
//     claims the (email, asset_pending_review, asset, asset_version)
//     outbox identity; a 'sent' notification is never re-prepared, a
//     'failed' one is reclaimed WITHOUT regenerating the image.
//   - Never publishes: this module does not import the social publishers.
//     Approving the finished-publication email ends at ready_to_publish.
//   - A failure here never touches the already-approved draft.

export interface ContinuationDeps {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  aiClient: AiClient;
  imageGenerationClient?: ImageGenerationClient;
  emailClient: EmailClient;
  addressing: ReviewEmailAddressing;
  baseUrl: string;
}

export type ContinuationOutcome =
  | { status: "not_eligible"; reason: string }
  /** The exact final caption can't be published on draft.channel: nothing generated, nothing sent, nothing durable changed. */
  | { status: "final_caption_invalid"; reason: string }
  | { status: "generation_in_progress" }
  | { status: "generation_failed"; message: string; budgetBlocked?: boolean }
  | { status: "asset_not_reviewable"; reason: string }
  | { status: "review_already_sent" }
  | { status: "review_not_prepared"; message: string }
  | { status: "review_sent"; generated: boolean; providerMessageId: string }
  | { status: "review_delivery_failed"; generated: boolean; message: string };

/** Pure eligibility for automatic continuation — the same preconditions generateAsset enforces, checked up front. */
export function continuationIneligibilityReason(draft: {
  status: string;
  content_type: string;
  brand: string;
  hook: string | null;
  cta_text: string | null;
}): string | null {
  if (draft.status !== "approved") return `draft is "${draft.status}", not approved`;
  if (draft.content_type !== "image_post") return `content type "${draft.content_type}" is not supported (image_post only)`;
  if (!(SUPPORTED_BRANDS as readonly string[]).includes(draft.brand)) return `brand "${draft.brand}" is not supported`;
  if (!draft.hook || !draft.cta_text) return "draft lacks the hook/CTA text needed to render an asset";
  return null;
}

async function ensureFirstAsset(
  deps: ContinuationDeps,
  draftId: string
): Promise<{ asset: ContentAssetRow; generated: boolean } | { outcome: ContinuationOutcome }> {
  const existing = await getLatestAsset(deps.db, draftId);
  if (existing) return { asset: existing, generated: false };

  const result = await generateAsset({
    db: deps.db,
    storage: deps.storage,
    draftId,
    aiClient: deps.aiClient,
    imageGenerationClient: deps.imageGenerationClient,
    firstGenerationOnly: true,
  });
  if (result.status === "success" && result.asset) return { asset: result.asset, generated: true };

  if (result.status === "concurrent" || result.assetAlreadyExists) {
    // Another attempt holds the brand lock or already created the asset —
    // use its asset if it exists yet; otherwise a later sweep continues.
    const now = await getLatestAsset(deps.db, draftId);
    return now ? { asset: now, generated: false } : { outcome: { status: "generation_in_progress" } };
  }
  return { outcome: { status: "generation_failed", message: result.message ?? "Asset generation failed.", budgetBlocked: result.budgetBlocked } };
}

/**
 * Continues one approved image_post draft to its finished-publication
 * review email. Idempotent: safe to call any number of times for the same
 * draft (after(), cron sweep, retries, concurrent calls).
 */
export async function continueApprovedImagePost(deps: ContinuationDeps, draftId: string): Promise<ContinuationOutcome> {
  const { data: draft } = await deps.db.from("content_drafts").select("*").eq("id", draftId).maybeSingle();
  if (!draft) return { status: "not_eligible", reason: "draft not found" };
  const ineligible = continuationIneligibilityReason(draft);
  if (ineligible) return { status: "not_eligible", reason: ineligible };

  // Checked BEFORE generation: never pay for an image whose finished
  // publication could not be reviewed as publishable on its channel. The
  // approved draft is frozen, so this is deterministic — retries (cron)
  // repeat only this pure check, never paid work.
  const captionCheck = checkFinalSocialCaption(draft, draft.channel);
  if (!captionCheck.ok) return { status: "final_caption_invalid", reason: captionCheck.reason };

  const ensured = await ensureFirstAsset(deps, draft.id);
  if ("outcome" in ensured) return ensured.outcome;
  const { asset, generated } = ensured;

  if (asset.status === "generation_failed") {
    return { status: "asset_not_reviewable", reason: "the latest generation attempt failed; not retried automatically" };
  }
  if (asset.source_draft_version !== draft.version) {
    return { status: "asset_not_reviewable", reason: `asset was generated from content v${asset.source_draft_version}, draft is v${draft.version}` };
  }
  if (asset.status === "ready_to_publish") {
    return { status: "asset_not_reviewable", reason: "asset is already approved (ready to publish)" };
  }

  // asset.status === "pending_review": make sure exactly one review email exists for it.
  const prepared = await prepareAssetReviewNotification(deps.db, deps.storage, { assetId: asset.id, baseUrl: deps.baseUrl });
  if (prepared.status === "already_sent") return { status: "review_already_sent" };
  if (prepared.status === "not_eligible" && prepared.finalCaptionInvalid) return { status: "final_caption_invalid", reason: prepared.message };
  if (prepared.status !== "prepared") {
    return { status: "review_not_prepared", message: prepared.status === "not_eligible" ? prepared.message : "a concurrent attempt is preparing this review" };
  }
  const delivered = await deliverPreparedReviewEmail(deps.db, deps.emailClient, prepared, deps.addressing);
  return delivered.status === "sent"
    ? { status: "review_sent", generated, providerMessageId: delivered.providerMessageId }
    : { status: "review_delivery_failed", generated, message: delivered.message };
}

const DEFAULT_SWEEP_LIMIT = 3;

/** True when the draft's CURRENT version had its content review sent by email — i.e. it entered the email lifecycle. Dashboard-only drafts never did. */
async function enteredEmailLifecycle(db: ContinuationDeps["db"], draft: { id: string; version: number }): Promise<boolean> {
  const { data: enrolled } = await db
    .from("notification_outbox")
    .select("id")
    .eq("channel", "email")
    .eq("notification_type", "draft_pending_approval")
    .eq("subject_type", "content_draft")
    .eq("subject_id", draft.id)
    .eq("subject_version", draft.version)
    .eq("status", "sent")
    .maybeSingle();
  return !!enrolled;
}

/**
 * Cron catch-up (recovery only): continues approved image_post drafts
 * that ENTERED THE EMAIL LIFECYCLE — i.e. have a sent email content-review
 * notification for their current version — and still lack their first
 * asset or their finished-publication review email. Drafts reviewed only
 * in the dashboard, carousels, drafts whose asset is already approved,
 * and drafts whose latest generation failed are never touched. Bounded
 * per invocation; Budget Guard still applies inside generateAsset.
 */
export async function runPostApprovalContinuationSweep(
  deps: ContinuationDeps,
  options: { limit?: number } = {}
): Promise<{ considered: number; outcomes: ContinuationOutcome["status"][] }> {
  const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;
  const { data: drafts } = await deps.db
    .from("content_drafts")
    .select("*")
    .eq("status", "approved")
    .eq("content_type", "image_post")
    .in("brand", [...SUPPORTED_BRANDS])
    .order("approved_at", { ascending: true });

  const outcomes: ContinuationOutcome["status"][] = [];
  let considered = 0;
  for (const draft of drafts ?? []) {
    if (outcomes.length >= limit) break;
    considered += 1;
    if (continuationIneligibilityReason(draft)) continue;
    // An unpublishable final caption can't become valid on its own (the
    // approved draft is frozen) — skip it without using the per-run limit,
    // so it never starves other drafts and never triggers repeated work.
    if (!checkFinalSocialCaption(draft, draft.channel).ok) continue;

    if (!(await enteredEmailLifecycle(deps.db, draft))) continue;

    // Cheap pre-filter so finished drafts never consume the per-run limit.
    const latest = await getLatestAsset(deps.db, draft.id);
    if (latest && latest.status !== "pending_review") continue;
    if (latest) {
      const { data: reviewSent } = await deps.db
        .from("notification_outbox")
        .select("id")
        .eq("channel", "email")
        .eq("notification_type", "asset_pending_review")
        .eq("subject_type", "content_asset")
        .eq("subject_id", latest.id)
        .eq("subject_version", latest.asset_version)
        .eq("status", "sent")
        .maybeSingle();
      if (reviewSent) continue;
    }

    try {
      outcomes.push((await continueApprovedImagePost(deps, draft.id)).status);
    } catch (err) {
      // One draft's failure must never stop the sweep or touch its state.
      console.error("Post-approval continuation failed for one draft:", err instanceof Error ? err.message : "unknown error");
      outcomes.push("generation_failed");
    }
  }
  return { considered, outcomes };
}

/**
 * Production dependencies, or null when outbound email or the app origin
 * isn't configured (continuation then does nothing — not a failure).
 * Never throws.
 */
export function createProductionContinuationDeps(): ContinuationDeps | null {
  try {
    const baseUrl = env.appBaseUrl();
    if (!baseUrl || !emailOutboundCapabilityAvailable()) return null;
    const db = supabaseAdmin();
    return {
      db,
      storage: new SupabaseAssetStorage(db),
      aiClient: new OpenAiClient(),
      imageGenerationClient: new OpenAiImageGenerationClient(),
      emailClient: new ResendEmailClient(),
      addressing: resolveReviewEmailAddressing(),
      baseUrl,
    };
  } catch {
    return null;
  }
}

/** For post-response use: runs one continuation and never throws (logs a status only — no ids, tokens, or addresses). */
export async function runContinuationSafely(draftId: string, depsFactory: () => ContinuationDeps | null = createProductionContinuationDeps): Promise<void> {
  try {
    const deps = depsFactory();
    if (!deps) {
      console.warn("Post-approval continuation skipped: outbound email or app origin is not configured.");
      return;
    }
    const outcome = await continueApprovedImagePost(deps, draftId);
    // Status plus, for a blocked finished publication, its sanitized reason (lengths only — no caption text, ids, or addresses).
    console.log(`Post-approval continuation: ${outcome.status}${outcome.status === "final_caption_invalid" ? ` — ${outcome.reason}` : ""}`);
  } catch (err) {
    console.error("Post-approval continuation crashed:", err instanceof Error ? err.message : "unknown error");
  }
}

/**
 * For post-response use after a dashboard Generate/Regenerate succeeded
 * (app/actions.ts generateAssetAction): sends the new asset version's
 * finished-publication review email right away instead of waiting for
 * the next cron sweep. Same scope as the sweep —
 * only drafts that entered the email lifecycle; a dashboard-only draft is
 * never switched to email review by regenerating. Delegates to the
 * canonical continueApprovedImagePost, so it never generates anything
 * (the regenerated asset already exists), sends at most one email per
 * asset version, and a delivery failure leaves the new asset intact for
 * the sweep to retry. Never throws.
 */
export async function runRegeneratedAssetReviewSafely(
  draftId: string,
  depsFactory: () => ContinuationDeps | null = createProductionContinuationDeps
): Promise<void> {
  try {
    const deps = depsFactory();
    if (!deps) {
      console.warn("Regenerated-asset review email skipped: outbound email or app origin is not configured.");
      return;
    }
    const { data: draft } = await deps.db.from("content_drafts").select("id, version").eq("id", draftId).maybeSingle();
    if (!draft || !(await enteredEmailLifecycle(deps.db, draft))) {
      console.log("Regenerated-asset review email: not_eligible — draft is not in the email review lifecycle");
      return;
    }
    const outcome = await continueApprovedImagePost(deps, draftId);
    console.log(`Regenerated-asset review email: ${outcome.status}${outcome.status === "final_caption_invalid" ? ` — ${outcome.reason}` : ""}`);
  } catch (err) {
    console.error("Regenerated-asset review email crashed:", err instanceof Error ? err.message : "unknown error");
  }
}
