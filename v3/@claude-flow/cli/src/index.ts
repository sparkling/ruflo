/**
 * V3 CLI Main Entry Point
 * Modernized CLI for RuFlo V3
 *
 * Created with ❤️ by ruv.io
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { Command, CommandContext, CommandResult, V3Config, CLIError } from './types.js';
import { CommandParser, commandParser } from './parser.js';
import { OutputFormatter, output } from './output.js';
import { commands, commandsByCategory, commandRegistry, getCommand, getCommandAsync, getCommandNames, hasCommand } from './commands/index.js';
import { suggestCommand } from './suggest.js';
import { runStartupUpdateCheck } from './update/index.js';

/**
 * ADR-0094 Sprint 1.4 (d6): lazy import of the memory-router shutdown so
 * this module doesn't pay the import cost on commands that never touch
 * storage. The router has `process.on('exit', _syncShutdown)` as a backstop
 * — this async call drives the full `RvfBackend.shutdown()` path (final
 * persist + native DB close + lock release).
 */
async function cliShutdownRouter(): Promise<void> {
  try {
    const mod = await import('./memory/memory-router.js');
    if (typeof mod.shutdownRouter === 'function') {
      await mod.shutdownRouter();
    }
  } catch {
    // best effort — sync `exit` handler still runs to release the lock
  }
}

// Read version from package.json at runtime
function getPackageVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    // Navigate from dist/src to package root
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '3.0.0';
  } catch {
    return '3.0.0';
  }
}

export const VERSION = getPackageVersion();

export interface CLIOptions {
  name?: string;
  description?: string;
  version?: string;
  interactive?: boolean;
}

/**
 * V3 CLI Application
 */
export class CLI {
  private name: string;
  private description: string;
  private version: string;
  private parser: CommandParser;
  private output: OutputFormatter;
  private interactive: boolean;

  constructor(options: CLIOptions = {}) {
    this.name = options.name || 'ruflo';
    this.description = options.description || 'RuFlo V3 - AI Agent Orchestration Platform';
    this.version = options.version || VERSION;
    this.parser = commandParser;
    this.output = output;
    this.interactive = options.interactive ?? process.stdin.isTTY ?? false;

    // Register all commands
    for (const cmd of commands) {
      this.parser.registerCommand(cmd);
    }
  }

