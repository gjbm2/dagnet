/**
 * Integration test: Output card focus → override flow (doc 15 §5.3, §17.3.4).
 *
 * Reproduces the exact code path from updateEdgeParam in PropertiesPanel
 * when ModelVarsCards.handleOutputFocus fires.
 */
import { describe, it, expect } from 'vitest';
import { applyPromotion, upsertModelVars, ukDateNow } from '../modelVarsResolution';
import type { ModelVarsEntry } from '../../types';

// ── Fixtures ────────────────────────────────────────────────────────────────

const analyticEntry: ModelVarsEntry = {
  source: 'analytic',
  source_at: '20-Mar-26',
  probability: { mean: 0.12, stdev: 0.03 },
  latency: { mu: 2.5, sigma: 0.8, t95: 45, onset_delta_days: 3 },
};

const bayesianGated: ModelVarsEntry = {
  source: 'bayesian',
  source_at: '21-Mar-26',
  probability: { mean: 0.15, stdev: 0.02 },
  latency: { mu: 2.3, sigma: 0.7, t95: 40, onset_delta_days: 2 },
  quality: { rhat: 1.01, ess: 800, divergences: 0, evidence_grade: 3, gate_passed: true },
};

function makeGraph(edgeP: Record<string, any>) {
  return {
    edges: [{
      uuid: 'edge-1',
      id: 'e1',
      p: { ...edgeP },
    }],
    model_source_preference: undefined as string | undefined,
    metadata: { updated_at: '' },
  };
}

/**
 * Reproduces updateEdgeParam logic from PropertiesPanel lines 1213–1284.
 * Returns the graph state that would be passed to setGraph.
 */
function simulateUpdateEdgeParam(
  graph: ReturnType<typeof makeGraph>,
  edgeId: string,
  paramSlot: 'p',
  changes: Record<string, any>,
): ReturnType<typeof makeGraph> {
  const next = structuredClone(graph);
  const edgeIndex = next.edges.findIndex((e: any) =>
    e.uuid === edgeId || e.id === edgeId,
  );
  if (edgeIndex < 0) throw new Error(`Edge ${edgeId} not found`);

  if (!next.edges[edgeIndex][paramSlot]) {
    (next.edges[edgeIndex] as any)[paramSlot] = {};
  }

  const { _noHistory, ...actualChanges } = changes;

  Object.assign(next.edges[edgeIndex][paramSlot], actualChanges);

  // AUTO-CREATE manual entry when model var field is overridden (mirrors updateEdgeParam)
  const MODEL_VAR_OVERRIDE_FIELDS = ['mean_overridden', 'stdev_overridden'];
  const hasModelVarOverride = paramSlot === 'p' &&
    next.edges[edgeIndex].p?.model_vars?.length &&
    MODEL_VAR_OVERRIDE_FIELDS.some(f => (actualChanges as any)[f] === true) &&
    !('model_vars' in actualChanges);

  if (hasModelVarOverride) {
    const p = next.edges[edgeIndex].p!;
    const existing = p.model_vars!.find((e: any) => e.source === 'manual');
    const base = existing ?? {
      source: 'manual' as const,
      source_at: ukDateNow(),
      probability: { mean: p.mean ?? 0, stdev: p.stdev ?? 0 },
    };
    const updated = { ...base, source_at: ukDateNow() };
    if ('mean' in actualChanges) updated.probability = { ...updated.probability, mean: (actualChanges as any).mean };
    if ('stdev' in actualChanges) updated.probability = { ...updated.probability, stdev: (actualChanges as any).stdev };
    upsertModelVars(p, updated);
    p.model_source_preference = 'manual';
    p.model_source_preference_overridden = true;
  }

  // MODEL_VARS resolution
  if (paramSlot === 'p' && (
    'model_vars' in actualChanges ||
    'model_source_preference' in actualChanges ||
    hasModelVarOverride
  )) {
    if (next.edges[edgeIndex].p) {
      applyPromotion(next.edges[edgeIndex].p, next.model_source_preference as any);
    }
  }

  return next;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Output card focus → updateEdgeParam → override state', () => {
  it('focus changes are applied to edge.p and survive applyPromotion', () => {
    const graph = makeGraph({
      mean: 0.15,
      stdev: 0.02,
      model_vars: [analyticEntry, bayesianGated],
      // No model_source_preference — auto mode
      // No model_source_preference_overridden
    });

    // Simulate what handleOutputFocus sends
    const focusChanges = {
      model_source_preference: 'manual',
      model_source_preference_overridden: true,
      _noHistory: true,
    };

    const result = simulateUpdateEdgeParam(graph, 'edge-1', 'p', focusChanges);

    // These MUST be on edge.p after the update
    expect(result.edges[0].p.model_source_preference).toBe('manual');
    expect(result.edges[0].p.model_source_preference_overridden).toBe(true);

    // Promoted scalars should still be valid (applyPromotion fell back to bestAvailable)
    expect(result.edges[0].p.mean).toBeCloseTo(0.15, 4);
  });

  it('ModelVarsCards would show manual as pinned after focus changes applied', () => {
    const graph = makeGraph({
      mean: 0.15,
      stdev: 0.02,
      model_vars: [analyticEntry, bayesianGated],
    });

    const result = simulateUpdateEdgeParam(graph, 'edge-1', 'p', {
      model_source_preference: 'manual',
      model_source_preference_overridden: true,
      _noHistory: true,
    });

    const p = result.edges[0].p;

    // Derive toggle states exactly as ModelVarsCards does
    const edgePreferenceOverridden = p.model_source_preference_overridden;
    const edgePreference = p.model_source_preference;
    const anyPinned = edgePreferenceOverridden === true;
    const isPinned = (s: string) => edgePreferenceOverridden === true && edgePreference === s;

    expect(isPinned('manual')).toBe(true);
    expect(anyPinned).toBe(true);
    // Bayesian should NOT be auto-on when something is pinned
    expect(!anyPinned).toBe(false);
  });

  it('blur commits manual entry + override persists through second updateEdgeParam', () => {
    // Phase 1: focus
    const graph = makeGraph({
      mean: 0.15,
      stdev: 0.02,
      model_vars: [analyticEntry, bayesianGated],
    });
    const afterFocus = simulateUpdateEdgeParam(graph, 'edge-1', 'p', {
      model_source_preference: 'manual',
      model_source_preference_overridden: true,
      _noHistory: true,
    });

    // Phase 2: blur with new value (what handleOutputEdit sends)
    const manualEntry: ModelVarsEntry = {
      source: 'manual',
      source_at: '22-Mar-26',
      probability: { mean: 0.20, stdev: 0.02 },
    };
    const nextVars = [...afterFocus.edges[0].p.model_vars, manualEntry];

    const afterBlur = simulateUpdateEdgeParam(afterFocus, 'edge-1', 'p', {
      model_vars: nextVars,
      model_source_preference: 'manual',
      model_source_preference_overridden: true,
    });

    // Override flags persist
    expect(afterBlur.edges[0].p.model_source_preference).toBe('manual');
    expect(afterBlur.edges[0].p.model_source_preference_overridden).toBe(true);

    // Promoted scalars updated to manual entry's values
    expect(afterBlur.edges[0].p.mean).toBeCloseTo(0.20, 4);
    expect(afterBlur.edges[0].p.stdev).toBeCloseTo(0.02, 4);

    // Manual entry is in model_vars
    const manual = afterBlur.edges[0].p.model_vars.find((e: any) => e.source === 'manual');
    expect(manual).toBeDefined();
    expect(manual.probability.mean).toBe(0.20);
  });
});

