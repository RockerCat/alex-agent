import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { SUPPORTED_BRANDS } from "@/lib/agent/constants";

// AlexAgent — WhatsApp Cloud API webhook (Autonomy v1).
//
// Two capabilities live here, both narrowly scoped:
//
// 1. Outbound delivery-status diagnostics (original scope): turns Meta's
//    asynchronous message-status callbacks (sent/delivered/read/failed)
//    into notification_outbox provider-status diagnostics. Never reads/
//    writes content_drafts/agent_questions/agent_runs and never invokes
//    Planner/Executor/Visual Director/publish.
//
// 2. Inbound message parsing/correlation (WhatsApp Inbound Phase 1):
//    extracts a recognized text message from Meta's `messages[]` payload
//    and resolves which pending content_draft it refers to. This module
//    only PARSES and CORRELATES — it never calls approveDraft/rejectDraft
//    itself and never sends a WhatsApp reply. That orchestration (sender
//    authorization, idempotency claim, command dispatch, confirmation
//    send) lives in lib/agent/whatsappInboundCommands.ts, which is the
//    only caller of resolveDraftForInboundCommand below.
//
// notification_outbox.status (see lib/agent/notifications.ts) already
// means "the send request was accepted by Meta" — that existing
// application-level retry/outbox state machine is untouched by this
// module. provider_status is a separate, later-arriving signal from
// Meta's own delivery pipeline; it only ever adds diagnostics to a row
// this app already created, never redefines `status`.

const PROVIDER_STATUS_VALUES = new Set(["sent", "delivered", "read", "failed"]);
const MAX_SANITIZED_TEXT_LENGTH = 300;

export type WhatsAppProviderStatus = "sent" | "delivered" | "read" | "failed";

export interface WhatsAppStatusEvent {
  providerMessageId: string;
  status: WhatsAppProviderStatus;
  /** ISO 8601 — converted from Meta's unix-seconds `timestamp` field. */
  occurredAt: string;
  errorCode: number | null;
  /** Sanitized (truncated) — Meta's own short error title/message, never a raw payload dump. */
  errorDetail: string | null;
}

function timingSafeStringsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Meta's GET webhook verification handshake: `hub.mode=subscribe`,
 * `hub.verify_token=<configured token>`, `hub.challenge=<echo this>`.
 * Returns the challenge to echo back verbatim, or null when the request
 * doesn't pass (caller must respond with a non-2xx, never the challenge).
 */
export function verifyWebhookChallenge(params: {
  mode: string | null;
  token: string | null;
  challenge: string | null;
  expectedToken: string;
}): string | null {
  if (params.mode !== "subscribe") return null;
  if (!params.token || !params.challenge) return null;
  if (!timingSafeStringsEqual(params.token, params.expectedToken)) return null;
  return params.challenge;
}

/**
 * Meta's `X-Hub-Signature-256` payload-authenticity check: an
 * HMAC-SHA256 of the RAW request body, keyed by the Meta App Secret,
 * hex-encoded and prefixed `sha256=`. This is required before trusting
 * ANY POST body — unlike the GET verify-token handshake (a one-time
 * setup check), every single POST must pass this, because a POST can
 * now trigger a real approve/reject mutation (WhatsApp Inbound Phase
 * 1), not just diagnostic writes. The caller must pass the exact raw
 * body bytes read from the request — re-serializing parsed JSON would
 * not reproduce the same bytes Meta signed.
 */
export function verifyWebhookSignature(params: { rawBody: string; signatureHeader: string | null; appSecret: string }): boolean {
  const { rawBody, signatureHeader, appSecret } = params;
  if (!signatureHeader) return false;
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;

  const providedHex = signatureHeader.slice(prefix.length);
  const expectedHex = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");

  if (providedHex.length !== expectedHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(providedHex, "hex"), Buffer.from(expectedHex, "hex"));
  } catch {
    // Buffer.from(..., "hex") silently stops decoding at the first
    // non-hex character rather than throwing, which can produce a
    // shorter-than-expected buffer even when the hex string lengths
    // matched — timingSafeEqual then throws on that length mismatch.
    // Either way this is an invalid signature header, not a server error.
    return false;
  }
}

