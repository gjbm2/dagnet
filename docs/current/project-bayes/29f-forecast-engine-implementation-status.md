# 29f — Forecast Engine: Implementation Status & Remaining Work

**Date**: 14-Apr-26
**Depends on**: doc 29 (design), doc 29e (implementation plan)
**Purpose**: honest audit of what has been built vs the design, with
status per item and defects found.

---

## Phase 0: Parity Gates (v1 → v2)

**Accepted as passed for now.** Single-hop parity gate passed. Multi-hop
and v2 promotion are deferred quality work.

### 0.1 Single-hop parity gate
- [x] **DONE** — v1 vs v2 field-by-field. Tests in `test_doc31_parity.py`.

### 0.2 Multi-hop acceptance
- [ ] **DEFERRED** — no multi-hop parity test exists.

### 0.3 Promote v2 as default
- [ ] **DEFERRED** — v2 is registered but not the default.

---

## Phase 1: Promoted Model Resolver

### 1.1 Define resolver interface
- [x] **DONE** — `ResolvedModelParams`, `ResolvedLatency` dataclasses
  in `lib/runner/model_resolver.py`.

### 1.2 Implement resolver
- [x] **DONE** — `resolve_model_params(edge, scope, temporal_mode)`
  implemented. Handles preference cascade (bayesian → analytic_be →
  analytic → manual), scope (edge|path), temporal_mode (window|cohort).
- [ ] **DEFERRED** — Existing call sites not migrated. These serve
  v2 (frozen) and snapshot analysis which return a richer dict than the
  resolver currently provides (source_curves, alpha/beta,
  evidence_retrieved_at). Migration requires extending the resolver
  significantly and will be done when v3 replaces v2 (Phase 5).
  Call sites:
  - `_read_edge_model_params()` in `api_handlers.py` (lines 855, 1939,
    1998) — line 855 serves v2 (frozen); lines 1939/1998 serve snapshot
    analysis.
  - `read_edge_cohort_params()` in `cohort_forecast.py` — v2 infra
    (frozen).
  - `_resolve_promoted_source()`, `_resolve_completeness_params()` in
    `api_handlers.py` — serve v2/snapshot analysis.

### 1.3 Tests
- [x] **DONE** — 8 tests in `test_model_resolver.py`. Covers scope,
  preference cascade, missing data.
- [ ] **INCOMPLETE** — No parity test vs `_read_edge_model_params` on
  real graph data confirming identical output.

### Exit gate status
**PARTIAL.** Resolver exists and is tested, but the four existing call
sites have not been migrated. The resolver is only used by the Phase 2
`completeness_stdev` computation in `api_handlers.py` (line 3749).

---

## Phase 2: Window-Mode ForecastState

### 2.1 Define ForecastState contract
- [x] **DONE** — `ForecastState`, `Dispersions`, `TrajectoryPoint`
  dataclasses in `lib/runner/forecast_state.py`.
- [ ] **INCOMPLETE** — No Pydantic models added to `graph_types.py`.
  Uses plain dataclasses instead.
- [x] **DONE** — `ForecastState` interface added to `src/types/index.ts`.

### 2.2 Window-mode forecast function
- [x] **DONE** — `compute_forecast_state_window()` in
  `forecast_state.py`. Computes completeness, completeness_sd,
  rate_unconditioned, rate_conditioned, tau_observed.
- [x] **DONE** — `compute_completeness_with_sd()` — 200-draw MC
  sampling from latency dispersions with onset_mu_corr.
- [x] **DONE** — `_compose_rate_sd()` — independence assumption
  composition of p and completeness uncertainties.
- [ ] **INCOMPLETE** — `forecast_application.py` not refactored. Design
  says to refactor `compute_completeness` to also return SD or add
  companion function. Instead a parallel implementation was created.

### 2.3 Inject into BE topo pass
- [x] **DONE** — `api_handlers.py` `handle_stats_topo_pass` calls
  `compute_forecast_state_window` per edge and returns ForecastState
  as a nested object alongside flat scalars (backward compat).
