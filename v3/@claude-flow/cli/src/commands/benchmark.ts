/**
 * V3 CLI Benchmark Command
 * Comprehensive benchmarking for self-learning, pre-training, and neural systems
 *
 * @module v3/cli/commands/benchmark
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import type { MemoryOp, MemoryResult } from '../memory/memory-router.js';
import { output } from '../output.js';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from '@claude-flow/shared/fs';

// Pretrain subcommand removed by ADR-0239 cluster 7 (Batch 3 deleted
// `cli/src/benchmarks/pretrain/`). Keeping `neural`, `memory`, `all`.

// ============================================================================
// Neural Benchmark Subcommand
// ============================================================================

const neuralCommand: Command = {
  name: 'neural',
  description: 'Benchmark neural operations (embeddings, WASM, Flash Attention)',
  options: [
    { name: 'iterations', short: 'i', type: 'number', description: 'Benchmark iterations', default: '100' },
    { name: 'dimension', short: 'd', type: 'number', description: 'Embedding dimension', default: '384' },
    { name: 'vectors', short: 'n', type: 'number', description: 'Number of test vectors', default: '1000' },
    { name: 'output', short: 'o', type: 'string', description: 'Output format: text, json', default: 'text' },
  ],
  examples: [
    { command: 'claude-flow benchmark neural', description: 'Run neural benchmarks' },
    { command: 'claude-flow benchmark neural -d 768 -n 5000', description: 'Higher dimension, more vectors' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const iterations = parseInt(ctx.flags.iterations as string || '100', 10);
    const dimension = parseInt(ctx.flags.dimension as string || '384', 10);
    const numVectors = parseInt(ctx.flags.vectors as string || '1000', 10);
    const outputFormat = ctx.flags.output as string || 'text';

    output.writeln();
    output.writeln(output.bold('Neural Operations Benchmark'));
    output.writeln(output.dim('─'.repeat(60)));
    output.writeln(`Iterations: ${iterations} | Dimension: ${dimension} | Vectors: ${numVectors}`);
    output.writeln();

    const spinner = output.createSpinner({ text: 'Running neural benchmarks...', spinner: 'dots' });
    spinner.start();

    try {
      const { performance } = await import('node:perf_hooks');

      // Helper functions
      const percentile = (sorted: number[], p: number) => {
        const idx = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.max(0, idx)];
      };

      const results: { name: string; mean: number; p95: number; p99: number; target: number; met: boolean }[] = [];

      // 1. Embedding Generation
      spinner.setText('Benchmarking embedding generation...');
      type EmbeddingResult = { embedding: number[]; dimensions: number; model: string };
      let generateEmbedding: (text: string) => Promise<EmbeddingResult>;
      try {
        // ADR-0086 T2.6: import from router (was memory-initializer)
        const memory = await import('../memory/memory-router.js');
        generateEmbedding = memory.generateEmbedding;
      } catch {
        generateEmbedding = async (text: string) => {
          const emb: number[] = [];
          for (let i = 0; i < dimension; i++) {
            emb.push(Math.sin(text.charCodeAt(i % text.length) * (i + 1)));
          }
          return { embedding: emb, dimensions: dimension, model: 'fallback' };
        };
      }

      const embedTimes: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await generateEmbedding(`benchmark text ${i}`);
        embedTimes.push(performance.now() - start);
      }
      const embedMean = embedTimes.reduce((a, b) => a + b, 0) / embedTimes.length;
      const embedSorted = [...embedTimes].sort((a, b) => a - b);
      results.push({
        name: 'Embedding Generation',
        mean: embedMean,
        p95: percentile(embedSorted, 95),
        p99: percentile(embedSorted, 99),
        target: 5.0,
        met: embedMean <= 5.0,
      });

      // 2. Batch Cosine Similarity
      // ADR-0086 T2.6: memory-router does not export batchCosineSim (raw vector helper
      // was intentionally dropped from memory-initializer.ts deletion). Use inline JS.
      spinner.setText('Benchmarking batch cosine similarity...');
      const batchCosineSim = (query: Float32Array, vectors: Float32Array[]): Float32Array => {
        const res = new Float32Array(vectors.length);
        for (let i = 0; i < vectors.length; i++) {
          let dot = 0, nQ = 0, nV = 0;
          for (let j = 0; j < query.length; j++) {
            dot += query[j] * vectors[i][j];
            nQ += query[j] * query[j];
            nV += vectors[i][j] * vectors[i][j];
          }
          res[i] = dot / (Math.sqrt(nQ) * Math.sqrt(nV));
        }
        return res;
      };

      const query = new Float32Array(dimension).map(() => Math.random());
      const vectors = Array.from({ length: numVectors }, () =>
        new Float32Array(dimension).map(() => Math.random())
      );

      const cosineTimes: number[] = [];
      for (let i = 0; i < Math.min(iterations, 50); i++) {
        const start = performance.now();
        batchCosineSim(query, vectors);
        cosineTimes.push(performance.now() - start);
      }
      const cosineMean = cosineTimes.reduce((a, b) => a + b, 0) / cosineTimes.length;
      const cosineSorted = [...cosineTimes].sort((a, b) => a - b);
      results.push({
        name: `Batch Cosine (${numVectors} vectors)`,
        mean: cosineMean,
        p95: percentile(cosineSorted, 95),
        p99: percentile(cosineSorted, 99),
        target: 5.0,
        met: cosineMean <= 5.0,
      });

      // ADR-0086 T2.6: Flash Attention search benchmark removed.
      // memory-router does not export flashAttentionSearch (raw vector helper was
      // intentionally dropped from memory-initializer.ts deletion). Benchmarking a
      // non-existent op is meaningless; do not stub.

      spinner.stop();

      // Display results
      output.writeln();
      output.writeln(output.bold('Results'));
      output.writeln(output.dim('─'.repeat(60)));

      for (const r of results) {
        const status = r.met ? output.success('✓') : output.error('✗');
        output.writeln(`${status} ${r.name}`);
        output.writeln(`   Mean: ${r.mean.toFixed(3)}ms | p95: ${r.p95.toFixed(3)}ms | p99: ${r.p99.toFixed(3)}ms`);
        output.writeln(`   Target: ${r.target}ms | Status: ${r.met ? 'Met' : 'Not met'}`);
        output.writeln();
      }

      if (outputFormat === 'json') {
        output.writeln(JSON.stringify(results, null, 2));
      }

      const allPassed = results.every(r => r.met);
      return {
        success: true,
        message: allPassed ? 'All neural benchmarks passed!' : 'Some benchmarks below target',
      };
    } catch (err) {
      spinner.stop();
      const errorMsg = err instanceof Error ? err.message : String(err);
      output.writeln(output.error(`Neural benchmark failed: ${errorMsg}`));
      return {
        success: false,
        message: `Neural benchmark failed: ${errorMsg}`,
      };
    }
  },
};

// ============================================================================
// Memory Benchmark Subcommand
// ============================================================================

const memoryCommand: Command = {
  name: 'memory',
  description: 'Benchmark memory operations (HNSW search, store, retrieve)',
  options: [
    { name: 'iterations', short: 'i', type: 'number', description: 'Benchmark iterations', default: '100' },
    { name: 'output', short: 'o', type: 'string', description: 'Output format: text, json', default: 'text' },
  ],
  examples: [
    { command: 'claude-flow benchmark memory', description: 'Run memory benchmarks' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const iterations = parseInt(ctx.flags.iterations as string || '100', 10);
    const outputFormat = ctx.flags.output as string || 'text';

    output.writeln();
    output.writeln(output.bold('Memory Operations Benchmark'));
    output.writeln(output.dim('─'.repeat(60)));

    const spinner = output.createSpinner({ text: 'Running memory benchmarks...', spinner: 'dots' });
    spinner.start();

    try {
      const { performance } = await import('node:perf_hooks');

      const percentile = (sorted: number[], p: number) => {
        const idx = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.max(0, idx)];
      };

      const results: { name: string; mean: number; p95: number; target: number; met: boolean }[] = [];

      // ADR-0086 T2.6: import from router (was memory-initializer).
      // No silent fallback: if the router import fails, the benchmark fails visibly
      // (a fake `{ success: true }` stub would produce zero-latency fake metrics).
      let routeMemoryOp: (op: MemoryOp) => Promise<MemoryResult>;
      {
        const memory = await import('../memory/memory-router.js');
        routeMemoryOp = memory.routeMemoryOp;
      }

      // 1. Store benchmark
      spinner.setText('Benchmarking memory store...');
      const storeTimes: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await routeMemoryOp({
          type: 'store',
          key: `bench-key-${i}`,
          value: `Benchmark value ${i} with some additional content`,
          namespace: 'benchmark',
        });
        storeTimes.push(performance.now() - start);
      }
      const storeMean = storeTimes.reduce((a, b) => a + b, 0) / storeTimes.length;
      results.push({
        name: 'Memory Store',
        mean: storeMean,
        p95: percentile([...storeTimes].sort((a, b) => a - b), 95),
        target: 10.0,
        met: storeMean <= 10.0,
      });

      // 2. Search benchmark
      spinner.setText('Benchmarking memory search...');
      const queries = [
        'authentication patterns',
        'error handling best practices',
        'performance optimization',
        'testing strategies',
        'security vulnerabilities',
      ];
      const searchTimes: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await routeMemoryOp({
          type: 'search',
          query: queries[i % queries.length],
          namespace: 'benchmark',
          limit: 10,
        });
        searchTimes.push(performance.now() - start);
      }
      const searchMean = searchTimes.reduce((a, b) => a + b, 0) / searchTimes.length;
      results.push({
        name: 'Memory Search (HNSW)',
        mean: searchMean,
        p95: percentile([...searchTimes].sort((a, b) => a - b), 95),
        target: 10.0,
        met: searchMean <= 10.0,
      });

      spinner.stop();

      // Display results
      output.writeln();
      output.writeln(output.bold('Results'));
      output.writeln(output.dim('─'.repeat(60)));

      for (const r of results) {
        const status = r.met ? output.success('✓') : output.error('✗');
        output.writeln(`${status} ${r.name}`);
        output.writeln(`   Mean: ${r.mean.toFixed(3)}ms | p95: ${r.p95.toFixed(3)}ms | Target: ${r.target}ms`);
        output.writeln();
      }

      if (outputFormat === 'json') {
        output.writeln(JSON.stringify(results, null, 2));
      }

      return { success: true, message: 'Memory benchmarks complete' };
    } catch (err) {
      spinner.stop();
      const errorMsg = err instanceof Error ? err.message : String(err);
      output.writeln(output.error(`Memory benchmark failed: ${errorMsg}`));
      return {
        success: false,
        message: `Memory benchmark failed: ${errorMsg}`,
      };
    }
  },
};

// ============================================================================
// Full Suite Benchmark Subcommand
// ============================================================================

const allCommand: Command = {
  name: 'all',
  description: 'Run all benchmark suites',
  options: [
    { name: 'iterations', short: 'i', type: 'number', description: 'Benchmark iterations', default: '50' },
    { name: 'output', short: 'o', type: 'string', description: 'Output format: text, json', default: 'text' },
    { name: 'save', short: 's', type: 'string', description: 'Save results to file' },
  ],
  examples: [
    { command: 'claude-flow benchmark all', description: 'Run all benchmarks' },
    { command: 'claude-flow benchmark all --save full-results.json', description: 'Run all and save results' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold(output.highlight('═'.repeat(65))));
    output.writeln(output.bold('  RuFlo V3 - Full Benchmark Suite'));
    output.writeln(output.bold(output.highlight('═'.repeat(65))));

    const startTime = Date.now();
    const allResults: Record<string, unknown> = {};

    // Pretrain benchmarks removed (ADR-0239 cluster 7).

    // Run neural benchmarks
    output.writeln();
    output.writeln(output.bold('▸ Neural Benchmarks'));
    if (neuralCommand.action) {
      const neuralResult = await neuralCommand.action(ctx);
      allResults.neural = neuralResult;
    }

    // Run memory benchmarks
    output.writeln();
    output.writeln(output.bold('▸ Memory Benchmarks'));
    if (memoryCommand.action) {
      const memoryResult = await memoryCommand.action(ctx);
      allResults.memory = memoryResult;
    }

    const totalDuration = Date.now() - startTime;

    output.writeln();
    output.writeln(output.bold(output.highlight('═'.repeat(65))));
    output.writeln(`  Total Duration: ${(totalDuration / 1000).toFixed(2)}s`);
    output.writeln(output.bold(output.highlight('═'.repeat(65))));

    // Save if requested
    const saveFile = ctx.flags.save as string | undefined;
    if (saveFile) {
      const resultsDir = join(findProjectRoot(), '.claude-flow', 'benchmarks'); // ADR-0137: anchor benchmarks at project root, not cwd
      if (!existsSync(resultsDir)) {
        mkdirSync(resultsDir, { recursive: true });
      }
      const savePath = saveFile.startsWith('/') ? saveFile : join(resultsDir, saveFile);
      writeFileSync(savePath, JSON.stringify({
        timestamp: new Date().toISOString(),
        duration: totalDuration,
        results: allResults,
      }, null, 2));
      output.writeln(output.success(`Results saved to ${savePath}`));
    }

    return { success: true, message: 'All benchmarks complete' };
  },
};

// ============================================================================
// Main Benchmark Command
// ============================================================================

export const benchmarkCommand: Command = {
  name: 'benchmark',
  description: 'Performance benchmarking for self-learning and neural systems',
  subcommands: [
    neuralCommand,
    memoryCommand,
    allCommand,
  ],
  examples: [
    { command: 'claude-flow benchmark neural', description: 'Benchmark neural operations' },
    { command: 'claude-flow benchmark memory', description: 'Benchmark memory operations' },
    { command: 'claude-flow benchmark all', description: 'Run all benchmarks' },
  ],
  action: async (_ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('RuFlo V3 Benchmark Suite'));
    output.writeln(output.dim('─'.repeat(50)));
    output.writeln();
    output.writeln('Available subcommands:');
    output.writeln(`  ${output.highlight('neural')}    - Benchmark neural operations (embeddings, WASM)`);
    output.writeln(`  ${output.highlight('memory')}    - Benchmark memory operations (HNSW, store, search)`);
    output.writeln(`  ${output.highlight('all')}       - Run all benchmark suites`);
    output.writeln();
    output.writeln('Examples:');
    output.writeln('  claude-flow benchmark neural -i 200');
    output.writeln('  claude-flow benchmark all --save results.json');
    output.writeln();

    return { success: true, message: 'Use a subcommand to run benchmarks' };
  },
};

export default benchmarkCommand;
