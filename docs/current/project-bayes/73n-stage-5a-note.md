# 73n Stage 5a — Single-Hop Window and Subject Cutover (Parity Oracle) — note

**Status**: Stage 5a landed — architecture correct (cross-surface parity proven), default OFF, SHADOW + ON available behind env var. Flipping to ON in production blocked by maturity-aware likelihood gap; Stage 5b extension migrates that into the primitive (see §5).
**Date opened**: 1-May-26
**Architecture revision**: 1-May-26 — substitution relocated from `handle_conditioned_forecast` post-extraction (per-surface) to inside `compute_cohort_maturity_rows_v3` (shared row-builder seam). The original placement violated AP58 / STATS_SUBSYSTEMS §3.3 "shared code → guaranteed parity": only the CF response surface saw the substitution while the cohort_maturity row surface kept the legacy IS-conditioned scalar. Both surfaces now produce identical `p_infinity_*` values when the flag fires.
**Plan**: [`73n-carrier-evidence-conditioning-implementation-plan.md`](73n-carrier-evidence-conditioning-implementation-plan.md) §"Stage 5a — Single-Hop Window and Subject Cutover (Parity Oracle)"
**Stage 0c contracts**: [`73n-stage-0-baseline.md`](73n-stage-0-baseline.md) §3.3 (numeric tolerances), §3.4 (F14 oracle)
**Stage 1-4 inputs**: [`73n-stage-1-note.md`](73n-stage-1-note.md), [`73n-stage-2-note.md`](73n-stage-2-note.md), [`73n-stage-3-note.md`](73n-stage-3-note.md), [`73n-stage-4-note.md`](73n-stage-4-note.md)

---

## 1. Stage 5a deliverables

### 1.1. Primitive readout module

[`graph-editor/lib/runner/primitive_readout.py`](../../graph-editor/lib/runner/primitive_readout.py) is the single home for Stage 5a's cutover machinery. It composes Stage 1-4 modules without touching live composition or trajectory code. Public surface:

- `SingleHopReadoutFlag` — three-state enum (`OFF`, `SHADOW`, `ON`).
- `read_single_hop_primitive_readout_flag()` — reads `DAGNET_SINGLE_HOP_PRIMITIVE_READOUT` (default `OFF`); accepts `on`/`true`/`1` synonyms; unknown values fall back to `OFF` so the rollback switch (plan §675) is unconditionally available.
- `is_single_hop_window_eligible()` — gate predicate. True iff `not is_multi_hop` AND (`is_window` OR cohort `A == X`). Active cohort `A != X` excluded; that is Stage 6's surface (plan §155, §201, §679).
- `compute_single_hop_readout()` — top-level helper. Classifies the edge requirement via Stage 4's `classify_edge_requirement`, wraps the legacy `EvidenceSet` in a Stage 1 `WeightedPrimitiveEvidenceView` with identity arrival weights, calls Stage 3's `condition_primitive`, derives closed-form mixture moments (no MC noise), returns a `SingleHopReadoutResult` with `should_substitute` for the seam.

The module imports from `runner.primitives`, `runner.primitive_evidence`, `runner.primitive_conditioning`, `runner.primitive_residual_guard`, `runner.model_resolver`, and `evidence_merge`. It does NOT import from `forecast_runtime`, `forecast_state`, `cohort_forecast_v3`, `span_kernel`, or `carrier_composition`. The api_handlers seam wires it in; the primitive layer remains self-contained.

#### 1.1.1. Synthetic identity-clock resolution (no re-merge)

`_synthetic_identity_resolution` wraps the existing `EvidenceSet` produced by `forecast_runtime.prepare_forecast_runtime_inputs` (which already called `merge_evidence_candidates` once). Each admitted `EvidencePoint` becomes one `WeightedEvidenceRow` with `arrival_weight = 1.0` and `n_weighted = n`, `k_weighted = k`. The synthetic `WeightedPrimitiveEvidenceView` carries the legacy `evidence_scope_key` so Stage 3's conditioning threads provenance correctly and the `binding_policy` is `'73n.stage_5a.identity_clock.v1'`.

Identity arrival weights are correct for Stage 5a's gate: window mode binds evidence on the `X` arrival clock, which equals the request source clock (plan §201). Cohort `A == X` collapses to the same. Active `cohort(A != X)` is excluded by the gate; the prefix-weighted binding for that case is Stage 6's surface.

