/**
 * Local Analysis Compute Service
 *
 * Provides instant FE-side computation for analysis types that can be
 * derived from in-memory graph data (node_info, edge_info).
 * These results render immediately; backend augmentation arrives later.
 */

import type { AnalysisResult, AnalysisResponse } from '../lib/graphComputeClient';
import type { ConversionGraph, GraphNode, GraphEdge } from '../types';
import { parseDSL } from '../lib/queryDSL';

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
  switch (analysisType) {
    case 'node_info':
      return { success: true, result: buildNodeInfoResult(graph, queryDsl) };
    case 'edge_info':
      return { success: true, result: buildEdgeInfoResult(graph, queryDsl) };
    default:
      return { success: false, error: { error_type: 'unsupported', message: `No local compute for ${analysisType}` } };
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

  // Basic identity
  data.push({ section: 'Identity', property: 'Label', value: node.label || node.id });
  data.push({ section: 'Identity', property: 'ID', value: node.id });
  data.push({ section: 'Identity', property: 'Type', value: node.type || 'normal' });

  if (node.absorbing) {
    data.push({ section: 'Identity', property: 'Absorbing', value: 'Yes' });
  }
  if (node.outcome_type) {
    data.push({ section: 'Identity', property: 'Outcome Type', value: node.outcome_type });
  }

  // Entry info
  if (node.entry) {
    if (node.entry.is_start) {
      data.push({ section: 'Entry', property: 'Start Node', value: 'Yes' });
    }
    if (node.entry.entry_weight !== undefined) {
      data.push({ section: 'Entry', property: 'Entry Weight', value: fmtNum(node.entry.entry_weight) });
    }
  }

  // Case node info
  if (node.type === 'case' && node.case) {
    data.push({ section: 'Case', property: 'Status', value: node.case.status });
    if (node.case.variants) {
      for (const v of node.case.variants) {
        data.push({
          section: 'Case',
          property: `Variant: ${v.name}`,
          value: fmtPct(v.weight),
          detail: v.description || undefined,
        });
      }
    }
  }

  // Outgoing edges
  const outEdges = graph.edges.filter(e => e.from === node.uuid || e.from === node.id);
  if (outEdges.length > 0) {
    for (const edge of outEdges) {
      const targetNode = graph.nodes.find(n => n.uuid === edge.to || n.id === edge.to);
      const targetLabel = targetNode?.label || targetNode?.id || edge.to;
      const prob = edge.p?.mean;
      data.push({
        section: 'Outgoing Edges',
        property: `→ ${targetLabel}`,
        value: prob !== undefined ? fmtPct(prob) : '—',
      });
    }
  }

  // Description
  if (node.description) {
    data.push({ section: 'Details', property: 'Description', value: node.description });
  }

  return {
    analysis_type: 'node_info',
    analysis_name: `Node: ${node.label || node.id}`,
    analysis_description: `Summary of node ${node.id}`,
    semantics: {
      dimensions: [
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

  // Identity
  if (edge.id) {
    data.push({ section: 'Identity', property: 'Edge ID', value: edge.id });
  }
  data.push({ section: 'Identity', property: 'From', value: fromLabel });
  data.push({ section: 'Identity', property: 'To', value: toLabel });

  // Case edge info
  if (edge.case_variant) {
    data.push({ section: 'Identity', property: 'Case Variant', value: edge.case_variant });
    if (fromNode?.type === 'case' && fromNode.case) {
      const variant = fromNode.case.variants?.find(v => v.name === edge.case_variant);
      if (variant) {
        data.push({ section: 'Identity', property: 'Case Weight', value: fmtPct(variant.weight) });
      }
    }
  }

  // Probability
  if (edge.p) {
    const prob = edge.p.mean;
    const stdev = edge.p.stdev;
    if (prob !== undefined) {
      data.push({
        section: 'Probability',
        property: 'Blended',
        value: stdev ? `${fmtPct(prob)} ± ${fmtPct(stdev)}` : fmtPct(prob),
      });
    }
    if (edge.p.n !== undefined && edge.p.n > 0) {
      data.push({ section: 'Probability', property: 'Forecast Population (n)', value: fmtNum(edge.p.n) });
    }

    // Evidence
    const ev = edge.p.evidence as any;
    if (ev) {
      if (ev.n !== undefined && ev.k !== undefined) {
        data.push({ section: 'Evidence', property: 'Observations', value: `n=${ev.n}, k=${ev.k}` });
        if (ev.n > 0) {
          data.push({ section: 'Evidence', property: 'Observed Rate', value: fmtPct(ev.k / ev.n) });
        }
      }
      if (ev.window_from && ev.window_to) {
        data.push({ section: 'Evidence', property: 'Window', value: `${fmtDate(ev.window_from)} — ${fmtDate(ev.window_to)}` });
      }
      if (ev.source) {
        data.push({ section: 'Evidence', property: 'Source', value: ev.source });
      }
    } else {
      data.push({ section: 'Evidence', property: 'Status', value: 'Rebalanced (no direct evidence)' });
    }

    // Forecast
    const forecast = edge.p.forecast;
    if (forecast && forecast.mean !== undefined) {
      data.push({
        section: 'Forecast',
        property: 'p∞',
        value: forecast.stdev ? `${fmtPct(forecast.mean)} ± ${fmtPct(forecast.stdev)}` : fmtPct(forecast.mean),
      });
    }

    // Latency
    const lat = edge.p.latency;
    if (lat && lat.latency_parameter) {
      if (lat.median_lag_days !== undefined) {
        data.push({ section: 'Latency', property: 'Median Lag', value: `${lat.median_lag_days.toFixed(1)}d` });
      }
      if (lat.t95 !== undefined) {
        data.push({ section: 'Latency', property: 't95', value: `${lat.t95.toFixed(1)}d` });
      }
      if (lat.completeness !== undefined) {
        data.push({ section: 'Latency', property: 'Completeness', value: fmtPct(lat.completeness) });
      }
      if (lat.anchor_node_id) {
        const anchorNode = graph.nodes.find(n => n.id === lat.anchor_node_id || n.uuid === lat.anchor_node_id);
        data.push({ section: 'Latency', property: 'Anchor', value: anchorNode?.label || lat.anchor_node_id });
      }
    }
  }

  // Conditional probabilities
  if (edge.conditional_p && edge.conditional_p.length > 0) {
    for (const cond of edge.conditional_p) {
      const condMean = cond.p.mean ?? 0;
      const condStdev = cond.p.stdev;
      data.push({
        section: `Condition: ${cond.condition}`,
        property: 'Probability',
        value: condStdev ? `${fmtPct(condMean)} ± ${fmtPct(condStdev)}` : fmtPct(condMean),
      });
      const condEv = cond.p.evidence;
      if (condEv && condEv.n !== undefined) {
        data.push({
          section: `Condition: ${cond.condition}`,
          property: 'Evidence',
          value: `n=${condEv.n}, k=${condEv.k ?? '?'}`,
        });
      }
    }
  }

  // Costs
  if (edge.cost_gbp?.mean) {
    data.push({ section: 'Costs', property: 'Cost (GBP)', value: `£${edge.cost_gbp.mean.toFixed(0)}` });
  }
  if (edge.labour_cost?.mean) {
    data.push({ section: 'Costs', property: 'Labour Cost', value: `${edge.labour_cost.mean.toFixed(1)}d` });
  }

  // Description
  if (edge.description) {
    data.push({ section: 'Details', property: 'Description', value: edge.description });
  }

  // Query
  if (edge.query) {
    data.push({ section: 'Details', property: 'Query', value: edge.query });
  }

  return {
    analysis_type: 'edge_info',
    analysis_name: `Edge: ${edgeLabel}`,
    analysis_description: `Summary of edge ${edge.id || edgeLabel}`,
    semantics: {
      dimensions: [
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
