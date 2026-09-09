# AlexAgent v0.1 — Implementation Specification

**Version:** 0.1  
**Status:** Approved for implementation  
**Pilot brand:** SolarDesk  
**Owner:** Alex Sosa  

## 1. Product Goal

AlexAgent v0.1 must demonstrate that an AI agent can autonomously manage SolarDesk's initial marketing cycle without Alex specifying what content to produce.

The expected operating model is:

```text
Alex
 │
 │ Run Marketing Cycle
 ▼
AlexAgent
 │
 ├─ understands SolarDesk
 ├─ reviews current operational state
 ├─ determines what marketing needs attention
 ├─ selects an objective
 ├─ defines a strategy
 ├─ decides appropriate marketing actions
 ├─ creates drafts
 └─ requests human intervention only when required
           │
           ▼
          Alex
       ┌────┼─────┐
    Approve Revise Reject
```

The manual Run Marketing Cycle action is temporary. The architecture must allow it to be replaced later by scheduled and event-driven execution.

The v0.1 success criterion is:

> SolarDesk has a valid brand context and no active marketing plan. Alex runs the marketing cycle without providing a content prompt. AlexAgent independently determines what marketing work is appropriate for the next seven days and prepares the necessary drafts for approval.

---

## 2. Scope

### Authorized brand

v0.1 supports **SolarDesk only**.

AlexAgent uses:

```text
/AGENT.md
/brands/solardesk/BRAND.md
```

### Strict context boundary

AlexAgent belongs exclusively to Alex's personal-project environment.

It must not access, retrieve, infer, store, or use corporate/work context, including Techtivo, JIRITA, MARKO, LendingPoint, corporate repositories, credentials, documentation, communications, or infrastructure.

Odentia and Mi Padel Club are also not part of the v0.1 implementation scope. Their future addition must not influence the SolarDesk pilot architecture beyond avoiding unnecessary single-brand hardcoding where simple extensibility is possible.

---

## 3. Technology Stack

```text
Frontend
├── Next.js 16
├── React 19
├── TypeScript
└── Tailwind CSS

Backend
├── Next.js server routes/actions
└── Custom TypeScript agent runtime

Persistence / Authentication
└── Supabase
    ├── PostgreSQL
    └── Auth

AI
├── OpenAI Responses API
└── Zod + Structured Outputs

Hosting
└── Vercel
```

Do not introduce LangChain, Make, n8n, Temporal, a multi-agent framework, or additional infrastructure in v0.1 unless an implementation blocker makes it strictly necessary and Alex approves the change.

---

## 4. Agent Architecture

AlexAgent is one agent with two internal AI phases, not a multi-agent system.

```text
Context Loader
      ↓
Preflight
      ↓
Planner
      ↓
Plan Validator
      ↓
Executor
      ↓
Draft Validator
      ↓
Persistence
      ↓
Approval
```

### Planner

The Planner decides:

```text
WHY
Objective
   ↓
HOW
Strategy
   ↓
WHAT
Marketing actions
   ↓
OUTPUT REQUIREMENTS
Content briefs
```

It decides whether marketing work is required at all.

### Executor

The Executor does not independently redefine strategy.

It receives validated content briefs from the runtime and materializes them into structured content drafts.

---

## 5. AI Models

Initial configuration:

```text
Planner
GPT-5.6 Sol
Reasoning effort: medium

Executor
GPT-5.6 Luna
```

Model selection must be configurable server-side.

GPT-5.6 Luna is the initial Executor choice, not a permanent architectural requirement. If content quality is insufficient, another model may be selected without redesigning the runtime.

The OpenAI API key must remain server-side and must never be exposed through a `NEXT_PUBLIC_*` environment variable or browser request.

---

## 6. Marketing Cycle

Conceptual entry point:

```ts
runMarketingCycle("solardesk")
```

Execution:

```text
Acquire execution lock
        ↓
Check AI budget
        ↓
Load AGENT.md
        ↓
Load SolarDesk BRAND.md
        ↓
Load operational state
        ↓
Preflight
        ↓
   ┌────┴──────────────┐
   │ deterministic stop│
   │                   │
   └──────── Planner ──┘
               ↓
       Validate decision
               ↓
        Execute actions
               ↓
        Generate drafts
               ↓
         Validate drafts
               ↓
            Persist
               ↓
        Release run lock
```

The runtime, not Alex, constructs the model context.

