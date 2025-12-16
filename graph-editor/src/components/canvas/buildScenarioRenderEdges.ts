/**
 * buildScenarioRenderEdges - Single Pipeline for All Edge Rendering
 * 
 * Replaces the dual base/overlay pipeline with a unified scenario-layer approach.
 * All edges (including 'current') are rendered through scenario logic.
 * Only 'current' layer edges are interactive; all others are visual-only.
 */

import { Edge } from 'reactflow';
import { computeEffectiveEdgeProbability } from '../../lib/whatIf';
import { getComposedParamsForLayer } from '../../services/CompositionService';
import { computeEFBasisForLayer } from '../../services/efBasisResolver';
import { MAX_EDGE_WIDTH, MIN_EDGE_WIDTH, SANKEY_MAX_EDGE_WIDTH, EDGE_OPACITY } from '../../lib/nodeEdgeConstants';
import type { EdgeLatencyDisplay, ScenarioVisibilityMode } from '../../types';

interface BuildScenarioRenderEdgesParams {
  baseEdges: Edge[];
  nodes: any[];
  graph: any;
  scenariosContext: any;
  visibleScenarioIds: string[];
  visibleColourOrderIds: string[];
  whatIfDSL: string | null;
  useUniformScaling: boolean;
  massGenerosity: number;
  useSankeyView: boolean;
  calculateEdgeOffsets: (edges: any[], nodes: any[], maxWidth: number) => any[];
  tabId?: string;
  highlightMetadata?: {
    highlightedEdgeIds: Set<string>;
    edgeDepthMap: Map<string, number>;
    isSingleNodeSelection: boolean;
  };
  isPanningOrZooming?: boolean;
  isInSlowPathRebuild?: boolean;
  /** Function to get the visibility mode (E/F/F+E) for a scenario layer */
  getScenarioVisibilityMode?: (scenarioId: string) => ScenarioVisibilityMode;
  /** Whether current query is cohort-based (affects latency bead policy) */
  isCohortQuery?: boolean;
}

const MIN_CHEVRON_THRESHOLD = 10;

/**
 * Build all edges to render in ReactFlow.
 * 
 * Returns scenario-layer edges for each visible layer + ghosted 'current' if hidden.
 * Only 'current' layer edges are interactive (selectable, editable).
 */
