/**
 * V3 Init System Types
 * Configuration options for initializing Claude Code integration
 */

import os from 'os';
import path from 'path';

/**
 * Components that can be initialized
 */
export interface InitComponents {
  /** Create .claude/settings.json with hooks */
  settings: boolean;
  /** Copy skills to .claude/skills/ */
  skills: boolean;
  /** Copy commands to .claude/commands/ */
  commands: boolean;
  /** Copy agents to .claude/agents/ */
  agents: boolean;
  /** Create helper scripts in .claude/helpers/ */
  helpers: boolean;
  /** Configure statusline */
  statusline: boolean;
  /** Create MCP configuration */
  mcp: boolean;
  /** Create .claude-flow/ directory (V3 runtime) */
  runtime: boolean;
  /** Create CLAUDE.md with swarm guidance */
  claudeMd: boolean;
}

/**
 * Hook configuration options
 * Valid Claude Code hook events (23 total):
 *   PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit,
 *   SessionStart, SessionEnd, Stop, SubagentStart, SubagentStop,
 *   PreCompact, PostCompact, Notification, ConfigChange,
 *   InstructionsLoaded, PermissionRequest, WorktreeCreate, WorktreeRemove,
 *   TeammateIdle, TaskCompleted, Elicitation, ElicitationResult
 */
export interface HooksConfig {
  /** Enable PreToolUse hooks */
  preToolUse: boolean;
  /** Enable PostToolUse hooks */
  postToolUse: boolean;
  /** Enable UserPromptSubmit for routing */
  userPromptSubmit: boolean;
  /** Enable SessionStart hooks */
  sessionStart: boolean;
  /** Enable Stop hooks */
  stop: boolean;
  /** Enable PreCompact hooks (context preservation before compaction) */
  preCompact: boolean;
  /** Enable Notification hooks */
  notification: boolean;
  /** Enable TeammateIdle hooks (agent teams auto-assign) */
  teammateIdle: boolean;
  /** Enable TaskCompleted hooks (agent teams pattern learning) */
  taskCompleted: boolean;
  /** Enable PermissionRequest hooks */
  permissionRequest?: boolean;
  /** Allow hooks to degrade on bridge failure */
  bridgeFallback?: boolean;
  /** Master hooks enable switch (used in config.json generation) */
  enabled?: boolean;
  /** Auto-execute hooks */
  autoExecute?: boolean;
  /** Hook timeout in milliseconds */
  timeout: number;
  /** Continue on hook error */
  continueOnError: boolean;
}

/**
 * Skills configuration
 */
export interface SkillsConfig {
  /** Include core skills (swarm, memory, sparc) */
  core: boolean;
  /** Include AgentDB skills */
  agentdb: boolean;
  /** Include GitHub integration skills */
  github: boolean;
  /** Include Flow Nexus skills */
  flowNexus: boolean;
  /** Include browser automation skills (agent-browser) */
  browser: boolean;
  /** Include V3 implementation skills */
  v3: boolean;
  /** Include dual-mode skills (Claude Code + Codex hybrid) */
  dualMode: boolean;
  /** ADR-0148 C: Include AI-native VCS skill (npx agentic-jujutsu) */
  jujutsu?: boolean;
  /** ADR-0148 C: Include hive-mind-advanced (queen-led collective intelligence per ADR-0140) */
  hiveMind?: boolean;
  /** ADR-0148 C: Include performance-analysis bottleneck workflow */
  performance?: boolean;
  /** ADR-0148 C: Include worker-benchmarks + worker-integration (loop-worker test harnesses) */
  workers?: boolean;
  /** Include all available skills */
  all: boolean;
}

/**
 * Commands configuration
 */
export interface CommandsConfig {
  /** Include core commands */
  core: boolean;
  /** Include analysis commands */
  analysis: boolean;
  /** Include automation commands */
  automation: boolean;
  /** Include github commands */
  github: boolean;
  /** Include hooks commands */
  hooks: boolean;
  /** Include monitoring commands */
  monitoring: boolean;
  /** Include optimization commands */
  optimization: boolean;
  /** Include SPARC commands */
  sparc: boolean;
  /** Include all commands */
  all: boolean;
}

/**
 * Agents configuration
 */
export interface AgentsConfig {
  /** Include core agents (coder, tester, reviewer) */
  core: boolean;
  /** Include consensus agents */
  consensus: boolean;
  /** Include GitHub agents */
  github: boolean;
  /** Include hive-mind agents */
  hiveMind: boolean;
  /** Include SPARC agents */
  sparc: boolean;
  /** Include swarm coordinators */
  swarm: boolean;
  /** Include browser automation agents (agent-browser) */
  browser: boolean;
  /** Include V3-specific agents (security, memory, performance, etc.) */
  v3: boolean;
  /** Include optimization agents */
  optimization: boolean;
  /** Include testing agents */
  testing: boolean;
  /** Include dual-mode agents (Claude Code + Codex hybrid) */
  dualMode: boolean;
  /** Include all agents */
  all: boolean;
}

