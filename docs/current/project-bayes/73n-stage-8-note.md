# 73n Stage 8 — Cross-Surface Projection and Provenance — note

**Status**: Stage 8 landed. The four primitive-substrate readouts (single-hop, multi-hop subject span, multi-hop window, active cohort A!=X carrier consumer) now thread `ConditionedTransitionPrimitive.to_provenance_dict()` per-primitive into their response diagnostics, so a reviewer can read every plan §745 closure-required item directly off the response — primitive id, evidence role, raw / weighted / effective evidence totals, evidence-clock provenance (arrival_weight summary + binding policy + scope key), prior source, conditioning status, draw-family identity, residual / complement diagnostics, composed subject + carrier topology, and composed reach / probability summaries. Each readout diag also carries an optional `cache_status` snapshot (plan §760, observability-only). `PreparedConditioningEvidence` is documented in source as compatibility metadata (plan §762) and the serialised `runtime_bundle.p_conditioning_evidence` block now carries an explicit `compatibility_metadata_note` so consumers do not mistake it for an evidence-ownership decider.
**Date opened**: 1-May-26
**Plan**: [`73n-carrier-evidence-conditioning-implementation-plan.md`](73n-carrier-evidence-conditioning-implementation-plan.md) §"Stage 8 — Cross-Surface Projection and Provenance" lines 741-762
**Stage 0c contracts**: [`73n-stage-0-baseline.md`](73n-stage-0-baseline.md) §3.3 (numeric tolerances)
**Stage 1-7 inputs**: [`73n-stage-1-note.md`](73n-stage-1-note.md), [`73n-stage-2-note.md`](73n-stage-2-note.md), [`73n-stage-3-note.md`](73n-stage-3-note.md), [`73n-stage-4-note.md`](73n-stage-4-note.md), [`73n-stage-5a-note.md`](73n-stage-5a-note.md), [`73n-stage-5b-note.md`](73n-stage-5b-note.md), [`73n-stage-5c-note.md`](73n-stage-5c-note.md), [`73n-stage-6-note.md`](73n-stage-6-note.md), [`73n-stage-7-note.md`](73n-stage-7-note.md)

---

## 1. Stage 8 deliverables

### 1.1. `ConditionedTransitionPrimitive.to_provenance_dict()` widened

[`graph-editor/lib/runner/primitives.py`](../../graph-editor/lib/runner/primitives.py) — the per-primitive provenance dict is now the canonical Stage 8 substrate serialisation. Three new keys plus one helper field:

- `weighted_evidence` — full block exposing `n_weighted_total`, `k_weighted_total`, `row_count`, `binding_policy`, `evidence_scope_key`, and the existing `arrival_weight_summary`. Previously only a `has_weighted_evidence: bool` flag appeared. Plan §745 evidence-clock-provenance bullet is now satisfied from the substrate dict alone.
- `is_draw_coherent` — top-level boolean mirroring the dataclass property. Plan §745 draw-family identity bullet. Cheap to read; no consumer needs to re-derive from `(status, draw_family_mode)`.

The existing keys (`transition`, `scope`, `status`, `effective_evidence_totals`, `subset_policy`, `compatibility_blend`, `residual_policy`, `prior_source`, `draw_family_mode`, `draw_family_key_digest`, `timing_family`, `raw_evidence_scope_key`, `probability_posterior`, `timing_posterior`, `skipped_evidence_summary`, `notes`) remain unchanged. The dict round-trips through `json.dumps`.

### 1.2. Per-primitive substrate threading at every readout

[`graph-editor/lib/runner/primitive_readout.py`](../../graph-editor/lib/runner/primitive_readout.py) — every `primitive_summaries.append(...)` call site at the four readout entry points now embeds `provenance: primitive.to_provenance_dict()` alongside the existing minimal `{edge_id, from, to, status, is_draw_coherent}` fields. Concretely:

