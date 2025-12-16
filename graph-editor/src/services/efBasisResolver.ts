import type { Graph, GraphEdge } from '../types';

export type EFBasisMode = 'e' | 'f';

export interface EFBasisValueResult {
  /** Basis value to use for display in the requested mode. */
  value: number;
  /** True if this value was produced by residual allocation (i.e. not explicitly present on the edge). */
  isDerived: boolean;
  /** True if this value was explicitly present on the edge (in the authoritative layer data or fallback chain). */
  isExplicit: boolean;
  /** True if at least one sibling in the group had an explicit basis value (enables derivation). */
  groupHasAnyExplicit: boolean;
}

export interface EFBasisMaps {
  evidence: Map<string, EFBasisValueResult>;
  forecast: Map<string, EFBasisValueResult>;
}

const NO_LAYER_PARAMS_KEY: object = {};
const cacheByGraph: WeakMap<object, WeakMap<object, EFBasisMaps>> = new WeakMap();

function getEdgeKey(edge: any): string | undefined {
  return edge?.id || edge?.uuid || (edge?.from && edge?.to ? `${edge.from}->${edge.to}` : undefined);
}

function getEdgeKeyAliases(edge: any): string[] {
  const keys = new Set<string>();
  if (typeof edge?.id === 'string' && edge.id) keys.add(edge.id);
  if (typeof edge?.uuid === 'string' && edge.uuid) keys.add(edge.uuid);
  if (edge?.from && edge?.to) keys.add(`${edge.from}->${edge.to}`);
  return Array.from(keys);
}

function inferCaseIdIfNeeded(graph: Graph, edge: any): string | undefined {
  if (!edge?.case_variant) return undefined;
  if (edge?.case_id) return edge.case_id;
  const sourceNodeId = edge?.from;
  if (!sourceNodeId) return undefined;
  const sourceNode = graph.nodes?.find((n: any) => n.uuid === sourceNodeId || n.id === sourceNodeId);
  if (sourceNode?.type === 'case') {
    return sourceNode.case?.id || sourceNode.uuid || sourceNode.id;
  }
  return undefined;
}

function getSiblingGroupKey(graph: Graph, edge: any): string | undefined {
  const sourceNodeId = edge?.from;
  if (!sourceNodeId) return undefined;
  if (edge?.case_variant) {
    const caseId = inferCaseIdIfNeeded(graph, edge) || '';
    const caseVariant = edge.case_variant || '';
    return `${sourceNodeId}::case::${caseId}::${caseVariant}`;
  }
  // Regular (non-case) edges are grouped purely by source.
  // Also excludes case edges from regular groups by construction.
  return `${sourceNodeId}::regular`;
}

function extractPMean(layerP: any, fallbackP: any): number {
  const mean = typeof layerP?.mean === 'number' ? layerP.mean : (typeof fallbackP?.mean === 'number' ? fallbackP.mean : 0);
  return typeof mean === 'number' && Number.isFinite(mean) ? mean : 0;
}

function extractEvidenceMean(layerP: any, fallbackP: any): number | undefined {
  // Scalar
  if (typeof layerP?.evidence === 'number') return layerP.evidence;
  // Object
  if (typeof layerP?.evidence?.mean === 'number') return layerP.evidence.mean;
  // Counts
  if (typeof layerP?.evidence?.n === 'number' && typeof layerP?.evidence?.k === 'number' && layerP.evidence.n > 0) {
    return layerP.evidence.k / layerP.evidence.n;
  }
  // Fallbacks
  if (typeof fallbackP?.evidence === 'number') return fallbackP.evidence;
  if (typeof fallbackP?.evidence?.mean === 'number') return fallbackP.evidence.mean;
  if (typeof fallbackP?.evidence?.n === 'number' && typeof fallbackP?.evidence?.k === 'number' && fallbackP.evidence.n > 0) {
    return fallbackP.evidence.k / fallbackP.evidence.n;
  }
  return undefined;
}

function extractForecastMean(layerP: any, fallbackP: any): number | undefined {
  // Scalar
  if (typeof layerP?.forecast === 'number') return layerP.forecast;
  // Object
  if (typeof layerP?.forecast?.mean === 'number') return layerP.forecast.mean;
  // Fallbacks
  if (typeof fallbackP?.forecast === 'number') return fallbackP.forecast;
  if (typeof fallbackP?.forecast?.mean === 'number') return fallbackP.forecast.mean;
  return undefined;
}

