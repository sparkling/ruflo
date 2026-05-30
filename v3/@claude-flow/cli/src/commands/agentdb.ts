/**
 * V3 CLI AgentDB command — ADR-0273.
 *
 * `agentdb index` builds the canonical `/adr-index` over all three skill
 * surfaces in ONE in-process pass (no ~780 MCP round-trips), writing through
 * the memory-router facade:
 *   (a) hierarchical  `adr/<id>`      → hierarchicalStore (SQLite, ADR-0176 key map)
 *   (b) causal edges  `causal-edges`  → recordCausalEdge (D8) + 3 derived inverses (D10)
 *   (c) `adr-patterns`                → routeMemoryOp (RVF + embedding)
 *
 * Runs alongside a live MCP server with no stop-server precondition: ADR-0274's
 * read/write handle split (park/unpark on idle) means the rapid write loop
 * coalesces into one flock hold for the batch (D7), and the MCP server's flock
 * is released while idle so this process acquires it.
 */
import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** A parsed ADR record. */
interface AdrRecord {
  id: string;            // ADR-NNNN[letter] — sub-letter preserved (D10/D11)
  file: string;
  title: string;
  status: string;
  date: string;
  tags: string[];
  contextExcerpt: string;
  supersedes: string[];
  dependsOn: string[];
  implements: string[];
}

const ADR_REF = /ADR-\d{1,4}[a-z]?/g;

/** Extract ADR-NNNN[letter] refs from a string (frontmatter list value). */
function extractRefs(s: string): string[] {
  const out = new Set<string>();
  const m = s.match(ADR_REF);
  if (m) for (const r of m) out.add(r);
  return Array.from(out);
}

/** Read a frontmatter scalar/list field as a raw string (between `field:` and EOL). */
function fmField(fm: string, field: string): string {
  const re = new RegExp(`^${field}:\\s*(.*)$`, 'mi');
  const m = re.exec(fm);
  return m ? m[1].trim() : '';
}

/**
 * Strict-ish MADR parser (ADR-0271 canonical shape). Keys off frontmatter
 * (status/date/tags + the 3 relation slots) and the first paragraph of
 * `## Context and Problem Statement` — companions without Options/Outcome still
 * parse (D11). Returns null only when the file has no usable frontmatter.
 */