function sanitizeText(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value.length > MAX_SANITIZED_TEXT_LENGTH ? `${value.slice(0, MAX_SANITIZED_TEXT_LENGTH - 3)}...` : value;
}

function normalizeTimestamp(raw: unknown): string {
  const seconds = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(seconds)) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}

/**
 * Extracts only outbound message-status events from an arbitrary Meta
 * webhook POST body. Every level is optional-chained/shape-checked —
 * this must never throw on an unexpected/future Meta payload shape, and
 * anything that isn't a recognized status event (inbound messages,
 * unknown fields, malformed entries) is silently skipped, not stored.
 */
export function parseStatusEvents(payload: unknown): WhatsAppStatusEvent[] {
  const events: WhatsAppStatusEvent[] = [];
  if (!payload || typeof payload !== "object") return events;

  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return events;

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown } | null)?.changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      const statuses = (change as { value?: { statuses?: unknown } } | null)?.value?.statuses;
      if (!Array.isArray(statuses)) continue;

      for (const status of statuses) {
        const id = (status as { id?: unknown } | null)?.id;
        const statusValue = (status as { status?: unknown } | null)?.status;
        if (typeof id !== "string" || typeof statusValue !== "string" || !PROVIDER_STATUS_VALUES.has(statusValue)) {
          continue;
        }

        const errors = (status as { errors?: unknown } | null)?.errors;
        const firstError = Array.isArray(errors) ? (errors[0] as Record<string, unknown> | undefined) : undefined;
        const errorCode = typeof firstError?.code === "number" ? firstError.code : null;
        const title = sanitizeText(firstError?.title);
        const message = sanitizeText(firstError?.message);
        const errorDetail = title && message ? `${title}: ${message}` : title ?? message;

        events.push({
          providerMessageId: id,
          status: statusValue as WhatsAppProviderStatus,
          occurredAt: normalizeTimestamp((status as { timestamp?: unknown } | null)?.timestamp),
          errorCode,
          errorDetail,
        });
      }
    }
  }

  return events;
}

/**
 * Correlates a Meta status event to an existing notification_outbox row
 * by provider_message_id only (never draft/agent_run ids — those aren't
 * present on this callback and aren't the right correlation key). Never
 * inserts a new row: an event with no matching provider_message_id is a
 * callback for a message this app didn't (or doesn't yet) track, and is
 * safely dropped.
 *
 * Meta documents that status callbacks are not guaranteed to arrive in
 * order — an event older than the row's current provider_status_at is
 * ignored rather than regressing already-recorded state.
 */
