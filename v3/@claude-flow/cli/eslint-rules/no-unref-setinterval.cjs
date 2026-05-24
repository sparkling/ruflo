/**
 * no-unref-setinterval — ESLint rule (custom, local to this package).
 *
 * ADR-0243 §Decision Option C addendum: flag `setInterval(...)` calls
 * whose handle is not `.unref()`'d in the same statement (direct chain)
 * or within `lookAhead` statements of the same enclosing block (typical
 * `this.timer = setInterval(...); this.timer.unref()` pattern). Catches
 * the recurring F-10-002 class — a long-lived process pinned because a
 * timer handle was assigned without `.unref()` — at edit time instead of
 * waiting for the runtime carry-forward soak test (G-16-014).
 *
 * Scope: applied to `cli/src/**` and `memory/src/**`. Excluded from
 * `v3/mcp/**` via `overrides` because that subtree is the cluster-2
 * carry-forward in [[ADR-0239]]; fixing inside it would patch code
 * marked for deletion.
 *
 * Allowed patterns (NOT flagged):
 *   - `this.timer = setInterval(fn, ms); this.timer.unref()` — assign +
 *     `.unref()` within `lookAhead` statements of the same block.
 *   - `setInterval(fn, ms).unref()` — directly chained.
 *   - `setInterval(fn, ms)` as a top-level expression statement WITH a
 *     marker comment `eslint-disable-next-line no-unref-setinterval` or
 *     `// no-unref-setinterval: keep-alive` on the same or previous line
 *     (the daemon keep-alive case at `commands/daemon.ts:185-189`).
 *
 * Short-lived CLI commands (status/progress/start) that legitimately
 * skip `.unref()` because the process is short-lived must add an
 * `// eslint-disable-next-line no-unref-setinterval` marker at the
 * setInterval call. The rule does not auto-detect "is the file a
 * short-lived entrypoint" — humans choose.
 *
 * Limitations:
 *   - Lookahead is statement-based; an `.unref()` reached only via a
 *     conditional branch within `lookAhead` will be conservatively
 *     credited as compliant (the rule is a regression guard, not a
 *     formal analyser).
 *   - The rule does not check `clearInterval` cleanup paths; those are
 *     orthogonal to event-loop-pin (which is what `.unref()` solves).
 */

'use strict';

const DEFAULT_LOOK_AHEAD = 8;

