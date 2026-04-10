/**
 * Blind integration tests for hashChainService.traceHashChain.
 *
 * Written from the specification only — without reading the implementation.
 * Tests the public interface behaviour: epoch construction, reachability via
 * mapping closure, date merging, chain integrity, and break detection.
 */
import { describe, it, expect } from 'vitest';
import { traceHashChain } from '../hashChainService';
import { computeShortCoreHash } from '../coreHashService';
import { serialiseSignature } from '../signatureMatchingService';
import type { HashMapping } from '../hashMappingsService';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Create a deterministic canonical signature string from a seed. */
async function makeSig(seed: string): Promise<string> {
  return serialiseSignature({ identityHash: seed.padEnd(64, '0'), contextDefHashes: {} });
}

/** Get the short core_hash for a given seed. */
async function makeHash(seed: string): Promise<string> {
  return computeShortCoreHash(await makeSig(seed));
}

/** Build a parameter value with window dates. */
function windowValue(
  querySig: string,
  windowFrom: string,
  windowTo: string,
): Record<string, unknown> {
  return {
    query_signature: querySig,
    window_from: windowFrom,
    window_to: windowTo,
  };
}

/** Build a parameter value with cohort dates. */
function cohortValue(
  querySig: string,
  cohortFrom: string,
  cohortTo: string,
): Record<string, unknown> {
  return {
    query_signature: querySig,
    cohort_from: cohortFrom,
    cohort_to: cohortTo,
  };
}

/** Build a parameter value with data_source.retrieved_at only. */
function retrievedAtValue(
  querySig: string,
  retrievedAt: string,
): Record<string, unknown> {
  return {
    query_signature: querySig,
    data_source: { retrieved_at: retrievedAt },
  };
}

/** Build a parameter value with evidence date fields only. */
function evidenceValue(
  querySig: string,
  evidenceWindowFrom: string,
  evidenceWindowTo: string,
): Record<string, unknown> {
  return {
    query_signature: querySig,
    evidence: { window_from: evidenceWindowFrom, window_to: evidenceWindowTo },
  };
}

