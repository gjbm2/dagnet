/**
 * Bayes vars → canvas info "Forecast" tab — end-to-end mapping.
 *
 * Pins the user-visible contract: every core Bayesian model variable
 * (mean+dispersion of p / μ / σ / onset, for both edge and path) must
 * survive the full pipeline from a bayes upsert event to the values
 * shown on the edge_info "Forecast" tab, for a contexted DSL query.
 *
 * Pipeline exercised end-to-end:
 *   1. Bayes upsert — parameter file carries `posterior.slices` with
 *      `window()` and `cohort()` slices from a real-shape fit.
 *   2. Contexting — `useDSLReaggregation` detects the model_vars[bayesian]
 *      gap and triggers `getParameterFromFile` → `contextProbabilityBlock`,
 *      which picks the right slice given the graph's currentQueryDSL.
 *   3. Promotion — `applyPromotion` projects the active source onto
 *      `p.posterior` (Beta) and `p.latency.posterior` (lognormal), plus
 *      `p.latency.promoted_t95` / `promoted_path_t95`.
 *   4. Display wiring — `getProbabilityPosteriorView` /
 *      `getLatencyPosteriorView` merge those surfaces with bayesian
 *      fit_diagnostics, and `PromotedModelCard` renders the rows.
 *
 * Assertions split into two layers:
 *   • State: every var on `edge.p.posterior`, `edge.p.latency.posterior`,
 *     and the promoted t95 scalars matches the seed slice values exactly.
 *     Catches contexting/promotion bugs that the chart would inherit.
 *   • DOM: the rendered rows in the canvas info card's Forecast tab
 *     display the formatted versions of those same values. Catches
 *     wiring bugs between the promoted surfaces and the rendered UI.
 *
 * Network boundaries are stubbed. No git / no Python BE.
 *
 * @group e2e
 */

import { test, expect, Page } from '@playwright/test';

test.describe.configure({ timeout: 30_000 });

// ── Bayes vars under test ───────────────────────────────────────────────
//
// These slice shapes are what a real fit produces (mu_mean/sigma_mean are
// the posterior means of the log-space lognormal parameters; onset_mean is
// the posterior mean of the shifted-lognormal onset, in days). Values are
// hand-tuned to give visually distinct edge / path curves so that any
// channel-crossing wiring bug surfaces immediately.

const WINDOW_SLICE = {
  // Probability — epistemic Beta posterior on the rate parameter
  alpha: 60,
  beta: 40,
  p_hdi_lower: 0.51,
  p_hdi_upper: 0.69,
  // Latency — lognormal in log-space, posterior means + dispersions
  mu_mean: 2.0,
  mu_sd: 0.08,
  sigma_mean: 0.5,
  sigma_sd: 0.04,
  onset_mean: 3.0,
  onset_sd: 0.5,
  hdi_t95_lower: 18.0,
  hdi_t95_upper: 28.0,
  onset_mu_corr: -0.3,
  // Gate inputs
  ess: 2000,
  rhat: 1.001,
  divergences: 0,
  evidence_grade: 3,
  provenance: 'bayesian',
};

const COHORT_SLICE = {
  alpha: 55,
  beta: 45,
  p_hdi_lower: 0.45,
  p_hdi_upper: 0.65,
  mu_mean: 2.3,
  mu_sd: 0.10,
  sigma_mean: 0.7,
  sigma_sd: 0.06,
  onset_mean: 5.0,
  onset_sd: 0.8,
  hdi_t95_lower: 30.0,
  hdi_t95_upper: 50.0,
  ess: 2200,
  rhat: 1.002,
  divergences: 0,
  evidence_grade: 3,
  provenance: 'bayesian',
};

