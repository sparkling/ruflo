/**
 * MCP Tool Types for CLI
 *
 * Local type definitions to avoid external imports outside package boundary.
 */

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
 * ADR-0137: `findProjectRoot()` was relocated to `@claude-flow/shared` so the
 * memory package (which cannot import from cli — that inverts the dependency
 * graph) can share the same primitive. Re-exported here so every existing
 * `import { findProjectRoot } from '.../mcp-tools/types.js'` callsite and the
 * paired test keep resolving unchanged. See ADR-0100 for the marker rules.
 */
export { findProjectRoot, assertProjectRootAnchored } from '@claude-flow/shared/fs';

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
