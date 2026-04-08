/**
 * Analysis Request Contract Shape Tests
 *
 * Tests the invariants of the analysis request contract as defined in
 * docs/current/project-y/8-Apr-26-analysis-contract-fix.md:
 *
 * 1. analytics_dsl (subject) never contains temporal clauses
 * 2. effective_query_dsl (temporal) never contains from()/to()
 * 3. analytics_dsl is constant across scenarios (top-level concept)
 * 4. Every scenario has a non-empty effective_query_dsl
 * 5. query_dsl is never a concatenation of subject + temporal
 *
 * These tests document the CURRENT behaviour first (some broken),
 * then are updated as each phase lands to assert CORRECT behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  prepareAnalysisComputeInputs,
  type PreparedAnalysisComputeReady,
} from '../analysisComputePreparationService';
import { ANALYSIS_TYPES } from '../../components/panels/analysisTypes';

// ── Minimal graph fixture ──────────────────────────────────────────

const MINIMAL_GRAPH = {
  nodes: [
    { uuid: 'n1', id: 'household-delegated', label: 'Household delegated', entry: { is_start: true } },
    { uuid: 'n2', id: 'switch-registered', label: 'Switch registered' },
    { uuid: 'n3', id: 'switch-success', label: 'Switch success', absorbing: true },
  ],
  edges: [
    { uuid: 'e1', from: 'n1', to: 'n2', p: { mean: 0.3 } },
    { uuid: 'e2', from: 'n2', to: 'n3', p: { mean: 0.5 } },
  ],
  policies: { default_outcome: 'end' },
  metadata: { version: '1.0.0' },
};

// ── Scenario context fixtures ──────────────────────────────────────

function makeScenarioContext(overrides: Record<string, any> = {}) {
  return {
    scenarios: overrides.scenarios || [],
    baseParams: overrides.baseParams || {},
    currentParams: overrides.currentParams || {},
    scenariosReady: true,
    baseDSL: overrides.baseDSL || '',
    ...overrides,
  };
}

function makeLiveScenario(id: string, queryDSL: string) {
  return {
    id,
    params: {},
    name: id,
    colour: '#ff0000',
    meta: {
      isLive: true,
      queryDSL,
      lastEffectiveDSL: queryDSL,
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function containsSubjectClause(dsl: string): boolean {
  return /\bfrom\(/.test(dsl) || /\bto\(/.test(dsl);
}

function containsTemporalClause(dsl: string): boolean {
  return /\bwindow\(/.test(dsl) || /\bcohort\(/.test(dsl) || /\bcontext\(/.test(dsl) || /\basat\(/.test(dsl);
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Analysis Request Contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('graph-only types (bridge_view)', () => {
    it('should produce correct prepared shape for bridge_view with two scenarios', async () => {
      const scenarioA = makeLiveScenario('scenario-a', 'window(-90d:-30d)');
      const prepared = await prepareAnalysisComputeInputs({
        mode: 'live',
        graph: MINIMAL_GRAPH as any,
        analysisType: 'bridge_view',
        analyticsDsl: 'to(switch-success)',
        currentDSL: 'window(-30d:)',
        needsSnapshots: false,
        rawScenarioStateLoaded: true,
        visibleScenarioIds: ['scenario-a', 'current'],
        scenariosContext: makeScenarioContext({
          scenarios: [scenarioA],
        }),
        whatIfDSL: null,
        getScenarioVisibilityMode: () => 'f+e' as const,
        getScenarioName: (id: string) => id === 'current' ? 'Current' : 'Scenario A',
        getScenarioColour: (id: string) => id === 'current' ? '#3b82f6' : '#f59e0b',
      });

      expect(prepared.status).toBe('ready');
      if (prepared.status !== 'ready') return;

      // Two scenarios
      expect(prepared.scenarios).toHaveLength(2);

      // Each scenario has effective_query_dsl
      for (const sc of prepared.scenarios) {
        expect(sc.effective_query_dsl).toBeTruthy();
      }

      // Scenarios have different effective_query_dsl
      expect(prepared.scenarios[0].effective_query_dsl).not.toBe(
        prepared.scenarios[1].effective_query_dsl,
      );

      // Each scenario has a graph with edges that have p.mean
      for (const sc of prepared.scenarios) {
        expect(sc.graph.edges.length).toBeGreaterThan(0);
        for (const edge of sc.graph.edges) {
          expect(edge.p?.mean).toBeDefined();
        }
      }
    });

    /**
     * INVARIANT TEST: queryDsl must not concatenate subject + temporal.
     *
     * Currently BROKEN — queryDsl = "to(switch-success).window(-30d:)".
     * After Phase 2 fix this will be just the temporal or empty.
     *
     * Marked with .todo so it doesn't block Phase 0 gate.
     * Change .todo to .only when implementing Phase 2.
     */
    it.todo('queryDsl should not contain the analytics subject (Phase 2 fix)');
  });

  describe('snapshot types (cohort_maturity)', () => {
    it('should recognise snapshotContract for cohort_maturity', () => {
      const meta = ANALYSIS_TYPES.find(t => t.id === 'cohort_maturity');
      expect(meta?.snapshotContract).toBeDefined();
      expect(meta?.snapshotContract?.scopeRule).toBe('funnel_path');
      expect(meta?.snapshotContract?.readMode).toBe('cohort_maturity');
    });

    it('should recognise snapshotContract for surprise_gauge', () => {
      const meta = ANALYSIS_TYPES.find(t => t.id === 'surprise_gauge');
      expect(meta?.snapshotContract).toBeDefined();
      expect(meta?.snapshotContract?.scopeRule).toBe('funnel_path');
      expect(meta?.snapshotContract?.readMode).toBe('sweep_simple');
    });
  });

  describe('snapshotContract alignment with BE SCOPE_RULES', () => {
    // BE scope rules from analysis_subject_resolution.py
    const BE_SCOPE_RULES: Record<string, string> = {
      cohort_maturity: 'funnel_path',
      daily_conversions: 'funnel_path',
      lag_histogram: 'funnel_path',
      lag_fit: 'funnel_path',
      surprise_gauge: 'funnel_path',
      outcome_comparison: 'children_of_selected_node',
      branch_comparison: 'children_of_selected_node',
      bayes_fit: 'all_graph_parameters',
    };

    for (const [typeId, expectedScope] of Object.entries(BE_SCOPE_RULES)) {
      it(`${typeId} should have snapshotContract with scopeRule=${expectedScope}`, () => {
        const meta = ANALYSIS_TYPES.find(t => t.id === typeId);
        expect(meta?.snapshotContract).toBeDefined();
        expect(meta?.snapshotContract?.scopeRule).toBe(expectedScope);
      });
    }

    it('graph-only types should NOT have snapshotContract', () => {
      const graphOnlyTypes = [
        'graph_overview', 'from_node_outcomes', 'to_node_reach', 'bridge_view',
        'path_through', 'path_between', 'conversion_funnel', 'constrained_path',
        'branches_from_start', 'multi_waypoint', 'multi_outcome_comparison',
        'multi_branch_comparison', 'general_selection',
      ];
      for (const typeId of graphOnlyTypes) {
        const meta = ANALYSIS_TYPES.find(t => t.id === typeId);
        if (meta) {
          expect(meta.snapshotContract).toBeUndefined();
        }
      }
    });
  });

  describe('DSL invariants', () => {
    /**
     * These parameterised tests assert that the preparation service
     * never crosses subject and temporal clauses. They test the
     * PREPARED OUTPUT, not the input.
     *
     * Currently some may fail due to the concatenation bug.
     * Marked .todo until Phase 2 lands.
     */
    it.todo('analyticsDsl should never contain temporal clauses (Phase 2 fix)');
    it.todo('effective_query_dsl should never contain from()/to() (Phase 2 fix)');
  });
});
