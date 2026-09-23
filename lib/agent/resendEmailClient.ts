import { Resend, type CreateEmailOptions, type CreateEmailRequestOptions, type CreateEmailResponse } from "resend";
import { env } from "@/lib/env";
import { EmailSendError, type EmailClient, type EmailSendInput, type EmailSendResult } from "@/lib/agent/emailClient";

// Resend-backed implementation of the provider-neutral EmailClient
// (lib/agent/emailClient.ts). Outbound only — no inbound/webhook handling.
//
// Verified against the installed SDK (resend@6.x), not assumed:
// - emails.send() never throws for HTTP/network failures; it resolves to
//   { data: null, error: { name, statusCode, message } }. Both that shape
//   and any unexpected throw are mapped to EmailSendError here.
// - Inline images: an attachment with `contentId` is sent inline and is
//   referenced from HTML as `cid:<contentId>`.
// - Idempotency: `idempotencyKey` is a request option sent as the
//   `Idempotency-Key` header (max 256 chars per Resend).
// - The send response carries ONLY Resend's own email id — no RFC
//   Message-ID. rfcMessageId is therefore always null at send time (a
//   later emails.get(id) or delivery webhook exposes `message_id`).
// - `new Resend()` without a key silently falls back to
//   process.env.RESEND_API_KEY and throws if absent; this client always
//   passes the configured key explicitly and never constructs the SDK
//   without one.

/** Resend's documented per-email attachment ceiling. */
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_ERROR_DETAIL_LENGTH = 300;
// Safe for both a MIME Content-ID and an HTML `cid:` reference.
const CONTENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
// Resend API keys are "re_"-prefixed; redact anything shaped like one.
const RESEND_KEY_PATTERN = /re_[A-Za-z0-9_-]{6,}/g;

/** The only slice of the Resend SDK this client uses — injectable so tests never call the real API. */
export interface ResendEmailsApi {
  send(payload: CreateEmailOptions, options?: CreateEmailRequestOptions): Promise<CreateEmailResponse>;
}

/**
 * Error text that can reach logs / notification_outbox.error_message:
 * single line, truncated, with the configured key and anything shaped
 * like a Resend key redacted. Never includes request payload/headers.
 */
export function sanitizeEmailErrorText(text: string, apiKey: string | null): string {
  let sanitized = text;
  if (apiKey) sanitized = sanitized.split(apiKey).join("[redacted]");
  sanitized = sanitized.replace(RESEND_KEY_PATTERN, "[redacted]").replace(/\s+/g, " ").trim();
  return sanitized.length > MAX_ERROR_DETAIL_LENGTH ? `${sanitized.slice(0, MAX_ERROR_DETAIL_LENGTH - 3)}...` : sanitized;
}

function assertValidInput(input: EmailSendInput): void {
  if (!input.from.trim() || !input.to.trim()) {
    throw new EmailSendError("Email sender and recipient are required.");
  }
  if (!input.subject.trim() || !input.html.trim() || !input.text.trim()) {
    throw new EmailSendError("Email subject, HTML body, and plain-text body are all required.");
  }
  if (input.idempotencyKey !== undefined && (!input.idempotencyKey || input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH)) {
    throw new EmailSendError(`Idempotency key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`);
  }
  const attachments = input.inlineAttachments ?? [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const attachment of attachments) {
    if (!CONTENT_ID_PATTERN.test(attachment.contentId)) {
      throw new EmailSendError("Inline attachment contentId contains unsupported characters.");
    }
    if (seen.has(attachment.contentId)) {
      throw new EmailSendError("Inline attachment contentIds must be unique.");
    }
    seen.add(attachment.contentId);
    totalBytes += attachment.content.length;
  }
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new EmailSendError("Inline attachments exceed the provider's 40MB per-email limit.");
  }
}

export class ResendEmailClient implements EmailClient {
  /** `emailsApi` is for tests only; production constructs the real SDK lazily, per send, from the configured key. */
  constructor(private readonly emailsApi?: ResendEmailsApi) {}

  async sendEmail(input: EmailSendInput): Promise<EmailSendResult> {
    const apiKey = env.resendApiKey();
    if (!apiKey) {
      throw new EmailSendError("Resend API key is not configured.");
    }
    assertValidInput(input);

    const payload: CreateEmailOptions = {
      from: input.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.inlineAttachments?.length
        ? {
            attachments: input.inlineAttachments.map((a) => ({
              filename: a.filename,
              content: a.content,
              contentType: a.contentType,
              contentId: a.contentId,
            })),
          }
        : {}),
    };
    const options: CreateEmailRequestOptions | undefined = input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined;

    let response: CreateEmailResponse;
    try {
      const emails = this.emailsApi ?? new Resend(apiKey).emails;
      response = await emails.send(payload, options);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown error";
      throw new EmailSendError(`Unexpected error calling Resend: ${sanitizeEmailErrorText(detail, apiKey)}`);
    }

    if (response.error) {
      const { name, statusCode, message } = response.error;
      const status = statusCode ? ` (HTTP ${statusCode})` : "";
      throw new EmailSendError(`Resend rejected the email send request: ${sanitizeEmailErrorText(`${name}${status}: ${message}`, apiKey)}`);
    }

    const providerMessageId = response.data?.id;
    if (!providerMessageId) {
      throw new EmailSendError("Resend returned success but no email id.");
    }
    return { providerMessageId, rfcMessageId: null };
  }
}
