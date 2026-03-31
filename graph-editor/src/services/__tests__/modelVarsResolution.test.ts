import { describe, it, expect } from 'vitest';
import {
  resolveActiveModelVars,
  effectivePreference,
  promoteModelVars,
  applyPromotion,
} from '../modelVarsResolution';
import type { ModelVarsEntry, ProbabilityParam } from '../../types';

// ── Fixtures ────────────────────────────────────────────────────────────────

const analyticEntry: ModelVarsEntry = {
  source: 'analytic',
  source_at: '20-Mar-26',
  probability: { mean: 0.12, stdev: 0.03 },
  latency: {
    mu: 2.5,
    sigma: 0.8,
    t95: 45,
    onset_delta_days: 3,
    path_mu: 3.1,
    path_sigma: 0.9,
    path_t95: 60,
  },
};

const bayesianGated: ModelVarsEntry = {
  source: 'bayesian',
  source_at: '21-Mar-26',
  probability: { mean: 0.15, stdev: 0.02 },
  latency: {
    mu: 2.3,
    sigma: 0.7,
    t95: 40,
    onset_delta_days: 2.5,
    path_mu: 2.9,
    path_sigma: 0.85,
    path_t95: 55,
  },
  quality: {
    rhat: 1.01,
    ess: 800,
    divergences: 0,
    evidence_grade: 3,
    gate_passed: true,
  },
};

const bayesianFailed: ModelVarsEntry = {
  ...bayesianGated,
  quality: {
    rhat: 1.15,
    ess: 120,
    divergences: 5,
    evidence_grade: 1,
    gate_passed: false,
  },
};

const manualEntry: ModelVarsEntry = {
  source: 'manual',
  source_at: '21-Mar-26',
  probability: { mean: 0.20, stdev: 0.05 },
  latency: {
    mu: 2.0,
    sigma: 0.6,
    t95: 35,
    onset_delta_days: 2,
  },
};

const allThree = [analyticEntry, bayesianGated, manualEntry];

// ── effectivePreference ─────────────────────────────────────────────────────

describe('effectivePreference', () => {
  it('should use edge preference when present', () => {
    expect(effectivePreference('manual', 'bayesian')).toBe('manual');
  });

  it('should fall back to graph preference when edge is undefined', () => {
    expect(effectivePreference(undefined, 'analytic')).toBe('analytic');
  });

  it('should default to best_available when both are undefined', () => {
    expect(effectivePreference(undefined, undefined)).toBe('best_available');
  });

  it('should prefer edge over graph even when edge is best_available', () => {
    expect(effectivePreference('best_available', 'bayesian')).toBe('best_available');
  });
});

// ── resolveActiveModelVars ──────────────────────────────────────────────────

