/**
 * Local Analysis Compute Service
 *
 * Provides instant FE-side computation for analysis types that can be
 * derived from in-memory graph data (node_info, edge_info).
 * These results render immediately; backend augmentation arrives later.
 */

import type { AnalysisResult, AnalysisResponse } from '../lib/graphComputeClient';
import type { ConversionGraph, GraphNode, GraphEdge, ProbabilityPosterior, LatencyPosterior } from '../types';
import { parseDSL } from '../lib/queryDSL';
import { computeQualityTier, qualityTierLabel } from '../utils/bayesQualityTier';
import { formatRelativeTime, getFreshnessLevel } from '../utils/freshnessDisplay';

// Analysis types that support local FE compute
const LOCAL_COMPUTE_TYPES = new Set(['node_info', 'edge_info']);

/**
 * Whether the given analysis type can be computed locally (FE-side).
 */
export function hasLocalCompute(analysisType: string): boolean {
  return LOCAL_COMPUTE_TYPES.has(analysisType);
}

/**
 * Compute an AnalysisResult locally from a single graph (used by hover preview).
 */
export function computeLocalResult(
  graph: ConversionGraph,
  analysisType: string,
  queryDsl: string,
): AnalysisResponse {
  try {
    switch (analysisType) {
      case 'node_info':
        return { success: true, result: buildNodeInfoResult(graph, queryDsl) };
      case 'edge_info':
        return { success: true, result: buildEdgeInfoResult(graph, queryDsl) };
      default:
        return { success: false, error: { error_type: 'unsupported', message: `No local compute for ${analysisType}` } };
    }
  } catch (err) {
    console.error(`[localAnalysisCompute] ${analysisType} threw:`, err);
    return { success: false, error: { error_type: 'compute_error', message: String(err) } };
  }
}

export interface LocalScenario {
  scenario_id: string;
  name: string;
  colour: string;
  graph: ConversionGraph;
}

/**
 * Compute an AnalysisResult locally from multiple scenario graphs.
 * For single scenario, delegates to computeLocalResult.
 * For multiple scenarios, produces rows with a scenario_id dimension
 * so renderers can show per-scenario columns.
 */
export function computeLocalResultMultiScenario(
  scenarios: LocalScenario[],
  analysisType: string,
  queryDsl: string,
): AnalysisResponse {
  if (scenarios.length === 0) {
    return { success: false, error: { error_type: 'no_scenarios', message: 'No scenarios provided' } };
  }

  // Single scenario: just use the simple path
  if (scenarios.length === 1) {
    return computeLocalResult(scenarios[0].graph, analysisType, queryDsl);
  }

  // Multi-scenario: compute per-scenario results and merge
  const perScenario: Array<{ scenario: LocalScenario; result: AnalysisResult }> = [];
  for (const scenario of scenarios) {
    const response = computeLocalResult(scenario.graph, analysisType, queryDsl);
    if (response.success && response.result) {
      perScenario.push({ scenario, result: response.result });
    }
  }

  if (perScenario.length === 0) {
    return computeLocalResult(scenarios[0].graph, analysisType, queryDsl);
  }

  // Use first scenario's result as template for structure
  const template = perScenario[0].result;

  // Merge data: add scenario_id to each row
  const mergedData: Record<string, any>[] = [];
  for (const { scenario, result } of perScenario) {
    for (const row of result.data) {
      mergedData.push({ ...row, scenario_id: scenario.scenario_id });
    }
  }

  // Build dimension_values for scenarios
  const scenarioDimValues: Record<string, { name: string; colour?: string; order?: number }> = {};
  for (let i = 0; i < perScenario.length; i++) {
    const sc = perScenario[i].scenario;
    scenarioDimValues[sc.scenario_id] = {
      name: sc.name,
      colour: sc.colour,
      order: i,
    };
  }

  return {
    success: true,
    result: {
      ...template,
      data: mergedData,
      semantics: template.semantics ? {
        ...template.semantics,
        dimensions: [
          { id: 'scenario_id', name: 'Scenario', type: 'scenario', role: 'filter' },
          ...template.semantics.dimensions,
        ],
      } : undefined,
      dimension_values: {
        ...template.dimension_values,
        scenario_id: scenarioDimValues,
      },
    },
  };
}

