/**
 * RuvLLM Persistence Store (W2-I2)
 *
 * MCP tools run one-shot via `cli mcp exec`, so in-process `Map` registries
 * are wiped between every invocation. Users creating a router in one call
 * and adding/routing in the next need cross-process state.
 *
 * This module persists router/sona/microlora state to disk under
 *   `<cwd>/.claude-flow/ruvllm/{hnsw,sona,microlora}-store.json`
 *
 * Strategy: config snapshot + operation journal. On registry miss we
 * re-create the WASM object from the saved config, then replay the
 * journaled ops (addPattern / adapt / recordPattern). This works because
 * the WASM API provides `toJson()` but no `fromJson()` constructors — the
 * journal-replay is the only deterministic-enough reconstruction path.
 *
 * Writes are atomic: `writeFileSync(tmp)` + `renameSync(tmp -> final)`
 * (same pattern as autopilot-state.ts).
 *
 * Scale note: replay is O(N) on every cold-process operation. Acceptable
 * for the current acceptance-test scale (<100 ops/instance). Compaction
 * (snapshot via toJson() + truncate journal) is a future improvement.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from './types.js';

// ── Storage layout ──────────────────────────────────────────────────

const STORAGE_SUBDIR = join('.claude-flow', 'ruvllm');
const HNSW_FILE = 'hnsw-store.json';
const SONA_FILE = 'sona-store.json';
const MICROLORA_FILE = 'microlora-store.json';
const STORE_VERSION = '1';

function getStoreDir(): string {
  // ADR-0100: anchor on project root, not process.cwd() (Claude Code CWD drift).
  return join(findProjectRoot(), STORAGE_SUBDIR);
}

function ensureStoreDir(): void {
  const dir = getStoreDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(path: string, data: unknown): void {
  ensureStoreDir();
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, path);
}

function readJsonOrDefault<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    // Corrupt store → treat as empty, do not throw (ADR-0082: still fail loud
    // on operation-level errors; a missing/corrupt cold-start file is not a
    // data-integrity violation, it just means replay is impossible).
    return fallback;
  }
}

// ── HNSW ────────────────────────────────────────────────────────────

export interface HnswPersistedConfig {
  dimensions: number;
  maxPatterns: number;
  efSearch?: number;
}

export interface HnswJournalAdd {
  op: 'add';
  name: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export type HnswJournalEntry = HnswJournalAdd;

export interface HnswPersistedRouter {
  id: string;
  createdAt: string;
  config: HnswPersistedConfig;
  journal: HnswJournalEntry[];
}

interface HnswStore {
  version: string;
  routers: Record<string, HnswPersistedRouter>;
}

function hnswPath(): string {
  return join(getStoreDir(), HNSW_FILE);
}

function loadHnswStore(): HnswStore {
  return readJsonOrDefault<HnswStore>(hnswPath(), {
    version: STORE_VERSION,
    routers: {},
  });
}

function saveHnswStore(store: HnswStore): void {
  atomicWriteJson(hnswPath(), store);
}

export function persistHnswCreate(id: string, config: HnswPersistedConfig): void {
  const store = loadHnswStore();
  store.routers[id] = {
    id,
    createdAt: new Date().toISOString(),
    config,
    journal: [],
  };
  saveHnswStore(store);
}

export function persistHnswAdd(
  id: string,
  name: string,
  embedding: number[],
  metadata?: Record<string, unknown>,
): boolean {
  const store = loadHnswStore();
  const rec = store.routers[id];
  if (!rec) return false;
  rec.journal.push({ op: 'add', name, embedding, metadata });
  saveHnswStore(store);
  return true;
}

export function getHnswRecord(id: string): HnswPersistedRouter | undefined {
  return loadHnswStore().routers[id];
}

// ── SONA ────────────────────────────────────────────────────────────

export interface SonaPersistedConfig {
  hiddenDim?: number;
  learningRate?: number;
  emaDecay?: number;
  ewcLambda?: number;
  microLoraRank?: number;
  patternCapacity?: number;
}

export type SonaJournalEntry =
  | { op: 'adapt'; quality: number }
  | { op: 'recordPattern'; embedding: number[]; success: boolean };

export interface SonaPersistedInstance {
  id: string;
  createdAt: string;
  config: SonaPersistedConfig;
  journal: SonaJournalEntry[];
}

interface SonaStore {
  version: string;
  instances: Record<string, SonaPersistedInstance>;
}

function sonaPath(): string {
  return join(getStoreDir(), SONA_FILE);
}

function loadSonaStore(): SonaStore {
  return readJsonOrDefault<SonaStore>(sonaPath(), {
    version: STORE_VERSION,
    instances: {},
  });
}

function saveSonaStore(store: SonaStore): void {
  atomicWriteJson(sonaPath(), store);
}

export function persistSonaCreate(id: string, config: SonaPersistedConfig): void {
  const store = loadSonaStore();
  store.instances[id] = {
    id,
    createdAt: new Date().toISOString(),
    config,
    journal: [],
  };
  saveSonaStore(store);
}

export function persistSonaAdapt(id: string, quality: number): boolean {
  const store = loadSonaStore();
  const rec = store.instances[id];
  if (!rec) return false;
  rec.journal.push({ op: 'adapt', quality });
  saveSonaStore(store);
  return true;
}

export function getSonaRecord(id: string): SonaPersistedInstance | undefined {
  return loadSonaStore().instances[id];
}

// ── MicroLoRA ───────────────────────────────────────────────────────

export interface MicroLoraPersistedConfig {
  inputDim: number;
  outputDim: number;
  rank?: number;
  alpha?: number;
}

export type MicroLoraJournalEntry = {
  op: 'adapt';
  quality: number;
  input: number[];
  learningRate?: number;
  success?: boolean;
  consolidate?: boolean;
};

export interface MicroLoraPersistedInstance {
  id: string;
  createdAt: string;
  config: MicroLoraPersistedConfig;
  journal: MicroLoraJournalEntry[];
}

interface MicroLoraStore {
  version: string;
  instances: Record<string, MicroLoraPersistedInstance>;
}

function microloraPath(): string {
  return join(getStoreDir(), MICROLORA_FILE);
}

function loadMicroLoraStore(): MicroLoraStore {
  return readJsonOrDefault<MicroLoraStore>(microloraPath(), {
    version: STORE_VERSION,
    instances: {},
  });
}

function saveMicroLoraStore(store: MicroLoraStore): void {
  atomicWriteJson(microloraPath(), store);
}

export function persistMicroLoraCreate(id: string, config: MicroLoraPersistedConfig): void {
  const store = loadMicroLoraStore();
  store.instances[id] = {
    id,
    createdAt: new Date().toISOString(),
    config,
    journal: [],
  };
  saveMicroLoraStore(store);
}

export function persistMicroLoraAdapt(
  id: string,
  quality: number,
  input: number[],
  learningRate?: number,
  success?: boolean,
  consolidate?: boolean,
): boolean {
  const store = loadMicroLoraStore();
  const rec = store.instances[id];
  if (!rec) return false;
  rec.journal.push({ op: 'adapt', quality, input, learningRate, success, consolidate });
  saveMicroLoraStore(store);
  return true;
}

export function getMicroLoraRecord(id: string): MicroLoraPersistedInstance | undefined {
  return loadMicroLoraStore().instances[id];
}

// ── Test/debug helpers (not part of MCP surface) ───────────────────

export function _storePaths() {
  return { hnsw: hnswPath(), sona: sonaPath(), microlora: microloraPath(), dir: getStoreDir() };
}
