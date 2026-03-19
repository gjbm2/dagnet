/**
 * analysisResultUtils — helpers for filtering / patching analysis results
 * before passing them to expression components (table, cards).
 */
import type { AnalysisResult } from './graphComputeClient';

/**
 * Returns a shallow-cloned result that:
 *  1. Filters `data` rows to only include visible scenarios
 *  2. Patches `dimension_values.scenario_id` with runtime metadata (name, colour, etc.)
 *
 * If the result has no scenario dimension, returns the original result unchanged.
 */
export function filterResultForScenarios(
  result: AnalysisResult | null | undefined,
  visibleScenarioIds: string[] | undefined,
  scenarioMetaById?: Record<string, { name?: string; colour?: string; visibility_mode?: string }>,
): AnalysisResult | null | undefined {
  if (!result) return result;
  const hasScenarioDim = result.semantics?.dimensions?.some(
    (d: any) => d.id === 'scenario_id' || d.type === 'scenario',
  );
  if (!hasScenarioDim && !scenarioMetaById) return result;

  let data = result.data;
  if (visibleScenarioIds && hasScenarioDim) {
    const visSet = new Set(visibleScenarioIds);
    data = data.filter((row: any) => visSet.has(String(row.scenario_id)));
  }

  let dimensionValues = result.dimension_values;
  if (scenarioMetaById) {
    const existing_scenario_id = dimensionValues?.scenario_id || {};
    const patched = { ...existing_scenario_id };
    for (const [id, meta] of Object.entries(scenarioMetaById)) {
      const existing = patched[id] as any;
      if (existing) {
        patched[id] = { ...existing, ...meta };
      } else {
        patched[id] = meta as any;
      }
    }
    dimensionValues = { ...(dimensionValues || {}), scenario_id: patched };
  }

  if (data === result.data && dimensionValues === result.dimension_values) return result;
  return { ...result, data, dimension_values: dimensionValues };
}
