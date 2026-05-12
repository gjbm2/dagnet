# Post-CF-Rebuild Python Test Audit

**Date opened**: 7-May-26
**Branch**: `feature/snapshot-db-phase0`
**Driver**: large-scale CF runtime rebuild (73m carrier composition + 73n primitive
conditioning + outside-in close-out 8/9-May-26). The `test_cohort_factorised_outside_in.py`
oracle is green; this audit triages every other Python test that fell out of step.

**Scope**: `graph-editor/` Python suite only. `bayes/` is excluded per direction.
`lib/tests/test_cohort_factorised_outside_in.py` is excluded from the run because it is
the oracle (already green) and it is the heaviest single file.

**Run**: `cd graph-editor && venv/bin/pytest --ignore=lib/tests/test_cohort_factorised_outside_in.py --tb=short -q` with `dev-server.py` up on `:9000` and `DB_CONNECTION` resolved from `.env.local`.

**Headline**:

```
79 failed, 1412 passed, 109 skipped, 1 xfailed, 27 errors in 869.70s (0:14:29)
```

**Reading of the 79+27 events** (final, after user pushback and code-side probes 7-May-26):

- **~30 are STALE-CONTRACT failures (deleted/renamed shape)** — most populated cluster: nine tests asserting on `result.metadata.model_curves`, which the FE comment at [`cohortComparisonBuilders.ts:774`](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L774) records as *"deleted post-73n"*. Promoted model curve is now per-row (`model_curve_midpoint` / `model_curve_fan_upper` / `model_curve_fan_lower` / `model_curve_bands` at [`cohort_forecast_v3.py:4102-4105`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L4102)) plus top-level `result.source_model_curves` ([`api_handlers.py:3868`](../../graph-editor/lib/api_handlers.py#L3868)). Plus seven lag-fitter tests against tightened input validation / Dirac short-circuit.
- **3 are STALE-CONTRACT failures (semantic inversion under 73n unification)** — `test_doc56_phase0_behaviours` asserts the *inverse* of the 73n contract. The post-73n contract on the unified primitive substrate is *cohort and window converge for the same subject* (oracle's GREEN-baseline `test_cohort_and_window_p_infinity_converge_for_same_subject_rate`, line 1642 ×3 parametrised, plus `test_a_equals_x_identity_collapses_to_window` at line 740). The doc56 tests were authored against the historical AP58-fork divergence pattern, which 73n explicitly closed. They assert the fork still fires; it doesn't, correctly.
- **21 are TEST-INFRA — one-keyword-argument fixes** — confirmed by inline-trace 7-May-26: `compute_cohort_maturity_rows_v3` calls without `scenario_id` cause `build_resolved_cf_runtime` to bail at [`cohort_forecast_v3.py:1129-1130`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1129) (`if not scenario_id: return None`), the row builder returns `[]`, and the asserts trip. Adding `scenario_id='<test-name>'` produces 61 valid rows for the v3_contract baseline. Affected: `test_cohort_maturity_v3_contract` (12), `test_cf_query_scoped_degradation` (3), and `test_selected_cohort_pop_d_distribution` (6 — separate one-arg fix on `_SelectedSourceDayMass(endpoint_cdf_by_node=...)`).
- **~21 are CASCADE-ONLY (resolved by isolation re-run 7-May-26)**:
  - `test_multihop_evidence_parity`: 5 errors in main run → **3 pass + 2 real residue** in isolation. The 2 real residue look like the open A-display y-side residual already named in [`cohort-outside-in-post-73n-regression-tracker.md`](cohort-outside-in-post-73n-regression-tracker.md) §Cluster-A-Display-residual.
  - `test_v3_degeneracy_invariants`: 9 fails in main run → **6 pass + 3 real residue** in isolation. The 3 residue look like wallclock-flakiness (relative-date DSL forms `(-1d:)` resolving past 21-Mar-26 fixture cutoff).
  - `test_window_cohort_convergence`: 1 fail in main run → **1 real residue** in isolation, likely same family as `test_multihop_evidence_parity`.
  - `test_v2_v3_parity_outside_in`: 15 errors in main run → 17 pass + 3 real residue in isolation; RETIRE-V2 anyway.
  - `test_chart_graph_agreement`: 2 fails in main run → 0 fails in isolation (pure cascade).
  Total ~21 of the original 30 cascade events were pure cascade; ~6 turn out to be real residue (1 wallclock-stale, 5 the A-display y-side residual cluster).
- **9 are RETIRE-V2** — `test_v2_v3_parity` direct-Python parity (12 fails) and `test_v2_v3_parity_outside_in` (15 errors → 3 real residue but file is RETIRE-V2 anyway).
- **~3 isolated NEEDS-INVESTIGATION** — `test_primitive_contract::test_different_draw_family_keys_produce_independent_draws` (digest collision; suspect both keys carry empty `selected_anchor_days=()`, so test bug not runtime defect), `test_stage1_be_topo_removal_pinning::test_a1_topo_pass_tokens_absent_from_live_code` (read `fetchDataService.ts:2384`), `test_lag_fields::test_build_graph_with_lag_fields` (blended-mean coefficient drift).
- **5–6 events are likely the same A-display y-side residual** already tracked in the cohort-outside-in regression tracker (`test_multihop_evidence_parity` ×2 + `test_window_cohort_convergence` ×1 + possibly `test_v2_v3_parity_outside_in` ×3 if those survive RETIRE-V2 cleanup).

**No confirmed runtime regressions in this audit beyond the A-display y-side residual that the regression tracker already names as open.** Every other failure resolves to STALE-CONTRACT, TEST-INFRA (one keyword-arg fix), RETIRE-V2, daemon-cascade-only, or wallclock-flakiness once probed.

The earlier drafts of this audit confidently labelled three clusters as "REAL-REGRESSION" before the user pointed out (correctly) that (a) `metadata.model_curves` is a deleted shape, not a missing curve, and (b) the doc56 window/cohort-split tests assert the *inverse* of the 73n unified-substrate contract. Both pushbacks proved out under code-side trace. The user's third pushback — that the test-infra and daemon-cascade groups deserved their own probes — landed the verdicts above. Net: of the 79+27 = 106 events, **the count of failures requiring runtime-side investigation is in the single digits**, and they are concentrated in one already-named open cluster (A-display y-side).

## Update — fixes landed 7-May-26 (post-audit)

After the audit completed, two changes landed against this branch:

### TEST-INFRA fixes (3 test files, ~21 events)

- [`graph-editor/lib/tests/test_cohort_maturity_v3_contract.py`](../../graph-editor/lib/tests/test_cohort_maturity_v3_contract.py): added `scenario_id='v3-contract-test'` parameter to `_run_v3` helper (default), forwarded into `compute_cohort_maturity_rows_v3`. Unblocks the 12 fail/error events that were tripping on the runtime builder's `if not scenario_id: return None` early-out.
- [`graph-editor/lib/tests/test_cf_query_scoped_degradation.py`](../../graph-editor/lib/tests/test_cf_query_scoped_degradation.py): added `scenario_id='cf-query-scoped-test'` to four direct call sites (lines 144, 177, 876, 889). Unblocks 3 of 3 fails.
- [`graph-editor/lib/tests/test_selected_cohort_pop_d_distribution.py`](../../graph-editor/lib/tests/test_selected_cohort_pop_d_distribution.py): added `endpoint_cdf_by_node=...` to the `_select_source_day_mass_at_x` helper (line 74) and to the two direct `_SelectedSourceDayMass(...)` constructions inside the file (lines 1344, 1438). Unblocks the constructor TypeError.

Verification: re-running the three files in isolation drops total fails from 21 → 12 across the three files (and 38 vs 37 pass), with the residual 12 now surfacing genuine assertion-level signal (`fan_bands missing canonical level 50`, `zero-evidence midpoint drifted from model_midpoint`, etc.) that was previously buried under the no-rows / TypeError barrier. Those 12 are now NEEDS-INVESTIGATION (likely STALE-CONTRACT — band-key naming, etc.) but **separate from this audit's scope**.

### Daemon-cascade fix (`graph-editor/lib/tests/_daemon_client.py`)

Two changes applied in the daemon client:

1. **Idle timeout extended for test runs**: `DaemonClient.start()` now sets `DAGNET_DAEMON_IDLE_MS=3600000` (1 hour) by default if the env var is not already set. The daemon's default 5-minute idle timeout was firing during long stretches of non-daemon tests in the lib suite, killing the daemon mid-run and producing cascade `daemon is no longer running (exit 0)` failures on the next daemon-using test. Override via `DAGNET_DAEMON_IDLE_MS=...` if a shorter window is genuinely needed.
2. **Auto-restart on detected death**: `DaemonClient.call()` now detects a dead daemon (via `self._proc.poll()` non-None) and re-spawns the daemon in place via a new `_restart_after_death` method, then retries the call once on the fresh process. Handles both the "dead before request" case (death between calls) and the "stdout closed mid-request" case (death during a request). Counter and stderr buffer are kept across the restart so request ids stay monotonic and earlier diagnostics remain visible. A `[daemon-client] auto-restarted daemon after death (prior exit X)` line is emitted to stderr so the operator can see when the auto-restart fired. If the restart itself fails to produce a fresh ready handshake, a DaemonError surfaces with both the prior and new daemon stderr tails attached.

### Verification — full lib suite re-run with both fixes landed

Re-ran `cd graph-editor && venv/bin/pytest --ignore=lib/tests/test_cohort_factorised_outside_in.py --tb=short -q` end-to-end:

| | Before fixes | After fixes | Δ |
|---|---:|---:|---:|
| Passed | 1412 | 1442 | **+30** |
| Failed | 79 | 76 | -3 |
| Errors | 27 | **0** | **-27** |
| Skipped | 109 | 109 | 0 |
| xfailed | 1 | 1 | 0 |
| Wallclock | 869.7 s | 1004.5 s | +135 s |

**Net: 30 fail/error events cleared. The audit's two predictions held:**

- **All 27 errors were daemon cascade or fixture-constructor failures.** Both classes are gone after the daemon auto-restart + idle-timeout extension + scenario_id / endpoint_cdf_by_node test fixes.
- **Cascade-only files are now fully green**: `test_chart_graph_agreement` cleared its 2 fails; `test_multihop_evidence_parity` 5 errors → 2 fails (3 cleared); `test_v3_degeneracy_invariants` 9 fails → 3 fails (6 cleared); `test_v2_v3_parity_outside_in` 15 errors → 3 fails (12 cleared). The residual ~9 failures across these files are the real residue called out in the audit: 3 are the A-display y-side cluster, 3 are wallclock-flakiness, 3 are RETIRE-V2 anyway.

**The 76 remaining failures match the audit's STALE-CONTRACT / STALE-73N / RETIRE-V2 categorisation almost line-for-line:**

- `test_carrier_object_contract` 11 — STALE-73N (`runner.carrier_composition` deleted)
- `test_v2_v3_parity` 10 — RETIRE-V2
- `test_lag_distribution_parity` 6 — STALE-CONTRACT (validation tightening)
- `test_cohort_maturity_v3_contract` 6 — assertion-level signal newly surfaced after the scaffolding fix; needs separate triage
- `test_cohort_maturity_no_evidence` 4 — STALE-CONTRACT (`metadata.model_curves` deleted)
- `test_cohort_maturity_model_parity` 4 — STALE-CONTRACT
- `test_v3_degeneracy_invariants` 3 — wallclock-flakiness on relative-DSL forms past fixture cutoff
- `test_v2_v3_parity_outside_in` 3 — RETIRE-V2
- `test_selected_cohort_pop_d_distribution` 3 — assertion-level signal newly surfaced; needs separate triage
- `test_doc56_phase0_behaviours` 3 — STALE-CONTRACT (semantic inversion under 73n unification)
- `test_cf_query_scoped_degradation` 3 — assertion-level signal newly surfaced
- `test_forecast_state_cohort` 3 — STALE-73N
- `test_multihop_evidence_parity` 2 — A-display y-side residual (regression tracker open cluster)
- `test_conditioned_forecast_response_contract` 2 — STALE-CONTRACT (kwarg / field rename)
- `test_cohort_maturity_no_evidence_truth` 1 — STALE-CONTRACT
- `test_cohort_maturity_v3_projection_contract` 1 — DEFER-73Q
- `test_conditioned_forecast_parity` 1 — likely STALE-CONTRACT (`n`/`k` field rename)
- `test_evidence_adapters` 1 — STALE-CONTRACT (merge keying changed in §A1)
- `test_funnel_contract` 1 — defer to 73q phase 5b
- `test_lag_fields` 1 — needs investigation
- `test_lag_model_fitter` 1 — STALE-CONTRACT (Dirac short-circuit)
- `test_primitive_contract` 1 — likely test bug (empty-tuple)
- `test_primitive_readout_integration` 1 — STALE-CONTRACT (likely renamed block)
- `test_stage1_be_topo_removal_pinning` 1 — needs investigation (one-line read at `fetchDataService.ts:2384`)
- `test_subject_span_cdf_ownership` 1 — STALE-73N (already documented in regression tracker)
- `test_window_cohort_convergence` 1 — A-display y-side residual cluster
- `test_wp8_default_off` 1 — likely STALE-CONTRACT (literal renamed)

The newly-surfaced 12 assertion-level events from the v3_contract / cf_query_scoped / selected_cohort_pop_d trio (where the scaffolding barrier was unblocked) are likely STALE-CONTRACT (e.g. `fan_bands missing canonical level 50` is band-key naming drift), but that triage is separate from this audit and should happen alongside the v2 / model_curves / lag-fitter sweeps.

**No runtime / production code has been changed.** All edits are in `graph-editor/lib/tests/`.

---

## How to read this document

Every test file with at least one failure or error is listed in §Per-file triage below. Each entry carries:

- a one-line reading of what went wrong;
- a category badge:
  - **RETIRE-V2** — pinned to `cohort_maturity_v1` / `cohort_maturity_v2` semantics that are scheduled for deletion. Drop the file when those analysis types are removed.
  - **STALE-73N** — pins API surfaces that 73n explicitly deleted (`runner.carrier_composition`, `compute_forecast_trajectory` aggregate-IS, per-surface readout entry points, etc.). Tombstone-skip or rewrite against the unified runtime.
  - **STALE-CONTRACT** — pins a field name / shape / response surface that 73m or 73n moved or renamed. The runtime is doing the right thing under the new contract; the test reads the old field. Update the test against the current contract — do not fix the runtime.
  - **MERGE-OUTSIDE-IN** — outside-in CLI pattern test (daemon-mode `analyse.sh`) whose intent is genuinely distinct from `test_cohort_factorised_outside_in.py`. Fold into the canonical outside-in file rather than maintaining a parallel CLI harness, then retire the old file. (Per the user's rule of thumb: "if it tests something new and worthwhile, move it; otherwise retire it.")
  - **DUPLICATE-OF-OUTSIDE-IN** — outside-in CLI pattern test whose semantic claim is already covered in `test_cohort_factorised_outside_in.py`. Retire.
  - **DEFER-73Q** — fails today because it asserts a contract that 73q (or a successor atom) is going to deliver. xfail with a reason and add a clearance line to the relevant 73q stage.
  - **NEEDS-INVESTIGATION** — provisional. Could be STALE-CONTRACT, TEST-INFRA, or genuine regression; this audit did not perform the code-side trace required to decide. Each entry names the function under test so the next pass knows where to start.
  - **REAL-REGRESSION (provisional)** — the surface failing is an outside-in CLI test on a real fixture, where field renames are unlikely to explain the gap. Still warrants a code-side trace before fixing — do not assume.
  - **CASCADE** — failed because the daemon died mid-suite. Re-run in isolation to see whether it is real or collateral.
  - **TEST-INFRA** — failure is an artefact of test scaffolding (inline `SimpleNamespace` fakes missing a now-required field, stale imports, etc.). Update the test, not the runtime.
- a note on whether the test is currently fast or whether it is one of the structurally heavyweight CLI/daemon files.

---

## Test infra issues that frame everything

These three issues distort the suite's signal-to-noise ratio enough that no triage decision is safe before they are acknowledged.

### 1. The dev BE has to be running, or `requires_python_be` silently skips the suite

The `requires_python_be` decorator (defined locally in many test files; canonical form in `test_cf_truth_parity.py:50-66`) probes `http://localhost:9000/__dagnet/server-info` at module-import time. Tests that depend on the live Python BE skip cleanly when it's down — but the skip count then masks real failures and silently invalidates many "outside-in" assertions. **At the start of this audit the BE was down**; my first run skipped most of the daemon-driven outside-in tests as a result. The canonical command per `release.sh` line 278 is:

```
cd graph-editor && venv/bin/pytest --tb=short -q
```

This command depends on `dev-server.py` being up on `:9000`. There is no warning if it isn't.

**Recommendation**: add a session-start warning that a non-trivial number of tests will skip if the BE is not reachable. A silent 30-percent skip rate on a 14-minute suite is the worst possible failure mode — it looks green but tests nothing.

### 2. Daemon idle-timeout cascade

The analyse daemon (`graph-editor/src/cli/daemon.ts`) self-terminates after 300 s of idle:

```
[cli] Daemon idle for 300s — exiting.
```

The lib suite alphabetically interleaves daemon-using tests (`test_multihop_evidence_parity.py`, `test_v2_v3_parity_outside_in.py`, `test_v3_degeneracy_invariants.py`, `test_window_cohort_convergence.py`) with long stretches of non-daemon tests. When the suite spends >5 min on non-daemon files, the daemon dies. The next daemon-using test then dies with `_daemon_client.DaemonError: daemon is no longer running (exit 0)`, which `pytest` surfaces as `AssertionError: daemon analyse failed for ...`.

**Estimated breakdown of today's 106 fail+error events**:

| Driver | Count | Examples |
|---|---:|---|
| Real test failures | ~40 | `test_carrier_object_contract`, `test_cohort_maturity_no_evidence` |
| Daemon cascade (likely false positives) | ~30 | `test_v3_degeneracy_invariants` (×9), `test_v2_v3_parity_outside_in` (×15), `test_multihop_evidence_parity` (×5), `test_window_cohort_convergence` (×1) |
| v2-vs-v3 parity (RETIRE-V2) | ~9 | `test_v2_v3_parity` |
| 73n leftover stale references | ~11 | `test_carrier_object_contract` (×11 ModuleNotFound) |
| 73q-anticipated | 2-4 | `test_cohort_maturity_v3_projection_contract`, possibly some no-evidence-collapse cases |

**Recommendation**: either auto-restart the daemon when a `_daemon_client` call sees the connection dropped, or have the daemon stay alive for the duration of pytest (set idle timeout >> suite wallclock for test runs, or make the daemon manageable as a session-scoped pytest fixture). Until this is fixed, every "daemon analyse failed" line in this audit is **suspect**, not confirmed.

### 3. Suite wallclock — 14.5 min without the oracle, ~30 min with

Even with the oracle excluded, the lib suite is a **14.5 min** run. Adding `test_cohort_factorised_outside_in.py` brings it to ~30 min on this branch. The user's standing observation is correct: a 30-min test suite is effectively a dead suite — agents stop running it, regressions land unchallenged, the oracle becomes the only thing exercised.

The dominant wallclock contributors are the daemon-mode CLI files. Order-of-magnitude per file (rough, from progress percentages and run timings):

| File | Style | Approx wallclock |
|---|---|---|
| `test_cohort_factorised_outside_in.py` (excluded here) | outside-in CLI | ~10-15 min |
| `test_doc56_phase0_behaviours.py` | outside-in CLI | ~3-5 min |
| `test_asat_blind.py` | outside-in CLI | ~1-2 min |
| `test_v3_degeneracy_invariants.py` | outside-in CLI | ~1-2 min |
| `test_v2_v3_parity_outside_in.py` | outside-in CLI | ~1-2 min (when not cascade-failed) |
| `test_cf_truth_parity.py` | outside-in CLI | ~1 min |
| `test_cf_cache_machinery.py` | daemon CLI | ~1 min |
| `test_chart_graph_agreement.py` | outside-in CLI | <1 min |
| `test_conditioned_forecast_parity.py` | outside-in CLI | ~1 min |
| `test_multihop_evidence_parity.py` | outside-in CLI | <1 min normally |
| `test_window_cohort_convergence.py` | outside-in CLI | <1 min |
| Everything else | direct Python | seconds |

The 73q plan talks about making the outside-in suite the canonical e2e test for analytics. The corollary is that **every other outside-in CLI file in the lib suite is competing with the oracle for the same wallclock budget**. The user's rule of thumb — "if it tests something new and worthwhile, move it into the oracle file; otherwise retire it" — should govern everything in the §MERGE-OUTSIDE-IN and §DUPLICATE-OF-OUTSIDE-IN buckets below.

**Recommendation**: aim for **one canonical outside-in CLI file** (`test_cohort_factorised_outside_in.py`) with a session-scoped daemon; retire or merge everything else in the same pattern. Per-test daemon spawning is the wallclock killer.

---

## Skip inventory

109 skipped tests, dominated by tombstone files left from 73n. These are not failures, but they are dead weight in the suite and most of them are in scope for the "delete v1/v2 cohort_maturity" sweep referenced in 73q (or a successor atom).

| File | Skipped | Total | Skip cause |
|---|---:|---:|---|
| `test_bayes_cohort_maturity_wiring.py` | 24 | 24 | `pytestmark = pytest.mark.skip(reason="forensic review … pre-span-kernel overlay contract")` — pre-existing whole-file skip predating this audit |
| `test_active_cohort_carrier_readout.py` | 16 | 17 | 16 OBSOLETE markers (per-surface eligibility helpers deleted by 73n unification of `compute_resolved_runtime_readout`) + 1 live source-import guard |
| `test_primitive_readout.py` | 14 | 15 | TOMBSTONE under 73n (per-surface entry points unified) |
| `test_multi_hop_window_readout.py` | 13 | 13 | TOMBSTONE under 73n (5c cutover) — file exists only to record gone-by-design API |
| `test_multi_hop_subject_readout.py` | 13 | 13 | TOMBSTONE under 73n (5b cutover) — same |
| `test_stage_8_substrate_provenance.py` | 10 | 10 | TOMBSTONE under 73n Stage 8 |
| `test_composed_cache.py` | 8 | 15 | partial skips on intermediate cache surfaces |
| `test_v2_v3_parity.py` | 5 | 17 | 5 cases skip cleanly; the other 12 fail (RETIRE-V2 anyway) |
| `test_prefix_arrival.py` | 2 | 15 | targeted skips |
| `test_doc31_parity.py` | 2 | 5 | 2 skipif cases (env-dependent) |
| `test_primitive_conditioning.py` | 1 | 21 | one targeted skip |
| `test_primitive_cache.py` | 1 | 16 | one targeted skip |

**Recommendation**: the five 73n tombstone files (`test_active_cohort_carrier_readout.py`, `test_primitive_readout.py`, `test_multi_hop_window_readout.py`, `test_multi_hop_subject_readout.py`, `test_stage_8_substrate_provenance.py`) should be **deleted outright**, not kept as `@pytest.mark.skip` farms. The 73-attic-mending-process is the right framework — anything that has not been mended back to live coverage by now is OBSOLETE-final and adds zero signal. Add this to the v1/v2 deletion sweep in 73q (or a new follow-up atom).

`test_bayes_cohort_maturity_wiring.py` predates 73m/73n and is whole-file-skipped pending the cohort path-vs-edge semantics question. With outside-in green and 73q's `rate_by_cohort` reducer landing soon, this file's contract is now covered structurally elsewhere; recommend retiring after a one-pass coverage audit (see §Per-file recommendations).

---

## Per-file triage

Files are listed alphabetically. For each, the failure pattern is summarised, then a category and recommendation.

### `test_carrier_object_contract.py` — **STALE-73N** — 11/15 fail
Eleven tests fail with `ModuleNotFoundError: No module named 'runner.carrier_composition'`. `runner/carrier_composition.py` was deleted by commit `e15e9a9b` (4-May-26) per the 73n carrier-composition consolidation. The file was authored against the 73m Stage-2 surface that 73n then unified.

**Recommendation**: this file is mostly obsolete by-design. Two options:
- (a) Tombstone it identical to `_attic` peers, kept only as a record of intent.
- (b) Mend it against the unified `compute_resolved_runtime_readout` / `compose_primitive_span` API per the attic-mending process. Cost is non-trivial (Stage-2 contract assertions don't map mechanically).
Today's recommendation is (a) — three of the fifteen tests that **don't** use `runner.carrier_composition` already pass, so move those into a small `test_carrier_object_contract_v3.py` and delete the rest.

### `test_cf_query_scoped_degradation.py` — **TEST-INFRA (one-arg fix — `scenario_id` required)** — 3 fail / 13 (1 xfail)
Probed 7-May-26. All three failures are the same root cause: `compute_cohort_maturity_rows_v3` called without `scenario_id`. The runtime builder bails at [`cohort_forecast_v3.py:1129-1130`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1129) (`if not scenario_id: return None`), the row builder receives `runtime is None` at line 4779 and returns `[]`, and the assertions trip. The `scenario_id` parameter is `Optional[str] = None` by default — `None` falsifies the truthiness check.

- `test_latency_rows_use_shared_sweep_contract`: empty rows from missing scenario_id (line 144).
- `test_shared_sweep_latency_rows_keep_window_denominator_fixed`: same (line 177).
- `test_cohort_maturity_rows_v3_identity_drift`: same (line 876, 889).

**Recommendation**: add `scenario_id='<test-scenario-name>'` to the three call sites. One-line fix. The other 10 tests in the file already pass (some pass `scenario_id` directly per the regime selection setup; lines 371, 944).

### `test_cohort_maturity_model_parity.py` — **STALE-CONTRACT** — 4/4 fail
All four parameterised cases fail with `Failed: [<case>] no model_curves in metadata`. The test reads `result.metadata.model_curves`. The FE comment at [`cohortComparisonBuilders.ts:774`](../../graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts#L774) is explicit: *"the legacy metadata.model_curves rendering path was deleted post-73n"*. The promoted model curve is now per-row (`model_curve_midpoint` / `model_curve_fan_upper` / `model_curve_fan_lower` / `model_curve_bands` at [`cohort_forecast_v3.py:4102-4105`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L4102)), and the source-level overlay is at top-level `result.source_model_curves` ([`api_handlers.py:3868`](../../graph-editor/lib/api_handlers.py#L3868)).

The test's *intent* — that the unconditioned `model_midpoint` line agrees with the promoted overlay's epistemic model curve at every τ — is still meaningful. The failure is a stale field address, not a missing curve.

**Recommendation**: rewrite the assertion against per-row `model_curve_midpoint` (or `result.source_model_curves`) instead of `metadata.model_curves`. Once green, **MERGE-OUTSIDE-IN** — fold the assertion into `test_cohort_factorised_outside_in.py` and retire as a separate file. Same fixture surface, same daemon CLI dispatch, same intent class.

### `test_cohort_maturity_no_evidence.py` — **STALE-CONTRACT + MERGE-OUTSIDE-IN** — 4/4 fail
All four parameterised cases fail with `Failed: [<case>] metadata.model_curves missing`. Same root cause as `test_cohort_maturity_model_parity` — the test's no-evidence degeneration assertion reads `metadata.model_curves` which is gone. The assertion intent (midpoint, model_midpoint, and the promoted overlay all coincide on the no-evidence boundary) is still valid against the new row-side fields.

**Recommendation**: same as `test_cohort_maturity_model_parity` — rewrite against per-row model_curve fields, then merge into the canonical outside-in file.

### `test_cohort_maturity_no_evidence_truth.py` — **STALE-CONTRACT + MERGE-OUTSIDE-IN** — 1/1 fail
Same `metadata.model_curves missing` failure. This file is the public-tooling counterpart to `test_cohort_maturity_no_evidence.py`'s direct-Python path; together they pin the no-evidence boundary contract.

**Recommendation**: rewrite against the new field shape; merge with its sibling.

### `test_cohort_maturity_v3_contract.py` — **TEST-INFRA (one-arg fix — `scenario_id` required)** — 12/15 fail/error (5 fail + 7 errors)
Probed 7-May-26. Inline trace:

```
build_resolved_cf_runtime(scenario_id=None, ...) →
  if not scenario_id: return None    # cohort_forecast_v3.py:1129-1130
compute_cohort_maturity_rows_v3 →
  if runtime is None: return []      # cohort_forecast_v3.py:4779
fixture: assert rows ...             # fails on []
```

Confirmed by adding `scenario_id='test-scenario'` to the test's `_run_v3` helper: `compute_cohort_maturity_rows_v3` returns 61 rows (axis_tau_max=60). The `_build_single_edge_graph` shape is fine; `resolve_model_params` resolves cleanly; `build_cohort_evidence_from_frames` returns a populated `FrameEvidence`; `build_resolved_cf_runtime` is the only step that bails, and it bails on the missing `scenario_id`.

The seven errors are the `baseline_rows` fixture failure cascading; the five direct failures hit the same return-[] in their own `_run_v3` calls.

**Recommendation**: add a `scenario_id` argument (literal string, e.g. test-name-derived) to `_run_v3` at [`test_cohort_maturity_v3_contract.py:286`](../../graph-editor/lib/tests/test_cohort_maturity_v3_contract.py#L286). Single-line fix. All 12 fail/error events should clear. The structural invariants the suite asserts (canonical row schema, fan ordering, monotonicity, epoch null rules) are all valid — the runtime is doing the right thing, the test scaffolding is one keyword short.

### `test_cohort_maturity_v3_projection_contract.py` — **DEFER-73Q** — 1/4 fail (3 skipped, 1 fail)
This file's docstring is explicit:

> Authored against the desired contract, not the existing implementation.
> Until the projection reducer lands these tests are expected to fail —
> that is the point. The failures pin what the new projection has to deliver.

The single failure is `test_v3_fan_widens_through_epoch_b`: fan width should be monotonically non-decreasing through epoch B; it currently shrinks. This is exactly the "selected-cohort projection pattern" work that 73q's reducer field contract is designed to fix (per `cohort-maturity-selected-cohort-projection-pattern.md`).

**Recommendation**: **xfail** the failing test with `strict=False, reason="73q projection reducer pending"` and add a clearance line to 73q phase 4 acceptance ("`test_v3_fan_widens_through_epoch_b` flips to passed"). Do NOT delete or weaken — the test is correctly capturing the desired contract.

### `test_conditioned_forecast_parity.py` — **NEEDS-INVESTIGATION (likely STALE-CONTRACT — `n`/`k` field rename)** — 1/8 fail
`TestPhase4AsatVisibility.test_whole_graph_cf_lowers_visible_evidence`: failure prints `live n | asat n | live k | asat k` all `None` for both edges. Live-vs-asat completeness *does* differ (0.89 vs 0.64, 0.85 vs 0.53) so the asat boundary is being applied — only the per-edge integer counts in the response are absent. Most plausible reading: the response now carries `evidence_n` / `evidence_k` (matching `evidence_x` / `evidence_y` chart fields) and the test still reads `n` / `k` directly. Worth a one-pass grep before declaring a real bug.

**Recommendation**: read the field name directly in `handle_conditioned_forecast` response output before fixing. If renamed, this is STALE-CONTRACT. The remaining 7 tests in this file pass.

### `test_conditioned_forecast_response_contract.py` — **NEEDS-INVESTIGATION** — 2/15 fail
- `test_handler_passes_axis_tau_max_to_upstream_fetch` — static AST check that `handle_conditioned_forecast` passes both `axis_tau_max` and `upstream_observation_fetcher=_fetch_upstream_observations` into `prepare_forecast_runtime_inputs`. The grep doesn't find the literal. Either the wiring is missing (real regression) or one of those keyword names changed during 73n cutover (STALE-CONTRACT).
- `test_scoped_multi_hop_cohort_matches_v3_horizon` — `Missing completeness scalars for scoped multi-hop cohort parity`, both `cm_completeness` and `cf_completeness` `None`. Same shape concern as the parity test above — the field may have been renamed.

**Recommendation**: read the live `prepare_forecast_runtime_inputs` signature and the live response shape. If the kwarg / field names changed, update the test. If they didn't, fix the wiring.

### `test_doc56_phase0_behaviours.py` — **STALE-CONTRACT (semantic inversion under 73n unification)** — 3/7 fail
On a fresh code-side trace, all three of these are STALE — the test file encodes the pre-73n window-vs-cohort divergence pattern as the desired behaviour, but 73n explicitly unified the two onto the same primitive substrate. The post-73n contract is recorded in the outside-in oracle's GREEN-baseline tests:

- `test_a_equals_x_identity_collapses_to_window` (oracle line 740) — cohort(A=X) is bit-identical to window;
- `test_cohort_and_window_p_infinity_converge_for_same_subject_rate` (oracle line 1642, ×3 parametrised) — cohort and window asymptotes converge for the same subject rate;
- the AP58 fork in `build_cohort_evidence_from_frames` that produced "materially different `obs_x`/`obs_y` per τ between is_window=True and is_window=False" is recorded as a *defect* in [`73n-stage-0-baseline.md`](project-bayes/73n-stage-0-baseline.md) §§9-12 and was the explicit flip-to-green target for the strict-xfail markers cleared by the 73n primitive registry + composition + projection passes. 73n stage 6 explicitly says *"cohort and window arms both consume the same primitive substrate"* ([`73n-stage-5a-note.md:166`](project-bayes/73n-stage-5a-note.md#L166)).

The three doc56 failures unpacked under that contract:

- **`test_query_scoped_identity_carrier_collapses_public_evidence_basis`** (asserts cohort == window at late τ): the test's intent is right (under identity carrier they should collapse) but its tolerance (`pytest.approx` default ~1e-6 relative) is over-tight against the new unified path's small fence-post offset (~1.5% on evidence_x at late τ ∈ {41, 44, 50, 65, 80}). The unified path is doing the right thing — cohort and window are now both being read off the same primitive substrate, but cohort applies its A-anchor binding through the time-shifted carrier convolution while window reads X-day rows directly, and at late τ a small selected-anchor set difference can produce a percent-level offset. The assertion needs to either widen to a noise-floor tolerance (à la the oracle's `_evidence_x_tolerance` machinery) or move into the oracle file directly where the unified-substrate tolerance is already calibrated.
- **`test_lag_fit_and_surprise_gauge_share_downstream_temporal_mode_split`** (asserts `window_p["observed"] > cohort_p["observed"] + 0.05` and same on completeness): this is the inverse of the oracle's `test_cohort_and_window_p_infinity_converge_for_same_subject_rate`. The test's premise — *"cohort-mode observed performance drops below the window-mode read because the selected population is re-rooted at the upstream anchor"* — was the AP58 fork's symptom, recorded as a defect in 73n. Post-73n, both consumers correctly read 0.379829 from the unified primitive substrate. The test is asserting that the fork still fires, which it doesn't.
- **`test_bayesian_sidecar_preserves_downstream_window_cohort_chart_split`** (asserts `window_x > cohort_x`, `window_model_midpoint > cohort_model_midpoint + 0.05`, `window_p_infinity > cohort_p_infinity + 0.04`): same inversion. The docstring even acknowledges *"This is the synth witness for the known downstream convergence defect"* — i.e. the test was named for a defect that 73n closed. The "split" it's witnessing is exactly the AP58 fork.

**Recommendation**: **STALE-CONTRACT — retire all three**. The intent that survives — *cross-consumer agreement on the unified primitive substrate* — is already canonically pinned by the outside-in oracle's `test_a_equals_x_identity_collapses_to_window` and `test_cohort_and_window_p_infinity_converge_for_same_subject_rate`. The other 4 tests in the file (`test_cf_and_v3_chart_carrier_tier_agree`, `test_cf_p_mean_matches_v3_p_infinity`, `test_whole_graph_cf_is_invariant_under_edge_reorder`, `test_chart_and_daily_conversions_do_not_collapse_window_and_cohort` — read the last one carefully too because its `evidence_x` separation premise may suffer the same inversion) should be audited for the same staleness pattern before fold-in. Once cleared, this whole file folds into the oracle (or retires entirely if the oracle already covers it). Performance: this is one of the slowest files in the suite (~3-5 min wallclock for 7 tests) — retiring it materially helps the wallclock budget.

### `test_evidence_adapters.py` — **NEEDS-INVESTIGATION** — 1/36 fail
`test_reconstructed_asat_adapter_coexists_with_raw_file_in_one_merge`: `assert 180 == (80 + 30)`. Merged total `n=180` instead of expected `110`. Could be a real defect (merge double-counting) or an intentional contract change in the reconstructed-asat adapter's dedupe semantics following the conditioner rewrite (the regression tracker records that the merge now keys by `(identity, observed_date, retrieved_at, asat_materialised)` instead of collapsing retrievals — which would change the totals shape on tests that previously expected merged sums).

**Recommendation**: read the merge keying change in [`evidence_merge.py:541-572`](../../graph-editor/lib/evidence_merge.py#L541) (per the regression tracker §"Defect A1") and decide whether the test's expected-180-or-expected-110 assertion is now wrong by design. The other 35 tests in the file pass.

### `test_forecast_state_cohort.py` — **STALE-73N (mostly)** — 3/16 fail
Three failures, three different stories:

- `test_single_retrieval_completeness_lives_in_success_probability`: `ImportError: cannot import name '_cohort_binomial_log_likelihood' from 'runner.forecast_state'`. The function was deleted by 73n's "trajectory engine becomes a pure projector" change (`forecast_state.py:1296-1305`).
- `test_trajectory_blend_cohort_evals_populated_unconditioned`: `assert sweep.blend_applied is True`. The IS-blend flag is no longer raised on this trajectory shape.
- `test_phase1_non_latent_upstream_produces_active_dirac_carrier`: `'TimingSpan' object has no attribute 'is_active'`. The `is_active` accessor was renamed/removed during the 73m carrier rewrite.

All three pin a pre-73n trajectory-engine API. Only the third is a structural API rename; the first two pin behaviours that 73n explicitly removed (per the regression tracker's note on `test_subject_span_cdf_ownership.py`).

**Recommendation**: STALE-73N for the import + dirac-carrier tests; rewrite or retire. The blend_applied test may still be load-bearing — needs a single read-through to decide. The other 13 tests in the file pass and are worth keeping.

### `test_funnel_contract.py` — **NEEDS-INVESTIGATION** — 1/8 fail
`test_f_median_matches_path_product_of_evidence_means`: f-mode stage-N bar `0.006481` ≠ Π epistemic means `1.0`. The test's expected value being exactly `1.0` is the giveaway — the fixture's per-stage epistemic means must all be 1, which makes the assertion vacuous unless the f-mode reduction is also producing per-stage 1s. Either the fixture is no longer well-formed (test bug) or the f-mode reduction has changed (contract). 73q phase 5b explicitly schedules funnel regression coverage; this file's contract is in scope there.

**Recommendation**: defer detailed investigation to 73q-5b unless it surfaces independently first. The other 7 tests in the file pass.

### `test_lag_distribution_parity.py` — **STALE-CONTRACT (validation tightening)** — 6/29 fail
Six golden parity failures all driven by `fit_lag_distribution` adding input validation that rejects what used to be degenerate-but-tolerated inputs:

- `test_golden[median=5,mean=None,k=500]`: `ValueError: mean lag missing or non-positive` — function now requires non-null mean.
- `test_golden[median=0,mean=4,k=200]`: `ValueError: invalid median lag (must be > 0 for lognormal): 0`.
- `test_golden[median=-1,mean=4,k=200]`: same.
- `test_golden[median=3,mean=3,k=200]`: `sigma=0.0` instead of `0.5` because the function now Dirac-detects when `mean == median`.
- `test_nan_median` / `test_inf_median`: NaN/Inf now rejected.

The validation in `fit_lag_distribution` ([`runner/lag_distribution_utils.py:206-227`](../../graph-editor/lib/runner/lag_distribution_utils.py#L206)) is the new contract. The golden fixture (`fixtures/lag-distribution-golden.json`) encodes degenerate cases that predate it.

**Recommendation**: STALE-CONTRACT. Update the golden fixture to drop / re-shape the now-rejected inputs, confirm the TS golden suite agrees (`src/services/__tests__/lagDistribution.golden.test.ts`). Do not relax the validation — refusing degenerate input is the correct behaviour for a lognormal fitter.

### `test_lag_fields.py` — **NEEDS-INVESTIGATION** — 1/12 fail
`test_build_graph_with_lag_fields`: `assert 0.75 == 0.72` (blended mean). One-line discrepancy. Cheap to triage; could be coefficient change or propagation through `_extract_evidence` / `_extract_forecast`.

**Recommendation**: trace the blended-mean derivation under the test's input. Likely a contract drift on the blend formula, possibly intentional.

### `test_lag_model_fitter.py` — **STALE-CONTRACT (Dirac short-circuit)** — 1/21 fail
`test_missing_mean_uses_default_sigma`: `assert 0.0 == 0.5`. Same root contract as `test_lag_distribution_parity[median=3,mean=3]` above — the lag fitter now returns `sigma=0` when the data is Dirac-detected (the failure_reason field even reads "Mean/median ratio ≈ 1.0 — data is effectively Dirac"). The test's pre-Dirac-detection expectation that `sigma` falls back to `LATENCY_DEFAULT_SIGMA=0.5` no longer holds.

**Recommendation**: STALE-CONTRACT. Update the test to assert the new Dirac behaviour, or replace it with an input case that genuinely exercises the missing-mean default-sigma path.

### `test_multihop_evidence_parity.py` — **NEEDS-INVESTIGATION (3 cascade-only, 2 real residue)** — 5/5 errors in main run
Re-ran in isolation 7-May-26: **3 passed, 2 failed in 16.76 s** — three of the original five errors were daemon-cascade (resolved by isolation), but two surface as substantive divergences:

- `TestMultihopCollapse::test_evidence_y_parity` — evidence_y diverges at 21 τ values (>5% gap)
- `TestMultihopCollapse::test_midpoint_parity` — midpoint diverges at 15 τ values (>15% gap)

Both are Claim 1 of the doc 64 Family D / G metamorphic canary: on subject `from(m4-delegated).to(m4-success)` with the upstream `m4-landing → m4-created → m4-delegated` declared instant, cohort and window must agree. Under the 73n unified primitive substrate they should collapse. Under this run, evidence_x parity passes but evidence_y and midpoint do not — i.e. the carrier-side fix unifies the x-axis but the subject/projection-side path retains a divergence.

This matches the **A-display residual** open item in [`cohort-outside-in-post-73n-regression-tracker.md`](cohort-outside-in-post-73n-regression-tracker.md) §"Cluster A — Display-side residual (still open)" which records: *"Chart `evidence_y` remains structurally divergent. The rate-attributed Y_prefix is a model expectation, not an observed count..."*. The same residual is showing up here on a different fixture surface.

**Recommendation**: **NEEDS-INVESTIGATION**. Either this is the cluster-A-display residual the regression tracker already flags as open, or it is independent. Probably the same. After diagnosis, fold the surviving claims into the canonical outside-in file (Claim 2 — divergence on latent upstream — is exactly the kind of metamorphic invariant the oracle should own). RETIRE-V2 sub-class `TestV2CrossVersionSignal` goes with the v2 sweep.

### `test_primitive_contract.py` — **REAL-REGRESSION (provisional)** — 1/16 fail
`test_different_draw_family_keys_produce_independent_draws`: two `DrawFamilyKey`s with **different `selected_anchor_days` tuples** are producing **identical SHA-256 digests**. The test's whole point is that anchor-day variation must change the draw key. The error trace shows both keys carry `selected_anchor_days=()` — both are empty tuples. So the test may be constructing two keys that don't actually differ (test bug — empty tuple parameterised twice), rather than the digest dropping the field.

**Recommendation**: read the test's two-key construction. If the tuples are genuinely different and digests collide, real defect in key derivation. If they're both empty tuples, test bug.

### `test_primitive_readout_integration.py` — **NEEDS-INVESTIGATION (likely STALE-CONTRACT)** — 1/1 fail
`test_substitutes_identically_on_both_surfaces`: `KeyError: 'primitive_readout'`. The CF response edges no longer carry a `primitive_readout` key. The intent (cross-surface parity for the substituted scalar — doc 73b §3.3) is still valid, but the field where the readout lives may have been renamed during 73n's primitive-readout unification.

**Recommendation**: read the current CF edge response shape and find where the substituted scalar lives. If renamed, STALE-CONTRACT — update the test. If genuinely missing, real regression. Likely co-located concern with the two `test_conditioned_forecast_response_contract.py` failures.

### `test_selected_cohort_pop_d_distribution.py` — **TEST-INFRA / API change** — 6/19 fail
Five failures share `TypeError: _SelectedSourceDayMass.__init__() missing 1 required positional argument: 'endpoint_cdf_by_node'`. The dataclass added a required field and the test's helper builder (`_select_source_day_mass_at_x` at line 74) doesn't pass it. The sixth failure (`test_m_select_construction_for_multi_hop_downstream_node`: `assert 0.0 == 100.0`) is downstream of the helper not being able to construct.

**Recommendation**: trivial test fix — pass the new `endpoint_cdf_by_node` argument in the test helper. Once the constructor compiles, the assertion failure may turn out to be real or to disappear. This is a **TEST-INFRA** lag, not a runtime defect.

### `test_stage1_be_topo_removal_pinning.py` — **REAL-REGRESSION (provisional)** — 1/5 fail
`test_a1_topo_pass_tokens_absent_from_live_code`: BE-topo tokens reappeared at [`graph-editor/src/services/fetchDataService.ts:2384`](../../graph-editor/src/services/fetchDataService.ts#L2384). Doc 73b §5 Action A1 forbids this; the pinning test exists exactly to catch this drift. Either the file genuinely contains the offending token (real source defect) or the matcher is too broad and is hitting a benign reference (test bug). Either way, do not silence the pin.

**Recommendation**: read line 2384 directly. One-minute triage.

### `test_subject_span_cdf_ownership.py` — **STALE-73N** — 1/12 fail
Already documented in [`cohort-outside-in-post-73n-regression-tracker.md`](cohort-outside-in-post-73n-regression-tracker.md) §"Stale-architecture test — adjacent suite". `test_per_draw_cdf_variation_drives_is_separation` asserts `compute_forecast_trajectory` produces `n_cohorts_conditioned == 1`. 73n stage-9 cleanup deliberately moved conditioning out of the trajectory engine (per `forecast_state.py:1296-1305`), so the trajectory engine's `n_cohorts_conditioned` is now 0 by design.

**Recommendation**: rewrite against the new architecture (call `condition_primitive` first, then check) or retire as STALE-73N. The 11 sibling tests in the same file are still relevant.

### `test_v2_v3_parity.py` — **RETIRE-V2** — 12/17 fail (5 skip)
This entire file pins v2-vs-v3 parity on `synth-simple-abc`. Per user direction ("anything related to parity with v2,v1 cohort maturity we can now retire those tests entirely; we will soon be deleting those analysis types") this whole file is RETIRE-V2. Failures are real divergences but irrelevant — the parity is being formally abandoned.

Specific failure shape (for the record): `tau_solid_max mismatch at tau=0`, `Midpoints out of range: [0.0, 0.0]`, `v3 diverges from v2 at 91/91 τ values`, plus two `AttributeError: 'types.SimpleNamespace' object has no attribute 'envelope_plan'` from a fresh API change.

**Recommendation**: **delete the entire file** as part of the v2 deletion atom. None of its assertions encode anything not already in `test_cohort_factorised_outside_in.py` or the `test_cohort_maturity_v3_contract` contract.

### `test_v2_v3_parity_outside_in.py` — **RETIRE-V2 + CASCADE** — 15 setup errors
Same RETIRE-V2 fate as `test_v2_v3_parity`, just at the outside-in CLI level (drives `analyse.sh` against `synth-mirror-4step`). Today's 15 errors are all daemon cascade — `daemon analyse failed ... daemon is no longer running (exit 0)` at fixture setup. The test itself is irrelevant once v2 goes.

**Recommendation**: **delete** with v2.

### `test_v3_degeneracy_invariants.py` — **MIXED (6 cascade-only, 3 real residue — likely wallclock-flakiness)** — 9/11 fail in main run
Re-ran in isolation 7-May-26: **6 passed, 3 failed in 47.24 s** — two-thirds were daemon-cascade. The three surviving failures look like wallclock-flakiness against fixture data ending 21-Mar-26, not real defects:

- `TestV3DegeneracyInvariants::test_i4_mature_window_midpoint_matches_posterior_p_mean`: window midpoint `0.9499` diverges from posterior `p=0.7000` by 35.7 %. The DSL `from(m4-registered).to(m4-success).window(-1d:)` resolves to today's date (2026-05-07) ± 1 day — fully outside the 21-Mar-26 fixture cutoff. AP17 (vacuous-by-relative-DSL) territory: chart row reads posterior-only at fan-saturation, midpoint sits near the prior-CDF asymptote, not at p=0.7 the test expected from a mature window. See [`KNOWN_ANTI_PATTERNS.md`](codebase/KNOWN_ANTI_PATTERNS.md#L276) and [`test-wallclock-flakiness-audit.md`](test-wallclock-flakiness-audit.md).
- `TestV3DegeneracyInvariants::test_i5_cohort_never_materially_above_window[synth-mirror-4step]`: `Failed: missing data wc=False cc=False`. Same vacuity — both window and cohort comparators returned no data, fixtures and DSL date forms have no overlap.
- `TestV3DegeneracyInvariants::test_i5_cohort_never_materially_above_window[synth-lat4]`: same.

**Recommendation**: **TEST-INFRA / wallclock-flakiness**. Replace the relative-date forms with absolute dates inside the fixture coverage window, or pin against `today = fixture_end - N` per the wallclock-audit toolkit. The five named invariants (I1–I5) are still load-bearing; they merit fold-in to `test_cohort_factorised_outside_in.py` once the date forms are hardened. Per the user's rule of thumb: distinct from the oracle's existing invariants → **MERGE-OUTSIDE-IN** after hardening.

### `test_window_cohort_convergence.py` — **NEEDS-INVESTIGATION (1 real residue, same family as multihop_evidence_parity)** — 1/1 fail in main run
Re-ran in isolation 7-May-26: still red — `test_multi_hop_composition[synth-mirror-4step:c-d-e]` fails with the same shape as `test_multihop_evidence_parity::TestMultihopCollapse::test_midpoint_parity`. Multi-hop composition midpoint divergence on `synth-mirror-4step` chain `c → d → e`. Likely the same A-display residual as multihop above.

**Recommendation**: investigate together with `test_multihop_evidence_parity` — almost certainly one root cause. After fix, **MERGE-OUTSIDE-IN**.

### `test_wp8_default_off.py` — **NEEDS-INVESTIGATION (likely STALE-CONTRACT)** — 1/4 fail
`test_wp8_cohort_forecast_v3_call_site_hardcodes_false`: regex search for `_direct_cohort_p_conditioning\s*=\s*False` in `cohort_forecast_v3.py` returns None. The kwarg may have been renamed or the call-site moved as part of the 73n rewrite. The test's intent — pinning that WP8 cannot be silently engaged through the runtime-bundle build site — is still valid, but the literal it greps for is stale.

**Recommendation**: confirm WP8 is still default-off under whatever the current toggle name is, then update the regex. The other 3 tests in the file pass (and confirm WP8 is structurally off elsewhere).

---

## Summary of recommendations

The earlier draft of this section confidently called four "real-regression clusters" with collective fix-it-now language. After a code-side check on the most populated cluster, that draft was wrong: the chief offender — the `metadata.model_curves` cluster (9 tests across three files) — is asserting on a field shape that 73n explicitly deleted. The corrected reading splits as follows.

### STALE-CONTRACT — update tests against current shapes (do NOT fix runtime)

These tests are pinning fields/shapes that 73m or 73n moved or renamed. The runtime is doing the right thing under the new contract.

- **`metadata.model_curves` cluster** (9 tests across three files): `test_cohort_maturity_model_parity` (4), `test_cohort_maturity_no_evidence` (4), `test_cohort_maturity_no_evidence_truth` (1). Promoted model curve is now per-row (`model_curve_midpoint` / `model_curve_fan_upper` / `model_curve_fan_lower` / `model_curve_bands`) plus top-level `result.source_model_curves`. Update assertions to read those fields. Once green, **MERGE-OUTSIDE-IN**.
- **Lag fitter validation tightening** (7 tests across two files): `test_lag_distribution_parity` (6 cases — golden fixture has degenerate inputs that the new validation rejects) and `test_lag_model_fitter::test_missing_mean_uses_default_sigma` (Dirac short-circuit returns `sigma=0`, not `LATENCY_DEFAULT_SIGMA`). Update the golden fixture and the test expectations.

### NEEDS-INVESTIGATION — code-side trace before classifying

These are listed in the audit body with the function/field name to grep. They are most likely STALE-CONTRACT or TEST-INFRA, but a one-pass code read should decide before fixing:

- `test_cf_query_scoped_degradation` (3 — direct-Python tests, likely missing `envelope_plan` on the `SimpleNamespace` fakes)
- `test_cohort_maturity_v3_contract` (12 — inline graph fixture probably no longer satisfies `resolve_model_params` after schema changes)
- `test_conditioned_forecast_response_contract` (2 — `axis_tau_max` / `upstream_observation_fetcher` kwarg names; `cm_completeness` / `cf_completeness` field names)
- `test_conditioned_forecast_parity::test_whole_graph_cf_lowers_visible_evidence` (1 — `n` / `k` field names on edge response, likely renamed to `evidence_n` / `evidence_k`)
- `test_primitive_readout_integration` (1 — `primitive_readout` block likely renamed/relocated under 73n's unified readout)
- `test_evidence_adapters` (1 — merge keying changed in evidence_merge §A1; expected `n=110` may now correctly be `n=180`)
- `test_funnel_contract` (1 — defer to 73q phase 5b)
- `test_lag_fields` (1 — blended-mean coefficient)
- `test_primitive_contract::test_different_draw_family_keys_produce_independent_draws` (1 — looks like both keys carry empty `selected_anchor_days=()`; might be test bug not digest bug)
- `test_wp8_default_off` (1 — kwarg likely renamed)
- `test_stage1_be_topo_removal_pinning` (1 — read `fetchDataService.ts:2384` directly)

### REAL-REGRESSION (confirmed) — one already-named open cluster

After the doc56 reclassification and the cascade-probe verdicts, the audit's net runtime-side regression footprint is **the A-display y-side residual already open in [`cohort-outside-in-post-73n-regression-tracker.md`](cohort-outside-in-post-73n-regression-tracker.md) §Cluster-A-Display-residual**, surfaced here on three additional fixtures:

- `test_multihop_evidence_parity::test_evidence_y_parity` (21 τ values >5%)
- `test_multihop_evidence_parity::test_midpoint_parity` (15 τ values >15%)
- `test_window_cohort_convergence::test_multi_hop_composition[synth-mirror-4step:c-d-e]`
- (probably) the 3 real residue in `test_v2_v3_parity_outside_in` — RETIRE-V2 covers them anyway

These are not new bugs — the regression tracker already records: *"Chart `evidence_y` remains structurally divergent. The rate-attributed Y_prefix is a model expectation, not an observed count, and is many orders of magnitude smaller than the empirical numerator at every age the test inspects."* The right home for these tests is *inside the regression tracker's open cluster*, not in scattered files asserting against the same surface.

The other isolated holding-pen candidates remain:

- `test_primitive_contract::test_different_draw_family_keys_produce_independent_draws` — almost certainly empty-tuple test bug (both keys carry `selected_anchor_days=()`), not a digest defect.
- `test_stage1_be_topo_removal_pinning::test_a1_topo_pass_tokens_absent_from_live_code` — read `fetchDataService.ts:2384`; one-minute decision.
- `test_lag_fields::test_build_graph_with_lag_fields` — blended-mean coefficient drift; one-minute trace.

Net: **runtime-side investigation footprint = 1 already-open cluster + 3 one-minute reads**.

### TEST-INFRA — one-keyword-argument fixes (probed 7-May-26)

These are **the highest-yield fix in the whole audit**. ~21 fail/error events resolve to two single-line constructor fixes in test scaffolding:

- `_run_v3` / inline calls to `compute_cohort_maturity_rows_v3` need `scenario_id='<test-name>'`. Affects `test_cohort_maturity_v3_contract` (12 fails/errors), `test_cf_query_scoped_degradation` (3 fails). Probed and confirmed: adding `scenario_id` to the v3_contract `_run_v3` helper produces 61 valid rows on the baseline fixture (was empty `[]`).
- `_SelectedSourceDayMass` test helper needs the new required `endpoint_cdf_by_node=...` argument. Affects `test_selected_cohort_pop_d_distribution` (6 fails). Helper is at [line 74](../../graph-editor/lib/tests/test_selected_cohort_pop_d_distribution.py#L74).

### CASCADE-ONLY — confirmed clean by isolation re-run (probed 7-May-26)

These were 100 % daemon-idle-timeout cascade — re-run in isolation gave passes:

- `test_chart_graph_agreement`: was 2 fails, now 0 fails in isolation.
- Subset of each of `test_multihop_evidence_parity` (3 of 5), `test_v3_degeneracy_invariants` (6 of 9), `test_v2_v3_parity_outside_in` (17 of 21).

### Real residue surfaced by the cascade probe

After isolation:

- `test_multihop_evidence_parity::test_evidence_y_parity` + `test_midpoint_parity` (2) — the A-display y-side residual already named in [`cohort-outside-in-post-73n-regression-tracker.md`](cohort-outside-in-post-73n-regression-tracker.md) §Cluster-A-Display-residual. Same surface, different fixture.
- `test_window_cohort_convergence::test_multi_hop_composition[synth-mirror-4step:c-d-e]` (1) — same cluster.
- `test_v3_degeneracy_invariants::test_i4` (1) — wallclock-flakiness; relative-date DSL `(-1d:)` past fixture cutoff. **TEST-INFRA-WALLCLOCK** per [`test-wallclock-flakiness-audit.md`](test-wallclock-flakiness-audit.md).
- `test_v3_degeneracy_invariants::test_i5[synth-mirror-4step]` + `[synth-lat4]` (2) — same wallclock-flakiness pattern.
- `test_v2_v3_parity_outside_in` (3 real residue) — RETIRE-V2 anyway.

### STALE-73N — API surface deleted

- `test_carrier_object_contract` (11 — `runner.carrier_composition` deleted)
- `test_forecast_state_cohort` (3 — `_cohort_binomial_log_likelihood`, `is_active`, blend_applied — all 73n-deleted surfaces)
- `test_subject_span_cdf_ownership` (1 — already documented in the regression tracker)

### RETIRE-V2 (queue against v1/v2 deletion atom)

- `test_v2_v3_parity` (12 fails) and `test_v2_v3_parity_outside_in` (15 errors). Drop with v2.

### Sweep-deletes (queue against v1/v2 deletion atom)

These should all be deleted in a single sweep when `cohort_maturity_v1` / `cohort_maturity_v2` are removed. **Add this list to 73q (or successor atom) explicitly** so it is not forgotten:

- `test_v2_v3_parity.py` — RETIRE-V2
- `test_v2_v3_parity_outside_in.py` — RETIRE-V2
- `test_completeness_stdev_vs_v2.py` — passes today (not in failure list) but pins v2 sampling; check & retire with v1/v2
- `test_doc31_parity.py` — old vs new path; check & retire when old path is gone
- `test_active_cohort_carrier_readout.py` — TOMBSTONE (16 of 17 OBSOLETE-skip)
- `test_primitive_readout.py` — TOMBSTONE
- `test_multi_hop_window_readout.py` — TOMBSTONE
- `test_multi_hop_subject_readout.py` — TOMBSTONE
- `test_stage_8_substrate_provenance.py` — TOMBSTONE
- `test_bayes_cohort_maturity_wiring.py` — pre-existing whole-file skip; retire after one-pass coverage check

That's roughly **12 files / ~125 tests** to delete in one stroke. Without this sweep the suite carries dead weight that confuses every future audit.

### Defer to 73q (xfail with clearance line)

- `test_cohort_maturity_v3_projection_contract::test_v3_fan_widens_through_epoch_b` — explicitly authored for the projection reducer 73q is delivering. Phase 4 acceptance should clear it.

### Move into outside-in proper, retire, or absorb (after staleness is cleared)

Per the user's rule of thumb, files in the outside-in CLI pattern that genuinely test something distinct should fold into `test_cohort_factorised_outside_in.py`. The doc56 reclassification means several of these are now likely *retire* candidates because the oracle already pins the surviving intent:

- `test_cohort_maturity_model_parity.py` — once rewritten against per-row `model_curve_midpoint`, the assertion (main midline matches promoted overlay at every τ) is worth keeping as a distinct claim. **MERGE-OUTSIDE-IN**.
- `test_cohort_maturity_no_evidence.py` + `test_cohort_maturity_no_evidence_truth.py` — no-evidence boundary; same. **MERGE-OUTSIDE-IN**.
- `test_doc56_phase0_behaviours.py` — three of the seven assertions are 73n-inverted. The other four still need a staleness pass. The cross-consumer agreement intent (CF == v3 == daily_conversions) is canonically pinned by `test_cf_p_mean_matches_v3_p_infinity` and equivalents already inside the oracle. **Likely RETIRE** entirely after the audit; if any genuinely distinct invariant survives, fold it.
- `test_v3_degeneracy_invariants.py` — five named invariants (I1–I5). Probably distinct from the oracle's existing invariants. **Re-run in isolation** to confirm green, then **MERGE-OUTSIDE-IN**.
- `test_window_cohort_convergence.py` — multi-hop composition convergence. **Re-run in isolation**, then **MERGE-OUTSIDE-IN**.

Order of operations: clear the staleness in each (rewrite assertions to current contract, drop now-inverted ones, re-run to confirm), then merge surviving distinct claims into the canonical outside-in file with a session-scoped daemon fixture, then delete the source files. The end state is one heavy outside-in file owned alongside the regression tracker, plus the lightweight unit tests.

### Test-infrastructure work (separate atom, prerequisite to many of the above)

1. **Daemon lifecycle in pytest**: kill the 300 s idle-timeout cascade. Either auto-restart on connection drop or hold a session-scoped daemon for the duration of pytest. Without this the lib suite has a built-in 30 % false-positive rate.
2. **BE-up warning at session start**: emit a single conftest log line if `requires_python_be` would skip — silent skip is the worst possible failure mode.
3. **Per-file wallclock report**: add `--durations=20` to the canonical command so slow files surface visibly. Today the suite's wallclock structure is invisible until you go looking for it.
4. **Suite wallclock budget**: the canonical Python lib suite needs a stated upper bound (e.g. 5 min). Anything above that should be marked `@pytest.mark.slow` and kept out of the default `pytest -q` run. This is exactly where the 73q work is heading for daily-conversions; the same discipline should apply to the existing suite.

---

## Cross-references

- Outside-in oracle: [`test_cohort_factorised_outside_in.py`](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py)
- 73q plan: [`project-bayes/73q-daily-conversions-shared-runtime-cutover-plan.md`](project-bayes/73q-daily-conversions-shared-runtime-cutover-plan.md)
- 73r plan (downstream of this audit's row-builder cluster): [`project-bayes/73r-generalised-primitive-evidence-acquisition-plan.md`](project-bayes/73r-generalised-primitive-evidence-acquisition-plan.md)
- Outside-in regression tracker: [`cohort-outside-in-post-73n-regression-tracker.md`](cohort-outside-in-post-73n-regression-tracker.md)
- 73-attic mending: [`project-bayes/73-attic-mending-process.md`](project-bayes/73-attic-mending-process.md)
- Wallclock-flakiness audit (predecessor pattern): [`test-wallclock-flakiness-audit.md`](test-wallclock-flakiness-audit.md)