  /**
   * Run the CLI with given arguments
   */
  async run(args: string[] = process.argv.slice(2)): Promise<void> {
    try {
      // Parse arguments
      const parseResult = this.parser.parse(args);
      const { command: commandPath, flags, positional } = parseResult;

      // Handle global flags
      if (flags.version || flags.V) {
        this.showVersion();
        return;
      }

      if (flags.noColor) {
        this.output.setColorEnabled(false);
      }

      // Set verbosity level based on flags
      if (flags.quiet) {
        this.output.setVerbosity('quiet');
      } else if (flags.verbose) {
        this.output.setVerbosity(process.env.DEBUG ? 'debug' : 'verbose');
      }

      // Verbose mode: show parsed arguments
      if (this.output.isVerbose()) {
        this.output.printDebug(`Command: ${commandPath.join(' ') || '(none)'}`);
        this.output.printDebug(`Positional: [${positional.join(', ')}]`);
        this.output.printDebug(`Flags: ${JSON.stringify(Object.fromEntries(Object.entries(flags).filter(([k]) => k !== '_')))}`);
        this.output.printDebug(`CWD: ${process.cwd()}`);
      }

      // Run startup update check (non-blocking, silent on skip)
      if (!flags.noUpdate && commandPath[0] !== 'update') {
        this.checkForUpdatesOnStartup().catch(() => {/* silent */});
      }

      // Handle lazy-loaded commands that weren't recognized by the parser
      // If commandPath is empty but positional has a command name, check if it's lazy-loadable
      if (commandPath.length === 0 && positional.length > 0 && !positional[0].startsWith('-')) {
        const potentialCommand = positional[0];
        if (hasCommand(potentialCommand)) {
          // This is a lazy-loaded command, treat it as the command
          commandPath.push(potentialCommand);
          positional.shift();
        }
      }

      // No command - show help or suggest correction
      if (commandPath.length === 0 || flags.help || flags.h) {
        if (commandPath.length > 0) {
          // Show command-specific help. Pass the full path so e.g.
          // `hive-mind spawn --help` shows the spawn subcommand's options
          // (including ADR-0108 --worker-types) rather than the parent
          // command's subcommand list.
          await this.showCommandHelp(commandPath);
        } else if (positional.length > 0 && !positional[0].startsWith('-')) {
          // First positional looks like an attempted command - suggest correction
          const attemptedCommand = positional[0];
          this.output.printError(`Unknown command: ${attemptedCommand}`);
          const availableCommands = Array.from(new Set([...commands.map(c => c.name), ...getCommandNames()]));
          const { message } = suggestCommand(attemptedCommand, availableCommands);
          this.output.writeln(this.output.dim(`  ${message}`));
          process.exit(1);
        } else {
          this.showHelp();
        }
        return;
      }

      // Find and execute command
      const commandName = commandPath[0];
      // First check the parser's registry (for dynamically registered commands)
      // Then fall back to the static registry, then try lazy loading
      let command = this.parser.getCommand(commandName) || getCommand(commandName);

      // If not found in sync registry, try lazy loading
      if (!command && hasCommand(commandName)) {
        command = await getCommandAsync(commandName);
      }

      if (!command) {
        this.output.printError(`Unknown command: ${commandName}`);
        // Smart suggestions - include lazy-loadable commands in suggestions
        const availableCommands = Array.from(new Set([...commands.map(c => c.name), ...getCommandNames()]));
        const { message } = suggestCommand(commandName, availableCommands);
        this.output.writeln(this.output.dim(`  ${message}`));
        process.exit(1);
      }

      // Handle subcommand (supports nested subcommands)
      let targetCommand = command;
      let subcommandArgs = positional;

      // Process command path (e.g., ['hooks', 'worker', 'list'])
      // Note: When parser includes subcommand in commandPath, positional already excludes it
      if (commandPath.length > 1 && command.subcommands) {
        const subcommandName = commandPath[1];
        const subcommand = command.subcommands.find(
          sc => sc.name === subcommandName || sc.aliases?.includes(subcommandName)
        );

        if (subcommand) {
          targetCommand = subcommand;
          // Parser already extracted subcommand from positional, so use as-is
          subcommandArgs = positional;

          // Check for nested subcommand (level 2)
          if (commandPath.length > 2 && subcommand.subcommands) {
            const nestedName = commandPath[2];
            const nestedSubcommand = subcommand.subcommands.find(
              sc => sc.name === nestedName || sc.aliases?.includes(nestedName)
            );
            if (nestedSubcommand) {
              targetCommand = nestedSubcommand;
              // Parser already extracted nested subcommand too
              subcommandArgs = positional;
            }
          }
        }
      } else if (positional.length > 0 && command.subcommands) {
        // Check if first positional is a subcommand
        const subcommandName = positional[0];
        const subcommand = command.subcommands.find(
          sc => sc.name === subcommandName || sc.aliases?.includes(subcommandName)
        );

        if (subcommand) {
          targetCommand = subcommand;
          subcommandArgs = positional.slice(1);

          // Check for nested subcommand (level 2 from positional)
          if (subcommandArgs.length > 0 && subcommand.subcommands) {
            const nestedName = subcommandArgs[0];
            const nestedSubcommand = subcommand.subcommands.find(
              sc => sc.name === nestedName || sc.aliases?.includes(nestedName)
            );
            if (nestedSubcommand) {
              targetCommand = nestedSubcommand;
              subcommandArgs = subcommandArgs.slice(1);
            }
          }
        }
      }

      // Validate flags
      const validationErrors = this.parser.validateFlags(flags, targetCommand);
      if (validationErrors.length > 0) {
        for (const error of validationErrors) {
          this.output.printError(error);
        }
        process.exit(1);
      }

      // Build context
      const ctx: CommandContext = {
        args: subcommandArgs,
        flags,
        config: await this.loadConfig(flags.config as string),
        cwd: process.cwd(),
        interactive: this.interactive && !flags.quiet
      };

      // Execute command
      if (targetCommand.action) {
        if (this.output.isVerbose()) {
          this.output.printDebug(`Executing: ${targetCommand.name}`);
        }

        const startTime = Date.now();
        const result = await targetCommand.action(ctx);

        if (this.output.isVerbose()) {
          this.output.printDebug(`Completed in ${Date.now() - startTime}ms`);
        }

        if (result && !result.success) {
          // ADR-0094 Sprint 1.4 (d6): flush router before error-path exit.
          // Otherwise the `.rvf.lock` + native DB handle leak to the next
          // process (LockHeld for up to 5s). Fire-and-forget async shutdown
          // then hard-exit — the `process.on('exit')` sync handler in
          // memory-router.ts catches any remaining lock-file residue.
          try { await cliShutdownRouter(); } catch { /* best effort */ }
          process.exit(result.exitCode || 1);
        }

        // Fix #1428: ONNX worker threads keep the event loop alive after
        // embedding operations. Force-exit after a short delay to allow
        // final I/O to flush. This replaces the per-command workaround
        // that was only applied to `memory init`.
        // ADR-0094 Sprint 1.4 (d6): BEFORE the hard exit, flush the memory
        // router so `RvfBackend.shutdown()` runs (closes native DB handle,
        // releases `.rvf.lock` cleanly). `process.exit(0)` skips `beforeExit`,
        // so the async shutdown hook we register there never fires for
        // normal CLI commands. The `process.on('exit')` sync handler still
        // acts as a backstop for any paths that don't go through here.
        setTimeout(async () => {
          try { await cliShutdownRouter(); } catch { /* best effort */ }
          process.exit(0);
        }, 500).unref();
      } else {
        // No action - show command help (drill into subcommand path so the
        // user sees the subcommand's options, not the parent's child list).
        this.showCommandHelp(commandPath);
      }
    } catch (error) {
      // Don't re-handle if this is a process.exit error (from mocked tests)
      const errorMessage = (error as Error).message;
      if (errorMessage && errorMessage.startsWith('process.exit:')) {
        throw error; // Re-throw so tests can capture the exit code
      }
      // ADR-0094 Sprint 1.4 (d6): await so the async shutdown pass in
      // handleError gets to run before the process exits.
      await this.handleError(error as Error);
    }
  }

