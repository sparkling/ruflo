/**
 * GitHub MCP Tools for CLI
 *
 * V2 Compatibility - GitHub integration tools
 *
 * ⚠️ IMPORTANT: These tools provide LOCAL STATE MANAGEMENT only.
 * - NO actual GitHub API calls are made
 * - Data is stored locally for workflow coordination
 * - For real GitHub operations, use `gh` CLI or GitHub MCP server
 */

import { type MCPTool, getProjectCwd } from './types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Storage paths
const STORAGE_DIR = '.claude-flow';
const GITHUB_DIR = 'github';
const GITHUB_FILE = 'store.json';

interface RepoInfo {
  owner: string;
  name: string;
  branch: string;
  lastAnalyzed?: string;
  metrics?: {
    commits: number;
    branches: number;
    contributors: number;
    openIssues: number;
    openPRs: number;
  };
}

interface GitHubStore {
  repos: Record<string, RepoInfo>;
  prs: Record<string, { id: string; title: string; status: string; branch: string; createdAt: string }>;
  issues: Record<string, { id: string; title: string; status: string; labels: string[]; createdAt: string }>;
  version: string;
}

function getGitHubDir(): string {
  return join(getProjectCwd(), STORAGE_DIR, GITHUB_DIR);
}

function getGitHubPath(): string {
  return join(getGitHubDir(), GITHUB_FILE);
}

