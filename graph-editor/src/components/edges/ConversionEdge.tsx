import React, { useState, useCallback, useMemo, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { EdgeProps, getBezierPath, EdgeLabelRenderer, useReactFlow, MarkerType, Handle, Position, getSmoothStepPath } from 'reactflow';
import { useGraphStore } from '../../contexts/GraphStoreContext';
import { useViewPreferencesContext } from '../../contexts/ViewPreferencesContext';
import { useScenariosContextOptional } from '../../contexts/ScenariosContext';
import { useTabContext, fileRegistry } from '../../contexts/TabContext';
import { dataOperationsService } from '../../services/dataOperationsService';
import { useSnapshotsMenu } from '../../hooks/useSnapshotsMenu';
import toast from 'react-hot-toast';
import Tooltip from '@/components/Tooltip';
import { getConditionalColour, getConditionalProbabilityColour, isConditionalEdge } from '@/lib/conditionalColours';
import { computeEffectiveEdgeProbability, getEdgeWhatIfDisplay } from '@/lib/whatIf';
import { getVisitedNodeIds } from '@/lib/queryDSL';
import { calculateConfidenceBounds } from '@/utils/confidenceIntervals';
import { useEdgeBeads, EdgeBeadsRenderer } from './EdgeBeads';
import { useDecorationVisibility } from '../GraphCanvas';
import { 
  EDGE_INSET, 
  EDGE_INITIAL_OFFSET, 
  CONVEX_DEPTH, 
  CONCAVE_DEPTH, 
  DEFAULT_NODE_WIDTH, 
  DEFAULT_NODE_HEIGHT, 
  EDGE_LABEL_FONT_SIZE,
  MIN_EDGE_WIDTH,
  CHEVRON_SPACING,
  CHEVRON_SPEED,
  CHEVRON_ANGLE_RATIO,
  CHEVRON_LENGTH_RATIO,
  CHEVRON_OPACITY,
  CHEVRON_FADE_IN_FRACTION,
  CHEVRON_BLUR,
  CHEVRON_LAG_D0,
  CHEVRON_LAG_K,
  LAG_FORECAST_STRIPE_WIDTH,
  LAG_FORECAST_STRIPE_GAP,
  LAG_FORECAST_STRIPE_ANGLE,
  LAG_FORECAST_STRIPE_OPACITY,
  LAG_FORECAST_STRIPE_OFFSET,
  LAG_EVIDENCE_STRIPE_WIDTH,
  LAG_EVIDENCE_STRIPE_GAP,
  LAG_EVIDENCE_STRIPE_ANGLE,
  LAG_EVIDENCE_STRIPE_OPACITY,
  LAG_EVIDENCE_STRIPE_OFFSET,
  EDGE_OPACITY,
  EDGE_BLEND_MODE,
  LAG_ANCHOR_OPACITY,
  LAG_ANCHOR_SELECTED_OPACITY,
  LAG_ANCHOR_HIGHLIGHTED_OPACITY,
  LAG_ANCHOR_FADE_BAND,
  LAG_ANCHOR_FADE_MIN,
  LAG_ANCHOR_USE_STRIPES,
  LAG_ANCHOR_USE_CHEVRONS,
  LAG_ANCHOR_STRIPE_WIDTH,
  LAG_ANCHOR_STRIPE_GAP,
  LAG_ANCHOR_STRIPE_ANGLE,
  LAG_ANCHOR_CHEVRON_SIZE,
  LAG_ANCHOR_CHEVRON_GAP,
  LAG_ANCHOR_CHEVRON_STROKE,
  LAG_ANCHOR_USE_SPLINE_CHEVRONS,
  LAG_ANCHOR_SPLINE_CHEVRON_LENGTH,
  LAG_ANCHOR_SPLINE_CHEVRON_GAP,
  LAG_ANCHOR_SPLINE_CHEVRON_ANGLE,
  LAG_ANCHOR_STIPPLE_SPACING,
  LAG_ANCHOR_STIPPLE_RADIUS,
  HIDDEN_CURRENT_STIPPLE_ANGLE,
  HIDDEN_CURRENT_OPACITY,
  HIDDEN_CURRENT_HIGHLIGHTED_OPACITY,
  HIDDEN_CURRENT_SELECTED_OPACITY,
  SANKEY_NODE_INSET,
  COMPLETENESS_CHEVRON_MIN_HALF_WIDTH,
  COMPLETENESS_CHEVRON_WIDTH_PADDING,
  COMPLETENESS_CHEVRON_START_OFFSET,
  COMPLETENESS_CHEVRON_END_OFFSET,
  COMPLETENESS_CHEVRON_OPACITY,
  COMPLETENESS_CHEVRON_SELECTED_OPACITY,
  COMPLETENESS_CHEVRON_HIGHLIGHTED_OPACITY,
  SANKEY_COMPLETENESS_LINE_MIN_HEIGHT,
  SANKEY_COMPLETENESS_LINE_OVERHANG,
  SANKEY_COMPLETENESS_LINE_STROKE,
  NO_EVIDENCE_E_MODE_OPACITY,
} from '@/lib/nodeEdgeConstants';

import type { EdgeLatencyDisplay, ScenarioVisibilityMode } from '../../types';

// Edge curvature (higher = more aggressive curves, default is 0.25)
const EDGE_CURVATURE = 0.5;

// Sankey mode curvature (lower = less velocity at faces, more horizontal)
const SANKEY_EDGE_CURVATURE = 0.3;

// Toggle between bezier (false) or smooth step (true) paths
const USE_SMOOTH_STEP = false;

// Edge blending configuration (EDGE_OPACITY and EDGE_BLEND_MODE imported from nodeEdgeConstants)
const USE_GROUP_BASED_BLENDING = false; // Enable scenario-specific blending

// DIAGNOSTIC: Check for nobeads mode (?nobeads URL parameter)
const NO_BEADS_MODE = new URLSearchParams(window.location.search).has('nobeads');

/**
 * Compute chevron animation speed factor based on lag/maturity days.
 * Uses power-law decay: f(d) = (1 + d/D0)^(-k)
 * 
 * Anchor points (with D0=3, k=0.6):
 *   d=0  → f(0)  = 1.0   (baseline speed)
 *   d=7  → f(7)  ≈ 0.49  (≈ half speed)
 *   d=30 → f(30) ≈ 0.24  (≈ quarter speed)
 * 
 * @param lagDays - median_lag_days (preferred) or t95 (fallback) for the edge
 * @returns Speed multiplier (0..1], where 1 = baseline CHEVRON_SPEED
 */
function computeChevronSpeedFactor(lagDays: number | undefined): number {
  if (lagDays === undefined || lagDays <= 0) {
    return 1; // No lag data → baseline speed
  }
  return Math.pow(1 + lagDays / CHEVRON_LAG_D0, -CHEVRON_LAG_K);
}

interface ConversionEdgeData {
  uuid: string;
  id?: string;
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
  labour_cost?: {
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
  scenarioColour?: string;
  strokeOpacity?: number; // Opacity for scenario overlays (0-1)
  effectiveWeight?: number; // Effective probability for this scenario overlay (for dashed line rendering)
  scenarioParams?: any;
  originalEdgeId?: string; // Original edge ID for overlay edges (used for lookups)
  // Scenario rendering flags
  suppressLabel?: boolean; // Suppress label rendering for non-current overlay edges
  // Pan/zoom state to disable beads during interaction
  isPanningOrZooming?: boolean;
  // Scenario + latency rendering data
  scenarioId?: string;
  edgeLatencyDisplay?: EdgeLatencyDisplay;
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

  const { graph, setGraph, saveHistoryState } = useGraphStore();

  // For overlay edges, use originalEdgeId stored in data.
  const lookupId = data?.originalEdgeId || id;
  const snapshotsEdge = useMemo(() => {
    return graph?.edges?.find((e: any) =>
      e.uuid === lookupId || e.id === lookupId || `${e.from}->${e.to}` === lookupId
    );
  }, [graph, lookupId, graph?.metadata?.updated_at]);
  
  // Snapshots inventory for tooltip (all params on this edge)
  const snapshotParamIds = React.useMemo(() => {
    const ids: string[] = [];
    if (typeof snapshotsEdge?.p?.id === 'string' && snapshotsEdge.p.id.trim()) ids.push(snapshotsEdge.p.id.trim());
    if (typeof snapshotsEdge?.cost_gbp?.id === 'string' && snapshotsEdge.cost_gbp.id.trim()) ids.push(snapshotsEdge.cost_gbp.id.trim());
    if (typeof snapshotsEdge?.labour_cost?.id === 'string' && snapshotsEdge.labour_cost.id.trim()) ids.push(snapshotsEdge.labour_cost.id.trim());
    if (Array.isArray(snapshotsEdge?.conditional_p)) {
      for (const cp of snapshotsEdge.conditional_p) {
        const pid = cp?.p?.id;
        if (typeof pid === 'string' && pid.trim()) ids.push(pid.trim());
      }
    }
    return Array.from(new Set(ids));
  }, [snapshotsEdge]);

  // Avoid eager fetch: tooltip should fetch on hover.
  const snapshots = useSnapshotsMenu(snapshotParamIds, { autoFetch: false });
  const scenarioState = currentTab?.editorState?.scenarioState;
  const scenarioOrder = scenarioState?.scenarioOrder || [];
  const visibleScenarioIds = scenarioState?.visibleScenarioIds || [];
  const visibleColourOrderIds = scenarioState?.visibleColourOrderIds || [];

  // Visibility mode key to force bead recompute when user toggles E/F/F+E
  const visibilityModesKey = React.useMemo(() => {
    if (!activeTabId) return '';
    const ids = visibleScenarioIds.length > 0 ? visibleScenarioIds : ['current'];
    return ids.map(id => `${id}:${tabOps.getScenarioVisibilityMode(activeTabId, id)}`).join('|');
  }, [activeTabId, visibleScenarioIds.join('|'), tabOps]);

  // Identify which scenario layer this edge belongs to (current vs overlay scenario)
  const scenarioIdForEdge: string = React.useMemo(() => {
    if (data?.scenarioOverlay && data.scenarioId) {
      return data.scenarioId;
    }
    // Non-overlay edges are part of the 'current' layer
    return 'current';
  }, [data?.scenarioOverlay, data?.scenarioId]);
  
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
    
    // Trigger snapshot inventory fetch (hook handles caching)
    void snapshots.refresh();
    
    // Show tooltip after delay (500ms)
    tooltipTimeoutRef.current = setTimeout(() => {
      setShowTooltip(true);
    }, 500);
  }, [data?.scenarioOverlay, snapshots.refresh]);

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
    
    const edgeId = data.id || id;
    const lines: string[] = [];
    
    // Case edge info
    const isCaseEdge = fullEdge?.case_variant && (
      fullEdge?.case_id || 
      (graph?.nodes?.find((n: any) => n.uuid === fullEdge?.from || n.id === fullEdge?.from)?.type === 'case')
    );
    if (isCaseEdge) {
      lines.push(`case: ${data.case_variant}`);
      const sourceNode = graph?.nodes.find((n: any) => n.uuid === source || n.id === source);
      if (sourceNode?.type === 'case' && sourceNode?.case?.id === data.case_id) {
        const variant = sourceNode?.case?.variants?.find((v: any) => v.name === data.case_variant);
        if (variant) {
          lines.push(`  weight ${(variant.weight * 100).toFixed(0)}% × sub ${(data.probability * 100).toFixed(0)}%`);
        }
      }
    }
    
    // === PARAM: e.<edgeId>.p (BLENDED) ===
    lines.push(`e.${edgeId}.p`);
    
    // Mean ± stdev (blended probability)
    const pVal = (effectiveProbability * 100).toFixed(1);
    const pStd = data.stdev ? ` ±${(data.stdev * 100).toFixed(1)}` : '';
    lines.push(`  ${pVal}%${pStd}`);
    
    // Forecast population (p.n) - from inbound-n convolution
    const pN = fullEdge?.p?.n;
    if (pN !== undefined && pN > 0) {
      lines.push(`  p.n=${pN.toFixed(0)} (forecast population)`);
    }
    
    // === PARAM: e.<edgeId>.p.evidence (RAW) ===
    const pEvidence = fullEdge?.p?.evidence as any;
    lines.push('');
    lines.push(`e.${edgeId}.p.evidence`);
    
    if (pEvidence) {
      const evMean = typeof pEvidence.mean === 'number'
        ? pEvidence.mean
        : (typeof pEvidence.n === 'number' && typeof pEvidence.k === 'number' && pEvidence.n > 0
            ? pEvidence.k / pEvidence.n
            : undefined);
      const evStdev = typeof pEvidence.stdev === 'number' ? pEvidence.stdev : undefined;
      
      if (evMean !== undefined) {
        const evVal = (evMean * 100).toFixed(1);
        const evStd = evStdev ? ` ±${(evStdev * 100).toFixed(1)}` : '';
        lines.push(`  ${evVal}%${evStd}`);
      }
      
      if (pEvidence.n !== undefined && pEvidence.k !== undefined) {
        lines.push(`  n=${pEvidence.n} k=${pEvidence.k}`);
      }
      if (pEvidence.window_from && pEvidence.window_to) {
        const fmtDate = (d: Date) =>
          `${d.getDate()}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]}`;
        lines.push(`  ${fmtDate(new Date(pEvidence.window_from))} to ${fmtDate(new Date(pEvidence.window_to))}`);
      }
      if (pEvidence.source) lines.push(`  source: ${pEvidence.source}`);
      // Query only if we have evidence (actual fetch happened)
      if (fullEdge?.query) {
        lines.push(`  query: ${fullEdge.query}`);
      }
    } else {
      lines.push(`  (rebalanced)`);
    }
    
    // Latency information (if tracking enabled)
    const latency = fullEdge?.p?.latency;
    if (latency && latency.latency_parameter === true) {
      lines.push('');
      lines.push(`latency:`);
      if (latency.median_lag_days !== undefined) {
        lines.push(`  median lag: ${latency.median_lag_days.toFixed(1)}d`);
      }
      if (latency.completeness !== undefined) {
        lines.push(`  completeness: ${(latency.completeness * 100).toFixed(0)}%`);
      }
      if (latency.t95 !== undefined) {
        lines.push(`  t95: ${latency.t95.toFixed(1)}d`);
      }
      if (latency.anchor_node_id) {
        lines.push(`  anchor: ${latency.anchor_node_id}`);
      }
    }
    
    // Forecast information (if available)
    const forecast = fullEdge?.p?.forecast;
    if (forecast && forecast.mean !== undefined) {
      lines.push('');
      lines.push(`forecast (p∞): ${(forecast.mean * 100).toFixed(1)}%`);
      if (forecast.stdev !== undefined) {
        lines.push(`  ±${(forecast.stdev * 100).toFixed(1)}%`);
      }
    }
    
    // === PARAMS: e.<edgeId>.<condition>.p ===
    if (fullEdge?.conditional_p && fullEdge.conditional_p.length > 0) {
      for (const cond of fullEdge.conditional_p) {
        lines.push('');
        lines.push(`e.${edgeId}.${cond.condition}.p`);
        
        // Mean ± stdev
        const condVal = ((cond.p.mean ?? 0) * 100).toFixed(1);
        const condStd = cond.p.stdev ? ` ±${(cond.p.stdev * 100).toFixed(1)}` : '';
        lines.push(`  ${condVal}%${condStd}`);
        
        // Evidence or rebalanced indicator
        const condEvidence = cond.p.evidence;
        const condHasEvidence = condEvidence && (condEvidence.n !== undefined || condEvidence.k !== undefined);
        
        if (condHasEvidence && condEvidence) {
          if (condEvidence.n !== undefined && condEvidence.k !== undefined) {
            lines.push(`  n=${condEvidence.n} k=${condEvidence.k}`);
          }
          if (condEvidence.window_from && condEvidence.window_to) {
            const fmtDate = (d: Date) => `${d.getDate()}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]}`;
            lines.push(`  ${fmtDate(new Date(condEvidence.window_from))} to ${fmtDate(new Date(condEvidence.window_to))}`);
          }
          if (condEvidence.source) lines.push(`  source: ${condEvidence.source}`);
          // Query only if we have evidence (actual fetch happened)
          if (fullEdge?.query) {
            lines.push(`  query: ${fullEdge.query}.${cond.condition}`);
          }
        } else {
          lines.push(`  (rebalanced)`);
        }
      }
    }
    
    // Description
    if (data.description) {
      lines.push('');
      lines.push(data.description);
    }
    
    // Costs
    if (data.cost_gbp?.mean || data.labour_cost?.mean) {
      lines.push('');
      if (data.cost_gbp?.mean) lines.push(`cost_gbp: £${data.cost_gbp.mean.toFixed(0)}`);
      if (data.labour_cost?.mean) lines.push(`labour_cost: ${data.labour_cost.mean.toFixed(0)}d`);
    }
    
    // Snapshot availability (any param on this edge)
    const fmtDate = (d: string) => {
      const date = new Date(d);
      return `${date.getDate()}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getMonth()]}-${date.getFullYear().toString().slice(-2)}`;
    };
    const snapshotParamsWithData = snapshotParamIds.filter((pid) => (snapshots.inventories[pid]?.row_count ?? 0) > 0);
    if (snapshotParamsWithData.length > 0) {
      lines.push('');
      lines.push('snapshots:');
      for (const pid of snapshotParamsWithData) {
        const inv = snapshots.inventories[pid];
        if (!inv) continue;
        const range = inv.earliest && inv.latest ? `${fmtDate(inv.earliest)} — ${fmtDate(inv.latest)}` : '(range unknown)';
        lines.push(`  ${pid}: ${range}`);
      }
    }
    
    return lines.join('\n');
  };
  const { deleteElements, setEdges, getNodes, getEdges, screenToFlowPosition } = useReactFlow();
  const viewPrefs = useViewPreferencesContext();
  
  // Handle drag over for drop target (added to existing path elements)
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  // Handle drop of parameter file onto this edge
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    
    if (data?.scenarioOverlay) return; // Don't allow drops on overlay edges
    
    try {
      const jsonData = e.dataTransfer.getData('application/json');
      if (!jsonData) return;
      
      const dragData = JSON.parse(jsonData);
      if (dragData.type !== 'dagnet-drag' || dragData.objectType !== 'parameter') {
        return; // Silently ignore non-parameter drops
      }
      
      const paramId = dragData.objectId;
      const fileId = `parameter-${paramId}`;
      
      // Check if the parameter file exists
      const file = fileRegistry.getFile(fileId);
      if (!file) {
        toast.error(`Parameter file not found: ${paramId}`);
        return;
      }
      
      if (!graph) return;
      
      // Find the edge in the graph
      const edgeInGraph = graph.edges?.find((e: any) => 
        (e.id && e.id === id) || 
        (e.uuid && e.uuid === id) ||
        `${e.from}->${e.to}` === id
      );
      
      if (!edgeInGraph) {
        toast.error('Could not find edge in graph');
        return;
      }
      
      // Get parameter type from file data
      const paramType = file.data?.type;
      
      // Prepare the graph with the attached parameter ID
      const nextGraph = structuredClone(graph);
      const edgeIndex = nextGraph.edges?.findIndex((e: any) => 
        (e.id && e.id === id) || 
        (e.uuid && e.uuid === id) ||
        `${e.from}->${e.to}` === id
      );
      
      if (edgeIndex === undefined || edgeIndex === -1) return;
      
      // Attach parameter ID to the correct slot (p.id, cost_gbp.id, or labour_cost.id)
      if (paramType === 'probability') {
        if (!nextGraph.edges[edgeIndex].p) {
          nextGraph.edges[edgeIndex].p = { mean: 0 };
        }
        nextGraph.edges[edgeIndex].p.id = paramId;
      } else if (paramType === 'cost_gbp') {
        if (!nextGraph.edges[edgeIndex].cost_gbp) {
          nextGraph.edges[edgeIndex].cost_gbp = { mean: 0 };
        }
        nextGraph.edges[edgeIndex].cost_gbp.id = paramId;
      } else if (paramType === 'labour_cost') {
        if (!nextGraph.edges[edgeIndex].labour_cost) {
          nextGraph.edges[edgeIndex].labour_cost = { mean: 0 };
        }
        nextGraph.edges[edgeIndex].labour_cost.id = paramId;
      } else {
        // Default to probability parameter slot
        if (!nextGraph.edges[edgeIndex].p) {
          nextGraph.edges[edgeIndex].p = { mean: 0 };
        }
        nextGraph.edges[edgeIndex].p.id = paramId;
      }
      
      if (nextGraph.metadata) {
        nextGraph.metadata.updated_at = new Date().toISOString();
      }
      
      // Let getParameterFromFile handle the graph update - it will set p.id and fetch data
      try {
        await dataOperationsService.getParameterFromFile({
          paramId: paramId,
          edgeId: id,
          graph: nextGraph,
          setGraph: setGraph as any,
        });
        
        if (typeof saveHistoryState === 'function') {
          saveHistoryState('Attach parameter file', id);
        }
        
        toast.success(`Attached parameter: ${paramId}`);
      } catch (error) {
        console.error('[ConversionEdge] Failed to get parameter from file:', error);
        toast.error('Failed to load parameter data from file');
      }
    } catch (error) {
      console.error('[ConversionEdge] Drop error:', error);
    }
  }, [graph, id, data?.scenarioOverlay, setGraph, saveHistoryState]);
  
  // What-if DSL is now passed through edge.data (from tab state)
  const whatIfDSL = data?.whatIfDSL;
  
  // Get the full edge object from graph (needed for tooltips and colours)
  // Find edge in graph (check both uuid and human-readable id after Phase 0.0 migration)
  // For overlay edges, use originalEdgeId stored in data
  // Memoize to ensure it updates when graph changes
  // Create a string key that changes when any relevant edge data changes
  // This ensures fullEdge updates when evidence, mean, etc. change
  const edgeDataKey = useMemo(() => {
    const edge = graph?.edges?.find((e: any) => 
      e.uuid === lookupId || e.id === lookupId || `${e.from}->${e.to}` === lookupId
    );
    if (!edge) return 'none';
    return `${edge.uuid}-${edge.p?.mean}-${edge.p?.stdev}-${edge.p?.evidence?.n}-${edge.p?.evidence?.k}-${edge.p?.evidence?.mean}-${edge.p?.latency?.completeness}`;
  }, [graph, lookupId, graph?.metadata?.updated_at]);
  
  const fullEdge = useMemo(() => {
    return graph?.edges.find((e: any) => 
      e.uuid === lookupId ||           // ReactFlow uses UUID as edge ID
      e.id === lookupId ||             // Human-readable ID
      `${e.from}->${e.to}` === lookupId  // Fallback format
    );
  }, [graph, lookupId, edgeDataKey]);
  
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
      // Find the start node - PRIORITIZE is_start=true over entry_weight>0
      const startNode = graph.nodes.find((n: any) => n.entry?.is_start === true) 
        || graph.nodes.find((n: any) => (n.entry?.entry_weight || 0) > 0);
      
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
  
  // Get scenario colours for beads
  const scenarioColours = useMemo(() => {
    const colourMap = new Map<string, string>();
    
    // Ensure we have at least 'current' if no scenarios visible
    const effectiveVisibleIds = visibleScenarioIds.length > 0 ? visibleScenarioIds : ['current'];
    const effectiveColourOrderIds = visibleColourOrderIds.length > 0 ? visibleColourOrderIds : ['current'];
    
    if (scenariosContext) {
      effectiveVisibleIds.forEach((id) => {
        const orderIdx = effectiveColourOrderIds.indexOf(id);
        if (orderIdx >= 0) {
          // Use colour from scenarios context or assign based on order
          const scenario = scenariosContext.scenarios?.find((s: any) => s.id === id);
          if (scenario?.colour) {
            colourMap.set(id, scenario.colour);
          } else if (id === 'current' && scenariosContext.currentColour) {
            colourMap.set(id, scenariosContext.currentColour);
          } else if (id === 'base' && scenariosContext.baseColour) {
            colourMap.set(id, scenariosContext.baseColour);
          } else {
            // Fallback: assign colour based on order
            const colours = ['#3b82f6', '#f97316', '#8b5cf6', '#ec4899', '#10b981'];
            colourMap.set(id, colours[orderIdx % colours.length]);
          }
        } else {
          // If not in colour order, use default
          if (id === 'current') {
            colourMap.set(id, scenariosContext.currentColour || '#000000');
          } else {
            colourMap.set(id, '#000000');
          }
        }
      });
    } else {
      // No scenarios context - use defaults
      effectiveVisibleIds.forEach((id) => {
        colourMap.set(id, id === 'current' ? '#000000' : '#808080');
      });
    }
    
    return colourMap;
  }, [scenariosContext, visibleScenarioIds, visibleColourOrderIds]);
  
  // Calculate stroke width using useMemo to enable CSS transitions
  const strokeWidth = useMemo(() => {
    // Use scaledWidth if available (for mass-based scaling modes), otherwise fall back to calculateWidth
    if (data?.scaledWidth !== undefined) {
      return data.scaledWidth;
    }
    if (data?.calculateWidth) {
      return data.calculateWidth();
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
  
  // Edge colour logic: highlight/selection shading
  // Case/conditional edge colours now shown as markers, not full edge colouring
  const edgeColour = useMemo(() => {
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
      
      // Blend scenario colour with black for highlight
      const baseColourHex = data?.scenarioColour || '#b3b3b3';
      const black = { r: 0, g: 0, b: 0 };
      const baseColourRgb = hexToRgb(baseColourHex);
      
      const blendedR = Math.round(black.r * blackIntensity + baseColourRgb.r * (1 - blackIntensity));
      const blendedG = Math.round(black.g * blackIntensity + baseColourRgb.g * (1 - blackIntensity));
      const blendedB = Math.round(black.b * blackIntensity + baseColourRgb.b * (1 - blackIntensity));
      
      return `rgb(${blendedR}, ${blendedG}, ${blendedB})`;
    }
    
    // Default: use scenario colour
    return data?.scenarioColour || '#b3b3b3';
  }, [effectiveSelected, data?.isHighlighted, data?.highlightDepth, data?.isSingleNodeHighlight, data?.scenarioColour]);
  
  const getEdgeColour = () => edgeColour;

  // Band opacity schema – experimental: very low opacities
  // Outer: 0.1, Middle: 0.4, Inner: 0.5
  const calculateBandOpacities = (level: '80' | '90' | '95' | '99') => {
    const inner = 0.15;
    const middle = 0.55;
    // Outer could scale slightly with CI level, but keeping it simple for now
    const outer = 0.15;
    return { inner, middle, outer };
  };

  // Calculate confidence bounds and colours if needed
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
      // FIX: Mass generosity compresses visual differences via power transformation
      // To compensate, we amplify the probability ratios BEFORE applying the transformation
      // This effectively gives CIs more "room" in the visual space
      
      // Calculate the CI spread amplification factor
      // Higher mass generosity = more compression = need more amplification
      // g=0 (linear): amplify 1x (no compression)
      // g=0.5 (sqrt): amplify ~1.5x 
      // g=0.8 (5th root): amplify ~2x
      const amplificationFactor = 1 + massGenerosity;
      
      // Amplify the probability ratios around the mean
      const upperRatio = bounds.upper / mean;
      const lowerRatio = bounds.lower / mean;
      const amplifiedUpperRatio = 1 + (upperRatio - 1) * amplificationFactor;
      const amplifiedLowerRatio = 1 - (1 - lowerRatio) * amplificationFactor;
      
      // Clamp to reasonable bounds (don't let it go too extreme)
      const clampedUpperRatio = Math.min(2.0, Math.max(1.0, amplifiedUpperRatio));
      const clampedLowerRatio = Math.max(0.3, Math.min(1.0, amplifiedLowerRatio));
      
      // Reverse the scaling to get actual mass
      const displayMass = (strokeWidth - MIN_WIDTH) / (MAX_WIDTH - MIN_WIDTH);
      const actualMass = Math.pow(displayMass, 1 / (1 - massGenerosity));
      
      // Calculate actual masses using amplified ratios
      const actualMassUpper = actualMass * clampedUpperRatio;
      const actualMassLower = actualMass * clampedLowerRatio;
      
      // Apply log scaling to each bound
      const displayMassUpper = Math.pow(actualMassUpper, 1 - massGenerosity);
      const displayMassLower = Math.pow(actualMassLower, 1 - massGenerosity);
      
      // Convert back to widths
      widthUpper = MIN_WIDTH + displayMassUpper * (MAX_WIDTH - MIN_WIDTH);
      widthMiddle = strokeWidth;
      widthLower = MIN_WIDTH + displayMassLower * (MAX_WIDTH - MIN_WIDTH);
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
  
  // LAG two-layer rendering data - computed from strokeWidth using pre-computed RATIOS and flags
  // Uses pre-computed hasEvidence/evidenceIsZero to properly distinguish:
  //   - "not an evidential edge" (no p.evidence block) → faint full-width edge with NO_EVIDENCE_E_MODE_OPACITY
  //   - "evidential edge with evidence.mean=0" (k=0) → thin dashed line
  const lagLayerData = useMemo(() => {
    const ld = data?.edgeLatencyDisplay;
    
    // No LAG data or disabled → normal rendering at p.mean width
    if (!ld || !ld.enabled) {
      return null;
    }

    const mode = ld.mode ?? 'f+e';
    const pEvidence = ld.p_evidence;
    const pForecast = ld.p_forecast;
    const pMean = ld.p_mean ?? pForecast ?? pEvidence;
    
    // Use pre-computed evidence flags (critical for proper distinction)
    const hasEvidence = ld.hasEvidence ?? (typeof pEvidence === 'number');
    const evidenceIsZero = ld.evidenceIsZero ?? (hasEvidence && pEvidence === 0);

    // Always use strokeWidth as the base for consistency
    const baseWidth = strokeWidth;

    if (mode === 'e') {
      // E mode:
      // In the unified pipeline, the *geometry* width (strokeWidth/baseWidth) is already driven
      // by the evidence basis (explicit or derived) in E mode. So the E lane should be full width,
      // except for the explicit k=0 case (hairline).
      let evidenceWidth = 0;
      let evidenceRatio = ld.evidenceRatio ?? 0;
      
      if (hasEvidence && !evidenceIsZero && pEvidence! > 0) {
        evidenceRatio = 1;
        evidenceWidth = baseWidth;
      } else if (evidenceIsZero) {
        evidenceWidth = 0;
        evidenceRatio = 0;
      } else if (!hasEvidence) {
        // No evidence anywhere: fall back to mean behaviour but keep the E-mode signalling.
        evidenceWidth = baseWidth;
        evidenceRatio = 1;
      }
      
      return {
        mode: 'e' as const,
        evidenceWidth,
        meanWidth: baseWidth,
        evidenceRatio,
        evidence: pEvidence ?? 0,
        mean: pMean ?? pEvidence ?? 0,
        hasEvidence,
        evidenceIsZero
      };
    }

    if (mode === 'f') {
      // F mode:
      // In the unified pipeline, the geometry width (strokeWidth/baseWidth) is already driven by
      // the forecast basis in F mode. Do not apply a second p_forecast/p_mean scaling here.
      return {
        mode: 'f' as const,
        evidenceWidth: 0,
        meanWidth: Math.max(MIN_EDGE_WIDTH, baseWidth),
        evidenceRatio: 0,
        evidence: pEvidence ?? 0,
        mean: pForecast ?? pMean ?? 0,
        hasEvidence,
        evidenceIsZero
      };
    }

    // F+E mode: both layers
    let evidenceRatio = ld.evidenceRatio ?? 0;
    let evidenceWidth = 0;
    
    if (hasEvidence && !evidenceIsZero && pEvidence! > 0 && pMean && pMean > 0) {
      // Evidence exists and is non-zero
      if (evidenceRatio === 0) {
        evidenceRatio = Math.min(1, Math.max(0, pEvidence! / pMean));
      }
      evidenceWidth = Math.max(0, baseWidth * evidenceRatio);
    }
    // When evidenceIsZero or !hasEvidence, evidenceWidth stays at 0
    
    const meanWidth = baseWidth;

    return {
      mode: 'f+e' as const,
      evidenceWidth,
      meanWidth,
      evidenceRatio,
      evidence: pEvidence ?? 0,
      mean: pMean ?? 0,
      hasEvidence,
      evidenceIsZero
    };
  }, [data?.edgeLatencyDisplay, strokeWidth]);
  
  // Should we show LAG two-layer rendering?
  // For normal edges: stroked paths with stripe patterns
  // For Sankey: filled ribbons with nested layers
  // Unified pipeline: LAG rendering is always available, even when CI is enabled.
  // CI and Sankey are geometry/overlay specialisations; they must not disable the LAG semantics.
  const shouldShowLagLayers = lagLayerData !== null;
  const shouldShowSankeyFE = data?.useSankeyView && lagLayerData !== null;
  
  // DEBUG: Log Sankey F+E state
  if (data?.useSankeyView) {
    console.log(`[Sankey F+E] Edge ${id}: shouldShowSankeyFE=${shouldShowSankeyFE}, lagLayerData=`, lagLayerData, 'edgeLatencyDisplay=', data?.edgeLatencyDisplay);
  }
  
  // IMPORTANT: Do NOT imperatively overwrite strokeWidth via DOM.
  // This was causing "fat dashed lines" by overriding the E-mode zero-evidence hairline
  // after layout/drag nudges (pathRef points at the anchor/interaction path in multiple modes).
  // Stroke widths are fully controlled by React styles on each path.
  
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

  // Calculate midpoint chevron for direction indication
  const midpointChevron = React.useMemo(() => {
    try {
      // Extract first 8 numbers from the path: M sx,sy C c1x,c1y c2x,c2y ex,ey
      const nums = edgePath.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi);
      if (!nums || nums.length < 8) return null;
      const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = nums.slice(0, 8).map(Number);

      const t = 0.5; // midpoint of the curve

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

      // Calculate tangent for chevron direction
      const tangentX = p123x - p012x;
      const tangentY = p123y - p012y;
      const angle = Math.atan2(tangentY, tangentX);

      // Calculate perpendicular (normal) direction
      const normalX = -Math.sin(angle);
      const normalY = Math.cos(angle);

      // Chevron dimensions - scale with edge width to maintain consistent angle
      const halfEdgeWidth = strokeWidth / 2; // half the edge width for perpendicular extent
      // Use proportional depths so the chevron angle stays consistent regardless of edge width
      // A ratio of 1.0 gives 45-degree angles, 0.5 gives shallower angles
      const angleRatio = 0.5; // Controls how pointy the chevron is
      const backIndentDepth = halfEdgeWidth * angleRatio; // scales with edge width
      const frontPointDepth = halfEdgeWidth * angleRatio; // scales with edge width
      const chevronLength = halfEdgeWidth * 1; // total length also scales

      // Direction vectors (pointing from source to target)
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);

      // Chevron center point
      const cx = p0123x;
      const cy = p0123y;

      // Back of chevron (upstream side - toward source)
      const backCenterX = cx - (chevronLength / 2) * dirX;
      const backCenterY = cy - (chevronLength / 2) * dirY;
      
      // Front of chevron (downstream side - toward target)
      const frontCenterX = cx + (chevronLength / 2) * dirX;
      const frontCenterY = cy + (chevronLength / 2) * dirY;

      // Back corners (at edge width)
      const backLeftX = backCenterX + halfEdgeWidth * normalX;
      const backLeftY = backCenterY + halfEdgeWidth * normalY;
      const backRightX = backCenterX - halfEdgeWidth * normalX;
      const backRightY = backCenterY - halfEdgeWidth * normalY;
      
      // Back indent point (the V notch pointing backward toward source)
      const backIndentX = backCenterX + backIndentDepth * dirX;
      const backIndentY = backCenterY + backIndentDepth * dirY;

      // Front corners (at edge width)
      const frontLeftX = frontCenterX + halfEdgeWidth * normalX;
      const frontLeftY = frontCenterY + halfEdgeWidth * normalY;
      const frontRightX = frontCenterX - halfEdgeWidth * normalX;
      const frontRightY = frontCenterY - halfEdgeWidth * normalY;
      
      // Front point (tip pointing forward toward target)
      const frontPointX = frontCenterX + frontPointDepth * dirX;
      const frontPointY = frontCenterY + frontPointDepth * dirY;

      // Create filled chevron polygon pointing in direction of travel:
      // Pointy at both ends - V notch at back, point at front
      return {
        x: p0123x,
        y: p0123y,
        angle: angle * (180 / Math.PI),
        // Filled chevron: back left -> back indent (V) -> back right -> front right -> front point -> front left -> close
        path: `M ${backLeftX},${backLeftY} L ${backIndentX},${backIndentY} L ${backRightX},${backRightY} L ${frontRightX},${frontRightY} L ${frontPointX},${frontPointY} L ${frontLeftX},${frontLeftY} Z`
      };
    } catch {
      return null;
    }
  }, [edgePath, strokeWidth]);

  // Calculate multiple chevrons along the spline for LAG anchor
  const splineChevrons = React.useMemo(() => {
    if (!LAG_ANCHOR_USE_SPLINE_CHEVRONS || !shouldShowLagLayers) return null;
    
    try {
      const nums = edgePath.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi);
      if (!nums || nums.length < 8) return null;
      const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = nums.slice(0, 8).map(Number);
      
      const completeness = (data?.edgeLatencyDisplay?.completeness_pct ?? 100) / 100;
      const chevrons: Array<{ path: string; opacity: number }> = [];
      
      const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
      
      // Helper to get point on bezier at parameter t
      const getBezierPoint = (t: number) => {
        const p01x = lerp(sx, c1x, t);
        const p01y = lerp(sy, c1y, t);
        const p12x = lerp(c1x, c2x, t);
        const p12y = lerp(c1y, c2y, t);
        const p23x = lerp(c2x, ex, t);
        const p23y = lerp(c2y, ey, t);
        const p012x = lerp(p01x, p12x, t);
        const p012y = lerp(p01y, p12y, t);
        const p123x = lerp(p12x, p23x, t);
        const p123y = lerp(p12y, p23y, t);
        return {
          x: lerp(p012x, p123x, t),
          y: lerp(p012y, p123y, t),
          tangentX: p123x - p012x,
          tangentY: p123y - p012y
        };
      };
      
      // Build arc-length lookup table by sampling the bezier
      const numSamples = 100;
      const arcLengthTable: { t: number; length: number }[] = [{ t: 0, length: 0 }];
      let totalLength = 0;
      let prevPoint = getBezierPoint(0);
      
      for (let i = 1; i <= numSamples; i++) {
        const t = i / numSamples;
        const point = getBezierPoint(t);
        const segmentLength = Math.sqrt((point.x - prevPoint.x) ** 2 + (point.y - prevPoint.y) ** 2);
        totalLength += segmentLength;
        arcLengthTable.push({ t, length: totalLength });
        prevPoint = point;
      }
      
      // Function to find t for a given arc length
      const getTForLength = (targetLength: number): number => {
        if (targetLength <= 0) return 0;
        if (targetLength >= totalLength) return 1;
        
        // Binary search
        let low = 0, high = arcLengthTable.length - 1;
        while (low < high - 1) {
          const mid = Math.floor((low + high) / 2);
          if (arcLengthTable[mid].length < targetLength) {
            low = mid;
          } else {
            high = mid;
          }
        }
        
        // Interpolate between low and high
        const lowEntry = arcLengthTable[low];
        const highEntry = arcLengthTable[high];
        const segmentFraction = (targetLength - lowEntry.length) / (highEntry.length - lowEntry.length);
        return lerp(lowEntry.t, highEntry.t, segmentFraction);
      };
      
      // Chevron dimensions
      const halfWidth = strokeWidth / 2;  // Width based on edge probability
      const chevronLength = LAG_ANCHOR_SPLINE_CHEVRON_LENGTH;  // Absolute length (pixels)
      const chevronGap = LAG_ANCHOR_SPLINE_CHEVRON_GAP;  // Absolute gap (pixels)
      // Indent calculated from angle: tan(angle) = indent / halfWidth
      const chevronIndent = halfWidth * Math.tan(LAG_ANCHOR_SPLINE_CHEVRON_ANGLE * Math.PI / 180);
      
      // Spacing = chevron length + gap
      const spacing = chevronLength + chevronGap;
      
      // Calculate number of chevrons based on actual path length
      const numChevrons = Math.max(1, Math.floor(totalLength / spacing));
      const actualSpacing = totalLength / numChevrons;
      
      // Generate chevrons at evenly spaced ARC LENGTH positions
      for (let i = 0; i < numChevrons; i++) {
        const targetLength = (i + 0.5) * actualSpacing; // Center each chevron
        const t = getTForLength(targetLength);
        
        // Calculate opacity based on position along path (use arc length fraction)
        const lengthFraction = targetLength / totalLength;
        let opacity = 1;
        if (lengthFraction > completeness - LAG_ANCHOR_FADE_BAND / 2) {
          if (lengthFraction > completeness + LAG_ANCHOR_FADE_BAND / 2) {
            opacity = LAG_ANCHOR_FADE_MIN;
          } else {
            // Fade within the band
            const fadeProgress = (lengthFraction - (completeness - LAG_ANCHOR_FADE_BAND / 2)) / LAG_ANCHOR_FADE_BAND;
            opacity = lerp(1, LAG_ANCHOR_FADE_MIN, fadeProgress);
          }
        }
        
        // Get point and tangent at this position
        const point = getBezierPoint(t);
        const cx = point.x;
        const cy = point.y;
        const angle = Math.atan2(point.tangentY, point.tangentX);

        // Direction vectors
        const dirX = Math.cos(angle);
        const dirY = Math.sin(angle);
        const normalX = -Math.sin(angle);
        const normalY = Math.cos(angle);

        // Filled chevron: rectangle with V-shaped front and back (all absolute pixels)
        // Back center (upstream)
        const backCenterX = cx - (chevronLength / 2) * dirX;
        const backCenterY = cy - (chevronLength / 2) * dirY;
        
        // Front center (downstream)
        const frontCenterX = cx + (chevronLength / 2) * dirX;
        const frontCenterY = cy + (chevronLength / 2) * dirY;
        
        // Back corners at full width
        const backLeftX = backCenterX + halfWidth * normalX;
        const backLeftY = backCenterY + halfWidth * normalY;
        const backRightX = backCenterX - halfWidth * normalX;
        const backRightY = backCenterY - halfWidth * normalY;
        
        // Back indent (V notch pointing backward/upstream) - absolute indent
        const backIndentX = backCenterX + chevronIndent * dirX;
        const backIndentY = backCenterY + chevronIndent * dirY;
        
        // Front corners at full width
        const frontLeftX = frontCenterX + halfWidth * normalX;
        const frontLeftY = frontCenterY + halfWidth * normalY;
        const frontRightX = frontCenterX - halfWidth * normalX;
        const frontRightY = frontCenterY - halfWidth * normalY;
        
        // Front point (tip pointing forward/downstream) - absolute indent
        const frontPointX = frontCenterX + chevronIndent * dirX;
        const frontPointY = frontCenterY + chevronIndent * dirY;

        // 6-point polygon: backLeft -> backIndent -> backRight -> frontRight -> frontPoint -> frontLeft -> close
        chevrons.push({
          path: `M ${backLeftX},${backLeftY} L ${backIndentX},${backIndentY} L ${backRightX},${backRightY} L ${frontRightX},${frontRightY} L ${frontPointX},${frontPointY} L ${frontLeftX},${frontLeftY} Z`,
          opacity
        });
      }
      
      return chevrons;
    } catch {
      return null;
    }
  }, [edgePath, strokeWidth, shouldShowLagLayers, data?.edgeLatencyDisplay?.completeness_pct]);

  // Single completeness chevron at the completeness % position along the edge
  // Width = max(meanWidth, evidenceWidth) + padding, with minimum for visibility over beads
  // Suppress at 100% completeness - no need to show marker when fully complete
  // Only show when scenario is tracking evidence (F+E or E mode, not F-only)
  const completenessChevron = React.useMemo(() => {
    if (!shouldShowLagLayers || !lagLayerData || data?.useSankeyView) return null;
    
    // Don't show completeness chevron in F-only mode (no evidence tracking)
    if (lagLayerData.mode === 'f') return null;
    
    const completeness = (data?.edgeLatencyDisplay?.completeness_pct ?? 100) / 100;
    // Suppress chevron at 100% completeness
    if (completeness >= 0.999) return null;
    
    try {
      const nums = edgePath.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi);
      if (!nums || nums.length < 8) return null;
      
      const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = nums.slice(0, 8).map(Number);
      
      const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
      
      // Helper to get point on bezier at parameter t
      const getBezierPoint = (t: number) => {
        const p01x = lerp(sx, c1x, t);
        const p01y = lerp(sy, c1y, t);
        const p12x = lerp(c1x, c2x, t);
        const p12y = lerp(c1y, c2y, t);
        const p23x = lerp(c2x, ex, t);
        const p23y = lerp(c2y, ey, t);
        const p012x = lerp(p01x, p12x, t);
        const p012y = lerp(p01y, p12y, t);
        const p123x = lerp(p12x, p23x, t);
        const p123y = lerp(p12y, p23y, t);
        const x = lerp(p012x, p123x, t);
        const y = lerp(p012y, p123y, t);
        const tangentX = p123x - p012x;
        const tangentY = p123y - p012y;
        return { x, y, tangentX, tangentY };
      };
      
      // Approximate path length for converting pixel offsets to t values
      const dx = ex - sx;
      const dy = ey - sy;
      const approxLength = Math.sqrt(dx * dx + dy * dy);
      
      // Calculate half-width first (needed for rendered length calculation)
      const maxLayerWidth = Math.max(lagLayerData.meanWidth, lagLayerData.evidenceWidth);
      const halfWidth = Math.max(
        COMPLETENESS_CHEVRON_MIN_HALF_WIDTH,
        (maxLayerWidth / 2) + COMPLETENESS_CHEVRON_WIDTH_PADDING
      );
      
      // Chevron geometry - wider chevrons have longer front/back indents
      const chevronLength = LAG_ANCHOR_SPLINE_CHEVRON_LENGTH;
      const chevronIndent = halfWidth * Math.tan(LAG_ANCHOR_SPLINE_CHEVRON_ANGLE * Math.PI / 180);
      // Total rendered length from back notch to front point
      const renderedLength = chevronLength + 2 * chevronIndent;
      
      // Convert pixel offsets to t values, adjusting for rendered chevron length
      // At 0%: front tip at start boundary → center offset by -halfRenderedLength
      // At 100%: back notch at end boundary → end offset increased by +halfRenderedLength
      const effectiveStartOffset = COMPLETENESS_CHEVRON_START_OFFSET - renderedLength / 2;
      const effectiveEndOffset = COMPLETENESS_CHEVRON_END_OFFSET + renderedLength / 2;
      const tStart = Math.min(0.4, Math.max(0, effectiveStartOffset) / approxLength);
      const tEnd = Math.max(0.6, 1 - effectiveEndOffset / approxLength);
      
      // Get position at completeness % (mapped to visible range)
      const tRange = tEnd - tStart;
      const t = tStart + completeness * tRange;
      const { x: cx, y: cy, tangentX, tangentY } = getBezierPoint(t);
      
      const angle = Math.atan2(tangentY, tangentX);
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);
      const normalX = -Math.sin(angle);
      const normalY = Math.cos(angle);
      
      // Back center (upstream)
      const backCenterX = cx - (chevronLength / 2) * dirX;
      const backCenterY = cy - (chevronLength / 2) * dirY;
      
      // Front center (downstream)
      const frontCenterX = cx + (chevronLength / 2) * dirX;
      const frontCenterY = cy + (chevronLength / 2) * dirY;
      
      // Back corners at full width
      const backLeftX = backCenterX + halfWidth * normalX;
      const backLeftY = backCenterY + halfWidth * normalY;
      const backRightX = backCenterX - halfWidth * normalX;
      const backRightY = backCenterY - halfWidth * normalY;
      
      // Back indent (V notch pointing backward/upstream)
      const backIndentX = backCenterX + chevronIndent * dirX;
      const backIndentY = backCenterY + chevronIndent * dirY;
      
      // Front corners at full width
      const frontLeftX = frontCenterX + halfWidth * normalX;
      const frontLeftY = frontCenterY + halfWidth * normalY;
      const frontRightX = frontCenterX - halfWidth * normalX;
      const frontRightY = frontCenterY - halfWidth * normalY;
      
      // Front point (tip pointing forward/downstream)
      const frontPointX = frontCenterX + chevronIndent * dirX;
      const frontPointY = frontCenterY + chevronIndent * dirY;
      
      return {
        path: `M ${backLeftX},${backLeftY} L ${backIndentX},${backIndentY} L ${backRightX},${backRightY} L ${frontRightX},${frontRightY} L ${frontPointX},${frontPointY} L ${frontLeftX},${frontLeftY} Z`,
        completeness
      };
    } catch {
      return null;
    }
  }, [edgePath, shouldShowLagLayers, lagLayerData, data?.useSankeyView, data?.edgeLatencyDisplay?.completeness_pct]);

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

  // Generate F+E ribbon paths for Sankey mode
  // Outer ribbon (forecast) = full width, Inner ribbon (evidence) = narrower
  // Plus completeness marker line at x% along the path (only when evidence visible)
  const sankeyFERibbons = React.useMemo(() => {
    if (!data?.useSankeyView || !lagLayerData) return null;
    
    // Parse the bezier path to get control points
    const nums = edgePath.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi);
    if (!nums || nums.length < 8) return null;
    
    const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = nums.slice(0, 8).map(Number);
    
    // Helper to compute ribbon path for a given width
    const computeRibbon = (width: number) => {
      const dx1 = c1x - sx;
      const dy1 = c1y - sy;
      const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1;
      const perpX1 = -dy1 / len1;
      const perpY1 = dx1 / len1;
      
      const dx2 = ex - c2x;
      const dy2 = ey - c2y;
      const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
      const perpX2 = -dy2 / len2;
      const perpY2 = dx2 / len2;
      
      const halfWidth = width / 2;
      
      const topSx = sx - perpX1 * halfWidth;
      const topSy = sy - perpY1 * halfWidth;
      const topC1x = c1x - perpX1 * halfWidth;
      const topC1y = c1y - perpY1 * halfWidth;
      const topC2x = c2x - perpX2 * halfWidth;
      const topC2y = c2y - perpY2 * halfWidth;
      const topEx = ex - perpX2 * halfWidth;
      const topEy = ey - perpY2 * halfWidth;
      
      const botEx = ex + perpX2 * halfWidth;
      const botEy = ey + perpY2 * halfWidth;
      const botC2x = c2x + perpX2 * halfWidth;
      const botC2y = c2y + perpY2 * halfWidth;
      const botC1x = c1x + perpX1 * halfWidth;
      const botC1y = c1y + perpY1 * halfWidth;
      const botSx = sx + perpX1 * halfWidth;
      const botSy = sy + perpY1 * halfWidth;
      
      return `M ${topSx},${topSy} C ${topC1x},${topC1y} ${topC2x},${topC2y} ${topEx},${topEy} L ${botEx},${botEy} C ${botC2x},${botC2y} ${botC1x},${botC1y} ${botSx},${botSy} Z`;
    };
    
    // Compute point along bezier at t (0-1)
    const bezierPoint = (t: number) => {
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
    
    // Get completeness from latency display data (completeness_pct is 0-100)
    const completeness = (data?.edgeLatencyDisplay?.completeness_pct ?? 100) / 100;
    
    // Calculate path length to determine clipped portions
    // Approximate: total bezier length and inset at each end (where ribbon is hidden by nodes)
    const pathDx = ex - sx;
    const pathDy = ey - sy;
    const approxPathLength = Math.sqrt(pathDx * pathDx + pathDy * pathDy);
    
    // Inset at each end - ribbons are clipped by nodes (constant from nodeEdgeConstants)
    const visibleLength = Math.max(approxPathLength - 2 * SANKEY_NODE_INSET, approxPathLength * 0.5);
    
    // Map completeness to visible portion: 0% = just after source inset, 100% = just before target inset
    const tStart = SANKEY_NODE_INSET / approxPathLength;
    const tEnd = 1 - (SANKEY_NODE_INSET / approxPathLength);
    const tVisible = tStart + completeness * (tEnd - tStart);
    const t = Math.max(tStart, Math.min(tEnd, tVisible));
    
    // DEBUG: Log completeness calculation
    console.log(`[Sankey F+E] Edge ${id}: completeness_pct=${data?.edgeLatencyDisplay?.completeness_pct}, t=${t.toFixed(3)} (visible range: ${tStart.toFixed(3)}-${tEnd.toFixed(3)})`);
    
    // Compute completeness marker line (VERTICAL dashed line at t% along VISIBLE ribbon)
    // Always compute for F+E and E modes - completeness is about latency, not k
    // Suppress at 100% completeness - no need to show marker when fully complete
    let completenessLine: { x1: number; y1: number; x2: number; y2: number } | null = null;
    if (lagLayerData.mode !== 'f' && completeness < 0.999) {  // Show whenever evidence is being tracked, but not at 100%
      const point = bezierPoint(t);
      // Vertical line with overhang beyond ribbon edges for visibility
      // halfHeight = ribbon half-width + overhang, but at least min height
      const ribbonHalfWidth = lagLayerData.meanWidth / 2;
      const halfHeight = Math.max(
        ribbonHalfWidth + SANKEY_COMPLETENESS_LINE_OVERHANG,
        SANKEY_COMPLETENESS_LINE_MIN_HEIGHT / 2
      );
      
      completenessLine = {
        x1: point.x,
        y1: point.y - halfHeight,
        x2: point.x,
        y2: point.y + halfHeight
      };
    }
    
    // F mode: striped ribbon at forecast width (meanWidth)
    // F+E mode: outer striped ribbon at mean width + inner solid ribbon at evidence width
    // E mode: single solid ribbon at evidence width
    const outerWidth = lagLayerData.mode === 'e' ? lagLayerData.evidenceWidth : lagLayerData.meanWidth;
    
    return {
      outerRibbon: computeRibbon(outerWidth),
      // Inner ribbon only when there's actual evidence (evidenceWidth > 0)
      innerRibbon: lagLayerData.mode === 'f+e' && lagLayerData.evidenceWidth > 0 
        ? computeRibbon(lagLayerData.evidenceWidth) 
        : null,
      completenessLine,
      evidenceRatio: lagLayerData.evidenceRatio,
      mode: lagLayerData.mode
    };
  }, [edgePath, data?.useSankeyView, lagLayerData, data?.edgeLatencyDisplay?.completeness_pct]);

  // Check if this is a hidden current layer (semi-transparent current when not visible)
  const isHiddenCurrent = !data?.scenarioOverlay && (data?.strokeOpacity ?? 1) < 0.1;
  
  return (
    <>
      <defs>
        {/* Stipple (dot) pattern for hidden current layer - replaces old stripe pattern */}
        {isHiddenCurrent && (
          <pattern
            id={`lag-anchor-stipple-${id}`}
            patternUnits="userSpaceOnUse"
            width={LAG_ANCHOR_STIPPLE_SPACING}
            height={LAG_ANCHOR_STIPPLE_SPACING}
            patternTransform={`rotate(${HIDDEN_CURRENT_STIPPLE_ANGLE})`}
          >
            <circle 
              cx={LAG_ANCHOR_STIPPLE_SPACING / 2} 
              cy={LAG_ANCHOR_STIPPLE_SPACING / 2} 
              r={LAG_ANCHOR_STIPPLE_RADIUS} 
              fill={getEdgeColour()}
              // Interaction parity: selected/highlighted hidden-current must "pop" more.
              fillOpacity={
                effectiveSelected
                  ? HIDDEN_CURRENT_SELECTED_OPACITY
                  : (data?.isHighlighted ? HIDDEN_CURRENT_HIGHLIGHTED_OPACITY : HIDDEN_CURRENT_OPACITY)
              }
            />
          </pattern>
        )}
        {/* LAG two-layer stripe patterns: inner (offset 0) and outer (offset half) */}
        {shouldShowLagLayers && (
          <>
            {/* Anchor fade gradient - fades AROUND completeness point
                Completeness = how much of the expected conversions we've observed
                Gradient: full opacity → fades → 0 opacity, centered on completeness
                Fade band width: 20% of path (±10% around completeness) - could use latency.stdev later */}
            <linearGradient
              id={`lag-anchor-fade-${id}`}
              gradientUnits="userSpaceOnUse"
              x1={adjustedSourceX}
              // Sankey: keep fade axis horizontal so the fade boundary is vertical (flat),
              // rather than perpendicular to a spline-angled gradient.
              y1={data?.useSankeyView ? (adjustedSourceY + adjustedTargetY) / 2 : adjustedSourceY}
              x2={adjustedTargetX}
              y2={data?.useSankeyView ? (adjustedSourceY + adjustedTargetY) / 2 : adjustedTargetY}
            >
              {(() => {
                const completeness = (data?.edgeLatencyDisplay?.completeness_pct ?? 100) / 100;
                const fadeStart = Math.max(0, completeness - LAG_ANCHOR_FADE_BAND / 2);
                const fadeEnd = Math.min(1, completeness + LAG_ANCHOR_FADE_BAND / 2);
                const anchorColor = (effectiveSelected || data?.isHighlighted) 
                  ? getEdgeColour() 
                  : (data?.scenarioColour || getEdgeColour());
                return (
                  <>
                    {/* Full opacity from start to fadeStart */}
                    <stop offset="0%" stopColor={anchorColor} stopOpacity={1} />
                    <stop offset={`${fadeStart * 100}%`} stopColor={anchorColor} stopOpacity={1} />
                    {/* Fade from 1 to min between fadeStart and fadeEnd */}
                    <stop offset={`${fadeEnd * 100}%`} stopColor={anchorColor} stopOpacity={LAG_ANCHOR_FADE_MIN} />
                    {/* Minimum opacity from fadeEnd to end */}
                    <stop offset="100%" stopColor={anchorColor} stopOpacity={LAG_ANCHOR_FADE_MIN} />
                  </>
                );
              })()}
            </linearGradient>
            {/* Anchor pattern - stripes or chevrons with solid color (mask handles fade) */}
            {LAG_ANCHOR_USE_STRIPES && (
              <>
                <pattern
                  id={`lag-anchor-stripe-${id}`}
                  patternUnits="userSpaceOnUse"
                  width={LAG_ANCHOR_USE_CHEVRONS 
                    ? LAG_ANCHOR_CHEVRON_SIZE + LAG_ANCHOR_CHEVRON_GAP 
                    : LAG_ANCHOR_STRIPE_WIDTH + LAG_ANCHOR_STRIPE_GAP}
                  height={LAG_ANCHOR_USE_CHEVRONS 
                    ? LAG_ANCHOR_CHEVRON_SIZE + LAG_ANCHOR_CHEVRON_GAP 
                    : LAG_ANCHOR_STRIPE_WIDTH + LAG_ANCHOR_STRIPE_GAP}
                  patternTransform={LAG_ANCHOR_USE_CHEVRONS ? undefined : `rotate(${LAG_ANCHOR_STRIPE_ANGLE})`}
                >
                  {LAG_ANCHOR_USE_CHEVRONS ? (
                    // Chevron pattern: > shape pointing right (along edge direction)
                    <path
                      d={`M0,0 L${LAG_ANCHOR_CHEVRON_SIZE / 2},${LAG_ANCHOR_CHEVRON_SIZE / 2} L0,${LAG_ANCHOR_CHEVRON_SIZE}`}
                      stroke={(effectiveSelected || data?.isHighlighted) 
                        ? getEdgeColour() 
                        : (data?.scenarioColour || getEdgeColour())}
                      strokeWidth={LAG_ANCHOR_CHEVRON_STROKE}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      fill="none"
                    />
                  ) : (
                    // Stripe pattern
                    <rect 
                      x="0" 
                      y="0" 
                      width={LAG_ANCHOR_STRIPE_WIDTH} 
                      height={LAG_ANCHOR_STRIPE_WIDTH + LAG_ANCHOR_STRIPE_GAP} 
                      fill={(effectiveSelected || data?.isHighlighted) 
                        ? getEdgeColour() 
                        : (data?.scenarioColour || getEdgeColour())}
                    />
                  )}
                </pattern>
                {/* Mask for anchor fade - white gradient controls visibility along path */}
                <mask id={`lag-anchor-fade-mask-${id}`} maskUnits="userSpaceOnUse"
                  x={Math.min(adjustedSourceX, adjustedTargetX) - 100}
                  y={Math.min(adjustedSourceY, adjustedTargetY) - 100}
                  width={Math.abs(adjustedTargetX - adjustedSourceX) + 200}
                  height={Math.abs(adjustedTargetY - adjustedSourceY) + 200}
                >
                  <rect
                    x={Math.min(adjustedSourceX, adjustedTargetX) - 100}
                    y={Math.min(adjustedSourceY, adjustedTargetY) - 100}
                    width={Math.abs(adjustedTargetX - adjustedSourceX) + 200}
                    height={Math.abs(adjustedTargetY - adjustedSourceY) + 200}
                    fill={`url(#lag-anchor-fade-white-${id})`}
                  />
                </mask>
                {/* White gradient for mask (white = visible, aligned source→target) */}
                <linearGradient
                  id={`lag-anchor-fade-white-${id}`}
                  gradientUnits="userSpaceOnUse"
                  x1={adjustedSourceX}
                  // Sankey: align mask gradient horizontally so the visible/invisible boundary is vertical.
                  y1={data?.useSankeyView ? (adjustedSourceY + adjustedTargetY) / 2 : adjustedSourceY}
                  x2={adjustedTargetX}
                  y2={data?.useSankeyView ? (adjustedSourceY + adjustedTargetY) / 2 : adjustedTargetY}
                >
                  {(() => {
                    const completeness = (data?.edgeLatencyDisplay?.completeness_pct ?? 100) / 100;
                    const fadeStart = Math.max(0, completeness - LAG_ANCHOR_FADE_BAND / 2);
                    const fadeEnd = Math.min(1, completeness + LAG_ANCHOR_FADE_BAND / 2);
                    return (
                      <>
                        <stop offset="0%" stopColor="white" stopOpacity={1} />
                        <stop offset={`${fadeStart * 100}%`} stopColor="white" stopOpacity={1} />
                        <stop offset={`${fadeEnd * 100}%`} stopColor="white" stopOpacity={LAG_ANCHOR_FADE_MIN} />
                        <stop offset="100%" stopColor="white" stopOpacity={LAG_ANCHOR_FADE_MIN} />
                      </>
                    );
                  })()}
                </linearGradient>
              </>
            )}
            {/* Inner stripe pattern (evidence layer) */}
            <pattern
              id={`lag-stripe-inner-${id}`}
              patternUnits="userSpaceOnUse"
              width={LAG_EVIDENCE_STRIPE_WIDTH + LAG_EVIDENCE_STRIPE_GAP}
              height={LAG_EVIDENCE_STRIPE_WIDTH + LAG_EVIDENCE_STRIPE_GAP}
              patternTransform={`rotate(${LAG_EVIDENCE_STRIPE_ANGLE})${LAG_EVIDENCE_STRIPE_OFFSET ? ` translate(${LAG_EVIDENCE_STRIPE_OFFSET}, 0)` : ''}`}
            >
              <rect x="0" y="0" width={LAG_EVIDENCE_STRIPE_WIDTH} height={LAG_EVIDENCE_STRIPE_WIDTH + LAG_EVIDENCE_STRIPE_GAP} 
                fill={(effectiveSelected || data?.isHighlighted) ? getEdgeColour() : (data?.scenarioColour || getEdgeColour())}
                fillOpacity={LAG_EVIDENCE_STRIPE_OPACITY}
              />
            </pattern>
            {/* Outer stripe pattern (forecast layer) */}
            <pattern
              id={`lag-stripe-outer-${id}`}
              patternUnits="userSpaceOnUse"
              width={LAG_FORECAST_STRIPE_WIDTH + LAG_FORECAST_STRIPE_GAP}
              height={LAG_FORECAST_STRIPE_WIDTH + LAG_FORECAST_STRIPE_GAP}
              patternTransform={`rotate(${LAG_FORECAST_STRIPE_ANGLE})${LAG_FORECAST_STRIPE_OFFSET ? ` translate(${LAG_FORECAST_STRIPE_OFFSET}, 0)` : ''}`}
            >
              <rect x="0" y="0" width={LAG_FORECAST_STRIPE_WIDTH} height={LAG_FORECAST_STRIPE_WIDTH + LAG_FORECAST_STRIPE_GAP} 
                fill={(effectiveSelected || data?.isHighlighted) ? getEdgeColour() : (data?.scenarioColour || getEdgeColour())} 
                fillOpacity={LAG_FORECAST_STRIPE_OPACITY} />
            </pattern>
          </>
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
          {data?.useSankeyView && ribbonPath && sankeyFERibbons ? (
            // Sankey mode: render as filled ribbon (SPECIALISATION of unified LAG semantics)
            <>
              {/* Outer ribbon - forecast stripes for F/F+E modes, solid for E mode */}
              <path
                id={`${id}-sankey-outer`}
                style={{
                  // Hidden-current should use the SAME mottled/stippled treatment as normal mode
                  // (i.e. not stripe-filled ribbons).
                  fill: isHiddenCurrent
                    ? `url(#lag-anchor-stipple-${id})`
                    : sankeyFERibbons.mode === 'e'
                      ? ((effectiveSelected || data?.isHighlighted)
                          ? getEdgeColour()
                          : (data?.scenarioColour || getEdgeColour()))
                      : `url(#lag-stripe-outer-${id})`,
                  // In E mode, apply NO_EVIDENCE_E_MODE_OPACITY for edges without evidence
                  // IMPORTANT: Hidden-current should NOT be more opaque in Sankey mode than normal mode.
                  // The scenario pipeline sets data.strokeOpacity (e.g. ~0.05) for hidden current.
                  // For hidden-current, opacity should be driven by the stipple pattern itself
                  // (mirrors non-Sankey branches that use `isHiddenCurrent ? 1 : ...`).
                  fillOpacity: isHiddenCurrent
                    ? 1
                    : (sankeyFERibbons.mode === 'e' && data?.edgeLatencyDisplay?.useNoEvidenceOpacity)
                      ? (data?.strokeOpacity ?? EDGE_OPACITY) * NO_EVIDENCE_E_MODE_OPACITY
                      : (data?.strokeOpacity ?? EDGE_OPACITY),
                  mixBlendMode: USE_GROUP_BASED_BLENDING ? 'normal' : EDGE_BLEND_MODE,
                  stroke: 'none',
                  transition: 'opacity 0.3s ease-in-out',
                  pointerEvents: data?.scenarioOverlay ? 'none' : 'auto',
                }}
                className="react-flow__edge-path"
                d={sankeyFERibbons.outerRibbon}
                onContextMenu={data?.scenarioOverlay ? undefined : handleContextMenu}
                onDoubleClick={data?.scenarioOverlay ? undefined : handleDoubleClick}
                onMouseEnter={data?.scenarioOverlay ? undefined : handleTooltipMouseEnter}
                onMouseMove={data?.scenarioOverlay ? undefined : handleTooltipMouseMove}
                onMouseLeave={data?.scenarioOverlay ? undefined : handleTooltipMouseLeave}
                onDragOver={data?.scenarioOverlay ? undefined : handleDragOver}
                onDrop={data?.scenarioOverlay ? undefined : handleDrop}
              />
              {/* Inner ribbon (evidence) - striped, only for F+E mode */}
              {sankeyFERibbons.innerRibbon && (
                <path
                  id={`${id}-sankey-inner`}
                  style={{
                    // Hidden-current should use stipple mottling, not stripes.
                    fill: isHiddenCurrent
                      ? `url(#lag-anchor-stipple-${id})`
                      : `url(#lag-stripe-inner-${id})`,
                    // For hidden-current, opacity is driven by the stipple pattern itself.
                    fillOpacity: isHiddenCurrent ? 1 : (data?.strokeOpacity ?? EDGE_OPACITY),
                    mixBlendMode: USE_GROUP_BASED_BLENDING ? 'normal' : EDGE_BLEND_MODE,
                    stroke: 'none',
                    transition: 'opacity 0.3s ease-in-out',
                    pointerEvents: 'none',
                  }}
                  className="react-flow__edge-path"
                  d={sankeyFERibbons.innerRibbon}
                />
              )}
              {/* Completeness marker - dashed vertical line at evidence boundary */}
              {sankeyFERibbons.mode !== 'f' && sankeyFERibbons.completenessLine && (
                <line
                  x1={sankeyFERibbons.completenessLine.x1}
                  y1={sankeyFERibbons.completenessLine.y1}
                  x2={sankeyFERibbons.completenessLine.x2}
                  y2={sankeyFERibbons.completenessLine.y2}
                  stroke="#333"
                  strokeWidth={SANKEY_COMPLETENESS_LINE_STROKE}
                  strokeDasharray="4,4"
                  strokeOpacity={0.8}
                  pointerEvents="none"
                />
              )}
              {/* Hidden path for beads - follows the top edge of the ribbon */}
              <path
                ref={pathRef}
                id={`${id}-top-edge`}
                d={ribbonPath.topEdge}
                style={{ display: 'none' }}
                pointerEvents="none"
              />

              {/* 
                Sankey parity: render the same LAG anchor stroke as normal mode so that:
                - Selected/highlighted edges get the same opacity boost behaviour
                - Hidden-current uses the same stipple "mottling" treatment
                This is visual-only here (pointerEvents disabled) to avoid changing interaction surfaces.
              */}
              <path
                id={`${id}-lag-anchor-sankey`}
                // Mask is only relevant for stripe-based anchors (fade is implemented via mask).
                mask={LAG_ANCHOR_USE_STRIPES && !isHiddenCurrent ? `url(#lag-anchor-fade-mask-${id})` : undefined}
                style={{
                  // Sankey: completeness/anchor overlay must be ribbon-shaped, not a stroked path.
                  // Reuse the normal-mode anchor paint sources (fade / stripes / stipple).
                  fill: isHiddenCurrent
                    ? `url(#lag-anchor-stipple-${id})`   // Stipple for hidden current
                    : LAG_ANCHOR_USE_STRIPES
                      ? `url(#lag-anchor-stripe-${id})`  // Stripes (mask handles fade)
                      : `url(#lag-anchor-fade-${id})`,   // Plain gradient fade
                  // Opacity semantics match normal mode's anchor strokeOpacity.
                  fillOpacity: effectiveSelected
                    ? LAG_ANCHOR_SELECTED_OPACITY
                    : data?.isHighlighted
                      ? LAG_ANCHOR_HIGHLIGHTED_OPACITY
                      : LAG_ANCHOR_OPACITY,
                  // Keep strokeOpacity in sync for any tooling/tests reading it (even though stroke is none).
                  strokeOpacity: effectiveSelected
                    ? LAG_ANCHOR_SELECTED_OPACITY
                    : data?.isHighlighted
                      ? LAG_ANCHOR_HIGHLIGHTED_OPACITY
                      : LAG_ANCHOR_OPACITY,
                  mixBlendMode: USE_GROUP_BASED_BLENDING ? 'normal' : EDGE_BLEND_MODE,
                  stroke: 'none',
                  transition: 'opacity 0.3s ease-in-out',
                  pointerEvents: 'none',
                }}
                className="react-flow__edge-path"
                d={sankeyFERibbons.outerRibbon}
              />
            </>
          ) : shouldShowConfidenceIntervals && confidenceData ? (
            // Confidence interval mode: render three overlapping paths
            <>
              {/* Outer band (upper bound) - widest, lightest colour */}
              <path
                key={`${id}-ci-upper`}
                id={`${id}-ci-upper`}
                style={{
                  stroke: isHiddenCurrent 
                    ? `url(#lag-anchor-stipple-${id})` 
                    : ((effectiveSelected || data?.isHighlighted) ? getEdgeColour() : (data?.scenarioColour || getEdgeColour())),
                  strokeWidth: confidenceData.widths.upper,
                  strokeOpacity: isHiddenCurrent ? 1 : (confidenceData.opacities.outer * ((data?.strokeOpacity ?? EDGE_OPACITY) / EDGE_OPACITY)),
                  mixBlendMode: USE_GROUP_BASED_BLENDING ? 'normal' : EDGE_BLEND_MODE,
                  fill: 'none',
                  strokeLinecap: 'round',
                  strokeLinejoin: 'miter',
                  strokeDasharray: (data?.edgeLatencyDisplay?.isDashed ?? (effectiveWeight === undefined || effectiveWeight === null || effectiveWeight === 0)) ? '5,5' : 'none',
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
                onDragOver={data?.scenarioOverlay ? undefined : handleDragOver}
                onDrop={data?.scenarioOverlay ? undefined : handleDrop}
              />
              {/* Middle band (mean) - normal width, base colour */}
              <path
                key={`${id}-ci-middle`}
                id={`${id}-ci-middle`}
                style={{
                  stroke: isHiddenCurrent 
                    ? `url(#lag-anchor-stipple-${id})` 
                    : ((effectiveSelected || data?.isHighlighted) ? getEdgeColour() : (data?.scenarioColour || getEdgeColour())),
                  strokeWidth: confidenceData.widths.middle,
                  strokeOpacity: isHiddenCurrent ? 1 : (confidenceData.opacities.middle * ((data?.strokeOpacity ?? EDGE_OPACITY) / EDGE_OPACITY)),
                  mixBlendMode: USE_GROUP_BASED_BLENDING ? 'normal' : EDGE_BLEND_MODE,
                  fill: 'none',
                  strokeLinecap: 'round',
                  strokeLinejoin: 'miter',
                  strokeDasharray: (data?.edgeLatencyDisplay?.isDashed ?? (effectiveWeight === undefined || effectiveWeight === null || effectiveWeight === 0)) ? '5,5' : 'none',
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
                onDragOver={data?.scenarioOverlay ? undefined : handleDragOver}
                onDrop={data?.scenarioOverlay ? undefined : handleDrop}
              />
              {/* Inner band (lower bound) - narrowest, darkest colour */}
              <path
                ref={pathRef}
                key={`${id}-ci-lower`}
                id={`${id}-ci-lower`}
                style={{
                  stroke: isHiddenCurrent 
                    ? `url(#lag-anchor-stipple-${id})` 
                    : ((effectiveSelected || data?.isHighlighted) ? getEdgeColour() : (data?.scenarioColour || getEdgeColour())),
                  strokeWidth: confidenceData.widths.lower,
                  strokeOpacity: isHiddenCurrent ? 1 : (confidenceData.opacities.inner * ((data?.strokeOpacity ?? EDGE_OPACITY) / EDGE_OPACITY)),
                  mixBlendMode: USE_GROUP_BASED_BLENDING ? 'normal' : EDGE_BLEND_MODE,
                  fill: 'none',
                  strokeLinecap: 'round',
                  strokeLinejoin: 'miter',
                  strokeDasharray: (data?.edgeLatencyDisplay?.isDashed ?? (effectiveWeight === undefined || effectiveWeight === null || effectiveWeight === 0)) ? '5,5' : 'none',
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
                onDragOver={data?.scenarioOverlay ? undefined : handleDragOver}
                onDrop={data?.scenarioOverlay ? undefined : handleDrop}
              />
            </>
          ) : shouldShowLagLayers && lagLayerData && !data?.useSankeyView ? (
            // LAG rendering modes (stroked paths - not used for Sankey which has ribbon-based F+E):
            // - F+E: Two striped bands with offset stripes that interleave (appears solid where overlap)
            // - F only: Single striped band for forecast
            // - E only: Solid edge with width scaled to p.evidence
            // ALL modes: p.mean visual anchor (carries pathRef, beads, interactions)
            <>
              {/* p.mean visual anchor - always at full p.mean width, fades based on completeness
                  This provides visual reference for total mass and is the interactive element
                  Can render as: spline chevrons, pattern stripes/chevrons, or gradient fade */}
              {LAG_ANCHOR_USE_SPLINE_CHEVRONS && completenessChevron && !isHiddenCurrent ? (
                // Single completeness chevron at the % complete position
                // PLUS: when evidence=0, also render a visible dashed line for the edge body
                <>
                  {/* When evidence=0, render a visible dashed edge body so the edge is not invisible.
                      Uses thin 1px hairline with standard dashed styling (same as pattern-based anchor). */}
                  <path
                    ref={pathRef}
                    key={`${id}-lag-anchor-interaction`}
                    style={{
                      // When evidence=0 in E mode, show thin dashed line; otherwise transparent for interaction only
                      stroke: (lagLayerData.mode === 'e' && lagLayerData.evidenceWidth === 0)
                        ? ((effectiveSelected || data?.isHighlighted) ? getEdgeColour() : (data?.scenarioColour || getEdgeColour()))
                        : 'transparent',
                      strokeWidth: (lagLayerData.mode === 'e' && lagLayerData.evidenceWidth === 0)
                        ? MIN_EDGE_WIDTH  // Thin hairline (matches pattern-based anchor for 0-evidence)
                        : strokeWidth,
                      strokeOpacity: (lagLayerData.mode === 'e' && lagLayerData.evidenceWidth === 0)
                        ? (data?.strokeOpacity ?? EDGE_OPACITY)  // Standard opacity
                        : 1,
                      strokeDasharray: (lagLayerData.mode === 'e' && lagLayerData.evidenceWidth === 0)
                        ? '5,5'
                        : 'none',
                      fill: 'none',
                      pointerEvents: data?.scenarioOverlay ? 'none' : 'auto',
                    }}
                    className="react-flow__edge-path"
                    d={edgePath}
                    onContextMenu={data?.scenarioOverlay ? undefined : handleContextMenu}
                    onDoubleClick={data?.scenarioOverlay ? undefined : handleDoubleClick}
                    onMouseEnter={data?.scenarioOverlay ? undefined : handleTooltipMouseEnter}
                    onMouseMove={data?.scenarioOverlay ? undefined : handleTooltipMouseMove}
                    onMouseLeave={data?.scenarioOverlay ? undefined : handleTooltipMouseLeave}
                    onDragOver={data?.scenarioOverlay ? undefined : handleDragOver}
                    onDrop={data?.scenarioOverlay ? undefined : handleDrop}
                  />
                  {/* Single completeness chevron - filled shape at % position */}
                  <path
                    key={`${id}-completeness-chevron`}
                    d={completenessChevron.path}
                    fill={(effectiveSelected || data?.isHighlighted) 
                      ? getEdgeColour() 
                      : (data?.scenarioColour || getEdgeColour())}
                    fillOpacity={effectiveSelected
                      ? COMPLETENESS_CHEVRON_SELECTED_OPACITY
                      : data?.isHighlighted
                        ? COMPLETENESS_CHEVRON_HIGHLIGHTED_OPACITY
                        : COMPLETENESS_CHEVRON_OPACITY}
                    stroke="none"
                    style={{ pointerEvents: 'none' }}
                  />
                </>
              ) : (
                // Pattern-based anchor (stripes, pattern chevrons, or gradient)
                <path
                  ref={pathRef}
                  key={`${id}-lag-anchor`}
                  id={`${id}-lag-anchor`}
                  mask={LAG_ANCHOR_USE_STRIPES && !isHiddenCurrent ? `url(#lag-anchor-fade-mask-${id})` : undefined}
                  style={{
                    stroke: isHiddenCurrent 
                      ? `url(#lag-anchor-stipple-${id})`   // Stipple for hidden current
                      : LAG_ANCHOR_USE_STRIPES
                        ? `url(#lag-anchor-stripe-${id})`  // Stripes (mask handles fade)
                        : `url(#lag-anchor-fade-${id})`,   // Plain gradient fade
                    // Anchor width:
                    // - In E-only mode, anchor should visually follow evidence width
                    //   (MIN_EDGE_WIDTH when there is no evidence yet).
                    // - In F / F+E modes, anchor stays at full p.mean width.
                    strokeWidth: lagLayerData.mode === 'e'
                      ? Math.max(MIN_EDGE_WIDTH, lagLayerData.evidenceWidth) // 0-evidence → thin hairline
                      : strokeWidth,
                    // Boost opacity when selected/highlighted for visibility
                    strokeOpacity: effectiveSelected
                      ? LAG_ANCHOR_SELECTED_OPACITY
                      : data?.isHighlighted
                        ? LAG_ANCHOR_HIGHLIGHTED_OPACITY
                        : LAG_ANCHOR_OPACITY,
                    mixBlendMode: USE_GROUP_BASED_BLENDING ? 'normal' : EDGE_BLEND_MODE,
                    fill: 'none',
                    strokeLinecap: 'round',
                    strokeLinejoin: 'miter',
                    strokeDasharray:
                      // Use pre-computed isDashed flag from EdgeLatencyDisplay
                      // Falls back to local computation for backward compatibility
                      (data?.edgeLatencyDisplay?.isDashed ??
                        (effectiveWeight === undefined || effectiveWeight === null || effectiveWeight === 0 ||
                          (lagLayerData.mode === 'e' && lagLayerData.evidenceWidth === 0)))
                        ? '5,5'
                        : 'none',
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
                onDragOver={data?.scenarioOverlay ? undefined : handleDragOver}
                onDrop={data?.scenarioOverlay ? undefined : handleDrop}
                />
              )}
              {lagLayerData.mode === 'e' ? (
                // E-only mode: solid edge with width based on p.evidence (Design doc §7.2)
                <path
                  key={`${id}-lag-evidence`}
                  id={`${id}-lag-evidence`}
                  style={{
                    stroke: isHiddenCurrent 
                      ? `url(#lag-anchor-stipple-${id})` 
                      : ((effectiveSelected || data?.isHighlighted) ? getEdgeColour() : (data?.scenarioColour || getEdgeColour())),
                    strokeWidth: lagLayerData.evidenceWidth,
                    strokeOpacity: isHiddenCurrent
                      ? 1
                      : // Use pre-computed useNoEvidenceOpacity flag from EdgeLatencyDisplay
                        // Falls back to local check for backward compatibility
                        ((data?.edgeLatencyDisplay?.useNoEvidenceOpacity ?? !fullEdge?.p?.evidence)
                          ? (data?.strokeOpacity ?? EDGE_OPACITY) * NO_EVIDENCE_E_MODE_OPACITY
                          : (data?.strokeOpacity ?? EDGE_OPACITY)),
                    mixBlendMode: USE_GROUP_BASED_BLENDING ? 'normal' : EDGE_BLEND_MODE,
                    fill: 'none',
                    strokeLinecap: 'round',
                    strokeLinejoin: 'miter',
                    strokeDasharray: (data?.edgeLatencyDisplay?.isDashed ?? (effectiveWeight === undefined || effectiveWeight === null || effectiveWeight === 0)) ? '5,5' : 'none',
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
                onDragOver={data?.scenarioOverlay ? undefined : handleDragOver}
                onDrop={data?.scenarioOverlay ? undefined : handleDrop}
                />
              ) : (
                // F and F+E modes: striped rendering
                <>
                  {/* Outer layer (forecast) - striped with offset, full width */}
                  <path
                    key={`${id}-lag-outer`}
                    id={`${id}-lag-outer`}
                    style={{
                      stroke: `url(#lag-stripe-outer-${id})`,
                      strokeWidth: lagLayerData.meanWidth,
                      strokeOpacity: data?.strokeOpacity ?? EDGE_OPACITY,
                      mixBlendMode: USE_GROUP_BASED_BLENDING ? 'normal' : EDGE_BLEND_MODE,
                      fill: 'none',
                      strokeLinecap: 'round',
                      strokeLinejoin: 'miter',
                      strokeDasharray: (data?.edgeLatencyDisplay?.isDashed ?? (effectiveWeight === undefined || effectiveWeight === null || effectiveWeight === 0)) ? '5,5' : 'none',
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
                onDragOver={data?.scenarioOverlay ? undefined : handleDragOver}
                onDrop={data?.scenarioOverlay ? undefined : handleDrop}
                  />
                  {/* Inner layer (evidence) - striped NO offset, narrower width - only for F+E mode */}
                  {lagLayerData.mode === 'f+e' && (
                    <path
                      key={`${id}-lag-inner`}
                      id={`${id}-lag-inner`}
                      style={{
                        stroke: `url(#lag-stripe-inner-${id})`,
                        strokeWidth: lagLayerData.evidenceWidth,
                        strokeOpacity: data?.strokeOpacity ?? EDGE_OPACITY,
                        mixBlendMode: USE_GROUP_BASED_BLENDING ? 'normal' : EDGE_BLEND_MODE,
                        fill: 'none',
                        strokeLinecap: 'round',
                        strokeLinejoin: 'miter',
                        strokeDasharray: (data?.edgeLatencyDisplay?.isDashed ?? (effectiveWeight === undefined || effectiveWeight === null || effectiveWeight === 0)) ? '5,5' : 'none',
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
                onDragOver={data?.scenarioOverlay ? undefined : handleDragOver}
                onDrop={data?.scenarioOverlay ? undefined : handleDrop}
                    />
                  )}
                </>
              )}
            </>
          ) : null}
          
          {/* Animated chevrons flowing along the edge - only on current layer, not Sankey or overlays */}
          {(viewPrefs?.animateFlow ?? true) && edgePath && pathRef.current && !data?.useSankeyView && !ribbonPath && !data?.scenarioOverlay && (() => {
            // Calculate path length to determine number of chevrons
            const pathLength = pathRef.current.getTotalLength?.() || 100;
            const numChevrons = Math.max(1, Math.floor(pathLength / CHEVRON_SPACING));
            
            // Lag-adjusted speed: slower chevrons for edges with higher lag.
            // Use median_lag_days from display data, fall back to t95 from config.
            const lagDays = data?.edgeLatencyDisplay?.median_days ?? fullEdge?.p?.latency?.t95;
            const effectiveSpeed = CHEVRON_SPEED * computeChevronSpeedFactor(lagDays);
            
            const animationDuration = pathLength / effectiveSpeed;
            const staggerDelay = animationDuration / numChevrons;
            
            // Create chevron shape - use middle CI width if in CI mode, otherwise normal strokeWidth
            const chevronWidth = (shouldShowConfidenceIntervals && confidenceData) 
              ? confidenceData.widths.middle 
              : strokeWidth;
            const halfWidth = chevronWidth / 2;
            const length = chevronWidth * CHEVRON_LENGTH_RATIO;
            const indent = halfWidth * CHEVRON_ANGLE_RATIO;
            const point = halfWidth * CHEVRON_ANGLE_RATIO;
            const chevronShapePath = `M ${-length/2},${-halfWidth} L ${-length/2 + indent},0 L ${-length/2},${halfWidth} L ${length/2},${halfWidth} L ${length/2 + point},0 L ${length/2},${-halfWidth} Z`;
            
            // Build keyTimes for fade-in animation
            const fadeInEnd = CHEVRON_FADE_IN_FRACTION;
            const opacityValues = `0;${CHEVRON_OPACITY};${CHEVRON_OPACITY};${CHEVRON_OPACITY}`;
            const keyTimesValues = `0;${fadeInEnd};0.95;1`;
            
            return (
              <g style={{ pointerEvents: 'none' }}>
                <defs>
                  <path id={`chevron-shape-${id}`} d={chevronShapePath} />
                  {CHEVRON_BLUR > 0 && (
                    <filter id={`chevron-blur-${id}`}>
                      <feGaussianBlur stdDeviation={CHEVRON_BLUR} />
                    </filter>
                  )}
                </defs>
                {Array.from({ length: numChevrons }, (_, i) => {
                  // Use negative begin time so chevrons start already distributed along path
                  const startOffset = -i * staggerDelay;
                  // Boost opacity in CI mode since middle layer has ~0.55 opacity
                  const effectiveOpacity = (shouldShowConfidenceIntervals && confidenceData) 
                    ? Math.min(1, CHEVRON_OPACITY * 2.5) // Boost to compensate for CI layer transparency
                    : CHEVRON_OPACITY;
                  return (
                    <use
                      key={i}
                      href={`#chevron-shape-${id}`}
                      fill="white"
                      fillOpacity={effectiveOpacity}
                      style={{ mixBlendMode: 'overlay' }}
                      filter={CHEVRON_BLUR > 0 ? `url(#chevron-blur-${id})` : undefined}
                    >
                      {/* Motion along the path - negative begin = already in progress */}
                      <animateMotion
                        dur={`${animationDuration}s`}
                        repeatCount="indefinite"
                        rotate="auto"
                        begin={`${startOffset}s`}
                        calcMode="linear"
                        path={edgePath}
                      />
                    </use>
                  );
                })}
              </g>
            );
          })()}
          
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
            const nodes = getNodes();
            
            // Default for flat faces (edge perpendicular to face)
            // For perpendicular edges: path distance ≈ perpendicular distance
            let visibleStartOffset = totalInset;
            let visibleEndOffset = totalInset;
            
            // --- Source side (left-aligned beads) ---
            if (!data?.useSankeyView && data?.sourceFace) {
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
              let basePerpDistance = totalInset;
              if (sourceFaceDirection === 'convex') {
                const bulgeAtOffset = (CONVEX_DEPTH / 2) * (1 - normalizedOffset * normalizedOffset);
                basePerpDistance = totalInset + bulgeAtOffset;
              } else if (sourceFaceDirection === 'concave') {
                const indentAtOffset = (CONCAVE_DEPTH / 2) * (1 - normalizedOffset * normalizedOffset);
                basePerpDistance = totalInset - indentAtOffset;
              }
              
              visibleStartOffset = basePerpDistance;
            }
            
            // --- Target side (right-aligned beads) ---
            if (!data?.useSankeyView && data?.targetFace) {
              const targetNode = nodes.find(n => n.id === target);
              const targetFaceDirection = targetNode?.data?.faceDirections?.[data.targetFace] ?? 'flat';
              
              // Get edge offset from center (perpendicular to face)
              const targetOffsetX = data?.targetOffsetX || 0;
              const targetOffsetY = data?.targetOffsetY || 0;
              
              // Determine perpendicular offset based on face orientation
              let perpendicularOffset = 0;
              if (data.targetFace === 'left' || data.targetFace === 'right') {
                perpendicularOffset = targetOffsetY;
              } else {
                perpendicularOffset = targetOffsetX;
              }
              
              // Get node dimensions to normalize offset
              const nominalWidth = (targetNode?.data as any)?.sankeyWidth || DEFAULT_NODE_WIDTH;
              const nominalHeight = (targetNode?.data as any)?.sankeyHeight || DEFAULT_NODE_HEIGHT;
              const faceLength = (data.targetFace === 'left' || data.targetFace === 'right') ? nominalHeight : nominalWidth;
              
              // Normalize offset to [-1, 1] range
              const normalizedOffset = perpendicularOffset / (faceLength / 2);
              
              // Compute base perpendicular distance based on face direction
              let basePerpDistance = totalInset;
              if (targetFaceDirection === 'convex') {
                const bulgeAtOffset = (CONVEX_DEPTH / 2) * (1 - normalizedOffset * normalizedOffset);
                basePerpDistance = totalInset + bulgeAtOffset;
              } else if (targetFaceDirection === 'concave') {
                const indentAtOffset = (CONCAVE_DEPTH / 2) * (1 - normalizedOffset * normalizedOffset);
                basePerpDistance = totalInset - indentAtOffset;
              }
              
              visibleEndOffset = basePerpDistance;
            }
            
            // Use offsets in key to force re-render when edge positions change
            const offsetKey = `${data?.sourceOffsetX?.toFixed(1) || 0}-${data?.sourceOffsetY?.toFixed(1) || 0}-${data?.scaledWidth?.toFixed(1) || 0}`;
            return (
              <EdgeBeadsRenderer
                key={`beads-${id}-${fullEdge.uuid || fullEdge.id}-${offsetKey}`}
                edgeId={id}
                edge={fullEdge}
                path={pathRef.current}
                pathD={data?.useSankeyView && ribbonPath?.topEdge ? ribbonPath.topEdge : edgePath}
                graph={graph}
                scenarioOrder={scenarioOrder}
                visibleScenarioIds={visibleScenarioIds}
                visibleColourOrderIds={visibleColourOrderIds}
                scenarioColours={scenarioColours}
                scenariosContext={scenariosContext}
                whatIfDSL={whatIfDSL}
                getScenarioVisibilityMode={activeTabId ? (scenarioId: string) => tabOps.getScenarioVisibilityMode(activeTabId, scenarioId) : undefined}
                visibilityModesKey={visibilityModesKey}
                visibleStartOffset={visibleStartOffset}
                visibleEndOffset={visibleEndOffset}
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
            whiteSpace: 'pre',
            maxWidth: '600px',
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
