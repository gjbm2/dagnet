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
  ConnectionMode,
} from 'reactflow';
import 'reactflow/dist/style.css';
import dagre from 'dagre';

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
  onAddNodeRef?: React.MutableRefObject<(() => void) | null>;
  onDeleteSelectedRef?: React.MutableRefObject<(() => void) | null>;
  onAutoLayoutRef?: React.MutableRefObject<((direction: 'LR' | 'RL' | 'TB' | 'BT') => void) | null>;
}

export default function GraphCanvas({ onSelectedNodeChange, onSelectedEdgeChange, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, edgeScalingMode, autoReroute, onAddNodeRef, onDeleteSelectedRef, onAutoLayoutRef }: GraphCanvasProps) {
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
        onAddNodeRef={onAddNodeRef}
        onDeleteSelectedRef={onDeleteSelectedRef}
        onAutoLayoutRef={onAutoLayoutRef}
      />
    </ReactFlowProvider>
  );
}

function CanvasInner({ onSelectedNodeChange, onSelectedEdgeChange, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, edgeScalingMode, autoReroute, onAddNodeRef, onDeleteSelectedRef, onAutoLayoutRef }: GraphCanvasProps) {
  const store = useGraphStore();
  const { graph, setGraph, whatIfAnalysis } = store;
  const saveHistoryState = store.saveHistoryState;
  // Recompute edge widths when conditional what-if overrides change
  const overridesVersion = useGraphStore(state => state.whatIfOverrides._version);
  const { deleteElements, fitView, screenToFlowPosition, setCenter } = useReactFlow();
  
  // ReactFlow maintains local state for smooth interactions
  const [nodes, setNodes, onNodesChangeBase] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  
  // Trigger flag for re-routing
  const [shouldReroute, setShouldReroute] = useState(0);
  const [forceReroute, setForceReroute] = useState(false); // Force re-route once (for layout)
  
  // Auto-layout state
  const [layoutDirection, setLayoutDirection] = useState<'LR' | 'RL' | 'TB' | 'BT'>('LR');
  
  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; flowX: number; flowY: number } | null>(null);
  const [nodeContextMenu, setNodeContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [edgeContextMenu, setEdgeContextMenu] = useState<{ x: number; y: number; edgeId: string } | null>(null);
  const [contextMenuLocalData, setContextMenuLocalData] = useState<{
    probability: number;
    conditionalProbabilities: { [key: string]: number };
    variantWeight: number;
  } | null>(null);
  
  // Custom onNodesChange handler to detect position changes for auto re-routing
  const onNodesChange = useCallback((changes: any[]) => {
    // Call the base handler first
    onNodesChangeBase(changes);
    
    // Save history for node changes (position, selection, etc.)
    const hasPositionChanges = changes.some(change => change.type === 'position' && change.dragging === false);
    if (hasPositionChanges) {
      saveHistoryState('Move node');
    }
    
    // Check if any position changes occurred (when user finishes dragging)
    if (autoReroute) {
      const positionChanges = changes.filter(change => change.type === 'position' && change.dragging === false);
      if (positionChanges.length > 0) {
        // Trigger re-routing by incrementing the flag
        setShouldReroute(prev => prev + 1);
      }
    }
  }, [onNodesChangeBase, autoReroute, saveHistoryState]);

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
    
    // Get current state from store (avoid stale closures)
    const currentGraph = useGraphStore.getState().graph;
    const currentOverrides = useGraphStore.getState().whatIfOverrides;
    const currentWhatIfAnalysis = useGraphStore.getState().whatIfAnalysis;

    // UNIFIED helper: get effective probability using shared logic
    const getEffectiveProbability = (e: any): number => {
      return computeEffectiveEdgeProbability(currentGraph, e.id, currentOverrides, currentWhatIfAnalysis);
    };
    
    if (edgeScalingMode === 'uniform') {
      return 10;
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
      return finalWidth;
    }
    
    if (edgeScalingMode === 'global-mass') {
      // Global mass: scale based on residual probability as graph is traversed from start
      // Find the start node (node with entry.is_start = true or entry.entry_weight > 0)
      const startNode = allNodes.find(n => 
        n.data?.entry?.is_start === true || (n.data?.entry?.entry_weight || 0) > 0
      );
      
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
      return finalWidth;
    }
    
    if (edgeScalingMode === 'global-log-mass') {
      // Global Log Mass: same as global-mass but with logarithmic transformation
      // Find the start node (node with entry.is_start = true or entry.entry_weight > 0)
      const startNode = allNodes.find(n => 
        n.data?.entry?.is_start === true || (n.data?.entry?.entry_weight || 0) > 0
      );
      
      if (!startNode) {
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
  }, [edgeScalingMode, logMassTransform]);

  // Calculate edge sort keys for curved edge stacking
  // For Bézier curves, sort by the angle/direction at which edges leave/enter the face
  const getEdgeSortKey = useCallback((sourceNode: any, targetNode: any, face: string, isSourceFace: boolean = true) => {
    if (!sourceNode || !targetNode) return [0, 0];

    const sourceX = sourceNode.position?.x || 0;
    const sourceY = sourceNode.position?.y || 0;
    const targetX = targetNode.position?.x || 0;
    const targetY = targetNode.position?.y || 0;

    // Calculate vector from source to target
    const dx = targetX - sourceX;
    const dy = targetY - sourceY;

    // For Bézier curves, approximate the control point direction
    // Default ReactFlow Bézier uses 25% of dx/dy as control point offset
    const controlFactor = 0.25;
    
    // Calculate the initial/final direction vector accounting for curve
    let directionAngle: number;
    
    if (isSourceFace) {
      // Source face: direction as edge LEAVES the node
      if (face === 'right') {
        // Right face: edges curve based on vertical offset
        // Sort by vertical component of initial direction
        directionAngle = Math.atan2(dy, Math.abs(dx)); // Angle from horizontal
      } else if (face === 'left') {
        directionAngle = Math.atan2(dy, -Math.abs(dx));
      } else if (face === 'bottom') {
        directionAngle = Math.atan2(Math.abs(dy), -dx); // Reversed for correct left-to-right order
      } else { // top
        directionAngle = Math.atan2(-Math.abs(dy), -dx); // Reversed for correct left-to-right order
      }
    } else {
      // Target face: direction as edge ENTERS the node
      if (face === 'left') {
        // Left face: edges arrive from the right
        directionAngle = Math.atan2(-dy, -Math.abs(dx));
      } else if (face === 'right') {
        directionAngle = Math.atan2(-dy, Math.abs(dx));
      } else if (face === 'top') {
        directionAngle = Math.atan2(-Math.abs(dy), -dx);
      } else { // bottom
        directionAngle = Math.atan2(Math.abs(dy), -dx);
      }
    }

    // Secondary sort by span for stability when angles are very close
    const span = Math.sqrt(dx * dx + dy * dy);

    return [directionAngle, -span];
  }, []);

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
      // Apply offsets for all modes including uniform (for Sankey-style visualization)
      // (Skip offsets only for modes that explicitly don't need them - currently none)

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

      // Sort by departure angle from this face (accounts for curve trajectory)
      const sortedSourceEdges = [...sameFaceSourceEdges].sort((a, b) => {
        const aTarget = allNodes.find(n => n.id === a.target);
        const bTarget = allNodes.find(n => n.id === b.target);
        if (!aTarget || !bTarget) return 0;
        
        const aKey = getEdgeSortKey(sourceNode, aTarget, sourceFace, true);
        const bKey = getEdgeSortKey(sourceNode, bTarget, sourceFace, true);
        
        // Compare [angle, span]
        if (aKey[0] !== bKey[0]) return aKey[0] - bKey[0];
        return aKey[1] - bKey[1];
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

      // Sort by arrival angle at this face (accounts for curve trajectory)
      const sortedTargetEdges = [...sameFaceTargetEdges].sort((a, b) => {
        const aSource = allNodes.find(n => n.id === a.source);
        const bSource = allNodes.find(n => n.id === b.source);
        if (!aSource || !bSource) return 0;
        
        const aKey = getEdgeSortKey(aSource, targetNode, targetFace, false);
        const bKey = getEdgeSortKey(bSource, targetNode, targetFace, false);
        
        // Compare [angle, span]
        if (aKey[0] !== bKey[0]) return aKey[0] - bKey[0];
        return aKey[1] - bKey[1];
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

      // Apply scaling for Global Log Mass
      let scaledWidth = edge.data?.calculateWidth ? edge.data.calculateWidth() : 2;
      if (edgeScalingMode === 'global-log-mass') {
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
  }, [edgeScalingMode, getEdgeSortKey]);

  // Track the last synced graph to detect real changes
  const lastSyncedGraphRef = useRef<string>('');
  const lastSyncedReactFlowRef = useRef<string>('');
  const isSyncingRef = useRef(false);
  const hasInitialFitViewRef = useRef(false);
  const currentGraphIdRef = useRef<string>('');
  
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
    // Allow execution if autoReroute is enabled OR if forceReroute is true
    if ((!autoReroute && !forceReroute) || !graph) {
      console.log('Auto re-route skipped:', { autoReroute, forceReroute, hasGraph: !!graph });
      return;
    }
    
    console.log('performAutoReroute executing:', { autoReroute, forceReroute });
    
    const currentPositions: { [nodeId: string]: { x: number; y: number } } = {};
    let movedNodes: string[] = [];
    
    // If forceReroute, re-route ALL edges
    if (forceReroute) {
      console.log('Force re-route: processing all nodes');
      movedNodes = nodes.map(n => n.id);
      nodes.forEach(node => {
        currentPositions[node.id] = { x: node.position.x, y: node.position.y };
      });
    } else {
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
  }, [autoReroute, forceReroute, graph, nodes, edges, calculateOptimalHandles, setGraph]);
  
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
    if ((shouldReroute > 0 && autoReroute) || forceReroute) {
      console.log('Re-route triggered:', { shouldReroute, autoReroute, forceReroute });
      // Add a small delay to ensure node positions are fully updated
      const timeoutId = setTimeout(() => {
        console.log('Executing delayed re-route after node movement');
        performAutoReroute();
        if (forceReroute) {
          setForceReroute(false); // Reset force flag after execution
        }
      }, 100); // 100ms delay after user finishes dragging
      
      return () => clearTimeout(timeoutId);
    }
  }, [shouldReroute, autoReroute, forceReroute, performAutoReroute]);
  
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
    if (!graph) return;
    
    const prevGraph = graph;
      
    // Check for slug uniqueness if slug is being updated
    if (data.slug) {
      const existingSlugs = getAllExistingSlugs(id);
      if (existingSlugs.includes(data.slug)) {
        alert(`Slug "${data.slug}" is already in use. Please choose a different slug.`);
        return;
      }
    }
    
    const nextGraph = structuredClone(prevGraph);
    const nodeIndex = nextGraph.nodes.findIndex(n => n.id === id);
    if (nodeIndex >= 0) {
      nextGraph.nodes[nodeIndex] = { ...nextGraph.nodes[nodeIndex], ...data };
      nextGraph.metadata.updated_at = new Date().toISOString();
      console.log('Updated node in graph:', nextGraph.nodes[nodeIndex]);
    }
    setGraph(nextGraph);
  }, [graph, setGraph, getAllExistingSlugs]);

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
      nextGraph.metadata = {
        version: "1.0.0",
        created_at: new Date().toISOString()
      };
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
    
    // Save history state for node deletion
    saveHistoryState('Delete node', id);
    
    // Clear selection when node is deleted
    onSelectedNodeChange(null);
  }, [graph, setGraph, onSelectedNodeChange, saveHistoryState]);

  const handleUpdateEdge = useCallback((id: string, data: any) => {
    if (!graph) return;
    
    const prevGraph = graph;
    
    // Check for slug uniqueness if slug is being updated
    if (data.slug) {
      const existingSlugs = getAllExistingSlugs(id);
      if (existingSlugs.includes(data.slug)) {
        alert(`Slug "${data.slug}" is already in use. Please choose a different slug.`);
        return;
      }
    }
    
    const nextGraph = structuredClone(prevGraph);
    const edgeIndex = nextGraph.edges.findIndex(e => e.id === id);
    if (edgeIndex >= 0) {
      nextGraph.edges[edgeIndex] = { ...nextGraph.edges[edgeIndex], ...data };
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    setGraph(nextGraph);
  }, [graph, setGraph, getAllExistingSlugs]);

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
      nextGraph.metadata = {
        version: "1.0.0",
        created_at: new Date().toISOString()
      };
    }
    nextGraph.metadata.updated_at = new Date().toISOString();
    
    // Clear the sync flag to allow graph->ReactFlow sync
    isSyncingRef.current = false;
    
    // Update the graph (this will trigger the graph->ReactFlow sync which will update lastSyncedGraphRef)
    setGraph(nextGraph);
    
    // Save history state for edge deletion
    saveHistoryState('Delete edge', undefined, id);
    
    // Clear selection when edge is deleted
    onSelectedEdgeChange(null);
  }, [graph, setGraph, onSelectedEdgeChange, saveHistoryState]);

  // Delete selected elements
  const deleteSelected = useCallback(() => {
    const selectedNodes = nodes.filter(n => n.selected);
    const selectedEdges = edges.filter(e => e.selected);
    
    console.log('deleteSelected called with:', selectedNodes.length, 'nodes and', selectedEdges.length, 'edges');
    
    // Save history state for bulk deletion
    if (selectedNodes.length > 0 || selectedEdges.length > 0) {
      saveHistoryState('Delete selected', undefined, undefined);
    }
    
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
  }, [nodes, edges, handleDeleteNode, handleDeleteEdge, saveHistoryState]);

  // Sync FROM graph TO ReactFlow when graph changes externally
  useEffect(() => {
    if (!graph) return;
    if (isSyncingRef.current) {
      return;
    }
    
    const graphJson = JSON.stringify(graph);
    if (graphJson === lastSyncedGraphRef.current) {
      return;
    }
    lastSyncedGraphRef.current = graphJson;
    
    // Preserve current selection state
    const selectedNodeIds = new Set(nodes.filter(n => n.selected).map(n => n.id));
    const selectedEdgeIds = new Set(edges.filter(e => e.selected).map(e => e.id));
    
    const { nodes: newNodes, edges: newEdges } = toFlow(graph, {
      onUpdateNode: handleUpdateNode,
      onDeleteNode: handleDeleteNode,
      onUpdateEdge: handleUpdateEdge,
      onDeleteEdge: handleDeleteEdge,
      onDoubleClickNode: onDoubleClickNode,
      onDoubleClickEdge: onDoubleClickEdge,
      onSelectEdge: onSelectEdge,
    });
    
    // Restore selection state
    const nodesWithSelection = newNodes.map(node => ({
      ...node,
      selected: selectedNodeIds.has(node.id)
    }));
    
    // Add edge width calculation to each edge
    const edgesWithWidth = newEdges.map(edge => {
      const isSelected = selectedEdgeIds.has(edge.id);
      return {
      ...edge,
        selected: isSelected,
        reconnectable: true, // Always true; CSS hides handles for unselected, callback rejects unselected
      data: {
        ...edge.data,
          calculateWidth: () => calculateEdgeWidth(edge, newEdges, nodesWithSelection)
      }
      };
    });
    
  // Calculate edge offsets for Sankey-style visualization
  const edgesWithOffsets = calculateEdgeOffsets(edgesWithWidth, nodesWithSelection, MAX_WIDTH);
  
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
    
    setNodes(nodesWithSelection);
    setEdges(edgesWithOffsetData);
  }, [graph, setNodes, setEdges, handleUpdateNode, handleDeleteNode, handleUpdateEdge, handleDeleteEdge, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, calculateEdgeWidth, calculateEdgeOffsets]);

  // Separate effect to handle initial fitView AFTER nodes are populated
  useEffect(() => {
    // Trigger fitView when we first have nodes and haven't done it yet
    if (!hasInitialFitViewRef.current && nodes.length > 0) {
      hasInitialFitViewRef.current = true;
      setTimeout(() => {
        console.log('Initial fitView after nodes populated:', nodes.length, 'nodes');
        fitView();
      }, 250);
    }
  }, [fitView]); // Removed nodes.length dependency
  
  // Reset fitView flag when graph changes (new file loaded)
  useEffect(() => {
    if (graph) {
      // Use a combination of metadata to detect graph changes
      const graphSignature = `${graph.metadata?.version || ''}_${graph.nodes?.length || 0}_${graph.edges?.length || 0}`;
      
      if (currentGraphIdRef.current !== graphSignature && graphSignature !== '_0_0') {
        console.log('New graph loaded, resetting fitView flag');
        hasInitialFitViewRef.current = false;
        currentGraphIdRef.current = graphSignature;
      }
    }
  }, [graph]);

  // Update edge widths when scaling mode changes
  useEffect(() => {
    if (edges.length === 0) return;
    
    console.log('Edge scaling mode changed to:', edgeScalingMode);
    
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
      const result = edgesWithOffsets.map(edge => ({
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
      
      console.log('Recalculated edge widths, sample edge scaledWidth:', result[0]?.data?.scaledWidth);
      return result;
    });
  }, [edgeScalingMode, calculateEdgeWidth, calculateEdgeOffsets, nodes, setEdges]);
  
  // Recalculate edge widths when what-if changes (separate effect to avoid loops)
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
  }, [overridesVersion, whatIfAnalysis, setEdges, calculateEdgeWidth, calculateEdgeOffsets, nodes]);
  
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
        return;
      }
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

  // Track pending reconnections to prevent race conditions
  const pendingReconnectionRef = useRef<string | null>(null);
  const reconnectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Handle edge reconnection (dragging edge to new source/target)
  // ReactFlow v11 uses onReconnect with signature: (oldEdge, newConnection)
  const onEdgeUpdate = useCallback((oldEdge: Edge, newConnection: Connection) => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════╗');
    console.log('║       EDGE RECONNECTION ATTEMPT                    ║');
    console.log('╚════════════════════════════════════════════════════╝');
    console.log('Old edge ID:', oldEdge.id);
    console.log('Old: from', oldEdge.source, 'to', oldEdge.target);
    console.log('Old handles:', oldEdge.sourceHandle, '→', oldEdge.targetHandle);
    console.log('');
    console.log('New: from', newConnection.source, 'to', newConnection.target);
    console.log('New handles:', newConnection.sourceHandle, '→', newConnection.targetHandle);
    console.log('Connection valid:', !!newConnection.source && !!newConnection.target);
    console.log('');
    
    // Clear any existing timeout for this edge
    if (reconnectionTimeoutRef.current) {
      clearTimeout(reconnectionTimeoutRef.current);
      reconnectionTimeoutRef.current = null;
    }
    
    // If this is an invalid connection, ignore it
    if (!newConnection.source || !newConnection.target) {
      console.log('❌ REJECTED: Invalid connection (missing source/target)');
      console.log('╚════════════════════════════════════════════════════╝');
      return;
    }
    
    // CRITICAL: Only allow reconnection if edge is selected
    if (!oldEdge.selected) {
      console.log('❌ REJECTED: Edge not selected');
      console.log('╚════════════════════════════════════════════════════╝');
      return;
    }
    
    if (!graph) {
      console.log('❌ REJECTED: No graph available');
      console.log('╚════════════════════════════════════════════════════╝');
      return;
    }
    
    // Check for valid connection
    if (!newConnection.source || !newConnection.target) {
      console.log('❌ REJECTED: Missing source or target');
      console.log('╚════════════════════════════════════════════════════╝');
      return;
    }
    
    // Additional check: if this is an invalid connection (no target), ignore it
    // This prevents ReactFlow from calling us with invalid connections when mouseup happens outside nodes
    if (newConnection.target === null || newConnection.target === undefined) {
      console.log('❌ REJECTED: Invalid target (null/undefined)');
      console.log('╚════════════════════════════════════════════════════╝');
      return;
    }
    
    // Prevent self-referencing edges (but allow changing the handle on same nodes)
    if (newConnection.source === newConnection.target && 
        oldEdge.source === oldEdge.target) {
      console.log('❌ REJECTED: Cannot connect node to itself');
      console.log('╚════════════════════════════════════════════════════╝');
      return;
    }
    
    // Check for circular dependencies ONLY if source or target changed
    const nodesChanged = oldEdge.source !== newConnection.source || oldEdge.target !== newConnection.target;
    if (nodesChanged) {
      const reactFlowEdges = graph.edges
        .filter(e => e.id !== oldEdge.id)
        .map(e => ({ source: e.from, target: e.to }));
      if (wouldCreateCycle(newConnection.source, newConnection.target, reactFlowEdges)) {
        console.log('❌ REJECTED: Would create cycle');
        console.log('╚════════════════════════════════════════════════════╝');
        alert('Cannot create this connection as it would create a circular dependency.');
        return;
      }
    }
    
    console.log('✅ VALIDATION PASSED - Debouncing reconnection...');
    
    // Debounce the reconnection to handle multiple rapid calls
    reconnectionTimeoutRef.current = setTimeout(() => {
      console.log('🔄 Processing debounced reconnection...');
      
      // Update the edge in graph state
      const nextGraph = structuredClone(graph);
      const edgeIndex = nextGraph.edges.findIndex((e: any) => e.id === oldEdge.id);
      
      if (edgeIndex === -1) {
        console.log('❌ ERROR: Edge not found in graph:', oldEdge.id);
        console.log('╚════════════════════════════════════════════════════╝');
        return;
      }
      
      const originalEdge = { ...nextGraph.edges[edgeIndex] };
      
      // Update edge source/target and handles (source and target are guaranteed non-null by earlier check)
      nextGraph.edges[edgeIndex].from = newConnection.source!;
      nextGraph.edges[edgeIndex].to = newConnection.target!;
      
      // Map handle IDs to match our node component
      // Source handles: "top" -> "top-out", "left" -> "left-out", etc.
      // Target handles: keep as-is ("top", "left", "right", "bottom")
      const sourceHandle = newConnection.sourceHandle ? 
        (newConnection.sourceHandle.endsWith('-out') ? newConnection.sourceHandle : `${newConnection.sourceHandle}-out`) : 
        undefined;
      const targetHandle = newConnection.targetHandle || undefined;
      
      nextGraph.edges[edgeIndex].fromHandle = sourceHandle;
      nextGraph.edges[edgeIndex].toHandle = targetHandle;
      
      // Generate new ID based on new source/target
      const newEdgeId = `${newConnection.source}->${newConnection.target}`;
      nextGraph.edges[edgeIndex].id = newEdgeId;
      
      if (nextGraph.metadata) {
        nextGraph.metadata.updated_at = new Date().toISOString();
      }
      
      console.log('');
      console.log('Updated edge:');
      console.log('  from:', originalEdge.from, '→', nextGraph.edges[edgeIndex].from);
      console.log('  to:', originalEdge.to, '→', nextGraph.edges[edgeIndex].to);
      console.log('  fromHandle:', originalEdge.fromHandle, '→', nextGraph.edges[edgeIndex].fromHandle);
      console.log('  toHandle:', originalEdge.toHandle, '→', nextGraph.edges[edgeIndex].toHandle);
      console.log('');
      console.log('✅ SUCCESS - Edge reconnected!');
      console.log('╚════════════════════════════════════════════════════╝');
      console.log('');
      
      setGraph(nextGraph);
      
      // Save history state for edge reconnection
      saveHistoryState('Reconnect edge', undefined, nextGraph.edges[edgeIndex].id);
    }, 50); // 50ms debounce
  }, [graph, setGraph, wouldCreateCycle, saveHistoryState]);

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
    
    // Map handle IDs to match our node component
    // Source handles: "top" -> "top-out", "left" -> "left-out", etc.
    // Target handles: keep as-is ("top", "left", "right", "bottom")
    const sourceHandle = connection.sourceHandle ? 
      (connection.sourceHandle.endsWith('-out') ? connection.sourceHandle : `${connection.sourceHandle}-out`) : 
      null;
    const targetHandle = connection.targetHandle || null;
    
    const newEdge: any = {
      id: edgeId,
      slug: edgeSlug,
      from: connection.source,
      to: connection.target,
      fromHandle: sourceHandle,
      toHandle: targetHandle,
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
    saveHistoryState('Add edge', undefined, edgeId);
    
    // Select the new edge after a brief delay to allow sync to complete
    setTimeout(() => {
      onSelectedEdgeChange(edgeId);
    }, 50);
  }, [graph, setGraph, generateEdgeSlug, wouldCreateCycle, onSelectedEdgeChange, saveHistoryState]);

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
      edge.case_id === sourceNode.case?.id &&
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
      from: pendingConnection.source!,
      to: pendingConnection.target!,
      fromHandle: pendingConnection.sourceHandle || undefined,
      toHandle: pendingConnection.targetHandle || undefined,
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
    saveHistoryState('Add edge', undefined, nextGraph.edges[nextGraph.edges.length - 1].id);
    
    // Close modal and clear state
    setShowVariantModal(false);
    setPendingConnection(null);
    setCaseNodeVariants([]);
  }, [pendingConnection, graph, setGraph, generateEdgeSlug, saveHistoryState]);
  
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
          console.log('Calling deleteSelected');
          deleteSelected();
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
    
    // Special case: 1 node - highlight upstream and downstream edges with depth-based fading
    if (selectedNodes.length === 1) {
      const selectedId = selectedNodes[0].id;
      const pathEdges = new Set<string>();
      
      // Helper to recursively find upstream edges with depth
      const findUpstreamEdges = (nodeId: string, depth: number, visited = new Set<string>()) => {
        if (visited.has(nodeId) || depth > 5) return;
        visited.add(nodeId);
        
        allEdges.forEach(edge => {
          if (edge.target === nodeId) {
            pathEdges.add(edge.id);
            findUpstreamEdges(edge.source, depth + 1, visited);
          }
        });
      };
      
      // Helper to recursively find downstream edges with depth
      const findDownstreamEdges = (nodeId: string, depth: number, visited = new Set<string>()) => {
        if (visited.has(nodeId) || depth > 5) return;
        visited.add(nodeId);
        
        allEdges.forEach(edge => {
          if (edge.source === nodeId) {
            pathEdges.add(edge.id);
            findDownstreamEdges(edge.target, depth + 1, visited);
          }
        });
      };
      
      // Find both upstream and downstream edges
      findUpstreamEdges(selectedId, 0);
      findDownstreamEdges(selectedId, 0);
      
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
    
      // Calculate highlight depths for single node selection
      const edgeDepthMap = new Map<string, number>();
      
      if (selectedNodesForAnalysis.length === 1) {
        const selectedId = selectedNodesForAnalysis[0].id;
        
        // Calculate upstream depths
        const calculateUpstreamDepths = (nodeId: string, depth: number, visited = new Set<string>()) => {
          if (visited.has(nodeId) || depth > 5) return;
          visited.add(nodeId);
          
          prevEdges.forEach(edge => {
            if (edge.target === nodeId) {
              const existingDepth = edgeDepthMap.get(edge.id);
              if (existingDepth === undefined || depth < existingDepth) {
                edgeDepthMap.set(edge.id, depth);
              }
              calculateUpstreamDepths(edge.source, depth + 1, visited);
            }
          });
        };
        
        // Calculate downstream depths
        const calculateDownstreamDepths = (nodeId: string, depth: number, visited = new Set<string>()) => {
          if (visited.has(nodeId) || depth > 5) return;
          visited.add(nodeId);
          
          prevEdges.forEach(edge => {
            if (edge.source === nodeId) {
              const existingDepth = edgeDepthMap.get(edge.id);
              if (existingDepth === undefined || depth < existingDepth) {
                edgeDepthMap.set(edge.id, depth);
              }
              calculateDownstreamDepths(edge.target, depth + 1, visited);
            }
          });
        };
        
        calculateUpstreamDepths(selectedId, 0);
        calculateDownstreamDepths(selectedId, 0);
      }
      
      const pathEdges = findPathEdges(selectedNodesForAnalysis, prevEdges);
      
      // Determine selection type: single node (40% fading) vs multi-node (60% solid)
      const isSingleNodeSelection = selectedNodesForAnalysis.length === 1;
      
      return prevEdges.map(edge => ({
        ...edge,
        // Always keep reconnectable true; CSS + callback enforce selection requirement
        reconnectable: true,
        data: {
          ...edge.data,
          isHighlighted: pathEdges.has(edge.id),
          highlightDepth: edgeDepthMap.get(edge.id) || 0,
          isSingleNodeHighlight: isSingleNodeSelection
        }
      }));
    });
  }, [selectedNodesForAnalysis, setEdges, findPathEdges, nodes]);

  // Calculate probability and cost for selected nodes
  const calculateSelectionAnalysis = useCallback(() => {
    if (selectedNodesForAnalysis.length === 0) return null;

    const selectedNodeIds = selectedNodesForAnalysis.map(n => n.id);
    
    // Helper function to find path through intermediate nodes using dagCalc logic
    // Now takes pre-computed pruning info to ensure consistency across segments
    const findPathThroughIntermediates = (
      startId: string, 
      endId: string, 
      givenVisitedNodeIds?: string[],
      prunedEdges?: Set<string>,
      renormFactors?: Map<string, number>
    ): { path: any[], probability: number, expectedCosts: any} => {
      const visited = new Set<string>();
      const costs: { [nodeId: string]: { monetary: number, time: number, units: string } } = {};
      
      // Get current state from store (avoid stale closures)
      const currentGraph = useGraphStore.getState().graph;
      const currentOverrides = useGraphStore.getState().whatIfOverrides;
      const currentWhatIfAnalysis = useGraphStore.getState().whatIfAnalysis;
      
      // Use pre-computed pruning if provided, otherwise no pruning
      const excludedEdges = prunedEdges || new Set<string>();
      const edgeRenormalizationFactors = renormFactors || new Map<string, number>();
      
      // Build set of nodes guaranteed to be visited in this path context
      const givenNodesSet = givenVisitedNodeIds ? new Set(givenVisitedNodeIds) : new Set<string>();
      
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
          let edgeProbability = computeEffectiveEdgeProbability(currentGraph, edge.id, currentOverrides, currentWhatIfAnalysis, edgePathContext);
          
          // Apply renormalization if siblings were pruned
          const renormFactor = edgeRenormalizationFactors.get(edge.id);
          if (renormFactor) {
            console.log(`APPLYING renorm to ${edge.id}: ${edgeProbability} * ${renormFactor} = ${edgeProbability * renormFactor}`);
            edgeProbability *= renormFactor;
            }
            
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
          let edgeProbability = computeEffectiveEdgeProbability(currentGraph, edge.id, currentOverrides, currentWhatIfAnalysis, edgePathContext);
          
          // Apply renormalization if siblings were pruned
          const renormFactor = edgeRenormalizationFactors.get(edge.id);
          if (renormFactor) {
            edgeProbability *= renormFactor;
          }
          
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
      
      console.log(`Path ${startId}→${endId} result: prob=${pathProbability}, excludedEdges=${excludedEdges.size}`);
        
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
      
      // No pruning for single node selection
      const pathAnalysis = findPathThroughIntermediates(startNode.id, selectedNode.id, [startNode.id, selectedNode.id], new Set(), new Map());
      
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
    
    // Special case: exactly 2 nodes selected
    if (selectedNodesForAnalysis.length === 2) {
      // First check if BOTH are end nodes - if so, show comparison instead of path
      const allAreEndNodes = selectedNodesForAnalysis.every(node => {
        const hasOutgoingEdges = edges.some(edge => edge.source === node.id);
        const isEndNode = node.data?.absorbing === true || !hasOutgoingEdges;
        console.log(`Multi-end check for ${node.data?.label || node.id}:`, { 
          absorbing: node.data?.absorbing, 
          hasOutgoingEdges, 
          isEndNode 
        });
        return isEndNode;
      });
      
      console.log(`Two nodes selected - both are end nodes?`, allAreEndNodes);
      
      if (allAreEndNodes) {
        // Show comparison of these two end nodes
        const startNodes = findStartNodes(nodes, edges);
        console.log(`Multi-end: found ${startNodes.length} start nodes`);
        if (startNodes.length > 0) {
          const startNode = startNodes[0];
          
          const endNodeProbabilities = selectedNodesForAnalysis.map(endNode => {
            const pathAnalysis = findPathThroughIntermediates(
              startNode.id, 
              endNode.id, 
              [startNode.id, endNode.id], 
              new Set(), 
              new Map()
            );
            
            return {
              node: endNode,
              probability: pathAnalysis.probability,
              expectedCosts: pathAnalysis.expectedCosts
            };
          });
          
          // Sort by probability descending
          endNodeProbabilities.sort((a, b) => b.probability - a.probability);
          
          const totalProbability = endNodeProbabilities.reduce((sum, item) => sum + item.probability, 0);
          
          console.log(`Multi-end result:`, { totalProbability, nodeCount: endNodeProbabilities.length });
          
          return {
            type: 'multi_end',
            endNodeProbabilities,
            totalProbability,
            startNode
          };
        }
      }
      
      // Otherwise, show standard 2-node path analysis
      console.log(`Two nodes selected - showing path analysis`);
    }
    
    // Standard 2-node path analysis (if not both end nodes)
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
      const currentWhatIfAnalysis2 = useGraphStore.getState().whatIfAnalysis;
      const currentGraph2 = useGraphStore.getState().graph;
      // Pass both nodes for graph pruning and conditional activation
      const pathContext = new Set([nodeA.id, nodeB.id]);
      let directPathProbability = directEdge ? computeEffectiveEdgeProbability(currentGraph2, directEdge.id, currentOverrides, currentWhatIfAnalysis2, pathContext) : 0;
      const directPathCosts = {
        monetary: directEdge?.data?.costs?.monetary?.value || 0,
        time: directEdge?.data?.costs?.time?.value || 0,
        units: directEdge?.data?.costs?.time?.units || ''
      };
      
      // Calculate path through intermediates using dagCalc logic
      // No pruning for 2-node selection (no intermediates to trigger pruning)
      const intermediatePath = findPathThroughIntermediates(nodeA.id, nodeB.id, [nodeA.id, nodeB.id], new Set(), new Map());
      
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
    
    // Helper: Compute graph pruning once for the entire path
    const computeGlobalPruning = (pathStart: string, pathEnd: string, allSelectedIds: string[]) => {
      const excludedEdges = new Set<string>();
      const renormFactors = new Map<string, number>();
      const impliedCaseOverrides = new Map<string, string>(); // case node ID → forced variant
      
      const currentGraph = useGraphStore.getState().graph;
      const currentOverrides = useGraphStore.getState().whatIfOverrides;
      const currentWhatIfAnalysis = useGraphStore.getState().whatIfAnalysis;
      
      // Interstitial nodes: all selected except path start and end
      const interstitialNodes = new Set(allSelectedIds.filter(id => id !== pathStart && id !== pathEnd));
      
      if (interstitialNodes.size === 0) return { excludedEdges, renormFactors };
      
      // Build sibling groups (case variants and regular edges)
      const siblingGroups = new Map<string, { parent: string, siblings: string[], caseId?: string }>();
      
      edges.forEach(edge => {
        if (edge.data?.case_id) {
          const key = `case_${edge.data.case_id}`;
          console.log(`Case edge: ${edge.id}, case_id=${edge.data.case_id}, target=${edge.target}`);
          if (!siblingGroups.has(key)) {
            siblingGroups.set(key, { parent: edge.source, siblings: [], caseId: edge.data.case_id });
          }
          if (!siblingGroups.get(key)!.siblings.includes(edge.target)) {
            siblingGroups.get(key)!.siblings.push(edge.target);
          }
        } else {
          const key = `parent_${edge.source}`;
          if (!siblingGroups.has(key)) {
            siblingGroups.set(key, { parent: edge.source, siblings: [] });
          }
          if (!siblingGroups.get(key)!.siblings.includes(edge.target)) {
            siblingGroups.get(key)!.siblings.push(edge.target);
          }
        }
      });
      
      // For each sibling group, prune and renormalize
      siblingGroups.forEach((group, key) => {
        if (group.siblings.length <= 1) return;
        
        const selectedSiblings = group.siblings.filter(id => interstitialNodes.has(id));
        
        console.log(`Group ${key}: siblings=[${group.siblings}], interstitial=${selectedSiblings.length}/${group.siblings.length}`);
        
        if (selectedSiblings.length > 0 && selectedSiblings.length < group.siblings.length) {
          const unselectedSiblings = group.siblings.filter(id => !interstitialNodes.has(id));
          
          const groupEdges = edges.filter(e => {
            if (group.caseId) {
              return e.data?.case_id === group.caseId && group.siblings.includes(e.target);
            } else {
              return e.source === group.parent && group.siblings.includes(e.target);
            }
          });
          
          let totalEffectiveProb = 0;
          let prunedEffectiveProb = 0;
          
          console.log(`  Calculating effective probs for ${key}:`);
          groupEdges.forEach(edge => {
            const effectiveProb = computeEffectiveEdgeProbability(currentGraph, edge.id, currentOverrides, currentWhatIfAnalysis);
            console.log(`    Edge ${edge.id}: effectiveProb=${effectiveProb}, target=${edge.target}, willPrune=${unselectedSiblings.includes(edge.target)}`);
            totalEffectiveProb += effectiveProb;
            
            if (unselectedSiblings.includes(edge.target)) {
              prunedEffectiveProb += effectiveProb;
              excludedEdges.add(edge.id);
            }
          });
          
          console.log(`  Total=${totalEffectiveProb}, Pruned=${prunedEffectiveProb}, Remaining=${totalEffectiveProb - prunedEffectiveProb}`);
          
          const remainingEffectiveProb = totalEffectiveProb - prunedEffectiveProb;
          if (remainingEffectiveProb > 0 && totalEffectiveProb > 0) {
            const renormFactor = totalEffectiveProb / remainingEffectiveProb;
            console.log(`  RENORM FACTOR = ${renormFactor}`);
            groupEdges.forEach(edge => {
              if (!excludedEdges.has(edge.id)) {
                renormFactors.set(edge.id, renormFactor);
              }
            });
          }
        }
      });
      
      return { excludedEdges, renormFactors };
    };
    
    // Special case: 3+ nodes - check if topologically sequential OR single start/end
    if (selectedNodesForAnalysis.length >= 3) {
      // First check if ALL are end nodes - if so, show comparison instead of path
      const allAreEndNodes = selectedNodesForAnalysis.every(node => {
        const hasOutgoingEdges = edges.some(edge => edge.source === node.id);
        const isEndNode = node.data?.absorbing === true || !hasOutgoingEdges;
        return isEndNode;
      });
      
      console.log(`${selectedNodesForAnalysis.length} nodes selected - all are end nodes?`, allAreEndNodes);
      
      if (allAreEndNodes) {
        // Show comparison of these end nodes
        const startNodes = findStartNodes(nodes, edges);
        if (startNodes.length > 0) {
          const startNode = startNodes[0];
          
          const endNodeProbabilities = selectedNodesForAnalysis.map(endNode => {
            const pathAnalysis = findPathThroughIntermediates(
              startNode.id, 
              endNode.id, 
              [startNode.id, endNode.id], 
              new Set(), 
              new Map()
            );
            
            return {
              node: endNode,
              probability: pathAnalysis.probability,
              expectedCosts: pathAnalysis.expectedCosts
            };
          });
          
          // Sort by probability descending
          endNodeProbabilities.sort((a, b) => b.probability - a.probability);
          
          const totalProbability = endNodeProbabilities.reduce((sum, item) => sum + item.probability, 0);
          
          return {
            type: 'multi_end',
            endNodeProbabilities,
            totalProbability,
            startNode
          };
        }
      }
      
      // Otherwise proceed with standard sequential path analysis
      const sortedNodeIds = topologicalSort(selectedNodeIds, edges);
      const isSequential = areNodesTopologicallySequential(sortedNodeIds, edges);
      
      // Check if there's a unique start and end based on topological sort
      // First node in sorted order = start, last node = end if it's absorbing
      const firstNodeId = sortedNodeIds[0];
      const lastNodeId = sortedNodeIds[sortedNodeIds.length - 1];
      const lastNode = selectedNodesForAnalysis.find(n => n.id === lastNodeId);
      
      const hasUniqueStartEnd = lastNode?.data?.absorbing === true;
      
      console.log(`3+ nodes check: isSequential=${isSequential}, first=${firstNodeId}, last=${lastNodeId}, lastIsAbsorbing=${lastNode?.data?.absorbing}, hasUniqueStartEnd=${hasUniqueStartEnd}`);
      
      if (isSequential || hasUniqueStartEnd) {
        // Path analysis from first to last through intermediate nodes (sequential or parallel)
        const firstNodeId = sortedNodeIds[0];
        const lastNodeId = sortedNodeIds[sortedNodeIds.length - 1];
        const intermediateIds = sortedNodeIds.slice(1, -1);
        
        const firstNode = selectedNodesForAnalysis.find(n => n.id === firstNodeId);
        const lastNode = selectedNodesForAnalysis.find(n => n.id === lastNodeId);
        
        // COMPUTE PRUNING ONCE for the entire path
        const { excludedEdges, renormFactors } = computeGlobalPruning(firstNodeId, lastNodeId, sortedNodeIds);
        
        console.log(`Global pruning: excluded=${excludedEdges.size}, renormFactors:`, Array.from(renormFactors.entries()));
        
        let totalProbability: number;
        let expectedCostsGivenPath: any;
        
        // ALWAYS calculate the full path in ONE traversal (not segments)
        // This ensures renormalized mass propagates correctly through the entire path
        const pathAnalysis = findPathThroughIntermediates(
          firstNodeId,
          lastNodeId,
          sortedNodeIds,
          excludedEdges,
          renormFactors
        );
        
        totalProbability = pathAnalysis.probability;
        expectedCostsGivenPath = {
          monetary: pathAnalysis.probability > 0 ? pathAnalysis.expectedCosts.monetary / pathAnalysis.probability : 0,
          time: pathAnalysis.probability > 0 ? pathAnalysis.expectedCosts.time / pathAnalysis.probability : 0,
          units: pathAnalysis.expectedCosts.units
        };
        
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
      nodes: selectedNodes.map((n: any) => n.id), 
      edges: selectedEdges.map((e: any) => e.id) 
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
  }, [onSelectedNodeChange, onSelectedEdgeChange, isLassoSelecting, setSelectedNodesForAnalysis]);

  // Add new node
  const addNode = useCallback(() => {
    console.log('addNode function called');
    if (!graph) return;
    
    const newId = crypto.randomUUID();
    
    // Generate initial label and slug
    const label = `Node ${graph.nodes.length + 1}`;
    const baseSlug = generateSlugFromLabel(label);
    
    // Get all existing slugs to ensure uniqueness from the graph state
    const existingSlugs = getAllExistingSlugs();
    const slug = generateUniqueSlug(baseSlug, existingSlugs);
    
    // Place node at center of current viewport
    const viewportCenter = screenToFlowPosition({ 
      x: window.innerWidth / 2, 
      y: window.innerHeight / 2 
    });
    
    // Add node directly to graph state (not ReactFlow state)
    const nextGraph = structuredClone(graph);
    nextGraph.nodes.push({
      id: newId,
      slug: slug,
      label: label,
      absorbing: false,
      layout: {
        x: viewportCenter.x,
        y: viewportCenter.y
      }
    });
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Update graph state - this will trigger graph->ReactFlow sync
    setGraph(nextGraph);
    console.log('saveHistoryState function:', typeof saveHistoryState);
    if (typeof saveHistoryState === 'function') {
      saveHistoryState('Add node', newId);
    } else {
      console.error('saveHistoryState is not a function:', saveHistoryState);
    }
    
    // Select the new node after a brief delay to allow sync to complete
    setTimeout(() => {
      onSelectedNodeChange(newId);
    }, 50);
  }, [graph, setGraph, generateSlugFromLabel, generateUniqueSlug, getAllExistingSlugs, onSelectedNodeChange, screenToFlowPosition, saveHistoryState]);

  // Expose addNode function to parent component via ref
  useEffect(() => {
    if (onAddNodeRef) {
      console.log('Setting addNodeRef.current to addNode function');
      onAddNodeRef.current = addNode;
    } else {
      console.log('onAddNodeRef is null');
    }
  }, [addNode, onAddNodeRef]);

  // Expose deleteSelected function to parent component via ref
  useEffect(() => {
    if (onDeleteSelectedRef) {
      onDeleteSelectedRef.current = deleteSelected;
    }
  }, [deleteSelected, onDeleteSelectedRef]);

  // Auto-layout function using dagre
  const performAutoLayout = useCallback((direction?: 'LR' | 'RL' | 'TB' | 'BT') => {
    if (!graph) return;
    
    // Use provided direction or fall back to state
    const effectiveDirection = direction || layoutDirection;
    
    // Determine which nodes to layout
    const selectedNodes = nodes.filter(n => n.selected);
    const nodesToLayout = selectedNodes.length > 0 ? selectedNodes : nodes;
    const nodeIdsToLayout = new Set(nodesToLayout.map(n => n.id));
    
    if (nodesToLayout.length === 0) return;
    
    // Create a new dagre graph
    const dagreGraph = new dagre.graphlib.Graph();
    dagreGraph.setDefaultEdgeLabel(() => ({}));
    
    // Configure layout direction and spacing
    dagreGraph.setGraph({ 
      rankdir: effectiveDirection, // User-selected direction
      nodesep: 80,   // Spacing between nodes in same rank
      ranksep: 200,  // Spacing between ranks
      marginx: 50,
      marginy: 50,
    });
    
    // Add nodes to dagre graph
    nodesToLayout.forEach((node) => {
      // Node dimensions (approximate)
      const width = node.data?.type === 'case' ? 96 : 100;
      const height = node.data?.type === 'case' ? 96 : 100;
      dagreGraph.setNode(node.id, { width, height });
    });
    
    // Add edges to dagre graph (only edges between nodes being laid out)
    edges.forEach((edge) => {
      if (nodeIdsToLayout.has(edge.source) && nodeIdsToLayout.has(edge.target)) {
        dagreGraph.setEdge(edge.source, edge.target);
      }
    });
    
    // Run the layout algorithm
    dagre.layout(dagreGraph);
    
    // Apply the layout to the graph
    const nextGraph = structuredClone(graph);
    dagreGraph.nodes().forEach((nodeId) => {
      const dagreNode = dagreGraph.node(nodeId);
      const graphNode = nextGraph.nodes.find((n: any) => n.id === nodeId);
      
      if (graphNode) {
        if (!graphNode.layout) graphNode.layout = {};
        // Dagre gives us center coordinates, so no need to adjust
        graphNode.layout.x = dagreNode.x;
        graphNode.layout.y = dagreNode.y;
      }
    });
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Update graph - this will trigger sync
    setGraph(nextGraph);
    
    // Save history state for auto-layout
    saveHistoryState('Auto-layout', undefined, undefined);
    
    // ALWAYS trigger re-route after layout (regardless of autoReroute setting)
    setTimeout(() => {
      console.log('Triggering FORCED re-route after auto-layout');
      setForceReroute(true); // Force re-route even if autoReroute is off
      
      // Fit view after re-route completes
      setTimeout(() => {
        fitView({ padding: 0.1, duration: 400 });
      }, 200);
    }, 150);
  }, [graph, setGraph, nodes, edges, layoutDirection, fitView, saveHistoryState]);

  // Auto-layout function that can be called from parent
  const triggerAutoLayout = useCallback((direction: 'LR' | 'RL' | 'TB' | 'BT') => {
    setLayoutDirection(direction);
    // Pass direction directly to performAutoLayout (don't wait for state to update)
    performAutoLayout(direction);
  }, [performAutoLayout]);

  // Expose auto-layout function to parent component via ref
  useEffect(() => {
    if (onAutoLayoutRef) {
      onAutoLayoutRef.current = triggerAutoLayout;
    }
  }, [triggerAutoLayout, onAutoLayoutRef]);


  // Handle canvas right-click for context menu
  const onPaneContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    
    // Get the flow position (position in the canvas coordinate system)
    const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      flowX: flowPosition.x,
      flowY: flowPosition.y
    });
  }, [screenToFlowPosition]);

  // Close context menus on any click
  useEffect(() => {
    if (contextMenu || nodeContextMenu || edgeContextMenu) {
      const handleClick = () => {
        setContextMenu(null);
        setNodeContextMenu(null);
        setEdgeContextMenu(null);
        setContextMenuLocalData(null);
      };
      // Delay adding the listener to avoid catching the same click that opened the menu
      const timeoutId = setTimeout(() => {
        document.addEventListener('click', handleClick);
      }, 0);
      
      return () => {
        clearTimeout(timeoutId);
        document.removeEventListener('click', handleClick);
      };
    }
  }, [contextMenu, nodeContextMenu, edgeContextMenu]);

  // Add node at specific position
  const addNodeAtPosition = useCallback((x: number, y: number) => {
    if (!graph) return;
    
    const slug = `node-${Date.now()}`;
    const label = `Node ${graph.nodes.length + 1}`;
    
    const newNode = {
      id: crypto.randomUUID(),
      slug: slug,
      label: label,
      absorbing: false,
      layout: {
        x: x,
        y: y
      }
    };
    
    const nextGraph = structuredClone(graph);
    nextGraph.nodes.push(newNode);
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    setGraph(nextGraph);
    console.log('saveHistoryState in addNodeAtPosition:', typeof saveHistoryState, saveHistoryState);
    if (typeof saveHistoryState === 'function') {
      saveHistoryState('Add node', newNode.id);
    } else {
      console.error('saveHistoryState is not a function in addNodeAtPosition:', saveHistoryState);
    }
    setContextMenu(null);
  }, [graph, setGraph, saveHistoryState]);

  // Handle node right-click
  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: any) => {
    event.preventDefault();
    event.stopPropagation();
    
    setNodeContextMenu({
      x: event.clientX,
      y: event.clientY,
      nodeId: node.id
    });
  }, []);

  // Handle edge right-click
  const onEdgeContextMenu = useCallback((event: React.MouseEvent, edge: any) => {
    event.preventDefault();
    event.stopPropagation();
    
    const edgeData = graph?.edges?.find((e: any) => e.id === edge.id);
    setEdgeContextMenu({
      x: event.clientX,
      y: event.clientY,
      edgeId: edge.id
    });
    setContextMenuLocalData({
      probability: edgeData?.p?.mean || 0,
      conditionalProbabilities: {},
      variantWeight: 0
    });
  }, []);

  // Delete specific node
  const deleteNode = useCallback((nodeId: string) => {
    if (!graph) return;
    
    const nextGraph = structuredClone(graph);
    nextGraph.nodes = nextGraph.nodes.filter(n => n.id !== nodeId);
    nextGraph.edges = nextGraph.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    setGraph(nextGraph);
    setNodeContextMenu(null);
  }, [graph, setGraph]);

  // Delete specific edge
  const deleteEdge = useCallback((edgeId: string) => {
    if (!graph) return;
    
    const nextGraph = structuredClone(graph);
    nextGraph.edges = nextGraph.edges.filter(e => e.id !== edgeId);
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    setGraph(nextGraph);
    setEdgeContextMenu(null);
  }, [graph, setGraph]);

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
        onReconnect={onEdgeUpdate}
        onSelectionChange={onSelectionChange}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        fitView
        selectionOnDrag={false}
        selectNodesOnDrag={false}
        selectionKeyCode={['Meta', 'Ctrl']}
        nodesDraggable
        nodesConnectable
        elementsSelectable
        reconnectRadius={50}
        edgeUpdaterRadius={80}
        onlyRenderVisibleElements={false}
        panOnDrag={!isLassoSelecting}
        connectionRadius={50}
        snapToGrid={false}
        snapGrid={[1, 1]}
        style={{ background: '#f8fafc' }}
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
                {analysis.type === 'path' || analysis.type === 'path_sequential' || analysis.type === 'single' || analysis.type === 'multi_end' ? 'Path Analysis' : 'Selection Analysis'}
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
                      
                      {(analysis.pathProbability !== undefined && analysis.pathProbability > 0) ? (
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
                  
                  {(analysis.pathProbability !== undefined && analysis.pathProbability > 0) ? (
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
                  
                  {(analysis.pathProbability !== undefined && analysis.pathProbability > 0) ? (
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
              ) : analysis.type === 'multi_end' ? (
                // Multiple end nodes selected - show probability mass comparison
                <>
                  <div style={{ marginBottom: '12px' }}>
                    <strong>End Node Comparison</strong>
                    <div style={{ color: '#666', fontSize: '12px', marginTop: '2px' }}>
                      From: {analysis.startNode?.data?.label || 'Start'}
                    </div>
                  </div>
                  
                  <div style={{ marginBottom: '12px' }}>
                    <div style={{ fontSize: '12px', color: '#666', marginBottom: '6px' }}>
                      Probability mass reaching each end node:
                    </div>
                    {(analysis.endNodeProbabilities || []).map((item: any, idx: number) => {
                      const percentage = item.probability * 100;
                      const barWidth = (analysis.totalProbability || 0) > 0 
                        ? (item.probability / (analysis.totalProbability || 1)) * 100 
                        : 0;
                      
                      // Get outcome type color
                      const outcomeType = item.node.data?.outcome_type;
                      let barColor = '#6b7280'; // default gray
                      if (outcomeType === 'success') barColor = '#16a34a'; // green
                      else if (outcomeType === 'failure') barColor = '#dc2626'; // red
                      else if (outcomeType === 'abandoned') barColor = '#ea580c'; // orange
                      
                      return (
                        <div key={item.node.id} style={{ marginBottom: '8px' }}>
                          <div style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            justifyContent: 'space-between',
                            fontSize: '11px',
                            marginBottom: '2px'
                          }}>
                            <span style={{ fontWeight: 500 }}>
                              {item.node.data?.label || item.node.id}
                            </span>
                            <span style={{ color: '#666' }}>
                              {percentage.toFixed(2)}%
                            </span>
                          </div>
                          <div style={{ 
                            width: '100%', 
                            height: '20px', 
                            background: '#f3f4f6',
                            borderRadius: '3px',
                            overflow: 'hidden',
                            position: 'relative'
                          }}>
                            <div style={{ 
                              width: `${barWidth}%`, 
                              height: '100%', 
                              background: barColor,
                              transition: 'width 0.3s ease',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: 'white',
                              fontSize: '10px',
                              fontWeight: 600
                            }}>
                              {barWidth > 15 && `${barWidth.toFixed(0)}%`}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  
                  {(analysis.totalProbability || 0) < 0.99 && (
                    <div style={{ fontSize: '11px', color: '#666', marginTop: '8px' }}>
                      ℹ️ Remaining {((1 - (analysis.totalProbability || 0)) * 100).toFixed(1)}% flows to other outcomes
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
      
      {/* Context Menu */}
      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            background: 'white',
            border: '1px solid #ddd',
            borderRadius: '4px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            minWidth: '160px',
            padding: '4px',
            zIndex: 10000
          }}
        >
          <div
            onClick={(e) => {
              e.stopPropagation();
              addNodeAtPosition(contextMenu.flowX, contextMenu.flowY);
            }}
            style={{
              padding: '8px 12px',
              cursor: 'pointer',
              fontSize: '13px',
              color: '#333',
              borderRadius: '2px'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
          >
            ➕ Add node
          </div>
        </div>
      )}
      
      {/* Node Context Menu */}
      {nodeContextMenu && (
        <div
          style={{
            position: 'fixed',
            left: nodeContextMenu.x,
            top: nodeContextMenu.y,
            background: 'white',
            border: '1px solid #ddd',
            borderRadius: '4px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            minWidth: '160px',
            padding: '4px',
            zIndex: 10000
          }}
        >
          <div
            onClick={(e) => {
              e.stopPropagation();
              deleteNode(nodeContextMenu.nodeId);
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
            🗑️ Delete node
          </div>
        </div>
      )}
      
      {/* Edge Context Menu */}
      {edgeContextMenu && (
        <div
          style={{
            position: 'fixed',
            left: edgeContextMenu.x,
            top: edgeContextMenu.y,
            background: 'white',
            border: '1px solid #ddd',
            borderRadius: '4px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            minWidth: '200px',
            padding: '8px',
            zIndex: 10000
          }}
        >
          {/* Probability editing section */}
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', marginBottom: '4px', color: '#333' }}>
              Probability
            </label>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.01"
                value={contextMenuLocalData?.probability || 0}
                onChange={(e) => {
                  const value = parseFloat(e.target.value) || 0;
                  // Update local state immediately for responsive input
                  setContextMenuLocalData(prev => prev ? { ...prev, probability: value } : null);
                  
                  // Debounce only the expensive graph update
                  clearTimeout((window as any).contextMenuNumberTimeout);
                  (window as any).contextMenuNumberTimeout = setTimeout(() => {
                    if (graph) {
                      const nextGraph = structuredClone(graph);
                      const edgeIndex = nextGraph.edges.findIndex((e: any) => e.id === edgeContextMenu.edgeId);
                      if (edgeIndex >= 0) {
                        nextGraph.edges[edgeIndex].p = { ...nextGraph.edges[edgeIndex].p, mean: value };
                        
                        if (nextGraph.metadata) {
                          nextGraph.metadata.updated_at = new Date().toISOString();
                        }
                        setGraph(nextGraph);
                      }
                    }
                  }, 250);
                }}
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                        style={{
                          width: '60px',
                          padding: '4px',
                          border: '1px solid #ddd',
                          borderRadius: '3px',
                          fontSize: '11px'
                        }}
                      />
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={contextMenuLocalData?.probability || 0}
                onChange={(e) => {
                  const value = parseFloat(e.target.value);
                  // Update local state immediately for smooth slider movement
                  setContextMenuLocalData(prev => prev ? { ...prev, probability: value } : null);
                  
                  // Debounce only the expensive graph update
                  clearTimeout((window as any).contextMenuSliderTimeout);
                  (window as any).contextMenuSliderTimeout = setTimeout(() => {
                    if (graph) {
                      const nextGraph = structuredClone(graph);
                      const edgeIndex = nextGraph.edges.findIndex((e: any) => e.id === edgeContextMenu.edgeId);
                      if (edgeIndex >= 0) {
                        nextGraph.edges[edgeIndex].p = { ...nextGraph.edges[edgeIndex].p, mean: value };
                        
                        if (nextGraph.metadata) {
                          nextGraph.metadata.updated_at = new Date().toISOString();
                        }
                        setGraph(nextGraph);
                      }
                    }
                  }, 250);
                }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onMouseUp={(e) => e.stopPropagation()}
                style={{
                  flex: 1,
                  height: '4px',
                  background: '#ddd',
                  outline: 'none',
                  borderRadius: '2px'
                }}
              />
                <span style={{ fontSize: '10px', color: '#666', minWidth: '25px' }}>
                  {((contextMenuLocalData?.probability || 0) * 100).toFixed(0)}%
                </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!graph) return;
                  const currentEdge = graph.edges.find((e: any) => e.id === edgeContextMenu.edgeId);
                  if (!currentEdge) return;
                  
                  const siblings = graph.edges.filter((e: any) => {
                    // For case edges, only balance within the same variant
                    if (currentEdge.case_id && currentEdge.case_variant) {
                      return e.id !== currentEdge.id && 
                             e.from === currentEdge.from && 
                             e.case_id === currentEdge.case_id && 
                             e.case_variant === currentEdge.case_variant;
                    }
                    // For regular edges, balance all edges from same source
                    return e.id !== currentEdge.id && e.from === currentEdge.from;
                  });
                  
                  if (siblings.length > 0) {
                    const nextGraph = structuredClone(graph);
                    const currentValue = currentEdge.p?.mean || 0;
                    const remainingProbability = 1 - currentValue;
                    
                    // Calculate total current probability of siblings
                    const siblingsTotal = siblings.reduce((sum, sibling) => sum + (sibling.p?.mean || 0), 0);
                    
                    if (siblingsTotal > 0) {
                      // Rebalance siblings proportionally
                      siblings.forEach(sibling => {
                        const siblingIndex = nextGraph.edges.findIndex((e: any) => e.id === sibling.id);
                        if (siblingIndex >= 0) {
                          const siblingCurrentValue = sibling.p?.mean || 0;
                          const newValue = (siblingCurrentValue / siblingsTotal) * remainingProbability;
                          nextGraph.edges[siblingIndex].p = { ...nextGraph.edges[siblingIndex].p, mean: newValue };
                        }
                      });
                    } else {
                      // If siblings have no probability, distribute equally
                      const equalShare = remainingProbability / siblings.length;
                      siblings.forEach(sibling => {
                        const siblingIndex = nextGraph.edges.findIndex((e: any) => e.id === sibling.id);
                        if (siblingIndex >= 0) {
                          nextGraph.edges[siblingIndex].p = { ...nextGraph.edges[siblingIndex].p, mean: equalShare };
                        }
                      });
                    }
                    
                    if (nextGraph.metadata) {
                      nextGraph.metadata.updated_at = new Date().toISOString();
                    }
                    setGraph(nextGraph);
                    saveHistoryState('Balance probabilities', undefined, currentEdge.id);
                  }
                }}
                style={{
                  padding: '2px 4px',
                  fontSize: '9px',
                  backgroundColor: (() => {
                    if (!graph) return '#f8f9fa';
                    const currentEdge = graph.edges.find((e: any) => e.id === edgeContextMenu.edgeId);
                    if (!currentEdge) return '#f8f9fa';
                    
                    const siblings = graph.edges.filter((e: any) => {
                      // For case edges, only balance within the same variant
                      if (currentEdge.case_id && currentEdge.case_variant) {
                        return e.id !== currentEdge.id && 
                               e.from === currentEdge.from && 
                               e.case_id === currentEdge.case_id && 
                               e.case_variant === currentEdge.case_variant;
                      }
                      // For regular edges, balance all edges from same source
                      return e.id !== currentEdge.id && e.from === currentEdge.from;
                    });
                    
                    if (siblings.length === 0) return '#f8f9fa';
                    
                    // Calculate total probability mass
                    const currentValue = currentEdge.p?.mean || 0;
                    const siblingsTotal = siblings.reduce((sum, sibling) => sum + (sibling.p?.mean || 0), 0);
                    const totalMass = currentValue + siblingsTotal;
                    
                    // Light up if total mass is not close to 1.0
                    return Math.abs(totalMass - 1.0) > 0.01 ? '#fff3cd' : '#f8f9fa';
                  })(),
                  border: (() => {
                    if (!graph) return '1px solid #ddd';
                    const currentEdge = graph.edges.find((e: any) => e.id === edgeContextMenu.edgeId);
                    if (!currentEdge) return '1px solid #ddd';
                    
                    const siblings = graph.edges.filter((e: any) => {
                      // For case edges, only balance within the same variant
                      if (currentEdge.case_id && currentEdge.case_variant) {
                        return e.id !== currentEdge.id && 
                               e.from === currentEdge.from && 
                               e.case_id === currentEdge.case_id && 
                               e.case_variant === currentEdge.case_variant;
                      }
                      // For regular edges, balance all edges from same source
                      return e.id !== currentEdge.id && e.from === currentEdge.from;
                    });
                    
                    if (siblings.length === 0) return '1px solid #ddd';
                    
                    // Calculate total probability mass
                    const currentValue = currentEdge.p?.mean || 0;
                    const siblingsTotal = siblings.reduce((sum, sibling) => sum + (sibling.p?.mean || 0), 0);
                    const totalMass = currentValue + siblingsTotal;
                    
                    // Light up if total mass is not close to 1.0
                    return Math.abs(totalMass - 1.0) > 0.01 ? '1px solid #ffc107' : '1px solid #ddd';
                  })(),
                  borderRadius: '2px',
                  cursor: 'pointer',
                  color: (() => {
                    if (!graph) return '#666';
                    const currentEdge = graph.edges.find((e: any) => e.id === edgeContextMenu.edgeId);
                    if (!currentEdge) return '#666';
                    
                    const siblings = graph.edges.filter((e: any) => {
                      // For case edges, only balance within the same variant
                      if (currentEdge.case_id && currentEdge.case_variant) {
                        return e.id !== currentEdge.id && 
                               e.from === currentEdge.from && 
                               e.case_id === currentEdge.case_id && 
                               e.case_variant === currentEdge.case_variant;
                      }
                      // For regular edges, balance all edges from same source
                      return e.id !== currentEdge.id && e.from === currentEdge.from;
                    });
                    
                    if (siblings.length === 0) return '#666';
                    
                    // Calculate total probability mass
                    const currentValue = currentEdge.p?.mean || 0;
                    const siblingsTotal = siblings.reduce((sum, sibling) => sum + (sibling.p?.mean || 0), 0);
                    const totalMass = currentValue + siblingsTotal;
                    
                    // Light up if total mass is not close to 1.0
                    return Math.abs(totalMass - 1.0) > 0.01 ? '#856404' : '#666';
                  })()
                }}
                title="Rebalance sibling edges proportionally"
              >
                ⚖️
              </button>
            </div>
          </div>

          {/* Conditional Probability editing section */}
          {(() => {
            const edge = graph?.edges?.find((e: any) => e.id === edgeContextMenu.edgeId);
            return edge?.conditional_p && edge.conditional_p.length > 0;
          })() && (
            <div style={{ marginBottom: '12px' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', marginBottom: '4px', color: '#333' }}>
                Conditional Probabilities
              </label>
              {(() => {
                const edge = graph?.edges?.find((e: any) => e.id === edgeContextMenu.edgeId);
                return edge?.conditional_p?.map((condP: any, index: number) => (
                  <div key={index} style={{ marginBottom: '8px', padding: '6px', border: '1px solid #eee', borderRadius: '3px' }}>
                    <div style={{ fontSize: '10px', color: '#666', marginBottom: '4px' }}>
                      Condition: {condP.condition.visited.join(', ') || 'None'}
                    </div>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.01"
                        value={condP.p.mean}
                        onChange={(e) => {
                          const value = parseFloat(e.target.value) || 0;
                          if (graph) {
                            const nextGraph = structuredClone(graph);
                            const edgeIndex = nextGraph.edges.findIndex((e: any) => e.id === edgeContextMenu.edgeId);
                            if (edgeIndex >= 0 && nextGraph.edges[edgeIndex].conditional_p) {
                              nextGraph.edges[edgeIndex].conditional_p[index].p.mean = value;
                              
                              if (nextGraph.metadata) {
                                nextGraph.metadata.updated_at = new Date().toISOString();
                              }
                              setGraph(nextGraph);
                            }
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                        style={{
                          width: '50px',
                          padding: '3px',
                          border: '1px solid #ddd',
                          borderRadius: '2px',
                          fontSize: '10px'
                        }}
                      />
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={condP.p.mean}
                        onChange={(e) => {
                          const value = parseFloat(e.target.value);
                          // Debounce the expensive graph update
                          clearTimeout((window as any).contextMenuConditionalSliderTimeout);
                          (window as any).contextMenuConditionalSliderTimeout = setTimeout(() => {
                            if (graph) {
                              const nextGraph = structuredClone(graph);
                              const edgeIndex = nextGraph.edges.findIndex((e: any) => e.id === edgeContextMenu.edgeId);
                            if (edgeIndex >= 0 && nextGraph.edges[edgeIndex].conditional_p) {
                              nextGraph.edges[edgeIndex].conditional_p[index].p.mean = value;
                                
                                if (nextGraph.metadata) {
                                  nextGraph.metadata.updated_at = new Date().toISOString();
                                }
                                setGraph(nextGraph);
                              }
                            }
                          }, 250);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                        onMouseUp={(e) => e.stopPropagation()}
                        style={{
                          flex: 1,
                          height: '3px',
                          background: '#ddd',
                          outline: 'none',
                          borderRadius: '2px'
                        }}
                      />
                      <span style={{ fontSize: '9px', color: '#666', minWidth: '20px' }}>
                        {(condP.p.mean * 100).toFixed(0)}%
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!graph) return;
                          const currentEdge = graph.edges.find((e: any) => e.id === edgeContextMenu.edgeId);
                          if (!currentEdge) return;
                          
                          const siblings = graph.edges.filter((e: any) => {
                            // For case edges, only balance within the same variant
                            if (currentEdge.case_id && currentEdge.case_variant) {
                              return e.id !== currentEdge.id && 
                                     e.from === currentEdge.from && 
                                     e.case_id === currentEdge.case_id && 
                                     e.case_variant === currentEdge.case_variant;
                            }
                            // For regular edges, balance all edges from same source
                            return e.id !== currentEdge.id && e.from === currentEdge.from;
                          });
                          
                          if (siblings.length > 0) {
                            const nextGraph = structuredClone(graph);
                            const currentValue = condP.p.mean;
                            const remainingProbability = 1 - currentValue;
                            
                            // Calculate total current probability of siblings for this condition
                            const conditionKey = JSON.stringify(condP.condition.visited.sort());
                            const siblingsWithSameCondition = siblings.filter(sibling => {
                              if (!sibling.conditional_p) return false;
                              return sibling.conditional_p.some((cp: any) => 
                                JSON.stringify(cp.condition.visited.sort()) === conditionKey
                              );
                            });
                            
                            if (siblingsWithSameCondition.length > 0) {
                              // Calculate total current probability of siblings for this condition
                              const siblingsTotal = siblingsWithSameCondition.reduce((sum, sibling) => {
                                const matchingCondition = sibling.conditional_p?.find((cp: any) => 
                                  JSON.stringify(cp.condition.visited.sort()) === conditionKey
                                );
                                return sum + (matchingCondition?.p?.mean || 0);
                              }, 0);
                              
                              if (siblingsTotal > 0) {
                                // Rebalance siblings proportionally for this condition
                                siblingsWithSameCondition.forEach(sibling => {
                                  const siblingIndex = nextGraph.edges.findIndex((e: any) => e.id === sibling.id);
                                  if (siblingIndex >= 0) {
                                    const matchingCondition = sibling.conditional_p?.find((cp: any) => 
                                      JSON.stringify(cp.condition.visited.sort()) === conditionKey
                                    );
                                    if (matchingCondition) {
                                      const conditionIndex = sibling.conditional_p?.findIndex((cp: any) => 
                                        JSON.stringify(cp.condition.visited.sort()) === conditionKey
                                      );
                                      if (conditionIndex !== undefined && conditionIndex >= 0 && nextGraph.edges[siblingIndex].conditional_p) {
                                        const siblingCurrentValue = matchingCondition.p?.mean || 0;
                                        const newValue = (siblingCurrentValue / siblingsTotal) * remainingProbability;
                                        nextGraph.edges[siblingIndex].conditional_p[conditionIndex].p.mean = newValue;
                                      }
                                    }
                                  }
                                });
                              } else {
                                // If siblings have no probability for this condition, distribute equally
                                const equalShare = remainingProbability / siblingsWithSameCondition.length;
                                siblingsWithSameCondition.forEach(sibling => {
                                  const siblingIndex = nextGraph.edges.findIndex((e: any) => e.id === sibling.id);
                                  if (siblingIndex >= 0) {
                                    const matchingCondition = sibling.conditional_p?.find((cp: any) => 
                                      JSON.stringify(cp.condition.visited.sort()) === conditionKey
                                    );
                                    if (matchingCondition) {
                                      const conditionIndex = sibling.conditional_p?.findIndex((cp: any) => 
                                        JSON.stringify(cp.condition.visited.sort()) === conditionKey
                                      );
                                      if (conditionIndex !== undefined && conditionIndex >= 0 && nextGraph.edges[siblingIndex].conditional_p) {
                                        nextGraph.edges[siblingIndex].conditional_p[conditionIndex].p.mean = equalShare;
                                      }
                                    }
                                  }
                                });
                              }
                            }
                            
                            if (nextGraph.metadata) {
                              nextGraph.metadata.updated_at = new Date().toISOString();
                            }
                            setGraph(nextGraph);
                            saveHistoryState('Balance conditional probabilities', undefined, currentEdge.id);
                          }
                        }}
                        style={{
                          padding: '1px 3px',
                          fontSize: '8px',
                          backgroundColor: (() => {
                            if (!graph) return '#f8f9fa';
                            const currentEdge = graph.edges.find((e: any) => e.id === edgeContextMenu.edgeId);
                            if (!currentEdge) return '#f8f9fa';
                            
                            const siblings = graph.edges.filter((e: any) => {
                              // For case edges, only balance within the same variant
                              if (currentEdge.case_id && currentEdge.case_variant) {
                                return e.id !== currentEdge.id && 
                                       e.from === currentEdge.from && 
                                       e.case_id === currentEdge.case_id && 
                                       e.case_variant === currentEdge.case_variant;
                              }
                              // For regular edges, balance all edges from same source
                              return e.id !== currentEdge.id && e.from === currentEdge.from;
                            });
                            
                            if (siblings.length === 0) return '#f8f9fa';
                            
                            // Calculate total probability mass for this condition
                            const conditionKey = JSON.stringify(condP.condition.visited.sort());
                            const currentValue = condP.p.mean;
                            const siblingsTotal = siblings.reduce((sum, sibling) => {
                              if (!sibling.conditional_p) return sum;
                              const matchingCondition = sibling.conditional_p.find((cp: any) => 
                                JSON.stringify(cp.condition.visited.sort()) === conditionKey
                              );
                              return sum + (matchingCondition?.p?.mean || 0);
                            }, 0);
                            const totalMass = currentValue + siblingsTotal;
                            
                            // Light up if total mass is not close to 1.0
                            return Math.abs(totalMass - 1.0) > 0.01 ? '#fff3cd' : '#f8f9fa';
                          })(),
                          border: (() => {
                            if (!graph) return '1px solid #ddd';
                            const currentEdge = graph.edges.find((e: any) => e.id === edgeContextMenu.edgeId);
                            if (!currentEdge) return '1px solid #ddd';
                            
                            const siblings = graph.edges.filter((e: any) => {
                              // For case edges, only balance within the same variant
                              if (currentEdge.case_id && currentEdge.case_variant) {
                                return e.id !== currentEdge.id && 
                                       e.from === currentEdge.from && 
                                       e.case_id === currentEdge.case_id && 
                                       e.case_variant === currentEdge.case_variant;
                              }
                              // For regular edges, balance all edges from same source
                              return e.id !== currentEdge.id && e.from === currentEdge.from;
                            });
                            
                            if (siblings.length === 0) return '1px solid #ddd';
                            
                            // Calculate total probability mass for this condition
                            const conditionKey = JSON.stringify(condP.condition.visited.sort());
                            const currentValue = condP.p.mean;
                            const siblingsTotal = siblings.reduce((sum, sibling) => {
                              if (!sibling.conditional_p) return sum;
                              const matchingCondition = sibling.conditional_p.find((cp: any) => 
                                JSON.stringify(cp.condition.visited.sort()) === conditionKey
                              );
                              return sum + (matchingCondition?.p?.mean || 0);
                            }, 0);
                            const totalMass = currentValue + siblingsTotal;
                            
                            // Light up if total mass is not close to 1.0
                            return Math.abs(totalMass - 1.0) > 0.01 ? '1px solid #ffc107' : '1px solid #ddd';
                          })(),
                          borderRadius: '2px',
                          cursor: 'pointer',
                          color: (() => {
                            if (!graph) return '#666';
                            const currentEdge = graph.edges.find((e: any) => e.id === edgeContextMenu.edgeId);
                            if (!currentEdge) return '#666';
                            
                            const siblings = graph.edges.filter((e: any) => {
                              // For case edges, only balance within the same variant
                              if (currentEdge.case_id && currentEdge.case_variant) {
                                return e.id !== currentEdge.id && 
                                       e.from === currentEdge.from && 
                                       e.case_id === currentEdge.case_id && 
                                       e.case_variant === currentEdge.case_variant;
                              }
                              // For regular edges, balance all edges from same source
                              return e.id !== currentEdge.id && e.from === currentEdge.from;
                            });
                            
                            if (siblings.length === 0) return '#666';
                            
                            // Calculate total probability mass for this condition
                            const conditionKey = JSON.stringify(condP.condition.visited.sort());
                            const currentValue = condP.p.mean;
                            const siblingsTotal = siblings.reduce((sum, sibling) => {
                              if (!sibling.conditional_p) return sum;
                              const matchingCondition = sibling.conditional_p.find((cp: any) => 
                                JSON.stringify(cp.condition.visited.sort()) === conditionKey
                              );
                              return sum + (matchingCondition?.p?.mean || 0);
                            }, 0);
                            const totalMass = currentValue + siblingsTotal;
                            
                            // Light up if total mass is not close to 1.0
                            return Math.abs(totalMass - 1.0) > 0.01 ? '#856404' : '#666';
                          })()
                        }}
                        title="Rebalance sibling conditional probabilities for this condition"
                      >
                        ⚖️
                      </button>
                    </div>
                  </div>
                ));
              })()}
            </div>
          )}

          {/* Variant Weight editing for case edges */}
          {(() => {
            const edge = graph?.edges?.find((e: any) => e.id === edgeContextMenu.edgeId);
            return edge?.case_id && edge?.case_variant;
          })() && (() => {
            const edge = graph?.edges?.find((e: any) => e.id === edgeContextMenu.edgeId);
            const caseNode = graph?.nodes?.find((n: any) => n.case?.id === edge?.case_id);
            const variant = caseNode?.case?.variants?.find((v: any) => v.name === edge?.case_variant);
            return variant && (
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', marginBottom: '4px', color: '#333' }}>
                  Variant Weight ({edge?.case_variant})
                </label>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={variant.weight}
                    onChange={(e) => {
                      const value = parseFloat(e.target.value) || 0;
                      if (graph) {
                        const nextGraph = structuredClone(graph);
                        const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.case?.id === edge?.case_id);
                        if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
                          const variantIndex = nextGraph.nodes[nodeIndex].case.variants.findIndex((v: any) => v.name === edge?.case_variant);
                          if (variantIndex >= 0) {
                            nextGraph.nodes[nodeIndex].case.variants[variantIndex].weight = value;
                            
                            if (nextGraph.metadata) {
                              nextGraph.metadata.updated_at = new Date().toISOString();
                            }
                            setGraph(nextGraph);
                          }
                        }
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    style={{
                      width: '60px',
                      padding: '4px',
                      border: '1px solid #ddd',
                      borderRadius: '3px',
                      fontSize: '11px'
                    }}
                  />
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={variant.weight}
                    onChange={(e) => {
                      const value = parseFloat(e.target.value);
                      // Debounce the expensive graph update
                      clearTimeout((window as any).contextMenuVariantSliderTimeout);
                      (window as any).contextMenuVariantSliderTimeout = setTimeout(() => {
                        if (graph) {
                          const nextGraph = structuredClone(graph);
                        const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.case?.id === edge?.case_id);
                        if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
                          const variantIndex = nextGraph.nodes[nodeIndex].case.variants.findIndex((v: any) => v.name === edge?.case_variant);
                          if (variantIndex >= 0) {
                            nextGraph.nodes[nodeIndex].case.variants[variantIndex].weight = value;
                              
                              if (nextGraph.metadata) {
                                nextGraph.metadata.updated_at = new Date().toISOString();
                              }
                              setGraph(nextGraph);
                            }
                          }
                        }
                      }, 250);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onMouseUp={(e) => e.stopPropagation()}
                    style={{
                      flex: 1,
                      height: '4px',
                      background: '#ddd',
                      outline: 'none',
                      borderRadius: '2px'
                    }}
                  />
                  <span style={{ fontSize: '10px', color: '#666', minWidth: '25px' }}>
                    {(variant.weight * 100).toFixed(0)}%
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!graph) return;
                      const caseNode = graph.nodes.find((n: any) => n.case?.id === edge?.case_id);
                      if (!caseNode?.case?.variants) return;
                      
                      const nextGraph = structuredClone(graph);
                      const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.case?.id === edge?.case_id);
                      if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
                        const currentWeight = variant.weight;
                        const remainingWeight = 1 - currentWeight;
                        const otherVariants = caseNode.case.variants.filter((v: any) => v.name !== edge?.case_variant);
                        
                        if (otherVariants.length > 0) {
                          // Calculate total current weight of other variants
                          const othersTotal = otherVariants.reduce((sum, v) => sum + v.weight, 0);
                          
                          if (othersTotal > 0) {
                            // Rebalance other variants proportionally
                            otherVariants.forEach((otherVariant) => {
                              const variantIndex = nextGraph.nodes[nodeIndex].case?.variants?.findIndex((v: any) => v.name === otherVariant.name);
                              if (variantIndex !== undefined && variantIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
                                const newWeight = (otherVariant.weight / othersTotal) * remainingWeight;
                                nextGraph.nodes[nodeIndex].case.variants[variantIndex].weight = newWeight;
                              }
                            });
                          } else {
                            // If other variants have no weight, distribute equally
                            const equalShare = remainingWeight / otherVariants.length;
                            otherVariants.forEach((otherVariant) => {
                              const variantIndex = nextGraph.nodes[nodeIndex].case?.variants?.findIndex((v: any) => v.name === otherVariant.name);
                              if (variantIndex !== undefined && variantIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
                                nextGraph.nodes[nodeIndex].case.variants[variantIndex].weight = equalShare;
                              }
                            });
                          }
                          
                          if (nextGraph.metadata) {
                            nextGraph.metadata.updated_at = new Date().toISOString();
                          }
                          setGraph(nextGraph);
                          saveHistoryState('Balance variant weights', nodeContextMenu?.nodeId);
                        }
                      }
                    }}
                    style={{
                      padding: '2px 4px',
                      fontSize: '9px',
                      backgroundColor: (() => {
                        if (!graph) return '#f8f9fa';
                        const caseNode = graph.nodes.find((n: any) => n.case?.id === edge?.case_id);
                        if (!caseNode?.case?.variants) return '#f8f9fa';
                        
                        const totalWeight = caseNode.case.variants.reduce((sum, v) => sum + v.weight, 0);
                        // Light up if total weight is not close to 1.0
                        return Math.abs(totalWeight - 1.0) > 0.01 ? '#fff3cd' : '#f8f9fa';
                      })(),
                      border: (() => {
                        if (!graph) return '1px solid #ddd';
                        const caseNode = graph.nodes.find((n: any) => n.case?.id === edge?.case_id);
                        if (!caseNode?.case?.variants) return '1px solid #ddd';
                        
                        const totalWeight = caseNode.case.variants.reduce((sum, v) => sum + v.weight, 0);
                        // Light up if total weight is not close to 1.0
                        return Math.abs(totalWeight - 1.0) > 0.01 ? '1px solid #ffc107' : '1px solid #ddd';
                      })(),
                      borderRadius: '2px',
                      cursor: 'pointer',
                      color: (() => {
                        if (!graph) return '#666';
                        const caseNode = graph.nodes.find((n: any) => n.case?.id === edge?.case_id);
                        if (!caseNode?.case?.variants) return '#666';
                        
                        const totalWeight = caseNode.case.variants.reduce((sum, v) => sum + v.weight, 0);
                        // Light up if total weight is not close to 1.0
                        return Math.abs(totalWeight - 1.0) > 0.01 ? '#856404' : '#666';
                      })()
                    }}
                    title="Rebalance variant weights proportionally"
                  >
                    ⚖️
                  </button>
                </div>
              </div>
            );
          })()}
          
          {/* Delete option */}
          <div
            onClick={(e) => {
              e.stopPropagation();
              deleteEdge(edgeContextMenu.edgeId);
            }}
            style={{
              padding: '8px 12px',
              cursor: 'pointer',
              fontSize: '13px',
              color: '#dc3545',
              borderRadius: '2px',
              borderTop: '1px solid #eee',
              marginTop: '8px'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
          >
            🗑️ Delete edge
          </div>
        </div>
      )}
      
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
