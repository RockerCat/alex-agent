import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import type { EmailClient } from "@/lib/agent/emailClient";
import { ResendEmailClient } from "@/lib/agent/resendEmailClient";
import { emailOutboundCapabilityAvailable, resolveReviewEmailAddressing, type ReviewEmailAddressing } from "@/lib/agent/emailConfig";
import { prepareContentReviewNotification, deliverPreparedReviewEmail } from "@/lib/agent/emailReviewNotifications";
import { SUPPORTED_BRANDS } from "@/lib/agent/constants";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { env } from "@/lib/env";

// AlexAgent — automatic entry into the email human loop: every durable
// content_drafts row that is pending_approval gets exactly one content-
// review email per version, sent from the normal wake
// (app/api/cron/marketing-cycle/route.ts) after runMarketingCycle() has
// finalized. Email is the primary approval channel.
//
// Source of truth is DURABLE state, never the Planner's return value: the
// sweep reads pending_approval drafts directly, so it covers a wake that
// created a new plan with several drafts, drafts from earlier wakes whose
// email failed or was missed, and new versions produced by a revision.
//
// Idempotency and retry come entirely from the existing infrastructure:
// prepareContentReviewNotification() claims the unique
// (brand, email, draft_pending_approval, content_draft, id, version)
// notification_outbox identity — a 'sent' review is never re-prepared,
// a 'failed' (or stale 'pending') one is reclaimed with fresh tokens, a
// new version is a new identity. deliverPreparedReviewEmail() records the
// send result on that row.
//
// This sweep is CONTENT review only: it never generates an asset, never
// calls the Planner/Executor or any model, and never publishes. (Asset
// generation happens only after an email approval — see
// lib/agent/postApprovalContinuation.ts.) Agent questions
// (NEEDS_HUMAN_INPUT) are deliberately NOT emailed yet: there is no
// inbound reply path to answer them until Phase 2C.

export interface ContentReviewEmailDeps {
  db: SupabaseClient<Database>;
  emailClient: EmailClient;
  addressing: ReviewEmailAddressing;
  baseUrl: string;
}

export type ContentReviewSweepOutcome = "sent" | "delivery_failed" | "concurrent" | "not_eligible" | "error";

/** Covers a full new plan (MAX_CONTENT_PER_CYCLE = 7) plus stragglers from earlier wakes; the rest continue on the next wake. */
const DEFAULT_CONTENT_REVIEW_SWEEP_LIMIT = 10;

export async function runContentReviewEmailSweep(
  deps: ContentReviewEmailDeps,
  options: { limit?: number; now?: Date } = {}
): Promise<{ outcomes: ContentReviewSweepOutcome[] }> {
  const limit = options.limit ?? DEFAULT_CONTENT_REVIEW_SWEEP_LIMIT;
  const { data: drafts } = await deps.db
    .from("content_drafts")
    .select("*")
    .eq("status", "pending_approval")
    .in("brand", [...SUPPORTED_BRANDS])
    .order("created_at", { ascending: true });

  const outcomes: ContentReviewSweepOutcome[] = [];
  for (const draft of drafts ?? []) {
    if (outcomes.length >= limit) break;
    // A draft blocked on a factual question isn't reviewable content yet.
    if (draft.blocked_on_question_id) continue;

    // Cheap pre-filter so already-reviewed drafts never consume the limit.
    const { data: sent } = await deps.db
      .from("notification_outbox")
      .select("id")
      .eq("brand", draft.brand)
      .eq("channel", "email")
      .eq("notification_type", "draft_pending_approval")
      .eq("subject_type", "content_draft")
      .eq("subject_id", draft.id)
      .eq("subject_version", draft.version)
      .eq("status", "sent")
      .maybeSingle();
    if (sent) continue;

    try {
      const prepared = await prepareContentReviewNotification(deps.db, { draftId: draft.id, baseUrl: deps.baseUrl, now: options.now });
      if (prepared.status === "already_sent") continue; // raced with another sender — nothing to do
      if (prepared.status !== "prepared") {
        outcomes.push(prepared.status === "concurrent" ? "concurrent" : "not_eligible");
        continue;
      }
      const delivered = await deliverPreparedReviewEmail(deps.db, deps.emailClient, prepared, deps.addressing);
      outcomes.push(delivered.status === "sent" ? "sent" : "delivery_failed");
    } catch (err) {
      // One draft's failure never blocks the others or touches the draft.
      console.error("Content-review email failed for one draft:", err instanceof Error ? err.message : "unknown error");
      outcomes.push("error");
    }
  }
  return { outcomes };
}

/**
 * Production dependencies, or null when outbound email or the app origin
 * isn't configured — email review is then inactive (not a failure), and
 * the wake falls back to its previous WhatsApp attention behavior.
 * Never throws.
 */
export function createProductionContentReviewDeps(): ContentReviewEmailDeps | null {
  try {
    const baseUrl = env.appBaseUrl();
    if (!baseUrl || !emailOutboundCapabilityAvailable()) return null;
    return { db: supabaseAdmin(), emailClient: new ResendEmailClient(), addressing: resolveReviewEmailAddressing(), baseUrl };
  } catch {
    return null;
  }
}
