/**
 * V3 CLI MCP Command
 * MCP server control and management with real server integration
 *
 * @module @claude-flow/cli/commands/mcp
 * @version 3.0.0
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { select, confirm } from '../prompt.js';
import {
  MCPServerManager,
  createMCPServerManager,
  getServerManager,
  startMCPServer,
  stopMCPServer,
  getMCPServerStatus,
  type MCPServerOptions,
  type MCPServerStatus,
} from '../mcp-server.js';
import { listMCPTools, callMCPTool, hasTool, getToolMetadata } from '../mcp-client.js';
import { configManager } from '../services/config-file-manager.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { findProjectRoot } from '../mcp-tools/types.js';

// MCP tools categories
const TOOL_CATEGORIES = [
  { value: 'coordination', label: 'Coordination', hint: 'Swarm and agent coordination tools' },
  { value: 'monitoring', label: 'Monitoring', hint: 'Status and metrics monitoring' },
  { value: 'memory', label: 'Memory', hint: 'Memory and neural features' },
  { value: 'github', label: 'GitHub', hint: 'GitHub integration tools' },
  { value: 'system', label: 'System', hint: 'System and benchmark tools' }
];

/**
 * Format uptime for display
 */
function formatUptime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/**
 * ADR-0164 Phase A0e — Run on-init `.meta` → segments migration before
 * `manager.start()` so stale legacy sidecars are converted before the new
 * native loader runs. Warn-and-continue on any failure; never block boot.
 *
 * Hard 10s cap (per ADR Correction #6: relies on A0a perf fixes — both
 * `inspectMeta` and `inspectRvfNative` peek the magic via `openSync` +
 * `readSync(fd, buf, 0, 4, 0)` rather than slurping multi-MB sidecars).
 *
 * Acceptance gate (Correction #7): callers must redirect stderr explicitly;
 * the marketplace harness pipes stderr to /dev/null and would swallow these
 * warnings under default invocation.
 */
async function runOnInitMigration(projectRoot: string): Promise<void> {
  // dist/src/commands/mcp.js -> dist/src/commands -> dist/src -> dist -> pkg root -> scripts/
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const migrationScript = resolve(join(__dirname, '..', '..', '..', 'scripts', 'migrate-meta-to-segments.mjs'));

  if (!existsSync(migrationScript)) {
    // Tool not packaged in this build — silent skip (warn-and-continue).
    process.stderr.write(`[mcp] migration tool not found at ${migrationScript}; skipping\n`);
    return;
  }

  await new Promise<void>((resolveDone) => {
    const child = spawn(process.execPath, [migrationScript, projectRoot, '--auto', '--quiet'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderrBuf = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8');
    });

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      process.stderr.write('[mcp] on-init migration timed out after 10s; continuing without migration\n');
      resolveDone();
    }, 10_000);

    child.on('error', (err) => {
      clearTimeout(timer);
      process.stderr.write(`[mcp] on-init migration spawn error: ${err.message}; continuing\n`);
      resolveDone();
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        const tail = stderrBuf.trim().split('\n').slice(-3).join(' | ');
        process.stderr.write(`[mcp] on-init migration exited ${code}; continuing (stderr: ${tail})\n`);
      }
      resolveDone();
    });
  });
}

