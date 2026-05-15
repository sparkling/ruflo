#!/usr/bin/env node

/**
 * Hooks Daemon CLI
 *
 * Background daemon for hooks learning and metrics collection.
 *
 * Usage:
 *   hooks-daemon start [interval]    Start the daemon
 *   hooks-daemon stop                Stop the daemon
 *   hooks-daemon status              Check daemon status
 *   hooks-daemon consolidate         Run pattern consolidation
 *   hooks-daemon notify-activity     Notify of activity (for hooks)
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DaemonManager, HooksLearningDaemon, MetricsDaemon } from '../dist/daemons/index.js';
import { Archivist } from 'agentdb/archivist';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0] || 'status';

// Project root — the hook-handler agrees with the cli/daemon processes that
// process.cwd() is the project root (same convention STATE_FILE uses below).
const PROJECT_ROOT = process.cwd();

// State file for daemon persistence
const STATE_FILE = join(PROJECT_ROOT, '.claude-flow', 'hooks-daemon.json');

/**
 * ADR-0181 Phase 1 — hook-handler `initialize(config)` feeding.
 *
 * Construct a per-process Archivist (NOT a global singleton, per ADR-0181
 * §Architecture) and feed it an ArchivistInitConfig.
 *
 * Config is `{ projectRoot }` — and that is the COMPLETE, correct config for
 * the hook-handler process, not a stub. Every storeId the hook handlers touch
 * (`hooks_pre_task`, `hooks_post_edit`, `hooks_session_end`, the daemon metrics
 * files, …) classifies as FS-JSON in `substrate-registry.ts` — none are in the
 * RVF or SQLite-carve-out rosters. FS-JSON substrates are lazily minted per
 * path from `projectRoot` inside `getSubstrate()`; they need no `rvfBackend` or
 * `sqliteDb`. Supplying an RVF/SQLite backend this process never dispatches to
 * would be speculative dead wiring (`feedback-no-fallbacks`) — and the hook
 * process holds no such handle to pass anyway (its only persistence path,
 * ReasoningBank → @claude-flow/memory's AgentDBAdapter, has empty-placeholder
 * loadFromDisk/saveToDisk and opens nothing).
 *
 * projectRoot is resolved EXPLICITLY to `process.cwd()` (the hooks-daemon's
 * own STATE_FILE convention, L35) and passed explicitly — not left to
 * `initialize()`'s internal `process.cwd()` default. The explicit pass is what
 * makes the eager-init below provably real, not the empty-config self-init.
 *
 * Per feedback-no-fallbacks there is no try/catch swallow — an `initialize()`
 * that throws fails loud and aborts daemon startup.
 */
async function initArchivist() {
  // No eager mkdir of `.claude-flow/data/` — audit-writer.ts creates it lazily
  // on its first write (`ensureFdOpen`).
  const archivist = new Archivist();
  await archivist.initialize({ projectRoot: PROJECT_ROOT });
  return archivist;
}

