import type { MCPToolDefinition } from '@claude-flow/shared/src/plugin-interface.js';
import type { PluginContext } from '@claude-flow/shared/src/plugin-interface.js';
import type { FederationCoordinator } from './application/federation-coordinator.js';
import type { FederationMessageType } from './domain/entities/federation-envelope.js';

type CoordinatorGetter = () => FederationCoordinator | null;
type ContextGetter = () => PluginContext | null;

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

export function createMcpTools(
  getCoordinator: CoordinatorGetter,
  getContext: ContextGetter,
): MCPToolDefinition[] {
  function requireCoordinator(): FederationCoordinator {
    const c = getCoordinator();
    if (!c) throw new Error('Federation not initialized');
    return c;
  }

  return [
    {
      name: 'federation_init',
      description: 'Initialize federation on this node with a manifest and begin discovery',
      pluginName: '@claude-flow/plugin-agent-federation',
      version: '1.0.0-alpha.1',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Unique node identifier' },
          endpoint: { type: 'string', description: 'WebSocket or HTTP endpoint for this node' },
          agentTypes: { type: 'array', description: 'Supported agent types', items: { type: 'string' } },
        },
        required: ['endpoint'],
      },
      handler: async (params) => {
        const coordinator = requireCoordinator();
        const nodeId = (params['nodeId'] as string) ?? `node-${Date.now().toString(36)}`;
        await coordinator.initialize({
          nodeId,
          publicKey: '',
          endpoint: params['endpoint'] as string,
          capabilities: {
            agentTypes: (params['agentTypes'] as string[]) ?? ['coder', 'reviewer'],
            maxConcurrentSessions: 10,
            supportedProtocols: ['websocket', 'http'],
            complianceModes: [],
          },
          version: '1.0.0-alpha.1',
          timestamp: new Date().toISOString(),
        });
        return textResult(`Federation initialized for node ${nodeId}`);
      },
    },
    {
      name: 'federation_join',
      description: 'Join a federation by connecting to a remote peer endpoint',
      pluginName: '@claude-flow/plugin-agent-federation',
      version: '1.0.0-alpha.1',
      inputSchema: {
        type: 'object',
        properties: {
          endpoint: { type: 'string', description: 'Remote peer endpoint to join' },
        },
        required: ['endpoint'],
      },
      handler: async (params) => {
        const coordinator = requireCoordinator();
        const session = await coordinator.joinPeer(params['endpoint'] as string);
        return textResult(`Joined peer. Session: ${session.sessionId}, Trust: ${session.trustLevel}`);
      },
    },
    {
      name: 'federation_peers',
      description: 'List all known federation peers with their trust levels and status',
      pluginName: '@claude-flow/plugin-agent-federation',
      version: '1.0.0-alpha.1',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const coordinator = requireCoordinator();
        const status = coordinator.getStatus();
        return textResult(JSON.stringify(status.trustLevels, null, 2));
      },
    },
    {
      name: 'federation_send',
      description: 'Send a message to a federated peer through the PII pipeline and security gates',
      pluginName: '@claude-flow/plugin-agent-federation',
      version: '1.0.0-alpha.1',
      inputSchema: {
        type: 'object',
        properties: {
          targetNodeId: { type: 'string', description: 'Target node ID' },
          messageType: { type: 'string', description: 'Message type (task-assignment, memory-query, context-share, etc.)' },
          payload: { type: 'object', description: 'Message payload' },
        },
        required: ['targetNodeId', 'messageType', 'payload'],
      },
      handler: async (params) => {
        const coordinator = requireCoordinator();
        const result = await coordinator.sendMessage(
          params['targetNodeId'] as string,
          params['messageType'] as FederationMessageType,
          params['payload'],
        );
        return textResult(JSON.stringify(result, null, 2), !result.success);
      },
    },
    {
      name: 'federation_query',
      description: 'Query federated memory from a remote peer (PII-gated)',
      pluginName: '@claude-flow/plugin-agent-federation',
      version: '1.0.0-alpha.1',
      inputSchema: {
        type: 'object',
        properties: {
          targetNodeId: { type: 'string', description: 'Target node ID to query' },
          query: { type: 'string', description: 'Memory query string' },
          namespace: { type: 'string', description: 'Memory namespace to query' },
        },
        required: ['targetNodeId', 'query'],
      },
      handler: async (params) => {
        const coordinator = requireCoordinator();
        const result = await coordinator.sendMessage(
          params['targetNodeId'] as string,
          'memory-query',
          { query: params['query'], namespace: params['namespace'] ?? 'default' },
        );
        return textResult(JSON.stringify(result, null, 2), !result.success);
      },
    },
    {
      name: 'federation_status',
      description: 'Get federation health status including active sessions, peers, and trust levels',
      pluginName: '@claude-flow/plugin-agent-federation',
      version: '1.0.0-alpha.1',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const coordinator = requireCoordinator();
        return textResult(JSON.stringify(coordinator.getStatus(), null, 2));
      },
    },
    {
      name: 'federation_trust',
      description: 'View or review trust score details for a specific node',
      pluginName: '@claude-flow/plugin-agent-federation',
      version: '1.0.0-alpha.1',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'Node ID to inspect' },
        },
        required: ['nodeId'],
      },
      handler: async (params) => {
        const coordinator = requireCoordinator();
        const status = coordinator.getStatus();
        const nodeId = params['nodeId'] as string;
        const trustLevel = status.trustLevels[nodeId];
        if (trustLevel === undefined) {
          return textResult(`Node ${nodeId} not found`, true);
        }
        return textResult(JSON.stringify({ nodeId, trustLevel }, null, 2));
      },
    },
    {
      name: 'federation_audit',
      description: 'Query federation audit logs with optional compliance mode filtering',
      pluginName: '@claude-flow/plugin-agent-federation',
      version: '1.0.0-alpha.1',
      inputSchema: {
        type: 'object',
        properties: {
          eventType: { type: 'string', description: 'Filter by event type' },
          severity: { type: 'string', description: 'Filter by severity (info, warn, error, critical)' },
          since: { type: 'string', description: 'ISO 8601 date to filter events since' },
          limit: { type: 'number', description: 'Maximum number of results' },
        },
      },
      handler: async (params) => {
        const context = getContext();
        if (!context) return textResult('Plugin not initialized', true);
        const audit = context.services.get<import('./domain/services/audit-service.js').AuditService>('federation:audit');
        if (!audit) return textResult('Audit service not found', true);

        const events = await audit.query({
          eventType: params['eventType'] as any,
          severity: params['severity'] as any,
          since: params['since'] ? new Date(params['since'] as string) : undefined,
          limit: (params['limit'] as number) ?? 50,
        });
        return textResult(JSON.stringify(events, null, 2));
      },
    },
    {
      name: 'federation_consensus',
      description: 'Propose a federated consensus operation across all active peers',
      pluginName: '@claude-flow/plugin-agent-federation',
      version: '1.0.0-alpha.1',
      inputSchema: {
        type: 'object',
        properties: {
          messageType: { type: 'string', description: 'Consensus message type (trust-change, topology-change, agent-spawn)' },
          payload: { type: 'object', description: 'Consensus proposal payload' },
          quorumFraction: { type: 'number', description: 'Required quorum fraction (default 2/3)' },
        },
        required: ['messageType', 'payload'],
      },
      handler: async (params) => {
        const context = getContext();
        if (!context) return textResult('Plugin not initialized', true);
        const routing = context.services.get<import('./domain/services/routing-service.js').RoutingService>('federation:routing');
        if (!routing) return textResult('Routing service not found', true);

        const proposal = await routing.propose(
          params['messageType'] as FederationMessageType,
          params['payload'],
          (params['quorumFraction'] as number) ?? 2 / 3,
        );
        return textResult(JSON.stringify({
          proposalId: proposal.proposalId,
          messageType: proposal.messageType,
          quorumRequired: proposal.quorumRequired,
          expiresAt: proposal.expiresAt.toISOString(),
        }, null, 2));
      },
    },
  ];
}