// Derived expected display values — these MUST be derivable from the
// slice values alone (no fallbacks). If the chart shows anything else,
// the test will catch it.
const EXPECTED = (() => {
  const eSum = WINDOW_SLICE.alpha + WINDOW_SLICE.beta;
  const pSum = COHORT_SLICE.alpha + COHORT_SLICE.beta;
  return {
    edge: {
      pMean: WINDOW_SLICE.alpha / eSum,
      pSd: Math.sqrt((WINDOW_SLICE.alpha * WINDOW_SLICE.beta) / (eSum * eSum * (eSum + 1))),
      mu: WINDOW_SLICE.mu_mean,
      muSd: WINDOW_SLICE.mu_sd,
      sigma: WINDOW_SLICE.sigma_mean,
      sigmaSd: WINDOW_SLICE.sigma_sd,
      onset: WINDOW_SLICE.onset_mean,
      onsetSd: WINDOW_SLICE.onset_sd,
      t95: Math.exp(WINDOW_SLICE.mu_mean + 1.645 * WINDOW_SLICE.sigma_mean) + WINDOW_SLICE.onset_mean,
    },
    path: {
      pMean: COHORT_SLICE.alpha / pSum,
      pSd: Math.sqrt((COHORT_SLICE.alpha * COHORT_SLICE.beta) / (pSum * pSum * (pSum + 1))),
      mu: COHORT_SLICE.mu_mean,
      muSd: COHORT_SLICE.mu_sd,
      sigma: COHORT_SLICE.sigma_mean,
      sigmaSd: COHORT_SLICE.sigma_sd,
      onset: COHORT_SLICE.onset_mean,
      onsetSd: COHORT_SLICE.onset_sd,
      t95: Math.exp(COHORT_SLICE.mu_mean + 1.645 * COHORT_SLICE.sigma_mean) + COHORT_SLICE.onset_mean,
    },
  };
})();

// ── Confounder: legacy analytic source-ledger entry ────────────────────
//
// To exercise actual promotion work, the edge starts with a FULL analytic
// entry that promotion has already projected onto p.posterior and
// p.latency.posterior. Every value is distinct from the bayesian slice
// values above — so any analytic leak through the bayesian-promoted
// surfaces (a missing field-write, a stale L5 scalar, a bad cascade
// ordering) shows up as an assertion failure.

const ANALYTIC_PROB = {
  mean: 0.40,
  stdev: 0.08,
  // Moment-matched Beta(α, β) for (mean=0.40, stdev=0.08).
  //   α+β+1 = mean(1-mean)/var = 0.24/0.0064 = 37.5
  //   α = 0.40 × 36.5 = 14.6, β = 0.60 × 36.5 = 21.9
  alpha: 14.6,
  beta: 21.9,
  n_effective: 36.5,
  provenance: 'analytic_window_baseline',
  cohort_alpha: 14.0,
  cohort_beta: 21.0,
  cohort_n_effective: 35.0,
  cohort_provenance: 'analytic_cohort_baseline',
};
const ANALYTIC_LAT = {
  mu: 1.5,
  sigma: 0.4,
  t95: Math.exp(1.5 + 1.645 * 0.4) + 2.0,
  onset_delta_days: 2.0,
  mu_sd: 0.05,
  sigma_sd: 0.03,
  onset_sd: 0.2,
  path_mu: 1.8,
  path_sigma: 0.5,
  path_t95: Math.exp(1.8 + 1.645 * 0.5) + 4.0,
  path_onset_delta_days: 4.0,
  path_mu_sd: 0.08,
  path_sigma_sd: 0.04,
  path_onset_sd: 0.3,
};

// ── Workspace fixtures ──────────────────────────────────────────────────

const REPO = 'repo-1';
const BRANCH = 'main';
const GRAPH_FILE_ID = 'graph-bayes-vars-test';
const GRAPH_NAME = 'bayes-vars-test';
const PARAM_ID = 'edge-a-b';
const EDGE_UUID = 'edge-a-b-uuid';

