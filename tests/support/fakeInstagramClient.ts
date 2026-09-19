import type {
  InstagramCreateMediaInput,
  InstagramCreateMediaResult,
  InstagramPublishMediaResult,
  InstagramContainerStatusResult,
  InstagramContainerStatusCode,
  InstagramGraphClient,
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

  constructor(
    options: {
      creationId?: string;
      mediaId?: string;
      failCreateWith?: Error;
      failPublishWith?: Error;
      statusSequence?: InstagramContainerStatusCode[];
      failStatusWith?: Error;
    } = {}
  ) {
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

  async getMediaContainerStatus(containerId: string): Promise<InstagramContainerStatusResult> {
    this.statusCalls.push(containerId);
    if (this.nextStatusError) {
      const err = this.nextStatusError;
      this.nextStatusError = null;
      throw err;
    }
    const statusCode = this.statusSequence.length > 1 ? this.statusSequence.shift()! : this.statusSequence[0];
    return { statusCode };
  }

  async publishMediaContainer(creationId: string): Promise<InstagramPublishMediaResult> {
    this.publishCalls.push(creationId);
    if (this.nextPublishError) {
      const err = this.nextPublishError;
      this.nextPublishError = null;
      throw err;
    }
    return this.nextPublishResult;
  }
}

export function instagramRejection(message: string) {
  return new InstagramPublishError(message);
}
