import { env } from "@/lib/env";

// AlexAgent — Instagram publishing readiness checkpoint. Thin
// server-side seam over the Meta Graph API for Instagram's two-step
// single-image publishing flow, mirroring the FacebookPageClient /
// MetaGraphFacebookClient injection pattern in
// lib/agent/facebookClient.ts: production code uses
// MetaGraphInstagramClient; tests inject a scripted fake so
// success/failure paths are testable without ever calling the real
// Meta endpoint.
//
// This client does not create the signed image URL Meta needs — that
// remains the responsibility of the later publication service (see
// SupabaseAssetStorage.createSignedUrl). It also does not implement
// publishAssetToInstagram, retries, or carousel/Stories/Reels support —
// single-image image_post only, for this checkpoint. Bounded
// container-status polling between create and publish lives in
// lib/agent/publish.ts, driving this client's getMediaContainerStatus().
//
// Instagram Login publishing uses the Instagram Graph API host
// (graph.instagram.com), not the Facebook Graph API host
// (graph.facebook.com) used by lib/agent/facebookClient.ts — these are
// different API families with independent version numbering. v24.0 is
// the version confirmed working against this account's Instagram
// Login token via GET /me (see incident diagnosis) — deliberately not
// copied from the Facebook client's v26.0.
const GRAPH_API_VERSION = "v24.0";
const GRAPH_API_HOST = "https://graph.instagram.com";

export class InstagramPublishError extends Error {}

export interface InstagramCreateMediaInput {
  /** Temporary HTTPS URL Meta can fetch the image from (see SupabaseAssetStorage.createSignedUrl). */
  imageUrl: string;
  caption: string;
}

export interface InstagramCreateMediaResult {
  creationId: string;
}

export interface InstagramPublishMediaResult {
  mediaId: string;
}

// Meta's documented Content Publishing API container lifecycle for a
// single-image container: IN_PROGRESS while Meta fetches/validates the
// image, FINISHED once it's publishable, ERROR/EXPIRED are terminal
// failures, and PUBLISHED means some earlier call already published it
// (never re-publish that container).
export const INSTAGRAM_CONTAINER_STATUS_CODES = ["IN_PROGRESS", "FINISHED", "ERROR", "EXPIRED", "PUBLISHED"] as const;
export type InstagramContainerStatusCode = (typeof INSTAGRAM_CONTAINER_STATUS_CODES)[number];

export interface InstagramContainerStatusResult {
  statusCode: InstagramContainerStatusCode;
}

export interface InstagramGraphClient {
  createMediaContainer(input: InstagramCreateMediaInput): Promise<InstagramCreateMediaResult>;
  getMediaContainerStatus(containerId: string): Promise<InstagramContainerStatusResult>;
  publishMediaContainer(creationId: string): Promise<InstagramPublishMediaResult>;
}

/** True only when both the Instagram access token and account id are explicitly configured. */
export function instagramPublishingCapabilityAvailable(): boolean {
  return Boolean(env.metaInstagramAccessToken() && env.metaInstagramAccountId());
}

export class MetaGraphInstagramClient implements InstagramGraphClient {
  /**
   * Shared POST + response-validation shape for both Instagram Graph
   * calls below (create container, publish container) — not a
   * cross-channel abstraction; the Facebook client's binary /photos
   * upload is deliberately not folded in here.
   */
  private async post(path: string, params: URLSearchParams, resultNoun: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${GRAPH_API_HOST}/${GRAPH_API_VERSION}/${path}`, {
        method: "POST",
        body: params,
      });
    } catch (err) {
      // Never interpolate the access token — only the (non-secret) failure shape.
      throw new InstagramPublishError(`Network error calling the Meta Graph API: ${err instanceof Error ? err.message : "unknown error"}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new InstagramPublishError(`Meta Graph API returned a non-JSON response (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      const errObj = (json as { error?: { message?: string } } | null)?.error;
      throw new InstagramPublishError(`Meta Graph API rejected the ${resultNoun} request: ${errObj?.message ?? `HTTP ${response.status}`}`);
    }

    const id = (json as { id?: string } | null)?.id;
    if (!id) {
      throw new InstagramPublishError(`Meta Graph API returned success but no ${resultNoun} id.`);
    }
    return id;
  }

  /**
   * GET counterpart to post() above, for the one read this client makes
   * (container status) — same response validation shape, but a GET
   * carries no body, so access_token travels as a query param instead
   * of a form field (there is no other way to authenticate a GET).
   */
  private async get(path: string, searchParams: URLSearchParams, resultNoun: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${GRAPH_API_HOST}/${GRAPH_API_VERSION}/${path}?${searchParams.toString()}`);
    } catch (err) {
      throw new InstagramPublishError(`Network error calling the Meta Graph API: ${err instanceof Error ? err.message : "unknown error"}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new InstagramPublishError(`Meta Graph API returned a non-JSON response (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      const errObj = (json as { error?: { message?: string } } | null)?.error;
      throw new InstagramPublishError(`Meta Graph API rejected the ${resultNoun} request: ${errObj?.message ?? `HTTP ${response.status}`}`);
    }

    return json;
  }

  async getMediaContainerStatus(containerId: string): Promise<InstagramContainerStatusResult> {
    const accessToken = env.metaInstagramAccessToken();
    if (!accessToken) {
      throw new InstagramPublishError("Meta Instagram configuration is missing.");
    }

    const params = new URLSearchParams({ fields: "status_code", access_token: accessToken });
    const json = await this.get(containerId, params, "media container status");

    const statusCode = (json as { status_code?: string } | null)?.status_code;
    if (!statusCode || !(INSTAGRAM_CONTAINER_STATUS_CODES as readonly string[]).includes(statusCode)) {
      throw new InstagramPublishError(`Meta Graph API returned an unrecognized media container status: ${statusCode ?? "missing"}.`);
    }

    return { statusCode: statusCode as InstagramContainerStatusCode };
  }

  async createMediaContainer(input: InstagramCreateMediaInput): Promise<InstagramCreateMediaResult> {
    const accountId = env.metaInstagramAccountId();
    const accessToken = env.metaInstagramAccessToken();
    if (!accountId || !accessToken) {
      throw new InstagramPublishError("Meta Instagram configuration is missing.");
    }

    const params = new URLSearchParams({
      image_url: input.imageUrl,
      caption: input.caption,
      access_token: accessToken,
    });

    const creationId = await this.post(`${accountId}/media`, params, "media container");
    return { creationId };
  }

  async publishMediaContainer(creationId: string): Promise<InstagramPublishMediaResult> {
    const accountId = env.metaInstagramAccountId();
    const accessToken = env.metaInstagramAccessToken();
    if (!accountId || !accessToken) {
      throw new InstagramPublishError("Meta Instagram configuration is missing.");
    }

    const params = new URLSearchParams({
      creation_id: creationId,
      access_token: accessToken,
    });

    const mediaId = await this.post(`${accountId}/media_publish`, params, "media");
    return { mediaId };
  }
}
