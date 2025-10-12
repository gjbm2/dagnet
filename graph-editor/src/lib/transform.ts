import type { Edge, Node } from 'reactflow';

export function toFlow(graph: any): { nodes: Node[]; edges: Edge[] } {
  if (!graph) return { nodes: [], edges: [] };
  const nodes: Node[] = (graph.nodes || []).map((n: any) => ({
    id: n.slug || n.id,
    position: { x: n.layout?.x ?? 0, y: n.layout?.y ?? 0 },
    data: { label: n.label || n.slug, raw: n },
    style: { border: '1px solid #ddd', padding: 8, borderRadius: 8, background: n.layout?.color || '#fff' },
  }));

  const edges: Edge[] = (graph.edges || []).map((e: any) => ({
    id: e.id || `${e.from}->${e.to}`,
    source: e.from,
    target: e.to,
    label: e.p?.mean != null ? String(e.p.mean) : undefined,
  }));

  return { nodes, edges };
}

export function fromFlow(nodes: Node[], edges: Edge[], original: any) {
  if (!original) return null;
  const idBySlug = new Map<string, string>();
  original.nodes.forEach((n: any) => idBySlug.set(n.slug || n.id, n.id));

  const nextNodes = original.nodes.map((n: any) => {
    const rf = nodes.find(nn => (nn.id === (n.slug || n.id)));
    if (!rf) return n;
    return {
      ...n,
      layout: { ...n.layout, x: Math.round(rf.position.x), y: Math.round(rf.position.y) }
    };
  });

  const nextEdges = original.edges.map((e: any) => ({ ...e }));
  // Note: for MVP we don't add/remove edges in JSON here; we only move nodes and edit labels via future UI.
  // Extending to full add/remove is straightforward: diff edges and nodes and update original accordingly.

  return { ...original, nodes: nextNodes, edges: nextEdges };
}
