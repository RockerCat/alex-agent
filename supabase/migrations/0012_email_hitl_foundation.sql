-- AlexAgent — Email human-in-the-loop: persistence foundation only.
--
-- Email is a sibling adapter over the existing durable content_drafts /
-- content_assets / agent_questions workflow, exactly like WhatsApp — never
-- a second approval, revision, question, or publishing state machine.
-- This migration only adds what a future email adapter needs to record
-- (outbound notification identity, single-use action tokens, inbound
-- idempotency); no application code sends email or consumes these tables
-- yet.
--
-- Strictly additive for the paused WhatsApp implementation: existing
-- notification_outbox rows, values, unique identity, and provider-status
-- diagnostics are unchanged. The CHECK constraints below are only
-- widened (every existing value remains valid), never narrowed.

-- ---------------------------------------------------------------------
-- notification_outbox: widen for email
-- ---------------------------------------------------------------------
-- Constraint names are Postgres's auto-generated names for the inline
-- column CHECKs declared in 0009_notification_outbox.sql
-- (<table>_<column>_check).
--
-- channel: + 'email'. The existing unique identity (brand, channel,
-- notification_type, subject_type, subject_id, subject_version) already
-- includes channel, so an email notification and a WhatsApp notification
-- for the same subject+version are independent slots — neither channel
-- can suppress or re-trigger the other.
alter table notification_outbox
  drop constraint notification_outbox_channel_check;
alter table notification_outbox
  add constraint notification_outbox_channel_check
    check (channel in ('whatsapp', 'email'));

-- notification_type:
--   'draft_pending_approval' (existing) — content pending approval, keyed
--     by subject_version = content_drafts.version.
--   'blocking_question' (existing, WhatsApp) — kept as-is.
--   'asset_pending_review' (new) — a content_assets row in pending_review,
--     keyed by subject_version = content_assets.asset_version.
--   'question_pending' (new) — any open agent_question, blocking or not
--     (the Executor's factual-gap questions are blocks_progress = false
--     and still need Alex's answer). Questions do not version, so this
--     keeps the same stable subject_version = 1 placeholder as
--     'blocking_question'.
alter table notification_outbox
  drop constraint notification_outbox_notification_type_check;
alter table notification_outbox
  add constraint notification_outbox_notification_type_check
    check (notification_type in (
      'draft_pending_approval',
      'blocking_question',
      'asset_pending_review',
      'question_pending'
    ));

alter table notification_outbox
  drop constraint notification_outbox_subject_type_check;
alter table notification_outbox
  add constraint notification_outbox_subject_type_check
    check (subject_type in ('content_draft', 'agent_question', 'content_asset'));

-- The outbound RFC 5322 Message-ID of an email notification, when the
-- provider exposes it. provider_message_id keeps meaning "the provider's
-- own id for this send" for every channel; rfc_message_id is the
-- separate, email-only header value an inbound reply's In-Reply-To /
-- References can be checked against. Always null for WhatsApp rows.
alter table notification_outbox
  add column rfc_message_id text;

create index notification_outbox_rfc_message_id_idx
  on notification_outbox (rfc_message_id)
  where rfc_message_id is not null;

-- ---------------------------------------------------------------------
-- email_action_tokens
-- ---------------------------------------------------------------------
-- One row per secure email action (an approve/reject link, or the
-- per-notification Reply-To token). Only a SHA-256 hash of the token is
-- ever stored — the plaintext exists only inside the sent email. The
-- token_hash format CHECK (exactly 64 lowercase hex chars) is a
-- structural guard against accidentally persisting a plaintext token.
--
-- Every token is bound to the exact subject identity + version it was
-- issued for. That binding is informational/correlational only: the
-- authoritative decision about whether the action may still apply is
-- always made by the existing domain functions (approveDraft /
-- rejectDraft / requestRevision with expectedVersion, approveAsset,
-- answerQuestion) — this table never becomes approval state itself.
--
-- consumed_at/outcome are set together, exactly once, by a single
-- conditional UPDATE (… where consumed_at is null and expires_at > now())
-- — the CHECK below keeps them from ever disagreeing.

create table email_action_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  notification_id uuid not null references notification_outbox (id),
  action text not null
    check (action in ('approve_draft', 'reject_draft', 'approve_asset', 'reply')),
  subject_type text not null
    check (subject_type in ('content_draft', 'content_asset', 'agent_question')),
  subject_id uuid not null,
  subject_version integer not null,
  brand text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  outcome text
    check (outcome in ('applied', 'stale', 'state_guard_failed', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > created_at),
  check ((consumed_at is null) = (outcome is null)),
  -- An action can only ever target the subject type it makes sense for:
  -- draft approve/reject act on a content_draft, asset approve on a
  -- content_asset; a reply may carry revision instructions (draft or
  -- asset) or an answer (question).
  check (
    (action in ('approve_draft', 'reject_draft') and subject_type = 'content_draft')
    or (action = 'approve_asset' and subject_type = 'content_asset')
    or (action = 'reply')
  )
);

create index email_action_tokens_notification_idx on email_action_tokens (notification_id);
create index email_action_tokens_subject_idx on email_action_tokens (subject_type, subject_id);

alter table email_action_tokens enable row level security;

-- ---------------------------------------------------------------------
-- email_inbound_events
-- ---------------------------------------------------------------------
-- One row per inbound email event, unique on the provider's own
-- event/message identity — the durable duplicate-processing guard
-- (provider webhooks are at-least-once), claimed BEFORE any workflow
-- call, same claim-first pattern as whatsapp_inbound_events (0011).
--
-- Unlike WhatsApp's approve/reject commands, an email reply's work
-- (a revision instruction, or an answer to an agent question) can be
-- legitimately deferred — e.g. the brand lock is held by a running wake,
-- or the Budget Guard blocks — so this row also carries what a retry
-- needs: status/attempts, and the SANITIZED instruction/answer text
-- (plain text, quoted history stripped, length-bounded) that will become
-- a content_revisions.feedback_note or an agent_questions.answer anyway.
-- Free-text replies never approve or reject anything.
--
-- Deliberately does NOT store: raw MIME, inbound HTML, attachments, the
-- subject line, or the sender's address/headers.

create table email_inbound_events (
  id uuid primary key default gen_random_uuid(),
  provider_event_id text not null unique,
  reply_token_id uuid references email_action_tokens (id),
  status text not null default 'pending'
    check (status in ('pending', 'applied', 'stale', 'rejected_sender', 'ignored', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  -- Upper bound is a storage-safety ceiling only; the future sanitizer
  -- applies its own (tighter) per-use limits before anything is stored.
  sanitized_text text check (char_length(sanitized_text) <= 4000),
  -- Short, sanitized diagnostic for a failed/deferred attempt — never a
  -- raw provider payload or inbound content.
  last_error text check (char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz,
  -- Only a correlated reply can ever have been applied to the workflow.
  check (status <> 'applied' or reply_token_id is not null)
);

create index email_inbound_events_pending_idx
  on email_inbound_events (created_at)
  where status = 'pending';

alter table email_inbound_events enable row level security;

-- Same pattern as 0011_whatsapp_inbound_events.sql: service_role is the
-- only role this app ever uses to touch these tables (RLS above denies
-- anon/authenticated entirely with zero policies); guarded on pg_roles
-- so this is a safe no-op against local/pglite validation.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.email_action_tokens to service_role;
    grant select, insert, update, delete on public.email_inbound_events to service_role;
  end if;
end;
$$;
