import { describe, it, expect } from "vitest";
import { validatePlannerOutput } from "@/lib/agent/planValidator";
import { createPlanOutput } from "@/tests/support/fakeAiClient";
import { CONTENT_BRIEF_TEXT_LIMITS, type ContentBrief } from "@/lib/agent/schemas";
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
      ctaUrl: null,
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
          ctaUrl: null,
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
          cta_url: null,
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
          ctaUrl: null,
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
          ctaUrl: null,
          targetDate: "2026-09-10",
        },
        {
          purpose: "education",
          channel: "instagram",
          format: "carousel",
          topic: "  cómo crear tu primera cotización  ",
          audience: "aud",
          cta: "cta",
          ctaUrl: null,
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
          ctaUrl: null,
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

  // Boundary D — defense in depth against an already-expired active
  // plan (runMarketingCycle deterministically completes it before the
  // Planner is ever invoked; this is the secondary guard for any other
  // caller of validatePlannerOutput). Real incident dates: SolarDesk's
  // ACTIVATION plan ran 2026-09-09 -> 2026-09-16.
  function expiringPlanContext() {
    return baseContext({
      activePlan: {
        id: "plan-1",
        brand: "solardesk",
        period_start: "2026-09-09",
        period_end: "2026-09-16",
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
        created_at: "2026-09-09T00:00:00Z",
      },
    });
  }

  it("rejects CONTINUE_EXISTING_PLAN when the active plan's period has already ended (period_end < today)", () => {
    const output = createPlanOutput({
      decision: "CONTINUE_EXISTING_PLAN",
      content: [
        {
          purpose: "activation",
          channel: "instagram",
          format: "carousel",
          topic: "Nueva pieza",
          audience: "aud",
          cta: "cta",
          ctaUrl: null,
          targetDate: "2026-09-16",
        },
      ],
    });
    const result = validatePlannerOutput(output, expiringPlanContext(), "2026-09-17");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("already ended"))).toBe(true);
  });

  it("does NOT reject CONTINUE_EXISTING_PLAN merely because today is the plan's last day (period_end === today)", () => {
    const output = createPlanOutput({
      decision: "CONTINUE_EXISTING_PLAN",
      content: [
        {
          purpose: "activation",
          channel: "instagram",
          format: "carousel",
          topic: "Nueva pieza",
          audience: "aud",
          cta: "cta",
          ctaUrl: null,
          targetDate: "2026-09-16",
        },
      ],
    });
    const result = validatePlannerOutput(output, expiringPlanContext(), "2026-09-16");
    expect(result.valid).toBe(true);
    expect(result.errors.some((e) => e.includes("already ended"))).toBe(false);
  });
});

// ContentBrief mechanical-truncation defense (real production incident,
// 2026-09-17): a Planner-authored `purpose` reached pending_approval
// truncated at exactly its 200-char pre-fix schema ceiling, mid-word,
// and — because purpose is brief-level, immutable context to every
// later revision call — could never be corrected afterward. This is the
// ContentBrief analogue of draftValidator.ts's findMechanicalTruncation,
// applied at the same content.filter() boundary that already drops
// out-of-range/duplicate briefs (lib/agent/planValidator.ts).

function baseBrief(overrides: Partial<ContentBrief> = {}): ContentBrief {
  return {
    purpose: "education",
    channel: "instagram",
    format: "carousel",
    topic: "Cómo crear tu primera cotización",
    audience: "Instaladores solares en Colombia",
    cta: "Crea tu primera cotización",
    ctaUrl: null,
    targetDate: "2026-09-10",
    ...overrides,
  };
}

/** Builds a string of exactly `len` characters ending in `tail`. */
function exactLength(len: number, tail: string): string {
  const filler = "a".repeat(Math.max(0, len - tail.length));
  return (filler + tail).slice(0, len);
}

const BRIEF_TEXT_FIELDS: { field: "purpose" | "topic" | "audience" | "cta"; limit: number }[] = [
  { field: "purpose", limit: CONTENT_BRIEF_TEXT_LIMITS.purpose },
  { field: "topic", limit: CONTENT_BRIEF_TEXT_LIMITS.topic },
  { field: "audience", limit: CONTENT_BRIEF_TEXT_LIMITS.audience },
  { field: "cta", limit: CONTENT_BRIEF_TEXT_LIMITS.cta },
];

