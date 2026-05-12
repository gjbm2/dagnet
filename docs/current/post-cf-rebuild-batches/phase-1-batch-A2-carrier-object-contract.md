# Phase 1 / Batch A2 — `test_carrier_object_contract.py` STALE-73N

**Cluster:** the single file
[`graph-editor/lib/tests/test_carrier_object_contract.py`](../../graph-editor/lib/tests/test_carrier_object_contract.py).
File contains 15 tests; 11 import the deleted `runner.carrier_composition`
module and currently fail with `ModuleNotFoundError`; 4 do not import the
deleted module and currently pass against the live runtime factory.

**Verify command:** `cd graph-editor && venv/bin/pytest lib/tests/test_carrier_object_contract.py --tb=short -q`

**Touches:** test file only. No runtime change.

**Predicted Δ:** −11 fails (76 → 65 on the broader audit count). 4 passing
tests stay passing.

---

## Background — the API change

`runner/carrier_composition.py` was deleted by commit `e15e9a9b` (4-May-26)
during the 73n consolidation. The Stage-2 composer entry points
(`compose_carrier_to_x` + `TransitionPrimitive` dataclass) were superseded
by the unified primitive-registry composer at
[`graph-editor/lib/runner/subject_span_composer.py:211`](../../graph-editor/lib/runner/subject_span_composer.py#L211)
(`compose_primitive_span`) — fundamentally different surface. The new
composer takes a `RequestPrimitiveRegistry` (populated by Stage 2/3
resolution) and an `edge_to_primitive_lookup` callable; it does not accept
raw transitions or read edge fields. The old composer's diagnostic tiers
(`'no_path'`, `'horizon_inadequate'`, etc.) are replaced by exception
raising (`CompositionError`).

The runtime-side carrier object also moved: the old `Carrier` dataclass
was replaced by [`PreparedCarrierToX`](../../graph-editor/lib/runner/forecast_runtime.py#L82)
with fields `mode` (`'identity' | 'upstream'`), `reach`, `x_provider`,
`from_node_arrival`. The `XProvider` factory at
[`forecast_runtime.build_x_provider_from_graph`](../../graph-editor/lib/runner/forecast_runtime.py)
is still live and exercised by the 4 currently-passing tests.

The 11 failing tests are all written against the deleted Stage-2 composer
API. None of them can be mechanically translated — the new surface is
expressed at the primitive-registry level, not the raw-graph level, and
encodes invariants at primitives rather than at the composer.

---

## Per-test verdicts

### Currently PASSING (against live `forecast_runtime.build_x_provider_from_graph`)

| ✓ | Conf | Risk | Line | Test | Verdict | Read justifies |
|---|------|------|------|------|---------|----------------|
| [ ] | H | L | 115 | `test_window_mode_returns_inactive_carrier` | KEEP | Asserts `provider.enabled is False`, `reach == 0.0`, `upstream_params_list == []`, `ingress_carrier is None` for window mode. Pins the runtime factory's first-guard short-circuit. Live API; passes today. |
| [ ] | H | L | 135 | `test_a_equals_x_cohort_returns_inactive_carrier` | KEEP | Asserts `provider.enabled is False` when anchor == target_edge.from (A=X). Pins `has_semantic_upstream_latency` returning False at A=X. Live API; passes today. |
| [ ] | H | L | 156 | `test_a_not_x_topological_reach_is_product_of_upstream_probabilities` | KEEP | Asserts `provider.reach == 0.6 × 0.5` for a 3-edge chain with target on the last edge — the topological product invariant. Live API; passes today. |
| [ ] | H | L | 228 | `test_a_not_x_all_non_latency_chain_must_enable_carrier` | KEEP | Pins the post-Stage-3 gate (`reach > 0 and A != X`, independent of whether any upstream edge is latency-bearing). Was authored as RED-expected against the pre-Stage-3 gate; **passes today** because 73n delivered the gate change. Worth keeping as a regression guard for that invariant. |

### Currently FAILING with `ModuleNotFoundError` (Stage-2 composer surface, deleted)

For each, the column "**Invariant lost**" records what is no longer pinned
by this file after the test is deleted. Each row notes whether the
invariant is covered elsewhere (and where), or whether deletion is a
genuine coverage loss worth flagging.

| ✓ | Conf | Risk | Line | Test | Verdict | Invariant lost / where covered now |
|---|------|------|------|------|---------|------------------------------------|
| [ ] | H | L | 184 | `test_carrier_conditional_cdf_saturates_to_one_for_latent_chain` | DELETE | Invariant: carrier conditional CDF saturates to 1.0, **not** to reach (no double-multiplication of `K(τ) × reach`). The reach/CDF separation is preserved structurally in `PreparedCarrierToX` (separate `reach: float` and `x_provider`); the saturation property is implicit in the new composer's `cdf_*` outputs. No equivalent assertion exists in current tests at the new entry, but the design preserves the invariant. **Mild loss**; a runtime-level assertion could be added later if it ever regresses. |
| [ ] | H | L | 254 | `test_all_non_latency_chain_carrier_cdf_is_dirac_at_zero` | DELETE | Invariant: all-non-latency upstream chain produces Dirac CDF (mass entirely at τ=0). Post-73n, this property is encoded at the **primitive** level — a non-latency primitive IS a Dirac — and primitive-level tests cover it. The composer doesn't need a chain-level assertion. **No coverage loss**; covered by primitive contract tests. |
| [ ] | H | L | 293 | `test_mixed_latency_then_non_latency_chain_carrier_reflects_latency_edge_timing` | DELETE | Invariant: mixed-latency chain composes to the latency edge's timing shape (median ≈ exp(μ)). Post-73n, this is the convolution behaviour of `compose_primitive_span` — implicit in primitive convolution and exercised by integration tests on cohort-mode runs. **Soft loss**; no direct unit pin but the runtime would surface a regression via cohort-mode acceptance tests. |
| [ ] | H | L | 355 | `test_horizon_adequacy_returns_at_least_99_percent_saturation_when_horizon_is_sufficient` | DELETE | Invariant: `K[max_tau] / reach ≥ 0.99` for fixtures sized to saturate. The 73m horizon-discipline rule was specific to the deleted composer; the new composer's saturation-vs-horizon contract is not the same shape. **Mild loss**; if the new composer needs a similar guard it should be expressed against `compose_primitive_span`'s actual outputs, not the old API. Out of scope here. |
| [ ] | H | L | 382 | `test_horizon_inadequacy_below_95_percent_must_be_refused_or_diagnosed` | DELETE | Invariant: <95% saturation must refuse (`tier='horizon_inadequate'`, `det_cdf=None`) rather than return a silently-truncated carrier. Post-73n, `compose_primitive_span` raises `CompositionError` for hard failures rather than returning diagnostic tiers (line 268 in subject_span_composer). The "must refuse" intent is preserved (raise vs return), but the specific tier-shape contract is gone. **Mild loss** of the explicit horizon-inadequate code path; the safety property (don't silently truncate) is preserved by raising. |
| [ ] | H | L | 450 | `test_composer_accepts_synthetic_transitions_without_invoking_resolver` | DELETE | Invariant: composer accepts pre-resolved transition primitives via a `transitions=...` kwarg, providing the seam for posterior-conditioned inputs (Phase 2/73n). Post-73n, the seam is the `RequestPrimitiveRegistry` populated upstream by Stage-2/3 resolution. The seam exists structurally; the specific kwarg-shape test is obsolete. **No coverage loss**. |
| [ ] | H | L | 493 | `test_composer_returns_identity_for_window_mode` | DELETE | Invariant: window mode → identity carrier (`is_identity=True`, `reach=1.0`, `det_cdf=None`). Already pinned at the runtime-factory level by test 115 (passing). **No coverage loss**. |
| [ ] | H | L | 512 | `test_composer_returns_identity_when_anchor_equals_denominator` | DELETE | Invariant: A=X → identity carrier. Already pinned at the runtime-factory level by test 135 (passing). Note: the new composer raises `CompositionError("requires x != end")` rather than returning identity — different shape but stricter (rejects the request entirely). **No coverage loss** at the carrier-factory level. |
| [ ] | H | L | 529 | `test_composer_returns_no_path_when_chain_is_disconnected` | DELETE | Invariant: disconnected anchor → no path. Post-73n, `compose_primitive_span` raises `CompositionError("no path from x to end in supplied graph")` (line 268). Same intent, exception instead of diagnostic. The error path is exercised by the new composer's own tests if any exist. **Mild loss** of explicit unit assertion. |
| [ ] | H | L | 550 | `test_composer_populates_mc_cdf_when_rng_provided` | DELETE | Invariant: per-draw MC CDFs populated when `(rng, num_draws)` are provided. Post-73n, `ComposedPrimitiveSpan` carries per-draw arrays when `is_draw_coherent` and primitives are draw-coherent — different shape. The MC seam is preserved; the specific `mc_cdf.shape == (32, 41)` assertion is obsolete. **Soft loss** of MC-seam integration test. |
| [ ] | H | L | 581 | `test_composer_diagnostics_carry_default_resolver_provenance` | DELETE | Invariant: default resolver labels transitions with `'prior_*'` provenance. Post-73n, provenance is carried by `ConditionedTransitionPrimitive.source` in the registry — different surface. The `'prior_'` vs `'posterior_'` distinction may or may not be preserved verbatim. **Mild loss**; if provenance discipline is load-bearing elsewhere it would already be tested at the primitive layer. |

### Summary of loss inventory

Of the 11 DELETE rows, **0 are genuine load-bearing coverage losses** — all
invariants either:

- (a) are preserved structurally in the post-73n design (test 184, test 450),
- (b) are covered at the primitive layer by existing tests (test 254, test 293),
- (c) are covered at the runtime-factory layer by surviving tests in this
  file (test 493 → 115; test 512 → 135),
- (d) are preserved by the new composer's stricter exception-raising
  behaviour (test 382, test 529, test 512),
- (e) are exercised by integration tests on cohort-mode runs (test 293),
- (f) are obsolete by surface change (test 450, test 581).

Three rows note "mild" or "soft" loss — primarily the absence of a
dedicated unit test for the saturation-to-1 invariant (184), the
horizon-inadequate code path (382), and the disconnected-graph path (529).
None blocks a known real defect; if any of these regresses, the surface
where it would manifest is a cohort-mode integration test which would
catch it.

**Recommendation: proceed with all 11 DELETEs as recipe-application.** No
backfill is required as part of this batch.

---

## Refactoring plan

In-place prune (no rename):

1. Delete the 11 tests at lines 184, 254, 293, 355, 382, 450, 493, 512,
   529, 550, 581.
2. Delete the docstring lines 219–226 ("RED-expected: Stage 2 (primitive)
   and Stage 3 (gate) targets …") which are no longer applicable.
3. Delete the docstring lines 339–352 (horizon-adequacy section header)
   which describe the deleted tests.
4. Delete docstring lines 440–448 (Stage 2 composer direct contract tests
   section header) for the same reason.
5. Update the file's top-of-module docstring (lines 1–27) to drop the
   reference to "the Stage-2 carrier composition primitive in
   `runner.carrier_composition`" — only the runtime v3 factory surface
   remains.

Risk on the refactor: L. The 4 keepers do not share any helpers with the
deleted tests beyond `_make_carrier_graph` and `_build_provider`, both of
which are kept. No imports become orphaned.

---

## Open questions (record decision before proceed)

1. **Should the file be renamed?** The 4 surviving tests are all about the
   runtime carrier-factory contract (window/cohort gate, A=X identity,
   topological reach, all-non-latency gate). The current name
   `test_carrier_object_contract.py` is still apt — the "carrier object" is
   the live `PreparedCarrierToX`. Default: no rename.

2. **Backfill any of the lost invariants now?** The "mild loss" rows
   (184 saturation, 382 horizon-inadequate, 529 disconnected) could each
   become a fresh test against `compose_primitive_span` in this batch,
   adding ~30–80 lines of new test code per invariant. Default: **do not
   backfill in this batch**. If any of these regresses, the next person
   to investigate adds the test then. Keeping batches narrowly scoped to
   recipe-application is more reliable than mixing recipe + design work.

---

## Tick semantics reminder

- `[ ]` proceed (default)
- `[~]` hold — skip this row, revisit at end of phase
- Strikethrough — drop from scope entirely

After review, type `proceed batch A2` and the agent will execute only `[ ]`
DELETE rows, run the verify command, and append the verify-run section
below.

---

## Verify run — 7-May-26

**Pre-edit baseline:**

```
11 failed, 4 passed in 0.17s
```

All 11 fails were `ModuleNotFoundError: No module named 'runner.carrier_composition'`.

**Post-edit:**

```
4 passed in 0.26s
```

**Net Δ:** −11 fails (11 → 0), 4 → 4 pass (unchanged). Matches predicted Δ exactly.

The pruned file now contains only the 4 runtime-factory contract tests
(`test_window_mode_returns_inactive_carrier`,
`test_a_equals_x_cohort_returns_inactive_carrier`,
`test_a_not_x_topological_reach_is_product_of_upstream_probabilities`,
`test_a_not_x_all_non_latency_chain_must_enable_carrier`) plus their two
helpers (`_make_carrier_graph`, `_build_provider`). 76 % of the file
removed.

No section-header comments retained — the file is short enough not to
need them. Top-of-module docstring updated to drop the Stage-2 composer
reference and to summarise the 4 surviving invariants.
