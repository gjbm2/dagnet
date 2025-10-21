import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node,
  ReactFlowProvider,
  NodeTypes,
  EdgeTypes,
  useReactFlow,
  Panel,
} from 'reactflow';
import 'reactflow/dist/style.css';

import ConversionNode from './nodes/ConversionNode';
import ConversionEdge from './edges/ConversionEdge';
import { useGraphStore } from '@/lib/useGraphStore';
import { toFlow, fromFlow } from '@/lib/transform';
import { generateSlugFromLabel, generateUniqueSlug } from '@/lib/slugUtils';
import { computeEffectiveEdgeProbability } from '@/lib/whatIf';

const nodeTypes: NodeTypes = {
  conversion: ConversionNode,
};

const edgeTypes: EdgeTypes = {
  conversion: ConversionEdge,
};

interface GraphCanvasProps {
  onSelectedNodeChange: (id: string | null) => void;
  onSelectedEdgeChange: (id: string | null) => void;
  onDoubleClickNode?: (id: string, field: string) => void;
  onDoubleClickEdge?: (id: string, field: string) => void;
  onSelectEdge?: (id: string) => void;
  edgeScalingMode: 'uniform' | 'local-mass' | 'global-mass' | 'global-log-mass';
  autoReroute: boolean;
}

export default function GraphCanvas({ onSelectedNodeChange, onSelectedEdgeChange, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, edgeScalingMode, autoReroute }: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner 
        onSelectedNodeChange={onSelectedNodeChange}
        onSelectedEdgeChange={onSelectedEdgeChange}
        onDoubleClickNode={onDoubleClickNode}
        onDoubleClickEdge={onDoubleClickEdge}
        onSelectEdge={onSelectEdge}
        edgeScalingMode={edgeScalingMode}
        autoReroute={autoReroute}
      />
    </ReactFlowProvider>
  );
}

