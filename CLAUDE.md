# AlexAgent — Guidance for Claude Code

Project-specific guidance for working in this repository. Product mission and the current Autonomy Model live in `AGENT.md`; the frozen v0.1 schema/behavior spec lives in `ALEXAGENT_V0.1_SPEC.md`; current implemented/validated state lives in `PROJECT_STATUS.md`. This file exists to record durable product direction and invariants that future development in this repo must preserve — not implementation detail.

## Product north star (approved direction, 2026-09-19)

AlexAgent's approved end-state is a **persistent, per-brand autonomous marketing agent** — not a tool Alex has to routinely open and drive by hand. Initial brands, in rollout order:

1. **SolarDesk** — first pilot; existing AlexAgent workflow and real Facebook/Instagram publishing are already validated here.
2. **MiPadel.Club** — configured only after the model is proven on SolarDesk.
3. **Odentia** — configured only after MiPadel.Club.

Each brand's agent is expected to wake on a regular schedule, evaluate current marketing state, and decide autonomously whether action is needed — the scheduler's job is only to wake the agent, never to dictate that a publication must be produced on a given run. `NO_ACTION` remains a fully valid, expected outcome of every wake. Marketing strategy stays agent-driven, not cron-driven.

**Product isolation between brands is required.** Brands share AlexAgent's infrastructure/code, never product truth: credentials, business rules, and brand context must not be copied or leaked between SolarDesk, MiPadel.Club, and Odentia just because they run on the same platform.

## Current SolarDesk wake implementation

SolarDesk's autonomous wake runs on **Vercel Cron** today: `GET /api/cron/marketing-cycle`, authenticated with Vercel's native contract (`Authorization: Bearer <CRON_SECRET>`, a server-only env var), scheduled via `vercel.json` to wake once daily (`0 13 * * *` UTC). This scheduler cadence wakes the agent only — it must never be read as, or made to imply, a required content-creation or publication cadence. The route is adaptor code only: it authenticates the caller and forwards to the existing `runMarketingCycle({ brand, trigger: "scheduled" })` domain entry point, the same one the manual "Run Marketing Cycle" button calls. All lock/preflight/Budget Guard/`NO_ACTION`/`WAIT_FOR_APPROVAL` semantics live in that domain function and remain authoritative — future scheduler or multi-brand work must keep reusing that entry point rather than building parallel orchestration around it.

Stored timestamps remain UTC. Any user-facing presentation that needs local time must render in the *browser's* timezone (a Client Component), never the server/Vercel runtime's timezone.

**AI usage ledger is brand-attributed; spend reporting must remain brand-scoped while the current Budget Guard ceiling remains global.** Every `ai_usage` row already carries the real `brand` it belongs to. Per-brand spend *display* (e.g. a Dashboard's monthly/Today/Daily-avg figures) must filter by that brand. Budget *enforcement* (the monthly effective-stop/per-run check that actually blocks a paid call) must stay a single shared pool across every brand, as it is today — do not make enforcement per-brand without an explicit product decision to do so.

## WhatsApp as the intended primary human-in-the-loop interface

The intended end-state is that Alex's routine involvement happens over WhatsApp instead of the AlexAgent dashboard: reviewing a proposed publication (including its generated content) and responding approve / reject / request changes; requested changes eventually feeding the existing revision workflow; and any genuine factual/human-input question AlexAgent has being asked (and answered) over WhatsApp, resuming the durable agent run. **WhatsApp Inbound Phase 1 (deterministic `aprobar`/`rechazar` only) is implemented** — see `PROJECT_STATUS.md` for current status. **Still future direction, not yet built:** answering a blocking agent question from WhatsApp, requesting revisions from WhatsApp, publishing from WhatsApp, and any free-form/conversational interpretation of a reply (no LLM is involved in Phase 1's command handling).

