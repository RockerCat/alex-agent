import type { EmailClient, EmailSendInput, EmailSendResult } from "@/lib/agent/emailClient";
import { EmailSendError } from "@/lib/agent/emailClient";

/**
 * Scripted stand-in for a real email provider client (mirrors
 * ScriptedWhatsAppClient), so future email notification/idempotency
 * behavior is testable without ever calling a real provider.
 */
export class ScriptedEmailClient implements EmailClient {
  sendCalls: EmailSendInput[] = [];
  private queuedErrors: (Error | null)[];

  constructor(options: { failWith?: Error; failSequence?: (Error | null)[] } = {}) {
    this.queuedErrors = options.failSequence ?? [options.failWith ?? null];
  }

  async sendEmail(input: EmailSendInput): Promise<EmailSendResult> {
    this.sendCalls.push(input);
    const err = this.queuedErrors.length > 1 ? this.queuedErrors.shift() : this.queuedErrors[0];
    if (err) throw err;
    const n = this.sendCalls.length;
    return { providerMessageId: `email-fake-${n}`, rfcMessageId: `<email-fake-${n}@example.test>` };
  }
}

export function emailRejection(message: string) {
  return new EmailSendError(message);
}
