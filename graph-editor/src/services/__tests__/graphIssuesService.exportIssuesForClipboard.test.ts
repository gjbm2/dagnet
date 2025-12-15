/**
 * GraphIssuesService clipboard export formatting
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { formatIssuesForClipboard } from '../graphIssuesClipboardExport';

describe('formatIssuesForClipboard', () => {
  it('includes summary + issues payload', () => {
    const text = formatIssuesForClipboard({
      issues: [
        {
          id: '1',
          fileId: 'graph-g1',
          type: 'graph',
          severity: 'warning',
          category: 'sync',
          message: 'Mismatch',
          field: 'x',
        },
      ],
      context: { searchTerm: 'mismatch', severities: ['warning'], generatedAt: '2025-12-15T00:00:00.000Z' },
    });

    const obj = JSON.parse(text);
    expect(obj.summary.total).toBe(1);
    expect(obj.issues[0].fileId).toBe('graph-g1');
    expect(obj.context.searchTerm).toBe('mismatch');
  });
});


