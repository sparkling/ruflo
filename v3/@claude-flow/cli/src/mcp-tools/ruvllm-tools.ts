/**
 * RuVector LLM WASM MCP Tools
 *
 * Exposes @ruvector/ruvllm-wasm operations via MCP protocol.
 * All tools gracefully degrade when the WASM package is not installed.
 *
 * W2-I2: Router/SONA/MicroLoRA state is persisted under
 * `.claude-flow/ruvllm/{hnsw,sona,microlora}-store.json` so that a
 * create-then-operate lifecycle survives across one-shot `cli mcp exec`
 * process boundaries. See ruvllm-store.ts for the journal/replay design.
 */

import type { MCPTool } from './types.js';
import { validateIdentifier, validateText } from './validate-input.js';
import type { ChatMessage } from '../ruvector/ruvllm-wasm.js';
import {
  persistHnswCreate,
  persistHnswAdd,
  getHnswRecord,
  persistSonaCreate,
  persistSonaAdapt,
  getSonaRecord,
  persistMicroLoraCreate,
  persistMicroLoraAdapt,
  getMicroLoraRecord,
} from './ruvllm-store.js';
import { BoundedLRU } from '../utils/bounded-lru.js';

// #2086 — every ruvllm_* MCP handler that touches the WASM runtime calls
// this. The downstream `createSonaInstant`/`createMicroLora`/`createHnswRouter`
// helpers all need `initSync({ module: wasmBytes })` to have run, otherwise
// the WASM exports throw. Doing it here makes the bootstrap invisible to
// MCP callers — they don't need a separate `ruvllm_init` tool. `_wasmReady`
// inside `initRuvllmWasm` short-circuits on the second+ call, so the cost
// after the first invocation is one boolean check.
//
// `ruvllm_status` deliberately uses `loadRuvllmWasmModule()` (no init) so a
// caller diagnosing why nothing works gets `initialized=false` instead of
// an error from a failed init.
async function loadRuvllmWasm() {
  const mod = await loadRuvllmWasmModule();
  await mod.initRuvllmWasm();
  return mod;
}

async function loadRuvllmWasmModule() {
  return import('../ruvector/ruvllm-wasm.js');
}

// ── Instance Registries (in-process, short-lived) ─────────────────
// One process may create+operate in-memory (fast path). Cross-process
// flows fall back to on-disk persistence + replay (see rebuild* helpers).
//
// ADR-0243 F-10-001: bounded LRU with dispose probe.
// Pre-ADR-0243: three plain `new Map<string, ...>()` accumulated a
// NAPI/WASM-backed handle for every distinct id ever seen, with no LRU,
// no TTL, no eviction. The WASM heap + Float32Array memory grew for the
// process lifetime (critical on the MCP-stdio server). The bounded LRU
// + dispose probe (destroy/free/dispose in priority order) closes both
// the JS-Map leak AND the underlying WASM-heap leak; see ADR-0243
// §Critique Expert 1.
//
// Cap is `CLAUDE_FLOW_RUVLLM_CACHE_MAX` (default 64) per ADR-0243
// §Decision F-10-001. The default tracks the HiveLRU shape with a
// smaller cap (WASM handles are heavier than HiveState entries).

type HnswRouter = Awaited<ReturnType<typeof import('../ruvector/ruvllm-wasm.js').createHnswRouter>>;
type SonaInstant = Awaited<ReturnType<typeof import('../ruvector/ruvllm-wasm.js').createSonaInstant>>;
type MicroLora = Awaited<ReturnType<typeof import('../ruvector/ruvllm-wasm.js').createMicroLora>>;

const RUVLLM_CACHE_MAX = BoundedLRU.readEnvMax('CLAUDE_FLOW_RUVLLM_CACHE_MAX', 64);

const hnswRouters = new BoundedLRU<string, HnswRouter>({ maxEntries: RUVLLM_CACHE_MAX });
const sonaInstances = new BoundedLRU<string, SonaInstant>({ maxEntries: RUVLLM_CACHE_MAX });
const loraInstances = new BoundedLRU<string, MicroLora>({ maxEntries: RUVLLM_CACHE_MAX });

// ── Replay helpers ────────────────────────────────────────────────

async function rebuildHnswRouter(id: string): Promise<HnswRouter | undefined> {
  const rec = getHnswRecord(id);
  if (!rec) return undefined;
  const mod = await loadRuvllmWasm();
  const router = await mod.createHnswRouter(rec.config);
  // Replay journal
  for (const entry of rec.journal) {
    if (entry.op === 'add') {
      router.addPattern({
        name: entry.name,
        embedding: new Float32Array(entry.embedding),
        metadata: entry.metadata,
      });
    }
  }
  hnswRouters.set(id, router);
  return router;
}

