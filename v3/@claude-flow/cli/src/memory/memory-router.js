"use strict";
/**
 * memory-router.ts -- Single entry point for ALL memory operations (ADR-0083 Phase 5)
 *
 * Data flow: MCP tool -> routeMemoryOp() / routeEmbeddingOp() -> storage functions
 * Controller access: getController() -> controller-intercept pool (Phase 4)
 * Embedding: EmbeddingPipeline (Phase 3) for vector operations
 * Config: ResolvedConfig singleton (Phase 1) for dimension/model
 * ADR-0085: JSON sidecar eliminated — intelligence reads from SQLite directly
 *
 * ADR-0084 Phase 4: Route methods use controller-direct (getController) instead of bridge.
 * ADR-0086: Uses RvfBackend (IStorageContract) for storage
 * for actual storage operations (not deleted, not modified -- just wrapped).
 *
 * @module @claude-flow/cli/memory/memory-router
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
exports.resetRouter = exports.shutdownRouter = exports.getAdaptiveThreshold = exports.generateBatchEmbeddings = exports.generateEmbedding = exports.loadEmbeddingModel = exports.routerGetAllEmbeddings = exports.routeCausalOp = exports.routeReflexionOp = exports.routeLearningOp = exports.routeSessionOp = exports.routeFeedbackOp = exports.routePatternOp = exports.routeEmbeddingOp = exports.healthCheck = exports.waitForDeferred = exports.listControllerInfo = exports.hasController = exports.getController = exports.routeMemoryOp = exports.ensureRouter = exports.getCallableMethod = exports.__resolveDatabasePathForTest = void 0;
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var crypto = require("node:crypto");
var types_js_1 = require("../mcp-tools/types.js");
// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------
// ADR-0086 T2.2: IStorageContract imported from @claude-flow/memory/storage.ts (canonical)
// Local any-typed copy deleted — compile-time safety restored via tsconfig reference.
var _storage = null;
var _initialized = false;
var _initPromise = null;
var _initFailed = false; // ADR-0086 I2: prevent retry storm on persistent failure
// ADR-0086 Phase 3: _embeddingFns + _allFns removed (no more initializer dependency).
// Lazy-cached Phase 4 controller-intercept module
var _interceptMod = null;
// ADR-0084 Phase 4: bridge module cache removed — route methods use controller-direct
// ---------------------------------------------------------------------------
// ADR-0085: ControllerRegistry bootstrap (moved from memory-bridge.ts)
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
var _registryInstance = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
var _registryPromise = null;
var _registryAvailable = null;
var _exitHookRegistered = false;
var _embeddingsJsonWarned = false;
// ADR-0094 Sprint 1.4 (d6): advisory-lock path tracked so `process.on('exit')`
// sync handler can release it. `_storage.shutdown()` is async-only, but
// `process.exit(N)` skips `beforeExit` entirely — meaning the async handler
// never runs on the normal CLI exit path. Without a sync fallback, the
// `.rvf.lock` file lingers and the next CLI invocation hits `LockHeld`
// until the 5s budget runs out. Observed in e2e-semantic + e2e-0083-roundtrip
// sequential failures (Pass 4 root cause). Captured at _doInit time so the
// path is available even if `_storage` gets nulled out later.
var _lockPath = null;
function _findProjectRoot() {
    var dir = (0, types_js_1.findProjectRoot)();
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, '.claude-flow')))
            return dir;
        dir = path.dirname(dir);
    }
    return (0, types_js_1.findProjectRoot)();
}
/**
 * ADR-0112 Phase 2 (memory-router track): unified fatal-init error
 * discrimination. Five error classes signal data-integrity / required-
 * dependency failures that MUST propagate so the CLI can surface a
 * specific diagnostic — silently dropping any of them is the ADR-0082
 * silent-fallback antipattern.
 *
 *   - EmbeddingDimensionError: controller-registry's relabel of
 *     DimensionMismatchError (controller-registry.ts:623). Means the
 *     user's stored vectors don't match the configured model.
 *   - DimensionMismatchError: the underlying class from
 *     embedding-pipeline.ts. Direct throws (not via controller-registry)
 *     keep this name. ADR-0112 W1.8 slice 4 found memory-router only
 *     checked the relabelled name, missing direct throws.
 *   - RvfCorruptError: rvf-backend.ts:2305. Disk file corrupted —
 *     surfacing it lets the CLI emit a specific recovery message
 *     instead of a generic "init failed".
 *   - AgentDBInitError: required dep failed under Model 1 (agentdb is
 *     in dependencies, not optionalDependencies — ADR-0111 W1.5/W1.6).
 *   - ControllerInitError: controller-registry's class for individual
 *     controller bootstrap failures (W1.5). Op-layer discriminates so
 *     callers see "<controller> not initialized" not "Storage init failed".
 */
function _isFatalInitError(e) {
    if (!e || !(e instanceof Error))
        return false;
    var name = e.name;
    return name === 'EmbeddingDimensionError'
        || name === 'DimensionMismatchError'
        || name === 'RvfCorruptError'
        || name === 'AgentDBInitError'
        || name === 'ControllerInitError';
}
/**
 * ADR-0069 Bug #3: when the CLI is invoked outside any `.claude-flow/` project
 * context (e.g. `cd /tmp/foo && claude-flow memory store ...`), the previous
 * behavior was to write `./.claude-flow/memory.rvf` relative to whatever
 * process.cwd() happened to be. Two consequences:
 *
 *   1) Each invocation from a different directory wrote to a different file,
 *      so `store` + `retrieve` in separate shells returned "not found".
 *   2) Files were scattered across every directory the user ever ran the CLI
 *      from — invisible, unmanageable, and never cleaned up.
 *
 * Fix: when no ancestor `.claude-flow/` is found AND the caller did not
 * explicitly configure `storage.databasePath`, default to a stable per-user
 * location at `~/.claude-flow/data/memory.rvf`. Inside a project (any ancestor
 * with `.claude-flow/`), keep the original relative-to-project-root behavior
 * so init'd projects still get their own store.
 *
 * Never silently in-memory: if the persistent path can't be created the
 * caller surfaces the error (see _doInit error path) — ADR-0082.
 *
 * @param configuredPath - value from resolve-config (may be the hardcoded
 *   default `.claude-flow/memory.rvf`, may be a user override). If the user
 *   explicitly set this to a non-default absolute path we honor it verbatim.
 */
