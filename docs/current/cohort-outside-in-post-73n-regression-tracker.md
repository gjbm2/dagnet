# Cohort Outside-In Suite — Post-73n Regression Tracker

**Status**: Clusters B, C and the conditioner side of Cluster A
resolved. Cluster A missing-anchors and subject-evidence starvation
resolved 7-May-26. Cluster A `evidence_x` resolved by trapezoidal
cumsum (7-May-26 later). Cluster A LAT4 multi-hop **resolved
8-May-26** by the per-edge source-clock fix in
`_build_rate_attributed_subject_prefix`: the half-bin midpoint shift
now applies only when the edge's source equals the query denominator
node X (i.e. the first subject layer where M_select is the carrier
floor-day bucket); downstream chain layers use integer τ because their
M_select has already been placed by composed A→U timing, and applying
the midpoint shift again would double-correct. Only Cluster A SIMPLE
`evidence_y` (rising-flank ~3% chart-vs-continuous bias plus ~4%
seed-fixed MC noise on the synth fixture) and the τ=39 sweep cliff
remain open. Cluster D open.
**Date opened**: 6-May-26
**Owner**: outside-in suite (`graph-editor/lib/tests/test_cohort_factorised_outside_in.py`)
**Branch**: `feature/snapshot-db-phase0`
**Baseline**: commit 62349848 ("73n landed + ancillaries; outside-in passes.") — green.
**Driver of regression**: uncommitted work-in-progress implementing
[`cohort-maturity-selected-a-clock-evidence-clock-adapter-plan.md`](cohort-maturity-selected-a-clock-evidence-clock-adapter-plan.md)
(5-May-26) and the §3-compliant nested-cumulative conditioner
([`conditioner-nested-cumulative-likelihood-proposal.md`](conditioner-nested-cumulative-likelihood-proposal.md)).
The plans are partially landed; this tracker captures the fall-out for
downstream triage.

This tracker explicitly is **not** a re-opening of 73f. The 73f xfails
recorded in `TODO.md` belong to a different generation of the suite and
were calibrated against the pre-adapter evidence path.

## Headline

Latest full run (6-May-26, post conditioner v6): **3 failed, 41
passed, 1 xfailed in 553s** (45 collected). Two of the three are the
original Cluster A pair; the third is a newly-added blind invariant on
epoch-A coverage (see §Cluster D). A fourth test —
`test_active_multihop_cohort_midpoint_matches_a_clock_convolution_oracle`
— was added in the same uncommitted work, regressed under the naive
supersession-removal attempt described under "Defect A1", and now
**passes** with the §3-compliant conditioner in place.

Focused rerun after the 7-May-26 subject-superset fix:

```
pytest graph-editor/lib/tests/test_cohort_factorised_outside_in.py::test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle \
       graph-editor/lib/tests/test_cohort_factorised_outside_in.py::test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x -q
```

Result: **2 failed in 16.64s**. The failures remain the Cluster A
pair, but the signature has changed materially:

- SIMPLE single-hop is no longer subject-starved. At τ=8 the chart now
  reports `evidence_x=2965.358638`, `evidence_y=0.204441`,
  `rate=0.000069` against the raw-count oracle's
  `evidence_x=2696`, `evidence_y=1`, `rate=0.000371`. At τ=10 it is
  close on Y (`6.128693` vs `7`) while X is still prior-carrier-CDF
  shaped (`4808.732838` vs raw `4683`).
- LAT4 multi-hop is also no longer collapsed. It now disagrees at the
  scale of the semantic definition rather than orders of magnitude
  (e.g. τ=17 `evidence_y=1.983567` vs raw `1`; τ=25
  `evidence_y=154.329718` vs raw `144`). Some rate checks still exceed
  the raw query-X denominator oracle slightly.

Current verified reading: the subject-superset repair closed the
immediate regression that flattened the evidence line. The two tests
still fail. The remaining failure must not be dismissed as "test stale"
without a full code-tracing investigation; the outside-in suite remains
the acceptance oracle. The current evidence indicates that public
`evidence_x` / `evidence_y` are still being populated from internal
prefix/proxy surfaces at least in some regimes, but the precise fix
point remains under investigation.

Independent arithmetic probe (7-May-26) confirms this reading. A
standalone script rebuilt the rate-attributed prefix directly from:
root-window carrier `n` for selected A-days, resolved source-layer
carrier/subject timing, and window-family subject rows from the
snapshot DB. The current chart rows match that independent
rate-attributed oracle closely:

- SIMPLE τ=8: chart `x=2965.358638`, `y=0.204441`; independent
  rate-attributed oracle `x=2969.267977`, `y=0.204429`; raw oracle
  `x=2696`, `y=1`.
- SIMPLE τ=17: chart `x=8777.872505`, `y=569.288417`; independent
  `x=8792.313104`, `y=570.058663`; raw oracle `x=9314`, `y=653`.
- LAT4 τ=25: chart `y=154.329718`, `rate=0.063672`; independent
  `y=154.280743`, `rate=0.063652`; raw oracle `y=144`,
  `rate=0.061512`.

This probe proves only that the production row output matches one
independent reconstruction of the current rate-attributed code path. It
does **not** prove that the current code path is the correct public
evidence contract. In particular, it does not justify changing or
weakening the outside-in oracle by itself.

Follow-up falsification requested 7-May-26: create a completely flat,
dense, boring SIMPLE-equivalent synth using the normal `synth_gen.py`
path. New fixture:

- `synth-simple-flat-abc`
- same A→B→C truth as `synth-simple-abc`
- `failure_rate=0`, `frame_drop_rate=0`, `toggle_rate=0`,
  `snapshot_start_offset=0`, `drift_sigma=0`, `drift_rate=0`,
  `growth_rate_mom=0`, `traffic_cv=0`
- `kappa_sim_default=1000000000`, `kappa_step_default=0`
- generated via `python -m bayes.synth_gen --graph
  synth-simple-flat-abc --write-files --enrich --bust-cache`

On an equilibrated selected window `cohort(1-Mar-26:3-Mar-26).asat(10-Apr-26)`,
the raw selected-cohort oracle and current chart evidence are close. The
remaining difference is small model/finite-sample timing noise, not the
20% SIMPLE gap:

| τ | raw rate | chart rate | Δ |
|---|---:|---:|---:|
| 13 | 0.013677 | 0.013597 | -0.000080 |
| 17 | 0.067701 | 0.066971 | -0.000730 |
| 21 | 0.160693 | 0.160173 | -0.000519 |
| 25 | 0.267304 | 0.266147 | -0.001157 |

This disproves only the broad hypothesis that the reducer/rate-
attribution machinery inherently creates a 20% discrepancy on every
equilibrated fixture. It does **not** close Cluster A: the flat fixture
still exposed a systematic `evidence_x` mismatch when the test was
switched over (see below).

Flat-fixture switch authorised 7-May-26:

- `test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle`
  now uses `synth-simple-flat-abc`.
- `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x`
  now uses `synth-lat4-flat`.
- The raw selected A-clock oracle shape is unchanged.
- Approved tolerance currently in the test:
  - count fields: `max(25, 0.5%)`
  - rate fields: `max(0.0025, 2%)`

Focused rerun after switching both tests to flat fixtures:

```
pytest graph-editor/lib/tests/test_cohort_factorised_outside_in.py::test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle \
       graph-editor/lib/tests/test_cohort_factorised_outside_in.py::test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x -q -rs
```

Result: **2 failed in 79.24s**.

Current residuals:

- SIMPLE flat single-hop fails primarily on `evidence_x`. Example:
  τ=13 expected raw `evidence_x=27125`, got `28385.088186`
  (Δ=1260.088186, tolerance=135.625). This persists despite the flat
  fixture and tight tolerance.
- SIMPLE flat also has smaller `evidence_y` mismatches around the
  rising flank, e.g. τ=15 expected `1081`, got `1126.995919`
  (Δ=45.995919, tolerance=25).
- LAT4 flat multi-hop now runs and fails on `evidence_y` only, with
  smaller but systematic late-τ residuals. Examples: τ=45 expected
  `11106`, got `11166.018468` (Δ≈60, tolerance≈55.5);
  τ=50 expected `11419`, got `11515.443305` (Δ≈96,
  tolerance≈57.1).

Working hypotheses, **not final diagnosis**:

- SIMPLE `evidence_x` may still be emitted from an internal carrier
  prefix (`x_prefix`) rather than the observed carrier surface. The code
  path currently gates on `carrier_surface.cell_at_or_before(...)` but
  assigns `x_val = x_prefix.value_at(...)`. This is a concrete call-site
  to investigate, not yet a completed root-cause proof.
- The residual shape resembles the discrete-CDF half-bin lead documented
  in [`discrete-cdf-half-bin-residual-in-active-evidence.md`](discrete-cdf-half-bin-residual-in-active-evidence.md),
  but that document is not sufficient by itself to close the defect.
  The remaining work is to trace exactly whether public evidence fields
  should read observed selected A-clock counts, prefix/proxy counts, or
  a convention-adjusted observed oracle.

Cluster A status as of 7-May-26 (revised): **the conditioner-side
defect (over-counting of nested retrievals after supersession was
removed) has been resolved.** The remaining Cluster A failures are
display-side only. Current evidence points at `evidence_x` /
`evidence_y` being read from internal prefix/proxy surfaces rather than
plain observed selected A-clock counts, but this remains a working
hypothesis until the code trace is completed. See §Cluster A below for
the current investigation state.

- **A1 — supersession destroyed retrieval CDF time-series (RESOLVED via
  conditioner option 2).** `merge_evidence_candidates` no longer
  collapses retrievals; it now keys by
  `(identity, observed_date, retrieved_at, asat_materialised)`. The
  conditioner's nested-cumulative likelihood (multinomial cell
  decomposition with zero-increment cells walking through plateaus,
  residual at the trajectory's last τ) absorbs the per-retrieval
  trajectory without over-counting. The convolution-oracle test
  passes as a result.
- **A-display — partially closed (7-May-26)**: the carrier-reach
  signature was missing-anchors, not model-projection drift. The
  runtime built its own `carrier_arrival_map` with root-day support
  taken from the **subject** target's primitive scope (X-day range),
  excluding cohort A-anchors that fell before the subject's evidence
  window. With the cohort range `1-Mar..3-Mar` and subject scope
  `date_from=2026-03-03` (carrier-onset offset), the runtime's map
  rooted only on `2026-03-03` and silently dropped 2026-03-01 / 02
  cohorts. Chart `evidence_x` was therefore one anchor's worth of
  contribution rather than three. The first fix landed here: the runtime now
  consumes `RequestEnvelopePlan.carrier_arrival_map` /
  `subject_arrival_map` (the envelope already roots correctly on the
  cohort A-day range). The companion fetch-envelope change first moved
  subject fetches to the public A-day range, then was corrected to the
  union of public A-days and subject X-day support after that
  over-narrowed the evidence superset. See §Cluster A "Two-clock
  root-day defect" and "Display-side residual" below.
- **A-display subject starvation — closed (7-May-26)**: the first
  missing-anchor fix overcorrected by narrowing the subject-side fetch
  envelope to the public A-anchor range. That preserved selected
  anchors but violated the evidence-superset contract for the subject
  primitive: the primitive binder builds its date scope from X-day
  arrival support, while the fetch had only returned A-day rows. The
  result was a flattened `evidence_y` line. In the SIMPLE probe the
  subject primitive kept only 17 rows from the single overlap day
  `2026-03-03` and skipped the rest as out of bounds. The current
  `request_envelope.py` fixes this by making the subject envelope the
  union of the public A-day range and the subject X-day support. After
  this fix the SIMPLE probe emits 52 selected A-clock cells and the
  subject line reaches `evidence_y=569.288` at τ=17 instead of the
  earlier near-zero value.
- **A-display residual — open**: with all three anchors now
  contributing and subject rows no longer starved, the flat fixtures
  still fail. The current failure is not yet fully diagnosed.

  Verified observations:
  - On `synth-simple-flat-abc`, `evidence_x` is materially above the
    raw selected A-clock oracle on the rising carrier flank (e.g. τ=13
    expected 27125, got 28385.088186).
  - The relevant code path currently builds an observed carrier
    surface, but the active selected-evidence cell assigns
    `x_at_query_x` from `x_prefix.value_at(...)`. That strongly suggests
    the public `evidence_x` field may be using a prefix/proxy quantity
    instead of observed carrier count, but this still needs a full trace
    through `SelectedAClockEvidence.aggregate_by_tau` and row projection
    before calling it final.
  - On `synth-lat4-flat`, the remaining failure is `evidence_y` only,
    at smaller magnitudes (e.g. τ=50 expected 11419, got
    11515.443305). This may be related to the same prefix/proxy path,
    to discrete-CDF binning, or to a separate subject-side aggregation
    issue. It has not yet been isolated.

  Do **not** close this by declaring the outside-in oracle stale. The
  oracle now uses flat fixtures specifically to remove the earlier
  noise/sparsity confounders. The remaining work is a code-tracing
  investigation of precisely which object should feed public
  `evidence_x` / `evidence_y`, and why the current implementation still
  diverges from raw selected A-clock counts.