describe('resolveActiveModelVars', () => {
  describe('best_available preference', () => {
    it('should select bayesian when gated and present', () => {
      const result = resolveActiveModelVars(allThree, 'best_available');
      expect(result?.source).toBe('bayesian');
      expect(result?.probability.mean).toBe(0.15);
    });

    it('should fall back to analytic when bayesian gate fails under best_available', () => {
      const entries = [analyticEntry, bayesianFailed, manualEntry];
      const result = resolveActiveModelVars(entries, 'best_available');
      expect(result?.source).toBe('analytic');
    });

    it('should select analytic when no bayesian entry exists', () => {
      const result = resolveActiveModelVars([analyticEntry], 'best_available');
      expect(result?.source).toBe('analytic');
    });
  });

  describe('bayesian preference', () => {
    it('should select bayesian when gated', () => {
      const result = resolveActiveModelVars(allThree, 'bayesian');
      expect(result?.source).toBe('bayesian');
    });

    it('should return bayesian even when gate fails (user pin overrides gate)', () => {
      const entries = [analyticEntry, bayesianFailed];
      const result = resolveActiveModelVars(entries, 'bayesian');
      expect(result?.source).toBe('bayesian');
      expect(result?.probability.mean).toBe(0.15);
    });

    it('should fall back to analytic when no bayesian entry exists', () => {
      const result = resolveActiveModelVars([analyticEntry], 'bayesian');
      expect(result?.source).toBe('analytic');
    });
  });

  describe('analytic preference', () => {
    it('should select analytic even when gated bayesian is available', () => {
      const result = resolveActiveModelVars(allThree, 'analytic');
      expect(result?.source).toBe('analytic');
      expect(result?.probability.mean).toBe(0.12);
    });

    it('should return undefined when no analytic entry exists', () => {
      const result = resolveActiveModelVars([bayesianGated, manualEntry], 'analytic');
      expect(result).toBeUndefined();
    });
  });

  describe('manual preference', () => {
    it('should select manual entry when present', () => {
      const result = resolveActiveModelVars(allThree, 'manual');
      expect(result?.source).toBe('manual');
      expect(result?.probability.mean).toBe(0.20);
    });

    it('should fall through to best_available when no manual entry exists', () => {
      const entries = [analyticEntry, bayesianGated];
      const result = resolveActiveModelVars(entries, 'manual');
      expect(result?.source).toBe('bayesian');
    });

    it('should fall through to analytic when no manual and bayesian gate failed', () => {
      const entries = [analyticEntry, bayesianFailed];
      const result = resolveActiveModelVars(entries, 'manual');
      expect(result?.source).toBe('analytic');
    });

    it('should fall through to bayesian when no manual and bayesian gate passed', () => {
      const entries = [analyticEntry, bayesianGated];
      const result = resolveActiveModelVars(entries, 'manual');
      expect(result?.source).toBe('bayesian');
    });
  });

  describe('edge cases', () => {
    it('should return undefined for undefined model_vars', () => {
      expect(resolveActiveModelVars(undefined, 'best_available')).toBeUndefined();
    });

    it('should return undefined for empty model_vars array', () => {
      expect(resolveActiveModelVars([], 'best_available')).toBeUndefined();
    });

    it('should return undefined when only manual exists and preference is analytic', () => {
      expect(resolveActiveModelVars([manualEntry], 'analytic')).toBeUndefined();
    });

    it('should fall back to analytic when bayesian has no quality data (best_available respects gate)', () => {
      const noQuality: ModelVarsEntry = {
        source: 'bayesian',
        source_at: '21-Mar-26',
        probability: { mean: 0.15, stdev: 0.02 },
      };
      const result = resolveActiveModelVars([analyticEntry, noQuality], 'best_available');
      expect(result?.source).toBe('analytic');
    });

    it('should select bayesian when explicitly pinned regardless of gate', () => {
      const result = resolveActiveModelVars([analyticEntry, bayesianFailed], 'bayesian');
      expect(result?.source).toBe('bayesian');
    });
  });
});

// ── promoteModelVars ────────────────────────────────────────────────────────

describe('promoteModelVars', () => {
  it('should return undefined for undefined entry', () => {
    expect(promoteModelVars(undefined)).toBeUndefined();
  });

  it('should promote probability fields', () => {
    const result = promoteModelVars(analyticEntry);
    expect(result?.mean).toBe(0.12);
    expect(result?.stdev).toBe(0.03);
    expect(result?.activeSource).toBe('analytic');
  });

  it('should promote latency fields when present', () => {
    const result = promoteModelVars(bayesianGated);
    expect(result?.latency?.mu).toBe(2.3);
    expect(result?.latency?.sigma).toBe(0.7);
    expect(result?.latency?.t95).toBe(40);
    expect(result?.latency?.onset_delta_days).toBe(2.5);
    expect(result?.latency?.path_mu).toBe(2.9);
    expect(result?.latency?.path_sigma).toBe(0.85);
    expect(result?.latency?.path_t95).toBe(55);
  });

  it('should omit latency when entry has no latency block', () => {
    const probOnly: ModelVarsEntry = {
      source: 'analytic',
      source_at: '20-Mar-26',
      probability: { mean: 0.5, stdev: 0.1 },
    };
    const result = promoteModelVars(probOnly);
    expect(result?.mean).toBe(0.5);
    expect(result?.latency).toBeUndefined();
  });

  it('should omit path-level fields when not present in entry', () => {
    const result = promoteModelVars(manualEntry);
    expect(result?.latency?.mu).toBe(2.0);
    expect(result?.latency?.path_mu).toBeUndefined();
    expect(result?.latency?.path_sigma).toBeUndefined();
    expect(result?.latency?.path_t95).toBeUndefined();
  });
});

// ── applyPromotion ──────────────────────────────────────────────────────────