// Exported for unit tests (ADR-0069 Bug #3). Not part of the public API —
// treat as internal; signature may change. Named with a `__` prefix to make
// the intent obvious at import sites.
function __resolveDatabasePathForTest(configuredPath) {
    return _resolveDatabasePath(configuredPath);
}
exports.__resolveDatabasePathForTest = __resolveDatabasePathForTest;
function _resolveDatabasePath(configuredPath) {
    // :memory: sentinel — pass through unchanged
    if (configuredPath === ':memory:')
        return configuredPath;
    // Absolute path from config override — honor it verbatim. The caller asked
    // for this specific location; don't second-guess.
    if (path.isAbsolute(configuredPath))
        return configuredPath;
    // Relative path. Find project root. _findProjectRoot() returns cwd as
    // fallback when no ancestor `.claude-flow/` exists, so we must also check
    // that the root we found actually has a `.claude-flow/` directory — that
    // tells us whether we're inside a project or just sitting in an arbitrary
    // cwd.
    var projectRoot = _findProjectRoot();
    var inProject = fs.existsSync(path.join(projectRoot, '.claude-flow'));
    if (inProject) {
        // Inside an init'd project — resolve relative to project root so callers
        // in subdirectories still hit the same store.
        return path.resolve(projectRoot, configuredPath);
    }
    // Outside any project context. Use per-user persistent default.
    // $HOME/.claude-flow/data/memory.rvf — mkdir -p is done in _doInit before
    // createStorage() runs.
    return path.join(os.homedir(), '.claude-flow', 'data', 'memory.rvf');
}
function _readProjectConfig() {
    try {
        var cfgPath = path.join((0, types_js_1.findProjectRoot)(), '.claude-flow', 'config.json');
        if (fs.existsSync(cfgPath)) {
            return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        }
    }
    catch ( /* config.json may not exist or may be malformed — use defaults */_a) { /* config.json may not exist or may be malformed — use defaults */ }
    return {};
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _readJsonFile(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    catch (_a) {
        if (!_embeddingsJsonWarned && filePath.endsWith('embeddings.json')) {
            _embeddingsJsonWarned = true;
            console.warn('[config-chain] embeddings.json not found — using fallback defaults. Run "claude-flow init" to generate.');
        }
        return {};
    }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _getProjectConfig() {
    var root = _findProjectRoot();
    return {
        config: _readJsonFile(path.join(root, '.claude-flow', 'config.json')),
        embeddings: _readJsonFile(path.join(root, '.claude-flow', 'embeddings.json')),
    };
}
function _getConfigSwarmDir() {
    var _a, _b;
    try {
        var root = _findProjectRoot();
        var cfg = JSON.parse(fs.readFileSync(path.join(root, '.claude-flow', 'config.json'), 'utf-8'));
        return (_b = (_a = cfg === null || cfg === void 0 ? void 0 : cfg.memory) === null || _a === void 0 ? void 0 : _a.swarmDir) !== null && _b !== void 0 ? _b : '.swarm';
    }
    catch (_c) {
        return '.swarm';
    }
}
function _getDbPath(customPath) {
    var swarmDir = path.resolve((0, types_js_1.findProjectRoot)(), _getConfigSwarmDir());
    if (!customPath)
        return path.join(swarmDir, 'memory.db');
    if (customPath === ':memory:')
        return ':memory:';
    var resolved = path.resolve(customPath);
    var cwd = (0, types_js_1.findProjectRoot)();
    if (!resolved.startsWith(cwd)) {
        return path.join(swarmDir, 'memory.db');
    }
    return resolved;
}
/**
 * ADR-0094 Sprint 1.4 (d6): sync shutdown for `process.on('exit')`.
 *
 * `beforeExit` only fires when Node's event loop drains naturally. Any call
 * to `process.exit(N)` — including the `setTimeout(process.exit(0), 500)`
 * in CLIApp.run() and the error-path exits in handleError — skips beforeExit
 * entirely. The `exit` event fires on BOTH paths but handlers must be
 * synchronous (no promises awaited).
 *
 * This handler does the minimum sync cleanup to avoid lock leaks:
 *  1. Release the `.rvf.lock` file (unlinkSync) if it belongs to this PID
 *  2. Log LOUDLY to stderr on failure (ADR-0082 — never swallow silently)
 *
 * `nativeDb.close()` cannot be called here: we only have a reference to
 * IStorageContract, and the native handle is an internal implementation
 * detail of RvfBackend. The lock release is the critical one — a dangling
 * native handle is freed by process death, but a dangling lock file blocks
 * the next CLI invocation for up to 5s.
 */
function _syncShutdown() {
    if (!_lockPath)
        return;
    try {
        // Only release if the lock belongs to us (PID match). This prevents a
        // racing process from having its lock yanked when we exit.
        if (fs.existsSync(_lockPath)) {
            var isOurs = false;
            try {
                var content = fs.readFileSync(_lockPath, 'utf-8');
                var parsed = JSON.parse(content);
                isOurs = parsed.pid === process.pid;
            }
            catch (_a) {
                // Corrupt or unreadable lock file — treat as ours (we're exiting anyway).
                isOurs = true;
            }
            if (isOurs) {
                fs.unlinkSync(_lockPath);
            }
        }
    }
    catch (err) {
        // ADR-0082: surface loudly to stderr, do NOT swallow. Next process
        // will hit LockHeld on the stale lock — operator needs to see this.
        process.stderr.write("[memory-router] sync shutdown failed to release lock ".concat(_lockPath, " ") +
            "(pid=".concat(process.pid, "): ").concat(err.message, "\n"));
    }
}
function _ensureExitHook() {
    var _this = this;
    if (_exitHookRegistered)
        return;
    _exitHookRegistered = true;
    // `beforeExit` fires on natural event-loop drain and can be async.
    process.on('beforeExit', function () { return __awaiter(_this, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, shutdownRouter()];
                case 1:
                    _b.sent();
                    return [3 /*break*/, 3];
                case 2:
                    _a = _b.sent();
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    }); });
    // ADR-0094 Sprint 1.4 (d6): `exit` fires on BOTH natural drain AND
    // `process.exit(N)`. Handler must be synchronous. This is the critical
    // path for CLI lock-leak prevention since CLIApp.run() calls
    // `setTimeout(process.exit(0), 500).unref()` on every successful command.
    process.on('exit', _syncShutdown);
}
/**
 * Initialize the ControllerRegistry singleton (ADR-0085).
 * Extracted from memory-bridge.ts getRegistry().
 * Returns null if @claude-flow/memory is not available.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function initControllerRegistry(dbPath) {
    return __awaiter(this, void 0, void 0, function () {
        var _neuralCfg;
        var _this = this;
        return __generator(this, function (_a) {
            if (_registryAvailable === false)
                return [2 /*return*/, null];
            if (_registryInstance)
                return [2 /*return*/, _registryInstance];
            _neuralCfg = _readProjectConfig().neural || {};
            if (_neuralCfg.enabled === false) {
                _registryAvailable = false;
                return [2 /*return*/, null];
            }
            if (!_registryPromise) {
                _registryPromise = (function () { return __awaiter(_this, void 0, void 0, function () {
                    var ControllerRegistry, registry, origLog_1, origWarn_1, _consoleRestored_1, _restoreConsole_1, _embDimension, _agentdbCfg, _ec, _a, _b, cfgJson, embJson, _deferredTimeout_1, e_1, agentdbMod, WASMVectorSearch, wasmSearch, _c, e_2;
                    var _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14, _15, _16, _17, _18, _19, _20, _21, _22, _23, _24, _25, _26, _27, _28, _29, _30, _31, _32, _33;
                    return __generator(this, function (_34) {
                        switch (_34.label) {
                            case 0:
                                _34.trys.push([0, 13, , 14]);
                                return [4 /*yield*/, Promise.resolve().then(function () { return require('@claude-flow/memory'); })];
                            case 1:
                                ControllerRegistry = (_34.sent()).ControllerRegistry;
                                registry = new ControllerRegistry();
                                origLog_1 = console.log;
                                origWarn_1 = console.warn;
                                _consoleRestored_1 = false;
                                _restoreConsole_1 = function () {
                                    if (_consoleRestored_1)
                                        return;
                                    _consoleRestored_1 = true;
                                    console.log = origLog_1;
                                    console.warn = origWarn_1;
                                };
                                console.log = function () {
                                    var _args = [];
                                    for (var _i = 0; _i < arguments.length; _i++) {
                                        _args[_i] = arguments[_i];
                                    }
                                };
                                console.warn = function () {
                                    var _args = [];
                                    for (var _i = 0; _i < arguments.length; _i++) {
                                        _args[_i] = arguments[_i];
                                    }
                                };
                                _embDimension = 768;
                                _34.label = 2;
                            case 2:
                                _34.trys.push([2, 4, , 5]);
                                return [4 /*yield*/, Promise.resolve().then(function () { return require('agentdb'); })];
                            case 3:
                                _agentdbCfg = _34.sent();
                                if (_agentdbCfg.getEmbeddingConfig) {
                                    _ec = _agentdbCfg.getEmbeddingConfig();
                                    _embDimension = _ec.dimension;
                                }
                                return [3 /*break*/, 5];
                            case 4:
                                _a = _34.sent();
                                return [3 /*break*/, 5];
                            case 5:
                                _34.trys.push([5, 7, , 8]);
                                _b = _getProjectConfig(), cfgJson = _b.config, embJson = _b.embeddings;
                                _deferredTimeout_1 = setTimeout(_restoreConsole_1, 120000);
                                _deferredTimeout_1.unref();
                                registry.once('deferred:initialized', function () {
                                    clearTimeout(_deferredTimeout_1);
                                    _restoreConsole_1();
                                });
                                return [4 /*yield*/, registry.initialize({
                                        dbPath: dbPath || _getDbPath(),
                                        dimension: (_d = embJson.dimension) !== null && _d !== void 0 ? _d : 768,
                                        embeddingModel: (_e = embJson.model) !== null && _e !== void 0 ? _e : 'Xenova/all-mpnet-base-v2',
                                        // ADR-0111 W1.5 — RVF-primary fail-loud (memory project-rvf-primary).
                                        // 'ruvector' forces the native NAPI backend; 'auto' could silently
                                        // fall through to hnswlib when the native binary is missing, which
                                        // contradicts our fail-loud stance.
                                        vectorBackend: 'ruvector',
                                        hnswM: (_g = (_f = embJson.hnsw) === null || _f === void 0 ? void 0 : _f.m) !== null && _g !== void 0 ? _g : 23,
                                        hnswEfConstruction: (_j = (_h = embJson.hnsw) === null || _h === void 0 ? void 0 : _h.efConstruction) !== null && _j !== void 0 ? _j : 100,
                                        hnswEfSearch: (_l = (_k = embJson.hnsw) === null || _k === void 0 ? void 0 : _k.efSearch) !== null && _l !== void 0 ? _l : 50,
                                        maxElements: (_o = (_m = cfgJson.memory) === null || _m === void 0 ? void 0 : _m.maxElements) !== null && _o !== void 0 ? _o : 100000,
                                        maxEntries: (_t = (_q = (_p = cfgJson.memory) === null || _p === void 0 ? void 0 : _p.maxEntries) !== null && _q !== void 0 ? _q : (_s = (_r = cfgJson.memory) === null || _r === void 0 ? void 0 : _r.storage) === null || _s === void 0 ? void 0 : _s.maxEntries) !== null && _t !== void 0 ? _t : 100000,
                                        similarityThreshold: (_v = (_u = cfgJson.memory) === null || _u === void 0 ? void 0 : _u.similarityThreshold) !== null && _v !== void 0 ? _v : 0.7,
                                        swarmDir: (_x = (_w = cfgJson.memory) === null || _w === void 0 ? void 0 : _w.swarmDir) !== null && _x !== void 0 ? _x : '.swarm',
                                        sqlite: (_z = (_y = cfgJson.memory) === null || _y === void 0 ? void 0 : _y.sqlite) !== null && _z !== void 0 ? _z : { cacheSize: -64000, busyTimeoutMs: 5000, journalMode: 'WAL', synchronous: 'NORMAL' },
                                        memory: {
                                            learningBridge: (_0 = cfgJson.memory) === null || _0 === void 0 ? void 0 : _0.learningBridge,
                                            memoryGraph: (_1 = cfgJson.memory) === null || _1 === void 0 ? void 0 : _1.memoryGraph,
                                            tieredCache: (_2 = cfgJson.controllers) === null || _2 === void 0 ? void 0 : _2.tieredCache,
                                        },
                                        attentionService: (_3 = cfgJson.controllers) === null || _3 === void 0 ? void 0 : _3.attentionService,
                                        multiHeadAttention: (_4 = cfgJson.controllers) === null || _4 === void 0 ? void 0 : _4.multiHeadAttention,
                                        selfAttention: (_5 = cfgJson.controllers) === null || _5 === void 0 ? void 0 : _5.selfAttention,
                                        rateLimiter: (_9 = (_7 = (_6 = cfgJson.rateLimiter) === null || _6 === void 0 ? void 0 : _6.default) !== null && _7 !== void 0 ? _7 : (_8 = cfgJson.controllers) === null || _8 === void 0 ? void 0 : _8.rateLimiter) !== null && _9 !== void 0 ? _9 : { maxRequests: 100, windowMs: 60000 },
                                        rateLimiterPresets: (_10 = cfgJson.rateLimiter) !== null && _10 !== void 0 ? _10 : null,
                                        circuitBreaker: (_11 = cfgJson.controllers) === null || _11 === void 0 ? void 0 : _11.circuitBreaker,
                                        solverBandit: (_12 = cfgJson.controllers) === null || _12 === void 0 ? void 0 : _12.solverBandit,
                                        controllers: __assign({ reasoningBank: true, learningBridge: ((_14 = (_13 = cfgJson.memory) === null || _13 === void 0 ? void 0 : _13.learningBridge) === null || _14 === void 0 ? void 0 : _14.enabled) === true, tieredCache: true, hierarchicalMemory: true, memoryConsolidation: true, enhancedEmbedding: true, memoryGraph: true, mutationGuard: true, attestationLog: true, learningSystem: true, explainableRecall: true, nightlyLearner: true, semanticRouter: true, 
                                            // sparkling/ruflo W5-A3: sonaTrajectory (SonaTrajectoryService) is
                                            // opt-in in @claude-flow/memory's ControllerRegistry
                                            // (isControllerEnabled returns false by default, line 1125-1126).
                                            // W2-I5's agentdb_sona_trajectory_store MCP tool dispatches to
                                            // getController('sonaTrajectory') and surfaced "SonaTrajectoryService
                                            // controller not available" because the registry never initialized
                                            // the controller. Enable it here so the standard ControllerRegistry
                                            // pipeline (Level 5 init → createController case 'sonaTrajectory'
                                            // → agentdb.getController('sonaTrajectory')) wires a real instance.
                                            sonaTrajectory: true, 
                                            // graphAdapter is opt-in because it requires @ruvector/graph-node
                                            // (native binding) to be installed and a persistent storagePath.
                                            // Users opt in via `cli config set --key controllers.graphAdapter
                                            // --value true`. When true, agentdb is constructed with
                                            // enableGraph:true at controller-registry.ts:993 and the native
                                            // backend initializes with storagePath = dbPath.
                                            graphAdapter: ((_15 = cfgJson.controllers) === null || _15 === void 0 ? void 0 : _15.graphAdapter) === true }, ((_17 = (_16 = cfgJson.controllers) === null || _16 === void 0 ? void 0 : _16.enabled) !== null && _17 !== void 0 ? _17 : {})),
                                        nightlyLearner: (_18 = cfgJson.controllers) === null || _18 === void 0 ? void 0 : _18.nightlyLearner,
                                        causalRecall: (_19 = cfgJson.controllers) === null || _19 === void 0 ? void 0 : _19.causalRecall,
                                        queryOptimizer: (_20 = cfgJson.controllers) === null || _20 === void 0 ? void 0 : _20.queryOptimizer,
                                        selfLearningRvfBackend: (_21 = cfgJson.controllers) === null || _21 === void 0 ? void 0 : _21.selfLearningRvfBackend,
                                        mutationGuard: (_22 = cfgJson.controllers) === null || _22 === void 0 ? void 0 : _22.mutationGuard,
                                        ports: {
                                            mcp: parseInt(process.env.MCP_PORT || '', 10) || ((_24 = (_23 = cfgJson.ports) === null || _23 === void 0 ? void 0 : _23.mcp) !== null && _24 !== void 0 ? _24 : 3000),
                                            mcpWebSocket: parseInt(process.env.MCP_WS_PORT || '', 10) || ((_26 = (_25 = cfgJson.ports) === null || _25 === void 0 ? void 0 : _25.mcpWebSocket) !== null && _26 !== void 0 ? _26 : 3001),
                                            quic: parseInt(process.env.QUIC_PORT || '', 10) || ((_28 = (_27 = cfgJson.ports) === null || _27 === void 0 ? void 0 : _27.quic) !== null && _28 !== void 0 ? _28 : 4433),
                                            federation: parseInt(process.env.FEDERATION_PORT || '', 10) || ((_30 = (_29 = cfgJson.ports) === null || _29 === void 0 ? void 0 : _29.federation) !== null && _30 !== void 0 ? _30 : 8443),
                                            health: parseInt(process.env.HEALTH_PORT || '', 10) || ((_32 = (_31 = cfgJson.ports) === null || _31 === void 0 ? void 0 : _31.health) !== null && _32 !== void 0 ? _32 : 8080),
                                        },
                                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    })];
                            case 6:
                                _34.sent();
                                void Promise.resolve().then(function () {
                                    setTimeout(_restoreConsole_1, 500);
                                });
                                return [3 /*break*/, 8];
                            case 7:
                                e_1 = _34.sent();
                                _restoreConsole_1();
                                // ADR-0090 Tier B1 + ADR-0111 W1.6 + ADR-0112 Phase 2 (memory-router
                                // track): dimension mismatch (both relabelled and direct), RVF
                                // corruption, agentdb-init, and controller-init are FATAL — not
                                // best-effort registry-init failures. Silently disabling the
                                // registry on any of them masks data-loss regressions per ADR-0082.
                                if (_isFatalInitError(e_1))
                                    throw e_1;
                                throw new Error('registry init failed');
                            case 8:
                                _registryInstance = registry;
                                _registryAvailable = true;
                                _34.label = 9;
                            case 9:
                                _34.trys.push([9, 11, , 12]);
                                return [4 /*yield*/, Promise.resolve().then(function () { return require('agentdb'); })];
                            case 10:
                                agentdbMod = _34.sent();
                                WASMVectorSearch = agentdbMod.WASMVectorSearch || ((_33 = agentdbMod.default) === null || _33 === void 0 ? void 0 : _33.WASMVectorSearch);
                                if (WASMVectorSearch) {
                                    wasmSearch = new WASMVectorSearch({
                                        dimension: _embDimension,
                                        wasmAvailable: false,
                                    });
                                    registry.register('wasmVectorSearch', wasmSearch);
                                }
                                return [3 /*break*/, 12];
                            case 11:
                                _c = _34.sent();
                                return [3 /*break*/, 12];
                            case 12:
                                _ensureExitHook();
                                return [2 /*return*/, registry];
                            case 13:
                                e_2 = _34.sent();
                                _registryAvailable = false;
                                _registryPromise = null;
                                // ADR-0090 Tier B1 + ADR-0111 W1.6 + ADR-0112 Phase 2: re-throw all
                                // fatal init classes. The caller (_doInit) wraps in its own best-
                                // effort try/catch, but those must not swallow these classes either.
                                if (_isFatalInitError(e_2))
                                    throw e_2;
                                return [2 /*return*/, null];
                            case 14: return [2 /*return*/];
                        }
                    });
                }); })();
            }
            return [2 /*return*/, _registryPromise];
        });
    });
}
// ---------------------------------------------------------------------------
// Lazy loaders
// ---------------------------------------------------------------------------
// ADR-0086 T2.2: RvfBackend replaces loadStorageFns
// ADR-0095 amendment d2 (ruflo-patch): route through storage-factory so both
// CLI and controller-registry hit the same resolved-path cache and the
// `tryNativeInit` work collapses from 2× to 1× per CLI invocation. Also
// `path.resolve()` here so a relative path passed to createStorage yields
// the same cache key as the absolute path passed by controller-registry.
function createStorage(config) {
    return __awaiter(this, void 0, void 0, function () {
        var memMod, backend;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve("".concat('@claude-flow/memory/storage-factory')).then(function (s) { return require(s); })];
                case 1:
                    memMod = _a.sent();
                    return [4 /*yield*/, memMod.createStorage({
                            databasePath: path.resolve(config.databasePath),
                            dimensions: config.dimensions,
                        })];
                case 2:
                    backend = _a.sent();
                    // IStorage and IStorageContract are both aliases for IMemoryBackend
                    // (memory/storage.ts lines 20 & 29). Single cast hop, not a real conversion.
                    return [2 /*return*/, backend];
            }
        });
    });
}
function loadIntercept() {
    return __awaiter(this, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (_interceptMod)
                        return [2 /*return*/, _interceptMod];
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, Promise.resolve("".concat('@claude-flow/memory/controller-intercept')).then(function (s) { return require(s); })];
                case 2:
                    _interceptMod = _b.sent();
                    return [3 /*break*/, 4];
                case 3:
                    _a = _b.sent();
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/, _interceptMod];
            }
        });
    });
}
// ---------------------------------------------------------------------------
// Phase 4 helpers — controller-direct (replaces loadBridge)
// ---------------------------------------------------------------------------
/** Generate a secure random ID (inlined from memory-bridge). */
function generateId(prefix) {
    return "".concat(prefix, "_").concat(Date.now(), "_").concat(crypto.randomBytes(8).toString('hex'));
}
/**
 * Probe a controller for a callable method across binding patterns.
 * Controllers may be wrapped as module objects, class instances, or nested objects.
 * Inlined from memory-bridge getCallableMethod (OPT-001/OPT-002).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getCallableMethod(obj) {
    var names = [];
    for (var _i = 1; _i < arguments.length; _i++) {
        names[_i - 1] = arguments[_i];
    }
    if (!obj)
        return null;
    for (var _a = 0, names_1 = names; _a < names_1.length; _a++) {
        var name_1 = names_1[_a];
        if (typeof obj[name_1] === 'function')
            return obj[name_1].bind(obj);
        if (obj.default && typeof obj.default[name_1] === 'function')
            return obj.default[name_1].bind(obj.default);
        if (obj.instance && typeof obj.instance[name_1] === 'function')
            return obj.instance[name_1].bind(obj.instance);
        if (obj.controller && typeof obj.controller[name_1] === 'function')
            return obj.controller[name_1].bind(obj.controller);
    }
    return null;
}
exports.getCallableMethod = getCallableMethod;
// ADR-0086 Phase 3: loadEmbeddingFns + loadAllFns deleted (no more initializer dependency).
// ---------------------------------------------------------------------------
// JSON sidecar (intelligence.cjs CJS contract)
// ---------------------------------------------------------------------------
// ADR-0085: writeJsonSidecar removed — intelligence.cjs reads from SQLite directly
// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
function _doInit() {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function () {
        var databasePath, dimensions, configMod, config, pipelineMod, _c, _d, e_3, e_4;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    if (_initialized)
                        return [2 /*return*/];
                    databasePath = '.claude-flow/memory.rvf';
                    dimensions = 768;
                    _e.label = 1;
                case 1:
                    _e.trys.push([1, 9, , 10]);
                    return [4 /*yield*/, Promise.resolve("".concat('@claude-flow/memory/resolve-config')).then(function (s) { return require(s); })];
                case 2:
                    configMod = _e.sent();
                    config = configMod.getConfig();
                    databasePath = ((_a = config.storage) === null || _a === void 0 ? void 0 : _a.databasePath) || databasePath;
                    dimensions = ((_b = config.embedding) === null || _b === void 0 ? void 0 : _b.dimension) || dimensions;
                    _e.label = 3;
                case 3:
                    _e.trys.push([3, 7, , 8]);
                    return [4 /*yield*/, Promise.resolve("".concat('@claude-flow/memory/embedding-pipeline')).then(function (s) { return require(s); })];
                case 4:
                    pipelineMod = _e.sent();
                    if (!(pipelineMod === null || pipelineMod === void 0 ? void 0 : pipelineMod.initPipeline)) return [3 /*break*/, 6];
                    return [4 /*yield*/, pipelineMod.initPipeline(config.embedding)];
                case 5:
                    _e.sent();
                    _e.label = 6;
                case 6: return [3 /*break*/, 8];
                case 7:
                    _c = _e.sent();
                    return [3 /*break*/, 8];
                case 8: return [3 /*break*/, 10];
                case 9:
                    _d = _e.sent();
                    return [3 /*break*/, 10];
                case 10:
                    // ADR-0069 Bug #3: resolve the database path to a per-user default when
                    // the CLI is invoked outside any project context, so `memory store` and
                    // `memory retrieve` in separate invocations hit the same file. See
                    // _resolveDatabasePath() for the full decision tree.
                    databasePath = _resolveDatabasePath(databasePath);
                    // ADR-0086 T2.2: Create RvfBackend (IStorageContract) instead of SQLite initializer
                    // ADR-0094 Sprint 1.4 (d6): capture lockPath for sync shutdown path.
                    // ADR-0095 amendment (2026-05-01, swarm-confirmed t3-2 fix): the JS-side
                    // advisory lock lives at `path + '.jslock'`, NOT `path + '.lock'`. The
                    // latter is the NATIVE rvf-runtime FLVR-format binary lock; if we set
                    // `_lockPath` to that path, `_syncShutdown` reads the native binary, fails
                    // to JSON.parse it, falls into the `catch { isOurs = true }` path, and
                    // `unlinkSync`s a peer's native lock on every CLI exit — directly
                    // producing the LockHeld 0x0300 / FsyncFailed 0x0303 errors and the
                    // silent-loss races observed in t3-2. Confirmed via 10-agent swarm
                    // analysis 2026-05-01 + diag-rvf-interproc-race.mjs --trials 40 (0/40
                    // before fix). See rvf-backend.ts constructor comment for the .jslock
                    // rename rationale.
                    if (databasePath && databasePath !== ':memory:')
                        _lockPath = databasePath + '.jslock';
                    _e.label = 11;
                case 11:
                    _e.trys.push([11, 13, , 14]);
                    // ADR-0069 Bug #3: ensure the parent directory exists before RvfBackend
                    // tries to open the file. The per-user path `$HOME/.claude-flow/data/`
                    // may not exist on first run. mkdirSync failure propagates into this
                    // catch, which trips the single ADR-0086 circuit-breaker path below —
                    // no secondary _initFailed assignment (honors the "exactly 3 assignments"
                    // state-machine invariant).
                    if (databasePath !== ':memory:') {
                        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
                    }
                    return [4 /*yield*/, createStorage({ databasePath: databasePath, dimensions: dimensions })];
                case 12:
                    _storage = _e.sent();
                    return [3 /*break*/, 14];
                case 13:
                    e_3 = _e.sent();
                    // ADR-0086 B4: circuit breaker — storage creation failed.
                    _storage = null;
                    _initFailed = true; // ADR-0086 I2: prevent retry storm.
                    // ADR-0090 Tier B1/B2 + ADR-0111 W1.6 + ADR-0112 Phase 2 (memory-router
                    // track): preserve all fatal error classes (DimensionMismatchError direct
                    // throws are now caught too — slice 4 found those slipped through).
                    if (_isFatalInitError(e_3))
                        throw e_3;
                    throw new Error('Storage initialization failed: ' + (e_3 instanceof Error ? e_3.message : String(e_3)));
                case 14:
                    if (!_storage) {
                        throw new Error('Storage initialization returned null');
                    }
                    _e.label = 15;
                case 15:
                    _e.trys.push([15, 17, , 18]);
                    return [4 /*yield*/, initControllerRegistry()];
                case 16:
                    _e.sent();
                    return [3 /*break*/, 18];
                case 17:
                    e_4 = _e.sent();
                    // ADR-0112 Phase 2 (memory-router track): unified fatal-init
                    // discrimination — slice 4 added DimensionMismatchError + RvfCorruptError
                    // + ControllerInitError to the set previously limited to the relabelled
                    // EmbeddingDimensionError + AgentDBInitError.
                    if (_isFatalInitError(e_4))
                        throw e_4;
                    return [3 /*break*/, 18];
                case 18:
                    _initialized = true;
                    return [2 /*return*/];
            }
        });
    });
}
/** Ensure the router (storage + pipeline) is initialized. */
function ensureRouter() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            if (_initialized)
                return [2 /*return*/];
            // ADR-0086 I2: fast-fail on persistent init failure — prevents retry storm
            if (_initFailed)
                throw new Error('Storage initialization permanently failed. Call resetRouter() or restart the process to retry.');
            if (_initPromise)
                return [2 /*return*/, _initPromise];
            _initPromise = _doInit().finally(function () { _initPromise = null; });
            return [2 /*return*/, _initPromise];
        });
    });
}
exports.ensureRouter = ensureRouter;
// ---------------------------------------------------------------------------
// Core: routeMemoryOp
// ---------------------------------------------------------------------------
/**
 * Single entry point for CRUD memory operations.
 * ADR-0086 T2.3: Routes through IStorageContract (RvfBackend).
 */
