import { describe, it, expect } from "vitest";
import { runMarketingCycle } from "@/lib/agent/runtime";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { seedDefaultSettings } from "@/tests/support/seed";
import { ScriptedAiClient, createPlanOutput, carouselExecutorOutput } from "@/tests/support/fakeAiClient";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

// Marketing-cycle lifecycle: an `active` plan whose period has
// genuinely ended (period_end < todayIso) is a deterministic calendar
// fact, not a Planner decision. runMarketingCycle must complete it
// BEFORE the Planner reasons about state for that same run, so a new
// plan can naturally follow without Alex manually editing the
// database. period_end === todayIso is still the plan's last active
// day. Real incident dates: SolarDesk's ACTIVATION plan ran
// 2026-09-09 -> 2026-09-16 (see PROJECT_STATUS.md).

const PLAN_ID = "plan-1";

function seedActivationPlan(fake: ReturnType<typeof createFakeDb>, overrides: Record<string, unknown> = {}) {
  fake.seed("marketing_plans", [
    {
      id: PLAN_ID,
      brand: "solardesk",
      period_start: "2026-09-09",
      period_end: "2026-09-16",
      primary_objective: "ACTIVATION",
      primary_objective_reason: "r",
      primary_objective_success_signal: "s",
      supporting_objectives: [],
      strategy_summary: "sum",
      strategy_audience: "aud",
      strategy_approach: "app",
      rationale: "rat",
      status: "active",
      created_by_run: null,
      created_at: "2026-09-09T00:00:00Z",
      ...overrides,
    },
  ]);
}

function seedFourApprovedDrafts(fake: ReturnType<typeof createFakeDb>) {
  fake.seed(
    "content_drafts",
    ["Demostración", "Primera cotización", "Personalización", "Estimaciones responsables"].map((topic, i) => ({
      id: `draft-${i}`,
      plan_id: PLAN_ID,
      brand: "solardesk",
      created_by_run: null,
      channel: "instagram" as const,
      content_type: "carousel" as const,
      purpose: "education",
      topic,
      audience: "Instaladores",
      cta: "cta",
      target_date: "2026-09-10",
      status: "approved" as const,
      version: 1,
      title: topic,
      hook: "hook",
      body: { slides: [{ slide: 1, text: "..." }] },
      caption: "caption",
      cta_text: "cta",
      visual_direction: "v",
      hashtags: [],
      approved_at: "2026-09-10T00:00:00Z",
      created_at: "2026-09-09T00:00:00Z",
    }))
  );
}

const noActionOutput = createPlanOutput({
  decision: "NO_ACTION",
  primaryObjective: null,
  strategy: null,
  content: [],
  rationale: "El plan activo ya cubre las prioridades actuales; no se requiere contenido adicional ahora.",
});