/** Create an 'equivalent' mapping between two core hashes. */
function mapping(coreHash: string, equivalentTo: string): HashMapping {
  return {
    core_hash: coreHash,
    equivalent_to: equivalentTo,
    operation: 'equivalent',
    weight: 1,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hashChainService.traceHashChain — blind specification tests', () => {
  // Pre-compute hashes for reuse across tests. These are deterministic.
  let sigA: string, sigB: string, sigC: string;
  let hashA: string, hashB: string, hashC: string;

  // Use a different setup: compute in a beforeAll since they're async
  // and deterministic — safe to share across tests.
  let ready: Promise<void>;

  const init = (async () => {
    sigA = await makeSig('A');
    sigB = await makeSig('B');
    sigC = await makeSig('C');
    hashA = await makeHash('A');
    hashB = await makeHash('B');
    hashC = await makeHash('C');
  })();

  // Ensure initialisation completes before each test
  async function ensureReady(): Promise<void> {
    await init;
  }

  // -------------------------------------------------------------------------
  // Scenario 1: Single epoch, current hash matches all values
  // -------------------------------------------------------------------------
  it('should report chainIntact=true with one epoch when all values share the current hash', async () => {
    await ensureReady();

    const values = [
      windowValue(sigA, '2025-01-01', '2025-01-31'),
      windowValue(sigA, '2025-02-01', '2025-02-28'),
    ];

    const result = await traceHashChain(hashA, values);

    expect(result.currentHash).toBe(hashA);
    expect(result.chainIntact).toBe(true);
    expect(result.epochs.length).toBe(1);
    expect(result.epochs[0].coreHash).toBe(hashA);
    expect(result.epochs[0].reachable).toBe(true);
    expect(result.earliestBreakDate).toBeNull();
    expect(result.breakAgeDays).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Two epochs, mapping bridges them
  // -------------------------------------------------------------------------
  it('should report chainIntact=true when a mapping bridges old epoch to current hash', async () => {
    await ensureReady();

    const values = [
      windowValue(sigA, '2024-06-01', '2024-06-30'),
      windowValue(sigB, '2025-03-01', '2025-03-31'),
    ];

    const mappings = [mapping(hashA, hashB)];

    const result = await traceHashChain(hashB, values, mappings);

    expect(result.currentHash).toBe(hashB);
    expect(result.chainIntact).toBe(true);
    expect(result.epochs.length).toBe(2);
    // Both should be reachable
    expect(result.epochs.every(e => e.reachable)).toBe(true);
    expect(result.earliestBreakDate).toBeNull();
    expect(result.breakAgeDays).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Two epochs, no mapping — chain broken
  // -------------------------------------------------------------------------
  it('should report chainIntact=false with correct breakDate when no mapping bridges old epoch', async () => {
    await ensureReady();

    const values = [
      windowValue(sigA, '2024-06-01', '2024-06-30'),
      windowValue(sigB, '2025-03-01', '2025-03-31'),
    ];

    // No mappings — hashA is orphaned
    const result = await traceHashChain(hashB, values);

    expect(result.currentHash).toBe(hashB);
    expect(result.chainIntact).toBe(false);
    expect(result.epochs.length).toBe(2);

    // Find the old epoch (hashA) — should be unreachable
    const epochA = result.epochs.find(e => e.coreHash === hashA);
    const epochB = result.epochs.find(e => e.coreHash === hashB);
    expect(epochA).not.toBeUndefined();
    expect(epochB).not.toBeUndefined();
    expect(epochA!.reachable).toBe(false);
    expect(epochB!.reachable).toBe(true);

    // Break date should be the earliest date from the unreachable epoch
    expect(result.earliestBreakDate).toBe('2024-06-01');
    expect(result.breakAgeDays).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Three epochs, full chain A→B→C via two mappings
  // -------------------------------------------------------------------------
  it('should report chainIntact=true for a three-hop chain A→B→C with transitive closure', async () => {
    await ensureReady();

    const values = [
      windowValue(sigA, '2024-01-01', '2024-03-31'),
      windowValue(sigB, '2024-07-01', '2024-09-30'),
      windowValue(sigC, '2025-01-01', '2025-03-31'),
    ];

    const mappings = [
      mapping(hashA, hashB),
      mapping(hashB, hashC),
    ];

    const result = await traceHashChain(hashC, values, mappings);

    expect(result.currentHash).toBe(hashC);
    expect(result.chainIntact).toBe(true);
    expect(result.epochs.length).toBe(3);
    expect(result.epochs.every(e => e.reachable)).toBe(true);
    expect(result.earliestBreakDate).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Gap in middle — A orphaned, B→C mapped
  // -------------------------------------------------------------------------
  it('should report chainIntact=false when A is orphaned but B→C are linked', async () => {
    await ensureReady();

    const values = [
      windowValue(sigA, '2024-01-01', '2024-03-31'),
      windowValue(sigB, '2024-07-01', '2024-09-30'),
      windowValue(sigC, '2025-01-01', '2025-03-31'),
    ];

    // Only B→C mapped, A has no link
    const mappings = [mapping(hashB, hashC)];

    const result = await traceHashChain(hashC, values, mappings);

    expect(result.currentHash).toBe(hashC);
    expect(result.chainIntact).toBe(false);
    expect(result.epochs.length).toBe(3);

    const epochA = result.epochs.find(e => e.coreHash === hashA);
    const epochB = result.epochs.find(e => e.coreHash === hashB);
    const epochC = result.epochs.find(e => e.coreHash === hashC);

    expect(epochA!.reachable).toBe(false);
    expect(epochB!.reachable).toBe(true);
    expect(epochC!.reachable).toBe(true);

    // Break date should come from the orphaned epoch A
    expect(result.earliestBreakDate).toBe('2024-01-01');
  });

  // -------------------------------------------------------------------------
  // Scenario 6: Date merging — three values with same signature → one epoch
  // -------------------------------------------------------------------------
  it('should merge multiple values with the same signature into one epoch with combined date range', async () => {
    await ensureReady();

    const values = [
      windowValue(sigA, '2025-03-01', '2025-03-10'),
      windowValue(sigA, '2025-01-15', '2025-02-15'),
      windowValue(sigA, '2025-02-01', '2025-04-01'),
    ];

    const result = await traceHashChain(hashA, values);

    expect(result.epochs.length).toBe(1);
    expect(result.epochs[0].coreHash).toBe(hashA);
    // Earliest date across all three values: 2025-01-15
    expect(result.epochs[0].earliestDate).toBe('2025-01-15');
    // Latest date across all three values: 2025-04-01
    expect(result.epochs[0].latestDate).toBe('2025-04-01');
    expect(result.chainIntact).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario 7: Values without query_signature skipped
  // -------------------------------------------------------------------------
  it('should skip values that have no query_signature field', async () => {
    await ensureReady();

    const values = [
      windowValue(sigA, '2025-01-01', '2025-01-31'),
      { window_from: '2024-01-01', window_to: '2024-06-30' }, // no query_signature
      { query_signature: '', window_from: '2023-01-01', window_to: '2023-06-30' }, // empty signature
    ];

    const result = await traceHashChain(hashA, values);

    // Only the value with sigA should produce an epoch
    expect(result.epochs.length).toBe(1);
    expect(result.epochs[0].coreHash).toBe(hashA);
    expect(result.chainIntact).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario 8: Empty values → intact, no epochs
  // -------------------------------------------------------------------------
  it('should report chainIntact=true with no epochs when values array is empty', async () => {
    await ensureReady();

    const result = await traceHashChain(hashA, []);

    expect(result.currentHash).toBe(hashA);
    expect(result.chainIntact).toBe(true);
    expect(result.epochs.length).toBe(0);
    expect(result.earliestBreakDate).toBeNull();
    expect(result.breakAgeDays).toBeNull();
    expect(result.earliestReachableDate).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Scenario 9: cohort_from/to dates used when window dates absent
  // -------------------------------------------------------------------------
  it('should extract dates from cohort_from/cohort_to when window dates are absent', async () => {
    await ensureReady();

    const values = [
      cohortValue(sigA, '2024-10-01', '2024-12-31'),
    ];

    const result = await traceHashChain(hashA, values);

    expect(result.epochs.length).toBe(1);
    expect(result.epochs[0].earliestDate).toBe('2024-10-01');
    expect(result.epochs[0].latestDate).toBe('2024-12-31');
  });

  // -------------------------------------------------------------------------
  // Scenario 10: data_source.retrieved_at used as date source
  // -------------------------------------------------------------------------
  it('should extract dates from data_source.retrieved_at when no window/cohort dates exist', async () => {
    await ensureReady();

    const values = [
      retrievedAtValue(sigA, '2025-02-15'),
    ];

    const result = await traceHashChain(hashA, values);

    expect(result.epochs.length).toBe(1);
    // retrieved_at should contribute as both earliest and latest since it's the only date
    expect(result.epochs[0].earliestDate).toBe('2025-02-15');
    expect(result.epochs[0].latestDate).toBe('2025-02-15');
  });

  // -------------------------------------------------------------------------
  // Scenario 11: evidence.window_from/to used as date source
  // -------------------------------------------------------------------------
  it('should extract dates from evidence.window_from/evidence.window_to', async () => {
    await ensureReady();

    const values = [
      evidenceValue(sigA, '2024-08-01', '2024-11-30'),
    ];

    const result = await traceHashChain(hashA, values);

    expect(result.epochs.length).toBe(1);
    expect(result.epochs[0].earliestDate).toBe('2024-08-01');
    expect(result.epochs[0].latestDate).toBe('2024-11-30');
  });

  // -------------------------------------------------------------------------
  // Scenario 12: breakAgeDays is approximately correct
  // -------------------------------------------------------------------------
  it('should compute breakAgeDays approximately correctly relative to current date', async () => {
    await ensureReady();

    // Use a date 30 days ago as the break point
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const breakDate = thirtyDaysAgo.toISOString().slice(0, 10);

    const values = [
      windowValue(sigA, breakDate, breakDate),
      windowValue(sigB, '2025-03-25', '2025-03-30'),
    ];

    // No mappings — hashA is orphaned
    const result = await traceHashChain(hashB, values);

    expect(result.chainIntact).toBe(false);
    expect(result.breakAgeDays).not.toBeNull();
    // Allow ±1 day tolerance
    expect(result.breakAgeDays!).toBeGreaterThanOrEqual(29);
    expect(result.breakAgeDays!).toBeLessThanOrEqual(31);
  });

  // -------------------------------------------------------------------------
  // Scenario 13: earliestReachableDate correct when chain partially broken
  // -------------------------------------------------------------------------
  it('should set earliestReachableDate to the earliest date among reachable epochs only', async () => {
    await ensureReady();

    const values = [
      windowValue(sigA, '2023-01-01', '2023-06-30'), // orphaned — should NOT affect earliestReachableDate
      windowValue(sigB, '2024-07-01', '2024-12-31'), // reachable via mapping
      windowValue(sigC, '2025-01-01', '2025-03-31'), // current
    ];

    const mappings = [mapping(hashB, hashC)]; // B→C linked; A orphaned

    const result = await traceHashChain(hashC, values, mappings);

    expect(result.chainIntact).toBe(false);
    // Earliest reachable date is from epoch B (2024-07-01), not epoch A
    expect(result.earliestReachableDate).toBe('2024-07-01');
  });

  // -------------------------------------------------------------------------
  // Scenario 14: Epochs sorted oldest-first regardless of insertion order
  // -------------------------------------------------------------------------
  it('should sort epochs oldest-first by earliestDate regardless of value insertion order', async () => {
    await ensureReady();

    // Insert values in reverse chronological order
    const values = [
      windowValue(sigC, '2025-01-01', '2025-03-31'),
      windowValue(sigA, '2023-01-01', '2023-06-30'),
      windowValue(sigB, '2024-07-01', '2024-12-31'),
    ];

    const mappings = [
      mapping(hashA, hashB),
      mapping(hashB, hashC),
    ];

    const result = await traceHashChain(hashC, values, mappings);

    expect(result.epochs.length).toBe(3);
    // Should be sorted oldest first: A, B, C
    expect(result.epochs[0].coreHash).toBe(hashA);
    expect(result.epochs[1].coreHash).toBe(hashB);
    expect(result.epochs[2].coreHash).toBe(hashC);
    expect(result.epochs[0].earliestDate).toBe('2023-01-01');
    expect(result.epochs[1].earliestDate).toBe('2024-07-01');
    expect(result.epochs[2].earliestDate).toBe('2025-01-01');
  });

  // -------------------------------------------------------------------------
  // Scenario 15: Current hash always reachable even with no matching values
  // -------------------------------------------------------------------------
  it('should mark current hash epoch as reachable even when no values match it', async () => {
    await ensureReady();

    // Only old values — nothing for the current hash
    const values = [
      windowValue(sigA, '2024-01-01', '2024-06-30'),
    ];

    const mappings = [mapping(hashA, hashB)];

    const result = await traceHashChain(hashB, values, mappings);

    // hashA should be reachable via mapping from hashB
    const epochA = result.epochs.find(e => e.coreHash === hashA);
    expect(epochA).not.toBeUndefined();
    expect(epochA!.reachable).toBe(true);
    // chainIntact should be true since all epochs are reachable
    expect(result.chainIntact).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Additional: Date merging across multiple date source types
  // -------------------------------------------------------------------------
  it('should merge dates from different source fields within the same epoch', async () => {
    await ensureReady();

    // One value with window dates, another with cohort dates, same signature
    const values = [
      windowValue(sigA, '2025-02-01', '2025-02-28'),
      cohortValue(sigA, '2025-01-01', '2025-03-31'),
    ];

    const result = await traceHashChain(hashA, values);

    expect(result.epochs.length).toBe(1);
    // Merged: earliest is 2025-01-01 (from cohort_from), latest is 2025-03-31 (from cohort_to)
    expect(result.epochs[0].earliestDate).toBe('2025-01-01');
    expect(result.epochs[0].latestDate).toBe('2025-03-31');
  });

  // -------------------------------------------------------------------------
  // Additional: earliestBreakDate is earliest among ALL unreachable epochs
  // -------------------------------------------------------------------------
  it('should set earliestBreakDate to the earliest date among all unreachable epochs', async () => {
    await ensureReady();

    // Two orphaned epochs (A and B), one reachable (C is current)
    // A is older than B
    const values = [
      windowValue(sigA, '2023-03-01', '2023-06-30'),
      windowValue(sigB, '2024-01-01', '2024-06-30'),
      windowValue(sigC, '2025-01-01', '2025-03-31'),
    ];

    // No mappings — A and B are orphaned, only C is reachable (as current)
    const result = await traceHashChain(hashC, values);

    expect(result.chainIntact).toBe(false);
    // Earliest break date should be from epoch A (the older orphan)
    expect(result.earliestBreakDate).toBe('2023-03-01');
  });

  // -------------------------------------------------------------------------
  // Additional: Null dates when value has signature but no date fields at all
  // -------------------------------------------------------------------------
  it('should handle values with signature but no date fields gracefully', async () => {
    await ensureReady();

    const values = [
      { query_signature: sigA }, // no date fields at all
    ];

    const result = await traceHashChain(hashA, values);

    expect(result.epochs.length).toBe(1);
    expect(result.epochs[0].coreHash).toBe(hashA);
    expect(result.epochs[0].earliestDate).toBeNull();
    expect(result.epochs[0].latestDate).toBeNull();
    expect(result.chainIntact).toBe(true);
  });
});
