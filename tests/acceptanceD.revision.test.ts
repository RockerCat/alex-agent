import { describe, it, expect } from "vitest";
import { requestRevision } from "@/lib/agent/revision";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { seedDefaultSettings } from "@/tests/support/seed";
import { ScriptedAiClient, carouselExecutorOutput } from "@/tests/support/fakeAiClient";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

function seedPendingDraft(fake: ReturnType<typeof createFakeDb>) {
  fake.seed("marketing_plans", [
    {
      id: "plan-1",
      brand: "solardesk",
      period_start: "2026-09-08",
      period_end: "2026-09-15",
      primary_objective: "SIGNUPS",
      primary_objective_reason: "r",
      primary_objective_success_signal: "s",
      supporting_objectives: [],
      strategy_summary: "sum",
      strategy_audience: "aud",
      strategy_approach: "app",
      rationale: "rat",
      status: "active",
      created_by_run: null,
      created_at: new Date().toISOString(),
    },
  ]);
  fake.seed("content_drafts", [
    {
      id: "draft-1",
      plan_id: "plan-1",
      brand: "solardesk",
      created_by_run: null,
      channel: "instagram",
      content_type: "carousel",
      purpose: "education",
      topic: "Cómo crear tu primera cotización",
      audience: "Instaladores",
      cta: "Crea tu primera cotización",
      target_date: "2026-09-12",
      status: "pending_approval",
      version: 1,
      title: "Título original",
      hook: "Hook original débil",
      body: { slides: [{ slide: 1, text: "..." }] },
      caption: "Caption original",
      cta_text: "Crea tu primera cotización",
      visual_direction: "v1",
      hashtags: ["#solar"],
      created_at: new Date().toISOString(),
    },
  ]);
  fake.seed("content_revisions", [
    {
      id: "rev-1",
      draft_id: "draft-1",
      version: 1,
      title: "Título original",
      hook: "Hook original débil",
      body: { slides: [{ slide: 1, text: "..." }] },
      caption: "Caption original",
      cta_text: "Crea tu primera cotización",
      visual_direction: "v1",
      hashtags: ["#solar"],
      source: "initial",
      feedback_category: null,
      feedback_note: null,
      created_by_run: null,
      created_at: new Date().toISOString(),
    },
  ]);
}

// Spec acceptance test D: requesting a revision with quick feedback must
// invoke the Executor automatically, preserve the previous version, and
// return a new pending-approval version — with no chat/prompt required.

describe("Acceptance D — Revision Workflow", () => {
  it("creates a new revision, preserves history, and returns the draft to pending_approval", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedPendingDraft(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const aiClient = new ScriptedAiClient(
      [],
      [carouselExecutorOutput({ hook: "¿Cansado de perder horas armando propuestas a mano?" })]
    );

    const outcome = await requestRevision({
      db,
      aiClient,
      draftId: "draft-1",
      category: "weak_hook",
      note: "The hook doesn't grab attention",
    });

    expect(outcome.status).toBe("revised");
    expect(outcome.draft?.version).toBe(2);
    expect(outcome.draft?.status).toBe("pending_approval");
    expect(outcome.draft?.hook).toContain("horas armando propuestas");

    const revisions = fake.getAll("content_revisions").sort((a, b) => (a.version as number) - (b.version as number));
    expect(revisions).toHaveLength(2);
    expect(revisions[0].version).toBe(1);
    expect(revisions[0].hook).toBe("Hook original débil"); // preserved, not overwritten
    expect(revisions[1].version).toBe(2);
    expect(revisions[1].feedback_category).toBe("weak_hook");

    expect(aiClient.executorCalls[0].userPrompt).toContain("Revision requested");
  });

  it("refuses to revise a draft that is not pending_approval", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedPendingDraft(fake);
    fake.getAll("content_drafts"); // no-op, ensure seeded
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);
    // flip status directly in-store via a raw update
    await db.from("content_drafts").update({ status: "approved" }).eq("id", "draft-1");

    const aiClient = new ScriptedAiClient([], [carouselExecutorOutput()]);
    const outcome = await requestRevision({ db, aiClient, draftId: "draft-1", category: "other", note: null });

    expect(outcome.status).toBe("failed");
    expect(aiClient.executorCalls).toHaveLength(0);
  });

  it("recovers a stale running run left by a crashed marketing cycle instead of reporting a false concurrency conflict", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedPendingDraft(fake);

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
    const aiClient = new ScriptedAiClient([], [carouselExecutorOutput()]);

    const outcome = await requestRevision({ db, aiClient, draftId: "draft-1", category: "weak_hook", note: null });

    expect(outcome.status).toBe("revised");
    const staleRun = fake.getAll("agent_runs").find((r) => r.id === "run-stale");
    expect(staleRun?.status).toBe("failed");
    expect(staleRun?.error_code).toBe("stale_run_timeout");
  });
});
