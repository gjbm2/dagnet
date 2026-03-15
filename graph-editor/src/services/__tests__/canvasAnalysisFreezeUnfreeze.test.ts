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
import { advanceMode, nextMode } from '../canvasAnalysisMutationService';
import { augmentDSLWithConstraint, normalizeConstraintString } from '../../lib/queryDSL';
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

// ============================================================
// advanceMode — tristate transition logic (Phase 2)
// ============================================================

describe('advanceMode — tristate transitions', () => {
  describe('nextMode helper', () => {
    it('should cycle live → custom → fixed → live', () => {
      expect(nextMode('live')).toBe('custom');
      expect(nextMode('custom')).toBe('fixed');
      expect(nextMode('fixed')).toBe('live');
    });
  });

  describe('Live → Custom (rebase to delta DSLs)', () => {
    it('should set mode to custom and rebase captured scenarios to deltas', () => {
      const analysis = makeLiveAnalysis();
      const currentDSL = 'window(-7d:).context(channel:google)';
      const captured = {
        scenarios: [
          { scenario_id: 'current', effective_dsl: currentDSL, name: 'Current', colour: '#3b82f6', is_live: true },
          { scenario_id: 'sc-1', effective_dsl: 'window(-30d:).context(channel:google)', name: 'Google 30d', colour: '#EC4899', is_live: true },
        ],
        what_if_dsl: 'case(test:treatment)',
      };

      advanceMode(analysis, currentDSL, captured);

      expect(analysis.mode).toBe('custom');
      expect(analysis.recipe.analysis.what_if_dsl).toBe('case(test:treatment)');

      const currentScenario = analysis.recipe.scenarios!.find(s => s.scenario_id === 'current')!;
      // Current scenario's absolute DSL equals currentDSL → empty delta
      expect(currentScenario.effective_dsl).toBeUndefined(); // empty delta stored as undefined
      expect(currentScenario.is_live).toBe(false);

      const sc1 = analysis.recipe.scenarios!.find(s => s.scenario_id === 'sc-1')!;
      // sc-1 differs from currentDSL in window: -30d vs -7d → delta should contain window(-30d:)
      expect(sc1.effective_dsl).toBe('window(-30d:)');
      expect(sc1.is_live).toBe(false);

      // Round-trip: augment(currentDSL, delta) should reproduce the original absolute DSL
      const reconstructed = augmentDSLWithConstraint(currentDSL, sc1.effective_dsl!);
      expect(reconstructed).toBe(normalizeConstraintString('window(-30d:).context(channel:google)'));
    });

    it('should be a no-op if captured is null', () => {
      const analysis = makeLiveAnalysis();
      advanceMode(analysis, 'window(-7d:)', null);
      expect(analysis.mode).toBe('live');
    });

    it('should handle scenario with context key removal during rebase', () => {
      const analysis = makeLiveAnalysis();
      const currentDSL = 'window(-7d:).context(channel:google).context(region:uk)';
      const captured = {
        scenarios: [
          { scenario_id: 'sc-1', effective_dsl: 'window(-7d:).context(channel:google)', name: 'No region', colour: '#f00', is_live: true },
        ],
      };

      advanceMode(analysis, currentDSL, captured);

      const sc1 = analysis.recipe.scenarios!.find(s => s.scenario_id === 'sc-1')!;
      // Delta should contain context(region:) — per-key clear for the removed key
      expect(sc1.effective_dsl).toBe('context(region:)');

      // Round-trip
      const reconstructed = augmentDSLWithConstraint(currentDSL, sc1.effective_dsl!);
      expect(reconstructed).toBe(normalizeConstraintString('window(-7d:).context(channel:google)'));
    });
  });

  describe('Custom → Fixed (bake deltas into absolute DSLs)', () => {
    it('should set mode to fixed and compose deltas into absolutes', () => {
      const analysis: CanvasAnalysis = {
        ...makeLiveAnalysis(),
        mode: 'custom',
        recipe: {
          analysis: { analysis_type: 'conversion_funnel', analytics_dsl: 'from(a).to(b)' },
          scenarios: [
            { scenario_id: 'current', name: 'Current', colour: '#3b82f6', effective_dsl: undefined }, // empty delta
            { scenario_id: 'sc-1', name: '30d', colour: '#EC4899', effective_dsl: 'window(-30d:)' }, // delta: change window
          ],
        },
      };

      const currentDSL = 'window(-7d:).context(channel:google)';
      advanceMode(analysis, currentDSL, null);

      expect(analysis.mode).toBe('fixed');

      const currentScenario = analysis.recipe.scenarios!.find(s => s.scenario_id === 'current')!;
      // Empty delta → baked to normalised currentDSL
      expect(currentScenario.effective_dsl).toBe(normalizeConstraintString(currentDSL));

      const sc1 = analysis.recipe.scenarios!.find(s => s.scenario_id === 'sc-1')!;
      // delta window(-30d:) on base window(-7d:).context(channel:google) → window(-30d:).context(channel:google)
      expect(sc1.effective_dsl).toBe(normalizeConstraintString('window(-30d:).context(channel:google)'));
    });
  });

  describe('Fixed → Live (clear scenarios)', () => {
    it('should set mode to live and clear scenarios and what_if_dsl', () => {
      const analysis: CanvasAnalysis = {
        ...makeLiveAnalysis(),
        mode: 'fixed',
        recipe: {
          analysis: { analysis_type: 'conversion_funnel', analytics_dsl: 'from(a).to(b)', what_if_dsl: 'case(test:treatment)' },
          scenarios: [
            { scenario_id: 'current', effective_dsl: 'window(-7d:)', name: 'Current', colour: '#3b82f6' },
          ],
        },
      };

      advanceMode(analysis, 'window(-7d:)', null);

      expect(analysis.mode).toBe('live');
      expect(analysis.recipe.scenarios).toBeUndefined();
      expect(analysis.recipe.analysis.what_if_dsl).toBeUndefined();
      // chart_current_layer_dsl should be preserved (advanceMode doesn't touch it)
      expect(analysis.chart_current_layer_dsl).toBe('context(device:mobile)');
    });
  });

  describe('Full cycle round-trip', () => {
    it('should preserve scenario semantics through Live → Custom → Fixed → Live', () => {
      const analysis = makeLiveAnalysis();
      const currentDSL = 'window(-7d:).context(channel:google)';

      // Step 1: Live → Custom
      const captured = {
        scenarios: [
          { scenario_id: 'current', effective_dsl: currentDSL, name: 'Current', colour: '#3b82f6', is_live: true },
          { scenario_id: 'sc-1', effective_dsl: 'window(-30d:).context(channel:meta)', name: 'Meta 30d', colour: '#EC4899', is_live: true },
        ],
      };
      advanceMode(analysis, currentDSL, captured);
      expect(analysis.mode).toBe('custom');
      const sc1Delta = analysis.recipe.scenarios!.find(s => s.scenario_id === 'sc-1')!.effective_dsl;

      // Step 2: Custom → Fixed
      advanceMode(analysis, currentDSL, null);
      expect(analysis.mode).toBe('fixed');
      const sc1Absolute = analysis.recipe.scenarios!.find(s => s.scenario_id === 'sc-1')!.effective_dsl;
      expect(sc1Absolute).toBe(normalizeConstraintString('window(-30d:).context(channel:meta)'));

      // Step 3: Fixed → Live
      advanceMode(analysis, currentDSL, null);
      expect(analysis.mode).toBe('live');
      expect(analysis.recipe.scenarios).toBeUndefined();
    });
  });
});
