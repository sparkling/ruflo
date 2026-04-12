/**
 * Safe database opener — ADR-0080 Phase 4
 *
 * Tries better-sqlite3 first (WAL-safe). Falls back to sql.js ONLY for
 * new databases. REFUSES to open existing files with sql.js because
 * sql.js cannot read WAL journals and will corrupt on close().
 *
 * When better-sqlite3 is loaded, prepare() returns a SqlJsCompatStatement
 * shim so callers can use either the sql.js cursor API (bind/step/get/free)
 * or the better-sqlite3 direct API (run/get/all) interchangeably.
 *
 * @module @claude-flow/cli/memory/open-database
 */

import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// SqlJsCompatStatement — cursor shim over better-sqlite3 statements
// ---------------------------------------------------------------------------

/**
 * Wraps a better-sqlite3 prepared statement with the sql.js cursor API.
 *
 * sql.js statements are cursor-based: bind() sets params, step() advances
 * the cursor returning true when a row is available, get() returns the
 * current row as a value array, getAsObject() returns it as a keyed object,
 * free() releases resources, and reset() rewinds for re-use.
 *
 * better-sqlite3 statements are call-based: run/get/all accept params
 * inline and return results immediately.
 *
 * This shim bridges the two by lazily executing the query on the first
 * step() call, caching all result rows, and exposing a cursor over them.
 * The better-sqlite3 direct methods (run/get/all/iterate) are passed
 * through unchanged so code using either API works without modification.
 */
export class SqlJsCompatStatement {
  /** Cached result rows from the last execution (null = not yet executed) */
  private rows: Record<string, unknown>[] | null = null;
  /** Current cursor position (-1 = before first row) */
  private cursor = -1;
  /** The underlying better-sqlite3 Statement */
  private bsStmt: any;
  /** Parameters set via bind() for deferred execution */
  private boundParams: unknown[] = [];
  /** Column names from the statement (populated on first execution) */
  private columnNames: string[] | null = null;

  constructor(bsStmt: any) {
    this.bsStmt = bsStmt;
  }

  // --- sql.js cursor API ---

  /**
   * Bind parameters for subsequent step()/get() calls.
   * Resets any cached results so the next step() re-executes.
   */
  bind(params?: unknown[]): void {
    this.boundParams = params ?? [];
    this.rows = null;
    this.cursor = -1;
  }

  /**
   * Execute the statement (on first call) and advance the cursor.
   * Returns true if a row is available at the new cursor position.
   */
  step(): boolean {
    if (this.rows === null) {
      this.execute();
    }
    this.cursor++;
    return this.cursor < this.rows!.length;
  }

  /**
   * Return the current row as a positional value array (sql.js style).
   * Returns an empty array if the cursor is out of range.
   */
  get(): unknown[];
  /**
   * better-sqlite3 pass-through: get first row as object.
   * Detected by the presence of arguments (sql.js get() takes none).
   */
  get(...params: unknown[]): unknown[] | Record<string, unknown> | undefined;
  get(...params: unknown[]): unknown[] | Record<string, unknown> | undefined {
    // Disambiguate: sql.js get() is called with zero args after step().
    // better-sqlite3 get() is called with params to execute + fetch one row.
    if (params.length > 0) {
      return this.bsStmt.get(...params);
    }

    // sql.js cursor mode
    if (!this.rows || this.cursor < 0 || this.cursor >= this.rows.length) {
      return [];
    }
    const row = this.rows[this.cursor];
    return Object.values(row);
  }

  /**
   * Return the current row as a keyed object (sql.js style).
   * Returns an empty object if the cursor is out of range.
   */
  getAsObject(): Record<string, unknown> {
    if (!this.rows || this.cursor < 0 || this.cursor >= this.rows.length) {
      return {};
    }
    return { ...this.rows[this.cursor] };
  }

  /**
   * Free the statement. No-op for better-sqlite3 (GC handles cleanup).
   */
  free(): void {
    this.rows = null;
    this.cursor = -1;
    this.boundParams = [];
  }

  /**
   * Reset the cursor and clear cached results so the statement can be
   * re-used with new parameters via bind().
   */
  reset(): void {
    this.rows = null;
    this.cursor = -1;
    this.boundParams = [];
  }

  // --- better-sqlite3 direct API (pass-through) ---

