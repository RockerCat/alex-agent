import { describe, it, expect } from "vitest";
import { runMarketingCycle } from "@/lib/agent/runtime";
import { answerQuestion } from "@/lib/agent/questions";
import { createFakeDb, asSupabaseClient, type FakeDb } from "@/tests/support/fakeDb";
import { seedDefaultSettings } from "@/tests/support/seed";
import { ScriptedAiClient, carouselExecutorOutput } from "@/tests/support/fakeAiClient";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

// Durable resume: closes the gap where a blocked brief's answered
// question could be orphaned if the immediate at-answer-time resume
// races with another active run, fails technically, or is stopped by
// the Budget Guard. A later "Run Marketing Cycle" must find and
// complete that exact resumable work — without rerunning the Planner,
// reconstructing the brief from prose, or duplicating anything.

const PLAN_ID = "plan-1";
const BLOCKED_DRAFT_ID = "draft-blocked";
const QUESTION_ID = "q-blocked";

function seedActivePlan(fake: FakeDb) {
  fake.seed("marketing_plans", [
    {
      id: PLAN_ID,
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
}

function pendingDraft(id: string, topic: string) {
  return {
    id,
    plan_id: PLAN_ID,
    brand: "solardesk",
    created_by_run: null,
    channel: "instagram" as const,
    content_type: "carousel" as const,
    purpose: "education",
    topic,
    audience: "Instaladores",
    cta: "cta",
    target_date: "2026-09-12",
    status: "pending_approval" as const,
    version: 1,
    title: topic,
    hook: "hook",
    body: { slides: [{ slide: 1, text: "..." }] },
    caption: "caption",
    cta_text: "cta",
    visual_direction: "v",
    hashtags: [],
    created_at: new Date().toISOString(),
  };
}

function seedBlockedDraftAndQuestion(
  fake: FakeDb,
  questionStatus: "open" | "answered",
  extraPendingDrafts: ReturnType<typeof pendingDraft>[] = []
) {
  fake.seed("content_drafts", [
    ...extraPendingDrafts,
    {
      id: BLOCKED_DRAFT_ID,
      plan_id: PLAN_ID,
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
      blocked_on_question_id: QUESTION_ID,
      created_at: new Date().toISOString(),
    },
  ]);
  fake.seed("agent_questions", [
    {
      id: QUESTION_ID,
      brand: "solardesk",
      question: "¿Debe el CTA enlazar directamente a la página de registro y cuál es la URL vigente para Instagram?",
      reason: "BRAND.md no confirma el destino exacto del CTA para este flujo.",
      status: questionStatus,
      blocks_progress: false,
      answer:
        questionStatus === "answered"
          ? 'Sí. El CTA "Comenzar gratis" debe dirigir directamente a la página de registro. La URL vigente es: https://solardesk.co/register'
          : null,
      context_run_id: null,
      context_plan_id: PLAN_ID,
      context_draft_id: BLOCKED_DRAFT_ID,
      created_at: new Date().toISOString(),
      answered_at: questionStatus === "answered" ? new Date().toISOString() : null,
    },
  ]);
}

function seedRunningRun(fake: FakeDb, id: string, startedAt = new Date().toISOString()) {
  fake.seed("agent_runs", [
    {
      id,
      brand: "solardesk",
      kind: "marketing_cycle",
      trigger: "manual",
      status: "running",
      decision: null,
      summary: null,
      error_code: null,
      error_message: null,
      started_at: startedAt,
      completed_at: null,
      created_at: startedAt,
    },
  ]);
}

describe("H8 — lock conflict does not orphan blocked work", () => {
  it("survives an answer that races with another active run, and resumes on the next wake once the lock clears", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedActivePlan(fake);
    seedBlockedDraftAndQuestion(fake, "open");
    seedRunningRun(fake, "run-other");

    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    // Alex answers while "run-other" still owns the brand lock.
    const answerAiClient = new ScriptedAiClient([], [carouselExecutorOutput()]);
    const answerOutcome = await answerQuestion({
      db,
      aiClient: answerAiClient,
      questionId: QUESTION_ID,
      answer: "answer",
    });

    expect(answerOutcome.ok).toBe(true);
    expect(answerOutcome.resumed?.status).toBe("concurrent");
    expect(answerAiClient.executorCalls).toHaveLength(0); // never got past the lock

    // The question is answered; the placeholder is untouched and still resumable.
    expect(fake.getAll("agent_questions")[0].status).toBe("answered");
    const stillBlocked = fake.getAll("content_drafts").find((d) => d.id === BLOCKED_DRAFT_ID);
    expect(stillBlocked?.status).toBe("draft");
    expect(stillBlocked?.blocked_on_question_id).toBe(QUESTION_ID);

    // The other run finishes and releases the lock.
    await db.from("agent_runs").update({ status: "completed" }).eq("id", "run-other");

    // Alex clicks Run Marketing Cycle.
    const cycleAiClient = new ScriptedAiClient([], [carouselExecutorOutput({ title: "resolved" })]);
    const { run } = await runMarketingCycle({ db, aiClient: cycleAiClient, brand: "solardesk" });

    expect(run.status).toBe("completed");
    expect(cycleAiClient.plannerCalls).toHaveLength(0);
    expect(cycleAiClient.executorCalls).toHaveLength(1);

    const drafts = fake.getAll("content_drafts");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe("pending_approval");
    expect(drafts[0].version).toBe(1);

    const revisions = fake.getAll("content_revisions").filter((r) => r.draft_id === BLOCKED_DRAFT_ID);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].version).toBe(1);
  });
});

