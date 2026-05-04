# 73n Stage 5b — Multi-Hop Subject Span Composition — note

**Status**: Stage 5b landed — architecture complete, default OFF, SHADOW + ON available behind env var. Flipping to ON in production blocked by the maturity-aware likelihood gap inherited from Stage 5a Follow-up #1; Stage 6 (carrier consumer) closes the remaining axis for the four AP58 strict-xfail targets.
**Date opened**: 1-May-26
**Plan**: [`73n-carrier-evidence-conditioning-implementation-plan.md`](73n-carrier-evidence-conditioning-implementation-plan.md) §"Stage 5b — Multi-Hop Subject Span Composition" lines 684-698
**Stage 0c contracts**: [`73n-stage-0-baseline.md`](73n-stage-0-baseline.md) §3.3 (numeric tolerances)
**Stage 1-5a inputs**: [`73n-stage-1-note.md`](73n-stage-1-note.md), [`73n-stage-2-note.md`](73n-stage-2-note.md), [`73n-stage-3-note.md`](73n-stage-3-note.md), [`73n-stage-4-note.md`](73n-stage-4-note.md), [`73n-stage-5a-note.md`](73n-stage-5a-note.md)

---

## 1. Stage 5b deliverables

### 1.1. Subject-span composer module

[`graph-editor/lib/runner/subject_span_composer.py`](../../graph-editor/lib/runner/subject_span_composer.py) is the single home for Stage 5b's multi-hop composition. It composes one `ComposedSubjectSpan` from a `RequestPrimitiveRegistry` of conditioned transition primitives along the X→end subject closure, using the existing doc-29b / `span_kernel` DAG algebra (serial convolution, parallel sums, joins, ordinary leakage). Public surface:

- `ComposedSubjectSpan` — frozen dataclass exposing composed reach (`span_p_*`) and conditional CDF (`cdf_*`), both as moments and (when every primitive is draw-coherent) as per-draw arrays. `is_draw_coherent` is the authoritative gate for draw-level consumption. `provenance` carries primitive summaries, composition mode (`draws` vs `moments`), refusal reasons, and the `73n.stage_5b.subject_span_composer.v1` binding policy.
- `ComposeOptions(max_tau, cdf_renorm_tolerance)` — knobs for the composer's grid and numerical tolerances.
- `CompositionError` — raised on hard contract violations (no path X→end, missing primitive for a topology edge, draw-count mismatch). Soft refusals (a primitive refuses to act as a coherent draw family) degrade to moments-only rather than raising.
- `compose_subject_span(*, graph, x_node_id, end_node_id, registry, edge_to_primitive_lookup, options)` — top-level composer entry point.

Critical invariants the module pins:

