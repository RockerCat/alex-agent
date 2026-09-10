import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { generateAsset, approveAsset, getLatestAsset, listAssets } from "@/lib/agent/assetGenerator";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { FakeAssetStorage } from "@/tests/support/fakeAssetStorage";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentDraftRow } from "@/lib/types/database";

// AlexAgent v0.2 — first vertical slice: manual image_post asset
// lifecycle. Behavioral tests only (no pixel-perfect screenshot
// comparisons) — the renderer's own visual output is covered by
// tests/assetRenderer.test.ts.

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

function seedDraft(
  fake: ReturnType<typeof createFakeDb>,
  id: string,
  overrides: Partial<ContentDraftRow> = {}
) {
  const row = {
    id,
    plan_id: PLAN_ID,
    brand: "solardesk",
    created_by_run: null,
    channel: "instagram" as const,
    content_type: "image_post" as const,
    purpose: "activation",
    topic: "Comienza gratis en SolarDesk",
    audience: "Instaladores",
    cta: "Comenzar gratis",
    target_date: "2026-09-12",
    status: "approved" as const,
    version: 1,
    title: "Comienza gratis en SolarDesk",
    hook: "¿Sigues armando propuestas solares en hojas de cálculo?",
    body: { slides: [] },
    caption: "Cotiza proyectos solares y presenta propuestas profesionales con la marca de tu empresa.",
    cta_text: "Crea tu primera cotización",
    visual_direction: "SaaS B2B limpio, azul oscuro y ámbar.",
    hashtags: ["#energiasolar", "#solardesk"],
    created_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    ...overrides,
  };
  fake.seed("content_drafts", [row]);
  return row;
}

function setup() {
  const fake = createFakeDb();
  seedPlan(fake);
  const db = asSupabaseClient<SupabaseClient<Database>>(fake);
  const storage = new FakeAssetStorage();
  return { fake, db, storage };
}

describe("generateAsset — eligibility", () => {
  it("1. an approved SolarDesk image_post can generate an asset", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(outcome.status).toBe("success");
    expect(outcome.asset?.status).toBe("pending_review");
  });

  it("2. a non-approved draft cannot generate", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1", { status: "pending_approval" });

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(outcome.status).toBe("ineligible");
    expect(fake.getAll("content_assets")).toHaveLength(0);
  });

  it("3. an unsupported format (carousel) cannot generate", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1", { content_type: "carousel" });

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(outcome.status).toBe("ineligible");
    expect(fake.getAll("content_assets")).toHaveLength(0);
  });
});

describe("generateAsset — output", () => {
  it("4. output is a real PNG at 1080x1350", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });
    expect(outcome.status).toBe("success");

    const stored = storage.files.get(outcome.asset!.storage_path!);
    expect(stored).toBeInstanceOf(Buffer);
    const meta = await sharp(stored!).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
  });

  it("5. the official logo asset is used (not AI-generated) — provenance names the real repository file", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(outcome.asset?.render_provenance).toMatchObject({
      logoFile: "brands/solardesk/assets/logos/logo.png",
    });
  });

  it("6. the source draft id and exact version remain traceable", async () => {
    const { fake, db, storage } = setup();
    const draft = seedDraft(fake, "draft-1", { version: 3 });

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(outcome.asset?.draft_id).toBe("draft-1");
    expect(outcome.asset?.source_draft_version).toBe(draft.version);
  });

  it("7. the approved content draft is never mutated", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    const before = fake.getAll("content_drafts").find((d) => d.id === "draft-1");

    await generateAsset({ db, storage, draftId: "draft-1" });

    const after = fake.getAll("content_drafts").find((d) => d.id === "draft-1");
    expect(after).toEqual(before);
  });

  it("8. the generated asset persists and can be retrieved after the call returns", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });
    const latest = await getLatestAsset(db, "draft-1");

    expect(latest?.id).toBe(outcome.asset?.id);
    expect(storage.files.has(latest!.storage_path!)).toBe(true);
  });

  it("9. a freshly generated asset begins pending_review", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(outcome.asset?.status).toBe("pending_review");
  });
});

describe("approveAsset", () => {
  it("10. approval moves the asset to ready_to_publish", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    const approved = await approveAsset(db, outcome.asset!.id);

    expect(approved.ok).toBe(true);
    expect(approved.asset?.status).toBe("ready_to_publish");
    expect(approved.asset?.approved_at).toBeTruthy();
  });

  it("refuses to approve a non-pending asset", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });
    await approveAsset(db, outcome.asset!.id);

    const secondApproval = await approveAsset(db, outcome.asset!.id);

    expect(secondApproval.ok).toBe(false);
  });
});

