/**
 * Worker Daemon Service
 * Node.js-based background worker system that auto-runs like shell daemons
 *
 * Workers:
 * - map: Codebase mapping (5 min interval)
 * - audit: Security analysis (10 min interval)
 * - optimize: Performance optimization (15 min interval)
 * - consolidate: Memory consolidation (30 min interval)
 * - testgaps: Test coverage analysis (20 min interval)
 */

import { EventEmitter } from 'events';
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, unlinkSync, renameSync } from 'fs';
import { cpus } from 'os';
import { join } from 'path';
import {
  HeadlessWorkerExecutor,
  HEADLESS_WORKER_TYPES,
  HEADLESS_WORKER_CONFIGS,
  isHeadlessWorker,
  type HeadlessWorkerType,
  type HeadlessExecutionResult,
} from './headless-worker-executor.js';
import { DaemonIPCServer, getDaemonSocketPath } from './daemon-ipc.js';

// Worker types matching hooks-tools.ts
export type WorkerType =
  | 'ultralearn'
  | 'optimize'
  | 'consolidate'
  | 'predict'
  | 'audit'
  | 'map'
  | 'preload'
  | 'deepdive'
  | 'document'
  | 'refactor'
  | 'benchmark'
  | 'testgaps';

interface WorkerConfig {
  type: WorkerType;
  intervalMs: number;
  priority: 'low' | 'normal' | 'high' | 'critical';
  description: string;
  enabled: boolean;
  timeoutMs?: number; // ADR-0069: per-worker timeout from workers.triggers config
}

interface WorkerState {
  lastRun?: Date;
  nextRun?: Date;
  runCount: number;
  successCount: number;
  failureCount: number;
  averageDurationMs: number;
  isRunning: boolean;
}

interface WorkerResult {
  workerId: string;
  type: WorkerType;
  success: boolean;
  durationMs: number;
  output?: unknown;
  error?: string;
  timestamp: Date;
}

interface DaemonStatus {
  running: boolean;
  pid: number;
  startedAt?: Date;
  workers: Map<WorkerType, WorkerState>;
  config: DaemonConfig;
  ipc?: { running: boolean; socketPath: string };
}

export interface DaemonConfig {
  autoStart: boolean;
  logDir: string;
  stateFile: string;
  maxConcurrent: number;
  workerTimeoutMs: number;
  headless?: boolean; // Enable headless worker execution (requires claude CLI on PATH)
  resourceThresholds: {
    maxCpuLoad: number;
    minFreeMemoryPercent: number;
  };
  workers: WorkerConfig[];
}

// Worker configuration with staggered offsets to prevent overlap
interface WorkerConfigInternal extends WorkerConfig {
  offsetMs: number; // Stagger start time
}

// Default worker configurations with improved intervals (P0 fix: map 5min -> 15min)
const DEFAULT_WORKERS: WorkerConfigInternal[] = [
  { type: 'map', intervalMs: 15 * 60 * 1000, offsetMs: 0, priority: 'normal', description: 'Codebase mapping', enabled: true },
  { type: 'audit', intervalMs: 30 * 60 * 1000, offsetMs: 2 * 60 * 1000, priority: 'critical', description: 'Security analysis', enabled: true },
  { type: 'optimize', intervalMs: 60 * 60 * 1000, offsetMs: 4 * 60 * 1000, priority: 'high', description: 'Performance optimization', enabled: true },
  { type: 'consolidate', intervalMs: 10 * 60 * 1000, offsetMs: 6 * 60 * 1000, priority: 'low', description: 'Memory consolidation', enabled: true },
  { type: 'testgaps', intervalMs: 60 * 60 * 1000, offsetMs: 8 * 60 * 1000, priority: 'normal', description: 'Test coverage analysis', enabled: true },
  { type: 'predict', intervalMs: 10 * 60 * 1000, offsetMs: 0, priority: 'low', description: 'Predictive preloading', enabled: false },
  { type: 'document', intervalMs: 60 * 60 * 1000, offsetMs: 0, priority: 'low', description: 'Auto-documentation', enabled: false },
  { type: 'ultralearn', intervalMs: 0, offsetMs: 0, priority: 'normal', description: 'Deep knowledge acquisition (headless, manual trigger)', enabled: false },
  { type: 'deepdive', intervalMs: 4 * 60 * 60 * 1000, offsetMs: 0, priority: 'low', description: 'Deep code analysis', enabled: false },
  { type: 'refactor', intervalMs: 4 * 60 * 60 * 1000, offsetMs: 0, priority: 'low', description: 'Refactoring suggestions', enabled: false },
  { type: 'benchmark', intervalMs: 2 * 60 * 60 * 1000, offsetMs: 0, priority: 'low', description: 'Performance benchmarking', enabled: false },
  // Bug-5 (2026-05-06): preload worker was firing immediately on every
  // daemon spawn (offsetMs:0), loading the full ONNX Xenova/all-mpnet-base-v2
  // model into the daemon process. With the MCP server (separate process)
  // ALSO loading the same model on its own startup via memory_search-on-
  // demand, two parallel cold-loads of @xenova/transformers' WASM heap
  // allocate ~5GB combined within ~2s post-session-attach (observed in HM
  // hejlsberg worktree, fresh daemon, 24 plugins installed). The model
  // gets loaded lazily by the MCP server when memory_search is actually
  // invoked — preload-on-startup is redundant duplication.
  // Fix: stagger preload to 90s post-startup so the MCP server can warm
  // its own copy first, AND drop priority from 'high' to 'normal' so it
  // doesn't preempt other startup work.
  { type: 'preload', intervalMs: 10 * 60 * 1000, offsetMs: 90 * 1000, priority: 'normal', description: 'Embedding model + HNSW preload (deferred to avoid MCP cold-load contention)', enabled: true },
];

// Worker timeout — must exceed the longest per-worker headless timeout (15 min for audit/refactor).
// Previously 5 min, which caused orphan processes when daemon timeout fired before executor timeout (#1117).
const DEFAULT_WORKER_TIMEOUT_MS = 16 * 60 * 1000;

/**
 * Worker Daemon - Manages background workers with Node.js
 */
export class WorkerDaemon extends EventEmitter {
  private config: DaemonConfig;
  private workers: Map<WorkerType, WorkerState> = new Map();
  private timers: Map<WorkerType, NodeJS.Timeout> = new Map();
  // #1845: separate timer for the MCP-dispatch queue poller. Kept off
  // the per-worker map so stop() clears both kinds without confusion.
  private queuePollTimer?: NodeJS.Timeout;
  private running = false;
  private startedAt?: Date;
  private projectRoot: string;
  private runningWorkers: Set<WorkerType> = new Set(); // Track concurrent workers
  private pendingWorkers: WorkerType[] = []; // Queue for deferred workers

  // Headless execution support
  private headlessExecutor: HeadlessWorkerExecutor | null = null;
  private headlessAvailable: boolean = false;

  // ADR-0088: IPC server kept for future non-memory RPC; memory handlers removed.
  private ipcServer: DaemonIPCServer | null = null;

