/**
 * LOCAL, ONE-OFF visual-quality benchmark: OpenAI gpt-image-2 vs Google
 * Nano Banana 2 (gemini-3.1-flash-image) vs Google Nano Banana Pro
 * (gemini-3-pro-image), using the exact same creative brief and the
 * same downstream deterministic renderer (assetRenderer.ts).
 *
 * This does NOT call the Visual Director, the Planner, or
 * generateAsset() — it isolates the image-generation ENGINE only, so
 * the three candidates are comparable. It never touches Supabase or
 * Supabase Storage.
 *
 * Cost: at most 1 real call per provider (3 total). No retries, no
 * best-of-N, no automatic fallback between models.
 *
 * Run with:
 *   npx tsx scripts/visual-provider-benchmark.ts
 *
 * Pass --google-only to run ONLY the two Google candidates (0 OpenAI
 * calls, OpenAI code path never entered) and merge their results into
 * any existing results.json, preserving a prior OpenAI result as-is:
 *   npx tsx scripts/visual-provider-benchmark.ts --google-only
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { renderImagePostAsset } from "@/lib/agent/assetRenderer";

// --- Minimal .env.local loader (same pattern as scripts/visual-director-qa.ts) ---
async function loadEnvLocal(): Promise<void> {
  const envPath = path.join(process.cwd(), ".env.local");
  let raw: string;
  try {
    raw = await readFile(envPath, "utf-8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// --- Fixed creative brief (identical across all three providers) ---
const CREATIVE_BRIEF = {
  topic: "QA — Explicar estimaciones con claridad",
  purpose:
    "Explicar que una estimación profesional debe mostrar los supuestos que la hacen posible, sin presentar proyecciones como garantías.",
  audience: "Instaladores y asesores solares",
  hook: "Una estimación clara no solo muestra un resultado: también explica qué condiciones lo hacen posible.",
  ctaText: "Conoce SolarDesk y comienza gratis.",
  visualConcept:
    "Escena editorial profesional de un instalador solar y un cliente conversando sobre las condiciones y supuestos de un proyecto residencial frente a una vivienda con paneles solares. Debe transmitir claridad, criterio profesional, confianza y transparencia, no una promesa comercial.",
  visualDirection:
    "Imagen publicitaria premium para una marca B2B SaaS solar. Fotografía/editorial realista y natural, composición limpia, personas creíbles, anatomía correcta, manos y dedos naturales, iluminación profesional, suficiente espacio negativo para overlays de marca. Evitar apariencia de stock genérico, poses artificiales y estética evidente de imagen generada por IA.",
};

const REQUIRED_EXCLUSIONS =
  "Do not generate or include: any SolarDesk logo or brand wordmark, any readable app/software user interface, " +
  "any proposal or document pages, any pricing, any metrics, dashboards, or charts presented as real data, " +
  "any factual marketing claims, any readable CTA text or headline text, any fake dashboards, or any watermark.";

function buildSharedPrompt(): string {
  return [
    `Scene: ${CREATIVE_BRIEF.visualConcept}`,
    `Direction: ${CREATIVE_BRIEF.visualDirection}`,
    REQUIRED_EXCLUSIONS,
  ].join("\n\n");
}

const OUT_DIR = path.join(process.cwd(), "tmp", "visual-provider-benchmark");
const ASPECT_TARGET = "4:5" as const;
// Fixed, shared across all three renders so the ONLY variable between
// final composites is the generated background image.
const RENDER_ASSET_VERSION = 1;

interface CandidateResult {
  provider: "openai" | "google";
  model: string;
  success: boolean;
  latencyMs: number;
  nativeWidth: number | null;
  nativeHeight: number | null;
  nativeFormat: string | null;
  requestedAspect: string;
  usage: Record<string, unknown> | null;
  error: string | null;
  rawPath: string | null;
  finalPath: string | null;
  sha256Raw: string | null;
  sha256Final: string | null;
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// Reads a prior results.json (if any) so --google-only can preserve the
// existing OpenAI candidate instead of dropping it from the merged file.
async function loadExistingResults(): Promise<{ candidates?: CandidateResult[] } | null> {
  try {
    const raw = await readFile(path.join(OUT_DIR, "results.json"), "utf-8");
    return JSON.parse(raw) as { candidates?: CandidateResult[] };
  } catch {
    return null;
  }
}

function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Strip anything that looks like it could carry an API key/bearer token.
  return message.replace(/[A-Za-z0-9_-]{20,}/g, "[REDACTED]").slice(0, 800);
}

/**
 * Runs one candidate end to end: real generation call (at most once),
 * then the SAME deterministic renderer used in production, saving
 * raw + final PNGs. Never retries; a thrown error is caught by the
 * caller and recorded as a FAILED candidate.
 */
