import { expect, Page, test } from '@playwright/test';

const QUERY_START_UK = '1-Apr-26';
const QUERY_END_UK = '7-Apr-26';
const QUERY_RANGE_DSL = `cohort(${QUERY_START_UK}:${QUERY_END_UK})`;
const CHART_FILE_ID = 'chart-e2e-daily-conversions-date-range';
const CHART_TAB_ID = 'tab-chart-e2e-daily-conversions-date-range';
const GRAPH_FILE_ID = 'graph-e2e-daily-conversions-date-range';

test.use({ timezoneId: 'Europe/London' });
test.describe.configure({ timeout: 30_000 });

function buildDailyRows() {
  const rows: Array<Record<string, unknown>> = [];

  for (let i = 0; i < 7; i += 1) {
    const date = `${i + 1}-Apr-26`;
    const x = 1_000 + i * 3;
    const y = 100 + (i % 11);
    const projectedY = y + 12;

    rows.push({
      scenario_id: 'current',
      subject_id: 'edge-start-end',
      date,
      x,
      y,
      rate: y / x,
      evidence_y: y,
      forecast_y: projectedY - y,
      projected_x: x,
      projected_y: projectedY,
      projected_rate: projectedY / x,
      layer: 'evidence',
    });
  }

  return rows;
}

function dailyConversionsResult() {
  return {
    analysis_type: 'daily_conversions',
    analysis_name: 'Daily Conversions',
    analysis_description: 'Daily conversion rate by cohort',
    metadata: {
      source: 'snapshot_db',
      date_range: { from: QUERY_START_UK, to: QUERY_END_UK },
      total_conversions: 6_000,
    },
    semantics: {
      dimensions: [
        { id: 'date', name: 'Cohort date', type: 'time', role: 'primary' },
        { id: 'scenario_id', name: 'Scenario', type: 'scenario', role: 'secondary' },
        { id: 'subject_id', name: 'Subject', type: 'categorical', role: 'filter' },
      ],
      metrics: [
        { id: 'rate', name: 'Conversion rate', type: 'ratio', format: 'percent', role: 'primary' },
        { id: 'x', name: 'Cohort size', type: 'count', format: 'number', role: 'secondary' },
        { id: 'y', name: 'Conversions', type: 'count', format: 'number', role: 'secondary' },
      ],
      chart: { recommended: 'daily_conversions', alternatives: ['table'] },
    },
    dimension_values: {
      scenario_id: {
        current: { name: 'Current', colour: '#3b82f6', visibility_mode: 'f+e' },
      },
      subject_id: {
        'edge-start-end': { name: 'Start -> End', order: 0 },
      },
    },
    data: buildDailyRows(),
  };
}

async function installNetworkGuards(page: Page) {
  await page.route('https://api.github.com/**', (route) => {
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.route('http://127.0.0.1:9000/**', (route) => {
    const url = route.request().url();
    if (url.endsWith('/api/runner/available-analyses')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          analyses: [
            { id: 'daily_conversions', name: 'Daily Conversions', is_primary: true },
          ],
        }),
      });
    }
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: `Unexpected E2E compute call: ${url}` }),
    });
  });
}

