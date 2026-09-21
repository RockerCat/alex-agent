import type { WhatsAppTemplateMessageInput, WhatsAppSendResult, WhatsAppGraphClient } from "@/lib/agent/whatsappClient";
import { WhatsAppSendError } from "@/lib/agent/whatsappClient";

/**
 * Scripted stand-in for the real Meta Graph API WhatsApp client (mirrors
 * ScriptedFacebookClient/ScriptedInstagramClient), so
 * lib/agent/notifications.ts's success/failure/idempotency behavior is
 * testable without ever calling the real Meta endpoint.
 */
export class ScriptedWhatsAppClient implements WhatsAppGraphClient {
  sendCalls: WhatsAppTemplateMessageInput[] = [];
  private nextResult: WhatsAppSendResult;
  private queuedErrors: (Error | null)[];

  constructor(options: { messageId?: string; failWith?: Error; failSequence?: (Error | null)[] } = {}) {
    this.nextResult = { messageId: options.messageId ?? "wamid.fake-1" };
    this.queuedErrors = options.failSequence ?? [options.failWith ?? null];
  }

  async sendTemplateMessage(input: WhatsAppTemplateMessageInput): Promise<WhatsAppSendResult> {
    this.sendCalls.push(input);
    const err = this.queuedErrors.length > 1 ? this.queuedErrors.shift() : this.queuedErrors[0];
    if (err) throw err;
    return this.nextResult;
  }
}

export function whatsappRejection(message: string) {
  return new WhatsAppSendError(message);
}
