# Draw-Family Keying (Keyed RNG)

**Status**: Active reference, 12-May-26
**Scope**: the keyed-RNG seam that replaces legacy fixed seeds (`seed=42|43|71`) across the CF primitive substrate, the runtime, and the trajectory engine. Lives in `primitives.py`.

This is a small contract module — 13 named derivations, one canonical-string format, one `make_rng(key, derivation)` function. The contract is small; the **consequences of getting it wrong** are large: two consumers of the same primitive under the same scope MUST receive identical draws. Without that, composition cannot honour draw-family coherence and the cache cannot key primitives correctly.

---

## The contract in one sentence

> Two consumers presenting the same `DrawFamilyKey` under the same scope MUST receive identical posterior draws under matching draw indices.

That's it. Everything else is mechanism to enforce it.

---

## `DrawFamilyKey`

```python
@dataclass(frozen=True)
class DrawFamilyKey:
    transition_identity: TransitionIdentity   # (source_node, destination_node, edge_id)
    scope: PrimitiveScope                     # request scope (see CF_PRIMITIVE_SUBSTRATE §4.1)
    draw_count: int                           # S — fixed per request
    scenario_seed: int                        # caller-context label (see §"Caching" below)

    def canonical_string(self) -> str: ...
    @property
    def digest(self) -> str: ...
    def as_seed_int(self) -> int: ...
```

The `canonical_string` is the stable serialisation that determines draw identity:

```
73n.draw_family_key.v2
| src=<source_node>
| dst=<destination_node>
| edge=<edge_id>
| role=<scope.evidence_role>
| date_from=<scope.date_from>
| date_to=<scope.date_to>
| as_at=<scope.as_at or ''>
| context=<scope.context_key or ''>
| regime=<scope.regime_key or ''>
| source_pref=<scope.model_source_preference>
| resolved_source=<scope.resolved_source_identity or ''>
| anchor_days=<comma-joined scope.selected_anchor_days>
| S=<draw_count>
```

Atom 2 v2 deliberately **drops** `scenario_id` and `scenario_seed` from the canonical string. They are caller-context labels — not part of the conditioned-posterior mathematical identity. The result-cache key already binds priors and bound evidence; identical math across scenarios should share draws.

`digest` is `sha256(canonical_string)[:16]` hex. `as_seed_int` takes the first 8 bytes as an int — used to derive numpy RNG seeds.

---

## The 13 named derivations

```python
_DERIVATIONS = {
    "primitive_p_draws":           "73n.derivation.primitive_p_draws.v1",
    "primitive_timing_draws":      "73n.derivation.primitive_timing_draws.v1",
    "primitive_is_resampling":     "73n.derivation.primitive_is_resampling.v1",
    "primitive_drift":             "73n.derivation.primitive_drift.v1",
    "primitive_completeness_sd":   "73n.derivation.primitive_completeness_sd.v1",
    "doc52_blend_permutation":     "73n.derivation.doc52_blend_permutation.v1",
    "node_arrival_cache":          "73n.derivation.node_arrival_cache.v1",
    "subject_span_full_path_mc":   "73n.derivation.subject_span_full_path_mc.v1",
    "subject_span_epistemic_overlay":
                                   "73n.derivation.subject_span_epistemic_overlay.v1",
    "anchor_relative_edge_p_mc":   "73n.derivation.anchor_relative_edge_p_mc.v1",
    "anchor_relative_edge_epistemic":
                                   "73n.derivation.anchor_relative_edge_epistemic.v1",
    "last_edge_frontier_cdf":      "73n.derivation.last_edge_frontier_cdf.v1",
    "legacy_upstream_carrier_v3":  "73n.derivation.legacy_upstream_carrier_v3.v1",
}
```

Each derivation gives an independent RNG stream from the same `DrawFamilyKey`. Two consumers reading `primitive_p_draws` from the same key see the same `p` samples; two consumers reading `primitive_timing_draws` from the same key see the same `(μ, σ, onset)` particles; the streams are independent of each other.

The list is closed: unknown derivations to `make_rng` raise `ValueError`. New derivations must be added with rationale tied to a specific draw-site identified in code review.

What each derivation is used for:

| Derivation | Where | Purpose |
|---|---|---|
| `primitive_p_draws` | `primitive_conditioning.condition_primitive`, `make_unconditioned_primitive`, `_make_prior_only_primitive` | The `p` draw stream per primitive |
| `primitive_timing_draws` | Same | The `(μ, σ, onset)` multivariate-normal stream per primitive |
| `primitive_is_resampling` | `_evaluate_likelihood_plan` IS resample step | Resampling indices for IS reweighting |
| `primitive_drift` | `forecast_state.compute_forecast_trajectory._run_cohort_loop` | Per-cohort drift draws (legacy trajectory engine) |
| `primitive_completeness_sd` | `compute_completeness_with_sd` | Completeness uncertainty (200 MC draws) |
| `doc52_blend_permutation` | `_apply_doc52_blend` | Permutation for `(1-r):r` conditioned-vs-prior particle mix |
| `node_arrival_cache` | `build_node_arrival_cache` | Per-node MC arrival CDFs (legacy whole-graph carrier) |
| `subject_span_full_path_mc` | `forecast_runtime.prepare_forecast_runtime_inputs` | Pre-substrate full-path subject-span MC |
| `subject_span_epistemic_overlay` | Same (retired) | Pre-substrate epistemic overlay MC |
| `anchor_relative_edge_p_mc` | Same | Edge-level `p` MC for anchor-relative subject CDF |
| `anchor_relative_edge_epistemic` | Same (retired) | Edge-level epistemic MC |
| `last_edge_frontier_cdf` | Same | Last-edge frontier CDF for multi-hop window subjects |
| `legacy_upstream_carrier_v3` | Legacy callers | Pre-substrate upstream carrier MC |