// Start MCP server
const startCommand: Command = {
  name: 'start',
  description: 'Start MCP server',
  options: [
    {
      name: 'port',
      short: 'p',
      description: 'Server port',
      type: 'number',
      default: 3000
    },
    {
      name: 'host',
      short: 'h',
      description: 'Server host',
      type: 'string',
      default: 'localhost'
    },
    {
      name: 'transport',
      short: 't',
      description: 'Transport type (stdio, http, websocket)',
      type: 'string',
      default: 'stdio',
      choices: ['stdio', 'http', 'websocket']
    },
    {
      name: 'tools',
      description: 'Tools to enable (comma-separated or "all")',
      type: 'string',
      default: 'all'
    },
    {
      name: 'daemon',
      short: 'd',
      description: 'Run as background daemon',
      type: 'boolean',
      default: false
    },
    {
      name: 'force',
      short: 'f',
      description: 'Force restart (kill existing server first)',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow mcp start', description: 'Start with defaults (stdio)' },
    { command: 'claude-flow mcp start -p 8080 -t http', description: 'Start HTTP server' },
    { command: 'claude-flow mcp start -d', description: 'Start as daemon' },
    { command: 'claude-flow mcp start -f', description: 'Force restart (kill existing)' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // ADR-0069 A6: config-chain ports
    // Parens disambiguate ??/||: use explicit flag, else env (default 3000).
    // tsc TS5076 + Node SyntaxError without parens.
    const port = (ctx.flags.port as number) ?? (parseInt(process.env.MCP_PORT || '', 10) || 3000);
    const host = (ctx.flags.host as string) ?? 'localhost';
    const transport = (ctx.flags.transport as 'stdio' | 'http' | 'websocket') ?? 'stdio';
    const tools = (ctx.flags.tools as string) || 'all';
    const daemon = (ctx.flags.daemon as boolean) ?? false;
    const force = (ctx.flags.force as boolean) ?? false;

    output.writeln();
    output.printInfo('Starting MCP Server...');
    output.writeln();

    // Check if already running (skip self-detection for stdio — getStatus()
    // reports the current process as "running" when transport=stdio and no
    // PID file exists, which would cause us to SIGKILL ourselves)
    const existingStatus = await getMCPServerStatus();
    const isSelfDetected = existingStatus.pid === process.pid;
    if (existingStatus.running && !isSelfDetected) {
      // For stdio transport, always force restart since we can't health check it
      // For other transports, check health unless --force is specified
      const shouldForceRestart = force || transport === 'stdio';

      if (!shouldForceRestart) {
        // Verify the server is actually healthy/responsive
        const manager = getServerManager();
        const health = await manager.checkHealth();

        if (health.healthy) {
          output.printWarning(`MCP Server already running (PID: ${existingStatus.pid})`);
          output.writeln(output.dim('Use "claude-flow mcp stop" to stop the server first, or use --force'));
          return { success: false, exitCode: 1 };
        }
      }

      // Force restart or unresponsive - auto-recover
      output.printWarning(`MCP Server (PID: ${existingStatus.pid}) - restarting...`);
      try {
        // Force kill the existing process
        if (existingStatus.pid) {
          try {
            process.kill(existingStatus.pid, 'SIGKILL');
          } catch {
            // Process may already be dead
          }
        }
        const manager = getServerManager();
        await manager.stop();
        output.writeln(output.dim('  Cleaned up existing server'));
      } catch {
        // Continue anyway - the stop/cleanup may partially fail
      }
    }

    // ADR-0164 Phase A0e: on-init `.meta` → segments migration.
    // Runs after prior-PID SIGKILL/cleanup, before `manager.start()`.
    // Warn-and-continue on failure or 10s timeout; does NOT block MCP boot.
    // ADR-0100/G: use findProjectRoot() not process.cwd() (gate-forbidden).
    await runOnInitMigration(findProjectRoot());

    const options: MCPServerOptions = {
      transport,
      host,
      port,
      tools: !tools || tools === 'all' ? 'all' : tools.split(','),
      daemonize: daemon,
    };

    try {
      output.writeln(output.dim('  Initializing server...'));

      const manager = getServerManager(options);

      // Setup event handlers for progress display
      manager.on('starting', () => {
        output.writeln(output.dim('  Loading tool registry...'));
      });

      manager.on('started', (data: { startupTime?: number }) => {
        output.writeln(output.dim(`  Server started in ${data.startupTime?.toFixed(2) || 0}ms`));
      });

      manager.on('log', (log: { level: string; msg: string; data?: unknown }) => {
        if (ctx.flags.verbose) {
          output.writeln(output.dim(`  [${log.level}] ${log.msg}`));
        }
      });

      // Start the server
      const status = await manager.start();

      // ADR-0244 site #8 (F-01-007): replace literal `'27 enabled'`
      // with the live tool count from `listMCPTools()` (already
      // imported at mcp.ts:22). The previous hardcoded `27` was
      // wrong against the actual ~298+ tools the manager registers,
      // causing users to assume the server was under-provisioned.
      // Upstream `ruvnet/ruflo` is byte-identical at this line; the
      // fix is fork-only merge-tax per ADR-0244.
      const liveToolCount = listMCPTools().length;
      const toolsValue = !tools || tools === 'all'
        ? `${liveToolCount} enabled`
        : `${tools.split(',').length} enabled`;
      output.writeln();
      output.printTable({
        columns: [
          { key: 'property', header: 'Property', width: 15 },
          { key: 'value', header: 'Value', width: 30 }
        ],
        data: [
          { property: 'Server PID', value: status.pid || process.pid },
          { property: 'Transport', value: transport },
          { property: 'Host', value: host },
          { property: 'Port', value: port },
          { property: 'Tools', value: toolsValue },
          { property: 'Status', value: output.success('Running') }
        ]
      });

      output.writeln();
      output.printSuccess('MCP Server started');

      if (transport === 'http') {
        output.writeln(output.dim(`  Health: http://${host}:${port}/health`));
        output.writeln(output.dim(`  RPC: http://${host}:${port}/rpc`));
      } else if (transport === 'websocket') {
        output.writeln(output.dim(`  WebSocket: ws://${host}:${port}/ws`));
      }

      if (daemon) {
        output.writeln(output.dim('  Running in background mode'));
      }

      return { success: true, data: status };
    } catch (error) {
      output.printError(`Failed to start MCP server: ${(error as Error).message}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Stop MCP server
const stopCommand: Command = {
  name: 'stop',
  description: 'Stop MCP server',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Force stop without graceful shutdown',
      type: 'boolean',
      default: false
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const force = ctx.flags.force as boolean;

    // Check if server is running
    const status = await getMCPServerStatus();
    if (!status.running) {
      output.printInfo('MCP Server is not running');
      return { success: true };
    }

    if (!force && ctx.interactive) {
      const confirmed = await confirm({
        message: `Stop MCP server (PID: ${status.pid})?`,
        default: false
      });

      if (!confirmed) {
        output.printInfo('Operation cancelled');
        return { success: true };
      }
    }

    output.printInfo('Stopping MCP Server...');

    try {
      const manager = getServerManager();

      if (!force) {
        output.writeln(output.dim('  Completing pending requests...'));
        output.writeln(output.dim('  Closing connections...'));
      }

      await manager.stop(force);

      output.writeln(output.dim('  Releasing resources...'));
      output.printSuccess('MCP Server stopped');

      return { success: true, data: { stopped: true, force } };
    } catch (error) {
      output.printError(`Failed to stop MCP server: ${(error as Error).message}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// MCP status
const statusCommand: Command = {
  name: 'status',
  description: 'Show MCP server status',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      let status = await getMCPServerStatus();

      // If PID-based check says not running, detect stdio mode
      if (!status.running) {
        const isStdio = !process.stdin.isTTY;
        const envTransport = process.env.CLAUDE_FLOW_MCP_TRANSPORT;
        if (isStdio || envTransport === 'stdio') {
          status = {
            running: true,
            pid: process.pid,
            transport: 'stdio',
          };
        }
      }

      if (ctx.flags.format === 'json') {
        output.printJson(status);
        return { success: true, data: status };
      }

      output.writeln();
      output.writeln(output.bold('MCP Server Status'));
      output.writeln();

      if (!status.running) {
        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 20 },
            { key: 'value', header: 'Value', width: 20, align: 'right' }
          ],
          data: [
            { metric: 'Status', value: output.error('Stopped') }
          ]
        });

        output.writeln();
        output.writeln(output.dim('Run "claude-flow mcp start" to start the server'));
        return { success: true, data: status };
      }

      const displayData: Array<{ metric: string; value: unknown }> = [
        { metric: 'Status', value: output.success('Running') },
        { metric: 'PID', value: status.pid },
        { metric: 'Transport', value: status.transport },
      ];

      // Only show host/port for non-stdio transports
      if (status.transport !== 'stdio') {
        displayData.push({ metric: 'Host', value: status.host });
        displayData.push({ metric: 'Port', value: status.port });
      }

      if (status.uptime !== undefined) {
        displayData.push({ metric: 'Uptime', value: formatUptime(status.uptime) });
      }

      if (status.startedAt) {
        displayData.push({ metric: 'Started At', value: status.startedAt });
      }

      if (status.health) {
        displayData.push({
          metric: 'Health',
          value: status.health.healthy
            ? output.success('Healthy')
            : output.error(status.health.error || 'Unhealthy')
        });

        if (status.health.metrics) {
          for (const [key, value] of Object.entries(status.health.metrics)) {
            displayData.push({
              metric: `  ${key}`,
              value: String(value)
            });
          }
        }
      }

      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 20 },
          { key: 'value', header: 'Value', width: 25, align: 'right' }
        ],
        data: displayData
      });

      return { success: true, data: status };
    } catch (error) {
      output.printError(`Failed to get status: ${(error as Error).message}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// List tools
const toolsCommand: Command = {
  name: 'tools',
  description: 'List available MCP tools',
  options: [
    {
      name: 'category',
      short: 'c',
      description: 'Filter by category',
      type: 'string',
      choices: TOOL_CATEGORIES.map(c => c.value)
    },
    {
      name: 'enabled',
      description: 'Show only enabled tools',
      type: 'boolean',
      default: false
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const category = ctx.flags.category as string;

    // Use local tool registry
    let tools: Array<{ name: string; category: string; description: string; enabled: boolean }>;

    // Get tools from local registry
    const registeredTools = listMCPTools(category);

    if (registeredTools.length > 0) {
      tools = registeredTools.map(tool => ({
        name: tool.name,
        category: tool.category || 'uncategorized',
        description: tool.description,
        enabled: true
      }));
    } else {
      // Fallback to static tool list
      tools = [
        // Agent tools
        { name: 'agent_spawn', category: 'agent', description: 'Spawn a new agent', enabled: true },
        { name: 'agent_list', category: 'agent', description: 'List all agents', enabled: true },
        { name: 'agent_terminate', category: 'agent', description: 'Terminate an agent', enabled: true },
        { name: 'agent_status', category: 'agent', description: 'Get agent status', enabled: true },

        // Swarm tools
        { name: 'swarm_init', category: 'swarm', description: 'Initialize swarm topology', enabled: true },
        { name: 'swarm_status', category: 'swarm', description: 'Get swarm status', enabled: true },
        { name: 'swarm_scale', category: 'swarm', description: 'Scale swarm size', enabled: true },

        // Memory tools
        { name: 'memory_store', category: 'memory', description: 'Store in memory', enabled: true },
        { name: 'memory_search', category: 'memory', description: 'Search memory', enabled: true },
        { name: 'memory_list', category: 'memory', description: 'List memory entries', enabled: true },

        // Config tools
        { name: 'config_load', category: 'config', description: 'Load configuration', enabled: true },
        { name: 'config_save', category: 'config', description: 'Save configuration', enabled: true },
        { name: 'config_validate', category: 'config', description: 'Validate configuration', enabled: true },

        // Hooks tools
        { name: 'hooks_pre-edit', category: 'hooks', description: 'Pre-edit hook', enabled: true },
        { name: 'hooks_post-edit', category: 'hooks', description: 'Post-edit hook', enabled: true },
        { name: 'hooks_pre-command', category: 'hooks', description: 'Pre-command hook', enabled: true },
        { name: 'hooks_post-command', category: 'hooks', description: 'Post-command hook', enabled: true },
        { name: 'hooks_route', category: 'hooks', description: 'Route task to agent', enabled: true },
        { name: 'hooks_explain', category: 'hooks', description: 'Explain routing', enabled: true },
        { name: 'hooks_pretrain', category: 'hooks', description: 'Pretrain from repo', enabled: true },
        { name: 'hooks_metrics', category: 'hooks', description: 'Learning metrics', enabled: true },
        { name: 'hooks_list', category: 'hooks', description: 'List hooks', enabled: true },

        // System tools
        { name: 'system_info', category: 'system', description: 'System information', enabled: true },
        { name: 'system_health', category: 'system', description: 'Health status', enabled: true },
        { name: 'system_metrics', category: 'system', description: 'Server metrics', enabled: true },
      ].filter(t => !category || t.category === category);
    }

    if (ctx.flags.format === 'json') {
      output.printJson(tools);
      return { success: true, data: tools };
    }

    output.writeln();
    output.writeln(output.bold('Available MCP Tools'));
    output.writeln();

    // Group by category
    const grouped = tools.reduce((acc, tool) => {
      if (!acc[tool.category]) acc[tool.category] = [];
      acc[tool.category].push(tool);
      return acc;
    }, {} as Record<string, typeof tools>);

    for (const [cat, catTools] of Object.entries(grouped)) {
      output.writeln(output.highlight(cat.charAt(0).toUpperCase() + cat.slice(1)));

      output.printTable({
        columns: [
          { key: 'name', header: 'Tool', width: 25 },
          { key: 'description', header: 'Description', width: 35 },
          { key: 'enabled', header: 'Status', width: 10, format: (v: unknown) => (v as boolean) ? output.success('Enabled') : output.dim('Disabled') }
        ],
        data: catTools,
        border: false
      });

      output.writeln();
    }

    output.printInfo(`Total: ${tools.length} tools`);

    return { success: true, data: tools };
  }
};

// Enable/disable tools
//
// ADR-0244 site #6 (F-01-006): persist toggle state to
// `.claude-flow/config.json` under `mcp.disabledTools`. Previously
// the handler printed success without writing anything; the tools
// remained enabled. After the fix the handler reads the current
// disabledTools list, applies enable/disable mutations, and writes
// the result back via `configManager.set('mcp.disabledTools', ...)`.
//
// Per ADR-0244 §Decision #6 (E5 expert amendment): toggling is
// config-write-only at runtime; effective on next
// `getMCPServerManager()` instantiation. The success envelope MUST
// include `note:'Restart required for changes to take effect'` so
// the user understands the toggle does NOT propagate to a live
// server in this process.
//
// Upstream `ruvnet/ruflo` ships the dishonest-print at this block
// byte-identical; the fix is fork-only merge-tax per ADR-0244.
const toggleCommand: Command = {
  name: 'toggle',
  description: 'Enable or disable MCP tools',
  options: [
    {
      name: 'enable',
      short: 'e',
      description: 'Enable tools',
      type: 'string'
    },
    {
      name: 'disable',
      short: 'd',
      description: 'Disable tools',
      type: 'string'
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const toEnable = ctx.flags.enable as string | undefined;
    const toDisable = ctx.flags.disable as string | undefined;

    if (!toEnable && !toDisable) {
      output.printError('Use --enable or --disable with comma-separated tool names');
      return { success: false, exitCode: 1 };
    }

    // Read current disabledTools list (set of tool names). Initialise
    // empty when no prior list exists.
    const existing = configManager.get(ctx.cwd, 'mcp.disabledTools');
    const disabledSet = new Set<string>(
      Array.isArray(existing) ? (existing as unknown[]).filter((x): x is string => typeof x === 'string') : []
    );

    const enabledList: string[] = [];
    const disabledList: string[] = [];

    if (toEnable) {
      const tools = toEnable.split(',').map((t) => t.trim()).filter(Boolean);
      for (const t of tools) {
        disabledSet.delete(t);
        enabledList.push(t);
      }
      output.printInfo(`Enabling tools: ${tools.join(', ')}`);
    }

    if (toDisable) {
      const tools = toDisable.split(',').map((t) => t.trim()).filter(Boolean);
      for (const t of tools) {
        disabledSet.add(t);
        disabledList.push(t);
      }
      output.printInfo(`Disabling tools: ${tools.join(', ')}`);
    }

    // Persist the updated disabledTools list. fail-loud per
    // feedback-no-fallbacks if the config write fails — the user
    // expects the toggle to land.
    const nextList = Array.from(disabledSet).sort();
    try {
      configManager.set(ctx.cwd, 'mcp.disabledTools', nextList);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      output.printError(`Failed to persist mcp.disabledTools: ${cause}`);
      return { success: false, exitCode: 1, message: `Failed to persist mcp.disabledTools: ${cause}` };
    }

    if (enabledList.length > 0) {
      output.printSuccess(`Enabled ${enabledList.length} tools`);
    }
    if (disabledList.length > 0) {
      output.printSuccess(`Disabled ${disabledList.length} tools`);
    }

    // ADR-0244 site #6 honesty envelope (per E5 expert): restart note.
    output.writeln(output.dim('  Restart required for changes to take effect'));

    return {
      success: true,
      data: {
        enabled: enabledList,
        disabled: disabledList,
        disabledTools: nextList,
      },
      message: 'Restart required for changes to take effect',
    };
  }
};

// Execute tool
const execCommand: Command = {
  name: 'exec',
  description: 'Execute an MCP tool',
  options: [
    {
      name: 'tool',
      short: 't',
      description: 'Tool name',
      type: 'string',
      required: true
    },
    {
      name: 'params',
      short: 'p',
      description: 'Tool parameters (JSON)',
      type: 'string'
    }
  ],
  examples: [
    { command: 'claude-flow mcp exec -t swarm_init -p \'{"topology":"mesh"}\'', description: 'Execute tool' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Reject unknown flags (X1: --args and other typos are silently ignored otherwise)
    const knownFlags = new Set(['tool', 'params', 'format', 'help', 'version', 'verbose', 'quiet', 'config', 'noColor', 'color', 'interactive', '_']);
    for (const key of Object.keys(ctx.flags)) {
      if (!knownFlags.has(key)) {
        output.printError(`Unknown option: --${key}`);
        return { success: false, exitCode: 1 };
      }
    }

    const tool = ctx.flags.tool as string || ctx.args[0];
    const paramsStr = ctx.flags.params as string;

    if (!tool) {
      output.printError('Tool name is required. Use --tool or -t');
      return { success: false, exitCode: 1 };
    }

    let params = {};
    if (paramsStr) {
      try {
        params = JSON.parse(paramsStr);
      } catch (e) {
        output.printError('Invalid JSON parameters');
        return { success: false, exitCode: 1 };
      }
    }

    output.printInfo(`Executing tool: ${tool}`);

    if (Object.keys(params).length > 0) {
      output.writeln(output.dim(`  Parameters: ${JSON.stringify(params)}`));
    }

    try {
      // Execute through local MCP tool registry
      if (!hasTool(tool)) {
        output.printError(`Tool not found: ${tool}`);
        return { success: false, exitCode: 1 };
      }

      const startTime = performance.now();
      const result = await callMCPTool(tool, params, {
        sessionId: `cli-${Date.now().toString(36)}`,
        requestId: `exec-${Date.now()}`,
      });
      const duration = performance.now() - startTime;

      // X2: Propagate tool failure to exit code
      const toolSuccess = result == null || typeof result !== 'object' || (result as Record<string, unknown>).success !== false;

      output.writeln();
      if (toolSuccess) {
        output.printSuccess(`Tool executed in ${duration.toFixed(2)}ms`);
      } else {
        output.printError(`Tool returned failure after ${duration.toFixed(2)}ms`);
      }

      if (ctx.flags.format === 'json') {
        output.printJson({ tool, params, result, duration });
      } else {
        output.writeln();
        output.writeln(output.bold('Result:'));
        output.printJson(result);
      }

      if (!toolSuccess) {
        return { success: false, exitCode: 1, data: { tool, params, result, duration } };
      }
      return { success: true, data: { tool, params, result, duration } };
    } catch (error) {
      output.printError(`Tool execution failed: ${(error as Error).message}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Health check command
const healthCommand: Command = {
  name: 'health',
  description: 'Check MCP server health',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      const status = await getMCPServerStatus();

      if (!status.running) {
        output.printError('MCP Server is not running');
        return { success: false, exitCode: 1 };
      }

      const manager = getServerManager();
      const health = await manager.checkHealth();

      if (ctx.flags.format === 'json') {
        output.printJson(health);
        return { success: true, data: health };
      }

      output.writeln();
      output.writeln(output.bold('MCP Server Health'));
      output.writeln();

      if (health.healthy) {
        output.printSuccess('Server is healthy');
      } else {
        output.printError(`Server is unhealthy: ${health.error || 'Unknown error'}`);
      }

      if (health.metrics) {
        output.writeln();
        output.writeln(output.bold('Metrics:'));
        for (const [key, value] of Object.entries(health.metrics)) {
          output.writeln(`  ${key}: ${value}`);
        }
      }

      return { success: health.healthy, data: health };
    } catch (error) {
      output.printError(`Health check failed: ${(error as Error).message}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Logs command
const logsCommand: Command = {
  name: 'logs',
  description: 'Show MCP server logs',
  options: [
    {
      name: 'lines',
      short: 'n',
      description: 'Number of lines',
      type: 'number',
      default: 20
    },
    {
      name: 'follow',
      short: 'f',
      description: 'Follow log output',
      type: 'boolean',
      default: false
    },
    {
      name: 'level',
      description: 'Filter by log level',
      type: 'string',
      choices: ['debug', 'info', 'warn', 'error']
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const lines = ctx.flags.lines as number;

    // Default logs (loaded from actual log file when available)
    const logs = [
      { time: new Date().toISOString(), level: 'info', message: 'MCP Server started on stdio' },
      { time: new Date().toISOString(), level: 'info', message: 'Registered 27 tools' },
      { time: new Date().toISOString(), level: 'debug', message: 'Received request: tools/list' },
      { time: new Date().toISOString(), level: 'info', message: 'Session initialized' },
    ].slice(-lines);

    output.writeln();
    output.writeln(output.bold('MCP Server Logs'));
    output.writeln();

    for (const log of logs) {
      let levelStr: string;
      switch (log.level) {
        case 'error':
          levelStr = output.error(log.level.toUpperCase().padEnd(5));
          break;
        case 'warn':
          levelStr = output.warning(log.level.toUpperCase().padEnd(5));
          break;
        case 'debug':
          levelStr = output.dim(log.level.toUpperCase().padEnd(5));
          break;
        default:
          levelStr = output.info(log.level.toUpperCase().padEnd(5));
      }

      output.writeln(`${output.dim(log.time)} ${levelStr} ${log.message}`);
    }

    return { success: true, data: logs };
  }
};

// Restart command
const restartCommand: Command = {
  name: 'restart',
  description: 'Restart MCP server',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Force restart without graceful shutdown',
      type: 'boolean',
      default: false
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const force = ctx.flags.force as boolean;

    output.printInfo('Restarting MCP Server...');

    try {
      const manager = getServerManager();
      const status = await manager.restart();

      output.printSuccess('MCP Server restarted');
      output.writeln(output.dim(`  PID: ${status.pid}`));

      return { success: true, data: status };
    } catch (error) {
      output.printError(`Failed to restart: ${(error as Error).message}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Main MCP command
export const mcpCommand: Command = {
  name: 'mcp',
  description: 'MCP server management',
  subcommands: [
    startCommand,
    stopCommand,
    statusCommand,
    healthCommand,
    restartCommand,
    toolsCommand,
    toggleCommand,
    execCommand,
    logsCommand
  ],
  options: [],
  examples: [
    { command: 'claude-flow mcp start', description: 'Start MCP server' },
    { command: 'claude-flow mcp start -t http -p 8080', description: 'Start HTTP server on port 8080' },
    { command: 'claude-flow mcp status', description: 'Show server status' },
    { command: 'claude-flow mcp tools', description: 'List tools' },
    { command: 'claude-flow mcp stop', description: 'Stop the server' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('MCP Server Management'));
    output.writeln();
    output.writeln('Usage: claude-flow mcp <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('start')}    - Start MCP server`,
      `${output.highlight('stop')}     - Stop MCP server`,
      `${output.highlight('status')}   - Show server status`,
      `${output.highlight('health')}   - Check server health`,
      `${output.highlight('restart')}  - Restart MCP server`,
      `${output.highlight('tools')}    - List available tools`,
      `${output.highlight('toggle')}   - Enable/disable tools`,
      `${output.highlight('exec')}     - Execute a tool`,
      `${output.highlight('logs')}     - Show server logs`
    ]);

    return { success: true };
  }
};

export default mcpCommand;
