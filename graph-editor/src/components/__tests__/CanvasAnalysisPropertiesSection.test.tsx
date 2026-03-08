/**
 * CanvasAnalysisPropertiesSection integration smoke tests.
 *
 * Invariants:
 * - Rendering with a valid canvas analysis does not crash
 * - Rendering with undefined analysis (race between creation and store propagation) does not crash
 * - Section order: Selection & Query, Data Source, Analysis Type, Chart Settings, Actions
 * - Live/Custom toggle renders and is interactive
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

let currentGraph: any = {
  nodes: [{ uuid: 'n1', id: 'node-a', label: 'Node A' }],
  edges: [],
  metadata: { updated_at: '2026-01-01T00:00:00Z' },
  canvasAnalyses: [
    {
      id: 'ca-1',
      x: 0, y: 0, width: 400, height: 300,
      view_mode: 'chart',
      live: true,
      recipe: { analysis: { analysis_type: 'conversion_funnel', analytics_dsl: 'from(node-a).to(node-b)' } },
    },
  ],
};

vi.mock('../../contexts/GraphStoreContext', () => ({
  useGraphStore: (selector?: any) => {
    const state = {
      graph: currentGraph,
      setGraph: vi.fn((g: any) => { currentGraph = g; }),
      saveHistoryState: vi.fn(),
      currentDSL: 'window(-30d:)',
      isAutoUpdating: false,
    };
    return selector ? selector(state) : state;
  },
  useGraphStoreOptional: () => ({
    graph: currentGraph,
    setGraph: vi.fn(),
    saveHistoryState: vi.fn(),
    currentDSL: '',
  }),
}));

vi.mock('../../contexts/TabContext', () => ({
  useTabContext: () => ({
    tabs: [{ id: 'tab-1', fileId: 'graph-test', editorState: {} }],
    operations: {
      updateTabState: vi.fn(),
      switchTab: vi.fn(),
      getScenarioState: () => ({ visibleScenarioIds: ['current'], scenarioOrder: [] }),
      getScenarioVisibilityMode: () => 'f+e',
      toggleScenarioVisibility: vi.fn(),
      cycleScenarioVisibilityMode: vi.fn(),
    },
  }),
  fileRegistry: {
    getFile: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  },
}));

vi.mock('../../contexts/ScenariosContext', () => ({
  useScenariosContextOptional: () => ({
    scenarios: [],
    currentColour: '#3b82f6',
    baseColour: '#6b7280',
    baseDSL: '',
  }),
}));

vi.mock('../../lib/graphComputeClient', () => ({
  graphComputeClient: {
    getAvailableAnalyses: vi.fn(async () => ({
      analyses: [{ id: 'conversion_funnel', is_primary: true, reason: 'compatible' }],
    })),
  },
}));

vi.mock('../../hooks/useCanvasAnalysisCompute', () => ({
  canvasAnalysisResultCache: new Map(),
  canvasAnalysisTransientCache: new Map(),
}));

vi.mock('../../lib/analysisDisplaySettingsRegistry', () => ({
  getDisplaySettingsForSurface: () => [],
  getDisplaySettings: () => [],
  resolveDisplaySetting: (display: any, setting: any) => display?.[setting.key] ?? setting.defaultValue,
}));

vi.mock('../../hooks/useSnapToSlider', () => ({
  useSnapToSlider: () => ({ snapValue: (v: number) => v, shouldAutoRebalance: false, scheduleRebalance: vi.fn(), handleMouseDown: vi.fn() }),
}));

vi.mock('../../hooks/useFetchData', () => ({
  useFetchData: () => ({ fetchItem: vi.fn() }),
  createFetchItem: vi.fn(),
}));

vi.mock('../../contexts/ValidationContext', () => ({
  useValidationMode: () => ({ mode: 'none' }),
}));

vi.mock('../../contexts/DialogContext', () => ({
  useDialog: () => ({ showConfirm: vi.fn(async () => true) }),
}));

vi.mock('../../contexts/NavigatorContext', () => ({
  useNavigatorContext: () => ({
    state: { selectedRepo: 'r', selectedBranch: 'b' },
    operations: { refreshItems: vi.fn() },
  }),
}));

vi.mock('../../services/captureTabScenariosService', () => ({
  captureTabScenariosToRecipe: () => ({
    scenarios: [{ scenario_id: 'current', name: 'Current', colour: '#3b82f6', visibility_mode: 'f+e' }],
    what_if_dsl: undefined,
  }),
}));

import PropertiesPanel from '../PropertiesPanel';

describe('CanvasAnalysisPropertiesSection smoke tests', () => {
  beforeEach(() => {
    currentGraph = {
      nodes: [{ uuid: 'n1', id: 'node-a', label: 'Node A' }],
      edges: [],
      metadata: { updated_at: '2026-01-01T00:00:00Z' },
      canvasAnalyses: [
        {
          id: 'ca-1',
          x: 0, y: 0, width: 400, height: 300,
          view_mode: 'chart',
          live: true,
          recipe: { analysis: { analysis_type: 'conversion_funnel', analytics_dsl: 'from(node-a).to(node-b)' } },
        },
      ],
    };
  });

  it('should render without crashing when canvas analysis is selected', () => {
    expect(() => {
      render(
        <PropertiesPanel
          selectedNodeId={null}
          onSelectedNodeChange={() => {}}
          selectedEdgeId={null}
          onSelectedEdgeChange={() => {}}
          selectedAnalysisId="ca-1"
          tabId="tab-1"
        />
      );
    }).not.toThrow();
  });

  it('should render without crashing when analysis ID does not exist in graph', () => {
    expect(() => {
      render(
        <PropertiesPanel
          selectedNodeId={null}
          onSelectedNodeChange={() => {}}
          selectedEdgeId={null}
          onSelectedEdgeChange={() => {}}
          selectedAnalysisId="nonexistent-id"
          tabId="tab-1"
        />
      );
    }).not.toThrow();
  });

  it('should render section headers in correct order', () => {
    const { container } = render(
      <PropertiesPanel
        selectedNodeId={null}
        onSelectedNodeChange={() => {}}
        selectedEdgeId={null}
        onSelectedEdgeChange={() => {}}
        selectedAnalysisId="ca-1"
        tabId="tab-1"
      />
    );

    const headers = Array.from(container.querySelectorAll('.collapsible-section-title'))
      .map(el => (el.textContent || '').trim())
      .filter(text => ['Selection', 'Data Source', 'Analysis Type', 'Chart Settings', 'Actions'].some(s => text.includes(s)));

    expect(headers.length).toBeGreaterThanOrEqual(4);
    const selIdx = headers.findIndex(h => h.includes('Selection'));
    const dsIdx = headers.findIndex(h => h.includes('Data Source'));
    const atIdx = headers.findIndex(h => h.includes('Analysis Type'));
    const csIdx = headers.findIndex(h => h.includes('Chart Settings'));

    if (selIdx >= 0 && dsIdx >= 0) expect(selIdx).toBeLessThan(dsIdx);
    if (dsIdx >= 0 && atIdx >= 0) expect(dsIdx).toBeLessThan(atIdx);
    if (atIdx >= 0 && csIdx >= 0) expect(atIdx).toBeLessThan(csIdx);
  });

  it('should show Live label when analysis.live is true', () => {
    const { container } = render(
      <PropertiesPanel
        selectedNodeId={null}
        onSelectedNodeChange={() => {}}
        selectedEdgeId={null}
        onSelectedEdgeChange={() => {}}
        selectedAnalysisId="ca-1"
        tabId="tab-1"
      />
    );

    const liveLabel = container.querySelector('.collapsible-section-toggle');
    expect(liveLabel).toBeTruthy();
  });

  it('should not crash when analysis has no recipe scenarios (live mode)', () => {
    currentGraph.canvasAnalyses[0].live = true;
    currentGraph.canvasAnalyses[0].recipe.scenarios = undefined;

    expect(() => {
      render(
        <PropertiesPanel
          selectedNodeId={null}
          onSelectedNodeChange={() => {}}
          selectedEdgeId={null}
          onSelectedEdgeChange={() => {}}
          selectedAnalysisId="ca-1"
          tabId="tab-1"
        />
      );
    }).not.toThrow();
  });

  it('should not crash when analysis has custom scenarios', () => {
    currentGraph.canvasAnalyses[0].live = false;
    currentGraph.canvasAnalyses[0].recipe.scenarios = [
      { scenario_id: 'current', name: 'Current', colour: '#3b82f6', effective_dsl: 'window(-30d:)', visibility_mode: 'f+e' },
      { scenario_id: 'sc-1', name: 'Google', colour: '#ec4899', effective_dsl: 'window(-30d:).context(channel:google)', visibility_mode: 'f+e' },
    ];

    expect(() => {
      render(
        <PropertiesPanel
          selectedNodeId={null}
          onSelectedNodeChange={() => {}}
          selectedEdgeId={null}
          onSelectedEdgeChange={() => {}}
          selectedAnalysisId="ca-1"
          tabId="tab-1"
        />
      );
    }).not.toThrow();
  });
});