function CanvasInner({ onSelectedNodeChange, onSelectedEdgeChange, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, edgeScalingMode, autoReroute }: GraphCanvasProps) {
  const { graph, setGraph, whatIfAnalysis } = useGraphStore();
  // Recompute edge widths when conditional what-if overrides change
  const overridesVersion = useGraphStore(state => state.whatIfOverrides._version);
  const { deleteElements, fitView, screenToFlowPosition, setCenter } = useReactFlow();
  
  // ReactFlow maintains local state for smooth interactions
  const [nodes, setNodes, onNodesChangeBase] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  
  // Trigger flag for re-routing
  const [shouldReroute, setShouldReroute] = useState(0);
  
  // Custom onNodesChange handler to detect position changes for auto re-routing
  const onNodesChange = useCallback((changes: any[]) => {
    console.log('onNodesChange called:', { 
      changeCount: changes.length, 
      autoReroute, 
      changeTypes: changes.map(c => ({ type: c.type, dragging: c.dragging }))
    });
    
    // Call the base handler first
    onNodesChangeBase(changes);
    
    // Check if any position changes occurred (when user finishes dragging)
    if (autoReroute) {
      const positionChanges = changes.filter(change => change.type === 'position' && change.dragging === false);
      console.log('Filtered position changes:', positionChanges.length);
      if (positionChanges.length > 0) {
        console.log('Position changes detected (dragging finished):', positionChanges);
        console.log('Setting shouldReroute flag');
        // Trigger re-routing by incrementing the flag
        setShouldReroute(prev => {
          console.log('shouldReroute incrementing from', prev, 'to', prev + 1);
          return prev + 1;
        });
      }
    }
  }, [onNodesChangeBase, autoReroute]);

  // Log transformation function for Global Log Mass scaling
  const logMassTransform = useCallback((probability: number, maxWidth: number): number => {
    if (probability <= 0) return 0;
    if (probability >= 1) return maxWidth;
    
    // Use log base 10 with scaling to preserve visual mass
    // Formula: width = maxWidth * (1 - log10(1/probability) / log10(1/minProb))
    // Where minProb is the minimum probability we want to show (e.g., 0.01)
    
    const minProb = 0.01; // Minimum probability to show
    const logBase = 10;
    
    // Clamp probability to avoid log(0)
    const clampedProb = Math.max(probability, minProb);
    
    // Calculate the log transformation
    const logRatio = Math.log10(1 / clampedProb) / Math.log10(1 / minProb);
    const width = maxWidth * (1 - logRatio);
    
    return Math.max(0, Math.min(maxWidth, width));
  }, []);

  // Edge width calculation based on scaling mode
  const MAX_WIDTH = 104; // Node height (120px) minus 2x corner radius (8px each = 16px)
  const MIN_WIDTH = 2;
  
  const calculateEdgeWidth = useCallback((edge: any, allEdges: any[], allNodes: any[]) => {
    console.log(`calculateEdgeWidth called for edge ${edge.id}, mode=${edgeScalingMode}`);

    // Get current what-if state (avoid stale closures)
    const currentOverrides = useGraphStore.getState().whatIfOverrides;

    // UNIFIED helper: get effective probability using shared logic
    const getEffectiveProbability = (e: any): number => {
      return computeEffectiveEdgeProbability(graph, e.id, currentOverrides, whatIfAnalysis);
    };
    
    if (edgeScalingMode === 'uniform') {
      return edge.selected ? 3 : 2;
    }
    
    if (edgeScalingMode === 'local-mass') {
      // Find all edges from the same source node
      const sourceEdges = allEdges.filter(e => e.source === edge.source);
      const totalProbability = sourceEdges.reduce((sum, e) => sum + getEffectiveProbability(e), 0);
      
      if (totalProbability === 0) return MIN_WIDTH;
      
      const edgeProbability = getEffectiveProbability(edge);
      const proportion = edgeProbability / totalProbability;
      // Use a more dramatic scaling for better visibility
      const scaledWidth = MIN_WIDTH + (proportion * (MAX_WIDTH - MIN_WIDTH));
      const finalWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, scaledWidth));
      
      console.log(`Local mass edge ${edge.id}: prob=${edgeProbability}, total=${totalProbability}, proportion=${proportion.toFixed(2)}, width=${finalWidth.toFixed(1)} (MAX_WIDTH=${MAX_WIDTH})`);
      return finalWidth;
    }
    
    if (edgeScalingMode === 'global-mass') {
      // Global mass: scale based on residual probability as graph is traversed from start
      // Find the start node (node with entry.is_start = true or entry.entry_weight > 0)
      const startNode = allNodes.find(n => 
        n.data?.entry?.is_start === true || (n.data?.entry?.entry_weight || 0) > 0
      );
      
      console.log(`Global mass mode: startNode=`, startNode);
      
      if (!startNode) {
        console.log(`No start node found, falling back to local mass for edge ${edge.id}`);
        // Fallback to local mass if no clear start node
        const sourceEdges = allEdges.filter(e => e.source === edge.source);
        const totalProbability = sourceEdges.reduce((sum, e) => sum + getEffectiveProbability(e), 0);
        if (totalProbability === 0) return MIN_WIDTH;
        const edgeProbability = getEffectiveProbability(edge);
        const proportion = edgeProbability / totalProbability;
        const scaledWidth = MIN_WIDTH + (proportion * (MAX_WIDTH - MIN_WIDTH));
        return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, scaledWidth));
      }
      
      // Calculate residual probability at the source node
      const residualAtSource = calculateResidualProbability(edge.source, allEdges, startNode.id);
      
      if (residualAtSource === 0) return MIN_WIDTH;
      
      // Sankey-style: actual mass flowing through this edge = p(source) × edge_probability
      const edgeProbability = getEffectiveProbability(edge);
      const actualMassFlowing = residualAtSource * edgeProbability;
      
      // Width scales directly with actual mass flowing through
      const scaledWidth = MIN_WIDTH + (actualMassFlowing * (MAX_WIDTH - MIN_WIDTH));
      const finalWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, scaledWidth));
      
      console.log(`Global mass edge ${edge.id}: p(source)=${residualAtSource.toFixed(2)}, edgeProb=${edgeProbability.toFixed(2)}, actualMass=${actualMassFlowing.toFixed(2)}, width=${finalWidth.toFixed(1)} (MAX_WIDTH=${MAX_WIDTH})`);
      return finalWidth;
    }
    
    if (edgeScalingMode === 'global-log-mass') {
      // Global Log Mass: same as global-mass but with logarithmic transformation
      // Find the start node (node with entry.is_start = true or entry.entry_weight > 0)
      const startNode = allNodes.find(n => 
        n.data?.entry?.is_start === true || (n.data?.entry?.entry_weight || 0) > 0
      );
      
      console.log(`Global log mass mode: startNode=`, startNode);
      
      if (!startNode) {
        console.log(`No start node found, falling back to local mass for edge ${edge.id}`);
        // Fallback to local mass if no clear start node
        const sourceEdges = allEdges.filter(e => e.source === edge.source);
        const totalProbability = sourceEdges.reduce((sum, e) => sum + getEffectiveProbability(e), 0);
        if (totalProbability === 0) return MIN_WIDTH;
        const edgeProbability = getEffectiveProbability(edge);
        const proportion = edgeProbability / totalProbability;
        const scaledWidth = MIN_WIDTH + (proportion * (MAX_WIDTH - MIN_WIDTH));
        return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, scaledWidth));
      }
      
      // Calculate residual probability at the source node
      const residualAtSource = calculateResidualProbability(edge.source, allEdges, startNode.id);
      
      if (residualAtSource === 0) return MIN_WIDTH;
      
      // Sankey-style: actual mass flowing through this edge = p(source) × edge_probability
      const edgeProbability = getEffectiveProbability(edge);
      const actualMassFlowing = residualAtSource * edgeProbability;
      
      // Apply logarithmic transformation to preserve visual mass for lower probabilities
      const logTransformedWidth = logMassTransform(actualMassFlowing, MAX_WIDTH - MIN_WIDTH);
      const finalWidth = MIN_WIDTH + logTransformedWidth;
      
      console.log(`Global log mass edge ${edge.id}: p(source)=${residualAtSource.toFixed(2)}, edgeProb=${edgeProbability.toFixed(2)}, actualMass=${actualMassFlowing.toFixed(2)}, logWidth=${logTransformedWidth.toFixed(1)}, finalWidth=${finalWidth.toFixed(1)} (MAX_WIDTH=${MAX_WIDTH})`);
      return finalWidth;
    }
    
    // Helper function to calculate residual probability with normalization (mass conservation)
    function calculateResidualProbability(targetNode: string, allEdges: any[], startNode: string): number {
      // Build adjacency lists
      const outgoing: { [key: string]: any[] } = {};
      const incoming: { [key: string]: any[] } = {};
      allEdges.forEach(e => {
        if (!outgoing[e.source]) outgoing[e.source] = [];
        if (!incoming[e.target]) incoming[e.target] = [];
        outgoing[e.source].push(e);
        incoming[e.target].push(e);
      });

      const residualAtNode: { [key: string]: number } = {};
      const visiting = new Set<string>();

      function dfs(nodeId: string): number {
        if (residualAtNode[nodeId] !== undefined) return residualAtNode[nodeId];
        if (visiting.has(nodeId)) return 0; // prevent cycles
        visiting.add(nodeId);

        if (nodeId === startNode) {
          residualAtNode[nodeId] = 1.0;
          visiting.delete(nodeId);
          return 1.0;
        }

        let sumIncoming = 0;
        const inEdges = incoming[nodeId] || [];
        for (const inEdge of inEdges) {
          const predId = inEdge.source;
          const massAtPred = dfs(predId);
          if (massAtPred <= 0) continue;
          const outEdges = outgoing[predId] || [];
          const denom = outEdges.reduce((acc, oe) => acc + (getEffectiveProbability(oe) || 0), 0);
          const edgeProb = getEffectiveProbability(inEdge) || 0;
          if (denom > 0 && edgeProb > 0) {
            sumIncoming += massAtPred * (edgeProb / denom);
          }
        }

        residualAtNode[nodeId] = sumIncoming;
        visiting.delete(nodeId);
        return sumIncoming;
      }

      return dfs(targetNode);
    }
    
    return edge.selected ? 3 : 2;
  }, [edgeScalingMode, logMassTransform, whatIfAnalysis, graph, overridesVersion]);

  // Calculate edge offsets for Sankey-style visualization
  const calculateEdgeOffsets = useCallback((edgesWithWidth: any[], allNodes: any[], maxWidth: number) => {
    
    // Group edges by source node (for source offsets)
    const edgesBySource: { [sourceId: string]: any[] } = {};
    edgesWithWidth.forEach(edge => {
      if (!edgesBySource[edge.source]) {
        edgesBySource[edge.source] = [];
      }
      edgesBySource[edge.source].push(edge);
    });

    // Group edges by target node (for target offsets)
    const edgesByTarget: { [targetId: string]: any[] } = {};
    edgesWithWidth.forEach(edge => {
      if (!edgesByTarget[edge.target]) {
        edgesByTarget[edge.target] = [];
      }
      edgesByTarget[edge.target].push(edge);
    });

    // Calculate offsets for each edge (both source and target)
    const edgesWithOffsets = edgesWithWidth.map(edge => {
      // Only apply offsets for mass-based scaling modes
      if (!['local-mass', 'global-mass', 'global-log-mass'].includes(edgeScalingMode)) {
        return { 
          ...edge, 
          sourceOffsetX: 0, 
          sourceOffsetY: 0,
          targetOffsetX: 0,
          targetOffsetY: 0
        };
      }

      const sourceEdges = edgesBySource[edge.source] || [];
      const targetEdges = edgesByTarget[edge.target] || [];

      // Find the source and target nodes to determine edge direction
      const sourceNode = allNodes.find(n => n.id === edge.source);
      const targetNode = allNodes.find(n => n.id === edge.target);
      
      if (!sourceNode || !targetNode) {
        return { 
          ...edge, 
          sourceOffsetX: 0, 
          sourceOffsetY: 0,
          targetOffsetX: 0,
          targetOffsetY: 0
        };
      }

      // Get the actual connection handles from the edge data
      // These tell us which face of each node the edge connects to
      const sourceHandle = edge.sourceHandle || 'right-out';
      const targetHandle = edge.targetHandle || 'left';
      
      // Extract face from handle (e.g., 'right-out' → 'right', 'left' → 'left')
      const sourceFace = sourceHandle.split('-')[0]; // 'right', 'left', 'top', 'bottom'
      const targetFace = targetHandle.split('-')[0]; // 'right', 'left', 'top', 'bottom'

      // ===== Calculate SOURCE offsets =====
      // Filter to only edges exiting from the SAME FACE of this source node
      const sameFaceSourceEdges = sourceEdges.filter(e => {
        const eSourceHandle = e.sourceHandle || 'right-out';
        const eSourceFace = eSourceHandle.split('-')[0];
        return eSourceFace === sourceFace;
      });

      // Sort edges from this face by visual position of their targets
      const sortedSourceEdges = [...sameFaceSourceEdges].sort((a, b) => {
        const aTarget = allNodes.find(n => n.id === a.target);
        const bTarget = allNodes.find(n => n.id === b.target);
        if (!aTarget || !bTarget) return 0;
        
        // For left/right faces: sort by Y (top to bottom)
        // For top/bottom faces: sort by X (left to right)
        if (sourceFace === 'left' || sourceFace === 'right') {
          return (aTarget.position?.y || 0) - (bTarget.position?.y || 0);
        } else {
          return (aTarget.position?.x || 0) - (bTarget.position?.x || 0);
        }
      });

      // Calculate total visual width of all edges on this face
      const sourceTotalWidth = sortedSourceEdges.reduce((sum, e) => {
        const width = e.data?.calculateWidth ? e.data.calculateWidth() : 2;
        return sum + width;
      }, 0);

      let sourceOffsetX = 0;
      let sourceOffsetY = 0;

      if (sourceTotalWidth > 0) {
        // For Global Log Mass: scale down if total width exceeds maxWidth
        let scaleFactor = 1.0;
        if (edgeScalingMode === 'global-log-mass' && sourceTotalWidth > maxWidth) {
          scaleFactor = maxWidth / sourceTotalWidth;
        }

        const sourceEdgeIndex = sortedSourceEdges.findIndex(e => e.id === edge.id);
        if (sourceEdgeIndex !== -1) {
          const sourceCumulativeWidth = sortedSourceEdges.slice(0, sourceEdgeIndex).reduce((sum, e) => {
            const width = e.data?.calculateWidth ? e.data.calculateWidth() : 2;
            return sum + width;
          }, 0);

          const edgeWidth = edge.data?.calculateWidth ? edge.data.calculateWidth() : 2;
          
          // Apply scaling to cumulative width and edge width
          const scaledCumulativeWidth = sourceCumulativeWidth * scaleFactor;
          const scaledEdgeWidth = edgeWidth * scaleFactor;
          const scaledTotalWidth = sourceTotalWidth * scaleFactor;
          
          const sourceCenterInStack = scaledCumulativeWidth + (scaledEdgeWidth / 2);
          const sourceStackCenter = scaledTotalWidth / 2;
          const sourceOffsetFromCenter = sourceCenterInStack - sourceStackCenter;

          // Apply offset to the correct axis based on face
          if (sourceFace === 'left' || sourceFace === 'right') {
            // Left/right faces: offset vertically (Y)
            sourceOffsetY = sourceOffsetFromCenter;
          } else {
            // Top/bottom faces: offset horizontally (X)
            sourceOffsetX = sourceOffsetFromCenter;
          }
        }
      }

      // ===== Calculate TARGET offsets =====
      // Filter to only edges entering from the SAME FACE of this target node
      const sameFaceTargetEdges = targetEdges.filter(e => {
        const eTargetHandle = e.targetHandle || 'left';
        const eTargetFace = eTargetHandle.split('-')[0];
        return eTargetFace === targetFace;
      });

      // Sort edges to this target face by visual position of their sources
      const sortedTargetEdges = [...sameFaceTargetEdges].sort((a, b) => {
        const aSource = allNodes.find(n => n.id === a.source);
        const bSource = allNodes.find(n => n.id === b.source);
        if (!aSource || !bSource) return 0;
        
        // For left/right faces: sort by source Y (top to bottom)
        // For top/bottom faces: sort by source X (left to right)
        if (targetFace === 'left' || targetFace === 'right') {
          return (aSource.position?.y || 0) - (bSource.position?.y || 0);
        } else {
          return (aSource.position?.x || 0) - (bSource.position?.x || 0);
        }
      });

      // Calculate total visual width of all edges on this target face
      const targetTotalWidth = sortedTargetEdges.reduce((sum, e) => {
        const width = e.data?.calculateWidth ? e.data.calculateWidth() : 2;
        return sum + width;
      }, 0);

      let targetOffsetX = 0;
      let targetOffsetY = 0;

      if (targetTotalWidth > 0) {
        // For Global Log Mass: scale down if total width exceeds maxWidth
        let scaleFactor = 1.0;
        if (edgeScalingMode === 'global-log-mass' && targetTotalWidth > maxWidth) {
          scaleFactor = maxWidth / targetTotalWidth;
        }

        const targetEdgeIndex = sortedTargetEdges.findIndex(e => e.id === edge.id);
        if (targetEdgeIndex !== -1) {
          const targetCumulativeWidth = sortedTargetEdges.slice(0, targetEdgeIndex).reduce((sum, e) => {
            const width = e.data?.calculateWidth ? e.data.calculateWidth() : 2;
            return sum + width;
          }, 0);

          const edgeWidth = edge.data?.calculateWidth ? edge.data.calculateWidth() : 2;
          
          // Apply scaling to cumulative width and edge width
          const scaledCumulativeWidth = targetCumulativeWidth * scaleFactor;
          const scaledEdgeWidth = edgeWidth * scaleFactor;
          const scaledTotalWidth = targetTotalWidth * scaleFactor;
          
          const targetCenterInStack = scaledCumulativeWidth + (scaledEdgeWidth / 2);
          const targetStackCenter = scaledTotalWidth / 2;
          const targetOffsetFromCenter = targetCenterInStack - targetStackCenter;

          // Apply offset to the correct axis based on face
          if (targetFace === 'left' || targetFace === 'right') {
            // Left/right faces: offset vertically (Y)
            targetOffsetY = targetOffsetFromCenter;
          } else {
            // Top/bottom faces: offset horizontally (X)
            targetOffsetX = targetOffsetFromCenter;
          }
        }
      }

      // Debug logging for offset calculation
      if (Math.abs(sourceOffsetX) > 0.1 || Math.abs(sourceOffsetY) > 0.1 || Math.abs(targetOffsetX) > 0.1 || Math.abs(targetOffsetY) > 0.1) {
        const edgeWidth = edge.data?.calculateWidth ? edge.data.calculateWidth() : 2;
        const sourceScaleFactor = (edgeScalingMode === 'global-log-mass' && sourceTotalWidth > maxWidth) ? maxWidth / sourceTotalWidth : 1.0;
        const targetScaleFactor = (edgeScalingMode === 'global-log-mass' && targetTotalWidth > maxWidth) ? maxWidth / targetTotalWidth : 1.0;
        
        const finalScaleFactor = Math.min(sourceScaleFactor, targetScaleFactor);
        const scaledWidth = edgeWidth * finalScaleFactor;
        
        console.log(`Edge ${edge.id} (${edge.source} → ${edge.target}):`);
        console.log(`  Original Width: ${edgeWidth.toFixed(1)} → Scaled Width: ${scaledWidth.toFixed(1)} (scale=${finalScaleFactor.toFixed(2)})`);
        console.log(`  Source: face=${sourceFace}, ${sameFaceSourceEdges.length}/${sourceEdges.length} edges, totalWidth=${sourceTotalWidth.toFixed(1)}, scale=${sourceScaleFactor.toFixed(2)}, offset=(${sourceOffsetX.toFixed(1)}, ${sourceOffsetY.toFixed(1)})`);
        console.log(`  Target: face=${targetFace}, ${sameFaceTargetEdges.length}/${targetEdges.length} edges, totalWidth=${targetTotalWidth.toFixed(1)}, scale=${targetScaleFactor.toFixed(2)}, offset=(${targetOffsetX.toFixed(1)}, ${targetOffsetY.toFixed(1)})`);
      }

      // Apply scaling to the edge width for Global Log Mass
      let scaledWidth = edge.data?.calculateWidth ? edge.data.calculateWidth() : 2;
      if (edgeScalingMode === 'global-log-mass') {
        // Use the more restrictive scaling factor (smaller of source/target)
        const sourceScaleFactor = sourceTotalWidth > maxWidth ? maxWidth / sourceTotalWidth : 1.0;
        const targetScaleFactor = targetTotalWidth > maxWidth ? maxWidth / targetTotalWidth : 1.0;
        const finalScaleFactor = Math.min(sourceScaleFactor, targetScaleFactor);
        scaledWidth = scaledWidth * finalScaleFactor;
      }

      return { 
        ...edge, 
        sourceOffsetX: sourceOffsetX,
        sourceOffsetY: sourceOffsetY,
        targetOffsetX: targetOffsetX,
        targetOffsetY: targetOffsetY,
        scaledWidth: scaledWidth
      };
    });

    return edgesWithOffsets;
  }, [edgeScalingMode, graph, whatIfAnalysis, overridesVersion]);

  // Track the last synced graph to detect real changes
  const lastSyncedGraphRef = useRef<string>('');
  const lastSyncedReactFlowRef = useRef<string>('');
  const isSyncingRef = useRef(false);
  
  // Re-route feature state
  const lastNodePositionsRef = useRef<{ [nodeId: string]: { x: number; y: number } }>({});
  
  // Calculate optimal handles between two nodes
  const calculateOptimalHandles = useCallback((sourceNode: any, targetNode: any) => {
    const sourceX = sourceNode.position.x;
    const sourceY = sourceNode.position.y;
    const targetX = targetNode.position.x;
    const targetY = targetNode.position.y;
    
    // Node dimensions (from layout.ts: width: 120, height: 120)
    const nodeWidth = 120;
    const nodeHeight = 120;
    
    // Calculate relative positions
    const deltaX = targetX - sourceX;
    const deltaY = targetY - sourceY;
    
    // Determine optimal source handle based on direction
    let sourceHandle: string;
    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      // Horizontal movement dominates
      sourceHandle = deltaX > 0 ? 'right-out' : 'left-out';
    } else {
      // Vertical movement dominates
      sourceHandle = deltaY > 0 ? 'bottom-out' : 'top-out';
    }
    
    // Determine optimal target handle based on direction
    let targetHandle: string;
    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      // Horizontal movement dominates
      targetHandle = deltaX > 0 ? 'left' : 'right';
    } else {
      // Vertical movement dominates
      targetHandle = deltaY > 0 ? 'top' : 'bottom';
    }
    
    return { sourceHandle, targetHandle };
  }, []);
  
  // Perform immediate re-route of ALL edges (used when toggling on)
  const performImmediateReroute = useCallback(() => {
    if (!graph) {
      console.log('No graph, skipping immediate re-route');
      return;
    }
    
    console.log('Performing immediate re-route of ALL edges');
    
    const nextGraph = structuredClone(graph);
    let updatedCount = 0;
    
    // Re-route ALL edges
    nextGraph.edges.forEach((graphEdge: any) => {
      const sourceNode = nodes.find(n => n.id === graphEdge.from);
      const targetNode = nodes.find(n => n.id === graphEdge.to);
      
      if (sourceNode && targetNode) {
        const { sourceHandle, targetHandle } = calculateOptimalHandles(sourceNode, targetNode);
        
        console.log(`Re-routing edge ${graphEdge.id}:`, {
          from: graphEdge.from,
          to: graphEdge.to,
          oldFromHandle: graphEdge.fromHandle,
          newFromHandle: sourceHandle,
          oldToHandle: graphEdge.toHandle,
          newToHandle: targetHandle
        });
        
        graphEdge.fromHandle = sourceHandle;
        graphEdge.toHandle = targetHandle;
        updatedCount++;
      }
    });
    
    console.log(`Updated ${updatedCount} edges`);
    
    if (updatedCount > 0) {
      if (nextGraph.metadata) {
        nextGraph.metadata.updated_at = new Date().toISOString();
      }
      
      console.log('Updating graph with immediate re-route changes');
      setGraph(nextGraph);
    }
  }, [graph, nodes, calculateOptimalHandles, setGraph]);
  
  // Auto re-route edges when nodes move
  const performAutoReroute = useCallback(() => {
    if (!autoReroute || !graph) {
      console.log('Auto re-route skipped:', { autoReroute, hasGraph: !!graph });
      return;
    }
    
    const currentPositions: { [nodeId: string]: { x: number; y: number } } = {};
    const movedNodes: string[] = [];
    
    // Check which nodes have moved
    nodes.forEach(node => {
      const currentPos = { x: node.position.x, y: node.position.y };
      const lastPos = lastNodePositionsRef.current[node.id];
      
      currentPositions[node.id] = currentPos;
      
      if (lastPos && (Math.abs(currentPos.x - lastPos.x) > 5 || Math.abs(currentPos.y - lastPos.y) > 5)) {
        movedNodes.push(node.id);
        console.log(`Node ${node.id} moved:`, { 
          from: lastPos, 
          to: currentPos, 
          deltaX: currentPos.x - lastPos.x, 
          deltaY: currentPos.y - lastPos.y 
        });
      }
    });
    
    if (movedNodes.length === 0) {
      console.log('No nodes moved, skipping re-route');
      return;
    }
    
    console.log('Moved nodes:', movedNodes);
    
    // Update last positions
    lastNodePositionsRef.current = currentPositions;
    
    // Find edges that need re-routing
    const edgesToReroute = edges.filter(edge => 
      movedNodes.includes(edge.source) || movedNodes.includes(edge.target)
    );
    
    console.log('Edges to re-route:', edgesToReroute.map(e => e.id));
    
    if (edgesToReroute.length === 0) return;
    
    // Update graph with new handle positions
    const nextGraph = structuredClone(graph);
    
    edgesToReroute.forEach(edge => {
      const sourceNode = nodes.find(n => n.id === edge.source);
      const targetNode = nodes.find(n => n.id === edge.target);
      
      if (sourceNode && targetNode) {
        const { sourceHandle, targetHandle } = calculateOptimalHandles(sourceNode, targetNode);
        
        console.log(`Re-routing edge ${edge.id}:`, { 
          oldFromHandle: edge.sourceHandle, 
          newFromHandle: sourceHandle,
          oldToHandle: edge.targetHandle,
          newToHandle: targetHandle
        });
        
        // Find the edge in the graph and update its handles
        const graphEdge = nextGraph.edges.find(e => e.id === edge.id);
        if (graphEdge) {
          graphEdge.fromHandle = sourceHandle;
          graphEdge.toHandle = targetHandle;
        }
      }
    });
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    console.log('Updating graph with new handle positions');
    setGraph(nextGraph);
  }, [autoReroute, graph, nodes, edges, calculateOptimalHandles, setGraph]);
  
  // Reset position tracking and perform immediate re-route when autoReroute is toggled ON
  useEffect(() => {
    console.log('Auto re-route toggled:', autoReroute);
    if (autoReroute) {
      // Initialize position tracking when enabling
      console.log('Initializing position tracking and performing immediate re-route');
      const initialPositions: { [nodeId: string]: { x: number; y: number } } = {};
      nodes.forEach(node => {
        initialPositions[node.id] = { x: node.position.x, y: node.position.y };
      });
      lastNodePositionsRef.current = initialPositions;
      
      // Perform immediate re-route when toggling on (with a small delay to ensure state is ready)
      console.log('Triggering immediate re-route on toggle');
      if (graph && nodes.length > 0 && edges.length > 0) {
        // Use setTimeout to break out of the render cycle
        setTimeout(() => {
          performImmediateReroute();
        }, 50);
      }
    } else {
      // Clear position tracking when disabling
      lastNodePositionsRef.current = {};
    }
  }, [autoReroute]); // ONLY depend on autoReroute, not nodes/edges/graph!
  
  // Perform re-routing when shouldReroute flag changes (with small delay after node movement)
  useEffect(() => {
    if (shouldReroute > 0 && autoReroute) {
      console.log('Re-route triggered by flag change:', shouldReroute);
      // Add a small delay to ensure node positions are fully updated
      const timeoutId = setTimeout(() => {
        console.log('Executing delayed re-route after node movement');
        performAutoReroute();
      }, 100); // 100ms delay after user finishes dragging
      
      return () => clearTimeout(timeoutId);
    }
  }, [shouldReroute, autoReroute, performAutoReroute]);
  
  // Get all existing slugs (nodes and edges) for uniqueness checking
  const getAllExistingSlugs = useCallback((excludeId?: string) => {
    if (!graph) return [];
    
    const nodeSlugs = graph.nodes
      .filter((node: any) => node.id !== excludeId)
      .map((node: any) => node.slug)
      .filter(Boolean);
    
    const edgeSlugs = graph.edges
      .filter((edge: any) => edge.id !== excludeId)
      .map((edge: any) => edge.slug)
      .filter(Boolean);
    
    return [...nodeSlugs, ...edgeSlugs];
  }, [graph]);
  
  // Callback functions for node/edge updates
  const handleUpdateNode = useCallback((id: string, data: any) => {
    console.log('handleUpdateNode called:', { id, data });
    setGraph((prevGraph) => {
      if (!prevGraph) return prevGraph;
      
      // Check for slug uniqueness if slug is being updated
      if (data.slug) {
        const existingSlugs = getAllExistingSlugs(id);
        if (existingSlugs.includes(data.slug)) {
          alert(`Slug "${data.slug}" is already in use. Please choose a different slug.`);
          return prevGraph;
        }
      }
      
      const nextGraph = structuredClone(prevGraph);
      const nodeIndex = nextGraph.nodes.findIndex(n => n.id === id);
      if (nodeIndex >= 0) {
        nextGraph.nodes[nodeIndex] = { ...nextGraph.nodes[nodeIndex], ...data };
        nextGraph.metadata.updated_at = new Date().toISOString();
        console.log('Updated node in graph:', nextGraph.nodes[nodeIndex]);
      }
      return nextGraph;
    });
  }, [setGraph, getAllExistingSlugs]);

  const handleDeleteNode = useCallback((id: string) => {
    console.log('=== DELETING NODE ===', id);
    
    if (!graph) {
      console.log('No graph, aborting delete');
      return;
    }
    
    console.log('BEFORE DELETE:', {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      hasPolicies: !!graph.policies,
      hasMetadata: !!graph.metadata
    });
    
    const nextGraph = structuredClone(graph);
    nextGraph.nodes = nextGraph.nodes.filter(n => n.id !== id);
    nextGraph.edges = nextGraph.edges.filter(e => e.from !== id && e.to !== id);
    
    // Ensure metadata exists and update it
    if (!nextGraph.metadata) {
      nextGraph.metadata = {};
    }
    nextGraph.metadata.updated_at = new Date().toISOString();
    
    console.log('AFTER DELETE:', {
      nodes: nextGraph.nodes.length,
      edges: nextGraph.edges.length,
      hasPolicies: !!nextGraph.policies,
      hasMetadata: !!nextGraph.metadata
    });
    
    // Clear the sync flag to allow graph->ReactFlow sync
    isSyncingRef.current = false;
    
    // Update the graph (this will trigger the graph->ReactFlow sync which will update lastSyncedGraphRef)
    setGraph(nextGraph);
    
    // Clear selection when node is deleted
    onSelectedNodeChange(null);
  }, [graph, setGraph, onSelectedNodeChange]);

  const handleUpdateEdge = useCallback((id: string, data: any) => {
    setGraph((prevGraph) => {
      if (!prevGraph) return prevGraph;
      
      // Check for slug uniqueness if slug is being updated
      if (data.slug) {
        const existingSlugs = getAllExistingSlugs(id);
        if (existingSlugs.includes(data.slug)) {
          alert(`Slug "${data.slug}" is already in use. Please choose a different slug.`);
          return prevGraph;
        }
      }
      
      const nextGraph = structuredClone(prevGraph);
      const edgeIndex = nextGraph.edges.findIndex(e => e.id === id);
      if (edgeIndex >= 0) {
        nextGraph.edges[edgeIndex] = { ...nextGraph.edges[edgeIndex], ...data };
        nextGraph.metadata.updated_at = new Date().toISOString();
      }
      return nextGraph;
    });
  }, [setGraph, getAllExistingSlugs]);

  const handleDeleteEdge = useCallback((id: string) => {
    console.log('=== DELETING EDGE ===', id);
    
    if (!graph) {
      console.log('No graph, aborting delete');
      return;
    }
    
    const nextGraph = structuredClone(graph);
    nextGraph.edges = nextGraph.edges.filter(e => e.id !== id);
    
    // Ensure metadata exists and update it
    if (!nextGraph.metadata) {
      nextGraph.metadata = {};
    }
    nextGraph.metadata.updated_at = new Date().toISOString();
    
    // Clear the sync flag to allow graph->ReactFlow sync
    isSyncingRef.current = false;
    
    // Update the graph (this will trigger the graph->ReactFlow sync which will update lastSyncedGraphRef)
    setGraph(nextGraph);
    
    // Clear selection when edge is deleted
    onSelectedEdgeChange(null);
  }, [graph, setGraph, onSelectedEdgeChange]);

  // Delete selected elements
  const deleteSelected = useCallback(() => {
    const selectedNodes = nodes.filter(n => n.selected);
    const selectedEdges = edges.filter(e => e.selected);
    
    console.log('deleteSelected called with:', selectedNodes.length, 'nodes and', selectedEdges.length, 'edges');
    
    // Delete selected nodes (which will cascade delete their edges)
    selectedNodes.forEach(node => {
      console.log('Deleting node:', node.id);
      handleDeleteNode(node.id);
    });
    
    // Delete any remaining selected edges
    selectedEdges.forEach(edge => {
      console.log('Deleting edge:', edge.id);
      handleDeleteEdge(edge.id);
    });
  }, [nodes, edges, handleDeleteNode, handleDeleteEdge]);

  // Sync FROM graph TO ReactFlow when graph changes externally
  useEffect(() => {
    if (!graph) return;
    if (isSyncingRef.current) {
      console.log('Skipping graph->ReactFlow sync (isSyncingRef=true)');
      return;
    }
    
    const graphJson = JSON.stringify(graph);
    if (graphJson === lastSyncedGraphRef.current) {
      console.log('Skipping graph->ReactFlow sync (no changes)');
      return;
    }
    
    console.log('=== Syncing graph -> ReactFlow ===');
    lastSyncedGraphRef.current = graphJson;
    const { nodes: newNodes, edges: newEdges } = toFlow(graph, {
      onUpdateNode: handleUpdateNode,
      onDeleteNode: handleDeleteNode,
      onUpdateEdge: handleUpdateEdge,
      onDeleteEdge: handleDeleteEdge,
      onDoubleClickNode: onDoubleClickNode,
      onDoubleClickEdge: onDoubleClickEdge,
      onSelectEdge: onSelectEdge,
    });
    
    // Add edge width calculation to each edge
    const edgesWithWidth = newEdges.map(edge => ({
      ...edge,
      data: {
        ...edge.data,
        calculateWidth: () => calculateEdgeWidth(edge, newEdges, newNodes)
      }
    }));
    
  // Calculate edge offsets for Sankey-style visualization
  const edgesWithOffsets = calculateEdgeOffsets(edgesWithWidth, newNodes, MAX_WIDTH);
  
  // Attach offsets to edge data for the ConversionEdge component
  const edgesWithOffsetData = edgesWithOffsets.map(edge => ({
    ...edge,
    data: {
      ...edge.data,
      sourceOffsetX: edge.sourceOffsetX,
      sourceOffsetY: edge.sourceOffsetY,
      targetOffsetX: edge.targetOffsetX,
      targetOffsetY: edge.targetOffsetY,
      scaledWidth: edge.scaledWidth
    }
  }));
    
    setNodes(newNodes);
    setEdges(edgesWithOffsetData);
    
    // Fit view after graph loads
    setTimeout(() => {
      fitView();
    }, 150);
  }, [graph, setNodes, setEdges, handleUpdateNode, handleDeleteNode, handleUpdateEdge, handleDeleteEdge, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, calculateEdgeWidth, calculateEdgeOffsets, fitView]);

  // Update edge widths when scaling mode changes
  useEffect(() => {
    if (edges.length === 0) return;
    
    // Force re-render of edges by updating their data and recalculating offsets
    setEdges(prevEdges => {
      const edgesWithWidth = prevEdges.map(edge => ({
        ...edge,
        data: {
          ...edge.data,
          calculateWidth: () => calculateEdgeWidth(edge, prevEdges, nodes)
        }
      }));
      
      // Recalculate offsets for mass-based scaling modes
      const edgesWithOffsets = calculateEdgeOffsets(edgesWithWidth, nodes, MAX_WIDTH);
      
      // Attach offsets to edge data for the ConversionEdge component
      return edgesWithOffsets.map(edge => ({
        ...edge,
        data: {
          ...edge.data,
          sourceOffsetX: edge.sourceOffsetX,
          sourceOffsetY: edge.sourceOffsetY,
          targetOffsetX: edge.targetOffsetX,
          targetOffsetY: edge.targetOffsetY,
          scaledWidth: edge.scaledWidth
        }
      }));
    });
  }, [edgeScalingMode, calculateEdgeWidth, calculateEdgeOffsets, nodes, overridesVersion, whatIfAnalysis]);
  
  // Sync FROM ReactFlow TO graph when user makes changes in the canvas
  // NOTE: This should NOT depend on 'graph' to avoid syncing when graph changes externally
  useEffect(() => {
    if (!graph) return;
    if (isSyncingRef.current) {
      console.log('Skipping ReactFlow->graph sync (isSyncingRef=true)');
      return;
    }
    if (nodes.length === 0 && graph.nodes.length > 0) {
      console.log('Skipping ReactFlow->graph sync (still initializing)');
      return;
    }
    
    const updatedGraph = fromFlow(nodes, edges, graph);
    if (updatedGraph) {
      const updatedJson = JSON.stringify(updatedGraph);
      if (updatedJson === lastSyncedReactFlowRef.current) {
        console.log('Skipping ReactFlow->graph sync (no changes)');
        return;
      }
      
      console.log('=== Syncing ReactFlow -> graph ===');
      isSyncingRef.current = true;
      lastSyncedReactFlowRef.current = updatedJson;
      setGraph(updatedGraph);
      
      // Reset sync flag
      setTimeout(() => {
        isSyncingRef.current = false;
      }, 0);
    }
  }, [nodes, edges]); // Removed 'graph' and 'setGraph' from dependencies

  // Function to check if adding an edge would create a cycle
  const wouldCreateCycle = useCallback((source: string, target: string, currentEdges: any[]) => {
    // Create a directed graph representation
    const graph: { [key: string]: string[] } = {};
    
    // Initialize all nodes
    nodes.forEach(node => {
      graph[node.id] = [];
    });
    
    // Add existing edges
    currentEdges.forEach(edge => {
      if (graph[edge.source]) {
        graph[edge.source].push(edge.target);
      }
    });
    
    // Add the proposed new edge
    if (graph[source]) {
      graph[source].push(target);
    }
    
    // DFS to detect cycles
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    
    const hasCycleDFS = (node: string): boolean => {
      if (recursionStack.has(node)) {
        return true; // Cycle detected
      }
      
      if (visited.has(node)) {
        return false; // Already processed
      }
      
      visited.add(node);
      recursionStack.add(node);
      
      const neighbors = graph[node] || [];
      for (const neighbor of neighbors) {
        if (hasCycleDFS(neighbor)) {
          return true;
        }
      }
      
      recursionStack.delete(node);
      return false;
    };
    
    // Check all nodes for cycles
    for (const nodeId of Object.keys(graph)) {
      if (!visited.has(nodeId)) {
        if (hasCycleDFS(nodeId)) {
          return true;
        }
      }
    }
    
    return false;
  }, [nodes]);

  // Generate a unique slug for an edge based on node slugs
  const generateEdgeSlug = useCallback((sourceId: string, targetId: string) => {
    if (!graph?.nodes) return `${sourceId}-to-${targetId}`;
    
    // Find source and target nodes to get their slugs
    const sourceNode = graph.nodes.find((n: any) => n.id === sourceId);
    const targetNode = graph.nodes.find((n: any) => n.id === targetId);
    
    const sourceSlug = sourceNode?.slug || sourceNode?.id || sourceId;
    const targetSlug = targetNode?.slug || targetNode?.id || targetId;
    
    let baseSlug = `${sourceSlug}-to-${targetSlug}`;
    let slug = baseSlug;
    let counter = 1;
    
    // Ensure uniqueness by appending a number if needed
    const existingSlugs = getAllExistingSlugs();
    const uniqueSlug = generateUniqueSlug(baseSlug, existingSlugs);
    
    return uniqueSlug;
  }, [graph, getAllExistingSlugs]);

  // Handle new connections
  const onConnect = useCallback((connection: Connection) => {
    if (!graph) return;
    
    // Check for valid connection
    if (!connection.source || !connection.target) {
      return;
    }
    
    // Prevent self-referencing edges
    if (connection.source === connection.target) {
      alert('Cannot create an edge from a node to itself.');
      return;
    }

    // Check if source is a case node (do this check early)
    const sourceNode = graph.nodes.find(n => n.id === connection.source);
    const isCaseNode = sourceNode && sourceNode.type === 'case' && sourceNode.case;
    
    // Prevent duplicate edges (but allow multiple edges from case nodes with different variants)
    if (!isCaseNode) {
      // For normal nodes, prevent any duplicate edges
      const existingEdge = graph.edges.find(edge => 
        edge.from === connection.source && edge.to === connection.target
      );
      if (existingEdge) {
        alert('An edge already exists between these nodes.');
        return;
      }
    }
    // For case nodes, duplication check will happen after variant selection

    // Check for circular dependencies (convert graph edges to ReactFlow format for check)
    const reactFlowEdges = graph.edges.map(e => ({ source: e.from, target: e.to }));
    if (wouldCreateCycle(connection.source, connection.target, reactFlowEdges)) {
      alert('Cannot create this connection as it would create a circular dependency.');
      return;
    }

    // Generate a sensible slug for the edge
    const edgeSlug = generateEdgeSlug(connection.source, connection.target);
    const edgeId = `${connection.source}->${connection.target}`;
    
    // If source is a case node with multiple variants, show variant selection modal
    if (isCaseNode && sourceNode.case && sourceNode.case.variants.length > 1) {
      setPendingConnection(connection);
      setCaseNodeVariants(sourceNode.case.variants);
      setShowVariantModal(true);
      return; // Don't create the edge yet, wait for variant selection
    }
    
    // Add edge directly to graph state (not ReactFlow state)
    const nextGraph = structuredClone(graph);
    const newEdge: any = {
      id: edgeId,
      slug: edgeSlug,
      from: connection.source,
      to: connection.target,
      fromHandle: connection.sourceHandle,
      toHandle: connection.targetHandle,
      p: {
        mean: 0.5
      }
    };
    
    // If source is a case node with single variant, automatically assign variant properties
    if (isCaseNode && sourceNode.case && sourceNode.case.variants.length === 1) {
      const variant = sourceNode.case.variants[0];
      newEdge.case_id = sourceNode.case.id;
      newEdge.case_variant = variant.name;
      // Set p.mean to 1.0 for single-path case edges (default sub-routing)
      newEdge.p.mean = 1.0;
      console.log('Created case edge with single variant:', newEdge);
    }
    
    nextGraph.edges.push(newEdge);
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Update graph state - this will trigger graph->ReactFlow sync
    setGraph(nextGraph);
    
    // Select the new edge after a brief delay to allow sync to complete
    setTimeout(() => {
      onSelectedEdgeChange(edgeId);
    }, 50);
  }, [graph, setGraph, generateEdgeSlug, wouldCreateCycle, onSelectedEdgeChange]);

  // Variant selection modal state
  const [showVariantModal, setShowVariantModal] = useState(false);
  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null);
  const [caseNodeVariants, setCaseNodeVariants] = useState<any[]>([]);

  // Handle variant selection for case edges
  const handleVariantSelection = useCallback((variant: any) => {
    if (!pendingConnection || !graph) return;
    
    const sourceNode = graph.nodes.find(n => n.id === pendingConnection.source);
    if (!sourceNode || !sourceNode.case) return;
    
    // Check if an edge with this variant already exists between these nodes
    const existingVariantEdge = graph.edges.find(edge => 
      edge.from === pendingConnection.source && 
      edge.to === pendingConnection.target &&
      edge.case_id === sourceNode.case.id &&
      edge.case_variant === variant.name
    );
    
    if (existingVariantEdge) {
      alert(`An edge for variant "${variant.name}" already exists between these nodes.`);
      setShowVariantModal(false);
      setPendingConnection(null);
      setCaseNodeVariants([]);
      return;
    }
    
    // Generate edge properties
    const edgeSlug = generateEdgeSlug(pendingConnection.source!, pendingConnection.target!);
    const edgeId = `${pendingConnection.source}-${variant.name}->${pendingConnection.target}`;
    
    // Create the edge with variant properties
    const nextGraph = structuredClone(graph);
    nextGraph.edges.push({
      id: edgeId,
      slug: edgeSlug,
      from: pendingConnection.source,
      to: pendingConnection.target,
      fromHandle: pendingConnection.sourceHandle,
      toHandle: pendingConnection.targetHandle,
      case_id: sourceNode.case.id,
      case_variant: variant.name,
      p: {
        mean: 1.0 // Default to 1.0 for single-path case edges
      }
    });
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    setGraph(nextGraph);
    
    // Close modal and clear state
    setShowVariantModal(false);
    setPendingConnection(null);
    setCaseNodeVariants([]);
  }, [pendingConnection, graph, setGraph, generateEdgeSlug]);
  
  // Handle Shift+Drag lasso selection
  const [isLassoSelecting, setIsLassoSelecting] = useState(false);
  const [lassoStart, setLassoStart] = useState<{ x: number; y: number } | null>(null);
  const [lassoEnd, setLassoEnd] = useState<{ x: number; y: number } | null>(null);
  const [isShiftHeld, setIsShiftHeld] = useState(false);

  // Track Shift key state and handle mouse events globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setIsShiftHeld(true);
      }
      
      // Handle Delete key for selected elements (only when not editing)
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Don't handle if user is typing in form fields
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
          return;
        }
        
        const selectedNodes = nodes.filter(n => n.selected);
        const selectedEdges = edges.filter(e => e.selected);
        
        console.log('Delete key pressed, selected nodes:', selectedNodes.length, 'selected edges:', selectedEdges.length);
        
        if (selectedNodes.length > 0 || selectedEdges.length > 0) {
          e.preventDefault();
          if (confirm(`Delete ${selectedNodes.length} node(s) and ${selectedEdges.length} edge(s)?`)) {
            console.log('Calling deleteSelected');
            deleteSelected();
          }
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setIsShiftHeld(false);
        setIsLassoSelecting(false);
        setLassoStart(null);
        setLassoEnd(null);
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (isShiftHeld && e.target && (e.target as Element).closest('.react-flow')) {
        e.preventDefault();
        e.stopPropagation();
        setIsLassoSelecting(true);
        setLassoStart({ x: e.clientX, y: e.clientY });
        setLassoEnd({ x: e.clientX, y: e.clientY });
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (isLassoSelecting && lassoStart) {
        e.preventDefault();
        e.stopPropagation();
        setLassoEnd({ x: e.clientX, y: e.clientY });
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (isLassoSelecting && lassoStart && lassoEnd) {
        e.preventDefault();
        e.stopPropagation();
        
        // Use ReactFlow's built-in coordinate conversion
        const flowStart = screenToFlowPosition({ x: lassoStart.x, y: lassoStart.y });
        const flowEnd = screenToFlowPosition({ x: lassoEnd.x, y: lassoEnd.y });
        
        const flowStartX = flowStart.x;
        const flowStartY = flowStart.y;
        const flowEndX = flowEnd.x;
        const flowEndY = flowEnd.y;
        
        const lassoRect = {
          left: Math.min(flowStartX, flowEndX),
          top: Math.min(flowStartY, flowEndY),
          right: Math.max(flowStartX, flowEndX),
          bottom: Math.max(flowStartY, flowEndY)
        };

        const selectedNodes = nodes.filter(node => {
          const nodeRect = {
            left: node.position.x,
            top: node.position.y,
            right: node.position.x + 120, // Approximate node width
            bottom: node.position.y + 60  // Approximate node height
          };

          const intersects = !(nodeRect.right < lassoRect.left || 
                             nodeRect.left > lassoRect.right || 
                             nodeRect.bottom < lassoRect.top || 
                             nodeRect.top > lassoRect.bottom);
          
          console.log(`Node ${node.id}:`, {
            nodeRect: {
              left: nodeRect.left,
              top: nodeRect.top,
              right: nodeRect.right,
              bottom: nodeRect.bottom
            },
            lassoRect: {
              left: lassoRect.left,
              top: lassoRect.top,
              right: lassoRect.right,
              bottom: lassoRect.bottom
            },
            intersects
          });

          return intersects;
        });

        console.log('Lasso selection:', {
          lassoRect,
          selectedNodes: selectedNodes.map(n => n.id),
          allNodes: nodes.map(n => ({ id: n.id, position: n.position })),
          screenCoords: {
            start: { x: lassoStart.x, y: lassoStart.y },
            end: { x: lassoEnd.x, y: lassoEnd.y }
          },
          flowCoords: {
            start: { x: flowStartX, y: flowStartY },
            end: { x: flowEndX, y: flowEndY }
          }
        });

        // Store the selected node IDs for persistence
        const selectedNodeIds = selectedNodes.map(n => n.id);
        
        // Update nodes with selection state
        setNodes(prevNodes => 
          prevNodes.map(n => ({ 
            ...n, 
            selected: selectedNodeIds.includes(n.id)
          }))
        );
        
        // Force the selection to persist by re-applying it after a short delay
        setTimeout(() => {
          setNodes(prevNodes => 
            prevNodes.map(n => ({ 
              ...n, 
              selected: selectedNodeIds.includes(n.id)
            }))
          );
        }, 50);
        
        // Delay resetting lasso state
        setTimeout(() => {
          setIsLassoSelecting(false);
          setLassoStart(null);
          setLassoEnd(null);
        }, 200);
      } else {
        setIsLassoSelecting(false);
        setLassoStart(null);
        setLassoEnd(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousedown', handleMouseDown, true);
    window.addEventListener('mousemove', handleMouseMove, true);
    window.addEventListener('mouseup', handleMouseUp, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('mousemove', handleMouseMove, true);
      window.removeEventListener('mouseup', handleMouseUp, true);
    };
  }, [isShiftHeld, isLassoSelecting, lassoStart, lassoEnd, nodes, setNodes, edges, deleteSelected]);


  // Track selected nodes for probability calculation
  const [selectedNodesForAnalysis, setSelectedNodesForAnalysis] = useState<any[]>([]);

  // Helper function to find start nodes (nodes with no incoming edges)
  const findStartNodes = useCallback((allNodes: any[], allEdges: any[]): any[] => {
    const nodesWithIncoming = new Set(allEdges.map(edge => edge.target));
    return allNodes.filter(node => !nodesWithIncoming.has(node.id));
  }, []);

  // DFS function to find all paths between two nodes (with depth limit to prevent infinite loops)
  const findAllPaths = useCallback((sourceId: string, targetId: string, allEdges: any[], maxDepth: number = 10) => {
    const paths: string[][] = [];
    const visited = new Set<string>();
    
    const dfs = (currentNodeId: string, currentPath: string[], depth: number) => {
      // Limit depth to prevent infinite loops in complex graphs
      if (depth > maxDepth) return;
      
      if (currentNodeId === targetId) {
        paths.push([...currentPath]);
        return;
      }
      
      if (visited.has(currentNodeId)) return;
      visited.add(currentNodeId);
      
      // Find all outgoing edges from current node
      const outgoingEdges = allEdges.filter(edge => edge.source === currentNodeId);
      
      for (const edge of outgoingEdges) {
        if (!currentPath.includes(edge.id)) { // Avoid cycles
          currentPath.push(edge.id);
          dfs(edge.target, currentPath, depth + 1);
          currentPath.pop(); // Backtrack
        }
      }
      
      visited.delete(currentNodeId); // Allow revisiting for other paths
    };
    
    dfs(sourceId, [], 0);
    return paths;
  }, []);

  // Helper function to topologically sort nodes
  const topologicalSort = useCallback((nodeIds: string[], allEdges: any[]): string[] => {
    // Build adjacency list and in-degree map for selected nodes
    // But consider ALL edges in the graph to determine reachability
    const adjList = new Map<string, string[]>();
    const inDegree = new Map<string, number>();
    
    // Initialize
    nodeIds.forEach(id => {
      adjList.set(id, []);
      inDegree.set(id, 0);
    });
    
    // For each pair of selected nodes, check if one can reach the other
    // and build the dependency graph accordingly
    const selectedNodeSet = new Set(nodeIds);
    
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = 0; j < nodeIds.length; j++) {
        if (i !== j) {
          const sourceId = nodeIds[i];
          const targetId = nodeIds[j];
          
          // Check if there's ANY path from sourceId to targetId using ALL graph edges
          const hasPath = findAllPaths(sourceId, targetId, allEdges).length > 0;
          
          if (hasPath) {
            // Add edge in our dependency graph
            if (!adjList.get(sourceId)!.includes(targetId)) {
              adjList.get(sourceId)!.push(targetId);
              inDegree.set(targetId, inDegree.get(targetId)! + 1);
            }
          }
        }
      }
    }
    
    // Kahn's algorithm
    const queue: string[] = [];
    const sorted: string[] = [];
    
    // Add nodes with no incoming edges to queue
    inDegree.forEach((degree, nodeId) => {
      if (degree === 0) queue.push(nodeId);
    });
    
    while (queue.length > 0) {
      const current = queue.shift()!;
      sorted.push(current);
      
      // Reduce in-degree for neighbors
      adjList.get(current)!.forEach(neighbor => {
        const newDegree = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      });
    }
    
    // If not all nodes were sorted, there's a cycle - return original order
    return sorted.length === nodeIds.length ? sorted : nodeIds;
  }, [findAllPaths]);

  // Helper function to check if nodes are topologically sequential
  const areNodesTopologicallySequential = useCallback((sortedNodeIds: string[], allEdges: any[]): boolean => {
    // Check if there's a path connecting consecutive nodes in the sorted order
    for (let i = 0; i < sortedNodeIds.length - 1; i++) {
      const paths = findAllPaths(sortedNodeIds[i], sortedNodeIds[i + 1], allEdges);
      if (paths.length === 0) {
        return false; // No path between consecutive nodes
      }
    }
    return true;
  }, [findAllPaths]);

  // Function to find all edges that are part of paths between selected nodes
  const findPathEdges = useCallback((selectedNodes: any[], allEdges: any[]) => {
    if (selectedNodes.length === 0) return new Set();
    
    // Special case: 1 node - find path from start to this node
    if (selectedNodes.length === 1) {
      const startNodes = findStartNodes(nodes, allEdges);
      if (startNodes.length === 0) return new Set();
      
      const pathEdges = new Set<string>();
      const targetId = selectedNodes[0].id;
      
      // Find paths from all start nodes to the selected node
      startNodes.forEach(startNode => {
        const paths = findAllPaths(startNode.id, targetId, allEdges);
        paths.forEach(path => {
          path.forEach(edgeId => pathEdges.add(edgeId));
        });
      });
      
      return pathEdges;
    }
    
    if (selectedNodes.length < 2) return new Set();
    
    const selectedNodeIds = selectedNodes.map(node => node.id);
    const pathEdges = new Set<string>();
    
    // Special case: 3+ nodes - check if topologically sequential
    if (selectedNodes.length >= 3) {
      const sortedNodeIds = topologicalSort(selectedNodeIds, allEdges);
      const isSequential = areNodesTopologicallySequential(sortedNodeIds, allEdges);
      
      if (isSequential) {
        // Find path from first to last node, given intermediate nodes
        const firstNodeId = sortedNodeIds[0];
        const lastNodeId = sortedNodeIds[sortedNodeIds.length - 1];
        const intermediateIds = sortedNodeIds.slice(1, -1);
        
        // Find all paths from first to last that go through all intermediates
        const findPathsThroughNodes = (
          currentId: string,
          remainingNodes: string[],
          currentPath: string[]
        ): string[][] => {
          if (remainingNodes.length === 0) {
            // Reached the end, return the path
            return [currentPath];
          }
          
          const nextNode = remainingNodes[0];
          const restNodes = remainingNodes.slice(1);
          const allPaths: string[][] = [];
          
          // Find all paths from current to next node
          const paths = findAllPaths(currentId, nextNode, allEdges);
          paths.forEach(path => {
            allPaths.push(...findPathsThroughNodes(nextNode, restNodes, [...currentPath, ...path]));
          });
          
          return allPaths;
        };
        
        const paths = findPathsThroughNodes(firstNodeId, [...intermediateIds, lastNodeId], []);
        paths.forEach(path => {
          path.forEach(edgeId => pathEdges.add(edgeId));
        });
        
        return pathEdges;
      }
    }
    
    // Default case: For each pair of selected nodes, find all paths between them
    for (let i = 0; i < selectedNodeIds.length; i++) {
      for (let j = i + 1; j < selectedNodeIds.length; j++) {
        const sourceId = selectedNodeIds[i];
        const targetId = selectedNodeIds[j];
        
        // Find all paths from source to target
        const paths = findAllPaths(sourceId, targetId, allEdges);
        
        // Add all edges from all paths to the set
        paths.forEach(path => {
          path.forEach(edgeId => pathEdges.add(edgeId));
        });
        
        // Also find paths in reverse direction (target to source)
        const reversePaths = findAllPaths(targetId, sourceId, allEdges);
        reversePaths.forEach(path => {
          path.forEach(edgeId => pathEdges.add(edgeId));
        });
      }
    }
    
    return pathEdges;
  }, [nodes, findStartNodes, topologicalSort, areNodesTopologicallySequential, findAllPaths]);

  // Update edge highlighting when selection changes
  useEffect(() => {
    setEdges(prevEdges => {
      if (prevEdges.length === 0) return prevEdges;
      
      const pathEdges = findPathEdges(selectedNodesForAnalysis, prevEdges);
      
      // Debug logging
      if (selectedNodesForAnalysis.length >= 2) {
        console.log('Selected nodes:', selectedNodesForAnalysis.map(n => n.id));
        console.log('Highlighted edges:', Array.from(pathEdges));
      }
      
      return prevEdges.map(edge => ({
        ...edge,
        data: {
          ...edge.data,
          isHighlighted: pathEdges.has(edge.id)
        }
      }));
    });
  }, [selectedNodesForAnalysis, setEdges, findPathEdges]);

  // Calculate probability and cost for selected nodes
  const calculateSelectionAnalysis = useCallback(() => {
    if (selectedNodesForAnalysis.length === 0) return null;

    const selectedNodeIds = selectedNodesForAnalysis.map(n => n.id);
    
    // Helper function to find path through intermediate nodes using dagCalc logic
    const findPathThroughIntermediates = (startId: string, endId: string, givenVisitedNodeIds?: string[]): { path: any[], probability: number, expectedCosts: any } => {
      const visited = new Set<string>();
      const costs: { [nodeId: string]: { monetary: number, time: number, units: string } } = {};
      
      // Get current what-if state (avoid stale closures)
      const currentOverrides = useGraphStore.getState().whatIfOverrides;
      
      // Build set of nodes guaranteed to be visited in this path context
      const givenNodesSet = givenVisitedNodeIds ? new Set(givenVisitedNodeIds) : new Set<string>();
      
      // GRAPH PRUNING: Identify edges to exclude based on unselected siblings
      const excludedEdges = new Set<string>();
      
      if (givenNodesSet.size > 0) {
        // For each node in the graph, find if it has multiple children and some are selected as via nodes
        const nodeChildren = new Map<string, string[]>();
        edges.forEach(edge => {
          if (!nodeChildren.has(edge.source)) {
            nodeChildren.set(edge.source, []);
          }
          nodeChildren.get(edge.source)!.push(edge.target);
        });
        
        // For each parent node
        nodeChildren.forEach((children, parentId) => {
          if (children.length <= 1) return; // No siblings to prune
          
          // Check if any children are in the via set
          const selectedChildren = children.filter(childId => givenNodesSet.has(childId));
          
          if (selectedChildren.length > 0 && selectedChildren.length < children.length) {
            // Some but not all children are selected → prune unselected siblings
            const unselectedChildren = children.filter(childId => !givenNodesSet.has(childId));
            
            // Exclude all edges leading to unselected siblings (and their descendants)
            unselectedChildren.forEach(unselectedChild => {
              edges.forEach(edge => {
                if (edge.source === parentId && edge.target === unselectedChild) {
                  excludedEdges.add(edge.id);
                }
              });
            });
          }
        });
      }
      
      const dfs = (nodeId: string, currentPathContext: Set<string>): { monetary: number, time: number, units: string } => {
        // Check if already visited (cycle detection)
        if (visited.has(nodeId)) {
          return costs[nodeId] || { monetary: 0, time: 0, units: '' };
        }
        
        // Check if it's the end node
        if (nodeId === endId) {
          costs[nodeId] = { monetary: 0, time: 0, units: '' };
          return costs[nodeId];
        }
        
        visited.add(nodeId);
        let totalCost = { monetary: 0, time: 0, units: '' };
        
        // Find all outgoing edges from current node (excluding pruned edges)
        const outgoingEdges = edges.filter(edge => edge.source === nodeId && !excludedEdges.has(edge.id));
        
        for (const edge of outgoingEdges) {
          // Build path context for THIS edge: includes given nodes + all nodes visited so far
          const edgePathContext = new Set([...givenNodesSet, ...currentPathContext]);
          
          // UNIFIED: Use shared what-if logic for probability
          // Pass accumulated path context so conditionals know which nodes have been visited on THIS path
          const edgeProbability = computeEffectiveEdgeProbability(graph, edge.id, currentOverrides, whatIfAnalysis, edgePathContext);
          
          const edgeCosts = edge.data?.costs;
          
          // Update path context to include the target node we're about to visit
          const nextPathContext = new Set([...edgePathContext, edge.target]);
          
          // Get cost from target node (recursive) with updated path context
          const targetCost = dfs(edge.target, nextPathContext);
          
          // Calculate probability-weighted cost (dagCalc logic)
          const edgeCost = {
            monetary: edgeCosts?.monetary?.value || 0,
            time: edgeCosts?.time?.value || 0,
            units: edgeCosts?.time?.units || ''
          };
          
          totalCost.monetary += edgeProbability * (edgeCost.monetary + targetCost.monetary);
          totalCost.time += edgeProbability * (edgeCost.time + targetCost.time);
          totalCost.units = totalCost.units || edgeCost.units;
        }
        
        costs[nodeId] = totalCost;
        return totalCost;
      };
      
      // Start DFS with initial path context (given nodes + start node)
      const initialContext = new Set([...givenNodesSet, startId]);
      const expectedCosts = dfs(startId, initialContext);
      
      // Calculate total probability using memoized DFS to avoid infinite recursion
      const probabilityCache = new Map<string, number>();
      const probVisited = new Set<string>();
      
      const calculateProbability = (nodeId: string, currentPathContext: Set<string>): number => {
        if (nodeId === endId) return 1;
        
        // Cache key includes path context to handle different contexts correctly
        const cacheKey = `${nodeId}|${Array.from(currentPathContext).sort().join(',')}`;
        if (probabilityCache.has(cacheKey)) {
          return probabilityCache.get(cacheKey)!;
        }
        
        // Detect cycles
        if (probVisited.has(nodeId)) {
          return 0;
        }
        
        probVisited.add(nodeId);
        
        let totalProbability = 0;
        // Use pruned edge set (excluding unselected siblings)
        const outgoingEdges = edges.filter(edge => edge.source === nodeId && !excludedEdges.has(edge.id));
        
        for (const edge of outgoingEdges) {
          // Build path context for this edge
          const edgePathContext = new Set([...givenNodesSet, ...currentPathContext]);
          
          // UNIFIED: Use shared what-if logic for probability
          // Pass accumulated path context so conditionals know which nodes have been visited on THIS path
          const edgeProbability = computeEffectiveEdgeProbability(graph, edge.id, currentOverrides, whatIfAnalysis, edgePathContext);
          
          // Update path context to include target node
          const nextPathContext = new Set([...currentPathContext, edge.target]);
          const targetProbability = calculateProbability(edge.target, nextPathContext);
          totalProbability += edgeProbability * targetProbability;
        }
        
        probVisited.delete(nodeId);
        probabilityCache.set(cacheKey, totalProbability);
        return totalProbability;
      };
      
      const pathProbability = calculateProbability(startId, initialContext);
      
      return { 
        path: [], // We don't need the actual path for cost calculation
        probability: pathProbability, 
        expectedCosts 
      };
    };
    
    // Special case: 1 node selected - path from Start to selected
    if (selectedNodesForAnalysis.length === 1) {
      const selectedNode = selectedNodesForAnalysis[0];
      const startNodes = findStartNodes(nodes, edges);
      
      if (startNodes.length === 0) {
        return {
          type: 'single',
          node: selectedNode,
          error: 'No start node found in graph'
        };
      }
      
      // Use first start node (or could aggregate across all start nodes)
      const startNode = startNodes[0];
      
      if (startNode.id === selectedNode.id) {
        return {
          type: 'single',
          node: selectedNode,
          isStartNode: true,
          pathProbability: 1.0,
          pathCosts: { monetary: 0, time: 0, units: '' }
        };
      }
      
      // Pass both nodes for graph pruning (excludes siblings) and conditional activation
      const pathAnalysis = findPathThroughIntermediates(startNode.id, selectedNode.id, [startNode.id, selectedNode.id]);
      
      // Calculate expected cost GIVEN that the path occurs
      const expectedCostsGivenPath = {
        monetary: pathAnalysis.probability > 0 ? pathAnalysis.expectedCosts.monetary / pathAnalysis.probability : 0,
        time: pathAnalysis.probability > 0 ? pathAnalysis.expectedCosts.time / pathAnalysis.probability : 0,
        units: pathAnalysis.expectedCosts.units
      };
      
      return {
        type: 'single',
        node: selectedNode,
        startNode: startNode,
        pathProbability: pathAnalysis.probability,
        pathCosts: expectedCostsGivenPath,
        isStartNode: false
      };
    }
    
    // Special case: exactly 2 nodes selected - calculate path analysis
    if (selectedNodesForAnalysis.length === 2) {
      // ALWAYS sort topologically first
      const sortedNodeIds = topologicalSort(selectedNodeIds, edges);
      const nodeA = selectedNodesForAnalysis.find(n => n.id === sortedNodeIds[0])!;
      const nodeB = selectedNodesForAnalysis.find(n => n.id === sortedNodeIds[1])!;
      
      // Find direct edge between the two nodes (A → B)
      const directEdge = edges.find(edge => 
        edge.source === nodeA.id && edge.target === nodeB.id
      );
      
      // Find reverse edge (B → A) 
      const reverseEdge = edges.find(edge => 
        edge.source === nodeB.id && edge.target === nodeA.id
      );
      
      // Calculate direct path (if exists) - for direct paths, cost is just the edge cost
      // UNIFIED: Use shared what-if logic for probability
      const currentOverrides = useGraphStore.getState().whatIfOverrides;
      // Pass nodeA as visited context for conditional probability resolution
      const pathContext = new Set([nodeA.id]);
      let directPathProbability = directEdge ? computeEffectiveEdgeProbability(graph, directEdge.id, currentOverrides, whatIfAnalysis, pathContext) : 0;
      const directPathCosts = {
        monetary: directEdge?.data?.costs?.monetary?.value || 0,
        time: directEdge?.data?.costs?.time?.value || 0,
        units: directEdge?.data?.costs?.time?.units || ''
      };
      
      // Calculate path through intermediates using dagCalc logic
      // Pass both nodes for graph pruning (excludes siblings) and conditional activation
      const intermediatePath = findPathThroughIntermediates(nodeA.id, nodeB.id, [nodeA.id, nodeB.id]);
      
      // Use the path with higher probability (direct vs intermediate)
      const useDirectPath = directEdge && directPathProbability >= intermediatePath.probability;
      const finalPath = useDirectPath ? {
        probability: directPathProbability,
        costs: directPathCosts,
        isDirect: true,
        pathEdges: directEdge ? [directEdge] : []
      } : {
        probability: intermediatePath.probability,
        costs: intermediatePath.expectedCosts,
        isDirect: false,
        pathEdges: []
      };
      
      // Calculate expected cost GIVEN that the path occurs (cost per successful conversion)
      const expectedCostsGivenPath = {
        monetary: finalPath.probability > 0 ? finalPath.costs.monetary / finalPath.probability : 0,
        time: finalPath.probability > 0 ? finalPath.costs.time / finalPath.probability : 0,
        units: finalPath.costs.units
      };
      
      return {
        type: 'path',
        nodeA: nodeA,
        nodeB: nodeB,
        directEdge: directEdge,
        reverseEdge: reverseEdge,
        pathProbability: finalPath.probability,
        pathCosts: expectedCostsGivenPath, // Use the corrected expected costs
        hasDirectPath: !!directEdge,
        hasReversePath: !!reverseEdge,
        isDirectPath: finalPath.isDirect,
        pathEdges: finalPath.pathEdges,
        intermediateNodes: finalPath.pathEdges.length > 1 ? 
          finalPath.pathEdges.slice(0, -1).map(edge => edge.target) : []
      };
    }
    
    // Special case: 3+ nodes - check if topologically sequential
    if (selectedNodesForAnalysis.length >= 3) {
      const sortedNodeIds = topologicalSort(selectedNodeIds, edges);
      const isSequential = areNodesTopologicallySequential(sortedNodeIds, edges);
      
      if (isSequential) {
        // Path analysis from first to last through intermediate nodes
        const firstNodeId = sortedNodeIds[0];
        const lastNodeId = sortedNodeIds[sortedNodeIds.length - 1];
        const intermediateIds = sortedNodeIds.slice(1, -1);
        
        const firstNode = selectedNodesForAnalysis.find(n => n.id === firstNodeId);
        const lastNode = selectedNodesForAnalysis.find(n => n.id === lastNodeId);
        
        // Calculate path probability through segments (A → B → C = P(A→B) * P(B→C))
        // This ensures we only consider paths that actually go through the intermediate nodes
        let totalProbability = 1.0;
        let totalCostGivenPath = { monetary: 0, time: 0, units: '' };
        
        for (let i = 0; i < sortedNodeIds.length - 1; i++) {
          const segmentStart = sortedNodeIds[i];
          const segmentEnd = sortedNodeIds[i + 1];
          
          // Pass ALL selected nodes as via nodes for graph pruning
          // This ensures unselected siblings are excluded across the entire path
          // Also includes nodes visited so far for conditional probability activation
          const allSelectedNodes = sortedNodeIds;
          
          const segmentAnalysis = findPathThroughIntermediates(segmentStart, segmentEnd, allSelectedNodes);
          
          totalProbability *= segmentAnalysis.probability;
          
          // Cost for this segment, given that the segment is traversed
          // expectedCosts is probability-weighted, so divide by probability to get cost per successful traversal
          const segmentCostGivenPath = {
            monetary: segmentAnalysis.probability > 0 ? segmentAnalysis.expectedCosts.monetary / segmentAnalysis.probability : 0,
            time: segmentAnalysis.probability > 0 ? segmentAnalysis.expectedCosts.time / segmentAnalysis.probability : 0,
            units: segmentAnalysis.expectedCosts.units
          };
          
          totalCostGivenPath.monetary += segmentCostGivenPath.monetary;
          totalCostGivenPath.time += segmentCostGivenPath.time;
          totalCostGivenPath.units = totalCostGivenPath.units || segmentCostGivenPath.units;
        }
        
        const expectedCostsGivenPath = totalCostGivenPath;
        
        return {
          type: 'path_sequential',
          nodeA: firstNode,
          nodeB: lastNode,
          intermediateNodes: intermediateIds.map(id => selectedNodesForAnalysis.find(n => n.id === id)),
          pathProbability: totalProbability,
          pathCosts: expectedCostsGivenPath,
          sortedNodeIds: sortedNodeIds
        };
      }
    }
    
    // General case: multiple nodes selected - existing analysis
    const internalEdges = edges.filter(edge => 
      selectedNodeIds.includes(edge.source) && selectedNodeIds.includes(edge.target)
    );
    
    const incomingEdges = edges.filter(edge => 
      !selectedNodeIds.includes(edge.source) && selectedNodeIds.includes(edge.target)
    );
    
    const outgoingEdges = edges.filter(edge => 
      selectedNodeIds.includes(edge.source) && !selectedNodeIds.includes(edge.target)
    );

    const totalIncomingProbability = incomingEdges.reduce((sum, edge) => {
      const prob = edge.data?.probability || 0;
      return sum + prob;
    }, 0);
    
    const totalOutgoingProbability = outgoingEdges.reduce((sum, edge) => {
      const prob = edge.data?.probability || 0;
      return sum + prob;
    }, 0);

    const totalCosts = {
      monetary: 0,
      time: 0,
      units: ''
    };

    [...internalEdges, ...outgoingEdges].forEach(edge => {
      if (edge.data?.costs) {
        totalCosts.monetary += edge.data.costs.monetary?.value || 0;
        totalCosts.time += edge.data.costs.time?.value || 0;
        if (edge.data.costs.time?.units && !totalCosts.units) {
          totalCosts.units = edge.data.costs.time.units;
        }
      }
    });

    return {
      type: 'multi',
      selectedNodes: selectedNodesForAnalysis.length,
      internalEdges: internalEdges.length,
      incomingEdges: incomingEdges.length,
      outgoingEdges: outgoingEdges.length,
      totalIncomingProbability,
      totalOutgoingProbability,
      totalCosts,
      probabilityConservation: Math.abs(totalIncomingProbability - totalOutgoingProbability) < 0.001
    };
  }, [selectedNodesForAnalysis, edges, nodes, whatIfAnalysis, findStartNodes, topologicalSort, areNodesTopologicallySequential, graph, overridesVersion]);

  const analysis = calculateSelectionAnalysis();

  // Handle selection changes
  const onSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: any) => {
    console.log('Selection changed:', { 
      nodes: selectedNodes.map(n => n.id), 
      edges: selectedEdges.map(e => e.id) 
    });
    
    // Update selected nodes for analysis
    setSelectedNodesForAnalysis(selectedNodes);
    
    // Don't clear selection if we just finished a lasso selection
    if (isLassoSelecting) {
      console.log('Ignoring selection change during lasso selection');
      return;
    }
    
    // For multi-selection, we'll show the first selected item in the properties panel
    // but keep track of all selected items for operations like delete
    if (selectedNodes.length > 0) {
      onSelectedNodeChange(selectedNodes[0].id);
      onSelectedEdgeChange(null);
    } else if (selectedEdges.length > 0) {
      onSelectedEdgeChange(selectedEdges[0].id);
      onSelectedNodeChange(null);
    } else {
      onSelectedNodeChange(null);
      onSelectedEdgeChange(null);
    }
  }, [onSelectedNodeChange, onSelectedEdgeChange, isLassoSelecting]);

  // Add new node
  const addNode = useCallback(() => {
    if (!graph) return;
    
    const newId = crypto.randomUUID();
    
    // Generate initial label and slug
    const label = `Node ${graph.nodes.length + 1}`;
    const baseSlug = generateSlugFromLabel(label);
    
    // Get all existing slugs to ensure uniqueness from the graph state
    const existingSlugs = getAllExistingSlugs();
    const slug = generateUniqueSlug(baseSlug, existingSlugs);
    
    // Add node directly to graph state (not ReactFlow state)
    const nextGraph = structuredClone(graph);
    nextGraph.nodes.push({
      id: newId,
      slug: slug,
      label: label,
      absorbing: false,
      layout: {
        x: Math.random() * 400 + 100,
        y: Math.random() * 300 + 100
      }
    });
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Update graph state - this will trigger graph->ReactFlow sync
    setGraph(nextGraph);
    
    // Select the new node after a brief delay to allow sync to complete
    setTimeout(() => {
      onSelectedNodeChange(newId);
    }, 50);
  }, [graph, setGraph, generateSlugFromLabel, generateUniqueSlug, getAllExistingSlugs, onSelectedNodeChange]);


  if (!graph) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      Loading...
    </div>;
  }

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectionChange={onSelectionChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        selectionOnDrag={false}
        selectNodesOnDrag={false}
        selectionKeyCode={['Meta', 'Ctrl']}
        nodesDraggable
        nodesConnectable
        elementsSelectable
        panOnDrag={!isLassoSelecting}
        style={{ background: '#f8f9fa' }}
        onInit={() => setTimeout(() => fitView(), 100)}
      >
        <Background />
        <Controls />
        <MiniMap />
        
        {/* Lasso selection rectangle */}
        {isLassoSelecting && lassoStart && lassoEnd && (
          <div
            style={{
              position: 'absolute',
              left: Math.min(lassoStart.x, lassoEnd.x),
              top: Math.min(lassoStart.y, lassoEnd.y),
              width: Math.abs(lassoEnd.x - lassoStart.x),
              height: Math.abs(lassoEnd.y - lassoStart.y),
              border: '2px dashed #007bff',
              background: 'rgba(0, 123, 255, 0.1)',
              pointerEvents: 'none',
              zIndex: 1000,
            }}
          />
        )}
        
        <Panel position="top-left">
          <button
            onClick={addNode}
            style={{
              padding: '8px 16px',
              background: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              marginRight: '8px',
            }}
          >
            + Add Node
          </button>
          <button
            onClick={deleteSelected}
            style={{
              padding: '8px 16px',
              background: '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Delete Selected
          </button>
        </Panel>

        {/* Selection Analysis Popup */}
        {analysis && (
          <Panel position="bottom-left">
            <div style={{
              background: 'white',
              border: '2px solid #007bff',
              borderRadius: '8px',
              padding: '16px',
              minWidth: '300px',
              maxWidth: '400px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              fontSize: '14px',
              lineHeight: '1.4'
            }}>
              <h3 style={{ margin: '0 0 12px 0', color: '#007bff', fontSize: '16px' }}>
                {analysis.type === 'path' || analysis.type === 'path_sequential' || analysis.type === 'single' ? 'Path Analysis' : 'Selection Analysis'}
              </h3>
              
              {analysis.type === 'single' ? (
                // Path analysis for 1 node (Start to selected)
                <>
                  {analysis.error ? (
                    <div style={{ color: '#ff6b6b', fontSize: '12px' }}>
                      ⚠️ {analysis.error}
                    </div>
                  ) : analysis.isStartNode ? (
                    <>
                      <div style={{ marginBottom: '12px' }}>
                        <strong>Node:</strong> {analysis.node.data?.label || analysis.node.id}
                      </div>
                      <div style={{ color: '#16a34a', fontSize: '12px' }}>
                        ✅ This is the start node
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ marginBottom: '12px' }}>
                        <strong>Path:</strong> {analysis.startNode?.data?.label || analysis.startNode?.id || 'Start'} → {analysis.node.data?.label || analysis.node.id}
                      </div>
                      
                      {analysis.pathProbability > 0 ? (
                        <>
                          <div style={{ marginBottom: '8px' }}>
                            <strong>Probability:</strong> {(analysis.pathProbability * 100).toFixed(2)}%
                          </div>
                          
                          {((analysis.pathCosts?.monetary || 0) > 0 || (analysis.pathCosts?.time || 0) > 0) && (
                            <div style={{ marginBottom: '8px' }}>
                              <strong>Expected Cost (Given Path):</strong>
                              <div style={{ marginLeft: '12px', fontSize: '12px' }}>
                                {(analysis.pathCosts?.monetary || 0) > 0 && (
                                  <div>💰 £{(analysis.pathCosts?.monetary || 0).toFixed(2)} per conversion</div>
                                )}
                                {(analysis.pathCosts?.time || 0) > 0 && (
                                  <div>⏱️ {(analysis.pathCosts?.time || 0).toFixed(1)} {analysis.pathCosts?.units || 'units'} per conversion</div>
                                )}
                              </div>
                            </div>
                          )}
                        </>
                      ) : (
                        <div style={{ color: '#ff6b6b', fontSize: '12px' }}>
                          ⚠️ No path found from start
                        </div>
                      )}
                    </>
                  )}
                </>
              ) : analysis.type === 'path_sequential' ? (
                // Path analysis for 3+ topologically sequential nodes
                <>
                  <div style={{ marginBottom: '12px' }}>
                    <strong>Path:</strong> {analysis.nodeA?.data?.label || analysis.nodeA?.id} → {analysis.nodeB?.data?.label || analysis.nodeB?.id}
                    {analysis.intermediateNodes && analysis.intermediateNodes.length > 0 && (
                      <div style={{ color: '#666', fontSize: '12px', marginTop: '2px' }}>
                        via {analysis.intermediateNodes.map((n: any) => n?.data?.label || n?.id).join(' → ')}
                      </div>
                    )}
                  </div>
                  
                  {analysis.pathProbability > 0 ? (
                    <>
                      <div style={{ marginBottom: '8px' }}>
                        <strong>Probability:</strong> {(analysis.pathProbability * 100).toFixed(2)}%
                      </div>
                      
                      {((analysis.pathCosts?.monetary || 0) > 0 || (analysis.pathCosts?.time || 0) > 0) && (
                        <div style={{ marginBottom: '8px' }}>
                          <strong>Expected Cost (Given Path):</strong>
                          <div style={{ marginLeft: '12px', fontSize: '12px' }}>
                            {(analysis.pathCosts?.monetary || 0) > 0 && (
                              <div>💰 £{(analysis.pathCosts?.monetary || 0).toFixed(2)} per conversion</div>
                            )}
                            {(analysis.pathCosts?.time || 0) > 0 && (
                              <div>⏱️ {(analysis.pathCosts?.time || 0).toFixed(1)} {analysis.pathCosts?.units || 'units'} per conversion</div>
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ color: '#ff6b6b', fontSize: '12px' }}>
                      ⚠️ No connection found through selected nodes
                    </div>
                  )}
                </>
              ) : analysis.type === 'path' ? (
                // Path analysis for exactly 2 nodes
                <>
                  <div style={{ marginBottom: '12px' }}>
                    <strong>Path:</strong> {analysis.nodeA.data?.label || analysis.nodeA.id} → {analysis.nodeB.data?.label || analysis.nodeB.id}
                  </div>
                  
                  {analysis.pathProbability > 0 ? (
                    <>
                      <div style={{ marginBottom: '8px' }}>
                        <strong>Probability:</strong> {(analysis.pathProbability * 100).toFixed(2)}%
                        {!analysis.isDirectPath && (analysis.intermediateNodes?.length || 0) > 0 && (
                          <div style={{ color: '#666', fontSize: '12px', marginTop: '2px' }}>
                            via {analysis.intermediateNodes?.length || 0} intermediate node{(analysis.intermediateNodes?.length || 0) > 1 ? 's' : ''}
                          </div>
                        )}
                      </div>
                      
                      {((analysis.pathCosts?.monetary || 0) > 0 || (analysis.pathCosts?.time || 0) > 0) && (
                        <div style={{ marginBottom: '8px' }}>
                          <strong>Expected Cost (Given Path):</strong>
                          <div style={{ marginLeft: '12px', fontSize: '12px' }}>
                            {(analysis.pathCosts?.monetary || 0) > 0 && (
                              <div>💰 £{(analysis.pathCosts?.monetary || 0).toFixed(2)} per conversion</div>
                            )}
                            {(analysis.pathCosts?.time || 0) > 0 && (
                              <div>⏱️ {(analysis.pathCosts?.time || 0).toFixed(1)} {analysis.pathCosts?.units || 'units'} per conversion</div>
                            )}
                          </div>
                        </div>
                      )}
                      
                      {analysis.hasReversePath && (
                        <div style={{ color: '#666', fontSize: '12px', marginTop: '8px' }}>
                          ℹ️ Bidirectional path exists
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ color: '#ff6b6b', fontSize: '12px' }}>
                      ⚠️ No connection found (direct or via intermediates)
                    </div>
                  )}
                </>
              ) : (
                // Multi-node analysis (existing logic)
                <>
                  <div style={{ marginBottom: '8px' }}>
                    <strong>Nodes:</strong> {analysis.selectedNodes} selected
                  </div>
                  
                  <div style={{ marginBottom: '8px' }}>
                    <strong>Edges:</strong> {analysis.internalEdges} internal, {analysis.incomingEdges} incoming, {analysis.outgoingEdges} outgoing
                  </div>
                  
                  <div style={{ marginBottom: '8px' }}>
                    <strong>Probability Flow:</strong>
                    <div style={{ marginLeft: '12px', fontSize: '12px' }}>
                      In: {Math.round((analysis.totalIncomingProbability || 0) * 100)}% → Out: {Math.round((analysis.totalOutgoingProbability || 0) * 100)}%
                    </div>
                    {(analysis.totalOutgoingProbability || 0) === 0 && (analysis.totalIncomingProbability || 0) > 0 ? (
                      <div style={{ color: '#16a34a', fontSize: '12px', marginTop: '4px' }}>
                        ✅ Complete path selected - probability contained within selection
                      </div>
                    ) : !analysis.probabilityConservation ? (
                      <div style={{ color: '#ff6b6b', fontSize: '12px', marginTop: '4px' }}>
                        ⚠️ Probability not conserved
                      </div>
                    ) : (
                      <div style={{ color: '#16a34a', fontSize: '12px', marginTop: '4px' }}>
                        ✅ Probability conserved
                      </div>
                    )}
                  </div>
                  
                  {((analysis.totalCosts?.monetary || 0) > 0 || (analysis.totalCosts?.time || 0) > 0) && (
                    <div style={{ marginBottom: '8px' }}>
                      <strong>Total Costs:</strong>
                      <div style={{ marginLeft: '12px', fontSize: '12px' }}>
                        {(analysis.totalCosts?.monetary || 0) > 0 && (
                          <div>£{analysis.totalCosts?.monetary}{analysis.totalCosts?.units && ` ${analysis.totalCosts.units}`}</div>
                        )}
                        {(analysis.totalCosts?.time || 0) > 0 && (
                          <div>{analysis.totalCosts?.time}h{analysis.totalCosts?.units && ` ${analysis.totalCosts.units}`}</div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </Panel>
        )}
      </ReactFlow>
      
      {/* Variant Selection Modal */}
      {showVariantModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            background: 'white',
            padding: '24px',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            maxWidth: '400px',
            width: '90%'
          }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', fontWeight: '600' }}>
              Select Variant for Case Edge
            </h3>
            <p style={{ margin: '0 0 16px 0', color: '#666', fontSize: '14px' }}>
              Choose which variant this edge represents:
            </p>
            
            <div style={{ marginBottom: '16px' }}>
              {caseNodeVariants.map((variant, index) => {
                // Check if this variant already has an edge to the target
                const sourceNode = graph?.nodes.find(n => n.id === pendingConnection?.source);
                const hasExistingEdge = graph?.edges.some(edge => 
                  edge.from === pendingConnection?.source && 
                  edge.to === pendingConnection?.target &&
                  edge.case_id === sourceNode?.case?.id &&
                  edge.case_variant === variant.name
                );
                
                return (
                  <button
                    key={index}
                    onClick={() => handleVariantSelection(variant)}
                    disabled={hasExistingEdge}
                    style={{
                      width: '100%',
                      padding: '12px 16px',
                      marginBottom: '8px',
                      border: hasExistingEdge ? '1px solid #ccc' : '1px solid #ddd',
                      borderRadius: '4px',
                      background: hasExistingEdge ? '#e9ecef' : '#f8f9fa',
                      cursor: hasExistingEdge ? 'not-allowed' : 'pointer',
                      textAlign: 'left',
                      fontSize: '14px',
                      transition: 'all 0.2s ease',
                      opacity: hasExistingEdge ? 0.6 : 1
                    }}
                    onMouseEnter={(e) => {
                      if (!hasExistingEdge) {
                        e.currentTarget.style.background = '#e9ecef';
                        e.currentTarget.style.borderColor = '#8B5CF6';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!hasExistingEdge) {
                        e.currentTarget.style.background = '#f8f9fa';
                        e.currentTarget.style.borderColor = '#ddd';
                      }
                    }}
                  >
                    <div style={{ fontWeight: '600', marginBottom: '4px' }}>
                      {variant.name}
                      {hasExistingEdge && <span style={{ color: '#666', fontWeight: 'normal', marginLeft: '8px' }}>✓ Already connected</span>}
                    </div>
                    <div style={{ color: '#666', fontSize: '12px' }}>
                      Weight: {(variant.weight * 100).toFixed(0)}%
                      {variant.description && ` • ${variant.description}`}
                    </div>
                  </button>
                );
              })}
            </div>
            
            <button
              onClick={() => {
                setShowVariantModal(false);
                setPendingConnection(null);
                setCaseNodeVariants([]);
              }}
              style={{
                padding: '8px 16px',
                background: '#6c757d',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '14px'
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
