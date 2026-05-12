// ADR-0177 Phase 1.6 (b) + (g): canonical known-dimension table for embedding
//   models. Single source of truth consumed by:
//     - `commands/init.ts` (--embedding-model flag validation)
//     - `init/config-template.ts` (default model + dim)
//     - `init/executor.ts` (existing MODEL_DIMS table — superseded by this)
//
//   Full-qualified names required per `feedback-full-model-names.md` /
//   ADR-0069. Never bare names, never runtime prefix prepending.

/**
 * Canonical known-dimension lookup table for ONNX embedding models.
 * Per ADR-0177 Phase 1.6 (b): adding a model means adding a row here so
 * dimension auto-detection + validation share one source.
 */
export const KNOWN_EMBEDDING_MODELS: Readonly<Record<string, number>> = Object.freeze({
  'Xenova/all-mpnet-base-v2': 768,
  'Xenova/bge-base-en-v1.5': 768,
  'Xenova/gte-base': 768,
  'Xenova/all-MiniLM-L6-v2': 384,
  'Xenova/all-MiniLM-L12-v2': 384,
});

/** Default embedding model written into `.claude-flow/config.json` by `ruflo init`. */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-mpnet-base-v2';

/** Default embedding dimension matching DEFAULT_EMBEDDING_MODEL. */
export const DEFAULT_EMBEDDING_DIMENSION = 768;

/**
 * Typed error for unknown / unqualified embedding model names. Surfaces
 * the canonical table so the user can self-correct without digging.
 */
export class EmbeddingModelValidationError extends Error {
  readonly code: 'BARE_NAME' | 'UNKNOWN_MODEL';
  readonly model: string;
  readonly knownModels: ReadonlyArray<string>;

  constructor(args: {
    code: 'BARE_NAME' | 'UNKNOWN_MODEL';
    model: string;
    message: string;
  }) {
    super(args.message);
    this.name = 'EmbeddingModelValidationError';
    this.code = args.code;
    this.model = args.model;
    this.knownModels = Object.freeze(Object.keys(KNOWN_EMBEDDING_MODELS));
  }
}

/**
 * Validate an embedding model name against the canonical known-dim table.
 * Per ADR-0177 Phase 1.6 (b) + (g):
 *  - Bare names (no `Xenova/` or `<org>/` prefix) -> BARE_NAME error
 *  - Unknown qualified names -> UNKNOWN_MODEL error citing the table
 *
 * Returns the resolved `(model, dimension)` pair on success.
 */
export function validateEmbeddingModel(model: string): {
  model: string;
  dimension: number;
} {
  // (g) Full-qualified name guard: reject bare names. The known table only
  //   contains slash-prefixed names; surface the typed error pointing at
  //   feedback-full-model-names.md / ADR-0069.
  if (!model.includes('/')) {
    throw new EmbeddingModelValidationError({
      code: 'BARE_NAME',
      model,
      message:
        `Embedding model "${model}" is not full-qualified. Use the `
        + `"Xenova/..." prefix (see feedback-full-model-names.md / ADR-0069). `
        + `Known models: ${Object.keys(KNOWN_EMBEDDING_MODELS).join(', ')}`,
    });
  }

  const dimension = KNOWN_EMBEDDING_MODELS[model];
  if (dimension === undefined) {
    throw new EmbeddingModelValidationError({
      code: 'UNKNOWN_MODEL',
      model,
      message:
        `Embedding model "${model}" is not in the ADR-0177 Phase 1.6 `
        + `known-dimension table. Add a row to `
        + `src/init/embedding-models.ts#KNOWN_EMBEDDING_MODELS or pick one of: `
        + `${Object.keys(KNOWN_EMBEDDING_MODELS).join(', ')}`,
    });
  }

  return { model, dimension };
}