**Outbound attention notifications, delivery-status diagnostics, and inbound approve/reject are all implemented** (`lib/agent/notifications.ts`, `lib/agent/whatsappClient.ts`, `lib/agent/whatsappWebhook.ts`, `lib/agent/whatsappInboundCommands.ts` — see `PROJECT_STATUS.md` for current validated state). Durable invariants that implementation, and any future WhatsApp work, must preserve:
- WhatsApp is an **adapter over the existing durable `content_drafts`/`agent_questions` workflow, never a second approval system** — an inbound command must call the *existing* `approveDraft`/`rejectDraft` (`lib/agent/approvals.ts`) verbatim, never reimplement their status guard or SQL mutation; human editorial approval in the existing dashboard workflow stays equally authoritative regardless of which channel triggered it.
- WhatsApp has its own dedicated Meta credentials (`META_WHATSAPP_*`) — never reuse the Facebook Page or Instagram Login tokens; each Meta capability in this app is credential-isolated (see the Facebook/Instagram clients).
- Notification idempotency (outbound) is keyed by **subject identity + version** (e.g. `brand + draft_id + draft.version` for a draft, a stable version for a question), never by `agent_run_id` — a new daily wake observing the same unresolved item must never re-notify, while a genuine revision must be able to notify again. Inbound idempotency is keyed by **Meta's own inbound message id** (`whatsapp_inbound_events`, claimed before any mutation) — a webhook retry must never double-process or double-confirm a command.
- A provider/notification failure must never mutate draft/question state and must never fail or roll back an already-completed marketing-cycle wake. Symmetrically, a WhatsApp confirmation-send failure must never roll back an already-committed approve/reject mutation.
- The webhook receives both outbound delivery-status callbacks and inbound messages at the **same physical URL** (Meta only allows one callback URL per app) — that's unavoidable, not a design choice. What must stay separated is the *domain logic*: `lib/agent/whatsappWebhook.ts`'s outbound-diagnostics functions (`parseStatusEvents`/`recordProviderStatus`) and inbound-parsing functions (`parseInboundMessages`/`resolveDraftForInboundCommand`) are independent, and the actual command mutation/confirmation-sending lives only in `lib/agent/whatsappInboundCommands.ts` — never fold inbound mutation logic into the diagnostics functions or vice versa.
- Every inbound POST must pass Meta's `X-Hub-Signature-256` signature check (keyed by `META_WHATSAPP_APP_SECRET`) **before** any parsing or DB/workflow operation — this applies uniformly to every POST, including outbound status callbacks. This became a hard requirement (not optional) the moment a POST could trigger a real draft mutation.
- Inbound command parsing is **deterministic exact-match only** (`aprobar`/`rechazar`, normalized for trim/case/accents) — no LLM, no fuzzy matching, no additional aliases without a deliberate product decision. Draft correlation for an inbound command must **fail safe, never guess**: prefer Meta's reply-context id (`context.id` → `notification_outbox.provider_message_id`); the no-context fallback only proceeds when exactly one `pending_approval` draft exists — zero or multiple candidates must mutate nothing.

## Initial autonomy boundary

The first autonomy model preserves human editorial approval before anything publishes. AlexAgent may autonomously wake, evaluate state, reason, manage cycles, create drafts, generate assets, and perform safe deterministic processing/retries — but approving a publication, rejecting it, requesting editorial changes, and answering genuine human/factual questions remain Alex's responsibility. Only after human approval may future autonomy design let publication proceed automatically. Broader policies (e.g. fully automatic publication of some content categories without per-post approval) are not part of the currently approved model and are not to be implemented under this section's authority.

## Success milestone: "7 days without opening AlexAgent"

The first operational autonomy target: for a continuous 7-day SolarDesk pilot period, routine marketing operation is handled by the autonomous agent plus WhatsApp human-in-the-loop interaction, with no need for Alex to open the AlexAgent dashboard for normal operation. Opening the app for development or debugging during that window does not itself invalidate the milestone — the target is about normal operation, not about the app being technically reachable.

This is a target, not a claim that it has been achieved. Do not describe Autonomy v1, WhatsApp integration, or scheduled autonomous wake-up as implemented until `PROJECT_STATUS.md` records them as such.
