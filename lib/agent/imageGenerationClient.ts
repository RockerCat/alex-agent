import OpenAI from "openai";
import { env } from "@/lib/env";
import type { UsageTokens } from "@/lib/agent/pricing";

// Visual Director generative-imagery capability seam (AlexAgent v0.2).
// Mirrors the AiClient injection pattern (lib/agent/aiClient.ts): the
// real OpenAI-backed client is used in production; tests inject a
// scripted fake so the generative-strategy/budget/failure paths are
// testable without a real (paid) API call.
//
// Capability discovered in the installed stack (openai@6.49.0):
// `client.images.generate()` supports the GPT image models
// (`gpt-image-1`/`gpt-image-1-mini`/`gpt-image-1.5`/`gpt-image-2`, per
// OpenAI's Images API) and returns real per-token `usage` (input/output
// tokens) exactly like the Responses API text calls this codebase
// already accounts for — so it slots directly into the existing
// UsageTokens/BudgetGuard/pricing machinery with no new accounting
// shape. No image-editing/variation/streaming capability is used here
// — text-prompt generation only.
//
// Capability is opt-in only (env.imageModel(), lib/env.ts) — absent
// means generative strategies are unavailable, and callers must never
// fabricate a result: imageGenerationCapabilityAvailable() must be
// checked before the Visual Director is even told generative strategies
// exist, and generate() must only ever be called after a real
// BudgetGuard.checkBeforeCall() pass (see lib/agent/assetGenerator.ts).

// Fixed, non-configurable size/quality: keeps the pre-call budget
// estimate deterministic (gpt-image-1's output token count is a
// function of size+quality, not a token cap parameter) and keeps
// worst-case per-image cost small and predictable. 1024x1536 (portrait)
// is the closest available GPT-image size to this app's 1080x1350
// image_post canvas; the renderer cover-crops/resizes it like every
// other composited source (see assetRenderer.ts).
export const IMAGE_GENERATION_SIZE = "1024x1536" as const;
export const IMAGE_GENERATION_QUALITY = "low" as const;

// Conservative pre-call estimate for BudgetGuard.checkBeforeCall's
// approxMaxOutputTokens: OpenAI's published gpt-image-1 image-token
// count for 1024x1536/low is materially smaller than this; padded for
// safety margin so the pessimistic pre-call estimate never under-
// reserves budget. Re-verify against live OpenAI documentation before
// changing IMAGE_GENERATION_SIZE/QUALITY.
export const IMAGE_GENERATION_APPROX_OUTPUT_TOKENS = 600;
// The constructed prompt (see generativePromptBuilder.ts) is short and
// bounded by VISUAL_PLAN_TEXT_LIMITS — this is a generous ceiling.
export const IMAGE_GENERATION_APPROX_INPUT_TOKENS = 400;

export class ImageGenerationError extends Error {}

export interface ImageGenerationInput {
  prompt: string;
}

export interface ImageGenerationResult {
  png: Buffer;
  model: string;
  usage: UsageTokens;
  /** GPT image models don't return a revised prompt (that's a dall-e-3-only field) — present only if the provider ever supplies one, for audit purposes. */
  revisedPrompt?: string;
}

export interface ImageGenerationClient {
  generate(input: ImageGenerationInput): Promise<ImageGenerationResult>;
}

/** True only when a specific image model has been explicitly, manually configured — never inferred from the installed SDK version alone. */
export function imageGenerationCapabilityAvailable(): boolean {
  return env.imageModel() !== null;
}

export class OpenAiImageGenerationClient implements ImageGenerationClient {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({ apiKey: env.openaiApiKey() });
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const model = env.imageModel();
    if (!model) {
      throw new ImageGenerationError("No image-generation model configured (OPENAI_IMAGE_MODEL is unset).");
    }

    const response = await this.client.images.generate({
      model,
      prompt: input.prompt,
      size: IMAGE_GENERATION_SIZE,
      quality: IMAGE_GENERATION_QUALITY,
      output_format: "png",
      n: 1,
    });

    const image = response.data?.[0];
    if (!image?.b64_json) {
      throw new ImageGenerationError("Image generation response did not contain image data.");
    }

    if (!response.usage) {
      throw new ImageGenerationError(
        "Image generation response did not include usage data — refusing to proceed without recording actual cost."
      );
    }

    return {
      png: Buffer.from(image.b64_json, "base64"),
      model,
      usage: {
        inputTokens: response.usage.input_tokens,
        cachedInputTokens: 0,
        outputTokens: response.usage.output_tokens,
      },
      revisedPrompt: image.revised_prompt,
    };
  }
}