function makeGraphData(opts: { fittedAt: string }) {
  return {
    nodes: [
      { uuid: 'n-a', id: 'a', label: 'A' },
      { uuid: 'n-b', id: 'b', label: 'B' },
    ],
    edges: [
      {
        uuid: EDGE_UUID,
        id: EDGE_UUID,
        from: 'a',
        to: 'b',
        p: {
          id: PARAM_ID,
          mean: 0.5,
          type: 'probability',
          // Seed a FULL analytic entry — Beta + latency, distinct values —
          // so that on initial boot, promotion projects analytic onto
          // p.posterior + p.latency.posterior, and the later drift-driven
          // bayesian arrival must actively DISPLACE every field. The
          // assertions below verify nothing analytic leaks through.
          model_vars: [
            {
              source: 'analytic',
              source_at: '2026-04-01T00:00:00Z',
              probability: ANALYTIC_PROB,
              latency: ANALYTIC_LAT,
              quality: { gate_passed: true },
            },
          ],
          // latency_parameter MUST be true for the contexting path to
          // emit a latency block on model_vars[bayesian].
          latency: { latency_parameter: true },
        },
      },
    ],
    currentQueryDSL: 'window(1-Jan-26:31-Jan-26)',
    baseDSL: 'window(1-Jan-26:31-Jan-26)',
    metadata: { name: GRAPH_NAME, version: '1.0.0' },
    policies: { default_outcome: 'end' },
    // Seed a pinned canvas-analysis object showing edge_info Model
    // (forecast) tab for this edge. This renders PromotedModelCard
    // directly on the canvas — no hover required.
    canvasAnalyses: [
      {
        id: 'analysis-bayes-vars',
        x: 400,
        y: 100,
        width: 360,
        height: 260,
        content_items: [
          {
            id: 'ci-forecast',
            analysis_type: 'edge_info',
            view_type: 'cards',
            kind: 'forecast',
            analytics_dsl: 'from(a).to(b)',
            mode: 'live',
          },
        ],
      },
    ],
  };
}

function makeParamFileData(opts: { fittedAt: string; fingerprint: string }) {
  return {
    id: PARAM_ID,
    name: PARAM_ID,
    type: 'probability',
    query: 'from(a).to(b)',
    query_overridden: false,
    values: [
      {
        mean: WINDOW_SLICE.alpha / (WINDOW_SLICE.alpha + WINDOW_SLICE.beta),
        stdev: 0.05,
        distribution: 'beta',
        window_from: '2026-01-01',
        window_to: '2026-01-31',
        sliceDSL: 'window(2026-01-01:2026-01-31)',
      },
    ],
    posterior: {
      fitted_at: opts.fittedAt,
      fingerprint: opts.fingerprint,
      hdi_level: 0.9,
      prior_tier: 'warm_start',
      slices: {
        'window()': WINDOW_SLICE,
        'cohort()': COHORT_SLICE,
      },
    },
    metadata: {
      description: '',
      constraints: { discrete: false },
      tags: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-05-12T00:00:00Z',
      author: 'e2e',
      version: '1.0.0',
      status: 'active',
      aliases: [],
      references: [],
    },
  };
}

// ── Network stubs ───────────────────────────────────────────────────────

async function installNetworkStubs(page: Page) {
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({ status: 404, body: '{}' }),
  );
  // Conditioned-forecast endpoint must return real CF scenarios so
  // `applyConditionedForecastToGraph` fires — that's the path that, before
  // the fix, wiped `model_vars[analytic].latency` to undefined via
  // `UpdateManager.applyBatchLAGValues`. Returning a non-empty scenario
  // with valid `p_mean` triggers the apply path.
  await page.route('**/api/forecast/conditioned', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        scenarios: [{
          scenario_id: 'current',
          success: true,
          edges: [{
            edge_uuid: EDGE_UUID,
            p_mean: 0.62,
            p_sd: 0.05,
            p_sd_epistemic: 0.045,
            completeness: 0.78,
            completeness_sd: 0.06,
            evidence_n: 1000,
            evidence_k: 620,
            conditioned: true,
          }],
        }],
      }),
    }),
  );
  // Catch-all for any other 127.0.0.1:9000 compute calls.
  await page.route('**://127.0.0.1:9000/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' }),
  );
}

// ── Seeding ─────────────────────────────────────────────────────────────

