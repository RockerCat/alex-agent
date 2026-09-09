import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AgentQuestionRow,
  AgentRunRow,
  ContentDraftRow,
  Database,
  MarketingPlanRow,
} from "@/lib/types/database";
import type { SupportedBrand } from "@/lib/agent/constants";

export interface AgentContext {
  brand: SupportedBrand;
  agentMd: string;
  brandMd: string;
  activePlan: MarketingPlanRow | null;
  draftsForActivePlan: ContentDraftRow[];
  openQuestions: AgentQuestionRow[];
  recentAnsweredQuestions: AgentQuestionRow[];
  recentRuns: AgentRunRow[];
}

// Statically scoped per brand (rather than a dynamic object index into a
// path string) so bundlers can trace exactly which files this needs
// instead of tracing the whole project — v0.1 only ever resolves to
// "solardesk" since that is the only entry in SUPPORTED_BRANDS.
function brandFilePath(repoRoot: string, brand: SupportedBrand): string {
  switch (brand) {
    case "solardesk":
      return path.join(repoRoot, "brands/solardesk/BRAND.md");
  }
}

/**
 * Loads the two authoritative markdown documents plus current operational
 * state from Supabase. This function never writes to AGENT.md or BRAND.md —
 * spec section 9 forbids the agent from auto-editing brand/agent contracts.
 */
export async function loadAgentContext(
  db: SupabaseClient<Database>,
  brand: SupportedBrand
): Promise<AgentContext> {
  const repoRoot = process.cwd();
  const [agentMd, brandMd] = await Promise.all([
    readFile(path.join(repoRoot, "AGENT.md"), "utf-8"),
    readFile(brandFilePath(repoRoot, brand), "utf-8"),
  ]);

  const { data: activePlan } = await db
    .from("marketing_plans")
    .select("*")
    .eq("brand", brand)
    .eq("status", "active")
    .maybeSingle();

  let draftsForActivePlan: ContentDraftRow[] = [];
  if (activePlan) {
    const { data } = await db
      .from("content_drafts")
      .select("*")
      .eq("plan_id", activePlan.id)
      .order("created_at", { ascending: true });
    draftsForActivePlan = data ?? [];
  }

  const { data: openQuestions } = await db
    .from("agent_questions")
    .select("*")
    .eq("brand", brand)
    .eq("status", "open")
    .order("created_at", { ascending: true });

  const { data: recentAnsweredQuestions } = await db
    .from("agent_questions")
    .select("*")
    .eq("brand", brand)
    .eq("status", "answered")
    .order("answered_at", { ascending: false })
    .limit(10);

  const { data: recentRuns } = await db
    .from("agent_runs")
    .select("*")
    .eq("brand", brand)
    .order("created_at", { ascending: false })
    .limit(10);

  return {
    brand,
    agentMd,
    brandMd,
    activePlan: activePlan ?? null,
    draftsForActivePlan,
    openQuestions: openQuestions ?? [],
    recentAnsweredQuestions: recentAnsweredQuestions ?? [],
    recentRuns: recentRuns ?? [],
  };
}
