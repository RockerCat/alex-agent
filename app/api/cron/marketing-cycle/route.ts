import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { OpenAiClient } from "@/lib/agent/aiClient";
import { runMarketingCycle } from "@/lib/agent/runtime";

// Autonomy v1 Phase 1A — the authenticated headless entry point that lets
// a future scheduler (not yet connected — see PROJECT_STATUS.md) wake
// SolarDesk's existing marketing-cycle runtime without a browser session.
// This is adaptor code only: it authenticates the caller and forwards to
// the exact same runMarketingCycle() the manual "Run Marketing Cycle" UI
// button already calls (see runMarketingCycleAction in app/actions.ts) —
// all lock/preflight/Budget Guard/resume behavior is unchanged and lives
// there, not here. No asset generation or publication is triggered by
// this endpoint; runMarketingCycle() never reaches those steps itself.

const CRON_SECRET_HEADER = "x-alexagent-cron-secret";

function secretsMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  // timingSafeEqual throws on mismatched lengths rather than returning
  // false, and a length mismatch is itself not secret, so check it first.
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

export async function POST(request: Request) {
  // Fail closed: an unconfigured secret must refuse every request, never
  // fall back to allowing the call through or to session-based auth.
  const expectedSecret = env.alexagentCronSecret();
  if (!expectedSecret) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }

  const provided = request.headers.get(CRON_SECRET_HEADER);
  if (!provided || !secretsMatch(provided, expectedSecret)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // Authentication passed before any DB/AI client is constructed or
  // runMarketingCycle is invoked — an unauthorized request never reaches
  // agent_runs, Planner, or any other agent state.
  try {
    const db = supabaseAdmin();
    const aiClient = new OpenAiClient();
    const result = await runMarketingCycle({ db, aiClient, brand: "solardesk", trigger: "scheduled" });

    return NextResponse.json({
      ok: true,
      runId: result.run.id,
      status: result.run.status,
      decision: result.run.decision,
      concurrent: result.concurrent ?? false,
    });
  } catch {
    // runMarketingCycle() already persists durable failure state for
    // failures inside its own try/catch; this only catches the narrow
    // case of a thrown error before/around that (e.g. recoverStaleRuns
    // or acquireRunLock itself failing). Never echo the raw error here —
    // it could contain DB/provider error text.
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}
