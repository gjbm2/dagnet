/**
 * Atomic multi-file commit via the GitHub Git Data API.
 *
 * This module encapsulates the 6-step Git Data API sequence for creating a
 * single commit that updates multiple files atomically:
 *
 *   1. getRef       — current branch HEAD SHA
 *   2. getCommit    — base tree SHA from HEAD commit
 *   3. createBlob   — one blob per file (parallel)
 *   4. createTree   — new tree referencing all blobs
 *   5. createCommit — single commit object
 *   6. updateRef    — advance branch HEAD
 *
 * Designed for Node.js (Vercel serverless). Uses Buffer for base64 encoding
 * (no btoa/atob). Uses global fetch (Node 18+).
 *
 * See: docs/current/project-bayes/4-async-roundtrip-infrastructure.md §3A
 */

export interface CommitFile {
  /** Repository-relative path, e.g. "parameters/my-param.yaml" */
  path: string;
  /** UTF-8 file content */
  content: string;
}

export interface CommitResult {
  /** SHA of the new commit */
  sha: string;
  /** GitHub web URL for the commit */
  url: string;
  /** SHAs of created blobs (same order as input files) */
  blob_shas: string[];
  /** SHA of the new tree */
  tree_sha: string;
}

interface GitHubHeaders {
  Authorization: string;
  Accept: string;
  'User-Agent': string;
  'Content-Type'?: string;
}

/**
 * Make a GitHub API request with error handling.
 */
async function ghFetch<T = any>(
  url: string,
  headers: GitHubHeaders,
  options?: { method?: string; body?: any },
): Promise<T> {
  const resp = await fetch(url, {
    method: options?.method ?? 'GET',
    headers: {
      ...headers,
      ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    const err = new Error(
      `GitHub API ${options?.method ?? 'GET'} ${url} returned ${resp.status}: ${errText}`,
    );
    (err as any).status = resp.status;
    (err as any).body = errText;
    throw err;
  }

  return resp.json() as Promise<T>;
}

/**
 * Create an atomic multi-file commit on a GitHub branch.
 *
 * All files are committed in a single commit — no intermediate commits are
 * visible, even if the operation includes dozens of files.
 *
 * @param owner     - Repository owner (org or user)
 * @param repo      - Repository name
 * @param branch    - Target branch name (e.g. "main", "feature/bayes-test-graph")
 * @param token     - GitHub personal access token or fine-grained token with contents:write
 * @param files     - Files to create/update (must have at least one)
 * @param message   - Commit message
 * @returns         - Commit result with SHA and URL
 *
 * @throws Error if any GitHub API call fails
 */
export async function atomicCommitFiles(
  owner: string,
  repo: string,
  branch: string,
  token: string,
  files: CommitFile[],
  message: string,
): Promise<CommitResult> {
  if (files.length === 0) {
    throw new Error('atomicCommitFiles: at least one file is required');
  }

  const MAX_RETRIES = 3;
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;
  const headers: GitHubHeaders = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'dagnet-bayes-webhook',
  };

  // 3. Create blobs for each file (parallel — all independent).
  // Blobs are content-addressable and immutable, so they're created once
  // and reused across retries.
  const blobPromises = files.map(file =>
    ghFetch<{ sha: string }>(
      `${baseUrl}/git/blobs`,
      headers,
      {
        method: 'POST',
        body: {
          content: Buffer.from(file.content, 'utf-8').toString('base64'),
          encoding: 'base64',
        },
      },
    ),
  );
  const blobs = await Promise.all(blobPromises);
  const blobShas = blobs.map(b => b.sha);

  const treeEntries = files.map((file, i) => ({
    path: file.path,
    mode: '100644' as const,  // regular file
    type: 'blob' as const,
    sha: blobShas[i],
  }));

  // Steps 1-2, 4-6 are retried on fast-forward failure (HTTP 422).
  // This handles the race where another commit lands between reading
  // the ref and updating it.
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // 1. Get current branch HEAD SHA
    const ref = await ghFetch<{ object: { sha: string } }>(
      `${baseUrl}/git/ref/heads/${branch}`,
      headers,
    );
    const headSha = ref.object.sha;

    // 2. Get the commit to find the base tree SHA
    const commit = await ghFetch<{ tree: { sha: string } }>(
      `${baseUrl}/git/commits/${headSha}`,
      headers,
    );
    const baseTreeSha = commit.tree.sha;

    // 4. Create a new tree with all the updated blobs
    const tree = await ghFetch<{ sha: string }>(
      `${baseUrl}/git/trees`,
      headers,
      {
        method: 'POST',
        body: {
          base_tree: baseTreeSha,
          tree: treeEntries,
        },
      },
    );
    const newTreeSha = tree.sha;

    // 5. Create the commit
    const newCommit = await ghFetch<{ sha: string; html_url: string }>(
      `${baseUrl}/git/commits`,
      headers,
      {
        method: 'POST',
        body: {
          message,
          tree: newTreeSha,
          parents: [headSha],
        },
      },
    );

    // 6. Update the branch ref to point to the new commit
    try {
      await ghFetch(
        `${baseUrl}/git/refs/heads/${branch}`,
        headers,
        {
          method: 'PATCH',
          body: {
            sha: newCommit.sha,
          },
        },
      );
    } catch (err: any) {
      // 422 = "Update is not a fast forward" — branch moved since step 1.
      // Retry from step 1 with fresh ref.
      if (err.status === 422 && attempt < MAX_RETRIES - 1) {
        continue;
      }
      throw err;
    }

    return {
      sha: newCommit.sha,
      url: newCommit.html_url,
      blob_shas: blobShas,
      tree_sha: newTreeSha,
    };
  }

  // Should be unreachable — the last attempt throws on failure.
  throw new Error('atomicCommitFiles: exhausted retries');
}
