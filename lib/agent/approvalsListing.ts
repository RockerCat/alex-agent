import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentDraftRow, DraftStatus } from "@/lib/types/database";

// Extracted from app/(app)/approvals/page.tsx so the data-loading query is
// unit-testable against the existing fake-DB harness, mirroring the same
// pattern already used for the dashboard (lib/agent/dashboardData.ts).

export type ApprovalsTab = "pending" | "approved";

export const APPROVALS_TAB_STATUS: Record<ApprovalsTab, DraftStatus> = {
  pending: "pending_approval",
  approved: "approved",
};

/**
 * Lists SolarDesk drafts for one Approvals tab. Read-only — this never
 * creates, generates, or approves anything; it only reflects whatever
 * content_drafts already contains for the requested status.
 */
export async function listDraftsForTab(
  db: SupabaseClient<Database>,
  tab: ApprovalsTab
): Promise<ContentDraftRow[]> {
  const { data } = await db
    .from("content_drafts")
    .select("*")
    .eq("brand", "solardesk")
    .eq("status", APPROVALS_TAB_STATUS[tab])
    .order("created_at", { ascending: true });
  return data ?? [];
}
