  // Sync FROM graph TO ReactFlow when graph changes externally
  useEffect(() => {
    if (!graph) return;
    
    // Allow Graph→ReactFlow sync during drag - the fast path will only update edge data, not positions
    
    // Don't block external graph changes (like undo) even if we're syncing ReactFlow->Graph
    // The isSyncingRef flag should only prevent ReactFlow->Graph sync, not Graph->ReactFlow sync
    
    const graphJson = JSON.stringify(graph);
    if (graphJson === lastSyncedGraphRef.current) {
      return;
    }
    lastSyncedGraphRef.current = graphJson;
    
    console.log('🔄 Graph→ReactFlow sync triggered');
    console.log('  Graph edges (UUIDs):', graph.edges?.map((e: any) => e.uuid));
    console.log('  ReactFlow edges (UUIDs):', edges.map(e => e.id));
    
    // Set syncing flag to prevent re-routing during graph->ReactFlow sync
    isSyncingRef.current = true;
    
    // Check if only edge probabilities changed (not topology or node positions)
    const edgeCountChanged = edges.length !== (graph.edges?.length || 0);
    const nodeCountChanged = nodes.length !== (graph.nodes?.length || 0);
    
    console.log('  Edge count changed:', edgeCountChanged, `(${edges.length} -> ${graph.edges?.length || 0})`);
    console.log('  Node count changed:', nodeCountChanged);
    
    // Check if any node positions changed
    const nodePositionsChanged = nodes.some(node => {
      const graphNode = graph.nodes.find((n: any) => n.uuid === node.id || n.id === node.id);
      return graphNode && (
        Math.abs((graphNode.layout?.x || 0) - node.position.x) > 0.1 ||
        Math.abs((graphNode.layout?.y || 0) - node.position.y) > 0.1
      );
    });
    
    // Check if any edge IDs changed (happens when reconnecting to different nodes)
    // NOTE: In ReactFlow, edge.id IS the UUID. In graph, we need e.uuid.
    const graphEdgeIds = new Set(graph.edges.map((e: any) => e.uuid));
    const reactFlowEdgeIds = new Set(edges.map(e => e.id));  // ReactFlow edge.id is the UUID
    const edgeIdsChanged = edges.some(e => !graphEdgeIds.has(e.id)) || 
                           graph.edges.some((e: any) => !reactFlowEdgeIds.has(e.uuid));
    
    console.log('  Edge IDs changed:', edgeIdsChanged);
    if (edgeIdsChanged) {
      console.log('    Old ReactFlow edge IDs:', Array.from(reactFlowEdgeIds));
      console.log('    New Graph edge IDs:', Array.from(graphEdgeIds));
    }
    
    // Check if any edge handles changed
    const edgeHandlesChanged = edges.some(edge => {
      // Find edge by UUID or human-readable ID (Phase 0.0 migration)
      let graphEdge = graph.edges.find((e: any) => e.uuid === edge.id || e.id === edge.id);
      if (!graphEdge) {
        graphEdge = graph.edges.find((e: any) => `${e.from}->${e.to}` === edge.id);
      }
      if (!graphEdge) {
        graphEdge = graph.edges.find((e: any) => e.from === edge.source && e.to === edge.target);
      }
      if (!graphEdge) return false;
      
      return graphEdge.fromHandle !== edge.sourceHandle || graphEdge.toHandle !== edge.targetHandle;
    });
    
    // Check if only node properties changed (not structure or positions)
    const nodePropertiesChanged = nodes.some(node => {
      // Find node by UUID or human-readable ID (Phase 0.0 migration)
      const graphNode = graph.nodes.find((n: any) => n.uuid === node.id || n.id === node.id);
      if (!graphNode) return false;
      
      // Check if any non-position properties changed
      const tagsChanged = JSON.stringify(node.data?.tags || []) !== JSON.stringify(graphNode.tags || []);
      const labelChanged = node.data?.label !== graphNode.label;
      const idChanged = node.data?.id !== graphNode.id;
      const descriptionChanged = node.data?.description !== graphNode.description;
      const absorbingChanged = node.data?.absorbing !== graphNode.absorbing;
      const outcomeTypeChanged = node.data?.outcome_type !== graphNode.outcome_type;
      const entryStartChanged = node.data?.entry?.is_start !== graphNode.entry?.is_start;
      const entryWeightChanged = node.data?.entry?.entry_weight !== graphNode.entry?.entry_weight;
      const caseColorChanged = node.data?.layout?.color !== graphNode.layout?.color;
      const caseTypeChanged = node.data?.type !== graphNode.type;
      const caseDataChanged = JSON.stringify(node.data?.case || {}) !== JSON.stringify(graphNode.case || {});
      
      const hasChanges = labelChanged || idChanged || descriptionChanged || absorbingChanged || 
                        outcomeTypeChanged || tagsChanged || entryStartChanged || entryWeightChanged ||
                        caseColorChanged || caseTypeChanged || caseDataChanged;
      
      if (hasChanges) {
        console.log('Node property changes detected:', {
          nodeId: node.id,
          labelChanged,
          idChanged,
          descriptionChanged,
          absorbingChanged,
          outcomeTypeChanged,
          tagsChanged,
          entryStartChanged,
          entryWeightChanged,
          caseColorChanged,
          caseTypeChanged,
          caseDataChanged,
          nodeTags: node.data?.tags,
          graphTags: graphNode.tags,
          nodeLayout: node.data?.layout,
          graphLayout: graphNode.layout
        });
      }
      
      return hasChanges;
    });
    
    // Fast path: If only edge data changed (no topology, position, or handle changes), update in place
    // CRITICAL: During drag or immediately after drag, ALWAYS take fast path to prevent node position overwrites
    // We ignore nodePositionsChanged during/after drag because ReactFlow has the current drag positions
    // Handle changes require full recalculation because they affect edge bundling, offsets, and widths
    // After drag, we keep isDraggingNodeRef.current true until sync completes to force fast path
    const shouldTakeFastPath = !edgeCountChanged && !nodeCountChanged && !edgeIdsChanged && !edgeHandlesChanged && 
                               edges.length > 0 && (isDraggingNodeRef.current || !nodePositionsChanged);
    
    if (shouldTakeFastPath) {
      const pathReason = isDraggingNodeRef.current ? '(DRAG - ignoring position diff)' : '(positions unchanged)';
      console.log(`  ⚡ Fast path: Topology and handles unchanged, updating edge data in place ${pathReason}`);
      
      // Clear drag flag after determining fast path (if it was set)
      // This ensures we don't block future syncs unnecessarily
      if (isDraggingNodeRef.current) {
        // Use setTimeout to clear after this sync completes
        setTimeout(() => {
          isDraggingNodeRef.current = false;
        }, 0);
      }
      
      // Topology unchanged and handles unchanged - update edge data in place to preserve component identity
      setEdges(prevEdges => {
        // First pass: update edge data without calculateWidth functions
        const result = prevEdges.map(prevEdge => {
          // Try multiple ways to match edges (Phase 0.0 migration: check uuid and id)
          let graphEdge = graph.edges.find((e: any) => e.uuid === prevEdge.id || e.id === prevEdge.id);
          if (!graphEdge) {
            graphEdge = graph.edges.find((e: any) => `${e.from}->${e.to}` === prevEdge.id);
          }
          if (!graphEdge) {
            // Try matching by source and target
            graphEdge = graph.edges.find((e: any) => e.from === prevEdge.source && e.to === prevEdge.target);
          }
          if (!graphEdge) return prevEdge;
          
          // Update edge data while preserving component identity
          return {
            ...prevEdge,
            sourceHandle: graphEdge.fromHandle || prevEdge.sourceHandle,
            targetHandle: graphEdge.toHandle || prevEdge.targetHandle,
            data: {
              ...prevEdge.data,
              id: graphEdge.id,
              parameter_id: (graphEdge as any).parameter_id, // Probability parameter ID
              cost_gbp_parameter_id: (graphEdge as any).cost_gbp_parameter_id, // GBP cost parameter ID
              cost_time_parameter_id: (graphEdge as any).cost_time_parameter_id, // Time cost parameter ID
              probability: graphEdge.p?.mean ?? 0.5,
              stdev: graphEdge.p?.stdev,
              locked: graphEdge.p?.locked,
              description: graphEdge.description,
              cost_gbp: (graphEdge as any).cost_gbp, // New flat cost structure
              cost_time: (graphEdge as any).cost_time, // New flat cost structure
              costs: graphEdge.costs, // Legacy field (for backward compat)
              weight_default: graphEdge.weight_default,
              case_variant: graphEdge.case_variant,
              case_id: graphEdge.case_id,
              useSankeyView: useSankeyView
            }
          };
        });
        
        // Edges are updated without calculateWidth (added by buildScenarioRenderEdges)
        const edgesWithOffsets = calculateEdgeOffsets(result, nodes, MAX_WIDTH);
        
        // Attach offsets to edge data
        return edgesWithOffsets.map(edge => ({
          ...edge,
          data: {
            ...edge.data,
            sourceOffsetX: edge.sourceOffsetX,
            sourceOffsetY: edge.sourceOffsetY,
            targetOffsetX: edge.targetOffsetX,
            targetOffsetY: edge.targetOffsetY,
            scaledWidth: edge.scaledWidth,
            // Bundle metadata
            sourceBundleWidth: edge.sourceBundleWidth,
            targetBundleWidth: edge.targetBundleWidth,
            sourceBundleSize: edge.sourceBundleSize,
            // Recalculate renderFallbackTargetArrow based on new bundle width
            renderFallbackTargetArrow: false,
            targetBundleSize: edge.targetBundleSize,
            isFirstInSourceBundle: edge.isFirstInSourceBundle,
            isLastInSourceBundle: edge.isLastInSourceBundle,
            isFirstInTargetBundle: edge.isFirstInTargetBundle,
            isLastInTargetBundle: edge.isLastInTargetBundle,
            sourceFace: edge.sourceFace,
            targetFace: edge.targetFace,
            // Pass what-if DSL to edges
            whatIfDSL: effectiveWhatIfDSL
          }
        }));
      });
      
      // Also update node properties if they changed
      if (nodePropertiesChanged) {
        setNodes(prevNodes => {
          return prevNodes.map(prevNode => {
            const graphNode = graph.nodes.find((n: any) => n.uuid === prevNode.id || n.id === prevNode.id);
            if (!graphNode) return prevNode;
            
            return {
              ...prevNode,
              data: {
                ...prevNode.data,
                label: graphNode.label,
                id: graphNode.id,
                description: graphNode.description,
                absorbing: graphNode.absorbing,
                outcome_type: graphNode.outcome_type,
                tags: graphNode.tags,
                entry: graphNode.entry,
                type: graphNode.type,
                case: graphNode.case,
                layout: graphNode.layout
              }
            };
          });
        });
      }
      
      return; // Skip full toFlow rebuild
    }
    
    // CRITICAL: Block slow-path rebuilds during drag operations
    // During drag, the store gets updated with new positions, which triggers this sync,
    // which would cause a full rebuild and reset node positions back to their store values
    // This causes the "flickering and reverting" behavior
    if (isDraggingNodeRef.current) {
      console.log('  ⚠️ Slow path BLOCKED: drag in progress, deferring rebuild');
      return;
    }
    
    console.log('  🔨 Slow path: Topology changed, doing full rebuild');
    
    // Topology changed - do full rebuild
    // Preserve current selection state
    const selectedNodeIds = new Set(nodes.filter(n => n.selected).map(n => n.id));
    const selectedEdgeIds = new Set(edges.filter(e => e.selected).map(e => e.id));
    
    // In Sankey mode, force all edges to use left/right handles only
    let graphForBuild = graph;
    if (useSankeyView && graph.edges) {
      graphForBuild = {
        ...graph,
        edges: graph.edges.map(edge => {
          // Calculate optimal handles respecting Sankey constraints
          const sourceNode = graph.nodes?.find(n => n.uuid === edge.from || n.id === edge.from);
          const targetNode = graph.nodes?.find(n => n.uuid === edge.to || n.id === edge.to);
          
          if (!sourceNode || !targetNode) return edge;
          
          const dx = (targetNode.layout?.x ?? 0) - (sourceNode.layout?.x ?? 0);
          const dy = (targetNode.layout?.y ?? 0) - (sourceNode.layout?.y ?? 0);
          
          // Simple horizontal face selection for Sankey
          const sourceFace = dx >= 0 ? 'right' : 'left';
          const targetFace = dx >= 0 ? 'left' : 'right';
          
          return {
            ...edge,
            fromHandle: sourceFace + '-out',
            toHandle: targetFace
          };
        })
      };
    }
    
    const { nodes: newNodes, edges: newEdges } = toFlow(graphForBuild, {
      onUpdateNode: handleUpdateNode,
      onDeleteNode: handleDeleteNode,
      onUpdateEdge: handleUpdateEdge,
      onDeleteEdge: handleDeleteEdge,
      onDoubleClickNode: onDoubleClickNode,
      onDoubleClickEdge: onDoubleClickEdge,
      onSelectEdge: onSelectEdge,
    }, useSankeyView);
    
    // Restore selection state
    let nodesWithSelection = newNodes.map(node => ({
      ...node,
      selected: selectedNodeIds.has(node.id)
    }));
    
    // Apply Sankey view sizing if enabled
    if (useSankeyView) {
      const NODE_WIDTH = DEFAULT_NODE_WIDTH; // Fixed width for Sankey view
      
      // Calculate flow mass through each node
      // For Sankey diagrams, we want to show the TOTAL flow passing through each node
      const flowMass = new Map<string, number>();
      
      console.log('[Sankey] Graph nodes:', graph.nodes?.map((n: any) => ({ uuid: n.uuid, id: n.id, label: n.label, isStart: n.entry?.is_start })));
      console.log('[Sankey] Graph edges:', graph.edges?.map((e: any) => ({ from: e.from, to: e.to, prob: e.p?.mean })));
      
      // Initialize start nodes with their entry weights
      graph.nodes?.forEach((node: any) => {
        if (node.entry?.is_start) {
          const entryWeight = node.entry.entry_weight || 1.0;
          console.log(`[Sankey] Initializing start node ${node.label} (uuid: ${node.uuid}) with mass ${entryWeight}`);
          flowMass.set(node.uuid, entryWeight);
        } else {
          // Initialize all other nodes to 0
          flowMass.set(node.uuid, 0);
        }
      });
      
      console.log('[Sankey] Initial flowMass:', Array.from(flowMass.entries()));
      
      // Build incoming edges map (we calculate mass from incoming flows)
      // Store the full edge object so we can access case information
      const incomingEdges = new Map<string, Array<any>>();
      graph.edges?.forEach((edge: any) => {
        const to = edge.to;
        
        if (!incomingEdges.has(to)) {
          incomingEdges.set(to, []);
        }
        incomingEdges.get(to)!.push(edge);
      });
      
      // Topological sort: process nodes in dependency order
      // Simple approach: iterate until all nodes are calculated
      const processed = new Set<string>();
      let iterations = 0;
      const maxIterations = graph.nodes?.length * 3 || 100;
      
      while (processed.size < (graph.nodes?.length || 0) && iterations < maxIterations) {
        iterations++;
        let madeProgress = false;
        
        graph.nodes?.forEach((node: any) => {
          const nodeId = node.uuid || node.id;
          
          // Skip if already processed or if it's a start node (already initialized)
          if (processed.has(nodeId) || node.entry?.is_start) {
            if (node.entry?.is_start) processed.add(nodeId);
            return;
          }
          
          // Check if all incoming nodes have been processed
          const incoming = incomingEdges.get(nodeId) || [];
          const allIncomingProcessed = incoming.every((edge: any) => processed.has(edge.from));
          
          if (allIncomingProcessed && incoming.length > 0) {
            // Calculate total incoming mass, accounting for case node variant weights and what-if analysis
            let totalMass = 0;
            incoming.forEach((edge: any) => {
              const from = edge.from;
              const sourceMass = flowMass.get(from) || 0;
              
              // Use unified what-if engine to get effective probability
              // This handles: case node variant weights, conditional overrides, and what-if analysis
              const edgeId = edge.uuid || edge.id || `${edge.from}->${edge.to}`;
              const effectiveProb = computeEffectiveEdgeProbability(
                graph,
                edgeId,
              { whatIfDSL: effectiveWhatIfDSL },
                undefined
              );
              
              console.log(`[Sankey] Edge ${edgeId}: sourceMass=${sourceMass.toFixed(3)}, effectiveProb=${effectiveProb.toFixed(3)}, contribution=${(sourceMass * effectiveProb).toFixed(3)}`);
              
              totalMass += sourceMass * effectiveProb;
            });
            
            flowMass.set(nodeId, totalMass);
            processed.add(nodeId);
            madeProgress = true;
            console.log(`[Sankey] Calculated node ${node.label}: incoming mass = ${totalMass.toFixed(3)}`);
          }
        });
        
        if (!madeProgress) {
          console.warn('[Sankey] No progress made in iteration', iterations, 'processed:', processed.size);
          break;
        }
      }
      
      console.log('[Sankey] Flow mass calculated (after propagation):', Array.from(flowMass.entries()));
      console.log(`[Sankey] Propagation completed in ${iterations} iterations`);
      
      // Find max mass to normalize heights
      const maxMass = Math.max(...Array.from(flowMass.values()), 0.001); // Avoid division by zero
      console.log('[Sankey] Max mass:', maxMass);
      
      // Apply heights to nodes
      console.log('[Sankey] ReactFlow nodes to size:', nodesWithSelection.map(n => ({ id: n.id, label: n.data?.label })));
      nodesWithSelection = nodesWithSelection.map(node => {
        const mass = flowMass.get(node.id) || 0;
        const normalizedMass = mass / maxMass;
        const height = Math.max(MIN_NODE_HEIGHT, Math.min(MAX_NODE_HEIGHT, normalizedMass * MAX_NODE_HEIGHT));
        
        console.log(`[Sankey] Node ${node.data?.label} (reactflow id: ${node.id}): mass=${mass.toFixed(3)}, normalized=${normalizedMass.toFixed(3)}, height=${height.toFixed(0)}`);
        
        return {
          ...node,
          style: {
            ...node.style,
            width: NODE_WIDTH,
            height: height
          },
          data: {
            ...node.data,
            sankeyHeight: height, // Pass height to node component
            sankeyWidth: NODE_WIDTH,
            useSankeyView: true // Flag for node to know it's in Sankey mode
          }
        };
      });
    }
    
    // Add edge width calculation to each edge
    const edgesWithWidth = newEdges.map(edge => {
      const isSelected = selectedEdgeIds.has(edge.id);
      return {
      ...edge,
        selected: isSelected,
        reconnectable: true, // Always true; CSS hides handles for unselected, callback rejects unselected
      data: {
        ...edge.data
        // Don't add calculateWidth here - will be added after offsets are calculated
      }
      };
    });
    
    // Add calculateWidth functions with updated edge data
    const edgesWithWidthFunctions = edgesWithWidth.map(edge => ({
      ...edge,
      data: {
        ...edge.data
      }
    }));
    
  // Calculate edge offsets for Sankey-style visualization
  // In Sankey view, use a much larger max width (edges can be as wide as tall nodes)
  const effectiveMaxWidth = useSankeyView 
    ? 384 // Allow edges to be up to 384px wide (MAX_NODE_HEIGHT 400 - 16px margin)
    : MAX_WIDTH;
  const edgesWithOffsets = calculateEdgeOffsets(edgesWithWidthFunctions, nodesWithSelection, effectiveMaxWidth);
  
  // Attach offsets to edge data for the ConversionEdge component
  const edgesWithOffsetData = edgesWithOffsets.map(edge => ({
    ...edge,
    data: {
      ...edge.data,
      sourceOffsetX: edge.sourceOffsetX,
      sourceOffsetY: edge.sourceOffsetY,
      targetOffsetX: edge.targetOffsetX,
      targetOffsetY: edge.targetOffsetY,
      scaledWidth: edge.scaledWidth,
      // Bundle metadata
      sourceBundleWidth: edge.sourceBundleWidth,
      targetBundleWidth: edge.targetBundleWidth,
      sourceBundleSize: edge.sourceBundleSize,
      targetBundleSize: edge.targetBundleSize,
      isFirstInSourceBundle: edge.isFirstInSourceBundle,
      isLastInSourceBundle: edge.isLastInSourceBundle,
      isFirstInTargetBundle: edge.isFirstInTargetBundle,
      isLastInTargetBundle: edge.isLastInTargetBundle,
      sourceFace: edge.sourceFace,
      targetFace: edge.targetFace,
      // Pass what-if DSL to edges
      whatIfDSL: effectiveWhatIfDSL,
      // Pass Sankey view flag to edges
      useSankeyView: useSankeyView
      // ATOMIC RESTORATION: Do NOT pass decoration visibility through edge.data
      // Beads will read beadsVisible from React Context instead
    }
  }));
  
  // Compute edge anchors (start edges under the node boundary for cleaner appearance)
  const edgesWithAnchors = edgesWithOffsetData.map(edge => {
    const computeAnchor = (
      nodeId: string,
      face: string | undefined,
      offsetX: number | undefined,
      offsetY: number | undefined
    ) => {
      const n: any = nodesWithSelection.find((nn: any) => nn.id === nodeId);
      const w = n?.width ?? DEFAULT_NODE_WIDTH;
      const h = n?.height ?? DEFAULT_NODE_HEIGHT;
      const x = n?.position?.x ?? 0;
      const y = n?.position?.y ?? 0;

      // No inset - anchors at the actual edge (ReactFlow handles are there)
      if (face === 'right') {
        return { x: x + w, y: y + h / 2 + (offsetY ?? 0) };
      }
      if (face === 'left') {
        return { x: x, y: y + h / 2 + (offsetY ?? 0) };
      }
      if (face === 'bottom') {
        return { x: x + w / 2 + (offsetX ?? 0), y: y + h };
      }
      // top/default
      return { x: x + w / 2 + (offsetX ?? 0), y: y };
    };
    const srcAnchor = computeAnchor(edge.source, edge.data.sourceFace, edge.sourceOffsetX, edge.sourceOffsetY);
    const tgtAnchor = computeAnchor(edge.target, edge.data.targetFace, edge.targetOffsetX, edge.targetOffsetY);
    
    return {
      ...edge,
      data: {
        ...edge.data,
        sourceAnchorX: srcAnchor.x,
        sourceAnchorY: srcAnchor.y,
        targetAnchorX: tgtAnchor.x,
        targetAnchorY: tgtAnchor.y,
      }
    };
  });
    
    setNodes(nodesWithSelection);
    // Sort edges so selected edges render last (on top)
    const sortedEdges = [...edgesWithAnchors].sort((a, b) => {
      if (a.selected && !b.selected) return 1;  // selected edge goes after unselected
      if (!a.selected && b.selected) return -1; // unselected edge goes before selected
      return 0; // preserve order otherwise
    });
    
    // Add scenario overlay edges (only if scenarios visible)
    // Filter out any existing overlay edges first to avoid duplicates
    const baseEdges = sortedEdges.filter(e => !e.id.startsWith('scenario-overlay-'));
    
    const scenarioState = tabId ? tabs.find(t => t.id === tabId)?.editorState?.scenarioState : undefined;
    const visibleScenarioIds = scenarioState?.visibleScenarioIds || [];
    const visibleColorOrderIds = scenarioState?.visibleColorOrderIds || [];
    
    let edgesWithScenarios = baseEdges;
    
    // TODO: Scenario rendering disabled for now - causes infinite loop
    // Need to refactor to not trigger re-render on every frame
    /*
    if (scenariosContext && visibleScenarioIds.length > 0 && graph) {
      const scenarios = scenariosContext.scenarios;
      const baseParams = scenariosContext.baseParams;
      const colorMap = assignColors(visibleScenarioIds, visibleColorOrderIds);
      
      const overlayEdges: any[] = [];
      
      // For each visible scenario, create overlay edges
      for (const scenarioId of visibleScenarioIds) {
        const scenario = scenarios.find(s => s.id === scenarioId);
        if (!scenario) continue;
        
        const color = colorMap.get(scenarioId) || scenario.color;
        
        // Compose params up to this scenario
        const layersUpToThis = visibleScenarioIds
          .slice(0, visibleScenarioIds.indexOf(scenarioId) + 1)
          .map(id => scenarios.find(s => s.id === id))
          .filter((s): s is any => s !== undefined);
        const overlays = layersUpToThis.map(s => s.params);
        const composedParams = composeParams(baseParams, overlays);
        
        // Create overlay edge for each base edge (not graph edge)
        baseEdges.forEach(edge => {
          const graphEdge = graph.edges.find(ge => ge.id === edge.id || ge.uuid === edge.data?.uuid);
          if (!graphEdge) return;
          
          // Use edge.id first (human-readable), fall back to uuid
          const edgeKey = graphEdge.id || graphEdge.uuid;
          const edgeParams = composedParams.edges?.[edgeKey];
          if (!edgeParams) return;
          
          overlayEdges.push({
            ...edge,
            id: `scenario-overlay-${scenarioId}-${edge.id}`,
            selectable: false,
            data: {
              ...edge.data,
              scenarioOverlay: true,
              scenarioColor: color,
              scenarioParams: edgeParams,
            },
            style: {
              stroke: color,
              strokeOpacity: 0.3,
              pointerEvents: 'none',
            },
            zIndex: -1,
          });
        });
      }
      
      edgesWithScenarios = [...baseEdges, ...overlayEdges];
    }
    */
    
    setEdges(edgesWithScenarios);
    
    // Reset syncing flag after graph->ReactFlow sync is complete
