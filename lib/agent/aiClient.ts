import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { env } from "@/lib/env";
import { plannerOutputSchema, executorOutputSchema, type PlannerOutput, type ExecutorOutput } from "@/lib/agent/schemas";
import type { UsageTokens } from "@/lib/agent/pricing";

export interface PlannerCallInput {
  systemPrompt: string;
  userPrompt: string;
}

export interface ExecutorCallInput {
  systemPrompt: string;
  userPrompt: string;
}

export interface AiCallResult<T> {
  output: T;
  usage: UsageTokens;
  model: string;
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
  runExecutor(input: ExecutorCallInput): Promise<AiCallResult<ExecutorOutput>>;
}

function usageFromResponse(usage: {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
}): UsageTokens {
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
    const response = await this.client.responses.parse({
      model,
      reasoning: { effort: "medium" },
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
      usage: usageFromResponse(response.usage!),
      model,
    };
  }

  async runExecutor(input: ExecutorCallInput): Promise<AiCallResult<ExecutorOutput>> {
    const model = env.executorModel();
    const response = await this.client.responses.parse({
      model,
      input: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
      ],
      text: { format: zodTextFormat(executorOutputSchema, "executor_output") },
    });

    const parsed = response.output_parsed;
    if (!parsed) {
      throw new Error("Executor response did not contain parsed structured output");
    }

    return {
      output: parsed,
      usage: usageFromResponse(response.usage!),
      model,
    };
  }
}
