// Deterministic runtime constants — ALEXAGENT_V0.1_SPEC.md sections 11 & 22.
// These are safety circuit breakers, not content quotas: the Planner can
// still legitimately choose to create zero pieces of content.

export const MAX_CONTENT_PER_CYCLE = 7;
export const MAX_EXECUTOR_RETRIES = 2;
export const MAX_PLANNER_CALLS_PER_RUN = 2;
export const PER_RUN_AI_BUDGET_USD = 1.0;

export const PLAN_PERIOD_DAYS = 7;

export const OBJECTIVE_CATALOG = [
  "BRAND_AWARENESS",
  "QUALIFIED_TRAFFIC",
  "LEAD_GENERATION",
  "SIGNUPS",
  "ACTIVATION",
  "CONVERSION",
  "RETENTION",
  "ENGAGEMENT",
  "REACTIVATION",
] as const;

export type Objective = (typeof OBJECTIVE_CATALOG)[number];

export const PLANNER_DECISIONS = [
  "CREATE_PLAN",
  "CONTINUE_EXISTING_PLAN",
  "WAIT_FOR_APPROVAL",
  "NO_ACTION",
  "NEEDS_HUMAN_INPUT",
] as const;

export type PlannerDecision = (typeof PLANNER_DECISIONS)[number];

// Channels/formats authorized for the SolarDesk pilot per brands/solardesk/BRAND.md
// ("Canales y llamadas a la acción" — only Facebook and Instagram are
// documented as available social channels; no ad budget, no other network).
export const ALLOWED_CHANNELS = ["instagram", "facebook"] as const;
export type AllowedChannel = (typeof ALLOWED_CHANNELS)[number];

export const ALLOWED_CONTENT_TYPES = [
  "carousel",
  "image_post",
  "story",
  "caption_only",
] as const;
export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

export const FEEDBACK_CATEGORIES = [
  "too_generic",
  "too_promotional",
  "too_long",
  "too_technical",
  "wrong_tone",
  "weak_hook",
  "weak_cta",
  "factually_incorrect",
  "visual_needs_work",
  "other",
] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const SUPPORTED_BRANDS = ["solardesk"] as const;
export type SupportedBrand = (typeof SUPPORTED_BRANDS)[number];
