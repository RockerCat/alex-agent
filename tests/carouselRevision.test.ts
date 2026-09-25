import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentDraftRow, ContentAssetRow } from "@/lib/types/database";
import { renderImagePostAsset } from "@/lib/agent/assetRenderer";
import { PROPOSAL_EXAMPLE, PROPOSAL_FOCUS_REGIONS } from "@/lib/agent/proposalExamples";
import {
  carouselVisualPlanSchema,
  carouselVisualRevisionOutputSchema,
  carouselVisualDirectorOutputSchema,
  DEFAULT_RENDER_SPEC,
  type CarouselVisualPlan,
} from "@/lib/agent/schemas";
import { approvedCarouselSlides, findRepeatedTreatments, planCarouselSlides, slideTreatmentSignature } from "@/lib/agent/carouselPlan";
import { describeAssetTreatment, proposalSourceFingerprint } from "@/lib/agent/visualHistory";
import { buildCarouselVisualDirectorPrompt } from "@/lib/agent/visualDirector";
import { emptyVisualHistory } from "@/lib/agent/visualHistory";
import { requestCarouselVisualRevision, CAROUSEL_REVISION_NO_NEW_IMAGES_REASON } from "@/lib/agent/carouselRevision";
import { continueApprovedImagePost, runRegeneratedAssetReviewSafely, type ContinuationDeps } from "@/lib/agent/postApprovalContinuation";
import { confirmEmailAction } from "@/lib/agent/emailActions";
import { composeFinalSocialCaption } from "@/lib/agent/finalCaption";
import { createFakeDb, asSupabaseClient, type FakeDb } from "@/tests/support/fakeDb";
import { FakeAssetStorage } from "@/tests/support/fakeAssetStorage";
import { ScriptedAiClient, carouselPlan } from "@/tests/support/fakeAiClient";
import { ScriptedImageGenerationClient } from "@/tests/support/fakeImageGenerationClient";
import { ScriptedEmailClient } from "@/tests/support/fakeEmailClient";
import { seedDefaultSettings } from "@/tests/support/seed";

// Carousel visual revision v1 + verified proposal focus views. Motivated
// by the first real production carousel (2026-09-25): slides 2 and 4
// used the same strategy, the same proposal pages and the same
// composition. Scripted AI/image/email only; nothing real is called.

const DRAFT_ID = "aaaaaaaa-1111-4111-8111-000000000001";
const PLAN_ID = "aaaaaaaa-2222-4222-8222-000000000002";
const REAL_SLIDES = [
  "Una propuesta solar clara reúne la información del proyecto y la identidad de tu empresa.",
  "Presenta estimaciones de sistema, producción, costos y retorno de forma organizada.",
  "Comparte un enlace interactivo para que tu cliente consulte la propuesta en línea.",
  "También puedes obtener un PDF profesional para compartirlo por el canal que prefieras.",
  "Las cifras son demostrativas: dependen de los datos ingresados y de los supuestos del proyecto.",
];
const CRITIQUE =
  "Slides 2 and 4 look practically identical. Preserve the approved copy and the good overall concept, but make repeated proposal evidence materially distinct. Preserve the other successful treatments where appropriate.";
const OVERVIEW_FP = "proposal:propuesta-sistema-solar-residencial#p1+p2";
const FINANCIAL_FP = "proposal:propuesta-sistema-solar-residencial#p2@financial_detail";
const SYSTEM_FP = "proposal:propuesta-sistema-solar-residencial#p2@system_detail";

function draftRow(overrides: Partial<ContentDraftRow> = {}): Record<string, unknown> {
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
    body: { slides: REAL_SLIDES.map((text, i) => ({ slide: i + 1, text })) },
    caption: "Una propuesta solar no solo reúne cálculos. #SolarDesk #EnergíaSolar",
    cta_text: "Comenzar gratis",
    visual_direction: "Mostrar la evolución desde la información técnica hasta una propuesta profesional lista para presentar.",
    hashtags: ["#SolarDesk", "#EnergíaSolar", "#PropuestasComerciales", "#InstaladoresSolares"],
    blocked_on_question_id: null,
    approved_at: "2026-09-25T21:05:46Z",
    rejected_at: null,
    created_at: "2026-09-25T13:01:19Z",
    updated_at: "2026-09-25T13:01:19Z",
    ...overrides,
  };
}

