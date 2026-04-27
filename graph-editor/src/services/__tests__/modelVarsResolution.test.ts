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

// Doc 73b §3.5 / S2 / S3: 'manual' is no longer a valid ModelSource or
// ModelSourcePreference value; user authoring lives at the per-field locks.
const allEntries = [analyticEntry, bayesianGated];

// ── effectivePreference ─────────────────────────────────────────────────────

describe('effectivePreference', () => {
  it('should use edge preference when present', () => {
    expect(effectivePreference('analytic', 'bayesian')).toBe('analytic');
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

  it('graceful-degrade: stale edge `manual` is treated as unpinned (doc 73b OP1)', () => {
    // In-the-wild graphs may still carry 'manual' on read despite the
    // load-time migration. Runtime treats it as undefined so we fall through
    // to graph preference.
    expect(effectivePreference('manual' as any, 'bayesian')).toBe('bayesian');
    expect(effectivePreference('manual' as any, undefined)).toBe('best_available');
  });

  it('graceful-degrade: stale graph `manual` is also treated as unpinned', () => {
    expect(effectivePreference(undefined, 'manual' as any)).toBe('best_available');
  });
});

// ── resolveActiveModelVars ──────────────────────────────────────────────────

describe('resolveActiveModelVars', () => {
  describe('best_available preference', () => {
    it('should select bayesian when gated and present', () => {
      const result = resolveActiveModelVars(allEntries, 'best_available');
      expect(result?.source).toBe('bayesian');
      expect(result?.probability.mean).toBe(0.15);
    });

    it('should fall back to analytic when bayesian gate fails under best_available', () => {
      const entries = [analyticEntry, bayesianFailed];
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
      const result = resolveActiveModelVars(allEntries, 'bayesian');
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
      const result = resolveActiveModelVars(allEntries, 'analytic');
      expect(result?.source).toBe('analytic');
      expect(result?.probability.mean).toBe(0.12);
    });

    it('should return undefined when no analytic entry exists', () => {
      const result = resolveActiveModelVars([bayesianGated], 'analytic');
      expect(result).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should return undefined for undefined model_vars', () => {
      expect(resolveActiveModelVars(undefined, 'best_available')).toBeUndefined();
    });

    it('should return undefined for empty model_vars array', () => {
      expect(resolveActiveModelVars([], 'best_available')).toBeUndefined();
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
    const edgeOnly: ModelVarsEntry = {
      source: 'analytic',
      source_at: '21-Mar-26',
      probability: { mean: 0.20, stdev: 0.05 },
      latency: { mu: 2.0, sigma: 0.6, t95: 35, onset_delta_days: 2 },
    };
    const result = promoteModelVars(edgeOnly);
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
    expect(p.latency?.onset_delta_days).toBe(2.5); // copied from promoted (no override lock)
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

  it('should preserve user-configured onset_delta_days when override lock is set', () => {
    const p: ProbabilityParam = {
      mean: 0,
      stdev: 0,
      latency: {
        mu: 0, sigma: 0, t95: 0, onset_delta_days: 10,
        onset_delta_days_overridden: true,
      },
      model_vars: [bayesianGated], // bayesian has onset_delta_days=2.5
    };

    applyPromotion(p, undefined);

    // User-configured value untouched (lock held)
    expect(p.latency?.onset_delta_days).toBe(10);
    expect(p.latency?.onset_delta_days_overridden).toBe(true);
    // Model output in promoted field
    expect(p.latency?.promoted_onset_delta_days).toBe(2.5);
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

    return { bayesian: result('bayesian'), analytic: result('analytic') };
  }

  const vars: ModelVarsEntry[] = [analyticEntry, bayesianGated];

  it('auto mode: active source is auto-on, others off', () => {
    // best_available with gated Bayesian → Bayesian active
    const s = deriveToggleStates(vars, undefined, false, undefined);
    expect(s.bayesian).toEqual({ pinned: false, autoOn: true, off: false });
    expect(s.analytic).toEqual({ pinned: false, autoOn: false, off: true });
  });

  it('pinned Bayesian: only Bayesian is pinned-on, others off', () => {
    const s = deriveToggleStates(vars, 'bayesian', true, undefined);
    expect(s.bayesian).toEqual({ pinned: true, autoOn: false, off: false });
    expect(s.analytic).toEqual({ pinned: false, autoOn: false, off: true });
  });

  it('pinned Analytic: only Analytic is pinned-on, others off', () => {
    const s = deriveToggleStates(vars, 'analytic', true, undefined);
    expect(s.bayesian).toEqual({ pinned: false, autoOn: false, off: true });
    expect(s.analytic).toEqual({ pinned: true, autoOn: false, off: false });
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
    // Simulate: was pinned, now cleared (edgePreferenceOverridden=false)
    const s = deriveToggleStates(vars, undefined, false, undefined);
    // best_available → Bayesian (gated)
    expect(s.bayesian).toEqual({ pinned: false, autoOn: true, off: false });
    expect(s.analytic).toEqual({ pinned: false, autoOn: false, off: true });
  });
});

// ── Output card focus + edit flow (doc 15 §5.3, §17.3.4) ──────────────────
// Tests the two-phase flow: focus (immediate pin) then blur (value commit).

// Output overtype semantics (doc 73b §6.7 Actions B7c, B7d, B7e — Stage 3) //
// Output overtype writes the per-field value plus its `*_overridden` flag.
// It does not auto-create a `model_vars[manual]` entry, does not pin the
// selector, and leaves the source ledger and selector preference unchanged.
describe('Output overtype semantics (doc 73b §6.7)', () => {
  // Replicate handleOutputCommit from ModelVarsCards.
  // The new contract: emit ONLY {field, field_overridden} — no model_vars
  // mutation, no model_source_preference change.
  function simulateOutputCommit(field: 'mean' | 'stdev', value: number): Record<string, any> {
    if (field === 'mean') return { mean: value, mean_overridden: true };
    return { stdev: value, stdev_overridden: true };
  }

  // Simulate what updateEdgeParam does: merge changes onto edge.p
  function applyChangesToEdge(
    edgeP: Record<string, any>,
    changes: Record<string, any>,
  ): Record<string, any> {
    return { ...edgeP, ...changes };
  }

  it('overtype on `mean` writes value + mean_overridden only', () => {
    const changes = simulateOutputCommit('mean', 0.20);
    expect(changes).toEqual({ mean: 0.20, mean_overridden: true });
    expect('model_vars' in changes).toBe(false);
    expect('model_source_preference' in changes).toBe(false);
    expect('model_source_preference_overridden' in changes).toBe(false);
  });

  it('overtype on `stdev` writes value + stdev_overridden only', () => {
    const changes = simulateOutputCommit('stdev', 0.05);
    expect(changes).toEqual({ stdev: 0.05, stdev_overridden: true });
    expect('model_vars' in changes).toBe(false);
  });

  it('overtype does NOT auto-create a model_vars[manual] entry', () => {
    const beforeP = {
      model_vars: [analyticEntry, bayesianGated],
      mean: 0.12, stdev: 0.03,
    };
    const afterP = applyChangesToEdge(beforeP, simulateOutputCommit('mean', 0.20));
    // model_vars unchanged — no synthetic entry was added.
    expect(afterP.model_vars).toEqual(beforeP.model_vars);
    // No 'manual' source ever appears.
    expect(afterP.model_vars.some((e: any) => e.source === 'manual')).toBe(false);
  });

  it('overtype does NOT pin the selector', () => {
    const beforeP = {
      model_vars: [analyticEntry, bayesianGated],
      mean: 0.12, stdev: 0.03,
    };
    const afterP = applyChangesToEdge(beforeP, simulateOutputCommit('mean', 0.20));
    // Selector preference remains absent (auto/quality-gated).
    expect(afterP.model_source_preference).toBeUndefined();
    expect(afterP.model_source_preference_overridden).toBeUndefined();
  });

  it('locked overtype: mean stays sticky (the lock is the canonical authoring mechanism)', () => {
    // After overtype, mean_overridden=true; the active source resolution is
    // unchanged, but lock-respecting writers (Stage 5) will skip rewriting mean.
    const beforeP = {
      model_vars: [analyticEntry, bayesianGated],
      mean: 0.12, stdev: 0.03,
    };
    const afterP = applyChangesToEdge(beforeP, simulateOutputCommit('mean', 0.20));
    expect(afterP.mean_overridden).toBe(true);
    expect(afterP.mean).toBe(0.20);
    // Active source resolution untouched — best_available still picks gated bayesian.
    const pref = effectivePreference(afterP.model_source_preference, undefined);
    const active = resolveActiveModelVars(afterP.model_vars, pref);
    expect(active?.source).toBe('bayesian');
  });
});
