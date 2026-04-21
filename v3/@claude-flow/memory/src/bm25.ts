/**
 * bm25.ts — BM25 Okapi lexical ranking for the hash-fallback embedding path.
 *
 * When the embedding pipeline is running in `hash-fallback` mode (no ONNX /
 * ruvector available), the produced vectors are deterministic but non-semantic,
 * so cosine similarity cannot connect a query like "authentication JWT" to a
 * key/value pair like `jwt-auth` / "authentication with JWT refresh tokens".
 * The result is that `memory search` returns noise or nothing at all, which
 * previously had to be silenced with fallback branches in acceptance checks
 * (an ADR-0082 violation).
 *
 * This module provides a small, dependency-free BM25 implementation that
 * tokenizes the concatenated (key + value + tags) text of each memory entry
 * against the tokenized query. It is intentionally self-contained so it can
 * be dynamically imported by the CLI search path without pulling new deps.
 *
 * BM25 parameters use the standard Robertson/Walker defaults (k1 = 1.2,
 * b = 0.75). Scores are unbounded but monotonic; the CLI does not threshold
 * them (any positive score indicates at least one query term match).
 *
 * ADR-0082: this module fails loudly — if the tokenizer produces zero tokens
 * for the query, `bm25Rank` throws. It must never silently return [].
 *
 * @module @claude-flow/memory/bm25
 */

import type { MemoryEntry } from './types.js';

export interface Bm25Options {
  /** Term saturation parameter. Default: 1.2 */
  k1?: number;
  /** Length normalization parameter. Default: 0.75 */
  b?: number;
  /** Maximum results to return (after sorting by score desc). Default: 10 */
  limit?: number;
}

export interface Bm25Result {
  entry: MemoryEntry;
  score: number;
}

/**
 * Lightweight tokenizer: lowercase, split on non-alphanumeric, drop empties
 * and 1-char tokens. Keeps hyphen-separated words (e.g. `jwt-auth`) joined
 * only after splitting on the hyphen, so `jwt-auth` yields ['jwt', 'auth'].
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  // Unicode-aware word split: any run of letters/digits is a token.
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = m[0].toLowerCase();
    if (t.length >= 2) tokens.push(t);
  }
  return tokens;
}

/**
 * Rank memory entries against a query using BM25 Okapi.
 *
 * @throws when the query tokenizes to zero tokens. This is deliberate —
 *   silently returning [] would mask test setup bugs (e.g. passing an empty
 *   string through the CLI flag parser) and is an ADR-0082 violation.
 */
export function bm25Rank(
  query: string,
  entries: MemoryEntry[],
  options?: Bm25Options,
): Bm25Result[] {
  const k1 = options?.k1 ?? 1.2;
  const b = options?.b ?? 0.75;
  const limit = options?.limit ?? 10;

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    throw new Error(
      `bm25Rank: query tokenized to zero tokens (query=${JSON.stringify(query)}). ` +
        `This usually means the search query is empty or contains only punctuation.`,
    );
  }

  if (entries.length === 0) {
    return [];
  }

  // Build per-entry token lists (key + content + tags joined with space).
  const docTokens: string[][] = entries.map((e) => {
    const parts: string[] = [e.key ?? '', e.content ?? ''];
    if (Array.isArray(e.tags) && e.tags.length > 0) parts.push(e.tags.join(' '));
    return tokenize(parts.join(' '));
  });

  const N = entries.length;
  const avgdl = docTokens.reduce((s, toks) => s + toks.length, 0) / N || 1;

  // Document frequency per unique query term.
  const uniqueQueryTerms = Array.from(new Set(queryTokens));
  const df = new Map<string, number>();
  for (const term of uniqueQueryTerms) {
    let count = 0;
    for (const toks of docTokens) {
      if (toks.includes(term)) count++;
    }
    df.set(term, count);
  }

  // IDF with the standard BM25 `+ 0.5` smoothing + floor at epsilon so rare
  // terms in tiny corpora (N < 3) don't go negative and cancel real matches.
  const EPSILON = 1e-6;
  const idf = new Map<string, number>();
  for (const term of uniqueQueryTerms) {
    const n = df.get(term) ?? 0;
    const raw = Math.log((N - n + 0.5) / (n + 0.5) + 1);
    idf.set(term, Math.max(raw, EPSILON));
  }

  const scored: Bm25Result[] = [];
  for (let i = 0; i < N; i++) {
    const toks = docTokens[i];
    const dl = toks.length;
    if (dl === 0) continue;

    // Term frequencies in this document (only for query terms).
    const tf = new Map<string, number>();
    for (const t of toks) {
      if (idf.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    if (tf.size === 0) continue; // no query terms matched — skip

    let score = 0;
    for (const [term, freq] of tf) {
      const termIdf = idf.get(term)!;
      const numerator = freq * (k1 + 1);
      const denominator = freq + k1 * (1 - b + b * (dl / avgdl));
      score += termIdf * (numerator / denominator);
    }

    if (score > 0) scored.push({ entry: entries[i], score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
