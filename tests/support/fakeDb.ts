// Minimal in-memory stand-in for the Supabase JS query builder, covering
// exactly the chain shapes used under lib/agent/*. Not a general Postgrest
// reimplementation — it exists so agent business logic (preflight,
// concurrency, budget, revisions, product truth) can be exercised
// deterministically without a live Supabase project (spec section 27).

import { randomUUID } from "node:crypto";

type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "gte" | "lt"; val: unknown };

function nowIso() {
  return new Date().toISOString();
}

function matchesFilters(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const v = row[f.col];
    if (f.op === "eq") return v === f.val;
    if (f.op === "gte") return (v as string) >= (f.val as string);
    if (f.op === "lt") return (v as string) < (f.val as string);
    return true;
  });
}

function checkUniqueConstraints(table: string, candidate: Row, existing: Row[]): string | null {
  if (table === "agent_runs" && candidate.status === "running") {
    const clash = existing.some((r) => r.brand === candidate.brand && r.status === "running");
    if (clash) return `duplicate key value violates unique constraint "agent_runs_one_active_per_brand"`;
  }
  if (table === "marketing_plans" && candidate.status === "active") {
    const clash = existing.some((r) => r.brand === candidate.brand && r.status === "active");
    if (clash) return `duplicate key value violates unique constraint "marketing_plans_one_active_per_brand"`;
  }
  if (table === "content_assets") {
    const clash = existing.some((r) => r.draft_id === candidate.draft_id && r.asset_version === candidate.asset_version);
    if (clash) return `duplicate key value violates unique constraint "content_assets_draft_id_asset_version_key"`;
  }
  return null;
}

function defaultsForTable(table: string): Row {
  switch (table) {
    case "agent_runs":
      return { started_at: nowIso(), completed_at: null, decision: null, summary: null, error_code: null, error_message: null };
    case "content_drafts":
      return { blocked_on_question_id: null, approved_at: null, rejected_at: null, updated_at: nowIso() };
    case "agent_questions":
      return { answer: null, answered_at: null, context_run_id: null, context_plan_id: null, context_draft_id: null, blocks_progress: true };
    case "content_assets":
      return {
        format: "image_post",
        width: null,
        height: null,
        mime_type: "image/png",
        storage_bucket: null,
        storage_path: null,
        render_provenance: {},
        error_message: null,
        approved_at: null,
      };
    default:
      return {};
  }
}

type PgResult<T> = { data: T; error: { code?: string; message: string } | null };

class FakeQueryBuilder<T = unknown> implements PromiseLike<PgResult<T>> {
  private filters: Filter[] = [];
  private orderSpec?: { col: string; ascending: boolean };
  private limitN?: number;
  private mode: "select" | "insert" | "update" = "select";
  private payload: Row | Row[] | null = null;
  private singleMode: "single" | "maybeSingle" | "list" = "list";

  constructor(
    private table: string,
    private store: Map<string, Row[]>
  ) {}

  select() {
    return this;
  }

  insert(payload: Row | Row[]) {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }

  update(payload: Row) {
    this.mode = "update";
    this.payload = payload;
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push({ col, op: "eq", val });
    return this;
  }

  gte(col: string, val: unknown) {
    this.filters.push({ col, op: "gte", val });
    return this;
  }

  lt(col: string, val: unknown) {
    this.filters.push({ col, op: "lt", val });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this.orderSpec = { col, ascending: opts?.ascending ?? true };
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  single() {
    this.singleMode = "single";
    return this;
  }

  maybeSingle() {
    this.singleMode = "maybeSingle";
    return this;
  }

  then<TResult1, TResult2>(
    onfulfilled?: ((value: PgResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled as never, onrejected as never);
  }

  private rows(): Row[] {
    return this.store.get(this.table) ?? [];
  }

  private async execute(): Promise<PgResult<T>> {
    if (this.mode === "insert") {
      const rows = this.rows();
      const items = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const inserted: Row[] = [];
      for (const item of items) {
        const candidate = { id: randomUUID(), created_at: nowIso(), ...defaultsForTable(this.table), ...item };
        const violation = checkUniqueConstraints(this.table, candidate, rows);
        if (violation) {
          return { data: null as T, error: { code: "23505", message: violation } };
        }
        rows.push(candidate);
        inserted.push(candidate);
      }
      this.store.set(this.table, rows);
      return this.finish(inserted);
    }

    if (this.mode === "update") {
      const rows = this.rows();
      const matched = rows.filter((r) => matchesFilters(r, this.filters));
      for (const r of matched) Object.assign(r, this.payload);
      return this.finish(matched);
    }

    let matched = this.rows().filter((r) => matchesFilters(r, this.filters));
    if (this.orderSpec) {
      const { col, ascending } = this.orderSpec;
      matched = [...matched].sort((a, b) => {
        const av = a[col] as string | number | null;
        const bv = b[col] as string | number | null;
        if (av === bv) return 0;
        if (av === null || av === undefined) return ascending ? -1 : 1;
        if (bv === null || bv === undefined) return ascending ? 1 : -1;
        return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
      });
    }
    if (this.limitN != null) matched = matched.slice(0, this.limitN);
    return this.finish(matched);
  }

  private finish(rows: Row[]): PgResult<T> {
    const cloned = rows.map((r) => ({ ...r }));
    if (this.singleMode === "single") {
      if (cloned.length !== 1) {
        return { data: null as T, error: { message: cloned.length === 0 ? "no rows returned" : "multiple rows returned" } };
      }
      return { data: cloned[0] as T, error: null };
    }
    if (this.singleMode === "maybeSingle") {
      return { data: (cloned[0] ?? null) as T, error: null };
    }
    return { data: cloned as T, error: null };
  }
}

export class FakeDb {
  private store = new Map<string, Row[]>();

  from(table: string) {
    return new FakeQueryBuilder(table, this.store);
  }

  seed(table: string, rows: Row[]) {
    this.store.set(table, rows.map((r) => ({ ...r })));
  }

  getAll(table: string): Row[] {
    return (this.store.get(table) ?? []).map((r) => ({ ...r }));
  }
}

export function createFakeDb() {
  return new FakeDb();
}

/**
 * Casts the fake db to the SupabaseClient<Database> shape expected by
 * lib/agent/* so tests satisfy the type checker without duplicating the
 * full Supabase client surface.
 */
export function asSupabaseClient<T>(db: FakeDb): T {
  return db as unknown as T;
}
