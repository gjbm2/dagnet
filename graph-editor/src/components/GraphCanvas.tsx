import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSnapToSlider } from '@/hooks/useSnapToSlider';
import { roundTo4DP } from '@/utils/rounding';
import ReactFlow, {
  Background,
  BackgroundVariant,
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
import '../custom-reactflow.css';
import dagre from 'dagre';

import ConversionNode from './nodes/ConversionNode';
import ConversionEdge from './edges/ConversionEdge';
import ProbabilityInput from './ProbabilityInput';
import VariantWeightInput from './VariantWeightInput';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { useTabContext } from '../contexts/TabContext';
import { useViewPreferencesContext } from '../contexts/ViewPreferencesContext';
import { toFlow, fromFlow } from '@/lib/transform';
import { generateIdFromLabel, generateUniqueId } from '@/lib/idUtils';
import { computeEffectiveEdgeProbability } from '@/lib/whatIf';
import { getOptimalFace, assignFacesForNode } from '@/lib/faceSelection';

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
  onAddNodeRef?: React.MutableRefObject<(() => void) | null>;
  onDeleteSelectedRef?: React.MutableRefObject<(() => void) | null>;
  onAutoLayoutRef?: React.MutableRefObject<((direction: 'LR' | 'RL' | 'TB' | 'BT') => void) | null>;
  onForceRerouteRef?: React.MutableRefObject<(() => void) | null>;
  onHideUnselectedRef?: React.MutableRefObject<(() => void) | null>;
  // What-if analysis state (from tab state, not GraphStore)
  whatIfAnalysis?: any;
  caseOverrides?: Record<string, string>;
  conditionalOverrides?: Record<string, Set<string>>;
  // Tab identification for keyboard event filtering
  tabId?: string;
  activeTabId?: string | null;
}

export default function GraphCanvas({ onSelectedNodeChange, onSelectedEdgeChange, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, onAddNodeRef, onDeleteSelectedRef, onAutoLayoutRef, onForceRerouteRef, onHideUnselectedRef, whatIfAnalysis, caseOverrides, conditionalOverrides, tabId, activeTabId }: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner 
        tabId={tabId}
        activeTabId={activeTabId}
        onSelectedNodeChange={onSelectedNodeChange}
        onSelectedEdgeChange={onSelectedEdgeChange}
        onDoubleClickNode={onDoubleClickNode}
        onDoubleClickEdge={onDoubleClickEdge}
        onSelectEdge={onSelectEdge}
        onAddNodeRef={onAddNodeRef}
        onDeleteSelectedRef={onDeleteSelectedRef}
        onAutoLayoutRef={onAutoLayoutRef}
        onForceRerouteRef={onForceRerouteRef}
        onHideUnselectedRef={onHideUnselectedRef}
        whatIfAnalysis={whatIfAnalysis}
        caseOverrides={caseOverrides}
        conditionalOverrides={conditionalOverrides}
      />
    </ReactFlowProvider>
  );
}

