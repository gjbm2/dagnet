import React, { useState, useCallback, useMemo, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { EdgeProps, getBezierPath, EdgeLabelRenderer, useReactFlow, MarkerType, Handle, Position, getSmoothStepPath } from 'reactflow';
import { useGraphStore } from '../../contexts/GraphStoreContext';
import { useViewPreferencesContext } from '../../contexts/ViewPreferencesContext';
import { useScenariosContextOptional } from '../../contexts/ScenariosContext';
import { useTabContext } from '../../contexts/TabContext';
import Tooltip from '@/components/Tooltip';
import { getConditionalColor, getConditionalProbabilityColor, isConditionalEdge } from '@/lib/conditionalColors';
import { computeEffectiveEdgeProbability, getEdgeWhatIfDisplay } from '@/lib/whatIf';
import { getVisitedNodeIds } from '@/lib/queryDSL';
import { calculateConfidenceBounds } from '@/utils/confidenceIntervals';
import { useEdgeBeads, EdgeBeadsRenderer } from './EdgeBeads';
import { useDecorationVisibility } from '../GraphCanvas';
import { EDGE_INSET, EDGE_INITIAL_OFFSET, CONVEX_DEPTH, CONCAVE_DEPTH, DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT, EDGE_LABEL_FONT_SIZE } from '@/lib/nodeEdgeConstants';

// Edge curvature (higher = more aggressive curves, default is 0.25)
const EDGE_CURVATURE = 0.5;

// Sankey mode curvature (lower = less velocity at faces, more horizontal)
const SANKEY_EDGE_CURVATURE = 0.3;

// Toggle between bezier (false) or smooth step (true) paths
const USE_SMOOTH_STEP = false;

// Edge blending configuration
const EDGE_OPACITY = 0.8; // Adjustable transparency (0-1)
const EDGE_BLEND_MODE = 'multiply'; // 'normal', 'multiply', 'screen', 'difference'
const USE_GROUP_BASED_BLENDING = false; // Enable scenario-specific blending

// DIAGNOSTIC: Check for nobeads mode (?nobeads URL parameter)
const NO_BEADS_MODE = new URLSearchParams(window.location.search).has('nobeads');


interface ConversionEdgeData {
  uuid: string;
  id?: string;
  parameter_id?: string; // Connected parameter from registry (probability)
  cost_gbp_parameter_id?: string; // Connected parameter from registry (GBP cost)
  cost_time_parameter_id?: string; // Connected parameter from registry (time cost)
  probability: number;
  stdev?: number;
  locked?: boolean;
  description?: string;
  // New flat cost structure
  cost_gbp?: {
    mean?: number;
    stdev?: number;
    distribution?: string;
  };
  cost_time?: {
    mean?: number;
    stdev?: number;
    distribution?: string;
  };
  // Legacy nested costs structure (for backward compatibility)
  costs?: {
    monetary?: {
      value: number;
      stdev?: number;
      distribution?: string;
      currency?: string;
    };
    time?: {
      value: number;
      stdev?: number;
      distribution?: string;
      units?: string;
    };
  };
  weight_default?: number;
  case_variant?: string; // Name of the variant this edge represents
  case_id?: string; // Reference to parent case node
  onUpdate: (id: string, data: Partial<ConversionEdgeData>) => void;
  onDelete: (id: string) => void;
  onReconnect?: (id: string, newSource?: string, newTarget?: string, newTargetHandle?: string, newSourceHandle?: string) => void;
  onDoubleClick?: (id: string, field: string) => void;
  onSelect?: (id: string) => void;
  calculateWidth?: () => number;
  sourceOffsetX?: number;
  sourceOffsetY?: number;
  targetOffsetX?: number;
  targetOffsetY?: number;
  scaledWidth?: number;
  isHighlighted?: boolean;
  highlightDepth?: number;
  isSingleNodeHighlight?: boolean;
  // What-if DSL (passed from tab state)
  whatIfDSL?: string | null;
  // Bundle metadata
  sourceBundleWidth?: number;
  targetBundleWidth?: number;
  sourceBundleSize?: number;
  targetBundleSize?: number;
  isFirstInSourceBundle?: boolean;
  isLastInSourceBundle?: boolean;
  isFirstInTargetBundle?: boolean;
  isLastInTargetBundle?: boolean;
  sourceFace?: string;
  targetFace?: string;
  // Sankey view flag
  useSankeyView?: boolean;
  // Scenario overlay data
  scenarioOverlay?: boolean;
  scenarioColor?: string;
  strokeOpacity?: number; // Opacity for scenario overlays (0-1)
  effectiveWeight?: number; // Effective probability for this scenario overlay (for dashed line rendering)
  scenarioParams?: any;
  originalEdgeId?: string; // Original edge ID for overlay edges (used for lookups)
  // Scenario rendering flags
  suppressLabel?: boolean; // Suppress label rendering for non-current overlay edges
  // Pan/zoom state to disable beads during interaction
  isPanningOrZooming?: boolean;
}

export default function ConversionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  source,
  target,
}: EdgeProps<ConversionEdgeData>) {
  // CRITICAL: Overlays should NEVER be selected, even if ReactFlow sets selected=true
  // Only 'current' layer edges can be selected
  const effectiveSelected = data?.scenarioOverlay ? false : selected;
  const scenariosContext = useScenariosContextOptional();
  const { operations: tabOps, tabs, activeTabId } = useTabContext();
  const currentTab = tabs.find(t => t.id === activeTabId);
  const scenarioState = currentTab?.editorState?.scenarioState;
  const scenarioOrder = scenarioState?.scenarioOrder || [];
  const visibleScenarioIds = scenarioState?.visibleScenarioIds || [];
  const visibleColorOrderIds = scenarioState?.visibleColorOrderIds || [];
  
  // ATOMIC RESTORATION: Read decoration visibility from context (not edge.data)
  const { beadsVisible, isPanning, isDraggingNode } = useDecorationVisibility();
  const shouldSuppressBeads = isPanning || isDraggingNode || !beadsVisible;
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [isDraggingSource, setIsDraggingSource] = useState(false);
  const [isDraggingTarget, setIsDraggingTarget] = useState(false);
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null);
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const pathRef = React.useRef<SVGPathElement>(null);
  const textPathRef = React.useRef<SVGPathElement>(null);
  const tooltipTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  // Handle mouse enter to show tooltip (with delay)
  const handleTooltipMouseEnter = useCallback((e: React.MouseEvent<SVGPathElement>) => {
    // Only show tooltips for current edges (not scenario overlays)
    if (data?.scenarioOverlay) return;
    
    // Clear any existing timeout
    if (tooltipTimeoutRef.current) {
      clearTimeout(tooltipTimeoutRef.current);
    }
    
    // Set initial position
    setTooltipPos({ x: e.clientX, y: e.clientY });
    
    // Show tooltip after delay (500ms)
    tooltipTimeoutRef.current = setTimeout(() => {
      setShowTooltip(true);
    }, 500);
  }, [data?.scenarioOverlay]);

  // Handle mouse move to update tooltip position
  const handleTooltipMouseMove = useCallback((e: React.MouseEvent<SVGPathElement>) => {
    if (data?.scenarioOverlay) return;
    
    // Update position immediately
    setTooltipPos({ x: e.clientX, y: e.clientY });
    
    // If tooltip is already showing, keep it showing
    // If not showing yet, the timeout will show it
  }, [data?.scenarioOverlay]);

  // Handle mouse leave to hide tooltip
  const handleTooltipMouseLeave = useCallback(() => {
    // Clear any pending timeout
    if (tooltipTimeoutRef.current) {
      clearTimeout(tooltipTimeoutRef.current);
      tooltipTimeoutRef.current = null;
    }
    
    setShowTooltip(false);
  }, []);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return () => {
      if (tooltipTimeoutRef.current) {
        clearTimeout(tooltipTimeoutRef.current);
      }
    };
  }, []);

  // Generate tooltip content
  const getTooltipContent = () => {
    if (!data) return 'No data available';
    
    const lines: string[] = [];
    
    // Edge id (more useful than UUID)
    if (data.id) {
      lines.push(`Edge: ${data.id}`);
    }
    
    // Probability info - show effective probability for case edges, sub-route probability otherwise
    // Check if case edge (has case_variant, infer case_id from source if needed)
    const isCaseEdgeForTooltip = fullEdge?.case_variant && (
      fullEdge?.case_id || 
      (graph?.nodes?.find((n: any) => n.uuid === fullEdge?.from || n.id === fullEdge?.from)?.type === 'case')
    );
    if (isCaseEdgeForTooltip) {
      // Case edge: show effective probability (variant weight * sub-route probability)
      lines.push(`Effective Probability: ${(effectiveProbability * 100).toFixed(1)}%`);
      lines.push(`Sub-Route Probability: ${(data.probability * 100).toFixed(1)}%`);
    } else {
      // Regular edge: show probability
      lines.push(`Probability: ${(effectiveProbability * 100).toFixed(1)}%`);
    }
    if (data.stdev) {
      lines.push(`Std Dev: ${(data.stdev * 100).toFixed(1)}%`);
    }
    
    // Case edge specific info - show variant weight
    if (data.case_variant) {
      lines.push(`\nCase Variant: ${data.case_variant}`);
      if (data.case_id) {
        lines.push(`Case ID: ${data.case_id}`);
        // Find the case node and get variant weight
        // source could be uuid OR human-readable id, check both
        const sourceNode = graph?.nodes.find((n: any) => n.uuid === source || n.id === source);
        if (sourceNode?.type === 'case' && sourceNode?.case?.id === data.case_id) {
          const variant = sourceNode.case.variants?.find((v: any) => v.name === data.case_variant);
          if (variant) {
            lines.push(`Variant Weight: ${(variant.weight * 100).toFixed(1)}%`);
          }
        }
      }
    }
    
    // Conditional probabilities
    if (fullEdge?.conditional_p && fullEdge.conditional_p.length > 0) {
      lines.push(`\nConditional Probabilities:`);
      for (const cond of fullEdge.conditional_p) {
        const nodeNames = getVisitedNodeIds(cond.condition).map((nodeId: string) => {
          const node = graph?.nodes.find((n: any) => n.uuid === nodeId || n.id === nodeId);
          return node?.id || node?.label || nodeId;
        }).join(', ');
        const condProb = ((cond.p.mean ?? 0) * 100).toFixed(1);
        lines.push(`  • p | visited(${nodeNames}): ${condProb}%`);
        if (cond.p.stdev) {
          lines.push(`    σ: ${(cond.p.stdev * 100).toFixed(1)}%`);
        }
      }
    }
    
    // Description
    if (data.description) {
      lines.push(`\nDescription: ${data.description}`);
    }
    
    // Costs (new flat schema)
    if (data.cost_gbp || data.cost_time) {
      lines.push('\nCosts:');
      if (data.cost_gbp) {
        lines.push(`  Monetary: £${data.cost_gbp.mean?.toFixed(2) || 0}`);
        if (data.cost_gbp.stdev) {
          lines.push(`    (±£${data.cost_gbp.stdev.toFixed(2)})`);
        }
      }
      if (data.cost_time) {
        lines.push(`  Time: ${data.cost_time.mean?.toFixed(1) || 0} days`);
        if (data.cost_time.stdev) {
          lines.push(`    (±${data.cost_time.stdev.toFixed(1)} days)`);
        }
      }
    }
    
  // Weight default
  if (data.weight_default !== undefined) {
    lines.push(`\nDefault Weight: ${data.weight_default}`);
  }
  
  // Evidence
  if (fullEdge?.p?.evidence) {
    const evidence = fullEdge.p.evidence;
    const evidenceParts: string[] = [];
    
    if (evidence.n !== undefined) evidenceParts.push(`n=${evidence.n}`);
    if (evidence.k !== undefined) evidenceParts.push(`k=${evidence.k}`);
    
    // Debug: Show naive p (k/n) and part pooled p
    if (evidence.n !== undefined && evidence.k !== undefined && evidence.n > 0) {
      const naiveP = evidence.k / evidence.n;
      evidenceParts.push(`naive p=${(naiveP * 100).toFixed(2)}%`);
      
      // Part pooled p (inverse-variance weighted) - calculate if we have daily data
      // For now, we'll show naive p. Part pooled would require daily time-series data
      // which isn't stored on the graph edge (only in parameter files)
      // TODO: Could fetch from parameter file if parameter_id exists
    }
    
    if (evidence.window_from && evidence.window_to) {
      const from = new Date(evidence.window_from).toLocaleDateString();
      const to = new Date(evidence.window_to).toLocaleDateString();
      evidenceParts.push(`Window: ${from} - ${to}`);
    }
    if (evidence.source) evidenceParts.push(`Source: ${evidence.source}`);
    
    if (evidenceParts.length > 0) {
      lines.push(`\nEvidence: ${evidenceParts.join(', ')}`);
    }
  }
  
  return lines.join('\n');
};
  const { deleteElements, setEdges, getNodes, getEdges, screenToFlowPosition } = useReactFlow();
  const { graph } = useGraphStore();
  const viewPrefs = useViewPreferencesContext();
  
  // What-if DSL is now passed through edge.data (from tab state)
  const whatIfDSL = data?.whatIfDSL;
  useEffect(() => {
    console.log(`[ConversionEdge ${id}] render with whatIfDSL:`, whatIfDSL);
  }, [id, whatIfDSL]);
  
  // Get the full edge object from graph (needed for tooltips and colors)
  // Find edge in graph (check both uuid and human-readable id after Phase 0.0 migration)
  // For overlay edges, use originalEdgeId stored in data
  // Memoize to ensure it updates when graph changes
  const lookupId = data?.originalEdgeId || id;
  const fullEdge = useMemo(() => {
    return graph?.edges.find((e: any) => 
      e.uuid === lookupId ||           // ReactFlow uses UUID as edge ID
      e.id === lookupId ||             // Human-readable ID
      `${e.from}->${e.to}` === lookupId  // Fallback format
    );
  }, [graph, lookupId, graph?.edges?.map(e => `${e.uuid}-${JSON.stringify(e.conditional_p)}`).join(',')]);
  
  // Get variant weights string for dependency tracking (for case edges)
  // This must be calculated directly from graph, not from fullEdge, to ensure it updates
  const variantWeightsKey = useMemo(() => {
    if (!graph) return '';
    const currentEdge = graph.edges.find((e: any) => 
      e.uuid === lookupId || e.id === lookupId || `${e.from}->${e.to}` === lookupId
    );
    if (!currentEdge?.case_variant) return '';
    
    // Infer case_id from source node if not set
    let caseId = currentEdge.case_id;
    if (!caseId) {
      const sourceNode = graph.nodes.find((n: any) => n.uuid === currentEdge.from || n.id === currentEdge.from);
      if (sourceNode?.type === 'case') {
        caseId = sourceNode.case?.id || sourceNode.uuid || sourceNode.id;
      }
    }
    
    if (!caseId) return '';
    
    // Find the case node (check case.id, uuid, or id)
    const caseNode = graph.nodes.find((n: any) => 
      n.type === 'case' && (
        n.case?.id === caseId || 
        n.uuid === caseId || 
        n.id === caseId
      )
    );
    if (!caseNode?.case?.variants) return '';
    // Create a key that changes when any variant weight changes
    return caseNode.case.variants.map((v: any) => `${v.name}-${v.weight}`).join(',');
  }, [
    graph, 
    lookupId,
    // Explicitly depend on variant weights from all case nodes to catch changes
    graph?.nodes?.filter((n: any) => n.type === 'case').map((n: any) => 
      n.case?.variants?.map((v: any) => `${v.name}-${v.weight}`).join(',') || ''
    ).join('|')
  ]);
  
  // UNIFIED: Compute effective probability using shared logic
  const effectiveProbability = useMemo(() => {
    if (!graph) return 0;
    return computeEffectiveEdgeProbability(graph, lookupId, { whatIfDSL });
  }, [
    lookupId, 
    whatIfDSL, 
    // Depend on the entire graph object so it recalculates when variant weights change
    graph,
    // Also explicitly depend on the edge's p.mean and case_id/case_variant
    graph?.edges?.find(e => e.uuid === lookupId || e.id === lookupId)?.p?.mean,
    graph?.edges?.find(e => e.uuid === lookupId || e.id === lookupId)?.case_id,
    graph?.edges?.find(e => e.uuid === lookupId || e.id === lookupId)?.case_variant,
    // Depend on variant weights for the case node (if this is a case edge)
    variantWeightsKey
  ]);

  // For dashed lines, we need the actual effective weight (flow-based), not just What-If overrides
  const effectiveWeight = useMemo(() => {
    // Calculate the actual probability mass flowing through this edge
    // This is the same logic used in calculateEdgeWidth for global-mass mode
    if (graph?.nodes && graph?.edges) {
      // Find the start node
      const startNode = graph.nodes.find((n: any) => 
        n.entry?.is_start === true || (n.entry?.entry_weight || 0) > 0
      );
      
      if (startNode) {
        // Calculate residual probability at the source node
        const calculateResidualProbability = (nodeId: string, edges: any[], startNodeUuid: string, startNodeId: string): number => {
          // Check if we're at the start node (nodeId could be uuid OR id)
          if (nodeId === startNodeUuid || nodeId === startNodeId) return 1.0;
          
          // Find all edges leading to this node
          const incomingEdges = edges.filter(e => e.to === nodeId);
          if (incomingEdges.length === 0) return 0;
          
          // Sum up the mass from all incoming edges
          let totalMass = 0;
          for (const incomingEdge of incomingEdges) {
            const sourceResidual = calculateResidualProbability(incomingEdge.from, edges, startNodeUuid, startNodeId);
            // Edge lookup by uuid or id (Phase 0.0 migration)
            const edgeProb = computeEffectiveEdgeProbability(graph, incomingEdge.uuid || incomingEdge.id, { whatIfDSL });
            totalMass += sourceResidual * edgeProb;
          }
          return totalMass;
        };
        
        // Pass both uuid and id so the function can match either format
        const residualAtSource = fullEdge?.from ? calculateResidualProbability(fullEdge.from, graph.edges, startNode.uuid, startNode.id) : 0;
        const actualMassFlowing = residualAtSource * effectiveProbability;
        
        return actualMassFlowing;
      }
    }
    
    // Fallback to effective probability if no flow calculation available
    return effectiveProbability;
  }, [graph, fullEdge?.from, effectiveProbability, whatIfDSL, graph?.edges?.map(e => `${e.uuid}-${e.p?.mean}`).join(',')]);
  
  // UNIFIED: Get what-if display info using shared logic
  const whatIfDisplay = useMemo(() => {
    return getEdgeWhatIfDisplay(graph, lookupId, { whatIfDSL }, null);
  }, [graph, lookupId, whatIfDSL]);
  
  // Get scenario colors for beads
  const scenarioColors = useMemo(() => {
    const colorMap = new Map<string, string>();
    
    // Ensure we have at least 'current' if no scenarios visible
    const effectiveVisibleIds = visibleScenarioIds.length > 0 ? visibleScenarioIds : ['current'];
    const effectiveColorOrderIds = visibleColorOrderIds.length > 0 ? visibleColorOrderIds : ['current'];
    
    if (scenariosContext) {
      effectiveVisibleIds.forEach((id) => {
        const orderIdx = effectiveColorOrderIds.indexOf(id);
        if (orderIdx >= 0) {
          // Use color from scenarios context or assign based on order
          const scenario = scenariosContext.scenarios?.find((s: any) => s.id === id);
          if (scenario?.color) {
            colorMap.set(id, scenario.color);
          } else if (id === 'current' && scenariosContext.currentColor) {
            colorMap.set(id, scenariosContext.currentColor);
          } else if (id === 'base' && scenariosContext.baseColor) {
            colorMap.set(id, scenariosContext.baseColor);
          } else {
            // Fallback: assign color based on order
            const colors = ['#3b82f6', '#f97316', '#8b5cf6', '#ec4899', '#10b981'];
            colorMap.set(id, colors[orderIdx % colors.length]);
          }
        } else {
          // If not in color order, use default
          if (id === 'current') {
            colorMap.set(id, scenariosContext.currentColor || '#000000');
          } else {
            colorMap.set(id, '#000000');
          }
        }
      });
    } else {
      // No scenarios context - use defaults
      effectiveVisibleIds.forEach((id) => {
        colorMap.set(id, id === 'current' ? '#000000' : '#808080');
      });
    }
    
    return colorMap;
  }, [scenariosContext, visibleScenarioIds, visibleColorOrderIds]);
  
  // Calculate stroke width using useMemo to enable CSS transitions
  const strokeWidth = useMemo(() => {
    // Use scaledWidth if available (for mass-based scaling modes), otherwise fall back to calculateWidth
    if (data?.scaledWidth !== undefined) {
      return data.scaledWidth;
    }
    if (data?.calculateWidth) {
      const width = data.calculateWidth();
      if (id && id.includes('node-2')) {
        console.log(`[RENDER] Edge ${id}: using calculateWidth=${width}, prob=${data?.probability}`);
      }
      return width;
    }
    if (selected) return 3;
    if (data?.probability === undefined || data?.probability === null) return 3;
    return 2;
  }, [data?.scaledWidth, data?.calculateWidth, data?.probability, selected, graph, whatIfDSL]);
  
  // Confidence interval rendering logic
  const confidenceIntervalLevel = viewPrefs?.confidenceIntervalLevel ?? 'none';
  // For scenario overlays, use scenario-specific stdev (do NOT fallback to current layer)
  // For current layer, use edge stdev directly
  // Note: React state can sometimes hold stale stdev values from previous graphs/scenarios
  // until a full refresh - the logic below should handle this correctly when state is fresh
  const stdev = data?.scenarioOverlay 
    ? (data?.stdev ?? 0) 
    : (fullEdge?.p?.stdev ?? data?.stdev ?? 0);
  const hasStdev = stdev !== undefined && stdev > 0;
  const shouldShowConfidenceIntervals = 
    confidenceIntervalLevel !== 'none' && 
    hasStdev && 
    !viewPrefs?.useUniformScaling && // Skip if uniform scaling is enabled
    !data?.useSankeyView; // Skip in Sankey view
  
  // Helper function to convert hex to RGB (must be defined before useMemo)
  const hexToRgb = (hex: string) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 153, g: 153, b: 153 }; // fallback to gray
  };
  
  // Edge color logic: highlight/selection shading
  // Case/conditional edge colors now shown as markers, not full edge coloring
  const edgeColor = useMemo(() => {
    // Selected edges: darker gray to distinguish from highlighted edges
    if (effectiveSelected) {
      return '#222'; // very dark gray for selection
    }
    if (data?.isHighlighted) {
      // Different opacity for different selection types:
      // - Single node (isSingleNodeHighlight=true): 30% fading with depth
      // - Multi-node topological (isSingleNodeHighlight=false): 50% solid
      let blackIntensity: number;
      
      if (data.isSingleNodeHighlight) {
        // Single node selection: Start at 30%, fade by 10% per hop
        const depth = data.highlightDepth || 0;
        blackIntensity = 0.3 * Math.pow(0.9, depth); // 30% × 0.9^depth
      } else {
        // Multi-node topological selection: 50% solid
        blackIntensity = 0.5;
      }
      
      // Blend scenario color with black for highlight
      const baseColorHex = data?.scenarioColor || '#b3b3b3';
      const black = { r: 0, g: 0, b: 0 };
      const baseColorRgb = hexToRgb(baseColorHex);
      
      const blendedR = Math.round(black.r * blackIntensity + baseColorRgb.r * (1 - blackIntensity));
      const blendedG = Math.round(black.g * blackIntensity + baseColorRgb.g * (1 - blackIntensity));
      const blendedB = Math.round(black.b * blackIntensity + baseColorRgb.b * (1 - blackIntensity));
      
      return `rgb(${blendedR}, ${blendedG}, ${blendedB})`;
    }
    
    // Default: use scenario color
    return data?.scenarioColor || '#b3b3b3';
  }, [effectiveSelected, data?.isHighlighted, data?.highlightDepth, data?.isSingleNodeHighlight, data?.scenarioColor]);
  
  const getEdgeColor = () => edgeColor;

  // Band opacity schema – experimental: very low opacities
  // Outer: 0.1, Middle: 0.4, Inner: 0.5
  const calculateBandOpacities = (level: '80' | '90' | '95' | '99') => {
    const inner = 0.15;
    const middle = 0.55;
    // Outer could scale slightly with CI level, but keeping it simple for now
    const outer = 0.15;
    return { inner, middle, outer };
  };

  // Calculate confidence bounds and colors if needed
  const confidenceData = useMemo(() => {
    if (!shouldShowConfidenceIntervals) return null;
    
    // For scenario overlays, use scenario-specific probability (do NOT bleed from current layer)
    // For current layer, use effectiveProbability (which includes what-if logic)
    const mean = data?.scenarioOverlay 
      ? (data?.probability ?? 0)
      : (effectiveProbability ?? 0);
    if (mean <= 0) return null; // Can't calculate widths if mean is 0
    
    // Get distribution from appropriate layer (do NOT bleed from current layer to overlays)
    const distribution = data?.scenarioOverlay
      ? ((data as any)?.distribution || 'beta') as 'normal' | 'beta' | 'uniform'
      : (fullEdge?.p?.distribution || 'beta') as 'normal' | 'beta' | 'uniform';
    
    const bounds = calculateConfidenceBounds(mean, stdev, confidenceIntervalLevel as '80' | '90' | '95' | '99', distribution);
    const opacities = calculateBandOpacities(confidenceIntervalLevel as '80' | '90' | '95' | '99');
    
    // Calculate stroke widths with proper mass generosity scaling
    // The strokeWidth already has the log scaling applied: width = MIN_WIDTH + Math.pow(actualMass, 1-g) * (MAX_WIDTH - MIN_WIDTH)
    // We need to reverse the scaling, apply bounds, then re-scale each bound separately
    
    const massGenerosity = viewPrefs?.massGenerosity ?? 0;
    const MIN_WIDTH = 0.5;
    const MAX_WIDTH = 50;
    
    let widthUpper, widthMiddle, widthLower;
    
    if (massGenerosity === 0) {
      // No log scaling - simple linear scaling by probability ratio
      widthUpper = strokeWidth * (bounds.upper / mean);
      widthMiddle = strokeWidth;
      widthLower = strokeWidth * (bounds.lower / mean);
    } else {
      // Reverse the scaling to get actual mass
      const displayMass = (strokeWidth - MIN_WIDTH) / (MAX_WIDTH - MIN_WIDTH);
      const actualMass = Math.pow(displayMass, 1 / (1 - massGenerosity));
      
      // Calculate actual masses for upper and lower bounds
      const actualMassUpper = actualMass * (bounds.upper / mean);
      const actualMassLower = actualMass * (bounds.lower / mean);
      
      // Apply log scaling to each bound
      const displayMassUpper = Math.pow(actualMassUpper, 1 - massGenerosity);
      const displayMassLower = Math.pow(actualMassLower, 1 - massGenerosity);
      
      // Convert back to widths
      widthUpper = MIN_WIDTH + displayMassUpper * (MAX_WIDTH - MIN_WIDTH);
      widthMiddle = strokeWidth;
      widthLower = MIN_WIDTH + displayMassLower * (MAX_WIDTH - MIN_WIDTH);
    }
    
    // Debug logging (remove after testing)
    if (id.includes('test') || id.includes('project')) {
      console.log(`[CI ${id}] mean=${mean.toFixed(3)}, stdev=${stdev.toFixed(3)}, bounds=`, bounds, 
        `widths=`, {upper: widthUpper.toFixed(1), middle: widthMiddle.toFixed(1), lower: widthLower.toFixed(1)},
        `opacities=`, opacities);
    }
    
    return {
      bounds,
      opacities,
      widths: {
        upper: Math.max(1, widthUpper),
        middle: Math.max(1, widthMiddle),
        lower: Math.max(1, widthLower)
      }
    };
  }, [shouldShowConfidenceIntervals, effectiveProbability, data?.probability, stdev, confidenceIntervalLevel, strokeWidth, id, viewPrefs?.massGenerosity, fullEdge?.p?.distribution, data?.scenarioOverlay, (data as any)?.distribution]);
  
  // Update stroke-width via DOM to enable CSS transitions
  React.useEffect(() => {
    if (pathRef.current) {
      const currentWidth = (shouldShowConfidenceIntervals && confidenceData)
        ? confidenceData.widths.lower
        : strokeWidth;
      pathRef.current.style.strokeWidth = `${currentWidth}px`;
    }
  }, [strokeWidth, shouldShowConfidenceIntervals, confidenceData?.widths.lower]);
  
  const isCaseEdge = (() => {
    // Check if edge has case_variant
    if (!fullEdge?.case_variant && !data?.case_variant) return false;
    
    // Check if case_id is set, or if source node is a case node
    const hasCaseId = fullEdge?.case_id || data?.case_id;
    if (hasCaseId) return true;
    
    // Infer from source node
    const sourceNode = graph?.nodes?.find((n: any) => 
      n.uuid === fullEdge?.from || n.id === fullEdge?.from
    );
    return sourceNode?.type === 'case';
  })();

  // Apply offsets to source and target positions for Sankey-style visualization
  const sourceOffsetX = data?.sourceOffsetX || 0;
  const sourceOffsetY = data?.sourceOffsetY || 0;
  const targetOffsetX = data?.targetOffsetX || 0;
  const targetOffsetY = data?.targetOffsetY || 0;
  
  // Base anchor positions at the nominal node face (ReactFlow's boundary + offsets)
  const baseSourceX = sourceX + sourceOffsetX;
  const baseSourceY = sourceY + sourceOffsetY;
  const baseTargetX = targetX + targetOffsetX;
  const baseTargetY = targetY + targetOffsetY;

  // For concave faces we want the rendered edge start/end points further under the node,
  // BUT we don't want to move the control points under the node.
  // So:
  // - start/end of the path are pulled under the node by halo width,
  // - control points are computed from the base (face) positions.
  const INSET_DEEP = data?.useSankeyView ? 0 : EDGE_INSET;
  const INITIAL_OFFSET = data?.useSankeyView ? 0 : EDGE_INITIAL_OFFSET;

  let adjustedSourceX = baseSourceX;
  let adjustedSourceY = baseSourceY;
  let adjustedTargetX = baseTargetX;
  let adjustedTargetY = baseTargetY;

  if (!data?.useSankeyView) {
    // Inset source by INSET_DEEP + INITIAL_OFFSET along face normal
    const sourceInset = INSET_DEEP + INITIAL_OFFSET;
    if (sourcePosition === Position.Left) {
      adjustedSourceX += sourceInset;
    } else if (sourcePosition === Position.Right) {
      adjustedSourceX -= sourceInset;
    } else if (sourcePosition === Position.Top) {
      adjustedSourceY += sourceInset;
    } else if (sourcePosition === Position.Bottom) {
      adjustedSourceY -= sourceInset;
    }

    // Inset target by INSET_DEEP + INITIAL_OFFSET along face normal
    const targetInset = INSET_DEEP + INITIAL_OFFSET;
    if (targetPosition === Position.Left) {
      adjustedTargetX += targetInset;
    } else if (targetPosition === Position.Right) {
      adjustedTargetX -= targetInset;
    } else if (targetPosition === Position.Top) {
      adjustedTargetY += targetInset;
    } else if (targetPosition === Position.Bottom) {
      adjustedTargetY -= targetInset;
    }
  }

  // Calculate edge path (either smooth step or custom bezier)
  const [edgePath, labelX, labelY] = React.useMemo(() => {
    if (USE_SMOOTH_STEP) {
      // Use smooth step path for more angular routing
      return getSmoothStepPath({
        sourceX: adjustedSourceX,
        sourceY: adjustedSourceY,
        sourcePosition,
        targetX: adjustedTargetX,
        targetY: adjustedTargetY,
        targetPosition,
        borderRadius: 20, // Adjust for sharper/smoother corners
      });
    } else {
      // Use custom bezier path with configurable curvature
      const dx = baseTargetX - baseSourceX;
      const dy = baseTargetY - baseSourceY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      // Use lower curvature in Sankey mode for less velocity at faces
      const curvature = data?.useSankeyView ? SANKEY_EDGE_CURVATURE : EDGE_CURVATURE;
      const controlDistance = distance * curvature;

      // Calculate control points based on edge direction, starting from the FACE positions
      // Adjust control points to accommodate face curvature (convex/concave)
      // Get source and target nodes to check face directions
      const nodes = getNodes();
      const sourceNode = nodes.find(n => n.id === source);
      const targetNode = nodes.find(n => n.id === target);
      const sourceFaceDirection = sourceNode?.data?.faceDirections?.[data?.sourceFace || ''] ?? 'flat';
      const targetFaceDirection = targetNode?.data?.faceDirections?.[data?.targetFace || ''] ?? 'flat';
      
      // Base control points at nominal face positions
      let c1x = baseSourceX;
      let c1y = baseSourceY;
      let c2x = baseTargetX;
      let c2y = baseTargetY;

      // Adjust source control point for face direction and curvature
      if (sourcePosition === Position.Right) {
        // Push control point out for convex, keep at nominal for flat/concave
        const faceOffset = sourceFaceDirection === 'convex' ? CONVEX_DEPTH : 0;
        c1x = baseSourceX + controlDistance + faceOffset;
      } else if (sourcePosition === Position.Left) {
        const faceOffset = sourceFaceDirection === 'convex' ? CONVEX_DEPTH : 0;
        c1x = baseSourceX - controlDistance - faceOffset;
      } else if (sourcePosition === Position.Bottom) {
        const faceOffset = sourceFaceDirection === 'convex' ? CONVEX_DEPTH : 0;
        c1y = baseSourceY + controlDistance + faceOffset;
      } else if (sourcePosition === Position.Top) {
        const faceOffset = sourceFaceDirection === 'convex' ? CONVEX_DEPTH : 0;
        c1y = baseSourceY - controlDistance - faceOffset;
      }

      // Adjust target control point for face direction and curvature
      if (targetPosition === Position.Right) {
        const faceOffset = targetFaceDirection === 'convex' ? CONVEX_DEPTH : 0;
        c2x = baseTargetX + controlDistance + faceOffset;
      } else if (targetPosition === Position.Left) {
        const faceOffset = targetFaceDirection === 'convex' ? CONVEX_DEPTH : 0;
        c2x = baseTargetX - controlDistance - faceOffset;
      } else if (targetPosition === Position.Bottom) {
        const faceOffset = targetFaceDirection === 'convex' ? CONVEX_DEPTH : 0;
        c2y = baseTargetY + controlDistance + faceOffset;
      } else if (targetPosition === Position.Top) {
        const faceOffset = targetFaceDirection === 'convex' ? CONVEX_DEPTH : 0;
        c2y = baseTargetY - controlDistance - faceOffset;
      }

      const path = `M ${adjustedSourceX},${adjustedSourceY} C ${c1x},${c1y} ${c2x},${c2y} ${adjustedTargetX},${adjustedTargetY}`;
      
      // Calculate label position at t=0.5 on the bezier curve (not the straight line!)
      const t = 0.5;
      const mt = 1 - t;
      const labelX = mt * mt * mt * adjustedSourceX + 
                     3 * mt * mt * t * c1x + 
                     3 * mt * t * t * c2x + 
                     t * t * t * adjustedTargetX;
      const labelY = mt * mt * mt * adjustedSourceY + 
                     3 * mt * mt * t * c1y + 
                     3 * mt * t * t * c2y + 
                     t * t * t * adjustedTargetY;
      
      return [path, labelX, labelY];
    }
  }, [adjustedSourceX, adjustedSourceY, adjustedTargetX, adjustedTargetY, sourcePosition, targetPosition]);

  // Create an offset path for text to follow (parallel to edge, offset by strokeWidth/2)
  const [offsetPath, labelOffsetDirection] = React.useMemo(() => {
    if (!data?.description) return ['', -1];
    
    // Parse the Bezier path to get control points
    const nums = edgePath.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi);
    if (!nums || nums.length < 8) return [edgePath, -1];
    
    let [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = nums.slice(0, 8).map(Number);
    
    // Determine edge direction: if going right-to-left, we need to reverse the path
    // so text always reads left-to-right
    const isRightToLeft = ex < sx;
    
    // If right-to-left, reverse the path by swapping start/end and control points
    if (isRightToLeft) {
      [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = [ex, ey, c2x, c2y, c1x, c1y, sx, sy];
    }
    
    // Determine offset direction based on position in Sankey stack
    // Goal: offset away from the node centerline
    let offsetDirection = -1; // Default: upward for L-R edges
    
    if (graph && source) {
      // Get all edges from the same source node
      const sourceEdges = graph.edges.filter((e: any) => e.from === source);
      
      if (sourceEdges.length > 1) {
        // Find the vertical center of all outgoing edges
        const edgeYPositions = sourceEdges.map((e: any) => {
          const edgeId = e.id || `${e.from}->${e.to}`;
          // Get the start Y position of each edge (approximate from source node)
          return sourceY;
        });
        
        // Calculate this edge's relative position
        // Use the current edge's Y position at start
        const thisEdgeY = sy;
        
        // Get source node center Y
        const sourceNodeCenterY = sourceY;
        
        // If this edge is below the source node center, offset downward (away from center)
        // If above, offset upward (away from center)
        if (thisEdgeY > sourceNodeCenterY) {
          offsetDirection = 1; // Downward
        } else {
          offsetDirection = -1; // Upward
        }
      }
    }
    
    // Calculate offset distance with direction
    const offsetDistance = offsetDirection * (strokeWidth / 2 + 10);
    
    // For a Bezier curve, we need to offset all points perpendicular to the tangent
    // Calculate tangent at start point
    const startTangentX = c1x - sx;
    const startTangentY = c1y - sy;
    const startLen = Math.sqrt(startTangentX * startTangentX + startTangentY * startTangentY);
    const startNormalX = startLen > 0 ? -startTangentY / startLen : 0;
    const startNormalY = startLen > 0 ? startTangentX / startLen : 1;
    
    // Calculate tangent at end point
    const endTangentX = ex - c2x;
    const endTangentY = ey - c2y;
    const endLen = Math.sqrt(endTangentX * endTangentX + endTangentY * endTangentY);
    const endNormalX = endLen > 0 ? -endTangentY / endLen : 0;
    const endNormalY = endLen > 0 ? endTangentX / endLen : 1;
    
    // Calculate tangent at control point 1
    const c1TangentX = c2x - sx;
    const c1TangentY = c2y - sy;
    const c1Len = Math.sqrt(c1TangentX * c1TangentX + c1TangentY * c1TangentY);
    const c1NormalX = c1Len > 0 ? -c1TangentY / c1Len : 0;
    const c1NormalY = c1Len > 0 ? c1TangentX / c1Len : 1;
    
    // Calculate tangent at control point 2
    const c2TangentX = ex - sx;
    const c2TangentY = ey - sy;
    const c2Len = Math.sqrt(c2TangentX * c2TangentX + c2TangentY * c2TangentY);
    const c2NormalX = c2Len > 0 ? -c2TangentY / c2Len : 0;
    const c2NormalY = c2Len > 0 ? c2TangentX / c2Len : 1;
    
    // Offset all points
    const osx = sx + startNormalX * offsetDistance;
    const osy = sy + startNormalY * offsetDistance;
    const oc1x = c1x + c1NormalX * offsetDistance;
    const oc1y = c1y + c1NormalY * offsetDistance;
    const oc2x = c2x + c2NormalX * offsetDistance;
    const oc2y = c2y + c2NormalY * offsetDistance;
    const oex = ex + endNormalX * offsetDistance;
    const oey = ey + endNormalY * offsetDistance;
    
    return [`M ${osx},${osy} C ${oc1x},${oc1y} ${oc2x},${oc2y} ${oex},${oey}`, offsetDirection];
  }, [edgePath, strokeWidth, data?.description, graph, source]);

  // Calculate startOffset and anchor - ensure text starts 15% from topological source
  const textAlignment = React.useMemo<{ offset: string; anchor: 'start' | 'end' }>(() => {
    if (!data?.description) return { offset: '15%', anchor: 'start' };
    
    // Check if path was reversed
    const nums = edgePath.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi);
    if (!nums || nums.length < 8) return { offset: '15%', anchor: 'start' };
    
    const [origSx, , , , , , origEx] = nums.slice(0, 8).map(Number);
    const isRightToLeft = origEx < origSx;
    
    // If path was reversed, use 85% offset and right-align (end anchor)
    return isRightToLeft 
      ? { offset: '85%', anchor: 'end' }
      : { offset: '15%', anchor: 'start' };
  }, [data?.description, edgePath]);

  // Calculate wrapped text lines based on offset path length
  const wrappedDescriptionLines = React.useMemo(() => {
    if (!data?.description) return [];
    
    // Get the offset path length
    const pathLength = textPathRef.current?.getTotalLength() || 0;
    if (pathLength === 0) return [data.description]; // Fallback to single line
    
    // Estimate character width for 11px italic font (approximately 6.5px per character)
    const charWidth = 6.5;
    const maxCharsPerLine = Math.floor((pathLength * 0.9) / charWidth); // Use 90% of path length
    
    if (maxCharsPerLine <= 5) return []; // Too short to display text
    
    // Split text into words
    const words = data.description.split(' ');
    const lines: string[] = [];
    let currentLine = '';
    
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      
      if (testLine.length <= maxCharsPerLine) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          lines.push(currentLine);
        }
        // If single word is too long, break it up
        if (word.length > maxCharsPerLine) {
          let remaining = word;
          while (remaining.length > maxCharsPerLine) {
            lines.push(remaining.substring(0, maxCharsPerLine - 1) + '-');
            remaining = remaining.substring(maxCharsPerLine - 1);
          }
          currentLine = remaining;
        } else {
          currentLine = word;
        }
      }
    }
    
    if (currentLine) {
      lines.push(currentLine);
    }
    
    // Limit to 3 lines max for readability
    const limitedLines = lines.slice(0, 3);
    
    // If there are more lines than we're showing, add "..." to the last line
    if (lines.length > 3) {
      const lastLine = limitedLines[2];
      // Replace end of last line with "..." if there's more content
      if (lastLine.length > 3) {
        limitedLines[2] = lastLine.substring(0, lastLine.length - 3) + '...';
      } else {
        limitedLines[2] = lastLine + '...';
      }
    }
    
    return limitedLines;
  }, [data?.description, offsetPath, textPathRef.current]);

  // Helper function to get point on Bézier curve at parameter t (for label positioning)
  const getBezierPoint = (t: number, sx: number, sy: number, c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number) => {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;
    const t2 = t * t;
    const t3 = t2 * t;
    
    return {
      x: mt3 * sx + 3 * mt2 * t * c1x + 3 * mt * t2 * c2x + t3 * ex,
      y: mt3 * sy + 3 * mt2 * t * c1y + 3 * mt * t2 * c2y + t3 * ey
    };
  };

  // Helper function to calculate arc length of a cubic Bézier curve up to parameter tMax
  const calculateBezierLengthToT = (sx: number, sy: number, c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number, tMax: number): number => {
    const steps = 100;
    let length = 0;
    const actualSteps = Math.floor(steps * tMax);
    
    for (let i = 0; i < actualSteps; i++) {
      const t1 = i / steps;
      const t2 = (i + 1) / steps;
      
      const p1 = getBezierPoint(t1, sx, sy, c1x, c1y, c2x, c2y, ex, ey);
      const p2 = getBezierPoint(t2, sx, sy, c1x, c1y, c2x, c2y, ex, ey);
      
      length += Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
    }
    
    return length;
  };

  // Helper function to calculate arc length of a cubic Bézier curve (full length)
  const calculateBezierLength = (sx: number, sy: number, c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number): number => {
    return calculateBezierLengthToT(sx, sy, c1x, c1y, c2x, c2y, ex, ey, 1.0);
  };

  // Calculate arrow positions along the path
  const arrowPositions = React.useMemo(() => {
    if (!data?.calculateWidth) return [];
    
    try {
      // Extract first 8 numbers from the path: M sx,sy C c1x,c1y c2x,c2y ex,ey
      const nums = edgePath.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi);
      if (!nums || nums.length < 8) return [];
      const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = nums.slice(0, 8).map(Number);

      const lerp = (a: number, b: number, tt: number) => a + (b - a) * tt;

      // Calculate multiple positions along the curve using correct algorithmic approach
      const positions: { x: number; y: number; angle: number }[] = [];
      
      // Calculate actual arc length of the Bézier curve (not just Euclidean distance)
      const pathLength = calculateBezierLength(sx, sy, c1x, c1y, c2x, c2y, ex, ey);
      
      // Algorithm: Place arrows at L/2 +/- nY (while avoiding first X and last X pixels)
      const excludePixels = 14; // Exclude 14 pixels from each end (20 * 0.7)
      const arrowSpacing = 28; // Y = spacing between arrows (40 * 0.7)
      const L = pathLength;
      const L_half = L / 2;
      
      // Arrow calculation
      
      // Helper function to find t value for a given arc length distance
      const findTForArcLength = (targetLength: number): number => {
        if (targetLength <= 0) return 0;
        if (targetLength >= L) return 1;
        
        // Binary search for the t value that gives us the target arc length
        let t = targetLength / L; // Initial guess (linear approximation)
        let low = 0;
        let high = 1;
        
        for (let i = 0; i < 20; i++) { // 20 iterations should be enough
          const currentLength = calculateBezierLengthToT(sx, sy, c1x, c1y, c2x, c2y, ex, ey, t);
          
          if (Math.abs(currentLength - targetLength) < 0.1) {
            return t; // Close enough
          }
          
          if (currentLength < targetLength) {
            low = t;
            t = (t + high) / 2;
          } else {
            high = t;
            t = (low + t) / 2;
          }
        }
        
        return t;
      };
      
      // Place arrows at L/2 +/- nY, but only if they're within valid range
      let n = 0;
      while (true) {
        // Calculate positions: L/2 + nY and L/2 - nY
        const pos1 = L_half + (n * arrowSpacing);
        const pos2 = L_half - (n * arrowSpacing);
        
        // Check if positions are valid (not in excluded areas)
        const pos1Valid = pos1 >= excludePixels && pos1 <= (L - excludePixels);
        const pos2Valid = pos2 >= excludePixels && pos2 <= (L - excludePixels);
        
        // If neither position is valid, we're done
        if (!pos1Valid && !pos2Valid) break;
        
        // Add valid positions
        if (pos1Valid) {
          const t1 = findTForArcLength(pos1);
          const point1 = calculatePointOnCurve(t1, sx, sy, c1x, c1y, c2x, c2y, ex, ey, lerp);
          if (point1) positions.push(point1);
        }
        
        if (pos2Valid && n > 0) { // Don't duplicate the center arrow
          const t2 = findTForArcLength(pos2);
          const point2 = calculatePointOnCurve(t2, sx, sy, c1x, c1y, c2x, c2y, ex, ey, lerp);
          if (point2) positions.push(point2);
        }
        
        n++;
      }
      
      // Arrow placement complete
      
      // Helper function to calculate point and angle on curve
      function calculatePointOnCurve(t: number, sx: number, sy: number, c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number, lerp: (a: number, b: number, tt: number) => number) {
        // De Casteljau to get point and tangent at t
        const p0x = sx, p0y = sy;
        const p1x = c1x, p1y = c1y;
        const p2x = c2x, p2y = c2y;
        const p3x = ex, p3y = ey;

        const p01x = lerp(p0x, p1x, t);
        const p01y = lerp(p0y, p1y, t);
        const p12x = lerp(p1x, p2x, t);
        const p12y = lerp(p1y, p2y, t);
        const p23x = lerp(p2x, p3x, t);
        const p23y = lerp(p2y, p3y, t);

        const p012x = lerp(p01x, p12x, t);
        const p012y = lerp(p01y, p12y, t);
        const p123x = lerp(p12x, p23x, t);
        const p123y = lerp(p12y, p23y, t);

        const p0123x = lerp(p012x, p123x, t);
        const p0123y = lerp(p012y, p123y, t);

        // Calculate tangent for arrow direction
        const tangentX = p123x - p012x;
        const tangentY = p123y - p012y;
        const angle = Math.atan2(tangentY, tangentX) * (180 / Math.PI);

        return { x: p0123x, y: p0123y, angle };
      }
      
      return positions;
    } catch {
      return [];
    }
  }, [edgePath, adjustedTargetX, adjustedTargetY, data?.calculateWidth]);

  // Calculate the arrow position at 75% along the path (for single arrow mode)
  const arrowPosition = React.useMemo(() => {
    try {
      // Extract first 8 numbers from the path: M sx,sy C c1x,c1y c2x,c2y ex,ey
      const nums = edgePath.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi);
      if (!nums || nums.length < 8) return { x: adjustedTargetX, y: adjustedTargetY, angle: 0 };
      const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = nums.slice(0, 8).map(Number);

      const t = 0.75; // position arrow at 75% of the curve

      const lerp = (a: number, b: number, tt: number) => a + (b - a) * tt;

      // De Casteljau to get point and tangent at t
      const p0x = sx, p0y = sy;
      const p1x = c1x, p1y = c1y;
      const p2x = c2x, p2y = c2y;
      const p3x = ex, p3y = ey;

      const p01x = lerp(p0x, p1x, t);
      const p01y = lerp(p0y, p1y, t);
      const p12x = lerp(p1x, p2x, t);
      const p12y = lerp(p1y, p2y, t);
      const p23x = lerp(p2x, p3x, t);
      const p23y = lerp(p2y, p3y, t);

      const p012x = lerp(p01x, p12x, t);
      const p012y = lerp(p01y, p12y, t);
      const p123x = lerp(p12x, p23x, t);
      const p123y = lerp(p12y, p23y, t);

      const p0123x = lerp(p012x, p123x, t);
      const p0123y = lerp(p012y, p123y, t);

      // Calculate tangent for arrow direction
      const tangentX = p123x - p012x;
      const tangentY = p123y - p012y;
      const angle = Math.atan2(tangentY, tangentX) * (180 / Math.PI);

      return { x: p0123x, y: p0123y, angle };
    } catch {
      return { x: adjustedTargetX, y: adjustedTargetY, angle: 0 };
    }
  }, [edgePath, adjustedTargetX, adjustedTargetY]);



  const handleDelete = useCallback(() => {
    deleteElements({ edges: [{ id }] });
  }, [id, deleteElements]);

  const handleDoubleClick = useCallback(() => {
    // Overlay edges are read-only, ignore interactions
    if (data?.scenarioOverlay) return;
    
    // First select the edge to update the properties panel
    if (data?.onSelect) {
      data.onSelect(lookupId);
    }
    
    // Then focus the probability field
    if (data?.onDoubleClick) {
      data.onDoubleClick(lookupId, 'probability');
    }
  }, [lookupId, data]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    // Overlay edges are read-only, ignore interactions
    if (data?.scenarioOverlay) return;
    
    e.preventDefault();
    setShowContextMenu(true);
  }, [data]);

  const handleReconnectSource = useCallback(() => {
    // Overlay edges are read-only, ignore interactions
    if (data?.scenarioOverlay) return;
    
    if (data?.onReconnect) {
      const newSource = prompt('Enter new source node ID:', source);
      if (newSource && newSource !== source) {
        data.onReconnect(lookupId, newSource, undefined);
      }
    }
    setShowContextMenu(false);
  }, [data, lookupId, source]);

  const handleReconnectTarget = useCallback(() => {
    // Overlay edges are read-only, ignore interactions
    if (data?.scenarioOverlay) return;
    
    if (data?.onReconnect) {
      const newTarget = prompt('Enter new target node ID:', target);
      if (newTarget && newTarget !== target) {
        data.onReconnect(lookupId, undefined, newTarget);
      }
    }
    setShowContextMenu(false);
  }, [data, lookupId, target]);

  // Handle source handle drag
  const handleSourceMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Use the mouse position directly - this avoids coordinate system issues
    const mouseX = e.clientX;
    const mouseY = e.clientY;
    
    // Source handle mousedown
    
    setIsDraggingSource(true);
    setDragPosition({ x: mouseX, y: mouseY });
  }, []);

  // Handle target handle drag
  const handleTargetMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Use the mouse position directly - this avoids coordinate system issues
    const mouseX = e.clientX;
    const mouseY = e.clientY;
    
    // Target handle mousedown
    
    setIsDraggingTarget(true);
    setDragPosition({ x: mouseX, y: mouseY });
  }, []);

  // Handle mouse move during drag
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (isDraggingSource || isDraggingTarget) {
      e.preventDefault();
      const newPos = { x: e.clientX, y: e.clientY };
      // Mouse move
      setDragPosition(newPos);
    }
  }, [isDraggingSource, isDraggingTarget]);

  // Handle mouse up to complete drag
  const handleMouseUp = useCallback((e: MouseEvent) => {
    if (isDraggingSource || isDraggingTarget) {
      // Convert screen position to flow position
      const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      
      // Find the node at this position
      const nodes = getNodes();
      const targetNode = nodes.find(node => {
        const nodeX = node.position.x;
        const nodeY = node.position.y;
        const nodeWidth = DEFAULT_NODE_WIDTH;
        const nodeHeight = DEFAULT_NODE_HEIGHT;
        
        return (
          flowPos.x >= nodeX &&
          flowPos.x <= nodeX + nodeWidth &&
          flowPos.y >= nodeY &&
          flowPos.y <= nodeY + nodeHeight
        );
      });

      if (targetNode && data?.onReconnect) {
        // Calculate which face of the node we're closest to
        const nodeX = targetNode.position.x;
        const nodeY = targetNode.position.y;
        const nodeWidth = DEFAULT_NODE_WIDTH;
        const nodeHeight = DEFAULT_NODE_HEIGHT;
        
        // Calculate relative position within the node (0 to 1)
        const relX = (flowPos.x - nodeX) / nodeWidth;
        const relY = (flowPos.y - nodeY) / nodeHeight;
        
        // Calculate distances to all faces
        const faceDistances = [
          { face: 'left', distance: relX },
          { face: 'right', distance: 1 - relX },
          { face: 'top', distance: relY },
          { face: 'bottom', distance: 1 - relY }
        ];
        
        // Sort by distance (closest first)
        faceDistances.sort((a, b) => a.distance - b.distance);
        
        // Get existing edges to analyze face usage
        const allEdges = getEdges();
        const nodeId = targetNode.id;
        
        // Determine if we're connecting as input or output
        const isInputConnection = isDraggingTarget;
        const isOutputConnection = isDraggingSource;
        
        // Find best face with type preference
        let targetHandle: string = faceDistances[0].face; // fallback to closest
        
        for (const { face, distance } of faceDistances) {
          // Get all edges using this face (both input and output)
          const faceEdges = allEdges.filter(edge => {
            const sourceHandle = edge.sourceHandle || 'right-out';
            const targetHandle = edge.targetHandle || 'left';
            const sourceFace = sourceHandle.split('-')[0];
            const targetFace = targetHandle.split('-')[0];
            
            // Check if this face is used by any edge connected to this node
            return (edge.source === nodeId && sourceFace === face) || 
                   (edge.target === nodeId && targetFace === face);
          });
          
          if (faceEdges.length === 0) {
            // Empty face - use it
            targetHandle = face;
            break;
          }
          
          // Check if face is used consistently (all input or all output)
          const hasInputs = faceEdges.some(edge => edge.target === nodeId);
          const hasOutputs = faceEdges.some(edge => edge.source === nodeId);
          
          // If face is mixed (both inputs and outputs), skip it
          if (hasInputs && hasOutputs) {
            continue;
          }
          
          // If face has only inputs and we're adding an input, use it
          if (hasInputs && !hasOutputs && isInputConnection) {
            targetHandle = face;
            break;
          }
          
          // If face has only outputs and we're adding an output, use it
          if (hasOutputs && !hasInputs && isOutputConnection) {
            targetHandle = face;
            break;
          }
        }
        
        // Drop position analysis complete
        
        if (isDraggingSource) {
          // Reconnecting source
          data.onReconnect(id, targetNode.id, undefined, undefined, targetHandle);
        } else if (isDraggingTarget) {
          // Reconnecting target
          data.onReconnect(id, undefined, targetNode.id, targetHandle, undefined);
        }
      }

      setIsDraggingSource(false);
      setIsDraggingTarget(false);
      setDragPosition(null);
    }
  }, [isDraggingSource, isDraggingTarget, screenToFlowPosition, getNodes, data, id, source, target]);

  // Close context menu when clicking elsewhere
  React.useEffect(() => {
    const handleClickOutside = () => setShowContextMenu(false);
    if (showContextMenu) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [showContextMenu]);

  // Add global mouse event listeners for dragging
  React.useEffect(() => {
    if (isDraggingSource || isDraggingTarget) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDraggingSource, isDraggingTarget, handleMouseMove, handleMouseUp]);

  // Generate ribbon-style path for Sankey mode (filled area instead of stroked path)
  const ribbonPath = React.useMemo(() => {
    if (!data?.useSankeyView || !strokeWidth) return null;
    
    // Parse the bezier path to get control points
    const nums = edgePath.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi);
    if (!nums || nums.length < 8) {
      return null;
    }
    
    const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = nums.slice(0, 8).map(Number);
    
    // Calculate perpendicular offset vectors at start and end
    // At start: perpendicular to (c1 - s)
    const dx1 = c1x - sx;
    const dy1 = c1y - sy;
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1;
    const perpX1 = -dy1 / len1;
    const perpY1 = dx1 / len1;
    
    // At end: perpendicular to (e - c2)
    const dx2 = ex - c2x;
    const dy2 = ey - c2y;
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
    const perpX2 = -dy2 / len2;
    const perpY2 = dx2 / len2;
    
    const halfWidth = strokeWidth / 2;
    
    // Visual top edge: offset upward (negative perpendicular in screen coordinates)
    const topSx = sx - perpX1 * halfWidth;
    const topSy = sy - perpY1 * halfWidth;
    const topC1x = c1x - perpX1 * halfWidth;
    const topC1y = c1y - perpY1 * halfWidth;
    const topC2x = c2x - perpX2 * halfWidth;
    const topC2y = c2y - perpY2 * halfWidth;
    const topEx = ex - perpX2 * halfWidth;
    const topEy = ey - perpY2 * halfWidth;
    
    // Visual bottom edge: offset downward (positive perpendicular in screen coordinates)
    const botEx = ex + perpX2 * halfWidth;
    const botEy = ey + perpY2 * halfWidth;
    const botC2x = c2x + perpX2 * halfWidth;
    const botC2y = c2y + perpY2 * halfWidth;
    const botC1x = c1x + perpX1 * halfWidth;
    const botC1y = c1y + perpY1 * halfWidth;
    const botSx = sx + perpX1 * halfWidth;
    const botSy = sy + perpY1 * halfWidth;
    
    // Create closed path: top curve forward, then bottom curve backward
    return {
      ribbon: `M ${topSx},${topSy} C ${topC1x},${topC1y} ${topC2x},${topC2y} ${topEx},${topEy} L ${botEx},${botEy} C ${botC2x},${botC2y} ${botC1x},${botC1y} ${botSx},${botSy} Z`,
      topEdge: `M ${topSx},${topSy} C ${topC1x},${topC1y} ${topC2x},${topC2y} ${topEx},${topEy}`
    };
  }, [edgePath, data?.useSankeyView, strokeWidth]);


  // Check if this is a hidden current layer (semi-transparent current when not visible)
  const isHiddenCurrent = !data?.scenarioOverlay && (data?.strokeOpacity ?? 1) < 0.1;
  
  return (
    <>
      <defs>
        <marker
          id={`arrow-${id}`}
          markerWidth="15"
          markerHeight="15"
          refX="13.5"
          refY="4.5"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path
            d="M0,0 L0,9 L13.5,4.5 z"
            fill={getEdgeColor()}
          />
        </marker>
        {/* Fallback marker: fixed size, independent of stroke width */}
        <marker
          id={`arrow-fallback-${id}`}
          markerWidth="15"
          markerHeight="15"
          refX="13.5"
          refY="4.5"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path
            d="M0,0 L0,9 L13.5,4.5 z"
            fill={getEdgeColor()}
          />
        </marker>
        {/* Diagonal stripe pattern for hidden current layer */}
        {isHiddenCurrent && (
          <pattern
            id={`stripe-pattern-${id}`}
            patternUnits="userSpaceOnUse"
            width="10"
            height="10"
            patternTransform="rotate(45)"
          >
            <rect x="0" y="0" width="5" height="10" fill={getEdgeColor()} fillOpacity="0.05" />
            <rect x="5" y="0" width="5" height="10" fill={getEdgeColor()} fillOpacity="0.2" />
          </pattern>
        )}
        {/* Define offset path for text to follow (parallel to edge) */}
        {data?.description && (
          <path
            ref={textPathRef}
            id={`edge-path-${id}`}
            d={offsetPath}
            fill="none"
            stroke="none"
            pointerEvents="none"
          />
        )}
      </defs>
      
      {/* Edge rendering */}
          {data?.useSankeyView && ribbonPath ? (
            // Sankey mode: render as filled ribbon
            <>
              <path
                id={id}
                style={{
                  fill: isHiddenCurrent 
                    ? `url(#stripe-pattern-${id})` 
                    : ((effectiveSelected || data?.isHighlighted) ? getEdgeColor() : (data?.scenarioColor || getEdgeColor())),
                  fillOpacity: isHiddenCurrent ? 1 : (data?.strokeOpacity ?? EDGE_OPACITY),
                  mixBlendMode: USE_GROUP_BASED_BLENDING ? 'normal' : EDGE_BLEND_MODE,
                  stroke: 'none',
                  transition: 'opacity 0.3s ease-in-out',
                  pointerEvents: data?.scenarioOverlay ? 'none' : 'auto',
                }}
                className="react-flow__edge-path"
                d={ribbonPath.ribbon}
                onContextMenu={data?.scenarioOverlay ? undefined : handleContextMenu}
                onDoubleClick={data?.scenarioOverlay ? undefined : handleDoubleClick}
                onMouseEnter={data?.scenarioOverlay ? undefined : handleTooltipMouseEnter}
                onMouseMove={data?.scenarioOverlay ? undefined : handleTooltipMouseMove}
                onMouseLeave={data?.scenarioOverlay ? undefined : handleTooltipMouseLeave}
              />
              {/* Hidden path for beads - follows the top edge of the ribbon */}
              <path
                ref={pathRef}
                id={`${id}-top-edge`}
                d={ribbonPath.topEdge}
                style={{ display: 'none' }}
                pointerEvents="none"
              />
            </>
          ) : shouldShowConfidenceIntervals && confidenceData ? (
            // Confidence interval mode: render three overlapping paths
            <>
              {/* Outer band (upper bound) - widest, lightest color */}
              <path
                key={`${id}-ci-upper`}
                id={`${id}-ci-upper`}
                style={{
                  stroke: isHiddenCurrent 
                    ? `url(#stripe-pattern-${id})` 
                    : ((effectiveSelected || data?.isHighlighted) ? getEdgeColor() : (data?.scenarioColor || getEdgeColor())),
                  strokeWidth: confidenceData.widths.upper,
                  strokeOpacity: isHiddenCurrent ? 1 : (confidenceData.opacities.outer * ((data?.strokeOpacity ?? 0.8) / 0.8)),
                  mixBlendMode: USE_GROUP_BASED_BLENDING ? 'normal' : EDGE_BLEND_MODE,
                  fill: 'none',
                  strokeLinecap: 'round',
                  strokeLinejoin: 'miter',
                  strokeDasharray: (effectiveWeight === undefined || effectiveWeight === null || effectiveWeight === 0) ? '5,5' : 'none',
                  transition: 'stroke-width 0.3s ease-in-out',
                  pointerEvents: data?.scenarioOverlay ? 'none' : 'auto',
                }}
                className="react-flow__edge-path"
                d={edgePath}
                onContextMenu={data?.scenarioOverlay ? undefined : handleContextMenu}
                onDoubleClick={data?.scenarioOverlay ? undefined : handleDoubleClick}
                onMouseEnter={data?.scenarioOverlay ? undefined : handleTooltipMouseEnter}
                onMouseMove={data?.scenarioOverlay ? undefined : handleTooltipMouseMove}
                onMouseLeave={data?.scenarioOverlay ? undefined : handleTooltipMouseLeave}
              />
              {/* Middle band (mean) - normal width, base color */}
              <path
                key={`${id}-ci-middle`}
                id={`${id}-ci-middle`}
                style={{
                  stroke: isHiddenCurrent 
                    ? `url(#stripe-pattern-${id})` 
                    : ((effectiveSelected || data?.isHighlighted) ? getEdgeColor() : (data?.scenarioColor || getEdgeColor())),
                  strokeWidth: confidenceData.widths.middle,
                  strokeOpacity: isHiddenCurrent ? 1 : (confidenceData.opacities.middle * ((data?.strokeOpacity ?? 0.8) / 0.8)),
                  mixBlendMode: USE_GROUP_BASED_BLENDING ? 'normal' : EDGE_BLEND_MODE,
                  fill: 'none',
                  strokeLinecap: 'round',
                  strokeLinejoin: 'miter',
                  strokeDasharray: (effectiveWeight === undefined || effectiveWeight === null || effectiveWeight === 0) ? '5,5' : 'none',
                  transition: 'stroke-width 0.3s ease-in-out',
                  pointerEvents: data?.scenarioOverlay ? 'none' : 'auto',
                }}
                className="react-flow__edge-path"
                d={edgePath}
                onContextMenu={data?.scenarioOverlay ? undefined : handleContextMenu}
                onDoubleClick={data?.scenarioOverlay ? undefined : handleDoubleClick}
                onMouseEnter={data?.scenarioOverlay ? undefined : handleTooltipMouseEnter}
                onMouseMove={data?.scenarioOverlay ? undefined : handleTooltipMouseMove}
                onMouseLeave={data?.scenarioOverlay ? undefined : handleTooltipMouseLeave}
              />
              {/* Inner band (lower bound) - narrowest, darkest color */}
              <path
                ref={pathRef}
                key={`${id}-ci-lower`}
                id={`${id}-ci-lower`}
                style={{
                  stroke: isHiddenCurrent 
                    ? `url(#stripe-pattern-${id})` 
                    : ((effectiveSelected || data?.isHighlighted) ? getEdgeColor() : (data?.scenarioColor || getEdgeColor())),
                  strokeWidth: confidenceData.widths.lower,
                  strokeOpacity: isHiddenCurrent ? 1 : (confidenceData.opacities.inner * ((data?.strokeOpacity ?? 0.8) / 0.8)),
                  mixBlendMode: USE_GROUP_BASED_BLENDING ? 'normal' : EDGE_BLEND_MODE,
                  fill: 'none',
                  strokeLinecap: 'round',
                  strokeLinejoin: 'miter',
                  strokeDasharray: (effectiveWeight === undefined || effectiveWeight === null || effectiveWeight === 0) ? '5,5' : 'none',
                  markerEnd: 'none',
                  transition: 'stroke-width 0.3s ease-in-out',
                  pointerEvents: data?.scenarioOverlay ? 'none' : 'auto',
                }}
                className="react-flow__edge-path"
                d={edgePath}
                onContextMenu={data?.scenarioOverlay ? undefined : handleContextMenu}
                onDoubleClick={data?.scenarioOverlay ? undefined : handleDoubleClick}
                onMouseEnter={data?.scenarioOverlay ? undefined : handleTooltipMouseEnter}
                onMouseMove={data?.scenarioOverlay ? undefined : handleTooltipMouseMove}
                onMouseLeave={data?.scenarioOverlay ? undefined : handleTooltipMouseLeave}
              />
            </>
          ) : (
            <>
              {/* Normal mode: render as stroked path */}
              <path
                ref={pathRef}
                id={id}
                style={{
                  stroke: isHiddenCurrent 
                    ? `url(#stripe-pattern-${id})` 
                    : ((effectiveSelected || data?.isHighlighted) ? getEdgeColor() : (data?.scenarioColor || getEdgeColor())),
                  strokeOpacity: isHiddenCurrent ? 1 : (data?.strokeOpacity ?? EDGE_OPACITY),
                  mixBlendMode: 'multiply',
                  fill: 'none',
                  strokeLinecap: 'round',
                  strokeLinejoin: 'miter',
                  strokeDasharray: ((data?.effectiveWeight !== undefined ? data.effectiveWeight : effectiveWeight) === 0) ? '5,5' : 'none',
                  markerEnd: 'none',
                  transition: 'stroke-width 0.3s ease-in-out',
                  pointerEvents: data?.scenarioOverlay ? 'none' : 'auto',
                }}
                className="react-flow__edge-path"
                d={edgePath}
                onContextMenu={data?.scenarioOverlay ? undefined : handleContextMenu}
                onDoubleClick={data?.scenarioOverlay ? undefined : handleDoubleClick}
                onMouseEnter={data?.scenarioOverlay ? undefined : handleTooltipMouseEnter}
                onMouseMove={data?.scenarioOverlay ? undefined : handleTooltipMouseMove}
                onMouseLeave={data?.scenarioOverlay ? undefined : handleTooltipMouseLeave}
              />
            </>
          )}
          
          {/* Edge Beads - SVG elements rendered directly in edge SVG */}
          {/* Only render beads if path ref is stable and edge data is available */}
          {/* DIAGNOSTIC: Skip beads if ?nobeads param set */}
          {!data?.suppressLabel && !data?.scenarioOverlay && pathRef.current && fullEdge && scenariosContext && !NO_BEADS_MODE && !shouldSuppressBeads && (() => {
            // Don't render beads until faceDirections are computed (prevents offset flash on first draw)
            if (!data?.useSankeyView) {
              const nodes = getNodes();
              const sourceNode = nodes.find(n => n.id === source);
              if (!sourceNode?.data?.faceDirections) {
                return null; // Wait for face directions to be computed
              }
            }
            
            // Compute visibleStartOffset based on source node face direction and edge offset
            const totalInset = EDGE_INSET + EDGE_INITIAL_OFFSET;
            
            // Default for flat faces (edge perpendicular to face)
            // For perpendicular edges: path distance ≈ perpendicular distance
            let visibleStartOffset = totalInset;
            
            // console.log('[Bead offset] Initial:', { totalInset, edgeId: id });
            
            if (!data?.useSankeyView && data?.sourceFace) {
              const nodes = getNodes();
              const sourceNode = nodes.find(n => n.id === source);
              const sourceFaceDirection = sourceNode?.data?.faceDirections?.[data.sourceFace] ?? 'flat';
              
              // Get edge offset from center (perpendicular to face)
              const sourceOffsetX = data?.sourceOffsetX || 0;
              const sourceOffsetY = data?.sourceOffsetY || 0;
              
              // Determine perpendicular offset based on face orientation
              let perpendicularOffset = 0;
              if (data.sourceFace === 'left' || data.sourceFace === 'right') {
                perpendicularOffset = sourceOffsetY; // Vertical offset for vertical faces
              } else {
                perpendicularOffset = sourceOffsetX; // Horizontal offset for horizontal faces
              }
              
              // Get node dimensions to normalize offset (approximate face length)
              const nominalWidth = (sourceNode?.data as any)?.sankeyWidth || DEFAULT_NODE_WIDTH;
              const nominalHeight = (sourceNode?.data as any)?.sankeyHeight || DEFAULT_NODE_HEIGHT;
              const faceLength = (data.sourceFace === 'left' || data.sourceFace === 'right') ? nominalHeight : nominalWidth;
              
              // Normalize offset to [-1, 1] range (center = 0, edges = ±1)
              const normalizedOffset = perpendicularOffset / (faceLength / 2);
              
              // Compute base perpendicular distance based on face direction
              // For quadratic Bezier Q(t) = (1-t)²·P₀ + 2t(1-t)·P₁ + t²·P₂
              // with control point P₁ at perpendicular depth d from the face:
              // The actual perpendicular distance at position n ∈ [-1,1] along face is:
              // perp(n) = (d/2) × (1 - n²)   [max depth is d/2 at center, not d]
              let basePerpDistance = totalInset;
              if (sourceFaceDirection === 'convex') {
                // Convex: quadratic bulge, max depth of CONVEX_DEPTH/2 at center
                const bulgeAtOffset = (CONVEX_DEPTH / 2) * (1 - normalizedOffset * normalizedOffset);
                basePerpDistance = totalInset + bulgeAtOffset;
              } else if (sourceFaceDirection === 'concave') {
                // Concave: quadratic indentation, max depth of CONCAVE_DEPTH/2 at center
                const indentAtOffset = (CONCAVE_DEPTH / 2) * (1 - normalizedOffset * normalizedOffset);
                basePerpDistance = totalInset - indentAtOffset;
              }
              
              // visibleStartOffset is perpendicular distance, but beads measure along path
              // For now use perpendicular as approximation; correct solution requires path integration
              visibleStartOffset = basePerpDistance;
              
              console.log('[Bead offset] Calculated:', {
                edgeId: id,
                sourceFace: data.sourceFace,
                sourceFaceDirection,
                perpendicularOffset,
                normalizedOffset,
                basePerpDistance,
                visibleStartOffset
              });
            }
            
            return (
              <EdgeBeadsRenderer
                key={`beads-${id}-${fullEdge.uuid || fullEdge.id}`}
                edgeId={id}
                edge={fullEdge}
                path={pathRef.current}
                graph={graph}
                scenarioOrder={scenarioOrder}
                visibleScenarioIds={visibleScenarioIds}
                visibleColorOrderIds={visibleColorOrderIds}
                scenarioColors={scenarioColors}
                scenariosContext={scenariosContext}
                whatIfDSL={whatIfDSL}
                visibleStartOffset={visibleStartOffset}
                onDoubleClick={handleDoubleClick}
                useSankeyView={data?.useSankeyView}
                edgeWidth={strokeWidth}
              />
            );
          })()}

      {/* Edge tooltip - rendered as portal */}
      {showTooltip && ReactDOM.createPortal(
        <div
          style={{
            position: 'fixed',
            left: `${tooltipPos.x}px`,
            top: `${tooltipPos.y}px`,
            transform: 'translate(-50%, -100%)',
            marginTop: '-8px',
            background: '#1a1a1a',
            color: '#ffffff',
            padding: '8px 12px',
            borderRadius: '6px',
            fontSize: `${EDGE_LABEL_FONT_SIZE}px`,
            lineHeight: '1.4',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            border: '1px solid #333',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxWidth: '300px',
            zIndex: 10000,
            pointerEvents: 'none',
          }}
        >
          {getTooltipContent()}
        </div>,
        document.body
      )}

      {/* Context Menu */}
      {showContextMenu && (
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: '4px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            zIndex: 1000,
            minWidth: '120px',
          }}
        >
          <div
            style={{
              padding: '8px 12px',
              cursor: 'pointer',
              fontSize: `${EDGE_LABEL_FONT_SIZE}px`,
              borderBottom: '1px solid #eee',
            }}
            onClick={handleReconnectSource}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
            onMouseLeave={(e) => e.currentTarget.style.background = '#fff'}
          >
            Reconnect Source
          </div>
          <div
            style={{
              padding: '8px 12px',
              cursor: 'pointer',
              fontSize: `${EDGE_LABEL_FONT_SIZE}px`,
              borderBottom: '1px solid #eee',
            }}
            onClick={handleReconnectTarget}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
            onMouseLeave={(e) => e.currentTarget.style.background = '#fff'}
          >
            Reconnect Target
          </div>
          <div
            style={{
              padding: '8px 12px',
              cursor: 'pointer',
              fontSize: `${EDGE_LABEL_FONT_SIZE}px`,
              color: '#dc3545',
            }}
            onClick={() => {
              handleDelete();
              setShowContextMenu(false);
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
            onMouseLeave={(e) => e.currentTarget.style.background = '#fff'}
          >
            Delete Edge
          </div>
        </div>
      )}
      
      {/* Description text - rendered last to appear on top of all other edge elements */}
      <g className="edge-description-text" style={{ isolation: 'isolate' }}>
        {data?.description && wrappedDescriptionLines.map((line, index) => {
          // Reverse line order so first line is closest to edge
          const reversedIndex = wrappedDescriptionLines.length - 1 - index;
          const lineOffset = reversedIndex * 11; // 11px vertical spacing between lines
          
          // When labels are below the edge (labelOffsetDirection = 1), use positive dy to push text away
          // When labels are above the edge (labelOffsetDirection = -1), use negative dy to push text away
          const dyOffset = labelOffsetDirection === 1 ? lineOffset : -lineOffset;
          
          return (
            <text
              key={`${id}-desc-${index}`}
              className="edge-description-text-element"
              style={{
                fontSize: '9px',
                fill: selected ? '#000' : '#666',
                fontStyle: 'italic',
                fontWeight: selected ? '600' : 'normal',
                pointerEvents: 'painted', // Only capture events over painted (visible) text, not the entire path
                cursor: 'pointer',
                userSelect: 'none',
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                // Select the edge first
                if (data?.onSelect) {
                  data.onSelect(id);
                }
                // Open Properties Panel and focus the description field
                window.dispatchEvent(new CustomEvent('dagnet:openPropertiesPanel'));
                window.dispatchEvent(new CustomEvent('dagnet:focusField', { detail: { field: 'description' } }));
              }}
            >
            <textPath
              href={`#edge-path-${id}`}
              startOffset={textAlignment.offset}
              textAnchor={textAlignment.anchor}
              spacing="auto"
              method="align"
            >
                <tspan dy={dyOffset}>
                  {line}
                </tspan>
              </textPath>
            </text>
          );
        })}
      </g>
    </>
  );
}
