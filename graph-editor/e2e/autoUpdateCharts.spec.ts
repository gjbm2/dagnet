import { test, expect } from '@playwright/test';

test.describe.configure({ timeout: 120_000 });

async function installComputeStub(page: any, state: { analyzeCount: number }) {
  await page.route('**/api/runner/analyze', async (route: any) => {
    state.analyzeCount++;
    let req: any = null;
    try {
      req = route.request().postDataJSON();
    } catch {
      req = null;
    }
    const analysisType = req?.analysis_type || 'graph_overview';
    const scenarioIds: string[] = Array.isArray(req?.scenarios) ? req.scenarios.map((s: any) => s?.scenario_id).filter(Boolean) : [];
    try {
      (state as any).lastScenarioIds = scenarioIds;
    } catch {
      // ignore
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        result: {
          analysis_type: analysisType,
          analysis_name: `E2E recomputed #${state.analyzeCount}`,
          analysis_description: 'E2E stubbed analysis result',
          metadata: {},
          dimension_values: {},
          data: [{ marker: state.analyzeCount }],
        },
      }),
    });
  });
}

async function seedWorkspaceChart(args: {
  page: any;
  graphFileId: string;
  chartFileId: string;
  chartTitle: string;
  chartKind: 'analysis_funnel' | 'analysis_bridge';
  parentFileId: string;
  // Pinned by default for workspace E2E: omit parent_tab_id so refresh uses DB-only path.
  scenarioDefs: Array<{
    scenario_id: string;
    is_live: boolean;
    effective_dsl?: string | null;
    name?: string;
    colour?: string;
    visibility_mode?: 'f+e' | 'f' | 'e';
  }>;
  hideCurrent: boolean;
  pinnedRecomputeEligible: boolean;
  autoUpdateEnabled: boolean;
}) {
  const { page, ...seed } = args;
  await page.evaluate(async (seed: any) => {
    const w: any = window as any;
    const db = w.db;
    if (!db) throw new Error('db missing');

    // Ensure app-state exists and set the auto-update preference (workspace mode).
    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ autoUpdateChartsEnabled: Boolean(seed.autoUpdateEnabled), updatedAt: Date.now() });
    }

    await db.files.put({
      fileId: seed.graphFileId,
      type: 'graph',
      viewTabs: [],
      data: { nodes: [{ uuid: 'n1', id: 'from' }, { uuid: 'n2', id: 'to' }], edges: [] },
      source: { repository: 'repo-1', branch: 'main', path: 'graphs/test-graph.json' },
    });

    // Seed scenarios in DB (used for names/colours fallback in recompute).
    for (const s of seed.scenarioDefs) {
      if (s.scenario_id === 'base' || s.scenario_id === 'current') continue;
      await db.scenarios.put({
        id: s.scenario_id,
        fileId: seed.graphFileId,
        name: s.name || s.scenario_id,
        colour: s.colour || '#999999',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
        params: { edges: {}, nodes: {} },
        meta: { isLive: Boolean(s.is_live), queryDSL: s.effective_dsl || '', lastEffectiveDSL: s.effective_dsl || '' },
      });
    }

    const recipeScenarios = seed.scenarioDefs.map((s: any) => ({
      scenario_id: s.scenario_id,
      name: s.name,
      colour: s.colour,
      visibility_mode: s.visibility_mode || 'f+e',
      effective_dsl: s.effective_dsl || undefined,
      is_live: Boolean(s.is_live),
    }));

    await db.files.put({
      fileId: seed.chartFileId,
      type: 'chart',
      viewTabs: [],
      data: {
        version: '1.0.0',
        chart_kind: seed.chartKind,
        title: seed.chartTitle,
        created_at_uk: '18-Jan-26',
        created_at_ms: Date.now(),
        source: {
          parent_file_id: seed.graphFileId,
          // IMPORTANT: pinned for this suite by default (no parent_tab_id)
          query_dsl: 'from(from).to(to)',
          analysis_type: 'graph_overview',
        },
        recipe: {
          parent: { parent_file_id: seed.graphFileId },
          analysis: { analysis_type: 'graph_overview', query_dsl: 'from(from).to(to)', what_if_dsl: null },
          scenarios: recipeScenarios,
          display: { hide_current: Boolean(seed.hideCurrent) },
          pinned_recompute_eligible: Boolean(seed.pinnedRecomputeEligible),
        },
        deps: {
          v: 1,
          mode: 'pinned',
          chart_kind: seed.chartKind,
          parent: { parent_file_id: seed.graphFileId },
          analysis: { analysis_type: 'graph_overview', query_dsl: 'from(from).to(to)', what_if_dsl: null },
          scenarios: recipeScenarios.map((s: any) => ({
            scenario_id: s.scenario_id,
            effective_dsl: s.effective_dsl || undefined,
            visibility_mode: s.visibility_mode || 'f+e',
            is_live: Boolean(s.is_live),
          })),
        },
        // Force staleness so refresh must recompute and update the artefact.
        deps_signature: 'e2e-stale',
        payload: {
          analysis_result: {
            analysis_type: 'graph_overview',
            analysis_name: 'E2E seeded',
            analysis_description: 'Seeded chart data',
            metadata: {},
            dimension_values: {},
            data: [{ marker: 0 }],
          },
          scenario_ids: recipeScenarios.map((s: any) => s.scenario_id),
        },
      },
    });

    // Seed an open tab for the chart so recomputeOpenChartsForGraph can discover it.
    await db.tabs.put({
      id: 'tab-chart-1',
      fileId: seed.chartFileId,
      viewMode: 'interactive',
      title: seed.chartTitle,
      icon: '',
      closable: true,
      group: 'main-content',
    });
    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ activeTabId: 'tab-chart-1', updatedAt: Date.now() });
    }
  }, seed);
}

