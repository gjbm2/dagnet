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
 * Chart files wrap this with: parent, pinned_recompute_eligible, display.hide_current
 * Canvas analyses wrap this with: id, position, dimensions, live, view_mode, chart_kind, display
 * Share payloads wrap this with: graph_state, chart metadata, scenario display metadata
 */
export interface ChartRecipeCore {
  analysis: ChartRecipeAnalysis;
  scenarios?: ChartRecipeScenario[];
}