Alex must not need to enter the number of posts, topics, formats, channels, captions, CTAs, or specific marketing objective before running a cycle.

---

## 7. Planner Decisions

The Planner may return only:

```text
CREATE_PLAN
CONTINUE_EXISTING_PLAN
WAIT_FOR_APPROVAL
NO_ACTION
NEEDS_HUMAN_INPUT
```

`NO_ACTION`, `WAIT_FOR_APPROVAL`, and deterministic skips are valid successful outcomes.

The agent must not create content merely because it was executed.

---

## 8. Marketing Objectives

Allowed objective catalog:

```text
BRAND_AWARENESS
QUALIFIED_TRAFFIC
LEAD_GENERATION
SIGNUPS
ACTIVATION
CONVERSION
RETENTION
ENGAGEMENT
REACTIVATION
```

The Planner selects:

```text
1 primary objective
0–2 supporting objectives
```

Objectives must be compatible with known SolarDesk business context.

The primary objective must include:

```text
type
reason
success_signal
```

If the business priority required to make a safe decision is unknown, AlexAgent should use `NEEDS_HUMAN_INPUT` instead of inventing it.

Business priority should guide marketing objective selection; social-content production is not itself an objective.

---

## 9. Planner Structured Output

The implementation must use a strict structured schema, implemented with Zod and OpenAI Structured Outputs.

Conceptual example:

```json
{
  "decision": "CREATE_PLAN",
  "primaryObjective": {
    "type": "QUALIFIED_TRAFFIC",
    "reason": "...",
    "successSignal": "..."
  },
  "supportingObjectives": [
    "BRAND_AWARENESS"
  ],
  "strategy": {
    "summary": "...",
    "audience": "...",
    "approach": "..."
  },
  "content": [
    {
      "purpose": "education",
      "channel": "instagram",
      "format": "carousel",
      "topic": "...",
      "audience": "...",
      "cta": "...",
      "targetDate": "2026-09-10"
    }
  ],
  "rationale": "..."
}
```

The production schema should conditionally require only the fields appropriate to the returned decision.

Do not store or request private chain-of-thought. Store concise operational rationale/decision summaries only.

---

## 10. AI vs. Code Responsibility

This boundary is mandatory.

### AI decides

- marketing objective;
- strategy;
- intended audience;
- whether marketing action is necessary;
- topics;
- number of pieces;
- formats;
- channels;
- appropriate CTA;
- whether an existing plan should continue;
- whether missing business knowledge blocks safe progress.

### Application code enforces

- authorization;
- budget;
- schema validity;
- allowed objectives;
- allowed channels/formats;
- dates and cycle bounds;
- concurrency;
- maximum content per cycle;
- approval policy;
- database consistency;
- runtime limits;
- permitted external actions.

Do not reduce marketing strategy to deterministic `if awareness → carousel` rules.

---

## 11. Content Limits

There is no required publication quota.

AlexAgent may decide that the correct number of new pieces is zero.

Runtime circuit breaker:

```text
MAX_CONTENT_PER_CYCLE = 7
```

A Planner response requesting more than seven pieces must not be executed as-is.

---

## 12. Executor

The Executor receives a validated content brief plus the authorized agent/brand context necessary to produce the piece.

Example input:

```json
{
  "brand": "solardesk",
  "contentBrief": {
    "channel": "instagram",
    "format": "carousel",
    "purpose": "education",
    "topic": "...",
    "audience": "...",
    "cta": "...",
    "targetDate": "..."
  }
}
```

Outputs must be structured according to content format.

Conceptual carousel output:

```json
{
  "title": "...",
  "hook": "...",
  "slides": [
    {
      "slide": 1,
      "text": "..."
    }
  ],
  "caption": "...",
  "cta": "...",
  "visualDirection": "...",
  "hashtags": []
}
```

Final image/video asset generation is out of scope.

`visualDirection` is included now so the content model can later support asset generation without redesigning drafts.

---

## 13. Operational State and Persistence

Supabase is the source of operational truth between executions.

Minimum tables:

```text
agent_runs
marketing_plans
content_drafts
content_revisions
agent_questions
ai_usage
agent_settings
```

AGENT.md is the agent contract.

BRAND.md is SolarDesk brand knowledge.

Operational events must not be written back automatically into either file.

AlexAgent must never auto-edit `AGENT.md` or `BRAND.md`.

---

## 14. Agent Runs

