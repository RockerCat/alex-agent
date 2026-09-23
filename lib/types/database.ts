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
  /** Separate, optional destination URL (see lib/agent/cta.ts). Null for content with no specific destination, and for legacy rows persisted before this field existed — see lib/agent/cta.ts's legacy-compatible resolver. */
  cta_url: string | null;
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

export type PublicationChannel = "facebook" | "instagram";
export type PublicationStatus = "publishing" | "published" | "failed";

export type AssetPublicationRow = {
  id: string;
  asset_id: string;
  draft_id: string;
  brand: string;
  channel: PublicationChannel;
  status: PublicationStatus;
  meta_post_id: string | null;
  published_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
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

export type NotificationChannel = "whatsapp" | "email";
// "blocking_question" is WhatsApp's existing type; email uses
// "question_pending" (any open question, blocking or not) — see
// supabase/migrations/0012_email_hitl_foundation.sql.
export type NotificationType = "draft_pending_approval" | "blocking_question" | "asset_pending_review" | "question_pending";
export type NotificationSubjectType = "content_draft" | "agent_question" | "content_asset";
export type NotificationStatus = "pending" | "sent" | "failed";
// Meta's own asynchronous delivery-status callback — a separate signal
// from NotificationStatus above (which means "accepted by Meta"); see
// lib/agent/whatsappWebhook.ts.
export type NotificationProviderStatus = "sent" | "delivered" | "read" | "failed";

export type NotificationOutboxRow = {
  id: string;
  brand: string;
  channel: NotificationChannel;
  notification_type: NotificationType;
  subject_type: NotificationSubjectType;
  subject_id: string;
  subject_version: number;
  status: NotificationStatus;
  provider_message_id: string | null;
  error_message: string | null;
  agent_run_id: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  provider_status: NotificationProviderStatus | null;
  provider_status_at: string | null;
  provider_error_code: number | null;
  provider_error_detail: string | null;
  /** Email only: the outbound RFC 5322 Message-ID, when the provider exposes it. Always null for WhatsApp. */
  rfc_message_id: string | null;
}

// WhatsApp Inbound Phase 1 (see lib/agent/whatsappInboundCommands.ts).
// Deliberately excludes sender/destination phone numbers and raw message
// text — see supabase/migrations/0011_whatsapp_inbound_events.sql for why.
export type WhatsappInboundCommand = "aprobar" | "rechazar";
export type WhatsappInboundOutcome =
  | "processing"
  | "approved"
  | "rejected"
  | "state_guard_failed"
  | "unsupported_command"
  | "no_candidate"
  | "ambiguous_candidates"
  | "unresolved_context"
  | "unauthorized_sender";

export type WhatsappInboundEventRow = {
  id: string;
  provider_message_id: string;
  command: WhatsappInboundCommand | null;
  resolved_draft_id: string | null;
  outcome: WhatsappInboundOutcome;
  created_at: string;
}

// Email human-in-the-loop foundation (0012_email_hitl_foundation.sql).
// Only a SHA-256 hash of an action token is ever persisted.
export type EmailActionType = "approve_draft" | "reject_draft" | "approve_asset" | "reply";
export type EmailActionSubjectType = "content_draft" | "content_asset" | "agent_question";
export type EmailActionOutcome = "applied" | "stale" | "state_guard_failed" | "failed";

export type EmailActionTokenRow = {
  id: string;
  token_hash: string;
  notification_id: string;
  action: EmailActionType;
  subject_type: EmailActionSubjectType;
  subject_id: string;
  subject_version: number;
  brand: string;
  expires_at: string;
  consumed_at: string | null;
  outcome: EmailActionOutcome | null;
  created_at: string;
  updated_at: string;
}

// Deliberately excludes raw MIME, inbound HTML, attachments, subject line,
// and sender address — only the sanitized text a retry needs.
export type EmailInboundStatus = "pending" | "applied" | "stale" | "rejected_sender" | "ignored" | "failed";

export type EmailInboundEventRow = {
  id: string;
  provider_event_id: string;
  reply_token_id: string | null;
  status: EmailInboundStatus;
  attempts: number;
  sanitized_text: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
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
      asset_publications: TableDef<AssetPublicationRow>;
      agent_questions: TableDef<AgentQuestionRow>;
      ai_usage: TableDef<AiUsageRow>;
      notification_outbox: TableDef<NotificationOutboxRow>;
      whatsapp_inbound_events: TableDef<WhatsappInboundEventRow>;
      email_action_tokens: TableDef<EmailActionTokenRow>;
      email_inbound_events: TableDef<EmailInboundEventRow>;
    };
    Views: Record<string, never>;
    Functions: {
      // 0013_approve_asset_if_current.sql — atomic exact-version asset approval.
      approve_asset_if_current: {
        Args: { p_asset_id: string; p_draft_id: string; p_expected_asset_version: number };
        Returns: string | null;
      };
    };
  };
}
