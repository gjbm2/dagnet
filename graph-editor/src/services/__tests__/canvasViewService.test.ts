/**
 * Canvas View Service + Scenario Rehydration — Integration Tests
 *
 * These test the pure data transformation functions in canvasViewService
 * and scenarioRehydrationService. No mocks needed — all functions are pure.
 */

import { describe, it, expect } from 'vitest';
import {
  snapshotStates,
  snapshotScenarios,
  createCanvasView,
  applyCanvasView,
  updateViewObjectState,
  deleteCanvasView,
  renameCanvasView,
  toggleCanvasViewLocked,
  toggleCanvasViewScope,
  scopeEnabled,
} from '../canvasViewService';
import {
  buildRehydrationPlan,
  finalisePlan,
} from '../scenarioRehydrationService';
import type { ConversionGraph, CanvasView } from '@/types';

// ---------------------------------------------------------------------------
// Helpers — minimal graph fixtures
// ---------------------------------------------------------------------------

function makeGraph(overrides: Partial<ConversionGraph> = {}): ConversionGraph {
  return {
    nodes: [{ id: 'n1', uuid: 'u1', label: 'Node 1', x: 0, y: 0 }] as any,
    edges: [],
    policies: {} as any,
    metadata: { name: 'test', updated_at: '' } as any,
    postits: [
      { id: 'p1', text: 'Note', colour: '#FFF475', width: 200, height: 150, x: 10, y: 20, minimised: false },
      { id: 'p2', text: 'Hidden', colour: '#F4BFDB', width: 300, height: 200, x: 100, y: 200, minimised: true, minimised_anchor: 'tr' },
    ] as any,
    canvasAnalyses: [
      { id: 'a1', x: 50, y: 50, width: 400, height: 300, content_items: [{ id: 'ci1' }], minimised: false },
      { id: 'a2', x: 500, y: 100, width: 350, height: 250, content_items: [{ id: 'ci2' }], minimised: true, minimised_anchor: 'bl' },
    ] as any,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// snapshotStates
// ---------------------------------------------------------------------------

describe('snapshotStates', () => {
  it('should capture every postit and analysis with correct minimised state and anchor', () => {
    // CORRECT OUTCOME: 4 entries (2 postits + 2 analyses), each with the right
    // minimised flag and anchor. p1/a1 are not minimised (anchor undefined),
    // p2 has anchor 'tr', a2 has anchor 'bl'.
    const graph = makeGraph();
    const states = snapshotStates(graph);

    expect(states).toHaveLength(4);

    const p1 = states.find(s => s.id === 'p1' && s.type === 'postit');
    expect(p1).toEqual({ id: 'p1', type: 'postit', minimised: false, anchor: undefined });

    const p2 = states.find(s => s.id === 'p2' && s.type === 'postit');
    expect(p2).toEqual({ id: 'p2', type: 'postit', minimised: true, anchor: 'tr' });

    const a1 = states.find(s => s.id === 'a1' && s.type === 'analysis');
    expect(a1).toEqual({ id: 'a1', type: 'analysis', minimised: false, anchor: undefined });

    const a2 = states.find(s => s.id === 'a2' && s.type === 'analysis');
    expect(a2).toEqual({ id: 'a2', type: 'analysis', minimised: true, anchor: 'bl' });
  });

  it('should return empty array for graph with no postits or analyses', () => {
    // CORRECT OUTCOME: empty array — nothing to snapshot
    const graph = makeGraph({ postits: undefined, canvasAnalyses: undefined });
    expect(snapshotStates(graph)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// snapshotScenarios
// ---------------------------------------------------------------------------

describe('snapshotScenarios', () => {
  const scenarios = [
    { id: 's1', name: 'Live A', colour: '#EC4899', meta: { queryDSL: 'context(channel:google)', isLive: true }, params: {} },
    { id: 's2', name: 'Static B', colour: '#10B981', meta: {}, params: { someEdge: { p: 0.5 } } },
  ];
  const scenarioState = {
    visibleScenarioIds: ['current', 's1', 'base'],
    scenarioOrder: ['s1', 's2', 'current'],
    visibilityMode: { current: 'f+e', s1: 'f', base: 'e' } as Record<string, string>,
  };

  it('should capture currentLayer with queryDSL from the passed currentDSL', () => {
    // CORRECT OUTCOME: currentLayer.visible = true (it's in visibleScenarioIds),
    // currentLayer.visibility_mode = 'f+e', currentLayer.queryDSL = the passed DSL string
    const snap = snapshotScenarios(scenarios, scenarioState, 'cohort(1-Jan-25:31-Mar-25).context(channel:google)');

    expect(snap.currentLayer.visible).toBe(true);
    expect(snap.currentLayer.visibility_mode).toBe('f+e');
    expect(snap.currentLayer.queryDSL).toBe('cohort(1-Jan-25:31-Mar-25).context(channel:google)');
  });

  it('should capture baseLayer visibility and mode', () => {
    // CORRECT OUTCOME: base is in visibleScenarioIds → visible: true, mode: 'e'
    const snap = snapshotScenarios(scenarios, scenarioState);

    expect(snap.baseLayer.visible).toBe(true);
    expect(snap.baseLayer.visibility_mode).toBe('e');
  });

  it('should capture user scenarios in scenarioOrder with correct live/static classification', () => {
    // CORRECT OUTCOME: 2 blueprints. s1 is live (has queryDSL), visible, order 0.
    // s2 is static (no queryDSL), not visible (not in visibleScenarioIds), order 1.
    const snap = snapshotScenarios(scenarios, scenarioState);

    expect(snap.scenarios).toHaveLength(2);

    const bp1 = snap.scenarios.find(s => s.name === 'Live A')!;
    expect(bp1.is_live).toBe(true);
    expect(bp1.queryDSL).toBe('context(channel:google)');
    expect(bp1.visible).toBe(true);
    expect(bp1.order).toBe(0);
    expect(bp1.visibility_mode).toBe('f');
    expect(bp1.params).toBeUndefined();

    const bp2 = snap.scenarios.find(s => s.name === 'Static B')!;
    expect(bp2.is_live).toBe(false);
    expect(bp2.queryDSL).toBeUndefined();
    expect(bp2.visible).toBe(false);
    expect(bp2.order).toBe(1);
    expect(bp2.params).toEqual({ someEdge: { p: 0.5 } });
  });
});

// ---------------------------------------------------------------------------
// createCanvasView
// ---------------------------------------------------------------------------

describe('createCanvasView', () => {
  it('should create a view with snapshot of current layout state and unique ID', () => {
    // CORRECT OUTCOME: new view appended to canvasViews, states array has 4 entries,
    // viewport preserved, ID is a non-empty string
    const graph = makeGraph({ canvasViews: [] });
    const viewport = { x: 100, y: 200, zoom: 1.5 };
    const [next, viewId] = createCanvasView(graph, 'My View', viewport);

    expect(viewId).toBeTruthy();
    expect(typeof viewId).toBe('string');
    expect(next.canvasViews).toHaveLength(1);

    const view = next.canvasViews![0];
    expect(view.name).toBe('My View');
    expect(view.viewport).toEqual(viewport);
    expect(view.states).toHaveLength(4); // 2 postits + 2 analyses
  });

  it('should append to existing views without removing them', () => {
    // CORRECT OUTCOME: 2 views after creation (1 existing + 1 new)
    const existing: CanvasView = { id: 'old', name: 'Old', states: [] };
    const graph = makeGraph({ canvasViews: [existing] });
    const [next] = createCanvasView(graph, 'New');

    expect(next.canvasViews).toHaveLength(2);
    expect(next.canvasViews![0].id).toBe('old');
  });
});

// ---------------------------------------------------------------------------
// applyCanvasView — layout application
// ---------------------------------------------------------------------------

describe('applyCanvasView', () => {
  it('should minimise an expanded postit with correct position offset', () => {
    // Setup: p1 is at (10, 20), width 200, not minimised.
    // View says p1 should be minimised with anchor 'tr'.
    // CORRECT OUTCOME: p1.minimised = true, p1.x = 10 + (200 - 32) = 178, p1.y stays 20
    const view: CanvasView = {
      id: 'v1', name: 'Test', states: [
        { id: 'p1', type: 'postit', minimised: true, anchor: 'tr' },
      ],
    };
    const graph = makeGraph({ canvasViews: [view] });
    const result = applyCanvasView(graph, 'v1');

    const p1 = result.postits!.find(p => p.id === 'p1')!;
    expect(p1.minimised).toBe(true);
    expect(p1.x).toBe(10 + (200 - 32)); // 178
    expect(p1.y).toBe(20); // unchanged for 'tr' anchor
  });

  it('should expand a minimised analysis with correct position reverse', () => {
    // Setup: a2 is at (500, 100), width 350, height 250, minimised with anchor 'bl'.
    // View says a2 should NOT be minimised.
    // CORRECT OUTCOME: a2.minimised = false, a2.x stays 500, a2.y = 100 - (250 - 32) = -118
    const view: CanvasView = {
      id: 'v1', name: 'Test', states: [
        { id: 'a2', type: 'analysis', minimised: false },
      ],
    };
    const graph = makeGraph({ canvasViews: [view] });
    const result = applyCanvasView(graph, 'v1');

    const a2 = result.canvasAnalyses!.find(a => a.id === 'a2')!;
    expect(a2.minimised).toBe(false);
    expect(a2.x).toBe(500); // unchanged for 'bl' anchor (only y shifts)
    expect(a2.y).toBe(100 - (250 - 32)); // -118
  });

  it('should learn new objects not in the view by adding them with current state', () => {
    // Setup: view has only p1. Graph has p1, p2, a1, a2.
    // CORRECT OUTCOME: after apply, view.states has 4 entries (p1 applied + p2, a1, a2 learned)
    const view: CanvasView = {
      id: 'v1', name: 'Test', states: [
        { id: 'p1', type: 'postit', minimised: false },
      ],
    };
    const graph = makeGraph({ canvasViews: [view] });
    const result = applyCanvasView(graph, 'v1');

    const resultView = result.canvasViews!.find(v => v.id === 'v1')!;
    expect(resultView.states).toHaveLength(4);
    // p2 should be learned with its current minimised state (true, anchor 'tr')
    const learnedP2 = resultView.states.find(s => s.id === 'p2');
    expect(learnedP2).toEqual({ id: 'p2', type: 'postit', minimised: true, anchor: 'tr' });
  });

  it('should prune orphaned entries for objects that no longer exist', () => {
    // Setup: view references 'ghost' which doesn't exist on graph.
    // CORRECT OUTCOME: 'ghost' is removed from states after apply
    const view: CanvasView = {
      id: 'v1', name: 'Test', states: [
        { id: 'ghost', type: 'postit', minimised: true },
        { id: 'p1', type: 'postit', minimised: false },
      ],
    };
    const graph = makeGraph({ canvasViews: [view] });
    const result = applyCanvasView(graph, 'v1');

    const resultView = result.canvasViews!.find(v => v.id === 'v1')!;
    expect(resultView.states.find(s => s.id === 'ghost')).toBeUndefined();
  });

  it('should not modify objects when applyLayout is false', () => {
    // CORRECT OUTCOME: p1 stays not-minimised even though view says minimise it
    const view: CanvasView = {
      id: 'v1', name: 'Test', applyLayout: false, states: [
        { id: 'p1', type: 'postit', minimised: true, anchor: 'tl' },
      ],
    };
    const graph = makeGraph({ canvasViews: [view] });
    const result = applyCanvasView(graph, 'v1');

    const p1 = result.postits!.find(p => p.id === 'p1')!;
    expect(p1.minimised).toBe(false); // unchanged
    expect(p1.x).toBe(10); // unchanged
  });
});

// ---------------------------------------------------------------------------
// updateViewObjectState
// ---------------------------------------------------------------------------

describe('updateViewObjectState', () => {
  it('should update an existing entry in the view states', () => {
    // CORRECT OUTCOME: p1's minimised flips from false to true
    const view: CanvasView = {
      id: 'v1', name: 'Test', states: [
        { id: 'p1', type: 'postit', minimised: false },
      ],
    };
    const graph = makeGraph({ canvasViews: [view] });
    const result = updateViewObjectState(graph, 'v1', 'p1', 'postit', true, 'br');

    const updated = result.canvasViews![0].states.find(s => s.id === 'p1');
    expect(updated).toEqual({ id: 'p1', type: 'postit', minimised: true, anchor: 'br' });
  });

  it('should add a new entry if the object is not yet in the view', () => {
    // CORRECT OUTCOME: new entry appended for 'a1'
    const view: CanvasView = { id: 'v1', name: 'Test', states: [] };
    const graph = makeGraph({ canvasViews: [view] });
    const result = updateViewObjectState(graph, 'v1', 'a1', 'analysis', true, 'tl');

    expect(result.canvasViews![0].states).toHaveLength(1);
    expect(result.canvasViews![0].states[0]).toEqual({ id: 'a1', type: 'analysis', minimised: true, anchor: 'tl' });
  });

  it('should not write when applyLayout is false', () => {
    // CORRECT OUTCOME: states array stays empty
    const view: CanvasView = { id: 'v1', name: 'Test', applyLayout: false, states: [] };
    const graph = makeGraph({ canvasViews: [view] });
    const result = updateViewObjectState(graph, 'v1', 'p1', 'postit', true, 'tl');

    expect(result.canvasViews![0].states).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scopeEnabled
// ---------------------------------------------------------------------------

describe('scopeEnabled', () => {
  it('should treat undefined as true (default on)', () => {
    expect(scopeEnabled(undefined)).toBe(true);
  });
  it('should treat true as true', () => {
    expect(scopeEnabled(true)).toBe(true);
  });
  it('should treat false as false', () => {
    expect(scopeEnabled(false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toggleCanvasViewScope
// ---------------------------------------------------------------------------

describe('toggleCanvasViewScope', () => {
  it('should flip applyScenarios from default (undefined→true) to false', () => {
    // CORRECT OUTCOME: undefined → scopeEnabled returns true → toggle sets false
    const view: CanvasView = { id: 'v1', name: 'Test', states: [] };
    const graph = makeGraph({ canvasViews: [view] });
    const result = toggleCanvasViewScope(graph, 'v1', 'applyScenarios');

    expect(result.canvasViews![0].applyScenarios).toBe(false);
  });

  it('should flip applyLayout from false to true', () => {
    const view: CanvasView = { id: 'v1', name: 'Test', applyLayout: false, states: [] };
    const graph = makeGraph({ canvasViews: [view] });
    const result = toggleCanvasViewScope(graph, 'v1', 'applyLayout');

    expect(result.canvasViews![0].applyLayout).toBe(true);
  });

  it('should not affect other views', () => {
    // CORRECT OUTCOME: v2 is untouched
    const view1: CanvasView = { id: 'v1', name: 'A', states: [] };
    const view2: CanvasView = { id: 'v2', name: 'B', applyDisplayMode: true, states: [] };
    const graph = makeGraph({ canvasViews: [view1, view2] });
    const result = toggleCanvasViewScope(graph, 'v1', 'applyDisplayMode');

    expect(result.canvasViews![0].applyDisplayMode).toBe(false);
    expect(result.canvasViews![1].applyDisplayMode).toBe(true); // unchanged
  });
});

// ---------------------------------------------------------------------------
// deleteCanvasView, renameCanvasView, toggleCanvasViewLocked
// ---------------------------------------------------------------------------

describe('CRUD operations', () => {
  it('deleteCanvasView should remove the view and leave others', () => {
    const graph = makeGraph({
      canvasViews: [
        { id: 'v1', name: 'A', states: [] },
        { id: 'v2', name: 'B', states: [] },
      ],
    });
    const result = deleteCanvasView(graph, 'v1');
    expect(result.canvasViews).toHaveLength(1);
    expect(result.canvasViews![0].id).toBe('v2');
  });

  it('renameCanvasView should change only the name', () => {
    const graph = makeGraph({ canvasViews: [{ id: 'v1', name: 'Old', states: [{ id: 'p1', type: 'postit' as const, minimised: false }] }] });
    const result = renameCanvasView(graph, 'v1', 'New');
    expect(result.canvasViews![0].name).toBe('New');
    expect(result.canvasViews![0].states).toHaveLength(1); // states preserved
  });

  it('toggleCanvasViewLocked should flip locked state', () => {
    const graph = makeGraph({ canvasViews: [{ id: 'v1', name: 'A', states: [] }] });
    const r1 = toggleCanvasViewLocked(graph, 'v1');
    expect(r1.canvasViews![0].locked).toBe(true);
    const r2 = toggleCanvasViewLocked(r1, 'v1');
    expect(r2.canvasViews![0].locked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildRehydrationPlan — scenario matching
// ---------------------------------------------------------------------------

describe('buildRehydrationPlan', () => {
  const existing = [
    { id: 'e1', name: 'Live A', colour: '#EC4899', meta: { queryDSL: 'context(channel:google)', isLive: true } },
    { id: 'e2', name: 'Live B', colour: '#10B981', meta: { queryDSL: 'context(channel:facebook)', isLive: true } },
    { id: 'e3', name: 'Static C', colour: '#8B5CF6', meta: {} },
  ];

  it('should match live scenarios by (queryDSL, name, colour) and return existing IDs', () => {
    // CORRECT OUTCOME: blueprint for Live A matches e1, Live B matches e2
    const blueprints = [
      { queryDSL: 'context(channel:google)', name: 'Live A', colour: '#EC4899', is_live: true, visible: true, order: 0, params: undefined },
      { queryDSL: 'context(channel:facebook)', name: 'Live B', colour: '#10B981', is_live: true, visible: true, order: 1, params: undefined },
    ] as any;

    const plan = buildRehydrationPlan(blueprints, existing);

    expect(plan.entries[0].existingId).toBe('e1');
    expect(plan.entries[1].existingId).toBe('e2');
  });

  it('should return null existingId for unmatched blueprints', () => {
    // CORRECT OUTCOME: no match for a DSL that doesn't exist
    const blueprints = [
      { queryDSL: 'context(channel:tiktok)', name: 'New', colour: '#EF4444', is_live: true, visible: true, order: 0, params: undefined },
    ] as any;

    const plan = buildRehydrationPlan(blueprints, existing);
    expect(plan.entries[0].existingId).toBeNull();
  });

  it('should match static scenarios by (name, colour) ignoring queryDSL', () => {
    // CORRECT OUTCOME: Static C matches e3 (no queryDSL on either)
    const blueprints = [
      { name: 'Static C', colour: '#8B5CF6', is_live: false, visible: true, order: 0, params: { x: 1 } },
    ] as any;

    const plan = buildRehydrationPlan(blueprints, existing);
    expect(plan.entries[0].existingId).toBe('e3');
  });

  it('should never reuse the same existing ID for two blueprints', () => {
    // Setup: two blueprints both match e1 (same DSL/name/colour)
    // CORRECT OUTCOME: first gets e1, second gets null (needs creation)
    const blueprints = [
      { queryDSL: 'context(channel:google)', name: 'Live A', colour: '#EC4899', is_live: true, visible: true, order: 0, params: undefined },
      { queryDSL: 'context(channel:google)', name: 'Live A', colour: '#EC4899', is_live: true, visible: false, order: 1, params: undefined },
    ] as any;

    const plan = buildRehydrationPlan(blueprints, existing);
    expect(plan.entries[0].existingId).toBe('e1');
    expect(plan.entries[1].existingId).toBeNull(); // can't reuse e1
  });

  it('should include current in scenarioOrder', () => {
    // CORRECT OUTCOME: scenarioOrder ends with 'current'
    const plan = buildRehydrationPlan([], existing);
    expect(plan.scenarioOrder).toContain('current');
  });

  it('should default current to visible when currentLayer is undefined', () => {
    // CORRECT OUTCOME: 'current' appears in visibleScenarioIds
    const plan = buildRehydrationPlan([], existing);
    expect(plan.visibleScenarioIds).toContain('current');
  });

  it('should hide current when currentLayer.visible is false', () => {
    const plan = buildRehydrationPlan([], existing, { visible: false });
    expect(plan.visibleScenarioIds).not.toContain('current');
  });

  it('should include base in visibleScenarioIds only when baseLayer.visible is true', () => {
    const withBase = buildRehydrationPlan([], existing, undefined, { visible: true });
    expect(withBase.visibleScenarioIds).toContain('base');

    const withoutBase = buildRehydrationPlan([], existing, undefined, { visible: false });
    expect(withoutBase.visibleScenarioIds).not.toContain('base');

    // Undefined baseLayer → base not visible (no default-on for base)
    const noBase = buildRehydrationPlan([], existing);
    expect(noBase.visibleScenarioIds).not.toContain('base');
  });

  it('should preserve visibility_mode in the plan', () => {
    const blueprints = [
      { queryDSL: 'context(channel:google)', name: 'Live A', colour: '#EC4899', is_live: true, visible: true, order: 0, visibility_mode: 'e' as const, params: undefined },
    ] as any;

    const plan = buildRehydrationPlan(blueprints, existing, { visible: true, visibility_mode: 'f' as const });
    expect(plan.visibilityMode['current']).toBe('f');
    expect(plan.visibilityMode['e1']).toBe('e');
  });
});

// ---------------------------------------------------------------------------
// finalisePlan
// ---------------------------------------------------------------------------

describe('finalisePlan', () => {
  it('should replace __pending_ placeholders with real IDs in all arrays', () => {
    // Setup: plan has a pending entry at order 0
    // CORRECT OUTCOME: all occurrences of __pending_0 become 'real-id'
    const plan = {
      entries: [{ blueprint: { order: 0 } as any, existingId: null }],
      visibleScenarioIds: ['current', '__pending_0'],
      scenarioOrder: ['__pending_0', 'current'],
      visibilityMode: { current: 'f+e' as const, '__pending_0': 'f' as const },
    };

    const createdIds = new Map([[0, 'real-id']]);
    const result = finalisePlan(plan, createdIds);

    expect(result.visibleScenarioIds).toEqual(['current', 'real-id']);
    expect(result.scenarioOrder).toEqual(['real-id', 'current']);
    expect(result.visibilityMode['real-id']).toBe('f');
    expect(result.visibilityMode['__pending_0']).toBeUndefined();
  });

  it('should leave non-pending IDs untouched', () => {
    const plan = {
      entries: [],
      visibleScenarioIds: ['current', 'existing-1', 'base'],
      scenarioOrder: ['existing-1', 'current'],
      visibilityMode: {},
    };

    const result = finalisePlan(plan, new Map());
    expect(result.visibleScenarioIds).toEqual(['current', 'existing-1', 'base']);
    expect(result.scenarioOrder).toEqual(['existing-1', 'current']);
  });
});
