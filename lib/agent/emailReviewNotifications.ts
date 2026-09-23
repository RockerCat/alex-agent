import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, NotificationOutboxRow, NotificationType, NotificationSubjectType, ContentDraftRow } from "@/lib/types/database";
import type { AssetStorage } from "@/lib/agent/assetStorage";
import { EmailSendError, type EmailClient, type EmailInlineAttachment } from "@/lib/agent/emailClient";
import type { ReviewEmailAddressing } from "@/lib/agent/emailConfig";
import { BRAND_DISPLAY_NAMES, type SupportedBrand } from "@/lib/agent/constants";
import { isUniqueViolation } from "@/lib/agent/runLock";
import { getLatestAsset } from "@/lib/agent/assetGenerator";
import { buildEmailActionUrl, createEmailActionTokens } from "@/lib/agent/emailActions";
import { renderAssetReviewEmail, renderContentReviewEmail, loadAssetInlineImage, type RenderedEmail } from "@/lib/agent/emailTemplates";

// AlexAgent — Email HITL Phase 2B: preparing an ACTIONABLE review email.
//
// Explicit, caller-driven only: nothing in the marketing cycle, cron, or
// any workflow calls this yet. Order of operations is deliberate:
//   1. claim the durable notification_outbox identity (channel 'email',
//      keyed by brand + type + subject + version — the existing unique
//      constraint is the duplicate-review-email guard);
//   2. mint version-bound action tokens referencing that notification
//      (only hashes persisted);
//   3. render the email with action URLs built from the plaintext tokens.
// deliverPreparedReviewEmail() then sends it and records the result on
// the same outbox row. A 'sent' notification is never re-prepared; a
// 'pending'/'failed' one may be reclaimed (fresh tokens, fresh
// idempotency key) — same claim/reclaim shape as lib/agent/notifications.ts.

export type PrepareReviewOutcome<TEmail extends RenderedEmail = RenderedEmail> =
  | { status: "prepared"; notificationId: string; idempotencyKey: string; email: TEmail & { inlineAttachments?: EmailInlineAttachment[] } }
  | { status: "already_sent" }
  | { status: "concurrent" }
  | { status: "not_eligible"; message: string };

type ClaimResult = { ok: true; row: NotificationOutboxRow } | { ok: false; outcome: PrepareReviewOutcome };

