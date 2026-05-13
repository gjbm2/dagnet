# CF Map — Orientation

**Status**: Active reference, 13-May-26
**Scope**: one-page orientation to the conditioned-forecast (CF) / `cohort_maturity_v3` machinery — file → role lookup, end-to-end stage flow, and the required reading order for the deeper docs. Read this **first** before opening any CF code or the topic-specific docs.

> The CF cluster is documented across ~10 codebase docs plus active design trackers. Without orientation it is easy to read three of them in the wrong order and emerge with a partial mental model. This page is the index.

---

## 1. 30-second mental model

A `cohort_maturity_v3` (or `conditioned_forecast`) request enters a single HTTP route and threads through **four code layers**:

1. **Dispatch** — string-match by `analysis_type` to a handler.
2. **Preparation** — DSL → subjects → snapshot DB fetch with regime selection → composed frames + per-edge derivation results → request envelope plan. [`FORECAST_PREPARATION.md`](FORECAST_PREPARATION.md)
3. **Runtime** — composed frames + candidates → primitive conditioning → composed subject/carrier spans → `ResolvedCFRuntime`. [`FORECAST_RUNTIME_ARCHITECTURE.md`](FORECAST_RUNTIME_ARCHITECTURE.md), [`CF_PRIMITIVE_SUBSTRATE.md`](CF_PRIMITIVE_SUBSTRATE.md)
4. **Row pipeline** — `ResolvedCFRuntime` → dual-prefix objects → selected-cohort reducer → per-τ rows. [`CF_ROW_PIPELINE.md`](CF_ROW_PIPELINE.md)

