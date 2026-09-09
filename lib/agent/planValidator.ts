import type { PlannerOutput, ContentBrief } from "@/lib/agent/schemas";
import { plannerOutputSchema } from "@/lib/agent/schemas";
import { MAX_CONTENT_PER_CYCLE, PLAN_PERIOD_DAYS } from "@/lib/agent/constants";
import type { AgentContext } from "@/lib/agent/contextLoader";

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  /** Output with deterministic corrections applied (clamped array, etc). */
  corrected?: PlannerOutput;
  periodStart?: string;
  periodEnd?: string;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isDuplicateOfExisting(brief: ContentBrief, context: AgentContext): boolean {
  return context.draftsForActivePlan.some(
    (d) =>
      d.status !== "rejected" &&
      d.channel === brief.channel &&
      d.topic.trim().toLowerCase() === brief.topic.trim().toLowerCase()
  );
}

/**
 * Enforces the AI/code responsibility boundary from spec section 10:
 * the Planner decides strategy/content, but application code enforces
 * schema validity, allowed decision/objective/channel/format values,
 * date bounds, the max-content-per-cycle circuit breaker, and duplicate
 * prevention against the active plan.
 */
export function validatePlannerOutput(
  raw: unknown,
  context: AgentContext,
  todayIso: string
): PlanValidationResult {
  const parseResult = plannerOutputSchema.safeParse(raw);
  if (!parseResult.success) {
    return { valid: false, errors: parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }

  const output = parseResult.data;
  const errors: string[] = [];

  if (output.decision === "CREATE_PLAN" || output.decision === "CONTINUE_EXISTING_PLAN") {
    if (!output.primaryObjective) errors.push("primaryObjective is required for this decision");
    if (!output.strategy) errors.push("strategy is required for this decision");
  }

  if (output.decision === "NEEDS_HUMAN_INPUT" && !output.humanQuestion) {
    errors.push("humanQuestion is required when decision is NEEDS_HUMAN_INPUT");
  }

  if (output.decision === "CONTINUE_EXISTING_PLAN" && !context.activePlan) {
    errors.push("CONTINUE_EXISTING_PLAN was returned but no active plan exists");
  }

  if (output.decision === "CREATE_PLAN" && context.activePlan) {
    errors.push("CREATE_PLAN was returned but an active plan already exists — use CONTINUE_EXISTING_PLAN or NO_ACTION");
  }

  if (errors.length) {
    return { valid: false, errors };
  }

  const periodStart = context.activePlan?.period_start ?? todayIso;
  const periodEnd = context.activePlan?.period_end ?? addDays(todayIso, PLAN_PERIOD_DAYS);

  let content = output.content;
  const contentErrors: string[] = [];

  if (output.decision === "CREATE_PLAN" || output.decision === "CONTINUE_EXISTING_PLAN") {
    content = content.filter((brief) => {
      if (brief.targetDate < periodStart || brief.targetDate > periodEnd) {
        contentErrors.push(`Dropped brief "${brief.topic}": targetDate ${brief.targetDate} outside plan period ${periodStart}..${periodEnd}`);
        return false;
      }
      if (isDuplicateOfExisting(brief, context)) {
        contentErrors.push(`Dropped brief "${brief.topic}": duplicates an existing draft on ${brief.channel}`);
        return false;
      }
      return true;
    });

    if (content.length > MAX_CONTENT_PER_CYCLE) {
      contentErrors.push(
        `Planner requested ${content.length} pieces; clamped to circuit-breaker limit of ${MAX_CONTENT_PER_CYCLE}`
      );
      content = content.slice(0, MAX_CONTENT_PER_CYCLE);
    }
  } else {
    content = [];
  }

  const corrected: PlannerOutput = { ...output, content };

  return {
    valid: true,
    errors: contentErrors,
    corrected,
    periodStart,
    periodEnd,
  };
}
