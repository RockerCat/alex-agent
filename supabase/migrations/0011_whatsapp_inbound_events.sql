-- AlexAgent — WhatsApp Inbound Phase 1: durable idempotency for inbound
-- approve/reject commands (see lib/agent/whatsappInboundCommands.ts,
-- app/api/webhooks/whatsapp/route.ts).
--
-- One row per inbound Meta message id. This is the actual duplicate-
-- processing guard: Meta's webhook delivery is at-least-once (it retries
-- on a non-2xx response, and can occasionally redeliver), so a retried
-- "aprobar"/"rechazar" must never be allowed to reach the authoritative
-- approveDraft/rejectDraft mutation a second time, and must never send a
-- second WhatsApp confirmation for the same command. The unique
-- constraint below — not application logic alone — is the real boundary,
-- same claim-before-mutation pattern as notification_outbox
-- (0009_notification_outbox.sql) and asset_publications
-- (0006_asset_publications.sql).
--
-- Deliberately does NOT store: the sender/destination phone number (see
-- CLAUDE.md's WhatsApp invariants — never persist that beyond what's
-- already in env config), or the raw inbound message text (only the
-- recognized command, if any, is kept). This is an idempotency/audit
-- record, not a message log, and is never read by any workflow decision
-- outside this module — it does not become a second approval state
-- machine.

create table whatsapp_inbound_events (
  id uuid primary key default gen_random_uuid(),
  provider_message_id text not null unique,
  command text check (command in ('aprobar', 'rechazar')),
  resolved_draft_id uuid references content_drafts (id),
  -- 'processing' is the initial claimed-but-not-yet-resolved state
  -- (inserted first, same pending-then-finalize shape as
  -- notification_outbox.status) — every other value is a terminal
  -- outcome the row is updated to once processing completes.
  outcome text not null default 'processing' check (outcome in (
    'processing',
    'approved',
    'rejected',
    'state_guard_failed',
    'unsupported_command',
    'no_candidate',
    'ambiguous_candidates',
    'unresolved_context',
    'unauthorized_sender'
  )),
  created_at timestamptz not null default now()
);

alter table whatsapp_inbound_events enable row level security;

-- Same pattern as 0009_notification_outbox.sql: service_role is the only
-- role this app ever uses to touch this table (RLS above denies
-- anon/authenticated entirely with zero policies); guarded on pg_roles
-- so this is a safe no-op against local/pglite validation.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.whatsapp_inbound_events to service_role;
  end if;
end;
$$;