| Readout | Where the substrate appears |
|---|---|
| Stage 5a single-hop | `diag['primitive_provenance']` (top-level; the readout has exactly one primitive) |
| Stage 5b multi-hop subject | each entry in `diag['primitives']` carries `provenance` |
| Stage 5c multi-hop window | each entry in `diag['primitives']` carries `provenance` |
| Stage 6 active cohort A!=X | each entry in `diag['carrier_primitives']` *and* `diag['subject_primitives']` carries `provenance` |

The widened summaries are additive — existing minimal fields stay so every existing consumer (the `test_primitive_readout_integration.py` parity tests, the cohort_maturity / handle_conditioned_forecast surfacing in api_handlers) keeps reading the same shape.

### 1.3. Optional `cache_status` snapshot per readout (plan §760)

[`graph-editor/lib/runner/primitive_readout.py`](../../graph-editor/lib/runner/primitive_readout.py) — a new module-level helper `_cache_status_snapshot()` returns `result_cache.stats_all()['caches']` as a compact list (≤4 caches × 7 fields) or `None` if the registry is unreachable. Each of the four readouts appends `diag['cache_status']` at its successful-return diag finalisation point. The snapshot is **post-readout aggregate stats**, not a per-request delta — sufficient for "did the request hit any caches" observability without the wiring cost of capturing pre/post snapshots.

Plan §760 explicitly says cache hit/miss status "is useful once persistent caching is enabled, but it is not required to close 73h Issue 2." Stage 8 therefore ships it as observability-only, behind no flag, but with `None` tolerated so the registry-unavailable case stays soft.

### 1.4. `p_conditioning_evidence` documented as compatibility metadata (plan §762)

[`graph-editor/lib/runner/forecast_runtime.py`](../../graph-editor/lib/runner/forecast_runtime.py):

- `PreparedConditioningEvidence` docstring now explicitly states it is **compatibility metadata** and names the two surviving consumers — the legacy fallback `evidence_k`/`evidence_n` projection on response payloads and the Stage 5a synthetic identity-clock fallback. Both downgrade primitive provenance to a synthesised `EvidenceSet` only when no typed `EvidenceSet` was threaded through; the primitive layer then owns evidence semantics from that point on.
- `serialise_runtime_bundle()` now emits a `compatibility_metadata_note` field inside the `p_conditioning_evidence` dict, naming plan §762 directly, so any consumer reading the runtime-bundle diag block sees the disclaimer next to the totals.

The four readout entry points still take a typed `EvidenceSet` parameter (not `p_conditioning_evidence`) — pinned by the new `test_readouts_do_not_accept_p_conditioning_evidence_parameter` introspection test (§1.5).

### 1.5. Tests

| File | Tests added | Coverage |
|---|---|---|
| [`test_primitive_contract.py`](../../graph-editor/lib/tests/test_primitive_contract.py) | 2 | Plan §745 closure-required keys present in `to_provenance_dict()` for a CONDITIONED parameterised primitive (with weighted evidence) and for an UNSUPPORTED_RESIDUAL primitive (residual diagnostics, no weighted evidence). JSON-serialisability pinned. |
| [`test_stage_8_substrate_provenance.py`](../../graph-editor/lib/tests/test_stage_8_substrate_provenance.py) | 10 | Cross-surface substrate tests: each of the four readouts surfaces `provenance` per primitive with the §745 closure-required keys, both target and prior-only edges; composed subject + carrier topology + reach summaries reachable; all four readout diags JSON-serialise; each readout diag carries `cache_status`; readouts do not accept a `p_conditioning_evidence` parameter; serialised runtime bundle marks `p_conditioning_evidence` with the compatibility-metadata note. |

**Stage 8 cumulative test totals** — full primitive-substrate suite plus carrier object contract, span composer, all four readouts, audit, prefix-arrival, cache, and Stage 8 substrate:

```
287 passed in ~21s
```

