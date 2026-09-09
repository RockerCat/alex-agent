import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPlanOutput } from "@/tests/support/fakeAiClient";

// Live incident: the confirmed gpt-5.6-sol Planner model rejected the
// Responses API `reasoning.effort` param outright ("400 Unsupported
// parameter: 'reasoning.effort' is not supported with this model.")
// because OPENAI_PLANNER_REASONING_EFFORT defaulted to "medium" in
// lib/env.ts and was sent on every call regardless of configuration.
// This proves the fix: absent/empty env var -> no `reasoning` key is
// ever included in the request, while an explicitly configured value
// still flows through for a model that is verified to accept it.

const parseMock = vi.fn();

vi.mock("openai", () => {
  class MockOpenAI {
    responses = { parse: parseMock };
  }
  return { default: MockOpenAI };
});

import { OpenAiClient } from "@/lib/agent/aiClient";

describe("OpenAiClient — reasoning param is opt-in only", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    parseMock.mockReset();
    parseMock.mockResolvedValue({
      output_parsed: createPlanOutput(),
      usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 0 } },
    });
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_PLANNER_MODEL = "gpt-5.6-sol";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("sends no reasoning param when OPENAI_PLANNER_REASONING_EFFORT is unset", async () => {
    delete process.env.OPENAI_PLANNER_REASONING_EFFORT;

    const client = new OpenAiClient();
    await client.runPlanner({ systemPrompt: "system", userPrompt: "user" });

    expect(parseMock).toHaveBeenCalledTimes(1);
    const callArgs = parseMock.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty("reasoning");
    expect(callArgs.model).toBe("gpt-5.6-sol");
  });

  it("sends no reasoning param when OPENAI_PLANNER_REASONING_EFFORT is an empty string", async () => {
    process.env.OPENAI_PLANNER_REASONING_EFFORT = "";

    const client = new OpenAiClient();
    await client.runPlanner({ systemPrompt: "system", userPrompt: "user" });

    const callArgs = parseMock.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty("reasoning");
  });

  it("still sends reasoning.effort when explicitly configured for a model verified to accept it", async () => {
    process.env.OPENAI_PLANNER_REASONING_EFFORT = "low";

    const client = new OpenAiClient();
    await client.runPlanner({ systemPrompt: "system", userPrompt: "user" });

    const callArgs = parseMock.mock.calls[0][0];
    expect(callArgs.reasoning).toEqual({ effort: "low" });
  });
});