function allocateResidual(
  edges: Array<{ edgeKey: string; weight: number; explicitValue?: number }>,
  kind: 'evidence' | 'forecast'
): Map<string, EFBasisValueResult> {
  const results = new Map<string, EFBasisValueResult>();

  const explicitEdges = edges.filter(e => typeof e.explicitValue === 'number' && Number.isFinite(e.explicitValue));
  const groupHasAnyExplicit = explicitEdges.length > 0;

  if (!groupHasAnyExplicit) {
    // If nothing is explicit anywhere, do not fabricate values.
    // - Evidence: matches current semantics (only derive when some evidence exists).
    // - Forecast: forecasts only exist for window() edges with data; do not invent forecasts
    //   for groups where none exist. In F mode, such groups should fall back to existing display behaviour.
    edges.forEach(e => {
      results.set(e.edgeKey, {
        value: 0,
        isDerived: false,
        isExplicit: false,
        groupHasAnyExplicit: false,
      });
    });
    return results;
  }

  const S = explicitEdges.reduce((sum, e) => sum + Math.max(0, e.explicitValue as number), 0);
  const R = Math.max(0, 1 - S);

  const missing = edges.filter(e => typeof e.explicitValue !== 'number' || !Number.isFinite(e.explicitValue));
  const missingWeightSum = missing.reduce((sum, e) => sum + Math.max(0, e.weight), 0);

  // First, set explicit values.
  edges.forEach(e => {
    if (typeof e.explicitValue === 'number' && Number.isFinite(e.explicitValue)) {
      results.set(e.edgeKey, {
        value: e.explicitValue,
        isDerived: false,
        isExplicit: true,
        groupHasAnyExplicit: true,
      });
    }
  });

  // Then allocate residual to missing edges.
  if (missing.length > 0) {
    if (missingWeightSum > 0) {
      missing.forEach(e => {
        const alloc = R * (Math.max(0, e.weight) / missingWeightSum);
        results.set(e.edgeKey, {
          value: alloc,
          isDerived: true,
          isExplicit: false,
          groupHasAnyExplicit: true,
        });
      });
    } else {
      // Degenerate: all missing weights are zero → uniform allocation.
      const each = missing.length > 0 ? (R / missing.length) : 0;
      missing.forEach(e => {
        results.set(e.edgeKey, {
          value: each,
          isDerived: true,
          isExplicit: false,
          groupHasAnyExplicit: true,
        });
      });
    }
  }

  // Ensure every edge has an entry (should already, but be safe).
  edges.forEach(e => {
    if (!results.has(e.edgeKey)) {
      results.set(e.edgeKey, {
        value: 0,
        isDerived: true,
        isExplicit: false,
        groupHasAnyExplicit: true,
      });
    }
  });

  // NOTE: `kind` is currently unused but kept to make intent explicit and to allow
  // future divergence (e.g. different clamping policies for evidence vs forecast).
  void kind;

  return results;
}

/**
 * Compute derived E/F sibling basis values for a given layer.
 *
 * - Uses the graph topology to determine sibling groups (mirrors rebalancing grouping rules).
 * - Uses layer params (if present) as authoritative, with fallback to the graph edge `p`.
 * - Produces per-edge basis values and derived flags for both evidence and forecast.
 *
 * This is a view-layer projection: callers must not persist derived values.
 */
export function computeEFBasisForLayer(graph: Graph, layerParams: any | undefined | null): EFBasisMaps {
  const layerKey = (layerParams && typeof layerParams === 'object') ? layerParams : NO_LAYER_PARAMS_KEY;
  const graphKey = graph as unknown as object;

  const cachedByLayer = cacheByGraph.get(graphKey);
  if (cachedByLayer) {
    const cached = cachedByLayer.get(layerKey);
    if (cached) return cached;
  }

  // Group edges by sibling group key
  const groups = new Map<string, GraphEdge[]>();
  (graph.edges || []).forEach((e: any) => {
    const groupKey = getSiblingGroupKey(graph, e);
    if (!groupKey) return;
    (groups.get(groupKey) || groups.set(groupKey, []).get(groupKey)!).push(e);
  });

  const evidenceMap = new Map<string, EFBasisValueResult>();
  const forecastMap = new Map<string, EFBasisValueResult>();

  // For each sibling group, compute residual allocations.
  groups.forEach((groupEdges) => {
    const normalised = groupEdges.map((ge: any) => {
      const edgeKey = getEdgeKey(ge);
      if (!edgeKey) return null;

      // Layer params can be keyed by either human id or uuid depending on migration state.
      // Try id first (preferred), then uuid, then composite.
      const aliasKeys = getEdgeKeyAliases(ge);
      const layerP =
        aliasKeys.map(k => layerParams?.edges?.[k]?.p).find((p: any) => p !== undefined && p !== null);
      const fallbackP = ge?.p || {};

      const weight = extractPMean(layerP, fallbackP);
      const explicitEvidence = extractEvidenceMean(layerP, fallbackP);
      const explicitForecast = extractForecastMean(layerP, fallbackP);

      return {
        edgeKey,
        aliasKeys,
        weight,
        explicitEvidence,
        explicitForecast,
      };
    }).filter(Boolean) as Array<{ edgeKey: string; aliasKeys: string[]; weight: number; explicitEvidence?: number; explicitForecast?: number }>;

    const evidenceResults = allocateResidual(
      normalised.map(e => ({ edgeKey: e.edgeKey, weight: e.weight, explicitValue: e.explicitEvidence })),
      'evidence'
    );
    const forecastResults = allocateResidual(
      normalised.map(e => ({ edgeKey: e.edgeKey, weight: e.weight, explicitValue: e.explicitForecast })),
      'forecast'
    );

    // Store under both primary keys and aliases so callers can look up by id or uuid.
    evidenceResults.forEach((v, k) => {
      evidenceMap.set(k, v);
      const aliases = normalised.find(e => e.edgeKey === k)?.aliasKeys ?? [];
      aliases.forEach(a => evidenceMap.set(a, v));
    });
    forecastResults.forEach((v, k) => {
      forecastMap.set(k, v);
      const aliases = normalised.find(e => e.edgeKey === k)?.aliasKeys ?? [];
      aliases.forEach(a => forecastMap.set(a, v));
    });
  });

  const result: EFBasisMaps = { evidence: evidenceMap, forecast: forecastMap };

  const nextByLayer = cachedByLayer || new WeakMap<object, EFBasisMaps>();
  nextByLayer.set(layerKey, result);
  if (!cachedByLayer) {
    cacheByGraph.set(graphKey, nextByLayer);
  }

  return result;
}


