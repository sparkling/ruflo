/**
 * MCP Tool Types for CLI
 *
 * Local type definitions to avoid external imports outside package boundary.
 */

import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface MCPToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface MCPToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/**
 * Maximum parent-directory walk depth. 32 covers any real-world repo layout;
 * monorepos top out at ~12, deeply nested monorepos at ~20.
 */
const MAX_WALK_DEPTH = 32;

/**
 * ADR-0100: find the nearest project root by walking upward from `startDir`
 * (or process.cwd()/CLAUDE_FLOW_CWD if omitted). Per-invocation — never cache
 * at module load; Claude Code CWD drifts mid-session and a cached root will
 * be stale.
 *
 * Marker priority (first match wins):
 *   1. `.ruflo-project` sentinel — explicit contract
 *   2. `CLAUDE.md` AND sibling `.claude/` — init'd project (BOTH required to
 *      skip docs/CLAUDE.md false-positives)
 *   3. `.git/` — generic repo fallback
 *   4. No marker → warn (stderr AND persistent log) + return startDir
 *
 * See docs/adr/ADR-0100-project-root-resolution.md for full rationale and
 * third-order adversarial-review outcomes. See upstream reproduction:
 * https://github.com/ruvnet/ruflo/issues/1639
 */
export function findProjectRoot(startDir?: string): string {
  const start = startDir ?? process.env.CLAUDE_FLOW_CWD ?? process.cwd();

  let dir = start;
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    if (existsSync(join(dir, '.ruflo-project'))) return dir;
    if (existsSync(join(dir, 'CLAUDE.md')) && existsSync(join(dir, '.claude'))) return dir;
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const msg = `[ruflo] No project root marker found from ${start}; falling back to CWD. Consider 'ruflo init' or creating '.ruflo-project'.`;
  console.warn(msg);
  try {
    const logPath = join(homedir(), '.ruflo', 'resolver-warnings.log');
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // best-effort — resolver MUST NOT throw
  }
  return start;
}

/**
 * @deprecated Use findProjectRoot() for ANY artifact/storage path.
 * Only use getDisplayCwd() for user-facing display or logging that genuinely
 * wants the drifting Claude Code CWD (ADR-0100). Renamed from getProjectCwd
 * in 2026-04-23 to force audit of existing callsites.
 */
export function getDisplayCwd(): string {
  return process.env.CLAUDE_FLOW_CWD ?? process.cwd();
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: MCPToolInputSchema;
  category?: string;
  tags?: string[];
  version?: string;
  cacheable?: boolean;
  cacheTTL?: number;
  handler: (input: Record<string, unknown>, context?: Record<string, unknown>) => Promise<MCPToolResult | unknown>;
}
