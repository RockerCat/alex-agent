# AlexAgent — Guidance for Claude Code

Project-specific guidance for working in this repository. Product mission and the current Autonomy Model live in `AGENT.md`; the frozen v0.1 schema/behavior spec lives in `ALEXAGENT_V0.1_SPEC.md`; current implemented/validated state lives in `PROJECT_STATUS.md`. This file exists to record durable product direction and invariants that future development in this repo must preserve — not implementation detail.

## Product north star (approved direction, 2026-09-19)

AlexAgent's approved end-state is a **persistent, per-brand autonomous marketing agent** — not a tool Alex has to routinely open and drive by hand. Initial brands, in rollout order:

1. **SolarDesk** — first pilot; existing AlexAgent workflow and real Facebook/Instagram publishing are already validated here.
2. **MiPadel.Club** — configured only after the model is proven on SolarDesk.
3. **Odentia** — configured only after MiPadel.Club.

Each brand's agent is expected to wake on a regular schedule, evaluate current marketing state, and decide autonomously whether action is needed — the scheduler's job is only to wake the agent, never to dictate that a publication must be produced on a given run. `NO_ACTION` remains a fully valid, expected outcome of every wake. Marketing strategy stays agent-driven, not cron-driven.

**Product isolation between brands is required.** Brands share AlexAgent's infrastructure/code, never product truth: credentials, business rules, and brand context must not be copied or leaked between SolarDesk, MiPadel.Club, and Odentia just because they run on the same platform.

## WhatsApp as the intended primary human-in-the-loop interface

The intended end-state is that Alex's routine involvement happens over WhatsApp instead of the AlexAgent dashboard: reviewing a proposed publication (including its generated content) and responding approve / reject / request changes; requested changes eventually feeding the existing revision workflow; and any genuine factual/human-input question AlexAgent has being asked (and answered) over WhatsApp, resuming the durable agent run. This is product direction, not a shipped feature — WhatsApp provider, webhook design, message protocol, and persistence architecture are all future decisions, not yet made.

## Initial autonomy boundary

The first autonomy model preserves human editorial approval before anything publishes. AlexAgent may autonomously wake, evaluate state, reason, manage cycles, create drafts, generate assets, and perform safe deterministic processing/retries — but approving a publication, rejecting it, requesting editorial changes, and answering genuine human/factual questions remain Alex's responsibility. Only after human approval may future autonomy design let publication proceed automatically. Broader policies (e.g. fully automatic publication of some content categories without per-post approval) are not part of the currently approved model and are not to be implemented under this section's authority.

## Success milestone: "7 days without opening AlexAgent"

The first operational autonomy target: for a continuous 7-day SolarDesk pilot period, routine marketing operation is handled by the autonomous agent plus WhatsApp human-in-the-loop interaction, with no need for Alex to open the AlexAgent dashboard for normal operation. Opening the app for development or debugging during that window does not itself invalidate the milestone — the target is about normal operation, not about the app being technically reachable.

This is a target, not a claim that it has been achieved. Do not describe Autonomy v1, WhatsApp integration, or scheduled autonomous wake-up as implemented until `PROJECT_STATUS.md` records them as such.
