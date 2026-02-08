import { describe, it, expect, vi, beforeEach } from 'vitest';

// NOTE: We mock dependencies BEFORE importing the module under test.
vi.mock('../dataOperationsService', () => ({
  computeQuerySignature: vi.fn(async () => JSON.stringify({ c: 'corehash-123', x: {} })),
}));

vi.mock('../../lib/das/buildDslFromEdge', () => ({
  buildDslFromEdge: vi.fn(async () => ({ queryPayload: {}, eventDefinitions: [] })),
}));

vi.mock('../snapshotWriteService', async (importOriginal) => {
  const original: any = await importOriginal();
  return {
    ...original,
    getBatchInventoryV2: vi.fn(async (paramIds: string[], options?: any) => {
      const pid = paramIds[0];
      const sig = options?.current_signatures?.[pid];
      return {
        [pid]: {
          param_id: pid,
          overall_all_families: {
            row_count: 1,
            unique_anchor_days: 1,
            unique_retrievals: 1,
            unique_retrieved_days: 1,
            earliest_anchor_day: '2026-01-01',
            latest_anchor_day: '2026-01-01',
            earliest_retrieved_at: '2026-01-01T00:00:00Z',
            latest_retrieved_at: '2026-01-01T00:00:00Z',
          },
          current: {
            provided_signature: sig,
            provided_core_hash: 'corehash-123',
            matched_family_id: 'fam-1',
            match_mode: 'strict',
            matched_core_hashes: ['corehash-123'],
          },
          families: [
            {
              family_id: 'fam-1',
              family_size: 1,
              member_core_hashes: ['corehash-123'],
              created_at_min: null,
              created_at_max: null,
              overall: {
                row_count: 1,
                unique_anchor_days: 1,
                unique_retrievals: 1,
                unique_retrieved_days: 1,
                earliest_anchor_day: '2026-01-01',
                latest_anchor_day: '2026-01-01',
                earliest_retrieved_at: '2026-01-01T00:00:00Z',
                latest_retrieved_at: '2026-01-01T00:00:00Z',
              },
              by_slice_key: [
                {
                  slice_key: 'context(channel:influencer).window(-100d:)',
                  row_count: 1,
                  unique_anchor_days: 1,
                  unique_retrievals: 1,
                  unique_retrieved_days: 1,
                  earliest_anchor_day: '2026-01-01',
                  latest_anchor_day: '2026-01-01',
                  earliest_retrieved_at: '2026-01-01T00:00:00Z',
                  latest_retrieved_at: '2026-01-01T00:00:00Z',
                },
                {
                  slice_key: 'context(channel:paid-social).cohort(1-Nov-25:15-Dec-25)',
                  row_count: 1,
                  unique_anchor_days: 1,
                  unique_retrievals: 1,
                  unique_retrieved_days: 1,
                  earliest_anchor_day: '2026-01-01',
                  latest_anchor_day: '2026-01-01',
                  earliest_retrieved_at: '2026-01-01T00:00:00Z',
                  latest_retrieved_at: '2026-01-01T00:00:00Z',
                },
              ],
            },
          ],
          unlinked_core_hashes: [],
          warnings: [],
        },
      };
    }),
  };
});

import { fileRegistry } from '../../contexts/TabContext';
import { buildSnapshotRetrievalsQueryForEdge } from '../snapshotRetrievalsService';

function clearFileRegistry() {
  try { (fileRegistry as any).files?.clear?.(); } catch {}
  try { (fileRegistry as any)._files?.clear?.(); } catch {}
  try { (fileRegistry as any)._mockFiles?.clear?.(); } catch {}
  try { (fileRegistry as any).listeners?.clear?.(); } catch {}
}

describe('snapshotRetrievalsService slice_keys (DB-driven)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFileRegistry();
  });

  it('filters inventory slice_key list by context dims, ignoring date-range differences', async () => {
    // Arrange: edge with parameter and a loaded param file (source of truth for workspace prefixing)
    await fileRegistry.registerFile('parameter-p1', {
      fileId: 'parameter-p1',
      type: 'parameter',
      source: { repository: 'repo', branch: 'main' },
      data: { values: [] },
      isDirty: false,
    } as any);

    const graph: any = {
      edges: [{ uuid: 'e1', p: { id: 'p1', connection: 'amplitude-prod' } }],
      nodes: [],
      dataInterestsDSL: '(window(-100d:);cohort(-100d:)).context(channel)',
    };

    const effectiveDSL = 'context(channel:influencer).window(11-Jan-26:31-Jan-26)';

    // Act
    const query = await buildSnapshotRetrievalsQueryForEdge({
      graph,
      edgeId: 'e1',
      effectiveDSL,
      workspace: { repository: 'WRONG', branch: 'WRONG' }, // should be ignored in favour of param file source
    });

    // Assert
    expect(query).not.toBeNull();
    expect(query!.param_id).toBe('repo-main-p1');
    expect(query!.slice_keys).toEqual(['context(channel:influencer).window(-100d:)']);
  });
});