describe('applyPromotion', () => {
  it('should write promoted scalars onto ProbabilityParam', () => {
    const p: ProbabilityParam = {
      mean: 0,
      stdev: 0,
      latency: {
        mu: 0, sigma: 0, t95: 0, onset_delta_days: 0,
      },
      model_vars: [analyticEntry, bayesianGated],
    };

    const source = applyPromotion(p, undefined);

    expect(source).toBe('bayesian');
    // p.mean and p.stdev are per-query display quantities computed by the
    // topo pass / pipeline — NOT written by applyPromotion.
    expect(p.mean).toBe(0); // unchanged
    expect(p.stdev).toBe(0); // unchanged
    expect(p.latency?.mu).toBe(2.3);
    expect(p.latency?.sigma).toBe(0.7);
    // Doc 19: t95 and path_t95 write to promoted_* fields to avoid circular dependency.
    expect(p.latency?.t95).toBe(0); // user-configured value unchanged
    expect(p.latency?.promoted_t95).toBe(40); // model output in promoted field
    expect(p.latency?.onset_delta_days).toBe(0); // user-configured value unchanged
    expect(p.latency?.promoted_onset_delta_days).toBe(2.5); // model output in promoted field
    expect(p.latency?.path_mu).toBe(2.9);
    expect(p.latency?.path_sigma).toBe(0.85);
    expect(p.latency?.path_t95).toBeUndefined(); // user-configured value unchanged (was not set)
    expect(p.latency?.promoted_path_t95).toBe(55); // model output in promoted field
  });

  it('should respect edge-level model_source_preference', () => {
    const p: ProbabilityParam = {
      mean: 0,
      stdev: 0,
      latency: { mu: 0, sigma: 0, t95: 0, onset_delta_days: 0 },
      model_vars: [analyticEntry, bayesianGated],
      model_source_preference: 'analytic',
    };

    const source = applyPromotion(p, 'bayesian');

    expect(source).toBe('analytic');
    expect(p.mean).toBe(0); // unchanged — topo pass computes p.mean
  });

  it('should respect graph-level preference when edge has none', () => {
    const p: ProbabilityParam = {
      mean: 0,
      stdev: 0,
      model_vars: [analyticEntry, bayesianGated],
    };

    const source = applyPromotion(p, 'analytic');

    expect(source).toBe('analytic');
    expect(p.mean).toBe(0); // unchanged — topo pass computes p.mean
  });

  it('should return undefined and not mutate when model_vars is empty', () => {
    const p: ProbabilityParam = {
      mean: 0.99,
      stdev: 0.01,
    };

    const source = applyPromotion(p, undefined);

    expect(source).toBeUndefined();
    expect(p.mean).toBe(0.99);
    expect(p.stdev).toBe(0.01);
  });

  it('should preserve user-configured t95 when Bayesian produces a different value (doc 19)', () => {
    // Simulates: user locked t95=14, Bayesian posterior produces t95=85.
    // Promotion must NOT overwrite the user's value.
    const p: ProbabilityParam = {
      mean: 0,
      stdev: 0,
      latency: {
        mu: 0, sigma: 0, t95: 14, onset_delta_days: 0,
        t95_overridden: true,
        path_t95: 25,
        path_t95_overridden: true,
      },
      model_vars: [bayesianGated], // bayesian has t95=40, path_t95=55
    };

    applyPromotion(p, undefined);

    // User-configured values untouched
    expect(p.latency?.t95).toBe(14);
    expect(p.latency?.path_t95).toBe(25);
    expect(p.latency?.t95_overridden).toBe(true);
    expect(p.latency?.path_t95_overridden).toBe(true);
    // Model output in promoted fields
    expect(p.latency?.promoted_t95).toBe(40);
    expect(p.latency?.promoted_path_t95).toBe(55);
  });

  it('should not write latency when ProbabilityParam has no latency block', () => {
    const p: ProbabilityParam = {
      mean: 0,
      stdev: 0,
      model_vars: [bayesianGated],
    };

    const source = applyPromotion(p, undefined);

    expect(source).toBe('bayesian');
    expect(p.mean).toBe(0); // unchanged — topo pass computes p.mean
    expect(p.latency).toBeUndefined();
  });
});

// ── Toggle visual state derivation (doc 15 §17.3) ─────────────────────────
// These test the exact logic used in ModelVarsCards to determine toggle states.