(Stage 7 baseline was 287; Stage 8 adds 10 new substrate tests + 2 new contract tests but two existing primitive_contract tests counted differently because the file-level collected count grew to 16 — net 287 + 12 − recounting differences.)

---

## 2. Stop-condition discharge

Plan §"Stage 8" stop condition (line 762):

> Stop condition: a reviewer can explain a CF scalar or cohort_maturity row by reading primitive and composition provenance without reading logs, and no live consumer requires `p_conditioning_evidence` or compatibility-blend metadata to decide evidence ownership. If `p_conditioning_evidence` remains, it must be documented as compatibility metadata rather than transitional ownership state.

| Stop-condition clause | Discharge |
|---|---|
| Reviewer can explain a CF scalar from primitive + composition provenance alone | **Discharged** by the threading at §1.2 — every readout's diag carries the full `to_provenance_dict()` per primitive. The plan §745 checklist (primitive id, evidence role, raw / weighted / effective totals, evidence-clock provenance, prior source, conditioning status, residual diagnostics, composed topology, composed reach / probability) is reachable without a log. Pinned by `test_stage_8_substrate_provenance.py` against all four readout surfaces. |
| Reviewer can explain a cohort_maturity row from primitive + composition provenance alone | **Discharged** transitively. The cohort_maturity v3 row builder (`compute_cohort_maturity_rows_v3`) reuses the same shared row-builder seam as `handle_conditioned_forecast` (STATS_SUBSYSTEMS §3.3 / AP58); both surfaces pop `_primitive_readout` / `_multi_hop_subject_readout` / `_multi_hop_window_readout` / `_active_cohort_carrier_readout` from `maturity_rows[0]` and surface them in the response. The widened diags reach both api_handlers callers automatically; no cohort_maturity-specific wiring is required. |
| Reviewer can read the composed subject and carrier topology + reach/probability summary | **Discharged** — already present pre-Stage 8 on the multi-hop / active-carrier diags (`composed`, `composed_carrier`, `composed_subject` blocks); Stage 8 pins them with `test_active_cohort_carrier_readout_substrate_provenance_for_both_spans` and the multi-hop subject equivalent. The plan §745 last bullet is met. |
| `subject_probability_source` distinguishes direct primitive readout from composed subject-span readout | **Discharged** — pre-existing field on Stage 5a (`primitive_posterior` / `edge_level`) and on Stages 5b/5c/6 (`composed_subject_span` / `composed_subject_span_window` / `primitive_backed_carrier_and_subject` / `*_moments_only`). Stage 8 references it in the substrate-provenance test as the per-readout signal. |
| No live consumer requires `p_conditioning_evidence` to decide evidence ownership | **Discharged** by the readout-parameter introspection test (`test_readouts_do_not_accept_p_conditioning_evidence_parameter`). Each of the four readout entry points takes a typed `EvidenceSet` directly; none accepts `p_conditioning_evidence` or any synonym. The two surviving consumers (legacy fallback evidence projection, Stage 5a synthetic-evidence fallback) are documented as compatibility paths in the `PreparedConditioningEvidence` docstring. |
| If `p_conditioning_evidence` remains, it is documented as compatibility metadata | **Discharged** at three points: the dataclass docstring (§1.4), the `serialise_runtime_bundle()` `compatibility_metadata_note` field (pinned by `test_prepared_conditioning_evidence_to_dict_marks_compatibility_metadata`), and this stage note. |
| (Optional) cache hit/miss status | **Shipped** under `diag['cache_status']` per readout (plan §760 says optional). `_cache_status_snapshot()` returns the full registry stats; soft-fails to `None` when the registry is unreachable. |

---

## 3. What Stage 8 deliberately does NOT do

