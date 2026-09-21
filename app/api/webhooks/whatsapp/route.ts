import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { verifyWebhookChallenge, parseStatusEvents, recordProviderStatus } from "@/lib/agent/whatsappWebhook";

// AlexAgent — WhatsApp Cloud API webhook (Autonomy v1, diagnostics only).
// Adaptor code only: GET handles Meta's one-time verification handshake,
// POST forwards recognized message-status events to
// lib/agent/whatsappWebhook.ts's recordProviderStatus(). This route
// itself never touches content_drafts/agent_questions/agent_runs and
// never invokes Planner/Executor/Visual Director/publish — see that
// module's header comment for why. Inbound WhatsApp commands
// (approve/reject/question-answering) are explicitly out of scope here.

export async function GET(request: Request) {
  const expectedToken = env.metaWhatsappWebhookVerifyToken();
  if (!expectedToken) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }

  const url = new URL(request.url);
  const verified = verifyWebhookChallenge({
    mode: url.searchParams.get("hub.mode"),
    token: url.searchParams.get("hub.verify_token"),
    challenge: url.searchParams.get("hub.challenge"),
    expectedToken,
  });

  if (verified === null) {
    return new NextResponse(null, { status: 403 });
  }

  // Meta requires the raw challenge value echoed back as the plain
  // response body — never JSON-wrapped.
  return new NextResponse(verified, { status: 200 });
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const events = parseStatusEvents(payload);
  if (events.length > 0) {
    const db = supabaseAdmin();
    for (const event of events) {
      try {
        await recordProviderStatus(db, event);
      } catch (err) {
        // Never let a diagnostics-recording failure leak into the
        // response, and never fail the ack for it — this endpoint has
        // zero workflow state to protect, and Meta retries aggressively
        // on a non-2xx response.
        console.error("WhatsApp webhook status recording failed:", err instanceof Error ? err.message : "unknown error");
      }
    }
  }

  // Ack every structurally valid webhook call with 200 — including
  // event types we don't act on (e.g. inbound messages) — so Meta does
  // not retry them as if they were failures.
  return NextResponse.json({ ok: true });
}
