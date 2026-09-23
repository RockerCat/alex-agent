import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import type { ExecutorCallInput, ExecutorCallResult } from "@/lib/agent/aiClient";
import { approveDraft, rejectDraft } from "@/lib/agent/approvals";
import { requestRevision } from "@/lib/agent/revision";
import { createFakeDb, asSupabaseClient, type FakeDb } from "@/tests/support/fakeDb";
import { seedDefaultSettings } from "@/tests/support/seed";
import { ScriptedAiClient, carouselExecutorOutput } from "@/tests/support/fakeAiClient";

// Version-bound draft decisions (Email HITL foundation): an action taken
// on a specific reviewed version (e.g. a future email link for v1) must
// never approve/reject/revise a newer version, and must never overwrite
// a concurrent decision. Callers that pass no expectedVersion (dashboard,
// WhatsApp Phase 1) keep their exact legacy behavior.

const DRAFT_ID = "draft-1";

function seedDraft(fake: FakeDb, overrides: Record<string, unknown> = {}) {
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
      id: DRAFT_ID,
      plan_id: "plan-1",
      brand: "solardesk",
      created_by_run: null,
      channel: "instagram",
      content_type: "carousel",
      purpose: "education",
      topic: "Cómo crear tu primera cotización",
      audience: "Instaladores",
      cta: "Crea tu primera cotización",
      cta_url: null,
      target_date: "2026-09-12",
      status: "pending_approval",
      version: 2,
      title: "Título v2",
      hook: "Hook v2",
      body: { slides: [{ slide: 1, text: "..." }] },
      caption: "Caption v2",
      cta_text: "Crea tu primera cotización",
      visual_direction: "v2",
      hashtags: ["#solar"],
      blocked_on_question_id: null,
      approved_at: null,
      rejected_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    },
  ]);
}

function setup(overrides: Record<string, unknown> = {}) {
  const fake = createFakeDb();
  seedDefaultSettings(fake);
  seedDraft(fake, overrides);
  return { fake, db: asSupabaseClient<SupabaseClient<Database>>(fake) };
}

function draftRow(fake: FakeDb) {
  return fake.getAll("content_drafts").find((d) => d.id === DRAFT_ID)!;
}

