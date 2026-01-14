import { test, expect } from '@playwright/test';
import LZString from 'lz-string';
import { installShareLiveStubs, type ShareLiveStubState } from './support/shareLiveStubs';

test.describe.configure({ timeout: 120_000 });

type SharePayloadV1 =
  | {
      version: '1.0.0';
      target: 'chart';
      chart: {
        kind: 'analysis_funnel' | 'analysis_bridge';
        title?: string;
      };
      analysis: {
        query_dsl: string;
        analysis_type?: string | null;
        what_if_dsl?: string | null;
      };
      scenarios: {
        items: Array<{
          dsl: string;
          name?: string;
          colour?: string;
          visibility_mode?: 'f+e' | 'f' | 'e';
          subtitle?: string;
        }>;
        hide_current?: boolean;
        selected_scenario_dsl?: string | null;
      };
    };

function encodeSharePayloadToParam(payload: SharePayloadV1): string {
  // IMPORTANT: Use the same algorithm as the app (lz-string compressToEncodedURIComponent).
  // In Playwright node runtime, lz-string is treated as a CJS default export.
  return (LZString as any).compressToEncodedURIComponent(JSON.stringify(payload));
}

function stableShortHash(input: string): string {
  // Same implementation as src/lib/sharePayload.ts (djb2 variant).
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

function buildLiveChartShareUrl(payload: SharePayloadV1): string {
  const params = new URLSearchParams();
  params.set('mode', 'live');
  params.set('e2e', '1');
  params.set('repo', 'repo-1');
  params.set('branch', 'main');
  params.set('graph', 'test-graph');
  // E2E: provide credentials via URL creds to avoid depending on env-secret wiring.
  // We are testing persistence/refresh correctness, not secret-validation plumbing.
  params.set(
    'creds',
    JSON.stringify({
      defaultGitRepo: 'repo-1',
      git: [
        {
          name: 'repo-1',
          owner: 'owner-1',
          repo: 'repo-1',
          token: 'test-token',
          branch: 'main',
          basePath: '',
        },
        {
          name: 'repo-2',
          owner: 'owner-1',
          repo: 'repo-2',
          token: 'test-token',
          branch: 'main',
          basePath: '',
        },
      ],
    })
  );
  params.set('dashboard', '1');
  params.set('share', encodeSharePayloadToParam(payload));
  return `/?${params.toString()}`;
}

test.describe.serial('Share-live chart (persistence-first)', () => {
  test('cold boot seeds share-scoped IndexedDB and materialises a chart artefact', async ({ browser, baseURL }) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };
    const context = await browser.newContext();
    const page = await context.newPage();
    await installShareLiveStubs(page, state);

    const payload: SharePayloadV1 = {
      version: '1.0.0',
      target: 'chart',
      chart: { kind: 'analysis_bridge', title: 'E2E Live Chart' },
      analysis: { query_dsl: 'from(from).to(to)', analysis_type: 'graph_overview', what_if_dsl: null },
      scenarios: {
        items: [
          { dsl: 'cohort(-1w:)', name: 'A', colour: '#111', visibility_mode: 'f+e', subtitle: 'cohort(-1w:)' },
          { dsl: 'cohort(-2m:-1m)', name: 'B', colour: '#222', visibility_mode: 'f', subtitle: 'cohort(-2m:-1m)' },
        ],
        hide_current: false,
        selected_scenario_dsl: null,
      },
    };

    const chartFileId = `chart-share-${stableShortHash(JSON.stringify(payload))}`;
    const graphFileId = 'graph-test-graph';

    await page.goto(new URL(buildLiveChartShareUrl(payload), baseURL).toString(), { waitUntil: 'domcontentloaded' });

    // Basic UI sanity: we are in live share mode.
    await expect(page.getByText('Live view')).toBeVisible();

    // Chart-only share must NOT open a visible graph tab / ReactFlow surface.
    await expect(page.getByRole('link', { name: 'React Flow' })).toHaveCount(0);

    // Debug: ensure bootstrapper + hook are actually running.
    // Debug: ensure the share chart hook becomes eligible (otherwise nothing should run).
    await expect
      .poll(async () => {
        return await page.evaluate(() => (window as any).__dagnetShareChartBootstrapper?.hook?.isEligible || false);
      })
      .toBe(true);

    // Persistence assertions: chart + graph exist in the share-scoped DB.
    await expect
      .poll(
        async () => {
        return await page.evaluate(
          async ({ chartFileId, graphFileId }) => {
            const db: any = (window as any).db;
            if (!db) return { ok: false, reason: 'no-db' };
            const graph = await db.files.get(graphFileId);
            const chart = await db.files.get(chartFileId);
              const scenarios = await db.scenarios.toArray();
            return {
              ok: Boolean(graph?.data && chart?.data?.payload?.analysis_result),
              dbName: db.name,
              graphMean: graph?.data?.edges?.[0]?.p?.mean,
              analysisName: chart?.data?.payload?.analysis_result?.analysis_name,
                scenariosCount: Array.isArray(scenarios) ? scenarios.length : 0,
              bootError: (window as any).__dagnetShareChartBootError || null,
            };
          },
          { chartFileId, graphFileId }
        );
        },
        { timeout: 55_000 }
      )
      .toMatchObject({
        ok: true,
        dbName: expect.stringContaining('DagNetGraphEditorShare:'),
        graphMean: 0.5,
        analysisName: 'E2E Analysis v1',
        bootError: null,
      });

    // Scenario rehydration + regeneration must preserve DSL + colours.
    const scenarioCheck = await page.evaluate(async () => {
      const db: any = (window as any).db;
      const all = await db.scenarios.toArray();
      return all.map((s: any) => ({
        dsl: s?.meta?.queryDSL,
        colour: s?.colour,
        version: s?.version,
      }));
    });
    expect(scenarioCheck).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dsl: 'cohort(-1w:)', colour: '#111' }),
        expect.objectContaining({ dsl: 'cohort(-2m:-1m)', colour: '#222' }),
      ])
    );
    // Boot path should regenerate live scenarios before analysis so versions increment.
    expect(scenarioCheck.filter(s => s.dsl === 'cohort(-1w:)' && (s.version || 0) > 1).length).toBeGreaterThan(0);
    expect(scenarioCheck.filter(s => s.dsl === 'cohort(-2m:-1m)' && (s.version || 0) > 1).length).toBeGreaterThan(0);

    // Network sanity: cold boot fetched content from GitHub at least once.
    expect(state.counts['github:contents:graphs/test-graph.json']).toBeGreaterThan(0);
    expect(state.counts['compute:analyze']).toBeGreaterThan(0);

    await context.close();
  });

  test('warm boot uses IndexedDB cache (no content refetch) and refresh to v2 overwrites + recomputes', async ({ browser, baseURL }) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };
    const context = await browser.newContext();
    const page = await context.newPage();
    await installShareLiveStubs(page, state);

    const payload: SharePayloadV1 = {
      version: '1.0.0',
      target: 'chart',
      chart: { kind: 'analysis_bridge', title: 'E2E Live Chart' },
      analysis: { query_dsl: 'from(from).to(to)', analysis_type: 'graph_overview', what_if_dsl: null },
      scenarios: {
        items: [
          { dsl: 'cohort(-1w:)', name: 'A', colour: '#111', visibility_mode: 'f+e', subtitle: 'cohort(-1w:)' },
          { dsl: 'cohort(-2m:-1m)', name: 'B', colour: '#222', visibility_mode: 'f', subtitle: 'cohort(-2m:-1m)' },
        ],
        hide_current: false,
        selected_scenario_dsl: null,
      },
    };
    const chartFileId = `chart-share-${stableShortHash(JSON.stringify(payload))}`;
    const graphFileId = 'graph-test-graph';

    // First load (cold) seeds cache.
    await page.goto(new URL(buildLiveChartShareUrl(payload), baseURL).toString(), { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Live view')).toBeVisible();

    await expect
      .poll(async () => {
        return await page.evaluate(
          async ({ chartFileId, graphFileId }) => {
            const db: any = (window as any).db;
            const graph = await db.files.get(graphFileId);
            const chart = await db.files.get(chartFileId);
            return Boolean(graph?.data && chart?.data?.payload?.analysis_result);
          },
          { chartFileId, graphFileId }
        );
      })
      .toBe(true);

    // Reset counters and reload: warm cache should skip GitHub content fetch.
    state.counts = {};
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect
      .poll(async () => state.counts['github:contents:graphs/test-graph.json'] || 0)
      .toBe(0);

    // Now simulate remote advance and ensure dashboard refresh pipeline runs.
    state.version = 'v2';

    // Deterministic refresh trigger (dev-only E2E hook). This exercises the real refresh pipeline
    // without relying on focus/visibility heuristics.
    const refreshRes = await page.evaluate(async () => {
      const w: any = window as any;
      if (!w.dagnetE2e?.refreshLiveShareToLatest) throw new Error('dagnetE2e hooks missing');
      return await w.dagnetE2e.refreshLiveShareToLatest();
    });
    expect(refreshRes).toMatchObject({ success: true });

    // Sanity: the refresh path must have fetched the v2 graph from the stubbed GitHub boundary.
    expect(state.counts['github:graph:v2'] || 0).toBeGreaterThan(0);
    expect(state.lastServedGraphVersion).toBe('v2');
    expect(state.lastServedGraphMean).toBe(0.9);

    await expect
      .poll(
        async () => {
        return await page.evaluate(
          async ({ chartFileId, graphFileId }) => {
            const db: any = (window as any).db;
            const graph = await db.files.get(graphFileId);
            const graphPrefixed = await db.files.get(`repo-1-main-${graphFileId}`);
            const chart = await db.files.get(chartFileId);
            return {
              graphSha: graph?.sha,
              graphMean: graph?.data?.edges?.[0]?.p?.mean,
              graphPrefixedMean: graphPrefixed?.data?.edges?.[0]?.p?.mean,
              analysisName: chart?.data?.payload?.analysis_result?.analysis_name,
            };
          },
          { chartFileId, graphFileId }
        );
        },
        { timeout: 55_000 }
      )
      .toMatchObject({ graphSha: 'graph_sha_v2', graphMean: 0.9, graphPrefixedMean: 0.9, analysisName: 'E2E Analysis v2' });

    // Refresh should have hit GitHub at least once (overwrite seed).
    expect(state.counts['github:contents:graphs/test-graph.json']).toBeGreaterThan(0);
    expect(state.counts['compute:analyze']).toBeGreaterThan(0);

    await context.close();
  });

  test('share isolation: different repo scopes create distinct share DBs', async ({ browser, baseURL }) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };
    const payload: SharePayloadV1 = {
      version: '1.0.0',
      target: 'chart',
      chart: { kind: 'analysis_bridge', title: 'E2E Live Chart' },
      analysis: { query_dsl: 'from(from).to(to)', analysis_type: 'graph_overview', what_if_dsl: null },
      scenarios: { items: [{ dsl: 'window(-2w:-1w)' }], hide_current: false, selected_scenario_dsl: null },
    };

    const urlRepo1 = new URL(buildLiveChartShareUrl(payload), baseURL);
    urlRepo1.searchParams.set('repo', 'repo-1');

    const urlRepo2 = new URL(buildLiveChartShareUrl(payload), baseURL);
    urlRepo2.searchParams.set('repo', 'repo-2');

    // NOTE: share boot config (and thus DB name) is resolved once per page load.
    // To validate isolation, load each URL in a fresh page context and compare db.name values.
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    await installShareLiveStubs(page1, state);
    await page1.goto(urlRepo1.toString(), { waitUntil: 'domcontentloaded' });
    await expect(page1.getByText('Live view')).toBeVisible();
    const dbName1 = await page1.evaluate(() => (window as any).db?.name);
    await context1.close();

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await installShareLiveStubs(page2, state);
    await page2.goto(urlRepo2.toString(), { waitUntil: 'domcontentloaded' });
    await expect(page2.getByText('Live view')).toBeVisible();
    const dbName2 = await page2.evaluate(() => (window as any).db?.name);
    await context2.close();

    expect(String(dbName1)).toContain('DagNetGraphEditorShare:');
    expect(String(dbName2)).toContain('DagNetGraphEditorShare:');
    expect(dbName1).not.toEqual(dbName2);
  });

  test('live bundle opens graph + chart tabs (dashboard) from a single share= payload', async ({ browser, baseURL }) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };
    const context = await browser.newContext();
    const page = await context.newPage();
    await installShareLiveStubs(page, state);

    const bundlePayload: any = {
      version: '1.0.0',
      target: 'bundle',
      presentation: { dashboardMode: true, activeTabIndex: 0 },
      scenarios: {
        items: [
          { dsl: 'cohort(-1w:)', name: 'A', colour: '#111', visibility_mode: 'f+e', subtitle: 'cohort(-1w:)' },
          { dsl: 'cohort(-2m:-1m)', name: 'B', colour: '#222', visibility_mode: 'f', subtitle: 'cohort(-2m:-1m)' },
        ],
        hide_current: false,
        selected_scenario_dsl: null,
      },
      tabs: [
        { type: 'graph', title: 'Graph' },
        {
          type: 'chart',
          title: 'Chart — Bridge View',
          chart: { kind: 'analysis_bridge' },
          analysis: { query_dsl: 'from(from).to(to)', analysis_type: 'graph_overview', what_if_dsl: null },
        },
      ],
    };

    const params = new URLSearchParams();
    params.set('mode', 'live');
    params.set('e2e', '1');
    params.set('dashboard', '1');
    params.set('repo', 'repo-1');
    params.set('branch', 'main');
    params.set('graph', 'test-graph');
    params.set(
      'creds',
      JSON.stringify({
        defaultGitRepo: 'repo-1',
        git: [
          {
            name: 'repo-1',
            owner: 'owner-1',
            repo: 'repo-1',
            token: 'test-token',
            branch: 'main',
            basePath: '',
          },
        ],
      })
    );
    params.set('share', (LZString as any).compressToEncodedURIComponent(JSON.stringify(bundlePayload)));

    const url = new URL(`/?${params.toString()}`, baseURL).toString();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Live view')).toBeVisible();

    // In dashboard mode, both tabs should render simultaneously:
    // - Graph surface includes React Flow attribution link.
    // - Chart surface includes chart title.
    await expect(page.getByRole('link', { name: 'React Flow' })).toBeVisible();
    await expect(page.getByText('Chart — Bridge View')).toBeVisible();

    await context.close();
  });

  test('static bundle dedup + activeTabIndex: opens two graph tabs pointing at one shared graph and focuses the requested tab', async ({ page, baseURL }) => {
    const graph = {
      nodes: [{ uuid: 'n1', id: 'from' }, { uuid: 'n2', id: 'to' }],
      edges: [{ uuid: 'e1', id: 'edge-1', from: 'n1', to: 'n2', p: { id: 'param-1', mean: 0.5 } }],
      metadata: { name: 'static-bundle-graph', e2e_marker: 'static' },
    };

    const graphRef = stableShortHash(JSON.stringify(graph));
    const bundle = {
      type: 'bundle',
      version: '1.0.0',
      shared: {
        graphs: {
          [graphRef]: graph,
        },
      },
      items: [
        { type: 'graph', title: 'Graph A', graphRef },
        { type: 'graph', title: 'Graph B', graphRef },
      ],
      options: {
        dashboardMode: false,
        includeScenarios: false,
        activeTabIndex: 1,
      },
    };

    const params = new URLSearchParams();
    params.set('mode', 'static');
    params.set('e2e', '1');
    params.set('data', (LZString as any).compressToEncodedURIComponent(JSON.stringify(bundle)));

    const url = new URL(`/?${params.toString()}`, baseURL).toString();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('.dock-tab-title', { hasText: 'Graph A' })).toBeVisible();
    await expect(page.locator('.dock-tab-title', { hasText: 'Graph B' })).toBeVisible();

    await expect(page.locator('.dock-tab-title[data-is-focused="true"]')).toHaveText(/Graph B/);
  });
});