Persistence (which fields apply back to the graph) is owned by [`FORECAST_STACK_DATA_FLOW.md`](FORECAST_STACK_DATA_FLOW.md). Semantic correctness is owned by [`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md).

---

## 2. End-to-end flow

```
   HTTP POST /api/runner/analyze
        │
        │  api_handlers.handle_runner_analyze:598
        │  → _handle_runner_analyze_impl:632
        │  → string-match on analysis_type
        ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ DISPATCH                api_handlers._handle_cohort_maturity_v3  │
   └──────────────┬───────────────────────────────────────────────────┘
                  │
                  │  per scenario:
                  ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ PREPARATION                                                      │
   │   resolve_forecast_subjects                                      │
   │     → analysis_subject_resolution.resolve_analysis_subjects      │
   │   prepare_forecast_subject_group                                 │
   │     → build_request_envelope_plan                                │
   │     → prepare_forecast_subject_entry (per subject)               │
   │         → query_snapshots_for_sweep                              │
   │         → apply_temporal_regime_selection                        │
   │         → derive_cohort_maturity                                 │
   │     → compose_path_maturity_frames                               │
   │   → ForecastPreparation                                          │
   └──────────────┬───────────────────────────────────────────────────┘
                  │
                  │  ForecastPreparation (composed_frames, per_edge_results,
                  │                       envelope_plan, anchor_node, …)
                  ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ ROW BUILDER ENTRY     cohort_forecast_v3.compute_cohort_         │
   │                       maturity_rows_v3:5974                      │
   │                                                                  │
   │   1. resolve_model_params                                        │
   │   2. build_cohort_evidence_from_frames        ◄  row layer 1     │
   │   3. _aggregate_request_candidates                               │
   │   4. build_resolved_cf_runtime                ◄  SUBSTRATE STAGE │
   │      → primitive_readout.compute_resolved_runtime_readout        │
   │   5. _root_window_carrier_n_by_anchor_day     ◄  row layer 2     │
   │   6. _build_selected_source_day_mass          ◄  row layer 3     │
   │   7. _build_carrier_only_denominator_prefix   ◄  row layer 4     │
   │   8. _build_selected_a_clock_evidence_from_runtime               │
   │                                                ◄  row layers 5+6 │
   │   9. _project_runtime_rows                    ◄  row layers 7+8  │
   └──────────────┬───────────────────────────────────────────────────┘
                  │
                  │  List[maturity_row]
                  ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ RESPONSE ENVELOPE        api_handlers._handle_cohort_maturity_v3 │
   │   → {success, subject_id, result:{maturity_rows, frames,         │
   │      cf_mode, cf_reason, runtime_provenance}, …}                 │
   └──────────────────────────────────────────────────────────────────┘
```

Key call-order subtlety: row layer 1 (frame evidence) runs **before** the substrate; row layers 2–8 run **after**. The substrate stage is sandwiched. See [`CF_ROW_PIPELINE.md` §1a](CF_ROW_PIPELINE.md) for the detailed interleave.

---

## 3. File → role map

### Preparation (between HTTP and runtime)

| File | Role |
|---|---|
| `lib/api_handlers.py` | HTTP route handler; dispatch by `analysis_type` |
| `lib/analysis_subject_resolution.py` | DSL → resolved subjects; scope rules; sweep bound calculation |
| `lib/query_dsl.py` | Formal grammar parser (`parse_query`, `ParsedQuery`); does **not** parse `cohort()` |
| `lib/runner/forecast_preparation.py` | Per-subject snapshot fetch with regime selection; frame composition; envelope-plan construction |
| `lib/runner/request_envelope.py` | `build_request_envelope_plan`; two-clocks split; per-edge fetch bounds |
| `lib/snapshot_service.py` | Snapshot DB queries (`query_snapshots_for_sweep`) |
| `lib/snapshot_regime_selection.py` | Per-date regime family selection |
| `lib/runner/cohort_maturity_derivation.py` | Per-edge derivation: raw rows → anchor-day frames |
| `lib/runner/span_evidence.py` | `compose_path_maturity_frames` — multi-edge frame merge |

### Runtime (substrate)

| File | Role |
|---|---|
| `lib/runner/primitives.py` | `ConditionedTransitionPrimitive`, `TransitionIdentity`, `PrimitiveScope`, `DrawFamilyKey`, RNG keying |
| `lib/runner/primitive_evidence.py` | `bind_primitive_evidence`; `WeightedPrimitiveEvidenceView`; per-primitive evidence-merge layer |
| `lib/runner/primitive_conditioning.py` | `condition_primitive` — **the only** conditioning locus; Beta-Binomial conjugate update; multinomial-cell IS; doc-52 blend |
| `lib/runner/primitive_residual_guard.py` | Edge requirement taxonomy (`PARAMETERISED`, `UNSUPPORTED_RESIDUAL`, …) |
| `lib/runner/prefix_arrival.py` | `PrefixArrivalMap`, `build_prefix_arrival_map` — per-edge τ distribution from upstream prefix |
| `lib/runner/timing_span.py` | DAG density DP; shared by runtime composition and prefix-arrival construction |
| `lib/runner/span_kernel.py` | Underlying topology + forward DP; shared by `timing_span` |
| `lib/runner/subject_span_composer.py` | `compose_primitive_span` → `ComposedPrimitiveSpan` (role-neutral) |
| `lib/runner/primitive_readout.py` | `compute_resolved_runtime_readout` — orchestrates substrate, builds spans + overlays |
| `lib/runner/forecast_runtime.py` | `prepare_forecast_runtime_inputs`, `resolve_model_params`, `find_edge_by_id`, `get_cf_mode_and_reason` |
| `lib/runner/edge_binding_descriptor.py` | `build_candidates_for_descriptor` — superset rows → typed candidates |
| `lib/runner/evidence_adapters.py` | Adapter layer between superset rows and `EvidenceCandidate` shape |

### Row pipeline (in `cohort_forecast_v3.py`)

| Function | Role |
|---|---|
| `compute_cohort_maturity_rows_v3:5974` | Public entry; orchestrates everything below |
| `build_cohort_evidence_from_frames:5563` | Frame → `engine_cohorts`, epoch boundaries, observed prefixes (identity) |
| `_aggregate_request_candidates:911` | Flatten target / per-edge-subject / per-edge-upstream pools → one `request_evidence_candidates` |
| `build_resolved_cf_runtime:1235` | Construct `ResolvedCFRuntime`; calls `compute_resolved_runtime_readout` |
| `ResolvedCFRuntime` (dataclass) | Request-scoped object owning conditioning, composition, projection-facing provenance |
| `_root_window_carrier_n_by_anchor_day` | Active `a_pop` per anchor; root-window admission rule |
| `_build_selected_source_day_mass` | `M_select(U, C, u)` — per subject primitive source-day mass |
| `_build_carrier_only_denominator_prefix` | `X_prefix(C, τ)` — denominator cumulative mass |
| `_build_rate_attributed_subject_prefix` | `Y_prefix(C, τ)` — numerator cumulative mass |
| `_build_active_selected_a_clock_evidence_from_runtime` | Build `SelectedAClockEvidence` cell surface |
| `_join_conditioned_carrier_backmap` | Subject row placement onto A-clock |
| `_selected_cohort_group_rate_draws` | E+F reducer — per-particle `ΣY(τ)/ΣX(τ)` |
| `_project_runtime_rows` | Per-τ row emission; quantiles reducer draws; coverage signals |
| `_attach_cf_row_metadata` | Stamp first row with provenance / cf_mode |
| `build_superset_candidates_by_edge:841` | Subject-edge superset rows → candidates |
| `build_carrier_superset_candidates_by_edge:816` | Carrier-edge superset rows → candidates |

### Hold-outs (parallel paths bypassing the substrate)

| File | Role |
|---|---|
| `lib/runner/funnel_engine.py` | Funnel analysis (doc 52); legacy, F-1 unification target |
| `lib/runner/daily_conversions_derivation.py` | Daily conversions chart; legacy |
| `lib/runner/cohort_maturity_derivation.py` (NB: also used by preparation per-edge) | Legacy single-edge derivation |
| `lib/runner/forecast_state.py` | Legacy trajectory engine — **do not add new callers** |
| `lib/runner/epistemic_bands.py` | Reads `_posteriorSlices.fit_history` |

See [`CF_HOLD_OUT_ENGINES.md`](CF_HOLD_OUT_ENGINES.md) for migration status.

---

## 4. Required reading order

### For first contact with the CF cluster

1. [`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) — **semantic contract**: carrier vs subject, Pop C vs Pop D, factorised vs gross-fitted, the seam invariant.
2. **This doc** — orientation; you already have it.
3. [`FORECAST_PREPARATION.md`](FORECAST_PREPARATION.md) — how the runtime's inputs are built.
4. [`FORECAST_RUNTIME_ARCHITECTURE.md`](FORECAST_RUNTIME_ARCHITECTURE.md) — what `ResolvedCFRuntime` carries and the live flow inside the row builder entry.
5. [`CF_PRIMITIVE_SUBSTRATE.md`](CF_PRIMITIVE_SUBSTRATE.md) — substrate detail (skip on first pass; return when opening `primitives.py` / `primitive_*.py`).
6. [`CF_ROW_PIPELINE.md`](CF_ROW_PIPELINE.md) — row layer detail; dual-prefix objects; the epoch model.
7. [`FORECAST_STACK_DATA_FLOW.md`](FORECAST_STACK_DATA_FLOW.md) — surrounding I/O and persistence (read when working at the FE↔BE boundary).