async function finishCandidate(
  provider: CandidateResult["provider"],
  model: string,
  latencyMs: number,
  nativeImageBytes: Buffer,
  usage: Record<string, unknown> | null,
  fileSlug: string
): Promise<CandidateResult> {
  const meta = await sharp(nativeImageBytes).metadata();
  const rawPngBuffer = await sharp(nativeImageBytes).png().toBuffer();

  const rawPath = path.join(OUT_DIR, `${fileSlug}-raw.png`);
  await writeFile(rawPath, rawPngBuffer);

  const rendered = await renderImagePostAsset({
    headline: CREATIVE_BRIEF.hook,
    ctaText: CREATIVE_BRIEF.ctaText,
    assetVersion: RENDER_ASSET_VERSION,
    strategy: "generated_photo",
    generatedImage: nativeImageBytes,
  });

  const finalPath = path.join(OUT_DIR, `${fileSlug}-final.png`);
  await writeFile(finalPath, rendered.png);

  return {
    provider,
    model,
    success: true,
    latencyMs,
    nativeWidth: meta.width ?? null,
    nativeHeight: meta.height ?? null,
    nativeFormat: meta.format ?? null,
    requestedAspect: ASPECT_TARGET,
    usage,
    error: null,
    rawPath: path.relative(process.cwd(), rawPath),
    finalPath: path.relative(process.cwd(), finalPath),
    sha256Raw: sha256(rawPngBuffer),
    sha256Final: sha256(rendered.png),
  };
}

function failedCandidate(provider: CandidateResult["provider"], model: string, latencyMs: number, err: unknown): CandidateResult {
  return {
    provider,
    model,
    success: false,
    latencyMs,
    nativeWidth: null,
    nativeHeight: null,
    nativeFormat: null,
    requestedAspect: ASPECT_TARGET,
    usage: null,
    error: sanitizeError(err),
    rawPath: null,
    finalPath: null,
    sha256Raw: null,
    sha256Final: null,
  };
}

// --- Candidate 1: OpenAI gpt-image-2 ---
async function runOpenAiGptImage2(prompt: string): Promise<CandidateResult> {
  const model = "gpt-image-2";
  const started = Date.now();
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    // 1024x1280 is exactly a 4:5 aspect ratio and satisfies gpt-image-2's
    // "divisible by 16" constraint; "high" quality (not "low") for a
    // real publication-quality benchmark candidate.
    const response = await client.images.generate({
      model,
      prompt,
      size: "1024x1280",
      quality: "high",
      output_format: "png",
      n: 1,
    });
    const latencyMs = Date.now() - started;

    const image = response.data?.[0];
    if (!image?.b64_json) {
      throw new Error("OpenAI response did not contain image data.");
    }
    const bytes = Buffer.from(image.b64_json, "base64");
    const usage = response.usage ? { ...response.usage } : null;

    return await finishCandidate("openai", model, latencyMs, bytes, usage, "openai-gpt-image-2");
  } catch (err) {
    return failedCandidate("openai", model, Date.now() - started, err);
  }
}