async function claimEmailNotification(
  db: SupabaseClient<Database>,
  params: { brand: string; notificationType: NotificationType; subjectType: NotificationSubjectType; subjectId: string; subjectVersion: number; now: Date }
): Promise<ClaimResult> {
  const nowIso = params.now.toISOString();
  const { data: inserted, error } = await db
    .from("notification_outbox")
    .insert({
      brand: params.brand,
      channel: "email",
      notification_type: params.notificationType,
      subject_type: params.subjectType,
      subject_id: params.subjectId,
      subject_version: params.subjectVersion,
      status: "pending",
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select("*")
    .single();
  if (!error && inserted) return { ok: true, row: inserted };
  if (!isUniqueViolation(error)) {
    return { ok: false, outcome: { status: "not_eligible", message: error?.message ?? "Could not create the notification." } };
  }

  const { data: existing } = await db
    .from("notification_outbox")
    .select("*")
    .eq("brand", params.brand)
    .eq("channel", "email")
    .eq("notification_type", params.notificationType)
    .eq("subject_type", params.subjectType)
    .eq("subject_id", params.subjectId)
    .eq("subject_version", params.subjectVersion)
    .maybeSingle();
  if (!existing) return { ok: false, outcome: { status: "concurrent" } };
  if (existing.status === "sent") return { ok: false, outcome: { status: "already_sent" } };

  const { data: reclaimed } = await db
    .from("notification_outbox")
    .update({ status: "pending", error_message: null, updated_at: nowIso })
    .eq("id", existing.id)
    .neq("status", "sent")
    .select("*")
    .maybeSingle();
  if (!reclaimed) return { ok: false, outcome: { status: "concurrent" } };
  return { ok: true, row: reclaimed };
}

async function markNotificationFailed(db: SupabaseClient<Database>, id: string, message: string) {
  await db.from("notification_outbox").update({ status: "failed", error_message: message, updated_at: new Date().toISOString() }).eq("id", id);
}

/** Unique per claim, so a reclaimed notification (new tokens/content) is never deduplicated against an earlier attempt. */
function idempotencyKeyFor(row: NotificationOutboxRow): string {
  return `alexagent-review-${row.id}-${Date.parse(row.updated_at)}`;
}

function brandDisplayName(brand: string): string {
  return BRAND_DISPLAY_NAMES[brand as SupportedBrand] ?? brand;
}

async function loadPlanObjective(db: SupabaseClient<Database>, draft: ContentDraftRow): Promise<string | null> {
  const { data } = await db.from("marketing_plans").select("primary_objective").eq("id", draft.plan_id).maybeSingle();
  return data?.primary_objective ?? null;
}

/**
 * Prepares (does NOT send) a content-review email for a draft that is
 * pending approval at its current version, with Aprobar/Rechazar links
 * bound to exactly that version.
 */
export async function prepareContentReviewNotification(
  db: SupabaseClient<Database>,
  params: { draftId: string; baseUrl: string; now?: Date }
): Promise<PrepareReviewOutcome> {
  const now = params.now ?? new Date();
  const { data: draft } = await db.from("content_drafts").select("*").eq("id", params.draftId).maybeSingle();
  if (!draft) return { status: "not_eligible", message: "Draft not found." };
  if (draft.status !== "pending_approval") {
    return { status: "not_eligible", message: `Draft is in status "${draft.status}", not pending approval.` };
  }

  const claim = await claimEmailNotification(db, {
    brand: draft.brand,
    notificationType: "draft_pending_approval",
    subjectType: "content_draft",
    subjectId: draft.id,
    subjectVersion: draft.version,
    now,
  });
  if (!claim.ok) return claim.outcome;

  try {
    const tokens = await createEmailActionTokens(db, {
      notificationId: claim.row.id,
      brand: draft.brand,
      subjectType: "content_draft",
      subjectId: draft.id,
      subjectVersion: draft.version,
      actions: ["approve_draft", "reject_draft"],
      now,
    });
    const { data: latestRevision } = await db
      .from("content_revisions")
      .select("*")
      .eq("draft_id", draft.id)
      .eq("version", draft.version)
      .maybeSingle();

    const email = renderContentReviewEmail({
      brandDisplayName: brandDisplayName(draft.brand),
      draft,
      planObjective: await loadPlanObjective(db, draft),
      latestRevision: latestRevision ?? null,
      actions: {
        approveUrl: buildEmailActionUrl(params.baseUrl, tokens.approve_draft!),
        rejectUrl: buildEmailActionUrl(params.baseUrl, tokens.reject_draft!),
      },
    });
    return { status: "prepared", notificationId: claim.row.id, idempotencyKey: idempotencyKeyFor(claim.row), email };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    await markNotificationFailed(db, claim.row.id, `Preparation failed: ${message}`);
    return { status: "not_eligible", message: `Preparation failed: ${message}` };
  }
}

/**
 * Prepares (does NOT send) an asset-review email for the latest asset of
 * a draft while it is pending review, with an "Aprobar imagen" link bound
 * to exactly that asset version and the image embedded inline (CID).
 */
export async function prepareAssetReviewNotification(
  db: SupabaseClient<Database>,
  storage: AssetStorage,
  params: { assetId: string; baseUrl: string; now?: Date }
): Promise<PrepareReviewOutcome> {
  const now = params.now ?? new Date();
  const { data: asset } = await db.from("content_assets").select("*").eq("id", params.assetId).maybeSingle();
  if (!asset) return { status: "not_eligible", message: "Asset not found." };
  if (asset.status !== "pending_review") {
    return { status: "not_eligible", message: `Asset is in status "${asset.status}", not pending review.` };
  }
  const latest = await getLatestAsset(db, asset.draft_id);
  if (!latest || latest.id !== asset.id) {
    return { status: "not_eligible", message: "Asset has been superseded by a newer version." };
  }
  const { data: draft } = await db.from("content_drafts").select("*").eq("id", asset.draft_id).maybeSingle();
  if (!draft || draft.brand !== asset.brand) return { status: "not_eligible", message: "Asset's draft not found." };

  const claim = await claimEmailNotification(db, {
    brand: asset.brand,
    notificationType: "asset_pending_review",
    subjectType: "content_asset",
    subjectId: asset.id,
    subjectVersion: asset.asset_version,
    now,
  });
  if (!claim.ok) return claim.outcome;

  try {
    const tokens = await createEmailActionTokens(db, {
      notificationId: claim.row.id,
      brand: asset.brand,
      subjectType: "content_asset",
      subjectId: asset.id,
      subjectVersion: asset.asset_version,
      actions: ["approve_asset"],
      now,
    });
    const email = renderAssetReviewEmail({
      brandDisplayName: brandDisplayName(asset.brand),
      draft,
      asset,
      planObjective: await loadPlanObjective(db, draft),
      image: await loadAssetInlineImage(storage, asset),
      approveAssetUrl: buildEmailActionUrl(params.baseUrl, tokens.approve_asset!),
    });
    return { status: "prepared", notificationId: claim.row.id, idempotencyKey: idempotencyKeyFor(claim.row), email };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    await markNotificationFailed(db, claim.row.id, `Preparation failed: ${message}`);
    return { status: "not_eligible", message: `Preparation failed: ${message}` };
  }
}

export type DeliverReviewOutcome = { status: "sent"; providerMessageId: string } | { status: "failed"; message: string };

/**
 * Sends a prepared review email and records the result on its outbox row.
 * Never throws. A send failure only marks the notification 'failed'
 * (reclaimable); it never touches drafts, assets, or tokens.
 */
export async function deliverPreparedReviewEmail(
  db: SupabaseClient<Database>,
  emailClient: EmailClient,
  prepared: Extract<PrepareReviewOutcome, { status: "prepared" }>,
  addressing: ReviewEmailAddressing
): Promise<DeliverReviewOutcome> {
  try {
    const result = await emailClient.sendEmail({
      from: addressing.from,
      to: addressing.to,
      subject: prepared.email.subject,
      html: prepared.email.html,
      text: prepared.email.text,
      inlineAttachments: prepared.email.inlineAttachments,
      idempotencyKey: prepared.idempotencyKey,
    });
    const nowIso = new Date().toISOString();
    await db
      .from("notification_outbox")
      .update({
        status: "sent",
        provider_message_id: result.providerMessageId,
        rfc_message_id: result.rfcMessageId,
        sent_at: nowIso,
        error_message: null,
        updated_at: nowIso,
      })
      .eq("id", prepared.notificationId);
    return { status: "sent", providerMessageId: result.providerMessageId };
  } catch (err) {
    const message = err instanceof EmailSendError ? err.message : "Unexpected error sending review email.";
    await markNotificationFailed(db, prepared.notificationId, message);
    return { status: "failed", message };
  }
}