function routeMemoryOp(op) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    return __awaiter(this, void 0, void 0, function () {
        var storage, _o, id, namespace, now, embedding, adapterMod, result, _p, existing, existingContent, newContent, sameValue, entry, e_5, searchNamespace, entryCount, _q, pipelineProvider, pipelineMod, pipeline, adapterMod, e_6, BM25_MAX_CORPUS, entries, bm25Mod, ranked, results, e_7, embedding, adaptiveThreshold, adapterMod, result, e_8, raw, results, e_9, entry, e_10, entry, e_11, namespace, entries, total, e_12, stats, health, namespaceList, namespaces, _i, namespaceList_1, ns, _r, _s, e_13, count, e_14, namespaces, e_15, e_16, ns, e_17;
        return __generator(this, function (_t) {
            switch (_t.label) {
                case 0: return [4 /*yield*/, ensureRouter()];
                case 1:
                    _t.sent();
                    // ADR-0086 B4: defense-in-depth null guard
                    if (!_storage) {
                        return [2 /*return*/, { success: false, error: 'Storage not initialized. Call ensureRouter() first.' }];
                    }
                    storage = _storage;
                    _o = op.type;
                    switch (_o) {
                        case 'store': return [3 /*break*/, 2];
                        case 'search': return [3 /*break*/, 13];
                        case 'get': return [3 /*break*/, 39];
                        case 'delete': return [3 /*break*/, 42];
                        case 'list': return [3 /*break*/, 47];
                        case 'stats': return [3 /*break*/, 51];
                        case 'count': return [3 /*break*/, 60];
                        case 'listNamespaces': return [3 /*break*/, 63];
                        case 'bulkDelete': return [3 /*break*/, 66];
                        case 'clearNamespace': return [3 /*break*/, 70];
                    }
                    return [3 /*break*/, 74];
                case 2:
                    _t.trys.push([2, 12, , 13]);
                    id = generateId('mem');
                    namespace = op.namespace || 'default';
                    now = Date.now();
                    embedding = void 0;
                    if (!(op.generateEmbedding !== false && op.value)) return [3 /*break*/, 7];
                    _t.label = 3;
                case 3:
                    _t.trys.push([3, 6, , 7]);
                    return [4 /*yield*/, Promise.resolve("".concat('@claude-flow/memory/embedding-adapter')).then(function (s) { return require(s); })];
                case 4:
                    adapterMod = _t.sent();
                    return [4 /*yield*/, adapterMod.generateEmbedding(op.value)];
                case 5:
                    result = _t.sent();
                    embedding = new Float32Array(result.embedding);
                    return [3 /*break*/, 7];
                case 6:
                    _p = _t.sent();
                    return [3 /*break*/, 7];
                case 7:
                    if (!op.key) return [3 /*break*/, 10];
                    return [4 /*yield*/, storage.getByKey(namespace, op.key)];
                case 8:
                    existing = _t.sent();
                    if (!existing) return [3 /*break*/, 10];
                    existingContent = (_a = existing.content) !== null && _a !== void 0 ? _a : '';
                    newContent = (_b = op.value) !== null && _b !== void 0 ? _b : '';
                    sameValue = existingContent === newContent;
                    if (sameValue) {
                        // Idempotent no-op: same (key, value, namespace) — return existing entry
                        return [2 /*return*/, {
                                success: true, key: op.key, stored: true,
                                storedAt: new Date((_c = existing.createdAt) !== null && _c !== void 0 ? _c : now).toISOString(),
                                hasEmbedding: !!existing.embedding,
                                embeddingDimensions: (_e = (_d = existing.embedding) === null || _d === void 0 ? void 0 : _d.length) !== null && _e !== void 0 ? _e : null,
                                idempotent: true,
                            }];
                    }
                    if (!op.upsert) {
                        return [2 /*return*/, {
                                success: false,
                                key: op.key,
                                stored: false,
                                error: "'key' already exists in this namespace with a different value; set upsert:true to replace",
                            }];
                    }
                    // upsert === true and value differs → overwrite
                    return [4 /*yield*/, storage.update(existing.id, {
                            content: op.value,
                            tags: op.tags,
                            metadata: __assign(__assign({}, (existing.metadata || {})), { ttl: op.ttl }),
                        })];
                case 9:
                    // upsert === true and value differs → overwrite
                    _t.sent();
                    return [2 /*return*/, {
                            success: true, key: op.key, stored: true,
                            storedAt: new Date().toISOString(),
                            hasEmbedding: !!embedding, embeddingDimensions: (embedding === null || embedding === void 0 ? void 0 : embedding.length) || null,
                        }];
                case 10:
                    entry = {
                        id: id,
                        key: op.key || id,
                        content: op.value || '',
                        embedding: embedding,
                        type: 'semantic',
                        namespace: namespace,
                        tags: op.tags || [],
                        metadata: op.ttl ? { ttl: op.ttl } : {},
                        accessLevel: 'private',
                        createdAt: now,
                        updatedAt: now,
                        version: 1,
                        references: [],
                        accessCount: 0,
                        lastAccessedAt: now,
                    };
                    return [4 /*yield*/, storage.store(entry)];
                case 11:
                    _t.sent();
                    return [2 /*return*/, {
                            success: true, key: op.key, stored: true,
                            storedAt: new Date().toISOString(),
                            hasEmbedding: !!embedding, embeddingDimensions: (embedding === null || embedding === void 0 ? void 0 : embedding.length) || null,
                        }];
                case 12:
                    e_5 = _t.sent();
                    return [2 /*return*/, { success: false, error: "store failed: ".concat(e_5 instanceof Error ? e_5.message : String(e_5)) }];
                case 13:
                    searchNamespace = op.namespace === 'all' ? undefined : op.namespace;
                    _t.label = 14;
                case 14:
                    _t.trys.push([14, 16, , 17]);
                    return [4 /*yield*/, storage.count(searchNamespace)];
                case 15:
                    entryCount = _t.sent();
                    if (entryCount === 0) {
                        return [2 /*return*/, { success: true, results: [], total: 0 }];
                    }
                    return [3 /*break*/, 17];
                case 16:
                    _q = _t.sent();
                    return [3 /*break*/, 17];
                case 17:
                    pipelineProvider = null;
                    _t.label = 18;
                case 18:
                    _t.trys.push([18, 23, , 24]);
                    return [4 /*yield*/, Promise.resolve("".concat('@claude-flow/memory/embedding-pipeline')).then(function (s) { return require(s); })];
                case 19:
                    pipelineMod = _t.sent();
                    pipeline = (_f = pipelineMod.getPipeline) === null || _f === void 0 ? void 0 : _f.call(pipelineMod);
                    if (!(!pipeline || !((_g = pipeline.isInitialized) === null || _g === void 0 ? void 0 : _g.call(pipeline)))) return [3 /*break*/, 22];
                    return [4 /*yield*/, Promise.resolve("".concat('@claude-flow/memory/embedding-adapter')).then(function (s) { return require(s); })];
                case 20:
                    adapterMod = _t.sent();
                    return [4 /*yield*/, adapterMod.loadEmbeddingModel()];
                case 21:
                    _t.sent();
                    pipeline = (_h = pipelineMod.getPipeline) === null || _h === void 0 ? void 0 : _h.call(pipelineMod);
                    _t.label = 22;
                case 22:
                    if (pipeline === null || pipeline === void 0 ? void 0 : pipeline.getProvider)
                        pipelineProvider = pipeline.getProvider();
                    return [3 /*break*/, 24];
                case 23:
                    e_6 = _t.sent();
                    // Provider detection is advisory — fall through to the embedding
                    // path, which will surface its own error if the pipeline is broken.
                    pipelineProvider = null;
                    return [3 /*break*/, 24];
                case 24:
                    if (!(pipelineProvider === 'hash-fallback')) return [3 /*break*/, 29];
                    _t.label = 25;
                case 25:
                    _t.trys.push([25, 28, , 29]);
                    BM25_MAX_CORPUS = 10000;
                    return [4 /*yield*/, storage.query({
                            type: 'prefix',
                            namespace: searchNamespace,
                            limit: BM25_MAX_CORPUS,
                            offset: 0,
                        })];
                case 26:
                    entries = _t.sent();
                    return [4 /*yield*/, Promise.resolve("".concat('@claude-flow/memory/bm25')).then(function (s) { return require(s); })];
                case 27:
                    bm25Mod = _t.sent();
                    ranked = bm25Mod.bm25Rank(op.query || '', entries, {
                        limit: op.limit || 10,
                    });
                    results = ranked.map(function (r) { return ({
                        key: r.entry.key,
                        score: r.score,
                        namespace: r.entry.namespace,
                        content: r.entry.content,
                    }); });
                    return [2 /*return*/, { success: true, results: results, total: results.length }];
                case 28:
                    e_7 = _t.sent();
                    return [2 /*return*/, { success: false, error: "bm25 search failed: ".concat(e_7 instanceof Error ? e_7.message : String(e_7)) }];
                case 29:
                    embedding = void 0;
                    adaptiveThreshold = void 0;
                    _t.label = 30;
                case 30:
                    _t.trys.push([30, 35, , 36]);
                    return [4 /*yield*/, Promise.resolve("".concat('@claude-flow/memory/embedding-adapter')).then(function (s) { return require(s); })];
                case 31:
                    adapterMod = _t.sent();
                    return [4 /*yield*/, adapterMod.generateEmbedding(op.query || '', { intent: 'query' })];
                case 32:
                    result = _t.sent();
                    embedding = new Float32Array(result.embedding);
                    if (!adapterMod.getAdaptiveThreshold) return [3 /*break*/, 34];
                    return [4 /*yield*/, adapterMod.getAdaptiveThreshold(op.threshold)];
                case 33:
                    adaptiveThreshold = _t.sent();
                    _t.label = 34;
                case 34: return [3 /*break*/, 36];
                case 35:
                    e_8 = _t.sent();
                    return [2 /*return*/, { success: false, error: 'Embedding generation failed: ' + (e_8 instanceof Error ? e_8.message : String(e_8)) }];
                case 36:
                    _t.trys.push([36, 38, , 39]);
                    return [4 /*yield*/, storage.search(embedding, {
                            k: op.limit || 10,
                            threshold: (_j = adaptiveThreshold !== null && adaptiveThreshold !== void 0 ? adaptiveThreshold : op.threshold) !== null && _j !== void 0 ? _j : 0.3,
                            filters: searchNamespace ? { namespace: searchNamespace } : undefined,
                        })];
                case 37:
                    raw = _t.sent();
                    results = raw.map(function (r) { return ({
                        key: r.entry.key,
                        score: r.score,
                        namespace: r.entry.namespace,
                        content: r.entry.content,
                    }); });
                    return [2 /*return*/, { success: true, results: results, total: results.length }];
                case 38:
                    e_9 = _t.sent();
                    return [2 /*return*/, { success: false, error: "search failed: ".concat(e_9 instanceof Error ? e_9.message : String(e_9)) }];
                case 39:
                    _t.trys.push([39, 41, , 42]);
                    return [4 /*yield*/, storage.getByKey(op.namespace || 'default', op.key || '')];
                case 40:
                    entry = _t.sent();
                    return [2 /*return*/, {
                            success: true,
                            found: !!entry,
                            entry: entry || null,
                        }];
                case 41:
                    e_10 = _t.sent();
                    return [2 /*return*/, { success: false, error: "get failed: ".concat(e_10 instanceof Error ? e_10.message : String(e_10)) }];
                case 42:
                    _t.trys.push([42, 46, , 47]);
                    return [4 /*yield*/, storage.getByKey(op.namespace || 'default', op.key || '')];
                case 43:
                    entry = _t.sent();
                    if (!entry) return [3 /*break*/, 45];
                    return [4 /*yield*/, storage.delete(entry.id)];
                case 44:
                    _t.sent();
                    return [2 /*return*/, { success: true, deleted: true }];
                case 45: return [2 /*return*/, { success: true, deleted: false }];
                case 46:
                    e_11 = _t.sent();
                    return [2 /*return*/, { success: false, error: "delete failed: ".concat(e_11 instanceof Error ? e_11.message : String(e_11)) }];
                case 47:
                    _t.trys.push([47, 50, , 51]);
                    namespace = op.namespace === 'all' ? undefined : op.namespace;
                    return [4 /*yield*/, storage.query({
                            type: 'prefix',
                            namespace: namespace,
                            limit: op.limit || 50,
                            offset: op.offset || 0,
                        })];
                case 48:
                    entries = _t.sent();
                    return [4 /*yield*/, storage.count(namespace)];
                case 49:
                    total = _t.sent();
                    return [2 /*return*/, { success: true, entries: entries, total: total }];
                case 50:
                    e_12 = _t.sent();
                    return [2 /*return*/, { success: false, error: "list failed: ".concat(e_12 instanceof Error ? e_12.message : String(e_12)) }];
                case 51:
                    _t.trys.push([51, 59, , 60]);
                    return [4 /*yield*/, storage.getStats()];
                case 52:
                    stats = _t.sent();
                    return [4 /*yield*/, storage.healthCheck()];
                case 53:
                    health = _t.sent();
                    return [4 /*yield*/, storage.listNamespaces()];
                case 54:
                    namespaceList = _t.sent();
                    namespaces = {};
                    _i = 0, namespaceList_1 = namespaceList;
                    _t.label = 55;
                case 55:
                    if (!(_i < namespaceList_1.length)) return [3 /*break*/, 58];
                    ns = namespaceList_1[_i];
                    _r = namespaces;
                    _s = ns;
                    return [4 /*yield*/, storage.count(ns)];
                case 56:
                    _r[_s] = _t.sent();
                    _t.label = 57;
                case 57:
                    _i++;
                    return [3 /*break*/, 55];
                case 58: return [2 /*return*/, {
                        success: true,
                        initialized: health.status === 'healthy',
                        totalEntries: (_k = stats.totalEntries) !== null && _k !== void 0 ? _k : 0,
                        entriesWithEmbeddings: (_m = (_l = stats.entriesWithEmbeddings) !== null && _l !== void 0 ? _l : stats.totalEntries) !== null && _m !== void 0 ? _m : 0,
                        namespaces: namespaces,
                    }];
                case 59:
                    e_13 = _t.sent();
                    return [2 /*return*/, { success: false, error: "stats failed: ".concat(e_13 instanceof Error ? e_13.message : String(e_13)) }];
                case 60:
                    _t.trys.push([60, 62, , 63]);
                    return [4 /*yield*/, storage.count(op.namespace === 'all' ? undefined : op.namespace)];
                case 61:
                    count = _t.sent();
                    return [2 /*return*/, { success: true, count: count }];
                case 62:
                    e_14 = _t.sent();
                    return [2 /*return*/, { success: false, error: "count failed: ".concat(e_14 instanceof Error ? e_14.message : String(e_14)) }];
                case 63:
                    _t.trys.push([63, 65, , 66]);
                    return [4 /*yield*/, storage.listNamespaces()];
                case 64:
                    namespaces = _t.sent();
                    return [2 /*return*/, { success: true, namespaces: namespaces }];
                case 65:
                    e_15 = _t.sent();
                    return [2 /*return*/, { success: false, error: "listNamespaces failed: ".concat(e_15 instanceof Error ? e_15.message : String(e_15)) }];
                case 66:
                    if (!op.ids || op.ids.length === 0) {
                        return [2 /*return*/, { success: false, error: 'bulkDelete requires ids array' }];
                    }
                    _t.label = 67;
                case 67:
                    _t.trys.push([67, 69, , 70]);
                    // ADR-0086 B2: bulkDelete was missing from router switch
                    return [4 /*yield*/, storage.bulkDelete(op.ids)];
                case 68:
                    // ADR-0086 B2: bulkDelete was missing from router switch
                    _t.sent();
                    return [2 /*return*/, { success: true, deleted: op.ids.length }];
                case 69:
                    e_16 = _t.sent();
                    return [2 /*return*/, { success: false, error: "bulkDelete failed: ".concat(e_16 instanceof Error ? e_16.message : String(e_16)) }];
                case 70:
                    ns = op.namespace;
                    if (!ns) {
                        return [2 /*return*/, { success: false, error: 'clearNamespace requires namespace' }];
                    }
                    _t.label = 71;
                case 71:
                    _t.trys.push([71, 73, , 74]);
                    // ADR-0086 B2: clearNamespace was missing from router switch
                    return [4 /*yield*/, storage.clearNamespace(ns)];
                case 72:
                    // ADR-0086 B2: clearNamespace was missing from router switch
                    _t.sent();
                    return [2 /*return*/, { success: true, cleared: true, namespace: ns }];
                case 73:
                    e_17 = _t.sent();
                    return [2 /*return*/, { success: false, error: "clearNamespace failed: ".concat(e_17 instanceof Error ? e_17.message : String(e_17)) }];
                case 74: return [2 /*return*/, { success: false, error: "Unknown operation: ".concat(op.type) }];
            }
        });
    });
}
exports.routeMemoryOp = routeMemoryOp;
// ---------------------------------------------------------------------------
// Controller access (replaces bridgeGetController)
// ---------------------------------------------------------------------------
/**
 * Get a controller by name.
 * ADR-0085: Try local registry first, fall back to intercept pool.
 *
 * Both paths read from the same ControllerRegistry singleton instantiated by
 * initControllerRegistry(). controller-intercept does NOT create its own
 * registry — it accesses the one the router bootstrapped. The fallback exists
 * only for the case where initControllerRegistry() failed or hasn't run yet
 * (e.g. neural.enabled=false), not as an independent controller source.
 */