/**
 * Merge backend augmentation into an existing local result.
 * Backend rows with new fields are merged; existing FE rows are kept as fallback.
 */
export function mergeBackendAugmentation(
  local: AnalysisResult,
  backend: AnalysisResult,
): AnalysisResult {
  // Backend result is authoritative for data rows if present
  const mergedData = backend.data.length > 0 ? backend.data : local.data;

  // Merge metrics: keep all local metrics, add any new backend metrics
  const localMetricIds = new Set((local.semantics?.metrics || []).map(m => m.id));
  const extraMetrics = (backend.semantics?.metrics || []).filter(m => !localMetricIds.has(m.id));

  return {
    ...local,
    data: mergedData,
    metadata: { ...local.metadata, ...backend.metadata, _augmented: true },
    semantics: local.semantics ? {
      ...local.semantics,
      metrics: [...local.semantics.metrics, ...extraMetrics],
    } : backend.semantics,
    dimension_values: {
      ...local.dimension_values,
      ...backend.dimension_values,
    },
  };
}

// ────────────────────────────────────────────────────────────
// node_info
// ────────────────────────────────────────────────────────────

function resolveNodeFromDsl(graph: ConversionGraph, dsl: string): GraphNode | undefined {
  const parsed = parseDSL(dsl);
  // Try all DSL node references: from, to, visited, visitedAny
  const ref = parsed.from || parsed.to || parsed.visited[0] || parsed.visitedAny[0];
  if (!ref) return undefined;
  return graph.nodes.find(n => n.id === ref || n.uuid === ref);
}

