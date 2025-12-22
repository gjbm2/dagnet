/**
 * IntegrityCheckService – semantic evidence issues
 *
 * Purpose:
 * - Flag likely semantic data problems using only persisted graph evidence (n/k) + topology:
 *   - denominator incoherence across outgoing edges
 *   - node-level inflow/outflow mismatch (overlap or missing coverage)
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

describe('IntegrityCheckService semantic evidence issues', () => {
  it('flags denominator incoherence and inflow/outflow mismatch', async () => {
    (db as any).__setFiles([
      {
        fileId: 'graph-g-semantic',
        type: 'graph',
        source: { repository: 'repo', branch: 'main', path: 'graphs/g-semantic.yaml' },
        data: {
          schema_version: '1.1.0',
          metadata: { version: '1.0.0', created_at: '2025-12-15T00:00:00.000Z' },
          policies: { default_outcome: 'success' },
          nodes: [
            { id: 'A', uuid: 'A', label: 'A', entry: { is_start: true, entry_weight: 1 }, layout: { x: 0, y: 0 } },
            { id: 'X', uuid: 'X', label: 'X', layout: { x: 0, y: 0 } },
            { id: 'Y', uuid: 'Y', label: 'Y', layout: { x: 0, y: 0 } },
            { id: 'Z', uuid: 'Z', label: 'Z', layout: { x: 0, y: 0 } },
          ],
          edges: [
            // Two inbound edges into X whose k's sum to > X's outgoing n (overlap symptom)
            { id: 'A->X', uuid: 'e1', from: 'A', to: 'X', p: { evidence: { n: 100, k: 60, mean: 0.6, full_query: 'from(A).to(X)' } } },
            { id: 'Y->X', uuid: 'e2', from: 'Y', to: 'X', p: { evidence: { n: 100, k: 50, mean: 0.5, full_query: 'from(Y).to(X)' } } },

            // Outgoing edges from X have inconsistent denominators
            { id: 'X->Z', uuid: 'e3', from: 'X', to: 'Z', p: { evidence: { n: 100, k: 10, mean: 0.1, full_query: 'from(X).to(Z)' } } },
            { id: 'X->Y', uuid: 'e4', from: 'X', to: 'Y', p: { evidence: { n: 95, k: 20, mean: 0.2105, full_query: 'from(X).to(Y)' } } },
          ],
        },
      },
    ]);

    const result = await IntegrityCheckService.checkIntegrity({} as any, false);

    const semantic = result.issues.filter(i => i.category === 'semantic');
    expect(semantic.length).toBeGreaterThan(0);

    // Denominator incoherence on X
    expect(semantic.some(i => i.message.includes('Evidence denominators disagree') && (i.field || '').includes('node: X'))).toBe(true);

    // Inflow/outflow mismatch on X
    expect(semantic.some(i => i.message.includes('Σk_in') && (i.field || '').includes('node: X'))).toBe(true);
  });
});


