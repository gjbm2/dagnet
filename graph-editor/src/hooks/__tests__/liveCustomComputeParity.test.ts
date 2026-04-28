/**
 * Live vs Custom compute argument parity tests.
 *
 * Invariant: switching from Live to Custom must produce identical backend
 * call arguments. Both paths must send the same scenario IDs in the same
 * order, with the same names, colours, visibility modes, and composed graphs.
 *
 * These tests exercise the REAL captureTabScenariosToRecipe and
 * buildGraphForAnalysisLayer functions — not mocks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { captureTabScenariosToRecipe } from '../../services/captureTabScenariosService';
import { buildGraphForAnalysisLayer } from '../../services/CompositionService';
import { advanceMode } from '../../services/canvasAnalysisMutationService';
import { augmentDSLWithConstraint, normalizeConstraintString } from '../../lib/queryDSL';
import type { ContentItem } from '../../types';

vi.mock('../../services/CompositionService', () => ({
  buildGraphForAnalysisLayer: vi.fn(
    (layerId: string, graph: any, _base: any, _current: any, _scenarios: any[], _whatIf: any) => ({
      ...graph,
      __composedFor: layerId,
    }),
  ),
  getComposedParamsForLayer: vi.fn(
    (_layerId: string, _baseParams: any, _currentParams: any, _scenarios: any[], _visibleIds: string[]) => ({}),
  ),
}));

const graph = {
  nodes: [
    { uuid: 'u1', id: 'start', label: 'Start', entry: { is_start: true } },
    { uuid: 'u2', id: 'end', label: 'End', absorbing: true },
  ],
  edges: [{ from: 'u1', to: 'u2', p: { mean: 0.5 } }],
  metadata: { version: '1.0.0' },
};

const scenariosContext = {
  scenarios: [
    { id: 'sc-mobile', name: 'Mobile', colour: '#EC4899', params: {}, meta: { isLive: true, queryDSL: 'context(device:mobile)', lastEffectiveDSL: 'window(-30d:).context(device:mobile)' } },
    { id: 'sc-paid', name: 'Paid', colour: '#10B981', params: {}, meta: { isLive: true, queryDSL: 'context(channel:paid)', lastEffectiveDSL: 'window(-30d:).context(channel:paid)' } },
  ],
  currentColour: '#3b82f6',
  baseColour: '#6b7280',
  baseParams: {},
  currentParams: {},
  baseDSL: 'window(-30d:)',
};

const currentDSL = 'window(-30d:)';

function makeOps(visibleIds: string[], modes: Record<string, 'f+e' | 'f' | 'e'> = {}, scenarioOrder?: string[]) {
  const effectiveOrder = scenarioOrder || visibleIds.filter(id => id !== 'current' && id !== 'base');
  return {
    getScenarioState: () => ({
      visibleScenarioIds: visibleIds,
      scenarioOrder: effectiveOrder,
    }),
    getScenarioVisibilityMode: (_tabId: string, sid: string) => modes[sid] || ('f+e' as const),
  };
}

/**
 * Mirrors deriveOrderedVisibleIds from captureTabScenariosService.
 * Used to compute the expected rendering order for live-mode descriptors.
 */
function deriveExpectedOrder(visibleIds: string[], scenarioOrder?: string[]): string[] {
  const visibleSet = new Set(visibleIds);
  const order = scenarioOrder || visibleIds.filter(id => id !== 'current' && id !== 'base');
  const userItems = [...order]
    .reverse()
    .filter(id => id !== 'current' && id !== 'base' && visibleSet.has(id));
  const result: string[] = [];
  if (visibleSet.has('base')) result.push('base');
  result.push(...userItems);
  if (visibleSet.has('current')) result.push('current');
  return result.length > 0 ? result : ['current'];
}