export function buildScenarioRenderEdges(params: BuildScenarioRenderEdgesParams): Edge[] {
  const {
    baseEdges,
    nodes,
    graph,
    scenariosContext,
    visibleScenarioIds,
    visibleColourOrderIds,
    whatIfDSL,
    useUniformScaling,
    massGenerosity,
    useSankeyView,
    calculateEdgeOffsets,
    tabId,
    highlightMetadata,
    isPanningOrZooming,
    isInSlowPathRebuild,
    getScenarioVisibilityMode,
    isCohortQuery
  } = params;

  // Log slow path rebuilds - these are expensive and shouldn't happen repeatedly on load
  if (isInSlowPathRebuild) {
    console.warn(`⚠️ [buildScenarioRenderEdges] Slow path rebuild triggered (${baseEdges.length} edges, ${nodes.length} nodes)`);
  }

  if (!scenariosContext || !graph) {
    // Fallback: return base edges as-is if no scenario system
    return baseEdges;
  }

  // Always render 'current' layer (even if hidden), plus all truly visible layers
  // 'current' will be rendered at ~5% opacity when not in visibleScenarioIds
  // IMPORTANT: Render 'current' LAST so it appears topmost in DOM (for pointer events)
  const layersToRender = visibleScenarioIds.includes('current')
    ? [...visibleScenarioIds.filter(id => id !== 'current'), 'current']  // Current last
    : [...visibleScenarioIds, 'current'];  // Current is hidden, add it last

  // Calculate dynamic opacity based on number of visible layers
  // Uses EDGE_OPACITY from constants as the target combined opacity
  const numVisibleLayers = visibleScenarioIds.length;
  const dynamicLayerOpacity = 1 - Math.pow(1 - EDGE_OPACITY, 1 / numVisibleLayers);

  const scenarios = scenariosContext.scenarios;
  const baseParams = scenariosContext.baseParams;
  const currentParams = scenariosContext.currentParams;
  const currentColour = scenariosContext.currentColour;
  const baseColour = scenariosContext.baseColour;

  /**
   * Get effective colour for a scenario (with single-layer grey override)
   * Only the sole VISIBLE layer is shown in grey; hidden layers retain their assigned colour.
   */
  const getScenarioColour = (scenarioId: string, isVisible: boolean = true): string => {
    // Single-layer grey override: ONLY apply to the visible layer when exactly 1 layer is visible
    if (isVisible && visibleScenarioIds.length === 1) {
      return '#808080';
    }

    // Get stored colour (for both visible and hidden layers)
    if (scenarioId === 'current') {
      return currentColour;
    } else if (scenarioId === 'base') {
      return baseColour;
    } else {
      const scenario = scenarios.find((s: any) => s.id === scenarioId);
      return scenario?.colour || '#808080';
    }
  };

  const renderEdges: Edge[] = [];
  const MAX_WIDTH = MAX_EDGE_WIDTH;
  const MIN_WIDTH = MIN_EDGE_WIDTH;
  const effectiveMaxWidth = useSankeyView ? SANKEY_MAX_EDGE_WIDTH : MAX_WIDTH;
  const effectiveMassGenerosity = useSankeyView ? 0 : massGenerosity;

  const rfNodes = nodes;
  const rfEdges = baseEdges;
  // Find start node: PRIORITIZE is_start=true over entry_weight>0
  // First check for explicit is_start=true, then fall back to entry_weight>0
  const startNode = rfNodes.find((n: any) => n.data?.entry?.is_start === true) 
    || rfNodes.find((n: any) => (n.data?.entry?.entry_weight || 0) > 0);
  const startNodeId = startNode?.id || null;

  // Helper: build residual probability calculator for a given prob resolver
  const buildResidualHelpers = (probResolver: (e: Edge) => number) => {
    const outgoing: Record<string, Edge[]> = {};
    const incoming: Record<string, Edge[]> = {};
    rfEdges.forEach(e => {
      (outgoing[e.source] ||= []).push(e);
      (incoming[e.target] ||= []).push(e);
    });
    const residualAtNode: Record<string, number> = {};
    const visiting = new Set<string>();
    const dfs = (nodeId: string): number => {
      if (residualAtNode[nodeId] !== undefined) return residualAtNode[nodeId];
      if (visiting.has(nodeId)) return 0;
      visiting.add(nodeId);
      if (startNodeId && nodeId === startNodeId) {
        residualAtNode[nodeId] = 1.0;
        visiting.delete(nodeId);
        return 1.0;
      }
      let sumIncoming = 0;
      const inEdges = incoming[nodeId] || [];
      for (const inE of inEdges) {
        const pred = inE.source;
        const massAtPred = dfs(pred);
        if (massAtPred <= 0) continue;
        const out = outgoing[pred] || [];
        const denom = out.reduce((acc, oe) => acc + (probResolver(oe) || 0), 0);
        const p = probResolver(inE) || 0;
        if (denom > 0 && p > 0) sumIncoming += massAtPred * (p / denom);
      }
      residualAtNode[nodeId] = sumIncoming;
      visiting.delete(nodeId);
      return sumIncoming;
    };
    return { dfs };
  };

  // Helper: compute raw width for an overlay edge
  const computeOverlayWidthRaw = (
    e: Edge,
    probResolver: (e: Edge) => number,
    helpers: { dfs: (nodeId: string) => number },
    currentScenarioId: string
  ): number => {
    if (useUniformScaling) {
      // Uniform scaling mode - all edges same width
      return 10;
    }
    const edgeProb = probResolver(e);
    if (!startNodeId) {
      const siblings = rfEdges.filter(se => se.source === e.source);
      const denom = siblings.reduce((sum, se) => sum + (probResolver(se) || 0), 0);
      if (denom === 0) return MIN_WIDTH;
      const proportion = edgeProb / denom;
      const result = MIN_WIDTH + proportion * (effectiveMaxWidth - MIN_WIDTH);
      return result;
    }
    const residualAtSource = helpers.dfs(e.source);
    if (residualAtSource === 0) return MIN_WIDTH;
    const actualMass = residualAtSource * edgeProb;
    let displayMass: number;
    if (effectiveMassGenerosity === 0) {
      displayMass = actualMass;
    } else if (effectiveMassGenerosity === 1) {
      const siblings = rfEdges.filter(se => se.source === e.source);
      const denom = siblings.reduce((sum, se) => sum + (probResolver(se) || 0), 0);
      if (denom === 0) return MIN_WIDTH;
      displayMass = edgeProb / denom;
    } else {
      const power = 1 - effectiveMassGenerosity;
      displayMass = Math.pow(actualMass, power);
    }
    const result = MIN_WIDTH + displayMass * (effectiveMaxWidth - MIN_WIDTH);
    return result;
  };

  // For each scenario to render, create overlay edges
  // Render in layer order (bottom to top of stack) for correct z-index
  for (let layerIndex = 0; layerIndex < layersToRender.length; layerIndex++) {
    const scenarioId = layersToRender[layerIndex];
    const scenario = scenarios.find((s: any) => s.id === scenarioId);
    const isVisible = visibleScenarioIds.includes(scenarioId);
    const colour = getScenarioColour(scenarioId, isVisible);

    // Resolve scenario visibility mode once per layer so geometry + styling stay coherent.
    // This mode determines which probability basis drives widths (and therefore offsets/text-path positioning).
    let layerMode: ScenarioVisibilityMode = 'f+e';
    if (getScenarioVisibilityMode) {
      try {
        layerMode = getScenarioVisibilityMode(scenarioId);
      } catch {
        layerMode = 'f+e';
      }
    }

    // Compose params based on layer type - use centralized composition.
    // IMPORTANT:
    // - For 'base' and scenario layers we compose from baseParams + overlays (frozen snapshots).
    // - For 'current' we MUST use currentParams so latency / evidence / forecast fields reflect
    //   live graph updates (e.g. retrievals from file/source). Probabilities for 'current'
    //   still come from computeEffectiveEdgeProbability via probResolver below.
    const composedParams = getComposedParamsForLayer(
      scenarioId,
      baseParams,
      scenarioId === 'current' ? currentParams : baseParams,
      scenarios,
      visibleScenarioIds
    );

    // Precompute sibling-derived basis values for this layer.
    // This is view-only and must not be persisted.
    const efBasisMaps = computeEFBasisForLayer(graph, composedParams);
    
    // Skip unknown scenarios that couldn't be composed
    if (scenarioId !== 'base' && scenarioId !== 'current' && !scenario) {
      console.warn(`[LAG:buildScenarioRenderEdges] ⏭️ SKIPPING layer ${scenarioId} - scenario not found in available scenarios`);
      continue;
    }

    // Probability resolver: current uses What-If, others use frozen params
    const probResolver = (e: Edge) => {
      // Helper: resolve the base (mean) probability for this edge (What-If aware for 'current').
      const resolveBaseMean = (): number => {
        if (scenarioId === 'current') {
          const edgeId = e.id || `${e.source}->${e.target}`;
          return computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL });
        }

        // For 'base' and scenario layers: ONLY use params (frozen snapshots)
        const flowEdgeUuid = (e.data as any)?.uuid;
        const graphEdge = graph.edges?.find((ge: any) =>
          ge.uuid === flowEdgeUuid || ge.id === e.id
        );

        if (graphEdge) {
          const key = graphEdge.id || graphEdge.uuid;
          // First try composed params, then fall back to graph edge's p.mean
          // This ensures edges not explicitly in params still render at their graph-defined probability
          let probability = composedParams.edges?.[key]?.p?.mean;

          if (typeof probability !== 'number') {
            // Fall back to graph edge's probability
            probability = graphEdge.p?.mean;
          }

          if (typeof probability !== 'number') {
            return 0;
          }

          // Apply case variant weight if this is a case edge
          if (graphEdge.case_variant) {
            let caseId = graphEdge.case_id;
            if (!caseId) {
              const sourceNode = graph.nodes?.find((n: any) =>
                n.uuid === graphEdge.from || n.id === graphEdge.from
              );
              if (sourceNode?.type === 'case') {
                caseId = sourceNode.case?.id || sourceNode.uuid || sourceNode.id;
              }
            }

            if (caseId) {
              const caseNodeKey = graph.nodes?.find((n: any) =>
                n.type === 'case' && (
                  n.case?.id === caseId ||
                  n.uuid === caseId ||
                  n.id === caseId
                )
              )?.id || caseId;

              const variants = composedParams.nodes?.[caseNodeKey]?.case?.variants;
              if (variants) {
                const variant = variants.find((v: any) => v.name === graphEdge.case_variant);
                const variantWeight = variant?.weight ?? 0;
                probability = probability * variantWeight;
              } else {
                const caseNode = graph.nodes?.find((n: any) =>
                  n.type === 'case' && (
                    n.case?.id === caseId ||
                    n.uuid === caseId ||
                    n.id === caseId
                  )
                );
                const variant = caseNode?.case?.variants?.find((v: any) =>
                  v.name === graphEdge.case_variant
                );
                const variantWeight = variant?.weight ?? 0;
                probability = probability * variantWeight;
              }
            }
          }

          return probability;
        }

        return 0;
      };

      // In E/F single-basis modes, geometry (widths/offsets/text path positioning) must be driven
      // by the same derived basis values we render on the edge lanes/beads.
      if (layerMode === 'e' || layerMode === 'f') {
        const flowEdgeUuid = (e.data as any)?.uuid;
        const graphEdge = graph.edges?.find((ge: any) =>
          ge.uuid === flowEdgeUuid || ge.id === e.id
        );
        const basisKey = graphEdge ? (graphEdge.id || graphEdge.uuid) : undefined;

        if (basisKey) {
          if (layerMode === 'e') {
            const b = efBasisMaps.evidence.get(basisKey);
            if (b?.groupHasAnyExplicit) return b.value;
          } else {
            const b = efBasisMaps.forecast.get(basisKey);
            if (b?.groupHasAnyExplicit) return b.value;
          }
        }

        // No explicit basis anywhere in the sibling group → fall back to mean behaviour.
        return resolveBaseMean();
      }

      if (scenarioId === 'current') {
        const edgeId = e.id || `${e.source}->${e.target}`;
        return computeEffectiveEdgeProbability(graph, edgeId, { whatIfDSL });
      }

      // For 'base' and scenario layers: ONLY use params (frozen snapshots)
      const flowEdgeUuid = (e.data as any)?.uuid;
      const graphEdge = graph.edges?.find((ge: any) => 
        ge.uuid === flowEdgeUuid || ge.id === e.id
      );

      if (graphEdge) {
        const key = graphEdge.id || graphEdge.uuid;
        // First try composed params, then fall back to graph edge's p.mean
        // This ensures edges not explicitly in params still render at their graph-defined probability
        let probability = composedParams.edges?.[key]?.p?.mean;

        if (typeof probability !== 'number') {
          // Fall back to graph edge's probability
          probability = graphEdge.p?.mean;
        }
        
        if (typeof probability !== 'number') {
          return 0;
        }

        // Apply case variant weight if this is a case edge
        if (graphEdge.case_variant) {
          let caseId = graphEdge.case_id;
          if (!caseId) {
            const sourceNode = graph.nodes?.find((n: any) => 
              n.uuid === graphEdge.from || n.id === graphEdge.from
            );
            if (sourceNode?.type === 'case') {
              caseId = sourceNode.case?.id || sourceNode.uuid || sourceNode.id;
            }
          }

          if (caseId) {
            const caseNodeKey = graph.nodes?.find((n: any) => 
              n.type === 'case' && (
                n.case?.id === caseId || 
                n.uuid === caseId || 
                n.id === caseId
              )
            )?.id || caseId;

            const variants = composedParams.nodes?.[caseNodeKey]?.case?.variants;
            if (variants) {
              const variant = variants.find((v: any) => v.name === graphEdge.case_variant);
              const variantWeight = variant?.weight ?? 0;
              probability = probability * variantWeight;
            } else {
              const caseNode = graph.nodes?.find((n: any) => 
                n.type === 'case' && (
                  n.case?.id === caseId || 
                  n.uuid === caseId || 
                  n.id === caseId
                )
              );
              const variant = caseNode?.case?.variants?.find((v: any) => 
                v.name === graphEdge.case_variant
              );
              const variantWeight = variant?.weight ?? 0;
              probability = probability * variantWeight;
            }
          }
        }

        return probability;
      }

      return 0;
    };

    const helpers = buildResidualHelpers(probResolver);

    // Precompute raw widths
    const rawWidths = new Map<string, number>();
    const sourceFaceBuckets: Record<string, Edge[]> = {};
    const targetFaceBuckets: Record<string, Edge[]> = {};
    baseEdges.forEach(edge => {
      const raw = computeOverlayWidthRaw(edge, probResolver, helpers, scenarioId);
      rawWidths.set(edge.id, raw);
      const sFace = (edge.sourceHandle || 'right-out').split('-')[0];
      const tFace = (edge.targetHandle || 'left').split('-')[0];
      const sKey = `source-${edge.source}-${sFace}`;
      const tKey = `target-${edge.target}-${tFace}`;
      (sourceFaceBuckets[sKey] ||= []).push(edge);
      (targetFaceBuckets[tKey] ||= []).push(edge);
    });

    // Sort and assign offsets
    const edgeSortKey = (sourceNode: any, targetNode: any, face: string, isSourceFace: boolean) => {
      // Simplified sort key (full logic from GraphCanvas if needed)
      return [0, 0];
    };

    Object.entries(sourceFaceBuckets).forEach(([key, faceEdges]) => {
      faceEdges.sort((a, b) => {
        const nodeA = nodes.find((n: any) => n.id === a.source);
        const nodeB = nodes.find((n: any) => n.id === b.source);
        const targetA = nodes.find((n: any) => n.id === a.target);
        const targetB = nodes.find((n: any) => n.id === b.target);
        const [sortA] = edgeSortKey(nodeA, targetA, key.split('-')[2], true);
        const [sortB] = edgeSortKey(nodeB, targetB, key.split('-')[2], true);
        return sortA - sortB;
      });
    });

    Object.entries(targetFaceBuckets).forEach(([key, faceEdges]) => {
      faceEdges.sort((a, b) => {
        const sourceA = nodes.find((n: any) => n.id === a.source);
        const sourceB = nodes.find((n: any) => n.id === b.source);
        const nodeA = nodes.find((n: any) => n.id === a.target);
        const nodeB = nodes.find((n: any) => n.id === b.target);
        const [sortA] = edgeSortKey(sourceA, nodeA, key.split('-')[2], false);
        const [sortB] = edgeSortKey(sourceB, nodeB, key.split('-')[2], false);
        return sortA - sortB;
      });
    });

    // Build draft overlay edges with raw widths
    const draftOverlayEdges = baseEdges.map(edge => {
      // Compute fresh width from probabilities
      const freshComputed = rawWidths.get(edge.id) || MIN_WIDTH;
      const mergedWidth = edge.data?.scaledWidth as number | undefined;
      
      // Use fresh computation
      const preScaled = freshComputed;
      
      const edgeProb = probResolver(edge);

      // Find graph edge for params lookup
      const flowEdgeUuid = (edge.data as any)?.uuid;
      const graphEdge = graph.edges?.find((ge: any) => 
        ge.uuid === flowEdgeUuid || ge.id === edge.id
      );
      const paramsKey = graphEdge ? (graphEdge.id || graphEdge.uuid) : undefined;
      const edgeParams = paramsKey ? composedParams.edges?.[paramsKey] : undefined;

      // LAG: derive EdgeLatencyDisplay for this layer from params + graph edge
      // This now includes ALL pre-computed rendering decisions (mode, widths, styling).
      let latencyDisplay: EdgeLatencyDisplay | undefined;
      if (graphEdge) {
        // Base probabilities from graph edge
        const baseP = graphEdge.p || {};
        const baseLatency = baseP.latency || {};

        // Scenario-level overrides from composed params (nested structure)
        const scenarioProb = edgeParams?.p || {};
        
        // DEBUG: Log LAG data sources for shipped-to-delivered edge
        if (scenarioId === 'current' && (graphEdge.id === 'shipped-to-delivered' || paramsKey === 'shipped-to-delivered')) {
          console.log('[LAG DEBUG] shipped-to-delivered:', {
            paramsKey,
            hasEdgeParams: !!edgeParams,
            scenarioProb,
            baseP,
            'scenarioProb.evidence': scenarioProb.evidence,
            'scenarioProb.latency': scenarioProb.latency,
            'baseP.evidence': baseP.evidence,
            'baseP.latency': baseP.latency,
          });
        }

        // Two-layer rendering: evidence vs forecast (explicit layer values with fallback chain)
        // DSL: e.X.p.evidence (scalar) or e.X.p.evidence.mean (nested)
        // Handle both scalar (p.evidence: 0.1) and nested (p.evidence.mean: 0.1) formats
        const p_evidence_explicit = typeof scenarioProb.evidence === 'number'
          ? scenarioProb.evidence
          : (typeof scenarioProb.evidence?.mean === 'number'
              ? scenarioProb.evidence.mean
              : (typeof baseP.evidence === 'number'
                  ? baseP.evidence
                  : (typeof baseP.evidence?.mean === 'number'
                      ? baseP.evidence.mean
                      : undefined)));

        const p_forecast_explicit = typeof scenarioProb.forecast === 'number'
          ? scenarioProb.forecast
          : (typeof scenarioProb.forecast?.mean === 'number'
              ? scenarioProb.forecast.mean
              : (typeof baseP.forecast === 'number'
                  ? baseP.forecast
                  : baseP.forecast?.mean));

        const p_mean = typeof scenarioProb.mean === 'number'
          ? scenarioProb.mean
          : baseP.mean;

        // Latency bead data: prefer scenario params, fall back to base edge
        // DSL: e.X.p.latency.median_lag_days, e.X.p.latency.completeness
        const median_days = typeof scenarioProb.latency?.median_lag_days === 'number'
          ? scenarioProb.latency.median_lag_days
          : baseLatency.median_lag_days;

        const completeness = typeof scenarioProb.latency?.completeness === 'number'
          ? scenarioProb.latency.completeness
          : baseLatency.completeness;

        // === Derived booleans ===
        const hasEvidenceExplicit = typeof p_evidence_explicit === 'number';
        const hasForecastExplicit = typeof p_forecast_explicit === 'number';
        const hasLatency = (typeof median_days === 'number' && median_days > 0) ||
                          (typeof baseLatency.t95 === 'number' && baseLatency.t95 > 0) ||
                          (typeof completeness === 'number');

        // IMPORTANT: For the unified rendering pipeline, we MUST populate EdgeLatencyDisplay
        // for every edge. This prevents "legacy" rendering branches from ever activating.
        //
        // The renderer then decides:
        // - Evidence present vs evidence=0 vs no evidence block (rebalanced)
        // - E/F/F+E modes
        // - Opacity/dashing rules
        //
        // === Get scenario visibility mode ===
        let mode: ScenarioVisibilityMode = 'f+e';
        if (getScenarioVisibilityMode) {
          try {
            mode = getScenarioVisibilityMode(scenarioId);
          } catch {
            mode = 'f+e';
          }
        }

        // === Apply sibling-derived basis ONLY in single-basis modes (E or F) ===
        // Default policy: do NOT introduce derived basis into F+E mode unless explicitly desired.
        const basisKey = paramsKey;
        const evidenceBasis = basisKey ? efBasisMaps.evidence.get(basisKey) : undefined;
        const forecastBasis = basisKey ? efBasisMaps.forecast.get(basisKey) : undefined;

        const useDerivedEvidence =
          mode === 'e' && !!evidenceBasis?.groupHasAnyExplicit && evidenceBasis.value !== undefined;
        const useDerivedForecast =
          mode === 'f' && !!forecastBasis?.groupHasAnyExplicit && forecastBasis.value !== undefined;

        const p_evidence = useDerivedEvidence ? evidenceBasis!.value : p_evidence_explicit;
        const p_forecast = useDerivedForecast ? forecastBasis!.value : p_forecast_explicit;

        const evidenceIsDerived = !!(useDerivedEvidence && evidenceBasis?.isDerived);
        const forecastIsDerived = !!(useDerivedForecast && forecastBasis?.isDerived);

        const hasEvidence = mode === 'e'
          ? (hasEvidenceExplicit || evidenceIsDerived)
          : hasEvidenceExplicit;

        // EvidenceIsZero must ONLY represent an explicit k=0/mean=0 evidence condition.
        // A derived value of 0 must NOT trigger the "k=0 hairline" behaviour.
        const evidenceIsZero = hasEvidenceExplicit && p_evidence_explicit === 0;

        const hasForecast = mode === 'f'
          ? (hasForecastExplicit || forecastIsDerived)
          : hasForecastExplicit;

        // === Compute widths ===
        // preScaled is the base stroke width for this edge (before offset/layout adjustments).
        // The renderer will ultimately scale against its own strokeWidth, but we still populate
        // reasonable defaults here to keep the model complete.
        const baseWidth = preScaled;
        let evidenceWidth = 0;
        let meanWidth = baseWidth;
        let evidenceRatio = 0;

        const hasCompletenessData = typeof completeness === 'number';

        if (mode === 'e') {
          // E-only mode:
          // Geometry (and thus baseWidth) is already driven by the E-basis via probResolver.
          // So the evidence lane should render at full base width when evidence exists (explicit or derived).
          // Only the explicit k=0 case renders as a hairline (evidenceWidth=0 + dashed styling).
          if (hasEvidence && p_evidence! > 0) {
            evidenceRatio = 1;
            evidenceWidth = baseWidth;
          } else if (!hasEvidence && (p_mean ?? 0) > 0) {
            // No evidence anywhere in the group: fall back to mean behaviour but keep the E-mode signalling.
            evidenceRatio = 1;
            evidenceWidth = baseWidth;
          } else {
            evidenceRatio = 0;
            evidenceWidth = 0;
          }
          meanWidth = baseWidth;
        } else if (mode === 'f') {
          // F-only mode:
          // Geometry (and thus baseWidth) is already driven by the F-basis via probResolver.
          // Do NOT apply a second p_forecast/p_mean scaling here; that creates "double scaling" and breaks offsets.
          meanWidth = baseWidth;
          evidenceWidth = 0;
        } else {
          // F+E mode: outer = mean/forecast, inner = evidence (0-width if evidence=0 or missing)
          if (hasEvidence && p_evidence! > 0 && (p_mean ?? 0) > 0) {
            evidenceRatio = Math.min(1, Math.max(0, p_evidence! / (p_mean || 1)));
            evidenceWidth = Math.max(0, baseWidth * evidenceRatio);
          } else {
            evidenceRatio = 0;
            evidenceWidth = 0;
          }
          meanWidth = baseWidth;
        }

        // === Compute styling flags ===
        // isDashed: edge has no mass (p.mean=0) OR in E mode with evidence.mean = 0
        const isDashed = edgeProb === 0 || (mode === 'e' && evidenceIsZero);

        // useNoEvidenceOpacity:
        // - legacy: no evidence block but p.mean > 0 in E mode
        // - new: derived evidence basis in E mode (still show faint to signal derivation)
        const useNoEvidenceOpacity =
          mode === 'e' && ((evidenceIsDerived) || (!hasEvidence && (p_mean ?? 0) > 0));

        // === Latency bead policy (based on query mode) ===
        const hasLocalLatency = typeof median_days === 'number' && median_days > 0;
        let showLatencyBead = false;
        let showCompletenessOnly = false;

        if (isCohortQuery) {
          showLatencyBead = hasCompletenessData;
          showCompletenessOnly = hasCompletenessData && !hasLocalLatency;
        } else {
          showLatencyBead = hasLocalLatency;
          showCompletenessOnly = false;
        }

        latencyDisplay = {
          enabled: true,
          // Raw data
          median_days,
          completeness_pct: hasCompletenessData ? completeness! * 100 : undefined,
          t95: baseLatency.t95,
          p_evidence,
          p_forecast,
          p_mean,
          // Derived booleans
          hasEvidence,
          evidenceIsZero,
          hasForecast,
          hasLatency,
          // Rendering mode
          mode,
          // Pre-computed widths
          evidenceWidth,
          meanWidth,
          evidenceRatio,
          // Styling flags
          isDashed,
          useNoEvidenceOpacity,
          // Latency bead policy
          showLatencyBead,
          showCompletenessOnly,
          // Derived basis flags (view-only)
          evidenceIsDerived: evidenceIsDerived,
          forecastIsDerived: forecastIsDerived
        };
        
        // DEBUG: Log final LAG decision for shipped-to-delivered
        if (scenarioId === 'current' && (graphEdge.id === 'shipped-to-delivered' || paramsKey === 'shipped-to-delivered')) {
          console.log('[LAG DEBUG] shipped-to-delivered FINAL:', {
            p_mean,
            p_evidence,
            p_forecast,
            median_days,
            completeness,
            latencyDisplay: latencyDisplay ? 'SET' : 'UNDEFINED'
          });
        }
      }

      // Opacity: hidden current at 5%, visible layers at dynamicLayerOpacity
      const HIDDEN_CURRENT_OPACITY = 0.05;
      const overlayOpacity = (scenarioId === 'current' && !visibleScenarioIds.includes('current')) 
        ? HIDDEN_CURRENT_OPACITY 
        : dynamicLayerOpacity;

      // STEP 2: Make 'current' edges fully interactive; others are visual-only
      const isCurrent = scenarioId === 'current';
      
      // STEP 4: Apply highlight metadata to 'current' layer only
      const isHighlighted = isCurrent && highlightMetadata ? highlightMetadata.highlightedEdgeIds.has(edge.id) : false;
      const highlightDepth = isCurrent && highlightMetadata ? (highlightMetadata.edgeDepthMap.get(edge.id) || 0) : 0;
      const isSingleNodeHighlight = isCurrent && highlightMetadata ? highlightMetadata.isSingleNodeSelection : false;
      
      return {
        ...edge,
        // For 'current': reuse base edge ID (preserves ReactFlow selection/interaction)
        // For others: use prefixed ID to avoid conflicts
        id: isCurrent ? edge.id : `scenario-overlay__${scenarioId}__${edge.id}`,
        // Only 'current' is selectable/editable
        selectable: isCurrent,
        reconnectable: isCurrent,  // Enable reconnection for 'current' only
        data: {
          ...edge.data,
          scenarioId,
          scenarioOverlay: !isCurrent,  // 'current' is NOT an overlay, it's the live layer
          scenarioColour: colour,
          strokeOpacity: overlayOpacity,
          originalEdgeId: edge.id,
          isPanningOrZooming: isPanningOrZooming,  // Pass through pan/zoom state
          // STEP 6: suppressConditionalColours removed (dead code, conditional colours handled by scenarioColour)
          suppressLabel: !isCurrent,  // Only 'current' shows labels
          scenarioParams: edgeParams,
          edgeLatencyDisplay: latencyDisplay,
          probability: edgeParams?.p?.mean ?? edge.data?.probability ?? 0.5,
          stdev: edgeParams?.p?.stdev ?? edge.data?.stdev,
          calculateWidth: () => preScaled,
          effectiveWeight: edgeProb,
          renderFallbackTargetArrow: preScaled < MIN_CHEVRON_THRESHOLD,
          // STEP 4: Apply highlight flags to 'current' edges
          isHighlighted,
          highlightDepth,
          isSingleNodeHighlight,
          // For 'current': preserve interaction handlers from base edge
          // For others: null them out
          onUpdate: isCurrent ? edge.data?.onUpdate : undefined,
          onDelete: isCurrent ? edge.data?.onDelete : undefined,
          onDoubleClick: isCurrent ? edge.data?.onDoubleClick : undefined,
          onSelect: isCurrent ? edge.data?.onSelect : undefined,
          onReconnect: isCurrent ? edge.data?.onReconnect : undefined,
        },
        style: {
          ...edge.style,
          stroke: colour,
          strokeOpacity: overlayOpacity,
          // 'current' is interactive; others are not
          pointerEvents: isCurrent ? 'auto' : 'none',
        },
        // Z-index based on layer order: higher layers have higher z-index
        // But all edges are behind labels/markers (which have z-index > 100)
        zIndex: layerIndex,
      };
    });

    // Compute offsets using the same logic as base
    const overlayWithOffsets = calculateEdgeOffsets(draftOverlayEdges, rfNodes, effectiveMaxWidth);

    // Attach offset data
    overlayWithOffsets.forEach(oe => {
      renderEdges.push({
        ...oe,
        data: {
          ...oe.data,
          sourceOffsetX: oe.sourceOffsetX,
          sourceOffsetY: oe.sourceOffsetY,
          targetOffsetX: oe.targetOffsetX,
          targetOffsetY: oe.targetOffsetY,
          isPanningOrZooming: isPanningOrZooming,  // Pass through pan/zoom state
          scaledWidth: oe.scaledWidth,
          sourceBundleWidth: oe.sourceBundleWidth,
          targetBundleWidth: oe.targetBundleWidth,
          sourceBundleSize: oe.sourceBundleSize,
          targetBundleSize: oe.targetBundleSize,
          isFirstInSourceBundle: oe.isFirstInSourceBundle,
          isLastInSourceBundle: oe.isLastInSourceBundle,
          isFirstInTargetBundle: oe.isFirstInTargetBundle,
          isLastInTargetBundle: oe.isLastInTargetBundle,
          sourceFace: oe.sourceFace,
          targetFace: oe.targetFace,
        },
      } as any);
    });
  }

  return renderEdges;
}

