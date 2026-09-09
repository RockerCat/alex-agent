import { describe, it, expect } from "vitest";
import { runMarketingCycle } from "@/lib/agent/runtime";
import { answerQuestion } from "@/lib/agent/questions";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { seedDefaultSettings } from "@/tests/support/seed";
import { ScriptedAiClient, createPlanOutput, carouselExecutorOutput } from "@/tests/support/fakeAiClient";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

// Live-discovered gap: a Planner-proposed brief that the Executor could
// not complete without a fact only Alex has must not be silently lost.
// Answering the resulting question must resume that exact brief and
// eventually produce its draft — without a second "Run Marketing Cycle"
// click, and without duplicating the drafts that succeeded on the first
// pass.

describe("Resume a blocked brief after its human question is answered", () => {
  it("persists the blocked brief, then completes it as soon as the question is answered", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const planOutput = createPlanOutput({
      content: [
        {
          purpose: "education",
          channel: "instagram",
          format: "carousel",
          topic: "Cómo compartir tu propuesta con un cliente",
          audience: "Instaladores",
          cta: "Comparte tu propuesta",
          targetDate: "2026-09-12",
        },
        {
          purpose: "activation",
          channel: "instagram",
          format: "carousel",
          topic: "Comienza gratis en SolarDesk",
          audience: "Instaladores",
          cta: "Comenzar gratis",
          targetDate: "2026-09-13",
        },
      ],
    });

    const okOutput = carouselExecutorOutput();
    const gapOutput = carouselExecutorOutput({
      unresolvedFactualGap: {
        question: "¿Debe el CTA enlazar directamente a la página de registro y cuál es la URL vigente para Instagram?",
        reason: "BRAND.md no confirma el destino exacto del CTA para este flujo.",
      },
    });

    const aiClient = new ScriptedAiClient([planOutput], [okOutput, gapOutput]);

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });
    expect(run.status).toBe("completed");
    expect(run.decision).toBe("CREATE_PLAN");

    // Exactly the reported live shape: 1 pending draft, 1 blocked
    // placeholder draft, 1 open question linking to it.
    const drafts = fake.getAll("content_drafts");
    expect(drafts).toHaveLength(2);
    const pending = drafts.filter((d) => d.status === "pending_approval");
    const blocked = drafts.filter((d) => d.status === "draft");
    expect(pending).toHaveLength(1);
    expect(blocked).toHaveLength(1);

    const blockedDraft = blocked[0];
    expect(blockedDraft.topic).toBe("Comienza gratis en SolarDesk");
    expect(blockedDraft.channel).toBe("instagram");
    expect(blockedDraft.version).toBe(0);

    const questions = fake.getAll("agent_questions");
    expect(questions).toHaveLength(1);
    expect(questions[0].status).toBe("open");
    expect(questions[0].context_draft_id).toBe(blockedDraft.id);
    expect(blockedDraft.blocked_on_question_id).toBe(questions[0].id);

    // Alex answers the question — this alone must resume the blocked
    // brief, with no further "Run Marketing Cycle" click.
    const resolvedOutput = carouselExecutorOutput({
      title: "Comienza gratis en SolarDesk",
      caption: "Sí, el CTA dirige directamente al registro.",
    });
    const answerAiClient = new ScriptedAiClient([], [resolvedOutput]);

    const answerOutcome = await answerQuestion({
      db,
      aiClient: answerAiClient,
      questionId: questions[0].id as string,
      answer: 'Sí. El CTA "Comenzar gratis" debe dirigir directamente a la página de registro. La URL vigente es: https://solardesk.co/register',
    });

    expect(answerOutcome.ok).toBe(true);
    expect(answerOutcome.resumed?.status).toBe("revised");
    expect(answerOutcome.resumed?.draft?.status).toBe("pending_approval");
    expect(answerOutcome.resumed?.draft?.version).toBe(1);
    expect(answerOutcome.resumed?.draft?.caption).toContain("registro");

    const finalDrafts = fake.getAll("content_drafts");
    expect(finalDrafts).toHaveLength(2);
    expect(finalDrafts.every((d) => d.status === "pending_approval")).toBe(true);

    const finalQuestions = fake.getAll("agent_questions");
    expect(finalQuestions[0].status).toBe("answered");

    // The revision history for the resumed draft starts at v1 (this was
    // its first-ever generated content, not a "second" version).
    const revisions = fake.getAll("content_revisions").filter((r) => r.draft_id === blockedDraft.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].version).toBe(1);
  });

  it("re-running the marketing cycle after the answer sees 2 healthy pending drafts, not a phantom 3rd/4th brief", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const planOutput = createPlanOutput({
      content: [
        {
          purpose: "education",
          channel: "instagram",
          format: "carousel",
          topic: "Topic A",
          audience: "aud",
          cta: "cta",
          targetDate: "2026-09-12",
        },
        {
          purpose: "activation",
          channel: "instagram",
          format: "carousel",
          topic: "Topic B",
          audience: "aud",
          cta: "cta",
          targetDate: "2026-09-13",
        },
      ],
    });
    const gapOutput = carouselExecutorOutput({
      unresolvedFactualGap: { question: "q?", reason: "unknown" },
    });

    const aiClient = new ScriptedAiClient([planOutput], [carouselExecutorOutput(), gapOutput]);
    await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    const question = fake.getAll("agent_questions")[0];
    const resumeAiClient = new ScriptedAiClient([], [carouselExecutorOutput({ title: "Topic B resolved" })]);
    await answerQuestion({ db, aiClient: resumeAiClient, questionId: question.id as string, answer: "answer" });

    // Now click "Run Marketing Cycle" again with no instructions.
    const secondAiClient = new ScriptedAiClient([], []);
    const { run } = await runMarketingCycle({ db, aiClient: secondAiClient, brand: "solardesk" });

    expect(run.status).toBe("skipped");
    expect(run.decision).toBe("WAIT_FOR_APPROVAL");
    expect(run.summary).toContain("2 draft(s)");
    expect(secondAiClient.plannerCalls).toHaveLength(0);
    expect(fake.getAll("content_drafts").filter((d) => d.status === "pending_approval")).toHaveLength(2);
  });
});
