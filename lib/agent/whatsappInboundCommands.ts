import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import type { WhatsAppGraphClient } from "@/lib/agent/whatsappClient";
import type { InboundMessageEvent } from "@/lib/agent/whatsappWebhook";
import { resolveDraftForInboundCommand } from "@/lib/agent/whatsappWebhook";
import { approveDraft, rejectDraft } from "@/lib/agent/approvals";
import { isUniqueViolation } from "@/lib/agent/runLock";
import { env } from "@/lib/env";

// AlexAgent — WhatsApp Inbound Phase 1: "aprobar"/"rechazar" from
// WhatsApp, acting on the SAME existing durable content_drafts workflow.
//
// This module is the only caller of approveDraft/rejectDraft
// (lib/agent/approvals.ts) from a WhatsApp context — their state guards
// and SQL mutation are never reproduced here. It is also the only place
// that sends a WhatsApp confirmation reply. It never invokes
// runMarketingCycle, Planner, Executor, Visual Director, asset
// generation, or publishing, and never creates an agent_run — approving
// or rejecting a draft from WhatsApp is the exact same domain operation
// the web dashboard already performs, not a parallel workflow.
//
// Processing order for every recognized text message, in this exact
// sequence (see handleInboundMessage): (1) claim inbound idempotency by
// the message's own Meta id — BEFORE any mutation or reply, so a
// webhook retry can never double-process or double-reply; (2) verify
// the sender against the single configured destination number,
// fail-closed; (3) parse the exact command; (4) resolve which draft it
// refers to, fail-safe (see whatsappWebhook.ts's
// resolveDraftForInboundCommand); (5) call the existing authoritative
// approveDraft/rejectDraft; (6) send one confirmation reply describing
// the outcome, never leaking internal ids/DB details.

const APPROVE_COMMAND = "aprobar";
const REJECT_COMMAND = "rechazar";

export type InboundCommand = typeof APPROVE_COMMAND | typeof REJECT_COMMAND;

/**
 * Trim + lowercase + generic diacritic stripping, then EXACT match only
 * against the two Phase 1 commands — no aliases ("sí"/"si"/"no"/"ok"/
 * English variants/fuzzy text are all deliberately unrecognized), no
 * LLM. Diacritic stripping guards against an incidental stray accent
 * (e.g. a mobile keyboard's autocorrect) without adding any new accepted
 * word — "aprobar"/"rechazar" have no accents of their own.
 */
export function parseInboundCommand(rawText: string): InboundCommand | null {
  const normalized = rawText
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

  if (normalized === APPROVE_COMMAND) return APPROVE_COMMAND;
  if (normalized === REJECT_COMMAND) return REJECT_COMMAND;
  return null;
}