  /**
   * Show main help
   */
  private showHelp(): void {
    this.output.writeln();
    this.output.writeln(this.output.bold(`${this.name} v${this.version}`));
    this.output.writeln(this.output.dim(this.description));
    this.output.writeln();

    this.output.writeln(this.output.bold('USAGE:'));
    this.output.writeln(`  ${this.name} <command> [subcommand] [options]`);
    this.output.writeln();

    // Primary Commands
    this.output.writeln(this.output.bold('PRIMARY COMMANDS:'));
    for (const cmd of commandsByCategory.primary) {
      if (cmd.hidden) continue;
      const name = cmd.name.padEnd(12);
      this.output.writeln(`  ${this.output.highlight(name)} ${cmd.description}`);
    }
    this.output.writeln();

    // Advanced Commands
    this.output.writeln(this.output.bold('ADVANCED COMMANDS:'));
    for (const cmd of commandsByCategory.advanced) {
      if (cmd.hidden) continue;
      const name = cmd.name.padEnd(12);
      this.output.writeln(`  ${this.output.highlight(name)} ${cmd.description}`);
    }
    this.output.writeln();

    // Utility Commands
    this.output.writeln(this.output.bold('UTILITY COMMANDS:'));
    for (const cmd of commandsByCategory.utility) {
      if (cmd.hidden) continue;
      const name = cmd.name.padEnd(12);
      this.output.writeln(`  ${this.output.highlight(name)} ${cmd.description}`);
    }
    this.output.writeln();

    // Analysis Commands
    this.output.writeln(this.output.bold('ANALYSIS COMMANDS:'));
    for (const cmd of commandsByCategory.analysis) {
      if (cmd.hidden) continue;
      const name = cmd.name.padEnd(12);
      this.output.writeln(`  ${this.output.highlight(name)} ${cmd.description}`);
    }
    this.output.writeln();

    // Management Commands
    this.output.writeln(this.output.bold('MANAGEMENT COMMANDS:'));
    for (const cmd of commandsByCategory.management) {
      if (cmd.hidden) continue;
      const name = cmd.name.padEnd(12);
      this.output.writeln(`  ${this.output.highlight(name)} ${cmd.description}`);
    }
    this.output.writeln();

    this.output.writeln(this.output.bold('GLOBAL OPTIONS:'));
    for (const opt of this.parser.getGlobalOptions()) {
      const flags = opt.short ? `-${opt.short}, --${opt.name}` : `    --${opt.name}`;
      this.output.writeln(`  ${flags.padEnd(25)} ${opt.description}`);
    }
    this.output.writeln();

    this.output.writeln(this.output.bold('V3 FEATURES:'));
    this.output.printList([
      '15-agent hierarchical mesh coordination',
      'AgentDB with HNSW indexing (150x-12,500x faster)',
      'Flash Attention (2.49x-7.47x speedup)',
      'Unified SwarmCoordinator engine',
      'Event-sourced state management',
      'Domain-Driven Design architecture'
    ]);
    this.output.writeln();

    this.output.writeln(this.output.bold('EXAMPLES:'));
    this.output.writeln(`  ${this.name} agent spawn -t coder              # Spawn a coder agent`);
    this.output.writeln(`  ${this.name} swarm init                        # Initialize V3 swarm`);
    this.output.writeln(`  ${this.name} memory search -q "auth patterns"  # Semantic search`);
    this.output.writeln(`  ${this.name} mcp start                         # Start MCP server`);
    this.output.writeln();

    this.output.writeln(this.output.dim(`Run "${this.name} <command> --help" for command help`));
    this.output.writeln();
    this.output.writeln(this.output.dim('Created with ❤️ by ruv.io'));
    this.output.writeln();
  }

