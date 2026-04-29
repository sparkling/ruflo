/**
 * MCP Configuration Generator
 * Creates .mcp.json for Claude Code MCP server integration
 * Handles cross-platform compatibility (Windows requires cmd /c wrapper)
 */

import { execSync } from 'node:child_process';
import type { InitOptions, MCPConfig } from './types.js';

/**
 * Check if running on Windows
 */
function isWindows(): boolean {
  return process.platform === 'win32';
}

// ADR-0104 §4a: detect a globally-installed `claude-flow` so init can write
// `.mcp.json` with a direct path. Eliminates ~5–8s `npx -y` cold start that
// exceeds claude-code's MCP handshake budget in `-p` mode.
// Cached at module load — `init` runs once per project.
let cachedClaudeFlowPath: string | null | undefined;
function detectClaudeFlowPath(): string | null {
  if (cachedClaudeFlowPath !== undefined) return cachedClaudeFlowPath;
  const cmd = isWindows() ? 'where claude-flow' : 'which claude-flow';
  try {
    const out = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    // `where` may return multiple lines on Windows — take the first.
    const path = out.split(/\r?\n/)[0].trim();
    cachedClaudeFlowPath = path || null;
  } catch {
    cachedClaudeFlowPath = null;
  }
  return cachedClaudeFlowPath ?? null;
}

/**
 * Generate platform-specific MCP server entry
 * - Windows: uses 'cmd /c npx' directly
 * - Unix: uses 'npx' directly (simple, reliable)
 */
function createMCPServerEntry(
  npxArgs: string[],
  env: Record<string, string>,
  additionalProps: Record<string, unknown> = {}
): object {
  if (isWindows()) {
    return {
      command: 'cmd',
      args: ['/c', 'npx', '-y', ...npxArgs],
      env,
      ...additionalProps,
    };
  }

  // Unix: direct npx invocation — simple and reliable
  return {
    command: 'npx',
    args: ['-y', ...npxArgs],
    env,
    ...additionalProps,
  };
}

/**
 * Build the `claude-flow` MCP server entry. Prefers a directly-resolved path
 * over `npx -y` to avoid the cold-start that breaks claude-code MCP attach
 * in `-p` mode (ADR-0104 §4a). Falls back to npx when not globally installed.
 */
function createClaudeFlowEntry(env: Record<string, string>): object {
  const cfPath = detectClaudeFlowPath();
  if (cfPath) {
    return {
      command: cfPath,
      args: ['mcp', 'start'],
      env,
    };
  }
  return createMCPServerEntry(
    ['@claude-flow/cli@latest', 'mcp', 'start'],
    env,
    {}
  );
}

/**
 * Generate MCP configuration
 */
export function generateMCPConfig(options: InitOptions): object {
  const config = options.mcp;
  const mcpServers: Record<string, object> = {};

  const npmEnv = {
    npm_config_update_notifier: 'false',
  };

  // Claude Flow MCP server (core)
  if (config.claudeFlow) {
    mcpServers['claude-flow'] = createClaudeFlowEntry({
      ...npmEnv,
      CLAUDE_FLOW_MODE: 'v3',
      CLAUDE_FLOW_HOOKS_ENABLED: 'true',
      CLAUDE_FLOW_TOPOLOGY: options.runtime.topology,
      CLAUDE_FLOW_MAX_AGENTS: String(options.runtime.maxAgents),
      CLAUDE_FLOW_MEMORY_BACKEND: options.runtime.memoryBackend,
    });
  }

  // Ruv-Swarm MCP server (enhanced coordination)
  if (config.ruvSwarm) {
    mcpServers['ruv-swarm'] = createMCPServerEntry(
      ['ruv-swarm', 'mcp', 'start'],
      { ...npmEnv },
      { optional: true }
    );
  }

  // Flow Nexus MCP server (cloud features)
  if (config.flowNexus) {
    mcpServers['flow-nexus'] = createMCPServerEntry(
      ['flow-nexus@latest', 'mcp', 'start'],
      { ...npmEnv },
      { optional: true, requiresAuth: true }
    );
  }

  return { mcpServers };
}

/**
 * Generate .mcp.json as formatted string
 */
export function generateMCPJson(options: InitOptions): string {
  const config = generateMCPConfig(options);
  return JSON.stringify(config, null, 2);
}

/**
 * Generate MCP server add commands for manual setup
 */
export function generateMCPCommands(options: InitOptions): string[] {
  const commands: string[] = [];
  const config = options.mcp;

  if (isWindows()) {
    if (config.claudeFlow) {
      commands.push('claude mcp add claude-flow -- cmd /c npx -y @claude-flow/cli@latest mcp start');
    }
    if (config.ruvSwarm) {
      commands.push('claude mcp add ruv-swarm -- cmd /c npx -y ruv-swarm mcp start');
    }
    if (config.flowNexus) {
      commands.push('claude mcp add flow-nexus -- cmd /c npx -y flow-nexus@latest mcp start');
    }
  } else {
    if (config.claudeFlow) {
      commands.push("claude mcp add claude-flow -- npx -y @claude-flow/cli@latest mcp start");
    }
    if (config.ruvSwarm) {
      commands.push("claude mcp add ruv-swarm -- npx -y ruv-swarm mcp start");
    }
    if (config.flowNexus) {
      commands.push("claude mcp add flow-nexus -- npx -y flow-nexus@latest mcp start");
    }
  }

  return commands;
}

/**
 * Get platform-specific setup instructions
 */
export function getPlatformInstructions(): { platform: string; note: string } {
  if (isWindows()) {
    return {
      platform: 'Windows',
      note: 'MCP configuration uses cmd /c wrapper for npx compatibility.',
    };
  }
  return {
    platform: process.platform === 'darwin' ? 'macOS' : 'Linux',
    note: 'MCP configuration uses npx directly.',
  };
}
