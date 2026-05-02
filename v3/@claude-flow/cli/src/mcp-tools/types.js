"use strict";
/**
 * MCP Tool Types for CLI
 *
 * Local type definitions to avoid external imports outside package boundary.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDisplayCwd = exports.findProjectRoot = void 0;
var node_fs_1 = require("node:fs");
var node_path_1 = require("node:path");
var node_os_1 = require("node:os");
/**
 * Maximum parent-directory walk depth. 32 covers any real-world repo layout;
 * monorepos top out at ~12, deeply nested monorepos at ~20.
 */
var MAX_WALK_DEPTH = 32;
/**
 * ADR-0100: find the nearest project root by walking upward from `startDir`
 * (or process.cwd()/CLAUDE_FLOW_CWD if omitted). Per-invocation — never cache
 * at module load; Claude Code CWD drifts mid-session and a cached root will
 * be stale.
 *
 * Marker priority (first match wins):
 *   1. `.ruflo-project` sentinel — explicit contract
 *   2. `CLAUDE.md` AND sibling `.claude/` — init'd project (BOTH required to
 *      skip docs/CLAUDE.md false-positives)
 *   3. `.git/` — generic repo fallback
 *   4. No marker → warn (stderr AND persistent log) + return startDir
 *
 * See docs/adr/ADR-0100-project-root-resolution.md for full rationale and
 * third-order adversarial-review outcomes. See upstream reproduction:
 * https://github.com/ruvnet/ruflo/issues/1639
 */
function findProjectRoot(startDir) {
    var _a;
    var start = (_a = startDir !== null && startDir !== void 0 ? startDir : process.env.CLAUDE_FLOW_CWD) !== null && _a !== void 0 ? _a : process.cwd();
    var dir = start;
    for (var i = 0; i < MAX_WALK_DEPTH; i++) {
        if ((0, node_fs_1.existsSync)((0, node_path_1.join)(dir, '.ruflo-project')))
            return dir;
        if ((0, node_fs_1.existsSync)((0, node_path_1.join)(dir, 'CLAUDE.md')) && (0, node_fs_1.existsSync)((0, node_path_1.join)(dir, '.claude')))
            return dir;
        if ((0, node_fs_1.existsSync)((0, node_path_1.join)(dir, '.git')))
            return dir;
        var parent_1 = (0, node_path_1.dirname)(dir);
        if (parent_1 === dir)
            break;
        dir = parent_1;
    }
    var msg = "[ruflo] No project root marker found from ".concat(start, "; falling back to CWD. Consider 'ruflo init' or creating '.ruflo-project'.");
    console.warn(msg);
    try {
        var logPath = (0, node_path_1.join)((0, node_os_1.homedir)(), '.ruflo', 'resolver-warnings.log');
        (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(logPath), { recursive: true });
        (0, node_fs_1.appendFileSync)(logPath, "".concat(new Date().toISOString(), " ").concat(msg, "\n"));
    }
    catch (_b) {
        // best-effort — resolver MUST NOT throw
    }
    return start;
}
exports.findProjectRoot = findProjectRoot;
/**
 * @deprecated Use findProjectRoot() for ANY artifact/storage path.
 * Only use getDisplayCwd() for user-facing display or logging that genuinely
 * wants the drifting Claude Code CWD (ADR-0100). Renamed from getProjectCwd
 * in 2026-04-23 to force audit of existing callsites.
 */
function getDisplayCwd() {
    var _a;
    return (_a = process.env.CLAUDE_FLOW_CWD) !== null && _a !== void 0 ? _a : process.cwd();
}
exports.getDisplayCwd = getDisplayCwd;
