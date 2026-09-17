import { describe, it, expect } from "vitest";
import { listDraftsForTab, listApprovalsGroupedByCycle } from "@/lib/agent/approvalsListing";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentDraftRow, MarketingPlanRow } from "@/lib/types/database";

// Live QA gap: /approvals only ever queried status = "pending_approval",
// so an already-approved draft (exactly the state needed to reach the
// v0.2 Generate Asset action) had no way to be reached through normal
// navigation, even though the detail route itself worked fine directly.

const PLAN_ID = "plan-1";

function seedPlan(fake: ReturnType<typeof createFakeDb>) {
  fake.seed("marketing_plans", [
    {
      id: PLAN_ID,
      brand: "solardesk",
      period_start: "2026-09-08",
      period_end: "2026-09-15",
      primary_objective: "ACTIVATION",
      primary_objective_reason: "r",
      primary_objective_success_signal: "s",
      supporting_objectives: [],
      strategy_summary: "sum",
      strategy_audience: "aud",
      strategy_approach: "app",
      rationale: "rat",
      status: "active",
      created_by_run: null,
      created_at: new Date().toISOString(),
    },
  ]);
}

function plan(overrides: Partial<MarketingPlanRow> & { id: string }): MarketingPlanRow {
  return {
    brand: "solardesk",
    period_start: "2026-09-08",
    period_end: "2026-09-15",
    primary_objective: "ACTIVATION",
    primary_objective_reason: "r",
    primary_objective_success_signal: "s",
    supporting_objectives: [],
    strategy_summary: "sum",
    strategy_audience: "aud",
    strategy_approach: "app",
    rationale: "rat",
    status: "active",
    created_by_run: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function draftRow(id: string, status: ContentDraftRow["status"], topic: string, planId: string = PLAN_ID): ContentDraftRow {
  return {
    id,
    plan_id: planId,
    brand: "solardesk",
    created_by_run: null,
    channel: "instagram",
    content_type: "image_post",
    purpose: "activation",
    topic,
    audience: "Instaladores",
    cta: "Comenzar gratis",
    target_date: "2026-09-12",
    status,
    version: 1,
    title: topic,
    hook: "hook",
    body: { slides: [] },
    caption: "caption",
    cta_text: "cta",
    visual_direction: "v",
    hashtags: [],
    blocked_on_question_id: null,
    approved_at: status === "approved" ? new Date().toISOString() : null,
    rejected_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function setup() {
  const fake = createFakeDb();
  seedPlan(fake);
  const db = asSupabaseClient<SupabaseClient<Database>>(fake);
  return { fake, db };
}

describe("listDraftsForTab", () => {
  it("1. pending drafts remain accessible via the pending tab", async () => {
    const { fake, db } = setup();
    fake.seed("content_drafts", [draftRow("draft-pending", "pending_approval", "Pending topic")]);

    const rows = await listDraftsForTab(db, "pending");

    expect(rows.map((r) => r.id)).toEqual(["draft-pending"]);
  });

  it("2. approved drafts are now listable via the approved tab", async () => {
    const { fake, db } = setup();
    fake.seed("content_drafts", [draftRow("draft-approved", "approved", "Approved topic")]);

    const rows = await listDraftsForTab(db, "approved");

    expect(rows.map((r) => r.id)).toEqual(["draft-approved"]);
  });

  it("3. approved items carry the id the UI uses to link to the existing /approvals/[id] detail route", async () => {
    const { fake, db } = setup();
    fake.seed("content_drafts", [draftRow("draft-approved", "approved", "Approved topic")]);

    const rows = await listDraftsForTab(db, "approved");

    // The page builds the link as `/approvals/${draft.id}` — the exact
    // existing detail route, unchanged by this fix.
    expect(rows[0].id).toBe("draft-approved");
  });

  it("4. existing pending behavior is not broken — an approved draft never leaks into the pending tab, and vice versa", async () => {
    const { fake, db } = setup();
    fake.seed("content_drafts", [
      draftRow("draft-pending", "pending_approval", "Pending topic"),
      draftRow("draft-approved", "approved", "Approved topic"),
    ]);

    const pending = await listDraftsForTab(db, "pending");
    const approved = await listDraftsForTab(db, "approved");

    expect(pending.map((r) => r.id)).toEqual(["draft-pending"]);
    expect(approved.map((r) => r.id)).toEqual(["draft-approved"]);
  });

  it("returns an empty list (not an error) when there is nothing for a tab, matching the existing empty-state UI", async () => {
    const { db } = setup();
    const rows = await listDraftsForTab(db, "pending");
    expect(rows).toEqual([]);
  });

  it("5. listing drafts (either tab) never generates or persists an asset", async () => {
    const { fake, db } = setup();
    fake.seed("content_drafts", [draftRow("draft-approved", "approved", "Approved topic")]);

    await listDraftsForTab(db, "pending");
    await listDraftsForTab(db, "approved");

    expect(fake.getAll("content_assets")).toHaveLength(0);
  });

  it("6. rejected drafts are listable via the rejected tab and stay absent from pending/approved", async () => {
    const { fake, db } = setup();
    fake.seed("content_drafts", [
      draftRow("draft-pending", "pending_approval", "Pending topic"),
      draftRow("draft-approved", "approved", "Approved topic"),
      draftRow("draft-rejected", "rejected", "Rejected topic"),
    ]);

    const pending = await listDraftsForTab(db, "pending");
    const approved = await listDraftsForTab(db, "approved");
    const rejected = await listDraftsForTab(db, "rejected");

    expect(rejected.map((r) => r.id)).toEqual(["draft-rejected"]);
    expect(pending.map((r) => r.id)).not.toContain("draft-rejected");
    expect(approved.map((r) => r.id)).not.toContain("draft-rejected");
  });
});

describe("listApprovalsGroupedByCycle", () => {
  const ACTIVATION_ID = "plan-activation";
  const SIGNUPS_ID = "plan-signups";

  function seedTwoCycles(fake: ReturnType<typeof createFakeDb>) {
    fake.seed("marketing_plans", [
      plan({
        id: ACTIVATION_ID,
        primary_objective: "ACTIVATION",
        period_start: "2026-09-09",
        period_end: "2026-09-16",
        status: "completed",
      }),
      plan({
        id: SIGNUPS_ID,
        primary_objective: "SIGNUPS",
        period_start: "2026-09-17",
        period_end: "2026-09-24",
        status: "active",
      }),
    ]);
  }

  it("1. drafts from two plans are grouped into separate cycle groups", async () => {
    const { fake, db } = setup();
    seedTwoCycles(fake);
    fake.seed("content_drafts", [
      draftRow("draft-old", "approved", "Old cycle topic", ACTIVATION_ID),
      draftRow("draft-new", "approved", "New cycle topic", SIGNUPS_ID),
    ]);

    const groups = await listApprovalsGroupedByCycle(db, "approved", "2026-09-20");

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.drafts.map((d) => d.id))).toEqual([["draft-new"], ["draft-old"]]);
  });

  it("2. groups are ordered newest-cycle-first by period_start", async () => {
    const { fake, db } = setup();
    seedTwoCycles(fake);
    fake.seed("content_drafts", [
      // Seeded oldest-plan-first to prove the result order comes from
      // the plan's period_start, not seed/query order.
      draftRow("draft-old", "approved", "Old cycle topic", ACTIVATION_ID),
      draftRow("draft-new", "approved", "New cycle topic", SIGNUPS_ID),
    ]);

    const groups = await listApprovalsGroupedByCycle(db, "approved", "2026-09-20");

    expect(groups[0].plan?.id).toBe(SIGNUPS_ID);
    expect(groups[1].plan?.id).toBe(ACTIVATION_ID);
  });

  it("3. plan objective/date/status metadata maps correctly onto each group, including the current-cycle flag", async () => {
    const { fake, db } = setup();
    seedTwoCycles(fake);
    fake.seed("content_drafts", [
      draftRow("draft-old", "approved", "Old cycle topic", ACTIVATION_ID),
      draftRow("draft-new", "approved", "New cycle topic", SIGNUPS_ID),
    ]);

    const groups = await listApprovalsGroupedByCycle(db, "approved", "2026-09-20");
    const signups = groups.find((g) => g.plan?.id === SIGNUPS_ID)!;
    const activation = groups.find((g) => g.plan?.id === ACTIVATION_ID)!;

    expect(signups.plan?.primary_objective).toBe("SIGNUPS");
    expect(signups.plan?.period_start).toBe("2026-09-17");
    expect(signups.plan?.period_end).toBe("2026-09-24");
    expect(signups.plan?.status).toBe("active");
    expect(signups.isCurrentCycle).toBe(true); // active and not yet expired relative to "today"

    expect(activation.plan?.status).toBe("completed");
    expect(activation.isCurrentCycle).toBe(false);
  });

  it("4. drafts remain associated with the correct plan (no cross-cycle leakage)", async () => {
    const { fake, db } = setup();
    seedTwoCycles(fake);
    fake.seed("content_drafts", [
      draftRow("draft-old-1", "approved", "Old topic 1", ACTIVATION_ID),
      draftRow("draft-old-2", "approved", "Old topic 2", ACTIVATION_ID),
      draftRow("draft-new-1", "approved", "New topic 1", SIGNUPS_ID),
    ]);

    const groups = await listApprovalsGroupedByCycle(db, "approved", "2026-09-20");
    const signups = groups.find((g) => g.plan?.id === SIGNUPS_ID)!;
    const activation = groups.find((g) => g.plan?.id === ACTIVATION_ID)!;

    expect(signups.drafts.map((d) => d.id)).toEqual(["draft-new-1"]);
    expect(activation.drafts.map((d) => d.id).sort()).toEqual(["draft-old-1", "draft-old-2"]);
  });

  it("5. existing pending/approved filtering is preserved through the grouped view", async () => {
    const { fake, db } = setup();
    seedTwoCycles(fake);
    fake.seed("content_drafts", [
      draftRow("draft-pending", "pending_approval", "Pending topic", SIGNUPS_ID),
      draftRow("draft-approved", "approved", "Approved topic", SIGNUPS_ID),
    ]);

    const pendingGroups = await listApprovalsGroupedByCycle(db, "pending", "2026-09-20");
    const approvedGroups = await listApprovalsGroupedByCycle(db, "approved", "2026-09-20");

    expect(pendingGroups.flatMap((g) => g.drafts.map((d) => d.id))).toEqual(["draft-pending"]);
    expect(approvedGroups.flatMap((g) => g.drafts.map((d) => d.id))).toEqual(["draft-approved"]);
  });

  it("6. rejected drafts appear only under the rejected tab's grouping, never pending/approved", async () => {
    const { fake, db } = setup();
    seedTwoCycles(fake);
    fake.seed("content_drafts", [
      draftRow("draft-pending", "pending_approval", "Pending topic", SIGNUPS_ID),
      draftRow("draft-approved", "approved", "Approved topic", SIGNUPS_ID),
      draftRow("draft-rejected", "rejected", "Rejected topic", SIGNUPS_ID),
    ]);

    const rejectedGroups = await listApprovalsGroupedByCycle(db, "rejected", "2026-09-20");
    const pendingGroups = await listApprovalsGroupedByCycle(db, "pending", "2026-09-20");
    const approvedGroups = await listApprovalsGroupedByCycle(db, "approved", "2026-09-20");

    expect(rejectedGroups.flatMap((g) => g.drafts.map((d) => d.id))).toEqual(["draft-rejected"]);
    expect(pendingGroups.flatMap((g) => g.drafts.map((d) => d.id))).not.toContain("draft-rejected");
    expect(approvedGroups.flatMap((g) => g.drafts.map((d) => d.id))).not.toContain("draft-rejected");
  });

  it("7. returns an empty array (sensible empty state) when there is nothing for a tab", async () => {
    const { fake, db } = setup();
    seedTwoCycles(fake);

    const groups = await listApprovalsGroupedByCycle(db, "approved", "2026-09-20");

    expect(groups).toEqual([]);
  });

  it("handles a draft whose plan_id no longer resolves to a real plan (legacy/orphaned data) without crashing, grouping it last under plan: null", async () => {
    const { fake, db } = setup();
    seedTwoCycles(fake);
    fake.seed("content_drafts", [
      draftRow("draft-orphan", "approved", "Orphan topic", "plan-does-not-exist"),
      draftRow("draft-new", "approved", "New cycle topic", SIGNUPS_ID),
    ]);

    const groups = await listApprovalsGroupedByCycle(db, "approved", "2026-09-20");

    expect(groups).toHaveLength(2);
    expect(groups[groups.length - 1].plan).toBeNull();
    expect(groups[groups.length - 1].drafts.map((d) => d.id)).toEqual(["draft-orphan"]);
  });
});
