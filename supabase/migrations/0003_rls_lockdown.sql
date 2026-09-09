-- AlexAgent v0.1 — RLS lockdown
--
-- All application access to these tables goes through server-side route
-- handlers using the Supabase service-role key (see lib/supabase/admin.ts).
-- Enabling RLS with no policies denies the anon/authenticated keys by
-- default; the service role bypasses RLS entirely, so this does not affect
-- the app but prevents accidental exposure if a browser-side client is
-- ever pointed at these tables.

alter table agent_settings enable row level security;
alter table agent_runs enable row level security;
alter table marketing_plans enable row level security;
alter table content_drafts enable row level security;
alter table content_revisions enable row level security;
alter table agent_questions enable row level security;
alter table ai_usage enable row level security;