- [x] **DONE** — `beTopoPassService.ts` `BeTopoEdgeResult` includes
  `forecast_state` typed field.
- [x] **DONE** — `fetchDataService.ts` writes `forecast_state` to
  `edge.p.forecast_state` when present.
- [x] **DEFECT FOUND AND FIXED** — `fetchDataService.ts` was writing BE
  topo pass mu/sigma/onset directly to `edge.p.latency.*`, bypassing
  the promotion cascade. Fixed: removed those overwrites.

### 2.4 Tests
- [x] **DONE** — 12 tests in `test_forecast_state_window.py`. Covers
  basic completeness, SD non-zero with dispersions, SD zero without,
  mature limit, onset_mu_corr, conditioned vs unconditioned.
- [x] **DONE** — 3 tests in `test_be_topo_pass_parity.py`. Topo pass
  completeness vs v2 annotated completeness (0.16% delta).
- [x] **DONE** — 2 tests in `test_completeness_stdev_vs_v2.py`. Engine
  SD vs brute-force MC SD (ratio 0.3–3.0).

### Exit gate status
**MOSTLY DONE.** Core computation works and is tested. ForecastState is
now returned from the BE topo pass per edge and consumed on the FE side.
Remaining gaps: Pydantic models in `graph_types.py` (uses dataclasses
instead), `forecast_application.py` not refactored (parallel
implementation in `forecast_state.py`).

---

## Phase 3: Cohort-Mode ForecastState

### 3.1 Per-node arrival cache
- [x] **DONE** — `NodeArrivalState` dataclass in `forecast_state.py`
  with `deterministic_cdf`, `mc_cdf`, `reach`, `evidence_obs`, `tier`.
- [x] **DONE** — `build_node_arrival_cache()` walks graph in topo order,
  calls v2's `build_upstream_carrier` (Tier 1/2/3) per node, caches
  result keyed by node UUID.

### 3.2 Cohort-mode forecast function
- [x] **DONE** — `compute_forecast_state_cohort()` in
  `forecast_state.py`. Uses `NodeArrivalState` from the per-node cache.
  Evaluates upstream-aware completeness via convolution of carrier's
  deterministic CDF with edge CDF. completeness_sd from MC draws.
- [x] **DONE** — Calls frozen v2 carrier functions (`build_upstream_carrier`,
  `read_edge_cohort_params`) — does not reimplement them.

### 3.3 Inject into BE topo pass
- [x] **DONE** — `handle_stats_topo_pass` builds per-node arrival
  cache for cohort-mode queries and calls
  `compute_forecast_state_cohort` for cohort-mode edges,
  `compute_forecast_state_window` for window-mode edges.

### 3.4 Tests
- [x] **DONE** — `test_forecast_state_cohort.py` with 6 tests:
  anchor has delta arrival, downstream has carrier, multi-hop reach
  propagates, single-edge matches window, multi-edge completeness is
  upstream-aware (25% lower than edge-only), completeness_sd present.
- [ ] **INCOMPLETE** — `test_forecast_propagation.py` not created.
  Parity test against v2 row builder not yet written.

### Known limitation: no IS conditioning in topo pass
The topo pass calls `build_upstream_carrier` with `upstream_obs=None`
and `cohort_list=[]`, so IS conditioning (lines 766-790 in v2) never
fires. Tier 1 draws are unconditioned.

This is correct for `asat <= now`: the topo pass has observed data up
to the frontier and doesn't need to forecast upstream arrivals. The
unconditioned proposal gives a wider (more conservative) completeness_sd,
which is appropriate for edge display.

For `asat > now` (forward projection, Phase 7.2), the topo pass would
need IS conditioning to constrain upstream forecasts against observed
history. This requires passing frame-level upstream observations into
the carrier — data the topo pass doesn't currently receive. Deferred
to Phase 7.2.