Minimum fields should support:

```text
id
brand
trigger
status
decision
summary
started_at
completed_at
error/error_code
```

Run statuses:

```text
queued
running
completed
failed
skipped
```

Supported trigger values:

```text
manual
scheduled
event
```

Only `manual` is implemented in v0.1.

A successful run does not imply that content was created.

---

## 15. Marketing Plans

Each plan should persist at least:

```text
id
brand
period_start
period_end
primary_objective
supporting_objectives
objective_reason
success_signal
strategy
rationale
status
created_by_run
created_at
```

Initial marketing-cycle duration:

```text
7 days
```

The database/runtime should model explicit `period_start` and `period_end`; seven days must not become an irreversible product assumption.

---

## 16. Drafts and Revisions

Draft lifecycle supports:

```text
draft
pending_approval
approved
revision_requested
rejected
scheduled
published
```

v0.1 does not produce `scheduled` or `published`; those states exist only to avoid an unnecessary lifecycle redesign later.

Revisions must be preserved rather than overwritten:

```text
Draft
├── Revision 1
├── Revision 2
└── Revision N
```

The stored data should preserve the Planner brief, generated content, visual direction, approval status, human feedback, and revision history.

---

## 17. Approval Engine

The human-in-the-loop interface exposes four actions:

```text
Approve
Request Revision
Reject
Answer Question
```

### Approve

```text
pending_approval → approved
```

Record approval time and actor.

v0.1 stops at approval; it does not schedule or publish externally.

### Reject

The draft becomes `rejected`.

Feedback is optional.

A rejection must not automatically regenerate the same idea. The Planner may later decide whether a strategically necessary replacement is warranted.

### Request Revision

The user may choose structured quick feedback:

```text
Too generic
Too promotional
Too long
Too technical
Wrong tone
Weak hook
Weak CTA
Factually incorrect
Visual needs work
Other
```

An optional free-text note may accompany it.

Requesting a revision invokes the Executor to create a new revision automatically. Alex should not need to open a chat or write a new content-generation prompt.

### Factually incorrect

This feedback must be treated as a product-truth issue, not merely a stylistic preference.

The unsupported claim must not be reused as fact. If the correct fact is required to proceed, create a human question.

---

## 18. Human Questions

When required business/product knowledge is unavailable:

```text
NEEDS_HUMAN_INPUT
```

The system creates an `agent_question`.

Minimum data:

```text
id
brand
question
reason
status
answer
created_at
answered_at
```

Alex answers the business question once through the UI.

The answer becomes available to subsequent agent execution/state. It must not silently rewrite permanent brand documentation.

---

## 19. Product Truth Guardrails

AlexAgent must distinguish:

```text
available
under_development
planned
unknown
```

Planned or under-development functionality must never be marketed as currently available.

AlexAgent must not fabricate:

- pricing;
- free trials;
- product capabilities;
- customers;
- testimonials;
- partnerships;
- statistics;
- awards;
- reviews;
- performance claims;
- business metrics;
- product availability.

Relevant uncertainty must result in verification or `NEEDS_HUMAN_INPUT`, not invention.

---

## 20. AI Budget Guard

AI spending protection is a core v0.1 requirement.

Initial configuration:

```text
Configured monthly AI budget:  USD $10.00
Safety reserve:                USD $0.50
Effective new-call stop:       USD $9.50
Per-run hard limit:            USD $1.00
Budget period:                 Calendar month
Budget owner:                  Alex only
Automatic budget increase:     NEVER
```

The monthly budget is global to AlexAgent, not per brand.

Budget thresholds:

```text
50%   informational
75%   warning
90%   critical
100%  blocked
```

Because final API cost is only known after a call completes, the safety reserve provides headroom for in-flight/estimated usage.

Before every AI operation, the Budget Guard must verify that the call is allowed.

At the effective stop threshold, new AI calls are blocked.

AlexAgent may take budget availability into account but can never modify its own budget.

Where available, OpenAI platform/project spending controls should later be configured as an independent second defense.

---

## 21. AI Usage Accounting

Each model operation records at least:

```text
id
agent_run_id
brand
operation
model
input_tokens
cached_input_tokens
output_tokens
estimated_cost_usd
created_at
```

Usage should allow aggregation by run and calendar month.

The dashboard must make current monthly spend visible.

Cost calculation must be centralized so model pricing can be updated without modifying agent business logic.

---

