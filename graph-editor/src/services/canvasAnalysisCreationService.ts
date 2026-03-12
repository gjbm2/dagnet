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

import type { CanvasAnalysis } from '../types';
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
  /** Display settings to persist (e.g. font_size, scale_with_canvas). */
  display?: Record<string, unknown>;
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
  return {
    id: crypto.randomUUID(),
    x: Math.round(position.x),
    y: Math.round(position.y),
    width: size.width,
    height: size.height,
    view_mode: payload.viewMode,
    chart_kind: payload.chartKind,
    live: true,
    analysis_type_overridden: payload.analysisTypeOverridden || undefined,
    recipe: payload.recipe,
    ...(payload.display ? { display: payload.display } : {}),
  } as CanvasAnalysis;
}