### Exit gate status
**MOSTLY DONE.** Core computation implemented using v2 carrier hierarchy.
Per-node cache works. Wired into BE topo pass. Tests pass on synth
data. Remaining: parity test against v2 row builder's completeness at
tau_observed.

---

## Phase 4: Consumer Migrations

### 4.1 Edge bead ± correction
- [~] **PARTIAL** — `edgeBeadHelpers.tsx` reads
  `completeness_stdev` from the edge and formats as "5d / 70% ± 5%".
  But this reads from the flat scalar, not from ForecastState. Does not
  distinguish E/F/F+E regimes as designed.

### 4.2 Edge display (chevron, quality tier)
- [ ] **INCOMPLETE** — No quality tier badge. Completeness chevron still
  reads from `latency.completeness`, not ForecastState.

### 4.3 Surprise gauge migration
- [ ] **INCOMPLETE** — Not started.

### 4.4 Edge card / completeness overlay migration
- [ ] **INCOMPLETE** — Not started.

### 4.5 Tests
- [ ] **INCOMPLETE** — No consumer migration tests.

### Exit gate status
**NOT STARTED** (aside from partial bead display).

---

## Phase 5: cohort_maturity_v3

- [ ] **INCOMPLETE** — Not started. All sub-items (5.1–5.5) outstanding.

---

## Phase 6: Parity and Contract Tests

- [ ] **INCOMPLETE** — Not started.

---

## Phase 7: Future Enhancements

- [ ] **INCOMPLETE** — Not started (by design — these are post-Phase 3).

---

## Blocking prerequisite: Synth graph enrichment tooling

**Problem**: Phase 3 parity tests need synth graphs with Bayesian
model_vars (probability, latency with SDs, quality metadata, promoted
fields). No synth graph currently has model_vars — `synth_gen.py`
creates snapshot data in the DB and latency params on edges, but
doesn't run Bayes or write model_vars.

**Approach**: use the existing production code path
(`bayesPatchService.ts` → `upsertModelVars` → `applyPromotion`) via a
new FE CLI command. This ensures the enriched graph has exactly the
same field layout as a real Bayes run — no Python reimplementation of
the TS field mapping.

### Step 1: CLI `--apply-patch` subcommand

Add a `--apply-patch <file>` mode to `graph-editor/src/cli/commands/bayes.ts`.

**Input**: a JSON file containing the `webhook_payload_edges` output
from `fit_graph` (the same shape the Bayes webhook sends).

**Behaviour**:
1. Load the graph from disk via `diskLoader.ts`
2. For each edge in the patch payload, extract `window()` and
   `cohort()` slices from the unified slices dict
3. Call `upsertModelVars(edge.p, bayesEntry)` with the Bayesian
   `ModelVarsEntry` built from the slices — same construction as
   `bayesPatchService.ts` lines 361-392
4. Call `applyPromotion(edge.p, graphPref)` — writes promoted fields
5. Write the enriched graph back to disk

**Files touched**:
- `graph-editor/src/cli/commands/bayes.ts` — new `--apply-patch` mode
- Imports from `modelVarsResolution.ts` (already pure functions,
  no browser dependencies)

**Validation**: the CLI command should print per-edge what it wrote
(source, p.mean, mu, sigma, onset, SDs, path params, quality gate).

### Step 2: Harness integration

Extend `bayes/test_harness.py` with a `--enrich` flag that:
1. Runs `fit_graph` on the synth graph (or reads cached result)
2. Writes the `webhook_payload_edges` to a temp JSON file
3. Calls the FE CLI `--apply-patch` with that file
4. Verifies the enriched graph has model_vars on every fitted edge

**Files touched**:
- `bayes/test_harness.py` — new `--enrich` flag

This means enriching a synth graph is: `python bayes/test_harness.py
--graph synth-simple-abc --enrich --no-webhook`.

### Step 3: Enrichment verification test

A fast test (no MCMC) that loads an already-enriched synth graph and
verifies:
- Every edge with latency has a `model_vars` entry with
  `source='bayesian'`
