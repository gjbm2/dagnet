/**
 * canvasAnalysisAccessors — bridge between flat CanvasAnalysis fields and
 * the container/content-item model.
 *
 * During the migration period, CanvasAnalysis objects may have content_items
 * populated (new model) or only flat fields (legacy). These accessors
 * normalise both shapes so consumers always see content_items.
 *
 * See: docs/current/project-canvas/7-container-content-split.md
 */

import type { CanvasAnalysis, ContentItem, CanvasAnalysisDisplay } from '../types';
import type { AnalysisResult } from '../lib/graphComputeClient';
import { getAnalyticsDsl } from '../types/chartRecipe';
import { parseDSL } from '../lib/queryDSL';

/**
 * Get the active content item for a canvas analysis.
 *
 * If content_items is populated, returns the first item.
 * Otherwise, synthesises one from the flat fields (legacy migration).
 */
export function getActiveContentItem(analysis: CanvasAnalysis): ContentItem {
  if (analysis.content_items && analysis.content_items.length > 0) {
    return analysis.content_items[0];
  }
  // Legacy: synthesise from flat fields (including DSL migration)
  return {
    id: `${analysis.id}-content-0`,
    analysis_type: analysis.recipe?.analysis?.analysis_type ?? '',
    view_type: analysis.view_mode ?? 'chart',
    kind: analysis.chart_kind,
    display: analysis.display,
    title: analysis.title,
    analysis_type_overridden: analysis.analysis_type_overridden,
    analytics_dsl: getAnalyticsDsl(analysis.recipe?.analysis),
    chart_current_layer_dsl: analysis.chart_current_layer_dsl,
  };
}

/**
 * Get all content items for a canvas analysis.
 *
 * If content_items is populated, returns them.
 * Otherwise, synthesises a single item from flat fields.
 */
export function getContentItems(analysis: CanvasAnalysis): ContentItem[] {
  if (analysis.content_items && analysis.content_items.length > 0) {
    // Backfill DSL from container level if missing (legacy migration)
    const containerDsl = getAnalyticsDsl(analysis.recipe?.analysis);
    const containerLayerDsl = analysis.chart_current_layer_dsl;
    for (const ci of analysis.content_items) {
      if (!ci.analytics_dsl && containerDsl) ci.analytics_dsl = containerDsl;
      if (!ci.chart_current_layer_dsl && containerLayerDsl) ci.chart_current_layer_dsl = containerLayerDsl;
    }
    return analysis.content_items;
  }
  return [getActiveContentItem(analysis)];
}

/**
 * Get the analytics DSL from a canvas analysis's active content item.
 * Falls back to container-level recipe.analysis.analytics_dsl for legacy data.
 */
export function getContainerDsl(analysis: CanvasAnalysis): string | undefined {
  const active = getActiveContentItem(analysis);
  return active.analytics_dsl || getAnalyticsDsl(analysis.recipe?.analysis);
}

/**
 * Normalise a CanvasAnalysis in-place, ensuring content_items is populated.
 * Used during graph load/migration to upgrade legacy flat objects.
 *
 * Returns the same object (mutated) for convenience in map() chains.
 */
export function normaliseCanvasAnalysis(analysis: CanvasAnalysis): CanvasAnalysis {
  if (!analysis.content_items || analysis.content_items.length === 0) {
    analysis.content_items = [getActiveContentItem(analysis)];
  } else {
    // Backfill DSL onto content items that lack it (migration from container-level DSL)
    const containerDsl = getAnalyticsDsl(analysis.recipe?.analysis);
    const containerLayerDsl = analysis.chart_current_layer_dsl;
    for (const ci of analysis.content_items) {
      if (!ci.analytics_dsl && containerDsl) ci.analytics_dsl = containerDsl;
      if (!ci.chart_current_layer_dsl && containerLayerDsl) ci.chart_current_layer_dsl = containerLayerDsl;
    }
  }
  // Migrate legacy chart_kind / facet → kind on content items
  for (const ci of analysis.content_items) {
    const legacy = ci as any;
    const hadFacet = !!legacy.facet;
    if (!ci.kind && (legacy.chart_kind || legacy.facet)) {
      ci.kind = legacy.facet || legacy.chart_kind;
    }
    // Items that had a facet were card views, not chart views
    if (hadFacet && ci.view_type === 'chart') {
      ci.view_type = 'cards';
    }
    delete legacy.chart_kind;
    delete legacy.facet;
  }
  return analysis;
}

