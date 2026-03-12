/**
 * ChartRecipeCore — shared chart definition schema
 *
 * The core of a chart definition ("what to compute and how") is the same
 * regardless of where the chart lives:
 *   - In its own file (ChartFileDataV1)
 *   - Embedded in a graph (CanvasAnalysis)
 *   - Compressed in a share URL (SharePayloadV1)
 *
 * Each context wraps ChartRecipeCore with its own contextual metadata.
 * See: docs/current/project-canvas/3-canvas-analyses.md §2.2
 */

export type ViewMode = 'chart' | 'cards' | 'table';

export type ChartVisibilityMode = 'f+e' | 'f' | 'e';

export interface ChartRecipeScenario {
  scenario_id: string;
  effective_dsl?: string;
  name?: string;
  colour?: string;
  visibility_mode?: ChartVisibilityMode;
  is_live?: boolean;
}

export interface ChartRecipeAnalysis {
  analysis_type?: string;
  analytics_dsl?: string;
  /** @deprecated Use analytics_dsl. Kept for backward compatibility with existing chart files. */
  query_dsl?: string;
  what_if_dsl?: string;
}

/** Read the analytics DSL from a recipe analysis, preferring the canonical field. */
export function getAnalyticsDsl(analysis: ChartRecipeAnalysis | undefined): string | undefined {
  return analysis?.analytics_dsl ?? analysis?.query_dsl;
}

/**
 * Core chart recipe — shared across chart files, canvas analyses, and share payloads.
 *
 * Chart files wrap this with: parent, pinned_recompute_eligible
 * Canvas analyses wrap this with: id, position, dimensions, live
 * Share payloads wrap this with: graph_state, chart metadata
 */
export interface ChartRecipeCore {
  analysis: ChartRecipeAnalysis;
  scenarios?: ChartRecipeScenario[];
}

/**
 * ChartDefinition — the ONE schema for a chart.
 *
 * Contains everything needed to render a chart:
 *   - recipe: what to compute (analysis type, DSL, scenarios)
 *   - chart_kind, view_mode, display: how to render the result
 *   - title: human-readable name
 *
 * This is the canonical shape. Every surface uses it:
 *   - CanvasAnalysis extends it (adds: id, x, y, width, height, live)
 *   - Chart files embed it (adds: version, created_at, source, deps, payload)
 *   - Share payloads embed it (adds: graph_state)
 *   - AnalysisChartContainer reads from it
 *
 * When "Open as Tab" is clicked, the ChartDefinition is serialised verbatim
 * into the chart file. When the chart tab opens, it reads the same fields back.
 */
export interface ChartDefinition {
  title?: string;
  view_mode: ViewMode;
  /** User-pinned chart kind (undefined = auto-infer from result semantics) */
  chart_kind?: string;
  /** All display settings (orientation, bar width, grid, legend, labels, etc.) */
  display?: Record<string, unknown>;
  /** What to compute */
  recipe: ChartRecipeCore;
}

/**
 * Extract a ChartDefinition from any object that contains the relevant fields.
 * Works with CanvasAnalysis, chart file data, or any superset.
 */
/**
 * Derive which expression modes are available for a given analysis result.
 * Returns the subset of ViewMode values that can be meaningfully rendered.
 */
export function getAvailableExpressions(result: { semantics?: any; data?: any[] } | null | undefined): ViewMode[] {
  const modes: ViewMode[] = [];
  if (result?.semantics?.chart?.recommended) modes.push('chart');
  // Cards require a primary dimension — matches AnalysisResultCards' guard.
  if (result?.semantics?.dimensions?.some((d: any) => d.role === 'primary')) modes.push('cards');
  if (result?.data?.length) modes.push('table');
  return modes;
}

export function toChartDefinition(source: {
  title?: string;
  view_mode?: ViewMode;
  chart_kind?: string;
  display?: Record<string, unknown>;
  recipe?: ChartRecipeCore;
}): ChartDefinition {
  return {
    title: source.title,
    view_mode: source.view_mode || 'chart',
    chart_kind: source.chart_kind,
    display: source.display || {},
    recipe: source.recipe || { analysis: {} },
  };
}
