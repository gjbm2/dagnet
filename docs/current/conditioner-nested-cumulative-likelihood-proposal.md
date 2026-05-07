# Proposal: nested-cumulative likelihood in the primitive conditioner

**Status:** v6 design landed with all three reviewer follow-ups (F1, F2, F2′, F3); convolution-oracle target test passes. See §11 for implementation status and parity tests.
**Scope:** `condition_primitive` and former `_maturity_aware_conditioned_draws` in `graph-editor/lib/runner/primitive_conditioning.py`
**Context:** Cluster A regression investigation, post-73n. See `cohort-outside-in-post-73n-regression-tracker.md`.

---

## 1. Why this exists

The primitive evidence merge (`evidence_merge.merge_evidence_candidates`) was rekeyed from `(identity, observed_date)` to `(identity, observed_date, retrieved_at, asat_materialised)`. That preserves the per-cohort retrieval trajectory the snapshot DB stores — for one cohort `(carrier, observed_date=d)`, snapshots at retrievals τ₁ < τ₂ < … < τₘ with cumulative counts k₁ ≤ k₂ ≤ … ≤ kₘ all out of the same cohort size n_d.

The conditioner downstream of the merge has not been updated. Its current per-row likelihood loop treats those m retrievals of one cohort as m **independent** Binomial trials at fixed n_d, multiplying that cohort's contribution to log-likelihood by ~m. The p-posterior concentrates much harder than the data warrants, and the carrier CDF posterior is suppressed.

Demonstrated symptom: `test_active_multihop_cohort_midpoint_matches_a_clock_convolution_oracle` midpoint shifts ~50% (expected 0.196, got 0.100 at τ=33) once supersession is removed.

## 2. What is currently wrong

