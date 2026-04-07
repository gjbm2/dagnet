/**
 * useAnalysisBootCoordinator — state machine tests
 *
 * Invariants protected:
 *   - State transitions follow: idle → waiting_for_restore → collecting → (hydrating →) ready/failed
 *   - bootReadyEpoch increments monotonically, only on genuine ready transitions
 *   - Coordinator gates on TabContext restore, graph readiness, and workspace metadata
 *   - Non-snapshot contexts become ready immediately without hydration
 *   - Hydration failures produce a terminal 'failed' state with diagnostics
 *   - Exceptions during check/hydrate produce 'failed' with error message
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks — coordinator service (already unit-tested separately)
// ---------------------------------------------------------------------------

const mockCheckBootRequirements = vi.fn();
const mockHydrateBootRequirements = vi.fn();
const mockAnalysisNeedsSnapshots = vi.fn();

vi.mock('../../services/analysisBootCoordinatorService', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../services/analysisBootCoordinatorService')>();
  return {
    ...real,
    analysisNeedsSnapshots: (...args: any[]) => mockAnalysisNeedsSnapshots(...args),
    checkBootRequirements: (...args: any[]) => mockCheckBootRequirements(...args),
    hydrateBootRequirements: (...args: any[]) => mockHydrateBootRequirements(...args),
  };
});

vi.mock('../../services/sessionLogService', () => ({
  sessionLogService: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    isLevelEnabled: vi.fn(() => false),
    startOperation: vi.fn(() => 'op'),
    addChild: vi.fn(),
    endOperation: vi.fn(),
  },
}));

import { useAnalysisBootCoordinator, type UseAnalysisBootCoordinatorArgs } from '../useAnalysisBootCoordinator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGraph(nodes: any[] = [{ id: 'n1' }], edges: any[] = []) {
  return { nodes, edges };
}

function makeSnapshotAnalysis(id = 'a1'): any {
  return {
    id,
    recipe: { analysis: { analysis_type: 'daily_conversions', analytics_dsl: 'from(a).to(b)' } },
    chart_kind: 'daily_conversions',
  };
}

function makeNonSnapshotAnalysis(id = 'a2'): any {
  return {
    id,
    recipe: { analysis: { analysis_type: 'conversion_funnel' } },
  };
}

function readyResult(overrides?: Partial<any>) {
  return {
    ready: true,
    snapshotAnalysisCount: 1,
    requiredFileIds: ['parameter-edge-a'],
    missingFileIds: [],
    hydratableFileIds: [],
    unavailableFileIds: [],
    ...overrides,
  };
}

function needsHydrationResult(overrides?: Partial<any>) {
  return {
    ready: false,
    snapshotAnalysisCount: 1,
    requiredFileIds: ['parameter-edge-a'],
    missingFileIds: ['parameter-edge-a'],
    hydratableFileIds: ['parameter-edge-a'],
    unavailableFileIds: [],
    ...overrides,
  };
}

function unavailableResult(overrides?: Partial<any>) {
  return {
    ready: false,
    snapshotAnalysisCount: 1,
    requiredFileIds: ['parameter-missing'],
    missingFileIds: ['parameter-missing'],
    hydratableFileIds: [],
    unavailableFileIds: ['parameter-missing'],
    ...overrides,
  };
}

function defaultArgs(overrides?: Partial<UseAnalysisBootCoordinatorArgs>): UseAnalysisBootCoordinatorArgs {
  return {
    hostType: 'graph-tab',
    hostId: 'test-tab',
    graph: makeGraph(),
    workspace: { repository: 'repo', branch: 'main' },
    analyses: [makeNonSnapshotAnalysis()],
    ...overrides,
  };
}

/** Simulate TabContext restore having already happened before the hook mounts. */
function setTabContextRestored(value: boolean) {
  (window as any).__dagnetTabContextInitDone = value || undefined;
}

