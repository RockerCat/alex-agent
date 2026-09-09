import { describe, it, expect } from "vitest";
import { runMarketingCycle } from "@/lib/agent/runtime";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { seedDefaultSettings } from "@/tests/support/seed";
import { ScriptedAiClient } from "@/tests/support/fakeAiClient";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

// Spec acceptance test B: given a healthy active plan with pending drafts,
// running the cycle again must not blindly create another plan or
// duplicate drafts. A wait/no-action outcome is valid — and it must be
// reached deterministically, without paying for another Planner call.

describe("Acceptance B — State Awareness / Duplicate Prevention", () => {
  it("skips the Planner entirely when an active plan has pending-approval drafts", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);

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
        title: "t",
        hook: "h",
        body: { slides: [] },
        caption: "c",
        cta_text: "cta",
        visual_direction: "v",
        hashtags: [],
        created_at: new Date().toISOString(),
      },
    ]);

    const db = asSupabaseClient<SupabaseClient<Database>>(fake);
    const aiClient = new ScriptedAiClient([], []);

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(run.status).toBe("skipped");
    expect(run.decision).toBe("WAIT_FOR_APPROVAL");
    expect(aiClient.plannerCalls).toHaveLength(0);
    expect(fake.getAll("marketing_plans")).toHaveLength(1);
    expect(fake.getAll("content_drafts")).toHaveLength(1);
  });
});