Code: [`primitive_conditioning.py:879-884`](../../graph-editor/lib/runner/primitive_conditioning.py#L879-L884).

In plain form, for each weighted-evidence row in `weighted_view.rows`,

```
log_lik += k_w_row · log(p · F(τ_row))
         + (n_w_row − k_w_row) · log(1 − p · F(τ_row))
```

summed independently across rows.

Under merge supersession, each cohort produced exactly one row (the latest retrieval), so the addends were one-per-cohort marginal Binomials `Bin(kₘ | n_d, p · F(τₘ))` — defensible but losing trajectory information.

Under the per-retrieval merge, one cohort produces m rows sharing the same n_d. Treating them as independent violates the joint distribution: nested cumulative observations of one process cannot be factorised into independent Binomials.

A second class of latent-path defects is co-located:

- The `T ≤ 1` no-grid fallback ([line 812-813](../../graph-editor/lib/runner/primitive_conditioning.py#L812-L813)) conjugate-updates p as if F = 1; a missing grid does not licence treating F as identity.
- The "all τ ≤ 0" fallback ([line 828-829](../../graph-editor/lib/runner/primitive_conditioning.py#L828-L829)) does the same with rows that cannot inform p (`p · F(0) = 0`).
- The IS-failed fallback ([line 929-940](../../graph-editor/lib/runner/primitive_conditioning.py#L929-L940)) does the same with rows that the latent likelihood could not converge on.

All three latent fallbacks pretend F = 1, and all three are made worse under per-retrieval rows because the row-level totals they consume are now over-counted.

## 3. Correct likelihood

For one cohort with size n_d and observations (k₁, …, kₘ) at retrievals τ₁ < … < τₘ, the joint likelihood under "rate p, latency CDF F" is **multinomial** over m+1 cells:

| Cell                  | Count            | Probability                     |
|-----------------------|------------------|---------------------------------|
| arrived in (0, τ₁]    | k₁               | p · F(τ₁)                       |
| arrived in (τ₁, τ₂]   | k₂ − k₁          | p · (F(τ₂) − F(τ₁))             |
| …                     | …                | …                               |
| arrived in (τₘ₋₁, τₘ] | kₘ − kₘ₋₁        | p · (F(τₘ) − F(τₘ₋₁))           |
| not yet arrived       | n_d − kₘ         | 1 − p · F(τₘ)                   |

Per-cohort log-likelihood:

```
log_lik_d  =  Σᵢ (kᵢ − kᵢ₋₁) · log(p · (F(τᵢ) − F(τᵢ₋₁)))
            + (n_d − kₘ)     · log(1 − p · F(τₘ))
```

with k₀ ≡ 0, F(τ₀) ≡ 0. Total log-likelihood is the sum across cohort groups.

### Reduction properties (mathematical cases)

These are the **mathematical** cases of the likelihood, not implementation branches. They differ by degeneration of the same expression:

- **Single retrieval per cohort (m=1):** `(k₁ − 0)·log(p·F(τ₁)) + (n_d − k₁)·log(1 − p·F(τ₁))` — the pre-existing per-row Binomial, recovered exactly.
- **Non-latent timing (F ≡ 1):** the literal multinomial form is undefined (interior cells have probability 0). The degeneration is the cohort-level marginal Binomial: per cohort take (n_d, kₘ) at the latest retrieval and apply Beta-Binomial conjugate on summed totals. This matches the Bayes compiler's no-latency treatment (I-44: non-latent is a degeneration of the latent semantic, not a parallel route).
- **No evaluable likelihood** (no timing grid, no row with τ > 0, or IS unable to find an ESS-feasible λ): the unconditioned prior is the answer (I-26).

## 4. Implementation: plan → evaluate → materialise

The implementation has **one** resolution path with three stages. The mathematical cases above become **data** carried on a plan and an outcome, not scattered control flow (I-45, AP58).

### 4.1 Plan stage — `build_cohort_likelihood_plan`

Pure function over `(weighted_view, timing_family, options)`. Reads evidence once and produces a `CohortLikelihoodPlan`. Construction has **two independent passes** so timing family does not constrain aggregation:

**Pass 1 — Aggregation (timing-family-independent).** Requires only `(observed_date, retrieved_at)` to be parseable; τ irrelevant.

1. Group `weighted_view.rows` by `observed_date`.
2. Within each group, drop rows whose `retrieved_at` cannot be ordered (missing or unparseable timestamp).
3. Resolve same-retrieval conflicts within each group (rules in §5), emitting provenance against original values.
4. Pick the latest surviving row per `observed_date` by full-timestamp ordering.
5. From the per-cohort latest, build:
   - `cohort_aggregate = (Σ n_weighted_d, Σ kₘ_weighted)` — the aggregate that drives the conjugate degeneration and the reported posterior pressure.
   - `m_S_doc52 = Σ raw row.n` (latest retrieval per group). Doc-52 mass is raw/raw by contract; never substitute weighted.

**Pass 2 — Bucket construction (latent only).** Skipped when `timing_family == NON_LATENT` because non-latent has no use for τ buckets (the F ≡ 1 degeneration only needs the cohort_aggregate). For latent, requires `τ = retrieved_at − observed_date > 0`:

1. Reuse the surviving rows from Pass 1 (so the same conflict resolution applies once).
2. Within each cohort group, exclude rows with `τ ≤ 0` (cannot inform `p · F(τ)`).
3. Sort surviving rows by τ ascending.
4. Apply monotone-k clamp (`kᵢ := max(kᵢ, kᵢ₋₁)`); record any clamp-firing.
5. Compute increments `kᵢ − kᵢ₋₁`.
6. Residual is `n_weighted_d − kₘ_weighted` (cohort size from Pass 1), clamped at 0.

The plan carries:

- **`cohort_aggregate`** — from Pass 1.
- **`m_S_doc52`** — from Pass 1.
- **`cohort_buckets`** — from Pass 2, or empty for non-latent.
- **`row_level_diagnostic`** — row-level `n_weighted_total` / `k_weighted_total` from `bind_primitive_evidence`'s output. Carried for the cache-key tuple, the empty-evidence guard, and provenance traceability.
- **`evaluable`** — boolean. **"This plan has evidence capable of moving the posterior."** True iff:
  - `cohort_aggregate` has non-zero `Σ n_weighted_d` (mass exists), AND
  - timing family is non-latent (Pass 1 alone suffices for the F ≡ 1 conjugate update), OR (timing family is latent AND timing grid `T > 1` AND `cohort_buckets` is non-empty).
- **`unevaluable_reason`** — `Optional[str]`, populated when `evaluable = False`, by the precedence below. (`is_failed` is set later by the evaluator.)
- **`provenance`** — same-retrieval conflicts resolved or skipped, monotone-clamp firings, retrieved_at parse failures, τ ≤ 0 exclusions. Surfaced through to the materialised primitive.

**Reason precedence** (applied in order; first match wins):

1. `cohort_aggregate` empty (Σ n_weighted_d == 0) → `no_evidence`. **Applies to both timing families.** A non-latent plan whose every cohort was skipped by same-timestamp conflicts or had retrieved_at unparseable yields `no_evidence`, not a vacuous CONDITIONED outcome.
2. Timing-latent and `T ≤ 1` (no grid) → `no_timing_grid`.
3. Timing-latent, grid present, `cohort_aggregate` non-empty, `cohort_buckets` empty (rows existed but every τ ≤ 0) → `no_latent_rows`.
4. Otherwise — evaluable; reason left null.

The plan stage does **no** posterior computation. It builds a single description of the evidence that the evaluator and the materialiser both consume.

### 4.2 Evaluate stage — `evaluate_likelihood_plan`

Pure function over `(plan, prior, draw_count, draw_family_key)`. Returns one `ConditioningOutcome`:

```
ConditioningOutcome.prior_only(reason: str, provenance: dict)
ConditioningOutcome.conditioned(
    cond_p_draws, cond_cdf_draws,
    prior_p_draws, prior_cdf_draws,
    cohort_aggregate, provenance,
)
```

Internal logic, written as cases on the plan's data — no `if pre-helper / post-helper`:

- `not plan.evaluable` → `prior_only(reason=plan.unevaluable_reason)`. Covers `no_evidence`, `no_timing_grid`, `no_latent_rows`.
- timing family is non-latent → cohort-level Beta-Binomial conjugate on `plan.cohort_aggregate` → `conditioned(...)`. (The F ≡ 1 degeneration of §3.)
- timing family is latent → multinomial IS over `plan.cohort_buckets`. If a feasible λ is found → `conditioned(...)`. If not → `prior_only(reason='is_failed')`.

`is_failed` is a degeneration discovered during evaluation, identical in kind to `no_timing_grid` / `no_latent_rows` — reasons-as-data, one outcome type.

The evaluator owns nothing about primitive construction. It does not call `_make_prior_only_primitive` or the CONDITIONED constructor; it only returns the outcome.

### 4.3 Materialise stage — `condition_primitive`

The outer function shrinks to a single switch on outcome status:

```
plan = build_cohort_likelihood_plan(...)
outcome = evaluate_likelihood_plan(plan, prior, ...)

if outcome.status == PRIOR_ONLY:
    return _make_prior_only_primitive(
        prior_only_reason=outcome.reason,    # provenance value, not control flow
        ...,
    )

# CONDITIONED path
subset_policy = _compute_subset_policy(m_S=plan.m_S_doc52, ...)
... apply doc-52 blend on outcome.cond_p_draws / outcome.prior_p_draws ...
return _make_conditioned_primitive(outcome=outcome, plan=plan, subset_policy=...)
```

Two property-level rules govern the materialise stage:

- **Doc-52 subset policy is computed only on the CONDITIONED branch.** Prior-only outcomes bypass it (the existing `_make_prior_only_primitive` already records `subset_policy.skip_reason='no_evidence'`).
- **`effective_evidence_totals` is operand substitution only.** The `(1 − r)` factor is preserved — it captures the doc-52 compatibility blend, not the pre-blend aggregate. Concretely:

  ```
  n_cohort, k_cohort = outcome.cohort_aggregate

  if subset_policy.r is None:
      eff_n, eff_k = n_cohort, k_cohort
  else:
      f = max(0.0, 1.0 - float(subset_policy.r))
      eff_n, eff_k = n_cohort * f, k_cohort * f
  ```

  Notes added to the primitive's `notes` tuple:

  - `n_eff_posterior = prior_alpha + prior_beta + n_cohort` (replaces the row-level `n_w` term).
  - `cohort_aggregate_pre_blend = (n_cohort, k_cohort)` — pre-blend cohort aggregate, separate from the post-blend `effective_evidence_totals`.
  - `row_level_admitted_total = plan.row_level_diagnostic.n_w_total` — preserves the row-level admitted mass for traceability.

### 4.4 Constructor parameter

`_make_prior_only_primitive` takes a new `prior_only_reason: Optional[str]` parameter, populated from `outcome.reason` and surfaced via `skipped_evidence_summary`. `prior_source` keeps its existing meaning (model-source provenance — Beta(α,β) source). The reason vocabulary today is `no_evidence`, `no_timing_grid`, `no_latent_rows`, `is_failed`; future reasons are added by extending the outcome's reason vocabulary, not by touching the materialise stage.

### 4.5 Helper internal cleanup (AP53)

After this redesign, `_maturity_aware_conditioned_draws`'s internal `if not row_evidence:` and IS-failed conjugate fallbacks are dead-caller residue. They are removed; the helper either becomes the body of `evaluate_likelihood_plan` or is replaced by it. No latent code path may end in a `_conjugate_p_only` call (that was the F≡1 substitution defect in three guises). `_conjugate_p_only`'s only remaining caller is the non-latent degeneration inside the evaluator.

## 5. Same-retrieval conflict resolution

Two rows in one `observed_date` group can collide along two axes: same `retrieved_at` full timestamp (Pass 1, where rows are dedupliсated for cohort-latest selection), or same `int(τ)` after τ derivation (Pass 2 of bucket construction, where rows could share a day-rounded τ but have different sub-day timestamps already resolved by Pass 1).

Pass 1 collisions are the substantive case (Pass 2 inherits the survivors and operates on already-deduplicated rows). The rule is the same in both:

1. **Identical values — exact float equality.** If the two rows have `n_weighted == n_weighted'` and `k_weighted == k_weighted'` under Python `==` (bit-equality on normal floats; no tolerance) → coalesce; no provenance entry. Exact equality is used deliberately to avoid tolerance ambiguity in conflict/skipped provenance and cache identity.
2. **Distinct full timestamps:** take the row with the later **full timestamp** `retrieved_at` (sub-day ordering). Drop the earlier; emit `same_retrieval_conflict_resolved_by_timestamp` in provenance with both retrieval timestamps.
3. **Same full timestamp, non-identical values:** no authority rule applies. **Skip the entire cohort group** from both `cohort_aggregate` and `cohort_buckets`, and emit `same_retrieval_conflict_skipped` in provenance with the conflicting `(n_weighted, k_weighted)` pairs. Other cohorts in the same evidence view are unaffected.

Rule 3 is conservative: omit a contradictory cohort rather than make a non-deterministic choice that depends on iteration order.

## 6. Edge cases

1. **n varies across retrievals.** In well-formed snapshot data, n_d is constant. If a back-fill produces a later n that differs, the rule is "latest retrieval's n is authoritative for the cohort size". Records implying `kᵢ > n_latest` are clamped via the monotone-k clamp; if it ever fires, emit a provenance note.
2. **Non-monotone k.** Floating-point `k_weighted = k · arrival_weight` is monotone within a cohort because `arrival_weight` is per `observed_date` (identical across retrievals of one cohort). Defence-in-depth clamp `kᵢ := max(kᵢ, kᵢ₋₁)` and 0-clamp on residual.
3. **IS proposal compatibility.** `proposal_p_draws` and `proposal_cdf_draws` are independent of the likelihood form. Tempering, ESS targeting, resampling all unchanged. Only the per-iteration `log_lik` accumulator changes.
4. **Bayes-compiler parity.** The Bayes compiler's CDF-per-cohort treatment in this regime should be the same multinomial form. Worth confirming as a separate cross-check; not a blocker.

## 7. Symmetry / parity test

A unit test asserts: when each cohort has exactly one retrieval (or only exact-duplicate rows that coalesce), the new likelihood is **bit-identical** to the old per-row Binomial sum. Provable by the m=1 reduction in §3; a guard against future drift.

## 8. Invariant alignment (RTFM citations)

| Invariant | Where it applies in this proposal |
|---|---|
| **I-45 / AP58** — one resolution path; cases differ by degeneration, not branching. | §4 collapses three "branches" to one plan→evaluate→materialise pipeline; cases live as data on `plan.evaluable` and `outcome.status`. |
| **I-26** — when no evidence can be applied, the unconditioned prior is the answer. | `plan.evaluable = False` and `is_failed` outcomes both yield `prior_only`. |
| **I-46** — projection/consumer layers must not re-decide semantics. | Materialise stage does not re-classify timing family or re-evaluate evidence; it only switches on `outcome.status`. |
| **I-44** — non-latent is a degeneration, not a parallel route. | Non-latent is a case inside the evaluator, sharing the same plan and outcome shape with latent. |
| **AP18** — route on semantic type/capability, not incidental data presence. | Routing is on `outcome.status` (semantic), not on `len(rows)` or `n_w_total > 0` checks scattered in the helper. |
| **AP53** — avoid dead-caller residue in helpers after changing the contract. | §4.5: helper's `if not row_evidence:` and IS-failed conjugate fallbacks are removed. |

## 9. What this fix is expected to clear

**Expected to clear** (subject to confirmation by implementation and regression sweep)

- `test_active_multihop_cohort_midpoint_matches_a_clock_convolution_oracle` (regressed when the merge fix landed; a-clock convolution is sensitive to the carrier CDF posterior).
- The conditioner's correctness for any primitive whose evidence carries a real CDF trajectory.

**Not claimed to clear**

- The two Cluster A target tests, `test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle` and `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x`. Those test a separate display-side defect: cohort-family snapshot oracle vs window-family BE adaptation. Investigation deferred. The conditioner fix is necessary regardless; sufficiency for those tests is not claimed.

**May surface new failures**

- Tests that asserted on the over-counted posterior shape (effectively encoding the bug).
- Tests exercising the latent fall-through paths (`T ≤ 1`, no-usable-rows, IS-failed) with conditioned-update expectations rather than prior-only expectations.
- Tests exercising non-latent + zero cohort aggregate (previously CONDITIONED with row-level totals; now `prior_only(reason='no_evidence')`).
- Tests reading `effective_evidence_totals` / `n_eff_posterior` and expecting row-level sums.
- All surfaced explicitly via regression sweep — not silently updated.

## 10. Confidence

| Area | Level | Notes |
|---|---|---|
| Multinomial cell decomposition for nested cumulative observations | High | Direct competing-risks / multinomial-cell consequence. |
| Per-touchpoint weighted vs raw split | High | Verified across all consumers of `n_weighted_total`, `k_weighted_total`, and `m_S_doc52`. |
| Reduction to existing behaviour at m=1 | High | Algebraic identity. |
| Plan/evaluate/materialise collapse | High | One resolution path per I-45 / AP58; reasons-as-data per AP18. |
| Fall-through paths → prior-only (incl. non-latent zero-aggregate as `no_evidence`) | Moderate | Direction is principled (I-26); existing test coverage is unknown until sweep runs. |
| Aggregation/bucket pass split (non-latent does not depend on τ) | High | Pass 1 needs only `(observed_date, retrieved_at)`; Pass 2 needs τ. Independent eligibility per pass. |
| Exact float-equality for identical-value coalesce | High | Deterministic by construction; avoids tolerance ambiguity in provenance and cache identity. |
| `effective_evidence_totals` substitution preserving `(1 − r)` factor | High | Operand substitution only; blend factor untouched. |
| `prior_only_reason` parameter (no overload of `prior_source`) | High | Additive parameter on existing constructor. |
| Conflict-resolution-before-clamp ordering | High | Required for diagnosability; mechanical. |
| Whether this clears Cluster A target tests | Low | They are a separate display-side defect. Conditioner fix is necessary regardless; sufficiency for those tests is not claimed. |

---

## 11. Implementation status (as of 6-May-26)

**Headline:** the v6 design with all three reviewer follow-ups (F1, F2, F2′, F3) is fully landed and the convolution-oracle target test passes. Sixty-three unit tests across `test_primitive_conditioning.py`, `test_evidence_merge.py`, and `test_primitive_evidence.py` pass alongside it (21 + 20 + 22; 1 skipped pre-existing). The earlier "F1+F2′ broke a working test → reverted everything → still failing" narrative was based on an intermediate state during the review-fix cycle and has been retired.

### 11.1 What is in the tree

In `graph-editor/lib/runner/primitive_conditioning.py` (vs `HEAD = 62349848`):

- New dataclasses: `_CohortLatest`, `_CohortBucket`, `_CohortLikelihoodPlan`, `_ConditioningOutcome` (frozen).
- New functions: `_build_cohort_likelihood_plan` (Pass 1 + Pass 2), `_evaluate_likelihood_plan` (multinomial + non-latent degeneration + IS-failed → prior-only).
- `_condition_primitive_uncached` rewritten as plan → evaluate → materialise. Reason precedence: `no_evidence` > `no_timing_grid` > `no_latent_rows` > `is_failed`.
- `_make_prior_only_primitive` extended with `prior_only_reason: Optional[str] = None` and `plan_provenance: Tuple[str, ...] = ()` parameters (additive; surfaced via `skipped_evidence_summary` and notes).
- `effective_evidence_totals` substitution: now `outcome.cohort_aggregate × max(0, 1 − r)` (cohort-aggregate × doc-52 blend factor), replacing the row-level `n_w / k_w` operands. The `(1 − r)` factor is preserved.
- New diagnostic notes: `cohort_aggregate_pre_blend`, `row_level_admitted_total`, `plan_provenance: ...`.
- Old `_maturity_aware_conditioned_draws` deleted — its body is now `_evaluate_likelihood_plan`.

In `graph-editor/lib/evidence_merge.py`: per-retrieval rekey to `(identity, observed_date, retrieved_at, asat_materialised)`; skip reason renamed `superseded_by_later_retrieval` → `exact_duplicate`.

### 11.2 Reviewer follow-ups — final disposition

All four findings (F1, F2, F2′, F3) are applied in the current tree:

- **F1 (zero-count τ buckets preserved).** Pass 2 emits every cell, including zero-increment cells. The multinomial loop walks every cell with `prev_F` advancing through plateaus. Mathematically `0·log(p·ΔF) = 0`, so zero cells contribute nothing to the log-likelihood directly — but their presence is required so the residual term lands at the trajectory's actual final τ rather than at the last positive cell.
- **F2 (per-trajectory same-timestamp dedup).** Pass 1 now applies the §5 collision rules across the entire per-cohort retrieval trajectory, not only at the cohort-latest retrieval. Identical-value collisions coalesce silently; non-identical collisions skip the entire cohort with a `same_retrieval_conflict_skipped[…]` provenance entry. The upstream merge already keys per-retrieval, so this is largely defence-in-depth, but the contract is now uniform.
- **F2′ (residual at trajectory's last τ).** The multinomial loop's residual term `(n − k_last) · log(1 − p · CDF(τ_last))` is evaluated at `bucket.last_observed_tau_idx` — the trajectory's actual final τ — rather than at `bucket.increments[-1][0]` (last positive cell). A plateau at the trajectory tail still constrains survival; this is the mathematically-correct choice.
- **F3 (plan provenance surfaced).** `plan.provenance` is threaded through both `_make_prior_only_primitive` and the conditioned-primitive constructor and surfaces in `notes` / `skipped_evidence_summary`.

The dead `last_observed_tau_idx` field flagged in earlier drafts of this section is now read by the multinomial loop (residual at trajectory's last τ); the AP53 dead-residue pattern is closed.

### 11.3 Parity tests

Two tests in `graph-editor/lib/tests/test_primitive_conditioning.py` pin the conditioner's reduction properties:

- `test_multinomial_m1_reduces_to_per_row_binomial` — m=1 (single retrieval per cohort) is bit-identical to the legacy per-row Binomial form, swept across `p ∈ {0.05, 0.2, 0.5, 0.8, 0.95}` and `F ∈ {0.1, 0.4, 0.7, 0.9, 0.99}` to a relative tolerance of 1e-12. This is the §7 parity test.
- `test_multinomial_plateau_preserves_survival_pressure` — a fixture with two retrievals at the same `k` (a plateau) emits two cells: a positive-increment cell at the first τ and a zero-increment cell at the second τ. `bucket.last_observed_tau_idx` advances to the trajectory's second τ, and the residual lands there.

### 11.4 Convolution-oracle target test

`test_active_multihop_cohort_midpoint_matches_a_clock_convolution_oracle` (the design's headline target) **passes** against the current tree. The test compares the active-cohort E+F midpoint against an independent factorised oracle (`_active_cohort_span_oracle_curve` in the test file) on the LAT4 multi-hop fixture. The §3-compliant conditioner restores agreement to within the test tolerance (|Δ| ≤ 0.04 and rel ≤ 0.45 across τ=18..45).

### 11.5 What remains open (out of scope for this work)

- **Cluster A display-side** in `test_cohort_factorised_outside_in.py` — chart `evidence_x` / `evidence_y` are sourced from model-projected mass prefixes rather than raw observation counts. Tracked in [`cohort-outside-in-post-73n-regression-tracker.md`](cohort-outside-in-post-73n-regression-tracker.md) §"Cluster A". Not the conditioner's responsibility.
- **Cluster D** (newly identified) — `test_coverage_one_in_epoch_a_linear_decay_in_epoch_b_zero_at_epoch_c` asserts `coverage = 1.0` across epoch A under daily snapshot density; observed values ramp from 0 to 1 over τ=1..9. Tracked in the same regression tracker §"Cluster D". Not the conditioner's responsibility.