### Reference (consult as needed)

| Need | Doc |
|---|---|
| Defensive coding rules / known violations | [`CF_DEFENSIVE_FINDINGS.md`](CF_DEFENSIVE_FINDINGS.md) |
| Edge requirement classification | [`CF_RESIDUAL_GUARD.md`](CF_RESIDUAL_GUARD.md) |
| RNG keying / draw families | [`DRAW_FAMILY_KEYING.md`](DRAW_FAMILY_KEYING.md) |
| Hold-out engines / migration status | [`CF_HOLD_OUT_ENGINES.md`](CF_HOLD_OUT_ENGINES.md) |
| `§A.*` references in code comments | [`CF_REFACTOR_TRACKERS.md`](CF_REFACTOR_TRACKERS.md) |
| Semantic pseudo-code | [`FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md`](FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md) |
| DSL parsing (FE + BE) | [`DSL_PARSING_ARCHITECTURE.md`](DSL_PARSING_ARCHITECTURE.md) |
| `cohort_maturity` date model | [`DATE_MODEL_COHORT_MATURITY.md`](DATE_MODEL_COHORT_MATURITY.md) |
| Snapshot fetch envelope | [`docs/current/snapshot-fetch-envelope-design.md`](../snapshot-fetch-envelope-design.md) |
| Load-bearing rules | [`INVARIANTS.md`](INVARIANTS.md) — especially I-45 (one resolution path), I-47 (no engine defence), I-48 (single conditioning locus) |

---

## 5. The discipline (don't extend the debt)

Across the CF docs you will see banner warnings about defensive coding inside the engine. The short form, stated once:

- **No fallbacks inside the engine.** `or 0.0`, `np.clip`, `try/except: pass`, `if x is None: return` are anti-patterns. Defence lives at the perimeter.
- **No case-forks near the centre.** `is_window`, `is_identity_carrier`, single-hop vs multi-hop, latent vs non-latent are **degeneracies of one runtime object**, not separate paths.
- **Engine degenerates algebraically.** Missing values propagate as NaN; missing keys raise; out-of-shape inputs refuse at the perimeter. The 21 known violations ([`CF_DEFENSIVE_FINDINGS.md`](CF_DEFENSIVE_FINDINGS.md)) are debt to retire, not precedent.

This applies wherever you edit `cohort_forecast_v3.py`, the `primitive_*` modules, `subject_span_composer.py`, `prefix_arrival.py`, `timing_span.py`, or `span_kernel.py`.

---

## 6. The single load-bearing facts

If you remember nothing else:

- **`ResolvedCFRuntime`** is the one request-scoped object that owns conditioning, composition, and projection-facing provenance. Everything in the row pipeline reads it; nothing else owns this state.
- **`request_evidence_candidates`** is the one canonical evidence pool. Every consumer reads from the same flat sequence; per-primitive merge filters by identity. ([`CF_ROW_PIPELINE.md` §1b](CF_ROW_PIPELINE.md))
- **Single conditioning locus**: `primitive_conditioning.condition_primitive` is the only place evidence updates a posterior. ([`INVARIANTS.md`](INVARIANTS.md) I-48)
- **Two-clocks split** in active cohort: subject map rooted at X (with X-day weights from carrier reach); carrier map rooted at A. They answer different questions.
- **Identity carrier is data, not a route.** `window()` and `cohort(A=X)` are degeneracies of the active path with `composed_carrier = None`. ([`INVARIANTS.md`](INVARIANTS.md) I-45)
