import type { FakeDb } from "@/tests/support/fakeDb";

export function seedDefaultSettings(db: FakeDb, overrides: Record<string, unknown> = {}) {
  db.seed("agent_settings", [
    {
      id: "settings-1",
      singleton: true,
      monthly_budget_usd: 10.0,
      safety_reserve_usd: 0.5,
      per_run_budget_usd: 1.0,
      solardesk_enabled: true,
      approval_policy: "ALL_CONTENT_REQUIRES_APPROVAL",
      execution_mode: "MANUAL",
      updated_at: new Date().toISOString(),
      ...overrides,
    },
  ]);
}
