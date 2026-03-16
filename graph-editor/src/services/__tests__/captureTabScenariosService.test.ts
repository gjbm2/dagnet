import { describe, it, expect } from 'vitest';
import { captureTabScenariosToRecipe } from '../captureTabScenariosService';

const makeOperations = (
  visibleIds: string[],
  modes: Record<string, 'f+e' | 'f' | 'e'> = {},
  scenarioOrder?: string[],
) => ({
  getScenarioState: () => ({
    visibleScenarioIds: visibleIds,
    scenarioOrder: scenarioOrder || visibleIds.filter(id => id !== 'current' && id !== 'base'),
  }),
  getScenarioVisibilityMode: (_tabId: string, sid: string) => modes[sid] || ('f+e' as const),
});

const baseScenariosContext = {
  scenarios: [
    {
      id: 'sc-1',
      name: 'Google Channel',
      colour: '#EC4899',
      params: {},
      meta: { isLive: true, queryDSL: 'context(channel:google)', lastEffectiveDSL: 'window(-30d:).context(channel:google)' },
    },
    {
      id: 'sc-2',
      name: 'Static Snapshot',
      colour: '#F59E0B',
      params: {},
      meta: { isLive: false },
    },
  ],
  currentColour: '#3b82f6',
  baseColour: '#6b7280',
  baseDSL: 'window(-30d:)',
};

describe('captureTabScenariosToRecipe', () => {
  it('should capture effective_dsl for current scenario from currentDSL arg', () => {
    const result = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: 'window(-30d:).context(channel:all)',
      operations: makeOperations(['current']),
      scenariosContext: baseScenariosContext,
    });

    expect(result.scenarios).toHaveLength(1);
    const current = result.scenarios[0];
    expect(current.scenario_id).toBe('current');
    expect(current.effective_dsl).toBe('window(-30d:).context(channel:all)');
    expect(current.is_live).toBe(true);
    expect(current.name).toBe('Current');
    expect(current.colour).toBe('#3b82f6');
  });

  it('should capture effective_dsl for base scenario from baseDSL', () => {
    const result = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: 'window(-30d:)',
      operations: makeOperations(['base']),
      scenariosContext: baseScenariosContext,
    });

    expect(result.scenarios).toHaveLength(1);
    const base = result.scenarios[0];
    expect(base.scenario_id).toBe('base');
    expect(base.effective_dsl).toBe('window(-30d:)');
    expect(base.is_live).toBe(true);
    expect(base.colour).toBe('#6b7280');
  });

  it('should capture effective_dsl for live user scenario from lastEffectiveDSL', () => {
    const result = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: 'window(-30d:)',
      operations: makeOperations(['current', 'sc-1', 'base']),
      scenariosContext: baseScenariosContext,
    });

    expect(result.scenarios).toHaveLength(3);
    const sc1 = result.scenarios.find(s => s.scenario_id === 'sc-1');
    expect(sc1?.effective_dsl).toBe('window(-30d:).context(channel:google)');
    expect(sc1?.is_live).toBe(true);
    expect(sc1?.name).toBe('Google Channel');
    expect(sc1?.colour).toBe('#EC4899');
  });

  it('should capture static scenario without effective_dsl', () => {
    const result = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: 'window(-30d:)',
      operations: makeOperations(['sc-2']),
      scenariosContext: baseScenariosContext,
    });

    expect(result.scenarios).toHaveLength(1);
    const sc2 = result.scenarios[0];
    expect(sc2.scenario_id).toBe('sc-2');
    expect(sc2.effective_dsl).toBeUndefined();
    expect(sc2.is_live).toBe(false);
  });

  it('should capture visibility_mode per scenario', () => {
    const result = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: 'window(-30d:)',
      operations: makeOperations(['current', 'sc-1'], { current: 'f+e', 'sc-1': 'f' }),
      scenariosContext: baseScenariosContext,
    });

    const current = result.scenarios.find(s => s.scenario_id === 'current');
    const sc1 = result.scenarios.find(s => s.scenario_id === 'sc-1');
    expect(current?.visibility_mode).toBe('f+e');
    expect(sc1?.visibility_mode).toBe('f');
  });

  it('should capture what_if_dsl when provided', () => {
    const result = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: 'window(-30d:)',
      operations: makeOperations(['current']),
      scenariosContext: baseScenariosContext,
      whatIfDSL: 'case(my-case:treatment)',
    });

    expect(result.what_if_dsl).toBe('case(my-case:treatment)');
  });

  it('should omit what_if_dsl when empty or whitespace', () => {
    const result = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: 'window(-30d:)',
      operations: makeOperations(['current']),
      scenariosContext: baseScenariosContext,
      whatIfDSL: '   ',
    });

    expect(result.what_if_dsl).toBeUndefined();
  });

  it('should derive order from scenarioOrder reversed: base first, user items, current last', () => {
    // visibleIds = ['sc-1', 'current', 'base'], scenarioOrder defaults to ['sc-1']
    // deriveOrderedVisibleIds reverses scenarioOrder → ['sc-1'], pins base first, current last
    const result = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: 'window(-30d:)',
      operations: makeOperations(['sc-1', 'current', 'base']),
      scenariosContext: baseScenariosContext,
    });

    expect(result.scenarios).toHaveLength(3);
    expect(result.scenarios[0].scenario_id).toBe('base');
    expect(result.scenarios[1].scenario_id).toBe('sc-1');
    expect(result.scenarios[2].scenario_id).toBe('current');
  });

  it('should reverse scenarioOrder for multi-user-scenario ordering', () => {
    // visibleIds = ['sc-1', 'sc-2', 'current'], scenarioOrder defaults to ['sc-1', 'sc-2']
    // deriveOrderedVisibleIds reverses → ['sc-2', 'sc-1'], no base visible, current last
    const result = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: 'window(-30d:)',
      operations: makeOperations(['sc-1', 'sc-2', 'current']),
      scenariosContext: baseScenariosContext,
    });

    expect(result.scenarios).toHaveLength(3);
    expect(result.scenarios[0].scenario_id).toBe('sc-2');
    expect(result.scenarios[1].scenario_id).toBe('sc-1');
    expect(result.scenarios[2].scenario_id).toBe('current');
  });

  it('should only include visible scenarios', () => {
    const result = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: 'window(-30d:)',
      operations: makeOperations(['current', 'sc-1']),
      scenariosContext: baseScenariosContext,
    });

    expect(result.scenarios).toHaveLength(2);
    expect(result.scenarios.find(s => s.scenario_id === 'sc-2')).toBeUndefined();
  });

  it('should handle base-only visible (no current)', () => {
    const result = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: 'window(-30d:)',
      operations: makeOperations(['base']),
      scenariosContext: baseScenariosContext,
    });

    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0].scenario_id).toBe('base');
  });

  it('should fall back to queryDSL when lastEffectiveDSL is missing', () => {
    const ctx = {
      ...baseScenariosContext,
      scenarios: [
        { id: 'sc-fallback', name: 'Fallback', colour: '#aaa', meta: { isLive: true, queryDSL: 'context(channel:meta)' } },
      ],
    };

    const result = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: '',
      operations: makeOperations(['sc-fallback']),
      scenariosContext: ctx,
    });

    expect(result.scenarios[0].effective_dsl).toBe('context(channel:meta)');
  });
});
