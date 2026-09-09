import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

// Shared by lib/agent/runtime.ts (marketing cycles) and
// lib/agent/revision.ts (revisions) — both acquire the same brand-scoped
// lock via the agent_runs unique partial index on status='running', so
// both need the same stale-run recovery sweep. Keeping this in one place
// avoids the lock behaving differently depending on which entry point a
// caller happens to use.

const STALE_RUN_TIMEOUT_MS = 10 * 60 * 1000;

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505"
  );
}

/**
 * Marks any run stuck in "running" past the timeout as failed, freeing
 * the unique lock. Must be called before every lock-acquisition attempt
 * (marketing cycle or revision) so a crashed run of either kind can't
 * permanently block the other.
 */
export async function recoverStaleRuns(db: SupabaseClient<Database>, brand: string) {
  const cutoff = new Date(Date.now() - STALE_RUN_TIMEOUT_MS).toISOString();
  await db
    .from("agent_runs")
    .update({
      status: "failed",
      error_code: "stale_run_timeout",
      error_message: "Run did not complete within the expected window and was recovered.",
      completed_at: new Date().toISOString(),
    })
    .eq("brand", brand)
    .eq("status", "running")
    .lt("started_at", cutoff);
}