/** Find the enclosing block / program node for an AST node. */
function enclosingBlock(node) {
  let cur = node;
  while (cur) {
    if (
      cur.type === 'BlockStatement' ||
      cur.type === 'Program' ||
      cur.type === 'StaticBlock'
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

/** True if `callExpr` is a direct `.unref()` chain on `setInterval(...)`. */
function isDirectUnrefChain(callExpr) {
  // shape: setInterval(...).unref()  →  parent is MemberExpression .unref
  const parent = callExpr.parent;
  if (
    parent &&
    parent.type === 'MemberExpression' &&
    parent.object === callExpr &&
    parent.property &&
    parent.property.type === 'Identifier' &&
    parent.property.name === 'unref'
  ) {
    const grand = parent.parent;
    if (grand && grand.type === 'CallExpression' && grand.callee === parent) {
      return true;
    }
  }
  // shape: setInterval(...)?.unref()  →  ChainExpression wrapper
  if (parent && parent.type === 'ChainExpression') {
    return isDirectUnrefChain(parent);
  }
  return false;
}

/**
 * Identify the target ident the `setInterval` result is stored in. Looks
 * at the immediate parent AssignmentExpression / VariableDeclarator and
 * returns the LHS identifier name(s) for later lookup.
 *
 * Returns array because `this.x = this.y = setInterval(...)` chains assign
 * to multiple targets (rare but possible).
 */
function collectAssignmentTargets(callExpr) {
  const targets = [];
  let cur = callExpr;
  let parent = cur.parent;

  while (parent) {
    if (parent.type === 'AssignmentExpression' && parent.right === cur) {
      pushTargetName(parent.left, targets);
      cur = parent;
      parent = cur.parent;
      continue;
    }
    if (parent.type === 'VariableDeclarator' && parent.init === cur) {
      pushTargetName(parent.id, targets);
      return targets;
    }
    if (parent.type === 'Property' && parent.value === cur) {
      // Inside an object literal — not a tracked path.
      return targets;
    }
    break;
  }
  return targets;
}

function pushTargetName(node, out) {
  if (!node) return;
  if (node.type === 'Identifier') {
    out.push({ kind: 'identifier', name: node.name });
    return;
  }
  if (
    node.type === 'MemberExpression' &&
    node.object &&
    node.property &&
    node.property.type === 'Identifier' &&
    !node.computed
  ) {
    if (node.object.type === 'ThisExpression') {
      out.push({ kind: 'member', text: `this.${node.property.name}` });
      return;
    }
    if (node.object.type === 'Identifier') {
      out.push({ kind: 'member', text: `${node.object.name}.${node.property.name}` });
      return;
    }
  }
  // Other LHS shapes (Pattern, deeper chains) not tracked — leave empty.
}

/**
 * Find the statement node that contains `callExpr` in its subtree but
 * whose parent is a block / program / static block. This is the unit we
 * use for lookahead counting.
 */
function enclosingStatement(node) {
  let cur = node;
  while (cur) {
    const parent = cur.parent;
    if (!parent) return null;
    if (
      parent.type === 'BlockStatement' ||
      parent.type === 'Program' ||
      parent.type === 'StaticBlock'
    ) {
      return cur;
    }
    cur = parent;
  }
  return null;
}

/**
 * Walk an AST subtree and ask the predicate on every CallExpression.
 * Returns true on first match.
 */
function someCallExpression(root, predicate) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if (n.type === 'CallExpression' && predicate(n)) return true;
    for (const key of Object.keys(n)) {
      const v = n[key];
      if (!v) continue;
      if (key === 'parent') continue;
      if (Array.isArray(v)) {
        for (const child of v) {
          if (child && typeof child === 'object' && typeof child.type === 'string') {
            stack.push(child);
          }
        }
      } else if (typeof v === 'object' && typeof v.type === 'string') {
        stack.push(v);
      }
    }
  }
  return false;
}

/**
 * Does `subtree` contain a CallExpression of `target.unref()` (or
 * `.unref?.()` etc.)?
 */
function containsUnrefCall(subtree, targetText) {
  return someCallExpression(subtree, (call) => {
    const callee = call.callee;
    if (!callee) return false;
    // optional chain: x?.unref()
    let mem = callee;
    if (mem.type === 'ChainExpression') mem = mem.expression;
    if (mem.type !== 'MemberExpression') return false;
    if (!mem.property || mem.property.type !== 'Identifier' || mem.property.name !== 'unref') {
      return false;
    }
    // Verify the object matches the target text.
    return memberObjectMatches(mem.object, targetText);
  });
}

function memberObjectMatches(node, targetText) {
  if (!node) return false;
  if (node.type === 'ChainExpression') {
    return memberObjectMatches(node.expression, targetText);
  }
  if (node.type === 'TSNonNullExpression') {
    return memberObjectMatches(node.expression, targetText);
  }
  if (node.type === 'Identifier') {
    return node.name === targetText;
  }
  if (node.type === 'MemberExpression') {
    if (node.object && node.object.type === 'ThisExpression' && node.property && node.property.type === 'Identifier' && !node.computed) {
      return `this.${node.property.name}` === targetText;
    }
    if (
      node.object && node.object.type === 'Identifier' &&
      node.property && node.property.type === 'Identifier' &&
      !node.computed
    ) {
      return `${node.object.name}.${node.property.name}` === targetText;
    }
  }
  return false;
}

/**
 * Check whether the source code has an `eslint-disable-next-line` /
 * inline disable / explicit "keep-alive" marker that authorises a bare
 * setInterval. eslint's own machinery handles the standard disable
 * directives, but we also accept a free-form keep-alive marker on the
 * preceding or trailing comment line.
 */
function hasKeepAliveMarker(node, sourceCode) {
  if (!sourceCode) return false;
  // Walk up to the enclosing statement: comments attach to statement
  // boundaries, not bare CallExpression subnodes.
  let stmt = node;
  while (stmt.parent && stmt.parent.type !== 'BlockStatement' && stmt.parent.type !== 'Program' && stmt.parent.type !== 'StaticBlock') {
    stmt = stmt.parent;
  }
  const before = sourceCode.getCommentsBefore(stmt) || [];
  const after = sourceCode.getCommentsAfter(stmt) || [];
  const inside = sourceCode.getCommentsInside ? (sourceCode.getCommentsInside(stmt) || []) : [];
  for (const c of [...before, ...after, ...inside]) {
    if (/no-unref-setinterval:\s*keep-alive/i.test(c.value)) return true;
  }
  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "setInterval(...) result must be .unref()'d to avoid pinning Node's event loop on long-lived processes",
      category: 'Possible Errors',
      recommended: false,
    },
    schema: [
      {
        type: 'object',
        properties: {
          lookAhead: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingUnref:
        "setInterval(...) is not .unref()'d. Pinning the event loop on long-lived processes (ADR-0243 F-10-002). Either chain .unref() or add '// no-unref-setinterval: keep-alive' if a ref'd handle is intentional.",
    },
  },
  create(context) {
    const options = context.options[0] || {};
    const lookAhead = Number.isInteger(options.lookAhead) ? options.lookAhead : DEFAULT_LOOK_AHEAD;
    const sourceCode = context.getSourceCode ? context.getSourceCode() : context.sourceCode;

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (!callee) return;
        // Match: setInterval(...)
        let isSetInterval = false;
        if (callee.type === 'Identifier' && callee.name === 'setInterval') {
          isSetInterval = true;
        } else if (
          callee.type === 'MemberExpression' &&
          callee.property &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'setInterval'
        ) {
          // globalThis.setInterval, global.setInterval — still flagged.
          isSetInterval = true;
        }
        if (!isSetInterval) return;

        if (isDirectUnrefChain(node)) return;

        if (hasKeepAliveMarker(node, sourceCode)) return;

        const targets = collectAssignmentTargets(node);
        const block = enclosingBlock(node);
        const stmt = enclosingStatement(node);
        if (block && stmt && targets.length > 0) {
          const body = block.body || (block.type === 'StaticBlock' ? block.body : []);
          const idx = body.indexOf(stmt);
          if (idx >= 0) {
            const end = Math.min(body.length - 1, idx + lookAhead);
            for (const t of targets) {
              const text = t.kind === 'member' ? t.text : t.name;
              for (let i = idx; i <= end; i++) {
                if (containsUnrefCall(body[i], text)) {
                  return;
                }
              }
            }
          }
        }

        context.report({ node, messageId: 'missingUnref' });
      },
    };
  },
};