async function rebuildSona(id: string): Promise<SonaInstant | undefined> {
  const rec = getSonaRecord(id);
  if (!rec) return undefined;
  const mod = await loadRuvllmWasm();
  const sona = await mod.createSonaInstant(rec.config);
  for (const entry of rec.journal) {
    if (entry.op === 'adapt') {
      sona.adapt(entry.quality);
    } else if (entry.op === 'recordPattern') {
      sona.recordPattern(entry.embedding, entry.success);
    }
  }
  sonaInstances.set(id, sona);
  return sona;
}

async function rebuildMicroLora(id: string): Promise<MicroLora | undefined> {
  const rec = getMicroLoraRecord(id);
  if (!rec) return undefined;
  const mod = await loadRuvllmWasm();
  const lora = await mod.createMicroLora(rec.config);
  for (let i = 0; i < rec.journal.length; i++) {
    const entry = rec.journal[i];
    if (entry.op === 'adapt') {
      if (!('input' in entry) || entry.input === undefined) {
        // ADR-0231 gap #1: legacy adapt entries lack input field. They predate
        // the per-call input requirement and were mathematically no-ops (the
        // pre-fork zero-input bug). Skip on replay; lose no real adaptation.
        console.warn(
          `microlora replay: skipping legacy adapt entry for loraId=${id} index=${i} (no input field; pre-ADR-0231)`,
        );
        continue;
      }
      lora.adapt(
        Float32Array.from(entry.input),
        entry.quality,
        entry.learningRate,
        entry.success,
        entry.consolidate ?? true,
      );
    }
  }
  loraInstances.set(id, lora);
  return lora;
}

// Registry lookup with disk fallback
async function getOrRebuildHnsw(id: string): Promise<HnswRouter | undefined> {
  return hnswRouters.get(id) ?? (await rebuildHnswRouter(id));
}
async function getOrRebuildSona(id: string): Promise<SonaInstant | undefined> {
  return sonaInstances.get(id) ?? (await rebuildSona(id));
}
async function getOrRebuildMicroLora(id: string): Promise<MicroLora | undefined> {
  return loraInstances.get(id) ?? (await rebuildMicroLora(id));
}

