# Thread-Derived After-Reversion Snapshot

This file is a changed-region reconstruction of the relevant files **after I finished the partial reversion**.

It is derived only from literal on-disk records of my tool calls:

- saved shell diff output `agent-tools/09fa1fa5-e04f-409c-879f-c4efc7c4115f.txt`
- transcript record `agent-transcripts/4f218527-3ef6-45bc-9bfc-bbaa6a7bdc38.jsonl` for the `doc 66` patch

Only regions retained in those records are reproduced here. Unchanged lines outside those hunks are intentionally omitted rather than guessed.

## `graph-editor/lib/api_handlers.py`

```python
from runner.forecast_runtime import (
    build_prepared_runtime_bundle,
    get_cf_mode_and_reason,
    is_cf_sweep_eligible,
)

runtime_bundle = build_prepared_runtime_bundle(
    mode='window' if is_window else 'cohort',
    query_from_node=from_node_id,
    query_to_node=to_node_id,
    anchor_node_id=anchor_node_id,
    is_multi_hop=False,
    from_node_arrival=from_node_arrival,
    numerator_representation='factorised',
    p_conditioning_source='aggregate_evidence',
    p_conditioning_evidence_points=len(evidence),
    p_conditioning_total_x=total_n,
    p_conditioning_total_y=total_k,
)

prepared_upstream = prepare_forecast_subject_entry(
    subj=donor_subject,
    subject_is_window=True,
    log_prefix=log_prefix,
    anchor_from_override=af_widened,
    sweep_from_override=af_widened,
)
```

Both handler paths now delegate their runtime assembly through the shared helper:

```python
from runner.forecast_runtime import (
    build_prepared_span_execution,
    find_edge_by_id,
    prepare_forecast_runtime_inputs,
)

_prepared_runtime_v3 = prepare_forecast_runtime_inputs(
    graph_data=graph_data,
    query_from_node=query_from_node,
    query_to_node=query_to_node,
    anchor_node_id=anchor_node,
    last_edge_id=last_edge_id,
    is_window=is_window,
    is_multi_hop=preparation.is_multi_hop,
    composed_frames=composed_frames,
    path_per_edge_results=per_edge_results,
    upstream_per_edge_results=per_edge_results,
    axis_tau_max=axis_tau_max,
    upstream_anchor_from=subjects[0].get('anchor_from', ''),
    upstream_anchor_to=subjects[0].get('anchor_to', ''),
    upstream_sweep_from=subjects[0].get('sweep_from', subjects[0].get('anchor_from', '')),
    upstream_sweep_to=subjects[0].get('sweep_to', subjects[0].get('anchor_to', '')),
    candidate_regimes_by_edge=scenario.get('candidate_regimes_by_edge', {}),
    upstream_observation_fetcher=_fetch_upstream_observations,
    upstream_log_prefix='[v3] upstream:',
    p_conditioning_source='snapshot_frames',
    p_conditioning_evidence_points=len(composed_frames),
    include_epistemic_overlay=True,
)

_prepared_runtime = prepare_forecast_runtime_inputs(
    graph_data=graph_data,
    query_from_node=query_from_node,
    query_to_node=query_to_node,
    anchor_node_id=anchor_node,
    last_edge_id=last_edge_id,
    is_window=is_window,
    is_multi_hop=preparation.is_multi_hop,
    composed_frames=composed_frames,
    path_per_edge_results=per_edge_results,
    upstream_per_edge_results=(
        list(all_per_edge_results.values()) if is_whole_graph else per_edge_results
    ),
    axis_tau_max=axis_tau_max,
    upstream_anchor_from=subj_group[0].get('anchor_from', ''),
    upstream_anchor_to=subj_group[0].get('anchor_to', ''),
    upstream_sweep_from=subj_group[0].get('sweep_from', subj_group[0].get('anchor_from', '')),
    upstream_sweep_to=subj_group[0].get('sweep_to', subj_group[0].get('anchor_to', '')),
    candidate_regimes_by_edge=scenario.get('candidate_regimes_by_edge', {}),
    upstream_observation_fetcher=_fetch_upstream_observations,
    upstream_log_prefix='[forecast] upstream:',
    p_conditioning_source='snapshot_frames',
    p_conditioning_evidence_points=len(composed_frames),
    include_epistemic_overlay=False,
)
```

