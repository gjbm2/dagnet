# CF Primitive Substrate

**Status**: Active reference, 12-May-26
**Scope**: the per-request primitive substrate that underlies the v3 conditioned-forecast runtime — contract types, evidence binding, the single conditioning locus, span composition, role-labelled readout. Companion to [FORECAST_RUNTIME_ARCHITECTURE.md](FORECAST_RUNTIME_ARCHITECTURE.md) (which describes the runtime that consumes the substrate) and [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) (which gives the semantic contract).

> New to the CF cluster? Read [CF_MAP.md](CF_MAP.md) first for orientation and the canonical reading order.

This doc is the entry point an agent needs to read **before** opening `primitives.py`, `primitive_evidence.py`, `primitive_conditioning.py`, `subject_span_composer.py`, or `primitive_readout.py`. Without it the modules look like a 5,000-line dataclass party.

---

## ⚠️ STOP — read this before adding any code

**Defensive coding inside the engine is dangerous and must be avoided.** No `or 0.0`, no `np.clip`, no `try/except: pass`, no `if x is None: return`, no `getattr(x, 'p', 0.0) or 0.0`, no fallback chains, no schema-shape `isinstance` forks. All defence lives at the perimeter ([INVARIANTS.md](INVARIANTS.md) I-47).

**Branching by case is the recurring failure mode** ([KNOWN_ANTI_PATTERNS.md](KNOWN_ANTI_PATTERNS.md) AP58). `window` vs `cohort`, single-hop vs multi-hop, latency vs non-latency, identity carrier vs active carrier — these are **degeneracies of one runtime object**, not different code paths. If you find yourself reaching for `if mode == ...` near the centre of a function, the factoring is wrong; fix the factoring, not the case.

The maintainer **constantly polices these patterns**. Where they already exist they are **debt to be retired gradually**, not precedent to extend. Rules: [CF_ENGINE_DISCIPLINE.md](CF_ENGINE_DISCIPLINE.md). Known violations: [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md) (21: 7 HIGH, 9 MEDIUM, 5 LOW). **Adding a new one will be reverted.** If existing code seems to justify a fallback ("the surrounding function does this already"), you are looking at debt — match the substrate's discipline, not the legacy code's.

When in doubt: **let it raise, let it propagate as NaN, let composition refuse**. Algebraic degenerate is the contract.

---

## 1. The five layers

