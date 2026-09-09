import { describe, it, expect } from "vitest";
import { runMarketingCycle } from "@/lib/agent/runtime";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { seedDefaultSettings } from "@/tests/support/seed";
import { ScriptedAiClient, createPlanOutput } from "@/tests/support/fakeAiClient";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

// Spec acceptance test F: given one active SolarDesk run, a second
// concurrent request must not start another Planner execution and must
// not create a duplicate plan or drafts. Enforced here at the database
// level via a unique partial index simulated by the fake db, exactly as
// supabase/migrations/0001_init.sql defines it for the real database.

describe("Acceptance F — Concurrency", () => {
  it("refuses a second run while one is already active for the brand", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    fake.seed("agent_runs", [
      {
        id: "run-active",
        brand: "solardesk",
        kind: "marketing_cycle",
        trigger: "manual",
        status: "running",
        decision: null,
        summary: null,
        error_code: null,
        error_message: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        created_at: new Date().toISOString(),
      },
    ]);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);
    const aiClient = new ScriptedAiClient([createPlanOutput()], []);

    const { run, concurrent } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(concurrent).toBe(true);
    expect(run.status).toBe("skipped");
    expect(aiClient.plannerCalls).toHaveLength(0);
    expect(fake.getAll("marketing_plans")).toHaveLength(0);
    expect(fake.getAll("content_drafts")).toHaveLength(0);
    // The original active run row is untouched.
    expect(fake.getAll("agent_runs").filter((r) => r.status === "running")).toHaveLength(1);
  });

  it("recovers a stale running run instead of leaving it permanently running", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    fake.seed("agent_runs", [
      {
        id: "run-stale",
        brand: "solardesk",
        kind: "marketing_cycle",
        trigger: "manual",
        status: "running",
        decision: null,
        summary: null,
        error_code: null,
        error_message: null,
        started_at: elevenMinutesAgo,
        completed_at: null,
        created_at: elevenMinutesAgo,
      },
    ]);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);
    const aiClient = new ScriptedAiClient(
      [createPlanOutput({ decision: "NO_ACTION", primaryObjective: null, strategy: null, content: [] })],
      []
    );

    const { run, concurrent } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(concurrent).toBeFalsy();
    expect(run.status).toBe("completed");
    const staleRun = fake.getAll("agent_runs").find((r) => r.id === "run-stale");
    expect(staleRun?.status).toBe("failed");
    expect(staleRun?.error_code).toBe("stale_run_timeout");
  });
});
