/**
 * GraphIssuesService – severity tooltip formatting
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { graphIssuesService } from '../graphIssuesService';

describe('graphIssuesService.getSeverityTooltipText', () => {
  it('lists issues and truncates with … when maxItems is exceeded', () => {
    (graphIssuesService as any).state = {
      issues: [
        { id: 'e1', fileId: 'graph-g1', type: 'graph', severity: 'error', category: 'schema', message: 'm1' },
        { id: 'e2', fileId: 'graph-g1', type: 'graph', severity: 'error', category: 'schema', message: 'm2' },
        { id: 'w1', fileId: 'graph-g1', type: 'graph', severity: 'warning', category: 'semantic', message: 'w1' },
      ],
      summary: { errors: 2, warnings: 1, info: 0, byCategory: { schema: 2, semantic: 1 } },
      totalFiles: 1,
      lastUpdated: new Date(),
      isLoading: false,
      error: null,
    };

    const text = graphIssuesService.getSeverityTooltipText({
      graphName: 'g1',
      severity: 'error',
      includeReferencedFiles: true,
      maxItems: 1,
    });

    expect(text).toContain('Errors (2):');
    expect(text).toContain('- graph-g1: m1');
    expect(text).toContain('… +1 more');
  });
});


