/**
 * Edge Label Construction Helpers
 * 
 * This module provides a unified system for building and rendering edge labels
 * across all scenario configurations. It consolidates duplicate logic and ensures
 * consistent display regardless of whether scenarios are visible.
 * 
 * Key Features:
 * - Single code path for all label rendering
 * - Smart deduplication of identical values
 * - Per-field deduplication (e.g., same costs, different probabilities)
 * - Inline cost display with comma separation
 * - Variant name first for case edges
 * - Plug icon for parameter connections
 */

import React from 'react';
import { computeEffectiveEdgeProbability } from '@/lib/whatIf';
import { composeParams } from '../../services/CompositionService';
import type { ScenarioParams } from '../../types/scenarios';

// ============================================================================
// Data Structures
// ============================================================================

export interface CaseEdgeInfo {
  variantName: string;
  variantWeight: number;
  edgeProbability: number;
  caseId: string;
}

export interface LabelSegment {
  layerId: string;
  
  // Probability info
  probability: number;
  stdev?: number;
  
  // Case edge info (if applicable)
  variantName?: string;
  variantWeight?: number;
  edgeProbability?: number;
  
  // Cost info (inline)
  cost_gbp?: {
    mean?: number;
    stdev?: number;
  };
  cost_time?: {
    mean?: number;
    stdev?: number;
  };
  
  // Parameter connections
  parameter_id?: string;
  cost_gbp_parameter_id?: string;
  cost_time_parameter_id?: string;
  
  // Display info
  color: string;
  isHidden: boolean;
}

export interface CompositeLabel {
  segments: LabelSegment[];
  deduplication: {
    type: 'full' | 'simplified' | 'partial' | 'none';
    dedupFlags?: {
      probability: boolean;
      cost_gbp: boolean;
      cost_time: boolean;
    };
  };
}

// ============================================================================
// Helper: Extract Case Edge Variant Information
// ============================================================================

/**
 * Extract case edge variant information (name, weight, edge probability)
 * This is the SINGLE source of truth for variant extraction, replacing 4 duplicate implementations.
 */
export function getCaseEdgeVariantInfo(
  edge: any,
  graph: any,
  params?: ScenarioParams
): CaseEdgeInfo | null {
  if (!edge?.case_variant) {
    return null;
  }
  
  // Find case ID
  let caseId = edge.case_id;
  if (!caseId) {
    const sourceNode = graph.nodes?.find((n: any) => 
      n.uuid === edge.from || n.id === edge.from
    );
    if (sourceNode?.type === 'case') {
      caseId = sourceNode.case?.id || sourceNode.uuid || sourceNode.id;
    }
  }
  
  if (!caseId) {
    return null;
  }
  
  // Find case node
  const caseNode = graph.nodes?.find((n: any) => 
    n.type === 'case' && (
      n.case?.id === caseId || 
      n.uuid === caseId || 
      n.id === caseId
    )
  );
  
  // Try to get variant from params first (for frozen scenarios), then from graph
  let variant: any = null;
  
  if (params) {
    const caseNodeKey = caseNode?.id || caseId;
    const variants = params.nodes?.[caseNodeKey]?.case?.variants;
    if (variants) {
      variant = variants.find((v: any) => v.name === edge.case_variant);
    }
  }
  
  // Fallback to graph if not in params
  if (!variant && caseNode) {
    variant = caseNode.case?.variants?.find((v: any) => 
      v.name === edge.case_variant
    );
  }
  
  if (!variant) {
    return null;
  }
  
  return {
    variantName: edge.case_variant,
    variantWeight: variant.weight ?? 0,
    edgeProbability: edge.p?.mean ?? 1.0,
    caseId
  };
}

// ============================================================================
// Helper: Get Edge Info for a Specific Layer
// ============================================================================

/**
 * Get complete edge information for a specific layer (base, current, or scenario)
 * This replaces the duplicate logic in compositeLabel calculation.
 */
