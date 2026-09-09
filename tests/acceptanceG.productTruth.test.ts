import { describe, it, expect } from "vitest";
import { runMarketingCycle } from "@/lib/agent/runtime";
import { scanTextForProductTruthViolations } from "@/lib/agent/productTruth";
import { validateDraft } from "@/lib/agent/draftValidator";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { seedDefaultSettings } from "@/tests/support/seed";
import { ScriptedAiClient, createPlanOutput, carouselExecutorOutput } from "@/tests/support/fakeAiClient";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

// Spec acceptance test G: an unsupported claim must never be presented as
// fact. The Draft Validator's deterministic Product Truth scan must catch
// it even if the model ignored its instructions, and the runtime must
// either retry to a safe version or escalate to a human question — never
// silently ship the fabrication.

describe("Acceptance G — Product Truth", () => {
  it("flags fabricated testimonials and unavailable-capability claims deterministically", () => {
    const violations = scanTextForProductTruthViolations(
      "Nuestros clientes reportan resultados increíbles. Ahora con CRM avanzado y seguimiento automático por WhatsApp."
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.category === "fabrication")).toBe(true);
    expect(violations.some((v) => v.category === "unavailable_capability")).toBe(true);
  });

  it("rejects a draft containing an unsupported claim at the validator level", () => {
    const brief = {
      purpose: "education",
      channel: "instagram" as const,
      format: "carousel" as const,
      topic: "topic",
      audience: "aud",
      cta: "cta",
      targetDate: "2026-09-12",
    };
    const bad = carouselExecutorOutput({
      caption: "Nuestros clientes reportan un aumento de ventas garantizado con SolarDesk.",
    });
    const result = validateDraft(bad, brief);
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("recovers via retry when the first Executor attempt violates Product Truth", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const badOutput = carouselExecutorOutput({
      caption: "Nuestros clientes reportan un aumento de ventas garantizado.",
    });
    const goodOutput = carouselExecutorOutput();

    const aiClient = new ScriptedAiClient([createPlanOutput()], [badOutput, goodOutput]);

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(run.status).toBe("completed");
    expect(aiClient.executorCalls.length).toBe(2);
    const drafts = fake.getAll("content_drafts");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].caption).not.toMatch(/garantizado/i);
  });

  it("escalates to a human question instead of fabricating when the Executor cannot verify a fact", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const gapOutput = carouselExecutorOutput({
      unresolvedFactualGap: {
        question: "What is the current promotional PRO price and its expiry date?",
        reason: "BRAND.md marks the promotion end date as unconfirmed and the piece requires it.",
      },
    });

    const aiClient = new ScriptedAiClient([createPlanOutput()], [gapOutput]);

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(run.status).toBe("completed");
    // No fabricated content ships — but the blocked brief itself is
    // persisted (status "draft", not "pending_approval") so answering
    // the question can resume it later instead of losing it silently.
    const drafts = fake.getAll("content_drafts");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe("draft");

    const questions = fake.getAll("agent_questions");
    expect(questions).toHaveLength(1);
    expect(questions[0].question).toMatch(/promotional PRO price/i);
    expect(questions[0].context_draft_id).toBe(drafts[0].id);
    expect(drafts[0].blocked_on_question_id).toBe(questions[0].id);
  });
});
