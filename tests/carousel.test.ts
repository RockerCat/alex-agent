import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentDraftRow, ContentAssetRow } from "@/lib/types/database";
import { generateAsset } from "@/lib/agent/assetGenerator";
import { addSlideMarker, IMAGE_POST_WIDTH, IMAGE_POST_HEIGHT } from "@/lib/agent/assetRenderer";
import { approvedCarouselSlides, carouselPlanShapeError, planCarouselSlides, fallbackCarouselPlan } from "@/lib/agent/carouselPlan";
import { carouselSlidePlanSchema, CAROUSEL_SLIDE_STRATEGIES } from "@/lib/agent/schemas";
import { continueApprovedImagePost, runPostApprovalContinuationSweep, type ContinuationDeps } from "@/lib/agent/postApprovalContinuation";
import { publishEmailAuthorizedAsset, runPublicationRecoverySweep, type PublicationDeps } from "@/lib/agent/postApprovalPublication";
import { publishAssetToInstagram, RETRY_SAFE_FAILURE_MARKER, UNCERTAIN_OUTCOME_MARKER } from "@/lib/agent/publish";
import { confirmEmailAction, createEmailActionTokens } from "@/lib/agent/emailActions";
import { composeFinalSocialCaption } from "@/lib/agent/finalCaption";
import { getRecentVisualHistory } from "@/lib/agent/visualHistory";
import { AssetStorageError } from "@/lib/agent/assetStorage";
import { createFakeDb, asSupabaseClient, type FakeDb } from "@/tests/support/fakeDb";
import { FakeAssetStorage } from "@/tests/support/fakeAssetStorage";
import { ScriptedAiClient, carouselPlan } from "@/tests/support/fakeAiClient";
import { ScriptedImageGenerationClient } from "@/tests/support/fakeImageGenerationClient";
import { ScriptedEmailClient, emailRejection } from "@/tests/support/fakeEmailClient";
import { ScriptedInstagramClient, instagramRejection, instagramUncertainFailure } from "@/tests/support/fakeInstagramClient";
import { seedDefaultSettings } from "@/tests/support/seed";

// Instagram carousel v1: ONE editorial unit → ONE Visual Director call →
// N ordered slide images in ONE content_assets row → ONE finished review
// email → ONE approval → ONE Instagram carousel. Every AI/image/email/Meta
// call is scripted; nothing real is ever called.

const DRAFT_ID = "7871fef9-0aaf-457a-9608-f3ac72538249"; // shaped like the real 2026-09-25 pending carousel
const PLAN_ID = "9e0d0520-fa21-461f-b576-8ccb8e86a0fc";
const BASE_URL = "https://agent.alexsosa.me";
const noDelay = async () => {};

// The real pending carousel's approved slide texts (5 slides).
const REAL_SLIDES = [
  "Una propuesta solar clara reúne la información del proyecto y la identidad de tu empresa.",
  "Presenta estimaciones de sistema, producción, costos y retorno de forma organizada.",
  "Comparte un enlace interactivo para que tu cliente consulte la propuesta en línea.",
  "También puedes obtener un PDF profesional para compartirlo por el canal que prefieras.",
  "Las cifras son demostrativas: dependen de los datos ingresados y de los supuestos del proyecto.",
];
const slidesBody = (texts: string[]) => ({ slides: texts.map((text, i) => ({ slide: i + 1, text })) });

function carouselDraft(overrides: Partial<ContentDraftRow> = {}): Record<string, unknown> {
  return {
    id: DRAFT_ID,
    plan_id: PLAN_ID,
    brand: "solardesk",
    created_by_run: null,
    channel: "instagram",
    content_type: "carousel",
    purpose: "Carrusel educativo para mostrar el resultado que puede presentar el usuario.",
    topic: "Así puede verse y compartirse una propuesta solar preparada en SolarDesk",
    audience: "Profesionales solares",
    cta: "Comenzar gratis",
    cta_url: "https://solardesk.co/register",
    target_date: "2026-09-26",
    status: "approved",
    version: 1,
    title: "Así puede verse tu propuesta solar en SolarDesk",
    hook: "De la información técnica a una propuesta lista para presentar.",
    body: slidesBody(REAL_SLIDES),
    caption: "Una propuesta solar no solo reúne cálculos. #SolarDesk #EnergíaSolar",
    cta_text: "Comenzar gratis",
    visual_direction: "Mostrar la evolución desde la información técnica hasta una propuesta profesional lista para presentar.",
    hashtags: ["#SolarDesk", "#EnergíaSolar", "#PropuestasComerciales", "#InstaladoresSolares"],
    blocked_on_question_id: null,
    approved_at: "2026-09-25T13:10:00Z",
    rejected_at: null,
    created_at: "2026-09-25T13:01:19Z",
    updated_at: "2026-09-25T13:01:19Z",
    ...overrides,
  };
}

/** A sent email content review for the draft's current version = it entered the email lifecycle. */
const enrollment = (version = 1) => ({
  id: `outbox-content-${version}`,
  brand: "solardesk",
  channel: "email",
  notification_type: "draft_pending_approval",
  subject_type: "content_draft",
  subject_id: DRAFT_ID,
  subject_version: version,
  status: "sent",
  updated_at: "2026-09-25T13:01:29Z",
});