> **Call order within a request**: the five substrate layers below describe a *data flow*. They are invoked together inside `build_resolved_cf_runtime` (Layer 5's `compute_resolved_runtime_readout` orchestrates Layers 2–4). Stage A as a whole sits **after** row layer 1 (frame evidence) and **before** row layers 2–8 (dual-prefix construction, reducer, projection). The full call order through the public entry is documented in [CF_ROW_PIPELINE.md §1a](CF_ROW_PIPELINE.md#1a-data-flow-vs-call-order).

```
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 1 — Contract types                  primitives.py             │
│   ConditionedTransitionPrimitive, PrimitiveScope, DrawFamilyKey,    │
│   ProbabilityPosterior, TimingPosterior, status enums.              │
│   No imports from runtime / state / composition.                    │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 2 — Evidence binding                primitive_evidence.py     │
│   bind_primitive_evidence: candidates + arrival weights →           │
│   WeightedPrimitiveEvidenceView.                                    │
│   RequestPrimitiveRegistry: one primitive per                       │
│   (transition, scope, prefix-arrival identity).                     │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 3 — Single conditioning locus       primitive_conditioning.py │
│   condition_primitive: bound evidence + resolved prior →            │
│   ConditionedTransitionPrimitive.                                   │
│   Multinomial-cell IS for latent timing; conjugate Beta-Binomial    │
│   for non-latent; doc-52 subset-policy blend at primitive layer.    │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 4 — Span composition                subject_span_composer.py  │
│   compose_primitive_span: registry + topology →                     │
│   ComposedPrimitiveSpan (reach + conditional CDF, per-draw).        │
│   Role-neutral — same composer for carrier and subject.             │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 5 — Role-labelled readout           primitive_readout.py      │
│   compute_resolved_runtime_readout: orchestrates all of the above   │
│   per request, plus unconditioned overlays for F-mode / model-curve │
│   bands. Returns ResolvedRuntimeReadoutResult; the v3 row builder   │
│   wraps it in ResolvedCFRuntime.                                    │
└─────────────────────────────────────────────────────────────────────┘
```

Adjacent helpers used by Layers 2-4: `prefix_arrival.py` (the `PrefixArrivalMap` keyed by calendar day, derived from the role-neutral timing algebra in `timing_span.py`), `timing_span.py` (DAG density DP over per-edge sub-probability densities, shared by both runtime composition and prefix-arrival construction), `span_kernel.py` (the underlying topology + forward DP shared by `timing_span` and the legacy span kernel), `primitive_residual_guard.py` (refusal taxonomy for unparameterised / complement / span-rejected edges — see [CF_RESIDUAL_GUARD.md](CF_RESIDUAL_GUARD.md)).

---

## 2. What a primitive is

A **`ConditionedTransitionPrimitive`** is a typed posterior over **one parameterised graph edge** under **one** `(scenario, role, date range, context, regime, source preference, anchor selection)` tuple.

```python
@dataclass(frozen=True)
class ConditionedTransitionPrimitive:
    transition: TransitionIdentity       # (source_node, destination_node, edge_id)
    scope: PrimitiveScope                # what request scope it lives under
    draw_count: int                      # S — fixed per request
    status: ConditioningStatus           # CONDITIONED / PRIOR_ONLY / STRUCTURALLY_DETERMINISTIC
                                         # / UNSUPPORTED_RESIDUAL / DEGRADED / UNAVAILABLE
    timing_family: TimingFamily          # LATENT / NON_LATENT / DETERMINISTIC

    raw_evidence_scope_key: str | None
    weighted_evidence: WeightedPrimitiveEvidenceView | None
    effective_evidence_totals: tuple[float, float] | None     # post-blend (n_eff, k_eff)
    subset_policy: SubsetPolicyProvenance | None              # doc-52 m_S/m_G/r
    compatibility_blend: CompatibilityBlendProvenance | None  # (1-r):r row mix
    residual_policy: ResidualPolicyProvenance | None          # why UNSUPPORTED_RESIDUAL

    probability_posterior: ProbabilityPosterior | None        # mean, sd, draws
    timing_posterior: TimingPosterior | None                  # cdf_mean, cdf_draws

    probability_prior: ProbabilityPosterior | None
    timing_prior: TimingPosterior | None

    draw_family_mode: DrawFamilyMode      # KEYED_PRIOR / REUSED_IS / MOMENTS_ONLY
    draw_family_key: DrawFamilyKey | None
    prior_source: str | None              # 'bayesian' / 'analytic' / ...
    skipped_evidence_summary: Mapping[str, Any]
    notes: tuple[str, ...]
```

The five primitive states:

| Status | When | `is_draw_coherent` | `probability_draws()` returns |
|---|---|---|---|
| `CONDITIONED` | Evidence was admitted and moved the posterior | True | Per-draw conditioned IS particles |
| `PRIOR_ONLY` | Evidence was empty (zero-row weighted view, all rows off-clock, or IS failed to find ESS-feasible λ) | True | Prior draws (`Beta(α, β)` samples) |
| `STRUCTURALLY_DETERMINISTIC` | Graph semantics fix `p` (no evidence consulted) | True | Constant draws at the deterministic `p` |
| `UNSUPPORTED_RESIDUAL` | Composition needed `1 − p` sibling, residual closure, or rejected a prepared span | False | Raises `DrawFamilyUnavailable` |
| `DEGRADED` | Arrival weights degraded (no path / horizon inadequate) — every row rejected off-clock | False | Raises `DrawFamilyUnavailable` |
| `UNAVAILABLE` | Reserved; not currently emitted | False | Raises `DrawFamilyUnavailable` |

`MOMENTS_ONLY` is a draw-family mode flag separate from status: a primitive that refused to act as a coherent draw family. Composition (Layer 4) collapses the whole composed span to moments-only as soon as **any** primitive in the span is moments-only.

---

## 3. Load-bearing invariants

These are the rules whose violation produces silent wrong answers. The substrate enforces them by construction; consumers must not relax them.

### 3.1 Single conditioning locus

`primitive_conditioning.condition_primitive` is **the only** place where evidence updates a posterior. Composition (Layer 4), readout (Layer 5), the selected-cohort reducer, the row projector, and the legacy trajectory engine all consume already-conditioned primitives — none re-condition.

This is what makes the primitive object a unit of work the result cache can key. Re-conditioning downstream would break draw-family coherence and bust the cache silently. See [INVARIANTS.md](INVARIANTS.md) I-48.

### 3.2 No fallbacks in the engine

"All defence at the perimeter; the engine is a mathematical object that degenerates algebraically." This is the user's stated principle, the audit's measuring stick, and the rule the codebase mostly honours and occasionally violates — see [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md) for the 21 known violations. I-47.

The audit captures all `or 0.0`, `np.clip`, `try/except` swallow, and `if x is None: return` patterns inside Layers 1–5 and the consumers of their output. New code in this area should be reviewed against the same rubric.

### 3.3 Draw-family coherence

Two consumers of the same primitive under the same scope **MUST** receive identical draws under matching indices. Layer 1's `DrawFamilyKey` is the contract; Layer 3's keyed-RNG seam (`make_rng(key, derivation)`) is how it's enforced. The 13 named derivations are listed in `primitives._DERIVATIONS`. See [DRAW_FAMILY_KEYING.md](DRAW_FAMILY_KEYING.md).

Failure mode if violated: a row builder reads a primitive's draws, a downstream consumer recomputes them with a different RNG, and the two answers diverge for reasons no test catches.

### 3.4 Role-neutral composition

`compose_primitive_span` does not know whether the span is a carrier (`A → X`) or a subject (`X → end`). Role is **data on the call**, not a separate composer. `ComposedPrimitiveSpan` exposes `reach`, `deterministic_cdf`, `span_p_draws`, `cdf_draws` — the meaning of those fields comes from the caller's role assignment in `ResolvedCFRuntime`.

### 3.5 Reach and conditional timing are separate

`span_p_mean` / `span_p_draws` is the asymptotic span probability. `cdf_mean` / `cdf_draws` is the **conditional** timing CDF, saturating to 1.0. They are independent surfaces; reach affects counts and denominator mass; it does **not** multiply displayed subject rates.

This is why the legacy trajectory engine (which collapsed them into a single `rate(τ) = p × CDF(τ)`) cannot serve cohort `A != X` queries correctly — Pop C arrivals at X have their **own** subject clock and reach factor.

### 3.6 MOMENTS_ONLY refusal at the contract layer

`primitives.ConditionedTransitionPrimitive.probability_draws()` raises `DrawFamilyUnavailable` for non-draw-coherent primitives. The composer cannot bypass this — there is no "synthesise a coherent draw family for a primitive that refused one" code path.

### 3.7 Single conditioning at the primitive level for doc-52 subset policy

The doc-52 mass-ratio policy (`r = min(m_S/m_G, 1)`) is applied **once**, in `primitive_conditioning._compute_subset_policy`. Composed consumers (`window()`, `subject_span`, `carrier_to_x`, projection) **must not** re-apply subset logic. The conditioned primitive carries the posterior outright. The retired in-trajectory blend (`forecast_state.compute_forecast_trajectory`'s `_compute_blend_params`) is documented in [CF_HOLD_OUT_ENGINES.md](CF_HOLD_OUT_ENGINES.md).

### 3.8 Structurally non-latency timing is provenance-only on μ/σ/onset

For `TimingFamily.NON_LATENT`, the timing posterior is a Dirac at τ=0 with `cdf_mean = (1.0, 1.0, ..., 1.0)`. `μ`, `σ`, `onset`, `completeness` are carried on `TimingPosterior.structural_identity_compat` for migration consumers but are **provenance only** — never evidence-conditioned timing parameters.

### 3.9 Two-clocks split

A request has **two** `PrefixArrivalMap`s in cohort `A != X` mode:

- The **carrier map** is rooted at A and binds carrier `A → X` primitives.
- The **subject map** is rooted at X, with X-day root weights derived from the carrier's reach to X (not the cohort A-anchor range). Subject primitives bind here.

`request_envelope.build_request_envelope_plan` builds both. The runtime consumes them. See `request_envelope.py:476-554` for the algebra and `cohort_forecast_v3.build_resolved_cf_runtime:1322-1405` for the consumption. `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` invariant 5 is the canonical statement. Pre-fix the runtime built its own carrier map with subject-target root support, which silently dropped early A-anchors from chart evidence — that bug is the historical motivation.

Window mode and `cohort(A = X)` have only one map (X-rooted, identity weights over the public window).

### 3.10 Identity carrier is data, not a route

`window()` and `cohort(A = X)` are degeneracies of the same runtime object. Their `composed_carrier` is `None`; the composer helpers treat `carrier is None` as identity; the selected-cohort reducer additionally checks `population_root == denominator_node` (semantic equality is authoritative even if a stray carrier object exists).

The implementation has a known unification gap: 20+ `if is_identity_carrier:` branches in `cohort_forecast_v3.py` and a separate `_synthesize_identity_carrier_observed_surface` helper. The design says "identity is data"; the code is mid-refactor toward that. AP58, audit H-5, and [CF_REFACTOR_TRACKERS.md](CF_REFACTOR_TRACKERS.md). I-45 is the canonical invariant ("one resolution path; cases differ by degeneration, not branching").

---

## 4. Trace through one request

The fastest way to internalise the substrate is to follow a single edge through it.

### 4.1 Identity (`primitives.TransitionIdentity` + `PrimitiveScope`)

A request walks the `X → end` subject topology and the `A → X` carrier topology (when active). For each edge it builds a `TransitionIdentity(source_node, destination_node, edge_id)` and a `PrimitiveScope` describing the request scope: `scenario_id`, `evidence_role`, `date_from`/`date_to`, `as_at`, `context_key`, `regime_key`, `model_source_preference`, `resolved_source_identity`, `selected_anchor_days`.

### 4.2 Prefix arrival (`prefix_arrival.PrefixArrivalMap`)

`build_prefix_arrival_map` composes per-edge timing primitives through `timing_span.compose_timing_span_from_transition_primitives` to produce `NodeArrivalWeights` for every parameterised source node. Each node's weights are a **calendar-day** distribution: "of the units that ever arrive at U, what fraction arrived on each day?"

Three topology cases: `identity` (root), `composed` (a real A → U arrival distribution), `degraded` (no path / horizon inadequate). Degraded primitives' rows are all rejected off-clock and the conditioner emits `DEGRADED`.

### 4.3 Evidence binding (`primitive_evidence.bind_primitive_evidence`)

The runtime translates the request's `evidence_superset_rows` into typed `EvidenceCandidate`s (via `evidence_adapters.py`), then for each primitive:

1. Builds an `EvidenceScope` from the primitive's local arrival support — the date range a row could plausibly land on for this U.
2. Calls `merge_evidence_candidates` (the shared evidence-merge library — **unchanged** by the substrate work).
3. Multiplies each admitted `EvidencePoint` by `arrival_weights.weight_on(observed_date)` to get `(n_weighted, k_weighted)`.
4. Emits a `WeightedPrimitiveEvidenceView`: floating-point weighted totals, plus a tuple of per-row `WeightedEvidenceRow`s carrying the row's `root_day_shares` for downstream A-clock placement.

Two crucial separations:

- The raw `EvidenceSet` keeps integer `n`/`k` totals for non-primitive callers; the weighted view's floats are confined to primitive evidence resolution.
- The merge layer is shared with every other evidence consumer. The substrate adds **only** the weighting step.

### 4.4 Conditioning (`primitive_conditioning.condition_primitive`)

This is the substrate's mathematical heart. Inputs: a `PrimitiveEvidenceResolution`, the per-edge `ResolvedModelParams` (the prior — Beta `(α, β)`, latency `(μ, σ, onset)` with their epistemic and predictive SDs), a `scenario_seed`, and `ConditioningPolicyOptions(draw_count, timing_cdf_max_tau)`.

The work happens in a **plan → evaluate → materialise** pipeline:

**Plan** (`_build_cohort_likelihood_plan`):
- Pass 1 (timing-family-independent) aggregates rows by `observed_date`, applying the §5 same-retrieval conflict rule, and selects one `_CohortLatest` per cohort. Produces `cohort_n_weighted_total`, `cohort_k_weighted_total`, `m_S_doc52`.
- Pass 2 (latent only) builds per-cohort multinomial τ-cell decompositions in `_CohortBucket` — one entry per retrieval (including zero-increment plateau cells), the trajectory's actual final τ as `last_observed_tau_idx`, and `last_k_weighted` for the residual cell.

The plan emits an `evaluable` flag and an `unevaluable_reason` (`no_evidence`, `no_timing_grid`, `no_latent_rows`).

**Evaluate** (`_evaluate_likelihood_plan`):
- Not evaluable → `prior_only` with reason.
- `NON_LATENT` → cohort-level Beta-Binomial conjugate update on `(cohort_n, cohort_k)` against the prior.
- `LATENT` → multinomial-cell importance sampling. Proposal: predictive Beta `(α_pred, β_pred)` for `p`, multivariate-normal for `(μ, σ, onset)` with `onset_mu_corr`. Per-cohort log-likelihood is the cell-by-cell multinomial: `Σᵢ (kᵢ − kᵢ₋₁)·log(p·(F(τᵢ) − F(τᵢ₋₁))) + (n_d − kₘ)·log(1 − p·F(τₘ))`. Tempering λ bisected to hit ESS ≥ 20; reaches λ=1 in the well-conditioned case. IS resample produces conditioned `p_draws` and joint `cdf_draws`.

**Materialise**:
- `prior_only` → `_make_prior_only_primitive` (status = `PRIOR_ONLY`, draws sampled from the prior under `'primitive_p_draws'` derivation).
- `conditioned` → `_apply_doc52_blend` mixes the conditioned and prior particles `(1-r):r` under one permutation (same index → same `(p, cdf)` pair, never mixed). Status = `CONDITIONED`. `effective_evidence_totals` is `(n_cohort × (1-r), k_cohort × (1-r))`.

Degraded topology (raw rows present but all off-clock because `arrival_weights[U]` is degraded) emits `_make_degraded_primitive` directly — prior posterior carried but `is_draw_coherent` is False so composers refuse it.

### 4.5 Span composition (`subject_span_composer.compose_primitive_span`)

Inputs: graph, `x_node_id`, `end_node_id`, the `RequestPrimitiveRegistry`, a callable `edge_to_primitive_lookup(from_id, to_id, edge_dict) → primitive`. The caller (Layer 5) supplies the lookup so the composer doesn't re-implement Stage 2's resolution logic.

The composer:

1. Builds the `X → end` topology via `span_kernel._build_span_topology`. Empty topology → `CompositionError`. Missing primitive for any required edge → `CompositionError`.
2. Checks draw-coherence across the span. Any single moments-only primitive collapses the result to moments-only.
3. Per draw `s` (when draw-coherent): builds per-edge per-draw density arrays from each primitive's `p_draws[s]` and timing draws, runs the forward DP at draw `s`, supplies `expected_reach_s` from `_topological_reach` so the asymptotic span probability is horizon-independent.
4. Returns `ComposedPrimitiveSpan(reach, cdf_mean, cdf_draws, span_p_draws, ...)`.

`expected_reach` is the key subtlety: without it the multi-edge convolution truncates at the finite grid and `density_cdf[T-1]` falls below `Π_i p_i_draws[s]` for slow spans. The reach supplied per draw decouples the asymptotic probability from `T`, which is what makes single-hop and multi-hop the same call site.

A process-memory cache wraps the composer keyed by topology + per-edge primitive identity (object `id()`); the upstream primitive cache pins identity across calls for the same scope and the snapshot-write bustcache flushes both together.

### 4.6 Role-labelled readout (`primitive_readout.compute_resolved_runtime_readout`)

This is the orchestrator. It:

1. Builds the two arrival maps (subject X-rooted; carrier A-rooted when active) if the caller hasn't pre-built them.
2. Walks the carrier and subject edge-resolution lists, running each edge through the residual guard (`primitive_residual_guard.classify_edge_requirement`) and then through `_prepare_one` — which calls `bind_primitive_evidence` + `condition_primitive` and registers the resulting primitive in the request's `RequestPrimitiveRegistry` (carrier primitives are registered under the carrier-map identity; subject primitives under the subject-map identity).
3. Calls `compose_primitive_span` twice: once for the carrier (`A → X`, skipped in identity-carrier mode), once for the subject (`X → end`).
4. Builds `unconditioned_overlays` keyed by dispersion basis (`'predictive'` for F-mode bands, optional `'epistemic'` for the model-curve overlay). Each overlay runs `compose_primitive_span` over a parallel set of prior-only primitives produced by `make_unconditioned_primitive`.
5. Computes shadow/acceptance band deltas (`SHADOW_ABS_BAND` / `ACCEPTANCE_ABS_BAND`) against the caller-supplied legacy moments — diagnostic only; v3 row paths pass no legacy moments.
6. Returns a `ResolvedRuntimeReadoutResult` with the composed spans, primitive registry, conditioned-primitive map, role-labelled provenance, and a `should_substitute` property.

`ResolvedCFRuntime` (in `cohort_forecast_v3.py`) is the request-level dataclass that wraps the readout result plus the runtime-resolved dual-prefix objects (`selected_source_day_mass`, `selected_x_prefix`, `selected_y_prefix`) used by the row pipeline. See [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md).

---

## 5. Things the substrate is NOT

- **Not a fetch engine.** Evidence rows arrive via `evidence_superset_rows` from the preparation layer (`forecast_preparation.py`, `request_envelope.py`). The substrate translates and binds; it never widens DB fetches. See [`docs/current/snapshot-fetch-envelope-design.md`](../snapshot-fetch-envelope-design.md).
- **Not a row builder.** Row schema (`midpoint`, `evidence_*`, `model_*`, `coverage`, `forecast_y`, `forecast_x`) is owned by `_project_runtime_rows` in `cohort_forecast_v3.py` — see [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md).
- **Not a hold-out engine consumer.** The funnel, daily-conversions, and cohort-maturity-derivation analytic engines bypass the substrate; their migration is post-v3 work. See [CF_HOLD_OUT_ENGINES.md](CF_HOLD_OUT_ENGINES.md).
- **Not the Bayes compiler.** `bayes/compiler/` fits aggregate posteriors offline and writes `model_vars[bayesian]` per edge. The substrate consumes those as priors via `ResolvedModelParams`; it does not run MCMC. See [PYTHON_BACKEND_ARCHITECTURE.md](PYTHON_BACKEND_ARCHITECTURE.md) §Bayesian, [BAYESIAN_ENGINE_RESEARCH.md](BAYESIAN_ENGINE_RESEARCH.md).
- **Not authoritative for residual / `1-p` sibling derivation.** Edge requirements that need adjacency complements or residual closures are refused with `UNSUPPORTED_RESIDUAL` per `primitive_residual_guard.classify_edge_requirement`. See [CF_RESIDUAL_GUARD.md](CF_RESIDUAL_GUARD.md).

---

## 6. Adjacent in-flight design trackers

The substrate is mid-refactor. Several decisions are still live in design-doc trackers under `docs/current/` (not yet promoted to `docs/current/codebase/`). Index in [CF_REFACTOR_TRACKERS.md](CF_REFACTOR_TRACKERS.md). The substrate code cites these by `§A.1`-style references; agents reading the code follow them there.

Most cited:

- `cohort-1apr-falling-k-problem-statement.md` (§A.1 / §A.3 / §A.4 / §A.6) — the dual-prefix object model.
- `cohort-maturity-evidence-coverage-design.md` — the coverage signal in row buckets.
- `selected-a-clock-retrieval-frontier-provenance-proposal.md` — strict observation-support frontiers per anchor.
- `snapshot-fetch-envelope-design.md` — fetch envelope construction at the preparation layer.
- [`cf-defensive-coding-audit.md`](../project-generalise/cf-defensive-coding-audit.md) — defensive-coding inventory; tracker is [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md).

---

## 7. Where to read next

- [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md) — the chart engine that consumes the substrate.
- [FORECAST_RUNTIME_ARCHITECTURE.md](FORECAST_RUNTIME_ARCHITECTURE.md) — the runtime object the substrate produces.
- [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md) — the semantic contract the substrate honours.
- [FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md](FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md) — stage-by-stage semantic pseudo-code.
- [DRAW_FAMILY_KEYING.md](DRAW_FAMILY_KEYING.md) — the keyed-RNG contract.
- [CF_RESIDUAL_GUARD.md](CF_RESIDUAL_GUARD.md) — edge-requirement classification.
- [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md) — what the engine still gets wrong (tracker).
- [INVARIANTS.md](INVARIANTS.md) — I-45, I-46, I-47, I-48.
