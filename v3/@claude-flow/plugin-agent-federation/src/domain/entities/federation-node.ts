import { TrustLevel } from './trust-level.js';

export interface FederationNodeCapabilities {
  readonly agentTypes: readonly string[];
  readonly maxConcurrentSessions: number;
  readonly supportedProtocols: readonly string[];
  readonly complianceModes: readonly string[];
}

export interface FederationNodeMetadata {
  readonly organizationId?: string;
  readonly region?: string;
  readonly version?: string;
  readonly [key: string]: unknown;
}

export interface FederationNodeProps {
  readonly nodeId: string;
  readonly publicKey: string;
  readonly endpoint: string;
  readonly capabilities: FederationNodeCapabilities;
  readonly trustLevel: TrustLevel;
  readonly trustScore: number;
  readonly lastSeen: Date;
  readonly metadata: FederationNodeMetadata;
}

export class FederationNode {
  readonly nodeId: string;
  readonly publicKey: string;
  readonly endpoint: string;
  readonly capabilities: FederationNodeCapabilities;

  private _trustLevel: TrustLevel;
  private _trustScore: number;
  private _lastSeen: Date;
  private readonly _metadata: FederationNodeMetadata;

  constructor(props: FederationNodeProps) {
    this.nodeId = props.nodeId;
    this.publicKey = props.publicKey;
    this.endpoint = props.endpoint;
    this.capabilities = props.capabilities;
    this._trustLevel = props.trustLevel;
    this._trustScore = props.trustScore;
    this._lastSeen = props.lastSeen;
    this._metadata = props.metadata;
  }

  get trustLevel(): TrustLevel {
    return this._trustLevel;
  }

  get trustScore(): number {
    return this._trustScore;
  }

  get lastSeen(): Date {
    return this._lastSeen;
  }

  get metadata(): FederationNodeMetadata {
    return this._metadata;
  }

  updateTrustLevel(level: TrustLevel): void {
    this._trustLevel = level;
  }

  updateTrustScore(score: number): void {
    this._trustScore = Math.max(0, Math.min(1, score));
  }

  markSeen(): void {
    this._lastSeen = new Date();
  }

  isStale(maxAgeMs: number): boolean {
    return Date.now() - this._lastSeen.getTime() > maxAgeMs;
  }

  toProps(): FederationNodeProps {
    return {
      nodeId: this.nodeId,
      publicKey: this.publicKey,
      endpoint: this.endpoint,
      capabilities: this.capabilities,
      trustLevel: this._trustLevel,
      trustScore: this._trustScore,
      lastSeen: this._lastSeen,
      metadata: this._metadata,
    };
  }

  static create(props: Omit<FederationNodeProps, 'trustLevel' | 'trustScore' | 'lastSeen'> & {
    trustLevel?: TrustLevel;
    trustScore?: number;
    lastSeen?: Date;
  }): FederationNode {
    return new FederationNode({
      ...props,
      trustLevel: props.trustLevel ?? TrustLevel.UNTRUSTED,
      trustScore: props.trustScore ?? 0,
      lastSeen: props.lastSeen ?? new Date(),
    });
  }
}