export function getEdgeInfoForLayer(
  layerId: string,
  edge: any,
  graph: any,
  scenariosContext: any,
  whatIfDSL?: string | null
): Omit<LabelSegment, 'color' | 'isHidden' | 'layerId'> {
  const lookupId = edge?.uuid || edge?.id;
  const edgeKey = edge?.id || edge?.uuid || lookupId;
  
  if (layerId === 'current') {
    // Current layer: use What-If logic
    const prob = computeEffectiveEdgeProbability(graph, lookupId, { whatIfDSL });
    const stdev = edge?.p?.stdev;
    
    const caseInfo = getCaseEdgeVariantInfo(edge, graph);
    
    return {
      probability: prob,
      stdev,
      variantName: caseInfo?.variantName,
      variantWeight: caseInfo?.variantWeight,
      edgeProbability: caseInfo?.edgeProbability,
      cost_gbp: edge?.cost_gbp,
      cost_time: edge?.cost_time,
      parameter_id: edge?.parameter_id,
      cost_gbp_parameter_id: edge?.cost_gbp_parameter_id,
      cost_time_parameter_id: edge?.cost_time_parameter_id,
    };
  } else if (layerId === 'base') {
    // Base layer: ONLY use baseParams (frozen snapshot)
    let prob = scenariosContext.baseParams.edges?.[edgeKey]?.p?.mean ?? 0;
    const stdev = scenariosContext.baseParams.edges?.[edgeKey]?.p?.stdev;
    
    const caseInfo = getCaseEdgeVariantInfo(edge, graph, scenariosContext.baseParams);
    
    // Apply case variant weight if this is a case edge
    if (caseInfo) {
      prob = prob * caseInfo.variantWeight;
    }
    
    return {
      probability: prob,
      stdev,
      variantName: caseInfo?.variantName,
      variantWeight: caseInfo?.variantWeight,
      edgeProbability: caseInfo ? (scenariosContext.baseParams.edges?.[edgeKey]?.p?.mean ?? 1.0) : undefined,
      cost_gbp: scenariosContext.baseParams.edges?.[edgeKey]?.cost_gbp,
      cost_time: scenariosContext.baseParams.edges?.[edgeKey]?.cost_time,
      parameter_id: edge?.parameter_id,
      cost_gbp_parameter_id: edge?.cost_gbp_parameter_id,
      cost_time_parameter_id: edge?.cost_time_parameter_id,
    };
  } else {
    // Scenario layer: look up in scenario params (with compositing)
    const scenario = scenariosContext.scenarios.find((s: any) => s.id === layerId);
    if (!scenario) {
      return {
        probability: 0,
        parameter_id: edge?.parameter_id,
        cost_gbp_parameter_id: edge?.cost_gbp_parameter_id,
        cost_time_parameter_id: edge?.cost_time_parameter_id,
      };
    }
    
    // Get all layers below this one for compositing
    // Note: We assume visibleScenarioIds is available in context, but for now we'll compose with all previous scenarios
    const allScenarios = scenariosContext.scenarios;
    const currentIndex = allScenarios.findIndex((s: any) => s.id === layerId);
    const layersBelow = allScenarios
      .slice(0, currentIndex)
      .map((s: any) => s.params)
      .filter((p: any): p is NonNullable<typeof p> => p !== undefined);
    
    // Compose params
    const composedParams = composeParams(scenariosContext.baseParams, layersBelow.concat([scenario.params]));
    
    // Get probability
    let prob = composedParams.edges?.[edgeKey]?.p?.mean 
      ?? scenariosContext.baseParams.edges?.[edgeKey]?.p?.mean 
      ?? 0;
    const stdev = composedParams.edges?.[edgeKey]?.p?.stdev 
      ?? scenariosContext.baseParams.edges?.[edgeKey]?.p?.stdev;
    
    const caseInfo = getCaseEdgeVariantInfo(edge, graph, composedParams);
    
    // Apply case variant weight if this is a case edge
    if (caseInfo) {
      prob = prob * caseInfo.variantWeight;
    }
    
    return {
      probability: prob,
      stdev,
      variantName: caseInfo?.variantName,
      variantWeight: caseInfo?.variantWeight,
      edgeProbability: caseInfo ? (composedParams.edges?.[edgeKey]?.p?.mean ?? 1.0) : undefined,
      cost_gbp: composedParams.edges?.[edgeKey]?.cost_gbp,
      cost_time: composedParams.edges?.[edgeKey]?.cost_time,
      parameter_id: edge?.parameter_id,
      cost_gbp_parameter_id: edge?.cost_gbp_parameter_id,
      cost_time_parameter_id: edge?.cost_time_parameter_id,
    };
  }
}

// ============================================================================
// Helper: Build Complete Composite Label
// ============================================================================

