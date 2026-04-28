/**
 * Posterior slice contexting + engorgement — doc 73b §3.2a, Stage 4(a)/4(e).
 *
 * Verifies the shared slice helper that replaces the persistent
 * `_posteriorSlices` stash. Pure orchestration around
 * `posteriorSliceResolution.ts`; these tests pin the orchestration
 * contract: parameter-file lookup, asat handling, conditional_p
 * mirroring, and the engorgement flag's effect on `_posteriorSlices`.
 */

import { describe, it, expect } from 'vitest';
import type { Posterior, SlicePosteriorEntry } from '../../types';
import {
  contextGraphForEffectiveDsl,
  contextLiveGraphForCurrentDsl,
  type ParameterFileResolver,
} from '../posteriorSliceContexting';

function makeSlice(overrides: Partial<SlicePosteriorEntry> = {}): SlicePosteriorEntry {
  return {
    alpha: 40,
    beta: 120,
    p_hdi_lower: 0.2,
    p_hdi_upper: 0.32,
    mu_mean: 1.8,
    mu_sd: 0.05,
    sigma_mean: 0.3,
    sigma_sd: 0.02,
    onset_mean: 5.0,
    onset_sd: 0.7,
    hdi_t95_lower: 22,
    hdi_t95_upper: 36,
    ess: 1000,
    rhat: 1.005,
    divergences: 0,
    evidence_grade: 3,
    provenance: 'bayesian',
    ...overrides,
  };
}

function makePosterior(): Posterior {
  return {
    fitted_at: '1-Mar-26',
    fingerprint: 'fp-current',
    hdi_level: 0.9,
    prior_tier: 'direct_history',
    slices: {
      'window()': makeSlice({ alpha: 40, beta: 120 }),
      'cohort()': makeSlice({ alpha: 35, beta: 110, mu_mean: 2.4 }),
    },
    fit_history: [
      {
        fitted_at: '15-Jan-26',
        fingerprint: 'fp-jan15',
        hdi_level: 0.9,
        prior_tier: 'direct_history',
        slices: { 'window()': makeSlice({ alpha: 30, beta: 90 }) },
      },
    ],
  };
}

function makeGraphWithEdge(paramId: string): any {
  return {
    edges: [{ id: 'edge-1', uuid: 'edge-1', p: { id: paramId } }],
    nodes: [],
  };
}

function resolverFor(paramId: string, file: any): ParameterFileResolver {
  return (id: string) => (id === paramId ? file : undefined);
}

