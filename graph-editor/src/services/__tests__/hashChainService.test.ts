/**
 * hashChainService — Tests for hash history chain tracing.
 *
 * Tests that traceHashChain correctly identifies whether a parameter's
 * full history is reachable from the current core_hash via mappings,
 * and correctly reports chain breaks with dates.
 *
 * Mock decisions:
 *   - hashMappingsService: real getClosureSet (pure algorithm, no I/O)
 *   - computeShortCoreHash: real (deterministic hash computation)
 *   - No IDB, no FileRegistry — traceHashChain is a pure function
 *     that takes pre-computed inputs
 */

import { describe, it, expect } from 'vitest';
import { traceHashChain, type HashChainResult } from '../hashChainService';
import { computeShortCoreHash } from '../coreHashService';
import { serialiseSignature } from '../signatureMatchingService';
import type { HashMapping } from '../hashMappingsService';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: generate deterministic but distinct signatures and hashes
// ─────────────────────────────────────────────────────────────────────────────

async function makeSig(seed: string): Promise<string> {
  return serialiseSignature({ identityHash: seed.padEnd(64, '0'), contextDefHashes: {} });
}

async function makeHash(seed: string): Promise<string> {
  const sig = await makeSig(seed);
  return computeShortCoreHash(sig);
}

function makeValue(signature: string, windowFrom?: string, windowTo?: string): any {
  return {
    mean: 0.5,
    n: 100,
    k: 50,
    query_signature: signature,
    window_from: windowFrom,
    window_to: windowTo,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('hashChainService — traceHashChain', () => {

  it('should report chain intact when all values have the current hash', async () => {
    const sig = await makeSig('aaa');
    const currentHash = await makeHash('aaa');

    const result = await traceHashChain(currentHash, [
      makeValue(sig, '2026-01-01', '2026-01-31'),
      makeValue(sig, '2026-02-01', '2026-02-28'),
    ], []);

    expect(result.chainIntact).toBe(true);
    expect(result.epochs).toHaveLength(1);
    expect(result.epochs[0].reachable).toBe(true);
    expect(result.epochs[0].coreHash).toBe(currentHash);
    expect(result.earliestBreakDate).toBeNull();
    expect(result.breakAgeDays).toBeNull();
  });

  it('should report chain intact when old hash is bridged by mapping', async () => {
    const sigOld = await makeSig('old');
    const sigNew = await makeSig('new');
    const hashOld = await makeHash('old');
    const hashNew = await makeHash('new');

    const mappings: HashMapping[] = [
      { core_hash: hashOld, equivalent_to: hashNew, operation: 'equivalent', weight: 1 },
    ];

    const result = await traceHashChain(hashNew, [
      makeValue(sigOld, '2025-06-01', '2025-12-31'),
      makeValue(sigNew, '2026-01-01', '2026-03-31'),
    ], mappings);

    expect(result.chainIntact).toBe(true);
    expect(result.epochs).toHaveLength(2);
    expect(result.epochs.every(e => e.reachable)).toBe(true);
    expect(result.earliestBreakDate).toBeNull();
  });

  it('should report chain broken when old hash has no mapping to current', async () => {
    const sigOld = await makeSig('old');
    const sigNew = await makeSig('new');
    const hashNew = await makeHash('new');

    const result = await traceHashChain(hashNew, [
      makeValue(sigOld, '2025-06-01', '2025-12-31'),
      makeValue(sigNew, '2026-01-01', '2026-03-31'),
    ], []);  // No mappings

    expect(result.chainIntact).toBe(false);
    expect(result.epochs).toHaveLength(2);

    const unreachable = result.epochs.find(e => !e.reachable);
    expect(unreachable).toBeDefined();
    expect(unreachable!.earliestDate).toBe('2025-06-01');

    expect(result.earliestBreakDate).toBe('2025-06-01');
    expect(result.breakAgeDays).toBeGreaterThan(0);
  });

  it('should handle multi-hop mapping chains (A→B→C, current=C)', async () => {
    const sigA = await makeSig('aaa');
    const sigB = await makeSig('bbb');
    const sigC = await makeSig('ccc');
    const hashA = await makeHash('aaa');
    const hashB = await makeHash('bbb');
    const hashC = await makeHash('ccc');

    const mappings: HashMapping[] = [
      { core_hash: hashA, equivalent_to: hashB, operation: 'equivalent', weight: 1 },
      { core_hash: hashB, equivalent_to: hashC, operation: 'equivalent', weight: 1 },
    ];

    const result = await traceHashChain(hashC, [
      makeValue(sigA, '2025-01-01', '2025-06-30'),
      makeValue(sigB, '2025-07-01', '2025-12-31'),
      makeValue(sigC, '2026-01-01', '2026-03-31'),
    ], mappings);

    expect(result.chainIntact).toBe(true);
    expect(result.epochs).toHaveLength(3);
    expect(result.epochs.every(e => e.reachable)).toBe(true);
  });

  it('should detect gap in the middle of a chain (A not mapped, B→C mapped)', async () => {
    const sigA = await makeSig('aaa');
    const sigB = await makeSig('bbb');
    const sigC = await makeSig('ccc');
    const hashB = await makeHash('bbb');
    const hashC = await makeHash('ccc');

    // Only B→C mapped, A is orphaned
    const mappings: HashMapping[] = [
      { core_hash: hashB, equivalent_to: hashC, operation: 'equivalent', weight: 1 },
    ];

    const result = await traceHashChain(hashC, [
      makeValue(sigA, '2025-01-01', '2025-06-30'),
      makeValue(sigB, '2025-07-01', '2025-12-31'),
      makeValue(sigC, '2026-01-01', '2026-03-31'),
    ], mappings);

    expect(result.chainIntact).toBe(false);
    expect(result.epochs).toHaveLength(3);

    // A should be unreachable
    const epochA = result.epochs.find(e => e.earliestDate === '2025-01-01');
    expect(epochA).toBeDefined();
    expect(epochA!.reachable).toBe(false);

    // B and C should be reachable
    const epochB = result.epochs.find(e => e.earliestDate === '2025-07-01');
    expect(epochB!.reachable).toBe(true);

    expect(result.earliestBreakDate).toBe('2025-01-01');
  });

  it('should sort epochs by earliest date (oldest first)', async () => {
    const sigA = await makeSig('aaa');
    const sigB = await makeSig('bbb');
    const hashB = await makeHash('bbb');

    const result = await traceHashChain(hashB, [
      makeValue(sigB, '2026-03-01', '2026-03-31'),  // Newer, inserted first
      makeValue(sigA, '2025-01-01', '2025-12-31'),  // Older, inserted second
    ], []);

    expect(result.epochs[0].earliestDate).toBe('2025-01-01');
    expect(result.epochs[1].earliestDate).toBe('2026-03-01');
  });

  it('should merge date ranges for same hash across multiple values', async () => {
    const sig = await makeSig('aaa');
    const currentHash = await makeHash('aaa');

    const result = await traceHashChain(currentHash, [
      makeValue(sig, '2026-01-01', '2026-01-31'),
      makeValue(sig, '2026-02-01', '2026-02-28'),
      makeValue(sig, '2025-12-01', '2025-12-31'),
    ], []);

    expect(result.epochs).toHaveLength(1);
    expect(result.epochs[0].earliestDate).toBe('2025-12-01');
    expect(result.epochs[0].latestDate).toBe('2026-02-28');
  });

  it('should handle values without dates gracefully', async () => {
    const sig = await makeSig('aaa');
    const currentHash = await makeHash('aaa');

    const result = await traceHashChain(currentHash, [
      { mean: 0.5, query_signature: sig },  // No dates
    ], []);

    expect(result.chainIntact).toBe(true);
    expect(result.epochs).toHaveLength(1);
    expect(result.epochs[0].earliestDate).toBeNull();
    expect(result.epochs[0].latestDate).toBeNull();
  });

  it('should handle values without query_signature (skip them)', async () => {
    const sig = await makeSig('aaa');
    const currentHash = await makeHash('aaa');

    const result = await traceHashChain(currentHash, [
      { mean: 0.5 },  // No signature
      makeValue(sig, '2026-01-01', '2026-01-31'),
    ], []);

    expect(result.epochs).toHaveLength(1);
    expect(result.chainIntact).toBe(true);
  });

  it('should handle empty values array', async () => {
    const currentHash = await makeHash('aaa');

    const result = await traceHashChain(currentHash, [], []);

    expect(result.chainIntact).toBe(true);
    expect(result.epochs).toHaveLength(0);
    expect(result.earliestBreakDate).toBeNull();
  });

  it('should compute breakAgeDays correctly', async () => {
    const sigOld = await makeSig('old');
    const sigNew = await makeSig('new');
    const hashNew = await makeHash('new');

    // Break date 30 days ago
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const breakDate = thirtyDaysAgo.toISOString().slice(0, 10);

    const result = await traceHashChain(hashNew, [
      makeValue(sigOld, breakDate, breakDate),
      makeValue(sigNew, '2026-03-01', '2026-03-31'),
    ], []);

    expect(result.chainIntact).toBe(false);
    expect(result.breakAgeDays).toBeGreaterThanOrEqual(29);
    expect(result.breakAgeDays).toBeLessThanOrEqual(31);
  });

  it('should use cohort dates when window dates are absent', async () => {
    const sig = await makeSig('aaa');
    const currentHash = await makeHash('aaa');

    const result = await traceHashChain(currentHash, [
      {
        mean: 0.5,
        query_signature: sig,
        cohort_from: '2025-06-01',
        cohort_to: '2025-12-31',
      },
    ], []);

    expect(result.epochs[0].earliestDate).toBe('2025-06-01');
    expect(result.epochs[0].latestDate).toBe('2025-12-31');
  });

  it('should report earliestReachableDate correctly when chain is partially broken', async () => {
    const sigA = await makeSig('aaa');
    const sigB = await makeSig('bbb');
    const sigC = await makeSig('ccc');
    const hashB = await makeHash('bbb');
    const hashC = await makeHash('ccc');

    // B→C mapped, A orphaned
    const mappings: HashMapping[] = [
      { core_hash: hashB, equivalent_to: hashC, operation: 'equivalent', weight: 1 },
    ];

    const result = await traceHashChain(hashC, [
      makeValue(sigA, '2025-01-01', '2025-06-30'),
      makeValue(sigB, '2025-07-01', '2025-12-31'),
      makeValue(sigC, '2026-01-01', '2026-03-31'),
    ], mappings);

    expect(result.earliestReachableDate).toBe('2025-07-01');
    expect(result.earliestBreakDate).toBe('2025-01-01');
  });
});