/**
 * Build complete composite label structure for an edge.
 * This is the ONLY entry point for label construction - replaces all duplicate logic.
 */
export function buildCompositeLabel(
  edge: any,
  graph: any,
  scenariosContext: any,
  activeTabId: string | null,
  tabs: any[],
  whatIfDSL?: string | null,
  currentColor?: string,
  baseColor?: string
): CompositeLabel | null {
  if (!scenariosContext || !graph || !activeTabId) {
    // No scenarios context: return single segment for current layer
    const prob = computeEffectiveEdgeProbability(graph, edge?.uuid || edge?.id, { whatIfDSL });
    const caseInfo = getCaseEdgeVariantInfo(edge, graph);
    
    return {
      segments: [{
        layerId: 'current',
        probability: prob,
        stdev: edge?.p?.stdev,
        variantName: caseInfo?.variantName,
        variantWeight: caseInfo?.variantWeight,
        edgeProbability: caseInfo?.edgeProbability,
        cost_gbp: edge?.cost_gbp,
        cost_time: edge?.cost_time,
        parameter_id: edge?.parameter_id,
        cost_gbp_parameter_id: edge?.cost_gbp_parameter_id,
        cost_time_parameter_id: edge?.cost_time_parameter_id,
        color: '#000',
        isHidden: false
      }],
      deduplication: { type: 'full' }
    };
  }
  
  const currentTab = tabs.find(t => t.id === activeTabId);
  const scenarioState = currentTab?.editorState?.scenarioState;
  const visibleScenarioIds = scenarioState?.visibleScenarioIds || [];
  const visibleColorOrderIds = scenarioState?.visibleColorOrderIds || [];
  
  // Get scenario color using same logic as elsewhere
  // Only the sole VISIBLE layer is shown in grey; hidden layers retain their assigned color.
  const getScenarioColor = (scenarioId: string, isVisible: boolean = true): string => {
    // Single-layer grey override: ONLY apply to the visible layer when exactly 1 layer is visible
    if (isVisible && visibleScenarioIds.length === 1) {
      return '#808080';
    }
    
    // Get stored colour (for both visible and hidden layers)
    if (scenarioId === 'current') {
      return currentColor || '#3B82F6';
    } else if (scenarioId === 'base') {
      return baseColor || '#A3A3A3';
    } else {
      const scenario = scenariosContext.scenarios.find((s: any) => s.id === scenarioId);
      return scenario?.color || '#808080';
    }
  };
  
  // If no visible scenarios, treat as single current segment
  if (visibleScenarioIds.length === 0) {
    const info = getEdgeInfoForLayer('current', edge, graph, scenariosContext, whatIfDSL);
    return {
      segments: [{
        ...info,
        layerId: 'current',
        color: '#000',
        isHidden: false
      }],
      deduplication: { type: 'full' }
    };
  }
  
  const segments: LabelSegment[] = [];
  
  // Add segment for each visible layer (bottom-to-top in stack order)
  for (const layerId of visibleScenarioIds) {
    const info = getEdgeInfoForLayer(layerId, edge, graph, scenariosContext, whatIfDSL);
    segments.push({
      ...info,
      layerId,
      color: getScenarioColor(layerId, true),
      isHidden: false
    });
  }
  
  // Add hidden 'current' if not in visible list
  if (!visibleScenarioIds.includes('current')) {
    const info = getEdgeInfoForLayer('current', edge, graph, scenariosContext, whatIfDSL);
    segments.push({
      ...info,
      layerId: 'current',
      color: '#999', // Light grey for hidden
      isHidden: true
    });
  }
  
  // Analyze deduplication
  const deduplication = analyzeDeduplication(segments);
  
  return {
    segments,
    deduplication
  };
}

// ============================================================================
// Helper: Analyze Deduplication
// ============================================================================

/**
 * Analyze segments and determine deduplication strategy
 */