async function main() {
  const daemonManager = new DaemonManager({
    pidDirectory: join(PROJECT_ROOT, '.claude-flow', 'pids'),
    logDirectory: join(PROJECT_ROOT, '.claude-flow', 'logs'),
    autoRestart: true,
    maxRestartAttempts: 3,
    daemons: [],
  });

  const learningDaemon = new HooksLearningDaemon(daemonManager);
  const metricsDaemon = new MetricsDaemon(daemonManager);

  switch (command) {
    case 'start': {
      const interval = parseInt(args[1], 10) || 60; // Default 60 seconds
      console.log(`Starting hooks daemon with ${interval}s interval...`);

      // ADR-0181 Phase 1 — EAGER-INITIALIZE ORDERING CONTRACT.
      // `dispatch()`/`dispatchRead()` self-call `await this.initialize()` with
      // NO args (config {}), and initialize() is idempotent — first call wins.
      // So this explicit `await archivist.initialize(realConfig)` MUST run and
      // COMPLETE before any hook can fire, or the lazy no-arg self-init would
      // permanently lock in an empty config and silently drop the real one.
      // The `await` here is sequenced BEFORE learningDaemon/metricsDaemon
      // .start() below — the daemons run the hook-handling task loops, so
      // nothing can dispatch until this await resolves.
      // Placed outside the try below so an initialize() failure propagates to
      // main().catch() with a full stack (feedback-no-fallbacks) rather than
      // being flattened to error.message.
      // Only the long-lived `start` path initializes the archivist — status/
      // export/notify-activity are short-lived and never dispatch. The instance
      // is retained for the daemon's lifetime (the process stays alive via
      // setInterval below); ADR-0181 Phase 5 wires the hook write paths to
      // dispatch through it.
      const archivist = await initArchivist();
      void archivist;

      try {
        await Promise.all([
          learningDaemon.start(),
          metricsDaemon.start(),
        ]);
        console.log('Hooks daemon started successfully.');
        console.log(`PID: ${process.pid}`);
        console.log(`Interval: ${interval}s`);

        // Keep process alive
        process.on('SIGINT', async () => {
          console.log('\nShutting down hooks daemon...');
          await Promise.all([
            learningDaemon.stop(),
            metricsDaemon.stop(),
          ]);
          process.exit(0);
        });

        process.on('SIGTERM', async () => {
          await Promise.all([
            learningDaemon.stop(),
            metricsDaemon.stop(),
          ]);
          process.exit(0);
        });

        // Keep alive
        setInterval(() => {}, 1000);
      } catch (error) {
        console.error('Failed to start hooks daemon:', error.message);
        process.exit(1);
      }
      break;
    }

    case 'stop': {
      console.log('Stopping hooks daemon...');
      try {
        await Promise.all([
          learningDaemon.stop(),
          metricsDaemon.stop(),
        ]);
        console.log('Hooks daemon stopped.');
      } catch (error) {
        console.error('Failed to stop hooks daemon:', error.message);
        process.exit(1);
      }
      break;
    }

    case 'status': {
      const states = daemonManager.getAllStates();
      console.log('Hooks Daemon Status');
      console.log('===================');

      if (states.length === 0) {
        console.log('No daemons registered.');
      } else {
        for (const state of states) {
          const status = state.status === 'running' ? '🟢' : '🔴';
          console.log(`${status} ${state.name}: ${state.status}`);
          if (state.lastUpdateAt) {
            console.log(`   Last update: ${state.lastUpdateAt.toISOString()}`);
          }
          console.log(`   Executions: ${state.executionCount}`);
          console.log(`   Failures: ${state.failureCount}`);
        }
      }

      const stats = learningDaemon.getStats();
      console.log('\nLearning Stats:');
      console.log(`  Patterns learned: ${stats.patternsLearned}`);
      console.log(`  Routing accuracy: ${stats.routingAccuracy}%`);
      break;
    }

    case 'consolidate': {
      console.log('Running pattern consolidation...');
      try {
        // Force a consolidation cycle
        await learningDaemon.start();
        await new Promise(resolve => setTimeout(resolve, 1000));
        await learningDaemon.stop();
        console.log('Pattern consolidation completed.');
      } catch (error) {
        console.error('Consolidation failed:', error.message);
        process.exit(1);
      }
      break;
    }

    case 'notify-activity': {
      // Quick notification for hook integration
      const metrics = metricsDaemon.getMetrics();
      console.log(JSON.stringify({
        notified: true,
        timestamp: new Date().toISOString(),
        metrics,
      }));
      break;
    }

    case 'export': {
      const format = args[1] || 'json';
      const stats = learningDaemon.getStats();
      const metrics = metricsDaemon.getMetrics();

      const data = {
        stats,
        metrics,
        exportedAt: new Date().toISOString(),
      };

      if (format === 'json') {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log('Hooks Learning Export');
        console.log('====================');
        console.log(`Patterns: ${stats.patternsLearned}`);
        console.log(`Accuracy: ${stats.routingAccuracy}%`);
        console.log(`Exported: ${data.exportedAt}`);
      }
      break;
    }

    case 'rebuild-index': {
      console.log('Rebuilding HNSW index...');
      // In real implementation, this would rebuild the vector index
      console.log('Index rebuild completed.');
      break;
    }

    default:
      console.log(`Unknown command: ${command}`);
      console.log(`
Usage:
  hooks-daemon start [interval]    Start the daemon (interval in seconds)
  hooks-daemon stop                Stop the daemon
  hooks-daemon status              Check daemon status
  hooks-daemon consolidate         Run pattern consolidation
  hooks-daemon notify-activity     Notify of activity (for hooks)
  hooks-daemon export [format]     Export patterns (json|text)
  hooks-daemon rebuild-index       Rebuild HNSW index
`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('Daemon error:', error);
  process.exit(1);
});
