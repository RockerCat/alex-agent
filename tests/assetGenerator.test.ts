import { describe, it, expect, beforeEach, afterEach } from "vitest";
import sharp from "sharp";
import { generateAsset, approveAsset, getLatestAsset, listAssets } from "@/lib/agent/assetGenerator";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { FakeAssetStorage } from "@/tests/support/fakeAssetStorage";
import { ScriptedAiClient, visualPlan } from "@/tests/support/fakeAiClient";
import { ScriptedImageGenerationClient, tinyPngBuffer } from "@/tests/support/fakeImageGenerationClient";
import { seedDefaultSettings } from "@/tests/support/seed";
import { getEffectiveRenderSpec } from "@/lib/agent/assetGenerator";
import { DEFAULT_RENDER_SPEC } from "@/lib/agent/schemas";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentDraftRow } from "@/lib/types/database";

// AlexAgent v0.2 — first vertical slice: manual image_post asset
// lifecycle. Behavioral tests only (no pixel-perfect screenshot
// comparisons) — the renderer's own visual output is covered by
// tests/assetRenderer.test.ts.

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

function seedDraft(
  fake: ReturnType<typeof createFakeDb>,
  id: string,
  overrides: Partial<ContentDraftRow> = {}
) {
  const row = {
    id,
    plan_id: PLAN_ID,
    brand: "solardesk",
    created_by_run: null,
    channel: "instagram" as const,
    content_type: "image_post" as const,
    purpose: "activation",
    topic: "Comienza gratis en SolarDesk",
    audience: "Instaladores",
    cta: "Comenzar gratis",
    target_date: "2026-09-12",
    status: "approved" as const,
    version: 1,
    title: "Comienza gratis en SolarDesk",
    hook: "¿Sigues armando propuestas solares en hojas de cálculo?",
    body: { slides: [] },
    caption: "Cotiza proyectos solares y presenta propuestas profesionales con la marca de tu empresa.",
    cta_text: "Crea tu primera cotización",
    visual_direction: "SaaS B2B limpio, azul oscuro y ámbar.",
    hashtags: ["#energiasolar", "#solardesk"],
    created_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    ...overrides,
  };
  fake.seed("content_drafts", [row]);
  return row;
}

function setup() {
  const fake = createFakeDb();
  seedPlan(fake);
  const db = asSupabaseClient<SupabaseClient<Database>>(fake);
  const storage = new FakeAssetStorage();
  return { fake, db, storage };
}

/** Like setup(), but also seeds agent_settings — required only by the Visual Director path (BudgetGuard.getSnapshot()), never by the no-aiClient/Regenerate paths above. */
function setupWithBudget() {
  const fake = createFakeDb();
  seedPlan(fake);
  seedDefaultSettings(fake);
  const db = asSupabaseClient<SupabaseClient<Database>>(fake);
  const storage = new FakeAssetStorage();
  return { fake, db, storage };
}

describe("generateAsset — eligibility", () => {
  it("1. an approved SolarDesk image_post can generate an asset", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(outcome.status).toBe("success");
    expect(outcome.asset?.status).toBe("pending_review");
  });

  it("2. a non-approved draft cannot generate", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1", { status: "pending_approval" });

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(outcome.status).toBe("ineligible");
    expect(fake.getAll("content_assets")).toHaveLength(0);
  });

  it("3. an unsupported format (carousel) cannot generate", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1", { content_type: "carousel" });

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(outcome.status).toBe("ineligible");
    expect(fake.getAll("content_assets")).toHaveLength(0);
  });
});

describe("generateAsset — output", () => {
  it("4. output is a real PNG at 1080x1350", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });
    expect(outcome.status).toBe("success");

    const stored = storage.files.get(outcome.asset!.storage_path!);
    expect(stored).toBeInstanceOf(Buffer);
    const meta = await sharp(stored!).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
  });

  it("5. the official logo asset is used (not AI-generated) — provenance names the real repository file", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(outcome.asset?.render_provenance).toMatchObject({
      logoFile: "brands/solardesk/assets/logos/logo.png",
    });
  });

  it("6. the source draft id and exact version remain traceable", async () => {
    const { fake, db, storage } = setup();
    const draft = seedDraft(fake, "draft-1", { version: 3 });

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(outcome.asset?.draft_id).toBe("draft-1");
    expect(outcome.asset?.source_draft_version).toBe(draft.version);
  });

  it("7. the approved content draft is never mutated", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    const before = fake.getAll("content_drafts").find((d) => d.id === "draft-1");

    await generateAsset({ db, storage, draftId: "draft-1" });

    const after = fake.getAll("content_drafts").find((d) => d.id === "draft-1");
    expect(after).toEqual(before);
  });

  it("8. the generated asset persists and can be retrieved after the call returns", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });
    const latest = await getLatestAsset(db, "draft-1");

    expect(latest?.id).toBe(outcome.asset?.id);
    expect(storage.files.has(latest!.storage_path!)).toBe(true);
  });

  it("9. a freshly generated asset begins pending_review", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(outcome.asset?.status).toBe("pending_review");
  });
});

describe("approveAsset", () => {
  it("10. approval moves the asset to ready_to_publish", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    const approved = await approveAsset(db, outcome.asset!.id);

    expect(approved.ok).toBe(true);
    expect(approved.asset?.status).toBe("ready_to_publish");
    expect(approved.asset?.approved_at).toBeTruthy();
  });

  it("refuses to approve a non-pending asset", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });
    await approveAsset(db, outcome.asset!.id);

    const secondApproval = await approveAsset(db, outcome.asset!.id);

    expect(secondApproval.ok).toBe(false);
  });
});