async function seedWorkspace(page: Page, opts: { fittedAt: string; fingerprint: string }) {
  await page.evaluate(
    async ({ opts, GRAPH_FILE_ID, GRAPH_NAME, REPO, BRANCH, PARAM_ID, graphData, paramFile }: any) => {
      const db = (window as any).db;
      if (!db) throw new Error('window.db missing');

      if (db.workspaces?.put) {
        await db.workspaces.put({
          id: `${REPO}-${BRANCH}`,
          repository: REPO,
          branch: BRANCH,
          lastOpenedAt: Date.now(),
          files: [],
        });
      }

      if (db.appState?.put) {
        await db.appState.put({
          id: 'app-state',
          navigatorState: {
            isOpen: true,
            isPinned: true,
            searchQuery: '',
            selectedRepo: REPO,
            selectedBranch: BRANCH,
            expandedSections: [],
            availableRepos: [REPO],
            availableBranches: [BRANCH],
          },
          updatedAt: Date.now(),
        });
      }

      await db.files.put({
        fileId: GRAPH_FILE_ID,
        type: 'graph',
        viewTabs: [],
        data: graphData,
        source: { repository: REPO, branch: BRANCH, path: `graphs/${GRAPH_FILE_ID}.json` },
        isDirty: false,
        lastModified: Date.now(),
      });

      await db.files.put({
        fileId: `parameter-${PARAM_ID}`,
        type: 'parameter',
        viewTabs: [],
        data: paramFile,
        source: { repository: REPO, branch: BRANCH, path: `parameters/${PARAM_ID}.yaml` },
        isDirty: false,
        lastModified: Date.now(),
      });

      await db.files.put({
        fileId: 'parameter-index',
        type: 'index',
        viewTabs: [],
        data: { parameters: [{ id: PARAM_ID, file_path: `parameters/${PARAM_ID}.yaml` }] },
        source: { repository: REPO, branch: BRANCH, path: 'parameters-index.yaml' },
        isDirty: false,
        lastModified: Date.now(),
      });

      // Live-mode canvas-analysis compute requires editorState.scenarioState
      // — without it the prepare service blocks with
      // `live_scenario_state_missing` and the card never renders.
      await db.tabs.put({
        id: 'tab-graph-1',
        fileId: GRAPH_FILE_ID,
        viewMode: 'interactive',
        title: GRAPH_NAME,
        icon: '',
        closable: true,
        group: 'main-content',
        editorState: {
          scenarioState: {
            visibleScenarioIds: ['current'],
            scenarioOrder: ['current'],
            visibleColourOrderIds: ['current'],
            visibilityMode: {},
          },
        },
      });

      if (typeof db.saveAppState === 'function') {
        await db.saveAppState({ activeTabId: 'tab-graph-1', updatedAt: Date.now() });
      }
    },
    {
      opts,
      GRAPH_FILE_ID,
      GRAPH_NAME,
      REPO,
      BRANCH,
      PARAM_ID,
      graphData: makeGraphData({ fittedAt: opts.fittedAt }),
      paramFile: makeParamFileData({ fittedAt: opts.fittedAt, fingerprint: opts.fingerprint }),
    },
  );
}

async function seedFileRegistry(page: Page, opts: { fittedAt: string; fingerprint: string }) {
  await page.evaluate(
    async ({ GRAPH_FILE_ID, REPO, BRANCH, PARAM_ID, graphData, paramFile }: any) => {
      const fr = (window as any).fileRegistry;
      if (!fr?.registerFile) throw new Error('fileRegistry.registerFile not exposed (need ?e2e=1)');

      await fr.registerFile(`parameter-${PARAM_ID}`, {
        fileId: `parameter-${PARAM_ID}`,
        type: 'parameter',
        viewTabs: [],
        data: paramFile,
        source: { repository: REPO, branch: BRANCH, path: `parameters/${PARAM_ID}.yaml` },
        isDirty: false,
        lastModified: Date.now(),
      });

      await fr.registerFile('parameter-index', {
        fileId: 'parameter-index',
        type: 'index',
        viewTabs: [],
        data: { parameters: [{ id: PARAM_ID, file_path: `parameters/${PARAM_ID}.yaml` }] },
        source: { repository: REPO, branch: BRANCH, path: 'parameters-index.yaml' },
        isDirty: false,
        lastModified: Date.now(),
      });

      await fr.registerFile(GRAPH_FILE_ID, {
        fileId: GRAPH_FILE_ID,
        type: 'graph',
        viewTabs: [],
        data: graphData,
        source: { repository: REPO, branch: BRANCH, path: `graphs/${GRAPH_FILE_ID}.json` },
        isDirty: false,
        lastModified: Date.now(),
      });
    },
    {
      GRAPH_FILE_ID,
      REPO,
      BRANCH,
      PARAM_ID,
      graphData: makeGraphData({ fittedAt: opts.fittedAt }),
      paramFile: makeParamFileData({ fittedAt: opts.fittedAt, fingerprint: opts.fingerprint }),
    },
  );
}

