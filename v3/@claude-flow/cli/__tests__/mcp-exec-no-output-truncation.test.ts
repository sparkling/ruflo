/**
 * Regression: `mcp exec` must NOT truncate large structured tool results.
 *
 * Bug report: `ruflo mcp exec --tool agentdb_hierarchical-query --params
 * '{"pathPattern":"adr/*"}'` returned only ~60 of 287 records even though the
 * underlying data was complete, and the symptom tracked response BYTES (the
 * same query returned ~284 when each record carried a smaller value blob).
 *
 * The `mcp exec` non-JSON branch prints the result via
 * `output.printJson(result)` (commands/mcp.ts). `printJson` delegates to
 * `OutputFormatter.json()` → `JSON.stringify(data, null, 2)` → `writeln`,
 * none of which clamp by row count or byte length. This test pins that
 * contract: a large, many-record result round-trips through the exact display
 * path with EVERY record present and zero byte/char truncation.
 *
 * Scope note: this defends the CLI display path (path "a"). The data-production
 * path (HierarchicalMemory.query / agentdb-orchestration) is verified separately
 * — empirically the live `agentdb_hierarchical-query` returns the full record
 * set (281 records / 274 KB) with no limit, so the tool response is NOT capped.
 * The only row cap in the chain is `MAX_TOP_K=100` applied to the *limit*
 * parameter in mcp-tools/agentdb-tools.ts (owned elsewhere); it does not touch
 * the printed output and is out of scope here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OutputFormatter } from '../src/output.js';

describe('mcp exec — large structured result is printed in full', () => {
  let captured: string[];

  beforeEach(() => {
    captured = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
      captured.push(String(s));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Build a result shaped like agentdb_hierarchical-query's envelope, with a
   * large number of records each carrying a rich value blob — the exact
   * condition under which the reporter saw truncation.
   */
  function buildLargeHierarchicalResult(recordCount: number) {
    const results = Array.from({ length: recordCount }, (_, i) => ({
      id: `mem-${i}`,
      tier: 'semantic',
      content: `adr/${String(i).padStart(4, '0')}-decision`,
      importance: 0.5,
      accessCount: i,
      createdAt: 1_700_000_000_000 + i,
      // Rich value blob: this is what pushed the serialized response over the
      // size where the reporter saw the count collapse from ~284 to ~60.
      metadata: {
        key: `adr/${String(i).padStart(4, '0')}-decision`,
        value: 'x'.repeat(900) + `#${i}`,
      },
    }));
    return { results, controller: 'hierarchicalMemory' };
  }

  it('round-trips all 281 records through printJson with no record dropped', () => {
    const RECORD_COUNT = 281; // matches the live full-set size observed for adr/*
    const result = buildLargeHierarchicalResult(RECORD_COUNT);

    const out = new OutputFormatter({ color: false });
    // This is the precise call execCommand makes for the default (non-JSON)
    // output branch: `output.printJson(result)`.
    out.printJson(result);

    const printed = captured.join('');

    // 1. The serialized output is large (the bug only manifested past a size
    //    threshold) — guards against a future byte cap silently re-appearing.
    expect(printed.length).toBeGreaterThan(250_000);

    // 2. The printed text must be valid, COMPLETE JSON (a byte/char truncation
    //    would corrupt the trailing braces and fail the parse).
    const parsed = JSON.parse(printed) as { results: unknown[]; controller: string };
    expect(parsed.controller).toBe('hierarchicalMemory');

    // 3. Every single record survives — no row cap on the display path.
    expect(parsed.results).toHaveLength(RECORD_COUNT);

    // 4. The FIRST and LAST record keys are both present — proves neither the
    //    head nor the tail of the array was sliced off.
    expect(printed).toContain('"key": "adr/0000-decision"');
    expect(printed).toContain(`"key": "adr/${String(RECORD_COUNT - 1).padStart(4, '0')}-decision"`);
  });

  it('json() returns the full string for a large result (no internal cap)', () => {
    const result = buildLargeHierarchicalResult(300);
    const out = new OutputFormatter({ color: false });

    const serialized = out.json(result); // pretty
    const compact = out.json(result, false);

    // The exact JSON.stringify output length — any clamp would shorten it.
    expect(serialized).toBe(JSON.stringify(result, null, 2));
    expect(compact).toBe(JSON.stringify(result));

    // All 300 records present in both forms.
    expect((JSON.parse(serialized) as { results: unknown[] }).results).toHaveLength(300);
    expect((JSON.parse(compact) as { results: unknown[] }).results).toHaveLength(300);
  });
});
