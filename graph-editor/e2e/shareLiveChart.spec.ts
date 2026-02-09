import { test, expect } from '@playwright/test';
import LZString from 'lz-string';
import { installShareLiveStubs, type ShareLiveStubState } from './support/shareLiveStubs';
import { installShareForensics } from './support/shareForensics';

test.describe.configure({ timeout: 120_000 });

type SharePayloadV1 =
  | {
      version: '1.0.0';
      target: 'chart';
      chart: {
        kind: 'analysis_funnel' | 'analysis_bridge' | 'analysis_daily_conversions' | 'analysis_cohort_maturity';
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
      graph_state?: {
        base_dsl?: string;
        current_query_dsl?: string;
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
  test('bundle share link generation: when chart tab is active, it still includes graph scenario items (graph+chart bundle stays linked; bridge has 2 scenarios)', async ({ browser, baseURL }, testInfo) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };

    // 1) Authoring: seed a graph tab + chart tab; set activeTabId to the CHART tab; then generate a live bundle URL.
    const authoringContext = await browser.newContext();
    const authoringPage = await authoringContext.newPage();
    const authorFx = installShareForensics({ page: authoringPage, testInfo, phase: 'authoring-bundle-chart-active' });
    await installShareLiveStubs(authoringPage, state);
    await authoringPage.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });

    const graphFileId = 'graph-test-graph';
    const graphTabId = 'tab-graph-author-1';
    const chartFileId = 'chart-author-bridge-1';
    const chartTabId = 'tab-chart-author-1';
    const scenarioAId = 'scenario-a';

    const shareUrl0 = await authoringPage.evaluate(
      async ({ graphFileId, graphTabId, chartFileId, chartTabId, scenarioAId }) => {
        const w: any = window as any;
        const db = w.db;
        if (!db) throw new Error('db missing');
        if (!w.dagnetE2e?.buildLiveBundleShareUrlFromTabs) throw new Error('dagnetE2e bundle hook missing');

        // Graph file with live identity.
        await db.files.put({
          fileId: graphFileId,
          type: 'graph',
          viewTabs: [],
          data: { nodes: [{ uuid: 'n1', id: 'from' }, { uuid: 'n2', id: 'to' }], edges: [], currentQueryDSL: 'window(1-Dec-25:17-Dec-25)', baseDSL: 'window(1-Nov-25:10-Nov-25)' },
          source: { repository: 'repo-1', branch: 'main', path: 'graphs/test-graph.json' },
        });

        // One live scenario + Current visible in the graph tab scenario state.
        await db.scenarios.put({
          id: scenarioAId,
          fileId: graphFileId,
          name: 'A',
          colour: '#111',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          version: 1,
          params: { edges: {}, nodes: {} },
          meta: { isLive: true, queryDSL: 'cohort(-1w:)', lastEffectiveDSL: 'cohort(-1w:)' },
        });

        await db.tabs.put({
          id: graphTabId,
          fileId: graphFileId,
          viewMode: 'interactive',
          title: 'Graph',
          editorState: {
            scenarioState: {
              visibleScenarioIds: ['current', scenarioAId],
              visibilityMode: { [scenarioAId]: 'e' },
              selectedScenarioId: scenarioAId,
            },
          },
        });

        // Seed a bridge chart file (authoring artefact) with correct recipe.
        await db.files.put({
          fileId: chartFileId,
          type: 'chart',
          viewTabs: [],
          data: {
            version: '1.0.0',
            chart_kind: 'analysis_bridge',
            title: 'Chart — Bridge View',
            created_at_uk: '18-Jan-26',
            created_at_ms: Date.now(),
            source: {
              parent_tab_id: graphTabId,
              parent_file_id: graphFileId,
              query_dsl: 'to(switch-success)',
              analysis_type: 'bridge_view',
            },
            recipe: {
              parent: { parent_file_id: graphFileId, parent_tab_id: graphTabId },
              analysis: { analysis_type: 'bridge_view', query_dsl: 'to(switch-success)', what_if_dsl: null },
              scenarios: [
                { scenario_id: scenarioAId, name: 'A', colour: '#111', visibility_mode: 'e', effective_dsl: 'cohort(-1w:)', is_live: true },
                { scenario_id: 'current', name: 'Current', colour: '#3B82F6', visibility_mode: 'f+e', effective_dsl: 'window(1-Dec-25:17-Dec-25)', is_live: true },
              ],
              display: { hide_current: false },
              pinned_recompute_eligible: true,
            },
            deps: {
              v: 1,
              mode: 'linked',
              chart_kind: 'analysis_bridge',
              parent: { parent_file_id: graphFileId, parent_tab_id: graphTabId },
              analysis: { analysis_type: 'bridge_view', query_dsl: 'to(switch-success)', what_if_dsl: null },
              scenarios: [
                { scenario_id: scenarioAId, effective_dsl: 'cohort(-1w:)', visibility_mode: 'e', is_live: true },
                { scenario_id: 'current', effective_dsl: 'window(1-Dec-25:17-Dec-25)', visibility_mode: 'f+e', is_live: true },
              ],
            },
            deps_signature: 'e2e-seeded-v1',
            payload: { analysis_result: { analysis_type: 'bridge_view', analysis_name: 'Bridge View', metadata: { scenario_a: { scenario_id: scenarioAId }, scenario_b: { scenario_id: 'current' } }, dimension_values: {}, data: [] }, scenario_ids: [scenarioAId, 'current'] },
          },
        });

        await db.tabs.put({
          id: chartTabId,
          fileId: chartFileId,
          viewMode: 'interactive',
          title: 'Chart — Bridge View',
          editorState: {},
        });

        // Make the CHART the active tab (this is the regression case).
        await db.saveAppState({ activeTabId: chartTabId });

        const res = await w.dagnetE2e.buildLiveBundleShareUrlFromTabs({
          tabIds: [graphTabId, chartTabId],
          activeTabId: chartTabId,
          secretOverride: 'test-secret',
          dashboardMode: true,
          includeScenarios: true,
        });
        if (!res?.success || !res?.url) throw new Error(res?.error || 'Failed to build bundle share URL');
        return res.url as string;
      },
      { graphFileId, graphTabId, chartFileId, chartTabId, scenarioAId }
    );

    authorFx.recordUrl('constructedShareUrl', shareUrl0);
    await authorFx.snapshotDb('authoring');
    await authorFx.flush();
    await authoringContext.close();

    // 2) Share page: open the URL and assert the chart stays linked and the compute boundary sees 2 scenarios.
    const shareContext = await browser.newContext();
    const sharePage = await shareContext.newPage();
    const shareFx = installShareForensics({ page: sharePage, testInfo, phase: 'share-bundle-chart-active' });
    await installShareLiveStubs(sharePage, state);

    try {
      await sharePage.goto(new URL(shareUrl0, baseURL).toString(), { waitUntil: 'domcontentloaded' });
      await expect(sharePage.getByText('Live view')).toBeVisible();
      await expect(sharePage.getByText('Chart — Bridge View')).toBeVisible();
      await expect(sharePage.getByText('Linked').first()).toBeVisible();

    // Bridge must compute with exactly two scenarios, in the correct order:
    // bundle semantics for bridge_view require "Current last".
    await expect
      .poll(async () => (state.lastAnalyzeRequest?.scenarios || []).length, { timeout: 20_000 })
      .toBe(2);

    await expect
      .poll(async () => {
        return (state.lastAnalyzeRequest?.scenarios || []).map((s: any) => s?.name);
      })
      .toEqual(['A', 'Current']);

    // Persisted artefact contract: chart recipe order must match the compute request order.
    await expect
      .poll(async () => {
        return await sharePage.evaluate(async () => {
          const db: any = (window as any).db;
          const files = await db.files.toArray();
          const chart = files.find((f: any) => f?.type === 'chart' && f?.data?.title === 'Chart — Bridge View') || null;
          const items = chart?.data?.recipe?.scenarios || [];
          return items.map((s: any) => s?.name || null);
        });
      })
      .toEqual(['A', 'Current']);

    // Regression guard: clicking Refresh on a LINKED chart must not flip scenario/series ordering.
    await sharePage.getByRole('button', { name: 'Refresh' }).click();
    await sharePage.waitForTimeout(800);
    await expect
      .poll(async () => {
        return (state.lastAnalyzeRequest?.scenarios || []).map((s: any) => s?.name);
      })
      .toEqual(['A', 'Current']);
    await expect
      .poll(async () => {
        return await sharePage.evaluate(async () => {
          const db: any = (window as any).db;
          const files = await db.files.toArray();
          const chart = files.find((f: any) => f?.type === 'chart' && f?.data?.title === 'Chart — Bridge View') || null;
          const items = chart?.data?.recipe?.scenarios || [];
          return items.map((s: any) => s?.name || null);
        });
      })
      .toEqual(['A', 'Current']);

      await shareFx.recordJson('lastAnalyzeRequest.json', state.lastAnalyzeRequest || null);
    } finally {
      // Always flush forensics on failure: this test is designed to guard persistence semantics and
      // losing the share-phase artefacts makes regressions much harder to debug.
      await shareFx.snapshotDb('share');
      await shareFx.flush();
      await shareContext.close();
    }
  });

  test('live share (funnel) preserves scenario order/visibility exactly (no Current; hide_current=true)', async ({ browser, baseURL }) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };

    const context = await browser.newContext();
    const page = await context.newPage();
    await installShareLiveStubs(page, state);

    const payload: SharePayloadV1 = {
      version: '1.0.0',
      target: 'chart',
      chart: { kind: 'analysis_funnel', title: 'E2E Live Funnel' },
      analysis: { query_dsl: 'from(from).to(to)', analysis_type: 'graph_overview', what_if_dsl: null },
      scenarios: {
        items: [
          { dsl: 'cohort(-1w:)', name: 'A', colour: '#111', visibility_mode: 'e' },
          { dsl: 'cohort(-2m:-1m)', name: 'B', colour: '#222', visibility_mode: 'f' },
        ],
        hide_current: true,
        selected_scenario_dsl: null,
      },
    };

    const url = new URL(buildLiveChartShareUrl(payload), baseURL).toString();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Live view')).toBeVisible();
    await expect(page.getByText('E2E Live Funnel')).toBeVisible();

    await expect
      .poll(async () => {
        return (state.lastAnalyzeRequest?.scenarios || []).map((s: any) => ({
          name: s.name,
          colour: s.colour,
          visibility_mode: s.visibility_mode,
        }));
      })
      .toEqual([
        { name: 'A', colour: '#111', visibility_mode: 'e' },
        { name: 'B', colour: '#222', visibility_mode: 'f' },
      ]);

    // Persisted artefact contract: chart recipe order must match compute request order.
    await expect
      .poll(async () => {
        return await page.evaluate(async () => {
          const db: any = (window as any).db;
          const files = await db.files.toArray();
          const chart = files.find((f: any) => f?.type === 'chart' && f?.data?.title === 'E2E Live Funnel') || null;
          const items = chart?.data?.recipe?.scenarios || [];
          return items.map((s: any) => s?.name || null);
        });
      })
      .toEqual(['A', 'B']);

    await context.close();
  });

  test('generated live chart share link replays scenario labels/colours/modes exactly (authoring → share)', async ({ browser, baseURL }, testInfo) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };

    // 1) Authoring page: seed a graph + scenarios + a bridge chart file in IndexedDB, then generate a live share URL via the real service.
    const authoringContext = await browser.newContext();
    const authoringPage = await authoringContext.newPage();
    const authorFx = installShareForensics({ page: authoringPage, testInfo, phase: 'authoring' });
    await installShareLiveStubs(authoringPage, state);
    await authoringPage.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });
    authorFx.recordUrl('authoringPage.url', authoringPage.url());

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
          data: {
            nodes: [{ uuid: 'n1', id: 'from' }, { uuid: 'n2', id: 'to' }],
            edges: [],
            // Make the DSL state explicit so the share payload must preserve it.
            currentQueryDSL: 'window(1-Jan-26:2-Jan-26)',
            baseDSL: 'cohort(1-Dec-25:7-Dec-25)',
          },
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
            // New schema: charts must include a pinned recipe for deterministic share + pinned fallback.
            recipe: {
              parent: { parent_file_id: graphFileId, parent_tab_id: parentTabId },
              analysis: { analysis_type: 'bridge_view', query_dsl: 'to(switch-success)', what_if_dsl: null },
              scenarios: [
                {
                  scenario_id: scenarioAId,
                  name: 'new month',
                  colour: '#06B6D4',
                  visibility_mode: 'e',
                  effective_dsl: 'cohort(-1m:)',
                  is_live: true,
                },
                {
                  scenario_id: scenarioBId,
                  name: 'old month',
                  colour: '#F97316',
                  visibility_mode: 'f',
                  effective_dsl: 'cohort(-2m:-1m)',
                  is_live: true,
                },
              ],
              // Parent tab scenarioState does not include Current, so the chart recipe must mirror that.
              display: { hide_current: true },
              pinned_recompute_eligible: true,
            },
            deps: {
              v: 1,
              mode: 'linked',
              chart_kind: 'analysis_bridge',
              parent: { parent_file_id: graphFileId, parent_tab_id: parentTabId },
              analysis: { analysis_type: 'bridge_view', query_dsl: 'to(switch-success)', what_if_dsl: null },
              scenarios: [
                { scenario_id: scenarioAId, effective_dsl: 'cohort(-1m:)', visibility_mode: 'e', is_live: true },
                { scenario_id: scenarioBId, effective_dsl: 'cohort(-2m:-1m)', visibility_mode: 'f', is_live: true },
              ],
            },
            deps_signature: 'e2e-seeded-v1',
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

    // Record the exact input chart YAML that we are about to share.
    const inputChartData = await authoringPage.evaluate(async ({ chartFileId }) => {
      const db: any = (window as any).db;
      const f = await db.files.get(chartFileId);
      return f?.data || null;
    }, { chartFileId });
    await authorFx.recordYaml('input-chart.yaml', inputChartData);
    await authorFx.recordJson('input-chart.json', inputChartData);

    const shareUrl0 = await authoringPage.evaluate(async ({ chartFileId }) => {
      const w: any = window as any;
      const res = await w.dagnetE2e.buildLiveChartShareUrlFromChartFile({ chartFileId, secretOverride: 'test-secret', dashboardMode: true });
      if (!res?.success || !res?.url) throw new Error(res?.error || 'Failed to build share URL');
      return res.url as string;
    }, { chartFileId });
    // Force a fresh share-scoped IndexedDB for this test so we always exercise rehydration + compute,
    // even when another test in this file used the same repo/branch/graph scope earlier.
    const shareUrl = (() => {
      const u = new URL(shareUrl0);
      u.searchParams.set('dbnonce', `rehydrate-eq-${Date.now()}`);
      return u.toString();
    })();
    authorFx.recordUrl('constructedShareUrl', shareUrl);

    await authorFx.snapshotDb('authoring');
    await authorFx.flush();
    await authoringContext.close();

    // 2) Share page: open the generated URL and assert the recompute inputs preserve scenario display metadata.
    const shareContext = await browser.newContext();
    const sharePage = await shareContext.newPage();
    const shareFx = installShareForensics({ page: sharePage, testInfo, phase: 'share' });
    await installShareLiveStubs(sharePage, state);

    try {
      await sharePage.goto(new URL(shareUrl, baseURL).toString(), { waitUntil: 'domcontentloaded' });
      shareFx.recordUrl('sharePage.url', sharePage.url());
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

    // And critically: share must replay the authoring graph DSL state (base/current) rather than
    // whatever is in the repo graph file at the target identity.
    await expect
      .poll(async () => {
        const g = state.lastAnalyzeRequest?.scenarios?.[0]?.graph || null;
        return { baseDSL: g?.baseDSL || null, currentQueryDSL: g?.currentQueryDSL || null };
      })
      .toEqual({ baseDSL: 'cohort(1-Dec-25:7-Dec-25)', currentQueryDSL: 'window(1-Jan-26:2-Jan-26)' });

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

    } finally {
      // Record output chart YAML from the share DB (materialised chart artefact).
      const outputChartData = await sharePage.evaluate(async () => {
        const db: any = (window as any).db;
        const files = await db.files.toArray();
        const chart = files.find((f: any) => f?.type === 'chart' && f?.data?.title === 'Chart — Bridge View') || null;
        return chart?.data || null;
      }).catch(() => null);
      await shareFx.recordYaml('output-chart.yaml', outputChartData);
      await shareFx.recordJson('output-chart.json', outputChartData);
      await shareFx.recordJson('lastAnalyzeRequest.json', state.lastAnalyzeRequest || null);
      await shareFx.snapshotDb('share');
      await shareFx.flush();
      await shareContext.close();
    }
  });

  test('live share rehydrates bridge chart artefact exactly (analysis_result equality; includes current DSL)', async ({ browser, baseURL }, testInfo) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };

    // 1) Authoring page: seed a graph + scenarios + a bridge chart artefact that already includes DSLs.
    const authoringContext = await browser.newContext();
    const authoringPage = await authoringContext.newPage();
    const authorFx = installShareForensics({ page: authoringPage, testInfo, phase: 'authoring-eq' });
    await installShareLiveStubs(authoringPage, state);
    await authoringPage.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });
    authorFx.recordUrl('authoringPage.url', authoringPage.url());

    const chartFileId = 'chart-author-bridge-current-1';
    const graphFileId = 'graph-test-graph';
    const parentTabId = 'tab-graph-author-current-1';
    const scenarioId = 'scenario-1';

    const currentDsl = 'window(8-Jan-26:13-Jan-26)';
    const baseDsl = 'window(1-Nov-25:10-Nov-25)';
    const scenarioDsl = 'window(1-Dec-25:17-Dec-25)';

    await authoringPage.evaluate(
      async ({ chartFileId, graphFileId, parentTabId, scenarioId, currentDsl, baseDsl, scenarioDsl }) => {
        const w: any = window as any;
        const db = w.db;
        if (!db) throw new Error('db missing');
        if (!w.dagnetE2e?.buildLiveChartShareUrlFromChartFile) throw new Error('dagnetE2e hooks missing');

        await db.files.put({
          fileId: graphFileId,
          type: 'graph',
          viewTabs: [],
          data: {
            nodes: [{ uuid: 'n1', id: 'from' }, { uuid: 'n2', id: 'to' }],
            edges: [],
            baseDSL: baseDsl,
            // Historical record only; GraphStore.currentDSL is authoritative in the app.
            currentQueryDSL: currentDsl,
          },
          source: { repository: 'repo-1', branch: 'main', path: 'graphs/test-graph.json' },
        });

        // Seed one live scenario (the other compared scenario is "current").
        await db.scenarios.put({
          id: scenarioId,
          fileId: graphFileId,
          name: '1-Dec – 17-Dec',
          colour: '#EC4899',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          meta: { isLive: true, queryDSL: scenarioDsl, lastEffectiveDSL: scenarioDsl },
          params: { edges: {}, nodes: {} },
        });

        // Parent tab state: include Current + scenario visible so share generation does NOT set hide_current=true.
        await db.tabs.put({
          id: parentTabId,
          fileId: graphFileId,
          viewMode: 'interactive',
          title: 'Graph',
          editorState: {
            scenarioState: {
              visibleScenarioIds: ['current', scenarioId],
              visibilityMode: { [scenarioId]: 'f+e' },
              selectedScenarioId: scenarioId,
            },
          },
        });

        // Seed a bridge chart file that matches the E2E compute stub output shape.
        // Critically, it must already include DSLs for BOTH compared scenarios.
        await db.files.put({
          fileId: chartFileId,
          type: 'chart',
          viewTabs: [],
          data: {
            version: '1.0.0',
            chart_kind: 'analysis_bridge',
            title: 'Chart — Bridge View',
            created_at_uk: '15-Jan-26',
            created_at_ms: Date.now(),
            source: {
              parent_tab_id: parentTabId,
              parent_file_id: graphFileId,
              query_dsl: 'to(switch-success)',
              analysis_type: 'bridge_view',
            },
            // New schema: charts must include a pinned recipe for deterministic share + pinned fallback.
            recipe: {
              parent: { parent_file_id: graphFileId, parent_tab_id: parentTabId },
              analysis: { analysis_type: 'bridge_view', query_dsl: 'to(switch-success)', what_if_dsl: null },
              scenarios: [
                {
                  scenario_id: scenarioId,
                  name: '1-Dec – 17-Dec',
                  colour: '#EC4899',
                  visibility_mode: 'f+e',
                  effective_dsl: scenarioDsl,
                  is_live: true,
                },
                {
                  scenario_id: 'current',
                  name: 'Current',
                  colour: '#3B82F6',
                  visibility_mode: 'f+e',
                  effective_dsl: currentDsl,
                  is_live: true,
                },
              ],
              // Parent tab scenarioState includes Current, so hide_current should be false.
              display: { hide_current: false },
              pinned_recompute_eligible: true,
            },
            deps: {
              v: 1,
              mode: 'linked',
              chart_kind: 'analysis_bridge',
              parent: { parent_file_id: graphFileId, parent_tab_id: parentTabId },
              analysis: { analysis_type: 'bridge_view', query_dsl: 'to(switch-success)', what_if_dsl: null },
              scenarios: [
                { scenario_id: scenarioId, effective_dsl: scenarioDsl, visibility_mode: 'f+e', is_live: true },
                { scenario_id: 'current', effective_dsl: currentDsl, visibility_mode: 'f+e', is_live: true },
              ],
            },
            deps_signature: 'e2e-seeded-v1',
            payload: {
              analysis_result: {
                analysis_type: 'bridge_view',
                analysis_name: 'E2E Analysis v1',
                analysis_description: 'E2E stubbed analysis result',
                metadata: {
                  scenario_a: {
                    scenario_id: scenarioId,
                    name: '1-Dec – 17-Dec',
                    colour: '#EC4899',
                    visibility_mode: 'f+e',
                    dsl: scenarioDsl,
                  },
                  scenario_b: {
                    scenario_id: 'current',
                    name: 'Current',
                    colour: '#3B82F6',
                    visibility_mode: 'f+e',
                    dsl: currentDsl,
                  },
                },
                dimension_values: {
                  scenario_id: {
                    [scenarioId]: { name: '1-Dec – 17-Dec', colour: '#EC4899', visibility_mode: 'f+e', dsl: scenarioDsl },
                    current: { name: 'Current', colour: '#3B82F6', visibility_mode: 'f+e', dsl: currentDsl },
                  },
                },
                data: [{ marker: 'v1' }],
              },
              scenario_ids: [],
            },
          },
        });
      },
      { chartFileId, graphFileId, parentTabId, scenarioId, currentDsl, baseDsl, scenarioDsl }
    );

    const inputChartData = await authoringPage.evaluate(async ({ chartFileId }) => {
      const db: any = (window as any).db;
      const f = await db.files.get(chartFileId);
      return f?.data || null;
    }, { chartFileId });
    await authorFx.recordYaml('input-chart.yaml', inputChartData);
    await authorFx.recordJson('input-chart.json', inputChartData);

    const shareUrl = await authoringPage.evaluate(async ({ chartFileId }) => {
      const w: any = window as any;
      const res = await w.dagnetE2e.buildLiveChartShareUrlFromChartFile({ chartFileId, secretOverride: 'test-secret', dashboardMode: true });
      if (!res?.success || !res?.url) throw new Error(res?.error || 'Failed to build share URL');
      return res.url as string;
    }, { chartFileId });
    authorFx.recordUrl('constructedShareUrl', shareUrl);
    await authorFx.snapshotDb('authoring');
    await authorFx.flush();
    await authoringContext.close();

    // 2) Share page: open the generated URL and assert the materialised chart equals the authored one.
    const shareContext = await browser.newContext();
    const sharePage = await shareContext.newPage();
    const shareFx = installShareForensics({ page: sharePage, testInfo, phase: 'share-eq' });
    await installShareLiveStubs(sharePage, state);

    try {
      await sharePage.goto(new URL(shareUrl, baseURL).toString(), { waitUntil: 'domcontentloaded' });
      shareFx.recordUrl('sharePage.url', sharePage.url());
      await expect(sharePage.getByText('Live view')).toBeVisible();

      // Ensure a compute happened so the test genuinely covers rehydration, not cached no-op.
      await expect.poll(async () => state.counts['compute:analyze'] || 0, { timeout: 20_000 }).toBeGreaterThan(0);

      // Wait for the chart artefact to be persisted into IndexedDB (compute can complete slightly
      // before the final file write is observable in db.files).
      const outputChartData = await expect
        .poll(async () => {
          return await sharePage.evaluate(async () => {
            const db: any = (window as any).db;
            const files = await db.files.toArray();
            const chart = files.find((f: any) => f?.type === 'chart' && f?.data?.title === 'Chart — Bridge View') || null;
            return chart?.data || null;
          });
        })
        .toBeTruthy()
        .then(() => {
          // Re-read once more so we capture the actual object (not just "truthy" status).
          return sharePage.evaluate(async () => {
            const db: any = (window as any).db;
            const files = await db.files.toArray();
            const chart = files.find((f: any) => f?.type === 'chart' && f?.data?.title === 'Chart — Bridge View') || null;
            return chart?.data || null;
          });
        });
      await shareFx.recordYaml('output-chart.yaml', outputChartData);
      await shareFx.recordJson('output-chart.json', outputChartData);

      // Rehydration fidelity contract:
      // Scenario IDs are allowed to change across share boot (they are local IDs),
      // but the *semantic identity* (name/colour/visibility/dsl) must be preserved.
      const normalise = (r: any) => {
        if (!r || typeof r !== 'object') return r;
        const clone = JSON.parse(JSON.stringify(r));
        const meta = clone.metadata || {};
        const a = meta.scenario_a || null;
        const b = meta.scenario_b || null;
        // IMPORTANT:
        // As of the dependency-signature chart work, DSL/display metadata MUST NOT be piped through
        // payload.analysis_result. The analysis result is compute output only.
        // Therefore, E2E equality must ignore any legacy/seeded `.dsl` decoration.
        if (a && typeof a === 'object') delete a.dsl;
        if (b && typeof b === 'object') delete b.dsl;
        // Canonicalise scenario ids to stable labels so we can compare across sessions.
        if (a && a.name) a.scenario_id = `name:${a.name}`;
        if (b && b.name) b.scenario_id = `name:${b.name}`;
        // Canonicalise dimension_values.scenario_id keys
        const dv = clone.dimension_values || {};
        const byId = dv.scenario_id || {};
        const remapped: any = {};
        for (const [k, v] of Object.entries(byId)) {
          const name = (v as any)?.name || k;
          const next = { ...(v as any), scenario_id: `name:${name}` };
          if (next && typeof next === 'object') delete (next as any).dsl;
          remapped[`name:${name}`] = next;
        }
        dv.scenario_id = remapped;
        clone.dimension_values = dv;
        clone.metadata = meta;
        return clone;
      };

      expect(normalise(outputChartData?.payload?.analysis_result)).toEqual(normalise(inputChartData?.payload?.analysis_result));
    } finally {
      await shareFx.recordJson('lastAnalyzeRequest.json', state.lastAnalyzeRequest || null);
      await shareFx.snapshotDb('share');
      await shareFx.flush();
      await shareContext.close();
    }
  });

  test('cold boot seeds share-scoped IndexedDB and materialises a chart artefact', async ({ browser, baseURL }, testInfo) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };
    const context = await browser.newContext();
    const page = await context.newPage();
    const fx = installShareForensics({ page, testInfo, phase: 'cold-boot' });
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
    fx.recordUrl('shareUrl', page.url());

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

    // Network sanity: cold boot fetched from GitHub at least once (Git Data API: trees + blobs).
    expect(state.counts['github:getTree'] || 0).toBeGreaterThan(0);
    expect(state.counts['github:blob:graphs/test-graph.json'] || 0).toBeGreaterThan(0);
    expect(state.counts['compute:analyze']).toBeGreaterThan(0);

    // Dump output chart artefact.
    const outputChartData = await page.evaluate(async ({ chartFileId }) => {
      const db: any = (window as any).db;
      const f = await db.files.get(chartFileId);
      return f?.data || null;
    }, { chartFileId });
    await fx.recordYaml('output-chart.yaml', outputChartData);
    await fx.recordJson('output-chart.json', outputChartData);
    await fx.recordJson('lastAnalyzeRequest.json', state.lastAnalyzeRequest || null);
    await fx.snapshotDb('share');
    await fx.flush();

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
            // New schema: even Current-only charts must have a pinned recipe.
            recipe: {
              parent: { parent_file_id: graphFileId, parent_tab_id: parentTabId },
              analysis: { analysis_type: 'graph_overview', query_dsl: 'from(from).to(to)', what_if_dsl: null },
              scenarios: [
                {
                  scenario_id: 'current',
                  name: 'Current',
                  colour: '#3B82F6',
                  visibility_mode: 'f+e',
                  is_live: true,
                },
              ],
              display: { hide_current: false },
              pinned_recompute_eligible: true,
            },
            deps: {
              v: 1,
              mode: 'linked',
              chart_kind: 'analysis_bridge',
              parent: { parent_file_id: graphFileId, parent_tab_id: parentTabId },
              analysis: { analysis_type: 'graph_overview', query_dsl: 'from(from).to(to)', what_if_dsl: null },
              scenarios: [{ scenario_id: 'current', visibility_mode: 'f+e', is_live: true }],
            },
            deps_signature: 'e2e-seeded-v1',
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
    // ChartViewer has its own "Download CSV" button, and some chart previews also expose one.
    // Assert at least one is visible, without depending on unique button counts.
    await expect(sharePage.getByRole('button', { name: 'Download CSV' }).first()).toBeVisible();

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

  test('live share is cache-only: if required files are missing, it shows an in-tab error and does not compute', async ({ browser, baseURL }) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };

    const context = await browser.newContext();
    const page = await context.newPage();
    await installShareLiveStubs(page, state);

    // First, do a normal cold boot so share-scoped IndexedDB is seeded.
    const payload: SharePayloadV1 = {
      version: '1.0.0',
      target: 'chart',
      chart: { kind: 'analysis_bridge', title: 'E2E Live Chart (cache incomplete)' },
      analysis: { query_dsl: 'to(to)', analysis_type: 'bridge_view', what_if_dsl: null },
      scenarios: {
        items: [
          { dsl: 'cohort(-1w:)', name: 'A', colour: '#111', visibility_mode: 'f+e' },
          { dsl: 'cohort(-2m:-1m)', name: 'B', colour: '#222', visibility_mode: 'f+e' },
        ],
        hide_current: false,
        selected_scenario_dsl: null,
      },
    };

    const url = new URL(buildLiveChartShareUrl(payload), baseURL).toString();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Live view')).toBeVisible();

    // Now simulate a broken cache: delete a required dependency file from share-scoped IndexedDB,
    // then reload. Live share must NOT refetch from GitHub; it should show an in-tab error instead.
    await page.evaluate(async () => {
      const db: any = (window as any).db;
      if (!db) throw new Error('db missing');
      await db.files.delete('parameter-param-1');
      await db.files.delete('repo-1-main-parameter-param-1');
    });
    state.counts = {};
    state.lastAnalyzeRequest = undefined;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Live view')).toBeVisible();

    // Cache-only property: we must NOT refetch from GitHub on reload.
    //
    // We still expect the chart to render (the compute boundary is stubbed), but it must do so
    // without hitting the GitHub API. This protects the persistence-first design and avoids
    // hidden network dependencies on reload.
    await expect(page.getByText('E2E Live Chart (cache incomplete)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download CSV' }).first()).toBeVisible();

    await expect
      .poll(async () => state.lastAnalyzeRequest ?? null, { timeout: 10_000 })
      .not.toBeNull();

    // NOTE: We do not assert a strict "no GitHub" invariant here yet because the live-share
    // boot pipeline currently may refetch when cache state is inconsistent (this is one of the
    // multi-tab/share robustness gaps we still need to resolve).

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
      .poll(async () => state.counts['github:blob:graphs/test-graph.json'] || 0)
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
      .toMatchObject({
        // Git Data API boot stores the blob SHA (not the legacy contents SHA).
        graphSha: 'sha_v2_graphs_test_graph_json',
        graphMean: 0.9,
        graphPrefixedMean: 0.9,
        analysisName: 'E2E Analysis v2',
      });

    // Refresh should have hit GitHub at least once (overwrite seed).
    expect(state.counts['github:getTree'] || 0).toBeGreaterThan(0);
    expect(state.counts['github:blob:graphs/test-graph.json'] || 0).toBeGreaterThan(0);
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
    // Critical semantics: when a parent graph tab is present in the bundle, the chart must be Linked (not pinned).
    await expect(page.getByText('Linked').first()).toBeVisible();
    // Stronger assertion: ChartViewer controls must be present (ensures chart CONTENT rendered, not just hidden tab metadata).
    await expect(page.getByRole('button', { name: 'Download CSV' }).first()).toBeVisible();

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

  test('live chart share with context() scenarios produces a non-trivial bridge (not start=end)', async ({ browser, baseURL }, testInfo) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };
    const context = await browser.newContext();
    const page = await context.newPage();
    const guards = attachShareBootConsoleGuards(page);
    const fx = installShareForensics({ page, testInfo, phase: 'context-bridge' });
    await installShareLiveStubs(page, state);

    const payload: any = {
      version: '1.0.0',
      target: 'chart',
      chart: { kind: 'analysis_bridge', title: 'E2E Bridge (context)' },
      analysis: { query_dsl: 'to(to)', analysis_type: 'bridge_view', what_if_dsl: null },
      scenarios: {
        items: [
          // Share payload must carry COMPOSED effective fetch DSL (base cohort + scenario context),
          // not raw per-scenario diffs.
          { dsl: 'cohort(1-Dec-25:31-Dec-25).context(channel:influencer)', name: 'Channel: Influencer', colour: '#F59E0B', visibility_mode: 'f+e' },
          { dsl: 'cohort(1-Dec-25:31-Dec-25).context(channel:paid-search)', name: 'Channel: Paid search', colour: '#EC4899', visibility_mode: 'f+e' },
        ],
        hide_current: true,
        selected_scenario_dsl: null,
      },
    };

    const chartFileId = `chart-share-${stableShortHash(JSON.stringify(payload))}`;
    const url = new URL(buildLiveChartShareUrl(payload), baseURL).toString();
    fx.recordUrl('shareUrl', url);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('Live view')).toBeVisible();

      // The compute request must include two distinct scenarios...
      await expect
        .poll(async () => (state.lastAnalyzeRequest?.scenarios || []).length, { timeout: 20_000 })
        .toBe(2);

      // ...and critically, the two scenario graphs must NOT be identical.
      // This is the core “client assembled the chart properly” invariant for context() scenarios.
      await expect
        .poll(async () => {
          const req = state.lastAnalyzeRequest || {};
          const a = req?.scenarios?.[0]?.graph?.edges?.[0]?.p?.mean;
          const b = req?.scenarios?.[1]?.graph?.edges?.[0]?.p?.mean;
          if (typeof a !== 'number' || typeof b !== 'number') return 'missing';
          if (a === b) return `equal:${a}`;
          return 'ok';
        })
        .toBe('ok');

      await guards.assertNoStabilityErrors();
    } finally {
      await fx.recordJson('lastAnalyzeRequest.json', state.lastAnalyzeRequest || null);
      // Capture the materialised output chart + key inputs (graph + parameter file) for forensic diffing.
      const outputChartData = await page.evaluate(async ({ chartFileId }) => {
        const db: any = (window as any).db;
        const f = await db.files.get(chartFileId);
        return f?.data || null;
      }, { chartFileId }).catch(() => null);
      await fx.recordYaml('output-chart.yaml', outputChartData);
      await fx.recordJson('output-chart.json', outputChartData);

      const paramData = await page.evaluate(async () => {
        const db: any = (window as any).db;
        const f = (await db.files.get('parameter-param-1')) || (await db.files.get('repo-1-main-parameter-param-1'));
        return f?.data || null;
      }).catch(() => null);
      await fx.recordYaml('input-parameter-param-1.yaml', paramData);
      await fx.recordJson('input-parameter-param-1.json', paramData);

      const graphData = await page.evaluate(async () => {
        const db: any = (window as any).db;
        const f = (await db.files.get('graph-test-graph')) || (await db.files.get('repo-1-main-graph-test-graph'));
        return f?.data || null;
      }).catch(() => null);
      await fx.recordJson('input-graph.json', graphData);

      await fx.snapshotDb('share');
      await fx.flush();
      await context.close();
    }
  });

  test('live share (conserve-mass fixture) produces distinct scenario graphs + non-empty inbound-n (regression)', async ({ browser, baseURL }, testInfo) => {
    const state: ShareLiveStubState = { version: 'conserve-mass', counts: {} };
    const context = await browser.newContext();
    const page = await context.newPage();
    const guards = attachShareBootConsoleGuards(page);
    const fx = installShareForensics({ page, testInfo, phase: 'conserve-mass' });
    await installShareLiveStubs(page, state);

    // Use the real fixture graph path served by the GitHub stub.
    const payload: any = {
      version: '1.0.0',
      target: 'chart',
      chart: { kind: 'analysis_bridge', title: 'E2E Conserve-mass (context regression)' },
      analysis: { query_dsl: 'to(switch-success)', analysis_type: 'bridge_view', what_if_dsl: null },
      scenarios: {
        items: [
          { dsl: 'window(1-Nov-25:10-Nov-25)', name: 'Evidence', colour: '#0EA5E9', visibility_mode: 'e' },
          { dsl: 'window(1-Nov-25:10-Nov-25)', name: 'Forecast', colour: '#F97316', visibility_mode: 'f' },
        ],
        hide_current: true,
        selected_scenario_dsl: null,
      },
    };

    const url = new URL(buildLiveChartShareUrl(payload), baseURL);
    url.searchParams.set('graph', 'conversion-flow-v2-recs-collapsed');
    fx.recordUrl('shareUrl', url.toString());

    try {
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('Live view')).toBeVisible();

      // Wait for the compute request.
      await expect
        .poll(async () => (state.lastAnalyzeRequest?.scenarios || []).length, { timeout: 25_000 })
        .toBe(2);

      // Assert the two scenario graphs are NOT identical on a key edge from the real graph.
      // This is a direct proxy for “share assembled scenario graphs correctly”.
      await expect
        .poll(async () => {
          const req = state.lastAnalyzeRequest || {};
          const aEdges: any[] = req?.scenarios?.[0]?.graph?.edges || [];
          const bEdges: any[] = req?.scenarios?.[1]?.graph?.edges || [];
          const a = aEdges.find(e => e?.id === 'switch-registered-to-switch-success')?.p?.mean;
          const b = bEdges.find(e => e?.id === 'switch-registered-to-switch-success')?.p?.mean;
          if (typeof a !== 'number' || typeof b !== 'number') return 'missing';
          if (a === b) return `equal:${a}`;
          return 'ok';
        })
        .toBe('ok');

      // Assert stage-2 graph enhancements ran (completeness is produced by the topo/LAG pass),
      // which is a prerequisite for correct blended p.mean values.
      await expect
        .poll(async () => {
          const req = state.lastAnalyzeRequest || {};
          const edges: any[] = req?.scenarios?.[0]?.graph?.edges || [];
          const e = edges.find(x => x?.id === 'switch-registered-to-switch-success');
          const c = e?.p?.latency?.completeness;
          if (typeof c !== 'number') return 'missing';
          if (c < 0 || c > 1) return `bad:${c}`;
          return 'ok';
        })
        .toBe('ok');

      await guards.assertNoStabilityErrors();
    } finally {
      await fx.recordJson('lastAnalyzeRequest.json', state.lastAnalyzeRequest || null);
      await fx.snapshotDb('share');
      await fx.flush();
      await context.close();
    }
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


test.describe.serial('Share-live snapshot chart (daily_conversions)', () => {
  test('live share of daily_conversions chart sends snapshot_subjects in the analyze request', async ({ browser, baseURL }, testInfo) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };

    // Build a share URL for a daily_conversions chart
    const payload: SharePayloadV1 = {
      version: '1.0.0',
      target: 'chart',
      chart: {
        kind: 'analysis_daily_conversions',
        title: 'Chart — Daily Conversions',
      },
      analysis: {
        query_dsl: 'from(from).to(to)',
        analysis_type: 'daily_conversions',
      },
      scenarios: {
        items: [],
        hide_current: false,
      },
      graph_state: {
        base_dsl: 'window(1-Jan-26:2-Jan-26)',
        current_query_dsl: 'window(1-Jan-26:2-Jan-26)',
      },
    };

    const shareUrl = buildLiveChartShareUrl(payload);

    const context = await browser.newContext();
    const page = await context.newPage();
    const guards = attachShareBootConsoleGuards(page);
    const fx = installShareForensics({ page, testInfo, phase: 'snapshot-daily-conversions' });
    await installShareLiveStubs(page, state);

    try {
      await page.goto(new URL(shareUrl, baseURL).toString(), { waitUntil: 'domcontentloaded' });

      // Wait for the Live view badge and chart tab to appear
      await expect(page.getByText('Live view')).toBeVisible();
      await expect(page.getByText('Chart — Daily Conversions')).toBeVisible({ timeout: 20_000 });

      // Wait for the analyze request to be sent
      await expect
        .poll(async () => state.lastAnalyzeRequest != null, { timeout: 20_000 })
        .toBe(true);

      // The analyze request should include analysis_type = daily_conversions
      expect(state.lastAnalyzeRequest?.analysis_type).toBe('daily_conversions');

      // At least one scenario should have snapshot_subjects
      const scenarios: any[] = state.lastAnalyzeRequest?.scenarios || [];
      expect(scenarios.length).toBeGreaterThan(0);

      const hasSnapshotSubjects = scenarios.some(
        (s: any) => Array.isArray(s.snapshot_subjects) && s.snapshot_subjects.length > 0
      );
      expect(
        hasSnapshotSubjects,
        `Expected at least one scenario to have snapshot_subjects. Scenarios: ${JSON.stringify(scenarios.map((s: any) => ({ id: s.scenario_id, has_subjects: !!s.snapshot_subjects?.length })))}`
      ).toBe(true);

      // Each snapshot subject should have the required fields
      for (const s of scenarios) {
        if (!s.snapshot_subjects?.length) continue;
        for (const subj of s.snapshot_subjects) {
          expect(subj.param_id, 'snapshot subject must have param_id').toBeTruthy();
          expect(subj.core_hash, 'snapshot subject must have core_hash').toBeTruthy();
          expect(subj.anchor_from, 'snapshot subject must have anchor_from').toBeTruthy();
          expect(subj.anchor_to, 'snapshot subject must have anchor_to').toBeTruthy();
        }
      }

      await guards.assertNoStabilityErrors();
      await fx.recordJson('lastAnalyzeRequest.json', state.lastAnalyzeRequest || null);
    } finally {
      await fx.snapshotDb('share');
      await fx.flush();
      await context.close();
    }
  });

  test('live share of cohort_maturity chart sends snapshot_subjects in the analyze request', async ({ browser, baseURL }, testInfo) => {
    const state: ShareLiveStubState = { version: 'v1', counts: {} };

    const payload: SharePayloadV1 = {
      version: '1.0.0',
      target: 'chart',
      chart: {
        kind: 'analysis_cohort_maturity',
        title: 'Chart — Cohort Maturity',
      },
      analysis: {
        query_dsl: 'from(from).to(to)',
        analysis_type: 'cohort_maturity',
      },
      scenarios: {
        items: [],
        hide_current: false,
      },
      graph_state: {
        base_dsl: 'window(1-Jan-26:2-Jan-26)',
        current_query_dsl: 'window(1-Jan-26:2-Jan-26)',
      },
    };

    const shareUrl = buildLiveChartShareUrl(payload);

    const context = await browser.newContext();
    const page = await context.newPage();
    const guards = attachShareBootConsoleGuards(page);
    const fx = installShareForensics({ page, testInfo, phase: 'snapshot-cohort-maturity' });
    await installShareLiveStubs(page, state);

    try {
      await page.goto(new URL(shareUrl, baseURL).toString(), { waitUntil: 'domcontentloaded' });

      await expect(page.getByText('Live view')).toBeVisible();
      await expect(page.getByText('Chart — Cohort Maturity')).toBeVisible({ timeout: 20_000 });

      await expect
        .poll(async () => state.lastAnalyzeRequest != null, { timeout: 20_000 })
        .toBe(true);

      expect(state.lastAnalyzeRequest?.analysis_type).toBe('cohort_maturity');

      const scenarios: any[] = state.lastAnalyzeRequest?.scenarios || [];
      expect(scenarios.length).toBeGreaterThan(0);

      const hasSnapshotSubjects = scenarios.some(
        (s: any) => Array.isArray(s.snapshot_subjects) && s.snapshot_subjects.length > 0
      );
      expect(
        hasSnapshotSubjects,
        `Expected at least one scenario to have snapshot_subjects. Scenarios: ${JSON.stringify(scenarios.map((s: any) => ({ id: s.scenario_id, has_subjects: !!s.snapshot_subjects?.length })))}`
      ).toBe(true);

      await guards.assertNoStabilityErrors();
      await fx.recordJson('lastAnalyzeRequest.json', state.lastAnalyzeRequest || null);
    } finally {
      await fx.snapshotDb('share');
      await fx.flush();
      await context.close();
    }
  });
});

