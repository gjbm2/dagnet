import { test, expect } from '@playwright/test';
import { installShareLiveStubs, type ShareLiveStubState } from './support/shareLiveStubs';

test.describe.configure({ timeout: 120_000 });

function buildLiveScenarioShareUrl(args: {
  repo: 'repo-1' | 'repo-2';
  scenariosDsl: string;
  selectedScenarioDsl?: string;
}) {
  const params = new URLSearchParams();
  params.set('mode', 'live');
  params.set('e2e', '1');
  params.set('repo', args.repo);
  params.set('branch', 'main');
  params.set('graph', 'test-graph');
  // E2E: provide credentials via URL creds to avoid env-secret dependence.
  params.set(
    'creds',
    JSON.stringify({
      defaultGitRepo: args.repo,
      git: [
        {
          name: args.repo,
          owner: 'owner-1',
          repo: args.repo,
          token: 'test-token',
          branch: 'main',
          basePath: '',
        },
      ],
    })
  );
  // IMPORTANT: URLSearchParams will encode values. Do not double-encode.
  params.set('scenarios', args.scenariosDsl);
  if (args.selectedScenarioDsl) params.set('selectedscenario', args.selectedScenarioDsl);
  return `/?${params.toString()}`;
}

test('Scenario URL params: creates live scenarios deterministically (share-live)', async ({ browser, baseURL }) => {
  const state: ShareLiveStubState = { version: 'v1', counts: {} };
  const context = await browser.newContext();
  const page = await context.newPage();
  await installShareLiveStubs(page, state);

  const dsl1 = 'window(-2w:-1w)';
  const dsl2 = 'window(-3w:-2w)';
  const url = new URL(
    buildLiveScenarioShareUrl({ repo: 'repo-1', scenariosDsl: `${dsl1};${dsl2}`, selectedScenarioDsl: dsl2 }),
    baseURL
  ).toString();

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Live view')).toBeVisible();

  // Assert persistence: scenarios with the given DSLs exist in the share DB.
  await expect
    .poll(async () => {
      return await page.evaluate(async ({ dsl1, dsl2 }) => {
        const db: any = (window as any).db;
        if (!db) return { ok: false, reason: 'no-db' };
        const all = await db.scenarios.toArray();
        const dsls = all.map((s: any) => s?.meta?.queryDSL).filter((x: any) => typeof x === 'string');
        return {
          ok: dsls.includes(dsl1) && dsls.includes(dsl2),
          dbName: db.name,
          dsls,
        };
      }, { dsl1, dsl2 });
    })
    .toMatchObject({
      ok: true,
      dbName: expect.stringContaining('DagNetGraphEditorShare:'),
    });

  await context.close();
});

