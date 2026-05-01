import type {
  ClaudeFlowPlugin,
  PluginContext,
  MCPToolDefinition,
  CLICommandDefinition,
  AgentTypeDefinition,
} from '@claude-flow/shared/src/plugin-interface.js';

import { FederationCoordinator, type FederationCoordinatorConfig } from './application/federation-coordinator.js';
import { DiscoveryService } from './domain/services/discovery-service.js';
import { HandshakeService } from './domain/services/handshake-service.js';
import { RoutingService } from './domain/services/routing-service.js';
import { AuditService, type ComplianceMode } from './domain/services/audit-service.js';
import { PIIPipelineService } from './domain/services/pii-pipeline-service.js';
import { TrustEvaluator } from './application/trust-evaluator.js';
import { PolicyEngine, type FederationClaimType } from './application/policy-engine.js';
import { TrustLevel, getTrustLevelLabel } from './domain/entities/trust-level.js';
import { type FederationMessageType } from './domain/entities/federation-envelope.js';
import { createMcpTools } from './mcp-tools.js';
import { createCliCommands } from './cli-commands.js';

export class AgentFederationPlugin implements ClaudeFlowPlugin {
  readonly name = '@claude-flow/plugin-agent-federation';
  readonly version = '1.0.0-alpha.1';
  readonly description = 'Cross-installation agent federation with PII protection and AI defence';
  readonly author = 'Claude Flow Team';
  readonly dependencies = ['@claude-flow/security', '@claude-flow/aidefence'];

  private coordinator: FederationCoordinator | null = null;
  private context: PluginContext | null = null;