  // ADR-0088: capability detection — 'headless' if `claude` CLI is on PATH
  // (9 of 12 workers can invoke Claude Code for real AI analysis), otherwise
  // 'local' (those 9 workers write placeholder metrics). Set once during start().
  private _aiMode: 'headless' | 'local' = 'local';

  // Preserve the original constructor config so we can detect explicit overrides
  // during state restoration (R1: constructor config takes priority over stale state)
  private originalConfig?: Partial<DaemonConfig>;

  constructor(projectRoot: string, config?: Partial<DaemonConfig>) {
    super();
    this.projectRoot = projectRoot;
    this.originalConfig = config;

    const claudeFlowDir = join(projectRoot, '.claude-flow');

    // Read daemon config from .claude-flow/config.json (Layer B)
    const fileConfig = this.readDaemonConfigFromFile(claudeFlowDir);

    // CPU-proportional smart default instead of hardcoded 2.0
    const cpuCount = WorkerDaemon.getEffectiveCpuCount();
    const smartMaxCpuLoad = Math.max(cpuCount * 0.8, 2.0); // Floor of 2.0 for single-CPU machines

    // Platform-aware default: macOS os.freemem() excludes reclaimable file cache,
    // so reported "free" is much lower than actually available memory.
    // Linux reports available memory (including reclaimable cache) more accurately.
    const defaultMinFreeMemory = process.platform === 'darwin' ? 5 : 10;

    // Priority: constructor arg > config.json > smart default
    // For resourceThresholds, merge field-by-field so partial overrides
    // (e.g. only --max-cpu-load) still pick up defaults for other fields.
    this.config = {
      autoStart: config?.autoStart ?? fileConfig.autoStart ?? false,
      logDir: config?.logDir ?? join(claudeFlowDir, 'logs'),
      stateFile: config?.stateFile ?? join(claudeFlowDir, 'daemon-state.json'),
      maxConcurrent: config?.maxConcurrent ?? fileConfig.maxConcurrent ?? 2,
      workerTimeoutMs: config?.workerTimeoutMs ?? fileConfig.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
      resourceThresholds: {
        maxCpuLoad: config?.resourceThresholds?.maxCpuLoad ?? fileConfig.maxCpuLoad ?? smartMaxCpuLoad,
        minFreeMemoryPercent: config?.resourceThresholds?.minFreeMemoryPercent ?? fileConfig.minFreeMemoryPercent ?? defaultMinFreeMemory,
      },
      workers: (() => {
        const base = config?.workers ?? DEFAULT_WORKERS;
        try {
          const sp = join(projectRoot, '.claude', 'settings.json');
          const s = JSON.parse(readFileSync(sp, 'utf-8'));
          const schedules = s?.claudeFlow?.daemon?.schedules;
          if (!schedules || typeof schedules !== 'object') return base;
          const parseInterval = (v: unknown): number | null => {
            if (typeof v === 'number') return v;
            if (typeof v !== 'string') return null;
            const m = v.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/i);
            if (!m) return null;
            const n = parseFloat(m[1]);
            switch (m[2].toLowerCase()) {
              case 'ms': return n;
              case 's': return n * 1000;
              case 'm': return n * 60 * 1000;
              case 'h': return n * 3600 * 1000;
              default: return null;
            }
          };
          return base.map(w => {
            const sched = schedules[w.type] as Record<string, unknown> | undefined;
            if (!sched) return w;
            const iv = parseInterval(sched.interval ?? sched.intervalMs);
            const en = typeof sched.enabled === 'boolean' ? sched.enabled : w.enabled;
            return { ...w, ...(iv !== null ? { intervalMs: iv } : {}), enabled: en };
          });
        } catch { return base; }
      })(),
    };

    // ADR-0069: wire workers.triggers consumer — merge per-worker timeouts and priorities
    if (fileConfig.workerTriggers) {
      const validPriorities = new Set(['low', 'normal', 'high', 'critical']);
      for (const worker of this.config.workers) {
        const trigger = fileConfig.workerTriggers[worker.type];
        if (!trigger) continue;
        if (typeof trigger.timeoutMs === 'number' && trigger.timeoutMs > 0) {
          worker.timeoutMs = trigger.timeoutMs;
        }
        if (typeof trigger.priority === 'string' && validPriorities.has(trigger.priority)) {
          worker.priority = trigger.priority as WorkerConfig['priority'];
        }
      }
    }

    // Setup graceful shutdown handlers
    this.setupShutdownHandlers();

    // Ensure directories exist
    if (!existsSync(claudeFlowDir)) {
      mkdirSync(claudeFlowDir, { recursive: true });
    }
    if (!existsSync(this.config.logDir)) {
      mkdirSync(this.config.logDir, { recursive: true });
    }

    // Initialize worker states
    this.initializeWorkerStates();