describe("H9 — a technical resume failure is retryable, not fatal", () => {
  it("leaves the placeholder recoverable after a thrown Executor error, and a later cycle completes it without duplicates", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedActivePlan(fake);
    seedBlockedDraftAndQuestion(fake, "open");
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const failingAiClient = new ScriptedAiClient([], [carouselExecutorOutput()]);
    failingAiClient.failNextExecutorCalls = 1;

    const answerOutcome = await answerQuestion({
      db,
      aiClient: failingAiClient,
      questionId: QUESTION_ID,
      answer: "answer",
    });

    expect(answerOutcome.ok).toBe(true);
    expect(answerOutcome.resumed?.status).toBe("failed");

    // Question answered; draft untouched (no version bump, still blocked).
    expect(fake.getAll("agent_questions")[0].status).toBe("answered");
    const stillBlocked = fake.getAll("content_drafts").find((d) => d.id === BLOCKED_DRAFT_ID);
    expect(stillBlocked?.status).toBe("draft");
    expect(stillBlocked?.version).toBe(0);
    expect(fake.getAll("content_revisions").filter((r) => r.draft_id === BLOCKED_DRAFT_ID)).toHaveLength(0);

    // A later marketing cycle retries it successfully.
    const retryAiClient = new ScriptedAiClient([], [carouselExecutorOutput({ title: "recovered" })]);
    const { run } = await runMarketingCycle({ db, aiClient: retryAiClient, brand: "solardesk" });

    expect(run.status).toBe("completed");
    expect(retryAiClient.plannerCalls).toHaveLength(0);

    const drafts = fake.getAll("content_drafts");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe("pending_approval");
    expect(drafts[0].version).toBe(1);

    // Exactly one revision (no duplicate versions from the failed attempt).
    const revisions = fake.getAll("content_revisions").filter((r) => r.draft_id === BLOCKED_DRAFT_ID);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].version).toBe(1);
  });
});

describe("H10 — resumable work outranks WAIT_FOR_APPROVAL", () => {
  it("resumes the blocked placeholder before ever considering WAIT_FOR_APPROVAL, then a later wake correctly returns WAIT_FOR_APPROVAL with no AI call", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedActivePlan(fake);
    const healthyDrafts = [
      pendingDraft("draft-1", "Topic A"),
      pendingDraft("draft-2", "Topic B"),
      pendingDraft("draft-3", "Topic C"),
    ];
    seedBlockedDraftAndQuestion(fake, "answered", healthyDrafts);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const aiClient = new ScriptedAiClient([], [carouselExecutorOutput({ title: "Comienza gratis en SolarDesk" })]);
    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(run.status).toBe("completed");
    expect(run.decision).not.toBe("WAIT_FOR_APPROVAL");
    expect(aiClient.plannerCalls).toHaveLength(0);
    expect(aiClient.executorCalls).toHaveLength(1);

    const drafts = fake.getAll("content_drafts");
    expect(drafts).toHaveLength(4);
    expect(drafts.every((d) => d.status === "pending_approval")).toBe(true);

    // A subsequent wake, with nothing left resumable, must correctly
    // report WAIT_FOR_APPROVAL — with zero AI calls of any kind.
    const secondAiClient = new ScriptedAiClient([], []);
    const { run: secondRun } = await runMarketingCycle({ db, aiClient: secondAiClient, brand: "solardesk" });

    expect(secondRun.status).toBe("skipped");
    expect(secondRun.decision).toBe("WAIT_FOR_APPROVAL");
    expect(secondRun.summary).toContain("4 draft(s)");
    expect(secondAiClient.plannerCalls).toHaveLength(0);
    expect(secondAiClient.executorCalls).toHaveLength(0);
  });
});

