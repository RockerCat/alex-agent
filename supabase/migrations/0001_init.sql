-- AlexAgent v0.1 initial schema
-- Single-tenant, single-brand (SolarDesk) operational store.
-- Extensible to future brands via the `brand` text column rather than a
-- hardcoded enum, per ALEXAGENT_V0.1_SPEC.md section 2.

-- gen_random_uuid() is a core PostgreSQL 13+ function (no pgcrypto needed).

-- ---------------------------------------------------------------------
-- agent_settings
-- ---------------------------------------------------------------------
create table agent_settings (
  id uuid primary key default gen_random_uuid(),
  singleton boolean not null default true unique,
  monthly_budget_usd numeric(10,2) not null default 10.00,
  safety_reserve_usd numeric(10,2) not null default 0.50,
  per_run_budget_usd numeric(10,2) not null default 1.00,
  solardesk_enabled boolean not null default true,
  approval_policy text not null default 'ALL_CONTENT_REQUIRES_APPROVAL'
    check (approval_policy in ('ALL_CONTENT_REQUIRES_APPROVAL')),
  execution_mode text not null default 'MANUAL'
    check (execution_mode in ('MANUAL')),
  updated_at timestamptz not null default now()
);

-- Only one settings row ever exists (singleton pattern enforced by unique column above).
insert into agent_settings (singleton) values (true);

-- ---------------------------------------------------------------------
-- agent_runs
-- ---------------------------------------------------------------------
create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  brand text not null,
  kind text not null default 'marketing_cycle'
    check (kind in ('marketing_cycle', 'revision')),
  trigger text not null default 'manual'
    check (trigger in ('manual', 'scheduled', 'event')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'skipped')),
  decision text
    check (decision in (
      'CREATE_PLAN', 'CONTINUE_EXISTING_PLAN', 'WAIT_FOR_APPROVAL',
      'NO_ACTION', 'NEEDS_HUMAN_INPUT', 'PREFLIGHT_SKIP', 'BUDGET_BLOCKED'
    )),
  summary text,
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Concurrency guarantee: only one run per brand may be "running" at a time.
-- This is the actual database-backed execution lock required by the spec
-- (section 20 / 22) — not merely a disabled UI button.
create unique index agent_runs_one_active_per_brand
  on agent_runs (brand)
  where status = 'running';

create index agent_runs_brand_created_idx on agent_runs (brand, created_at desc);

-- ---------------------------------------------------------------------
-- marketing_plans
-- ---------------------------------------------------------------------
create table marketing_plans (
  id uuid primary key default gen_random_uuid(),
  brand text not null,
  period_start date not null,
  period_end date not null,
  primary_objective text not null,
  primary_objective_reason text not null,
  primary_objective_success_signal text not null,
  supporting_objectives text[] not null default '{}',
  strategy_summary text not null,
  strategy_audience text not null,
  strategy_approach text not null,
  rationale text not null,
  status text not null default 'active'
    check (status in ('active', 'completed', 'superseded')),
  created_by_run uuid references agent_runs (id),
  created_at timestamptz not null default now(),
  check (period_end > period_start)
);

create index marketing_plans_brand_status_idx on marketing_plans (brand, status);

-- At most one active plan per brand at a time — this is the deterministic
-- backbone of duplicate-plan prevention (acceptance test B).
create unique index marketing_plans_one_active_per_brand
  on marketing_plans (brand)
  where status = 'active';

-- ---------------------------------------------------------------------
-- content_drafts
-- ---------------------------------------------------------------------
create table content_drafts (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references marketing_plans (id) on delete cascade,
  brand text not null,
  created_by_run uuid references agent_runs (id),
  channel text not null check (channel in ('instagram', 'facebook')),
  content_type text not null
    check (content_type in ('carousel', 'image_post', 'story', 'caption_only')),
  purpose text not null,
  topic text not null,
  audience text not null,
  cta text not null,
  target_date date not null,
  status text not null default 'draft'
    check (status in (
      'draft', 'pending_approval', 'approved', 'revision_requested',
      'rejected', 'scheduled', 'published'
    )),
  version integer not null default 1,
  -- Current materialized content (mirrors the latest revision for fast reads).
  title text,
  hook text,
  body jsonb not null default '{}'::jsonb,
  caption text,
  cta_text text,
  visual_direction text,
  hashtags text[] not null default '{}',
  blocked_on_question_id uuid,
  approved_at timestamptz,
  rejected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index content_drafts_plan_idx on content_drafts (plan_id);
create index content_drafts_brand_status_idx on content_drafts (brand, status);

-- ---------------------------------------------------------------------
-- content_revisions
-- ---------------------------------------------------------------------
create table content_revisions (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references content_drafts (id) on delete cascade,
  version integer not null,
  -- Snapshot of the draft content at this version.
  title text,
  hook text,
  body jsonb not null default '{}'::jsonb,
  caption text,
  cta_text text,
  visual_direction text,
  hashtags text[] not null default '{}',
  -- What produced this version.
  source text not null default 'executor'
    check (source in ('executor', 'initial')),
  feedback_category text
    check (feedback_category in (
      'too_generic', 'too_promotional', 'too_long', 'too_technical',
      'wrong_tone', 'weak_hook', 'weak_cta', 'factually_incorrect',
      'visual_needs_work', 'other'
    )),
  feedback_note text,
  created_by_run uuid references agent_runs (id),
  created_at timestamptz not null default now(),
  unique (draft_id, version)
);

create index content_revisions_draft_idx on content_revisions (draft_id);

-- content_drafts.blocked_on_question_id references agent_questions(id);
-- the FK is added in 0002_questions_and_usage.sql once that table exists.
