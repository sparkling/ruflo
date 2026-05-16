/**
 * ADR-0182 lever L13(a): writer-layer unit tests for the embedding
 * config chain.
 *
 * Sister test file: `phase1-6-init-embedding.test.ts`. That suite covers the
 * canonical Phase 1.6 (a)/(b)/(g) cases plus integration via `executeInit`.
 * This file is the L13(a) writer-layer addendum that:
 *
 *   1. Asserts `validateEmbeddingModel` returns the canonical `(model,
 *      dimension)` pair for ALL 5 rows of KNOWN_EMBEDDING_MODELS in a single
 *      parametric pass (positive cases).
 *   2. Round-trips EVERY one of those 5 models through the config-emitter
 *      (`getMinimalConfigTemplate` and `getFullConfigTemplate`), asserting
 *      `embedding.model` and `embedding.dimension` in the emitted object
 *      exactly match the validator's resolved pair. The sister suite only
 *      round-trips 2 of the 5 (default + a single MiniLM-L6 override); L13(a)
 *      requires all 5 so the acceptance corpus can drop the per-model init
 *      invocations in adr0177 (L13(b) follow-up).
 *   3. Negative cases: BARE_NAME + UNKNOWN_MODEL via `validateEmbeddingModel`,
 *      typed-error code + identity checks (per ADR-0177 Phase 1.6 (g) + (b)).
 *
 * Pure-function only — no temp dirs, no `executeInit`, no I/O. The integration
 * surface lives in the sister suite + the L13(b) acceptance layer.
 *
 * Per memory `feedback-no-fallbacks` / `feedback-no-squelch-tests`: every
 * assertion exercises the real exported function. No mocks.
 */

import { describe, it, expect } from 'vitest';
import {
  KNOWN_EMBEDDING_MODELS,
  validateEmbeddingModel,
  EmbeddingModelValidationError,
} from '../src/init/embedding-models.js';
import {
  getMinimalConfigTemplate,
  getFullConfigTemplate,
} from '../src/init/config-template.js';

// Single source of truth for the 5 ADR-0177 Phase 1.6 rows. Test data is
// duplicated from the production table on purpose so an accidental edit to
// `KNOWN_EMBEDDING_MODELS` fails this test loudly rather than silently
// re-baselining itself.
const KNOWN_MODEL_ROWS: ReadonlyArray<readonly [string, number]> = [
  ['Xenova/all-mpnet-base-v2', 768],
  ['Xenova/bge-base-en-v1.5', 768],
  ['Xenova/gte-base', 768],
  ['Xenova/all-MiniLM-L6-v2', 384],
  ['Xenova/all-MiniLM-L12-v2', 384],
] as const;

describe('ADR-0182 L13(a): validateEmbeddingModel — all 5 rows return canonical pair', () => {
  it('test data mirrors KNOWN_EMBEDDING_MODELS exactly (drift guard)', () => {
    const tableKeys = Object.keys(KNOWN_EMBEDDING_MODELS).sort();
    const rowKeys = KNOWN_MODEL_ROWS.map(([m]) => m).sort();
    expect(rowKeys).toEqual(tableKeys);
    for (const [model, dim] of KNOWN_MODEL_ROWS) {
      expect(KNOWN_EMBEDDING_MODELS[model]).toBe(dim);
    }
  });

  it.each(KNOWN_MODEL_ROWS)(
    'validateEmbeddingModel("%s") returns { model, dimension: %i }',
    (model, expectedDim) => {
      const result = validateEmbeddingModel(model);
      expect(result.model).toBe(model);
      expect(result.dimension).toBe(expectedDim);
    },
  );
});

