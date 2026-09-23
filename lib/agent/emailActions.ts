import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Database,
  ContentAssetRow,
  ContentDraftRow,
  EmailActionOutcome,
  EmailActionTokenRow,
  EmailActionType,
  EmailActionSubjectType,
} from "@/lib/types/database";
import { approveDraft, rejectDraft } from "@/lib/agent/approvals";
import { approveAsset, getLatestAsset } from "@/lib/agent/assetGenerator";
import { BRAND_DISPLAY_NAMES, type SupportedBrand } from "@/lib/agent/constants";

// AlexAgent — Email HITL Phase 2B: secure, version-bound email actions.
//
// Email is an adapter over the existing durable workflow, never a second
// approval system: every decision here is made by the SAME authoritative
// domain functions the dashboard uses (approveDraft/rejectDraft with
// expectedVersion, approveAsset with expectedAssetVersion). This module
// only (1) mints and verifies opaque tokens, and (2) records each token's
// single use in email_action_tokens.
//
// Token security:
// - 32 bytes from the CSPRNG, base64url (43 chars, 256 bits). Possession
//   of the unexpired token is the authorization — no login required.
// - Only the SHA-256 hex hash is persisted; lookup is by hash. The
//   plaintext exists only long enough to build the action URL for the
//   email, and this module never logs a token or a hash.
// - The URL carries the token in the fragment (#t=…), which browsers never
//   send to the server: it stays out of server/platform request logs,
//   proxies, and Referer headers. The confirmation page reads it
//   client-side and sends it in a POST body.
//
// Scanner safety: inspectEmailAction() is strictly read-only (never
// consumes, never mutates). Only confirmEmailAction() — reached from an
// explicit user click (POST) — calls a domain mutation.
//
// Single use: a confirm attempt that reaches the domain call always
// finalizes the token (consumed_at + outcome) with a conditional update
// (consumed_at IS NULL). Concurrent/replayed confirms cannot double-mutate:
// the domain calls are themselves compare-and-set on exact version +
// state, so at most one attempt can ever succeed, and every later attempt
// sees a consumed token or a failed state guard.

export const DEFAULT_ACTION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Actions this endpoint can execute. "reply" tokens belong to the (future) inbound-reply flow and are never actionable here. */
export type ExecutableEmailAction = Exclude<EmailActionType, "reply">;

const SUBJECT_TYPE_FOR_ACTION: Record<ExecutableEmailAction, EmailActionSubjectType> = {
  approve_draft: "content_draft",
  reject_draft: "content_draft",
  approve_asset: "content_asset",
};

export function generateActionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashActionToken(token) };
}

export function hashActionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isWellFormedActionToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

/**
 * The only shape of action URL this app produces: `${baseUrl}/email/action#t=<token>`.
 * baseUrl must be an absolute https origin (http allowed only for localhost development).
 */
export function buildEmailActionUrl(baseUrl: string, token: string): string {
  const parsed = new URL(baseUrl);
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
    throw new Error("Email action base URL must be https.");
  }
  if (!isWellFormedActionToken(token)) {
    throw new Error("Refusing to build an action URL for a malformed token.");
  }
  return `${parsed.origin}/email/action#t=${token}`;
}

/**
 * Mints one token per requested action, all bound to the same
 * notification + subject + version + brand, and persists ONLY their
 * hashes. Returns the plaintext tokens (never stored) for URL building.
 * The notification row must already exist (durable outbox identity first).
 */