describe("regeneration and failure handling", () => {
  it("11. regeneration preserves the previous version instead of overwriting it", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");

    const first = await generateAsset({ db, storage, draftId: "draft-1" });
    const second = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(first.asset?.asset_version).toBe(1);
    expect(second.asset?.asset_version).toBe(2);
    expect(storage.files.has(first.asset!.storage_path!)).toBe(true); // v1 file still present
    expect(storage.files.has(second.asset!.storage_path!)).toBe(true);

    const all = await listAssets(db, "draft-1");
    expect(all).toHaveLength(2);
  });

  it("12. a failed generation does not damage existing approved content or asset history", async () => {
    const { fake, db, storage } = setup();
    // A headline long enough that even the smallest candidate font size
    // cannot fit within 4 lines — the renderer's real fail-safe path.
    const longHeadline = "Palabra ".repeat(400).trim();
    seedDraft(fake, "draft-1", { hook: longHeadline });

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(outcome.status).toBe("failed");
    expect(outcome.asset?.status).toBe("generation_failed");
    expect(outcome.asset?.error_message).toBeTruthy();

    // The draft is untouched and no file was ever uploaded for this attempt.
    const draft = fake.getAll("content_drafts").find((d) => d.id === "draft-1");
    expect(draft?.status).toBe("approved");
    expect(storage.files.size).toBe(0);

    // A subsequent successful generation still works and gets the next version.
    const retryDraft = seedDraft(fake, "draft-1", { hook: "¿Listo para tu primera propuesta?" });
    fake.seed("content_drafts", [retryDraft]);
    const retry = await generateAsset({ db, storage, draftId: "draft-1" });
    expect(retry.status).toBe("success");
    expect(retry.asset?.asset_version).toBe(2);
  });

  it("a storage upload failure is recorded as generation_failed without leaving an orphaned success row", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    storage.failNextUpload = true;

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(outcome.status).toBe("failed");
    expect(outcome.asset?.status).toBe("generation_failed");
    expect(fake.getAll("content_assets")).toHaveLength(1);
  });

  it("13. concurrent generation for the same draft is handled safely — only one version 1 is ever persisted", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");

    const [a, b] = await Promise.all([
      generateAsset({ db, storage, draftId: "draft-1" }),
      generateAsset({ db, storage, draftId: "draft-1" }),
    ]);

    const outcomes = [a, b];
    const successes = outcomes.filter((o) => o.status === "success");
    const concurrentRejections = outcomes.filter((o) => o.status === "concurrent");

    // Exactly one of the two calls wins version 1; the other is told to retry.
    expect(successes).toHaveLength(1);
    expect(concurrentRejections.length + successes.length).toBe(2);

    const rows = fake.getAll("content_assets");
    const versionOnes = rows.filter((r) => r.asset_version === 1);
    expect(versionOnes).toHaveLength(1); // never two competing "version 1" rows
  });
});

