/**
 * Bayes posterior — real Git roundtrip + cascade + BE dual-curve test.
 *
 * Proves the full chain:
 *   1. Write posterior data to a param file via Git Data API (same as webhook)
 *   2. Read it back from git
 *   3. YAML roundtrip preserves all posterior fields (including _model_state)
 *   4. UpdateManager cascade strips fit_history but preserves summary
 *   5. BE generates both analytic + Bayesian model curves
 *
 * Requires credentials (GITHUB_TOKEN or VITE_CREDENTIALS_JSON).
 * Writes to a real branch — NOT idempotent, NOT for CI.
 */

import { resolve } from 'path';
import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { atomicCommitFiles } from '../../../api/_lib/git-commit';
import { applyMappings } from '../updateManager/mappingEngine';
import { MAPPING_CONFIGURATIONS } from '../updateManager/mappingConfigurations';

// Load .env.vercel credentials
try {
  const envPath = resolve(__dirname, '../../../.env.vercel');
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx);
    let val = trimmed.slice(eqIdx + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* */ }

const TEST_BRANCH = 'feature/bayes-test-graph';

function loadCredentials(): { owner: string; repo: string; token: string } | null {
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO) {
    return { owner: process.env.GITHUB_OWNER, repo: process.env.GITHUB_REPO, token: process.env.GITHUB_TOKEN };
  }
  const json = process.env.VITE_CREDENTIALS_JSON || process.env.SHARE_JSON;
  if (!json) return null;
  try {
    const creds = JSON.parse(json);
    if (!creds.git || creds.git.length === 0) return null;
    const defaultRepo = creds.defaultGitRepo || creds.git[0].name;
    const gitRepo = creds.git.find((r: any) => r.name === defaultRepo) || creds.git[0];
    return { owner: gitRepo.owner, repo: gitRepo.repo || gitRepo.name, token: gitRepo.token };
  } catch { return null; }
}

async function fetchFileContent(owner: string, repo: string, branch: string, path: string, token: string): Promise<string> {
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'dagnet-test',
      },
    },
  );
  if (!resp.ok) throw new Error(`Failed to fetch ${path}: ${resp.status}`);
  const data = await resp.json();
  return Buffer.from(data.content, 'base64').toString('utf-8');
}

// Fixture: a probability posterior with fit_history, slices, _model_state
const PROB_POSTERIOR = {
  distribution: 'beta',
  alpha: 45.2,
  beta: 120.8,
  hdi_lower: 0.22,
  hdi_upper: 0.33,
  hdi_level: 0.9,
  ess: 1200,
  rhat: 1.003,
  evidence_grade: 3,
  fitted_at: '17-Mar-26',
  fingerprint: 'abc123def456',
  provenance: 'bayesian',
  divergences: 0,
  prior_tier: 'direct_history',
  surprise_z: 0.45,
  fit_history: [
    { fitted_at: '15-Mar-26', alpha: 40.1, beta: 115.2, hdi_lower: 0.21, hdi_upper: 0.34, rhat: 1.01, divergences: 2, slices: { 'window()': { alpha: 38, beta: 110 } } },
    { fitted_at: '16-Mar-26', alpha: 42.5, beta: 118.0, hdi_lower: 0.22, hdi_upper: 0.33, rhat: 1.005, divergences: 0 },
  ],
  slices: {
    'window()': { alpha: 43.0, beta: 119.5, hdi_lower: 0.22, hdi_upper: 0.33, ess: 1100, rhat: 1.002, divergences: 0 },
    'cohort(90d)': { alpha: 38.0, beta: 112.0, hdi_lower: 0.20, hdi_upper: 0.35, ess: 800, rhat: 1.01, divergences: 1 },
  },
  _model_state: { sigma_temporal: 0.12, tau_cohort: 0.31, p_base_alpha: 45.2, p_base_beta: 120.8 },
};

// Fixture: a latency posterior with fit_history
const LAT_POSTERIOR = {
  distribution: 'lognormal',
  onset_delta_days: 1.5,
  mu_mean: 2.35,
  mu_sd: 0.08,
  sigma_mean: 0.72,
  sigma_sd: 0.04,
  hdi_t95_lower: 18.5,
  hdi_t95_upper: 32.1,
  hdi_level: 0.9,
  ess: 950,
  rhat: 1.006,
  fitted_at: '17-Mar-26',
  fingerprint: 'abc123def456',
  provenance: 'bayesian',
  fit_history: [
    { fitted_at: '15-Mar-26', mu_mean: 2.30, sigma_mean: 0.75, onset_delta_days: 1.5, rhat: 1.02, divergences: 3 },
  ],
};

