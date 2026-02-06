import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { LAG_ANCHOR_SELECTED_OPACITY } from '@/lib/nodeEdgeConstants';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('reactflow', () => {
  const React = require('react');
  return {
    EdgeLabelRenderer: ({ children }: any) => React.createElement(React.Fragment, null, children),
    Handle: () => null,
    MarkerType: { ArrowClosed: 'ArrowClosed' },
    Position: { Left: 'Left', Right: 'Right', Top: 'Top', Bottom: 'Bottom' },
    getBezierPath: () => ['M 0,0 C 50,0 50,0 100,0', 50, 0],
    getSmoothStepPath: () => ['M 0,0 L 100,0', 50, 0],
    useReactFlow: () => ({
      deleteElements: vi.fn(),
      setEdges: vi.fn(),
      getNodes: () => [],
      getEdges: () => [],
      screenToFlowPosition: (p: any) => p,
    }),
  };
});

vi.mock('../../../contexts/GraphStoreContext', () => ({
  useGraphStore: () => ({
    graph: {
      nodes: [
        { uuid: 'node-a', id: 'from', label: 'From', event_id: 'from' },
        { uuid: 'node-b', id: 'to', label: 'To', event_id: 'to' },
      ],
      edges: [
        {
          uuid: 'edge-uuid',
          id: 'edge-id',
          from: 'node-a',
          to: 'node-b',
          p: { id: 'param-1', mean: 0.5, evidence: { mean: 0.2 }, forecast: { mean: 0.7 } },
        },
      ],
      metadata: { name: 'g' },
    },
    setGraph: vi.fn(),
    saveHistoryState: vi.fn(),
  }),
}));

vi.mock('../../../contexts/ViewPreferencesContext', () => ({
  useViewPreferencesContext: () => ({
    confidenceIntervalLevel: 'none',
    useUniformScaling: false,
    animateFlow: false,
    massGenerosity: 0,
  }),
}));

vi.mock('../../../contexts/ScenariosContext', () => ({
  useScenariosContextOptional: () => ({
    scenarios: [],
    baseParams: { edges: {} },
    currentParams: { edges: {} },
    currentColour: '#00f',
    baseColour: '#999',
  }),
}));

vi.mock('../../../contexts/TabContext', () => ({
  useTabContext: () => ({
    operations: {
      getScenarioVisibilityMode: () => 'f+e',
    },
    tabs: [
      {
        id: 'tab-1',
        editorState: {
          scenarioState: {
            scenarioOrder: [],
            visibleScenarioIds: ['scenario-a'], // 'current' is NOT visible (hidden-current rendering)
            visibleColourOrderIds: ['scenario-a'],
          },
        },
      },
    ],
    activeTabId: 'tab-1',
  }),
  fileRegistry: {
    getFile: () => null,
  },
}));

vi.mock('../../../contexts/NavigatorContext', () => ({
  useNavigatorContext: () => ({
    state: {
      selectedRepo: 'test-repo',
      selectedBranch: 'main',
    },
  }),
}));

vi.mock('../../../contexts/DialogContext', () => ({
  useDialog: () => ({
    showConfirm: vi.fn(async () => true),
  }),
}));

