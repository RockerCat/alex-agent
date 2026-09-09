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
  // The Responses API `reasoning` param is only accepted by gpt-5/o-series
  // reasoning models. gpt-5.6-sol supports it, so "medium" (spec section 5)
  // is the default; only override/unset this if OPENAI_PLANNER_MODEL is
  // pointed at a non-reasoning model, which would otherwise hard-fail every
  // Planner call.
  plannerReasoningEffort: () => process.env.OPENAI_PLANNER_REASONING_EFFORT || "medium",
  ownerEmail: () => process.env.OWNER_EMAIL || null,
};
