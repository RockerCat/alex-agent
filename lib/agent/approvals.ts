import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

export async function approveDraft(db: SupabaseClient<Database>, draftId: string) {
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

export async function rejectDraft(db: SupabaseClient<Database>, draftId: string) {
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