## 22. Runtime Safety

Initial limits:

```text
MAX_CONTENT_PER_CYCLE = 7
MAX_EXECUTOR_RETRIES = 2
MAX_PLANNER_CALLS_PER_RUN = 2
PER_RUN_AI_BUDGET_USD = 1.00
```

Only one SolarDesk marketing-cycle run may execute simultaneously.

Technical failures may be retried within limits.

Classify outcomes conceptually:

```text
TECHNICAL FAILURE
→ retry when safe, then log failure

MISSING BUSINESS KNOWLEDGE
→ NEEDS_HUMAN_INPUT

POLICY / BUDGET BLOCK
→ stop

NO WORK REQUIRED
→ successful no-action/skip
```

Execution locks must be released safely on success and failure.

---

## 23. Preflight

Before spending AI tokens, perform deterministic checks.

Conceptual flow:

```text
Another run active?
→ SKIP

AI budget unavailable?
→ BLOCK

Unresolved human blocker prevents useful progress?
→ SKIP

Healthy active plan + relevant state unchanged?
→ SKIP

Otherwise
→ invoke Planner
```

The system should avoid paying an LLM merely to rediscover that nothing has changed.

A future state fingerprint may improve this further; sophisticated fingerprinting is not required if a simpler deterministic v0.1 check is sufficient.

---

## 24. Trigger Model

The architecture recognizes:

```text
MANUAL
SCHEDULED
EVENT
```

v0.1 implements only:

```text
MANUAL
```

The Run Marketing Cycle button means:

> Wake up, evaluate SolarDesk's current marketing state, and decide whether action is required.

It must not mean:

> Generate content now.

Scheduled daily heartbeat and event triggers are future capabilities.

---

## 25. Minimal UI

Only these product areas are required:

```text
/dashboard
/approvals
/approvals/[id]
/questions
/settings
```

No chat interface.

### Dashboard

Show:

- SolarDesk;
- current AlexAgent status;
- Run Marketing Cycle;
- current cycle;
- primary objective;
- strategy summary;
- items requiring Alex's attention;
- monthly AI budget usage;
- recent activity.

Possible statuses include:

```text
Ready
Running
Needs input
Budget paused
```

The action should be labeled **Run Marketing Cycle**, not Generate Content.

### Approvals

List pending drafts requiring human review.

### Draft Detail

Show:

- brand;
- channel;
- format;
- purpose;
- audience;
- target date;
- generated content;
- CTA;
- visual direction;
- revision information;
- Approve;
- Request Revision;
- Reject.

### Questions

Show unresolved business/product questions, why AlexAgent needs the information, and an answer field.

### Settings

Initially expose:

```text
Monthly AI budget
Safety reserve
Per-run AI limit
SolarDesk enabled
Approval policy
Execution mode
```

Initial policy:

```text
ALL_CONTENT_REQUIRES_APPROVAL
```

Initial execution mode:

```text
MANUAL
```

---

## 26. UX Principle

The product's primary interaction model is:

```text
AlexAgent works
        ↓
Alex handles exceptions
```

It is explicitly **not**:

```text
Alex writes prompts
        ↓
AlexAgent responds
```

A chat UI is intentionally excluded from v0.1.

The desired future experience is that Alex opens AlexAgent and sees what requires attention rather than having to decide what marketing work should happen next.

---

## 27. Activity Log

The Dashboard should expose recent agent activity sufficient for operational transparency/debugging.

Examples:

```text
Marketing cycle completed
Created weekly marketing plan
Created 3 drafts
Draft revision created
Draft rejected
Planner selected QUALIFIED_TRAFFIC
Run skipped — active plan awaiting approval
```

Do not expose private model chain-of-thought.

Operational summaries are sufficient.

A dedicated `/activity` page is not required in v0.1.

---

## 28. Acceptance Tests

### A — Autonomous Planning

**Given** SolarDesk has a valid `BRAND.md` and no active marketing plan,

**When** Alex runs `Run Marketing Cycle`,

**Then** AlexAgent independently determines an appropriate marketing objective, strategy, actions, number of pieces, formats, channels, topics, and drafts,

**Without** Alex specifying what content to create.

### B — State Awareness

**Given** SolarDesk already has a healthy active plan with pending drafts,

**When** AlexAgent runs again,

**Then** it must not blindly create another marketing plan or duplicate content.

A no-action/awaiting-approval outcome is valid.