interface Harness {
  fake: FakeDb;
  db: SupabaseClient<Database>;
  storage: FakeAssetStorage;
  aiClient: ScriptedAiClient;
  imageClient: ScriptedImageGenerationClient;
  emailClient: ScriptedEmailClient;
  instagramClient: ScriptedInstagramClient;
  continuation: ContinuationDeps;
  publication: PublicationDeps;
}

function setup(
  opts: {
    draft?: Partial<ContentDraftRow>;
    plans?: ReturnType<typeof carouselPlan>[];
    storage?: FakeAssetStorage;
    emailClient?: ScriptedEmailClient;
    instagramClient?: ScriptedInstagramClient;
    imageClient?: ScriptedImageGenerationClient;
  } = {}
): Harness {
  const fake = createFakeDb();
  seedDefaultSettings(fake);
  fake.seed("marketing_plans", [{ id: PLAN_ID, brand: "solardesk", primary_objective: "SIGNUPS", status: "active" }]);
  fake.seed("content_drafts", [carouselDraft(opts.draft)]);
  fake.seed("notification_outbox", [enrollment()]);
  fake.seed("content_assets", []);
  fake.seed("asset_publications", []);
  const db = asSupabaseClient<SupabaseClient<Database>>(fake);
  const storage = opts.storage ?? new FakeAssetStorage();
  const aiClient = new ScriptedAiClient([], [], undefined, undefined, opts.plans ?? [carouselPlan(["branded_graphic", "generated_photo", "product_ui", "proposal_document", "branded_graphic"])]);
  const imageClient = opts.imageClient ?? new ScriptedImageGenerationClient();
  const emailClient = opts.emailClient ?? new ScriptedEmailClient();
  const instagramClient = opts.instagramClient ?? new ScriptedInstagramClient({ mediaId: "ig-carousel-media-1" });
  return {
    fake,
    db,
    storage,
    aiClient,
    imageClient,
    emailClient,
    instagramClient,
    continuation: {
      db,
      storage,
      aiClient,
      imageGenerationClient: imageClient,
      emailClient,
      addressing: { from: "AlexAgent <review@mail.agent.alexsosa.me>", to: "owner@example.test" },
      baseUrl: BASE_URL,
    },
    publication: { db, storage, facebookClient: undefined as never, instagramClient, delay: noDelay },
  };
}

