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

function attachShareBootConsoleGuards(page: any) {
  const errors: string[] = [];
  const warnings: string[] = [];

  page.on('pageerror', (err: any) => {
    errors.push(String(err?.message || err));
  });

  page.on('console', (msg: any) => {
    const type = msg.type?.() || '';
    const text = msg.text?.() || '';

    if (type === 'error') {
      errors.push(text);
      return;
    }

    if (type === 'warning') {
      // Only fail on known stability regressions (React update loops, repeated 4xx boot failures).
      if (/Maximum update depth exceeded/i.test(text)) warnings.push(text);
      if (/Failed to load resource.*\b400\b/i.test(text)) warnings.push(text);
      if (/\bPOST\b.*\/api\/runner\/analyze\b.*\b400\b/i.test(text)) warnings.push(text);
    }
  });

  return {
    assertNoStabilityErrors: async () => {
      expect(errors, `Console errors during share boot:\n${errors.join('\n')}`).toEqual([]);
      expect(warnings, `Console stability warnings during share boot:\n${warnings.join('\n')}`).toEqual([]);
    },
  };
}

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
  test('generated live chart share link replays scenario labels/colours/modes exactly (authoring → share)', async ({ browser, baseURL }) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };

    // 1) Authoring page: seed a graph + scenarios + a bridge chart file in IndexedDB, then generate a live share URL via the real service.
    const authoringContext = await browser.newContext();
    const authoringPage = await authoringContext.newPage();
    await installShareLiveStubs(authoringPage, state);
    await authoringPage.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });

    const chartFileId = 'chart-author-bridge-1';
    const graphFileId = 'graph-test-graph';
    const parentTabId = 'tab-graph-author-1';
    const scenarioAId = 'scenario-a';
    const scenarioBId = 'scenario-b';

    await authoringPage.evaluate(
      async ({ chartFileId, graphFileId, parentTabId, scenarioAId, scenarioBId }) => {
        const w: any = window as any;
        const db = w.db;
        if (!db) throw new Error('db missing');
        if (!w.dagnetE2e?.buildLiveChartShareUrlFromChartFile) throw new Error('dagnetE2e hooks missing');

        // Seed graph file with live identity.
        await db.files.put({
          fileId: graphFileId,
          type: 'graph',
          viewTabs: [],
          data: { nodes: [{ uuid: 'n1', id: 'from' }, { uuid: 'n2', id: 'to' }], edges: [] },
          // IMPORTANT: repository must match the credential entry name (not owner/repo).
          source: { repository: 'repo-1', branch: 'main', path: 'graphs/test-graph.json' },
        });

        // Seed live scenarios (source of truth for DSL).
        await db.scenarios.put({
          id: scenarioAId,
          fileId: graphFileId,
          name: 'new month',
          colour: '#06B6D4',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          meta: { isLive: true, queryDSL: 'cohort(-1m:)' },
          params: { edges: {}, nodes: {} },
        });
        await db.scenarios.put({
          id: scenarioBId,
          fileId: graphFileId,
          name: 'old month',
          colour: '#F97316',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          meta: { isLive: true, queryDSL: 'cohort(-2m:-1m)' },
          params: { edges: {}, nodes: {} },
        });

        // Seed parent graph tab state (only for share link generation legacy fallback).
        await db.tabs.put({
          id: parentTabId,
          fileId: graphFileId,
          viewMode: 'interactive',
          title: 'Graph',
          editorState: {
            scenarioState: {
              visibleScenarioIds: [scenarioAId, scenarioBId],
              visibilityMode: { [scenarioAId]: 'e', [scenarioBId]: 'f' },
              selectedScenarioId: scenarioAId,
            },
          },
        });

        // Seed a bridge chart file that embeds the canonical scenario display metadata in analysis_result.metadata.
        await db.files.put({
          fileId: chartFileId,
          type: 'chart',
          viewTabs: [],
          data: {
            version: '1.0.0',
            chart_kind: 'analysis_bridge',
            title: 'Chart — Bridge View',
            created_at_uk: '14-Jan-26',
            created_at_ms: Date.now(),
            source: {
              parent_tab_id: parentTabId,
              parent_file_id: graphFileId,
              query_dsl: 'to(switch-success)',
              analysis_type: 'bridge_view',
            },
            payload: {
              analysis_result: {
                analysis_type: 'bridge_view',
                analysis_name: 'Bridge View',
                analysis_description: 'Decompose the Reach Probability difference between two scenarios',
                metadata: {
                  scenario_a: {
                    scenario_id: scenarioAId,
                    name: 'new month',
                    colour: '#06B6D4',
                    visibility_mode: 'e',
                    probability_label: 'Evidence Probability',
                  },
                  scenario_b: {
                    scenario_id: scenarioBId,
                    name: 'old month',
                    colour: '#F97316',
                    visibility_mode: 'f',
                    probability_label: 'Forecast Probability',
                  },
                },
                dimension_values: { bridge_step: {} },
                data: [],
              },
              scenario_ids: [],
            },
          },
        });
      },
      { chartFileId, graphFileId, parentTabId, scenarioAId, scenarioBId }
    );

    const shareUrl = await authoringPage.evaluate(async ({ chartFileId }) => {
      const w: any = window as any;
      const res = await w.dagnetE2e.buildLiveChartShareUrlFromChartFile({ chartFileId, secretOverride: 'test-secret', dashboardMode: true });
      if (!res?.success || !res?.url) throw new Error(res?.error || 'Failed to build share URL');
      return res.url as string;
    }, { chartFileId });

    await authoringContext.close();

    // 2) Share page: open the generated URL and assert the recompute inputs preserve scenario display metadata.
    const shareContext = await browser.newContext();
    const sharePage = await shareContext.newPage();
    await installShareLiveStubs(sharePage, state);

    await sharePage.goto(new URL(shareUrl, baseURL).toString(), { waitUntil: 'domcontentloaded' });
    await expect(sharePage.getByText('Live view')).toBeVisible();

    // Assert compute boundary received the exact scenario labels/colours/modes (this is what drives chart display).
    await expect
      .poll(async () => {
        return (state.lastAnalyzeRequest?.scenarios || []).map((s: any) => ({
          name: s.name,
          colour: s.colour,
          visibility_mode: s.visibility_mode,
        }));
      })
      .toEqual([
        { name: 'new month', colour: '#06B6D4', visibility_mode: 'e' },
        { name: 'old month', colour: '#F97316', visibility_mode: 'f' },
      ]);

    // Assert the share session materialised exactly two user scenarios with the correct display metadata.
    await expect
      .poll(async () => {
        return await sharePage.evaluate(async () => {
          const db: any = (window as any).db;
          const all = await db.scenarios.toArray();
          return all.map((s: any) => ({ name: s?.name, colour: s?.colour, dsl: s?.meta?.queryDSL }));
        });
      })
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'new month', colour: '#06B6D4', dsl: 'cohort(-1m:)' }),
          expect.objectContaining({ name: 'old month', colour: '#F97316', dsl: 'cohort(-2m:-1m)' }),
        ])
      );

    // Guard against the "double chart tab" regression: the chart UI should be rendered once.
    await expect(sharePage.getByText('Chart — Bridge View')).toHaveCount(1);
    await sharePage.waitForTimeout(1000);
    await expect(sharePage.getByText('Chart — Bridge View')).toHaveCount(1);

    await shareContext.close();
  });

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

  test('live chart share supports Current-only charts (no user scenarios) and still materialises a chart', async ({ browser, baseURL }) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };

    // 1) Authoring page: seed a graph + a parent tab with Current visible only + a chart file, then generate share URL.
    const authoringContext = await browser.newContext();
    const authoringPage = await authoringContext.newPage();
    await installShareLiveStubs(authoringPage, state);
    await authoringPage.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });

    const chartFileId = 'chart-author-current-only-1';
    const graphFileId = 'graph-test-graph';
    const parentTabId = 'tab-graph-author-current-only-1';

    await authoringPage.evaluate(
      async ({ chartFileId, graphFileId, parentTabId }) => {
        const w: any = window as any;
        const db = w.db;
        if (!db) throw new Error('db missing');
        if (!w.dagnetE2e?.buildLiveChartShareUrlFromChartFile) throw new Error('dagnetE2e hooks missing');

        await db.files.put({
          fileId: graphFileId,
          type: 'graph',
          viewTabs: [],
          data: { nodes: [{ uuid: 'n1', id: 'from' }, { uuid: 'n2', id: 'to' }], edges: [] },
          source: { repository: 'repo-1', branch: 'main', path: 'graphs/test-graph.json' },
        });

        // Parent tab with Current visible (and no user scenarios).
        await db.tabs.put({
          id: parentTabId,
          fileId: graphFileId,
          viewMode: 'interactive',
          title: 'Graph',
          editorState: {
            scenarioState: {
              visibleScenarioIds: ['current'],
              visibilityMode: {},
              selectedScenarioId: 'current',
            },
          },
        });

        // Chart file (bridge-style metadata shape is fine; analyze is stubbed anyway).
        await db.files.put({
          fileId: chartFileId,
          type: 'chart',
          viewTabs: [],
          data: {
            version: '1.0.0',
            chart_kind: 'analysis_bridge',
            title: 'Chart — Current only',
            created_at_uk: '14-Jan-26',
            created_at_ms: Date.now(),
            source: {
              parent_tab_id: parentTabId,
              parent_file_id: graphFileId,
              query_dsl: 'from(from).to(to)',
              analysis_type: 'graph_overview',
            },
            payload: {
              analysis_result: {
                analysis_type: 'graph_overview',
                analysis_name: 'E2E Analysis v1',
                analysis_description: 'E2E stubbed analysis result',
                metadata: {},
                dimension_values: {},
                data: [],
              },
              scenario_ids: [],
            },
          },
        });
      },
      { chartFileId, graphFileId, parentTabId }
    );

    const shareUrl = await authoringPage.evaluate(async ({ chartFileId }) => {
      const w: any = window as any;
      const res = await w.dagnetE2e.buildLiveChartShareUrlFromChartFile({ chartFileId, secretOverride: 'test-secret', dashboardMode: true });
      if (!res?.success || !res?.url) throw new Error(res?.error || 'Failed to build share URL');
      return res.url as string;
    }, { chartFileId });

    await authoringContext.close();

    // 2) Share page: open and assert chart content materialises (and compute was called with at least one scenario).
    const shareContext = await browser.newContext();
    const sharePage = await shareContext.newPage();
    await installShareLiveStubs(sharePage, state);

    await sharePage.goto(new URL(shareUrl, baseURL).toString(), { waitUntil: 'domcontentloaded' });
    await expect(sharePage.getByText('Live view')).toBeVisible();
    await expect(sharePage.getByText('Chart — Current only')).toBeVisible();
    await expect(sharePage.getByRole('button', { name: 'Download CSV' })).toBeVisible();

    await expect
      .poll(async () => (state.lastAnalyzeRequest?.scenarios || []).length, { timeout: 20_000 })
      .toBeGreaterThan(0);

    await shareContext.close();
  });

  test('live chart share shows an in-tab error (not a blank page) when analysis fails', async ({ browser, baseURL }) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {}, forceAnalyzeStatus: 500 };

    const context = await browser.newContext();
    const page = await context.newPage();
    await installShareLiveStubs(page, state);

    const payload: SharePayloadV1 = {
      version: '1.0.0',
      target: 'chart',
      chart: { kind: 'analysis_bridge', title: 'E2E Live Chart (forced failure)' },
      analysis: { query_dsl: 'from(from).to(to)', analysis_type: 'graph_overview', what_if_dsl: null },
      scenarios: { items: [{ dsl: 'cohort(-1w:)', name: 'A', colour: '#111', visibility_mode: 'f+e' }], hide_current: false, selected_scenario_dsl: null },
    };

    const url = new URL(buildLiveChartShareUrl(payload), baseURL).toString();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Live view')).toBeVisible();

    // Must not be "blank": show a persistent in-tab error state.
    await expect(page.getByText('Chart failed to load')).toBeVisible();

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
    const guards = attachShareBootConsoleGuards(page);
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
    // Stronger assertion: ChartViewer controls must be present (ensures chart CONTENT rendered, not just hidden tab metadata).
    await expect(page.getByRole('button', { name: 'Download CSV' })).toBeVisible();

    // Stability: analyze must have received at least one scenario, and the app must not spam tabs/renders.
    await expect
      .poll(async () => (state.lastAnalyzeRequest?.scenarios || []).length, { timeout: 20_000 })
      .toBeGreaterThan(0);

    // Integrity: scenario labels/colours/modes should be replayed exactly into the compute boundary.
    await expect
      .poll(async () => {
        return (state.lastAnalyzeRequest?.scenarios || []).map((s: any) => ({
          name: s.name,
          colour: s.colour,
          visibility_mode: s.visibility_mode,
        }));
      })
      .toEqual([
        { name: 'Current', colour: expect.any(String), visibility_mode: 'f+e' },
        { name: 'A', colour: '#111', visibility_mode: 'f+e' },
        { name: 'B', colour: '#222', visibility_mode: 'f' },
      ]);

    // Stability: tab strip should not explode (regression: repeated openTemporaryTab with Date.now()).
    // In dashboard mode, rc-dock tab strip may be hidden. Use IndexedDB tab state instead.
    await expect
      .poll(async () => {
        return await page.evaluate(async () => {
          const db: any = (window as any).db;
          if (!db?.tabs) return [];
          const all = await db.tabs.toArray();
          return all.map((t: any) => ({ id: t.id, fileId: t.fileId, title: t.title, viewMode: t.viewMode }));
        });
      })
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: 'Graph' }),
          expect.objectContaining({ title: 'Chart — Bridge View' }),
        ])
      );

    const tabCount1 = await page.evaluate(async () => {
      const db: any = (window as any).db;
      const all = await db.tabs.toArray();
      return all.length;
    });
    await page.waitForTimeout(1000);
    const tabCount2 = await page.evaluate(async () => {
      const db: any = (window as any).db;
      const all = await db.tabs.toArray();
      return all.length;
    });
    expect(tabCount2).toBe(tabCount1);

    await guards.assertNoStabilityErrors();
    await context.close();
  });

  test('live bundle preserves duplicate DSL scenarios (distinct colours) in compute request', async ({ browser, baseURL }) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };
    const context = await browser.newContext();
    const page = await context.newPage();
    const guards = attachShareBootConsoleGuards(page);
    await installShareLiveStubs(page, state);

    // Two scenarios can legitimately share the same DSL but must remain distinct in the share payload/boot.
    // Regression: we previously keyed scenarios by DSL during boot, collapsing duplicates and dropping colours.
    const bundlePayload: any = {
      version: '1.0.0',
      target: 'bundle',
      presentation: { dashboardMode: true, activeTabIndex: 0 },
      scenarios: {
        items: [
          { dsl: 'cohort(1-Dec-25:31-Dec-25)', name: 'A', colour: '#F97316', visibility_mode: 'f+e' },
          { dsl: 'cohort(1-Dec-25:31-Dec-25)', name: 'B', colour: '#06B6D4', visibility_mode: 'f+e' },
        ],
        hide_current: true,
        selected_scenario_dsl: null,
      },
      tabs: [
        {
          type: 'chart',
          title: 'Chart — Duplicate DSL',
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
    await expect(page.getByText('Chart — Duplicate DSL')).toBeVisible();

    // Integrity: the compute boundary must receive *two* scenarios with the distinct colours/names.
    await expect
      .poll(async () => {
        return (state.lastAnalyzeRequest?.scenarios || []).map((s: any) => ({
          name: s?.name,
          colour: s?.colour,
          visibility_mode: s?.visibility_mode,
        }));
      })
      .toEqual([
        { name: 'A', colour: '#F97316', visibility_mode: 'f+e' },
        { name: 'B', colour: '#06B6D4', visibility_mode: 'f+e' },
      ]);

    await guards.assertNoStabilityErrors();
    await context.close();
  });

  test('live bundle (graph-only) preserves visible scenarios exactly (hide_current + colours) in tab state + IndexedDB', async ({ browser, baseURL }) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };
    const context = await browser.newContext();
    const page = await context.newPage();
    const guards = attachShareBootConsoleGuards(page);
    await installShareLiveStubs(page, state);

    const bundlePayload: any = {
      version: '1.0.0',
      target: 'bundle',
      presentation: { dashboardMode: true, activeTabIndex: 0 },
      scenarios: {
        items: [
          { dsl: 'cohort(1-Dec-25:31-Dec-25)', name: 'A', colour: '#F97316', visibility_mode: 'f+e' },
          { dsl: 'cohort(1-Dec-25:31-Dec-25)', name: 'B', colour: '#06B6D4', visibility_mode: 'f+e' },
        ],
        hide_current: true,
        selected_scenario_dsl: null,
      },
      tabs: [{ type: 'graph', title: 'Graph Only' }],
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

    // Assert tab scenarioState mirrors payload semantics: Current hidden, two scenarios visible.
    // (poll because share boot creates the tab asynchronously)
    await expect
      .poll(async () => {
        return await page.evaluate(async () => {
          const db: any = (window as any).db;
          const tabs = await db.tabs.toArray();
          const graphTab = tabs.find((t: any) => t?.title === 'Graph Only') || null;
          const ids = graphTab?.editorState?.scenarioState?.visibleScenarioIds;
          if (!Array.isArray(ids)) return 'missing';
          return ids.includes('current') ? 'has-current' : 'ok';
        });
      })
      .toBe('ok');

    await expect
      .poll(async () => {
        return await page.evaluate(async () => {
          const db: any = (window as any).db;
          const tabs = await db.tabs.toArray();
          const graphTab = tabs.find((t: any) => t?.title === 'Graph Only') || null;
          const ids = graphTab?.editorState?.scenarioState?.visibleScenarioIds;
          return Array.isArray(ids) ? ids.length : -1;
        });
      })
      .toBe(2);

    // Assert scenarios were actually persisted for the graph fileId, with colours preserved.
    await expect
      .poll(async () => {
        return await page.evaluate(async () => {
          const db: any = (window as any).db;
          const files = await db.files.toArray();
          const graphFile = files.find((f: any) => f?.type === 'graph') || files[0];
          const fileId = graphFile?.fileId;
          const scenarios = await db.scenarios.where('fileId').equals(fileId).toArray();
          return scenarios.map((s: any) => ({ name: s?.name, colour: s?.colour, dsl: s?.meta?.queryDSL }));
        });
      })
      .toEqual([
        { name: 'A', colour: '#F97316', dsl: 'cohort(1-Dec-25:31-Dec-25)' },
        { name: 'B', colour: '#06B6D4', dsl: 'cohort(1-Dec-25:31-Dec-25)' },
      ]);

    await guards.assertNoStabilityErrors();
    await context.close();
  });

  test('live bundle boot is stable when hide_current=true and scenario list is empty (falls back to Current)', async ({ browser, baseURL }) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };
    const context = await browser.newContext();
    const page = await context.newPage();
    const guards = attachShareBootConsoleGuards(page);
    await installShareLiveStubs(page, state);

    const bundlePayload: any = {
      version: '1.0.0',
      target: 'bundle',
      presentation: { dashboardMode: true, activeTabIndex: 0 },
      scenarios: {
        items: [],
        hide_current: true,
        selected_scenario_dsl: null,
      },
      tabs: [
        { type: 'graph', title: 'Graph' },
        {
          type: 'chart',
          title: 'Chart — Empty scenarios',
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
    await expect(page.getByText('Chart — Empty scenarios')).toBeVisible();

    // The compute boundary must never be invoked with 0 scenarios (stub returns 400 if it is).
    await expect
      .poll(async () => (state.lastAnalyzeRequest?.scenarios || []).map((s: any) => s.scenario_id), { timeout: 20_000 })
      .toEqual(['current']);

    // In dashboard mode, rc-dock tab strip may be hidden. Use IndexedDB tab state instead.
    await expect
      .poll(async () => {
        return await page.evaluate(async () => {
          const db: any = (window as any).db;
          if (!db?.tabs) return [];
          const all = await db.tabs.toArray();
          return all.map((t: any) => ({ id: t.id, fileId: t.fileId, title: t.title, viewMode: t.viewMode }));
        });
      })
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: 'Graph' }),
          expect.objectContaining({ title: 'Chart — Empty scenarios' }),
        ])
      );

    const tabCount1 = await page.evaluate(async () => {
      const db: any = (window as any).db;
      const all = await db.tabs.toArray();
      return all.length;
    });
    await page.waitForTimeout(1000);
    const tabCount2 = await page.evaluate(async () => {
      const db: any = (window as any).db;
      const all = await db.tabs.toArray();
      return all.length;
    });
    expect(tabCount2).toBe(tabCount1);

    await guards.assertNoStabilityErrors();
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

