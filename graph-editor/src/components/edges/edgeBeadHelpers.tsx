/**
 * Edge Bead Data Extraction Helpers
 * 
 * This module extracts data for bead rendering from edges and scenarios.
 * Repurposes logic from edgeLabelHelpers.tsx but builds bead definitions instead of label segments.
 */

import React from 'react';
import { computeEffectiveEdgeProbability, parseWhatIfDSL } from '@/lib/whatIf';
import { composeParams } from '../../services/CompositionService';
import { BEAD_MARKER_DISTANCE, BEAD_SPACING } from '../../lib/nodeEdgeConstants';
import { getCaseEdgeVariantInfo } from './edgeLabelHelpers';
import { getConditionalProbabilityColor, ensureDarkBeadColor } from '@/lib/conditionalColors';
import { darkenCaseColor } from '@/lib/conditionalColors';
import type { ScenarioParams } from '../../types/scenarios';
import type { Graph, GraphEdge } from '../../types';

// ============================================================================
// Data Structures
// ============================================================================

export interface BeadValue {
  scenarioId: string;
  value: number | string;
  color: string; // scenario color
  stdev?: number; // Standard deviation (for probability and cost beads)
}

export interface BeadDefinition {
  type: 'probability' | 'cost_gbp' | 'cost_time' | 'variant' | 'conditional_p';
  
  // Multi-scenario values
  values: BeadValue[];
  
  // Hidden current value (if 'current' not visible but differs)
  hiddenCurrent?: {
    value: number | string;
  };
  
  // Display
  displayText: React.ReactNode; // Colored segments + optional grey brackets
  allIdentical: boolean; // true if all visible scenarios have same value
  
  // Bead appearance
  backgroundColor: string; // Dark grey for normal params, colored for variant/conditional
  hasParameterConnection: boolean; // Show 🔌 icon when expanded
  
  // Position
  distance: number; // along spline from visible start
  expanded: boolean; // default expansion state
  index: number; // for ordering along spline
}

// ============================================================================
// Helper: Format Value
// ============================================================================

function formatProbability(value: number, stdev?: number): string {
  // Convert probability (0-1) to percentage (0-100)
  const percent = value * 100;
  const stdevPercent = stdev ? stdev * 100 : undefined;
  if (stdevPercent && stdevPercent > 0) {
    return `${Math.round(percent)}% ± ${Math.round(stdevPercent)}%`;
  }
  return `${Math.round(percent)}%`;
}

function formatCostGBP(value: number, stdev?: number): string {
  if (stdev && stdev > 0) {
    return `£${value.toFixed(2)} ± £${stdev.toFixed(2)}`;
  }
  return `£${value.toFixed(2)}`;
}

function formatCostTime(value: number, stdev?: number): string {
  if (stdev && stdev > 0) {
    return `${value.toFixed(1)}d ± ${stdev.toFixed(1)}d`;
  }
  return `${value.toFixed(1)}d`;
}

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
// Helper: Format Bead Text with Multi-Scenario Support
// ============================================================================