async function seedDailyConversionsChart(page: Page) {
  await page.evaluate(async ({ chartFileId, chartTabId, graphFileId, result, queryRangeDsl }) => {
    const db = (window as any).db;
    if (!db) throw new Error('window.db not available; navigate with ?e2e=1 first');

    await db.files.put({
      fileId: graphFileId,
      type: 'graph',
      viewTabs: [],
      data: {
        nodes: [
          { uuid: 'start', id: 'start', label: 'Start', entry: { is_start: true } },
          { uuid: 'end', id: 'end', label: 'End' },
        ],
        edges: [
          {
            uuid: 'edge-start-end',
            id: 'start->end',
            from: 'start',
            to: 'end',
            query: 'from(start).to(end)',
            p: { id: 'edge-start-end', parameter_id: 'edge-start-end', mean: 0.1 },
          },
        ],
        currentQueryDSL: queryRangeDsl,
        baseDSL: queryRangeDsl,
        metadata: { name: 'E2E Daily Conversions Date Range' },
      },
      source: { repository: 'repo-1', branch: 'main', path: 'graphs/e2e-daily-conversions-date-range.json' },
    });

    await db.files.put({
      fileId: chartFileId,
      type: 'chart',
      viewTabs: [chartTabId],
      data: {
        version: '1.0.0',
        chart_kind: 'daily_conversions',
        title: 'Daily Conversions Date Range',
        created_at_uk: '1-Apr-26',
        created_at_ms: Date.now(),
        source: {
          parent_file_id: graphFileId,
          query_dsl: 'from(start).to(end)',
          analysis_type: 'daily_conversions',
        },
        recipe: {
          parent: { parent_file_id: graphFileId },
          analysis: {
            analysis_type: 'daily_conversions',
            query_dsl: 'from(start).to(end)',
            what_if_dsl: null,
          },
          scenarios: [
            {
              scenario_id: 'current',
              name: 'Current',
              colour: '#3b82f6',
              visibility_mode: 'f+e',
              effective_dsl: queryRangeDsl,
              is_live: true,
            },
          ],
          display: { hide_current: false },
          pinned_recompute_eligible: false,
        },
        definition: {
          title: 'Daily Conversions Date Range',
          view_mode: 'chart',
          chart_kind: 'daily_conversions',
          display: {
            aggregate: 'daily',
            animate: false,
            show_legend: false,
            smooth_lines: false,
          },
          recipe: {
            analysis: {
              analysis_type: 'daily_conversions',
              query_dsl: 'from(start).to(end)',
              what_if_dsl: null,
            },
            scenarios: [
              {
                scenario_id: 'current',
                name: 'Current',
                colour: '#3b82f6',
                visibility_mode: 'f+e',
                effective_dsl: queryRangeDsl,
                is_live: true,
              },
            ],
          },
        },
        payload: {
          analysis_result: result,
          scenario_ids: ['current'],
        },
      },
      source: { repository: 'repo-1', branch: 'main', path: 'charts/e2e-daily-conversions-date-range.json' },
    });

    await db.tabs.put({
      id: chartTabId,
      fileId: chartFileId,
      viewMode: 'interactive',
      title: 'Daily Conversions Date Range',
      icon: '',
      closable: true,
      group: 'main-content',
      editorState: {},
    });

    if (typeof db.saveAppState === 'function') {
      await db.saveAppState({ activeTabId: chartTabId, updatedAt: Date.now() });
    }
  }, {
    chartFileId: CHART_FILE_ID,
    chartTabId: CHART_TAB_ID,
    graphFileId: GRAPH_FILE_ID,
    result: dailyConversionsResult(),
    queryRangeDsl: QUERY_RANGE_DSL,
  });
}

async function visibleChartText(page: Page): Promise<string> {
  return page.locator('.chart-viewer-content').evaluate((el) => {
    return Array.from(el.querySelectorAll('svg text'))
      .map((node) => node.textContent || '')
      .join('\n');
  });
}

async function hoverChartBoundary(page: Page, boundary: 'start' | 'end') {
  const chart = page.locator('.chart-viewer-content .echarts-for-react').first();
  const box = await chart.boundingBox();
  if (!box) throw new Error('Chart bounding box not available');

  const xInset = 58;
  const x = boundary === 'start' ? box.x + xInset : box.x + box.width - xInset;
  const y = box.y + box.height * 0.45;
  await page.mouse.move(x, y);
}

test.describe('Daily conversions date range display', () => {
  test('renders BST query boundaries without shifting the visible dates', async ({ page, baseURL }) => {
    await installNetworkGuards(page);

    await page.goto(new URL('/?e2e=1', baseURL!).toString(), { waitUntil: 'domcontentloaded' });
    await seedDailyConversionsChart(page);
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.locator('.chart-viewer-content .echarts-for-react svg')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.chart-viewer-content')).toContainText('Cohort date');

    const axisText = await visibleChartText(page);
    expect.soft(axisText, 'axis should display the query start date').toContain('1-Apr');
    expect.soft(axisText, 'axis should display the query end date').toContain('7-Apr');
    expect.soft(axisText, 'axis should not show the day before the query start').not.toMatch(/31-Mar(?:-26)?/);
    expect.soft(axisText, 'axis should not show the day after the query end').not.toMatch(/8-Apr(?:-26)?/);
    expect.soft(axisText, 'axis should not expose timestamp-shaped labels').not.toMatch(/2026-04-\d{2}T00:00:00Z/);

    await hoverChartBoundary(page, 'start');
    await expect.soft(page.locator('body'), 'tooltip should not shift start to previous day').not.toContainText('31-Mar-26', { timeout: 500 });
    await expect.soft(page.locator('body'), 'tooltip should not expose the raw start timestamp').not.toContainText('2026-04-01T00:00:00Z', { timeout: 500 });

    await hoverChartBoundary(page, 'end');
    await expect.soft(page.locator('body'), 'tooltip should not shift end past the query range').not.toContainText('8-Apr-26', { timeout: 500 });
    await expect.soft(page.locator('body'), 'tooltip should not expose the raw end timestamp').not.toContainText('2026-04-07T00:00:00Z', { timeout: 500 });
  });
});