The row-builder calls still pass `runtime_bundle`, but no longer pass `edge_cdf_arr`, `det_span_p`, or `display_settings` in the retained net hunks.

## `graph-editor/lib/runner/cohort_forecast_v3.py`

```python
from .forecast_runtime import (
    PreparedForecastRuntimeBundle,
    build_prepared_runtime_bundle,
    build_upstream_carrier,
    build_x_provider_from_graph,
    find_edge_by_id,
    get_cf_mode_and_reason,
    is_cf_sweep_eligible,
)

...

if bundle is None:
    _direct_cohort_p_conditioning = False
    bundle = build_prepared_runtime_bundle(
        mode='window' if is_window else 'cohort',
        query_from_node=query_from_node,
        query_to_node=query_to_node,
        anchor_node_id=anchor_node_id,
        is_multi_hop=is_multi_hop,
        x_provider=x_provider_local,
        from_node_arrival=from_node_arrival_local,
        numerator_representation='factorised',
        p_conditioning_temporal_family=(
            'cohort' if _direct_cohort_p_conditioning else 'window'
        ),
        p_conditioning_source=(
            'direct_cohort_exact_subject'
            if _direct_cohort_p_conditioning
            else 'frame_evidence'
        ),
        p_conditioning_direct_cohort=_direct_cohort_p_conditioning,
        ...
    )
```

The monolithic `compute_cohort_maturity_rows_v3(...)` API is back; the prepare-step split is gone in the retained post-reversion diff.

## `graph-editor/lib/runner/forecast_runtime.py`

```python
class PreparedConditioningEvidence:
    temporal_family: str = 'window'
    source: str = 'none'
    evidence_points: int = 0
    total_x: Optional[float] = None
    total_y: Optional[float] = None


def build_prepared_runtime_bundle(...):
    del p_conditioning_direct_cohort

    p_conditioning_evidence=PreparedConditioningEvidence(
        temporal_family=(p_conditioning_temporal_family or 'window'),
        source=p_conditioning_source,
        evidence_points=p_conditioning_evidence_points,
        total_x=p_conditioning_total_x,
        total_y=p_conditioning_total_y,
    )


def serialise_runtime_bundle(...):
    return {
        'p_conditioning_evidence': {
            'temporal_family': bundle.p_conditioning_evidence.temporal_family,
            'source': bundle.p_conditioning_evidence.source,
            'evidence_points': bundle.p_conditioning_evidence.evidence_points,
            'total_x': bundle.p_conditioning_evidence.total_x,
            'total_y': bundle.p_conditioning_evidence.total_y,
        }
    }


def should_enable_direct_cohort_p_conditioning(
    *,
    is_window: bool,
    is_multi_hop: bool,
) -> bool:
    del is_window, is_multi_hop
    return False


@dataclass
class PreparedForecastSolveInputs:
    subject_temporal_mode: str = 'window'
    is_multi_hop: bool = False
    anchor_relative_subject_cdf: bool = False
    span_x_node_id: Optional[str] = None
    edge_kernel: Optional[Any] = None
    det_norm_cdf: Optional[List[float]] = None
    det_span_p: Optional[float] = None
    span_alpha: Optional[float] = None
    span_beta: Optional[float] = None
    span_params: Optional[SpanParams] = None
    span_params_epi: Optional[SpanParams] = None
    mc_cdf_arr: Optional[Any] = None
    mc_p_s: Optional[Any] = None
    mc_cdf_arr_epi: Optional[Any] = None
    mc_p_s_epi: Optional[Any] = None
    edge_cdf_arr: Optional[Any] = None
    x_provider: Optional[XProvider] = None
    x_provider_overlay: Optional[XProvider] = None
    resolved_override: Optional[Any] = None
    runtime_bundle: Optional[PreparedForecastRuntimeBundle] = None


def _resolve_subject_temporal_mode(...):
    if is_window:
        return 'window'
    if anchor_node_id and query_from_node and anchor_node_id != query_from_node:
        return 'cohort'
    return 'window'


def prepare_forecast_runtime_inputs(...):
    result.subject_temporal_mode = _resolve_subject_temporal_mode(...)
    ...
    return result
```

## `graph-editor/lib/runner/forecast_state.py`

