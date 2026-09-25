import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { VISUAL_STRATEGIES, type VisualStrategy } from "@/lib/agent/schemas";

// Compact, deterministic recent visual history for the Visual Director
// (real production finding, 2026-09-25): the previous loader read only
// the last few asset ROWS that carried a Visual Director visualPlan, so
// legacy assets (including a published proposal-document creative from
// 2026-09-16) were invisible, regenerations of one draft could fill every
// slot, and the model saw no date/channel/status/source/layout at all —
// it picked the same proposal treatment again believing it was the
// non-repetitive choice.
//
// This module derives, per DRAFT (not per asset row), what followers
// actually saw or will see: its published asset if any, otherwise its
// latest successful one. Everything is read from durable, already-stored
// fields (content_assets.render_provenance, content_drafts,
// asset_publications) — historical rows are never modified, and legacy
// assets without a visualPlan are described by conservative inference
// from their recorded renderer. No embeddings, no image similarity, no
// URLs, no raw provenance ever leaves this module.

export const VISUAL_HISTORY_WINDOW_DAYS = 45;
export const VISUAL_HISTORY_MAX_DRAFTS = 8;
const ASSET_QUERY_LIMIT = 80; // bounded over-fetch: regenerations and failures share the window
const RECENT_PUBLISHED_MAX = 4;
const TOPIC_MAX_CHARS = 100;
const CONCEPT_MAX_CHARS = 140;
const DAY_MS = 24 * 60 * 60 * 1000;

export type VisualLayout = "text_only" | "product" | "proposal" | "hero" | "carousel";
export type VisualStrategySource = "visual_director" | "reused_plan" | "fallback" | "legacy_inferred";
export type VisualHistoryStatus = "published" | "ready_to_publish" | "pending_review" | "rejected";

export interface VisualHistoryEntry {
  daysAgo: number;
  channel: string;
  status: VisualHistoryStatus;
  strategy: VisualStrategy;
  strategySource: VisualStrategySource;
  layout: VisualLayout;
  theme: "a" | "b" | null;
  /** Verified source actually shown ("proposal:<doc>#p1+p2", "screenshot:04.png"), or "generated" / "none". Never a URL or storage path. */
  sourceFingerprint: string;
  generatedImage: boolean;
  topic: string;
  creativeConcept: string | null;
}

export interface PublishedTreatment {
  daysAgo: number;
  channel: string;
  strategy: VisualStrategy;
  layout: VisualLayout;
  sourceFingerprint: string;
  generatedImage: boolean;
}

export interface RecentVisualHistory {
  windowDays: number;
  /** One per draft, newest first, at most VISUAL_HISTORY_MAX_DRAFTS. */
  entries: VisualHistoryEntry[];
  summary: {
    strategyCounts: Partial<Record<VisualStrategy, number>>;
    sourceCounts: Record<string, number>;
    /** Absent strategy = not used within the window. */
    daysSinceLastUse: Partial<Record<VisualStrategy, number>>;
    /** The latest published pieces, newest first — the feed as followers saw it. */
    recentPublished: PublishedTreatment[];
  };
}

/** What a single rendered asset showed, derived only from its durable render_provenance. Null when that can't be determined safely. */
export interface AssetTreatment {
  strategy: VisualStrategy;
  strategySource: VisualStrategySource;
  layout: VisualLayout;
  theme: "a" | "b" | null;
  sourceFingerprint: string;
  generatedImage: boolean;
  creativeConcept: string | null;
}

const RENDERER_LAYOUTS: Record<string, VisualLayout> = {
  "svg-sharp-v1": "text_only",
  "svg-sharp-product-v1": "product",
  "svg-sharp-proposal-v1": "proposal",
  "svg-sharp-hero-v1": "hero",
};

// Legacy (pre-Visual-Director) assets carry no visualPlan. These
// renderers each only ever produced one strategy, so the mapping is safe.
// The hero renderer is deliberately absent: it can't tell
// generated_photo from generated_illustration/hybrid on its own, and it
// never existed without a visualPlan anyway.
const LEGACY_LAYOUT_STRATEGIES: Partial<Record<VisualLayout, VisualStrategy>> = {
  text_only: "branded_graphic",
  product: "product_ui",
  proposal: "proposal_document",
};

type Provenance = Record<string, unknown>;

function asRecord(value: unknown): Provenance | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Provenance) : null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function baseName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

/** "page-1.png" → "p1"; anything unrecognized keeps its bare file name. */
function pageLabel(pagePath: string): string {
  const match = /^page-(\d+)\.png$/.exec(baseName(pagePath));
  return match ? `p${match[1]}` : baseName(pagePath);
}

