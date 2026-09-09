-- AlexAgent v0.1 — human questions + AI usage accounting

-- ---------------------------------------------------------------------
-- agent_questions
-- ---------------------------------------------------------------------
create table agent_questions (
  id uuid primary key default gen_random_uuid(),
  brand text not null,
  question text not null,
  reason text not null,
  status text not null default 'open'
    check (status in ('open', 'answered', 'dismissed')),
  blocks_progress boolean not null default true,
  answer text,
  -- Optional linkage: what this question is about, so an answer can
  -- automatically resume the exact piece of work that was blocked.
  context_run_id uuid references agent_runs (id),
  context_plan_id uuid references marketing_plans (id),
  context_draft_id uuid references content_drafts (id),
  created_at timestamptz not null default now(),
  answered_at timestamptz
);

create index agent_questions_brand_status_idx on agent_questions (brand, status);

alter table content_drafts
  add constraint content_drafts_blocked_on_question_fk
  foreign key (blocked_on_question_id) references agent_questions (id);

-- ---------------------------------------------------------------------
-- ai_usage
-- ---------------------------------------------------------------------
create table ai_usage (
  id uuid primary key default gen_random_uuid(),
  agent_run_id uuid references agent_runs (id),
  brand text not null,
  operation text not null check (operation in ('planner', 'executor')),
  model text not null,
  input_tokens integer not null default 0,
  cached_input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  estimated_cost_usd numeric(10,6) not null default 0,
  created_at timestamptz not null default now()
);

-- created_at is a plain btree index; monthly-spend aggregation (global
-- budget, not per-brand — spec section 20) queries a created_at range,
-- since date_trunc(timestamptz) is not IMMUTABLE and can't back an index.
create index ai_usage_created_at_idx on ai_usage (created_at);
create index ai_usage_run_idx on ai_usage (agent_run_id);
