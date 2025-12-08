/**
 * Edge Bead Data Extraction Helpers
 * 
 * This module extracts data for bead rendering from edges and scenarios.
 * Repurposes logic from edgeLabelHelpers.tsx but builds bead definitions instead of label segments.
 */

import React from 'react';
import { computeEffectiveEdgeProbability, parseWhatIfDSL } from '@/lib/whatIf';
import { getComposedParamsForLayer } from '../../services/CompositionService';
import { BEAD_MARKER_DISTANCE, BEAD_SPACING } from '../../lib/nodeEdgeConstants';
import { getCaseEdgeVariantInfo } from './edgeLabelHelpers';
import { getConditionalProbabilityColour, ensureDarkBeadColour } from '@/lib/conditionalColours';
import { darkenCaseColour } from '@/lib/conditionalColours';
import type { ScenarioParams } from '../../types/scenarios';
import type { Graph, GraphEdge } from '../../types';
import { BeadLabelBuilder, type BeadValue, type HiddenCurrentValue } from './BeadLabelBuilder';

// Re-export for backwards compatibility
export type { BeadValue, HiddenCurrentValue };

export interface BeadDefinition {
  type: 'probability' | 'cost_gbp' | 'labour_cost' | 'variant' | 'conditional_p' | 'latency';
  
  // Multi-scenario values
  values: BeadValue[];
  
  // Hidden current value (if 'current' not visible but differs)
  hiddenCurrent?: {
    value: number | string;
  };
  
  // Display
  displayText: React.ReactNode; // Coloured segments + optional grey brackets
  allIdentical: boolean; // true if all visible scenarios have same value
  
  // Bead appearance
  backgroundColor: string; // Dark grey for normal params, colored for variant/conditional
  hasParameterConnection: boolean; // Show 🔌 icon when expanded
  isOverridden: boolean; // Show ⚡ icon when query is overridden
  
  // Position
  distance: number; // along spline from visible start (or from end if rightAligned)
  expanded: boolean; // default expansion state
  index: number; // for ordering along spline
  rightAligned?: boolean; // if true, distance is from path END (for latency beads)
}

// ============================================================================
// Helper: Format Value
// ============================================================================
// NOTE: These are now provided by BeadLabelBuilder for consistency
// Keeping local aliases for backwards compatibility in this file

const formatProbability = BeadLabelBuilder.formatProbability;
const formatCostGBP = BeadLabelBuilder.formatCostGBP;
const formatCostTime = BeadLabelBuilder.formatCostTime;

function formatVariant(variantName: string, weight: number): string {
  // weight is already 0-1, convert to percentage
  // Just return the percentage, variant name is handled separately
  return `${Math.round(weight * 100)}%`;
}

function formatConditional(condition: string, prob: number): string {
  // Simplify condition string for display
  let displayCondition = condition;
  if (condition.startsWith('context(') && condition.endsWith(')')) {
    const inner = condition.slice(8, -1);
    const parts = inner.split(':');
    if (parts.length === 2) {
      displayCondition = parts[1]; // e.g., "context(device:mobile)" -> "mobile"
    }
  } else if (condition.includes('.exclude(')) {
    const [a, b] = condition.split('.exclude(');
    displayCondition = `${a} not ${b.replace(')', '')}`;
  }
  
  // prob is already 0-1, convert to percentage
  return `${displayCondition}: ${Math.round(prob * 100)}%`;
}

// ============================================================================
// Generic Parameter Bead Builder
// ============================================================================

/**
 * Generic function to build a parameter bead.
 * Handles the common pattern of:
 * 1. Checking if parameter exists in ANY layer
 * 2. Extracting values from all visible layers (using proper compositing)
 * 3. Building label using BeadLabelBuilder
 * 4. Constructing BeadDefinition
 * 
 * This eliminates duplicate logic across probability, cost_gbp, labour_cost, etc.
 */