// Product rule (updated deliberately): the approveDraft() DOMAIN function
// and the marketing-cycle runtime still never generate assets. The ONE
// automatic path is the email lifecycle adapter
// (lib/agent/postApprovalContinuation.ts): after an approve_draft EMAIL
// action is applied, it continues an image_post to its FIRST asset via the
// canonical generateAsset({ firstGenerationOnly: true }). Everything else
// (Regenerate, dashboard-approved drafts) remains an explicit UI action.
describe("asset generation triggers", () => {
  it("14. the approveDraft() domain function itself never calls generateAsset — no content_assets row appears", async () => {
    const { fake, db } = setup();
    seedDraft(fake, "draft-1", { status: "pending_approval" });

    // Simulate the existing approval action directly (the real
    // approveDraft() codepath) — it must never touch content_assets.
    const { approveDraft } = await import("@/lib/agent/approvals");
    await approveDraft(db, "draft-1");

    const draft = fake.getAll("content_drafts").find((d) => d.id === "draft-1");
    expect(draft?.status).toBe("approved");
    expect(fake.getAll("content_assets")).toHaveLength(0);
  });

  it("15. runMarketingCycle's own source never references asset generation at all", async () => {
    // Structural guarantee, not just a behavioral one: asset generation
    // must only ever be reachable from an explicit UI action
    // (app/actions.ts -> generateAssetAction), never from the autonomous
    // marketing-cycle runtime or the approval codepath. Grepping the
    // source is a stronger, more future-proof check than running one
    // marketing cycle and hoping it happens not to trigger — it proves
    // the wiring doesn't exist at all, not just that this one scripted
    // run didn't exercise it.
    const { readFile } = await import("node:fs/promises");
    const runtimeSource = await readFile("lib/agent/runtime.ts", "utf-8");
    const approvalsSource = await readFile("lib/agent/approvals.ts", "utf-8");
    expect(runtimeSource).not.toMatch(/generateAsset|assetGenerator|assetRenderer/);
    expect(approvalsSource).not.toMatch(/generateAsset|assetGenerator|assetRenderer/);
  });

  it("15b. the only automatic caller of generateAsset is the email post-approval continuation, and it requests first generation only", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const path = await import("node:path");
    async function sourceFiles(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const nested = await Promise.all(
        entries.map((e) => (e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : Promise.resolve(/\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : [])))
      );
      return nested.flat();
    }
    const callers: string[] = [];
    for (const file of [...(await sourceFiles("lib")), ...(await sourceFiles("app"))]) {
      if (file.endsWith(path.join("agent", "assetGenerator.ts"))) continue;
      if (/\bgenerateAsset\(/.test(await readFile(file, "utf-8"))) callers.push(file.split(path.sep).join("/"));
    }
    // app/actions.ts = the explicit dashboard "Generate Asset"/"Regenerate" button.
    expect(callers.sort()).toEqual(["app/actions.ts", "lib/agent/postApprovalContinuation.ts"]);
    const continuation = await readFile("lib/agent/postApprovalContinuation.ts", "utf-8");
    expect(continuation).toMatch(/generateAsset\(\{[^}]*firstGenerationOnly: true/);
  });
});

// AlexAgent v0.2 — Visual Director. Covers the "Prompt Master" task's
// end-to-end generateAsset() lifecycle when an aiClient (and optionally
// an imageGenerationClient) is supplied — the no-aiClient/Regenerate
// paths exercised above are entirely unaffected (zero AI cost, no
// BudgetGuard dependency, as asserted there already).
describe("generateAsset — Visual Director (first-time generation with an aiClient)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function enableImageCapability() {
    process.env.OPENAI_IMAGE_MODEL = "gpt-image-1";
  }

  it("1. a validated Visual Director plan drives generation — proposal-focused content can select proposal_document", async () => {
    const { fake, db, storage } = setupWithBudget();
    seedDraft(fake, "draft-1", {
      visual_direction: "Muestra la propuesta final en PDF que SolarDesk entrega al cliente, lista para presentar.",
      topic: "El resultado: una propuesta profesional para tu cliente",
    });
    const aiClient = new ScriptedAiClient([], [], [], [visualPlan({ strategy: "proposal_document", verifiedSourceCategory: "proposal_example" })]);

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient });

    expect(outcome.status).toBe("success");
    const provenance = outcome.asset!.render_provenance as Record<string, unknown>;
    expect((provenance.visualPlan as { strategy: string }).strategy).toBe("proposal_document");
    expect((provenance.proposalExample as { selected: boolean }).selected).toBe(true);
  });

  it("2. product-focused content can select product_ui", async () => {
    const { fake, db, storage } = setupWithBudget();
    seedDraft(fake, "draft-1", {
      visual_direction: "Mockup B2B SaaS mostrando la experiencia de propuestas de SolarDesk.",
      topic: "Gestiona tus propuestas solares",
    });
    const aiClient = new ScriptedAiClient([], [], [], [visualPlan({ strategy: "product_ui", verifiedSourceCategory: "product_screenshot" })]);

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient });

    const provenance = outcome.asset!.render_provenance as Record<string, unknown>;
    expect((provenance.visualPlan as { strategy: string }).strategy).toBe("product_ui");
    expect((provenance.screenshot as { selected: boolean; file: string }).file).toBe("04.png");
  });

  it("3. conceptual/educational content can select branded_graphic — the live QA gap this task fixes", async () => {
    const { fake, db, storage } = setupWithBudget();
    seedDraft(fake, "draft-1", {
      visual_direction: "SaaS B2B limpio, azul oscuro y ámbar.",
      topic: "Explicar los supuestos también es parte de la propuesta",
    });
    const aiClient = new ScriptedAiClient([], [], [], [visualPlan({ strategy: "branded_graphic" })]);

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient });

    const provenance = outcome.asset!.render_provenance as Record<string, unknown>;
    expect((provenance.visualPlan as { strategy: string }).strategy).toBe("branded_graphic");
    expect(provenance.renderer).toBe("svg-sharp-v1");
  });

  it("20. the Visual Director's strategy choice wins over raw keyword coincidence — a 'propuesta'-containing topic does not force proposal_document when the plan says branded_graphic", async () => {
    const { fake, db, storage } = setupWithBudget();
    seedDraft(fake, "draft-1", {
      visual_direction: "Muestra la propuesta final en PDF que SolarDesk entrega al cliente.",
      topic: "El resultado: una propuesta profesional para tu cliente",
    });
    const aiClient = new ScriptedAiClient([], [], [], [visualPlan({ strategy: "branded_graphic" })]);

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient });

    expect((outcome.asset!.render_provenance as Record<string, unknown>).renderer).toBe("svg-sharp-v1");
    expect(((outcome.asset!.render_provenance as Record<string, unknown>).proposalExample as { selected: boolean }).selected).toBe(false);
  });

  it("21. relevance can still legitimately select proposal_document repeatedly — no artificial novelty penalty", async () => {
    // Two independent DBs/drafts (the fake DB's seed() replaces a
    // table's rows rather than appending, so two drafts must either
    // share one seed call or, as here, live in separate fake DBs) — the
    // point under test is that nothing in generateAsset() itself
    // penalizes reusing the same strategy back-to-back.
    const setupA = setupWithBudget();
    seedDraft(setupA.fake, "draft-1", { visual_direction: "Muestra la propuesta final en PDF.", topic: "Propuesta A" });
    const setupB = setupWithBudget();
    seedDraft(setupB.fake, "draft-2", { visual_direction: "Muestra la propuesta final en PDF.", topic: "Propuesta B" });
    const plan = visualPlan({ strategy: "proposal_document", verifiedSourceCategory: "proposal_example" });

    const first = await generateAsset({ db: setupA.db, storage: setupA.storage, draftId: "draft-1", aiClient: new ScriptedAiClient([], [], [], [plan]) });
    const second = await generateAsset({ db: setupB.db, storage: setupB.storage, draftId: "draft-2", aiClient: new ScriptedAiClient([], [], [], [plan]) });

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(((first.asset!.render_provenance as Record<string, unknown>).visualPlan as { strategy: string }).strategy).toBe("proposal_document");
    expect(((second.asset!.render_provenance as Record<string, unknown>).visualPlan as { strategy: string }).strategy).toBe("proposal_document");
  });

  it("5/6/7. generated_photo/generated_illustration/hybrid are only accepted when generative capability is available, and hybrid combines a generated image with a verified source", async () => {
    const { fake, db, storage } = setupWithBudget();
    enableImageCapability();
    seedDraft(fake, "draft-1", { topic: "Explicar los supuestos también es parte de la propuesta" });
    const imageClient = new ScriptedImageGenerationClient();
    const aiClient = new ScriptedAiClient(
      [],
      [],
      [],
      [
        visualPlan({
          strategy: "hybrid",
          verifiedSourceCategory: "product_screenshot",
          generativeSceneDescription: "Un instalador solar revisando planos en una oficina moderna.",
        }),
      ]
    );

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient, imageGenerationClient: imageClient });

    expect(outcome.status).toBe("success");
    expect(imageClient.calls).toHaveLength(1);
    const provenance = outcome.asset!.render_provenance as Record<string, unknown>;
    expect((provenance.visualPlan as { strategy: string }).strategy).toBe("hybrid");
    expect((provenance.screenshot as { selected: boolean }).selected).toBe(true);
    expect((provenance.visualPlan as { generatedImage: { used: boolean } }).generatedImage.used).toBe(true);
  });

  it("generative strategies are never accepted without an imageGenerationClient, even if the plan requests one — degrades to branded_graphic", async () => {
    const { fake, db, storage } = setupWithBudget();
    // Capability env var deliberately NOT set.
    seedDraft(fake, "draft-1", { topic: "Explicar los supuestos también es parte de la propuesta" });
    const aiClient = new ScriptedAiClient([], [], [], [visualPlan({ strategy: "generated_photo", generativeSceneDescription: "Escena solar." })]);

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient });

    expect(outcome.status).toBe("success");
    const provenance = outcome.asset!.render_provenance as Record<string, unknown>;
    expect((provenance.visualPlan as { strategy: string }).strategy).toBe("branded_graphic");
    expect((provenance.visualPlan as { degraded: boolean }).degraded).toBe(true);
  });

  it("8/27. Visual Director usage is recorded", async () => {
    const { fake, db, storage } = setupWithBudget();
    seedDraft(fake, "draft-1");
    const aiClient = new ScriptedAiClient([], [], [], [visualPlan({ strategy: "branded_graphic" })]);

    await generateAsset({ db, storage, draftId: "draft-1", aiClient });

    const usage = fake.getAll("ai_usage");
    expect(usage.length).toBeGreaterThanOrEqual(1);
    expect(usage[0].operation).toBe("executor");
    expect(aiClient.visualDirectorCalls).toHaveLength(1);
  });

  it("26. generative usage/cost is recorded as a separate ai_usage row from the Visual Director call", async () => {
    const { fake, db, storage } = setupWithBudget();
    enableImageCapability();
    seedDraft(fake, "draft-1");
    const imageClient = new ScriptedImageGenerationClient();
    const aiClient = new ScriptedAiClient(
      [],
      [],
      [],
      [visualPlan({ strategy: "generated_photo", generativeSceneDescription: "Escena solar profesional." })]
    );

    await generateAsset({ db, storage, draftId: "draft-1", aiClient, imageGenerationClient: imageClient });

    const usage = fake.getAll("ai_usage");
    expect(usage).toHaveLength(2);
    expect(usage.map((u) => u.model)).toEqual(expect.arrayContaining(["test-image-model"]));
  });

  it("28. a budget block prevents the Visual Director call entirely and does not create a generated asset", async () => {
    const { fake, db, storage } = setupWithBudget();
    seedDraft(fake, "draft-1");
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
    const aiClient = new ScriptedAiClient([], [], [], [visualPlan()]);

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient });

    expect(outcome.status).toBe("failed");
    expect(outcome.budgetBlocked).toBe(true);
    expect(aiClient.visualDirectorCalls).toHaveLength(0);
    expect(fake.getAll("content_assets")).toHaveLength(0);
  });

  it("11/29. a budget block on the image-generation call specifically degrades to branded_graphic instead of failing the whole asset — never a paid call past the block", async () => {
    const { fake, db, storage } = setupWithBudget();
    enableImageCapability();
    seedDraft(fake, "draft-1");
    // Leave headroom for the (cheap) Visual Director call but not for image generation.
    fake.seed("ai_usage", [
      {
        id: "usage-1",
        agent_run_id: null,
        brand: "solardesk",
        operation: "executor",
        model: "gpt-5.6-luna",
        input_tokens: 100,
        cached_input_tokens: 0,
        output_tokens: 100,
        estimated_cost_usd: 9.49,
        created_at: new Date().toISOString(),
      },
    ]);
    const imageClient = new ScriptedImageGenerationClient();
    const aiClient = new ScriptedAiClient(
      [],
      [],
      [],
      [visualPlan({ strategy: "generated_photo", generativeSceneDescription: "Escena solar." })]
    );

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient, imageGenerationClient: imageClient });

    expect(outcome.status).toBe("success");
    expect(imageClient.calls).toHaveLength(0);
    const provenance = outcome.asset!.render_provenance as Record<string, unknown>;
    expect((provenance.visualPlan as { strategy: string }).strategy).toBe("branded_graphic");
    expect((provenance.visualPlan as { degraded: boolean }).degraded).toBe(true);
  });

  it("13/30. an image-generation provider failure does not corrupt the asset — degrades to branded_graphic and still succeeds", async () => {
    const { fake, db, storage } = setupWithBudget();
    enableImageCapability();
    seedDraft(fake, "draft-1");
    const imageClient = new ScriptedImageGenerationClient();
    imageClient.failNextCalls = 1;
    const aiClient = new ScriptedAiClient(
      [],
      [],
      [],
      [visualPlan({ strategy: "generated_illustration", generativeSceneDescription: "Ilustración conceptual de energía solar." })]
    );

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient, imageGenerationClient: imageClient });

    expect(outcome.status).toBe("success");
    const provenance = outcome.asset!.render_provenance as Record<string, unknown>;
    expect((provenance.visualPlan as { strategy: string }).strategy).toBe("branded_graphic");
    expect((provenance.visualPlan as { degraded: boolean }).degraded).toBe(true);
  });

  it("14/31. a Storage failure on the final composited upload is recorded as generation_failed and never corrupts a prior asset", async () => {
    const { fake, db, storage } = setupWithBudget();
    seedDraft(fake, "draft-1");
    storage.failNextUpload = true;
    const aiClient = new ScriptedAiClient([], [], [], [visualPlan({ strategy: "branded_graphic" })]);

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient });

    expect(outcome.status).toBe("failed");
    expect(outcome.asset?.status).toBe("generation_failed");
  });

  it("15/32. concurrent first-time generations for the same draft are handled safely by the agent_runs brand lock", async () => {
    const { fake, db, storage } = setupWithBudget();
    seedDraft(fake, "draft-1");
    const aiClientA = new ScriptedAiClient([], [], [], [visualPlan({ strategy: "branded_graphic" })]);
    const aiClientB = new ScriptedAiClient([], [], [], [visualPlan({ strategy: "branded_graphic" })]);

    const [a, b] = await Promise.all([
      generateAsset({ db, storage, draftId: "draft-1", aiClient: aiClientA }),
      generateAsset({ db, storage, draftId: "draft-1", aiClient: aiClientB }),
    ]);

    const outcomes = [a, b];
    const successes = outcomes.filter((o) => o.status === "success");
    const concurrentRejections = outcomes.filter((o) => o.status === "concurrent");
    expect(successes.length + concurrentRejections.length).toBe(2);
    const versionOnes = fake.getAll("content_assets").filter((r) => r.asset_version === 1);
    expect(versionOnes).toHaveLength(1);
  });

  it("16/33. the resulting asset is pending_review", async () => {
    const { fake, db, storage } = setupWithBudget();
    seedDraft(fake, "draft-1");
    const aiClient = new ScriptedAiClient([], [], [], [visualPlan({ strategy: "branded_graphic" })]);

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient });

    expect(outcome.asset?.status).toBe("pending_review");
  });

  it("17/34. provenance records the strategy and verified/generative source information", async () => {
    const { fake, db, storage } = setupWithBudget();
    seedDraft(fake, "draft-1", {
      visual_direction: "Mockup B2B SaaS mostrando la experiencia de propuestas de SolarDesk.",
      topic: "Gestiona tus propuestas solares",
    });
    const aiClient = new ScriptedAiClient([], [], [], [visualPlan({ strategy: "product_ui", verifiedSourceCategory: "product_screenshot" })]);

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient });

    const visualPlanProvenance = (outcome.asset!.render_provenance as Record<string, unknown>).visualPlan as Record<string, unknown>;
    expect(visualPlanProvenance.strategy).toBe("product_ui");
    expect(visualPlanProvenance.origin).toBe("visual_director");
    expect(visualPlanProvenance.draftContext).toEqual({ purpose: "activation", topic: "Gestiona tus propuestas solares" });
  });

  it("18/35. no secrets or giant base64 blobs are persisted in provenance — only the storage path/prompt text for a generated image", async () => {
    const { fake, db, storage } = setupWithBudget();
    enableImageCapability();
    seedDraft(fake, "draft-1");
    const imageClient = new ScriptedImageGenerationClient();
    const aiClient = new ScriptedAiClient(
      [],
      [],
      [],
      [visualPlan({ strategy: "generated_photo", generativeSceneDescription: "Escena solar profesional." })]
    );

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient, imageGenerationClient: imageClient });

    const serialized = JSON.stringify(outcome.asset!.render_provenance);
    const tinyPngBase64 = tinyPngBuffer().toString("base64");
    expect(serialized).not.toContain(tinyPngBase64);
    expect(serialized.length).toBeLessThan(5000);
    const generatedImage = ((outcome.asset!.render_provenance as Record<string, unknown>).visualPlan as { generatedImage: { storagePath: string } })
      .generatedImage;
    expect(generatedImage.storagePath).toBe("draft-1/generated/v1.png");
  });

  it("22/23. Regenerate after a Visual Director generation reuses the same plan and cached generated image — zero additional AI calls", async () => {
    const { fake, db, storage } = setupWithBudget();
    enableImageCapability();
    seedDraft(fake, "draft-1");
    const imageClient = new ScriptedImageGenerationClient();
    const aiClient = new ScriptedAiClient(
      [],
      [],
      [],
      [visualPlan({ strategy: "generated_photo", generativeSceneDescription: "Escena solar profesional." })]
    );

    const first = await generateAsset({ db, storage, draftId: "draft-1", aiClient, imageGenerationClient: imageClient });
    expect(first.status).toBe("success");

    // Regenerate: no aiClient/imageGenerationClient passed at all — must not need them.
    const regenerated = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(regenerated.status).toBe("success");
    expect(regenerated.asset?.asset_version).toBe(2);
    expect(aiClient.visualDirectorCalls).toHaveLength(1); // still just the one from first-time generation
    expect(imageClient.calls).toHaveLength(1); // never called again
    const provenance = regenerated.asset!.render_provenance as Record<string, unknown>;
    expect((provenance.visualPlan as { strategy: string }).strategy).toBe("generated_photo");
    expect((provenance.visualPlan as { generatedImage: { reused: boolean } }).generatedImage.reused).toBe(true);
  });

  it("24. Regenerate degrades to branded_graphic (never re-generates) if the cached generated image cannot be retrieved", async () => {
    const { fake, db, storage } = setupWithBudget();
    enableImageCapability();
    seedDraft(fake, "draft-1");
    const imageClient = new ScriptedImageGenerationClient();
    const aiClient = new ScriptedAiClient(
      [],
      [],
      [],
      [visualPlan({ strategy: "generated_photo", generativeSceneDescription: "Escena solar profesional." })]
    );
    const first = await generateAsset({ db, storage, draftId: "draft-1", aiClient, imageGenerationClient: imageClient });
    // Simulate the cached generated-image object having been lost from Storage.
    storage.files.delete(`draft-1/generated/v${first.asset!.asset_version}.png`);

    const regenerated = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(regenerated.status).toBe("success");
    expect(imageClient.calls).toHaveLength(1); // still just the one call from the original (first-time) generation — never re-called for Regenerate
    const provenance = regenerated.asset!.render_provenance as Record<string, unknown>;
    expect((provenance.visualPlan as { strategy: string }).strategy).toBe("branded_graphic");
    expect((provenance.visualPlan as { degraded: boolean }).degraded).toBe(true);
  });

  it("Visual Director technical failure degrades safely to the deterministic fallback rather than blocking generation", async () => {
    const { fake, db, storage } = setupWithBudget();
    seedDraft(fake, "draft-1", {
      visual_direction: "Muestra la propuesta final en PDF que SolarDesk entrega al cliente.",
      topic: "El resultado: una propuesta profesional para tu cliente",
    });
    const aiClient = new ScriptedAiClient([], [], [], [visualPlan()]);
    aiClient.failNextVisualDirectorCalls = 1;

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient });

    expect(outcome.status).toBe("success");
    const provenance = outcome.asset!.render_provenance as Record<string, unknown>;
    expect((provenance.visualPlan as { origin: string }).origin).toBe("fallback");
    // The deterministic fallback still finds the real proposal example for this topic.
    expect((provenance.proposalExample as { selected: boolean }).selected).toBe(true);
  });

  it("Visual Director incomplete/invalid structured output degrades safely to the deterministic fallback", async () => {
    const { fake, db, storage } = setupWithBudget();
    seedDraft(fake, "draft-1");
    const aiClient = new ScriptedAiClient([], [], [], []);
    aiClient.incompleteVisualDirectorReasons = ["max_output_tokens"];

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient });

    expect(outcome.status).toBe("success");
    expect(((outcome.asset!.render_provenance as Record<string, unknown>).visualPlan as { origin: string }).origin).toBe("fallback");
    // Usage is still recorded for the incomplete call — it was real and billable.
    expect(fake.getAll("ai_usage")).toHaveLength(1);
  });

  it("25/36/37/38/39. existing AssetRenderSpec/Approve/Regenerate/renderer behavior remains green alongside Visual Director assets", async () => {
    const { fake, db, storage } = setupWithBudget();
    seedDraft(fake, "draft-1");
    const aiClient = new ScriptedAiClient([], [], [], [visualPlan({ strategy: "branded_graphic" })]);
    const generated = await generateAsset({ db, storage, draftId: "draft-1", aiClient });

    const approved = await approveAsset(db, generated.asset!.id);
    expect(approved.ok).toBe(true);
    expect(approved.asset?.status).toBe("ready_to_publish");

    const regenerated = await generateAsset({ db, storage, draftId: "draft-1" });
    expect(regenerated.status).toBe("success");
    expect(regenerated.asset?.asset_version).toBe(2);
  });
});

