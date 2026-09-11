import type { ImageGenerationClient, ImageGenerationInput, ImageGenerationResult } from "@/lib/agent/imageGenerationClient";
import { ImageGenerationError } from "@/lib/agent/imageGenerationClient";

// Scripted stand-in for the OpenAI-backed image generation client,
// mirroring ScriptedAiClient's pattern (tests/support/fakeAiClient.ts).
// Never calls a real provider. Produces a tiny deterministic 4x4 PNG
// (a real, valid PNG — not a placeholder string) so callers that feed
// this through sharp() for compositing get a real image.

// Smallest possible valid PNG: 1x1 transparent pixel (67 bytes). Reused
// as a placeholder "generated" image everywhere a test needs a real
// decodable PNG buffer without depending on `sharp` to construct one.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export function tinyPngBuffer(): Buffer {
  return Buffer.from(TINY_PNG_BASE64, "base64");
}

export class ScriptedImageGenerationClient implements ImageGenerationClient {
  calls: ImageGenerationInput[] = [];
  failNextCalls = 0;
  /** When true, the next call throws ImageGenerationError (capability/provider failure) rather than succeeding. */

  constructor(
    private queue: ImageGenerationResult[] = [
      { png: tinyPngBuffer(), model: "test-image-model", usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 400 } },
    ]
  ) {}

  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    this.calls.push(input);
    if (this.failNextCalls > 0) {
      this.failNextCalls -= 1;
      throw new ImageGenerationError("Simulated image generation provider failure.");
    }
    const output = this.queue.length > 1 ? this.queue.shift()! : this.queue[0];
    if (!output) throw new Error("ScriptedImageGenerationClient: no output queued");
    return output;
  }
}