function buildParameterBead(config: {
  beadType: 'probability' | 'cost_gbp' | 'labour_cost' | 'latency';
  
  // Check if parameter exists anywhere (current, base, or any visible scenario)
  checkExists: () => boolean;
  
  // Extract value from specific layer (returns {mean/value, stdev} or undefined)
  extractFromLayer: (layerId: string) => { mean?: number; value?: number; stdev?: number } | undefined;
  
  // Build label using BeadLabelBuilder
  // The third boolean parameter indicates whether there is existence variation
  // (i.e. param present in some layers but missing in others).
  buildLabel: (
    values: BeadValue[], 
    hiddenCurrent: HiddenCurrentValue | undefined, 
    hasExistenceVariation: boolean
  ) => { displayText: React.ReactNode; allIdentical: boolean };
  
  // Bead styling and metadata
  backgroundColor: string;
  hasParameterConnection: boolean;
  isOverridden: boolean;
  
  // Position info
  baseDistance: number;
  beadIndex: number;
  
  // Layer info
  orderedVisibleIds: string[];
  currentVisible: boolean;
  getScenarioColour: (layerId: string) => string;
  
  // Position modifiers
  rightAligned?: boolean; // If true, position from path end
}): BeadDefinition | null {
  
  // Check if parameter exists anywhere
  if (!config.checkExists()) {
    return null;
  }
  
  const values: BeadValue[] = [];
  let hiddenCurrent: HiddenCurrentValue | undefined;
  
  // First pass: inspect raw extracted values per visible layer
  const rawLayerValues = new Map<string, { value?: number; stdev?: number } | null>();
  for (const layerId of config.orderedVisibleIds) {
    const extracted = config.extractFromLayer(layerId);
    const extractedValue = extracted?.mean ?? extracted?.value;
    rawLayerValues.set(
      layerId, 
      extracted ? { value: extractedValue, stdev: extracted?.stdev } : null
    );
  }
  
  // Do any visible layers have an explicit value?
  const hasAnyExplicitValue = Array.from(rawLayerValues.values()).some(
    v => v !== null && v.value !== undefined
  );
  
  // For non-probability numeric params (costs, etc.), when at least one layer
  // has an explicit value, we treat "missing" on other layers as 0 for
  // display/delta purposes. This lets us render e.g. "£0 £1.60".
  const shouldTreatMissingAsZero =
    hasAnyExplicitValue && config.beadType !== 'probability';
  
  // Second pass: construct final layerValues with optional zero-filling
  const layerValues = new Map<string, { value: number; stdev?: number } | null>();
  for (const [layerId, raw] of rawLayerValues.entries()) {
    if (raw && raw.value !== undefined) {
      layerValues.set(layerId, { value: raw.value, stdev: raw.stdev });
    } else if (shouldTreatMissingAsZero) {
      layerValues.set(layerId, { value: 0, stdev: undefined });
    } else {
      layerValues.set(layerId, null);
    }
  }
  
  // Check if there's variation in existence (some layers have a real value, others only zero/missing)
  const hasValue = Array.from(layerValues.values()).some(v => v !== null);
  const hasNoValue = Array.from(layerValues.values()).some(v => v === null);
  const hasExistenceVariation = hasValue && hasNoValue;
  
  // Collect values from layers that have them
  for (const [layerId, extracted] of layerValues.entries()) {
    if (extracted !== null) {
      values.push({
        scenarioId: layerId,
        value: extracted.value,
        colour: config.getScenarioColour(layerId),
        stdev: extracted.stdev
      });
    }
  }
  
  // Check hidden current
  if (!config.currentVisible) {
    const extracted = config.extractFromLayer('current');
    const extractedValue = extracted?.mean ?? extracted?.value;
    
    if (extractedValue !== undefined) {
      // Check if hidden current differs from visible values
      if (values.length > 0) {
        const tempBuilder = new BeadLabelBuilder(
          values,
          { value: extractedValue, stdev: extracted?.stdev },
          (v: number | string, stdev?: number) => String(v)
        );
        if (!tempBuilder.doesHiddenCurrentMatch()) {
          hiddenCurrent = { value: extractedValue, stdev: extracted?.stdev };
        }
      } else {
        // No visible values but hidden current exists - definitely different
        hiddenCurrent = { value: extractedValue, stdev: extracted?.stdev };
      }
    } else if (values.length > 0) {
      // Hidden current doesn't exist but visible layers do - that's also a difference
      // We can't represent "no value" in hiddenCurrent, but the existence variation will trigger display
    }
  }
  
  // If no values collected and no hiddenCurrent, don't create bead
  if (values.length === 0 && !hiddenCurrent) {
    return null;
  }
  
  // If there's existence variation (some layers have value, others don't), 
  // we should show the bead even if only one visible layer has a value
  // This is valid variation - absence vs presence is meaningful
  
  // Build label using BeadLabelBuilder
  const label = config.buildLabel(values, hiddenCurrent, hasExistenceVariation);
  
  // For right-aligned beads: distance is offset FROM END (fixed at BEAD_MARKER_DISTANCE)
  // For left-aligned beads: distance is offset FROM START (accumulated)
  const beadDistance = config.rightAligned
    ? BEAD_MARKER_DISTANCE
    : config.baseDistance + config.beadIndex * BEAD_SPACING;
  
  return {
    type: config.beadType,
    values,
    hiddenCurrent,
    displayText: label.displayText,
    allIdentical: label.allIdentical,
    backgroundColor: config.backgroundColor,
    hasParameterConnection: config.hasParameterConnection,
    isOverridden: config.isOverridden,
    distance: beadDistance,
    expanded: true,
    index: config.beadIndex,
    rightAligned: config.rightAligned
  };
}

