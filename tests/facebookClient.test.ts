import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MetaGraphFacebookClient, FacebookPublishError } from "@/lib/agent/facebookClient";

// AlexAgent v0.2 — Facebook manual publishing. Direct tests of the real
// production client's request construction (never a real network call
// to Meta): a local mocked global.fetch captures exactly what
// MetaGraphFacebookClient sends, so these tests validate the actual
// multipart payload Meta receives — not just success through the
// ScriptedFacebookClient fake used elsewhere (tests/publish.test.ts).
//
// Context: a real publish attempt from AlexAgent reached Meta but was
// rejected with an OAuthException, even though the exact same Page
// Access Token succeeded via a manual curl POST to the same /photos
// endpoint. Investigation (see the accompanying report) confirmed the
// multipart construction itself (FormData + Blob, boundary, per-part
// Content-Disposition/Content-Type, byte-exact binary payload) is
// correct, and that every stored asset is a genuine re-encoded PNG
// (lib/agent/assetRenderer.ts always finishes with sharp(...).png()).
// The one concrete, verifiable gap was environment-variable hygiene:
// nothing trimmed the token/page id read from process.env, so
// incidental whitespace picked up from a hosting-platform env panel or
// a `.env.local` line (a well-documented, common real-world cause of
// "works via curl, fails from the app" token bugs) would silently
// corrupt the token sent to Meta. lib/env.ts now trims both values —
// the "6. token hygiene" tests below are the regression coverage for
// that exact fix.

const REAL_TOKEN = "EAA-fake-token-for-tests-only";

function captureFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    install() {
      global.fetch = (async (url: string, init?: RequestInit) => {
        calls.push({ url, init: init! });
        return new Response(JSON.stringify({ id: "photo-1", post_id: "page_photo-1" }), { status: 200 });
      }) as typeof fetch;
    },
  };
}

describe("MetaGraphFacebookClient", () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN = REAL_TOKEN;
    process.env.META_FACEBOOK_PAGE_ID = "1225292840656707";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
  });

  it("1. posts to the correct v26.0 /{page-id}/photos URL with POST", async () => {
    const capture = captureFetch();
    capture.install();
    const client = new MetaGraphFacebookClient();

    await client.publishImagePost({ message: "Approved caption", imageBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });

    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0].url).toBe("https://graph.facebook.com/v26.0/1225292840656707/photos");
    expect(capture.calls[0].init.method).toBe("POST");
  });

  it("2. sends the approved caption, the real access token, and the image as a named binary file", async () => {
    const capture = captureFetch();
    capture.install();
    const client = new MetaGraphFacebookClient();
    const imageBuffer = Buffer.from("fake-png-bytes-for-transport-test");

    await client.publishImagePost({ message: "Cotiza proyectos solares hoy.", imageBuffer });

    const form = capture.calls[0].init.body as FormData;
    expect(form.get("caption")).toBe("Cotiza proyectos solares hoy.");
    expect(form.get("access_token")).toBe(REAL_TOKEN);

    const source = form.get("source") as File;
    expect(source).toBeInstanceOf(Blob);
    expect(source.type).toBe("image/png");
    expect(source.name).toBe("asset.png");
    expect(source.size).toBe(imageBuffer.length);
    const roundTripped = Buffer.from(await source.arrayBuffer());
    expect(roundTripped.equals(imageBuffer)).toBe(true);
  });

  it("3. returns Meta's post_id when present", async () => {
    const capture = captureFetch();
    capture.install();
    const client = new MetaGraphFacebookClient();

    const result = await client.publishImagePost({ message: "m", imageBuffer: Buffer.from("x") });

    expect(result.postId).toBe("page_photo-1");
  });

  it("4. falls back to id only when post_id is absent", async () => {
    global.fetch = (async () => new Response(JSON.stringify({ id: "photo-only-1" }), { status: 200 })) as typeof fetch;
    const client = new MetaGraphFacebookClient();

    const result = await client.publishImagePost({ message: "m", imageBuffer: Buffer.from("x") });

    expect(result.postId).toBe("photo-only-1");
  });

  it("5. surfaces Meta's rejection reason without ever leaking the access token", async () => {
    let sentToken: string | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      sentToken = (init!.body as FormData).get("access_token") as string;
      return new Response(JSON.stringify({ error: { message: "Invalid OAuth access token." } }), { status: 400 });
    }) as typeof fetch;
    const client = new MetaGraphFacebookClient();

    let thrown: unknown;
    try {
      await client.publishImagePost({ message: "m", imageBuffer: Buffer.from("x") });
    } catch (err) {
      thrown = err;
    }

    // Meta genuinely receives the real token (that's correct/required)...
    expect(sentToken).toBe(REAL_TOKEN);
    // ...but the error that reaches logs/UI must never contain it.
    expect(thrown).toBeInstanceOf(FacebookPublishError);
    expect(String(thrown)).toContain("Invalid OAuth access token.");
    expect(String(thrown)).not.toContain(REAL_TOKEN);
  });

  it("6. token hygiene — trims incidental whitespace/newlines from env before building the request", async () => {
    // Regression test for the actual root-cause fix: a Page Access
    // Token picked up from a hosting-platform env panel or an editor
    // that appended a trailing newline/space must not silently differ
    // from the token that works via curl.
    process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN = `  ${REAL_TOKEN}\n`;
    process.env.META_FACEBOOK_PAGE_ID = "1225292840656707\n";
    const capture = captureFetch();
    capture.install();
    const client = new MetaGraphFacebookClient();

    await client.publishImagePost({ message: "m", imageBuffer: Buffer.from("x") });

    expect(capture.calls[0].url).toBe("https://graph.facebook.com/v26.0/1225292840656707/photos");
    const form = capture.calls[0].init.body as FormData;
    expect(form.get("access_token")).toBe(REAL_TOKEN);
  });

  it("7. missing configuration fails before ever calling fetch", async () => {
    delete process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN;
    const capture = captureFetch();
    capture.install();
    const client = new MetaGraphFacebookClient();

    await expect(client.publishImagePost({ message: "m", imageBuffer: Buffer.from("x") })).rejects.toThrow(FacebookPublishError);
    expect(capture.calls).toHaveLength(0);
  });
});
