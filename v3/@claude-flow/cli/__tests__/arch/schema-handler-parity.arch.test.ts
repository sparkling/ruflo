/**
 * Arch-test: schema-vs-handler parity (ADR-0241 / Option B).
 *
 * For every MCP tool registered by any `cli/src/mcp-tools/*-tools.ts` registry,
 * enumerate every field listed in `inputSchema.required` and assert that the
 * handler does NOT silently default the value when the field is omitted at
 * call-time.
 *
 * Background (F-14-001):
 *   The fork's `memory_store` shipped
 *     inputSchema.required = ['key', 'value', 'namespace']
 *   while the handler did
 *     const namespace = (input.namespace as string) || 'default'
 *   creating an asymmetry where strict MCP clients refused the call and
 *   permissive clients defaulted to the `'default'` namespace — silent data
 *   partitioning by client-strictness. ADR-0241 Option D1 relaxes the
 *   schema (drops `'namespace'` from `required`), aligning with upstream's
 *   permissive posture. This arch-test guards against the *class* of
 *   defect — any future tool that re-introduces the asymmetry fails CI.
 *
 * Approach:
 *   - Discover all `export const \w*Tools: MCPTool[] = [` declarations in
 *     `cli/src/mcp-tools/*.ts` via static source scan.
 *   - For each declaration, extract every `{ name: '...', inputSchema: { ...,
 *     required: [...] }, handler: async (input, ...) => { <body> } }` shape.
 *   - For every field in `required`, scan the handler body for a defaulting
 *     pattern on that field — e.g.
 *       (input.<field> as string) || '...'
 *       input.<field> ?? '...'
 *       input['<field>'] || '...'
 *     Presence of such a pattern is the F-14-001 asymmetry. The arch-test
 *     fails with the offending `(tool, field, line)` triple.
 *
 *   The pattern matcher is deliberately narrow — it only flags `<value> ||
 *   <literal>` and `<value> ?? <literal>` shapes where the LHS is the
 *   `input.<field>` access. Defaults to non-literal expressions (function
 *   calls, env vars, etc.) are not asymmetries because the handler is
 *   communicating that the field is genuinely optional with a derived
 *   default, not silently substituting a hardcoded string for a value the
 *   schema swore was always present.
 *
 *   For tools where the handler legitimately does NOT default a required
 *   field (e.g. `memory_retrieve` post-fix throws `"'namespace' is required"`
 *   when missing), no offender is reported and the test passes.
 *
 * Iterator (`forEachToolRequiredField`):
 *   Single source of truth for "which (tool, requiredField) pairs are we
 *   asserting parity on?" — register a new tool registry in one place and
 *   the test picks it up automatically. Future-proofs against new tools
 *   shipping schemas the arch-test doesn't cover.
 *
 * Test count: ~167 required-field declarations across 29 registries
 * (~250-300 (tool, field) pairs once `required: [...]` arrays are expanded).
 * Each test is a synchronous regex scan of the handler body — <50ms total.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve paths: __tests__/arch/ -> __tests__/ -> cli/ -> @claude-flow/ -> v3/ -> ruflo/
const CLI_PKG_DIR = resolve(__dirname, '../..');
const MCP_TOOLS_DIR = resolve(CLI_PKG_DIR, 'src/mcp-tools');

interface ToolShape {
  registry: string;        // e.g. 'memoryTools'
  file: string;            // absolute path to the source file
  toolName: string;        // e.g. 'memory_store'
  required: string[];      // schema-declared required fields
  handlerBody: string;     // source text of the handler arrow function body
  handlerStartLine: number; // 1-indexed line where the handler arrow function starts in the file
}

/**
 * forEachToolRequiredField — single-source-of-truth iterator.
 *
 * Walks every `cli/src/mcp-tools/*.ts` file, extracts every
 * `(tool, requiredField)` pair from the registered `export const \w*Tools:
 * MCPTool[] = [...]` declarations, and yields them to the callback.
 *
 * The callback receives the full `ToolShape` plus the specific
 * `requiredField` being asserted, so the caller can run any per-pair check
 * (the arch-test below runs a defaulting-pattern scan; future callers could
 * run different assertions on the same enumeration).
 *
 * Public surface so additional arch-tests can reuse the iterator instead
 * of duplicating the discovery / parse logic.
 */
export function forEachToolRequiredField(
  callback: (shape: ToolShape, requiredField: string) => void,
): void {
  const sourceFiles = readdirSync(MCP_TOOLS_DIR)
    .filter((f) => f.endsWith('-tools.ts'))
    .map((f) => join(MCP_TOOLS_DIR, f))
    .filter((p) => {
      try { return statSync(p).isFile(); } catch { return false; }
    });

  for (const file of sourceFiles) {
    const source = readFileSync(file, 'utf8');
    const shapes = extractToolShapes(file, source);
    for (const shape of shapes) {
      for (const field of shape.required) {
        callback(shape, field);
      }
    }
  }
}

