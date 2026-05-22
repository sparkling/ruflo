/**
 * Tests ADR-0224 F-14-009 — provider default skew fix.
 *
 * `embedding.provider` (config-template.ts:85) and
 * `memory.embeddings.provider` (config-template.ts:173) must emit the same
 * default value into a freshly-generated config.json. Before the fix, the
 * latter emitted `'transformers.js'` while the former emitted `'onnx'`,
 * surfacing as two different values for the same logical concept via
 * `ruflo config get` even though `config-chain/src/index.ts:176` normalises
 * the discrepancy at runtime.
 */

import { describe, it, expect } from 'vitest';
import {
  getMinimalConfigTemplate,
  getFullConfigTemplate,
} from '../src/init/config-template.js';

describe('config-template provider default unification (ADR-0224 F-14-009)', () => {
  it('minimal template emits embedding.provider = "onnx"', () => {
    const tpl = getMinimalConfigTemplate() as { embedding: { provider: string } };
    expect(tpl.embedding.provider).toBe('onnx');
  });

  it('full template emits embedding.provider = "onnx"', () => {
    const tpl = getFullConfigTemplate() as { embedding: { provider: string } };
    expect(tpl.embedding.provider).toBe('onnx');
  });

  it('full template emits memory.embeddings.provider = "onnx" (was "transformers.js")', () => {
    const tpl = getFullConfigTemplate() as {
      memory: { embeddings: { provider: string } };
    };
    expect(tpl.memory.embeddings.provider).toBe('onnx');
  });

  it('embedding.provider and memory.embeddings.provider have the same value (no skew)', () => {
    const tpl = getFullConfigTemplate() as {
      embedding: { provider: string };
      memory: { embeddings: { provider: string } };
    };
    expect(tpl.memory.embeddings.provider).toBe(tpl.embedding.provider);
  });
});
