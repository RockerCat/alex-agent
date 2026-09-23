-- AlexAgent — Email HITL Phase 2B: atomic exact-version asset approval.
--
-- A version-bound approval (e.g. an "Aprobar imagen" email link for asset
-- version N) must succeed only if, AT MUTATION TIME, the exact asset
-- still exists, belongs to the expected draft, is still pending_review,
-- IS version N, and is still the newest asset row for that draft. Doing
-- the "newest" check in application code and then updating is a
-- check-then-update race; this function makes the whole predicate one
-- serialized database operation. It is called only by lib/agent/
-- assetGenerator.ts's approveAsset() when a version guard is supplied —
-- the existing unguarded dashboard path is unchanged.
--
-- Why the draft-row lock: under READ COMMITTED a NOT EXISTS subquery
-- alone cannot see a newer asset inserted by a concurrent, not-yet-
-- committed transaction. Every content_assets INSERT takes FOR KEY SHARE
-- on its parent content_drafts row (the draft_id foreign-key check), and
-- FOR KEY SHARE conflicts with FOR UPDATE. Taking FOR UPDATE on the draft
-- first therefore (a) waits for any in-flight asset insert for this
-- draft to commit, whose row the following UPDATE statement — which takes
-- a fresh snapshot — then sees; and (b) makes any later insert wait
-- until this approval commits, i.e. it is serialized after the approval.
--
-- "Newest" deliberately counts ANY newer asset row for the draft
-- (including a failed generation attempt), matching the app's existing
-- "latest row = current candidate" semantics (getLatestAsset) — an older
-- asset is never approvable once anything newer exists.
--
-- Returns the approved asset's id, or NULL when nothing was approved
-- (the caller re-reads only to explain why; it never decides on that read).

create or replace function public.approve_asset_if_current(
  p_asset_id uuid,
  p_draft_id uuid,
  p_expected_asset_version integer
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_approved_id uuid;
begin
  perform 1 from content_drafts where id = p_draft_id for update;
  if not found then
    return null;
  end if;

  update content_assets a
     set status = 'ready_to_publish',
         approved_at = now()
   where a.id = p_asset_id
     and a.draft_id = p_draft_id
     and a.asset_version = p_expected_asset_version
     and a.status = 'pending_review'
     and not exists (
       select 1
         from content_assets newer
        where newer.draft_id = p_draft_id
          and newer.asset_version > p_expected_asset_version
     )
  returning a.id into v_approved_id;

  return v_approved_id;
end;
$$;

-- Functions are executable by PUBLIC by default, and Supabase's default
-- privileges also grant EXECUTE on new public functions to anon/
-- authenticated. This must be callable only by the server-side
-- service_role client, same posture as every table here (RLS on, zero
-- policies, service_role-only grants). Role-guarded so this is a safe
-- no-op for roles that don't exist in local/pglite validation.
revoke all on function public.approve_asset_if_current(uuid, uuid, integer) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.approve_asset_if_current(uuid, uuid, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.approve_asset_if_current(uuid, uuid, integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.approve_asset_if_current(uuid, uuid, integer) to service_role;
  end if;
end;
$$;
