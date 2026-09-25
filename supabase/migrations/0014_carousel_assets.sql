-- AlexAgent — Instagram carousel assets (v1).
--
-- A carousel version is ONE content_assets row (format = 'carousel'),
-- exactly like an image_post version: one row = one approve_asset email
-- token = one approve_asset_if_current() decision = one
-- asset_publications (asset_id, channel) claim. Its ordered slide images
-- live in the new `slides` jsonb array — position order in that array is
-- authoritative for generation, the review email and publication. For a
-- carousel, `storage_path` points at slide 1 (a preview-compatible
-- image); for image_post rows `slides` stays '[]' and nothing changes.
--
-- Additive only: no backfill, no change to any existing row.

alter table content_assets
  drop constraint content_assets_format_check;
alter table content_assets
  add constraint content_assets_format_check
    check (format in ('image_post', 'carousel'));

alter table content_assets
  add column slides jsonb not null default '[]'::jsonb;

alter table content_assets
  add constraint content_assets_slides_is_array
    check (jsonb_typeof(slides) = 'array');
