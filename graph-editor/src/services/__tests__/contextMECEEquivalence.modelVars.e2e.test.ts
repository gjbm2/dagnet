/**
 * MECE equivalence — model_vars[analytic] coverage (per 73b §3.9 mirror contract).
 *
 * Sibling to contextMECEEquivalence.windowAndIncomplete.e2e.test.ts. That
 * file pins `extractParamsFromGraph`-equivalent param-pack surfaces
 * (p.mean, p.forecast, p.evidence, p.posterior); model_vars is NOT in the
 * param pack. Per 73b §6.5 the carrier reroute reads via
 * `resolve_model_params` from `model_vars[]`, and §3.9 makes the analytic
 * source-layer entry the canonical FE-fallback model. So the equivalence
 * the param-pack tests assert must also hold at the source layer.
 *
 * Spec invariant being pinned (73b §3.9):
 *
 *   When the user issues an uncontexted `window()` query and FE topo
 *   produces `model_vars[analytic]`, the entry must be derived from
 *   aggregate window-family evidence. When evidence is delivered as a
 *   MECE partition across a context dimension (one slice per value),
 *   FE topo must aggregate the partition. The result must be equivalent
 *   to the entry that would have been produced from a single explicit
 *   uncontexted slice carrying the summed totals.
 *
 *   §3.9 lists the required window-family probability fields:
 *     mean, stdev, alpha, beta, n_effective (or window_n_effective),
 *     provenance.
 *
 *   §3.9 lists the required window/edge-level latency fields:
 *     mu, sigma, t95, onset_delta_days, mu_sd, sigma_sd, onset_sd,
 *     onset_mu_corr.
 *
 * The test asserts unconditional presence and equivalence on each
 * required field. Failures are informative about §3.9 / code drift —
 * deliberate, not weasel-guarded.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { Graph } from '../../types';
import { fileRegistry } from '../../contexts/TabContext';
import { fetchDataService, createFetchItem, type FetchItem } from '../fetchDataService';
import { contextRegistry } from '../contextRegistry';

type ParamFile = {
  id: string;
  type: string;
  values: any[];
};

async function registerParameterFile(paramId: string, data: ParamFile): Promise<void> {
  await fileRegistry.registerFile(`parameter-${paramId}`, {
    fileId: `parameter-${paramId}`,
    type: 'parameter',
    data,
    originalData: structuredClone(data),
    isDirty: false,
    isInitializing: false,
    source: { repository: 'test-repo', branch: 'main', isLocal: true } as any,
    viewTabs: [],
    lastModified: Date.now(),
  } as any);
}

function makeLatencyGraph(edgeId: string, paramId: string, currentQueryDSL: string): Graph {
  return {
    nodes: [
      { id: 'A', uuid: 'A', entry: { is_start: true, entry_weight: 1 } } as any,
      { id: 'B', uuid: 'B' } as any,
    ],
    edges: [
      {
        id: edgeId,
        uuid: edgeId,
        from: 'A',
        to: 'B',
        p: {
          id: paramId,
          connection: 'amplitude-test',
          latency: { latency_parameter: true, anchor_node_id: 'A', t95: 7 },
        },
      } as any,
    ],
    currentQueryDSL,
  } as any;
}

function getAnalyticEntry(graph: Graph, label: string): any {
  const edge = (graph as any).edges[0];
  const mv = edge?.p?.model_vars ?? [];
  const analytic = mv.find((e: any) => e.source === 'analytic');
  expect(analytic, `${label}: model_vars[analytic] must exist (§3.9)`).toBeDefined();
  return analytic;
}

async function resetFileRegistry(): Promise<void> {
  (fileRegistry as any).files?.clear?.();
  (fileRegistry as any).listeners?.clear?.();
}

describe('MECE equivalence: model_vars[analytic] (73b §3.9)', () => {
  beforeAll(async () => {
    contextRegistry.clearCache();
    (contextRegistry as any).cache.set('channel', {
      id: 'channel',
      name: 'Channel',
      description: 'Test',
      type: 'categorical',
      otherPolicy: 'null',
      values: [
        { id: 'google', label: 'Google' },
        { id: 'meta', label: 'Meta' },
      ],
      metadata: { status: 'active', created_at: '1-Dec-25', version: '1.0.0' },
    });
    await resetFileRegistry();
  });

  beforeEach(async () => {
    await resetFileRegistry();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await resetFileRegistry();
  });

  it('window() uncontexted query: model_vars[analytic] from MECE partition equals explicit uncontexted', async () => {
    const edgeId = 'edge-A-B';
    const dsl = 'window(1-Dec-25:3-Dec-25)';

    const baselineParamId = 'mvars-window-explicit';
    const meceOnlyParamId = 'mvars-window-mece-only';

    const windowDates = ['1-Dec-25', '2-Dec-25', '3-Dec-25'];

    // Baseline: single explicit uncontexted slice. n=900, k=240.
    const fileA: ParamFile = {
      id: baselineParamId,
      type: 'probability',
      values: [
        {
          sliceDSL: 'window(1-Dec-25:3-Dec-25)',
          window_from: '1-Dec-25',
          window_to: '3-Dec-25',
          dates: windowDates,
          n_daily: [300, 300, 300],
          k_daily: [80, 80, 80],
          n: 900,
          k: 240,
          mean: 80 / 300,
          forecast: 80 / 300,
          median_lag_days: [2, 2, 2],
          mean_lag_days: [3, 3, 3],
          data_source: { type: 'amplitude', retrieved_at: '17-Dec-25T00:00:00.000Z' },
        },
      ],
    };

    // MECE partition across `channel`: same totals (google n=600 k=180 + meta n=300 k=60 = n=900 k=240).
    const fileB: ParamFile = {
      id: meceOnlyParamId,
      type: 'probability',
      values: [
        {
          sliceDSL: 'window(1-Dec-25:3-Dec-25).context(channel:google)',
          window_from: '1-Dec-25',
          window_to: '3-Dec-25',
          dates: windowDates,
          n_daily: [200, 200, 200],
          k_daily: [60, 60, 60],
          n: 600,
          k: 180,
          mean: 0.3,
          forecast: 0.3,
          median_lag_days: [2, 2, 2],
          mean_lag_days: [3, 3, 3],
          data_source: { type: 'amplitude', retrieved_at: '17-Dec-25T00:00:00.000Z' },
        },
        {
          sliceDSL: 'window(1-Dec-25:3-Dec-25).context(channel:meta)',
          window_from: '1-Dec-25',
          window_to: '3-Dec-25',
          dates: windowDates,
          n_daily: [100, 100, 100],
          k_daily: [20, 20, 20],
          n: 300,
          k: 60,
          mean: 0.2,
          forecast: 0.2,
          median_lag_days: [2, 2, 2],
          mean_lag_days: [3, 3, 3],
          data_source: { type: 'amplitude', retrieved_at: '17-Dec-25T00:00:00.000Z' },
        },
      ],
    };

    await registerParameterFile(baselineParamId, fileA);
    await registerParameterFile(meceOnlyParamId, fileB);

    // Run A — explicit uncontexted baseline
    let graphA: Graph | null = makeLatencyGraph(edgeId, baselineParamId, dsl);
    const setGraphA = (g: Graph | null) => { graphA = g; };
    const itemsA: FetchItem[] = [createFetchItem('parameter', baselineParamId, edgeId)];
    const resultsA = await fetchDataService.fetchItems(
      itemsA, { mode: 'from-file' }, graphA as Graph, setGraphA, dsl, () => graphA,
    );
    expect(resultsA.every((r) => r.success)).toBe(true);
    const analyticA = getAnalyticEntry(graphA as Graph, 'baseline');

    // Run B — MECE-only contexted slices, same totals
    let graphB: Graph | null = makeLatencyGraph(edgeId, meceOnlyParamId, dsl);
    const setGraphB = (g: Graph | null) => { graphB = g; };
    const itemsB: FetchItem[] = [createFetchItem('parameter', meceOnlyParamId, edgeId)];
    const resultsB = await fetchDataService.fetchItems(
      itemsB, { mode: 'from-file' }, graphB as Graph, setGraphB, dsl, () => graphB,
    );
    expect(resultsB.every((r) => r.success)).toBe(true);
    const analyticB = getAnalyticEntry(graphB as Graph, 'MECE');

    // ── §3.9 required probability fields (window-family) ────────────────
    // The plan lists these as REQUIRED. Each must be present on both
    // entries and must agree.
    const probA = analyticA.probability;
    const probB = analyticB.probability;
    expect(probA, 'baseline analytic.probability').toBeDefined();
    expect(probB, 'MECE analytic.probability').toBeDefined();

    // mean — aggregate window-family rate estimate
    expect(typeof probA.mean, 'baseline probability.mean type').toBe('number');
    expect(typeof probB.mean, 'MECE probability.mean type').toBe('number');
    expect(probB.mean).toBeCloseTo(probA.mean, 9);

    // stdev — epistemic uncertainty for that estimate
    expect(typeof probA.stdev, 'baseline probability.stdev type').toBe('number');
    expect(typeof probB.stdev, 'MECE probability.stdev type').toBe('number');
    expect(probB.stdev).toBeCloseTo(probA.stdev, 9);

    // alpha, beta — window-family epistemic Beta shape
    expect(typeof probA.alpha, 'baseline probability.alpha type').toBe('number');
    expect(typeof probB.alpha, 'MECE probability.alpha type').toBe('number');
    expect(typeof probA.beta, 'baseline probability.beta type').toBe('number');
    expect(typeof probB.beta, 'MECE probability.beta type').toBe('number');
    expect(probB.alpha).toBeCloseTo(probA.alpha, 9);
    expect(probB.beta).toBeCloseTo(probA.beta, 9);

    // n_effective (or window_n_effective) — source mass
    const nEffA = probA.n_effective ?? probA.window_n_effective;
    const nEffB = probB.n_effective ?? probB.window_n_effective;
    expect(typeof nEffA, 'baseline n_effective/window_n_effective type').toBe('number');
    expect(typeof nEffB, 'MECE n_effective/window_n_effective type').toBe('number');
    expect(nEffB).toBeCloseTo(nEffA as number, 9);

    // provenance — source-basis label (e.g. analytic_window_baseline)
    expect(typeof probA.provenance, 'baseline probability.provenance type').toBe('string');
    expect(typeof probB.provenance, 'MECE probability.provenance type').toBe('string');
    expect(probB.provenance).toBe(probA.provenance);

    // ── analytic predictive Beta (§3.9 deferral now closed) ──────────────
    // FE topo emits alpha_pred / beta_pred when the per-cohort overdispersion
    // estimator (Pearson chi-squared / quasi-likelihood — Wedderburn 1974,
    // Williams 1975, McCullagh & Nelder 1989 §4.5) produces a finite
    // predictive concentration. Design:
    // docs/current/codebase/EPISTEMIC_DISPERSION_DESIGN.md §6.
    // When emitted, both MECE-equivalent entries must agree on type and
    // produce a positive predictive Beta. When not emitted (degenerate cases:
    // single cohort, boundary mean, infeasible moment-match), both must
    // agree on absence.
    if (probA.alpha_pred !== undefined || probB.alpha_pred !== undefined) {
      expect(typeof probA.alpha_pred, 'baseline alpha_pred type').toBe('number');
      expect(typeof probB.alpha_pred, 'MECE alpha_pred type').toBe('number');
      expect(typeof probA.beta_pred, 'baseline beta_pred type').toBe('number');
      expect(typeof probB.beta_pred, 'MECE beta_pred type').toBe('number');
      expect(probA.alpha_pred as number).toBeGreaterThan(0);
      expect(probB.alpha_pred as number).toBeGreaterThan(0);
      expect(probA.beta_pred as number).toBeGreaterThan(0);
      expect(probB.beta_pred as number).toBeGreaterThan(0);
    } else {
      expect(probA.alpha_pred).toBeUndefined();
      expect(probB.alpha_pred).toBeUndefined();
      expect(probA.beta_pred).toBeUndefined();
      expect(probB.beta_pred).toBeUndefined();
    }

    // ── §3.9 required window/edge-level latency fields ──────────────────
    const latA = analyticA.latency;
    const latB = analyticB.latency;
    expect(latA, 'baseline analytic.latency').toBeDefined();
    expect(latB, 'MECE analytic.latency').toBeDefined();

    const requiredEdgeLatencyKeys = [
      'mu', 'sigma', 't95', 'onset_delta_days',
      'mu_sd', 'sigma_sd', 'onset_sd', 'onset_mu_corr',
    ] as const;
    for (const k of requiredEdgeLatencyKeys) {
      const va = (latA as any)[k];
      const vb = (latB as any)[k];
      expect(typeof va, `baseline analytic.latency.${k} type (§3.9 required)`).toBe('number');
      expect(typeof vb, `MECE analytic.latency.${k} type (§3.9 required)`).toBe('number');
      expect(vb, `analytic.latency.${k} must agree under MECE aggregation`).toBeCloseTo(va as number, 6);
    }
  });
});