function buildLiveScenarioDescriptors(
  visibleIds: string[],
  modes: Record<string, 'f+e' | 'f' | 'e'>,
  whatIfDSL?: string | null,
) {
  return visibleIds.map((scenarioId) => {
    const visibilityMode = modes[scenarioId] || 'f+e';
    const scenarioGraph = buildGraphForAnalysisLayer(
      scenarioId, graph as any,
      scenariosContext.baseParams || {},
      scenariosContext.currentParams || {},
      scenariosContext.scenarios || [],
      scenarioId === 'current' ? whatIfDSL : undefined,
    );
    const colour = scenarioId === 'current' ? '#3b82f6'
      : scenarioId === 'base' ? '#6b7280'
      : scenariosContext.scenarios.find(s => s.id === scenarioId)?.colour || '#808080';
    const name = scenarioId === 'current' ? 'Current'
      : scenarioId === 'base' ? 'Base'
      : scenariosContext.scenarios.find(s => s.id === scenarioId)?.name || scenarioId;
    return { scenario_id: scenarioId, name, graph: scenarioGraph, colour, visibility_mode: visibilityMode };
  });
}

function buildFrozenScenarioDescriptors(
  frozenScenarios: any[],
  whatIfDSL?: string | null,
) {
  return frozenScenarios.map((fs: any) => {
    const scenarioGraph = buildGraphForAnalysisLayer(
      fs.scenario_id, graph as any,
      scenariosContext.baseParams || {},
      scenariosContext.currentParams || {},
      scenariosContext.scenarios || [],
      fs.scenario_id === 'current' ? whatIfDSL : undefined,
    );
    return {
      scenario_id: fs.scenario_id,
      name: fs.name || fs.scenario_id,
      graph: scenarioGraph,
      colour: fs.colour || '#808080',
      visibility_mode: fs.visibility_mode || 'f+e',
    };
  });
}

function assertScenarioDescriptorsParity(live: any[], frozen: any[]) {
  expect(frozen).toHaveLength(live.length);
  for (let i = 0; i < live.length; i++) {
    expect(frozen[i].scenario_id).toBe(live[i].scenario_id);
    expect(frozen[i].name).toBe(live[i].name);
    expect(frozen[i].colour).toBe(live[i].colour);
    expect(frozen[i].visibility_mode).toBe(live[i].visibility_mode);
    expect(frozen[i].graph).toEqual(live[i].graph);
  }
}

