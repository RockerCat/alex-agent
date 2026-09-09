import { z } from "zod";
import {
  ALLOWED_CHANNELS,
  ALLOWED_CONTENT_TYPES,
  MAX_CONTENT_PER_CYCLE,
  OBJECTIVE_CATALOG,
  PLANNER_DECISIONS,
} from "@/lib/agent/constants";

// ---------------------------------------------------------------------
// Planner structured output (ALEXAGENT_V0.1_SPEC.md section 9)
// ---------------------------------------------------------------------

export const contentBriefSchema = z.object({
  purpose: z.string().min(1).max(200),
  channel: z.enum(ALLOWED_CHANNELS),
  format: z.enum(ALLOWED_CONTENT_TYPES),
  topic: z.string().min(1).max(300),
  audience: z.string().min(1).max(300),
  cta: z.string().min(1).max(200),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
});
export type ContentBrief = z.infer<typeof contentBriefSchema>;

export const plannerOutputSchema = z.object({
  decision: z.enum(PLANNER_DECISIONS),
  primaryObjective: z
    .object({
      type: z.enum(OBJECTIVE_CATALOG),
      reason: z.string().min(1).max(500),
      successSignal: z.string().min(1).max(300),
    })
    .nullable(),
  supportingObjectives: z.array(z.enum(OBJECTIVE_CATALOG)).max(2),
  strategy: z
    .object({
      summary: z.string().min(1).max(600),
      audience: z.string().min(1).max(300),
      approach: z.string().min(1).max(600),
    })
    .nullable(),
  content: z.array(contentBriefSchema).max(MAX_CONTENT_PER_CYCLE + 3), // over-cap tolerated, clamped later
  humanQuestion: z
    .object({
      question: z.string().min(1).max(400),
      reason: z.string().min(1).max(400),
    })
    .nullable(),
  rationale: z.string().min(1).max(800),
});
export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

// ---------------------------------------------------------------------
// Executor structured output (ALEXAGENT_V0.1_SPEC.md section 12)
// ---------------------------------------------------------------------

// Named so lib/agent/draftValidator.ts can check whether a generated
// string landed at EXACTLY its schema ceiling — a strong, mechanical
// signal that OpenAI's Structured Outputs constrained decoding (or the
// model itself, trying to respect the stated limit) force-closed the
// string mid-sentence rather than a coincidentally-short natural length.
//
// The original limits here (title 200, hook 300, slideText 500, cta
// 200, visualDirection 600) are the confirmed root cause of a live
// incident: a carousel slide and visualDirection were cut off mid-
// sentence in an otherwise syntactically valid, schema-compliant
// response — the Responses API's own maxLength enforcement clipped the
// string exactly at the JSON Schema `maxLength` derived from these
// `.max()` calls. Widened with real headroom so ordinary marketing
// copy (including a trailing caveat sentence) fits comfortably under
// the ceiling; `caption`'s existing 2200 was never implicated and is
// unchanged.
export const EXECUTOR_TEXT_LIMITS = {
  title: 260,
  hook: 400,
  slideText: 700,
  caption: 2200,
  cta: 260,
  visualDirection: 900,
} as const;

export const executorOutputSchema = z.object({
  title: z.string().min(1).max(EXECUTOR_TEXT_LIMITS.title),
  hook: z.string().min(1).max(EXECUTOR_TEXT_LIMITS.hook),
  slides: z
    .array(
      z.object({
        slide: z.number().int().min(1),
        text: z.string().min(1).max(EXECUTOR_TEXT_LIMITS.slideText),
      })
    )
    .max(10),
  caption: z.string().min(1).max(EXECUTOR_TEXT_LIMITS.caption),
  cta: z.string().min(1).max(EXECUTOR_TEXT_LIMITS.cta),
  visualDirection: z.string().min(1).max(EXECUTOR_TEXT_LIMITS.visualDirection),
  hashtags: z.array(z.string().min(1).max(50)).max(15),
  // Set by the executor when it could not safely complete the brief
  // without relying on an unverifiable claim (Product Truth — spec section 19).
  unresolvedFactualGap: z
    .object({
      question: z.string().min(1).max(400),
      reason: z.string().min(1).max(400),
    })
    .nullable(),
});
export type ExecutorOutput = z.infer<typeof executorOutputSchema>;