vi.mock('../../../services/snapshotWriteService', () => ({
  getBatchInventory: vi.fn(async (paramIds: string[]) => {
    const inv: any = {};
    for (const pid of paramIds) {
      // Provide snapshot data for a single param id, empty for others.
      inv[pid] = pid.endsWith('-param-1')
        ? {
            has_data: true,
            param_id: pid,
            earliest: '2025-12-01',
            latest: '2025-12-10',
            row_count: 10,
            unique_days: 10,
            unique_slices: 1,
            unique_hashes: 1,
            unique_retrievals: 2,
            unique_retrieved_days: 10,
          }
        : {
            has_data: false,
            param_id: pid,
            earliest: null,
            latest: null,
            row_count: 0,
            unique_days: 0,
            unique_slices: 0,
            unique_hashes: 0,
            unique_retrievals: 0,
            unique_retrieved_days: 0,
          };
    }
    return inv;
  }),
  getBatchInventoryV2: vi.fn(async (paramIds: string[]) => {
    const inv: any = {};
    for (const pid of paramIds) {
      inv[pid] = pid.endsWith('-param-1')
        ? {
            param_id: pid,
            overall_all_families: {
              earliest_anchor_day: '2025-12-01',
              latest_anchor_day: '2025-12-10',
              row_count: 10,
              unique_anchor_days: 10,
              unique_retrievals: 2,
              unique_retrieved_days: 2,
              earliest_retrieved_at: '2025-12-01T12:00:00Z',
              latest_retrieved_at: '2025-12-10T12:00:00Z',
            },
            current: {
              provided_signature: null,
              provided_core_hash: 'abc123',
              matched_family_id: 'abc123',
              match_mode: 'strict',
              matched_core_hashes: ['abc123'],
            },
            families: [{
              family_id: 'abc123',
              family_size: 1,
              member_core_hashes: ['abc123'],
              created_at_min: null,
              created_at_max: null,
              overall: {
                row_count: 10,
                unique_anchor_days: 10,
                unique_retrievals: 2,
                unique_retrieved_days: 2,
                earliest_anchor_day: '2025-12-01',
                latest_anchor_day: '2025-12-10',
                earliest_retrieved_at: '2025-12-01T12:00:00Z',
                latest_retrieved_at: '2025-12-10T12:00:00Z',
              },
              by_slice_key: [],
            }],
            unlinked_core_hashes: [],
          }
        : {
            param_id: pid,
            overall_all_families: {
              earliest_anchor_day: null,
              latest_anchor_day: null,
              row_count: 0,
              unique_anchor_days: 0,
              unique_retrievals: 0,
              unique_retrieved_days: 0,
              earliest_retrieved_at: null,
              latest_retrieved_at: null,
            },
            current: null,
            families: [],
            unlinked_core_hashes: [],
          };
    }
    return inv;
  }),
  deleteSnapshots: vi.fn(async () => ({ success: true, deleted: 0 })),
  querySnapshotsFull: vi.fn(async () => ({ success: true, rows: [], count: 0 })),
}));

vi.mock('../../../services/dataOperationsService', () => ({
  dataOperationsService: {},
}));

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/components/Tooltip', () => ({
  default: () => null,
}));

vi.mock('@/lib/conditionalColours', () => ({
  getConditionalColour: vi.fn(() => null),
  getConditionalProbabilityColour: vi.fn(() => '#8B5CF6'),
  isConditionalEdge: vi.fn(() => false),
}));

vi.mock('@/lib/whatIf', () => ({
  computeEffectiveEdgeProbability: vi.fn(() => 0.5),
  getEdgeWhatIfDisplay: vi.fn(() => null),
}));

vi.mock('@/lib/queryDSL', () => ({
  getVisitedNodeIds: vi.fn(() => new Set<string>()),
}));

vi.mock('@/utils/confidenceIntervals', () => ({
  calculateConfidenceBounds: vi.fn(() => ({ lower: 0.1, upper: 0.9 })),
}));

vi.mock('../EdgeBeads', () => ({
  useEdgeBeads: () => ({ beads: [], visibleStartOffset: 0 }),
  EdgeBeadsRenderer: () => null,
}));

vi.mock('../../GraphCanvas', () => ({
  useDecorationVisibility: () => ({ beadsVisible: false, isPanning: false, isDraggingNode: false }),
}));

// ============================================================================
// Tests
// ============================================================================

