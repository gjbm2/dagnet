import type { Edge, Node } from 'reactflow';

export function toFlow(graph: any, callbacks?: { onUpdateNode?: (id: string, data: any) => void; onDeleteNode?: (id: string) => void; onUpdateEdge?: (id: string, data: any) => void; onDeleteEdge?: (id: string) => void; onDoubleClickNode?: (id: string, field: string) => void; onDoubleClickEdge?: (id: string, field: string) => void; onSelectEdge?: (id: string) => void; onEdgeUpdate?: (oldEdge: any, newConnection: any) => void; onReconnect?: (id: string, newSource?: string, newTarget?: string, newTargetHandle?: string, newSourceHandle?: string) => void }): { nodes: Node[]; edges: Edge[] } {
  if (!graph) return { nodes: [], edges: [] };
  
  const nodes: Node[] = (graph.nodes || []).map((n: any) => ({
    id: n.uuid,  // ReactFlow node ID uses the UUID
    type: 'conversion',
    position: { x: n.layout?.x ?? 0, y: n.layout?.y ?? 0 },
    data: { 
      uuid: n.uuid,
      id: n.id,  // Human-readable ID (formerly "id")
      label: n.label || n.id,
      absorbing: n.absorbing,
      outcome_type: n.outcome_type,
      description: n.description,
      entry: n.entry,
      type: n.type, // Add node type (normal/case)
      case: n.case, // Add case data for case nodes
      layout: n.layout, // Add layout object (includes color!)
      onUpdate: callbacks?.onUpdateNode,
      onDelete: callbacks?.onDeleteNode,
      onDoubleClick: callbacks?.onDoubleClickNode,
    },
  }));

  const edges: Edge[] = (graph.edges || []).map((e: any) => {
    // Resolve e.from and e.to to UUIDs (they can be either UUID or human-readable ID)
    const sourceNode = graph.nodes.find((n: any) => n.uuid === e.from || n.id === e.from);
    const targetNode = graph.nodes.find((n: any) => n.uuid === e.to || n.id === e.to);
    
    if (!sourceNode || !targetNode) {
      console.warn(`Edge ${e.uuid || e.id} references non-existent nodes: from=${e.from}, to=${e.to}`);
      return null;
    }
    
    return {
    id: e.uuid || `${e.from}->${e.to}`,  // ReactFlow edge ID uses the UUID
    type: 'conversion',
    source: sourceNode.uuid,  // ReactFlow needs UUID (node.id in ReactFlow is the UUID)
    target: targetNode.uuid,  // ReactFlow needs UUID
    sourceHandle: e.fromHandle,
    targetHandle: e.toHandle,
    reconnectable: true, // CSS and callback will enforce selection requirement
    data: {
      uuid: e.uuid || `${e.from}->${e.to}`,
      id: e.id,  // Human-readable ID (formerly "id")
      parameter_id: e.parameter_id, // Probability parameter ID
      cost_gbp_parameter_id: e.cost_gbp_parameter_id, // GBP cost parameter ID
      cost_time_parameter_id: e.cost_time_parameter_id, // Time cost parameter ID
      probability: e.p?.mean ?? 0.5,
      stdev: e.p?.stdev,
      locked: e.p?.locked,
      description: e.description,
      cost_gbp: e.cost_gbp, // Flat cost structure
      cost_time: e.cost_time, // Flat cost structure
      weight_default: e.weight_default,
      case_variant: e.case_variant, // Add case variant for case edges
      case_id: e.case_id, // Add case ID for case edges
      onUpdate: callbacks?.onUpdateEdge,
      onDelete: callbacks?.onDeleteEdge,
      onDoubleClick: callbacks?.onDoubleClickEdge,
      onSelect: callbacks?.onSelectEdge,
      onEdgeUpdate: callbacks?.onEdgeUpdate,
      onReconnect: callbacks?.onReconnect,
    },
  };
  }).filter(Boolean); // Remove null entries from invalid edges

  return { nodes, edges: edges as Edge[] };
}

export function fromFlow(nodes: Node[], edges: Edge[], original: any): any {
  if (!original) return null;
  
  return {
    ...original,
    nodes: nodes.map((n) => ({
      uuid: n.id,  // ReactFlow node ID is the UUID
      id: n.data.id ?? '', // Human-readable ID (use nullish coalescing to preserve empty strings)
      label: n.data.label,
      absorbing: n.data.absorbing ?? false,
      outcome_type: n.data.outcome_type,
      description: n.data.description,
      entry: n.data.entry,
      type: n.data.type, // Add node type (normal/case)
      case: n.data.case, // Add case data for case nodes
      layout: {
        ...n.data.layout, // Preserve all layout properties (including color!)
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
      },
    })),
    edges: edges.map((e) => {
      // Find the original edge to preserve all its properties
      const originalEdge = original.edges?.find((oe: any) => 
        oe.uuid === e.id || `${oe.from}->${oe.to}` === e.id
      );
      
      return {
        ...originalEdge, // Preserve ALL original properties (including conditional_p, display)
        uuid: e.id,  // ReactFlow edge ID is the UUID
        id: e.data?.id,  // Human-readable ID
        parameter_id: e.data?.parameter_id, // Probability parameter ID
        cost_gbp_parameter_id: e.data?.cost_gbp_parameter_id, // GBP cost parameter ID
        cost_time_parameter_id: e.data?.cost_time_parameter_id, // Time cost parameter ID
        from: e.source,
        to: e.target,
        fromHandle: e.sourceHandle,
        toHandle: e.targetHandle,
        p: { 
          mean: e.data?.probability ?? 0.5,
          stdev: e.data?.stdev,
          locked: e.data?.locked,
        },
        cost_gbp: e.data?.cost_gbp, // Flat cost structure
        cost_time: e.data?.cost_time, // Flat cost structure
        description: e.data?.description ?? '',
        weight_default: e.data?.weight_default,
        case_variant: e.data?.case_variant, // Add case variant for case edges
        case_id: e.data?.case_id, // Add case ID for case edges
      };
    }),
  };
}
