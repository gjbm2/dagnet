/**
 * Canvas analysis CRUD integration tests.
 *
 * Invariants protected: graph mutation correctness for all canvas analysis
 * lifecycle operations -- create, read, update, delete, copy/paste.
 *
 * Uses REAL service functions (buildCanvasAnalysisPayload, buildCanvasAnalysisObject,
 * mutateCanvasAnalysisGraph, deleteCanvasAnalysisFromGraph, extractSubgraph,
 * UpdateManager.pasteSubgraph). No mocks for internal components.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildCanvasAnalysisPayload, buildCanvasAnalysisObject } from '../canvasAnalysisCreationService';
import { mutateCanvasAnalysisGraph, deleteCanvasAnalysisFromGraph } from '../canvasAnalysisMutationService';
import { captureTabScenariosToRecipe } from '../captureTabScenariosService';
import { constructQueryDSL } from '../../lib/dslConstruction';
import type { CanvasAnalysis } from '../../types';

const GRAPH_BASE = {
  nodes: [
    { uuid: 'n1', id: 'landing-page', label: 'Landing Page', type: 'conversion', entry: { is_start: true, weight: 1.0 } },
    { uuid: 'n2', id: 'signup', label: 'Signup', type: 'conversion' },
    { uuid: 'n3', id: 'purchase', label: 'Purchase', type: 'conversion', absorbing: true },
  ],
  edges: [
    { uuid: 'e1', from: 'n1', to: 'n2', id: 'landing-to-signup', p: { mean: 0.5 } },
    { uuid: 'e2', from: 'n2', to: 'n3', id: 'signup-to-purchase', p: { mean: 0.3 } },
  ],
  metadata: { id: 'test-graph', name: 'Test Graph', updated_at: '2026-01-01T00:00:00.000Z' },
  canvasAnalyses: [] as CanvasAnalysis[],
};

const REACTFLOW_NODES = GRAPH_BASE.nodes.map(n => ({
  id: n.uuid,
  type: 'conversion',
  position: { x: 0, y: 0 },
  data: { uuid: n.uuid, id: n.id, label: n.label, entry: (n as any).entry, absorbing: (n as any).absorbing, type: n.type },
}));

function makeGraph() {
  return structuredClone(GRAPH_BASE) as any;
}

function addAnalysisToGraph(graph: any, analysis: CanvasAnalysis): any {
  const g = structuredClone(graph);
  if (!g.canvasAnalyses) g.canvasAnalyses = [];
  g.canvasAnalyses.push(analysis);
  return g;
}

describe('Canvas analysis CRUD: Create', () => {
  it('should create from selection with correct DSL and auto-resolved type', () => {
    const selectedNodeIds = ['landing-page', 'purchase'];
    const dsl = constructQueryDSL(selectedNodeIds, REACTFLOW_NODES as any[], GRAPH_BASE.edges as any[]);
    expect(dsl).toBeTruthy();

    const payload = buildCanvasAnalysisPayload({
      analyticsDsl: dsl,
      analysisType: 'path_between',
      analysisTypeOverridden: false,
    });
    const analysis = buildCanvasAnalysisObject(payload, { x: 100, y: 200 }, { width: 400, height: 300 });
    const graph = addAnalysisToGraph(makeGraph(), analysis);

    expect(graph.canvasAnalyses).toHaveLength(1);
    const a = graph.canvasAnalyses[0];
    const ci = a.content_items[0];
    expect(ci.analytics_dsl).toBe(dsl);
    expect(ci.analysis_type).toBe('path_between');
    expect(a.x).toBe(100);
    expect(a.y).toBe(200);
    expect(a.width).toBe(400);
    expect(a.height).toBe(300);
    expect(ci.analysis_type_overridden).toBeFalsy();
    expect(ci.mode).toBe('live');
    expect(ci.view_type).toBe('chart');
  });

  it('should create with explicit type and mark as overridden', () => {
    const payload = buildCanvasAnalysisPayload({
      analyticsDsl: 'from(landing-page).to(purchase)',
      analysisType: 'bridge_view',
      analysisTypeOverridden: true,
    });
    const analysis = buildCanvasAnalysisObject(payload, { x: 0, y: 0 }, { width: 400, height: 300 });

    expect(analysis.content_items[0].analysis_type).toBe('bridge_view');
    expect(analysis.content_items[0].analysis_type_overridden).toBe(true);
  });

  it('should create blank analysis with no selected type when no selection', () => {
    const dsl = constructQueryDSL([], REACTFLOW_NODES as any[], GRAPH_BASE.edges as any[]);
    expect(dsl).toBe('');

    const payload = buildCanvasAnalysisPayload({ analyticsDsl: '' });
    const analysis = buildCanvasAnalysisObject(payload, { x: 50, y: 50 }, { width: 400, height: 300 });

    expect(analysis.content_items[0].analytics_dsl).toBeUndefined();
    expect(analysis.content_items[0].analysis_type).toBe('');
    expect(analysis.content_items[0].analysis_type_overridden).toBeFalsy();
  });

  it('should assign unique UUID on each creation', () => {
    const payload = buildCanvasAnalysisPayload({});
    const a1 = buildCanvasAnalysisObject(payload, { x: 0, y: 0 }, { width: 400, height: 300 });
    const a2 = buildCanvasAnalysisObject(payload, { x: 0, y: 0 }, { width: 400, height: 300 });
    expect(a1.id).not.toBe(a2.id);
  });
});

describe('Canvas analysis CRUD: Delete', () => {
  it('should remove analysis by ID and update metadata', () => {
    const analysis = buildCanvasAnalysisObject(
      buildCanvasAnalysisPayload({}),
      { x: 0, y: 0 }, { width: 400, height: 300 },
    );
    const graph = addAnalysisToGraph(makeGraph(), analysis);
    expect(graph.canvasAnalyses).toHaveLength(1);

    const result = deleteCanvasAnalysisFromGraph(graph, analysis.id);
    expect(result).not.toBeNull();
    expect(result!.canvasAnalyses).toHaveLength(0);
    expect(result!.metadata.updated_at).not.toBe(graph.metadata.updated_at);
  });

  it('should return null when analysis ID does not exist', () => {
    const graph = makeGraph();
    const result = deleteCanvasAnalysisFromGraph(graph, 'nonexistent');
    expect(result).not.toBeNull();
    expect(result!.canvasAnalyses).toHaveLength(0);
  });

  it('should not affect other analyses when deleting one', () => {
    const a1 = buildCanvasAnalysisObject(buildCanvasAnalysisPayload({}), { x: 0, y: 0 }, { width: 400, height: 300 });
    const a2 = buildCanvasAnalysisObject(buildCanvasAnalysisPayload({}), { x: 500, y: 0 }, { width: 400, height: 300 });
    let graph = addAnalysisToGraph(makeGraph(), a1);
    graph = addAnalysisToGraph(graph, a2);
    expect(graph.canvasAnalyses).toHaveLength(2);

    const result = deleteCanvasAnalysisFromGraph(graph, a1.id);
    expect(result!.canvasAnalyses).toHaveLength(1);
    expect(result!.canvasAnalyses[0].id).toBe(a2.id);
  });
});

describe('Canvas analysis CRUD: Update via mutateCanvasAnalysisGraph', () => {
  let graph: any;
  let analysis: CanvasAnalysis;

  beforeEach(() => {
    analysis = buildCanvasAnalysisObject(
      buildCanvasAnalysisPayload({
        analyticsDsl: 'from(landing-page).to(purchase)',
        analysisType: 'conversion_funnel',
      }),
      { x: 100, y: 200 }, { width: 400, height: 300 },
    );
    graph = addAnalysisToGraph(makeGraph(), analysis);
  });

  it('should update analysis type and set overridden', () => {
    const result = mutateCanvasAnalysisGraph(graph, analysis.id, (a) => {
      a.content_items[0].analysis_type = 'bridge_view';
      a.content_items[0].analysis_type_overridden = true;
    });
    expect(result).not.toBeNull();
    const updated = result!.canvasAnalyses.find((a: any) => a.id === analysis.id);
    expect(updated.content_items[0].analysis_type).toBe('bridge_view');
    expect(updated.content_items[0].analysis_type_overridden).toBe(true);
    expect(result!.metadata.updated_at).not.toBe(graph.metadata.updated_at);
  });

  it('should update analytics DSL', () => {
    const result = mutateCanvasAnalysisGraph(graph, analysis.id, (a) => {
      a.content_items[0].analytics_dsl = 'to(purchase)';
    });
    const updated = result!.canvasAnalyses.find((a: any) => a.id === analysis.id);
    expect(updated.content_items[0].analytics_dsl).toBe('to(purchase)');
  });

  it('should update chart kind', () => {
    const result = mutateCanvasAnalysisGraph(graph, analysis.id, (a) => {
      a.content_items[0].kind = 'bridge';
    });
    const updated = result!.canvasAnalyses.find((a: any) => a.id === analysis.id);
    expect(updated.content_items[0].kind).toBe('bridge');
  });

  it('should update display settings', () => {
    const result = mutateCanvasAnalysisGraph(graph, analysis.id, (a) => {
      const ci = a.content_items[0];
      if (!ci.display) ci.display = {} as any;
      (ci.display as any).orientation = 'horizontal';
    });
    const updated = result!.canvasAnalyses.find((a: any) => a.id === analysis.id);
    expect(updated.content_items[0].display.orientation).toBe('horizontal');
  });

  it('should update title', () => {
    const result = mutateCanvasAnalysisGraph(graph, analysis.id, (a) => {
      a.content_items[0].title = 'My Custom Chart';
    });
    const updated = result!.canvasAnalyses.find((a: any) => a.id === analysis.id);
    expect(updated.content_items[0].title).toBe('My Custom Chart');
  });

  it('should return null for nonexistent analysis ID', () => {
    const result = mutateCanvasAnalysisGraph(graph, 'nonexistent', () => {});
    expect(result).toBeNull();
  });

  it('should not mutate the original graph', () => {
    const originalType = graph.canvasAnalyses[0].content_items[0].analysis_type;
    mutateCanvasAnalysisGraph(graph, analysis.id, (a) => {
      a.content_items[0].analysis_type = 'something_else';
    });
    expect(graph.canvasAnalyses[0].content_items[0].analysis_type).toBe(originalType);
  });
});

describe('Canvas analysis CRUD: Live ↔ Custom toggle', () => {
  const makeOperations = (visibleIds: string[], modes: Record<string, 'f+e' | 'f' | 'e'> = {}) => ({
    getScenarioState: () => ({ visibleScenarioIds: visibleIds }),
    getScenarioVisibilityMode: (_tabId: string, sid: string) => modes[sid] || ('f+e' as const),
  });

  const scenariosCtx = {
    scenarios: [],
    currentColour: '#3b82f6',
    baseColour: '#6b7280',
    baseDSL: 'window(-30d:)',
  };

  it('should toggle Live → Custom: capture scenarios into content item', () => {
    const analysis = buildCanvasAnalysisObject(
      buildCanvasAnalysisPayload({ analyticsDsl: 'from(a).to(b)', analysisType: 'conversion_funnel' }),
      { x: 0, y: 0 }, { width: 400, height: 300 },
    );
    let graph = addAnalysisToGraph(makeGraph(), analysis);

    const { scenarios: captured } = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: 'window(-30d:)',
      operations: makeOperations(['current', 'base']) as any,
      scenariosContext: scenariosCtx as any,
      whatIfDSL: null,
    });

    const result = mutateCanvasAnalysisGraph(graph, analysis.id, (a) => {
      const ci = a.content_items[0];
      ci.mode = 'custom';
      ci.scenarios = captured;
    });

    const updated = result!.canvasAnalyses[0];
    const ci = updated.content_items[0];
    expect(ci.mode).toBe('custom');
    expect(ci.scenarios).toBeDefined();
    expect(ci.scenarios!.length).toBeGreaterThan(0);
    // deriveOrderedVisibleIds puts base before current
    expect(ci.scenarios![0].scenario_id).toBe('base');
  });

  it('should toggle Custom → Live: clear scenarios', () => {
    const analysis = buildCanvasAnalysisObject(
      buildCanvasAnalysisPayload({ analysisType: 'conversion_funnel' }),
      { x: 0, y: 0 }, { width: 400, height: 300 },
    );
    analysis.content_items[0].mode = 'custom';
    analysis.content_items[0].scenarios = [
      { scenario_id: 'current', name: 'Current', effective_dsl: 'window(-30d:)', colour: '#3b82f6' },
    ] as any;
    let graph = addAnalysisToGraph(makeGraph(), analysis);

    const result = mutateCanvasAnalysisGraph(graph, analysis.id, (a) => {
      const ci = a.content_items[0];
      ci.mode = 'live';
      ci.scenarios = undefined;
    });

    const updated = result!.canvasAnalyses[0];
    const ci = updated.content_items[0];
    expect(ci.mode).toBe('live');
    expect(ci.scenarios).toBeUndefined();
  });
});

describe('Canvas analysis CRUD: Scenario edits in Custom mode', () => {
  it('should rename a scenario', () => {
    const analysis = buildCanvasAnalysisObject(
      buildCanvasAnalysisPayload({ analysisType: 'conversion_funnel' }),
      { x: 0, y: 0 }, { width: 400, height: 300 },
    );
    analysis.content_items[0].mode = 'custom';
    analysis.content_items[0].scenarios = [
      { scenario_id: 'sc-1', name: 'Original', effective_dsl: 'window(-30d:)', colour: '#3b82f6' },
      { scenario_id: 'sc-2', name: 'Second', effective_dsl: 'window(-7d:)', colour: '#ec4899' },
    ] as any;
    let graph = addAnalysisToGraph(makeGraph(), analysis);

    const result = mutateCanvasAnalysisGraph(graph, analysis.id, (a) => {
      const s = a.content_items[0].scenarios?.find((s: any) => s.scenario_id === 'sc-1');
      if (s) (s as any).name = 'Renamed';
    });

    const updated = result!.canvasAnalyses[0];
    expect(updated.content_items[0].scenarios![0].name).toBe('Renamed');
    expect(updated.content_items[0].scenarios![1].name).toBe('Second');
  });
});

describe('Canvas analysis CRUD: Copy/paste via subgraphExtractor + UpdateManager', () => {
  it('should paste analysis with new ID and offset position', async () => {
    const { extractSubgraph } = await import('../../lib/subgraphExtractor');
    const { UpdateManager } = await import('../UpdateManager');

    const analysis = buildCanvasAnalysisObject(
      buildCanvasAnalysisPayload({
        analyticsDsl: 'from(a).to(b)',
        analysisType: 'conversion_funnel',
      }),
      { x: 100, y: 200 }, { width: 400, height: 300 },
    );
    analysis.content_items[0].title = 'My Chart';
    let graph = addAnalysisToGraph(makeGraph(), analysis);

    const subgraph = extractSubgraph({
      selectedNodeIds: [],
      selectedCanvasObjectIds: { canvasAnalyses: [analysis.id] },
      graph,
      includeConnectedEdges: false,
    });

    expect(subgraph.canvasAnalyses).toHaveLength(1);
    expect(subgraph.canvasAnalyses[0].id).toBe(analysis.id);

    const um = new UpdateManager();
    const pasteResult = um.pasteSubgraph(
      graph, [], [], { x: 50, y: 50 }, [],
      { canvasAnalyses: subgraph.canvasAnalyses },
    );

    expect(pasteResult.graph.canvasAnalyses).toHaveLength(2);
    const pasted = pasteResult.graph.canvasAnalyses.find(
      (a: any) => a.id !== analysis.id,
    );
    expect(pasted).toBeDefined();
    expect(pasted.id).not.toBe(analysis.id);
    expect(pasted.x).toBe(150); // 100 + 50 offset
    expect(pasted.y).toBe(250); // 200 + 50 offset
    expect(pasted.content_items[0].analytics_dsl).toBe('from(a).to(b)');
    expect(pasted.content_items[0].analysis_type).toBe('conversion_funnel');
    expect(pasted.content_items[0].title).toBe('My Chart');
  });
});
