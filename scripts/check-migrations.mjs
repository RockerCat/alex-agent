import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const migrationsDir = path.join(process.cwd(), "supabase", "migrations");

async function main() {
  const db = new PGlite();
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf-8");
    console.log(`Applying ${file}...`);
    await db.exec(sql);
    console.log(`  OK`);
  }

  console.log("\n--- Verifying schema shape ---");

  const tables = await db.query(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name;"
  );
  console.log("Tables:", tables.rows.map((r) => r.table_name).join(", "));

  const expected = [
    "agent_questions",
    "agent_runs",
    "agent_settings",
    "ai_usage",
    "content_assets",
    "content_drafts",
    "content_revisions",
    "marketing_plans",
  ];
  const actual = tables.rows.map((r) => r.table_name).sort();
  const missing = expected.filter((t) => !actual.includes(t));
  if (missing.length) {
    throw new Error(`Missing expected tables: ${missing.join(", ")}`);
  }

  // Exercise the concurrency + duplicate-plan unique indexes for real.
  await db.exec(`
    insert into agent_runs (brand, status) values ('solardesk', 'running');
  `);
  let concurrencyBlocked = false;
  try {
    await db.exec(`insert into agent_runs (brand, status) values ('solardesk', 'running');`);
  } catch (err) {
    concurrencyBlocked = /agent_runs_one_active_per_brand/.test(String(err));
  }
  if (!concurrencyBlocked) throw new Error("Expected unique index to block a second concurrent running run");
  console.log("OK: agent_runs_one_active_per_brand unique index enforced");

  await db.exec(`
    update agent_settings set solardesk_enabled = true where singleton = true;
    insert into marketing_plans (
      brand, period_start, period_end, primary_objective, primary_objective_reason,
      primary_objective_success_signal, strategy_summary, strategy_audience, strategy_approach, rationale, status
    ) values (
      'solardesk', '2026-09-08', '2026-09-15', 'SIGNUPS', 'r', 's', 'sum', 'aud', 'app', 'rat', 'active'
    );
  `);
  let planBlocked = false;
  try {
    await db.exec(`
      insert into marketing_plans (
        brand, period_start, period_end, primary_objective, primary_objective_reason,
        primary_objective_success_signal, strategy_summary, strategy_audience, strategy_approach, rationale, status
      ) values (
        'solardesk', '2026-09-08', '2026-09-15', 'SIGNUPS', 'r', 's', 'sum', 'aud', 'app', 'rat', 'active'
      );
    `);
  } catch (err) {
    planBlocked = /marketing_plans_one_active_per_brand/.test(String(err));
  }
  if (!planBlocked) throw new Error("Expected unique index to block a second active plan per brand");
  console.log("OK: marketing_plans_one_active_per_brand unique index enforced");

  const settingsRow = await db.query("select * from agent_settings;");
  if (settingsRow.rows.length !== 1) throw new Error("Expected exactly one agent_settings row");
  console.log("OK: agent_settings singleton row present:", JSON.stringify(settingsRow.rows[0]));

  // Exercise the content_assets (draft_id, asset_version) unique index —
  // the actual concurrency guarantee for asset generation.
  const plan = await db.query("select id from marketing_plans limit 1;");
  const draft = await db.query(
    `insert into content_drafts (
       plan_id, brand, channel, content_type, purpose, topic, audience, cta, target_date, status, version
     ) values ($1, 'solardesk', 'instagram', 'image_post', 'p', 't', 'a', 'c', '2026-09-10', 'approved', 1)
     returning id;`,
    [plan.rows[0].id]
  );
  const draftId = draft.rows[0].id;
  await db.query(
    `insert into content_assets (draft_id, brand, asset_version, source_draft_version, status)
     values ($1, 'solardesk', 1, 1, 'pending_review');`,
    [draftId]
  );
  let assetVersionBlocked = false;
  try {
    await db.query(
      `insert into content_assets (draft_id, brand, asset_version, source_draft_version, status)
       values ($1, 'solardesk', 1, 1, 'pending_review');`,
      [draftId]
    );
  } catch (err) {
    assetVersionBlocked = /content_assets_draft_id_asset_version_key|duplicate key/.test(String(err));
  }
  if (!assetVersionBlocked) throw new Error("Expected unique index to block a duplicate (draft_id, asset_version)");
  console.log("OK: content_assets (draft_id, asset_version) unique index enforced");

  // Exercise the asset_publications (asset_id, channel) unique index —
  // the actual concurrency guarantee for "never double-publish the same
  // asset to the same channel" (Facebook manual publishing checkpoint 1).
  const asset = await db.query("select id from content_assets limit 1;");
  const assetId = asset.rows[0].id;
  await db.query(
    `insert into asset_publications (asset_id, draft_id, brand, channel, status)
     values ($1, $2, 'solardesk', 'facebook', 'publishing');`,
    [assetId, draftId]
  );
  let publicationBlocked = false;
  try {
    await db.query(
      `insert into asset_publications (asset_id, draft_id, brand, channel, status)
       values ($1, $2, 'solardesk', 'facebook', 'publishing');`,
      [assetId, draftId]
    );
  } catch (err) {
    publicationBlocked = /asset_publications_asset_id_channel_key|duplicate key/.test(String(err));
  }
  if (!publicationBlocked) throw new Error("Expected unique index to block a duplicate (asset_id, channel) publication");
  console.log("OK: asset_publications (asset_id, channel) unique index enforced");

  // Exercise the widened asset_publications.channel CHECK constraint
  // (0008_asset_publications_instagram_channel.sql): 'instagram' must
  // now be accepted as its own independent (asset_id, channel) slot,
  // and an unrecognized channel must still be rejected.
  await db.query(
    `insert into asset_publications (asset_id, draft_id, brand, channel, status)
     values ($1, $2, 'solardesk', 'instagram', 'publishing');`,
    [assetId, draftId]
  );
  console.log("OK: asset_publications.channel accepts 'instagram'");

  let unknownChannelBlocked = false;
  try {
    await db.query(
      `insert into asset_publications (asset_id, draft_id, brand, channel, status)
       values ($1, $2, 'solardesk', 'twitter', 'publishing');`,
      [assetId, draftId]
    );
  } catch (err) {
    unknownChannelBlocked = /asset_publications_channel_check/.test(String(err));
  }
  if (!unknownChannelBlocked) throw new Error("Expected CHECK constraint to reject an unrecognized channel");
  console.log("OK: asset_publications.channel rejects an unrecognized channel");

  // Exercise the notification_outbox unique identity (0009) — the actual
  // duplicate-notification guard: the same (brand, channel,
  // notification_type, subject_type, subject_id, subject_version) must
  // not be insertable twice, but a different subject_version (a real
  // draft revision) must be its own independent slot.
  await db.query(
    `insert into notification_outbox (brand, channel, notification_type, subject_type, subject_id, subject_version, status)
     values ('solardesk', 'whatsapp', 'draft_pending_approval', 'content_draft', $1, 1, 'pending');`,
    [draftId]
  );
  let notificationBlocked = false;
  try {
    await db.query(
      `insert into notification_outbox (brand, channel, notification_type, subject_type, subject_id, subject_version, status)
       values ('solardesk', 'whatsapp', 'draft_pending_approval', 'content_draft', $1, 1, 'pending');`,
      [draftId]
    );
  } catch (err) {
    notificationBlocked = /notification_outbox_brand_channel_notification_type_subjec/.test(String(err)) || /duplicate key/.test(String(err));
  }
  if (!notificationBlocked) throw new Error("Expected unique index to block a duplicate notification identity");
  console.log("OK: notification_outbox unique identity enforced");

  await db.query(
    `insert into notification_outbox (brand, channel, notification_type, subject_type, subject_id, subject_version, status)
     values ('solardesk', 'whatsapp', 'draft_pending_approval', 'content_draft', $1, 2, 'pending');`,
    [draftId]
  );
  console.log("OK: notification_outbox allows a new subject_version as an independent notification");

  // Exercise the email widening of notification_outbox (0012): 'email'
  // is its own independent slot for the same subject+version as an
  // existing WhatsApp row, the new types/subject type are accepted, and
  // an unrecognized channel is still rejected.
  const emailOutbox = await db.query(
    `insert into notification_outbox (brand, channel, notification_type, subject_type, subject_id, subject_version, status, rfc_message_id)
     values ('solardesk', 'email', 'draft_pending_approval', 'content_draft', $1, 1, 'pending', '<abc@example.test>')
     returning id;`,
    [draftId]
  );
  const emailOutboxId = emailOutbox.rows[0].id;
  await db.query(
    `insert into notification_outbox (brand, channel, notification_type, subject_type, subject_id, subject_version, status)
     values ('solardesk', 'email', 'asset_pending_review', 'content_asset', $1, 1, 'pending'),
            ('solardesk', 'email', 'question_pending', 'agent_question', gen_random_uuid(), 1, 'pending');`,
    [assetId]
  );
  console.log("OK: notification_outbox accepts email channel, asset_pending_review, question_pending, content_asset");

  let unknownOutboxChannelBlocked = false;
  try {
    await db.query(
      `insert into notification_outbox (brand, channel, notification_type, subject_type, subject_id, subject_version, status)
       values ('solardesk', 'sms', 'draft_pending_approval', 'content_draft', $1, 9, 'pending');`,
      [draftId]
    );
  } catch (err) {
    unknownOutboxChannelBlocked = /notification_outbox_channel_check/.test(String(err));
  }
  if (!unknownOutboxChannelBlocked) throw new Error("Expected CHECK constraint to reject an unrecognized notification channel");
  console.log("OK: notification_outbox.channel rejects an unrecognized channel");

  // email_action_tokens (0012): hashed-only token format, unique hash,
  // action/subject consistency, consumed_at/outcome consistency.
  const validHash = "a".repeat(64);
  const insertToken = (hash, action, subjectType, extra = "") =>
    db.query(
      `insert into email_action_tokens (token_hash, notification_id, action, subject_type, subject_id, subject_version, brand, expires_at${extra ? ", consumed_at, outcome" : ""})
       values ($1, $2, $3, $4, $5, 1, 'solardesk', now() + interval '3 days'${extra});`,
      [hash, emailOutboxId, action, subjectType, draftId]
    );
  await insertToken(validHash, "approve_draft", "content_draft");
  console.log("OK: email_action_tokens accepts a hashed approve_draft token");

  const expectReject = async (label, fn, pattern) => {
    let blocked = false;
    try {
      await fn();
    } catch (err) {
      blocked = pattern.test(String(err));
    }
    if (!blocked) throw new Error(`Expected email_action_tokens to reject: ${label}`);
    console.log(`OK: email_action_tokens rejects ${label}`);
  };
  await expectReject("a duplicate token hash", () => insertToken(validHash, "reject_draft", "content_draft"), /duplicate key/);
  await expectReject("a non-hash (plaintext-looking) token", () => insertToken("plaintext-token-value", "reply", "content_draft"), /email_action_tokens_token_hash_check/);
  await expectReject("approve_draft against a non-draft subject", () => insertToken("b".repeat(64), "approve_draft", "content_asset"), /email_action_tokens_check/);
  await expectReject("approve_asset against a non-asset subject", () => insertToken("c".repeat(64), "approve_asset", "content_draft"), /email_action_tokens_check/);
  await expectReject("consumed_at without an outcome", () => insertToken("d".repeat(64), "reply", "agent_question", ", now(), null"), /email_action_tokens_check/);
  await insertToken("e".repeat(64), "reply", "agent_question", ", now(), 'applied'");
  console.log("OK: email_action_tokens accepts a consumed token with an outcome");

  // email_inbound_events (0012): unique provider event identity, and
  // 'applied' requires a correlated reply token.
  await db.exec(`insert into email_inbound_events (provider_event_id, sanitized_text) values ('evt-1', 'Cambia el título');`);
  let duplicateInboundBlocked = false;
  try {
    await db.exec(`insert into email_inbound_events (provider_event_id) values ('evt-1');`);
  } catch (err) {
    duplicateInboundBlocked = /duplicate key/.test(String(err));
  }
  if (!duplicateInboundBlocked) throw new Error("Expected unique constraint to block a duplicate inbound provider event");
  console.log("OK: email_inbound_events provider_event_id uniqueness enforced");

  let uncorrelatedAppliedBlocked = false;
  try {
    await db.exec(`insert into email_inbound_events (provider_event_id, status) values ('evt-2', 'applied');`);
  } catch (err) {
    uncorrelatedAppliedBlocked = /email_inbound_events_check/.test(String(err));
  }
  if (!uncorrelatedAppliedBlocked) throw new Error("Expected CHECK constraint to block an 'applied' inbound event without a reply token");
  console.log("OK: email_inbound_events rejects 'applied' without a correlated reply token");

  console.log("\nAll migration checks passed.");
  await db.close();
}

main().catch((err) => {
  console.error("Migration check FAILED:", err);
  process.exit(1);
});
