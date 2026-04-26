export interface ConditionedForecastSupersessionState {
  nextGeneration(scenarioId?: string | null): number;
  latestGeneration(scenarioId?: string | null): number;
}

const DEFAULT_SCENARIO_ID = 'current';

export function resolveConditionedForecastScenarioId(
  scenarioId?: string | null,
): string {
  const trimmed = typeof scenarioId === 'string' ? scenarioId.trim() : '';
  return trimmed.length > 0 ? trimmed : DEFAULT_SCENARIO_ID;
}

class MapBackedConditionedForecastSupersessionState
  implements ConditionedForecastSupersessionState
{
  private readonly generations = new Map<string, number>();

  nextGeneration(scenarioId?: string | null): number {
    const key = resolveConditionedForecastScenarioId(scenarioId);
    const next = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, next);
    return next;
  }

  latestGeneration(scenarioId?: string | null): number {
    const key = resolveConditionedForecastScenarioId(scenarioId);
    return this.generations.get(key) ?? 0;
  }
}

class NoTrackConditionedForecastSupersessionState
  implements ConditionedForecastSupersessionState
{
  nextGeneration(): number {
    return 0;
  }

  latestGeneration(): number {
    return 0;
  }
}

export function createConditionedForecastSupersessionState():
  ConditionedForecastSupersessionState {
  return new MapBackedConditionedForecastSupersessionState();
}

export function createNoTrackConditionedForecastSupersessionState():
  ConditionedForecastSupersessionState {
  return new NoTrackConditionedForecastSupersessionState();
}