/**
 * Statusline configuration
 */
export interface StatuslineConfig {
  /** Enable statusline */
  enabled: boolean;
  /** Show V3 progress */
  showProgress: boolean;
  /** Show security status */
  showSecurity: boolean;
  /** Show swarm activity */
  showSwarm: boolean;
  /** Show hooks metrics */
  showHooks: boolean;
  /** Show performance targets */
  showPerformance: boolean;
  /** Refresh interval in milliseconds */
  refreshInterval: number;
}

/**
 * MCP configuration
 */
export interface MCPConfig {
  /** Include claude-flow MCP server */
  claudeFlow: boolean;
  /** Include ruv-swarm MCP server */
  ruvSwarm: boolean;
  /** Include flow-nexus MCP server */
  flowNexus: boolean;
  /** Auto-start MCP server */
  autoStart: boolean;
  /** Server port */
  port: number;
}

/**
 * Runtime configuration (.claude-flow/)
 */
export interface RuntimeConfig {
  /** Swarm topology */
  topology: 'mesh' | 'hierarchical' | 'hierarchical-mesh' | 'adaptive';
  /** Maximum agents */
  maxAgents: number;
  /** Memory backend */
  memoryBackend: 'memory' | 'sqlite' | 'agentdb' | 'hybrid';
  /** Enable HNSW indexing */
  enableHNSW: boolean;
  /** Enable neural learning */
  enableNeural: boolean;
  /** Enable LearningBridge (ADR-049) - connects insights to SONA/ReasoningBank */
  enableLearningBridge?: boolean;
  /** Enable MemoryGraph (ADR-049) - PageRank knowledge graph */
  enableMemoryGraph?: boolean;
  /** Enable AgentMemoryScope (ADR-049) - 3-scope agent memory */
  enableAgentScopes?: boolean;
  /** Swarm coordination strategy */
  coordinationStrategy?: string;
  /** Memory/embedding LRU cache size */
  cacheSize?: number;
  /** SONA access boost amount */
  accessBoostAmount?: number;
  /** Default agent memory scope */
  defaultScope?: string;
  /** Neural model path */
  modelPath?: string;
  /** Swarm auto-scale */
  autoScale?: boolean;
  /** Vector backend for AgentDB */
  vectorBackend?: string;
  /** Enable AgentDB learning */
  enableLearning?: boolean;
  /** AgentDB learning positive threshold */
  learningPositiveThreshold?: number;
  /** AgentDB learning negative threshold */
  learningNegativeThreshold?: number;
  /** AgentDB learning batch size */
  learningBatchSize?: number;
  /** AgentDB learning tick interval (ms) */
  learningTickInterval?: number;
  /** SONA mode */
  sonaMode?: string;
  /** Per-hour confidence decay rate (ADR-0080) */
  confidenceDecayRate?: number;
  /** Confidence boost per access (ADR-0080) */
  accessBoostAmount?: number;
  /** Min trajectories before consolidation (ADR-0080) */
  consolidationThreshold?: number;
  /** PageRank damping factor for memoryGraph (ADR-0080) */
  pageRankDamping?: number;
  /** Bridge init fallback */
  bridgeInitFallback?: boolean;
  /** Enable AgentDB learning (CLI flag) */
  enableAgentdbLearning?: boolean;
  /** AgentDB positive threshold (CLI flag) */
  agentdbPositiveThreshold?: number;
  /** AgentDB negative threshold (CLI flag) */
  agentdbNegativeThreshold?: number;
  /** AgentDB batch size (CLI flag) */
  agentdbBatchSize?: number;
  /** AgentDB tick interval (CLI flag) */
  agentdbTickInterval?: number;
  /** Max HNSW graph nodes (ADR-0030) */
  maxNodes?: number;
  /** ADR-0069: similarity threshold for memory/pattern search */
  similarityThreshold?: number;
  /** Enable Flash Attention (ADR-0030) */
  flashAttention?: boolean;
  /** Max neural models to keep loaded (ADR-0030) */
  maxModels?: number;
  /** CLAUDE.md template variant */
  claudeMdTemplate?: ClaudeMdTemplate;
}

/** Template variants for generated CLAUDE.md files */
export type ClaudeMdTemplate = 'minimal' | 'standard' | 'full' | 'security' | 'performance' | 'solo';

/**
 * Embeddings configuration
 */