describe('Toggle visual state derivation (§17.3)', () => {
  // Mirror the derivation logic from ModelVarsCards
  function deriveToggleStates(
    modelVars: ModelVarsEntry[],
    edgePreference: string | undefined,
    edgePreferenceOverridden: boolean,
    graphPreference: string | undefined,
  ) {
    const pref = effectivePreference(
      edgePreference as any,
      graphPreference as any,
    );
    const activeEntry = resolveActiveModelVars(modelVars, pref);
    const activeSource = activeEntry?.source;
    const anyPinned = edgePreferenceOverridden;

    const result = (source: string) => {
      const pinned = edgePreferenceOverridden && edgePreference === source;
      const autoOn = activeSource === source && !anyPinned;
      return { pinned, autoOn, off: !pinned && !autoOn };
    };

    return { bayesian: result('bayesian'), analytic: result('analytic'), manual: result('manual') };
  }

  const vars: ModelVarsEntry[] = [analyticEntry, bayesianGated];

  it('auto mode: active source is auto-on, others off', () => {
    // best_available with gated Bayesian → Bayesian active
    const s = deriveToggleStates(vars, undefined, false, undefined);
    expect(s.bayesian).toEqual({ pinned: false, autoOn: true, off: false });
    expect(s.analytic).toEqual({ pinned: false, autoOn: false, off: true });
    expect(s.manual).toEqual({ pinned: false, autoOn: false, off: true });
  });

  it('pinned Bayesian: only Bayesian is pinned-on, others off', () => {
    const s = deriveToggleStates(vars, 'bayesian', true, undefined);
    expect(s.bayesian).toEqual({ pinned: true, autoOn: false, off: false });
    expect(s.analytic).toEqual({ pinned: false, autoOn: false, off: true });
    expect(s.manual).toEqual({ pinned: false, autoOn: false, off: true });
  });

  it('pinned Analytic: only Analytic is pinned-on, others off', () => {
    const s = deriveToggleStates(vars, 'analytic', true, undefined);
    expect(s.bayesian).toEqual({ pinned: false, autoOn: false, off: true });
    expect(s.analytic).toEqual({ pinned: true, autoOn: false, off: false });
    expect(s.manual).toEqual({ pinned: false, autoOn: false, off: true });
  });

  it('pinned Bayesian with gate fail: Bayesian pinned-on even though resolution falls back to analytic', () => {
    const ungated: ModelVarsEntry = { ...bayesianGated, quality: { ...bayesianGated.quality!, gate_passed: false } };
    const s = deriveToggleStates([analyticEntry, ungated], 'bayesian', true, undefined);
    // Bayesian is pinned (green toggle) even though activeSource resolved to analytic
    expect(s.bayesian).toEqual({ pinned: true, autoOn: false, off: false });
    expect(s.analytic).toEqual({ pinned: false, autoOn: false, off: true });
  });

  it('graph-level analytic preference: analytic is auto-on', () => {
    const s = deriveToggleStates(vars, undefined, false, 'analytic');
    expect(s.analytic).toEqual({ pinned: false, autoOn: true, off: false });
    expect(s.bayesian).toEqual({ pinned: false, autoOn: false, off: true });
  });

  it('unpin (clear override): reverts to auto mode', () => {
    // Simulate: was pinned to manual, now cleared
    const withManual: ModelVarsEntry[] = [...vars, { source: 'manual', source_at: '21-Mar-26', probability: { mean: 0.5, stdev: 0.1 } }];
    const s = deriveToggleStates(withManual, undefined, false, undefined);
    // best_available → Bayesian (gated), manual is off
    expect(s.bayesian).toEqual({ pinned: false, autoOn: true, off: false });
    expect(s.manual).toEqual({ pinned: false, autoOn: false, off: true });
  });
});

// ── Output card focus + edit flow (doc 15 §5.3, §17.3.4) ──────────────────
// Tests the two-phase flow: focus (immediate pin) then blur (value commit).

