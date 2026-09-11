import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { VISUAL_STRATEGIES, type VisualStrategy } from "@/lib/agent/schemas";
import type { RecentAssetStrategyEntry } from "@/lib/agent/visualDirector";

// Bounded recent-strategy-history context for the Visual Director (spec
// section 5: "avoid repetitive visual strategy... without enforcing
// arbitrary novelty"). Reads ONLY the small, already-persisted
// render_provenance.visualPlan.{strategy,creativeConcept,draftContext}
// fields off recent content_assets rows for the brand — never full
// historical binaries, never a join against content_drafts (the fake
// test DB's query builder has no `.in()`, and duplicating topic/purpose
// into provenance at generation time avoids needing one against the
// real DB either). Legacy/malformed rows (no visualPlan, e.g. any asset
// generated before this feature) are silently skipped, never thrown on.

const HISTORY_QUERY_LIMIT = 12; // over-fetch: some rows may lack visualPlan or be generation_failed
const HISTORY_MAX_ENTRIES = 5;
const HISTORY_TOPIC_MAX_CHARS = 120;
const HISTORY_CONCEPT_MAX_CHARS = 160;

interface RawVisualPlanProvenance {
  strategy?: unknown;
  creativeConcept?: unknown;
  draftContext?: { topic?: unknown; purpose?: unknown };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function parseHistoryEntry(provenance: Record<string, unknown> | null): RecentAssetStrategyEntry | null {
  const visualPlan = provenance?.visualPlan as RawVisualPlanProvenance | undefined;
  if (!visualPlan) return null;

  const strategy = visualPlan.strategy;
  const creativeConcept = visualPlan.creativeConcept;
  const topic = visualPlan.draftContext?.topic;
  const purpose = visualPlan.draftContext?.purpose;

  if (
    typeof strategy !== "string" ||
    !(VISUAL_STRATEGIES as readonly string[]).includes(strategy) ||
    typeof creativeConcept !== "string" ||
    typeof topic !== "string" ||
    typeof purpose !== "string"
  ) {
    return null;
  }

  return {
    strategy: strategy as VisualStrategy,
    creativeConcept: truncate(creativeConcept, HISTORY_CONCEPT_MAX_CHARS),
    topic: truncate(topic, HISTORY_TOPIC_MAX_CHARS),
    purpose: truncate(purpose, HISTORY_TOPIC_MAX_CHARS),
  };
}

/**
 * Fetches up to HISTORY_MAX_ENTRIES recent, successfully-produced
 * image_post asset strategies across the brand (not just this draft —
 * the whole point is cross-post variety awareness), most recent first.
 * Never throws on malformed/legacy provenance; simply skips those rows.
 */
export async function getRecentVisualStrategyHistory(
  db: SupabaseClient<Database>,
  brand: string
): Promise<RecentAssetStrategyEntry[]> {
  const { data } = await db
    .from("content_assets")
    .select("*")
    .eq("brand", brand)
    .order("created_at", { ascending: false })
    .limit(HISTORY_QUERY_LIMIT);

  const rows = data ?? [];
  const entries: RecentAssetStrategyEntry[] = [];
  for (const row of rows) {
    if (row.status === "generation_failed") continue;
    const entry = parseHistoryEntry(row.render_provenance as Record<string, unknown> | null);
    if (entry) entries.push(entry);
    if (entries.length >= HISTORY_MAX_ENTRIES) break;
  }
  return entries;
}