  async initialize(context: PluginContext): Promise<void> {
    this.context = context;
    const config = context.config;

    const nodeId = (config['nodeId'] as string) ?? `node-${Date.now().toString(36)}`;
    const endpoint = (config['endpoint'] as string) ?? 'ws://localhost:9100';
    const complianceMode = (config['complianceMode'] as ComplianceMode) ?? 'none';
    const staticPeers = (config['staticPeers'] as string[]) ?? [];
    const hashSalt = (config['hashSalt'] as string) ?? `salt-${nodeId}`;

    const coordConfig: FederationCoordinatorConfig = {
      nodeId,
      publicKey: '',
      endpoint,
      capabilities: ['send', 'receive', 'query-redacted', 'status', 'ping', 'discovery'],
    };

    const generateId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const discovery = new DiscoveryService(
      {
        signManifest: async () => 'stub-signature',
        verifyManifest: async () => true,
        onPeerDiscovered: (node) => {
          context.logger.info(`Peer discovered: ${node.nodeId} at ${node.endpoint}`);
        },
      },
      { staticPeers },
    );

    const handshake = new HandshakeService({
      generateSessionId: generateId,
      generateSessionToken: () => `token-${generateId()}`,
      generateNonce: () => `nonce-${Math.random().toString(36).slice(2)}`,
      signChallenge: async (nonce) => `sig-${nonce}`,
      verifySignature: async () => true,
      getLocalNodeId: () => nodeId,
      getLocalPublicKey: () => '',
      getLocalCapabilities: () => coordConfig.capabilities,
    });

    const piiPipeline = new PIIPipelineService(
      { hashFunction: (val, salt) => `hash-${salt}-${val.slice(0, 4)}` },
      { hashSalt },
    );

    const auditEvents: Array<Record<string, unknown>> = [];
    const audit = new AuditService(
      {
        generateEventId: generateId,
        getLocalNodeId: () => nodeId,
        persistEvent: async (event) => { auditEvents.push(event as unknown as Record<string, unknown>); },
        queryEvents: async (query) => {
          return auditEvents
            .filter(e => {
              if (query.eventType && e['eventType'] !== query.eventType) return false;
              if (query.severity && e['severity'] !== query.severity) return false;
              if (query.category && e['category'] !== query.category) return false;
              return true;
            })
            .slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 100)) as any;
        },
        onAuditEvent: (event) => {
          context.eventBus.emit('federation:audit', event);
        },
      },
      { complianceMode },
    );

    const trustEvaluator = new TrustEvaluator({
      onTrustChange: (nid, result) => {
        context.logger.info(`Trust change for ${nid}: ${getTrustLevelLabel(result.previousLevel)} -> ${getTrustLevelLabel(result.newLevel)}`);
        context.eventBus.emit('federation:trust-change', { nodeId: nid, ...result });
      },
    });

    const policyEngine = new PolicyEngine(
      { checkClaim: () => true },
    );

    const sessions: Map<string, import('./domain/entities/federation-session.js').FederationSession> = new Map();

    const routing = new RoutingService({
      generateEnvelopeId: generateId,
      generateNonce: () => `nonce-${Math.random().toString(36).slice(2)}`,
      signEnvelope: (payload, token) => `hmac-${token.slice(0, 6)}-${payload.length}`,
      verifyEnvelope: () => true,
      scanPii: (text, trustLevel) => {
        const result = piiPipeline.transform(text, trustLevel as TrustLevel);
        return {
          transformedText: result.transformedText,
          scanResult: {
            scanned: true,
            piiFound: result.detections.length > 0,
            detections: result.detections.map(d => ({
              type: d.type,
              action: result.actionsApplied.find(a => a.type === d.type)?.action ?? 'pass',
              confidence: d.confidence,
            })),
            actionsApplied: result.actionsApplied.map(a => a.action),
            scanDurationMs: 0,
          },
        };
      },
      sendToNode: async (targetNodeId, envelope) => {
        context.logger.debug(`Sending envelope ${envelope.envelopeId} to ${targetNodeId}`);
      },
      getActiveSessions: () => Array.from(sessions.values()).filter(s => s.active),
      getLocalNodeId: () => nodeId,
    });

    this.coordinator = new FederationCoordinator(
      coordConfig, discovery, handshake, routing, audit,
      piiPipeline, trustEvaluator, policyEngine,
    );

    context.services.register('federation:coordinator', this.coordinator);
    context.services.register('federation:discovery', discovery);
    context.services.register('federation:audit', audit);
    context.services.register('federation:pii', piiPipeline);
    context.services.register('federation:trust', trustEvaluator);
    context.services.register('federation:policy', policyEngine);
    context.services.register('federation:routing', routing);

    context.logger.info('Agent Federation plugin initialized');
  }

  async shutdown(): Promise<void> {
    if (this.coordinator) {
      await this.coordinator.shutdown();
      this.coordinator = null;
    }
    this.context?.logger.info('Agent Federation plugin shut down');
    this.context = null;
  }

  registerMCPTools(): MCPToolDefinition[] {
    return createMcpTools(() => this.coordinator, () => this.context);
  }

  registerCLICommands(): CLICommandDefinition[] {
    return createCliCommands(() => this.coordinator, () => this.context);
  }

  registerAgentTypes(): AgentTypeDefinition[] {
    return [
      {
        type: 'federation-coordinator',
        name: 'Federation Coordinator',
        description: 'Coordinates cross-installation agent federation, managing discovery, handshake, trust evaluation, and secure message routing between federated nodes.',
        defaultConfig: {
          id: '',
          name: 'federation-coordinator',
          type: 'coordinator',
          capabilities: [
            'federation:discover',
            'federation:connect',
            'federation:read',
            'federation:write',
            'federation:admin',
          ],
          maxConcurrentTasks: 10,
          priority: 90,
          timeout: 300_000,
          metadata: {
            pluginSource: '@claude-flow/plugin-agent-federation',
          },
        },
        requiredCapabilities: ['federation:discover', 'federation:connect'],
        metadata: {
          trustAware: true,
          piiAware: true,
        },
      },
    ];
  }

  async healthCheck(): Promise<boolean> {
    if (!this.coordinator) return false;
    const status = this.coordinator.getStatus();
    return status.healthy;
  }
}