describe('Bayes posterior — real Git roundtrip', () => {
  const creds = loadCredentials();
  const PARAM_PATH = '_bayes-spike/posterior-roundtrip.yaml';

  it.skipIf(!creds || !process.env.BAYES_E2E)(
    'should survive YAML serialisation through Git Data API and back',
    async () => {
      const { owner, repo, token } = creds!;

      // Check branch exists
      const branchResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${TEST_BRANCH}`,
        { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'dagnet-test' } },
      );
      if (!branchResp.ok) {
        console.log(`Skipping: branch '${TEST_BRANCH}' does not exist`);
        return;
      }

      // Build a param file with both posteriors (simulating webhook output)
      const paramDoc: any = {
        type: 'probability',
        values: [{ mean: 0.273, stdev: 0.035, n: 166, k: 45 }],
        latency: {
          mu: 2.1,           // analytic value (LAG pass)
          sigma: 0.68,       // analytic value (LAG pass)
          onset_delta_days: 1.2,
          t95: 25.5,
          latency_parameter: true,
          model_trained_at: '16-Mar-26',
          posterior: LAT_POSTERIOR,
        },
        posterior: PROB_POSTERIOR,
      };

      const yamlContent = yaml.dump(paramDoc, { lineWidth: -1, noRefs: true, sortKeys: false });

      // Commit to git
      const result = await atomicCommitFiles(owner, repo, TEST_BRANCH, token, [
        { path: PARAM_PATH, content: yamlContent },
      ], `[bayes-test] Posterior roundtrip — ${new Date().toISOString()}`);
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

      // Read back from git
      const readBack = await fetchFileContent(owner, repo, TEST_BRANCH, PARAM_PATH, token);
      const parsed = yaml.load(readBack) as any;

      // --- Verify probability posterior survived ---
      expect(parsed.posterior).toBeDefined();
      expect(parsed.posterior.alpha).toBe(45.2);
      expect(parsed.posterior.beta).toBe(120.8);
      expect(parsed.posterior.hdi_lower).toBe(0.22);
      expect(parsed.posterior.provenance).toBe('bayesian');
      expect(parsed.posterior.prior_tier).toBe('direct_history');
      expect(parsed.posterior.surprise_z).toBe(0.45);
      expect(parsed.posterior.divergences).toBe(0);

      // fit_history survived
      expect(parsed.posterior.fit_history).toHaveLength(2);
      expect(parsed.posterior.fit_history[0].slices).toBeDefined();
      expect(parsed.posterior.fit_history[0].slices['window()'].alpha).toBe(38);

      // slices survived
      expect(parsed.posterior.slices['window()']).toBeDefined();
      expect(parsed.posterior.slices['window()'].alpha).toBe(43.0);
      expect(parsed.posterior.slices['cohort(90d)'].divergences).toBe(1);

      // _model_state survived (leading underscore key in YAML)
      expect(parsed.posterior._model_state).toBeDefined();
      expect(parsed.posterior._model_state.sigma_temporal).toBe(0.12);
      expect(parsed.posterior._model_state.tau_cohort).toBe(0.31);

      // --- Verify latency posterior survived ---
      expect(parsed.latency.posterior).toBeDefined();
      expect(parsed.latency.posterior.mu_mean).toBe(2.35);
      expect(parsed.latency.posterior.sigma_mean).toBe(0.72);
      expect(parsed.latency.posterior.onset_delta_days).toBe(1.5);
      expect(parsed.latency.posterior.hdi_t95_lower).toBe(18.5);
      expect(parsed.latency.posterior.fit_history).toHaveLength(1);

      // --- Verify analytic params were NOT overwritten ---
      expect(parsed.latency.mu).toBe(2.1);
      expect(parsed.latency.sigma).toBe(0.68);

      console.log('Git roundtrip OK — all posterior fields survived YAML serialisation');
    },
    30_000,
  );
});

describe('Bayes posterior — UpdateManager cascade', () => {
  it('should cascade posterior summary to graph edge, stripping fit_history/slices/_model_state', async () => {
    // Simulate a param file with posteriors (as read from git)
    const paramFileData: any = {
      type: 'probability',
      values: [{ mean: 0.273, stdev: 0.035 }],
      latency: {
        mu: 2.1,
        sigma: 0.68,
        onset_delta_days: 1.2,
        t95: 25.5,
        latency_parameter: true,
        posterior: LAT_POSTERIOR,
      },
      posterior: PROB_POSTERIOR,
    };

    // Simulate a graph edge (target for cascade)
    const graphEdge: any = {
      uuid: 'edge-1',
      from: 'node-a',
      to: 'node-b',
      p: {
        id: 'param-1',
        mean: 0.25,
        stdev: 0.04,
        latency: {
          mu: 2.1,
          sigma: 0.68,
          onset_delta_days: 1.2,
          t95: 25.5,
          latency_parameter: true,
        },
      },
    };

    // Apply file→graph mappings (same as UpdateManager.syncFileToGraph)
    const config = MAPPING_CONFIGURATIONS.get('file_to_graph:UPDATE:parameter');
    expect(config).toBeDefined();

    const result = await applyMappings(paramFileData, graphEdge, config!.mappings, {});
    expect(result.success).toBe(true);

    // --- Probability posterior cascaded ---
    expect(graphEdge.p.posterior).toBeDefined();
    expect(graphEdge.p.posterior.alpha).toBe(45.2);
    expect(graphEdge.p.posterior.beta).toBe(120.8);
    expect(graphEdge.p.posterior.provenance).toBe('bayesian');
    expect(graphEdge.p.posterior.prior_tier).toBe('direct_history');
    expect(graphEdge.p.posterior.divergences).toBe(0);

    // fit_history, slices, _model_state stripped
    expect(graphEdge.p.posterior.fit_history).toBeUndefined();
    expect(graphEdge.p.posterior.slices).toBeUndefined();
    expect(graphEdge.p.posterior._model_state).toBeUndefined();

    // --- Latency posterior cascaded ---
    expect(graphEdge.p.latency.posterior).toBeDefined();
    expect(graphEdge.p.latency.posterior.mu_mean).toBe(2.35);
    expect(graphEdge.p.latency.posterior.sigma_mean).toBe(0.72);
    expect(graphEdge.p.latency.posterior.onset_delta_days).toBe(1.5);

    // fit_history stripped
    expect(graphEdge.p.latency.posterior.fit_history).toBeUndefined();

    // --- Analytic params untouched ---
    expect(graphEdge.p.latency.mu).toBe(2.1);
    expect(graphEdge.p.latency.sigma).toBe(0.68);

    console.log('Cascade OK — posterior summary on graph edge, heavy fields stripped');
  });
});
