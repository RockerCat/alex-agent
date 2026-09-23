import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CreateEmailOptions, CreateEmailRequestOptions, CreateEmailResponse } from "resend";
import { ResendEmailClient, sanitizeEmailErrorText, type ResendEmailsApi } from "@/lib/agent/resendEmailClient";
import { EmailSendError, type EmailSendInput } from "@/lib/agent/emailClient";
import { emailOutboundCapabilityAvailable, resolveReviewEmailAddressing } from "@/lib/agent/emailConfig";

// Resend outbound mapping, failure sanitization, and fail-closed config.
// The real Resend SDK is never called: every test injects a scripted
// emails API, and global fetch is stubbed to fail loudly if anything
// ever tried to reach the network.

const FAKE_KEY = "re_TestOnly_abcdef1234567890";

class ScriptedResendEmails implements ResendEmailsApi {
  calls: { payload: CreateEmailOptions; options?: CreateEmailRequestOptions }[] = [];
  constructor(private respond: () => Promise<CreateEmailResponse> = async () => ({ data: { id: "resend-email-1" }, error: null, headers: null })) {}
  async send(payload: CreateEmailOptions, options?: CreateEmailRequestOptions): Promise<CreateEmailResponse> {
    this.calls.push({ payload, options });
    return this.respond();
  }
}

