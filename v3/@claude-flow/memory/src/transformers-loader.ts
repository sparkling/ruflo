/**
 * Provider-agnostic transformers loader.
 *
 * ADR-094: prefer the maintained `@huggingface/transformers` (which
 * pulls in `protobufjs >=7.5.5` and clears the critical RCE CVE
 * chain), fall back to the legacy `@xenova/transformers` for
 * backwards compatibility with consumers who haven't installed the
 * new package yet.
 *
 * ADR-0239 cluster 4 step (a): relocated from the dead
 * `@claude-flow/embeddings` package into `@claude-flow/memory` so the
 * live `EmbeddingPipeline._doInitialize` path picks up the
 * CVE-mitigated loader. The original copy in
 * `v3/@claude-flow/embeddings/src/transformers-loader.ts` is deleted
 * in cluster 4 step (c) together with the rest of the dead package.
 *
 * Both packages export the same `pipeline()` function with compatible
 * signatures for our usage (`pipeline('feature-extraction', modelId)`),
 * so callers can use the returned function transparently. The `source`
 * field is plumbed through `EmbeddingPipeline.getProviderSource()` and
 * surfaced on `embeddings_status.runtime.source` so users can see
 * which package satisfied the runtime — closes F-08-008 in the same
 * commit (per ADR-0239 cluster 4 step (a) confirmation gate).
 */

export type PipelineFn = (
  task: string,
  model?: string,
  options?: Record<string, unknown>,
) => Promise<unknown>;

export interface TransformersHandle {
  pipeline: PipelineFn;
  source: '@huggingface/transformers' | '@xenova/transformers';
  version?: string;
}

let cached: TransformersHandle | null = null;
let cacheChecked = false;

/**
 * Load a working transformers pipeline. Returns null if neither
 * package is installed. Caches the first successful resolution so
 * subsequent calls don't re-import.
 */
export async function loadTransformersPipeline(): Promise<TransformersHandle | null> {
  if (cacheChecked) return cached;
  cacheChecked = true;

  // Use indirect import paths through string variables so TypeScript
  // doesn't try to resolve module types at compile time. Both packages
  // are runtime-optional; types aren't needed for the typed PipelineFn
  // signature we expose.
  const tryLoad = async (specifier: string): Promise<Record<string, unknown> | null> => {
    try {
      // Webpack/tsc can't statically resolve the specifier when it's a
      // variable, which is intentional here — we want runtime resolution
      // that gracefully fails if the package isn't installed.
      const mod = await import(/* @vite-ignore */ specifier);
      return mod as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  // Prefer the maintained successor.
  const hf = await tryLoad('@huggingface/transformers');
  if (hf && typeof hf.pipeline === 'function') {
    cached = {
      pipeline: hf.pipeline as PipelineFn,
      source: '@huggingface/transformers',
      version: typeof hf.version === 'string' ? hf.version : undefined,
    };
    return cached;
  }

  // Fall back to the legacy package so existing installs keep working.
  const xen = await tryLoad('@xenova/transformers');
  if (xen && typeof xen.pipeline === 'function') {
    cached = {
      pipeline: xen.pipeline as PipelineFn,
      source: '@xenova/transformers',
      version: typeof xen.version === 'string' ? xen.version : undefined,
    };
    return cached;
  }

  return null;
}

/**
 * Synchronous probe — returns whether either package was loaded
 * during a previous call to `loadTransformersPipeline()`. For status
 * tools that don't want to trigger a fresh import.
 */
export function getCachedTransformersSource(): TransformersHandle | null {
  return cached;
}
