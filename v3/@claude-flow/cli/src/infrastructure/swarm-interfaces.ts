/**
 * Minimal swarm type interfaces for CLI in-memory repositories.
 *
 * These are the subset of swarm domain types that the CLI actually uses.
 * Replaces the 833-line copy of swarm entity files (SG-004 v2).
 * If swarm adds new fields, only add them here when CLI needs them.
 */

// ── Enums ────────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'active' | 'busy' | 'paused' | 'terminated' | 'error';
export type AgentRole = 'coordinator' | 'worker' | 'specialist' | 'monitor';
export type TaskStatus = 'pending' | 'queued' | 'assigned' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

// ── Entity interfaces ────────────────────────────────────────────

export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;
  role: AgentRole;
  domain: string;
  parentId?: string;
  completedTaskCount: number;
  getUtilization(): number;
  hasCapability(capability: string): boolean;
  isAvailable(): boolean;
}

export interface Task {
  id: string;
  type: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgentId?: string;
  retryCount: number;
  createdAt: Date;
  completedAt?: Date;
  isTimedOut(): boolean;
  comparePriority(other: Task): number;
  getExecutionDuration(): number | null;
}

// ── Repository interfaces ────────────────────────────────────────

export interface AgentQueryOptions {
  status?: AgentStatus;
  role?: AgentRole;
  domain?: string;
  limit?: number;
  offset?: number;
}

export interface AgentStatistics {
  total: number;
  byStatus: Record<string, number>;
  byRole: Record<string, number>;
  byDomain: Record<string, number>;
  averageUtilization: number;
  totalTasksCompleted: number;
}

export interface IAgentRepository {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  clear(): Promise<void>;
  save(agent: Agent): Promise<void>;
  findById(id: string): Promise<Agent | null>;
  findByName(name: string): Promise<Agent | null>;
  delete(id: string): Promise<boolean>;
  exists(id: string): Promise<boolean>;
  saveMany(agents: Agent[]): Promise<void>;
  findByIds(ids: string[]): Promise<Agent[]>;
  deleteMany(ids: string[]): Promise<number>;
  findAll(options?: AgentQueryOptions): Promise<Agent[]>;
  findByStatus(status: AgentStatus): Promise<Agent[]>;
  findByRole(role: AgentRole): Promise<Agent[]>;
  findByDomain(domain: string): Promise<Agent[]>;
  findByParent(parentId: string): Promise<Agent[]>;
  findByCapability(capability: string): Promise<Agent[]>;
  findAvailable(): Promise<Agent[]>;
  getStatistics(): Promise<AgentStatistics>;
  count(options?: AgentQueryOptions): Promise<number>;
}

export interface TaskQueryOptions {
  status?: TaskStatus;
  priority?: TaskPriority;
  type?: string;
  assignedAgentId?: string;
  limit?: number;
  offset?: number;
}

export interface TaskStatistics {
  total: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  byType: Record<string, number>;
  averageExecutionTime: number;
  successRate: number;
  retryRate: number;
}

export interface ITaskRepository {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  clear(): Promise<void>;
  save(task: Task): Promise<void>;
  findById(id: string): Promise<Task | null>;
  delete(id: string): Promise<boolean>;
  exists(id: string): Promise<boolean>;
  saveMany(tasks: Task[]): Promise<void>;
  findByIds(ids: string[]): Promise<Task[]>;
  deleteMany(ids: string[]): Promise<number>;
  findAll(options?: TaskQueryOptions): Promise<Task[]>;
  findByStatus(status: TaskStatus): Promise<Task[]>;
  findByPriority(priority: TaskPriority): Promise<Task[]>;
  findByAgent(agentId: string): Promise<Task[]>;
  findPending(): Promise<Task[]>;
  findQueued(): Promise<Task[]>;
  findRunning(): Promise<Task[]>;
  findTimedOut(): Promise<Task[]>;
  getNextTask(agentCapabilities?: string[]): Promise<Task | null>;
  getTaskQueue(limit?: number): Promise<Task[]>;
  getStatistics(): Promise<TaskStatistics>;
  count(options?: TaskQueryOptions): Promise<number>;
}
