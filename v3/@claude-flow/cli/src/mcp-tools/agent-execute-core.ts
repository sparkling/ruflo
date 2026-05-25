/**
 * Shared agent-execution core.
 *
 * Both the agent_execute MCP tool and the workflow runtime (G3) need
 * to dispatch a prompt to an agent's configured Anthropic model. This
 * module factors that path out so it's testable and reusable, and
 * keeps the wire from agent_spawn → ProviderManager (real) in one
 * place rather than duplicated.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from './types.js';

const STORAGE_DIR = '.claude-flow';
const AGENT_DIR = 'agents';
const AGENT_FILE = 'store.json';

type ClaudeModel = 'haiku' | 'sonnet' | 'opus' | 'inherit';

export interface AgentRecord {
  agentId: string;
  agentType: string;
  status: 'idle' | 'busy' | 'terminated';
  health: number;
  taskCount: number;
  config: Record<string, unknown>;
  createdAt: string;
  domain?: string;
  model?: ClaudeModel;
  modelRoutedBy?: 'explicit' | 'router' | 'agent-booster' | 'default';
  lastResult?: Record<string, unknown>;
}

interface AgentStore {
  agents: Record<string, AgentRecord>;
  version: string;
}

function getAgentDir(): string { return join(findProjectRoot(), STORAGE_DIR, AGENT_DIR); }
function getAgentPath(): string { return join(getAgentDir(), AGENT_FILE); }
// `ensureAgentDir` removed (ADR-0181 Phase C): pre-Phase-C only `saveAgentStore`
// needed mkdir; that function is now archivist-owned.
function loadAgentStore(): AgentStore {
  try {
    if (existsSync(getAgentPath())) return JSON.parse(readFileSync(getAgentPath(), 'utf-8'));
  } catch { /* fall through */ }
  return { agents: {}, version: '3.0.0' };
}
// `saveAgentStore` removed in ADR-0181 Phase C wire-up (2026-05-18). All
// writes now flow through archivist.dispatch('agent_execute', ...) — see
// pre-LLM busy reservation + post-LLM idle release dispatches below. The
// archivist handler owns the substrate.withWrite envelope for the
// 'agent_spawn' FS-JSON store.

const MODEL_MAP: Record<string, string> = {
  haiku: 'claude-3-5-haiku-latest',
  sonnet: 'claude-3-5-sonnet-latest',
  opus: 'claude-3-opus-latest',
  inherit: 'claude-3-5-sonnet-latest',
};

