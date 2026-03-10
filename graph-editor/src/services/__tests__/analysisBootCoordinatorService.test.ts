/**
 * Analysis Boot Coordinator Service — unit tests for pure helpers
 * and integration tests for the requirement collection pipeline.
 *
 * Invariants protected:
 *   - analysisNeedsSnapshots correctly identifies snapshot-backed analyses
 *   - checkBootRequirements aggregates planner status across analyses
 *   - Non-snapshot compute contexts are immediately ready
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSnapshotPlannerInputsStatus = vi.fn();
const mockHydrateSnapshotPlannerInputs = vi.fn();

vi.mock('../../components/panels/analysisTypes', () => ({
  ANALYSIS_TYPES: [
    { id: 'conversion_funnel', name: 'Funnel' },
    { id: 'graph_overview', name: 'Overview' },
    {
      id: 'branch_comparison',
      name: 'Branch',
      snapshotContract: {
        scopeRule: 'children_of_selected_node',
        readMode: 'raw_snapshots',
        slicePolicy: 'mece_fulfilment_allowed',
        timeBoundsSource: 'query_dsl_window',
        perScenario: true,
      },
    },
    {
      id: 'daily_conversions',
      name: 'Daily',
      snapshotContract: {
        scopeRule: 'funnel_path',
        readMode: 'raw_snapshots',
        slicePolicy: 'mece_fulfilment_allowed',
        timeBoundsSource: 'query_dsl_window',
        perScenario: false,
      },
    },
    {
      id: 'cohort_maturity',
      name: 'Cohort',
      snapshotContract: {
        scopeRule: 'funnel_path',
        readMode: 'raw_snapshots',
        slicePolicy: 'mece_fulfilment_allowed',
        timeBoundsSource: 'query_dsl_window',
        perScenario: false,
      },
    },
  ],
}));

vi.mock('../../services/snapshotSubjectResolutionService', () => ({
  getSnapshotPlannerInputsStatus: (...args: any[]) => mockGetSnapshotPlannerInputsStatus(...args),
  hydrateSnapshotPlannerInputs: (...args: any[]) => mockHydrateSnapshotPlannerInputs(...args),
}));

import {
  analysisNeedsSnapshots,
  collectSnapshotDslStrings,
  checkBootRequirements,
  hydrateBootRequirements,
  INITIAL_BOOT_STATE,
} from '../analysisBootCoordinatorService';

describe('analysisBootCoordinatorService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // analysisNeedsSnapshots
  // -----------------------------------------------------------------------

  describe('analysisNeedsSnapshots', () => {
    it('should return false for non-snapshot analysis types', () => {
      expect(analysisNeedsSnapshots({
        recipe: { analysis: { analysis_type: 'conversion_funnel' } },
      } as any)).toBe(false);
    });

    it('should return false when analysis type is missing', () => {
      expect(analysisNeedsSnapshots({
        recipe: { analysis: {} },
      } as any)).toBe(false);
    });

    it('should return true for daily_conversions (snapshot-backed)', () => {
      expect(analysisNeedsSnapshots({
        recipe: { analysis: { analysis_type: 'daily_conversions' } },
      } as any)).toBe(true);
    });

    it('should return true for cohort_maturity (snapshot-backed)', () => {
      expect(analysisNeedsSnapshots({
        recipe: { analysis: { analysis_type: 'cohort_maturity' } },
      } as any)).toBe(true);
    });

    it('should return false for branch_comparison without time_series chart_kind', () => {
      expect(analysisNeedsSnapshots({
        recipe: { analysis: { analysis_type: 'branch_comparison' } },
        chart_kind: 'bar_grouped',
      } as any)).toBe(false);
    });

    it('should return true for branch_comparison with time_series chart_kind', () => {
      expect(analysisNeedsSnapshots({
        recipe: { analysis: { analysis_type: 'branch_comparison' } },
        chart_kind: 'time_series',
      } as any)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // collectSnapshotDslStrings
  // -----------------------------------------------------------------------

  describe('collectSnapshotDslStrings', () => {
    it('should collect analytics DSL from snapshot analyses only', () => {
      const analyses: any[] = [
        { recipe: { analysis: { analysis_type: 'daily_conversions', analytics_dsl: 'from(a).to(b)' } } },
        { recipe: { analysis: { analysis_type: 'conversion_funnel', analytics_dsl: 'from(c).to(d)' } } },
      ];
      const dsls = collectSnapshotDslStrings(analyses, {});
      expect(dsls).toContain('from(a).to(b)');
      expect(dsls).not.toContain('from(c).to(d)');
    });

    it('should include frozen scenario effective_dsl from snapshot analyses', () => {
      const analyses: any[] = [
        {
          recipe: {
            analysis: { analysis_type: 'cohort_maturity', analytics_dsl: 'from(x).to(y)' },
            scenarios: [
              { effective_dsl: 'window(-30d:).context(channel:paid)' },
            ],
          },
        },
      ];
      const dsls = collectSnapshotDslStrings(analyses, {});
      expect(dsls).toContain('window(-30d:).context(channel:paid)');
    });

    it('should include graph-level DSLs', () => {
      const graph = { currentQueryDSL: 'window(-7d:)', baseDSL: 'window(-14d:)' };
      const dsls = collectSnapshotDslStrings([], graph);
      expect(dsls).toContain('window(-7d:)');
      expect(dsls).toContain('window(-14d:)');
    });
  });

  // -----------------------------------------------------------------------
  // checkBootRequirements
  // -----------------------------------------------------------------------

  describe('checkBootRequirements', () => {
    it('should return ready immediately when no snapshot analyses exist', async () => {
      const result = await checkBootRequirements({
        graph: { nodes: [], edges: [] },
        analyses: [
          { recipe: { analysis: { analysis_type: 'conversion_funnel' } } } as any,
        ],
      });
      expect(result.ready).toBe(true);
      expect(result.snapshotAnalysisCount).toBe(0);
      expect(mockGetSnapshotPlannerInputsStatus).not.toHaveBeenCalled();
    });

    it('should return ready when all planner inputs are present', async () => {
      mockGetSnapshotPlannerInputsStatus.mockResolvedValue({
        ready: true,
        requiredFileIds: ['parameter-edge-a', 'event-ev-1'],
        missingFileIds: [],
        hydratableFileIds: [],
        unavailableFileIds: [],
      });

      const result = await checkBootRequirements({
        graph: { nodes: [{ id: 'n1', event_id: 'ev-1' }], edges: [] },
        analyses: [
          { recipe: { analysis: { analysis_type: 'daily_conversions', analytics_dsl: 'from(a).to(b)' } } } as any,
        ],
        workspace: { repository: 'repo', branch: 'main' },
      });

      expect(result.ready).toBe(true);
      expect(result.snapshotAnalysisCount).toBe(1);
      expect(result.requiredFileIds).toEqual(['parameter-edge-a', 'event-ev-1']);
    });

    it('should report hydratable files when planner inputs are in IDB but not FileRegistry', async () => {
      mockGetSnapshotPlannerInputsStatus.mockResolvedValue({
        ready: false,
        requiredFileIds: ['parameter-edge-a'],
        missingFileIds: ['parameter-edge-a'],
        hydratableFileIds: ['parameter-edge-a'],
        unavailableFileIds: [],
      });

      const result = await checkBootRequirements({
        graph: { nodes: [], edges: [] },
        analyses: [
          { recipe: { analysis: { analysis_type: 'daily_conversions' } } } as any,
        ],
        workspace: { repository: 'repo', branch: 'main' },
      });

      expect(result.ready).toBe(false);
      expect(result.hydratableFileIds).toEqual(['parameter-edge-a']);
    });

    it('should report unavailable files when planner inputs are not in IDB', async () => {
      mockGetSnapshotPlannerInputsStatus.mockResolvedValue({
        ready: false,
        requiredFileIds: ['parameter-missing'],
        missingFileIds: ['parameter-missing'],
        hydratableFileIds: [],
        unavailableFileIds: ['parameter-missing'],
      });

      const result = await checkBootRequirements({
        graph: { nodes: [], edges: [] },
        analyses: [
          { recipe: { analysis: { analysis_type: 'daily_conversions' } } } as any,
        ],
        workspace: { repository: 'repo', branch: 'main' },
      });

      expect(result.ready).toBe(false);
      expect(result.unavailableFileIds).toEqual(['parameter-missing']);
    });

    it('should pass collected DSL strings to planner status check', async () => {
      mockGetSnapshotPlannerInputsStatus.mockResolvedValue({
        ready: true,
        requiredFileIds: [],
        missingFileIds: [],
        hydratableFileIds: [],
        unavailableFileIds: [],
      });

      await checkBootRequirements({
        graph: { nodes: [], edges: [], currentQueryDSL: 'window(-7d:)' },
        analyses: [
          { recipe: { analysis: { analysis_type: 'daily_conversions', analytics_dsl: 'from(a).to(b)' } } } as any,
        ],
        workspace: { repository: 'repo', branch: 'main' },
      });

      expect(mockGetSnapshotPlannerInputsStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          dslStrings: expect.arrayContaining(['from(a).to(b)', 'window(-7d:)']),
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // hydrateBootRequirements
  // -----------------------------------------------------------------------

  describe('hydrateBootRequirements', () => {
    it('should delegate to hydrateSnapshotPlannerInputs', async () => {
      mockHydrateSnapshotPlannerInputs.mockResolvedValue(undefined);
      await hydrateBootRequirements({
        fileIds: ['parameter-edge-a'],
        workspace: { repository: 'repo', branch: 'main' },
      });
      expect(mockHydrateSnapshotPlannerInputs).toHaveBeenCalledWith({
        fileIds: ['parameter-edge-a'],
        workspace: { repository: 'repo', branch: 'main' },
      });
    });
  });

  // -----------------------------------------------------------------------
  // INITIAL_BOOT_STATE
  // -----------------------------------------------------------------------

  describe('INITIAL_BOOT_STATE', () => {
    it('should start in idle with bootReady false and epoch 0', () => {
      expect(INITIAL_BOOT_STATE.status).toBe('idle');
      expect(INITIAL_BOOT_STATE.bootReady).toBe(false);
      expect(INITIAL_BOOT_STATE.bootReadyEpoch).toBe(0);
      expect(INITIAL_BOOT_STATE.error).toBeNull();
    });
  });
});
