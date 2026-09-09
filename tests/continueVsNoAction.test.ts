import { describe, it, expect } from "vitest";
import { runMarketingCycle } from "@/lib/agent/runtime";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { seedDefaultSettings } from "@/tests/support/seed";
import { ScriptedAiClient, createPlanOutput, carouselExecutorOutput } from "@/tests/support/fakeAiClient";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

// Live decision-semantics bug: an active ACTIVATION plan already had 4
// approved drafts covering every strategically relevant line; nothing
// differentiated was left to do. The Planner's own reasoning concluded
// exactly that ("No drafts were created"), yet it returned
// CONTINUE_EXISTING_PLAN instead of NO_ACTION — an active plan existing
// is not, by itself, a reason to "continue" it. CONTINUE_EXISTING_PLAN
// must mean "there is justified work to execute now" (>=1 actionable
// brief); an empty one is invalid and must be corrected via the
// existing bounded Planner retry, never silently rewritten in code.

function seedActivePlanWithApprovedDrafts(fake: ReturnType<typeof createFakeDb>) {
  fake.seed("marketing_plans", [
    {
      id: "plan-1",
      brand: "solardesk",
      period_start: "2026-09-08",
      period_end: "2026-09-15",
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
      created_at: new Date().toISOString(),
    },
  ]);
  fake.seed(
    "content_drafts",
    ["Demostración", "Primera cotización", "Personalización", "Estimaciones responsables"].map((topic, i) => ({
      id: `draft-${i}`,
      plan_id: "plan-1",
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
      approved_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }))
  );
}

const emptyContinuePlan = createPlanOutput({
  decision: "CONTINUE_EXISTING_PLAN",
  content: [],
  rationale:
    "El plan activo ya contiene cuatro borradores aprobados y cubre las líneas prioritarias de demostración, primera cotización, personalización y explicación responsable de estimaciones. Agregar más contenido aumentaría el volumen sin una necesidad diferenciada.",
});

const noActionPlan = createPlanOutput({
  decision: "NO_ACTION",
  primaryObjective: null,
  strategy: null,
  content: [],
  rationale: "Confirmado: el plan activo ya cubre las prioridades actuales; no se requiere contenido adicional ahora.",
});

describe("CONTINUE_EXISTING_PLAN vs NO_ACTION", () => {
  it("rejects an empty CONTINUE_EXISTING_PLAN and lets the bounded Planner retry correct it to NO_ACTION", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedActivePlanWithApprovedDrafts(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const aiClient = new ScriptedAiClient([emptyContinuePlan, noActionPlan], []);

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(run.status).toBe("completed");
    expect(run.decision).toBe("NO_ACTION");
    // Exactly two Planner calls: the rejected attempt, then the correction.
    expect(aiClient.plannerCalls).toHaveLength(2);
    expect(aiClient.executorCalls).toHaveLength(0);

    // No drafts were created or altered — still exactly the 4 pre-existing approved ones.
    const drafts = fake.getAll("content_drafts");
    expect(drafts).toHaveLength(4);
    expect(drafts.every((d) => d.status === "approved")).toBe(true);

    // Both real Planner calls went through the Budget Guard and were recorded.
    const plannerUsage = fake.getAll("ai_usage").filter((u) => u.operation === "planner");
    expect(plannerUsage).toHaveLength(2);
  });

  it("fails safely (not NO_ACTION, not a fabricated plan) if every allowed Planner attempt keeps returning an empty CONTINUE_EXISTING_PLAN", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedActivePlanWithApprovedDrafts(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    // MAX_PLANNER_CALLS_PER_RUN is 2 — both attempts are the invalid, empty decision.
    const aiClient = new ScriptedAiClient([emptyContinuePlan, emptyContinuePlan], []);

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(aiClient.plannerCalls).toHaveLength(2);
    expect(run.status).toBe("failed");
    expect(run.decision).toBeNull();
    expect(fake.getAll("content_drafts")).toHaveLength(4); // unchanged
  });

  it("a valid NO_ACTION on the first attempt creates zero drafts and makes zero Executor calls", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedActivePlanWithApprovedDrafts(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const aiClient = new ScriptedAiClient([noActionPlan], []);

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(run.status).toBe("completed");
    expect(run.decision).toBe("NO_ACTION");
    expect(aiClient.plannerCalls).toHaveLength(1);
    expect(aiClient.executorCalls).toHaveLength(0);
    expect(fake.getAll("content_drafts")).toHaveLength(4);
  });

  it("a legitimate CONTINUE_EXISTING_PLAN with at least one actionable brief still creates a new draft", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedActivePlanWithApprovedDrafts(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const continuePlanWithWork = createPlanOutput({
      decision: "CONTINUE_EXISTING_PLAN",
      content: [
        {
          purpose: "activation",
          channel: "instagram",
          format: "carousel",
          topic: "Cómo revisar tus supuestos antes de compartir la propuesta",
          audience: "Instaladores",
          cta: "Comparte tu propuesta",
          targetDate: "2026-09-12",
        },
      ],
      rationale: "Hay una brecha real: falta contenido sobre cómo revisar supuestos antes de compartir.",
    });

    const aiClient = new ScriptedAiClient([continuePlanWithWork], [carouselExecutorOutput()]);

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(run.status).toBe("completed");
    expect(run.decision).toBe("CONTINUE_EXISTING_PLAN");
    expect(aiClient.plannerCalls).toHaveLength(1);
    expect(aiClient.executorCalls).toHaveLength(1);

    const drafts = fake.getAll("content_drafts");
    expect(drafts).toHaveLength(5); // 4 pre-existing + 1 new
    const newDraft = drafts.find((d) => d.status === "pending_approval");
    expect(newDraft).toBeTruthy();
  });
});