- No fallback to a terminal-edge primitive when more than one primitive is on the span (plan §696). The DP runs over every edge in the topology.
- Draw indices `s` are stable across primitives. The `RequestPrimitiveRegistry` enforces one primitive per `(transition, scope, prefix-arrival identity)`; the composer enforces draw-count agreement locally.
- If any primitive in the span is not draw-coherent (`MOMENTS_ONLY` / `DEGRADED` / `UNAVAILABLE` / `UNSUPPORTED_RESIDUAL`), the composed result drops to moments-only and `is_draw_coherent` is False (plan §591). Composition does NOT fabricate a coherent draw family.
- Probability and conditional timing are kept separate. Reach affects counts and denominator mass; it does NOT multiply displayed subject rates (plan §441).
- DP algebra is delegated to a forward DP that mirrors `span_kernel._run_dp` but takes per-edge density arrays directly — this lets primitives whose timing is non-parametric (Dirac-at-zero for non-latent, deterministic shift, or arbitrary CDF for latent) participate without per-draw `(p, mu, sigma, onset)` tuples.
- The module imports `span_kernel`, `primitives` (Stage 1), and `primitive_evidence` (Stage 2's registry). It does NOT import `forecast_runtime`, `forecast_state`, `cohort_forecast_v3`, or `carrier_composition` — AP58 prevention.

### 1.2. Stage 3 prior-only contract fix (prerequisite landed)

[`graph-editor/lib/runner/primitive_conditioning.py`](../../graph-editor/lib/runner/primitive_conditioning.py) `_make_prior_only_primitive` had a contract gap: it produced PRIOR_ONLY primitives with `probability_posterior.draws=None` and `draw_family_key=None`. The Stage 1 contract test [`test_prior_only_primitive_has_empty_evidence_and_is_not_misreported`](../../graph-editor/lib/tests/test_primitive_contract.py#L190) explicitly requires PRIOR_ONLY primitives to serve coherent draws. Stage 5b's composer needs draw-coherent prior-only primitives for non-target edges along the X→end span; closing this gap was a prerequisite. Changes:

- `_make_prior_only_primitive` now accepts `prior_alpha`, `prior_beta`, and `draw_family_key`, samples `draw_count` draws from `Beta(prior_alpha, prior_beta)` via `make_rng(key, 'primitive_p_draws')` (the same derivation as the conditioned path), and stores the keyed draws on the posterior plus the key on the primitive. Two consumers reading the same prior-only primitive under the same scope receive identical draws (plan §141, §585-589).
- `condition_primitive` updated to thread the new args through.
- New public `condition_prior_only_primitive(*, transition, primitive_scope, resolved_model, scenario_seed, options, prior_source)` builds a prior-only primitive without requiring an `EvidenceSet` — used by span composers for non-target edges that have no admitted evidence under the request scope. Constructs an empty `WeightedPrimitiveEvidenceView` carrying the `73n.stage_5b.prior_only_no_evidence.v1` binding policy.

The 18 existing Stage 3 tests stay green — the prior-only test asserted `mean` only, and the new behaviour (sampled draws) is consistent with the analytical mean.

### 1.3. Multi-hop readout in primitive_readout

[`graph-editor/lib/runner/primitive_readout.py`](../../graph-editor/lib/runner/primitive_readout.py) extended with the Stage 5b readout (parallel to Stage 5a's single-hop readout). Public surface added:

- `MultiHopReadoutFlag` — three-state enum (`OFF`, `SHADOW`, `ON`).
- `read_multi_hop_subject_composition_flag()` — reads `DAGNET_MULTI_HOP_SUBJECT_COMPOSITION` (default `OFF`); accepts `on`/`true`/`1` synonyms; unknown values fall back to `OFF` so the rollback switch (plan §397) is unconditional. Independent of Stage 5a's flag (plan §692).
- `is_multi_hop_subject_eligible(*, is_multi_hop, is_window, anchor_node_id, query_from_node)` — gate predicate. True iff `is_multi_hop` AND (`is_window` OR cohort `A == X`). Active cohort `A != X` excluded (Stage 6's surface).
- `SpanEdgeResolution` — frozen dataclass holding per-edge inputs the readout consumes for one edge of the X→end closure: `transition`, `primitive_scope`, `resolved_model`, optional `evidence_set`, and `is_target` flag. The caller resolves one of these per edge along the topological span.
- `MultiHopReadoutResult` — parallel to `SingleHopReadoutResult`. Carries `composed: Optional[ComposedSubjectSpan]`, the closed-form public scalars derived from the composed span, deltas vs legacy, and a diagnostics block. `should_substitute` is True only when `(flag=ON, eligible, composed.is_draw_coherent, p_mean_primitive set)`.
- `compute_multi_hop_subject_readout(...)` — top-level helper. Builds a synthetic `PrefixArrivalIdentity` and `RequestPrimitiveRegistry` for the request, conditions one primitive per span edge (target via `_synthetic_identity_resolution` + `condition_primitive`; non-target via `condition_prior_only_primitive`), runs `compose_subject_span`, derives `(p_mean, p_sd, p_sd_epistemic)` from the composed span's draws, returns the result with `should_substitute` set when ON and draw-coherent.

#### 1.3.1. Synthetic identity-clock map (no full prefix-arrival construction)

Stage 5b widens Stage 5a's identity-clock binding to multi-hop spans under window mode and cohort(A=X). For these requests every primitive's local clock equals the source clock (plan §201), so the readout builds an empty-nodes `PrefixArrivalMap` whose only role is to feed an `identity.cache_key` into the registry. The full request-scoped `arrival_weight[node_id][calendar_day]` map (Stage 2's deliverable) is the input to Stage 6's active cohort A≠X carrier work, not Stage 5b.

#### 1.3.2. Substitution semantics for multi-hop

Stage 5b uses `composed.span_p_mean` directly as the public `p_mean_primitive`. There is no closed-form analogue to Stage 5a's `(1-r)*cond_mean + r*prior_mean` Beta mixture for a composed multi-edge span — the DP is the semantic. `p_sd_primitive` and `p_sd_epistemic_primitive` are both reported as the composed-draw SD. Predictive vs epistemic separation (Stage 5a's closed-form Beta(α, β) vs Beta(α_pred, β_pred) split) does not have a multi-edge generalisation; producing one would require a parallel composition pass with epistemic-only primitives. That is deferred to a follow-up — see §5.

### 1.4. Wiring at the shared row-builder seam

[`compute_cohort_maturity_rows_v3`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1010) extended with a Stage 5b block immediately after Stage 5a's block. Mutually exclusive with Stage 5a by gate construction (5a requires `not is_multi_hop`; 5b requires `is_multi_hop`).

The block:

1. Reads the Stage 5b flag and gate (for multi-hop `is_window` or cohort A=X).
2. Builds the X→end span topology via `span_kernel._build_span_topology` (re-used, not re-implemented — AP58 prevention).
3. Resolves one `SpanEdgeResolution` per edge in `topo.edge_list`. For the target edge (`edge_id == target_edge_id`), the resolved model is the same `resolved` the row builder already uses, and the evidence is the Stage 5a-shared `_readout_evidence_set` (typed `EvidenceSet` or the synthetic from `runtime_bundle.p_conditioning_evidence` totals). For non-target edges, `resolve_model_params(edge_dict, scope='edge', temporal_mode=...)` resolves a fresh model and `evidence_set=None` produces a prior-only primitive.
4. Calls `compute_multi_hop_subject_readout`. When `should_substitute` is True, overrides `_p_infinity_mean` / `_p_infinity_sd` / `_p_infinity_sd_epistemic` in place. The diagnostic block (`_multi_hop_subject_readout`) is stashed on the first row's sentinel via the existing `_attach_cf_row_metadata` pattern.

Both api_handlers callers were updated:

- `_handle_cohort_maturity_v3` ([api_handlers.py](../../graph-editor/lib/api_handlers.py#L1781)) pops `_multi_hop_subject_readout` onto `subject_result['multi_hop_subject_readout']`.
- `handle_conditioned_forecast` ([api_handlers.py](../../graph-editor/lib/api_handlers.py#L2557)) pops it onto `edge_results[i]['multi_hop_subject_readout']`.

There is no per-handler substitution logic — both surfaces transparently see the substituted `p_infinity_*` values because the row builder wrote them. The AP58-correct factoring (STATS_SUBSYSTEMS §3.3 "shared code → guaranteed parity") established by Stage 5a applies uniformly to Stage 5b.

### 1.5. Tests

#### 1.5.1. Composer unit tests

[`graph-editor/lib/tests/test_subject_span_composer.py`](../../graph-editor/lib/tests/test_subject_span_composer.py) — 11 tests, all green. Coverage:

| Test | Plan reference | Coverage |
|---|---|---|
| `test_single_hop_degenerates_to_underlying_primitive` | §364 | One-edge span returns composed span_p ≈ primitive's posterior mean within MC noise. |
| `test_two_hop_serial_composes_probability_via_doc_29b_dp` | §429-431 | Two non-latent primitives at p≈0.5 each give composed span_p ≈ 0.25 (full DP, not terminal alone). |
| `test_two_hop_does_not_collapse_to_terminal_edge` | §696 | Even when upstream p≈1.0, composed span runs the full DP. |
| `test_draw_coherence_preserved_across_primitives` | §126-138 | Re-running composition with the same primitives produces identical draws. |
| `test_moments_only_primitive_drops_span_to_moments_only` | §591 | A single MOMENTS_ONLY primitive forces the whole composed span to moments-only; `cdf_draws` and `span_p_draws` are None; refusal reasons recorded. |
| `test_x_equals_end_raises` | §149 | x == end raises `CompositionError`. |
| `test_no_path_raises` | §149 | Disconnected graph (no path X→end) raises `CompositionError`. |
| `test_missing_primitive_raises` | §675 | Missing registry entry for a topology edge raises `CompositionError` ("lookup returned None"). |
| `test_provenance_records_composition_mode_draws` | §744 | Provenance records `composition_mode='draws'` and `all_coherent=True`. |
| `test_provenance_records_composition_mode_moments` | §744 | Provenance records `composition_mode='moments'` and `all_coherent=False` when one primitive refuses draws. |
| `test_composer_does_not_import_trajectory_engine` | KNOWN_ANTI_PATTERNS §272 | Source-level audit: composer does not import forecast_state / forecast_runtime / cohort_forecast_v3 / carrier_composition. |

#### 1.5.2. Multi-hop readout unit tests

[`graph-editor/lib/tests/test_multi_hop_subject_readout.py`](../../graph-editor/lib/tests/test_multi_hop_subject_readout.py) — 25 tests, all green (parameterised on flag synonyms). Coverage:

| Test group | Coverage |
|---|---|
| Flag plumbing (10 tests) | Default OFF; explicit off/shadow/on; on/true/1/TRUE/On/ON synonyms; unknown value falls back to OFF (rollback switch unconditional). |
| Eligibility (5 tests) | Multi-hop window: eligible. Multi-hop cohort A=X: eligible. Multi-hop cohort A≠X: deferred (Stage 6). Single-hop: deferred (Stage 5a). Cohort missing anchor info: conservative defer. |
| Mode behaviour (3 tests) | OFF: composed=None, skip_reason=`flag_off`. SHADOW: composed populated, deltas recorded, `should_substitute=False`. ON: substitution fires when draw-coherent. |
| Soft skips (4 tests) | Ineligible, incomplete inputs (missing graph), invalid target count (multiple is_target=True), composition error (no path) all return soft skips with named `skip_reason`. |
| Diagnostics (1 test) | Diagnostics expose flag, eligibility, primitive count, composition mode, composed_public_moments, legacy_public_moments, delta, within_shadow_band, subject_probability_source. |
| Prior-only sub-span (1 test) | All-prior-only span composes correctly; primitive summaries report `status='prior_only'` and `is_draw_coherent=True`. |
| `should_substitute` property (1 test) | True only for (flag=ON, eligible, draw-coherent). |

#### 1.5.3. Stage 5a / Stage 1-4 / existing-test parity

- **Stage 1-5a primitive suite**: 143 tests passed (Stage 1 contract, Stage 2 evidence, Stage 3 conditioning, Stage 4 residual guard, Stage 5a readout, prefix arrival, plus Stage 5b composer + readout).
- **Stage 5a in-process integration**: 3/3 tests passed (`test_primitive_readout_integration.py`). Cross-surface parity contract holds; the row-builder seam still produces identical answers across cohort_maturity and conditioned_forecast surfaces.
- **AP58 outside-in baseline**: identical to Stage 5a's documented baseline (§1.3.2 of the 5a note) — 32 passed, 5 xfailed (4 AP58 strict-xfail targets + the 73m §1B carry-over), 1 failed (`test_v3_midline_at_saturation_converges_to_p` — pre-existing 73m §1B carry-over, not caused by Stage 5b).

#### 1.5.4. AP58 strict-xfail flip status

The four `test_cohort_factorised_outside_in.py` strict-xfail targets remain xfailed under both flag combinations. This is the expected outcome:

- The four targets assert cohort-vs-window convergence. They are gated to `DAGNET_SINGLE_HOP_PRIMITIVE_READOUT=on`. Stage 5b's flag (`DAGNET_MULTI_HOP_SUBJECT_COMPOSITION`) does not affect them directly.
- Closure requires both Stage 5b's multi-hop composition AND Stage 6's carrier consumer (so cohort A!=X requests route through the primitive substrate). Stage 5a §6 row 2 records the joint dependency; Stage 5b alone does not flip them.
- Independently, the maturity-aware likelihood gap inherited from Stage 5a Follow-up #1 (5a note §5.1) means primitive substitution publishes raw `Σy/Σx` rather than the maturity-corrected forecast, so even after Stage 6 closes the carrier axis, the AP58 targets need the likelihood migration to converge.

The strict-xfail markers stay as the regression net for when Stage 6 + the likelihood migration close the remaining gaps.

### 1.6. What Stage 5b deliberately does NOT do

- **No live cutover by default.** The flag is `OFF` out of the box. The legacy multi-hop trajectory output is canonical until the user flips the flag.
- **No replacement of `compute_forecast_trajectory`.** The trajectory engine still runs every multi-hop CF request unchanged. Stage 5b substitutes only the public asymptotic scalar (`_p_infinity_*`) when the flag fires; trajectory rows, completeness, and fan bands flow through unchanged.
- **No carrier logic beyond identity.** Active cohort A!=X is excluded by the eligibility gate. The carrier consumer is Stage 6's surface (plan §"Stage 6 — Carrier Consumer" line 715).
- **No maturity-aware likelihood migration.** Inherited from Stage 5a Follow-up #1; Stage 5b is the architectural target stage but the migration itself is non-trivial (the legacy per-cohort likelihood at `forecast_state._cohort_binomial_log_likelihood:249` is per-cohort with maturity reweighting; the primitive currently runs a plain Beta-Binomial conjugate on the weighted view). Tracked as §5 follow-up #1.
- **No predictive vs epistemic SD separation for multi-hop.** Both `p_sd_primitive` and `p_sd_epistemic_primitive` carry the composed-draw SD. Stage 5a's closed-form predictive Beta has no multi-edge generalisation. Tracked as §5 follow-up #2.
- **No retirement of `compute_forecast_trajectory` as a window evidence-admission owner.** Plan §725 mandates this for the dead-code audit at the end of Stage 6; Stage 5b leaves the trajectory engine in place because the legacy public path remains the rollback surface.
- **No FE/wire change.** `multi_hop_subject_composition` is a BE env-var-only flag at this stage. If FE A/B testing becomes necessary, future work can promote it to `ForecastingSettings` (same trajectory as the Stage 5a single-hop flag).
- **No flip-to-green for the four AP58 strict-xfails.** Per §1.5.4 above, those gates need both Stage 6 and the maturity-aware likelihood migration; Stage 5b alone is insufficient.

---

## 2. Stop-condition discharge

Plan §"Stage 5b" stop condition (line 698):

> multi-hop `subject_span` tests prove the full `X -> end` primitive composition is consumed; every divergence from legacy is named, tied to an invariant in 73g and the semantics doc, and covered by tests; degraded composition results carry explicit provenance and do not silently masquerade as coherent draw families.

| Stop-condition clause | Discharge |
|---|---|
| Multi-hop `subject_span` tests prove the full X→end primitive composition is consumed | **Discharged.** The composer's DP runs `g_X = δ(τ=0)`, `g_v = Σ_{u→v} g_u * f_{u→v}`, `K = cumsum(g_end)` over every edge in the topology; tests `test_two_hop_serial_composes_probability_via_doc_29b_dp` and `test_two_hop_does_not_collapse_to_terminal_edge` prove the full span is consumed (composed span_p = product of edge p's, not terminal alone). `test_missing_primitive_raises` proves the composer fails loudly when any edge in the topology lacks a registry entry. |
| Every divergence from legacy is named, tied to an invariant in 73g and the semantics doc, and covered by tests | **Discharged for the architectural surface; numerical divergence is gated.** Legacy multi-hop output uses `compute_forecast_trajectory` which conditions per-cohort on the target edge's evidence and (per the AP58 outstanding-instance note in BE_RUNNER_CLUSTER §4) can read terminal-edge-only or trajectory-local results for some multi-hop requests. Stage 5b's composed span_p is `Π p_i` (with timing convolution); under flag ON it WILL diverge from legacy where legacy was terminal-edge-only — that is the corrected target semantics per plan §695(ii), tied to plan §437 ("`subject_span` probability is the composed probability of the X→end primitive topology. In multi-hop it is not the terminal edge probability"). Production keeps the flag at OFF until the maturity-aware likelihood migration (Stage 5a follow-up #1) closes the per-primitive numeric gap and Stage 6 closes the cohort A!=X axis; numerical parity tests against the F14 oracle land then. |
| Degraded composition results carry explicit provenance and do not silently masquerade as coherent draw families | **Discharged.** `test_moments_only_primitive_drops_span_to_moments_only` proves a single MOMENTS_ONLY primitive forces `composed.is_draw_coherent=False`, sets `span_p_draws=None` and `cdf_draws=None`, and records `refusal_reasons` in provenance. The readout's `should_substitute` property checks `composed.is_draw_coherent` and refuses to substitute moments-only output. |

The §"Stage 5b" migration rules (lines 690-696) are honoured:

- ✓ gate the composed multi-hop subject span behind an independent `multi_hop_subject_composition` flag (env var `DAGNET_MULTI_HOP_SUBJECT_COMPOSITION`, separate from Stage 5a's flag);
- ✓ compose primitive probability and conditional timing along the full X→Z span, never the terminal edge alone (DP runs over every edge in topology;`test_two_hop_does_not_collapse_to_terminal_edge`);
- ✓ preserve draw-family coherence across all primitives in the span using the Stage 1 draw-identity rules (`test_draw_coherence_preserved_across_primitives`; registry enforces draw_count agreement; composer enforces local check;);
- ✓ classify any divergence from legacy per plan §695 (i)/(ii)/(iii) (this note's §1.6 and §3 below; tests are the regression net);
- ✓ reject any fallback that collapses a multi-hop subject to a terminal-edge primitive when more than one primitive is on the span (the composer never reads a single primitive when `topo.edge_list` has >1 entry; `test_missing_primitive_raises` proves the contract is enforced).

---

## 3. Divergence categorisation per plan §695

Plan §695 requires every divergence from legacy to be classified as (i) regression — stop and investigate; (ii) corrected target semantics — record reason and update tests; (iii) draw-family or moments-only degradation — surface as provenance, not silent change.

| Surface | Expected divergence under flag ON | Category | Reason |
|---|---|---|---|
| Multi-hop `window(X-Z)` p_infinity_mean against legacy on synth fixtures with terminal-edge-only legacy result | Composed value ≠ legacy terminal-edge value. | (ii) corrected target semantics | Plan §437 "`subject_span` probability is the composed probability of the X→end primitive topology. In multi-hop it is not the terminal edge probability." 73g invariant 7 (multi-hop subject must read composed `p_∞`). |
| Multi-hop F14 Q2 (`from(simple-b).to(simple-c).cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)`) under flag ON: composed value drops to raw `Σy/Σx`-style aggregate | (iii) degraded — gated on Stage 5a follow-up #1 | The non-target edge is prior-only with the model_resolver's prior; the target edge's primitive runs plain Beta-Binomial conjugate (no maturity-aware likelihood). The composed span carries the per-primitive numeric gap forward. Surfaces in the SHADOW diagnostic via `delta_p_mean`. |
| All-prior-only span (no admitted evidence on any edge) | Composed value reflects the prior product. | (ii) corrected target semantics — there is no legacy "edge-local prior product" path to compare against; the legacy path either conditioned on the target's evidence (single-edge prior product, ill-defined for multi-hop) or fell through to trajectory-engine output. | This is genuinely new behaviour for multi-hop with no admitted evidence. |
| Composed span on graphs where one primitive refuses draws (DEGRADED upstream, MOMENTS_ONLY upstream) | Composed becomes moments-only; `span_p_sd=NaN`. | (iii) degraded provenance | `provenance.refusal_reasons` lists the offending primitive(s). Consumers (Stage 5b readout's `should_substitute` and downstream callers) refuse to substitute. |

No category (i) regressions surfaced during Stage 5b's test sweep. The 1 failing test in `test_cohort_factorised_outside_in.py` is the documented 73m §1B carry-over (`test_v3_midline_at_saturation_converges_to_p`); identical pre- and post-Stage-5b.

---

## 4. Suggested commit messages (per atom)

The skill does not commit. The following are suggested commit messages for each atom; the user decides timing and granularity.

| Atom | Files | Suggested message |
|---|---|---|
| 1 | `graph-editor/lib/runner/subject_span_composer.py` | `73n stage 5b: subject_span_composer module — multi-hop primitive composition via doc-29b/span_kernel DAG algebra (§684-698)` |
| 2a | `graph-editor/lib/runner/primitive_conditioning.py` | `73n stage 5b: PRIOR_ONLY primitives produce keyed prior draws (Stage 1 contract test §190); add public condition_prior_only_primitive helper for non-target span edges (§95, §141, §585-589)` |
| 2b | `graph-editor/lib/runner/primitive_readout.py` | `73n stage 5b: multi-hop subject-span readout — flag, gate, span-edge resolution, registry-backed composition (§684-698, §692, §694)` |
| 3 | `graph-editor/lib/runner/cohort_forecast_v3.py`, `graph-editor/lib/api_handlers.py` | `73n stage 5b: wire multi-hop subject-span readout into compute_cohort_maturity_rows_v3 — shared row-builder seam, both api_handlers callers updated (AP58 / STATS_SUBSYSTEMS §3.3)` |
| 4 | `graph-editor/lib/tests/test_subject_span_composer.py`, `graph-editor/lib/tests/test_multi_hop_subject_readout.py` | `73n stage 5b: composer + readout tests — degenerate single-hop, two-hop serial, draw coherence, moments-only refusal, AP58 prevention, OFF/SHADOW/ON behaviour` |
| 5 | `docs/current/project-bayes/73n-stage-5b-note.md`, `docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md` | `73n stage 5b: stage-5b note + mark stage 5b complete in progress block` |

---

## 5. What unblocks for later stages

- **Stage 5c (Multi-Hop Window Readout)** consumes Stage 5b's `ComposedSubjectSpan` directly. The eligibility gate matches Stage 5b's; Stage 5c just substitutes the multi-hop window readout to read the same composed span Stage 5b produces, with the identity carrier in window mode (plan §704). Same row-builder seam; same flag pattern (`DAGNET_MULTI_HOP_WINDOW_READOUT`).
- **Stage 6 (Carrier Consumer)** widens the Stage 5b gate to admit active cohort `A != X`. A real `PrefixArrivalMap` (Stage 2's deliverable) replaces the synthetic identity-clock map; the carrier composer feeds a primitive-backed `carrier_to_x` into the substitution alongside the composed subject span. Stage 6 also retires `_legacy_trajectory_draw_family_key` once the registry-backed key reaches the trajectory engine.
- **Stage 7 (Caching)** can persist `ConditionedTransitionPrimitive` and `ComposedSubjectSpan` keyed by `(transition, scope, prefix-arrival identity)` and `(x, end, registry-key-set)` respectively. Stage 5b's composer is idempotent across cache hits.
- **Stage 8 (Cross-Surface Projection and Provenance)** rolls the `multi_hop_subject_readout` block into the canonical CF response provenance schema alongside Stage 5a's `primitive_readout` block.
- **Stage 9 (Acceptance Tests)** consumes Stage 5b's composer for the multi-hop `window(X-Z)` and multi-hop `subject_span` acceptance fixtures; the F14 Q2 measurement against the maturity-corrected oracle lands here once follow-up #1 closes.

---

## 6. Open follow-ups (tracked for later resolution; NOT Stage 5b-blocking)

These items are recorded so they survive into the rest of 73n's plan. Each carries a target stage where it must be closed before the plan as a whole can ship.

### Follow-up 1 — Maturity-aware likelihood migration into the primitive (BLOCKS production flag-ON)

**Inherited from**: Stage 5a Follow-up #1 (5a note §5.1).

**Where**: `runner.primitive_conditioning.condition_primitive`. Today it produces a plain Beta-Binomial conjugate posterior on the weighted view. The trajectory engine `compute_forecast_trajectory` produces a per-cohort maturity-aware IS-conditioned posterior with `Binomial.pmf(k_c | n_c, p_s · CDF_s(τ_c))` reweighting (`forecast_state._cohort_binomial_log_likelihood:249`) that downweights immature cohorts.

**Why this blocks Stage 5b production flag-ON too**: composed multi-hop primitives carry the per-primitive likelihood gap forward. F14 Q1 single-hop showed Δ=−0.167 (5a §1.3.4); multi-hop compounds the same gap across primitives. Production must keep both flags at OFF until this lands.

**Target stage**: Stage 5b should have closed it but the migration is genuinely non-trivial (per-cohort decomposition + per-draw IS reweighting moves an entire likelihood pass into the primitive). Carrying forward as a Stage 6 prerequisite.

**How to detect closure**: F14 Q1 shadow delta `< 0.002` (Stage 0c §3.3 acceptance band).

### Follow-up 2 — Predictive vs epistemic SD separation for multi-hop

**Where**: `runner.primitive_readout.compute_multi_hop_subject_readout` returns `p_sd_primitive == p_sd_epistemic_primitive` (both = composed-draw SD). Stage 5a's closed-form Beta(α, β) vs Beta(α_pred, β_pred) split has no multi-edge generalisation in closed form.

**Why deferred**: producing a separate epistemic band would require running composition twice — once with predictive primitives (κ-inflated) and once with epistemic-only — or deriving an analytical pass via Edgeworth/Cornish-Fisher expansion. Either approach is a full design exercise.

**Target stage**: Stage 8 (Cross-Surface Projection) or Stage 9 (Acceptance Tests).

### Follow-up 3 — Active cohort A!=X gate widening (Stage 6)

**Where**: `runner.primitive_readout.is_multi_hop_subject_eligible` returns False for active cohort A!=X. The same gate for the four AP58 strict-xfail tests; both axes must close together.

**Target stage**: Stage 6 (Carrier Consumer).

**How to detect closure**: gate widens; the four AP58 strict-xfails XPASS under flag ON (combined with follow-up #1).

### Follow-up 4 — `subject_probability_source` enum on ForecastTrajectory (low priority, inherited)

Inherited from Stage 5a Follow-up #4. Same disposition.

### Follow-up 5 — FE-controllable flag (deferred, inherited)

Inherited from Stage 5a Follow-up #5. Same disposition; if the Stage 5a flag promotes to `ForecastingSettings`, Stage 5b's flag should too.

### Follow-up 6 — Diagnostic block volume on flag=off (low priority, inherited)

Inherited from Stage 5a Follow-up #6. The Stage 5b diagnostic adds another ~120 bytes/edge. Total volume on multi-hop OFF responses is now ~240 bytes/edge across both diagnostic blocks. If this becomes a concern, gate on flag != off.

---

## 7. Tracked failures and known-RED items (for plan closure)

This is the live ledger of items that MUST be resolved before 73n can ship as a whole. Every item has a target stage.

| Item | Status | Target stage | Re-test recipe |
|---|---|---|---|
| F14 Q1 / Q2 primitive-vs-legacy gap (likelihood migration) | **BLOCKING flag-ON for both 5a + 5b** | Stage 6 (with follow-up #1) | F14 Q1 shadow delta `< 0.002`; F14 Q2 measurement once likelihood migrates |
| AP58 strict-xfail #1: `test_single_hop_non_latent_upstream_collapses_to_window[FAST]` | xfailed (Stage 5a) | Stage 5b + Stage 6 + likelihood migration | `pytest -k 'test_single_hop_non_latent_upstream_collapses_to_window' lib/tests/test_cohort_factorised_outside_in.py` with both flags ON; expect XPASS |
| AP58 strict-xfail #2: same `[SLOW]` | xfailed | Stage 5b + Stage 6 + likelihood migration | same |
| AP58 strict-xfail #3: `test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel` | xfailed | Stage 5b + Stage 6 + likelihood migration | `pytest -k 'test_degenerate_identity_and_instant_carrier'` |
| AP58 strict-xfail #4: `test_multihop_non_latent_upstream_collapse` | xfailed | Stage 5b + Stage 6 + likelihood migration | `pytest -k 'test_multihop_non_latent_upstream_collapse'` |
| `test_v3_midline_at_saturation_converges_to_p` (73m §1B carry-over) | **failing** (documented, not gated) | not 73n | Re-evaluate at Stage 9 |

The four AP58 strict-xfail markers remain the regression net: they will surface as suite failures (XPASS strict) the moment Stage 6 + the likelihood migration close their semantic gaps. Removing the markers is the closure event.

---

## 8. Test totals snapshot

Stage 5b additions:

- 11 new composer tests (`test_subject_span_composer.py`)
- 25 new multi-hop readout tests (`test_multi_hop_subject_readout.py`, parameterised on flag synonyms)

Existing test surfaces unchanged:

- 18 Stage 3 tests (`test_primitive_conditioning.py`) — green
- 14 Stage 1 tests (`test_primitive_contract.py`) — green
- 18 Stage 2 tests (`test_primitive_evidence.py`) — green
- 20 Stage 4 tests (`test_primitive_residual_guard.py`) — green
- 22 Stage 5a tests (`test_primitive_readout.py`) — green
- 15 prefix-arrival tests (`test_prefix_arrival.py`) — green
- 3 Stage 5a in-process integration tests (`test_primitive_readout_integration.py`) — green
- AP58 outside-in baseline (`test_cohort_factorised_outside_in.py`) — 32 passed / 5 xfailed / 1 documented carry-over failure (unchanged from Stage 5a's recorded baseline)

Total primitive-substrate suite: **143 tests green** (up from Stage 5a's 107).