export interface EmbeddingsConfig {
  /** Enable embedding subsystem */
  enabled: boolean;
  /** ONNX model ID (ADR-0069: always use full Xenova/ prefix) */
  model: 'Xenova/all-MiniLM-L6-v2' | 'Xenova/all-mpnet-base-v2' | 'Xenova/bge-small-en-v1.5' | 'nomic-ai/nomic-embed-text-v1.5' | string;
  /** Embedding provider (transformers or onnx) */
  provider?: 'transformers' | 'onnx' | string;
  /** Enable hyperbolic (Poincaré ball) embeddings */
  hyperbolic: boolean;
  /** Poincaré ball curvature (negative value, typically -1) */
  curvature: number;
  /** Pre-download model during init */
  predownload: boolean;
  /** LRU cache size (number of embeddings) */
  cacheSize: number;
  /** Enable neural substrate integration */
  neuralSubstrate: boolean;
}

/**
 * Detected platform information
 */
export interface PlatformInfo {
  /** Operating system */
  os: 'windows' | 'darwin' | 'linux';
  /** Architecture */
  arch: 'x64' | 'arm64' | 'arm' | 'ia32';
  /** Node.js version */
  nodeVersion: string;
  /** Shell type */
  shell: 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh';
  /** Home directory */
  homeDir: string;
  /** Config directory (platform-specific) */
  configDir: string;
}

/**
 * Detect current platform
 */
export function detectPlatform(): PlatformInfo {
  const platform = os.platform();
  const arch = os.arch();
  const homeDir = os.homedir();

  let osType: 'windows' | 'darwin' | 'linux';
  let shell: 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh';
  let configDir: string;

  switch (platform) {
    case 'win32':
      osType = 'windows';
      shell = process.env.PSModulePath ? 'powershell' : 'cmd';
      configDir = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
      break;
    case 'darwin':
      osType = 'darwin';
      shell = process.env.SHELL?.includes('zsh') ? 'zsh' : 'bash';
      configDir = path.join(homeDir, 'Library', 'Application Support');
      break;
    default:
      osType = 'linux';
      shell = process.env.SHELL?.includes('zsh') ? 'zsh' : (process.env.SHELL?.includes('bash') ? 'bash' : 'sh');
      configDir = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
  }

  return {
    os: osType,
    arch: arch as PlatformInfo['arch'],
    nodeVersion: process.version,
    shell,
    homeDir,
    configDir,
  };
}

/**
 * Complete init options
 */
export interface InitOptions {
  /** Target directory */
  targetDir: string;
  /** Source base directory for skills/commands/agents (optional) */
  sourceBaseDir?: string;
  /** Force overwrite existing files */
  force: boolean;
  /** Generate full config.json with all ADR-0069 keys */
  full?: boolean;
  /** Run in interactive mode */
  interactive: boolean;
  /** Components to initialize */
  components: InitComponents;
  /** Hooks configuration */
  hooks: HooksConfig;
  /** Skills configuration */
  skills: SkillsConfig;
  /** Commands configuration */
  commands: CommandsConfig;
  /** Agents configuration */
  agents: AgentsConfig;
  /** Statusline configuration */
  statusline: StatuslineConfig;
  /** MCP configuration */
  mcp: MCPConfig;
  /** Runtime configuration */
  runtime: RuntimeConfig;
  /** Embeddings configuration */
  embeddings: EmbeddingsConfig;
}

/**
 * Default init options - full V3 setup
 */
export const DEFAULT_INIT_OPTIONS: InitOptions = {
  targetDir: process.cwd(), // adr-0100-allow: tracked in ADR-0118 hive-mind-runtime-gaps-tracker
  force: false,
  interactive: true,
  components: {
    settings: true,
    skills: true,
    commands: true,
    agents: true,
    helpers: true,
    statusline: true,
    mcp: true,
    runtime: true,
    claudeMd: true,
  },
  hooks: {
    preToolUse: true,
    postToolUse: true,
    userPromptSubmit: true,
    sessionStart: true,
    stop: true,
    preCompact: true,
    notification: true,
    teammateIdle: true,
    taskCompleted: true,
    timeout: 5000,
    continueOnError: true,
  },
  skills: {
    core: true,
    agentdb: true,
    github: true,
    flowNexus: false,
    browser: true,
    v3: true,
    dualMode: false,  // Optional: enable with --dual flag
    all: false,
  },
  commands: {
    core: true,
    analysis: true,
    automation: true,
    github: true,
    hooks: true,
    monitoring: true,
    optimization: true,
    sparc: true,
    all: false,
  },
  agents: {
    core: true,
    consensus: true,
    github: true,
    hiveMind: true,
    sparc: true,
    swarm: true,
    browser: true,
    v3: true,
    optimization: true,
    testing: true,
    dualMode: false,  // Optional: enable with --dual flag
    all: true,
  },
  statusline: {
    enabled: true,
    showProgress: true,
    showSecurity: true,
    showSwarm: true,
    showHooks: true,
    showPerformance: true,
    refreshInterval: 5000,
  },
  mcp: {
    claudeFlow: true,
    ruvSwarm: false,
    flowNexus: false,
    autoStart: true,
    port: parseInt(process.env.MCP_PORT || '', 10) || 3000, // ADR-0069 A6: config-chain ports
  },
  runtime: {
    topology: 'hierarchical-mesh',
    maxAgents: 15,
    memoryBackend: 'hybrid',
    enableHNSW: true,
    enableNeural: true,
    enableLearningBridge: true,
    enableMemoryGraph: true,
    enableAgentScopes: true,
    similarityThreshold: 0.7,
  },
  embeddings: {
    enabled: true,
    model: 'Xenova/all-mpnet-base-v2', // ADR-0069 A12: canonical model
    hyperbolic: true,
    curvature: -1.0,
    predownload: false,  // Don't auto-download to speed up init
    cacheSize: 256,
    neuralSubstrate: true,
  },
};

