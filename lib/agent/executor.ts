import type { AgentContext } from "@/lib/agent/contextLoader";
import type { AiClient, ExecutorCallResult } from "@/lib/agent/aiClient";
import type { ContentBrief } from "@/lib/agent/schemas";
import type { FeedbackCategory } from "@/lib/agent/constants";

export interface RevisionInstruction {
  category: FeedbackCategory;
  note: string | null;
  // All editable/versioned Executor-output fields (see
  // lib/agent/draftValidator.ts / content_revisions) — not just the
  // fields the feedback targets — so the model actually has the
  // previous unaffected content in front of it to preserve rather than
  // silently re-inventing it from the brief alone.
  previousContent: {
    title: string | null;
    hook: string | null;
    slides: { slide: number; text: string }[] | null;
    caption: string | null;
    cta: string | null;
    visualDirection: string | null;
    hashtags: string[] | null;
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
    // Channel Content Rules v1 (editorial guidance below is intentionally
    // not mirrored as new schema/validator ceilings — see draftValidator.ts
    // for the separate hard structural rules this pairs with).
    "Instagram and Facebook are different publishing contexts — write for the brief's actual channel, don't reuse generic copy across both.",
    "Instagram: caption editorial target is roughly 300-600 characters when the topic warrants it (shorter is fine); prefer 3-5 genuinely relevant hashtags, never filler hashtags added only to reach a count; a carousel's slides should be visually scannable, with an editorial target of no more than about 140 characters of body text per slide.",
    "Facebook: caption editorial target is roughly 300-800 characters when warranted (shorter is fine); use 0-3 genuinely relevant hashtags — zero is completely valid, do not treat Facebook like Instagram with more hashtags; a carousel's slide body text editorial target is roughly 160 characters or fewer.",
    "These character/hashtag targets are editorial guidance, not quotas — never pad copy, slides, or hashtags merely to reach a preferred range/count; shorter is always acceptable when it communicates the message well.",
    "Every draft needs exactly one clear primary CTA. Do not unnecessarily repeat the same CTA/URL throughout the caption and every slide.",
    "Respect the brief's content type structurally: a carousel's `slides` array must contain between 3 and 6 items; an image_post has exactly one visual panel, so its `slides` array must contain exactly 1 item.",
    "visualDirection must describe communicative visual intent only — hierarchy, subject/emphasis, and what the eventual asset needs to communicate (for example: \"Show the transition from a technical solar quotation to a professional proposal ready to share, emphasizing the finished result and keeping information density low\"). Never specify hex codes, exact colors, font families or sizes, coordinates, pixel measurements, or other low-level rendering/layout instructions — those belong to the Visual Director and the brand's fixed render constraints, not to you.",
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
      "Previous version (title, hook, slides, caption, cta, visualDirection, hashtags):",
      JSON.stringify(revision.previousContent, null, 2),
      "Address the feedback above directly — the new version must actually reflect the requested change, not merely restate the previous version.",
      "When the feedback is narrow, keep the previous version's fields that are unrelated to the requested change unchanged if they remain valid and still consistent with the content brief and channel/Product Truth rules — never rewrite an unaffected field merely for stylistic variety.",
      "The Content brief above (purpose, channel, format, topic, audience, cta, targetDate) is fixed context, not revision-editable output — your output schema has no field for it, so never attempt to restate or correct it."
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

export async function callExecutor(
  aiClient: AiClient,
  context: AgentContext,
  brief: ContentBrief,
  revision?: RevisionInstruction,
  factCorrection?: string
): Promise<ExecutorCallResult> {
  const { system, user } = buildExecutorPrompt(context, brief, revision, factCorrection);
  return aiClient.runExecutor({ systemPrompt: system, userPrompt: user });
}

export function estimateExecutorInputTokens(context: AgentContext): number {
  return Math.ceil((context.brandMd.length + 1500) / 4);
}
