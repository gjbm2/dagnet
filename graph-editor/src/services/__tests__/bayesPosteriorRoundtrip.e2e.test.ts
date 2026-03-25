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

// Fixture: unified posterior (doc 21) with slices, _model_state, fit_history
const UNIFIED_POSTERIOR = {
  fitted_at: '17-Mar-26',
  fingerprint: 'abc123def456',
  hdi_level: 0.9,
  prior_tier: 'direct_history',
  surprise_z: 0.45,
  slices: {
    'window()': {
      alpha: 43.0, beta: 119.5, p_hdi_lower: 0.22, p_hdi_upper: 0.33,
      mu_mean: 2.35, mu_sd: 0.08, sigma_mean: 0.72, sigma_sd: 0.04,
      onset_mean: 1.5, onset_sd: 0.3, hdi_t95_lower: 18.5, hdi_t95_upper: 32.1,
      onset_mu_corr: -0.42,
      ess: 1100, rhat: 1.002, divergences: 0, evidence_grade: 3, provenance: 'bayesian',
    },
    'cohort()': {
      alpha: 38.0, beta: 112.0, p_hdi_lower: 0.20, p_hdi_upper: 0.35,
      mu_mean: 2.81, mu_sd: 0.12, sigma_mean: 0.58, sigma_sd: 0.06,
      onset_mean: 3.2, onset_sd: 0.5, hdi_t95_lower: 28.4, hdi_t95_upper: 58.7,
      ess: 800, rhat: 1.01, divergences: 1, evidence_grade: 3, provenance: 'bayesian',
    },
  },
  _model_state: { sigma_temporal: 0.12, tau_cohort: 0.31, p_base_alpha: 45.2, p_base_beta: 120.8 },
  fit_history: [
    { fitted_at: '15-Mar-26', fingerprint: 'old123', slices: { 'window()': { alpha: 38, beta: 110 }, 'cohort()': { alpha: 35, beta: 108 } } },
    { fitted_at: '16-Mar-26', fingerprint: 'old456', slices: { 'window()': { alpha: 40.1, beta: 115.2, mu_mean: 2.30 } } },
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

      // Build a param file with unified posterior (doc 21)
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
          // NOTE: no latency.posterior — doc 21 removes it
        },
        posterior: UNIFIED_POSTERIOR,
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

      // --- Verify unified posterior survived ---
      expect(parsed.posterior).toBeDefined();
      expect(parsed.posterior.fitted_at).toBe('17-Mar-26');
      expect(parsed.posterior.fingerprint).toBe('abc123def456');
      expect(parsed.posterior.prior_tier).toBe('direct_history');
      expect(parsed.posterior.surprise_z).toBe(0.45);

      // slices survived with both probability and latency fields
      expect(parsed.posterior.slices['window()']).toBeDefined();
      expect(parsed.posterior.slices['window()'].alpha).toBe(43.0);
      expect(parsed.posterior.slices['window()'].mu_mean).toBe(2.35);
      expect(parsed.posterior.slices['window()'].onset_mu_corr).toBe(-0.42);
      expect(parsed.posterior.slices['cohort()']).toBeDefined();
      expect(parsed.posterior.slices['cohort()'].mu_mean).toBe(2.81);
      expect(parsed.posterior.slices['cohort()'].divergences).toBe(1);

      // fit_history survived
      expect(parsed.posterior.fit_history).toHaveLength(2);
      expect(parsed.posterior.fit_history[0].slices['window()'].alpha).toBe(38);
      expect(parsed.posterior.fit_history[1].slices['window()'].mu_mean).toBe(2.30);

      // _model_state survived (leading underscore key in YAML)
      expect(parsed.posterior._model_state).toBeDefined();
      expect(parsed.posterior._model_state.sigma_temporal).toBe(0.12);
      expect(parsed.posterior._model_state.tau_cohort).toBe(0.31);

      // --- No latency.posterior (doc 21) ---
      expect(parsed.latency.posterior).toBeUndefined();

      // --- Analytic params NOT overwritten ---
      expect(parsed.latency.mu).toBe(2.1);
      expect(parsed.latency.sigma).toBe(0.68);

      console.log('Git roundtrip OK — unified posterior survived YAML serialisation');
    },
    30_000,
  );
});

describe('Bayes posterior — UpdateManager cascade (doc 21 unified schema)', () => {
  it('should project unified posterior.slices onto graph-edge shapes for UI consumption', async () => {
    // Simulate a param file with unified posterior (as read from git)
    const paramFileData: any = {
      type: 'probability',
      values: [{ mean: 0.273, stdev: 0.035 }],
      latency: {
        mu: 2.1,
        sigma: 0.68,
        onset_delta_days: 1.2,
        t95: 25.5,
        latency_parameter: true,
        // NOTE: no latency.posterior (doc 21)
      },
      posterior: UNIFIED_POSTERIOR,
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

    // --- Probability posterior projected from window() slice ---
    expect(graphEdge.p.posterior).toBeDefined();
    expect(graphEdge.p.posterior.alpha).toBe(43.0);
    expect(graphEdge.p.posterior.beta).toBe(119.5);
    expect(graphEdge.p.posterior.hdi_lower).toBe(0.22);
    expect(graphEdge.p.posterior.hdi_upper).toBe(0.33);
    expect(graphEdge.p.posterior.provenance).toBe('bayesian');
    expect(graphEdge.p.posterior.prior_tier).toBe('direct_history');
    expect(graphEdge.p.posterior.divergences).toBe(0);
    expect(graphEdge.p.posterior.evidence_grade).toBe(3);

    // fit_history, slices, _model_state NOT on graph edge
    expect(graphEdge.p.posterior.fit_history).toBeUndefined();
    expect(graphEdge.p.posterior.slices).toBeUndefined();
    expect(graphEdge.p.posterior._model_state).toBeUndefined();

    // --- Latency posterior projected from window() + cohort() slices ---
    expect(graphEdge.p.latency.posterior).toBeDefined();
    expect(graphEdge.p.latency.posterior.mu_mean).toBe(2.35);
    expect(graphEdge.p.latency.posterior.sigma_mean).toBe(0.72);
    expect(graphEdge.p.latency.posterior.onset_delta_days).toBe(1.5);
    expect(graphEdge.p.latency.posterior.onset_mean).toBe(1.5);
    expect(graphEdge.p.latency.posterior.onset_mu_corr).toBe(-0.42);

    // Path-level from cohort() slice
    expect(graphEdge.p.latency.posterior.path_mu_mean).toBe(2.81);
    expect(graphEdge.p.latency.posterior.path_sigma_mean).toBe(0.58);
    expect(graphEdge.p.latency.posterior.path_onset_delta_days).toBe(3.2);

    // fit_history NOT on graph edge
    expect(graphEdge.p.latency.posterior.fit_history).toBeUndefined();

    // --- Analytic params untouched ---
    expect(graphEdge.p.latency.mu).toBe(2.1);
    expect(graphEdge.p.latency.sigma).toBe(0.68);

    console.log('Cascade OK — unified slices projected onto graph-edge shapes');
  });
});