function input(overrides: Partial<EmailSendInput> = {}): EmailSendInput {
  return {
    from: "AlexAgent <review@mail.agent.alexsosa.me>",
    to: "owner@example.test",
    subject: "Asunto",
    html: "<p>Hola</p>",
    text: "Hola",
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", FAKE_KEY);
  vi.stubEnv("EMAIL_FROM", "AlexAgent <review@mail.agent.alexsosa.me>");
  vi.stubEnv("EMAIL_REVIEW_RECIPIENT", "owner@example.test");
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("Network access is not allowed in tests.");
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("ResendEmailClient — request mapping", () => {
  it("maps a transactional HTML + text email and returns the provider id with a null RFC Message-ID", async () => {
    const emails = new ScriptedResendEmails();
    const result = await new ResendEmailClient(emails).sendEmail(input());

    expect(result).toEqual({ providerMessageId: "resend-email-1", rfcMessageId: null });
    expect(emails.calls).toHaveLength(1);
    expect(emails.calls[0].payload).toEqual({
      from: "AlexAgent <review@mail.agent.alexsosa.me>",
      to: "owner@example.test",
      subject: "Asunto",
      html: "<p>Hola</p>",
      text: "Hola",
    });
    expect(emails.calls[0].options).toBeUndefined();
  });

  it("maps Reply-To only when provided", async () => {
    const emails = new ScriptedResendEmails();
    await new ResendEmailClient(emails).sendEmail(input({ replyTo: "reply+tok@mail.agent.alexsosa.me" }));
    expect(emails.calls[0].payload).toMatchObject({ replyTo: "reply+tok@mail.agent.alexsosa.me" });

    await new ResendEmailClient(emails).sendEmail(input());
    expect(emails.calls[1].payload).not.toHaveProperty("replyTo");
  });

  it("maps inline CID attachments to Resend attachments with contentId", async () => {
    const emails = new ScriptedResendEmails();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await new ResendEmailClient(emails).sendEmail(
      input({ inlineAttachments: [{ contentId: "solardesk-asset-v3", filename: "solardesk-asset-v3.png", contentType: "image/png", content: png }] })
    );
    expect((emails.calls[0].payload as { attachments?: unknown[] }).attachments).toEqual([
      { filename: "solardesk-asset-v3.png", content: png, contentType: "image/png", contentId: "solardesk-asset-v3" },
    ]);
  });

  it("omits attachments entirely when none are supplied", async () => {
    const emails = new ScriptedResendEmails();
    await new ResendEmailClient(emails).sendEmail(input({ inlineAttachments: [] }));
    expect(emails.calls[0].payload).not.toHaveProperty("attachments");
  });

  it("passes the idempotency key as a Resend request option (Idempotency-Key header)", async () => {
    const emails = new ScriptedResendEmails();
    await new ResendEmailClient(emails).sendEmail(input({ idempotencyKey: "outbox-123-v2" }));
    expect(emails.calls[0].options).toEqual({ idempotencyKey: "outbox-123-v2" });
  });

  it("rejects invalid inputs before calling Resend", async () => {
    const emails = new ScriptedResendEmails();
    const client = new ResendEmailClient(emails);
    await expect(client.sendEmail(input({ to: " " }))).rejects.toBeInstanceOf(EmailSendError);
    await expect(client.sendEmail(input({ text: "" }))).rejects.toBeInstanceOf(EmailSendError);
    await expect(client.sendEmail(input({ idempotencyKey: "x".repeat(257) }))).rejects.toBeInstanceOf(EmailSendError);
    const attachment = { filename: "a.png", contentType: "image/png", content: Buffer.from("x") };
    await expect(client.sendEmail(input({ inlineAttachments: [{ ...attachment, contentId: "bad id<>" }] }))).rejects.toBeInstanceOf(EmailSendError);
    await expect(
      client.sendEmail(input({ inlineAttachments: [{ ...attachment, contentId: "dup" }, { ...attachment, contentId: "dup" }] }))
    ).rejects.toBeInstanceOf(EmailSendError);
    expect(emails.calls).toHaveLength(0);
  });
});

describe("ResendEmailClient — failures and sanitization", () => {
  it("maps a Resend error response to EmailSendError with code and status", async () => {
    const emails = new ScriptedResendEmails(async () => ({
      data: null,
      error: { name: "validation_error", statusCode: 422, message: "Invalid `from` field." },
      headers: null,
    }));
    const err = await new ResendEmailClient(emails).sendEmail(input()).catch((e) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err.message).toBe("Resend rejected the email send request: validation_error (HTTP 422): Invalid `from` field.");
  });

  it("never lets the API key leak through a provider error message", async () => {
    const emails = new ScriptedResendEmails(async () => ({
      data: null,
      error: { name: "invalid_api_key", statusCode: 401, message: `API key ${FAKE_KEY} is invalid; also re_someOtherKey999 rejected` },
      headers: null,
    }));
    const err = await new ResendEmailClient(emails).sendEmail(input()).catch((e) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.message).not.toContain("re_someOtherKey999");
    expect(err.message).toContain("[redacted]");
  });

  it("maps an unexpected SDK throw to a sanitized EmailSendError", async () => {
    const emails = new ScriptedResendEmails(async () => {
      throw new Error(`socket hang up\nAuthorization: Bearer ${FAKE_KEY}`);
    });
    const err = await new ResendEmailClient(emails).sendEmail(input()).catch((e) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.message).not.toContain("\n");
  });

  it("treats a success response without an id as a failure", async () => {
    const emails = new ScriptedResendEmails(async () => ({ data: { id: "" }, error: null, headers: null }));
    await expect(new ResendEmailClient(emails).sendEmail(input())).rejects.toThrow("no email id");
  });

  it("truncates long provider errors to a single bounded line", () => {
    const sanitized = sanitizeEmailErrorText(`line1\nline2 ${"x".repeat(1000)}`, null);
    expect(sanitized.length).toBeLessThanOrEqual(300);
    expect(sanitized).not.toContain("\n");
  });
});

describe("outbound email configuration — fail closed", () => {
  it("refuses to send without an API key, without ever constructing the SDK or touching the network", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    // No injected API: a production-shaped client.
    const err = await new ResendEmailClient().sendEmail(input()).catch((e) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err.message).toBe("Resend API key is not configured.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports capability only when key, sender, and recipient are all configured", () => {
    expect(emailOutboundCapabilityAvailable()).toBe(true);
    vi.stubEnv("EMAIL_REVIEW_RECIPIENT", "");
    expect(emailOutboundCapabilityAvailable()).toBe(false);
  });

  it("resolves review addressing, and fails closed without leaking configured values", () => {
    expect(resolveReviewEmailAddressing()).toEqual({ from: "AlexAgent <review@mail.agent.alexsosa.me>", to: "owner@example.test" });
    vi.stubEnv("EMAIL_FROM", "");
    let caught: unknown;
    try {
      resolveReviewEmailAddressing();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmailSendError);
    expect((caught as Error).message).not.toContain("owner@example.test");
  });

  it("constructing the client with no configuration does not throw (import/construction is config-free)", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM", "");
    vi.stubEnv("EMAIL_REVIEW_RECIPIENT", "");
    expect(() => new ResendEmailClient()).not.toThrow();
    expect(emailOutboundCapabilityAvailable()).toBe(false);
  });
});
