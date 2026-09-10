// Hand-written types mirroring supabase/migrations/*.sql.
// These are not generated from a live project (none is provisioned in this
// environment) — if the schema drifts, regenerate with
// `supabase gen types typescript` and replace this file.

export type RunStatus = "queued" | "running" | "completed" | "failed" | "skipped";
export type RunTrigger = "manual" | "scheduled" | "event";
export type RunKind = "marketing_cycle" | "revision";
export type RunDecision =
  | "CREATE_PLAN"
  | "CONTINUE_EXISTING_PLAN"
  | "WAIT_FOR_APPROVAL"
  | "NO_ACTION"
  | "NEEDS_HUMAN_INPUT"
  | "PREFLIGHT_SKIP"
  | "BUDGET_BLOCKED";

export type PlanStatus = "active" | "completed" | "superseded";

export type DraftStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "revision_requested"
  | "rejected"
  | "scheduled"
  | "published";

export type Channel = "instagram" | "facebook";
export type ContentType = "carousel" | "image_post" | "story" | "caption_only";

export type FeedbackCategory =
  | "too_generic"
  | "too_promotional"
  | "too_long"
  | "too_technical"
  | "wrong_tone"
  | "weak_hook"
  | "weak_cta"
  | "factually_incorrect"
  | "visual_needs_work"
  | "other";

export type QuestionStatus = "open" | "answered" | "dismissed";

export type AgentSettingsRow = {
  id: string;
  singleton: boolean;
  monthly_budget_usd: number;
  safety_reserve_usd: number;
  per_run_budget_usd: number;
  solardesk_enabled: boolean;
  approval_policy: "ALL_CONTENT_REQUIRES_APPROVAL";
  execution_mode: "MANUAL";
  updated_at: string;
}

export type AgentRunRow = {
  id: string;
  brand: string;
  kind: RunKind;
  trigger: RunTrigger;
  status: RunStatus;
  decision: RunDecision | null;
  summary: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

export type MarketingPlanRow = {
  id: string;
  brand: string;
  period_start: string;
  period_end: string;
  primary_objective: string;
  primary_objective_reason: string;
  primary_objective_success_signal: string;
  supporting_objectives: string[];
  strategy_summary: string;
  strategy_audience: string;
  strategy_approach: string;
  rationale: string;
  status: PlanStatus;
  created_by_run: string | null;
  created_at: string;
}

export type ContentDraftBody = {
  slides?: { slide: number; text: string }[];
  [key: string]: unknown;
}

export type ContentDraftRow = {
  id: string;
  plan_id: string;
  brand: string;
  created_by_run: string | null;
  channel: Channel;
  content_type: ContentType;
  purpose: string;
  topic: string;
  audience: string;
  cta: string;
  target_date: string;
  status: DraftStatus;
  version: number;
  title: string | null;
  hook: string | null;
  body: ContentDraftBody;
  caption: string | null;
  cta_text: string | null;
  visual_direction: string | null;
  hashtags: string[];
  blocked_on_question_id: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ContentRevisionRow = {
  id: string;
  draft_id: string;
  version: number;
  title: string | null;
  hook: string | null;
  body: ContentDraftBody;
  caption: string | null;
  cta_text: string | null;
  visual_direction: string | null;
  hashtags: string[];
  source: "executor" | "initial";
  feedback_category: FeedbackCategory | null;
  feedback_note: string | null;
  created_by_run: string | null;
  created_at: string;
}

export type AgentQuestionRow = {
  id: string;
  brand: string;
  question: string;
  reason: string;
  status: QuestionStatus;
  blocks_progress: boolean;
  answer: string | null;
  context_run_id: string | null;
  context_plan_id: string | null;
  context_draft_id: string | null;
  created_at: string;
  answered_at: string | null;
}

export type AssetStatus = "pending_review" | "ready_to_publish" | "generation_failed";
export type AssetFormat = "image_post";

export type ContentAssetRow = {
  id: string;
  draft_id: string;
  brand: string;
  asset_version: number;
  source_draft_version: number;
  status: AssetStatus;
  format: AssetFormat;
  width: number | null;
  height: number | null;
  mime_type: string;
  storage_bucket: string | null;
  storage_path: string | null;
  render_provenance: Record<string, unknown>;
  error_message: string | null;
  created_at: string;
  approved_at: string | null;
}

export type AiUsageRow = {
  id: string;
  agent_run_id: string | null;
  brand: string;
  operation: "planner" | "executor";
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  created_at: string;
}

// Matches @supabase/postgrest-js's GenericTable/GenericSchema shape so the
// client's generic inference resolves properly instead of collapsing to
// `never`. This app has no foreign-table `.select()` embeds, so
// Relationships is always empty.
type TableDef<Row> = {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      agent_settings: TableDef<AgentSettingsRow>;
      agent_runs: TableDef<AgentRunRow>;
      marketing_plans: TableDef<MarketingPlanRow>;
      content_drafts: TableDef<ContentDraftRow>;
      content_revisions: TableDef<ContentRevisionRow>;
      content_assets: TableDef<ContentAssetRow>;
      agent_questions: TableDef<AgentQuestionRow>;
      ai_usage: TableDef<AiUsageRow>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}
