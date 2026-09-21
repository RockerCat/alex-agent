import { env } from "@/lib/env";

// AlexAgent — WhatsApp outbound attention notifications (Autonomy v1,
// outbound only). Thin server-side seam over the Meta WhatsApp Cloud
// API's template-message send endpoint, mirroring the
// FacebookPageClient/MetaGraphFacebookClient and
// InstagramGraphClient/MetaGraphInstagramClient injection pattern
// already established in lib/agent/facebookClient.ts and
// lib/agent/instagramClient.ts: production code uses
// MetaGraphWhatsAppClient; tests inject a scripted fake so
// success/failure paths are testable without ever calling the real
// Meta endpoint.
//
// WhatsApp Cloud API is served through the same graph.facebook.com
// Graph API host/version family Facebook publishing already uses here
// (unlike Instagram Login, which needed its own separate
// graph.instagram.com host — see instagramClient.ts's history). This
// has NOT been independently reverified against a live send in this
// codebase (the approved template is still under Meta review at
// implementation time) — confirm the exact current supported Graph API
// version for WhatsApp Cloud API against Meta's own documentation
// before the first real send.
const GRAPH_API_VERSION = "v26.0";
const GRAPH_API_HOST = "https://graph.facebook.com";

export class WhatsAppSendError extends Error {}

/**
 * Meta's Cloud API rejects template BODY parameter values containing
 * newline/tab characters or long runs of spaces (observed in production
 * as error #132018, "There's an issue with the parameters in your
 * template") — this tripped on notifications.ts's
 * `${truncated}\n${approvalUrl}` draft-attention value. Sanitizing here,
 * once, keeps every caller's parameter values Meta-contract-compliant
 * without each call site having to know about this restriction.
 */
function sanitizeParameterText(text: string): string {
  return text.replace(/[\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

export interface WhatsAppTemplateMessageInput {
  /** E.164 destination number, e.g. "+573001234567". */
  to: string;
  templateName: string;
  /** Meta template language code, e.g. "es_CO". */
  languageCode: string;
  /** Positional body variables, filling {{1}}, {{2}}, {{3}}... in order. */
  bodyParameters: string[];
}

export interface WhatsAppSendResult {
  messageId: string;
}

export interface WhatsAppGraphClient {
  sendTemplateMessage(input: WhatsAppTemplateMessageInput): Promise<WhatsAppSendResult>;
}

/** True only when the WhatsApp access token, phone number id, and Alex's destination number are all explicitly configured. */
export function whatsappNotificationsCapabilityAvailable(): boolean {
  return Boolean(env.metaWhatsappAccessToken() && env.metaWhatsappPhoneNumberId() && env.metaWhatsappDestinationNumber());
}

export class MetaGraphWhatsAppClient implements WhatsAppGraphClient {
  async sendTemplateMessage(input: WhatsAppTemplateMessageInput): Promise<WhatsAppSendResult> {
    const phoneNumberId = env.metaWhatsappPhoneNumberId();
    const accessToken = env.metaWhatsappAccessToken();
    if (!phoneNumberId || !accessToken) {
      throw new WhatsAppSendError("Meta WhatsApp configuration is missing.");
    }

    const body = {
      messaging_product: "whatsapp",
      to: input.to,
      type: "template",
      template: {
        name: input.templateName,
        language: { code: input.languageCode },
        components: [
          {
            type: "body",
            parameters: input.bodyParameters.map((text) => ({ type: "text", text: sanitizeParameterText(text) })),
          },
        ],
      },
    };

    let response: Response;
    try {
      response = await fetch(`${GRAPH_API_HOST}/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Never log/include this header value anywhere below —
          // errors are constructed only from the parsed response body.
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new WhatsAppSendError(`Network error calling the Meta Graph API: ${err instanceof Error ? err.message : "unknown error"}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new WhatsAppSendError(`Meta Graph API returned a non-JSON response (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      const errObj = (json as { error?: { message?: string } } | null)?.error;
      throw new WhatsAppSendError(`Meta Graph API rejected the WhatsApp send request: ${errObj?.message ?? `HTTP ${response.status}`}`);
    }

    const messageId = (json as { messages?: { id?: string }[] } | null)?.messages?.[0]?.id;
    if (!messageId) {
      throw new WhatsAppSendError("Meta Graph API returned success but no message id.");
    }
    return { messageId };
  }
}
