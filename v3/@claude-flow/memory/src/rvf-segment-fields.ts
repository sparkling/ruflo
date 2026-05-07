/**
 * ADR-0154 Phase 2: TS-side mapping between MemoryEntry fields and the
 * on-disk META_SEG payload format implemented by the rvf-runtime crate
 * (`rvf-runtime/src/meta_payload.rs`).
 *
 * The `field_id: u16` values reserved here are wire format: never reorder,
 * never reuse, append-only. New fields must claim the next unused id.
 *
 * Why both per-field IDs (1..11) AND an entry-blob (99)?
 *  - Per-field IDs enable filter push-down at the runtime layer (e.g. "find
 *    entries in namespace X" using `FilterExpr::Eq(2, value)` against the
 *    in-memory MetadataStore).
 *  - The entry-blob is a JSON-serialized `MemoryEntry` minus its embedding,
 *    giving lossless round-trip for any field not yet promoted to a stable
 *    field_id (forward-compat).
 *
 * The runtime accepts these via `RvfDatabase.ingestBatch(vectors, ids,
 * metadata)` where each `metadata` entry is a flat `RvfMetadataEntry` with
 * `{fieldId, valueType, value, valueBytes?}`. ADR-0154 Phase 1 wires the
 * runtime to persist them to META_SEGs and reconstruct on reopen.
 */

import { Buffer } from 'node:buffer';
import type { MemoryEntry } from './types.js';

/**
 * Stable field IDs. Append-only — never reorder, never reuse.
 *
 * Range allocation:
 *  - 1–98: reserved for promoted MemoryEntry fields (filter push-down).
 *  - 99: entry-blob (full serialized record minus embedding).
 *  - 100+: reserved for future use; do not allocate without ADR.
 */
export const RVF_FIELD_ID = {
  /** `MemoryEntry.key` — primary lookup string. */
  KEY: 1,
  /** `MemoryEntry.namespace` — partition key. */
  NAMESPACE: 2,
  /** `MemoryEntry.content` — body text. */
  CONTENT: 3,
  /** `MemoryEntry.tags` as JSON-encoded string. */
  TAGS_JSON: 4,
  /** `MemoryEntry.metadata` as JSON-encoded string. */
  METADATA_JSON: 5,
  /** `MemoryEntry.accessLevel` — enum string. */
  ACCESS_LEVEL: 6,
  /** `MemoryEntry.ownerId` — optional agent ID. */
  OWNER_ID: 7,
  /** `MemoryEntry.createdAt` — epoch milliseconds (i64). */
  CREATED_AT: 8,
  /** `MemoryEntry.updatedAt` — epoch milliseconds (i64). */
  UPDATED_AT: 9,
  /** `MemoryEntry.version` — optimistic-locking counter (i64). */
  VERSION: 10,
  /** `MemoryEntry.references` as JSON-encoded string. */
  REFERENCES_JSON: 11,
  /**
   * Full serialized `MemoryEntry` minus `embedding`, encoded as JSON UTF-8
   * bytes. Forward-compat carrier for fields not yet promoted to stable
   * field IDs above. Always emit alongside per-field IDs so a reader can
   * reconstruct any field even without knowledge of newer IDs.
   */
  ENTRY_BLOB: 99,
} as const;

export type RvfFieldId = typeof RVF_FIELD_ID[keyof typeof RVF_FIELD_ID];

/**
 * `value_type` strings accepted by `RvfMetadataEntry`. Mirrors the runtime's
 * `MetadataValue` enum + `parse_metadata_entry` napi binding.
 */
export type RvfValueType = 'u64' | 'i64' | 'f64' | 'string' | 'bytes';

/**
 * The wire-shape consumed by `RvfDatabase.ingestBatch(vectors, ids, metadata)`
 * and returned by `RvfDatabase.getMetadataEntries(id)`. Mirrors
 * `RvfMetadataEntry` in `rvf-node/src/lib.rs`.
 *
 * For `valueType === 'bytes'`, the binary payload is in `valueBytes` (a
 * Buffer); `value` is empty. For all other types `value` is the
 * string-serialized form (numerics as decimal strings, strings as-is).
 */
export interface RvfMetadataEntryWire {
  fieldId: number;
  valueType: RvfValueType;
  value: string;
  valueBytes?: Buffer;
}

/**
 * Encode a `MemoryEntry` (minus its embedding) as a META_SEG entry array.
 *
 * Emits per-field entries for IDs 1..11 plus the entry-blob at id 99. Entries
 * with empty/zero values are still emitted to keep the on-disk record shape
 * uniform (decoder relies on field presence, not absence-as-default).
 */
