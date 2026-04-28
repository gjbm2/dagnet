/**
 * Bayes graph runtime helpers.
 *
 * Convention: fields prefixed with `_` (or `__`) on graph edges, edge.p, or
 * edge.p.latency are transport-only / diagnostic and must never reach disk.
 * They are attached on a request-graph copy at submission time and stripped
 * by the helpers below at every persistence boundary. New transport fields
 * should follow the same prefix convention so the rule stays self-evident.
 *
 * Concretely today:
 *   - `_bayes_evidence` / `_bayes_priors` (on edge) and `_posteriorSlices`
 *     (on edge.p) are request-only payload fields attached by
 *     `engorgeGraphEdges` for Bayes / CF submission snapshots.
 *   - `__parityEvidence` / `__parityComputedT95Days` (on edge.p.latency) are
 *     runtime-only parity diagnostics.
 */

const EDGE_RUNTIME_FIELDS = ['_bayes_evidence', '_bayes_priors'] as const;
const P_RUNTIME_FIELDS = ['_posteriorSlices'] as const;
const LATENCY_RUNTIME_FIELDS = ['__parityEvidence', '__parityComputedT95Days'] as const;

function stripFieldsInPlace(target: any, fields: readonly string[]): boolean {
  if (!target || typeof target !== 'object') return false;

  let modified = false;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(target, field)) {
      delete target[field];
      modified = true;
    }
  }
  return modified;
}

function stripPRuntimeFieldsInPlace(p: any): boolean {
  return stripFieldsInPlace(p, P_RUNTIME_FIELDS);
}

function stripLatencyRuntimeFieldsInPlace(latency: any): boolean {
  return stripFieldsInPlace(latency, LATENCY_RUNTIME_FIELDS);
}

export function stripBayesRuntimeFieldsFromGraphInPlace(graph: any): boolean {
  if (!graph || typeof graph !== 'object') return false;

  let modified = false;
  const edges = Array.isArray(graph.edges) ? graph.edges : [];

  for (const edge of edges) {
    if (!edge || typeof edge !== 'object') continue;

    modified = stripFieldsInPlace(edge, EDGE_RUNTIME_FIELDS) || modified;
    modified = stripPRuntimeFieldsInPlace(edge.p) || modified;
    modified = stripLatencyRuntimeFieldsInPlace(edge.p?.latency) || modified;

    if (Array.isArray(edge.conditional_p)) {
      for (const conditional of edge.conditional_p) {
        modified = stripPRuntimeFieldsInPlace(conditional?.p) || modified;
        modified = stripLatencyRuntimeFieldsInPlace(conditional?.p?.latency) || modified;
      }
    }
  }

  return modified;
}

export function cloneGraphWithoutBayesRuntimeFields<T>(graph: T): T {
  if (!graph || typeof graph !== 'object') return graph;
  const clone = structuredClone(graph);
  stripBayesRuntimeFieldsFromGraphInPlace(clone);
  return clone;
}

/**
 * Defence-in-depth strip for chart-file persisted state.
 *
 * Chart files persist a `recipe.scenarios` (and mirrored
 * `definition.recipe.scenarios`) array describing the scenarios shown in the
 * chart. The current schema (`ChartRecipeScenario`) carries metadata + params
 * only and never embeds a graph snapshot — but historic chart files written
 * before this hardening, future schema widenings, or accidental runtime
 * captures of an engorged graph could put one on disk. This walker runs the
 * shared graph-strip on any embedded graph it finds so request-only Bayes
 * fields cannot persist into a chart file (73e §8.3 Stage 1 / §8.2.1a).
 *
 * Returns true when at least one embedded graph was modified.
 */
export function stripBayesRuntimeFieldsFromChartInPlace(chartData: any): boolean {
  if (!chartData || typeof chartData !== 'object') return false;
  let modified = false;
  const visit = (scenarios: any) => {
    if (!Array.isArray(scenarios)) return;
    for (const sc of scenarios) {
      if (sc && typeof sc === 'object' && sc.graph && typeof sc.graph === 'object') {
        modified = stripBayesRuntimeFieldsFromGraphInPlace(sc.graph) || modified;
      }
    }
  };
  visit(chartData.recipe?.scenarios);
  visit(chartData.definition?.recipe?.scenarios);
  return modified;
}
