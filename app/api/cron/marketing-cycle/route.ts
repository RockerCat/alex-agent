import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { OpenAiClient } from "@/lib/agent/aiClient";
import { runMarketingCycle } from "@/lib/agent/runtime";
import { notifyAttentionIfNeeded } from "@/lib/agent/notifications";
import { MetaGraphWhatsAppClient } from "@/lib/agent/whatsappClient";

// Autonomy v1 Phase 1B — the authenticated headless entry point that lets
// Vercel Cron (see vercel.json; not yet configured with a real
// CRON_SECRET in production — see PROJECT_STATUS.md) wake SolarDesk's
// existing marketing-cycle runtime without a browser session. This is
// adaptor code only: it authenticates the caller and forwards to the
// exact same runMarketingCycle() the manual "Run Marketing Cycle" UI
// button already calls (see runMarketingCycleAction in app/actions.ts) —
// all lock/preflight/Budget Guard/resume behavior is unchanged and lives
// there, not here. No asset generation or publication is triggered by
// this endpoint; runMarketingCycle() never reaches those steps itself.
//
// GET + `Authorization: Bearer <CRON_SECRET>` is Vercel Cron's native,
// non-configurable contract (fixed GET method; auto-injects this header
// only for an env var named exactly CRON_SECRET) — see
// https://vercel.com/docs/cron-jobs/manage-cron-jobs. The prior
// custom-header contract had no real external caller, so it was
// replaced outright rather than kept alongside this.

const BEARER_PREFIX = "Bearer ";

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader || !authorizationHeader.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = authorizationHeader.slice(BEARER_PREFIX.length);
  return token.length > 0 ? token : null;
}

function secretsMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  // timingSafeEqual throws on mismatched lengths rather than returning
  // false, and a length mismatch is itself not secret, so check it first.
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

export async function GET(request: Request) {
  // Fail closed: an unconfigured secret must refuse every request, never
  // fall back to allowing the call through or to session-based auth.
  const expectedSecret = env.cronSecret();
  if (!expectedSecret) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }

  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token || !secretsMatch(token, expectedSecret)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // Authentication passed before any DB/AI client is constructed or
  // runMarketingCycle is invoked — an unauthorized request never reaches
  // agent_runs, Planner, or any other agent state.
  try {
    const db = supabaseAdmin();
    const aiClient = new OpenAiClient();
    const result = await runMarketingCycle({ db, aiClient, brand: "solardesk", trigger: "scheduled" });

    // Only after the marketing cycle's own durable state is fully
    // finalized (runMarketingCycle has already returned) — this must
    // never affect the response above, which reflects a completed
    // cycle regardless of what happens here. Independently wrapped: a
    // WhatsApp/config/provider failure is caught, safely persisted per
    // notification_outbox item inside notifyAttentionIfNeeded itself,
    // and only ever logged here — never re-thrown, never changes the
    // HTTP status/body already decided above.
    try {
      const whatsappClient = new MetaGraphWhatsAppClient();
      await notifyAttentionIfNeeded({
        db,
        whatsappClient,
        brand: "solardesk",
        runId: result.run.id,
        runDecision: result.run.decision,
      });
    } catch (notifyErr) {
      // Never let a bug in the notification layer itself (as opposed to
      // a provider-level failure, which notifyAttentionIfNeeded already
      // catches internally) affect this successful cron response.
      console.error("WhatsApp attention notification dispatch failed:", notifyErr instanceof Error ? notifyErr.message : "unknown error");
    }

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
