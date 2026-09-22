import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { MetaGraphWhatsAppClient } from "@/lib/agent/whatsappClient";
import { verifyWebhookChallenge, verifyWebhookSignature, parseStatusEvents, parseInboundMessages, recordProviderStatus } from "@/lib/agent/whatsappWebhook";
import { handleInboundMessage } from "@/lib/agent/whatsappInboundCommands";

// AlexAgent — WhatsApp Cloud API webhook (Autonomy v1). Adaptor code
// only: GET handles Meta's one-time verification handshake; POST
// forwards recognized message-status events to
// lib/agent/whatsappWebhook.ts's recordProviderStatus() (unchanged
// behavior) and recognized inbound text messages to
// lib/agent/whatsappInboundCommands.ts's handleInboundMessage() (WhatsApp
// Inbound Phase 1 — approve/reject only; see that module's header
// comment for the full processing order and invariants). This route
// itself never touches content_drafts/agent_questions/agent_runs
// directly, never invokes Planner/Executor/Visual Director/publish, and
// never creates an agent_run.
//
// Every POST must pass Meta's `X-Hub-Signature-256` payload-signature
// check BEFORE any parsing or DB/workflow operation — this was an
// acceptable gap while POST only wrote diagnostic provider-status
// fields, but is not acceptable now that a POST can approve/reject a
// real draft. This applies uniformly to every POST, including existing
// legitimate status callbacks — there is no separate, weaker path for
// them.

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
  const appSecret = env.metaWhatsappAppSecret();
  if (!appSecret) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }

  // Read the raw body ONCE, before any JSON parsing — HMAC verification
  // must run over the exact bytes Meta signed; re-serializing parsed
  // JSON would not reproduce them.
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-hub-signature-256");
  if (!verifyWebhookSignature({ rawBody, signatureHeader, appSecret })) {
    return NextResponse.json({ ok: false, error: "invalid_signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const db = supabaseAdmin();

  const statusEvents = parseStatusEvents(payload);
  for (const event of statusEvents) {
    try {
      await recordProviderStatus(db, event);
    } catch (err) {
      // Never let a diagnostics-recording failure leak into the
      // response, and never fail the ack for it — Meta retries
      // aggressively on a non-2xx response.
      console.error("WhatsApp webhook status recording failed:", err instanceof Error ? err.message : "unknown error");
    }
  }

  const inboundMessages = parseInboundMessages(payload);
  if (inboundMessages.length > 0) {
    const whatsappClient = new MetaGraphWhatsAppClient();
    for (const event of inboundMessages) {
      try {
        await handleInboundMessage({ db, whatsappClient, event });
      } catch (err) {
        // handleInboundMessage itself is designed to never throw (every
        // path returns a result) — this is defense in depth only, same
        // "never fail the ack" posture as the status-callback loop above.
        console.error("WhatsApp inbound message handling failed:", err instanceof Error ? err.message : "unknown error");
      }
    }
  }

  // Ack every signed, structurally valid webhook call with 200 — including
  // event types we don't act on — so Meta does not retry them as if they
  // were failures.
  return NextResponse.json({ ok: true });
}
