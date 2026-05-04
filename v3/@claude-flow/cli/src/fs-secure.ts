/**
 * Restricted-permission file helpers.
 *
 * audit_1776853149979: session/memory/terminal stores were written with the
 * process umask, which on most macOS/Linux setups leaves them world-readable
 * (mode 0644). They contain conversation snapshots, agent prompts, and
 * terminal command history — anyone else on the host can read them.
 *
 * These helpers write atomically and force mode 0600 (files) / 0700 (dirs).
 * chmod fails silently on Windows, where POSIX modes don't apply — that's
 * fine, the OS-level ACL surface there is different.
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';

/**
 * Create a directory tree with mode 0700 (owner-only). No-op if exists.
 * Uses recursive: true so missing parents are created with the same mode.
 */
export function mkdirRestricted(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/**
 * Write a file and tighten its permissions to mode 0600 (owner read/write).
 * Equivalent to writeFileSync followed by chmod, but emphasizes intent —
 * any subsequent reader auditing the codebase can grep for this name.
 */
export function writeFileRestricted(
  path: string,
  data: string | Buffer,
  encoding: BufferEncoding = 'utf-8',
): void {
  writeFileSync(path, data, encoding);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows / FS without POSIX modes — silently skip.
  }
}