describe('ConversionEdge Sankey parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses stipple mottling for hidden-current in Sankey and renders an anchor with selected opacity boost', async () => {
    // Import AFTER mocks so ConversionEdge sees the mocked hooks/contexts.
    const { default: ConversionEdge } = await import('../ConversionEdge');

    const { container } = render(
      // SVG root helps React Testing Library place <path>/<defs> correctly
      <svg>
        <ConversionEdge
          id="edge-id"
          source="from"
          target="to"
          sourceX={0}
          sourceY={0}
          targetX={100}
          targetY={0}
          sourcePosition={'Right' as any}
          targetPosition={'Left' as any}
          selected={true}
          data={{
            useSankeyView: true,
            // Hidden-current: scenarioOverlay=false and very low strokeOpacity
            scenarioOverlay: false,
            strokeOpacity: 0.05,
            scenarioColour: '#10B981',
            edgeLatencyDisplay: {
              // Minimal LAG payload to ensure lagLayerData exists
              enabled: true,
              mode: 'f+e',
              p_mean: 0.5,
              p_evidence: 0.2,
              p_forecast: 0.7,
              completeness_pct: 100,
              median_days: 2.5,
              isDashed: false,
              useNoEvidenceOpacity: false,
              showLatencyBead: false,
              showCompletenessOnly: false,
              evidenceIsDerived: false,
              forecastIsDerived: false,
            },
          }}
        />
      </svg>
    );

    // Sankey outer ribbon should use stipple fill when hidden-current
    const outer = container.querySelector('#edge-id-sankey-outer') as SVGPathElement | null;
    expect(outer).toBeTruthy();
    expect(outer!.style.fill).toBe('url(#lag-anchor-stipple-edge-id)');
    // For hidden-current, fillOpacity should be driven by the stipple pattern (i.e. set to 1)
    expect(outer!.style.fillOpacity).toBe('1');

    // Sankey parity anchor should exist and reflect selected opacity boost
    const sankeyAnchor = container.querySelector('#edge-id-lag-anchor-sankey') as SVGPathElement | null;
    expect(sankeyAnchor).toBeTruthy();
    expect(sankeyAnchor!.style.strokeOpacity).toBe(String(LAG_ANCHOR_SELECTED_OPACITY));
  });

  it('includes snapshot date range in edge tooltip when DB inventory exists', async () => {
    vi.useFakeTimers();
    const { default: ConversionEdge } = await import('../ConversionEdge');

    const rendered = render(
      <svg>
        <ConversionEdge
          id="edge-id"
          source="from"
          target="to"
          sourceX={0}
          sourceY={0}
          targetX={100}
          targetY={0}
          sourcePosition={'Right' as any}
          targetPosition={'Left' as any}
          selected={false}
          data={{
            scenarioOverlay: false,
            useSankeyView: false,
            strokeOpacity: 1,
            scenarioColour: '#10B981',
            edgeLatencyDisplay: {
              enabled: true,
              mode: 'f+e',
              p_mean: 0.5,
              p_evidence: 0.2,
              p_forecast: 0.7,
              completeness_pct: 100,
              median_days: 2.5,
              isDashed: false,
              useNoEvidenceOpacity: false,
              showLatencyBead: false,
              showCompletenessOnly: false,
              evidenceIsDerived: false,
              forecastIsDerived: false,
            },
            // Ensure tooltip builds edgeId consistently
            id: 'edge-id',
          }}
        />
      </svg>
    );

    const edgePath = rendered.container.querySelector('path.react-flow__edge-path') as SVGPathElement | null;
    expect(edgePath).toBeTruthy();

    // Trigger hover, then advance the tooltip delay.
    await act(async () => {
      fireEvent.mouseEnter(edgePath!, { clientX: 10, clientY: 10 });
      vi.advanceTimersByTime(550);
      // Allow async inventory fetch + state updates to settle
      await Promise.resolve();
      await Promise.resolve();
    });

    // Tooltip is rendered as a portal; assert the snapshot label exists.
    expect(document.body.textContent || '').toContain('snapshots (retrieved):');
    // Date format: d-MMM-yy (from retrieved_at timestamps)
    expect(document.body.textContent || '').toContain('1-Dec-25 — 10-Dec-25');

    vi.useRealTimers();
  });
});


