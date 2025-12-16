/**
 * fetchDataService – from-file permission propagation defaults
 *
 * Policy: ordinary "from-file" loads should NOT copy permission flags (override flags)
 * from file → graph unless explicitly requested via FetchOptions.includePermissions.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dataOperationsService so we can observe includePermissions passed to getParameterFromFile.
vi.mock('../dataOperationsService', () => ({
  dataOperationsService: {
    getParameterFromFile: vi.fn(async () => ({ success: true })),
    getCaseFromFile: vi.fn(async () => {}),
    getNodeFromFile: vi.fn(async () => {}),
  },
}));

import { fetchDataService, createFetchItem } from '../fetchDataService';
import { dataOperationsService } from '../dataOperationsService';

describe('fetchDataService from-file does not copy permissions by default', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not request permission copying when includePermissions is omitted', async () => {
    const graph: any = { nodes: [], edges: [] };
    const setGraph = vi.fn();
    const item = createFetchItem('parameter', 'p1', 'e1', { paramSlot: 'p' });

    await fetchDataService.fetchItem(item, { mode: 'from-file' }, graph, setGraph, 'window(1-Dec-25:7-Dec-25)', () => graph);

    expect(dataOperationsService.getParameterFromFile).toHaveBeenCalledTimes(1);
    const callArg = (dataOperationsService.getParameterFromFile as any).mock.calls[0][0];
    expect(callArg.includePermissions).toBe(false);
  });

  it('requests permission copying when includePermissions=true', async () => {
    const graph: any = { nodes: [], edges: [] };
    const setGraph = vi.fn();
    const item = createFetchItem('parameter', 'p1', 'e1', { paramSlot: 'p' });

    await fetchDataService.fetchItem(
      item,
      { mode: 'from-file', includePermissions: true },
      graph,
      setGraph,
      'window(1-Dec-25:7-Dec-25)',
      () => graph
    );

    expect(dataOperationsService.getParameterFromFile).toHaveBeenCalledTimes(1);
    const callArg = (dataOperationsService.getParameterFromFile as any).mock.calls[0][0];
    expect(callArg.includePermissions).toBe(true);
  });
});