describe("regeneration and failure handling", () => {
  it("11. regeneration preserves the previous version instead of overwriting it", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");

    const first = await generateAsset({ db, storage, draftId: "draft-1" });
    const second = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(first.asset?.asset_version).toBe(1);
    expect(second.asset?.asset_version).toBe(2);
    expect(storage.files.has(first.asset!.storage_path!)).toBe(true); // v1 file still present
    expect(storage.files.has(second.asset!.storage_path!)).toBe(true);

    const all = await listAssets(db, "draft-1");
    expect(all).toHaveLength(2);
  });

  it("12. a failed generation does not damage existing approved content or asset history", async () => {
    const { fake, db, storage } = setup();
    // A headline long enough that even the smallest candidate font size
    // cannot fit within 4 lines — the renderer's real fail-safe path.
    const longHeadline = "Palabra ".repeat(400).trim();
    seedDraft(fake, "draft-1", { hook: longHeadline });

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(outcome.status).toBe("failed");
    expect(outcome.asset?.status).toBe("generation_failed");
    expect(outcome.asset?.error_message).toBeTruthy();

    // The draft is untouched and no file was ever uploaded for this attempt.
    const draft = fake.getAll("content_drafts").find((d) => d.id === "draft-1");
    expect(draft?.status).toBe("approved");
    expect(storage.files.size).toBe(0);

    // A subsequent successful generation still works and gets the next version.
    const retryDraft = seedDraft(fake, "draft-1", { hook: "¿Listo para tu primera propuesta?" });
    fake.seed("content_drafts", [retryDraft]);
    const retry = await generateAsset({ db, storage, draftId: "draft-1" });
    expect(retry.status).toBe("success");
    expect(retry.asset?.asset_version).toBe(2);
  });

  it("a storage upload failure is recorded as generation_failed without leaving an orphaned success row", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");
    storage.failNextUpload = true;

    const outcome = await generateAsset({ db, storage, draftId: "draft-1" });

    expect(outcome.status).toBe("failed");
    expect(outcome.asset?.status).toBe("generation_failed");
    expect(fake.getAll("content_assets")).toHaveLength(1);
  });

  it("13. concurrent generation for the same draft is handled safely — only one version 1 is ever persisted", async () => {
    const { fake, db, storage } = setup();
    seedDraft(fake, "draft-1");

    const [a, b] = await Promise.all([
      generateAsset({ db, storage, draftId: "draft-1" }),
      generateAsset({ db, storage, draftId: "draft-1" }),
    ]);

    const outcomes = [a, b];
    const successes = outcomes.filter((o) => o.status === "success");
    const concurrentRejections = outcomes.filter((o) => o.status === "concurrent");

    // Exactly one of the two calls wins version 1; the other is told to retry.
    expect(successes).toHaveLength(1);
    expect(concurrentRejections.length + successes.length).toBe(2);

    const rows = fake.getAll("content_assets");
    const versionOnes = rows.filter((r) => r.asset_version === 1);
    expect(versionOnes).toHaveLength(1); // never two competing "version 1" rows
  });
});

describe("no automatic generation", () => {
  it("14. approving a draft never calls generateAsset — no content_assets row appears without an explicit call", async () => {
    const { fake, db } = setup();
    seedDraft(fake, "draft-1", { status: "pending_approval" });

    // Simulate the existing approval action directly (the real
    // approveDraft() codepath) — it must never touch content_assets.
    const { approveDraft } = await import("@/lib/agent/approvals");
    await approveDraft(db, "draft-1");

    const draft = fake.getAll("content_drafts").find((d) => d.id === "draft-1");
    expect(draft?.status).toBe("approved");
    expect(fake.getAll("content_assets")).toHaveLength(0);
  });

  it("15. runMarketingCycle's own source never references asset generation at all", async () => {
    // Structural guarantee, not just a behavioral one: asset generation
    // must only ever be reachable from an explicit UI action
    // (app/actions.ts -> generateAssetAction), never from the autonomous
    // marketing-cycle runtime or the approval codepath. Grepping the
    // source is a stronger, more future-proof check than running one
    // marketing cycle and hoping it happens not to trigger — it proves
    // the wiring doesn't exist at all, not just that this one scripted
    // run didn't exercise it.
    const { readFile } = await import("node:fs/promises");
    const runtimeSource = await readFile("lib/agent/runtime.ts", "utf-8");
    const approvalsSource = await readFile("lib/agent/approvals.ts", "utf-8");
    expect(runtimeSource).not.toMatch(/generateAsset|assetGenerator|assetRenderer/);
    expect(approvalsSource).not.toMatch(/generateAsset|assetGenerator|assetRenderer/);
  });
});