### C — Missing Knowledge

**Given** a safe marketing decision requires unknown business/product information,

**When** AlexAgent cannot verify the information from authorized context,

**Then** it creates a human question instead of inventing the answer.

### D — Revision

**Given** a draft is pending approval,

**When** Alex requests a revision using quick feedback and/or a note,

**Then** AlexAgent creates a new revision through the Executor,

**And** preserves the previous version,

**Without** requiring Alex to start a chat or issue another content-generation prompt.

### E — Budget

**Given** the AI Budget Guard determines that additional AI use is not allowed,

**When** an operation attempts to invoke a model,

**Then** the model call is blocked,

**And** the UI exposes the budget-paused state.

AlexAgent must never increase its own budget.

### F — Concurrency

**Given** a SolarDesk marketing cycle is already running,

**When** another run is requested,

**Then** a second Planner execution must not start.

### G — Product Truth

**Given** a proposed claim is not supported by authorized SolarDesk context,

**When** AlexAgent generates or validates marketing content,

**Then** the unsupported claim must not be presented as fact,

**And**, when the fact is necessary, AlexAgent requests human input.

---

## 29. Explicitly Out of Scope for v0.1

Do **not** implement:

- Odentia;
- Mi Padel Club;
- multi-brand management UI;
- Buffer;
- Meta/Instagram publishing APIs;
- LinkedIn publishing;
- any external social publishing;
- social analytics;
- website analytics;
- automated scheduler/cron;
- event triggers;
- autonomous publishing;
- image generation;
- video generation;
- paid advertising;
- advertising budgets;
- campaign-management UI;
- marketing calendar UI;
- asset library;
- chatbot;
- multi-agent architecture;
- sophisticated vector memory/RAG;
- automatic learning/memory promotion;
- automatic edits to `AGENT.md`;
- automatic edits to `BRAND.md`.

Do not add adjacent features merely because they appear useful.

---

## 30. Implementation Priorities

Implementation should prioritize behavior over visual polish.

Recommended order:

```text
1. Validate existing AGENT.md and SolarDesk BRAND.md
2. Establish Next.js/Supabase application foundation
3. Create database schema and migrations
4. Implement settings and Budget Guard
5. Implement agent-run lifecycle and concurrency protection
6. Implement Context Loader + Preflight
7. Implement Planner with Structured Outputs
8. Implement validation + persistence
9. Implement Executor with Structured Outputs
10. Implement approvals/revisions/questions
11. Implement minimal Dashboard/UI
12. Add usage/activity visibility
13. Run acceptance/regression tests
```

The implementation may adjust internal file/module organization when technically justified, but it must preserve the behavioral contract in this specification.

---

## 31. Definition of Done

AlexAgent v0.1 is done when the following end-to-end demonstration succeeds:

1. SolarDesk's approved `BRAND.md` exists.
2. No active marketing plan exists for the test cycle.
3. Alex opens AlexAgent.
4. Alex presses **Run Marketing Cycle**.
5. Alex provides no marketing/content prompt.
6. AlexAgent evaluates SolarDesk.
7. AlexAgent independently selects an objective and strategy.
8. AlexAgent decides whether content is required.
9. If required, it creates appropriate structured drafts.
10. Drafts appear as pending approval.
11. Alex can approve, reject, or request a revision.
12. A revision is generated without a new conversational prompt.
13. Re-running the cycle does not blindly duplicate the existing plan.
14. Unknown facts generate questions rather than fabricated claims.
15. All AI usage is recorded and constrained by the configured budget.

At that point we have crossed the v0.1 boundary from:

> **Alex using AI to do marketing**

to:

> **AlexAgent performing marketing work and escalating decisions to Alex.**

---

## 32. Work Handoff Instruction

This document is the approved implementation scope for **AlexAgent v0.1**.

Before implementation, inspect the current `RockerCat/alex-agent` repository and preserve valid existing `AGENT.md` and `brands/solardesk/BRAND.md` work.

Implement this specification against the repository's actual current state.

**Do not expand scope.**

If repository reality conflicts with this specification in a way that materially affects architecture, security, data integrity, budget enforcement, or the acceptance tests, stop and surface the conflict rather than silently changing the product requirements.

The implementation target is not a generic marketing dashboard.

The implementation target is the smallest reliable system that proves:

> **SolarDesk Marketing Cycle runs without Alex telling AlexAgent what content to create.**