  /**
   * Show command-specific help.
   *
   * Accepts either a string (top-level command) or an array of names that
   * walks the subcommand tree, so `hive-mind spawn --help` (path:
   * `['hive-mind', 'spawn']`) shows the spawn subcommand's options instead
   * of the parent command's child list. Per ADR-0108 §AC#1: --worker-types
   * is only discoverable via the subcommand-specific --help; the parent
   * command's help has no per-subcommand option visibility.
   */
  private async showCommandHelp(commandPath: string | string[]): Promise<void> {
    const path = Array.isArray(commandPath) ? commandPath : [commandPath];
    const rootName = path[0];
    // Try sync first, then lazy load
    let command = getCommand(rootName);
    if (!command && hasCommand(rootName)) {
      command = await getCommandAsync(rootName);
    }

    if (!command) {
      this.output.printError(`Unknown command: ${rootName}`);
      return;
    }

    // Drill into subcommands following the resolved path. If the path's
    // remaining segment isn't a known subcommand we stay on the parent —
    // matches the dispatch behaviour for a typo'd subcommand.
    let resolved = command;
    let displayPath = command.name;
    for (let i = 1; i < path.length; i++) {
      const sub = resolved.subcommands?.find(
        sc => sc.name === path[i] || sc.aliases?.includes(path[i])
      );
      if (!sub) break;
      resolved = sub;
      displayPath = `${displayPath} ${sub.name}`;
    }

    this.output.writeln();
    this.output.writeln(this.output.bold(`${this.name} ${displayPath}`));
    this.output.writeln(resolved.description);
    this.output.writeln();
    // Reassign `command` so the rest of this method (subcommands, options,
    // examples) renders the resolved subcommand's surface.
    command = resolved;

    // Subcommands
    if (command.subcommands && command.subcommands.length > 0) {
      this.output.writeln(this.output.bold('SUBCOMMANDS:'));
      for (const sub of command.subcommands) {
        if (sub.hidden) continue;
        const name = sub.name.padEnd(15);
        const aliases = sub.aliases ? this.output.dim(` (${sub.aliases.join(', ')})`) : '';
        this.output.writeln(`  ${this.output.highlight(name)} ${sub.description}${aliases}`);
      }
      this.output.writeln();
    }

    // Options
    if (command.options && command.options.length > 0) {
      this.output.writeln(this.output.bold('OPTIONS:'));
      for (const opt of command.options) {
        const flags = opt.short ? `-${opt.short}, --${opt.name}` : `    --${opt.name}`;
        const required = opt.required ? this.output.error(' (required)') : '';
        const defaultVal = opt.default !== undefined ? this.output.dim(` [default: ${opt.default}]`) : '';
        this.output.writeln(`  ${flags.padEnd(25)} ${opt.description}${required}${defaultVal}`);
      }
      this.output.writeln();
    }

    // Examples
    if (command.examples && command.examples.length > 0) {
      this.output.writeln(this.output.bold('EXAMPLES:'));
      for (const example of command.examples) {
        this.output.writeln(`  ${this.output.dim('$')} ${example.command}`);
        this.output.writeln(`    ${this.output.dim(example.description)}`);
      }
      this.output.writeln();
    }
  }

