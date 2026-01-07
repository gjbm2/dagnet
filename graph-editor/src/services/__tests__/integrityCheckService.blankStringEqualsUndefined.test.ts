/**
 * Regression: when a graph omits an optional query config field but the file stores it as "",
 * treat them as equivalent for drift detection. This avoids noisy "drift" issues after a
 * force-copy PUT clears n_query by writing an empty string.
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

describe('IntegrityCheckService: blank string equals undefined for n_query drift', () => {
  it('does not report drift when graph n_query is undefined and file n_query is ""', async () => {
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
              // Intentionally OMIT n_query + n_query_overridden on the graph.
              p: { id: 'p1' },
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
          query: 'from(a).to(b)',
          n_query: '', // cleared state
          n_query_overridden: false,
          values: [{ mean: 0.5 }],
        },
      },
    ]);

    const result = await IntegrityCheckService.checkIntegrity({} as any, false);
    const driftIssues = result.issues.filter(i => i.category === 'sync' && i.message.includes('Graph ↔ parameter drift'));
    expect(driftIssues.some(i => i.message.includes('"n_query"'))).toBe(false);
  });
});


