function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Server-only environment access. Importing this module from client
 * components will throw at build time if it ever ends up in a client
 * bundle that lacks these vars — that's intentional: these secrets must
 * never reach the browser (spec section 22 / 25).
 */
export const env = {
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  openaiApiKey: () => required("OPENAI_API_KEY"),
  // Confirmed production models (spec section 5: "GPT-5.6 Sol" / "GPT-5.6
  // Luna"). Pricing for both is registered in lib/agent/pricing.ts —
  // keep the two in sync if either model id changes.
  plannerModel: () => process.env.OPENAI_PLANNER_MODEL || "gpt-5.6-sol",
  executorModel: () => process.env.OPENAI_EXECUTOR_MODEL || "gpt-5.6-luna",
  // Live evidence: gpt-5.6-sol rejects the Responses API `reasoning`
  // param outright — "400 Unsupported parameter: 'reasoning.effort' is
  // not supported with this model." Whether a given model accepts this
  // param is not something to infer from its name or the spec's stated
  // intent; it must be verified against the live API. So this is opt-in
  // only: absent or empty, no reasoning param is sent to anyone. Set it
  // explicitly only once a specific configured model is confirmed to
  // accept it.
  plannerReasoningEffort: () => process.env.OPENAI_PLANNER_REASONING_EFFORT || null,
  // Visual Director generative-imagery capability (lib/agent/imageGenerationClient.ts).
  // Defaults to gpt-image-2 — confirmed via a controlled visual-quality
  // benchmark against gpt-image-1 and the Google Nano Banana candidates
  // (scripts/visual-provider-benchmark.ts); publishable quality, promoted
  // to the real Visual Director runtime. Still fully overridable via
  // OPENAI_IMAGE_MODEL (e.g. to roll back to gpt-image-1) — set it
  // explicitly only once the replacement model is itself confirmed to
  // work and its pricing (lib/agent/pricing.ts) has been verified against
  // live OpenAI billing.
  imageModel: () => process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
  ownerEmail: () => process.env.OWNER_EMAIL || null,
};
