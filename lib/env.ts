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
  // Opt-in only, same posture as plannerReasoningEffort above: absent or
  // empty means generative strategies are unavailable and the Visual
  // Director must never select one — capability is not assumed from the
  // installed SDK version, only from an explicit, human-confirmed model
  // id. Set it only once a specific model is confirmed to work and its
  // pricing (lib/agent/pricing.ts) has been verified against live
  // OpenAI billing.
  imageModel: () => process.env.OPENAI_IMAGE_MODEL || null,
  ownerEmail: () => process.env.OWNER_EMAIL || null,
};
