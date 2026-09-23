import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { answerQuestion } from "@/lib/agent/questions";
import { createFakeDb, asSupabaseClient, type FakeDb } from "@/tests/support/fakeDb";
import { seedDefaultSettings } from "@/tests/support/seed";
import { ScriptedAiClient } from "@/tests/support/fakeAiClient";

// A question may leave the authoritative "open" state exactly once.
// Duplicate/concurrent answers (a dashboard submit racing a future email
// reply, or a webhook retry) must never overwrite an already-recorded
// answer.

const QUESTION_ID = "q-1";

function setup(status: "open" | "answered" | "dismissed" = "open") {
  const fake = createFakeDb();
  seedDefaultSettings(fake);
  fake.seed("agent_questions", [
    {
      id: QUESTION_ID,
      brand: "solardesk",
      question: "¿Cuál es el precio del plan Pro?",
      reason: "Needed for pricing content",
      status,
      blocks_progress: true,
      answer: status === "answered" ? "Primera respuesta" : null,
      context_run_id: null,
      context_plan_id: null,
      context_draft_id: null,
      created_at: new Date().toISOString(),
      answered_at: status === "answered" ? new Date().toISOString() : null,
    },
  ]);
  return { fake, db: asSupabaseClient<SupabaseClient<Database>>(fake) };
}

function question(fake: FakeDb) {
  return fake.getAll("agent_questions")[0];
}

describe("answerQuestion — single open→answered transition", () => {
  it("answers an open question", async () => {
    const { fake, db } = setup();
    const outcome = await answerQuestion({ db, aiClient: new ScriptedAiClient(), questionId: QUESTION_ID, answer: "USD 49/mes" });
    expect(outcome).toEqual({ ok: true });
    expect(question(fake).status).toBe("answered");
    expect(question(fake).answer).toBe("USD 49/mes");
  });

  it("a sequential duplicate answer does not overwrite the first", async () => {
    const { fake, db } = setup();
    const aiClient = new ScriptedAiClient();
    expect((await answerQuestion({ db, aiClient, questionId: QUESTION_ID, answer: "Primera" })).ok).toBe(true);
    const second = await answerQuestion({ db, aiClient, questionId: QUESTION_ID, answer: "Segunda" });
    expect(second).toEqual({ ok: false, message: "Question was already answered." });
    expect(question(fake).answer).toBe("Primera");
  });

  it("concurrent answers: exactly one wins and the recorded answer is never overwritten", async () => {
    const { fake, db } = setup();
    const aiClient = new ScriptedAiClient();
    // Both calls pass the initial read before either writes — the
    // conditional UPDATE is what must decide.
    const [a, b] = await Promise.all([
      answerQuestion({ db, aiClient, questionId: QUESTION_ID, answer: "A" }),
      answerQuestion({ db, aiClient, questionId: QUESTION_ID, answer: "B" }),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    expect(question(fake).answer).toBe(a.ok ? "A" : "B");
  });

  it("does not overwrite an already-answered question", async () => {
    const { fake, db } = setup("answered");
    const outcome = await answerQuestion({ db, aiClient: new ScriptedAiClient(), questionId: QUESTION_ID, answer: "Otra" });
    expect(outcome.ok).toBe(false);
    expect(question(fake).answer).toBe("Primera respuesta");
  });

  it("refuses to answer a dismissed question", async () => {
    const { fake, db } = setup("dismissed");
    const outcome = await answerQuestion({ db, aiClient: new ScriptedAiClient(), questionId: QUESTION_ID, answer: "Tarde" });
    expect(outcome.ok).toBe(false);
    expect(question(fake).status).toBe("dismissed");
    expect(question(fake).answer).toBeNull();
  });

  it("returns not-found for an unknown question", async () => {
    const { db } = setup();
    expect(await answerQuestion({ db, aiClient: new ScriptedAiClient(), questionId: "nope", answer: "x" })).toEqual({
      ok: false,
      message: "Question not found.",
    });
  });
});