/**
 * Best-effort textual extractor for `MCPTool` declarations inside an
 * `export const <registry>Tools: MCPTool[] = [ ... ]` literal.
 *
 * Not a full TS parser — relies on the consistent shape that every tool
 * declaration in this codebase follows:
 *   {
 *     name: 'tool_name',
 *     ...
 *     inputSchema: { type: 'object', properties: {...}, required: [...] },
 *     handler: async (input, ...) => { ... },
 *   }
 *
 * If a future tool deviates from this shape, the extractor will quietly
 * skip it — but the iterator's invariant ("we yield every (tool, field)
 * pair the gate can verify") holds, because the unverifiable shape would
 * also escape any other strict static check.
 */
function extractToolShapes(file: string, source: string): ToolShape[] {
  const shapes: ToolShape[] = [];

  // Find each `export const <Registry>Tools: MCPTool[] = [` so we can attribute
  // every tool to a registry name in the error message.
  const registryRe = /export\s+const\s+(\w+Tools)\s*:\s*MCPTool\[\]\s*=/g;
  let registryMatch: RegExpExecArray | null;
  while ((registryMatch = registryRe.exec(source)) !== null) {
    const registry = registryMatch[1];

    // Walk the source linearly from the registry declaration looking for
    // tool object boundaries. We need to find each `{ name: '...', ...,
    // handler: async (input, ...) => { ... } }` block.
    // Use a naive approach: split on `name: '` markers within the registry's
    // array literal — each one introduces a new tool.
    const nameRe = /name:\s*['"]([\w_]+)['"]/g;
    let nameMatch: RegExpExecArray | null;
    nameRe.lastIndex = registryMatch.index;
    while ((nameMatch = nameRe.exec(source)) !== null) {
      const toolName = nameMatch[1];
      const startIdx = nameMatch.index;

      // Find the `required: [` for this tool — must come AFTER the name and
      // BEFORE the next `name: '` (the next tool in the array).
      const nextNameMatch = nameRe.exec(source);
      nameRe.lastIndex = nameMatch.index + nameMatch[0].length;
      const endIdx = nextNameMatch ? nextNameMatch.index : source.length;
      const toolBlock = source.slice(startIdx, endIdx);

      // Strip `//` line comments AND `/* … */` block comments before scanning
      // for `required:` — comments that happen to mention the pattern (e.g.
      // a divergence marker citing `required: ['key', 'value']` from upstream
      // ADR-0241's relax) would otherwise match the first hit and shadow the
      // real schema below. Inline replacement is safe because we never index
      // back into the stripped string — only consume the regex match.
      const codeOnly = toolBlock
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');

      // Extract `required: [...]` — only the first `required:` belongs to
      // the tool's inputSchema (handlers don't have a `required:` key).
      const requiredMatch = /required:\s*\[([^\]]*)\]/.exec(codeOnly);
      if (!requiredMatch) continue;
      const requiredFields = requiredMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter((s) => s.length > 0);
      if (requiredFields.length === 0) continue;

      // Extract the handler arrow function body. Match `handler: async (input,
      // ...) => {` and capture until the matching closing brace via a balanced
      // brace walk (regex alone cannot do this reliably for nested blocks).
      const handlerOpenMatch = /handler:\s*async\s*\([^)]*\)\s*=>\s*\{/.exec(toolBlock);
      if (!handlerOpenMatch) continue;

      const bodyStartLocal = handlerOpenMatch.index + handlerOpenMatch[0].length;
      let depth = 1;
      let bodyEndLocal = bodyStartLocal;
      while (bodyEndLocal < toolBlock.length && depth > 0) {
        const ch = toolBlock[bodyEndLocal];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        bodyEndLocal++;
      }
      if (depth !== 0) continue;
      const handlerBody = toolBlock.slice(bodyStartLocal, bodyEndLocal - 1);

      // Compute 1-indexed line number of the handler's opening line in the
      // original source for nicer error messages.
      const handlerAbsIdx = startIdx + handlerOpenMatch.index;
      const handlerStartLine = source.slice(0, handlerAbsIdx).split('\n').length;

      shapes.push({
        registry,
        file,
        toolName,
        required: requiredFields,
        handlerBody,
        handlerStartLine,
      });

      // Rewind nameRe so the outer loop sees the next tool.
      if (nextNameMatch) {
        nameRe.lastIndex = nextNameMatch.index;
      } else {
        break;
      }
    }
  }

  return shapes;
}

/**
 * Scan the handler body for a defaulting expression on `input.<field>`.
 *
 * Patterns flagged (F-14-001 asymmetry):
 *   (input.<field> as string) || 'literal'
 *   input.<field> || 'literal'
 *   input.<field> ?? 'literal'
 *   input['<field>'] || 'literal'
 *   input["<field>"] ?? 'literal'
 *
 * Patterns NOT flagged (legitimate optional-field handling):
 *   input.<field> || someFunction()
 *   input.<field> ?? deriveFrom(other)
 *   input.<field> || process.env.X
 *   const x = input.<field>; if (!x) { ... } — explicit branching is fine
 *
 * The literal-RHS narrowness is intentional: a string-literal default is
 * the exact F-14-001 shape ("schema says required but handler silently
 * substitutes a hardcoded value"). A computed/derived default is the
 * handler communicating that the field is genuinely derivable.
 */
