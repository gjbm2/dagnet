# 73n Stage 5c — Multi-Hop Window Readout — note

**Status**: Stage 5c landed — multi-hop window queries now route through the same composed-subject-span machinery Stage 5b built for cohort A==X, behind an independent flag (`DAGNET_MULTI_HOP_WINDOW_READOUT`, default OFF). Architecture complete; flipping to ON in production blocked by the inherited maturity-aware likelihood gap (Stage 5a Follow-up #1).
**Date opened**: 1-May-26
**Plan**: [`73n-carrier-evidence-conditioning-implementation-plan.md`](73n-carrier-evidence-conditioning-implementation-plan.md) §"Stage 5c — Multi-Hop Window Readout" lines 700-713
**Stage 0c contracts**: [`73n-stage-0-baseline.md`](73n-stage-0-baseline.md) §3.3 (numeric tolerances)
**Stage 1-5b inputs**: [`73n-stage-1-note.md`](73n-stage-1-note.md), [`73n-stage-2-note.md`](73n-stage-2-note.md), [`73n-stage-3-note.md`](73n-stage-3-note.md), [`73n-stage-4-note.md`](73n-stage-4-note.md), [`73n-stage-5a-note.md`](73n-stage-5a-note.md), [`73n-stage-5b-note.md`](73n-stage-5b-note.md)

---

## 1. Stage 5c deliverables

### 1.1. Stage 5b gate tightened — multi-hop window leaves Stage 5b's surface

Stage 5b's `is_multi_hop_subject_eligible` ([`primitive_readout.py:784`](../../graph-editor/lib/runner/primitive_readout.py#L784)) previously admitted both multi-hop window and multi-hop cohort A==X. Plan §708 mandates the Stage 5c flag be independent of Stages 5a/5b. If Stage 5b's gate continued admitting `is_window`, flipping `DAGNET_MULTI_HOP_SUBJECT_COMPOSITION=on` would also fire on multi-hop window queries — defeating flag independence. The gate now returns `False` for `is_window=True`; Stage 5b admits multi-hop cohort A==X only. Stage 5b's unit test `test_eligible_multi_hop_window` becomes `test_ineligible_multi_hop_window_deferred_to_stage_5c` to pin the new contract.

### 1.2. Stage 5c readout module — same composer, independent flag

[`graph-editor/lib/runner/primitive_readout.py`](../../graph-editor/lib/runner/primitive_readout.py) gained Stage 5c's surface, structured in parallel with Stage 5b. Public surface added:

- `MultiHopWindowReadoutFlag` — three-state enum (`OFF`, `SHADOW`, `ON`).
- `read_multi_hop_window_readout_flag()` — reads `DAGNET_MULTI_HOP_WINDOW_READOUT` (default OFF). Same parsing rules as Stages 5a/5b: case-insensitive `off`/`shadow`/`on`; synonyms `true`/`1`/`TRUE`/`On` map to ON; unknown values fall back to OFF so the rollback switch (plan §397) is unconditional. Independent of Stage 5a's `DAGNET_SINGLE_HOP_PRIMITIVE_READOUT` and Stage 5b's `DAGNET_MULTI_HOP_SUBJECT_COMPOSITION`.
- `is_multi_hop_window_eligible(*, is_multi_hop, is_window)` — gate predicate. True iff `is_multi_hop AND is_window`. Multi-hop cohort A==X is Stage 5b's surface; single-hop is Stage 5a's; active cohort A!=X is Stage 6's.
- `MultiHopWindowReadoutResult` — frozen dataclass. Carries `composed: Optional[ComposedSubjectSpan]`, the closed-form public scalars derived from the composed span's draws, deltas vs legacy, a diagnostics block, and a `should_substitute` property. The property is True only when `(flag=ON AND eligible AND composed.is_draw_coherent AND p_mean_primitive set)`.
- `compute_multi_hop_window_readout(...)` — top-level helper. Builds a synthetic `PrefixArrivalIdentity` and `RequestPrimitiveRegistry` for the request (window mode binds on the source clock per plan §201, so the full prefix-arrival map is Stage 6's deliverable, not Stage 5c's), conditions one primitive per span edge (target via `_synthetic_identity_resolution` + `condition_primitive`; non-target via `condition_prior_only_primitive`), runs `compose_subject_span`, derives `(p_mean, p_sd, p_sd_epistemic)` from the composed span's draws, returns the result with `should_substitute` set when ON and draw-coherent.

Per plan §704, Stage 5c does not introduce new conditioning. It consumes Stage 5b's composer (`subject_span_composer.compose_subject_span` and the doc-29b DP algebra) directly; the only differences from Stage 5b's helper are:

- the gate predicate (`is_multi_hop AND is_window` rather than `is_multi_hop AND not is_window AND A==X`);
- the binding policy string (`73n.stage_5c.multi_hop_window_readout.v1`) for cache-key disambiguation if Stage 7 later persists composed objects;
- the `subject_probability_source` label (`composed_subject_span_window` rather than `composed_subject_span`), exposed in diagnostics so consumers reading the response provenance can distinguish the rollout axis;
- the request-root selection (window mode pins to `query_from_node` directly).

### 1.3. Wiring at the shared row-builder seam

[`compute_cohort_maturity_rows_v3`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L1010) gained a Stage 5c block immediately after Stage 5b's. The two blocks are mutually exclusive by gate construction (Stage 5b admits multi-hop cohort A==X only; Stage 5c admits multi-hop window only). The Stage 5c block:

1. Reads the Stage 5c flag and gate (multi-hop + window).
2. Builds the X→end span topology via `span_kernel._build_span_topology` (re-used, not re-implemented — AP58 prevention).
3. Resolves one `SpanEdgeResolution` per edge in `topo.edge_list`, with `temporal_mode='window'` for non-target edges. The target edge uses the same `_readout_evidence_set` Stage 5b's block uses (typed `EvidenceSet` from `forecast_runtime.prepare_forecast_runtime_inputs`, or the Stage 5a-shared synthetic from `runtime_bundle.p_conditioning_evidence` totals).
4. Calls `compute_multi_hop_window_readout`. When `should_substitute` is True, overrides `_p_infinity_mean` / `_p_infinity_sd` / `_p_infinity_sd_epistemic` in place. The diagnostic block is stashed on the first row's `_multi_hop_window_readout` sentinel via `_attach_cf_row_metadata`.

`_attach_cf_row_metadata` ([`cohort_forecast_v3.py:153`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L153)) gained an optional `multi_hop_window_readout` kwarg that lands the sentinel when supplied, mirroring the existing `primitive_readout` (Stage 5a) and `multi_hop_subject_readout` (Stage 5b) kwargs.

Both api_handlers callers were updated:

- `_handle_cohort_maturity_v3` ([`api_handlers.py`](../../graph-editor/lib/api_handlers.py)) pops `_multi_hop_window_readout` onto `subject_result['multi_hop_window_readout']`.
- `handle_conditioned_forecast` ([`api_handlers.py`](../../graph-editor/lib/api_handlers.py)) pops it onto `edge_results[i]['multi_hop_window_readout']`.

There is no per-handler substitution logic — both surfaces transparently see the substituted `p_infinity_*` values because the row builder wrote them. The AP58-correct factoring (STATS_SUBSYSTEMS §3.3 "shared code → guaranteed parity") established by Stage 5a applies to Stage 5c.

### 1.4. Tests

#### 1.4.1. Stage 5c unit tests

[`graph-editor/lib/tests/test_multi_hop_window_readout.py`](../../graph-editor/lib/tests/test_multi_hop_window_readout.py) — 25 tests, all green. Coverage:

| Test group | Coverage |
|---|---|
| Flag plumbing (10 tests) | Default OFF; explicit off/shadow/on; on/true/1/TRUE/On/ON synonyms; unknown value falls back to OFF; flag is independent of Stage 5b's flag (both axes tested). |
| Eligibility (4 tests) | Multi-hop window: eligible. Multi-hop cohort: deferred to Stage 5b. Single-hop window: deferred to Stage 5a. Single-hop cohort: deferred to Stage 5a. |
| Mode behaviour (4 tests) | OFF: composed=None, skip_reason=`flag_off`. SHADOW: composed populated, deltas recorded, `should_substitute=False`. ON: substitution fires when draw-coherent (`should_substitute=True`). Plan §709: composer runs the full DP — does not collapse to terminal edge even when upstream primitive is concentrated. |
| Soft skips (4 tests) | Ineligible, incomplete inputs, invalid target count, composition error all return soft skips with named `skip_reason`. |
| Diagnostics (1 test) | Diagnostics expose flag, eligibility, primitive count, composition mode, `composed_public_moments`, `legacy_public_moments`, delta, `within_shadow_band`, `subject_probability_source='composed_subject_span_window'`. |
| Prior-only sub-span (1 test) | All-prior-only span composes correctly; primitive summaries report `status='prior_only'` and `is_draw_coherent=True`. |
| `should_substitute` property (1 test) | True only for (flag=ON, eligible, draw-coherent). |

#### 1.4.2. Stage 5b regression coverage

The Stage 5b unit suite ([`test_multi_hop_subject_readout.py`](../../graph-editor/lib/tests/test_multi_hop_subject_readout.py)) was updated for the tightened gate:

- `test_eligible_multi_hop_window` removed (multi-hop window is now Stage 5c's surface).
- `test_ineligible_multi_hop_window_deferred_to_stage_5c` added to pin the new contract.
- `test_ineligible_single_hop` updated to use cohort-mode arguments (the `_two_hop_resolutions` fixtures are A==X cohort-mode by construction; single-hop window remains a separate ineligibility for Stage 5b).
- `test_eligible_multi_hop_cohort_a_equals_x` retained — confirms Stage 5b still admits its primary surface.

All 18 Stage 5b unit tests stay green under the tightened gate.

#### 1.4.3. Existing-test parity (flags OFF default)

With both Stage 5b and Stage 5c env vars unset (default OFF), every existing test passes unchanged. Counts:

- 25 new Stage 5c readout tests (`test_multi_hop_window_readout.py`) — green.
- 18 Stage 5b readout tests (`test_multi_hop_subject_readout.py`, updated for tightened gate) — green.
- 11 composer tests (`test_subject_span_composer.py`) — green.
- 22 Stage 5a readout tests (`test_primitive_readout.py`) — green.
- 14 Stage 1 contract tests (`test_primitive_contract.py`) — green.
- 18 Stage 2 evidence tests (`test_primitive_evidence.py`) — green.
- 18 Stage 3 conditioning tests (`test_primitive_conditioning.py`) — green.
- 20 Stage 4 residual guard tests (`test_primitive_residual_guard.py`) — green.
- 15 prefix-arrival tests (`test_prefix_arrival.py`) — green.
- 3 Stage 5a in-process integration tests (`test_primitive_readout_integration.py`) — green.

Total primitive-substrate suite: **172 tests green** (up from Stage 5b's 143).

#### 1.4.4. AP58 outside-in baseline

`test_cohort_factorised_outside_in.py` measured in-process: 2 passed, 36 skipped (BE not running on localhost:9000). The skipped set includes the four AP58 strict-xfail targets and the documented 73m §1B carry-over. Stage 5c's flag-OFF default is a structural no-op against this baseline — no regression possible because the row-builder block exits early when `is_multi_hop AND is_window AND _readout_evidence_set is not None` is not satisfied. The four AP58 strict-xfails remain gated to `DAGNET_SINGLE_HOP_PRIMITIVE_READOUT=on`; Stage 5c's flag does not affect them directly.

### 1.5. What Stage 5c deliberately does NOT do

- **No live cutover by default.** The flag is `OFF` out of the box. The legacy multi-hop window output (the trajectory engine's per-tau saturation scalar) remains canonical until the user flips the flag.
- **No replacement of `compute_forecast_trajectory`.** The trajectory engine still runs every multi-hop window CF request unchanged. Stage 5c substitutes only the public asymptotic scalar (`_p_infinity_*`) when the flag fires; trajectory rows, completeness, and fan bands flow through unchanged.
- **No new conditioning.** Per plan §704, Stage 5c reads the composed subject span Stage 5b produces. The composer, the prior-only fallback for non-target edges, and the doc-29b DP algebra are unchanged.
- **No carrier logic beyond identity.** Active cohort A!=X is excluded by the eligibility gate. The carrier consumer is Stage 6's surface (plan §"Stage 6 — Carrier Consumer" line 715).
- **No maturity-aware likelihood migration.** Inherited from Stage 5a Follow-up #1; Stage 5c carries the same per-primitive likelihood gap forward. Tracked as §3 follow-up #1.
- **No predictive vs epistemic SD separation for multi-hop window.** Both `p_sd_primitive` and `p_sd_epistemic_primitive` carry the composed-draw SD, identical to Stage 5b. Tracked as §3 follow-up #2.
- **No FE/wire change.** `multi_hop_window_readout` is a BE env-var-only flag at this stage. If FE A/B testing becomes necessary, future work can promote it to `ForecastingSettings` (same trajectory as Stages 5a/5b's flags).
- **No flip-to-green for the four AP58 strict-xfails.** Those gates need both Stage 6 and the maturity-aware likelihood migration; Stage 5c (or any combination of 5a + 5b + 5c) is insufficient.

---

## 2. Stop-condition discharge

Plan §"Stage 5c" stop condition (line 713):

> multi-hop `window(X-Z)` reads the Stage 5b composed subject span, diagnostics identify composed-subject-span provenance, and any divergence from legacy is reconciled and tested per the rules above.

| Stop-condition clause | Discharge |
|---|---|
| Multi-hop `window(X-Z)` reads the Stage 5b composed subject span | **Discharged.** Stage 5c's `compute_multi_hop_window_readout` invokes `subject_span_composer.compose_subject_span` (the same composer Stage 5b uses) for every multi-hop window request that hits the row-builder seam under flag ON. The DP runs over every edge in `_build_span_topology(graph).edge_list` (`test_two_hop_serial_composes_probability_via_doc_29b_dp` proves the full span is consumed; `test_on_flag_does_not_collapse_to_terminal_edge` proves the upstream primitive participates rather than being elided). |
| Diagnostics identify composed-subject-span provenance | **Discharged.** When substitution fires, `subject_probability_source` reads `composed_subject_span_window`, the diag block carries `composed.{primitive_count, draw_count, is_draw_coherent, span_p_mean, span_p_sd, composition_mode, binding_policy}`, plus per-primitive summaries with `(edge_id, from, to, is_target, status, is_draw_coherent)`, and `composed_public_moments` vs `legacy_public_moments` for forensic comparison. Plan §710 ("projection and diagnostics must name primitive composition directly") is met. |
| Any divergence from legacy is reconciled and tested per the rules above | **Discharged for the architectural surface; numerical divergence is gated.** Plan §711 explicitly classifies multi-hop window parity SEPARATELY from single-hop and rules out preservation of any old terminal-edge-only read as the target. Stage 5c's substituted scalar will diverge from legacy where legacy was terminal-edge-only — that is the corrected target semantics, tied to plan §437 ("`subject_span` probability is the composed probability of the X→end primitive topology. In multi-hop it is not the terminal edge probability") and 73g invariant 7 (multi-hop subject must read composed `p_∞`). Production keeps the flag at OFF until the maturity-aware likelihood migration (Stage 5a follow-up #1) closes the per-primitive numeric gap; numerical parity tests against the F14 oracle land then. |

The §"Stage 5c" migration rules (lines 706-711) are honoured:

- ✓ gate the multi-hop window readout behind an independent `multi_hop_window_readout` flag (env var `DAGNET_MULTI_HOP_WINDOW_READOUT`, separate from Stages 5a and 5b);
- ✓ read the composed subject span, not the terminal edge, and not a separate multi-hop window evidence-conditioning branch (the composer's DP runs over every topology edge; Stage 5c does not introduce a parallel evidence-conditioning path);
- ✓ preserve `p_conditioning_evidence` as compatibility/provenance metadata only — Stage 5c's diag block names primitive composition directly via `subject_probability_source='composed_subject_span_window'`;
- ✓ classify multi-hop window parity separately from single-hop — Stage 5c is independently flagged so window parity is rolled out and measured on its own axis; the documented expected divergence categories (corrected target semantics; degraded provenance) are surfaced via the SHADOW diagnostic and named in §3 of this note.

---

## 3. Divergence categorisation per plan §695 / §711

Plan §711 requires multi-hop window parity to be classified separately from single-hop, with intentional non-parity tied to invariants and covered by tests.

| Surface | Expected divergence under flag ON | Category | Reason |
|---|---|---|---|
| Multi-hop `window(X-Z)` p_infinity_mean against legacy on synth fixtures with terminal-edge-only legacy result | Composed value ≠ legacy terminal-edge value. | Corrected target semantics | Plan §437 "`subject_span` probability is the composed probability of the X→end primitive topology. In multi-hop it is not the terminal edge probability." 73g invariant 7. The composed span runs the full DP per `test_two_hop_serial_composes_probability_via_doc_29b_dp` and `test_on_flag_does_not_collapse_to_terminal_edge`. |
| Multi-hop window F14-style fixtures under flag ON: composed value drops toward raw `Σy/Σx`-style aggregate | Inherited from Stage 5a Follow-up #1 | Degraded — gated on Stage 5a follow-up #1 | The non-target edges are prior-only with the model_resolver's prior; the target edge's primitive runs plain Beta-Binomial conjugate (no maturity-aware likelihood). Surfaces in the SHADOW diagnostic via `delta_p_mean`. |
| All-prior-only multi-hop window span (no admitted evidence on any edge) | Composed value reflects the prior product. | Corrected target semantics | There is no legacy "edge-local prior product" path to compare against; the legacy path either conditioned on the target's evidence or fell through to trajectory-engine output. New behaviour for multi-hop window with no admitted evidence. |
| Composed span where one primitive refuses draws (DEGRADED upstream, MOMENTS_ONLY upstream) | Composed becomes moments-only; `span_p_sd=NaN`. | Degraded provenance | `provenance.refusal_reasons` lists the offending primitive(s). `should_substitute` checks `composed.is_draw_coherent` and refuses to substitute moments-only output. |

No regressions surfaced during Stage 5c's test sweep. The skipped AP58 outside-in tests (BE not running) are identical to the documented Stage 5b baseline.

---

## 4. Suggested commit messages (per atom)

The skill does not commit. The following are suggested commit messages for each atom; the user decides timing and granularity.

| Atom | Files | Suggested message |
|---|---|---|
| 1 | `graph-editor/lib/runner/primitive_readout.py`, `graph-editor/lib/tests/test_multi_hop_subject_readout.py` | `73n stage 5c: tighten Stage 5b gate to exclude is_window — Stage 5b owns multi-hop cohort A==X only; multi-hop window deferred to Stage 5c (§708)` |
| 2 | `graph-editor/lib/runner/primitive_readout.py` | `73n stage 5c: multi-hop window readout — flag, gate, MultiHopWindowReadoutResult, compute_multi_hop_window_readout (§700-713)` |
| 3 | `graph-editor/lib/runner/cohort_forecast_v3.py` | `73n stage 5c: wire multi-hop window readout into compute_cohort_maturity_rows_v3 — shared row-builder seam alongside Stages 5a/5b (AP58 / STATS_SUBSYSTEMS §3.3)` |
| 4 | `graph-editor/lib/api_handlers.py` | `73n stage 5c: surface multi_hop_window_readout diag on cohort_maturity_v3 and conditioned_forecast responses (§710)` |
| 5 | `graph-editor/lib/tests/test_multi_hop_window_readout.py` | `73n stage 5c: multi-hop window readout tests — flag plumbing, eligibility, OFF/SHADOW/ON, soft skips, prior-only sub-span, diagnostics (§"Stage 5c" stop condition)` |
| 6 | `docs/current/project-bayes/73n-stage-5c-note.md`, `docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md` | `73n stage 5c: stage-5c note + mark stage 5c complete in progress block` |

---

## 5. What unblocks for later stages

- **Stage 6 (Carrier Consumer)** — the eligibility gate widens to admit active cohort `A != X`; a real `PrefixArrivalMap` (Stage 2's deliverable) replaces the synthetic identity-clock map; the carrier composer feeds a primitive-backed `carrier_to_x` into the substitution alongside the composed subject span. With Stage 5b + Stage 5c both landed and gates non-overlapping, Stage 6 cleanly extends the substitution surface for the third gate axis (active cohort A!=X) without touching the existing Stage 5b/5c logic.
- **Stage 7 (Caching)** — Stage 5c's binding policy `73n.stage_5c.multi_hop_window_readout.v1` distinguishes window-mode composed cache entries from Stage 5b's `73n.stage_5b.multi_hop_subject_span.v1`. When persistent caching lands, the disambiguation lets cohort A==X and window cutovers invalidate independently.
- **Stage 8 (Cross-Surface Projection and Provenance)** — rolls the `multi_hop_window_readout` block into the canonical CF response provenance schema alongside Stage 5a's `primitive_readout` and Stage 5b's `multi_hop_subject_readout` blocks. The three diagnostics are mutually exclusive by gate construction so one block per request is the steady state.
- **Stage 9 (Acceptance Tests)** — multi-hop `window(X-Z)` acceptance fixtures consume Stage 5c's substituted scalars; the F14 multi-hop window measurement against the maturity-corrected oracle lands here once Stage 5a follow-up #1 closes.

---

## 6. Open follow-ups (tracked for later resolution; NOT Stage 5c-blocking)

These items are recorded so they survive into the rest of 73n's plan.

### Follow-up 1 — Maturity-aware likelihood migration into the primitive (BLOCKS production flag-ON)

**Inherited from**: Stage 5a Follow-up #1 (5a note §5.1) and Stage 5b Follow-up #1 (5b note §6.1).

**Where**: `runner.primitive_conditioning.condition_primitive`. Plain Beta-Binomial conjugate posterior on the weighted view; the trajectory engine produces a per-cohort maturity-aware IS-conditioned posterior via `Binomial.pmf(k_c | n_c, p_s · CDF_s(τ_c))` reweighting.

**Why this blocks Stage 5c production flag-ON**: composed multi-hop window primitives carry the per-primitive likelihood gap forward, identical to Stage 5b's cohort A==X path.

**Target stage**: Stage 6 (with the likelihood migration as a Stage 6 prerequisite).

**How to detect closure**: F14 Q1 single-hop shadow delta `< 0.002`; multi-hop window measurement once likelihood migrates.

### Follow-up 2 — Predictive vs epistemic SD separation for multi-hop window (low priority, inherited)

Inherited from Stage 5b Follow-up #2. Same disposition; both `p_sd_primitive` and `p_sd_epistemic_primitive` carry the composed-draw SD on Stage 5c's surface as on Stage 5b's.

### Follow-up 3 — Active cohort A!=X gate widening (Stage 6, inherited)

Inherited from Stage 5b Follow-up #3. The cohort A!=X gate widening lands in Stage 6 and is independent of Stage 5c's window axis.

### Follow-up 4 — `subject_probability_source` enum on ForecastTrajectory (low priority, inherited)

Inherited from Stage 5a Follow-up #4 and Stage 5b Follow-up #4. Stage 5c adds `composed_subject_span_window` and `composed_subject_span_window_moments_only` labels to the per-edge readout block (not to the trajectory dataclass). Same disposition.

### Follow-up 5 — FE-controllable flag (deferred, inherited)

Inherited from Stage 5a Follow-up #5 and Stage 5b Follow-up #5. If the Stage 5a/5b flags promote to `ForecastingSettings`, Stage 5c's flag should too.

### Follow-up 6 — Diagnostic block volume on flag=off (low priority, inherited)

Inherited from Stage 5b Follow-up #6. The Stage 5c diagnostic adds another ~120 bytes/edge. Total volume on multi-hop window OFF responses is now ~360 bytes/edge across the three diagnostic blocks (Stage 5a is single-hop only, so it's mutually exclusive, but the row builder still allocates the empty diag dict early). If this becomes a concern, gate diag construction on `flag != off`.

---

## 7. Tracked failures and known-RED items (for plan closure)

This is the live ledger of items that MUST be resolved before 73n can ship as a whole. Every item has a target stage.

| Item | Status | Target stage | Re-test recipe |
|---|---|---|---|
| F14 Q1 / Q2 primitive-vs-legacy gap (likelihood migration) | **BLOCKING flag-ON for 5a + 5b + 5c** | Stage 6 (with follow-up #1) | F14 Q1 shadow delta `< 0.002`; F14 Q2 / multi-hop window measurement once likelihood migrates |
| AP58 strict-xfail #1: `test_single_hop_non_latent_upstream_collapses_to_window[FAST]` | xfailed (Stage 5a baseline) | Stage 5b + Stage 6 + likelihood migration | `pytest -k 'test_single_hop_non_latent_upstream_collapses_to_window' lib/tests/test_cohort_factorised_outside_in.py` with all three flags ON; expect XPASS |
| AP58 strict-xfail #2: same `[SLOW]` | xfailed | Stage 5b + Stage 6 + likelihood migration | same |
| AP58 strict-xfail #3: `test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel` | xfailed | Stage 5b + Stage 6 + likelihood migration | `pytest -k 'test_degenerate_identity_and_instant_carrier'` |
| AP58 strict-xfail #4: `test_multihop_non_latent_upstream_collapse` | xfailed | Stage 5b + Stage 5c + Stage 6 + likelihood migration | `pytest -k 'test_multihop_non_latent_upstream_collapse'` |
| `test_v3_midline_at_saturation_converges_to_p` (73m §1B carry-over) | failing (documented, not gated; not exercised in this in-process baseline) | not 73n | Re-evaluate at Stage 9 |

The four AP58 strict-xfail markers remain the regression net: they will surface as suite failures (XPASS strict) the moment Stage 6 + the likelihood migration close the remaining gaps.

---

## 8. Test totals snapshot

Stage 5c additions:

- 25 new multi-hop window readout tests (`test_multi_hop_window_readout.py`, parameterised on flag synonyms).

Stage 5b updates:

- 18 multi-hop subject readout tests (`test_multi_hop_subject_readout.py`) updated for the tightened gate; `test_eligible_multi_hop_window` removed and replaced with `test_ineligible_multi_hop_window_deferred_to_stage_5c`.

Existing test surfaces unchanged:

- 18 Stage 3 tests (`test_primitive_conditioning.py`) — green
- 14 Stage 1 tests (`test_primitive_contract.py`) — green
- 18 Stage 2 tests (`test_primitive_evidence.py`) — green
- 20 Stage 4 tests (`test_primitive_residual_guard.py`) — green
- 22 Stage 5a tests (`test_primitive_readout.py`) — green
- 11 Stage 5b composer tests (`test_subject_span_composer.py`) — green
- 15 prefix-arrival tests (`test_prefix_arrival.py`) — green
- 3 Stage 5a in-process integration tests (`test_primitive_readout_integration.py`) — green
- AP58 outside-in baseline (`test_cohort_factorised_outside_in.py`) — 2 passed / 36 skipped (BE not running on localhost:9000); identical to Stage 5b's documented in-process baseline

Total primitive-substrate suite: **172 tests green** (up from Stage 5b's 143).
