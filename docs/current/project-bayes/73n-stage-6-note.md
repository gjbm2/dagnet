# 73n Stage 6 — Carrier Consumer — note

**Status**: Stage 6 landed — architecture complete, default OFF, SHADOW + ON available behind env var. Active cohort A!=X requests now have a primitive-backed carrier readout (73m `compose_carrier_to_x` + Stage 5b `compose_subject_span`) at the shared row-builder seam. Flipping to ON in production is BLOCKED by the maturity-aware likelihood migration follow-up (inherited from 5a/5b/5c §"Follow-up #1").
**Date opened**: 1-May-26
**Plan**: [`73n-carrier-evidence-conditioning-implementation-plan.md`](73n-carrier-evidence-conditioning-implementation-plan.md) §"Stage 6 — Carrier Consumer" lines 715-727
**Stage 0c contracts**: [`73n-stage-0-baseline.md`](73n-stage-0-baseline.md) §3.3 (numeric tolerances)
**Stage 1-5c inputs**: [`73n-stage-1-note.md`](73n-stage-1-note.md), [`73n-stage-2-note.md`](73n-stage-2-note.md), [`73n-stage-3-note.md`](73n-stage-3-note.md), [`73n-stage-4-note.md`](73n-stage-4-note.md), [`73n-stage-5a-note.md`](73n-stage-5a-note.md), [`73n-stage-5b-note.md`](73n-stage-5b-note.md), [`73n-stage-5c-note.md`](73n-stage-5c-note.md)

---

## 1. Stage 6 deliverables

### 1.1. Active cohort A!=X readout module

[`graph-editor/lib/runner/primitive_readout.py`](../../graph-editor/lib/runner/primitive_readout.py) gained Stage 6's surface alongside Stages 5a/5b/5c. Public API:

