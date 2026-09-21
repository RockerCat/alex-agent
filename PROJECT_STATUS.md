# AlexAgent — Project Status

Running record of what is actually implemented and validated, kept current as checkpoints close. Product vision lives in `AGENT.md`; the approved product north star and its invariants live in `CLAUDE.md`; the frozen v0.1 schema/behavior spec lives in `ALEXAGENT_V0.1_SPEC.md`. This file tracks *current state*, not design intent.

## Current status summary (2026-09-19)

**Completed and validated end-to-end:**
- Facebook manual `image_post` publishing (SolarDesk).
- Instagram manual `image_post` publishing (SolarDesk), including bounded media-container readiness handling before publish.

**Known limitation:** Instagram carousel publishing is not implemented.

**Next product initiative: Autonomy v1.** Intended high-level outcome (see `CLAUDE.md` for the approved product north star; no technical architecture beyond what's listed below is decided):
- scheduled agent wake-up that evaluates state rather than forcing content creation on every run;
- continued autonomous cycle/content/asset work, with `NO_ACTION` remaining a valid outcome;
- WhatsApp as the human-in-the-loop channel for approve/reject/revision-request/question-answer;
- automatic resumption of the durable agent run after a human WhatsApp response;
- publication proceeding after human approval without routine dashboard operation;
- first pilot: SolarDesk; target milestone: **"7 days without opening AlexAgent."**

**Phase 1A/1B — Autonomous Wake, live in production (SolarDesk only, closed 2026-09-20):** `GET /api/cron/marketing-cycle` (`app/api/cron/marketing-cycle/route.ts`) lets Vercel Cron invoke the existing `runMarketingCycle({ brand: "solardesk", trigger: "scheduled" })` — the same domain function the manual "Run Marketing Cycle" button already calls — without a browser session. Authenticated via Vercel Cron's native mechanism: `Authorization: Bearer <CRON_SECRET>`, matching the server-side `CRON_SECRET` env var Vercel auto-injects for a scheduled invocation; the endpoint fails closed if that secret isn't configured, and an unauthenticated request never reaches `agent_runs`, Planner, or any agent state. `vercel.json` configures the SolarDesk wake for once daily at `0 13 * * *` UTC (≈08:00 America/Bogota) — this is agent **wake** cadence only, never a publication or content-creation cadence; the runtime itself still owns no cron/posting frequency, and `NO_ACTION`/`WAIT_FOR_APPROVAL`/blocking-question/skip-on-concurrency all remain legitimate outcomes of a wake.

AlexAgent is deployed to Vercel Production from `main` (Phase 1B commit `5e606bf`), `CRON_SECRET` is configured in the production environment, and Vercel Cron is enabled and invoking the endpoint on schedule.

**First real production wake — Autonomous Wake E2E: PASS (2026-09-19, ~19:11 America/Bogota).** A real Vercel Cron invocation (`user-agent: vercel-cron/1.0`) reached `GET /api/cron/marketing-cycle`, passed firewall/middleware, authenticated via the native Bearer contract, and executed `runMarketingCycle({ brand: "solardesk", trigger: "scheduled" })` against real Supabase state, returning HTTP 200. Validated chain: Vercel Cron → native Bearer auth → production Route Handler → `runMarketingCycle` → Supabase/runtime → deterministic preflight → `WAIT_FOR_APPROVAL` → persisted activity → HTTP 200. The result was `WAIT_FOR_APPROVAL` because the active `SIGNUPS` plan already had 1 draft awaiting Alex's review — correctly, no new plan or draft was created and Planner was not invoked, exactly as the existing preflight logic is designed to behave.

**Timestamp display bug found and fixed during this validation:** Dashboard "Recent activity" rendered the persisted UTC instant using the server's timezone (via a Server Component calling `toLocaleString()` server-side) rather than the viewer's browser timezone — e.g. the production instant `2026-09-20T00:11:51Z` displayed as `9/20/2026, 12:11:51 AM` instead of the correct `9/19/2026, 7:11:51 PM` for a Colombia browser. Fixed with a small Client Component (`components/LocalDateTime.tsx`) so formatting genuinely executes in the browser; stored DB timestamps remain UTC and unchanged — this was a presentation-only bug.

**Dashboard AI spend is now brand-scoped for display (2026-09-20):** the existing `Monthly AI budget $X.XX / $10.00` figure was silently global — its `ai_usage` query filtered by month but not by `brand`, so it happened to equal SolarDesk's spend only because SolarDesk was the only brand with usage. The numerator is now brand-scoped (`BudgetGuard.getBrandMonthlySpend(brand)`); the ceiling/reserve/per-run limits and the actual budget-exhausted enforcement decision are untouched and remain global (a single shared monthly pool across every brand — `agent_settings` was not changed). The Dashboard now also shows **Today** and **Daily avg.** AI spend for SolarDesk: `Today` is brand spend since the visitor's local midnight; `Daily avg.` is brand month-to-date spend divided by elapsed local calendar days (including zero-cost days; never zero on the 1st of a month). Both are computed against the visitor's real browser-local calendar day/month, never Vercel/server UTC — the local-day/month boundaries are computed in the browser (`components/DailySpend.tsx`, same principle as `LocalDateTime`) and passed to a small server action (`getBrandSpendSummaryAction`) that sums only the already brand-scoped, already-persisted `ai_usage` cost rows; no new usage/cost records are created, no schema changed, and a deterministic wake that makes no paid AI call (e.g. `WAIT_FOR_APPROVAL`) still contributes exactly `$0.00`.

**WhatsApp outbound attention notifications — implemented, outbound only, pending Meta template approval (2026-09-20):** after `runMarketingCycle()` returns from a scheduled wake and its durable state is already finalized, `/api/cron/marketing-cycle` independently invokes `notifyAttentionIfNeeded()` (`lib/agent/notifications.ts`), which sends Alex a WhatsApp message via the Meta WhatsApp Cloud API when the wake's decision is `WAIT_FOR_APPROVAL` (a pending draft) or `NEEDS_HUMAN_INPUT` (a blocking open question). This is an adapter over the existing durable workflow, not a second approval system: it only reads `content_drafts`/`agent_questions` and sends a message describing that state — it never creates, approves, rejects, or revises anything, never causes an additional Planner call, and human editorial approval in the existing dashboard workflow remains fully authoritative and unchanged. A dedicated `notification_outbox` table (brand + channel + notification type + subject type/id/version) guarantees the same still-pending draft/question is never renotified by a later daily wake, while a genuine draft revision (a new `content_drafts.version`) is treated as a new, independently notifiable item. A WhatsApp send failure only ever marks its own outbox row `failed` — it can never fail or roll back an already-completed marketing-cycle wake — and is safely retried by a later invocation.

WhatsApp uses its own dedicated Meta credentials (`META_WHATSAPP_*` env vars) — never the Facebook/Instagram publishing tokens. A real WhatsApp Cloud API sender exists externally (registered and connected), and the message template `alexagent_attention_required` (Spanish/Colombia) has been submitted to Meta and is **awaiting approval** — no real WhatsApp send has been made or can succeed yet; all of the above is validated against a scripted fake Meta client, exactly like the existing Facebook/Instagram client test suites. Inbound WhatsApp replies, approve/reject/request-changes commands, and question-answering over WhatsApp are **not implemented** — this remains outbound-only. Next smoke step once Meta approves the template: send one real notification referencing the existing pending SolarDesk draft (no Planner call, no asset generation, no publication) to confirm end-to-end delivery.

**Current operational state:** SolarDesk now wakes autonomously once daily with no manual "Run Marketing Cycle" click required; existing deterministic preflight/runtime logic (unchanged) decides whether further action is needed on each wake. The current human bottleneck is the existing "Drafts pending approval" step — still a manual dashboard action. **Not yet implemented:** WhatsApp human-in-the-loop (approve/reject/revision/questions), automatic asset generation after content approval, automatic asset approval, automatic publication after approval, and MiPadel.Club/Odentia autonomous agents or a multi-brand scheduler/dispatcher. The next autonomy direction is moving the human interaction loop toward WhatsApp by reusing the existing domain approval/question/revision operations, not a parallel workflow — not designed or started here. The **"7 days without opening AlexAgent"** milestone has not started/completed; this is one validated wake, not a 7-day pilot.

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

## v0.2 — Manual Instagram `image_post` publishing (closed 2026-09-19)

Approved SolarDesk `image_post` drafts can now also be published to the real SolarDesk.co Instagram account, manually, from the same AlexAgent UI, alongside (and independent of) Facebook publishing:

```
Approved draft → content_asset (ready_to_publish) → explicit "Publish to Instagram"
→ explicit confirmation → server-side publish orchestration
→ Meta Graph API POST /{ig-user-id}/media → bounded container-readiness polling
→ POST /{ig-user-id}/media_publish (only once FINISHED) → real public Instagram post
→ publication record persisted → UI shows "Published to Instagram"
```

Publishing is entirely manual, same posture as Facebook: no cron, heartbeat, scheduling, or autopublish. Publishing never invokes the Planner, Executor, Visual Director, or any image generation/regeneration — it publishes exactly the already-approved image and caption, with the same shared CTA-destination caption composition used for Facebook.

**Implementation:**
- `lib/agent/instagramClient.ts` — thin server-side Instagram Graph API client. Uses the **Instagram Graph API host** (`https://graph.instagram.com`, API version `v24.0`), not the Facebook Graph API host — Instagram Login tokens are a separate API family from a Facebook Page token and are not interchangeable between hosts. Facebook publishing (`lib/agent/facebookClient.ts`) is untouched and remains independently on `https://graph.facebook.com/v26.0`.
- `lib/agent/publish.ts` (`publishAssetToInstagram`) — reuses the exact same eligibility-guard / idempotency-claim / persistence orchestration as `publishAssetToFacebook`, parametrized by channel, plus one Instagram-specific step: bounded media-container readiness polling between create and publish (see below).
- `supabase/migrations/0008_asset_publications_instagram_channel.sql` — widens the existing `asset_publications.channel` CHECK constraint to accept `'instagram'` alongside `'facebook'`; the `(asset_id, channel)` unique constraint (from `0006`) already made this a genuinely independent per-channel slot with no schema change needed. Already applied to the live Supabase project.
- `app/actions.ts` (`publishAssetToInstagramAction`) and `components/AssetPanel.tsx` — manual trigger + confirmation UI, branching by the draft's own channel (Facebook's button/copy/color are unchanged for Facebook-channel drafts).