// ── State reader ────────────────────────────────────────────────────────

async function readEdgeState(page: Page) {
  return page.evaluate(({ GRAPH_FILE_ID, EDGE_UUID }: any) => {
    const getStore = (window as any).__dagnet_getGraphStore;
    const store = getStore?.(GRAPH_FILE_ID);
    const graph = store?.getState()?.graph;
    const edge = graph?.edges?.find((e: any) => e.uuid === EDGE_UUID);
    if (!edge) return null;
    const bayesEntry = edge.p?.model_vars?.find((mv: any) => mv?.source === 'bayesian');
    const analyticEntry = edge.p?.model_vars?.find((mv: any) => mv?.source === 'analytic');
    return {
      forecastSource: edge.p?.forecast?.source,
      forecastMean: edge.p?.forecast?.mean,
      posterior: edge.p?.posterior,
      latencyPosterior: edge.p?.latency?.posterior,
      // L5 scalars that applyPromotion writes alongside the posterior
      // surfaces — both must switch to bayesian values, not retain
      // analytic ones.
      promotedT95: edge.p?.latency?.promoted_t95,
      promotedPathT95: edge.p?.latency?.promoted_path_t95,
      latMu: edge.p?.latency?.mu,
      latSigma: edge.p?.latency?.sigma,
      latPathMu: edge.p?.latency?.path_mu,
      latPathSigma: edge.p?.latency?.path_sigma,
      latPathOnset: edge.p?.latency?.path_onset_delta_days,
      bayesEntryLatency: bayesEntry?.latency,
      bayesEntryProb: bayesEntry?.probability,
      analyticEntryLatency: analyticEntry?.latency,
      analyticEntryProb: analyticEntry?.probability,
    };
  }, { GRAPH_FILE_ID, EDGE_UUID });
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('Bayes vars → canvas info Forecast tab', () => {
  test('every core bayes var flows from upsert through contexting/promotion to display', async ({ page, baseURL }) => {
    const fittedAt = '2026-05-13T12:00:00Z';
    const fingerprint = 'fp-bayes-vars-test';

    await installNetworkStubs(page);

    await page.goto(
      new URL(`/?e2e=1&secret=test-secret&repo=${REPO}&branch=${BRANCH}&graph=${GRAPH_NAME}`, baseURL!).toString(),
      { waitUntil: 'domcontentloaded' },
    );

    await seedWorkspace(page, { fittedAt, fingerprint });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 15_000 });
    await seedFileRegistry(page, { fittedAt, fingerprint });

    // Wait for the drift detector → contexting → promotion chain to land
    // the bayesian projection on the edge.
    await expect
      .poll(
        async () => {
          const s = await readEdgeState(page);
          return s?.forecastSource === 'bayesian' && s?.posterior?.alpha === WINDOW_SLICE.alpha;
        },
        { timeout: 15_000, message: 'bayesian projection should land on edge after drift-triggered fetch' },
      )
      .toBe(true);

    const state = await readEdgeState(page);
    expect(state).not.toBeNull();

    // ─────────────────────────────────────────────────────────────────
    // STATE assertions — every bayes var maps to its promoted surface
    // ─────────────────────────────────────────────────────────────────

    // Promotion chose bayesian (best_available with gate passed)
    expect(state!.forecastSource).toBe('bayesian');

    // ── Probability (Beta) — window + cohort ──
    expect(state!.posterior.distribution).toBe('beta');
    expect(state!.posterior.alpha).toBe(WINDOW_SLICE.alpha);
    expect(state!.posterior.beta).toBe(WINDOW_SLICE.beta);
    expect(state!.posterior.cohort_alpha).toBe(COHORT_SLICE.alpha);
    expect(state!.posterior.cohort_beta).toBe(COHORT_SLICE.beta);

    // ── Latency (lognormal) — edge means + dispersions ──
    expect(state!.latencyPosterior.distribution).toBe('lognormal');
    expect(state!.latencyPosterior.mu_mean).toBeCloseTo(WINDOW_SLICE.mu_mean, 6);
    expect(state!.latencyPosterior.sigma_mean).toBeCloseTo(WINDOW_SLICE.sigma_mean, 6);
    expect(state!.latencyPosterior.onset_delta_days).toBeCloseTo(WINDOW_SLICE.onset_mean, 6);
    expect(state!.latencyPosterior.mu_sd).toBeCloseTo(WINDOW_SLICE.mu_sd, 6);
    expect(state!.latencyPosterior.sigma_sd).toBeCloseTo(WINDOW_SLICE.sigma_sd, 6);
    expect(state!.latencyPosterior.onset_sd).toBeCloseTo(WINDOW_SLICE.onset_sd, 6);

    // ── Latency (lognormal) — path means + dispersions ──
    expect(state!.latencyPosterior.path_mu_mean).toBeCloseTo(COHORT_SLICE.mu_mean, 6);
    expect(state!.latencyPosterior.path_sigma_mean).toBeCloseTo(COHORT_SLICE.sigma_mean, 6);
    expect(state!.latencyPosterior.path_onset_delta_days).toBeCloseTo(COHORT_SLICE.onset_mean, 6);
    expect(state!.latencyPosterior.path_mu_sd).toBeCloseTo(COHORT_SLICE.mu_sd, 6);
    expect(state!.latencyPosterior.path_sigma_sd).toBeCloseTo(COHORT_SLICE.sigma_sd, 6);
    expect(state!.latencyPosterior.path_onset_sd).toBeCloseTo(COHORT_SLICE.onset_sd, 6);

    // ── Promoted t95 scalars — self-consistent with μ/σ/onset ──
    expect(state!.promotedT95).toBeCloseTo(EXPECTED.edge.t95, 4);
    expect(state!.promotedPathT95).toBeCloseTo(EXPECTED.path.t95, 4);

    // ── Source-ledger entry (the per-source view the edge-props
    //    ModelCard reads) must carry the same values verbatim ──
    expect(state!.bayesEntryProb.alpha).toBe(WINDOW_SLICE.alpha);
    expect(state!.bayesEntryProb.beta).toBe(WINDOW_SLICE.beta);
    expect(state!.bayesEntryProb.cohort_alpha).toBe(COHORT_SLICE.alpha);
    expect(state!.bayesEntryProb.cohort_beta).toBe(COHORT_SLICE.beta);
    expect(state!.bayesEntryLatency.mu).toBeCloseTo(WINDOW_SLICE.mu_mean, 6);
    expect(state!.bayesEntryLatency.sigma).toBeCloseTo(WINDOW_SLICE.sigma_mean, 6);
    expect(state!.bayesEntryLatency.onset_delta_days).toBeCloseTo(WINDOW_SLICE.onset_mean, 6);
    expect(state!.bayesEntryLatency.path_mu).toBeCloseTo(COHORT_SLICE.mu_mean, 6);
    expect(state!.bayesEntryLatency.path_sigma).toBeCloseTo(COHORT_SLICE.sigma_mean, 6);
    expect(state!.bayesEntryLatency.path_onset_delta_days).toBeCloseTo(COHORT_SLICE.onset_mean, 6);

    // ── Analytic entry must be PRESERVED on the source ledger. Promotion
    //    must not delete other sources — the user can flip the preference
    //    back to analytic at any time. Specific seed values aren't pinned
    //    here (enhanceGraphLatencies derives analytic.latency.* live during
    //    FE topo), but EVERY field must remain a defined number after CF
    //    has run. The CF apply path must not wipe `model_vars[*]` — only
    //    FE topo and file-fetch are allowed to mutate the source ledger.
    expect(state!.analyticEntryProb).toBeDefined();
    expect(state!.analyticEntryLatency).toBeDefined();
    // Edge-level latency fields the FE topo always derives. Before the
    // CF→model_vars fix, CF's call through applyBatchLAGValues with no
    // (mu, sigma, ...) in the payload wiped these to `undefined`.
    expect(typeof state!.analyticEntryLatency.mu).toBe('number');
    expect(typeof state!.analyticEntryLatency.sigma).toBe('number');
    expect(typeof state!.analyticEntryLatency.onset_delta_days).toBe('number');
    expect(typeof state!.analyticEntryLatency.mu_sd).toBe('number');
    expect(typeof state!.analyticEntryLatency.sigma_sd).toBe('number');
    expect(typeof state!.analyticEntryLatency.onset_sd).toBe('number');
    // Path-level point estimates are present on this single-latency edge
    // via the topology's path-identity invariant.
    expect(typeof state!.analyticEntryLatency.path_mu).toBe('number');
    expect(typeof state!.analyticEntryLatency.path_sigma).toBe('number');
    expect(typeof state!.analyticEntryLatency.path_onset_delta_days).toBe('number');
    // path_*_sd dispersions are not derived for the analytic source
    // (they're a Bayesian-cohort thing), so we don't assert them.

    // ── L5 scalars (p.latency.mu / .sigma / .path_*) must carry the bayes
    //    values. applyPromotion writes these unconditionally from the active
    //    source; a missed write would retain the analytic-derived values
    //    that were there before drift triggered re-promotion.
    expect(state!.latMu).toBeCloseTo(WINDOW_SLICE.mu_mean, 6);
    expect(state!.latSigma).toBeCloseTo(WINDOW_SLICE.sigma_mean, 6);
    expect(state!.latPathMu).toBeCloseTo(COHORT_SLICE.mu_mean, 6);
    expect(state!.latPathSigma).toBeCloseTo(COHORT_SLICE.sigma_mean, 6);
    expect(state!.latPathOnset).toBeCloseTo(COHORT_SLICE.onset_mean, 6);

    // ── Forecast scalar: promoted mean = α/(α+β) of bayesian.
    expect(state!.forecastMean).toBeCloseTo(EXPECTED.edge.pMean, 6);

    // ─────────────────────────────────────────────────────────────────
    // DOM assertions — what PromotedModelCard actually renders
    // ─────────────────────────────────────────────────────────────────
    //
    // The graph carries a pinned canvas-analysis object of type
    // `edge_info` with `kind: 'forecast'` — this renders the Model tab
    // (PromotedModelCard) directly on the canvas, no hover required.
    // Each row carries `data-testid` of form
    // `pmcard-{edge|path}-{p|mu|sigma|onset}`.

    // The canvas-analysis node spinners on "Loading chart dependencies…"
    // while React.lazy resolves the chart/info-card bundle. Wait for the
    // spinner to clear before reading content.
    await expect(page.locator('.canvas-analysis-node').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=Loading chart dependencies')).toHaveCount(0, { timeout: 30_000 });

    // Source header confirms the canvas card is up and that promotion
    // selected bayesian.
    await expect(page.getByTestId('pmcard-source-header')).toContainText('Bayesian', { timeout: 15_000 });

    // Format helpers mirror PromotedModelCard's fmtPct / fmt(_, 3) / fmt(_, 1)
    const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;
    const f3 = (v: number) => v.toFixed(3);
    const f1 = (v: number) => v.toFixed(1);

    // Edge column
    await expect(page.getByTestId('pmcard-edge-p')).toContainText(
      `${pct1(EXPECTED.edge.pMean)} ± ${pct1(EXPECTED.edge.pSd)}`,
    );
    await expect(page.getByTestId('pmcard-edge-mu')).toContainText(
      `${f3(EXPECTED.edge.mu)} ± ${f3(EXPECTED.edge.muSd)}`,
    );
    await expect(page.getByTestId('pmcard-edge-sigma')).toContainText(
      `${f3(EXPECTED.edge.sigma)} ± ${f3(EXPECTED.edge.sigmaSd)}`,
    );
    await expect(page.getByTestId('pmcard-edge-onset')).toContainText(
      `${f1(EXPECTED.edge.onset)}d ± ${f1(EXPECTED.edge.onsetSd)}d`,
    );

    // Path column
    await expect(page.getByTestId('pmcard-path-p')).toContainText(
      `${pct1(EXPECTED.path.pMean)} ± ${pct1(EXPECTED.path.pSd)}`,
    );
    await expect(page.getByTestId('pmcard-path-mu')).toContainText(
      `${f3(EXPECTED.path.mu)} ± ${f3(EXPECTED.path.muSd)}`,
    );
    await expect(page.getByTestId('pmcard-path-sigma')).toContainText(
      `${f3(EXPECTED.path.sigma)} ± ${f3(EXPECTED.path.sigmaSd)}`,
    );
    await expect(page.getByTestId('pmcard-path-onset')).toContainText(
      `${f1(EXPECTED.path.onset)}d ± ${f1(EXPECTED.path.onsetSd)}d`,
    );
  });
});
