import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import {
  getRecentVisualHistory,
  describeAssetTreatment,
  assessVariety,
  emptyVisualHistory,
  VISUAL_HISTORY_MAX_DRAFTS,
} from "@/lib/agent/visualHistory";
import { createFakeDb, asSupabaseClient, type FakeDb } from "@/tests/support/fakeDb";

// Compact deterministic visual history for the Visual Director (real
// production finding, 2026-09-25): right before the autonomous Sep 25
// decision, the previous loader showed the model only the Sep 17
// product_ui piece — the published Sep 16 proposal-document creative was
// invisible (legacy asset, no visualPlan), so the model re-chose the same
// proposal treatment believing it was the non-repetitive option. The
// fixtures below mirror the real SolarDesk rows' shapes (ids shortened).

const NOW = new Date("2026-09-25T13:07:43Z"); // just before the real Sep 25 decision
const PDF = "brands/solardesk/assets/proposal-examples/propuesta-sistema-solar-residencial.pdf";
const PAGES = ["brands/solardesk/assets/proposal-examples/rendered/page-1.png", "brands/solardesk/assets/proposal-examples/rendered/page-2.png"];
const PROPOSAL_FP = "proposal:propuesta-sistema-solar-residencial#p1+p2";

const legacyProposal = (theme: "a" | "b", renderSpec: unknown = null) => ({
  renderer: "svg-sharp-proposal-v1",
  theme,
  logoFile: "brands/solardesk/assets/logos/logo.png",
  screenshot: { selected: false },
  proposalExample: { selected: true, pdfPath: PDF, pages: PAGES, disclosureText: "Propuesta de ejemplo · Valores ilustrativos" },
  ...(renderSpec ? { renderSpec } : {}),
});
const legacyProduct = (theme: "a" | "b") => ({
  renderer: "svg-sharp-product-v1",
  theme,
  screenshot: { selected: true, file: "04.png", source: "brands/solardesk/assets/product-screenshots" },
  proposalExample: { selected: false },
});
const legacyTextOnly = (theme: "a" | "b") => ({ renderer: "svg-sharp-v1", theme, screenshot: { selected: false }, proposalExample: { selected: false } });
const directorPlan = (strategy: string, origin: string, extra: Record<string, unknown> = {}) => ({
  strategy,
  origin,
  creativeConcept: "Una entrada clara y sin fricción al flujo de SolarDesk.",
  draftContext: { topic: "t", purpose: "p" },
  generatedImage: { used: false },
  ...extra,
});

let assetSeq = 0;
function asset(fake: FakeDb, draftId: string, version: number, createdAt: string, provenance: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  assetSeq += 1;
  const id = `${draftId}-v${version}-${assetSeq}`;
  fake.seed("content_assets", [
    ...fake.getAll("content_assets"),
    {
      id,
      draft_id: draftId,
      brand: "solardesk",
      asset_version: version,
      source_draft_version: 1,
      status: "pending_review",
      format: "image_post",
      storage_bucket: "solardesk-assets",
      storage_path: `${draftId}/v${version}.png`,
      render_provenance: provenance,
      error_message: null,
      created_at: createdAt,
      approved_at: null,
      ...overrides,
    },
  ]);
  return id;
}
function draft(fake: FakeDb, id: string, overrides: Record<string, unknown> = {}) {
  fake.seed("content_drafts", [...fake.getAll("content_drafts"), { id, brand: "solardesk", channel: "facebook", topic: `Topic ${id}`, status: "approved", ...overrides }]);
}
function published(fake: FakeDb, assetId: string, draftId: string, publishedAt: string, channel = "facebook") {
  fake.seed("asset_publications", [
    ...fake.getAll("asset_publications"),
    { id: `pub-${assetId}`, asset_id: assetId, draft_id: draftId, brand: "solardesk", channel, status: "published", published_at: publishedAt, created_at: publishedAt },
  ]);
}