/**
 * Stable, non-sensitive identity of the verified source an asset showed —
 * the same real proposal pages or screenshot always yield the same string.
 * Built only from catalog file names in provenance, never a URL.
 */
function verifiedSourceFingerprint(provenance: Provenance, layout: VisualLayout): string | null {
  const proposal = asRecord(provenance.proposalExample);
  if (proposal?.selected === true && typeof proposal.pdfPath === "string" && Array.isArray(proposal.pages)) {
    let pages = proposal.pages.filter((p): p is string => typeof p === "string");
    // The standard proposal layout records both pages even when the
    // second one is hidden — fingerprint only what was actually shown.
    const spec = asRecord(provenance.renderSpec);
    if (layout === "proposal" && spec?.secondaryPageVisibility === "hidden") pages = pages.slice(0, 1);
    const doc = baseName(proposal.pdfPath).replace(/\.pdf$/i, "");
    return `proposal:${doc}#${pages.map(pageLabel).join("+")}`;
  }
  const screenshot = asRecord(provenance.screenshot);
  if (screenshot?.selected === true && typeof screenshot.file === "string") {
    return `screenshot:${baseName(screenshot.file)}`;
  }
  return null;
}

/**
 * Describes one successfully rendered asset from its render_provenance.
 * Visual Director assets use their recorded (final, possibly degraded)
 * strategy; legacy assets are inferred from their renderer only where
 * that renderer could have produced exactly one strategy. Returns null
 * rather than guessing (e.g. no renderer recorded at all).
 */
export function describeAssetTreatment(provenanceValue: unknown): AssetTreatment | null {
  const provenance = asRecord(provenanceValue);
  if (!provenance) return null;
  if (provenance.renderer === CAROUSEL_RENDERER) return describeCarouselTreatment(provenance);
  const layout = typeof provenance.renderer === "string" ? RENDERER_LAYOUTS[provenance.renderer] : undefined;
  if (!layout) return null;

  const visualPlan = asRecord(provenance.visualPlan);
  const planStrategy = visualPlan?.strategy;
  let strategy: VisualStrategy | undefined;
  let strategySource: VisualStrategySource;
  if (typeof planStrategy === "string" && (VISUAL_STRATEGIES as readonly string[]).includes(planStrategy)) {
    strategy = planStrategy as VisualStrategy;
    const origin = visualPlan?.origin;
    strategySource = origin === "reused_plan" || origin === "fallback" ? origin : "visual_director";
  } else {
    strategy = LEGACY_LAYOUT_STRATEGIES[layout];
    strategySource = "legacy_inferred";
  }
  if (!strategy) return null;

  // Only the hero layout ever composites a generated image; for it, trust
  // the plan's own record. Legacy non-hero renderers never used one.
  const generatedImage = layout === "hero" && asRecord(visualPlan?.generatedImage)?.used === true;
  const verified = verifiedSourceFingerprint(provenance, layout);
  const theme = provenance.theme === "a" || provenance.theme === "b" ? provenance.theme : null;
  const concept = typeof visualPlan?.creativeConcept === "string" ? truncate(visualPlan.creativeConcept, CONCEPT_MAX_CHARS) : null;

  return {
    strategy,
    strategySource,
    layout,
    theme,
    sourceFingerprint: verified ?? (generatedImage ? "generated" : "none"),
    generatedImage,
    creativeConcept: concept,
  };
}

const CAROUSEL_RENDERER = "svg-sharp-carousel-v1"; // lib/agent/carouselGenerator.ts
const CAROUSEL_FP_PREFIX = "carousel(";

/**
 * A carousel (one asset, many slides) is described as ONE treatment:
 * layout "carousel", its recorded dominant strategy, whether any slide
 * used a generated image, and a fingerprint listing the distinct sources
 * its slides showed, in slide order — e.g.
 * "carousel(none | screenshot:04.png | generated)".
 */