/** The real v1 plan shape: illustration, proposal, illustration, proposal (same view), branded CTA. */
const V1_PLAN = carouselPlan(["generated_illustration", "proposal_document", "generated_illustration", "proposal_document", "branded_graphic"]);

/** A revision plan: reuse slides 1 and 3's images, distinct proposal views on 2 and 4. */
function revisionPlan(overrides: { slide2?: Record<string, unknown>; slide4?: Record<string, unknown>; top?: Partial<CarouselVisualPlan>; slide1?: Record<string, unknown>; slide3?: Record<string, unknown> } = {}): CarouselVisualPlan {
  const base = carouselPlan(["generated_illustration", "proposal_document", "generated_illustration", "proposal_document", "branded_graphic"]);
  const sp = base.slidePlans;
  return {
    ...base,
    creativeConcept: "Del dato técnico al resultado, con evidencia real distinta en cada paso.",
    varietyRationale: "Mantiene las ilustraciones y distingue la evidencia de propuesta por vista.",
    repetitionJustification: null,
    ...overrides.top,
    slidePlans: [
      { ...sp[0], generativeSceneDescription: "Una escena reescrita que no debe reemplazar la original.", reuseGeneratedFromSlide: 1, proposalFocus: null, intentionalRepeatOf: null, ...overrides.slide1 },
      { ...sp[1], proposalFocus: "financial_detail", reuseGeneratedFromSlide: null, intentionalRepeatOf: null, ...overrides.slide2 },
      { ...sp[2], reuseGeneratedFromSlide: 3, proposalFocus: null, intentionalRepeatOf: null, ...overrides.slide3 },
      { ...sp[3], proposalFocus: "overview", reuseGeneratedFromSlide: null, intentionalRepeatOf: null, ...overrides.slide4 },
      { ...sp[4], proposalFocus: null, reuseGeneratedFromSlide: null, intentionalRepeatOf: null },
    ],
  } as CarouselVisualPlan;
}

interface Harness {
  fake: FakeDb;
  db: SupabaseClient<Database>;
  storage: FakeAssetStorage;
  aiClient: ScriptedAiClient;
  imageClient: ScriptedImageGenerationClient;
  emailClient: ScriptedEmailClient;
  deps: ContinuationDeps;
}

/** v1 exactly as production produced it: approved content → continuation → carousel v1 + its review email. */
async function withCarouselV1(): Promise<Harness> {
  const fake = createFakeDb();
  seedDefaultSettings(fake);
  fake.seed("marketing_plans", [{ id: PLAN_ID, brand: "solardesk", primary_objective: "SIGNUPS", status: "active" }]);
  fake.seed("content_drafts", [draftRow()]);
  fake.seed("notification_outbox", [
    { id: "outbox-content-1", brand: "solardesk", channel: "email", notification_type: "draft_pending_approval", subject_type: "content_draft", subject_id: DRAFT_ID, subject_version: 1, status: "sent", updated_at: "2026-09-25T13:01:29Z" },
  ]);
  fake.seed("content_assets", []);
  fake.seed("asset_publications", []);
  const db = asSupabaseClient<SupabaseClient<Database>>(fake);
  const storage = new FakeAssetStorage();
  const aiClient = new ScriptedAiClient([], [], undefined, undefined, [V1_PLAN]);
  const imageClient = new ScriptedImageGenerationClient();
  const emailClient = new ScriptedEmailClient();
  const deps: ContinuationDeps = {
    db,
    storage,
    aiClient,
    imageGenerationClient: imageClient,
    emailClient,
    addressing: { from: "AlexAgent <review@mail.agent.alexsosa.me>", to: "owner@example.test" },
    baseUrl: "https://agent.alexsosa.me",
  };
  expect((await continueApprovedImagePost(deps, DRAFT_ID)).status).toBe("review_sent");
  expect(imageClient.calls).toHaveLength(2);
  return { fake, db, storage, aiClient, imageClient, emailClient, deps };
}

