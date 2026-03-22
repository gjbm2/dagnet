import type { GraphData, CanvasAnalysis, CanvasAnalysisMode, ContentItem } from '../types';
import type { ChartRecipeScenario } from '../types/chartRecipe';
import { computeRebaseDelta, augmentDSLWithConstraint, normalizeConstraintString } from '../lib/queryDSL';
import { getAnalysisTypeMeta } from '../components/panels/analysisTypes';

/** Strip legacy flat fields from a container after clone/mutation.
 *  These may linger in in-memory graphs that haven't been re-normalised. */
function stripLegacyContainerFields(analysis: any): void {
  delete analysis.recipe;
  delete analysis.mode;
  delete analysis.view_mode;
  delete analysis.chart_kind;
  delete analysis.title;
  delete analysis.display;
  delete analysis.chart_current_layer_dsl;
  delete analysis.analysis_type_overridden;
}

/**
 * Mutate a canvas analysis container (placement, content_items array).
 * For mutating individual content items, use mutateContentItem.
 */
export function mutateCanvasAnalysisGraph(
  graph: GraphData | null | undefined,
  analysisId: string,
  mutator: (analysis: CanvasAnalysis, nextGraph: GraphData) => void
): GraphData | null {
  if (!graph) return null;
  const nextGraph = structuredClone(graph) as GraphData;
  const analysis = nextGraph.canvasAnalyses?.find((a: any) => a.id === analysisId) as CanvasAnalysis | undefined;
  if (!analysis) return null;
  stripLegacyContainerFields(analysis);
  mutator(analysis, nextGraph);
  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
  return nextGraph;
}

/**
 * Mutate a specific content item within a canvas analysis.
 * Clones the graph, finds the analysis and content item, runs the mutator.
 */
export function mutateContentItem(
  graph: GraphData | null | undefined,
  analysisId: string,
  contentItemIndex: number,
  mutator: (ci: ContentItem, analysis: CanvasAnalysis) => void
): GraphData | null {
  if (!graph) return null;
  const nextGraph = structuredClone(graph) as GraphData;
  const analysis = nextGraph.canvasAnalyses?.find((a: any) => a.id === analysisId) as CanvasAnalysis | undefined;
  if (!analysis) return null;
  stripLegacyContainerFields(analysis);
  const ci = analysis.content_items[contentItemIndex];
  if (!ci) return null;
  mutator(ci, analysis);
  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
  return nextGraph;
}

/**
 * Get the human-readable title for an analysis type ID.
 * Uses the ANALYSIS_TYPES registry, with humanisation fallback for unknown types.
 */