async function getChartAnalysisName(page: any, chartFileId: string): Promise<string | null> {
  return await page.evaluate(async ({ chartFileId }: any) => {
    const db: any = (window as any).db;
    if (!db) return null;
    const f = await db.files.get(chartFileId);
    return f?.data?.payload?.analysis_result?.analysis_name || null;
  }, { chartFileId });
}

async function getChartRecipeScenarioIds(page: any, chartFileId: string): Promise<string[]> {
  return await page.evaluate(async ({ chartFileId }: any) => {
    const db: any = (window as any).db;
    if (!db) return [];
    const f = await db.files.get(chartFileId);
    const items = f?.data?.recipe?.scenarios || [];
    return Array.isArray(items) ? items.map((s: any) => s?.scenario_id).filter(Boolean) : [];
  }, { chartFileId });
}

test('workspace pinned refresh recomputes when eligible (scenario + Current; funnel)', async ({ page, baseURL }) => {
  const state: any = { analyzeCount: 0, lastScenarioIds: null };
  await installComputeStub(page, state);

  await page.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });

  await seedWorkspaceChart({
    page,
    graphFileId: 'graph-e2e-1',
    parentFileId: 'graph-e2e-1',
    chartFileId: 'chart-e2e-funnel-scn-current',
    chartTitle: 'Chart — E2E Funnel (scenario + Current)',
    chartKind: 'analysis_funnel',
    scenarioDefs: [
      { scenario_id: 's-live', is_live: true, effective_dsl: 'cohort(-1w:)', name: 'Live', colour: '#111', visibility_mode: 'f+e' },
      { scenario_id: 'current', is_live: true, effective_dsl: 'window(1-Dec-25:2-Dec-25)', name: 'Current', colour: '#3B82F6', visibility_mode: 'f+e' },
    ],
    hideCurrent: false,
    pinnedRecomputeEligible: true,
    autoUpdateEnabled: false,
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Chart — E2E Funnel (scenario + Current)').first()).toBeVisible();

  expect(await getChartAnalysisName(page, 'chart-e2e-funnel-scn-current')).toBe('E2E seeded');

  await page.getByRole('button', { name: 'Refresh' }).click();

  await expect
    .poll(async () => await getChartAnalysisName(page, 'chart-e2e-funnel-scn-current'))
    .toBe('E2E recomputed #1');

  expect(state.lastScenarioIds).toEqual(['s-live', 'current']);
  expect(await getChartRecipeScenarioIds(page, 'chart-e2e-funnel-scn-current')).toEqual(['s-live', 'current']);
});

