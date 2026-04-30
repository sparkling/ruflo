/**
 * JSON Security Utilities
 *
 * Defends against prototype-pollution attacks via __proto__ / constructor /
 * prototype keys in JSON-serialized values from untrusted sources (e.g.,
 * sibling-process writes to a shared SQLite database).
 *
 * Ported from upstream commit e50df6722 (issue #1558) via ADR-0111
 * orphan-deletion audit item #15. Upstream applied this to sqljs-backend.ts
 * which our fork deleted (ADR-0086); the same vulnerability class exists in
 * agentdb-backend.ts's SQLite-backed memory path (STORAGE_BACKEND=agentdb-sqlite).
 *
 * @module v3/memory/json-security
 */

const POLLUTING_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

/**
 * Parse JSON with prototype-pollution defense. Strips __proto__, constructor,
 * and prototype keys from objects in the parsed value tree. Use this in place
 * of `JSON.parse` whenever the input string comes from untrusted storage
 * (peer processes, on-disk SQL rows, network).
 *
 * Behavioral notes:
 * - Benign JSON (no polluting keys) is unaffected.
 * - Top-level pollution (`{"__proto__": {...}}` at root) is neutralized.
 * - Nested pollution at any depth is neutralized.
 * - Arrays and primitive values pass through unchanged.
 *
 * Uses `Object.prototype.hasOwnProperty.call(...)` instead of
 * `value.hasOwnProperty(...)` to defend against rows that have already
 * poisoned `hasOwnProperty` itself.
 *
 * @throws SyntaxError if `s` is not valid JSON (same contract as JSON.parse).
 */
export function safeJsonParse<T>(s: string): T {
  return JSON.parse(s, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const k of POLLUTING_KEYS) {
        if (Object.prototype.hasOwnProperty.call(value, k)) {
          delete (value as Record<string, unknown>)[k];
        }
      }
    }
    return value;
  }) as T;
}
