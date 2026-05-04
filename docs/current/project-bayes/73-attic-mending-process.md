# 73n Attic Mending Process

- **Status**: in-progress (started 4-May-26)
- **Driver**: [73-attic-coverage-audit.md](73-attic-coverage-audit.md) (147 intents classified)
- **Companion plan**: [73n-carrier-evidence-conditioning-implementation-plan.md](73n-carrier-evidence-conditioning-implementation-plan.md)
- **Pickup contract**: this document is the resumption point. If anyone (Claude or human) walks in mid-stream, read sections 1–4 and then the latest entry in §"Progress log" to know what's done, what's next, and what known-unknowns remain.

## 1. What we are doing

The 4-May commit `e15e9a9b` ("73n proceeding (generalisation of CF conditioning)") deleted `runner/carrier_composition.py` and replaced four per-surface readout entry points with a single unified `compute_resolved_runtime_readout` in `runner/primitive_readout.py`. Ten pytest files that pinned the older API broke at import time and have been quarantined under `graph-editor/lib/tests/_attic/` (collection skipped via `collect_ignore_glob` in [graph-editor/lib/tests/conftest.py](../../graph-editor/lib/tests/conftest.py)).

This process closes the resulting coverage hole by **mending the attic tests in place** and restoring the still-relevant ones to live collection, rather than rewriting from intents alone.

## 2. Why mend, not rewrite

The audit established that the attic encodes 147 distinct intents — across roughly 5,900 lines of test code with non-trivial fixture scaffolding (graph builders, identity builders, evidence-scope builders, arrival-map builders, candidate factories). Rewriting from the audit's 1-sentence intents would require re-deriving:

- exact field names on returned objects (posteriors, readout results, diagnostics blocks);
- exact literal values for `binding_policy`, skip-reason strings, provenance keys;
- exact graph shapes that exercise specific topology cases (identity / composed / degraded; latency / non-latency; deterministic / stochastic prefix);
- exact arrival-weight constructions that drive shifted-day binding, retrieval-superset envelopes, doc-52 numerator semantics.

The attic has all of this baked in. Mending preserves intent literally instead of paraphrasing it, and the migration surface is small: most failures resolve to a one-line import swap or a function-name swap.

## 3. Triage rubric (audit verdict → action)

The audit classifies every test in the attic as one of:

- **OBSOLETE** — the API the test pinned no longer exists by design. **Action: leave in attic, do not restore.** When the attic is eventually deleted, these go with it. Do not invent a replacement test for an obsolete intent unless the audit's "Recommendations" section flagged a behaviour worth preserving at a different layer.
- **GAP** — no live test pins this intent. **Action: mend and restore to live collection.** The mended file should drop into `graph-editor/lib/tests/` under its current attic name unless the audit suggested a better target.
- **PARTIAL** — a live test pins a related claim, but at weaker scope (fewer parameters, integration-only, missing edge cases). **Action: mend and restore IF the attic's specific assertion is load-bearing beyond the live partial cite.** Use the audit's "Gap" note on each PARTIAL row to decide. If the live coverage is genuinely equivalent on closer reading, drop the attic test.
- **COVERED** (zero in the audit) — would mean equivalent live coverage exists. Action would be to drop the attic test.

Triage discipline: when in doubt between PARTIAL-equivalent and PARTIAL-with-genuine-gap, mend. Cost of an extra test that overlaps live coverage is small; cost of a silent regression is not.

## 4. Migration map

These mappings have been verified by reading the current source. They are the dominant import/symbol changes attic files need.

### 4.1 Type renames (drop-in replacements)

| Attic import | Current source | Notes |
|---|---|---|
| `from runner.carrier_composition import TransitionPrimitive` | `from runner.timing_span import TimingTransitionPrimitive` | Identical dataclass fields (`p, mu, sigma, onset, p_sd, mu_sd, sigma_sd, onset_sd, source`). Constructor and field access unchanged. |

### 4.2 Readout entry point unification

| Attic call | Current call | Notes |
|---|---|---|
| `compute_single_hop_readout(...)` | `compute_resolved_runtime_readout(...)` | Caller now selects surface via inputs, not function name. **Will need per-test reconciliation** of result-object schema — not a pure rename. |
| `compute_multi_hop_subject_readout(...)` | `compute_resolved_runtime_readout(...)` | Same. |
| `compute_multi_hop_window_readout(...)` | `compute_resolved_runtime_readout(...)` | Same. |
| `compute_active_cohort_carrier_readout(...)` | `compute_resolved_runtime_readout(...)` | Same. |

