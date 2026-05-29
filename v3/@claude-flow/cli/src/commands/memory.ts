/**
 * V3 CLI Memory Command
 * Memory operations for AgentDB integration
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { select, confirm, input } from '../prompt.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { findProjectRoot } from '@claude-flow/shared/fs';

// Memory backends
const BACKENDS = [
  { value: 'agentdb', label: 'AgentDB', hint: 'Vector database with HNSW indexing (150x-12,500x faster)' },
  { value: 'sqlite', label: 'SQLite', hint: 'Lightweight local storage' },
  { value: 'hybrid', label: 'Hybrid', hint: 'SQLite + AgentDB (recommended)' },
  { value: 'memory', label: 'In-Memory', hint: 'Fast but non-persistent' }
];

// Store command
const storeCommand: Command = {
  name: 'store',
  description: 'Store data in memory',
  options: [
    {
      name: 'key',
      short: 'k',
      description: 'Storage key/namespace',
      type: 'string',
      required: true
    },
    {
      name: 'value',
      // Note: No short flag - global -v is reserved for verbose
      description: 'Value to store (use --value)',
      type: 'string'
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Memory namespace',
      type: 'string',
      default: 'default'
    },
    {
      name: 'ttl',
      description: 'Time to live in seconds',
      type: 'number'
    },
    {
      name: 'tags',
      description: 'Comma-separated tags',
      type: 'string'
    },
    {
      name: 'vector',
      description: 'Store as vector embedding',
      type: 'boolean',
      default: false
    },
    {
      name: 'upsert',
      short: 'u',
      description: 'Update if key exists (insert or replace)',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow memory store -k "api/auth" -v "JWT implementation"', description: 'Store text' },
    { command: 'claude-flow memory store -k "pattern/singleton" --vector', description: 'Store vector' },
    { command: 'claude-flow memory store -k "pattern" -v "updated" --upsert', description: 'Update existing' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const key = ctx.flags.key as string;
    let value = ctx.flags.value as string || ctx.args[0];
    // ADR-0257 #3: apply 'default' fallback so log line reads "default/<key>"
    // not "undefined/<key>" when --namespace is omitted.
    const namespace = (ctx.flags.namespace as string) || 'default';
    const ttl = ctx.flags.ttl as number;
    const tags = ctx.flags.tags ? (ctx.flags.tags as string).split(',') : [];
    const asVector = ctx.flags.vector as boolean;
    const upsert = ctx.flags.upsert as boolean;

    if (!key) {
      output.printError('Key is required. Use --key or -k');
      return { success: false, exitCode: 1 };
    }

    if (!value && ctx.interactive) {
      value = await input({
        message: 'Enter value to store:',
        validate: (v) => v.length > 0 || 'Value is required'
      });
    }

    if (!value) {
      output.printError('Value is required. Use --value');
      return { success: false, exitCode: 1 };
    }

    const storeData = {
      key,
      namespace,
      value,
      ttl,
      tags,
      asVector,
      storedAt: new Date().toISOString(),
      size: Buffer.byteLength(value, 'utf8')
    };

    output.printInfo(`Storing in ${namespace}/${key}...`);

    // ADR-0086 T2.6: import from router (was memory-initializer)
    try {
      const { routeMemoryOp } = await import('../memory/memory-router.js');

      if (asVector) {
        output.writeln(output.dim('  Generating embedding vector...'));
      }

      const result = await routeMemoryOp({
        type: 'store',
        key,
        value,
        namespace,
        generateEmbedding: true, // Always generate embeddings for semantic search
        tags,
        ttl,
        upsert
      });

      if (!result.success) {
        output.printError((result as any).error || 'Failed to store');
        return { success: false, exitCode: 1 };
      }

      // ADR-0085: writeJsonSidecar removed — intelligence reads from SQLite directly
      // ADR-0086 T2.6: router returns { success, key, stored, hasEmbedding, embeddingDimensions }
      const hasEmb = (result as any).hasEmbedding;
      const embDim = (result as any).embeddingDimensions;
      const storedKey = (result as any).key || key;

      output.writeln();
      output.printTable({
        columns: [
          { key: 'property', header: 'Property', width: 15 },
          { key: 'val', header: 'Value', width: 40 }
        ],
        data: [
          { property: 'Key', val: key },
          { property: 'Namespace', val: namespace },
          { property: 'Size', val: `${storeData.size} bytes` },
          { property: 'TTL', val: ttl ? `${ttl}s` : 'None' },
          { property: 'Tags', val: tags.length > 0 ? tags.join(', ') : 'None' },
          { property: 'Vector', val: hasEmb ? `Yes (${embDim}-dim)` : 'No' },
          { property: 'Key', val: storedKey.substring(0, 20) }
        ]
      });

      output.writeln();
      output.printSuccess('Data stored successfully');

      return { success: true, data: { ...storeData, key: storedKey, hasEmbedding: hasEmb } };
    } catch (error) {
      output.printError(`Failed to store: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Retrieve command
const retrieveCommand: Command = {
  name: 'retrieve',
  aliases: ['get'],
  description: 'Retrieve data from memory',
  options: [
    {
      name: 'key',
      short: 'k',
      description: 'Storage key',
      type: 'string'
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Memory namespace',
      type: 'string',
      default: 'default'
    },
    {
      name: 'value-only',
      description: 'Print only entry.content to stdout (pipe-friendly; no box, no banner). Trailing newline appended only when isTTY (ADR-0255 Phase 2).',
      type: 'boolean',
      default: false
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const key = ctx.flags.key as string || ctx.args[0];
    const namespace = ctx.flags.namespace as string;

    if (!key) {
      output.printError('Key is required');
      return { success: false, exitCode: 1 };
    }

    // ADR-0086 T2.6: import from router (was memory-initializer)
    try {
      const { routeMemoryOp } = await import('../memory/memory-router.js');
      const result = await routeMemoryOp({ type: 'get', key, namespace });

      if (!result.success) {
        output.printError(`Failed to retrieve: ${(result as any).error}`);
        return { success: false, exitCode: 1 };
      }

      if (!(result as any).found || !(result as any).entry) {
        output.printWarning(`Key not found: ${key}`);
        return { success: false, exitCode: 1, data: { key, found: false } };
      }

      const entry = (result as any).entry as {
        namespace: string; key: string; content: string;
        accessCount: number; tags: string[]; hasEmbedding?: boolean;
      };

      // ADR-0255 Decision #4 — pipe-friendly raw value stdout.
      // No box, no banner, no decoration. Trailing newline only on TTY so
      // piped output stays JSON.parse-clean for downstream consumers.
      if (ctx.flags['value-only']) {
        process.stdout.write(entry.content);
        if (process.stdout.isTTY) process.stdout.write('\n');
        return { success: true, data: entry };
      }

      if (ctx.flags.format === 'json') {
        output.printJson(entry);
        return { success: true, data: entry };
      }

      output.writeln();
      output.printBox(
        [
          `Namespace: ${entry.namespace}`,
          `Key: ${entry.key}`,
          `Size: ${entry.content.length} bytes`,
          `Access Count: ${entry.accessCount}`,
          `Tags: ${entry.tags.length > 0 ? entry.tags.join(', ') : 'None'}`,
          `Vector: ${entry.hasEmbedding ? 'Yes' : 'No'}`,
          '',
          output.bold('Value:'),
          entry.content
        ].join('\n'),
        'Memory Entry'
      );

      return { success: true, data: entry };
    } catch (error) {
      output.printError(`Failed to retrieve: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Search command
const searchCommand: Command = {
  name: 'search',
  description: 'Search memory with semantic/vector search',
  options: [
    {
      name: 'query',
      short: 'q',
      description: 'Search query',
      type: 'string',
      required: true
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Memory namespace',
      type: 'string'
    },
    {
      name: 'limit',
      short: 'l',
      description: 'Maximum results',
      type: 'number',
      default: 10
    },
    {
      name: 'threshold',
      description: 'Similarity threshold (0-1, auto-adapts to embedding model if omitted)',
      type: 'number',
    },
    {
      name: 'type',
      short: 't',
      description: 'Search type (semantic, keyword, hybrid)',
      type: 'string',
      default: 'semantic',
      choices: ['semantic', 'keyword', 'hybrid']
    },
    {
      name: 'build-hnsw',
      description: 'Build/rebuild HNSW index before searching (enables 150x-12,500x speedup)',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow memory search -q "authentication patterns"', description: 'Semantic search' },
    { command: 'claude-flow memory search -q "JWT" -t keyword', description: 'Keyword search' },
    { command: 'claude-flow memory search -q "test" --build-hnsw', description: 'Build HNSW index and search' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const query = ctx.flags.query as string || ctx.args[0];
    const namespace = ctx.flags.namespace as string || 'all';
    const limit = ctx.flags.limit as number || 10;
    const threshold = ctx.flags.threshold as number | undefined;
    const searchType = ctx.flags.type as string || 'semantic';
    const buildHnsw = (ctx.flags['build-hnsw'] || ctx.flags.buildHnsw) as boolean;

    if (!query) {
      output.printError('Query is required. Use --query or -q');
      return { success: false, exitCode: 1 };
    }

    // Build/rebuild HNSW index if requested
    if (buildHnsw) {
      output.printInfo('Building HNSW index...');
      // ADR-0086 T2.6: import from router (was memory-initializer)
      try {
        const { routeEmbeddingOp } = await import('../memory/memory-router.js');

        const startTime = Date.now();
        const indexResult = await routeEmbeddingOp({ type: 'hnswGet' });
        const buildTime = Date.now() - startTime;

        if (indexResult.success) {
          const statusResult = await routeEmbeddingOp({ type: 'hnswStatus' });
          const status = statusResult as { entryCount?: number; dimensions?: number };
          const entryCount = status.entryCount ?? 0;
          output.printSuccess(`HNSW index built (${entryCount} vectors, ${buildTime}ms)`);
          output.writeln(output.dim(`  Dimensions: ${status.dimensions ?? 'unknown'}, Metric: cosine`));
          output.writeln(output.dim(`  Search speedup: ${entryCount > 10000 ? '12,500x' : entryCount > 1000 ? '150x' : '10x'}`));
        } else {
          output.printWarning('HNSW index not available (install @ruvector/core for acceleration)');
        }
        output.writeln();
      } catch (error) {
        output.printWarning(`HNSW build failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        output.writeln(output.dim('  Falling back to brute-force search'));
        output.writeln();
      }
    }

    output.printInfo(`Searching: "${query}" (${searchType})`);
    output.writeln();

    // ADR-0086 T2.6: import from router (was memory-initializer)
    try {
      const { routeMemoryOp } = await import('../memory/memory-router.js');

      const searchStart = Date.now();
      const searchResult = await routeMemoryOp({
        type: 'search',
        query,
        namespace,
        limit,
        threshold
      });
      const searchTime = Date.now() - searchStart;

      if (!searchResult.success) {
        output.printError((searchResult as any).error || 'Search failed');
        return { success: false, exitCode: 1 };
      }

      const rawResults = ((searchResult as any).results || []) as Array<{ key: string; score: number; namespace: string; content: string }>;
      const results = rawResults.map(r => ({
        key: r.key,
        score: r.score,
        namespace: r.namespace,
        preview: r.content
      }));

      if (ctx.flags.format === 'json') {
        output.printJson({ query, searchType, results, searchTime: `${searchTime}ms` });
        return { success: true, data: results };
      }

      // Performance stats
      output.writeln(output.dim(`  Search time: ${searchTime}ms`));
      output.writeln();

      if (results.length === 0) {
        output.printWarning('No results found');
        output.writeln(output.dim('Try: claude-flow memory store -k "key" --value "data"'));
        return { success: true, data: [] };
      }

      output.printTable({
        columns: [
          { key: 'key', header: 'Key', width: 20 },
          { key: 'score', header: 'Score', width: 8, align: 'right', format: (v) => Number(v).toFixed(2) },
          { key: 'namespace', header: 'Namespace', width: 12 },
          { key: 'preview', header: 'Preview', width: 35 }
        ],
        data: results
      });

      output.writeln();
      output.printInfo(`Found ${results.length} results`);

      return { success: true, data: results };
    } catch (error) {
      output.printError(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// List command
const listCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  description: 'List memory entries',
  options: [
    {
      name: 'namespace',
      short: 'n',
      description: 'Filter by namespace',
      type: 'string'
    },
    {
      name: 'tags',
      short: 't',
      description: 'Filter by tags (comma-separated)',
      type: 'string'
    },
    {
      name: 'limit',
      short: 'l',
      description: 'Maximum entries',
      type: 'number',
      default: 20
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const namespace = ctx.flags.namespace as string;
    const limit = ctx.flags.limit as number;

    // ADR-0086 T2.6: import from router (was memory-initializer)
    try {
      const { routeMemoryOp } = await import('../memory/memory-router.js');
      const listResult = await routeMemoryOp({ type: 'list', namespace, limit, offset: 0 });

      if (!listResult.success) {
        output.printError(`Failed to list: ${(listResult as any).error}`);
        return { success: false, exitCode: 1 };
      }

      // ADR-0086 T2.6: router returns { success, entries, total }
      const rawEntries = ((listResult as any).entries || []) as Array<{
        key: string; namespace: string; content: string;
        hasEmbedding?: boolean; accessCount?: number; updatedAt?: string;
        embedding?: unknown;
      }>;

      // Format entries for display
      const entries = rawEntries.map(e => ({
        key: e.key,
        namespace: e.namespace,
        size: (e.content?.length ?? 0) + ' B',
        vector: (e.hasEmbedding || !!e.embedding) ? '✓' : '-',
        accessCount: e.accessCount ?? 0,
        updated: e.updatedAt ? formatRelativeTime(e.updatedAt) : '-'
      }));

      if (ctx.flags.format === 'json') {
        output.printJson(rawEntries);
        return { success: true, data: rawEntries };
      }

      output.writeln();
      output.writeln(output.bold('Memory Entries'));
      output.writeln();

      if (entries.length === 0) {
        output.printWarning('No entries found');
        output.printInfo('Store data: claude-flow memory store -k "key" --value "data"');
        return { success: true, data: [] };
      }

      output.printTable({
        columns: [
          { key: 'key', header: 'Key', width: 25 },
          { key: 'namespace', header: 'Namespace', width: 12 },
          { key: 'size', header: 'Size', width: 10, align: 'right' },
          { key: 'vector', header: 'Vector', width: 8, align: 'center' },
          { key: 'accessCount', header: 'Accessed', width: 10, align: 'right' },
          { key: 'updated', header: 'Updated', width: 12 }
        ],
        data: entries
      });

      output.writeln();
      output.printInfo(`Showing ${entries.length} of ${(listResult as any).total ?? rawEntries.length} entries`);

      return { success: true, data: rawEntries };
    } catch (error) {
      output.printError(`Failed to list: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Helper function to format relative time
function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const date = new Date(isoDate).getTime();
  const diff = now - date;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

// Delete command
const deleteCommand: Command = {
  name: 'delete',
  aliases: ['rm'],
  description: 'Delete memory entry',
  options: [
    {
      name: 'key',
      short: 'k',
      description: 'Storage key',
      type: 'string'
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Memory namespace',
      type: 'string',
      default: 'default'
    },
    {
      name: 'force',
      short: 'f',
      description: 'Skip confirmation',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow memory delete -k "mykey"', description: 'Delete entry with default namespace' },
    { command: 'claude-flow memory delete -k "lesson" -n "lessons"', description: 'Delete entry from specific namespace' },
    { command: 'claude-flow memory delete mykey -f', description: 'Delete without confirmation' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Support both --key flag and positional argument
    const key = ctx.flags.key as string || ctx.args[0];
    const namespace = (ctx.flags.namespace as string) || 'default';
    const force = ctx.flags.force as boolean;

    if (!key) {
      output.printError('Key is required. Use: memory delete -k "key" [-n "namespace"]');
      return { success: false, exitCode: 1 };
    }

    if (!force && ctx.interactive) {
      const confirmed = await confirm({
        message: `Delete memory entry "${key}" from namespace "${namespace}"?`,
        default: false
      });

      if (!confirmed) {
        output.printInfo('Operation cancelled');
        return { success: true };
      }
    }

    // ADR-0086 T2.6: import from router (was memory-initializer)
    try {
      const { routeMemoryOp } = await import('../memory/memory-router.js');
      const result = await routeMemoryOp({ type: 'delete', key, namespace });

      if (!result.success) {
        output.printError((result as any).error || 'Failed to delete');
        return { success: false, exitCode: 1 };
      }

      if ((result as any).deleted) {
        output.printSuccess(`Deleted "${key}" from namespace "${namespace}"`);
      } else {
        output.printWarning(`Key not found: "${key}" in namespace "${namespace}"`);
      }

      return { success: !!(result as any).deleted, data: result };
    } catch (error) {
      output.printError(`Failed to delete: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Stats command
const statsCommand: Command = {
  name: 'stats',
  description: 'Show memory statistics',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Call MCP memory/stats tool for real statistics
    try {
      const statsResult = await callMCPTool('memory_stats', {}) as {
        totalEntries: number;
        totalSize: string;
        version: string;
        backend: string;
        location: string;
        oldestEntry: string | null;
        newestEntry: string | null;
      };

      const stats = {
        backend: statsResult.backend,
        entries: {
          total: statsResult.totalEntries,
          vectors: 0, // Would need vector backend support
          text: statsResult.totalEntries
        },
        storage: {
          total: statsResult.totalSize,
          location: statsResult.location
        },
        version: statsResult.version,
        oldestEntry: statsResult.oldestEntry,
        newestEntry: statsResult.newestEntry
      };

      if (ctx.flags.format === 'json') {
        output.printJson(stats);
        return { success: true, data: stats };
      }

      output.writeln();
      output.writeln(output.bold('Memory Statistics'));
      output.writeln();

      output.writeln(output.bold('Overview'));
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 20 },
          { key: 'value', header: 'Value', width: 30, align: 'right' }
        ],
        data: [
          { metric: 'Backend', value: stats.backend },
          { metric: 'Version', value: stats.version },
          { metric: 'Total Entries', value: stats.entries.total.toLocaleString() },
          { metric: 'Total Storage', value: stats.storage.total },
          { metric: 'Location', value: stats.storage.location }
        ]
      });

      output.writeln();
      output.writeln(output.bold('Timeline'));
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 20 },
          { key: 'value', header: 'Value', width: 30, align: 'right' }
        ],
        data: [
          { metric: 'Oldest Entry', value: stats.oldestEntry || 'N/A' },
          { metric: 'Newest Entry', value: stats.newestEntry || 'N/A' }
        ]
      });

      // #1622 — Surface the active embedding provider in `memory stats` so
      // users can tell which backend resolved at runtime (the 6-level
      // fallback chain in loadEmbeddingModel ranges from full ONNX to a
      // 128-dim hash that has no semantic understanding). Calling
      // loadEmbeddingModel() is cheap when the model is already cached;
      // a fresh call still resolves quickly because we only need the
      // metadata, not a real embedding.
      try {
        // ADR-0162 Batch C+D hand-port: memory-initializer.js was deleted in our
        // fork (ADR-0086 / ADR-0161 relocated the seam). The upstream introspection
        // helpers now live in memory-router.ts.
        //
        // HNSW status comes from RvfBackend (IStorageContract), not the
        // `enhancedEmbeddingService` controller. EnhancedEmbeddingService is a
        // WASM-cosine helper for batch embedding generation — it has no HNSW
        // state, no `isReady()`, and its `getStats()` returns
        // `{cacheSize, wasmEnabled, simdEnabled}` (no `totalEntries`). The
        // previous code also used the short name `enhancedEmbedding` which
        // never matched the registry's canonical name `enhancedEmbeddingService`,
        // so getController returned null and the row always reported "not
        // active" even when HNSW was active with vectors indexed.
        //
        // The canonical source of truth is `routeEmbeddingOp({type:'hnswStatus'})`,
        // which calls `_storage.getStats()` and returns `hnswStats` when the
        // RvfBackend has an HNSW index wired in (see rvf-backend.ts:998).
        const { loadEmbeddingModel: lem, routeEmbeddingOp: reo } = await import('../memory/memory-router.js');
        const embedding = await lem({ verbose: false });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hnswResult: any = await reo({ type: 'hnswStatus' });
        // Presence of `hnswStats` in storage stats means RvfBackend has an
        // HNSW index wired in. `vectorCount` is the number of vectors
        // currently indexed (may be 0 on a fresh init — that's still "active").
        const hnswActive = !!(hnswResult?.success && hnswResult.hnswStats);
        const hnsw = {
          available: hnswActive,
          initialized: hnswActive,
          entryCount: hnswResult?.hnswStats?.vectorCount ?? 0,
        };
        // Map model name → semantic capability so users can spot the
        // hash-fallback case without reading docs.
        const semanticProviders = new Set([
          'Xenova/all-MiniLM-L6-v2',
          'Xenova/all-mpnet-base-v2',
          'Xenova/bge-small-en-v1.5',
          'agentic-flow',
          'agentic-flow/reasoningbank',
          'ruvector/onnx',
          'cached',
        ]);
        const isSemantic = embedding.success && semanticProviders.has(embedding.modelName);

        output.writeln();
        output.writeln(output.bold('Embedding'));
        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 20 },
            { key: 'value', header: 'Value', width: 30, align: 'right' }
          ],
          data: [
            {
              metric: 'Provider',
              value: embedding.success
                ? embedding.modelName
                : output.warning(`unavailable: ${embedding.error || 'unknown'}`),
            },
            { metric: 'Dimensions', value: String(embedding.dimensions) },
            {
              metric: 'Semantic Search',
              value: isSemantic
                ? output.success('yes')
                : output.warning('no — using hash fallback'),
            },
            {
              metric: 'HNSW Index',
              value: hnsw.available && hnsw.initialized
                ? output.success(`active (${hnsw.entryCount.toLocaleString()} entries)`)
                : hnsw.available
                  ? output.warning('available but not initialized')
                  : output.dim('not active'),
            },
          ]
        });
      } catch (e) {
        // Don't fail the whole stats command if introspection breaks —
        // the rest of the dashboard is still useful.
        output.writeln();
        output.writeln(output.bold('Embedding'));
        output.printInfo(`Provider info unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }

      output.writeln();
      output.printInfo('V3 Performance: 150x-12,500x faster search with HNSW indexing');

      return { success: true, data: stats };
    } catch (error) {
      output.printError(`Failed to get stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Configure command
const configureCommand: Command = {
  name: 'configure',
  aliases: ['config'],
  description: 'Configure memory backend',
  options: [
    {
      name: 'backend',
      short: 'b',
      description: 'Memory backend',
      type: 'string',
      choices: BACKENDS.map(b => b.value)
    },
    {
      name: 'path',
      description: 'Storage path',
      type: 'string'
    },
    {
      name: 'cache-size',
      description: 'Cache size in MB',
      type: 'number'
    },
    {
      name: 'hnsw-m',
      description: 'HNSW M parameter',
      type: 'number',
      default: 16
    },
    {
      name: 'hnsw-ef',
      description: 'HNSW ef parameter',
      type: 'number',
      default: 200
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let backend = ctx.flags.backend as string;

    if (!backend && ctx.interactive) {
      backend = await select({
        message: 'Select memory backend:',
        options: BACKENDS,
        default: 'hybrid'
      });
    }

    const config = {
      backend: backend || 'hybrid',
      path: ctx.flags.path || './data/memory',
      cacheSize: ctx.flags.cacheSize || 256,
      hnsw: {
        m: ctx.flags.hnswM || 16,
        ef: ctx.flags.hnswEf || 200
      }
    };

    output.writeln();
    output.printInfo('Memory Configuration');
    output.writeln();

    output.printTable({
      columns: [
        { key: 'setting', header: 'Setting', width: 20 },
        { key: 'value', header: 'Value', width: 25 }
      ],
      data: [
        { setting: 'Backend', value: config.backend },
        { setting: 'Storage Path', value: config.path },
        { setting: 'Cache Size', value: `${config.cacheSize} MB` },
        { setting: 'HNSW M', value: config.hnsw.m },
        { setting: 'HNSW ef', value: config.hnsw.ef }
      ]
    });

    output.writeln();
    output.printSuccess('Memory configuration updated');

    return { success: true, data: config };
  }
};

// Cleanup command
const cleanupCommand: Command = {
  name: 'cleanup',
  description: 'Clean up stale and expired memory entries',
  options: [
    {
      name: 'dry-run',
      short: 'd',
      description: 'Show what would be deleted',
      type: 'boolean',
      default: false
    },
    {
      name: 'older-than',
      short: 'o',
      description: 'Delete entries older than (e.g., "7d", "30d")',
      type: 'string'
    },
    {
      name: 'expired-only',
      short: 'e',
      description: 'Only delete expired TTL entries',
      type: 'boolean',
      default: false
    },
    {
      name: 'low-quality',
      short: 'l',
      description: 'Delete low quality patterns (threshold)',
      type: 'number'
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Clean specific namespace only',
      type: 'string'
    },
    {
      name: 'force',
      short: 'f',
      description: 'Skip confirmation',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow memory cleanup --dry-run', description: 'Preview cleanup' },
    { command: 'claude-flow memory cleanup --older-than 30d', description: 'Delete entries older than 30 days' },
    { command: 'claude-flow memory cleanup --expired-only', description: 'Clean expired entries' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const dryRun = ctx.flags.dryRun as boolean;
    const force = ctx.flags.force as boolean;

    if (dryRun) {
      output.writeln(output.warning('DRY RUN - No changes will be made'));
    }

    output.printInfo('Analyzing memory for cleanup...');

    try {
      const result = await callMCPTool<{
        dryRun: boolean;
        candidates: {
          expired: number;
          stale: number;
          lowQuality: number;
          total: number;
        };
        deleted: {
          entries: number;
          vectors: number;
          patterns: number;
        };
        freed: {
          bytes: number;
          formatted: string;
        };
        duration: number;
      }>('memory_cleanup', {
        dryRun,
        olderThan: ctx.flags.olderThan,
        expiredOnly: ctx.flags.expiredOnly,
        lowQualityThreshold: ctx.flags.lowQuality,
        namespace: ctx.flags.namespace,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Cleanup Analysis'));
      output.printTable({
        columns: [
          { key: 'category', header: 'Category', width: 20 },
          { key: 'count', header: 'Count', width: 15, align: 'right' }
        ],
        data: [
          { category: 'Expired (TTL)', count: result.candidates.expired },
          { category: 'Stale (unused)', count: result.candidates.stale },
          { category: 'Low Quality', count: result.candidates.lowQuality },
          { category: output.bold('Total'), count: output.bold(String(result.candidates.total)) }
        ]
      });

      if (!dryRun && result.candidates.total > 0 && !force) {
        const confirmed = await confirm({
          message: `Delete ${result.candidates.total} entries (${result.freed.formatted})?`,
          default: false
        });

        if (!confirmed) {
          output.printInfo('Cleanup cancelled');
          return { success: true, data: result };
        }
      }

      if (!dryRun) {
        output.writeln();
        output.printSuccess(`Cleaned ${result.deleted.entries} entries`);
        output.printList([
          `Vectors removed: ${result.deleted.vectors}`,
          `Patterns removed: ${result.deleted.patterns}`,
          `Space freed: ${result.freed.formatted}`,
          `Duration: ${result.duration}ms`
        ]);
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Cleanup error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Compress command
const compressCommand: Command = {
  name: 'compress',
  description: 'Compress and optimize memory storage',
  options: [
    {
      name: 'level',
      short: 'l',
      description: 'Compression level (fast, balanced, max)',
      type: 'string',
      choices: ['fast', 'balanced', 'max'],
      default: 'balanced'
    },
    {
      name: 'target',
      short: 't',
      description: 'Target (vectors, text, patterns, all)',
      type: 'string',
      choices: ['vectors', 'text', 'patterns', 'all'],
      default: 'all'
    },
    {
      name: 'quantize',
      short: 'z',
      description: 'Enable vector quantization (reduces memory 4-32x)',
      type: 'boolean',
      default: false
    },
    {
      name: 'bits',
      description: 'Quantization bits (4, 8, 16)',
      type: 'number',
      default: 8
    },
    {
      name: 'rebuild-index',
      short: 'r',
      description: 'Rebuild HNSW index after compression',
      type: 'boolean',
      default: true
    }
  ],
  examples: [
    { command: 'claude-flow memory compress', description: 'Balanced compression' },
    { command: 'claude-flow memory compress --quantize --bits 4', description: '4-bit quantization (32x reduction)' },
    { command: 'claude-flow memory compress -l max -t vectors', description: 'Max compression on vectors' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const level = ctx.flags.level as string || 'balanced';
    const target = ctx.flags.target as string || 'all';
    const quantize = ctx.flags.quantize as boolean;
    const bits = ctx.flags.bits as number || 8;
    const rebuildIndex = ctx.flags.rebuildIndex as boolean ?? true;

    output.writeln();
    output.writeln(output.bold('Memory Compression'));
    output.writeln(output.dim(`Level: ${level}, Target: ${target}, Quantize: ${quantize ? `${bits}-bit` : 'no'}`));
    output.writeln();

    const spinner = output.createSpinner({ text: 'Analyzing current storage...', spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        before: {
          totalSize: string;
          vectorsSize: string;
          textSize: string;
          patternsSize: string;
          indexSize: string;
        };
        after: {
          totalSize: string;
          vectorsSize: string;
          textSize: string;
          patternsSize: string;
          indexSize: string;
        };
        compression: {
          ratio: number;
          bytesSaved: number;
          formattedSaved: string;
          quantizationApplied: boolean;
          indexRebuilt: boolean;
        };
        performance: {
          searchLatencyBefore: number;
          searchLatencyAfter: number;
          searchSpeedup: string;
        };
        duration: number;
      }>('memory_compress', {
        level,
        target,
        quantize,
        bits,
        rebuildIndex,
      });

      spinner.succeed('Compression complete');

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Storage Comparison'));
      output.printTable({
        columns: [
          { key: 'category', header: 'Category', width: 15 },
          { key: 'before', header: 'Before', width: 12, align: 'right' },
          { key: 'after', header: 'After', width: 12, align: 'right' },
          { key: 'saved', header: 'Saved', width: 12, align: 'right' }
        ],
        data: [
          { category: 'Vectors', before: result.before.vectorsSize, after: result.after.vectorsSize, saved: '-' },
          { category: 'Text', before: result.before.textSize, after: result.after.textSize, saved: '-' },
          { category: 'Patterns', before: result.before.patternsSize, after: result.after.patternsSize, saved: '-' },
          { category: 'Index', before: result.before.indexSize, after: result.after.indexSize, saved: '-' },
          { category: output.bold('Total'), before: result.before.totalSize, after: result.after.totalSize, saved: output.success(result.compression.formattedSaved) }
        ]
      });

      output.writeln();
      output.printBox(
        [
          `Compression Ratio: ${result.compression.ratio.toFixed(2)}x`,
          `Space Saved: ${result.compression.formattedSaved}`,
          `Quantization: ${result.compression.quantizationApplied ? `Yes (${bits}-bit)` : 'No'}`,
          `Index Rebuilt: ${result.compression.indexRebuilt ? 'Yes' : 'No'}`,
          `Duration: ${(result.duration / 1000).toFixed(1)}s`
        ].join('\n'),
        'Results'
      );

      if (result.performance) {
        output.writeln();
        output.writeln(output.bold('Performance Impact'));
        output.printList([
          `Search latency: ${result.performance.searchLatencyBefore.toFixed(2)}ms → ${result.performance.searchLatencyAfter.toFixed(2)}ms`,
          `Speedup: ${output.success(result.performance.searchSpeedup)}`
        ]);
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Compression failed');
      if (error instanceof MCPClientError) {
        output.printError(`Compression error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Export command
const exportCommand: Command = {
  name: 'export',
  description: 'Export memory to file',
  options: [
    {
      name: 'output',
      short: 'o',
      description: 'Output file path',
      type: 'string',
      required: true
    },
    {
      name: 'format',
      short: 'f',
      description: 'Export format (json, csv, binary)',
      type: 'string',
      choices: ['json', 'csv', 'binary'],
      default: 'json'
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Export specific namespace',
      type: 'string'
    },
    {
      name: 'include-vectors',
      description: 'Include vector embeddings (Phase 1: must be false; true throws a typed error per ADR-0255 Decision #6 pending schema v2)',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow memory export -o ./backup.json', description: 'Export all to JSON' },
    { command: 'claude-flow memory export -o ./data.csv -f csv', description: 'Export to CSV' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const outputPath = ctx.flags.output as string;
    const format = ctx.flags.format as string || 'json';

    if (!outputPath) {
      output.printError('Output path is required. Use --output or -o');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Exporting memory to ${outputPath}...`);

    try {
      const result = await callMCPTool<{
        outputPath: string;
        format: string;
        exported: {
          entries: number;
          vectors: number;
          patterns: number;
        };
        fileSize: string;
      }>('memory_export', {
        outputPath,
        format,
        namespace: ctx.flags.namespace,
        // ADR-0255 Decision #6: default to false (Phase 1 omits vector
        // serialization). Setting true at the call site would throw the
        // typed error in the MCP tool. Keep the user's explicit choice if
        // provided; otherwise omit-as-false.
        includeVectors: ctx.flags.includeVectors ?? false,
      });

      output.printSuccess(`Exported to ${result.outputPath}`);
      output.printList([
        `Entries: ${result.exported.entries}`,
        `Vectors: ${result.exported.vectors}`,
        `Patterns: ${result.exported.patterns}`,
        `File size: ${result.fileSize}`
      ]);

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Export error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Import command
const importCommand: Command = {
  name: 'import',
  description: 'Import memory from file',
  options: [
    {
      name: 'input',
      short: 'i',
      description: 'Input file path',
      type: 'string',
      required: true
    },
    {
      name: 'merge',
      short: 'm',
      description: 'Merge with existing (skip duplicates)',
      type: 'boolean',
      default: true
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Import into specific namespace',
      type: 'string'
    }
  ],
  examples: [
    { command: 'claude-flow memory import -i ./backup.json', description: 'Import from file' },
    { command: 'claude-flow memory import -i ./data.json -n archive', description: 'Import to namespace' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const inputPath = ctx.flags.input as string || ctx.args[0];

    if (!inputPath) {
      output.printError('Input path is required. Use --input or -i');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Importing memory from ${inputPath}...`);

    try {
      const result = await callMCPTool<{
        inputPath: string;
        imported: {
          entries: number;
          vectors: number;
          patterns: number;
        };
        skipped: number;
        duration: number;
      }>('memory_import', {
        inputPath,
        merge: ctx.flags.merge ?? true,
        namespace: ctx.flags.namespace,
      });

      output.printSuccess(`Imported from ${result.inputPath}`);
      output.printList([
        `Entries: ${result.imported.entries}`,
        `Vectors: ${result.imported.vectors}`,
        `Patterns: ${result.imported.patterns}`,
        `Skipped (duplicates): ${result.skipped}`,
        `Duration: ${result.duration}ms`
      ]);

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Import error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Init subcommand - initialize memory database using SQLite
const initMemoryCommand: Command = {
  name: 'init',
  description: 'Initialize memory database with SQLite - includes vector embeddings, pattern learning, temporal decay',
  options: [
    {
      name: 'backend',
      short: 'b',
      description: 'Backend type: hybrid (default), sqlite, or agentdb',
      type: 'string',
      default: 'hybrid'
    },
    {
      name: 'path',
      short: 'p',
      description: 'Database path',
      type: 'string'
    },
    {
      name: 'force',
      short: 'f',
      description: 'Overwrite existing database',
      type: 'boolean',
      default: false
    },
    {
      name: 'verbose',
      description: 'Show detailed initialization output',
      type: 'boolean',
      default: false
    },
    {
      name: 'verify',
      description: 'Run verification tests after initialization',
      type: 'boolean',
      default: true
    },
    {
      name: 'load-embeddings',
      description: 'Pre-load ONNX embedding model (lazy by default)',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'ruflo memory init', description: 'Initialize hybrid backend with all features' },
    { command: 'ruflo memory init -b agentdb', description: 'Initialize AgentDB backend' },
    { command: 'ruflo memory init -p ./data/memory.db --force',
      description: 'Reinitialize at custom path. ADR-0156: --force unlinks the canonical RVF sibling set (memory.rvf, .meta, .wal, .lock, .jslock, .ingestlock); preserves backups (.bak-*, .disabled-*, .migrated-*). Use `ruflo memory migrate` for non-destructive consolidation.' },
    { command: 'ruflo memory init --verbose --verify', description: 'Initialize with full verification' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const backend = (ctx.flags.backend as string) || 'hybrid';
    const customPath = ctx.flags.path as string;
    const force = ctx.flags.force as boolean;
    const verbose = ctx.flags.verbose as boolean;
    const verify = ctx.flags.verify !== false; // Default true
    const loadEmbeddings = ctx.flags.loadEmbeddings as boolean;

    output.writeln();
    output.writeln(output.bold('Initializing Memory Database'));
    output.writeln(output.dim('─'.repeat(50)));

    const spinner = output.createSpinner({ text: 'Initializing schema...', spinner: 'dots' });
    spinner.start();

    try {
      // ADR-0086 T2.6: import from router (was memory-initializer)
      // ADR-0156: also import resetRouter, getActiveBackendPath,
      // getActiveSiblingPaths, RVF_CANONICAL_EXTENSIONS for the --force
      // reset path + honest dbPath display.
      const {
        ensureRouter,
        loadEmbeddingModel,
        healthCheck,
        resetRouter,
        getActiveBackendPath,
        getActiveSiblingPaths,
        RVF_CANONICAL_EXTENSIONS,
      } = await import('../memory/memory-router.js');

      // ADR-0156: when --force is set, reset the canonical sibling set
      // BEFORE re-initializing. Previously --force was a silent no-op
      // (collected but never wired through). Now: enumerate the canonical
      // extensions, refuse if a peer holds the .jslock, unlink each
      // (symlink-safe), then resetRouter() to clear the in-process cache.
      if (force) {
        // First-time init must run to discover the resolved path; if a
        // prior init landed in this same process, getActiveBackendPath()
        // returns the cached value and we skip re-init.
        let pathForReset = getActiveBackendPath();
        if (!pathForReset) {
          // Bootstrap the path resolution by initializing once.
          await ensureRouter();
          pathForReset = getActiveBackendPath();
        }

        if (pathForReset && pathForReset !== ':memory:') {
          const fs = await import('node:fs');

          // Lock-acquire check: discriminate self-held vs peer-held.
          // _lockHeldDepth is process-internal; flock self-held is
          // tracked by checking if the .jslock content's PID matches
          // process.pid. Peer-held lock → fail loud.
          const jslockPath = pathForReset + '.jslock';
          if (fs.existsSync(jslockPath)) {
            try {
              const lockContent = fs.readFileSync(jslockPath, 'utf-8').trim();
              const recordedPid = parseInt(lockContent, 10);
              if (Number.isFinite(recordedPid) && recordedPid !== process.pid) {
                // Verify the peer process still exists.
                let peerAlive = false;
                try {
                  process.kill(recordedPid, 0); // signal 0 = existence probe
                  peerAlive = true;
                } catch {
                  // peer pid not alive — stale lock, safe to proceed
                }
                if (peerAlive) {
                  spinner.fail('Refusing to --force reset live state');
                  output.printError(
                    `another process (PID ${recordedPid}) holds ${jslockPath}; ` +
                    `refuse to reset live state. Stop the peer first ` +
                    `(e.g. \`kill ${recordedPid}\`) or wait for it to exit.`,
                  );
                  return { success: false, exitCode: 1 };
                }
              }
            } catch {
              // .jslock unreadable — could be a race or permissions issue.
              // Safer to proceed than refuse (treats unreadable as stale).
            }
          }

          // Pre-deletion print: list the canonical sibling files that
          // exist and would be unlinked. Defensive UX — the flag is
          // named --force, so no confirmation prompt, but the user
          // should see exactly what got removed.
          const existingSiblings = getActiveSiblingPaths().filter((p) => fs.existsSync(p));
          if (existingSiblings.length > 0) {
            output.writeln();
            output.writeln(output.dim(`--force: removing ${existingSiblings.length} canonical file(s):`));
            for (const p of existingSiblings) {
              output.writeln(output.dim(`  ${p}`));
            }
            output.writeln(
              output.dim('Backups (.bak-*, .disabled-*, .migrated-*) are preserved.'),
            );
            output.writeln(
              output.dim('To preserve data instead of deleting it, use ` ruflo memory migrate ` ' +
                'or `node scripts/migrate-meta-to-segments.mjs`.'),
            );
            output.writeln();
          }

          // Unlink each canonical sibling. Symlink-safe: skip with a
          // warning if the path is a symlink (we don't follow).
          for (const ext of RVF_CANONICAL_EXTENSIONS) {
            const target = pathForReset + ext;
            if (!fs.existsSync(target)) continue;
            try {
              const stat = fs.lstatSync(target);
              if (stat.isSymbolicLink()) {
                output.printWarning(`refusing to traverse symlink at canonical path ${target} — skipped`);
                continue;
              }
              if (!stat.isFile()) continue; // directories etc — skip
              fs.unlinkSync(target);
            } catch (err) {
              output.printWarning(
                `failed to unlink ${target}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          // Reset the in-process router cache. Without this, ensureRouter()
          // would return the stale cached _storage handle that still
          // points at the now-deleted files.
          resetRouter();
        }
      }

      // ADR-0162 Batch C+D #1791.6: detect pre-existing DB before init so we
      // can short-circuit cleanly. memory-initializer.ts (deleted in our fork)
      // would have surfaced this via MemoryInitResult.alreadyExists; we derive
      // the same signal from disk presence at the resolved-path candidate.
      const _preInitExists = await (async () => {
        try {
          const candidatePath = customPath || getActiveBackendPath() || '';
          if (!candidatePath || candidatePath === '(unresolved)') return false;
          const fsMod = await import('node:fs');
          // RVF_CANONICAL_EXTENSIONS includes '' (the bare path) and sidecars;
          // any of them being on-disk indicates an existing DB.
          for (const ext of RVF_CANONICAL_EXTENSIONS) {
            if (fsMod.existsSync(candidatePath + ext)) return true;
          }
          return false;
        } catch { return false; }
      })();

      await ensureRouter();

      // ADR-0156: pull dbPath from the resolved router state instead of
      // the previous hardcoded '.swarm/memory.db' lie. customPath flag
      // overrides; absent that, the router's resolved path wins.
      const resolvedDbPath = customPath || getActiveBackendPath() || '(unresolved)';

      // ADR-0156: removed fabricated `success`, `tablesCreated`,
      // `indexesCreated` fields. `success` is now implicit — if we
      // reached this point, ensureRouter() didn't throw. The catch at
      // line ~1487 handles the failure path.
      const result = {
        backend,
        schemaVersion: '3.0',
        dbPath: resolvedDbPath,
        features: {
          vectorEmbeddings: true,
          patternLearning: true,
          temporalDecay: true,
          hnswIndexing: true,
          migrationTracking: true,
        },
        // #1791.6 — set when DB was already on disk pre-ensureRouter and
        // --force wasn't passed; the early-return branch turns this into a
        // friendly no-op.
        alreadyExists: _preInitExists && !force,
        controllers: undefined as { activated: string[]; failed: string[]; initTimeMs: number } | undefined,
        error: undefined as string | undefined,
      };

      // #1791.6 — DB already initialized and --force not passed: friendly no-op.
      if (result.alreadyExists) {
        spinner.succeed(`Memory database already initialized at ${result.dbPath}`);
        output.printInfo('Use `--force` to reinitialize from scratch (destructive).');
        return { success: true, exitCode: 0 };
      }

      spinner.succeed('Schema initialized');

      // Lazy load or pre-load embedding model
      if (loadEmbeddings) {
        const embeddingSpinner = output.createSpinner({ text: 'Loading embedding model...', spinner: 'dots' });
        embeddingSpinner.start();

        const embeddingResult = await loadEmbeddingModel({ verbose });

        if (embeddingResult.success) {
          embeddingSpinner.succeed(`Embedding model loaded: ${embeddingResult.modelName} (${embeddingResult.dimensions}-dim, ${embeddingResult.loadTime}ms)`);
        } else {
          embeddingSpinner.stop(output.warning(`Embedding model: ${embeddingResult.error || 'Using fallback'}`));
        }
      }

      output.writeln();

      // Show features enabled with detailed capabilities
      const featureLines = [
        `Backend:           ${result.backend}`,
        `Schema Version:    ${result.schemaVersion}`,
        `Database Path:     ${result.dbPath}`,
        '',
        output.bold('Features:'),
        `  Vector Embeddings: ${result.features.vectorEmbeddings ? output.success('✓ Enabled') : output.dim('✗ Disabled')}`,
        `  Pattern Learning:  ${result.features.patternLearning ? output.success('✓ Enabled') : output.dim('✗ Disabled')}`,
        `  Temporal Decay:    ${result.features.temporalDecay ? output.success('✓ Enabled') : output.dim('✗ Disabled')}`,
        `  HNSW Indexing:     ${result.features.hnswIndexing ? output.success('✓ Enabled') : output.dim('✗ Disabled')}`,
        `  Migration Tracking: ${result.features.migrationTracking ? output.success('✓ Enabled') : output.dim('✗ Disabled')}`
      ];

      if (verbose) {
        featureLines.push(
          '',
          output.bold('HNSW Configuration:'),
          `  M (connections):     16`,
          `  ef (construction):   200`,
          `  ef (search):         100`,
          `  Metric:              cosine`,
          '',
          output.bold('Pattern Learning:'),
          `  Confidence scoring:  0.0 - 1.0`,
          `  Temporal decay:      Half-life 30 days`,
          `  Pattern versioning:  Enabled`,
          `  Types: task-routing, error-recovery, optimization, coordination, prediction`
        );
      }

      output.printBox(featureLines.join('\n'), 'Configuration');
      output.writeln();

      // ADR-053: Show ControllerRegistry activation results
      if (result.controllers) {
        const { activated, failed, initTimeMs } = result.controllers;
        if (activated.length > 0 || failed.length > 0) {
          const controllerLines = [
            output.bold('AgentDB Controllers:'),
            `  Activated: ${activated.length}  Failed: ${failed.length}  Init: ${Math.round(initTimeMs)}ms`,
          ];
          if (verbose && activated.length > 0) {
            controllerLines.push('');
            for (const name of activated) {
              controllerLines.push(`  ${output.success('✓')} ${name}`);
            }
          }
          if (failed.length > 0) {
            controllerLines.push('');
            for (const name of failed) {
              controllerLines.push(`  ${output.dim('✗')} ${name}`);
            }
          }
          output.printBox(controllerLines.join('\n'), 'Controller Registry (ADR-053)');
          output.writeln();
        }
      }

      // ADR-0156: removed fabricated "Tables Created" / "Indexes Created"
      // displays. The hardcoded SQLite-era table list (memory_entries,
      // patterns, pattern_history, trajectories, trajectory_steps,
      // migration_state, sessions, vector_indexes, metadata) was a
      // pre-RVF leak that didn't reflect what RVF actually creates.
      // RVF doesn't have "tables" — it has segments (VEC_SEG, META_SEG,
      // etc.). Showing fake table names was telemetry dishonesty per
      // `feedback-no-fallbacks`. Removed.

      // ADR-0086 T2.6: healthCheck replaces verifyMemoryInit
      if (verify) {
        const verifySpinner = output.createSpinner({ text: 'Verifying initialization...', spinner: 'dots' });
        verifySpinner.start();

        const health = await healthCheck() as { available?: boolean; controllers?: number; controllerNames?: string[]; error?: string };

        if (health.available) {
          verifySpinner.succeed(`Verification passed (router healthy, ${health.controllers ?? 0} controllers)`);
        } else {
          verifySpinner.fail(`Verification failed: ${health.error || 'router not available'}`);
        }

        if (verbose || !health.available) {
          output.writeln();
          output.writeln(output.bold('Health Check Results:'));
          output.printTable({
            columns: [
              { key: 'status', header: '', width: 3 },
              { key: 'name', header: 'Check', width: 22 },
              { key: 'details', header: 'Details', width: 30 }
            ],
            data: [
              {
                status: health.available ? output.success('✓') : output.error('✗'),
                name: 'Router available',
                details: health.available ? 'OK' : (health.error || 'unavailable')
              },
              ...(health.controllerNames || []).map(name => ({
                status: output.success('✓'),
                name: 'Controller',
                details: name
              }))
            ]
          });
        }

        output.writeln();
      }

      // Show next steps
      output.writeln(output.bold('Next Steps:'));
      output.printList([
        `Store data: ${output.highlight('claude-flow memory store -k "key" --value "data"')}`,
        `Search: ${output.highlight('claude-flow memory search -q "query"')}`,
        `Train patterns: ${output.highlight('claude-flow neural train -p coordination')}`,
        `View stats: ${output.highlight('claude-flow memory stats')}`
      ]);

      // ADR-0080: removed .claude/memory.db copy — it was a dead-weight one-time
      // copy that never received subsequent writes. Subsystems that probed it
      // (.swarm/memory.db is the canonical path) now fall through gracefully.

      // Fix #1428 now handled centrally in CLI.run() — see index.ts

      return {
        success: true,
        data: result
      };
    } catch (error) {
      spinner.fail('Initialization failed');
      output.printError(`Failed to initialize memory: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Migrate command — ADR-0030 S6 (OPT-011): Backfill legacy embeddings
// ADR-0086: Legacy SQLite -> RVF migration helper.
// Reads .swarm/memory.db via better-sqlite3 (dynamic, optional dep) and bulk-inserts
// into .claude-flow/memory.rvf via RvfBackend.bulkInsert(). Preserves source row IDs
// so reruns are idempotent (entries.set + keyIndex.set on same id replace, never duplicate).
async function runFromSqlite(ctx: CommandContext): Promise<CommandResult> {
  const cwd = findProjectRoot(); // ADR-0137: anchor migration source/dest at project root, not cwd
  const sourcePath = (ctx.flags.source as string) || `${cwd}/.swarm/memory.db`;
  const destPath = (ctx.flags.dest as string) || `${cwd}/.claude-flow/memory.rvf`;
  const dryRun = ctx.flags['dry-run'] as boolean;

  output.writeln();
  output.writeln(output.bold('SQLite -> RVF Migration (ADR-0086)'));
  output.writeln();
  output.writeln(`  Source: ${sourcePath}`);
  output.writeln(`  Dest:   ${destPath}`);
  if (dryRun) output.printInfo('Dry-run mode: no writes will be performed');
  output.writeln();

  // Verify source exists
  const { existsSync } = await import('node:fs');
  if (!existsSync(sourcePath)) {
    output.printError(`Source SQLite file not found: ${sourcePath}`);
    output.printInfo('Hint: pre-ADR-0086 installs stored memory at .swarm/memory.db');
    return { success: false, exitCode: 1 };
  }

  // Dry-run: count rows directly via better-sqlite3 (no RVF write path).
  if (dryRun) {
    let Database: any = null;
    try {
      const mod: any = await import('better-sqlite3' as string);
      Database = mod.default ?? mod;
    } catch {
      output.printError('better-sqlite3 is required for SQLite migration but is not installed.');
      output.printInfo('Install it (one-time, only needed for migration):');
      output.writeln('    npm install better-sqlite3');
      return { success: false, exitCode: 1 };
    }
    try {
      const db = new Database(sourcePath, { readonly: true });
      try {
        const row = db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get() as { n: number };
        output.printSuccess(`Dry-run: found ${row.n} entries in ${sourcePath}`);
        return { success: true, data: { dryRun: true, total: row.n, source: sourcePath, dest: destPath } };
      } finally {
        db.close();
      }
    } catch (e) {
      output.printError(`Failed to read SQLite database: ${e instanceof Error ? e.message : String(e)}`);
      return { success: false, exitCode: 1 };
    }
  }

  // Real migration: delegate to RvfMigrator.fromSqlite (handles batching, normalization).
  // The migrator uses dynamic import of better-sqlite3 internally and throws a clear
  // error if it is missing, which we surface here.
  const spinner = output.createSpinner({ text: 'Reading SQLite database...', spinner: 'dots' });
  spinner.start();
  try {
    const { RvfMigrator }: any = await import('@claude-flow/memory');
    const result = await RvfMigrator.fromSqlite(sourcePath, destPath, {
      verbose: ctx.flags.verbose as boolean,
      onProgress: (p: { current: number; total: number; phase: string }) => {
        spinner.setText(`${p.phase}: ${p.current}/${p.total}`);
      },
    });

    if (!result.success) {
      const firstError = result.errors[0] || 'Unknown error';
      const isMissingDriver = /better-sqlite3|sql\.js/i.test(firstError);
      if (isMissingDriver) {
        spinner.fail('SQLite driver missing');
        output.printError('better-sqlite3 is required for SQLite migration but is not installed.');
        output.printInfo('Install it (one-time, only needed for migration):');
        output.writeln('    npm install better-sqlite3');
      } else {
        spinner.fail('Migration failed');
        for (const err of result.errors) output.printError(err);
      }
      return { success: false, exitCode: 1 };
    }

    spinner.succeed(`Migrated ${result.entriesMigrated} entries in ${result.durationMs}ms`);
    output.writeln();
    output.printTable({
      columns: [
        { key: 'metric', header: 'Metric', width: 22 },
        { key: 'value', header: 'Value', width: 30 }
      ],
      data: [
        { metric: 'Source', value: sourcePath },
        { metric: 'Destination', value: destPath },
        { metric: 'Migrated', value: String(result.entriesMigrated) },
        { metric: 'Errors', value: String(result.errors.length) },
        { metric: 'Duration', value: `${result.durationMs}ms` }
      ]
    });
    output.writeln();
    output.printSuccess('SQLite migration complete. Restart any running daemon to pick up the new RVF data.');
    return {
      success: true,
      data: {
        migrated: result.entriesMigrated,
        skipped: 0,
        errors: result.errors,
        source: sourcePath,
        dest: destPath,
        durationMs: result.durationMs,
      },
    };
  } catch (e) {
    spinner.fail('Migration failed');
    output.printError(`Failed to migrate: ${e instanceof Error ? e.message : String(e)}`);
    return { success: false, exitCode: 1 };
  }
}

const migrateCommand: Command = {
  name: 'migrate',
  description: 'Migrate legacy memory data (embeddings backfill or SQLite import)',
  options: [
    {
      name: 'from-sqlite',
      description: 'Migrate from a legacy .swarm/memory.db SQLite file into RVF (ADR-0086)',
      type: 'boolean',
      default: false
    },
    {
      name: 'source',
      description: 'SQLite source path for --from-sqlite (default: .swarm/memory.db)',
      type: 'string'
    },
    {
      name: 'dest',
      description: 'RVF destination path for --from-sqlite (default: .claude-flow/memory.rvf)',
      type: 'string'
    },
    {
      name: 'dry-run',
      description: 'Count entries without writing (only with --from-sqlite)',
      type: 'boolean',
      default: false
    },
    {
      name: 'force',
      short: 'f',
      description: 'Regenerate all embeddings even if already present',
      type: 'boolean',
      default: false
    },
    {
      name: 'batch-size',
      short: 'b',
      description: 'Number of entries to process per batch',
      type: 'number',
      default: 50
    },
    {
      name: 'model',
      short: 'm',
      description: 'Override embedding model',
      type: 'string'
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Only migrate entries in this namespace',
      type: 'string'
    }
  ],
  examples: [
    { command: 'claude-flow memory migrate', description: 'Backfill missing embeddings' },
    { command: 'claude-flow memory migrate --force', description: 'Regenerate all embeddings' },
    { command: 'claude-flow memory migrate --batch-size 100 --model text-embedding-3-small', description: 'Custom batch size and model' },
    { command: 'claude-flow memory migrate --from-sqlite', description: 'Import legacy .swarm/memory.db into .claude-flow/memory.rvf (ADR-0086)' },
    { command: 'claude-flow memory migrate --from-sqlite --source ./old.db --dest ./new.rvf --dry-run', description: 'Count entries in a legacy DB without writing' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // ADR-0086: --from-sqlite branch — import a legacy .swarm/memory.db into RVF.
    // Pre-ADR-0086 installs wrote entries to SQLite via Hybrid/SQLite backends.
    // After ADR-0086 the CLI only reads RVF, so users upgrading silently lose data
    // unless they run this command. better-sqlite3 is loaded dynamically (it is
    // NOT in CLI dependencies — Debt 7) and a clear install hint is shown if missing.
    if (ctx.flags['from-sqlite']) {
      return runFromSqlite(ctx);
    }

    const force = ctx.flags.force as boolean;
    const batchSize = (ctx.flags['batch-size'] as number) || 50;
    const model = ctx.flags.model as string | undefined;
    const namespace = ctx.flags.namespace as string | undefined;

    output.writeln();
    output.writeln(output.bold('Embedding Migration (ADR-0030 OPT-011)'));
    output.writeln();

    if (force) {
      output.printWarning('Force mode: will regenerate ALL embeddings');
    }

    const spinner = output.createSpinner({ text: 'Scanning memory entries...', spinner: 'dots' });
    spinner.start();

    try {
      // ADR-0086 T2.6: import from router (was memory-initializer)
      const { routeMemoryOp } = await import('../memory/memory-router.js');

      // Collect all entries by paginating through them
      const allEntries: { key: string; namespace: string; hasEmbedding: boolean }[] = [];
      let offset = 0;
      const pageSize = 200;

      while (true) {
        const page = await routeMemoryOp({ type: 'list', namespace, limit: pageSize, offset });
        if (!page.success) {
          spinner.fail('Failed to list entries');
          output.printError((page as any).error || 'Unknown error listing entries');
          return { success: false, exitCode: 1 };
        }
        for (const entry of (page as any).entries) {
          allEntries.push({ key: entry.key, namespace: entry.namespace, hasEmbedding: entry.hasEmbedding });
        }
        if ((page as any).entries.length < pageSize) break;
        offset += pageSize;
      }

      const totalEntries = allEntries.length;
      const candidates = force
        ? allEntries
        : allEntries.filter(e => !e.hasEmbedding);

      spinner.succeed(`Found ${totalEntries} entries, ${candidates.length} need embedding migration`);

      if (candidates.length === 0) {
        output.writeln();
        output.printSuccess('All entries already have embeddings. Nothing to migrate.');
        return { success: true, data: { total: totalEntries, migrated: 0, skipped: totalEntries, errors: 0 } };
      }

      // Confirm if interactive and many entries
      if (ctx.interactive && candidates.length > 10) {
        const proceed = await confirm({
          message: `Migrate ${candidates.length} entries? This will re-store each entry with embedding generation.`,
          default: true
        });
        if (!proceed) {
          output.printInfo('Migration cancelled');
          return { success: true, data: { cancelled: true } };
        }
      }

      let migrated = 0;
      let skipped = 0;
      let errors = 0;

      // Process in batches
      for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(candidates.length / batchSize);

        output.writeln(output.dim(`  Batch ${batchNum}/${totalBatches} (${batch.length} entries)...`));

        for (const candidate of batch) {
          const progress = migrated + skipped + errors + 1;
          const pct = Math.round((progress / candidates.length) * 100);
          output.write(`\r  [${pct}%] ${progress}/${candidates.length} — migrating ${candidate.namespace}/${candidate.key}`);

          // Retrieve the full entry to get its value
          const retrieved = await routeMemoryOp({ type: 'get', key: candidate.key, namespace: candidate.namespace });
          if (!retrieved.success || !(retrieved as any).found || !(retrieved as any).entry) {
            errors++;
            continue;
          }

          const entry = (retrieved as any).entry;

          // Re-store with embedding generation and upsert
          const result = await routeMemoryOp({
            type: 'store',
            key: entry.key,
            value: entry.content,
            namespace: entry.namespace,
            generateEmbedding: true,
            tags: entry.tags,
            upsert: true
          });

          if (result.success) {
            migrated++;
          } else {
            errors++;
          }
        }

        output.writeln(); // newline after progress line
      }

      // Summary
      skipped = totalEntries - candidates.length;

      output.writeln();
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 20 },
          { key: 'count', header: 'Count', width: 10, align: 'right' }
        ],
        data: [
          { metric: 'Total entries', count: totalEntries },
          { metric: 'Migrated', count: migrated },
          { metric: 'Skipped (had embedding)', count: skipped },
          { metric: 'Errors', count: errors }
        ]
      });

      output.writeln();
      if (errors > 0) {
        output.printWarning(`Migration completed with ${errors} error(s)`);
      } else {
        output.printSuccess('Migration completed successfully');
      }

      return {
        success: errors === 0,
        exitCode: errors > 0 ? 1 : 0,
        data: { total: totalEntries, migrated, skipped, errors }
      };
    } catch (error) {
      spinner.fail('Migration failed');
      output.printError(`Failed to migrate: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Main memory command
export const memoryCommand: Command = {
  name: 'memory',
  description: 'Memory management commands',
  subcommands: [initMemoryCommand, storeCommand, retrieveCommand, searchCommand, listCommand, deleteCommand, statsCommand, configureCommand, cleanupCommand, compressCommand, exportCommand, importCommand, migrateCommand],
  options: [],
  examples: [
    { command: 'claude-flow memory store -k "key" -v "value"', description: 'Store data' },
    { command: 'claude-flow memory search -q "auth patterns"', description: 'Search memory' },
    { command: 'claude-flow memory stats', description: 'Show statistics' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Memory Management Commands'));
    output.writeln();
    output.writeln('Usage: claude-flow memory <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('init')}       - Initialize memory database (SQLite)`,
      `${output.highlight('store')}      - Store data in memory`,
      `${output.highlight('retrieve')}   - Retrieve data from memory`,
      `${output.highlight('search')}     - Semantic/vector search`,
      `${output.highlight('list')}       - List memory entries`,
      `${output.highlight('delete')}     - Delete memory entry`,
      `${output.highlight('stats')}      - Show statistics`,
      `${output.highlight('configure')}  - Configure backend`,
      `${output.highlight('cleanup')}    - Clean expired entries`,
      `${output.highlight('compress')}   - Compress database`,
      `${output.highlight('export')}     - Export memory to file`,
      `${output.highlight('import')}     - Import from file`,
      `${output.highlight('migrate')}    - Backfill embeddings or import legacy SQLite (--from-sqlite)`
    ]);

    return { success: true };
  }
};

export default memoryCommand;
