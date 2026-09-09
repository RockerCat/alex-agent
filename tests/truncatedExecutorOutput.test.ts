import { describe, it, expect } from "vitest";
import { runMarketingCycle } from "@/lib/agent/runtime";
import { validateDraft } from "@/lib/agent/draftValidator";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { seedDefaultSettings } from "@/tests/support/seed";
import {
  ScriptedAiClient,
  createPlanOutput,
  carouselExecutorOutput,
  liveIncidentShapedTruncatedOutput,
} from "@/tests/support/fakeAiClient";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import type { ContentBrief } from "@/lib/agent/schemas";

// Live incident (2026-09-09): a SolarDesk draft reached pending_approval
// with a carousel slide and visualDirection cut off mid-sentence, despite
// a formally valid, schema-compliant Structured Output and a fully
// intact caption. Root cause: the Responses API's own incomplete/status
// signal was never checked, and two of the executor schema's `.max()`
// string limits (slide text 500, visualDirection 600) were tight enough
// that OpenAI's Structured Outputs constrained decoding (or the model's
// own literal compliance with the stated limit) could force-close a
// string exactly at that boundary mid-sentence, producing syntactically
// valid JSON with semantically truncated prose. Neither the Zod schema
// (which only checked shape/length ceilings) nor the Draft Validator
// (which only checked structure/Product Truth) had any way to catch it.

const brief: ContentBrief = {
  purpose: "education",
  channel: "instagram",
  format: "carousel",
  topic: "Topic",
  audience: "aud",
  cta: "cta",
  targetDate: "2026-09-12",
};

describe("I1 — an explicit incomplete OpenAI response never persists", () => {
  it("does not create a draft, respects bounded retry, and never calls the Planner", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const aiClient = new ScriptedAiClient([createPlanOutput()], []);
    // Both allowed Executor attempts (MAX_EXECUTOR_RETRIES = 2) report incomplete.
    aiClient.incompleteExecutorReasons = ["max_output_tokens", "max_output_tokens"];

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(run.status).toBe("completed"); // plan itself is created successfully; only the one brief failed
    expect(aiClient.plannerCalls).toHaveLength(1);
    expect(aiClient.executorCalls).toHaveLength(2);
    expect(fake.getAll("content_drafts")).toHaveLength(0);
    expect(fake.getAll("content_revisions")).toHaveLength(0);
    // Usage must still be recorded for both real (if incomplete) calls.
    expect(fake.getAll("ai_usage").filter((u) => u.operation === "executor")).toHaveLength(2);
  });
});

describe("I2 — a successful retry persists only the complete result", () => {
  it("persists exactly one valid draft after an incomplete first attempt", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const aiClient = new ScriptedAiClient([createPlanOutput()], [carouselExecutorOutput()]);
    aiClient.incompleteExecutorReasons = ["max_output_tokens"];

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(run.status).toBe("completed");
    expect(aiClient.plannerCalls).toHaveLength(1);
    expect(aiClient.executorCalls).toHaveLength(2);

    const drafts = fake.getAll("content_drafts");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe("pending_approval");
    expect(drafts[0].version).toBe(1);

    const revisions = fake.getAll("content_revisions");
    expect(revisions).toHaveLength(1);

    // Usage recorded for both the incomplete attempt and the successful one.
    expect(fake.getAll("ai_usage").filter((u) => u.operation === "executor")).toHaveLength(2);
  });
});

describe("I3 — retry exhaustion fails safely", () => {
  it("produces no partial draft and no infinite retry when every attempt is incomplete", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const aiClient = new ScriptedAiClient([createPlanOutput()], []);
    aiClient.incompleteExecutorReasons = ["max_output_tokens", "max_output_tokens", "max_output_tokens"];

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    // Exactly MAX_EXECUTOR_RETRIES (2) attempts were made, not 3.
    expect(aiClient.executorCalls).toHaveLength(2);
    expect(run.status).toBe("completed");
    expect(fake.getAll("content_drafts")).toHaveLength(0);
    expect(run.summary).toMatch(/failed attempt/i);
  });
});