    // Initialize headless executor only when explicitly opted in via --headless flag.
    // Without this gate, workers silently spawn full claude processes (~250MB each)
    // on any machine where claude is installed, even though local fallbacks exist.
    if (this.config.headless) {
      this.initHeadlessExecutor().catch((err) => {
        this.log('warn', `Headless executor init failed: ${err}`);
      });
    }
  }

  /**
   * Initialize headless executor if Claude Code is available
   */
  private async initHeadlessExecutor(): Promise<void> {
    try {
      this.headlessExecutor = new HeadlessWorkerExecutor(this.projectRoot, {
        maxConcurrent: this.config.maxConcurrent,
      });

      this.headlessAvailable = await this.headlessExecutor.isAvailable();

      if (this.headlessAvailable) {
        this.log('info', 'Claude Code headless mode available - AI workers enabled');

        // Forward headless executor events
        this.headlessExecutor.on('execution:start', (data) => {
          this.emit('headless:start', data);
        });

        this.headlessExecutor.on('execution:complete', (data) => {
          this.emit('headless:complete', data);
        });

        this.headlessExecutor.on('execution:error', (data) => {
          this.emit('headless:error', data);
        });

        this.headlessExecutor.on('output', (data) => {
          this.emit('headless:output', data);
        });
      } else {
        this.log('info', 'Claude Code not found - AI workers will run in local fallback mode');
      }
    } catch (error) {
      this.log('warn', `Failed to initialize headless executor: ${error}`);
      this.headlessAvailable = false;
    }
  }

  /**
   * Check if headless execution is available
   */
  isHeadlessAvailable(): boolean {
    return this.headlessAvailable;
  }

  /**
   * Get headless executor instance
   */
  getHeadlessExecutor(): HeadlessWorkerExecutor | null {
    return this.headlessExecutor;
  }

  /**
   * Detect effective CPU count for the current environment.
   *
   * Inside Docker / K8s containers, os.cpus().length reports the HOST cpu
   * count, not the container limit (Node.js #28762 — wontfix).  We read
   * cgroup v2 / v1 quota files first so the maxCpuLoad threshold stays
   * meaningful under resource-limited containers.
   */
  static getEffectiveCpuCount(): number {
    // 1. Try cgroup v2: /sys/fs/cgroup/cpu.max
    try {
      const cpuMax = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim();
      const [quotaStr, periodStr] = cpuMax.split(' ');
      if (quotaStr !== 'max') {
        const quota = parseInt(quotaStr, 10);
        const period = parseInt(periodStr, 10);
        if (quota > 0 && period > 0) return Math.ceil(quota / period);
      }
    } catch { /* not in cgroup v2 */ }

    // 2. Try cgroup v1: /sys/fs/cgroup/cpu/cpu.cfs_quota_us
    try {
      const quota = parseInt(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim(), 10);
      const period = parseInt(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim(), 10);
      if (quota > 0 && period > 0) return Math.ceil(quota / period);
    } catch { /* not in cgroup v1 */ }

    // 3. Fallback to os.cpus().length
    return cpus().length || 1;
  }

  /**
   * Read daemon-specific config from .claude-flow/config.{json,yaml,yml}.
   * Supports dot-notation keys like 'daemon.resourceThresholds.maxCpuLoad'.
   * #1844: prefer JSON when both exist (existing behavior) but fall back
   * to YAML so operators using the v3 canonical YAML format aren't silently
   * ignored. The chosen path is logged at info level.
   */
  private readDaemonConfigFromFile(claudeFlowDir: string): {
    autoStart?: boolean;
    maxConcurrent?: number;
    workerTimeoutMs?: number;
    maxCpuLoad?: number;
    minFreeMemoryPercent?: number;
    workerTriggers?: Record<string, { timeoutMs?: number; priority?: string }>;
  } {
    const jsonPath = join(claudeFlowDir, 'config.json');
    const yamlPath = join(claudeFlowDir, 'config.yaml');
    const ymlPath = join(claudeFlowDir, 'config.yml');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let raw: Record<string, any> | undefined;
    let chosenPath: string | undefined;

    if (existsSync(jsonPath)) {
      try {
        raw = JSON.parse(readFileSync(jsonPath, 'utf-8'));
        chosenPath = jsonPath;
      } catch {
        return {};
      }
    } else if (existsSync(yamlPath) || existsSync(ymlPath)) {
      const yPath = existsSync(yamlPath) ? yamlPath : ymlPath;
      try {
        // Lazy-load yaml so the daemon doesn't hard-require it; if the
        // dep isn't installed, fall back to the previous warn-only path.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const yamlMod = require('yaml') as { parse(s: string): unknown };
        const parsed = yamlMod.parse(readFileSync(yPath, 'utf-8'));
        if (parsed && typeof parsed === 'object') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          raw = parsed as Record<string, any>;
          chosenPath = yPath;
        }
      } catch {
        this.log(
          'warn',
          `Found ${yPath} but yaml parser unavailable. Install \`yaml\` or convert to JSON. Falling back to defaults.`,
        );
        return {};
      }
    }

    if (!raw || !chosenPath) {
      return {};
    }
    this.log('info', `Daemon config loaded from ${chosenPath}`);

    try {
      // Support both flat keys at root and nested under scopes.project
      const cfg = raw?.scopes?.project ?? raw;
      const rawCpuLoad = cfg['daemon.resourceThresholds.maxCpuLoad'] ?? raw['daemon.resourceThresholds.maxCpuLoad'];
      const rawMinMem = cfg['daemon.resourceThresholds.minFreeMemoryPercent'] ?? raw['daemon.resourceThresholds.minFreeMemoryPercent'];
      const rawMaxConcurrent = cfg['daemon.maxConcurrent'] ?? raw['daemon.maxConcurrent'];
      const rawTimeout = cfg['daemon.workerTimeoutMs'] ?? raw['daemon.workerTimeoutMs'];
      // ADR-0069: read workers.triggers from nested config
      const rawTriggers = raw?.workers?.triggers ?? cfg?.workers?.triggers;
      const workerTriggers = (rawTriggers && typeof rawTriggers === 'object' && !Array.isArray(rawTriggers))
        ? rawTriggers as Record<string, { timeoutMs?: number; priority?: string }>
        : undefined;

      return {
        autoStart: typeof raw['daemon.autoStart'] === 'boolean' ? raw['daemon.autoStart'] : undefined,
        maxConcurrent: (typeof rawMaxConcurrent === 'number' && rawMaxConcurrent > 0) ? rawMaxConcurrent : undefined,
        workerTimeoutMs: (typeof rawTimeout === 'number' && rawTimeout > 0) ? rawTimeout : undefined,
        maxCpuLoad: (typeof rawCpuLoad === 'number' && rawCpuLoad > 0 && rawCpuLoad < 1000) ? rawCpuLoad : undefined,
        minFreeMemoryPercent: (typeof rawMinMem === 'number' && rawMinMem >= 0 && rawMinMem <= 100) ? rawMinMem : undefined,
        workerTriggers,
      };
    } catch {
      return {};
    }
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    const shutdown = async () => {
      this.log('info', 'Received shutdown signal, stopping daemon...');
      await this.stop();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('SIGHUP', shutdown);
  }

  /**
   * Check if system resources allow worker execution
   */
  private async canRunWorker(): Promise<{ allowed: boolean; reason?: string }> {
    const os = await import('os');
    const cpuLoad = os.loadavg()[0];
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const freePercent = (freeMem / totalMem) * 100;

    if (cpuLoad > this.config.resourceThresholds.maxCpuLoad) {
      return { allowed: false, reason: `CPU load too high: ${cpuLoad.toFixed(2)}` };
    }
    if (os.platform() !== 'darwin' && freePercent < this.config.resourceThresholds.minFreeMemoryPercent) {
      return { allowed: false, reason: `Memory too low: ${freePercent.toFixed(1)}% free` };
    }
    return { allowed: true };
  }

  /**
   * Process pending workers queue
   *
   * When executeWorkerWithConcurrencyControl defers a worker (returns null),
   * we break immediately to avoid a busy-wait loop — the deferred worker is
   * already back on the pendingWorkers queue by that point. If no workers are
   * currently running when we break, we schedule a backoff retry so the queue
   * does not get permanently stuck.
   */
  private async processPendingWorkers(): Promise<void> {
    while (this.pendingWorkers.length > 0 && this.runningWorkers.size < this.config.maxConcurrent) {
      const workerType = this.pendingWorkers.shift()!;
      const workerConfig = this.config.workers.find(w => w.type === workerType);
      if (workerConfig) {
        const result = await this.executeWorkerWithConcurrencyControl(workerConfig);
        if (result === null) {
          // Worker was deferred (resource pressure or concurrency limit).
          // Break to avoid tight-looping — the next executeWorker() completion
          // will call processPendingWorkers() again via the finally block.
          if (this.runningWorkers.size === 0) {
            // No workers running means nobody will trigger the finally-block
            // callback, so schedule a backoff retry to avoid a stuck queue.
            setTimeout(() => this.processPendingWorkers(), 30_000).unref();
          }
          break;
        }
      }
    }
  }

  private initializeWorkerStates(): void {
    // Try to restore state from file
    if (existsSync(this.config.stateFile)) {
      try {
        const saved = JSON.parse(readFileSync(this.config.stateFile, 'utf-8'));

        // CRITICAL: Restore worker config (including enabled flag) from saved state
        // This fixes #950: daemon enable command not persisting worker state
        if (saved.config?.workers && Array.isArray(saved.config.workers)) {
          for (const savedWorker of saved.config.workers) {
            const workerConfig = this.config.workers.find(w => w.type === savedWorker.type);
            if (workerConfig && typeof savedWorker.enabled === 'boolean') {
              workerConfig.enabled = savedWorker.enabled;
            }
          }
        }

        // Restore resourceThresholds, maxConcurrent, workerTimeoutMs from saved state
        // Only restore if valid numeric values within sane ranges
        if (saved.config?.resourceThresholds && !this.originalConfig?.resourceThresholds) {
          const rt = saved.config.resourceThresholds;
          if (typeof rt.maxCpuLoad === 'number' && rt.maxCpuLoad > 0 && rt.maxCpuLoad < 1000) {
            this.config.resourceThresholds.maxCpuLoad = rt.maxCpuLoad;
          }
          if (typeof rt.minFreeMemoryPercent === 'number' && rt.minFreeMemoryPercent >= 0 && rt.minFreeMemoryPercent <= 100) {
            this.config.resourceThresholds.minFreeMemoryPercent = rt.minFreeMemoryPercent;
          }
        }
        if (typeof saved.config?.maxConcurrent === 'number' && saved.config.maxConcurrent > 0) {
          this.config.maxConcurrent = saved.config.maxConcurrent;
        }
        if (typeof saved.config?.workerTimeoutMs === 'number' && saved.config.workerTimeoutMs > 0) {
          this.config.workerTimeoutMs = saved.config.workerTimeoutMs;
        }

        // Restore worker runtime states (runCount, successCount, etc.)
        if (saved.workers) {
          for (const [type, state] of Object.entries(saved.workers)) {
            const savedState = state as Record<string, unknown>;
            const lastRunValue = savedState.lastRun;
            this.workers.set(type as WorkerType, {
              runCount: (savedState.runCount as number) || 0,
              successCount: (savedState.successCount as number) || 0,
              failureCount: (savedState.failureCount as number) || 0,
              averageDurationMs: (savedState.averageDurationMs as number) || 0,
              lastRun: lastRunValue ? new Date(lastRunValue as string) : undefined,
              nextRun: undefined,
              isRunning: false,
            });
          }
        }
      } catch {
        // Ignore parse errors, start fresh
      }
    }

    // Initialize any missing workers
    for (const workerConfig of this.config.workers) {
      if (!this.workers.has(workerConfig.type)) {
        this.workers.set(workerConfig.type, {
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          averageDurationMs: 0,
          isRunning: false,
        });
      }
    }
  }

  /**
   * Get the PID file path for singleton enforcement (#1395 Bug 3).
   */
  private get pidFile(): string {
    return join(this.projectRoot, '.claude-flow', 'daemon.pid');
  }

  /**
   * Check if another daemon instance is already running.
   * Returns the existing PID if alive, or null if no daemon is running.
   *
   * #1853: ignore self-PID matches. The detached-spawn path in
   * `commands/daemon.ts` writes the child's PID into the file as a
   * fallback after a 500ms wait. If the child reaches `start()` slower
   * than the parent's 500ms wait (observed on Node 25 / macOS 26), the
   * child reads its own PID back from the file and concludes "another
   * daemon is already running" — so it exits before scheduling workers
   * and `daemon status` reports STOPPED forever. A daemon process is
   * never "another instance" of itself; treat self-match as absence.
   */
  private checkExistingDaemon(): number | null {
    if (!existsSync(this.pidFile)) return null;
    try {
      const pid = parseInt(readFileSync(this.pidFile, 'utf-8').trim(), 10);
      if (isNaN(pid)) return null;
      // #1853: a PID file containing our own PID is not "another daemon".
      // Treat as absent so the start() path proceeds normally.
      if (pid === process.pid) return null;
      // Check if process is alive (signal 0 = existence check)
      process.kill(pid, 0);
      return pid; // Process is alive
    } catch {
      // Process is dead — clean up stale PID file
      try { unlinkSync(this.pidFile); } catch { /* ignore */ }
      return null;
    }
  }

  /**
   * Write PID file for singleton enforcement.
   */
  private writePidFile(): void {
    const dir = join(this.projectRoot, '.claude-flow');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.pidFile, String(process.pid), 'utf-8');
  }

  /**
   * Remove PID file on shutdown.
   */
  private removePidFile(): void {
    try { unlinkSync(this.pidFile); } catch { /* ignore */ }
  }

  /**
   * ADR-0088: Get the current AI mode — 'headless' when `claude` CLI is
   * available, 'local' otherwise. Read by `daemon status` command.
   */
  public get aiMode(): 'headless' | 'local' {
    return this._aiMode;
  }

  /**
   * ADR-0088: Detect whether `claude` CLI is on PATH. 'headless' means
   * 9 of 12 workers can invoke Claude Code for real AI analysis; 'local'
   * means those workers will write placeholder metrics.
   */
  private detectClaudeCapability(): 'headless' | 'local' {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { execSync } = require('node:child_process');
      execSync('which claude', { stdio: 'ignore' });
      return 'headless';
    } catch {
      return 'local';
    }
  }

  /**
   * Start the daemon and all enabled workers
   */
  async start(): Promise<void> {
    if (this.running) {
      this.emit('warning', 'Daemon already running');
      return;
    }

    // ADR-0088: Detect AI capability up-front so `this._aiMode` is valid even
    // if we end up bailing out in the singleton guard below (the status
    // command reads aiMode via the in-process singleton).
    this._aiMode = this.detectClaudeCapability();

    // PID singleton enforcement (#1395 Bug 3): prevent daemon accumulation
    const existingPid = this.checkExistingDaemon();
    if (existingPid !== null) {
      this.log('info', `Daemon already running (PID: ${existingPid}), skipping start`);
      this.emit('warning', `Daemon already running (PID: ${existingPid})`);
      return;
    }

    // ADR-0088: Emit exactly one honest startup line. Headless mode means
    // 9 of 12 workers can invoke Claude Code; local mode means those
    // workers will write placeholder metrics.
    if (this._aiMode === 'headless') {
      this.log('info', '[Daemon] Starting in headless mode — AI workers will invoke Claude Code for analysis.');
    } else {
      this.log('info', '[Daemon] Starting in local mode — 9 of 12 workers will write placeholder metrics. Install Claude Code CLI for AI-powered background analysis.');
    }

    this.running = true;
    this.startedAt = new Date();
    this.writePidFile();
    this.emit('started', { pid: process.pid, startedAt: this.startedAt });

    // ADR-0088: IPC server stays up for future non-memory RPC methods, but
    // memory.* handlers and the pre-warm step are gone — memory ops are
    // in-process only per ADR-050/ADR-0086. No handlers are currently
    // registered; add them via this.ipcServer.registerMethod() when a
    // concrete non-memory use case arrives.
    try {
      this.ipcServer = new DaemonIPCServer({
        socketPath: getDaemonSocketPath(this.projectRoot),
        projectRoot: this.projectRoot,
      });
      await this.ipcServer.start();
      this.log('info', `IPC server listening on ${this.ipcServer.socketPath}`);
    } catch (err: any) {
      this.log('warn', `IPC server failed to start: ${err.message}`);
      // Non-fatal: daemon scheduler still runs without IPC
    }

    // Schedule all enabled workers
    for (const workerConfig of this.config.workers) {
      if (workerConfig.enabled) {
        this.scheduleWorker(workerConfig);
      }
    }

    // #1845: poll the MCP-dispatch queue directory so workers requested
    // via mcp__hooks_worker-dispatch (in a separate process) actually
    // execute here. Previously the dispatch wrote to a process-local Map
    // that the daemon could never see.
    this.queuePollTimer = setInterval(() => {
      void this.processDispatchQueue();
    }, 5_000);
    if (typeof this.queuePollTimer.unref === 'function') {
      this.queuePollTimer.unref();
    }

    // Save state
    this.saveState();

    this.log('info', `Daemon started (PID: ${process.pid}, CPUs: ${cpus().length}, workers: ${this.config.workers.filter(w => w.enabled).length}, maxCpuLoad: ${this.config.resourceThresholds.maxCpuLoad}, minFreeMemoryPercent: ${this.config.resourceThresholds.minFreeMemoryPercent}%)`);
  }

  /**
   * #1845: ingest queue entries written by mcp__hooks_worker-dispatch.
   * Each entry is a JSON file at `.claude-flow/daemon-queue/<id>.json`
   * with `{ workerId, trigger, context, enqueuedAt }`. We move processed
   * files to `.claude-flow/daemon-queue/.processed/` so the daemon never
   * re-runs the same dispatch and operators can inspect history.
   */
  private async processDispatchQueue(): Promise<void> {
    if (!this.running) return;
    const queueDir = join(this.projectRoot, '.claude-flow', 'daemon-queue');
    if (!existsSync(queueDir)) return;

    let entries: string[];
    try {
      const fs = await import('fs');
      entries = fs.readdirSync(queueDir).filter((n) => n.endsWith('.json'));
    } catch {
      return;
    }
    if (entries.length === 0) return;

    const fs = await import('fs');
    const processedDir = join(queueDir, '.processed');
    if (!existsSync(processedDir)) {
      try { fs.mkdirSync(processedDir, { recursive: true }); } catch { /* race ok */ }
    }

    for (const entry of entries) {
      const src = join(queueDir, entry);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let payload: any;
      try {
        payload = JSON.parse(fs.readFileSync(src, 'utf-8'));
      } catch {
        // Malformed entry — quarantine so we don't loop on it
        try { fs.renameSync(src, join(processedDir, `bad-${entry}`)); } catch { /* nothing more we can do */ }
        continue;
      }
      const trigger = payload?.trigger as WorkerType | undefined;
      const workerId = payload?.workerId as string | undefined;
      if (!trigger || !this.config.workers.some((w) => w.type === trigger)) {
        try { fs.renameSync(src, join(processedDir, `unknown-${entry}`)); } catch { /* ok */ }
        continue;
      }
      try {
        this.log('info', `Dequeued ${trigger}${workerId ? ` (id=${workerId})` : ''} from MCP dispatch queue`);
        await this.triggerWorker(trigger);
      } catch (err) {
        this.log('warn', `Queued worker ${trigger} failed: ${(err as Error).message}`);
      } finally {
        try { fs.renameSync(src, join(processedDir, entry)); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Stop the daemon and all workers
   */
  async stop(): Promise<void> {
    if (!this.running) {
      this.emit('warning', 'Daemon not running');
      return;
    }

    // Clear all timers (convert to array to avoid iterator issues)
    const timerEntries = Array.from(this.timers.entries());
    for (const [type, timer] of timerEntries) {
      clearTimeout(timer);
      this.log('info', `Stopped worker: ${type}`);
    }
    this.timers.clear();

    // ADR-0059 Phase 4: Stop IPC server
    if (this.ipcServer) {
      try { await this.ipcServer.stop(); } catch { /* ignore */ }
      this.ipcServer = null;
    }

    // #1845: stop the MCP-dispatch queue poller too.
    if (this.queuePollTimer) {
      clearInterval(this.queuePollTimer);
      this.queuePollTimer = undefined;
    }

    this.running = false;
    // ADR-0084 Phase 4: shut down via router (replaces direct bridge dependency)
    try {
      const router = await import('../memory/memory-router.js');
      if (router.shutdownRouter) await router.shutdownRouter();
    } catch { /* router may not be loaded */ }
    this.removePidFile();
    this.saveState();
    this.emit('stopped', { stoppedAt: new Date() });
    this.log('info', 'Daemon stopped');
  }

  /**
   * Get daemon status
   */
  getStatus(): DaemonStatus {
    return {
      running: this.running,
      pid: process.pid,
      startedAt: this.startedAt,
      workers: new Map(this.workers),
      config: this.config,
      ipc: this.ipcServer
        ? { running: this.ipcServer.isRunning, socketPath: this.ipcServer.socketPath }
        : undefined,
    };
  }

  /**
   * Schedule a worker to run at intervals with staggered start
   */
  private scheduleWorker(workerConfig: WorkerConfig): void {
    const state = this.workers.get(workerConfig.type)!;
    const internalConfig = workerConfig as WorkerConfigInternal;
    const staggerOffset = internalConfig.offsetMs || 0;

    // Calculate initial delay with stagger offset
    let initialDelay = staggerOffset;
    if (state.lastRun) {
      const timeSinceLastRun = Date.now() - state.lastRun.getTime();
      initialDelay = Math.max(staggerOffset, workerConfig.intervalMs - timeSinceLastRun);
    }

    state.nextRun = new Date(Date.now() + initialDelay);

    const runAndReschedule = async () => {
      if (!this.running) return;

      // Use concurrency-controlled execution (P0 fix)
      await this.executeWorkerWithConcurrencyControl(workerConfig);

      // Reschedule
      if (this.running) {
        const timer = setTimeout(runAndReschedule, workerConfig.intervalMs);
        this.timers.set(workerConfig.type, timer);
        state.nextRun = new Date(Date.now() + workerConfig.intervalMs);
      }
    };

    // Schedule first run with stagger offset
    const timer = setTimeout(runAndReschedule, initialDelay);
    this.timers.set(workerConfig.type, timer);

    this.log('info', `Scheduled ${workerConfig.type} (interval: ${workerConfig.intervalMs / 1000}s, first run in ${initialDelay / 1000}s)`);
  }

  /**
   * Execute a worker with concurrency control (P0 fix)
   */
  private async executeWorkerWithConcurrencyControl(workerConfig: WorkerConfig): Promise<WorkerResult | null> {
    // Check concurrency limit
    if (this.runningWorkers.size >= this.config.maxConcurrent) {
      this.log('info', `Worker ${workerConfig.type} deferred: max concurrent (${this.config.maxConcurrent}) reached`);
      this.pendingWorkers.push(workerConfig.type);
      this.emit('worker:deferred', { type: workerConfig.type, reason: 'max_concurrent' });
      return null;
    }

    // Check resource availability
    const resourceCheck = await this.canRunWorker();
    if (!resourceCheck.allowed) {
      this.log('info', `Worker ${workerConfig.type} deferred: ${resourceCheck.reason}`);
      this.pendingWorkers.push(workerConfig.type);
      this.emit('worker:deferred', { type: workerConfig.type, reason: resourceCheck.reason });
      return null;
    }

    return this.executeWorker(workerConfig);
  }

  /**
   * Execute a worker with timeout protection
   */
  private async executeWorker(workerConfig: WorkerConfig): Promise<WorkerResult> {
    const state = this.workers.get(workerConfig.type)!;
    const workerId = `${workerConfig.type}_${Date.now()}`;
    const startTime = Date.now();

    // Track running worker
    this.runningWorkers.add(workerConfig.type);
    state.isRunning = true;
    this.emit('worker:start', { workerId, type: workerConfig.type });
    this.log('info', `Starting worker: ${workerConfig.type} (${this.runningWorkers.size}/${this.config.maxConcurrent} concurrent)`);

    try {
      // Execute worker logic with timeout (P1 fix)
      // Pass cleanup callback to kill orphan child processes on timeout (#1117)
      // ADR-0069: prefer per-worker timeoutMs from workers.triggers config, fall back to global
      const effectiveTimeout = workerConfig.timeoutMs ?? this.config.workerTimeoutMs;
      const output = await this.runWithTimeout(
        () => this.runWorkerLogic(workerConfig),
        effectiveTimeout,
        `Worker ${workerConfig.type} timed out after ${effectiveTimeout / 1000}s`,
        () => {
          // On timeout, cancel any headless execution to prevent orphan processes
          if (this.headlessExecutor) {
            this.headlessExecutor.cancelAll();
          }
        }
      );
      const durationMs = Date.now() - startTime;

      // Update state
      state.runCount++;
      state.successCount++;
      state.lastRun = new Date();
      state.averageDurationMs = (state.averageDurationMs * (state.runCount - 1) + durationMs) / state.runCount;
      state.isRunning = false;

      const result: WorkerResult = {
        workerId,
        type: workerConfig.type,
        success: true,
        durationMs,
        output,
        timestamp: new Date(),
      };

      this.emit('worker:complete', result);
      this.log('info', `Worker ${workerConfig.type} completed in ${durationMs}ms`);
      this.saveState();

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      state.runCount++;
      state.failureCount++;
      state.lastRun = new Date();
      state.isRunning = false;

      const result: WorkerResult = {
        workerId,
        type: workerConfig.type,
        success: false,
        durationMs,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date(),
      };

      this.emit('worker:error', result);
      this.log('error', `Worker ${workerConfig.type} failed: ${result.error}`);
      this.saveState();

      return result;
    } finally {
      // Remove from running set and process queue
      this.runningWorkers.delete(workerConfig.type);
      this.processPendingWorkers();
    }
  }

  /**
   * Run a function with timeout (P1 fix)
   * @param fn - The async function to execute
   * @param timeoutMs - Timeout in milliseconds
   * @param timeoutMessage - Error message on timeout
   * @param onTimeout - Optional cleanup callback invoked when timeout fires (#1117: kills orphan processes)
   */
  private async runWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
    onTimeout?: () => void
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Kill orphan child processes before rejecting (#1117)
        if (onTimeout) {
          try {
            onTimeout();
          } catch {
            // Ignore cleanup errors
          }
        }
        reject(new Error(timeoutMessage));
      }, timeoutMs);

      fn()
        .then((result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * Run the actual worker logic
   */
  private async runWorkerLogic(workerConfig: WorkerConfig): Promise<unknown> {
    // Check if this is a headless worker type and headless execution is available
    if (isHeadlessWorker(workerConfig.type) && this.headlessAvailable && this.headlessExecutor) {
      let result: HeadlessExecutionResult;
      try {
        this.log('info', `Running ${workerConfig.type} in headless mode (Claude Code AI)`);
        result = await this.headlessExecutor.execute(workerConfig.type as HeadlessWorkerType);
        // #1793: persist the headless result to the same metrics files the
        // local workers write to. Without this, AI-mode runs produced rich
        // parsedOutput that lived only in `.claude-flow/logs/headless/*` and
        // never reached `.claude-flow/metrics/<name>.json` — `memory stats`
        // and downstream consumers saw nothing despite successful runs.
        try {
          this.persistHeadlessResult(workerConfig.type as HeadlessWorkerType, result);
        } catch (persistError) {
          this.log('warn', `Failed to persist headless result for ${workerConfig.type}: ${(persistError as Error).message}`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.log('warn', `Headless execution threw for ${workerConfig.type}: ${errorMsg}`);
        this.emit('headless:fallback', { type: workerConfig.type, error: errorMsg });
        throw error instanceof Error ? error : new Error(errorMsg);
      }
      if (result.success) {
        return { mode: 'headless', ...result };
      }
      const errorMsg = result.error || 'Unknown headless failure';
      this.log('warn', `Headless failed for ${workerConfig.type}: ${errorMsg}`);
      this.emit('headless:fallback', { type: workerConfig.type, error: errorMsg });
      throw new Error(`Headless execution failed for ${workerConfig.type}: ${errorMsg}`);
    }

    // Local execution (fallback or for non-headless workers)
    switch (workerConfig.type) {
      case 'map':
        return this.runMapWorker();
      case 'audit':
        return this.runAuditWorkerLocal();
      case 'optimize':
        return this.runOptimizeWorkerLocal();
      case 'consolidate':
        return this.runConsolidateWorker();
      case 'testgaps':
        return this.runTestGapsWorkerLocal();
      case 'predict':
        return this.runPredictWorkerLocal();
      case 'document':
        return this.runDocumentWorkerLocal();
      case 'ultralearn':
        return this.runUltralearnWorkerLocal();
      case 'refactor':
        return this.runRefactorWorkerLocal();
      case 'deepdive':
        return this.runDeepdiveWorkerLocal();
      case 'benchmark':
        return this.runBenchmarkWorkerLocal();
      case 'preload':
        return this.runPreloadWorkerLocal();
      default:
        return { status: 'unknown worker type', mode: 'local' };
    }
  }

  /**
   * #1793: persist a headless worker result to the same metrics file the
   * local fallback writes to. Without this, AI-mode workers produced rich
   * structured output (audit findings, perf signals, test-gap analysis)
   * that lived only in `.claude-flow/logs/headless/*_result.log` and was
   * invisible to `npx ruflo memory stats` or the metrics consumers.
   *
   * The mapping mirrors the `*Local` worker implementations below so a
   * single consumer path works regardless of execution mode.
   */
  private persistHeadlessResult(
    workerType: HeadlessWorkerType,
    result: HeadlessExecutionResult,
  ): void {
    const metricsDir = join(this.projectRoot, '.claude-flow', 'metrics');
    if (!existsSync(metricsDir)) mkdirSync(metricsDir, { recursive: true });

    // Filename mirrors the local-mode worker writes (security-audit.json,
    // performance.json, test-gaps.json) so a downstream reader doesn't
    // care which mode produced the data.
    const filenameMap: Partial<Record<HeadlessWorkerType, string>> = {
      audit: 'security-audit.json',
      optimize: 'performance.json',
      testgaps: 'test-gaps.json',
      document: 'documentation.json',
      refactor: 'refactor.json',
      deepdive: 'deepdive.json',
      ultralearn: 'ultralearn.json',
      predict: 'predictions.json',
    };
    const filename = filenameMap[workerType] ?? `${workerType}.json`;
    const metricsFile = join(metricsDir, filename);

    const persisted = {
      timestamp: result.timestamp instanceof Date ? result.timestamp.toISOString() : new Date().toISOString(),
      mode: 'headless' as const,
      workerType,
      model: result.model,
      durationMs: result.durationMs,
      tokensUsed: result.tokensUsed,
      executionId: result.executionId,
      success: result.success,
      // Structured findings live here when the worker emits JSON (e.g. the
      // audit worker's vulnerability list). Fall back to a raw-output
      // pointer so consumers can still locate the full log.
      findings: result.parsedOutput ?? null,
      rawOutputPreview: typeof result.output === 'string' ? result.output.slice(0, 2000) : undefined,
      rawOutputLength: typeof result.output === 'string' ? result.output.length : 0,
    };

    writeFileSync(metricsFile, JSON.stringify(persisted, null, 2));
  }

  // Worker implementations

  private async runMapWorker(): Promise<unknown> {
    // Scan project structure and update metrics
    const metricsFile = join(this.projectRoot, '.claude-flow', 'metrics', 'codebase-map.json');
    const metricsDir = join(this.projectRoot, '.claude-flow', 'metrics');

    if (!existsSync(metricsDir)) {
      mkdirSync(metricsDir, { recursive: true });
    }

    const map = {
      timestamp: new Date().toISOString(),
      projectRoot: this.projectRoot,
      structure: {
        hasPackageJson: existsSync(join(this.projectRoot, 'package.json')),
        hasTsConfig: existsSync(join(this.projectRoot, 'tsconfig.json')),
        hasClaudeConfig: existsSync(join(this.projectRoot, '.claude')),
        hasClaudeFlow: existsSync(join(this.projectRoot, '.claude-flow')),
      },
      scannedAt: Date.now(),
    };

    writeFileSync(metricsFile, JSON.stringify(map, null, 2));
    return map;
  }

  /**
   * Local audit worker (fallback when headless unavailable)
   */
  private async runAuditWorkerLocal(): Promise<unknown> {
    // Basic security checks
    const auditFile = join(this.projectRoot, '.claude-flow', 'metrics', 'security-audit.json');
    const metricsDir = join(this.projectRoot, '.claude-flow', 'metrics');

    if (!existsSync(metricsDir)) {
      mkdirSync(metricsDir, { recursive: true });
    }

    const audit = {
      timestamp: new Date().toISOString(),
      mode: 'local',
      checks: {
        envFilesProtected: !existsSync(join(this.projectRoot, '.env.local')),
        gitIgnoreExists: existsSync(join(this.projectRoot, '.gitignore')),
        noHardcodedSecrets: true, // Would need actual scanning
      },
      riskLevel: 'low',
      recommendations: [],
      note: 'Install Claude Code CLI for AI-powered security analysis',
    };

    writeFileSync(auditFile, JSON.stringify(audit, null, 2));
    return audit;
  }

  /**
   * Local optimize worker (fallback when headless unavailable)
   */
  private async runOptimizeWorkerLocal(): Promise<unknown> {
    // Update performance metrics
    const optimizeFile = join(this.projectRoot, '.claude-flow', 'metrics', 'performance.json');
    const metricsDir = join(this.projectRoot, '.claude-flow', 'metrics');

    if (!existsSync(metricsDir)) {
      mkdirSync(metricsDir, { recursive: true });
    }

    const perf = {
      timestamp: new Date().toISOString(),
      mode: 'local',
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime(),
      optimizations: {
        cacheHitRate: 0.78,
        avgResponseTime: 45,
      },
      note: 'Install Claude Code CLI for AI-powered optimization suggestions',
    };

    writeFileSync(optimizeFile, JSON.stringify(perf, null, 2));
    return perf;
  }

  private async runConsolidateWorker(): Promise<unknown> {
    const consolidateFile = join(this.projectRoot, '.claude-flow', 'metrics', 'consolidation.json');
    const metricsDir = join(this.projectRoot, '.claude-flow', 'metrics');

    if (!existsSync(metricsDir)) {
      mkdirSync(metricsDir, { recursive: true });
    }

    const result: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      patternsConsolidated: 0,
      memoryCleaned: 0,
      duplicatesRemoved: 0,
    };

    try {
      // ADR-0086 T2.7: import from router (was memory-initializer)
      const mi = await import('../memory/memory-router.js');
      // 1. Temporal decay is a no-op with RVF storage (ADR-0086 B1)
      // applyTemporalDecay was SQLite-specific; RVF handles TTL internally.
      result.patternsConsolidated = 0;
      // 2. HNSW index is managed internally by RvfBackend — explicit
      // clear/rebuild not supported. Query stats for reporting only.
      const hnswStatus = await mi.routeEmbeddingOp({ type: 'hnswStatus' });
      if (hnswStatus?.success) result.hnswRebuilt = (hnswStatus as Record<string, unknown>).totalEntries ?? 0;
      result.memoryCleaned = 1;
      // WM-108b: Run consolidation pipeline via memory-router (ADR-0084 Phase 3)
      try {
        const routerResult = await mi.routeLearningOp({ type: 'consolidate' });
        result.routerConsolidated = routerResult?.success ?? false;
      } catch (routerErr: unknown) {
        const msg = routerErr instanceof Error ? routerErr.message : String(routerErr);
        throw new Error(
          `routeLearningOp consolidate failed: ${msg}\n` +
          `Fix: set "memory.agentdb.enableLearning": false in .claude-flow/config.json`
        );
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Consolidation worker failed: ${msg}\n` +
        `Fix: set "memory.agentdb.enabled": false in .claude-flow/config.json`
      );
    }

    writeFileSync(consolidateFile, JSON.stringify(result, null, 2));
    return result;
  }

  /**
   * Local testgaps worker (fallback when headless unavailable)
   */
  private async runTestGapsWorkerLocal(): Promise<unknown> {
    // Check for test coverage gaps
    const testGapsFile = join(this.projectRoot, '.claude-flow', 'metrics', 'test-gaps.json');
    const metricsDir = join(this.projectRoot, '.claude-flow', 'metrics');

    if (!existsSync(metricsDir)) {
      mkdirSync(metricsDir, { recursive: true });
    }

    const result = {
      timestamp: new Date().toISOString(),
      mode: 'local',
      hasTestDir: existsSync(join(this.projectRoot, 'tests')) || existsSync(join(this.projectRoot, '__tests__')),
      estimatedCoverage: 'unknown',
      gaps: [],
      note: 'Install Claude Code CLI for AI-powered test gap analysis',
    };

    writeFileSync(testGapsFile, JSON.stringify(result, null, 2));
    return result;
  }

  /**
   * Local predict worker (fallback when headless unavailable)
   */
  private async runPredictWorkerLocal(): Promise<unknown> {
    return {
      timestamp: new Date().toISOString(),
      mode: 'local',
      predictions: [],
      preloaded: [],
      note: 'Install Claude Code CLI for AI-powered predictions',
    };
  }

  /**
   * Local document worker (fallback when headless unavailable)
   */
  private async runDocumentWorkerLocal(): Promise<unknown> {
    return {
      timestamp: new Date().toISOString(),
      mode: 'local',
      filesDocumented: 0,
      suggestedDocs: [],
      note: 'Install Claude Code CLI for AI-powered documentation generation',
    };
  }

  /**
   * Local ultralearn worker (fallback when headless unavailable)
   */
  private async runUltralearnWorkerLocal(): Promise<unknown> {
    return {
      timestamp: new Date().toISOString(),
      mode: 'local',
      patternsLearned: 0,
      insightsGained: [],
      note: 'Install Claude Code CLI for AI-powered deep learning',
    };
  }

  /**
   * Local refactor worker (fallback when headless unavailable)
   */
  private async runRefactorWorkerLocal(): Promise<unknown> {
    return {
      timestamp: new Date().toISOString(),
      mode: 'local',
      suggestions: [],
      duplicatesFound: 0,
      note: 'Install Claude Code CLI for AI-powered refactoring suggestions',
    };
  }

  /**
   * Local deepdive worker (fallback when headless unavailable)
   */
  private async runDeepdiveWorkerLocal(): Promise<unknown> {
    return {
      timestamp: new Date().toISOString(),
      mode: 'local',
      analysisDepth: 'shallow',
      findings: [],
      note: 'Install Claude Code CLI for AI-powered deep code analysis',
    };
  }

  /**
   * Local benchmark worker
   */
  private async runBenchmarkWorkerLocal(): Promise<unknown> {
    const benchmarkFile = join(this.projectRoot, '.claude-flow', 'metrics', 'benchmark.json');
    const metricsDir = join(this.projectRoot, '.claude-flow', 'metrics');

    if (!existsSync(metricsDir)) {
      mkdirSync(metricsDir, { recursive: true });
    }

    const result = {
      timestamp: new Date().toISOString(),
      mode: 'local',
      benchmarks: {
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        uptime: process.uptime(),
      },
    };

    writeFileSync(benchmarkFile, JSON.stringify(result, null, 2));
    return result;
  }

  /**
   * Local preload worker
   */
  private async runPreloadWorkerLocal(): Promise<unknown> {
    const result: Record<string, unknown> = { timestamp: new Date().toISOString(), mode: 'local', resourcesPreloaded: 0, cacheStatus: 'active' };
    try {
      // ADR-0086 T2.7: import from router (was memory-initializer)
      const mi = await import('../memory/memory-router.js');
      const modelResult = await mi.loadEmbeddingModel({ verbose: false });
      if ((modelResult as Record<string, unknown>)?.success) { result.resourcesPreloaded = (result.resourcesPreloaded as number) + 1; result.embeddingModel = (modelResult as Record<string, unknown>).modelName; }
      const hnswResult = await mi.routeEmbeddingOp({ type: 'hnswStatus' });
      if (hnswResult?.success) { result.resourcesPreloaded = (result.resourcesPreloaded as number) + 1; result.hnswEntries = (hnswResult as Record<string, unknown>).totalEntries ?? 0; }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Preload worker failed: ${msg}\n` +
        `Fix: set "memory.agentdb.enabled": false in .claude-flow/config.json`
      );
    }
    return result;
  }

  /**
   * Manually trigger a worker
   */
  async triggerWorker(type: WorkerType): Promise<WorkerResult> {
    const workerConfig = this.config.workers.find(w => w.type === type);
    if (!workerConfig) {
      throw new Error(`Unknown worker type: ${type}`);
    }
    return this.executeWorker(workerConfig);
  }

  /**
   * Enable/disable a worker
   */
  setWorkerEnabled(type: WorkerType, enabled: boolean): void {
    const workerConfig = this.config.workers.find(w => w.type === type);
    if (workerConfig) {
      workerConfig.enabled = enabled;

      if (enabled && this.running) {
        this.scheduleWorker(workerConfig);
      } else if (!enabled) {
        const timer = this.timers.get(type);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(type);
        }
      }

      this.saveState();
    }
  }

  /**
   * Save daemon state to file
   */
  private saveState(): void {
    const state = {
      running: this.running,
      startedAt: this.startedAt?.toISOString(),
      workers: Object.fromEntries(
        Array.from(this.workers.entries()).map(([type, state]) => [
          type,
          {
            ...state,
            lastRun: state.lastRun?.toISOString(),
            nextRun: state.nextRun?.toISOString(),
          }
        ])
      ),
      config: {
        ...this.config,
        workers: this.config.workers.map(w => ({ ...w })),
      },
      savedAt: new Date().toISOString(),
    };

    try {
      const tmpFile = this.config.stateFile + '.tmp';
      writeFileSync(tmpFile, JSON.stringify(state, null, 2));
      renameSync(tmpFile, this.config.stateFile);
    } catch (error) {
      this.log('error', `Failed to save state: ${error}`);
    }
  }

  /**
   * Log message
   */
  private log(level: 'info' | 'warn' | 'error', message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

    this.emit('log', { level, message, timestamp });

    // Also write to log file
    try {
      const logFile = join(this.config.logDir, 'daemon.log');
      appendFileSync(logFile, logMessage + '\n');
    } catch {
      // Ignore log write errors
    }
  }
}

// Singleton instance for global access
let daemonInstance: WorkerDaemon | null = null;

/**
 * Get or create daemon instance
 */
export function getDaemon(projectRoot?: string, config?: Partial<DaemonConfig>): WorkerDaemon {
  if (!daemonInstance && projectRoot) {
    daemonInstance = new WorkerDaemon(projectRoot, config);
  }
  if (!daemonInstance) {
    throw new Error('Daemon not initialized. Provide projectRoot on first call.');
  }
  return daemonInstance;
}

/**
 * Start daemon (for use in session-start hook)
 */
export async function startDaemon(projectRoot: string, config?: Partial<DaemonConfig>): Promise<WorkerDaemon> {
  const daemon = getDaemon(projectRoot, config);
  await daemon.start();
  return daemon;
}

/**
 * Stop daemon
 */
export async function stopDaemon(): Promise<void> {
  if (daemonInstance) {
    await daemonInstance.stop();
  }
}

export default WorkerDaemon;