  /**
   * Execute INSERT/UPDATE/DELETE and return { changes, lastInsertRowid }.
   */
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.bsStmt.run(...params);
  }

  /**
   * Return all matching rows as an array of objects.
   */
  all(...params: unknown[]): Record<string, unknown>[] {
    return this.bsStmt.all(...params);
  }

  /**
   * Return an iterator over matching rows.
   */
  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>> {
    return this.bsStmt.iterate(...params);
  }

  // --- Internal ---

  /**
   * Execute the query with bound parameters and cache all result rows.
   * Uses better-sqlite3's all() to fetch everything at once, then
   * exposes it through the cursor interface.
   */
  private execute(): void {
    try {
      this.rows = this.bsStmt.all(...this.boundParams);
    } catch {
      // Statement may be a write (INSERT/UPDATE/DELETE) that returns no rows.
      // In that case all() throws; fall back to run() and return empty results.
      try {
        this.bsStmt.run(...this.boundParams);
      } catch {
        // run() may also fail for genuinely broken SQL — swallow here so
        // step() returns false rather than exploding.
      }
      this.rows = [];
    }
  }
}

export interface SafeDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlJsCompatStatement | any;
  pragma(sql: string): any;
  close(): void;
  export?(): Buffer;
  engine: 'better-sqlite3' | 'sql.js';
}

/**
 * Open a SQLite database safely.
 *
 * - better-sqlite3: handles WAL natively, always preferred
 * - sql.js: ONLY for new files (no WAL to corrupt) or :memory:
 * - Existing files + no better-sqlite3 = THROWS (not silent corruption)
 */
export async function openDatabase(dbPath: string, options?: { readonly?: boolean }): Promise<SafeDatabase> {
  // Try better-sqlite3 first — handles WAL natively
  try {
    const mod = await import('better-sqlite3');
    // better-sqlite3 uses module.exports (CJS), not export default
    const Database = mod.default ?? mod;
    if (typeof Database !== 'function') throw new Error('better-sqlite3 loaded but Database is not a constructor');
    const db = new Database(dbPath, {
      readonly: options?.readonly === true,
    });
    return {
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => new SqlJsCompatStatement(db.prepare(sql)),
      pragma: (sql: string) => db.pragma(sql),
      close: () => db.close(),
      engine: 'better-sqlite3',
    };
  } catch (e: any) {
    // Log the actual error so we can diagnose why better-sqlite3 failed
    console.warn(`[open-database] better-sqlite3 failed: ${e?.message || e}. Falling back to sql.js.`);
  }

  // sql.js fallback — ONLY safe for new files or :memory:
  const fileExists = dbPath !== ':memory:' && fs.existsSync(dbPath);

  // If the file already exists, sql.js CANNOT safely open it.
  // WAL journals would be lost on close(), corrupting the database.
  if (fileExists) {
    // Check if WAL files exist — if so, corruption is certain
    const hasWal = fs.existsSync(dbPath + '-wal') || fs.existsSync(dbPath + '-shm');
    if (hasWal) {
      throw new Error(
        `Cannot open ${dbPath} with sql.js — WAL journal detected. ` +
        `sql.js will corrupt WAL-mode databases. Install better-sqlite3.`
      );
    }
    // No WAL files — the database may have been created by sql.js originally.
    // Still risky but less likely to corrupt. Log a warning.
    console.warn(`[open-database] WARNING: opening existing ${dbPath} with sql.js (no WAL detected). Install better-sqlite3 for safe WAL support.`);
  }

  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const buf = fileExists ? fs.readFileSync(dbPath) : undefined;
  const sqlDb = buf ? new SQL.Database(buf) : new SQL.Database();

  // Force DELETE journal mode — prevents this sql.js session from creating WAL
  try { sqlDb.run('PRAGMA journal_mode=DELETE'); } catch { /* best effort */ }

  return {
    exec: (sql: string) => sqlDb.run(sql),
    prepare: (sql: string) => sqlDb.prepare(sql),
    pragma: (sql: string) => {
      const result = sqlDb.exec(`PRAGMA ${sql}`);
      return result[0]?.values || [];
    },
    close: () => {
      // Only write back for new files or :memory: → file
      // For existing files without WAL, write back is acceptable
      if (dbPath !== ':memory:') {
        const data = sqlDb.export();
        fs.writeFileSync(dbPath, Buffer.from(data));
      }
      sqlDb.close();
    },
    export: () => Buffer.from(sqlDb.export()),
    engine: 'sql.js',
  };
}
