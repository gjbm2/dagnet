# Thread-Derived Before-Start Snapshot

This file is a changed-region reconstruction of the relevant files **before my refactor started**.

It is derived only from literal on-disk records of my tool calls:

- saved shell diff output `agent-tools/09fa1fa5-e04f-409c-879f-c4efc7c4115f.txt`
- saved shell diff output `agent-tools/952ef3dc-4aa9-4425-b7f6-d0e520c44fb1.txt`
- transcript record `agent-transcripts/4f218527-3ef6-45bc-9bfc-bbaa6a7bdc38.jsonl` for the `doc 66` patch

Only regions retained in those records are reproduced here. Unchanged lines outside those hunks are intentionally omitted rather than guessed.

## `graph-editor/lib/api_handlers.py`

```python
from runner.forecast_runtime import (
    build_prepared_runtime_bundle,
    get_cf_mode_and_reason,
    is_cf_sweep_eligible,
    should_enable_direct_cohort_p_conditioning,
)

_direct_cohort_p_conditioning = should_enable_direct_cohort_p_conditioning(
    is_window=is_window,
    is_multi_hop=False,
)
runtime_bundle = build_prepared_runtime_bundle(
    mode='window' if is_window else 'cohort',
    query_from_node=from_node_id,
    query_to_node=to_node_id,
    anchor_node_id=anchor_node_id,
    is_multi_hop=False,
    from_node_arrival=from_node_arrival,
    numerator_representation='factorised',
    p_conditioning_temporal_family=(
        'cohort' if _direct_cohort_p_conditioning else 'window'
    ),
    p_conditioning_source=(
        'direct_cohort_exact_subject'
        if _direct_cohort_p_conditioning
        else 'aggregate_evidence'
    ),
    p_conditioning_direct_cohort=_direct_cohort_p_conditioning,
    p_conditioning_evidence_points=len(evidence),
    p_conditioning_total_x=total_n,
    p_conditioning_total_y=total_k,
)

prepared_upstream = prepare_forecast_subject_entry(
    subj=donor_subject,
    subject_is_window=subject_is_window,
    log_prefix=log_prefix,
    anchor_from_override=af_widened,
    sweep_from_override=af_widened,
)
```

The handlers also still assembled their solve inputs locally instead of delegating to a shared runtime helper:

```python
from runner.forecast_runtime import (
    build_prepared_span_execution,
    build_prepared_runtime_bundle,
    find_edge_by_id,
    resolve_subject_cdf_start_node,
    should_use_anchor_relative_subject_cdf,
    should_enable_direct_cohort_p_conditioning,
)

# large local span-kernel / MC / carrier / runtime-bundle assembly
_v3_runtime_bundle = build_prepared_runtime_bundle(...)
...
_runtime_bundle = build_prepared_runtime_bundle(...)
```

## `graph-editor/lib/runner/cohort_forecast_v3.py`

```python
from .forecast_runtime import (
    PreparedForecastRuntimeBundle,
    XProvider,
    build_prepared_runtime_bundle,
    build_upstream_carrier,
    build_x_provider_from_graph,
    find_edge_by_id,
    get_cf_mode_and_reason,
    is_cf_sweep_eligible,
    should_enable_direct_cohort_p_conditioning,
)

...

if bundle is None:
    _direct_cohort_p_conditioning = (
        should_enable_direct_cohort_p_conditioning(
            is_window=is_window,
            is_multi_hop=is_multi_hop,
        )
    )
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

## `graph-editor/lib/runner/forecast_runtime.py`

```python
class PreparedConditioningEvidence:
    temporal_family: str = 'window'
    source: str = 'none'
    direct_cohort_enabled: bool = False
    evidence_points: int = 0
    total_x: Optional[float] = None
    total_y: Optional[float] = None


def should_enable_direct_cohort_p_conditioning(
    *,
    is_window: bool,
    is_multi_hop: bool,
) -> bool:
    """WP8's first landing: exact single-hop cohort subjects only."""
    return (not is_window) and (not is_multi_hop)


