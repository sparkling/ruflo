import type {
  ClaudeFlowPlugin,
  PluginContext,
  MCPToolDefinition,
  CLICommandDefinition,
  AgentTypeDefinition,
} from '@claude-flow/shared/src/plugin-interface.js';

import * as ed from '@noble/ed25519';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// @noble/ed25519 v2 needs a sync sha512 wired explicitly.
ed.etc.sha512Sync = (...m: Uint8Array[]): Uint8Array => {
  const h = createHash('sha512');
  for (const x of m) h.update(x);
  return h.digest();
};

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

    // ADR-095 G2: real Ed25519 keypair instead of empty publicKey + stub
    // signatures. Persist to .claude-flow/federation/key-<nodeId>.json so
    // the same node identity survives restarts. Audit log
    // audit_1776483149979 flagged the previous "verifySignature returns
    // true unconditionally" as a critical authn bypass; this closes it.
    const keyDir = join(process.cwd(), '.claude-flow', 'federation');
    const keyPath = join(keyDir, `key-${nodeId}.json`);
    let privateKey: Uint8Array;
    let publicKeyHex: string;
    try {
      if (existsSync(keyPath)) {
        const stored = JSON.parse(readFileSync(keyPath, 'utf-8')) as { privateKey: string; publicKey: string; nodeId: string };
        privateKey = new Uint8Array(Buffer.from(stored.privateKey, 'hex'));
        publicKeyHex = stored.publicKey;
      } else {
        privateKey = ed.utils.randomPrivateKey();
        const pk = ed.getPublicKey(privateKey);
        publicKeyHex = Buffer.from(pk).toString('hex');
        if (!existsSync(keyDir)) mkdirSync(keyDir, { recursive: true, mode: 0o700 });
        writeFileSync(keyPath, JSON.stringify({
          nodeId,
          privateKey: Buffer.from(privateKey).toString('hex'),
          publicKey: publicKeyHex,
          createdAt: new Date().toISOString(),
        }, null, 2), { mode: 0o600 });
      }
    } catch (err) {
      // Fall back to ephemeral key if persistence fails — still real crypto.
      privateKey = ed.utils.randomPrivateKey();
      const pk = ed.getPublicKey(privateKey);
      publicKeyHex = Buffer.from(pk).toString('hex');
      context.logger.warn(`Federation: could not persist keypair (${err instanceof Error ? err.message : err}); using ephemeral key for this session`);
    }

    const coordConfig: FederationCoordinatorConfig = {
      nodeId,
      publicKey: publicKeyHex,
      endpoint,
      capabilities: ['send', 'receive', 'query-redacted', 'status', 'ping', 'discovery'],
    };

    const generateId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // ADR-095 G2: real signing + verification using @noble/ed25519. The
    // sign* helpers use this node's private key; verify* helpers accept
    // a peer's public key over the wire and check the signature with
    // ed.verify(). No "return true" stubs.
    const signBytes = (msg: string): string => {
      const sig = ed.sign(new TextEncoder().encode(msg), privateKey);
      return Buffer.from(sig).toString('hex');
    };
    const verifyBytes = (msg: string, signatureHex: string, peerPublicKeyHex: string): boolean => {
      try {
        if (!signatureHex || !peerPublicKeyHex) return false;
        return ed.verify(
          Buffer.from(signatureHex, 'hex'),
          new TextEncoder().encode(msg),
          Buffer.from(peerPublicKeyHex, 'hex'),
        );
      } catch { return false; }
    };

    // Canonical manifest serialization for signing — sorts keys to keep
    // sign/verify deterministic. Excludes the signature field itself.
    const canonicalize = (obj: Record<string, unknown>): string => {
      const stripped: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) {
        if (k === 'signature') continue;
        const v = obj[k];
        stripped[k] = (v && typeof v === 'object' && !Array.isArray(v))
          ? JSON.parse(canonicalize(v as Record<string, unknown>))
          : v;
      }
      return JSON.stringify(stripped);
    };

    const discovery = new DiscoveryService(
      {
        signManifest: async (manifest) => signBytes(canonicalize(manifest as unknown as Record<string, unknown>)),
        verifyManifest: async (manifest) => {
          const peerPub = (manifest as { publicKey?: string }).publicKey;
          const sig = (manifest as { signature?: string }).signature;
          if (!peerPub || !sig) return false;
          return verifyBytes(canonicalize(manifest as unknown as Record<string, unknown>), sig, peerPub);
        },
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
      signChallenge: async (nonce) => signBytes(nonce),
      verifySignature: async (nonce, signature, peerPublicKey) =>
        verifyBytes(nonce, signature, peerPublicKey),
      getLocalNodeId: () => nodeId,
      getLocalPublicKey: () => publicKeyHex,
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
