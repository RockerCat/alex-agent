-- AlexAgent v0.2 — Facebook manual publishing (checkpoint 1)
--
-- One row per (asset, channel) publish attempt. This is the actual
-- duplicate-publication guard: a double click, refresh, or retry
-- racing to publish the same content_assets row to the same channel
-- can both attempt the INSERT below, but only one can succeed — the
-- unique constraint, not the UI, is the real boundary (mirrors the
-- agent_runs "one running per brand" / content_assets "(draft_id,
-- asset_version)" lock patterns already used in this schema).
--
-- Lifecycle: a row is inserted with status='publishing' BEFORE the
-- Meta Graph API call is made (claiming the slot), then updated to
-- 'published' (with meta_post_id/published_at) on success or 'failed'
-- on failure. A 'failed' row can be reclaimed (status flipped back to
-- 'publishing') by a manual retry; a 'publishing' or 'published' row
-- blocks a new publish attempt outright — see lib/agent/publish.ts.

create table asset_publications (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references content_assets (id) on delete cascade,
  draft_id uuid not null references content_drafts (id) on delete cascade,
  brand text not null,
  -- Facebook only in this checkpoint — deliberately not widened to
  -- match content_drafts.channel until Instagram publishing actually
  -- ships (a future migration, not a redesign here).
  channel text not null check (channel in ('facebook')),
  status text not null default 'publishing'
    check (status in ('publishing', 'published', 'failed')),
  meta_post_id text,
  published_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (asset_id, channel)
);

create index asset_publications_draft_idx on asset_publications (draft_id);

alter table asset_publications enable row level security;

-- Same pattern as 0005_content_assets.sql: service_role is the only
-- role this app ever uses to touch this table (RLS above denies
-- anon/authenticated entirely with zero policies); guarded on pg_roles
-- so this is a safe no-op against local/pglite validation.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.asset_publications to service_role;
  end if;
end;
$$;
