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
  // Facebook manual publishing (AlexAgent v0.2 checkpoint 1). Nullable
  // (not `required()`) on purpose: publishing is a manually-triggered
  // action, not something every code path needs, so a missing value
  // must surface as a safe "Facebook publishing is not configured"
  // result from lib/agent/publish.ts — never an uncaught throw at
  // import time. Server-side only; never expose via NEXT_PUBLIC_*.
  //
  // `.trim()`: defensive credential hygiene only — env values can pick
  // up incidental leading/trailing whitespace depending on how they
  // were set. This was NOT the cause of any specific incident; the one
  // real failed-smoke root cause found during this checkpoint was a
  // `.env.local` Page Access Token that simply held a different token
  // than the one validated manually (confirmed via SHA-256 hash
  // comparison, fixed by correcting the value) — see PROJECT_STATUS.md.
  metaFacebookPageAccessToken: () => process.env.META_FACEBOOK_PAGE_ACCESS_TOKEN?.trim() || null,
  metaFacebookPageId: () => process.env.META_FACEBOOK_PAGE_ID?.trim() || null,
  // Instagram publishing readiness (env/config contract only — see
  // lib/agent/instagramClient.ts). Same nullable + `.trim()` pattern as
  // the Facebook vars above, for the same reasons: publishing is a
  // manually-triggered capability, not something every code path
  // needs, so a missing value must surface as a safe "not configured"
  // result rather than an uncaught throw at import time; trimming
  // guards against incidental whitespace from how the value was set.
  // Server-side only; never expose via NEXT_PUBLIC_*.
  metaInstagramAccessToken: () => process.env.META_INSTAGRAM_ACCESS_TOKEN?.trim() || null,
  metaInstagramAccountId: () => process.env.META_INSTAGRAM_ACCOUNT_ID?.trim() || null,
  // Autonomy v1 Phase 1B: Vercel Cron's own reserved env var name —
  // required to be exactly CRON_SECRET for Vercel to auto-inject
  // `Authorization: Bearer <value>` on its scheduled GET request (see
  // app/api/cron/marketing-cycle/route.ts and vercel.json). Nullable,
  // same fail-closed posture as the Meta accessors above: absent config
  // must make the endpoint refuse to run the agent, never throw at
  // import time. A machine caller with no browser session, so it cannot
  // use requireSession(); dedicated to this one endpoint only — never
  // reused for Meta/Supabase/session auth.
  cronSecret: () => process.env.CRON_SECRET?.trim() || null,
  // WhatsApp outbound attention notifications (Autonomy v1 — see
  // lib/agent/whatsappClient.ts). Its own dedicated Meta credentials —
  // a WhatsApp Cloud API access token and phone number ID are NOT the
  // same credential type as a Facebook Page token or an Instagram Login
  // token (confirmed by inspecting those two clients: each Meta
  // capability here has always had its own isolated env pair, never a
  // shared "Meta credentials" object), so this must never fall back to
  // metaFacebookPageAccessToken()/metaInstagramAccessToken(). Nullable,
  // same fail-closed posture as the other Meta accessors: a missing
  // value must surface as a safe "not configured" result, never an
  // uncaught throw at import time. Server-side only; never expose via
  // NEXT_PUBLIC_*.
  metaWhatsappAccessToken: () => process.env.META_WHATSAPP_ACCESS_TOKEN?.trim() || null,
  metaWhatsappPhoneNumberId: () => process.env.META_WHATSAPP_PHONE_NUMBER_ID?.trim() || null,
  // Alex's own destination number for this single-owner, single-brand
  // first slice — an env var (not a persisted settings row) is the
  // right level of durability here, matching the existing single-owner
  // ownerEmail() pattern above; this should move to persisted,
  // per-brand settings only once there is more than one recipient/brand
  // to notify (MiPadel.Club/Odentia — not implemented here).
  metaWhatsappDestinationNumber: () => process.env.META_WHATSAPP_DESTINATION_NUMBER?.trim() || null,
  // The approved-pending Meta template name/language are configuration,
  // not something to hardcode in lib/agent/whatsappClient.ts or
  // lib/agent/notifications.ts — overridable, but defaulted to the
  // real template already submitted for review (see PROJECT_STATUS.md).
  // "es_CO" (Spanish — Colombia) is Meta's documented language code for
  // that locale; reconfirm against the current Meta template-language
  // reference if the template's approved language ever differs.
  metaWhatsappTemplateName: () => process.env.META_WHATSAPP_TEMPLATE_NAME?.trim() || "alexagent_attention_required",
  metaWhatsappTemplateLanguage: () => process.env.META_WHATSAPP_TEMPLATE_LANGUAGE?.trim() || "es_CO",
  // Needed to build a real, clickable /approvals/<draft.id> link inside
  // a WhatsApp message (see lib/agent/notifications.ts). No existing
  // accessor in this file already does this — repo-wide search found
  // none. Deliberately NOT read from Vercel's own auto-injected
  // VERCEL_URL/VERCEL_PROJECT_PRODUCTION_URL here: their exact current
  // semantics (preview vs. production, protocol) should be confirmed
  // against current Vercel documentation before relying on them
  // instead of this explicit, unambiguous override. Nullable — a
  // notification can still degrade to sending its text without a link
  // if this is unset, never throw.
  appBaseUrl: () => process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") || null,
  // WhatsApp Cloud API webhook verification (see
  // app/api/webhooks/whatsapp/route.ts, lib/agent/whatsappWebhook.ts).
  // Meta's GET handshake echoes this back only when it matches exactly
  // what's configured in the Meta App Dashboard's webhook setup — a
  // separate secret from META_WHATSAPP_ACCESS_TOKEN, never reused for
  // it. Nullable, same fail-closed posture as the other Meta accessors:
  // an unconfigured token must make the endpoint refuse verification
  // (503), never fall back to accepting any token.
  metaWhatsappWebhookVerifyToken: () => process.env.META_WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim() || null,
};
