/**
 * Canonical .claude-flow/embeddings.json walk-up accessor.
 *
 * ADR-0177 Phase 1.6 refactor: extracted from
 *   - `forks/agentdb/src/core/config-chain.ts` (original canonical impl)
 *   - `forks/ruflo/v3/@claude-flow/memory/src/resolve-config.ts` (embedding-triple
 *     subset; the rest of `resolve-config.ts` — storage / HNSW / learning / graph
 *     keys — stays in memory and layers on top of `getEmbeddingConfig()` here).
 *
 * Both `@claude-flow/memory` and `agentdb` consume this package; neither depends
 * on the other for embedding config, so the previous dynamic-require cycle
 * (memory.resolve-config.ts:134 -> require('@claude-flow/agentdb')) is gone.
 *
 * Reads `.claude-flow/embeddings.json` (walking up from cwd) and surfaces
 * embedding model/dimension/provider plus the paid-provider gate. Boot-time
 * consumers (AgentDB.initialize, RvfBackend, EmbeddingService) call
 * `getConfig()` to read substrate-wide embedding settings. Paid-provider gate
 * is enforced via `feedback-no-api-keys`: when allowPaidProvider == false the
 * only acceptable provider is `onnx` / `transformers.js` (local).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface EmbeddingChainConfig {
  /** HuggingFace-style model identifier (e.g. `Xenova/all-mpnet-base-v2`). */
  readonly model: string | undefined;
  /** Vector dimension the substrate is configured to use. */
  readonly dimension: number;
  /** Embedding provider — `onnx` / `transformers.js` for local, `openai` etc. for paid. */
  readonly provider: string;
  /** Gate for non-local providers. False forbids `openai` / paid APIs at boot. */
  readonly allowPaidProvider: boolean;
}

export interface ConfigChain {
  readonly embedding: EmbeddingChainConfig;
}

/** Boot-time validation failure (missing model, disallowed paid provider). */
export class ConfigChainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigChainValidationError';
  }
}

/**
 * Embedding pipeline output dimension does not match the substrate-configured
 * dimension. Thrown at EmbeddingService.initialize() once the first call
 * resolves the pipeline's reported feature size.
 */
export class EmbeddingDimensionMismatchError extends Error {
  constructor(
    public readonly model: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `Embedding model "${model}" produced dimension ${actual} but substrate is ` +
      `configured for ${expected}. Either re-init with --embedding-model matching ` +
      `the configured dimension, or edit .claude-flow/embeddings.json to match the model.`,
    );
    this.name = 'EmbeddingDimensionMismatchError';
  }
}

// ─── Hardcoded fallback defaults (ADR-0069 / reference-embedding-model) ───

const DEFAULT_MODEL = 'Xenova/all-mpnet-base-v2';
const DEFAULT_DIMENSION = 768;
const DEFAULT_PROVIDER = 'onnx';
const DEFAULT_ALLOW_PAID = false;

// ─── Internals ───

interface RawConfig {
  model?: unknown;
  dimension?: unknown;
  provider?: unknown;
  allowPaidProvider?: unknown;
  embedding?: {
    model?: unknown;
    dimension?: unknown;
    provider?: unknown;
    allowPaidProvider?: unknown;
  };
}

/**
 * Walk up from `start` looking for `.claude-flow/embeddings.json`. Returns
 * parsed JSON or `null` if not found / malformed.
 */
function findEmbeddingsJson(start: string): RawConfig | null {
  let dir = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = join(dir, '.claude-flow', 'embeddings.json');
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, 'utf-8')) as RawConfig;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

// ─── Singleton ───

let _singleton: ConfigChain | null = null;
let _resolvedFromDisk = false;
/**
 * True when an on-disk embeddings.json is present AND has a `model` field
 * present but empty/invalid. Distinguishes "model: ''" (explicit but invalid
 * intent) from "no model field" (caller relying on defaults).
 * validateBoot() rejects only the former.
 */
let _diskModelInvalid = false;

/**
 * Resolve the config chain. First call walks up from cwd; subsequent calls
 * return the cached singleton until `resetConfig()` is called.
 *
 * Per Amendment 2 (2026-05-12): does NOT validate @xenova availability — the
 * existing upstream embedding-init error path handles missing optional deps.
 */
