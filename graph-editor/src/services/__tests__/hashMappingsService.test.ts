import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';

import type { HashMapping } from '../hashMappingsService';
import { getClosureSet, addMapping, removeMapping } from '../hashMappingsService';
import { db } from '../../db/appDatabase';

// ---------------------------------------------------------------------------
// Mock fileRegistry so the pure algorithm tests use only the `mappings`
// parameter (no file store dependency). The IDB integration test at the bottom
// exercises the real IDB path.
// ---------------------------------------------------------------------------
vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: {
    getFile: vi.fn().mockReturnValue(null),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eq(a: string, b: string, opts?: Partial<HashMapping>): HashMapping {
  return {
    core_hash: a,
    equivalent_to: b,
    operation: 'equivalent',
    weight: 1.0,
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// Pure closure algorithm tests (use `mappings` parameter — no file I/O)
// ---------------------------------------------------------------------------

describe('hashMappingsService — getClosureSet (pure algorithm)', () => {
  it('transitive closure: A↔B, B↔C → closure(A) = [B, C]', () => {
    const mappings = [eq('A', 'B'), eq('B', 'C')];
    const result = getClosureSet('A', mappings);
    expect(result.map((e) => e.core_hash)).toEqual(['B', 'C']);
  });

  it('multi-hop: A↔B, B↔C, C↔D → closure(A) = [B, C, D]', () => {
    const mappings = [eq('A', 'B'), eq('B', 'C'), eq('C', 'D')];
    const result = getClosureSet('A', mappings);
    expect(result.map((e) => e.core_hash)).toEqual(['B', 'C', 'D']);
  });

  it('cycle: A↔B, B↔C, C↔A → closure(A) = [B, C] (terminates, no duplicates)', () => {
    const mappings = [eq('A', 'B'), eq('B', 'C'), eq('C', 'A')];
    const result = getClosureSet('A', mappings);
    expect(result.map((e) => e.core_hash)).toEqual(['B', 'C']);
  });

  it('deterministic ordering: result is sorted alphabetically by core_hash', () => {
    // Adjacency order would naturally yield Z, M, A — but output must be sorted.
    const mappings = [eq('seed', 'Z'), eq('Z', 'M'), eq('M', 'A')];
    const result = getClosureSet('seed', mappings);
    expect(result.map((e) => e.core_hash)).toEqual(['A', 'M', 'Z']);
  });

  it('operation filtering: only "equivalent" rows participate in closure', () => {
    const mappings = [
      eq('A', 'B', { operation: 'equivalent' }),
      eq('A', 'C', { operation: 'weighted_average', weight: 0.5 }),
    ];
    const result = getClosureSet('A', mappings);
    expect(result.map((e) => e.core_hash)).toEqual(['B']);
  });

  it('self-link ignored: A↔A → closure(A) = []', () => {
    const mappings = [eq('A', 'A')];
    const result = getClosureSet('A', mappings);
    expect(result).toEqual([]);
  });

  it('empty mappings → closure(anything) = []', () => {
    const result = getClosureSet('X', []);
    expect(result).toEqual([]);
  });

  it('seed not in any mapping → closure(X) = []', () => {
    const mappings = [eq('A', 'B')];
    const result = getClosureSet('X', mappings);
    expect(result).toEqual([]);
  });

  it('does not include seed in result', () => {
    const mappings = [eq('A', 'B')];
    const result = getClosureSet('A', mappings);
    expect(result.map((e) => e.core_hash)).not.toContain('A');
  });

  it('preserves weight from mapping rows', () => {
    const mappings = [eq('A', 'B', { weight: 0.75 })];
    const result = getClosureSet('A', mappings);
    expect(result).toEqual([{ core_hash: 'B', operation: 'equivalent', weight: 0.75 }]);
  });

  it('handles diamond graph: A↔B, A↔C, B↔D, C↔D → closure(A) = [B, C, D]', () => {
    const mappings = [eq('A', 'B'), eq('A', 'C'), eq('B', 'D'), eq('C', 'D')];
    const result = getClosureSet('A', mappings);
    expect(result.map((e) => e.core_hash)).toEqual(['B', 'C', 'D']);
  });
});

// ---------------------------------------------------------------------------
// Mutation helpers (addMapping / removeMapping) — uses real IDB
// ---------------------------------------------------------------------------

describe('hashMappingsService — addMapping / removeMapping', () => {
  beforeEach(async () => {
    await db.files.clear();
    vi.clearAllMocks();
  });

  it('addMapping creates a file entry and marks dirty', async () => {
    await addMapping(eq('X', 'Y'));

    const file = await db.files.get('hash-mappings');
    expect(file).toBeDefined();
    expect(file!.isDirty).toBe(true);
    expect((file!.data as any).mappings).toHaveLength(1);
    expect((file!.data as any).mappings[0].core_hash).toBe('X');
    expect((file!.data as any).mappings[0].equivalent_to).toBe('Y');
  });

  it('removeMapping deletes the matching row (undirected match)', async () => {
    await addMapping(eq('X', 'Y'));
    await addMapping(eq('M', 'N'));

    // Remove X↔Y by specifying in reverse order
    await removeMapping('Y', 'X');

    const file = await db.files.get('hash-mappings');
    const mappings = (file!.data as any).mappings;
    expect(mappings).toHaveLength(1);
    expect(mappings[0].core_hash).toBe('M');
  });

  it('unlink semantics: add then remove → closure returns empty', async () => {
    await addMapping(eq('A', 'B'));
    await removeMapping('A', 'B');

    const file = await db.files.get('hash-mappings');
    const mappings = (file!.data as any).mappings as HashMapping[];
    const result = getClosureSet('A', mappings);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration: seed file in IDB → read via service
// ---------------------------------------------------------------------------

describe('hashMappingsService — IDB integration', () => {
  beforeEach(async () => {
    await db.files.clear();
    vi.clearAllMocks();
  });

  it('seed empty file → getClosureSet returns []', async () => {
    // Seed the file as the init code would.
    await db.files.put({
      fileId: 'hash-mappings',
      type: 'hash-mappings',
      path: 'hash-mappings.json',
      data: { version: 1, mappings: [] },
      lastModified: Date.now(),
      viewTabs: [],
      isDirty: false,
      originalData: { version: 1, mappings: [] },
    });

    // Since fileRegistry mock returns null, service should fall back to IDB via getMappingsFileAsync.
    // But getClosureSet is synchronous and uses getMappingsFile (registry only).
    // So we test the async path indirectly through addMapping/removeMapping which read via async.
    const file = await db.files.get('hash-mappings');
    const mappings = (file!.data as any).mappings as HashMapping[];
    const result = getClosureSet('anything', mappings);
    expect(result).toEqual([]);
  });

  it('write mappings to IDB → getClosureSet computes correct closure', async () => {
    const fileData = {
      version: 1,
      mappings: [
        eq('hash-1', 'hash-2'),
        eq('hash-2', 'hash-3'),
      ],
    };

    await db.files.put({
      fileId: 'hash-mappings',
      type: 'hash-mappings',
      path: 'hash-mappings.json',
      data: fileData,
      lastModified: Date.now(),
      viewTabs: [],
      isDirty: false,
      originalData: structuredClone(fileData),
    });

    const file = await db.files.get('hash-mappings');
    const mappings = (file!.data as any).mappings as HashMapping[];
    const result = getClosureSet('hash-1', mappings);
    expect(result.map((e) => e.core_hash)).toEqual(['hash-2', 'hash-3']);
  });
});
