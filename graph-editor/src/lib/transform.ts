import type { Edge, Node } from 'reactflow';

export function toFlow(graph: any, callbacks?: { onUpdateNode?: (id: string, data: any) => void; onDeleteNode?: (id: string) => void; onUpdateEdge?: (id: string, data: any) => void; onDeleteEdge?: (id: string) => void; onDoubleClickNode?: (id: string, field: string) => void; onDoubleClickEdge?: (id: string, field: string) => void; onSelectEdge?: (id: string) => void; onReconnect?: (id: string, newSource?: string, newTarget?: string, newTargetHandle?: string, newSourceHandle?: string) => void }): { nodes: Node[]; edges: Edge[] } {
  if (!graph) return { nodes: [], edges: [] };
  
  const nodes: Node[] = (graph.nodes || []).map((n: any) => ({
    id: n.id,
    type: 'conversion',
    position: { x: n.layout?.x ?? 0, y: n.layout?.y ?? 0 },
    data: { 
      id: n.id,
      label: n.label || n.slug,
      slug: n.slug,
      absorbing: n.absorbing,
      outcome_type: n.outcome_type,
      description: n.description,
      entry: n.entry,
      type: n.type, // Add node type (normal/case)
      case: n.case, // Add case data for case nodes
      onUpdate: callbacks?.onUpdateNode,
      onDelete: callbacks?.onDeleteNode,
      onDoubleClick: callbacks?.onDoubleClickNode,
    },
  }));

  const edges: Edge[] = (graph.edges || []).map((e: any) => ({
    id: e.id || `${e.from}->${e.to}`,
    type: 'conversion',
    source: e.from,
    target: e.to,
    sourceHandle: e.fromHandle,
    targetHandle: e.toHandle,
    data: {
      id: e.id || `${e.from}->${e.to}`,
      slug: e.slug,
      probability: e.p?.mean ?? 0.5,
      stdev: e.p?.stdev,
      locked: e.p?.locked,
      description: e.description,
      costs: e.costs,
      weight_default: e.weight_default,
      case_variant: e.case_variant, // Add case variant for case edges
      case_id: e.case_id, // Add case ID for case edges
      onUpdate: callbacks?.onUpdateEdge,
      onDelete: callbacks?.onDeleteEdge,
      onDoubleClick: callbacks?.onDoubleClickEdge,
      onSelect: callbacks?.onSelectEdge,
      onReconnect: callbacks?.onReconnect,
    },
  }));

  return { nodes, edges };
}

export function fromFlow(nodes: Node[], edges: Edge[], original: any): any {
  if (!original) return null;
  
  return {
    ...original,
    nodes: nodes.map((n) => ({
      id: n.id,
      slug: n.data.slug || n.id,
      label: n.data.label,
      absorbing: n.data.absorbing ?? false,
      outcome_type: n.data.outcome_type,
      description: n.data.description,
      entry: n.data.entry,
      type: n.data.type, // Add node type (normal/case)
      case: n.data.case, // Add case data for case nodes
      layout: {
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
      },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      slug: e.data?.slug,
      from: e.source,
      to: e.target,
      fromHandle: e.sourceHandle,
      toHandle: e.targetHandle,
      p: { 
        mean: e.data?.probability ?? 0.5,
        stdev: e.data?.stdev,
        locked: e.data?.locked,
      },
      description: e.data?.description ?? '',
      costs: e.data?.costs,
      weight_default: e.data?.weight_default,
      case_variant: e.data?.case_variant, // Add case variant for case edges
      case_id: e.data?.case_id, // Add case ID for case edges
    })),
  };
}