/** Fire the TabContext restore event. */
function fireTabContextRestore() {
  (window as any).__dagnetTabContextInitDone = true;
  window.dispatchEvent(new Event('dagnet:tabContextInitDone'));
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

describe('useAnalysisBootCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAnalysisNeedsSnapshots.mockReturnValue(false);
    mockCheckBootRequirements.mockResolvedValue(readyResult({ snapshotAnalysisCount: 0, requiredFileIds: [] }));
    mockHydrateBootRequirements.mockResolvedValue(undefined);
    setTabContextRestored(true);
  });

  afterEach(() => {
    delete (window as any).__dagnetTabContextInitDone;
  });

  // -----------------------------------------------------------------------
  // Restore gate
  // -----------------------------------------------------------------------

  describe('restore gate', () => {
    it('should stay in waiting_for_restore until TabContext fires', async () => {
      setTabContextRestored(false);

      const { result } = renderHook(() => useAnalysisBootCoordinator(defaultArgs()));

      expect(result.current.status).toBe('waiting_for_restore');
      expect(result.current.bootReady).toBe(false);

      await act(async () => { fireTabContextRestore(); });

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });
    });

    it('should skip waiting if TabContext already restored before mount', async () => {
      setTabContextRestored(true);

      const { result } = renderHook(() => useAnalysisBootCoordinator(defaultArgs()));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });
    });
  });

  // -----------------------------------------------------------------------
  // Graph readiness gate
  // -----------------------------------------------------------------------

  describe('graph readiness gate', () => {
    it('should stay in waiting_for_restore when graph is null', () => {
      const { result } = renderHook(() =>
        useAnalysisBootCoordinator(defaultArgs({ graph: null })),
      );

      expect(result.current.status).toBe('waiting_for_restore');
      expect(result.current.bootReady).toBe(false);
    });

    it('should stay in waiting_for_restore when graph lacks nodes array', () => {
      const { result } = renderHook(() =>
        useAnalysisBootCoordinator(defaultArgs({ graph: { edges: [] } })),
      );

      expect(result.current.status).toBe('waiting_for_restore');
    });

    it('should progress when graph becomes ready', async () => {
      const { result, rerender } = renderHook(
        (props: UseAnalysisBootCoordinatorArgs) => useAnalysisBootCoordinator(props),
        { initialProps: defaultArgs({ graph: null }) },
      );

      expect(result.current.status).toBe('waiting_for_restore');

      rerender(defaultArgs({ graph: makeGraph() }));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });
    });
  });

  // -----------------------------------------------------------------------
  // Non-snapshot context — immediate ready
  // -----------------------------------------------------------------------

  describe('non-snapshot context', () => {
    it('should reach ready status with epoch 1 when no snapshot analyses exist', async () => {
      mockAnalysisNeedsSnapshots.mockReturnValue(false);
      mockCheckBootRequirements.mockResolvedValue(readyResult({ snapshotAnalysisCount: 0, requiredFileIds: [] }));

      const { result } = renderHook(() =>
        useAnalysisBootCoordinator(defaultArgs({ analyses: [makeNonSnapshotAnalysis()] })),
      );

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
        expect(result.current.bootReady).toBe(true);
        expect(result.current.bootReadyEpoch).toBe(1);
        expect(result.current.error).toBeNull();
      });
    });
  });

  // -----------------------------------------------------------------------
  // Snapshot context — all inputs present
  // -----------------------------------------------------------------------

  describe('snapshot context — inputs already present', () => {
    it('should reach ready when checkBootRequirements returns ready', async () => {
      mockAnalysisNeedsSnapshots.mockReturnValue(true);
      mockCheckBootRequirements.mockResolvedValue(readyResult());

      const { result } = renderHook(() =>
        useAnalysisBootCoordinator(defaultArgs({ analyses: [makeSnapshotAnalysis()] })),
      );

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
        expect(result.current.bootReady).toBe(true);
        expect(result.current.bootReadyEpoch).toBe(1);
        expect(result.current.diagnostics.snapshotAnalysisCount).toBe(1);
        expect(result.current.diagnostics.requiredFileIds).toEqual(['parameter-edge-a']);
      });
    });
  });

  // -----------------------------------------------------------------------
  // Snapshot context — workspace gate
  // -----------------------------------------------------------------------

  describe('snapshot context — workspace gate', () => {
    it('should stay in collecting_requirements when snapshot analyses exist but no workspace', async () => {
      mockAnalysisNeedsSnapshots.mockReturnValue(true);

      const { result } = renderHook(() =>
        useAnalysisBootCoordinator(defaultArgs({
          analyses: [makeSnapshotAnalysis()],
          workspace: undefined,
        })),
      );

      await waitFor(() => {
        expect(result.current.status).toBe('collecting_requirements');
        expect(result.current.bootReady).toBe(false);
      });

      expect(mockCheckBootRequirements).not.toHaveBeenCalled();
    });

    it('should progress to ready once workspace becomes available', async () => {
      mockAnalysisNeedsSnapshots.mockReturnValue(true);
      mockCheckBootRequirements.mockResolvedValue(readyResult());

      const { result, rerender } = renderHook(
        (props: UseAnalysisBootCoordinatorArgs) => useAnalysisBootCoordinator(props),
        { initialProps: defaultArgs({ analyses: [makeSnapshotAnalysis()], workspace: undefined }) },
      );

      await waitFor(() => {
        expect(result.current.status).toBe('collecting_requirements');
      });

      rerender(defaultArgs({
        analyses: [makeSnapshotAnalysis()],
        workspace: { repository: 'repo', branch: 'main' },
      }));

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
        expect(result.current.bootReady).toBe(true);
      });
    });
  });

  // -----------------------------------------------------------------------
  // Hydration path
  // -----------------------------------------------------------------------

  describe('hydration path', () => {
    it('should hydrate missing files and then reach ready after successful re-check', async () => {
      mockAnalysisNeedsSnapshots.mockReturnValue(true);
      mockCheckBootRequirements
        .mockResolvedValueOnce(needsHydrationResult())
        .mockResolvedValueOnce(readyResult());
      mockHydrateBootRequirements.mockResolvedValue(undefined);

      const { result } = renderHook(() =>
        useAnalysisBootCoordinator(defaultArgs({ analyses: [makeSnapshotAnalysis()] })),
      );

      await waitFor(() => {
        expect(result.current.status).toBe('ready');
        expect(result.current.bootReady).toBe(true);
        expect(result.current.bootReadyEpoch).toBe(1);
      });

      expect(mockHydrateBootRequirements).toHaveBeenCalledWith({
        fileIds: ['parameter-edge-a'],
        workspace: { repository: 'repo', branch: 'main' },
      });
      expect(mockCheckBootRequirements).toHaveBeenCalledTimes(2);
    });

    it('should reach failed if re-check after hydration still reports missing files', async () => {
      mockAnalysisNeedsSnapshots.mockReturnValue(true);
      const stillMissing = {
        ready: false,
        snapshotAnalysisCount: 1,
        requiredFileIds: ['parameter-edge-a'],
        missingFileIds: ['parameter-edge-a'],
        hydratableFileIds: [],
        unavailableFileIds: ['parameter-edge-a'],
      };
      mockCheckBootRequirements
        .mockResolvedValueOnce(needsHydrationResult())
        .mockResolvedValueOnce(stillMissing);
      mockHydrateBootRequirements.mockResolvedValue(undefined);

      const { result } = renderHook(() =>
        useAnalysisBootCoordinator(defaultArgs({ analyses: [makeSnapshotAnalysis()] })),
      );

      await waitFor(() => {
        expect(result.current.status).toBe('failed');
        expect(result.current.bootReady).toBe(false);
        expect(result.current.error).toContain('parameter-edge-a');
      });
    });
  });

  // -----------------------------------------------------------------------
  // Failure — unavailable artefacts (no hydration possible)
  // -----------------------------------------------------------------------

  describe('unavailable artefacts', () => {
    it('should reach failed immediately when no files are hydratable', async () => {
      mockAnalysisNeedsSnapshots.mockReturnValue(true);
      mockCheckBootRequirements.mockResolvedValue(unavailableResult());

      const { result } = renderHook(() =>
        useAnalysisBootCoordinator(defaultArgs({ analyses: [makeSnapshotAnalysis()] })),
      );

      await waitFor(() => {
        expect(result.current.status).toBe('failed');
        expect(result.current.bootReady).toBe(false);
        expect(result.current.error).toContain('parameter-missing');
        expect(result.current.diagnostics.unavailableFileIds).toEqual(['parameter-missing']);
      });

      expect(mockHydrateBootRequirements).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe('error handling', () => {
    it('should reach failed with error message when checkBootRequirements throws', async () => {
      mockAnalysisNeedsSnapshots.mockReturnValue(true);
      mockCheckBootRequirements.mockRejectedValue(new Error('Network failure'));

      const { result } = renderHook(() =>
        useAnalysisBootCoordinator(defaultArgs({ analyses: [makeSnapshotAnalysis()] })),
      );

      await waitFor(() => {
        expect(result.current.status).toBe('failed');
        expect(result.current.bootReady).toBe(false);
        expect(result.current.error).toBe('Network failure');
      });
    });

    it('should reach failed when hydrateBootRequirements throws', async () => {
      mockAnalysisNeedsSnapshots.mockReturnValue(true);
      mockCheckBootRequirements.mockResolvedValue(needsHydrationResult());
      mockHydrateBootRequirements.mockRejectedValue(new Error('IDB write error'));

      const { result } = renderHook(() =>
        useAnalysisBootCoordinator(defaultArgs({ analyses: [makeSnapshotAnalysis()] })),
      );

      await waitFor(() => {
        expect(result.current.status).toBe('failed');
        expect(result.current.error).toBe('IDB write error');
      });
    });
  });

  // -----------------------------------------------------------------------
  // Epoch monotonicity
  // -----------------------------------------------------------------------

  describe('epoch monotonicity', () => {
    it('should increment epoch on each fresh ready transition when deps change', async () => {
      mockAnalysisNeedsSnapshots.mockReturnValue(false);
      mockCheckBootRequirements.mockResolvedValue(readyResult({ snapshotAnalysisCount: 0, requiredFileIds: [] }));

      const { result, rerender } = renderHook(
        (props: UseAnalysisBootCoordinatorArgs) => useAnalysisBootCoordinator(props),
        { initialProps: defaultArgs() },
      );

      await waitFor(() => {
        expect(result.current.bootReadyEpoch).toBe(1);
      });

      rerender(defaultArgs({ hostId: 'test-tab-2' }));

      await waitFor(() => {
        expect(result.current.bootReadyEpoch).toBe(2);
      });
    });
  });
});