def build_prepared_runtime_bundle(...):
    p_conditioning_evidence=PreparedConditioningEvidence(
        temporal_family=(
            p_conditioning_temporal_family
            or ('window' if mode == 'window' else 'cohort')
        ),
        source=p_conditioning_source,
        direct_cohort_enabled=p_conditioning_direct_cohort,
        evidence_points=p_conditioning_evidence_points,
        total_x=p_conditioning_total_x,
        total_y=p_conditioning_total_y,
    )


def serialise_runtime_bundle(...):
    return {
        'p_conditioning_evidence': {
            'temporal_family': bundle.p_conditioning_evidence.temporal_family,
            'source': bundle.p_conditioning_evidence.source,
            'direct_cohort_enabled': (
                bundle.p_conditioning_evidence.direct_cohort_enabled
            ),
            'evidence_points': bundle.p_conditioning_evidence.evidence_points,
            'total_x': bundle.p_conditioning_evidence.total_x,
            'total_y': bundle.p_conditioning_evidence.total_y,
        }
    }
```

There was no shared `PreparedForecastSolveInputs`, no `_resolve_subject_temporal_mode()`, and no `prepare_forecast_runtime_inputs()` block in the retained baseline.

## `graph-editor/lib/runner/forecast_state.py`

```python
_x_median = np.median(X_total, axis=0)
if not np.any(_x_median > 1e-9):
    rate = p_draws[:S, None] * cdf_arr[:S]

rate_conditioned, is_ess, n_conditioned, Y_cond, X_cond, cohort_evals_cond = _run_cohort_loop(
    apply_is=True
)

for c in cohorts:
    if c.eval_age is not None and c.x_frozen > 0:
        t_i = min(c.eval_age, T - 1)
        _comp_draws += c.x_frozen * cdf_arr[:S, t_i]
        _comp_n += c.x_frozen
```

## `graph-editor/lib/tests/test_cf_query_scoped_degradation.py`

```python
captured.setdefault(
    'p_conditioning_direct_cohort',
    kwargs.get('p_conditioning_direct_cohort'),
)

assert captured['p_conditioning_source'] == 'direct_cohort_exact_subject'
assert captured['p_conditioning_direct_cohort'] is True
```

The explanatory `NOTE:` blocks were not present in the retained baseline hunks.

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
    band_level=0.90,
    axis_tau_max=axis_tau_max,
    anchor_node_id=anchor_node_id,
    is_multi_hop=is_multi_hop,
)
```

## `graph-editor/lib/tests/test_v2_v3_parity.py`

```python
preparation = SimpleNamespace(
    ...
    subject_is_window=False,
)

lambda **kwargs: captured.update({
    'p_conditioning_source': kwargs.get('p_conditioning_source'),
    'p_conditioning_direct_cohort': kwargs.get('p_conditioning_direct_cohort'),
}) or SimpleNamespace(...)

assert captured['p_conditioning_source'] == 'direct_cohort_exact_subject'
assert captured['p_conditioning_direct_cohort'] is True
```

## `docs/current/project-bayes/66-shared-cf-runtime-and-wp8-admission-plan.md`

```markdown
**Required changes**

- centralise subject resolution
- centralise temporal evidence-family selection for preparation
- centralise `ResolvedModelParams`
- centralise `carrier_to_x` and `subject_span`
- centralise degrade-versus-sweep eligibility
- centralise WP8 admission and evidence selection

**Exit guard**

For the same semantic question, the chart path and the CF path receive
the same prepared structural runtime and the same evidence-admission
decision.

### Stage 3 — Make the row builder projection-only

Reduce `cohort_forecast_v3` to projection logic over prepared inputs.

- stop local re-resolution of priors inside the row builder
- stop local re-creation of runtime policy inside the row builder
- stop local caller-dependent WP8 logic inside the row builder
- keep only the projection from prepared solve inputs to row outputs
```
