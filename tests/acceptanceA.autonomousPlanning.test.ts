import { describe, it, expect } from "vitest";
import { runMarketingCycle } from "@/lib/agent/runtime";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { seedDefaultSettings } from "@/tests/support/seed";
import { ScriptedAiClient, createPlanOutput, carouselExecutorOutput } from "@/tests/support/fakeAiClient";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

// Spec acceptance test A: given a valid BRAND.md and no active plan, running
// the cycle with no content instructions from Alex must independently
// select an objective/strategy, decide content is needed, and produce
// pending-approval drafts.

describe("Acceptance A — Autonomous Planning", () => {
  it("creates a plan and pending-approval drafts without any content instructions", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const aiClient = new ScriptedAiClient([createPlanOutput()], [carouselExecutorOutput()]);

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(run.status).toBe("completed");
    expect(run.decision).toBe("CREATE_PLAN");

    const plans = fake.getAll("marketing_plans");
    expect(plans).toHaveLength(1);
    expect(plans[0].status).toBe("active");
    expect(plans[0].primary_objective).toBe("SIGNUPS");

    const drafts = fake.getAll("content_drafts");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe("pending_approval");
    expect(drafts[0].plan_id).toBe(plans[0].id);

    const revisions = fake.getAll("content_revisions");
    expect(revisions).toHaveLength(1);
    expect(revisions[0].version).toBe(1);
    expect(revisions[0].source).toBe("initial");

    // The Planner prompt must never have been fed a content instruction —
    // only the brand/agent context and operational state.
    const prompt = aiClient.plannerCalls[0].userPrompt;
    expect(prompt).toContain("BRAND.md");
    expect(prompt).not.toMatch(/write \d+ posts about/i);
  });

  it("allows a fully successful run that creates zero content", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const aiClient = new ScriptedAiClient(
      [
        createPlanOutput({
          decision: "NO_ACTION",
          primaryObjective: null,
          strategy: null,
          content: [],
          rationale: "State is already healthy; no new marketing action is warranted this cycle.",
        }),
      ],
      []
    );

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(run.status).toBe("completed");
    expect(run.decision).toBe("NO_ACTION");
    expect(fake.getAll("marketing_plans")).toHaveLength(0);
    expect(fake.getAll("content_drafts")).toHaveLength(0);
  });
});