Several derivations (`subject_span_epistemic_overlay`, `anchor_relative_edge_epistemic`) are post-73n retired — the runtime's `unconditioned_overlays['epistemic']` owns the tight-band model curve now. Their keys are preserved for stream-identity compatibility with legacy callers.

---

## `make_rng(key, derivation)`

```python
def make_rng(key: DrawFamilyKey, derivation: str) -> np.random.Generator:
    if derivation not in _DERIVATIONS:
        raise ValueError(...)
    payload = key.canonical_string() + "||" + _DERIVATIONS[derivation]
    digest = hashlib.sha256(payload.encode("utf-8")).digest()
    seed_int = int.from_bytes(digest[:8], "big")
    return np.random.default_rng(seed=seed_int)
```

Two-step seeding: combine the canonical string with the derivation tag, hash to 8 bytes, seed numpy. The numpy `Generator` is the only randomness source called downstream — there is no other RNG path in the substrate.

---

## What replaced what

Pre-73n the runtime had three fixed-seed RNG constants scattered across the codebase:

- `np.random.default_rng(seed=42)` — primitive draws, span MC, node arrival cache, cohort loops.
- `np.random.default_rng(seed=43)` — doc-52 blend permutation.
- `np.random.default_rng(seed=71)` — completeness uncertainty.

The retirement is partial: `forecast_runtime.prepare_forecast_runtime_inputs` still names "Fixed-seed retirement" in comments and routes through `_request_scoped_key('subject_span_full_path_mc')` etc., but the legacy trajectory engine `compute_forecast_trajectory` retains a `_trajectory_fallback_draw_family_key` for callers that don't supply a key. That fallback derives `scenario_id` from the resolved model's `(alpha, beta, n_effective, src)` so two calls with matching resolved parameters reuse the same stream.

[`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md) does not flag the legacy fallback as a defensive-code violation — it is a documented bridge.

---

## Why scenario_id is excluded from identity

Two requests with the same math but different scenario labels **must** seed the same RNG. Atom 2 v2 retirement of scenario_id from `canonical_string` enforces this.

The pre-Atom-2 behaviour leaked scenario_id into the synthetic edge_id at a few call sites (`forecast_runtime.py` `_request_scoped_key` and `forecast_state.py` `_trajectory_fallback_draw_family_key`). Both have been corrected to exclude scenario_id from the synthetic `edge_id` and the `scope.scenario_id` (set to `''`) — so canonical_string is independent of caller-context labels.

Failure mode if violated: two scenarios with identical math (e.g. the same `window(-90d:)` against the same graph) get different draws, the per-particle quantile bands differ, and a parity test catches it. The Atom 2 v2 retirement fixed exactly this.

---

## Cache identity: separate from RNG identity

The result-cache for conditioned primitives (`primitive_conditioning._primitive_cache_key`) uses a **separate** identity from `DrawFamilyKey.canonical_string`. It captures:

- The `DrawFamilyKey.canonical_string` (which already includes everything about the request scope).
- The merged `EvidenceSet.provenance.scope_key`.
- Per-row weighted evidence (`evidence_scope_key`, totals, per-row `(observed_date, retrieved_at, n, k, n_weighted, k_weighted)` tuple).
- Resolved model priors (`alpha`, `beta`, `alpha_pred`, `beta_pred`, `n_effective`, latency moments).
- Conditioning options (`draw_count`, `timing_cdf_max_tau`).
- `prior_source`, `resolved_source`.

Two calls that differ in any of these produce a distinct cache key; two calls that match in all of them produce the same posterior deterministically.

The composed-span cache (`subject_span_composer._subject_span_cache`) uses object identity (Python `id()`) of each consumed primitive plus topology. Snapshot-write `cache_clear` flushes the whole registry.

---

## Adding a new derivation

If a new draw site needs an independent stream:

1. Identify the call site and the rationale (why this stream needs to be independent of the existing 13).
2. Add a new entry to `_DERIVATIONS` with a `73n.derivation.<name>.v1` tag.
3. Call `make_rng(key, '<name>')` at the new site.
4. Document the addition in this doc's §"The 13 named derivations" table.

The version suffix (`.v1`) is for stream-identity rollover — if a derivation's draw-site needs to break stream compatibility (e.g. you changed the order of draws within the consumer), bump to `.v2` so existing keys produce a fresh stream rather than silently drifting.

---

## What goes wrong if this gets broken

Three failure modes, all silent:

1. **Two consumers of the same primitive disagree on draws.** Row builder reads `primitive.probability_draws()`, downstream consumer rebuilds with a different RNG, the per-particle composition diverges. No test catches it unless it asserts on specific quantile values.
2. **Cache key collides across distinct evidence.** If `canonical_string` leaks something that should be part of identity (or omits something that should be part of identity), the cache can hand out a posterior that doesn't match the inputs.
3. **Scenario-context leakage.** If `scenario_id` re-enters `canonical_string` via a synthetic `edge_id`, two scenarios with the same math draw different streams. Parity tests catch this in CI but agents can introduce it by accident if they don't know the rule.

For rule 1 — the contract this doc enforces — the only safe pattern is: **call `make_rng(key, '<derivation>')` for every random draw, never `np.random.default_rng(seed=<int>)` directly, never `np.random.<func>(...)` on the module-level RNG**. The substrate enforces this by construction; legacy modules (`forecast_state`, parts of `forecast_runtime`) have been migrated but the bridge fallback paths remain.

---

## Cross-references

- [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md) §3.3 — draw-family coherence as a substrate invariant.
- `primitives.py:104-195` — the `DrawFamilyKey`, `_DERIVATIONS`, and `make_rng` definitions.
