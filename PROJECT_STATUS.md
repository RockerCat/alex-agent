# AlexAgent — Project Status

Running record of what is actually implemented and validated, kept current as checkpoints close. Product vision lives in `AGENT.md`; the frozen v0.1 schema/behavior spec lives in `ALEXAGENT_V0.1_SPEC.md`. This file tracks *current state*, not design intent.

## v0.2 — Manual Facebook `image_post` publishing (closed 2026-09-16)

Approved SolarDesk `image_post` drafts can now be published to the real SolarDesk.co Facebook Page, manually, from the AlexAgent UI:

```
Approved draft → content_asset (ready_to_publish) → explicit "Publish to Facebook"
→ explicit confirmation → server-side publish orchestration
→ Meta Graph API POST /{page-id}/photos → real public Facebook post
→ publication record persisted → UI shows "Published to Facebook"
```

Publishing is entirely manual — there is no cron, heartbeat, scheduling, or autopublish anywhere in the app. Publishing never invokes the Planner, Executor, Visual Director, or any image generation/regeneration; it publishes exactly the already-approved image and caption.

**Implementation:**
- `lib/agent/facebookClient.ts` — thin server-side Meta Graph API client (`v26.0`, `POST /{page-id}/photos`, multipart `FormData`/`Blob`).
- `lib/agent/publish.ts` — orchestration: eligibility guards, idempotency claim, Meta call, persistence.
- `supabase/migrations/0006_asset_publications.sql` — `asset_publications` table, unique on `(asset_id, channel)`.
- `app/actions.ts` (`publishAssetToFacebookAction`) and `components/AssetPanel.tsx` — manual trigger + confirmation UI.

**Auth model:** Meta Business System User `AlexAgent` → System User authorization → SolarDesk.co Page Access Token → server-side env (`META_FACEBOOK_PAGE_ACCESS_TOKEN`, `META_FACEBOOK_PAGE_ID`) → Graph API Page publishing. Credentials are server-side only, never exposed to the browser, never logged, never committed.

**Idempotency / failure semantics** (`lib/agent/publish.ts`):
- Publication identity is unique per `(asset_id, channel)` — enforced by the DB, not the UI.
- A publish attempt claims that slot *before* calling Meta, so a double click/refresh/retry can't create two Page posts.
- An already-`published` asset can't be published again.
- A `publishing` row is treated conservatively as uncertain (never silently retried).
- A `failed` row (no real Facebook post resulted) can be safely reclaimed and retried.
- If Meta creates the post but the local persistence update then fails, AlexAgent does **not** retry Meta automatically — it surfaces the real Meta post ID for manual reconciliation, to avoid ever risking a duplicate post.

**Database:** migration `0006_asset_publications.sql` has been applied to the live Supabase project; local `0001`–`0006` were confirmed to match remote.

**Live smoke — PASS (2026-09-16):** Publishing an approved v6 SolarDesk asset ("De la cotización a una propuesta lista para presentar") through the real AlexAgent UI produced a real, public post on the SolarDesk.co Facebook Page with the expected image and caption, and AlexAgent correctly persisted the publication and showed "Published to Facebook" with the Publish action no longer available for that asset.

**Root cause of earlier failed smoke attempts:** Not `FormData`/`Blob`/multipart serialization, not invalid PNG bytes, not missing `pages_manage_posts`, not the `/photos` endpoint choice. The actual cause was that `.env.local` held a `META_FACEBOOK_PAGE_ACCESS_TOKEN` value different from the Page Access Token already validated manually against Meta — confirmed by comparing SHA-256 hashes without exposing either token. Correcting the local credential to the validated token and restarting Next.js resolved it. (`lib/env.ts` also trims both Facebook env values now, as harmless defensive credential hygiene — that trim was not the fix for this incident.)

**Out of scope for this checkpoint** (future work): Instagram publishing, carousel publishing, scheduled/automated publishing, token rotation automation, additional Meta permissions.

## v0.2 — Deterministic marketing-cycle expiry (closed 2026-09-16)

**Bug discovered during the real 2026-09-16 manual `Run Marketing Cycle` smoke:** a marketing plan's `status` never left `'active'` once created — no code path transitioned it to `completed`/`superseded`, even after its `period_end` had passed. An expired plan would have stayed the apparent "current cycle" forever, permanently blocking `CREATE_PLAN` for that brand until someone manually edited the database.

**Fix:** expiry is a deterministic calendar fact, decided by application code, never by the Planner (no new Planner decision was added):
- `runMarketingCycle` (`lib/agent/runtime.ts`) now resolves `todayIso` first (real UTC calendar date in production; injectable for tests) and, before loading the state the Planner will reason over, completes any `active` plan for the brand whose `period_end < todayIso`. This runs on every manual `Run Marketing Cycle`, independent of what the Planner ends up deciding.
- Exact boundary semantics: `period_end === today` → the plan is still active for that entire calendar day (this matches the real 2026-09-16 run, where the Planner correctly saw the plan as active and returned `NO_ACTION`). `period_end < today` → the plan is completed before the Planner is invoked for that run.
- `lib/agent/planValidator.ts` additionally rejects `CONTINUE_EXISTING_PLAN` against an already-expired plan as defense in depth (the runtime's own completion step should always prevent this from arising in practice).
- The Planner is never forced toward `CREATE_PLAN` after an expired plan is closed — `NO_ACTION`, `NEEDS_HUMAN_INPUT`, or a new `CREATE_PLAN` all remain valid, existing-rules-governed outcomes. Overlapping active plans remain impossible (unchanged DB unique index + existing validator guard).
- A completed plan's own strategy/objective/content/drafts/history are left untouched — only its `status` changes.
- **Fails closed:** expired-plan completion is required before Planner reasoning, not best-effort. If that persistence step itself errors, the Marketing Cycle run fails safely through the existing failure path — it never proceeds to load context or call the Planner over potentially stale active-plan state. A later manual retry attempts the same deterministic transition again.

**Still a separate, unaddressed capability:** cross-cycle learning. Publication records, draft outcomes, and any real Meta engagement/performance metrics are still not part of Planner context — closing an expired cycle lets AlexAgent *start* a new one correctly, but gives it no performance signal from the previous one. This remains explicit future work, not part of this fix.
