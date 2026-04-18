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

async function loadRuvllmWasm() {
  return import('../ruvector/ruvllm-wasm.js');
}

// ── Instance Registries (in-process, short-lived) ─────────────────
// One process may create+operate in-memory (fast path). Cross-process
// flows fall back to on-disk persistence + replay (see rebuild* helpers).

type HnswRouter = Awaited<ReturnType<typeof import('../ruvector/ruvllm-wasm.js').createHnswRouter>>;
type SonaInstant = Awaited<ReturnType<typeof import('../ruvector/ruvllm-wasm.js').createSonaInstant>>;
type MicroLora = Awaited<ReturnType<typeof import('../ruvector/ruvllm-wasm.js').createMicroLora>>;

const hnswRouters = new Map<string, HnswRouter>();
const sonaInstances = new Map<string, SonaInstant>();
const loraInstances = new Map<string, MicroLora>();

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
  for (const entry of rec.journal) {
    if (entry.op === 'adapt') {
      lora.adapt(entry.quality, entry.learningRate, entry.success);
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
        const mod = await loadRuvllmWasm();
        const status = await mod.getRuvllmStatus();
        return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
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
        learningRate: { type: 'number', description: 'Learning rate (default: 0.01)' },
        success: { type: 'boolean', description: 'Whether the adaptation was successful (default: true)' },
      },
      required: ['loraId', 'quality'],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const loraId = args.loraId as string;
        const lora = await getOrRebuildMicroLora(loraId);
        if (!lora) return { content: [{ type: 'text', text: JSON.stringify({ error: `MicroLoRA not found: ${loraId}` }) }], isError: true };
        const quality = args.quality as number;
        const learningRate = args.learningRate as number | undefined;
        const success = args.success as boolean | undefined;
        const statsBefore = lora.stats();
        lora.adapt(quality, learningRate, success);
        const statsAfter = lora.stats();
        persistMicroLoraAdapt(loraId, quality, learningRate, success);
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
