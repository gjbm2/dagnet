/**
 * canvasViewService — pure functions for canvas view CRUD and application.
 *
 * A canvas view captures layout state (min/max), display modes, viewport,
 * and scenario blueprints. While a view is active, changes auto-save back
 * to it (unless locked). Apply-scope toggles control which categories of
 * state are captured and applied.
 */

import type { ConversionGraph, CanvasView, CanvasViewObjectState, CanvasViewScenario, CanvasViewLayerVisibility, ViewportBounds, ViewportPixel } from '@/types';
import { isViewportBounds } from '@/types';

/** Generate a short random ID for new views. */
function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Check if an apply-scope toggle is enabled (undefined = true). */
export function scopeEnabled(value: boolean | undefined): boolean {
  return value !== false;
}

// ---------------------------------------------------------------------------
// Viewport ↔ bounds conversion (resolution-independent view storage)
// ---------------------------------------------------------------------------

/**
 * Convert a ReactFlow transform + container size into a node-space bounding box.
 * Returns undefined if container dimensions are invalid (not yet rendered).
 */
export function viewportToBounds(
  transform: [number, number, number],
  containerWidth: number,
  containerHeight: number,
): ViewportBounds | undefined {
  const [tx, ty, zoom] = transform;
  if (!containerWidth || !containerHeight || !zoom) return undefined;
  return {
    x: -tx / zoom,
    y: -ty / zoom,
    width: containerWidth / zoom,
    height: containerHeight / zoom,
  };
}

/**
 * Convert a node-space bounding box into a ReactFlow viewport for the current container.
 * Centres the bounds if aspect ratios differ. Clamps zoom to [minZoom, maxZoom].
 */
export function boundsToViewport(
  bounds: ViewportBounds,
  containerWidth: number,
  containerHeight: number,
  maxZoom = 2,
  minZoom = 0.1,
): ViewportPixel {
  if (!bounds.width || !bounds.height || !containerWidth || !containerHeight) {
    return { x: 0, y: 0, zoom: 1 };
  }
  const zoomX = containerWidth / bounds.width;
  const zoomY = containerHeight / bounds.height;
  let zoom = Math.min(zoomX, zoomY);
  zoom = Math.max(minZoom, Math.min(maxZoom, zoom));

  // Centre the bounds in the container
  const scaledWidth = bounds.width * zoom;
  const scaledHeight = bounds.height * zoom;
  const x = -bounds.x * zoom + (containerWidth - scaledWidth) / 2;
  const y = -bounds.y * zoom + (containerHeight - scaledHeight) / 2;

  return { x, y, zoom };
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

/** Snapshot scenario state from the tab into view-storable blueprints.
 *  Current is captured as a scenario blueprint with queryDSL = currentDSL. */
export function snapshotScenarios(
  scenarios: Array<{ id: string; name: string; colour: string; meta?: any; params?: any }>,
  scenarioState: {
    visibleScenarioIds?: string[];
    scenarioOrder?: string[];
    visibilityMode?: Record<string, string>;
  },
  currentDSL?: string,
): {
  currentLayer: CanvasViewLayerVisibility;
  baseLayer: CanvasViewLayerVisibility;
  scenarios: CanvasViewScenario[];
} {
  const visibleIds = new Set(scenarioState.visibleScenarioIds ?? []);
  const order = scenarioState.scenarioOrder ?? [];
  const modes = scenarioState.visibilityMode ?? {};

  const currentLayer: CanvasViewLayerVisibility = {
    visible: visibleIds.has('current'),
    visibility_mode: (modes['current'] as any) ?? undefined,
    queryDSL: currentDSL || undefined,
  };
  const baseLayer: CanvasViewLayerVisibility = {
    visible: visibleIds.has('base'),
    visibility_mode: (modes['base'] as any) ?? undefined,
  };

  // Build ordered list of user scenarios
  const userOrder = order.filter(id => id !== 'current' && id !== 'base');
  const scenarioMap = new Map(scenarios.map(s => [s.id, s]));
  const blueprints: CanvasViewScenario[] = [];

  for (let i = 0; i < userOrder.length; i++) {
    const id = userOrder[i];
    const s = scenarioMap.get(id);
    if (!s) continue;
    const isLive = !!(s.meta?.queryDSL);
    blueprints.push({
      queryDSL: isLive ? s.meta.queryDSL : undefined,
      params: !isLive ? s.params : undefined,
      name: s.name,
      colour: s.colour,
      is_live: isLive,
      visible: visibleIds.has(id),
      order: i,
      visibility_mode: (modes[id] as any) ?? undefined,
      whatIfDSL: s.meta?.whatIfDSL ?? undefined,
    });
  }

  return { currentLayer, baseLayer, scenarios: blueprints };
}

/** Create a new canvas view from the current graph state. Returns [updatedGraph, newViewId]. */
export function createCanvasView(
  graph: ConversionGraph,
  name: string,
  viewport?: ViewportPixel | ViewportBounds,
): [ConversionGraph, string] {
  const id = newId();
  const view: CanvasView = { id, name, states: snapshotStates(graph), viewport };
  const next = { ...graph, canvasViews: [...(graph.canvasViews ?? []), view] };
  return [next, id];
}

/** Apply a canvas view's layout state (min/max) to the graph objects.
 *  Only applies if applyLayout is enabled (default true).
 *  Objects not listed in the view stay as-is but are added to the view (it "learns" them). */
export function applyCanvasView(
  graph: ConversionGraph,
  viewId: string,
): ConversionGraph {
  const next = structuredClone(graph);
  const view = (next.canvasViews ?? []).find(v => v.id === viewId);
  if (!view) return next;

  // Only apply layout changes if the scope toggle is enabled
  if (scopeEnabled(view.applyLayout)) {
    const stateMap = new Map(view.states.map(s => [`${s.type}:${s.id}`, s]));

    // Apply saved states to postits
    for (const p of next.postits ?? []) {
      const key = `postit:${p.id}`;
      const saved = stateMap.get(key);
      if (saved) {
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

    // Prune orphaned entries
    const existingIds = new Set([
      ...(next.postits ?? []).map(p => `postit:${p.id}`),
      ...(next.canvasAnalyses ?? []).map(a => `analysis:${a.id}`),
    ]);
    view.states = view.states.filter(s => existingIds.has(`${s.type}:${s.id}`));
  }

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
    if (!scopeEnabled(v.applyLayout)) return v;
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

/** Toggle an apply-scope flag on a canvas view. */
export function toggleCanvasViewScope(
  graph: ConversionGraph,
  viewId: string,
  scope: 'applyScenarios' | 'applyLayout' | 'applyDisplayMode',
): ConversionGraph {
  return {
    ...graph,
    canvasViews: (graph.canvasViews ?? []).map(v =>
      v.id === viewId ? { ...v, [scope]: !scopeEnabled(v[scope]) } : v
    ),
  };
}

/** Reorder canvas views by moving a view from one index to another. */
export function reorderCanvasViews(
  graph: ConversionGraph,
  fromIndex: number,
  toIndex: number,
): ConversionGraph {
  const views = [...(graph.canvasViews ?? [])];
  if (fromIndex < 0 || fromIndex >= views.length || toIndex < 0 || toIndex >= views.length || fromIndex === toIndex) {
    return graph;
  }
  const [moved] = views.splice(fromIndex, 1);
  views.splice(toIndex, 0, moved);
  return { ...graph, canvasViews: views };
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
