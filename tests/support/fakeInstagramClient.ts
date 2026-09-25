import type {
  InstagramCreateMediaInput,
  InstagramCreateMediaResult,
  InstagramPublishMediaResult,
  InstagramContainerStatusResult,
  InstagramContainerStatusCode,
  InstagramGraphClient,
  InstagramCarouselItemInput,
  InstagramCarouselContainerInput,
} from "@/lib/agent/instagramClient";
import { InstagramPublishError } from "@/lib/agent/instagramClient";

/**
 * Scripted stand-in for the real Meta Graph API Instagram client
 * (mirrors ScriptedFacebookClient / ScriptedAiClient / ScriptedImageGenerationClient),
 * so lib/agent/publish.ts's Instagram success/failure/idempotency
 * behavior is testable without ever calling the real Meta endpoint.
 * Create and publish results/errors are scripted independently so
 * tests can exercise each of Instagram's two Graph calls in isolation.
 */
export class ScriptedInstagramClient implements InstagramGraphClient {
  createCalls: InstagramCreateMediaInput[] = [];
  publishCalls: string[] = [];
  statusCalls: string[] = [];
  private nextCreateResult: InstagramCreateMediaResult;
  private nextCreateError: Error | null;
  private nextPublishResult: InstagramPublishMediaResult;
  private nextPublishError: Error | null;
  // Consumed one call at a time (shifted) while more than one entry
  // remains, then the final entry repeats forever — so a sequence
  // shorter than the poller's max attempts naturally exercises the
  // poller's own timeout instead of throwing on array underflow.
  private statusSequence: InstagramContainerStatusCode[];
  private nextStatusError: Error | null;

  // Carousel calls (Instagram carousel v1). Every create/publish call is
  // also appended to `mutatingCalls`, in order, so tests can assert the
  // exact item → parent → publish sequence.
  carouselItemCalls: InstagramCarouselItemInput[] = [];
  carouselContainerCalls: InstagramCarouselContainerInput[] = [];
  mutatingCalls: string[] = [];
  private failCarouselItemAt: { index: number; error: Error } | null;
  private failCarouselContainerWith: Error | null;
  /** Per-container status sequences (consumed like statusSequence); containers not listed use statusSequence. */
  private statusByContainer: Record<string, InstagramContainerStatusCode[]>;

  constructor(
    options: {
      creationId?: string;
      mediaId?: string;
      failCreateWith?: Error;
      failPublishWith?: Error;
      statusSequence?: InstagramContainerStatusCode[];
      failStatusWith?: Error;
      /** 0-based index of the carousel item create call to fail (once). */
      failCarouselItemAt?: { index: number; error: Error };
      failCarouselContainerWith?: Error;
      statusByContainer?: Record<string, InstagramContainerStatusCode[]>;
    } = {}
  ) {
    this.failCarouselItemAt = options.failCarouselItemAt ?? null;
    this.failCarouselContainerWith = options.failCarouselContainerWith ?? null;
    this.statusByContainer = { ...(options.statusByContainer ?? {}) };
    this.nextCreateResult = { creationId: options.creationId ?? "ig-container-1" };
    this.nextCreateError = options.failCreateWith ?? null;
    this.nextPublishResult = { mediaId: options.mediaId ?? "ig-media-1" };
    this.nextPublishError = options.failPublishWith ?? null;
    this.statusSequence = options.statusSequence ?? ["FINISHED"];
    this.nextStatusError = options.failStatusWith ?? null;
  }

  async createMediaContainer(input: InstagramCreateMediaInput): Promise<InstagramCreateMediaResult> {
    this.createCalls.push(input);
    if (this.nextCreateError) {
      const err = this.nextCreateError;
      this.nextCreateError = null;
      throw err;
    }
    return this.nextCreateResult;
  }

  async createCarouselItemContainer(input: InstagramCarouselItemInput): Promise<InstagramCreateMediaResult> {
    const index = this.carouselItemCalls.length;
    this.carouselItemCalls.push(input);
    this.mutatingCalls.push(`item:${index + 1}`);
    if (this.failCarouselItemAt && this.failCarouselItemAt.index === index) {
      const err = this.failCarouselItemAt.error;
      this.failCarouselItemAt = null;
      throw err;
    }
    return { creationId: `ig-item-${this.carouselItemCalls.length}` };
  }

  async createCarouselContainer(input: InstagramCarouselContainerInput): Promise<InstagramCreateMediaResult> {
    this.carouselContainerCalls.push(input);
    this.mutatingCalls.push("carousel");
    if (this.failCarouselContainerWith) {
      const err = this.failCarouselContainerWith;
      this.failCarouselContainerWith = null;
      throw err;
    }
    return { creationId: `ig-carousel-${this.carouselContainerCalls.length}` };
  }

  async getMediaContainerStatus(containerId: string): Promise<InstagramContainerStatusResult> {
    this.statusCalls.push(containerId);
    if (this.nextStatusError) {
      const err = this.nextStatusError;
      this.nextStatusError = null;
      throw err;
    }
    const perContainer = this.statusByContainer[containerId];
    if (perContainer) return { statusCode: perContainer.length > 1 ? perContainer.shift()! : perContainer[0] };
    const statusCode = this.statusSequence.length > 1 ? this.statusSequence.shift()! : this.statusSequence[0];
    return { statusCode };
  }

  async publishMediaContainer(creationId: string): Promise<InstagramPublishMediaResult> {
    this.publishCalls.push(creationId);
    this.mutatingCalls.push(`publish:${creationId}`);
    if (this.nextPublishError) {
      const err = this.nextPublishError;
      this.nextPublishError = null;
      throw err;
    }
    return this.nextPublishResult;
  }
}

/** An authoritative Meta rejection (4xx + Graph error): nothing was published — retry-safe. */
export function instagramRejection(message: string) {
  return new InstagramPublishError(message, { retrySafe: true });
}

/** An uncertain outcome (network failure after sending, non-JSON/5xx, success without id): the post may exist. */
export function instagramUncertainFailure(message = "Network error calling the Meta Graph API: socket hang up") {
  return new InstagramPublishError(message);
}
