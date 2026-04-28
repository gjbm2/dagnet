/**
 * Live-edge re-context on `currentDSL` change — 73e Stage 3 / 73b §3.1.
 *
 * When the user changes the live currentDSL on the canvas, the live
 * edge must re-project the matching slice onto `p.posterior.*` and
 * `p.latency.posterior.*`, upsert `model_vars[bayesian]` from the
 * projected slice, and re-run promotion so the narrow promoted surface
 * (`p.forecast.{mean, stdev, source}`) updates accordingly. Any
 * pre-existing `model_vars[analytic]` entry must survive intact.
 *
 * Pre-Stage-3 the test invoked a private orchestrator that performed
 * the upsert + promotion outside the production helper, so the test
 * passed despite production only running the in-schema projection.
 * 73b §3.1 names this gap. The shape below now calls the production
 * helper directly — it must do the full sequence on its own.
 *
 * 73d sentinel: a parameter file with two distinct slices for `window()`
 * vs `context(channel:google).window()` — switching live DSL flips
 * `p.forecast.mean` to the new slice's value.
 */

import { describe, it, expect } from 'vitest';
import { contextLiveGraphForCurrentDsl } from '../posteriorSliceContexting';

const PARAM_ID = 'edge-1-param';

function paramFileWithTwoContexts() {
  return {
    posterior: {
      fitted_at: '1-Mar-26',
      fingerprint: 'fp-current',
      hdi_level: 0.9,
      slices: {
        // Default window context. Mean = 30 / (30+90) = 0.25.
        'window()': {
          alpha: 30, beta: 90,
          mu_mean: 1.5, sigma_mean: 0.3, onset_mean: 4.0,
          ess: 1100, rhat: 1.003, divergences: 0,
          evidence_grade: 3, provenance: 'bayesian',
        },
        // Channel-scoped context. Mean = 80 / (80+20) = 0.80.
        'context(channel:google).window()': {
          alpha: 80, beta: 20,
          mu_mean: 2.5, sigma_mean: 0.5, onset_mean: 6.0,
          ess: 1100, rhat: 1.003, divergences: 0,
          evidence_grade: 3, provenance: 'bayesian',
        },
      },
    },
    values: [{ sliceDSL: 'window()', n: 200, k: 50, mean: 0.25, stdev: 0.03 }],
  };
}

function makeGraph() {
  return {
    nodes: [
      { uuid: 'n1', id: 'a', entry: { is_start: true } },
      { uuid: 'n2', id: 'b', absorbing: true },
    ],
    edges: [
      {
        uuid: 'e1', id: 'e1', from: 'n1', to: 'n2',
        p: { id: PARAM_ID, mean: 0.25, type: 'probability' },
      },
    ],
    policies: { default_outcome: 'end' },
    metadata: { version: '1.0.0' },
  };
}

const resolveParameterFile = (paramId: string) => (
  paramId === PARAM_ID ? paramFileWithTwoContexts() : undefined
);

describe('Live-edge re-context on currentDSL change (73e Stage 3)', () => {
  it('flips p.forecast.mean to the new slice when currentDSL changes (sentinel)', () => {
    // ── Initial DSL: `window()` → slice mean ≈ 0.25 ─────────────────
    const initial = makeGraph() as any;
    contextLiveGraphForCurrentDsl(initial, resolveParameterFile, 'window()');
    const e1 = initial.edges[0];
    expect(e1.p.posterior.alpha).toBe(30);
    expect(e1.p.posterior.beta).toBe(90);
    expect(e1.p.forecast).toBeDefined();
    expect(e1.p.forecast.mean).toBeCloseTo(0.25, 6);
    expect(e1.p.forecast.source).toBe('bayesian');

    // ── DSL change: `context(channel:google).window()` → mean ≈ 0.80 ─
    contextLiveGraphForCurrentDsl(initial, resolveParameterFile, 'context(channel:google).window()');
    const e2 = initial.edges[0];
    expect(e2.p.posterior.alpha).toBe(80);
    expect(e2.p.posterior.beta).toBe(20);

    // The sentinel: the promoted surface flipped to the new slice's
    // value. Without this, canvas displays that read
    // `p.forecast.{mean, stdev, source}` go stale on DSL change.
    expect(e2.p.forecast.mean).toBeCloseTo(0.80, 6);
    expect(e2.p.forecast.source).toBe('bayesian');

    // And the live latency posterior re-projected too.
    expect(e2.p.latency.posterior.mu_mean).toBe(2.5);
    expect(e2.p.latency.posterior.sigma_mean).toBe(0.5);
  });

  it('flips back when DSL changes back', () => {
    // Idempotency: window → context → window must restore the original.
    const g = makeGraph() as any;
    contextLiveGraphForCurrentDsl(g, resolveParameterFile, 'window()');
    contextLiveGraphForCurrentDsl(g, resolveParameterFile, 'context(channel:google).window()');
    contextLiveGraphForCurrentDsl(g, resolveParameterFile, 'window()');
    const e = g.edges[0];
    expect(e.p.forecast.mean).toBeCloseTo(0.25, 6);
    expect(e.p.posterior.alpha).toBe(30);
    expect(e.p.posterior.beta).toBe(90);
  });

  it('preserves a pre-existing model_vars[analytic] entry across re-context', () => {
    // Seed the edge with an analytic entry that must survive the bayesian
    // upsert. This pins the §3.1 invariant: re-context updates the
    // bayesian source, never the analytic one.
    const g = makeGraph() as any;
    g.edges[0].p.model_vars = [
      {
        source: 'analytic',
        source_at: '1-Feb-26',
        probability: { mean: 0.42, stdev: 0.05 },
        quality: { gate_passed: true },
      },
    ];

    contextLiveGraphForCurrentDsl(g, resolveParameterFile, 'window()');

    const mv = g.edges[0].p.model_vars;
    const analytic = mv.find((e: any) => e.source === 'analytic');
    expect(analytic).toBeDefined();
    expect(analytic.probability.mean).toBe(0.42);
    expect(analytic.probability.stdev).toBe(0.05);
    expect(analytic.source_at).toBe('1-Feb-26');

    // Bayesian was upserted alongside, not in place of analytic.
    const bayesian = mv.find((e: any) => e.source === 'bayesian');
    expect(bayesian).toBeDefined();
    expect(bayesian.probability.mean).toBeCloseTo(0.25, 6);

    // And re-contexting again must not duplicate the bayesian entry or
    // disturb the analytic one.
    contextLiveGraphForCurrentDsl(g, resolveParameterFile, 'context(channel:google).window()');
    const mv2 = g.edges[0].p.model_vars;
    expect(mv2.filter((e: any) => e.source === 'bayesian')).toHaveLength(1);
    expect(mv2.filter((e: any) => e.source === 'analytic')).toHaveLength(1);
    const analytic2 = mv2.find((e: any) => e.source === 'analytic');
    expect(analytic2.probability.mean).toBe(0.42);
  });
});