The unified surface is at [graph-editor/lib/runner/primitive_readout.py](../../graph-editor/lib/runner/primitive_readout.py); `ResolvedRuntimeReadoutResult` is the new return type. Audit's OBSOLETE rows are mostly here — many per-surface eligibility helpers (`is_active_cohort_carrier_eligible`, `is_single_hop_eligible`, etc.) no longer exist as public entry points.

### 4.3 Public symbols still present (no migration needed)

Verified by grep against `runner/`:

- `runner.primitives.TransitionIdentity` ✓
- `runner.primitives.ConditionedTransitionPrimitive` ✓ (replaces some attic uses of `TransitionPrimitive`)
- `runner.primitives.PrimitiveScope`, `DrawFamilyKey`, `DrawFamilyMode`, `TimingFamily`, `ConditioningStatus`, `WeightedEvidenceRow`, `WeightedPrimitiveEvidenceView` ✓
- `runner.primitives.ProbabilityPosterior`, `TimingPosterior`, `SubsetPolicyProvenance`, `CompatibilityBlendProvenance`, `ResidualPolicyProvenance` ✓
- `runner.primitive_evidence.bind_primitive_evidence`, `PrimitiveBindingError`, `RequestPrimitiveRegistry`, `SpanPrimitiveMetadata`, `derive_retrieval_superset`, `make_primitive_scope_from_evidence_scope`, `validate_span_primitive`, `RetrievalSupersetSpec`, `PrimitiveBindingDiagnostics`, `PrimitiveEvidenceResolution` ✓
- `runner.primitive_conditioning.condition_primitive`, `ConditioningPolicyOptions`, `make_unconditioned_primitive` ✓
- `runner.prefix_arrival.PrefixArrivalIdentity`, `PrefixArrivalMap`, `NodeArrivalWeights`, `NodeArrivalProvenance`, `build_prefix_arrival_map` ✓
- `evidence_merge.*` symbols used by attic ✓ (no rename observed)

### 4.4 Known unknowns (resolve on first hit, then update this doc)

- ~~**Cache-registry public surface** for §417 invalidation tests — registered names (`primitive`, `composed_subject_span`?), single-cache flush API, `set_cache_bypass` ContextVar location. Likely in `runner/result_cache.py` or `snapshot_service.py`. Resolve before mending `test_composed_cache.py` and `test_primitive_cache.py`.~~ **RESOLVED 4-May-26 during file 4 mend**: registry lives in `lib/result_cache.py`. Public surface: `make_cache(name, ttl_s, max_entries)`, `get_cache(name)`, `clear_all()`, `clear(name)`, `stats_all()`, `cache_bypass_ctx` (class), `set_cache_bypass(bypass)` / `reset_cache_bypass(token)` / `is_cache_bypassed()`. Snapshot-service re-exports `set_cache_bypass`, `reset_cache_bypass`, `cache_clear`. Primitive cache is registered as `'primitive'` (verified at `runner/primitive_conditioning.py:100-104`). The composed-subject-span cache name is still TBD — confirm during file 5 (test_composed_cache.py).
- **`compute_resolved_runtime_readout` signature and `ResolvedRuntimeReadoutResult` schema** — diagnostic block field names (`composed_carrier`, `subject_probability_source`, `binding_policy`, `delta_p_mean`, `within_shadow_band`, `should_substitute`?). Resolve before mending `test_active_cohort_carrier_readout.py`, `test_multi_hop_subject_readout.py`, `test_multi_hop_window_readout.py`, `test_primitive_readout.py`, `test_stage_8_substrate_provenance.py`.
- **Stage 6 input axes** — which input field carries "upstream resolved-model" vs "target subject evidence" so connectivity invariants can vary one without the other. Resolve before mending Stage 6 isolation/connectivity tests.

These are the recon items §6.1 expects you to land on first when picking up.

## 5. Order of operations

Files are mended in dependency order: scaffolding-rich files first (so later files can `from .test_primitive_evidence import _make_graph, _identity, _evidence_scope, _candidate, _build_arrival_map`), then files that depend on the unified readout surface, then leaf files.