/** The real SolarDesk history as it stood right before the Sep 25 decision. */
function productionShaped() {
  const fake = createFakeDb();
  fake.seed("content_assets", []);
  fake.seed("content_drafts", []);
  fake.seed("asset_publications", []);
  // Sep 10–16: one draft, six legacy versions; v6 published on Sep 16.
  draft(fake, "d-9020", { topic: "De la cotización a una propuesta lista para presentar" });
  asset(fake, "d-9020", 1, "2026-09-10T00:42:00Z", legacyTextOnly("a"));
  asset(fake, "d-9020", 2, "2026-09-10T01:08:00Z", legacyProduct("b"));
  asset(fake, "d-9020", 3, "2026-09-10T01:36:00Z", legacyProposal("a"));
  asset(fake, "d-9020", 4, "2026-09-10T01:41:00Z", legacyProposal("b"));
  asset(fake, "d-9020", 5, "2026-09-10T02:04:00Z", legacyProposal("a"));
  const sep16 = asset(fake, "d-9020", 6, "2026-09-10T02:07:00Z", legacyProposal("b", { primaryVisualScale: "large", secondaryPageVisibility: "normal" }), { status: "ready_to_publish" });
  published(fake, sep16, "d-9020", "2026-09-16T18:17:35Z");
  // Sep 11: legacy proposal, never published.
  draft(fake, "d-6c3a", { topic: "Explicar los supuestos también es parte de la propuesta" });
  asset(fake, "d-6c3a", 1, "2026-09-11T13:30:00Z", legacyProposal("a"));
  // Sep 17: Visual Director product_ui; v1 failed, v2 (reused plan) published.
  draft(fake, "d-2d2d", { topic: "Empieza con SolarDesk sin tarjeta" });
  asset(fake, "d-2d2d", 1, "2026-09-17T19:07:00Z", { renderSpec: {}, visualPlan: directorPlan("product_ui", "visual_director") }, { status: "generation_failed" });
  const sep17 = asset(fake, "d-2d2d", 2, "2026-09-17T20:09:00Z", { ...legacyProduct("b"), visualPlan: directorPlan("product_ui", "reused_plan") }, { status: "ready_to_publish" });
  published(fake, sep17, "d-2d2d", "2026-09-17T20:10:09Z");
  // Sep 19: Instagram smoke test — no renderer recorded at all.
  draft(fake, "d-1c8e", { channel: "instagram", topic: "SMOKE TEST — Instagram publish" });
  const smoke = asset(fake, "d-1c8e", 1, "2026-09-19T14:33:58Z", {}, { status: "ready_to_publish" });
  published(fake, smoke, "d-1c8e", "2026-09-19T15:23:23Z", "instagram");
  return { fake, db: asSupabaseClient<SupabaseClient<Database>>(fake) };
}

describe("getRecentVisualHistory — production-shaped (Sep 25 decision)", () => {
  it("1–2. includes the Sep 16 legacy published proposal creative, inferred as proposal_document", async () => {
    const { db } = productionShaped();
    const history = await getRecentVisualHistory(db, "solardesk", NOW);

    const sep16 = history.entries.find((e) => e.topic === "De la cotización a una propuesta lista para presentar")!;
    expect(sep16).toMatchObject({
      daysAgo: 8,
      channel: "facebook",
      status: "published",
      strategy: "proposal_document",
      strategySource: "legacy_inferred",
      layout: "proposal",
      theme: "b",
      sourceFingerprint: PROPOSAL_FP,
      generatedImage: false,
      creativeConcept: null,
    });
  });

  it("3–5. one entry per draft: regenerations count once, the published version wins, failed generations take no slot", async () => {
    const { db } = productionShaped();
    const history = await getRecentVisualHistory(db, "solardesk", NOW);

    // d-9020 has 6 versions (text-only, product, 4× proposal) → exactly one entry: its published v6.
    expect(history.entries.map((e) => e.topic)).toEqual([
      "Empieza con SolarDesk sin tarjeta", // published Sep 17
      "De la cotización a una propuesta lista para presentar", // published Sep 16
      "Explicar los supuestos también es parte de la propuesta", // created Sep 11
    ]);
    const sep17 = history.entries[0];
    expect(sep17).toMatchObject({ strategy: "product_ui", strategySource: "reused_plan", status: "published", sourceFingerprint: "screenshot:04.png" });
  });

  it("skips an asset whose treatment can't be determined (the Instagram smoke test had no renderer) rather than guessing", async () => {
    const { db } = productionShaped();
    const history = await getRecentVisualHistory(db, "solardesk", NOW);
    expect(history.entries.some((e) => e.topic.startsWith("SMOKE TEST"))).toBe(false);
  });

  it("8 + summary: exposes channel/date/status/source/layout/theme/generated info and counts the repeated proposal source", async () => {
    const { db } = productionShaped();
    const { summary } = await getRecentVisualHistory(db, "solardesk", NOW);

    expect(summary.strategyCounts).toEqual({ product_ui: 1, proposal_document: 2 });
    expect(summary.sourceCounts).toEqual({ "screenshot:04.png": 1, [PROPOSAL_FP]: 2 });
    expect(summary.daysSinceLastUse).toEqual({ product_ui: 7, proposal_document: 8 });
    expect(summary.recentPublished).toEqual([
      { daysAgo: 7, channel: "facebook", strategy: "product_ui", layout: "product", sourceFingerprint: "screenshot:04.png", generatedImage: false },
      { daysAgo: 8, channel: "facebook", strategy: "proposal_document", layout: "proposal", sourceFingerprint: PROPOSAL_FP, generatedImage: false },
    ]);
  });

  it("never carries URLs, storage paths or raw provenance", async () => {
    const { db } = productionShaped();
    const serialized = JSON.stringify(await getRecentVisualHistory(db, "solardesk", NOW));
    expect(serialized).not.toMatch(/https?:|storage|solardesk-assets|brands\/|\/v\d+\.png|disclosureText|logoFile|renderSpec/);
  });
});