export function analyzeDeduplication(segments: LabelSegment[]): CompositeLabel['deduplication'] {
  const visible = segments.filter(s => !s.isHidden);
  const hidden = segments.filter(s => s.isHidden);
  
  if (visible.length === 0) {
    return { type: 'none' };
  }
  
  if (visible.length === 1 && hidden.length === 0) {
    return { type: 'full' };
  }
  
  // Check if ALL fields identical across visible
  const first = visible[0];
  const allFieldsIdentical = visible.every(s => 
    s.probability === first.probability &&
    s.variantWeight === first.variantWeight &&
    s.edgeProbability === first.edgeProbability &&
    s.stdev === first.stdev &&
    s.cost_gbp?.mean === first.cost_gbp?.mean &&
    s.cost_gbp?.stdev === first.cost_gbp?.stdev &&
    s.cost_time?.mean === first.cost_time?.mean &&
    s.cost_time?.stdev === first.cost_time?.stdev
  );
  
  if (allFieldsIdentical) {
    // Check if hidden also matches
    const hiddenMatches = hidden.every(h => 
      h.probability === first.probability &&
      h.variantWeight === first.variantWeight &&
      h.edgeProbability === first.edgeProbability &&
      h.stdev === first.stdev &&
      h.cost_gbp?.mean === first.cost_gbp?.mean &&
      h.cost_gbp?.stdev === first.cost_gbp?.stdev &&
      h.cost_time?.mean === first.cost_time?.mean &&
      h.cost_time?.stdev === first.cost_time?.stdev
    );
    
    if (hiddenMatches) {
      return { type: 'full' };
    } else {
      return { type: 'simplified' };
    }
  }
  
  // Partial deduplication: check per field
  const probsIdentical = visible.every(s => 
    s.probability === first.probability &&
    s.stdev === first.stdev &&
    s.variantWeight === first.variantWeight &&
    s.edgeProbability === first.edgeProbability
  );
  const costsGbpIdentical = visible.every(s => 
    s.cost_gbp?.mean === first.cost_gbp?.mean &&
    s.cost_gbp?.stdev === first.cost_gbp?.stdev
  );
  const costsTimeIdentical = visible.every(s => 
    s.cost_time?.mean === first.cost_time?.mean &&
    s.cost_time?.stdev === first.cost_time?.stdev
  );
  
  // If any field can be deduplicated, use partial mode
  if (probsIdentical || costsGbpIdentical || costsTimeIdentical) {
    return {
      type: 'partial',
      dedupFlags: {
        probability: probsIdentical,
        cost_gbp: costsGbpIdentical,
        cost_time: costsTimeIdentical
      }
    };
  }
  
  return { type: 'none' };
}

// ============================================================================
// Helper: Format Segment Value
// ============================================================================

/**
 * Format a single segment as a string (inline format with costs)
 * Examples:
 * - "🔌 45%"
 * - "treatment: 25%/100% ± 5%"
 * - "45%, £100, 2.5d"
 * - "🔌 treatment: 20%/90%, 🔌 £150 ± £10, 2d"
 */
export function formatSegmentValue(segment: LabelSegment, includeFields: {
  probability: boolean;
  cost_gbp: boolean;
  cost_time: boolean;
}): string {
  const parts: string[] = [];
  
  // Probability part
  if (includeFields.probability) {
    let probPart = '';
    
    // Add plug icon if parameter connected
    if (segment.parameter_id) {
      probPart += '🔌 ';
    }
    
    // Case edge: show variant name + weights
    if (segment.variantName && segment.variantWeight !== undefined && segment.edgeProbability !== undefined) {
      probPart += `${segment.variantName}: ${Math.round(segment.variantWeight * 100)}%/${Math.round(segment.edgeProbability * 100)}%`;
    } else {
      // Normal edge: just probability
      probPart += `${Math.round(segment.probability * 100)}%`;
    }
    
    // Add stdev if present
    if (segment.stdev && segment.stdev > 0) {
      probPart += ` ± ${Math.round(segment.stdev * 100)}%`;
    }
    
    parts.push(probPart);
  }
  
  // GBP cost part
  if (includeFields.cost_gbp && segment.cost_gbp?.mean !== undefined) {
    let costPart = '';
    
    if (segment.cost_gbp_parameter_id) {
      costPart += '🔌 ';
    }
    
    costPart += `£${segment.cost_gbp.mean.toFixed(2)}`;
    
    if (segment.cost_gbp.stdev && segment.cost_gbp.stdev > 0) {
      costPart += ` ± £${segment.cost_gbp.stdev.toFixed(2)}`;
    }
    
    parts.push(costPart);
  }
  
  // Time cost part
  if (includeFields.cost_time && segment.cost_time?.mean !== undefined) {
    let timePart = '';
    
    if (segment.cost_time_parameter_id) {
      timePart += '🔌 ';
    }
    
    timePart += `${segment.cost_time.mean.toFixed(1)}d`;
    
    if (segment.cost_time.stdev && segment.cost_time.stdev > 0) {
      timePart += ` ± ${segment.cost_time.stdev.toFixed(1)}d`;
    }
    
    parts.push(timePart);
  }
  
  return parts.join(', ');
}