export async function createEmailActionTokens(
  db: SupabaseClient<Database>,
  params: {
    notificationId: string;
    brand: string;
    subjectType: EmailActionSubjectType;
    subjectId: string;
    subjectVersion: number;
    actions: ExecutableEmailAction[];
    now?: Date;
    ttlMs?: number;
  }
): Promise<Record<ExecutableEmailAction, string | undefined>> {
  const now = params.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (params.ttlMs ?? DEFAULT_ACTION_TOKEN_TTL_MS)).toISOString();
  const tokens: Record<ExecutableEmailAction, string | undefined> = { approve_draft: undefined, reject_draft: undefined, approve_asset: undefined };

  const rows = params.actions.map((action) => {
    if (SUBJECT_TYPE_FOR_ACTION[action] !== params.subjectType) {
      throw new Error(`Action ${action} cannot target a ${params.subjectType}.`);
    }
    const { token, tokenHash } = generateActionToken();
    tokens[action] = token;
    return {
      token_hash: tokenHash,
      notification_id: params.notificationId,
      action,
      subject_type: params.subjectType,
      subject_id: params.subjectId,
      subject_version: params.subjectVersion,
      brand: params.brand,
      expires_at: expiresAt,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
  });

  const { error } = await db.from("email_action_tokens").insert(rows);
  if (error) {
    throw new Error(`Could not persist email action tokens: ${error.message}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------
// Inspection (read-only) and confirmation (mutating)
// ---------------------------------------------------------------------

/** Human-safe context only — never internal ids. */
export interface EmailActionContext {
  action: ExecutableEmailAction;
  brandDisplayName: string;
  title: string;
  channel: ContentDraftRow["channel"];
  contentType: ContentDraftRow["content_type"];
  contentVersion: number;
  assetVersion: number | null;
}

export type EmailActionInspection =
  | { state: "invalid" }
  | { state: "expired"; context: EmailActionContext | null }
  | { state: "already_processed"; outcome: EmailActionOutcome | null; context: EmailActionContext | null }
  | { state: "ready"; context: EmailActionContext }
  | { state: "stale"; context: EmailActionContext }
  | { state: "not_actionable"; currentStatus: string; context: EmailActionContext };

export type EmailActionConfirmation =
  | { result: "invalid" }
  | { result: "expired"; context: EmailActionContext | null }
  | { result: "already_processed"; outcome: EmailActionOutcome | null; context: EmailActionContext | null }
  | { result: "applied"; context: EmailActionContext }
  | { result: "stale"; context: EmailActionContext }
  | { result: "not_actionable"; currentStatus: string; context: EmailActionContext }
  | { result: "failed"; context: EmailActionContext | null };

interface LoadedSubject {
  draft: ContentDraftRow;
  asset: ContentAssetRow | null;
  context: EmailActionContext;
}

function brandDisplayName(brand: string): string {
  return BRAND_DISPLAY_NAMES[brand as SupportedBrand] ?? brand;
}

async function findTokenRow(db: SupabaseClient<Database>, rawToken: unknown): Promise<EmailActionTokenRow | null> {
  if (!isWellFormedActionToken(rawToken)) return null;
  const { data } = await db.from("email_action_tokens").select("*").eq("token_hash", hashActionToken(rawToken)).maybeSingle();
  if (!data || data.action === "reply") return null;
  if (SUBJECT_TYPE_FOR_ACTION[data.action as ExecutableEmailAction] !== data.subject_type) return null;
  return data;
}

/** Loads the token's subject; null when it no longer exists or belongs to a different brand than the token (fail closed). */
async function loadSubject(db: SupabaseClient<Database>, row: EmailActionTokenRow): Promise<LoadedSubject | null> {
  let asset: ContentAssetRow | null = null;
  let draftId = row.subject_id;
  if (row.subject_type === "content_asset") {
    const { data } = await db.from("content_assets").select("*").eq("id", row.subject_id).maybeSingle();
    if (!data || data.brand !== row.brand) return null;
    asset = data;
    draftId = data.draft_id;
  }
  const { data: draft } = await db.from("content_drafts").select("*").eq("id", draftId).maybeSingle();
  if (!draft || draft.brand !== row.brand) return null;

  return {
    draft,
    asset,
    context: {
      action: row.action as ExecutableEmailAction,
      brandDisplayName: brandDisplayName(row.brand),
      title: draft.title?.trim() ? draft.title : draft.topic,
      channel: draft.channel,
      contentType: draft.content_type,
      contentVersion: row.subject_type === "content_draft" ? row.subject_version : asset!.source_draft_version,
      assetVersion: asset ? row.subject_version : null,
    },
  };
}

type Actionability = { state: "ready" } | { state: "stale" } | { state: "not_actionable"; currentStatus: string };

async function evaluateActionability(db: SupabaseClient<Database>, row: EmailActionTokenRow, subject: LoadedSubject): Promise<Actionability> {
  if (subject.asset) {
    const latest = await getLatestAsset(db, subject.asset.draft_id);
    if (subject.asset.asset_version !== row.subject_version || !latest || latest.id !== subject.asset.id) return { state: "stale" };
    return subject.asset.status === "pending_review" ? { state: "ready" } : { state: "not_actionable", currentStatus: subject.asset.status };
  }
  if (subject.draft.version !== row.subject_version) return { state: "stale" };
  return subject.draft.status === "pending_approval" ? { state: "ready" } : { state: "not_actionable", currentStatus: subject.draft.status };
}

function isExpired(row: EmailActionTokenRow, now: Date): boolean {
  return Date.parse(row.expires_at) <= now.getTime();
}

/**
 * Read-only: what the confirmation page shows. Never consumes the token
 * and never mutates any workflow state — safe for link scanners.
 */
export async function inspectEmailAction(db: SupabaseClient<Database>, rawToken: unknown, now: Date = new Date()): Promise<EmailActionInspection> {
  const row = await findTokenRow(db, rawToken);
  if (!row) return { state: "invalid" };

  const subject = await loadSubject(db, row);
  if (row.consumed_at) return { state: "already_processed", outcome: row.outcome, context: subject?.context ?? null };
  if (isExpired(row, now)) return { state: "expired", context: subject?.context ?? null };
  if (!subject) return { state: "invalid" };

  const actionability = await evaluateActionability(db, row, subject);
  if (actionability.state === "not_actionable") return { state: "not_actionable", currentStatus: actionability.currentStatus, context: subject.context };
  return { state: actionability.state, context: subject.context };
}

async function finalizeToken(db: SupabaseClient<Database>, row: EmailActionTokenRow, outcome: EmailActionOutcome, now: Date): Promise<boolean> {
  const { data } = await db
    .from("email_action_tokens")
    .update({ consumed_at: now.toISOString(), outcome, updated_at: now.toISOString() })
    .eq("id", row.id)
    .is("consumed_at", null)
    .select("id")
    .maybeSingle();
  return Boolean(data);
}

/**
 * The explicit, user-confirmed action (POST only). Delegates the decision
 * to the existing authoritative domain function with the token's exact
 * version, then finalizes the token exactly once.
 */
export async function confirmEmailAction(db: SupabaseClient<Database>, rawToken: unknown, now: Date = new Date()): Promise<EmailActionConfirmation> {
  const row = await findTokenRow(db, rawToken);
  if (!row) return { result: "invalid" };

  const subject = await loadSubject(db, row);
  if (row.consumed_at) return { result: "already_processed", outcome: row.outcome, context: subject?.context ?? null };
  if (isExpired(row, now)) return { result: "expired", context: subject?.context ?? null };
  if (!subject) {
    await finalizeToken(db, row, "failed", now);
    return { result: "failed", context: null };
  }

  let outcome: EmailActionOutcome;
  let currentStatus: string | null = null;
  if (row.action === "approve_asset") {
    const result = await approveAsset(db, row.subject_id, { expectedAssetVersion: row.subject_version });
    outcome = result.ok ? "applied" : result.staleVersion ? "stale" : "state_guard_failed";
  } else {
    const decide = row.action === "approve_draft" ? approveDraft : rejectDraft;
    const result = await decide(db, row.subject_id, { expectedVersion: row.subject_version });
    outcome = result.ok ? "applied" : !result.ok && result.staleVersion ? "stale" : "state_guard_failed";
  }
  if (outcome === "state_guard_failed") {
    // Re-read purely to tell Alex what the subject is now (e.g. already
    // approved) — never to decide anything.
    const refreshed = (await loadSubject(db, row)) ?? subject;
    const actionability = await evaluateActionability(db, row, refreshed);
    currentStatus = actionability.state === "not_actionable" ? actionability.currentStatus : null;
  }

  const finalizedHere = await finalizeToken(db, row, outcome, now);
  if (!finalizedHere && outcome !== "applied") {
    // A concurrent confirm of this same token finalized first; report
    // what it recorded rather than this attempt's (redundant) failure.
    const { data: current } = await db.from("email_action_tokens").select("outcome").eq("id", row.id).maybeSingle();
    return { result: "already_processed", outcome: current?.outcome ?? null, context: subject.context };
  }

  if (outcome === "applied") return { result: "applied", context: subject.context };
  if (outcome === "stale") return { result: "stale", context: subject.context };
  return { result: "not_actionable", currentStatus: currentStatus ?? "unknown", context: subject.context };
}