// --- Candidates 2 & 3: Google Gemini image models via @google/genai ---
async function runGeminiImageModel(
  model: "gemini-3.1-flash-image" | "gemini-3-pro-image",
  prompt: string,
  fileSlug: string
): Promise<CandidateResult> {
  const started = Date.now();
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const interaction = await ai.interactions.create({
      model,
      input: prompt,
      response_format: {
        type: "image",
        aspect_ratio: ASPECT_TARGET,
        image_size: "2K",
      },
    });
    const latencyMs = Date.now() - started;

    if (interaction.status !== "completed" || !interaction.output_image?.data) {
      const errDetail = interaction.errors?.length ? JSON.stringify(interaction.errors) : `status=${interaction.status}`;
      throw new Error(`Gemini interaction did not complete with an image (${errDetail}).`);
    }

    const bytes = Buffer.from(interaction.output_image.data, "base64");
    const usage = interaction.usage ? { ...interaction.usage } : null;

    return await finishCandidate("google", model, latencyMs, bytes, usage, fileSlug);
  } catch (err) {
    return failedCandidate("google", model, Date.now() - started, err);
  }
}

async function main() {
  await loadEnvLocal();

  const googleOnly = process.argv.includes("--google-only");

  const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY);
  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY);
  console.log("=== Env check (no secret values printed) ===");
  console.log("OPENAI_API_KEY present:", hasOpenAiKey);
  console.log("GEMINI_API_KEY present:", hasGeminiKey);
  console.log("Mode:", googleOnly ? "--google-only (0 OpenAI calls; 2 Google candidates only)" : "full benchmark (3 providers)");
  if (!googleOnly && !hasOpenAiKey) throw new Error("OPENAI_API_KEY is not set — refusing to proceed.");
  if (!hasGeminiKey) throw new Error("GEMINI_API_KEY is not set — refusing to proceed.");

  await mkdir(OUT_DIR, { recursive: true });

  const prompt = buildSharedPrompt();
  console.log("\n=== Shared prompt (identical for all three providers) ===");
  console.log(prompt);

  let openaiResult: CandidateResult | null;
  if (googleOnly) {
    const existing = await loadExistingResults();
    const preserved = existing?.candidates?.find((c) => c.provider === "openai") ?? null;
    console.log(
      preserved
        ? "\n=== Skipping OpenAI gpt-image-2 (--google-only): preserving existing result from results.json ==="
        : "\n=== Skipping OpenAI gpt-image-2 (--google-only): no prior result found to preserve ==="
    );
    openaiResult = preserved;
  } else {
    console.log("\n=== Calling OpenAI gpt-image-2 (1 call) ===");
    openaiResult = await runOpenAiGptImage2(prompt);
    console.log(openaiResult.success ? "SUCCESS" : `FAILED: ${openaiResult.error}`);
  }

  console.log("\n=== Calling Google gemini-3.1-flash-image / Nano Banana 2 (1 call) ===");
  const nanoBanana2Result = await runGeminiImageModel("gemini-3.1-flash-image", prompt, "nano-banana-2");
  console.log(nanoBanana2Result.success ? "SUCCESS" : `FAILED: ${nanoBanana2Result.error}`);

  console.log("\n=== Calling Google gemini-3-pro-image / Nano Banana Pro (1 call) ===");
  const nanoBananaProResult = await runGeminiImageModel("gemini-3-pro-image", prompt, "nano-banana-pro");
  console.log(nanoBananaProResult.success ? "SUCCESS" : `FAILED: ${nanoBananaProResult.error}`);

  const candidates = [openaiResult, nanoBanana2Result, nanoBananaProResult].filter(
    (c): c is CandidateResult => c !== null
  );

  const results = {
    generatedAt: new Date().toISOString(),
    mode: googleOnly ? "google-only" : "full",
    aspectTarget: ASPECT_TARGET,
    renderer: { renderAssetVersion: RENDER_ASSET_VERSION, strategy: "generated_photo" },
    creativeBrief: CREATIVE_BRIEF,
    sharedPrompt: prompt,
    maxCallsPerProvider: 1,
    candidates,
  };

  const resultsPath = path.join(OUT_DIR, "results.json");
  await writeFile(resultsPath, JSON.stringify(results, null, 2));

  console.log("\n=== Summary ===");
  for (const c of candidates) {
    console.log(`${c.provider}/${c.model}: ${c.success ? "SUCCESS" : "FAILED"}${c.success ? ` (${c.nativeWidth}x${c.nativeHeight})` : ""}`);
  }
  console.log("\nResults written to:", path.relative(process.cwd(), resultsPath));
}

main().catch((err) => {
  console.error("Benchmark script failed:", err);
  process.exitCode = 1;
});