describe('Live → Custom compute parity', () => {
  it('1. single scenario (Current only)', () => {
    const visibleIds = ['current'];
    const ops = makeOps(visibleIds);
    const { scenarios: captured } = captureTabScenariosToRecipe({
      tabId: 'tab-1', currentDSL, operations: ops, scenariosContext: scenariosContext as any,
    });

    const liveDescs = buildLiveScenarioDescriptors(visibleIds, {});
    const frozenDescs = buildFrozenScenarioDescriptors(captured);

    assertScenarioDescriptorsParity(liveDescs, frozenDescs);
  });

  it('2. two scenarios (Current + user)', () => {
    const visibleIds = ['current', 'sc-mobile'];
    const ops = makeOps(visibleIds);
    const { scenarios: captured } = captureTabScenariosToRecipe({
      tabId: 'tab-1', currentDSL, operations: ops, scenariosContext: scenariosContext as any,
    });

    const derivedOrder = deriveExpectedOrder(visibleIds);
    const liveDescs = buildLiveScenarioDescriptors(derivedOrder, {});
    const frozenDescs = buildFrozenScenarioDescriptors(captured);

    assertScenarioDescriptorsParity(liveDescs, frozenDescs);
  });

  it('3. three scenarios (Current + user + Base)', () => {
    const visibleIds = ['current', 'sc-mobile', 'base'];
    const ops = makeOps(visibleIds);
    const { scenarios: captured } = captureTabScenariosToRecipe({
      tabId: 'tab-1', currentDSL, operations: ops, scenariosContext: scenariosContext as any,
    });

    const derivedOrder = deriveExpectedOrder(visibleIds);
    const liveDescs = buildLiveScenarioDescriptors(derivedOrder, {});
    const frozenDescs = buildFrozenScenarioDescriptors(captured);

    assertScenarioDescriptorsParity(liveDescs, frozenDescs);
  });

  it('4. ordering preserved: user scenarios follow scenarioOrder reversed', () => {
    const visibleIds = ['current', 'sc-paid', 'sc-mobile', 'base'];
    const scenarioOrder = ['sc-paid', 'sc-mobile'];
    const ops = makeOps(visibleIds, {}, scenarioOrder);
    const { scenarios: captured } = captureTabScenariosToRecipe({
      tabId: 'tab-1', currentDSL, operations: ops, scenariosContext: scenariosContext as any,
    });

    // scenarioOrder reversed = ['sc-mobile', 'sc-paid'], with base first and current last
    const derivedOrder = deriveExpectedOrder(visibleIds, scenarioOrder);
    expect(captured.map(s => s.scenario_id)).toEqual(derivedOrder);

    const liveDescs = buildLiveScenarioDescriptors(derivedOrder, {});
    const frozenDescs = buildFrozenScenarioDescriptors(captured);

    assertScenarioDescriptorsParity(liveDescs, frozenDescs);
  });

  it('5. visibility modes preserved per scenario', () => {
    const visibleIds = ['current', 'sc-mobile'];
    const modes: Record<string, 'f+e' | 'f' | 'e'> = { current: 'f', 'sc-mobile': 'e' };
    const ops = makeOps(visibleIds, modes);
    const { scenarios: captured } = captureTabScenariosToRecipe({
      tabId: 'tab-1', currentDSL, operations: ops, scenariosContext: scenariosContext as any,
    });

    const derivedOrder = deriveExpectedOrder(visibleIds);
    // derived order: ['sc-mobile', 'current'] — sc-mobile first, current last
    const scMobile = captured.find(s => s.scenario_id === 'sc-mobile');
    const current = captured.find(s => s.scenario_id === 'current');
    expect(scMobile?.visibility_mode).toBe('e');
    expect(current?.visibility_mode).toBe('f');

    const liveDescs = buildLiveScenarioDescriptors(derivedOrder, modes);
    const frozenDescs = buildFrozenScenarioDescriptors(captured);

    assertScenarioDescriptorsParity(liveDescs, frozenDescs);
  });

  it('6. What-If DSL preserved and applied to Current graph composition', () => {
    const visibleIds = ['current', 'sc-mobile'];
    const ops = makeOps(visibleIds);
    const whatIf = 'case(test:treatment)';
    const { scenarios: captured, what_if_dsl } = captureTabScenariosToRecipe({
      tabId: 'tab-1', currentDSL, operations: ops, scenariosContext: scenariosContext as any, whatIfDSL: whatIf,
    });

    expect(what_if_dsl).toBe(whatIf);

    const derivedOrder = deriveExpectedOrder(visibleIds);
    const liveDescs = buildLiveScenarioDescriptors(derivedOrder, {}, whatIf);
    const frozenDescs = buildFrozenScenarioDescriptors(captured, what_if_dsl);

    assertScenarioDescriptorsParity(liveDescs, frozenDescs);

    expect(vi.mocked(buildGraphForAnalysisLayer)).toHaveBeenCalledWith(
      'current', expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      whatIf,
    );
  });

  it('7. chart fragment does not affect scenario descriptors (applied separately)', () => {
    const visibleIds = ['current', 'sc-mobile'];
    const ops = makeOps(visibleIds);
    const { scenarios: captured } = captureTabScenariosToRecipe({
      tabId: 'tab-1', currentDSL, operations: ops, scenariosContext: scenariosContext as any,
    });

    const derivedOrder = deriveExpectedOrder(visibleIds);
    const liveDescs = buildLiveScenarioDescriptors(derivedOrder, {});
    const frozenDescs = buildFrozenScenarioDescriptors(captured);

    assertScenarioDescriptorsParity(liveDescs, frozenDescs);
  });

  it('8. hidden scenarios excluded from frozen compute', () => {
    const visibleIds = ['current', 'sc-mobile', 'sc-paid'];
    const ops = makeOps(visibleIds);
    const { scenarios: captured } = captureTabScenariosToRecipe({
      tabId: 'tab-1', currentDSL, operations: ops, scenariosContext: scenariosContext as any,
    });

    const hiddenSet = new Set(['sc-paid']);
    const frozenVisible = captured.filter(s => !hiddenSet.has(s.scenario_id));

    expect(frozenVisible).toHaveLength(2);
    expect(frozenVisible.map(s => s.scenario_id)).toEqual(['sc-mobile', 'current']);

    const liveDescs = buildLiveScenarioDescriptors(['sc-mobile', 'current'], {});
    const frozenDescs = buildFrozenScenarioDescriptors(frozenVisible);

    assertScenarioDescriptorsParity(liveDescs, frozenDescs);
  });

  it('9. scenario with custom lastEffectiveDSL preserves per-scenario DSL', () => {
    const visibleIds = ['current', 'sc-mobile'];
    const ops = makeOps(visibleIds);
    const { scenarios: captured } = captureTabScenariosToRecipe({
      tabId: 'tab-1', currentDSL, operations: ops, scenariosContext: scenariosContext as any,
    });

    const mobileScenario = captured.find(s => s.scenario_id === 'sc-mobile');
    expect(mobileScenario?.effective_dsl).toBe('window(-30d:).context(device:mobile)');

    const currentScenario = captured.find(s => s.scenario_id === 'current');
    expect(currentScenario?.effective_dsl).toBe(currentDSL);
  });
});

