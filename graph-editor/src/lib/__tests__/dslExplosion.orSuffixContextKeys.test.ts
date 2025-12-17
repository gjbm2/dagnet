/**
 * DSL explosion: suffix `.or(...)` distribution with bare context keys.
 *
 * Typical pinned DSL pattern:
 *   or(cohort(-60d:),window(-60d:)).or(context(channel),context(geo))
 *
 * Expected semantics:
 * - or(timeA,timeB).or(ctxA,ctxB) expands to:
 *   timeA.ctxA; timeA.ctxB; timeB.ctxA; timeB.ctxB
 * - bare context keys expand to all values per key
 * - total slices = 2(N+M), not 2(N*M)
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { explodeDSL } from '../dslExplosion';
import { contextRegistry } from '../../services/contextRegistry';

describe('explodeDSL suffix .or(context(key),...)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(contextRegistry, 'getValuesForContext').mockImplementation(async (key: string) => {
      if (key === 'channel') return [{ id: 'google' }, { id: 'meta' }]; // N=2
      if (key === 'geo') return [{ id: 'uk' }, { id: 'us' }, { id: 'fr' }]; // M=3
      return [];
    });
  });

  it('expands to 2(N+M) slices', async () => {
    const dsl = 'or(cohort(-60d:),window(-60d:)).or(context(channel),context(geo))';
    const slices = await explodeDSL(dsl);

    // Expected: cohort×(channels + geos) + window×(channels + geos)
    // = 2 * (2 + 3) = 10
    expect(slices).toHaveLength(10);

    // Spot check a few representative slices exist
    expect(slices.some(s => s.includes('cohort(-60d:)') && s.includes('context(channel:google)'))).toBe(true);
    expect(slices.some(s => s.includes('cohort(-60d:)') && s.includes('context(geo:uk)'))).toBe(true);
    expect(slices.some(s => s.includes('window(-60d:)') && s.includes('context(channel:meta)'))).toBe(true);
    expect(slices.some(s => s.includes('window(-60d:)') && s.includes('context(geo:fr)'))).toBe(true);
  });
});


