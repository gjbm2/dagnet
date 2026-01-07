/**
 * IntegrityCheckService – conditional_p sibling alignment lint
 *
 * Adds a semantic warning when a conditional group exists on some outgoing edges
 * from a node but is missing on sibling edges.
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

describe('IntegrityCheckService conditional sibling alignment', () => {
  it('warns when a sibling edge is missing a conditional group present on another sibling edge', async () => {
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
            { id: 'C', uuid: 'C', label: 'C', layout: { x: 0, y: 0 } },
          ],
          edges: [
            {
              id: 'e1',
              uuid: 'e1',
              from: 'A',
              to: 'B',
              p: { id: 'p1', connection: 'amplitude-prod' },
              conditional_p: [
                { condition: 'visited(x)', p: { id: 'cp1', connection: 'amplitude-prod' } },
                { condition: 'visited(y)', p: { id: 'cp2', connection: 'amplitude-prod' } },
              ],
            },
            {
              id: 'e2',
              uuid: 'e2',
              from: 'A',
              to: 'C',
              p: { id: 'p2', connection: 'amplitude-prod' },
              conditional_p: [
                { condition: 'visited(x)', p: { id: 'cp3', connection: 'amplitude-prod' } },
              ],
            },
          ],
        },
      },
    ]);

    const res = await IntegrityCheckService.checkIntegrity({} as any, false);
    const msgs = res.issues
      .filter((i) => i.category === 'semantic' && i.message.includes('Conditional group alignment'))
      .map((i) => i.message);

    // e2 should be missing visited(y)
    expect(msgs.some((m) => m.includes('edge "e2"') && m.includes('visited(y)'))).toBe(true);
  });
});


