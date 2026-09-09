import { describe, it, expect } from "vitest";
import { validatePlannerOutput } from "@/lib/agent/planValidator";
import { createPlanOutput } from "@/tests/support/fakeAiClient";
import type { AgentContext } from "@/lib/agent/contextLoader";

function baseContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    brand: "solardesk",
    agentMd: "agent",
    brandMd: "brand",
    activePlan: null,
    draftsForActivePlan: [],
    openQuestions: [],
    recentAnsweredQuestions: [],
    recentRuns: [],
    ...overrides,
  };
}

describe("planValidator", () => {
  it("clamps content arrays beyond the circuit breaker limit", () => {
    const content = Array.from({ length: 9 }, (_, i) => ({
      purpose: "education",
      channel: "instagram" as const,
      format: "caption_only" as const,
      topic: `topic-${i}`,
      audience: "aud",
      cta: "cta",
      targetDate: "2026-09-10",
    }));
    const output = createPlanOutput({ content });
    const result = validatePlannerOutput(output, baseContext(), "2026-09-08");
    expect(result.valid).toBe(true);
    expect(result.corrected!.content).toHaveLength(7);
    expect(result.errors.some((e) => e.includes("clamped"))).toBe(true);
  });

  it("drops briefs whose targetDate falls outside the plan period", () => {
    const output = createPlanOutput({
      content: [
        {
          purpose: "education",
          channel: "instagram",
          format: "carousel",
          topic: "out of range",
          audience: "aud",
          cta: "cta",
          targetDate: "2026-10-01",
        },
      ],
    });
    const result = validatePlannerOutput(output, baseContext(), "2026-09-08");
    expect(result.valid).toBe(true);
    expect(result.corrected!.content).toHaveLength(0);
    expect(result.errors.some((e) => e.includes("outside plan period"))).toBe(true);
  });

  it("drops briefs that duplicate an existing non-rejected draft on the same channel", () => {
    const context = baseContext({
      activePlan: {
        id: "plan-1",
        brand: "solardesk",
        period_start: "2026-09-08",
        period_end: "2026-09-15",
        primary_objective: "SIGNUPS",
        primary_objective_reason: "r",
        primary_objective_success_signal: "s",
        supporting_objectives: [],
        strategy_summary: "s",
        strategy_audience: "a",
        strategy_approach: "a",
        rationale: "r",
        status: "active",
        created_by_run: null,
        created_at: "2026-09-08T00:00:00Z",
      },
      draftsForActivePlan: [
        {
          id: "draft-1",
          plan_id: "plan-1",
          brand: "solardesk",
          created_by_run: null,
          channel: "instagram",
          content_type: "carousel",
          purpose: "education",
          topic: "Cómo crear tu primera cotización",
          audience: "aud",
          cta: "cta",
          target_date: "2026-09-10",
          status: "pending_approval",
          version: 1,
          title: null,
          hook: null,
          body: {},
          caption: null,
          cta_text: null,
          visual_direction: null,
          hashtags: [],
          blocked_on_question_id: null,
          approved_at: null,
          rejected_at: null,
          created_at: "2026-09-08T00:00:00Z",
          updated_at: "2026-09-08T00:00:00Z",
        },
      ],
    });

    const output = createPlanOutput({
      decision: "CONTINUE_EXISTING_PLAN",
      content: [
        {
          purpose: "education",
          channel: "instagram",
          format: "carousel",
          topic: "Cómo crear tu primera cotización",
          audience: "aud",
          cta: "cta",
          targetDate: "2026-09-11",
        },
      ],
    });

    const result = validatePlannerOutput(output, context, "2026-09-08");
    // The only proposed brief was dropped as a duplicate, leaving
    // CONTINUE_EXISTING_PLAN with zero actionable content — invalid
    // (not merely "valid but empty"): the Planner must instead return
    // NO_ACTION when nothing differentiated is left to do.
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicates"))).toBe(true);
    expect(result.errors.some((e) => e.includes("at least one actionable content brief"))).toBe(true);
  });

  it("drops a brief that duplicates another brief within the same Planner response", () => {
    const output = createPlanOutput({
      content: [
        {
          purpose: "education",
          channel: "instagram",
          format: "carousel",
          topic: "Cómo crear tu primera cotización",
          audience: "aud",
          cta: "cta",
          targetDate: "2026-09-10",
        },
        {
          purpose: "education",
          channel: "instagram",
          format: "carousel",
          topic: "  cómo crear tu primera cotización  ",
          audience: "aud",
          cta: "cta",
          targetDate: "2026-09-11",
        },
      ],
    });
    const result = validatePlannerOutput(output, baseContext(), "2026-09-08");
    expect(result.valid).toBe(true);
    expect(result.corrected!.content).toHaveLength(1);
    expect(result.errors.some((e) => e.includes("same response"))).toBe(true);
  });

  it("rejects an empty CONTINUE_EXISTING_PLAN — an active plan alone is not a reason to continue", () => {
    const context = baseContext({
      activePlan: {
        id: "plan-1",
        brand: "solardesk",
        period_start: "2026-09-08",
        period_end: "2026-09-15",
        primary_objective: "ACTIVATION",
        primary_objective_reason: "r",
        primary_objective_success_signal: "s",
        supporting_objectives: [],
        strategy_summary: "s",
        strategy_audience: "a",
        strategy_approach: "a",
        rationale: "r",
        status: "active",
        created_by_run: null,
        created_at: "2026-09-08T00:00:00Z",
      },
    });
    const output = createPlanOutput({ decision: "CONTINUE_EXISTING_PLAN", content: [] });
    const result = validatePlannerOutput(output, context, "2026-09-08");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("at least one actionable content brief"))).toBe(true);
  });

  it("accepts CONTINUE_EXISTING_PLAN when at least one actionable brief survives validation", () => {
    const context = baseContext({
      activePlan: {
        id: "plan-1",
        brand: "solardesk",
        period_start: "2026-09-08",
        period_end: "2026-09-15",
        primary_objective: "ACTIVATION",
        primary_objective_reason: "r",
        primary_objective_success_signal: "s",
        supporting_objectives: [],
        strategy_summary: "s",
        strategy_audience: "a",
        strategy_approach: "a",
        rationale: "r",
        status: "active",
        created_by_run: null,
        created_at: "2026-09-08T00:00:00Z",
      },
    });
    const output = createPlanOutput({
      decision: "CONTINUE_EXISTING_PLAN",
      content: [
        {
          purpose: "education",
          channel: "instagram",
          format: "carousel",
          topic: "Cómo explicar tus supuestos de estimación",
          audience: "aud",
          cta: "cta",
          targetDate: "2026-09-11",
        },
      ],
    });
    const result = validatePlannerOutput(output, context, "2026-09-08");
    expect(result.valid).toBe(true);
    expect(result.corrected!.content).toHaveLength(1);
  });

  it("rejects CREATE_PLAN when an active plan already exists", () => {
    const context = baseContext({
      activePlan: {
        id: "plan-1",
        brand: "solardesk",
        period_start: "2026-09-08",
        period_end: "2026-09-15",
        primary_objective: "SIGNUPS",
        primary_objective_reason: "r",
        primary_objective_success_signal: "s",
        supporting_objectives: [],
        strategy_summary: "s",
        strategy_audience: "a",
        strategy_approach: "a",
        rationale: "r",
        status: "active",
        created_by_run: null,
        created_at: "2026-09-08T00:00:00Z",
      },
    });
    const output = createPlanOutput({ decision: "CREATE_PLAN" });
    const result = validatePlannerOutput(output, context, "2026-09-08");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("already exists"))).toBe(true);
  });
});
