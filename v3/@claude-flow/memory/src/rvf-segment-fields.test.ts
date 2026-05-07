/**
 * ADR-0154 Phase 2: TS-side field mapping unit tests.
 *
 * Validates `encodeMemoryEntryMetadata` + `decodeMemoryEntryMetadata`
 * round-trip a `MemoryEntry` (minus its embedding) through the wire-shape
 * consumed by `RvfDatabase.ingestBatch` / `RvfDatabase.getMetadataEntries`.
 *
 * What this does NOT test:
 *  - The native runtime persists META_SEGs end-to-end (covered by Rust
 *    integration test `adr0154_meta_seg_round_trip.rs`).
 *  - The full backend stack reads back via `loadFromNativeSegments`
 *    (covered by acceptance `adr0154-single-file-storage.test.mjs`).
 */

import { describe, it, expect } from 'vitest';
import {
  RVF_FIELD_ID,
  encodeMemoryEntryMetadata,
  decodeMemoryEntryMetadata,
  type RvfMetadataEntryWire,
} from './rvf-segment-fields.js';
import type { MemoryEntry } from './types.js';

function sampleEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'test-id-001',
    key: 'test-key',
    content: 'hello world',
    type: 'general' as MemoryEntry['type'],
    namespace: 'unit-test',
    tags: ['alpha', 'beta'],
    metadata: { foo: 'bar', n: 42 },
    ownerId: undefined,
    accessLevel: 'private' as MemoryEntry['accessLevel'],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    version: 1,
    references: ['ref-1', 'ref-2'],
    accessCount: 0,
    lastAccessedAt: 0,
    ...overrides,
  };
}

