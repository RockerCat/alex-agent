import { timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

// AlexAgent — WhatsApp Cloud API webhook (Autonomy v1, diagnostics only).
//
// This module is deliberately narrow: it turns Meta's webhook handshake
// and asynchronous message-status callbacks (sent/delivered/read/failed)
// into notification_outbox provider-status diagnostics, and nothing
// else. It never reads/writes content_drafts, agent_questions,
// agent_runs, or any other workflow table, and never invokes
// Planner/Executor/Visual Director/publish. Inbound user messages
// (entry[].changes[].value.messages[]) are intentionally not parsed or
// stored here — that's future conversational-approval work, not this
// task.
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