describe('ADR-0182 L13(a): config-emitter round-trip — minimal template, all 5 rows', () => {
  it.each(KNOWN_MODEL_ROWS)(
    'getMinimalConfigTemplate({model: "%s", dim: %i}) emits matching embedding.{model,dimension}',
    (model, dim) => {
      // Resolve via the canonical validator first so the round-trip exercises
      // the same `(model, dim)` pair downstream consumers will see.
      const resolved = validateEmbeddingModel(model);
      const tpl = getMinimalConfigTemplate({
        embeddingModel: resolved.model,
        embeddingDim: resolved.dimension,
      });
      const embedding = tpl.embedding as Record<string, unknown>;
      expect(embedding.model).toBe(model);
      expect(embedding.dimension).toBe(dim);
      // Other Phase 1.6 (a) embedding keys must keep their defaults — the
      // override mechanism only flows (model, dimension).
      expect(embedding.provider).toBe('onnx');
      expect(embedding.allowPaidProvider).toBe(false);
    },
  );
});

describe('ADR-0182 L13(a): config-emitter round-trip — full template, all 5 rows', () => {
  it.each(KNOWN_MODEL_ROWS)(
    'getFullConfigTemplate({model: "%s", dim: %i}) emits matching embedding.{model,dimension}',
    (model, dim) => {
      const resolved = validateEmbeddingModel(model);
      const tpl = getFullConfigTemplate({
        embeddingModel: resolved.model,
        embeddingDim: resolved.dimension,
      });
      const embedding = tpl.embedding as Record<string, unknown>;
      expect(embedding.model).toBe(model);
      expect(embedding.dimension).toBe(dim);
      expect(embedding.provider).toBe('onnx');
      expect(embedding.allowPaidProvider).toBe(false);
    },
  );
});

describe('ADR-0182 L13(a): negative cases — bare names and unknown qualified names', () => {
  // Bare names = no `org/` prefix. Per ADR-0177 Phase 1.6 (g) + ADR-0069 /
  // `feedback-full-model-names.md`, these must be rejected with BARE_NAME so
  // callers cannot silently degrade to a runtime-prepended `Xenova/` prefix.
  it.each([
    'all-mpnet-base-v2',
    'bge-base-en-v1.5',
    'gte-base',
    'all-MiniLM-L6-v2',
    'all-MiniLM-L12-v2',
  ])('validateEmbeddingModel("%s") throws EmbeddingModelValidationError code=BARE_NAME', (bare) => {
    expect(() => validateEmbeddingModel(bare)).toThrow(EmbeddingModelValidationError);
    try {
      validateEmbeddingModel(bare);
      throw new Error('validateEmbeddingModel did not throw for bare name');
    } catch (e) {
      expect(e).toBeInstanceOf(EmbeddingModelValidationError);
      const err = e as EmbeddingModelValidationError;
      expect(err.code).toBe('BARE_NAME');
      expect(err.model).toBe(bare);
      // The 5 canonical model names must appear in `knownModels` so the user
      // can self-correct without digging.
      expect(err.knownModels.length).toBe(KNOWN_MODEL_ROWS.length);
    }
  });

  // Qualified-but-unknown = has `/` prefix but not in KNOWN_EMBEDDING_MODELS.
  // Per ADR-0177 Phase 1.6 (b), must surface UNKNOWN_MODEL with a pointer to
  // the canonical table source so the user can extend it or pick from it.
  it.each([
    'Xenova/does-not-exist',
    'OpenAI/text-embedding-3-small',
    'sentence-transformers/all-mpnet-base-v2',
    'BAAI/bge-large-en-v1.5',
  ])('validateEmbeddingModel("%s") throws EmbeddingModelValidationError code=UNKNOWN_MODEL', (unknown) => {
    expect(() => validateEmbeddingModel(unknown)).toThrow(EmbeddingModelValidationError);
    try {
      validateEmbeddingModel(unknown);
      throw new Error('validateEmbeddingModel did not throw for unknown qualified name');
    } catch (e) {
      expect(e).toBeInstanceOf(EmbeddingModelValidationError);
      const err = e as EmbeddingModelValidationError;
      expect(err.code).toBe('UNKNOWN_MODEL');
      expect(err.model).toBe(unknown);
      expect(err.knownModels.length).toBe(KNOWN_MODEL_ROWS.length);
    }
  });
});
