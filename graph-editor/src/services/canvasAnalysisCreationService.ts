/**
 * canvasAnalysisCreationService
 *
 * Single authoritative pathway for building a canvas analysis payload.
 * Used by ALL creation entry points:
 *   - analytics panel (drag chart/cards, pin-to-canvas, drag analysis type card)
 *   - element palette (click, drag)
 *   - Elements menu ("Add Analysis")
 *   - future context-menu creation
 *
 * The contract: callers provide whatever they know (DSL, type, result, etc.)
 * and this service fills in the rest consistently.
 * GraphCanvas insertion is then synchronous and insertion-only.
 */

import type { CanvasAnalysis, ContentItem } from '../types';
import type { ViewMode } from '../types/chartRecipe';

export interface CanvasAnalysisCreationPayload {
  recipe: {
    analysis: {
      analysis_type: string;
      analytics_dsl?: string;
      what_if_dsl?: string;
    };
  };
  viewMode: ViewMode;
  chartKind?: string;
  analysisResult?: any;
  analysisTypeOverridden: boolean;
  /** Container/content-item title (e.g. 'Lag Histogram'). */
  title?: string;
  /** Display settings to persist (e.g. font_size, scale_with_canvas). */
  display?: Record<string, unknown>;
  /**
   * Pre-built content items (e.g. one per tab from a hover preview).
   * When provided, buildCanvasAnalysisObject uses these instead of
   * creating a single content item from the flat fields.
   */
  contentItems?: Array<{
    analysis_type: string;
    view_type: ViewMode;
    kind?: string;
    title?: string;
    display?: Record<string, unknown>;
    analysis_type_overridden?: boolean;
    analytics_dsl?: string;
    chart_current_layer_dsl?: string;
  }>;
}

export interface BuildCanvasAnalysisPayloadArgs {
  analyticsDsl?: string;
  analysisType?: string;
  analysisTypeOverridden?: boolean;
  chartKind?: string;
  analysisResult?: any;
  viewMode?: ViewMode;
}

/**
 * Build a fully-resolved creation payload from whatever the caller knows.
 *
 * If `analysisType` is provided (from analytics panel selection or drag),
 * it is used as-is and marked overridden.
 * If absent, `analysisType` MUST have been pre-resolved by the caller
 * via resolveAnalysisType before calling this function.
 * This function does NOT call the backend -- it is synchronous and pure.
 */
export function buildCanvasAnalysisPayload(args: BuildCanvasAnalysisPayloadArgs): CanvasAnalysisCreationPayload {
  const analysisType = args.analysisType || '';
  const overridden = args.analysisTypeOverridden ?? !!args.analysisType;

  return {
    recipe: {
      analysis: {
        analysis_type: analysisType,
        analytics_dsl: args.analyticsDsl || undefined,
      },
    },
    viewMode: args.viewMode || 'chart',
    chartKind: args.chartKind || undefined,
    analysisResult: args.analysisResult || undefined,
    analysisTypeOverridden: overridden,
  };
}

/**
 * Build the CanvasAnalysis object to insert into the graph.
 * This is the final step before graph mutation -- fully resolved, no async.
 */
export function buildCanvasAnalysisObject(
  payload: CanvasAnalysisCreationPayload,
  position: { x: number; y: number },
  size: { width: number; height: number },
): CanvasAnalysis {
  // Build content items: use pre-built list if provided, otherwise single item from flat fields
  const analyticsDsl = payload.recipe.analysis.analytics_dsl;
  const contentItems: ContentItem[] = payload.contentItems
    ? payload.contentItems.map(ci => ({
        id: crypto.randomUUID(),
        analysis_type: ci.analysis_type,
        view_type: ci.view_type,
        kind: ci.kind,
        title: ci.title,
        display: ci.display as any,
        analysis_type_overridden: ci.analysis_type_overridden,
        analytics_dsl: ci.analytics_dsl || analyticsDsl,
        chart_current_layer_dsl: ci.chart_current_layer_dsl,
        mode: 'live' as const,
      }))
    : [{
        id: crypto.randomUUID(),
        analysis_type: payload.recipe.analysis.analysis_type || '',
        view_type: payload.viewMode,
        kind: payload.chartKind,
        title: payload.title,
        display: payload.display as any,
        analysis_type_overridden: payload.analysisTypeOverridden || undefined,
        analytics_dsl: analyticsDsl,
        mode: 'live' as const,
      }];

  return {
    id: crypto.randomUUID(),
    x: Math.round(position.x),
    y: Math.round(position.y),
    width: size.width,
    height: size.height,
    content_items: contentItems,
  };
}
