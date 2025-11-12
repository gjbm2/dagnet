/**
 * Edge Context Menu Component
 * 
 * Context menu for graph edges with:
 * - Probability editing (with slider & balance button)
 * - Conditional probabilities editing
 * - Variant weight editing (for case edges)
 * - Data operations (Get/Put) for parameters with submenus
 * - Properties & Delete options
 */

import React, { useState, useRef } from 'react';
import { ParameterEditor } from './ParameterEditor';
import { DataOperationsMenu } from './DataOperationsMenu';
import { ChevronRight } from 'lucide-react';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { useViewPreferencesContext } from '../contexts/ViewPreferencesContext';
import { getConditionalProbabilityUnbalancedMap } from '../utils/rebalanceUtils';

interface EdgeContextMenuProps {
  x: number;
  y: number;
  edgeId: string;
  edgeData: any;
  graph: any;
  onClose: () => void;
  onUpdateGraph: (graph: any, historyLabel?: string, nodeId?: string) => void;
  onDeleteEdge: (edgeId: string) => void;
}

export const EdgeContextMenu: React.FC<EdgeContextMenuProps> = ({
  x,
  y,
  edgeId,
  edgeData,
  graph,
  onClose,
  onUpdateGraph,
  onDeleteEdge,
}) => {
  const [localData, setLocalData] = useState(edgeData);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const submenuTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { window } = useGraphStore();
  const viewPrefs = useViewPreferencesContext();
  
  // Helper to handle submenu open/close with delay to prevent closing when hovering over disabled items
  const handleSubmenuEnter = (submenuName: string) => {
    if (submenuTimeoutRef.current) {
      clearTimeout(submenuTimeoutRef.current);
      submenuTimeoutRef.current = null;
    }
    setOpenSubmenu(submenuName);
  };
  
  const handleSubmenuLeave = () => {
    // Add a small delay before closing to allow movement to submenu
    submenuTimeoutRef.current = setTimeout(() => {
      setOpenSubmenu(null);
      submenuTimeoutRef.current = null;
    }, 150);
  };
  
  const handleSubmenuContentEnter = () => {
    // Cancel close timeout when entering submenu content
    if (submenuTimeoutRef.current) {
      clearTimeout(submenuTimeoutRef.current);
      submenuTimeoutRef.current = null;
    }
  };
  
  const handleSubmenuContentLeave = () => {
    // Close immediately when leaving submenu content
    setOpenSubmenu(null);
    if (submenuTimeoutRef.current) {
      clearTimeout(submenuTimeoutRef.current);
      submenuTimeoutRef.current = null;
    }
  };
  
  // Create a setGraph wrapper that calls onUpdateGraph (which updates the tab-specific graph)
  const setGraph = (updatedGraph: any) => {
    onUpdateGraph(updatedGraph);
  };
  
  const handleConfidenceIntervalChange = (level: 'none' | '80' | '90' | '95' | '99') => {
    if (viewPrefs) {
      viewPrefs.setConfidenceIntervalLevel(level);
    }
  };
  
  // Find the edge in the graph - recalculate when graph changes to ensure rebalance button updates
  const edge = React.useMemo(() => {
    return graph?.edges?.find((e: any) => e.uuid === edgeId || e.id === edgeId);
  }, [graph, edgeId]);
  
  // Sync localData when edge changes (e.g., after rebalance)
  React.useEffect(() => {
    if (edge) {
      setLocalData(edge);
    }
  }, [edge]);
  
  // Memoize conditional probability unbalanced map to react to graph changes
  const conditionalUnbalancedMap = React.useMemo(() => {
    if (!graph || !edge || !edge.conditional_p) {
      return new Map<number, boolean>();
    }
    return getConditionalProbabilityUnbalancedMap(graph, edge, []);
  }, [graph, edge]);
  
  // Check for connected parameters from the actual edge object
  // Check for file-based connections (parameter_id OR p.id) OR direct connections (connection field)
  // Note: parameter_id can be top-level OR nested in p.id (transform.ts maps p.id → parameter_id for ReactFlow)
  const parameterId = edge?.parameter_id || edge?.p?.id; // Prefer top-level, fallback to nested
  const hasProbabilityParam = !!parameterId || !!edge?.p?.connection;
  // Check if conditional_p exists (for showing editing UI)
  const hasConditionalP = edge?.conditional_p && edge.conditional_p.length > 0;
  // Check if ANY conditional_p has a parameter_id or connection (for showing parameter submenu)
  const hasConditionalParam = edge?.conditional_p?.some((cp: any) => 
    cp.p?.parameter_id || cp.p?.id || cp.p?.connection
  ) || false;
  // Get the first conditional parameter ID (for file operations)
  const firstConditionalParamId = edge?.conditional_p?.find((cp: any) => 
    cp.p?.parameter_id || cp.p?.id
  )?.p?.parameter_id || edge?.conditional_p?.find((cp: any) => 
    cp.p?.parameter_id || cp.p?.id
  )?.p?.id;
  const costGbpParameterId = edge?.cost_gbp_parameter_id || edge?.cost_gbp?.id;
  const hasCostGbpParam = !!costGbpParameterId || !!edge?.cost_gbp?.connection;
  const costTimeParameterId = edge?.cost_time_parameter_id || edge?.cost_time?.id;
  const hasCostTimeParam = !!costTimeParameterId || !!edge?.cost_time?.connection;
  const hasAnyParam = hasProbabilityParam || hasConditionalParam || hasCostGbpParam || hasCostTimeParam;
  
  // Check if it's a case edge with variants
  // Case edges can have case_variant set, and we infer case_id from the source node if missing
  const sourceNode = graph?.nodes?.find((n: any) => n.uuid === edge?.from || n.id === edge?.from);
  const isCaseNode = sourceNode?.type === 'case';
  const inferredCaseId = edge?.case_id || (isCaseNode ? (sourceNode?.case?.id || sourceNode?.uuid || sourceNode?.id) : null);
  const isCaseEdge = edge?.case_variant && inferredCaseId;
  const caseNode = graph?.nodes?.find((n: any) => 
    n.type === 'case' && (
      n.case?.id === inferredCaseId || 
      n.uuid === inferredCaseId || 
      n.id === inferredCaseId ||
      (isCaseNode && (n.uuid === sourceNode?.uuid || n.id === sourceNode?.id))
    )
  );
  const variant = caseNode?.case?.variants?.find((v: any) => v.name === edge?.case_variant);
  const variantIndex = caseNode?.case?.variants?.findIndex((v: any) => v.name === edge?.case_variant) ?? -1;
  const allVariants = caseNode?.case?.variants || [];
  
  // Calculate if probabilities are unbalanced (for balance button highlighting)
  // For case edges, only consider edges with the same case_variant and case_id
  // Infer case_id from source node if missing (for backward compatibility)
  const edgeCaseId = edge?.case_id || (edge?.case_variant && sourceNode?.type === 'case' ? 
    (sourceNode.case?.id || sourceNode.uuid || sourceNode.id) : null);
  
  const probabilitySiblings = graph?.edges?.filter((e: any) => {
    if (!edge) return false;
    if (edge.case_variant) {
      // For case edges, must match both case_variant and case_id
      const eSourceNode = graph?.nodes?.find((n: any) => n.uuid === e.from || n.id === e.from);
      const eCaseId = e.case_id || (e.case_variant && eSourceNode?.type === 'case' ? 
        (eSourceNode.case?.id || eSourceNode.uuid || eSourceNode.id) : null);
      
      return e.from === edge.from && 
             e.case_variant === edge.case_variant &&
             eCaseId === edgeCaseId;
    }
    // For regular edges, exclude case edges
    return e.from === edge.from && !e.case_variant;
  }) || [];
  const totalProbability = probabilitySiblings.reduce((sum, e) => sum + (e.p?.mean || 0), 0);
  const isProbabilityUnbalanced = Math.abs(totalProbability - 1.0) > 0.01; // More than 1% off
  
  // Calculate if variant weights are unbalanced
  const totalVariantWeight = allVariants.reduce((sum: number, v: any) => sum + (v.weight || 0), 0);
  const isVariantWeightUnbalanced = Math.abs(totalVariantWeight - 1.0) > 0.01;

  // Handlers for regular probability
  const handleProbabilityCommit = React.useCallback((value: number, skipHistory: boolean = false) => {
    if (!graph) return;
    const nextGraph = structuredClone(graph);
    const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeId || e.id === edgeId);
    if (edgeIndex >= 0) {
      nextGraph.edges[edgeIndex].p = {
        ...nextGraph.edges[edgeIndex].p,
        mean: value,
        mean_overridden: true
      };
      if (nextGraph.metadata) {
        nextGraph.metadata.updated_at = new Date().toISOString();
      }
      // Only save history if not skipping (for slider dragging)
      const historyLabel = skipHistory ? undefined : 'Update edge probability';
      onUpdateGraph(nextGraph, historyLabel, edgeId);
    }
  }, [graph, edgeId, onUpdateGraph]);
  
  // Separate handler for onChange (no history) vs onCommit (with history)
  const handleProbabilityChange = React.useCallback((value: number) => {
    handleProbabilityCommit(value, true); // Skip history for onChange
  }, [handleProbabilityCommit]);

  const handleProbabilityRebalance = React.useCallback(async () => {
    if (!graph || !edge) return;
    const { updateManager } = await import('../services/UpdateManager');
    const { graphMutationService } = await import('../services/graphMutationService');
    const oldGraph = graph;
    const nextGraph = updateManager.rebalanceEdgeProbabilities(graph, edgeId, true);
    await graphMutationService.updateGraph(oldGraph, nextGraph, (updatedGraph) => {
      onUpdateGraph(updatedGraph, 'Auto-rebalance probabilities', edgeId);
    });
  }, [graph, edge, edgeId, onUpdateGraph]);

  const handleProbabilityClearOverride = React.useCallback(() => {
    if (!graph) return;
    const nextGraph = structuredClone(graph);
    const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeId || e.id === edgeId);
    if (edgeIndex >= 0 && nextGraph.edges[edgeIndex].p) {
      delete nextGraph.edges[edgeIndex].p.mean_overridden;
      if (nextGraph.metadata) {
        nextGraph.metadata.updated_at = new Date().toISOString();
      }
      onUpdateGraph(nextGraph, 'Clear probability override', edgeId);
    }
  }, [graph, edgeId, onUpdateGraph]);

  // Handlers for conditional probabilities
  const handleConditionalCommit = React.useCallback((cpIndex: number, value: number, skipHistory: boolean = false) => {
    if (!graph) return;
    const nextGraph = structuredClone(graph);
    const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeId || e.id === edgeId);
    if (edgeIndex >= 0 && nextGraph.edges[edgeIndex].conditional_p) {
      if (!nextGraph.edges[edgeIndex].conditional_p[cpIndex].p) {
        nextGraph.edges[edgeIndex].conditional_p[cpIndex].p = {};
      }
      nextGraph.edges[edgeIndex].conditional_p[cpIndex].p.mean = value;
      nextGraph.edges[edgeIndex].conditional_p[cpIndex].p.mean_overridden = true;
      if (nextGraph.metadata) {
        nextGraph.metadata.updated_at = new Date().toISOString();
      }
      // Only save history if not skipping (for slider dragging)
      const historyLabel = skipHistory ? undefined : undefined; // No label for conditional p updates
      onUpdateGraph(nextGraph, historyLabel, edgeId);
    }
  }, [graph, edgeId, onUpdateGraph]);
  
  // Separate handler for onChange (no history) vs onCommit (with history)
  const handleConditionalChange = React.useCallback((cpIndex: number, value: number) => {
    handleConditionalCommit(cpIndex, value, true); // Skip history for onChange
  }, [handleConditionalCommit]);

  const handleConditionalRebalance = React.useCallback(async (cpIndex: number) => {
    if (!graph || !edge || !edge.conditional_p) return;
    const { updateManager } = await import('../services/UpdateManager');
    const { graphMutationService } = await import('../services/graphMutationService');
    const oldGraph = graph;
    const nextGraph = updateManager.rebalanceConditionalProbabilities(graph, edgeId, cpIndex, true);
    await graphMutationService.updateGraph(oldGraph, nextGraph, (updatedGraph) => {
      onUpdateGraph(updatedGraph, 'Auto-rebalance conditional probabilities', edgeId);
    });
  }, [graph, edge, edgeId, onUpdateGraph]);

  const handleConditionalClearOverride = React.useCallback((cpIndex: number) => {
    if (!graph) return;
    const nextGraph = structuredClone(graph);
    const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeId || e.id === edgeId);
    if (edgeIndex >= 0 && nextGraph.edges[edgeIndex].conditional_p && nextGraph.edges[edgeIndex].conditional_p[cpIndex]?.p) {
      delete nextGraph.edges[edgeIndex].conditional_p[cpIndex].p.mean_overridden;
      if (nextGraph.metadata) {
        nextGraph.metadata.updated_at = new Date().toISOString();
      }
      onUpdateGraph(nextGraph, 'Clear conditional probability override', edgeId);
    }
  }, [graph, edgeId, onUpdateGraph]);

  // Handlers for variant weights
  const handleVariantCommit = React.useCallback((value: number) => {
    if (!graph || !edge || !caseNode) return;
    const nextGraph = structuredClone(graph);
    const nodeIndex = nextGraph.nodes.findIndex((n: any) => 
      n.type === 'case' && (
        n.case?.id === inferredCaseId || 
        n.uuid === inferredCaseId || 
        n.id === inferredCaseId ||
        (n.uuid === caseNode?.uuid || n.id === caseNode?.id)
      )
    );
    if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
      const vIdx = nextGraph.nodes[nodeIndex].case.variants.findIndex((v: any) => v.name === edge?.case_variant);
      if (vIdx >= 0) {
        nextGraph.nodes[nodeIndex].case.variants[vIdx].weight = value;
        nextGraph.nodes[nodeIndex].case.variants[vIdx].weight_overridden = true;
        if (nextGraph.metadata) {
          nextGraph.metadata.updated_at = new Date().toISOString();
        }
        onUpdateGraph(nextGraph, 'Update variant weight', caseNode?.id || caseNode?.uuid);
      }
    }
  }, [graph, edge, caseNode, inferredCaseId, onUpdateGraph]);

  // Separate handler for onChange (no history) vs onCommit (with history)
  const handleVariantChange = React.useCallback((value: number) => {
    if (!graph || !edge || !caseNode) return;
    const nextGraph = structuredClone(graph);
    const nodeIndex = nextGraph.nodes.findIndex((n: any) => 
      n.type === 'case' && (
        n.case?.id === inferredCaseId || 
        n.uuid === inferredCaseId || 
        n.id === inferredCaseId ||
        (n.uuid === caseNode?.uuid || n.id === caseNode?.id)
      )
    );
    if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
      const vIdx = nextGraph.nodes[nodeIndex].case.variants.findIndex((v: any) => v.name === edge?.case_variant);
      if (vIdx >= 0) {
        nextGraph.nodes[nodeIndex].case.variants[vIdx].weight = value;
        nextGraph.nodes[nodeIndex].case.variants[vIdx].weight_overridden = true;
        if (nextGraph.metadata) {
          nextGraph.metadata.updated_at = new Date().toISOString();
        }
        // Skip history for onChange (slider dragging)
        onUpdateGraph(nextGraph, undefined, caseNode?.id || caseNode?.uuid);
      }
    }
  }, [graph, edge, caseNode, inferredCaseId, onUpdateGraph]);

  const handleVariantRebalance = React.useCallback(async () => {
    if (!graph || !edge || !caseNode) return;
    const { updateManager } = await import('../services/UpdateManager');
    const { graphMutationService } = await import('../services/graphMutationService');
    const oldGraph = graph;
    const nodeId = caseNode.uuid || caseNode.id;
    if (!nodeId) return;
    const nextGraph = updateManager.rebalanceVariantWeights(graph, nodeId, variantIndex, true);
    await graphMutationService.updateGraph(oldGraph, nextGraph, (updatedGraph) => {
      onUpdateGraph(updatedGraph, 'Update and balance variant weights', caseNode?.id || caseNode?.uuid);
    });
  }, [graph, edge, caseNode, variantIndex, onUpdateGraph]);

  const handleVariantClearOverride = React.useCallback(() => {
    if (!graph || !edge || !caseNode) return;
    const nextGraph = structuredClone(graph);
    const nodeIndex = nextGraph.nodes.findIndex((n: any) => 
      n.type === 'case' && (
        n.case?.id === inferredCaseId || 
        n.uuid === inferredCaseId || 
        n.id === inferredCaseId ||
        (n.uuid === caseNode?.uuid || n.id === caseNode?.id)
      )
    );
    if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
      const vIdx = nextGraph.nodes[nodeIndex].case.variants.findIndex((v: any) => v.name === edge?.case_variant);
      if (vIdx >= 0) {
        delete nextGraph.nodes[nodeIndex].case.variants[vIdx].weight_overridden;
        if (nextGraph.metadata) {
          nextGraph.metadata.updated_at = new Date().toISOString();
        }
        onUpdateGraph(nextGraph, 'Clear variant weight override', caseNode?.id || caseNode?.uuid);
      }
    }
  }, [graph, edge, caseNode, inferredCaseId, onUpdateGraph]);

  return (
    <div
      style={{
        position: 'fixed',
        left: x,
        top: y,
        background: 'white',
        border: '1px solid #ddd',
        borderRadius: '4px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        minWidth: '200px',
        padding: '8px',
        zIndex: 10000
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Probability editing section */}
      <div style={{ marginBottom: '12px' }}>
        <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', marginBottom: '4px', color: '#333' }}>
          Probability
        </label>
        <ParameterEditor
          paramType="probability"
          value={edge?.p?.mean || 0}
          overridden={edge?.p?.mean_overridden || false}
            isUnbalanced={isProbabilityUnbalanced}
          graph={graph}
          objectId={edgeId}
          paramSlot="p"
          onChange={handleProbabilityChange}
          onCommit={handleProbabilityCommit}
          onRebalance={handleProbabilityRebalance}
          onClearOverride={handleProbabilityClearOverride}
          onClose={onClose}
          />
      </div>

      {/* Conditional Probabilities editing */}
      {hasConditionalP && (
        <div style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', marginBottom: '4px', color: '#333' }}>
            Conditional Probabilities
          </label>
          {edge.conditional_p.map((condP: any, cpIndex: number) => {
            // Skip old format conditions
            if (typeof condP.condition !== 'string') {
              console.warn(`[EdgeContextMenu] Skipping conditional_p with old format at index ${cpIndex}:`, condP);
              return null;
            }
            
            return (
              <ParameterEditor
                key={cpIndex}
                paramType="conditional_p"
                value={condP.p?.mean || 0}
                overridden={condP.p?.mean_overridden || false}
                isUnbalanced={conditionalUnbalancedMap.get(cpIndex) || false}
                graph={graph}
                objectId={edgeId}
                paramSlot="p"
                conditionalIndex={cpIndex}
                conditionDisplay={condP.condition}
                onChange={(value) => handleConditionalChange(cpIndex, value)}
                onCommit={(value) => handleConditionalCommit(cpIndex, value)}
                onRebalance={() => handleConditionalRebalance(cpIndex)}
                onClearOverride={() => handleConditionalClearOverride(cpIndex)}
                onClose={onClose}
              />
            );
          })}
        </div>
      )}

      {/* Variant Weight editing for case edges */}
      {isCaseEdge && variant && variantIndex >= 0 && (
        <div style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', marginBottom: '4px', color: '#333' }}>
            Variant Weight ({edge?.case_variant})
          </label>
          <ParameterEditor
            paramType="variant_weight"
            value={variant.weight || 0}
            overridden={variant.weight_overridden || false}
            isUnbalanced={isVariantWeightUnbalanced}
            graph={graph}
            objectId={caseNode?.uuid || caseNode?.id || ''}
            variantIndex={variantIndex}
            allVariants={allVariants}
            label={`Variant Weight (${edge?.case_variant})`}
            onChange={handleVariantChange}
            onCommit={handleVariantCommit}
            onRebalance={handleVariantRebalance}
            onClearOverride={handleVariantClearOverride}
            onClose={onClose}
          />
        </div>
      )}

      {/* Data operations (if any parameters connected) */}
      {hasAnyParam && (
        <>
          <div style={{ height: '1px', background: '#eee', margin: '8px 0' }} />
          
          {/* Probability parameter submenu */}
          {hasProbabilityParam && (
            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => handleSubmenuEnter('probability')}
              onMouseLeave={handleSubmenuLeave}
            >
              <div
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  borderRadius: '2px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: openSubmenu === 'probability' ? '#f8f9fa' : 'white'
                }}
              >
                <span>Probability parameter</span>
                <ChevronRight size={14} style={{ color: '#666' }} />
              </div>
              
              {openSubmenu === 'probability' && (
                <div
                  style={{
                    position: 'absolute',
                    left: '100%',
                    top: 0,
                    marginLeft: '4px',
                    zIndex: 10001
                  }}
                  onMouseEnter={handleSubmenuContentEnter}
                  onMouseLeave={handleSubmenuContentLeave}
                >
                  <DataOperationsMenu
                    objectType="parameter"
                    objectId={parameterId || ''}
                    hasFile={!!parameterId}
                    targetId={edgeId}
                    graph={graph}
                    setGraph={setGraph}
                    paramSlot="p"
                    window={window}
                    mode="submenu"
                    showConnectionSettings={false}
                    showSyncStatus={true}
                    onClose={() => setOpenSubmenu(null)}
                  />
                </div>
              )}
            </div>
          )}

          {/* Conditional probability parameter submenu (if has conditionals) */}
          {hasConditionalParam && (
            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => handleSubmenuEnter('conditional')}
              onMouseLeave={handleSubmenuLeave}
            >
              <div
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  borderRadius: '2px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: openSubmenu === 'conditional' ? '#f8f9fa' : 'white'
                }}
              >
                <span>Conditional prob. parameter</span>
                <ChevronRight size={14} style={{ color: '#666' }} />
              </div>
              
              {openSubmenu === 'conditional' && (
                <div
                  style={{
                    position: 'absolute',
                    left: '100%',
                    top: 0,
                    marginLeft: '4px',
                    zIndex: 10001
                  }}
                  onMouseEnter={handleSubmenuContentEnter}
                  onMouseLeave={handleSubmenuContentLeave}
                >
                  <DataOperationsMenu
                    objectType="parameter"
                    objectId={firstConditionalParamId || ''}
                    hasFile={!!firstConditionalParamId}
                    targetId={edgeId}
                    graph={graph}
                    setGraph={setGraph}
                    paramSlot="p"
                    conditionalIndex={0}
                    window={window}
                    mode="submenu"
                    showConnectionSettings={false}
                    showSyncStatus={true}
                    onClose={() => setOpenSubmenu(null)}
                  />
                </div>
              )}
            </div>
          )}

          {/* Cost GBP parameter submenu */}
          {hasCostGbpParam && (
            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => handleSubmenuEnter('cost_gbp')}
              onMouseLeave={handleSubmenuLeave}
            >
              <div
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  borderRadius: '2px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: openSubmenu === 'cost_gbp' ? '#f8f9fa' : 'white'
                }}
              >
                <span>Cost (£) parameter</span>
                <ChevronRight size={14} style={{ color: '#666' }} />
              </div>
              
              {openSubmenu === 'cost_gbp' && (
                <div
                  style={{
                    position: 'absolute',
                    left: '100%',
                    top: 0,
                    marginLeft: '4px',
                    zIndex: 10001
                  }}
                  onMouseEnter={handleSubmenuContentEnter}
                  onMouseLeave={handleSubmenuContentLeave}
                >
                  <DataOperationsMenu
                    objectType="parameter"
                    objectId={costGbpParameterId || ''}
                    hasFile={!!costGbpParameterId}
                    targetId={edgeId}
                    graph={graph}
                    setGraph={setGraph}
                    paramSlot="cost_gbp"
                    window={window}
                    mode="submenu"
                    showConnectionSettings={false}
                    showSyncStatus={true}
                    onClose={() => setOpenSubmenu(null)}
                  />
                </div>
              )}
            </div>
          )}

          {/* Cost Time parameter submenu */}
          {hasCostTimeParam && (
            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => handleSubmenuEnter('cost_time')}
              onMouseLeave={handleSubmenuLeave}
            >
              <div
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  borderRadius: '2px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: openSubmenu === 'cost_time' ? '#f8f9fa' : 'white'
                }}
              >
                <span>Duration parameter</span>
                <ChevronRight size={14} style={{ color: '#666' }} />
              </div>
              
              {openSubmenu === 'cost_time' && (
                <div
                  style={{
                    position: 'absolute',
                    left: '100%',
                    top: 0,
                    marginLeft: '4px',
                    zIndex: 10001
                  }}
                  onMouseEnter={handleSubmenuContentEnter}
                  onMouseLeave={handleSubmenuContentLeave}
                >
                  <DataOperationsMenu
                    objectType="parameter"
                    objectId={costTimeParameterId || ''}
                    hasFile={!!costTimeParameterId}
                    targetId={edgeId}
                    graph={graph}
                    setGraph={setGraph}
                    paramSlot="cost_time"
                    window={window}
                    mode="submenu"
                    showConnectionSettings={false}
                    showSyncStatus={true}
                    onClose={() => setOpenSubmenu(null)}
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div style={{ height: '1px', background: '#eee', margin: '8px 0' }} />

      {/* Confidence Intervals */}
      <div
        style={{ position: 'relative' }}
        onMouseEnter={() => handleSubmenuEnter('confidence')}
        onMouseLeave={handleSubmenuLeave}
      >
        <div
          style={{
            padding: '8px 12px',
            cursor: 'pointer',
            fontSize: '13px',
            borderRadius: '2px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: openSubmenu === 'confidence' ? '#f8f9fa' : 'white'
          }}
        >
          <span>Confidence Intervals</span>
          <ChevronRight size={14} style={{ color: '#666' }} />
        </div>
        
        {openSubmenu === 'confidence' && (
          <div
            style={{
              position: 'absolute',
              left: '100%',
              top: 0,
              marginLeft: '4px',
              background: 'white',
              border: '1px solid #ddd',
              borderRadius: '4px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              minWidth: '120px',
              zIndex: 10001
            }}
            onMouseEnter={handleSubmenuContentEnter}
            onMouseLeave={handleSubmenuContentLeave}
          >
            <div
              onClick={() => {
                handleConfidenceIntervalChange('99');
                setOpenSubmenu(null);
              }}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                background: viewPrefs?.confidenceIntervalLevel === '99' ? '#f0f0f0' : 'white'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={(e) => (e.currentTarget.style.background = viewPrefs?.confidenceIntervalLevel === '99' ? '#f0f0f0' : 'white')}
            >
              {viewPrefs?.confidenceIntervalLevel === '99' ? '✓ ' : ''}99%
            </div>
            <div
              onClick={() => {
                handleConfidenceIntervalChange('95');
                setOpenSubmenu(null);
              }}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                background: viewPrefs?.confidenceIntervalLevel === '95' ? '#f0f0f0' : 'white'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={(e) => (e.currentTarget.style.background = viewPrefs?.confidenceIntervalLevel === '95' ? '#f0f0f0' : 'white')}
            >
              {viewPrefs?.confidenceIntervalLevel === '95' ? '✓ ' : ''}95%
            </div>
            <div
              onClick={() => {
                handleConfidenceIntervalChange('90');
                setOpenSubmenu(null);
              }}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                background: viewPrefs?.confidenceIntervalLevel === '90' ? '#f0f0f0' : 'white'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={(e) => (e.currentTarget.style.background = viewPrefs?.confidenceIntervalLevel === '90' ? '#f0f0f0' : 'white')}
            >
              {viewPrefs?.confidenceIntervalLevel === '90' ? '✓ ' : ''}90%
            </div>
            <div
              onClick={() => {
                handleConfidenceIntervalChange('80');
                setOpenSubmenu(null);
              }}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                background: viewPrefs?.confidenceIntervalLevel === '80' ? '#f0f0f0' : 'white'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={(e) => (e.currentTarget.style.background = viewPrefs?.confidenceIntervalLevel === '80' ? '#f0f0f0' : 'white')}
            >
              {viewPrefs?.confidenceIntervalLevel === '80' ? '✓ ' : ''}80%
            </div>
            <div
              onClick={() => {
                handleConfidenceIntervalChange('none');
                setOpenSubmenu(null);
              }}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                background: viewPrefs?.confidenceIntervalLevel === 'none' ? '#f0f0f0' : 'white'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={(e) => (e.currentTarget.style.background = viewPrefs?.confidenceIntervalLevel === 'none' ? '#f0f0f0' : 'white')}
            >
              {viewPrefs?.confidenceIntervalLevel === 'none' ? '✓ ' : ''}None
            </div>
          </div>
        )}
      </div>

      <div style={{ height: '1px', background: '#eee', margin: '8px 0' }} />

      {/* Properties */}
      <div
        onClick={() => {
          globalThis.window.dispatchEvent(new CustomEvent('dagnet:openPropertiesPanel'));
          onClose();
        }}
        style={{
          padding: '8px 12px',
          cursor: 'pointer',
          fontSize: '13px',
          borderRadius: '2px',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
      >
        Properties
      </div>

      {/* Delete */}
      <div
        onClick={() => {
          onDeleteEdge(edgeId);
          onClose();
        }}
        style={{
          padding: '8px 12px',
          cursor: 'pointer',
          fontSize: '13px',
          color: '#dc3545',
          borderRadius: '2px'
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
      >
        Delete edge
      </div>
    </div>
  );
};
