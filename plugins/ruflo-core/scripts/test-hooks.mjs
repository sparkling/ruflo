#!/usr/bin/env node
/**
 * Regression guard for ruvnet/ruflo#1859 + #1862.
 *
 * Drives each PostToolUse hook command from `hooks/hooks.json` with synthetic
 * Claude-Code-style stdin against a locally built CLI, asserting:
 *
 *   - Exit code 0 (no parser errors like "Invalid value for --format")
 *   - Output records the *intended* value (the file path / command), not a
 *     stray boolean like "true" — the symptom that #1859 reported
 *
 * The script substitutes `npx claude-flow@alpha` → the local CLI binary, so
 * we exercise the same flag wiring users hit in production but pinned to
 * the build under test.
 *
 * Usage (from repo root):
 *   node plugins/ruflo-core/scripts/test-hooks.mjs <path-to-cli-binary>
 *
 * Wired into .github/workflows/v3-ci.yml as the `plugin-hooks-smoke` job.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_JSON = join(__dirname, '..', 'hooks', 'hooks.json');

// `cliInvoke` is the literal token-string that should run the CLI — caller
// passes the full thing so this script doesn't need to guess shebangs:
//   - local node script:   "node /abs/path/to/bin/cli.js"
//   - shell wrapper:       "/abs/path/to/wrapper.sh"
//   - npx fallthrough:     "npx --yes @claude-flow/cli@latest"
const cliInvoke = process.argv[2];
if (!cliInvoke) {
  console.error('Usage: node test-hooks.mjs "<cli-invocation-string>"');
  console.error('Examples:');
  console.error('  node test-hooks.mjs "node $PWD/v3/@claude-flow/cli/bin/cli.js"');
  console.error('  node test-hooks.mjs "npx --yes @claude-flow/cli@latest"');
  process.exit(2);
}

const hooks = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
const post = hooks.hooks?.PostToolUse ?? [];

const findHook = (matcher) => {
  const hit = post.find(h => h.matcher === matcher);
  if (!hit) throw new Error(`No PostToolUse hook with matcher=${matcher}`);
  return hit.hooks[0].command.replace(/npx claude-flow@alpha/g, cliInvoke);
};

const cmdBash = findHook('Bash');
const cmdEdit = findHook('Write|Edit|MultiEdit');

let failed = 0;
const cases = [];

const run = (name, cmd, stdin, assertions) => {
  const r = spawnSync('bash', ['-c', cmd], { input: stdin, encoding: 'utf8' });
  const combined = (r.stdout ?? '') + (r.stderr ?? '');
  const errors = [];
  if (r.status !== 0) errors.push(`exit ${r.status} (expected 0)`);
  for (const a of assertions) {
    if (a.contains && !combined.includes(a.contains)) errors.push(`missing "${a.contains}" in output`);
    if (a.absent && combined.includes(a.absent)) errors.push(`unexpected "${a.absent}" in output`);
  }
  if (errors.length === 0) {
    console.log(`ok: ${name}`);
  } else {
    console.error(`FAIL: ${name}`);
    for (const e of errors) console.error(`     - ${e}`);
    if (combined.trim()) {
      console.error('     output:');
      for (const line of combined.split('\n').slice(0, 8)) console.error(`       ${line}`);
    }
    failed++;
  }
  cases.push(name);
};

// --- Edit hook ---
run('Edit hook records file_path (regression #1859: was "true")',
  cmdEdit,
  '{"tool_input":{"file_path":"/tmp/foo.ts"}}',
  [{ contains: '/tmp/foo.ts' }, { absent: 'Recording outcome for: true' }, { absent: 'Invalid value' }]);

run('Edit hook records legacy "path" field',
  cmdEdit,
  '{"tool_input":{"path":"/tmp/bar.ts"}}',
  [{ contains: '/tmp/bar.ts' }, { absent: 'Invalid value' }]);

run('Edit hook silently no-ops when no path present',
  cmdEdit,
  '{"tool_input":{}}',
  []);

// --- Bash hook ---
run('Bash hook records simple command',
  cmdBash,
  '{"tool_input":{"command":"echo hi"},"tool_response":{"exit_code":0}}',
  [{ contains: 'echo hi' }, { absent: 'Required option missing' }, { absent: 'Invalid value' }]);

run('Bash hook records multi-line heredoc (regression #1859)',
  cmdBash,
  '{"tool_input":{"command":"cat <<EOF\\nline1\\nline2\\nEOF"},"tool_response":{"exit_code":0}}',
  [{ contains: 'cat <<EOF' }, { absent: 'Required option missing' }]);

run('Bash hook records non-zero exit (distinct from -s value)',
  cmdBash,
  '{"tool_input":{"command":"echo failing-cmd"},"tool_response":{"exit_code":1}}',
  [{ contains: 'echo failing-cmd' }, { absent: 'Recording command outcome: false' }, { absent: 'Recording command outcome: true' }]);

run('Bash hook silently no-ops when no command present',
  cmdBash,
  '{"tool_input":{},"tool_response":{}}',
  []);

console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);
