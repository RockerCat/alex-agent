-- Widens asset_publications.channel to also accept 'instagram',
-- preparing the existing generic publication persistence model
-- (claim/reclaim/idempotency via the (asset_id, channel) unique
-- constraint from 0006_asset_publications.sql) for a second publish
-- channel. This migration only widens what the row can *record* — it
-- does not add an Instagram client, publishing action, or UI; those
-- ship in a later checkpoint.
--
-- Additive: drops and recreates only the CHECK constraint (auto-named
-- asset_publications_channel_check by 0006, confirmed via
-- pg_get_constraintdef before writing this). No column change, no data
-- migration — existing 'facebook' rows satisfy the new constraint
-- unchanged, and the (asset_id, channel) unique constraint, statuses,
-- and timestamps are untouched.
alter table asset_publications
  drop constraint asset_publications_channel_check;

alter table asset_publications
  add constraint asset_publications_channel_check
    check (channel in ('facebook', 'instagram'));