function getController(name) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, ctrl, ctrl, _b, intercept;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, ensureRouter()];
                case 1:
                    _c.sent();
                    return [3 /*break*/, 3];
                case 2:
                    _a = _c.sent();
                    return [3 /*break*/, 3];
                case 3:
                    // Primary: router-local registry (populated by initControllerRegistry)
                    if (_registryInstance && typeof _registryInstance.get === 'function') {
                        try {
                            ctrl = _registryInstance.get(name);
                            if (ctrl)
                                return [2 /*return*/, ctrl];
                        }
                        catch ( /* fall through to intercept */_d) { /* fall through to intercept */ }
                    }
                    if (!(_registryInstance && typeof _registryInstance.waitForDeferred === 'function')) return [3 /*break*/, 7];
                    _c.label = 4;
                case 4:
                    _c.trys.push([4, 6, , 7]);
                    return [4 /*yield*/, _registryInstance.waitForDeferred()];
                case 5:
                    _c.sent();
                    if (typeof _registryInstance.get === 'function') {
                        ctrl = _registryInstance.get(name);
                        if (ctrl)
                            return [2 /*return*/, ctrl];
                    }
                    return [3 /*break*/, 7];
                case 6:
                    _b = _c.sent();
                    return [3 /*break*/, 7];
                case 7: return [4 /*yield*/, loadIntercept()];
                case 8:
                    intercept = _c.sent();
                    if (intercept === null || intercept === void 0 ? void 0 : intercept.getExisting) {
                        return [2 /*return*/, intercept.getExisting(name)];
                    }
                    return [2 /*return*/, undefined];
            }
        });
    });
}
exports.getController = getController;
/**
 * Check if a controller exists in the pool.
 * Same shared-singleton contract as getController — see its JSDoc.
 */
