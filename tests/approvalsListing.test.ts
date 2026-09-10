import { describe, it, expect } from "vitest";
import { listDraftsForTab } from "@/lib/agent/approvalsListing";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentDraftRow } from "@/lib/types/database";

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

function draftRow(id: string, status: ContentDraftRow["status"], topic: string): ContentDraftRow {
  return {
    id,
    plan_id: PLAN_ID,
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
});
