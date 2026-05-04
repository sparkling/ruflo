import { FederationNode } from '../domain/entities/federation-node.js';
import { FederationSession } from '../domain/entities/federation-session.js';
import { type FederationMessageType } from '../domain/entities/federation-envelope.js';
import { TrustLevel } from '../domain/entities/trust-level.js';
import { DiscoveryService, type FederationManifest } from '../domain/services/discovery-service.js';
import { HandshakeService } from '../domain/services/handshake-service.js';
import { RoutingService, type RoutingResult } from '../domain/services/routing-service.js';
import { AuditService } from '../domain/services/audit-service.js';
import { PIIPipelineService } from '../domain/services/pii-pipeline-service.js';
import { TrustEvaluator, type ImmediateDowngradeReason } from './trust-evaluator.js';
import { PolicyEngine } from './policy-engine.js';
import {
  type Budget,
  type BudgetEnforcement,
  enforceBudget,
  validateBudget,
} from '../domain/value-objects/federation-budget.js';

/**
 * Optional per-call budget controls (ADR-097 Phase 1). All fields are
 * optional; omitted means "no limit on that axis" (the default unbounded
 * budget still has maxHops = 8 to defang recursive delegation loops).
 */
export interface SendOptions {
  readonly budget?: { maxTokens?: number; maxUsd?: number };
  readonly maxHops?: number;
  /**
   * How many hops this message has already traveled (0 on the originator).
   * Phase 1 enforces at the send side because there is no inbound dispatcher
   * yet; callers re-forwarding a received message should pass the original
   * envelope's hopCount here.
   */
  readonly hopCount?: number;
  /** Caller-reported usage from the previous leg, for cumulative checks. */
  readonly spent?: { tokens?: number; usd?: number };
}

export interface FederationCoordinatorConfig {
  readonly nodeId: string;
  readonly publicKey: string;
  readonly endpoint: string;
  readonly capabilities: readonly string[];
}

export interface FederationStatus {
  readonly nodeId: string;
  readonly activeSessions: number;
  readonly knownPeers: number;
  readonly trustLevels: Record<string, TrustLevel>;
  readonly healthy: boolean;
}

export class FederationCoordinator {
  private readonly config: FederationCoordinatorConfig;
  private readonly discovery: DiscoveryService;
  private readonly handshake: HandshakeService;
  private readonly routing: RoutingService;
  private readonly audit: AuditService;
  private readonly piiPipeline: PIIPipelineService;
  private readonly trustEvaluator: TrustEvaluator;
  private readonly policyEngine: PolicyEngine;
  private readonly sessions: Map<string, FederationSession>;
  private initialized: boolean;

  constructor(
    config: FederationCoordinatorConfig,
    discovery: DiscoveryService,
    handshake: HandshakeService,
    routing: RoutingService,
    audit: AuditService,
    piiPipeline: PIIPipelineService,
    trustEvaluator: TrustEvaluator,
    policyEngine: PolicyEngine,
  ) {
    this.config = config;
    this.discovery = discovery;
    this.handshake = handshake;
    this.routing = routing;
    this.audit = audit;
    this.piiPipeline = piiPipeline;
    this.trustEvaluator = trustEvaluator;
    this.policyEngine = policyEngine;
    this.sessions = new Map();
    this.initialized = false;
  }

  async initialize(manifest: Omit<FederationManifest, 'signature'>): Promise<void> {
    await this.discovery.publishManifest(manifest);
    this.discovery.startPeriodicDiscovery();
    this.initialized = true;

    await this.audit.log('peer_manifest_published', {
      metadata: { endpoint: this.config.endpoint },
    });
  }

  async shutdown(): Promise<void> {
    this.discovery.stopPeriodicDiscovery();

    for (const [sessionId, session] of this.sessions) {
      session.terminate();
      await this.audit.log('session_terminated', {
        sessionId,
        targetNodeId: session.remoteNodeId,
      });
    }

    this.sessions.clear();
    await this.audit.flush();
    this.initialized = false;
  }

  async joinPeer(endpoint: string): Promise<FederationSession> {
    this.ensureInitialized();

    const node = await this.discovery.addStaticPeer(endpoint);

    await this.audit.log('peer_discovered', {
      targetNodeId: node.nodeId,
      metadata: { endpoint },
    });

    return this.establishSession(node);
  }

  async leavePeer(nodeId: string): Promise<void> {
    this.ensureInitialized();

    const session = this.findSessionByNodeId(nodeId);
    if (session) {
      session.terminate();
      this.sessions.delete(session.sessionId);

      await this.audit.log('session_terminated', {
        sessionId: session.sessionId,
        targetNodeId: nodeId,
      });
    }

    this.discovery.removePeer(nodeId);
  }

