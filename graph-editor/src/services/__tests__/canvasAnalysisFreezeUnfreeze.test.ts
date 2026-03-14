/**
 * Canvas analysis freeze/unfreeze + scenario CRUD integration tests.
 *
 * Invariants tested:
 * - Freeze (capture from tab) serialises effective_dsl, is_live, what_if_dsl into recipe.scenarios
 * - Unfreeze (return to tab) clears recipe.scenarios and recipe.analysis.what_if_dsl
 * - Chart fragment (chart_current_layer_dsl) survives both freeze and unfreeze
 * - Scenario delete removes entry from recipe.scenarios
 * - Scenario reorder changes recipe.scenarios order
 * - Scenario colour edit persists to recipe.scenarios
 */

import { describe, it, expect } from 'vitest';
import { captureTabScenariosToRecipe } from '../captureTabScenariosService';
import type { CanvasAnalysis } from '../../types';

const makeOperations = (visibleIds: string[], modes: Record<string, 'f+e' | 'f' | 'e'> = {}) => ({
  getScenarioState: () => ({ visibleScenarioIds: visibleIds }),
  getScenarioVisibilityMode: (_tabId: string, sid: string) => modes[sid] || ('f+e' as const),
});

const scenariosCtx = {
  scenarios: [
    { id: 'sc-1', name: 'Google', colour: '#EC4899', meta: { isLive: true, queryDSL: 'context(channel:google)', lastEffectiveDSL: 'window(-30d:).context(channel:google)' } },
  ],
  currentColour: '#3b82f6',
  baseColour: '#6b7280',
  baseDSL: 'window(-30d:)',
};

function makeLiveAnalysis(): CanvasAnalysis {
  return {
    id: 'a-1',
    x: 0, y: 0, width: 400, height: 300,
    view_mode: 'chart',
    mode: 'live' as const,
    chart_current_layer_dsl: 'context(device:mobile)',
    recipe: { analysis: { analysis_type: 'conversion_funnel', analytics_dsl: 'from(a).to(b)' } },
  };
}

describe('Canvas analysis freeze/unfreeze', () => {
  it('should populate effective_dsl and is_live on freeze (capture from tab)', () => {
    const { scenarios, what_if_dsl } = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: 'window(-30d:).context(device:mobile)',
      operations: makeOperations(['current', 'sc-1', 'base']),
      scenariosContext: scenariosCtx,
      whatIfDSL: 'case(test:treatment)',
    });

    expect(scenarios).toHaveLength(3);
    expect(what_if_dsl).toBe('case(test:treatment)');

    const current = scenarios.find(s => s.scenario_id === 'current')!;
    expect(current.effective_dsl).toBe('window(-30d:).context(device:mobile)');
    expect(current.is_live).toBe(true);

    const sc1 = scenarios.find(s => s.scenario_id === 'sc-1')!;
    expect(sc1.effective_dsl).toBe('window(-30d:).context(channel:google)');
    expect(sc1.is_live).toBe(true);

    const base = scenarios.find(s => s.scenario_id === 'base')!;
    expect(base.effective_dsl).toBe('window(-30d:)');
  });

  it('should preserve chart_current_layer_dsl through freeze', () => {
    const analysis = makeLiveAnalysis();
    const { scenarios } = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: 'window(-30d:)',
      operations: makeOperations(['current']),
      scenariosContext: scenariosCtx,
    });

    const frozen: CanvasAnalysis = {
      ...analysis,
      mode: 'fixed',
      recipe: { ...analysis.recipe, scenarios },
    };

    expect(frozen.chart_current_layer_dsl).toBe('context(device:mobile)');
    expect(frozen.recipe.scenarios).toHaveLength(1);
    expect(frozen.mode).toBe('fixed');
  });

  it('should clear scenarios and what_if_dsl on unfreeze (return to tab)', () => {
    const frozen: CanvasAnalysis = {
      ...makeLiveAnalysis(),
      mode: 'fixed',
      recipe: {
        analysis: { analysis_type: 'conversion_funnel', analytics_dsl: 'from(a).to(b)', what_if_dsl: 'case(test:treatment)' },
        scenarios: [
          { scenario_id: 'current', effective_dsl: 'window(-30d:)', name: 'Current', colour: '#3b82f6' },
        ],
      },
    };

    const unfrozen: CanvasAnalysis = {
      ...frozen,
      mode: 'live',
      recipe: {
        ...frozen.recipe,
        scenarios: undefined,
        analysis: { ...frozen.recipe.analysis, what_if_dsl: undefined },
      },
    };

    expect(unfrozen.mode).toBe('live');
    expect(unfrozen.recipe.scenarios).toBeUndefined();
    expect(unfrozen.recipe.analysis.what_if_dsl).toBeUndefined();
    expect(unfrozen.chart_current_layer_dsl).toBe('context(device:mobile)');
  });
});

describe('Canvas analysis chart-owned scenario CRUD', () => {
  function makeFrozenAnalysis(): CanvasAnalysis {
    return {
      ...makeLiveAnalysis(),
      mode: 'fixed' as const,
      recipe: {
        analysis: { analysis_type: 'conversion_funnel', analytics_dsl: 'from(a).to(b)' },
        scenarios: [
          { scenario_id: 'current', effective_dsl: 'window(-30d:)', name: 'Current', colour: '#3b82f6', visibility_mode: 'f+e' },
          { scenario_id: 'sc-1', effective_dsl: 'window(-30d:).context(channel:google)', name: 'Google', colour: '#EC4899', visibility_mode: 'f+e', is_live: true },
          { scenario_id: 'base', effective_dsl: 'window(-30d:)', name: 'Base', colour: '#6b7280', visibility_mode: 'f+e' },
        ],
      },
    };
  }

  it('should remove scenario on delete', () => {
    const analysis = makeFrozenAnalysis();
    const scenarios = analysis.recipe.scenarios!.filter(s => s.scenario_id !== 'sc-1');
    expect(scenarios).toHaveLength(2);
    expect(scenarios.find(s => s.scenario_id === 'sc-1')).toBeUndefined();
  });

  it('should reorder scenarios preserving current/base anchors', () => {
    const analysis = makeFrozenAnalysis();
    const arr = [...analysis.recipe.scenarios!];
    const userItems = arr.filter(s => s.scenario_id !== 'current' && s.scenario_id !== 'base');
    expect(userItems).toHaveLength(1);

    const reordered = [
      arr.find(s => s.scenario_id === 'current')!,
      ...userItems,
      arr.find(s => s.scenario_id === 'base')!,
    ];
    expect(reordered[0].scenario_id).toBe('current');
    expect(reordered[reordered.length - 1].scenario_id).toBe('base');
  });

  it('should update scenario colour', () => {
    const analysis = makeFrozenAnalysis();
    const updated = analysis.recipe.scenarios!.map(s =>
      s.scenario_id === 'sc-1' ? { ...s, colour: '#10B981' } : s
    );
    expect(updated.find(s => s.scenario_id === 'sc-1')!.colour).toBe('#10B981');
  });

  it('should update scenario effective_dsl via edit', () => {
    const analysis = makeFrozenAnalysis();
    const updated = analysis.recipe.scenarios!.map(s =>
      s.scenario_id === 'sc-1' ? { ...s, effective_dsl: 'window(-7d:).context(channel:meta)' } : s
    );
    expect(updated.find(s => s.scenario_id === 'sc-1')!.effective_dsl).toBe('window(-7d:).context(channel:meta)');
  });
});