export function getConfig(): ConfigChain {
  if (_singleton) return _singleton;

  const raw = findEmbeddingsJson(process.cwd());
  _resolvedFromDisk = raw !== null;

  // ADR-0070 split: top-level keys are canonical. `embedding.*` nested also
  // accepted for callers writing config.json-shaped objects.
  const embNested = raw?.embedding;
  // Detect the "field present but empty/wrong-typed" case so validateBoot()
  // can distinguish it from the "no model field at all" default-fallback case.
  if (raw !== null) {
    const explicitTop = Object.prototype.hasOwnProperty.call(raw, 'model');
    const explicitNested = embNested != null
      && Object.prototype.hasOwnProperty.call(embNested, 'model');
    if (explicitTop || explicitNested) {
      const rawModel = explicitTop ? raw.model : embNested?.model;
      _diskModelInvalid = !(typeof rawModel === 'string' && rawModel.length > 0);
    }
  }
  const model =
    asString(raw?.model) ??
    asString(embNested?.model) ??
    DEFAULT_MODEL;
  const dimension =
    asNumber(raw?.dimension) ??
    asNumber(embNested?.dimension) ??
    DEFAULT_DIMENSION;
  // Normalise provider: ruflo init writes `transformers.js`; ADR-0177 Phase 1.6
  // (e) gate compares against `onnx`. Both denote local @xenova — treat as such.
  let provider =
    asString(raw?.provider) ??
    asString(embNested?.provider) ??
    DEFAULT_PROVIDER;
  if (provider === 'transformers' || provider === 'transformers.js') {
    provider = 'onnx';
  }
  const allowPaidProvider =
    asBoolean(raw?.allowPaidProvider) ??
    asBoolean(embNested?.allowPaidProvider) ??
    DEFAULT_ALLOW_PAID;

  _singleton = Object.freeze({
    embedding: Object.freeze({ model, dimension, provider, allowPaidProvider }),
  });
  return _singleton;
}

/**
 * True iff getConfig() found `.claude-flow/embeddings.json` on disk (vs.
 * falling back to hardcoded defaults). Used by AgentDB.initialize() to decide
 * whether to throw ConfigChainValidationError for "missing model" — defaults
 * are accepted in test/embedded contexts, but a present-but-empty file is not.
 */
export function isConfigOnDisk(): boolean {
  // Trigger resolve so the flag is set
  getConfig();
  return _resolvedFromDisk;
}

/** Reset for tests. */
export function resetConfig(): void {
  _singleton = null;
  _resolvedFromDisk = false;
  _diskModelInvalid = false;
}

/**
 * Boot-time validation. Throws ConfigChainValidationError if:
 *   - embedding.model is missing AND a config file exists on disk (an
 *     explicitly-present-but-incomplete config is rejected; absence of a
 *     config file falls back to defaults and is allowed for embedded use).
 *   - allowPaidProvider == false AND provider != 'onnx' (per feedback-no-api-keys).
 *
 * Per Amendment 2: does NOT check @xenova availability.
 */
export function validateBoot(chain: ConfigChain = getConfig()): void {
  if (_resolvedFromDisk && _diskModelInvalid) {
    throw new ConfigChainValidationError(
      'embedding.model missing or empty in .claude-flow/embeddings.json. ' +
      'Run `ruflo init` (or `ruflo init --embedding-model <model>`) to regenerate.',
    );
  }
  if (!chain.embedding.allowPaidProvider && chain.embedding.provider !== 'onnx') {
    throw new ConfigChainValidationError(
      `Paid embedding provider "${chain.embedding.provider}" requires ` +
      `embedding.allowPaidProvider=true in .claude-flow/embeddings.json. ` +
      'Per memory feedback-no-api-keys, ruflo runs on the Claude subscription — ' +
      'no API costs. Either switch to provider="onnx" or set allowPaidProvider=true ' +
      'explicitly (and pay your own API bill).',
    );
  }
}

/**
 * Convenience accessor returning plain (non-frozen) shape. Used by
 * `@claude-flow/memory/resolve-config.ts` to layer its full
 * ResolvedConfig (storage / HNSW / learning / graph) on top of the embedding
 * triple without taking a runtime dep on agentdb.
 */
export function getEmbeddingConfig(): {
  model: string | undefined;
  dimension: number;
  provider: string;
  allowPaidProvider: boolean;
} {
  const cfg = getConfig();
  return {
    model: cfg.embedding.model,
    dimension: cfg.embedding.dimension,
    provider: cfg.embedding.provider,
    allowPaidProvider: cfg.embedding.allowPaidProvider,
  };
}