describe("Marketing cycle lifecycle — expiry boundary", () => {
  it("Boundary A: on the plan's last day (period_end === today), the plan stays active", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedActivationPlan(fake);
    seedFourApprovedDrafts(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);
    const aiClient = new ScriptedAiClient([noActionOutput], []);

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk", todayIso: "2026-09-16" });

    expect(run.status).toBe("completed");
    expect(run.decision).toBe("NO_ACTION");
    expect(fake.getAll("marketing_plans")).toHaveLength(1);
    expect(fake.getAll("marketing_plans")[0].status).toBe("active");
    // The Planner must have been told this plan is still the active one.
    expect(aiClient.plannerCalls[0].userPrompt).toContain("status=active");
    expect(aiClient.plannerCalls[0].userPrompt).toContain("2026-09-09 to 2026-09-16");
  });

  it("Boundary B: the day after period_end, the active plan is deterministically completed before the Planner reasons", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedActivationPlan(fake);
    seedFourApprovedDrafts(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);
    const aiClient = new ScriptedAiClient([noActionOutput], []);

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk", todayIso: "2026-09-17" });

    // Application code closed the expired period...
    const plans = fake.getAll("marketing_plans");
    expect(plans).toHaveLength(1);
    expect(plans[0].status).toBe("completed");

    // ...and the SAME run's Planner call received the post-expiry
    // state: no active plan, not the stale one.
    expect(aiClient.plannerCalls[0].userPrompt).toContain("No active marketing plan exists for this brand.");
    expect(aiClient.plannerCalls[0].userPrompt).not.toContain("status=active");

    // The decision itself is still Planner discretion — NO_ACTION
    // remains valid post-expiry; nothing forces CREATE_PLAN.
    expect(run.status).toBe("completed");
    expect(run.decision).toBe("NO_ACTION");

    // The old plan's own content/history is untouched.
    expect(fake.getAll("content_drafts")).toHaveLength(4);
    expect(fake.getAll("content_drafts").every((d) => d.status === "approved" && d.plan_id === PLAN_ID)).toBe(true);
  });

  it("Boundary C: after expiry completion, a Planner CREATE_PLAN response succeeds and does not overlap with the old plan", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedActivationPlan(fake);
    seedFourApprovedDrafts(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const createPlan = createPlanOutput({
      decision: "CREATE_PLAN",
      content: [
        {
          purpose: "activation",
          channel: "instagram",
          format: "carousel",
          topic: "Nuevo ciclo: resultados del piloto",
          audience: "Instaladores",
          cta: "Crea tu primera cotización",
          targetDate: "2026-09-18", // within the new period (starts 2026-09-17)
        },
      ],
    });
    const aiClient = new ScriptedAiClient([createPlan], [carouselExecutorOutput()]);

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk", todayIso: "2026-09-17" });

    expect(run.status).toBe("completed");
    expect(run.decision).toBe("CREATE_PLAN");

    const plans = fake.getAll("marketing_plans");
    expect(plans).toHaveLength(2);

    const oldPlan = plans.find((p) => p.id === PLAN_ID)!;
    expect(oldPlan.status).toBe("completed");
    // Old plan's own fields are untouched (only status changed).
    expect(oldPlan.primary_objective).toBe("ACTIVATION");
    expect(oldPlan.period_start).toBe("2026-09-09");
    expect(oldPlan.period_end).toBe("2026-09-16");

    const newPlan = plans.find((p) => p.id !== PLAN_ID)!;
    expect(newPlan.status).toBe("active");
    expect(newPlan.period_start).toBe("2026-09-17");

    // Exactly one active plan — no overlap.
    expect(plans.filter((p) => p.status === "active")).toHaveLength(1);
  });

  it("regression: CREATE_PLAN is still rejected while a genuinely non-expired active plan exists", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedActivationPlan(fake);
    seedFourApprovedDrafts(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const createPlanAttempt = createPlanOutput({ decision: "CREATE_PLAN" });
    // Both bounded Planner attempts keep incorrectly returning CREATE_PLAN.
    const aiClient = new ScriptedAiClient([createPlanAttempt, createPlanAttempt], []);

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk", todayIso: "2026-09-16" });

    expect(run.status).toBe("failed");
    expect(aiClient.plannerCalls).toHaveLength(2);
    const plans = fake.getAll("marketing_plans");
    expect(plans).toHaveLength(1); // no second plan was created
    expect(plans[0].status).toBe("active"); // untouched — not expired
  });

  it("fails closed if the expired-plan completion UPDATE itself errors, without ever reaching the Planner", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedActivationPlan(fake); // period_end 2026-09-16 — expired relative to todayIso below
    seedFourApprovedDrafts(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    fake.failNextUpdate("marketing_plans", "simulated connection error");

    const aiClient = new ScriptedAiClient([createPlanOutput()], []);

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk", todayIso: "2026-09-17" });

    // The run fails through the existing failure/finalization path.
    expect(run.status).toBe("failed");
    expect(run.error_code).toBe("unexpected_error");
    expect(run.error_message).toContain("Unable to complete expired marketing plans");

    // No Planner (and therefore no AI/OpenAI) call was ever made.
    expect(aiClient.plannerCalls).toHaveLength(0);
    expect(aiClient.executorCalls).toHaveLength(0);

    // The original plan was NOT incorrectly treated as completed —
    // the failed UPDATE never actually applied.
    const plans = fake.getAll("marketing_plans");
    expect(plans).toHaveLength(1);
    expect(plans[0].status).toBe("active");

    // No subsequent strategy/content decision occurred.
    expect(fake.getAll("content_drafts")).toHaveLength(4);
  });
});
