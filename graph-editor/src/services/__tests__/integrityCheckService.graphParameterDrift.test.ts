/**
 * IntegrityCheckService – graph ↔ parameter file drift detection
 *
 * Purpose:
 * - Direct vs versioned operations can legitimately consult different persisted sources:
 *   - Direct: graph edge config
 *   - Versioned: parameter file config
 * - If those persisted configs drift, behaviour diverges.
 *
 * This test asserts that the Graph Issues / Integrity report flags drift for:
 * - query / n_query
 * - connection settings
 * - latency config including t95/path_t95 + override flags
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi } from 'vitest';
import { IntegrityCheckService } from '../integrityCheckService';

vi.mock('../../db/appDatabase', () => {
  const files: any[] = [];
  return {
    db: {
      files: {
        toArray: vi.fn(async () => files),
      },
      __setFiles: (next: any[]) => {
        files.length = 0;
        files.push(...next);
      },
    },
  };
});

vi.mock('../logFileService', () => ({
  LogFileService: {
    createLogFile: vi.fn(async () => {}),
  },
}));

vi.mock('../../lib/credentials', () => ({
  credentialsManager: {
    loadCredentials: vi.fn(async () => ({ success: true, credentials: { providers: {} } })),
  },
}));

const { db } = await import('../../db/appDatabase');

describe('IntegrityCheckService graph↔parameter drift', () => {
  it('reports drift for shared persisted parameter-backed fields (including t95/path_t95)', async () => {
    (db as any).__setFiles([
      {
        fileId: 'graph-g1',
        type: 'graph',
        source: { repository: 'repo', branch: 'main', path: 'graphs/g1.yaml' },
        data: {
          schema_version: '1.1.0',
          metadata: { version: '1.0.0', created_at: '2025-12-15T00:00:00.000Z' },
          policies: { default_outcome: 'success' },
          nodes: [
            { id: 'A', uuid: 'A', label: 'A', layout: { x: 0, y: 0 } },
            { id: 'B', uuid: 'B', label: 'B', layout: { x: 0, y: 0 } },
          ],
          edges: [
            {
              id: 'e1',
              uuid: 'e1',
              from: 'A',
              to: 'B',
              query: 'from(a).to(b)',
              query_overridden: true,
              n_query: 'from(a).to(b)',
              n_query_overridden: false,
              p: {
                id: 'p1',
                connection: 'amplitude-prod',
                connection_string: '{"x":1}',
                latency: {
                  latency_parameter: true,
                  latency_parameter_overridden: false,
                  anchor_node_id: 'A',
                  anchor_node_id_overridden: false,
                  t95: 13.12,
                  t95_overridden: false,
                  path_t95: 40,
                  path_t95_overridden: false,
                },
              },
              // conditional_p should also be drift-checked (it uses parameter-backed p objects)
              conditional_p: [
                {
                  case_id: 'c1',
                  query: 'from(a).to(b).visited(x)',
                  p: {
                    id: 'p2',
                    connection: 'amplitude-prod',
                    connection_string: '{"x":1}',
                    latency: {
                      latency_parameter: true,
                      t95: 13.12,
                      path_t95: 40,
                    },
                  },
                },
              ],
            },
          ],
        },
      },
      {
        fileId: 'parameter-p1',
        type: 'parameter',
        source: { repository: 'repo', branch: 'main', path: 'parameters/p1.yaml' },
        data: {
          id: 'p1',
          name: 'P1',
          type: 'probability',
          metadata: { created_at: '2025-12-15T00:00:00.000Z', updated_at: '2025-12-15T00:00:00.000Z' },
          // Drift fields:
          query: 'from(a).to(c)',
          query_overridden: false,
          n_query: 'from(a).to(c)',
          n_query_overridden: true,
          connection: 'amplitude-staging',
          connection_string: '{"x":2}',
          latency: {
            latency_parameter: true,
            latency_parameter_overridden: true,
            anchor_node_id: 'A',
            anchor_node_id_overridden: true,
            t95: 10,
            t95_overridden: true,
            path_t95: 26,
            path_t95_overridden: true,
          },
          values: [{ mean: 0.5 }],
        },
      },
      {
        fileId: 'parameter-p2',
        type: 'parameter',
        source: { repository: 'repo', branch: 'main', path: 'parameters/p2.yaml' },
        data: {
          id: 'p2',
          name: 'P2',
          type: 'probability',
          metadata: { created_at: '2025-12-15T00:00:00.000Z', updated_at: '2025-12-15T00:00:00.000Z' },
          // Deliberately omit query/n_query to exercise "missing-vs-present drift" (info severity)
          connection: 'amplitude-staging',
          connection_string: '{"x":2}',
          latency: {
            latency_parameter: true,
            t95: 10,
            path_t95: 26,
          },
          values: [{ mean: 0.5 }],
        },
      },
    ]);

    const result = await IntegrityCheckService.checkIntegrity({} as any, false);

    const driftIssues = result.issues.filter(i => i.category === 'sync' && i.message.includes('Graph ↔ parameter drift'));
    expect(driftIssues.length).toBeGreaterThan(0);

    // Ensure key new latency fields are covered
    const hasT95 = driftIssues.some(i => i.message.includes('latency.t95'));
    const hasPathT95 = driftIssues.some(i => i.message.includes('latency.path_t95'));
    expect(hasT95).toBe(true);
    expect(hasPathT95).toBe(true);

    // Ensure query/n_query drift is covered
    expect(driftIssues.some(i => i.message.includes('"query"'))).toBe(true);
    expect(driftIssues.some(i => i.message.includes('"n_query"'))).toBe(true);

    // Ensure connection drift is covered
    expect(driftIssues.some(i => i.message.includes('"connection"'))).toBe(true);

    // Ensure conditional_p is covered and missing-vs-present drift is surfaced
    expect(driftIssues.some(i => i.field?.includes('conditional_p'))).toBe(true);
  });
});


