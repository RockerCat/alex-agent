import type { AgentContext } from "@/lib/agent/contextLoader";
import type { AiClient } from "@/lib/agent/aiClient";
import type { PlannerOutput } from "@/lib/agent/schemas";
import { OBJECTIVE_CATALOG, ALLOWED_CHANNELS, ALLOWED_CONTENT_TYPES, MAX_CONTENT_PER_CYCLE } from "@/lib/agent/constants";
import type { UsageTokens } from "@/lib/agent/pricing";

function formatDraftSummary(draft: { topic: string; channel: string; status: string; target_date: string }) {
  return `- [${draft.status}] ${draft.channel} / ${draft.target_date}: ${draft.topic}`;
}

export function buildPlannerPrompt(context: AgentContext, todayIso: string): { system: string; user: string } {
  const system = [
    "You are the planning stage of AlexAgent, an autonomous AI marketing manager.",
    "You operate under a strict agent contract and a single authorized brand.",
    "Read AGENT.md and BRAND.md as the sole authoritative sources for strategy, tone, and factual claims.",
    "You decide WHETHER marketing action is needed and, if so, WHAT should be planned — never fabricate business facts.",
    `Allowed objectives: ${OBJECTIVE_CATALOG.join(", ")}.`,
    `Allowed channels: ${ALLOWED_CHANNELS.join(", ")}. Allowed content formats: ${ALLOWED_CONTENT_TYPES.join(", ")}.`,
    `Never propose more than ${MAX_CONTENT_PER_CYCLE} content pieces. Zero pieces is a valid and often correct answer.`,
    "If a business priority or material product fact required for a safe decision is unknown, use decision NEEDS_HUMAN_INPUT and populate humanQuestion instead of guessing.",
    "Never invent customers, testimonials, statistics, awards, partnerships, or claim unavailable capabilities as available.",
    "Do not repeat a topic that is already covered by an existing active-plan draft unless materially different.",
  ].join("\n");

  const planSummary = context.activePlan
    ? [
        `Active plan: ${context.activePlan.primary_objective} (${context.activePlan.period_start} to ${context.activePlan.period_end}), status=${context.activePlan.status}.`,
        `Strategy: ${context.activePlan.strategy_summary}`,
        "Existing drafts in this plan:",
        ...(context.draftsForActivePlan.length
          ? context.draftsForActivePlan.map(formatDraftSummary)
          : ["  (none yet)"]),
      ].join("\n")
    : "No active marketing plan exists for this brand.";

  const answeredQA = context.recentAnsweredQuestions.length
    ? context.recentAnsweredQuestions
        .map((q) => `Q: ${q.question}\nA: ${q.answer}`)
        .join("\n\n")
    : "(none)";

  const user = [
    `Today's date: ${todayIso}.`,
    "",
    "=== AGENT.md ===",
    context.agentMd,
    "",
    "=== BRAND.md ===",
    context.brandMd,
    "",
    "=== Current operational state ===",
    planSummary,
    "",
    "=== Previously answered business questions (authoritative, may be used as fact) ===",
    answeredQA,
    "",
    "Decide what, if anything, should happen next for this marketing cycle.",
    "If you choose CREATE_PLAN, define a period_start of today and target dates within the next 7 days.",
    "If you choose CONTINUE_EXISTING_PLAN, only propose additional content compatible with the existing active plan's objective/strategy and remaining period.",
  ].join("\n");

  return { system, user };
}

export interface PlannerCallOutcome {
  output: PlannerOutput;
  usage: UsageTokens;
  model: string;
}

export async function callPlanner(
  aiClient: AiClient,
  context: AgentContext,
  todayIso: string,
  correctiveNote?: string
): Promise<PlannerCallOutcome> {
  const { system, user } = buildPlannerPrompt(context, todayIso);
  const finalUser = correctiveNote ? `${user}\n\n=== Correction required ===\n${correctiveNote}` : user;
  const result = await aiClient.runPlanner({ systemPrompt: system, userPrompt: finalUser });
  return result;
}

/** Rough token estimate for pre-call budget checks (chars/4 heuristic). */
export function estimatePlannerInputTokens(context: AgentContext): number {
  const approxChars = context.agentMd.length + context.brandMd.length + 2000;
  return Math.ceil(approxChars / 4);
}