export const ruvllmWasmTools: MCPTool[] = [
  {
    name: 'ruvllm_status',
    description: 'Get ruvllm-wasm availability and initialization status.',
    inputSchema: { type: 'object' as const, properties: {} },
    handler: async () => {
      try {
        const mod = await loadRuvllmWasmModule();
        const wasmStatus = await mod.getRuvllmStatus();

        // Also include native ruvllm CJS backend status (ADR-086).
        // ADR-0191 Cluster A: these are same-package internal imports —
        // MODULE_NOT_FOUND is impossible. Any throw here is a real init bug
        // (state read inside getIntelligenceStats/getSONAStats) and must
        // surface, not get folded into "not initialized yet".
        const { getIntelligenceStats } = await import('../memory/intelligence.js');
        const iStats = getIntelligenceStats();
        const { getSONAStats } = await import('../memory/sona-optimizer.js');
        const sStats = await getSONAStats();
        const nativeBackend: Record<string, unknown> = {
          available: iStats._ruvllmBackend === 'active',
          coordinator: iStats._ruvllmBackend || 'unavailable',
          trajectories: iStats._ruvllmTrajectories || 0,
          contrastiveTrainer: sStats._contrastiveTrainer !== 'unavailable' ? 'active' : 'unavailable',
          trainingBackend: iStats._trainingBackend || 'unknown',
        };

        // Graph database status (ADR-087). Same-package internal import.
        const { getGraphStats } = await import('../ruvector/graph-backend.js');
        const gs = await getGraphStats();
        const graphStatus: Record<string, unknown> = { available: gs.backend === 'graph-node', ...gs };

        return { content: [{ type: 'text', text: JSON.stringify({ wasm: wasmStatus, native: nativeBackend, graph: graphStatus }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'ruvllm_hnsw_create',
    description: 'Create a WASM HNSW router for semantic pattern routing. State persists under .claude-flow/ruvllm/.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dimensions: { type: 'number', description: 'Embedding dimensions (e.g., 64, 128, 384)' },
        maxPatterns: { type: 'number', description: 'Max patterns capacity (limit ~1024 in v2.0.2)' },
        efSearch: { type: 'number', description: 'HNSW ef search parameter (higher = more accurate, slower)' },
      },
      required: ['dimensions', 'maxPatterns'],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const mod = await loadRuvllmWasm();
        const dimensions = args.dimensions as number;
        const maxPatterns = args.maxPatterns as number;
        const efSearch = args.efSearch as number | undefined;
        const router = await mod.createHnswRouter({ dimensions, maxPatterns, efSearch });
        const id = `hnsw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        hnswRouters.set(id, router);
        persistHnswCreate(id, { dimensions, maxPatterns, efSearch });
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, routerId: id, dimensions, maxPatterns, persisted: true }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'ruvllm_hnsw_add',
    description: 'Add a pattern to an HNSW router. Embedding must match router dimensions. Persists across processes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        routerId: { type: 'string', description: 'HNSW router ID from ruvllm_hnsw_create' },
        name: { type: 'string', description: 'Pattern name/label' },
        embedding: { type: 'array', items: { type: 'number' }, description: 'Float array embedding vector' },
        metadata: { type: 'object', description: 'Optional metadata object' },
      },
      required: ['routerId', 'name', 'embedding'],
    },
    handler: async (args: Record<string, unknown>) => {
      { const v = validateIdentifier(args.routerId, 'routerId'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
      { const v = validateIdentifier(args.name, 'name'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
      try {
        const routerId = args.routerId as string;
        const router = await getOrRebuildHnsw(routerId);
        if (!router) return { content: [{ type: 'text', text: JSON.stringify({ error: `Router not found: ${routerId}` }) }], isError: true };
        const embeddingArr = args.embedding as number[];
        const ok = router.addPattern({
          name: args.name as string,
          embedding: new Float32Array(embeddingArr),
          metadata: args.metadata as Record<string, unknown>,
        });
        if (ok) {
          persistHnswAdd(
            routerId,
            args.name as string,
            embeddingArr,
            args.metadata as Record<string, unknown> | undefined,
          );
        }
        return { content: [{ type: 'text', text: JSON.stringify({ success: ok, patternCount: router.patternCount() }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'ruvllm_hnsw_route',
    description: 'Route a query embedding to nearest patterns in HNSW index. Reads persisted state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        routerId: { type: 'string', description: 'HNSW router ID' },
        query: { type: 'array', items: { type: 'number' }, description: 'Query embedding vector' },
        k: { type: 'number', description: 'Number of nearest neighbors (default: 3)' },
      },
      required: ['routerId', 'query'],
    },
    handler: async (args: Record<string, unknown>) => {
      { const v = validateIdentifier(args.routerId, 'routerId'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
      try {
        const routerId = args.routerId as string;
        const router = await getOrRebuildHnsw(routerId);
        if (!router) return { content: [{ type: 'text', text: JSON.stringify({ error: `Router not found: ${routerId}` }) }], isError: true };
        const query = new Float32Array(args.query as number[]);
        const results = router.route(query, (args.k as number) ?? 3);
        return { content: [{ type: 'text', text: JSON.stringify({ results, patternCount: router.patternCount() }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'ruvllm_sona_create',
    description: 'Create a SONA instant adaptation loop (<1ms adaptation cycles). State persists under .claude-flow/ruvllm/.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        hiddenDim: { type: 'number', description: 'Hidden dimension (default: 64)' },
        learningRate: { type: 'number', description: 'Learning rate (default: 0.01)' },
        patternCapacity: { type: 'number', description: 'Max stored patterns' },
      },
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const mod = await loadRuvllmWasm();
        const config = {
          hiddenDim: args.hiddenDim as number | undefined,
          learningRate: args.learningRate as number | undefined,
          patternCapacity: args.patternCapacity as number | undefined,
        };
        const sona = await mod.createSonaInstant(config);
        const id = `sona-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        sonaInstances.set(id, sona);
        persistSonaCreate(id, config);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, sonaId: id, persisted: true }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'ruvllm_sona_adapt',
    description: 'Run SONA instant adaptation with a quality signal. Persists across processes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sonaId: { type: 'string', description: 'SONA instance ID' },
        quality: { type: 'number', description: 'Quality signal (0.0-1.0)' },
      },
      required: ['sonaId', 'quality'],
    },
    handler: async (args: Record<string, unknown>) => {
      { const v = validateIdentifier(args.sonaId, 'sonaId'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
      try {
        const sonaId = args.sonaId as string;
        const sona = await getOrRebuildSona(sonaId);
        if (!sona) return { content: [{ type: 'text', text: JSON.stringify({ error: `SONA not found: ${sonaId}` }) }], isError: true };
        const quality = args.quality as number;
        const statsBefore = sona.stats();
        sona.adapt(quality);
        const statsAfter = sona.stats();
        persistSonaAdapt(sonaId, quality);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, stats: statsAfter, statsChanged: statsBefore !== statsAfter }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'ruvllm_microlora_create',
    description: 'Create a MicroLoRA adapter (ultra-lightweight LoRA, ranks 1-4). State persists under .claude-flow/ruvllm/.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        inputDim: { type: 'number', description: 'Input dimension' },
        outputDim: { type: 'number', description: 'Output dimension' },
        rank: { type: 'number', description: 'LoRA rank (1-4, default: 2)' },
        alpha: { type: 'number', description: 'LoRA alpha scaling (default: 1.0)' },
      },
      required: ['inputDim', 'outputDim'],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const mod = await loadRuvllmWasm();
        const config = {
          inputDim: args.inputDim as number,
          outputDim: args.outputDim as number,
          rank: args.rank as number | undefined,
          alpha: args.alpha as number | undefined,
        };
        const lora = await mod.createMicroLora(config);
        const id = `lora-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        loraInstances.set(id, lora);
        persistMicroLoraCreate(id, config);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, loraId: id, persisted: true }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'ruvllm_microlora_adapt',
    description: 'Adapt MicroLoRA weights with quality feedback. Persists across processes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        loraId: { type: 'string', description: 'MicroLoRA instance ID' },
        quality: { type: 'number', description: 'Quality signal (0.0-1.0)' },
        input: { type: 'array', items: { type: 'number' }, description: 'Input embedding vector (length must match the LoRA instance inputDim)' },
        learningRate: { type: 'number', description: 'Learning rate (default: 0.01)' },
        success: { type: 'boolean', description: 'Whether the adaptation was successful (default: true)' },
        consolidate: { type: 'boolean', description: 'Apply EWC++ catastrophic-forgetting protection (default: true)' },
      },
      required: ['loraId', 'quality', 'input'],
    },
    handler: async (args: Record<string, unknown>) => {
      { const v = validateIdentifier(args.loraId, 'loraId'); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
      try {
        const loraId = args.loraId as string;
        const lora = await getOrRebuildMicroLora(loraId);
        if (!lora) return { content: [{ type: 'text', text: JSON.stringify({ error: `MicroLoRA not found: ${loraId}` }) }], isError: true };
        const quality = args.quality as number;
        const learningRate = args.learningRate as number | undefined;
        const success = args.success as boolean | undefined;
        const inputArr = args.input as number[];
        const input = Float32Array.from(inputArr);
        const consolidate = (args.consolidate as boolean | undefined) ?? true;
        const statsBefore = lora.stats();
        lora.adapt(input, quality, learningRate, success, consolidate);
        const statsAfter = lora.stats();
        persistMicroLoraAdapt(loraId, quality, inputArr, learningRate, success, consolidate);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, stats: statsAfter, statsChanged: statsBefore !== statsAfter }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'ruvllm_chat_format',
    description: 'Format chat messages using a template (llama3, mistral, chatml, phi, gemma, or auto-detect).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messages: {
          type: 'array',
          items: { type: 'object', properties: { role: { type: 'string' }, content: { type: 'string' } }, required: ['role', 'content'] },
          description: 'Array of {role, content} message objects',
        },
        template: { type: 'string', description: 'Template preset (llama3, mistral, chatml, phi, gemma) or model ID for auto-detection' },
      },
      required: ['messages', 'template'],
    },
    handler: async (args: Record<string, unknown>) => {
      { const v = validateText(args.template, 'template', 256); if (!v.valid) return { content: [{ type: 'text', text: JSON.stringify({ error: v.error }) }], isError: true }; }
      try {
        const mod = await loadRuvllmWasm();
        const messages = args.messages as ChatMessage[];
        const templateStr = args.template as string;

        const presets = ['llama3', 'mistral', 'chatml', 'phi', 'gemma'];
        const template = presets.includes(templateStr)
          ? templateStr as any
          : { modelId: templateStr };

        const formatted = await mod.formatChat(messages, template);
        return { content: [{ type: 'text', text: formatted }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
  {
    name: 'ruvllm_generate_config',
    description: 'Create a generation config (maxTokens, temperature, topP, etc.) as JSON.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        maxTokens: { type: 'number', description: 'Max tokens to generate' },
        temperature: { type: 'number', description: 'Sampling temperature (note: f32 precision)' },
        topP: { type: 'number', description: 'Top-p sampling' },
        topK: { type: 'number', description: 'Top-k sampling' },
        repetitionPenalty: { type: 'number', description: 'Repetition penalty' },
        stopSequences: { type: 'array', items: { type: 'string' }, description: 'Stop sequences' },
      },
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const mod = await loadRuvllmWasm();
        const config = await mod.createGenerateConfig(args as any);
        return { content: [{ type: 'text', text: config }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }], isError: true };
      }
    },
  },
];
