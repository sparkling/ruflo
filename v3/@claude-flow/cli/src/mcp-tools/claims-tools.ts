/**
 * Claims MCP Tools for CLI
 *
 * Implements MCP tools for ADR-016: Collaborative Issue Claims
 * Provides programmatic access to claim operations for MCP clients.
 *
 * ADR-0181 Phase 5 (F4-3 cli delegation): the 8 mutating claims_* tools
 * (claims_claim, claims_release, claims_handoff, claims_accept-handoff,
 * claims_status, claims_mark-stealable, claims_steal, claims_rebalance)
 * dispatch through `archivist.dispatch()` for the authoritative
 * `.claude-flow/claims/claims.json` mutation. The substrate's `withWrite`
 * subsumes the prior `withClaimsLock` (POSIX O_EXCL lockfile) so cross-process
 * mutual exclusion comes from the substrate seam rather than the cli. The
 * post-dispatch `loadClaims()` re-read composes the cli envelope from
 * authoritative persisted state.
 *
 * Read-only tools (claims_list, claims_stealable, claims_load, claims_board)
 * have no archivist read-handler counterpart yet — they stay on the cli's
 * direct `loadClaims()` path per the team-lead consolidated ruling. See the
 * Phase 6+ comment on each read handler.
 *
 * Path alignment: substrate-registry.ts entry
 * `['claims', 'claims/claims.json']` keeps the substrate's resolved path in
 * sync with this file's `.claude-flow/claims/claims.json` layout, so the
 * 4 cli-native read tools observe the substrate's writes immediately.
 *
 * @module @claude-flow/cli/mcp-tools/claims
 */

import type { MCPTool } from './types.js';
import { validateIdentifier, validateText } from './validate-input.js';
import { getProcessArchivist } from '../memory/archivist-init.js';

// Inline claim service since we can't import external modules
interface Claimant {
  type: 'human' | 'agent';
  userId?: string;
  name?: string;
  agentId?: string;
  agentType?: string;
}

type ClaimStatus = 'active' | 'paused' | 'handoff-pending' | 'review-requested' | 'blocked' | 'stealable' | 'completed';
type StealReason = 'overloaded' | 'stale' | 'blocked-timeout' | 'voluntary';

interface IssueClaim {
  issueId: string;
  claimant: Claimant;
  claimedAt: string;
  status: ClaimStatus;
  statusChangedAt: string;
  expiresAt?: string;
  handoffTo?: Claimant;
  handoffReason?: string;
  blockReason?: string;
  progress: number;
  context?: string;
}

interface ClaimsStore {
  claims: Record<string, IssueClaim>;
  stealable: Record<string, { reason: StealReason; stealableAt: string; preferredTypes?: string[]; progress: number; context?: string }>;
  contests: Record<string, { originalClaimant: Claimant; contestedAt: string; reason: string }>;
}

// File-based persistence (read-side for cli envelope + the 4 read-only tools)
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const CLAIMS_DIR = '.claude-flow/claims';
const CLAIMS_FILE = 'claims.json';

function getClaimsPath(): string {
  return resolve(join(CLAIMS_DIR, CLAIMS_FILE));
}

function loadClaims(): ClaimsStore {
  try {
    const path = getClaimsPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    // Return empty store on error
  }
  return { claims: {}, stealable: {}, contests: {} };
}

function formatClaimant(claimant: Claimant): string {
  return claimant.type === 'human'
    ? `human:${claimant.userId}:${claimant.name}`
    : `agent:${claimant.agentId}:${claimant.agentType}`;
}

function parseClaimant(str: string): Claimant | null {
  const parts = str.split(':');
  if (parts[0] === 'human' && parts.length >= 3) {
    return { type: 'human', userId: parts[1], name: parts.slice(2).join(':') };
  } else if (parts[0] === 'agent' && parts.length >= 3) {
    return { type: 'agent', agentId: parts[1], agentType: parts[2] };
  }
  return null;
}

