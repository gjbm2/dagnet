import { describe, it, expect } from 'vitest';
import {
  createConditionedForecastSupersessionState,
  createNoTrackConditionedForecastSupersessionState,
  resolveConditionedForecastScenarioId,
} from '../conditionedForecastSupersessionState';

describe('conditionedForecastSupersessionState', () => {
  it('tracks generations independently per scenario', () => {
    const state = createConditionedForecastSupersessionState();

    expect(state.nextGeneration('scenario-a')).toBe(1);
    expect(state.nextGeneration('scenario-a')).toBe(2);
    expect(state.nextGeneration('scenario-b')).toBe(1);
    expect(state.latestGeneration('scenario-a')).toBe(2);
    expect(state.latestGeneration('scenario-b')).toBe(1);
  });

  it('normalises empty scenario ids to current', () => {
    const state = createConditionedForecastSupersessionState();

    expect(state.nextGeneration(undefined)).toBe(1);
    expect(state.nextGeneration('')).toBe(2);
    expect(state.nextGeneration('   ')).toBe(3);
    expect(state.latestGeneration('current')).toBe(3);
  });

  it('supports no-track fallback state', () => {
    const state = createNoTrackConditionedForecastSupersessionState();
    expect(state.nextGeneration('scenario-a')).toBe(0);
    expect(state.latestGeneration('scenario-a')).toBe(0);
  });

  it('resolves scenario ids consistently', () => {
    expect(resolveConditionedForecastScenarioId('scenario-z')).toBe('scenario-z');
    expect(resolveConditionedForecastScenarioId('  scenario-z  ')).toBe('scenario-z');
    expect(resolveConditionedForecastScenarioId('')).toBe('current');
    expect(resolveConditionedForecastScenarioId(undefined)).toBe('current');
  });
});