/**
 * Minimal init options
 */
export const MINIMAL_INIT_OPTIONS: InitOptions = {
  ...DEFAULT_INIT_OPTIONS,
  components: {
    settings: true,
    skills: true,
    commands: false,
    agents: false,
    helpers: false,
    statusline: false,
    mcp: true,
    runtime: true,
    claudeMd: true,
  },
  hooks: {
    ...DEFAULT_INIT_OPTIONS.hooks,
    userPromptSubmit: false,
    stop: false,
    notification: false,
    teammateIdle: false,
    taskCompleted: false,
  },
  // SG-001: statusline file not generated (components.statusline: false)
  // so disable the feature flag to prevent dangling settings.json references
  statusline: {
    ...DEFAULT_INIT_OPTIONS.statusline,
    enabled: false,
  },
  skills: {
    core: true,
    agentdb: false,
    github: false,
    flowNexus: false,
    browser: false,
    v3: false,
    dualMode: false,
    all: false,
  },
  agents: {
    core: true,
    consensus: false,
    github: false,
    hiveMind: false,
    sparc: false,
    swarm: false,
    browser: false,
    v3: false,
    optimization: false,
    testing: false,
    dualMode: false,
    all: false,
  },
  runtime: {
    topology: 'mesh',
    maxAgents: 5,
    memoryBackend: 'memory',
    enableHNSW: false,
    enableNeural: false,
    enableLearningBridge: false,
    enableMemoryGraph: false,
    enableAgentScopes: false,
    similarityThreshold: 0.7,
  },
  embeddings: {
    enabled: false,
    model: 'Xenova/all-mpnet-base-v2', // ADR-0069 A12: canonical model
    hyperbolic: false,
    curvature: -1.0,
    predownload: false,
    cacheSize: 128,
    neuralSubstrate: false,
  },
};

/**
 * Full init options (everything enabled)
 */
export const FULL_INIT_OPTIONS: InitOptions = {
  ...DEFAULT_INIT_OPTIONS,
  full: true,
  components: {
    settings: true,
    skills: true,
    commands: true,
    agents: true,
    helpers: true,
    statusline: true,
    mcp: true,
    runtime: true,
    claudeMd: true,
  },
  skills: {
    core: true,
    agentdb: true,
    github: true,
    flowNexus: true,
    browser: true,
    v3: true,
    dualMode: true,  // Include in full init
    all: true,
  },
  commands: {
    ...DEFAULT_INIT_OPTIONS.commands,
    all: true,
  },
  agents: {
    ...DEFAULT_INIT_OPTIONS.agents,
    all: true,
  },
  mcp: {
    claudeFlow: true,
    ruvSwarm: true,
    flowNexus: true,
    autoStart: true,
    port: parseInt(process.env.MCP_PORT || '', 10) || 3000, // ADR-0069 A6: config-chain ports
  },
  runtime: {
    ...DEFAULT_INIT_OPTIONS.runtime,
    cacheSize: 256,
    sonaMode: 'balanced',
    maxNodes: 10000,
    similarityThreshold: 0.7,
    learningBatchSize: 64,
    learningTickInterval: 10000,
    flashAttention: true,
    maxModels: 5,
  },
  embeddings: {
    enabled: true,
    model: 'Xenova/all-mpnet-base-v2',
    hyperbolic: true,
    curvature: -1.0,
    predownload: true,  // Pre-download for full init
    cacheSize: 256,
    neuralSubstrate: true,
  },
};

/**
 * Init result
 */
export interface InitResult {
  success: boolean;
  platform: PlatformInfo;
  created: {
    directories: string[];
    files: string[];
  };
  skipped: string[];
  errors: string[];
  summary: {
    skillsCount: number;
    commandsCount: number;
    agentsCount: number;
    hooksEnabled: number;
  };
}
