/**
 * Git Data API — real roundtrip test.
 *
 * Calls the ACTUAL GitHub API against the test branch (feature/bayes-test-graph)
 * in the data repo. Proves that atomicCommitFiles() produces a single atomic
 * commit with multiple files from a Node.js runtime.
 *
 * Requires one of:
 *   - GITHUB_TOKEN + GITHUB_OWNER + GITHUB_REPO env vars (simplest)
 *   - SHARE_JSON or VITE_CREDENTIALS_JSON with full credentials blob
 * Skips gracefully if credentials are not available.
 *
 * This is a SPIKE TEST — it exists to prove the Git Data API sequence works.
 * It writes to a real branch, so it is NOT idempotent and should NOT run in CI.
 */

import { resolve } from 'path';
import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import { atomicCommitFiles } from '../../../api/_lib/git-commit';

// Load graph-editor/.env.vercel into process.env (has VITE_CREDENTIALS_JSON with live token)
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
    // Strip surrounding quotes from Vercel env format
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* .env.vercel may not exist — run `npx vercel env pull .env.vercel` */ }

const TEST_BRANCH = 'feature/bayes-test-graph';

function loadCredentials(): { owner: string; repo: string; token: string } | null {
  // Direct env vars (from .env.local or shell)
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO) {
    return {
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      token: process.env.GITHUB_TOKEN,
    };
  }

  // Credentials JSON blob — prefer VITE_CREDENTIALS_JSON (has fresher token in .env.vercel)
  const json = process.env.VITE_CREDENTIALS_JSON || process.env.SHARE_JSON;
  if (!json) return null;
  try {
    const creds = JSON.parse(json);
    if (!creds.git || creds.git.length === 0) return null;
    const defaultRepo = creds.defaultGitRepo || creds.git[0].name;
    const gitRepo = creds.git.find((r: any) => r.name === defaultRepo) || creds.git[0];
    return { owner: gitRepo.owner, repo: gitRepo.repo || gitRepo.name, token: gitRepo.token };
  } catch {
    return null;
  }
}

describe('atomicCommitFiles — real GitHub roundtrip', () => {
  const creds = loadCredentials();

  it.skipIf(!creds)(
    'should create a single atomic commit with two files on the test branch',
    async () => {
      const { owner, repo, token } = creds!;

      // Verify the test branch exists before attempting commit
      const branchResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${TEST_BRANCH}`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'dagnet-test',
          },
        },
      );
      if (!branchResp.ok) {
        console.log(`Skipping: branch '${TEST_BRANCH}' does not exist (${branchResp.status})`);
        return;
      }

      const timestamp = new Date().toISOString();

      const files = [
        {
          path: '_bayes-spike/roundtrip-1.txt',
          content: `Roundtrip test file 1\nTimestamp: ${timestamp}\n`,
        },
        {
          path: '_bayes-spike/roundtrip-2.txt',
          content: `Roundtrip test file 2\nTimestamp: ${timestamp}\n`,
        },
      ];

      const message =
        `[bayes-spike] Roundtrip test — ${timestamp}\n\n` +
        `Files: ${files.length}\nPurpose: Prove Git Data API works from Node.js`;

      const t0 = Date.now();
      const result = await atomicCommitFiles(owner, repo, TEST_BRANCH, token, files, message);
      const elapsed = Date.now() - t0;

      // Commit SHA is a 40-char hex string
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

      // URL points to the right repo
      expect(result.url).toContain(`${owner}/${repo}`);

      // One blob per file
      expect(result.blob_shas).toHaveLength(2);
      result.blob_shas.forEach(sha => {
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
      });

      // Tree SHA is valid
      expect(result.tree_sha).toMatch(/^[0-9a-f]{40}$/);

      // Should complete well within Vercel timeout budget
      expect(elapsed).toBeLessThan(15_000);

      console.log(
        `Atomic commit OK: ${result.sha.slice(0, 8)} (${elapsed}ms, ${files.length} files)`,
      );

      // --- Verify the commit actually landed by reading it back ---
      const headers = {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'dagnet-test',
      };

      const commitResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/commits/${result.sha}`,
        { headers },
      );
      expect(commitResp.ok).toBe(true);

      const commitData = await commitResp.json();
      expect(commitData.message).toContain('[bayes-spike]');
      expect(commitData.tree.sha).toBe(result.tree_sha);

      // Verify both files exist in the tree
      const treeResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${result.tree_sha}?recursive=true`,
        { headers },
      );
      expect(treeResp.ok).toBe(true);

      const treeData = await treeResp.json();
      const paths = treeData.tree.map((e: any) => e.path);
      expect(paths).toContain('_bayes-spike/roundtrip-1.txt');
      expect(paths).toContain('_bayes-spike/roundtrip-2.txt');
    },
    30_000, // generous timeout for network calls
  );
});
