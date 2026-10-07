// Copy one D1 database into another, from inside the worker (no CLI, no API
// token). Built 2026-10-06 for the "D1 DB is overloaded" incident: the fix is
// a FRESH database (fresh backing process), and the sandbox cannot run
// wrangler. Both databases are bindings (DB + DB_TARGET); the admin page
// /admin/migrate drives these steps and shows progress.
//
// - copySchema: every CREATE TABLE / INDEX / TRIGGER from the source's
//   sqlite_master, as IF NOT EXISTS, so it is idempotent.
// - copyStep: resumable, cursor = (table index, last rowid). Rows go in as
//   INSERT OR IGNORE with their primary keys, so re-running (and the post-switch
//   delta) can never duplicate. Multi-row statements sized under D1's 100
//   bound-parameter limit, batched.
// - tableCounts: per-table COUNT(*) on both sides for the go/no-go check.
//
// Every table in this schema is a rowid table (no WITHOUT ROWID), so
// `rowid > ?` paging is stable even while the source keeps writing.

export interface CopyCursor {
  tables: string[];
  tableIndex: number;
  afterRowid: number;
  copied: number;
}

export interface CopyStepResult {
  cursor: CopyCursor;
  done: boolean;
  /** Rows written in THIS call (all tables). */
  copiedNow: number;
  /** Table being worked on when the budget ran out (null when done). */
  current: string | null;
}

export interface DbLike {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

const MAX_PARAMS = 100; // D1 limit per statement
const ROWS_PER_SELECT = 400;
const STATEMENTS_PER_BATCH = 25;

function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** User tables, in sqlite_master order (skips SQLite internals and D1's own). */
export async function listTables(db: DbLike): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
       ORDER BY rowid`,
    )
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

/** Make a CREATE statement idempotent. */
export function idempotentCreate(sql: string): string {
  return sql
    .replace(/^\s*CREATE\s+TABLE\s+(?!IF NOT EXISTS)/i, "CREATE TABLE IF NOT EXISTS ")
    .replace(/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/i, (_m, u: string | undefined) => `CREATE ${u ?? ""}INDEX IF NOT EXISTS `)
    .replace(/^\s*CREATE\s+TRIGGER\s+(?!IF NOT EXISTS)/i, "CREATE TRIGGER IF NOT EXISTS ");
}

/** Tables first, then indexes/triggers. Returns the statements it ran. */
export async function copySchema(src: DbLike, dst: DbLike): Promise<string[]> {
  const { results } = await src
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
       ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, rowid`,
    )
    .all<{ type: string; name: string; sql: string }>();
  const ran: string[] = [];
  for (const r of results) {
    const sql = idempotentCreate(r.sql);
    await dst.prepare(sql).run();
    ran.push(`${r.type} ${r.name}`);
  }
  return ran;
}

export async function tableColumns(db: DbLike, table: string): Promise<string[]> {
  const { results } = await db.prepare(`PRAGMA table_info(${q(table)})`).all<{ name: string }>();
  return results.map((r) => r.name);
}

export async function startCursor(src: DbLike): Promise<CopyCursor> {
  return { tables: await listTables(src), tableIndex: 0, afterRowid: 0, copied: 0 };
}

/**
 * Copy rows until `budgetMs` elapses or everything is copied. Resumable:
 * feed the returned cursor back in. Throws on a D1 error (the caller retries
 * with the same cursor — nothing is lost, INSERT OR IGNORE makes the overlap
 * harmless).
 */
export async function copyStep(
  src: DbLike,
  dst: DbLike,
  cursor: CopyCursor,
  budgetMs = 20_000,
  now: () => number = () => Date.now(),
): Promise<CopyStepResult> {
  const started = now();
  const c: CopyCursor = { ...cursor, tables: [...cursor.tables] };
  let copiedNow = 0;
  while (c.tableIndex < c.tables.length) {
    const table = c.tables[c.tableIndex]!;
    const cols = await tableColumns(src, table);
    if (cols.length === 0) {
      c.tableIndex++;
      c.afterRowid = 0;
      continue;
    }
    const rowsPerStmt = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
    const colList = cols.map(q).join(", ");
    const tuple = `(${cols.map(() => "?").join(", ")})`;
    const { results } = await src
      .prepare(`SELECT rowid AS __rid, ${colList} FROM ${q(table)} WHERE rowid > ?1 ORDER BY rowid LIMIT ?2`)
      .bind(c.afterRowid, ROWS_PER_SELECT)
      .all<Record<string, unknown>>();
    if (results.length === 0) {
      c.tableIndex++;
      c.afterRowid = 0;
      continue;
    }
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < results.length; i += rowsPerStmt) {
      const chunk = results.slice(i, i + rowsPerStmt);
      const sql = `INSERT OR IGNORE INTO ${q(table)} (${colList}) VALUES ${chunk.map(() => tuple).join(", ")}`;
      const binds: unknown[] = [];
      for (const row of chunk) for (const col of cols) binds.push(row[col] ?? null);
      statements.push(dst.prepare(sql).bind(...binds));
    }
    for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) {
      await dst.batch(statements.slice(i, i + STATEMENTS_PER_BATCH));
    }
    c.afterRowid = Number(results[results.length - 1]!["__rid"]);
    c.copied += results.length;
    copiedNow += results.length;
    if (results.length < ROWS_PER_SELECT) {
      c.tableIndex++;
      c.afterRowid = 0;
    }
    if (now() - started >= budgetMs) break;
  }
  const done = c.tableIndex >= c.tables.length;
  return { cursor: c, done, copiedNow, current: done ? null : c.tables[c.tableIndex]! };
}

export interface TableCount {
  table: string;
  src: number | null;
  dst: number | null;
}

/** COUNT(*) per source table on both sides; null = that side errored/missing. */
export async function tableCounts(src: DbLike, dst: DbLike): Promise<TableCount[]> {
  const tables = await listTables(src);
  const out: TableCount[] = [];
  for (const table of tables) {
    const count = async (db: DbLike): Promise<number | null> => {
      try {
        const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${q(table)}`).first<{ n: number }>();
        return row?.n ?? 0;
      } catch {
        return null;
      }
    };
    out.push({ table, src: await count(src), dst: await count(dst) });
  }
  return out;
}
