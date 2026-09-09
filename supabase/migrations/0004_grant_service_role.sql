-- AlexAgent v0.1 — persist the service_role table grants
--
-- On a hosted Supabase project created with "Automatically expose new
-- tables" disabled, tables created by SQL migrations do not receive the
-- grants Supabase normally provisions automatically. That left even
-- service_role without table privileges, so the first live run failed
-- with:
--
--   permission denied for table agent_settings
--
-- This app's design already denies anon/authenticated any direct table
-- access (see 0003_rls_lockdown.sql — RLS enabled, zero policies); all
-- reads/writes happen server-side through the service-role client
-- (lib/supabase/admin.ts). service_role bypasses RLS but still needs the
-- underlying GRANTs to touch these tables at all, hence this migration.
--
-- `service_role` (and `anon`/`authenticated`) are Supabase platform roles
-- that don't exist in a vanilla/local Postgres (e.g. the pglite instance
-- used by scripts/check-migrations.mjs) — guard on pg_roles so this
-- migration is a safe no-op there and only takes effect against a real
-- Supabase project.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      public.agent_settings,
      public.agent_runs,
      public.marketing_plans,
      public.content_drafts,
      public.content_revisions,
      public.agent_questions,
      public.ai_usage
    TO service_role;

    -- Cover future migrations too: any table this same role creates
    -- later in the public schema is granted to service_role by default,
    -- so a forgotten grant here can't silently repeat this outage.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
  END IF;
END;
$$;
