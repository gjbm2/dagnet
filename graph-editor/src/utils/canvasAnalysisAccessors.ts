/**
 * canvasAnalysisAccessors — content item accessors and legacy migration.
 *
 * Content items are the unit of authority. The container (CanvasAnalysis)
 * owns only placement (x, y, width, height) and the tab list (content_items).
 *
 * normaliseCanvasAnalysis handles legacy graphs where flat fields lived on
 * the container. On load, it moves everything into content_items and strips
 * the container.
 */

import type { CanvasAnalysis, ContentItem, CanvasAnalysisDisplay } from '../types';
import type { ChartDefinition } from '../types/chartRecipe';
import type { AnalysisResult } from '../lib/graphComputeClient';
import { getAnalyticsDsl } from '../types/chartRecipe';
import { parseDSL } from '../lib/queryDSL';

/**
 * Get the first content item (default tab).
 * Content items are always populated after normalisation.
 */
export function getActiveContentItem(analysis: CanvasAnalysis): ContentItem {
  return analysis.content_items[0];
}

/**
 * Get all content items.
 */
export function getContentItems(analysis: CanvasAnalysis): ContentItem[] {
  return analysis.content_items;
}

/**
 * Get the analytics DSL from the first content item.
 */
export function getContainerDsl(analysis: CanvasAnalysis): string | undefined {
  return analysis.content_items[0]?.analytics_dsl;
}

/**
 * Build a ChartDefinition from a ContentItem.
 * Used by "Open as Tab" and share link construction.
 */
export function contentItemToChartDefinition(ci: ContentItem): ChartDefinition {
  return {
    title: ci.title,
    view_mode: ci.view_type,
    chart_kind: ci.kind,
    display: ci.display as Record<string, unknown> | undefined,
    recipe: {
      analysis: {
        analysis_type: ci.analysis_type,
        analytics_dsl: ci.analytics_dsl,
        what_if_dsl: ci.what_if_dsl,
      },
      scenarios: ci.scenarios,
    },
  };
}

/**
 * Normalise a CanvasAnalysis in-place on graph load.
 *
 * Migrates legacy flat fields (recipe, mode, view_mode, chart_kind, etc.)
 * from the container into content_items, then strips them from the container.
 *
 * After normalisation, the container has ONLY id, x, y, width, height, content_items.
 */
export function normaliseCanvasAnalysis(analysis: CanvasAnalysis): CanvasAnalysis {
  const legacy = analysis as any;

  // Step 1: ensure content_items exists
  if (!analysis.content_items || analysis.content_items.length === 0) {
    // Synthesise a single content item from legacy container flat fields
    analysis.content_items = [{
      id: `${analysis.id}-content-0`,
      analysis_type: legacy.recipe?.analysis?.analysis_type ?? '',
      view_type: legacy.view_mode ?? 'chart',
      kind: legacy.chart_kind,
      display: legacy.display,
      title: legacy.title,
      analysis_type_overridden: legacy.analysis_type_overridden,
      analytics_dsl: getAnalyticsDsl(legacy.recipe?.analysis),
      chart_current_layer_dsl: legacy.chart_current_layer_dsl,
      mode: legacy.mode ?? 'live',
      scenarios: legacy.recipe?.scenarios,
      what_if_dsl: legacy.recipe?.analysis?.what_if_dsl,
    }];
  }

  // Step 2: migrate per-item legacy fields and backfill defaults
  const containerDsl = getAnalyticsDsl(legacy.recipe?.analysis);
  const containerLayerDsl = legacy.chart_current_layer_dsl;
  for (let i = 0; i < analysis.content_items.length; i++) {
    const ci = analysis.content_items[i];
    const ciLegacy = ci as any;

    // Backfill DSL from container if missing
    if (!ci.analytics_dsl && containerDsl) ci.analytics_dsl = containerDsl;
    if (!ci.chart_current_layer_dsl && containerLayerDsl) ci.chart_current_layer_dsl = containerLayerDsl;

    // Migrate chart_kind / facet → kind
    const hadFacet = !!ciLegacy.facet;
    if (!ci.kind && (ciLegacy.chart_kind || ciLegacy.facet)) {
      ci.kind = ciLegacy.facet || ciLegacy.chart_kind;
    }
    if (hadFacet && ci.view_type === 'chart') {
      ci.view_type = 'cards';
    }
    delete ciLegacy.chart_kind;
    delete ciLegacy.facet;

    // Ensure mode is set (default live)
    if (!ci.mode) ci.mode = 'live';

    // Copy container scenarios to content_items[0] only (if not already set)
    if (i === 0 && !ci.scenarios && legacy.recipe?.scenarios) {
      ci.scenarios = legacy.recipe.scenarios;
      ci.what_if_dsl = ci.what_if_dsl ?? legacy.recipe?.analysis?.what_if_dsl;
    }
    if (i === 0 && legacy.mode && ci.mode === 'live') {
      ci.mode = legacy.mode;
    }
  }

  // Step 3: strip ALL legacy flat fields from container
  delete legacy.recipe;
  delete legacy.mode;
  delete legacy.view_mode;
  delete legacy.chart_kind;
  delete legacy.title;
  delete legacy.display;
  delete legacy.chart_current_layer_dsl;
  delete legacy.analysis_type_overridden;

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
  forecast: 'Model',
  latency: 'Latency',
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
    analysisType,
    analyticsDsl: dsl,
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