export async function recordProviderStatus(
  db: SupabaseClient<Database>,
  event: WhatsAppStatusEvent
): Promise<{ matched: boolean; applied: boolean }> {
  const { data: row } = await db
    .from("notification_outbox")
    .select("id, provider_status_at")
    .eq("provider_message_id", event.providerMessageId)
    .maybeSingle();

  if (!row) return { matched: false, applied: false };

  if (row.provider_status_at && event.occurredAt < row.provider_status_at) {
    return { matched: true, applied: false };
  }

  await db
    .from("notification_outbox")
    .update({
      provider_status: event.status,
      provider_status_at: event.occurredAt,
      provider_error_code: event.status === "failed" ? event.errorCode : null,
      provider_error_detail: event.status === "failed" ? event.errorDetail : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  return { matched: true, applied: true };
}

// ---------------------------------------------------------------------
// Inbound message parsing/correlation (WhatsApp Inbound Phase 1)
// ---------------------------------------------------------------------

export interface InboundMessageEvent {
  providerMessageId: string;
  from: string;
  /** Meta's message type field, e.g. "text", "image", "button" — only "text" is acted on in Phase 1. */
  type: string;
  occurredAt: string;
  /** Only populated when type === "text". */
  textBody: string | null;
  /** The wamid of the message this is a reply to, when the sender used WhatsApp's native reply/swipe gesture. */
  contextId: string | null;
}

/**
 * Extracts inbound user messages from `entry[].changes[].value.messages[]`
 * — the sibling array to `statuses[]` that parseStatusEvents reads; Meta
 * never populates both in the same change. Every level is optional-
 * chained/shape-checked, same posture as parseStatusEvents: never throws
 * on an unexpected/future payload shape, and anything not a well-formed
 * message (missing id/from, malformed entry) is silently skipped rather
 * than stored. Does not decide what to DO with a message — see
 * lib/agent/whatsappInboundCommands.ts for that.
 */
export function parseInboundMessages(payload: unknown): InboundMessageEvent[] {
  const events: InboundMessageEvent[] = [];
  if (!payload || typeof payload !== "object") return events;

  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return events;

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown } | null)?.changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown } } | null)?.value?.messages;
      if (!Array.isArray(messages)) continue;

      for (const message of messages) {
        const id = (message as { id?: unknown } | null)?.id;
        const from = (message as { from?: unknown } | null)?.from;
        const type = (message as { type?: unknown } | null)?.type;
        if (typeof id !== "string" || typeof from !== "string" || typeof type !== "string") continue;

        const textBody = type === "text" ? sanitizeText((message as { text?: { body?: unknown } } | null)?.text?.body) : null;
        const contextId = (message as { context?: { id?: unknown } } | null)?.context?.id;

        events.push({
          providerMessageId: id,
          from,
          type,
          occurredAt: normalizeTimestamp((message as { timestamp?: unknown } | null)?.timestamp),
          textBody,
          contextId: typeof contextId === "string" ? contextId : null,
        });
      }
    }
  }

  return events;
}

export type DraftCorrelationOutcome =
  | { outcome: "resolved"; draftId: string }
  | { outcome: "unresolved_context" }
  | { outcome: "no_candidate" }
  | { outcome: "ambiguous_candidates" };

/**
 * Fail-safe draft correlation for an inbound approve/reject command —
 * never guesses. Preferred path: `contextId` (Meta's reply-to message
 * id) resolves EXACTLY by `notification_outbox.provider_message_id`, so
 * a reply to an older notification always resolves to that specific
 * notification's draft, never "whichever is newest now". Fallback path
 * (no reply context): only proceeds when exactly one
 * `content_drafts.status = 'pending_approval'` row exists across the
 * currently supported brands — zero or multiple candidates both refuse
 * to guess. This also makes the fallback safe if a second brand is ever
 * added (SUPPORTED_BRANDS currently has exactly one entry): two brands
 * each with a pending draft at once would correctly yield
 * "ambiguous_candidates", not a wrong guess.
 */
export async function resolveDraftForInboundCommand(
  db: SupabaseClient<Database>,
  contextId: string | null
): Promise<DraftCorrelationOutcome> {
  if (contextId) {
    const { data: row } = await db
      .from("notification_outbox")
      .select("subject_type, subject_id")
      .eq("provider_message_id", contextId)
      .eq("notification_type", "draft_pending_approval")
      .maybeSingle();

    if (!row || row.subject_type !== "content_draft") {
      return { outcome: "unresolved_context" };
    }
    return { outcome: "resolved", draftId: row.subject_id };
  }

  const { data: drafts } = await db
    .from("content_drafts")
    .select("id")
    .in("brand", [...SUPPORTED_BRANDS])
    .eq("status", "pending_approval");

  const candidates = drafts ?? [];
  if (candidates.length === 0) return { outcome: "no_candidate" };
  if (candidates.length > 1) return { outcome: "ambiguous_candidates" };
  return { outcome: "resolved", draftId: candidates[0].id };
}