function hasController(name) {
    return __awaiter(this, void 0, void 0, function () {
        var intercept;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (_registryInstance && typeof _registryInstance.has === 'function') {
                        try {
                            if (_registryInstance.has(name))
                                return [2 /*return*/, true];
                        }
                        catch ( /* fall through */_b) { /* fall through */ }
                    }
                    return [4 /*yield*/, loadIntercept()];
                case 1:
                    intercept = _a.sent();
                    if (intercept === null || intercept === void 0 ? void 0 : intercept.has)
                        return [2 /*return*/, intercept.has(name)];
                    return [2 /*return*/, false];
            }
        });
    });
}
exports.hasController = hasController;
/**
 * List all registered controller names and info.
 * Same shared-singleton contract as getController — see its JSDoc.
 *
 * ADR-0090 Tier B5 fix: ensure the router is initialized before querying
 * the registry. Previously this function was called directly by the
 * `agentdb_controllers` / `agentdb_health` MCP handlers, which don't
 * themselves touch `ensureRouter()` — so on a cold `cli mcp exec
 * --tool agentdb_controllers` invocation, `_registryInstance` was null
 * and the intercept pool was empty, returning `[]` even though the
 * controllers had been initialized on a prior memory op. The 12-agent
 * B5 swarm (2026-04-16) observed `controllers: 0, active: 0` for every
 * controller across every cold invocation and traced the gap here.
 * Calling `ensureRouter()` is idempotent and inexpensive after first
 * init (short-circuits on `_initialized`).
 */
function listControllerInfo() {
    return __awaiter(this, void 0, void 0, function () {
        var _a, controllers, intercept, names;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, ensureRouter()];
                case 1:
                    _b.sent();
                    return [3 /*break*/, 3];
                case 2:
                    _a = _b.sent();
                    return [3 /*break*/, 3];
                case 3:
                    if (_registryInstance && typeof _registryInstance.listControllers === 'function') {
                        try {
                            controllers = _registryInstance.listControllers();
                            if (Array.isArray(controllers)) {
                                return [2 /*return*/, controllers.map(function (c) { var _a, _b; return ({ name: (_a = c.name) !== null && _a !== void 0 ? _a : c, enabled: (_b = c.enabled) !== null && _b !== void 0 ? _b : true }); })];
                            }
                        }
                        catch ( /* fall through */_c) { /* fall through */ }
                    }
                    return [4 /*yield*/, loadIntercept()];
                case 4:
                    intercept = _b.sent();
                    if (intercept === null || intercept === void 0 ? void 0 : intercept.listControllers) {
                        names = intercept.listControllers();
                        return [2 /*return*/, names.map(function (name) { return ({ name: name, enabled: true }); })];
                    }
                    return [2 /*return*/, []];
            }
        });
    });
}
exports.listControllerInfo = listControllerInfo;
/**
 * Wait for deferred (Level 2+) controller initialization.
 *
 * ADR-0090 Tier B5 fix (2026-04-16): the prior implementation only
 * delegated to `controller-intercept.waitForDeferred()` which does NOT
 * exist on the intercept module (it only exposes the singleton pool
 * — getOrCreate / getExisting / listControllers). The net effect was
 * a silent no-op: callers assumed Level 2+ controllers (reflexion,
 * skills, causalGraph, causalRecall, learningSystem, memoryConsolidation,
 * attentionService, gnnService, semanticRouter, graphAdapter,
 * sonaTrajectory, nightlyLearner, explainableRecall — 13 of 15 B5
 * controllers) were init'd, but only Level 0-1 had actually landed.
 * The B5 swarm verifiers observed `"<Controller> not available"` for
 * every Level 2+ tool invocation because deferred init never completed
 * by the time the MCP handler tried to resolve the controller.
 *
 * Correct behavior: ensure the router is up (to instantiate the
 * registry), then await the registry instance's own `waitForDeferred()`.
 * That promise resolves when ALL deferred levels (2-6) finish
 * initController() calls — at which point `getController('reflexion')`
 * etc. will return the real controller via the agentdb fallback in
 * ControllerRegistry.get.
 */
function waitForDeferred() {
    return __awaiter(this, void 0, void 0, function () {
        var _a, _b, intercept;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, ensureRouter()];
                case 1:
                    _c.sent();
                    return [3 /*break*/, 3];
                case 2:
                    _a = _c.sent();
                    return [3 /*break*/, 3];
                case 3:
                    if (!(_registryInstance && typeof _registryInstance.waitForDeferred === 'function')) return [3 /*break*/, 8];
                    _c.label = 4;
                case 4:
                    _c.trys.push([4, 6, , 7]);
                    return [4 /*yield*/, _registryInstance.waitForDeferred()];
                case 5:
                    _c.sent();
                    return [3 /*break*/, 7];
                case 6:
                    _b = _c.sent();
                    return [3 /*break*/, 7];
                case 7: return [2 /*return*/];
                case 8: return [4 /*yield*/, loadIntercept()];
                case 9:
                    intercept = _c.sent();
                    if (!(intercept && typeof intercept.waitForDeferred === 'function')) return [3 /*break*/, 11];
                    return [4 /*yield*/, intercept.waitForDeferred()];
                case 10:
                    _c.sent();
                    _c.label = 11;
                case 11: return [2 /*return*/];
            }
        });
    });
}
exports.waitForDeferred = waitForDeferred;
/**
 * Controller health check.
 * Same shared-singleton contract as getController — see its JSDoc.
 *
 * ADR-0090 Tier B5 fix: call `ensureRouter()` so the registry is
 * populated even on a cold `cli mcp exec --tool agentdb_health`
 * invocation. See listControllerInfo() for the full rationale.
 */
