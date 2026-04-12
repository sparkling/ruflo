/**
 * Safe database opener — ADR-0080 Phase 4
 *
 * Tries better-sqlite3 first (WAL-safe), falls back to sql.js with
 * journal_mode=DELETE forced (prevents WAL corruption).
 *
 * NEVER use raw sql.js on existing .db files — sql.js can't read WAL journals.
 */

import * as fs from 'node:fs';

export interface SafeDatabase {
  exec(sql: string): void;
  prepare(sql: string): any;
  pragma(sql: string): any;
  close(): void;
  /** For sql.js compat: export the database as a Buffer */
  export?(): Buffer;
  /** The underlying engine: 'better-sqlite3' or 'sql.js' */
  engine: 'better-sqlite3' | 'sql.js';
}

/**
 * Open a SQLite database safely.
 * @param dbPath - path to .db file (or ':memory:')
 * @param options - { readonly?: boolean }
 */
export async function openDatabase(dbPath: string, options?: { readonly?: boolean }): Promise<SafeDatabase> {
  // Try better-sqlite3 first
  try {
    const Database = (await import('better-sqlite3')).default;
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
  } catch { /* better-sqlite3 not available — fall through */ }

  // Fallback: sql.js with forced DELETE journal mode
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const buf = fs.existsSync(dbPath) && dbPath !== ':memory:'
    ? fs.readFileSync(dbPath)
    : undefined;
  const sqlDb = buf ? new SQL.Database(buf) : new SQL.Database();

  // CRITICAL: force DELETE journal mode to prevent WAL creation
  // sql.js cannot read WAL journals — this eliminates the corruption vector
  try { sqlDb.run('PRAGMA journal_mode=DELETE'); } catch { /* best effort */ }

  return {
    exec: (sql: string) => sqlDb.run(sql),
    prepare: (sql: string) => sqlDb.prepare(sql),
    pragma: (sql: string) => {
      const result = sqlDb.exec(`PRAGMA ${sql}`);
      return result[0]?.values || [];
    },
    close: () => {
      if (dbPath !== ':memory:' && buf !== undefined) {
        // sql.js requires explicit export+write
        const data = sqlDb.export();
        fs.writeFileSync(dbPath, Buffer.from(data));
      }
      sqlDb.close();
    },
    export: () => Buffer.from(sqlDb.export()),
    engine: 'sql.js',
  };
}
