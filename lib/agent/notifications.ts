import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentDraftRow, AgentQuestionRow, NotificationOutboxRow, NotificationType, NotificationSubjectType } from "@/lib/types/database";
import type { SupportedBrand } from "@/lib/agent/constants";
import { BRAND_DISPLAY_NAMES } from "@/lib/agent/constants";
import { env } from "@/lib/env";
import { isUniqueViolation } from "@/lib/agent/runLock";
import { WhatsAppSendError, whatsappNotificationsCapabilityAvailable, type WhatsAppGraphClient } from "@/lib/agent/whatsappClient";

// AlexAgent — WhatsApp outbound attention notifications (Autonomy v1,
// outbound only; no inbound/webhook handling here). This is the
// notification-service layer invoked from
// app/api/cron/marketing-cycle/route.ts strictly AFTER
// runMarketingCycle() has already returned and durably finalized its
// run — never from inside the runtime itself, and never causing
// another Planner call or draft creation. WhatsApp is an adapter over
// the existing durable content_drafts/agent_questions workflow, not a
// second approval system: this module only reads that state and sends
// a message describing it; it never mutates draft/question status.
//
// Idempotency / no-daily-spam: before ever calling the Meta Graph API,
// this claims a row in notification_outbox keyed by (brand, channel,
// notification_type, subject_type, subject_id, subject_version) — the
// unique constraint added in
// supabase/migrations/0009_notification_outbox.sql is the actual
// duplicate-notification guard (mirrors lib/agent/publish.ts's
// claimPublicationSlot), not just an in-memory check. A new wake
// observing the same still-pending draft/question is a no-op; a real
// draft revision (content_drafts.version increments) is a new logical
// identity and may notify again.
//
// Failure isolation: a WhatsApp send failure only ever marks its own
// notification_outbox row 'failed' — it never touches content_drafts,
// agent_questions, or agent_runs, and the caller (the cron route) is
// expected to catch/report this independently of the marketing-cycle
// response. Meta's own delivery is best-effort: a network failure can
// occur after Meta has already accepted the message but before the
// response reaches us, in which case this will (safely) record
// 'failed' and retry on the next wake, at the cost of a possible
// duplicate real WhatsApp message in that specific race — an
// exactly-once guarantee is not something the provider offers, and
// this deliberately does not pretend otherwise.

const MAX_ATTENTION_CONTENT_LENGTH = 200;
const QUESTION_SUBJECT_VERSION = 1;

export interface NotificationAttemptOutcome {
  status: "sent" | "already_sent" | "failed" | "concurrent";
  message?: string;
}