function formatBeadText(
  values: BeadValue[],
  hiddenCurrent?: { value: number | string; stdev?: number },
  formatter: (v: number | string, stdev?: number) => string = (v) => String(v)
): React.ReactNode {
  const allIdentical = values.length > 0 && values.every(v => v.value === values[0].value);
  
  if (allIdentical && !hiddenCurrent) {
    // Always use white/bright text on dark grey backgrounds
    // If all identical, use the stdev from the first value
    return <span style={{ color: '#FFFFFF' }}>{formatter(values[0].value, values[0].stdev)}</span>;
  }
  
  const segments: React.ReactNode[] = [];
  
  // Visible scenario values
  values.forEach((val, idx) => {
    segments.push(
      <span key={idx} style={{ color: val.color }}>
        {formatter(val.value, val.stdev)}
      </span>
    );
    if (idx < values.length - 1) {
      segments.push(' ');
    }
  });
  
  // Hidden current in brackets (if present and differs)
  if (hiddenCurrent !== undefined) {
    const visibleAllIdentical = allIdentical && values.length > 0 && values[0].value === hiddenCurrent.value;
    if (!visibleAllIdentical) {
      segments.push(' (');
      segments.push(
        <span key="hidden" style={{ color: '#808080' }}>
          {formatter(hiddenCurrent.value, hiddenCurrent.stdev)}
        </span>
      );
      segments.push(')');
    }
  }
  
  return <>{segments}</>;
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
    // Scenario layer
    const scenario = scenariosContext.scenarios.find((s: any) => s.id === layerId);
    if (!scenario) {
      return { probability: 0 };
    }
    
    const allScenarios = scenariosContext.scenarios;
    const currentIndex = allScenarios.findIndex((s: any) => s.id === layerId);
    const layersBelow = allScenarios
      .slice(0, currentIndex)
      .map((s: any) => s.params)
      .filter((p: any): p is NonNullable<typeof p> => p !== undefined);
    
    // Compose params
    const composedParams = composeParams(scenariosContext.baseParams, layersBelow.concat([scenario.params]));
    
    // Get probability with fallback chain (same as old label system)
    // IMPORTANT: composedParams should include all edges from baseParams, but if scenario doesn't override,
    // we need to check baseParams directly. Also check the actual edge object as final fallback.
    let prob = composedParams.edges?.[edgeKey]?.p?.mean;
    if (prob === undefined || prob === null) {
      prob = scenariosContext.baseParams.edges?.[edgeKey]?.p?.mean;
    }
    if (prob === undefined || prob === null) {
      // Final fallback: use the actual edge's probability (should always exist)
      prob = edge?.p?.mean ?? 0;
    }
    const stdev = composedParams.edges?.[edgeKey]?.p?.stdev 
      ?? scenariosContext.baseParams.edges?.[edgeKey]?.p?.stdev
      ?? edge?.p?.stdev;
    
    // For variant edges, return actual p (not p*v_weight)
    // Variant weight is shown separately in the variant bead
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
    const scenario = scenariosContext.scenarios.find((s: any) => s.id === layerId);
    if (!scenario) return undefined;
    
    const allScenarios = scenariosContext.scenarios;
    const currentIndex = allScenarios.findIndex((s: any) => s.id === layerId);
    const layersBelow = allScenarios
      .slice(0, currentIndex)
      .map((s: any) => s.params)
      .filter((p: any): p is NonNullable<typeof p> => p !== undefined);
    
    const composedParams = composeParams(scenariosContext.baseParams, layersBelow.concat([scenario.params]));
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
    return edge?.cost_time;
  } else if (layerId === 'base') {
    return scenariosContext.baseParams.edges?.[edgeKey]?.cost_time;
  } else {
    const scenario = scenariosContext.scenarios.find((s: any) => s.id === layerId);
    if (!scenario) return undefined;
    
    const allScenarios = scenariosContext.scenarios;
    const currentIndex = allScenarios.findIndex((s: any) => s.id === layerId);
    const layersBelow = allScenarios
      .slice(0, currentIndex)
      .map((s: any) => s.params)
      .filter((p: any): p is NonNullable<typeof p> => p !== undefined);
    
    const composedParams = composeParams(scenariosContext.baseParams, layersBelow.concat([scenario.params]));
    return composedParams.edges?.[edgeKey]?.cost_time;
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
          const override = parsed.caseOverrides?.[caseNode.id] || 
                          parsed.caseOverrides?.[caseNode.case?.id] ||
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
    const scenario = scenariosContext.scenarios.find((s: any) => s.id === layerId);
    if (!scenario) return null;
    
    const allScenarios = scenariosContext.scenarios;
    const currentIndex = allScenarios.findIndex((s: any) => s.id === layerId);
    const layersBelow = allScenarios
      .slice(0, currentIndex)
      .map((s: any) => s.params)
      .filter((p: any): p is NonNullable<typeof p> => p !== undefined);
    
    const composedParams = composeParams(scenariosContext.baseParams, layersBelow.concat([scenario.params]));
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
  visibleColorOrderIds: string[],
  scenarioColors: Map<string, string>,
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
  
  // Helper to get scenario color
  const getScenarioColor = (scenarioId: string): string => {
    return scenarioColors.get(scenarioId) || '#000000';
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
          color: getScenarioColor(scenarioId)
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
    
    // Use darkened case node color for background
    const caseColor = sourceNode.layout?.color || '#8B5CF6';
    const darkenedColor = darkenCaseColor(caseColor);
    
    // Format variant text: "variantName: 50% 25% 50%" with colored percentages
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
      // Add colored percentages for each scenario (when they differ)
      variantValues.forEach((val, idx) => {
        variantSegments.push(
          <span key={idx} style={{ color: val.color }}>
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
      backgroundColor: darkenedColor,
      hasParameterConnection: false,
      distance: baseDistance + beadIndex * BEAD_SPACING,
      expanded: true, // Default expanded
      index: beadIndex++
    });
  }
  
  // ============================================================================
  // 2. Probability Bead
  // ============================================================================
  const probValues: BeadValue[] = [];
  let hiddenCurrentProb: { value: number } | undefined;
  
  // Collect visible scenario values in scenarioOrder (panel display order)
  for (const scenarioId of orderedVisibleIds) {
    const { probability, stdev } = getEdgeProbabilityForLayer(scenarioId, edge, graph, scenariosContext, whatIfDSL);
    
    probValues.push({
      scenarioId,
      value: probability,
      color: getScenarioColor(scenarioId),
      stdev
    });
  }
  
  // Check hidden current
  if (!currentVisible) {
    const { probability, stdev } = getEdgeProbabilityForLayer('current', edge, graph, scenariosContext, whatIfDSL);
    const visibleAllSame = probValues.length > 0 && probValues.every(v => v.value === probValues[0].value);
    if (!visibleAllSame || probValues.length === 0 || probValues[0].value !== probability) {
      hiddenCurrentProb = { value: probability, stdev };
    }
  }
  
  const allProbIdentical = probValues.length > 0 && probValues.every(v => v.value === probValues[0].value);
  
  beads.push({
    type: 'probability',
    values: probValues,
    hiddenCurrent: hiddenCurrentProb,
    displayText: formatBeadText(probValues, hiddenCurrentProb, (v, stdev) => formatProbability(v as number, stdev)),
    allIdentical: allProbIdentical && !hiddenCurrentProb,
    backgroundColor: '#000000', // Black with white/bright text (80% opacity)
    hasParameterConnection: !!(edge as any).parameter_id,
    distance: baseDistance + beadIndex * BEAD_SPACING,
    expanded: true, // Default expanded
    index: beadIndex++
  });
  
  // ============================================================================
  // 3. Cost GBP Bead (if present)
  // ============================================================================
  const edgeKeyForCosts = edge.id || edge.uuid;
  if (edge.cost_gbp || (edgeKeyForCosts && scenariosContext.baseParams.edges?.[edgeKeyForCosts]?.cost_gbp)) {
    const costValues: BeadValue[] = [];
    let hiddenCurrentCost: { value: number } | undefined;
    
    // Use orderedVisibleIds (panel display order)
    for (const scenarioId of orderedVisibleIds) {
      const cost = getEdgeCostGBPForLayer(scenarioId, edge, graph, scenariosContext);
      if (cost?.mean !== undefined) {
        costValues.push({
          scenarioId,
          value: cost.mean,
          color: getScenarioColor(scenarioId),
          stdev: cost.stdev
        });
      }
    }
    
    if (!currentVisible && costValues.length > 0) {
      const cost = getEdgeCostGBPForLayer('current', edge, graph, scenariosContext);
      if (cost?.mean !== undefined) {
        const visibleAllSame = costValues.every(v => v.value === costValues[0].value);
        if (!visibleAllSame || costValues[0].value !== cost.mean) {
          hiddenCurrentCost = { value: cost.mean, stdev: cost.stdev };
        }
      }
    }
    
    const allCostIdentical = costValues.length > 0 && costValues.every(v => v.value === costValues[0].value);
    
    if (costValues.length > 0 || hiddenCurrentCost) {
      beads.push({
        type: 'cost_gbp',
        values: costValues,
        hiddenCurrent: hiddenCurrentCost,
        displayText: formatBeadText(costValues, hiddenCurrentCost, (v, stdev) => formatCostGBP(v as number, stdev)),
        allIdentical: allCostIdentical && !hiddenCurrentCost,
        backgroundColor: '#000000', // Black with white/bright text (80% opacity)
        hasParameterConnection: !!((edge as any).cost_gbp_parameter_id),
        distance: baseDistance + beadIndex * BEAD_SPACING,
        expanded: true, // Default expanded
        index: beadIndex++
      });
    }
  }
  
  // ============================================================================
  // 4. Cost Time Bead (if present)
  // ============================================================================
  if (edge.cost_time || (edgeKeyForCosts && scenariosContext.baseParams.edges?.[edgeKeyForCosts]?.cost_time)) {
    const costValues: BeadValue[] = [];
    let hiddenCurrentCost: { value: number } | undefined;
    
    // Use orderedVisibleIds (panel display order)
    for (const scenarioId of orderedVisibleIds) {
      const cost = getEdgeCostTimeForLayer(scenarioId, edge, graph, scenariosContext);
      if (cost?.mean !== undefined) {
        costValues.push({
          scenarioId,
          value: cost.mean,
          color: getScenarioColor(scenarioId),
          stdev: cost.stdev
        });
      }
    }
    
    if (!currentVisible && costValues.length > 0) {
      const cost = getEdgeCostTimeForLayer('current', edge, graph, scenariosContext);
      if (cost?.mean !== undefined) {
        const visibleAllSame = costValues.every(v => v.value === costValues[0].value);
        if (!visibleAllSame || costValues[0].value !== cost.mean) {
          hiddenCurrentCost = { value: cost.mean, stdev: cost.stdev };
        }
      }
    }
    
    const allCostIdentical = costValues.length > 0 && costValues.every(v => v.value === costValues[0].value);
    
    if (costValues.length > 0 || hiddenCurrentCost) {
      beads.push({
        type: 'cost_time',
        values: costValues,
        hiddenCurrent: hiddenCurrentCost,
        displayText: formatBeadText(costValues, hiddenCurrentCost, (v, stdev) => formatCostTime(v as number, stdev)),
        allIdentical: allCostIdentical && !hiddenCurrentCost,
        backgroundColor: '#000000', // Black with white/bright text (80% opacity)
        hasParameterConnection: !!((edge as any).cost_time_parameter_id),
        distance: baseDistance + beadIndex * BEAD_SPACING,
        expanded: true, // Default expanded
        index: beadIndex++
      });
    }
  }
  
  // ============================================================================
  // 5. Conditional Probability Beads (one per conditional_p entry)
  // ============================================================================
  if (edge.conditional_p && edge.conditional_p.length > 0) {
    edge.conditional_p.forEach((cp: any) => {
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
          const allScenarios = scenariosContext.scenarios;
          const currentIndex = allScenarios.findIndex((s: any) => s.id === scenarioId);
          const layersBelow = allScenarios
            .slice(0, currentIndex)
            .map((s: any) => s.params)
            .filter((p: any): p is NonNullable<typeof p> => p !== undefined);
          
          const composedParams = composeParams(scenariosContext.baseParams, layersBelow.concat([scenario.params]));
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
          color: getScenarioColor(scenarioId)
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
      
      // Get color for this specific conditional probability
      const condColor = getConditionalProbabilityColor(cp);
      const darkenedColor = ensureDarkBeadColor(condColor);
      
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
        backgroundColor: darkenedColor,
        hasParameterConnection: false,
        distance: baseDistance + beadIndex * BEAD_SPACING,
        expanded: false, // Default collapsed
        index: beadIndex++
      });
    });
  }
  
  return beads;
}

