/**
 * Canvas analysis creation integration tests.
 *
 * Tests the FULL chain:
 *   1. constructQueryDSL builds correct DSL from node selection
 *   2. resolveAnalysisType returns correct primary type for that DSL
 *
 * Uses REAL backend (localhost:9000). No mocks.
 *
 * These tests simulate what happens when a user selects nodes on the canvas
 * and creates a canvas analysis via the element palette.
 */

import { describe, it, expect } from 'vitest';
import { constructQueryDSL } from '../../lib/dslConstruction';
import { resolveAnalysisType } from '../analysisTypeResolutionService';

const GRAPH = {
  nodes: [
    { uuid: 'n1', id: 'landing-page', label: 'Landing Page', type: 'conversion', entry: { is_start: true, weight: 1.0 } },
    { uuid: 'n2', id: 'signup', label: 'Signup', type: 'conversion' },
    { uuid: 'n3', id: 'purchase', label: 'Purchase', type: 'conversion', absorbing: true },
    { uuid: 'n4', id: 'dropout', label: 'Dropout', type: 'conversion', absorbing: true },
  ],
  edges: [
    { uuid: 'e1', from: 'n1', to: 'n2', id: 'landing-to-signup', p: { mean: 0.5 } },
    { uuid: 'e2', from: 'n2', to: 'n3', id: 'signup-to-purchase', p: { mean: 0.3 } },
    { uuid: 'e3', from: 'n2', to: 'n4', id: 'signup-to-dropout', p: { mean: 0.7 } },
    { uuid: 'e4', from: 'n1', to: 'n4', id: 'landing-to-dropout', p: { mean: 0.5 } },
  ],
  metadata: { id: 'test-graph', name: 'Test Graph' },
};

const REACTFLOW_NODES = GRAPH.nodes.map(n => ({
  id: n.uuid,
  type: 'conversion',
  position: { x: 0, y: 0 },
  data: { uuid: n.uuid, id: n.id, label: n.label, entry: (n as any).entry, absorbing: (n as any).absorbing, type: n.type },
}));

describe('Canvas analysis creation: element palette path (integration)', () => {
  it('should produce conversion_funnel for 3 selected nodes (from -> visited -> to)', async () => {
    const selectedNodeIds = ['landing-page', 'signup', 'purchase'];

    const dsl = constructQueryDSL(selectedNodeIds, REACTFLOW_NODES as any[], GRAPH.edges as any[]);
    console.log('[TEST] 3-node DSL:', dsl);
    expect(dsl).toBeTruthy();
    expect(dsl.length).toBeGreaterThan(0);

    const { primaryAnalysisType } = await resolveAnalysisType(GRAPH, dsl);
    expect(primaryAnalysisType, `DSL was: "${dsl}"`).toBe('conversion_funnel');
  });

  it('should produce path_between for 2 selected nodes (from -> to)', async () => {
    const selectedNodeIds = ['landing-page', 'purchase'];

    const dsl = constructQueryDSL(selectedNodeIds, REACTFLOW_NODES as any[], GRAPH.edges as any[]);
    expect(dsl).toBeTruthy();

    const { primaryAnalysisType } = await resolveAnalysisType(GRAPH, dsl);
    expect(primaryAnalysisType).toBe('path_between');
  });

  it('should produce from_node_outcomes for 1 selected entry node', async () => {
    const selectedNodeIds = ['landing-page'];

    const dsl = constructQueryDSL(selectedNodeIds, REACTFLOW_NODES as any[], GRAPH.edges as any[]);
    expect(dsl).toBeTruthy();

    const { primaryAnalysisType } = await resolveAnalysisType(GRAPH, dsl);
    expect(primaryAnalysisType).toBe('from_node_outcomes');
  });

  it('should produce to_node_reach for 1 selected absorbing node', async () => {
    const selectedNodeIds = ['purchase'];

    const dsl = constructQueryDSL(selectedNodeIds, REACTFLOW_NODES as any[], GRAPH.edges as any[]);
    expect(dsl).toBeTruthy();

    const { primaryAnalysisType } = await resolveAnalysisType(GRAPH, dsl);
    expect(primaryAnalysisType).toBe('to_node_reach');
  });

  it('should produce graph_overview for no selection', async () => {
    const selectedNodeIds: string[] = [];

    const dsl = constructQueryDSL(selectedNodeIds, REACTFLOW_NODES as any[], GRAPH.edges as any[]);
    expect(dsl).toBe('');

    const { primaryAnalysisType } = await resolveAnalysisType(GRAPH);
    expect(primaryAnalysisType).toBe('graph_overview');
  });

  it('DSL from 3 nodes should contain from(), to(), and visited()', () => {
    const selectedNodeIds = ['landing-page', 'signup', 'purchase'];
    const dsl = constructQueryDSL(selectedNodeIds, REACTFLOW_NODES as any[], GRAPH.edges as any[]);

    expect(dsl).toContain('from(');
    expect(dsl).toContain('to(');
    expect(dsl).toContain('visited(');
  });

  it('should produce bridge_view for absorbing node with scenarioCount=2', async () => {
    const selectedNodeIds = ['purchase'];
    const dsl = constructQueryDSL(selectedNodeIds, REACTFLOW_NODES as any[], GRAPH.edges as any[]);
    expect(dsl).toContain('to(purchase)');

    const { primaryAnalysisType } = await resolveAnalysisType(GRAPH, dsl, 2);
    expect(primaryAnalysisType).toBe('bridge_view');
  });

  it('should produce to_node_reach for absorbing node with scenarioCount=1 (default)', async () => {
    const selectedNodeIds = ['purchase'];
    const dsl = constructQueryDSL(selectedNodeIds, REACTFLOW_NODES as any[], GRAPH.edges as any[]);
    expect(dsl).toContain('to(purchase)');

    const { primaryAnalysisType } = await resolveAnalysisType(GRAPH, dsl, 1);
    expect(primaryAnalysisType).toBe('to_node_reach');
  });

  it('scenarioCount changes primary type: to(node) with 1 vs 2 scenarios', async () => {
    const dsl = 'to(purchase)';
    const { primaryAnalysisType: withOne } = await resolveAnalysisType(GRAPH, dsl, 1);
    const { primaryAnalysisType: withTwo } = await resolveAnalysisType(GRAPH, dsl, 2);

    expect(withOne).toBe('to_node_reach');
    expect(withTwo).toBe('bridge_view');
  });
});

