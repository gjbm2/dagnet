/**
 * Bayes projection — on graph load (α) and after a clean merge (β).
 *
 * Pins the user-visible behaviour the refactor was meant to fix:
 *
 *   α. Boot a workspace where parameter files carry healthy
 *      `posterior.slices` but the graph file's edges have no
 *      `model_vars[bayesian]` entry (the exact state we caught in the
 *      diag dump on F5 — `modelVarsSources_BEFORE: ["analytic"]` on
 *      every paramId-bearing edge). The drift check in
 *      `useDSLReaggregation` must detect the gap and run a fetch via
 *      the established `fetchItems → getParameterFromFile` path, which
 *      now projects bayes. The edges must end up with bayesian source
 *      ledger entries and `p.forecast.source === 'bayesian'`.
 *
 *   β. Boot a workspace where everything is in sync. Then simulate a
 *      clean post-merge file update by calling `fileRegistry.updateFile`
 *      with a fresh `posterior.fitted_at` for one parameter file. The
 *      β subscription in `useDSLReaggregation` must fire only for the
 *      edge referencing that paramId, project the new posterior, and
 *      leave the other edges untouched.
 *
 * Network boundaries are intercepted. No git / no Python BE.
 *
 * @group e2e
 */

import { test, expect, Page } from '@playwright/test';

test.describe.configure({ timeout: 30_000 });

// ── Fixtures ────────────────────────────────────────────────────────────

const REPO = 'repo-1';
const BRANCH = 'main';
const GRAPH_FILE_ID = 'graph-e2e-bayes-drift';
const GRAPH_NAME = 'e2e-bayes-drift';

const PARAM_IDS = ['edge-a-b', 'edge-b-c'] as const;
type ParamId = typeof PARAM_IDS[number];

const HEALTHY_WINDOW_SLICE = {
  alpha: 400, beta: 84,
  p_hdi_lower: 0.80, p_hdi_upper: 0.85,
  ess: 11000, rhat: 1.001, divergences: 0,
  evidence_grade: 3, provenance: 'bayesian',
  mu_mean: 2.26, mu_sd: 0.05, sigma_mean: 0.67, sigma_sd: 0.03,
  onset_mean: 0.5, onset_sd: 0.1,
  hdi_t95_lower: 26.0, hdi_t95_upper: 33.0,
};

const HEALTHY_COHORT_SLICE = {
  alpha: 392, beta: 83,
  p_hdi_lower: 0.80, p_hdi_upper: 0.86,
  ess: 13000, rhat: 1.001, divergences: 0,
  evidence_grade: 3, provenance: 'bayesian',
  mu_mean: -1.23, mu_sd: 0.24, sigma_mean: 2.90, sigma_sd: 0.14,
  onset_mean: 0.48, onset_sd: 0.18,
  hdi_t95_lower: 29.0, hdi_t95_upper: 41.0,
};

function makeGraphData(opts: { withBayesianOnEdges: boolean; fittedAt: string; fingerprint: string }) {
  const bayesianEntry = opts.withBayesianOnEdges
    ? {
        source: 'bayesian',
        source_at: opts.fittedAt,
        probability: {
          mean: 400 / (400 + 84), stdev: 0.02,
          alpha: 400, beta: 84,
        },
        quality: {
          rhat: 1.001, ess: 11000, divergences: 0,
          evidence_grade: 3, gate_passed: true,
        },
        fit_diagnostics: {
          probability: { fitted_at: opts.fittedAt, fingerprint: opts.fingerprint },
        },
      }
    : null;

  const makeEdge = (uuid: string, from: string, to: string, paramId: string) => ({
    uuid, id: uuid, from, to,
    p: {
      id: paramId, mean: 0.5, type: 'probability',
      model_vars: [
        // Always seed an analytic entry so promotion has something to fall
        // back to. This mirrors a saved-graph that ran analytic at some
        // point in the past.
        {
          source: 'analytic',
          source_at: '2026-04-01T00:00:00Z',
          probability: { mean: 0.4, stdev: 0.05 },
          quality: { gate_passed: true },
        },
        ...(bayesianEntry ? [bayesianEntry] : []),
      ],
    },
  });

  return {
    nodes: [
      { uuid: 'n-a', id: 'a', label: 'A' },
      { uuid: 'n-b', id: 'b', label: 'B' },
      { uuid: 'n-c', id: 'c', label: 'C' },
    ],
    edges: [
      makeEdge('edge-a-b-uuid', 'a', 'b', 'edge-a-b'),
      makeEdge('edge-b-c-uuid', 'b', 'c', 'edge-b-c'),
    ],
    currentQueryDSL: 'window(1-Jan-26:31-Jan-26)',
    baseDSL: 'window(1-Jan-26:31-Jan-26)',
    metadata: { name: GRAPH_NAME, version: '1.0.0' },
    policies: { default_outcome: 'end' },
  };
}