describe("planValidator — ContentBrief mechanical-truncation defense", () => {
  it("a brief with ordinary, well-below-ceiling text passes untouched", () => {
    const output = createPlanOutput({ content: [baseBrief()] });
    const result = validatePlannerOutput(output, baseContext(), "2026-09-08");
    expect(result.valid).toBe(true);
    expect(result.corrected!.content).toHaveLength(1);
    expect(result.errors.some((e) => e.includes("truncated"))).toBe(false);
  });

  for (const { field, limit } of BRIEF_TEXT_FIELDS) {
    it(`drops a brief whose ${field} lands exactly at its ${limit}-char ceiling with a non-terminal ending (mechanical truncation)`, () => {
      const truncated = exactLength(limit, "x"); // ends mid-word — the real incident's fingerprint
      const output = createPlanOutput({ content: [baseBrief({ [field]: truncated })] });
      const result = validatePlannerOutput(output, baseContext(), "2026-09-08");

      expect(result.valid).toBe(true); // dropped, not a whole-response rejection
      expect(result.corrected!.content).toHaveLength(0);
      expect(result.errors.some((e) => e.includes(`${field} appears mechanically truncated at its ${limit}-character limit`))).toBe(
        true
      );
    });

    it(`keeps a brief whose ${field} lands exactly at its ${limit}-char ceiling but ends with ordinary closing punctuation`, () => {
      const safe = exactLength(limit, "."); // same exact length, deliberately finished thought
      const output = createPlanOutput({ content: [baseBrief({ [field]: safe })] });
      const result = validatePlannerOutput(output, baseContext(), "2026-09-08");

      expect(result.valid).toBe(true);
      expect(result.corrected!.content).toHaveLength(1);
      expect(result.errors.some((e) => e.includes("truncated"))).toBe(false);
    });
  }

  it("existing valid Planner output (no truncation anywhere) is unaffected by this defense", () => {
    const output = createPlanOutput();
    const result = validatePlannerOutput(output, baseContext(), "2026-09-08");
    expect(result.valid).toBe(true);
    expect(result.corrected!.content.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("truncated"))).toBe(false);
  });
});

// CTA label/destination contract (real production incident, 2026-09-17):
// a ContentBrief with a separate, valid ctaUrl must be accepted; a cta
// label carrying an embedded URL (the exact incident shape) or an
// invalid ctaUrl must be deterministically dropped before it can ever
// become a persisted draft.
describe("planValidator — CTA label/destination contract", () => {
  it("1. accepts a brief with cta label and a separate, valid ctaUrl", () => {
    const output = createPlanOutput({
      content: [baseBrief({ cta: "Comenzar gratis", ctaUrl: "https://solardesk.co/register" })],
    });
    const result = validatePlannerOutput(output, baseContext(), "2026-09-08");
    expect(result.valid).toBe(true);
    expect(result.corrected!.content).toHaveLength(1);
    expect(result.corrected!.content[0].cta).toBe("Comenzar gratis");
    expect(result.corrected!.content[0].ctaUrl).toBe("https://solardesk.co/register");
  });

  it("accepts a brief with no destination (ctaUrl null) — not every piece needs one", () => {
    const output = createPlanOutput({ content: [baseBrief({ cta: "Comenzar gratis", ctaUrl: null })] });
    const result = validatePlannerOutput(output, baseContext(), "2026-09-08");
    expect(result.valid).toBe(true);
    expect(result.corrected!.content).toHaveLength(1);
  });

  it("drops the real incident shape: cta label with a URL appended instead of using ctaUrl", () => {
    const output = createPlanOutput({
      content: [baseBrief({ cta: "Comenzar gratis — https://solardesk.co/register", ctaUrl: null })],
    });
    const result = validatePlannerOutput(output, baseContext(), "2026-09-08");
    expect(result.valid).toBe(true); // dropped, not a whole-response rejection
    expect(result.corrected!.content).toHaveLength(0);
    expect(result.errors.some((e) => e.includes("cta must be a short label and must not contain a URL"))).toBe(true);
  });

  it("drops a brief whose ctaUrl is not a valid http(s) URL", () => {
    const output = createPlanOutput({ content: [baseBrief({ cta: "Comenzar gratis", ctaUrl: "not-a-url" })] });
    const result = validatePlannerOutput(output, baseContext(), "2026-09-08");
    expect(result.valid).toBe(true);
    expect(result.corrected!.content).toHaveLength(0);
    expect(result.errors.some((e) => e.includes("ctaUrl is not a valid http(s) URL"))).toBe(true);
  });
});