function healthCheck() {
    return __awaiter(this, void 0, void 0, function () {
        var _a, controllers, names, intercept, names;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, ensureRouter()];
                case 1:
                    _b.sent();
                    return [3 /*break*/, 3];
                case 2:
                    _a = _b.sent();
                    return [3 /*break*/, 3];
                case 3:
                    if (_registryInstance && typeof _registryInstance.listControllers === 'function') {
                        try {
                            controllers = _registryInstance.listControllers();
                            names = Array.isArray(controllers)
                                ? controllers.map(function (c) { var _a; return (_a = c.name) !== null && _a !== void 0 ? _a : c; })
                                : [];
                            return [2 /*return*/, { available: true, controllers: names.length, controllerNames: names, source: 'registry' }];
                        }
                        catch ( /* fall through */_c) { /* fall through */ }
                    }
                    return [4 /*yield*/, loadIntercept()];
                case 4:
                    intercept = _b.sent();
                    if (intercept === null || intercept === void 0 ? void 0 : intercept.listControllers) {
                        names = intercept.listControllers();
                        return [2 /*return*/, { available: true, controllers: names.length, controllerNames: names, source: 'intercept' }];
                    }
                    return [2 /*return*/, { available: false, error: 'No controller source loaded' }];
            }
        });
    });
}
exports.healthCheck = healthCheck;
// ---------------------------------------------------------------------------
// routeEmbeddingOp — embedding/HNSW operation router (ADR-0083 Phase 5)
// ---------------------------------------------------------------------------
/**
 * Single entry point for embedding and HNSW operations.
 * Mirrors routeMemoryOp but for vector/index operations.
 */
function routeEmbeddingOp(op) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, adapter, _b, e_18, adapter, _c, e_19, adapter, _d, e_20, adapter, e_21, vec, results, e_22, stats, e_23;
        var _e;
        return __generator(this, function (_f) {
            switch (_f.label) {
                case 0: return [4 /*yield*/, ensureRouter()];
                case 1:
                    _f.sent();
                    _a = op.type;
                    switch (_a) {
                        case 'generate': return [3 /*break*/, 2];
                        case 'generateBatch': return [3 /*break*/, 6];
                        case 'loadModel': return [3 /*break*/, 10];
                        case 'getThreshold': return [3 /*break*/, 14];
                        case 'hnswSearch': return [3 /*break*/, 18];
                        case 'hnswStatus': return [3 /*break*/, 22];
                        case 'hnswAdd': return [3 /*break*/, 26];
                        case 'hnswGet': return [3 /*break*/, 27];
                        case 'hnswClear': return [3 /*break*/, 27];
                        case 'hnswRebuild': return [3 /*break*/, 27];
                    }
                    return [3 /*break*/, 28];
                case 2:
                    _f.trys.push([2, 5, , 6]);
                    return [4 /*yield*/, Promise.resolve("".concat('@claude-flow/memory/embedding-adapter')).then(function (s) { return require(s); })];
                case 3:
                    adapter = _f.sent();
                    _b = [{ success: true }];
                    return [4 /*yield*/, adapter.generateEmbedding(op.text, op.data)];
                case 4: return [2 /*return*/, __assign.apply(void 0, _b.concat([(_f.sent())]))];
                case 5:
                    e_18 = _f.sent();
                    return [2 /*return*/, { success: false, error: "generate failed: ".concat(e_18 instanceof Error ? e_18.message : String(e_18)) }];
                case 6:
                    _f.trys.push([6, 9, , 10]);
                    return [4 /*yield*/, Promise.resolve("".concat('@claude-flow/memory/embedding-adapter')).then(function (s) { return require(s); })];
                case 7:
                    adapter = _f.sent();
                    _c = [{ success: true }];
                    return [4 /*yield*/, adapter.generateBatchEmbeddings(op.texts, op.data)];
                case 8: return [2 /*return*/, __assign.apply(void 0, _c.concat([(_f.sent())]))];
                case 9:
                    e_19 = _f.sent();
                    return [2 /*return*/, { success: false, error: "generateBatch failed: ".concat(e_19 instanceof Error ? e_19.message : String(e_19)) }];
                case 10:
                    _f.trys.push([10, 13, , 14]);
                    return [4 /*yield*/, Promise.resolve("".concat('@claude-flow/memory/embedding-adapter')).then(function (s) { return require(s); })];
                case 11:
                    adapter = _f.sent();
                    _d = [{ success: true }];
                    return [4 /*yield*/, adapter.loadEmbeddingModel(op.data)];
                case 12: return [2 /*return*/, __assign.apply(void 0, _d.concat([(_f.sent())]))];
                case 13:
                    e_20 = _f.sent();
                    return [2 /*return*/, { success: false, error: "loadModel failed: ".concat(e_20 instanceof Error ? e_20.message : String(e_20)) }];
                case 14:
                    _f.trys.push([14, 17, , 18]);
                    return [4 /*yield*/, Promise.resolve("".concat('@claude-flow/memory/embedding-adapter')).then(function (s) { return require(s); })];
                case 15:
                    adapter = _f.sent();
                    _e = { success: true };
                    return [4 /*yield*/, adapter.getAdaptiveThreshold(op.data)];
                case 16: return [2 /*return*/, (_e.threshold = _f.sent(), _e)];
                case 17:
                    e_21 = _f.sent();
                    return [2 /*return*/, { success: false, error: "getThreshold failed: ".concat(e_21 instanceof Error ? e_21.message : String(e_21)) }];
                case 18:
                    if (!_storage)
                        return [2 /*return*/, { success: false, error: 'Storage not initialized' }];
                    _f.label = 19;
                case 19:
                    _f.trys.push([19, 21, , 22]);
                    vec = op.vector instanceof Float32Array ? op.vector
                        : new Float32Array(op.vector);
                    return [4 /*yield*/, _storage.search(vec, { k: op.k || op.limit || 10 })];
                case 20:
                    results = _f.sent();
                    return [2 /*return*/, { success: true, results: results, total: results.length }];
                case 21:
                    e_22 = _f.sent();
                    return [2 /*return*/, { success: false, error: "hnswSearch failed: ".concat(e_22 instanceof Error ? e_22.message : String(e_22)) }];
                case 22:
                    if (!_storage)
                        return [2 /*return*/, { success: false, error: 'Storage not initialized' }];
                    _f.label = 23;
                case 23:
                    _f.trys.push([23, 25, , 26]);
                    return [4 /*yield*/, _storage.getStats()];
                case 24:
                    stats = _f.sent();
                    return [2 /*return*/, __assign({ success: true }, stats)];
                case 25:
                    e_23 = _f.sent();
                    return [2 /*return*/, { success: false, error: "hnswStatus failed: ".concat(e_23 instanceof Error ? e_23.message : String(e_23)) }];
                case 26:
                    {
                        return [2 /*return*/, { success: false, error: 'Direct HNSW add not supported — entries are indexed automatically on store()' }];
                    }
                    _f.label = 27;
                case 27:
                    {
                        return [2 /*return*/, { success: false, error: 'Direct HNSW manipulation not supported — index is managed by RvfBackend. Use routeMemoryOp for data operations.' }];
                    }
                    _f.label = 28;
                case 28: return [2 /*return*/, { success: false, error: "Unknown embedding operation: ".concat(op.type) }];
            }
        });
    });
}
exports.routeEmbeddingOp = routeEmbeddingOp;
// ---------------------------------------------------------------------------
// Phase 2 route methods (ADR-0084) — bridge caller migration
// ---------------------------------------------------------------------------
/**
 * Route pattern store/search operations.
 * ADR-0084 Phase 4: controller-direct — uses getController('reasoningBank') instead of bridge.
 */
function routePatternOp(op) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function () {
        var _c, reasoningBank, patternId, storePatternFn, e_24, storeFn, e_25, reasoningBank, searchFn, results, searchPatternsFn, _d, fallback;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0: return [4 /*yield*/, ensureRouter()];
                case 1:
                    _e.sent();
                    _c = op.type;
                    switch (_c) {
                        case 'store': return [3 /*break*/, 2];
                        case 'search': return [3 /*break*/, 12];
                    }
                    return [3 /*break*/, 22];
                case 2: return [4 /*yield*/, getController('reasoningBank')];
                case 3:
                    reasoningBank = _e.sent();
                    patternId = generateId('pattern');
                    storePatternFn = getCallableMethod(reasoningBank, 'storePattern');
                    if (!storePatternFn) return [3 /*break*/, 7];
                    _e.label = 4;
                case 4:
                    _e.trys.push([4, 6, , 7]);
                    return [4 /*yield*/, storePatternFn({
                            taskType: op.patternType || 'general',
                            approach: op.pattern || '',
                            successRate: (_a = op.confidence) !== null && _a !== void 0 ? _a : 1.0,
                            tags: op.patternType ? [op.patternType] : undefined,
                            metadata: op.metadata,
                        })];
                case 5:
                    _e.sent();
                    return [2 /*return*/, { success: true, patternId: patternId, controller: 'reasoningBank' }];
                case 6:
                    e_24 = _e.sent();
                    return [2 /*return*/, { success: false, patternId: '', controller: '', error: e_24 instanceof Error ? e_24.message : String(e_24) }];
                case 7:
                    storeFn = getCallableMethod(reasoningBank, 'store', 'add');
                    if (!storeFn) return [3 /*break*/, 11];
                    _e.label = 8;
                case 8:
                    _e.trys.push([8, 10, , 11]);
                    return [4 /*yield*/, storeFn({
                            id: patternId,
                            content: op.pattern || '',
                            type: op.patternType || 'general',
                            confidence: (_b = op.confidence) !== null && _b !== void 0 ? _b : 1.0,
                            metadata: op.metadata,
                            timestamp: Date.now(),
                        })];
                case 9:
                    _e.sent();
                    return [2 /*return*/, { success: true, patternId: patternId, controller: 'reasoningBank' }];
                case 10:
                    e_25 = _e.sent();
                    return [2 /*return*/, { success: false, patternId: '', controller: '', error: e_25 instanceof Error ? e_25.message : String(e_25) }];
                case 11: 
                // ADR-0112 Phase 1: no silent fallback to RVF when reasoningBank
                // lacks both `storePattern` and `store`/`add`. The caller invoked an
                // AgentDB pattern-store tool; routing that write to RVF's `pattern`
                // namespace violates the per-store partition (cross-store coordination
                // is forbidden — ADR-0086 §Debt 15 + ADR-0112 §Decision). Fail loud.
                return [2 /*return*/, {
                        success: false,
                        patternId: '',
                        controller: '',
                        error: 'reasoningBank controller missing both storePattern and store/add methods — pattern store unavailable. Per ADR-0112, no silent fallback to RVF (cross-store coordination forbidden).',
                    }];
                case 12: return [4 /*yield*/, getController('reasoningBank')];
                case 13:
                    reasoningBank = _e.sent();
                    searchFn = getCallableMethod(reasoningBank, 'searchPatterns', 'search');
                    if (!searchFn) return [3 /*break*/, 20];
                    _e.label = 14;
                case 14:
                    _e.trys.push([14, 19, , 20]);
                    results = void 0;
                    searchPatternsFn = getCallableMethod(reasoningBank, 'searchPatterns');
                    if (!searchPatternsFn) return [3 /*break*/, 16];
                    return [4 /*yield*/, searchPatternsFn({ task: op.query || '', k: op.topK || 5, threshold: op.minConfidence || 0.3 })];
                case 15:
                    results = _e.sent();
                    return [3 /*break*/, 18];
                case 16: return [4 /*yield*/, searchFn(op.query || '', { topK: op.topK || 5, minScore: op.minConfidence || 0.3 })];
                case 17:
                    results = _e.sent();
                    _e.label = 18;
                case 18: return [2 /*return*/, {
                        success: true,
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        results: Array.isArray(results) ? results.map(function (r) {
                            var _a, _b;
                            return ({
                                id: r.id || r.patternId || '',
                                content: r.content || r.pattern || '',
                                score: (_b = (_a = r.score) !== null && _a !== void 0 ? _a : r.confidence) !== null && _b !== void 0 ? _b : 0,
                            });
                        }) : [],
                        controller: 'reasoningBank',
                    }];
                case 19:
                    _d = _e.sent();
                    return [3 /*break*/, 20];
                case 20: return [4 /*yield*/, routeMemoryOp({
                        type: 'search',
                        query: op.query || '',
                        namespace: 'pattern',
                        limit: op.topK || 5,
                        threshold: op.minConfidence || 0.3,
                    })];
                case 21:
                    fallback = _e.sent();
                    return [2 /*return*/, fallback.success
                            ? { success: true, results: fallback.results || [], controller: 'router-fallback' }
                            : { success: false, error: 'Pattern search unavailable' }];
                case 22: return [2 /*return*/, { success: false, error: "Unknown pattern operation: ".concat(op.type) }];
            }
        });
    });
}
exports.routePatternOp = routePatternOp;
/**
 * Route feedback recording operations.
 * ADR-0084 Phase 4: controller-direct — uses getController('learningSystem') + getController('reasoningBank').
 */