function buildNodeInfoResult(graph: ConversionGraph, dsl: string): AnalysisResult {
  const node = resolveNodeFromDsl(graph, dsl);
  if (!node) {
    return emptyResult('node_info', 'Node Info', 'Node not found in graph');
  }

  const data: Record<string, any>[] = [];

  // ── Tab: Overview (intrinsic node properties) ──
  data.push({ tab: 'overview', section: 'Identity', property: 'Label', value: node.label || node.id });
  data.push({ tab: 'overview', section: 'Identity', property: 'ID', value: node.id, link: { type: 'node', fileId: `node-${node.id}` } });
  data.push({ tab: 'overview', section: 'Identity', property: 'Type', value: node.type || 'normal' });

  if (node.absorbing) {
    data.push({ tab: 'overview', section: 'Identity', property: 'Absorbing', value: 'Yes' });
  }
  if (node.outcome_type) {
    data.push({ tab: 'overview', section: 'Identity', property: 'Outcome Type', value: node.outcome_type });
  }
  if (node.event_id) {
    data.push({ tab: 'overview', section: 'Identity', property: 'Event', value: node.event_id, link: { type: 'event', fileId: `event-${node.event_id}` } });
  }
  if (node.tags && node.tags.length > 0) {
    data.push({ tab: 'overview', section: 'Identity', property: 'Tags', value: node.tags.join(', ') });
  }

  // Entry info
  if (node.entry) {
    if (node.entry.is_start) {
      data.push({ tab: 'overview', section: 'Entry', property: 'Start Node', value: 'Yes' });
    }
    if (node.entry.entry_weight !== undefined) {
      data.push({ tab: 'overview', section: 'Entry', property: 'Entry Weight', value: fmtNum(node.entry.entry_weight) });
    }
  }

  // Details
  if (node.description) {
    data.push({ tab: 'overview', section: 'Details', property: 'Description', value: node.description });
  }
  if (node.url) {
    data.push({ tab: 'overview', section: 'Details', property: 'URL', value: node.url });
  }

  // ── Tab: Structure (relationships — cases, outgoing edges) ──
  if (node.type === 'case' && node.case) {
    data.push({ tab: 'structure', section: 'Case', property: 'Status', value: node.case.status });
    if (node.case.variants) {
      for (const v of node.case.variants) {
        data.push({
          tab: 'structure',
          section: 'Case',
          property: `Variant: ${v.name}`,
          value: fmtPct(v.weight),
          detail: v.description || undefined,
        });
      }
    }
  }

  const outEdges = graph.edges.filter(e => e.from === node.uuid || e.from === node.id);
  if (outEdges.length > 0) {
    for (const edge of outEdges) {
      const targetNode = graph.nodes.find(n => n.uuid === edge.to || n.id === edge.to);
      const targetLabel = targetNode?.label || targetNode?.id || edge.to;
      const prob = edge.p?.mean;
      data.push({
        tab: 'structure',
        section: 'Outgoing Edges',
        property: `→ ${targetLabel}`,
        value: prob !== undefined ? fmtPct(prob) : '—',
      });
    }
  }

  // ── Tab: Evidence (from outgoing edges) ──
  const outEdgesForEvidence = graph.edges.filter(e => e.from === node.uuid || e.from === node.id);
  if (outEdgesForEvidence.length > 0) {
    for (const oe of outEdgesForEvidence) {
      const target = graph.nodes.find(n => n.uuid === oe.to || n.id === oe.to);
      const targetLabel = target?.label || target?.id || oe.to;
      const ev = oe.p?.evidence as any;
      if (ev && ev.n !== undefined && ev.k !== undefined) {
        data.push({
          tab: 'evidence',
          section: `→ ${targetLabel}`,
          property: 'Counts',
          value: `n=${ev.n}, k=${ev.k}`,
        });
        if (ev.n > 0) {
          data.push({
            tab: 'evidence',
            section: `→ ${targetLabel}`,
            property: 'Observed Rate',
            value: fmtPct(ev.k / ev.n),
          });
        }
        if (ev.window_from && ev.window_to) {
          data.push({
            tab: 'evidence',
            section: `→ ${targetLabel}`,
            property: 'Window',
            value: `${fmtDate(ev.window_from)} — ${fmtDate(ev.window_to)}`,
          });
        }
        if (ev.source) {
          data.push({
            tab: 'evidence',
            section: `→ ${targetLabel}`,
            property: 'Source',
            value: ev.source,
          });
        }
      } else {
        data.push({
          tab: 'evidence',
          section: `→ ${targetLabel}`,
          property: 'Status',
          value: 'No direct evidence',
        });
      }
    }
  }

  // ── Tab: Diagnostics (freshness) ──
  buildFreshnessRows(data, 'diagnostics', graph);

  return {
    analysis_type: 'node_info',
    analysis_name: `Node: ${node.label || node.id}`,
    analysis_description: `Summary of node ${node.id}`,
    semantics: {
      dimensions: [
        { id: 'tab', name: 'Tab', type: 'categorical', role: 'tab' },
        { id: 'section', name: 'Section', type: 'categorical', role: 'primary' },
        { id: 'property', name: 'Property', type: 'categorical', role: 'secondary' },
      ],
      metrics: [
        { id: 'value', name: 'Value', type: 'text', role: 'primary' },
        { id: 'detail', name: 'Detail', type: 'text', role: 'secondary' },
      ],
      chart: { recommended: 'info' },
    },
    data,
  };
}

// ────────────────────────────────────────────────────────────
// edge_info
// ────────────────────────────────────────────────────────────

function resolveEdgeFromDsl(graph: ConversionGraph, dsl: string): GraphEdge | undefined {
  const parsed = parseDSL(dsl);
  const fromRef = parsed.from;
  const toRef = parsed.to;

  if (fromRef && toRef) {
    return graph.edges.find(e => {
      const fromNode = graph.nodes.find(n => n.uuid === e.from || n.id === e.from);
      const toNode = graph.nodes.find(n => n.uuid === e.to || n.id === e.to);
      return (fromNode && (fromNode.id === fromRef || fromNode.uuid === fromRef)) &&
             (toNode && (toNode.id === toRef || toNode.uuid === toRef));
    });
  }

  // Fallback: single edge reference by id
  if (fromRef) {
    return graph.edges.find(e => e.id === fromRef || e.uuid === fromRef);
  }
  return undefined;
}

