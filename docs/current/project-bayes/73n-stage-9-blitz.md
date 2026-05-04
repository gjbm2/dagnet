# 73n Stage 9 — Blitz Punch List

**Date opened**: 2-May-26
**Plan**: [`73n-carrier-evidence-conditioning-implementation-plan.md`](73n-carrier-evidence-conditioning-implementation-plan.md)
**Anti-pattern this is fixing**: [AP59](../codebase/KNOWN_ANTI_PATTERNS.md) — stages 5a–8 closed "architecturally" with the new path default-OFF; nothing was actually proven.

## Rule

**Build → flip → test → diagnose → delete.** In that order. Do not delete legacy code before the flag-ON path is proven against tests, because deleting the legacy path destroys the only mechanism left to isolate primitive bugs (flip a flag OFF and see if the bug goes away).

The feature flags are a regrettable inheritance — we wouldn't have built them — but now they exist, they are the diagnostic instrument until tests are green.

## Phase 1 — Build the missing pieces

These are the four numerical components every prior stage punted. Land all of them before flipping any flag.

1. **Maturity-aware likelihood migration.** Port [`forecast_state._cohort_binomial_log_likelihood`](../../graph-editor/lib/runner/forecast_state.py) plus the per-cohort IS reweighting (bisection on tempering λ to ESS ≥ 20, then resample) into `runner.primitive_conditioning.condition_primitive`. Replace the plain Beta-Binomial conjugate update on summed `n_weighted_total` / `k_weighted_total`. Per-row τ derives from `(retrieved_at − observed_date).days`; per-row completeness from `timing_posterior.cdf_mean[τ]`.

2. **Per-upstream-edge evidence fetching.** Stage 6 carrier readout currently builds PRIOR_ONLY upstream primitives. Wire it: thread a per-edge EvidenceSet map through `compute_cohort_maturity_rows_v3`, populated by the caller (`handle_conditioned_forecast`) from the per-edge results that already exist in scope plus the existing `_fetch_upstream_observations` data path at `api_handlers.py:692`. Stage 6 already supports a populated `evidence_set` slot — the wire is a kwarg + dict construction, not a refactor.

3. **Defect 1 — `int(remaining)` truncation.** Find and fix the Pop D arithmetic bug surfaced by `test_v3_midline_at_saturation_converges_to_p`. The error message names the suspect.

4. **Fixed-seed RNG retirement.** Migrate the seven sites recorded in `test_primitive_seed_retirement.py` to `make_rng(key, derivation)`:
   - `forecast_state.build_node_arrival_cache` (seed=42 → `node_arrival_cache`)
   - five `forecast_runtime.prepare_forecast_runtime_inputs` sites (seed=42 → `subject_span_full_path_mc`, `subject_span_epistemic_overlay`, `anchor_relative_edge_p_mc`, `anchor_relative_edge_epistemic`, `last_edge_frontier_cdf`)
   - `cohort_forecast_v3._resolve_frame_carrier_state` (seed=43 → `legacy_upstream_carrier_v3` if retained, else delete in Phase 4)

## Phase 2 — Flip flags ON in code defaults

Change the four flag defaults in code from OFF to ON:

- `DAGNET_SINGLE_HOP_WINDOW_READOUT`
- `DAGNET_MULTI_HOP_SUBJECT_READOUT`
- `DAGNET_MULTI_HOP_WINDOW_READOUT`
- `DAGNET_ACTIVE_COHORT_CARRIER_READOUT`

Keep the env-var override mechanism intact — flags must remain togglable for the diagnose phase. Do not flip to ON-only-in-code (i.e. delete the off branch) yet.

## Phase 3 — Run tests

Run the full primitive substrate + outside_in suites under the new defaults (flags ON). Record:

- which tests pass
- which strict-xfails XPASS (and therefore need their markers removed)
- which tests still fail and the failure mode for each

Do not touch any markers yet. Do not delete any code yet.

## Phase 4 — Diagnose

For every test that still fails, use the env-var flag toggle to isolate:

- if a test passes flag-OFF and fails flag-ON → bug is in the new path; fix the new path
- if a test fails both → not a flag-routing issue; trace as a normal defect
- if a test passes both → noise; record and move on

This is the phase the flags exist to support. **Do not delete the legacy code while this phase is running** — every deletion shrinks the diagnostic surface.

## Phase 5 — Delete legacy

Once tests are green flag-ON, the legacy path is dead and must be removed:

- `build_cohort_evidence_from_frames` AP58 fork (the `is_window`-gated population fallback at `cohort_forecast_v3.py:750-769` and the carrier-projection rebuild at `:775-803`)
- `forecast_runtime.build_upstream_carrier` and its tier ladder (Tier 2 empirical, Tier 3 weak-prior, weak-prior carrier timing)
- `cohort_forecast_v3._resolve_frame_carrier_state` if no longer reachable
- `forecast_state.compute_forecast_trajectory` ownership of conditioning — reduce to numerical helper called only from primitive construction, or delete entirely if no callers remain
- `_legacy_trajectory_draw_family_key` synthesis fallback (Stage 5a follow-up #4)
- the off branches of the four feature flags themselves (now redundant)

After deletion: dead-code audit. Confirm no aggregate-IS, window-evidence-admission, or trajectory-local conditioning site remains a live owner. Plan §399, §727, §845 — these are mandatory closure criteria, not optional.

## Phase 6 — Markers and acceptance

- Remove the 12 strict-xfail markers (4 in `test_cohort_factorised_outside_in.py`, 7 in `test_primitive_seed_retirement.py`, 1 RED `test_v3_midline_at_saturation_converges_to_p`).
- Remove WP8/v2 skips that are no longer applicable (audit each — some are out of 73n scope and stay).
- Walk the plan §"Stage 9 — Acceptance Tests" 43-bullet list against existing test files. Fill genuine gaps. Do not invent acceptance criteria the plan didn't name.
- Mark Stage 9 complete in the plan progress block.

## Stop conditions (real ones, not bureaucratic)

Stop and surface to the user if:

- Phase 1 likelihood migration produces a flag-ON result that diverges from legacy by more than the Stage 0c band (≈ ±0.002 on displayed rate). That means there's a second numerical defect we don't yet understand.
- Per-edge evidence fetching turns out to require new snapshot-DB infrastructure beyond Stage 2's prefix-arrival map.
- Phase 4 isolates a test failure that is genuinely correct under the new semantics (i.e. the legacy answer was wrong, the new answer is right). Surface and confirm before deleting any code.

Otherwise: keep going. No stage notes, no follow-up sections, no "architecturally complete" anything.

## Discipline notes (carried forward, do not violate)

- No `git commit` runs until the user authorises. Atoms land, suggested commit messages are reported, the user commits.
- No `git push`, no PR open, no remote work.
- No new tests written before the code path they exercise lands. No new tests skipped or weakened.
- No backwards-compat shims, deprecated aliases, or "just in case" code at Phase 5.
- If tempted to write "architecture discharged, semantics deferred" anywhere — re-read AP59.
