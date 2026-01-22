/**
 * useShareChartFromUrl – Phase 3 live chart share boot + refresh
 *
 * @vitest-environment happy-dom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  restoreFile: vi.fn(),
  openExistingChartTab: vi.fn(async () => ({ fileId: 'chart-share-abc', tabId: 'tab-chart-1' })),
  openAnalysisChartTabFromAnalysis: vi.fn(async () => ({ fileId: 'chart-share-abc', tabId: 'tab-chart-2' })),
  analyzeMultipleScenarios: vi.fn(async () => ({ success: true, result: { analysis_name: 'Test Analysis', dimension_values: { scenario_id: {} } } })),
  buildGraphForAnalysisLayer: vi.fn(() => ({ nodes: [], edges: [] })),
  setVisibleScenarios: vi.fn(async () => {}),
  setScenarioVisibilityMode: vi.fn(async () => {}),
  scenarios: [] as any[],
  createLiveScenario: vi.fn(async (dsl: string, name?: string, tabId?: string, colour?: string) => {
    const id = `s-${dsl}`;
    const scenario = { id, name: name || dsl, colour: colour || '#000', meta: { isLive: true, queryDSL: dsl } };
    hoisted.scenarios.push(scenario);
    return scenario;
  }),
  regenerateScenario: vi.fn(async () => {}),
}));

vi.mock('../../lib/sharePayload', () => ({
  decodeSharePayloadFromUrl: vi.fn(() => ({
    version: '1.0.0',
    target: 'chart',
    chart: { kind: 'analysis_funnel', title: 'Shared Chart' },
    analysis: { query_dsl: 'from(a).to(b)', analysis_type: 'graph_overview', what_if_dsl: null },
    scenarios: {
      items: [
        { dsl: 'window(-2w:-1w)', name: 'W1', colour: '#111', visibility_mode: 'f+e', subtitle: 'w1' },
        { dsl: 'window(-3w:-2w)', name: 'W2', colour: '#222', visibility_mode: 'f', subtitle: 'w2' },
      ],
      hide_current: false,
      selected_scenario_dsl: null,
    },
  })),
  stableShortHash: vi.fn(() => 'abc'),
}));

vi.mock('../../contexts/ShareModeContext', () => ({
  useShareModeOptional: () => ({
    isLiveMode: true,
    identity: { repo: 'repo-1', branch: 'main', graph: 'g-1' },
  }),
}));

vi.mock('../../contexts/ScenariosContext', () => ({
  useScenariosContextOptional: () => ({
    scenariosReady: true,
    graph: { nodes: [], edges: [] },
    baseParams: { edges: {}, nodes: {} },
    currentParams: { edges: {}, nodes: {} },
    scenarios: hoisted.scenarios,
    currentColour: '#3b82f6',
    createLiveScenario: hoisted.createLiveScenario,
    regenerateScenario: hoisted.regenerateScenario,
  }),
}));

vi.mock('../../contexts/TabContext', () => ({
  useTabContext: () => ({
    tabs: [],
    operations: {
      setVisibleScenarios: hoisted.setVisibleScenarios,
      setScenarioVisibilityMode: hoisted.setScenarioVisibilityMode,
    },
  }),
  fileRegistry: {
    restoreFile: hoisted.restoreFile,
  },
}));

vi.mock('../../services/chartOperationsService', () => ({
  chartOperationsService: {
    openExistingChartTab: hoisted.openExistingChartTab,
    openAnalysisChartTabFromAnalysis: hoisted.openAnalysisChartTabFromAnalysis,
  },
}));

vi.mock('../../lib/graphComputeClient', () => ({
  graphComputeClient: {
    analyzeMultipleScenarios: hoisted.analyzeMultipleScenarios,
  },
}));

vi.mock('../../services/CompositionService', () => ({
  buildGraphForAnalysisLayer: hoisted.buildGraphForAnalysisLayer,
}));

vi.mock('../../services/fetchOrchestratorService', () => ({
  fetchOrchestratorService: {
    buildPlan: vi.fn(() => ({ plan: { version: 1, createdAt: 'x', referenceNow: 'x', dsl: 'x', items: [] } })),
    refreshFromFilesWithRetries: vi.fn(async () => ({ attempts: 1, failures: 0 })),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn(), loading: vi.fn() },
}));

import { useShareChartFromUrl } from '../useShareChartFromUrl';

function Harness() {
  useShareChartFromUrl({ fileId: 'graph-g-1', tabId: 'tab-graph-1' });
  return <div>ok</div>;
}

describe('useShareChartFromUrl', () => {
  beforeEach(() => {
    hoisted.restoreFile.mockReset();
    hoisted.openExistingChartTab.mockClear();
    hoisted.openAnalysisChartTabFromAnalysis.mockClear();
    hoisted.analyzeMultipleScenarios.mockClear();
    hoisted.buildGraphForAnalysisLayer.mockClear();
    hoisted.setVisibleScenarios.mockClear();
    hoisted.setScenarioVisibilityMode.mockClear();
    hoisted.createLiveScenario.mockClear();
    hoisted.regenerateScenario.mockClear();
    hoisted.scenarios.length = 0;
    // The hook uses a global guard to avoid duplicate boot in dev/StrictMode.
    // Reset between tests so earlier runs don't suppress later ones.
    try {
      (window as any).__dagnetShareChartProcessedKeys = new Set<string>();
    } catch {
      // ignore
    }
  });

  it('shows cached chart immediately (placeholder) and still recomputes on boot when cached artefact exists', async () => {
    hoisted.restoreFile.mockResolvedValue({
      data: { payload: { analysis_result: {} } },
    });

    render(<Harness />);

    await waitFor(() => {
      expect(hoisted.openExistingChartTab).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(hoisted.analyzeMultipleScenarios).toHaveBeenCalled();
      expect(hoisted.openAnalysisChartTabFromAnalysis).toHaveBeenCalled();
    });
    expect(hoisted.createLiveScenario).toHaveBeenCalledTimes(2);
  });

  it('creates scenarios and computes chart when no cached artefact exists', async () => {
    hoisted.restoreFile.mockResolvedValue(null);

    render(<Harness />);

    await waitFor(() => {
      expect(hoisted.analyzeMultipleScenarios).toHaveBeenCalled();
      expect(hoisted.openAnalysisChartTabFromAnalysis).toHaveBeenCalled();
    });

    expect(hoisted.createLiveScenario).toHaveBeenCalledTimes(2);
    expect(hoisted.setVisibleScenarios).toHaveBeenCalled();
    expect(hoisted.setScenarioVisibilityMode).toHaveBeenCalled();
  });

  it('regenerates scenarios and recomputes chart after live-share refresh event', async () => {
    hoisted.restoreFile.mockResolvedValue(null);

    render(<Harness />);

    await waitFor(() => {
      expect(hoisted.openAnalysisChartTabFromAnalysis).toHaveBeenCalledTimes(1);
    });

    window.dispatchEvent(
      new CustomEvent('dagnet:liveShareRefreshed', {
        detail: { repo: 'repo-1', branch: 'main', graph: 'g-1', remoteHeadSha: 'abc' },
      })
    );

    await waitFor(() => {
      expect(hoisted.regenerateScenario).toHaveBeenCalled();
      expect(hoisted.openAnalysisChartTabFromAnalysis).toHaveBeenCalledTimes(2);
    });
  });
});

