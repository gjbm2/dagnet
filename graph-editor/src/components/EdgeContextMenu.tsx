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

import React, { useState, useRef, useEffect } from 'react';
import { ParameterEditor } from './ParameterEditor';
import { DataOperationsMenu } from './DataOperationsMenu';
import { ChevronRight, Copy } from 'lucide-react';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { useViewPreferencesContext } from '../contexts/ViewPreferencesContext';
import { getConditionalProbabilityUnbalancedMap } from '../utils/rebalanceUtils';
import { getAllDataSections, type DataOperationSection } from './DataOperationsSections';
import { DataSectionSubmenu } from './DataSectionSubmenu';
import { copyVarsToClipboard } from '../services/copyVarsService';
import toast from 'react-hot-toast';

interface EdgeContextMenuProps {
  x: number;
  y: number;
  edgeId: string;
  edgeData: any;
  edges: any[]; // ReactFlow edges to check for selection
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
  edges,
  graph,
  onClose,
  onUpdateGraph,
  onDeleteEdge,
}) => {
  const [localData, setLocalData] = useState(edgeData);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const submenuTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const { window } = useGraphStore();
  const viewPrefs = useViewPreferencesContext();

  // Calculate constrained position on mount
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const menuWidth = rect.width;
      const menuHeight = rect.height;
      
      let left = x;
      let top = y;
      
      // Constrain horizontally
      const viewportWidth = globalThis.innerWidth;
      if (left + menuWidth > viewportWidth - 20) {
        left = Math.max(20, viewportWidth - menuWidth - 20);
      }
      if (left < 20) {
        left = 20;
      }
      
      // Constrain vertically
      const viewportHeight = globalThis.innerHeight;
      if (top + menuHeight > viewportHeight - 20) {
        // Try to show above the cursor position
        const aboveY = y - menuHeight - 4;
        if (aboveY > 20) {
          top = aboveY;
        } else {
          top = Math.max(20, viewportHeight - menuHeight - 20);
        }
      }
      if (top < 20) {
        top = 20;
      }
      
      setPosition({ left, top });
    }
  }, [x, y]);
  
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
  
  // Get selected edges (including the current edge)
  const selectedEdges = edges.filter(e => e.selected || e.id === edgeId);
  const selectedEdgeUuids = selectedEdges.map(e => e.id); // ReactFlow IDs are UUIDs
  const isMultiSelect = selectedEdgeUuids.length > 1;
  
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
  // Check for file-based connections via nested ids (p.id, cost_gbp.id, cost_time.id) OR direct connections (connection field)
  // Check if conditional_p exists (for showing editing UI)
  const hasConditionalP = edge?.conditional_p && edge.conditional_p.length > 0;
  
  // Get all data operation sections using single source of truth
  const dataOperationSections = getAllDataSections(null, edgeId, graph);
  
  // Generic section-based handlers for data operations
  const handleSectionGetFromFile = (section: DataOperationSection) => {
    // Delegate to dataOperationsService
    import('../services/dataOperationsService').then(({ dataOperationsService }) => {
      dataOperationsService.getParameterFromFile({
        paramId: section.objectId,
        edgeId: section.targetId,
        graph,
        setGraph,
      });
    });
  };

  const handleSectionPutToFile = (section: DataOperationSection) => {
    import('../services/dataOperationsService').then(({ dataOperationsService }) => {
      dataOperationsService.putParameterToFile({
        paramId: section.objectId,
        edgeId: section.targetId,
        graph,
        setGraph,
      });
    });
  };

  const handleSectionGetFromSourceDirect = (section: DataOperationSection) => {
    import('../services/dataOperationsService').then(({ dataOperationsService }) => {
      dataOperationsService.getFromSourceDirect({
        objectType: 'parameter',
        objectId: section.objectId,
        targetId: section.targetId,
        graph,
        setGraph,
        paramSlot: section.paramSlot,
        conditionalIndex: section.conditionalIndex,
        dailyMode: false,
        currentDSL: graph?.currentQueryDSL || '',
      });
    });
  };

  const handleSectionGetFromSource = (section: DataOperationSection) => {
    import('../services/dataOperationsService').then(({ dataOperationsService }) => {
      dataOperationsService.getFromSource({
        objectType: 'parameter',
        objectId: section.objectId,
        targetId: section.targetId,
        graph,
        setGraph,
        paramSlot: section.paramSlot,
        conditionalIndex: section.conditionalIndex,
      });
    });
  };
  
  const handleSectionClearCache = (section: DataOperationSection) => {
    if (section.objectType === 'event') {
      // Events don't have cache clearing support
      return;
    }
    import('../services/dataOperationsService').then(({ dataOperationsService }) => {
      dataOperationsService.clearCache(section.objectType as 'parameter' | 'case' | 'node', section.objectId);
    });
    onClose();
  };
  
  const handleCopyVars = async () => {
    const result = await copyVarsToClipboard(graph, [], selectedEdgeUuids);
    
    if (result.success) {
      toast.success(
        `Copied ${result.count} variable${result.count !== 1 ? 's' : ''} ` +
        `from ${result.edgeCount} edge${result.edgeCount !== 1 ? 's' : ''} to clipboard`
      );
    } else {
      toast.error(result.error || 'Failed to copy variables');
    }
    
    onClose();
  };
  
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
    const result = updateManager.rebalanceVariantWeights(graph, nodeId, variantIndex, true);
    await graphMutationService.updateGraph(oldGraph, result.graph, (updatedGraph) => {
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
      ref={menuRef}
      style={{
        position: 'fixed',
        left: position.left,
        top: position.top,
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

      {/* Data operations (using single source of truth) */}
      {dataOperationSections.length > 0 && (
        <>
          <div style={{ height: '1px', background: '#eee', margin: '8px 0' }} />
          
          {/* Render all data operation sections */}
          {dataOperationSections.map(section => (
            <DataSectionSubmenu
              key={section.id}
              section={section}
              isOpen={openSubmenu === section.id}
              onMouseEnter={() => handleSubmenuEnter(section.id)}
              onMouseLeave={handleSubmenuLeave}
              onSubmenuContentEnter={handleSubmenuContentEnter}
              onSubmenuContentLeave={handleSubmenuContentLeave}
              onGetFromFile={handleSectionGetFromFile}
              onPutToFile={handleSectionPutToFile}
              onGetFromSource={handleSectionGetFromSource}
              onGetFromSourceDirect={handleSectionGetFromSourceDirect}
              onClearCache={handleSectionClearCache}
            />
          ))}
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
              zIndex: 99999
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

      {/* Copy vars */}
      <div
        onClick={(e) => {
          e.stopPropagation();
          handleCopyVars();
        }}
        style={{
          padding: '8px 12px',
          cursor: 'pointer',
          fontSize: '13px',
          borderRadius: '2px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
      >
        <Copy size={14} />
        <span>Copy vars{isMultiSelect ? ` (${selectedEdges.length} edges)` : ''}</span>
      </div>

      <div style={{ height: '1px', background: '#eee', margin: '4px 0' }} />

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
