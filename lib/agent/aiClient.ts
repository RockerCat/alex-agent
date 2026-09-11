import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ReasoningEffort } from "openai/resources/shared";
import { env } from "@/lib/env";
import {
  plannerOutputSchema,
  executorOutputSchema,
  assetFeedbackInterpretationSchema,
  visualCreativePlanSchema,
  type PlannerOutput,
  type ExecutorOutput,
  type AssetFeedbackInterpretation,
  type VisualCreativePlan,
} from "@/lib/agent/schemas";
import type { UsageTokens } from "@/lib/agent/pricing";

export interface PlannerCallInput {
  systemPrompt: string;
  userPrompt: string;
}

export interface ExecutorCallInput {
  systemPrompt: string;
  userPrompt: string;
}

export interface AssetFeedbackCallInput {
  systemPrompt: string;
  userPrompt: string;
}

export interface VisualDirectorCallInput {
  systemPrompt: string;
  userPrompt: string;
}

export interface AiCallResult<T> {
  output: T;
  usage: UsageTokens;
  model: string;
}

/**
 * Executor calls need a third outcome beyond "valid output" / "thrown
 * error": the Responses API can report a call as `status: "incomplete"`
 * (see `incomplete_details.reason`, e.g. "max_output_tokens") while
 * still returning syntactically valid, schema-compliant JSON — Structured
 * Outputs' constrained decoding can force-close a string exactly at its
 * JSON Schema `maxLength` mid-sentence rather than failing to parse.
 * `output` is therefore optional here and must not be read when
 * `incomplete` is set; callers still record `usage` (the call was real
 * and billable) and retry within the existing bounded Executor policy
 * instead of persisting anything.
 */
export interface ExecutorCallResult {
  output?: ExecutorOutput;
  usage: UsageTokens;
  model: string;
  incomplete?: { reason: string };
}

/**
 * Same incomplete/output-optional shape as ExecutorCallResult, for the
 * same reason — the Responses API's own `status: "incomplete"` signal
 * is checked rather than trusted-by-omission, consistent with how
 * every other structured-output call in this codebase treats that
 * signal. Unlike the renderSpec enums, appliedChanges/unsupportedRequests
 * ARE free-text-ish strings, so truncation here is a real (if bounded
 * by ASSET_FEEDBACK_SUMMARY_MAX_LENGTH) risk, not just belt-and-braces.
 */
export interface AssetFeedbackCallResult {
  output?: AssetFeedbackInterpretation;
  usage: UsageTokens;
  model: string;
  incomplete?: { reason: string };
}

/** Same incomplete/output-optional shape as the other structured-output calls, for the same reason. */
export interface VisualDirectorCallResult {
  output?: VisualCreativePlan;
  usage: UsageTokens;
  model: string;
  incomplete?: { reason: string };
}

/**
 * Thin seam between the agent runtime and the model provider. Production
 * code uses OpenAiClient; tests inject a scripted fake so Planner/Executor
 * business logic (preflight, validation, budget, product truth, revision
 * flow) is exercised deterministically without real API calls or cost
 * (spec section 27).
 */
export interface AiClient {
  runPlanner(input: PlannerCallInput): Promise<AiCallResult<PlannerOutput>>;
  runExecutor(input: ExecutorCallInput): Promise<ExecutorCallResult>;
  runAssetFeedbackInterpreter(input: AssetFeedbackCallInput): Promise<AssetFeedbackCallResult>;
  runVisualDirector(input: VisualDirectorCallInput): Promise<VisualDirectorCallResult>;
}

// Generous headroom above what EXECUTOR_TEXT_LIMITS (lib/agent/schemas.ts)
// can ever require for a single piece of content, so this cap bounds
// worst-case per-call cost without becoming a new truncation source
// itself. Not wired into the Budget Guard's own pre-call estimate
// (lib/agent/runtime.ts / revision.ts still use a smaller, separate
// approxMaxOutputTokens for that pessimistic reservation) — this is
// strictly an upper bound sent to the API.
const EXECUTOR_MAX_OUTPUT_TOKENS = 4000;

// The asset feedback interpreter's output is five short enum values
// plus up to ASSET_FEEDBACK_SUMMARY_MAX_ITEMS short (<=
// ASSET_FEEDBACK_SUMMARY_MAX_LENGTH-char) explanatory strings in each
// of appliedChanges/unsupportedRequests (lib/agent/schemas.ts) — still
// a small, cheap cap, sized with headroom for those summaries rather
// than the bare enums alone.
const ASSET_FEEDBACK_MAX_OUTPUT_TOKENS = 700;

// The Visual Director's output is one enum strategy + a reused
// AssetRenderSpec (five short enums) + up to four capped-length
// explanatory/creative strings (VISUAL_PLAN_TEXT_LIMITS in
// lib/agent/schemas.ts: creativeConcept 280, communicationGoal 240,
// generativeSceneDescription 500, rationale 400 chars) — sized with
// headroom for all four at their ceiling plus enum/JSON overhead.
const VISUAL_DIRECTOR_MAX_OUTPUT_TOKENS = 1600;

