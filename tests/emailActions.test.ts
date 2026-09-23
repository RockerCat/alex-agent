import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import {
  DEFAULT_ACTION_TOKEN_TTL_MS,
  buildEmailActionUrl,
  confirmEmailAction,
  createEmailActionTokens,
  generateActionToken,
  hashActionToken,
  inspectEmailAction,
  isWellFormedActionToken,
} from "@/lib/agent/emailActions";
import { approveAsset } from "@/lib/agent/assetGenerator";
import { createFakeDb, asSupabaseClient, type FakeDb } from "@/tests/support/fakeDb";

// Email HITL Phase 2B — secure, version-bound email actions. Every
// decision must go through the existing domain functions with the
// token's exact version; tokens are hashed-only, single-use, expiring,
// and inspection is strictly read-only (scanner-safe).

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "44444444-4444-4444-8444-444444444444";
const NOTIFICATION_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-09-23T15:00:00Z");

function seed(fake: FakeDb, draftOverrides: Record<string, unknown> = {}) {
  fake.seed("content_drafts", [
    {
      id: DRAFT_ID,
      plan_id: "plan-1",
      brand: "solardesk",
      created_by_run: null,
      channel: "instagram",
      content_type: "image_post",
      purpose: "p",
      topic: "Tema del borrador",
      audience: "a",
      cta: "c",
      cta_url: null,
      target_date: "2026-09-25",
      status: "pending_approval",
      version: 2,
      title: "Título <b>v2</b>",
      hook: "h",
      body: {},
      caption: "cap",
      cta_text: "c",
      visual_direction: "v",
      hashtags: [],
      blocked_on_question_id: null,
      approved_at: null,
      rejected_at: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      ...draftOverrides,
    },
  ]);
  fake.seed("notification_outbox", [
    {
      id: NOTIFICATION_ID,
      brand: "solardesk",
      channel: "email",
      notification_type: "draft_pending_approval",
      subject_type: "content_draft",
      subject_id: DRAFT_ID,
      subject_version: 2,
      status: "sent",
    },
  ]);
}

function seedAssets(fake: FakeDb, assets: Record<string, unknown>[]) {
  fake.seed(
    "content_assets",
    assets.map((a) => ({
      draft_id: DRAFT_ID,
      brand: "solardesk",
      source_draft_version: 2,
      status: "pending_review",
      format: "image_post",
      width: 1080,
      height: 1350,
      mime_type: "image/png",
      storage_bucket: "solardesk-assets",
      storage_path: "p.png",
      render_provenance: {},
      error_message: null,
      created_at: NOW.toISOString(),
      approved_at: null,
      ...a,
    }))
  );
}

function setup(draftOverrides: Record<string, unknown> = {}) {
  const fake = createFakeDb();
  seed(fake, draftOverrides);
  return { fake, db: asSupabaseClient<SupabaseClient<Database>>(fake) };
}

async function draftTokens(db: SupabaseClient<Database>, opts: { subjectVersion?: number; ttlMs?: number } = {}) {
  return createEmailActionTokens(db, {
    notificationId: NOTIFICATION_ID,
    brand: "solardesk",
    subjectType: "content_draft",
    subjectId: DRAFT_ID,
    subjectVersion: opts.subjectVersion ?? 2,
    actions: ["approve_draft", "reject_draft"],
    now: NOW,
    ttlMs: opts.ttlMs,
  });
}

