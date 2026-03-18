import type { GraphData, CanvasAnalysis, CanvasAnalysisMode } from '../types';
import type { ChartRecipeScenario } from '../types/chartRecipe';
import { computeRebaseDelta, augmentDSLWithConstraint, normalizeConstraintString } from '../lib/queryDSL';

export function mutateCanvasAnalysisGraph(
  graph: GraphData | null | undefined,
  analysisId: string,
  mutator: (analysis: CanvasAnalysis, nextGraph: GraphData) => void
): GraphData | null {
  if (!graph) return null;
  const nextGraph = structuredClone(graph) as GraphData;
  const analysis = nextGraph.canvasAnalyses?.find((a: any) => a.id === analysisId) as CanvasAnalysis | undefined;
  if (!analysis) return null;
  mutator(analysis, nextGraph);
  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
  return nextGraph;
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
export function advanceMode(
  analysis: CanvasAnalysis,
  currentDSL: string,
  captured: { scenarios: ChartRecipeScenario[]; what_if_dsl?: string } | null,
  currentColour?: string,
): void {
  switch (analysis.mode) {
    case 'live': {
      if (!captured) return;
      const base = currentDSL || '';
      const rebasedScenarios = captured.scenarios.map((s) => {
        const absoluteDsl = s.effective_dsl || '';
        const delta = computeRebaseDelta(base, absoluteDsl);
        return { ...s, effective_dsl: delta || undefined, is_live: false };
      });
      // Promote 'current' to a visible "No overrides" copy (bucket B) and
      // keep the original as a hidden underlayer (bucket C, kind:'current').
      const currentIdx = rebasedScenarios.findIndex((s) => s.scenario_id === 'current');
      if (currentIdx >= 0) {
        const orig = rebasedScenarios[currentIdx];
        const copy = {
          ...orig,
          scenario_id: 'no-overrides',
          name: 'No overrides',
        };
        // Replace original with copy at the same position (bucket B).
        // Move original to end of list (bucket C — hidden underlayer).
        rebasedScenarios.splice(currentIdx, 1, copy);
        rebasedScenarios.push(orig);
      }

      analysis.mode = 'custom';
      analysis.recipe = {
        ...analysis.recipe,
        scenarios: rebasedScenarios,
        analysis: { ...analysis.recipe.analysis, what_if_dsl: captured.what_if_dsl },
      };

      // Hide the 'current' underlayer by default — it's the base reference
      // (bucket C). Users can unhide it to use as a comparison scenario.
      if (!analysis.display) analysis.display = {};
      const hidden = Array.isArray((analysis.display as any).hidden_scenarios)
        ? [...(analysis.display as any).hidden_scenarios]
        : [];
      if (!hidden.includes('current')) hidden.push('current');
      (analysis.display as any).hidden_scenarios = hidden;
      break;
    }

    case 'custom': {
      const base = currentDSL || '';
      const hiddenIds = new Set<string>(
        Array.isArray((analysis.display as any)?.hidden_scenarios)
          ? (analysis.display as any).hidden_scenarios
          : [],
      );
      // Only visible scenarios carry over into Fixed mode.
      // If 'current' is visible, include it (baked to absolute) as the last scenario.
      const allScenarios = analysis.recipe.scenarios || [];
      const visibleNonCurrent = allScenarios.filter(
        (s: ChartRecipeScenario) => s.scenario_id !== 'current' && !hiddenIds.has(s.scenario_id),
      );
      const currentScenario = allScenarios.find(
        (s: ChartRecipeScenario) => s.scenario_id === 'current',
      );
      const currentIsVisible = currentScenario && !hiddenIds.has('current');
      const scenariosToFixed = [...visibleNonCurrent];
      if (currentIsVisible) {
        // Stamp the live displayed colour so Fixed mode preserves it
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
      analysis.mode = 'fixed';
      analysis.recipe = { ...analysis.recipe, scenarios: bakedScenarios };
      // Clear hidden_scenarios — fixed mode has no hidden layers
      if (analysis.display) {
        (analysis.display as any).hidden_scenarios = undefined;
      }
      break;
    }

    case 'fixed': {
      analysis.mode = 'live';
      analysis.recipe = {
        ...analysis.recipe,
        scenarios: undefined,
        analysis: { ...analysis.recipe.analysis, what_if_dsl: undefined },
      };
      // Clear hidden_scenarios — no residual visibility state from custom/fixed
      if (analysis.display) {
        (analysis.display as any).hidden_scenarios = undefined;
      }
      break;
    }
  }
}