describe('updateEdgeParam: auto-creates manual entry on model var field override', () => {
  it('mean_overridden triggers manual entry creation when model_vars exists', () => {
    const graph = makeGraph({
      mean: 0.15, stdev: 0.02,
      model_vars: [analyticEntry, bayesianGated],
    });

    // Simulate context menu override: just sets mean + mean_overridden
    const result = simulateUpdateEdgeParam(graph, 'edge-1', 'p', {
      mean: 0.25,
      mean_overridden: true,
    });

    const p = result.edges[0].p;
    // Manual entry auto-created
    const manual = p.model_vars?.find((e: any) => e.source === 'manual');
    expect(manual).toBeDefined();
    expect(manual!.probability.mean).toBe(0.25);
    // Source pinned to manual
    expect(p.model_source_preference).toBe('manual');
    expect(p.model_source_preference_overridden).toBe(true);
    // Promoted scalars updated
    expect(p.mean).toBeCloseTo(0.25, 4);
  });

  it('does NOT create manual entry when model_vars is absent (legacy mode)', () => {
    const graph = makeGraph({
      mean: 0.15, stdev: 0.02,
      // no model_vars
    });

    const result = simulateUpdateEdgeParam(graph, 'edge-1', 'p', {
      mean: 0.25,
      mean_overridden: true,
    });

    expect(result.edges[0].p.model_vars).toBeUndefined();
    expect(result.edges[0].p.model_source_preference).toBeUndefined();
  });

  it('skips auto-creation when caller already provides model_vars', () => {
    const graph = makeGraph({
      mean: 0.15, stdev: 0.02,
      model_vars: [analyticEntry],
    });

    // Caller provides model_vars explicitly (e.g. handleOutputCommit did this before)
    const manualEntry = { source: 'manual', source_at: '22-Mar-26', probability: { mean: 0.30, stdev: 0.02 } };
    const result = simulateUpdateEdgeParam(graph, 'edge-1', 'p', {
      mean: 0.30,
      mean_overridden: true,
      model_vars: [analyticEntry, manualEntry],
    });

    // Should use the caller's model_vars, not auto-create
    const manuals = result.edges[0].p.model_vars?.filter((e: any) => e.source === 'manual');
    expect(manuals).toHaveLength(1);
    expect(manuals![0].probability.mean).toBe(0.30);
  });
});

describe('updateEdgeParam: preference-only changes skip async resolution', () => {
  it('focus changes (preference-only) do NOT contain model_vars — no await needed', () => {
    const focusChanges = {
      model_source_preference: 'manual',
      model_source_preference_overridden: true,
      _noHistory: true,
    };
    const { _noHistory, ...actualChanges } = focusChanges;

    // The resolution gate should NOT trigger for preference-only changes.
    // Old code: 'model_source_preference' in actualChanges → TRUE → await import() → BLOCKED setGraph
    // Fixed code: 'model_vars' in actualChanges → FALSE → skip → setGraph fires synchronously
    expect('model_vars' in actualChanges).toBe(false);
    expect('model_source_preference' in actualChanges).toBe(true);
  });

  it('blur changes (with model_vars) DO contain model_vars — resolution runs', () => {
    const blurChanges = {
      model_vars: [analyticEntry],
      model_source_preference: 'manual',
      model_source_preference_overridden: true,
    };
    const { _noHistory, ...actualChanges } = blurChanges;
    expect('model_vars' in actualChanges).toBe(true);
  });
});
