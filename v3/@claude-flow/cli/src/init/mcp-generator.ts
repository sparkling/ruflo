/**
 * MCP Configuration Generator
 * Creates .mcp.json for Claude Code MCP server integration
 * Handles cross-platform compatibility (Windows requires cmd /c wrapper)
 */

import type { InitOptions, MCPConfig } from './types.js';

/**
 * Check if running on Windows
 */
function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Build the `ruflo` MCP server entry. Always uses `npx -y
 * @sparkleideas/ruflo@latest mcp start` (the user-facing wrapper, per
 * ADR-0143).
 *
 * ADR-0104 §4a (superseded by ADR-0155 2026-05-07): the previous default
 * was a directly-resolved global binary path when `which ruflo` succeeded.
 * That optimised the ~5-8s npx cold-start at the cost of pinning every
 * MCP boot to whatever `@claude-flow/cli` was bundled at last
 * `npm install -g` time. The validation around ADR-0154 made the failure
 * mode concrete: stale wrappers miss subsequent runtime fixes (d12
 * typed-retry, musl prebuild, Phase 4 loader-preference) — same staleness
 * shape as HM's pinned-npx-cache `.mcp.json`, just at the global-wrapper
 * layer. Per `feedback-always-npx-for-ruflo`, freshness wins; the
 * cold-start cost is the user's call to optimise out manually if they
 * care.
 */
function createRufloEntry(env: Record<string, string>, additionalProps: Record<string, unknown> = {}): object {
  return createMCPServerEntry(['@sparkleideas/ruflo@latest', 'mcp', 'start'], env, additionalProps);
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
 * Generate MCP configuration
 */
export function generateMCPConfig(options: InitOptions): object {
  const config = options.mcp;
  const mcpServers: Record<string, object> = {};

  const npmEnv = {
    npm_config_update_notifier: 'false',
  };

  // Claude Flow MCP server (core) — uses ruflo wrapper for portable npm-resolved invocation
  // ADR-0104 §4a: prefer directly-resolved binary path over npx cold-start.
  //
  // ADR-0214 (Option A, corrected): theatrical env vars dropped — `MODE`,
  // `HOOKS_ENABLED` had zero consumers in shipping code. Surviving emissions
  // are renamed to the loader's reader names (`TOPOLOGY` →
  // `SWARM_TOPOLOGY`, `MEMORY_BACKEND` → `MEMORY_TYPE`), which is value-safe
  // (init defaults ∈ the loader's Zod allowed sets at
  // `shared/src/core/config/loader.ts:105,144`). `MAX_AGENTS` was already
  // canonical.
  if (config.claudeFlow) {
    mcpServers['ruflo'] = createRufloEntry(
      {
        ...npmEnv,
        CLAUDE_FLOW_MAX_AGENTS: String(options.runtime.maxAgents),
        CLAUDE_FLOW_SWARM_TOPOLOGY: options.runtime.topology,
        CLAUDE_FLOW_MEMORY_TYPE: options.runtime.memoryBackend,
      },
      { autoStart: config.autoStart }
    );
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
      commands.push('claude mcp add claude-flow -- cmd /c npx -y @sparkleideas/cli@latest mcp start');
    }
    if (config.ruvSwarm) {
      commands.push('claude mcp add ruv-swarm -- cmd /c npx -y ruv-swarm mcp start');
    }
    if (config.flowNexus) {
      commands.push('claude mcp add flow-nexus -- cmd /c npx -y flow-nexus@latest mcp start');
    }
  } else {
    if (config.claudeFlow) {
      commands.push("claude mcp add claude-flow -- npx -y @sparkleideas/cli@latest mcp start");
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