/**
 * DEPRECATED: Use BeadLabelBuilder.buildCustomLabel() instead
 * This function is kept for backwards compatibility but delegates to BeadLabelBuilder
 * 
 * @deprecated Use BeadLabelBuilder.buildCustomLabel() for consistent behavior
 */
function formatBeadText(
  values: BeadValue[],
  hiddenCurrent?: HiddenCurrentValue,
  formatter: (v: number | string, stdev?: number) => string = (v) => String(v)
): React.ReactNode {
  return BeadLabelBuilder.buildCustomLabel(values, hiddenCurrent, formatter).displayText;
}

// ============================================================================
// Helper: Extract Edge Values for All Scenarios
// ============================================================================

function getEdgeProbabilityForLayer(
  layerId: string,
  edge: GraphEdge,
  graph: Graph,
  scenariosContext: any,
  whatIfDSL?: string | null
): { probability: number; stdev?: number } {
  // IMPORTANT: Prefer edge.id for scenario param lookups (human-readable IDs)
  // UUIDs are only used as fallback for edges without IDs
  const edgeKey = edge.id || edge.uuid;
  if (!edgeKey) return { probability: 0 };
  
  if (layerId === 'current') {
    const prob = edge?.p?.mean ?? 0;
    const stdev = edge?.p?.stdev;
    return { probability: prob, stdev };
  } else if (layerId === 'base') {
    const prob = scenariosContext.baseParams.edges?.[edgeKey]?.p?.mean ?? 0;
    const stdev = scenariosContext.baseParams.edges?.[edgeKey]?.p?.stdev;
    return { probability: prob, stdev };
  } else {
    // Scenario layer - use centralized composition
    const composedParams = getComposedParamsForLayer(
      layerId,
      scenariosContext.baseParams,
      scenariosContext.currentParams,
      scenariosContext.scenarios
    );
    
    // Get probability with fallback chain
    let prob = composedParams.edges?.[edgeKey]?.p?.mean;
    if (prob === undefined || prob === null) {
      prob = scenariosContext.baseParams.edges?.[edgeKey]?.p?.mean;
    }
    if (prob === undefined || prob === null) {
      prob = edge?.p?.mean ?? 0;
    }
    const stdev = composedParams.edges?.[edgeKey]?.p?.stdev 
      ?? scenariosContext.baseParams.edges?.[edgeKey]?.p?.stdev
      ?? edge?.p?.stdev;
    
    return { probability: prob, stdev };
  }
}

function getEdgeCostGBPForLayer(
  layerId: string,
  edge: GraphEdge,
  graph: Graph,
  scenariosContext: any
): { mean?: number; stdev?: number } | undefined {
  // IMPORTANT: Prefer edge.id for scenario param lookups (human-readable IDs)
  const edgeKey = edge.id || edge.uuid;
  if (!edgeKey) return undefined;
  
  if (layerId === 'current') {
    return edge?.cost_gbp;
  } else if (layerId === 'base') {
    return scenariosContext.baseParams.edges?.[edgeKey]?.cost_gbp;
  } else {
    // Scenario layer - use centralized composition
    const composedParams = getComposedParamsForLayer(
      layerId,
      scenariosContext.baseParams,
      scenariosContext.currentParams,
      scenariosContext.scenarios
    );
    return composedParams.edges?.[edgeKey]?.cost_gbp;
  }
}