// CTA label/destination contract + pre-render feasibility + provenance
// fix (real production incident, 2026-09-17): a Facebook image_post
// draft's approved cta_text was the combined "label — URL" string; the
// Visual Director chose ctaEmphasis "strong"; the 47-character combined
// string didn't fit, and the resulting generation_failed row's
// render_provenance never recorded a top-level renderSpec, so Regenerate
// would have silently fallen back to DEFAULT_RENDER_SPEC instead of
// reproducing what was actually attempted.
describe("CTA label/destination contract and pre-render feasibility", () => {
  // Same 47-character shape as the real incident's combined CTA string —
  // built the same way tests/assetRenderer.test.ts's headline-overflow
  // fixtures are (repeated real words, not one unbreakable token), so
  // wrapToFit's word-boundary wrapping behaves realistically.
  const REAL_INCIDENT_LENGTH_LABEL = "Palabra ".repeat(6).trim(); // 47 chars — fits at "normal", not at "strong"
  const NEVER_FITS_LABEL = "Palabra ".repeat(11).trim(); // 87 chars — doesn't fit even at "subtle"

  it("1. the renderer receives only the resolved label, never the legacy combined cta_text string", async () => {
    const { fake, db, storage } = setupWithBudget();
    // Legacy shape: cta_url is null/unset, and cta_text still carries
    // the combined "label — URL" string that would NOT fit at "strong"
    // (see tests/assetRenderer.test.ts's realistic-length CTA-overflow
    // case) — but the derived label "Comenzar gratis" fits trivially.
    seedDraft(fake, "draft-1", { cta_text: "Comenzar gratis — https://solardesk.co/register" });
    const aiClient = new ScriptedAiClient(
      [],
      [],
      [],
      [visualPlan({ renderSpec: { ...DEFAULT_RENDER_SPEC, ctaEmphasis: "strong" } })]
    );

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient });

    expect(outcome.status).toBe("success");
    const provenance = outcome.asset!.render_provenance as { cta?: { source?: string } };
    expect(provenance.cta?.source).toBe("draft.cta_text");
  });

  it("2. a realistic CTA that doesn't fit at the requested emphasis is deterministically downgraded, never truncated", async () => {
    const { fake, db, storage } = setupWithBudget();
    seedDraft(fake, "draft-1", { cta_text: REAL_INCIDENT_LENGTH_LABEL });
    const aiClient = new ScriptedAiClient(
      [],
      [],
      [],
      [visualPlan({ renderSpec: { ...DEFAULT_RENDER_SPEC, ctaEmphasis: "strong" } })]
    );

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient });

    expect(outcome.status).toBe("success");
    const renderSpec = (outcome.asset!.render_provenance as { renderSpec?: { ctaEmphasis?: string } }).renderSpec;
    expect(renderSpec?.ctaEmphasis).toBe("normal"); // downgraded from the requested "strong"
  });

  it("3. a CTA that fits nowhere still fails fail-safe, with a clear pre-render message, before any pixels are produced", async () => {
    const { fake, db, storage } = setupWithBudget();
    seedDraft(fake, "draft-1", { cta_text: NEVER_FITS_LABEL });
    const aiClient = new ScriptedAiClient(
      [],
      [],
      [],
      [visualPlan({ renderSpec: { ...DEFAULT_RENDER_SPEC, ctaEmphasis: "strong" } })]
    );

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient });

    expect(outcome.status).toBe("failed");
    expect(outcome.asset?.status).toBe("generation_failed");
    expect(outcome.asset?.error_message).toMatch(/does not fit within any supported CTA emphasis level/);
    expect(storage.files.size).toBe(0); // no render/upload was ever attempted
  });

  it("4. a failed generation's provenance preserves the effective renderSpec at the top level (not just nested in visualPlan)", async () => {
    const { fake, db, storage } = setupWithBudget();
    seedDraft(fake, "draft-1", { cta_text: NEVER_FITS_LABEL });
    const aiClient = new ScriptedAiClient(
      [],
      [],
      [],
      [visualPlan({ renderSpec: { ...DEFAULT_RENDER_SPEC, ctaEmphasis: "strong" } })]
    );

    const outcome = await generateAsset({ db, storage, draftId: "draft-1", aiClient });

    expect(outcome.status).toBe("failed");
    // getEffectiveRenderSpec is exactly what Regenerate relies on — this
    // is the fixed shape, verified through the real reader function.
    const effective = getEffectiveRenderSpec(outcome.asset!);
    expect(effective.ctaEmphasis).toBe("subtle"); // the smallest level actually tried
  });

  it("5. Regenerate on an unchanged draft after a failure reproduces the SAME effective emphasis — never silently reverting to DEFAULT_RENDER_SPEC", async () => {
    const { fake, db, storage } = setupWithBudget();
    seedDraft(fake, "draft-1", { cta_text: NEVER_FITS_LABEL });
    const aiClient = new ScriptedAiClient(
      [],
      [],
      [],
      [visualPlan({ renderSpec: { ...DEFAULT_RENDER_SPEC, ctaEmphasis: "strong" } })]
    );

    const first = await generateAsset({ db, storage, draftId: "draft-1", aiClient });
    expect(first.status).toBe("failed");
    expect(getEffectiveRenderSpec(first.asset!).ctaEmphasis).toBe("subtle");

    // Regenerate: no aiClient passed at all — this must go through
    // regenerateFromPrevious (reusing the previous failed asset's
    // provenance), never the Visual Director again.
    const second = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(second.status).toBe("failed");
    expect(second.asset?.asset_version).toBe(2);
    // Before the provenance fix, this would have silently come back as
    // "normal" (DEFAULT_RENDER_SPEC), hiding what was really attempted.
    const secondRenderSpec = (second.asset!.render_provenance as { renderSpec?: { ctaEmphasis?: string } }).renderSpec;
    expect(secondRenderSpec?.ctaEmphasis).toBe("subtle");
    expect(secondRenderSpec?.ctaEmphasis).not.toBe(DEFAULT_RENDER_SPEC.ctaEmphasis);
  });
});