function usageFromResponse(
  usage:
    | {
        input_tokens: number;
        output_tokens: number;
        input_tokens_details?: { cached_tokens?: number };
      }
    | undefined
): UsageTokens {
  // The SDK types `usage` as optional. Guard explicitly rather than a
  // non-null assertion: the Budget Guard's spend accounting depends on
  // this, and a call that billed real tokens but silently produced no
  // usage record would let the guard under-count spend and allow further
  // calls it should have blocked.
  if (!usage) {
    throw new Error(
      "OpenAI response did not include usage data — refusing to proceed without recording actual cost."
    );
  }
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage.output_tokens,
  };
}

export class OpenAiClient implements AiClient {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({ apiKey: env.openaiApiKey() });
  }

  async runPlanner(input: PlannerCallInput): Promise<AiCallResult<PlannerOutput>> {
    const model = env.plannerModel();
    const reasoningEffort = env.plannerReasoningEffort();
    const response = await this.client.responses.parse({
      model,
      // Opt-in only (env.plannerReasoningEffort() is null unless
      // OPENAI_PLANNER_REASONING_EFFORT is explicitly set): live evidence
      // showed the confirmed gpt-5.6-sol default rejects this param
      // outright ("400 Unsupported parameter: 'reasoning.effort' is not
      // supported with this model."). Only set the env var once a
      // specific configured model is verified to accept it.
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort as ReasoningEffort } } : {}),
      input: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
      ],
      text: { format: zodTextFormat(plannerOutputSchema, "planner_output") },
    });

    const parsed = response.output_parsed;
    if (!parsed) {
      throw new Error("Planner response did not contain parsed structured output");
    }

    return {
      output: parsed,
      usage: usageFromResponse(response.usage),
      model,
    };
  }

  async runExecutor(input: ExecutorCallInput): Promise<ExecutorCallResult> {
    const model = env.executorModel();
    const response = await this.client.responses.parse({
      model,
      max_output_tokens: EXECUTOR_MAX_OUTPUT_TOKENS,
      input: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
      ],
      text: { format: zodTextFormat(executorOutputSchema, "executor_output") },
    });

    const usage = usageFromResponse(response.usage);

    // Trust the API's own completeness signal over the parse succeeding.
    // Constrained decoding can force-close a truncated string into
    // syntactically valid JSON, so `output_parsed` may look fine even
    // when `status`/`incomplete_details` says otherwise — this is the
    // live incident this guards against.
    if (response.status === "incomplete") {
      return {
        usage,
        model,
        incomplete: { reason: response.incomplete_details?.reason ?? "unknown" },
      };
    }

    const parsed = response.output_parsed;
    if (!parsed) {
      throw new Error("Executor response did not contain parsed structured output");
    }

    return {
      output: parsed,
      usage,
      model,
    };
  }

  async runAssetFeedbackInterpreter(input: AssetFeedbackCallInput): Promise<AssetFeedbackCallResult> {
    // Deliberately the same executor model/configuration as runExecutor
    // (spec: narrow execution/interpretation task, no reasoning effort,
    // does not warrant the Planner model) — just a different, much
    // smaller, fully-bounded output schema.
    const model = env.executorModel();
    const response = await this.client.responses.parse({
      model,
      max_output_tokens: ASSET_FEEDBACK_MAX_OUTPUT_TOKENS,
      input: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
      ],
      text: { format: zodTextFormat(assetFeedbackInterpretationSchema, "asset_feedback_interpretation") },
    });

    const usage = usageFromResponse(response.usage);

    if (response.status === "incomplete") {
      return {
        usage,
        model,
        incomplete: { reason: response.incomplete_details?.reason ?? "unknown" },
      };
    }

    const parsed = response.output_parsed;
    if (!parsed) {
      throw new Error("Asset feedback interpreter response did not contain parsed structured output");
    }

    return {
      output: parsed,
      usage,
      model,
    };
  }

  async runVisualDirector(input: VisualDirectorCallInput): Promise<VisualDirectorCallResult> {
    // Same executor model/configuration as runExecutor/runAssetFeedbackInterpreter
    // (spec: narrow, non-reasoning creative-planning task, one call) —
    // just a different bounded output schema.
    const model = env.executorModel();
    const response = await this.client.responses.parse({
      model,
      max_output_tokens: VISUAL_DIRECTOR_MAX_OUTPUT_TOKENS,
      input: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
      ],
      text: { format: zodTextFormat(visualCreativePlanSchema, "visual_creative_plan") },
    });

    const usage = usageFromResponse(response.usage);

    if (response.status === "incomplete") {
      return {
        usage,
        model,
        incomplete: { reason: response.incomplete_details?.reason ?? "unknown" },
      };
    }

    const parsed = response.output_parsed;
    if (!parsed) {
      throw new Error("Visual Director response did not contain parsed structured output");
    }

    return {
      output: parsed,
      usage,
      model,
    };
  }
}