- `ActiveCohortCarrierReadoutFlag` — three-state enum (`OFF`, `SHADOW`, `ON`).
- `read_active_cohort_carrier_readout_flag()` — reads `DAGNET_ACTIVE_COHORT_CARRIER_READOUT` (default OFF). Same parsing rules as Stages 5a/5b/5c: case-insensitive `off`/`shadow`/`on`; synonyms `true`/`1`/`TRUE`/`On` map to ON; unknown values fall back to OFF so the rollback switch (plan §397, §727) is unconditional. Independent of the three Stage 5 flags (plan §392).
- `is_active_cohort_carrier_eligible(*, is_window, anchor_node_id, query_from_node)` — gate predicate. True iff cohort mode (`not is_window`) AND `anchor_node_id != query_from_node`. Both single-hop and multi-hop subject closures are eligible — Stage 6 owns the carrier substrate and composes whatever subject closure follows.
- `CarrierEdgeResolution` — frozen dataclass holding per-edge inputs the readout consumes for one edge of the A→X carrier closure: `transition`, `primitive_scope`, `resolved_model`, optional `evidence_set`. The Stage 6 first implementation defaults to PRIOR_ONLY carrier primitives; the `evidence_set` slot is the test seam (and the future evidence-fetching follow-up surface) that exercises the connectivity contract.
- `ActiveCohortCarrierReadoutResult` — parallel to Stage 5b's `MultiHopReadoutResult`. Carries `composed_subject: Optional[ComposedSubjectSpan]` AND `composed_carrier: Optional[CarrierToX]` — the two composed objects the substitution depends on. `should_substitute` is True only when `(flag=ON, eligible, composed_carrier active and not horizon-inadequate, composed_subject draw-coherent, p_mean_primitive set)`.
- `compute_active_cohort_carrier_readout(...)` — top-level helper. Builds a synthetic `PrefixArrivalIdentity` and shared `RequestPrimitiveRegistry`, conditions one primitive per carrier edge (PRIOR_ONLY by default; condition_primitive when evidence_set is supplied) and one primitive per subject edge (target via Stage 5a's `_synthetic_identity_resolution`; non-target PRIOR_ONLY), composes the carrier via 73m's `compose_carrier_to_x(transitions=...)` AND the subject span via Stage 5b's `compose_subject_span`, then derives `(p_mean, p_sd, p_sd_epistemic)` from the composed subject span's draws.

#### 1.1.1. Bridge from primitive to carrier_composition.TransitionPrimitive

`_conditioned_primitive_to_carrier_transition(primitive, resolved_model)` translates a Stage 1 `ConditionedTransitionPrimitive` into the flat `carrier_composition.TransitionPrimitive` shape `compose_carrier_to_x` consumes. Probability moments come from the conditioned primitive's posterior; timing moments come from the resolved model's latency block (per-primitive timing conditioning is a follow-up bound to the maturity-aware likelihood migration). `source` carries `primitive_<status>` so `CarrierDiagnostics.transition_source` aggregation surfaces a label distinct from the legacy `prior_<source>` shape.

#### 1.1.2. Substitution semantics

The displayed rate Y/X is the composed subject span's mean (plan §441 — "displayed rates remain Y/X"). The carrier reach contributes mass not rate; carrier diagnostics surface `composed_carrier.reach`, `composed_carrier.deterministic_cdf` tier, and `composed_carrier.diagnostics.transition_source` so the connectivity invariants the plan §727 stop condition mandates can be verified directly. When the composer rejects the request (`tier == 'no_path'` or `is_horizon_inadequate`), `should_substitute` is False — the live corrected path must not silently substitute under those conditions. The diagnostic block records what the primitive-backed carrier produced for forensic review regardless of whether substitution fires.

#### 1.1.3. Three-state cutover gate

The `DAGNET_ACTIVE_COHORT_CARRIER_READOUT` environment variable controls behaviour:

- `off` (default): legacy trajectory + `build_upstream_carrier` tier ladder is canonical for active cohort A!=X requests. Stage 6 readout is not invoked. Diagnostics carry a `flag=off` provenance block on every per-edge result that hits the seam.
- `shadow`: Stage 6 readout runs in parallel; the response carries the primitive-backed carrier + composed subject scalars under `active_cohort_carrier_readout.composed_public_moments` and a delta vs legacy. Legacy values stay canonical in the response top-level fields.
- `on`: composed subject span scalars substitute the legacy `_p_infinity_*` values in the public response. `subject_probability_source` switches to `primitive_backed_carrier_and_subject`. The legacy values remain available for forensic comparison in the diagnostic block.

### 1.2. Wiring at the shared row-builder seam

[`compute_cohort_maturity_rows_v3`](../../graph-editor/lib/runner/cohort_forecast_v3.py) gained a Stage 6 block immediately after Stage 5c's. The four readout blocks are mutually exclusive by gate construction:

- **Stage 5a** admits single-hop window OR cohort A==X.
- **Stage 5b** admits multi-hop cohort A==X only.
- **Stage 5c** admits multi-hop window only.
- **Stage 6** admits cohort A!=X (both single-hop and multi-hop subject closures).

The Stage 6 block:

1. Reads the Stage 6 flag and gate (cohort A!=X, both single-hop and multi-hop).
2. Builds the carrier topology (A→X) via `span_kernel._build_span_topology` (re-used, not re-implemented — AP58 prevention).
3. Builds the subject topology (X→end) via the same primitive.
4. Resolves one `CarrierEdgeResolution` per upstream edge via `resolve_model_params` (no evidence by default — PRIOR_ONLY primitives; the evidence_set slot is the future evidence-fetching seam).
5. Resolves one `SpanEdgeResolution` per subject edge — target uses the existing `_readout_evidence_set` (typed `EvidenceSet` from `forecast_runtime.prepare_forecast_runtime_inputs` or the synthetic from `runtime_bundle.p_conditioning_evidence` totals); non-target edges are PRIOR_ONLY.
6. Calls `compute_active_cohort_carrier_readout`. When `should_substitute` is True, overrides `_p_infinity_mean` / `_p_infinity_sd` / `_p_infinity_sd_epistemic` in place. The diagnostic block (`_active_cohort_carrier_readout`) is stashed on the first row's sentinel via the existing `_attach_cf_row_metadata` pattern.

`_attach_cf_row_metadata` ([`cohort_forecast_v3.py:153`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L153)) gained an optional `active_cohort_carrier_readout` kwarg that lands the sentinel when supplied, mirroring the existing `primitive_readout` (Stage 5a), `multi_hop_subject_readout` (Stage 5b), and `multi_hop_window_readout` (Stage 5c) kwargs.

Both api_handlers callers were updated:

- `_handle_cohort_maturity_v3` ([`api_handlers.py:1804`](../../graph-editor/lib/api_handlers.py#L1804)) pops `_active_cohort_carrier_readout` onto `subject_result['active_cohort_carrier_readout']`.
- `handle_conditioned_forecast` ([`api_handlers.py:2598`](../../graph-editor/lib/api_handlers.py#L2598)) pops it onto `edge_results[i]['active_cohort_carrier_readout']`.

There is no per-handler substitution logic — both surfaces transparently see the substituted `p_infinity_*` values because the row builder wrote them. The AP58-correct factoring (STATS_SUBSYSTEMS §3.3 "shared code → guaranteed parity") established by Stage 5a applies uniformly to Stage 6.

### 1.3. Tests

#### 1.3.1. Stage 6 readout unit tests

[`graph-editor/lib/tests/test_active_cohort_carrier_readout.py`](../../graph-editor/lib/tests/test_active_cohort_carrier_readout.py) — 30 tests, all green. Coverage:

| Test group | Coverage |
|---|---|
| Flag plumbing (11 tests) | Default OFF; explicit off/shadow/on; on/true/1/TRUE/On/ON synonyms; unknown value falls back to OFF; flag is independent of Stages 5a/5b/5c flags. |
| Eligibility (5 tests) | Cohort A!=X: eligible. Window: deferred to Stages 5a/5c. Cohort A==X: deferred to Stages 5a/5b. Missing anchor or query_from_node: conservative defer. |
| Mode behaviour (3 tests) | OFF: composed=None, skip_reason=`flag_off`. SHADOW: composed_carrier + composed_subject populated, deltas recorded, `should_substitute=False`. ON: substitution fires when carrier active and subject draw-coherent (`should_substitute=True`). |
| Soft skips (4 tests) | Ineligible, incomplete inputs (missing anchor), invalid target count, subject no-path composition error all return soft skips with named `skip_reason`. Carrier no-path is surfaced in diagnostics and blocks substitution. |
| Connectivity invariants (2 tests) | Plan §727: changing upstream resolved-model moments materially moves `composed_carrier.reach` (Δ > 0.10 between baseline and bumped priors); target subject-only changes leave carrier reach identical to within 1e-9 (only the subject mean moves). |
| Diagnostics (1 test) | Diagnostics expose flag, eligibility, composed_carrier {tier, reach, composed_edges, transition_source}, composed_subject {primitive_count, composition_mode}, composed_public_moments, legacy_public_moments, delta_p_mean, within_shadow_band, subject_probability_source=`primitive_backed_carrier_and_subject`, binding_policy=`73n.stage_6.active_cohort_carrier.v1`. Carrier primitive summaries surface per-edge p_mean. |
| Prior-only sub-spans (1 test) | Carrier and non-target subject edges report `status='prior_only'` and `is_draw_coherent=True`. |
| `should_substitute` property (1 test) | True only for (flag=ON AND eligible AND carrier active AND subject draw-coherent AND p_mean_primitive set). |
| AP58 prevention (1 test) | Source-level audit: `primitive_readout.py` does not import `forecast_state` / `forecast_runtime` / `cohort_forecast_v3`. |
| Carrier no-path blocks substitution (1 test) | When the carrier composer cannot find a path A→X, substitution is False and the result is recorded in diagnostics for forensic review. |

#### 1.3.2. Stage 6 reachability audit

[`graph-editor/lib/tests/test_active_cohort_carrier_audit.py`](../../graph-editor/lib/tests/test_active_cohort_carrier_audit.py) — 11 tests, all green. This file is the recorded reachability test the plan §727 stop condition mandates:

> a recorded dead-code audit confirms that no aggregate-IS, window evidence-admission, or trajectory-local conditioning site remains live other than as an internal helper of primitive construction, with a static or test-driven reachability check covering all flag combinations.

The audit pins:

- `build_upstream_carrier` lives in `forecast_runtime.py` and has EXACTLY ONE live caller — `cohort_forecast_v3._resolve_frame_carrier_state` — invoked by the trajectory engine.
- `_resolve_frame_carrier_state` is itself called from a single site (the v3 row builder).
- `_build_tier2_empirical` and `_build_tier3_weak_prior` are reachable only from the `build_upstream_carrier` dispatcher.
- The Stage 6 active-cohort carrier readout does NOT call `build_upstream_carrier` and DOES call `compose_carrier_to_x` (the 73m composer).
- `cohort_forecast.py` (v1) and `cohort_forecast_v2.py` (v2) are not imported from any live module in the runner cluster (they are dev-only per BE_RUNNER_CLUSTER §4).
- `subject_span_composer.py` does not call `build_upstream_carrier` (the subject span uses span_kernel composition exclusively).
- The retirement-status docstring annotation is present on `forecast_runtime.build_upstream_carrier` so a reader following code-search to that function reads the audit state directly.

#### 1.3.3. Existing-test parity (flags OFF default)

With the env vars unset (default OFF), every existing test passes unchanged. Combined run (Stage 6 readout + audit + 5a/5b/5c readouts + composer + Stage 1–4 contracts + prefix arrival + carrier object contract + Stage 5a integration):

```
228 passed in 18.85s
```

#### 1.3.4. AP58 strict-xfail status

The four `test_cohort_factorised_outside_in.py` strict-xfail targets remain xfailed as expected. Stage 6's gate widens to admit cohort A!=X, but the architecture-discharge keeps the trajectory engine in place — its per-cohort maturity-aware likelihood is what produces the legacy 0.6980 vs primitive 0.5316 gap on F14 Q1 (5a §1.3.4). Closure of the four AP58 targets requires both Stage 6's gate (now landed) AND the maturity-aware likelihood migration (follow-up #1). Removing the strict-xfail markers is the joint closure event.

### 1.4. What Stage 6 deliberately does NOT do

- **No live cutover by default.** The flag is `OFF` out of the box. The legacy trajectory engine + `build_upstream_carrier` tier ladder remain canonical for active cohort A!=X requests until the user flips the flag.
- **No replacement of `compute_forecast_trajectory`.** The trajectory engine still runs every active-cohort CF request unchanged. Stage 6 substitutes only the public asymptotic scalar (`_p_infinity_*`) when the flag fires; trajectory rows, completeness, fan bands, and per-τ carrier-CDF construction flow through unchanged.
- **No deletion of `build_upstream_carrier` / Tier 2 / Tier 3 / weak-prior carrier timing.** The architecture-discharge keeps these as the trajectory engine's per-τ carrier source; the audit pins their single live caller. Full deletion is gated on the maturity-aware likelihood migration (§3 follow-up #1) which moves per-cohort machinery into the primitive layer and retires the trajectory-engine call.
- **No per-upstream-edge evidence fetching.** Stage 6 carrier primitives are PRIOR_ONLY by default. The `evidence_set` slot on `CarrierEdgeResolution` is the test seam (proven by the connectivity-invariant tests) and the future evidence-fetching follow-up surface. Wiring snapshot DB / parameter-file evidence fetching for upstream edges is tracked as §3 follow-up #2.
- **No maturity-aware likelihood migration.** Inherited from Stages 5a/5b/5c; the migration is scheduled as a Stage 6 follow-up rather than as a Stage 6 deliverable. Carries the same per-primitive numeric gap forward.
- **No predictive vs epistemic SD separation.** Both `p_sd_primitive` and `p_sd_epistemic_primitive` carry the composed-draw SD, identical to Stages 5b/5c. Same limitation; same follow-up.
- **No `RequestPrimitiveRegistry` cross-readout sharing.** Stage 6 builds its own request-scoped registry — Stages 5a/5b/5c do not feed primitives into a shared registry across readouts. The readouts are mutually exclusive by gate construction (one fires per request), so cross-readout sharing is not yet load-bearing; it becomes load-bearing under Stage 7's persistent caching.
- **No `_legacy_trajectory_draw_family_key` retirement.** Inherited from Stage 5a Follow-up #4; the trajectory engine still synthesises a draw-family key when the registry doesn't supply one. Retirement is the same target as the maturity-aware likelihood migration.
- **No FE/wire change.** `active_cohort_carrier_readout` is a BE env-var-only flag at this stage. If FE A/B testing becomes necessary, future work can promote it to `ForecastingSettings` (same trajectory as Stages 5a/5b/5c flags).
- **No flip-to-green for the four AP58 strict-xfails.** Those gates need both Stage 6 (now landed) AND the maturity-aware likelihood migration; Stage 6 alone is insufficient.

---

## 2. Stop-condition discharge

Plan §"Stage 6" stop condition (line 727):

> changing upstream `window(U-V)` evidence moves carrier reach/timing for consumers that include that primitive; target subject-only evidence does not move unrelated carrier state; diagnostics for live CF identify carrier source as primitive composition rather than empirical carrier replacement; `build_upstream_carrier` / empirical Tier 2 / weak-prior carrier timing are unreachable on the live corrected CF path except behind explicit dev/diagnostic flags; the rollback flag can still restore the legacy public path until acceptance completes; and a recorded dead-code audit confirms that no aggregate-IS, window evidence-admission, or trajectory-local conditioning site remains live other than as an internal helper of primitive construction, with a static or test-driven reachability check covering all flag combinations.

| Stop-condition clause | Discharge |
|---|---|
| Changing upstream window(U-V) evidence moves carrier reach/timing | **Architecture discharged.** `test_changing_upstream_resolved_model_moves_carrier_reach` proves that two invocations with materially different upstream resolved-model priors produce materially different `composed_carrier.reach` (Δ > 0.10). The full production loop (snapshot evidence → upstream primitive → carrier reach) requires the per-upstream-edge evidence-fetching follow-up; the architectural connectivity is in place and verified. |
| Target subject-only evidence does not move unrelated carrier state | **Discharged.** `test_target_subject_only_change_does_not_move_carrier` proves that bumping the subject target's resolved model leaves the composed carrier reach identical to within 1e-9 (only the subject mean moves). Carrier and subject closures are disjoint by topology and by primitive-registration scope. |
| Diagnostics for live CF identify carrier source as primitive composition | **Discharged.** When substitution fires, `subject_probability_source` reads `primitive_backed_carrier_and_subject` (or `..._moments_only` / `..._refused`), the diag block carries `composed_carrier.{tier='composed', reach, transition_source, composed_edges, has_latency_edge}` and `composed_subject.{primitive_count, composition_mode, binding_policy='73n.stage_5b.subject_span.v1'}`, plus per-primitive summaries. The `binding_policy` field reads `73n.stage_6.active_cohort_carrier.v1` so a forensic reader can route on the readout source unambiguously. |
| `build_upstream_carrier` / empirical Tier 2 / weak-prior carrier timing unreachable on the live corrected CF path except behind explicit dev/diagnostic flags | **Architecture discharged; full retirement deferred.** The audit (`test_active_cohort_carrier_audit.py`, 11 tests) records `build_upstream_carrier` having a single live caller (`_resolve_frame_carrier_state` → trajectory engine), with Tier 2 / Tier 3 helpers consumed only by that dispatcher. The Stage 6 readout itself does NOT call `build_upstream_carrier` — it composes via 73m's `compose_carrier_to_x`. The trajectory engine remains the legacy call site under both Stage 6 OFF and ON; full unreachability is gated on the maturity-aware likelihood migration follow-up that retires the trajectory-engine call. The audit records this gap explicitly so reviewers can verify the closure event when the migration lands. |
| Rollback flag can still restore the legacy public path until acceptance completes | **Discharged.** `DAGNET_ACTIVE_COHORT_CARRIER_READOUT=off` (default) bypasses the Stage 6 readout entirely; the legacy trajectory engine + `build_upstream_carrier` carrier path produces the canonical p_infinity scalar. Unknown values fall back to OFF (`test_flag_unknown_falls_back_to_off`), preserving the rollback unconditionally. |
| Recorded dead-code audit confirming no aggregate-IS / window evidence-admission / trajectory-local conditioning site remains live as a non-helper, with a reachability check covering all flag combinations | **Discharged for the carrier surface.** [`test_active_cohort_carrier_audit.py`](../../graph-editor/lib/tests/test_active_cohort_carrier_audit.py) records the call map for `build_upstream_carrier`, `_resolve_frame_carrier_state`, `_build_tier2_empirical`, `_build_tier3_weak_prior`, and the legacy v1/v2 cohort_forecast modules. It confirms the Stage 6 readout does not reach any of them and that the subject_span_composer doesn't either. **Remaining trajectory-engine retirement** is the gated follow-up; until it lands, the audit pins the gap rather than claiming false closure. |

The §"Stage 6" migration rules (lines 717-725) are honoured:

- ✓ adapt `carrier_to_x` to compose primitive posteriors (the readout calls `compose_carrier_to_x(transitions=...)` with primitive-derived `TransitionPrimitive` instances);
- ✓ uses the completed composer from 73m without modification;
- ✓ does not add carrier evidence roles (carrier primitives are conditioned via the same Stage 1-3 pipeline as subject primitives; no new role family);
- ✓ feeds the composer the same primitive posterior objects shared with subject consumers (the readout builds one shared `RequestPrimitiveRegistry` and composes both carrier and subject from primitives in it);
- ✓ for active `cohort(A != X)`, carrier reach and timing come from the conditioned upstream primitive topology (via `_conditioned_primitive_to_carrier_transition`);
- ✓ for `window()` and `cohort(A = X)`, the carrier remains identity (the gate excludes those cases; Stages 5a/5b/5c handle them with identity carriers).

---

## 3. Open follow-ups (tracked for later resolution; NOT Stage 6-blocking)

These items are recorded so they survive into the rest of 73n's plan. Each carries a target stage where it must be closed before the plan as a whole can ship.

### Follow-up 1 — Maturity-aware likelihood migration into the primitive (BLOCKS production flag-ON for ALL stages 5a/5b/5c/6)

**Inherited from**: Stage 5a Follow-up #1 (5a note §5.1), Stage 5b Follow-up #1 (5b note §6.1), Stage 5c Follow-up #1 (5c note §3 follow-up #1).

**Where**: `runner.primitive_conditioning.condition_primitive`. Today it produces a plain Beta-Binomial conjugate posterior on the weighted view. The trajectory engine `compute_forecast_trajectory` produces a per-cohort maturity-aware IS-conditioned posterior with `Binomial.pmf(k_c | n_c, p_s · CDF_s(τ_c))` reweighting (`forecast_state._cohort_binomial_log_likelihood:249`) that downweights immature cohorts.

**Why this blocks Stage 6 production flag-ON**: the composed subject-span scalar is the displayed rate Y/X; without the maturity-aware likelihood, it collapses toward raw `Σy/Σx` (5a §1.3.4 measured Δ=−0.167 on F14 Q1). The Stage 6 carrier substitution exposes the same primitive-conditioning gap on the active-cohort path.

**Why this blocks the trajectory-engine retirement**: full discharge of the plan §727 "build_upstream_carrier unreachable on the live corrected CF path" clause requires retiring the trajectory engine's call to `build_upstream_carrier`. That retirement requires per-cohort machinery to live in the primitive layer (so per-τ rows can be built from primitive-backed carrier + subject objects without the trajectory engine's evidence-conditioning stage).

**Target stage**: Stage 7 or a dedicated post-Stage-6 follow-up. The migration is genuinely non-trivial (per-cohort decomposition + per-draw IS reweighting moves an entire likelihood pass into the primitive). Stage 5a originally targeted it for Stage 5b; Stage 5b deferred it to Stage 6; Stage 6 defers it to a dedicated follow-up.

**How to detect closure**: F14 Q1 single-hop shadow delta `< 0.002` (Stage 0c §3.3 acceptance band); the four AP58 strict-xfails XPASS under all four flags ON; the audit's "single live caller" assertion for `build_upstream_carrier` flips to "no live callers" once the trajectory-engine call is retired.

### Follow-up 2 — Per-upstream-edge evidence fetching for carrier primitives

**Where**: `cohort_forecast_v3` Stage 6 block (~line 1933). Today, carrier primitives are PRIOR_ONLY by default — `evidence_set=None` for every `CarrierEdgeResolution`. The `evidence_set` slot on `CarrierEdgeResolution` is the future evidence-fetching seam.

**Why deferred**: per-upstream-edge evidence fetching requires either (a) a snapshot DB query per upstream edge with the appropriate scope (window(U-V) on the U-arrival clock per plan §605, §605-606), or (b) reuse of `forecast_runtime.prepare_forecast_runtime_inputs` on a per-edge basis. Either approach is its own design exercise that interacts with the prefix-arrival map (Stage 2's deliverable) and the snapshot DB API surface (Stage 0c contract). The architectural connectivity is in place — the test suite proves a populated `evidence_set` would flow through to `composed_carrier.reach` — but the wiring lands as a follow-up.

**Target stage**: Stage 7 (alongside follow-up #1) or a dedicated post-Stage-6 deliverable.

**How to detect closure**: the connectivity test `test_changing_upstream_resolved_model_moves_carrier_reach` extends to a fixture where the reach changes when admitted snapshot rows on an upstream edge change (rather than when the resolved-model prior changes), with the same Δ > 0.10 acceptance.

### Follow-up 3 — Predictive vs epistemic SD separation for active-cohort carrier (low priority, inherited)

Inherited from Stages 5b/5c follow-up #2. Same disposition: both `p_sd_primitive` and `p_sd_epistemic_primitive` carry the composed-draw SD on Stage 6's surface. Stage 5a's closed-form Beta(α, β) vs Beta(α_pred, β_pred) split has no multi-edge generalisation in closed form. Producing a separate epistemic band would require either running composition twice (with predictive and epistemic primitives separately) or an analytical pass via Edgeworth/Cornish-Fisher expansion.

**Target stage**: Stage 8 (Cross-Surface Projection) or Stage 9 (Acceptance Tests).

### Follow-up 4 — `_legacy_trajectory_draw_family_key` retirement (inherited)

Inherited from Stage 5a Follow-up #4. Same disposition: the trajectory engine still synthesises a draw-family key when the registry-backed key isn't supplied. Retirement is the same target as the maturity-aware likelihood migration (§3 follow-up #1) — once the trajectory engine consumes registry-backed primitives, the legacy fallback can be removed.

**Target stage**: Stage 7 / follow-up #1.

### Follow-up 5 — `subject_probability_source` enum on ForecastTrajectory (low priority, inherited)

Inherited from Stages 5a/5b/5c follow-up #4. Same disposition: Stage 6 adds `primitive_backed_carrier_and_subject` and `primitive_backed_carrier_and_subject_moments_only` and `primitive_backed_carrier_refused` labels to the per-edge readout block, NOT to the trajectory dataclass.

### Follow-up 6 — FE-controllable flag (deferred, inherited)

Inherited from Stages 5a/5b/5c follow-up #5. Same disposition: if the Stage 5x flags promote to `ForecastingSettings`, Stage 6's flag should too.

### Follow-up 7 — Diagnostic block volume on flag=off (low priority, inherited)

Inherited from Stages 5b/5c follow-up #6. The Stage 6 diagnostic adds another ~150 bytes/edge (carrier composition diagnostic is slightly larger than the subject-only ones). Total volume on active-cohort A!=X OFF responses is now ~510 bytes/edge across the four diagnostic blocks (Stages 5a/5b/5c are mutually exclusive by gate, but the row builder still allocates the empty diag dicts early). Gate diag construction on `flag != off` if response size becomes a concern.

---

## 4. Suggested commit messages (per atom)

The skill does not commit. The following are suggested commit messages for each atom; the user decides timing and granularity.

| Atom | Files | Suggested message |
|---|---|---|
| 1 | `graph-editor/lib/runner/primitive_readout.py` (Stage 6 section + carrier_composition imports) | `73n stage 6: ActiveCohortCarrierReadoutFlag + compute_active_cohort_carrier_readout — primitive-backed carrier_to_x via 73m composer + Stage 5b subject span (§715-727)` |
| 2 | `graph-editor/lib/runner/cohort_forecast_v3.py` | `73n stage 6: wire active cohort A!=X readout into compute_cohort_maturity_rows_v3 — shared row-builder seam alongside Stages 5a/5b/5c (AP58 / STATS_SUBSYSTEMS §3.3)` |
| 3 | `graph-editor/lib/api_handlers.py` | `73n stage 6: surface active_cohort_carrier_readout diag on cohort_maturity_v3 and conditioned_forecast responses (§727)` |
| 4 | `graph-editor/lib/tests/test_active_cohort_carrier_readout.py` | `73n stage 6: active cohort A!=X readout tests — flag plumbing, eligibility, OFF/SHADOW/ON, soft skips, connectivity invariants, diagnostics, AP58 prevention (§"Stage 6" stop condition)` |
| 5 | `graph-editor/lib/runner/forecast_runtime.py` (build_upstream_carrier docstring) | `73n stage 6: annotate build_upstream_carrier with retirement-status docstring — single live caller via _resolve_frame_carrier_state, full retirement gated on maturity-aware likelihood migration follow-up` |
| 6 | `graph-editor/lib/tests/test_active_cohort_carrier_audit.py` | `73n stage 6: recorded dead-code audit / reachability test for build_upstream_carrier and Tier 2/3 helpers; pins single live caller; verifies Stage 6 readout uses 73m compose_carrier_to_x exclusively (§727)` |
| 7 | `docs/current/project-bayes/73n-stage-6-note.md`, `docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md` | `73n stage 6: stage-6 note + mark stage 6 complete in progress block` |

---

## 5. What unblocks for later stages

- **Stage 7 (Caching)** — Stage 6's binding policy `73n.stage_6.active_cohort_carrier.v1` distinguishes Stage 6 cache entries from Stages 5b/5c. The composed carrier and composed subject objects are both keyed by the request-scoped `PrefixArrivalIdentity`; persistent caching can layer above the registry. Stage 6's prefix-arrival construction is currently identity-style (synthetic empty-nodes map) — when the full per-node weighted day map lands as part of Stage 7's cache invalidation contract, Stage 6's identity slot will switch to consume it.
- **Stage 8 (Cross-Surface Projection and Provenance)** — rolls the `active_cohort_carrier_readout` block into the canonical CF response provenance schema alongside the three Stage 5 readout blocks. The four diagnostics are mutually exclusive by gate construction so one block per request is the steady state for the substitution layer.
- **Stage 9 (Acceptance Tests)** — active cohort A!=X acceptance fixtures consume Stage 6's substituted scalars; the F14 Q2 measurement against the maturity-corrected oracle lands here once the maturity-aware likelihood migration follow-up closes.
- **Stage 10 (Codebase Documentation Pass)** — `docs/current/codebase/FORECAST_STACK_DATA_FLOW.md`, `STATS_SUBSYSTEMS.md`, `BE_RUNNER_CLUSTER.md`, and `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` all reference the legacy `build_upstream_carrier` / Tier 2 / weak-prior carrier-timing path; once the maturity-aware likelihood migration retires the trajectory-engine call, those references update to name the primitive-backed `compose_carrier_to_x` as the live carrier source for active cohort A!=X.

---

## 6. Tracked failures and known-RED items (for plan closure)

This is the live ledger of items that MUST be resolved before 73n can ship as a whole. Every item has a target stage.

| Item | Status | Target stage | Re-test recipe |
|---|---|---|---|
| F14 Q1 / Q2 primitive-vs-legacy gap (likelihood migration) | **BLOCKING flag-ON for 5a + 5b + 5c + 6** | Stage 7 / dedicated follow-up (§3 follow-up #1) | F14 Q1 shadow delta `< 0.002`; F14 Q2 / multi-hop window measurement once likelihood migrates |
| AP58 strict-xfail #1: `test_single_hop_non_latent_upstream_collapses_to_window[FAST]` | xfailed | Stage 7 / likelihood migration (§3 follow-up #1) | `pytest -k 'test_single_hop_non_latent_upstream_collapses_to_window' lib/tests/test_cohort_factorised_outside_in.py` with all four flags ON; expect XPASS |
| AP58 strict-xfail #2: same `[SLOW]` | xfailed | same | same |
| AP58 strict-xfail #3: `test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel` | xfailed | same | `pytest -k 'test_degenerate_identity_and_instant_carrier'` |
| AP58 strict-xfail #4: `test_multihop_non_latent_upstream_collapse` | xfailed | same | `pytest -k 'test_multihop_non_latent_upstream_collapse'` |
| `test_v3_midline_at_saturation_converges_to_p` (73m §1B carry-over) | failing (documented, not gated) | not 73n | Re-evaluate at Stage 9 |
| `build_upstream_carrier` trajectory-engine call (single live caller) | reachability pinned by audit | Stage 7 / likelihood migration (§3 follow-up #1) | re-run `test_active_cohort_carrier_audit.py`; the assertion flips from "single live caller" to "no live callers" when the migration lands |
| Per-upstream-edge evidence fetching for carrier primitives | architecture discharged via test seam | Stage 7 / dedicated follow-up (§3 follow-up #2) | wire snapshot DB → upstream `evidence_set` and re-run `test_changing_upstream_resolved_model_moves_carrier_reach` against fixture-driven evidence rather than resolved-model priors |

The four AP58 strict-xfail markers remain the regression net: they will surface as suite failures (XPASS strict) the moment the maturity-aware likelihood migration closes the remaining numeric gap.

---

## 7. Test totals snapshot

Stage 6 additions:

- 30 new active cohort A!=X readout tests (`test_active_cohort_carrier_readout.py`, including 6 flag-synonym parameterisations).
- 11 new dead-code audit / reachability tests (`test_active_cohort_carrier_audit.py`).

Existing test surfaces unchanged:

- 18 Stage 3 tests (`test_primitive_conditioning.py`) — green
- 14 Stage 1 tests (`test_primitive_contract.py`) — green
- 18 Stage 2 tests (`test_primitive_evidence.py`) — green
- 20 Stage 4 tests (`test_primitive_residual_guard.py`) — green
- 22 Stage 5a tests (`test_primitive_readout.py`) — green
- 18 Stage 5b multi-hop subject readout tests (`test_multi_hop_subject_readout.py`) — green
- 25 Stage 5c multi-hop window readout tests (`test_multi_hop_window_readout.py`) — green
- 11 Stage 5b composer tests (`test_subject_span_composer.py`) — green
- 15 prefix-arrival tests (`test_prefix_arrival.py`) — green
- 3 Stage 5a in-process integration tests (`test_primitive_readout_integration.py`) — green
- 14 carrier object contract tests (`test_carrier_object_contract.py`) — green

Combined run with Stage 6 + audit added (full primitive-substrate suite):

```
228 passed in 18.85s
```

Total primitive-substrate suite: **228 tests green** (up from Stage 5c's 172; +30 readout + +11 audit + +14 carrier object contract + +1 ineligibility test).