function getEdgeCostTimeForLayer(
  layerId: string,
  edge: GraphEdge,
  graph: Graph,
  scenariosContext: any
): { mean?: number; stdev?: number } | undefined {
  // IMPORTANT: Prefer edge.id for scenario param lookups (human-readable IDs)
  const edgeKey = edge.id || edge.uuid;
  if (!edgeKey) return undefined;
  
  if (layerId === 'current') {
    return edge?.labour_cost;
  } else if (layerId === 'base') {
    return scenariosContext.baseParams.edges?.[edgeKey]?.labour_cost;
  } else {
    // Scenario layer - use centralized composition
    const composedParams = getComposedParamsForLayer(
      layerId,
      scenariosContext.baseParams,
      scenariosContext.currentParams,
      scenariosContext.scenarios
    );
    return composedParams.edges?.[edgeKey]?.labour_cost;
  }
}

/**
 * Extract latency bead data (median_lag_days, completeness) for a layer.
 *
 * Design requirement: when a layer has *no* latency configured, it should
 * resolve to a synthetic value of **0d and 100% complete** so that:
 *   - scenario layers with real latency can be meaningfully compared
 *   - hidden current can show "(0d (100%))" in brackets when current is invisible.
 *
 * To keep the pattern consistent with other beads, we still gate creation of
 * the latency bead via checkExists (see below); this helper is ONLY about the
 * values used for display/difference once the bead exists.
 *
 * Returns { mean: median_lag_days, stdev: completeness } for formatter compatibility.
 * DSL: e.X.p.latency.median_lag_days, e.X.p.latency.completeness
 */
function getEdgeLatencyForLayer(
  layerId: string,
  edge: GraphEdge,
  graph: Graph,
  scenariosContext: any
): { mean?: number; stdev?: number } | undefined {
  // IMPORTANT: Prefer edge.id for scenario param lookups (human-readable IDs)
  const edgeKey = edge.id || edge.uuid;
  if (!edgeKey) return undefined;
  
  if (layerId === 'current') {
    const latency = edge?.p?.latency;
    if (!latency) {
      // Synthetic "no latency": 0d, 100% complete
      return { mean: 0, stdev: 1 };
    }
    return {
      mean: latency.median_lag_days ?? 0,
      stdev: latency.completeness ?? 1
    };
  } else if (layerId === 'base') {
    const latency = scenariosContext.baseParams.edges?.[edgeKey]?.p?.latency;
    if (!latency) {
      // Synthetic "no latency": 0d, 100% complete
      return { mean: 0, stdev: 1 };
    }
    return {
      mean: latency.median_lag_days ?? 0,
      stdev: latency.completeness ?? 1
    };
  } else {
    // Scenario layer - use centralized composition
    const composedParams = getComposedParamsForLayer(
      layerId,
      scenariosContext.baseParams,
      scenariosContext.currentParams,
      scenariosContext.scenarios
    );
    const latency = composedParams.edges?.[edgeKey]?.p?.latency;
    if (!latency) {
      // Synthetic "no latency": 0d, 100% complete
      return { mean: 0, stdev: 1 };
    }
    return {
      mean: latency.median_lag_days ?? 0,
      stdev: latency.completeness ?? 1
    };
  }
}