export const claimsTools: MCPTool[] = [
  {
    name: 'claims_claim',
    description: 'Claim an issue for work (human or agent)',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID or GitHub issue number',
        },
        claimant: {
          type: 'string',
          description: 'Claimant identifier (e.g., "human:user-1:Alice" or "agent:coder-1:coder")',
        },
        context: {
          type: 'string',
          description: 'Optional context about the work approach',
        },
      },
      required: ['issueId', 'claimant'],
    },
    handler: async (input) => {
      // Input validation (ADR-0094 P11/P12): typeof guard + named error + structural hint
      if (input.issueId === undefined || input.issueId === null) {
        return { success: false, error: "'issueId' is required and must be a string" };
      }
      if (typeof input.issueId !== 'string') {
        return { success: false, error: "'issueId' must be a string (got " + (Array.isArray(input.issueId) ? 'array' : typeof input.issueId) + "); expected a non-empty string identifier" };
      }
      if (input.issueId.length === 0) {
        return { success: false, error: "'issueId' is required and must be a non-empty string" };
      }
      if (input.claimant === undefined || input.claimant === null) {
        return { success: false, error: "'claimant' is required and must be a string (format: human:userId:name or agent:agentId:type)" };
      }
      if (typeof input.claimant !== 'string') {
        return { success: false, error: "'claimant' must be a string (got " + (Array.isArray(input.claimant) ? 'array' : typeof input.claimant) + "); expected format: human:userId:name or agent:agentId:type" };
      }
      if (input.context !== undefined && input.context !== null && typeof input.context !== 'string') {
        return { success: false, error: "'context' must be a string if provided (got " + (Array.isArray(input.context) ? 'array' : typeof input.context) + "); expected an optional free-form string" };
      }

      const issueId = input.issueId as string;
      const claimantStr = input.claimant as string;
      const context = input.context as string | undefined;

      { const v = validateIdentifier(issueId, 'issueId'); if (!v.valid) return { success: false, error: v.error }; }
      { const v = validateText(claimantStr, 'claimant'); if (!v.valid) return { success: false, error: v.error }; }
      if (context) { const v = validateText(context, 'context'); if (!v.valid) return { success: false, error: v.error }; }

      const claimant = parseClaimant(claimantStr);
      if (!claimant) {
        return { success: false, error: 'Invalid claimant format. Use "human:userId:name" or "agent:agentId:agentType"' };
      }

      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `forks/agentdb/src/archivist/handlers/claims/claim.ts` owns the
      // load → check-not-claimed → mutate → save under substrate.withWrite
      // (which subsumes the prior `withClaimsLock` O_EXCL lockfile for
      // cross-process mutual exclusion — ADR-0094 P9). The handler throws on
      // "already claimed", which we map back to the cli envelope shape.
      try {
        const archivist = await getProcessArchivist();
        await archivist.dispatch('claims_claim', {
          issueId,
          claimant,
          context,
        });
      } catch (err) {
        const msg = (err as { message?: string }).message ?? String(err);
        if (msg.includes('already claimed')) {
          const existing = loadClaims().claims[issueId];
          return {
            success: false,
            error: existing ? `Issue already claimed by ${formatClaimant(existing.claimant)}` : `Issue '${issueId}' already claimed`,
            existingClaim: existing,
          };
        }
        throw err;
      }

      const postStore = loadClaims();
      const claim = postStore.claims[issueId];
      if (!claim) {
        throw new Error(
          `claims_claim: issue '${issueId}' missing from store after successful dispatch — concurrent mutation suspected`,
        );
      }

      return {
        success: true,
        claim,
        message: `Issue ${issueId} claimed by ${formatClaimant(claimant)}`,
      };
    },
  },

  {
    name: 'claims_release',
    description: 'Release a claim on an issue',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID to release',
        },
        claimant: {
          type: 'string',
          description: 'Claimant identifier (must match current owner)',
        },
        reason: {
          type: 'string',
          description: 'Reason for releasing',
        },
      },
      required: ['issueId', 'claimant'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const claimantStr = input.claimant as string;
      const reason = input.reason as string | undefined;

      { const v = validateIdentifier(issueId, 'issueId'); if (!v.valid) return { success: false, error: v.error }; }
      { const v = validateText(claimantStr, 'claimant'); if (!v.valid) return { success: false, error: v.error }; }
      if (reason) { const v = validateText(reason, 'reason'); if (!v.valid) return { success: false, error: v.error }; }

      const claimant = parseClaimant(claimantStr);
      if (!claimant) {
        return { success: false, error: 'Invalid claimant format' };
      }

      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `.../archivist/handlers/claims/release.ts` owns the load → ownership
      // check → delete → save under substrate.withWrite. Pre-read so the cli
      // envelope can return the previousClaim shape the caller depends on, and
      // so the "not claimed" / "wrong claimant" branches preserve their
      // {success:false, error} contract (handler throws on both — we map back).
      const preStore = loadClaims();
      const preClaim = preStore.claims[issueId];

      if (!preClaim) {
        return { success: false, error: 'Issue is not claimed' };
      }
      if (formatClaimant(preClaim.claimant) !== formatClaimant(claimant)) {
        return { success: false, error: 'Only the current claimant can release' };
      }

      const archivist = await getProcessArchivist();
      await archivist.dispatch('claims_release', {
        issueId,
        claimant,
        reason,
      });

      return {
        success: true,
        message: `Issue ${issueId} released`,
        reason,
        previousClaim: preClaim,
      };
    },
  },

  {
    name: 'claims_handoff',
    description: 'Request handoff of an issue to another claimant',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID to handoff',
        },
        from: {
          type: 'string',
          description: 'Current claimant identifier',
        },
        to: {
          type: 'string',
          description: 'Target claimant identifier',
        },
        reason: {
          type: 'string',
          description: 'Reason for handoff',
        },
        progress: {
          type: 'number',
          description: 'Current progress percentage (0-100)',
        },
      },
      required: ['issueId', 'from', 'to'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const fromStr = input.from as string;
      const toStr = input.to as string;
      const reason = input.reason as string | undefined;
      const progress = (input.progress as number) || 0;

      { const v = validateIdentifier(issueId, 'issueId'); if (!v.valid) return { success: false, error: v.error }; }
      { const v = validateText(fromStr, 'from'); if (!v.valid) return { success: false, error: v.error }; }
      { const v = validateText(toStr, 'to'); if (!v.valid) return { success: false, error: v.error }; }
      if (reason) { const v = validateText(reason, 'reason'); if (!v.valid) return { success: false, error: v.error }; }

      const from = parseClaimant(fromStr);
      const to = parseClaimant(toStr);

      if (!from || !to) {
        return { success: false, error: 'Invalid claimant format' };
      }

      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `.../archivist/handlers/claims/handoff.ts` owns the load → ownership
      // check → status='handoff-pending' transition → save under
      // substrate.withWrite. Pre-read mirrors release.ts to preserve the cli
      // {success:false, error} envelope shape for not-claimed / wrong-claimant.
      const preStore = loadClaims();
      const preClaim = preStore.claims[issueId];

      if (!preClaim) {
        return { success: false, error: 'Issue is not claimed' };
      }
      if (formatClaimant(preClaim.claimant) !== formatClaimant(from)) {
        return { success: false, error: 'Only the current claimant can request handoff' };
      }

      const archivist = await getProcessArchivist();
      await archivist.dispatch('claims_handoff', {
        issueId,
        from,
        to,
        reason,
        progress,
      });

      const postStore = loadClaims();
      const claim = postStore.claims[issueId];
      if (!claim) {
        throw new Error(
          `claims_handoff: issue '${issueId}' missing from store after successful dispatch — concurrent mutation suspected`,
        );
      }

      return {
        success: true,
        claim,
        message: `Handoff requested from ${formatClaimant(from)} to ${formatClaimant(to)}`,
      };
    },
  },

  {
    name: 'claims_accept-handoff',
    description: 'Accept a pending handoff',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID with pending handoff',
        },
        claimant: {
          type: 'string',
          description: 'Claimant accepting the handoff',
        },
      },
      required: ['issueId', 'claimant'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const claimantStr = input.claimant as string;

      { const v = validateIdentifier(issueId, 'issueId'); if (!v.valid) return { success: false, error: v.error }; }
      { const v = validateText(claimantStr, 'claimant'); if (!v.valid) return { success: false, error: v.error }; }

      const claimant = parseClaimant(claimantStr);
      if (!claimant) {
        return { success: false, error: 'Invalid claimant format' };
      }

      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `.../archivist/handlers/claims/accept-handoff.ts` owns the load →
      // pending-handoff check → target check → transfer → save under
      // substrate.withWrite. Pre-read preserves both the {success:false,error}
      // envelope branches AND the `previousOwner` field the cli surface emits.
      const preStore = loadClaims();
      const preClaim = preStore.claims[issueId];

      if (!preClaim) {
        return { success: false, error: 'Issue is not claimed' };
      }
      if (preClaim.status !== 'handoff-pending') {
        return { success: false, error: 'No pending handoff for this issue' };
      }
      if (!preClaim.handoffTo || formatClaimant(preClaim.handoffTo) !== formatClaimant(claimant)) {
        return { success: false, error: 'You are not the target of this handoff' };
      }

      const previousOwner = preClaim.claimant;

      const archivist = await getProcessArchivist();
      await archivist.dispatch('claims_accept-handoff', {
        issueId,
        claimant,
      });

      const postStore = loadClaims();
      const claim = postStore.claims[issueId];
      if (!claim) {
        throw new Error(
          `claims_accept-handoff: issue '${issueId}' missing from store after successful dispatch — concurrent mutation suspected`,
        );
      }

      return {
        success: true,
        claim,
        previousOwner,
        message: `Handoff accepted. ${formatClaimant(claimant)} now owns issue ${issueId}`,
      };
    },
  },

  {
    name: 'claims_status',
    description: 'Update claim status',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID',
        },
        status: {
          type: 'string',
          description: 'New status',
          enum: ['active', 'paused', 'blocked', 'review-requested', 'completed'],
        },
        note: {
          type: 'string',
          description: 'Status note or reason',
        },
        progress: {
          type: 'number',
          description: 'Current progress percentage',
        },
      },
      required: ['issueId', 'status'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const status = input.status as ClaimStatus;
      const note = input.note as string | undefined;
      const progress = input.progress as number | undefined;

      { const v = validateIdentifier(issueId, 'issueId'); if (!v.valid) return { success: false, error: v.error }; }
      if (note) { const v = validateText(note, 'note'); if (!v.valid) return { success: false, error: v.error }; }

      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `.../archivist/handlers/claims/status.ts` owns the load → status flip
      // → save under substrate.withWrite. Pre-read so the "not claimed"
      // envelope branch stays {success:false, error} rather than propagating
      // the handler's throw.
      const preStore = loadClaims();
      if (!preStore.claims[issueId]) {
        return { success: false, error: 'Issue is not claimed' };
      }

      const archivist = await getProcessArchivist();
      await archivist.dispatch('claims_status', {
        issueId,
        status,
        note,
        progress,
      });

      const postStore = loadClaims();
      const claim = postStore.claims[issueId];
      if (!claim) {
        throw new Error(
          `claims_status: issue '${issueId}' missing from store after successful dispatch — concurrent mutation suspected`,
        );
      }

      return {
        success: true,
        claim,
        message: `Issue ${issueId} status updated to ${status}`,
      };
    },
  },

  {
    name: 'claims_list',
    description: 'List all claims or filter by criteria',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status',
          enum: ['active', 'paused', 'blocked', 'stealable', 'completed', 'all'],
        },
        claimant: {
          type: 'string',
          description: 'Filter by claimant',
        },
        agentType: {
          type: 'string',
          description: 'Filter by agent type',
        },
      },
    },
    // PHASE 6+: routeRead via archivist when claims_list/stealable/load/board
    // register as registerReadHandler. No archivist read-handler counterpart
    // exists today — staying cli-native per team-lead consolidated ruling.
    handler: async (input) => {
      const status = input.status as string | undefined;
      const claimantFilter = input.claimant as string | undefined;
      const agentType = input.agentType as string | undefined;

      if (claimantFilter) { const v = validateText(claimantFilter, 'claimant'); if (!v.valid) return { success: false, error: v.error }; }
      if (agentType) { const v = validateIdentifier(agentType, 'agentType'); if (!v.valid) return { success: false, error: v.error }; }

      const store = loadClaims();
      let claims = Object.values(store.claims);

      if (status && status !== 'all') {
        claims = claims.filter(c => c.status === status);
      }

      if (claimantFilter) {
        claims = claims.filter(c => formatClaimant(c.claimant).includes(claimantFilter));
      }

      if (agentType) {
        claims = claims.filter(c =>
          c.claimant.type === 'agent' && c.claimant.agentType === agentType
        );
      }

      return {
        success: true,
        claims,
        count: claims.length,
        stealableCount: Object.keys(store.stealable).length,
      };
    },
  },

  {
    name: 'claims_mark-stealable',
    description: 'Mark an issue as stealable by other agents',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID to mark stealable',
        },
        reason: {
          type: 'string',
          description: 'Reason for marking stealable',
          enum: ['overloaded', 'stale', 'blocked-timeout', 'voluntary'],
        },
        preferredTypes: {
          type: 'array',
          description: 'Preferred agent types to steal',
          items: { type: 'string' },
        },
        context: {
          type: 'string',
          description: 'Handoff context for the stealer',
        },
      },
      required: ['issueId', 'reason'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const reason = input.reason as StealReason;
      const preferredTypes = input.preferredTypes as string[] | undefined;
      const context = input.context as string | undefined;

      { const v = validateIdentifier(issueId, 'issueId'); if (!v.valid) return { success: false, error: v.error }; }
      if (context) { const v = validateText(context, 'context'); if (!v.valid) return { success: false, error: v.error }; }

      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `.../archivist/handlers/claims/mark-stealable.ts` owns the load →
      // status='stealable' + stealable[issueId] writes (both atomic in one
      // substrate.withWrite). Pre-read preserves the "not claimed"
      // {success:false, error} envelope branch.
      const preStore = loadClaims();
      if (!preStore.claims[issueId]) {
        return { success: false, error: 'Issue is not claimed' };
      }

      const archivist = await getProcessArchivist();
      await archivist.dispatch('claims_mark-stealable', {
        issueId,
        reason,
        preferredTypes,
        context,
      });

      const postStore = loadClaims();
      const claim = postStore.claims[issueId];
      if (!claim) {
        throw new Error(
          `claims_mark-stealable: issue '${issueId}' missing from store after successful dispatch — concurrent mutation suspected`,
        );
      }

      return {
        success: true,
        claim,
        stealableInfo: postStore.stealable[issueId],
        message: `Issue ${issueId} marked as stealable (${reason})`,
      };
    },
  },

  {
    name: 'claims_steal',
    description: 'Steal a stealable issue',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: {
          type: 'string',
          description: 'Issue ID to steal',
        },
        stealer: {
          type: 'string',
          description: 'Claimant stealing the issue',
        },
      },
      required: ['issueId', 'stealer'],
    },
    handler: async (input) => {
      const issueId = input.issueId as string;
      const stealerStr = input.stealer as string;

      { const v = validateIdentifier(issueId, 'issueId'); if (!v.valid) return { success: false, error: v.error }; }
      { const v = validateText(stealerStr, 'stealer'); if (!v.valid) return { success: false, error: v.error }; }

      const stealer = parseClaimant(stealerStr);
      if (!stealer) {
        return { success: false, error: 'Invalid claimant format' };
      }

      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist. The handler at
      // `.../archivist/handlers/claims/steal.ts` owns the load → claimed +
      // stealable + preferredTypes checks → ownership transfer → save under
      // substrate.withWrite (which gives "exactly one of N parallel steals
      // wins" semantics — ADR-0094 P9). Pre-read preserves three
      // {success:false, error} envelope branches the cli surface emits
      // (not-claimed / not-stealable / preferredTypes mismatch) AND the
      // `previousOwner` + `stealableInfo` fields in the success response.
      const preStore = loadClaims();
      const preClaim = preStore.claims[issueId];
      const stealableInfo = preStore.stealable[issueId];

      if (!preClaim) {
        return { success: false, error: 'Issue is not claimed' };
      }
      if (!stealableInfo) {
        return { success: false, error: 'Issue is not stealable' };
      }
      if (stealableInfo.preferredTypes && stealableInfo.preferredTypes.length > 0) {
        if (stealer.type === 'agent' && !stealableInfo.preferredTypes.includes(stealer.agentType!)) {
          return {
            success: false,
            error: `Issue prefers agent types: ${stealableInfo.preferredTypes.join(', ')}`,
          };
        }
      }

      const previousOwner = preClaim.claimant;

      const archivist = await getProcessArchivist();
      await archivist.dispatch('claims_steal', {
        issueId,
        stealer,
      });

      const postStore = loadClaims();
      const claim = postStore.claims[issueId];
      if (!claim) {
        throw new Error(
          `claims_steal: issue '${issueId}' missing from store after successful dispatch — concurrent mutation suspected`,
        );
      }

      return {
        success: true,
        claim,
        previousOwner,
        stealableInfo,
        message: `Issue ${issueId} stolen by ${formatClaimant(stealer)}`,
      };
    },
  },

  {
    name: 'claims_stealable',
    description: 'List all stealable issues',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        agentType: {
          type: 'string',
          description: 'Filter by preferred agent type',
        },
      },
    },
    // PHASE 6+: routeRead via archivist when claims_list/stealable/load/board
    // register as registerReadHandler. No archivist read-handler counterpart
    // exists today — staying cli-native per team-lead consolidated ruling.
    handler: async (input) => {
      const agentType = input.agentType as string | undefined;

      if (agentType) { const v = validateIdentifier(agentType, 'agentType'); if (!v.valid) return { success: false, error: v.error }; }

      const store = loadClaims();
      let stealableIssues = Object.entries(store.stealable).map(([issueId, info]) => ({
        issueId,
        ...info,
        claim: store.claims[issueId],
      }));

      if (agentType) {
        stealableIssues = stealableIssues.filter(s =>
          !s.preferredTypes || s.preferredTypes.length === 0 || s.preferredTypes.includes(agentType)
        );
      }

      return {
        success: true,
        stealable: stealableIssues,
        count: stealableIssues.length,
      };
    },
  },

  {
    name: 'claims_load',
    description: 'Get agent load information',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Specific agent ID (optional)',
        },
        agentType: {
          type: 'string',
          description: 'Filter by agent type',
        },
      },
    },
    // PHASE 6+: routeRead via archivist when claims_list/stealable/load/board
    // register as registerReadHandler. No archivist read-handler counterpart
    // exists today — staying cli-native per team-lead consolidated ruling.
    handler: async (input) => {
      const agentId = input.agentId as string | undefined;
      const agentType = input.agentType as string | undefined;

      if (agentId) { const v = validateIdentifier(agentId, 'agentId'); if (!v.valid) return { success: false, error: v.error }; }
      if (agentType) { const v = validateIdentifier(agentType, 'agentType'); if (!v.valid) return { success: false, error: v.error }; }

      const store = loadClaims();
      const claims = Object.values(store.claims);

      // Group claims by agent
      const agentLoads = new Map<string, {
        agentId: string;
        agentType: string;
        claims: IssueClaim[];
        blockedCount: number;
      }>();

      for (const claim of claims) {
        if (claim.claimant.type !== 'agent') continue;

        const key = claim.claimant.agentId!;
        if (!agentLoads.has(key)) {
          agentLoads.set(key, {
            agentId: key,
            agentType: claim.claimant.agentType!,
            claims: [],
            blockedCount: 0,
          });
        }

        const load = agentLoads.get(key)!;
        load.claims.push(claim);
        if (claim.status === 'blocked') {
          load.blockedCount++;
        }
      }

      let loads = Array.from(agentLoads.values());

      if (agentId) {
        loads = loads.filter(l => l.agentId === agentId);
      }

      if (agentType) {
        loads = loads.filter(l => l.agentType === agentType);
      }

      const result = loads.map(l => ({
        agentId: l.agentId,
        agentType: l.agentType,
        claimCount: l.claims.length,
        maxClaims: 5, // Default max
        utilization: l.claims.length / 5,
        blockedCount: l.blockedCount,
        claims: l.claims.map(c => ({
          issueId: c.issueId,
          status: c.status,
          progress: c.progress,
        })),
      }));

      return {
        success: true,
        loads: result,
        totalAgents: result.length,
        totalClaims: claims.filter(c => c.claimant.type === 'agent').length,
        avgUtilization: result.length > 0
          ? result.reduce((sum, l) => sum + l.utilization, 0) / result.length
          : 0,
      };
    },
  },

  {
    name: 'claims_board',
    description: 'Get a visual board view of all claims',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    // PHASE 6+: routeRead via archivist when claims_list/stealable/load/board
    // register as registerReadHandler. No archivist read-handler counterpart
    // exists today — staying cli-native per team-lead consolidated ruling.
    handler: async () => {
      const store = loadClaims();
      const claims = Object.values(store.claims);

      const byStatus: Record<string, IssueClaim[]> = {
        active: [],
        paused: [],
        blocked: [],
        'handoff-pending': [],
        'review-requested': [],
        stealable: [],
        completed: [],
      };

      for (const claim of claims) {
        if (byStatus[claim.status]) {
          byStatus[claim.status].push(claim);
        }
      }

      const humanClaims = claims.filter(c => c.claimant.type === 'human');
      const agentClaims = claims.filter(c => c.claimant.type === 'agent');

      return {
        success: true,
        board: {
          active: byStatus.active.map(c => ({ issueId: c.issueId, claimant: formatClaimant(c.claimant), progress: c.progress })),
          paused: byStatus.paused.map(c => ({ issueId: c.issueId, claimant: formatClaimant(c.claimant) })),
          blocked: byStatus.blocked.map(c => ({ issueId: c.issueId, claimant: formatClaimant(c.claimant), reason: c.blockReason })),
          'handoff-pending': byStatus['handoff-pending'].map(c => ({ issueId: c.issueId, from: formatClaimant(c.claimant), to: c.handoffTo ? formatClaimant(c.handoffTo) : null })),
          'review-requested': byStatus['review-requested'].map(c => ({ issueId: c.issueId, claimant: formatClaimant(c.claimant) })),
          stealable: byStatus.stealable.map(c => ({ issueId: c.issueId, claimant: formatClaimant(c.claimant) })),
          completed: byStatus.completed.map(c => ({ issueId: c.issueId, claimant: formatClaimant(c.claimant) })),
        },
        summary: {
          total: claims.length,
          active: byStatus.active.length,
          blocked: byStatus.blocked.length,
          stealable: byStatus.stealable.length,
          humanClaims: humanClaims.length,
          agentClaims: agentClaims.length,
        },
      };
    },
  },

  {
    name: 'claims_rebalance',
    description: 'Suggest or apply load rebalancing across agents',
    category: 'claims',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: {
          type: 'boolean',
          description: 'Preview rebalancing without applying',
          default: true,
        },
        targetUtilization: {
          type: 'number',
          description: 'Target utilization (0-1)',
          default: 0.7,
        },
      },
    },
    handler: async (input) => {
      const dryRun = input.dryRun !== false;
      const targetUtilization = (input.targetUtilization as number) || 0.7;

      // Compute suggestions + metrics at the cli boundary; the archivist
      // handler at `.../archivist/handlers/claims/rebalance.ts` returns void
      // (per Phase 5 mutation-handler contract) and only mutates when
      // dryRun=false. The cli surface keeps the suggestions/metrics return
      // shape so callers can review proposed moves before applying.
      const preStore = loadClaims();
      const claims = Object.values(preStore.claims);

      const agentLoads = new Map<string, { agentId: string; agentType: string; claims: IssueClaim[] }>();

      for (const claim of claims) {
        if (claim.claimant.type !== 'agent') continue;

        const key = claim.claimant.agentId!;
        if (!agentLoads.has(key)) {
          agentLoads.set(key, { agentId: key, agentType: claim.claimant.agentType!, claims: [] });
        }
        agentLoads.get(key)!.claims.push(claim);
      }

      const loads = Array.from(agentLoads.values());
      const maxClaims = 5;
      const avgLoad = loads.length > 0
        ? loads.reduce((sum, l) => sum + l.claims.length, 0) / loads.length
        : 0;

      const overloaded = loads.filter(l => l.claims.length > maxClaims * targetUtilization * 1.5);
      const underloaded = loads.filter(l => l.claims.length < maxClaims * targetUtilization * 0.5);

      const suggestions: Array<{ issueId: string; from: string; to: string; reason: string }> = [];

      for (const over of overloaded) {
        const movable = over.claims
          .filter(c => c.progress < 25 && c.status === 'active')
          .slice(0, over.claims.length - Math.ceil(maxClaims * targetUtilization));

        for (const claim of movable) {
          const target = underloaded.find(u => u.agentType === over.agentType && u.claims.length < maxClaims);
          if (target) {
            suggestions.push({
              issueId: claim.issueId,
              from: `agent:${over.agentId}:${over.agentType}`,
              to: `agent:${target.agentId}:${target.agentType}`,
              reason: 'Load balancing',
            });
          }
        }
      }

      // ADR-0181 Phase 5 (F4-3): dispatch through the archivist for the apply
      // path. The handler short-circuits when dryRun=true (returns void without
      // mutating); when dryRun=false it recomputes the same moves under
      // substrate.withWrite — which is the correct lock scope, and is what
      // guarantees rebalance + concurrent steal don't race the same claim.
      const archivist = await getProcessArchivist();
      await archivist.dispatch('claims_rebalance', {
        dryRun,
        targetUtilization,
      });

      return {
        success: true,
        dryRun,
        suggestions,
        metrics: {
          totalAgents: loads.length,
          avgLoad,
          overloadedCount: overloaded.length,
          underloadedCount: underloaded.length,
          targetUtilization,
        },
        message: dryRun
          ? `Found ${suggestions.length} rebalancing opportunities (dry run)`
          : `Applied ${suggestions.length} rebalancing moves`,
      };
    },
  },
];

export default claimsTools;
