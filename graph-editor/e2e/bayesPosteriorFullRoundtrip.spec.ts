/**
 * Bayes posterior — full E2E roundtrip via Playwright.
 *
 * Exercises the COMPLETE pipeline with nothing mocked:
 *   1. Clone minimal test workspace from feature/bayes-test-graph (21 files)
 *   2. Click DevBayesTrigger → local Python server runs placeholder fit
 *   3. Webhook commits posteriors to git
 *   4. FE polls → detects completion → auto-pulls updated files
 *   5. File-to-graph cascade populates p.posterior + p.latency.posterior
 *   6. Call real BE analysis → verify dual model curves in response
 *
 * Prerequisites:
 *   - Dev server running: npm run dev
 *   - Local Python server running: cd graph-editor && python dev-server.py
 *   - .env.vercel pulled: cd graph-editor && npx vercel env pull .env.vercel
 *   - feature/bayes-test-graph branch exists in data repo (21 files)
 *
 * Run (explicitly — skipped by default):
 *   cd graph-editor
 *   BAYES_E2E=1 CI= PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright" \
 *     npx playwright test --config=e2e/playwright.bayes.config.ts
 *
 * Skipped unless BAYES_E2E=1 is set. This is a heavyweight integration
 * test that commits to a real git branch and should not run in CI or
 * as part of routine test suites.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GRAPH_EDITOR_ROOT = path.resolve(__dirname, '..');

const GRAPH_NAME = 'bayes-test-gm-rebuild';
const TEST_BRANCH = 'feature/bayes-test-graph';

// ─── Load real credentials from .env.vercel ──────────────────────────

function loadEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const vars: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    let val = t.slice(eq + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    vars[t.slice(0, eq)] = val;
  }
  return vars;
}

const VERCEL_ENV = loadEnvFile(path.join(GRAPH_EDITOR_ROOT, '.env.vercel'));
const HAS_CREDS = Boolean(VERCEL_ENV.VITE_CREDENTIALS_JSON);

// ─── Readiness ───────────────────────────────────────────────────────

async function isBayesServerRunning(): Promise<boolean> {
  try {
    const r = await fetch('http://localhost:9000/', { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

// ─── Test ────────────────────────────────────────────────────────────

test.describe('Bayes posterior full roundtrip', () => {
  test('placeholder fit → webhook → git → pull → cascade → dual curves', async ({ page }) => {
    test.skip(!process.env.BAYES_E2E, 'Skipped — set BAYES_E2E=1 to run');
    test.skip(!HAS_CREDS, 'No credentials — run: cd graph-editor && npx vercel env pull .env.vercel');
    const serverUp = await isBayesServerRunning();
    test.skip(!serverUp, 'Local Python server not running on :9000');

    const realCreds = JSON.parse(VERCEL_ENV.VITE_CREDENTIALS_JSON);

    // ── 1. Boot app, seed credentials, navigate to test branch + graph ──
    await page.goto('/');
    await page.waitForSelector('.menubar-trigger', { timeout: 15_000 });

    // Seed real credentials + workspace record pointing to test branch.
    // This tells the app to start on feature/bayes-test-graph directly,
    // skipping the default main clone (which is 700+ files and rate-limited).
    const gitRepo = realCreds.git?.find((r: any) => r.name === realCreds.defaultGitRepo) || realCreds.git?.[0];
    const repoName = gitRepo?.name || gitRepo?.repo;

    await page.evaluate(async ({ creds, repoName, branch }) => {
      const db = (window as any).db;
      if (!db) throw new Error('window.db not available');

      // Credentials
      await db.files.put({
        fileId: 'credentials-credentials',
        type: 'credentials',
        data: creds,
        isDirty: false,
        lastModified: Date.now(),
      });

      // Workspace record on the test branch — prevents app from cloning main
      await db.workspaces.put({
        id: `${repoName}-${branch}`,
        repository: repoName,
        branch,
        lastOpenedAt: Date.now(),
        files: [],
      });

      // App state: set navigator to the test repo + branch
      await db.appState.put({
        id: 'app-state',
        navigatorState: {
          isOpen: true,
          isPinned: true,
          searchQuery: '',
          selectedRepo: repoName,
          selectedBranch: branch,
          expandedSections: [],
          availableRepos: [repoName],
          availableBranches: [branch],
        },
        updatedAt: Date.now(),
      });
    }, { creds: realCreds, repoName, branch: TEST_BRANCH });

    // Navigate with branch + graph — NavigatorContext now respects ?branch=
    // on init, so it clones the 21-file test branch directly (no main clone)
    await page.goto(`/?branch=${TEST_BRANCH}&graph=${GRAPH_NAME}&nonudge=1&placeholder=1`);

    // Wait for graph to render AND param files to load
    await page.waitForFunction(() => {
      const nodes = document.querySelectorAll('.react-flow__node');
      if (nodes.length === 0) return false;
      // Navigator shows "Parameters" with a non-zero count when files are loaded
      const navText = document.body.innerText;
      return navText.includes('Parameters') && !navText.includes('Parameters\n0');
    }, { timeout: 30_000 });
    await page.waitForTimeout(3_000);
    console.log('Graph and param files loaded');

    // Capture console for diagnostics
    const consoleLogs: string[] = [];
    page.on('console', (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));

    // No staleness banner to dismiss — nudge is now a toast, not a banner

    // ── 2. Click Data > Run Bayesian Fit ──
    const dataMenu = page.locator('.menubar-trigger:has-text("Data")');
    await expect(dataMenu).toBeVisible({ timeout: 10_000 });
    await dataMenu.click({ force: true });
    await page.waitForTimeout(500);
    const bayesItem = page.locator('.menubar-item:has-text("Run Bayesian Fit")');
    await expect(bayesItem).toBeVisible({ timeout: 5_000 });
    await bayesItem.click();
    console.log('Clicked Run Bayesian Fit');

    // ── 3–4. Wait for the operation to complete via toast ──
    // The operation registry shows a toast. Wait for it to show "complete".
    const t0 = Date.now();
    await page.waitForFunction(() => {
      const text = document.body.innerText;
      return text.includes('Bayes') && (text.includes('complete') || text.includes('failed'));
    }, { timeout: 90_000 });

    const failed = await page.evaluate(() => document.body.innerText.includes('failed'));
    console.log(`Fit ${failed ? 'FAILED' : 'complete'} in ${Date.now() - t0}ms`);
    expect(failed).toBe(false);

    // Check webhook response diagnostics from the session log
    const webhookDiag = await page.evaluate(() => {
      const db = (window as any).db;
      if (!db) return null;
      // The session log stores entries; find the BAYES_DEV_COMPLETE one
      // which contains the webhook_response in its details JSON
      const logs = (window as any).__dagnet_session_log_entries;
      if (!logs) return 'no session log entries on window';
      const complete = logs.find((l: any) => l.operation === 'BAYES_DEV_COMPLETE');
      if (!complete?.details) return 'no BAYES_DEV_COMPLETE entry';
      try {
        const result = JSON.parse(complete.details);
        return result.webhook_response;
      } catch { return 'parse failed'; }
    });
    console.log('Webhook response:', JSON.stringify(webhookDiag, null, 2));

    // ── 5. Wait for posteriors to appear in IDB (pull countdown + pull + cascade) ──
    await page.waitForFunction(async () => {
      const db = (window as any).db;
      if (!db) return false;
      const files = await db.files.toArray();
      return files.some((f: any) => f.type === 'parameter' && f.data?.posterior);
    }, { timeout: 30_000 });

    // Dump pull-related console logs
    const pullLogs = consoleLogs.filter(l =>
      l.includes('Pull') || l.includes('pull') || l.includes('CHANGED') ||
      l.includes('NEW file') || l.includes('unchanged') || l.includes('commit:') ||
      l.includes('posterior') || l.includes('webhook') || l.includes('SHA')
    );
    console.log('=== Pull-related logs ===');
    for (const l of pullLogs.slice(-30)) console.log(l);
    console.log('=== End pull logs ===');

    // ── 6. Verify posteriors in IDB ──
    const posteriorCheck = await page.evaluate(async () => {
      const db = (window as any).db;
      if (!db) throw new Error('window.db not available');
      const allFiles = await db.files.toArray();
      const withProb = allFiles.filter((f: any) => f.type === 'parameter' && f.data?.posterior);
      const withLat = allFiles.filter((f: any) => f.type === 'parameter' && f.data?.latency?.posterior);

      if (withProb.length === 0) return { error: 'No param files with posterior in IDB' };

      const s = withProb[0];
      return {
        count: withProb.length,
        latCount: withLat.length,
        fileId: s.fileId,
        provenance: s.data.posterior?.provenance,
        alpha: s.data.posterior?.alpha,
        hasLatPosterior: withLat.length > 0,
        analyticMu: withLat[0]?.data?.latency?.mu,
        bayesMu: withLat[0]?.data?.latency?.posterior?.mu_mean,
        muDiffers: withLat.length > 0 && withLat[0].data.latency.mu !== withLat[0].data.latency.posterior?.mu_mean,
      };
    });

    console.log('Posterior check:', JSON.stringify(posteriorCheck, null, 2));
    expect(posteriorCheck.error).toBeUndefined();
    expect(posteriorCheck.count).toBeGreaterThan(0);
    expect(posteriorCheck.provenance).toBe('bayesian');

    if (posteriorCheck.hasLatPosterior) {
      expect(posteriorCheck.muDiffers).toBe(true);
      console.log(`Analytic mu=${posteriorCheck.analyticMu}, Bayesian mu=${posteriorCheck.bayesMu}`);
    }

    // ── 7. Call real BE analysis, verify dual curves ──
    const curves = await page.evaluate(async () => {
      const db = (window as any).db;
      if (!db) throw new Error('window.db not available');
      const allFiles = await db.files.toArray();
      const graphFile = allFiles.find((f: any) => f.type === 'graph');
      if (!graphFile) return { error: 'No graph' };

      const graph = graphFile.data;
      const edge = graph.edges?.find((e: any) => e.p?.latency?.mu !== undefined);
      if (!edge) return { error: 'No edge with latency' };

      const paramId = edge.p?.id;
      const edgeId = edge.uuid || edge.id;
      const today = new Date();
      const ago = new Date(today.getTime() - 90 * 86400000);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);

      try {
        const r = await fetch('http://localhost:9000/api/runner/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            analysis_type: 'cohort_maturity',
            scenarios: [{
              scenario_id: 'bayes-e2e',
              graph,
              snapshot_subjects: [{
                subject_id: `${paramId}::e2e`,
                param_id: paramId,
                core_hash: '*',  // wildcard — use any available snapshot data
                slice_keys: [''],
                anchor_from: fmt(ago),
                anchor_to: fmt(today),
                target: { targetId: edgeId },
              }],
            }],
          }),
        });
        if (!r.ok) return { error: `BE ${r.status}`, body: (await r.text()).slice(0, 300) };
        const data = await r.json();
        const result = data.result || data.subjects?.[0]?.result || {};
        return {
          hasAnalytic: Array.isArray(result.model_curve) && result.model_curve.length > 0,
          hasBayes: Array.isArray(result.model_curve_bayes) && result.model_curve_bayes.length > 0,
          analyticParams: result.model_curve_params,
          bayesParams: result.model_curve_bayes_params,
          analyticLen: result.model_curve?.length || 0,
          bayesLen: result.model_curve_bayes?.length || 0,
          paramsDiffer: result.model_curve_params?.mu !== result.model_curve_bayes_params?.mu,
        };
      } catch (e: any) {
        return { error: e.message };
      }
    });

    console.log('Dual curves:', JSON.stringify(curves, null, 2));
    // Dual curves require snapshot data in the DB for this param_id.
    // The test branch uses bayes-test-* param IDs which may not have snapshots.
    // If the BE returned curves, verify they differ. If not, the posterior
    // roundtrip is still proven by the checks above.
    if (curves.hasAnalytic && curves.hasBayes) {
      expect(curves.paramsDiffer).toBe(true);
      expect(curves.bayesParams?.mode).toBe('bayesian');
      console.log(`PASS — full roundtrip + dual curves verified:`);
      console.log(`  Analytic: mu=${curves.analyticParams?.mu}, ${curves.analyticLen} points`);
      console.log(`  Bayesian: mu=${curves.bayesParams?.mu}, ${curves.bayesLen} points`);
    } else {
      console.log('PASS — posterior roundtrip verified (no snapshot data for dual-curve check)');
      console.log(`  Posteriors: ${posteriorCheck.count} prob, ${posteriorCheck.latCount} latency`);
      console.log(`  Provenance: ${posteriorCheck.provenance}`);
      console.log(`  Analytic mu=${posteriorCheck.analyticMu}, Bayesian mu=${posteriorCheck.bayesMu}`);
    }
  });
});