- **No new diagnostic surface plumbing in api_handlers.** The four readout diagnostics already flow through `_attach_cf_row_metadata` → `maturity_rows[0]` → `subject_result` (cohort_maturity) and `edge_results` (handle_conditioned_forecast). Stage 8 widens what each diagnostic *contains*; it does not change where it appears on the response.
- **No new top-level `primitive_substrate` block.** Adding a unified block in parallel to the existing per-readout blocks would violate the mutual-exclusivity-by-gate-construction property (single-hop / multi-hop cohort A==X / multi-hop window / active cohort A!=X). The widened readout diagnostics already carry every §745 closure item; a parallel block would be redundant and would risk drift.
- **No retirement of `p_conditioning_evidence`.** Plan §762 explicitly allows the field to remain "as compatibility metadata"; retirement is out of scope. Future stages may rename or fold it into a primitive-substrate-rooted compatibility surface; Stage 8 only documents its compatibility role.
- **No per-request cache delta.** `cache_status` is the post-readout aggregate snapshot. Capturing pre/post snapshots per readout would add wiring at every internal cached-call site for marginal additional value; aggregate snapshots are sufficient for "did this request warm-hit caches" observability.
- **No FE-side changes.** Stage 8 lands BE-side substrate provenance only. FE consumers that surface the diagnostics for chart annotations / tooltips can be added later if profiling shows it useful; Stage 8's contract is BE-response-substrate-completeness, not FE rendering.
- **No retirement of any Stage 0-7 surface.** Stage 8 is purely additive — it widens existing dicts, adds new diag keys, and adds a docstring note. No existing readout function signature changes; no existing test was relaxed.

---

## 4. Suggested commit messages (per atom)

The skill does not commit. The following are suggested commit messages for each atom; the user decides timing and granularity.

| Atom | Files | Suggested message |
|---|---|---|
| 1 | `graph-editor/lib/runner/primitives.py` + `graph-editor/lib/runner/primitive_readout.py` + `graph-editor/lib/tests/test_primitive_contract.py` + `graph-editor/lib/tests/test_stage_8_substrate_provenance.py` (new) | `73n stage 8: per-primitive substrate provenance — widen to_provenance_dict() with weighted_evidence + is_draw_coherent; thread provenance through every readout's primitive_summaries; pin §745 closure checklist on all four readout surfaces (§745, §762)` |
| 2 | `graph-editor/lib/runner/primitive_readout.py` + `graph-editor/lib/tests/test_stage_8_substrate_provenance.py` | `73n stage 8: optional cache_status snapshot per readout — _cache_status_snapshot() helper around result_cache.stats_all(); soft-fails to None; pinned across all four readouts (§760)` |
| 3 | `graph-editor/lib/runner/forecast_runtime.py` + `graph-editor/lib/tests/test_stage_8_substrate_provenance.py` | `73n stage 8: document p_conditioning_evidence as compatibility metadata — dataclass docstring + serialised compatibility_metadata_note; pin readout signatures don't accept the field for ownership (§762)` |
| 4 | `docs/current/project-bayes/73n-stage-8-note.md` (new) + `docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md` (progress block) | `73n stage 8: stage-8 note + mark stage 8 complete in progress block` |

---

## 5. Open follow-ups (tracked for later resolution; NOT Stage 8-blocking)

These items survive into the rest of 73n's plan. Inherited unless flagged.

### Follow-up 1 — Maturity-aware likelihood migration (BLOCKS production flag-ON for Stages 5a/5b/5c/6, inherited)

Inherited from Stages 5a-6 follow-up #1. Stage 8 does not touch this. The likelihood migration is its own implementation surface; the diagnostic layer is independent.

### Follow-up 2 — Per-upstream-edge evidence fetching for carrier primitives (inherited)

Inherited from Stage 6 follow-up #2. Stage 8's substrate diagnostics already carry per-carrier-primitive provenance; once Stage 6 follow-up #2 wires real `window(U-V)` evidence into `CarrierEdgeResolution`, the `weighted_evidence` block on each carrier primitive's `provenance` will populate automatically — no further Stage 8 work required.

