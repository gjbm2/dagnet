/**
 * UpdateManager.updateConditionalProbability – evidence window metadata
 *
 * Purpose:
 * - Conditional probabilities must persist evidence window_from/window_to and normalise to UK format,
 *   otherwise conditional fetches leave stale/missing provenance.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { UpdateManager } from '../UpdateManager';

describe('UpdateManager.updateConditionalProbability evidence window metadata', () => {
  it('writes evidence.window_from/window_to (normalised to UK) on conditional_p', () => {
    const um = new UpdateManager();

    const graph: any = {
      metadata: { updated_at: '2025-12-01T00:00:00.000Z' },
      edges: [
        {
          uuid: 'e1',
          conditional_p: [
            { condition: 'visited(x)', p: { evidence: { n: 1, k: 0, window_from: '1-Oct-25', window_to: '2-Oct-25' } } },
          ],
        },
      ],
    };

    const updated = um.updateConditionalProbability(
      graph,
      'e1',
      0,
      {
        evidence: {
          n: 10,
          k: 3,
          window_from: '2025-11-01T00:00:00.000Z',
          window_to: '2025-11-14T00:00:00.000Z',
          retrieved_at: '2025-12-22T16:00:00.000Z',
          source: 'amplitude',
        },
      },
      { respectOverrides: true }
    );

    expect(updated).not.toBe(graph);
    expect(updated.edges[0].conditional_p[0].p.evidence.n).toBe(10);
    expect(updated.edges[0].conditional_p[0].p.evidence.k).toBe(3);
    expect(updated.edges[0].conditional_p[0].p.evidence.window_from).toBe('1-Nov-25');
    expect(updated.edges[0].conditional_p[0].p.evidence.window_to).toBe('14-Nov-25');
    expect(updated.edges[0].conditional_p[0].p.evidence.retrieved_at).toBe('2025-12-22T16:00:00.000Z');
    expect(updated.edges[0].conditional_p[0].p.evidence.source).toBe('amplitude');
  });
});


