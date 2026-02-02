import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
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
          p: { mean: 0.5, evidence: { mean: 0.2 }, forecast: { mean: 0.7 } },
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
  fileRegistry: {},
}));

vi.mock('../../../contexts/NavigatorContext', () => ({
  useNavigatorContext: () => ({
    state: {
      selectedRepo: 'test-repo',
      selectedBranch: 'main',
    },
  }),
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
});