```python
_x_median = np.median(X_total, axis=0)
_needs_fallback = _x_median <= 1e-9
if np.any(_needs_fallback):
    fallback_cdf = cdf_arr[:S].copy()
    if upstream_cdf_mc is not None and reach > 0:
        ...
        fallback_cdf[s, :] = np.clip(
            np.convolve(upstream_pdf[s], cdf_arr[s, :T], mode='full')[:T],
            0.0,
            1.0,
        )
    rate[:, _needs_fallback] = (
        p_draws[:S, None] * fallback_cdf[:, _needs_fallback]
    )

apply_rate_conditioning = not bool(
    getattr(resolved, 'alpha_beta_query_scoped', False)
)
rate_conditioned, is_ess, n_conditioned, Y_cond, X_cond, cohort_evals_cond = _run_cohort_loop(
    apply_is=apply_rate_conditioning,
)

for c in cohorts:
    if c.eval_age is None:
        continue
    _comp_weight = float(c.x_frozen) if c.x_frozen > 0 else float(c.a_pop or 0.0)
    if _comp_weight <= 0:
        continue
    t_i = min(c.eval_age, T - 1)
    _comp_draws += _comp_weight * cdf_arr[:S, t_i]
    _comp_n += _comp_weight
```

## `graph-editor/lib/tests/test_cf_query_scoped_degradation.py`

```python
# NOTE:
# The provenance assertions below still describe the intended live
# contract after doc-57-style "no re-conditioning" handling.
# ...
# a structural reason: the dedicated degraded latency-row branch was
# deleted, so these rows are now produced by the shared engine path...

assert captured['p_conditioning_source'] == 'aggregate_evidence'

# NOTE:
# This test is intentionally coupled to the old daily-conversions
# degraded branch...
```

The captured `p_conditioning_direct_cohort` field and its assertion are gone in the retained post-reversion diff.

## `graph-editor/lib/tests/test_cohort_maturity_v3_contract.py`

```python
return compute_cohort_maturity_rows_v3(
    frames=frames,
    graph=graph,
    target_edge_id=target_edge_id,
    query_from_node=query_from_node,
    query_to_node=query_to_node,
    anchor_from=anchor_from,
    anchor_to=anchor_to,
    sweep_to=sweep_to,
    is_window=is_window,
    axis_tau_max=axis_tau_max,
    anchor_node_id=anchor_node_id,
    is_multi_hop=is_multi_hop,
    band_level=0.90,
)
```

## `graph-editor/lib/tests/test_v2_v3_parity.py`

```python
preparation = SimpleNamespace(
    ...
    subject_is_window=True,
)

lambda **kwargs: captured.update({
    'p_conditioning_source': kwargs.get('p_conditioning_source'),
}) or SimpleNamespace(...)

assert captured['p_conditioning_source'] == 'snapshot_frames'
```

## `docs/current/project-bayes/66-shared-cf-runtime-and-wp8-admission-plan.md`

```markdown
**Required changes**

- centralise subject resolution
- centralise temporal evidence-family selection for preparation
- centralise `ResolvedModelParams`
- centralise prepared `subject_span` execution inputs, including the
  deterministic-versus-MC span-kernel setup
- centralise `carrier_to_x` and `x_provider`
- centralise any multi-hop last-edge helper CDF still required by the
  projection layer
- centralise degrade-versus-sweep eligibility
- centralise WP8 admission and evidence selection
- assemble one authoritative `PreparedForecastRuntimeBundle`
- extract the duplicated runtime-assembly block out of
  `_handle_cohort_maturity_v3` and the scoped path inside
  `handle_conditioned_forecast`

The immediate next implementation cut for v3-versus-CF unification is
that handler extraction.

**Exit guard**

For the same semantic question, the chart path and the CF path receive
the same prepared structural runtime and the same evidence-admission
decision.

In practical terms, both handlers should then do only four things:

- perform shared subject and frame preparation
- call the authoritative runtime builder
- call `compute_cohort_maturity_rows_v3`
- project the returned solve into consumer-specific outputs

### Stage 3 — Make the row builder projection-only

Reduce `cohort_forecast_v3` to projection logic over the authoritative
prepared inputs.

- stop local re-resolution of priors inside the row builder
- stop local re-creation of runtime policy inside the row builder
- stop local caller-dependent WP8 logic inside the row builder
- stop assembling span-kernel inputs, `carrier_to_x`, `x_provider`, or
  helper CDFs inside the row builder
- keep only the projection from prepared solve inputs to row outputs
```