### Discretisation-side fixes landed (7-May-26 later)

Three landings on the inference path, in the order they arrived:

1. **Trapezoidal cumsum for the carrier `density_cdf`.** Replaces the
   rectangle-rule cumsum convention in
   [`_edge_sub_probability_density`](../../graph-editor/lib/runner/span_kernel.py#L83)
   with a trapezoidal scheme. This removes the constant half-bin lead
   documented in
   [`discrete-cdf-half-bin-residual-in-active-evidence.md`](discrete-cdf-half-bin-residual-in-active-evidence.md)
   from `selected_x_prefix.value_at` and therefore from `evidence_x`.
2. **Diff-CDF construction for `evidence_y`.** Reworks the subject-side
   prefix in
   [`_build_rate_attributed_subject_prefix`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2652)
   to use a CDF-difference scheme rather than the prior empirical-rate
   plus carry-forward path.
3. **Midpoint shift on per-source-day rate evaluation.** Replaces
   `_latest_nk_at_or_before(nk_by_tau, tau)` (integer-τ as-of) with a
   linear interpolation between `nk_by_tau[τ-1]` and `nk_by_tau[τ]`
   evaluated at `τ - 0.5`, the midpoint of the source-day exposure
   bucket. By linearity, this is equivalent to
   `chart_y_new(τ) = 0.5 × (chart_y_old(τ-1) + chart_y_old(τ))` per
   anchor.

#### Verified arithmetic against the prior signature

Pre-fix, `evidence_x` exhibited a deterministic
`F_continuous(τ + 0.5) / F_continuous(τ)` ratio at every τ in the
SIMPLE-flat fixture (`a-to-b` carrier `p=0.7, onset=1, mu=2.3, σ=0.5`).
That ratio was matched to within 0.5 percentage points absolute at
every failing τ before the trapezoidal change — sufficient proof that
the half-bin lead in the rectangle-rule cumsum was the cause.

#### Current state after all three landings

Focused rerun:

```
pytest graph-editor/lib/tests/test_cohort_factorised_outside_in.py::test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle \
       graph-editor/lib/tests/test_cohort_factorised_outside_in.py::test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x -q -rs
```

Result: **2 failed in 63s**. The failure shape has narrowed
substantially:

- **`evidence_x` is closed in the test's evaluation band.** No
  `evidence_x` failures appear on either fixture. Per-τ relative error
  on SIMPLE-flat: every τ ≥ 6 is ≤ 0.483%, with most rows at
  0.1–0.3% (well inside the 0.5% bar). τ ∈ {3, 4, 5} sit on the very
  steep pre-`sum_y` flank with larger residuals (97% / 16% / 3%) —
  not asserted on, because the test's `candidate_taus` requires
  `sum_y > 0`.

- **`evidence_y` SIMPLE-flat single-hop: residual ~3–7% overshoot at
  τ ∈ {13..21}.** Live numbers (chart, oracle, Δ, tol):

  | τ  | oracle | chart    | Δ     | tol  |
  |---:|-------:|---------:|------:|-----:|
  | 13 | 371    | 415.33   | +44.3 | 25   |
  | 14 | 664    | 727.94   | +63.9 | 25   |
  | 15 | 1081   | 1164.76  | +83.8 | 25   |
  | 16 | 1642   | 1728.60  | +86.6 | 25   |
  | 17 | 2348   | 2418.28  | +70.3 | 25   |
  | 18 | 3195   | 3230.40  | +35.4 | 25   |
  | 19 | 4083   | 4156.49  | +73.5 | 25   |
  | 20 | 5095   | 5173.15  | +78.1 | 25.5 |
  | 21 | 6200   | 6253.06  | +53.1 | 31   |

  Anatomy of the residual at τ=15 (representative): chart 1164.76,
  oracle 1081, continuous A→B→C convolution expectation
  ≈ 1128. So roughly half the 84-unit gap is a chart overshoot
  vs continuous (~37 units, ~3%) and the other half is the synth
  fixture's seed-4242 MC undershoot vs continuous (~47 units, ~4%).
  Multi-seed MC verification (20 seeds) confirmed:
  - the per-seed signed deviation has mean ≈ 0 across seeds
  - the per-seed standard deviation matches the binomial σ predicted
    from `N × p × (1−p)` (e.g. τ=15 realised σ=37.7 vs predicted
    33.3)
  - same-sign drift across consecutive τ within a single seed is
    expected because `oracle_y(τ)` is a cumulative count;
    15/20 seeds gave the same sign at τ=14 and τ=17. The synth's
    seed-4242 realisation lands ~1.4σ low across the 14–17 band.

- **`evidence_y` LAT4 multi-hop: closed 8-May-26.** Pre-fix LAT4 had a
  ~50–95 unit overshoot at late τ; the midpoint-shift first-pass
  over-corrected, flipping sign to a −42 to −366 unit undershoot at
  τ ∈ {19..30}. Resolved by the per-edge source-clock rule in
  `_build_rate_attributed_subject_prefix`: the half-bin midpoint shift
  applies only when `from_id_str == str(denominator_node)` (i.e. the
  first subject layer where M_select is the carrier floor-day bucket
  whose mass is spread through the source day). Downstream chain layers
  use integer τ because their M_select has already been placed by
  composed A→U timing; applying the midpoint shift again would
  double-correct. The test passes after this change. Remaining LAT4
  late-τ overshoot is small enough to fit within tolerance.

- **`evidence_y` SIMPLE-flat τ=39 cliff (newly visible).** At τ=39
  the oracle drops to 14209 while chart stays at 21156 (Δ≈+6947).
  This is the `sweep_to=2026-04-10` boundary effect (anchor +
  τ exceeds sweep for some anchors), the same cliff `evidence_x`
  hits at τ=39/40. The `evidence_x` test branch absorbs this via
  the epoch-B `actual ≥ expected` clause at lines 1315–1346;
  `evidence_y` has no equivalent epoch-B handling, so the cliff
  surfaces as a hard failure.

#### Outstanding work after these landings

1. **SIMPLE-flat ~3% chart-side overshoot at τ=13..21 vs continuous
   expectation.** After the midpoint shift the chart still sits ~3%
   above the model's continuous prediction. Confirmed via the
   `--diag` `rate_attributed_dual_eval_by_edge` block (added 8-May-26
   on `_selected_a_clock_evidence`) that the production path is
   already on the midpoint branch for single-hop and that the integer
   branch overshoots much further (~600 vs ~85 units at τ=15). The
   ~3% residual must therefore live in the rate-attribution algebra
   itself or its discretisation, not in the half-bin choice. Worth
   checking whether the diff-CDF reconstruction inadvertently stacks
   with the trapezoidal change (e.g. carries a residual half-bin
   internally), or whether some boundary handling on the rising flank
   introduces the bias.
2. **`evidence_y` epoch-B handling at the sweep cliff.** The
   `evidence_x` test has an `actual ≥ oracle` branch past
   `tau_solid_max`; `evidence_y` doesn't. Either add an analogous
   branch to the oracle assertion, or change the chart's
   `evidence_y` to behave the same way as `evidence_x` past the
   seam (frozen at the seam value).
3. **SIMPLE-flat synth fixture's MC noise.** The seed-fixed
   realisation is itself ~4% below continuous expectation across
   τ=14..17 (this contributes ~47 units at τ=15 of the 84-unit
   observed gap). Multi-seed verification confirmed the per-seed
   signed deviation has mean ≈ 0 and per-seed σ matches binomial
   `√(N·p·(1−p))`. Closing this without changing tolerances requires
   regenerating the fixture with more samples (higher
   `mean_daily_traffic` or longer `expected_sample_seconds`) so the
   single-seed realisation lands closer to the continuous mean.
   Tolerance changes are explicitly out of scope — the test
   modification policy applies and the user has declined.

#### Diagnostic landed 8-May-26: `rate_attributed_dual_eval_by_edge`

Added a `--diag`-gated diagnostic on `SelectedAClockEvidence`
(`graph-editor/lib/runner/cohort_forecast_v3.py`) that emits, per
(edge, anchor_day, tau), three evaluations of the rate-attributed
cumulative side-by-side: `production` (the per-edge source-clock rule
the runtime actually uses), `midpoint` (rate at tau-0.5
unconditionally), and `integer` (rate at integer tau unconditionally).
Surfaced once on the row payload at
`rows[0]['_selected_a_clock_evidence']['rate_attributed_dual_eval_by_edge']`
to avoid the multi-hop V8-string-length overflow that a per-cell copy
would trip. Production behaviour is unchanged — the diagnostic is
zero-cost when `--diag` is off.

LAT4 daemon JSON envelope still trips V8's max string length under
`--diag` because of unrelated pre-existing `placement_lineage` /
`row_lineage` bloat that re-emerges in diag mode (the gating that
closed Cluster B is correct for production traffic but does not slim
the diag payload itself). The diagnostic must be probed in-process for
LAT4 until that secondary bloat is also gated.

## Failure Inventory

| # | Test | Cluster | Status |
|---|------|---------|--------|
| 1 | `test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle` | A — `evidence_x` **closed 7-May-26** (trapezoidal); `evidence_y` ~3% chart-vs-continuous bias plus ~4% MC noise remains; sweep-cliff at τ=39 | Open (`evidence_y` only) |
| 2 | `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x` | A — chain-layer half-bin compounding **closed 8-May-26** by per-edge source-clock rule | **Closed 8-May-26** |
| 3 | `test_active_multihop_cohort_midpoint_matches_a_clock_convolution_oracle` | A — conditioner over-counted nested retrievals | **Closed 6-May-26** (v6 conditioner) |
| 4 | `test_coverage_one_in_epoch_a_linear_decay_in_epoch_b_zero_at_epoch_c` | D — epoch-A coverage non-unity under daily snapshot density | Open |
| 5 | `test_multihop_latent_upstream_divergence` | B — daemon stdout exceeds V8 max string | **Closed 6-May-26** |
| 6 | `test_multihop_with_terminal_non_latency_cohort_must_honour_upstream_subject_latency` | B — daemon stdout exceeds V8 max string | **Closed 6-May-26** |
| 7 | `test_f_mode_equals_ef_at_frontier_under_drift` | C — F vs E+F frontier-agreement gap widened | **Closed 6-May-26** |

## Cluster A — Display surface emits model-projected mass instead of raw counts

### Symptom (refined 6-May-26 — superseded by 7-May-26 update below)

Both remaining tests are oracle-equality assertions on active cohort
rows. The oracle (`_selected_a_clock_snapshot_oracle`, test file
line 470) reads raw synth snapshot rows independently and
reconstructs the selected A-clock CDF/as-of view; the test then
compares row `evidence_y` / `evidence_x` / `rate` against the oracle
bucket.

The 6-May-26 numeric signature on the SIMPLE single-hop fixture
(pre-fix) was a clean ~33-37% chart-to-oracle ratio for `evidence_x`
that tracked carrier reach. That signature was misread as
"model-projected mass vs. raw counts" — it was actually
`1 of 3 anchors`. See "Two-clock root-day defect" below for the
revised diagnosis (7-May-26).

### Two-clock root-day defect (revised diagnosis, 7-May-26 — landed)

The runtime previously rebuilt its own `carrier_arrival_map` at
[`build_resolved_cf_runtime`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1074)
even though `RequestEnvelopePlan.carrier_arrival_map` already carried
a correctly-rooted version. The runtime construction sourced its
`root_day_weights` from `target_resolution.primitive_scope.date_from
.. date_to`, where `target_resolution` was the **subject** target.
Subject scope's `date_from` reflects when the carrier latency lets
mass plausibly arrive at X; for SIMPLE single-hop with `cohort(1-Mar
.. 3-Mar)` and the A→B carrier (`mu=2.30, sigma=0.50, onset=1`),
that scope started at `2026-03-03`. The runtime carrier map
therefore rooted only on `2026-03-03`. Cohort A-anchors `2026-03-01`
and `2026-03-02` had no entry in `root_day_weights`, so
`arrival_weights.root_day_shares_on('2026-03-01')` returned `{}`,
the per-row `WeightedEvidenceRow.root_day_shares` was empty, and
`_row_selected_a_clock_placements` rejected those rows with
`clock=no_prefix_arrival_root_day_shares`. Only the third anchor's
evidence reached `SelectedAClockEvidence`.

Numeric confirmation (pre-fix, SIMPLE-BC, τ=8 carrier `k_w` per
anchor from row_lineage):

| anchor | retrieval | τ | k_w |
|---|---|---|---|
| 2026-03-01 | 2026-03-09 | 8 | 718 |
| 2026-03-02 | 2026-03-10 | 8 | 961 |
| 2026-03-03 | 2026-03-11 | 8 | 1017 |
| **sum** | — | — | **2696** ⇐ matches oracle exactly |

Chart at τ=8 was 985.49 ≈ 0.969 × 1017 (the third anchor alone, with
sub-percent prior-CDF projection drift).

A second-layer defect surfaced once the runtime map was corrected:
the per-edge subject `EdgeFetchEnvelope.anchor_from / anchor_to`
filter for the snapshot fetch was sourced from the same X-day
support (`_envelope_from_arrival_map(subject_arrival_map,
source_node)`). Cohort-family rows are keyed by `anchor_day = A-day`,
so filtering by X-day excluded cohort rows for early A-day anchors
even when the runtime map was correct. Both fixes had to land
together for `cohort_list` to contain all three selected A-day
cohorts and for `_selected_anchor_day_keys` to return all three.

#### Fixes landed (7-May-26)

1. `build_resolved_cf_runtime` (`cohort_forecast_v3.py:1074`) now
   accepts `envelope_plan` and consumes its
   `carrier_arrival_map` / `subject_arrival_map` directly in active
   mode. The runtime no longer constructs a parallel carrier map.
   Window mode and `cohort(A=X)` continue to build a subject map
   locally because the envelope plan emits no maps in those cases
   (per Appendix A's local-clock binding contract). When a caller
   does not supply `envelope_plan`, one is built inline via
   `build_request_envelope_plan` so direct test invocations still
   work. `compute_cohort_maturity_rows_v3` and the two
   `api_handlers.py` call sites pass `preparation.envelope_plan`
   forward.

2. `build_request_envelope_plan` (`request_envelope.py:300`) now
   builds per-edge subject `EdgeFetchEnvelope`s with
   `anchor_from / anchor_to` taken from the public cohort A-anchor
   range, not from `_envelope_from_arrival_map(subject_arrival_map
   , source_node)`. The subject map's X-day support remains the
   evidence-clock binding range used at runtime; it is no longer
   conflated with the snapshot-fetch anchor filter. In window mode
   and `cohort(A=X)` the two ranges coincide, so the change is a
   no-op for those degeneracies.

#### Display-side residual (still open)

With both fixes landed, all three selected anchors contribute and
chart `evidence_x` is within ~10% of oracle on the SIMPLE single-hop
fixture (e.g. τ=8: chart 2965 vs oracle 2696, ~10% over) — the
residual is the prior-CDF vs empirical-CDF drift that the
rate-attributed prefix carries by construction. Tightening that
gap is a separate decision: oracle-tolerance relaxation, or a route
back to primitive-bound observed counts for `evidence_x`.

Chart `evidence_y` remains structurally divergent. The
rate-attributed Y_prefix (`Σ_u M_select(U,C,u) · k(u,τ-u)/n(u,τ-u)`,
[`_build_rate_attributed_subject_prefix`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2640))
is a model expectation, not an observed count, and is many orders
of magnitude smaller than the empirical numerator at every age the
test inspects (e.g. SIMPLE τ=8: chart 0.0012 vs oracle 1.0; τ=17:
chart 0.020 vs oracle 653; LAT4 τ=17..28: chart 0.000 vs oracle
1..281). This is the "model projection used as evidence-named field"
issue the
[`cohort-maturity-selected-a-clock-evidence-clock-adapter-plan.md`](cohort-maturity-selected-a-clock-evidence-clock-adapter-plan.md)
flagged but did not yet fix. It is independent of the missing-anchors
defect resolved here. The proper fix is to replace the rate-attributed
Y_prefix with primitive-bound observed Y placed on the A-clock via
the join-conditioned carrier surface, per the plan's
"Field Semantics" §158 ("`evidence_y` is cumulative clock-adapted
observed selected numerator Y_A(tau)") and §59 forbidding
"using model projection values as evidence-named fields".

### Mechanism (confirmed 6-May-26 by tracing the data flow)

The chart row's `evidence_x` and `evidence_y` are read at
`cohort_forecast_v3.py:3781-3782` from `active_bucket['sum_x']` /
`['sum_y']`, which is built by
`SelectedAClockEvidence.aggregate_by_tau`
(`cohort_forecast_v3.py:301-338`). Each anchor's contribution is
`cell.x_at_query_x` / `cell.y_at_subject_end`. Those amplitudes are
set inside
[`_build_active_selected_a_clock_evidence_from_runtime`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2859)
(`cohort_forecast_v3.py:2859`) as:

- `x_val = x_prefix.value_at(anchor_day, tau)` — i.e.
  `N_cohort × P(carrier reach by τ)` from `runtime.selected_x_prefix`
  (carrier-only N×G_carrier per the inline contract at
  `cohort_forecast_v3.py:2870-2877`).
- `y_val = y_prefix.value_at(anchor_day, tau)` — built by
  [`_build_rate_attributed_subject_prefix`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2640)
  (`cohort_forecast_v3.py:2640`) as
  `Σ_u M_select(U,C,u) · k(u,τ)/n(u,τ)`.

Both are model-projected, mass-weighted reconstructions. The oracle
sums raw `x` / `y` from cohort-family snapshot rows, latest-as-of
the retrieval date, across anchor days. Different objects.

The fix is in the chart-row evidence path, not the conditioner.
Either (a) re-route `evidence_x` / `evidence_y` back to raw observed
counts (preserving the new prefix machinery for the conditioning and
projection paths only), or (b) update the oracle to match the
mass-weighted definition that `selected_x_prefix` /
`selected_y_prefix` carry. The open work in
[`cohort-maturity-selected-a-clock-evidence-clock-adapter-plan.md`](cohort-maturity-selected-a-clock-evidence-clock-adapter-plan.md)
governs which side moves.

#### What the substrate actually contains

Verified against the LAT4 diagnostic: across all three primitives
(AB carrier, BC subject, CD subject) the only skip reasons reported
are `subject_mismatch` and `superseded_by_later_retrieval`.
`wrong_role` is absent. Since `_validate_candidate`
(`evidence_merge.py:464-467`) raises `wrong_role` whenever a
candidate's `slice_family` doesn't match `_role_family(scope.role)`,
zero such skips confirms the merge is consuming window-family rows
only — which is the intended architecture pre-WP8 per
`docs/current/cohort-maturity-selected-a-clock-evidence-clock-adapter-plan.md`
§"Pass A". The substrate choice is correct; the bugs are in how
the adaptation builds and uses it.

#### Defect A1 — Retrieval supersession destroyed the τ time-series (RESOLVED via conditioner option 2)

The 6-May-26 framing held that
`evidence_merge.merge_evidence_candidates` collapsed retrievals by
`(identity, observed_date)` and that this starved both the
conditioner and the display surface of the per-retrieval CDF growth
curve. The naive fix — drop supersession, keep all retrievals —
regressed
`test_active_multihop_cohort_midpoint_matches_a_clock_convolution_oracle`
because the conditioner's per-row Binomial treated nested cumulative
retrievals as independent observations and over-counted evidence.

The choice at the time was:

1. **Display path gets per-retrieval rows; conditioner keeps deduped
   one-row-per-cohort.** Contained Cluster A fix, no conditioner
   work.
2. **Add nested-observation handling to the conditioner**, then
   remove supersession globally. A real rewrite of the conditioner
   likelihood — bigger than this cluster, but produces correct
   inference under per-retrieval input.

**Option 2 was chosen and has landed.** The merge now keys by
`(identity, observed_date, retrieved_at, asat_materialised)` —
preserving the full per-cohort retrieval trajectory
(`evidence_merge.py:541-572`). The conditioner has been rewritten
around a multinomial cell decomposition: per cohort, the trajectory
is split into per-retrieval cells `(prev_F, cur_F)` whose
log-likelihood is
`(k_i − k_{i-1}) · log(p · (CDF(τ_i) − CDF(τ_{i-1})))`, with a
residual term `(n − k_last) · log(1 − p · CDF(τ_last))` evaluated
at the trajectory's actual final τ. Zero-increment cells (plateaus)
are walked through with `prev_F` advancing — they contribute zero
to the log-likelihood mathematically but are required so the
residual lands at the right τ. See
[`conditioner-nested-cumulative-likelihood-proposal.md`](conditioner-nested-cumulative-likelihood-proposal.md)
for the full design (§3 — "Correct likelihood").

The convolution-oracle test passes against the §3-compliant
conditioner. Sixty-three unit tests across
`test_primitive_conditioning.py`, `test_evidence_merge.py`, and
`test_primitive_evidence.py` pass alongside it. Two parity tests
pin the conditioner's reduction properties: the m=1 (single
retrieval per cohort) case is bit-identical to the legacy per-row
Binomial, and the plateau-with-survival-pressure case checks that
zero-increment cells advance `prev_F` and that the residual lands
at the trajectory's last τ.

#### Display-side mechanism (still open)

Once A1's substrate was corrected and the conditioner stopped
over-counting, the residual symptom is the carrier-reach factor
documented under §"Mechanism" above: chart `evidence_x` /
`evidence_y` are sourced from model-projected mass prefixes
(`runtime.selected_x_prefix` / `runtime.selected_y_prefix`) rather
than raw observation counts. The earlier "wild numbers" framing
(τ=19 expected 329, got 2584) described an over-shoot direction
that arose while the conditioner was still over-counting; with
that corrected the failure now consistently under-shoots by one
factor of carrier reach. Mechanism is the same — chart on a
different object than oracle — only the sign depends on which
carrier-reach regime the anchor sits at.

The earlier "A2/A3" framings in this tracker (clock-origin gate via
`temporal_basis`; missing `override_root_day_weights` at carrier and
subject maps) were unverified speculation and have been removed.

### Risk class

Real production bug in the new active-evidence path. Does not have a
shadow path, so observable in chart UI as well as tests. Reproducible
deterministically from the SIMPLE and LAT4 enriched fixtures via the
diagnostic probe in `/tmp/probe_simple_evidence.py` and
`/tmp/probe_lat4_evidence.py` (preserved here for the next pass).

## Cluster B — Daemon JSON.stringify exceeds V8's max string length (CLOSED 6-May-26)

**Resolution**: per-cell provenance bloat (`row_lineage`, nested
`dict(diagnostics)`, `placement_lineage`, and the
`rows[0]['_selected_a_clock_evidence']` block) gated behind an
`emit_diagnostics: bool = False` flag through the active-carrier evidence
build path. The flag is wired CLI → globalThis → request body → Python
BE so production callers never pay the V8-string-length cost; tests that
need provenance opt in via `--diag`. Both Cluster B tests now pass.

### Forensic record (preserved for future regressions)


### Symptom

Both tests run multi-hop cohort_maturity queries against
`cf-fix-deep-mixed`. The daemon completes the analysis (`[cli] Analysis
complete`) and then raises V8's `RangeError: Invalid string length`
during the protocol response write at
[`daemon.ts:68`](../../graph-editor/src/cli/daemon.ts#L68).

Single-hop queries against the same graph pass. Daemon RSS during the
failure is only 71.4 MiB — this is a string-size ceiling, not memory
exhaustion.

### Mechanism

The active-evidence rewrite has added rich provenance to every
`SelectedAClockEvidenceCell`. Two locations together cause O(cells ×
edges × rows × placements) string blow-up:

- `cohort_forecast_v3.py:1828` — surface provenance includes the full
  `row_lineage`: one entry per (raw row × matching anchor × τ × share)
  tuple, each containing `root_day_shares` and `placements` lists.
- `cohort_forecast_v3.py:1877` — every cell's provenance copies both
  surface provenances via `dict(diagnostics)`, materialising the
  lineage into each cell.

The resulting structure is then assigned into the row payload's
`_selected_a_clock_evidence.cells` (around `cohort_forecast_v3.py:2721`)
which is in turn JSON-serialised by `analyse.ts:416` and embedded in
the daemon protocol envelope at `daemon.ts:68`.

Multi-hop is the loaded case because the carrier and subject spans
each pull in multiple primitives, multiplying out lineage entries.
The single-hop active-carrier degeneration short-circuits cell
construction earlier (`cohort_forecast_v3.py:1921-1922`).

### Risk class

Diagnostic blow-up. The provenance fields involved have no live
consumer:

- `_selected_cohort_group_rate_draws` reads `prefixes_for_cohorts` /
  `aggregate_by_tau`, not provenance.
- The row consumer reads `x_at_query_x` / `y_at_subject_end` only.
- The frontend chart pipeline does not surface this block.

Removing or aggressively summarising the lineage and the nested
`dict(diagnostics)` should clear the failure without touching any
load-bearing object. Open question: whether to remove or to dump
to a separate diagnostic file under `runtime.diagnostics_path` so the
information stays available for future investigation without bloating
the protocol payload.

### Caveat

The protocol envelope is produced by `analyse.ts:416` (`JSON.stringify(result, null, 2)`)
and embedded inside `stdout` of the daemon response. If `analyse.ts`
is also writing the result to disk or to a different sink, that path
must be checked too — not yet verified.

## Cluster C — F vs E+F frontier agreement violated under drift (CLOSED 6-May-26)

**Resolution**: `tau_observed` in `build_cohort_evidence_from_frames`
was computed from `(last_frame_date − anchor_day)`, the forward-fill
horizon — an alias for the `(sweep_to − anchor_to)` proxy that
`docs/current/codebase/DATE_MODEL_COHORT_MATURITY.md` §2.2 explicitly
forbids as a frontier. Under `.asat()` drift the proxy extends past the
last real retrieval, inflating `tau_solid_max` and pulling the E+F
trajectory's "observed prefix" branch out to mid-projection. Replaced
with the canonical formula per §2.3: per-cohort
`max((data_retrieved_at − anchor_day).days)` over cells with non-null
provenance, clamped to `tau_max`. Cells gained a third tuple element
carrying `data_retrieved_at`; the producer
(`cohort_maturity_derivation.py:185-193`) sets it as the conservative
min-across-contributing-slices timestamp. No-provenance fallback is the
canonical-doc-prescribed lossy lower-bound (largest τ where y strictly
exceeds previous y); production paths preserve provenance per the
proposal's Audit B and don't engage the fallback. `tau_future_max`
remains coupled to `(sweep_to − anchor_from)` as the comment block at
the build site warns.

Design proposal:
[`cohort-maturity-frontier-from-data-retrieved-at.md`](cohort-maturity-frontier-from-data-retrieved-at.md).

Test surface:
- `test_f_mode_equals_ef_at_frontier_under_drift` — the original
  failing assertion, now passing.
- Three new unit tests in
  `test_selected_cohort_pop_d_distribution.py` pin the canonical case
  and the two documented lossy-fallback failure modes (all-zero-y
  cohorts and post-conversion plateaus).

Adjacent proxies in `cohort_forecast_v2.py:637-646` and
`api_handlers.py:344` (surprise gauge `frontier_age`) were audited
and flagged as out of scope; both still carry the same defective
`(last_frame_date − anchor_day)` proxy and should be triaged
separately if those analysis paths surface comparable symptoms.

### Forensic record (preserved for future regressions)


### Symptom

`test_f_mode_equals_ef_at_frontier_under_drift` (test file line 3040)
asserts that at τ = `tau_solid_max` (the frontier of epoch A), F-mode
(`p × CDF(τ)` aggregate model) and E+F (data-conditioned trajectory)
agree to within `_FMODE_FRONTIER_AGREE_TOL = 0.01`. The test rationale
is that at the frontier the latency CDF is still tiny so both lines
should sit near zero.

Observed: at τ=40 (frontier) F=0.4444, E+F=0.1689, |Δ|=0.2755.

The paired anti-test
`test_f_mode_diverges_from_ef_off_frontier_under_drift` continues to
pass — F is divergent off-frontier, which is the post-fix contract.

### Mechanism (preliminary)

`_f_curve` reads `model_midpoint` from the row payload; `_ef_curve`
reads `midpoint`. The new `SelectedAClockEvidence.aggregate_by_tau`
(introduced in `cohort_forecast_v3.py` between the WIP additions) feeds
the per-cohort projection that produces the E+F midpoint, with
explicit boundary semantics around `tau_solid_max` (denominator
splices to `boundary_x` post-frontier).

Two competing readings:

- **Real regression**: F-mode lost or never had the per-fixture
  `p × CDF` reduction at the frontier — F=0.4444 is far above zero,
  which is consistent with F being projected without the latency-CDF
  scaling for this fixture's `mu=2.0, sigma=0.4, onset=1` lognormal.
  The pre-WIP value at τ=40 must have been close to zero or the test
  would not have been calibrated to 0.01.
- **Calibration drift**: the new clock-adapted E+F path correctly
  reduces evidence at the frontier (sparse selected-cohort prefixes;
  CDF/as-of carry-forward replaces frame bloat), and the test's
  agreement assumption was load-bearing on the pre-WIP frame
  evidence's permissive aggregation.

### Open questions

- What does `_f_curve` evaluate to at τ=40 against a fixture with
  identical mu/sigma/onset but **without** drift? If F=0.4444 there too,
  F-mode has a genuine regression independent of E+F.
- What is the latency CDF mass at τ=40 in this fixture? If small,
  F=0.4444 cannot be `p × CDF`, so F-mode has lost the CDF factor.
- The plan (§"Field Semantics") is silent on F-mode reduction logic;
  the relevant code path needs walking before deciding which side
  moved.

### Risk class

Unresolved. Either real regression in F-mode projection, or
correctness fix that retired the test's invariant. Until one of those
is confirmed by reading the F-mode projection code, do **not** widen
the tolerance and do **not** delete the test.

## Cluster D — Epoch-A coverage non-unity under daily snapshot density

### Symptom

`test_coverage_one_in_epoch_a_linear_decay_in_epoch_b_zero_at_epoch_c`
(test file line 3157) is a blind invariant test against `synth-lat4`
with a 14-day cohort anchor range
(`from(synth-lat4-b).to(synth-lat4-c).cohort(1-Mar-26:14-Mar-26)`).
It asserts that `coverage` equals 1.0 across all of epoch A
(τ ≤ `tau_solid_max` = 53) under daily snapshot density. Observed:

```
τ=0 : None
τ=1 : 0.0
τ=2 : 0.0
τ=3 : 0.0
τ=4 : 0.3409
τ=5 : 0.4329
τ=6 : 0.6071
τ=7 : 0.8189
τ=8 : 0.9638
```

Coverage ramps from 0 to ~1 over τ=1..9 instead of being 1.0
throughout epoch A. The values at τ=4..8 are close to multiples
of 1/14 (5/14, 6/14, 8.5/14, 11.5/14, 13.5/14) — consistent with
the count of cohorts contributing an exact-τ landing growing from
~5 to 14 across that range.

### Mechanism (preliminary)

`coverage` for an active row is computed in
[`SelectedAClockEvidence.aggregate_by_tau`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L301)
(`cohort_forecast_v3.py:301-338`) as
`sum_carrier_coverage / cohort_denom` where each cohort's per-cell
contribution is set in
[`_build_observed_span_evidence_surface`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2520)
(`cohort_forecast_v3.py:2520-2537`):

```
landing_coverage = min(1.0, total_share)   where
total_share = Σ_edge share_at(anchor_day, τ)   (exact-τ shares)
```

The exact-τ semantics is deliberate per the design
(`docs/current/cohort-maturity-evidence-coverage-design.md` §2.2 /
§2.4) — forward-fill is for value, not for coverage. A cohort
contributes to `total_share` at τ only if at least one edge has a
row landing at exactly that τ. The denominator is
`n_cohorts_in_scope` (the admissible-cohort count, 14 here).

Two candidate causes — distinguishable by `--diag` against the same
DSL:

1. **Evidence-superset construction is missing low-τ placements
   despite snapshots covering them.** The exact-τ shares for
   cohorts at low τ are absent from `edge_share_surfaces`, even
   though raw rows landing at those τ exist in the DB. This would
   show up as missing entries in the surface provenance for
   anchor_day = `2026-03-14`, τ = 1 (retrieved_at = `2026-03-15`).
2. **`n_cohorts_in_scope` includes anchors that structurally cannot
   contribute at low τ.** If admission counts cohorts whose first
   retrieval is dated several days after the anchor, the
   denominator at τ=1 is 14 but the numerator is whatever fraction
   has an exact-τ=1 landing — ramping naturally as anchor maturities
   align.

The numeric pattern (multiples of 1/14, ramp aligning with cohort
range) is consistent with either, and a `--diag` probe of the
surface construction at τ=1 against the raw DB rows for an anchor
known to have a snapshot retrieved at anchor_day+1 will distinguish
them. Not yet done.

### Risk class

Real production defect or test calibration drift, not yet
distinguished. The test was added as a blind invariant in the
current uncommitted diff and has never passed. Do **not** widen the
property or skip the test before the `--diag` probe lands a verdict.

## Stale-architecture test — adjacent suite

`test_per_draw_cdf_variation_drives_is_separation` in
`graph-editor/lib/tests/test_subject_span_cdf_ownership.py` fails
under the post-73n architecture. The test asserts
`compute_forecast_trajectory` produces `n_cohorts_conditioned == 1`
when a single cohort is supplied; the 73n stage-9 cleanup
deliberately moved conditioning out of the trajectory engine
(`forecast_state.py:1296-1305` — "No aggregate-IS conditioning
here. Conditioning is owned by `runner.primitive_conditioning.
condition_primitive`; the trajectory engine is a pure projector.").
The test's expectation is stale.

This is not part of the outside-in suite but appears in adjacent
runs and is recorded here so that future agents do not redo the
diagnosis. Either rewrite the test against the new architecture
(call `condition_primitive` first, then check
`n_cohorts_conditioned`) or retire the test as stale-by-design.

## Investigation Discipline

Outstanding work: Cluster A display-side and Cluster D.

1. **Cluster A display-side** — pick which side moves: re-route
   chart `evidence_x` / `evidence_y` back to raw observation counts,
   or update the oracle to match the mass-weighted prefix
   definition. Governing plan:
   [`cohort-maturity-selected-a-clock-evidence-clock-adapter-plan.md`](cohort-maturity-selected-a-clock-evidence-clock-adapter-plan.md).
   Probe the carrier-reach signature on a single
   `(anchor_day, τ)` cell to confirm the diagnosis end-to-end before
   committing to a side.

2. **Cluster D** — `--diag` probe of
   `_build_observed_span_evidence_surface` at low τ against raw DB
   rows for a known-retrieved anchor. Distinguish "missing
   placements" from "denominator counts inadmissible cohorts". Do
   not speculate further until the probe lands.

3. **Re-probe after a substrate change.** The convolution-oracle
   fix lands a substantive change to the conditioner; any
   speculation against the pre-v6 code path no longer applies.
   Re-derive arithmetic against the current substrate before drawing
   conclusions.

4. **Probes preserved.** `/tmp/probe_db_rows.py` (DB row enumeration,
   used to prove A1), `/tmp/probe_simple_evidence.py` (display
   surface diagnostic), `/tmp/probe_lat4_evidence.py` (multi-hop
   variant). Move to a durable location before they are GC'd.

## Pointers

- Display-side adapter plan:
  [`cohort-maturity-selected-a-clock-evidence-clock-adapter-plan.md`](cohort-maturity-selected-a-clock-evidence-clock-adapter-plan.md)
- Conditioner design (now landed):
  [`conditioner-nested-cumulative-likelihood-proposal.md`](conditioner-nested-cumulative-likelihood-proposal.md)
- Coverage design referenced by Cluster D:
  [`cohort-maturity-evidence-coverage-design.md`](cohort-maturity-evidence-coverage-design.md)
- Recent handover:
  [`handover/5-May-26-active-cohort-display-evidence.md`](handover/5-May-26-active-cohort-display-evidence.md)
- Adjacent investigation:
  [`cohort-curve-collapse-investigation-handover.md`](cohort-curve-collapse-investigation-handover.md)
- Adjacent problem statement:
  [`cohort-maturity-mc-wrong-object-problem-statement.md`](cohort-maturity-mc-wrong-object-problem-statement.md)
- The 73r plan that flows from this work:
  [`project-bayes/73r-generalised-primitive-evidence-acquisition-plan.md`](project-bayes/73r-generalised-primitive-evidence-acquisition-plan.md)