- The entry has `probability.mean`, `probability.stdev`
- The entry has `latency.mu`, `sigma`, `t95`, `onset_delta_days`,
  `mu_sd`, `sigma_sd`, `onset_sd`, `onset_mu_corr`
- Path-level fields present when the edge has path params
- `quality.gate_passed` is set
- Promoted fields match: `latency.mu == model_vars[bayesian].latency.mu`,
  `promoted_mu_sd == model_vars[bayesian].latency.mu_sd`, etc.
- `p.forecast.mean` is set (from posterior p)

This test validates the enrichment itself before using enriched graphs
for parity tests.

**Files touched**:
- `graph-editor/lib/tests/test_forecast_state_cohort.py` — add
  enrichment verification tests

### Step 4: Phase 3 parity test (the actual exit gate)

Using the enriched synth graph + DB snapshot data:
1. Run v2 in cohort mode on an edge with upstream → extract
   per-data-point completeness from annotated frames
2. Run `compute_forecast_state_cohort` with the same edge, same
   cohorts, same `NodeArrivalState` from `build_node_arrival_cache`
3. Assert completeness values agree within tolerance

Also:
- Run v2 in window mode → compare against
  `compute_forecast_state_window`
- Check `completeness_sd` is consistent with v2's MC fan width at
  `tau_observed`

**Files touched**:
- `graph-editor/lib/tests/test_forecast_state_cohort.py` — parity
  tests using enriched synth graph

### Dependency chain

```
Step 1 (CLI --apply-patch)          ✅ DONE (14-Apr-26)
  │
  ▼
Step 2 (harness --enrich)           ✅ DONE (14-Apr-26)
  │
  ▼
Step 3 (enrichment verification)    ✅ DONE (14-Apr-26)
  │
  ▼
Step 4 (Phase 3 parity test — exit gate)
```

Steps 1-2 are dev tooling, now implemented. Step 3 (verification) is
covered by `cliApplyPatch.test.ts` (15 tests: promoted values, model_vars,
quality gate, parameter file posteriors, path-level fields). Step 4 is the
actual Phase 3 exit gate that uses enriched synth graphs.

---

## Schema Changes

### Implemented
- [x] `latency.completeness_stdev` added to:
  - `src/types/index.ts` (`LatencyConfig` interface)
  - `lib/graph_types.py` (`LatencyConfig` Pydantic model)
  - `public/schemas/conversion-graph-1.1.0.json`

### Not implemented
- [x] `ForecastState` interface added to `src/types/index.ts`
- [ ] No ForecastState Pydantic model in `graph_types.py`

---

## Documentation

### Implemented
- [x] `docs/current/project-bayes/29-generalised-forecast-engine-design.md`
  — design doc, substantially rewritten.
- [x] `docs/current/project-bayes/29e-forecast-engine-implementation-plan.md`
  — phased plan.
- [x] `docs/current/codebase/39-schema-cleanup-proposal.md` — separate
  schema cleanup proposal (not part of engine work).

### Not implemented
- [ ] Public docs: `lag-statistics-reference.md` — no engine section.
- [ ] Public docs: `forecasting-settings.md` — not updated.
- [ ] Public docs: `glossary.md` — no new terms.
- [ ] Public docs: `user-guide.md` — no ± section.
- [ ] Public docs: `CHANGELOG.md` — no release entry.
- [ ] Codebase docs: `STATISTICAL_DOMAIN_SUMMARY.md` — not updated.
- [ ] Codebase docs: `FE_BE_STATS_PARALLELISM.md` — not updated.

---

## Defects Found

### D1: BE scalar overwrite bypasses promotion (FIXED)
`fetchDataService.ts` wrote BE topo pass mu/sigma/onset directly to
`edge.p.latency.*`, clobbering Bayesian posteriors that promotion had
already placed. Fixed: removed those overwrites, kept only fields the
BE genuinely adds.

