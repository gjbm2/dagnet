/**
 * Implicit-uncontexted cache selection hardening tests
 *
 * Verifies the shared selection logic used by BOTH:
 * - dataOperationsService get-from-file path
 * - windowAggregationService incremental coverage path
 *
 * Focus: competing MECE generations (query_signature) and competing uncontexted duplicates.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ParameterValue } from '../../types/parameterData';
import { selectImplicitUncontextedSliceSetSync } from '../meceSliceService';
import { contextRegistry } from '../contextRegistry';

function pv(args: Partial<ParameterValue> & { sliceDSL: string; retrieved_at: string; query_signature?: string | null }): ParameterValue {
  return {
    sliceDSL: args.sliceDSL,
    dates: args.dates,
    n_daily: args.n_daily,
    k_daily: args.k_daily,
    n: args.n,
    k: args.k,
    window_from: args.window_from,
    window_to: args.window_to,
    cohort_from: args.cohort_from,
    cohort_to: args.cohort_to,
    query_signature: (args as any).query_signature,
    data_source: { type: 'amplitude', retrieved_at: args.retrieved_at } as any,
  } as any;
}

describe('selectImplicitUncontextedSliceSetSync (hardening)', () => {
  beforeEach(() => {
    // Make MECE detection deterministic for these unit tests.
    // We treat 'channel' as MECE with expected values:
    // paid-search, influencer, paid-social, other.
    vi.spyOn(contextRegistry, 'detectMECEPartitionSync').mockImplementation((windows: any[], key: string) => {
      if (key !== 'channel') {
        return { isMECE: false, isComplete: false, canAggregate: false, missingValues: [], policy: 'explicit' } as any;
      }
      const expected = ['paid-search', 'influencer', 'paid-social', 'other'];
      const present = new Set<string>();
      for (const w of windows || []) {
        const dsl = String((w as any)?.sliceDSL ?? '');
        const m = dsl.match(/context\(\s*channel\s*:\s*([^)]+)\s*\)/);
        if (m) present.add(m[1].trim());
      }
      const missing = expected.filter(v => !present.has(v));
      return {
        isMECE: true,
        isComplete: missing.length === 0,
        canAggregate: missing.length === 0,
        missingValues: missing,
        policy: 'computed',
      } as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('chooses the most recent explicit uncontexted slice when it is newer than any complete MECE generation', () => {
    const values: ParameterValue[] = [
      // Older explicit uncontexted
      pv({ sliceDSL: '', retrieved_at: '2026-01-01T00:00:00Z' }),
      // Newer explicit uncontexted (should win)
      pv({ sliceDSL: '', retrieved_at: '2026-01-03T00:00:00Z' }),

      // Complete MECE generation (older)
      pv({ sliceDSL: 'context(channel:paid-search)', retrieved_at: '2026-01-02T00:00:00Z', query_signature: 'sig-old' }),
      pv({ sliceDSL: 'context(channel:influencer)', retrieved_at: '2026-01-02T00:00:00Z', query_signature: 'sig-old' }),
      pv({ sliceDSL: 'context(channel:paid-social)', retrieved_at: '2026-01-02T00:00:00Z', query_signature: 'sig-old' }),
      pv({ sliceDSL: 'context(channel:other)', retrieved_at: '2026-01-02T00:00:00Z', query_signature: 'sig-old' }),
    ];

    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: values, requireCompleteMECE: true });
    expect(r.kind).toBe('explicit_uncontexted');
    if (r.kind !== 'explicit_uncontexted') throw new Error('expected explicit_uncontexted');
    expect(r.values).toHaveLength(1);
    expect(r.values[0].data_source?.retrieved_at).toBe('2026-01-03T00:00:00Z');
  });

  it('chooses the newest COMPLETE MECE generation (by set recency=min(retrieved_at)) and does not mix generations', () => {
    const values: ParameterValue[] = [
      // Explicit uncontexted exists but is older than newest MECE
      pv({ sliceDSL: '', retrieved_at: '2026-01-01T00:00:00Z' }),

      // MECE generation A (older complete)
      pv({ sliceDSL: 'context(channel:paid-search)', retrieved_at: '2026-01-02T00:00:00Z', query_signature: 'sig-a' }),
      pv({ sliceDSL: 'context(channel:influencer)', retrieved_at: '2026-01-02T00:00:00Z', query_signature: 'sig-a' }),
      pv({ sliceDSL: 'context(channel:paid-social)', retrieved_at: '2026-01-02T00:00:00Z', query_signature: 'sig-a' }),
      pv({ sliceDSL: 'context(channel:other)', retrieved_at: '2026-01-02T00:00:00Z', query_signature: 'sig-a' }),

      // MECE generation B (newer complete)
      pv({ sliceDSL: 'context(channel:paid-search)', retrieved_at: '2026-01-04T00:00:00Z', query_signature: 'sig-b' }),
      pv({ sliceDSL: 'context(channel:influencer)', retrieved_at: '2026-01-04T00:00:00Z', query_signature: 'sig-b' }),
      pv({ sliceDSL: 'context(channel:paid-social)', retrieved_at: '2026-01-04T00:00:00Z', query_signature: 'sig-b' }),
      pv({ sliceDSL: 'context(channel:other)', retrieved_at: '2026-01-04T00:00:00Z', query_signature: 'sig-b' }),
    ];

    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: values, requireCompleteMECE: true });
    expect(r.kind).toBe('mece_partition');
    if (r.kind !== 'mece_partition') throw new Error('expected mece_partition');
    expect(r.key).toBe('channel');
    expect(r.querySignature).toBe('sig-b');
    expect(r.values).toHaveLength(4);
    // Ensure all chosen values belong to the same generation
    const sigs = new Set(r.values.map((v: any) => v.query_signature || null));
    expect(Array.from(sigs)).toEqual(['sig-b']);
  });

  it('refuses incomplete newer MECE generation when requireCompleteMECE=true and falls back to older complete generation', () => {
    const values: ParameterValue[] = [
      // Older complete generation
      pv({ sliceDSL: 'context(channel:paid-search)', retrieved_at: '2026-01-02T00:00:00Z', query_signature: 'sig-complete' }),
      pv({ sliceDSL: 'context(channel:influencer)', retrieved_at: '2026-01-02T00:00:00Z', query_signature: 'sig-complete' }),
      pv({ sliceDSL: 'context(channel:paid-social)', retrieved_at: '2026-01-02T00:00:00Z', query_signature: 'sig-complete' }),
      pv({ sliceDSL: 'context(channel:other)', retrieved_at: '2026-01-02T00:00:00Z', query_signature: 'sig-complete' }),

      // Newer but INCOMPLETE generation (missing 'other')
      pv({ sliceDSL: 'context(channel:paid-search)', retrieved_at: '2026-01-05T00:00:00Z', query_signature: 'sig-incomplete' }),
      pv({ sliceDSL: 'context(channel:influencer)', retrieved_at: '2026-01-05T00:00:00Z', query_signature: 'sig-incomplete' }),
      pv({ sliceDSL: 'context(channel:paid-social)', retrieved_at: '2026-01-05T00:00:00Z', query_signature: 'sig-incomplete' }),
    ];

    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: values, requireCompleteMECE: true });
    expect(r.kind).toBe('mece_partition');
    if (r.kind !== 'mece_partition') throw new Error('expected mece_partition');
    expect(r.querySignature).toBe('sig-complete');
    expect(r.values).toHaveLength(4);
  });

  it('dedupes duplicates for the same context value within a generation by choosing the most recent for that slice', () => {
    const values: ParameterValue[] = [
      // Duplicate paid-search entries within same generation: newest should be used
      pv({ sliceDSL: 'context(channel:paid-search)', retrieved_at: '2026-01-02T00:00:00Z', query_signature: 'sig-a' }),
      pv({ sliceDSL: 'context(channel:paid-search)', retrieved_at: '2026-01-03T00:00:00Z', query_signature: 'sig-a' }),
      pv({ sliceDSL: 'context(channel:influencer)', retrieved_at: '2026-01-03T00:00:00Z', query_signature: 'sig-a' }),
      pv({ sliceDSL: 'context(channel:paid-social)', retrieved_at: '2026-01-03T00:00:00Z', query_signature: 'sig-a' }),
      pv({ sliceDSL: 'context(channel:other)', retrieved_at: '2026-01-03T00:00:00Z', query_signature: 'sig-a' }),
    ];

    const r = selectImplicitUncontextedSliceSetSync({ candidateValues: values, requireCompleteMECE: true });
    expect(r.kind).toBe('mece_partition');
    if (r.kind !== 'mece_partition') throw new Error('expected mece_partition');
    expect(r.values).toHaveLength(4);
    const paidSearch = r.values.find(v => v.sliceDSL?.includes('context(channel:paid-search)'));
    expect(paidSearch?.data_source?.retrieved_at).toBe('2026-01-03T00:00:00Z');
  });
});


