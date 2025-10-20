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
import LayoutConfirmationModal from './LayoutConfirmationModal';
import { useGraphStore } from '@/lib/useGraphStore';
import { toFlow, fromFlow } from '@/lib/transform';
import { generateSlugFromLabel, generateUniqueSlug } from '@/lib/slugUtils';
import { applyAutoLayout, type LayoutOptions } from '@/lib/layout';

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
  const { deleteElements, fitView, screenToFlowPosition, setCenter, getNodes } = useReactFlow();
  
  // ReactFlow maintains local state for smooth interactions
  const [nodes, setNodes, onNodesChangeBase] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  
  // Trigger flag for re-routing
  const [shouldReroute, setShouldReroute] = useState(0);
  
  // Layout state
  const [showLayoutConfirmModal, setShowLayoutConfirmModal] = useState(false);
  const [layoutHistory, setLayoutHistory] = useState<{ 
    nodes: Node[]; 
    edges: Edge[];
    graph: any; // Save graph state too for complete undo
  } | null>(null);
  const [showLayoutDropdown, setShowLayoutDropdown] = useState(false);
  
  // Custom onNodesChange handler to detect position changes for auto re-routing
  const onNodesChange = useCallback((changes: any[]) => {
    // onNodesChange called
    
    // Call the base handler first
    onNodesChangeBase(changes);
    
    // Check if any position changes occurred (when user finishes dragging)
    if (autoReroute) {
      const positionChanges = changes.filter(change => change.type === 'position' && change.dragging === false);
      // Filtered position changes
      if (positionChanges.length > 0) {
        // Position changes detected (dragging finished)
        // Trigger re-routing by incrementing the flag
        setShouldReroute(prev => {
          // shouldReroute incrementing
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
    
    // calculateEdgeWidth called
    
    // Helper function to get effective probability (handles case edges and what-if analysis)
    const getEffectiveProbability = (e: any) => {
      // For case edges, multiply variant weight by sub-route probability
      if (e.data?.case_id && e.data?.case_variant) {
        const caseNode = allNodes.find((n: any) => n.data?.case?.id === e.data.case_id);
        const variant = caseNode?.data?.case?.variants?.find((v: any) => v.name === e.data.case_variant);
        let variantWeight = variant?.weight || 0;
        
        // Apply what-if analysis override
        if (whatIfAnalysis && whatIfAnalysis.caseNodeId === caseNode?.id) {
          variantWeight = e.data.case_variant === whatIfAnalysis.selectedVariant ? 1.0 : 0.0;
        }
        
        const subRouteProbability = e.data?.probability || 1.0; // Default to 1.0 for single-path
        return variantWeight * subRouteProbability;
      }
      // For normal edges, use the probability from edge data
      return e.data?.probability || 0;
    };
    
    if (edgeScalingMode === 'uniform') {
      // Use a standard width for all edges, with slight increase for selected edges
      return edge.selected ? 12 : 10;
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
      
      // Local mass edge calculation
      return finalWidth;
    }
    
    if (edgeScalingMode === 'global-mass') {
      // Global mass: scale based on residual probability as graph is traversed from start
      // Find the start node (node with entry.is_start = true or entry.entry_weight > 0)
      const startNode = allNodes.find(n => 
        n.data?.entry?.is_start === true || (n.data?.entry?.entry_weight || 0) > 0
      );
      
      // Global mass mode
      
      if (!startNode) {
        // No start node found, falling back to local mass
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
      
      // Global mass edge calculation
      return finalWidth;
    }
    
    if (edgeScalingMode === 'global-log-mass') {
      // Global Log Mass: same as global-mass but with logarithmic transformation
      // Find the start node (node with entry.is_start = true or entry.entry_weight > 0)
      const startNode = allNodes.find(n => 
        n.data?.entry?.is_start === true || (n.data?.entry?.entry_weight || 0) > 0
      );
      
      // Global log mass mode
      
      if (!startNode) {
        // No start node found, falling back to local mass
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
      
      // Global log mass edge calculation
      return finalWidth;
    }
    
    // Helper function to calculate residual probability
    function calculateResidualProbability(targetNode: string, allEdges: any[], startNode: string): number {
      // Build adjacency list and reverse adjacency list
      const outgoing: { [key: string]: any[] } = {};
      const incoming: { [key: string]: any[] } = {};
      allEdges.forEach(e => {
        if (!outgoing[e.source]) outgoing[e.source] = [];
        if (!incoming[e.target]) incoming[e.target] = [];
        outgoing[e.source].push(e);
        incoming[e.target].push(e);
      });
      
      // Use topological sort to calculate residual probability at each node
      const residualAtNode: { [key: string]: number } = {};
      const visited = new Set<string>();
      
      function dfs(node: string): number {
        if (visited.has(node)) {
          return residualAtNode[node] || 0;
        }
        visited.add(node);
        
        // If this is the start node, residual is 1.0
        if (node === startNode) {
          residualAtNode[node] = 1.0;
          return 1.0;
        }
        
        // Sum up probability mass from all incoming edges
        let totalIncoming = 0;
        const incomingEdges = incoming[node] || [];
        incomingEdges.forEach(edge => {
          const sourceResidual = dfs(edge.source);
          const edgeProbability = getEffectiveProbability(edge);
          totalIncoming += sourceResidual * edgeProbability;
        });
        
        residualAtNode[node] = totalIncoming;
        return totalIncoming;
      }
      
      // Calculate residual for target node
      return dfs(targetNode);
    }
    
    return edge.selected ? 3 : 2;
  }, [edgeScalingMode, logMassTransform, whatIfAnalysis]);

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
      // Only apply offsets for mass-based scaling modes and uniform mode
      if (!['local-mass', 'global-mass', 'global-log-mass', 'uniform'].includes(edgeScalingMode)) {
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

      // Sort edges from this face by the ANGLE/DIRECTION they're heading
      const sortedSourceEdges = [...sameFaceSourceEdges].sort((a, b) => {
        const aTarget = allNodes.find(n => n.id === a.target);
        const bTarget = allNodes.find(n => n.id === b.target);
        if (!aTarget || !bTarget) return 0;
        
        // Get source node dimensions
        const sourceWidth = (sourceNode.data as any)?.type === 'case' ? 96 : 120;
        const sourceHeight = (sourceNode.data as any)?.type === 'case' ? 96 : 120;
        const sourceCenterX = sourceNode.position.x + sourceWidth / 2;
        const sourceCenterY = sourceNode.position.y + sourceHeight / 2;
        
        // Get target node dimensions and centers
        const aTargetWidth = (aTarget.data as any)?.type === 'case' ? 96 : 120;
        const aTargetHeight = (aTarget.data as any)?.type === 'case' ? 96 : 120;
        const aTargetCenterX = (aTarget.position?.x || 0) + aTargetWidth / 2;
        const aTargetCenterY = (aTarget.position?.y || 0) + aTargetHeight / 2;
        
        const bTargetWidth = (bTarget.data as any)?.type === 'case' ? 96 : 120;
        const bTargetHeight = (bTarget.data as any)?.type === 'case' ? 96 : 120;
        const bTargetCenterX = (bTarget.position?.x || 0) + bTargetWidth / 2;
        const bTargetCenterY = (bTarget.position?.y || 0) + bTargetHeight / 2;
        
        // Calculate direction vectors from source to target
        const aDx = aTargetCenterX - sourceCenterX;
        const aDy = aTargetCenterY - sourceCenterY;
        const bDx = bTargetCenterX - sourceCenterX;
        const bDy = bTargetCenterY - sourceCenterY;
        
        // For left/right faces: sort by angle (more upward = higher in stack)
        // Use atan2 to get angle, or just compare dy/dx ratios
        if (sourceFace === 'left' || sourceFace === 'right') {
          // Sort by the angle: atan2(dy, dx)
          // More negative dy (upward) should be on top
          // For same dy, more outward (dx magnitude) goes higher
          const aAngle = Math.atan2(aDy, Math.abs(aDx));
          const bAngle = Math.atan2(bDy, Math.abs(bDx));
          return aAngle - bAngle; // Lower angle (more upward) = higher in stack
        } else {
          // For top/bottom faces: sort by angle in X direction
          // More negative dx (leftward) should be on left
          const aAngle = Math.atan2(aDx, Math.abs(aDy));
          const bAngle = Math.atan2(bDx, Math.abs(bDy));
          return aAngle - bAngle; // Lower angle (more leftward) = left in stack
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

      // Sort edges to this target face by the ANGLE/DIRECTION they're arriving from
      const sortedTargetEdges = [...sameFaceTargetEdges].sort((a, b) => {
        const aSource = allNodes.find(n => n.id === a.source);
        const bSource = allNodes.find(n => n.id === b.source);
        if (!aSource || !bSource) return 0;
        
        // Get target node dimensions
        const targetWidth = (targetNode.data as any)?.type === 'case' ? 96 : 120;
        const targetHeight = (targetNode.data as any)?.type === 'case' ? 96 : 120;
        const targetCenterX = targetNode.position.x + targetWidth / 2;
        const targetCenterY = targetNode.position.y + targetHeight / 2;
        
        // Get source node dimensions and centers
        const aSourceWidth = (aSource.data as any)?.type === 'case' ? 96 : 120;
        const aSourceHeight = (aSource.data as any)?.type === 'case' ? 96 : 120;
        const aSourceCenterX = (aSource.position?.x || 0) + aSourceWidth / 2;
        const aSourceCenterY = (aSource.position?.y || 0) + aSourceHeight / 2;
        
        const bSourceWidth = (bSource.data as any)?.type === 'case' ? 96 : 120;
        const bSourceHeight = (bSource.data as any)?.type === 'case' ? 96 : 120;
        const bSourceCenterX = (bSource.position?.x || 0) + bSourceWidth / 2;
        const bSourceCenterY = (bSource.position?.y || 0) + bSourceHeight / 2;
        
        // Calculate direction vectors from source to target (arriving direction)
        const aDx = targetCenterX - aSourceCenterX;
        const aDy = targetCenterY - aSourceCenterY;
        const bDx = targetCenterX - bSourceCenterX;
        const bDy = targetCenterY - bSourceCenterY;
        
        // For left/right target faces: sort by angle of arrival
        if (targetFace === 'left' || targetFace === 'right') {
          // Sort by the angle: atan2(dy, dx)
          // Edges arriving from above (source y < target y, positive dy) should be on top
          const aAngle = Math.atan2(aDy, Math.abs(aDx));
          const bAngle = Math.atan2(bDy, Math.abs(bDx));
          return bAngle - aAngle; // REVERSED: Higher angle (from above) = higher in stack
        } else {
          // For top/bottom target faces: sort by angle in X direction
          // Edges arriving from left (source x < target x, positive dx) should be on left
          const aAngle = Math.atan2(aDx, Math.abs(aDy));
          const bAngle = Math.atan2(bDx, Math.abs(bDy));
          return bAngle - aAngle; // REVERSED: Higher angle (from left) = left in stack
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
        
        // Edge offset calculation
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
  }, [edgeScalingMode, nodes, edges]);

  // Track the last synced graph to detect real changes
  const lastSyncedGraphRef = useRef<string>('');
  const isSyncingRef = useRef(false);
  const isAutoReroutingRef = useRef(false);
  const lastEdgeScalingUpdateRef = useRef<string>('');
  
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
      // No graph, skipping immediate re-route
      return;
    }
    
    // Performing immediate re-route of ALL edges
    
    const nextGraph = structuredClone(graph);
    let updatedCount = 0;
    
    // Re-route ALL edges
    nextGraph.edges.forEach((graphEdge: any) => {
      const sourceNode = nodes.find(n => n.id === graphEdge.from);
      const targetNode = nodes.find(n => n.id === graphEdge.to);
      
      if (sourceNode && targetNode) {
        const { sourceHandle, targetHandle } = calculateOptimalHandles(sourceNode, targetNode);
        
        // Re-routing edge
        
        graphEdge.fromHandle = sourceHandle;
        graphEdge.toHandle = targetHandle;
        updatedCount++;
      }
    });
    
    // Updated edges
    
    if (updatedCount > 0) {
      if (nextGraph.metadata) {
        nextGraph.metadata.updated_at = new Date().toISOString();
      }
      
      // Updating graph with immediate re-route changes
      isAutoReroutingRef.current = true;
      setGraph(nextGraph);
      
      // Reset the flag after a short delay
      setTimeout(() => {
        isAutoReroutingRef.current = false;
      }, 50);
    }
  }, [graph, nodes, calculateOptimalHandles, setGraph]);
  
  // Auto re-route edges when nodes move
  const performAutoReroute = useCallback((forceReroute = false) => {
    if (!autoReroute || !graph) {
      // Auto re-route skipped
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
        // Node moved
      }
    });
    
    if (movedNodes.length === 0 && !forceReroute) {
      // No nodes moved, skipping re-route
      return;
    }
    
    // Moved nodes
    
    // Update last positions
    lastNodePositionsRef.current = currentPositions;
    
    // Find edges that need re-routing
    let edgesToReroute;
    if (forceReroute) {
      // When forcing re-route (e.g., after graph changes), re-route ALL edges
      edgesToReroute = edges;
      // Force re-routing ALL edges
    } else {
      // Normal case: only re-route edges connected to moved nodes
      edgesToReroute = edges.filter(edge => 
        movedNodes.includes(edge.source) || movedNodes.includes(edge.target)
      );
      // Edges to re-route
    }
    
    if (edgesToReroute.length === 0) return;
    
    // Update graph with new handle positions
    const nextGraph = structuredClone(graph);
    
    edgesToReroute.forEach(edge => {
      const sourceNode = nodes.find(n => n.id === edge.source);
      const targetNode = nodes.find(n => n.id === edge.target);
      
      if (sourceNode && targetNode) {
        const { sourceHandle, targetHandle } = calculateOptimalHandles(sourceNode, targetNode);
        
        // Re-routing edge
        
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
    
    // Updating graph with new handle positions
    isAutoReroutingRef.current = true;
    setGraph(nextGraph);
    
    // Reset the flag after a short delay
    setTimeout(() => {
      isAutoReroutingRef.current = false;
    }, 50);
  }, [autoReroute, graph, nodes, edges, calculateOptimalHandles, setGraph]);
  
  // Reset position tracking and perform immediate re-route when autoReroute is toggled ON
  useEffect(() => {
    // Auto re-route toggled
    if (autoReroute) {
      // Initialize position tracking when enabling
      // Initializing position tracking and performing immediate re-route
      const initialPositions: { [nodeId: string]: { x: number; y: number } } = {};
      nodes.forEach(node => {
        initialPositions[node.id] = { x: node.position.x, y: node.position.y };
      });
      lastNodePositionsRef.current = initialPositions;
      
      // Perform immediate re-route when toggling on (with a small delay to ensure state is ready)
      // Triggering immediate re-route on toggle
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
      // Re-route triggered by flag change
      // Add a small delay to ensure node positions are fully updated
      const timeoutId = setTimeout(() => {
        // Executing delayed re-route after node movement
        performAutoReroute();
      }, 100); // 100ms delay after user finishes dragging
      
      return () => clearTimeout(timeoutId);
    }
  }, [shouldReroute, autoReroute, performAutoReroute]);

  // Auto-reroute when graph changes (edges added/removed, etc.)
  useEffect(() => {
    // Skip if auto-reroute is off, no graph, or if this change was caused by auto-reroute itself
    if (!autoReroute || !graph || isAutoReroutingRef.current) {
      return;
    }
    
    // Add a small delay to ensure the graph changes are fully processed
    const timeoutId = setTimeout(() => {
      performAutoReroute(true); // Force re-route even if no nodes moved
    }, 200); // 200ms delay after graph changes
    
    return () => clearTimeout(timeoutId);
  }, [graph, autoReroute]);
  
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
    // handleUpdateNode called
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
        // Updated node in graph
      }
      return nextGraph;
    });
  }, [setGraph, getAllExistingSlugs]);

  const handleDeleteNode = useCallback((id: string) => {
    // Deleting node
    
    if (!graph) {
      // No graph, aborting delete
      return;
    }
    
    // Before delete
    
    const nextGraph = structuredClone(graph);
    nextGraph.nodes = nextGraph.nodes.filter(n => n.id !== id);
    nextGraph.edges = nextGraph.edges.filter(e => e.from !== id && e.to !== id);
    
    // Ensure metadata exists and update it
    if (!nextGraph.metadata) {
      nextGraph.metadata = {};
    }
    nextGraph.metadata.updated_at = new Date().toISOString();
    
    // After delete
    
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
    // Deleting edge
    
    if (!graph) {
      // No graph, aborting delete
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

  const handleReconnectEdge = useCallback((id: string, newSource?: string, newTarget?: string, newTargetHandle?: string, newSourceHandle?: string) => {
    // console.log('=== RECONNECTING EDGE ===', { id, newSource, newTarget, newTargetHandle, newSourceHandle });
    
    if (!graph) {
      // console.log('No graph, aborting reconnect');
      return;
    }
    
    const nextGraph = structuredClone(graph);
    const edgeIndex = nextGraph.edges.findIndex(e => e.id === id);
    
    if (edgeIndex === -1) {
      // console.log('Edge not found:', id);
      return;
    }
    
    const edge = nextGraph.edges[edgeIndex];
    const oldFrom = edge.from;
    const oldTo = edge.to;
    
    // Update source if provided
    if (newSource) {
      if (newSource !== edge.from) {
        // console.log(`Changing source from ${edge.from} to ${newSource}`);
        edge.from = newSource;
      }
      
      // Update source handle if provided
      if (newSourceHandle) {
        edge.fromHandle = `${newSourceHandle}-out`;
        // console.log(`Setting fromHandle to ${edge.fromHandle}`);
      }
    }
    
    // Update target if provided
    if (newTarget) {
      if (newTarget !== edge.to) {
        // console.log(`Changing target from ${edge.to} to ${newTarget}`);
        edge.to = newTarget;
      }
      
      // Update target handle if provided
      if (newTargetHandle) {
        edge.toHandle = newTargetHandle;
        // console.log(`Setting toHandle to ${edge.toHandle}`);
      }
    }
    
    // Check if connection actually changed (node or handle)
    const sourceChanged = newSource && (newSource !== oldFrom || newSourceHandle);
    const targetChanged = newTarget && (newTarget !== oldTo || newTargetHandle);
    
    if (!sourceChanged && !targetChanged) {
      // console.log('No change in edge connection');
      return;
    }
    
    // Generate new ID that avoids conflicts
    let newId = `${edge.from}->${edge.to}`;
    let counter = 1;
    
    // Check if edge with this ID already exists (excluding the current edge)
    while (nextGraph.edges.some((e, idx) => e.id === newId && idx !== edgeIndex)) {
      newId = `${edge.from}->${edge.to}-${counter}`;
      counter++;
    }
    
    // console.log(`Updating edge ID from ${edge.id} to ${newId}`);
    edge.id = newId;
    
    // Ensure metadata exists and update it
    if (!nextGraph.metadata) {
      nextGraph.metadata = {};
    }
    nextGraph.metadata.updated_at = new Date().toISOString();
    
    // Clear the sync flag to allow graph->ReactFlow sync
    isSyncingRef.current = false;
    
    // Update the graph (this will trigger the graph->ReactFlow sync which will update lastSyncedGraphRef)
    setGraph(nextGraph);
    
    // console.log('Edge reconnected successfully');
  }, [graph, setGraph]);

  // Delete selected elements
  const deleteSelected = useCallback(() => {
    const selectedNodes = nodes.filter(n => n.selected);
    const selectedEdges = edges.filter(e => e.selected);
    
    // console.log('deleteSelected called with:', selectedNodes.length, 'nodes and', selectedEdges.length, 'edges');
    
    // Delete selected nodes (which will cascade delete their edges)
    selectedNodes.forEach(node => {
      // console.log('Deleting node:', node.id);
      handleDeleteNode(node.id);
    });
    
    // Delete any remaining selected edges
    selectedEdges.forEach(edge => {
      // console.log('Deleting edge:', edge.id);
      handleDeleteEdge(edge.id);
    });
  }, [nodes, edges, handleDeleteNode, handleDeleteEdge]);

  // Store callback refs for use in sync effect
  const calculateEdgeWidthRef = useRef(calculateEdgeWidth);
  const calculateEdgeOffsetsRef = useRef(calculateEdgeOffsets);
  
  useEffect(() => {
    calculateEdgeWidthRef.current = calculateEdgeWidth;
    calculateEdgeOffsetsRef.current = calculateEdgeOffsets;
  }, [calculateEdgeWidth, calculateEdgeOffsets]);
  
  // Sync FROM graph TO ReactFlow when graph changes externally
  const syncCountRef = useRef(0);
  useEffect(() => {
    console.log('🔄 Sync effect triggered', { hasGraph: !!graph, syncCount: syncCountRef.current });
    
    if (!graph) {
      console.log('  ↳ No graph, skipping');
      return;
    }
    
    const graphJson = JSON.stringify(graph);
    
    // Check if this is the same graph we just synced
    if (graphJson === lastSyncedGraphRef.current) {
      console.log('  ↳ Same graph, skipping');
      return;
    }
    
    syncCountRef.current++;
    console.log(`  ↳ Syncing (attempt ${syncCountRef.current}/5)...`);
    
    if (syncCountRef.current > 5) {
      console.error('❌ Sync loop detected (>5 syncs). Stopping.');
      return;
    }
    
    lastSyncedGraphRef.current = graphJson;
    
    // Reset counter after a delay
    setTimeout(() => { syncCountRef.current = 0; }, 500);
    
    try {
      console.log('  ↳ Converting graph to ReactFlow...');
      const { nodes: newNodes, edges: newEdges } = toFlow(graph, {
        onUpdateNode: handleUpdateNode,
        onDeleteNode: handleDeleteNode,
        onUpdateEdge: handleUpdateEdge,
        onDeleteEdge: handleDeleteEdge,
        onDoubleClickNode: onDoubleClickNode,
        onDoubleClickEdge: onDoubleClickEdge,
        onSelectEdge: onSelectEdge,
        onReconnect: handleReconnectEdge,
      });
      
      console.log(`  ↳ Converted: ${newNodes.length} nodes, ${newEdges.length} edges`);
      
      // Add edge width calculation to each edge using ref
      const edgesWithWidth = newEdges.map(edge => ({
        ...edge,
        data: {
          ...edge.data,
          calculateWidth: () => calculateEdgeWidthRef.current(edge, newEdges, newNodes)
        }
      }));
      
      console.log('  ↳ Calculating edge offsets...');
      // Calculate edge offsets for Sankey-style visualization using ref
      const edgesWithOffsets = calculateEdgeOffsetsRef.current(edgesWithWidth, newNodes, MAX_WIDTH);
      
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
      
      console.log('  ↳ Setting nodes and edges...');
      setNodes(newNodes);
      setEdges(edgesWithOffsetData);
      console.log('✅ Sync complete');
    } catch (error) {
      console.error('❌ Error during sync:', error);
    }
  }, [graph, handleUpdateNode, handleDeleteNode, handleUpdateEdge, handleDeleteEdge, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, handleReconnectEdge, setNodes, setEdges]);

  // Fit view when graph is initially loaded (e.g., from git repository)
  // Track graph metadata to detect actual graph changes (not just re-renders)
  const lastGraphMetadataRef = useRef<string>('');
  
  useEffect(() => {
    console.log('📐 FitView effect triggered', { 
      hasGraph: !!graph,
      graphName: graph?.metadata?.name,
      lastMetadata: lastGraphMetadataRef.current
    });
    
    if (!graph) {
      console.log('  ↳ No graph, skipping fitView');
      return;
    }
    
    // Create a stable identifier for the graph using metadata
    const graphId = graph.metadata?.name || JSON.stringify(graph).slice(0, 100);
    console.log('  ↳ Current graphId:', graphId);
    console.log('  ↳ Last graphId:', lastGraphMetadataRef.current);
    
    // Check if this is a different graph
    if (graphId !== lastGraphMetadataRef.current) {
      console.log('📊 New graph detected, will fit view');
      lastGraphMetadataRef.current = graphId;
      
      // Wait for nodes to be rendered AND measured, then fit view
      // Using requestAnimationFrame to ensure DOM is updated
      requestAnimationFrame(() => {
        console.log('  ↳ requestAnimationFrame fired, scheduling fitView...');
        setTimeout(() => {
          console.log('🎯 Fitting view NOW');
          fitView({ padding: 0.15, duration: 800, maxZoom: 1.5 });
        }, 500);
      });
    } else {
      console.log('  ↳ Same graph, skipping fitView');
    }
  }, [graph, fitView]);

  // Track node positions to detect when they change
  const nodePositionsRef = useRef<string>('');
  
  // Update edge widths and offsets when scaling mode, what-if analysis, or node positions change
  const edgeUpdateCountRef = useRef(0);
  useEffect(() => {
    if (edges.length === 0) return;
    
    // Create a key that includes node positions
    const currentNodes = getNodes();
    const nodePositionsKey = currentNodes.map(n => `${n.id}:${n.position.x.toFixed(0)},${n.position.y.toFixed(0)}`).join('|');
    const updateKey = `${edgeScalingMode}-${whatIfAnalysis?.caseNodeId || ''}-${whatIfAnalysis?.selectedVariant || ''}-${nodePositionsKey}`;
    
    if (updateKey === lastEdgeScalingUpdateRef.current) {
      return; // Skip if nothing relevant changed
    }
    lastEdgeScalingUpdateRef.current = updateKey;
    
    edgeUpdateCountRef.current++;
    if (edgeUpdateCountRef.current > 10) {
      console.warn('⚠️ Edge update loop detected (>10 updates). Stopping.');
      return;
    }
    
    // Force re-render of edges by updating their data and recalculating offsets
    setEdges(prevEdges => {
      const edgesWithWidth = prevEdges.map(edge => ({
        ...edge,
        data: {
          ...edge.data,
          calculateWidth: () => calculateEdgeWidth(edge, prevEdges, currentNodes)
        }
      }));
      
      // Recalculate offsets for mass-based scaling modes
      const edgesWithOffsets = calculateEdgeOffsets(edgesWithWidth, currentNodes, MAX_WIDTH);
      
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
    
    // Reset counter after a delay
    setTimeout(() => { edgeUpdateCountRef.current = 0; }, 1000);
  }, [edgeScalingMode, whatIfAnalysis]);
  
  // Sync FROM ReactFlow TO graph when user makes changes in the canvas
  // NOTE: This should NOT depend on 'graph' to avoid syncing when graph changes externally
  useEffect(() => {
    if (!graph) return;
    if (isSyncingRef.current) return;
    if (nodes.length === 0 && graph.nodes.length > 0) return;
    
    const updatedGraph = fromFlow(nodes, edges, graph);
    if (updatedGraph) {
      const updatedJson = JSON.stringify(updatedGraph);
      if (updatedJson === lastSyncedGraphRef.current) {
        return;
      }
      
      isSyncingRef.current = true;
      lastSyncedGraphRef.current = updatedJson;
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
      // console.log('Created case edge with single variant:', newEdge);
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
        
        // console.log('Delete key pressed, selected nodes:', selectedNodes.length, 'selected edges:', selectedEdges.length);
        
        if (selectedNodes.length > 0 || selectedEdges.length > 0) {
          e.preventDefault();
          if (confirm(`Delete ${selectedNodes.length} node(s) and ${selectedEdges.length} edge(s)?`)) {
            // console.log('Calling deleteSelected');
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
          
          // Node lasso selection check

          return intersects;
        });

        // Lasso selection complete

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

  // Function to find all edges that are part of paths between selected nodes
  const findPathEdges = useCallback((selectedNodes: any[], allEdges: any[]) => {
    if (selectedNodes.length === 0) return new Set();
    
    const selectedNodeIds = selectedNodes.map(node => node.id);
    const pathEdges = new Set<string>();
    
    if (selectedNodes.length === 1) {
      // Single node selected: recursively find upstream and downstream edges with decreasing intensity
      const nodeId = selectedNodeIds[0];
      const visitedNodes = new Set<string>();
      const visitedEdges = new Set<string>();
      const edgeDepths = new Map<string, number>(); // Track depth for each edge
      
      // Recursive function to find downstream edges (edges FROM current node)
      const findDownstreamEdges = (currentNodeId: string, depth: number = 0) => {
        if (visitedNodes.has(currentNodeId) || depth > 10) return; // Prevent infinite loops
        
        visitedNodes.add(currentNodeId);
        
        // Find all downstream edges (edges from this node)
        const downstreamEdges = allEdges.filter(edge => edge.source === currentNodeId);
        downstreamEdges.forEach(edge => {
          if (!visitedEdges.has(edge.id)) {
            visitedEdges.add(edge.id);
            pathEdges.add(edge.id);
            edgeDepths.set(edge.id, depth);
            // Recursively follow the target node (downstream)
            findDownstreamEdges(edge.target, depth + 1);
          }
        });
      };
      
      // Recursive function to find upstream edges (edges TO current node)
      const findUpstreamEdges = (currentNodeId: string, depth: number = 0) => {
        if (visitedNodes.has(currentNodeId) || depth > 10) return; // Prevent infinite loops
        
        visitedNodes.add(currentNodeId);
        
        // Find all upstream edges (edges to this node)
        const upstreamEdges = allEdges.filter(edge => edge.target === currentNodeId);
        upstreamEdges.forEach(edge => {
          if (!visitedEdges.has(edge.id)) {
            visitedEdges.add(edge.id);
            pathEdges.add(edge.id);
            edgeDepths.set(edge.id, depth);
            // Recursively follow the source node (upstream)
            findUpstreamEdges(edge.source, depth + 1);
          }
        });
      };
      
      // Find downstream edges (logical flow direction)
      findDownstreamEdges(nodeId);
      
      // Reset visited nodes for upstream traversal
      visitedNodes.clear();
      visitedEdges.clear();
      
      // Find upstream edges (logical antecedent direction)
      findUpstreamEdges(nodeId);
      
      // Store edge depths for intensity calculation
      (pathEdges as any).edgeDepths = edgeDepths;
      return pathEdges;
    }
    
    // Multiple nodes selected: find all paths between them (existing logic)
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

  // Update edge highlighting when selection changes
  useEffect(() => {
    if (edges.length === 0) return;
    
    const pathEdges = findPathEdges(selectedNodesForAnalysis, edges);
    
    // Debug logging
    if (selectedNodesForAnalysis.length >= 1) {
      // console.log('Selected nodes:', selectedNodesForAnalysis.map(n => n.id));
      // console.log('Highlighted edges:', Array.from(pathEdges));
    }
    
    setEdges(prevEdges => 
      prevEdges.map(edge => {
        const isHighlighted = pathEdges.has(edge.id);
        const edgeDepths = (pathEdges as any).edgeDepths;
        const depth = edgeDepths ? edgeDepths.get(edge.id) : 0;
        
        return {
          ...edge,
          data: {
            ...edge.data,
            isHighlighted,
            highlightDepth: isHighlighted ? depth : undefined
          }
        };
      })
    );
  }, [selectedNodesForAnalysis, setEdges, findPathEdges, edges]);

  // Calculate probability and cost for selected nodes
  const calculateSelectionAnalysis = useCallback(() => {
    if (selectedNodesForAnalysis.length === 0) return null;

    const selectedNodeIds = selectedNodesForAnalysis.map(n => n.id);
    
    // Special case: exactly 2 nodes selected - calculate path analysis
    if (selectedNodesForAnalysis.length === 2) {
      const [nodeA, nodeB] = selectedNodesForAnalysis;
      
      // Find direct edge between the two nodes (A → B)
      const directEdge = edges.find(edge => 
        edge.source === nodeA.id && edge.target === nodeB.id
      );
      
      // Find reverse edge (B → A) 
      const reverseEdge = edges.find(edge => 
        edge.source === nodeB.id && edge.target === nodeA.id
      );
      
      // Find path through intermediate nodes (A → ... → B) using dagCalc logic
      const findPathThroughIntermediates = (startId: string, endId: string): { path: any[], probability: number, expectedCosts: any } => {
        const visited = new Set<string>();
        const costs: { [nodeId: string]: { monetary: number, time: number, units: string } } = {};
        
        const dfs = (nodeId: string): { monetary: number, time: number, units: string } => {
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
          
          // Find all outgoing edges from current node
          const outgoingEdges = edges.filter(edge => edge.source === nodeId);
          
          for (const edge of outgoingEdges) {
            // Calculate effective probability (handles case edges and what-if analysis)
            let edgeProbability = edge.data?.probability || 0;
            if (edge.data?.case_id && edge.data?.case_variant) {
              const caseNode = nodes.find((n: any) => n.data?.case?.id === edge.data.case_id);
              if (caseNode) {
                const variant = caseNode.data?.case?.variants?.find((v: any) => v.name === edge.data.case_variant);
                let variantWeight = variant?.weight || 0;
                
                // Apply what-if analysis override
                if (whatIfAnalysis && whatIfAnalysis.caseNodeId === caseNode.id) {
                  variantWeight = edge.data.case_variant === whatIfAnalysis.selectedVariant ? 1.0 : 0.0;
                }
                
                const subRouteProbability = edge.data?.probability || 1.0;
                edgeProbability = variantWeight * subRouteProbability;
              }
            }
            
            const edgeCosts = edge.data?.costs;
            
            // Get cost from target node (recursive)
            const targetCost = dfs(edge.target);
            
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
        
        const expectedCosts = dfs(startId);
        
        // Calculate total probability using the same DFS approach
        const calculateProbability = (nodeId: string): number => {
          if (nodeId === endId) return 1;
          
          let totalProbability = 0;
          const outgoingEdges = edges.filter(edge => edge.source === nodeId);
          
          for (const edge of outgoingEdges) {
            // Calculate effective probability (handles case edges and what-if analysis)
            let edgeProbability = edge.data?.probability || 0;
            if (edge.data?.case_id && edge.data?.case_variant) {
              const caseNode = nodes.find((n: any) => n.data?.case?.id === edge.data.case_id);
              if (caseNode) {
                const variant = caseNode.data?.case?.variants?.find((v: any) => v.name === edge.data.case_variant);
                let variantWeight = variant?.weight || 0;
                
                // Apply what-if analysis override
                if (whatIfAnalysis && whatIfAnalysis.caseNodeId === caseNode.id) {
                  variantWeight = edge.data.case_variant === whatIfAnalysis.selectedVariant ? 1.0 : 0.0;
                }
                
                const subRouteProbability = edge.data?.probability || 1.0;
                edgeProbability = variantWeight * subRouteProbability;
              }
            }
            
            const targetProbability = calculateProbability(edge.target);
            totalProbability += edgeProbability * targetProbability;
          }
          
          return totalProbability;
        };
        
        const pathProbability = calculateProbability(startId);
        
        return { 
          path: [], // We don't need the actual path for cost calculation
          probability: pathProbability, 
          expectedCosts 
        };
      };
      
      // Calculate direct path (if exists) - for direct paths, cost is just the edge cost
      let directPathProbability = directEdge?.data?.probability || 0;
      // Handle case edges for direct path
      if (directEdge && directEdge.data?.case_id && directEdge.data?.case_variant) {
        const caseNode = nodes.find((n: any) => n.data?.case?.id === directEdge.data.case_id);
        if (caseNode) {
          const variant = caseNode.data?.case?.variants?.find((v: any) => v.name === directEdge.data.case_variant);
          let variantWeight = variant?.weight || 0;
          
          // Apply what-if analysis override
          if (whatIfAnalysis && whatIfAnalysis.caseNodeId === caseNode.id) {
            variantWeight = directEdge.data.case_variant === whatIfAnalysis.selectedVariant ? 1.0 : 0.0;
          }
          
          const subRouteProbability = directEdge.data?.probability || 1.0;
          directPathProbability = variantWeight * subRouteProbability;
        }
      }
      const directPathCosts = {
        monetary: directEdge?.data?.costs?.monetary?.value || 0,
        time: directEdge?.data?.costs?.time?.value || 0,
        units: directEdge?.data?.costs?.time?.units || ''
      };
      
      // Calculate path through intermediates using dagCalc logic
      const intermediatePath = findPathThroughIntermediates(nodeA.id, nodeB.id);
      
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
  }, [selectedNodesForAnalysis, edges, nodes, whatIfAnalysis]);

  const analysis = calculateSelectionAnalysis();

  // Handle selection changes
  const onSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: any) => {
    // Selection changed
    
    // Update selected nodes for analysis
    setSelectedNodesForAnalysis(selectedNodes);
    
    // Don't clear selection if we just finished a lasso selection
    if (isLassoSelecting) {
      // console.log('Ignoring selection change during lasso selection');
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

  // Auto-layout functions
  const handleApplyLayout = useCallback((direction: 'LR' | 'TB' | 'RL' | 'BT', selectedOnly: boolean) => {
    if (!graph) return;
    
    // Save current state for undo (including graph state)
    setLayoutHistory({ 
      nodes: [...nodes], 
      edges: [...edges],
      graph: structuredClone(graph)
    });
    
    // Get selected node IDs
    const selectedNodeIds = new Set(nodes.filter(n => n.selected).map(n => n.id));
    
    // Apply layout
    const { nodes: newNodes, edges: newEdges } = applyAutoLayout(nodes, edges, {
      direction,
      selectedOnly,
      selectedNodeIds
    });
    
    // Update nodes and edges in ReactFlow
    setNodes(newNodes);
    setEdges(newEdges);
    
    // Update graph state: node positions AND edge handles (always re-route after layout)
    const nextGraph = structuredClone(graph);
    
    // Update node positions
    newNodes.forEach(node => {
      const graphNode = nextGraph.nodes.find(n => n.id === node.id);
      if (graphNode && graphNode.layout) {
        graphNode.layout.x = node.position.x;
        graphNode.layout.y = node.position.y;
      }
    });
    
    // Always re-route edges after layout for optimal routing
    // console.log('Updating edge handles after layout');
    edges.forEach(edge => {
      const sourceNode = newNodes.find(n => n.id === edge.source);
      const targetNode = newNodes.find(n => n.id === edge.target);
      
      if (sourceNode && targetNode) {
        const { sourceHandle, targetHandle } = calculateOptimalHandles(sourceNode, targetNode);
        
        // Find the edge in the graph and update its handles
        const graphEdge = nextGraph.edges.find(e => e.id === edge.id);
        if (graphEdge) {
          // console.log(`Re-routing edge ${edge.id}: ${graphEdge.fromHandle} -> ${sourceHandle}, ${graphEdge.toHandle} -> ${targetHandle}`);
          graphEdge.fromHandle = sourceHandle;
          graphEdge.toHandle = targetHandle;
        }
      }
    });
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Update graph state with both position and re-route changes in one go
    // Prevent sync loop by updating lastSyncedGraphRef immediately
    lastSyncedGraphRef.current = JSON.stringify(nextGraph);
    setGraph(nextGraph);
    
    // Show confirmation modal
    setShowLayoutConfirmModal(true);
    setShowLayoutDropdown(false);
    
    // Only fit view for full layouts, not partial (selected only)
    if (!selectedOnly) {
      setTimeout(() => {
        fitView({ padding: 0.2, duration: 400 });
      }, 100);
    }
  }, [nodes, edges, graph, setNodes, setEdges, setGraph, fitView, calculateOptimalHandles]);

  const handleConfirmLayout = useCallback(() => {
    // Clear history and close modal
    setLayoutHistory(null);
    setShowLayoutConfirmModal(false);
  }, []);

  const handleRevertLayout = useCallback(() => {
    if (layoutHistory) {
      // Restore nodes and edges
      setNodes(layoutHistory.nodes);
      setEdges(layoutHistory.edges);
      // Restore graph state (this reverts any auto re-route changes too)
      setGraph(layoutHistory.graph);
    }
    setLayoutHistory(null);
    setShowLayoutConfirmModal(false);
  }, [layoutHistory, setNodes, setEdges, setGraph]);

  // Close layout dropdown when clicking outside
  useEffect(() => {
    if (!showLayoutDropdown) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-layout-dropdown]')) {
        setShowLayoutDropdown(false);
      }
    };
    
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showLayoutDropdown]);

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
        onInit={() => setTimeout(() => fitView({ padding: 0.1, duration: 600 }), 100)}
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
              marginRight: '8px',
            }}
          >
            Delete Selected
          </button>
          
          <div style={{ position: 'relative', display: 'inline-block' }} data-layout-dropdown>
            <button
              onClick={() => setShowLayoutDropdown(!showLayoutDropdown)}
              style={{
                padding: '8px 16px',
                background: '#28a745',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              ⚡ Auto Layout
              <span style={{ fontSize: '10px' }}>▼</span>
            </button>
            
            {showLayoutDropdown && (
              <div style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: '4px',
                background: 'white',
                border: '1px solid #ddd',
                borderRadius: '4px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                zIndex: 1000,
                minWidth: '200px'
              }}>
                <div style={{ padding: '8px 0' }}>
                  <div style={{
                    padding: '4px 12px',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    color: '#666',
                    textTransform: 'uppercase'
                  }}>
                    Layout All Nodes
                  </div>
                  <button
                    onClick={() => handleApplyLayout('LR', false)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      background: 'transparent',
                      border: 'none',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontSize: '14px'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#f5f5f5'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    → Left to Right
                  </button>
                  <button
                    onClick={() => handleApplyLayout('TB', false)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      background: 'transparent',
                      border: 'none',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontSize: '14px'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#f5f5f5'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    ↓ Top to Bottom
                  </button>
                  <button
                    onClick={() => handleApplyLayout('RL', false)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      background: 'transparent',
                      border: 'none',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontSize: '14px'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#f5f5f5'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    ← Right to Left
                  </button>
                  <button
                    onClick={() => handleApplyLayout('BT', false)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      background: 'transparent',
                      border: 'none',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontSize: '14px'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#f5f5f5'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    ↑ Bottom to Top
                  </button>
                  
                  {nodes.some(n => n.selected) && (
                    <>
                      <div style={{
                        borderTop: '1px solid #eee',
                        margin: '4px 0',
                        padding: '4px 12px',
                        fontSize: '11px',
                        fontWeight: 'bold',
                        color: '#666',
                        textTransform: 'uppercase'
                      }}>
                        Layout Selected Only
                      </div>
                      <button
                        onClick={() => handleApplyLayout('LR', true)}
                        style={{
                          width: '100%',
                          padding: '8px 12px',
                          background: 'transparent',
                          border: 'none',
                          textAlign: 'left',
                          cursor: 'pointer',
                          fontSize: '14px'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = '#f5f5f5'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        → Left to Right (Selected)
                      </button>
                      <button
                        onClick={() => handleApplyLayout('TB', true)}
                        style={{
                          width: '100%',
                          padding: '8px 12px',
                          background: 'transparent',
                          border: 'none',
                          textAlign: 'left',
                          cursor: 'pointer',
                          fontSize: '14px'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = '#f5f5f5'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        ↓ Top to Bottom (Selected)
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
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
                {analysis.type === 'path' ? 'Path Analysis' : 'Selection Analysis'}
              </h3>
              
              {analysis.type === 'path' ? (
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
      
      {/* Layout Confirmation Modal */}
      <LayoutConfirmationModal
        isOpen={showLayoutConfirmModal}
        onConfirm={handleConfirmLayout}
        onRevert={handleRevertLayout}
      />
    </div>
  );
}
