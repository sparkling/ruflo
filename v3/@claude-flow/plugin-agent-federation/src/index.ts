export { AgentFederationPlugin } from './plugin.js';

export { FederationNode, type FederationNodeProps, type FederationNodeCapabilities, type FederationNodeMetadata } from './domain/entities/federation-node.js';
export { FederationSession, type FederationSessionProps, type SessionMetrics } from './domain/entities/federation-session.js';
export {
  FederationEnvelope,
  type FederationEnvelopeProps,
  type FederationMessageType,
  type PIIScanResult,
  type PIIScanDetection,
  type PIIScanAction,
  CONSENSUS_REQUIRED_TYPES,
} from './domain/entities/federation-envelope.js';
export {
  TrustLevel,
  TRUST_TRANSITION_THRESHOLDS,
  CAPABILITY_GATES,
  isOperationAllowed,
  getTrustLevelLabel,
  type TrustTransitionThreshold,
} from './domain/entities/trust-level.js';

export {
  PIIPipelineService,
  type PIIType,
  type PIIAction,
  type PIIDetection,
  type PIIPolicyConfig,
  type PIICalibration,
  type PIITransformResult,
  type PIIConfidenceThresholds,
  type PIIPipelineServiceDeps,
} from './domain/services/pii-pipeline-service.js';
export {
  DiscoveryService,
  type DiscoveryMechanism,
  type FederationManifest,
  type DiscoveryServiceDeps,
  type DiscoveryConfig,
} from './domain/services/discovery-service.js';
export {
  HandshakeService,
  type HandshakeChallenge,
  type HandshakeChallengeResponse,
  type HandshakeResult,
  type HandshakeServiceDeps,
  type HandshakeConfig,
} from './domain/services/handshake-service.js';
export {
  RoutingService,
  type RoutingMode,
  type RoutingResult,
  type ConsensusProposal,
  type RoutingServiceDeps,
} from './domain/services/routing-service.js';
export {
  AuditService,
  type FederationAuditEvent,
  type FederationAuditEventType,
  type AuditSeverity,
  type AuditCategory,
  type ComplianceMode,
  type AuditQuery,
  type AuditExportFormat,
  type AuditServiceDeps,
  type AuditServiceConfig,
} from './domain/services/audit-service.js';

export {
  TrustEvaluator,
  type TrustScoreComponents,
  type TrustTransitionResult,
  type ImmediateDowngradeReason,
  type TrustEvaluatorDeps,
} from './application/trust-evaluator.js';
export {
  FederationCoordinator,
  type FederationCoordinatorConfig,
  type FederationStatus,
} from './application/federation-coordinator.js';
export {
  PolicyEngine,
  type FederationClaimType,
  type SecurityPolicy,
  type PolicyEvaluationResult,
  type PolicyEngineDeps,
} from './application/policy-engine.js';