### D2: Topo pass re-fits mu/sigma for Bayesian edges (PRE-EXISTING)
`compute_edge_latency_stats` in `stats_engine.py` always re-derives
mu/sigma from cohort median/mean lag via heuristic fitting +
`improve_fit_with_t95`. This runs even for edges with Bayesian
posteriors. The re-fitted values are used for the topo pass's own
completeness CDF, blend calculations, and are returned in the response.
This is a faithful port of the FE topo pass behaviour — the FE does the
same. But it means the topo pass completeness uses heuristic params, not
the promoted Bayesian params. The Phase 2 `completeness_stdev`
computation correctly uses `resolve_model_params` (promoted params), so
there is an inconsistency within the same response: `completeness` uses
heuristic params, `completeness_stdev` uses promoted params.

### D3: Wrong test file exists — FIXED
`test_cohort_mode_completeness_parity.py` deleted. Proper Phase 3 tests
created in `test_forecast_state_cohort.py`.

### D4: Tier 1 DRIFT_FRACTION = 0.20 crippled IS conditioning — FIXED
`cohort_forecast_v2.py` line 139: the Tier 1 carrier generated MC draws
with `DRIFT_FRACTION = 0.20` — only 20% of the posterior SD. This was
cargo-culted from the per-cohort drift context (different purpose) when
v2 was written. With IS conditioning active (lines 762-790), the narrow
proposal meant all draws were near-identical → uniform weights →
conditioning was a no-op.

**Fixed**: changed to `DRIFT_FRACTION = 2.0` (overdispersed proposal,
standard IS practice). IS conditioning can now differentiate draws and
reweight meaningfully against observed upstream arrivals.

---

### D5: Reach-scaling bug in `_convolve_completeness_at_age` (FIXED 14-Apr-26)

`forecast_state.py` `_convolve_completeness_at_age` divided the
convolution result by `reach`. This was incorrect because:

1. The carrier CDF from `build_upstream_carrier` is **conditional** —
   it goes to 1.0 (meaning "given you reach this node, probability of
   arriving by age u"). Confirmed empirically: CDF[200] = 1.000,
   reach = 0.697.

2. Completeness in cohort mode is **x-denominated** (y/x, not y/a).
   It answers "of eventual converters on this edge, what fraction have
   completed by age τ?" — a conditional quantity going to 1.0.

3. The convolution of a conditional PDF (integrates to 1) with the
   edge CDF (goes to 1) already gives the correct conditional path
   completeness. No reach scaling needed.

The `/reach` inflated completeness by ~1/reach (~43% for reach=0.70),
producing a 9% n-weighted parity delta against v2's path CDF.

**Fixed**: removed the `/reach` divisor. The `reach` parameter is now
vestigial in the function signature (passed but unused by the MC path
and the deterministic path). Parity delta dropped from 9% to 1.75%.

The residual 1.75% delta is expected: the engine convolves discretised
carrier PDF × edge CDF (edge-level mu/sigma), while v2 evaluates a
single CDF with fitted path-level params (path_mu/path_sigma). These
are different approximations — the convolution is numerically exact
for the given carrier, while path-level params are a lognormal fit to
the composed distribution.

---

## Summary

| Phase | Status | Key gap |
|-------|--------|---------|
| 0 | Accepted | Multi-hop acceptance + v2 promotion deferred |
| 1 | Partial | Resolver exists; call site migration deferred (v2 infra) |
| 2 | Mostly done | ForecastState returned from topo pass; promotion fix done; `forecast_application.py` not refactored |
| 3 | **PASSED** | Parity test passes (1.75% delta). Enrichment tooling done (Steps 1-4). Reach-scaling bug fixed (D5). Schema cleanup: `forecast_state` sidecar removed — engine writes to existing fields per doc 29 §Schema Change. |
| 4 | Not started | Partial bead display only |
| 5 | Not started | — |
| 6 | Not started | — |
| 7 | Not started | By design |