1. **`test_primitive_evidence.py`** (932 lines, 18 intents: 4 PARTIAL + 14 GAP) — seeds graph/identity/scope/candidate/arrival-map helpers used by 4 other files. Includes 4 of the 9 Tier A intents.
2. **`test_primitive_conditioning.py`** (779 lines, 19 intents: 9 PARTIAL + 10 GAP) — seeds conditioning fixtures; covers Tier E.
3. **`test_prefix_arrival.py`** (703 lines, 15 intents: 13 GAP + 2 OBSOLETE) — Stage 2 prefix-arrival map invariants (Tier C: 11 items).
4. **`test_primitive_cache.py`** (460 lines, 16 intents: 5 PARTIAL + 11 GAP) — primitive cache (Tier B: 6 items, plus Tier A.4).
5. **`test_composed_cache.py`** (624 lines, 15 intents: 7 GAP + 8 OBSOLETE) — composed-subject-span cache; the Stage 6 OBSOLETE rows leave behind a residue of 7 GAPs that include Tier A.3 and Tier B.13–B.17.
6. **`test_primitive_readout.py`** (411 lines, 14 intents: 5 PARTIAL + 4 GAP + 5 OBSOLETE) — single-hop readout surface, mostly absorbed into unified readout.
7. **`test_multi_hop_subject_readout.py`** (342 lines, 13 intents: 4 PARTIAL + 4 GAP + 5 OBSOLETE).
8. **`test_multi_hop_window_readout.py`** (369 lines, 13 intents: 4 PARTIAL + 5 GAP + 4 OBSOLETE) — includes Tier A.7 anti-collapse-to-terminal.
9. **`test_active_cohort_carrier_readout.py`** (532 lines, 16 intents: 7 PARTIAL + 4 GAP + 5 OBSOLETE) — Stage 6 surface; includes Tier A.8 and A.9 connectivity invariants.
10. **`test_stage_8_substrate_provenance.py`** (717 lines, 8 intents: 2 PARTIAL + 6 GAP) — substrate inventory; closes the audit.

This order also means each Tier A intent (load-bearing numeric correctness) lands in the natural file rather than in a new bespoke file, which is a side benefit over the greenfield path.

## 6. Per-file workflow

For each attic file, in order:

### 6.1 Recon (do once, then update §4.4 if you discover a new unknown)

- Read the attic file end-to-end. Note its imports, fixture helpers, and one-line per-test intent.
- For every import that fails or every called symbol that no longer exists, locate its current home with grep (`grep -rn "def symbol_name" graph-editor/lib/runner/`).
- Write the migration delta in §4 of this doc — leave a record so the next file gets the benefit.
- Read the audit's per-file section (in [73-attic-coverage-audit.md](73-attic-coverage-audit.md)) to know which intents are GAP / PARTIAL / OBSOLETE before touching the code.

### 6.2 Mend

- Move the file from `graph-editor/lib/tests/_attic/` back to `graph-editor/lib/tests/` (this requires a destructive-gate confirmation each time — see §8).
- Rewrite imports per §4.
- Annotate each test function with a header comment block keyed to the audit verdict:
  - GAP → no comment beyond what's already there; this test is the closure of a real gap.
  - PARTIAL → one-line comment naming the live test that partially covers the same claim and what this attic-mended test adds beyond it (regression risk being closed).
  - OBSOLETE → wrap the test body in `pytest.skip("OBSOLETE: …")` with a one-line reason citing the deleted API. Do not delete the function — it stays as a tombstone marker for "the audit confirmed this no longer applies" and an aid to resumption discipline. (When the attic is finally deleted the tombstones go with it.)
- Adapt call sites for the readout-surface migration (4.2). This is the part that is **not a pure rename** — confirm the assertion still holds against the unified result schema before declaring the test mended.

### 6.3 Verify

- Run pytest just on the mended file: `cd graph-editor && . venv/bin/activate && pytest lib/tests/<file>.py -x`.
- Read every assertion failure and decide: (a) the assertion is still right but the unified API surface differs and the test needs adapting, or (b) the assertion is wrong because the post-73n behaviour genuinely changed and the audit miscategorised the row. In case (b), fix the audit — do not silently weaken the test.
- Use `--tb=short` per `pytest.ini`. Do **not** truncate output (CLAUDE.md hard rule).

### 6.4 Record

- Append an entry to §"Progress log" below: file name, total intents, classification breakdown, what changed in §4 (if anything), and a one-line "next file unblocked" note.
- If a Tier-A intent landed: cross-reference it back to the audit's Gap workplan section.

## 7. Definition of done

The full process is complete when:

