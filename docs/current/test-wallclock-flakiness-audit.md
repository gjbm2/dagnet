# Test Wallclock-Flakiness Audit

**Status**: In progress — `test_cohort_factorised_outside_in.py` partly pinned (17 of 26 in-scope tests; `-1d:` subset deferred). Other 19 files unstarted.
**Date**: 29-Apr-26
**Today (analysis anchor at pin date)**: 2026-04-29
**Fixture data span (synth-mirror-4step, synth-simple-abc, etc.)**: 12-Dec-25 to 21-Mar-26 (deterministic per [bayes/synth_gen.py](../../bayes/synth_gen.py) `base_date` + `n_days=100`)

## Progress log

- **29-Apr-26**: worked example completed on `test_a_equals_x_identity_collapses_to_window`. Pattern validated. 16 additional tests in `test_cohort_factorised_outside_in.py` pinned via the same pattern. All 33 non-xfail tests in the file pass. `-1d:` subset (≤9 tests) deferred — they need vacuous-by-design vs narrow-real-evidence design decision.

## Purpose

Catalogue every Python test in [graph-editor/lib/tests](../../graph-editor/lib/tests) that uses relative-date DSL forms (`window(-Nd:)`, `cohort(-Nd:)`, `cohort(<anchor>,-Nd:)`, `asat(-Nd)`) and is therefore subject to wallclock drift. For each test, record:

- **Authoring window** — when the test was added / last touched. Used to judge how likely it is that the *current* pass result is trustworthy versus an artefact of fixture drift since authoring.
- **Risk** — vacuity (does the relative form currently resolve to a date range with no fixture overlap?) and drift coupling (does the assertion read values that depend on `today`-derived quantities like `sweep_to`, `eval_age`, max-τ, forecast horizon?).
- **Intent** — what is the test really verifying, stripped of the relative-DSL packaging?
- **Plan to harden** — minimal change that makes the test invariant under wallclock advancement while preserving its intent.

