/**
 * AllSlices simulation tests
 *
 * Verifies the dry-run report does not mutate files or hit external providers.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dataOperationsService } from '../dataOperationsService';
import type { Graph } from '../../types';
import { formatDateUK, parseUKDate } from '../../lib/dateFormat';

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

// Minimal fileRegistry mock (must be the same module path as production imports)
vi.mock('../../contexts/TabContext', () => {
  const mockFiles = new Map<string, any>();
  return {
    fileRegistry: {
      getFile: vi.fn((id: string) => mockFiles.get(id)),
      updateFile: vi.fn(async () => {}),
      registerFile: vi.fn(async (id: string, data: any) => {
        mockFiles.set(id, { data: structuredClone(data) });
      }),
      _mockFiles: mockFiles,
    },
  };
});

const { fileRegistry } = await import('../../contexts/TabContext');

describe('simulateRetrieveAllSlicesToMarkdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fileRegistry as any)._mockFiles.clear();
  });

  it('produces a report and does not write files', async () => {
    const graph: Graph = {
      schema_version: '1.0.0',
      id: 'g1',
      name: 'Test',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', layout: { x: 0, y: 0 } } as any,
        { id: 'B', uuid: 'B', label: 'B', layout: { x: 0, y: 0 } } as any,
      ],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'A',
          to: 'B',
          p: { id: 'p1', connection: 'amplitude-prod', latency: { maturity_days: 10 } },
          query: 'from(a).to(b)',
        } as any,
      ],
    };

    // Provide a parameter file with minimal structure (no values)
    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-prod',
      values: [],
    });

    const report = await dataOperationsService.simulateRetrieveAllSlicesToMarkdown({
      graph,
      slices: ['cohort(-7d:)'],
      bustCache: false,
    });

    expect(report).toContain('Simulate Retrieve All Slices');
    expect(report).toContain('Slice:');
    expect(report).toContain('p:p1');
    expect(report).toContain('**Requested mode**: cohort()');
    expect(report).toContain('**DSL requested range**:');
    expect(report).toContain('**path_t95 diagnostics**:');
    expect(report).toContain('**Would fetch (date windows)**:');
    expect(report).toContain('Provider (runner.execute) range (end-of-day normalised)');
    expect(report).toContain('Therefore: actual HTTP queries we would run');
    // No file writes in simulation
    expect((fileRegistry as any).updateFile).not.toHaveBeenCalled();
  });

  it('reports both internal and provider-normalised windows for window() slices', async () => {
    const todayUK = formatDateUK(new Date());
    const endDate = parseUKDate(todayUK);
    const startDate = new Date(endDate);
    startDate.setUTCDate(endDate.getUTCDate() - 3);
    const startUK = formatDateUK(startDate);

    const graph: Graph = {
      schema_version: '1.0.0',
      id: 'g2',
      name: 'Test',
      description: '',
      nodes: [
        { id: 'A', uuid: 'A', label: 'A', layout: { x: 0, y: 0 } } as any,
        { id: 'B', uuid: 'B', label: 'B', layout: { x: 0, y: 0 } } as any,
      ],
      edges: [
        {
          id: 'e1',
          uuid: 'e1',
          from: 'A',
          to: 'B',
          p: { id: 'p1', connection: 'amplitude-prod', latency: { maturity_days: 10 } },
          query: 'from(a).to(b)',
        } as any,
      ],
    };

    await (fileRegistry as any).registerFile('parameter-p1', {
      id: 'p1',
      connection: 'amplitude-prod',
      values: [],
    });

    const report = await dataOperationsService.simulateRetrieveAllSlicesToMarkdown({
      graph,
      slices: [`window(${startUK}:${todayUK})`],
      bustCache: true,
    });

    expect(report).toContain('**Requested mode**: window()');
    expect(report).toContain('**Would fetch (date windows)**:');
    expect(report).toContain('DSL/internal range:');
    expect(report).toContain('Provider (runner.execute) range (end-of-day normalised):');
    // Normalised end-of-day timestamp should be the same calendar day as todayUK in report
    expect(report).toContain(`${todayUK}`);
  });
});


