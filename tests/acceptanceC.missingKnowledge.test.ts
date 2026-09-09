import { describe, it, expect } from "vitest";
import { runMarketingCycle } from "@/lib/agent/runtime";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { seedDefaultSettings } from "@/tests/support/seed";
import { ScriptedAiClient, createPlanOutput } from "@/tests/support/fakeAiClient";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

// Spec acceptance test C: when a safe decision requires unknown business
// knowledge, AlexAgent must create a human question instead of inventing
// the answer, and must not create a marketing plan on that basis.

describe("Acceptance C — Missing Knowledge", () => {
  it("creates a human question and stops instead of fabricating a decision", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const aiClient = new ScriptedAiClient(
      [
        createPlanOutput({
          decision: "NEEDS_HUMAN_INPUT",
          primaryObjective: null,
          strategy: null,
          content: [],
          humanQuestion: {
            question: "Which installer segment (residential vs. commercial) should the first campaign target?",
            reason: "BRAND.md marks the target segment as pending and it materially changes audience/messaging.",
          },
          rationale: "Cannot safely choose a strategy without knowing the target segment.",
        }),
      ],
      []
    );

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(run.status).toBe("completed");
    expect(run.decision).toBe("NEEDS_HUMAN_INPUT");

    const questions = fake.getAll("agent_questions");
    expect(questions).toHaveLength(1);
    expect(questions[0].status).toBe("open");
    expect(questions[0].blocks_progress).toBe(true);
    expect(questions[0].question).toMatch(/segment/i);

    expect(fake.getAll("marketing_plans")).toHaveLength(0);
    expect(fake.getAll("content_drafts")).toHaveLength(0);
  });

  it("a subsequent run is blocked deterministically by the open question, without another Planner call", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    fake.seed("agent_questions", [
      {
        id: "q-1",
        brand: "solardesk",
        question: "Which segment?",
        reason: "unknown",
        status: "open",
        blocks_progress: true,
        answer: null,
        context_run_id: null,
        context_plan_id: null,
        context_draft_id: null,
        created_at: new Date().toISOString(),
        answered_at: null,
      },
    ]);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);
    const aiClient = new ScriptedAiClient([], []);

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(run.status).toBe("skipped");
    expect(run.decision).toBe("NEEDS_HUMAN_INPUT");
    expect(aiClient.plannerCalls).toHaveLength(0);
  });
});
