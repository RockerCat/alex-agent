import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { BudgetGuard, type BudgetSnapshot } from "@/lib/agent/budgetGuard";

export type AgentStatus = "ready" | "running" | "needs_input" | "budget_paused" | "disabled";

export interface DashboardData {
  status: AgentStatus;
  settings: {
    solardeskEnabled: boolean;
  };
  budget: BudgetSnapshot;
  activePlan: {
    id: string;
    primaryObjective: string;
    strategySummary: string;
    periodStart: string;
    periodEnd: string;
  } | null;
  pendingDraftsCount: number;
  openQuestionsCount: number;
  recentRuns: {
    id: string;
    status: string;
    decision: string | null;
    summary: string | null;
    createdAt: string;
  }[];
}

export async function loadDashboardData(
  db: SupabaseClient<Database>,
  // Injection seam for deterministic tests only — production always
  // omits this and derives today's real UTC calendar date.
  todayIsoOverride?: string
): Promise<DashboardData> {
  const brand = "solardesk";

  const { data: settings } = await db.from("agent_settings").select("*").eq("singleton", true).single();
  const budgetGuard = new BudgetGuard(db);
  const budget = await budgetGuard.getSnapshot();

  const { data: activeRun } = await db
    .from("agent_runs")
    .select("*")
    .eq("brand", brand)
    .eq("status", "running")
    .maybeSingle();

  const { data: plan } = await db
    .from("marketing_plans")
    .select("*")
    .eq("brand", brand)
    .eq("status", "active")
    .maybeSingle();

  // Mirror the fail-closed period_end semantics from completeExpiredPlans
  // (lib/agent/runtime.ts) for display only: period_end === today is still
  // current for the day, period_end < today is stale until the next
  // Marketing Cycle run actually completes it. This never writes to the DB.
  const todayIso = todayIsoOverride ?? new Date().toISOString().slice(0, 10);
  const currentPlan = plan && plan.period_end >= todayIso ? plan : null;

  const { data: pendingDrafts } = await db
    .from("content_drafts")
    .select("id")
    .eq("brand", brand)
    .eq("status", "pending_approval");

  const { data: openQuestions } = await db
    .from("agent_questions")
    .select("id")
    .eq("brand", brand)
    .eq("status", "open");

  const { data: recentRuns } = await db
    .from("agent_runs")
    .select("*")
    .eq("brand", brand)
    .order("created_at", { ascending: false })
    .limit(8);

  let status: AgentStatus = "ready";
  if (!settings?.solardesk_enabled) status = "disabled";
  else if (budget.thresholdLevel === "blocked") status = "budget_paused";
  else if (activeRun) status = "running";
  else if ((openQuestions ?? []).length > 0) status = "needs_input";

  return {
    status,
    settings: { solardeskEnabled: Boolean(settings?.solardesk_enabled) },
    budget,
    activePlan: currentPlan
      ? {
          id: currentPlan.id,
          primaryObjective: currentPlan.primary_objective,
          strategySummary: currentPlan.strategy_summary,
          periodStart: currentPlan.period_start,
          periodEnd: currentPlan.period_end,
        }
      : null,
    pendingDraftsCount: (pendingDrafts ?? []).length,
    openQuestionsCount: (openQuestions ?? []).length,
    recentRuns: (recentRuns ?? []).map((r) => ({
      id: r.id,
      status: r.status,
      decision: r.decision,
      summary: r.summary,
      createdAt: r.created_at,
    })),
  };
}
