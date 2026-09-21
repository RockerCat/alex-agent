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

The intended end-state is that Alex's routine involvement happens over WhatsApp instead of the AlexAgent dashboard: reviewing a proposed publication (including its generated content) and responding approve / reject / request changes; requested changes eventually feeding the existing revision workflow; and any genuine factual/human-input question AlexAgent has being asked (and answered) over WhatsApp, resuming the durable agent run. Inbound handling (webhooks, approve/reject/question commands) is still future direction, not yet built — WhatsApp provider, webhook design, message protocol, and persistence architecture for that side are not yet decided.

**Outbound-only attention notifications are implemented** (`lib/agent/notifications.ts`, `lib/agent/whatsappClient.ts` — see `PROJECT_STATUS.md` for current external/template status). Durable invariants that implementation, and any future WhatsApp work, must preserve:
- WhatsApp is an **adapter over the existing durable `content_drafts`/`agent_questions` workflow, never a second approval system** — it only reads that state and sends a message; it must never itself create, approve, reject, or revise anything, and human editorial approval in the existing dashboard workflow stays authoritative.
- WhatsApp has its own dedicated Meta credentials (`META_WHATSAPP_*`) — never reuse the Facebook Page or Instagram Login tokens; each Meta capability in this app is credential-isolated (see the Facebook/Instagram clients).
- Notification idempotency is keyed by **subject identity + version** (e.g. `brand + draft_id + draft.version` for a draft, a stable version for a question), never by `agent_run_id` — a new daily wake observing the same unresolved item must never re-notify, while a genuine revision must be able to notify again.
- A provider/notification failure must never mutate draft/question state and must never fail or roll back an already-completed marketing-cycle wake.

## Initial autonomy boundary

The first autonomy model preserves human editorial approval before anything publishes. AlexAgent may autonomously wake, evaluate state, reason, manage cycles, create drafts, generate assets, and perform safe deterministic processing/retries — but approving a publication, rejecting it, requesting editorial changes, and answering genuine human/factual questions remain Alex's responsibility. Only after human approval may future autonomy design let publication proceed automatically. Broader policies (e.g. fully automatic publication of some content categories without per-post approval) are not part of the currently approved model and are not to be implemented under this section's authority.

## Success milestone: "7 days without opening AlexAgent"

The first operational autonomy target: for a continuous 7-day SolarDesk pilot period, routine marketing operation is handled by the autonomous agent plus WhatsApp human-in-the-loop interaction, with no need for Alex to open the AlexAgent dashboard for normal operation. Opening the app for development or debugging during that window does not itself invalidate the milestone — the target is about normal operation, not about the app being technically reachable.

This is a target, not a claim that it has been achieved. Do not describe Autonomy v1, WhatsApp integration, or scheduled autonomous wake-up as implemented until `PROJECT_STATUS.md` records them as such.
