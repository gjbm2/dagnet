import { describe, it, expect } from 'vitest';
import { toFlow, fromFlow } from '../transform';

const baseGraph = {
  nodes: [
    { uuid: 'node-1', id: 'start', label: 'Start', layout: { x: 0, y: 0 } },
  ],
  edges: [],
  policies: { default_outcome: 'end', overflow_policy: 'error', free_edge_policy: 'complement' },
  metadata: { version: '1.0.0', created_at: '2026-01-01' },
};

describe('Canvas analysis transform round-trip', () => {
  it('toFlow emits analysis nodes with correct prefix and type', () => {
    const graph = {
      ...baseGraph,
      canvasAnalyses: [
        {
          id: 'a1',
          x: 100, y: 200, width: 400, height: 300,
          view_mode: 'chart',
          chart_kind: 'funnel',
          mode: 'live' as const,
          recipe: { analysis: { analysis_type: 'conversion_funnel', analytics_dsl: 'from(a).to(b)' } },
        },
      ],
    };

    const { nodes } = toFlow(graph);
    const analysisNode = nodes.find(n => n.id === 'analysis-a1');

    expect(analysisNode).toBeDefined();
    expect(analysisNode!.type).toBe('canvasAnalysis');
    expect(analysisNode!.position).toEqual({ x: 100, y: 200 });
    expect(analysisNode!.style).toEqual({ width: 400, height: 300 });
    expect(analysisNode!.data.analysis.view_mode).toBe('chart');
    expect(analysisNode!.data.analysis.recipe.analysis.analytics_dsl).toBe('from(a).to(b)');
  });

  it('toFlow appends analysis nodes AFTER conversion nodes, postits, and containers', () => {
    const graph = {
      ...baseGraph,
      postits: [{ id: 'p1', text: 'Note', colour: '#FFF475', width: 200, height: 150, x: 0, y: 0 }],
      containers: [{ id: 'c1', label: 'Group', colour: '#94A3B8', width: 300, height: 200, x: 0, y: 0 }],
      canvasAnalyses: [{
        id: 'a1', x: 0, y: 0, width: 400, height: 300,
        view_mode: 'chart', mode: 'live' as const,
        recipe: { analysis: { analysis_type: 'graph_overview' } },
      }],
    };

    const { nodes } = toFlow(graph);
    const analysisIdx = nodes.findIndex(n => n.id === 'analysis-a1');
    const conversionIdx = nodes.findIndex(n => n.id === 'node-1');
    const postitIdx = nodes.findIndex(n => n.id === 'postit-p1');
    const containerIdx = nodes.findIndex(n => n.id === 'container-c1');

    expect(analysisIdx).toBeGreaterThan(conversionIdx);
    expect(analysisIdx).toBeGreaterThan(postitIdx);
    expect(analysisIdx).toBeGreaterThan(containerIdx);
  });

  it('fromFlow updates analysis positions without contaminating graph.nodes', () => {
    const graph = {
      ...baseGraph,
      canvasAnalyses: [{
        id: 'a1', x: 100, y: 200, width: 400, height: 300,
        view_mode: 'cards', mode: 'fixed' as const,
        recipe: { analysis: { analysis_type: 'from_node_outcomes' } },
      }],
    };

    const { nodes, edges } = toFlow(graph);
    const movedNodes = nodes.map(n =>
      n.id === 'analysis-a1' ? { ...n, position: { x: 500, y: 600 } } : n
    );

    const result = fromFlow(movedNodes, edges, graph);

    expect(result.canvasAnalyses[0].x).toBe(500);
    expect(result.canvasAnalyses[0].y).toBe(600);
    expect(result.canvasAnalyses[0].view_mode).toBe('cards');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].uuid).toBe('node-1');
  });

  it('toFlow handles graph.canvasAnalyses === undefined gracefully', () => {
    const { nodes } = toFlow(baseGraph);
    const analysisNodes = nodes.filter(n => n.id?.startsWith('analysis-'));
    expect(analysisNodes).toHaveLength(0);
  });

  it('toFlow handles empty canvasAnalyses array', () => {
    const graph = { ...baseGraph, canvasAnalyses: [] };
    const { nodes } = toFlow(graph);
    const analysisNodes = nodes.filter(n => n.id?.startsWith('analysis-'));
    expect(analysisNodes).toHaveLength(0);
  });

  it('total node count includes all canvas object types for fast-path detection', () => {
    const graph = {
      ...baseGraph,
      postits: [{ id: 'p1', text: '', colour: '#FFF475', width: 200, height: 150, x: 0, y: 0 }],
      containers: [{ id: 'c1', label: '', colour: '#94A3B8', width: 300, height: 200, x: 0, y: 0 }],
      canvasAnalyses: [{
        id: 'a1', x: 0, y: 0, width: 400, height: 300,
        view_mode: 'chart', mode: 'live' as const,
        recipe: { analysis: { analysis_type: 'graph_overview' } },
      }],
    };

    const { nodes } = toFlow(graph);

    const expectedCount =
      (graph.nodes?.length || 0) +
      (graph.postits?.length || 0) +
      (graph.containers?.length || 0) +
      (graph.canvasAnalyses?.length || 0);

    expect(nodes).toHaveLength(expectedCount);
  });
});

