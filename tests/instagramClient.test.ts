import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MetaGraphInstagramClient, InstagramPublishError, instagramPublishingCapabilityAvailable } from "@/lib/agent/instagramClient";

// AlexAgent — Instagram publishing readiness checkpoint. Direct tests of
// the real production client's request construction (never a real
// network call to Meta): a local mocked global.fetch captures exactly
// what MetaGraphInstagramClient sends, following the same pattern as
// tests/facebookClient.test.ts for the production Facebook client.

const REAL_TOKEN = "EAA-fake-ig-token-for-tests-only";
const ACCOUNT_ID = "17841417848021831";

function captureFetch(responseBody: unknown = { id: "container-1" }, status = 200) {
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

describe("MetaGraphInstagramClient", () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.META_INSTAGRAM_ACCESS_TOKEN = REAL_TOKEN;
    process.env.META_INSTAGRAM_ACCOUNT_ID = ACCOUNT_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
  });

  describe("createMediaContainer", () => {
    it("1. posts to the correct Instagram Graph host v24.0 /{ig-account-id}/media URL with POST", async () => {
      const capture = captureFetch();
      capture.install();
      const client = new MetaGraphInstagramClient();

      await client.createMediaContainer({ imageUrl: "https://example.supabase.co/signed/asset.png", caption: "Approved caption" });

      expect(capture.calls).toHaveLength(1);
      expect(capture.calls[0].url).toBe(`https://graph.instagram.com/v24.0/${ACCOUNT_ID}/media`);
      expect(capture.calls[0].init.method).toBe("POST");
    });

    it("never targets the Facebook Graph host", async () => {
      const capture = captureFetch();
      capture.install();
      const client = new MetaGraphInstagramClient();

      await client.createMediaContainer({ imageUrl: "https://example.supabase.co/signed/asset.png", caption: "c" });

      expect(capture.calls[0].url).not.toContain("graph.facebook.com");
    });

    it("2. sends the image url, caption, and access token as request params", async () => {
      const capture = captureFetch();
      capture.install();
      const client = new MetaGraphInstagramClient();

      await client.createMediaContainer({ imageUrl: "https://example.supabase.co/signed/asset.png", caption: "Cotiza proyectos solares hoy." });

      const params = capture.calls[0].init.body as URLSearchParams;
      expect(params.get("image_url")).toBe("https://example.supabase.co/signed/asset.png");
      expect(params.get("caption")).toBe("Cotiza proyectos solares hoy.");
      expect(params.get("access_token")).toBe(REAL_TOKEN);
    });

    it("3. never puts the access token in the request URL", async () => {
      const capture = captureFetch();
      capture.install();
      const client = new MetaGraphInstagramClient();

      await client.createMediaContainer({ imageUrl: "https://example.supabase.co/signed/asset.png", caption: "c" });

      expect(capture.calls[0].url).not.toContain(REAL_TOKEN);
    });

    it("4. returns Meta's creation id on success", async () => {
      const capture = captureFetch({ id: "container-abc-123" });
      capture.install();
      const client = new MetaGraphInstagramClient();

      const result = await client.createMediaContainer({ imageUrl: "https://example.supabase.co/signed/asset.png", caption: "c" });

      expect(result.creationId).toBe("container-abc-123");
    });

    it("5. surfaces Meta's rejection reason without ever leaking the access token", async () => {
      let sentToken: string | null = null;
      global.fetch = (async (_url: string, init?: RequestInit) => {
        sentToken = (init!.body as URLSearchParams).get("access_token");
        return new Response(JSON.stringify({ error: { message: "Invalid OAuth access token." } }), { status: 400 });
      }) as typeof fetch;
      const client = new MetaGraphInstagramClient();

      let thrown: unknown;
      try {
        await client.createMediaContainer({ imageUrl: "https://example.supabase.co/signed/asset.png", caption: "c" });
      } catch (err) {
        thrown = err;
      }

      // Meta genuinely receives the real token (that's correct/required)...
      expect(sentToken).toBe(REAL_TOKEN);
      // ...but the error that reaches logs/UI must never contain it.
      expect(thrown).toBeInstanceOf(InstagramPublishError);
      expect(String(thrown)).toContain("Invalid OAuth access token.");
      expect(String(thrown)).not.toContain(REAL_TOKEN);
    });

    it("6. a malformed success response without an id fails safely", async () => {
      global.fetch = (async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })) as typeof fetch;
      const client = new MetaGraphInstagramClient();

      await expect(client.createMediaContainer({ imageUrl: "https://example.supabase.co/signed/asset.png", caption: "c" })).rejects.toThrow(InstagramPublishError);
    });

    it("7. a network failure is surfaced as an InstagramPublishError, never an uncaught rejection shape", async () => {
      global.fetch = (async () => {
        throw new Error("fetch failed: getaddrinfo ENOTFOUND");
      }) as typeof fetch;
      const client = new MetaGraphInstagramClient();

      await expect(client.createMediaContainer({ imageUrl: "https://example.supabase.co/signed/asset.png", caption: "c" })).rejects.toThrow(InstagramPublishError);
    });

    it("8. missing configuration fails before ever calling fetch", async () => {
      delete process.env.META_INSTAGRAM_ACCESS_TOKEN;
      const capture = captureFetch();
      capture.install();
      const client = new MetaGraphInstagramClient();

      await expect(client.createMediaContainer({ imageUrl: "https://example.supabase.co/signed/asset.png", caption: "c" })).rejects.toThrow(InstagramPublishError);
      expect(capture.calls).toHaveLength(0);
    });
  });

  describe("publishMediaContainer", () => {
    it("9. posts to the correct Instagram Graph host v24.0 /{ig-account-id}/media_publish URL with the creation id", async () => {
      const capture = captureFetch({ id: "media-1" });
      capture.install();
      const client = new MetaGraphInstagramClient();

      await client.publishMediaContainer("container-abc-123");

      expect(capture.calls).toHaveLength(1);
      expect(capture.calls[0].url).toBe(`https://graph.instagram.com/v24.0/${ACCOUNT_ID}/media_publish`);
      expect(capture.calls[0].init.method).toBe("POST");
      const params = capture.calls[0].init.body as URLSearchParams;
      expect(params.get("creation_id")).toBe("container-abc-123");
      expect(params.get("access_token")).toBe(REAL_TOKEN);
    });

    it("never targets the Facebook Graph host", async () => {
      const capture = captureFetch({ id: "media-1" });
      capture.install();
      const client = new MetaGraphInstagramClient();

      await client.publishMediaContainer("container-abc-123");

      expect(capture.calls[0].url).not.toContain("graph.facebook.com");
    });

    it("10. returns Meta's published media id on success", async () => {
      const capture = captureFetch({ id: "published-media-999" });
      capture.install();
      const client = new MetaGraphInstagramClient();

      const result = await client.publishMediaContainer("container-abc-123");

      expect(result.mediaId).toBe("published-media-999");
    });

    it("11. a Graph API rejection is surfaced safely without leaking the token", async () => {
      let sentToken: string | null = null;
      global.fetch = (async (_url: string, init?: RequestInit) => {
        sentToken = (init!.body as URLSearchParams).get("access_token");
        return new Response(JSON.stringify({ error: { message: "Media ID is not available." } }), { status: 400 });
      }) as typeof fetch;
      const client = new MetaGraphInstagramClient();

      let thrown: unknown;
      try {
        await client.publishMediaContainer("stale-container");
      } catch (err) {
        thrown = err;
      }

      expect(sentToken).toBe(REAL_TOKEN);
      expect(thrown).toBeInstanceOf(InstagramPublishError);
      expect(String(thrown)).toContain("Media ID is not available.");
      expect(String(thrown)).not.toContain(REAL_TOKEN);
    });

    it("12. a malformed success response without an id fails safely", async () => {
      global.fetch = (async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })) as typeof fetch;
      const client = new MetaGraphInstagramClient();

      await expect(client.publishMediaContainer("container-abc-123")).rejects.toThrow(InstagramPublishError);
    });

    it("13. missing configuration fails before ever calling fetch", async () => {
      delete process.env.META_INSTAGRAM_ACCOUNT_ID;
      const capture = captureFetch();
      capture.install();
      const client = new MetaGraphInstagramClient();

      await expect(client.publishMediaContainer("container-abc-123")).rejects.toThrow(InstagramPublishError);
      expect(capture.calls).toHaveLength(0);
    });
  });

  describe("getMediaContainerStatus", () => {
    it("targets graph.instagram.com/v24.0/{container-id}?fields=status_code with the access token as a query param", async () => {
      const capture = captureFetch({ status_code: "FINISHED" });
      capture.install();
      const client = new MetaGraphInstagramClient();

      await client.getMediaContainerStatus("container-abc-123");

      expect(capture.calls).toHaveLength(1);
      const url = new URL(capture.calls[0].url);
      expect(`${url.origin}${url.pathname}`).toBe("https://graph.instagram.com/v24.0/container-abc-123");
      expect(url.searchParams.get("fields")).toBe("status_code");
      // A GET has no body, so the token can only travel as a query
      // param here — unlike the POST calls above, which send it in the
      // form body. This is required, not a leak: it's never logged and
      // never surfaces in a thrown error (see the rejection test below).
      expect(url.searchParams.get("access_token")).toBe(REAL_TOKEN);
      expect(capture.calls[0].init?.method ?? "GET").not.toBe("POST");
    });

    it("parses a FINISHED status", async () => {
      const capture = captureFetch({ status_code: "FINISHED" });
      capture.install();
      const client = new MetaGraphInstagramClient();

      const result = await client.getMediaContainerStatus("container-1");

      expect(result.statusCode).toBe("FINISHED");
    });

    it("parses an IN_PROGRESS status", async () => {
      const capture = captureFetch({ status_code: "IN_PROGRESS" });
      capture.install();
      const client = new MetaGraphInstagramClient();

      const result = await client.getMediaContainerStatus("container-1");

      expect(result.statusCode).toBe("IN_PROGRESS");
    });

    it.each(["ERROR", "EXPIRED", "PUBLISHED"])("parses the terminal status %s", async (statusCode) => {
      const capture = captureFetch({ status_code: statusCode });
      capture.install();
      const client = new MetaGraphInstagramClient();

      const result = await client.getMediaContainerStatus("container-1");

      expect(result.statusCode).toBe(statusCode);
    });

    it("fails safely on a missing status_code", async () => {
      const capture = captureFetch({});
      capture.install();
      const client = new MetaGraphInstagramClient();

      await expect(client.getMediaContainerStatus("container-1")).rejects.toThrow(InstagramPublishError);
    });

    it("fails safely on an unrecognized status_code", async () => {
      const capture = captureFetch({ status_code: "SOMETHING_NEW_META_ADDED" });
      capture.install();
      const client = new MetaGraphInstagramClient();

      await expect(client.getMediaContainerStatus("container-1")).rejects.toThrow(InstagramPublishError);
    });

    it("surfaces a Graph API rejection without ever leaking the access token", async () => {
      global.fetch = (async (url: string) => {
        expect(url).toContain(REAL_TOKEN);
        return new Response(JSON.stringify({ error: { message: "Unsupported get request." } }), { status: 400 });
      }) as typeof fetch;
      const client = new MetaGraphInstagramClient();

      let thrown: unknown;
      try {
        await client.getMediaContainerStatus("container-1");
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(InstagramPublishError);
      expect(String(thrown)).toContain("Unsupported get request.");
      expect(String(thrown)).not.toContain(REAL_TOKEN);
    });

    it("a non-JSON response fails safely", async () => {
      global.fetch = (async () => new Response("not json", { status: 200 })) as typeof fetch;
      const client = new MetaGraphInstagramClient();

      await expect(client.getMediaContainerStatus("container-1")).rejects.toThrow(InstagramPublishError);
    });

    it("a network failure is surfaced as an InstagramPublishError", async () => {
      global.fetch = (async () => {
        throw new Error("fetch failed: getaddrinfo ENOTFOUND");
      }) as typeof fetch;
      const client = new MetaGraphInstagramClient();

      await expect(client.getMediaContainerStatus("container-1")).rejects.toThrow(InstagramPublishError);
    });

    it("missing configuration fails before ever calling fetch", async () => {
      delete process.env.META_INSTAGRAM_ACCESS_TOKEN;
      const capture = captureFetch();
      capture.install();
      const client = new MetaGraphInstagramClient();

      await expect(client.getMediaContainerStatus("container-1")).rejects.toThrow(InstagramPublishError);
      expect(capture.calls).toHaveLength(0);
    });
  });

  describe("instagramPublishingCapabilityAvailable", () => {
    it("14. true only when both the access token and account id are configured", () => {
      expect(instagramPublishingCapabilityAvailable()).toBe(true);
    });

    it("15. false when the access token is missing", () => {
      delete process.env.META_INSTAGRAM_ACCESS_TOKEN;
      expect(instagramPublishingCapabilityAvailable()).toBe(false);
    });

    it("16. false when the account id is missing", () => {
      delete process.env.META_INSTAGRAM_ACCOUNT_ID;
      expect(instagramPublishingCapabilityAvailable()).toBe(false);
    });
  });
});