describe('Canvas analysis creation: element palette path simulates addCanvasAnalysisAtPosition', () => {
  it('element palette path should resolve type with correct scenario count', async () => {
    const selectedNodeIds = ['purchase'];
    const analyticsDsl = constructQueryDSL(selectedNodeIds, REACTFLOW_NODES as any[], GRAPH.edges as any[]);
    expect(analyticsDsl).toContain('to(purchase)');

    const pendingPayload = analyticsDsl
      ? { recipe: { analysis: { analytics_dsl: analyticsDsl } } }
      : {};

    const hasExplicitType = pendingPayload.recipe?.analysis?.analysis_type &&
      pendingPayload.recipe.analysis.analysis_type !== 'unknown';
    expect(hasExplicitType).toBeFalsy();

    const scenarioCount = 2;
    const dsl = pendingPayload.recipe?.analysis?.analytics_dsl || '';
    const { primaryAnalysisType } = await resolveAnalysisType(GRAPH, dsl || undefined, scenarioCount);

    expect(primaryAnalysisType).toBe('bridge_view');
  });

  it('element palette path with scenarioCount=1 should resolve to to_node_reach', async () => {
    const selectedNodeIds = ['purchase'];
    const analyticsDsl = constructQueryDSL(selectedNodeIds, REACTFLOW_NODES as any[], GRAPH.edges as any[]);

    const scenarioCount = 1;
    const { primaryAnalysisType } = await resolveAnalysisType(GRAPH, analyticsDsl || undefined, scenarioCount);

    expect(primaryAnalysisType).toBe('to_node_reach');
  });

  it('analytics panel drag path has explicit type and skips resolution', () => {
    const dragData = {
      objectType: 'canvas-analysis',
      recipe: { analysis: { analysis_type: 'bridge_view', analytics_dsl: 'to(purchase)' } },
      chartKind: 'bridge',
      analysisResult: { analysis_type: 'bridge_view' },
    };

    const hasExplicitType = dragData.recipe?.analysis?.analysis_type &&
      dragData.recipe.analysis.analysis_type !== 'unknown';
    expect(hasExplicitType).toBeTruthy();
  });
});
