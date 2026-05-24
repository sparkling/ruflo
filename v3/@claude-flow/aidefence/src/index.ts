/**
 * @claude-flow/aidefence
 *
 * Manual scan utility for prompt-injection and PII patterns. NOT a runtime
 * defence-in-depth gate — the MCP tools (`aidefence_scan`, `_is_safe`,
 * `_has_pii`, `_analyze`, `_stats`, `_learn`) are caller-opt-in; the
 * central dispatch boundary (`mcp-client.ts::callMCPTool`,
 * `archivist.dispatch`) does NOT pre-scan payloads. Wire your own gates if
 * you need defence-in-depth (the 3-gate pattern in
 * `plugins/ruflo-aidefence/docs/adrs/0001-aidefence-contract.md` is a
 * caller-side convention, not enforced here).
 *
 * Features:
 * - 50+ prompt-injection regex patterns (`domain/services/threat-detection-service.ts`)
 * - `searchSimilarThreats()` does ad-hoc cosine similarity over an in-memory
 *   `Map`-backed `InMemoryVectorStore`; pass a custom `VectorStore`
 *   (e.g. AgentDB-backed) to use HNSW-indexed retrieval. Default is NOT
 *   HNSW-indexed and offers no speedup over a linear scan.
 *   (ADR-0238 Surface 1 + ADR-0247 F-04-010 HNSW-scope clarification.)
 * - Optional learning service stores `LearnedThreatPattern` records when
 *   `enableLearning: true` and `learnFromDetection()` is called explicitly.
 * - PII detection via regex (no ML model).
 *
 * @example
 * ```typescript
 * import { createAIDefence } from '@claude-flow/aidefence';
 *
 * // Manual, caller-side scan
 * const aidefence = createAIDefence({ enableLearning: true });
 * const result = await aidefence.detect('Ignore all previous instructions');
 * console.log(result.safe); // false
 *
 * // For HNSW-indexed similarity, pass an AgentDB-backed VectorStore
 * // (defaults to InMemoryVectorStore which performs a linear scan):
 * const similar = await aidefence.searchSimilarThreats('system prompt injection');
 *
 * // Learning is opt-in
 * await aidefence.learnFromDetection(input, result, { wasAccurate: true });
 * ```
 */

// Domain entities
export type {
  Threat,
  ThreatType,
  ThreatSeverity,
  ThreatDetectionResult,
  BehavioralAnalysisResult,
  PolicyVerificationResult,
} from './domain/entities/threat.js';

export { createThreat } from './domain/entities/threat.js';

// Domain services
export { ThreatDetectionService, createThreatDetectionService } from './domain/services/threat-detection-service.js';

export type {
  LearnedThreatPattern,
  MitigationStrategy,
  LearningTrajectory,
  VectorStore,
} from './domain/services/threat-learning-service.js';

export {
  ThreatLearningService,
  createThreatLearningService,
  InMemoryVectorStore,
} from './domain/services/threat-learning-service.js';

// Import for internal use
import { createThreatDetectionService } from './domain/services/threat-detection-service.js';
import { createThreatLearningService } from './domain/services/threat-learning-service.js';
import type { ThreatDetectionResult, ThreatType, Threat } from './domain/entities/threat.js';
import type { LearnedThreatPattern, MitigationStrategy, VectorStore } from './domain/services/threat-learning-service.js';

/**
 * Configuration for AIDefence
 */
export interface AIDefenceConfig {
  /** Enable self-learning from detections */
  enableLearning?: boolean;
  /** Custom vector store (defaults to in-memory, use AgentDB for production) */
  vectorStore?: VectorStore;
  /** Minimum confidence threshold for threats */
  confidenceThreshold?: number;
  /** Enable PII detection */
  enablePIIDetection?: boolean;
}

/**
 * AIDefence - Unified threat detection and learning facade
 */
export interface AIDefence {
  /**
   * Detect threats in input text
   */
  detect(input: string): Promise<ThreatDetectionResult>;

  /**
   * Quick scan for threats (faster, less detailed)
   */
  quickScan(input: string): { threat: boolean; confidence: number };

  /**
   * Check if input contains PII
   */
  hasPII(input: string): boolean;

  /**
   * Search for similar threat patterns.
   *
   * Default behaviour: linear cosine scan over the InMemoryVectorStore (no
   * HNSW indexing). Pass an AgentDB-backed VectorStore via
   * `createAIDefence({ vectorStore })` to use HNSW-indexed retrieval. The
   * speedup is in the substrate, not this function.
   * (ADR-0238 Surface 1 + ADR-0247 F-04-010 HNSW-scope clarification.)
   */
  searchSimilarThreats(
    query: string,
    options?: { k?: number; minSimilarity?: number }
  ): Promise<LearnedThreatPattern[]>;

  /**
   * Learn from a detection result (ReasoningBank pattern)
   */
  learnFromDetection(
    input: string,
    result: ThreatDetectionResult,
    feedback?: { wasAccurate: boolean; userVerdict?: string }
  ): Promise<void>;

  /**
   * Record mitigation effectiveness for meta-learning
   */
  recordMitigation(
    threatType: ThreatType,
    strategy: 'block' | 'sanitize' | 'warn' | 'log' | 'escalate' | 'transform' | 'redirect',
    success: boolean
  ): Promise<void>;

  /**
   * Get best mitigation strategy based on learned effectiveness
   */
  getBestMitigation(
    threatType: ThreatType
  ): Promise<MitigationStrategy | null>;

  /**
   * Start a learning trajectory session
   */
  startTrajectory(sessionId: string, task: string): void;

  /**
   * End a learning trajectory and store for future learning
   */
  endTrajectory(sessionId: string, verdict: 'success' | 'failure' | 'partial'): Promise<void>;