function getCaseVariantForLayer(
  layerId: string,
  edge: GraphEdge,
  graph: Graph,
  scenariosContext: any,
  whatIfDSL?: string | null
): { variantName: string; variantWeight: number } | null {
  // IMPORTANT: Prefer edge.id for scenario param lookups (human-readable IDs)
  const edgeKey = edge.id || edge.uuid;
  if (!edgeKey) return null;
  
  if (layerId === 'current') {
    const caseInfo = getCaseEdgeVariantInfo(edge, graph);
    if (!caseInfo) return null;
    
    let variantWeight = caseInfo.variantWeight;
    
    // Check for what-if DSL override
    if (whatIfDSL) {
      const parsed = parseWhatIfDSL(whatIfDSL, graph);
      
      // Find the case node
      let caseId = edge.case_id;
      if (!caseId) {
        const sourceNode = graph.nodes?.find((n: any) => n.uuid === edge.from || n.id === edge.from);
        if (sourceNode?.type === 'case') {
          caseId = sourceNode.case?.id || sourceNode.uuid || sourceNode.id;
        }
      }
      
      if (caseId) {
        const caseNode = graph.nodes?.find((n: any) => 
          n.type === 'case' && (
            n.case?.id === caseId || 
            n.uuid === caseId || 
            n.id === caseId
          )
        );
        
        if (caseNode) {
          // Check for case override (try multiple key formats)
          const caseNodeCaseId = caseNode.case?.id;
          const override = parsed.caseOverrides?.[caseNode.id] || 
                          (caseNodeCaseId ? parsed.caseOverrides?.[caseNodeCaseId] : undefined) ||
                          parsed.caseOverrides?.[caseId];
          
          if (override !== undefined) {
            // What-if: set weight to 1.0 if this variant matches, 0.0 otherwise
            variantWeight = edge.case_variant === override ? 1.0 : 0.0;
          }
        }
      }
    }
    
    return { variantName: caseInfo.variantName, variantWeight };
  } else if (layerId === 'base') {
    const caseInfo = getCaseEdgeVariantInfo(edge, graph, scenariosContext.baseParams);
    if (!caseInfo) return null;
    return { variantName: caseInfo.variantName, variantWeight: caseInfo.variantWeight };
  } else {
    // Scenario layer - use centralized composition
    const composedParams = getComposedParamsForLayer(
      layerId,
      scenariosContext.baseParams,
      scenariosContext.currentParams,
      scenariosContext.scenarios
    );
    const caseInfo = getCaseEdgeVariantInfo(edge, graph, composedParams);
    if (!caseInfo) return null;
    return { variantName: caseInfo.variantName, variantWeight: caseInfo.variantWeight };
  }
}

// ============================================================================
// Main: Build Bead Definitions
// ============================================================================