function buildEdgeInfoResult(graph: ConversionGraph, dsl: string): AnalysisResult {
  const edge = resolveEdgeFromDsl(graph, dsl);
  if (!edge) {
    return emptyResult('edge_info', 'Edge Info', 'Edge not found in graph');
  }

  const fromNode = graph.nodes.find(n => n.uuid === edge.from || n.id === edge.from);
  const toNode = graph.nodes.find(n => n.uuid === edge.to || n.id === edge.to);
  const fromLabel = fromNode?.label || fromNode?.id || edge.from;
  const toLabel = toNode?.label || toNode?.id || edge.to;
  const edgeLabel = `${fromLabel} → ${toLabel}`;

  const data: Record<string, any>[] = [];

  // ── Tab: Overview (summary of edge) ──
  if (edge.id) {
    data.push({ tab: 'overview', section: 'Identity', property: 'Edge ID', value: edge.id });
  }
  data.push({ tab: 'overview', section: 'Identity', property: 'From', value: fromLabel });
  data.push({ tab: 'overview', section: 'Identity', property: 'To', value: toLabel });

  if (edge.case_variant) {
    data.push({ tab: 'overview', section: 'Identity', property: 'Case Variant', value: edge.case_variant });
    if (fromNode?.type === 'case' && fromNode.case) {
      const variant = fromNode.case.variants?.find(v => v.name === edge.case_variant);
      if (variant) {
        data.push({ tab: 'overview', section: 'Identity', property: 'Case Weight', value: fmtPct(variant.weight) });
      }
    }
  }

  if (edge.p) {
    const prob = edge.p.mean;
    const stdev = edge.p.stdev;
    if (prob !== undefined) {
      data.push({
        tab: 'overview',
        section: 'Probability',
        property: 'Blended',
        value: stdev ? `${fmtPct(prob)} ± ${fmtPct(stdev)}` : fmtPct(prob),
      });
    }
    if (edge.p.distribution && edge.p.distribution !== 'beta') {
      data.push({ tab: 'overview', section: 'Probability', property: 'Distribution', value: edge.p.distribution });
    }
    if (edge.p.n !== undefined && edge.p.n > 0) {
      data.push({ tab: 'overview', section: 'Probability', property: 'Forecast Population (n)', value: fmtNum(edge.p.n) });
    }

    // Forecast p∞
    const forecast = edge.p.forecast;
    if (forecast && forecast.mean !== undefined) {
      data.push({
        tab: 'overview',
        section: 'Forecast',
        property: 'p∞',
        value: forecast.stdev ? `${fmtPct(forecast.mean)} ± ${fmtPct(forecast.stdev)}` : fmtPct(forecast.mean),
      });
    }

    // Latency summary — on the latency tab (chart rendered by AnalysisInfoCard)
    const lat = edge.p.latency;
    if (lat && lat.latency_parameter) {
      if (lat.median_lag_days !== undefined) {
        data.push({ tab: 'latency', section: 'Edge', property: 'Median Lag', value: `${lat.median_lag_days.toFixed(1)}d` });
      }
      if (lat.t95 !== undefined) {
        data.push({ tab: 'latency', section: 'Edge', property: 't95', value: `${lat.t95.toFixed(1)}d` });
      }
      if (lat.onset_delta_days !== undefined) {
        data.push({ tab: 'latency', section: 'Edge', property: 'Onset', value: `${lat.onset_delta_days.toFixed(1)}d` });
      }
      if (lat.completeness !== undefined) {
        data.push({ tab: 'latency', section: 'Edge', property: 'Completeness', value: fmtPct(lat.completeness) });
      }
      if (lat.path_t95 !== undefined) {
        data.push({ tab: 'latency', section: 'Path', property: 'Path t95', value: `${lat.path_t95.toFixed(1)}d` });
      }
      if (lat.anchor_node_id) {
        const anchorNode = graph.nodes.find(n => n.id === lat.anchor_node_id || n.uuid === lat.anchor_node_id);
        data.push({ tab: 'latency', section: 'Path', property: 'Anchor', value: anchorNode?.label || lat.anchor_node_id });
      }
    }
  }

  // Costs
  if (edge.cost_gbp?.mean) {
    data.push({ tab: 'overview', section: 'Costs', property: 'Cost (GBP)', value: `£${edge.cost_gbp.mean.toFixed(0)}` });
  }
  if (edge.labour_cost?.mean) {
    data.push({ tab: 'overview', section: 'Costs', property: 'Labour Cost', value: `${edge.labour_cost.mean.toFixed(1)}d` });
  }

  // Conditional overrides count
  if (edge.conditional_p && edge.conditional_p.length > 0) {
    const count = edge.conditional_p.length;
    data.push({
      tab: 'overview',
      section: 'Probability',
      property: 'Conditions',
      value: `${count} override${count > 1 ? 's' : ''}`,
    });
  }

  if (edge.description) {
    data.push({ tab: 'overview', section: 'Details', property: 'Description', value: edge.description });
  }
  if (edge.query) {
    data.push({ tab: 'overview', section: 'Details', property: 'Query', value: edge.query });
  }
  if (edge.n_query) {
    data.push({ tab: 'overview', section: 'Details', property: 'n Query', value: edge.n_query });
  }
  const dataSourceType = (edge.p as any)?.data_source?.type || (edge.p as any)?.connection;
  if (dataSourceType) {
    data.push({ tab: 'overview', section: 'Details', property: 'Data Source', value: dataSourceType });
  }
  const paramId = edge.p?.id as string | undefined;
  if (paramId) {
    data.push({ tab: 'overview', section: 'Details', property: 'Parameter', value: paramId, link: { type: 'parameter', fileId: `parameter-${paramId}` } });
  }

  // ── Tab: Evidence (data provenance) ──
  if (edge.p) {
    const ev = edge.p.evidence as any;
    if (ev) {
      if (ev.n !== undefined && ev.k !== undefined) {
        data.push({ tab: 'evidence', section: 'Observations', property: 'Counts', value: `n=${ev.n}, k=${ev.k}` });
        if (ev.n > 0) {
          data.push({ tab: 'evidence', section: 'Observations', property: 'Observed Rate', value: fmtPct(ev.k / ev.n) });
        }
      }
      if (ev.window_from && ev.window_to) {
        data.push({ tab: 'evidence', section: 'Observations', property: 'Window', value: `${fmtDate(ev.window_from)} — ${fmtDate(ev.window_to)}` });
      }
      if (ev.source) {
        data.push({ tab: 'evidence', section: 'Observations', property: 'Source', value: ev.source });
      }
    } else {
      data.push({ tab: 'evidence', section: 'Observations', property: 'Status', value: 'Rebalanced (no direct evidence)' });
    }
  }

  // Conditional probabilities (in evidence tab — they are data-derived)
  if (edge.conditional_p && edge.conditional_p.length > 0) {
    for (const cond of edge.conditional_p) {
      const condMean = cond.p.mean ?? 0;
      const condStdev = cond.p.stdev;
      data.push({
        tab: 'evidence',
        section: `Condition: ${cond.condition}`,
        property: 'Probability',
        value: condStdev ? `${fmtPct(condMean)} ± ${fmtPct(condStdev)}` : fmtPct(condMean),
      });
      const condEv = cond.p.evidence;
      if (condEv && condEv.n !== undefined) {
        data.push({
          tab: 'evidence',
          section: `Condition: ${cond.condition}`,
          property: 'Evidence',
          value: `n=${condEv.n}, k=${condEv.k ?? '?'}`,
        });
      }
    }
  }

  // ── Tab: Forecast (Bayes quality) ──
  buildEdgeForecastTab(data, edge, graph);

  // ── Tab: Diagnostics (freshness) ──
  buildFreshnessRows(data, 'diagnostics', graph, edge);

  // Build latency CDF metadata for sparkline rendering
  const latencyCdf = buildLatencyCdfMeta(edge);

  return {
    analysis_type: 'edge_info',
    analysis_name: `Edge: ${edgeLabel}`,
    analysis_description: `Summary of edge ${edge.id || edgeLabel}`,
    semantics: {
      dimensions: [
        { id: 'tab', name: 'Tab', type: 'categorical', role: 'tab' },
        { id: 'section', name: 'Section', type: 'categorical', role: 'primary' },
        { id: 'property', name: 'Property', type: 'categorical', role: 'secondary' },
      ],
      metrics: [
        { id: 'value', name: 'Value', type: 'text', role: 'primary' },
        { id: 'detail', name: 'Detail', type: 'text', role: 'secondary' },
      ],
      chart: { recommended: 'info' },
    },
    data,
    ...(latencyCdf ? { metadata: { latency_cdf: latencyCdf } } : {}),
  };
}

