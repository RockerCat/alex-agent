import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { OpenAiClient } from "@/lib/agent/aiClient";
import { runMarketingCycle } from "@/lib/agent/runtime";
import { notifyAttentionIfNeeded } from "@/lib/agent/notifications";
import { MetaGraphWhatsAppClient } from "@/lib/agent/whatsappClient";
import { createProductionContinuationDeps, runPostApprovalContinuationSweep } from "@/lib/agent/postApprovalContinuation";
import { createProductionContentReviewDeps, runContentReviewEmailSweep } from "@/lib/agent/contentReviewSweep";
import { createProductionPublicationDeps, runPublicationRecoverySweep } from "@/lib/agent/postApprovalPublication";

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

    // Everything below runs only after the marketing cycle's own durable
    // state is fully finalized (runMarketingCycle has already returned),
    // and must never affect the response below, which reflects a completed
    // cycle regardless of what happens here. Each step is independently
    // wrapped: failures are logged only — never re-thrown, never change
    // the HTTP status/body.

    // 1. Email is the primary human-attention channel: send a content-
    //    review email for every durable pending_approval draft that hasn't
    //    had one for its current version (drafts this wake created AND
    //    earlier drafts whose email failed or was missed). Reads durable
    //    draft state — never the Planner output — and makes no model call.
    let contentReviewEmailActive = false;
    try {
      const contentReviewDeps = createProductionContentReviewDeps();
      contentReviewEmailActive = contentReviewDeps !== null;
      if (contentReviewDeps) {
        const sweep = await runContentReviewEmailSweep(contentReviewDeps);
        if (sweep.outcomes.length > 0) {
          console.log(`Content-review email sweep: ${sweep.outcomes.join(", ")}`);
        }
      }
    } catch (sweepErr) {
      console.error("Content-review email sweep failed:", sweepErr instanceof Error ? sweepErr.message : "unknown error");
    }

    // 2. WhatsApp attention notifications — dormant/fallback. When email
    //    review is active, a pending-approval attention event
    //    (WAIT_FOR_APPROVAL) is already covered by the content-review
    //    email above, so WhatsApp is skipped rather than notifying twice.
    //    Blocking questions (NEEDS_HUMAN_INPUT) are unchanged: email can't
    //    carry questions until inbound replies exist (Phase 2C). A provider
    //    failure is persisted per notification_outbox item inside
    //    notifyAttentionIfNeeded itself.
    const pendingApprovalCoveredByEmail = contentReviewEmailActive && result.run.decision === "WAIT_FOR_APPROVAL";
    if (!pendingApprovalCoveredByEmail) {
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
    }

    // 3. Email lifecycle catch-up (recovery only): continues email-approved
    // image_post drafts that still lack their first asset or their
    // finished-publication review email — e.g. when the post-response
    // continuation after an email approval failed or was cut short. Same
    // isolation as the blocks above: runs only after the marketing
    // cycle has finalized, never affects this response, never throws out.
    // Idempotent and bounded (see runPostApprovalContinuationSweep); it
    // never regenerates, never re-sends a sent review, never publishes.
    try {
      const continuationDeps = createProductionContinuationDeps();
      if (continuationDeps) {
        const sweep = await runPostApprovalContinuationSweep(continuationDeps);
        if (sweep.outcomes.length > 0) {
          console.log(`Post-approval continuation sweep: ${sweep.outcomes.join(", ")}`);
        }
      }
    } catch (sweepErr) {
      console.error("Post-approval continuation sweep failed:", sweepErr instanceof Error ? sweepErr.message : "unknown error");
    }

    // 4. Publication recovery: publishes assets that received an APPLIED
    //    "Aprobar publicación" email authorization (exact asset version)
    //    but whose post-response publication didn't complete. Only
    //    provably-safe failures are retried; uncertain provider outcomes
    //    and in-flight attempts are held for manual verification; dashboard-
    //    approved assets are never touched. Same isolation as above.
    try {
      const publicationDeps = createProductionPublicationDeps();
      if (publicationDeps) {
        const sweep = await runPublicationRecoverySweep(publicationDeps);
        if (sweep.outcomes.length > 0) {
          console.log(`Publication recovery sweep: ${sweep.outcomes.join(", ")}`);
        }
      }
    } catch (sweepErr) {
      console.error("Publication recovery sweep failed:", sweepErr instanceof Error ? sweepErr.message : "unknown error");
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