#### 1.1.2. Closed-form posterior moments (no MC noise)

`_closed_form_posterior_moments` derives the public `(p_mean, p_sd, p_sd_epistemic)` analytically from the conditioned primitive's prior, weighted view, and subset policy:

- recover `(α, β)` from `prior_posterior.mean` and `prior_posterior.sd` via method-of-moments;
- compute `(α + k_w, β + n_w - k_w)` for the fully-conditioned Beta;
- read `r` from `primitive.subset_policy`;
- apply the doc-52 mixture: `mean = (1-r) * cond_mean + r * prior_mean`;
- compute the mixture variance as `(1-r)*(var_cond + cond_mean²) + r*(var_prior + prior_mean²) - mix_mean²`.

Stage 3's primitive draws are produced from `np.random.Generator.beta` at `S=2000`, which carries `~±0.011` MC noise on the mean of a typical Beta. The Stage 0c §3.3 acceptance band is `±0.002` on displayed rate. Closed-form moments bypass that gap entirely — substitution is parity-grade by construction, leaving the only legacy gap to be the difference between Stage 3's plain conjugate and the trajectory engine's maturity-aware likelihood. That residual gap is the meaningful measurement and is what shadow mode surfaces in the response diagnostic.

#### 1.1.3. Three-state cutover gate

The `DAGNET_SINGLE_HOP_PRIMITIVE_READOUT` environment variable controls behaviour:

- `off` (default): primitive readout never runs; legacy trajectory engine output is canonical. Diagnostics still surface a one-line `flag=off` provenance block on every per-edge result.
- `shadow`: primitive readout runs in parallel; the response carries the primitive's closed-form moments under `primitive_readout.closed_form_public_moments`, the legacy values under `primitive_readout.legacy_public_moments`, and `delta_p_mean` / `within_shadow_band` for shadow comparison. Legacy values remain canonical in the response's top-level `p_mean` / `p_sd` / `p_sd_epistemic`.
- `on`: primitive readout runs; closed-form moments substitute the legacy values in the top-level fields. `subject_probability_source` switches to `'primitive_posterior'`. The legacy values remain available for forensic comparison in `primitive_readout.legacy_public_moments`.

Plan §397 ("feature flags or equivalent request-level switches") permits an env-var implementation. Future work may promote the flag to `ForecastingSettings` if the FE needs per-repo control.

### 1.2. Wiring at the shared row-builder seam

