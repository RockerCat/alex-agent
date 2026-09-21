-- AlexAgent — Autonomy v1: WhatsApp outbound attention notifications
-- (outbound only; no inbound/webhook handling yet).
--
-- One row per logical notification identity. This is the actual
-- duplicate-notification guard: a wake that observes the same
-- unresolved pending draft or open blocking question on a later day
-- must not spam Alex again — the unique constraint below, not
-- application logic alone, is the real boundary (mirrors the
-- agent_runs "one running per brand" / asset_publications "(asset_id,
-- channel)" lock patterns already used in this schema).
--
-- subject_version distinguishes a genuinely new actionable revision
-- (a draft revised after "Request Changes" bumps content_drafts.version)
-- from the *same* still-pending item being observed again by a later
-- wake — a new version is a new logical identity and may notify again.
-- agent_questions does not version today, so question notifications
-- always use subject_version = 1 (a stable placeholder, not a real
-- version concept) — kept as a real column rather than omitted so the
-- same table/unique-constraint shape works for both subject types
-- without a nullable special case.
--
-- Lifecycle: a row is inserted with status='pending' BEFORE the Meta
-- WhatsApp Graph API call is made (claiming the slot), then updated to
-- 'sent' (with provider_message_id/sent_at) on success or 'failed' (with
-- a sanitized error_message — never a token/authorization header) on
-- failure. A 'pending' or 'failed' row can be reclaimed by a later
-- invocation (see lib/agent/notifications.ts); a 'sent' row blocks a new
-- attempt outright — the same claim/reclaim shape as
-- lib/agent/publish.ts's claimPublicationSlot.
--
-- agent_run_id is informational only (which wake produced this attempt,
-- for operational diagnosis) — it is deliberately NOT part of the
-- unique identity: a new run/wake happens daily and must not be able to
-- re-trigger a notification for an unchanged subject.

create table notification_outbox (
  id uuid primary key default gen_random_uuid(),
  brand text not null,
  channel text not null check (channel in ('whatsapp')),
  notification_type text not null
    check (notification_type in ('draft_pending_approval', 'blocking_question')),
  subject_type text not null check (subject_type in ('content_draft', 'agent_question')),
  subject_id uuid not null,
  subject_version integer not null default 1,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed')),
  provider_message_id text,
  error_message text,
  agent_run_id uuid references agent_runs (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (brand, channel, notification_type, subject_type, subject_id, subject_version)
);

create index notification_outbox_status_idx on notification_outbox (status);
create index notification_outbox_subject_idx on notification_outbox (subject_type, subject_id);

alter table notification_outbox enable row level security;

-- Same pattern as 0006_asset_publications.sql: service_role is the only
-- role this app ever uses to touch this table (RLS above denies
-- anon/authenticated entirely with zero policies); guarded on pg_roles
-- so this is a safe no-op against local/pglite validation.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.notification_outbox to service_role;
  end if;
end;
$$;
