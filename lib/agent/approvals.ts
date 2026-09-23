import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentDraftRow } from "@/lib/types/database";

export interface DraftDecisionOptions {
  /**
   * When provided, the decision only applies if the draft is STILL at
   * exactly this version and still pending_approval — enforced by the
   * UPDATE's own WHERE clause (compare-and-set), not by a prior read, so
   * a concurrent revision/approval can never be overwritten. Intended
   * for callers acting on a specific reviewed version (e.g. a future
   * version-bound email action link); an older version's action must
   * never approve/reject a newer one. Omitted → unchanged legacy
   * behavior (dashboard, WhatsApp Phase 1).
   */
  expectedVersion?: number;
}

export type DraftDecisionResult =
  | { ok: true }
  /** staleVersion is true only when a guarded call failed because the draft is no longer at expectedVersion. */
  | { ok: false; message: string; staleVersion?: boolean };

/**
 * Guarded (expectedVersion) path shared by approveDraft/rejectDraft:
 * one conditional UPDATE is the authoritative state guard. Only when it
 * matches no row is the draft re-read — purely to explain why, never to
 * decide anything.
 */
async function applyVersionGuardedDecision(
  db: SupabaseClient<Database>,
  draftId: string,
  expectedVersion: number,
  update: Partial<ContentDraftRow>,
  verb: "approved" | "rejected"
): Promise<DraftDecisionResult> {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return { ok: false, message: "Invalid expected draft version." };
  }

  const { data: updated, error } = await db
    .from("content_drafts")
    .update(update)
    .eq("id", draftId)
    .eq("status", "pending_approval")
    .eq("version", expectedVersion)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, message: error.message };
  if (updated) return { ok: true };

  const { data: current } = await db.from("content_drafts").select("status, version").eq("id", draftId).maybeSingle();
  if (!current) return { ok: false, message: "Draft not found." };
  if (current.version !== expectedVersion) {
    return {
      ok: false,
      staleVersion: true,
      message: `Draft is now at version ${current.version}; version ${expectedVersion} can no longer be ${verb}.`,
    };
  }
  return { ok: false, message: `Draft is in status "${current.status}" and cannot be ${verb}.` };
}

export async function approveDraft(
  db: SupabaseClient<Database>,
  draftId: string,
  options: DraftDecisionOptions = {}
): Promise<DraftDecisionResult> {
  if (options.expectedVersion !== undefined) {
    return applyVersionGuardedDecision(
      db,
      draftId,
      options.expectedVersion,
      { status: "approved", approved_at: new Date().toISOString() },
      "approved"
    );
  }

  const { data: draft } = await db.from("content_drafts").select("status").eq("id", draftId).single();
  if (!draft) return { ok: false as const, message: "Draft not found." };
  if (draft.status !== "pending_approval") {
    return { ok: false as const, message: `Draft is in status "${draft.status}" and cannot be approved.` };
  }
  const { error } = await db
    .from("content_drafts")
    .update({ status: "approved", approved_at: new Date().toISOString() })
    .eq("id", draftId);
  if (error) return { ok: false as const, message: error.message };
  return { ok: true as const };
}

export async function rejectDraft(
  db: SupabaseClient<Database>,
  draftId: string,
  options: DraftDecisionOptions = {}
): Promise<DraftDecisionResult> {
  if (options.expectedVersion !== undefined) {
    return applyVersionGuardedDecision(
      db,
      draftId,
      options.expectedVersion,
      { status: "rejected", rejected_at: new Date().toISOString() },
      "rejected"
    );
  }

  const { data: draft } = await db.from("content_drafts").select("status").eq("id", draftId).single();
  if (!draft) return { ok: false as const, message: "Draft not found." };
  if (draft.status !== "pending_approval") {
    return { ok: false as const, message: `Draft is in status "${draft.status}" and cannot be rejected.` };
  }
  const { error } = await db
    .from("content_drafts")
    .update({ status: "rejected", rejected_at: new Date().toISOString() })
    .eq("id", draftId);
  if (error) return { ok: false as const, message: error.message };
  return { ok: true as const };
}
