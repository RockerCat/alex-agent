import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MetaGraphWhatsAppClient, WhatsAppSendError, whatsappNotificationsCapabilityAvailable } from "@/lib/agent/whatsappClient";

// AlexAgent — WhatsApp outbound attention notifications (Autonomy v1).
// Direct tests of the real production client's request construction
// (never a real network call to Meta): a local mocked global.fetch
// captures exactly what MetaGraphWhatsAppClient sends. The approved
// message template (alexagent_attention_required) is still under Meta
// review at implementation time, so this suite — like
// facebookClient.test.ts/instagramClient.test.ts before it — validates
// request/error-handling correctness without depending on a real send
// ever succeeding.

const REAL_TOKEN = "EAA-fake-whatsapp-token-for-tests-only";
const PHONE_NUMBER_ID = "111222333444555";
const DESTINATION = "+573001234567";

function captureFetch(responseBody: unknown = { messages: [{ id: "wamid.abc123" }] }, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    install() {
      global.fetch = (async (url: string, init?: RequestInit) => {
        calls.push({ url, init: init! });
        return new Response(JSON.stringify(responseBody), { status });
      }) as typeof fetch;
    },
  };
}

describe("MetaGraphWhatsAppClient", () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.META_WHATSAPP_ACCESS_TOKEN = REAL_TOKEN;
    process.env.META_WHATSAPP_PHONE_NUMBER_ID = PHONE_NUMBER_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
  });

  it("1. posts to /{phone-number-id}/messages with POST and a Bearer authorization header", async () => {
    const capture = captureFetch();
    capture.install();
    const client = new MetaGraphWhatsAppClient();

    await client.sendTemplateMessage({
      to: DESTINATION,
      templateName: "alexagent_attention_required",
      languageCode: "es_CO",
      bodyParameters: ["SolarDesk", "un contenido pendiente de aprobación", "Título del borrador"],
    });

    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0].url).toBe(`https://graph.facebook.com/v26.0/${PHONE_NUMBER_ID}/messages`);
    expect(capture.calls[0].init.method).toBe("POST");
    expect((capture.calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${REAL_TOKEN}`);
  });

  it("2. sends the correct template payload shape with positional body parameters in order", async () => {
    const capture = captureFetch();
    capture.install();
    const client = new MetaGraphWhatsAppClient();

    await client.sendTemplateMessage({
      to: DESTINATION,
      templateName: "alexagent_attention_required",
      languageCode: "es_CO",
      bodyParameters: ["SolarDesk", "un contenido pendiente de aprobación", "Título del borrador"],
    });

    const body = JSON.parse(capture.calls[0].init.body as string);
    expect(body.messaging_product).toBe("whatsapp");
    expect(body.to).toBe(DESTINATION);
    expect(body.type).toBe("template");
    expect(body.template.name).toBe("alexagent_attention_required");
    expect(body.template.language.code).toBe("es_CO");
    expect(body.template.components).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "SolarDesk" },
          { type: "text", text: "un contenido pendiente de aprobación" },
          { type: "text", text: "Título del borrador" },
        ],
      },
    ]);
  });

  it("2b. strips newline/tab characters and collapses runs of spaces in body parameters (Meta #132018)", async () => {
    const capture = captureFetch();
    capture.install();
    const client = new MetaGraphWhatsAppClient();

    await client.sendTemplateMessage({
      to: DESTINATION,
      templateName: "alexagent_attention_required",
      languageCode: "es_CO",
      bodyParameters: ["SolarDesk", "una publicación pendiente de aprobación", "Título del borrador\nhttps://example.com/approvals/abc123"],
    });

    const body = JSON.parse(capture.calls[0].init.body as string);
    expect(body.template.components).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "SolarDesk" },
          { type: "text", text: "una publicación pendiente de aprobación" },
          { type: "text", text: "Título del borrador https://example.com/approvals/abc123" },
        ],
      },
    ]);
  });

  it("3. never puts the access token in the request URL", async () => {
    const capture = captureFetch();
    capture.install();
    const client = new MetaGraphWhatsAppClient();

    await client.sendTemplateMessage({ to: DESTINATION, templateName: "t", languageCode: "es_CO", bodyParameters: ["a", "b", "c"] });

    expect(capture.calls[0].url).not.toContain(REAL_TOKEN);
  });

  it("4. returns Meta's message id on success", async () => {
    const capture = captureFetch({ messages: [{ id: "wamid.real-123" }] });
    capture.install();
    const client = new MetaGraphWhatsAppClient();

    const result = await client.sendTemplateMessage({ to: DESTINATION, templateName: "t", languageCode: "es_CO", bodyParameters: ["a", "b", "c"] });

    expect(result.messageId).toBe("wamid.real-123");
  });

  it("5. surfaces Meta's rejection reason without ever leaking the access token", async () => {
    let sentAuthHeader: string | null = null;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      sentAuthHeader = (init!.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ error: { message: "Template alexagent_attention_required is not approved yet." } }), { status: 400 });
    }) as typeof fetch;
    const client = new MetaGraphWhatsAppClient();

    let thrown: unknown;
    try {
      await client.sendTemplateMessage({ to: DESTINATION, templateName: "alexagent_attention_required", languageCode: "es_CO", bodyParameters: ["a", "b", "c"] });
    } catch (err) {
      thrown = err;
    }

    // Meta genuinely receives the real token (that's correct/required)...
    expect(sentAuthHeader).toBe(`Bearer ${REAL_TOKEN}`);
    // ...but the error that reaches logs/notification_outbox must never contain it.
    expect(thrown).toBeInstanceOf(WhatsAppSendError);
    expect(String(thrown)).toContain("not approved yet");
    expect(String(thrown)).not.toContain(REAL_TOKEN);
  });

  it("6. a malformed success response without a message id fails safely", async () => {
    global.fetch = (async () => new Response(JSON.stringify({ messaging_product: "whatsapp" }), { status: 200 })) as typeof fetch;
    const client = new MetaGraphWhatsAppClient();

    await expect(
      client.sendTemplateMessage({ to: DESTINATION, templateName: "t", languageCode: "es_CO", bodyParameters: ["a", "b", "c"] })
    ).rejects.toThrow(WhatsAppSendError);
  });

  it("7. a network failure is surfaced as a WhatsAppSendError, never an uncaught rejection shape", async () => {
    global.fetch = (async () => {
      throw new Error("fetch failed: getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    const client = new MetaGraphWhatsAppClient();

    await expect(
      client.sendTemplateMessage({ to: DESTINATION, templateName: "t", languageCode: "es_CO", bodyParameters: ["a", "b", "c"] })
    ).rejects.toThrow(WhatsAppSendError);
  });

  it("8. missing configuration fails before ever calling fetch", async () => {
    delete process.env.META_WHATSAPP_ACCESS_TOKEN;
    const capture = captureFetch();
    capture.install();
    const client = new MetaGraphWhatsAppClient();

    await expect(
      client.sendTemplateMessage({ to: DESTINATION, templateName: "t", languageCode: "es_CO", bodyParameters: ["a", "b", "c"] })
    ).rejects.toThrow(WhatsAppSendError);
    expect(capture.calls).toHaveLength(0);
  });

  describe("whatsappNotificationsCapabilityAvailable", () => {
    beforeEach(() => {
      process.env.META_WHATSAPP_DESTINATION_NUMBER = DESTINATION;
    });

    it("9. true only when access token, phone number id, and destination number are all configured", () => {
      expect(whatsappNotificationsCapabilityAvailable()).toBe(true);
    });

    it("10. false when the access token is missing", () => {
      delete process.env.META_WHATSAPP_ACCESS_TOKEN;
      expect(whatsappNotificationsCapabilityAvailable()).toBe(false);
    });

    it("11. false when the phone number id is missing", () => {
      delete process.env.META_WHATSAPP_PHONE_NUMBER_ID;
      expect(whatsappNotificationsCapabilityAvailable()).toBe(false);
    });

    it("12. false when the destination number is missing", () => {
      delete process.env.META_WHATSAPP_DESTINATION_NUMBER;
      expect(whatsappNotificationsCapabilityAvailable()).toBe(false);
    });
  });
});