function ensureGitHubDir(): void {
  const dir = getGitHubDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadGitHubStore(): GitHubStore {
  try {
    const path = getGitHubPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    // Return empty store
  }
  return { repos: {}, prs: {}, issues: {}, version: '3.0.0' };
}

function saveGitHubStore(store: GitHubStore): void {
  ensureGitHubDir();
  writeFileSync(getGitHubPath(), JSON.stringify(store, null, 2), 'utf-8');
}

export const githubTools: MCPTool[] = [
  {
    name: 'github_repo_analyze',
    description: 'Analyze a GitHub repository',
    category: 'github',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        branch: { type: 'string', description: 'Branch to analyze' },
        deep: { type: 'boolean', description: 'Deep analysis' },
      },
    },
    handler: async (input) => {
      const store = loadGitHubStore();
      const owner = (input.owner as string) || 'owner';
      const repo = (input.repo as string) || 'repo';
      const branch = (input.branch as string) || 'main';
      const repoKey = `${owner}/${repo}`;

      const repoInfo: RepoInfo = {
        owner,
        name: repo,
        branch,
        lastAnalyzed: new Date().toISOString(),
      };

      store.repos[repoKey] = repoInfo;
      saveGitHubStore(store);

      return {
        success: false,
        _stub: true,
        message: 'GitHub tools are local-only stubs. For real GitHub operations, use the gh CLI or GitHub MCP server directly.',
        localData: {
          repository: repoKey,
          branch,
          lastAnalyzed: repoInfo.lastAnalyzed,
          storedRepos: Object.keys(store.repos),
        },
      };
    },
  },
  {
    name: 'github_pr_manage',
    description: 'Manage pull requests',
    category: 'github',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'review', 'merge', 'close'], description: 'Action to perform' },
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        prNumber: { type: 'number', description: 'PR number' },
        title: { type: 'string', description: 'PR title' },
        branch: { type: 'string', description: 'Source branch' },
        baseBranch: { type: 'string', description: 'Target branch' },
        body: { type: 'string', description: 'PR description' },
      },
    },
    handler: async (input) => {
      const store = loadGitHubStore();
      const action = (input.action as string) || 'list';
      const owner = (input.owner as string) || 'owner';
      const repo = (input.repo as string) || 'repo';

      if (action === 'list') {
        const prs = Object.values(store.prs);
        return {
          success: true,
          pullRequests: prs,
          total: prs.length,
          open: prs.filter(pr => pr.status === 'open').length,
        };
      }

      if (action === 'create') {
        const prId = `pr-${Date.now()}`;
        const pr = {
          id: prId,
          title: (input.title as string) || 'New PR',
          status: 'open',
          branch: (input.branch as string) || 'feature',
          baseBranch: (input.baseBranch as string) || 'main',
          createdAt: new Date().toISOString(),
        };
        store.prs[prId] = pr;
        saveGitHubStore(store);

        return {
          success: true,
          action: 'created',
          pullRequest: pr,
          url: `https://github.com/${owner}/${repo}/pull/${prId}`,
        };
      }

      if (action === 'review') {
        return {
          success: false,
          _stub: true,
          message: 'GitHub tools are local-only stubs. PR review requires actual GitHub API access. Use the gh CLI or GitHub MCP server directly.',
          localData: {
            prNumber: input.prNumber,
          },
        };
      }

      if (action === 'merge') {
        const prNumber = input.prNumber as number;
        const prKey = Object.keys(store.prs).find(k => k.includes(String(prNumber)));
        if (prKey && store.prs[prKey]) {
          store.prs[prKey].status = 'merged';
          saveGitHubStore(store);
        }

        return {
          success: true,
          action: 'merged',
          prNumber,
          mergedAt: new Date().toISOString(),
        };
      }

      if (action === 'close') {
        const prNumber = input.prNumber as number;
        const prKey = Object.keys(store.prs).find(k => k.includes(String(prNumber)));
        if (prKey && store.prs[prKey]) {
          store.prs[prKey].status = 'closed';
          saveGitHubStore(store);
        }

        return {
          success: true,
          action: 'closed',
          prNumber,
          closedAt: new Date().toISOString(),
        };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
  {
    name: 'github_issue_track',
    description: 'Track and manage issues',
    category: 'github',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'close', 'assign'], description: 'Action to perform' },
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        issueNumber: { type: 'number', description: 'Issue number' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Issue labels' },
        assignees: { type: 'array', items: { type: 'string' }, description: 'Assignees' },
      },
    },
    handler: async (input) => {
      const store = loadGitHubStore();
      const action = (input.action as string) || 'list';

      if (action === 'list') {
        const issues = Object.values(store.issues);
        return {
          success: true,
          issues,
          total: issues.length,
          open: issues.filter(i => i.status === 'open').length,
        };
      }

      if (action === 'create') {
        const issueId = `issue-${Date.now()}`;
        const issue = {
          id: issueId,
          title: (input.title as string) || 'New Issue',
          status: 'open',
          labels: (input.labels as string[]) || [],
          createdAt: new Date().toISOString(),
        };
        store.issues[issueId] = issue;
        saveGitHubStore(store);

        return {
          success: true,
          action: 'created',
          issue,
        };
      }

      if (action === 'update') {
        const issueNumber = input.issueNumber as number;
        const issueKey = Object.keys(store.issues).find(k => k.includes(String(issueNumber)));
        if (issueKey && store.issues[issueKey]) {
          if (input.title) store.issues[issueKey].title = input.title as string;
          if (input.labels) store.issues[issueKey].labels = input.labels as string[];
          saveGitHubStore(store);
        }

        return {
          success: true,
          action: 'updated',
          issueNumber,
        };
      }

      if (action === 'close') {
        const issueNumber = input.issueNumber as number;
        const issueKey = Object.keys(store.issues).find(k => k.includes(String(issueNumber)));
        if (issueKey && store.issues[issueKey]) {
          store.issues[issueKey].status = 'closed';
          saveGitHubStore(store);
        }

        return {
          success: true,
          action: 'closed',
          issueNumber,
          closedAt: new Date().toISOString(),
        };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
  {
    name: 'github_workflow',
    description: 'Manage GitHub Actions workflows',
    category: 'github',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'trigger', 'status', 'cancel'], description: 'Action to perform' },
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        workflowId: { type: 'string', description: 'Workflow ID or name' },
        ref: { type: 'string', description: 'Branch or tag ref' },
      },
    },
    handler: async (input) => {
      const action = (input.action as string) || 'list';

      return {
        success: false,
        _stub: true,
        message: 'GitHub tools are local-only stubs. Workflow operations require actual GitHub API access. Use the gh CLI or GitHub MCP server directly.',
        localData: {
          requestedAction: action,
          workflowId: input.workflowId || null,
          ref: input.ref || null,
        },
      };
    },
  },
  {
    name: 'github_metrics',
    description: 'Get repository metrics and statistics',
    category: 'github',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        metric: { type: 'string', enum: ['all', 'commits', 'contributors', 'traffic', 'releases'], description: 'Metric type' },
        timeRange: { type: 'string', description: 'Time range' },
      },
    },
    handler: async (input) => {
      const store = loadGitHubStore();

      return {
        success: false,
        _stub: true,
        message: 'GitHub tools are local-only stubs. Repository metrics require actual GitHub API access. Use the gh CLI or GitHub MCP server directly.',
        localData: {
          owner: (input.owner as string) || 'owner',
          repo: (input.repo as string) || 'repo',
          requestedMetric: (input.metric as string) || 'all',
          storedRepos: Object.keys(store.repos),
          localIssueCount: Object.keys(store.issues).length,
          localPrCount: Object.keys(store.prs).length,
        },
      };
    },
  },
];