export function humaniseAnalysisType(analysisTypeId: string): string {
  const meta = getAnalysisTypeMeta(analysisTypeId);
  return meta?.name || analysisTypeId.replace(/[_-]/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
}

/**
 * Change a content item's analysis type.
 * Sets analysis_type, title (from registry), analysis_type_overridden, and clears kind.
 * This is the ONE function all code paths must use when changing type.
 */
export function setContentItemAnalysisType(
  graph: GraphData | null | undefined,
  analysisId: string,
  contentItemIndex: number,
  analysisTypeId: string,
): GraphData | null {
  const title = humaniseAnalysisType(analysisTypeId);
  return mutateContentItem(graph, analysisId, contentItemIndex, (ci) => {
    ci.analysis_type = analysisTypeId;
    ci.title = title;
    ci.analysis_type_overridden = true;
    ci.kind = undefined;
  });
}

export function deleteCanvasAnalysisFromGraph(
  graph: GraphData | null | undefined,
  analysisId: string
): GraphData | null {
  if (!graph) return null;
  const nextGraph = structuredClone(graph) as GraphData;
  if (!nextGraph.canvasAnalyses) return null;
  nextGraph.canvasAnalyses = nextGraph.canvasAnalyses.filter((a: any) => a.id !== analysisId);
  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
  return nextGraph;
}

/**
 * The next mode in the cycle: Live → Custom → Fixed → Live.
 */
export function nextMode(mode: CanvasAnalysisMode): CanvasAnalysisMode {
  switch (mode) {
    case 'live': return 'custom';
    case 'custom': return 'fixed';
    case 'fixed': return 'live';
  }
}

/**
 * Advance a canvas analysis one step through the tristate cycle.
 * Mutates the analysis object in place (caller should pass a clone).
 *
 * Transitions:
 * - Live → Custom: takes captured scenarios (absolute DSLs from tab), rebases
 *   each to a delta DSL relative to currentDSL via computeRebaseDelta.
 * - Custom → Fixed: bakes each scenario's delta DSL into an absolute DSL
 *   via augmentDSLWithConstraint(currentDSL, delta).
 * - Fixed → Live: clears recipe scenarios and what_if_dsl.
 *
 * @param analysis - The analysis to mutate (must be a clone)
 * @param currentDSL - The live base DSL from the active tab
 * @param captured - Captured tab scenarios (only needed for Live→Custom)
 */
/**
 * Advance a content item one step through the tristate cycle.
 * Mutates the content item in place (caller should pass a clone via mutateContentItem).
 *
 * Transitions:
 * - Live → Custom: takes captured scenarios, rebases to deltas
 * - Custom → Fixed: bakes deltas into absolutes
 * - Fixed → Live: clears scenarios and what_if_dsl
 */
export function advanceMode(
  ci: ContentItem,
  currentDSL: string,
  captured: { scenarios: ChartRecipeScenario[]; what_if_dsl?: string } | null,
  currentColour?: string,
): void {
  switch (ci.mode) {
    case 'live': {
      if (!captured) return;
      const base = currentDSL || '';
      const rebasedScenarios = captured.scenarios.map((s) => {
        const absoluteDsl = s.effective_dsl || '';
        const delta = computeRebaseDelta(base, absoluteDsl);
        return { ...s, effective_dsl: delta || undefined, is_live: false };
      });
      const currentIdx = rebasedScenarios.findIndex((s) => s.scenario_id === 'current');
      if (currentIdx >= 0) {
        const orig = rebasedScenarios[currentIdx];
        const copy = { ...orig, scenario_id: 'no-overrides', name: 'No overrides' };
        rebasedScenarios.splice(currentIdx, 1, copy);
        rebasedScenarios.push(orig);
      }

      ci.mode = 'custom';
      ci.scenarios = rebasedScenarios;
      ci.what_if_dsl = captured.what_if_dsl;

      if (!ci.display) ci.display = {} as any;
      const hidden = Array.isArray((ci.display as any).hidden_scenarios)
        ? [...(ci.display as any).hidden_scenarios]
        : [];
      if (!hidden.includes('current')) hidden.push('current');
      (ci.display as any).hidden_scenarios = hidden;
      break;
    }

    case 'custom': {
      const base = currentDSL || '';
      const hiddenIds = new Set<string>(
        Array.isArray((ci.display as any)?.hidden_scenarios)
          ? (ci.display as any).hidden_scenarios
          : [],
      );
      const allScenarios = ci.scenarios || [];
      const visibleNonCurrent = allScenarios.filter(
        (s: ChartRecipeScenario) => s.scenario_id !== 'current' && !hiddenIds.has(s.scenario_id),
      );
      const currentScenario = allScenarios.find(
        (s: ChartRecipeScenario) => s.scenario_id === 'current',
      );
      const currentIsVisible = currentScenario && !hiddenIds.has('current');
      const scenariosToFixed = [...visibleNonCurrent];
      if (currentIsVisible) {
        const stamped = currentColour
          ? { ...currentScenario, colour: currentColour }
          : currentScenario;
        scenariosToFixed.push(stamped);
      }

      const bakedScenarios = scenariosToFixed.map((s: ChartRecipeScenario) => {
        const delta = s.effective_dsl || '';
        const absolute = delta
          ? augmentDSLWithConstraint(base, delta)
          : normalizeConstraintString(base);
        return { ...s, effective_dsl: absolute || undefined, is_live: false };
      });
      ci.mode = 'fixed';
      ci.scenarios = bakedScenarios;
      if (ci.display) {
        (ci.display as any).hidden_scenarios = undefined;
      }
      break;
    }

    case 'fixed': {
      ci.mode = 'live';
      ci.scenarios = undefined;
      ci.what_if_dsl = undefined;
      if (ci.display) {
        (ci.display as any).hidden_scenarios = undefined;
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Content item mutations
// ---------------------------------------------------------------------------

/**
 * Remove a content item from a canvas analysis by its ID.
 * Returns true if the analysis should be deleted (last item removed).
 */
export function removeContentItem(analysis: CanvasAnalysis, contentItemId: string): boolean {
  if (!analysis.content_items) return false;
  analysis.content_items = analysis.content_items.filter(ci => ci.id !== contentItemId);
  return analysis.content_items.length === 0;
}

/**
 * Add a content item to a canvas analysis.
 * When `preset` is provided, its fields are merged into the new item
 * (useful for drop-to-snap from hover preview tabs).
 * Returns the new content item.
 */
export function addContentItem(analysis: CanvasAnalysis, preset?: Partial<ContentItem>): ContentItem {
  if (!analysis.content_items) analysis.content_items = [];
  const newItem: ContentItem = {
    analysis_type: '',
    view_type: 'chart',
    mode: 'live' as const,
    ...preset,
    id: crypto.randomUUID(), // always generate a fresh ID regardless of preset
  };
  analysis.content_items.push(newItem);
  return newItem;
}

/**
 * Ensure all content items on an analysis have analytics_dsl populated.
 * Backfills from container-level recipe if missing (legacy migration).
 */
export function ensureContentItemDsl(analysis: CanvasAnalysis): void {
  if (!analysis.content_items) return;
  // Use the first content item's DSL as the canonical source for backfilling others
  const firstCi = analysis.content_items[0];
  const canonicalDsl = firstCi?.analytics_dsl;
  const canonicalLayerDsl = firstCi?.chart_current_layer_dsl;
  for (const ci of analysis.content_items) {
    if (!ci.analytics_dsl && canonicalDsl) ci.analytics_dsl = canonicalDsl;
    if (!ci.chart_current_layer_dsl && canonicalLayerDsl) ci.chart_current_layer_dsl = canonicalLayerDsl;
  }
}
