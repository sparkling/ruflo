/**
 * Tests for the canonical validated config.json accessor (ADR-0224).
 *
 * The accessor wraps the substrate's previous `JSON.parse(readFileSync('.claude-flow/config.json'))`
 * pattern with Zod validation: malformed config throws loud (no silent fallback);
 * missing config falls back to defaults (embedded use is still supported).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getValidatedConfig,
  resetConfigCache,
  type RuntimeConfig,
} from '../src/core/config/accessor.js';

describe('config accessor (ADR-0224)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'config-accessor-'));
    mkdirSync(join(tempDir, '.claude-flow'), { recursive: true });
    resetConfigCache();
  });

  afterEach(() => {
    resetConfigCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeConfig(content: unknown): void {
    writeFileSync(
      join(tempDir, '.claude-flow', 'config.json'),
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    );
  }

  it('returns the parsed config when valid', () => {
    writeConfig({
      version: '3.0.0',
      memory: { similarityThreshold: 0.65, cleanupIntervalMs: 30000 },
      neural: { defaultLearningRate: 0.005 },
    });

    const cfg = getValidatedConfig({ cwd: tempDir });

    expect(cfg.memory?.similarityThreshold).toBe(0.65);
    expect(cfg.memory?.cleanupIntervalMs).toBe(30000);
    expect(cfg.neural?.defaultLearningRate).toBe(0.005);
  });

  it('returns defaults when no config.json exists (embedded use)', () => {
    // No config file written
    const cfg = getValidatedConfig({ cwd: tempDir });

    expect(cfg).toBeDefined();
    expect(cfg.memory).toBeUndefined();
    expect(cfg.neural).toBeUndefined();
  });

  it('throws when config.json is structurally invalid JSON', () => {
    writeConfig('{ invalid json');
    expect(() => getValidatedConfig({ cwd: tempDir })).toThrow(/config\.json/);
  });

  it('throws when a typed key has the wrong type (string where number expected)', () => {
    writeConfig({
      memory: { similarityThreshold: 'not-a-number' },
    });

    expect(() => getValidatedConfig({ cwd: tempDir })).toThrow(/similarityThreshold/);
  });

  it('throws when nested learning rate has the wrong type', () => {
    writeConfig({
      neural: { learningRates: { qLearning: 'wrong' } },
    });

    expect(() => getValidatedConfig({ cwd: tempDir })).toThrow();
  });

  it('caches the resolved config; resetConfigCache() forces re-read', () => {
    writeConfig({ memory: { similarityThreshold: 0.7 } });
    const cfg1 = getValidatedConfig({ cwd: tempDir });
    expect(cfg1.memory?.similarityThreshold).toBe(0.7);

    // Re-write with new value
    writeConfig({ memory: { similarityThreshold: 0.9 } });
    const cfg2 = getValidatedConfig({ cwd: tempDir });
    // Without reset, cached value persists
    expect(cfg2.memory?.similarityThreshold).toBe(0.7);

    resetConfigCache();
    const cfg3 = getValidatedConfig({ cwd: tempDir });
    expect(cfg3.memory?.similarityThreshold).toBe(0.9);
  });

  it('accepts the keys the init template emits without complaint (passthrough)', () => {
    writeConfig({
      version: '3.0.0',
      swarm: { topology: 'hierarchical-mesh', maxAgents: 15 },
      memory: {
        backend: 'hybrid',
        type: 'hybrid',
        similarityThreshold: 0.7,
        cleanupIntervalMs: 60000,
        embeddingCacheSize: 1000,
      },
      neural: { ewcLambda: 2000, defaultLearningRate: 0.001, qualityThreshold: 0.5 },
      embedding: { provider: 'onnx', model: 'Xenova/all-mpnet-base-v2', dimension: 768 },
      index: { hnsw: { M: 23, efConstruction: 100, efSearch: 50 } },
      mcp: { autoStart: true, transport: { port: 3000 } },
      ports: { mcp: 3000, mcpWebSocket: 3001 },
      hooks: { enabled: true, autoExecute: true },
    });

    const cfg = getValidatedConfig({ cwd: tempDir });
    expect(cfg.memory?.embeddingCacheSize).toBe(1000);
    expect(cfg.neural?.ewcLambda).toBe(2000);
  });

  it('walks up from cwd looking for .claude-flow/config.json', () => {
    // Write to parent
    writeConfig({ memory: { similarityThreshold: 0.5 } });
    const nestedDir = join(tempDir, 'subdir', 'inner');
    mkdirSync(nestedDir, { recursive: true });

    const cfg = getValidatedConfig({ cwd: nestedDir });
    expect(cfg.memory?.similarityThreshold).toBe(0.5);
  });

  // process.cwd()-fallback path is exercised at substrate runtime; vitest
  // workers don't support process.chdir(), so we cover the equivalent
  // semantics by passing the explicit `cwd` option above. The accessor's
  // `cwd ?? process.cwd()` line is trivial.

  it('exposes the substrate-consumed key surface as typed', () => {
    writeConfig({
      memory: {
        similarityThreshold: 0.8,
        cleanupIntervalMs: 60000,
        dedupThreshold: 0.95,
        embeddingCacheSize: 2000,
        migrationBatchSize: 500,
        persistPath: '/tmp/memory',
        swarmDir: '.swarm',
      },
      neural: {
        ewcLambda: 1500,
        defaultLearningRate: 0.002,
        learningRates: { qLearning: 0.1, sarsa: 0.1, moe: 0.01, lora: 0.001 },
      },
      workers: {
        factory: {
          'optimize': { timeout: 300000 },
        },
      },
    });

    const cfg: RuntimeConfig = getValidatedConfig({ cwd: tempDir });
    expect(cfg.memory?.similarityThreshold).toBe(0.8);
    expect(cfg.memory?.persistPath).toBe('/tmp/memory');
    expect(cfg.neural?.learningRates?.qLearning).toBe(0.1);
    expect(cfg.workers?.factory?.optimize?.timeout).toBe(300000);
  });
});