describe("getRecentVisualHistory — bounds and isolation", () => {
  it("6. is brand-scoped: another brand's assets/drafts/publications never appear", async () => {
    const { fake, db } = productionShaped();
    fake.seed("content_drafts", [...fake.getAll("content_drafts"), { id: "d-other", brand: "mipadel", channel: "facebook", topic: "Otra marca", status: "approved" }]);
    asset(fake, "d-other", 1, "2026-09-24T10:00:00Z", legacyTextOnly("a"), { brand: "mipadel" });
    const history = await getRecentVisualHistory(db, "solardesk", NOW);
    expect(history.entries.some((e) => e.topic === "Otra marca")).toBe(false);
  });

  it("7. bounded to the 45-day window and at most 8 drafts", async () => {
    const fake = createFakeDb();
    fake.seed("content_assets", []);
    fake.seed("content_drafts", []);
    fake.seed("asset_publications", []);
    draft(fake, "old");
    asset(fake, "old", 1, "2026-08-10T00:00:00Z", legacyTextOnly("a")); // 46 days before NOW
    for (let i = 0; i < 12; i++) {
      draft(fake, `d${i}`);
      asset(fake, `d${i}`, 1, `2026-09-${String(10 + i).padStart(2, "0")}T00:00:00Z`, legacyTextOnly("a"));
    }
    const history = await getRecentVisualHistory(asSupabaseClient<SupabaseClient<Database>>(fake), "solardesk", NOW);
    expect(history.windowDays).toBe(45);
    expect(history.entries).toHaveLength(VISUAL_HISTORY_MAX_DRAFTS);
    expect(history.entries[0].topic).toBe("Topic d11"); // newest first
    expect(history.entries.some((e) => e.topic === "Topic old")).toBe(false);
  });

  it("an empty window yields an empty, well-formed history", async () => {
    const fake = createFakeDb();
    fake.seed("content_assets", []);
    expect(await getRecentVisualHistory(asSupabaseClient<SupabaseClient<Database>>(fake), "solardesk", NOW)).toEqual(emptyVisualHistory());
  });
});