// History-aware visual diversity (real production finding, 2026-09-25):
// the Visual Director now sees a compact deterministic history — including
// legacy pre-Visual-Director assets — and code records objectively whether
// the rendered result repeats it. Nothing here ever overrides the model's
// strategy choice.
describe("generateAsset — history-aware visual diversity", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_IMAGE_MODEL = "gpt-image-1";
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const PDF = "brands/solardesk/assets/proposal-examples/propuesta-sistema-solar-residencial.pdf";
  const PAGES = ["brands/solardesk/assets/proposal-examples/rendered/page-1.png", "brands/solardesk/assets/proposal-examples/rendered/page-2.png"];

  /** The new draft plus a legacy (no visualPlan) proposal creative published on Facebook a week earlier — like the real Sep 16 piece. */
  function setupWithPublishedLegacyProposal(draftOverrides: Partial<ContentDraftRow> = {}) {
    const env = setupWithBudget();
    const newDraft = seedDraft(env.fake, "draft-new", {
      channel: "facebook",
      topic: "Prepara tu primera propuesta solar sin tarjeta de crédito",
      visual_direction: "Destacar la propuesta profesional gratuita mensual.",
      ...draftOverrides,
    });
    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    env.fake.seed("content_drafts", [
      newDraft,
      { ...newDraft, id: "draft-legacy", topic: "De la cotización a una propuesta lista para presentar", status: "approved" },
    ]);
    env.fake.seed("content_assets", [
      {
        id: "asset-legacy",
        draft_id: "draft-legacy",
        brand: "solardesk",
        asset_version: 6,
        source_draft_version: 1,
        status: "ready_to_publish",
        format: "image_post",
        storage_bucket: "solardesk-assets",
        storage_path: "draft-legacy/v6.png",
        render_provenance: { renderer: "svg-sharp-proposal-v1", theme: "b", screenshot: { selected: false }, proposalExample: { selected: true, pdfPath: PDF, pages: PAGES } },
        created_at: weekAgo,
      },
    ]);
    env.fake.seed("asset_publications", [
      { id: "pub-legacy", asset_id: "asset-legacy", draft_id: "draft-legacy", brand: "solardesk", channel: "facebook", status: "published", published_at: weekAgo, created_at: weekAgo },
    ]);
    return env;
  }
  const planOf = (asset: { render_provenance: unknown }) => (asset.render_provenance as { visualPlan: Record<string, unknown> }).visualPlan;

  it("10–11. the Visual Director sees the recent published proposal_document with its source, channel, status and age", async () => {
    const { db, storage } = setupWithPublishedLegacyProposal();
    const aiClient = new ScriptedAiClient([], [], [], [visualPlan({ varietyRationale: "Cambia a tipografía." })]);

    await generateAsset({ db, storage, draftId: "draft-new", aiClient, imageGenerationClient: new ScriptedImageGenerationClient() });

    const { systemPrompt, userPrompt } = aiClient.visualDirectorCalls[0];
    expect(userPrompt).toContain("Channel: facebook");
    expect(userPrompt).toMatch(
      /8d ago · facebook · published · proposal_document \(inferred from renderer\) · layout=proposal theme=b · source=proposal:propuesta-sistema-solar-residencial#p1\+p2 · generatedImage=no · topic="De la cotización a una propuesta lista para presentar"/
    );
    expect(userPrompt).toMatch(/Latest published feed treatments \(newest first\): 8d ago facebook: proposal_document \/ proposal \/ proposal:propuesta-sistema-solar-residencial#p1\+p2/);
    expect(systemPrompt).toMatch(/same strategy with the same source/);
    expect(systemPrompt).toMatch(/Do not rotate strategies mechanically/);
    expect(systemPrompt).toMatch(/Do not choose generated imagery merely for novelty/);
    expect(systemPrompt).toMatch(/Always fill varietyRationale/);
  });

  it("13–14/17. repeating the recent proposal is legal and never overridden; code records the repetition independently of the model's prose", async () => {
    const { db, storage } = setupWithPublishedLegacyProposal();
    const aiClient = new ScriptedAiClient([], [], [], [
      visualPlan({
        strategy: "proposal_document",
        verifiedSourceCategory: "proposal_example",
        compositionIntent: "verified_dominant",
        // Deliberately misleading prose: code must not trust it.
        varietyRationale: "Tratamiento totalmente nuevo, nunca usado antes.",
      }),
    ]);
    const imageClient = new ScriptedImageGenerationClient();

    const outcome = await generateAsset({ db, storage, draftId: "draft-new", aiClient, imageGenerationClient: imageClient });

    expect(outcome.status).toBe("success");
    const plan = planOf(outcome.asset!);
    expect(plan.strategy).toBe("proposal_document"); // not rotated away
    expect(plan.varietyRationale).toBe("Tratamiento totalmente nuevo, nunca usado antes.");
    expect(plan.varietyAssessment).toEqual({
      repeatsRecentStrategy: true,
      repeatsRecentSource: true,
      repeatsLatestPublishedOnChannel: true,
      sameStrategyCount: 1,
      daysSinceStrategyLastUsed: 8,
      comparedEntries: 1,
    });
    expect(imageClient.calls).toHaveLength(0);
  });

  it("12. generated_photo remains selectable, with a factual cost/budget hint, and records no repetition", async () => {
    const { db, storage } = setupWithPublishedLegacyProposal();
    const aiClient = new ScriptedAiClient([], [], [], [
      visualPlan({
        strategy: "generated_photo",
        compositionIntent: "generated_dominant",
        generativeSceneDescription: "Un instalador solar conversando con un cliente en su casa.",
        varietyRationale: "Las piezas recientes fueron documento de propuesta; esta usa contexto humano.",
      }),
    ]);
    const imageClient = new ScriptedImageGenerationClient();

    const outcome = await generateAsset({ db, storage, draftId: "draft-new", aiClient, imageGenerationClient: imageClient });

    expect(aiClient.visualDirectorCalls[0].systemPrompt).toMatch(
      /Generative capability IS available this call \(approximately \$0\.026 per low-quality generation; the current AI budget leaves room for one generation this run\)/
    );
    expect(imageClient.calls).toHaveLength(1);
    const plan = planOf(outcome.asset!);
    expect(plan.strategy).toBe("generated_photo");
    expect(plan.varietyAssessment).toMatchObject({ repeatsRecentStrategy: false, repeatsRecentSource: false, repeatsLatestPublishedOnChannel: false });
  });

  it("18. Budget Guard still decides: a generated choice under an exhausted budget makes no paid call, falls back, and records why", async () => {
    const { fake, db, storage } = setupWithPublishedLegacyProposal();
    fake.seed("ai_usage", [
      { id: "u1", agent_run_id: null, brand: "solardesk", operation: "executor", model: "gpt-5.6-luna", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, estimated_cost_usd: 9.49, created_at: new Date().toISOString() },
    ]);
    const aiClient = new ScriptedAiClient([], [], [], [
      visualPlan({ strategy: "generated_photo", compositionIntent: "generated_dominant", generativeSceneDescription: "Escena solar.", varietyRationale: "Contexto humano." }),
    ]);
    const imageClient = new ScriptedImageGenerationClient();

    const outcome = await generateAsset({ db, storage, draftId: "draft-new", aiClient, imageGenerationClient: imageClient });

    expect(aiClient.visualDirectorCalls[0].systemPrompt).toMatch(/does NOT leave room for a generation this run/);
    expect(imageClient.calls).toHaveLength(0);
    const plan = planOf(outcome.asset!);
    expect(plan).toMatchObject({ strategy: "branded_graphic", requestedStrategy: "generated_photo", degraded: true });
    expect(plan.degradeReason).toMatch(/^Image generation budget blocked:/);
    expect(plan.varietyAssessment).toMatchObject({ repeatsRecentStrategy: false }); // assessed on what was actually rendered
  });

  it("16/19. an old stored plan without varietyRationale still parses: Regenerate reuses it (never keyword fallback) with zero AI calls", async () => {
    const { fake, db, storage } = setupWithPublishedLegacyProposal({ topic: "Consejos de instalación" }); // no proposal keywords
    const oldPlan = visualPlan({ strategy: "branded_graphic", creativeConcept: "Plan persistido antes de varietyRationale." });
    expect("varietyRationale" in oldPlan).toBe(false);
    fake.seed("content_assets", [
      ...fake.getAll("content_assets"),
      {
        id: "asset-old",
        draft_id: "draft-new",
        brand: "solardesk",
        asset_version: 1,
        source_draft_version: 1,
        status: "pending_review",
        format: "image_post",
        storage_bucket: "solardesk-assets",
        storage_path: "draft-new/v1.png",
        render_provenance: { renderSpec: DEFAULT_RENDER_SPEC, renderer: "svg-sharp-v1", theme: "a", visualPlan: { ...oldPlan, origin: "visual_director", degraded: false, generatedImage: { used: false } } },
        created_at: new Date().toISOString(),
      },
    ]);
    const aiClient = new ScriptedAiClient([], [], [], []);
    const imageClient = new ScriptedImageGenerationClient();

    const regenerated = await generateAsset({ db, storage, draftId: "draft-new", aiClient, imageGenerationClient: imageClient });

    expect(regenerated.status).toBe("success");
    expect(aiClient.visualDirectorCalls).toHaveLength(0);
    expect(imageClient.calls).toHaveLength(0);
    const plan = planOf(regenerated.asset!);
    expect(plan).toMatchObject({ origin: "reused_plan", strategy: "branded_graphic", creativeConcept: "Plan persistido antes de varietyRationale." });
    expect(plan.varietyAssessment).toBeUndefined(); // only first-time Visual Director generations are assessed
  });
});
