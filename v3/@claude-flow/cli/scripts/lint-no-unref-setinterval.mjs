#!/usr/bin/env node
/**
 * lint-no-unref-setinterval — ADR-0243 §Decision Option C addendum.
 *
 * Runs as the `lint` npm script for `@claude-flow/cli` and
 * `@claude-flow/memory`. Walks every TypeScript / JavaScript file under
 * `src/` (config-driven, defaults below), parses each via the
 * `typescript` package, and flags every `setInterval(...)` whose result
 * is not `.unref()`'d within a small lookahead window in the same
 * enclosing block.
 *
 * Why a custom Node script instead of an ESLint plugin:
 *   - ESLint 8 doesn't ship a TS parser; adding `@typescript-eslint/parser`
 *     as a devDep cascades into the workspace's broken peer-dep resolution
 *     (workspace:* protocol + ETARGET against the private registry).
 *   - The lint surface here is one rule. A standalone script with a
 *     12K-LOC custom AST walker is cheaper than fighting the lint
 *     toolchain.
 *
 * Why TypeScript's parser specifically:
 *   - It is already a devDep of every workspace (each pkg has its own
 *     tsc build). No new dependency.
 *   - It parses TS-syntax (decorators, type assertions, `as const`,
 *     `enum`) that `acorn` (the only other parser already in
 *     node_modules) does not.
 *
 * Exit codes:
 *   - 0: all setInterval sites are `.unref()`'d or carry an explicit
 *     `// no-unref-setinterval: keep-alive` marker.
 *   - 1: one or more violations found; prints `file:line:col` per
 *     finding plus a suggestion.
 *   - 2: usage / config error.
 *
 * Configuration is via CLI args; see USAGE below.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const USAGE = `Usage: lint-no-unref-setinterval [--root <dir>] [--ext .ts,.tsx,.cts,.mts,.js,.cjs,.mjs] [--look-ahead N] [--exclude <glob>] [--quiet]

Defaults:
  --root          src
  --ext           .ts,.tsx,.cts,.mts,.js,.cjs,.mjs
  --look-ahead    8
  --exclude       node_modules/**, dist/**, __tests__/**, **/*.test.ts, **/*.test.tsx, **/v3/mcp/**, **/mcp/**
`;

const DEFAULT_EXTS = ['.ts', '.tsx', '.cts', '.mts', '.js', '.cjs', '.mjs'];
const DEFAULT_EXCLUDES = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)__tests__(\/|$)/,
  /\.test\.[cm]?[tj]sx?$/,
  /(^|\/)v3\/mcp(\/|$)/,
  /(^|\/)mcp(\/|$)/,
];

function parseArgs(argv) {
  const args = { root: 'src', exts: DEFAULT_EXTS, lookAhead: 8, excludes: DEFAULT_EXCLUDES, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') { args.root = argv[++i]; continue; }
    if (a === '--ext') { args.exts = argv[++i].split(',').map(s => s.trim()); continue; }
    if (a === '--look-ahead') { args.lookAhead = Number.parseInt(argv[++i], 10); continue; }
    if (a === '--exclude') { args.excludes.push(new RegExp(argv[++i])); continue; }
    if (a === '--quiet') { args.quiet = true; continue; }
    if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    console.error(`Unknown arg: ${a}`);
    console.error(USAGE);
    process.exit(2);
  }
  if (!Number.isInteger(args.lookAhead) || args.lookAhead < 0) {
    console.error(`--look-ahead must be a non-negative integer, got ${args.lookAhead}`);
    process.exit(2);
  }
  return args;
}

async function* walk(dir, exts, excludes) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (excludes.some(re => re.test(full))) continue;
    if (entry.isDirectory()) {
      yield* walk(full, exts, excludes);
    } else if (entry.isFile() && exts.some(e => full.endsWith(e))) {
      yield full;
    }
  }
}

function fileScript(filePath) {
  const lc = filePath.toLowerCase();
  if (lc.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (lc.endsWith('.cts')) return ts.ScriptKind.TS;
  if (lc.endsWith('.mts')) return ts.ScriptKind.TS;
  if (lc.endsWith('.ts')) return ts.ScriptKind.TS;
  if (lc.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (lc.endsWith('.cjs')) return ts.ScriptKind.JS;
  if (lc.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.JS;
}

function isSetIntervalCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee) && callee.text === 'setInterval') return true;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.name) &&
    callee.name.text === 'setInterval'
  ) return true;
  return false;
}

function isDirectUnrefChain(call) {
  const parent = call.parent;
  if (
    parent &&
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === call &&
    ts.isIdentifier(parent.name) &&
    parent.name.text === 'unref' &&
    parent.parent &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  ) {
    return true;
  }
  // optional chain: setInterval(...)?.unref()
  if (parent && ts.isNonNullExpression(parent)) {
    return isDirectUnrefChain(parent);
  }
  return false;
}

function targetTextForAssignment(call) {
  let node = call;
  while (node.parent) {
    const p = node.parent;
    // const x = setInterval(...)
    if (ts.isVariableDeclaration(p) && p.initializer === node) {
      return identifierTextFromBinding(p.name);
    }
    // x = setInterval(...) or this.x = setInterval(...)
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === node) {
      return propertyAccessOrIdentifierText(p.left);
    }
    // wrap-in-parens
    if (ts.isParenthesizedExpression(p) && p.expression === node) {
      node = p;
      continue;
    }
    break;
  }
  return null;
}

function identifierTextFromBinding(name) {
  if (ts.isIdentifier(name)) return name.text;
  return null;
}

function unwrap(node) {
  while (node) {
    if (ts.isParenthesizedExpression(node)) { node = node.expression; continue; }
    if (ts.isAsExpression && ts.isAsExpression(node)) { node = node.expression; continue; }
    if (ts.isNonNullExpression(node)) { node = node.expression; continue; }
    if (ts.isTypeAssertionExpression && ts.isTypeAssertionExpression(node)) { node = node.expression; continue; }
    if (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node)) { node = node.expression; continue; }
    break;
  }
  return node;
}

function propertyAccessOrIdentifierText(node) {
  const inner = unwrap(node);
  if (!inner) return null;
  if (ts.isIdentifier(inner)) return inner.text;
  if (
    ts.isPropertyAccessExpression(inner) &&
    ts.isIdentifier(inner.name)
  ) {
    const obj = unwrap(inner.expression);
    if (obj && obj.kind === ts.SyntaxKind.ThisKeyword) {
      return `this.${inner.name.text}`;
    }
    if (obj && ts.isIdentifier(obj)) {
      return `${obj.text}.${inner.name.text}`;
    }
  }
  return null;
}

function findEnclosingBlock(node) {
  let cur = node;
  while (cur && cur.parent) {
    cur = cur.parent;
    if (ts.isBlock(cur) || ts.isSourceFile(cur)) return cur;
  }
  return null;
}

function findEnclosingStatementIndex(block, node) {
  const stmts = ts.isSourceFile(block) ? block.statements : block.statements;
  if (!stmts) return -1;
  for (let i = 0; i < stmts.length; i++) {
    if (containsNode(stmts[i], node)) return i;
  }
  return -1;
}

function containsNode(haystack, needle) {
  if (haystack === needle) return true;
  let found = false;
  haystack.forEachChild((child) => {
    if (found) return;
    if (containsNode(child, needle)) found = true;
  });
  return found;
}

function statementContainsUnref(stmt, targetText) {
  let found = false;
  function visit(node) {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.name) &&
      node.expression.name.text === 'unref'
    ) {
      const objText = propertyAccessOrIdentifierText(node.expression.expression);
      if (objText === targetText) {
        found = true;
        return;
      }
    }
    node.forEachChild(visit);
  }
  visit(stmt);
  return found;
}

function hasKeepAliveMarker(sf, node) {
  // Walk up to the enclosing top-level statement to harvest comments.
  let stmt = node;
  while (stmt.parent && !ts.isBlock(stmt.parent) && !ts.isSourceFile(stmt.parent)) {
    stmt = stmt.parent;
  }
  const fullText = sf.getFullText();
  // Leading comments BEFORE the statement.
  const leading = ts.getLeadingCommentRanges(fullText, stmt.getFullStart()) || [];
  // Trailing comments on the SAME line as the statement.
  const trailing = ts.getTrailingCommentRanges(fullText, stmt.getEnd()) || [];
  // Comments INSIDE the statement (the call expression itself often has
  // an end-of-line `// no-unref-setinterval: keep-alive` right after).
  const insideLeading = ts.getLeadingCommentRanges(fullText, node.getFullStart()) || [];
  const insideTrailing = ts.getTrailingCommentRanges(fullText, node.getEnd()) || [];
  const all = [...leading, ...trailing, ...insideLeading, ...insideTrailing];
  for (const range of all) {
    const text = fullText.slice(range.pos, range.end);
    if (/no-unref-setinterval:\s*keep-alive/i.test(text)) return true;
  }
  return false;
}

function lintFile(filePath, source, lookAhead) {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, /*setParentNodes*/ true, fileScript(filePath));
  const findings = [];
  function visit(node) {
    if (isSetIntervalCall(node)) {
      if (!isDirectUnrefChain(node) && !hasKeepAliveMarker(sf, node)) {
        // Look for an assignment target + check next `lookAhead` statements.
        const target = targetTextForAssignment(node);
        const block = findEnclosingBlock(node);
        let ok = false;
        if (target && block) {
          const idx = findEnclosingStatementIndex(block, node);
          if (idx >= 0) {
            const stmts = ts.isSourceFile(block) ? block.statements : block.statements;
            const end = Math.min(stmts.length - 1, idx + lookAhead);
            for (let i = idx; i <= end; i++) {
              if (statementContainsUnref(stmts[i], target)) { ok = true; break; }
            }
          }
        }
        if (!ok) {
          const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          findings.push({ filePath, line: line + 1, column: character + 1 });
        }
      }
    }
    node.forEachChild(visit);
  }
  visit(sf);
  return findings;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const findings = [];
  for await (const file of walk(root, args.exts, args.excludes)) {
    let source;
    try {
      source = await fs.readFile(file, 'utf8');
    } catch (err) {
      console.error(`failed to read ${file}: ${err && err.message ? err.message : err}`);
      process.exit(2);
    }
    findings.push(...lintFile(file, source, args.lookAhead));
  }
  if (findings.length === 0) {
    if (!args.quiet) console.log('lint-no-unref-setinterval: no violations (0 findings)');
    process.exit(0);
  }
  for (const f of findings) {
    console.error(
      `${f.filePath}:${f.line}:${f.column}  error  setInterval(...) is not .unref()'d. Pinning Node's event loop on long-lived processes (ADR-0243 F-10-002). Chain .unref() or add '// no-unref-setinterval: keep-alive' for an intentional ref'd handle.`,
    );
  }
  console.error(`\nlint-no-unref-setinterval: ${findings.length} violation${findings.length === 1 ? '' : 's'}`);
  process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(2);
  });
}