function routeFeedbackOp(op) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, controller, updated, learningSystem, _b, reasoningBank, rbStoreFn, _c, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0: return [4 /*yield*/, ensureRouter()];
                case 1:
                    _e.sent();
                    _a = op.type;
                    switch (_a) {
                        case 'record': return [3 /*break*/, 2];
                    }
                    return [3 /*break*/, 17];
                case 2:
                    controller = 'none';
                    updated = 0;
                    return [4 /*yield*/, getController('learningSystem')];
                case 3:
                    learningSystem = _e.sent();
                    if (!learningSystem) return [3 /*break*/, 8];
                    _e.label = 4;
                case 4:
                    _e.trys.push([4, 7, , 8]);
                    if (!(typeof learningSystem.recordFeedback === 'function')) return [3 /*break*/, 6];
                    return [4 /*yield*/, learningSystem.recordFeedback({
                            taskId: op.taskId, success: op.success, quality: op.quality,
                            agent: op.agent, duration: op.duration, timestamp: Date.now(),
                        })];
                case 5:
                    _e.sent();
                    controller = 'learningSystem';
                    updated++;
                    _e.label = 6;
                case 6: return [3 /*break*/, 8];
                case 7:
                    _b = _e.sent();
                    return [3 /*break*/, 8];
                case 8: return [4 /*yield*/, getController('reasoningBank')];
                case 9:
                    reasoningBank = _e.sent();
                    rbStoreFn = getCallableMethod(reasoningBank, 'store', 'storePattern');
                    if (!rbStoreFn) return [3 /*break*/, 13];
                    _e.label = 10;
                case 10:
                    _e.trys.push([10, 12, , 13]);
                    return [4 /*yield*/, rbStoreFn({
                            id: generateId('feedback'),
                            content: JSON.stringify({ taskId: op.taskId, success: op.success, quality: op.quality }),
                            type: 'feedback',
                            confidence: op.quality,
                            metadata: { agent: op.agent, duration: op.duration, patterns: op.patterns },
                            timestamp: Date.now(),
                        })];
                case 11:
                    _e.sent();
                    controller = controller === 'none' ? 'reasoningBank' : "".concat(controller, "+reasoningBank");
                    updated++;
                    return [3 /*break*/, 13];
                case 12:
                    _c = _e.sent();
                    return [3 /*break*/, 13];
                case 13:
                    _e.trys.push([13, 15, , 16]);
                    return [4 /*yield*/, routeMemoryOp({
                            type: 'store',
                            key: "feedback-".concat(op.taskId),
                            value: JSON.stringify({ taskId: op.taskId, success: op.success, quality: op.quality, agent: op.agent, duration: op.duration }),
                            namespace: 'feedback',
                            tags: ['feedback', op.success ? 'success' : 'failure'],
                            upsert: true,
                        })];
                case 14:
                    _e.sent();
                    if (controller === 'none')
                        controller = 'router-store';
                    updated = Math.max(updated, 1);
                    return [3 /*break*/, 16];
                case 15:
                    _d = _e.sent();
                    return [3 /*break*/, 16];
                case 16: return [2 /*return*/, { success: updated > 0, controller: controller, updated: updated }];
                case 17: return [2 /*return*/, { success: false, error: "Unknown feedback operation: ".concat(op.type) }];
            }
        });
    });
}
exports.routeFeedbackOp = routeFeedbackOp;
/**
 * Route session lifecycle operations.
 * ADR-0084 Phase 4: controller-direct — uses getController('reflexion') + getController('nightlyLearner').
 */
function routeSessionOp(op) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function () {
        var _c, controller, restoredPatterns, reflexion, _d, searchResult, _e, controller, persisted, reflexion, _f, _g, nightlyLearner, _h;
        return __generator(this, function (_j) {
            switch (_j.label) {
                case 0: return [4 /*yield*/, ensureRouter()];
                case 1:
                    _j.sent();
                    _c = op.type;
                    switch (_c) {
                        case 'start': return [3 /*break*/, 2];
                        case 'end': return [3 /*break*/, 11];
                    }
                    return [3 /*break*/, 25];
                case 2:
                    controller = 'none';
                    restoredPatterns = 0;
                    return [4 /*yield*/, getController('reflexion')];
                case 3:
                    reflexion = _j.sent();
                    if (!(reflexion && typeof reflexion.startEpisode === 'function')) return [3 /*break*/, 7];
                    _j.label = 4;
                case 4:
                    _j.trys.push([4, 6, , 7]);
                    return [4 /*yield*/, reflexion.startEpisode(op.sessionId, { context: op.context })];
                case 5:
                    _j.sent();
                    controller = 'reflexion';
                    return [3 /*break*/, 7];
                case 6:
                    _d = _j.sent();
                    return [3 /*break*/, 7];
                case 7:
                    _j.trys.push([7, 9, , 10]);
                    return [4 /*yield*/, routeMemoryOp({
                            type: 'search',
                            query: op.context || 'session patterns',
                            namespace: 'session',
                            limit: 10,
                        })];
                case 8:
                    searchResult = _j.sent();
                    if (searchResult.success) {
                        restoredPatterns = (searchResult.results || []).length;
                    }
                    return [3 /*break*/, 10];
                case 9:
                    _e = _j.sent();
                    return [3 /*break*/, 10];
                case 10: return [2 /*return*/, {
                        success: true,
                        controller: controller === 'none' ? 'router-search' : controller,
                        restoredPatterns: restoredPatterns,
                        sessionId: op.sessionId,
                    }];
                case 11:
                    controller = 'none';
                    persisted = false;
                    return [4 /*yield*/, getController('reflexion')];
                case 12:
                    reflexion = _j.sent();
                    if (!(reflexion && typeof reflexion.endEpisode === 'function')) return [3 /*break*/, 16];
                    _j.label = 13;
                case 13:
                    _j.trys.push([13, 15, , 16]);
                    return [4 /*yield*/, reflexion.endEpisode(op.sessionId, {
                            summary: op.summary,
                            tasksCompleted: op.tasksCompleted,
                            patternsLearned: op.patternsLearned,
                        })];
                case 14:
                    _j.sent();
                    controller = 'reflexion';
                    persisted = true;
                    return [3 /*break*/, 16];
                case 15:
                    _f = _j.sent();
                    return [3 /*break*/, 16];
                case 16:
                    _j.trys.push([16, 18, , 19]);
                    return [4 /*yield*/, routeMemoryOp({
                            type: 'store',
                            key: "session-".concat(op.sessionId),
                            value: JSON.stringify({
                                sessionId: op.sessionId,
                                summary: op.summary || 'Session ended',
                                tasksCompleted: (_a = op.tasksCompleted) !== null && _a !== void 0 ? _a : 0,
                                patternsLearned: (_b = op.patternsLearned) !== null && _b !== void 0 ? _b : 0,
                                endedAt: new Date().toISOString(),
                            }),
                            namespace: 'session',
                            tags: ['session-end'],
                            upsert: true,
                        })];
                case 17:
                    _j.sent();
                    if (controller === 'none')
                        controller = 'router-store';
                    persisted = true;
                    return [3 /*break*/, 19];
                case 18:
                    _g = _j.sent();
                    return [3 /*break*/, 19];
                case 19: return [4 /*yield*/, getController('nightlyLearner')];
                case 20:
                    nightlyLearner = _j.sent();
                    if (!(nightlyLearner && typeof nightlyLearner.consolidate === 'function')) return [3 /*break*/, 24];
                    _j.label = 21;
                case 21:
                    _j.trys.push([21, 23, , 24]);
                    return [4 /*yield*/, nightlyLearner.consolidate({ sessionId: op.sessionId })];
                case 22:
                    _j.sent();
                    controller += '+nightlyLearner';
                    return [3 /*break*/, 24];
                case 23:
                    _h = _j.sent();
                    return [3 /*break*/, 24];
                case 24: return [2 /*return*/, { success: true, controller: controller, persisted: persisted }];
                case 25: return [2 /*return*/, { success: false, error: "Unknown session operation: ".concat(op.type) }];
            }
        });
    });
}
exports.routeSessionOp = routeSessionOp;
/**
 * Route self-learning search and memory consolidation.
 * ADR-0084 Phase 4: controller-direct — uses getController('selfLearningRvfBackend') + getController('memoryConsolidation').
 */
function routeLearningOp(op) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, a6, results, stats, _b, fallback, _c, mc, result, e_26;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0: return [4 /*yield*/, ensureRouter()];
                case 1:
                    _d.sent();
                    _a = op.type;
                    switch (_a) {
                        case 'search': return [3 /*break*/, 2];
                        case 'consolidate': return [3 /*break*/, 10];
                    }
                    return [3 /*break*/, 15];
                case 2: return [4 /*yield*/, getController('selfLearningRvfBackend')];
                case 3:
                    a6 = _d.sent();
                    if (!(a6 && typeof a6.search === 'function')) return [3 /*break*/, 7];
                    _d.label = 4;
                case 4:
                    _d.trys.push([4, 6, , 7]);
                    return [4 /*yield*/, a6.search({
                            query: op.query || '',
                            limit: op.limit || 10,
                            namespace: op.namespace,
                            threshold: op.threshold,
                        })];
                case 5:
                    results = _d.sent();
                    stats = typeof a6.getStats === 'function' ? a6.getStats() : undefined;
                    return [2 /*return*/, { success: true, results: results || [], routed: true, controller: 'selfLearningRvfBackend', stats: stats }];
                case 6:
                    _b = _d.sent();
                    return [3 /*break*/, 7];
                case 7:
                    _d.trys.push([7, 9, , 10]);
                    return [4 /*yield*/, routeMemoryOp({
                            type: 'search',
                            query: op.query || '',
                            limit: op.limit || 10,
                            namespace: op.namespace,
                            threshold: op.threshold,
                        })];
                case 8:
                    fallback = _d.sent();
                    return [2 /*return*/, {
                            success: fallback.success,
                            results: fallback.results || [],
                            routed: false,
                            controller: 'routeMemoryOp',
                        }];
                case 9:
                    _c = _d.sent();
                    return [2 /*return*/, { success: false, results: [], routed: false, controller: 'routeMemoryOp', error: 'Search fallback failed' }];
                case 10: return [4 /*yield*/, getController('memoryConsolidation')];
                case 11:
                    mc = _d.sent();
                    if (!mc)
                        return [2 /*return*/, { success: false, error: 'MemoryConsolidation not available' }];
                    _d.label = 12;
                case 12:
                    _d.trys.push([12, 14, , 15]);
                    return [4 /*yield*/, mc.consolidate()];
                case 13:
                    result = _d.sent();
                    return [2 /*return*/, { success: true, consolidated: result }];
                case 14:
                    e_26 = _d.sent();
                    return [2 /*return*/, { success: false, error: e_26 instanceof Error ? e_26.message : String(e_26) }];
                case 15: return [2 /*return*/, { success: false, error: "Unknown learning operation: ".concat(op.type) }];
            }
        });
    });
}
exports.routeLearningOp = routeLearningOp;
/**
 * Route reflexion store/retrieve operations.
 * Uses reflexion controller directly (no bridge functions exist for reflexion).
 */