function CanvasInner({ onSelectedNodeChange, onSelectedEdgeChange, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, onAddNodeRef, onDeleteSelectedRef, onAutoLayoutRef, onForceRerouteRef, onHideUnselectedRef, whatIfAnalysis, caseOverrides = {}, conditionalOverrides = {}, tabId, activeTabId: activeTabIdProp }: GraphCanvasProps) {
  const store = useGraphStore();
  const { graph, setGraph } = store;
  const { operations: tabOperations, activeTabId: activeTabIdContext, tabs } = useTabContext();
  const viewPrefs = useViewPreferencesContext();
  
  // Fallback to defaults if context not available (shouldn't happen in normal use)
  const useUniformScaling = viewPrefs?.useUniformScaling ?? false;
  const massGenerosity = viewPrefs?.massGenerosity ?? 0.5;
  const autoReroute = viewPrefs?.autoReroute ?? true;
  const ts = () => new Date().toISOString();
  const whatIfStartRef = useRef<number | null>(null);
  
  // Track graph store reference changes to detect loops
  const prevGraphRef = useRef(graph);
  const graphChangeCountRef = useRef(0);
  useEffect(() => {
    if (prevGraphRef.current !== graph) {
      graphChangeCountRef.current++;
      console.log(`[${new Date().toISOString()}] [GraphCanvas] GRAPH STORE NEW REFERENCE (count: ${graphChangeCountRef.current}, nodes: ${graph?.nodes?.length || 0}, edges: ${graph?.edges?.length || 0})`);
      prevGraphRef.current = graph;
    }
  }, [graph]);
  useEffect(() => {
    const handler = (e: any) => {
      if (e?.detail?.tabId && tabId && e.detail.tabId !== tabId) return;
      whatIfStartRef.current = e.detail?.t0 ?? performance.now();
      console.log(`[${ts()}] [GraphCanvas] what-if start received`, { t0: whatIfStartRef.current, tabId });
    };
    window.addEventListener('dagnet:whatif-start', handler as any);
    return () => window.removeEventListener('dagnet:whatif-start', handler as any);
  }, []);
  
  // Use prop if provided, otherwise fall back to context
  const activeTabId = activeTabIdProp ?? activeTabIdContext;
  const saveHistoryState = store.saveHistoryState;
  const { snapValue, shouldAutoRebalance, scheduleRebalance, handleMouseDown } = useSnapToSlider();
  
  // Get the store hook for direct .getState() access
  const graphStoreHook = useGraphStore();
  
  // Recompute edge widths when conditional what-if overrides change
  // Create a "version" to track changes in what-if overrides (for reactivity)
  const overridesVersion = JSON.stringify({ caseOverrides, conditionalOverrides, whatIfAnalysis });
  const { deleteElements, fitView, screenToFlowPosition, setCenter } = useReactFlow();
  
  // ReactFlow maintains local state for smooth interactions
  const [nodes, setNodes, onNodesChangeBase] = useNodesState([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState([]);
  
  // Track array reference changes to detect loops
  const prevNodesRef = useRef(nodes);
  const prevEdgesRef = useRef(edges);
  const nodesChangeCountRef = useRef(0);
  const edgesChangeCountRef = useRef(0);
  useEffect(() => {
    if (prevNodesRef.current !== nodes) {
      nodesChangeCountRef.current++;
      console.log(`[${new Date().toISOString()}] [GraphCanvas] NODES ARRAY NEW REFERENCE (count: ${nodesChangeCountRef.current}, length: ${nodes.length})`);
      prevNodesRef.current = nodes;
    }
    if (prevEdgesRef.current !== edges) {
      edgesChangeCountRef.current++;
      console.log(`[${new Date().toISOString()}] [GraphCanvas] EDGES ARRAY NEW REFERENCE (count: ${edgesChangeCountRef.current}, length: ${edges.length})`);
      prevEdgesRef.current = edges;
    }
  }, [nodes, edges]);
  
  // Custom onEdgesChange handler to prevent automatic deletion
  const onEdgesChange = useCallback((changes: any[]) => {
    console.log(`[${new Date().toISOString()}] [GraphCanvas] onEdgesChange called (${changes.length} changes)`);
    
    // Filter out remove changes to prevent automatic deletion
    const filteredChanges = changes.filter(change => change.type !== 'remove');
    
    if (filteredChanges.length !== changes.length) {
      console.log(`[${new Date().toISOString()}] [GraphCanvas] Filtered out ${changes.length - filteredChanges.length} remove changes`);
    }
    
    // Call the base handler with filtered changes
    onEdgesChangeBase(filteredChanges);
  }, [onEdgesChangeBase]);
  
  // Trigger flag for re-routing
  const [shouldReroute, setShouldReroute] = useState(0);
  const [forceReroute, setForceReroute] = useState(false); // Force re-route once (for layout)
  const skipNextRerouteRef = useRef(false); // Skip next auto-reroute after manual reconnection
  
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
    console.log(`[${new Date().toISOString()}] [GraphCanvas] onNodesChange called (${changes.length} changes)`);
    // Call the base handler first
    onNodesChangeBase(changes);
    
    // Trigger auto-reroute on ANY position change (during or after drag)
    // But not when syncing from graph to ReactFlow
    if (autoReroute && !isSyncingRef.current) {
      const positionChanges = changes.filter(change => change.type === 'position');
      if (positionChanges.length > 0) {
        console.log(`[${new Date().toISOString()}] [GraphCanvas] Position changes detected, triggering reroute`);
        // Trigger re-routing by incrementing the flag
        // This will run during drag (for visual feedback) and won't save history
        setShouldReroute(prev => prev + 1);
      }
    }
  }, [onNodesChangeBase, autoReroute]);


  // Edge width calculation based on scaling mode
  const MAX_WIDTH = 104; // Node height (120px) minus 2x corner radius (8px each = 16px)
  const MIN_WIDTH = 2;
  
  const calculateEdgeWidth = useCallback((edge: any, allEdges: any[], allNodes: any[]) => {
    
    // Get current state from store (avoid stale closures)
    const currentGraph = graphStoreHook.getState().graph;
    const currentOverrides = { caseOverrides, conditionalOverrides };
    const currentWhatIfAnalysis = whatIfAnalysis;

    // UNIFIED helper: get effective probability
    // Use edge data directly if available (most current), otherwise use store
    const getEffectiveProbability = (e: any): number => {
      // Use unified What-If engine so conditional overrides and hyperpriors are respected
      const edgeId = e.id || `${e.source}->${e.target}`;
      return computeEffectiveEdgeProbability(
        currentGraph,
        edgeId,
        currentOverrides,
        currentWhatIfAnalysis || null,
        undefined
      );
    };
    
    // Uniform scaling: constant width
    if (useUniformScaling) {
      return 10;
    }
    
    // Find the start node for flow calculations
      const startNode = allNodes.find(n => 
        n.data?.entry?.is_start === true || (n.data?.entry?.entry_weight || 0) > 0
      );
      
        const edgeProbability = getEffectiveProbability(edge);
    
    // If no start node, fallback to pure local mass
      if (!startNode) {
        const sourceEdges = allEdges.filter(e => e.source === edge.source);
        const totalProbability = sourceEdges.reduce((sum, e) => sum + getEffectiveProbability(e), 0);
        if (totalProbability === 0) return MIN_WIDTH;
        const proportion = edgeProbability / totalProbability;
        const scaledWidth = MIN_WIDTH + (proportion * (MAX_WIDTH - MIN_WIDTH));
        return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, scaledWidth));
      }
      
    // Helper function to calculate residual probability at a node
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
    
    // Calculate actual flow through this edge
    const residualAtSource = calculateResidualProbability(edge.source, allEdges, startNode.id);
    
    if (residualAtSource === 0) return MIN_WIDTH;
    
    const actualMassFlowing = residualAtSource * edgeProbability;
    
    // Apply generosity transformation
    // generosity = 0: pure global (actualMassFlowing^1 = actualMassFlowing)
    // generosity = 1: pure local (actualMassFlowing^0 × local_proportion)
    // generosity = 0.5: balanced (actualMassFlowing^0.5, compresses dynamic range)
    
    let displayMass: number;
    
    if (massGenerosity === 0) {
      // Pure global (Sankey): use actual mass directly
      displayMass = actualMassFlowing;
    } else if (massGenerosity === 1) {
      // Pure local: ignore upstream, just use local proportions
      const sourceEdges = allEdges.filter(e => e.source === edge.source);
      const totalProbability = sourceEdges.reduce((sum, e) => sum + getEffectiveProbability(e), 0);
      if (totalProbability === 0) return MIN_WIDTH;
      const localProportion = edgeProbability / totalProbability;
      displayMass = localProportion;
    } else {
      // Blended: use power function to compress dynamic range
      // At g=0.5, this gives sqrt(actualMassFlowing) which compresses the range
      // while still respecting global flow
      const power = 1 - massGenerosity;
      displayMass = Math.pow(actualMassFlowing, power);
    }
    
    // Scale to width
    const scaledWidth = MIN_WIDTH + (displayMass * (MAX_WIDTH - MIN_WIDTH));
    const finalWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, scaledWidth));
    return finalWidth;
  }, [useUniformScaling, massGenerosity, caseOverrides, conditionalOverrides, whatIfAnalysis, graphStoreHook]);

  // Calculate edge sort keys for curved edge stacking
  // For Bézier curves, sort by the angle/direction at which edges leave/enter the face
  const getEdgeSortKey = useCallback((sourceNode: any, targetNode: any, face: string, isSourceFace: boolean = true, edgeId?: string) => {
    if (!sourceNode || !targetNode) return [0, 0];

    const sourceX = sourceNode.position?.x || 0;
    const sourceY = sourceNode.position?.y || 0;
    const targetX = targetNode.position?.x || 0;
    const targetY = targetNode.position?.y || 0;

    // Calculate vector from source to target
    const dx = targetX - sourceX;
    const dy = targetY - sourceY;

    // Angle-based sorting (preferred). Use abs(dy) to mirror top/bottom behavior
    // so tiny vertical shifts don't flip ordering on left/right faces.
    let directionAngle: number;
    if (isSourceFace) {
      // Edge leaves the source
      if (face === 'right') {
        directionAngle = Math.atan2(Math.abs(dx), -dy); // rotate top/bottom by 90°: swap x↔y
      } else if (face === 'left') {
        directionAngle = -Math.atan2(Math.abs(dx), dy); // rotate top/bottom by 90°: swap x↔y
      } else if (face === 'bottom') {
        directionAngle = Math.atan2(Math.abs(dy), -dx);
      } else { // top
        directionAngle = -Math.atan2(Math.abs(dy), dx);
      }
    } else {
      // Edge enters the target
      if (face === 'left') {
        directionAngle = Math.atan2(-Math.abs(dx), -dy); // rotate top/bottom by 90°: swap x↔y
      } else if (face === 'right') {
        directionAngle = -Math.atan2(Math.abs(dx), -dy); // rotate top/bottom by 90°: swap x↔y
      } else if (face === 'top') {
        directionAngle = Math.atan2(-Math.abs(dy), -dx);
      } else { // bottom
        directionAngle = -Math.atan2(Math.abs(dy), -dx);
      }
    }

    // Secondary sort by span for stability when angles are very close
    const span = Math.sqrt(dx * dx + dy * dy);

    // Final tie-breaker to keep order stable under tiny movements
    const edgeIdHash = edgeId ? edgeId.split('').reduce((a, b) => a + b.charCodeAt(0), 0) : 0;

    return [directionAngle, -span, edgeIdHash];
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

    // Pre-calculate scale factors per face to ensure consistency
    const faceScaleFactors: { [faceKey: string]: number } = {};
    
    if (!useUniformScaling) {
      // Calculate scale factors for each source face
      Object.keys(edgesBySource).forEach(sourceId => {
        const sourceEdges = edgesBySource[sourceId];
        // allNodes are ReactFlow nodes: n.id = uuid, n.data.id = human-readable id
        const sourceNode = allNodes.find(n => n.id === sourceId || n.data?.id === sourceId);
        if (!sourceNode) return;
        
        // Group by face
        const edgesByFace: { [face: string]: any[] } = {};
        sourceEdges.forEach(edge => {
          const sourceHandle = edge.sourceHandle || 'right-out';
          const sourceFace = sourceHandle.split('-')[0];
          if (!edgesByFace[sourceFace]) {
            edgesByFace[sourceFace] = [];
          }
          edgesByFace[sourceFace].push(edge);
        });
        
        // Calculate scale factor for each face
        Object.keys(edgesByFace).forEach(face => {
          const faceEdges = edgesByFace[face];
          const totalWidth = faceEdges.reduce((sum, e) => {
            return sum + (e.data?.calculateWidth ? e.data.calculateWidth() : 2);
          }, 0);
          
          const faceKey = `source-${sourceId}-${face}`;
          faceScaleFactors[faceKey] = totalWidth > maxWidth ? maxWidth / totalWidth : 1.0;
        });
      });
      
      // Calculate scale factors for each target face
      Object.keys(edgesByTarget).forEach(targetId => {
        const targetEdges = edgesByTarget[targetId];
        // allNodes are ReactFlow nodes: n.id = uuid, n.data.id = human-readable id
        const targetNode = allNodes.find(n => n.id === targetId || n.data?.id === targetId);
        if (!targetNode) return;
        
        // Group by face
        const edgesByFace: { [face: string]: any[] } = {};
        targetEdges.forEach(edge => {
          const targetHandle = edge.targetHandle || 'left';
          const targetFace = targetHandle.split('-')[0];
          if (!edgesByFace[targetFace]) {
            edgesByFace[targetFace] = [];
          }
          edgesByFace[targetFace].push(edge);
        });
        
        // Calculate scale factor for each face
        Object.keys(edgesByFace).forEach(face => {
          const faceEdges = edgesByFace[face];
          const totalWidth = faceEdges.reduce((sum, e) => {
            return sum + (e.data?.calculateWidth ? e.data.calculateWidth() : 2);
          }, 0);
          
          const faceKey = `target-${targetId}-${face}`;
          faceScaleFactors[faceKey] = totalWidth > maxWidth ? maxWidth / totalWidth : 1.0;
        });
      });
      
      // Calculate scale factors for incident faces (faces with edges from multiple sources)
      // This handles cases where multiple source nodes connect to the same target face
      const incidentFaces: { [faceKey: string]: any[] } = {};
      
      // Group all edges by target node and face
      edgesWithWidth.forEach(edge => {
        const targetHandle = edge.targetHandle || 'left';
        const targetFace = targetHandle.split('-')[0];
        const faceKey = `incident-${edge.target}-${targetFace}`;
        
        if (!incidentFaces[faceKey]) {
          incidentFaces[faceKey] = [];
        }
        incidentFaces[faceKey].push(edge);
      });
      
      // Calculate scale factors for incident faces
      Object.keys(incidentFaces).forEach(faceKey => {
        const faceEdges = incidentFaces[faceKey];
        const totalWidth = faceEdges.reduce((sum, e) => {
          return sum + (e.data?.calculateWidth ? e.data.calculateWidth() : 2);
        }, 0);
        
        faceScaleFactors[faceKey] = totalWidth > maxWidth ? maxWidth / totalWidth : 1.0;
      });
    }

    // Calculate offsets for each edge (both source and target)
    const edgesWithOffsets = edgesWithWidth.map(edge => {
      // Apply offsets for all modes including uniform (for Sankey-style visualization)
      // (Skip offsets only for modes that explicitly don't need them - currently none)

      const sourceEdges = edgesBySource[edge.source] || [];
      const targetEdges = edgesByTarget[edge.target] || [];

      // Find the source and target nodes to determine edge direction
      // allNodes are ReactFlow nodes: n.id = uuid, n.data.id = human-readable id
      const sourceNode = allNodes.find(n => n.id === edge.source || n.data?.id === edge.source);
      const targetNode = allNodes.find(n => n.id === edge.target || n.data?.id === edge.target);
      
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
        // allNodes are ReactFlow nodes: n.id = uuid, n.data.id = human-readable id
        const aTarget = allNodes.find(n => n.id === a.target || n.data?.id === a.target);
        const bTarget = allNodes.find(n => n.id === b.target || n.data?.id === b.target);
        if (!aTarget || !bTarget) return 0;
        
        const aKey = getEdgeSortKey(sourceNode, aTarget, sourceFace, true, a.id);
        const bKey = getEdgeSortKey(sourceNode, bTarget, sourceFace, true, b.id);
        
        // Compare [angle, span, edgeIdHash]
        if (aKey[0] !== bKey[0]) return aKey[0] - bKey[0];
        if (aKey[1] !== bKey[1]) return aKey[1] - bKey[1];
        return aKey[2] - bKey[2];
      });

      // Get the scale factor for this source face
      const sourceFaceKey = `source-${edge.source}-${sourceFace}`;
      const sourceScaleFactor = faceScaleFactors[sourceFaceKey] || 1.0;

      // Calculate source offsets using the pre-calculated scale factor
      let sourceOffsetX = 0;
      let sourceOffsetY = 0;

      if (sortedSourceEdges.length > 0) {
        const sourceEdgeIndex = sortedSourceEdges.findIndex(e => e.id === edge.id); // ReactFlow edge IDs match
        if (sourceEdgeIndex !== -1) {
          // Calculate cumulative width using per-edge scale = min(source-face, incident target-face)
          const sourceCumulativeWidth = sortedSourceEdges.slice(0, sourceEdgeIndex).reduce((sum, e) => {
            const width = e.data?.calculateWidth ? e.data.calculateWidth() : 2;
            const eSourceHandle = e.sourceHandle || 'right-out';
            const eSourceFace = eSourceHandle.split('-')[0];
            const eTargetHandle = e.targetHandle || 'left';
            const eTargetFace = eTargetHandle.split('-')[0];
            const eSourceKey = `source-${e.source}-${eSourceFace}`;
            const eIncidentKey = `incident-${e.target}-${eTargetFace}`;
            const eSourceScale = faceScaleFactors[eSourceKey] || 1.0;
            const eIncidentScale = faceScaleFactors[eIncidentKey] || 1.0;
            const eScale = !useUniformScaling ? Math.min(eSourceScale, eIncidentScale) : 1.0;
            return sum + (width * eScale);
          }, 0);

          const edgeWidth = edge.data?.calculateWidth ? edge.data.calculateWidth() : 2;
          const incidentFaceKeyForThis = `incident-${edge.target}-${targetFace}`;
          const incidentScaleForThis = faceScaleFactors[incidentFaceKeyForThis] || 1.0;
          const thisEdgeScale = !useUniformScaling ? Math.min(sourceScaleFactor, incidentScaleForThis) : 1.0;
          const scaledEdgeWidth = edgeWidth * thisEdgeScale;
          
          const sourceCenterInStack = sourceCumulativeWidth + (scaledEdgeWidth / 2);
          
          // Calculate total scaled width for centering using per-edge scales
          const totalScaledWidth = sortedSourceEdges.reduce((sum, e) => {
            const width = e.data?.calculateWidth ? e.data.calculateWidth() : 2;
            const eSourceHandle = e.sourceHandle || 'right-out';
            const eSourceFace = eSourceHandle.split('-')[0];
            const eTargetHandle = e.targetHandle || 'left';
            const eTargetFace = eTargetHandle.split('-')[0];
            const eSourceKey = `source-${e.source}-${eSourceFace}`;
            const eIncidentKey = `incident-${e.target}-${eTargetFace}`;
            const eSourceScale = faceScaleFactors[eSourceKey] || 1.0;
            const eIncidentScale = faceScaleFactors[eIncidentKey] || 1.0;
            const eScale = !useUniformScaling ? Math.min(eSourceScale, eIncidentScale) : 1.0;
            return sum + (width * eScale);
          }, 0);
          
          const sourceStackCenter = totalScaledWidth / 2;
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
        // allNodes are ReactFlow nodes: n.id = uuid, n.data.id = human-readable id
        const aSource = allNodes.find(n => n.id === a.source || n.data?.id === a.source);
        const bSource = allNodes.find(n => n.id === b.source || n.data?.id === b.source);
        if (!aSource || !bSource) return 0;
        
        const aKey = getEdgeSortKey(aSource, targetNode, targetFace, false, a.id);
        const bKey = getEdgeSortKey(bSource, targetNode, targetFace, false, b.id);
        
        // Compare [angle, span, edgeIdHash]
        if (aKey[0] !== bKey[0]) return aKey[0] - bKey[0];
        if (aKey[1] !== bKey[1]) return aKey[1] - bKey[1];
        return aKey[2] - bKey[2];
      });

      // Get the scale factor for this target incident face (ALL incoming edges)
      const incidentFaceKey = `incident-${edge.target}-${targetFace}`;
      const targetScaleFactor = faceScaleFactors[incidentFaceKey] || 1.0;

      let targetOffsetX = 0;
      let targetOffsetY = 0;

      if (sortedTargetEdges.length > 0) {
        const targetEdgeIndex = sortedTargetEdges.findIndex(e => e.id === edge.id); // ReactFlow edge IDs match
        if (targetEdgeIndex !== -1) {
          // Calculate cumulative width using per-edge scale = min(source-face, incident target-face)
          const targetCumulativeWidth = sortedTargetEdges.slice(0, targetEdgeIndex).reduce((sum, e) => {
            const width = e.data?.calculateWidth ? e.data.calculateWidth() : 2;
            const eSourceHandle = e.sourceHandle || 'right-out';
            const eSourceFace = eSourceHandle.split('-')[0];
            const eTargetHandle = e.targetHandle || 'left';
            const eTargetFace = eTargetHandle.split('-')[0];
            const eSourceKey = `source-${e.source}-${eSourceFace}`;
            const eIncidentKey = `incident-${e.target}-${eTargetFace}`;
            const eSourceScale = faceScaleFactors[eSourceKey] || 1.0;
            const eIncidentScale = faceScaleFactors[eIncidentKey] || 1.0;
            const eScale = !useUniformScaling ? Math.min(eSourceScale, eIncidentScale) : 1.0;
            return sum + (width * eScale);
          }, 0);

          const edgeWidth = edge.data?.calculateWidth ? edge.data.calculateWidth() : 2;
          const thisEdgeScaleAtTarget = !useUniformScaling ? Math.min(sourceScaleFactor, targetScaleFactor) : 1.0;
          const scaledEdgeWidth = edgeWidth * thisEdgeScaleAtTarget;
          
          const targetCenterInStack = targetCumulativeWidth + (scaledEdgeWidth / 2);
          
          // Calculate total scaled width for centering using per-edge scales
          const totalScaledWidth = sortedTargetEdges.reduce((sum, e) => {
            const width = e.data?.calculateWidth ? e.data.calculateWidth() : 2;
            const eSourceHandle = e.sourceHandle || 'right-out';
            const eSourceFace = eSourceHandle.split('-')[0];
            const eTargetHandle = e.targetHandle || 'left';
            const eTargetFace = eTargetHandle.split('-')[0];
            const eSourceKey = `source-${e.source}-${eSourceFace}`;
            const eIncidentKey = `incident-${e.target}-${eTargetFace}`;
            const eSourceScale = faceScaleFactors[eSourceKey] || 1.0;
            const eIncidentScale = faceScaleFactors[eIncidentKey] || 1.0;
            const eScale = !useUniformScaling ? Math.min(eSourceScale, eIncidentScale) : 1.0;
            return sum + (width * eScale);
          }, 0);
          
          const targetStackCenter = totalScaledWidth / 2;
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

      // Get the final edge width using the per-edge scale factor = min(source-face, incident target-face)
      let scaledWidth = edge.data?.calculateWidth ? edge.data.calculateWidth() : 2;
      if (!useUniformScaling) {
        const thisIncidentScale = faceScaleFactors[`incident-${edge.target}-${targetFace}`] || 1.0;
        const thisEdgeScale = Math.min(sourceScaleFactor, thisIncidentScale);
        scaledWidth = scaledWidth * thisEdgeScale;
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
  }, [useUniformScaling, getEdgeSortKey, graphStoreHook]);

  // Track the last synced graph to detect real changes
  const lastSyncedGraphRef = useRef<string>('');
  const lastSyncedReactFlowRef = useRef<string>('');
  const isSyncingRef = useRef(false); // Prevents ReactFlow->Graph sync loops, but NOT Graph->ReactFlow sync
  const isDraggingNodeRef = useRef(false); // Prevents Graph->ReactFlow sync during node dragging
  const reactFlowWrapperRef = useRef<HTMLDivElement>(null); // For lasso coordinate calculations
  const hasInitialFitViewRef = useRef(false);
  const currentGraphIdRef = useRef<string>('');
  
  // Re-route feature state
  const lastNodePositionsRef = useRef<{ [nodeId: string]: { x: number; y: number } }>({});

  // Ref to autofocus edge probability input in context menu
  const edgeProbabilityInputRef = useRef<HTMLInputElement | null>(null);
  
  // Separate state for input display to allow intermediate states like "."
  const [edgeProbabilityDisplay, setEdgeProbabilityDisplay] = useState<string>('');

  // Focus probability input when edge context menu opens
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphCanvas] useEffect#GC3: Focus edge probability input`);
    if (edgeContextMenu && edgeProbabilityInputRef.current) {
      // Initialize display state with current probability value
      setEdgeProbabilityDisplay(String(contextMenuLocalData?.probability || 0));
      requestAnimationFrame(() => {
        edgeProbabilityInputRef.current?.focus();
        edgeProbabilityInputRef.current?.select();
      });
    }
  }, [edgeContextMenu, contextMenuLocalData?.probability]);
  
  // Calculate optimal handles between two nodes
  const calculateOptimalHandles = useCallback((sourceNode: any, targetNode: any) => {
    // Calculate direction from source to target
    const deltaX = targetNode.position.x - sourceNode.position.x;
    const deltaY = targetNode.position.y - sourceNode.position.y;
    
    // For source node: this is an output connection, direction TO target
    const sourceFace = getOptimalFace(sourceNode.id, true, deltaX, deltaY, edges);
    
    // For target node: this is an input connection, direction FROM source (inverse)
    const targetFace = getOptimalFace(targetNode.id, false, -deltaX, -deltaY, edges);
    
    // Convert face to handle format
    const sourceHandle = sourceFace + '-out';
    const targetHandle = targetFace;
    
    return { sourceHandle, targetHandle };
  }, [edges]);
  
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
      // For ReactFlow nodes, n.id IS the uuid, but graphEdge.from/to could be either uuid or human-readable id
      const sourceNode = nodes.find(n => n.id === graphEdge.from || n.data?.id === graphEdge.from);
      const targetNode = nodes.find(n => n.id === graphEdge.to || n.data?.id === graphEdge.to);
      
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
    // Skip if we just did a manual reconnection
    if (skipNextRerouteRef.current) {
      console.log('Auto re-route skipped: manual reconnection just occurred');
      skipNextRerouteRef.current = false;
      return;
    }
    
    // Allow execution if autoReroute is enabled OR if forceReroute is true
    if ((!autoReroute && !forceReroute) || !graph) {
      console.log('Auto re-route skipped:', { autoReroute, forceReroute, hasGraph: !!graph });
      return;
    }
    
    const isDragging = isDraggingNodeRef.current;
    console.log('performAutoReroute executing:', { autoReroute, forceReroute, isDragging });
    
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
    
    // Build quick position map
    const pos: Record<string, { x: number; y: number }> = {};
    nodes.forEach(n => { pos[n.id] = { x: n.position.x, y: n.position.y }; });

    // Track which edges changed to identify nodes that need re-evaluation
    const changedEdges = new Set<string>();
    const processedNodes = new Set<string>();
    const nodesToProcess = [...movedNodes];
    
    // Process nodes in waves, using original edge state for decisions
    while (nodesToProcess.length > 0) {
      const nodeId = nodesToProcess.shift()!;
      if (processedNodes.has(nodeId)) continue;
      
      processedNodes.add(nodeId);
      
      // Use original edges for face assignment decisions
      const assignments = assignFacesForNode(nodeId, pos, edges as any);
      
      // Apply assignments and track changes
      Object.entries(assignments).forEach(([edgeId, face]) => {
        const originalEdge = edges.find(e => e.id === edgeId); // ReactFlow edge IDs match
        const graphEdge = nextGraph.edges.find(e => e.uuid === edgeId || e.id === edgeId);
        if (!originalEdge || !graphEdge) return;
        
        const newFromHandle = graphEdge.from === nodeId ? face + '-out' : graphEdge.fromHandle;
        const newToHandle = graphEdge.to === nodeId ? face : graphEdge.toHandle;
        
        
        // Check if this edge's face actually changed
        const fromChanged = graphEdge.from === nodeId && originalEdge.sourceHandle !== newFromHandle;
        const toChanged = graphEdge.to === nodeId && originalEdge.targetHandle !== newToHandle;
        
        if (fromChanged || toChanged) {
          changedEdges.add(edgeId);
          
          // Add connected nodes for next wave (avoid duplicates)
          if (!processedNodes.has(originalEdge.source) && !nodesToProcess.includes(originalEdge.source)) {
            nodesToProcess.push(originalEdge.source);
          }
          if (!processedNodes.has(originalEdge.target) && !nodesToProcess.includes(originalEdge.target)) {
            nodesToProcess.push(originalEdge.target);
          }
        }
        
        // Apply the changes
        if (graphEdge.from === nodeId) {
          graphEdge.fromHandle = face + '-out';
        }
        if (graphEdge.to === nodeId) {
          graphEdge.toHandle = face;
        }
      });
    }
    
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    console.log('Updating graph with new handle positions');
    setGraph(nextGraph);
    // Graph→ReactFlow sync will pick up the edge handle changes via the fast path
  }, [autoReroute, forceReroute, graph, nodes, edges, calculateOptimalHandles, setGraph]);
  
  // Reset position tracking and perform immediate re-route when autoReroute is toggled ON
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphCanvas] useEffect#GC4: Auto re-route toggled:`, autoReroute);
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
    console.log(`[${new Date().toISOString()}] [GraphCanvas] useEffect#GC5: Perform re-routing`);
    if ((shouldReroute > 0 && autoReroute) || forceReroute) {
      console.log('Re-route triggered:', { shouldReroute, autoReroute, forceReroute });
      // Add a small delay to ensure node positions are fully updated
      const timeoutId = setTimeout(() => {
        console.log('Executing delayed re-route after node movement');
        performAutoReroute();
        if (forceReroute) {
          setForceReroute(false); // Reset force flag after execution
        }
        // Reset the shouldReroute flag to prevent infinite loops
        setShouldReroute(0);
      }, 100); // 100ms delay after user finishes dragging
      
      return () => clearTimeout(timeoutId);
    }
  }, [shouldReroute, autoReroute, forceReroute, performAutoReroute]);
  
  // Get all existing ids (nodes and edges) for uniqueness checking
  const getAllExistingIds = useCallback((excludeId?: string) => {
    if (!graph) return [];
    
    const nodeIds = graph.nodes
      .filter((node: any) => node.uuid !== excludeId)
      .map((node: any) => node.id)
      .filter(Boolean);
    
    const edgeIds = graph.edges
      .filter((edge: any) => edge.uuid !== excludeId)
      .map((edge: any) => edge.id)
      .filter(Boolean);
    
    return [...nodeIds, ...edgeIds];
  }, [graph]);
  
  // Callback functions for node/edge updates
  const handleUpdateNode = useCallback((id: string, data: any) => {
    console.log('handleUpdateNode called:', { id, data });
    if (!graph) return;
    
    const prevGraph = graph;
      
    // Check for id uniqueness if id is being updated
    if (data.id) {
      const existingIds = getAllExistingIds(id);
      if (existingIds.includes(data.id)) {
        alert(`ID "${data.id}" is already in use. Please choose a different ID.`);
        return;
      }
    }
    
    const nextGraph = structuredClone(prevGraph);
    const nodeIndex = nextGraph.nodes.findIndex(n => n.uuid === id);
    if (nodeIndex >= 0) {
      nextGraph.nodes[nodeIndex] = { ...nextGraph.nodes[nodeIndex], ...data };
      if (nextGraph.metadata) {
        nextGraph.metadata.updated_at = new Date().toISOString();
      }
      console.log('Updated node in graph:', nextGraph.nodes[nodeIndex]);
    }
    setGraph(nextGraph);
  }, [graph, setGraph, getAllExistingIds]);

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
    
    // Check for id uniqueness if id is being updated
    if (data.id) {
      const existingIds = getAllExistingIds(id);
      if (existingIds.includes(data.id)) {
        alert(`ID "${data.id}" is already in use. Please choose a different ID.`);
        return;
      }
    }
    
    const nextGraph = structuredClone(prevGraph);
    const edgeIndex = nextGraph.edges.findIndex(e => e.uuid === id);
    if (edgeIndex >= 0) {
      nextGraph.edges[edgeIndex] = { ...nextGraph.edges[edgeIndex], ...data };
      if (nextGraph.metadata) {
        nextGraph.metadata.updated_at = new Date().toISOString();
      }
    }
    setGraph(nextGraph);
  }, [graph, setGraph, getAllExistingIds]);

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
    
    // Note: History saving is handled by the calling component (PropertiesPanel or deleteSelected)
    
    // Clear selection when edge is deleted
    onSelectedEdgeChange(null);
  }, [graph, setGraph, onSelectedEdgeChange]);

  // Delete selected elements
  const deleteSelected = useCallback(() => {
    if (!graph) return;
    
    const selectedNodes = nodes.filter(n => n.selected);
    const selectedEdges = edges.filter(e => e.selected);
    
    console.log('deleteSelected called with:', selectedNodes.length, 'nodes and', selectedEdges.length, 'edges');
    
    if (selectedNodes.length === 0 && selectedEdges.length === 0) return;
    
    // Save history state BEFORE deletion
    if (selectedNodes.length > 1 || selectedEdges.length > 1 || (selectedNodes.length > 0 && selectedEdges.length > 0)) {
      saveHistoryState('Delete selected', undefined, undefined);
    } else if (selectedEdges.length === 1) {
      saveHistoryState('Delete edge', undefined, selectedEdges[0].id);
    } else if (selectedNodes.length === 1) {
      saveHistoryState('Delete node', selectedNodes[0].id);
    }
    
    // Do all deletions in a single graph update
    const nextGraph = structuredClone(graph);
    
    // Delete selected nodes and their connected edges
    // Build set of both UUIDs and human-readable IDs for checking edge.from/to
    const selectedNodeUUIDs = new Set(selectedNodes.map(n => n.id)); // ReactFlow IDs are UUIDs
    const selectedNodeHumanIds = new Set(selectedNodes.map(n => n.data?.id).filter(Boolean));
    const allSelectedIds = new Set([...selectedNodeUUIDs, ...selectedNodeHumanIds]);
    
    nextGraph.nodes = nextGraph.nodes.filter(n => !selectedNodeUUIDs.has(n.uuid));
    nextGraph.edges = nextGraph.edges.filter(e => 
      // edge.from/to can be EITHER uuid OR human-readable ID
      !allSelectedIds.has(e.from) && !allSelectedIds.has(e.to)
    );
    
    // Delete selected edges (that weren't already deleted with nodes)
    const selectedEdgeIds = new Set(selectedEdges.map(e => e.id));
    nextGraph.edges = nextGraph.edges.filter(e => !selectedEdgeIds.has(e.uuid));
    
    // Update metadata
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = new Date().toISOString();
    }
    
    // Single graph update for all deletions
    setGraph(nextGraph);
    
    // Clear selection
    if (selectedNodes.length > 0) {
      onSelectedNodeChange(null);
    }
    if (selectedEdges.length > 0) {
      onSelectedEdgeChange(null);
    }
  }, [nodes, edges, graph, setGraph, saveHistoryState, onSelectedNodeChange, onSelectedEdgeChange]);

  // Listen for force redraw events (e.g., after undo/redo)
  useEffect(() => {
    const handleForceRedraw = () => {
      console.log('🔄 Force redraw requested - clearing sync cache');
      lastSyncedGraphRef.current = '';
      // The Graph→ReactFlow sync useEffect will fire on next render
    };
    
    window.addEventListener('dagnet:forceRedraw', handleForceRedraw);
    return () => window.removeEventListener('dagnet:forceRedraw', handleForceRedraw);
  }, []);

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
    console.log('  Graph edges:', graph.edges?.map((e: any) => e.id));
    console.log('  ReactFlow edges:', edges.map(e => e.id));
    
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
    const graphEdgeIds = new Set(graph.edges.map((e: any) => e.id));
    const reactFlowEdgeIds = new Set(edges.map(e => e.id));
    const edgeIdsChanged = edges.some(e => !graphEdgeIds.has(e.id)) || 
                           graph.edges.some((e: any) => !reactFlowEdgeIds.has(e.id));
    
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
    
    // Fast path: If only edge data/handles changed (no topology or position changes), update in place
    // CRITICAL: During drag, ALWAYS take fast path to prevent node position overwrites
    // We ignore nodePositionsChanged during drag because ReactFlow has the current drag positions
    const shouldTakeFastPath = !edgeCountChanged && !nodeCountChanged && !edgeIdsChanged && edges.length > 0 && 
                               (isDraggingNodeRef.current || !nodePositionsChanged);
    
    if (shouldTakeFastPath) {
      const pathReason = isDraggingNodeRef.current ? '(DRAG - ignoring position diff)' : '(positions unchanged)';
      console.log(`  ⚡ Fast path: Topology unchanged, updating edge data/handles in place ${pathReason}`);
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
              case_id: graphEdge.case_id
            }
          };
        });
        
        // Second pass: add calculateWidth functions with updated edge data
        const resultWithWidth = result.map(edge => ({
          ...edge,
          data: {
            ...edge.data,
            calculateWidth: () => calculateEdgeWidth(edge, result, nodes)
          }
        }));
        
        // Recalculate offsets for mass-based scaling modes
        const edgesWithOffsets = calculateEdgeOffsets(resultWithWidth, nodes, MAX_WIDTH);
        
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
            // Pass what-if overrides to edges
            caseOverrides: caseOverrides,
            conditionalOverrides: conditionalOverrides
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
    
    console.log('  🔨 Slow path: Topology changed, doing full rebuild');
    
    // Topology changed - do full rebuild
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
        ...edge.data
        // Don't add calculateWidth here - will be added after offsets are calculated
      }
      };
    });
    
    // Add calculateWidth functions with updated edge data
    const edgesWithWidthFunctions = edgesWithWidth.map(edge => ({
      ...edge,
      data: {
        ...edge.data,
        calculateWidth: () => calculateEdgeWidth(edge, edgesWithWidth, nodesWithSelection)
      }
    }));
    
  // Calculate edge offsets for Sankey-style visualization
  const edgesWithOffsets = calculateEdgeOffsets(edgesWithWidthFunctions, nodesWithSelection, MAX_WIDTH);
  
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
      // Pass what-if overrides to edges
      caseOverrides: caseOverrides,
      conditionalOverrides: conditionalOverrides
    }
  }));
    
    setNodes(nodesWithSelection);
    setEdges(edgesWithOffsetData);
    
    // Reset syncing flag after graph->ReactFlow sync is complete
    // Use a longer timeout to ensure all cascading updates complete
    setTimeout(() => {
      isSyncingRef.current = false;
      console.log('Reset isSyncingRef to false');
    }, 100);
  }, [graph, setNodes, setEdges, handleUpdateNode, handleDeleteNode, handleUpdateEdge, handleDeleteEdge, onDoubleClickNode, onDoubleClickEdge, onSelectEdge, activeTabId, tabs]);

  // Separate effect to handle hidden state changes and trigger redraw
  useEffect(() => {
    if (!activeTabId || !nodes.length || !edges.length) return;
    
    const tab = tabs.find(t => t.id === activeTabId);
    const hiddenNodes = tab?.editorState?.hiddenNodes || new Set<string>();
    
    // Update node classes
    setNodes(prevNodes => 
      prevNodes.map(node => ({
        ...node,
        className: hiddenNodes.has(node.id) ? 'hidden' : ''
      }))
    );
    
    // Update edge classes
    setEdges(prevEdges => 
      prevEdges.map(edge => ({
        ...edge,
        className: (hiddenNodes.has(edge.source) || hiddenNodes.has(edge.target)) ? 'hidden' : ''
      }))
    );
  }, [activeTabId, tabs, nodes.length, edges.length, setNodes, setEdges]);

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
    
    console.log('Edge scaling changed - uniform:', useUniformScaling, 'generosity:', massGenerosity);
    
    // Ensure sync flag is reset after edge scaling updates
    setTimeout(() => {
      isSyncingRef.current = false;
      console.log('Reset isSyncingRef after edge scaling');
    }, 50);
    
    // Force re-render of edges by updating their data and recalculating offsets
    setEdges(prevEdges => {
      // First pass: update edge data without calculateWidth functions
      const edgesWithWidth = prevEdges.map(edge => ({
        ...edge,
        data: {
          ...edge.data
          // Don't add calculateWidth here - will be added after offsets are calculated
        }
      }));
      
      // Second pass: add calculateWidth functions with updated edge data
      const edgesWithWidthFunctions = edgesWithWidth.map(edge => ({
        ...edge,
        data: {
          ...edge.data,
          calculateWidth: () => calculateEdgeWidth(edge, edgesWithWidth, nodes)
        }
      }));
      
      // Recalculate offsets for mass-based scaling modes
      const edgesWithOffsets = calculateEdgeOffsets(edgesWithWidthFunctions, nodes, MAX_WIDTH);
      
      // Attach offsets to edge data for the ConversionEdge component
      const result = edgesWithOffsets.map(edge => ({
        ...edge,
        data: {
          ...edge.data,
          sourceOffsetX: edge.sourceOffsetX,
          sourceOffsetY: edge.sourceOffsetY,
          targetOffsetX: edge.targetOffsetX,
          targetOffsetY: edge.targetOffsetY,
          scaledWidth: edge.scaledWidth,
          // Pass what-if overrides to edges
          caseOverrides: caseOverrides,
          conditionalOverrides: conditionalOverrides
        }
      }));
      
      return result;
    });
  }, [useUniformScaling, massGenerosity, nodes, setEdges]);
  
  // Recalculate edge widths when what-if changes (throttled to one per frame)
  const recomputeInProgressRef = useRef(false);
  const visualWhatIfUpdateRef = useRef(false);
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphCanvas] useEffect#GC1: What-If recompute triggered (edges=${edges.length})`);
    if (edges.length === 0) return;
    if (recomputeInProgressRef.current) {
      console.log(`[${ts()}] [GraphCanvas] what-if recompute skipped (in progress)`);
      return;
    }
    recomputeInProgressRef.current = true;
    const t0 = performance.now();
    requestAnimationFrame(() => {
      try {
        visualWhatIfUpdateRef.current = true; // mark as visual-only update
        setEdges(prevEdges => {
          const t1 = performance.now();
          // First pass: update edge data without calculateWidth functions
          const edgesWithWidth = prevEdges.map(edge => ({
            ...edge,
            data: {
              ...edge.data
            }
          }));
          // Second pass: add calculateWidth functions with updated edge data
          const edgesWithWidthFunctions = edgesWithWidth.map(edge => ({
            ...edge,
            data: {
              ...edge.data,
              calculateWidth: () => calculateEdgeWidth(edge, edgesWithWidth, nodes)
            }
          }));
          const t2 = performance.now();
          // Recalculate offsets for mass-based scaling modes
          const edgesWithOffsets = calculateEdgeOffsets(edgesWithWidthFunctions, nodes, MAX_WIDTH);
          const t3 = performance.now();
          console.log(`[${ts()}] [GraphCanvas] what-if recompute timings`, { mapMs: Math.round(t2 - t1), offsetsMs: Math.round(t3 - t2) });
          // Attach offsets to edge data for the ConversionEdge component
          return edgesWithOffsets.map(edge => ({
            ...edge,
            data: {
              ...edge.data,
              sourceOffsetX: edge.sourceOffsetX,
              sourceOffsetY: edge.sourceOffsetY,
              targetOffsetX: edge.targetOffsetX,
              targetOffsetY: edge.targetOffsetY,
              scaledWidth: edge.scaledWidth,
              // Pass what-if overrides to edges
              caseOverrides: caseOverrides,
              conditionalOverrides: conditionalOverrides
            }
          }));
        });
      } finally {
        const tEnd = performance.now();
        console.log(`[${ts()}] [GraphCanvas] what-if recompute done`, { totalMs: Math.round(tEnd - t0) });
        recomputeInProgressRef.current = false;
        // Clear the visual-only flag after queue flush
        setTimeout(() => { visualWhatIfUpdateRef.current = false; }, 0);
      }
    });
  }, [overridesVersion, whatIfAnalysis, setEdges, nodes, edges.length]);

  useEffect(() => {
    // Log when overridesVersion propagates into canvas and compute latency
    if (whatIfStartRef.current != null) {
      const dt = performance.now() - whatIfStartRef.current;
      console.log(`[${ts()}] [GraphCanvas] what-if applied`, { dtMs: Math.round(dt) });
      whatIfStartRef.current = null;
    } else {
      console.log(`[${ts()}] [GraphCanvas] overrides changed (no start marker)`);
    }
  }, [overridesVersion]);
  
  // Sync FROM ReactFlow TO graph when user makes changes in the canvas
  // NOTE: This should NOT depend on 'graph' to avoid syncing when graph changes externally
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [GraphCanvas] useEffect#GC2: Sync ReactFlow→Store triggered`);
    if (!graph) return;
    if (visualWhatIfUpdateRef.current) {
      // Skip syncing visual-only what-if changes back to graph store
      // Prevents global rerenders and race conditions
      console.log(`[${new Date().toISOString()}] [GraphCanvas] skip store sync (what-if visual update)`);
      return;
    }
    if (isSyncingRef.current) {
      console.log(`[${new Date().toISOString()}] [GraphCanvas] ReactFlow→Store: Skipped (already syncing)`);
      return;
    }
    
    // BLOCK ReactFlow→Graph sync during node dragging to prevent multiple graph updates
    if (isDraggingNodeRef.current) {
      console.log(`[${new Date().toISOString()}] [GraphCanvas] ReactFlow→Store: Blocked (dragging)`);
      return;
    }
    
    if (nodes.length === 0 && graph.nodes.length > 0) {
      console.log(`[${new Date().toISOString()}] [GraphCanvas] ReactFlow→Store: Skipped (nodes empty)`);
      return;
    }
    
    const updatedGraph = fromFlow(nodes, edges, graph);
    if (updatedGraph) {
      const updatedJson = JSON.stringify(updatedGraph);
      if (updatedJson === lastSyncedReactFlowRef.current) {
        console.log(`[${new Date().toISOString()}] [GraphCanvas] ReactFlow→Store: Skipped (no changes)`);
        return;
      }
      
      console.log(`[${new Date().toISOString()}] [GraphCanvas] ReactFlow→Store: SYNCING to store`);
      isSyncingRef.current = true;
      lastSyncedReactFlowRef.current = updatedJson;
      setGraph(updatedGraph);
      
      // Note: History is NOT saved here during drag - it's saved once at drag start
      
      // Reset sync flag
      setTimeout(() => {
        isSyncingRef.current = false;
        console.log(`[${new Date().toISOString()}] [GraphCanvas] ReactFlow→Store: Sync flag reset`);
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
      
      // Try multiple ways to find the edge
      let edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === oldEdge.id || e.id === oldEdge.id);
      
      if (edgeIndex === -1) {
        // Try finding by source->target format
        const sourceTargetId = `${oldEdge.source}->${oldEdge.target}`;
        edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === sourceTargetId || e.id === sourceTargetId);
      }
      
      if (edgeIndex === -1) {
        // Try finding by from->to format (from/to could be uuid or id)
        edgeIndex = nextGraph.edges.findIndex((e: any) => 
          (e.from === oldEdge.source || e.from === oldEdge.source) && 
          (e.to === oldEdge.target || e.to === oldEdge.target)
        );
      }
      
      if (edgeIndex === -1) {
        console.log('❌ ERROR: Edge not found in graph:', oldEdge.id);
        console.log('Available edges:', nextGraph.edges.map((e: any) => e.id));
        console.log('╚════════════════════════════════════════════════════╝');
        return;
      }
      
      const originalEdge = { ...nextGraph.edges[edgeIndex] };
      
      console.log('');
      console.log('📊 PROBABILITY CHECK:');
      console.log('  Original edge probability:', originalEdge.p);
      
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
      console.log('  probability (p):', originalEdge.p, '→', nextGraph.edges[edgeIndex].p);
      console.log('');
      console.log('✅ SUCCESS - Edge reconnected!');
      console.log('📊 Final edge object:', JSON.stringify(nextGraph.edges[edgeIndex], null, 2));
      console.log('╚════════════════════════════════════════════════════╝');
      console.log('');
      
      // Prevent ReactFlow->Graph sync from overwriting this manual reconnection
      isSyncingRef.current = true;
      setGraph(nextGraph);
      
      // Prevent auto-reroute from overwriting manual handle selection
      skipNextRerouteRef.current = true;
      
      // Save history state for edge reconnection
      saveHistoryState('Reconnect edge', undefined, nextGraph.edges[edgeIndex].id);
      
      // Reset isSyncingRef after a short delay to allow Graph->ReactFlow sync to complete
      setTimeout(() => {
        isSyncingRef.current = false;
      }, 100);
    }, 50); // 50ms debounce
  }, [graph, setGraph, wouldCreateCycle, saveHistoryState]);

  // Generate a unique id for an edge based on node ids
  const generateEdgeId = useCallback((sourceId: string, targetId: string) => {
    if (!graph?.nodes) return `${sourceId}-to-${targetId}`;
    
    // Find source and target nodes to get their ids
    const sourceNode = graph.nodes.find((n: any) => n.uuid === sourceId || n.id === sourceId);
    const targetNode = graph.nodes.find((n: any) => n.uuid === targetId || n.id === targetId);
    
    const sourceId_ = sourceNode?.id || sourceNode?.uuid || sourceId;
    const targetId_ = targetNode?.id || targetNode?.uuid || targetId;
    
    let baseId = `${sourceId_}-to-${targetId_}`;
    let edgeId = baseId;
    let counter = 1;
    
    // Ensure uniqueness by appending a number if needed
    const existingIds = getAllExistingIds();
    const uniqueId = generateUniqueId(baseId, existingIds);
    
    return uniqueId;
  }, [graph, getAllExistingIds]);

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
    // connection.source is ReactFlow ID (uuid)
    const sourceNode = graph.nodes.find(n => n.uuid === connection.source || n.id === connection.source);
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

    // Generate a sensible id for the edge
    const edgeId = generateEdgeId(connection.source, connection.target) || `${connection.source}->${connection.target}`;
    
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
    
    // Calculate smart default probability based on existing outgoing edges
    const existingOutgoingEdges = nextGraph.edges.filter((e: any) => e.from === connection.source);
    let defaultProbability: number;
    
    if (existingOutgoingEdges.length === 0) {
      // First edge from this node - default to 1.0 (100%)
      defaultProbability = 1.0;
    } else {
      // Subsequent edges - default to remaining probability
      const existingProbabilitySum = existingOutgoingEdges.reduce((sum, edge) => {
        return sum + (edge.p?.mean || 0);
      }, 0);
      defaultProbability = Math.max(0, 1.0 - existingProbabilitySum);
    }
    
    const newEdge: any = {
      uuid: edgeId,
      id: edgeId,
      from: connection.source,
      to: connection.target,
      fromHandle: sourceHandle,
      toHandle: targetHandle,
      p: {
        mean: defaultProbability
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
  }, [graph, setGraph, generateEdgeId, wouldCreateCycle, onSelectedEdgeChange, saveHistoryState]);

  // Variant selection modal state
  const [showVariantModal, setShowVariantModal] = useState(false);
  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null);
  const [caseNodeVariants, setCaseNodeVariants] = useState<any[]>([]);

  // Handle variant selection for case edges
  const handleVariantSelection = useCallback((variant: any) => {
    if (!pendingConnection || !graph) return;
    
    // pendingConnection.source is ReactFlow ID (uuid)
    const sourceNode = graph.nodes.find(n => n.uuid === pendingConnection.source || n.id === pendingConnection.source);
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
    
    // Generate edge properties (for case variant edges, use variant-specific ID)
    const edgeId = `${pendingConnection.source}-${variant.name}->${pendingConnection.target}`;
    
    // Create the edge with variant properties
    const nextGraph = structuredClone(graph);
    nextGraph.edges.push({
      uuid: edgeId,
      id: edgeId,
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
  }, [pendingConnection, graph, setGraph, generateEdgeId, saveHistoryState]);
  
  // Handle Shift+Drag lasso selection
  const [isLassoSelecting, setIsLassoSelecting] = useState(false);
  const [lassoStart, setLassoStart] = useState<{ x: number; y: number } | null>(null);
  const [lassoEnd, setLassoEnd] = useState<{ x: number; y: number } | null>(null);
  const [isShiftHeld, setIsShiftHeld] = useState(false);
  const lassoCompletedRef = useRef(false); // Prevent double completion

  // Track Shift key state and handle mouse events globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setIsShiftHeld(true);
      }
      
      // Handle Delete key for selected elements
      if (e.key === 'Delete' || e.key === 'Backspace') {
        console.log(`[GraphCanvas ${tabId}] Delete key detected`);
        
        // FIRST: Check if user is typing in a form field or Monaco editor
        // (Exception: inputs with data-allow-global-shortcuts="true" should pass through for CTRL+Z/CTRL+Y only)
        const target = e.target as HTMLElement;
        const allowGlobalShortcuts = target.getAttribute?.('data-allow-global-shortcuts') === 'true';
        
        if (!allowGlobalShortcuts && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.closest('.monaco-editor'))) {
          console.log(`[GraphCanvas ${tabId}] Delete ignored - focus in input field without global shortcuts flag`);
          return; // Let the input field handle the Delete/Backspace
        }
        
        // SECOND: If not in an input, check for selected elements
        const selectedNodes = nodes.filter(n => n.selected);
        const selectedEdges = edges.filter(e => e.selected);
        
        console.log(`[GraphCanvas ${tabId}] Delete key pressed, selected nodes:`, selectedNodes.length, 'selected edges:', selectedEdges.length);
        
        // If there are selected nodes or edges, delete them
        if (selectedNodes.length > 0 || selectedEdges.length > 0) {
          e.preventDefault();
          console.log(`[GraphCanvas ${tabId}] Calling deleteSelected`);
          deleteSelected();
          return;
        }
        
        console.log(`[GraphCanvas ${tabId}] No selected elements to delete`);
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
        
        // Store viewport coordinates (for screenToFlowPosition conversion)
        setIsLassoSelecting(true);
        setLassoStart({ x: e.clientX, y: e.clientY });
        setLassoEnd({ x: e.clientX, y: e.clientY });
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (isLassoSelecting && lassoStart) {
        e.preventDefault();
        e.stopPropagation();
        
        // Store viewport coordinates (for screenToFlowPosition conversion)
        setLassoEnd({ x: e.clientX, y: e.clientY });
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (isLassoSelecting && lassoStart && lassoEnd && !lassoCompletedRef.current) {
        lassoCompletedRef.current = true; // Prevent double execution
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
          

          return intersects;
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
        
        // Reset lasso state after a delay to allow selection to settle
        setTimeout(() => {
          setIsLassoSelecting(false);
          setLassoStart(null);
          setLassoEnd(null);
          lassoCompletedRef.current = false; // Reset for next lasso
        }, 100);
      } else {
        setIsLassoSelecting(false);
        setLassoStart(null);
        setLassoEnd(null);
        lassoCompletedRef.current = false;
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
  }, [isShiftHeld, isLassoSelecting, lassoStart, lassoEnd, nodes, setNodes, edges, deleteSelected, activeTabId, tabId]);


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
      const currentGraph = graphStoreHook.getState().graph;
      // Use per-tab what-if state (passed as props), not global store
      const currentOverrides = { caseOverrides, conditionalOverrides };
      const currentWhatIfAnalysis = whatIfAnalysis;
      
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
            
          // Update path context to include the target node we're about to visit
          const nextPathContext = new Set([...edgePathContext, edge.target]);
          
          // Get cost from target node (recursive) with updated path context
          const targetCost = dfs(edge.target, nextPathContext);
            
            // Calculate probability-weighted cost (using new flat schema)
            const edgeCost = {
              monetary: edge.data?.cost_gbp?.mean || 0,
              time: edge.data?.cost_time?.mean || 0,
              units: 'days' // Units now implicit: GBP and days
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
      const nodeA = selectedNodesForAnalysis.find(n => n.uuid === sortedNodeIds[0] || n.id === sortedNodeIds[0])!;
      const nodeB = selectedNodesForAnalysis.find(n => n.uuid === sortedNodeIds[1] || n.id === sortedNodeIds[1])!;
      
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
      const currentOverrides = { caseOverrides, conditionalOverrides };
      const currentWhatIfAnalysis2 = whatIfAnalysis;
      const currentGraph2 = graphStoreHook.getState().graph;
      // Pass both nodes for graph pruning and conditional activation
      const pathContext = new Set([nodeA.id, nodeB.id]);
      let directPathProbability = directEdge ? computeEffectiveEdgeProbability(currentGraph2, directEdge.id, currentOverrides, currentWhatIfAnalysis2, pathContext) : 0;
      const directPathCosts = {
        monetary: directEdge?.data?.cost_gbp?.mean || 0,
        time: directEdge?.data?.cost_time?.mean || 0,
        units: 'days' // Units now implicit: GBP and days
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
      
      const currentGraph = graphStoreHook.getState().graph;
      // Use per-tab what-if state (passed as props), not global store
      const currentOverrides = { caseOverrides, conditionalOverrides };
      const currentWhatIfAnalysis = whatIfAnalysis;
      
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
      
      // Build set of ALL selected nodes (including start and end for proper OR logic)
      const allSelected = new Set(allSelectedIds);
      
      // For each sibling group, prune and renormalize
      siblingGroups.forEach((group, key) => {
        if (group.siblings.length <= 1) return;
        
        // Check against ALL selected nodes (not just interstitials)
        // This allows paths to the end node even if it's not an interstitial (fixes OR mode)
        const selectedSiblings = group.siblings.filter(id => allSelected.has(id));
        
        console.log(`Group ${key}: siblings=[${group.siblings}], selected=${selectedSiblings.length}/${group.siblings.length}`);
        
        if (selectedSiblings.length > 0 && selectedSiblings.length < group.siblings.length) {
          const unselectedSiblings = group.siblings.filter(id => !allSelected.has(id));
          
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
      // First node in sorted order = start, last node = end
      const firstNodeId = sortedNodeIds[0];
      const lastNodeId = sortedNodeIds[sortedNodeIds.length - 1];
      const lastNode = selectedNodesForAnalysis.find(n => n.id === lastNodeId);
      
      // Check if last node is an end node (absorbing OR no outgoing edges)
      const lastNodeHasOutgoing = edges.some(e => e.source === lastNodeId);
      const lastNodeIsEnd = lastNode?.data?.absorbing === true || !lastNodeHasOutgoing;
      
      // Check if first node is in the selection (ensures we have a defined start point)
      const firstNodeIsSelected = selectedNodeIds.includes(firstNodeId);
      
      // If we have a clear start and end in the selection, treat as path analysis
      // This handles both sequential (A→B→C) and parallel (A→{B,C}→D) patterns
      const hasUniqueStartEnd = firstNodeIsSelected && (lastNodeIsEnd || sortedNodeIds.length >= 3);
      
      console.log(`3+ nodes check: isSequential=${isSequential}, first=${firstNodeId}, last=${lastNodeId}, lastIsEnd=${lastNodeIsEnd}, hasUniqueStartEnd=${hasUniqueStartEnd}`);
      
      if (isSequential || hasUniqueStartEnd) {
        // Path analysis from first to last through intermediate nodes (sequential or parallel)
        const firstNodeId = sortedNodeIds[0];
        const lastNodeId = sortedNodeIds[sortedNodeIds.length - 1];
        const intermediateIds = sortedNodeIds.slice(1, -1);
        
        const firstNode = selectedNodesForAnalysis.find(n => n.uuid === firstNodeId || n.id === firstNodeId);
        const lastNode = selectedNodesForAnalysis.find(n => n.uuid === lastNodeId || n.id === lastNodeId);
        
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
          intermediateNodes: intermediateIds.map(id => selectedNodesForAnalysis.find(n => n.uuid === id || n.id === id)),
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
      // New flat schema: cost_gbp, cost_time
      if (edge.data?.cost_gbp) {
        totalCosts.monetary += edge.data.cost_gbp.mean || 0;
      }
      if (edge.data?.cost_time) {
        totalCosts.time += edge.data.cost_time.mean || 0;
        if (!totalCosts.units) {
          totalCosts.units = 'days';
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
    
    // Update selected nodes for analysis
    setSelectedNodesForAnalysis(selectedNodes);
    
    // Don't clear selection if we're currently lasso selecting
    if (isLassoSelecting) {
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

  // Handle node drag start - just set flag, don't save yet
  const onNodeDragStart = useCallback(() => {
    console.log('🎯 Node drag started - blocking sync during drag');
    
    // Block Graph→ReactFlow sync during drag to prevent interruption
    isDraggingNodeRef.current = true;
  }, []);

  // Handle node drag stop - save final position to history
  const onNodeDragStop = useCallback(() => {
    console.log('🎯 Node drag stopped - saving final position to history');
    
    // Clear the drag flag - this allows ReactFlow→Graph sync to run and update positions
    isDraggingNodeRef.current = false;
    
    // Save the FINAL position to history after the ReactFlow→Store sync completes
    // Use setTimeout to ensure sync completes first
    setTimeout(() => {
      saveHistoryState('Move node');
    }, 0);
  }, [saveHistoryState]);

  // Add new node
  const addNode = useCallback(() => {
    console.log('addNode function called');
    if (!graph) return;
    
    const newId = crypto.randomUUID();
    
    // Generate initial label (but no id - user should pick from registry)
    const label = `Node ${graph.nodes.length + 1}`;
    
    // Place node at center of current viewport
    const viewportCenter = screenToFlowPosition({ 
      x: window.innerWidth / 2, 
      y: window.innerHeight / 2 
    });
    
    // Add node directly to graph state (not ReactFlow state)
    const nextGraph = structuredClone(graph);
    nextGraph.nodes.push({
      uuid: newId,
      id: '', // Empty ID - user should assign a node_id from registry
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
      // Select in ReactFlow (visual selection)
      setNodes((nodes) => 
        nodes.map((node) => ({
          ...node,
          selected: node.id === newId
        }))
      );
      // Notify parent (PropertiesPanel)
      onSelectedNodeChange(newId);
    }, 50);
  }, [graph, setGraph, onSelectedNodeChange, screenToFlowPosition, saveHistoryState, setNodes]);

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
      nodesep: 60,   // Spacing between nodes in same rank (midpoint between 80 and 40)
      ranksep: 150,  // Spacing between ranks (midpoint between 200 and 100)
      edgesep: 20,   // Minimum separation between edges (encourages straighter edges)
      marginx: 40,   // Midpoint margins
      marginy: 40,
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
      const graphNode = nextGraph.nodes.find((n: any) => n.uuid === nodeId || n.id === nodeId);
      
      if (graphNode) {
        if (!graphNode.layout) graphNode.layout = { x: 0, y: 0 };
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

  // Expose force re-route function to parent component via ref
  useEffect(() => {
    if (onForceRerouteRef) {
      onForceRerouteRef.current = () => {
        console.log('Force re-route triggered via ref');
        setForceReroute(true);
      };
    }
  }, [onForceRerouteRef]);

  // Hide unselected nodes function
  const hideUnselected = useCallback(async () => {
    if (!activeTabId) return;
    
    const selectedNodes = nodes.filter(n => n.selected);
    // Tab operations use human-readable IDs, not UUIDs
    const selectedNodeIds = selectedNodes.map(n => n.data?.id || n.id);
    
    await tabOperations.hideUnselectedNodes(activeTabId, selectedNodeIds);
  }, [activeTabId, nodes, tabOperations]);

  // Expose hide unselected function to parent component via ref
  useEffect(() => {
    if (onHideUnselectedRef) {
      onHideUnselectedRef.current = hideUnselected;
    }
  }, [hideUnselected, onHideUnselectedRef]);


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
    
    const newId = crypto.randomUUID();
    const label = `Node ${graph.nodes.length + 1}`;
    
    const newNode = {
      uuid: newId,
      id: '', // Empty ID - user should assign a node_id from registry
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
      saveHistoryState('Add node', newId);
    } else {
      console.error('saveHistoryState is not a function in addNodeAtPosition:', saveHistoryState);
    }
    setContextMenu(null);
    
    // Select the new node after a brief delay to allow sync to complete
    setTimeout(() => {
      // Select in ReactFlow (visual selection)
      setNodes((nodes) => 
        nodes.map((node) => ({
          ...node,
          selected: node.id === newId
        }))
      );
      // Notify parent (PropertiesPanel)
      onSelectedNodeChange(newId);
    }, 50);
  }, [graph, setGraph, saveHistoryState, setNodes, onSelectedNodeChange]);

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
    
    // edge.id is ReactFlow ID (uuid), check both uuid and human-readable id
    const edgeData = graph?.edges?.find((e: any) => e.uuid === edge.id || e.id === edge.id);
    
    // Select the edge so properties panel shows the correct data
    onSelectedEdgeChange(edge.id);
    
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
  }, [graph, onSelectedEdgeChange]);

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
    // Note: History saving is handled by PropertiesPanel for keyboard/button deletes
    setEdgeContextMenu(null);
  }, [graph, setGraph]);

  if (!graph) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      Loading...
    </div>;
  }

  return (
    <div ref={reactFlowWrapperRef} style={{ height: '100%', position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onReconnect={onEdgeUpdate}
        onSelectionChange={onSelectionChange}
        onNodeDragStart={onNodeDragStart} 
        onNodeDragStop={onNodeDragStop}
        onNodeDoubleClick={(event, node) => {
          event.preventDefault();
          // Select the node first, then open Properties panel
          onSelectedNodeChange(node.id);
          window.dispatchEvent(new CustomEvent('dagnet:openPropertiesPanel'));
        }}
        onEdgeDoubleClick={(event, edge) => {
          event.preventDefault();
          // Select the edge first, then open Properties panel
          onSelectedEdgeChange(edge.id);
          window.dispatchEvent(new CustomEvent('dagnet:openPropertiesPanel'));
        }}
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
        panActivationKeyCode={null}
        nodesDraggable={true}
        nodesConnectable
        elementsSelectable
        reconnectRadius={40}
        edgeUpdaterRadius={40}
        onlyRenderVisibleElements={false}
        panOnDrag={!isLassoSelecting}
        connectionRadius={50}
        snapToGrid={false}
        snapGrid={[1, 1]}
        style={{ background: '#f8fafc' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#ddd" />
        <Controls />
        <MiniMap />
        
        {/* Lasso selection rectangle */}
        {isLassoSelecting && lassoStart && lassoEnd && (() => {
          // Convert viewport coordinates to container-relative coordinates
          const rect = reactFlowWrapperRef.current?.getBoundingClientRect();
          const offsetX = rect?.left || 0;
          const offsetY = rect?.top || 0;
          
          const startX = lassoStart.x - offsetX;
          const startY = lassoStart.y - offsetY;
          const endX = lassoEnd.x - offsetX;
          const endY = lassoEnd.y - offsetY;
          
          return (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 1000,
                pointerEvents: 'auto',
              }}
              onMouseUp={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // Don't call handleMouseUp here - let the global handler do it once
              }}
              onMouseDown={(e) => {
                // ensure pane doesn't treat this as a click
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: Math.min(startX, endX),
                  top: Math.min(startY, endY),
                  width: Math.abs(endX - startX),
                  height: Math.abs(endY - startY),
                  border: '2px dashed #007bff',
                  background: 'rgba(0, 123, 255, 0.1)',
                  pointerEvents: 'none',
                }}
              />
            </div>
          );
        })()}

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
          {/* Properties option */}
          <div
            onClick={(e) => {
              e.stopPropagation();
              // Select the node first, then open Properties panel
              onSelectedNodeChange(nodeContextMenu.nodeId);
              // Dispatch event to open Properties panel
              window.dispatchEvent(new CustomEvent('dagnet:openPropertiesPanel'));
              setNodeContextMenu(null);
            }}
            style={{
              padding: '8px 12px',
              cursor: 'pointer',
              fontSize: '13px',
              borderRadius: '2px',
              borderBottom: '1px solid #eee'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
          >
            📝 Properties
          </div>
          
          {/* Hide/Unhide option */}
          {(() => {
            // Get all selected nodes (including the context menu target)
            // For ReactFlow nodes, n.id IS the uuid
            const selectedNodes = nodes.filter(n => n.selected || n.id === nodeContextMenu.nodeId || n.data?.id === nodeContextMenu.nodeId);
            // hiddenNodes are stored by human-readable ID, not UUID
            const selectedNodeIds = selectedNodes.map(n => n.data?.id || n.id);
            const allHidden = selectedNodeIds.every(id => activeTabId && tabOperations.isNodeHidden(activeTabId, id));
            const someHidden = selectedNodeIds.some(id => activeTabId && tabOperations.isNodeHidden(activeTabId, id));
            const isMultiSelect = selectedNodeIds.length > 1;
            
            if (allHidden) {
              // All selected nodes are hidden - show "Show" option
              return (
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    if (activeTabId) {
                      selectedNodeIds.forEach(nodeId => {
                        tabOperations.unhideNode(activeTabId, nodeId);
                      });
                    }
                    setNodeContextMenu(null);
                  }}
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    fontSize: '13px',
                    color: '#28a745',
                    borderRadius: '2px'
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                >
                  👁️ Show {isMultiSelect ? `${selectedNodeIds.length} nodes` : 'node'}
                </div>
              );
            } else {
              // At least one node is visible - show "Hide" option
              return (
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    if (activeTabId) {
                      selectedNodeIds.forEach(nodeId => {
                        tabOperations.hideNode(activeTabId, nodeId);
                      });
                    }
                    setNodeContextMenu(null);
                  }}
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    fontSize: '13px',
                    color: '#6c757d',
                    borderRadius: '2px'
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                >
                  🙈 Hide {isMultiSelect ? `${selectedNodeIds.length} nodes` : 'node'}
                </div>
              );
            }
          })()}
          
          {/* Delete option */}
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
            <ProbabilityInput
                value={contextMenuLocalData?.probability || 0}
              onChange={(value) => {
                  setContextMenuLocalData(prev => prev ? { ...prev, probability: value } : null);
              }}
              onCommit={(value) => {
                    if (graph) {
                      const nextGraph = structuredClone(graph);
                      const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeContextMenu.edgeId || e.id === edgeContextMenu.edgeId);
                      if (edgeIndex >= 0) {
                        nextGraph.edges[edgeIndex].p = { ...nextGraph.edges[edgeIndex].p, mean: value };
                        if (nextGraph.metadata) {
                          nextGraph.metadata.updated_at = new Date().toISOString();
                        }
                        setGraph(nextGraph);
                    saveHistoryState('Update edge probability', undefined, edgeContextMenu.edgeId);
                  }
                }
              }}
              onRebalance={(value) => {
                if (graph) {
                  const currentEdge = graph.edges.find((e: any) => e.uuid === edgeContextMenu.edgeId || e.id === edgeContextMenu.edgeId);
                  if (!currentEdge) return;
                  
                  const siblings = graph.edges.filter((e: any) => {
                    // Check if this is NOT the current edge (compare both uuid and id)
                    const isCurrentEdge = (e.uuid === currentEdge.uuid && e.uuid) || (e.id === currentEdge.id && e.id);
                    if (isCurrentEdge) return false;
                    
                    if (currentEdge.case_id && currentEdge.case_variant) {
                      return e.from === currentEdge.from && 
                             e.case_id === currentEdge.case_id && 
                             e.case_variant === currentEdge.case_variant;
                    }
                    return e.from === currentEdge.from;
                  });
                  
                  if (siblings.length > 0) {
                    const nextGraph = structuredClone(graph);
                    const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeContextMenu.edgeId || e.id === edgeContextMenu.edgeId);
                    if (edgeIndex >= 0) {
                      nextGraph.edges[edgeIndex].p = { ...nextGraph.edges[edgeIndex].p, mean: value };
                    
                      const remainingProbability = roundTo4DP(1 - value);
                    const siblingsTotal = siblings.reduce((sum, sibling) => sum + (sibling.p?.mean || 0), 0);
                    
                    if (siblingsTotal > 0) {
                      siblings.forEach(sibling => {
                        const siblingIndex = nextGraph.edges.findIndex((e: any) => (e.uuid === sibling.uuid && e.uuid) || (e.id === sibling.id && e.id));
                        if (siblingIndex >= 0) {
                          const siblingCurrentValue = sibling.p?.mean || 0;
                          const newValue = (siblingCurrentValue / siblingsTotal) * remainingProbability;
                          nextGraph.edges[siblingIndex].p = { ...nextGraph.edges[siblingIndex].p, mean: newValue };
                        }
                      });
                    } else {
                      const equalShare = remainingProbability / siblings.length;
                      siblings.forEach(sibling => {
                        const siblingIndex = nextGraph.edges.findIndex((e: any) => (e.uuid === sibling.uuid && e.uuid) || (e.id === sibling.id && e.id));
                        if (siblingIndex >= 0) {
                          nextGraph.edges[siblingIndex].p = { ...nextGraph.edges[siblingIndex].p, mean: equalShare };
                        }
                      });
                    }
                    
                    if (nextGraph.metadata) {
                      nextGraph.metadata.updated_at = new Date().toISOString();
                    }
                    setGraph(nextGraph);
                      saveHistoryState('Update and balance edge probabilities', undefined, edgeContextMenu.edgeId);
                    }
                  }
                }
              }}
              onClose={() => {
                setEdgeContextMenu(null);
                setContextMenuLocalData(null);
              }}
              autoFocus={true}
              autoSelect={true}
              showSlider={true}
              showBalanceButton={true}
            />
          </div>


          {/* Conditional Probability editing section */}
          {(() => {
            const edge = graph?.edges?.find((e: any) => e.uuid === edgeContextMenu.edgeId || e.id === edgeContextMenu.edgeId);
            return edge?.conditional_p && edge.conditional_p.length > 0;
          })() && (
            <div style={{ marginBottom: '12px' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', marginBottom: '4px', color: '#333' }}>
                Conditional Probabilities
              </label>
              {(() => {
                const edge = graph?.edges?.find((e: any) => e.uuid === edgeContextMenu.edgeId || e.id === edgeContextMenu.edgeId);
                return edge?.conditional_p?.map((condP: any, cpIndex: number) => (
                  <div key={cpIndex} style={{ marginBottom: '8px', padding: '6px', border: '1px solid #eee', borderRadius: '3px' }}>
                    <div style={{ fontSize: '10px', color: '#666', marginBottom: '4px' }}>
                      Condition: {condP.condition.visited.join(', ') || 'None'}
                    </div>
                    <ProbabilityInput
                        value={condP.p.mean}
                      onChange={(value) => {
                          if (graph) {
                            const nextGraph = structuredClone(graph);
                            const edgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeContextMenu.edgeId || e.id === edgeContextMenu.edgeId);
                            if (edgeIndex >= 0 && nextGraph.edges[edgeIndex].conditional_p) {
                            nextGraph.edges[edgeIndex].conditional_p[cpIndex].p.mean = value;
                              if (nextGraph.metadata) {
                                nextGraph.metadata.updated_at = new Date().toISOString();
                              }
                              setGraph(nextGraph);
                            }
                          }
                        }}
                      onCommit={(value) => {
                        // Already committed via onChange above
                      }}
                        onRebalance={(value) => {
                              if (graph) {
                          const currentEdge = graph.edges.find((e: any) => e.uuid === edgeContextMenu.edgeId || e.id === edgeContextMenu.edgeId);
                          if (!currentEdge || !currentEdge.conditional_p) return;
                          
                          const siblings = graph.edges.filter((e: any) => {
                            if (currentEdge.case_id && currentEdge.case_variant) {
                              return e.id !== currentEdge.id && 
                                     e.from === currentEdge.from && 
                                     e.case_id === currentEdge.case_id && 
                                     e.case_variant === currentEdge.case_variant;
                            }
                            return e.id !== currentEdge.id && e.from === currentEdge.from;
                          });
                          
                          if (siblings.length > 0) {
                            const nextGraph = structuredClone(graph);
                            const currentValue = value;
                            const remainingProbability = roundTo4DP(1 - currentValue);
                            
                            const currentEdgeIndex = nextGraph.edges.findIndex((e: any) => e.uuid === edgeContextMenu.edgeId || e.id === edgeContextMenu.edgeId);
                            if (currentEdgeIndex >= 0 && nextGraph.edges[currentEdgeIndex].conditional_p) {
                              nextGraph.edges[currentEdgeIndex].conditional_p[cpIndex].p.mean = currentValue;
                              
                              
                              // Get the current condition key to match siblings with the same condition
                              const currentCondition = currentEdge.conditional_p[cpIndex];
                              const conditionKey = JSON.stringify(currentCondition.condition.visited.sort());
                              
                              // Filter siblings to only those with the same condition
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
                                  const siblingIndex = nextGraph.edges.findIndex((e: any) => (e.uuid === sibling.uuid && e.uuid) || (e.id === sibling.id && e.id));
                                  if (siblingIndex >= 0) {
                                    const matchingCondition = sibling.conditional_p?.find((cp: any) => 
                                      JSON.stringify(cp.condition.visited.sort()) === conditionKey
                                    );
                                      if (matchingCondition && sibling.conditional_p) {
                                        const conditionIndex = sibling.conditional_p.findIndex((cp: any) => 
                                        JSON.stringify(cp.condition.visited.sort()) === conditionKey
                                      );
                                        if (conditionIndex >= 0) {
                                        const siblingCurrentValue = matchingCondition.p?.mean || 0;
                                        const newValue = (siblingCurrentValue / siblingsTotal) * remainingProbability;
                                          if (nextGraph.edges[siblingIndex].conditional_p) {
                                        nextGraph.edges[siblingIndex].conditional_p[conditionIndex].p.mean = newValue;
                                          }
                                      }
                                    }
                                  }
                                });
                              } else {
                                // If siblings have no probability for this condition, distribute equally
                                const equalShare = remainingProbability / siblingsWithSameCondition.length;
                                siblingsWithSameCondition.forEach(sibling => {
                                  const siblingIndex = nextGraph.edges.findIndex((e: any) => (e.uuid === sibling.uuid && e.uuid) || (e.id === sibling.id && e.id));
                                  if (siblingIndex >= 0) {
                                    const matchingCondition = sibling.conditional_p?.find((cp: any) => 
                                      JSON.stringify(cp.condition.visited.sort()) === conditionKey
                                    );
                                      if (matchingCondition && sibling.conditional_p) {
                                        const conditionIndex = sibling.conditional_p.findIndex((cp: any) => 
                                        JSON.stringify(cp.condition.visited.sort()) === conditionKey
                                      );
                                        if (conditionIndex >= 0) {
                                          if (nextGraph.edges[siblingIndex].conditional_p) {
                                        nextGraph.edges[siblingIndex].conditional_p[conditionIndex].p.mean = equalShare;
                                          }
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
                              saveHistoryState('Auto-rebalance conditional probabilities', undefined, edgeContextMenu.edgeId);
                            }
                          }
                        }
                      }}
                      onClose={() => {
                        setEdgeContextMenu(null);
                        setContextMenuLocalData(null);
                      }}
                      autoFocus={false}
                      autoSelect={false}
                      showSlider={true}
                      showBalanceButton={true}
                    />
                  </div>
                ));
              })()}
            </div>
          )}

          {/* Variant Weight editing for case edges */}
          {(() => {
            const edge = graph?.edges?.find((e: any) => e.uuid === edgeContextMenu.edgeId || e.id === edgeContextMenu.edgeId);
            return edge?.case_id && edge?.case_variant;
          })() && (() => {
            const edge = graph?.edges?.find((e: any) => e.uuid === edgeContextMenu.edgeId || e.id === edgeContextMenu.edgeId);
            const caseNode = graph?.nodes?.find((n: any) => n.case?.id === edge?.case_id);
            const variant = caseNode?.case?.variants?.find((v: any) => v.name === edge?.case_variant);
            const variantIndex = caseNode?.case?.variants?.findIndex((v: any) => v.name === edge?.case_variant) ?? -1;
            const allVariants = caseNode?.case?.variants || [];
            
            return variant && (
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', marginBottom: '4px', color: '#333' }}>
                  Variant Weight ({edge?.case_variant})
                </label>
                <VariantWeightInput
                    value={variant.weight}
                  onChange={(value) => {
                    // Optional: update local state if needed
                  }}
                  onCommit={(value) => {
                    if (graph && edge) {
                          const nextGraph = structuredClone(graph);
                        const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.case?.id === edge?.case_id);
                        if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
                        const vIdx = nextGraph.nodes[nodeIndex].case.variants.findIndex((v: any) => v.name === edge?.case_variant);
                        if (vIdx >= 0) {
                          nextGraph.nodes[nodeIndex].case.variants[vIdx].weight = value;
                              if (nextGraph.metadata) {
                                nextGraph.metadata.updated_at = new Date().toISOString();
                              }
                              setGraph(nextGraph);
                          saveHistoryState('Update variant weight', caseNode?.id);
                        }
                      }
                    }
                  }}
                  onRebalance={(value, currentIndex, variants) => {
                    if (graph && edge) {
                      const nextGraph = structuredClone(graph);
                      const nodeIndex = nextGraph.nodes.findIndex((n: any) => n.case?.id === edge?.case_id);
                      if (nodeIndex >= 0 && nextGraph.nodes[nodeIndex].case?.variants) {
                        const vIdx = nextGraph.nodes[nodeIndex].case.variants.findIndex((v: any) => v.name === edge?.case_variant);
                        if (vIdx >= 0) {
                          nextGraph.nodes[nodeIndex].case.variants[vIdx].weight = value;
                          
                          const remainingWeight = 1 - value;
                          const otherVariants = variants.filter((v: any, i: number) => i !== vIdx);
                          const otherVariantsTotal = otherVariants.reduce((sum, v) => sum + (v.weight || 0), 0);
                          
                          if (otherVariantsTotal > 0) {
                            otherVariants.forEach(v => {
                              const otherIdx = nextGraph.nodes[nodeIndex].case!.variants!.findIndex((variant: any) => variant.name === v.name);
                              if (otherIdx !== undefined && otherIdx >= 0) {
                                const currentWeight = v.weight || 0;
                                const newWeight = (currentWeight / otherVariantsTotal) * remainingWeight;
                                nextGraph.nodes[nodeIndex].case!.variants![otherIdx].weight = newWeight;
                              }
                            });
                          } else {
                            const equalShare = remainingWeight / otherVariants.length;
                            otherVariants.forEach(v => {
                              const otherIdx = nextGraph.nodes[nodeIndex].case!.variants!.findIndex((variant: any) => variant.name === v.name);
                              if (otherIdx !== undefined && otherIdx >= 0) {
                                nextGraph.nodes[nodeIndex].case!.variants![otherIdx].weight = equalShare;
                              }
                            });
                          }
                          
                          if (nextGraph.metadata) {
                            nextGraph.metadata.updated_at = new Date().toISOString();
                          }
                          setGraph(nextGraph);
                          saveHistoryState('Update and balance variant weights', caseNode?.id);
                        }
                      }
                    }
                  }}
                  onClose={() => {
                    setEdgeContextMenu(null);
                    setContextMenuLocalData(null);
                  }}
                  currentIndex={variantIndex}
                  allVariants={allVariants}
                  autoFocus={false}
                  autoSelect={false}
                  showSlider={true}
                  showBalanceButton={true}
                />
              </div>
            );
          })()}


          
          {/* Properties option */}
          <div
            onClick={(e) => {
              e.stopPropagation();
              // Dispatch event to open Properties panel
              window.dispatchEvent(new CustomEvent('dagnet:openPropertiesPanel'));
              setEdgeContextMenu(null);
            }}
            style={{
              padding: '8px 12px',
              cursor: 'pointer',
              fontSize: '13px',
              borderRadius: '2px',
              borderTop: '1px solid #eee',
              marginTop: '8px'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
          >
            📝 Properties
          </div>
          
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
              borderRadius: '2px'
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
                const sourceNode = graph?.nodes.find(n => n.uuid === pendingConnection?.source || n.id === pendingConnection?.source);
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
