"use strict";
/**
 * Memory MCP Tools for CLI - V3 with SQLite/HNSW Backend
 *
 * UPGRADED: Now uses the advanced SQLite + HNSW backend for:
 * - 150x-12,500x faster semantic search
 * - Vector embeddings with cosine similarity
 * - Persistent SQLite storage (WASM)
 * - Backward compatible with legacy JSON storage (auto-migrates)
 *
 * @module v3/cli/mcp-tools/memory-tools
 */
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.memoryTools = void 0;
var fs_1 = require("fs");
var path_1 = require("path");
var memory_router_js_1 = require("../memory/memory-router.js");
var migration_legacy_js_1 = require("../memory/migration-legacy.js");
// #1604: Align with memory-initializer.ts — single source of truth is .swarm/memory.db
var MEMORY_DIR = '.swarm';
var LEGACY_MEMORY_DIR = '.claude-flow/memory';
var MIGRATION_MARKER = '.migrated-to-sqlite';
function getMigrationMarkerPath() {
    // Marker lives alongside the legacy store so the migration check finds it
    // even if .swarm is wiped (legacy data is the source-of-truth for "have we
    // migrated yet?").
    return (0, path_1.resolve)((0, path_1.join)(LEGACY_MEMORY_DIR, MIGRATION_MARKER));
}
// D-2: Input bounds for memory parameters
var MAX_KEY_LENGTH = 1024;
var MAX_VALUE_SIZE = 1024 * 1024; // 1MB
var MAX_QUERY_LENGTH = 4096;
function validateMemoryInput(key, value, query) {
    if (key && key.length > MAX_KEY_LENGTH) {
        throw new Error("'key' must be a string of at most ".concat(MAX_KEY_LENGTH, " characters (invalid: length ").concat(key.length, ")"));
    }
    if (value && value.length > MAX_VALUE_SIZE) {
        throw new Error("'value' must be a string of at most ".concat(MAX_VALUE_SIZE, " bytes (invalid: length ").concat(value.length, ")"));
    }
    if (query && query.length > MAX_QUERY_LENGTH) {
        throw new Error("'query' must be a string of at most ".concat(MAX_QUERY_LENGTH, " characters (invalid: length ").concat(query.length, ")"));
    }
}
function ensureInitialized() {
    return __awaiter(this, void 0, void 0, function () {
        var _this = this;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, memory_router_js_1.ensureRouter)()];
                case 1:
                    _a.sent();
                    if (!(0, migration_legacy_js_1.hasLegacyStore)()) return [3 /*break*/, 3];
                    return [4 /*yield*/, (0, migration_legacy_js_1.migrateLegacyStore)(function (opts) { return __awaiter(_this, void 0, void 0, function () {
                            var result;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0: return [4 /*yield*/, (0, memory_router_js_1.routeMemoryOp)(__assign({ type: 'store' }, opts))];
                                    case 1:
                                        result = _a.sent();
                                        return [2 /*return*/, result];
                                }
                            });
                        }); })];
                case 2:
                    _a.sent();
                    _a.label = 3;
                case 3: return [2 /*return*/];
            }
        });
    });
}
exports.memoryTools = [
    {
        name: 'memory_store',
        description: 'Store a value in memory with vector embedding for semantic search (SQLite + HNSW backend). Use upsert=true to update existing keys.',
        category: 'memory',
        inputSchema: {
            type: 'object',
            properties: {
                key: { type: 'string', description: 'Memory key (unique within namespace)' },
                value: { description: 'Value to store (string or object)' },
                namespace: { type: 'string', description: 'Namespace for organization (default: "default")' },
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional tags for filtering',
                },
                ttl: { type: 'number', description: 'Time-to-live in seconds (optional)' },
                upsert: { type: 'boolean', description: 'If true, update existing key instead of failing (default: false)' },
                scope: { type: 'string', enum: ['agent', 'session', 'global'], description: 'Memory scope (default: unscoped)' },
                scope_id: { type: 'string', description: 'Scope identifier (agent ID or session ID)' },
            },
            required: ['key', 'value', 'namespace'],
        },
        handler: function (input) { return __awaiter(void 0, void 0, void 0, function () {
            var key, scopeCtrl, namespace, value, tags, ttl, upsert, startTime, result, duration, mg, _a, error_1;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0: return [4 /*yield*/, ensureInitialized()];
                    case 1:
                        _b.sent();
                        // ADR-0094 RC-3a: strict input type validation — reject non-string keys and
                        // non-string values rather than silently coercing (ADR-0082 no-silent-pass).
                        if (typeof input.key !== 'string' || input.key.length === 0) {
                            return [2 /*return*/, {
                                    success: false,
                                    stored: false,
                                    hasEmbedding: false,
                                    error: "'key' is required and must be a non-empty string",
                                }];
                        }
                        if (input.value === undefined || input.value === null) {
                            return [2 /*return*/, {
                                    success: false,
                                    key: input.key,
                                    stored: false,
                                    hasEmbedding: false,
                                    error: "'value' is required and must be a non-empty string",
                                }];
                        }
                        if (typeof input.value !== 'string') {
                            return [2 /*return*/, {
                                    success: false,
                                    key: input.key,
                                    stored: false,
                                    hasEmbedding: false,
                                    error: "'value' must be a string (got " + typeof input.value + "; arrays/numbers/objects are not silently stringified)",
                                }];
                        }
                        if (input.namespace !== undefined && typeof input.namespace !== 'string') {
                            return [2 /*return*/, {
                                    success: false,
                                    key: input.key,
                                    stored: false,
                                    hasEmbedding: false,
                                    error: "'namespace' must be a string when provided (got " + typeof input.namespace + ")",
                                }];
                        }
                        key = input.key;
                        if (!input.scope) return [3 /*break*/, 3];
                        return [4 /*yield*/, (0, memory_router_js_1.getController)('agentMemoryScope')];
                    case 2:
                        scopeCtrl = _b.sent();
                        if (scopeCtrl && typeof scopeCtrl.scopeKey === 'function') {
                            // No catch — if scopeKey throws, propagate to the outer handler
                            key = scopeCtrl.scopeKey(key, input.scope, (input.scope_id || input.agent_id || input.session_id));
                        }
                        _b.label = 3;
                    case 3:
                        namespace = input.namespace || 'default';
                        value = input.value;
                        tags = input.tags || [];
                        ttl = input.ttl;
                        upsert = input.upsert || false;
                        if (value.length === 0) {
                            return [2 /*return*/, {
                                    success: false,
                                    key: key,
                                    stored: false,
                                    hasEmbedding: false,
                                    error: "'value' is required and must be a non-empty string",
                                }];
                        }
                        validateMemoryInput(key, value);
                        startTime = performance.now();
                        _b.label = 4;
                    case 4:
                        _b.trys.push([4, 10, , 11]);
                        return [4 /*yield*/, (0, memory_router_js_1.routeMemoryOp)({
                                type: 'store',
                                key: key,
                                value: value,
                                namespace: namespace,
                                tags: tags,
                                ttl: ttl,
                                upsert: upsert,
                                generateEmbedding: true,
                            })];
                    case 5:
                        result = _b.sent();
                        duration = performance.now() - startTime;
                        if (!result.success) return [3 /*break*/, 9];
                        _b.label = 6;
                    case 6:
                        _b.trys.push([6, 8, , 9]);
                        return [4 /*yield*/, (0, memory_router_js_1.getController)('memoryGraph')];
                    case 7:
                        mg = _b.sent();
                        if (mg && typeof mg.addNode === 'function') {
                            mg.addNode(key, { namespace: namespace, value: value, tags: tags });
                        }
                        return [3 /*break*/, 9];
                    case 8:
                        _a = _b.sent();
                        return [3 /*break*/, 9];
                    case 9: return [2 /*return*/, {
                            success: result.success,
                            key: key,
                            namespace: namespace,
                            stored: result.success,
                            storedAt: result.storedAt || new Date().toISOString(),
                            hasEmbedding: !!result.hasEmbedding,
                            embeddingDimensions: result.embeddingDimensions || null,
                            backend: 'SQLite + HNSW',
                            storeTime: "".concat(duration.toFixed(2), "ms"),
                            error: result.error,
                        }];
                    case 10:
                        error_1 = _b.sent();
                        return [2 /*return*/, {
                                success: false,
                                key: key,
                                error: error_1 instanceof Error ? error_1.message : 'Unknown error',
                            }];
                    case 11: return [2 /*return*/];
                }
            });
        }); },
    },
    {
        name: 'memory_retrieve',
        description: 'Retrieve a value from memory by key',
        category: 'memory',
        inputSchema: {
            type: 'object',
            properties: {
                key: { type: 'string', description: 'Memory key' },
                namespace: { type: 'string', description: 'Namespace (e.g. "patterns", "solutions", "tasks")' },
            },
            required: ['key', 'namespace'],
        },
        handler: function (input) { return __awaiter(void 0, void 0, void 0, function () {
            var key, namespace, result, entry, value, error_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, ensureInitialized()];
                    case 1:
                        _a.sent();
                        key = input.key;
                        namespace = input.namespace;
                        if (!namespace || namespace === 'all') {
                            throw new Error("'namespace' is required and must be a specific string (cannot be \"all\"). Use namespace: \"patterns\", \"solutions\", or \"tasks\"");
                        }
                        validateMemoryInput(key);
                        _a.label = 2;
                    case 2:
                        _a.trys.push([2, 4, , 5]);
                        return [4 /*yield*/, (0, memory_router_js_1.routeMemoryOp)({ type: 'get', key: key, namespace: namespace })];
                    case 3:
                        result = _a.sent();
                        if (result.found && result.entry) {
                            entry = result.entry;
                            value = entry.content;
                            try {
                                value = JSON.parse(entry.content);
                            }
                            catch (_b) {
                                // Keep as string
                            }
                            return [2 /*return*/, {
                                    key: key,
                                    namespace: namespace,
                                    value: value,
                                    tags: entry.tags,
                                    storedAt: entry.createdAt,
                                    updatedAt: entry.updatedAt,
                                    accessCount: entry.accessCount,
                                    hasEmbedding: entry.hasEmbedding,
                                    found: true,
                                    backend: 'SQLite + HNSW',
                                }];
                        }
                        return [2 /*return*/, {
                                key: key,
                                namespace: namespace,
                                value: null,
                                found: false,
                            }];
                    case 4:
                        error_2 = _a.sent();
                        return [2 /*return*/, {
                                key: key,
                                namespace: namespace,
                                value: null,
                                found: false,
                                error: error_2 instanceof Error ? error_2.message : 'Unknown error',
                            }];
                    case 5: return [2 /*return*/];
                }
            });
        }); },
    },
    {
        name: 'memory_search',
        description: 'Semantic vector search using HNSW index (150x-12,500x faster than keyword search)',
        category: 'memory',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query (semantic similarity)' },
                namespace: { type: 'string', description: 'Namespace to search (default: "all" = all namespaces)' },
                limit: { type: 'number', description: 'Maximum results (default: 10)' },
                threshold: { type: 'number', description: 'Minimum similarity threshold 0-1 (default: 0.3)' },
                metadata_filter: { type: 'object', description: 'Optional metadata predicates for structured filtering (MongoDB-style)' },
                mmr_lambda: { type: 'number', description: 'MMR diversity lambda 0-1 (default: 0.5; 1.0 = pure relevance, 0.0 = pure diversity)' },
                synthesize: { type: 'boolean', description: 'Synthesize context from search results (default: false)' },
                scope: { type: 'string', enum: ['agent', 'session', 'global'], description: 'Memory scope (default: unscoped)' },
                scope_id: { type: 'string', description: 'Scope identifier (agent ID or session ID)' },
            },
            required: ['query'],
        },
        handler: function (input) { return __awaiter(void 0, void 0, void 0, function () {
            var query, namespace, limit, threshold, qo, cacheKey, cached, _a, startTime, result, duration, _mg_1, _mgCtrl, _b, rawResults, results_1, filteredResults, mf, _c, outputResults_2, mmr, lambda, diverseResults, _d, attentionApplied, attnService, _i, outputResults_1, r, attnScore, _e, scopeCtrl, _f, synthesis, ctx, _g, response, qo, cacheKey, _h, error_3;
            var _j;
            return __generator(this, function (_k) {
                switch (_k.label) {
                    case 0: return [4 /*yield*/, ensureInitialized()];
                    case 1:
                        _k.sent();
                        query = input.query;
                        namespace = input.namespace || 'all';
                        limit = input.limit || 10;
                        threshold = input.threshold || 0.3;
                        validateMemoryInput(undefined, undefined, query);
                        _k.label = 2;
                    case 2:
                        _k.trys.push([2, 4, , 5]);
                        return [4 /*yield*/, (0, memory_router_js_1.getController)('queryOptimizer')];
                    case 3:
                        qo = _k.sent();
                        if (qo && typeof qo.getCached === 'function') {
                            cacheKey = JSON.stringify({ q: query, ns: namespace, limit: limit, threshold: threshold });
                            cached = qo.getCached(cacheKey);
                            if (cached) {
                                return [2 /*return*/, __assign(__assign({}, cached), { cached: true })];
                            }
                        }
                        return [3 /*break*/, 5];
                    case 4:
                        _a = _k.sent();
                        return [3 /*break*/, 5];
                    case 5:
                        startTime = performance.now();
                        _k.label = 6;
                    case 6:
                        _k.trys.push([6, 40, , 41]);
                        return [4 /*yield*/, (0, memory_router_js_1.routeMemoryOp)({
                                type: 'search',
                                query: query,
                                namespace: namespace,
                                limit: limit,
                                threshold: threshold,
                            })];
                    case 7:
                        result = _k.sent();
                        duration = performance.now() - startTime;
                        _mg_1 = null;
                        _k.label = 8;
                    case 8:
                        _k.trys.push([8, 10, , 11]);
                        return [4 /*yield*/, (0, memory_router_js_1.getController)('memoryGraph')];
                    case 9:
                        _mgCtrl = _k.sent();
                        if (_mgCtrl && typeof _mgCtrl.getImportance === 'function') {
                            _mg_1 = _mgCtrl;
                        }
                        return [3 /*break*/, 11];
                    case 10:
                        _b = _k.sent();
                        return [3 /*break*/, 11];
                    case 11:
                        rawResults = result.results || [];
                        results_1 = rawResults.map(function (r) {
                            var _a;
                            var value = r.content;
                            try {
                                value = JSON.parse(r.content);
                            }
                            catch (_b) {
                                // Keep as string
                            }
                            var importance = _mg_1 ? ((_a = _mg_1.getImportance(r.key)) !== null && _a !== void 0 ? _a : 0) : 0;
                            return {
                                key: r.key,
                                namespace: r.namespace,
                                value: value,
                                similarity: r.score + importance * 0.1,
                                importance: importance || undefined,
                            };
                        });
                        filteredResults = results_1;
                        if (!input.metadata_filter) return [3 /*break*/, 15];
                        _k.label = 12;
                    case 12:
                        _k.trys.push([12, 14, , 15]);
                        return [4 /*yield*/, (0, memory_router_js_1.getController)('metadataFilter')];
                    case 13:
                        mf = _k.sent();
                        if (mf && typeof mf.filter === 'function') {
                            filteredResults = mf.filter(results_1, input.metadata_filter);
                        }
                        return [3 /*break*/, 15];
                    case 14:
                        _c = _k.sent();
                        return [3 /*break*/, 15];
                    case 15:
                        outputResults_2 = filteredResults;
                        _k.label = 16;
                    case 16:
                        _k.trys.push([16, 20, , 21]);
                        return [4 /*yield*/, (0, memory_router_js_1.getController)('mmrDiversityRanker')];
                    case 17:
                        mmr = _k.sent();
                        if (!(mmr && typeof mmr.selectDiverse === 'function' && outputResults_2.length > 1)) return [3 /*break*/, 19];
                        lambda = (_j = input.mmr_lambda) !== null && _j !== void 0 ? _j : 0.5;
                        return [4 /*yield*/, Promise.race([
                                Promise.resolve(mmr
                                    .selectDiverse(outputResults_2, query, { lambda: lambda, k: limit })),
                                new Promise(function (_, reject) { return setTimeout(function () { return reject(new Error('MMR timeout')); }, 2000); }),
                            ])];
                    case 18:
                        diverseResults = _k.sent();
                        if (Array.isArray(diverseResults) && diverseResults.length > 0) {
                            outputResults_2 = diverseResults;
                        }
                        _k.label = 19;
                    case 19: return [3 /*break*/, 21];
                    case 20:
                        _d = _k.sent();
                        return [3 /*break*/, 21];
                    case 21:
                        attentionApplied = false;
                        _k.label = 22;
                    case 22:
                        _k.trys.push([22, 24, , 25]);
                        return [4 /*yield*/, (0, memory_router_js_1.getController)('attentionService')];
                    case 23:
                        attnService = _k.sent();
                        if (attnService && typeof attnService.score === 'function' && outputResults_2.length > 1) {
                            for (_i = 0, outputResults_1 = outputResults_2; _i < outputResults_1.length; _i++) {
                                r = outputResults_1[_i];
                                attnScore = attnService.score(r.key);
                                if (typeof attnScore === 'number' && attnScore > 0) {
                                    r.similarity = r.similarity * 0.8 + attnScore * 0.2;
                                    r.attentionBoosted = true;
                                }
                            }
                            outputResults_2.sort(function (a, b) { return b.similarity - a.similarity; });
                            attentionApplied = true;
                        }
                        return [3 /*break*/, 25];
                    case 24:
                        _e = _k.sent();
                        return [3 /*break*/, 25];
                    case 25:
                        _k.trys.push([25, 28, , 29]);
                        if (!input.scope) return [3 /*break*/, 27];
                        return [4 /*yield*/, (0, memory_router_js_1.getController)('agentMemoryScope')];
                    case 26:
                        scopeCtrl = _k.sent();
                        if (scopeCtrl && typeof scopeCtrl.filterByScope === 'function') {
                            outputResults_2 = scopeCtrl.filterByScope(outputResults_2, input.scope, (input.scope_id || input.agent_id || input.session_id));
                        }
                        _k.label = 27;
                    case 27: return [3 /*break*/, 29];
                    case 28:
                        _f = _k.sent();
                        return [3 /*break*/, 29];
                    case 29:
                        synthesis = undefined;
                        if (!(input.synthesize && outputResults_2.length > 0)) return [3 /*break*/, 35];
                        _k.label = 30;
                    case 30:
                        _k.trys.push([30, 34, , 35]);
                        return [4 /*yield*/, (0, memory_router_js_1.getController)('contextSynthesizer')];
                    case 31:
                        ctx = _k.sent();
                        if (!(ctx && typeof ctx.synthesize === 'function')) return [3 /*break*/, 33];
                        return [4 /*yield*/, Promise.race([
                                Promise.resolve(ctx.synthesize(outputResults_2)),
                                new Promise(function (_, reject) { return setTimeout(function () { return reject(new Error('ContextSynthesizer timeout')); }, 2000); }),
                            ])];
                    case 32:
                        synthesis = _k.sent();
                        _k.label = 33;
                    case 33: return [3 /*break*/, 35];
                    case 34:
                        _g = _k.sent();
                        return [3 /*break*/, 35];
                    case 35:
                        response = __assign({ query: query, results: outputResults_2, total: outputResults_2.length, searchTime: "".concat(duration.toFixed(2), "ms"), backend: 'HNSW + SQLite', attention: attentionApplied }, (synthesis ? { synthesis: synthesis } : {}));
                        _k.label = 36;
                    case 36:
                        _k.trys.push([36, 38, , 39]);
                        return [4 /*yield*/, (0, memory_router_js_1.getController)('queryOptimizer')];
                    case 37:
                        qo = _k.sent();
                        if (qo && typeof qo.cache === 'function') {
                            cacheKey = JSON.stringify({ q: query, ns: namespace, limit: limit, threshold: threshold });
                            qo.cache(cacheKey, response);
                        }
                        return [3 /*break*/, 39];
                    case 38:
                        _h = _k.sent();
                        return [3 /*break*/, 39];
                    case 39: return [2 /*return*/, response];
                    case 40:
                        error_3 = _k.sent();
                        return [2 /*return*/, {
                                query: query,
                                results: [],
                                total: 0,
                                error: error_3 instanceof Error ? error_3.message : 'Unknown error',
                            }];
                    case 41: return [2 /*return*/];
                }
            });
        }); },
    },
    {
        name: 'memory_delete',
        description: 'Delete a memory entry by key',
        category: 'memory',
        inputSchema: {
            type: 'object',
            properties: {
                key: { type: 'string', description: 'Memory key' },
                namespace: { type: 'string', description: 'Namespace (e.g. "patterns", "solutions", "tasks")' },
            },
            required: ['key', 'namespace'],
        },
        handler: function (input) { return __awaiter(void 0, void 0, void 0, function () {
            var key, namespace, result, error_4;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, ensureInitialized()];
                    case 1:
                        _a.sent();
                        key = input.key;
                        namespace = input.namespace;
                        if (!namespace || namespace === 'all') {
                            throw new Error("'namespace' is required and must be a specific string (cannot be \"all\"). Use namespace: \"patterns\", \"solutions\", or \"tasks\"");
                        }
                        validateMemoryInput(key);
                        _a.label = 2;
                    case 2:
                        _a.trys.push([2, 4, , 5]);
                        return [4 /*yield*/, (0, memory_router_js_1.routeMemoryOp)({ type: 'delete', key: key, namespace: namespace })];
                    case 3:
                        result = _a.sent();
                        return [2 /*return*/, {
                                success: !!result.deleted,
                                key: key,
                                namespace: namespace,
                                deleted: !!result.deleted,
                                hnswIndexInvalidated: !!result.deleted,
                                backend: 'SQLite + HNSW',
                            }];
                    case 4:
                        error_4 = _a.sent();
                        return [2 /*return*/, {
                                success: false,
                                key: key,
                                namespace: namespace,
                                deleted: false,
                                error: error_4 instanceof Error ? error_4.message : 'Unknown error',
                            }];
                    case 5: return [2 /*return*/];
                }
            });
        }); },
    },
    {
        name: 'memory_list',
        description: 'List memory entries with optional filtering',
        category: 'memory',
        inputSchema: {
            type: 'object',
            properties: {
                namespace: { type: 'string', description: 'Namespace to list (default: "all" = all namespaces)' },
                limit: { type: 'number', description: 'Maximum results (default: 50)' },
                offset: { type: 'number', description: 'Offset for pagination (default: 0)' },
            },
        },
        handler: function (input) { return __awaiter(void 0, void 0, void 0, function () {
            var rawNamespace, namespace, limit, offset, result, rawEntries, entries, error_5;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, ensureInitialized()];
                    case 1:
                        _a.sent();
                        rawNamespace = input.namespace;
                        namespace = rawNamespace && rawNamespace.length > 0 ? rawNamespace : undefined;
                        limit = input.limit || 50;
                        offset = input.offset || 0;
                        _a.label = 2;
                    case 2:
                        _a.trys.push([2, 4, , 5]);
                        return [4 /*yield*/, (0, memory_router_js_1.routeMemoryOp)({
                                type: 'list',
                                namespace: namespace,
                                limit: limit,
                                offset: offset,
                            })];
                    case 3:
                        result = _a.sent();
                        rawEntries = result.entries || [];
                        entries = rawEntries.map(function (e) { return ({
                            key: e.key,
                            namespace: e.namespace,
                            storedAt: e.createdAt,
                            updatedAt: e.updatedAt,
                            accessCount: e.accessCount,
                            hasEmbedding: e.hasEmbedding,
                            size: e.size,
                        }); });
                        return [2 /*return*/, {
                                entries: entries,
                                total: result.total || 0,
                                limit: limit,
                                offset: offset,
                                backend: 'SQLite + HNSW',
                            }];
                    case 4:
                        error_5 = _a.sent();
                        return [2 /*return*/, {
                                entries: [],
                                total: 0,
                                limit: limit,
                                offset: offset,
                                error: error_5 instanceof Error ? error_5.message : 'Unknown error',
                            }];
                    case 5: return [2 /*return*/];
                }
            });
        }); },
    },
    {
        name: 'memory_stats',
        description: 'Get memory storage statistics including HNSW index status',
        category: 'memory',
        inputSchema: {
            type: 'object',
            properties: {},
        },
        handler: function () { return __awaiter(void 0, void 0, void 0, function () {
            var result, totalEntries, withEmbeddings, namespaces, error_6;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, ensureInitialized()];
                    case 1:
                        _a.sent();
                        _a.label = 2;
                    case 2:
                        _a.trys.push([2, 4, , 5]);
                        return [4 /*yield*/, (0, memory_router_js_1.routeMemoryOp)({ type: 'stats' })];
                    case 3:
                        result = _a.sent();
                        totalEntries = result.totalEntries || 0;
                        withEmbeddings = result.entriesWithEmbeddings || 0;
                        namespaces = result.namespaces || {};
                        return [2 /*return*/, {
                                initialized: !!result.initialized,
                                totalEntries: totalEntries,
                                entriesWithEmbeddings: withEmbeddings,
                                embeddingCoverage: totalEntries > 0
                                    ? "".concat(((withEmbeddings / totalEntries) * 100).toFixed(1), "%")
                                    : '0%',
                                namespaces: namespaces,
                                backend: 'SQLite + HNSW',
                                version: '3.0.0',
                                features: {
                                    vectorEmbeddings: true,
                                    hnswIndex: true,
                                    semanticSearch: true,
                                },
                            }];
                    case 4:
                        error_6 = _a.sent();
                        return [2 /*return*/, {
                                initialized: false,
                                error: error_6 instanceof Error ? error_6.message : 'Unknown error',
                            }];
                    case 5: return [2 /*return*/];
                }
            });
        }); },
    },
    {
        name: 'memory_migrate',
        description: 'Manually trigger migration from legacy JSON store to SQLite',
        category: 'memory',
        inputSchema: {
            type: 'object',
            properties: {
                force: { type: 'boolean', description: 'Force re-migration even if already done' },
            },
        },
        handler: function (input) { return __awaiter(void 0, void 0, void 0, function () {
            var force, markerPath, _a, migrated, total;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        force = input.force;
                        // Remove migration marker if forcing
                        if (force) {
                            markerPath = getMigrationMarkerPath();
                            if ((0, fs_1.existsSync)(markerPath)) {
                                (0, fs_1.unlinkSync)(markerPath);
                            }
                        }
                        return [4 /*yield*/, (0, memory_router_js_1.ensureRouter)()];
                    case 1:
                        _b.sent();
                        if (!(0, migration_legacy_js_1.hasLegacyStore)()) {
                            return [2 /*return*/, {
                                    success: true,
                                    message: 'No legacy data to migrate',
                                    migrated: 0,
                                }];
                        }
                        return [4 /*yield*/, (0, migration_legacy_js_1.migrateLegacyStore)(function (opts) { return __awaiter(void 0, void 0, void 0, function () {
                                var r;
                                return __generator(this, function (_a) {
                                    switch (_a.label) {
                                        case 0: return [4 /*yield*/, (0, memory_router_js_1.routeMemoryOp)(__assign({ type: 'store' }, opts))];
                                        case 1:
                                            r = _a.sent();
                                            return [2 /*return*/, r];
                                    }
                                });
                            }); })];
                    case 2:
                        _a = _b.sent(), migrated = _a.migrated, total = _a.total;
                        return [2 /*return*/, {
                                success: true,
                                message: 'Migration completed',
                                migrated: migrated,
                                total: total,
                                backend: 'SQLite + HNSW',
                            }];
                }
            });
        }); },
    },
];
