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

  it('emits a session-log warning when asat() strict-drops a fit (Phase 6a)', async () => {
    // Defence-in-depth (asat-bayes-vars-fix plan §Phase 6a). The strict-drop
    // is by design; the session-log entry surfaces it so a future regression
    // — e.g. wrapPatchIfRaw silently defaulting fitted_at to NOW for past
    // asat queries — is observable instead of silent.
    const { sessionLogService } = await import('../sessionLogService');
    const calls: Array<{ category: string; operation: string; details?: string }> = [];
    const original = sessionLogService.warning.bind(sessionLogService);
    (sessionLogService as any).warning = (
      category: string,
      operation: string,
      message: string,
      details?: string,
    ): string => {
      calls.push({ category, operation, details });
      return 'stub';
    };

    try {
      const graph = makeGraphWithEdge('p-strict-drop');
      contextGraphForEffectiveDsl(
        graph,
        resolverFor('p-strict-drop', { posterior: makePosterior() }),
        'window().asat(1-Jan-25)',
      );
    } finally {
      (sessionLogService as any).warning = original;
    }

    const stricts = calls.filter((c) => c.operation === 'BAYES_SLICE_STRICT_DROP_AT_ASAT');
    expect(stricts.length).toBe(1);
    expect(stricts[0].details).toContain('paramId=p-strict-drop');
    expect(stricts[0].details).toContain('asat=1-Jan-25');
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

  it('strict no-fallback: context-bearing DSL with no matching slice drops bayesian', () => {
    // Per posteriorSliceResolution.ts:158-188, when the DSL specifies a
    // context dimension (`context(channel:google)`) but the file's posterior
    // only has bare-aggregate slices (`window()` / `cohort()`), the resolver
    // returns undefined — it does NOT silently fall back to the aggregate.
    // The marginal aggregate is a different population from the asked-for
    // conditional, and substituting it would present the wrong posterior
    // as authoritative.
    //
    // This is the canonical "bayes disappears on a context-bearing scenario"
    // path. Coverage of it pins that the strict semantics survive future
    // refactors. The bare aggregate is present in the file — the test fails
    // if a future change reintroduces cross-context fallback.
    const graph = makeGraphWithEdge('p-1');
    // Seed an existing bayesian projection on the edge so we can assert it
    // gets actively cleared, not just absent.
    graph.edges[0].p.posterior = { distribution: 'beta', alpha: 7, beta: 13 } as any;
    graph.edges[0].p.model_vars = [
      {
        source: 'bayesian',
        source_at: '1-Mar-26',
        probability: { alpha: 7, beta: 13 },
        quality: { gate_passed: true, rhat: 1.001, ess: 1000, divergences: 0 },
        fit_diagnostics: { probability: { fitted_at: '1-Mar-26' } },
      },
    ];

    contextGraphForEffectiveDsl(
      graph,
      resolverFor('p-1', { posterior: makePosterior() }), // file has only window() + cohort() aggregates
      'context(channel:google).window()',
    );

    expect(graph.edges[0].p.posterior).toBeUndefined();
    const bayes = graph.edges[0].p.model_vars?.find((mv: any) => mv?.source === 'bayesian');
    expect(bayes).toBeUndefined();
  });

  it('strict no-fallback preserves a non-bayesian source-ledger entry on drop', () => {
    // Companion to the above: dropping bayesian must NOT cascade to other
    // source-ledger entries. Only `model_vars[bayesian]` is removed; the
    // analytic entry, if present, survives intact.
    const graph = makeGraphWithEdge('p-1');
    graph.edges[0].p.model_vars = [
      {
        source: 'analytic',
        source_at: '1-Feb-26',
        probability: { mean: 0.42, stdev: 0.05 },
        quality: { gate_passed: true },
      },
      {
        source: 'bayesian',
        source_at: '1-Mar-26',
        probability: { alpha: 7, beta: 13 },
        quality: { gate_passed: true, rhat: 1.001, ess: 1000, divergences: 0 },
        fit_diagnostics: { probability: { fitted_at: '1-Mar-26' } },
      },
    ];

    contextGraphForEffectiveDsl(
      graph,
      resolverFor('p-1', { posterior: makePosterior() }),
      'context(channel:google).window()',
    );

    const sources = (graph.edges[0].p.model_vars ?? []).map((mv: any) => mv?.source);
    expect(sources).toContain('analytic');
    expect(sources).not.toContain('bayesian');
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