describe('rvf-segment-fields encode/decode', () => {
  it('encode produces one entry per field plus the entry-blob', () => {
    const e = sampleEntry();
    const wire = encodeMemoryEntryMetadata(e);
    const ids = wire.map((w) => w.fieldId).sort((a, b) => a - b);
    expect(ids).toEqual([
      RVF_FIELD_ID.KEY,
      RVF_FIELD_ID.NAMESPACE,
      RVF_FIELD_ID.CONTENT,
      RVF_FIELD_ID.TAGS_JSON,
      RVF_FIELD_ID.METADATA_JSON,
      RVF_FIELD_ID.ACCESS_LEVEL,
      RVF_FIELD_ID.OWNER_ID,
      RVF_FIELD_ID.CREATED_AT,
      RVF_FIELD_ID.UPDATED_AT,
      RVF_FIELD_ID.VERSION,
      RVF_FIELD_ID.REFERENCES_JSON,
      RVF_FIELD_ID.ENTRY_BLOB,
    ].sort((a, b) => a - b));
  });

  it('entry-blob is a Buffer with valueType=bytes', () => {
    const e = sampleEntry();
    const wire = encodeMemoryEntryMetadata(e);
    const blob = wire.find((w) => w.fieldId === RVF_FIELD_ID.ENTRY_BLOB);
    expect(blob).toBeDefined();
    expect(blob!.valueType).toBe('bytes');
    expect(blob!.valueBytes).toBeInstanceOf(Buffer);
  });

  it('entry-blob contains the full record minus embedding', () => {
    const e = sampleEntry({
      embedding: new Float32Array([0.1, 0.2, 0.3]),
    });
    const wire = encodeMemoryEntryMetadata(e);
    const blob = wire.find((w) => w.fieldId === RVF_FIELD_ID.ENTRY_BLOB)!;
    const parsed = JSON.parse(blob.valueBytes!.toString('utf8'));
    expect(parsed.embedding).toBeUndefined();
    expect(parsed.key).toBe(e.key);
    expect(parsed.namespace).toBe(e.namespace);
    expect(parsed.tags).toEqual(e.tags);
  });

  it('round-trip recovers all fields via blob fast path', () => {
    const original = sampleEntry({ ownerId: 'agent-7' });
    const wire = encodeMemoryEntryMetadata(original);
    const decoded = decodeMemoryEntryMetadata(wire);

    expect(decoded.key).toBe(original.key);
    expect(decoded.namespace).toBe(original.namespace);
    expect(decoded.content).toBe(original.content);
    expect(decoded.tags).toEqual(original.tags);
    expect(decoded.metadata).toEqual(original.metadata);
    expect(decoded.accessLevel).toBe(original.accessLevel);
    expect(decoded.ownerId).toBe(original.ownerId);
    expect(decoded.createdAt).toBe(original.createdAt);
    expect(decoded.updatedAt).toBe(original.updatedAt);
    expect(decoded.version).toBe(original.version);
    expect(decoded.references).toEqual(original.references);
  });

  it('decode falls back to per-field reconstruction when blob is missing', () => {
    const original = sampleEntry();
    const wire = encodeMemoryEntryMetadata(original);
    // Strip the blob entry to force per-field fallback.
    const stripped = wire.filter((w) => w.fieldId !== RVF_FIELD_ID.ENTRY_BLOB);
    const decoded = decodeMemoryEntryMetadata(stripped);

    expect(decoded.key).toBe(original.key);
    expect(decoded.namespace).toBe(original.namespace);
    expect(decoded.content).toBe(original.content);
    expect(decoded.tags).toEqual(original.tags);
    expect(decoded.createdAt).toBe(original.createdAt);
  });

  it('decode prefers blob when blob is intact and individual fields disagree', () => {
    const original = sampleEntry();
    const wire = encodeMemoryEntryMetadata(original);

    // Tamper an individual field but leave the blob alone.
    const tampered = wire.map((w) =>
      w.fieldId === RVF_FIELD_ID.KEY
        ? { ...w, value: 'tampered-key' }
        : w,
    );
    const decoded = decodeMemoryEntryMetadata(tampered);

    // Blob wins.
    expect(decoded.key).toBe(original.key);
  });

  it('decode falls back to per-field when blob is malformed JSON', () => {
    const original = sampleEntry();
    const wire = encodeMemoryEntryMetadata(original);
    const tampered = wire.map((w) =>
      w.fieldId === RVF_FIELD_ID.ENTRY_BLOB
        ? { ...w, valueBytes: Buffer.from('{ this is not valid json', 'utf8') }
        : w,
    );
    const decoded = decodeMemoryEntryMetadata(tampered);
    // Falls back to KEY field.
    expect(decoded.key).toBe(original.key);
  });

  it('throws when neither blob nor key are present', () => {
    const wire: RvfMetadataEntryWire[] = [
      { fieldId: RVF_FIELD_ID.NAMESPACE, valueType: 'string', value: 'ns' },
    ];
    expect(() => decodeMemoryEntryMetadata(wire)).toThrow(
      /no entry blob and no key field present/,
    );
  });

  it('encode handles missing optional fields gracefully', () => {
    const minimal: MemoryEntry = {
      id: 'min-id',
      key: 'min',
      content: '',
      type: 'general' as MemoryEntry['type'],
      namespace: 'ns',
      tags: [],
      metadata: {},
      accessLevel: 'private' as MemoryEntry['accessLevel'],
      createdAt: 0,
      updatedAt: 0,
      version: 0,
      references: [],
      accessCount: 0,
      lastAccessedAt: 0,
    };
    const wire = encodeMemoryEntryMetadata(minimal);
    const ownerEntry = wire.find((w) => w.fieldId === RVF_FIELD_ID.OWNER_ID);
    expect(ownerEntry).toBeDefined();
    expect(ownerEntry!.value).toBe('');
  });

  it('field IDs are stable wire format — sentinel values', () => {
    // If any of these change, every existing .rvf with META_SEGs becomes
    // unreadable. They are wire format. Append-only.
    expect(RVF_FIELD_ID.KEY).toBe(1);
    expect(RVF_FIELD_ID.NAMESPACE).toBe(2);
    expect(RVF_FIELD_ID.CONTENT).toBe(3);
    expect(RVF_FIELD_ID.TAGS_JSON).toBe(4);
    expect(RVF_FIELD_ID.METADATA_JSON).toBe(5);
    expect(RVF_FIELD_ID.ACCESS_LEVEL).toBe(6);
    expect(RVF_FIELD_ID.OWNER_ID).toBe(7);
    expect(RVF_FIELD_ID.CREATED_AT).toBe(8);
    expect(RVF_FIELD_ID.UPDATED_AT).toBe(9);
    expect(RVF_FIELD_ID.VERSION).toBe(10);
    expect(RVF_FIELD_ID.REFERENCES_JSON).toBe(11);
    expect(RVF_FIELD_ID.ENTRY_BLOB).toBe(99);
  });
});
