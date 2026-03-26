/**
 * canvasViewService — pure functions for canvas view CRUD and application.
 *
 * A canvas view captures the minimised/maximised state of every post-it and
 * canvas analysis on a graph. While a view is active, all min/max changes
 * auto-save back to it.
 */

import type { ConversionGraph, CanvasView, CanvasViewObjectState } from '@/types';

/** Generate a short random ID for new views. */
function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Snapshot the current min/max state of all canvas objects into an array. */
export function snapshotStates(graph: ConversionGraph): CanvasViewObjectState[] {
  const states: CanvasViewObjectState[] = [];
  for (const p of graph.postits ?? []) {
    states.push({
      id: p.id,
      type: 'postit',
      minimised: !!p.minimised,
      anchor: (p as any).minimised_anchor ?? undefined,
    });
  }
  for (const a of graph.canvasAnalyses ?? []) {
    states.push({
      id: a.id,
      type: 'analysis',
      minimised: !!a.minimised,
      anchor: (a as any).minimised_anchor ?? undefined,
    });
  }
  return states;
}

/** Create a new canvas view from the current graph state. Returns [updatedGraph, newViewId]. */
export function createCanvasView(
  graph: ConversionGraph,
  name: string,
  viewport?: { x: number; y: number; zoom: number },
): [ConversionGraph, string] {
  const id = newId();
  const view: CanvasView = { id, name, states: snapshotStates(graph), viewport };
  const next = { ...graph, canvasViews: [...(graph.canvasViews ?? []), view] };
  return [next, id];
}

/** Apply a canvas view's saved state to the graph objects.
 *  Objects not listed in the view stay as-is but are added to the view (it "learns" them). */
export function applyCanvasView(
  graph: ConversionGraph,
  viewId: string,
): ConversionGraph {
  const next = structuredClone(graph);
  const view = (next.canvasViews ?? []).find(v => v.id === viewId);
  if (!view) return next;

  const stateMap = new Map(view.states.map(s => [`${s.type}:${s.id}`, s]));

  // Apply saved states to postits
  for (const p of next.postits ?? []) {
    const key = `postit:${p.id}`;
    const saved = stateMap.get(key);
    if (saved) {
      // Apply saved state and calculate position change
      const wasMinimised = !!p.minimised;
      const willMinimise = saved.minimised;
      if (wasMinimised !== willMinimise) {
        const anchor = willMinimise
          ? (saved.anchor || 'tl')
          : ((p as any).minimised_anchor || 'tl');
        const mw = 32, mh = 32;
        const dx = (anchor === 'tr' || anchor === 'br') ? p.width - mw : 0;
        const dy = (anchor === 'bl' || anchor === 'br') ? p.height - mh : 0;
        if (willMinimise) {
          p.x += dx; p.y += dy;
          (p as any).minimised_anchor = saved.anchor || 'tl';
        } else {
          p.x -= dx; p.y -= dy;
        }
      }
      p.minimised = saved.minimised;
      if (saved.anchor) (p as any).minimised_anchor = saved.anchor;
      stateMap.delete(key);
    } else {
      // Object not in view — add it with current state
      view.states.push({
        id: p.id, type: 'postit',
        minimised: !!p.minimised,
        anchor: (p as any).minimised_anchor ?? undefined,
      });
    }
  }

  // Apply saved states to analyses
  for (const a of next.canvasAnalyses ?? []) {
    const key = `analysis:${a.id}`;
    const saved = stateMap.get(key);
    if (saved) {
      const wasMinimised = !!a.minimised;
      const willMinimise = saved.minimised;
      if (wasMinimised !== willMinimise) {
        const anchor = willMinimise
          ? (saved.anchor || 'tl')
          : ((a as any).minimised_anchor || 'tl');
        const mw = 32, mh = 32;
        const dx = (anchor === 'tr' || anchor === 'br') ? a.width - mw : 0;
        const dy = (anchor === 'bl' || anchor === 'br') ? a.height - mh : 0;
        if (willMinimise) {
          a.x += dx; a.y += dy;
          (a as any).minimised_anchor = saved.anchor || 'tl';
        } else {
          a.x -= dx; a.y -= dy;
        }
      }
      a.minimised = saved.minimised;
      if (saved.anchor) (a as any).minimised_anchor = saved.anchor;
      stateMap.delete(key);
    } else {
      view.states.push({
        id: a.id, type: 'analysis',
        minimised: !!a.minimised,
        anchor: (a as any).minimised_anchor ?? undefined,
      });
    }
  }

  // Prune orphaned entries (objects that no longer exist on the graph)
  const existingIds = new Set([
    ...(next.postits ?? []).map(p => `postit:${p.id}`),
    ...(next.canvasAnalyses ?? []).map(a => `analysis:${a.id}`),
  ]);
  view.states = view.states.filter(s => existingIds.has(`${s.type}:${s.id}`));

  return next;
}

/** Update a single object's state within a view. Called on every min/max toggle while active. */
export function updateViewObjectState(
  graph: ConversionGraph,
  viewId: string,
  objectId: string,
  objectType: 'postit' | 'analysis',
  minimised: boolean,
  anchor?: 'tl' | 'tr' | 'bl' | 'br',
): ConversionGraph {
  const next = { ...graph, canvasViews: (graph.canvasViews ?? []).map(v => {
    if (v.id !== viewId) return v;
    const updated = { ...v, states: [...v.states] };
    const idx = updated.states.findIndex(s => s.id === objectId && s.type === objectType);
    const entry: CanvasViewObjectState = { id: objectId, type: objectType, minimised, anchor };
    if (idx >= 0) {
      updated.states[idx] = entry;
    } else {
      updated.states.push(entry);
    }
    return updated;
  })};
  return next;
}

/** Delete a canvas view. */
export function deleteCanvasView(
  graph: ConversionGraph,
  viewId: string,
): ConversionGraph {
  return {
    ...graph,
    canvasViews: (graph.canvasViews ?? []).filter(v => v.id !== viewId),
  };
}

/** Toggle the locked state of a canvas view. */
export function toggleCanvasViewLocked(
  graph: ConversionGraph,
  viewId: string,
): ConversionGraph {
  return {
    ...graph,
    canvasViews: (graph.canvasViews ?? []).map(v =>
      v.id === viewId ? { ...v, locked: !v.locked } : v
    ),
  };
}

/** Rename a canvas view. */
export function renameCanvasView(
  graph: ConversionGraph,
  viewId: string,
  newName: string,
): ConversionGraph {
  return {
    ...graph,
    canvasViews: (graph.canvasViews ?? []).map(v =>
      v.id === viewId ? { ...v, name: newName } : v
    ),
  };
}
