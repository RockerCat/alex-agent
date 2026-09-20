import { describe, it, expect, vi, beforeEach } from "vitest";

// Per-project AI spend (Dashboard "Today"/"Daily avg."): tests the
// server action in isolation (no real Supabase/session), proving its
// own job — authenticate, validate inputs, then delegate to
// BudgetGuard.getBrandSpendSince() with the caller-supplied boundaries
// unchanged. The boundary *computation* itself (components/DailySpend.tsx)
// and the brand-scoped aggregation itself (BudgetGuard, covered in
// acceptanceE.budget.test.ts) are tested separately.

vi.mock("@/lib/supabase/admin", async () => {
  const { createFakeDb, asSupabaseClient } = await import("@/tests/support/fakeDb");
  const fake = createFakeDb();
  return {
    supabaseAdmin: () => asSupabaseClient(fake),
    __fake: fake,
  };
});

vi.mock("@/lib/supabase/server", () => ({
  requireSession: vi.fn(async () => ({ id: "alex", email: "sosa@techtivo.com" })),
}));

import * as adminModule from "@/lib/supabase/admin";
import { getBrandSpendSummaryAction } from "@/app/actions";
import { requireSession } from "@/lib/supabase/server";

const fake = (adminModule as unknown as { __fake: ReturnType<typeof import("@/tests/support/fakeDb").createFakeDb> }).__fake;

function seedUsage(rows: { brand: string; costUsd: number; createdAt: string }[]) {
  fake.seed(
    "ai_usage",
    rows.map((r, i) => ({
      id: `usage-${i}`,
      agent_run_id: null,
      brand: r.brand,
      operation: "executor",
      model: "gpt-5.6-luna",
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      estimated_cost_usd: r.costUsd,
      created_at: r.createdAt,
    }))
  );
}

describe("getBrandSpendSummaryAction", () => {
  beforeEach(() => {
    // FakeDb.seed() replaces a table's rows outright (not append), so
    // this gives each test a clean ai_usage table without needing a
    // fresh FakeDb instance per test.
    fake.seed("ai_usage", []);
    vi.mocked(requireSession).mockResolvedValue({ id: "alex", email: "sosa@techtivo.com" } as never);
  });

  it("1. requires an authenticated session", async () => {
    vi.mocked(requireSession).mockResolvedValueOnce(null as never);

    await expect(
      getBrandSpendSummaryAction({ brand: "solardesk", todayStartIso: "2026-09-19T00:00:00.000Z", monthStartIso: "2026-09-01T00:00:00.000Z" })
    ).rejects.toThrow("Not authorized.");
  });

  it("2. rejects an unsupported brand without querying usage", async () => {
    const result = await getBrandSpendSummaryAction({
      brand: "mipadel",
      todayStartIso: "2026-09-19T00:00:00.000Z",
      monthStartIso: "2026-09-01T00:00:00.000Z",
    });

    expect(result).toEqual({ error: "Unsupported brand." });
  });

  it("3. rejects a malformed date boundary", async () => {
    const result = await getBrandSpendSummaryAction({
      brand: "solardesk",
      todayStartIso: "not-a-date",
      monthStartIso: "2026-09-01T00:00:00.000Z",
    });

    expect(result).toEqual({ error: "Invalid date boundary." });
  });

  it("4. sums only this brand's usage on/after each supplied boundary", async () => {
    seedUsage([
      { brand: "solardesk", costUsd: 0.1, createdAt: "2026-09-19T05:00:00.000Z" }, // on/after today boundary
      { brand: "solardesk", costUsd: 0.2, createdAt: "2026-09-10T00:00:00.000Z" }, // on/after month boundary only
      { brand: "solardesk", costUsd: 0.3, createdAt: "2026-08-15T00:00:00.000Z" }, // before month boundary
      { brand: "mipadel", costUsd: 5.0, createdAt: "2026-09-19T06:00:00.000Z" }, // different brand entirely
    ]);

    const result = await getBrandSpendSummaryAction({
      brand: "solardesk",
      todayStartIso: "2026-09-19T05:00:00.000Z",
      monthStartIso: "2026-09-01T05:00:00.000Z",
    });

    if ("error" in result) throw new Error("unexpected error result");
    expect(result.todayUsd).toBeCloseTo(0.1, 6);
    expect(result.monthToDateUsd).toBeCloseTo(0.3, 6);
  });

  it("5. returns $0 for a brand with no usage rows", async () => {
    const result = await getBrandSpendSummaryAction({
      brand: "solardesk",
      todayStartIso: "2026-09-19T05:00:00.000Z",
      monthStartIso: "2026-09-01T05:00:00.000Z",
    });

    expect(result).toEqual({ todayUsd: 0, monthToDateUsd: 0 });
  });
});
