import type { AgentContext } from "@/lib/agent/contextLoader";
import type { BudgetSnapshot } from "@/lib/agent/budgetGuard";

export type PreflightOutcome =
  | "disabled"
  | "budget_blocked"
  | "blocked_by_question"
  | "wait_for_approval"
  | "proceed_to_planner";

export interface PreflightResult {
  outcome: PreflightOutcome;
  summary: string;
  blockingQuestionId?: string;
}

/**
 * Deterministic checks performed before spending any AI tokens
 * (ALEXAGENT_V0.1_SPEC.md section 23). Concurrency (another run already
 * active) is enforced separately at the database level when the run row
 * is created — by the time preflight runs, this run already holds the
 * lock.
 */
export function runPreflight(params: {
  context: AgentContext;
  solardeskEnabled: boolean;
  budget: BudgetSnapshot;
}): PreflightResult {
  const { context, solardeskEnabled, budget } = params;

  if (!solardeskEnabled) {
    return {
      outcome: "disabled",
      summary: "SolarDesk is disabled in Settings — no marketing action taken.",
    };
  }

  if (budget.monthlySpentUsd >= budget.effectiveStopUsd) {
    return {
      outcome: "budget_blocked",
      summary: `Monthly AI budget effectively exhausted ($${budget.monthlySpentUsd.toFixed(
        2
      )} of $${budget.effectiveStopUsd.toFixed(2)} effective stop). No AI call attempted.`,
    };
  }

  const blockingQuestion = context.openQuestions.find((q) => q.blocks_progress);
  if (blockingQuestion) {
    return {
      outcome: "blocked_by_question",
      summary: `Waiting on an unanswered business question: "${blockingQuestion.question}"`,
      blockingQuestionId: blockingQuestion.id,
    };
  }

  const pendingDrafts = context.draftsForActivePlan.filter(
    (d) => d.status === "pending_approval"
  );
  if (context.activePlan && pendingDrafts.length > 0) {
    return {
      outcome: "wait_for_approval",
      summary: `Active plan "${context.activePlan.primary_objective}" already has ${pendingDrafts.length} draft(s) awaiting Alex's review. No new plan or drafts created.`,
    };
  }

  return {
    outcome: "proceed_to_planner",
    summary: "State changed or no active plan — invoking Planner.",
  };
}
