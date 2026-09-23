import type { FacebookImagePostInput, FacebookImagePostResult, FacebookPageClient } from "@/lib/agent/facebookClient";
import { FacebookPublishError } from "@/lib/agent/facebookClient";

/**
 * Scripted stand-in for the real Meta Graph API client (mirrors
 * ScriptedAiClient / ScriptedImageGenerationClient), so
 * lib/agent/publish.ts's success/failure/idempotency behavior is
 * testable without ever calling the real Meta endpoint.
 */
export class ScriptedFacebookClient implements FacebookPageClient {
  calls: FacebookImagePostInput[] = [];
  private nextResult: FacebookImagePostResult | null;
  private nextError: Error | null;

  constructor(options: { postId?: string; failWith?: Error } = {}) {
    this.nextResult = options.postId ? { postId: options.postId } : { postId: "fb-post-1" };
    this.nextError = options.failWith ?? null;
  }

  failNextCallWith(err: Error) {
    this.nextError = err;
  }

  async publishImagePost(input: FacebookImagePostInput): Promise<FacebookImagePostResult> {
    this.calls.push(input);
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    return this.nextResult ?? { postId: "fb-post-1" };
  }
}

/** An authoritative Meta rejection (4xx + Graph error): Meta provably did not create the post — retry-safe. */
export function facebookRejection(message: string) {
  return new FacebookPublishError(message, { retrySafe: true });
}

/** An uncertain outcome (network failure after sending, non-JSON/5xx, success without id): the post may exist. */
export function facebookUncertainFailure(message = "Network error calling the Meta Graph API: socket hang up") {
  return new FacebookPublishError(message);
}