export function encodeMemoryEntryMetadata(
  entry: Omit<MemoryEntry, 'embedding'> & { embedding?: unknown },
): RvfMetadataEntryWire[] {
  const out: RvfMetadataEntryWire[] = [];

  out.push(stringEntry(RVF_FIELD_ID.KEY, entry.key));
  out.push(stringEntry(RVF_FIELD_ID.NAMESPACE, entry.namespace));
  out.push(stringEntry(RVF_FIELD_ID.CONTENT, entry.content));
  out.push(stringEntry(RVF_FIELD_ID.TAGS_JSON, JSON.stringify(entry.tags ?? [])));
  out.push(stringEntry(RVF_FIELD_ID.METADATA_JSON, JSON.stringify(entry.metadata ?? {})));
  out.push(stringEntry(RVF_FIELD_ID.ACCESS_LEVEL, String(entry.accessLevel ?? '')));
  out.push(stringEntry(RVF_FIELD_ID.OWNER_ID, entry.ownerId ?? ''));
  out.push(i64Entry(RVF_FIELD_ID.CREATED_AT, entry.createdAt ?? 0));
  out.push(i64Entry(RVF_FIELD_ID.UPDATED_AT, entry.updatedAt ?? 0));
  out.push(i64Entry(RVF_FIELD_ID.VERSION, entry.version ?? 0));
  out.push(stringEntry(RVF_FIELD_ID.REFERENCES_JSON, JSON.stringify(entry.references ?? [])));

  // Entry-blob: full record minus embedding. JSON-encoded; carried as bytes.
  // The cast strips embedding even though we declared it Omit-able above —
  // belt + braces, since callers might pass a complete MemoryEntry.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { embedding: _stripEmbedding, ...stripped } = entry as MemoryEntry;
  const blob = Buffer.from(JSON.stringify(stripped), 'utf8');
  out.push({
    fieldId: RVF_FIELD_ID.ENTRY_BLOB,
    valueType: 'bytes',
    value: '',
    valueBytes: blob,
  });

  return out;
}

/**
 * Decode META_SEG entries back into a `MemoryEntry` (without `embedding` —
 * the embedding is reconstructed from the VEC_SEG by the calling backend).
 *
 * Strategy: prefer `ENTRY_BLOB` (id=99) as the source of truth — it carries
 * every field including ones not yet promoted to per-field IDs. Use the
 * per-field IDs as a fallback if the blob is missing or malformed (forward-
 * compat for partial writes / format drift).
 *
 * Throws if the entry cannot be reconstructed at all (no blob, no key).
 */
export function decodeMemoryEntryMetadata(
  entries: RvfMetadataEntryWire[],
): Omit<MemoryEntry, 'embedding'> {
  const blob = entries.find((e) => e.fieldId === RVF_FIELD_ID.ENTRY_BLOB);
  if (blob && blob.valueType === 'bytes' && blob.valueBytes) {
    try {
      const parsed = JSON.parse(blob.valueBytes.toString('utf8')) as Omit<
        MemoryEntry,
        'embedding'
      >;
      if (parsed && typeof parsed === 'object' && typeof parsed.key === 'string') {
        return parsed;
      }
    } catch {
      // Fall through to per-field reconstruction.
    }
  }

  // Fallback: per-field reconstruction. Used when the blob is missing or
  // malformed (e.g. partial-write scenario, or future readers that disabled
  // the blob). Newer fields without an ID surface as defaulted values.
  const get = (id: number): RvfMetadataEntryWire | undefined =>
    entries.find((e) => e.fieldId === id);
  const getString = (id: number, fallback = ''): string => get(id)?.value ?? fallback;
  const getJson = <T,>(id: number, fallback: T): T => {
    const raw = get(id)?.value;
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };
  const getI64 = (id: number, fallback = 0): number => {
    const raw = get(id)?.value;
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };

  const key = getString(RVF_FIELD_ID.KEY);
  if (!key) {
    throw new Error('decodeMemoryEntryMetadata: no entry blob and no key field present');
  }

  // The narrow per-field reconstruction can't recover `id`, `type`,
  // `expiresAt`, `accessCount`, or `lastAccessedAt` (they're not in the
  // registry yet). Defaults match the conservative-restore behavior in
  // rvf-backend.ts for older entries that pre-date the field-ID registry.
  return {
    id: '', // caller must repopulate from key/namespace; intentionally empty here
    key,
    content: getString(RVF_FIELD_ID.CONTENT),
    type: 'general' as MemoryEntry['type'], // safe default; not in registry yet
    namespace: getString(RVF_FIELD_ID.NAMESPACE),
    tags: getJson<string[]>(RVF_FIELD_ID.TAGS_JSON, []),
    metadata: getJson<Record<string, unknown>>(RVF_FIELD_ID.METADATA_JSON, {}),
    ownerId: getString(RVF_FIELD_ID.OWNER_ID) || undefined,
    accessLevel: (getString(RVF_FIELD_ID.ACCESS_LEVEL) as MemoryEntry['accessLevel'])
      || ('private' as MemoryEntry['accessLevel']),
    createdAt: getI64(RVF_FIELD_ID.CREATED_AT),
    updatedAt: getI64(RVF_FIELD_ID.UPDATED_AT),
    version: getI64(RVF_FIELD_ID.VERSION),
    references: getJson<string[]>(RVF_FIELD_ID.REFERENCES_JSON, []),
    accessCount: 0,
    lastAccessedAt: 0,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function stringEntry(fieldId: number, value: string): RvfMetadataEntryWire {
  return { fieldId, valueType: 'string', value: value ?? '' };
}

function i64Entry(fieldId: number, value: number): RvfMetadataEntryWire {
  // Numerics are sent as decimal strings; the napi binding parses on the
  // Rust side via `e.value.parse::<i64>()`.
  return { fieldId, valueType: 'i64', value: String(Math.trunc(value)) };
}