describe("H11 — an unanswered blocker is never auto-resumed", () => {
  it("does not call the Executor for a still-open blocking question, and normal WAIT_FOR_APPROVAL behavior is unaffected", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedActivePlan(fake);
    const healthyDrafts = [
      pendingDraft("draft-1", "Topic A"),
      pendingDraft("draft-2", "Topic B"),
      pendingDraft("draft-3", "Topic C"),
    ];
    seedBlockedDraftAndQuestion(fake, "open", healthyDrafts);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const aiClient = new ScriptedAiClient([], []);
    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(run.status).toBe("skipped");
    expect(run.decision).toBe("WAIT_FOR_APPROVAL");
    expect(aiClient.plannerCalls).toHaveLength(0);
    expect(aiClient.executorCalls).toHaveLength(0);

    const stillBlocked = fake.getAll("content_drafts").find((d) => d.id === BLOCKED_DRAFT_ID);
    expect(stillBlocked?.status).toBe("draft");
    expect(stillBlocked?.version).toBe(0);
    expect(fake.getAll("agent_questions")[0].status).toBe("open");
  });
});

describe("H12 — a budget-blocked resume remains durable", () => {
  it("blocks the Executor call, leaves the placeholder intact, and completes on a later retry once budget allows", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake, { monthly_budget_usd: 10.0, safety_reserve_usd: 0.5 });
    seedActivePlan(fake);
    seedBlockedDraftAndQuestion(fake, "answered");
    // Effective stop is $9.50 — seed usage already at $9.60 spent this month.
    fake.seed("ai_usage", [
      {
        id: "usage-1",
        agent_run_id: null,
        brand: "solardesk",
        operation: "executor",
        model: "gpt-5.6-luna",
        input_tokens: 1000,
        cached_input_tokens: 0,
        output_tokens: 1000,
        estimated_cost_usd: 9.6,
        created_at: new Date().toISOString(),
      },
    ]);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const blockedAiClient = new ScriptedAiClient([], [carouselExecutorOutput()]);
    const { run } = await runMarketingCycle({ db, aiClient: blockedAiClient, brand: "solardesk" });

    expect(run.status).toBe("skipped");
    expect(run.decision).toBe("BUDGET_BLOCKED");
    expect(blockedAiClient.plannerCalls).toHaveLength(0);
    expect(blockedAiClient.executorCalls).toHaveLength(0);

    const stillBlocked = fake.getAll("content_drafts").find((d) => d.id === BLOCKED_DRAFT_ID);
    expect(stillBlocked?.status).toBe("draft");
    expect(fake.getAll("agent_questions")[0].status).toBe("answered");

    // Budget frees up (e.g. a new month, or Alex raises the monthly cap) —
    // a later retry completes the exact same resumable work.
    await db.from("agent_settings").update({ monthly_budget_usd: 50.0 }).eq("singleton", true);
    const retryAiClient = new ScriptedAiClient([], [carouselExecutorOutput({ title: "resolved after budget freed up" })]);
    const { run: secondRun } = await runMarketingCycle({ db, aiClient: retryAiClient, brand: "solardesk" });

    expect(secondRun.status).toBe("completed");
    expect(retryAiClient.plannerCalls).toHaveLength(0);
    expect(retryAiClient.executorCalls).toHaveLength(1);

    const drafts = fake.getAll("content_drafts");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe("pending_approval");
    expect(drafts[0].version).toBe(1);
  });
});
