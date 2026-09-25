/**
 * Manual, local-only QA for the Visual Director (AlexAgent v0.2).
 *
 * Exercises the REAL pipeline —
 *   synthetic in-memory draft -> real Visual Director call
 *   -> real image generation (only if the plan picks a generative
 *      strategy) -> local deterministic renderer -> local PNG
 * — using the OpenAI credentials already in `.env.local`, WITHOUT ever
 * touching Supabase (remote) or Supabase Storage. It deliberately calls
 * only the pure/stateless layers (visualDirector.ts, aiClient.ts's
 * OpenAiClient, visualSourceResolver.ts, generativePromptBuilder.ts,
 * imageGenerationClient.ts, assetRenderer.ts) and never
 * lib/agent/assetGenerator.ts's generateAsset() — that function is the
 * one that couples Visual Director/BudgetGuard/production to Supabase
 * (agent_runs, content_assets, BudgetGuard's agent_settings/ai_usage
 * reads, AssetStorage.upload). None of that is invoked here.
 *
 * Run with:
 *   npx tsx scripts/visual-director-qa.ts
 *
 * Cost: at most 1 real Visual Director call + 1 real image-generation
 * call (only if the plan selects a generative strategy). No retries.
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { OpenAiClient } from "@/lib/agent/aiClient";
import { callVisualDirector, type VisualDirectorContext } from "@/lib/agent/visualDirector";
import { emptyVisualHistory } from "@/lib/agent/visualHistory";
import { resolveVisualSources } from "@/lib/agent/visualSourceResolver";
import { buildGenerativeImagePrompt } from "@/lib/agent/generativePromptBuilder";
import { OpenAiImageGenerationClient, imageGenerationCapabilityAvailable } from "@/lib/agent/imageGenerationClient";
import { renderImagePostAsset } from "@/lib/agent/assetRenderer";

// --- Minimal .env.local loader (no dependency, no CLI-flag reliance) ---
async function loadEnvLocal(): Promise<void> {
  const envPath = path.join(process.cwd(), ".env.local");
  let raw: string;
  try {
    raw = await readFile(envPath, "utf-8");
  } catch {
    return; // no .env.local — rely on whatever is already in process.env
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

async function main() {
  await loadEnvLocal();

  // --- Step 2: verify required OpenAI vars exist, without printing values ---
  const hasApiKey = Boolean(process.env.OPENAI_API_KEY);
  const executorModel = process.env.OPENAI_EXECUTOR_MODEL || "gpt-5.6-luna (default)";
  const imageModelConfigured = Boolean(process.env.OPENAI_IMAGE_MODEL);
  console.log("=== Env check (no secret values printed) ===");
  console.log("OPENAI_API_KEY present:", hasApiKey);
  console.log("OPENAI_EXECUTOR_MODEL:", executorModel);
  console.log("OPENAI_IMAGE_MODEL configured:", imageModelConfigured, imageModelConfigured ? `(${process.env.OPENAI_IMAGE_MODEL})` : "");
  if (!hasApiKey) {
    throw new Error("OPENAI_API_KEY is not set — refusing to proceed.");
  }

  // Everything below only uses pure/stateless modules imported at the
  // top of this file — no Supabase client is constructed anywhere in
  // this script.

  // --- Synthetic in-memory QA draft (never written anywhere) ---
  const draft = {
    topic: "QA — Explicar estimaciones con claridad",
    purpose:
      "Explicar que una estimación profesional debe mostrar los supuestos que la hacen posible, sin presentar proyecciones como garantías.",
    audience: "Instaladores y asesores solares",
    hook: "Una estimación clara no solo muestra un resultado: también explica qué condiciones lo hacen posible.",
    ctaText: "Conoce SolarDesk y comienza gratis.",
    visualDirection: "Comunicar transparencia y criterio profesional de una forma visualmente distinta a mostrar simplemente una propuesta PDF.",
  };

  // Same verified-source inventory Visual Director callers describe in
  // production (lib/agent/assetGenerator.ts's AVAILABLE_VERIFIED_SOURCES_SUMMARY),
  // duplicated here rather than imported so this script never pulls in
  // assetGenerator.ts (which is what actually couples to Supabase).
  const availableVerifiedSources = [
    "product_screenshot: real, verified SolarDesk product UI (dashboard/overview, and the proposals list/management screen).",
    "proposal_example: one real, verified client-facing solar proposal PDF SolarDesk can generate (overview page + financial/system-detail page) — any use always shows a visible 'illustrative example' disclosure.",
    "logo: the official SolarDesk logo — always composited automatically regardless of strategy; never request it separately.",
  ].join("\n");

  const generativeCapabilityAvailable = imageGenerationCapabilityAvailable();

  const context: VisualDirectorContext = {
    topic: draft.topic,
    purpose: draft.purpose,
    audience: draft.audience,
    hook: draft.hook,
    ctaText: draft.ctaText,
    visualDirection: draft.visualDirection,
    channel: "facebook",
    availableVerifiedSources,
    generativeCapabilityAvailable,
    generativeBudget: { approxCostUsd: null, budgetPermits: true }, // manual QA: no budget read
    recentHistory: emptyVisualHistory(), // no Supabase read for this manual QA — history is optional context, not required to exercise the Director
  };

  // --- Step 3: REAL Visual Director call (exactly once) ---
  console.log("\n=== Calling the real Visual Director (1 call) ===");
  const aiClient = new OpenAiClient();
  const directorResult = await callVisualDirector(aiClient, context);

  if (directorResult.incomplete || !directorResult.output) {
    throw new Error(
      `Visual Director did not return a usable plan: ${directorResult.incomplete ? `incomplete (${directorResult.incomplete.reason})` : "no output"}`
    );
  }
  const plan = directorResult.output;

  // --- Step 4: print the safe plan summary ---
  console.log("\n=== VisualCreativePlan ===");
  console.log("strategy:", plan.strategy);
  console.log("creativeConcept:", plan.creativeConcept);
  console.log("communicationGoal:", plan.communicationGoal);
  console.log("verifiedSourceCategory:", plan.verifiedSourceCategory);
  console.log("compositionIntent:", plan.compositionIntent);
  console.log("rationale:", plan.rationale);
  console.log("renderSpec:", plan.renderSpec);
  if (plan.generativeSceneDescription) {
    console.log("generativeSceneDescription:", plan.generativeSceneDescription);
  }
  console.log("\n(model used for Visual Director call:", directorResult.model + ")");

  // --- Step 6: resolve verified sources locally (pure, deterministic) ---
  const resolved = resolveVisualSources(
    plan,
    { visualDirection: draft.visualDirection, purpose: draft.purpose, topic: draft.topic },
    generativeCapabilityAvailable
  );
  console.log("\n=== Resolved sources ===");
  console.log("final strategy (after resolution/degradation):", resolved.strategy);
  console.log("screenshotMeta:", resolved.screenshotMeta?.file ?? null);
  console.log("proposalMeta:", resolved.proposalMeta ? "proposal example" : null);
  console.log("needsGeneratedImage:", resolved.needsGeneratedImage);
  console.log("degraded:", resolved.degraded, resolved.degradeReason ?? "");

  // --- Step 5: REAL image generation, only if the resolved plan needs one, at most once ---
  let generatedImage: Buffer | null = null;
  let imageGenCalls = 0;
  let imageModelUsed: string | null = null;
  if (resolved.needsGeneratedImage) {
    console.log("\n=== Calling the real image generation provider (1 call) ===");
    const { prompt } = buildGenerativeImagePrompt(plan);
    const imageClient = new OpenAiImageGenerationClient();
    const genResult = await imageClient.generate({ prompt });
    generatedImage = genResult.png;
    imageGenCalls = 1;
    imageModelUsed = genResult.model;
    console.log("image generation model:", genResult.model);
    console.log("image usage tokens:", genResult.usage);
  } else {
    console.log("\nNo generative imagery required by the resolved plan — skipping image generation.");
  }

  // --- Step 7: render the final asset locally (pure, no DB/Storage) ---
  const rendered = await renderImagePostAsset({
    headline: draft.hook,
    ctaText: draft.ctaText,
    assetVersion: 1,
    visualDirection: draft.visualDirection,
    purpose: draft.purpose,
    topic: draft.topic,
    renderSpec: plan.renderSpec,
    strategy: resolved.strategy,
    forceScreenshotMeta: resolved.screenshotMeta,
    forceProposalMeta: resolved.proposalMeta,
    generatedImage,
  });

  // --- Step 8: write locally under an ignored QA folder ---
  const outDir = path.join(process.cwd(), "tmp", "visual-director-qa");
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `qa-${resolved.strategy}-${stamp}.png`);
  await writeFile(outPath, rendered.png);

  console.log("\n=== Summary ===");
  console.log("Visual Director calls:", 1);
  console.log("Image generation calls:", imageGenCalls, imageModelUsed ? `(model: ${imageModelUsed})` : "");
  console.log("Renderer provenance.renderer:", rendered.provenance.renderer);
  console.log("Output size:", `${rendered.width}x${rendered.height}`);
  console.log("\nFinal PNG:", outPath);
}

main().catch((err) => {
  console.error("QA script failed:", err);
  process.exitCode = 1;
});