test('workspace pinned refresh recomputes when eligible (just Current; bridge)', async ({ page, baseURL }) => {
  const state: any = { analyzeCount: 0, lastScenarioIds: null };
  await installComputeStub(page, state);

  await page.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });

  await seedWorkspaceChart({
    page,
    graphFileId: 'graph-e2e-2',
    parentFileId: 'graph-e2e-2',
    chartFileId: 'chart-e2e-bridge-current-only',
    chartTitle: 'Chart — E2E Bridge (Current only)',
    chartKind: 'analysis_bridge',
    scenarioDefs: [{ scenario_id: 'current', is_live: true, effective_dsl: 'window(8-Jan-26:13-Jan-26)', name: 'Current', colour: '#3B82F6', visibility_mode: 'f+e' }],
    hideCurrent: false,
    pinnedRecomputeEligible: true,
    autoUpdateEnabled: true,
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Chart — E2E Bridge (Current only)').first()).toBeVisible();

  await page.getByRole('button', { name: 'Refresh' }).click();

  await expect
    .poll(async () => await getChartAnalysisName(page, 'chart-e2e-bridge-current-only'))
    .toBe('E2E recomputed #1');

  expect(state.lastScenarioIds).toEqual(['current']);
  expect(await getChartRecipeScenarioIds(page, 'chart-e2e-bridge-current-only')).toEqual(['current']);
});

test('workspace pinned refresh recomputes when eligible (only scenarios; hide Current; bridge)', async ({ page, baseURL }) => {
  const state: any = { analyzeCount: 0, lastScenarioIds: null };
  await installComputeStub(page, state);

  await page.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });

  await seedWorkspaceChart({
    page,
    graphFileId: 'graph-e2e-3',
    parentFileId: 'graph-e2e-3',
    chartFileId: 'chart-e2e-bridge-only-scenarios',
    chartTitle: 'Chart — E2E Bridge (only scenarios)',
    chartKind: 'analysis_bridge',
    scenarioDefs: [
      { scenario_id: 's-a', is_live: true, effective_dsl: 'cohort(-1w:)', name: 'A', colour: '#111', visibility_mode: 'e' },
      { scenario_id: 's-b', is_live: true, effective_dsl: 'cohort(-2m:-1m)', name: 'B', colour: '#222', visibility_mode: 'f' },
    ],
    hideCurrent: true,
    pinnedRecomputeEligible: true,
    autoUpdateEnabled: true,
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Chart — E2E Bridge (only scenarios)').first()).toBeVisible();

  await page.getByRole('button', { name: 'Refresh' }).click();

  await expect
    .poll(async () => await getChartAnalysisName(page, 'chart-e2e-bridge-only-scenarios'))
    .toBe('E2E recomputed #1');

  expect(state.lastScenarioIds).toEqual(['s-a', 's-b']);
  expect(await getChartRecipeScenarioIds(page, 'chart-e2e-bridge-only-scenarios')).toEqual(['s-a', 's-b']);
});

