/**
 * CLI --allow-external-fetch regression test.
 *
 * Verifies that the aggregate pipeline mode parameter correctly
 * gates whether the CLI attempts external API calls vs cache-only.
 *
 * The test fixture graph has no real external connection configured
 * (the IDB connection store is empty in vitest). This is intentional:
 * we verify the MODE WIRING, not the full Amplitude round-trip.
 *
 * - from-file: reads local parameter files, no connection lookup → no warnings
 * - versioned: tries cache, then attempts API → hits "no connection" error
 * - direct: always attempts API → hits "no connection" error
 *
 * The presence of connection-lookup errors in versioned/direct modes
 * proves the flag is threaded through to getFromSourceDirect. The
 * ABSENCE of such errors in from-file mode proves the gate works.
 *
 * Mock count: ZERO. This test uses no mocks — it exercises real code
 * paths with the fixture graph data and lets the connection lookup
 * fail naturally at the Amplitude boundary.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { join } from 'path';

// Set credential env vars so the versioned/direct paths reach the
// DAS runner (which then fails at connection lookup, not auth).
process.env.DAGNET_LOCAL_E2E_CREDENTIALS = '1';
process.env.AMPLITUDE_API_KEY = 'test-api-key';
process.env.AMPLITUDE_SECRET_KEY = 'test-secret-key';

import { loadGraphFromDisk, seedFileRegistry, type GraphBundle } from '../diskLoader';
import { aggregateAndPopulateGraph } from '../aggregate';

const FIXTURES_DIR = join(__dirname, 'fixtures');

describe('CLI --allow-external-fetch flag wiring', () => {
  it('should NOT attempt external fetch when mode is from-file (default)', async () => {
    const bundle = await loadGraphFromDisk(FIXTURES_DIR, 'test-fixture');
    seedFileRegistry(bundle);

    const { graph, warnings } = await aggregateAndPopulateGraph(
      bundle,
      'window(1-Jan-26:10-Jan-26)',
      // No options → defaults to from-file
    );

    // Should produce a valid result from cached parameter files
    expect(graph).toBeDefined();
    expect(graph.edges?.length).toBeGreaterThan(0);

    // from-file mode should NOT produce any connection/API errors
    const connectionErrors = warnings.filter(w =>
      w.includes('connections') || w.includes('API') || w.includes('Execution failed')
    );
    expect(connectionErrors).toHaveLength(0);
  });

  it('should attempt external fetch when mode is direct', async () => {
    const bundle = await loadGraphFromDisk(FIXTURES_DIR, 'test-fixture');
    seedFileRegistry(bundle);

    const { graph, warnings } = await aggregateAndPopulateGraph(
      bundle,
      'window(1-Jan-26:10-Jan-26)',
      { mode: 'direct' },
    );

    expect(graph).toBeDefined();

    // direct mode should attempt API calls and fail at the connection
    // boundary (no real connection configured in the test fixture IDB)
    const connectionErrors = warnings.filter(w =>
      w.includes('connections') || w.includes('API') || w.includes('Execution failed')
    );
    expect(connectionErrors.length).toBeGreaterThan(0);
  });

  it('should produce different results for from-file vs direct mode on same graph', async () => {
    // from-file: loads parameter data from fixture files
    const bundleA = await loadGraphFromDisk(FIXTURES_DIR, 'test-fixture');
    seedFileRegistry(bundleA);
    const resultA = await aggregateAndPopulateGraph(
      bundleA,
      'window(1-Jan-26:10-Jan-26)',
    );

    // direct: attempts API (fails) so graph has different data shape
    const bundleB = await loadGraphFromDisk(FIXTURES_DIR, 'test-fixture');
    seedFileRegistry(bundleB);
    const resultB = await aggregateAndPopulateGraph(
      bundleB,
      'window(1-Jan-26:10-Jan-26)',
      { mode: 'direct' },
    );

    // from-file should have no connection warnings
    const connectionWarningsA = resultA.warnings.filter(w =>
      w.includes('connections') || w.includes('API') || w.includes('Execution failed')
    );
    // direct should have connection warnings
    const connectionWarningsB = resultB.warnings.filter(w =>
      w.includes('connections') || w.includes('API') || w.includes('Execution failed')
    );

    expect(connectionWarningsA).toHaveLength(0);
    expect(connectionWarningsB.length).toBeGreaterThan(0);
  });
});