function makeParamFileData(opts: { paramId: ParamId; fittedAt: string; fingerprint: string }) {
  return {
    id: opts.paramId,
    name: opts.paramId,
    type: 'probability',
    query: `from(${opts.paramId.split('-')[1]}).to(${opts.paramId.split('-')[2]})`,
    query_overridden: false,
    values: [{
      mean: 0.83, stdev: 0.02, distribution: 'beta',
      window_from: '2026-01-01', window_to: '2026-01-31',
      sliceDSL: 'window(2026-01-01:2026-01-31)',
    }],
    posterior: {
      fitted_at: opts.fittedAt,
      fingerprint: opts.fingerprint,
      hdi_level: 0.9,
      prior_tier: 'warm_start',
      slices: {
        'window()': HEALTHY_WINDOW_SLICE,
        'cohort()': HEALTHY_COHORT_SLICE,
      },
    },
    metadata: {
      description: '', constraints: { discrete: false }, tags: [],
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-05-12T00:00:00Z',
      author: 'e2e', version: '1.0.0', status: 'active', aliases: [], references: [],
    },
  };
}

// ── Stubs ───────────────────────────────────────────────────────────────

async function installNetworkStubs(page: Page) {
  // Block any accidental GitHub call — the workspace is seeded directly in
  // IDB and the test must not hit the real API.
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({ status: 404, body: '{}' }),
  );
  // Compute API — drift-driven fetch uses from-file mode so this should
  // not be invoked, but stub it for safety.
  await page.route('**://127.0.0.1:9000/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' }),
  );
}

// ── Seeding ─────────────────────────────────────────────────────────────

async function seedWorkspace(
  page: Page,
  opts: { graphHasBayesian: boolean; fittedAt: string; fingerprint: string },
) {
  await page.evaluate(async ({ opts, GRAPH_FILE_ID, GRAPH_NAME, REPO, BRANCH, PARAM_IDS, graphData, paramFiles }: any) => {
    const db = (window as any).db;
    if (!db) throw new Error('window.db missing');

    // Workspace record so NavigatorContext picks up the right repo/branch.
    if (db.workspaces?.put) {
      await db.workspaces.put({
        id: `${REPO}-${BRANCH}`,
        repository: REPO,
        branch: BRANCH,
        lastOpenedAt: Date.now(),
        files: [],
      });
    }

    // Navigator state — selects the workspace on app boot so
    // workspaceService.loadWorkspaceFromIDB runs and hydrates the files
    // we seeded below.
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

    // Graph file
    await db.files.put({
      fileId: GRAPH_FILE_ID,
      type: 'graph',
      viewTabs: [],
      data: graphData,
      source: { repository: REPO, branch: BRANCH, path: `graphs/${GRAPH_FILE_ID}.json` },
      isDirty: false,
      lastModified: Date.now(),
    });

    // Parameter files
    for (let i = 0; i < PARAM_IDS.length; i++) {
      const paramId = PARAM_IDS[i];
      await db.files.put({
        fileId: `parameter-${paramId}`,
        type: 'parameter',
        viewTabs: [],
        data: paramFiles[i],
        source: { repository: REPO, branch: BRANCH, path: `parameters/${paramId}.yaml` },
        isDirty: false,
        lastModified: Date.now(),
      });
    }

    // Parameter index (so registry lookups don't warn).
    await db.files.put({
      fileId: 'parameter-index',
      type: 'index',
      viewTabs: [],
      data: {
        parameters: PARAM_IDS.map((id: string) => ({
          id, file_path: `parameters/${id}.yaml`,
        })),
      },
      source: { repository: REPO, branch: BRANCH, path: 'parameters-index.yaml' },
      isDirty: false,
      lastModified: Date.now(),
    });

    // Open a tab for the graph.
    await db.tabs.put({
      id: 'tab-graph-1',
      fileId: GRAPH_FILE_ID,
      viewMode: 'interactive',
      title: GRAPH_NAME,
      icon: '',
      closable: true,
      group: 'main-content',
    });

    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ activeTabId: 'tab-graph-1', updatedAt: Date.now() });
    }
  }, {
    opts, GRAPH_FILE_ID, GRAPH_NAME, REPO, BRANCH, PARAM_IDS: [...PARAM_IDS],
    graphData: makeGraphData({
      withBayesianOnEdges: opts.graphHasBayesian,
      fittedAt: opts.fittedAt,
      fingerprint: opts.fingerprint,
    }),
    paramFiles: PARAM_IDS.map(id => makeParamFileData({ paramId: id, fittedAt: opts.fittedAt, fingerprint: opts.fingerprint })),
  });
}