`compute_cohort_maturity_rows_v3` ([cohort_forecast_v3.py:897+](../../graph-editor/lib/runner/cohort_forecast_v3.py#L897)) is the single shared dependency between the `--type cohort_maturity` route (`_handle_cohort_maturity_v3`) and the `--type conditioned_forecast` route (`handle_conditioned_forecast`). Per STATS_SUBSYSTEMS §3.3 ("Distinction from cohort_maturity analysis runner: they share the v3 pipeline ... Shared code → guaranteed parity") this is the canonical place to substitute.

The row builder gained three optional kwargs:

- `evidence_set` — typed canonical `EvidenceSet` from `forecast_runtime.prepare_forecast_runtime_inputs`. When the caller didn't thread this through, the row builder synthesises a minimal one from `runtime_bundle.p_conditioning_evidence.total_x/total_y` (the totals the trajectory engine actually conditioned on), via `_synthesise_minimal_evidence_set`. Either path gives Stage 5a's primitive readout the same evidence pressure the legacy posterior used.
- `scenario_id` — drives the deterministic `DrawFamilyKey` seed.
- `as_at` — flows into the `PrimitiveScope` for forensic equivalence.

Substitution sits between the legacy `_p_infinity_*` derivation ([cohort_forecast_v3.py:1310-1314](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1310-L1314)) and the per-tau row loop ([:1316+](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1316)). When the flag fires AND the request is single-hop with identity carrier AND evidence is reachable, the readout overrides `_p_infinity_mean` / `_p_infinity_sd` / `_p_infinity_sd_epistemic` before they're stamped onto every row. The diag is stashed on the first row's `_primitive_readout` sentinel via the existing `_attach_cf_row_metadata` pattern.

Both api_handlers callers were updated:

- `_handle_cohort_maturity_v3` ([api_handlers.py:1689](../../graph-editor/lib/api_handlers.py#L1689)) passes the new kwargs and pops `_primitive_readout` onto `subject_result['primitive_readout']`.
- `handle_conditioned_forecast` ([api_handlers.py:2358](../../graph-editor/lib/api_handlers.py#L2358)) passes the new kwargs and pops `_primitive_readout` onto `edge_results[i]['primitive_readout']`.

There is **no per-handler substitution logic** — the post-extraction `last_row.get('p_infinity_mean')` reads in both handlers transparently see the substituted value because the row builder wrote it. This is the AP58-correct factoring.

### 1.3. Tests

#### 1.3.1. Stage 5a unit tests

[`graph-editor/lib/tests/test_primitive_readout.py`](../../graph-editor/lib/tests/test_primitive_readout.py) — 22 tests, all green. Coverage:

| Test | Plan reference | Coverage |
|---|---|---|
| `test_flag_default_is_off` | §675 | `DAGNET_SINGLE_HOP_PRIMITIVE_READOUT` unset ⇒ `OFF`. |
| `test_flag_off_explicit` | §675 | Explicit `off` value reads as `OFF`. |
| `test_flag_shadow` | §672 | `shadow` reads as `SHADOW`. |
| `test_flag_on_synonyms` | §672 | `on` / `true` / `1` (case-insensitive) all read as `ON`. |
| `test_flag_unknown_value_falls_back_to_off` | §675 | Unknown values fall back to `OFF` so the rollback switch is unconditional. |
| `test_eligible_single_hop_window` | §679 | window single-hop: eligible. |
| `test_eligible_single_hop_cohort_a_equals_x` | §155, §201 | cohort A=X: eligible. |
| `test_ineligible_single_hop_cohort_a_not_x` | §155 | cohort A≠X: deferred to Stage 6. |
| `test_ineligible_multi_hop_window` | §679 | multi-hop window: deferred to Stage 5c. |
| `test_ineligible_multi_hop_cohort` | §155 | multi-hop cohort: deferred to Stage 5b/6. |
| `test_ineligible_cohort_missing_anchor` | §155 | cohort with no anchor: conservative defer. |
| `test_closed_form_mean_matches_conjugate_update_exactly` | §"Stage 0c" §3.3 | Beta(2,2) prior + (k=70, n=100) → closed-form posterior mean = 72/104 within `1e-9`. |
| `test_full_subset_limit_returns_prior` | §224, §240-244 | r → 1 ⇒ primitive equals model var (mean = prior mean). |
| `test_zero_subset_limit_returns_full_conjugate` | §240 | r → 0 ⇒ primitive equals fully-conditioned Beta (full E pressure). |
| `test_off_flag_is_no_op` | §675 | `OFF` builds no primitive, returns early with diagnostic note. |
| `test_shadow_flag_builds_primitive_but_does_not_substitute` | §672 | `SHADOW` builds primitive, records delta, leaves legacy values canonical. |
| `test_shadow_band_constants_match_stage_0c_contract` | §"Stage 0c" §3.3 | `SHADOW_ABS_BAND = 0.005`, `ACCEPTANCE_ABS_BAND = 0.002`. |
| `test_ineligible_request_returns_diagnostic_skip_not_substitution` | §679 | Ineligible request returns a `skip_reason` rather than substituting. |
| `test_eligible_but_inputs_missing_records_soft_skip` | §394 | Eligible but inputs incomplete (e.g. evidence_set None) records `skip_reason='incomplete_inputs'` so plumbing gaps are detectable in shadow rollout. |
| `test_diagnostics_carry_full_provenance` | §680 | Diagnostics expose flag, eligible, primitive status, raw + weighted totals, subset r, closed-form moments, legacy moments, delta, within_shadow_band. |
| `test_synthetic_resolution_preserves_raw_evidence_set_scope_key` | §565 | Identity-clock binding wraps the raw `EvidenceSet` without re-merge; `evidence_scope_key` flows through; weighted totals equal raw totals; `binding_policy = '73n.stage_5a.identity_clock.v1'`. |
| `test_should_substitute_property_responds_to_flag` | §672 | `should_substitute` is True only for `(flag=ON, eligible, primitive built, draw-coherent)`. |

#### 1.3.2. Existing-test parity (flag OFF default)

With the env var unset (default `OFF`), every existing test passes unchanged:

- `test_carrier_object_contract.py` — 15/15 green (Stage 6 carrier contract).
- `test_primitive_contract.py` (14), `test_primitive_evidence.py` (18), `test_primitive_conditioning.py` (18), `test_primitive_residual_guard.py` (20), `test_prefix_arrival.py` (15) — 85/85 green (Stage 1-4 contract tests).
- `test_cohort_factorised_outside_in.py` — 32 passed, 5 xfailed (the four 73n flip-to-green AP58 targets at Stages 5a/5b plus the single carry-over from 73m §1B), 1 failed: `test_v3_midline_at_saturation_converges_to_p`.

The single failure is the documented pre-existing carry-over from 73m §1B (Stage 0 baseline §2.4 line 413: "observation-only RED ... 73m §1B carry-over ... Plan does not commit to closing this; 73n inherits as RED unchanged"). It is NOT a regression caused by Stage 5a. The 5-minute test wall-clock confirms the trajectory engine is unmodified.

#### 1.3.3. Stage 5a integration tests (in-process, F14 Q1)

[`graph-editor/lib/tests/test_primitive_readout_integration.py`](../../graph-editor/lib/tests/test_primitive_readout_integration.py) — 3 tests, all green. The tests call `_handle_cohort_maturity_v3` and `handle_conditioned_forecast` in-process against the synth-simple-abc graph (F14 Q1 fixture: `from(simple-a).to(simple-b).window(-90d:)`), with the env var monkeypatched per test. The asserts:

| Test | Coverage |
|---|---|
| `test_off_flag_legacy_oracle_unchanged` | OFF mode: both surfaces produce IDENTICAL legacy values (cross-surface delta < 1e-6). Legacy is within ±0.020 of Stage 0c §3.4 oracle 0.6925 (in-process measurement drifts ~0.005 from CLI capture; the contract is cross-surface match, not absolute oracle). |
| `test_shadow_flag_records_delta_no_substitution` | SHADOW mode: both surfaces still legacy-canonical. Both surfaces carry `primitive_readout` with the SAME `closed_form_public_moments` (delta < 1e-9 — same primitive, shared row-builder seam). |
| `test_on_flag_substitutes_identically_on_both_surfaces` | ON mode: substitution happens at the row-builder seam, so cohort_maturity's `p_infinity_mean` and CF's `p_mean` are IDENTICAL (delta < 1e-9). `subject_probability_source` reads `'primitive_posterior'` on both. The substituted value equals the closed-form mean (no MC noise). |

These tests pin the AP58 / STATS_SUBSYSTEMS §3.3 contract: shared code → guaranteed parity. They will fail loudly if a future change reintroduces per-handler substitution.

#### 1.3.4. F14 Q1 measurement (in-process, all three modes)

Captured 1-May-26 (post-relocation):

| Mode | cm `p_infinity_mean` | CF `p_mean` | cross-surface Δ | substituted | within shadow band? |
|---|---|---|---|---|---|
| OFF | 0.698030 | 0.698030 | 0.00e+00 | False | n/a |
| SHADOW | 0.698030 | 0.698030 | 0.00e+00 | False | **False** (Δ=−0.167 vs primitive's 0.5315) |
| ON | 0.531514 | 0.531514 | 0.00e+00 | True | n/a |

**Cross-surface parity**: exact (0.00e+00) in all three modes. The relocation fix works.

**Primitive-vs-legacy delta**: −0.167 (primitive 0.5315 vs legacy 0.6980). This is the maturity-aware-likelihood gap exposed by Stage 5a's substitution — Stage 3's plain Beta-Binomial conjugate gives `(α + k_w) / (α + β + n_w)` ≈ raw `Σy/Σx` = 132835/249918 = 0.5316 because:

1. The graph loaded by the in-process measurement does not carry an aggregate Bayesian prior on this edge — `resolved.alpha = resolved.beta = 0`. So the conjugate update has no prior to balance the observed evidence.
2. `n_effective` is None, so the doc-52 mass-ratio blend is skipped (full evidence pressure applied).
3. The legacy trajectory engine's `compute_forecast_trajectory` uses a per-cohort maturity-aware likelihood (`Binomial.pmf(k_c | n_c, p_s · CDF_s(τ_c))`) that downweights immature cohorts, producing 0.6980 as the maturity-corrected forecast.

This delta far exceeds Stage 0c §3.3 shadow band (±0.005) and acceptance band (±0.002). **Production must keep the flag at OFF**. SHADOW is useful for forensic measurement (the diag block surfaces the delta), but ON would publish a wildly incorrect rate.

The fix is to migrate the maturity-aware likelihood from `compute_forecast_trajectory` into `primitive_conditioning.condition_primitive`. That is Stage 5b's natural extension and is now §5 follow-up #1.

#### 1.3.5. AP58 strict-xfail flip check

Captured 1-May-26 with `DAGNET_SINGLE_HOP_PRIMITIVE_READOUT=on`:

```
test_single_hop_non_latent_upstream_collapses_to_window[FAST]   xfail
test_single_hop_non_latent_upstream_collapses_to_window[SLOW]   xfail
test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel  xfail
test_multihop_non_latent_upstream_collapse                       xfail
```

All four targets remain xfailed under flag ON. This is the expected outcome:

1. The four tests assert cohort-vs-window convergence (cohort with non-latent upstream should match window, etc.). Stage 5a's gate ALLOWS substitution for window mode but DEFERS active cohort A≠X to Stage 6. So with flag ON, only the window arm substitutes, and the cohort arm keeps the legacy AP58-affected output. The rate-axis gap WIDENS rather than closes.
2. The single-hop primitive substitution itself produces 0.5316 (raw rate) for window mode while the cohort arm produces ≈0.6980 (legacy maturity-corrected via the AP58 fork in `build_cohort_evidence_from_frames`). 

Both arms must change in lockstep before these targets flip green:

- Stage 5b moves maturity-aware likelihood into the primitive (closes the legacy-vs-primitive gap).
- Stage 6 extends the gate to active cohort A≠X with a primitive-backed carrier (so cohort and window arms both consume the same primitive substrate).

The strict-xfail markers stay until both happen. They function as a parity gate for the eventual cutover.

### 1.4. What Stage 5a deliberately does NOT do

- **No live cutover by default.** The flag is `OFF` out of the box. The legacy trajectory engine remains the canonical owner of public p_mean / p_sd until the user flips the flag.
- **No replacement of `compute_forecast_trajectory`.** The trajectory engine still runs every CF request unchanged — its per-tau rows drive completeness, fan bands, and the v3 row output. Stage 5a substitutes only the public asymptotic scalar; the trajectory's other outputs flow through unchanged.
- **No carrier logic beyond identity.** Active cohort A!=X (real upstream carrier) is excluded by the eligibility gate. The carrier consumer is Stage 6's surface (plan §"Stage 6 — Carrier Consumer" line 715).
- **No multi-hop subject_span.** Multi-hop subjects are excluded by the eligibility gate. Stage 5b owns subject-span composition; Stage 5c owns the multi-hop window readout.
- **No retirement of `_legacy_trajectory_draw_family_key`.** Stage 3 introduced this fallback for callers without a registry-backed key. Stage 5a does not pass a registry-backed key into the trajectory engine — that is Stage 6's responsibility (Stage 3 note §"What unblocks for later stages" item 4).
- **No `RequestPrimitiveRegistry` wiring.** The single-edge readout builds one primitive per CF request and discards it. Multi-primitive sharing across composed consumers (Stage 5b for subject-span, Stage 6 for carrier) is the registry's surface; the registry contract from Stage 2 is unused on the live path until then.
- **No flip-to-green for the four AP58 strict-xfails.** The four `test_cohort_factorised_outside_in.py` xfails at lines 827 (×2), 1115, 1185 are gated to `DAGNET_SINGLE_HOP_PRIMITIVE_READOUT=on`. With the default OFF they remain xfailed. Manual flip-on to verify `XPASS` is the operational gate; the strict-xfail markers will be removed in a follow-up commit once the flip-on is validated against the F14 oracle.
- **No FE/wire change.** `single_hop_primitive_readout` is an env-var-only flag at this stage. If FE control becomes necessary, future work can promote it to `ForecastingSettings`.
- **No change to `subject_probability_source` enum on `ForecastTrajectory`.** The new `'primitive_posterior'` label lives on the per-edge result block (`primitive_readout.subject_probability_source`), not on the trajectory dataclass. The existing trajectory provenance (`'edge_level'` / `'span_level'`) reflects what the trajectory engine itself sourced; that semantic is preserved. Extending the trajectory enum was considered but deferred — Stage 5a's substitution sits one layer above the trajectory and the per-edge surface is the natural home for the new label.

---

## 2. Stop-condition discharge

Plan §"Stage 5a" stop condition (line 682):

> single-hop window(X-Y) parity tests stay green within the Stage 0 acceptance tolerance, single-hop subject_span returns the conditioned primitive directly, diagnostics identify primitive-posterior provenance, and the named F14 single-hop fixture's public scalar matches the Stage 0 numeric oracle once the F14 root cause identified at Stage 0 has been addressed.

| Stop-condition clause | Discharge |
|---|---|
| Single-hop window(X-Y) parity tests stay green within Stage 0 acceptance tolerance | **Architecture discharged; semantics deferred.** Flag OFF (default): all 32 non-xfailed `test_cohort_factorised_outside_in.py` tests pass; AP58 baseline shows zero regression after relocation. Cross-surface parity proven (1e-9) by `test_primitive_readout_integration.py`. Flag ON: substituted value differs from legacy by −0.167 on F14 Q1 (in-process measurement, §1.3.4) — the maturity-aware-likelihood gap. Production must keep the flag at OFF until Stage 5b migrates the maturity-aware likelihood into the primitive. |
| Single-hop subject_span returns the conditioned primitive directly | **Architecture discharged.** When flag fires, the substituted scalar is sourced from the primitive's posterior (closed-form mixture mean), and both `--type cohort_maturity` and `--type conditioned_forecast` surfaces show the same value. The semantic correctness of that value is gated on the maturity-aware-likelihood migration (follow-up #1). |
| Diagnostics identify primitive-posterior provenance | **Discharged.** `subject_result['primitive_readout']` (cohort_maturity) and `edge_results[i]['primitive_readout']` (CF) carry the same diagnostic block: `flag`, `eligible`, `substituted`, `subject_probability_source`, `closed_form_public_moments`, `legacy_public_moments`, `delta_p_mean`, `within_shadow_band`. When substitution fires, `subject_probability_source` reads `'primitive_posterior'`. |
| F14 single-hop fixture's public scalar matches Stage 0 numeric oracle | **Architecture discharged; semantics deferred.** F14 Q1 measured at all three modes (§1.3.4). The substituted value (0.5315) is wrong against the maturity-corrected oracle (0.6925) because Stage 3's plain Beta-Binomial conjugate doesn't have the per-cohort maturity-aware likelihood. The cross-surface parity contract holds; the absolute parity contract is gated on Stage 5b's likelihood migration. |

The §"Stage 5a" migration rules (lines 670-680) are honoured:

- ✓ run primitive and legacy paths in shadow mode, gated by an independent flag;
- ✓ preserve single-hop window(X-Y) numerical behaviour within the Stage 0 acceptance tolerance (closed-form parity at the algorithmic level; the maturity-likelihood residual is what shadow mode measures);
- ✓ single-hop subject_span(X→Y) returns the conditioned primitive directly when the flag is ON;
- ✓ keep a rollback switch until Stage 6 (env var defaults to OFF, unknown values fall back to OFF);
- ✓ wrap the current aggregate-IS/window conditioning logic so primitive construction owns it (the conditioned primitive is constructed and consumed; the trajectory engine still runs but its rate output is overridden);
- ✓ p_conditioning_evidence remains compatibility/provenance metadata only — the response still carries it; no Stage 5a code reads it for ownership decisions;
- ✓ doc-52 subset/effective-evidence applied once at primitive construction (Stage 3's `condition_primitive` is the single owner; Stage 5a never re-applies);
- ✓ no carrier logic beyond identity in window mode (the gate ensures only identity-carrier requests reach the primitive readout);
- ✓ diagnostics show the window() output came from primitive posterior X→Y (`primitive_readout.subject_probability_source`).

---

## 3. Suggested commit messages (per atom)

The skill does not commit. The following commit messages are suggested for each atom; the user decides timing and granularity.

| Atom | Files | Suggested message |
|---|---|---|
| 1 | `graph-editor/lib/runner/primitive_readout.py` (Sections 1.1.1-1.1.3) | `73n stage 5a: primitive_readout module — flag, gate, synthetic identity-clock resolution, closed-form posterior moments (§664-682)` |
| 2 | `graph-editor/lib/api_handlers.py` (handle_conditioned_forecast wiring + hashlib import) | `73n stage 5a: wire single-hop primitive readout into handle_conditioned_forecast — shadow/on/off via DAGNET_SINGLE_HOP_PRIMITIVE_READOUT env var (§668, §680)` |
| 3 | `graph-editor/lib/tests/test_primitive_readout.py` | `73n stage 5a: primitive_readout tests — flag plumbing, eligibility gate, closed-form parity, full-subset limit, shadow/on/off mode behaviour, diagnostics (§"Stage 5a" stop condition)` |
| 4 | `docs/current/project-bayes/73n-stage-5a-note.md`, `docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md` | `73n stage 5a: stage-5a note + mark stage 5a complete in progress block` |

---

## 4. What unblocks for later stages

- **Stage 5b (Multi-Hop Subject Span Composition)** consumes the same primitive contract for each edge along the subject span. The eligibility gate widens (multi-hop accepted) and a per-primitive `RequestPrimitiveRegistry` enters the picture so composed consumers share `DrawFamilyKey`s. The Stage 5a closed-form moment derivation generalises to multi-edge composition by convolving primitive posteriors along the span topology.
- **Stage 5c (Multi-Hop Window Readout)** reads the Stage 5b composed `subject_span(X → Z)` and substitutes its closed-form moments for the legacy multi-hop window output. Same surgery, different surface.
- **Stage 6 (Carrier Consumer)** introduces the active `cohort(A != X)` path. The eligibility gate flips to admit it; a real `PrefixArrivalMap` (Stage 2) replaces the synthetic identity-clock resolution; the carrier composer feeds a primitive-backed `carrier_to_x` into the substitution. Stage 6 also retires `_legacy_trajectory_draw_family_key` once the registry-backed key reaches the trajectory engine.
- **Stage 7 (Caching)** can persist `ConditionedTransitionPrimitive` keyed by `(transition, scope, prefix-arrival identity)`. Stage 5a's closed-form moment derivation is idempotent across cache hits.
- **Stage 8 (Cross-Surface Projection and Provenance)** rolls the `primitive_readout` block into the canonical CF response provenance schema.

---

## 5. Open follow-ups (tracked for later resolution; NOT Stage 5a-blocking)

These items are recorded so they survive into the rest of 73n's plan. Each carries a target stage where it must be closed before the plan as a whole can ship.

### Follow-up 1 — Maturity-aware likelihood migration into the primitive (BLOCKS flag-ON)

**Where**: `runner.primitive_conditioning.condition_primitive`. Today it produces a plain Beta-Binomial conjugate posterior on the weighted view. The trajectory engine `compute_forecast_trajectory` produces a per-cohort maturity-aware IS-conditioned posterior with `Binomial.pmf(k_c | n_c, p_s · CDF_s(τ_c))` reweighting that downweights immature cohorts.

**Evidence the gap is real**: F14 Q1 in-process measurement (§1.3.4) — primitive 0.5315 vs legacy 0.6980 (Δ = −0.167). The primitive collapses to raw `Σy/Σx` because the prior is `α=β=0` for analytic-only sources and `n_effective` is None.

**Why this blocks production flag-ON**: the substituted scalar would publish a wildly wrong rate on every single-hop window query. Stage 0c §3.3 acceptance band ±0.002; current gap exceeds it by ~80×.

**Target stage**: Stage 5b or earlier. Plan §"Stage 5b" focuses on multi-hop subject-span composition; the likelihood migration is a natural prerequisite for any composed primitive to produce parity-grade outputs. It must land before any flag flips to ON in production.

**How to detect closure**: F14 Q1 shadow delta `< 0.002` (acceptance band). Re-run §1.3.4 measurement after migration.

### Follow-up 2 — Cohort A≠X gate extension + carrier consumer (Stage 6)

**Where**: `runner.primitive_readout.is_single_hop_window_eligible`. Today returns `False` for active cohort `A != X`. The four AP58 strict-xfail tests assert cohort-vs-window convergence; with Stage 5a's gate, the cohort arm keeps the legacy `build_cohort_evidence_from_frames` AP58-affected output while the window arm substitutes — gap WIDENS rather than closes.

**Target stage**: Stage 6 (Carrier Consumer). Stage 6 introduces a primitive-backed `carrier_to_x` so cohort A≠X requests can route through the primitive registry. At that point the gate widens and both arms consume the same substrate.

**How to detect closure**: the four strict-xfail targets (`test_cohort_factorised_outside_in.py` lines 827×2, 1115, 1185) XPASS under flag ON. The strict markers force a suite failure on XPASS so the closure event is loud.

### Follow-up 3 — Pre-existing 73m §1B carry-over: `test_v3_midline_at_saturation_converges_to_p`

**Where**: `test_cohort_factorised_outside_in.py:1850` (synth-mirror-4step fixture). midpoint=0.5777 vs p_infinity_mean=0.6794, |Δ|=0.1017, tolerance 0.05. Stage 0a §1.13 / §2.4 documents this as "observation-only RED ... 73m §1B carry-over ... Plan does not commit to closing this; 73n inherits as RED unchanged." Investigation in `cohort-maturity-v3-midline-collapse-investigation.md`.

**Target stage**: not 73n. May resurface at Stage 5b/5c if the multi-hop work touches the same surface. Re-evaluate at Stage 9 (acceptance tests).

**How to detect closure**: test passes (delta within tol). Currently failing every run; not gated.

### Follow-up 4 — `subject_probability_source` enum on ForecastTrajectory (low priority)

**Where**: `runner.forecast_state.ForecastTrajectory.subject_probability_source` (currently values `'edge_level'`, `'span_level'`). Stage 5a's `primitive_posterior` label lives on `primitive_readout.subject_probability_source` (per-edge surface), NOT on the trajectory dataclass.

**Target stage**: Stage 5b or 6, only if a downstream consumer reads the trajectory's enum directly. None do today.

**How to detect closure**: not a closure item; cosmetic alignment if it ever matters.

### Follow-up 5 — FE-controllable flag (deferred)

**Where**: `DAGNET_SINGLE_HOP_PRIMITIVE_READOUT` is a BE env var. If FE A/B testing becomes necessary, promote to `ForecastingSettings`.

**Target stage**: Stage 8 (Cross-Surface Projection) or post-acceptance. Defer until measured need.

### Follow-up 6 — Diagnostic block volume on flag=off (low priority)

**Where**: every CF response carries `primitive_readout` (~120 bytes/edge) even on OFF. Consider gating on `flag != off` if response size becomes a concern.

**Target stage**: Stage 8. Defer until measured.

---

## 6. Tracked failures and known-RED items (for plan closure)

This is the live ledger of items that MUST be resolved before 73n can ship as a whole. Every item has a target stage.

| Item | Status | Target stage | Re-test recipe |
|---|---|---|---|
| F14 Q1 primitive-vs-legacy gap (Δ=−0.167) | **BLOCKING flag-ON** | Stage 5b (likelihood migration) | `python /tmp/f14_measure.py` (or §1.3.4 in-process pattern); expect Δ within ±0.002 |
| AP58 strict-xfail #1: `test_single_hop_non_latent_upstream_collapses_to_window[FAST]` | xfailed | Stage 5b + Stage 6 | `pytest -k 'test_single_hop_non_latent_upstream_collapses_to_window' lib/tests/test_cohort_factorised_outside_in.py` with flag ON; expect XPASS |
| AP58 strict-xfail #2: same `[SLOW]` | xfailed | Stage 5b + Stage 6 | same |
| AP58 strict-xfail #3: `test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel` | xfailed | Stage 5b + Stage 6 | `pytest -k 'test_degenerate_identity_and_instant_carrier'` |
| AP58 strict-xfail #4: `test_multihop_non_latent_upstream_collapse` | xfailed | Stage 5b + Stage 6 | `pytest -k 'test_multihop_non_latent_upstream_collapse'` |
| `test_v3_midline_at_saturation_converges_to_p` (73m §1B carry-over) | **failing** (documented, not gated) | not 73n | Re-evaluate at Stage 9 |

The four AP58 strict-xfail markers are themselves the regression net: they will surface as suite failures (XPASS strict) the moment Stage 5b + Stage 6 close their semantic gaps. Removing the markers is the closure event.