describe('Canvas analysis view_mode semantics', () => {
  it('analysis with view_mode "cards" carries view_mode through transform', () => {
    const graph = {
      ...baseGraph,
      canvasAnalyses: [{
        id: 'a1', x: 0, y: 0, width: 400, height: 300,
        view_mode: 'cards', mode: 'live' as const,
        recipe: { analysis: { analysis_type: 'graph_overview' } },
      }],
    };

    const { nodes } = toFlow(graph);
    const analysisNode = nodes.find(n => n.id === 'analysis-a1');
    expect(analysisNode!.data.analysis.view_mode).toBe('cards');
  });

  it('analysis with view_mode "chart" carries view_mode through transform', () => {
    const graph = {
      ...baseGraph,
      canvasAnalyses: [{
        id: 'a1', x: 0, y: 0, width: 400, height: 300,
        view_mode: 'chart', chart_kind: 'funnel', mode: 'live' as const,
        recipe: { analysis: { analysis_type: 'conversion_funnel', analytics_dsl: 'from(a).to(b)' } },
      }],
    };

    const { nodes } = toFlow(graph);
    const analysisNode = nodes.find(n => n.id === 'analysis-a1');
    expect(analysisNode!.data.analysis.view_mode).toBe('chart');
    expect(analysisNode!.data.analysis.chart_kind).toBe('funnel');
  });

  it('chart_current_layer_dsl is preserved through transform round-trip', () => {
    const graph = {
      ...baseGraph,
      canvasAnalyses: [{
        id: 'a1', x: 0, y: 0, width: 400, height: 300,
        view_mode: 'chart', mode: 'live' as const,
        chart_current_layer_dsl: 'context(channel:influencer)',
        recipe: { analysis: { analysis_type: 'graph_overview' } },
      }],
    };

    const { nodes, edges } = toFlow(graph);
    const result = fromFlow(nodes, edges, graph);
    expect(result.canvasAnalyses[0].chart_current_layer_dsl).toBe('context(channel:influencer)');
  });
});

describe('Canvas analysis full structural round-trip', () => {
  it('should preserve all fields for live + custom analyses through toFlow → fromFlow', () => {
    const graph = {
      ...baseGraph,
      canvasAnalyses: [
        {
          id: 'live-chart',
          x: 100, y: 200, width: 500, height: 350,
          view_mode: 'chart' as const,
          chart_kind: 'funnel',
          mode: 'live' as const,
          title: 'Live Funnel',
          analysis_type_overridden: false,
          chart_current_layer_dsl: 'context(channel:organic)',
          display: { orientation: 'horizontal', show_legend: true },
          recipe: {
            analysis: { analysis_type: 'conversion_funnel', analytics_dsl: 'from(start).to(end)' },
          },
        },
        {
          id: 'custom-chart',
          x: 600, y: 100, width: 400, height: 300,
          view_mode: 'cards' as const,
          mode: 'fixed' as const,
          title: 'Custom Bridge',
          analysis_type_overridden: true,
          display: { show_labels: false },
          recipe: {
            analysis: { analysis_type: 'bridge_view', analytics_dsl: 'to(purchase)', what_if_dsl: 'window(-7d:)' },
            scenarios: [
              { scenario_id: 'current', name: 'Current', effective_dsl: 'window(-30d:)', colour: '#3b82f6', visibility_mode: 'f+e' },
              { scenario_id: 'sc-1', name: 'Test', effective_dsl: 'window(-7d:)', colour: '#ec4899', visibility_mode: 'f' },
            ],
          },
        },
      ],
    };

    const { nodes, edges } = toFlow(graph);

    // Move one analysis to verify position updates
    const movedNodes = nodes.map(n =>
      n.id === 'analysis-live-chart' ? { ...n, position: { x: 150, y: 250 } } : n
    );

    const result = fromFlow(movedNodes, edges, graph);

    expect(result.canvasAnalyses).toHaveLength(2);

    // Live chart: position updated, all other fields preserved
    const live = result.canvasAnalyses.find((a: any) => a.id === 'live-chart');
    expect(live).toBeDefined();
    expect(live.x).toBe(150); // moved
    expect(live.y).toBe(250); // moved
    expect(live.width).toBe(500);
    expect(live.height).toBe(350);
    expect(live.view_mode).toBe('chart');
    expect(live.chart_kind).toBe('funnel');
    expect(live.mode).toBe('live');
    expect(live.title).toBe('Live Funnel');
    expect(live.analysis_type_overridden).toBe(false);
    expect(live.chart_current_layer_dsl).toBe('context(channel:organic)');
    expect(live.display).toEqual({ orientation: 'horizontal', show_legend: true });
    expect(live.recipe.analysis.analysis_type).toBe('conversion_funnel');
    expect(live.recipe.analysis.analytics_dsl).toBe('from(start).to(end)');

    // Custom chart: position unchanged, recipe with scenarios preserved
    const custom = result.canvasAnalyses.find((a: any) => a.id === 'custom-chart');
    expect(custom).toBeDefined();
    expect(custom.x).toBe(600);
    expect(custom.y).toBe(100);
    expect(custom.view_mode).toBe('cards');
    expect(custom.mode).toBe('fixed');
    expect(custom.title).toBe('Custom Bridge');
    expect(custom.analysis_type_overridden).toBe(true);
    expect(custom.display).toEqual({ show_labels: false });
    expect(custom.recipe.analysis.analysis_type).toBe('bridge_view');
    expect(custom.recipe.analysis.what_if_dsl).toBe('window(-7d:)');
    expect(custom.recipe.scenarios).toHaveLength(2);
    expect(custom.recipe.scenarios[0].scenario_id).toBe('current');
    expect(custom.recipe.scenarios[1].scenario_id).toBe('sc-1');
    expect(custom.recipe.scenarios[1].colour).toBe('#ec4899');
    expect(custom.recipe.scenarios[1].visibility_mode).toBe('f');

    // Graph nodes not contaminated
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].uuid).toBe('node-1');
  });
});
