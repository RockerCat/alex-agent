import type { AgentContext } from "@/lib/agent/contextLoader";
import type { AiClient } from "@/lib/agent/aiClient";
import type { ContentBrief, ExecutorOutput } from "@/lib/agent/schemas";
import type { FeedbackCategory } from "@/lib/agent/constants";
import type { UsageTokens } from "@/lib/agent/pricing";

export interface RevisionInstruction {
  category: FeedbackCategory;
  note: string | null;
  previousContent: {
    title: string | null;
    hook: string | null;
    caption: string | null;
    cta: string | null;
  };
}

export function buildExecutorPrompt(
  context: AgentContext,
  brief: ContentBrief,
  revision?: RevisionInstruction,
  factCorrection?: string
): { system: string; user: string } {
  const system = [
    "You are the execution stage of AlexAgent, an autonomous AI marketing manager.",
    "You materialize a validated content brief into structured draft content for the requested channel/format.",
    "Use only facts supported by BRAND.md. Never fabricate customers, testimonials, statistics, partnerships, awards, or claim a capability as available if BRAND.md marks it planned/under development/unknown.",
    "If you cannot complete the brief without relying on an unverifiable fact, set unresolvedFactualGap with a concise question and reason instead of guessing; still fill the other fields as best as safely possible.",
    "Write in the brand's documented tone of voice and language.",
  ].join("\n");

  const parts = [
    "=== BRAND.md ===",
    context.brandMd,
    "",
    "=== Content brief ===",
    JSON.stringify(brief, null, 2),
  ];

  if (revision) {
    parts.push(
      "",
      "=== Revision requested ===",
      `Feedback category: ${revision.category}`,
      revision.note ? `Feedback note: ${revision.note}` : "Feedback note: (none)",
      "Previous version:",
      JSON.stringify(revision.previousContent, null, 2),
      "Produce a new version that addresses this feedback. Do not simply restate the previous version."
    );
  }

  if (factCorrection) {
    parts.push(
      "",
      "=== Correction ===",
      "A previous version stated something as fact that is not supported. Do not reuse it as true.",
      factCorrection
    );
  }

  return { system, user: parts.join("\n") };
}

export interface ExecutorCallOutcome {
  output: ExecutorOutput;
  usage: UsageTokens;
  model: string;
}

export async function callExecutor(
  aiClient: AiClient,
  context: AgentContext,
  brief: ContentBrief,
  revision?: RevisionInstruction,
  factCorrection?: string
): Promise<ExecutorCallOutcome> {
  const { system, user } = buildExecutorPrompt(context, brief, revision, factCorrection);
  return aiClient.runExecutor({ systemPrompt: system, userPrompt: user });
}

export function estimateExecutorInputTokens(context: AgentContext): number {
  return Math.ceil((context.brandMd.length + 1500) / 4);
}
