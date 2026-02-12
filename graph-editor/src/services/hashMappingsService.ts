/**
 * hashMappingsService — owns hash-mappings.json (equivalence links between core hashes).
 *
 * Responsibilities:
 * - Read/parse the repo-root hash-mappings.json from FileRegistry / IndexedDB.
 * - Derive deterministic, cycle-safe transitive closure sets for a seed core_hash.
 * - Provide CRUD helpers for Snapshot Manager (Stage 3).
 *
 * This is the single place in FE where closure semantics live.
 */

import { fileRegistry } from '../contexts/TabContext';
import { db } from '../db/appDatabase';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single pairwise mapping row stored in hash-mappings.json. */
export interface HashMapping {
  core_hash: string;
  equivalent_to: string;
  operation: string;
  weight: number;
  reason?: string;
  created_by?: string;
}

/** Top-level shape of hash-mappings.json. */
export interface HashMappingsFile {
  version: number;
  mappings: HashMapping[];
}

/** A single entry in a closure set (what the FE sends to the BE). */
export interface ClosureEntry {
  core_hash: string;
  operation: string;
  weight: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILE_ID = 'hash-mappings';

// ---------------------------------------------------------------------------
// File access
// ---------------------------------------------------------------------------

/**
 * Read and parse hash-mappings.json from FileRegistry (memory) or IndexedDB (fallback).
 * Returns empty structure if the file is missing or unparseable.
 */
export function getMappingsFile(): HashMappingsFile {
  // Try in-memory FileRegistry first (fast path).
  const regFile = fileRegistry.getFile(FILE_ID);
  if (regFile?.data && typeof regFile.data === 'object') {
    const d = regFile.data as any;
    if (Array.isArray(d.mappings)) {
      return d as HashMappingsFile;
    }
  }
  return { version: 1, mappings: [] };
}

/**
 * Async variant that falls back to IndexedDB if FileRegistry has nothing.
 */
export async function getMappingsFileAsync(): Promise<HashMappingsFile> {
  // Try in-memory first.
  const fast = getMappingsFile();
  if (fast.mappings.length > 0) return fast;

  // Fallback to IDB (may have workspace-prefixed or unprefixed key).
  try {
    const idbFile = await db.files.get(FILE_ID);
    if (idbFile?.data && typeof idbFile.data === 'object') {
      const d = idbFile.data as any;
      if (Array.isArray(d.mappings)) {
        return d as HashMappingsFile;
      }
    }
  } catch {
    // IDB unavailable — return empty.
  }
  return { version: 1, mappings: [] };
}

/**
 * Return the raw mapping rows from the file.
 */
export function getMappings(): HashMapping[] {
  return getMappingsFile().mappings;
}

// ---------------------------------------------------------------------------
// Closure derivation (core algorithm)
// ---------------------------------------------------------------------------

/**
 * Compute the equivalence closure set for a seed `core_hash`.
 *
 * Semantics:
 * - Only rows with `operation === 'equivalent'` participate.
 * - Edges are undirected (A→B and B→A are the same link).
 * - Self-links (core_hash === equivalent_to) are ignored.
 * - The returned list does NOT include the seed itself.
 * - The list is sorted alphabetically by core_hash for determinism.
 * - Cycles are handled (BFS visited set prevents infinite loops).
 *
 * @returns ClosureEntry[] — the equivalent hashes reachable from `seed`, excluding `seed`.
 */
export function getClosureSet(seed: string, mappings?: HashMapping[]): ClosureEntry[] {
  const rows = mappings ?? getMappings();

  // Build adjacency list from equivalence edges (undirected).
  const adj = new Map<string, Array<{ target: string; operation: string; weight: number }>>();

  for (const row of rows) {
    if (row.operation !== 'equivalent') continue;
    if (row.core_hash === row.equivalent_to) continue; // self-link

    const a = row.core_hash;
    const b = row.equivalent_to;
    const entry = { operation: row.operation, weight: row.weight };

    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push({ target: b, ...entry });

    if (!adj.has(b)) adj.set(b, []);
    adj.get(b)!.push({ target: a, ...entry });
  }

  // BFS from seed.
  const visited = new Set<string>();
  const queue: string[] = [seed];
  visited.add(seed);

  const result: ClosureEntry[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbours = adj.get(current);
    if (!neighbours) continue;

    for (const n of neighbours) {
      if (visited.has(n.target)) continue;
      visited.add(n.target);
      queue.push(n.target);
      result.push({
        core_hash: n.target,
        operation: n.operation,
        weight: n.weight,
      });
    }
  }

  // Sort deterministically to avoid request churn.
  result.sort((a, b) => a.core_hash.localeCompare(b.core_hash));

  return result;
}

// ---------------------------------------------------------------------------
// Mutation helpers (used by Snapshot Manager in Stage 3)
// ---------------------------------------------------------------------------

/**
 * Add a mapping row to hash-mappings.json and mark the file dirty.
 */
export async function addMapping(mapping: HashMapping): Promise<void> {
  const file = await getMappingsFileAsync();
  file.mappings.push(mapping);
  await _writeFile(file);
}

/**
 * Remove a mapping row (by both endpoints) from hash-mappings.json and mark dirty.
 * Matches undirected: removes rows where (core_hash, equivalent_to) matches in either order.
 */
export async function removeMapping(coreHash: string, equivalentTo: string): Promise<void> {
  const file = await getMappingsFileAsync();
  file.mappings = file.mappings.filter(
    (m) =>
      !(
        (m.core_hash === coreHash && m.equivalent_to === equivalentTo) ||
        (m.core_hash === equivalentTo && m.equivalent_to === coreHash)
      )
  );
  await _writeFile(file);
}

// ---------------------------------------------------------------------------
// Internal: write-back
// ---------------------------------------------------------------------------

async function _writeFile(file: HashMappingsFile): Promise<void> {
  const regFile = fileRegistry.getFile(FILE_ID);
  if (regFile) {
    regFile.data = file;
    regFile.isDirty = true;
    regFile.lastModified = Date.now();
    await db.files.put({ ...regFile });
  } else {
    // File not in registry — write directly to IDB.
    await db.files.put({
      fileId: FILE_ID,
      type: 'hash-mappings',
      path: 'hash-mappings.json',
      data: file,
      lastModified: Date.now(),
      viewTabs: [],
      isDirty: true,
      originalData: undefined,
    });
  }
}