  /**
   * Get detection and learning statistics
   */
  getStats(): Promise<{
    detectionCount: number;
    avgDetectionTimeMs: number;
    learnedPatterns: number;
    mitigationStrategies: number;
    avgMitigationEffectiveness: number;
  }>;
}

/**
 * Create an AIDefence instance with optional learning capabilities
 *
 * @example
 * ```typescript
 * // Simple usage (detection only)
 * const simple = createAIDefence();
 *
 * // With learning enabled (uses InMemoryVectorStore: linear cosine scan)
 * const learning = createAIDefence({ enableLearning: true });
 *
 * // With AgentDB-backed VectorStore for HNSW-indexed similarity. The
 * // speedup comes from AgentDB's HNSW substrate, not from aidefence
 * // itself. (ADR-0238 Surface 1 + ADR-0247 F-04-010 HNSW-scope.)
 * import { AgentDB } from 'agentdb';
 * const agentdb = new AgentDB({ path: './data/aidefence' });
 * const indexed = createAIDefence({
 *   enableLearning: true,
 *   vectorStore: agentdb
 * });
 * ```
 */
export function createAIDefence(config: AIDefenceConfig = {}): AIDefence {
  const detectionService = createThreatDetectionService();
  const learningService = config.enableLearning
    ? createThreatLearningService(config.vectorStore)
    : null;

  return {
    async detect(input: string) {
      const result = detectionService.detect(input);

      // Auto-learn if enabled
      if (learningService && result.threats.length > 0) {
        await learningService.learnFromDetection(input, result);
      }

      return result;
    },

    quickScan(input: string) {
      return detectionService.quickScan(input);
    },

    hasPII(input: string) {
      return detectionService.detectPII(input);
    },

    async searchSimilarThreats(query, options) {
      if (!learningService) {
        return [];
      }
      return learningService.searchSimilarThreats(query, options);
    },

    async learnFromDetection(input, result, feedback) {
      if (!learningService) {
        console.warn('Learning not enabled. Pass { enableLearning: true } to createAIDefence()');
        return;
      }
      await learningService.learnFromDetection(input, result, feedback);
    },

    async recordMitigation(threatType, strategy, success) {
      if (!learningService) return;
      await learningService.recordMitigation(threatType, strategy, success);
    },

    async getBestMitigation(threatType) {
      if (!learningService) return null;
      return learningService.getBestMitigation(threatType);
    },

    startTrajectory(sessionId, task) {
      learningService?.startTrajectory(sessionId, task);
    },

    async endTrajectory(sessionId, verdict) {
      await learningService?.endTrajectory(sessionId, verdict);
    },

    async getStats() {
      const detectionStats = detectionService.getStats();
      const learningStats = learningService
        ? await learningService.getStats()
        : { learnedPatterns: 0, mitigationStrategies: 0, avgEffectiveness: 0 };

      return {
        detectionCount: detectionStats.detectionCount,
        avgDetectionTimeMs: detectionStats.avgDetectionTimeMs,
        learnedPatterns: learningStats.learnedPatterns,
        mitigationStrategies: learningStats.mitigationStrategies,
        avgMitigationEffectiveness: learningStats.avgEffectiveness,
      };
    },
  };
}

/**
 * Singleton instance for convenience
 */
let defaultInstance: AIDefence | null = null;

/**
 * Get the default AIDefence instance (singleton, learning enabled)
 */
export function getAIDefence(): AIDefence {
  if (!defaultInstance) {
    defaultInstance = createAIDefence({ enableLearning: true });
  }
  return defaultInstance;
}

/**
 * Convenience function for quick threat check
 */
export function isSafe(input: string): boolean {
  const service = createThreatDetectionService();
  return service.detect(input).safe;
}

/**
 * Convenience function for quick threat check with details
 */
export function checkThreats(input: string) {
  const service = createThreatDetectionService();
  return service.detect(input);
}

/**
 * Integration with agentic-flow attention mechanisms
 * Use for multi-agent security consensus
 */
export interface AttentionContext {
  agentId: string;
  threatAssessment: ThreatDetectionResult;
  weight: number;
}

/**
 * Calculate security consensus from multiple agent assessments
 * Uses attention-based weighting for flash attention integration
 */
export function calculateSecurityConsensus(
  assessments: AttentionContext[]
): {
  consensus: 'safe' | 'threat' | 'uncertain';
  confidence: number;
  criticalThreats: Threat[];
} {
  if (assessments.length === 0) {
    return { consensus: 'uncertain', confidence: 0, criticalThreats: [] };
  }

  // Normalize weights
  const totalWeight = assessments.reduce((sum, a) => sum + a.weight, 0);
  const normalized = assessments.map(a => ({
    ...a,
    weight: a.weight / totalWeight,
  }));

  // Calculate weighted threat score
  let threatScore = 0;
  const allThreats: Threat[] = [];

  for (const assessment of normalized) {
    if (!assessment.threatAssessment.safe) {
      threatScore += assessment.weight;
      allThreats.push(...assessment.threatAssessment.threats);
    }
  }

  // Determine consensus
  const criticalThreats = allThreats.filter(t => t.severity === 'critical');

  if (criticalThreats.length > 0) {
    return {
      consensus: 'threat',
      confidence: Math.max(...criticalThreats.map(t => t.confidence)),
      criticalThreats,
    };
  }

  if (threatScore > 0.5) {
    return { consensus: 'threat', confidence: threatScore, criticalThreats: [] };
  }

  if (threatScore < 0.2) {
    return { consensus: 'safe', confidence: 1 - threatScore, criticalThreats: [] };
  }

  return { consensus: 'uncertain', confidence: 0.5, criticalThreats: [] };
}