const draftRow = (fake: FakeDb) => fake.getAll("content_drafts")[0];
const tokenRows = (fake: FakeDb) => fake.getAll("email_action_tokens");
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe("token generation and persistence", () => {
  it("generates 256-bit base64url tokens whose SHA-256 hex hash is what gets stored", () => {
    const { token, tokenHash } = generateActionToken();
    expect(isWellFormedActionToken(token)).toBe(true);
    expect(token).toHaveLength(43);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashActionToken(token)).toBe(tokenHash);
    expect(generateActionToken().token).not.toBe(token);
  });

  it("persists only hashes, bound to notification/action/subject/version/brand/expiry — never the plaintext", async () => {
    const { fake, db } = setup();
    const tokens = await draftTokens(db);
    const rows = tokenRows(fake);
    expect(rows).toHaveLength(2);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(tokens.approve_draft!);
    expect(serialized).not.toContain(tokens.reject_draft!);

    const approveRow = rows.find((r) => r.action === "approve_draft")!;
    expect(approveRow).toMatchObject({
      token_hash: hashActionToken(tokens.approve_draft!),
      notification_id: NOTIFICATION_ID,
      subject_type: "content_draft",
      subject_id: DRAFT_ID,
      subject_version: 2,
      brand: "solardesk",
      expires_at: later(DEFAULT_ACTION_TOKEN_TTL_MS).toISOString(),
      consumed_at: null,
      outcome: null,
    });
  });

  it("defaults to a finite 7-day expiry", () => {
    expect(DEFAULT_ACTION_TOKEN_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("refuses to mint an action for the wrong subject type", async () => {
    const { db } = setup();
    await expect(
      createEmailActionTokens(db, { notificationId: NOTIFICATION_ID, brand: "solardesk", subjectType: "content_draft", subjectId: DRAFT_ID, subjectVersion: 2, actions: ["approve_asset"] })
    ).rejects.toThrow();
  });

  it("builds URLs with the token only in the fragment, https only", () => {
    const { token } = generateActionToken();
    expect(buildEmailActionUrl("https://agent.alexsosa.me/", token)).toBe(`https://agent.alexsosa.me/email/action#t=${token}`);
    expect(() => buildEmailActionUrl("http://agent.alexsosa.me", token)).toThrow();
    expect(buildEmailActionUrl("http://localhost:3000", token)).toBe(`http://localhost:3000/email/action#t=${token}`);
    expect(() => buildEmailActionUrl("https://agent.alexsosa.me", "not-a-token")).toThrow();
  });
});

describe("inspectEmailAction — read-only, scanner-safe", () => {
  it("describes a valid action without consuming the token or mutating the draft", async () => {
    const { fake, db } = setup();
    const tokens = await draftTokens(db);
    const before = JSON.stringify({ d: fake.getAll("content_drafts"), t: tokenRows(fake) });

    const inspection = await inspectEmailAction(db, tokens.approve_draft, NOW);
    expect(inspection).toEqual({
      state: "ready",
      context: {
        action: "approve_draft",
        brandDisplayName: "SolarDesk",
        title: "Título <b>v2</b>",
        channel: "instagram",
        contentType: "image_post",
        contentVersion: 2,
        assetVersion: null,
      },
    });
    // Repeated inspection (e.g. a link scanner) changes nothing.
    await inspectEmailAction(db, tokens.approve_draft, NOW);
    expect(JSON.stringify({ d: fake.getAll("content_drafts"), t: tokenRows(fake) })).toBe(before);
    expect(JSON.stringify(inspection)).not.toContain(DRAFT_ID);
  });

  it("fails closed for malformed and unknown tokens", async () => {
    const { db } = setup();
    await draftTokens(db);
    for (const bad of [undefined, null, 42, "", "short", "x".repeat(43) + "!", generateActionToken().token]) {
      expect(await inspectEmailAction(db, bad, NOW)).toEqual({ state: "invalid" });
    }
  });

  it("reports expiry, staleness, and already-decided state without writing", async () => {
    const { fake, db } = setup();
    const tokens = await draftTokens(db, { ttlMs: 1000 });
    expect((await inspectEmailAction(db, tokens.approve_draft, later(1000))).state).toBe("expired");

    const fresh = await draftTokens(db, { subjectVersion: 1 });
    expect((await inspectEmailAction(db, fresh.approve_draft, NOW)).state).toBe("stale");

    const current = await draftTokens(db);
    await db.from("content_drafts").update({ status: "approved" }).eq("id", DRAFT_ID);
    expect(await inspectEmailAction(db, current.reject_draft, NOW)).toMatchObject({ state: "not_actionable", currentStatus: "approved" });
    expect(tokenRows(fake).every((r) => r.consumed_at === null)).toBe(true);
  });
});

describe("confirmEmailAction — exact-version draft decisions", () => {
  it("approves the exact version and consumes the token as applied", async () => {
    const { fake, db } = setup();
    const tokens = await draftTokens(db);
    const result = await confirmEmailAction(db, tokens.approve_draft, NOW);
    expect(result.result).toBe("applied");
    expect(draftRow(fake).status).toBe("approved");
    const row = tokenRows(fake).find((r) => r.action === "approve_draft")!;
    expect(row.outcome).toBe("applied");
    expect(row.consumed_at).toBe(NOW.toISOString());
  });

  it("rejects the exact version", async () => {
    const { fake, db } = setup();
    const tokens = await draftTokens(db);
    expect((await confirmEmailAction(db, tokens.reject_draft, NOW)).result).toBe("applied");
    expect(draftRow(fake).status).toBe("rejected");
  });

  it("an old email (stale version) can never approve or reject a newer draft version", async () => {
    const { fake, db } = setup();
    const oldTokens = await draftTokens(db, { subjectVersion: 1 });
    expect((await confirmEmailAction(db, oldTokens.approve_draft, NOW)).result).toBe("stale");
    expect((await confirmEmailAction(db, oldTokens.reject_draft, NOW)).result).toBe("stale");
    expect(draftRow(fake).status).toBe("pending_approval");
    expect(tokenRows(fake).map((r) => r.outcome)).toEqual(["stale", "stale"]);
  });

  it("replay of a used token never repeats the mutation", async () => {
    const { fake, db } = setup();
    const tokens = await draftTokens(db);
    expect((await confirmEmailAction(db, tokens.approve_draft, NOW)).result).toBe("applied");
    const approvedAt = draftRow(fake).approved_at;
    const replay = await confirmEmailAction(db, tokens.approve_draft, later(5000));
    expect(replay).toMatchObject({ result: "already_processed", outcome: "applied" });
    expect(draftRow(fake).approved_at).toBe(approvedAt);
  });

  it("competing approve/reject tokens: once one decision succeeds, the other cannot change the draft", async () => {
    const { fake, db } = setup();
    const tokens = await draftTokens(db);
    expect((await confirmEmailAction(db, tokens.approve_draft, NOW)).result).toBe("applied");
    expect(await inspectEmailAction(db, tokens.reject_draft, NOW)).toMatchObject({ state: "not_actionable", currentStatus: "approved" });
    const competing = await confirmEmailAction(db, tokens.reject_draft, NOW);
    expect(competing).toMatchObject({ result: "not_actionable", currentStatus: "approved" });
    expect(draftRow(fake).status).toBe("approved");
    expect(draftRow(fake).rejected_at).toBeNull();
    expect(tokenRows(fake).find((r) => r.action === "reject_draft")!.outcome).toBe("state_guard_failed");
  });

  it("concurrent confirms of the same token mutate at most once", async () => {
    const { fake, db } = setup();
    const tokens = await draftTokens(db);
    const results = await Promise.all([confirmEmailAction(db, tokens.approve_draft, NOW), confirmEmailAction(db, tokens.approve_draft, NOW)]);
    expect(results.filter((r) => r.result === "applied")).toHaveLength(1);
    expect(draftRow(fake).status).toBe("approved");
    expect(tokenRows(fake).find((r) => r.action === "approve_draft")!.outcome).toBe("applied");
  });

  it("an expired token cannot decide anything and stays unconsumed", async () => {
    const { fake, db } = setup();
    const tokens = await draftTokens(db, { ttlMs: 1000 });
    expect((await confirmEmailAction(db, tokens.approve_draft, later(1000))).result).toBe("expired");
    expect(draftRow(fake).status).toBe("pending_approval");
    expect(tokenRows(fake).every((r) => r.consumed_at === null)).toBe(true);
  });

  it("wrong subject state (already rejected elsewhere) fails closed without mutating", async () => {
    const { fake, db } = setup({ status: "rejected" });
    const tokens = await draftTokens(db);
    expect(await confirmEmailAction(db, tokens.approve_draft, NOW)).toMatchObject({ result: "not_actionable", currentStatus: "rejected" });
    expect(draftRow(fake).status).toBe("rejected");
  });

  it("malformed/unknown tokens mutate nothing", async () => {
    const { fake, db } = setup();
    await draftTokens(db);
    expect(await confirmEmailAction(db, "garbage", NOW)).toEqual({ result: "invalid" });
    expect(await confirmEmailAction(db, generateActionToken().token, NOW)).toEqual({ result: "invalid" });
    expect(draftRow(fake).status).toBe("pending_approval");
    expect(tokenRows(fake).every((r) => r.consumed_at === null)).toBe(true);
  });

  it("a token whose brand does not match its subject fails closed", async () => {
    const { fake, db } = setup();
    const tokens = await createEmailActionTokens(db, {
      notificationId: NOTIFICATION_ID,
      brand: "mipadel",
      subjectType: "content_draft",
      subjectId: DRAFT_ID,
      subjectVersion: 2,
      actions: ["approve_draft"],
      now: NOW,
    });
    expect(await inspectEmailAction(db, tokens.approve_draft, NOW)).toEqual({ state: "invalid" });
    expect((await confirmEmailAction(db, tokens.approve_draft, NOW)).result).toBe("failed");
    expect(draftRow(fake).status).toBe("pending_approval");
  });
});

describe("approve_asset — exact asset version", () => {
  async function assetToken(db: SupabaseClient<Database>, assetVersion = 3, assetId = ASSET_ID) {
    return createEmailActionTokens(db, {
      notificationId: NOTIFICATION_ID,
      brand: "solardesk",
      subjectType: "content_asset",
      subjectId: assetId,
      subjectVersion: assetVersion,
      actions: ["approve_asset"],
      now: NOW,
    });
  }

  it("approves the latest pending asset at the exact version", async () => {
    const { fake, db } = setup({ status: "approved" });
    seedAssets(fake, [{ id: ASSET_ID, asset_version: 3 }]);
    const tokens = await assetToken(db);
    expect(await inspectEmailAction(db, tokens.approve_asset, NOW)).toMatchObject({ state: "ready", context: { assetVersion: 3, contentVersion: 2 } });
    expect((await confirmEmailAction(db, tokens.approve_asset, NOW)).result).toBe("applied");
    expect(fake.getAll("content_assets")[0].status).toBe("ready_to_publish");
  });

  it("an old asset email cannot approve a superseded asset", async () => {
    const { fake, db } = setup({ status: "approved" });
    seedAssets(fake, [
      { id: ASSET_ID, asset_version: 3 },
      { id: "66666666-6666-4666-8666-666666666666", asset_version: 4 },
    ]);
    const tokens = await assetToken(db);
    expect((await inspectEmailAction(db, tokens.approve_asset, NOW)).state).toBe("stale");
    expect((await confirmEmailAction(db, tokens.approve_asset, NOW)).result).toBe("stale");
    expect(fake.getAll("content_assets").every((a) => a.status === "pending_review")).toBe(true);
  });

  it("an already-approved asset is not re-approved; replay is already_processed", async () => {
    const { fake, db } = setup({ status: "approved" });
    seedAssets(fake, [{ id: ASSET_ID, asset_version: 3 }]);
    const tokens = await assetToken(db);
    expect((await confirmEmailAction(db, tokens.approve_asset, NOW)).result).toBe("applied");
    const approvedAt = fake.getAll("content_assets")[0].approved_at;
    expect((await confirmEmailAction(db, tokens.approve_asset, NOW)).result).toBe("already_processed");
    expect(fake.getAll("content_assets")[0].approved_at).toBe(approvedAt);
  });

  /** Records every direct content_assets UPDATE issued through the query builder. */
  function trackAssetUpdates(fake: FakeDb): unknown[] {
    const updates: unknown[] = [];
    const originalFrom = fake.from.bind(fake);
    fake.from = ((table: string) => {
      const builder = originalFrom(table);
      if (table === "content_assets") {
        const originalUpdate = builder.update.bind(builder);
        builder.update = (payload: Record<string, unknown>) => {
          updates.push(payload);
          return originalUpdate(payload);
        };
      }
      return builder;
    }) as typeof fake.from;
    return updates;
  }

  it("the guarded path is ONE atomic database operation, never an app-side check-then-update", async () => {
    const { fake, db } = setup({ status: "approved" });
    seedAssets(fake, [{ id: ASSET_ID, asset_version: 3 }]);
    const assetUpdates = trackAssetUpdates(fake);

    expect((await approveAsset(db, ASSET_ID, { expectedAssetVersion: 3 })).ok).toBe(true);
    expect(fake.rpcCalls).toEqual([
      { name: "approve_asset_if_current", args: { p_asset_id: ASSET_ID, p_draft_id: DRAFT_ID, p_expected_asset_version: 3 } },
    ]);
    expect(assetUpdates).toEqual([]);
    expect(fake.getAll("content_assets")[0].status).toBe("ready_to_publish");
  });

  it("a newer asset appearing right before the mutation makes the old approval fail closed", async () => {
    const { fake, db } = setup({ status: "approved" });
    seedAssets(fake, [{ id: ASSET_ID, asset_version: 3 }]);
    const tokens = await assetToken(db);
    // Everything the app reads before the mutation still says v3 is current…
    expect((await inspectEmailAction(db, tokens.approve_asset, NOW)).state).toBe("ready");
    // …but a regeneration lands between those reads and the atomic mutation.
    fake.beforeNextRpc = () => {
      fake.seed("content_assets", [
        ...fake.getAll("content_assets"),
        { id: "77777777-7777-4777-8777-777777777777", draft_id: DRAFT_ID, brand: "solardesk", asset_version: 4, source_draft_version: 2, status: "pending_review" },
      ]);
    };

    const result = await confirmEmailAction(db, tokens.approve_asset, NOW);
    expect(result.result).toBe("stale");
    expect(fake.getAll("content_assets").find((a) => a.id === ASSET_ID)!.status).toBe("pending_review");
    expect(fake.getAll("email_action_tokens")[0].outcome).toBe("stale");
  });

  it("guarded approval refuses a wrong version, a non-pending asset, and invalid versions without mutating", async () => {
    const { fake, db } = setup({ status: "approved" });
    seedAssets(fake, [{ id: ASSET_ID, asset_version: 3, status: "ready_to_publish" }]);
    expect(await approveAsset(db, ASSET_ID, { expectedAssetVersion: 2 })).toMatchObject({ ok: false, staleVersion: true });
    expect(await approveAsset(db, ASSET_ID, { expectedAssetVersion: 3 })).toMatchObject({ ok: false });
    expect((await approveAsset(db, ASSET_ID, { expectedAssetVersion: 3 })).staleVersion).toBeUndefined();
    expect(await approveAsset(db, ASSET_ID, { expectedAssetVersion: 0 })).toMatchObject({ ok: false });
    expect(fake.getAll("content_assets")[0].approved_at).toBeNull();
  });

  it("legacy unguarded approval never uses the guarded database function", async () => {
    const { fake, db } = setup({ status: "approved" });
    seedAssets(fake, [{ id: ASSET_ID, asset_version: 3 }]);
    expect((await approveAsset(db, ASSET_ID)).ok).toBe(true);
    expect(fake.rpcCalls).toEqual([]);
  });

  it("approveAsset legacy callers (no expectedAssetVersion) keep their behavior; guarded callers are version-bound", async () => {
    const { fake, db } = setup({ status: "approved" });
    seedAssets(fake, [
      { id: ASSET_ID, asset_version: 3 },
      { id: "66666666-6666-4666-8666-666666666666", asset_version: 4 },
    ]);
    expect(await approveAsset(db, ASSET_ID, { expectedAssetVersion: 3 })).toMatchObject({ ok: false, staleVersion: true });
    expect(await approveAsset(db, "66666666-6666-4666-8666-666666666666", { expectedAssetVersion: 3 })).toMatchObject({ ok: false, staleVersion: true });
    expect((await approveAsset(db, ASSET_ID)).ok).toBe(true); // legacy: still approves any pending asset by id
    expect(fake.getAll("content_assets").find((a) => a.id === ASSET_ID)!.status).toBe("ready_to_publish");
  });
});
