-- AlexAgent v0.2 — first vertical slice: manual image_post asset lifecycle
--
-- One row per generation ATTEMPT (success or failure) for a given
-- content_drafts row. asset_version is monotonic per draft and never
-- reused — regeneration always inserts a new row, never overwrites an
-- existing one, so history (including failed attempts) is never lost.
-- The current "candidate" for a draft is simply the row with the
-- highest asset_version — no separate "is_current" flag is needed.

create table content_assets (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references content_drafts (id) on delete cascade,
  brand text not null,
  asset_version integer not null,
  -- Snapshot of content_drafts.version at generation time, so a
  -- generated asset always traces back to the exact approved content
  -- it was rendered from, even if that draft could somehow change later.
  source_draft_version integer not null,
  status text not null
    check (status in ('pending_review', 'ready_to_publish', 'generation_failed')),
  format text not null default 'image_post'
    check (format in ('image_post')),
  width integer,
  height integer,
  mime_type text not null default 'image/png',
  storage_bucket text,
  storage_path text,
  -- Enough to reproduce/debug the render: which logo file, which
  -- deterministic layout variant, font sizes chosen by the fit/wrap
  -- algorithm, which draft fields were used as source text. Never
  -- model chain-of-thought — there is no model call in this path.
  render_provenance jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  -- The actual concurrency guarantee: two requests racing to create
  -- "the next version" for the same draft can both compute the same
  -- next number, but only one INSERT can succeed here. The loser gets
  -- a real unique-violation, not a silently overwritten/duplicated
  -- "current" row.
  unique (draft_id, asset_version)
);

create index content_assets_draft_idx on content_assets (draft_id);
create index content_assets_brand_status_idx on content_assets (brand, status);

alter table content_assets enable row level security;

-- Same pattern as 0004_grant_service_role.sql: service_role is the only
-- role this app ever uses to touch this table (RLS above denies
-- anon/authenticated entirely with zero policies); guarded on pg_roles
-- so this is a safe no-op against local/pglite validation.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.content_assets to service_role;
  end if;
end;
$$;

-- Private Storage bucket for generated asset files. Supabase manages
-- buckets through the storage.buckets catalog table, which is why this
-- can be a committed migration rather than an undocumented dashboard
-- change. Guarded on the storage schema existing, since it is a
-- Supabase platform schema not present in local/pglite validation.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public)
    values ('solardesk-assets', 'solardesk-assets', false)
    on conflict (id) do nothing;
  end if;
end;
$$;
