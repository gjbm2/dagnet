# CF Machinery Defensive-Coding & Branching Audit

**Date**: 12-May-26
**Branch audited**: `feature/snapshot-db-phase0` (head a3d0ce56)
**Auditor**: read-only audit; no code modified.
**Guiding principle (per user)**: *"No fallbacks within the engine — all defense, if any needed, should be at the perimeter. The engine is a mathematical object and should degenerate algebraically."*

---

## 1. Scope & Methodology

### Docs read in full

- `docs/current/codebase/FORECAST_RUNTIME_ARCHITECTURE.md`
- `docs/current/codebase/FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md`
- `docs/current/codebase/FORECAST_STACK_DATA_FLOW.md`
- Skim: `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`, `PROBABILITY_BLENDING.md`, `EPISTEMIC_DISPERSION_DESIGN.md`, `STATS_SUBSYSTEMS.md`, `PROJECTION_MODE.md`, `DAILY_CONVERSIONS_CHART_ARCHITECTURE.md`, `cohort-cf-defect-and-cli-fe-parity.md`, `post-cf-rebuild-batch-pipeline.md`, `KNOWN_ANTI_PATTERNS.md`, `INVARIANTS.md`.
- Bayes side: `bayes/compiler/{inference,calibration,evidence,topology,model}.py` (skim).

### Directories grepped

- `graph-editor/lib/runner/` (Python CF engine, ~31k LOC) — **primary engine core**.
- `graph-editor/lib/analysis_subject_resolution.py`, `api_handlers.py` — perimeter dispatch.
- `graph-editor/src/services/{statisticalEnhancementService,conditionedForecastService,feTopoMaterialisationService}.ts` — TS-side topo/applier.
- `bayes/compiler/` — Bayes inference engine.

### "Engine core" vs "perimeter" boundary used in this audit

**Engine core** (the mathematical object; must degenerate algebraically):
- `cohort_forecast_v3.py` — runtime, selected-Cohort reducer, row projector, selected A-clock evidence builders.
- `primitives.py`, `primitive_conditioning.py`, `primitive_readout.py`, `primitive_evidence.py`, `primitive_residual_guard.py` — primitive substrate.
- `subject_span_composer.py`, `prefix_arrival.py`, `timing_span.py`, `span_kernel.py`, `span_evidence.py`, `span_upstream.py` — composition kernels.
- `confidence_bands.py`, `epistemic_bands.py` — dispersion projection.
- `funnel_engine.py`, `daily_conversions_derivation.py`, `cohort_maturity_derivation.py`, `conversion_rate_derivation.py` — analytic-mode engines (the "hold-outs" the user flagged).
- `bayes/compiler/inference.py`, `bayes/compiler/calibration.py` — Bayes likelihood/calibration math.

**Perimeter** (allowed to validate / coerce / refuse):
- `forecast_preparation.py`, `forecast_runtime.py` (where they assemble the request bundle from graph + DSL).
- `request_envelope.py`, `evidence_adapters.py`, `edge_binding_descriptor.py` — translate inputs.
- `api_handlers.py`, `analysis_subject_resolution.py` — HTTP boundary / subject resolution.
- TS-side `statisticalEnhancementService.ts`, `feTopoMaterialisationService.ts`, `conditionedForecastService.ts`.

Note: `forecast_runtime.py` and `forecast_preparation.py` straddle the boundary — most of their code is perimeter-grade (DSL parsing, fetch envelope, scenario translation) but they also reach into engine math at a few points (e.g. `_resolve_evidence_role`).

---

## 2. Architecture Summary as Understood

The post-73n CF runtime is a **mass-first selected-Cohort reducer** sitting inside the `[I10]/[I12]` boundary. Flow:

1. **Perimeter** (preparation + envelope): given a scenario graph + query DSL, materialise `evidence_superset_rows`, resolve carrier and subject spans, build arrival maps.
2. **Engine** (`build_resolved_cf_runtime` in `cohort_forecast_v3.py`):
   - For each parameterised edge: prepare a `ConditionedTransitionPrimitive` once at the single conditioning locus (`primitive_conditioning.condition_primitive`). Latent timing uses joint draw-family particles; degenerate non-latent timing is `F == 1` of the same shape.
   - Compose `composed_subject = X -> end` and `composed_carrier = A -> X` (identity carrier when `population_root == X`).
   - Build `SelectedAClockEvidence` from primitive-bound observed rows + join-conditioned carrier backmap.
3. **Reducer** (`_selected_cohort_group_rate_draws`): for each particle s, each row τ: sum X and Y mass across selected Cohorts, divide once. Pop C / Pop D extend mass beyond the frontier under the factorised representation.
4. **Row projection** (`_project_runtime_rows`): emit E+F midpoint/fan, model overlays, observed evidence — but never mix them.

