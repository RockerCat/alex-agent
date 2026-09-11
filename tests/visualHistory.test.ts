import { describe, it, expect } from "vitest";
import { getRecentVisualStrategyHistory } from "@/lib/agent/visualHistory";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

// AlexAgent v0.2 — bounded recent visual-strategy history for the
// Visual Director (spec section 5). Reads only small, already-persisted
// fields off recent content_assets rows for the brand — never a join,
// never full historical binaries, never throws on legacy/malformed rows.

function seedAsset(
  fake: ReturnType<typeof createFakeDb>,
  overrides: Record<string, unknown>
) {
  const existing = fake.getAll("content_assets");
  fake.seed("content_assets", [
    ...existing,
    {
      id: `asset-${existing.length + 1}`,
      draft_id: `draft-${existing.length + 1}`,
      brand: "solardesk",
      asset_version: 1,
      source_draft_version: 1,
      status: "pending_review",
      format: "image_post",
      width: 1080,
      height: 1350,
      mime_type: "image/png",
      storage_bucket: "solardesk-assets",
      storage_path: "x",
      render_provenance: {},
      error_message: null,
      created_at: new Date(Date.now() + existing.length * 1000).toISOString(),
      approved_at: null,
      ...overrides,
    },
  ]);
}

function withVisualPlan(strategy: string, concept: string, topic: string, purpose: string) {
  return { render_provenance: { visualPlan: { strategy, creativeConcept: concept, draftContext: { topic, purpose } } } };
}

describe("getRecentVisualStrategyHistory", () => {
  it("returns entries derived only from persisted visualPlan/draftContext fields, most recent first", async () => {
    const fake = createFakeDb();
    seedAsset(fake, withVisualPlan("proposal_document", "Mostrar el PDF final.", "Post A", "activation"));
    seedAsset(fake, withVisualPlan("branded_graphic", "Explicar supuestos.", "Post B", "education"));
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const history = await getRecentVisualStrategyHistory(db, "solardesk");

    expect(history).toHaveLength(2);
    expect(history[0].strategy).toBe("branded_graphic"); // most recent first
    expect(history[1].strategy).toBe("proposal_document");
  });

  it("skips generation_failed rows", async () => {
    const fake = createFakeDb();
    seedAsset(fake, { status: "generation_failed", ...withVisualPlan("product_ui", "x", "y", "z") });
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const history = await getRecentVisualStrategyHistory(db, "solardesk");

    expect(history).toHaveLength(0);
  });

  it("skips legacy/malformed rows (no visualPlan, or an invalid strategy) without throwing", async () => {
    const fake = createFakeDb();
    seedAsset(fake, {}); // no visualPlan at all — legacy asset
    seedAsset(fake, { render_provenance: { visualPlan: { strategy: "not_a_real_strategy", creativeConcept: "x", draftContext: { topic: "a", purpose: "b" } } } });
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    await expect(getRecentVisualStrategyHistory(db, "solardesk")).resolves.toEqual([]);
  });

  it("caps at 5 entries even if more are available", async () => {
    const fake = createFakeDb();
    for (let i = 0; i < 8; i++) {
      seedAsset(fake, withVisualPlan("branded_graphic", `concept ${i}`, `topic ${i}`, "purpose"));
    }
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const history = await getRecentVisualStrategyHistory(db, "solardesk");

    expect(history.length).toBeLessThanOrEqual(5);
  });

  it("never includes another brand's assets", async () => {
    const fake = createFakeDb();
    seedAsset(fake, { brand: "other-brand", ...withVisualPlan("branded_graphic", "x", "y", "z") });
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const history = await getRecentVisualStrategyHistory(db, "solardesk");

    expect(history).toHaveLength(0);
  });
});