/**
 * Derive a human-readable subject label from a DSL string and graph nodes.
 *
 * Examples:
 *   "from(reg).to(del)"  + nodes → "Registration → Delegated"
 *   "node(reg)"          + nodes → "Registration"
 *   ""                   → undefined
 *
 * Node IDs are resolved to labels via `node.label || node.id`.
 */
export function deriveDslSubjectLabel(
  dsl: string | null | undefined,
  nodes: Array<{ id?: string; uuid?: string; label?: string }>,
): string | undefined {
  if (!dsl) return undefined;
  const parsed = parseDSL(dsl);

  const resolveLabel = (nodeId: string): string => {
    // Match on node.id (human-readable ID) or node.uuid
    const node = nodes.find(n => n.id === nodeId || n.uuid === nodeId);
    if (node) return node.label || node.id || nodeId;
    // Fallback: humanise the raw ID (replace hyphens/underscores with spaces, title-case)
    return nodeId.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  };

  if (parsed.from && parsed.to) {
    return `${resolveLabel(parsed.from)} → ${resolveLabel(parsed.to)}`;
  }
  if (parsed.from) {
    return resolveLabel(parsed.from);
  }
  // node(x) DSL — parseDSL doesn't have a 'node' extractor, check manually
  const nodeMatch = dsl.match(/node\(([^)]+)\)/);
  if (nodeMatch) {
    return resolveLabel(nodeMatch[1]);
  }
  return undefined;
}

// -------------------------------------------------------------------
// Tab / drag utilities — shared between CanvasAnalysisCard,
// CanvasAnalysisNode, and HoverAnalysisPreview.
// -------------------------------------------------------------------

/** Tab display names for content item facets. */
export const TAB_LABELS: Record<string, string> = {
  overview: 'Overview',
  structure: 'Structure',
  evidence: 'Evidence',
  forecast: 'Forecast',
  depth: 'Data Depth',
  diagnostics: 'Diagnostics',
};

/** Extract distinct tab IDs from a result's data rows (preserving order). */
export function extractTabIds(result: AnalysisResult | null): string[] {
  if (!result?.data) return [];
  const seen: string[] = [];
  for (const row of result.data) {
    if (row.tab && !seen.includes(row.tab)) seen.push(row.tab);
  }
  return seen;
}

export interface PinDragDataInput {
  analysisType: string;
  dsl: string;
  chartKind?: string;
  result: AnalysisResult | null;
  screenWidth: number;
  screenHeight: number;
  canvasZoom: number;
  baseFontSize: number;
  scaleContent: boolean;
  /** When set, pin only this single facet instead of all tabs. */
  singleFacet?: string;
  /** Human-readable title (e.g. 'Lag Histogram'). Falls back to analysisType if omitted. */
  title?: string;
}

/** Build the drag data payload dispatched when a card is pinned to canvas.
 *  Pure function — no DOM access. */
export function buildPinDragData(input: PinDragDataInput) {
  const { analysisType, dsl, chartKind, result, screenWidth, screenHeight, canvasZoom, baseFontSize, scaleContent, singleFacet, title } = input;
  const z = canvasZoom || 1;
  const display = {
    font_size: baseFontSize,
    scale_with_canvas: scaleContent,
  };

  const tabIds = extractTabIds(result);
  let contentItems: Array<{
    analysis_type: string;
    view_type: 'chart' | 'cards';
    kind?: string;
    title: string;
    display: typeof display;
    analysis_type_overridden: boolean;
    analytics_dsl?: string;
  }> | undefined;
  if (singleFacet) {
    contentItems = [{
      analysis_type: analysisType,
      view_type: 'cards' as const,
      kind: singleFacet,
      title: TAB_LABELS[singleFacet] || singleFacet,
      display,
      analysis_type_overridden: true,
      analytics_dsl: dsl,
    }];
  } else if (tabIds.length > 1) {
    contentItems = tabIds.map(tabId => ({
      analysis_type: analysisType,
      view_type: 'cards' as const,
      kind: tabId,
      title: TAB_LABELS[tabId] || tabId,
      display,
      analysis_type_overridden: true,
      analytics_dsl: dsl,
    }));
  }

  return {
    type: 'dagnet-drag' as const,
    objectType: 'canvas-analysis' as const,
    recipe: {
      analysis: {
        analysis_type: analysisType,
        analytics_dsl: dsl,
      },
    },
    viewMode: 'chart' as const,
    chartKind,
    title: title || analysisType,
    analysisTypeOverridden: true,
    analysisResult: result,
    drawWidth: screenWidth / z,
    drawHeight: screenHeight / z,
    display,
    contentItems,
  };
}