describe("describeAssetTreatment — source fingerprints and inference", () => {
  it("9. the same proposal pages always produce the same fingerprint (legacy or Visual Director)", () => {
    const legacy = describeAssetTreatment(legacyProposal("a"))!;
    const director = describeAssetTreatment({ ...legacyProposal("b"), visualPlan: directorPlan("proposal_document", "visual_director") })!;
    expect(legacy.sourceFingerprint).toBe(PROPOSAL_FP);
    expect(director.sourceFingerprint).toBe(PROPOSAL_FP);
  });

  it("fingerprints only the pages actually shown (hidden second page → p1 only)", () => {
    const hidden = describeAssetTreatment(legacyProposal("a", { secondaryPageVisibility: "hidden" }))!;
    expect(hidden.sourceFingerprint).toBe("proposal:propuesta-sistema-solar-residencial#p1");
  });

  it("maps each legacy renderer to the only strategy it could produce", () => {
    expect(describeAssetTreatment(legacyTextOnly("a"))).toMatchObject({ strategy: "branded_graphic", layout: "text_only", sourceFingerprint: "none", strategySource: "legacy_inferred" });
    expect(describeAssetTreatment(legacyProduct("b"))).toMatchObject({ strategy: "product_ui", layout: "product", sourceFingerprint: "screenshot:04.png" });
    expect(describeAssetTreatment(legacyProposal("a"))).toMatchObject({ strategy: "proposal_document", layout: "proposal" });
  });

  it("never infers a generated strategy from the hero renderer alone; uses the plan's record when present", () => {
    expect(describeAssetTreatment({ renderer: "svg-sharp-hero-v1", theme: "a" })).toBeNull();
    const hero = describeAssetTreatment({
      renderer: "svg-sharp-hero-v1",
      theme: "a",
      screenshot: { selected: false },
      proposalExample: { selected: false },
      visualPlan: directorPlan("generated_photo", "visual_director", { generatedImage: { used: true, storagePath: "d/generated/v1.png" } }),
    })!;
    expect(hero).toMatchObject({ strategy: "generated_photo", layout: "hero", generatedImage: true, sourceFingerprint: "generated" });
    const hybrid = describeAssetTreatment({
      renderer: "svg-sharp-hero-v1",
      theme: "b",
      screenshot: { selected: true, file: "04.png" },
      visualPlan: directorPlan("hybrid", "visual_director", { generatedImage: { used: true } }),
    })!;
    expect(hybrid).toMatchObject({ strategy: "hybrid", generatedImage: true, sourceFingerprint: "screenshot:04.png" });
  });

  it("a degraded Visual Director asset is described by what was actually rendered", () => {
    const degraded = describeAssetTreatment({ ...legacyTextOnly("a"), visualPlan: directorPlan("branded_graphic", "visual_director", { requestedStrategy: "generated_photo", degraded: true }) })!;
    expect(degraded).toMatchObject({ strategy: "branded_graphic", generatedImage: false, sourceFingerprint: "none" });
  });

  it("returns null for missing/malformed provenance without throwing", () => {
    expect(describeAssetTreatment(null)).toBeNull();
    expect(describeAssetTreatment({})).toBeNull();
    expect(describeAssetTreatment({ renderer: "something-else" })).toBeNull();
  });
});

describe("assessVariety — deterministic repetition facts", () => {
  it("17. flags the Sep 25 proposal treatment as repeating the latest published Facebook proposal source", async () => {
    const { db } = productionShaped();
    const history = await getRecentVisualHistory(db, "solardesk", NOW);
    const sep25 = describeAssetTreatment({ ...legacyProposal("a"), visualPlan: directorPlan("proposal_document", "visual_director") })!;

    expect(assessVariety(sep25, "facebook", history)).toEqual({
      repeatsRecentStrategy: true,
      repeatsRecentSource: true,
      repeatsLatestPublishedOnChannel: false, // the latest published Facebook piece was the Sep 17 product_ui
      sameStrategyCount: 2,
      daysSinceStrategyLastUsed: 8,
      comparedEntries: 3,
    });
  });

  it("a generated photo repeats nothing here, and 'generated'/'none' never count as a repeated source", async () => {
    const { db } = productionShaped();
    const history = await getRecentVisualHistory(db, "solardesk", NOW);
    const photo = describeAssetTreatment({ renderer: "svg-sharp-hero-v1", theme: "a", visualPlan: directorPlan("generated_photo", "visual_director", { generatedImage: { used: true } }) })!;
    expect(assessVariety(photo, "facebook", history)).toMatchObject({ repeatsRecentStrategy: false, repeatsRecentSource: false, repeatsLatestPublishedOnChannel: false });

    const withPhoto = { ...history, entries: [{ ...history.entries[0], strategy: "generated_photo" as const, sourceFingerprint: "generated", generatedImage: true }] };
    expect(assessVariety(photo, "facebook", withPhoto).repeatsRecentSource).toBe(false);
  });

  it("detects back-to-back identical treatments on the same channel", async () => {
    const { db } = productionShaped();
    const history = await getRecentVisualHistory(db, "solardesk", NOW);
    const product = describeAssetTreatment({ ...legacyProduct("a"), visualPlan: directorPlan("product_ui", "visual_director") })!;
    expect(assessVariety(product, "facebook", history).repeatsLatestPublishedOnChannel).toBe(true);
    expect(assessVariety(product, "instagram", history).repeatsLatestPublishedOnChannel).toBe(false);
  });
});
