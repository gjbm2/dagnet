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

  const edgeKeys = edges
    .map(e => `${String(e?.uuid || '')}:${String(e?.from || '')}->${String(e?.to || '')}`)
    .sort();

  // Only include nodes referenced by at least one edge — isolated nodes
  // don't affect queries, MSMDC, or data fetching, so adding/removing them
  // should not trigger scenario regeneration or chart reconciliation.
  const connectedIds = new Set<string>();
  for (const e of edges) {
    if (e?.from) connectedIds.add(String(e.from));
    if (e?.to) connectedIds.add(String(e.to));
  }
  const nodeKeys = nodes
    .filter(n => connectedIds.has(String(n?.id || '')) || connectedIds.has(String(n?.uuid || '')))
    .map(n => `${String(n?.uuid || '')}:${String(n?.id || '')}`)
    .sort();

  return `n:${nodeKeys.join('|')};e:${edgeKeys.join('|')}`;
}