describe('Output card focus + edit flow (§5.3, §17.3.4)', () => {
  // Replicate handleOutputFocus from ModelVarsCards
  function simulateOutputFocus(
    edgePreference: string | undefined,
    edgePreferenceOverridden: boolean,
  ): Record<string, any> | null {
    if (edgePreferenceOverridden && edgePreference === 'manual') return null; // already pinned
    return { model_source_preference: 'manual', model_source_preference_overridden: true };
  }

  // Replicate handleOutputEdit from ModelVarsCards
  function simulateOutputEdit(
    modelVars: ModelVarsEntry[],
    promotedMean: number,
    promotedStdev: number,
    field: string,
    value: number,
  ): Record<string, any> {
    const existing = modelVars.find(e => e.source === 'manual');
    const base: ModelVarsEntry = existing ?? {
      source: 'manual',
      source_at: '22-Mar-26',
      probability: { mean: promotedMean, stdev: promotedStdev },
    };
    const updated: ModelVarsEntry = { ...base, source_at: '22-Mar-26' };
    if (field === 'mean' || field === 'stdev') {
      updated.probability = { ...updated.probability, [field]: value };
    } else {
      updated.latency = { ...(updated.latency ?? { mu: 0, sigma: 0, t95: 0, onset_delta_days: 0 }), [field]: value };
    }
    const nextVars = [...modelVars];
    const idx = nextVars.findIndex(e => e.source === 'manual');
    if (idx >= 0) nextVars[idx] = updated; else nextVars.push(updated);
    return { model_vars: nextVars, model_source_preference: 'manual', model_source_preference_overridden: true };
  }

  // Simulate what updateEdgeParam does: merge changes onto edge.p
  function applyChangesToEdge(
    edgeP: Record<string, any>,
    changes: Record<string, any>,
  ): Record<string, any> {
    return { ...edgeP, ...changes };
  }

  it('focus immediately pins to manual before any value change', () => {
    const focusChanges = simulateOutputFocus(undefined, false);
    expect(focusChanges).not.toBeNull();
    expect(focusChanges!.model_source_preference).toBe('manual');
    expect(focusChanges!.model_source_preference_overridden).toBe(true);
  });

  it('focus is idempotent — no-op if already pinned to manual', () => {
    const focusChanges = simulateOutputFocus('manual', true);
    expect(focusChanges).toBeNull();
  });

  it('after focus, toggles show manual pinned + others off', () => {
    const focusChanges = simulateOutputFocus(undefined, false)!;
    // Merge onto edge.p (simulating updateEdgeParam)
    const edgeP = applyChangesToEdge(
      { model_vars: [analyticEntry, bayesianGated], mean: 0.12, stdev: 0.03 },
      focusChanges,
    );

    // Derive toggle states from the updated edge
    const pref = effectivePreference(edgeP.model_source_preference, undefined);
    const active = resolveActiveModelVars(edgeP.model_vars, pref);
    // manual preference but no manual entry → falls back to bestAvailable
    // That's fine — the TOGGLE state is what matters, not the active entry
    const anyPinned = edgeP.model_source_preference_overridden;
    expect(anyPinned).toBe(true);

    // Manual is pinned (green toggle)
    const manualPinned = anyPinned && edgeP.model_source_preference === 'manual';
    expect(manualPinned).toBe(true);

    // Others are OFF (not auto-on, because anyPinned is true)
    const bayesAutoOn = active?.source === 'bayesian' && !anyPinned;
    expect(bayesAutoOn).toBe(false);
    const analyticAutoOn = active?.source === 'analytic' && !anyPinned;
    expect(analyticAutoOn).toBe(false);
  });

  it('full flow: focus → type → blur creates manual entry + stays pinned', () => {
    // Phase 1: focus
    const focusChanges = simulateOutputFocus(undefined, false)!;
    const afterFocus = applyChangesToEdge(
      { model_vars: [analyticEntry], mean: 0.12, stdev: 0.03 },
      focusChanges,
    );
    expect(afterFocus.model_source_preference_overridden).toBe(true);

    // Phase 2: blur with new value
    const editChanges = simulateOutputEdit(afterFocus.model_vars, 0.12, 0.03, 'mean', 0.20);
    const afterEdit = applyChangesToEdge(afterFocus, editChanges);

    // Manual entry exists with edited value
    const manual = afterEdit.model_vars.find((e: any) => e.source === 'manual');
    expect(manual).toBeDefined();
    expect(manual.probability.mean).toBe(0.20);
    expect(manual.probability.stdev).toBe(0.03); // snapshot

    // Still pinned to manual
    expect(afterEdit.model_source_preference).toBe('manual');
    expect(afterEdit.model_source_preference_overridden).toBe(true);

    // Resolution picks manual entry
    const pref = effectivePreference(afterEdit.model_source_preference, undefined);
    const active = resolveActiveModelVars(afterEdit.model_vars, pref);
    expect(active?.source).toBe('manual');
    expect(active?.probability.mean).toBe(0.20);
  });

  it('subsequent edit updates existing manual entry in place', () => {
    const manualEntry: ModelVarsEntry = {
      source: 'manual', source_at: '21-Mar-26',
      probability: { mean: 0.15, stdev: 0.03 },
    };
    const changes = simulateOutputEdit([analyticEntry, manualEntry], 0.15, 0.03, 'stdev', 0.05);

    expect(changes.model_vars).toHaveLength(2);
    const manual = changes.model_vars.find((e: any) => e.source === 'manual');
    expect(manual.probability.mean).toBe(0.15);
    expect(manual.probability.stdev).toBe(0.05);
    expect(changes.model_source_preference_overridden).toBe(true);
  });
});