The contract — repeated in three docs — is that rate cells with zero denominator are **`NaN`**, not zero; identity carrier is **data, not a route**; the runtime never widens DB fetches; reductions never repair upstream non-monotonicity by sorting/clipping.

---

## 3. Findings

Severity rubric:
- **HIGH** — defeats the "algebraic degenerate" contract: corrupts math, hides bugs, or silently switches mode.
- **MEDIUM** — defensive code that masks invalid inputs without changing answers when inputs are clean, but blocks fail-fast diagnosis.
- **LOW** — defensive coding around diagnostic / observability paths; cosmetic but worth removing.

### HIGH severity

#### H-1. Monotone repair clamp inside the engine math
**Files / lines**: [cohort_forecast_v3.py:3587](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3587)

```python
# Operator-boundary monotone repair. The evaluator
# consumes non-negative increments, not raw noisy diffs.
rate = min(1.0, max(prev_rate, max(0.0, float(rate))))
```

**Category**: 7 (Defensive clamping). Also Category 1 (silent fallback) — `prev_rate` is substituted whenever `rate < prev_rate`, hiding the upstream non-monotonicity entirely.

**Why this corrupts**: the architecture explicitly says (FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md §A.8): *"The aggregate is a projection of the selected prefix. It must not repair upstream non-monotonicity by sorting, clipping, cumulative-max, or smoothing."* This clamp is exactly that, applied inside the mass-projection loop in `_project_active_cohort_x_y_mass` (the routine that builds `X_prefix` / `Y_prefix`). If a downstream rate dips below `prev_rate`, that is a signal of an upstream defect (e.g. a window-mode evidence row arriving out of order) — the clamp silently buries it.

**Remediation**: drop the clamp, let `inc_rate` be negative, surface in provenance as a non-monotonic input. The reducer-side `NaN` propagation will then expose the issue end-to-end.

---