This doc is the working ledger for the hardening pass. It is not a hardening *strategy* — the strategy is in [`#hardening-toolkit`](#hardening-toolkit). It is the per-test inventory the strategy is applied against.

## Methodology

### Vacuity table (today = 2026-04-29, fixture ends 21-Mar-26)

| Relative form | Resolves to | Fixture overlap | Status |
|---|---|---|---|
| `window(-1d:)` | 28-Apr-26 to 29-Apr-26 | 0 days | **Fully vacuous** |
| `window(-7d:)` | 22-Apr-26 to 29-Apr-26 | 0 days | **Fully vacuous** |
| `window(-14d:)` | 15-Apr-26 to 29-Apr-26 | 0 days | **Fully vacuous** |
| `window(-30d:)` | 30-Mar-26 to 29-Apr-26 | 0 days | **Fully vacuous** |
| `window(-60d:)` | 28-Feb-26 to 29-Apr-26 | ~22 days | Partial |
| `window(-90d:)` | 29-Jan-26 to 29-Apr-26 | ~52 days | Partial |
| `window(-120d:)` | 30-Dec-25 to 29-Apr-26 | ~82 days | Substantial |
| `window(-180d:)` | 31-Oct-25 to 29-Apr-26 | Full fixture | Full |

A vacuous resolution does not necessarily mean the test fails — many tests pass "trivially" against zero-evidence (posterior-only) curves. Per anti-pattern 17 in [KNOWN_ANTI_PATTERNS.md](codebase/KNOWN_ANTI_PATTERNS.md), this is the *worst* failure mode: tests appear green but exercise the early-return path, not the population model.

### Drift-coupling categories

A test is **drift-coupled** if its assertion reads values that vary with implicit `today` even when window/cohort scope is pinned to absolute dates. The four mechanisms (mapped in [analysis_subject_resolution.py:458-471](../../graph-editor/lib/analysis_subject_resolution.py#L458-L471), [api_handlers.py:3524-3560](../../graph-editor/lib/api_handlers.py#L3524-L3560)):

- **`sweep_to` drift** (cohort_maturity, sweep_simple): sweep upper bound = `_resolve_date(asat)`, defaults to today when asat omitted. Affects per-anchor row count, max-τ, last-row presence.
- **`eval_age` drift** (conditioned_forecast): maturity horizon computed from today. Affects forecast trajectory tail.
- **Max-τ drift**: a special case of either of the above when assertion uses `max(curve)` or `last(rows)`.
- **Bin-count drift**: a special case where the BE bins by τ; bin count grows with sweep extent.

The remaining asat-controlled paths (snapshot retrieved_at filter, scope-hash, virtual-snapshot cache key — see [evidence_merge.py:480-485](../../graph-editor/lib/evidence_merge.py#L480-L485), [snapshot_service.py:707-709](../../graph-editor/lib/snapshot_service.py#L707-L709)) are *not* drift sources for current synth fixtures because synth `retrieved_at` is `base_date + fetch_night`, deterministic and bounded inside the fixture's simulated window.

### Authoring-window risk

For tests authored when "today" was within fixture range (≲ 23-Mar-26 for `-1d:`, ≲ 21-Apr-26 for `-30d:`, etc.), the relative form's resolution at authoring time was inside fixture. The test's intent was "exercise this analysis with this much recent fixture data". As wallclock advances past those thresholds, the test silently becomes vacuous. The authoring date tells us whether we're still inside the test's design envelope.

| Authoring date | `-1d:` design intent? | `-30d:` design intent? | `-90d:` design intent? |
|---|---|---|---|
| ≤ 21-Mar-26 | Yes | Yes | Yes |
| 22-Mar-26 to 21-Apr-26 | No (already vacuous when authored) | Yes | Yes |
| 22-Apr-26 to 19-Jun-26 | No | No | Yes |
| 20-Jun-26 onwards | No | No | No |

Only tests authored inside the relevant envelope can be assumed to have ever exercised the population model under their relative form. The rest were either testing the zero-evidence path deliberately (legitimate) or vacuously by accident (a defect from day one).

## Hardening toolkit

Per the analysis in earlier discussions, available tools and their costs:

- **(a) Pin DSL scope absolutely.** Convert `window(-Nd:)` → `window(<absolute>:<absolute>)`. **Pin to today's-resolution at pin date** (i.e. the absolute equivalent of the relative form *as it currently resolves*). Free of confounders. Doesn't fix sweep_to / eval_age drift, but for symmetric assertions this drift is harmless (both sides drift identically).
- **(b) Add `.asat(<date>)`.** Freezes sweep_to and eval_age at the asat value. **Risky**: asat triggers six confounding code paths in the BE (admission filter, scope hash, sweep-cap, SQL filter, cache key, eval_age compute). Using asat as a stability mechanism makes test outcomes dependent on asat being defect-free. Only appropriate for tests whose intent is genuinely "as of date X" (the existing `test_asat_blind` pattern).
- **(c) Wallclock-freeze in test context.** For in-process tests, `freezegun`-style `date.today()` patch. For daemon-routed tests, would require threading a frozen-today through FE+BE+DB+synth-regen — large surface, large audit cost.
- **(d) Modify synth fixtures.** Regenerate with adjusted `base_date`, `n_days`, or `retrieved_at` distribution if a test's premise requires a fixture shape we don't have.
- **(e) Re-author assertion.** Express test intent without coupling to drift-sensitive quantities. Preferred whenever the assertion is drift-coupled but the underlying intent is not.

The principle: most drift can be eliminated by **(a) + (e)**. **(b)** and **(c)** are reserved for a small minority. **(d)** is for cases where neither rewriting the assertion nor pinning the DSL covers the intent.

### Pin-date choice (lessons learned from worked example)

When applying (a), the absolute date range matters. Two natural choices, only one is right:

- **❌ Fixture-full** (e.g. `window(12-Dec-25:21-Mar-26)` covering the synth's entire data span): tested first, **wrong**. Widens `sweep_to` span unnecessarily (sweep extends from `anchor_from` to today; earlier `anchor_from` → wider sweep range → ~75% runtime increase) for no test-value gain on symmetric assertions. The test ran ~28s vs ~16s for unpinned.
- **✅ Today's-resolution** (e.g. `window(29-Jan-26:29-Apr-26)` for `-90d:` at today=29-Apr-26): preserves the exact evidence regime and sweep range the test was running on at pin date. Runtime matches unpinned. No semantic shift.

The pin date and resolution rule is **encoded in the comment** so a future reader can reconstruct the intent. Conversion table at pin date 29-Apr-26:

| Relative form | Today's-resolution absolute |
|---|---|
| `window(-1d:)` / `cohort(-1d:)` | `28-Apr-26:29-Apr-26` (currently outside fixture; vacuous) |
| `window(-7d:)` / `cohort(-7d:)` | `22-Apr-26:29-Apr-26` (vacuous) |
| `window(-14d:)` | `15-Apr-26:29-Apr-26` (vacuous) |
| `window(-30d:)` / `cohort(-30d:)` | `30-Mar-26:29-Apr-26` (vacuous) |
| `window(-60d:)` | `28-Feb-26:29-Apr-26` (~22 days fixture) |
| `window(-90d:)` / `cohort(-90d:)` | `29-Jan-26:29-Apr-26` (~52 days fixture) |
| `window(-120d:)` | `30-Dec-25:29-Apr-26` (~82 days fixture) |
| `window(-180d:)` / `cohort(-180d:)` | `31-Oct-25:29-Apr-26` (full fixture) |

### Synth fixture stability — verified

A pinning approach that depends on `today` was meaningful at the pin date assumes the fixture data doesn't change underneath us. Confirmed during the worked example:

- `bayes/synth_gen.py` hardcodes per-graph `base_date` and uses `seed=42` ([line 1196](../../bayes/synth_gen.py#L1196)). Regeneration is content-deterministic.
- `verify_synth_data` ([synth_gen.py:394-460](../../bayes/synth_gen.py#L394-L460)) checks only content hashes (truth SHA256, graph SHA256, param hashes, FE-parity probe). **No wallclock-based staleness criterion exists**; the synth never regenerates "because it got old".
- `enriched_at` and `generated_at` in synth-meta are wallclock-stamped but consumed only by self-tests of the synth machinery — not by the analysis pipeline our tests call.
- Snapshot DB rows have `retrieved_at = base_date + fetch_night` — also deterministic, not wallclock.

So a today's-resolution pin at 29-Apr-26 stays valid through any number of regenerations, as long as `base_date` and `n_days` remain unchanged in source.

### Symmetric-assertion principle

Tests that compare two same-DSL-shape calls (window vs cohort, v2 vs v3, parity across CLI surfaces) and assert agreement within tolerance are **wallclock-invariant in result** by virtue of symmetric drift, even when the underlying values change. Both sides drift together; their delta doesn't depend on where they happen to be looking. For these, the pin is mostly cosmetic — it makes the evidence regime explicit and reproducible, and protects against the silent slide into vacuity (which would still pass trivially but stop testing the population model — AP17).

### Aside: per-call BE latency

During timing the worked example, observed ~8s per `analyse` CLI call against the 4-node `synth-simple-abc` graph. user-time was ~7s for an entire pytest invocation, so wall-clock is dominated by waiting on the BE over HTTP, not by Python work in the test process. Likely contributors: `--no-snapshot-cache` and `--no-cache` flags (deliberate, for correctness), daemon→BE round-trip, BE-side per-call setup. The full file (34 tests, ~2 calls/test) takes ~3m50s. Worth a separate audit (CLAUDE.md flags slow dev tooling as blocking) but **out of scope for this hardening pass**.

## Aggregate findings

- **20 test files** carry relative-DSL forms.
- **~190 occurrences** spread across roughly **95 distinct test functions**.
- **~30-35%** of those test functions have observable wallclock-flakiness risk; **~15%** are in critical (already-vacuous on `-1d:`/`-7d:`/`-14d:`/`-30d:`) or high-risk tiers today.
- Most files were added in **April 2026**; only [test_snapshot_read_integrity.py](../../graph-editor/lib/tests/test_snapshot_read_integrity.py) (Feb-26) and [test_cohort_maturity_derivation.py](../../graph-editor/lib/tests/test_cohort_maturity_derivation.py) (Feb-26) predate the current cycle. The latter has no relative DSL — fully drift-immune.
- Tests authored in the last 7 days using `-1d:` / `-7d:` were **already vacuous when committed** — they encode design intent that was wrong-from-day-one given the fixture span, OR they're deliberately testing the zero-evidence path (in which case the relative form is misleading and should be replaced by an explicit empty-window).

## Per-file audit

Files are ordered roughly by the volume of relative-DSL exposure. Each file lists test functions that use relative forms; tests with no relative DSL are omitted unless they coexist meaningfully with flakey tests in the file.

---

### test_cohort_factorised_outside_in.py — 47 occurrences (17 pinned 29-Apr-26, ~9 deferred)

**File added**: 26-Apr-26 (3 days before today). Last touched: 29-Apr-26.

**File status note**: this is the largest single source of wallclock flakiness in the suite, and the most recently-authored. The volume of `-1d:` and `-90d:` forms suggests tests were written assuming today was within fixture range (i.e., expecting `-1d:` to give the test 1-2 days of recent fixture data). Today's wallclock has already drifted past that envelope for `-1d:`.

**Drift coupling**: the file's assertions are heavy on tau-curve comparisons (cohort vs window), p_infinity scalars, and FE/BE parity — all eval_age/sweep_to-sensitive. Several tests currently passing may be passing only because both sides of the comparison are computed from posterior-only (vacuous evidence) and therefore agree trivially.

**Pinning convention applied** (29-Apr-26): module docstring carries the rationale; per-test inline comments reserved for the worked example only. Patterns pinned:

- `window(-90d:)` / `cohort(-90d:)` → `29-Jan-26:29-Apr-26` (today's-resolution at pin date)
- `cohort(synth-lat4-{a,b,c},-90d:)` / `cohort(simple-b,-90d:)` / `cohort({anchor},-90d:)` → same with anchor preserved
- `window(-180d:)` / `cohort(-180d:)` → `31-Oct-25:29-Apr-26`

**`-1d:` patterns deliberately NOT pinned** — they need per-test design decisions:
- vacuous-by-design (replace with explicit out-of-fixture absolute window like `window(1-Jan-30:2-Jan-30)`), or
- narrow-real-evidence (replace with absolute narrow window inside fixture like `window(20-Mar-26:21-Mar-26)`, possibly with synth modification if the existing fixture's tail isn't fit-for-purpose).

**Disposition**:

| Test | Status |
|---|---|
| `test_a_equals_x_identity_collapses_to_window` | ✅ pinned (worked example, has inline comment) |
| `test_single_hop_non_latent_upstream_collapses_to_window` (parametrised) | ✅ pinned |
| `test_single_hop_latent_upstream_lags_window_but_converges_to_same_subject_p` | ⏸ deferred (`-1d:`, vacuous-by-accident or narrow-real intent unclear) |
| `test_anchor_depth_monotonicity_for_same_subject` | ✅ pinned (initially flagged for separate reasoning, turned out symmetric) |
| `test_same_carrier_shared_across_different_subjects` | ✅ pinned |
| `test_low_evidence_cohort_matches_factorised_convolution_oracle` | ⏸ deferred (`-1d:`, name suggests vacuous-by-design intent) |
| `test_no_evidence_single_hop_matches_unconditioned_fw_convolution_midline` | ✅ no relative DSL — already drift-immune |
| `test_low_evidence_single_hop_remains_near_unconditioned_oracle` | ✅ no relative DSL — already drift-immune |
| `test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel` | ✅ no relative DSL |
| `test_factorised_convergence_identity_cohort` | ⏸ deferred (`-1d:`) |
| `test_factorised_p_convergence_instant_edge` | ✅ pinned |
| `test_multihop_non_latent_upstream_collapse` | ✅ pinned |
| `test_multihop_latent_upstream_divergence` | ✅ pinned (`-180d:` → `31-Oct-25:29-Apr-26`) |
| `test_multihop_subject_span_is_not_last_edge_or_param_pack_scalar` | ⏸ deferred (`-1d:`) |
| `test_cli_window_single_edge_scalar_identity_across_public_surfaces` | ✅ pinned |
| `test_cli_identity_collapse_matches_window_across_public_surfaces` | ✅ pinned |
| `test_cli_single_hop_downstream_cohort_parity_and_admitted_provenance` | ✅ pinned (status remains xfail) |
| `test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point` | ✅ pinned (initially flagged for re-authoring, assertion turned out symmetric in practice) |
| `test_cohort_and_window_p_infinity_converge_for_same_subject_rate` (parametrised) | ⚠️ partial — 2 of 3 rows pinned; 1 row with `-1d:` deferred |
| `test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case` | ✅ pinned |
| `test_cohort_frame_evidence_does_not_retarget_carrier_or_subject` | ✅ pinned |
| `test_zero_evidence_window_rises_as_subject_cdf` | ⏸ deferred (`-1d:`, vacuous-by-design — needs explicit out-of-fixture absolute) |
| `test_parity_window_mature_high_evidence_p_mean` | ✅ pinned |
| `test_parity_cohort_identity_collapse_p_mean` | ✅ pinned |
| `test_parity_subject_equivalent_cohort_anchor_override_p_mean` | ✅ pinned |
| `test_fe_topo_cohort_c_to_d_p_mean_stays_near_truth` (parametrised) | ✅ pinned |
| `test_parity_zero_evidence_cohort_returns_prior` | ✅ pinned (uses `window(-90d:)`) |
| `test_d0_bayes_vars_actually_promotes_to_bayesian` | ✅ pinned |
| `test_d1_parity_analytic_vs_bayes_mature_window` | ✅ no relative DSL (uses inherited DSL via decorator/helper) |
| `test_d2_parity_analytic_vs_bayes_identity_collapse_cohort` | ✅ no relative DSL |
| `test_d3_parity_analytic_vs_bayes_zero_evidence_returns_prior` | ✅ no relative DSL |
| `test_d4_parity_analytic_vs_bayes_low_evidence_cohort_F1_signature` | ✅ pinned |

Verification: full-file run after pinning shows **33 pass + 1 xfail (unchanged)**, no regressions. Runtime: ~3m50s.

The original per-test entries below preserve the pre-pinning intent / drift / vacuity analysis as a record. They are not updated post-hoc; the disposition above is authoritative for current state.

**Original per-test analysis**:

- `test_a_equals_x_identity_collapses_to_window` (line 726-727) — `window(-90d:)`, `cohort(-90d:)` on synth-simple-abc. **INTENT**: identity collapse — when A=X, cohort and window must agree. **DRIFT**: eval_age (curve comparison). **VACUITY**: partial. **PLAN**: pin scope; verify intent via curve comparison still meaningful with current ~52-day fixture overlap.
- `test_single_hop_non_latent_upstream_collapses_to_window` (lines 776-777) — same pair, parametrised. **Same plan.**
- `test_single_hop_latent_upstream_lags_window_but_converges_to_same_subject_p` (lines 808-809, 833-834) — `window(-1d:)` and `cohort(-1d:)` on synth-lat4 b-c edge. **INTENT**: under upstream latency, cohort lags window but reaches same p_infinity. **DRIFT**: eval_age (lag signature). **VACUITY**: fully vacuous — the test currently passes against posterior-only curves, exercising the trivial path. **PLAN**: this is the test that exposed AP17 in earlier work; intent depends on lag-distinct curves which require non-zero evidence. Either re-author with absolute scope inside fixture (e.g. `window(20-Mar-26:21-Mar-26)`) and accept the assertion may need re-tuning, or replace with an explicit zero-evidence test if that's the actual intent. Needs design decision.
- `test_anchor_depth_monotonicity_for_same_subject` (lines 844-847) — `window(-90d:)` plus three anchor variants `cohort(synth-lat4-c,-90d:)`, `cohort(synth-lat4-b,-90d:)`, `cohort(synth-lat4-a,-90d:)`. **INTENT**: as anchor moves further upstream, cohort curve lags more. **DRIFT**: eval_age. **VACUITY**: partial. **PLAN**: pin scope; verify monotonicity assertion still holds.
- `test_same_carrier_shared_across_different_subjects` (lines 903-904) — `cohort(-90d:)` on two subjects. **INTENT**: shared upstream carrier produces shared cohort behaviour. **DRIFT**: eval_age. **VACUITY**: partial. **PLAN**: pin scope.
- `test_low_evidence_cohort_matches_factorised_convolution_oracle` (line 970) — `cohort(-1d:)`. **INTENT**: low-evidence cohort matches oracle curve. **DRIFT**: eval_age. **VACUITY**: fully vacuous. **PLAN**: this test wants low evidence — `-1d:` has been picking that "naturally" via vacuity. Replace with an explicit narrow absolute window inside fixture (e.g. last 1-2 days of fixture) so the test runs deliberately on low-but-real evidence.
- `test_factorised_convergence_identity_cohort` (line 1036) — `cohort(-1d:)`. **INTENT**: identity collapse on narrow cohort. **VACUITY**: fully vacuous. **PLAN**: same as above — replace with narrow absolute window inside fixture.
- `test_factorised_p_convergence_instant_edge` (line 1056) — `cohort(-90d:)` on cf-fix-no-lag. **INTENT**: p_infinity convergence on instant edges. **VACUITY**: partial. **PLAN**: pin scope.
- `test_multihop_non_latent_upstream_collapse` (lines 1080-1081) — `window(-90d:)` and `cohort(-90d:)`. **INTENT**: multi-hop without upstream latency collapses to window. **VACUITY**: partial. **PLAN**: pin scope.
- `test_multihop_latent_upstream_divergence` (lines 1106-1107) — `window(-180d:)` and `cohort(-180d:)` on cf-fix-deep-mixed. **INTENT**: multi-hop with upstream latency diverges. **VACUITY**: full. **PLAN**: pin scope (low-risk, full fixture coverage).
- `test_multihop_subject_span_is_not_last_edge_or_param_pack_scalar` (lines 1128, 1134-1135) — `window(-1d:)` on synth-lat4. **INTENT**: subject span semantics distinct from last edge. **VACUITY**: fully vacuous. **PLAN**: replace with narrow absolute window.
- `test_cli_window_single_edge_scalar_identity_across_public_surfaces` (line 1161) — `window(-90d:)`. **INTENT**: scalar identity across CLI surfaces. **VACUITY**: partial. **PLAN**: pin scope.
- `test_cli_identity_collapse_matches_window_across_public_surfaces` (lines 1178-1179) — `window(-90d:)` and `cohort(synth-lat4-c,-90d:)`. **INTENT**: identity-collapse cohort matches window. **VACUITY**: partial. **PLAN**: pin scope.
- `test_cli_single_hop_downstream_cohort_parity_and_admitted_provenance` (lines 1256-1257) — paired `window(-90d:)` and `cohort(synth-lat4-b,-90d:)`. **INTENT**: cohort parity with provenance. Currently `xfail`. **PLAN**: pin scope; xfail status is independent of hardening.
- `test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point` (line 1342) — `cohort(synth-lat4-b,-90d:)`. **INTENT**: projection parity uses last-row saturation. **DRIFT**: max_tau (last-row depends on sweep_to). **VACUITY**: partial. **PLAN**: re-author assertion to use a specific anchor's last-row, not "last" generically; then pin scope.
- `test_cohort_and_window_p_infinity_converge_for_same_subject_rate` (parametrised, lines 1383-1385) — three combinations including `window(-1d:)`/`cohort(-1d:)` on synth-lat4-b-c. **INTENT**: p_infinity convergence between window and cohort for the same subject. **DRIFT**: eval_age. **VACUITY**: mixed (-1d fully vacuous; -90d partial). **PLAN**: replace `-1d:` parametrisation with absolute narrow window; pin -90d cases.
- `test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case` (lines 1413, 1418, 1423) — `window(-90d:)` + two `cohort(synth-lat4-c,-90d:)` and `cohort(synth-lat4-b,-90d:)`. **INTENT**: cohort-frame admission gating by anchor-override. **VACUITY**: partial. **PLAN**: pin scope.
- `test_cohort_frame_evidence_does_not_retarget_carrier_or_subject` (lines 1470-1472) — same triplet. **PLAN**: pin scope.
- `test_zero_evidence_window_rises_as_subject_cdf` (line 1517) — `window(-1d:)` parametrised across graphs. **INTENT**: zero-evidence window curve rises as subject CDF (posterior-only behaviour). **VACUITY**: fully vacuous **by design** — this test wants zero evidence. **PLAN**: replace `-1d:` with a clearly-out-of-fixture absolute date (e.g. `window(1-Jan-30:2-Jan-30)`) and add a comment that the empty window is deliberate.
- `test_parity_window_mature_high_evidence_p_mean` (line 1573) — `window(-90d:)`. **INTENT**: mature window p_mean parity. **VACUITY**: partial. **PLAN**: pin scope.
- `test_parity_cohort_identity_collapse_p_mean` (line 1606) — `cohort(synth-lat4-c,-90d:)`. **PLAN**: pin scope.
- `test_parity_subject_equivalent_cohort_anchor_override_p_mean` (line 1641) — `cohort(synth-lat4-b,-90d:)`. **PLAN**: pin scope.
- `test_fe_topo_cohort_c_to_d_p_mean_stays_near_truth` (parametrised line 1679) — `cohort(<anchor>,-90d:)`. **PLAN**: pin scope.
- `test_parity_zero_evidence_cohort_returns_prior` (line 1876) — `window(-90d:)` (yes, named "cohort" but uses window DSL — verify). **PLAN**: pin scope; check naming.
- `test_d0_bayes_vars_actually_promotes_to_bayesian` (line 1917) — `window(-90d:)`. **PLAN**: pin scope.
- `test_d4_parity_analytic_vs_bayes_low_evidence_cohort_F1_signature` (line 1964) — `cohort(simple-b,-90d:)`. **PLAN**: pin scope.

---

### test_v2_v3_parity.py — 27 occurrences

**File added**: 14-Apr-26. Last touched: 29-Apr-26.

**File status note**: v2/v3 handler parity tests. Authored when today was within fixture for `-90d:` (today=14-Apr → -90d=14-Jan, with fixture starting 12-Dec, ~63 days overlap). Now (29-Apr) overlap is ~52 days. Still partial but slightly degraded since authoring.

**Tests using relative DSL** (selective — full list to be filled in during hardening pass):

- Multiple `window(-90d:)` and `cohort(-90d:)` parity tests (lines 174, 232, 271, 341, 384, 632-657). **INTENT**: handler v2 vs v3 produce identical output for given DSL. **DRIFT**: indirect — both handlers see same drift, so parity persists; but baselines may drift away from any hardcoded reference values. **PLAN**: pin scope. Parity assertions are robust to scope choice.
- `test_narrow_cohort_final_stage_parity` (line 1118) and `test_narrow_window_final_stage_parity` (line 1379) — `cohort(-1d:)`, `window(-1d:)`. **INTENT**: parity on narrow temporal scope. **VACUITY**: fully vacuous. **PLAN**: replace with absolute narrow window inside fixture.
- `test_full_parametrised_parity_matrix` (line 1605) — three-way parametrisation including `window(-90d:)` and `cohort(-90d:)`. **PLAN**: pin scope.
- `test_window_cohort_mode_distinction` (lines 868-911) — `window(-1d:)` and `cohort(-1d:)` on a downstream prod edge. **INTENT**: window and cohort must NOT collapse to identical curves. **VACUITY**: fully vacuous. **PLAN**: this test specifically guards against mode collapse — needs non-zero evidence to be meaningful. Replace with absolute narrow window inside fixture.
- Various `cohort(-14d:)` / `window(-14d:)` / `cohort(-7d:)` (lines 776, 789, 799, 834). **VACUITY**: fully vacuous. **PLAN**: replace with absolute narrow windows inside fixture.

---

### test_analysis_subject_resolution.py — 18 occurrences

**File added**: 8-Apr-26. Last touched: 23-Apr-26.

**File status note**: these are *unit tests of the resolver itself*. They construct a graph, pass a DSL string, assert on the resolver's parse/structure output. Most assertions don't read fixture data — they check that `resolve_analysis_subjects` correctly identifies subjects, edges, scope rules, etc.

**Drift coupling for this file is generally LOW** — the tests don't depend on fixture data values. They depend on the resolver's date math being internally consistent. The one case using `(date.today() - timedelta(days=7))` (line 491) compares resolver output against test-side `date.today()` — both compute against real time, so it's stable by construction.

**Tests using relative DSL** (sample — most follow same pattern):

- `test_window_dsl_resolves_path_subjects` (line 353), `test_daily_conversions_resolves_path_subjects` (line 369), `test_visited_any_resolves_branches_for_funnel_dsl` (line 427), `test_bayes_fit_with_no_subject_returns_all_edges` (line 449), `test_visited_in_path_resolves_correctly` (line 602), `test_lag_fit_with_subject_resolves_to_target_edge` (line 639), `test_visited_any_with_two_targets` (line 652), and similar throughout. Most use `window(-30d:)` or `window(-90d:)`. **INTENT**: structural resolver tests. **DRIFT**: none. **PLAN**: pin scope as a hygiene measure (the resolved date math doesn't matter, but the input string then matches what real users would write). Optional — these tests are stable as-is.
- Line 485: `'window(1-Oct-25:31-Oct-25).asat(-7d)'` — uses absolute scope plus *relative* asat. The asat resolves to today-7d. The matching assertion at line 491 reads `(date.today() - timedelta(days=7))`. **INTENT**: asat resolution math. **DRIFT**: none (test and production agree by construction). **PLAN**: leave as-is. This is a deliberate runtime-anchored test of date arithmetic.

---

### test_doc56_phase0_behaviours.py — 17 occurrences

**File added**: 20-Apr-26. Last touched: 28-Apr-26.

**Tests using relative DSL**:

- Parametrised matrix at lines 354-360: `window(-60d:)`, `window(-120d:)`, `window(-180d:)`, `cohort(-180d:)` across CF fixtures. **INTENT**: doc 56 phase-0 CF correctness invariants. **VACUITY**: -60d partial, -120d/-180d substantial-to-full. **PLAN**: pin scope.
- Lines 478, 563, 570, 589, 596, 652, 655, 667, 673, 714, 717: various `window(-90d:)` and `cohort(-90d:)` uses. **PLAN**: pin scope per-test after intent check.

---

### test_evidence_adapters.py — 14 occurrences

**File added**: 29-Apr-26 (today). **Drift-immunity status**: maximally fresh — relative forms resolve to whatever the author intended today.

**Tests using relative DSL**: all uses are in `slice_key="window(-90d:)"` or `sliceDSL="window(-90d:)"` — these are **slice key strings used as opaque labels** in test fixtures, not actually parsed as date forms by the test logic. The tests construct synthetic snapshot rows and assert on adapter output.

**Drift coupling: NONE.** The slice keys are opaque strings, not date-evaluated.

**PLAN**: leave as-is. No hardening needed. Optional cosmetic change: use canonical absolute strings to match the rest of the codebase, but no functional reason.

---

### test_analysis_request_contract.py — 13 occurrences

**File added**: 8-Apr-26.

**Tests using relative DSL**: tests of analysis request shape — `effective_query_dsl: 'window(-30d:)'`, `temporal_dsl = 'window(-30d:)'`, plus regex tests of "subject must not contain temporal" / "temporal must not contain subject" classifiers (lines 184-208).

**Drift coupling: NONE for the regex classifier tests** (they check string patterns). **Indirect for the request-shape tests** — they call `handle_runner_analyze` against a tiny in-memory graph with no fixture data. Assertions are `reach_a > 0`, `reach_b > 0`, `analysis_type == X`. These don't depend on fixture dates at all.

**VACUITY**: tests don't use synth fixtures; they use a tiny in-memory graph defined in `_make_graph()`. Wallclock is irrelevant to the assertions.

**PLAN**: leave as-is. These tests are wallclock-immune by construction.

---

### test_cf_query_scoped_degradation.py — 11 occurrences

**File added**: 22-Apr-26. Last touched: 28-Apr-26.

**Tests using relative DSL**: graceful-degradation tests. `effective_query_dsl='window(-7d:)'`, `'cohort(-7d:)'`, `'window(-30d:)'`, `'cohort(-30d:)'`. **INTENT**: BE returns valid response (success or graceful failure) under narrow query scope.

**VACUITY**: fully vacuous (-7d, -30d both outside fixture). But these tests are *testing the no-data path deliberately* — degradation behaviour matters most when there's no data.

**Special**: line 949 has `'effective_query_dsl': 'window(-30d:).asat(5-Apr-26)'` — already has explicit asat. Authored 22-28 Apr; asat 5-Apr is in the past relative to authoring. **INTENT**: tests asat-prior-to-now scenario. **PLAN**: leave as-is.

**PLAN for the rest**: replace relative forms with absolute equivalents that explicitly produce empty windows (e.g. `window(1-Jan-30:2-Jan-30)`) and document the intent of testing degradation. Or pin to current relative-resolution if the test is willing to run against partial fixture for `-30d:` cases.

---

### test_conditioned_forecast_response_contract.py — 8 occurrences

**File added**: 18-Apr-26. Last touched: 29-Apr-26.

**Tests using relative DSL**:

- Line 418: `query_dsl = "window(-90d:)"` — schema contract test (response shape). **DRIFT**: none for schema. **PLAN**: pin scope (cosmetic).
- Line 539: `query_dsl = "cohort(-14d:)"` — narrow cohort response structure. **VACUITY**: fully vacuous. **PLAN**: replace with absolute narrow window inside fixture if intent is "narrow with data", or absolute clearly-empty window if intent is "narrow without data".
- Line 643: `query_dsl = "cohort(-90d:)"` — single-hop cohort matches v3 horizon. **PLAN**: pin scope.
- Lines 805, 810, 834, 839: `cohort(synth-lat4-c,-90d:)` and `cohort(synth-lat4-b,-90d:)`. **PLAN**: pin scope.

---

### _daemon_parity_check.py — 7 occurrences

**File added**: 27-Apr-26.

**File status note**: this is a *parity check script*, not a pytest module. Used standalone to verify daemon and subprocess paths produce identical output. Same DSL flows through both paths so drift is irrelevant to parity.

**PLAN**: low priority. Pin scope for consistency with rest of suite if desired, but no urgent risk.

---

### test_v3_degeneracy_invariants.py — 6 occurrences

**File added**: 23-Apr-26. Last touched: 27-Apr-26.

**Tests using relative DSL**: all are `window(-1d:)` or `cohort(-1d:)`. **VACUITY**: fully vacuous.

- `test_i1_zero_evidence_window_not_flat` (line 182) — wants zero evidence (vacuous **by design**). **PLAN**: replace `-1d:` with explicit out-of-fixture absolute window for clarity.
- `test_i2_zero_evidence_cohort_lags_window` (lines 206-207) — same intent. **PLAN**: same.
- `test_i3_cohort_a_equals_x_collapses_to_window` (line 266) — identity collapse. **VACUITY**: fully vacuous, but assertion holds in posterior-only regime. **PLAN**: this is the same shape as `test_single_hop_latent_upstream_lags_window_but_converges_to_same_subject_p` in cohort_factorised — needs the design decision.
- `test_i4_mature_window_midpoint_matches_posterior_p_mean` (line 304) — uses **absolute `window(1-Mar-26:22-Mar-26).asat(22-Mar-26)`**. Already drift-immune. Reference pattern.
- `test_i5_cohort_never_materially_above_window` (line 323) — `window(-1d:)`/`cohort(-1d:)`. Same shape as test_i3. **PLAN**: same design decision.

---

### test_doc31_parity.py — 5 occurrences

**File added**: 8-Apr-26. Last touched: 22-Apr-26.

**Tests using relative DSL**: all `cohort(-90d:)` / `window(-90d:)` for cohort_maturity / single-edge tests. **DRIFT**: indirect (parity old-vs-new path). **VACUITY**: partial. **PLAN**: pin scope.

---

### test_cf_truth_parity.py — 5 occurrences

**File added**: 27-Apr-26.

Already covered in earlier hardening attempt. Fixture matrix at lines 71-76. **PLAN**: pin scope per fixture; preserve existing absolute `cohort(7-Mar-26:21-Mar-26)` for synth-mirror-4step.

---

### test_cohort_maturity_model_parity.py — 4 occurrences

**File added**: 27-Apr-26.

Parametrised at lines 53-56: `window(-90d:)` and `cohort(-90d:)` on synth-mirror-4step single-hop and multi-hop. **INTENT**: main chart midline matches promoted overlay. **DRIFT**: tau-wise parity within tolerance — **max_tau drift coupling**. **PLAN**: pin scope; if assertion uses tau_max, re-author to assert at specific tau anchors.

---

### test_temporal_regime_separation.py — 2 occurrences

**File added**: 17-Apr-26.

Lines 182-183: `window(-90d:)` and `cohort(-90d:)`. **INTENT**: evidence_x differs between window and cohort modes at early tau. **DRIFT**: eval_age. **VACUITY**: partial. **PLAN**: pin scope. Assertion is at a specific tau (5), so tau-anchored — drift-stable post-pin.

---

### test_conversion_rate_blind.py — 2 occurrences

**File added**: 27-Apr-26.

Lines 39-40: module-level DSL constants. **INTENT**: doc 49 conversion_rate contract (T1-T8 invariants). **DRIFT**: T7 (`test_t7_multiple_bins_over_90d`) is bin-count-coupled to sweep extent. Others are schema-stable. **PLAN**: pin scope. Re-author T7 to assert on bins ≥ N where N is determined by fixture coverage post-pin, not on a hardcoded "≥5" assumption tied to wallclock.

---

### test_conditioned_forecast_parity.py — 2 occurrences

**File added**: 27-Apr-26.

Lines 51, 54: graph-keyed DSL map and default. **INTENT**: CF returns non-null p_mean on edges. **DRIFT**: forecast_horizon. **VACUITY**: partial. **PLAN**: pin scope.

---

### test_funnel_contract.py — 1 occurrence

**File added**: 20-Apr-26.

Line 62: `cohort(-90d:)` as default in dataclass. Tests use mocked CF. **DRIFT**: none (mocked). **PLAN**: leave as-is or pin cosmetically.

---

### test_conversion_funnel_v2.py — 1 occurrence

**File added**: 20-Apr-26.

Line 91: `cohort(-30d:)` default in dataclass. Tests use mocked CF. **VACUITY**: fully vacuous of fixture, but mock data supplies the e-mode bars assertion. **DRIFT**: none. **PLAN**: leave as-is.

---

### test_snapshot_read_integrity.py — 1 occurrence

**File added**: 2-Feb-26 (oldest file with relative DSL).

Line 262: `slice_key='context(channel:google).cohort(-100d:)'` — slice_key as opaque string. **DRIFT**: none. **PLAN**: leave as-is.

---

### test_cohort_maturity_derivation.py — 1 occurrence

**File added**: 8-Feb-26. **Last touched**: 28-Apr-26.

Line 281: `slice_key="cohort(-120d:)"` — opaque string. **DRIFT**: none. **PLAN**: leave as-is.

---

## Aggregate hardening plan

The hardening pass is per-test. Suggested execution order (lowest-risk to highest-risk):

### Phase 1: file-level no-ops (1-2 hours, low risk)
Files where relative DSL is opaque-string usage in fixtures, not date-evaluated. Add a brief comment noting the strings are opaque and leave them.

- `test_evidence_adapters.py` (14 occurrences, all opaque slice_key strings)
- `test_snapshot_read_integrity.py` (1)
- `test_cohort_maturity_derivation.py` (1)
- `test_funnel_contract.py` (1, mocked)
- `test_conversion_funnel_v2.py` (1, mocked)
- `test_analysis_request_contract.py` (13, in-memory graph + regex tests)

### Phase 2: structural resolver tests (1-2 hours, low risk)
Pin scope cosmetically; assertions don't depend on fixture data.

- `test_analysis_subject_resolution.py` (18)
- `_daemon_parity_check.py` (7)

### Phase 3: drift-coupled but recoverable (4-8 hours, medium risk)
Pin scope, run, verify result unchanged. Re-author specific drift-coupled assertions.

- `test_cf_truth_parity.py` (5)
- `test_doc31_parity.py` (5)
- `test_cohort_maturity_model_parity.py` (4) — re-author tau-max assertions
- `test_temporal_regime_separation.py` (2)
- `test_conversion_rate_blind.py` (2) — re-author T7 bin-count assertion
- `test_conditioned_forecast_parity.py` (2)
- `test_conditioned_forecast_response_contract.py` (8)
- `test_cf_query_scoped_degradation.py` (11) — convert vacuous-by-design `-7d`/`-30d` to explicit out-of-fixture absolutes
- `test_doc56_phase0_behaviours.py` (17)
- `test_v2_v3_parity.py` (27) — handle vacuous `-1d`/`-7d`/`-14d` cases as design decisions

### Phase 4: the heaviest file with the most ambiguity (8-16 hours, high risk)
Per-test design decisions for vacuous-by-`-1d:` tests; pin scope for the rest.

- `test_cohort_factorised_outside_in.py` (47) — **DONE for the `-90d:` / `-180d:` subset (29-Apr-26)**: 17 tests pinned, 0 regressions, 33+1xfail pass. Remaining: ~9 tests using `-1d:` await per-test design decisions.
- `test_v3_degeneracy_invariants.py` (6) — design decision on `-1d:` zero-evidence tests

### Phase 5: ratchet
After hardening, add a CI/lint check that disallows new relative-DSL forms in test files (or at minimum requires a comment justifying the relative form's use). Without this ratchet, the toil resumes.

## Open design decisions

Across the above, three design questions need a single answer applied consistently:

1. **For tests whose intent is "zero evidence" or "narrow / immature evidence"**: replace `-1d:` with what? An absolute clearly-out-of-fixture window like `window(1-Jan-30:2-Jan-30)` is unambiguous but ugly. An absolute narrow window inside fixture (e.g. `window(20-Mar-26:21-Mar-26)`) preserves the "narrow" property and gives 1-2 days of real evidence — but that's a different test from "zero evidence". Both intents exist in the codebase; the choice is per-test.

2. **For tests whose assertion compares two curves at "shared taus"**: do shared taus depend on sweep_to (max-τ drifts daily)? If yes, the assertion's domain changes daily. Re-author to specific named tau anchors (e.g. τ ∈ {0, 7, 14, 30, 60}).

3. **For parity tests** (v2 vs v3, old vs new): both paths see the same drift, so parity holds. Pin scope for explicitness, but parity itself is robust.

## Out of scope for this audit

- Posterior re-fit drift (param files). Tests assume current `bayes-vars.json` content. If posteriors are re-run, tests may shift — but this is fixture-mutation, not wallclock drift.
- Tests using `datetime.now()` / `date.today()` directly in test bodies for non-DSL purposes (e.g. `TEST_TIMESTAMP = datetime.now(timezone.utc)` at module load). These captured a snapshot at import time and don't drift over a single test session, but vary across sessions. Not addressed here.
- Synth fixture regeneration cadence. The audit assumes current synth state. If `bayes/synth_gen.py` `base_date` or `n_days` change, fixture overlap math changes and this audit is stale.