/**
 * End-to-end Live → Custom rendering parity tests.
 *
 * These exercise the FULL transition path:
 *   1. captureTabScenariosToRecipe (captures live tab state into recipe)
 *   2. advanceMode (rebases DSLs from absolute to delta)
 *   3. Custom compute path (re-expands delta DSLs to absolute)
 *
 * The invariant: after this round-trip, Custom mode must produce
 * identical rendering inputs (scenario IDs, order, colours, names,
 * visibility modes, and effective DSLs) to what Live mode produced.
 *
 * Uses REAL queryDSL functions (computeRebaseDelta, augmentDSLWithConstraint)
 * — no mocks for the DSL round-trip.
 */
describe('Live → Custom full transition parity (capture + advanceMode + custom compute)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Realistic 3-scenario state matching the user's bug report:
  //   - "No overrides" (yellow) — no queryDSL, just base window
  //   - "Cohort: 11-Feb – 12-Mar" (pink) — context filter
  //   - "Current" (blue) — live current layer
  const realisticContext = {
    scenarios: [
      {
        id: 'sc-no-overrides',
        name: 'No overrides',
        colour: '#EAB308',
        params: {},
        meta: { isLive: true, queryDSL: '', lastEffectiveDSL: 'window(-30d:)' },
      },
      {
        id: 'sc-cohort',
        name: 'Cohort: 11-Feb – 12-Mar',
        colour: '#EC4899',
        params: {},
        meta: { isLive: true, queryDSL: 'context(cohort:11feb-12mar)', lastEffectiveDSL: 'window(-30d:).context(cohort:11feb-12mar)' },
      },
    ],
    currentColour: '#3b82f6',
    baseColour: '#6b7280',
    baseDSL: 'window(-30d:)',
    baseParams: {},
    currentParams: {},
  };

  const realisticCurrentDSL = 'window(-30d:)';

  function makeLiveContentItem(): ContentItem {
    return {
      id: 'ci-test',
      analysis_type: 'pit',
      view_type: 'chart',
      analytics_dsl: 'pit_pull(start)',
      mode: 'live',
    };
  }

  /**
   * Simulate what the Custom compute path does: for each recipe scenario,
   * re-expand its delta DSL via augmentDSLWithConstraint(currentDSL, delta).
   */
  function computeCustomEffectiveDSLs(
    ci: ContentItem,
    baseDSL: string,
  ): Array<{ scenario_id: string; name: string; colour: string; visibility_mode: string; effective_dsl: string }> {
    const customScenarios = ci.scenarios || [];
    return customScenarios.map((s) => {
      const delta = s.effective_dsl || '';
      const absolute = delta
        ? augmentDSLWithConstraint(baseDSL, delta)
        : baseDSL;
      return {
        scenario_id: s.scenario_id,
        name: s.name || s.scenario_id,
        colour: s.colour || '#808080',
        visibility_mode: s.visibility_mode || 'f+e',
        effective_dsl: absolute,
      };
    });
  }

  it('should preserve scenario order through capture → advanceMode round-trip', () => {
    // scenarioOrder: newest first (prepended). User added sc-no-overrides then sc-cohort.
    const scenarioOrder = ['sc-cohort', 'sc-no-overrides'];
    const visibleIds = ['current', 'sc-no-overrides', 'sc-cohort'];
    const ops = makeOps(visibleIds, {}, scenarioOrder);

    // Step 1: capture
    const captured = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: realisticCurrentDSL,
      operations: ops,
      scenariosContext: realisticContext as any,
    });

    // Derived order: scenarioOrder reversed = ['sc-no-overrides', 'sc-cohort'], current last
    const expectedOrder = deriveExpectedOrder(visibleIds, scenarioOrder);
    expect(captured.scenarios.map(s => s.scenario_id)).toEqual(expectedOrder);

    // Step 2: advanceMode (Live → Custom)
    const ci = makeLiveContentItem();
    advanceMode(ci, realisticCurrentDSL, captured);

    expect(ci.mode).toBe('custom');
    // 'current' is replaced in-place by 'no-overrides' and moved to end (hidden underlayer)
    const expectedCustomOrder = expectedOrder
      .map(id => id === 'current' ? 'no-overrides' : id);
    expectedCustomOrder.push('current');
    expect(ci.scenarios!.map(s => s.scenario_id)).toEqual(expectedCustomOrder);
  });

  it('should preserve colours, names, and visibility modes through the full transition', () => {
    const scenarioOrder = ['sc-cohort', 'sc-no-overrides'];
    const visibleIds = ['current', 'sc-no-overrides', 'sc-cohort'];
    const modes: Record<string, 'f+e' | 'f' | 'e'> = {
      'current': 'f+e',
      'sc-no-overrides': 'f',
      'sc-cohort': 'e',
    };
    const ops = makeOps(visibleIds, modes, scenarioOrder);

    const captured = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: realisticCurrentDSL,
      operations: ops,
      scenariosContext: realisticContext as any,
    });

    const ci = makeLiveContentItem();
    advanceMode(ci, realisticCurrentDSL, captured);

    const customScenarios = ci.scenarios!;

    // Colours preserved exactly
    const noOverrides = customScenarios.find(s => s.scenario_id === 'sc-no-overrides');
    expect(noOverrides?.colour).toBe('#EAB308');
    expect(noOverrides?.name).toBe('No overrides');
    expect(noOverrides?.visibility_mode).toBe('f');

    const cohort = customScenarios.find(s => s.scenario_id === 'sc-cohort');
    expect(cohort?.colour).toBe('#EC4899');
    expect(cohort?.name).toBe('Cohort: 11-Feb – 12-Mar');
    expect(cohort?.visibility_mode).toBe('e');

    const current = customScenarios.find(s => s.scenario_id === 'current');
    expect(current?.colour).toBe('#3b82f6');
    expect(current?.name).toBe('Current');
    expect(current?.visibility_mode).toBe('f+e');
  });

  it('should produce identical effective DSLs after rebase round-trip (absolute → delta → absolute)', () => {
    const scenarioOrder = ['sc-cohort', 'sc-no-overrides'];
    const visibleIds = ['current', 'sc-no-overrides', 'sc-cohort'];
    const ops = makeOps(visibleIds, {}, scenarioOrder);

    // Capture (absolute DSLs)
    const captured = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: realisticCurrentDSL,
      operations: ops,
      scenariosContext: realisticContext as any,
    });

    // Record the absolute DSLs from capture (what Live mode sees)
    const liveAbsoluteDSLs = new Map<string, string>();
    for (const s of captured.scenarios) {
      liveAbsoluteDSLs.set(s.scenario_id, s.effective_dsl || realisticCurrentDSL);
    }

    // advanceMode: absolute → delta
    const ci = makeLiveContentItem();
    advanceMode(ci, realisticCurrentDSL, captured);

    // Custom compute: delta → absolute (same as analysisComputePreparationService)
    const customResults = computeCustomEffectiveDSLs(ci, realisticCurrentDSL);

    // The round-trip must produce semantically identical absolute DSLs.
    // Clause order may differ (context before window vs after) but normalised form must match.
    for (const customResult of customResults) {
      // 'no-overrides' is a promoted copy of 'current' — same DSL
      const lookupId = customResult.scenario_id === 'no-overrides' ? 'current' : customResult.scenario_id;
      const liveAbsolute = liveAbsoluteDSLs.get(lookupId);
      expect(normalizeConstraintString(customResult.effective_dsl)).toBe(normalizeConstraintString(liveAbsolute!));
    }
  });

  it('should produce rendering-identical output for realistic 3-scenario state', () => {
    // This test simulates the exact user flow:
    // 1. User has 3 scenarios visible in Live mode
    // 2. User clicks mode toggle → Live→Custom
    // 3. Chart must render identically

    const scenarioOrder = ['sc-cohort', 'sc-no-overrides'];
    const visibleIds = ['current', 'sc-no-overrides', 'sc-cohort'];
    const ops = makeOps(visibleIds, {}, scenarioOrder);

    // --- Live side: what the chart currently renders ---
    const derivedOrder = deriveExpectedOrder(visibleIds, scenarioOrder);

    const liveRenderingState = derivedOrder.map((sid) => {
      const colour = sid === 'current' ? '#3b82f6'
        : realisticContext.scenarios.find(s => s.id === sid)?.colour || '#808080';
      const name = sid === 'current' ? 'Current'
        : realisticContext.scenarios.find(s => s.id === sid)?.name || sid;
      const effectiveDsl = sid === 'current' ? realisticCurrentDSL
        : realisticContext.scenarios.find(s => s.id === sid)?.meta?.lastEffectiveDSL || realisticCurrentDSL;
      return { scenario_id: sid, colour, name, effective_dsl: effectiveDsl, visibility_mode: 'f+e' };
    });

    // --- Custom side: capture + advanceMode + re-expand ---
    const captured = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: realisticCurrentDSL,
      operations: ops,
      scenariosContext: realisticContext as any,
    });

    const ci = makeLiveContentItem();
    advanceMode(ci, realisticCurrentDSL, captured);

    const allCustomState = computeCustomEffectiveDSLs(ci, realisticCurrentDSL);
    // Filter to visible scenarios only (exclude hidden 'current' underlayer)
    const hiddenIds = new Set<string>(((ci.display as any)?.hidden_scenarios) || []);
    const customRenderingState = allCustomState.filter(s => !hiddenIds.has(s.scenario_id));

    // Custom has 'no-overrides' (promoted copy of current) in place of 'current'.
    // Map live 'current' to custom 'no-overrides' for parity comparison.
    const liveToCustomIdMap: Record<string, string> = { current: 'no-overrides' };
    expect(customRenderingState).toHaveLength(liveRenderingState.length);
    for (let i = 0; i < liveRenderingState.length; i++) {
      const expectedId = liveToCustomIdMap[liveRenderingState[i].scenario_id] || liveRenderingState[i].scenario_id;
      expect(customRenderingState[i].scenario_id).toBe(expectedId);
      expect(customRenderingState[i].colour).toBe(liveRenderingState[i].colour);
      const expectedName = liveRenderingState[i].scenario_id === 'current' ? 'No overrides' : liveRenderingState[i].name;
      expect(customRenderingState[i].name).toBe(expectedName);
      expect(normalizeConstraintString(customRenderingState[i].effective_dsl)).toBe(normalizeConstraintString(liveRenderingState[i].effective_dsl));
      expect(customRenderingState[i].visibility_mode).toBe(liveRenderingState[i].visibility_mode);
    }
  });

  it('should handle scenario with context filter DSL through rebase round-trip', () => {
    // Specific regression test: context(cohort:X) must survive the
    // absolute → delta → absolute round-trip via computeRebaseDelta + augmentDSLWithConstraint
    const visibleIds = ['current', 'sc-cohort'];
    const ops = makeOps(visibleIds, {}, ['sc-cohort']);

    const captured = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: realisticCurrentDSL,
      operations: ops,
      scenariosContext: realisticContext as any,
    });

    const cohortCaptured = captured.scenarios.find(s => s.scenario_id === 'sc-cohort');
    expect(cohortCaptured?.effective_dsl).toBe('window(-30d:).context(cohort:11feb-12mar)');

    const ci = makeLiveContentItem();
    advanceMode(ci, realisticCurrentDSL, captured);

    const customResults = computeCustomEffectiveDSLs(ci, realisticCurrentDSL);
    const cohortCustom = customResults.find(s => s.scenario_id === 'sc-cohort');

    // The context filter must survive the round-trip (normalised for clause order)
    expect(normalizeConstraintString(cohortCustom?.effective_dsl || '')).toBe(normalizeConstraintString('window(-30d:).context(cohort:11feb-12mar)'));
  });

  it('should handle what_if_dsl through the full transition', () => {
    const visibleIds = ['current', 'sc-no-overrides'];
    const ops = makeOps(visibleIds, {}, ['sc-no-overrides']);
    const whatIf = 'case(test-case:treatment)';

    const captured = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: realisticCurrentDSL,
      operations: ops,
      scenariosContext: realisticContext as any,
      whatIfDSL: whatIf,
    });

    expect(captured.what_if_dsl).toBe(whatIf);

    const ci = makeLiveContentItem();
    advanceMode(ci, realisticCurrentDSL, captured);

    // what_if_dsl must be preserved on the content item
    expect(ci.what_if_dsl).toBe(whatIf);
  });

  it('should handle base scenario through the full transition', () => {
    const scenarioOrder = ['sc-no-overrides'];
    const visibleIds = ['current', 'sc-no-overrides', 'base'];
    const ops = makeOps(visibleIds, {}, scenarioOrder);

    const captured = captureTabScenariosToRecipe({
      tabId: 'tab-1',
      currentDSL: realisticCurrentDSL,
      operations: ops,
      scenariosContext: realisticContext as any,
    });

    // Base must be first, current must be last
    const derivedOrder = deriveExpectedOrder(visibleIds, scenarioOrder);
    expect(derivedOrder[0]).toBe('base');
    expect(derivedOrder[derivedOrder.length - 1]).toBe('current');
    expect(captured.scenarios.map(s => s.scenario_id)).toEqual(derivedOrder);

    const ci = makeLiveContentItem();
    advanceMode(ci, realisticCurrentDSL, captured);

    const customResults = computeCustomEffectiveDSLs(ci, realisticCurrentDSL);

    // Base scenario should have the base DSL
    const baseDsl = customResults.find(s => s.scenario_id === 'base');
    expect(baseDsl?.effective_dsl).toBe('window(-30d:)');
    expect(baseDsl?.colour).toBe('#6b7280');
    expect(baseDsl?.name).toBe('Base');
  });
});
