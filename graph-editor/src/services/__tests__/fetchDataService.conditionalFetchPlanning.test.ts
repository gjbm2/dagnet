import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Graph } from '../../types';
import { fileRegistry } from '../../contexts/TabContext';
import { getItemsNeedingFetch, itemNeedsFetch } from '../fetchDataService';

describe('fetchDataService - conditional_p fetch planning (Phase 3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('getItemsNeedingFetch includes conditional_p[i] items (checkCache=false)', () => {
    const graph: Graph = {
      nodes: [],
      edges: [
        {
          uuid: 'edge-1',
          id: 'edge-1',
          from: 'a',
          to: 'b',
          p: { id: 'base-param', connection: 'amplitude-prod' },
          conditional_p: [
            { condition: 'visited(x)', p: { id: 'cond-param-0', connection: 'amplitude-prod' }, query: 'from(a).to(b).visited(x)' },
            { condition: 'visited(y)', p: { id: 'cond-param-1', connection: 'amplitude-prod' }, query: 'from(a).to(b).visited(y)' },
          ],
        } as any,
      ],
    } as any;

    // No files exist; checkCache=false should return all connectable items.
    vi.spyOn(fileRegistry, 'getFile').mockReturnValue(null as any);

    const items = getItemsNeedingFetch({ start: '1-Nov-25', end: '7-Nov-25' } as any, graph, 'window(1-Nov-25:7-Nov-25)', false);
    const ids = items.map(i => i.id);

    expect(ids).toContain('param-base-param-p-edge-1');
    expect(ids).toContain('param-cond-param-0-conditional_p[0]-edge-1');
    expect(ids).toContain('param-cond-param-1-conditional_p[1]-edge-1');
  });

  it('itemNeedsFetch resolves connection using conditional_p[i].p when conditionalIndex is provided', () => {
    const graph: Graph = {
      nodes: [],
      edges: [
        {
          uuid: 'edge-1',
          id: 'edge-1',
          from: 'a',
          to: 'b',
          // Base has NO connection
          p: { id: 'base-param' },
          // Conditional DOES have a connection
          conditional_p: [
            { condition: 'visited(x)', p: { id: 'cond-param-0', connection: 'amplitude-prod' }, query: 'from(a).to(b).visited(x)' },
          ],
        } as any,
      ],
    } as any;

    // No parameter file exists (so coverage cannot be satisfied); but item is still fetchable due to conditional connection.
    vi.spyOn(fileRegistry, 'getFile').mockReturnValue(null as any);

    const needs = itemNeedsFetch(
      {
        id: 'param-cond-param-0-conditional_p[0]-edge-1',
        type: 'parameter',
        name: 'conditional_p[0]',
        objectId: 'cond-param-0',
        targetId: 'edge-1',
        paramSlot: 'p',
        conditionalIndex: 0,
      },
      { start: '1-Nov-25', end: '7-Nov-25' } as any,
      graph,
      'window(1-Nov-25:7-Nov-25)',
      true
    );

    expect(needs).toBe(true);
  });
});


