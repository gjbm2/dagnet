import type { Page, Route } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export type RemoteStateVersion = 'v1' | 'v2' | 'conserve-mass';

// E2E TS config does not include Node typings; Buffer exists at runtime.
declare const Buffer: any;

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

function formatDateUK(d: Date): string {
  const day = d.getUTCDate();
  const month = d.getUTCMonth();
  const year = d.getUTCFullYear() % 100;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const yy = year.toString().padStart(2, '0');
  return `${day}-${months[month]}-${yy}`;
}

function buildUKDateRangeInclusive(startUtcYmd: string, endUtcYmd: string): string[] {
  const [sy, sm, sd] = startUtcYmd.split('-').map(n => Number(n));
  const [ey, em, ed] = endUtcYmd.split('-').map(n => Number(n));
  const start = new Date(Date.UTC(sy, sm - 1, sd));
  const end = new Date(Date.UTC(ey, em - 1, ed));
  const dates: string[] = [];
  const cur = new Date(start);
  while (cur.getTime() <= end.getTime()) {
    dates.push(formatDateUK(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
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

let conserveMassCache:
  | {
      baseDir: string;
      readText: (relPath: string) => string | null;
    }
  | null = null;

function getConserveMassFixtures(): { readText: (relPath: string) => string | null } {
  if (conserveMassCache) return conserveMassCache;

  // Playwright runs from graph-editor/, fixtures live in repo-level docs/.
  const baseDir = path.join(process.cwd(), '..', 'docs', 'current', 'project-conserve-mass');

  const readText = (relPath: string): string | null => {
    try {
      const p = path.join(baseDir, relPath);
      if (!fs.existsSync(p)) return null;
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };

  conserveMassCache = { baseDir, readText };
  return conserveMassCache;
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
      const sha =
        state.version === 'v1'
          ? 'sha_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          : state.version === 'v2'
            ? 'sha_v2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
            : 'sha_conserve_mass_cccccccccccccccccccccccccccccc';
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

      // Shared repo settings (forecasting knobs)
      if (path === 'settings/settings.yaml') {
        const content = [
          'version: 1.0.0',
          'forecasting:',
          '  # Company-wide defaults for analytics behaviour',
          `  RECENCY_HALF_LIFE_DAYS: 30`,
          '',
        ].join('\n');
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            githubFileResponse({
              path,
              sha: `sha_${state.version}_settings_settings_yaml`.slice(0, 40),
              contentUtf8: content,
            })
          ),
        });
      }

      // Conserve-mass fixture repo: serve a realistic graph + indices + params/nodes/events/contexts.
      if (state.version === 'conserve-mass') {
        const fx = getConserveMassFixtures();

        const content =
          path === 'graphs/conversion-flow-v2-recs-collapsed.json'
            ? (() => {
                const raw = fx.readText('graphs/conversion-flow-v2-recs-collapsed.json');
                if (!raw) return null;
                // E2E normalisation: prefer a window() base so from-file loads have a stable targetSlice
                // that exists across all parameters (avoids fixture cohort sparsity).
                try {
                  const g = JSON.parse(raw);
                  if (typeof g?.currentQueryDSL === 'string' && g.currentQueryDSL.trim()) {
                    g.baseDSL = g.currentQueryDSL;
                  }
                  return JSON.stringify(g);
                } catch {
                  return raw;
                }
              })()
            : path === 'parameters-index.yaml'
              ? fx.readText('parameters-index.yaml')
              : path === 'nodes-index.yaml'
                ? fx.readText('nodes-index.yaml')
                : path === 'events-index.yaml'
                  ? fx.readText('events-index.yaml')
                  : path === 'contexts-index.yaml'
                    ? [
                        'contexts:',
                        '  - id: channel',
                        '    file_path: contexts/channel.yaml',
                        '',
                      ].join('\n')
                    : path.startsWith('parameters/')
                      ? fx.readText(path)
                      : path.startsWith('nodes/')
                        ? fx.readText(path)
                        : path.startsWith('events/')
                          ? fx.readText(path)
                          : path === 'contexts/channel.yaml'
                            ? [
                                'id: channel',
                                'name: Channel',
                                'description: Channel context',
                                'type: categorical',
                                'otherPolicy: computed',
                                'values:',
                                '  - id: influencer',
                                '    label: Influencer',
                                '  - id: paid-search',
                                '    label: Paid search',
                                '  - id: paid-social',
                                '    label: Paid social',
                                '  - id: other',
                                '    label: Other',
                                '',
                              ].join('\n')
                            : null;

        if (content) {
          if (path === 'graphs/conversion-flow-v2-recs-collapsed.json') {
            inc(state, 'github:graph:conserve-mass');
            state.lastServedGraphVersion = state.version;
          }
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(
              githubFileResponse({
                path,
                sha: `sha_${state.version}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`.slice(0, 40),
                contentUtf8: content,
              })
            ),
          });
        }
      }

      // Graph JSON
      if (path === 'graphs/test-graph.json') {
        inc(state, `github:graph:${state.version}`);
        const graph =
          state.version === 'v1'
            ? {
                nodes: [{ uuid: 'n1', id: 'from' }, { uuid: 'n2', id: 'to' }],
                edges: [{ uuid: 'e1', id: 'edge-1', from: 'n1', to: 'n2', p: { id: 'param-1', mean: 0.5 } }],
                currentQueryDSL: 'window(1-Jan-26:2-Jan-26)',
                baseDSL: 'window(1-Jan-26:2-Jan-26)',
                metadata: { name: 'test-graph', e2e_marker: 'v1' },
              }
            : {
                nodes: [{ uuid: 'n1', id: 'from' }, { uuid: 'n2', id: 'to' }],
                edges: [{ uuid: 'e1', id: 'edge-1', from: 'n1', to: 'n2', p: { id: 'param-1', mean: 0.9 } }],
                currentQueryDSL: 'window(1-Jan-26:2-Jan-26)',
                baseDSL: 'window(1-Jan-26:2-Jan-26)',
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
        // Include contexted slices so share-boot scenario regeneration can differentiate
        // context(channel:influencer) vs context(channel:paid-search) using from-file aggregation.
        const meanInfluencer = state.version === 'v1' ? 0.2 : 0.3;
        const meanPaid = state.version === 'v1' ? 0.8 : 0.7;
        const n = 100;
        const kInfluencer = Math.round(meanInfluencer * n);
        const kPaid = Math.round(meanPaid * n);
        const meanUncontexted = state.version === 'v1' ? 0.5 : 0.6;
        const kUncontexted = Math.round(meanUncontexted * n);
        const cohortDates = buildUKDateRangeInclusive('2025-11-15', '2026-01-15');
        const cohortDecDates = buildUKDateRangeInclusive('2025-12-01', '2025-12-31');
        const yaml = [
          'id: param-1',
          'name: Param 1',
          'type: probability',
          'query: from(from).to(to)',
          'values:',
          // Uncontexted WINDOW slice (supports window() and also acts as a backstop for some cohort flows).
          `  - mean: ${meanUncontexted}`,
          `    n: ${n}`,
          `    k: ${kUncontexted}`,
          '    window_from: 1-Jan-26',
          '    window_to: 2-Jan-26',
          '    dates:',
          '      - 1-Jan-26',
          '      - 2-Jan-26',
          '    n_daily:',
          `      - ${n}`,
          `      - ${n}`,
          '    k_daily:',
          `      - ${kUncontexted}`,
          `      - ${kUncontexted}`,
          '    sliceDSL: window(1-Jan-26:2-Jan-26)',
          // Uncontexted WINDOW slice for a December range (used by bridge rehydration-equality tests).
          `  - mean: ${meanUncontexted}`,
          `    n: ${n}`,
          `    k: ${kUncontexted}`,
          '    window_from: 1-Dec-25',
          '    window_to: 17-Dec-25',
          '    dates:',
          '      - 1-Dec-25',
          '      - 17-Dec-25',
          '    n_daily:',
          `      - ${n}`,
          `      - ${n}`,
          '    k_daily:',
          `      - ${kUncontexted}`,
          `      - ${kUncontexted}`,
          '    sliceDSL: window(1-Dec-25:17-Dec-25)',
          // Uncontexted COHORT slice (supports cohort() scenarios like cohort(-1m:)).
          `  - mean: ${meanUncontexted}`,
          `    n: ${n}`,
          `    k: ${kUncontexted}`,
          '    cohort_from: 15-Nov-25',
          '    cohort_to: 15-Jan-26',
          '    dates:',
          ...cohortDates.map(d => `      - ${d}`),
          '    n_daily:',
          ...cohortDates.map(() => `      - ${n}`),
          '    k_daily:',
          ...cohortDates.map(() => `      - ${kUncontexted}`),
          '    sliceDSL: cohort(15-Nov-25:15-Jan-26)',
          // Contexted COHORT slices (needed when the target DSL includes BOTH context() and cohort()).
          // Note ordering: dataOperationsService logs targetSlice as "context(...).cohort(...)" in this flow.
          `  - mean: ${meanInfluencer}`,
          `    n: ${n}`,
          `    k: ${kInfluencer}`,
          '    cohort_from: 1-Dec-25',
          '    cohort_to: 31-Dec-25',
          '    dates:',
          ...cohortDecDates.map(d => `      - ${d}`),
          '    n_daily:',
          ...cohortDecDates.map(() => `      - ${n}`),
          '    k_daily:',
          ...cohortDecDates.map(() => `      - ${kInfluencer}`),
          '    sliceDSL: context(channel:influencer).cohort(1-Dec-25:31-Dec-25)',
          `  - mean: ${meanPaid}`,
          `    n: ${n}`,
          `    k: ${kPaid}`,
          '    cohort_from: 1-Dec-25',
          '    cohort_to: 31-Dec-25',
          '    dates:',
          ...cohortDecDates.map(d => `      - ${d}`),
          '    n_daily:',
          ...cohortDecDates.map(() => `      - ${n}`),
          '    k_daily:',
          ...cohortDecDates.map(() => `      - ${kPaid}`),
          '    sliceDSL: context(channel:paid-search).cohort(1-Dec-25:31-Dec-25)',
          `  - mean: ${meanInfluencer}`,
          `    n: ${n}`,
          `    k: ${kInfluencer}`,
          '    window_from: 1-Jan-26',
          '    window_to: 2-Jan-26',
          '    dates:',
          '      - 1-Jan-26',
          '      - 2-Jan-26',
          '    n_daily:',
          `      - ${n}`,
          `      - ${n}`,
          '    k_daily:',
          `      - ${kInfluencer}`,
          `      - ${kInfluencer}`,
          '    sliceDSL: window(1-Jan-26:2-Jan-26).context(channel:influencer)',
          `  - mean: ${meanPaid}`,
          `    n: ${n}`,
          `    k: ${kPaid}`,
          '    window_from: 1-Jan-26',
          '    window_to: 2-Jan-26',
          '    dates:',
          '      - 1-Jan-26',
          '      - 2-Jan-26',
          '    n_daily:',
          `      - ${n}`,
          `      - ${n}`,
          '    k_daily:',
          `      - ${kPaid}`,
          `      - ${kPaid}`,
          '    sliceDSL: window(1-Jan-26:2-Jan-26).context(channel:paid-search)',
          '',
        ].join('\n');
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

      // contexts-index.yaml (used for context definitions / MECE policies)
      if (path === 'contexts-index.yaml') {
        const yaml = [
          'contexts:',
          '  - id: channel',
          '    file_path: contexts/channel.yaml',
          '',
        ].join('\n');
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            githubFileResponse({
              path,
              sha: state.version === 'v1' ? 'cindex_sha_v1' : 'cindex_sha_v2',
              contentUtf8: yaml,
            })
          ),
        });
      }

      // contexts/channel.yaml
      if (path === 'contexts/channel.yaml') {
        const yaml = [
          'id: channel',
          'name: Channel',
          'description: Channel context',
          'type: categorical',
          'otherPolicy: computed',
          'values:',
          '  - id: influencer',
          '    label: Influencer',
          '  - id: paid-search',
          '    label: Paid search',
          '',
        ].join('\n');
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            githubFileResponse({
              path,
              sha: state.version === 'v1' ? 'ctx_channel_sha_v1' : 'ctx_channel_sha_v2',
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

