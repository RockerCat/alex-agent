// One-off local verification for supabase/migrations/0004_grant_service_role.sql:
// creates a fake `service_role` (mirroring the Supabase platform role that
// doesn't exist in pglite/vanilla Postgres) and confirms the migration's
// guarded GRANT actually takes effect once that role is present, then
// checks the resulting privileges via information_schema.
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const migrationsDir = path.join(process.cwd(), "supabase", "migrations");

async function main() {
  const db = new PGlite();
  await db.exec("create role service_role;");

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf-8");
    await db.exec(sql);
    console.log(`Applied ${file}`);
  }

  const grants = await db.query(`
    select table_name, privilege_type
    from information_schema.role_table_grants
    where grantee = 'service_role' and table_schema = 'public'
    order by table_name, privilege_type;
  `);

  const expectedTables = [
    "agent_questions",
    "agent_runs",
    "agent_settings",
    "ai_usage",
    "content_assets",
    "content_drafts",
    "content_revisions",
    "marketing_plans",
    "email_action_tokens",
    "email_inbound_events",
  ];
  const expectedPrivileges = ["SELECT", "INSERT", "UPDATE", "DELETE"];

  const byTable = new Map();
  for (const row of grants.rows) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set());
    byTable.get(row.table_name).add(row.privilege_type);
  }

  let ok = true;
  for (const table of expectedTables) {
    const privs = byTable.get(table) ?? new Set();
    const missing = expectedPrivileges.filter((p) => !privs.has(p));
    if (missing.length) {
      ok = false;
      console.error(`MISSING on ${table}: ${missing.join(", ")}`);
    } else {
      console.log(`OK: service_role has ${expectedPrivileges.join("/")} on ${table}`);
    }
  }

  // Also create a table AFTER the migrations run, as a future migration
  // would, and confirm the default-privileges clause covers it too.
  await db.exec("create table public.future_table (id uuid primary key default gen_random_uuid());");
  const futureGrants = await db.query(`
    select privilege_type from information_schema.role_table_grants
    where grantee = 'service_role' and table_schema = 'public' and table_name = 'future_table';
  `);
  const futurePrivs = new Set(futureGrants.rows.map((r) => r.privilege_type));
  const futureMissing = expectedPrivileges.filter((p) => !futurePrivs.has(p));
  if (futureMissing.length) {
    ok = false;
    console.error(`MISSING default privileges on future_table: ${futureMissing.join(", ")}`);
  } else {
    console.log("OK: ALTER DEFAULT PRIVILEGES covers a table created after this migration");
  }

  // approve_asset_if_current (0013) must be executable by service_role
  // only — never PUBLIC (which any other role, incl. anon/authenticated,
  // would inherit).
  await db.exec("create role probe_role;");
  const fnSig = "public.approve_asset_if_current(uuid, uuid, integer)";
  const fnPrivs = await db.query(
    `select has_function_privilege('service_role', $1, 'execute') as service_role_can,
            has_function_privilege('probe_role', $1, 'execute') as other_role_can;`,
    [fnSig]
  );
  if (fnPrivs.rows[0].service_role_can !== true) {
    ok = false;
    console.error("MISSING: service_role EXECUTE on approve_asset_if_current");
  } else {
    console.log("OK: service_role can EXECUTE approve_asset_if_current");
  }
  if (fnPrivs.rows[0].other_role_can !== false) {
    ok = false;
    console.error("UNEXPECTED: a non-service role can EXECUTE approve_asset_if_current (PUBLIC not revoked)");
  } else {
    console.log("OK: other roles (PUBLIC) cannot EXECUTE approve_asset_if_current");
  }

  await db.close();
  if (!ok) {
    console.error("\nGrant check FAILED.");
    process.exit(1);
  }
  console.log("\nAll grant checks passed.");
}

main().catch((err) => {
  console.error("Grant check FAILED:", err);
  process.exit(1);
});