  /**
   * Show version
   */
  private showVersion(): void {
    this.output.writeln(`${this.name} v${this.version}`);
  }

  /**
   * Check for updates on startup (non-blocking)
   * Shows notification if updates are available
   */
  private async checkForUpdatesOnStartup(): Promise<void> {
    try {
      const result = await runStartupUpdateCheck({ autoUpdate: true });

      // Show notifications for available updates that weren't auto-applied
      if (result.checked && result.updatesAvailable.length > 0) {
        const nonAutoUpdates = result.updatesAvailable.filter(u => !u.shouldAutoUpdate);

        if (result.updatesApplied.length > 0) {
          this.output.writeln(
            this.output.dim(`Auto-updated: ${result.updatesApplied.join(', ')}`)
          );
        }

        if (nonAutoUpdates.length > 0) {
          this.output.writeln(
            this.output.dim(`Updates available: ${nonAutoUpdates.map(u => `${u.package}@${u.latestVersion}`).join(', ')}`)
          );
          this.output.writeln(
            this.output.dim(`Run '${this.name} update check' for details`)
          );
        }
      }
    } catch {
      // Silently fail - don't interrupt CLI usage
    }
  }

  /**
   * Load configuration file
   */
  private async loadConfig(configPath?: string): Promise<V3Config | undefined> {
    try {
      // Import config utilities
      const { loadConfig: loadSystemConfig } = await import('@claude-flow/shared');
      const { systemConfigToV3Config } = await import('./config-adapter.js');

      // Load configuration
      const loaded = await loadSystemConfig({
        file: configPath,
        paths: configPath ? undefined : [process.cwd()],
      });

      // Convert to V3Config format
      const v3Config = systemConfigToV3Config(loaded.config);

      // Log warnings if any
      if (loaded.warnings && loaded.warnings.length > 0) {
        for (const warning of loaded.warnings) {
          this.output.printWarning(warning);
        }
      }

      return v3Config;
    } catch (error) {
      // Config loading is optional - don't fail if it doesn't exist
      if (process.env.DEBUG) {
        this.output.writeln(
          this.output.dim(`Config loading failed: ${(error as Error).message}`)
        );
      }
      return undefined;
    }
  }

  /**
   * Handle errors
   *
   * ADR-0094 Sprint 1.4 (d6): `process.exit(N)` bypasses `beforeExit`, so
   * without this async shutdown pass the router's `.rvf.lock` + native DB
   * handle leak and the next CLI invocation hits LockHeld for up to 5s.
   * We fire cliShutdownRouter() and then hard-exit — the sync handler
   * registered in memory-router.ts (`process.on('exit')`) runs
   * unconditionally afterwards as a backstop.
   */
  private async handleError(error: Error): Promise<void> {
    if ('code' in error) {
      // CLIError
      const cliError = error as CLIError;
      this.output.printError(cliError.message);

      if (cliError.details) {
        this.output.writeln(this.output.dim(JSON.stringify(cliError.details, null, 2)));
      }

      try { await cliShutdownRouter(); } catch { /* best effort */ }
      process.exit(cliError.exitCode);
    } else {
      // Generic error
      this.output.printError(error.message);

      if (process.env.DEBUG) {
        this.output.writeln();
        this.output.writeln(this.output.dim(error.stack || ''));
      }

      try { await cliShutdownRouter(); } catch { /* best effort */ }
      process.exit(1);
    }
  }
}

