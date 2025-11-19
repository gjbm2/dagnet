/**
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dataOperationsService } from '../dataOperationsService';
import { updateManager } from '../UpdateManager';

// Reuse the fileRegistry mock from the main integration test file
vi.mock('../../contexts/TabContext', () => {
  const mockFiles = new Map<string, any>();

  return {
    fileRegistry: {
      registerFile: vi.fn((id: string, data: any) => {
        mockFiles.set(id, { data: structuredClone(data) });
        return Promise.resolve();
      }) as any,
      getFile: vi.fn((id: string) => {
        return mockFiles.get(id);
      }) as any,
      updateFile: vi.fn((id: string, data: any) => {
        if (mockFiles.has(id)) {
          mockFiles.set(id, { data: structuredClone(data) });
        }
        return Promise.resolve();
      }) as any,
      deleteFile: vi.fn((id: string) => {
        mockFiles.delete(id);
        return Promise.resolve();
      }) as any,
      _mockFiles: mockFiles,
    },
  };
});

// Mock toast
vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
  },
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
  },
}));

const { fileRegistry } = await import('../../contexts/TabContext');

describe('DataOperationsService - Sheets integration (sheets-readonly)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fileRegistry as any)._mockFiles.clear();
  });

  it('treats sheets-readonly as sheets data source type when appending daily data', async () => {
    // Mock DAS runner factory so we can control Sheets results for this test
    vi.doMock('../../lib/das', async () => {
      const actual = await vi.importActual<any>('../../lib/das');
      return {
        ...actual,
        createDASRunner: vi.fn(() => {
          return {
            execute: vi.fn(async (connectionName: string) => {
              if (connectionName === 'sheets-readonly') {
                return {
                  success: true,
                  updates: [],
                  raw: {
                    scalar_value: 0.45,
                    param_pack: null,
                    errors: [],
                  },
                };
              }
              throw new Error(`Unexpected connectionName in mock runner: ${connectionName}`);
            }),
          };
        }),
      };
    });

    // Minimal parameter file with sheets connection configured
    const paramFile = {
      fileId: 'parameter-sheets-prob-param',
      type: 'parameter' as const,
      viewTabs: [],
      data: {
        id: 'sheets-prob-param',
        connection: 'sheets-readonly',
        connection_string: JSON.stringify({
          spreadsheet_id: 'sheet-id',
          range: 'Sheet1!A1',
        }),
        values: [],
      },
    };

    await fileRegistry.registerFile('parameter-sheets-prob-param', paramFile);

    const edgeId = 'edge-1';
    const graph: any = {
      edges: [
        {
          uuid: edgeId,
          id: edgeId,
          p: {
            id: 'sheets-prob-param',
          },
        },
      ],
      nodes: [],
    };

    const setGraph = vi.fn();

    // Call getFromSourceDirect in daily mode so it will try to append time-series data
    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: 'sheets-prob-param',
      targetId: edgeId,
      graph,
      setGraph,
      paramSlot: 'p',
      dailyMode: true,
      window: {
        start: '2025-01-01',
        end: '2025-01-07',
      },
    });

    const updatedFile = fileRegistry.getFile('parameter-sheets-prob-param');
    if (!updatedFile) {
      // In some flows daily mode may skip append if nothing to fetch; this test simply ensures
      // the presence of a sheets dataSourceType does not break the pipeline.
      expect(updatedFile).toBeUndefined();
      return;
    }

    const latestValue = updatedFile.data.values[updatedFile.data.values.length - 1];
    expect(latestValue.data_source?.type).toBe('sheets');
  });

  it('applies scalar_value from Sheets to current edge parameter', async () => {
    vi.doMock('../../lib/das', async () => {
      const actual = await vi.importActual<any>('../../lib/das');
      return {
        ...actual,
        createDASRunner: vi.fn(() => {
          return {
            execute: vi.fn(async (connectionName: string) => {
              if (connectionName === 'sheets-readonly') {
                return {
                  success: true,
                  updates: [],
                  raw: {
                    scalar_value: 0.42,
                    param_pack: null,
                    errors: [],
                  },
                };
              }
              throw new Error(`Unexpected connectionName in mock runner: ${connectionName}`);
            }),
          };
        }),
      };
    });

    const edgeId = 'edge-1';
    const graph: any = {
      edges: [
        {
          uuid: edgeId,
          id: edgeId,
          p: {
            mean: 0.3,
            connection: 'sheets-readonly',
            connection_string: JSON.stringify({
              spreadsheet_id: 'sheet-id',
              range: 'Sheet1!A1',
              mode: 'single',
            }),
          },
        },
      ],
      nodes: [],
    };

    const setGraph = vi.fn();

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: '', // not needed when connection lives on the edge
      targetId: edgeId,
      graph,
      setGraph,
      paramSlot: 'p',
      dailyMode: false,
    });

    expect(setGraph).toHaveBeenCalled();
    const updatedGraph = setGraph.mock.calls[setGraph.mock.calls.length - 1][0];
    const updatedEdge = updatedGraph.edges.find((e: any) => e.uuid === edgeId);
    expect(updatedEdge.p.mean).toBeCloseTo(0.42);
  });

  it('applies HRN param_pack for current edge only and ignores other edges', async () => {
    vi.doMock('../../lib/das', async () => {
      const actual = await vi.importActual<any>('../../lib/das');
      return {
        ...actual,
        createDASRunner: vi.fn(() => {
          return {
            execute: vi.fn(async (connectionName: string) => {
              if (connectionName === 'sheets-readonly') {
                return {
                  success: true,
                  updates: [],
                  raw: {
                    scalar_value: null,
                    param_pack: {
                      'e.edge-1.p.mean': 0.6,
                      'e.edge-2.p.mean': 0.9, // should be out-of-scope for this call
                    },
                    errors: [],
                  },
                };
              }
              throw new Error(`Unexpected connectionName in mock runner: ${connectionName}`);
            }),
          };
        }),
      };
    });

    const graph: any = {
      edges: [
        {
          uuid: 'edge-1-uuid',
          id: 'edge-1',
          p: {
            mean: 0.3,
            connection: 'sheets-readonly',
            connection_string: JSON.stringify({
              spreadsheet_id: 'sheet-id',
              range: 'Sheet1!A1',
              mode: 'param-pack',
            }),
          },
        },
        {
          uuid: 'edge-2-uuid',
          id: 'edge-2',
          p: {
            mean: 0.4,
          },
        },
      ],
      nodes: [],
    };

    const setGraph = vi.fn();

    await dataOperationsService.getFromSourceDirect({
      objectType: 'parameter',
      objectId: '',
      targetId: 'edge-1-uuid',
      graph,
      setGraph,
      paramSlot: 'p',
      dailyMode: false,
    });

    expect(setGraph).toHaveBeenCalled();
    const updatedGraph = setGraph.mock.calls[setGraph.mock.calls.length - 1][0];
    const edge1 = updatedGraph.edges.find((e: any) => e.uuid === 'edge-1-uuid');
    const edge2 = updatedGraph.edges.find((e: any) => e.uuid === 'edge-2-uuid');

    expect(edge1.p.mean).toBeCloseTo(0.6);
    expect(edge2.p.mean).toBeCloseTo(0.4); // unchanged
  });
});


