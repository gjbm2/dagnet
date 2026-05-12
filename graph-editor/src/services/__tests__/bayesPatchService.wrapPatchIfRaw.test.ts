/**
 * Contract tests for `wrapPatchIfRaw` in bayesPatchService.
 *
 * Pre-fix, the function silently defaulted a missing `fitted_at` to
 * `new Date().toISOString()` (NOW). For past-asat queries, the
 * downstream `resolveAsatPosterior` strict-drop fired immediately
 * because NOW > any past asat, wiping the bayesian model_var the
 * patch had just written. The user saw `[cli] Bayes vars applied`
 * with no signal that the projection was discarded at resolution.
 *
 * The fixed contract:
 *   - explicit `fitted_at` is preserved verbatim;
 *   - missing/empty `fitted_at` falls back to `generated_at` parsed
 *     to ISO-8601 (legacy sidecars carry a UK-format
 *     `d-MMM-yy HH:MM:SS` value here);
 *   - both missing → throw with a clear message. NEVER default to
 *     NOW.
 */
import { describe, it, expect } from 'vitest';
import { wrapPatchIfRaw } from '../bayesPatchService';

const SAMPLE_EDGE = {
  param_id: 'simple-a-to-b',
  file_path: 'parameters/simple-a-to-b.yaml',
  slices: { 'window()': { alpha: 70, beta: 30 } },
};

describe('wrapPatchIfRaw fitted_at contract', () => {
  it('preserves an explicit ISO fitted_at on the raw payload', () => {
    const wrapped = wrapPatchIfRaw(
      {
        webhook_payload_edges: [SAMPLE_EDGE],
        fitted_at: '2026-02-01T03:14:15Z',
        generated_at: '5-Feb-26 09:00:00',
      },
      'graph-x',
    );
    expect(wrapped.fitted_at).toBe('2026-02-01T03:14:15Z');
  });

  it('falls back to parsed generated_at when fitted_at is empty', () => {
    const wrapped = wrapPatchIfRaw(
      {
        webhook_payload_edges: [SAMPLE_EDGE],
        fitted_at: '',
        generated_at: '24-Apr-26 17:57:23',
      },
      'graph-x',
    );
    // 24-Apr-26 17:57:23 → 2026-04-24T17:57:23.000Z
    expect(wrapped.fitted_at).toBe('2026-04-24T17:57:23.000Z');
  });

  it('falls back to parsed generated_at when fitted_at is missing entirely', () => {
    const wrapped = wrapPatchIfRaw(
      {
        webhook_payload_edges: [SAMPLE_EDGE],
        generated_at: '1-Jan-26 00:00:00',
      },
      'graph-x',
    );
    expect(wrapped.fitted_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('throws when both fitted_at and generated_at are missing/empty', () => {
    expect(() =>
      wrapPatchIfRaw(
        {
          webhook_payload_edges: [SAMPLE_EDGE],
          fitted_at: '',
        },
        'graph-x',
      ),
    ).toThrow(/no fitted_at and no generated_at/);
  });

  it('throws when both fields are absent on the raw payload', () => {
    expect(() =>
      wrapPatchIfRaw({ webhook_payload_edges: [SAMPLE_EDGE] }, 'graph-x'),
    ).toThrow(/no fitted_at and no generated_at/);
  });

  it('does NOT silently default to current time when fitted_at is missing', () => {
    // The fix's load-bearing property: the patch must not silently use
    // NOW. If a future regression re-introduced `|| new Date().toISOString()`,
    // this test would fail because the throw would no longer fire AND
    // the produced fitted_at would be NOW (within seconds of test run).
    const beforeMs = Date.now();
    let threw = false;
    let wrapped: any = null;
    try {
      wrapped = wrapPatchIfRaw(
        { webhook_payload_edges: [SAMPLE_EDGE] },
        'graph-x',
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    if (!threw && wrapped) {
      const fittedAtMs = new Date(wrapped.fitted_at).getTime();
      // If we ever pass without throwing, the value must NOT be near now.
      expect(Math.abs(fittedAtMs - beforeMs)).toBeGreaterThan(60_000);
    }
  });

  it('full BayesPatchFile (non-raw) passes through unmodified except graph_id', () => {
    // The non-raw branch should not invoke the fitted_at resolution path
    // — it carries a fully-formed BayesPatchFile already.
    const fullPatch = {
      job_id: 'job-1',
      graph_id: 'old-graph',
      graph_file_path: 'graphs/old-graph.yaml',
      fitted_at: '2026-03-15T12:00:00Z',
      fingerprint: 'abc',
      model_version: 1,
      quality: { max_rhat: 1.001, min_ess: 14000, converged_pct: 100 },
      edges: [SAMPLE_EDGE],
      skipped: [],
    };
    const wrapped = wrapPatchIfRaw(fullPatch, 'new-graph') as any;
    expect(wrapped.fitted_at).toBe('2026-03-15T12:00:00Z');
    expect(wrapped.graph_id).toBe('new-graph');
  });
});
