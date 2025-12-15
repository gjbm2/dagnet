/**
 * IntegrityCheckService – graph ↔ case file drift detection
 *
 * Ensures the Graph Issues / Integrity report flags drift that can cause direct vs versionedCase
 * behaviour to diverge (connection, connection_string, status).
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

describe('IntegrityCheckService graph↔case drift', () => {
  it('reports drift for inline graph case vs case file', async () => {
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
            {
              id: 'N1',
              uuid: 'N1',
              type: 'case',
              label: 'CaseNode',
              layout: { x: 0, y: 0 },
              case: {
                id: 'c1',
                connection: 'graph-conn',
                connection_string: '{"a":2}',
                status: 'active',
                variants: [],
              },
            },
          ],
          edges: [],
        },
      },
      {
        fileId: 'case-c1',
        type: 'case',
        source: { repository: 'repo', branch: 'main', path: 'cases/c1.yaml' },
        data: {
          id: 'c1',
          name: 'C1',
          metadata: { created_at: '2025-12-15T00:00:00.000Z', updated_at: '2025-12-15T00:00:00.000Z' },
          connection: 'file-conn',
          connection_string: '{"a":1}',
          case: {
            status: 'paused',
            variants: [],
          },
          schedules: [],
        },
      },
    ]);

    const result = await IntegrityCheckService.checkIntegrity({} as any, false);
    const driftIssues = result.issues.filter(i => i.category === 'sync' && i.message.includes('Graph ↔ case drift'));
    expect(driftIssues.length).toBeGreaterThan(0);
    expect(driftIssues.some(i => i.message.includes('"connection"'))).toBe(true);
    expect(driftIssues.some(i => i.message.includes('"connection_string"'))).toBe(true);
    expect(driftIssues.some(i => i.message.includes('"status"'))).toBe(true);
  });
});