// ============================================================================
// Main Render Function
// ============================================================================

/**
 * Render composite label to React nodes
 * 
 * @param selected - Whether the edge is selected (affects text color on dark background)
 */
export function renderCompositeLabel(
  label: CompositeLabel,
  onDoubleClick?: () => void,
  selected?: boolean
): React.ReactNode {
  const { segments, deduplication } = label;
  const visible = segments.filter(s => !s.isHidden);
  const hidden = segments.filter(s => s.isHidden);
  
  if (visible.length === 0) {
    return null;
  }
  
  // Check if this is a case edge (has variant name)
  const isCaseEdge = visible.some(s => s.variantName !== undefined);
  const variantName = isCaseEdge ? visible.find(s => s.variantName)?.variantName : undefined;
  
  // Full deduplication: single label
  // STEP 5: Use white text when selected (on black background), black text otherwise
  if (deduplication.type === 'full') {
    const value = formatSegmentValue(visible[0], {
      probability: true,
      cost_gbp: true,
      cost_time: true
    });
    
    return (
      <span style={{ fontWeight: 'bold', fontSize: '11px', color: selected ? '#fff' : '#000' }}>
        {value}
      </span>
    );
  }
  
  // Simplified: visible identical, hidden differs
  // STEP 5: Adapt text color when selected
  if (deduplication.type === 'simplified') {
    const visibleValue = formatSegmentValue(visible[0], {
      probability: true,
      cost_gbp: true,
      cost_time: true
    });
    
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center' }}>
        <span style={{ fontWeight: 'bold', fontSize: '11px', color: selected ? '#fff' : '#000' }}>
          {visibleValue}
        </span>
        {hidden.map(h => {
          const hiddenValue = formatSegmentValue(h, {
            probability: true,
            cost_gbp: true,
            cost_time: true
          });
          return (
            <span key={h.layerId} style={{ fontWeight: 'bold', fontSize: '11px', color: selected ? '#ccc' : '#999' }}>
              ({hiddenValue})
            </span>
          );
        })}
      </div>
    );
  }
  
  // Partial or no deduplication: show segments with per-field dedup
  const includeProb = deduplication.type !== 'partial' || !deduplication.dedupFlags?.probability;
  const includeCostGbp = deduplication.type !== 'partial' || !deduplication.dedupFlags?.cost_gbp;
  const includeCostTime = deduplication.type !== 'partial' || !deduplication.dedupFlags?.cost_time;
  
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center', flexWrap: 'wrap' }}>
      {/* Show variant name once at the start for case edges */}
      {isCaseEdge && variantName && (
        <span style={{ color: selected ? '#fff' : '#000', fontWeight: 'bold', fontSize: '11px' }}>
          {variantName}:
        </span>
      )}
      
      {/* Render visible segments (without variant name prefix for case edges) */}
      {visible.map((segment, idx) => {
        // For case edges, format without variant name prefix
        let value: string;
        if (isCaseEdge && segment.variantWeight !== undefined && segment.edgeProbability !== undefined) {
          // Case edge: show only weights, not variant name
          const parts: string[] = [];
          
          if (includeProb) {
            let probPart = '';
            if (segment.parameter_id) {
              probPart += '🔌 ';
            }
            probPart += `${Math.round(segment.variantWeight * 100)}%/${Math.round(segment.edgeProbability * 100)}%`;
            if (segment.stdev && segment.stdev > 0) {
              probPart += ` ± ${Math.round(segment.stdev * 100)}%`;
            }
            parts.push(probPart);
          }
          
          if (includeCostGbp && segment.cost_gbp?.mean !== undefined) {
            let costPart = '';
            if (segment.cost_gbp_parameter_id) {
              costPart += '🔌 ';
            }
            costPart += `£${segment.cost_gbp.mean.toFixed(2)}`;
            if (segment.cost_gbp.stdev && segment.cost_gbp.stdev > 0) {
              costPart += ` ± £${segment.cost_gbp.stdev.toFixed(2)}`;
            }
            parts.push(costPart);
          }
          
          if (includeCostTime && segment.cost_time?.mean !== undefined) {
            let timePart = '';
            if (segment.cost_time_parameter_id) {
              timePart += '🔌 ';
            }
            timePart += `${segment.cost_time.mean.toFixed(1)}d`;
            if (segment.cost_time.stdev && segment.cost_time.stdev > 0) {
              timePart += ` ± ${segment.cost_time.stdev.toFixed(1)}d`;
            }
            parts.push(timePart);
          }
          
          value = parts.join(', ');
        } else {
          // Normal edge: use standard formatting
          value = formatSegmentValue(segment, {
            probability: includeProb,
            cost_gbp: includeCostGbp,
            cost_time: includeCostTime
          });
        }
        
        if (!value) return null;
        
        return (
          <span 
            key={segment.layerId}
            style={{
              color: segment.color,
              fontWeight: 'bold',
              fontSize: '11px'
            }}
          >
            {value}
            {idx < visible.length - 1 && ' '}
          </span>
        );
      })}
      
      {/* If partial dedup, show deduplicated fields at end */}
      {/* STEP 5: Adapt text color when selected */}
      {deduplication.type === 'partial' && visible.length > 0 && (
        <>
          {deduplication.dedupFlags?.probability && !isCaseEdge && (
            <span style={{ color: selected ? '#fff' : '#000', fontWeight: 'bold', fontSize: '11px' }}>
              {formatSegmentValue(visible[0], { probability: true, cost_gbp: false, cost_time: false })}
            </span>
          )}
          {deduplication.dedupFlags?.cost_gbp && (
            <span style={{ color: selected ? '#fff' : '#000', fontWeight: 'bold', fontSize: '11px' }}>
              {formatSegmentValue(visible[0], { probability: false, cost_gbp: true, cost_time: false })}
            </span>
          )}
          {deduplication.dedupFlags?.cost_time && (
            <span style={{ color: selected ? '#fff' : '#000', fontWeight: 'bold', fontSize: '11px' }}>
              {formatSegmentValue(visible[0], { probability: false, cost_gbp: false, cost_time: true })}
            </span>
          )}
        </>
      )}
      
      {/* Render hidden segments */}
      {hidden.map(segment => {
        // For case edges with hidden segments, also omit variant name
        let value: string;
        if (isCaseEdge && segment.variantWeight !== undefined && segment.edgeProbability !== undefined) {
          const parts: string[] = [];
          
          let probPart = '';
          if (segment.parameter_id) {
            probPart += '🔌 ';
          }
          probPart += `${Math.round(segment.variantWeight * 100)}%/${Math.round(segment.edgeProbability * 100)}%`;
          if (segment.stdev && segment.stdev > 0) {
            probPart += ` ± ${Math.round(segment.stdev * 100)}%`;
          }
          parts.push(probPart);
          
          if (segment.cost_gbp?.mean !== undefined) {
            let costPart = '';
            if (segment.cost_gbp_parameter_id) {
              costPart += '🔌 ';
            }
            costPart += `£${segment.cost_gbp.mean.toFixed(2)}`;
            if (segment.cost_gbp.stdev && segment.cost_gbp.stdev > 0) {
              costPart += ` ± £${segment.cost_gbp.stdev.toFixed(2)}`;
            }
            parts.push(costPart);
          }
          
          if (segment.cost_time?.mean !== undefined) {
            let timePart = '';
            if (segment.cost_time_parameter_id) {
              timePart += '🔌 ';
            }
            timePart += `${segment.cost_time.mean.toFixed(1)}d`;
            if (segment.cost_time.stdev && segment.cost_time.stdev > 0) {
              timePart += ` ± ${segment.cost_time.stdev.toFixed(1)}d`;
            }
            parts.push(timePart);
          }
          
          value = parts.join(', ');
        } else {
          value = formatSegmentValue(segment, {
            probability: true,
            cost_gbp: true,
            cost_time: true
          });
        }
        
        return (
          <span 
            key={segment.layerId}
            style={{
              color: selected ? '#ccc' : '#999',
              fontWeight: 'bold',
              fontSize: '11px'
            }}
          >
            ({value})
          </span>
        );
      })}
    </div>
  );
}

