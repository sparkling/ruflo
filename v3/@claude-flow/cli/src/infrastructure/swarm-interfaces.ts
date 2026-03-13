/**
 * Minimal swarm type interfaces for CLI in-memory repositories.
 * 
 * These are the subset of swarm domain types that the CLI actually uses.
 * Replaces the 833-line copy of swarm entity files (SG-004 v2).
 * If swarm adds new fields, only add them here when CLI needs them.
 */

// ── Enums ────────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'busy' | 'offline' | 'error' | 'terminated';
export type AgentRole = 'coordinator' | 'worker' | 'specialist' | 'monitor';
export type TaskStatus = 'pending' | 'assigned' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

// ── Entity interfaces ────────────────────────────────────────────

export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;
  role: AgentRole;
  domain: string;
  completedTaskCount: number;
  getUtilization(): number;
}

export interface Task {
  id: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedTo?: string;
  createdAt: Date;
  completedAt?: Date;
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
  totalCompletedTasks: number;
}

export interface IAgentRepository {
  save(agent: Agent): Promise<void>;
  findById(id: string): Promise<Agent | null>;
  findByName(name: string): Promise<Agent | null>;
  saveMany(agents: Agent[]): Promise<void>;
  findByIds(ids: string[]): Promise<Agent[]>;
  findAll(options?: AgentQueryOptions): Promise<Agent[]>;
  findByStatus(status: AgentStatus): Promise<Agent[]>;
  findByRole(role: AgentRole): Promise<Agent[]>;
  count(): Promise<number>;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  getStatistics(): Promise<AgentStatistics>;
}

export interface TaskQueryOptions {
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedTo?: string;
  limit?: number;
  offset?: number;
}

export interface TaskStatistics {
  total: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  completionRate: number;
  averageCompletionTime: number;
  failedCount: number;
}

export interface ITaskRepository {
  save(task: Task): Promise<void>;
  findById(id: string): Promise<Task | null>;
  saveMany(tasks: Task[]): Promise<void>;
  findByIds(ids: string[]): Promise<Task[]>;
  findAll(options?: TaskQueryOptions): Promise<Task[]>;
  findByStatus(status: TaskStatus): Promise<Task[]>;
  findByAssignee(agentId: string): Promise<Task[]>;
  count(): Promise<number>;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  getStatistics(): Promise<TaskStatistics>;
}