function describeCarouselTreatment(provenance: Provenance): AssetTreatment | null {
  const visualPlan = asRecord(provenance.visualPlan);
  const strategy = visualPlan?.strategy;
  if (typeof strategy !== "string" || !(VISUAL_STRATEGIES as readonly string[]).includes(strategy)) return null;
  const origin = visualPlan?.origin;
  const parts: string[] = [];
  let generatedImage = false;
  for (const raw of Array.isArray(provenance.carouselSlides) ? provenance.carouselSlides : []) {
    const slide = asRecord(raw);
    const slideTreatment = describeAssetTreatment({
      ...(asRecord(slide?.rendered) ?? {}),
      visualPlan: { strategy: slide?.strategy, origin: "visual_director", generatedImage: slide?.generatedImage },
    });
    if (!slideTreatment) continue;
    generatedImage ||= slideTreatment.generatedImage;
    if (!parts.includes(slideTreatment.sourceFingerprint)) parts.push(slideTreatment.sourceFingerprint);
  }
  return {
    strategy: strategy as VisualStrategy,
    strategySource: origin === "reused_plan" || origin === "fallback" ? origin : "visual_director",
    layout: "carousel",
    theme: provenance.theme === "a" || provenance.theme === "b" ? provenance.theme : null,
    sourceFingerprint: `${CAROUSEL_FP_PREFIX}${parts.length > 0 ? parts.join(" | ") : "none"})`,
    generatedImage,
    creativeConcept: typeof visualPlan?.creativeConcept === "string" ? truncate(visualPlan.creativeConcept, CONCEPT_MAX_CHARS) : null,
  };
}

/** The individual source fingerprints behind a fingerprint (a carousel's slides; otherwise just itself). */
export function sourceFingerprintParts(fingerprint: string): string[] {
  if (fingerprint.startsWith(CAROUSEL_FP_PREFIX) && fingerprint.endsWith(")")) {
    return fingerprint.slice(CAROUSEL_FP_PREFIX.length, -1).split(" | ");
  }
  return [fingerprint];
}

/** True for fingerprints that identify reusable real material (a repeat means the same pixels) — for a carousel, if any slide does. */
export function isVerifiedSourceFingerprint(fingerprint: string): boolean {
  return sourceFingerprintParts(fingerprint).some((part) => part !== "none" && part !== "generated");
}

const verifiedParts = (fingerprint: string) => sourceFingerprintParts(fingerprint).filter((part) => isVerifiedSourceFingerprint(part));

function daysBetween(now: Date, iso: string): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS));
}

function summarize(entries: VisualHistoryEntry[]): RecentVisualHistory["summary"] {
  const strategyCounts: Partial<Record<VisualStrategy, number>> = {};
  const sourceCounts: Record<string, number> = {};
  const daysSinceLastUse: Partial<Record<VisualStrategy, number>> = {};
  for (const e of entries) {
    strategyCounts[e.strategy] = (strategyCounts[e.strategy] ?? 0) + 1;
    for (const part of sourceFingerprintParts(e.sourceFingerprint)) sourceCounts[part] = (sourceCounts[part] ?? 0) + 1;
    daysSinceLastUse[e.strategy] = Math.min(daysSinceLastUse[e.strategy] ?? Infinity, e.daysAgo);
  }
  const recentPublished = entries
    .filter((e) => e.status === "published")
    .slice(0, RECENT_PUBLISHED_MAX)
    .map(({ daysAgo, channel, strategy, layout, sourceFingerprint, generatedImage }) => ({
      daysAgo,
      channel,
      strategy,
      layout,
      sourceFingerprint,
      generatedImage,
    }));
  return { strategyCounts, sourceCounts, daysSinceLastUse, recentPublished };
}

/** A history with nothing in it (no assets in the window yet). */
export function emptyVisualHistory(): RecentVisualHistory {
  return { windowDays: VISUAL_HISTORY_WINDOW_DAYS, entries: [], summary: summarize([]) };
}

/**
 * Builds the brand's recent visual history: last VISUAL_HISTORY_WINDOW_DAYS
 * days, at most VISUAL_HISTORY_MAX_DRAFTS drafts, one entry per draft
 * (its published asset if any, else its latest successful one), newest
 * first. Failed generations never occupy a slot. Never throws on
 * legacy/malformed provenance — such assets are skipped.
 */
