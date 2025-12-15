import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal mocks for isolated service call
vi.mock('../../contexts/TabContext', () => {
  const files = new Map<string, any>();
  return {
    fileRegistry: {
      getFile: vi.fn((id: string) => files.get(id)),
      updateFile: vi.fn(async (id: string, data: any) => {
        const existing = files.get(id);
        if (existing) {
          existing.data = data;
          existing.isDirty = true;
        } else {
          files.set(id, { fileId: id, data, isDirty: true, isInitializing: false });
        }
      }),
      __setFile: (id: string, data: any) => files.set(id, { fileId: id, data, isDirty: false, isInitializing: false }),
      __clearFiles: () => files.clear(),
    },
  };
});

vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    startOperation: vi.fn(() => 'op-id'),
    endOperation: vi.fn(),
    addChild: vi.fn(),
  },
}));

// Ensure the PUT logic reaches the "apply changes" stage even when includeValues=false.
// This avoids relying on the full UpdateManager mapping graph in this unit test.
vi.mock('../UpdateManager', () => {
  class UpdateManager {
    async handleGraphToFile(_source: any, _target: any, operation: string) {
      if (operation === 'UPDATE') {
        return {
          success: true,
          changes: [{ field: 'latency.path_t95', newValue: 9.55 }],
        };
      }
      if (operation === 'CREATE') {
        return { success: true, changes: [] };
      }
      if (operation === 'APPEND') {
        return { success: true, changes: [] };
      }
      return { success: true, changes: [] };
    }
  }
  return { UpdateManager };
});

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const { fileRegistry: mockedFileRegistry } = await import('../../contexts/TabContext');
const { dataOperationsService } = await import('../dataOperationsService');

describe('dataOperationsService.putParameterToFile (metadata-only)', () => {
  beforeEach(() => {
    (mockedFileRegistry.__clearFiles as any)();
  });

  it('does not crash when includeValues=false and only metadata changes are applied', async () => {
    const paramId = 'no-bdos-to-rec';
    const edgeId = 'edge-uuid-1';

    let graph: any = {
      nodes: [{ id: 'A', uuid: 'A' }, { id: 'B', uuid: 'B' }],
      edges: [
        {
          id: 'viewed-coffee-screen-to-energy-rec',
          uuid: edgeId,
          from: 'A',
          to: 'B',
          query: 'from(viewed-coffee-screen).to(energy-rec).exclude(gave-bds-in-onboarding)',
          p: {
            id: paramId,
            connection: 'amplitude-prod',
            latency: { t95: 6.91, path_t95: 9.55, latency_parameter: true },
          },
        },
      ],
      metadata: { name: 'graph-1' },
    };
    const setGraph = (g: any) => {
      graph = g;
    };

    // File initially has a different path_t95 so we can observe metadata update
    (mockedFileRegistry.__setFile as any)(`parameter-${paramId}`, {
      id: paramId,
      type: 'probability',
      connection: 'amplitude-prod',
      query: 'from(viewed-coffee-screen).to(energy-rec).exclude(gave-bds-in-onboarding)',
      latency: { t95: 6.91, path_t95: 6.91, latency_parameter: true },
      values: [{ mean: 0.5, window_from: '2025-12-01T00:00:00Z' }],
    });

    // Should not throw
    await expect(
      dataOperationsService.putParameterToFile({
        paramId,
        edgeId,
        graph,
        setGraph,
        copyOptions: {
          includeValues: false,
          includeMetadata: true,
          permissionsMode: 'copy_all',
        },
      })
    ).resolves.toBeUndefined();

    // Ensure we actually attempted to persist updates
    expect(mockedFileRegistry.updateFile).toHaveBeenCalled();
    const updateCalls = (mockedFileRegistry.updateFile as any).mock.calls as any[];
    const lastCall = updateCalls[updateCalls.length - 1];
    expect(lastCall?.[0]).toBe(`parameter-${paramId}`);

    // Metadata update should have propagated path_t95
    const updated = mockedFileRegistry.getFile(`parameter-${paramId}`);
    expect(updated).toBeTruthy();
    expect(updated.data.latency.path_t95).toBe(9.55);
  });
});