export interface AnthropicCallInput {
  prompt: string;
  systemPrompt?: string;
  model?: string;          // already-resolved Anthropic model id (e.g. 'claude-3-5-sonnet-latest')
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface AnthropicCallResult {
  success: boolean;
  model?: string;
  messageId?: string;
  stopReason?: string;
  output?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs?: number;
  error?: string;
}

/**
 * Generic Anthropic Messages API call. No agent registry coupling — used
 * by agent_execute (with the agent's configured model) and by the WASM
 * agent runtime (G4) when the bundled WASM only echoes input.
 *
 * #1725 — falls back to Ollama Cloud (Tier-2, OpenAI-compat) when
 * ANTHROPIC_API_KEY is unset and OLLAMA_API_KEY is present, or when
 * RUFLO_PROVIDER=ollama is explicitly set. Response shape is normalized
 * to the Anthropic-flavored AnthropicCallResult so existing callers
 * don't need to know which provider answered.
 */
export async function callAnthropicMessages(input: AnthropicCallInput): Promise<AnthropicCallResult> {
  const explicitProvider = (process.env.RUFLO_PROVIDER || '').toLowerCase();
  const ollamaKey = process.env.OLLAMA_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  // #2042 — OpenRouter is an OpenAI-compat endpoint that fronts dozens of
  // providers. Reporter (@ummcke00) had `providers.openrouter.apiKey` in
  // their config.yaml but agent_execute hardcoded Anthropic. Detect via
  // explicit RUFLO_PROVIDER=openrouter OR presence of OPENROUTER_API_KEY
  // when no Anthropic key is available (same precedence as the Ollama
  // branch above).
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const useOpenRouter =
    explicitProvider === 'openrouter' || (!anthropicKey && !!openrouterKey);
  const useOllama =
    explicitProvider === 'ollama' || (!anthropicKey && !!ollamaKey && !openrouterKey);

  if (useOpenRouter && openrouterKey) {
    return callOpenAICompat({
      ...input,
      apiKey: openrouterKey,
      baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api',
      providerLabel: 'openrouter',
      defaultModel: process.env.OPENROUTER_DEFAULT_MODEL || 'anthropic/claude-3.5-sonnet',
    });
  }
  if (useOllama && ollamaKey) {
    return callOllamaCompat({ ...input, apiKey: ollamaKey });
  }
  if (!anthropicKey) {
    return {
      success: false,
      error:
        'No LLM provider configured. Set ANTHROPIC_API_KEY (Tier-3), OPENROUTER_API_KEY (#2042), or OLLAMA_API_KEY (Tier-2 — #1725).',
    };
  }
  const model = input.model || 'claude-3-5-sonnet-latest';
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs || 60000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: input.maxTokens || 1024,
        temperature: typeof input.temperature === 'number' ? input.temperature : 0.7,
        ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
        messages: [{ role: 'user', content: input.prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errText = await res.text().catch(() => '<unreadable error body>');
      return { success: false, model, error: `Anthropic API error ${res.status}: ${errText.slice(0, 400)}` };
    }
    const data = await res.json() as {
      id: string;
      model: string;
      content: Array<{ type: string; text?: string }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    const textOut = data.content
      .filter(c => c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text as string)
      .join('');
    return {
      success: true,
      model: data.model,
      messageId: data.id,
      stopReason: data.stop_reason,
      output: textOut,
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      },
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      success: false,
      model,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Ollama Cloud / OpenAI-compat provider — Tier-2 routing per ADR-026 + #1725.
 *
 * Endpoint: https://ollama.com/v1/chat/completions
 * Auth: Authorization: Bearer <OLLAMA_API_KEY>
 *
 * Translates the Anthropic-flavored input shape onto OpenAI chat-completions
 * and translates the response back so callers never see provider-specific
 * fields. Logical model names are mapped to Ollama Cloud defaults:
 *   - 'haiku'  / 'sonnet'  → 'gpt-oss:120b-cloud' (sensible single default)
 *   - 'opus'              → 'gpt-oss:120b-cloud' (no opus tier on Ollama)
 *   - explicit 'ollama:<model>' or bare provider-native name → passed through
 */
async function callOllamaCompat(
  input: AnthropicCallInput & { apiKey: string },
): Promise<AnthropicCallResult> {
  const model = resolveOllamaModel(input.model);
  const startedAt = Date.now();
  // OLLAMA_BASE_URL lets users point at local/self-hosted endpoints
  // (e.g. http://ruvultra:11434, http://localhost:11434) instead of
  // Ollama Cloud. Default is the public cloud endpoint.
  const base = (process.env.OLLAMA_BASE_URL || 'https://ollama.com').replace(/\/+$/, '');
  const url = `${base}/v1/chat/completions`;
  // Self-hosted endpoints typically don't need an Authorization header
  // (the daemon binds to 11434 with no auth by default), but Ollama Cloud
  // does. Send the bearer when the key is non-empty AND looks cloud-shaped.
  const sendAuth = input.apiKey && input.apiKey !== 'local';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs || 60000);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...(sendAuth ? { Authorization: `Bearer ${input.apiKey}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: input.maxTokens || 1024,
        temperature: typeof input.temperature === 'number' ? input.temperature : 0.7,
        messages: [
          ...(input.systemPrompt
            ? [{ role: 'system' as const, content: input.systemPrompt }]
            : []),
          { role: 'user' as const, content: input.prompt },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errText = await res.text().catch(() => '<unreadable error body>');
      return { success: false, model, error: `Ollama API error ${res.status} at ${url}: ${errText.slice(0, 400)}` };
    }
    const data = (await res.json()) as {
      id?: string;
      model?: string;
      choices: Array<{
        message: { role: string; content: string };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    const textOut = data.choices?.[0]?.message?.content ?? '';
    const usage = data.usage ?? {};
    return {
      success: true,
      model: data.model ?? model,
      messageId: data.id ?? `ollama-${Date.now()}`,
      stopReason: data.choices?.[0]?.finish_reason ?? 'end_turn',
      output: textOut,
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      },
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      success: false,
      model,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Generic OpenAI-compat caller for OpenRouter and other OpenAI-shaped
 * endpoints. #2042 — reporter (@ummcke00) configured OpenRouter via
 * config.yaml but agent_execute hardcoded the Anthropic fetch. This is
 * the same shape as `callOllamaCompat` but routes to a configurable
 * baseUrl + sends an OpenRouter-friendly default model when none is
 * specified. Logical model names (haiku/sonnet/opus) pass through —
 * OpenRouter accepts vendor-prefixed names like `anthropic/claude-3.5-sonnet`.
 */
async function callOpenAICompat(
  input: AnthropicCallInput & {
    apiKey: string;
    baseUrl: string;
    providerLabel: string;
    defaultModel: string;
  },
): Promise<AnthropicCallResult> {
  const model = resolveOpenAICompatModel(input.model, input.defaultModel);
  const startedAt = Date.now();
  const base = input.baseUrl.replace(/\/+$/, '');
  const url = `${base}/v1/chat/completions`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs || 60000);
    const messages: Array<{ role: string; content: string }> = [];
    if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt });
    messages.push({ role: 'user', content: input.prompt });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
        // OpenRouter convention: identify the integrating app for analytics
        // and rate-limit tiering. Harmless on other OpenAI-compat backends.
        'HTTP-Referer': 'https://github.com/ruvnet/ruflo',
        'X-Title': 'Ruflo',
      },
      body: JSON.stringify({
        model,
        max_tokens: input.maxTokens || 1024,
        temperature: typeof input.temperature === 'number' ? input.temperature : 0.7,
        messages,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errText = await res.text().catch(() => '<unreadable error body>');
      return { success: false, model, error: `${input.providerLabel} API error ${res.status}: ${errText.slice(0, 400)}` };
    }
    const data = await res.json() as {
      id?: string;
      model?: string;
      choices: Array<{ message: { content: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const textOut = data.choices?.[0]?.message?.content ?? '';
    const usage = data.usage ?? {};
    return {
      success: true,
      model: data.model || model,
      messageId: data.id,
      stopReason: data.choices?.[0]?.finish_reason ?? 'end_turn',
      output: textOut,
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      },
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      success: false,
      model,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

function resolveOpenAICompatModel(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  // Logical Claude names → OpenRouter Anthropic-vendored names
  if (input === 'haiku') return 'anthropic/claude-3.5-haiku';
  if (input === 'sonnet' || input === 'inherit') return 'anthropic/claude-3.5-sonnet';
  if (input === 'opus') return 'anthropic/claude-3-opus';
  return input;
}

function resolveOllamaModel(input: string | undefined): string {
  const DEFAULT = 'gpt-oss:120b-cloud';
  if (!input) return DEFAULT;
  // Logical → cloud default
  if (input === 'haiku' || input === 'sonnet' || input === 'opus' || input === 'inherit') {
    return DEFAULT;
  }
  // Explicit provider prefix
  if (input.startsWith('ollama:')) return input.slice('ollama:'.length);
  // Bare name with cloud suffix (e.g. 'llama3:70b-cloud') passes through
  return input;
}

/**
 * Resolve a model identifier to an Anthropic model ID. Accepts:
 * - logical names: 'haiku', 'sonnet', 'opus', 'inherit'
 * - prefixed: 'anthropic:claude-3-5-sonnet-latest'
 * - direct: 'claude-3-5-sonnet-latest'
 */
export function resolveAnthropicModel(input: string | undefined): string {
  if (!input) return 'claude-3-5-sonnet-latest';
  if (input in MODEL_MAP) return MODEL_MAP[input];
  if (input.startsWith('anthropic:')) return input.slice('anthropic:'.length);
  return input;
}

export interface AgentExecuteInput {
  agentId: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface AgentExecuteResult {
  success: boolean;
  agentId: string;
  model?: string;
  messageId?: string;
  stopReason?: string;
  output?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs?: number;
  error?: string;
  remediation?: string;
}

export async function executeAgentTask(input: AgentExecuteInput): Promise<AgentExecuteResult> {
  // ADR-0181 Phase C (2026-05-18): three saveAgentStore() raw fs writes
  // (pre-LLM busy reservation, post-success idle release, post-error idle
  // release) now flip through archivist.dispatch('agent_execute', ...) for
  // audit-chain enrolment. The fs writes themselves remain owned by the
  // dispatched handler's substrate.withWrite envelope (FS-JSON store
  // 'agent_spawn'). Pre-existence check stays in cli (legacy "Agent not
  // found" envelope at agent-tools.ts:373-378 already uses loadAgentStore
  // for this; mirroring the same pre-check pattern here keeps the
  // "Agent not found" / "Agent has been terminated" envelopes returning
  // before any dispatch overhead).
  //
  // #2042 (2026-05-21): the apiKey / ANTHROPIC_API_KEY early-return that
  // used to live here was removed so executeAgentTask delegates to
  // callAnthropicMessages, which dispatches to Anthropic / OpenRouter /
  // Ollama based on env vars and config.yaml. The "no provider
  // configured" envelope is now surfaced from the router's reply.
  const store = loadAgentStore();
  const agent = store.agents[input.agentId];
  if (!agent) return { success: false, agentId: input.agentId, error: 'Agent not found' };
  if (agent.status === 'terminated') return { success: false, agentId: input.agentId, error: 'Agent has been terminated' };

  const anthropicModel = MODEL_MAP[agent.model || 'sonnet'] || 'claude-3-5-sonnet-latest';
  const systemPrompt = input.systemPrompt ||
    `You are a ${agent.agentType} agent operating as part of a Ruflo swarm. ` +
    `Agent ID: ${input.agentId}. Domain: ${agent.domain ?? 'general'}. ` +
    `Respond directly and stay focused on the task. If you need information you don't have, state that explicitly.`;

  // Pre-LLM busy reservation — one audit-traced mutation. taskCountDelta:1
  // bumps the count; lastResult omitted so any prior execution's result
  // remains visible until the new one lands.
  const { getProcessArchivist } = await import('../memory/archivist-init.js');
  const archivist = await getProcessArchivist();
  await archivist.dispatch('agent_execute', {
    agentId: input.agentId,
    status: 'busy',
    taskCountDelta: 1,
  });

  const startedAt = Date.now();

  // #2042 — delegate to callAnthropicMessages so the v3 provider router
  // (Anthropic / Ollama / OpenRouter) governs which backend is hit. The
  // previous inline `fetch('https://api.anthropic.com/...')` bypassed
  // the router entirely and forced an ANTHROPIC_API_KEY error for every
  // non-Anthropic deployment. Reporter (@ummcke00) had OpenRouter
  // configured but the bypass made the agent unreachable.
  const result = await callAnthropicMessages({
    model: anthropicModel,
    prompt: input.prompt,
    systemPrompt,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    timeoutMs: input.timeoutMs,
  });

  if (result.success) {
    const out: AgentExecuteResult = {
      success: true,
      agentId: input.agentId,
      messageId: result.messageId,
      model: result.model,
      stopReason: result.stopReason,
      output: result.output,
      usage: result.usage,
      durationMs: result.durationMs ?? Date.now() - startedAt,
    };

    // Post-LLM idle release (success) — second audit-traced mutation.
    // lastResult set to the new result.
    await archivist.dispatch('agent_execute', {
      agentId: input.agentId,
      status: 'idle',
      lastResult: out as unknown as Record<string, unknown>,
    });

    return out;
  }

  // Post-LLM idle release (failure path) — second audit-traced mutation.
  // taskCountDelta omitted (defaults to 0); count was already bumped at
  // reservation. lastResult also omitted on error path — preserves the
  // previous successful result so a transient API failure doesn't
  // erase the last good output.
  await archivist.dispatch('agent_execute', {
    agentId: input.agentId,
    status: 'idle',
  });

  // No-provider-configured error → surface the same actionable message
  // the router built, with a #2042-aware remediation pointer.
  const noProvider = (result.error || '').includes('No LLM provider configured');
  return {
    success: false,
    agentId: input.agentId,
    model: anthropicModel,
    error: result.error || 'agent_execute failed',
    durationMs: result.durationMs ?? Date.now() - startedAt,
    ...(noProvider && {
      remediation:
        'Set one of ANTHROPIC_API_KEY, OPENROUTER_API_KEY (+ optional OPENROUTER_BASE_URL), or OLLAMA_API_KEY. ' +
        'Or set RUFLO_PROVIDER=openrouter|ollama to force a specific provider.',
    }),
  };
}