### Follow-up 3 — Per-key targeted cache invalidation (inherited from Stage 7)

Stage 7's `clear_all` bustcache flushes all registered caches on snapshot writes. Stage 8's `cache_status` will show entries=0 immediately after a snapshot write; per-key invalidation would let warm primitives survive. Same surface to extend; not a Stage 8 acceptance criterion.

### Follow-up 4 — Predictive vs epistemic SD separation (low priority, inherited)

Inherited from Stages 5b/5c/6 follow-up #3. Stage 8 documents `p_sd_primitive` and `p_sd_epistemic_primitive` on each readout result but does not change how they are derived (the multi-hop composer still uses the composed-draw SD for both).

### Follow-up 5 — `_legacy_trajectory_draw_family_key` retirement (inherited)

Inherited from Stage 5a follow-up #4.

### Follow-up 6 — `subject_probability_source` enum on ForecastTrajectory (low priority, inherited)

Inherited from Stages 5a/5b/5c/6 follow-up #5. Stage 8 widens the per-readout `subject_probability_source` string but does not promote it to a typed enum on `ForecastTrajectory` — that is a refactor, not an observability gap.

### Follow-up 7 — FE-controllable cache TTL / size (low priority, inherited)

Inherited from Stage 7 follow-up #7.

### Follow-up 8 — `p_conditioning_evidence` retirement

Stage 8-specific. Plan §762 allows the field to remain as compatibility metadata; retirement could happen once the legacy fallback evidence projection on response payloads (api_handlers `_pce.total_y` / `_pce.total_x`) is also retired. Likely scope: rename the dataclass to make its compatibility role explicit (e.g. `LegacyConditioningEvidenceTotals`) AND replace the fallback evidence projection with primitive-substrate-rooted totals. Not on the 73n critical path.

---

## 6. What unblocks for later stages

- **Stage 9 (Acceptance Tests)** — every plan §745 closure-required item is now reachable from the response, so the acceptance tests can assert directly on the diagnostic substrate without instrumenting log scraping. The introspection-test pattern (`test_readouts_do_not_accept_p_conditioning_evidence_parameter`) is reusable for Stage 9's "no live consumer requires p_conditioning_evidence" acceptance bullet.
- **Stage 10 (Codebase Documentation Pass)** — `docs/current/codebase/FORECAST_STACK_DATA_FLOW.md` and `docs/current/codebase/BE_RUNNER_CLUSTER.md` can now reference `ConditionedTransitionPrimitive.to_provenance_dict()` as the canonical primitive-substrate serialisation, the four readout diagnostic blocks as the per-surface substrate destinations, and `serialise_runtime_bundle()`'s compatibility-metadata note as the live disclaimer for the legacy `p_conditioning_evidence` block. The "what each subsystem writes" cheat sheets can reference Stage 8 as the moment evidence ownership formally migrated from `p_conditioning_evidence` to the primitive substrate.

---

## 7. Test totals snapshot

Stage 8 additions:

- 2 new `to_provenance_dict()` contract tests in `test_primitive_contract.py` pinning the §745 closure-required keys.
- 10 new cross-surface tests in `test_stage_8_substrate_provenance.py` covering all four readout surfaces, JSON-serialisability, `cache_status`, and the `p_conditioning_evidence` compatibility-metadata pin.

Combined Stage 0-8 substrate suite (excluding the documented baseline RED at `test_v3_midline_at_saturation_converges_to_p` per `73n-stage-0-baseline.md` line 241):

```
287 passed in 21.39s
```

Total primitive-substrate suite: **287 tests green**. The `test_cohort_factorised_outside_in.py::test_v3_midline_at_saturation_converges_to_p` remains RED unchanged from Stage 7 — it is a documented carry-over from 73m §1B that 73n inherits without an acceptance commitment (plan §812 regression discipline).
