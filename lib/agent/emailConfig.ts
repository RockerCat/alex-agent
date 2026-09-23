import { env } from "@/lib/env";
import { EmailSendError } from "@/lib/agent/emailClient";

// Provider-neutral outbound email addressing/capability (Email HITL).
// Mirrors whatsappNotificationsCapabilityAvailable() in
// lib/agent/whatsappClient.ts: a future notifier checks capability first
// and skips cleanly when email isn't configured — that is not itself a
// failure. Nothing here runs at import time.

export interface ReviewEmailAddressing {
  from: string;
  to: string;
}

/** True only when the provider key, sender, and review recipient are all explicitly configured. */
export function emailOutboundCapabilityAvailable(): boolean {
  return Boolean(env.resendApiKey() && env.emailFrom() && env.emailReviewRecipient());
}

/**
 * Fail-closed: throws EmailSendError (never falls back to a default
 * sender/recipient) when either address is missing. Never includes the
 * configured values in the error.
 */
export function resolveReviewEmailAddressing(): ReviewEmailAddressing {
  const from = env.emailFrom();
  const to = env.emailReviewRecipient();
  if (!from || !to) {
    throw new EmailSendError("Outbound review email is not configured (sender and/or review recipient missing).");
  }
  return { from, to };
}
