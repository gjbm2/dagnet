import type { Edge, Node } from 'reactflow';

export function toFlow(graph: any, callbacks?: { onUpdateNode?: (id: string, data: any) => void; onDeleteNode?: (id: string) => void; onUpdateEdge?: (id: string, data: any) => void; onDeleteEdge?: (id: string) => void; onDoubleClickNode?: (id: string, field: string) => void; onDoubleClickEdge?: (id: string, field: string) => void; onSelectEdge?: (id: string) => void; onEdgeUpdate?: (oldEdge: any, newConnection: any) => void; onReconnect?: (id: string, newSource?: string, newTarget?: string, newTargetHandle?: string, newSourceHandle?: string) => void }, useSankeyView?: boolean): { nodes: Node[]; edges: Edge[] } {
  if (!graph) return { nodes: [], edges: [] };
  
  const nodes: Node[] = (graph.nodes || []).map((n: any) => {
    // In Sankey view, layout.x/y are already top-left coordinates from d3-sankey
    // In normal view, layout.x/y are center coordinates
    // ReactFlow expects top-left, so in Sankey mode we use them directly
    let positionX = n.layout?.x ?? 0;
    let positionY = n.layout?.y ?? 0;
    
    // No conversion needed for Sankey view - d3-sankey already gives us top-left
    // (Note: in normal mode, we should ideally convert center to top-left too, but
    // historically we've been passing center coords and it works because nodes center themselves)
    
    return {
    id: n.uuid,  // ReactFlow node ID uses the UUID
    type: 'conversion',
    position: { x: positionX, y: positionY },
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
      event_id: n.event_id, // Add event_id for DAS queries
      event_id_overridden: n.event_id_overridden, // Override flag
      onUpdate: callbacks?.onUpdateNode,
      onDelete: callbacks?.onDeleteNode,
      onDoubleClick: callbacks?.onDoubleClickNode,
    },
  };
  });

  const edges: Edge[] = (graph.edges || []).map((e: any) => {
    // Resolve e.from and e.to to UUIDs (they can be either UUID or human-readable ID)
    const sourceNode = graph.nodes.find((n: any) => n.uuid === e.from || n.id === e.from);
    const targetNode = graph.nodes.find((n: any) => n.uuid === e.to || n.id === e.to);
    
    if (!sourceNode || !targetNode) {
      console.warn(`Edge ${e.uuid || e.id} references non-existent nodes: from=${e.from}, to=${e.to}`);
      return null;
    }
    
    // Edge MUST have a UUID - if missing, this is a data corruption issue
    if (!e.uuid) {
      console.error(`Edge missing UUID! from=${e.from}, to=${e.to}, id=${e.id}`);
      // Don't create edges without proper UUIDs - they corrupt the scenario params
      return null;
    }
    
    return {
    id: e.uuid,  // ReactFlow edge ID uses the UUID
    type: 'conversion',
    source: sourceNode.uuid,  // ReactFlow needs UUID (node.id in ReactFlow is the UUID)
    target: targetNode.uuid,  // ReactFlow needs UUID
    sourceHandle: e.fromHandle,
    targetHandle: e.toHandle,
    reconnectable: true, // CSS and callback will enforce selection requirement
    data: {
      uuid: e.uuid,
      id: e.id,  // Human-readable ID (formerly "id")
      parameter_id: e.p?.id || e.parameter_id, // Probability parameter ID (prefer nested p.id, fallback to flat for backwards compat)
      cost_gbp_parameter_id: e.cost_gbp?.id || e.cost_gbp_parameter_id, // GBP cost parameter ID
      cost_time_parameter_id: e.cost_time?.id || e.cost_time_parameter_id, // Time cost parameter ID
      probability: e.p?.mean ?? 0.5,
      stdev: e.p?.stdev,
      locked: e.p?.locked,
      description: e.description,
      p: e.p, // Full probability parameter object (includes connection, connection_string, query, evidence, conditional_ps)
      cost_gbp: e.cost_gbp, // Full cost_gbp parameter object (includes connection, connection_string, query, evidence)
      cost_time: e.cost_time, // Full cost_time parameter object (includes connection, connection_string, query, evidence)
      weight_default: e.weight_default,
      case_variant: e.case_variant, // Add case variant for case edges
      case_id: e.case_id, // Add case ID for case edges
      query: e.query, // Direct query on edge (for backward compat)
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
      event_id: n.data.event_id, // Add event_id for DAS queries
      event_id_overridden: n.data.event_id_overridden, // Override flag
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
      
      // DIAGNOSTIC: Log p.id transformation for the edge being edited
      if (e.id === '550e8400-e29b-41d4-a716-446655440001->52207d6c-d3e3-4fda-a727-484eb1706041') {
        console.log(`[fromFlow] BEFORE: edge.uuid=${e.id}, originalEdge.p=${JSON.stringify(originalEdge?.p)}`);
      }
      
      // Merge p object: preserve original fields (like mean_overridden) while applying ReactFlow updates
      const mergedP = e.data?.p ? {
        ...originalEdge?.p,  // Start with original p to preserve ALL fields (mean_overridden, etc.)
        ...e.data.p,         // Override with ReactFlow data (which has updated mean, etc.)
        // Explicitly set mean from probability field if it exists (ReactFlow uses 'probability' field)
        mean: e.data?.probability !== undefined ? e.data.probability : (e.data.p.mean ?? originalEdge?.p?.mean ?? 0.5),
        stdev: e.data?.stdev !== undefined ? e.data.stdev : (e.data.p.stdev ?? originalEdge?.p?.stdev),
        locked: e.data?.locked !== undefined ? e.data.locked : (e.data.p.locked ?? originalEdge?.p?.locked),
        // Preserve mean_overridden from original if not explicitly set in e.data.p
        mean_overridden: e.data.p.mean_overridden !== undefined ? e.data.p.mean_overridden : originalEdge?.p?.mean_overridden,
      } : {
        ...originalEdge?.p,  // Preserve ALL p fields (id, distribution, evidence, mean_overridden, etc.)
        mean: e.data?.probability ?? originalEdge?.p?.mean ?? 0.5,
        stdev: e.data?.stdev ?? originalEdge?.p?.stdev,
        locked: e.data?.locked ?? originalEdge?.p?.locked,
      };

      const result = {
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
        p: mergedP,
        cost_gbp: e.data?.cost_gbp ?? originalEdge?.cost_gbp, // Full cost_gbp parameter object
        cost_time: e.data?.cost_time ?? originalEdge?.cost_time, // Full cost_time parameter object
        description: e.data?.description ?? '',
        weight_default: e.data?.weight_default,
        case_variant: e.data?.case_variant, // Add case variant for case edges
        case_id: e.data?.case_id, // Add case ID for case edges
        query: e.data?.query ?? originalEdge?.query, // Query object for DAS
      };
      
      // DIAGNOSTIC: Log p.id transformation for the edge being edited
      if (e.id === '550e8400-e29b-41d4-a716-446655440001->52207d6c-d3e3-4fda-a727-484eb1706041') {
        console.log(`[fromFlow] AFTER: edge.uuid=${e.id}, result.p=${JSON.stringify(result.p)}`);
      }
      
      return result;
    }),
  };
}