function normalizePhoneForComparison(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Deterministic, config-driven only — the single owner's destination
 * number is the only authorized sender in this single-owner model.
 * Digit-only comparison because Meta's `from` typically omits the
 * leading "+" that the configured E.164 value has; this is a safe,
 * non-fuzzy normalization of the identifiers Meta itself provides, not
 * a loosened match. Fails closed on any missing value.
 */
export function isAuthorizedSender(from: string | null, configuredDestination: string | null): boolean {
  if (!from || !configuredDestination) return false;
  return normalizePhoneForComparison(from) === normalizePhoneForComparison(configuredDestination);
}

type ClaimResult = { claimed: true; id: string } | { claimed: false };

/**
 * Insert-first claim on the inbound message's own Meta id — the unique
 * constraint in 0011_whatsapp_inbound_events.sql is the real duplicate-
 * processing guard, not this check alone (same pattern as
 * lib/agent/notifications.ts's claimNotificationSlot). Unlike that
 * function, a claim here is never reclaimed/retried on a later wake —
 * an inbound message id is processed at most once, period; any insert
 * failure (unique violation or otherwise) means this attempt does
 * nothing further, fail-safe against ever double-mutating a draft.
 */
async function claimInboundEvent(db: SupabaseClient<Database>, providerMessageId: string): Promise<ClaimResult> {
  const { data, error } = await db
    .from("whatsapp_inbound_events")
    .insert({ provider_message_id: providerMessageId })
    .select("id")
    .single();

  if (!error && data) return { claimed: true, id: data.id };

  if (!isUniqueViolation(error)) {
    // A genuine, unexpected DB failure (not a normal duplicate-delivery
    // race) — worth knowing about operationally, but still fail-safe:
    // this attempt does nothing further rather than risk processing
    // without a durable claim.
    console.error("WhatsApp inbound event claim failed unexpectedly:", error?.message ?? "unknown error");
  }
  return { claimed: false };
}

async function finalizeInboundEvent(
  db: SupabaseClient<Database>,
  id: string,
  fields: { command?: InboundCommand; resolved_draft_id?: string; outcome: Database["public"]["Tables"]["whatsapp_inbound_events"]["Row"]["outcome"] }
) {
  await db
    .from("whatsapp_inbound_events")
    .update({ command: fields.command ?? null, resolved_draft_id: fields.resolved_draft_id ?? null, outcome: fields.outcome })
    .eq("id", id);
}

const CONFIRMATION_COPY = {
  approved: "AlexAgent: borrador aprobado.",
  rejected: "AlexAgent: borrador rechazado.",
  state_guard_failed: "AlexAgent: ese borrador ya no está pendiente de aprobación.",
  unsupported_command: 'AlexAgent: comando no reconocido. Responde "Aprobar" o "Rechazar".',
  no_candidate_or_ambiguous: "AlexAgent: no se pudo identificar un único borrador pendiente. Responde directamente a la notificación del borrador que quieres decidir.",
  unresolved_context: "AlexAgent: no se pudo identificar el borrador de esa notificación.",
} as const;

async function sendConfirmation(whatsappClient: WhatsAppGraphClient, to: string, body: string): Promise<void> {
  try {
    await whatsappClient.sendTextMessage({ to, body });
  } catch (err) {
    // A confirmation-send failure must never roll back or affect the
    // already-committed authoritative draft mutation / event row above
    // — same failure-isolation posture as
    // lib/agent/notifications.ts's attemptSend. Logged only.
    console.error("WhatsApp inbound confirmation send failed:", err instanceof Error ? err.message : "unknown error");
  }
}

export interface HandleInboundMessageResult {
  /** True only when the message reached command processing (was claimed); false for ignored/duplicate messages. */
  processed: boolean;
  outcome: Database["public"]["Tables"]["whatsapp_inbound_events"]["Row"]["outcome"] | "ignored_non_text" | "duplicate" | "unauthorized_sender";
}

/**
 * Entry point for a single inbound message event (see
 * lib/agent/whatsappWebhook.ts's parseInboundMessages) — the webhook
 * route calls this once per recognized message. Never throws: every
 * failure path is captured and returned as a result, matching
 * notifyAttentionIfNeeded's posture of never failing the caller's ack.
 */
export async function handleInboundMessage(params: {
  db: SupabaseClient<Database>;
  whatsappClient: WhatsAppGraphClient;
  event: InboundMessageEvent;
}): Promise<HandleInboundMessageResult> {
  const { db, whatsappClient, event } = params;

  if (event.type !== "text" || event.textBody === null) {
    return { processed: false, outcome: "ignored_non_text" };
  }

  const claim = await claimInboundEvent(db, event.providerMessageId);
  if (!claim.claimed) {
    return { processed: false, outcome: "duplicate" };
  }

  const configuredDestination = env.metaWhatsappDestinationNumber();
  if (!isAuthorizedSender(event.from, configuredDestination)) {
    await finalizeInboundEvent(db, claim.id, { outcome: "unauthorized_sender" });
    return { processed: true, outcome: "unauthorized_sender" };
  }

  const command = parseInboundCommand(event.textBody);
  if (!command) {
    await finalizeInboundEvent(db, claim.id, { outcome: "unsupported_command" });
    await sendConfirmation(whatsappClient, event.from, CONFIRMATION_COPY.unsupported_command);
    return { processed: true, outcome: "unsupported_command" };
  }

  const correlation = await resolveDraftForInboundCommand(db, event.contextId);

  if (correlation.outcome === "unresolved_context") {
    await finalizeInboundEvent(db, claim.id, { command, outcome: "unresolved_context" });
    await sendConfirmation(whatsappClient, event.from, CONFIRMATION_COPY.unresolved_context);
    return { processed: true, outcome: "unresolved_context" };
  }

  if (correlation.outcome === "no_candidate" || correlation.outcome === "ambiguous_candidates") {
    await finalizeInboundEvent(db, claim.id, { command, outcome: correlation.outcome });
    await sendConfirmation(whatsappClient, event.from, CONFIRMATION_COPY.no_candidate_or_ambiguous);
    return { processed: true, outcome: correlation.outcome };
  }

  // correlation.outcome === "resolved" — call the existing authoritative
  // mutation directly. Its own state guard (not reproduced here) decides
  // success vs. "no longer pending_approval".
  const mutation = command === APPROVE_COMMAND ? await approveDraft(db, correlation.draftId) : await rejectDraft(db, correlation.draftId);

  if (mutation.ok) {
    const outcome = command === APPROVE_COMMAND ? "approved" : "rejected";
    await finalizeInboundEvent(db, claim.id, { command, resolved_draft_id: correlation.draftId, outcome });
    await sendConfirmation(whatsappClient, event.from, CONFIRMATION_COPY[outcome]);
    return { processed: true, outcome };
  }

  await finalizeInboundEvent(db, claim.id, { command, resolved_draft_id: correlation.draftId, outcome: "state_guard_failed" });
  await sendConfirmation(whatsappClient, event.from, CONFIRMATION_COPY.state_guard_failed);
  return { processed: true, outcome: "state_guard_failed" };
}
