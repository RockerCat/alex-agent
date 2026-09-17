import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentDraftRow, DraftStatus, MarketingPlanRow } from "@/lib/types/database";

// Extracted from app/(app)/approvals/page.tsx so the data-loading query is
// unit-testable against the existing fake-DB harness, mirroring the same
// pattern already used for the dashboard (lib/agent/dashboardData.ts).

export type ApprovalsTab = "pending" | "approved" | "rejected";

export const APPROVALS_TAB_STATUS: Record<ApprovalsTab, DraftStatus> = {
  pending: "pending_approval",
  approved: "approved",
  rejected: "rejected",
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

export interface ApprovalsCycleGroup {
  /** null only for a draft whose plan_id no longer resolves to a real marketing_plans row (legacy/orphaned data). */
  plan: MarketingPlanRow | null;
  /**
   * Mirrors the exact "current cycle" semantics already established for
   * the Dashboard (lib/agent/dashboardData.ts): an `active` plan whose
   * period hasn't genuinely ended yet (period_end >= today). Display
   * only — never mutates plan state or invents a new lifecycle concept.
   */
  isCurrentCycle: boolean;
  drafts: ContentDraftRow[];
}

/**
 * Same drafts as listDraftsForTab, grouped by their parent marketing
 * plan (cycle) so the Approvals UI can present cycles instead of one
 * flat historical list. Groups are ordered newest-cycle-first by
 * period_start; a draft whose plan_id no longer resolves to a real
 * marketing_plans row (should not happen in practice, but content_drafts
 * rows persist independently of their plan) is grouped last, under
 * plan: null, rather than dropped or crashing.
 */
export async function listApprovalsGroupedByCycle(
  db: SupabaseClient<Database>,
  tab: ApprovalsTab,
  todayIsoOverride?: string
): Promise<ApprovalsCycleGroup[]> {
  const drafts = await listDraftsForTab(db, tab);
  if (drafts.length === 0) return [];

  const { data: plans } = await db.from("marketing_plans").select("*").eq("brand", "solardesk");
  const planById = new Map((plans ?? []).map((p) => [p.id, p]));
  const todayIso = todayIsoOverride ?? new Date().toISOString().slice(0, 10);

  const groups = new Map<string, ApprovalsCycleGroup>();
  for (const draft of drafts) {
    const plan = planById.get(draft.plan_id) ?? null;
    const key = plan?.id ?? "__unknown_cycle__";
    let group = groups.get(key);
    if (!group) {
      group = {
        plan,
        isCurrentCycle: plan ? plan.status === "active" && plan.period_end >= todayIso : false,
        drafts: [],
      };
      groups.set(key, group);
    }
    group.drafts.push(draft); // preserves listDraftsForTab's existing created_at-ascending order
  }

  return Array.from(groups.values()).sort((a, b) => {
    if (!a.plan) return 1; // unresolved/legacy cycle always sinks to the end
    if (!b.plan) return -1;
    return b.plan.period_start.localeCompare(a.plan.period_start); // newest cycle first
  });
}
