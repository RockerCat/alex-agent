import { env } from "@/lib/env";

// AlexAgent v0.2 — Facebook manual publishing (checkpoint 1). Thin
// server-side seam over the Meta Graph API, mirroring the AiClient /
// ImageGenerationClient injection pattern already used in this codebase:
// production code uses MetaGraphFacebookClient; tests inject a scripted
// fake so success/failure paths are testable without ever calling the
// real (validated-by-hand, see the Graph API Explorer smoke test)
// Meta endpoint.
//
// Manually validated on 2026-09-16: POST /{page-id}/feed with a real
// Page Access Token produced a real Facebook post, later deleted via
// the Graph API. This client uses POST /{page-id}/photos instead,
// which is the correct Graph API endpoint for a Page image post (a
// photo upload that also becomes a feed post) — /feed does not accept
// a binary image attachment directly.

const GRAPH_API_VERSION = "v26.0";

/**
 * Provider-outcome classification for the ONE mutating call (POST
 * /{page}/photos). `retrySafe` is true only when Meta provably did NOT
 * create a post: the request was never sent, or Meta returned an
 * authoritative rejection (a 4xx response carrying a Graph error object).
 * Everything else — transport failure after the request may have been
 * sent, a non-JSON or 5xx response, a success-like response without an id
 * — is UNCERTAIN (retrySafe false, the default): the post may exist, so it
 * must never be retried automatically.
 */
export class FacebookPublishError extends Error {
  readonly retrySafe: boolean;
  constructor(message: string, options: { retrySafe?: boolean } = {}) {
    super(message);
    this.retrySafe = options.retrySafe ?? false;
  }
}

/** A 4xx response with a Graph API error object: Meta rejected the request, so nothing was created. */
function isAuthoritativeRejection(status: number, json: unknown): boolean {
  const errObj = (json as { error?: { message?: unknown; code?: unknown } } | null)?.error;
  return status >= 400 && status < 500 && Boolean(errObj) && (typeof errObj!.message === "string" || typeof errObj!.code === "number");
}

export interface FacebookImagePostInput {
  message: string;
  imageBuffer: Buffer;
}

export interface FacebookImagePostResult {
  /** The actual Facebook Page post ID (falls back to the photo id if Meta ever omits post_id). */
  postId: string;
}

export interface FacebookPageClient {
  publishImagePost(input: FacebookImagePostInput): Promise<FacebookImagePostResult>;
}

/** True only when both the Page access token and Page ID are explicitly configured. */
export function facebookPublishingCapabilityAvailable(): boolean {
  return Boolean(env.metaFacebookPageAccessToken() && env.metaFacebookPageId());
}

export class MetaGraphFacebookClient implements FacebookPageClient {
  async publishImagePost(input: FacebookImagePostInput): Promise<FacebookImagePostResult> {
    const pageId = env.metaFacebookPageId();
    const accessToken = env.metaFacebookPageAccessToken();
    if (!pageId || !accessToken) {
      throw new FacebookPublishError("Meta Facebook configuration is missing.", { retrySafe: true }); // nothing was sent
    }

    const form = new FormData();
    form.append("caption", input.message);
    form.append("access_token", accessToken);
    form.append("source", new Blob([new Uint8Array(input.imageBuffer)], { type: "image/png" }), "asset.png");

    let response: Response;
    try {
      response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${pageId}/photos`, {
        method: "POST",
        body: form,
      });
    } catch (err) {
      // Never interpolate the access token — only the (non-secret) failure shape.
      throw new FacebookPublishError(`Network error calling the Meta Graph API: ${err instanceof Error ? err.message : "unknown error"}`); // uncertain: may have been sent
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new FacebookPublishError(`Meta Graph API returned a non-JSON response (HTTP ${response.status}).`); // uncertain
    }

    if (!response.ok) {
      const errObj = (json as { error?: { message?: string } } | null)?.error;
      throw new FacebookPublishError(`Meta Graph API rejected the publish request: ${errObj?.message ?? `HTTP ${response.status}`}`, {
        retrySafe: isAuthoritativeRejection(response.status, json), // 5xx / error-less responses stay uncertain
      });
    }

    const body = json as { post_id?: string; id?: string } | null;
    const postId = body?.post_id ?? body?.id;
    if (!postId) {
      throw new FacebookPublishError("Meta Graph API returned success but no post id."); // uncertain: the post may exist
    }

    return { postId };
  }
}