export interface AttentionNotificationSummary {
  attempted: number;
  sent: number;
  alreadySent: number;
  failed: number;
  /** True when WhatsApp isn't configured at all — nothing was attempted, this is not itself a failure. */
  skippedNotConfigured: boolean;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function buildApprovalUrl(draftId: string): string | null {
  const base = env.appBaseUrl();
  return base ? `${base}/approvals/${draftId}` : null;
}

/**
 * Deterministic, no LLM call. Uses only already-existing, already
 * human-reviewable draft fields (title/hook) — never invents content,
 * never summarizes with a model.
 */
function buildDraftAttentionContent(draft: ContentDraftRow): string {
  const preview = [draft.title, draft.hook].filter((v): v is string => Boolean(v && v.trim())).join(" — ") || draft.topic;
  const truncated = truncate(preview, MAX_ATTENTION_CONTENT_LENGTH);
  const approvalUrl = buildApprovalUrl(draft.id);
  return approvalUrl ? `${truncated}\n${approvalUrl}` : truncated;
}

function buildQuestionAttentionContent(question: AgentQuestionRow): string {
  return truncate(question.question, MAX_ATTENTION_CONTENT_LENGTH);
}

type ClaimResult = { ok: true; row: NotificationOutboxRow } | { ok: false; outcome: NotificationAttemptOutcome };

/**
 * Atomically claims the (brand, channel, notification_type,
 * subject_type, subject_id, subject_version) notification slot — same
 * claim/reclaim shape as lib/agent/publish.ts's claimPublicationSlot.
 * A 'sent' row blocks outright (already notified for this exact
 * subject+version); a 'pending' or 'failed' row is reclaimed for retry.
 */
async function claimNotificationSlot(
  db: SupabaseClient<Database>,
  params: {
    brand: string;
    notificationType: NotificationType;
    subjectType: NotificationSubjectType;
    subjectId: string;
    subjectVersion: number;
    runId: string;
  }
): Promise<ClaimResult> {
  const { data: inserted, error: insertError } = await db
    .from("notification_outbox")
    .insert({
      brand: params.brand,
      channel: "whatsapp",
      notification_type: params.notificationType,
      subject_type: params.subjectType,
      subject_id: params.subjectId,
      subject_version: params.subjectVersion,
      status: "pending",
      agent_run_id: params.runId,
    })
    .select("*")
    .single();

  if (!insertError && inserted) {
    return { ok: true, row: inserted };
  }

  if (!isUniqueViolation(insertError)) {
    return { ok: false, outcome: { status: "failed", message: insertError?.message ?? "Could not start the notification attempt." } };
  }

  const { data: existing } = await db
    .from("notification_outbox")
    .select("*")
    .eq("brand", params.brand)
    .eq("channel", "whatsapp")
    .eq("notification_type", params.notificationType)
    .eq("subject_type", params.subjectType)
    .eq("subject_id", params.subjectId)
    .eq("subject_version", params.subjectVersion)
    .maybeSingle();

  if (!existing) {
    return { ok: false, outcome: { status: "concurrent", message: "Could not verify this notification's state." } };
  }

  if (existing.status === "sent") {
    return { ok: false, outcome: { status: "already_sent", message: `Already notified (message ${existing.provider_message_id}).` } };
  }

  // existing.status is 'pending' or 'failed': no confirmed delivery yet
  // — safe to reclaim. Guarded update so only one racing attempt wins.
  const { data: reclaimed, error: reclaimError } = await db
    .from("notification_outbox")
    .update({ status: "pending", error_message: null, agent_run_id: params.runId, updated_at: new Date().toISOString() })
    .eq("id", existing.id)
    .neq("status", "sent")
    .select("*")
    .single();

  if (reclaimError || !reclaimed) {
    return { ok: false, outcome: { status: "concurrent", message: "Another notification attempt for this item just started." } };
  }

  return { ok: true, row: reclaimed };
}

async function markNotificationSent(db: SupabaseClient<Database>, id: string, providerMessageId: string) {
  await db
    .from("notification_outbox")
    .update({ status: "sent", provider_message_id: providerMessageId, sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id);
}

async function markNotificationFailed(db: SupabaseClient<Database>, id: string, message: string) {
  // `message` must already be sanitized by the caller — this never
  // receives a raw Authorization header or token (see
  // whatsappClient.ts: WhatsAppSendError messages never interpolate
  // the access token).
  await db.from("notification_outbox").update({ status: "failed", error_message: message, updated_at: new Date().toISOString() }).eq("id", id);
}

async function attemptSend(
  db: SupabaseClient<Database>,
  whatsappClient: WhatsAppGraphClient,
  claim: ClaimResult,
  bodyParameters: string[]
): Promise<NotificationAttemptOutcome> {
  if (!claim.ok) return claim.outcome;

  const destination = env.metaWhatsappDestinationNumber();
  if (!destination) {
    // Capability check already gates the caller, but guards here too
    // rather than trusting call order.
    await markNotificationFailed(db, claim.row.id, "Meta WhatsApp destination number is not configured.");
    return { status: "failed", message: "Meta WhatsApp destination number is not configured." };
  }

  try {
    const result = await whatsappClient.sendTemplateMessage({
      to: destination,
      templateName: env.metaWhatsappTemplateName(),
      languageCode: env.metaWhatsappTemplateLanguage(),
      bodyParameters,
    });
    await markNotificationSent(db, claim.row.id, result.messageId);
    return { status: "sent" };
  } catch (err) {
    const message =
      err instanceof WhatsAppSendError ? err.message : `Unexpected error sending WhatsApp notification: ${err instanceof Error ? err.message : "unknown error"}`;
    await markNotificationFailed(db, claim.row.id, message);
    return { status: "failed", message };
  }
}

async function notifyDraftPendingApproval(
  db: SupabaseClient<Database>,
  whatsappClient: WhatsAppGraphClient,
  brand: SupportedBrand,
  runId: string,
  draft: ContentDraftRow
): Promise<NotificationAttemptOutcome> {
  const claim = await claimNotificationSlot(db, {
    brand,
    notificationType: "draft_pending_approval",
    subjectType: "content_draft",
    subjectId: draft.id,
    subjectVersion: draft.version,
    runId,
  });
  return attemptSend(db, whatsappClient, claim, [
    BRAND_DISPLAY_NAMES[brand],
    "un contenido pendiente de aprobación",
    buildDraftAttentionContent(draft),
  ]);
}

async function notifyBlockingQuestion(
  db: SupabaseClient<Database>,
  whatsappClient: WhatsAppGraphClient,
  brand: SupportedBrand,
  runId: string,
  question: AgentQuestionRow
): Promise<NotificationAttemptOutcome> {
  const claim = await claimNotificationSlot(db, {
    brand,
    notificationType: "blocking_question",
    subjectType: "agent_question",
    subjectId: question.id,
    subjectVersion: QUESTION_SUBJECT_VERSION,
    runId,
  });
  return attemptSend(db, whatsappClient, claim, [
    BRAND_DISPLAY_NAMES[brand],
    "una pregunta pendiente de tu respuesta",
    buildQuestionAttentionContent(question),
  ]);
}

function tally(summary: AttentionNotificationSummary, outcome: NotificationAttemptOutcome) {
  summary.attempted += 1;
  if (outcome.status === "sent") summary.sent += 1;
  else if (outcome.status === "already_sent") summary.alreadySent += 1;
  else summary.failed += 1;
}

/**
 * Inspects durable post-run state and sends at most one WhatsApp
 * notification per unresolved attention item (never more than once for
 * the same subject+version — see claimNotificationSlot). Intended to be
 * called only after runMarketingCycle() has already returned; never
 * invokes Planner, never creates/mutates a draft or question, never
 * throws — any provider/config failure is captured per-item in
 * notification_outbox and reflected only in the returned summary.
 */
export async function notifyAttentionIfNeeded(params: {
  db: SupabaseClient<Database>;
  whatsappClient: WhatsAppGraphClient;
  brand: SupportedBrand;
  runId: string;
  runDecision: string | null;
}): Promise<AttentionNotificationSummary> {
  const { db, whatsappClient, brand, runId, runDecision } = params;
  const summary: AttentionNotificationSummary = { attempted: 0, sent: 0, alreadySent: 0, failed: 0, skippedNotConfigured: false };

  if (!whatsappNotificationsCapabilityAvailable()) {
    summary.skippedNotConfigured = true;
    return summary;
  }

  // Preflight (lib/agent/preflight.ts) only ever reaches WAIT_FOR_APPROVAL
  // when a pending_approval draft already exists for this brand, and only
  // ever reaches NEEDS_HUMAN_INPUT when a blocking open question exists
  // (freshly Planner-raised or an older still-open one) — so gating on
  // the run's own decision here is exactly equivalent to "does durable
  // state require attention," without re-deriving that logic.
  if (runDecision === "WAIT_FOR_APPROVAL") {
    const { data: drafts } = await db
      .from("content_drafts")
      .select("*")
      .eq("brand", brand)
      .eq("status", "pending_approval")
      .order("created_at", { ascending: true });
    for (const draft of drafts ?? []) {
      tally(summary, await notifyDraftPendingApproval(db, whatsappClient, brand, runId, draft));
    }
  } else if (runDecision === "NEEDS_HUMAN_INPUT") {
    const { data: questions } = await db
      .from("agent_questions")
      .select("*")
      .eq("brand", brand)
      .eq("status", "open")
      .eq("blocks_progress", true)
      .order("created_at", { ascending: true });
    for (const question of questions ?? []) {
      tally(summary, await notifyBlockingQuestion(db, whatsappClient, brand, runId, question));
    }
  }

  return summary;
}