test('workspace pinned refresh is blocked when recipe is not eligible (mixed live + snapshot)', async ({ page, baseURL }) => {
  const state: any = { analyzeCount: 0, lastScenarioIds: null };
  await installComputeStub(page, state);

  await page.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });

  await seedWorkspaceChart({
    page,
    graphFileId: 'graph-e2e-4',
    parentFileId: 'graph-e2e-4',
    chartFileId: 'chart-e2e-mixed-not-eligible',
    chartTitle: 'Chart — E2E Mixed (not eligible)',
    chartKind: 'analysis_funnel',
    scenarioDefs: [
      { scenario_id: 's-live', is_live: true, effective_dsl: 'cohort(-1w:)', name: 'Live', colour: '#111', visibility_mode: 'f+e' },
      { scenario_id: 's-snap', is_live: false, effective_dsl: null, name: 'Snapshot', colour: '#999', visibility_mode: 'f+e' },
    ],
    hideCurrent: true,
    pinnedRecomputeEligible: false,
    autoUpdateEnabled: true,
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Chart — E2E Mixed (not eligible)').first()).toBeVisible();

  const before = await getChartAnalysisName(page, 'chart-e2e-mixed-not-eligible');
  await page.getByRole('button', { name: 'Refresh' }).click();
  // Give any queued work time; pinned refresh should return early and not call compute.
  await page.waitForTimeout(500);

  expect(state.analyzeCount).toBe(0);
  expect(await getChartAnalysisName(page, 'chart-e2e-mixed-not-eligible')).toBe(before);
});

test('workspace pinned refresh preserves order for base + current (bridge)', async ({ page, baseURL }) => {
  const state: any = { analyzeCount: 0, lastScenarioIds: null };
  await installComputeStub(page, state);

  await page.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });

  await seedWorkspaceChart({
    page,
    graphFileId: 'graph-e2e-5',
    parentFileId: 'graph-e2e-5',
    chartFileId: 'chart-e2e-base-current',
    chartTitle: 'Chart — E2E (base + current)',
    chartKind: 'analysis_bridge',
    scenarioDefs: [
      { scenario_id: 'base', is_live: true, effective_dsl: 'window(1-Nov-25:10-Nov-25)', name: 'Base', colour: '#999999', visibility_mode: 'f+e' },
      { scenario_id: 'current', is_live: true, effective_dsl: 'window(1-Dec-25:17-Dec-25)', name: 'Current', colour: '#3B82F6', visibility_mode: 'f+e' },
    ],
    hideCurrent: false,
    pinnedRecomputeEligible: true,
    autoUpdateEnabled: false,
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Chart — E2E (base + current)').first()).toBeVisible();

  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect
    .poll(async () => await getChartAnalysisName(page, 'chart-e2e-base-current'))
    .toBe('E2E recomputed #1');

  expect(state.lastScenarioIds).toEqual(['base', 'current']);
  expect(await getChartRecipeScenarioIds(page, 'chart-e2e-base-current')).toEqual(['base', 'current']);
});

test('workspace pinned refresh preserves order for base + scenario(s) (funnel)', async ({ page, baseURL }) => {
  const state: any = { analyzeCount: 0, lastScenarioIds: null };
  await installComputeStub(page, state);

  await page.goto(new URL('/?e2e=1', baseURL).toString(), { waitUntil: 'domcontentloaded' });

  await seedWorkspaceChart({
    page,
    graphFileId: 'graph-e2e-6',
    parentFileId: 'graph-e2e-6',
    chartFileId: 'chart-e2e-base-scn',
    chartTitle: 'Chart — E2E (base + scenarios)',
    chartKind: 'analysis_funnel',
    scenarioDefs: [
      { scenario_id: 'base', is_live: true, effective_dsl: 'window(1-Nov-25:10-Nov-25)', name: 'Base', colour: '#999999', visibility_mode: 'f+e' },
      { scenario_id: 's-live', is_live: true, effective_dsl: 'cohort(-1w:)', name: 'Live', colour: '#111', visibility_mode: 'e' },
    ],
    hideCurrent: true,
    pinnedRecomputeEligible: true,
    autoUpdateEnabled: false,
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Chart — E2E (base + scenarios)').first()).toBeVisible();

  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect
    .poll(async () => await getChartAnalysisName(page, 'chart-e2e-base-scn'))
    .toBe('E2E recomputed #1');

  expect(state.lastScenarioIds).toEqual(['base', 's-live']);
  expect(await getChartRecipeScenarioIds(page, 'chart-e2e-base-scn')).toEqual(['base', 's-live']);
});