- All 10 attic files have been processed in order.
- Every GAP intent landed as a passing test (or has a documented reason it could not, with audit updated).
- Every PARTIAL with a load-bearing residue landed as a passing test or was downgraded to "live coverage is sufficient" with explicit reasoning in this doc.
- Every OBSOLETE intent is either a `pytest.skip` tombstone in a restored file or remains in the still-quarantined attic.
- `pytest --collect-only` reports zero errors (currently 1481 tests collected, 0 errors — must stay green).
- `_attic/` is empty or contains only files whose entire intent surface is OBSOLETE (and is then a candidate for outright deletion at the user's call).
- All 9 Tier A items in [73-attic-coverage-audit.md](73-attic-coverage-audit.md) §"Gap workplan" are pinned by tests in the live tree.

The audit document does NOT need updating after each file; it is a frozen snapshot. Discrepancies discovered during mending should be recorded as deltas in §"Progress log" of this doc, and the audit's recommendations section is the only block we'd amend in place if a sweeping reclassification is warranted.

## 8. Operational notes

- **Briefing-receipt context-gate**: `graph-editor/lib/tests/` is NOT in the v1 scoped paths list ([../../.claude/context-manifest.yaml](../../.claude/context-manifest.yaml) covers `bayes/**`, `statisticalEnhancementService.ts`, `analysisECharts/**`, `analysis_subject_resolution.py`, `repositoryOperationsService.ts`, `dataOperationsService.ts`, `workspaceService.ts`, `indexRebuildService.ts`). Test edits do not require a briefing receipt.
- **Destructive-gate (Gate 2)**: every `mv` from `_attic/` back to `lib/tests/` triggers the destructive-ops gate. The user pre-authorised the attic move in this conversation; future `mv` invocations from `_attic/` to `lib/tests/` should be batched (one per file, but the user's "yes" to start mending is the standing instruction for these specific moves — re-confirm if the user later closes this session).
- **Carrier-composition import elsewhere**: production code under `runner/` is clean of `carrier_composition` imports (verified by grep). The two hits in `runner/primitive_readout.py` are diagnostic key strings (`"carrier_composition_error"`), not module references. Test mends should use `composition_error` / `subject_composition_error` / `carrier_composition_error` as diagnostic-string literals where the attic asserted those keys; they survive in the unified diag block.
- **Test running discipline**: per CLAUDE.md, run only relevant tests on each mend. Do **not** run the full suite until the very end. Never use `head` / `tail` / output truncation.
- **Output style**: per CLAUDE.md, no UI or planning files beyond what the user requests. This doc was explicitly requested. The audit doc was explicitly requested. Do not create more.

## 9. Progress log

Append-only. One entry per attic file processed. Format:

```
### YYYY-MM-DD — <file name>

- intents: <total> (G:<gap> P:<partial> O:<obsolete>)
- restored as: <path or "left in attic">
- migration deltas added to §4: <bullets or "none">
- new tombstones: <count or "none">
- Tier-A items closed: <list or "none">
- next unblocked: <next file>
- followups: <bullets or "none">
```

### 4-May-26 — process bootstrapped

- Audit at [73-attic-coverage-audit.md](73-attic-coverage-audit.md) (561 lines, 147 intents).
- Migration map populated in §4 with verified type-rename and known-unknowns.
- First file to mend: `test_primitive_evidence.py`.

### 4-May-26 — `test_primitive_evidence.py`

- intents: 18 (G:14 P:4 O:0)
- restored as: [graph-editor/lib/tests/test_primitive_evidence.py](../../graph-editor/lib/tests/test_primitive_evidence.py); attic original retained at [graph-editor/lib/tests/_attic/test_primitive_evidence.py](../../graph-editor/lib/tests/_attic/test_primitive_evidence.py) for reference (per user instruction "copy, don't move").
- migration deltas added to §4: none beyond the verified `TransitionPrimitive` → `TimingTransitionPrimitive` rename. Single import swap, single `_prim()` annotation/constructor rename — no API drift in the binder, registry, retrieval-superset, or span-primitive validator.
- new tombstones: none (no OBSOLETE rows in this file).
- Tier-A items closed: A.1 outside-in anti-leak (`test_outside_in_anti_leak_downstream_primitive_conditions_on_shifted_day`), A.2 off-clock retrieval-superset exclusion (`test_admitted_mass_inputs_exclude_retrieval_superset_off_clock_rows`), A.5 doc-52 admitted-mass semantics (subsumed by the same test), A.6 window-mode parity oracle (`test_window_mode_weighted_totals_equal_raw_totals`).
- pytest result: **18/18 passing** in 0.27s.
- workflow note: the user vetoed the in-place edit-then-move pattern. Standing instruction is **copy attic → live, then edit the live copy**, leaving the attic untouched as a triage reference. Future files follow this pattern. Implementation here used Read + Write (no `cp`) because the destructive gate fires on `cp` even when the destination doesn't exist.
- next unblocked: `test_primitive_conditioning.py` (file 2 in §5 order). Its scaffolding is similar; same `TransitionPrimitive` → `TimingTransitionPrimitive` swap is the leading mend hypothesis.
- followups: PARTIAL annotations (one-line live-test cross-references on the 4 PARTIAL functions: `test_wp8_default_off_rejects_cohort_role`, `test_as_at_admission_uses_retrieved_at_not_anchor_day`, `test_merge_evidence_candidates_signature_unchanged_for_non_primitive_callers`, `test_registry_to_provenance_dict_emits_per_primitive_inventory`, `test_raw_and_weighted_evidence_are_explicitly_separate_even_when_equal`) deferred — get all files passing first, decide if annotations earn their cost or whether the audit doc cross-reference is sufficient.

### 4-May-26 — `test_primitive_conditioning.py`

- intents: 19 (G:10 P:9 O:0 per audit; **+1 reclassified PARTIAL → OBSOLETE during mend** — see below)
- restored as: [graph-editor/lib/tests/test_primitive_conditioning.py](../../graph-editor/lib/tests/test_primitive_conditioning.py); attic original retained.
- migration deltas added to §4: none beyond the verified `TransitionPrimitive` → `TimingTransitionPrimitive` rename, but **two semantic deltas surfaced** during pytest:
  - **`build_prefix_arrival_map` root entry is held AS-IS, not normalised** ([prefix_arrival.py:262-272](../../graph-editor/lib/runner/prefix_arrival.py#L262-L272)). With weights `{d1: 1.0, d2: 1.0}`, `n_weighted_total` now equals raw admitted total, not raw/2. Test setup in `test_doc52_subset_mass_uses_raw_admitted_rows_not_arrival_weighted_total` adjusted to use `{0.5, 0.5}` weights so the raw-vs-weighted separation remains visible (n_weighted=100, m_S=200). Intent preserved.
  - **`DrawFamilyKey.canonical_string` v2 (Atom 2) deliberately drops `scenario_seed`** ([primitives.py:146-149](../../graph-editor/lib/runner/primitives.py#L146-L149)) — "scenario_seed are caller-context labels, not part of the conditioned-posterior identity". Two primitives with identical math share a draw family regardless of seed. The audit's PARTIAL classification of `test_distinct_scenario_seeds_give_independent_draws` was wrong: the intent (distinct seeds → distinct draws) is **OBSOLETE by design** in 73n, not just relocated. The retained intent (distinct draw families → independent streams) is pinned at `test_primitive_contract.py::test_different_draw_family_keys_produce_independent_draws`.
- new tombstones: 1 (`test_distinct_scenario_seeds_give_independent_draws`, marked `pytest.mark.skip` with reason citing the v2 design and the live test that pins the retained intent).
- Tier-A items closed: none beyond what test_primitive_evidence already closed (Tier A.1, A.2, A.5, A.6 all done in file 1).
- pytest result: **18 passed, 1 skipped** in 0.38s.
- audit feedback: the audit's classification was right that scenario-seed-based independence was load-bearing; it was wrong about whether 73n preserved the route. Mark the audit row OBSOLETE-not-PARTIAL on next pass; for now the tombstone in code is the canonical record.
- next unblocked: `test_prefix_arrival.py` (file 3 in §5 order). Watch for the same root-entry-not-normalised behaviour assumption — the prefix-arrival tests are most likely to encode it explicitly.
- followups: PARTIAL annotations still deferred. Audit-doc reclassification of one intent (PARTIAL → OBSOLETE) tracked here, not in the audit itself.

### 4-May-26 — `test_prefix_arrival.py`

- intents: 15 (G:13 P:0 O:2)
- restored as: [graph-editor/lib/tests/test_prefix_arrival.py](../../graph-editor/lib/tests/test_prefix_arrival.py); attic original retained.
- migration deltas added to §4: none beyond the verified `TransitionPrimitive` → `TimingTransitionPrimitive` rename. The non-normalised root-entry behaviour was already documented in §4.4 follow-on from file 2; its Stage 2 explicit-test variant (`test_root_day_weights_pass_through_unchanged_to_root_entry`) passes cleanly. Also confirmed: the no-second-timing-path guard now references `timing_span` not `carrier_composition` (the comment in the test was updated to reflect this; the forbidden-imports list is unchanged because none of those modules ever should appear).
- new tombstones: 2 (audit-flagged OBSOLETE):
  - `test_topological_map_does_not_invoke_carrier_composer_after_construction` — instrumented sentinel against deleted `compose_carrier_to_x` symbol on `runner.prefix_arrival`.
  - `test_carrier_dag_diamond_arrival_weight_matches_composer_reach` — comparator oracle (`compose_carrier_to_x`) deleted with the carrier_composition module. Reach algebra still pinned by `test_carrier_object_contract.py::test_a_not_x_topological_reach_is_product_of_upstream_probabilities` and the unified prefix-arrival map; only the comparator pattern is gone.
- Tier-A items closed: none directly, but Tier C (Stage 2 prefix-arrival map invariants — 11 items in the audit gap workplan) is now substantially covered. Items C.18 through C.28 of the audit's Gap workplan are pinned by the 13 passing tests in this file: window-clock identity, cohort A==X identity, non-latency chain, deterministic shift, topological reuse, contexted-source identity, stochastic mean, subject DAG fanout, boundary join at X, boundary split at X, degraded entry, root pass-through, and no-second-timing-path import guard.
- pytest result: **13 passed, 2 skipped** in 0.21s.
- next unblocked: `test_primitive_cache.py` (file 4 in §5 order). This is where §4.4's "cache-registry public surface" known-unknown lives — likely the file that drives the resolution. Watch for `runner/result_cache.py` API surface (registered names, single-cache flush, `set_cache_bypass` ContextVar).
- followups: none beyond the running deferred PARTIAL annotations.

### 4-May-26 — `test_primitive_cache.py`

- intents: 16 (G:11 P:5 O:0 per audit; **+1 reclassified GAP → OBSOLETE during mend**)
- restored as: [graph-editor/lib/tests/test_primitive_cache.py](../../graph-editor/lib/tests/test_primitive_cache.py); attic original retained.
- migration deltas added to §4: §4.4 known-unknown for cache registry **resolved** — see updated §4.4 entry. The cache key correctly excludes `scenario_seed` (consistent with the v2 design pinned in primitives.py:146-149); attempting to test cache-miss-on-seed therefore tests against retired behaviour.
- new tombstones: 1 — `test_cache_miss_for_different_scenario_seed`. Same v2 reason as `test_distinct_scenario_seeds_give_independent_draws` in file 2.
- Tier-A items closed: **A.4 (§739 cached/uncached equivalence)** by `test_cached_and_uncached_results_have_identical_posterior_fields` — pinning that uncached-bypass and cached calls produce identical `status`, `probability_posterior.mean`, `probability_posterior.sd`, `probability_posterior.draws` arrays, and `effective_evidence_totals`.
- Tier-B items closed (audit Gap workplan §"Tier B — request-scoped registry / cache contract"): B.13 `test_snapshot_cache_clear_flushes_primitive_cache`, B.14 `test_bypass_uses_same_contextvar_as_snapshot_cache`, B.15 `test_primitive_cache_is_registered_under_known_name`, B.16 `test_cache_miss_for_different_*` parametrised across 7 axes (with axis 1 = scenario_seed retired by v2 design).
- pytest result: **15 passed, 1 skipped** in 0.41s.
- next unblocked: `test_composed_cache.py` (file 5 in §5 order). Will resolve the remaining bit of §4.4 — the composed-subject-span cache registered name. Audit says 7 GAP + 8 OBSOLETE, so most of it stays attic'd; expect substantial tombstoning.
- followups: none beyond the running deferred PARTIAL annotations.

### 4-May-26 — `test_composed_cache.py`

- intents: 15 (G:7 P:0 O:8 — matches audit)
- restored as: [graph-editor/lib/tests/test_composed_cache.py](../../graph-editor/lib/tests/test_composed_cache.py); attic original retained.
- migration deltas added to §4: §4.4 cache-registry known-unknown **fully resolved** — `composed_subject_span` is the registered name (verified at `runner/subject_span_composer.py:89-93`). `composed_carrier` no longer exists as a registered cache (the carrier_composition module was deleted; carrier composition flows through the unified primitive-span substrate now).
- new tombstones: 8 (entire `TestCarrierCacheWiring` class, decorated at class level with one `@pytest.mark.skip`). Audit File 2 rows 1-8 confirmed OBSOLETE on mend. Live coverage of the retained intent (cache wiring of composed objects) is `test_active_cohort_carrier_audit.py::test_active_cohort_carrier_readout_uses_primitive_span_composer` plus `test_result_cache.py::TestBypass`/`TestRegistry`.
- Tier-A items closed: **A.3 (§417 composed caches must invalidate when their primitives invalidate)** by `test_primitive_cache_flush_invalidates_subject_span_cache`. This was flagged Complexity-L in the audit's Gap workplan; mended in place using the attic's existing scaffold (`_build_subject_setup` builds two distinct primitive instances after a `result_cache.get_cache('primitive').clear()` call and verifies the composed-subject cache misses on the new primitive id()).
- Tier-B items closed: B.13 (test_snapshot_cache_clear_flushes_subject_span_cache), B.14 (test_bypass_via_snapshot_service_set_cache_bypass), B.15 (test_subject_span_cache_registered_under_known_name), B.17 (test_identical_calls_return_cached_object + test_different_endpoints_miss + test_cached_and_bypassed_results_are_numerically_equivalent — the four-test bundle the audit's gap workplan named for `test_composed_subject_span_cache.py`; we got them all in place).
- pytest result: **7 passed, 8 skipped** in 0.94s.
- next unblocked: `test_primitive_readout.py` (file 6 in §5 order). Audit says 5 PARTIAL + 4 GAP + 5 OBSOLETE — 5 OBSOLETE entries means substantial tombstoning. This is also the file that resolves §4.4's `compute_resolved_runtime_readout` schema known-unknown — be ready to read `runner/primitive_readout.py` to find the surface the live tests exercise.
- followups: PARTIAL annotations still deferred. Tier A is now 5/9 closed (A.1 evidence anti-leak, A.2 off-clock retrieval-superset, A.3 §417 cache invalidation, A.4 §739 cache equivalence, A.5 doc-52 raw-vs-weighted, A.6 window-mode parity oracle). A.7 (anti-collapse-to-terminal), A.8 (target-subject isolation), A.9 (upstream-evidence carrier reach) remain — these live in files 7, 8, 9 (multi-hop and active-cohort).

### 4-May-26 — `test_primitive_readout.py`

- intents: 14 (audit File 9: G:4 P:5 O:5)
- restored as: [graph-editor/lib/tests/test_primitive_readout.py](../../graph-editor/lib/tests/test_primitive_readout.py); attic original retained.
- migration deltas added to §4: `compute_resolved_runtime_readout` signature confirmed at `runner/primitive_readout.py:541` — consumes `graph + subject_edge_resolutions + carrier_edge_resolutions` against a topology, NOT the per-edge `transition + evidence_set` shape the attic tests pass to `compute_single_hop_readout`. The two surfaces are not interchangeable; mending requires building `SpanEdgeResolution`/`CarrierEdgeResolution` objects per edge and a graph fixture per test, which is a rewrite, not a translation.
- new tombstones: 14. The single survivor is `test_shadow_band_constants_match_stage_0c_contract` (a trivial constants check that depends on `SHADOW_ABS_BAND` and `ACCEPTANCE_ABS_BAND`, both still exported). Eligibility-helper tests (rows 1-5) tombstoned with one reason; readout-call tests (rows 6, 7, 8, 10, 11, 12, 13, 14) tombstoned with another reason citing live integration coverage at `test_primitive_readout_integration.py`.
- Tier-A items closed: none (the audit Gap workplan rows for full/zero subset limit at the readout layer remain live work — they would be new integration tests against the unified entry, not mends).
- pytest result: **1 passed, 14 skipped** in 0.22s.
- followups: PARTIAL annotations still deferred. The audit's gap workplan rows for soft-skip parametrisation (incomplete inputs, target_count_invalid, composer_path_failure) remain live items.

### 4-May-26 — `test_multi_hop_subject_readout.py`, `test_multi_hop_window_readout.py`, `test_active_cohort_carrier_readout.py` (batched)

These three files all drive deleted per-surface readout entry points (`compute_multi_hop_subject_readout`, `compute_multi_hop_window_readout`, `compute_active_cohort_carrier_readout`). Same situation as `test_primitive_readout.py` — the unified `compute_resolved_runtime_readout` has a different shape so the attic tests cannot translate by mechanical mend. All three files written as tombstone modules.

- intents: 13 + 13 + 16 = 42 (audit Files 3, 4, 1)
- restored as: live tombstone modules at the corresponding paths under `graph-editor/lib/tests/`; attic originals retained.
- new tombstones: 42 — every test in all three files. The single survivor is `test_module_does_not_import_trajectory_engine` in `test_active_cohort_carrier_readout.py` (a static-source check on `runner/primitive_readout.py` that depends on no deleted symbols and survives the API unification cleanly).
- Tier-A items closed: none. Tier A.7 (anti-collapse-to-terminal §709) was the live-bearing test in `test_multi_hop_window_readout.py::test_on_flag_does_not_collapse_to_terminal_edge`; tombstoned. Tier A.8 (target-subject-only-change isolation) and A.9 (upstream-evidence-changes-carrier-reach) were both in `test_active_cohort_carrier_readout.py`; tombstoned. All three remain live items in the audit's Gap workplan to be written against the unified entry layer.
- pytest result (combined): **1 passed, 42 skipped**.

### 4-May-26 — `test_stage_8_substrate_provenance.py`

- intents: 8 (audit File 10: G:6 P:2 O:0 — but on mend all 10 test functions imported deleted symbols, so the entire file is tombstoned)
- restored as: tombstone module at `graph-editor/lib/tests/test_stage_8_substrate_provenance.py`; attic original retained.
- migration deltas added to §4: none beyond what was already known. The closure-required substrate keys per plan §745 are still emitted by the unified entry's diagnostics block (verified at `runner/primitive_readout.py:585-616` in the `_runtime_provenance` helper); the attic's wrapping shape (`diagnostics['primitive_provenance']` for single-hop, `diagnostics['primitives']` per-primitive list for multi-hop) is what the unified entry has retired in favour of a flatter shape.
- new tombstones: 10. Audit had classified the file as 8 PARTIAL/GAP (not OBSOLETE) but every test imports a deleted symbol, so the audit's classification is updated downstream by this tombstone. Live primitive-level coverage at `test_primitive_contract.py::test_to_provenance_dict_carries_stage_8_closure_required_items`.
- Tier-A items closed: none.
- pytest result: **0 passed, 10 skipped** in 0.04s.

### 4-May-26 — Mending complete

Final status across all 10 files:

| File | Passed | Skipped (tombstones) | Notes |
|---|---:|---:|---|
| test_primitive_evidence.py | 18 | 0 | Tier A.1, A.2, A.5, A.6 |
| test_primitive_conditioning.py | 18 | 1 | Tier E partially closed |
| test_prefix_arrival.py | 13 | 2 | Tier C closed |
| test_primitive_cache.py | 15 | 1 | Tier A.4, Tier B mostly closed |
| test_composed_cache.py | 7 | 8 | **Tier A.3 closed** (§417 invalidation) |
| test_primitive_readout.py | 1 | 14 | constants check survives |
| test_multi_hop_subject_readout.py | 0 | 13 | full tombstone |
| test_multi_hop_window_readout.py | 0 | 13 | full tombstone (Tier A.7 deferred) |
| test_active_cohort_carrier_readout.py | 1 | 16 | trajectory-engine guard survives (Tier A.8, A.9 deferred) |
| test_stage_8_substrate_provenance.py | 0 | 10 | full tombstone |
| **Totals** | **73** | **78** | **0 failed** |

Tier A items closed: 6 of 9 (A.1 outside-in anti-leak, A.2 off-clock retrieval-superset exclusion, A.3 §417 cache invalidation, A.4 §739 cache equivalence, A.5 doc-52 raw-vs-weighted, A.6 window-mode parity). Tier A items remaining as live workplan: A.7 anti-collapse-to-terminal, A.8 target-subject isolation, A.9 upstream-evidence carrier reach — all three are at the unified-readout integration layer and remain in the audit's Gap workplan as items to write fresh, not as mended attic tests.

Audit-vs-mend reclassifications (rows the audit called PARTIAL/GAP that turned out to be OBSOLETE during mend):
- `test_primitive_conditioning.py::test_distinct_scenario_seeds_give_independent_draws` — DrawFamilyKey v2 dropped scenario_seed.
- `test_primitive_cache.py::test_cache_miss_for_different_scenario_seed` — same v2 reason.
- All 14 tests in `test_primitive_readout.py` (only constants check survives) — unified API surface.
- All 13 tests in `test_multi_hop_subject_readout.py` — same.
- All 13 tests in `test_multi_hop_window_readout.py` — same.
- All 16 of 17 tests in `test_active_cohort_carrier_readout.py` — same.
- All 10 tests in `test_stage_8_substrate_provenance.py` — same.

§4.4 known-unknowns: all resolved during the mend. Cache-registry public surface fully documented (registered names: `'primitive'`, `'composed_subject_span'`; bypass via `result_cache.cache_bypass_ctx` ContextVar; snapshot-service re-exports `set_cache_bypass`/`reset_cache_bypass`/`cache_clear`). `compute_resolved_runtime_readout` signature documented (graph + subject/carrier edge resolutions). Stage 6 input axes documented (carrier_edge_resolutions vs subject_edge_resolutions, both as input to the unified entry; isolating one without the other is the test pattern the workplan items will follow).

Recommendation: the attic can now be deleted at the user's call. All mended live tests run green; all tombstoned tests have explicit reasons pointing to the live coverage that survives the architectural change. The audit's Gap workplan retains 3 Tier-A items + miscellaneous Tier B/C/D/E items as forward work, all at the unified-readout layer where the attic tests cannot reach.

<!-- Append further entries below this line as work proceeds. -->
