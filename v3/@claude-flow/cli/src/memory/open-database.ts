/**
 * Safe database opener — ADR-0080 Phase 4
 *
 * Tries better-sqlite3 first (WAL-safe). Falls back to sql.js ONLY for
 * new databases. REFUSES to open existing files with sql.js because
 * sql.js cannot read WAL journals and will corrupt on close().
 *
 * @module @claude-flow/cli/memory/open-database
 */

import * as fs from 'node:fs';

export interface SafeDatabase {
  exec(sql: string): void;
  prepare(sql: string): any;
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
      readonly: options?.readonly,
    });
    return {
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => db.prepare(sql),
      pragma: (sql: string) => db.pragma(sql),
      close: () => db.close(),
      engine: 'better-sqlite3',
    };
  } catch { /* better-sqlite3 not available — try sql.js below */ }

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