function findDefaultingPattern(handlerBody: string, field: string): { line: number; text: string } | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Build a pattern that matches the input access (with optional `as ...` cast
  // and optional surrounding parens) followed by `||` or `??` and a string
  // literal.
  // input.<field>  OR  input['<field>']  OR  input["<field>"]
  const accessPart = `(?:input\\.${escaped}|input\\[['"]${escaped}['"]\\])`;

  // Allow optional `as <Type>` cast inside the parens, OR a bare access.
  // Match either `(input.<field> as <Type>)` or just the access.
  const lhsPart = `(?:\\(\\s*${accessPart}\\s+as\\s+[\\w\\[\\]<>|& ,'"_-]+\\s*\\)|${accessPart})`;

  // Defaulting operators: ||  ??
  const opPart = `(?:\\|\\||\\?\\?)`;

  // Literal RHS: 'string' | "string" | `template` | true | false | number | null | array literal
  const literalPart = `(?:'[^']*'|"[^"]*"|\`[^\`]*\`|true|false|null|\\[[^\\]]*\\]|\\d+(?:\\.\\d+)?)`;

  const defaultingRe = new RegExp(`${lhsPart}\\s*${opPart}\\s*${literalPart}`);

  const lines = handlerBody.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (defaultingRe.test(lines[i])) {
      return { line: i, text: lines[i].trim() };
    }
  }
  return null;
}

/**
 * Known-debt baseline of `(tool, requiredField)` pairs where the handler
 * defaults the value with a literal — recorded as PRE-EXISTING violations
 * that ADR-0241 documents but does not in-scope fix.
 *
 * Add entries here ONLY by appending a comment with:
 *   - the upstream provenance (if upstream ships the same defect)
 *   - the disposition (`fix-deferred-fork-only-divergence` /
 *     `fix-deferred-upstream-inherited`)
 *   - the ADR or issue tracking the eventual reconciliation
 *
 * The gate's job is to prevent NEW asymmetries from landing. Items in this
 * baseline trip the gate the moment any other condition changes (the tool
 * gets renamed, the field gets renamed, etc.), forcing a re-decision.
 *
 * Listed entries:
 *   - `agentTools.agent_pool.action`: upstream-inherited
 *     (`ruvnet/ruflo/v3/.../agent-tools.ts:503` ships the identical
 *     `(input.action as string) || 'status'` against the same
 *     `required: ['action']` schema). Option D1 fix would re-diverge a
 *     5-line surface against upstream byte-identical; deferred to a
 *     future ADR-0241 follow-up that batches upstream-inherited
 *     asymmetries with INTEGRATION-LEDGER coverage.
 */
const KNOWN_BASELINE: ReadonlySet<string> = new Set<string>([
  'agentTools.agent_pool.action',
]);

// Build the test matrix eagerly so vitest can generate one `it()` per pair.
interface MatrixEntry {
  shape: ToolShape;
  field: string;
}
const matrix: MatrixEntry[] = [];
forEachToolRequiredField((shape, field) => {
  matrix.push({ shape, field });
});

describe('schema-handler parity (ADR-0241)', () => {
  it('iterator discovers at least one tool with required fields', () => {
    // Sanity check: if the iterator returns 0 pairs, the extractor is broken
    // and every assertion below is a vacuous pass. Failing loudly here is
    // the canary.
    expect(matrix.length).toBeGreaterThan(50);
  });

  for (const { shape, field } of matrix) {
    const baselineKey = `${shape.registry}.${shape.toolName}.${field}`;
    const testName = `${shape.registry}.${shape.toolName}: handler does not silently default required field '${field}'`;
    it(testName, () => {
      const offender = findDefaultingPattern(shape.handlerBody, field);

      if (KNOWN_BASELINE.has(baselineKey)) {
        // Baselined: assert the defect IS still present (so the baseline
        // doesn't go stale when someone unrelatedly fixes the handler) and
        // does not regress in the other direction.
        if (offender === null) {
          throw new Error(
            `ADR-0241 baseline stale: '${baselineKey}' is listed in KNOWN_BASELINE ` +
            `but the handler no longer defaults '${field}' on a literal. Remove the ` +
            `entry from KNOWN_BASELINE — the underlying defect was fixed.`,
          );
        }
        expect(offender).not.toBeNull();
        return;
      }

      if (offender !== null) {
        const absoluteLine = shape.handlerStartLine + offender.line;
        throw new Error(
          `ADR-0241 schema-handler asymmetry: tool '${shape.toolName}' (registry ${shape.registry}) ` +
          `declares '${field}' in inputSchema.required but the handler defaults it on a literal at\n` +
          `  ${shape.file}:${absoluteLine}\n` +
          `  ${offender.text}\n` +
          `Either:\n` +
          `  (a) drop '${field}' from inputSchema.required (handler is genuinely permissive, like memory_store post-ADR-0241 §Option D1), OR\n` +
          `  (b) remove the literal default and let the handler reject the missing field with a structured error (like memory_retrieve / memory_delete).`,
        );
      }
      expect(offender).toBeNull();
    });
  }
});