describe("approveDraft / rejectDraft with expectedVersion", () => {
  it("approves when the draft is still at the expected version and pending_approval", async () => {
    const { fake, db } = setup();
    const result = await approveDraft(db, DRAFT_ID, { expectedVersion: 2 });
    expect(result).toEqual({ ok: true });
    expect(draftRow(fake).status).toBe("approved");
    expect(draftRow(fake).approved_at).not.toBeNull();
  });

  it("rejects when the draft is still at the expected version and pending_approval", async () => {
    const { fake, db } = setup();
    const result = await rejectDraft(db, DRAFT_ID, { expectedVersion: 2 });
    expect(result).toEqual({ ok: true });
    expect(draftRow(fake).status).toBe("rejected");
  });

  it("a stale version cannot approve the newer version", async () => {
    const { fake, db } = setup();
    const result = await approveDraft(db, DRAFT_ID, { expectedVersion: 1 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.staleVersion).toBe(true);
    expect(draftRow(fake).status).toBe("pending_approval");
    expect(draftRow(fake).approved_at).toBeNull();
  });

  it("a stale version cannot reject the newer version", async () => {
    const { fake, db } = setup();
    const result = await rejectDraft(db, DRAFT_ID, { expectedVersion: 1 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.staleVersion).toBe(true);
    expect(draftRow(fake).status).toBe("pending_approval");
    expect(draftRow(fake).rejected_at).toBeNull();
  });

  it("fails closed (not stale) when the version matches but the draft is no longer pending_approval", async () => {
    const { fake, db } = setup({ status: "rejected" });
    const result = await approveDraft(db, DRAFT_ID, { expectedVersion: 2 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.staleVersion).toBeFalsy();
    expect(draftRow(fake).status).toBe("rejected");
  });

  it("a second guarded decision on the same version cannot overwrite the first", async () => {
    const { fake, db } = setup();
    expect((await approveDraft(db, DRAFT_ID, { expectedVersion: 2 })).ok).toBe(true);
    const second = await rejectDraft(db, DRAFT_ID, { expectedVersion: 2 });
    expect(second.ok).toBe(false);
    expect(draftRow(fake).status).toBe("approved");
    expect(draftRow(fake).rejected_at).toBeNull();
  });

  it("fails closed for a missing draft and for an invalid expected version", async () => {
    const { db } = setup();
    expect(await approveDraft(db, "missing", { expectedVersion: 2 })).toEqual({ ok: false, message: "Draft not found." });
    expect((await approveDraft(db, DRAFT_ID, { expectedVersion: 0 })).ok).toBe(false);
    expect((await rejectDraft(db, DRAFT_ID, { expectedVersion: 1.5 })).ok).toBe(false);
  });

  it("legacy callers without expectedVersion keep their exact current behavior", async () => {
    const { fake, db } = setup();
    // Any version is approvable while pending_approval — unchanged.
    expect(await approveDraft(db, DRAFT_ID)).toEqual({ ok: true });
    expect(draftRow(fake).status).toBe("approved");
    // Same status-guard message as before for a non-pending draft.
    expect(await rejectDraft(db, DRAFT_ID)).toEqual({
      ok: false,
      message: 'Draft is in status "approved" and cannot be rejected.',
    });
    expect(await approveDraft(db, "missing")).toEqual({ ok: false, message: "Draft not found." });
  });
});

/** Runs a side effect (simulating a concurrent human decision) the moment the Executor is called, then delegates. */
class InterleavingAiClient extends ScriptedAiClient {
  constructor(
    private onExecutor: () => Promise<void>,
    outputs: ConstructorParameters<typeof ScriptedAiClient>[1]
  ) {
    super([], outputs);
  }

  override async runExecutor(input: ExecutorCallInput): Promise<ExecutorCallResult> {
    await this.onExecutor();
    return super.runExecutor(input);
  }
}

describe("requestRevision with expectedVersion", () => {
  it("revises when the draft is still at the expected version", async () => {
    const { fake, db } = setup();
    const aiClient = new ScriptedAiClient([], [carouselExecutorOutput({ hook: "Hook v3" })]);

    const outcome = await requestRevision({ db, aiClient, draftId: DRAFT_ID, category: "other", note: "Cambia el hook", expectedVersion: 2 });

    expect(outcome.status).toBe("revised");
    expect(outcome.draft?.version).toBe(3);
    expect(draftRow(fake).version).toBe(3);
    expect(draftRow(fake).status).toBe("pending_approval");
    const revisions = fake.getAll("content_revisions");
    expect(revisions).toHaveLength(1);
    expect(revisions[0].version).toBe(3);
    expect(revisions[0].feedback_note).toBe("Cambia el hook");
  });

  it("a stale version cannot request a revision — refused before any lock or AI spend", async () => {
    const { fake, db } = setup();
    const aiClient = new ScriptedAiClient([], [carouselExecutorOutput()]);

    const outcome = await requestRevision({ db, aiClient, draftId: DRAFT_ID, category: "other", note: "for v1", expectedVersion: 1 });

    expect(outcome.status).toBe("failed");
    expect(outcome.staleVersion).toBe(true);
    expect(aiClient.executorCalls).toHaveLength(0);
    expect(fake.getAll("agent_runs")).toHaveLength(0);
    expect(fake.getAll("content_revisions")).toHaveLength(0);
    expect(draftRow(fake).version).toBe(2);
  });

  it("discards the revision when the draft is approved while the Executor is running — never overwrites the approval", async () => {
    const { fake, db } = setup();
    const aiClient = new InterleavingAiClient(
      async () => {
        expect((await approveDraft(db, DRAFT_ID, { expectedVersion: 2 })).ok).toBe(true);
      },
      [carouselExecutorOutput({ hook: "Hook v3" })]
    );

    const outcome = await requestRevision({ db, aiClient, draftId: DRAFT_ID, category: "other", note: "x", expectedVersion: 2 });

    expect(outcome.status).toBe("failed");
    expect(outcome.staleVersion).toBe(true);
    expect(draftRow(fake).status).toBe("approved");
    expect(draftRow(fake).version).toBe(2);
    expect(draftRow(fake).hook).toBe("Hook v2");
    // No orphan history row for a version that never materialized.
    expect(fake.getAll("content_revisions")).toHaveLength(0);
    // The brand lock taken for this revision is released.
    expect(fake.getAll("agent_runs").every((r) => r.status !== "running")).toBe(true);
  });

  it("dismisses a factual-gap question raised for a draft that was decided mid-generation, leaving the decision intact", async () => {
    const { fake, db } = setup();
    const aiClient = new InterleavingAiClient(
      async () => {
        expect((await rejectDraft(db, DRAFT_ID, { expectedVersion: 2 })).ok).toBe(true);
      },
      [carouselExecutorOutput({ unresolvedFactualGap: { question: "¿Precio exacto?", reason: "No está en BRAND.md" } })]
    );

    const outcome = await requestRevision({ db, aiClient, draftId: DRAFT_ID, category: "other", note: "x", expectedVersion: 2 });

    expect(outcome.status).toBe("failed");
    expect(outcome.staleVersion).toBe(true);
    expect(draftRow(fake).status).toBe("rejected");
    expect(draftRow(fake).blocked_on_question_id).toBeNull();
    const questions = fake.getAll("agent_questions");
    expect(questions).toHaveLength(1);
    expect(questions[0].status).toBe("dismissed");
  });

  it("legacy callers without expectedVersion still revise whatever version is pending", async () => {
    const { fake, db } = setup();
    const aiClient = new ScriptedAiClient([], [carouselExecutorOutput({ hook: "Hook v3" })]);

    const outcome = await requestRevision({ db, aiClient, draftId: DRAFT_ID, category: "weak_hook", note: null });

    expect(outcome.status).toBe("revised");
    expect(outcome.staleVersion).toBeUndefined();
    expect(draftRow(fake).version).toBe(3);
    expect(fake.getAll("content_revisions")).toHaveLength(1);
  });
});