async function seedFileRegistry(
  page: Page,
  opts: { graphHasBayesian: boolean; fittedAt: string; fingerprint: string },
) {
  await page.evaluate(async ({ GRAPH_FILE_ID, REPO, BRANCH, PARAM_IDS, graphData, paramFiles }: any) => {
    const fr = (window as any).fileRegistry;
    if (!fr?.registerFile) throw new Error('fileRegistry.registerFile not exposed (need ?e2e=1)');

    // Parameter files first — so when the graph registers and
    // useDSLReaggregation mounts, the drift check finds them.
    for (let i = 0; i < PARAM_IDS.length; i++) {
      const paramId = PARAM_IDS[i];
      await fr.registerFile(`parameter-${paramId}`, {
        fileId: `parameter-${paramId}`,
        type: 'parameter',
        viewTabs: [],
        data: paramFiles[i],
        source: { repository: REPO, branch: BRANCH, path: `parameters/${paramId}.yaml` },
        isDirty: false,
        lastModified: Date.now(),
      });
    }

    await fr.registerFile('parameter-index', {
      fileId: 'parameter-index',
      type: 'index',
      viewTabs: [],
      data: {
        parameters: PARAM_IDS.map((id: string) => ({ id, file_path: `parameters/${id}.yaml` })),
      },
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
  }, {
    GRAPH_FILE_ID, REPO, BRANCH, PARAM_IDS: [...PARAM_IDS],
    graphData: makeGraphData({
      withBayesianOnEdges: opts.graphHasBayesian,
      fittedAt: opts.fittedAt,
      fingerprint: opts.fingerprint,
    }),
    paramFiles: PARAM_IDS.map(id => makeParamFileData({ paramId: id, fittedAt: opts.fittedAt, fingerprint: opts.fingerprint })),
  });
}

// ── Assertion helpers ───────────────────────────────────────────────────

async function readEdgeBayesState(page: Page) {
  // Read from the live GraphStore, not IDB — drift writes to the store
  // via `setGraph`; IDB sync is best-effort and lags behind.
  return page.evaluate(({ GRAPH_FILE_ID }: any) => {
    const getStore = (window as any).__dagnet_getGraphStore;
    const store = getStore?.(GRAPH_FILE_ID);
    const graph = store?.getState()?.graph;
    const edges = graph?.edges ?? [];
    return edges.map((e: any) => {
      const bayes = (e.p?.model_vars ?? []).find((mv: any) => mv?.source === 'bayesian');
      return {
        uuid: e.uuid,
        paramId: e.p?.id,
        hasBayesian: !!bayes,
        gatePassed: bayes?.quality?.gate_passed === true,
        fittedAt: bayes?.fit_diagnostics?.probability?.fitted_at,
        fingerprint: bayes?.fit_diagnostics?.probability?.fingerprint,
        forecastSource: e.p?.forecast?.source,
        pPostAlpha: e.p?.posterior?.alpha,
      };
    });
  }, { GRAPH_FILE_ID });
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe('Bayes projection on load (α) and after merge (β)', () => {

  test('α: boot with stale-bayes graph reconciles to bayesian projection', async ({ page, baseURL }) => {
    await installNetworkStubs(page);

    // Boot to init IDB and seed credentials from the env-provided test secret.
    await page.goto(
      new URL(`/?e2e=1&secret=test-secret&repo=${REPO}&branch=${BRANCH}&graph=${GRAPH_NAME}`, baseURL!).toString(),
      { waitUntil: 'domcontentloaded' },
    );

    // Seed: graph edges have analytic-only model_vars; parameter files have
    // fresh posteriors with healthy slices. This is the exact failure state
    // we observed on F5 with `modelVarsSources_BEFORE: ["analytic"]` on
    // every paramId-bearing edge.
    await seedWorkspace(page, {
      graphHasBayesian: false,
      fittedAt: '2026-05-12T07:06:14Z',
      fingerprint: 'fp-load',
    });

    // Reload to drive normal hydration paths (workspace mount → graph load →
    // useDSLReaggregation mount → drift check).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 15_000 });

    // Workspace auto-load from IDB populates fileRegistry via a fast path
    // that bypasses notifyListeners (workspaceService.loadWorkspaceFromIDB
    // line 1376 directly sets the internal Map). The β subscription pattern
    // therefore can't observe those arrivals. We re-register the files via
    // `fileRegistry.registerFile` — same approach as the existing
    // `enhancedSelectorStaleGraph.spec.ts` regression test — which both
    // ensures the files are present and fires `notifyListeners` so β can
    // exercise its subscription path.
    await seedFileRegistry(page, {
      graphHasBayesian: false,
      fittedAt: '2026-05-12T07:06:14Z',
      fingerprint: 'fp-load',
    });

    // Pre-condition snapshot.
    const before = await readEdgeBayesState(page);
    expect(before).toHaveLength(2);
    expect(before.every((e: any) => e.paramId)).toBe(true);

    // The drift check should have fired by mount, run fetchItems for both
    // edges, and each fetch should have projected bayes via the unified
    // getParameterFromFile path. Poll until both edges show bayesian.
    await expect.poll(
      async () => {
        const state = await readEdgeBayesState(page);
        return state.every((e: any) => e.hasBayesian && e.gatePassed);
      },
      {
        message: 'all edges should have model_vars[bayesian] with gate_passed=true after drift-triggered fetch',
        timeout: 15_000,
      },
    ).toBe(true);

    const after = await readEdgeBayesState(page);
    for (const e of after) {
      expect(e.fittedAt).toBe('2026-05-12T07:06:14Z');
      expect(e.fingerprint).toBe('fp-load');
      // Promotion picks bayesian when gate passes — p.forecast.source flips.
      expect(e.forecastSource).toBe('bayesian');
      // p.posterior was projected from the slice library.
      expect(e.pPostAlpha).toBe(400);
    }
  });

  test('β: clean post-merge file update triggers per-edge re-projection', async ({ page, baseURL }) => {
    await installNetworkStubs(page);

    await page.goto(
      new URL(`/?e2e=1&secret=test-secret&repo=${REPO}&branch=${BRANCH}&graph=${GRAPH_NAME}`, baseURL!).toString(),
      { waitUntil: 'domcontentloaded' },
    );

    // Seed: graph and files are in sync at fitted_at = T1.
    await seedWorkspace(page, {
      graphHasBayesian: true,
      fittedAt: '2026-04-01T00:00:00Z',
      fingerprint: 'fp-T1',
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 15_000 });

    // Mirror α: re-register in fileRegistry so β's subscription has
    // something to observe (and so fileRegistry is reliably populated
    // for the manual updateFile call below).
    await seedFileRegistry(page, {
      graphHasBayesian: true,
      fittedAt: '2026-04-01T00:00:00Z',
      fingerprint: 'fp-T1',
    });

    // Wait for stable state — both edges should have bayesian at T1 with no
    // drift detected (the seeded edges already match the seeded files).
    await expect.poll(
      async () => {
        const s = await readEdgeBayesState(page);
        return s.length === 2 && s.every((e: any) => e.hasBayesian && e.fittedAt === '2026-04-01T00:00:00Z');
      },
      { message: 'edges should be in sync with files at T1 after boot', timeout: 10_000 },
    ).toBe(true);

    // Simulate a clean-merge pull updating one parameter file's posterior.
    // This is what `pullFile` does after a successful 3-way merge — calls
    // fileRegistry.updateFile with the merged content (data.posterior with
    // a newer fitted_at + fingerprint).
    const targetParamId = PARAM_IDS[0];
    await page.evaluate(async ({ targetParamId, newSlice }: any) => {
      const fr = (window as any).fileRegistry;
      if (!fr?.updateFile) throw new Error('fileRegistry.updateFile not exposed');
      const existing = fr.getFile(`parameter-${targetParamId}`);
      if (!existing) throw new Error(`parameter-${targetParamId} not in registry`);
      const newData = {
        ...existing.data,
        posterior: {
          ...existing.data.posterior,
          fitted_at: '2026-05-12T07:06:14Z',
          fingerprint: 'fp-T2',
          slices: {
            ...existing.data.posterior.slices,
            'window()': { ...existing.data.posterior.slices['window()'], ...newSlice },
          },
        },
      };
      await fr.updateFile(`parameter-${targetParamId}`, newData);
    }, { targetParamId, newSlice: { alpha: 500, beta: 100 } });

    // β subscription should fire for the changed paramId, run a per-edge
    // fetch, and update that edge's bayesian projection. The other edge
    // must NOT re-fetch (β filters to the changed paramId).
    await expect.poll(
      async () => {
        const s = await readEdgeBayesState(page);
        const updated = s.find((e: any) => e.paramId === targetParamId);
        return updated?.fittedAt === '2026-05-12T07:06:14Z' && updated?.fingerprint === 'fp-T2';
      },
      {
        message: 'edge referencing the updated paramId should re-project to T2',
        timeout: 10_000,
      },
    ).toBe(true);

    const final = await readEdgeBayesState(page);
    const updated = final.find((e: any) => e.paramId === targetParamId);
    const unchanged = final.find((e: any) => e.paramId !== targetParamId);

    expect(updated?.fittedAt).toBe('2026-05-12T07:06:14Z');
    expect(updated?.fingerprint).toBe('fp-T2');
    expect(updated?.pPostAlpha).toBe(500);

    // The other edge must still be at T1 — β does NOT graph-wide re-fetch.
    expect(unchanged?.fittedAt).toBe('2026-04-01T00:00:00Z');
    expect(unchanged?.fingerprint).toBe('fp-T1');
  });
});
