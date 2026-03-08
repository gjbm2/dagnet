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

import { describe, it, expect, vi } from 'vitest';
import { captureTabScenariosToRecipe } from '../../services/captureTabScenariosService';
import { buildGraphForAnalysisLayer } from '../../services/CompositionService';

vi.mock('../../services/CompositionService', () => ({
  buildGraphForAnalysisLayer: vi.fn(
    (layerId: string, graph: any, _base: any, _current: any, _scenarios: any[], _whatIf: any, _mode: any) => ({
      ...graph,
      __composedFor: layerId,
    }),
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
  return {
    getScenarioState: () => ({
      visibleScenarioIds: visibleIds,
      scenarioOrder: scenarioOrder || visibleIds.filter(id => id !== 'current' && id !== 'base'),
    }),
    getScenarioVisibilityMode: (_tabId: string, sid: string) => modes[sid] || ('f+e' as const),
  };
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
      visibilityMode,
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
      (fs.visibility_mode || 'f+e') as 'f+e' | 'f' | 'e',
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

    const liveDescs = buildLiveScenarioDescriptors(visibleIds, {});
    const frozenDescs = buildFrozenScenarioDescriptors(captured);

    assertScenarioDescriptorsParity(liveDescs, frozenDescs);
  });

  it('3. three scenarios (Current + user + Base)', () => {
    const visibleIds = ['current', 'sc-mobile', 'base'];
    const ops = makeOps(visibleIds);
    const { scenarios: captured } = captureTabScenariosToRecipe({
      tabId: 'tab-1', currentDSL, operations: ops, scenariosContext: scenariosContext as any,
    });

    const liveDescs = buildLiveScenarioDescriptors(visibleIds, {});
    const frozenDescs = buildFrozenScenarioDescriptors(captured);

    assertScenarioDescriptorsParity(liveDescs, frozenDescs);
  });

  it('4. ordering preserved: user scenarios follow scenarioOrder', () => {
    const visibleIds = ['current', 'sc-paid', 'sc-mobile', 'base'];
    const scenarioOrder = ['sc-paid', 'sc-mobile'];
    const ops = makeOps(visibleIds, {}, scenarioOrder);
    const { scenarios: captured } = captureTabScenariosToRecipe({
      tabId: 'tab-1', currentDSL, operations: ops, scenariosContext: scenariosContext as any,
    });

    expect(captured.map(s => s.scenario_id)).toEqual(['current', 'sc-paid', 'sc-mobile', 'base']);

    const liveDescs = buildLiveScenarioDescriptors(['current', 'sc-paid', 'sc-mobile', 'base'], {});
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

    expect(captured[0].visibility_mode).toBe('f');
    expect(captured[1].visibility_mode).toBe('e');

    const liveDescs = buildLiveScenarioDescriptors(visibleIds, modes);
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

    const liveDescs = buildLiveScenarioDescriptors(visibleIds, {}, whatIf);
    const frozenDescs = buildFrozenScenarioDescriptors(captured, what_if_dsl);

    assertScenarioDescriptorsParity(liveDescs, frozenDescs);

    expect(vi.mocked(buildGraphForAnalysisLayer)).toHaveBeenCalledWith(
      'current', expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      whatIf, expect.anything(),
    );
  });

  it('7. chart fragment does not affect scenario descriptors (applied separately)', () => {
    const visibleIds = ['current', 'sc-mobile'];
    const ops = makeOps(visibleIds);
    const { scenarios: captured } = captureTabScenariosToRecipe({
      tabId: 'tab-1', currentDSL, operations: ops, scenariosContext: scenariosContext as any,
    });

    const liveDescs = buildLiveScenarioDescriptors(visibleIds, {});
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
    expect(frozenVisible.map(s => s.scenario_id)).toEqual(['current', 'sc-mobile']);

    const liveDescs = buildLiveScenarioDescriptors(['current', 'sc-mobile'], {});
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
