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
  // Spec section 5 names "GPT-5.6 Sol" / "GPT-5.6 Luna" as the intended
  // models; those are product-facing names, not confirmed API model ids.
  // Defaults below use currently-supported OpenAI models and are meant to
  // be overridden via env once the exact target ids are confirmed.
  plannerModel: () => process.env.OPENAI_PLANNER_MODEL || "gpt-4.1",
  executorModel: () => process.env.OPENAI_EXECUTOR_MODEL || "gpt-4.1-mini",
  ownerEmail: () => process.env.OWNER_EMAIL || null,
};