export async function getRecentVisualHistory(
  db: SupabaseClient<Database>,
  brand: string,
  now: Date = new Date()
): Promise<RecentVisualHistory> {
  const cutoff = new Date(now.getTime() - VISUAL_HISTORY_WINDOW_DAYS * DAY_MS).toISOString();
  const { data: assetRows } = await db
    .from("content_assets")
    .select("*")
    .eq("brand", brand)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(ASSET_QUERY_LIMIT);

  const candidates = (assetRows ?? [])
    .filter((row) => row.status !== "generation_failed")
    .map((row) => ({ row, treatment: describeAssetTreatment(row.render_provenance) }))
    .filter((c): c is { row: (typeof c)["row"]; treatment: AssetTreatment } => c.treatment !== null);
  if (candidates.length === 0) return emptyVisualHistory();

  const assetIds = candidates.map((c) => c.row.id);
  const draftIds = [...new Set(candidates.map((c) => c.row.draft_id))];
  const [{ data: publications }, { data: drafts }] = await Promise.all([
    db.from("asset_publications").select("asset_id, status, published_at").eq("brand", brand).eq("status", "published").in("asset_id", assetIds),
    db.from("content_drafts").select("id, brand, channel, topic, status").eq("brand", brand).in("id", draftIds),
  ]);
  const publishedAt = new Map<string, string>();
  for (const p of publications ?? []) {
    if (p.asset_id && p.published_at) publishedAt.set(p.asset_id, p.published_at);
  }
  const draftById = new Map((drafts ?? []).map((d) => [d.id, d]));

  // One representative asset per draft: its published asset (latest
  // publication) wins; otherwise its highest successful version.
  const perDraft = new Map<string, { candidate: (typeof candidates)[number]; seenAt: string; published: boolean }>();
  for (const candidate of candidates) {
    const draft = draftById.get(candidate.row.draft_id);
    if (!draft) continue; // brand-scoped drafts only
    const pubAt = publishedAt.get(candidate.row.id);
    const current = perDraft.get(draft.id);
    const option = { candidate, seenAt: pubAt ?? candidate.row.created_at, published: pubAt !== undefined };
    if (
      !current ||
      (option.published && (!current.published || option.seenAt > current.seenAt)) ||
      (!option.published && !current.published && candidate.row.asset_version > current.candidate.row.asset_version)
    ) {
      perDraft.set(draft.id, option);
    }
  }

  const entries: VisualHistoryEntry[] = [...perDraft.entries()]
    .sort(([, a], [, b]) => (a.seenAt < b.seenAt ? 1 : a.seenAt > b.seenAt ? -1 : 0))
    .slice(0, VISUAL_HISTORY_MAX_DRAFTS)
    .map(([draftId, { candidate, seenAt, published }]) => {
      const draft = draftById.get(draftId)!;
      const status: VisualHistoryStatus = published
        ? "published"
        : draft.status === "rejected"
          ? "rejected"
          : candidate.row.status === "ready_to_publish"
            ? "ready_to_publish"
            : "pending_review";
      return {
        daysAgo: daysBetween(now, seenAt),
        channel: draft.channel,
        status,
        ...candidate.treatment,
        topic: truncate(draft.topic, TOPIC_MAX_CHARS),
        creativeConcept: candidate.treatment.creativeConcept,
      };
    });

  return { windowDays: VISUAL_HISTORY_WINDOW_DAYS, entries, summary: summarize(entries) };
}

export interface VarietyAssessment {
  /** Some draft in the history window used the same strategy. */
  repeatsRecentStrategy: boolean;
  /** Some draft in the history window showed the same real verified source (never true for "none"/"generated"). */
  repeatsRecentSource: boolean;
  /** The latest published piece on the same channel had the same strategy AND source — the feed would show near-identical treatments back to back. */
  repeatsLatestPublishedOnChannel: boolean;
  sameStrategyCount: number;
  daysSinceStrategyLastUsed: number | null;
  comparedEntries: number;
}

/**
 * Deterministic, code-computed repetition facts for a newly rendered
 * treatment against the history the Visual Director was shown. The
 * model's varietyRationale explains its choice; this records what
 * objectively happened. Informational only — never overrides a strategy.
 */
export function assessVariety(treatment: AssetTreatment, channel: string, history: RecentVisualHistory): VarietyAssessment {
  const sameStrategy = history.entries.filter((e) => e.strategy === treatment.strategy);
  // Any shared real source counts (a carousel slide reusing the same proposal pages is still the same pixels).
  const current = verifiedParts(treatment.sourceFingerprint);
  const repeatsRecentSource = current.length > 0 && history.entries.some((e) => verifiedParts(e.sourceFingerprint).some((part) => current.includes(part)));
  const latestPublishedOnChannel = history.entries.find((e) => e.status === "published" && e.channel === channel);
  return {
    repeatsRecentStrategy: sameStrategy.length > 0,
    repeatsRecentSource,
    repeatsLatestPublishedOnChannel:
      !!latestPublishedOnChannel &&
      latestPublishedOnChannel.strategy === treatment.strategy &&
      latestPublishedOnChannel.sourceFingerprint === treatment.sourceFingerprint,
    sameStrategyCount: sameStrategy.length,
    daysSinceStrategyLastUsed: sameStrategy.length > 0 ? Math.min(...sameStrategy.map((e) => e.daysAgo)) : null,
    comparedEntries: history.entries.length,
  };
}
