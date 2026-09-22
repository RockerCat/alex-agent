import type { WhatsAppTemplateMessageInput, WhatsAppTextMessageInput, WhatsAppSendResult, WhatsAppGraphClient } from "@/lib/agent/whatsappClient";
import { WhatsAppSendError } from "@/lib/agent/whatsappClient";

/**
 * Scripted stand-in for the real Meta Graph API WhatsApp client (mirrors
 * ScriptedFacebookClient/ScriptedInstagramClient), so
 * lib/agent/notifications.ts's and lib/agent/whatsappInboundCommands.ts's
 * success/failure/idempotency behavior is testable without ever calling
 * the real Meta endpoint.
 */
export class ScriptedWhatsAppClient implements WhatsAppGraphClient {
  sendCalls: WhatsAppTemplateMessageInput[] = [];
  textCalls: WhatsAppTextMessageInput[] = [];
  private nextResult: WhatsAppSendResult;
  private queuedErrors: (Error | null)[];
  private textFailWith: Error | null;

  constructor(options: { messageId?: string; failWith?: Error; failSequence?: (Error | null)[]; textFailWith?: Error } = {}) {
    this.nextResult = { messageId: options.messageId ?? "wamid.fake-1" };
    this.queuedErrors = options.failSequence ?? [options.failWith ?? null];
    this.textFailWith = options.textFailWith ?? null;
  }

  async sendTemplateMessage(input: WhatsAppTemplateMessageInput): Promise<WhatsAppSendResult> {
    this.sendCalls.push(input);
    const err = this.queuedErrors.length > 1 ? this.queuedErrors.shift() : this.queuedErrors[0];
    if (err) throw err;
    return this.nextResult;
  }

  async sendTextMessage(input: WhatsAppTextMessageInput): Promise<WhatsAppSendResult> {
    this.textCalls.push(input);
    if (this.textFailWith) throw this.textFailWith;
    return { messageId: `wamid.fake-text-${this.textCalls.length}` };
  }
}

export function whatsappRejection(message: string) {
  return new WhatsAppSendError(message);
}