const assets = (h: Harness) => (h.fake.getAll("content_assets") as unknown as ContentAssetRow[]).sort((a, b) => a.asset_version - b.asset_version);
const planOf = (a: ContentAssetRow) => (a.render_provenance as { visualPlan: Record<string, unknown> }).visualPlan;
const slidesOf = (a: ContentAssetRow) =>
  (a.render_provenance as { carouselSlides: { position: number; strategy: string; proposalFocus?: string; degradeReasons: string[]; generatedImage: { used: boolean; reused?: boolean; storagePath?: string }; rendered: Record<string, unknown> }[] }).carouselSlides;
const tokenIn = (text: string) => text.match(/#t=([A-Za-z0-9_-]{43})/)![1];
const revise = (h: Harness, critique = CRITIQUE) => requestCarouselVisualRevision({ db: h.db, storage: h.storage, aiClient: h.aiClient, draftId: DRAFT_ID, critique });

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("OPENAI_IMAGE_MODEL", "gpt-image-1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Verified proposal focus views
// ---------------------------------------------------------------------------

describe("verified proposal focus views", () => {
  const spec = { ...DEFAULT_RENDER_SPEC, primaryVisualScale: "large" as const };
  const render = (proposalFocus?: "overview" | "financial_detail" | "system_detail") =>
    renderImagePostAsset({ headline: REAL_SLIDES[1], ctaText: null, assetVersion: 2, renderSpec: spec, strategy: "proposal_document", forceProposalMeta: PROPOSAL_EXAMPLE, forceScreenshotMeta: null, proposalFocus });

  it("overview renders byte-for-byte through the original treatment (and so does an absent focus)", async () => {
    const legacy = await render();
    const overview = await render("overview");
    expect(Buffer.compare(legacy.png, overview.png)).toBe(0);
    expect(legacy.provenance.proposalExample).toEqual(overview.provenance.proposalExample);
    expect((overview.provenance.proposalExample as Record<string, unknown>).view).toBeUndefined();
  });

  it.each([
    ["financial_detail", FINANCIAL_FP],
    ["system_detail", SYSTEM_FP],
  ] as const)("%s renders a verified page-2 region, records it, and fingerprints distinctly", async (view, fingerprint) => {
    const result = await render(view);
    expect(result.provenance.proposalExample).toMatchObject({
      selected: true,
      view,
      pages: ["brands/solardesk/assets/proposal-examples/rendered/page-2.png"],
      region: PROPOSAL_FOCUS_REGIONS[view].region,
      disclosureText: "Propuesta de ejemplo · Valores ilustrativos",
    });
    expect(describeAssetTreatment(result.provenance)!.sourceFingerprint).toBe(fingerprint);
    const meta = await sharp(result.png).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1350]);
    expect(Buffer.compare(result.png, (await render("overview")).png)).not.toBe(0);
  });

  it("the verified regions lie inside page 2 and don't overlap each other", async () => {
    const page = await sharp(await readFile("brands/solardesk/assets/proposal-examples/rendered/page-2.png")).metadata();
    const f = PROPOSAL_FOCUS_REGIONS.financial_detail.region;
    const s = PROPOSAL_FOCUS_REGIONS.system_detail.region;
    for (const r of [f, s]) expect(r.x >= 0 && r.y >= 0 && r.x + r.width <= page.width! && r.y + r.height <= page.height!).toBe(true);
    expect(f.y + f.height).toBeLessThanOrEqual(s.y);
  });

  it("the three views have three distinct canonical fingerprints; overview stays comparable with older assets", () => {
    const pdf = PROPOSAL_EXAMPLE.pdfPath;
    expect(proposalSourceFingerprint(pdf, ["page-1.png", "page-2.png"], "overview")).toBe(OVERVIEW_FP);
    expect(proposalSourceFingerprint(pdf, ["page-1.png", "page-2.png"])).toBe(OVERVIEW_FP);
    expect(new Set([OVERVIEW_FP, FINANCIAL_FP, SYSTEM_FP]).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Schemas, planning and treatment signatures
// ---------------------------------------------------------------------------

describe("carousel plan schemas and treatment signatures", () => {
  const approved = approvedCarouselSlides({ body: { slides: REAL_SLIDES.map((text, i) => ({ slide: i + 1, text })) } })!;
  const selection = { visualDirection: "Mostrar la propuesta final en PDF", purpose: "p", topic: "t" };
  const plan = (p: CarouselVisualPlan) => {
    const planned = planCarouselSlides(p, approved, selection, { generativeCapabilityAvailable: true });
    if (!planned.ok) throw new Error(planned.reason);
    return planned.slides;
  };

  it("an old stored carousel plan without the new fields still parses, and its proposal slides mean 'overview'", () => {
    const parsed = carouselVisualPlanSchema.safeParse({ ...V1_PLAN, varietyRationale: undefined });
    expect(parsed.success).toBe(true);
    expect(plan(parsed.data!).filter((s) => s.strategy === "proposal_document").map((s) => s.proposalFocus)).toEqual(["overview", "overview"]);
  });

  it("new model outputs must state proposalFocus / intentionalRepeatOf / repetitionJustification (nullable); revisions also reuseGeneratedFromSlide", () => {
    expect(carouselVisualDirectorOutputSchema.safeParse(V1_PLAN).success).toBe(false);
    expect(carouselVisualRevisionOutputSchema.safeParse(revisionPlan()).success).toBe(true);
    const keys = Object.keys(carouselVisualRevisionOutputSchema.shape.slidePlans.element.shape).concat(Object.keys(carouselVisualRevisionOutputSchema.shape));
    expect(keys).not.toEqual(expect.arrayContaining(["text"]));
    for (const forbidden of ["text", "caption", "cta", "ctaText", "ctaUrl", "hashtags", "hook", "slides"]) expect(keys).not.toContain(forbidden);
  });

  it("same strategy + same source + same view IS an identical treatment; a different verified view is NOT", () => {
    const same = plan(carouselPlan(["branded_graphic", "proposal_document", "branded_graphic", "proposal_document", "branded_graphic"]));
    expect(findRepeatedTreatments(same, DEFAULT_RENDER_SPEC, null)).toEqual([
      { slides: [2, 4], signature: `proposal_document|proposal|${OVERVIEW_FP}`, justified: false },
    ]);
    const distinct = plan(revisionPlan({ slide1: { strategy: "branded_graphic", verifiedSourceCategory: "none", generativeSceneDescription: null }, slide3: { strategy: "branded_graphic", verifiedSourceCategory: "none", generativeSceneDescription: null } }));
    expect(findRepeatedTreatments(distinct, DEFAULT_RENDER_SPEC, null)).toEqual([]);
    expect(slideTreatmentSignature(distinct[1], DEFAULT_RENDER_SPEC)).toBe(`proposal_document|proposal|${FINANCIAL_FP}`);
  });

  it("typographic slides and newly generated images are never findings; the same REUSED image is", () => {
    const slides = plan(carouselPlan(["generated_photo", "branded_graphic", "generated_photo", "branded_graphic", "branded_graphic"]));
    expect(findRepeatedTreatments(slides, DEFAULT_RENDER_SPEC, null)).toEqual([]);
    const reused = new Map([
      [1, "d/generated/v1/slide-1.png"],
      [3, "d/generated/v1/slide-1.png"],
    ]);
    expect(findRepeatedTreatments(slides, DEFAULT_RENDER_SPEC, null, reused).map((f) => f.slides)).toEqual([[1, 3]]);
  });

  it("an intentional repeat is justified only with intentionalRepeatOf AND a repetitionJustification", () => {
    const p = carouselPlan(["branded_graphic", "proposal_document", "branded_graphic", "proposal_document", "branded_graphic"]);
    p.slidePlans[3] = { ...p.slidePlans[3], intentionalRepeatOf: 2 };
    expect(findRepeatedTreatments(plan(p), DEFAULT_RENDER_SPEC, null)[0].justified).toBe(false);
    expect(findRepeatedTreatments(plan(p), DEFAULT_RENDER_SPEC, "El mismo documento cierra el recorrido a propósito.")[0].justified).toBe(true);
  });

  it("the first-generation carousel prompt carries intra-carousel diversity guidance and the verified views", () => {
    const { system } = buildCarouselVisualDirectorPrompt({
      topic: "t",
      purpose: "p",
      audience: "a",
      hook: "h",
      ctaText: "Comenzar gratis",
      visualDirection: "",
      channel: "instagram",
      availableVerifiedSources: "x",
      generativeCapabilityAvailable: true,
      generativeBudget: { approxCostUsd: 0.02, budgetPermits: true, generations: 2 },
      recentHistory: emptyVisualHistory(),
      slides: [{ slideNumber: 1, text: "uno" }],
      maxGeneratedSlides: 2,
    });
    expect(system).toMatch(/Repeating a strategy is allowed when editorially useful/);
    expect(system).toMatch(/same strategy, the same source and the same view\/composition read as duplicate creative/);
    expect(system).toMatch(/prefer a distinct verified proposal view \(proposalFocus\)/);
    expect(system).toMatch(/no mechanical rotation/);
    expect(system).toMatch(/intentionalRepeatOf .* repetitionJustification/);
    expect(system).toMatch(/- financial_detail: the real financial-analysis section/);
    expect(system).toMatch(/- system_detail: the real system-design section/);
  });
});

// ---------------------------------------------------------------------------
// Carousel visual revision v1
// ---------------------------------------------------------------------------

describe("carousel visual revision v1", () => {
  it("v1 → v2: one revision call, ZERO image calls, reused generated sources, distinct proposal views, all 5 slides rerendered, v1 untouched", async () => {
    const h = await withCarouselV1();
    const v1Before = JSON.parse(JSON.stringify(assets(h)[0]));
    const draftBefore = JSON.parse(JSON.stringify(h.fake.getAll("content_drafts")[0]));
    h.aiClient.carouselRevisionQueue = [revisionPlan()];

    const outcome = await revise(h);

    expect(outcome).toMatchObject({ status: "success", modelCalls: 1 });
    expect(h.aiClient.carouselRevisionCalls).toHaveLength(1);
    expect(h.imageClient.calls).toHaveLength(2); // only v1's two paid images, ever
    const [v1, v2] = assets(h);
    expect(v1).toEqual(v1Before);
    expect(h.fake.getAll("content_drafts")[0]).toEqual(draftBefore); // approved content untouched
    expect(v2).toMatchObject({ asset_version: 2, format: "carousel", status: "pending_review", source_draft_version: 1 });
    expect(v2.slides.map((s) => s.storage_path)).toEqual([1, 2, 3, 4, 5].map((i) => `${DRAFT_ID}/v2/slide-${i}.jpg`));
    for (const s of v2.slides) expect(Buffer.compare(h.storage.files.get(s.storage_path)!, h.storage.files.get(s.storage_path.replace("/v2/", "/v1/"))!)).not.toBe(0);

    const slides = slidesOf(v2);
    expect(slides.map((s) => [s.strategy, s.proposalFocus ?? null])).toEqual([
      ["generated_illustration", null],
      ["proposal_document", "financial_detail"],
      ["generated_illustration", null],
      ["proposal_document", "overview"],
      ["branded_graphic", null],
    ]);
    expect(slides[0].generatedImage).toMatchObject({ used: true, reused: true, storagePath: `${DRAFT_ID}/generated/v1/slide-1.png` });
    expect(slides[2].generatedImage).toMatchObject({ used: true, reused: true, storagePath: `${DRAFT_ID}/generated/v1/slide-3.png` });
    expect(slides.map((s) => (s.rendered as { theme: string }).theme)).toEqual(["b", "b", "b", "b", "b"]);

    const plan = planOf(v2);
    // The reused image's own scene is kept (the model's rewritten scene can't silently describe a different image).
    expect((plan.slidePlans as { generativeSceneDescription: string | null }[])[0].generativeSceneDescription).toBe(V1_PLAN.slidePlans[0].generativeSceneDescription);
    expect(plan).toMatchObject({ origin: "revision", intraCarouselRepeats: [] });
    expect(plan.revision).toMatchObject({ fromVersion: 1, critique: CRITIQUE, modelCalls: 1, imageCalls: 0, correctivePass: false, reuse: [{ slide: 1, fromSlide: 1, accepted: true }, { slide: 3, fromSlide: 3, accepted: true }] });
    expect(h.fake.getAll("asset_publications")).toHaveLength(0);
  });

  it("the revision prompt carries the previous treatments, the deterministic finding and the critique — never storage paths", async () => {
    const h = await withCarouselV1();
    h.aiClient.carouselRevisionQueue = [revisionPlan()];
    await revise(h);
    const { systemPrompt, userPrompt } = h.aiClient.carouselRevisionCalls[0];
    expect(userPrompt).toContain(`2. proposal_document · view=overview · source=${OVERVIEW_FP}`);
    expect(userPrompt).toContain("1. generated_illustration · source=generated · generated image available");
    expect(userPrompt).toContain(`Slides 2 and 4 show the identical treatment: proposal_document · ${OVERVIEW_FP}.`);
    expect(userPrompt).toContain(CRITIQUE);
    REAL_SLIDES.forEach((t, i) => expect(userPrompt).toContain(`${i + 1}. ${t}`));
    expect(systemPrompt).toMatch(/REUSE-ONLY/);
    expect(systemPrompt).toMatch(/Revise ONLY the visual plan/);
    expect(userPrompt + systemPrompt).not.toMatch(/generated\/v1|\/v1\/slide|solardesk-assets/);
  });

  it("v2 gets exactly one new review email + token; the v1 approval link becomes stale; nothing is published", async () => {
    const h = await withCarouselV1();
    h.aiClient.carouselRevisionQueue = [revisionPlan()];
    await revise(h);
    await runRegeneratedAssetReviewSafely(DRAFT_ID, () => h.deps);

    expect(h.emailClient.sendCalls).toHaveLength(2);
    const [v1Email, v2Email] = h.emailClient.sendCalls;
    expect(v2Email.subject).toContain("carrusel v2");
    REAL_SLIDES.forEach((t) => expect(v2Email.text).toContain(`Texto en la imagen: ${t}`)); // copy unchanged
    expect(v2Email.text).toContain(composeFinalSocialCaption(h.fake.getAll("content_drafts")[0] as unknown as ContentDraftRow));
    expect(v2Email.text).not.toMatch(/ATENCIÓN: Las diapositivas/);
    const v2 = assets(h)[1];
    expect(h.fake.getAll("email_action_tokens").filter((t) => t.action === "approve_asset").map((t) => t.subject_id)).toEqual([assets(h)[0].id, v2.id]);

    expect((await confirmEmailAction(h.db, tokenIn(v1Email.text))).result).toBe("stale");
    expect(assets(h).map((a) => a.status)).toEqual(["pending_review", "pending_review"]);
    expect(h.fake.getAll("asset_publications")).toHaveLength(0);
  });

  it("incompatible reuse is rejected (strategy changed / not a generated slide) and, being reuse-only, falls back to typography — no image call", async () => {
    const h = await withCarouselV1();
    h.aiClient.carouselRevisionQueue = [
      revisionPlan({
        slide1: { strategy: "generated_photo", reuseGeneratedFromSlide: 1 }, // v1 slide 1 was an illustration
        slide3: { reuseGeneratedFromSlide: 2 }, // v1 slide 2 had no generated image
      }),
    ];
    await revise(h);
    const v2 = assets(h)[1];
    expect(h.imageClient.calls).toHaveLength(2);
    expect(slidesOf(v2).map((s) => s.strategy)).toEqual(["branded_graphic", "proposal_document", "branded_graphic", "proposal_document", "branded_graphic"]);
    expect(slidesOf(v2)[0].degradeReasons).toEqual([CAROUSEL_REVISION_NO_NEW_IMAGES_REASON]);
    expect((planOf(v2).revision as { reuse: unknown[] }).reuse).toEqual([
      { slide: 1, fromSlide: 1, accepted: false, reason: "slide 1 changed the generated strategy (generated_illustration → generated_photo)" },
      { slide: 3, fromSlide: 2, accepted: false, reason: "previous slide 2 has no cached generated image" },
    ]);
  });

  it("a revision asking for a NEW generated image never calls the image provider — that slide is downgraded with the reason", async () => {
    const h = await withCarouselV1();
    h.aiClient.carouselRevisionQueue = [revisionPlan({ slide3: { reuseGeneratedFromSlide: null, generativeSceneDescription: "Una escena nueva." } })];
    await revise(h);
    expect(h.imageClient.calls).toHaveLength(2);
    expect(slidesOf(assets(h)[1])[2]).toMatchObject({ strategy: "branded_graphic", degradeReasons: [CAROUSEL_REVISION_NO_NEW_IMAGES_REASON] });
  });

  it("an unjustified identical treatment triggers exactly ONE corrective call, which can resolve it", async () => {
    const h = await withCarouselV1();
    h.aiClient.carouselRevisionQueue = [revisionPlan({ slide2: { proposalFocus: "overview" } }), revisionPlan()];
    const outcome = await revise(h);
    expect(outcome.modelCalls).toBe(2);
    expect(h.aiClient.carouselRevisionCalls[1].userPrompt).toContain(`Your previous revised plan still has these identical treatments ===\nSlides 2 and 4 show the identical treatment: proposal_document · ${OVERVIEW_FP}.`);
    const plan = planOf(assets(h)[1]);
    expect(plan.intraCarouselRepeats).toEqual([]);
    expect(plan.revision).toMatchObject({ correctivePass: true, modelCalls: 2, initialRepeats: [{ slides: [2, 4], justified: false }] });
  });

  it("a repeat that survives the corrective call proceeds (no loop), is recorded, and is flagged in the review email", async () => {
    const h = await withCarouselV1();
    h.aiClient.carouselRevisionQueue = [revisionPlan({ slide2: { proposalFocus: "overview" } })]; // the model insists
    const outcome = await revise(h);
    expect(outcome).toMatchObject({ status: "success", modelCalls: 2 });
    expect(h.aiClient.carouselRevisionCalls).toHaveLength(2);
    expect(planOf(assets(h)[1]).intraCarouselRepeats).toEqual([{ slides: [2, 4], signature: `proposal_document|proposal|${OVERVIEW_FP}`, justified: false }]);
    await runRegeneratedAssetReviewSafely(DRAFT_ID, () => h.deps);
    expect(h.emailClient.sendCalls[1].text).toContain("ATENCIÓN: Las diapositivas 2 y 4 muestran el mismo tratamiento visual (misma fuente y composición).");
  });

  it("an intentional, justified repeat is legal: no corrective call and no warning", async () => {
    const h = await withCarouselV1();
    h.aiClient.carouselRevisionQueue = [
      revisionPlan({ slide2: { proposalFocus: "overview" }, slide4: { intentionalRepeatOf: 2 }, top: { repetitionJustification: "Abrir y cerrar con el mismo documento refuerza que es el entregable." } }),
    ];
    const outcome = await revise(h);
    expect(outcome.modelCalls).toBe(1);
    expect(planOf(assets(h)[1]).intraCarouselRepeats).toEqual([{ slides: [2, 4], signature: `proposal_document|proposal|${OVERVIEW_FP}`, justified: true }]);
    await runRegeneratedAssetReviewSafely(DRAFT_ID, () => h.deps);
    expect(h.emailClient.sendCalls[1].text).not.toMatch(/ATENCIÓN: Las diapositivas/);
  });

  it("an unusable revision output creates nothing (no v2, v1 still the latest)", async () => {
    const h = await withCarouselV1();
    h.aiClient.carouselRevisionQueue = [carouselPlan(["branded_graphic", "branded_graphic"])];
    expect(await revise(h)).toMatchObject({ status: "failed", message: expect.stringMatching(/2 slide plans for a 5-slide carousel/) });
    expect(assets(h)).toHaveLength(1);
  });

  it("Budget Guard can block the revision call itself: nothing is called or created", async () => {
    const h = await withCarouselV1();
    h.fake.seed("ai_usage", [...h.fake.getAll("ai_usage"), { id: "u-max", agent_run_id: null, brand: "solardesk", operation: "executor", model: "gpt-5.6-luna", input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, estimated_cost_usd: 9.6, created_at: new Date().toISOString() }]);
    h.aiClient.carouselRevisionQueue = [revisionPlan()];
    expect(await revise(h)).toMatchObject({ status: "failed", budgetBlocked: true });
    expect(h.aiClient.carouselRevisionCalls).toHaveLength(0);
    expect(assets(h)).toHaveLength(1);
  });

  it.each([
    ["the latest carousel is already approved (ready_to_publish)", (h: Harness) => h.fake.seed("content_assets", assets(h).map((a) => ({ ...a, status: "ready_to_publish" })))],
    ["a publication attempt exists", (h: Harness) => h.fake.seed("asset_publications", [{ id: "p", asset_id: assets(h)[0].id, draft_id: DRAFT_ID, brand: "solardesk", channel: "instagram", status: "failed" }])],
    ["the publication approval was applied", (h: Harness) => h.fake.seed("email_action_tokens", h.fake.getAll("email_action_tokens").map((t) => (t.action === "approve_asset" ? { ...t, outcome: "applied", consumed_at: new Date().toISOString() } : t)))],
    ["the content is not approved", (h: Harness) => h.fake.seed("content_drafts", [draftRow({ status: "pending_approval" })])],
    ["the draft is a Facebook carousel", (h: Harness) => h.fake.seed("content_drafts", [draftRow({ channel: "facebook" })])],
  ])("ineligible when %s — no model call, no new version", async (_label, mutate) => {
    const h = await withCarouselV1();
    mutate(h);
    h.aiClient.carouselRevisionQueue = [revisionPlan()];
    expect((await revise(h)).status).toBe("ineligible");
    expect(h.aiClient.carouselRevisionCalls).toHaveLength(0);
    expect(assets(h)).toHaveLength(1);
  });

  it("rejects an empty critique without any call", async () => {
    const h = await withCarouselV1();
    expect(await revise(h, "  ")).toMatchObject({ status: "ineligible" });
    expect(h.aiClient.carouselRevisionCalls).toHaveLength(0);
  });

  it("structurally cannot publish or generate images: the revision module imports no publisher or image client", async () => {
    const source = await readFile("lib/agent/carouselRevision.ts", "utf-8");
    expect(source).not.toMatch(/publishAssetTo|publishCarouselTo|agent\/publish"|instagramClient|facebookClient|imageGenerationClient|ImageGenerationClient/);
  });
});