// =============================================================================
// Module Exports
// =============================================================================

// Types
export * from './types.js';

// Parser
export { CommandParser, commandParser } from './parser.js';

// Output
export { OutputFormatter, output, Progress, Spinner, type VerbosityLevel } from './output.js';

// Prompt
export * from './prompt.js';

// Commands (internal use)
export * from './commands/index.js';

// MCP Server management
export {
  MCPServerManager,
  createMCPServerManager,
  getServerManager,
  startMCPServer,
  stopMCPServer,
  getMCPServerStatus,
  type MCPServerOptions,
  type MCPServerStatus,
} from './mcp-server.js';

// ADR-0086 Phase 3: Memory exports from router (RvfBackend) + adapter
export {
  routeMemoryOp,
  routeEmbeddingOp,
  ensureRouter,
  loadEmbeddingModel,
  generateEmbedding,
  generateBatchEmbeddings,
  getAdaptiveThreshold,
} from './memory/memory-router.js';

export {
  initializeIntelligence,
  recordStep,
  recordTrajectory,
  findSimilarPatterns,
  getIntelligenceStats,
  getSonaCoordinator,
  getReasoningBank,
  clearIntelligence,
  benchmarkAdaptation,
  // RL loop API
  endTrajectoryWithVerdict,
  distillLearning,
  // Pattern persistence API
  getAllPatterns,
  getPatternsByType,
  flushPatterns,
  deletePattern,
  clearAllPatterns,
  getNeuralDataDir,
  getPersistenceStatus,
  type SonaConfig,
  type TrajectoryStep,
  type Pattern,
  type IntelligenceStats,
} from './memory/intelligence.js';

// EWC++ Consolidation (Prevents Catastrophic Forgetting)
export {
  EWCConsolidator,
  getEWCConsolidator,
  resetEWCConsolidator,
  consolidatePatterns,
  recordPatternOutcome,
  getEWCStats,
  type PatternWeights,
  type EWCConfig,
  type ConsolidationResult,
  type EWCStats,
} from './memory/ewc-consolidation.js';

// SONA Optimizer (Adaptive Routing via Trajectory Learning)
export {
  SONAOptimizer,
  getSONAOptimizer,
  resetSONAOptimizer,
  processTrajectory,
  getSuggestion,
  getSONAStats,
  type TrajectoryOutcome,
  type LearnedPattern,
  type RoutingSuggestion,
  type SONAStats,
} from './memory/sona-optimizer.js';

// Production Hardening
export {
  ErrorHandler,
  withErrorHandling,
} from './production/error-handler.js';
export type {
  ErrorContext,
  ErrorHandlerConfig,
} from './production/error-handler.js';

export {
  RateLimiter,
  createRateLimiter,
} from './production/rate-limiter.js';
export type {
  RateLimiterConfig,
  RateLimitResult,
} from './production/rate-limiter.js';

export {
  withRetry,
  makeRetryable,
} from './production/retry.js';
export type {
  RetryConfig,
  RetryResult,
  RetryStrategy,
} from './production/retry.js';

export {
  CircuitBreaker,
  getCircuitBreaker,
  getAllCircuitStats,
  resetAllCircuits,
} from './production/circuit-breaker.js';
export type {
  CircuitBreakerConfig,
  CircuitState,
} from './production/circuit-breaker.js';

export {
  MonitoringHooks,
  createMonitor,
  getMonitor,
} from './production/monitoring.js';
export type {
  MonitorConfig,
  MetricEvent,
  HealthStatus,
  PerformanceMetrics,
} from './production/monitoring.js';

// Default export
export default CLI;
// pipeline trigger Sat Mar 14 02:09:25 PM UTC 2026