**Auth model:** Instagram Login (Business Login) access token + Instagram User ID → server-side env (`META_INSTAGRAM_ACCESS_TOKEN`, `META_INSTAGRAM_ACCOUNT_ID`). Credentials are server-side only, never exposed to the browser, never logged, never committed.

**Media-container readiness polling** (`lib/agent/publish.ts`): Meta processes a newly-created single-image container asynchronously; publishing before it's ready is what produces a real `"Media ID is not available"` rejection. Before calling `/media_publish`, AlexAgent now polls `GET /{container-id}?fields=status_code` (fixed 1500ms interval, max 6 checks, ~7.5s added wait at most):
- `IN_PROGRESS` → wait, poll again.
- `FINISHED` → proceed to publish.
- `ERROR` / `EXPIRED` → fail immediately, no publish call.
- `PUBLISHED` → fail conservatively, never call publish again on that container.
- Malformed/unrecognized status, or exhausting all attempts still `IN_PROGRESS` → fail safely with a typed error.

**Idempotency / failure semantics:** identical guarantees to Facebook (see above), independently per `(asset_id, channel)` — a Facebook publication for an asset never blocks an Instagram publication for the same asset, and vice versa. Any readiness-polling failure or timeout flows through the same `markPublicationFailed` path as a create/publish rejection, so the slot remains safely reclaimable on retry.

**Current format support:** `image_post` only. Instagram carousel publishing is **not implemented** — real Planner-generated Instagram carousel content exists, but publishing it is separate future work; the Planner itself was not changed to force image-only output.

**Live smoke — PASS (2026-09-19):** Publishing a controlled approved Instagram `image_post` asset through the real AlexAgent UI produced a real, public post on the SolarDesk.co Instagram account, independently confirmed visible on the account, and AlexAgent correctly persisted the publication and showed "Published to Instagram."

**Root causes found and fixed during this checkpoint's smoke:** (1) the originally configured Instagram account identifier did not match the Instagram User ID associated with the configured Instagram Login token — corrected in server-side env configuration; (2) the client originally called the Facebook Graph API host, which an Instagram Login token cannot authenticate against (`OAuthException` code 190) — corrected to the Instagram Graph API host; (3) the missing readiness polling described above.

**Out of scope for this checkpoint** (future work): Instagram carousel/Stories/Reels publishing, scheduled/automated publishing, token rotation automation, cross-channel performance/engagement signal back into Planner context. See the current status summary above for the next product initiative (Autonomy v1).

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