function parseAdr(absPath: string, filename: string): AdrRecord | null {
  const text = readFileSync(absPath, 'utf-8');
  const idMatch = /^(ADR-\d{1,4}[a-z]?)/.exec(filename);
  if (!idMatch) return null;
  const id = idMatch[1];

  const fmMatch = /^---\s*$([\s\S]*?)^---\s*$/m.exec(text);
  const fm = fmMatch ? fmMatch[1] : '';
  if (!fm) return null; // not a frontmatter ADR — skip (companions all have frontmatter per D11)

  const title =
    (/^#\s+(.+)$/m.exec(text)?.[1] || '').trim() || id;

  const tagsRaw = fmField(fm, 'tags');
  const tags = tagsRaw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  // First paragraph of Context and Problem Statement (excerpt for the value).
  let contextExcerpt = '';
  const ctx = /##\s+Context and Problem Statement\s*\n+([\s\S]*?)(?:\n\s*\n|\n##\s)/.exec(text);
  if (ctx) contextExcerpt = ctx[1].replace(/\s+/g, ' ').trim().slice(0, 600);

  return {
    id,
    file: filename,
    title,
    status: fmField(fm, 'status') || 'unknown',
    date: fmField(fm, 'date'),
    tags,
    contextExcerpt,
    supersedes: extractRefs(fmField(fm, 'supersedes')),
    dependsOn: extractRefs(fmField(fm, 'depends-on')),
    implements: extractRefs(fmField(fm, 'implements')),
  };
}

const indexCommand: Command = {
  name: 'index',
  description: 'Build the canonical ADR index (hierarchical adr/<id> + causal edges + adr-patterns) in one in-process pass',
  options: [
    { name: 'dir', description: 'ADR directory (default: docs/adr)', type: 'string', default: 'docs/adr' },
    { name: 'dry-run', description: 'Parse + report without writing', type: 'boolean', default: false },
    { name: 'purge', description: 'Clear existing adr/* hierarchical + adr-patterns + causal-edges entries before rebuilding (idempotent re-index)', type: 'boolean', default: false },
  ],
  examples: [
    { description: 'Index the corpus under docs/adr', command: 'agentdb index' },
    { description: 'Purge + rebuild (deterministic, no duplicates)', command: 'agentdb index --purge' },
    { description: 'Index a custom directory', command: 'agentdb index --dir docs/adrs' },
    { description: 'Parse + report only', command: 'agentdb index --dry-run' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const dir = resolve(ctx.cwd, (ctx.flags.dir as string) || 'docs/adr');
    const dryRun = ctx.flags['dry-run'] === true;
    const purge = ctx.flags.purge === true;

    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      output.printError(`ADR directory not found: ${dir}`);
      return { success: false, message: `not found: ${dir}`, exitCode: 1 };
    }

    // D11: size to glob(docs/adr/ADR-*.md), include companions, preserve sub-letters.
    const files = readdirSync(dir)
      .filter((f) => /^ADR-\d{1,4}[a-z]?.*\.md$/.test(f))
      .sort();

    if (files.length === 0) {
      output.printError(`No ADR-*.md files in ${dir}`);
      return { success: false, message: 'empty corpus', exitCode: 1 };
    }

    const records: AdrRecord[] = [];
    const skipped: string[] = [];
    for (const f of files) {
      const r = parseAdr(join(dir, f), f);
      if (r) records.push(r);
      else skipped.push(f);
    }

    output.printInfo(`Parsed ${records.length} ADR record(s) from ${dir}${skipped.length ? ` (${skipped.length} skipped: no frontmatter)` : ''}`);

    // Edge plan (forward + 3 derived inverses, D10). Built up-front so dry-run reports it.
    const REL: Array<[keyof AdrRecord, string, string]> = [
      ['supersedes', 'supersedes', 'superseded-by'],
      ['dependsOn', 'depends-on', 'depended-on-by'],
      ['implements', 'implements', 'implemented-by'],
    ];
    let plannedEdges = 0;
    let plannedInverses = 0;
    for (const r of records) {
      for (const [field] of REL) {
        plannedEdges += (r[field] as string[]).length;
        plannedInverses += (r[field] as string[]).length;
      }
    }

    if (dryRun) {
      output.printInfo(`[dry-run] would write: ${records.length} hierarchical records, ${records.length} adr-patterns, ${plannedEdges} forward edges + ${plannedInverses} inverses`);
      return { success: true, message: 'dry-run complete', data: { records: records.length, edges: plannedEdges, inverses: plannedInverses } };
    }

    // Facade — in-process, no MCP listener (ADR-0273 Q2). Cold-starts the
    // registry + archivist + embedder ONCE; the rapid loop below coalesces into
    // one flock hold via the ADR-0274 idle-timer park (D7).
    const { hierarchicalStore, recordCausalEdge } = await import('../mcp-tools/agentdb-orchestration.js');
    const { routeMemoryOp, getController } = await import('../memory/memory-router.js');

    // --purge: clear the 3 surfaces before rebuilding so a re-index is
    // deterministic (HierarchicalMemory.store inserts by synthetic id and
    // causal edges key on a timestamp, so without this a re-run duplicates).
    // This is the canonical purge-then-rebuild (ADR-0271 Phase 3 / WS3) — not an
    // ad-hoc script. NB: in this repo `causal-edges` is the ADR-index edge store;
    // clearNamespace wipes the whole namespace.
    if (purge) {
      output.printInfo('Purging existing adr/* hierarchical + adr-patterns + causal-edges entries…');
      try {
        const hm = await getController<any>('hierarchicalMemory');
        if (hm && typeof hm.query === 'function' && typeof hm.forget === 'function') {
          const existing = await hm.query('adr/*', {});
          let purged = 0;
          for (const e of (existing || [])) {
            const id = (e && (e.id ?? e.memoryId));
            if (!id) continue;
            const ok = await hm.forget(id).then(() => true).catch(() => false);
            if (ok) purged++;
          }
          output.writeln(output.dim(`  purged ${purged}/${(existing || []).length} hierarchical adr/* entr(ies)`));
        } else {
          output.printWarning('hierarchical purge skipped: controller lacks query/forget');
        }
      } catch (e: any) {
        output.printWarning(`hierarchical purge error: ${e?.message || e}`);
      }
      for (const ns of ['adr-patterns', 'causal-edges']) {
        try {
          await routeMemoryOp({ type: 'clearNamespace', namespace: ns } as any);
          output.writeln(output.dim(`  cleared namespace ${ns}`));
        } catch (e: any) {
          output.printWarning(`clearNamespace ${ns} error: ${e?.message || e}`);
        }
      }
    }

    let recCount = 0;
    let patCount = 0;
    let edgeCount = 0;
    let invCount = 0;
    const failures: string[] = [];

    // Surfaces (a) + (c): one record + one adr-patterns entry per ADR.
    for (const r of records) {
      const payload = JSON.stringify({
        id: r.id, title: r.title, status: r.status, date: r.date,
        tags: r.tags, file: r.file, context: r.contextExcerpt,
      });
      try {
        const h = await hierarchicalStore({ key: `adr/${r.id}`, value: payload, tier: 'semantic' });
        if (h?.success) recCount++;
        else failures.push(`hierarchical ${r.id}: ${h?.error || 'failed'}`);
      } catch (e: any) {
        failures.push(`hierarchical ${r.id}: ${e?.message || e}`);
      }
      try {
        const p = await routeMemoryOp({
          type: 'store',
          namespace: 'adr-patterns',
          key: r.id,
          value: `${r.title} — ${r.contextExcerpt}`,
          generateEmbedding: true,
        } as any);
        if ((p as any)?.success) patCount++;
        else failures.push(`adr-patterns ${r.id}: ${(p as any)?.error || 'failed'}`);
      } catch (e: any) {
        failures.push(`adr-patterns ${r.id}: ${e?.message || e}`);
      }
    }

    // Surface (b): edges + derived inverses, after all records exist (D8/D10).
    for (const r of records) {
      for (const [field, rel, inv] of REL) {
        for (const ref of r[field] as string[]) {
          try {
            const fe = await recordCausalEdge({ sourceId: r.id, targetId: ref, relation: rel });
            if (fe.success) edgeCount++; else failures.push(`edge ${r.id}-${rel}->${ref}: ${fe.error}`);
          } catch (e: any) { failures.push(`edge ${r.id}-${rel}->${ref}: ${e?.message || e}`); }
          try {
            const ie = await recordCausalEdge({ sourceId: ref, targetId: r.id, relation: inv });
            if (ie.success) invCount++; else failures.push(`inverse ${ref}-${inv}->${r.id}: ${ie.error}`);
          } catch (e: any) { failures.push(`inverse ${ref}-${inv}->${r.id}: ${e?.message || e}`); }
        }
      }
    }

    output.printSuccess(
      `agentdb index complete: ${recCount}/${records.length} hierarchical records, ${patCount} adr-patterns, ${edgeCount} edges + ${invCount} inverses`,
    );
    if (failures.length) {
      output.printWarning(`${failures.length} write failure(s):`);
      for (const f of failures.slice(0, 20)) output.writeln(output.dim(`  - ${f}`));
    }

    return {
      success: failures.length === 0,
      message: failures.length === 0 ? 'index complete' : `${failures.length} failures`,
      data: { records: recCount, patterns: patCount, edges: edgeCount, inverses: invCount, failures: failures.length },
      exitCode: failures.length === 0 ? 0 : 1,
    };
  },
};

export const agentdbCommand: Command = {
  name: 'agentdb',
  description: 'AgentDB index and maintenance operations',
  subcommands: [indexCommand],
  action: async (): Promise<CommandResult> => {
    output.printInfo('Usage: agentdb index [--dir docs/adr] [--dry-run]');
    return { success: true };
  },
};

export default agentdbCommand;