describe("I4 — existing valid drafts still pass validation", () => {
  it("accepts normal, complete Executor output", () => {
    const result = validateDraft(carouselExecutorOutput(), brief);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe("I5 — budget applies to a retry after an incomplete response", () => {
  it("does not call the Executor again once budget blocks the retry, and preserves safe state", async () => {
    // Uses the blocked-brief resume path (no Planner call involved at
    // all) so the per-run budget straddle is purely between two
    // Executor calls: ~$0.0032 pre-call estimate each, so a $0.0035
    // per-run limit allows the first (its own cost then recorded) and
    // blocks the second's own pre-call check.
    const fake = createFakeDb();
    seedDefaultSettings(fake, { per_run_budget_usd: 0.0035 });
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
    fake.seed("content_drafts", [
      {
        id: "draft-blocked",
        plan_id: "plan-1",
        brand: "solardesk",
        created_by_run: null,
        channel: "instagram",
        content_type: "carousel",
        purpose: "activation",
        topic: "Comienza gratis en SolarDesk",
        audience: "Instaladores",
        cta: "Comenzar gratis",
        target_date: "2026-09-13",
        status: "draft",
        version: 0,
        title: null,
        hook: null,
        body: {},
        caption: null,
        cta_text: null,
        visual_direction: null,
        hashtags: [],
        blocked_on_question_id: "q-blocked",
        created_at: new Date().toISOString(),
      },
    ]);
    fake.seed("agent_questions", [
      {
        id: "q-blocked",
        brand: "solardesk",
        question: "q?",
        reason: "r",
        status: "answered",
        blocks_progress: false,
        answer: "a",
        context_run_id: null,
        context_plan_id: "plan-1",
        context_draft_id: "draft-blocked",
        created_at: new Date().toISOString(),
        answered_at: new Date().toISOString(),
      },
    ]);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const aiClient = new ScriptedAiClient([], [carouselExecutorOutput()]);
    aiClient.incompleteExecutorReasons = ["max_output_tokens"];

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(aiClient.plannerCalls).toHaveLength(0);
    // Only the first (incomplete) Executor call happened; the retry was blocked by budget.
    expect(aiClient.executorCalls).toHaveLength(1);
    expect(run.decision).toBe("BUDGET_BLOCKED");

    const stillBlocked = fake.getAll("content_drafts").find((d) => d.id === "draft-blocked");
    expect(stillBlocked?.status).toBe("draft");
    expect(stillBlocked?.version).toBe(0);
  });
});

describe("I6 — live-incident-shaped regression fixture", () => {
  it("rejects a fixture truncated exactly at the schema's character ceiling", () => {
    const output = liveIncidentShapedTruncatedOutput();

    // Sanity-check the fixture actually reproduces the reported shape:
    // slide/visualDirection truncated mid-sentence, caption intact.
    expect(output.caption.endsWith(".")).toBe(true);
    expect(output.slides[2].text.endsWith("generación")).toBe(true);
    expect(output.visualDirection.endsWith("no son")).toBe(true);

    const result = validateDraft(output, brief);

    // Deterministically detectable: this fixture lands exactly at
    // EXECUTOR_TEXT_LIMITS.slideText / .visualDirection with no closing
    // punctuation — the mechanical-truncation check catches exactly
    // this shape.
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("slides[2]"))).toBe(true);
    expect(result.errors.some((e) => e.includes("visualDirection"))).toBe(true);
  });

  it("documents the limitation: a truncation NOT landing exactly at the boundary is not caught by this heuristic", () => {
    // A string cut short of the exact ceiling (e.g. the API closed it a
    // few characters early) looks identical, structurally, to a
    // deliberately concise sentence that simply doesn't end in a period.
    // No deterministic, non-AI signal in the Structured Output itself
    // distinguishes those two cases once the response is otherwise
    // schema-valid and the API did not flag it incomplete — that gap is
    // real and intentionally not "solved" with a fragile heuristic here.
    // It is covered instead by the primary defense (aiClient.ts checking
    // response.status/incomplete_details), exercised in I1-I3/I5 above.
    const shortAndAbrupt = carouselExecutorOutput({
      visualDirection: "Usar azul oscuro y ámbar; evitar imágenes genéricas de paneles y mantener el texto corto",
    });
    const result = validateDraft(shortAndAbrupt, brief);
    expect(result.valid).toBe(true); // not flagged — and that is the documented, accepted limitation
  });
});
