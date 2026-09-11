import { describe, it, expect } from "vitest";
import { requestAssetChanges } from "@/lib/agent/assetRevision";
import { generateAsset, approveAsset } from "@/lib/agent/assetGenerator";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { FakeAssetStorage } from "@/tests/support/fakeAssetStorage";
import { ScriptedAiClient, feedbackInterpretation } from "@/tests/support/fakeAiClient";
import { seedDefaultSettings } from "@/tests/support/seed";
import { DEFAULT_RENDER_SPEC, type AssetRenderSpec } from "@/lib/agent/schemas";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentDraftRow } from "@/lib/types/database";

// AlexAgent v0.2 — asset feedback / "Request Changes". Alex gives free
// natural-language visual feedback on the current image_post asset;
// the bounded feedback interpreter turns it into a validated
// AssetRenderSpec, and the deterministic renderer applies it to
// produce the next asset version. Behavioral tests only — the
// renderer's own pixel output is covered by tests/assetRenderer.test.ts.

const PLAN_ID = "plan-1";

function seedPlan(fake: ReturnType<typeof createFakeDb>) {
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

function seedDraft(fake: ReturnType<typeof createFakeDb>, id: string, overrides: Partial<ContentDraftRow> = {}) {
  const row = {
    id,
    plan_id: PLAN_ID,
    brand: "solardesk",
    created_by_run: null,
    channel: "instagram" as const,
    content_type: "image_post" as const,
    purpose: "activation",
    topic: "El resultado: una propuesta profesional para tu cliente",
    audience: "Instaladores",
    cta: "Comenzar gratis",
    target_date: "2026-09-12",
    status: "approved" as const,
    version: 1,
    title: "De la cotización a una propuesta lista para presentar",
    hook: "De la cotización a una propuesta lista para presentar",
    body: { slides: [] },
    caption: "Cotiza proyectos solares y presenta propuestas profesionales con la marca de tu empresa.",
    cta_text: "Crea tu primera propuesta",
    visual_direction: "Muestra la propuesta final en PDF que SolarDesk entrega al cliente, lista para presentar.",
    hashtags: ["#energiasolar", "#solardesk"],
    created_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    ...overrides,
  };
  fake.seed("content_drafts", [row]);
  return row;
}

function largerProposalSpec(overrides: Partial<AssetRenderSpec> = {}): AssetRenderSpec {
  return { ...DEFAULT_RENDER_SPEC, primaryVisualScale: "large", ctaEmphasis: "subtle", ...overrides };
}

function setup() {
  const fake = createFakeDb();
  seedPlan(fake);
  seedDefaultSettings(fake);
  const db = asSupabaseClient<SupabaseClient<Database>>(fake);
  const storage = new FakeAssetStorage();
  return { fake, db, storage };
}

async function seedApprovedAsset(fake: ReturnType<typeof createFakeDb>, db: SupabaseClient<Database>, storage: FakeAssetStorage, draftId: string) {
  const generated = await generateAsset({ db, storage, draftId });
  const approved = await approveAsset(db, generated.asset!.id);
  return approved.asset!;
}

describe("requestAssetChanges — feedback interpretation and revision", () => {
  it("1/2. feedback asking for a larger proposal is converted into a validated spec with primaryVisualScale changed", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    await generateAsset({ db, storage, draftId: "draft-1" });
    const aiClient = new ScriptedAiClient([], [], [feedbackInterpretation(largerProposalSpec())]);

    const outcome = await requestAssetChanges({
      db,
      storage,
      aiClient,
      draftId: "draft-1",
      feedback: "Haz la propuesta un poco más grande.",
    });

    expect(outcome.status).toBe("success");
    const spec = (outcome.asset!.render_provenance as Record<string, unknown>).renderSpec as AssetRenderSpec;
    expect(spec.primaryVisualScale).toBe("large");
  });

  it("3. feedback asking to reduce CTA prominence changes ctaEmphasis", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    await generateAsset({ db, storage, draftId: "draft-1" });
    const aiClient = new ScriptedAiClient([], [], [feedbackInterpretation({ ...DEFAULT_RENDER_SPEC, ctaEmphasis: "subtle" })]);

    const outcome = await requestAssetChanges({
      db,
      storage,
      aiClient,
      draftId: "draft-1",
      feedback: "Reduce el protagonismo del CTA.",
    });

    expect(outcome.status).toBe("success");
    const spec = (outcome.asset!.render_provenance as Record<string, unknown>).renderSpec as AssetRenderSpec;
    expect(spec.ctaEmphasis).toBe("subtle");
  });

  it("4. the renderer actually honors the resulting spec — output differs from the pre-feedback asset", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    const first = await generateAsset({ db, storage, draftId: "draft-1" });
    const aiClient = new ScriptedAiClient([], [], [feedbackInterpretation(largerProposalSpec())]);

    const outcome = await requestAssetChanges({ db, storage, aiClient, draftId: "draft-1", feedback: "Hazla más grande." });

    const beforeBuf = storage.files.get(first.asset!.storage_path!)!;
    const afterBuf = storage.files.get(outcome.asset!.storage_path!)!;
    expect(Buffer.compare(beforeBuf, afterBuf)).not.toBe(0);
  });

  it("5/6/7. a successful revision creates the next pending_review version and leaves the previous version row untouched", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    const first = await generateAsset({ db, storage, draftId: "draft-1" });
    const beforeRow = { ...fake.getAll("content_assets").find((r) => r.id === first.asset!.id) };
    const aiClient = new ScriptedAiClient([], [], [feedbackInterpretation(largerProposalSpec())]);

    const outcome = await requestAssetChanges({ db, storage, aiClient, draftId: "draft-1", feedback: "Hazla más grande." });

    expect(outcome.status).toBe("success");
    expect(outcome.asset?.asset_version).toBe(2);
    expect(outcome.asset?.status).toBe("pending_review");

    const afterRow = fake.getAll("content_assets").find((r) => r.id === first.asset!.id);
    expect(afterRow).toEqual(beforeRow);
  });

  it("8/9/10. feedback text, the validated spec, and the source version are all persisted in provenance", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    await generateAsset({ db, storage, draftId: "draft-1" });
    const aiClient = new ScriptedAiClient([], [], [feedbackInterpretation(largerProposalSpec())]);

    const outcome = await requestAssetChanges({
      db,
      storage,
      aiClient,
      draftId: "draft-1",
      feedback: "Haz la propuesta un poco más grande y reduce el protagonismo del CTA.",
    });

    const provenance = outcome.asset!.render_provenance as Record<string, unknown>;
    const feedbackRecord = provenance.feedback as { text: string; revisedFromVersion: number; revisedFromStatus: string };
    expect(feedbackRecord.text).toBe("Haz la propuesta un poco más grande y reduce el protagonismo del CTA.");
    expect(feedbackRecord.revisedFromVersion).toBe(1);
    expect(feedbackRecord.revisedFromStatus).toBe("pending_review");
    expect(provenance.renderSpec).toEqual(largerProposalSpec());
  });

  it("11. an already-approved (ready_to_publish) asset can be revised without losing its historical approved status", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    const approved = await seedApprovedAsset(fake, db, storage, "draft-1");
    const aiClient = new ScriptedAiClient([], [], [feedbackInterpretation(largerProposalSpec())]);

    const outcome = await requestAssetChanges({ db, storage, aiClient, draftId: "draft-1", feedback: "Hazla más grande." });

    expect(outcome.status).toBe("success");
    expect(outcome.asset?.status).toBe("pending_review");
    expect(outcome.asset?.asset_version).toBe(2);

    const approvedRowAfter = fake.getAll("content_assets").find((r) => r.id === approved.id);
    expect(approvedRowAfter?.status).toBe("ready_to_publish");
    expect(approvedRowAfter?.approved_at).toBe(approved.approved_at);
  });

  it("12/15. the approved content draft is never mutated by a revision", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    await generateAsset({ db, storage, draftId: "draft-1" });
    const before = { ...fake.getAll("content_drafts").find((d) => d.id === "draft-1") };
    const aiClient = new ScriptedAiClient([], [], [feedbackInterpretation(largerProposalSpec())]);

    await requestAssetChanges({ db, storage, aiClient, draftId: "draft-1", feedback: "Hazla más grande." });

    const after = fake.getAll("content_drafts").find((d) => d.id === "draft-1");
    expect(after).toEqual(before);
  });

  it("13. feedback asking for a new/unsupported factual claim cannot alter the draft's approved marketing claims", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    await generateAsset({ db, storage, draftId: "draft-1" });
    const before = { ...fake.getAll("content_drafts").find((d) => d.id === "draft-1") };
    // The interpreter's schema has no field for claims/text at all — the
    // model can only ever return bounded enum values regardless of what
    // the feedback asks for. Scripting a "nothing applicable, report it
    // unsupported" response simulates the required behavior for a purely
    // factual request; the assertion that matters is that the draft's
    // approved text never changes no matter what the feedback says, and
    // the fabricated claim is never rendered or persisted anywhere.
    const aiClient = new ScriptedAiClient(
      [],
      [],
      [feedbackInterpretation(DEFAULT_RENDER_SPEC, { appliedChanges: [], unsupportedRequests: ["Agregar la afirmación de garantía de ahorro del 30%"] })]
    );

    const outcome = await requestAssetChanges({
      db,
      storage,
      aiClient,
      draftId: "draft-1",
      feedback: "Pon que SolarDesk garantiza 30% de ahorro.",
    });

    expect(outcome.status).toBe("no_applicable_changes");
    expect(outcome.interpretation?.appliedChanges).toEqual([]);
    expect(outcome.interpretation?.unsupportedRequests).toHaveLength(1);
    const after = fake.getAll("content_drafts").find((d) => d.id === "draft-1");
    expect(after).toEqual(before);
    expect(after?.hook).toBe(before.hook);
    expect(after?.cta_text).toBe(before.cta_text);
    expect(after?.visual_direction).toBe(before.visual_direction);
    // No new content_assets row/version was created either — only the
    // original generateAsset row exists.
    expect(fake.getAll("content_assets")).toHaveLength(1);
  });

  it("13a. mixed supported + unsupported feedback (larger proposal + custom shadow) applies the supported part, creates the next version, and persists both summaries", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    await generateAsset({ db, storage, draftId: "draft-1" });
    const aiClient = new ScriptedAiClient(
      [],
      [],
      [
        feedbackInterpretation(largerProposalSpec(), {
          appliedChanges: ["Aumentar el protagonismo de la propuesta"],
          unsupportedRequests: ["Agregar una sombra personalizada entre las páginas"],
        }),
      ]
    );

    const outcome = await requestAssetChanges({
      db,
      storage,
      aiClient,
      draftId: "draft-1",
      feedback: "Haz la propuesta más grande y agrega una sombra entre las páginas.",
    });

    expect(outcome.status).toBe("success");
    expect(outcome.asset?.asset_version).toBe(2);
    expect(outcome.asset?.status).toBe("pending_review");
    expect(outcome.interpretation?.appliedChanges).toEqual(["Aumentar el protagonismo de la propuesta"]);
    expect(outcome.interpretation?.unsupportedRequests).toEqual(["Agregar una sombra personalizada entre las páginas"]);

    const spec = (outcome.asset!.render_provenance as Record<string, unknown>).renderSpec as AssetRenderSpec;
    expect(spec.primaryVisualScale).toBe("large");

    const provenance = outcome.asset!.render_provenance as Record<string, unknown>;
    const feedbackRecord = provenance.feedback as { appliedChanges: string[]; unsupportedRequests: string[] };
    expect(feedbackRecord.appliedChanges).toEqual(["Aumentar el protagonismo de la propuesta"]);
    expect(feedbackRecord.unsupportedRequests).toEqual(["Agregar una sombra personalizada entre las páginas"]);
  });

  it("13b. a custom-shadow-only request is reported unsupported, never modifies AssetRenderSpec, never creates a new asset version, and never uploads a new Storage object — but still records model usage", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    const first = await generateAsset({ db, storage, draftId: "draft-1" });
    const storageSizeBefore = storage.files.size;
    const aiClient = new ScriptedAiClient(
      [],
      [],
      [feedbackInterpretation(DEFAULT_RENDER_SPEC, { appliedChanges: [], unsupportedRequests: ["Agregar una sombra más fuerte a las páginas"] })]
    );

    const outcome = await requestAssetChanges({
      db,
      storage,
      aiClient,
      draftId: "draft-1",
      feedback: "Ponle una sombra más fuerte a las páginas.",
    });

    expect(outcome.status).toBe("no_applicable_changes");
    expect(outcome.asset).toBeUndefined();
    expect(outcome.interpretation?.appliedChanges).toEqual([]);
    expect(outcome.interpretation?.unsupportedRequests).toEqual(["Agregar una sombra más fuerte a las páginas"]);

    // No new content_assets row (of any status) was created — only the original.
    const rows = fake.getAll("content_assets");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.asset!.id);

    // No new Storage object was uploaded.
    expect(storage.files.size).toBe(storageSizeBefore);

    // The OpenAI call happened, so usage is still recorded.
    const usage = fake.getAll("ai_usage");
    expect(usage).toHaveLength(1);
    expect(usage[0].operation).toBe("executor");
  });

  it("14. the interpreter cannot select an arbitrary filesystem path or asset — its schema has no such field", async () => {
    const { assetRenderSpecSchema } = await import("@/lib/agent/schemas");
    const attempt = assetRenderSpecSchema.safeParse({
      ...DEFAULT_RENDER_SPEC,
      screenshotFile: "../../etc/passwd",
    });
    // Zod strips/rejects unknown behavior aside — the field simply isn't
    // part of the type, so nothing downstream can ever read a
    // model-supplied path. Valid known fields still parse fine.
    expect(attempt.success).toBe(true);
    expect((attempt as { success: true; data: AssetRenderSpec }).data).not.toHaveProperty("screenshotFile");

    const invalidEnum = assetRenderSpecSchema.safeParse({ ...DEFAULT_RENDER_SPEC, primaryVisualScale: "gigantic" });
    expect(invalidEnum.success).toBe(false);
  });

  it("14a. the interpreter result schema bounds appliedChanges/unsupportedRequests — no arbitrary-length text or arbitrary field injection can reach renderSpec", async () => {
    const {
      assetFeedbackInterpretationSchema,
      ASSET_FEEDBACK_SUMMARY_MAX_LENGTH,
      ASSET_FEEDBACK_SUMMARY_MAX_ITEMS,
    } = await import("@/lib/agent/schemas");

    const valid = assetFeedbackInterpretationSchema.safeParse({
      renderSpec: DEFAULT_RENDER_SPEC,
      appliedChanges: ["Aumentar el protagonismo de la propuesta"],
      unsupportedRequests: ["Agregar una sombra personalizada"],
    });
    expect(valid.success).toBe(true);

    // A summary string over the length cap is rejected — this is what
    // keeps these explanatory fields from becoming a place to smuggle
    // arbitrary long text (instructions, copy, markup) past the schema.
    const tooLong = assetFeedbackInterpretationSchema.safeParse({
      renderSpec: DEFAULT_RENDER_SPEC,
      appliedChanges: ["x".repeat(ASSET_FEEDBACK_SUMMARY_MAX_LENGTH + 1)],
      unsupportedRequests: [],
    });
    expect(tooLong.success).toBe(false);

    // More entries than the cap is rejected.
    const tooMany = assetFeedbackInterpretationSchema.safeParse({
      renderSpec: DEFAULT_RENDER_SPEC,
      appliedChanges: [],
      unsupportedRequests: Array.from({ length: ASSET_FEEDBACK_SUMMARY_MAX_ITEMS + 1 }, (_, i) => `item ${i}`),
    });
    expect(tooMany.success).toBe(false);

    // renderSpec itself is still the same bounded enum schema — no new
    // field (e.g. a shadow control, a color, a file path) can be smuggled
    // onto it via this wrapper.
    const attempt = assetFeedbackInterpretationSchema.safeParse({
      renderSpec: { ...DEFAULT_RENDER_SPEC, shadow: "strong", customCss: "box-shadow: 0 0 10px" },
      appliedChanges: [],
      unsupportedRequests: [],
    });
    expect(attempt.success).toBe(true);
    expect((attempt as { success: true; data: { renderSpec: AssetRenderSpec } }).data.renderSpec).not.toHaveProperty("shadow");
    expect((attempt as { success: true; data: { renderSpec: AssetRenderSpec } }).data.renderSpec).not.toHaveProperty("customCss");
  });

  it("16. proposal-example rendering still works end-to-end through a revision", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1"); // visual_direction asks to show the client-facing PDF
    await generateAsset({ db, storage, draftId: "draft-1" });
    const aiClient = new ScriptedAiClient([], [], [feedbackInterpretation(largerProposalSpec())]);

    const outcome = await requestAssetChanges({ db, storage, aiClient, draftId: "draft-1", feedback: "Hazla más grande." });

    const provenance = outcome.asset!.render_provenance as Record<string, unknown>;
    expect((provenance.proposalExample as { selected: boolean }).selected).toBe(true);
    expect(outcome.asset?.width).toBe(1080);
    expect(outcome.asset?.height).toBe(1350);
  });

  it("17. product-screenshot rendering still works end-to-end through a revision", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1", {
      visual_direction: "Mockup B2B SaaS mostrando la experiencia de propuestas de SolarDesk.",
      topic: "Gestiona tus propuestas solares",
    });
    await generateAsset({ db, storage, draftId: "draft-1" });
    const aiClient = new ScriptedAiClient([], [], [feedbackInterpretation({ ...DEFAULT_RENDER_SPEC, logoEmphasis: "strong" })]);

    const outcome = await requestAssetChanges({ db, storage, aiClient, draftId: "draft-1", feedback: "Haz el logo más visible." });

    const provenance = outcome.asset!.render_provenance as Record<string, unknown>;
    expect((provenance.screenshot as { selected: boolean; file: string }).selected).toBe(true);
    expect((provenance.screenshot as { selected: boolean; file: string }).file).toBe("04.png");
  });

  it("18. the text-only fallback still works end-to-end through a revision", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1", { visual_direction: "SaaS B2B limpio, azul oscuro y ámbar.", topic: "Comienza gratis en SolarDesk" });
    await generateAsset({ db, storage, draftId: "draft-1" });
    const aiClient = new ScriptedAiClient([], [], [feedbackInterpretation({ ...DEFAULT_RENDER_SPEC, logoEmphasis: "strong" })]);

    const outcome = await requestAssetChanges({ db, storage, aiClient, draftId: "draft-1", feedback: "Haz el logo más visible." });

    const provenance = outcome.asset!.render_provenance as Record<string, unknown>;
    expect(provenance.renderer).toBe("svg-sharp-v1");
  });

  it("19/21. budget exhaustion blocks the call before it happens and does not create a generated asset", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    await generateAsset({ db, storage, draftId: "draft-1" });
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
    const aiClient = new ScriptedAiClient([], [], [feedbackInterpretation(largerProposalSpec())]);

    const outcome = await requestAssetChanges({ db, storage, aiClient, draftId: "draft-1", feedback: "Hazla más grande." });

    expect(outcome.status).toBe("failed");
    expect(outcome.budgetBlocked).toBe(true);
    expect(aiClient.assetFeedbackCalls).toHaveLength(0);
    expect(fake.getAll("content_assets")).toHaveLength(1); // only the original generateAsset row
  });

  it("20. usage is recorded for a successful feedback-interpretation call", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    await generateAsset({ db, storage, draftId: "draft-1" });
    const aiClient = new ScriptedAiClient([], [], [feedbackInterpretation(largerProposalSpec())]);

    await requestAssetChanges({ db, storage, aiClient, draftId: "draft-1", feedback: "Hazla más grande." });

    const usage = fake.getAll("ai_usage");
    expect(usage).toHaveLength(1);
    expect(usage[0].operation).toBe("executor");
  });

  it("22. an incomplete/structured-output failure records a generation_failed row and never corrupts the prior asset", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    const first = await generateAsset({ db, storage, draftId: "draft-1" });
    const beforeRow = { ...fake.getAll("content_assets").find((r) => r.id === first.asset!.id) };
    const aiClient = new ScriptedAiClient([], [], []);
    aiClient.incompleteAssetFeedbackReasons = ["max_output_tokens"];

    const outcome = await requestAssetChanges({ db, storage, aiClient, draftId: "draft-1", feedback: "Hazla más grande." });

    expect(outcome.status).toBe("failed");
    expect(outcome.asset?.status).toBe("generation_failed");
    const afterFirstRow = fake.getAll("content_assets").find((r) => r.id === first.asset!.id);
    expect(afterFirstRow).toEqual(beforeRow);
  });

  it("23. a storage upload failure records a generation_failed row and never corrupts the prior asset", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    const first = await generateAsset({ db, storage, draftId: "draft-1" });
    const beforeRow = { ...fake.getAll("content_assets").find((r) => r.id === first.asset!.id) };
    storage.failNextUpload = true;
    const aiClient = new ScriptedAiClient([], [], [feedbackInterpretation(largerProposalSpec())]);

    const outcome = await requestAssetChanges({ db, storage, aiClient, draftId: "draft-1", feedback: "Hazla más grande." });

    expect(outcome.status).toBe("failed");
    expect(outcome.asset?.status).toBe("generation_failed");
    const afterFirstRow = fake.getAll("content_assets").find((r) => r.id === first.asset!.id);
    expect(afterFirstRow).toEqual(beforeRow);
  });

  it("24. concurrent revision requests for the same draft are handled safely — only one next version is ever persisted", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    await generateAsset({ db, storage, draftId: "draft-1" });
    const aiClientA = new ScriptedAiClient([], [], [feedbackInterpretation(largerProposalSpec())]);
    const aiClientB = new ScriptedAiClient([], [], [feedbackInterpretation(largerProposalSpec({ ctaEmphasis: "strong" }))]);

    const [a, b] = await Promise.all([
      requestAssetChanges({ db, storage, aiClient: aiClientA, draftId: "draft-1", feedback: "Hazla más grande." }),
      requestAssetChanges({ db, storage, aiClient: aiClientB, draftId: "draft-1", feedback: "Haz el CTA más fuerte." }),
    ]);

    const outcomes = [a, b];
    const successes = outcomes.filter((o) => o.status === "success");
    const concurrentRejections = outcomes.filter((o) => o.status === "concurrent");
    expect(successes.length + concurrentRejections.length).toBe(2);

    const versionTwos = fake.getAll("content_assets").filter((r) => r.asset_version === 2);
    expect(versionTwos).toHaveLength(1);
  });

  it("25. existing Approve Asset behavior still works after this feature", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    const generated = await generateAsset({ db, storage, draftId: "draft-1" });

    const approved = await approveAsset(db, generated.asset!.id);

    expect(approved.ok).toBe(true);
    expect(approved.asset?.status).toBe("ready_to_publish");
  });

  it("26. existing Regenerate behavior still works and now carries the current effective spec forward", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    await generateAsset({ db, storage, draftId: "draft-1" });
    const aiClient = new ScriptedAiClient([], [], [feedbackInterpretation(largerProposalSpec())]);
    const revised = await requestAssetChanges({ db, storage, aiClient, draftId: "draft-1", feedback: "Hazla más grande." });
    expect(revised.status).toBe("success");

    // Plain Regenerate (no feedback) — no AI call, no budget guard involved.
    const regenerated = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(regenerated.status).toBe("success");
    expect(regenerated.asset?.asset_version).toBe(3);
    const spec = (regenerated.asset!.render_provenance as Record<string, unknown>).renderSpec as AssetRenderSpec;
    expect(spec.primaryVisualScale).toBe("large"); // carried forward from the v2 revision, not reset to default
  });

  it("ineligible: feedback that is too short is rejected without calling the model", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    await generateAsset({ db, storage, draftId: "draft-1" });
    const aiClient = new ScriptedAiClient([], [], [feedbackInterpretation(largerProposalSpec())]);

    const outcome = await requestAssetChanges({ db, storage, aiClient, draftId: "draft-1", feedback: "ok" });

    expect(outcome.status).toBe("ineligible");
    expect(aiClient.assetFeedbackCalls).toHaveLength(0);
  });

  it("ineligible: cannot request changes when no asset has ever been generated", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    const aiClient = new ScriptedAiClient([], [], [feedbackInterpretation(largerProposalSpec())]);

    const outcome = await requestAssetChanges({ db, storage, aiClient, draftId: "draft-1", feedback: "Hazla más grande." });

    expect(outcome.status).toBe("ineligible");
    expect(aiClient.assetFeedbackCalls).toHaveLength(0);
  });

  it("ineligible: cannot request changes when the latest asset is generation_failed", async () => {
    const { fake, db, storage } = setup();
    const longHeadline = "Palabra ".repeat(400).trim();
    seedDraft(fake, "draft-1", { hook: longHeadline });
    await generateAsset({ db, storage, draftId: "draft-1" }); // fails, records generation_failed
    const aiClient = new ScriptedAiClient([], [], [feedbackInterpretation(largerProposalSpec())]);

    const outcome = await requestAssetChanges({ db, storage, aiClient, draftId: "draft-1", feedback: "Hazla más grande." });

    expect(outcome.status).toBe("ineligible");
    expect(aiClient.assetFeedbackCalls).toHaveLength(0);
  });
});