  async sendMessage<T>(
    targetNodeId: string,
    messageType: FederationMessageType,
    payload: T,
    options: SendOptions = {},
  ): Promise<RoutingResult> {
    this.ensureInitialized();

    const session = this.findSessionByNodeId(targetNodeId);
    if (!session) {
      return {
        success: false,
        mode: 'direct',
        envelopeId: '',
        targetNodeIds: [targetNodeId],
        error: `No active session with node ${targetNodeId}`,
      };
    }

    const policyResult = this.policyEngine.evaluateMessage(
      messageType,
      session.trustLevel,
      JSON.stringify(payload).length,
      this.config.nodeId,
    );

    if (!policyResult.allowed) {
      await this.audit.log('message_rejected', {
        targetNodeId,
        sessionId: session.sessionId,
        metadata: { reason: policyResult.reason },
      });
      return {
        success: false,
        mode: 'direct',
        envelopeId: '',
        targetNodeIds: [targetNodeId],
        error: policyResult.reason,
      };
    }

    // ADR-097 Phase 1: validate caller-supplied budget + enforce hop limit
    // and cumulative spend BEFORE outbound dispatch. Synchronous & atomic —
    // no awaits between validate and enforce, so concurrent sends cannot
    // both pass a single-hop budget. Errors are constant strings so a
    // malicious caller cannot use the response as a budget oracle.
    const budgetResult = validateBudget(options.budget, options.maxHops);
    if (!budgetResult.ok) {
      await this.audit.log('message_rejected', {
        targetNodeId,
        sessionId: session.sessionId,
        metadata: { reason: 'INVALID_BUDGET', detail: budgetResult.error },
      });
      return {
        success: false,
        mode: 'direct',
        envelopeId: '',
        targetNodeIds: [targetNodeId],
        error: 'INVALID_BUDGET',
      };
    }
    const enforcement: BudgetEnforcement = enforceBudget(
      budgetResult.budget,
      options.hopCount ?? 0,
      {
        tokens: options.spent?.tokens ?? 0,
        usd: options.spent?.usd ?? 0,
      },
    );
    if (!enforcement.ok) {
      await this.audit.log('message_rejected', {
        targetNodeId,
        sessionId: session.sessionId,
        metadata: { reason: enforcement.reason },
      });
      return {
        success: false,
        mode: 'direct',
        envelopeId: '',
        targetNodeIds: [targetNodeId],
        error: enforcement.reason, // constant string — no oracle leak
      };
    }

    const result = await this.routing.send(session, messageType, payload);

    await this.audit.log(result.success ? 'message_sent' : 'message_rejected', {
      targetNodeId,
      sessionId: session.sessionId,
      latencyMs: result.latencyMs,
      metadata: {
        messageType,
        mode: result.mode,
        hopCount: enforcement.nextHopCount,
      },
    });

    return result;
  }

  /**
   * Re-export the budget primitives so external callers (e.g. follow-up
   * iterations adding receive-side decrement) can reuse them without
   * dipping into domain/value-objects directly.
   */
  static readonly budget = { validate: validateBudget, enforce: enforceBudget };

  async broadcastMessage<T>(
    messageType: FederationMessageType,
    payload: T,
  ): Promise<RoutingResult[]> {
    this.ensureInitialized();
    return this.routing.broadcast(messageType, payload);
  }

  handleThreatDetection(nodeId: string): void {
    const exceedsThreshold = this.trustEvaluator.recordThreatDetection(nodeId);
    const node = this.discovery.getPeer(nodeId);

    if (node && exceedsThreshold) {
      this.trustEvaluator.downgrade(node, 'repeated-threat-detection');
      const session = this.findSessionByNodeId(nodeId);
      if (session) {
        session.terminate();
        this.sessions.delete(session.sessionId);
      }

      this.audit.log('threat_blocked', {
        sourceNodeId: nodeId,
        trustLevel: TrustLevel.UNTRUSTED,
        threatDetected: true,
        metadata: { reason: 'repeated-threat-detection' },
      });
    }
  }

  handleHmacFailure(nodeId: string): void {
    const node = this.discovery.getPeer(nodeId);
    if (node) {
      this.trustEvaluator.downgrade(node, 'hmac-verification-failure');
      const session = this.findSessionByNodeId(nodeId);
      if (session) {
        session.terminate();
        this.sessions.delete(session.sessionId);
      }

      this.audit.log('threat_blocked', {
        sourceNodeId: nodeId,
        trustLevel: TrustLevel.UNTRUSTED,
        metadata: { reason: 'hmac-verification-failure' },
      });
    }
  }

  getStatus(): FederationStatus {
    const peers = this.discovery.listPeers();
    const trustLevels: Record<string, TrustLevel> = {};
    for (const peer of peers) {
      trustLevels[peer.nodeId] = peer.trustLevel;
    }

    return {
      nodeId: this.config.nodeId,
      activeSessions: Array.from(this.sessions.values()).filter(s => s.active).length,
      knownPeers: peers.length,
      trustLevels,
      healthy: this.initialized,
    };
  }

  getSession(sessionId: string): FederationSession | undefined {
    return this.sessions.get(sessionId);
  }

  getActiveSessions(): FederationSession[] {
    return Array.from(this.sessions.values()).filter(s => s.active && !s.isExpired());
  }

  private async establishSession(node: FederationNode): Promise<FederationSession> {
    await this.audit.log('handshake_initiated', { targetNodeId: node.nodeId });

    const challenge = await this.handshake.initiateHandshake(node);
    const response = await this.handshake.respondToHandshake(challenge);
    const result = await this.handshake.verifyChallenge(response, node);

    if (!result.success || !result.session) {
      await this.audit.log('handshake_failed', {
        targetNodeId: node.nodeId,
        metadata: { error: result.error },
      });
      throw new Error(`Handshake failed: ${result.error}`);
    }

    this.sessions.set(result.session.sessionId, result.session);

    await this.audit.log('handshake_completed', {
      targetNodeId: node.nodeId,
      sessionId: result.session.sessionId,
      trustLevel: result.session.trustLevel,
    });

    await this.audit.log('session_created', {
      sessionId: result.session.sessionId,
      targetNodeId: node.nodeId,
      trustLevel: result.session.trustLevel,
    });

    return result.session;
  }

  private findSessionByNodeId(nodeId: string): FederationSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.remoteNodeId === nodeId && session.active) {
        return session;
      }
    }
    return undefined;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('FederationCoordinator is not initialized. Call initialize() first.');
    }
  }
}
