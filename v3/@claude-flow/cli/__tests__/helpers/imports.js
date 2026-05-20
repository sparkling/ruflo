/**
 * Helper: scan source files for import patterns.
 *
 * Used by arch tests to find forbidden or required import references
 * (both static `from '...'` AND dynamic `await import('...')` syntax).
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * @typedef {Object} FindImportsOptions
 * @property {string[]} roots - Directory paths to scan recursively.
 * @property {RegExp[]} patterns - Patterns that indicate a forbidden import.
 */

/**
 * Walk `roots` recursively, collect .ts/.js files, and return an array of
 * `{ file, line, text }` objects for every line that matches any pattern.
 *
 * @param {FindImportsOptions} options
 * @returns {{ file: string, line: number, text: string }[]}
 */
export function findImports({ roots, patterns }) {
  const offenders = [];

  for (const root of roots) {
    walkDir(root, (filePath) => {
      if (!/\.(ts|js)$/.test(filePath)) return;
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((text, idx) => {
        for (const pattern of patterns) {
          if (pattern.test(text)) {
            offenders.push({ file: filePath, line: idx + 1, text: text.trim() });
            break;
          }
        }
      });
    });
  }

  return offenders;
}

/**
 * Recursively walk a directory, calling `callback` for each file.
 *
 * @param {string} dir
 * @param {(filePath: string) => void} callback
 */
function walkDir(dir, callback) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    // Directory may not exist (e.g. after deletion); skip silently.
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkDir(full, callback);
    } else {
      callback(full);
    }
  }
}
