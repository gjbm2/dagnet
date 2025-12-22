/**
 * GraphIssuesService – category filter semantics
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { graphIssuesService } from '../graphIssuesService';

describe('graphIssuesService.getFilteredIssues category filter', () => {
  it('treats categories: [] as an explicit empty filter (returns none)', () => {
    // Mutate service state for test (state is internal; we access via cast).
    (graphIssuesService as any).state = {
      issues: [
        { id: 'i1', fileId: 'graph-g1', type: 'graph', severity: 'info', category: 'schema', message: 'm1' },
        { id: 'i2', fileId: 'graph-g1', type: 'graph', severity: 'info', category: 'semantic', message: 'm2' },
      ],
      summary: { errors: 0, warnings: 0, info: 2, byCategory: { schema: 1, semantic: 1 } },
      totalFiles: 1,
      lastUpdated: new Date(),
      isLoading: false,
      error: null,
    };

    const none = graphIssuesService.getFilteredIssues({ categories: [] as any });
    expect(none).toEqual([]);
  });
});