function routeReflexionOp(op) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function () {
        var reflexion, _c, result, e_27, results, e_28;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0: return [4 /*yield*/, ensureRouter()];
                case 1:
                    _d.sent();
                    return [4 /*yield*/, getController('reflexion')];
                case 2:
                    reflexion = _d.sent();
                    _c = op.type;
                    switch (_c) {
                        case 'store': return [3 /*break*/, 3];
                        case 'retrieve': return [3 /*break*/, 7];
                    }
                    return [3 /*break*/, 11];
                case 3:
                    if (!reflexion || typeof reflexion.store !== 'function') {
                        return [2 /*return*/, { success: false, error: 'Reflexion controller not available' }];
                    }
                    _d.label = 4;
                case 4:
                    _d.trys.push([4, 6, , 7]);
                    return [4 /*yield*/, Promise.race([
                            reflexion.store({
                                session_id: op.sessionId,
                                task: op.task,
                                input: op.input,
                                output: op.output,
                                reward: (_a = op.reward) !== null && _a !== void 0 ? _a : 0,
                                success: (_b = op.success) !== null && _b !== void 0 ? _b : false,
                            }),
                            new Promise(function (_, reject) {
                                return setTimeout(function () { return reject(new Error('reflexion store timeout (2s)')); }, 2000);
                            }),
                        ])];
                case 5:
                    result = _d.sent();
                    return [2 /*return*/, { success: true, stored: result }];
                case 6:
                    e_27 = _d.sent();
                    return [2 /*return*/, { success: false, error: e_27 instanceof Error ? e_27.message : String(e_27) }];
                case 7:
                    if (!reflexion || typeof reflexion.retrieve !== 'function') {
                        return [2 /*return*/, { success: false, error: 'Reflexion controller not available' }];
                    }
                    _d.label = 8;
                case 8:
                    _d.trys.push([8, 10, , 11]);
                    return [4 /*yield*/, Promise.race([
                            reflexion.retrieve(op.task, op.k || 5),
                            new Promise(function (_, reject) {
                                return setTimeout(function () { return reject(new Error('reflexion retrieve timeout (2s)')); }, 2000);
                            }),
                        ])];
                case 9:
                    results = _d.sent();
                    return [2 /*return*/, { success: true, results: Array.isArray(results) ? results : [] }];
                case 10:
                    e_28 = _d.sent();
                    return [2 /*return*/, { success: false, error: e_28 instanceof Error ? e_28.message : String(e_28) }];
                case 11: return [2 /*return*/, { success: false, error: "Unknown reflexion operation: ".concat(op.type) }];
            }
        });
    });
}
exports.routeReflexionOp = routeReflexionOp;
/**
 * Route causal graph operations.
 * ADR-0084 Phase 4: controller-direct — uses getController('causalGraph') + getController('causalRecall').
 */
function routeCausalOp(op) {
    var _a;
    return __awaiter(this, void 0, void 0, function () {
        var _b, causalGraph, result, _c, cr, stats, timeoutPromise, results, e_29;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0: return [4 /*yield*/, ensureRouter()];
                case 1:
                    _d.sent();
                    _b = op.type;
                    switch (_b) {
                        case 'edge': return [3 /*break*/, 2];
                        case 'recall': return [3 /*break*/, 7];
                    }
                    return [3 /*break*/, 11];
                case 2: return [4 /*yield*/, getController('causalGraph')];
                case 3:
                    causalGraph = _d.sent();
                    if (causalGraph && typeof causalGraph.addEdge === 'function') {
                        try {
                            causalGraph.addEdge(op.sourceId || '', op.targetId || '', {
                                relation: op.relation || '',
                                weight: (_a = op.weight) !== null && _a !== void 0 ? _a : 1.0,
                                timestamp: Date.now(),
                            });
                            return [2 /*return*/, { success: true, controller: 'causalGraph' }];
                        }
                        catch ( /* fall through to fallback */_e) { /* fall through to fallback */ }
                    }
                    _d.label = 4;
                case 4:
                    _d.trys.push([4, 6, , 7]);
                    return [4 /*yield*/, routeMemoryOp({
                            type: 'store',
                            key: "".concat(op.sourceId, "\u2192").concat(op.targetId),
                            value: JSON.stringify({ sourceId: op.sourceId, targetId: op.targetId, relation: op.relation, weight: op.weight }),
                            namespace: 'causal-edges',
                        })];
                case 5:
                    result = _d.sent();
                    return [2 /*return*/, result.success
                            ? { success: true, controller: 'router-fallback' }
                            : { success: false, error: 'Causal edge recording unavailable' }];
                case 6:
                    _c = _d.sent();
                    return [2 /*return*/, { success: false, error: 'Causal edge recording unavailable' }];
                case 7:
                    _d.trys.push([7, 10, , 11]);
                    return [4 /*yield*/, getController('causalRecall')];
                case 8:
                    cr = _d.sent();
                    if (!cr || typeof cr.search !== 'function') {
                        return [2 /*return*/, { success: false, error: 'CausalRecall not available' }];
                    }
                    // Cold-start guard: check if causal graph has enough edges
                    if (typeof cr.getStats === 'function') {
                        stats = cr.getStats();
                        if (stats && (stats.totalCausalEdges || 0) < 5) {
                            return [2 /*return*/, { success: true, results: [], warning: 'Cold start: fewer than 5 causal edges' }];
                        }
                    }
                    timeoutPromise = new Promise(function (_, reject) {
                        return setTimeout(function () { return reject(new Error('CausalRecall timeout (2s)')); }, 2000);
                    });
                    return [4 /*yield*/, Promise.race([
                            cr.search({ query: op.query || '', k: op.k || 10, includeEvidence: op.includeEvidence }),
                            timeoutPromise,
                        ])];
                case 9:
                    results = _d.sent();
                    return [2 /*return*/, { success: true, results: Array.isArray(results) ? results : [] }];
                case 10:
                    e_29 = _d.sent();
                    return [2 /*return*/, { success: false, error: e_29 instanceof Error ? e_29.message : String(e_29) }];
                case 11: return [2 /*return*/, { success: false, error: "Unknown causal operation: ".concat(op.type) }];
            }
        });
    });
}
exports.routeCausalOp = routeCausalOp;
// ---------------------------------------------------------------------------
// ADR-0111 W1.5 — letter F prep: enumerate-embeddings primitive
// ---------------------------------------------------------------------------
/**
 * Enumerate all stored embeddings via the RVF backend.
 *
 * ADR-0111 W1.5 — replaces upstream's SQLite-shaped `bridgeGetAllEmbeddings`
 * with an RVF-primary primitive. Letter F's RaBitQ index construction will
 * call this to materialize a snapshot of every stored vector.
 *
 * Per project-rvf-primary, this reads directly from the RvfBackend's
 * in-memory `entries` map (the canonical source of truth) — NOT from any
 * SQLite `memory_entries` table. Bypasses the registry entirely; this is
 * the storage-layer surface, not a controller op.
 *
 * @param options.dimensions Filter to embeddings of this length (default
 *                           768, matching reference-embedding-model.md
 *                           `Xenova/all-mpnet-base-v2`).
 * @param options.limit      Max results (default 50000 — matches upstream
 *                           bridgeGetAllEmbeddings).
 * @param options.dbPath     Reserved for future per-DB targeting; currently
 *                           ignored — operations use the active router
 *                           storage.
 *
 * @returns Array of embeddings or `null` when storage is unavailable
 *          (genuinely fatal under Model 1, but kept nullable to preserve
 *          the upstream signature shape for letter F's adoption).
 */
function routerGetAllEmbeddings(options) {
    var _a, _b;
    if (options === void 0) { options = {}; }
    return __awaiter(this, void 0, void 0, function () {
        var dimensions, limit, storage;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, ensureRouter()];
                case 1:
                    _c.sent();
                    if (!_storage) {
                        // Under ADR-0111 W1.5 Model 1 this should not happen — ensureRouter
                        // either succeeds or throws. Returning null preserves the upstream
                        // signature for letter F adoption; log so the regression is visible.
                        console.error('[routerGetAllEmbeddings] storage unavailable after ensureRouter()');
                        return [2 /*return*/, null];
                    }
                    dimensions = (_a = options.dimensions) !== null && _a !== void 0 ? _a : 768;
                    limit = (_b = options.limit) !== null && _b !== void 0 ? _b : 50000;
                    storage = _storage;
                    if (typeof storage.enumerateEmbeddings !== 'function') {
                        console.error('[routerGetAllEmbeddings] active storage does not implement enumerateEmbeddings');
                        return [2 /*return*/, null];
                    }
                    return [2 /*return*/, storage.enumerateEmbeddings({ dimensions: dimensions, limit: limit })];
            }
        });
    });
}
exports.routerGetAllEmbeddings = routerGetAllEmbeddings;
// ---------------------------------------------------------------------------
// ADR-0086 Phase 3: _wrap delegates + loadAllFns deleted.
// Embedding functions re-exported from adapter.
// HNSW managed internally by RvfBackend.
// ---------------------------------------------------------------------------
// Embedding re-exports (ADR-0086 Phase 3: from adapter, not initializer)
function _loadAdapter() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, Promise.resolve("".concat('@claude-flow/memory/embedding-adapter')).then(function (s) { return require(s); })];
        });
    });
}
var loadEmbeddingModel = function () {
    var args = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
    }
    return __awaiter(void 0, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, _loadAdapter()];
                case 1: return [2 /*return*/, (_a = (_b.sent())).loadEmbeddingModel.apply(_a, args)];
            }
        });
    });
};
exports.loadEmbeddingModel = loadEmbeddingModel;
var generateEmbedding = function () {
    var args = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
    }
    return __awaiter(void 0, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, _loadAdapter()];
                case 1: return [2 /*return*/, (_a = (_b.sent())).generateEmbedding.apply(_a, args)];
            }
        });
    });
};
exports.generateEmbedding = generateEmbedding;
var generateBatchEmbeddings = function () {
    var args = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
    }
    return __awaiter(void 0, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, _loadAdapter()];
                case 1: return [2 /*return*/, (_a = (_b.sent())).generateBatchEmbeddings.apply(_a, args)];
            }
        });
    });
};
exports.generateBatchEmbeddings = generateBatchEmbeddings;
var getAdaptiveThreshold = function () {
    var args = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
    }
    return __awaiter(void 0, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, _loadAdapter()];
                case 1: return [2 /*return*/, (_a = (_b.sent())).getAdaptiveThreshold.apply(_a, args)];
            }
        });
    });
};
exports.getAdaptiveThreshold = getAdaptiveThreshold;
// ---------------------------------------------------------------------------
// Shutdown + Reset
// ---------------------------------------------------------------------------
/**
 * Shutdown the router and release resources.
 * ADR-0085: Shuts down local ControllerRegistry + controller-intercept pool.
 */
function shutdownRouter() {
    return __awaiter(this, void 0, void 0, function () {
        var _a, _b, intercept, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!_storage) return [3 /*break*/, 4];
                    _d.label = 1;
                case 1:
                    _d.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, _storage.shutdown()];
                case 2:
                    _d.sent();
                    return [3 /*break*/, 4];
                case 3:
                    _a = _d.sent();
                    return [3 /*break*/, 4];
                case 4:
                    if (!_registryInstance) return [3 /*break*/, 8];
                    _d.label = 5;
                case 5:
                    _d.trys.push([5, 7, , 8]);
                    return [4 /*yield*/, _registryInstance.shutdown()];
                case 6:
                    _d.sent();
                    return [3 /*break*/, 8];
                case 7:
                    _b = _d.sent();
                    return [3 /*break*/, 8];
                case 8:
                    intercept = _interceptMod;
                    if (!intercept) return [3 /*break*/, 13];
                    _d.label = 9;
                case 9:
                    _d.trys.push([9, 12, , 13]);
                    if (!(typeof intercept.shutdown === 'function')) return [3 /*break*/, 11];
                    return [4 /*yield*/, intercept.shutdown()];
                case 10:
                    _d.sent();
                    _d.label = 11;
                case 11: return [3 /*break*/, 13];
                case 12:
                    _c = _d.sent();
                    return [3 /*break*/, 13];
                case 13:
                    resetRouter();
                    return [2 /*return*/];
            }
        });
    });
}
exports.shutdownRouter = shutdownRouter;
/** Reset all cached modules (testing only). */
function resetRouter() {
    _storage = null;
    _interceptMod = null;
    _initialized = false;
    _initPromise = null;
    _initFailed = false; // ADR-0086 I2: allow retry after reset
    // ADR-0085: Reset registry state
    _registryInstance = null;
    _registryPromise = null;
    _registryAvailable = null;
    _exitHookRegistered = false;
    // ADR-0094 Sprint 1.4 (d6): clear lockPath so a subsequent init
    // recaptures it from the (possibly new) storage config.
    _lockPath = null;
}
exports.resetRouter = resetRouter;