function buildLatencyCdfMeta(edge: GraphEdge): Record<string, any> | null {
  const lat = edge.p?.latency as any;
  if (!lat) return null;

  const result: Record<string, any> = {};

  // Edge-level CDF params (from analytic LAG pass or Bayesian posterior)
  const edgeMu = lat.posterior?.mu_mean ?? lat.mu;
  const edgeSigma = lat.posterior?.sigma_mean ?? lat.sigma;
  const edgeOnset = lat.posterior?.onset_delta_days ?? lat.onset_delta_days ?? 0;
  if (typeof edgeMu === 'number' && typeof edgeSigma === 'number' && edgeSigma > 0) {
    result.edge = { mu: edgeMu, sigma: edgeSigma, onset: edgeOnset };
  }

  // Path-level CDF params (from Bayesian posterior path_* fields, or analytic path_mu/path_sigma)
  const pathMu = lat.posterior?.path_mu_mean ?? lat.path_mu;
  const pathSigma = lat.posterior?.path_sigma_mean ?? lat.path_sigma;
  const pathOnset = lat.posterior?.path_onset_delta_days ?? lat.path_delta ?? edgeOnset;
  if (typeof pathMu === 'number' && typeof pathSigma === 'number' && pathSigma > 0) {
    result.path = { mu: pathMu, sigma: pathSigma, onset: pathOnset };
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ────────────────────────────────────────────────────────────
// Edge forecast tab builder
// ────────────────────────────────────────────────────────────

function buildEdgeForecastTab(
  data: Record<string, any>[],
  edge: GraphEdge,
  graph: ConversionGraph,
): void {
  const posterior: ProbabilityPosterior | undefined = edge.p?.posterior as ProbabilityPosterior | undefined;
  const latPosterior: LatencyPosterior | undefined = (edge.p?.latency as any)?.posterior as LatencyPosterior | undefined;

  if (!posterior && !latPosterior) {
    data.push({
      tab: 'forecast',
      section: 'Bayesian Fit',
      property: 'Status',
      value: 'No posterior available — run Bayesian fit',
    });
    return;
  }

  // Probability posterior — all field accesses guarded (posterior may be partial/malformed)
  if (posterior) {
    const tier = computeQualityTier(posterior);
    data.push({ tab: 'forecast', section: 'Quality', property: 'Tier', value: qualityTierLabel(tier.tier) });
    data.push({ tab: 'forecast', section: 'Quality', property: 'Reason', value: tier.reason });

    if (posterior.hdi_level != null && posterior.hdi_lower != null && posterior.hdi_upper != null) {
      data.push({
        tab: 'forecast',
        section: 'Probability',
        property: `HDI ${fmtPct(posterior.hdi_level)}`,
        value: `${fmtPct(posterior.hdi_lower)} — ${fmtPct(posterior.hdi_upper)}`,
      });
    }

    if (posterior.evidence_grade != null) {
      data.push({ tab: 'forecast', section: 'Probability', property: 'Evidence Grade', value: `${posterior.evidence_grade}/3` });
    }
    if (posterior.prior_tier) {
      data.push({ tab: 'forecast', section: 'Probability', property: 'Prior Tier', value: posterior.prior_tier.replace(/_/g, ' ') });
    }

    if (posterior.rhat != null) {
      data.push({ tab: 'forecast', section: 'Convergence', property: 'rhat', value: posterior.rhat.toFixed(4) });
    }
    if (posterior.ess != null) {
      data.push({ tab: 'forecast', section: 'Convergence', property: 'ESS', value: fmtNum(Math.round(posterior.ess)) });
    }
    if (posterior.divergences != null && posterior.divergences > 0) {
      data.push({ tab: 'forecast', section: 'Convergence', property: 'Divergences', value: posterior.divergences.toString() });
    }

    if (posterior.surprise_z != null && Math.abs(posterior.surprise_z) > 2) {
      data.push({ tab: 'forecast', section: 'Anomaly', property: 'Surprise z', value: posterior.surprise_z.toFixed(1) });
    }

    if (posterior.provenance) {
      data.push({ tab: 'forecast', section: 'Metadata', property: 'Provenance', value: posterior.provenance });
    }
    if (posterior.fitted_at) {
      const relFit = formatRelativeTime(posterior.fitted_at);
      const fitLevel = getFreshnessLevel(posterior.fitted_at);
      data.push({
        tab: 'forecast', section: 'Metadata', property: 'Fitted',
        value: relFit ? `${relFit} (${posterior.fitted_at})` : posterior.fitted_at,
        freshness: fitLevel,
      });
    }
  }

  // Latency posterior — all field accesses guarded
  if (latPosterior) {
    const latTier = computeQualityTier(latPosterior);
    if (!posterior) {
      data.push({ tab: 'forecast', section: 'Quality', property: 'Tier (Latency)', value: qualityTierLabel(latTier.tier) });
    }
    if (latPosterior.hdi_level != null && latPosterior.hdi_t95_lower != null && latPosterior.hdi_t95_upper != null) {
      data.push({
        tab: 'forecast',
        section: 'Latency HDI',
        property: `t95 HDI ${fmtPct(latPosterior.hdi_level)}`,
        value: `${latPosterior.hdi_t95_lower.toFixed(1)}d — ${latPosterior.hdi_t95_upper.toFixed(1)}d`,
      });
    }
    if (latPosterior.rhat != null) {
      data.push({ tab: 'forecast', section: 'Latency HDI', property: 'rhat', value: latPosterior.rhat.toFixed(4) });
    }
    if (latPosterior.ess != null) {
      data.push({ tab: 'forecast', section: 'Latency HDI', property: 'ESS', value: fmtNum(Math.round(latPosterior.ess)) });
    }
  }
}

// ────────────────────────────────────────────────────────────
// Freshness rows
// ────────────────────────────────────────────────────────────

/**
 * Add freshness/staleness rows to the given tab.
 * For nodes: graph update time.
 * For edges: data fetch time + graph update time.
 */
function buildFreshnessRows(
  data: Record<string, any>[],
  tab: string,
  graph: ConversionGraph,
  edge?: GraphEdge,
): void {
  // Edge: data fetch time from evidence.retrieved_at
  if (edge) {
    const retrievedAt = (edge.p?.evidence as any)?.retrieved_at;
    if (retrievedAt) {
      const rel = formatRelativeTime(retrievedAt);
      if (rel) {
        data.push({
          tab, section: 'Freshness', property: 'Data fetched',
          value: rel, freshness: getFreshnessLevel(retrievedAt),
        });
      }
    }

    // Bayes fit time (compact — just show if present)
    const fittedAt = (edge.p?.posterior as any)?.fitted_at;
    if (fittedAt) {
      const relFit = formatRelativeTime(fittedAt);
      if (relFit) {
        data.push({
          tab, section: 'Freshness', property: 'Forecast fitted',
          value: relFit, freshness: getFreshnessLevel(fittedAt),
        });
      }
    }
  }

  // Graph update time
  const graphUpdated = (graph as any).metadata?.updated_at
    || (graph as any).metadata?.last_retrieve_all_slices_success_at_ms;
  if (graphUpdated) {
    const rel = formatRelativeTime(graphUpdated);
    if (rel) {
      data.push({
        tab, section: 'Freshness', property: 'Graph updated',
        value: rel, freshness: getFreshnessLevel(graphUpdated),
      });
    }
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function emptyResult(type: string, name: string, desc: string): AnalysisResult {
  return {
    analysis_type: type,
    analysis_name: name,
    analysis_description: desc,
    semantics: {
      dimensions: [{ id: 'property', name: 'Property', type: 'categorical', role: 'primary' }],
      metrics: [{ id: 'value', name: 'Value', type: 'text', role: 'primary' }],
      chart: { recommended: 'info' },
    },
    data: [{ property: 'Status', value: desc }],
  };
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function fmtNum(v: number): string {
  return Number.isInteger(v) ? v.toString() : v.toFixed(2);
}

function fmtDate(d: string | Date): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${date.getDate()}-${months[date.getMonth()]}-${date.getFullYear().toString().slice(-2)}`;
}