describe('contextGraphForEffectiveDsl — in-schema contexting', () => {
  it('projects window() slice when DSL is window-mode', () => {
    const graph = makeGraphWithEdge('p-1');
    contextGraphForEffectiveDsl(
      graph,
      resolverFor('p-1', { posterior: makePosterior() }),
      'from(a).to(b).window(1-Jan-26:31-Jan-26)',
    );

    const p = graph.edges[0].p;
    expect(p.posterior).toBeDefined();
    expect(p.posterior.alpha).toBe(40);
    expect(p.posterior.beta).toBe(120);
    expect(p.posterior.cohort_alpha).toBe(35);
    expect(p.latency.posterior).toBeDefined();
    expect(p.latency.posterior.mu_mean).toBe(1.8);
  });

  it('projects path-level fields from cohort() slice in cohort-mode DSL', () => {
    const graph = makeGraphWithEdge('p-1');
    contextGraphForEffectiveDsl(
      graph,
      resolverFor('p-1', { posterior: makePosterior() }),
      'from(a).to(b).cohort(1-Jan-26:31-Jan-26)',
    );

    const p = graph.edges[0].p;
    // Edge-level fields always come from window() per doc 25 §2.2,
    // but cohort-mode preserves cohort-level path fields.
    expect(p.latency.posterior.path_mu_mean).toBe(2.4);
  });

  it('mirrors projection under each conditional_p[i].p block', () => {
    const graph = {
      edges: [{
        id: 'edge-1',
        uuid: 'edge-1',
        p: { id: 'p-base' },
        conditional_p: [
          { condition: 'X', p: { id: 'p-cond-x' } },
          { condition: 'Y', p: { id: 'p-cond-y' } },
        ],
      }],
      nodes: [],
    };
    const resolve = (id: string) => {
      if (id === 'p-base') return { posterior: makePosterior() };
      if (id === 'p-cond-x') return { posterior: makePosterior() };
      if (id === 'p-cond-y') return { posterior: makePosterior() };
      return undefined;
    };

    contextGraphForEffectiveDsl(graph, resolve, 'window()');

    expect(graph.edges[0].p.posterior).toBeDefined();
    expect((graph.edges[0].conditional_p[0].p as any).posterior).toBeDefined();
    expect((graph.edges[0].conditional_p[1].p as any).posterior).toBeDefined();
  });

  it('does NOT engorge _posteriorSlices when engorgeFitHistory is false', () => {
    const graph = makeGraphWithEdge('p-1');
    contextGraphForEffectiveDsl(
      graph,
      resolverFor('p-1', { posterior: makePosterior() }),
      'window()',
      { engorgeFitHistory: false },
    );
    expect(graph.edges[0].p._posteriorSlices).toBeUndefined();
  });

  it('engorges _posteriorSlices when engorgeFitHistory is true', () => {
    const graph = makeGraphWithEdge('p-1');
    contextGraphForEffectiveDsl(
      graph,
      resolverFor('p-1', { posterior: makePosterior() }),
      'window()',
      { engorgeFitHistory: true },
    );
    const stash = graph.edges[0].p._posteriorSlices;
    expect(stash).toBeDefined();
    expect(stash.slices).toBeDefined();
    expect(Object.keys(stash.slices)).toContain('window()');
    expect(stash.fit_history).toBeDefined();
    expect(stash.fit_history[0].fingerprint).toBe('fp-jan15');
  });

  it('resolves historical posterior when DSL contains asat()', () => {
    const graph = makeGraphWithEdge('p-1');
    // Current posterior fitted 1-Mar-26; asat 20-Jan-26 should pick the
    // 15-Jan-26 fit_history entry whose window() slice has alpha=30, beta=90.
    contextGraphForEffectiveDsl(
      graph,
      resolverFor('p-1', { posterior: makePosterior() }),
      'window().asat(20-Jan-26)',
    );

    const p = graph.edges[0].p;
    expect(p.posterior).toBeDefined();
    expect(p.posterior.alpha).toBe(30);
    expect(p.posterior.beta).toBe(90);
  });

  it('clears posterior strictly when asat() resolves no on-or-before fit', () => {
    const graph = makeGraphWithEdge('p-1');
    graph.edges[0].p.posterior = { distribution: 'beta', alpha: 99, beta: 99 } as any;
    graph.edges[0].p.latency = { posterior: { distribution: 'lognormal' } } as any;

    // asat well before any fit — strict clear (doc 27 §5.2).
    contextGraphForEffectiveDsl(
      graph,
      resolverFor('p-1', { posterior: makePosterior() }),
      'window().asat(1-Jan-25)',
    );
    expect(graph.edges[0].p.posterior).toBeUndefined();
    expect(graph.edges[0].p.latency.posterior).toBeUndefined();
  });

  it('clears posterior strictly when parameter file has no posterior slices (73b §7.5)', () => {
    const graph = makeGraphWithEdge('p-1');
    graph.edges[0].p.posterior = { distribution: 'beta', alpha: 7, beta: 13 } as any;
    graph.edges[0].p.latency = { posterior: { distribution: 'lognormal' } } as any;

    contextGraphForEffectiveDsl(
      graph,
      resolverFor('p-1', { /* no posterior */ }),
      'window()',
    );
    // 73b §7.5 closure (28-Apr-26): when the source of truth cannot
    // supply a slice for the effective DSL, the in-schema projection on
    // the edge is wiped — same shape as the asat-no-fit branch.
    expect(graph.edges[0].p.posterior).toBeUndefined();
    expect(graph.edges[0].p.latency.posterior).toBeUndefined();
  });

  it('clears engorged _posteriorSlices when parameter file has no posterior', () => {
    const graph = makeGraphWithEdge('p-1');
    graph.edges[0].p._posteriorSlices = { slices: { 'window()': { alpha: 1, beta: 1 } } };

    contextGraphForEffectiveDsl(
      graph,
      resolverFor('p-1', { /* no posterior */ }),
      'window()',
      { engorgeFitHistory: true },
    );
    expect(graph.edges[0].p._posteriorSlices).toBeUndefined();
  });
});

describe('contextLiveGraphForCurrentDsl — convenience wrapper', () => {
  it('applies in-schema contexting only and never engorges', () => {
    const graph = makeGraphWithEdge('p-1');
    contextLiveGraphForCurrentDsl(
      graph,
      resolverFor('p-1', { posterior: makePosterior() }),
      'window()',
    );
    expect(graph.edges[0].p.posterior).toBeDefined();
    expect(graph.edges[0].p._posteriorSlices).toBeUndefined();
  });

  it('handles null graph gracefully', () => {
    expect(() => contextLiveGraphForCurrentDsl(null, () => undefined, 'window()')).not.toThrow();
  });
});