const assets = (h: Harness) => h.fake.getAll("content_assets") as unknown as ContentAssetRow[];
const paid = (h: Harness) => ({ director: h.aiClient.carouselVisualDirectorCalls.length, singleDirector: h.aiClient.visualDirectorCalls.length, image: h.imageClient.calls.length });
const provenanceOf = (a: ContentAssetRow) => a.render_provenance as { carouselSlides: Record<string, unknown>[]; visualPlan: Record<string, unknown>; failedSlide?: number };
const tokenIn = (text: string) => text.match(/#t=([A-Za-z0-9_-]{43})/)![1];

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("OPENAI_IMAGE_MODEL", "gpt-image-1");
  vi.stubEnv("META_INSTAGRAM_ACCESS_TOKEN", "fake-ig-token");
  vi.stubEnv("META_INSTAGRAM_ACCOUNT_ID", "456");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Deterministic planning
// ---------------------------------------------------------------------------

describe("carousel planning (pure)", () => {
  const selection = { visualDirection: "Mostrar la propuesta final en PDF", purpose: "p", topic: "Gestiona tus propuestas en la plataforma" };

  it("reads approved slides as a clean 1..N sequence, or rejects gaps/empties", () => {
    expect(approvedCarouselSlides({ body: slidesBody(["a", "b", "c"]) })).toEqual([
      { position: 1, text: "a" },
      { position: 2, text: "b" },
      { position: 3, text: "c" },
    ]);
    expect(approvedCarouselSlides({ body: { slides: [{ slide: 2, text: "b" }, { slide: 1, text: "a" }] } })!.map((s) => s.position)).toEqual([1, 2]);
    expect(approvedCarouselSlides({ body: { slides: [{ slide: 1, text: "a" }, { slide: 3, text: "c" }] } })).toBeNull();
    expect(approvedCarouselSlides({ body: { slides: [{ slide: 1, text: "  " }] } })).toBeNull();
    expect(approvedCarouselSlides({ body: { slides: [] } })).toBeNull();
  });

  it("rejects a plan whose slide count or numbering doesn't exactly match the draft", () => {
    expect(carouselPlanShapeError(carouselPlan(["branded_graphic", "branded_graphic"]), 3)).toMatch(/2 slide plans for a 3-slide carousel/);
    const swapped = carouselPlan(["branded_graphic", "branded_graphic", "branded_graphic"]);
    swapped.slidePlans[1].slideNumber = 3;
    swapped.slidePlans[2].slideNumber = 2;
    expect(carouselPlanShapeError(swapped, 3)).toMatch(/not numbered 1..3 in order/);
    expect(carouselPlanShapeError(carouselPlan(["branded_graphic", "product_ui", "branded_graphic"]), 3)).toBeNull();
  });

  it("hybrid is not a carousel slide strategy in v1", () => {
    expect(CAROUSEL_SLIDE_STRATEGIES).not.toContain("hybrid");
    expect(carouselSlidePlanSchema.safeParse({ slideNumber: 1, strategy: "hybrid", verifiedSourceCategory: "none", compositionIntent: "split_hybrid", generativeSceneDescription: "x" }).success).toBe(false);
  });

  it("caps generated slides at 2 in slide order, downgrading the rest with a recorded reason", () => {
    const planning = planCarouselSlides(
      carouselPlan(["generated_photo", "generated_illustration", "generated_photo", "generated_photo"]),
      approvedCarouselSlides({ body: slidesBody(["uno", "dos", "tres", "cuatro"]) })!,
      selection,
      { generativeCapabilityAvailable: true }
    );
    if (!planning.ok) throw new Error(planning.reason);
    expect(planning.slides.map((s) => [s.strategy, s.needsGeneratedImage])).toEqual([
      ["generated_photo", true],
      ["generated_illustration", true],
      ["branded_graphic", false],
      ["branded_graphic", false],
    ]);
    expect(planning.slides[2].degradeReasons).toEqual(["Carousel v1 allows at most 2 generated slides."]);
  });

  it("text fit is decided before any paid call: too long for a layout → branded_graphic; too long for any → the carousel fails", () => {
    // Fits the 4-line typographic layout, not the proposal layout's 2 lines.
    const longForProposal = "Una propuesta solar clara reúne la información técnica del proyecto y la identidad de tu empresa en un documento.";
    expect(longForProposal.length).toBeGreaterThan(105);
    const planning = planCarouselSlides(carouselPlan(["proposal_document", "branded_graphic"]), approvedCarouselSlides({ body: slidesBody([longForProposal, "Corto"]) })!, selection, {
      generativeCapabilityAvailable: true,
    });
    if (!planning.ok) throw new Error(planning.reason);
    expect(planning.slides.map((s) => s.strategy)).toEqual(["branded_graphic", "branded_graphic"]);
    expect(planning.slides[0].degradeReasons).toEqual(["Approved slide text does not fit the proposal_document layout."]);

    const impossible = planCarouselSlides(carouselPlan(["branded_graphic", "branded_graphic"]), approvedCarouselSlides({ body: slidesBody(["ok", "Palabra ".repeat(60).trim()]) })!, selection, {
      generativeCapabilityAvailable: true,
    });
    expect(impossible).toEqual({ ok: false, reason: "The approved text of slide 2 is too long to render safely on a carousel slide without truncating it." });
  });

  it("generated slides need capability and a scene description", () => {
    const plan = carouselPlan(["generated_photo", "generated_photo"]);
    plan.slidePlans[1].generativeSceneDescription = null;
    const off = planCarouselSlides(plan, approvedCarouselSlides({ body: slidesBody(["a", "b"]) })!, selection, { generativeCapabilityAvailable: false });
    if (!off.ok) throw new Error(off.reason);
    expect(off.slides.map((s) => s.degradeReasons[0])).toEqual(["Generative imagery capability is not available.", "Generative imagery capability is not available."]);
    const on = planCarouselSlides(plan, approvedCarouselSlides({ body: slidesBody(["a", "b"]) })!, selection, { generativeCapabilityAvailable: true });
    if (!on.ok) throw new Error(on.reason);
    expect(on.slides[1]).toMatchObject({ strategy: "branded_graphic", degradeReasons: ["Generated slide had no scene description."] });
  });

  it("the fallback plan is a typographic carousel with one slide plan per slide", () => {
    expect(fallbackCarouselPlan(4).slidePlans.map((s) => [s.slideNumber, s.strategy])).toEqual([
      [1, "branded_graphic"],
      [2, "branded_graphic"],
      [3, "branded_graphic"],
      [4, "branded_graphic"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

describe("carousel generation", () => {
  it.each([3, 5, 6])("%i approved slides → exactly one Visual Director call and one carousel row with %i ordered JPEG slides", async (n) => {
    const texts = REAL_SLIDES.concat(["Empieza gratis hoy mismo."]).slice(0, n);
    const h = setup({ draft: { body: slidesBody(texts) }, plans: [carouselPlan(Array(n).fill("branded_graphic"))] });

    const outcome = await generateAsset({ db: h.db, storage: h.storage, draftId: DRAFT_ID, aiClient: h.aiClient, imageGenerationClient: h.imageClient });

    expect(outcome.status).toBe("success");
    expect(paid(h)).toEqual({ director: 1, singleDirector: 0, image: 0 });
    expect(assets(h)).toHaveLength(1);
    const asset = assets(h)[0];
    expect(asset).toMatchObject({ format: "carousel", status: "pending_review", asset_version: 1, mime_type: "image/jpeg", storage_path: `${DRAFT_ID}/v1/slide-1.jpg` });
    expect(asset.slides).toEqual(
      texts.map((_, i) => ({ position: i + 1, storage_path: `${DRAFT_ID}/v1/slide-${i + 1}.jpg`, width: 1080, height: 1350, mime_type: "image/jpeg" }))
    );
    for (const slide of asset.slides) {
      const meta = await sharp(h.storage.files.get(slide.storage_path)!).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", IMAGE_POST_WIDTH, IMAGE_POST_HEIGHT]);
    }
    // The approved slide texts are the Visual Director's slide list, in order.
    const { userPrompt, systemPrompt } = h.aiClient.carouselVisualDirectorCalls[0];
    texts.forEach((text, i) => expect(userPrompt).toContain(`${i + 1}. ${text}`));
    expect(systemPrompt).toMatch(/hybrid is NOT available inside a carousel/);
    expect(systemPrompt).toMatch(/deliberate progression from slide to slide/);
    expect(systemPrompt).toMatch(/Do not rotate strategies mechanically/);
  });

  it("CTA pill only on the last slide; every slide shares the version's theme", async () => {
    const h = setup();
    await generateAsset({ db: h.db, storage: h.storage, draftId: DRAFT_ID, aiClient: h.aiClient, imageGenerationClient: h.imageClient });
    const slides = provenanceOf(assets(h)[0]).carouselSlides as { rendered: { cta: unknown; theme: string } }[];
    expect(slides.map((s) => s.rendered.cta === null)).toEqual([true, true, true, true, false]);
    expect(new Set(slides.map((s) => s.rendered.theme))).toEqual(new Set(["a"]));
  });

  it("renders the mixed per-slide treatments it was planned with (product, proposal, generated, typography)", async () => {
    const h = setup();
    await generateAsset({ db: h.db, storage: h.storage, draftId: DRAFT_ID, aiClient: h.aiClient, imageGenerationClient: h.imageClient });
    const slides = provenanceOf(assets(h)[0]).carouselSlides as { strategy: string; rendered: { renderer: string } }[];
    expect(slides.map((s) => [s.strategy, s.rendered.renderer])).toEqual([
      ["branded_graphic", "svg-sharp-v1"],
      ["generated_photo", "svg-sharp-hero-v1"],
      ["product_ui", "svg-sharp-product-v1"],
      ["proposal_document", "svg-sharp-proposal-v1"],
      ["branded_graphic", "svg-sharp-v1"],
    ]);
  });

  it("the i/N marker is deterministic and actually drawn", async () => {
    const base = await sharp({ create: { width: IMAGE_POST_WIDTH, height: IMAGE_POST_HEIGHT, channels: 3, background: "#0F172A" } }).png().toBuffer();
    const a = await addSlideMarker(base, 2, 5);
    const b = await addSlideMarker(base, 2, 5);
    expect(Buffer.compare(a, b)).toBe(0);
    expect(Buffer.compare(a, await addSlideMarker(base, 3, 5))).not.toBe(0);
    const { data } = await sharp(a).extract({ left: IMAGE_POST_WIDTH - 140, top: 64, width: 76, height: 44 }).raw().toBuffer({ resolveWithObject: true });
    expect(data.some((v) => v > 150)).toBe(true); // white outlined digits inside the chip
  });

  it("each generated slide source is cached under version+position, and Regenerate reuses it with ZERO paid calls", async () => {
    const h = setup();
    await generateAsset({ db: h.db, storage: h.storage, draftId: DRAFT_ID, aiClient: h.aiClient, imageGenerationClient: h.imageClient });
    expect(paid(h)).toEqual({ director: 1, singleDirector: 0, image: 1 });
    expect(h.storage.files.has(`${DRAFT_ID}/generated/v1/slide-2.png`)).toBe(true);

    const regenerated = await generateAsset({ db: h.db, storage: h.storage, draftId: DRAFT_ID, aiClient: h.aiClient, imageGenerationClient: h.imageClient });

    expect(regenerated.status).toBe("success");
    expect(paid(h)).toEqual({ director: 1, singleDirector: 0, image: 1 }); // never paid again
    const v2 = assets(h).find((a) => a.asset_version === 2)!;
    const slide2 = provenanceOf(v2).carouselSlides[1] as { strategy: string; generatedImage: { reused: boolean; storagePath: string } };
    expect(slide2).toMatchObject({ strategy: "generated_photo", generatedImage: { reused: true, storagePath: `${DRAFT_ID}/generated/v1/slide-2.png` } });
    expect(provenanceOf(v2).visualPlan.origin).toBe("reused_plan");
    expect(v2.slides.map((s) => s.storage_path)).toEqual(REAL_SLIDES.map((_, i) => `${DRAFT_ID}/v2/slide-${i + 1}.jpg`));
  });

  it("a failed image call downgrades only that slide; the carousel still completes", async () => {
    const imageClient = new ScriptedImageGenerationClient();
    imageClient.failNextCalls = 1;
    const h = setup({ imageClient, plans: [carouselPlan(["generated_photo", "branded_graphic", "generated_illustration"])], draft: { body: slidesBody(REAL_SLIDES.slice(0, 3)) } });
    const outcome = await generateAsset({ db: h.db, storage: h.storage, draftId: DRAFT_ID, aiClient: h.aiClient, imageGenerationClient: imageClient });
    expect(outcome.status).toBe("success");
    const slides = provenanceOf(assets(h)[0]).carouselSlides as { strategy: string; requestedStrategy: string; degradeReasons: string[] }[];
    expect(slides.map((s) => s.strategy)).toEqual(["branded_graphic", "branded_graphic", "generated_illustration"]);
    expect(slides[0].degradeReasons[0]).toMatch(/^Image generation failed:/);
    expect(imageClient.calls).toHaveLength(2);
  });

  it("aggregate Budget Guard: if the budget can't cover every planned image, NO paid image call is made", async () => {
    const h = setup({ plans: [carouselPlan(["generated_photo", "generated_photo", "branded_graphic"])], draft: { body: slidesBody(REAL_SLIDES.slice(0, 3)) } });
    // Effective stop is $9.50: the director call and ONE image (~$0.026) would fit, two images would not.
    h.fake.seed("ai_usage", [
      { id: "u1", agent_run_id: null, brand: "solardesk", operation: "executor", model: "gpt-5.6-luna", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, estimated_cost_usd: 9.455, created_at: new Date().toISOString() },
    ]);
    const outcome = await generateAsset({ db: h.db, storage: h.storage, draftId: DRAFT_ID, aiClient: h.aiClient, imageGenerationClient: h.imageClient });

    expect(outcome.status).toBe("success");
    expect(h.imageClient.calls).toHaveLength(0);
    const slides = provenanceOf(assets(h)[0]).carouselSlides as { strategy: string; degradeReasons: string[] }[];
    expect(slides.map((s) => s.strategy)).toEqual(["branded_graphic", "branded_graphic", "branded_graphic"]);
    expect(slides[0].degradeReasons[0]).toMatch(/^Image generation budget blocked for 2 generated slide\(s\):/);
  });

  it("per-call Budget Guard still decides before each paid call (a costly first image blocks the second)", async () => {
    const imageClient = new ScriptedImageGenerationClient([
      { png: (await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123456" } }).png().toBuffer()), model: "gpt-image-1", usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 30_000_000 } },
    ]);
    const h = setup({ imageClient, plans: [carouselPlan(["generated_photo", "generated_photo", "branded_graphic"])], draft: { body: slidesBody(REAL_SLIDES.slice(0, 3)) } });
    await generateAsset({ db: h.db, storage: h.storage, draftId: DRAFT_ID, aiClient: h.aiClient, imageGenerationClient: imageClient });
    expect(imageClient.calls).toHaveLength(1);
    const slides = provenanceOf(assets(h)[0]).carouselSlides as { strategy: string; degradeReasons: string[] }[];
    expect(slides[1]).toMatchObject({ strategy: "branded_graphic" });
    expect(slides[1].degradeReasons[0]).toMatch(/^Image generation budget blocked:/);
  });

  it("an invalid plan shape falls back for the WHOLE carousel (typographic), recorded — never a partial plan", async () => {
    const h = setup({ plans: [carouselPlan(["generated_photo", "product_ui"])] }); // 2 plans for 5 slides
    await generateAsset({ db: h.db, storage: h.storage, draftId: DRAFT_ID, aiClient: h.aiClient, imageGenerationClient: h.imageClient });
    const asset = assets(h)[0];
    expect(provenanceOf(asset).visualPlan).toMatchObject({ origin: "fallback", strategy: "branded_graphic", degraded: true });
    expect(provenanceOf(asset).visualPlan.degradeReason).toMatch(/2 slide plans for a 5-slide carousel/);
    expect(h.imageClient.calls).toHaveLength(0);
    expect(asset.slides).toHaveLength(5);
  });

  it("a slide text that can't fit anywhere fails the carousel before ANY paid image call — one failed row, nothing exposed", async () => {
    const h = setup({ plans: [carouselPlan(["generated_photo", "branded_graphic", "branded_graphic"])], draft: { body: slidesBody(["uno", "dos", "Palabra ".repeat(60).trim()]) } });
    const outcome = await generateAsset({ db: h.db, storage: h.storage, draftId: DRAFT_ID, aiClient: h.aiClient, imageGenerationClient: h.imageClient });
    expect(outcome.status).toBe("failed");
    expect(h.imageClient.calls).toHaveLength(0);
    expect(assets(h)).toEqual([expect.objectContaining({ status: "generation_failed", format: "carousel", slides: [] })]);
  });

  it("a storage failure mid-carousel records ONE generation_failed row naming the slide, with the cached generated source, and a retry reuses it", async () => {
    class FailingSlide3Storage extends FakeAssetStorage {
      failed = false;
      async upload(path: string, data: Buffer): Promise<void> {
        if (!this.failed && path.endsWith("/v1/slide-3.jpg")) {
          this.failed = true;
          throw new AssetStorageError("Simulated storage failure.");
        }
        return super.upload(path, data);
      }
    }
    const h = setup({ storage: new FailingSlide3Storage() });
    const first = await generateAsset({ db: h.db, storage: h.storage, draftId: DRAFT_ID, aiClient: h.aiClient, imageGenerationClient: h.imageClient });

    expect(first.status).toBe("failed");
    expect(assets(h)).toHaveLength(1);
    const failed = assets(h)[0];
    expect(failed).toMatchObject({ status: "generation_failed", format: "carousel", slides: [] });
    expect(failed.error_message).toMatch(/Storage upload failed for slide 3 of 5/);
    expect(provenanceOf(failed).failedSlide).toBe(3);
    expect((provenanceOf(failed).carouselSlides[1] as { generatedImage: { storagePath: string } }).generatedImage.storagePath).toBe(`${DRAFT_ID}/generated/v1/slide-2.png`);

    const retry = await generateAsset({ db: h.db, storage: h.storage, draftId: DRAFT_ID, aiClient: h.aiClient, imageGenerationClient: h.imageClient });
    expect(retry.status).toBe("success");
    expect(paid(h)).toEqual({ director: 1, singleDirector: 0, image: 1 }); // the retry paid nothing
  });

  it("Facebook carousels remain unsupported", async () => {
    const h = setup({ draft: { channel: "facebook" } });
    const outcome = await generateAsset({ db: h.db, storage: h.storage, draftId: DRAFT_ID, aiClient: h.aiClient, imageGenerationClient: h.imageClient });
    expect(outcome).toMatchObject({ status: "ineligible", message: expect.stringMatching(/only supported for Instagram/) });
    expect(paid(h)).toEqual({ director: 0, singleDirector: 0, image: 0 });
  });

  it("the carousel appears in visual history (layout carousel, dominant strategy, its sources) and records its own variety assessment", async () => {
    const h = setup();
    await generateAsset({ db: h.db, storage: h.storage, draftId: DRAFT_ID, aiClient: h.aiClient, imageGenerationClient: h.imageClient });
    const asset = assets(h)[0];
    expect(provenanceOf(asset).visualPlan.varietyAssessment).toMatchObject({ comparedEntries: 0 });

    const history = await getRecentVisualHistory(h.db, "solardesk");
    expect(history.entries).toEqual([
      expect.objectContaining({
        channel: "instagram",
        status: "pending_review",
        layout: "carousel",
        strategy: "branded_graphic",
        generatedImage: true,
        sourceFingerprint: "carousel(none | generated | screenshot:04.png | proposal:propuesta-sistema-solar-residencial#p1+p2)",
      }),
    ]);
    expect(history.summary.sourceCounts).toMatchObject({ "screenshot:04.png": 1, "proposal:propuesta-sistema-solar-residencial#p1+p2": 1 });
  });
});

// ---------------------------------------------------------------------------
// Continuation + finished review email
// ---------------------------------------------------------------------------

describe("carousel continuation and review email", () => {
  it("one approved Instagram carousel → one asset → exactly ONE review email with every slide in order and ONE approve action", async () => {
    const h = setup();
    const outcome = await continueApprovedImagePost(h.continuation, DRAFT_ID);

    expect(outcome).toMatchObject({ status: "review_sent", generated: true });
    expect(h.emailClient.sendCalls).toHaveLength(1);
    const email = h.emailClient.sendCalls[0];
    expect(email.subject).toContain("Carrusel listo para publicar en Instagram");
    expect(email.subject).toContain("contenido v1, carrusel v1");
    expect(email.inlineAttachments!.map((a) => a.filename)).toEqual([1, 2, 3, 4, 5].map((i) => `solardesk-carousel-v1-slide-${i}.jpg`));
    const order = [1, 2, 3, 4, 5].map((i) => email.html.indexOf(`cid:solardesk-carousel-v1-slide-${i}`));
    expect(order.every((pos, i) => pos > 0 && (i === 0 || pos > order[i - 1]))).toBe(true);
    [1, 2, 3, 4, 5].forEach((i) => expect(email.text).toContain(`Diapositiva ${i}/5`));
    REAL_SLIDES.forEach((text) => expect(email.text).toContain(`Texto en la imagen: ${text}`));
    expect(email.text).toContain("Destino: Instagram");
    expect(email.text).toContain(composeFinalSocialCaption(h.fake.getAll("content_drafts")[0] as unknown as ContentDraftRow));
    expect(email.text.match(/Aprobar publicación: /g)).toHaveLength(1);
    expect(email.html).not.toMatch(/solardesk-assets|\/v1\/slide-|generated\//); // no storage paths
    expect(h.fake.getAll("email_action_tokens")).toEqual([
      expect.objectContaining({ action: "approve_asset", subject_type: "content_asset", subject_id: assets(h)[0].id, subject_version: 1 }),
    ]);
  });

  it("retries and concurrent continuations never regenerate, never pay twice, never send a second email", async () => {
    const h = setup();
    await Promise.all([continueApprovedImagePost(h.continuation, DRAFT_ID), continueApprovedImagePost(h.continuation, DRAFT_ID)]);
    expect(await continueApprovedImagePost(h.continuation, DRAFT_ID)).toEqual({ status: "review_already_sent" });
    expect(assets(h)).toHaveLength(1);
    expect(paid(h)).toEqual({ director: 1, singleDirector: 0, image: 1 });
    expect(h.emailClient.sendCalls).toHaveLength(1);
  });

  it("a generation failure never sends a review and is not retried automatically", async () => {
    const h = setup({ draft: { body: slidesBody(["uno", "dos", "Palabra ".repeat(60).trim()]) }, plans: [carouselPlan(["branded_graphic", "branded_graphic", "branded_graphic"])] });
    expect((await continueApprovedImagePost(h.continuation, DRAFT_ID)).status).toBe("generation_failed");
    expect(await continueApprovedImagePost(h.continuation, DRAFT_ID)).toMatchObject({ status: "asset_not_reviewable" });
    expect(h.emailClient.sendCalls).toHaveLength(0);
    expect(paid(h).director).toBe(1);
  });

  it("an email delivery failure is retried later WITHOUT regenerating", async () => {
    const h = setup({ emailClient: new ScriptedEmailClient({ failSequence: [emailRejection("Resend rejected the email send request: boom"), null] }) });
    expect((await continueApprovedImagePost(h.continuation, DRAFT_ID)).status).toBe("review_delivery_failed");
    expect((await runPostApprovalContinuationSweep(h.continuation)).outcomes).toEqual(["review_sent"]);
    expect(assets(h)).toHaveLength(1);
    expect(paid(h)).toEqual({ director: 1, singleDirector: 0, image: 1 });
  });

  it("the recovery sweep continues an approved, email-enrolled Instagram carousel that has no asset yet", async () => {
    const h = setup();
    expect((await runPostApprovalContinuationSweep(h.continuation)).outcomes).toEqual(["review_sent"]);
    expect(assets(h)[0].format).toBe("carousel");
  });

  it("an older carousel version's approval email is stale once a newer version exists; the new one approves", async () => {
    const h = setup();
    await continueApprovedImagePost(h.continuation, DRAFT_ID);
    await generateAsset({ db: h.db, storage: h.storage, draftId: DRAFT_ID }); // v2 (zero paid calls)
    await runPostApprovalContinuationSweep(h.continuation);
    const [v1Email, v2Email] = h.emailClient.sendCalls;
    expect(v2Email.subject).toContain("carrusel v2");

    expect((await confirmEmailAction(h.db, tokenIn(v1Email.text))).result).toBe("stale");
    expect((await confirmEmailAction(h.db, tokenIn(v2Email.text))).result).toBe("applied");
    expect(assets(h).map((a) => [a.asset_version, a.status])).toEqual([
      [1, "pending_review"],
      [2, "ready_to_publish"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Instagram carousel publication
// ---------------------------------------------------------------------------

async function approvedCarousel(h: Harness) {
  await continueApprovedImagePost(h.continuation, DRAFT_ID);
  expect((await confirmEmailAction(h.db, tokenIn(h.emailClient.sendCalls.at(-1)!.text))).result).toBe("applied");
  return assets(h).at(-1)!;
}
const publicationRow = (h: Harness) => h.fake.getAll("asset_publications")[0] as { status: string; error_message: string | null; meta_post_id: string | null };

describe("Instagram carousel publication", () => {
  it("items in exact slide order without captions → one parent with ordered children and the final caption → exactly ONE media_publish", async () => {
    const h = setup();
    const asset = await approvedCarousel(h);

    expect(await publishEmailAuthorizedAsset(h.publication, asset.id)).toEqual({ status: "published", channel: "instagram" });

    const ig = h.instagramClient;
    expect(ig.carouselItemCalls.map((c) => c.imageUrl)).toEqual(asset.slides.map((s) => `https://fake-storage.local/${s.storage_path}?signed=1`));
    ig.carouselItemCalls.forEach((c) => expect(Object.keys(c)).toEqual(["imageUrl"])); // no caption on items
    expect(ig.carouselContainerCalls).toEqual([
      { children: ["ig-item-1", "ig-item-2", "ig-item-3", "ig-item-4", "ig-item-5"], caption: composeFinalSocialCaption(h.fake.getAll("content_drafts")[0] as unknown as ContentDraftRow) },
    ]);
    expect(ig.mutatingCalls).toEqual(["item:1", "item:2", "item:3", "item:4", "item:5", "carousel", "publish:ig-carousel-1"]);
    expect(ig.publishCalls).toEqual(["ig-carousel-1"]);
    expect(ig.createCalls).toHaveLength(0); // never the single-image path
    expect(ig.statusCalls).toEqual(["ig-item-1", "ig-item-2", "ig-item-3", "ig-item-4", "ig-item-5", "ig-carousel-1"]);
    expect(h.fake.getAll("asset_publications")).toEqual([expect.objectContaining({ channel: "instagram", status: "published", meta_post_id: "ig-carousel-media-1" })]);
  });

  it("after() + cron racing produce ONE claim and ONE public carousel", async () => {
    const h = setup();
    const asset = await approvedCarousel(h);
    await Promise.all([publishEmailAuthorizedAsset(h.publication, asset.id), runPublicationRecoverySweep(h.publication), publishEmailAuthorizedAsset(h.publication, asset.id)]);
    expect(h.instagramClient.publishCalls).toHaveLength(1);
    expect(h.fake.getAll("asset_publications")).toHaveLength(1);
    expect(publicationRow(h).status).toBe("published");
  });

  it.each([
    ["an authoritative item rejection", { failCarouselItemAt: { index: 2, error: instagramRejection("Meta Graph API rejected the carousel item container request: bad image") } }],
    ["an uncertain item-creation failure (items are never public)", { failCarouselItemAt: { index: 2, error: instagramUncertainFailure() } }],
    ["an item readiness ERROR", { statusByContainer: { "ig-item-3": ["ERROR" as const] } }],
    ["an item readiness timeout", { statusByContainer: { "ig-item-3": ["IN_PROGRESS" as const] } }],
    ["a parent creation failure", { failCarouselContainerWith: instagramUncertainFailure() }],
    ["a parent readiness EXPIRED", { statusByContainer: { "ig-carousel-1": ["EXPIRED" as const] } }],
    ["an authoritative media_publish rejection", { failPublishWith: instagramRejection("Meta Graph API rejected the media request: rate limited") }],
  ])("%s before anything is public is retry-safe, and the recovery sweep then publishes exactly once", async (_label, options) => {
    const instagramClient = new ScriptedInstagramClient({ mediaId: "ig-carousel-media-1", ...options });
    const h = setup({ instagramClient });
    const asset = await approvedCarousel(h);

    expect((await publishEmailAuthorizedAsset(h.publication, asset.id)).status).toBe("failed_retryable");
    expect(publicationRow(h).status).toBe("failed");
    expect(publicationRow(h).error_message!.startsWith(RETRY_SAFE_FAILURE_MARKER)).toBe(true);
    const publishesBefore = h.instagramClient.publishCalls.length;
    expect(publishesBefore).toBeLessThanOrEqual(1);

    await runPublicationRecoverySweep(h.publication);
    expect(publicationRow(h).status).toBe("published");
    expect(h.instagramClient.publishCalls.length - publishesBefore).toBe(1);
  });

  it.each([
    ["a media_publish network failure", { failPublishWith: instagramUncertainFailure() }],
    ["a media_publish 5xx/non-JSON", { failPublishWith: instagramUncertainFailure("Meta Graph API returned a non-JSON response (HTTP 502).") }],
    ["a success-like response without a media id", { failPublishWith: instagramUncertainFailure("Meta Graph API returned success but no media id.") }],
    ["a parent reported PUBLISHED before our publish call", { statusByContainer: { "ig-carousel-1": ["PUBLISHED" as const] } }],
    ["an item reported PUBLISHED", { statusByContainer: { "ig-item-2": ["PUBLISHED" as const] } }],
  ])("%s is UNCERTAIN: held in 'publishing', never retried automatically or manually", async (_label, options) => {
    const instagramClient = new ScriptedInstagramClient({ mediaId: "ig-carousel-media-1", ...options });
    const h = setup({ instagramClient });
    const asset = await approvedCarousel(h);

    expect((await publishEmailAuthorizedAsset(h.publication, asset.id)).status).toBe("failed_uncertain_held");
    expect(publicationRow(h).status).toBe("publishing");
    expect(publicationRow(h).error_message!.startsWith(UNCERTAIN_OUTCOME_MARKER)).toBe(true);
    const publishes = h.instagramClient.publishCalls.length;

    await runPublicationRecoverySweep(h.publication);
    await publishEmailAuthorizedAsset(h.publication, asset.id);
    expect(h.instagramClient.publishCalls.length).toBe(publishes);
    expect(publicationRow(h).status).toBe("publishing");
  });

  it("the single-image Instagram publisher refuses a carousel asset (no accidental single-image post)", async () => {
    const h = setup();
    const asset = await approvedCarousel(h);
    const outcome = await publishAssetToInstagram({ db: h.db, storage: h.storage, instagramClient: h.instagramClient, draftId: DRAFT_ID, assetId: asset.id, delay: noDelay });
    expect(outcome.status).toBe("ineligible");
    expect(h.instagramClient.mutatingCalls).toEqual([]);
  });

  it("a carousel asset is never auto-published to Facebook", async () => {
    const h = setup();
    const asset = await approvedCarousel(h);
    h.fake.seed("content_drafts", [carouselDraft({ channel: "facebook" })]);
    expect(await publishEmailAuthorizedAsset(h.publication, asset.id)).toMatchObject({ status: "not_eligible" });
    expect(h.instagramClient.mutatingCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The real pending carousel as the first production smoke (mocked end to end)
// ---------------------------------------------------------------------------

describe("production-shaped: today's pending 5-slide carousel", () => {
  it("existing content-review token → approve → carousel generated → one review email → approve once → one Instagram carousel", async () => {
    const h = setup({ draft: { status: "pending_approval", approved_at: null } });
    // The content-review email that already went out on 2026-09-25 (v1 tokens).
    const contentTokens = await createEmailActionTokens(h.db, {
      notificationId: "outbox-content-1",
      brand: "solardesk",
      subjectType: "content_draft",
      subjectId: DRAFT_ID,
      subjectVersion: 1,
      actions: ["approve_draft", "reject_draft"],
      now: new Date(),
    });

    expect((await confirmEmailAction(h.db, contentTokens.approve_draft!)).result).toBe("applied");
    expect(h.fake.getAll("content_drafts")[0].status).toBe("approved");

    expect((await continueApprovedImagePost(h.continuation, DRAFT_ID)).status).toBe("review_sent");
    expect(assets(h)).toEqual([expect.objectContaining({ format: "carousel", status: "pending_review" })]);
    expect(assets(h)[0].slides).toHaveLength(5);
    expect(h.emailClient.sendCalls).toHaveLength(1);

    expect((await confirmEmailAction(h.db, tokenIn(h.emailClient.sendCalls[0].text))).result).toBe("applied");
    expect(await publishEmailAuthorizedAsset(h.publication, assets(h)[0].id)).toEqual({ status: "published", channel: "instagram" });

    expect(h.instagramClient.carouselItemCalls).toHaveLength(5);
    expect(h.instagramClient.publishCalls).toHaveLength(1);
    expect(h.fake.getAll("asset_publications")).toEqual([expect.objectContaining({ status: "published", channel: "instagram" })]);
    expect(paid(h)).toEqual({ director: 1, singleDirector: 0, image: 1 });
  });
});
