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

export const executorOutputSchema = z.object({
  title: z.string().min(1).max(200),
  hook: z.string().min(1).max(300),
  slides: z
    .array(
      z.object({
        slide: z.number().int().min(1),
        text: z.string().min(1).max(500),
      })
    )
    .max(10),
  caption: z.string().min(1).max(2200),
  cta: z.string().min(1).max(200),
  visualDirection: z.string().min(1).max(600),
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
