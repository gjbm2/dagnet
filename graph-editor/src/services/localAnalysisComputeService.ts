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
import { resolveActiveModelVars, effectivePreference } from './modelVarsResolution';
import { logNormalCDF, toModelSpaceAgeDays } from './lagDistributionUtils';

// Analysis types that support local FE compute
const LOCAL_COMPUTE_TYPES = new Set(['node_info', 'edge_info', 'surprise_gauge']);

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
      case 'surprise_gauge':
        return { success: true, result: buildSurpriseGaugeResult(graph, queryDsl) };
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

    // Model vars source — show which source is currently promoted
    const pref = effectivePreference(edge.p.model_source_preference, graph.model_source_preference);
    const active = resolveActiveModelVars(edge.p.model_vars, pref);
    if (active) {
      const sourceLabel = active.source === 'analytic_be' ? 'Analytic (BE)' : active.source.charAt(0).toUpperCase() + active.source.slice(1);
      data.push({ tab: 'latency', section: 'Source', property: 'Active Source', value: sourceLabel });
      if (active.source_at) {
        data.push({ tab: 'latency', section: 'Source', property: 'Updated', value: active.source_at });
      }
      if (active.latency) {
        data.push({ tab: 'latency', section: 'Source', property: 'μ (log-normal)', value: active.latency.mu.toFixed(3) });
        data.push({ tab: 'latency', section: 'Source', property: 'σ (log-normal)', value: active.latency.sigma.toFixed(3) });
      }
      data.push({ tab: 'latency', section: 'Source', property: 'p (mean)', value: fmtPct(active.probability.mean) });
      if (active.probability.stdev > 0) {
        data.push({ tab: 'latency', section: 'Source', property: 'p (stdev)', value: fmtPct(active.probability.stdev) });
      }
      if (active.quality) {
        const gradeLabels = ['Cold Start', 'Weak', 'Mature', 'Full Bayesian'];
        const gradeLabel = gradeLabels[active.quality.evidence_grade] ?? `Grade ${active.quality.evidence_grade}`;
        const gateStr = active.quality.gate_passed ? '✓ passed' : '✗ failed';
        data.push({ tab: 'latency', section: 'Source', property: 'Quality', value: `${gradeLabel} (${gateStr})` });
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
      if (ev.scope_from && ev.scope_to) {
        data.push({ tab: 'evidence', section: 'Observations', property: 'Scope', value: `${fmtDate(ev.scope_from)} — ${fmtDate(ev.scope_to)}` });
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

  // ── Tab: Data Depth (always present — scores enriched at render time) ──
  buildEdgeDepthTab(data, edge);

  // ── Tab: Diagnostics (freshness) ──
  buildFreshnessRows(data, 'diagnostics', graph, edge);

  // Build metadata for custom card rendering
  const latencyCdf = buildLatencyCdfMeta(edge);
  const probPosterior = edge.p?.posterior as any;
  const latPosterior = (edge.p?.latency as any)?.posterior || null;

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
    metadata: {
      ...(latencyCdf ? { latency_cdf: latencyCdf } : {}),
      ...((probPosterior || latPosterior) ? {
        posteriors: {
          probability: probPosterior || null,
          latency: latPosterior,
          // Model tab: use bayesian model_vars t95, not promoted scalars
          ...(() => {
            const bayesMv = (edge.p?.model_vars as any[])?.find((mv: any) => mv.source === 'bayesian');
            return {
              t95: bayesMv?.latency?.t95,
              path_t95: bayesMv?.latency?.path_t95,
            };
          })(),
        },
      } : {}),
    },
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
    result.edge = { mu: edgeMu, sigma: edgeSigma, onset: edgeOnset, t95: lat.promoted_t95 ?? lat.t95 };
  }

  // Path-level CDF params (from Bayesian posterior path_* fields, or analytic path_mu/path_sigma)
  const pathMu = lat.posterior?.path_mu_mean ?? lat.path_mu;
  const pathSigma = lat.posterior?.path_sigma_mean ?? lat.path_sigma;
  const pathOnset = lat.posterior?.path_onset_delta_days ?? lat.path_onset_delta_days ?? edgeOnset;
  if (typeof pathMu === 'number' && typeof pathSigma === 'number' && pathSigma > 0) {
    result.path = { mu: pathMu, sigma: pathSigma, onset: pathOnset, t95: lat.promoted_path_t95 ?? lat.path_t95 };
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ────────────────────────────────────────────────────────────
// Edge depth tab builder (always present; scores enriched at render time)
// ────────────────────────────────────────────────────────────

function buildEdgeDepthTab(data: Record<string, any>[], edge: GraphEdge): void {
  const n = edge.p?.evidence?.n ?? 0;
  const k = edge.p?.evidence?.k;
  data.push({ tab: 'depth', section: 'Sample Size', property: 'n', value: n > 0 ? fmtNum(n) : '—' });
  if (k != null && n > 0) {
    data.push({ tab: 'depth', section: 'Sample Size', property: 'k', value: fmtNum(k) });
    data.push({ tab: 'depth', section: 'Sample Size', property: 'Observed Rate', value: fmtPct(k / n) });
  }
  // Coverage scores (f₁, f₂, f₃, composite) are appended at render time
  // by AnalysisChartContainer when DataDepthContext scores are available.
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
      section: 'Posterior',
      property: 'Status',
      value: 'No posterior available',
    });
    return;
  }

  // ── Forecast tab: rendered by BayesPosteriorCard via metadata ──
  // Emit a placeholder row so the tab appears in the tab bar.
  // Fitted time is shown in the card's convergence footer — no separate Metadata section needed.
  if (posterior || latPosterior) {
    data.push({ tab: 'forecast', section: '_', property: '_', value: '' });
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

// ── Surprise Gauge ─────────────────────────────────────────────────────

/**
 * Recompute completeness at min(asat, retrieved_at) so the gauge comparison
 * matches when the evidence was actually captured, not "now".
 *
 * The topo-pass stores completeness computed with queryDate=now. When evidence
 * is stale (retrieved_at < now), this overstates completeness relative to the
 * k/n the user actually has. We recompute using the CDF params already on the
 * latency object (mu, sigma, onset_delta_days) and the cohort scope dates.
 *
 * Falls back to the stored completeness when CDF params or retrieved_at are
 * absent (backward compatibility with graphs that predate these fields).
 */
function _computeCompletenessAtRetrievedAt(
  latencyObj: Record<string, any>,
  evidenceObj: Record<string, any>,
  retrievedAt: string | Date | undefined,
): number {
  const storedCompleteness: number =
    typeof latencyObj.completeness === 'number' && latencyObj.completeness > 0
      ? latencyObj.completeness
      : 1.0;

  // Use path-level CDF params when available (cohort queries use A→Y path
  // completeness, not edge-level X→Y). Path params include upstream latency
  // and produce significantly lower completeness for downstream edges.
  const pathMu = latencyObj.path_mu;
  const pathSigma = latencyObj.path_sigma;
  const hasPathParams = typeof pathMu === 'number' && typeof pathSigma === 'number';
  const mu = hasPathParams ? pathMu : latencyObj.mu;
  const sigma = hasPathParams ? pathSigma : latencyObj.sigma;
  const onset = (hasPathParams ? (latencyObj.path_onset_delta_days ?? latencyObj.onset_delta_days) : latencyObj.onset_delta_days) ?? 0;
  if (typeof mu !== 'number' || typeof sigma !== 'number' || !retrievedAt) {
    return storedCompleteness;
  }

  // Parse retrieved_at to a Date
  const refDate = _parseLooseDate(retrievedAt);
  if (!refDate) return storedCompleteness;

  // Use evidence scope_from/scope_to (on p.evidence) as the cohort date range.
  // Approximate via midpoint — the topo pass uses n-weighted average across
  // individual cohort dates, but we don't have per-date data here.
  const scopeFrom = evidenceObj?.scope_from;
  const scopeTo = evidenceObj?.scope_to;

  if (scopeFrom && scopeTo) {
    const fromD = _parseLooseDate(scopeFrom);
    const toD = _parseLooseDate(scopeTo);
    if (fromD && toD) {
      const midMs = (fromD.getTime() + toD.getTime()) / 2;
      const midDate = new Date(midMs);
      const ageDays = Math.max(0, (refDate.getTime() - midDate.getTime()) / 86400000);
      const ageModel = toModelSpaceAgeDays(onset, ageDays);
      const c = logNormalCDF(ageModel, mu, sigma);
      if (Number.isFinite(c) && c > 0) return c;
    }
  }

  // Fallback: stored completeness (computed at topo-pass time)
  return storedCompleteness;
}

function _parseLooseDate(s: string | Date | unknown): Date | null {
  // js-yaml parses YAML datetimes as Date objects
  if (s instanceof Date) return Number.isNaN(s.getTime()) ? null : s;
  if (typeof s !== 'string' || !s) return null;

  // Try UK format: d-MMM-yy or d-MMM-yyyy
  const ukMatch = s.match(/^(\d{1,2})-(\w{3})-(\d{2,4})$/);
  if (ukMatch) {
    const months: Record<string, number> = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
    };
    const mon = months[ukMatch[2]];
    if (mon !== undefined) {
      let yr = parseInt(ukMatch[3], 10);
      if (yr < 100) yr += 2000;
      return new Date(yr, mon, parseInt(ukMatch[1], 10));
    }
  }
  // Try ISO
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function _formatRetrievedAtForDisplay(retrievedAt: string | Date | unknown): string | undefined {
  if (!retrievedAt) return undefined;
  const d = _parseLooseDate(retrievedAt);
  if (!d) return undefined;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
}

/** Normal CDF approximation (Abramowitz & Stegun 26.2.17). */
function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return 0.5;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

/** Inverse normal CDF (Beasley-Springer-Moro approximation). */
function normalPpf(q: number): number {
  const clamped = Math.max(1e-8, Math.min(1 - 1e-8, q));
  const a = [0, -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [0, -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [0, -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [0, 7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let r: number, qq: number;
  if (clamped < pLow) {
    qq = Math.sqrt(-2 * Math.log(clamped));
    return (((((c[1]*qq+c[2])*qq+c[3])*qq+c[4])*qq+c[5])*qq+c[6]) /
           ((((d[1]*qq+d[2])*qq+d[3])*qq+d[4])*qq+1);
  } else if (clamped <= pHigh) {
    qq = clamped - 0.5;
    r = qq * qq;
    return (((((a[1]*r+a[2])*r+a[3])*r+a[4])*r+a[5])*r+a[6])*qq /
           (((((b[1]*r+b[2])*r+b[3])*r+b[4])*r+b[5])*r+1);
  } else {
    qq = Math.sqrt(-2 * Math.log(1 - clamped));
    return -(((((c[1]*qq+c[2])*qq+c[3])*qq+c[4])*qq+c[5])*qq+c[6]) /
            ((((d[1]*qq+d[2])*qq+d[3])*qq+d[4])*qq+1);
  }
}

function classifyZone(q: number): string {
  const tail = Math.abs(q - 0.5) * 2;
  if (tail < 0.60) return 'expected';
  if (tail < 0.80) return 'noteworthy';
  if (tail < 0.90) return 'unusual';
  if (tail < 0.98) return 'surprising';
  return 'alarming';
}

function buildSurpriseGaugeResult(graph: ConversionGraph, queryDsl: string): AnalysisResult {
  const parsed = parseDSL(queryDsl);
  const variables: any[] = [];
  let hint: string | undefined;
  let referenceSource = 'unknown';

  // Find edge
  const edge = (graph.edges || []).find((e: GraphEdge) => {
    const fromNode = (graph.nodes || []).find((n: GraphNode) => n.uuid === e.from || n.id === e.from);
    const toNode = (graph.nodes || []).find((n: GraphNode) => n.uuid === e.to || n.id === e.to);
    return (fromNode && (fromNode.id === parsed.from || fromNode.uuid === parsed.from)) &&
           (toNode && (toNode.id === parsed.to || toNode.uuid === parsed.to));
  });

  if (!edge) {
    return { analysis_type: 'surprise_gauge', analysis_name: 'Expectation Gauge', variables: [], error: 'Edge not found', semantics: { chart: { recommended: 'surprise_gauge' } }, data: [] } as any;
  }

  const p = edge.p || {} as any;
  const modelVars: any[] = p.model_vars || [];
  const posterior = p.posterior || {};

  // Doc 25 §3.1–3.2: Use resolveActiveModelVars to respect quality gate and
  // source preference hierarchy. The graph-level and edge-level preferences
  // determine which model_vars entry is the reference.
  // Doc 25 §2: After Phase 3 re-projection, p.posterior already carries the
  // correct slice for the active query (window/cohort/contexted). No need
  // for isCohortQuery branching — just read alpha/beta directly.
  const pref = effectivePreference(p.model_source_preference, (graph as any).model_source_preference);
  const refEntry = resolveActiveModelVars(modelVars, pref);
  if (refEntry) {
    referenceSource = refEntry.source;
    if (refEntry.source !== 'bayesian') {
      hint = 'Run Bayes model for better indicators';
    }
  }

  if (!refEntry) {
    return { analysis_type: 'surprise_gauge', analysis_name: 'Expectation Gauge', variables: [], error: 'No model vars available', semantics: { chart: { recommended: 'surprise_gauge' } }, data: [] } as any;
  }

  // Evidence (pure observation — never the blended f+e value). See §5.0.
  const evidence = p.evidence || {};
  const evidenceK: number | undefined = evidence.k;
  const evidenceN: number | undefined = evidence.n;

  // Observed latency from analytic entry (evidence-fitted, not promoted/blended)
  const obsEntry = modelVars.find((mv: any) => mv?.source === 'analytic_be')
    || modelVars.find((mv: any) => mv?.source === 'analytic');
  const obsLat: Record<string, any> = obsEntry?.latency || p.latency || {};

  // Completeness: recompute at min(asat, retrieved_at) so that the gauge
  // comparison matches the actual observation date, not "now".
  // The topo-pass completeness (p.latency.completeness) uses queryDate=now,
  // but evidence k/n is frozen at retrieved_at.
  const latencyObj = p.latency || {} as any;
  // Use source_retrieved_at: the original Amplitude API fetch timestamp, preserved
  // through aggregation cycles. Falls back to retrieved_at on data_source (original
  // param file entries), then evidence.retrieved_at.
  const dataSource = (p as any).data_source || {};
  const evidenceRetrievedAt: string | Date | undefined =
    dataSource.source_retrieved_at || dataSource.retrieved_at || (evidence as any)?.retrieved_at;
  const cW = _computeCompletenessAtRetrievedAt(latencyObj, evidence, evidenceRetrievedAt);

  // n_dates for mu/sigma sampling SE — derived from evidence scope dates on the edge
  let nDates = 1;
  const evWindowFrom = evidence.scope_from;
  const evWindowTo = evidence.scope_to;
  if (evWindowFrom && evWindowTo) {
    try {
      const parseUkDate = (s: string): Date | null => {
        // Parse "d-MMM-yy" or "d-MMM-yyyy" format
        const m = s.match(/^(\d{1,2})-(\w{3})-(\d{2,4})$/);
        if (!m) return null;
        const months: Record<string, number> = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
        const mon = months[m[2]];
        if (mon === undefined) return null;
        let yr = parseInt(m[3], 10);
        if (yr < 100) yr += 2000;
        return new Date(yr, mon, parseInt(m[1], 10));
      };
      const from = parseUkDate(evWindowFrom);
      const to = parseUkDate(evWindowTo);
      if (from && to) {
        nDates = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000) + 1);
      }
    } catch { /* leave nDates = 1 */ }
  }

  const refProb = refEntry.probability || {};
  const refLat: Record<string, any> = refEntry.latency || {};

  // Select reference alpha/beta from posterior.
  // Doc 25 §3.2: After re-projection (Phase 3), p.posterior.alpha/beta already
  // carry the correct slice for the active query context. Read directly.
  let alpha: number | null = null;
  let beta_param: number | null = null;

  if (posterior.alpha != null) {
    alpha = posterior.alpha;
    beta_param = posterior.beta;
  } else {
    // Fall back to MoM reconstruction from model_vars mean/stdev
    const refMean = refProb.mean;
    const refStd = refProb.stdev;
    if (typeof refMean === 'number' && typeof refStd === 'number' && refMean > 0 && refMean < 1 && refStd > 0) {
      const v = refStd * refStd;
      if (v < refMean * (1 - refMean)) {
        const common = refMean * (1 - refMean) / v - 1;
        alpha = refMean * common;
        beta_param = (1 - refMean) * common;
      }
    }
  }

  // --- p ---
  // Completeness-adjusted comparison: pure evidence k/n vs posterior Beta(α,β)
  // scaled by per-date completeness. See surprise-gauge-design.md §5.1.
  if (alpha !== null && beta_param !== null
      && typeof evidenceK === 'number' && typeof evidenceN === 'number' && evidenceN > 0) {
    const muP = alpha / (alpha + beta_param);
    const sigma2P = (alpha * beta_param) / ((alpha + beta_param) ** 2 * (alpha + beta_param + 1));
    const obsRate = evidenceK / evidenceN;

    const expected = muP * cW;
    const varPost = sigma2P * (cW ** 2);
    const varSamp = expected * (1 - expected) / evidenceN;
    const combinedSd = Math.sqrt(Math.max(1e-20, varPost + varSamp));

    const z = (obsRate - expected) / combinedSd;
    const quantile = normalCdf(z);
    variables.push({
      name: 'p', label: 'Conversion rate',
      quantile: Math.round(quantile * 1e6) / 1e6,
      sigma: Math.round(z * 1000) / 1000,
      observed: Math.round(obsRate * 1e6) / 1e6,
      expected: Math.round(expected * 1e6) / 1e6,
      expected_longrun: Math.round(muP * 1e6) / 1e6,
      posterior_sd: Math.round(Math.sqrt(sigma2P) * 1e6) / 1e6,
      combined_sd: Math.round(combinedSd * 1e6) / 1e6,
      completeness: Math.round(cW * 1e4) / 1e4,
      evidence_n: evidenceN,
      evidence_k: evidenceK,
      evidence_retrieved_at: _formatRetrievedAtForDisplay(evidenceRetrievedAt),
      zone: classifyZone(quantile),
      available: true,
    });
  } else {
    const reason = !(typeof evidenceN === 'number' && evidenceN > 0) ? 'No evidence (k/n)' : 'Missing posterior (alpha/beta)';
    variables.push({ name: 'p', label: 'Conversion rate', available: false, reason });
  }

  // --- mu ---
  // Combined-SD normal approximation: posterior SD + sampling SE. See §5.2.
  const refMu = refLat?.mu;
  const obsMu = obsLat?.mu;
  const latPosterior: Record<string, any> = (p.latency as any)?.posterior || {};
  const muSd = latPosterior.mu_sd || refLat?.mu_sd;
  const sigmaLag = refLat?.sigma || latencyObj.sigma;

  if (typeof refMu === 'number' && typeof obsMu === 'number' && typeof muSd === 'number' && muSd > 0) {
    // obs_se = sqrt(π/2) × σ_lag / sqrt(n_dates)
    let obsSe = 0;
    if (typeof sigmaLag === 'number' && sigmaLag > 0 && nDates > 0) {
      obsSe = Math.sqrt(Math.PI / 2) * sigmaLag / Math.sqrt(nDates);
    }
    const combinedSd = Math.sqrt(muSd ** 2 + obsSe ** 2);
    const z = (obsMu - refMu) / combinedSd;
    const quantile = normalCdf(z);
    const onset = posterior.onset_mean || refLat?.onset_delta_days || 0;
    variables.push({
      name: 'mu', label: 'Latency location (μ)',
      quantile: Math.round(quantile * 1e6) / 1e6,
      sigma: Math.round(z * 1000) / 1000,
      observed: Math.round(obsMu * 1e4) / 1e4,
      observed_days: Math.round((Math.exp(obsMu) + onset) * 10) / 10,
      expected: Math.round(refMu * 1e4) / 1e4,
      expected_days: Math.round((Math.exp(refMu) + onset) * 10) / 10,
      posterior_sd: Math.round(muSd * 1e4) / 1e4,
      combined_sd: Math.round(combinedSd * 1e4) / 1e4,
      n_dates: nDates,
      zone: classifyZone(quantile),
      available: true,
    });
  } else {
    variables.push({ name: 'mu', label: 'Latency location (μ)', available: false, reason: muSd ? 'Missing mu values' : 'No posterior SD for mu' });
  }

  // --- sigma ---
  // Combined-SD normal approximation with n_dates guard. See §5.2.
  const refSigma = refLat?.sigma;
  const obsSigma = obsLat?.sigma;
  const sigmaSd = latPosterior.sigma_sd || refLat?.sigma_sd;

  if (typeof refSigma === 'number' && typeof obsSigma === 'number' && typeof sigmaSd === 'number' && sigmaSd > 0 && nDates >= 30) {
    // sigma_se = σ_lag / sqrt(2 × n_dates)
    let obsSe = 0;
    if (typeof sigmaLag === 'number' && sigmaLag > 0 && nDates > 0) {
      obsSe = sigmaLag / Math.sqrt(2 * nDates);
    }
    const combinedSd = Math.sqrt(sigmaSd ** 2 + obsSe ** 2);
    const z = (obsSigma - refSigma) / combinedSd;
    const quantile = normalCdf(z);
    variables.push({
      name: 'sigma', label: 'Latency spread (σ)',
      quantile: Math.round(quantile * 1e6) / 1e6,
      sigma: Math.round(z * 1000) / 1000,
      observed: Math.round(obsSigma * 1e4) / 1e4,
      expected: Math.round(refSigma * 1e4) / 1e4,
      posterior_sd: Math.round(sigmaSd * 1e4) / 1e4,
      combined_sd: Math.round(combinedSd * 1e4) / 1e4,
      n_dates: nDates,
      zone: classifyZone(quantile),
      available: true,
    });
  } else if (nDates < 30 && typeof refSigma === 'number' && typeof obsSigma === 'number') {
    variables.push({ name: 'sigma', label: 'Latency spread (σ)', available: false, reason: `Insufficient dates (${nDates} < 30) for reliable sigma estimate` });
  } else {
    variables.push({ name: 'sigma', label: 'Latency spread (σ)', available: false, reason: sigmaSd ? 'Missing sigma values' : 'No posterior SD for sigma' });
  }

  // --- onset (Phase 2 placeholder) ---
  const onsetMean = latPosterior.onset_mean;
  const onsetSd = latPosterior.onset_sd;
  if (typeof onsetMean === 'number' && typeof onsetSd === 'number' && onsetSd > 0) {
    variables.push({
      name: 'onset', label: 'Onset (dead time)',
      available: false,
      reason: 'Phase 2: requires snapshot DB query for observed onset',
      expected: Math.round(onsetMean * 100) / 100,
      posterior_sd: Math.round(onsetSd * 100) / 100,
    });
  }

  return {
    analysis_type: 'surprise_gauge',
    analysis_name: 'Expectation Gauge',
    semantics: {
      chart: { recommended: 'surprise_gauge' },
      dimensions: [{ id: 'variable', name: 'Variable', type: 'categorical', role: 'primary' }],
      metrics: [{ id: 'quantile', name: 'Quantile', type: 'number', role: 'primary' }],
    },
    data: variables,
    variables,
    reference_source: referenceSource,
    hint,
    promoted_source: pref,
  } as any;
}

