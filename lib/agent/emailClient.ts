// AlexAgent — Email human-in-the-loop: provider-neutral outbound seam.
//
// Interface only — no provider is integrated here and nothing in the app
// sends email yet. Mirrors the FacebookPageClient / InstagramGraphClient
// / WhatsAppGraphClient injection pattern: a future provider-backed
// implementation (Resend) will implement EmailClient; tests inject
// ScriptedEmailClient (tests/support/fakeEmailClient.ts) so success/
// failure/idempotency paths are testable without ever calling a real
// provider.
//
// Deliberately models only capabilities the email workflow is already
// known to need (see the Email HITL audit): transactional HTML + plain
// text, a per-notification Reply-To (the future reply-token address),
// optional inline CID images (generated assets/carousel slides, so the
// visual is reviewable without a public image URL), a provider
// idempotency key (so a reclaimed notification_outbox retry cannot send
// twice when the provider supports it), and the ids needed to record a
// send in notification_outbox (provider_message_id, rfc_message_id).

export class EmailSendError extends Error {}

export interface EmailInlineAttachment {
  /** Referenced from the HTML body as `cid:<contentId>`. */
  contentId: string;
  filename: string;
  /** e.g. "image/png", "image/jpeg". */
  contentType: string;
  content: Buffer;
}

export interface EmailSendInput {
  from: string;
  to: string;
  /** Where Alex's reply goes (the future per-notification reply-token address). */
  replyTo?: string;
  subject: string;
  html: string;
  /** Plain-text alternative — always required, never derived from HTML by the provider. */
  text: string;
  inlineAttachments?: EmailInlineAttachment[];
  /** Stable per logical send (e.g. derived from the notification_outbox row), so a retry is deduplicated by the provider where supported. */
  idempotencyKey?: string;
}

export interface EmailSendResult {
  /** The provider's own id for this send → notification_outbox.provider_message_id. */
  providerMessageId: string;
  /** The RFC 5322 Message-ID header value, when the provider exposes it → notification_outbox.rfc_message_id. */
  rfcMessageId: string | null;
}

export interface EmailClient {
  /**
   * Sends one transactional email. Must throw EmailSendError (with a
   * sanitized message — never an API key or authorization header) on any
   * provider rejection or transport failure.
   */
  sendEmail(input: EmailSendInput): Promise<EmailSendResult>;
}
