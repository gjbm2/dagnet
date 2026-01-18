/**
 * Compute a lightweight, stable signature of graph topology.
 *
 * Purpose:
 * - detect topology/structure changes (nodes/edges/connectivity) without treating
 *   every param/data mutation as a topology change.
 *
 * This is intentionally conservative and does not attempt to capture all semantics.
 */
export function graphTopologySignature(graph: any): string | null {
  if (!graph) return null;
  const nodes: any[] = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges: any[] = Array.isArray(graph.edges) ? graph.edges : [];
  if (nodes.length === 0 && edges.length === 0) return 'empty';

  const nodeKeys = nodes
    .map(n => `${String(n?.uuid || '')}:${String(n?.id || '')}`)
    .sort();
  const edgeKeys = edges
    .map(e => `${String(e?.uuid || '')}:${String(e?.from || '')}->${String(e?.to || '')}`)
    .sort();

  return `n:${nodeKeys.join('|')};e:${edgeKeys.join('|')}`;
}


