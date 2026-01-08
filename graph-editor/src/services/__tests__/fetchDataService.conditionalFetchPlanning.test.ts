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

    // Param files are optional; when missing, parameters are skipped for fetch planning/coverage.
    // For inclusion here, we simulate that the relevant parameter files exist.
    vi.spyOn(fileRegistry, 'getFile').mockImplementation((fileId: string) => {
      if (fileId === 'parameter-base-param') return { data: { connection: 'amplitude-prod', values: [] } } as any;
      if (fileId === 'parameter-cond-param-0') return { data: { connection: 'amplitude-prod', values: [] } } as any;
      if (fileId === 'parameter-cond-param-1') return { data: { connection: 'amplitude-prod', values: [] } } as any;
      return null as any;
    });

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

    // Param files are optional; when missing, parameters are skipped for fetch planning/coverage.
    // Simulate presence of the conditional parameter file so itemNeedsFetch can evaluate coverage.
    vi.spyOn(fileRegistry, 'getFile').mockImplementation((fileId: string) => {
      if (fileId === 'parameter-cond-param-0') return { data: { values: [], connection: undefined } } as any;
      return null as any;
    });

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