export function buildBeadDefinitions(
  edge: GraphEdge,
  graph: Graph,
  scenariosContext: any,
  scenarioOrder: string[],
  visibleScenarioIds: string[],
  visibleColourOrderIds: string[],
  scenarioColours: Map<string, string>,
  whatIfDSL?: string | null,
  visibleStartOffset?: number // Distance from path start to visible start (after chevron)
): BeadDefinition[] {
  if (!scenariosContext || !graph) {
    console.warn('[buildBeadDefinitions] Missing scenariosContext or graph');
    return [];
  }
  
  const beads: BeadDefinition[] = [];
  let beadIndex = 0;
  
  // Use shared constants from nodeEdgeConstants.ts
  const baseDistance = (visibleStartOffset || 0) + BEAD_MARKER_DISTANCE;
  
  // Helper to get scenario colour
  const getScenarioColour = (scenarioId: string): string => {
    return scenarioColours.get(scenarioId) || '#000000';
  };
  
  // Check if 'current' is visible
  const currentVisible = visibleScenarioIds.includes('current');
  const baseVisible = visibleScenarioIds.includes('base');
  
  // Order visible scenarios to match legend chips (left-to-right):
  // Left: Original (base) -> Middle: User Scenarios (REVERSED) -> Right: Current (top)
  // This mirrors the legend chip display where left = bottom of stack, right = top
  const orderedVisibleIds: string[] = [];
  
  // 1. Add base (leftmost - bottom of stack)
  if (baseVisible) {
    orderedVisibleIds.push('base');
  }
  
  // 2. Add user scenarios in REVERSE order (so bottom-to-top becomes left-to-right)
  const userScenarios = scenarioOrder.length > 0
    ? scenarioOrder.filter(id => id !== 'current' && id !== 'base' && visibleScenarioIds.includes(id))
    : visibleScenarioIds.filter(id => id !== 'current' && id !== 'base');
  orderedVisibleIds.push(...userScenarios.reverse());
  
  // 3. Add current (rightmost - top of stack)
  if (currentVisible) {
    orderedVisibleIds.push('current');
  }
  
  // ============================================================================
  // 1. Case Variant Bead (if present) - SHOWN FIRST
  // ============================================================================
  const sourceNode = graph.nodes.find(n => (n.uuid || n.id) === edge.from);
  if (sourceNode?.type === 'case' && edge.case_variant) {
    const variantValues: BeadValue[] = [];
    let hiddenCurrentVariant: { value: string } | undefined;
    
    // Use orderedVisibleIds which respects scenarioOrder (panel display order)
    for (const scenarioId of orderedVisibleIds) {
      const variant = getCaseVariantForLayer(scenarioId, edge, graph, scenariosContext, whatIfDSL);
      if (variant) {
        variantValues.push({
          scenarioId,
          value: variant.variantWeight,
          colour: getScenarioColour(scenarioId)
        });
      }
    }
    
    if (!currentVisible && variantValues.length > 0) {
      const variant = getCaseVariantForLayer('current', edge, graph, scenariosContext, whatIfDSL);
      if (variant) {
        const visibleAllSame = variantValues.every(v => v.value === variantValues[0].value);
        if (!visibleAllSame || variantValues[0].value !== variant.variantWeight) {
          hiddenCurrentVariant = { value: String(variant.variantWeight) };
        }
      }
    }
    
    const variantName = variantValues.length > 0 
      ? getCaseVariantForLayer(visibleScenarioIds[0], edge, graph, scenariosContext, whatIfDSL)?.variantName || 'variant'
      : getCaseVariantForLayer('current', edge, graph, scenariosContext, whatIfDSL)?.variantName || 'variant';
    
    const allVariantIdentical = variantValues.length > 0 && variantValues.every(v => v.value === variantValues[0].value);
    
    // Use darkened case node colour for background
    const caseColour = sourceNode.layout?.colour || '#8B5CF6';
    const darkenedColour = darkenCaseColour(caseColour);
    
    // Format variant text: "variantName: 50% 25% 50%" with coloured percentages
    const variantSegments: React.ReactNode[] = [];
    variantSegments.push(<span key="name" style={{ color: '#FFFFFF' }}>{variantName}: </span>);
    
    // Deduplicate: if all values are identical and no hiddenCurrent, show once in white
    if (allVariantIdentical && !hiddenCurrentVariant) {
      variantSegments.push(
        <span key="single" style={{ color: '#FFFFFF' }}>
          {formatVariant(variantName, variantValues[0].value as number)}
        </span>
      );
    } else {
      // Add coloured percentages for each scenario (when they differ)
      variantValues.forEach((val, idx) => {
        variantSegments.push(
          <span key={idx} style={{ color: val.colour }}>
            {formatVariant(variantName, val.value as number)}
          </span>
        );
        if (idx < variantValues.length - 1) {
          variantSegments.push(' ');
        }
      });
      
      // Add hidden current if present and differs
      if (hiddenCurrentVariant) {
        const visibleAllSame = variantValues.length > 0 && variantValues.every(v => v.value === variantValues[0].value);
        if (!visibleAllSame || variantValues[0]?.value !== hiddenCurrentVariant.value) {
          variantSegments.push(' (');
          variantSegments.push(
            <span key="hidden" style={{ color: '#808080' }}>
              {formatVariant(variantName, Number(hiddenCurrentVariant.value))}
            </span>
          );
          variantSegments.push(')');
        }
      }
    }
    
    beads.push({
      type: 'variant',
      values: variantValues,
      hiddenCurrent: hiddenCurrentVariant,
      displayText: <>{variantSegments}</>,
      allIdentical: allVariantIdentical && !hiddenCurrentVariant,
      backgroundColor: darkenedColour,
      hasParameterConnection: false,
      isOverridden: false, // Variants don't have query overrides
      distance: baseDistance + beadIndex * BEAD_SPACING,
      expanded: true, // Default expanded
      index: beadIndex++
    });
  }
  
  // ============================================================================
  // 2. Probability Bead
  // ============================================================================
  // Check if edge has query-level overrides (query_overridden, n_query specified, or n_query_overridden)
  const hasQueryOverride = !!(edge as any).query_overridden || !!(edge as any).n_query || !!(edge as any).n_query_overridden;
  
  const probBead = buildParameterBead({
    beadType: 'probability',
    checkExists: () => true, // Every edge has probability
    extractFromLayer: (layerId) => {
      const { probability, stdev } = getEdgeProbabilityForLayer(layerId, edge, graph, scenariosContext, whatIfDSL);
      return { value: probability, stdev };
    },
    buildLabel: BeadLabelBuilder.buildProbabilityLabel,
    backgroundColor: '#000000',
    hasParameterConnection: !!(edge as any).p?.id,
    isOverridden: !!(edge as any).p?.mean_overridden || hasQueryOverride,
    baseDistance,
    beadIndex: beadIndex,
    orderedVisibleIds,
    currentVisible,
    getScenarioColour
  });
  
  if (probBead) {
    beads.push(probBead);
    beadIndex++;
  }
  
  // ============================================================================
  // 2b. Latency Bead (if present in ANY layer) - right-aligned
  // ============================================================================
  const edgeKeyForLatency = edge.id || edge.uuid;
  const latencyBead = buildParameterBead({
    beadType: 'latency',
    checkExists: () => {
      // Check current
      if (edge.p?.latency?.median_lag_days !== undefined) return true;
      // Check base
      if (edgeKeyForLatency && scenariosContext.baseParams.edges?.[edgeKeyForLatency]?.p?.latency?.median_lag_days !== undefined) return true;
      // Check all visible scenarios
      for (const scenarioId of orderedVisibleIds) {
        if (scenarioId === 'current' || scenarioId === 'base') continue;
        // Look for explicit latency on this scenario (not the synthetic 0d/100%)
        const scenario = scenariosContext.scenarios?.find((s: any) => s.id === scenarioId);
        const latency = scenario?.params?.edges?.[edgeKeyForLatency]?.p?.latency;
        if (latency?.median_lag_days !== undefined) return true;
      }
      return false;
    },
    extractFromLayer: (layerId) => getEdgeLatencyForLayer(layerId, edge, graph, scenariosContext),
    buildLabel: BeadLabelBuilder.buildLatencyLabel,
    backgroundColor: '#374151', // Dark grey
    hasParameterConnection: false,
    isOverridden: false,
    baseDistance,
    beadIndex: beadIndex,
    orderedVisibleIds,
    currentVisible,
    getScenarioColour,
    rightAligned: true // Position from path END
  });
  
  if (latencyBead) {
    beads.push(latencyBead);
    beadIndex++;
  }
  
  // ============================================================================
  // 3. Cost GBP Bead (if present in ANY layer)
  // ============================================================================
  const edgeKeyForCosts = edge.id || edge.uuid;
  const costGBPBead = buildParameterBead({
    beadType: 'cost_gbp',
    checkExists: () => {
      // Check current
      if (edge.cost_gbp) return true;
      // Check base
      if (edgeKeyForCosts && scenariosContext.baseParams.edges?.[edgeKeyForCosts]?.cost_gbp) return true;
      // Check all visible scenarios
      for (const scenarioId of orderedVisibleIds) {
        if (scenarioId === 'current' || scenarioId === 'base') continue;
        const cost = getEdgeCostGBPForLayer(scenarioId, edge, graph, scenariosContext);
        if (cost?.mean !== undefined) return true;
      }
      return false;
    },
    extractFromLayer: (layerId) => getEdgeCostGBPForLayer(layerId, edge, graph, scenariosContext),
    buildLabel: BeadLabelBuilder.buildCostGBPLabel,
    backgroundColor: '#000000',
    hasParameterConnection: !!((edge as any).cost_gbp?.id),
    isOverridden: !!((edge as any).cost_gbp?.mean_overridden),
    baseDistance,
    beadIndex: beadIndex,
    orderedVisibleIds,
    currentVisible,
    getScenarioColour
  });
  
  if (costGBPBead) {
    beads.push(costGBPBead);
    beadIndex++;
  }
  
  // ============================================================================
  // 4. Cost Time Bead (if present in ANY layer)
  // ============================================================================
  const costTimeBead = buildParameterBead({
    beadType: 'labour_cost',
    checkExists: () => {
      // Check current
      if (edge.labour_cost) return true;
      // Check base
      if (edgeKeyForCosts && scenariosContext.baseParams.edges?.[edgeKeyForCosts]?.labour_cost) return true;
      // Check all visible scenarios
      for (const scenarioId of orderedVisibleIds) {
        if (scenarioId === 'current' || scenarioId === 'base') continue;
        const cost = getEdgeCostTimeForLayer(scenarioId, edge, graph, scenariosContext);
        if (cost?.mean !== undefined) return true;
      }
      return false;
    },
    extractFromLayer: (layerId) => getEdgeCostTimeForLayer(layerId, edge, graph, scenariosContext),
    buildLabel: BeadLabelBuilder.buildCostTimeLabel,
    backgroundColor: '#000000',
    hasParameterConnection: !!((edge as any).labour_cost?.id),
    isOverridden: !!((edge as any).labour_cost?.mean_overridden),
    baseDistance,
    beadIndex: beadIndex,
    orderedVisibleIds,
    currentVisible,
    getScenarioColour
  });
  
  if (costTimeBead) {
    beads.push(costTimeBead);
    beadIndex++;
  }
  
  // ============================================================================
  // 5. Conditional Probability Beads (one per conditional_p entry)
  // ============================================================================
  if (edge.conditional_p && edge.conditional_p.length > 0) {
    edge.conditional_p.forEach((cp: any, cpIndex: number) => {
      const condValues: BeadValue[] = [];
      let hiddenCurrentCond: { value: number } | undefined;
      
      const conditionStr = typeof cp.condition === 'string' ? cp.condition : '';
      const condProb = cp.p?.mean ?? 0;
      
      // For conditional probabilities, we show the same value across scenarios
      // (they're edge-specific, not scenario-specific)
      // But we still need to check if they differ across scenarios
      // IMPORTANT: Prefer edge.id for scenario param lookups (human-readable IDs)
      const edgeKey = edge.id || edge.uuid;
      if (!edgeKey) return; // Skip if no edge key
      
      // Use orderedVisibleIds (panel display order)
      for (const scenarioId of orderedVisibleIds) {
        // Conditional probabilities are typically the same across scenarios
        // but we'll check the composed params for each scenario
        const scenario = scenariosContext.scenarios.find((s: any) => s.id === scenarioId);
        
        let condProbValue = condProb;
        if (scenario) {
          // Scenario layer - use centralized composition
          const composedParams = getComposedParamsForLayer(
            scenarioId,
            scenariosContext.baseParams,
            scenariosContext.currentParams,
            scenariosContext.scenarios
          );
          const edgeParams = composedParams.edges?.[edgeKey];
          if (edgeParams && edgeParams.conditional_p && Array.isArray(edgeParams.conditional_p)) {
            const matchingCond = edgeParams.conditional_p.find((c: any) => 
              typeof c === 'object' && c !== null && typeof c.condition === 'string' && c.condition === conditionStr
            );
            if (matchingCond && typeof matchingCond === 'object' && matchingCond !== null && 'p' in matchingCond) {
              const pValue = (matchingCond as any).p;
              if (pValue && typeof pValue === 'object' && 'mean' in pValue) {
                condProbValue = pValue.mean;
              }
            }
          }
        }
        
        condValues.push({
          scenarioId,
          value: condProbValue,
          colour: getScenarioColour(scenarioId)
        });
      }
      
      if (!currentVisible && condValues.length > 0) {
        const visibleAllSame = condValues.every(v => v.value === condValues[0].value);
        const currentCondProb = condProb; // Use base value for current
        if (!visibleAllSame || condValues[0].value !== currentCondProb) {
          hiddenCurrentCond = { value: currentCondProb };
        }
      }
      
      const allCondIdentical = condValues.length > 0 && condValues.every(v => v.value === condValues[0].value);
      
      // Get colour for this specific conditional probability
      const condColour = getConditionalProbabilityColour(cp);
      const darkenedColour = ensureDarkBeadColour(condColour);
      
      beads.push({
        type: 'conditional_p',
        values: condValues,
        hiddenCurrent: hiddenCurrentCond,
        displayText: formatBeadText(
          condValues,
          hiddenCurrentCond,
          (v) => formatConditional(conditionStr, v as number)
        ),
        allIdentical: allCondIdentical && !hiddenCurrentCond,
        backgroundColor: darkenedColour,
        hasParameterConnection: false,
        isOverridden: !!(cp.p?.mean_overridden),
        distance: baseDistance + beadIndex * BEAD_SPACING,
        expanded: false, // Default collapsed
        index: beadIndex++
      });
    });
  }
  
  return beads;
}

