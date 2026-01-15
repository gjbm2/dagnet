import type { Page, Route } from '@playwright/test';

export type RemoteStateVersion = 'v1' | 'v2';

export interface ShareLiveStubState {
  version: RemoteStateVersion;
  counts: Record<string, number>;
  lastServedGraphMean?: number;
  lastServedGraphVersion?: RemoteStateVersion;
  lastAnalyzeRequest?: any;
  forceAnalyzeStatus?: number;
}

function inc(state: ShareLiveStubState, key: string) {
  state.counts[key] = (state.counts[key] || 0) + 1;
}

function base64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function githubFileResponse(args: {
  path: string;
  sha: string;
  contentUtf8: string;
  encoding?: 'base64';
}) {
  return {
    name: args.path.split('/').pop(),
    path: args.path,
    sha: args.sha,
    size: args.contentUtf8.length,
    url: `https://api.github.com/repos/owner-1/repo-1/contents/${args.path}`,
    html_url: `https://github.com/owner-1/repo-1/blob/main/${args.path}`,
    git_url: `https://api.github.com/repos/owner-1/repo-1/git/blobs/${args.sha}`,
    download_url: null,
    type: 'file',
    content: base64(args.contentUtf8),
    encoding: args.encoding || 'base64',
  };
}

export async function installShareLiveStubs(page: Page, state: ShareLiveStubState) {
  // GitHub API (fetch-based requests in gitService, and Octokit requests).
  await page.route('https://api.github.com/**', async (route: Route) => {
    const url = route.request().url();

    // 1) Remote HEAD SHA (Octokit git.getRef → /git/ref/heads/<branch>)
    //
    // Octokit may URL-encode the ref (e.g. "heads%2Fmain") depending on the route it uses.
    // Accept both forms.
    if (url.includes('/git/ref/heads/') || url.includes('/git/ref/heads%2F')) {
      inc(state, 'github:getRef');
      inc(state, `github:getRef:${state.version}`);
      const sha = state.version === 'v1' ? 'sha_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : 'sha_v2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ref: 'refs/heads/main',
          object: { sha, type: 'commit', url: 'https://api.github.com/repos/owner-1/repo-1/git/commits/' + sha },
        }),
      });
    }

    // 2) File content fetches (gitService.getFile → /contents/<path>?ref=<branch>)
    if (url.includes('/contents/')) {
      // Extract the "contents/<path>?ref=..." part.
      const m = url.match(/\/contents\/(.+?)(\?|$)/);
      const path = m?.[1] ? decodeURIComponent(m[1]) : '';
      inc(state, `github:contents:${path}`);

      // Graph JSON
      if (path === 'graphs/test-graph.json') {
        inc(state, `github:graph:${state.version}`);
        const graph =
          state.version === 'v1'
            ? {
                nodes: [{ uuid: 'n1', id: 'from' }, { uuid: 'n2', id: 'to' }],
                edges: [{ uuid: 'e1', id: 'edge-1', from: 'n1', to: 'n2', p: { id: 'param-1', mean: 0.5 } }],
                metadata: { name: 'test-graph', e2e_marker: 'v1' },
              }
            : {
                nodes: [{ uuid: 'n1', id: 'from' }, { uuid: 'n2', id: 'to' }],
                edges: [{ uuid: 'e1', id: 'edge-1', from: 'n1', to: 'n2', p: { id: 'param-1', mean: 0.9 } }],
                metadata: { name: 'test-graph', e2e_marker: 'v2' },
              };

        state.lastServedGraphVersion = state.version;
        state.lastServedGraphMean = (graph as any)?.edges?.[0]?.p?.mean;

        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            githubFileResponse({
              path,
              sha: state.version === 'v1' ? 'graph_sha_v1' : 'graph_sha_v2',
              contentUtf8: JSON.stringify(graph),
            })
          ),
        });
      }

      // parameters-index.yaml (used for path resolution)
      if (path === 'parameters-index.yaml') {
        const yaml = [
          'parameters:',
          '  - id: param-1',
          '    file_path: parameters/param-1.yaml',
          '',
        ].join('\n');
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            githubFileResponse({
              path,
              sha: state.version === 'v1' ? 'pindex_sha_v1' : 'pindex_sha_v2',
              contentUtf8: yaml,
            })
          ),
        });
      }

      // parameters/param-1.yaml
      if (path === 'parameters/param-1.yaml') {
        inc(state, `github:param-1:${state.version}`);
        const yaml =
          state.version === 'v1'
            ? ['id: param-1', 'type: probability', 'query: from(from).to(to)', 'values:', '  - date: 1-Jan-26', '    mean: 0.5', ''].join('\n')
            : ['id: param-1', 'type: probability', 'query: from(from).to(to)', 'values:', '  - date: 1-Jan-26', '    mean: 0.9', ''].join('\n');
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            githubFileResponse({
              path,
              sha: state.version === 'v1' ? 'param_sha_v1' : 'param_sha_v2',
              contentUtf8: yaml,
            })
          ),
        });
      }

      // Unknown content path → 404 (forces our code to tolerate missing, as in real repos).
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not found' }) });
    }

    // Default GitHub endpoints: return 404 to catch unexpected calls.
    inc(state, 'github:unexpected');
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Unexpected GitHub call', url }) });
  });

  // Compute API (GraphComputeClient)
  await page.route('http://127.0.0.1:9000/**', async (route: Route) => {
    const url = route.request().url();

    if (url.endsWith('/api/runner/analyze')) {
      inc(state, 'compute:analyze');
      inc(state, `compute:analyze:${state.version}`);
      const analysisName = state.version === 'v1' ? 'E2E Analysis v1' : 'E2E Analysis v2';

      // Capture request so E2E can assert scenario names/colours/modes precisely.
      try {
        const body = route.request().postData();
        state.lastAnalyzeRequest = body ? JSON.parse(body) : null;
      } catch {
        state.lastAnalyzeRequest = null;
      }

      // For correctness tests, echo scenario display metadata back into the response
      // so the chart layer can render stable labels.
      const req = state.lastAnalyzeRequest || {};
      const reqScenarios: any[] = Array.isArray(req?.scenarios) ? req.scenarios : [];

      if (typeof state.forceAnalyzeStatus === 'number') {
        return route.fulfill({
          status: state.forceAnalyzeStatus,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'E2E forced analyze failure' }),
        });
      }

      // IMPORTANT: mirror real API contract.
      // The runner rejects empty scenario lists with a 400.
      if (reqScenarios.length === 0) {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ detail: "Missing 'scenarios' field" }),
        });
      }
      const a = reqScenarios[0] || null;
      const b = reqScenarios[1] || null;

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          result: {
            analysis_type: req?.analysis_type || 'graph_overview',
            analysis_name: analysisName,
            analysis_description: 'E2E stubbed analysis result',
            metadata: {
              scenario_a: a
                ? {
                    scenario_id: a.scenario_id,
                    name: a.name,
                    colour: a.colour,
                    visibility_mode: a.visibility_mode,
                  }
                : null,
              scenario_b: b
                ? {
                    scenario_id: b.scenario_id,
                    name: b.name,
                    colour: b.colour,
                    visibility_mode: b.visibility_mode,
                  }
                : null,
            },
            dimension_values: {
              scenario_id: Object.fromEntries(
                reqScenarios.map(s => [
                  s.scenario_id,
                  { name: s.name, colour: s.colour, visibility_mode: s.visibility_mode },
                ])
              ),
            },
            data: [{ marker: state.version }],
          },
        }),
      });
    }

    inc(state, 'compute:unexpected');
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Unexpected compute call', url }) });
  });
}

