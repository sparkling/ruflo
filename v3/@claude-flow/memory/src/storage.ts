/**
 * IStorage — Unified storage abstraction for the V3 memory system (ADR-0076 Phase 3)
 *
 * Both IStorage and IStorageContract are type aliases for IMemoryBackend.
 * ADR-0086 Debt 1 collapsed the duplicate interface declaration; downstream
 * consumers that import either name continue to work unchanged.
 *
 * @module @claude-flow/memory/storage
 */

import type { IMemoryBackend } from './types.js';

/**
 * IStorage — drop-in alias for IMemoryBackend.
 *
 * Using a type alias (not a new interface) lets every existing backend
 * satisfy IStorage without changes.  When consumers are migrated, the
 * alias can be replaced with IStorageContract directly.
 */
export type IStorage = IMemoryBackend;

/**
 * IStorageContract — type alias for IMemoryBackend (ADR-0086 Debt 1).
 *
 * The two interfaces were identical (16 methods, matching signatures).
 * Collapsed to a type alias so downstream consumers keep working while
 * the codebase converges on a single name.
 */
export type IStorageContract = IMemoryBackend;