#### H-2. Funnel engine substitutes `0.0` for every missing CF scalar
**Files / lines**: [funnel_engine.py:243, 254, 255](../../graph-editor/lib/runner/funnel_engine.py#L243), [funnel_engine.py:176-178, 185-186, 192-193](../../graph-editor/lib/runner/funnel_engine.py#L176)

```python
# line 243
p_means = np.array([float(e.get('p_mean') or 0.0) for e in cf_per_edge])
# line 254-255
p_mean = float(cf_edge.get('p_mean') or 0.0)
p_sd_pred = float(cf_edge.get('p_sd') or 0.0)
# line 176-178 (in compute_bars_f)
if resolved is None:
    p_means[j] = 0.0
    p_draws[j, :] = 0.0
    continue
```

**Category**: 2 (`or 0.0` fallback for missing data), 3 (`if x is None: return ...` inside engine math), 12 (empty-collection guard).

**Why this corrupts**: the funnel computes `np.cumprod(p_means)` — a single `0.0` truncates the entire path to zero downstream, masquerading as a real "no conversion" answer. A missing `p_mean` is **unknown**, not zero; algebraically the cumprod should be `NaN`. Worse, the `if resolved is None: ... continue` in `compute_bars_f` skips a stage and silently inserts `0.0` rather than raising — the funnel rendered to the user will look identical to a genuine zero-conversion funnel.

The user explicitly flagged "funnel" as a hold-out. This is one of the most egregious in the engine.

**Remediation**: missing `p_mean` should propagate as `NaN`; perimeter must validate that all path edges have CF outputs before invoking the funnel engine, or the function must refuse with a typed error.

---

#### H-3. Daily-conversions reducer substitutes `0` for missing `x`/`y`
**Files / lines**: [daily_conversions_derivation.py:65, 81, 82](../../graph-editor/lib/runner/daily_conversions_derivation.py#L65)

```python
current_Y = snap.get('y') or snap.get('Y') or 0
...
latest_x = latest.get('x') or latest.get('X') or 0
latest_y = latest.get('y') or latest.get('Y') or 0
```

**Category**: 2 (numerical fallback). Also Category 5 (case fork on schema) — checking both `'y'` and `'Y'` is a schema-shape branch the perimeter should have normalised.

**Why this corrupts**: per [DAILY_CONVERSIONS_CHART_ARCHITECTURE.md], a snapshot row without `y` is a defect, not a zero count. Treating it as 0 collapses `delta_Y = current_Y - prev_Y` to `-prev_Y` (a *negative* daily count that the next line filters out with `if delta_Y > 0`, again silently swallowing). The case-insensitive `y`/`Y` fork should not exist in the engine — pick one casing at the perimeter.

User flagged daily-conversions as a hold-out. This confirms.

**Remediation**: require canonical `x` / `y` keys; raise if absent. Move casing normalisation to the snapshot adapter.

---

#### H-4. `forecast_y` floored to zero after evidence subtraction
**Files / lines**: [cohort_forecast_v3.py:5347-5353](../../graph-editor/lib/runner/cohort_forecast_v3.py#L5347)

```python
forecast_y_tau = max(0.0, float(forecast_y_tau) - float(evidence_y_tau))
forecast_x_tau = max(0.0, float(forecast_x_tau) - float(evidence_x_tau))
```

**Category**: 7 (defensive clamping).

**Why this corrupts**: if `evidence_y_tau > forecast_y_tau`, the projection and the evidence disagree — that is diagnostic gold. `max(0, ...)` buries it. Either the carrier projection is too pessimistic, or the evidence has been double-counted somewhere, or the selected Cohort set drifted between A.8 and A.9. The architecture's own A.8 invariant says *"`evidence_y == 0` with positive `evidence_x` is a real zero rate"* — by symmetry, negative residuals are real signals.

**Remediation**: allow negative residual to flow; emit warning provenance; let surprise-gauge / completeness diagnostics consume the signed delta.

---

#### H-5. Identity-carrier vs active-carrier branching pervasive across reducer
**Files / lines**: pervasive in `cohort_forecast_v3.py` — `is_identity_carrier`/`identity_carrier` referenced at lines [4161](../../graph-editor/lib/runner/cohort_forecast_v3.py#L4161), [4229](../../graph-editor/lib/runner/cohort_forecast_v3.py#L4229), [4486](../../graph-editor/lib/runner/cohort_forecast_v3.py#L4486), [4695, 4710, 4724, 4747, 4820, 4842, 4884, 4942, 4987, 4999](../../graph-editor/lib/runner/cohort_forecast_v3.py#L4695), [5196, 5340](../../graph-editor/lib/runner/cohort_forecast_v3.py#L5196). The selected-Cohort reducer at A.9 also branches on `population_root == X` to set `future_x_pool = 0` and `Y_from_C = 0`.

**Category**: 5 (mode fork inside engine), 6 (multiple code paths for what should be one).

**Why this corrupts**: [FORECAST_RUNTIME_ARCHITECTURE.md §4] is explicit: *"Identity carrier is data, not a route. window() and cohort(A = X) are degeneracies of the same runtime object."* The semantic pseudocode (A.9) describes identity as the algebraic case `composed_carrier = identity ⇒ Pop C = 0`, `future_x_pool = 0`. In code, this is implemented as 20+ `if is_identity_carrier:` branches and a parallel `_synthesize_identity_carrier_observed_surface` helper that duplicates logic the active path also performs.

This is the single largest unification opportunity. An identity composed-carrier object (CDF that is a Dirac at τ=0, reach = 1) makes the active code path the only path; Pop C convolution becomes `convolve(δ_0, subject) = subject(0) = 0` automatically.

**Remediation**: build an identity `ComposedPrimitiveSpan` once, feed it through the same active path, delete the synthesis helper and all `is_identity_carrier` branches. This is a substantial refactor but the cleanest possible expression of the user's principle.

---

#### H-6. Bayes calibration clips probabilities into open interval
**Files / lines**: [bayes/compiler/calibration.py:218, 292](../../bayes/compiler/calibration.py#L218); [bayes/compiler/inference.py:578, 779, 787, 799, 821](../../bayes/compiler/inference.py#L578)

```python
# calibration.py:218
p_eff = np.clip(p_draws * compl, 1e-6, 1.0 - 1e-6)
# calibration.py:292
q_mat = np.clip(p_draws[None, :] * delta_f_mat / surv_mat, 1e-6, 1.0 - 1e-6)
# inference.py:578
p_implied = _np.clip(p_implied, 0.001, 0.999)
```

**Category**: 7 (defensive clamping inside the likelihood).

**Why this corrupts**: the `1e-6` clamps are not mathematically motivated by the Beta-Binomial model — they exist to keep `log(p)` finite. A `p_eff = 0` should be a real signal that an edge cannot fire under this completeness; clamping to `1e-6` artificially adds log-likelihood mass that biases the posterior. The `0.001/0.999` clip in `p_implied` is worse — it's an order of magnitude wider and explicitly stated as "clip implied p before fitting kappa" in surrounding context.

The principled fix is to handle the boundary in log-space: where `q == 0`, the corresponding likelihood term is zero contribution if `k == 0` else negative infinity; the model should refuse rather than clip.

**Remediation**: replace clips with log-space-aware likelihood that handles boundary algebraically. At minimum, document each clip's mathematical justification or remove.

---

#### H-7. `getattr(primitive, 'p', 0.0) or 0.0` cascade in span timing
**Files / lines**: [timing_span.py:256-281, 353-375](../../graph-editor/lib/runner/timing_span.py#L256)

```python
p = float(getattr(primitive, 'p', 0.0) or 0.0)
mu = float(getattr(primitive, 'mu', 0.0) or 0.0)
...
sigma = float(getattr(primitive, 'sigma', 0.0) or 0.0)
onset = float(getattr(primitive, 'onset', 0.0) or 0.0)
```

**Category**: 9 (`hasattr`/`getattr` polymorphism), 2 (`or 0.0` fallback), 10 (fallback chain).

**Why this corrupts**: this code reads attributes off "primitive" objects whose type is not enforced — the double fallback (`getattr` default `0.0` then `or 0.0`) treats `None`, missing attribute, and zero as equivalent. If a primitive has `p = None` because conditioning legitimately returned a prior-only refusal, treating that as `p = 0` produces a span timing that integrates to zero — i.e. the engine silently emits "no flow possible" when the truth is "no information".

**Remediation**: define a strict dataclass for the primitive shape this function consumes; require non-Optional fields; let the perimeter convert.

---

### MEDIUM severity

#### M-1. Broad `except Exception: pass` on diagnostic writes
**Files / lines**: [cohort_forecast_v3.py:4147-4154 (`_record_diag`)](../../graph-editor/lib/runner/cohort_forecast_v3.py#L4147), [cohort_forecast_v3.py:4527-4530](../../graph-editor/lib/runner/cohort_forecast_v3.py#L4527), [cohort_forecast_v3.py:5659](../../graph-editor/lib/runner/cohort_forecast_v3.py#L5659), [cohort_forecast_v3.py:5895, 5899](../../graph-editor/lib/runner/cohort_forecast_v3.py#L5895), [forecast_state.py:1794](../../graph-editor/lib/runner/forecast_state.py#L1794)

```python
try:
    runtime.selected_y_prefix = y_prefix
except Exception:
    pass
```

**Category**: 1 (try/except swallowing).

**Why this is mid-tier**: these are diagnostic / provenance writes, not the math path. But the contract says "the seam at frontier dovetails by identity only when A.8 and A.9 share that prefix" — if setting `runtime.selected_y_prefix` ever fails (it shouldn't), A.9 will silently use a stale or unset prefix and the seam will gap. The swallow turns a sharp invariant violation into a slow silent drift.

**Remediation**: replace with attribute assignment unconditionally (it's a Python object; assignment doesn't raise). The try/except is cargo-cult.

---

#### M-2. `np.clip(cdf, 0.0, 1.0)` in convolution outputs
**Files / lines**: [cohort_forecast_v3.py:1603](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1603), [primitive_conditioning.py:1318](../../graph-editor/lib/runner/primitive_conditioning.py#L1318), [prefix_arrival.py:354](../../graph-editor/lib/runner/prefix_arrival.py#L354)

```python
return np.clip(convolved, 0.0, 1.0)
return np.clip(cdf, 0.0, 1.0)
pmf = np.clip(pmf, 0.0, None)
```

**Category**: 7 (defensive clamping).

**Why this is mid-tier**: a CDF mathematically *is* in `[0,1]`; clipping is a no-op when inputs are correct. But if numerical drift pushes a value to `-1e-12` or `1.0 + 1e-12`, the clip silently hides the drift. For an engine claiming to be a mathematical object, that drift should surface in provenance / diagnostics.

**Remediation**: assert / soft-warn on out-of-range and let the algebra continue; or document the precise numerical-stability rationale alongside each clip.

---

#### M-3. `min(1.0, sum_k / sum_n)` rate cap
**Files / lines**: [cohort_forecast_v3.py:3293, 3338, 3355, 5421](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3293)

```python
latest_rate = max(0.0, min(1.0, float(k_val) / float(n_val)))
...
max(0.0, min(1.0, sum_k / sum_n))
```

**Category**: 7.

**Why**: `k > n` is a real data error (duplicate counting, slice overlap). Clamping it to 1 hides the bug forever. The reducer would happily proceed with rate=1 even though something is fundamentally wrong with the row.

**Remediation**: assert `k <= n` at the perimeter (the merge step); engine math then never sees out-of-range inputs.

---

#### M-4. `confidence_bands.py` clips at sample edges
**Files / lines**: [confidence_bands.py:97, 110-111](../../graph-editor/lib/runner/confidence_bands.py#L97), [span_kernel.py:404, 410](../../graph-editor/lib/runner/span_kernel.py#L404)

```python
rates.append(max(0.0, min(1.0, p * cdf)))
samples[:, 0] = np.clip(samples[:, 0], 1e-6, 1 - 1e-6)  # p
samples[:, 2] = np.clip(samples[:, 2], 0.01, 20.0)       # sigma > 0
draws[:, :, 0] = np.clip(draws[:, :, 0], 1e-6, 1 - 1e-6)
np.clip(draws[:, :, 2], 0.01, 20.0)
```

**Category**: 7, 8.

**Why**: `p * cdf` cannot exceed 1 algebraically (both are in [0,1]); the clip is dead code under correct inputs. The `1e-6` and `0.01` clips on sample draws are again log-space hygiene that should be addressed in log-space, not by clipping samples.

**Remediation**: same as H-6 — make clips conditional on a `strict_math` flag and emit provenance when they fire.

---

#### M-5. `forecast_runtime._resolve_evidence_role` swallows date parse
**Files / lines**: [forecast_runtime.py:1339-1344](../../graph-editor/lib/runner/forecast_runtime.py#L1339)

```python
try:
    from analysis_subject_resolution import _resolve_date
    resolved = _resolve_date(raw)
except Exception:
    return None
return resolved or None
```

**Category**: 1 (broad except), 2 (`or None` chain).

**Why**: broad import + parse swallow. The import failure path (`analysis_subject_resolution` missing) is a deployment defect; the parse failure path is a DSL defect. Conflating them silences both.

**Remediation**: lift import to module top; let `_resolve_date` raise typed errors; perimeter handles.

---

#### M-6. `cohort_forecast_v3._weighted_evidence_provenance` swallows on `to_provenance_dict`
**Files / lines**: [cohort_forecast_v3.py:2867-2870](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2867)

```python
try:
    prov = primitive.to_provenance_dict()
except Exception:
    return None
```

**Category**: 1.

**Why**: if `to_provenance_dict()` raises, that is a real bug in the primitive type. Returning `None` propagates a "no provenance" signal that downstream readers interpret as "primitive absent" — a distinct condition. The two should not collapse.

**Remediation**: let it raise; perimeter / handler catches and reports.

---

#### M-7. Engine-side `isinstance` dispatch on dates / scalars
**Files / lines**: [cohort_forecast_v3.py:~15 locations](../../graph-editor/lib/runner/cohort_forecast_v3.py); [daily_conversions_derivation.py:45, 157-159](../../graph-editor/lib/runner/daily_conversions_derivation.py#L45); [cohort_maturity_derivation.py:72-73, 107-108, 283, 287](../../graph-editor/lib/runner/cohort_maturity_derivation.py#L72); [span_evidence.py: 6 locations](../../graph-editor/lib/runner/span_evidence.py)

```python
if isinstance(anchor, str):
    anchor = date.fromisoformat(anchor)
```

**Category**: 4 (isinstance dispatch on schema shape).

**Why**: every engine entry point coerces string-vs-date. The schema should be normalised once at the perimeter; the engine should accept typed `date` only.

**Remediation**: enforce `date` (not `str | date`) in the engine signatures; perimeter coerces.

---

#### M-8. `compute_bars_e`: missing `n_0` returns all-zero bars
**Files / lines**: [funnel_engine.py:125-131](../../graph-editor/lib/runner/funnel_engine.py#L125)

```python
if not isinstance(n_0, (int, float)) or n_0 <= 0:
    # No evidence; return None for all downstream stages
    for _ in range(N):
        bar.append(0.0)
        lo.append(None)
        hi.append(None)
    return FunnelStageBars(bar=bar, lo=lo, hi=hi)
```

**Category**: 4 (isinstance), 12 (empty-collection guard returning sentinel), 3 (early return).

**Why**: a missing `n_0` should surface as `bar=NaN` (unknown), not `0.0` (zero conversions). A consumer rendering this funnel sees a different chart than reality.

**Remediation**: `NaN` propagation; or refuse with typed error at perimeter.

---

#### M-9. `epistemic_bands._safe_int` and related parsers
**Files / lines**: [epistemic_bands.py:55-73](../../graph-editor/lib/runner/epistemic_bands.py#L55), [epistemic_bands.py:147-150, 154, 242-243](../../graph-editor/lib/runner/epistemic_bands.py#L147)

```python
fit_history = stashed.get('fit_history') or []
current_slices = stashed.get('slices') or {}
... (stashed.get('hdi_level') or 0.90)
...
evidence_grade=int(entry_slice.get('evidence_grade', 0) or 0),
```

**Category**: 2, 10 (fallback chain).

**Why**: `epistemic_bands` is the engine surface that builds the historical band ribbon. Treating missing `fit_history` as `[]` returns an empty ribbon — visually indistinguishable from "no edge ever fit". A consumer cannot tell. Default `hdi_level=0.90` is reasonable but should be a function parameter, not an inline fallback.

**Remediation**: refuse empty `fit_history` with a typed sentinel `EpistemicBandsUnavailable`; lift `hdi_level` default to function signature.

---

### LOW severity

#### L-1. Diagnostic file writes wrapped in broad try/except
**Files / lines**: [cohort_forecast_v3.py:2814-2817](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2814) (`from evidence_merge import SliceFamily`), [cohort_forecast_v3.py:5643-5660](../../graph-editor/lib/runner/cohort_forecast_v3.py#L5643) (DIAG dump to `/tmp`), [forecast_state.py:1790-1795](../../graph-editor/lib/runner/forecast_state.py#L1790) (`/tmp/v3_forensic.json`), [cohort_forecast_v3.py:1373](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1373) (envelope construction).

**Category**: 1, 11.

**Why**: these are observability lines. Acceptable but should be conditional on diagnostic mode and use specific exception types.

---

#### L-2. `int(...) or 0` pattern in candidate translation
**Files / lines**: [cohort_forecast_v3.py:939-940](../../graph-editor/lib/runner/cohort_forecast_v3.py#L939)

```python
int(getattr(candidate, 'n', 0) or 0),
int(getattr(candidate, 'k', 0) or 0),
```

**Category**: 2, 9.

**Why**: a candidate with `n=None` is malformed evidence; substituting 0 hides the malformation. Low severity because this is at the candidate pool boundary, but cleaner at the perimeter.

---

#### L-3. Wilson CI special-case at `n <= 0`
**Files / lines**: [funnel_engine.py:64-65](../../graph-editor/lib/runner/funnel_engine.py#L64)

```python
if n <= 0:
    return (0.0, 0.0)
```

**Category**: 12 (empty-collection guard).

**Why**: Wilson CI at `n=0` is mathematically `(0, 1)`, not `(0, 0)`. Returning `(0,0)` means "we know with certainty it's zero" — wildly misleading. Should be `(NaN, NaN)` or raise.

---

#### L-4. Identity-backmap fallback when `root_day_shares` is empty
**Files / lines**: [cohort_forecast_v3.py:4060-4064](../../graph-editor/lib/runner/cohort_forecast_v3.py#L4060)

```python
shares = dict(getattr(row, 'root_day_shares', {}) or {})
# Identity backmap: when no root_day_shares are populated, the
# row places onto its own observed_date (anchor == observed_date
# in identity-carrier mode by definition).
if not shares and observed in anchor_set:
    shares = {observed: 1.0}
```

**Category**: 12, 5 (mode fork inferred from data shape).

**Why**: the synthesis of an identity placement from "shares missing + observed in anchor_set" is implicit mode inference. Should be set explicitly by the carrier composer (identity carrier composes to a `{obs: 1.0}` share trivially).

---

#### L-5. TS perimeter: 100+ `?? 0` substitutions in `statisticalEnhancementService.ts`
**Files / lines**: [statisticalEnhancementService.ts:1492-1493, 1508-1509, 1715, 1733, 1737, 2254, 2264-2265, 2295, 2301, 2306, 2345-2357](../../graph-editor/src/services/statisticalEnhancementService.ts) (and dozens more).

**Category**: 2.

**Why this is LOW**: this service is the FE topo "Step 1/Step 2" which writes L1 (`model_vars[analytic]`) and provisional L5 — it sits at the perimeter between data fetch and graph state. Default-zero is *more* defensible here than in the engine because the FE has to render *something* on a partially-fetched graph. But the volume (hundreds of `?? 0`) indicates the input schema is not type-disciplined; ergonomically it would be much better to validate the input shape once at the top of each function and then assume non-null.

---

## 4. Forking / Branching Findings (Separate Section)

Beyond H-5 (identity-vs-active in the reducer), the following parallel code paths exist for what could be one:

### F-1. Daily conversions vs funnel vs cohort maturity
- `daily_conversions_derivation.py` — bespoke aggregator over snapshot rows with its own slice carry-forward (lines 92-111).
- `funnel_engine.py` — bespoke linear-path cumprod over a CF response (lines 196-209, 245-321).
- `cohort_maturity_derivation.py` — bespoke per-tau row reducer.
- `cohort_forecast_v3._selected_cohort_group_rate_draws` — the canonical mass-first reducer.

All four implement variations of `ΣY / ΣX`. The architecture doc identifies this as a known unification gap. Each has its own evidence-shape handling, its own monotonicity contract, its own NaN handling.

**Recommendation**: extract one mass-first reducer interface. All four feed it (carrier-projected mass for funnel, observed prefixes for daily, selected-cohort prefixes for maturity, runtime-projected for E+F).

### F-2. Window vs cohort vs active-cohort branching in `cohort_forecast_v3.build_cohort_evidence_from_frames`
The function name says "build cohort evidence" but its body forks on identity vs active several times. Per the architecture, `build_cohort_evidence_from_frames` is meant to be the *identity-carrier* display materialiser — active rows go through `SelectedAClockEvidence` instead. But the function currently still has fallback paths for active mode that emit "deliberately zero" prefixes. These zero-emit fallbacks (`obs_x = obs_y = 0`) are an implicit mode fork that an outside observer cannot distinguish from genuine zeros.

**Recommendation**: split into two functions: `build_identity_carrier_observed_prefixes` and a `build_active_carrier_placeholder_frames` (or, better, return absence rather than emit zeros).

### F-3. `_composed_pair_per_tau_rate_draws` vs `_selected_cohort_group_rate_draws`
Two reducers; the first is the "model overlay" path (per-edge primitive composition), the second is the "E+F" mass reducer. Both compute rate trajectories. The split is principled (model-only vs evidence-aware) but the implementation has accumulated similar-looking inner loops. Worth at least documenting the shared subroutines.

### F-4. Carrier vs subject role dispatch in `primitive_readout`
[primitive_readout.py:919, 951, 1114](../../graph-editor/lib/runner/primitive_readout.py#L919) — three sites where `compose_primitive_span` is called with role-specific lookups. The role-neutral `ComposedPrimitiveSpan` is correctly used (per architecture), but the calling sites have their own role-shaped error branches (`CompositionError` → role-specific skip reason). Worth consolidating into a single composition helper that returns a role-tagged result.

### F-5. Engine-internal `engine_cohorts.obs_x/obs_y` vs `SelectedAClockEvidence` fork
Per A.9 implementation note: *"when `selected_a_clock_evidence` exists, `_selected_cohort_group_rate_draws` treats it as authoritative and does not fall through to legacy `engine_cohorts.obs_x/obs_y` for missing active anchors. The `engine_cohorts` path remains the identity-carrier / window evidence path."*

The mere fact that this implementation note exists is a smell — the reducer has two parallel observed-prefix substrates and the choice between them is per-Cohort. Atom 2 design ([cohort-maturity-evidence-coverage-design.md]) plans to unify these; until that lands, this is a known fork.

---

## 5. Perimeter Audit

**Does the perimeter have the validation needed to remove engine fallbacks?**

Mixed picture.

### Strong perimeter
- `forecast_preparation.py` does substantial DSL parsing and envelope construction; raises typed errors on bad input.
- `request_envelope.py` builds candidate pools with explicit identity translation.
- `analysis_subject_resolution.py` enforces type rules for analysis dispatch (`ANALYSIS_TYPE_SCOPE_RULES`).
- `primitive_residual_guard.py` explicitly marks unsupported residual / complement edges rather than silently emitting zero — good model.

### Weak / missing perimeter
- **Funnel input** is not validated: `compute_bars_ef` reads `cf_per_edge` entries shape-free (`e.get('p_mean') or 0.0`). If the caller (`funnel_engine` invoked from `runners.py`) passed mis-shaped CF output, the engine silently produces a zero funnel. The perimeter should refuse missing per-edge `p_mean`.
- **Daily-conversions input** is not validated: `derive_daily_conversions(rows)` expects `anchor_day`, `retrieved_at`, `x`/`X`, `y`/`Y`. No validation; the case-fork in the engine is the only defence.
- **Primitive shape** — `timing_span.py`'s `getattr(primitive, 'p', 0.0) or 0.0` cascade exists because the primitive shape coming in is loose (sometimes a `ConditionedTransitionPrimitive`, sometimes a `ResolvedTimingSpan`, sometimes a dict from older code). The perimeter (whoever calls into `timing_span`) needs a single normalised type.
- **`evidence_superset_rows` schema** — `cohort_forecast_v3.build_superset_candidates_by_edge` reads from raw rows with many `or '' / or 0` defences. The fetch envelope should produce a typed dataclass.

### Recommendation
Each engine entry function should declare a strict dataclass for its input. The first move toward removing engine fallbacks is publishing those dataclasses and refusing untyped dicts at engine boundaries.

---

## 6. Summary Table

| Category | Count (HIGH) | Count (MED) | Count (LOW) | Total |
|---|---|---|---|---|
| 1. try/except swallowing | 0 | 3 (M-1, M-5, M-6) | 1 (L-1) | 4 |
| 2. `or 0`/`or []` fallback | 3 (H-2, H-3, H-7) | 2 (M-8, M-9) | 2 (L-2, L-5) | 7 |
| 3. early `return` on None | 1 (H-2) | 0 | 0 | 1 |
| 4. isinstance dispatch | 0 | 2 (M-7, M-8) | 0 | 2 |
| 5. feature-flag / mode fork | 1 (H-5) | 0 | 1 (L-4) | 2 |
| 6. multiple paths for one math object | 1 (H-5) + F-1..F-5 | 0 | 0 | 6 |
| 7. defensive clamping | 4 (H-1, H-4, H-6, H-7 partial) | 3 (M-2, M-3, M-4) | 0 | 7 |
| 8. NaN/Inf scrubbing | 1 (H-6) | 1 (M-4) | 0 | 2 |
| 9. hasattr / getattr | 1 (H-7) | 0 | 1 (L-2) | 2 |
| 10. fallback chain `a or b or c` | 1 (H-7) | 1 (M-9) | 0 | 2 |
| 11. logging-then-continuing | 0 | 0 | 1 (L-1) | 1 |
| 12. empty-collection guard | 1 (H-2) | 1 (M-8) | 2 (L-3, L-4) | 4 |
| 13. schema-version fork | 1 (H-3) | 0 | 0 | 1 |
| **Findings by severity** | **7** | **9** | **5** | **21** |

(Counts can exceed findings because some findings span multiple categories.)

---

## 7. Priority Recommendations

### #1 — Unify identity carrier as data (H-5)
Build an identity `ComposedPrimitiveSpan` at composition time and pipe identity-carrier requests through the same active reducer. This deletes 20+ `if is_identity_carrier:` branches, eliminates `_synthesize_identity_carrier_observed_surface`, and is the single most impactful step toward the user's principle. Big PR but the architecture explicitly endorses it.

### #2 — Make `funnel_engine` math fail-fast (H-2)
Refuse missing `p_mean`. Replace `or 0.0` with assertion. Perimeter validates CF response shape before invoking. The current behaviour silently emits zero-conversion funnels to users.

### #3 — Remove monotone-repair clamp at line 3587 (H-1)
The architecture forbids it in writing. Replace with non-monotonicity provenance. Surfaces real upstream defects.

### #4 — Strict-type the primitive shape consumed by `timing_span` (H-7)
Define `ConditionedTransitionPrimitive`-conforming dataclasses; remove the `getattr / or 0.0` cascade. Affects only one file; opens the door to dropping `or 0.0` cascades everywhere `getattr` is currently the contract.

### #5 — Audit and either remove or justify each `np.clip(..., 1e-6, ...)` in Bayes likelihood (H-6)
These are the single largest source of silent posterior bias. Each clip needs a written mathematical justification (which boundary case it handles, why log-space alternative isn't used) or removal. Affects calibration / inference / boundary cases.

### Beyond #5
- Unify daily-conversions / funnel / maturity reducers into one mass-first interface (F-1).
- Strict-type `evidence_superset_rows` so engine doesn't decode raw dicts.
- Distinguish "absent" from "zero" everywhere: Wilson CI (L-3), evidence-named fields (M-9), forecast residual (H-4).

---

## Appendix A. Files NOT audited in depth

- `forecast_state.py` (1854 LOC) — partially scanned; identified as legacy compute kernel mostly superseded by primitive readout. Worth a follow-up audit if it's still on the live path.
- `graph_builder.py`, `path_runner.py` — graph traversal, not selected for this audit's scope.
- TS-side `feTopoMaterialisationService.ts` — scanned, only L-5 found at this severity.
- Bayes `model.py`, `inspect_model.py` — partially scanned; further audit recommended.

## Appendix B. Cross-reference: invariants the audit relies on

| Invariant source | Statement | Findings it supports |
|---|---|---|
| FORECAST_RUNTIME_ARCHITECTURE.md §4 | "Identity carrier is data, not a route." | H-5, F-2 |
| FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md A.8 | "Must not repair upstream non-monotonicity by sorting, clipping, cumulative-max, or smoothing." | H-1 |
| FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md A.8 | "Rate = None when evidence_x == 0; evidence_y == 0 with positive evidence_x is a real zero rate." | H-2, H-3, M-8 |
| FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md A.9 | "Rate cells with zero denominator are NaN, not zero." | H-2, M-8, L-3 |
| User's stated principle | "No fallbacks within the engine — all defense should be at the perimeter." | Every HIGH and MEDIUM finding. |
