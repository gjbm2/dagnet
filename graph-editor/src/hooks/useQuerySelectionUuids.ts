/**
 * useQuerySelectionUuids
 *
 * Centralised helper for querying the current multi-selection from the graph canvas.
 * This uses the existing synchronous `dagnet:querySelection` event mechanism that
 * GraphCanvas listens to and populates with UUIDs.
 *
 * Kept as a hook-like module (in hooks/) so UI components don't re-implement the
 * event wiring ad-hoc.
 */

export interface GraphSelectionUuids {
  selectedNodeUuids: string[];
  selectedEdgeUuids: string[];
}

/**
 * Query the current selection UUIDs (nodes + edges) from the active GraphCanvas.
 *
 * If GraphCanvas is not mounted/active, this returns empty arrays.
 */
export function querySelectionUuids(): GraphSelectionUuids {
  const detail: GraphSelectionUuids = { selectedNodeUuids: [], selectedEdgeUuids: [] };
  globalThis.window?.dispatchEvent?.(new CustomEvent('dagnet:querySelection', { detail }));
  return detail;
}




