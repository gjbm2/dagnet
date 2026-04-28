/**
 * Live-edge re-context on `currentDSL` change — doc 73b §8 Stage 4(e) /
 * doc 73d.
 *
 * Plan (§8(e)): when the user changes the live currentDSL on the
 * canvas, the live edge re-projects the matching slice onto
 * `model_vars[bayesian]`, `p.posterior.*`, and `p.latency.posterior.*`,
 * via the same shared slice helper. Promotion re-runs as a downstream
 * consequence (it already runs on `model_vars` mutation), so the
 * narrow promoted surface (`p.forecast.{mean, stdev, source}`) updates
 * automatically. Without this, after Stage 4(c) lands, canvas displays
 * that read the promoted surface go stale on every currentDSL change
 * because today's compensating CF write of `forecast.mean = p_mean` is
 * removed.
 *
 * 73d sentinel: a parameter file with two distinct slices for `window()`
 * vs `context(channel:google).window()` — switching live DSL flips
 * `p.forecast.mean` to the new slice's value.
 */

import { describe, it, expect } from 'vitest';
import { contextLiveGraphForCurrentDsl } from '../posteriorSliceContexting';
import { applyPromotion, upsertModelVars } from '../modelVarsResolution';

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

/**
 * Mirror the runtime sequence the spec describes:
 *  1. `contextLiveGraphForCurrentDsl` projects the matching slice into
 *     `p.posterior.*` and `p.latency.posterior.*` (mutates in place).
 *  2. The bayesian `model_vars` entry is upserted from the same slice
 *     (the live-edge equivalent of what the bayes-patch service does
 *     in the persistent-fit path).
 *  3. `applyPromotion` re-runs and writes the narrow promoted surface.
 */
function recontextAndPromote(graph: any, currentDSL: string): any {
  contextLiveGraphForCurrentDsl(graph, resolveParameterFile, currentDSL);
  const edge = graph.edges[0];
  const post = edge.p?.posterior;
  if (post && Number.isFinite(post.alpha) && Number.isFinite(post.beta)) {
    const sum = post.alpha + post.beta;
    upsertModelVars(edge.p, {
      source: 'bayesian',
      source_at: '1-Mar-26',
      probability: {
        mean: post.alpha / sum,
        stdev: Math.sqrt((post.alpha * post.beta) / (sum * sum * (sum + 1))),
      },
      latency: edge.p.latency?.posterior
        ? {
            mu: edge.p.latency.posterior.mu_mean,
            sigma: edge.p.latency.posterior.sigma_mean,
            t95: 0,
            onset_delta_days: edge.p.latency.posterior.onset_mean,
          }
        : undefined,
      quality: { gate_passed: true },
    });
    applyPromotion(edge.p, undefined);
  }
  return graph;
}

describe('Live-edge re-context on currentDSL change (Stage 4(e))', () => {
  it('flips p.forecast.mean to the new slice when currentDSL changes (sentinel)', () => {
    // ── Initial DSL: `window()` → slice mean ≈ 0.25 ─────────────────
    const initial = recontextAndPromote(makeGraph() as any, 'window()');
    const e1 = initial.edges[0];
    expect(e1.p.posterior.alpha).toBe(30);
    expect(e1.p.posterior.beta).toBe(90);
    expect(e1.p.forecast).toBeDefined();
    expect(e1.p.forecast.mean).toBeCloseTo(0.25, 6);
    expect(e1.p.forecast.source).toBe('bayesian');

    // ── DSL change: `context(channel:google).window()` → mean ≈ 0.80 ─
    const flipped = recontextAndPromote(
      initial,
      'context(channel:google).window()',
    );
    const e2 = flipped.edges[0];
    expect(e2.p.posterior.alpha).toBe(80);
    expect(e2.p.posterior.beta).toBe(20);

    // The §8(e) sentinel: the promoted surface flipped to the new
    // slice's value. Without this, after Stage 4(c) the canvas displays
    // that read `p.forecast.{mean, stdev, source}` go stale on DSL
    // change.
    expect(e2.p.forecast.mean).toBeCloseTo(0.80, 6);
    expect(e2.p.forecast.source).toBe('bayesian');

    // And the live latency posterior re-projected too.
    expect(e2.p.latency.posterior.mu_mean).toBe(2.5);
    expect(e2.p.latency.posterior.sigma_mean).toBe(0.5);
  });

  it('flips back when DSL changes back', () => {
    // Idempotency: window → context → window must restore the original.
    const a = recontextAndPromote(makeGraph() as any, 'window()');
    const b = recontextAndPromote(a, 'context(channel:google).window()');
    const c = recontextAndPromote(b, 'window()');
    const e = c.edges[0];
    expect(e.p.forecast.mean).toBeCloseTo(0.25, 6);
    expect(e.p.posterior.alpha).toBe(30);
    expect(e.p.posterior.beta).toBe(90);
  });
});
