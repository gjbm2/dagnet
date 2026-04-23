# Thread-Derived Net Diff

This is the selected net diff between the reconstructed before-start state and the reconstructed after-reversion state.

Sources:

- `agent-tools/09fa1fa5-e04f-409c-879f-c4efc7c4115f.txt`
- transcript `agent-transcripts/4f218527-3ef6-45bc-9bfc-bbaa6a7bdc38.jsonl` for the `doc 66` hunk

## `graph-editor/lib/api_handlers.py`

```diff
@@ def _compute_surprise_gauge(
-        should_enable_direct_cohort_p_conditioning,
@@
-    _direct_cohort_p_conditioning = should_enable_direct_cohort_p_conditioning(
-        is_window=is_window,
-        is_multi_hop=False,
-    )
@@
-        p_conditioning_temporal_family=(
-            'cohort' if _direct_cohort_p_conditioning else 'window'
-        ),
-        p_conditioning_source=(
-            'direct_cohort_exact_subject'
-            if _direct_cohort_p_conditioning
-            else 'aggregate_evidence'
-        ),
-        p_conditioning_direct_cohort=_direct_cohort_p_conditioning,
+        p_conditioning_source='aggregate_evidence',
```

```diff
@@ def _fetch_upstream_observations(
-    subject_is_window: bool,
@@
-                subject_is_window=subject_is_window,
+                subject_is_window=True,
```

```diff
@@ def _handle_cohort_maturity_v3(...):
-            build_prepared_runtime_bundle,
-            resolve_subject_cdf_start_node,
-            should_use_anchor_relative_subject_cdf,
-            should_enable_direct_cohort_p_conditioning,
+            prepare_forecast_runtime_inputs,
@@
-        # large local span-kernel / MC / carrier / runtime-bundle assembly
-        _v3_resolved_override = None
+        _prepared_runtime_v3 = prepare_forecast_runtime_inputs(
+            graph_data=graph_data,
+            query_from_node=query_from_node,
+            query_to_node=query_to_node,
+            anchor_node_id=anchor_node,
+            last_edge_id=last_edge_id,
+            is_window=is_window,
+            is_multi_hop=preparation.is_multi_hop,
+            composed_frames=composed_frames,
+            path_per_edge_results=per_edge_results,
+            upstream_per_edge_results=per_edge_results,
+            axis_tau_max=axis_tau_max,
+            upstream_anchor_from=subjects[0].get('anchor_from', ''),
+            upstream_anchor_to=subjects[0].get('anchor_to', ''),
+            upstream_sweep_from=subjects[0].get('sweep_from', subjects[0].get('anchor_from', '')),
+            upstream_sweep_to=subjects[0].get('sweep_to', subjects[0].get('anchor_to', '')),
+            candidate_regimes_by_edge=scenario.get('candidate_regimes_by_edge', {}),
+            upstream_observation_fetcher=_fetch_upstream_observations,
+            upstream_log_prefix='[v3] upstream:',
+            p_conditioning_source='snapshot_frames',
+            p_conditioning_evidence_points=len(composed_frames),
+            include_epistemic_overlay=True,
+        )
@@
-                display_settings=display_settings,
-                det_span_p=_det_span_p,
-                edge_cdf_arr=_edge_mc_cdf_v3,
```

```diff
@@ def handle_conditioned_forecast(...):
-                _direct_cohort_p_conditioning = (
-                    should_enable_direct_cohort_p_conditioning(...)
-                )
-                _runtime_bundle = build_prepared_runtime_bundle(...)
+            _prepared_runtime = prepare_forecast_runtime_inputs(
+                graph_data=graph_data,
+                query_from_node=query_from_node,
+                query_to_node=query_to_node,
+                anchor_node_id=anchor_node,
+                last_edge_id=last_edge_id,
+                is_window=is_window,
+                is_multi_hop=preparation.is_multi_hop,
+                composed_frames=composed_frames,
+                path_per_edge_results=per_edge_results,
+                upstream_per_edge_results=(
+                    list(all_per_edge_results.values()) if is_whole_graph else per_edge_results
+                ),
+                axis_tau_max=axis_tau_max,
+                upstream_anchor_from=subj_group[0].get('anchor_from', ''),
+                upstream_anchor_to=subj_group[0].get('anchor_to', ''),
+                upstream_sweep_from=subj_group[0].get('sweep_from', subj_group[0].get('anchor_from', '')),
+                upstream_sweep_to=subj_group[0].get('sweep_to', subj_group[0].get('anchor_to', '')),
+                candidate_regimes_by_edge=scenario.get('candidate_regimes_by_edge', {}),
+                upstream_observation_fetcher=_fetch_upstream_observations,
+                upstream_log_prefix='[forecast] upstream:',
+                p_conditioning_source='snapshot_frames',
+                p_conditioning_evidence_points=len(composed_frames),
+                include_epistemic_overlay=False,
+            )
@@
-                    edge_cdf_arr=_edge_mc_cdf,
```

## `graph-editor/lib/runner/cohort_forecast_v3.py`

```diff
@@ def compute_cohort_maturity_rows_v3(...):
-        should_enable_direct_cohort_p_conditioning,
@@
-            _direct_cohort_p_conditioning = (
-                should_enable_direct_cohort_p_conditioning(
-                    is_window=is_window,
-                    is_multi_hop=is_multi_hop,
-                )
-            )
+            _direct_cohort_p_conditioning = False
```

## `graph-editor/lib/runner/forecast_runtime.py`

```diff
@@ class PreparedConditioningEvidence:
-    direct_cohort_enabled: bool = False

@@
-def should_enable_direct_cohort_p_conditioning(
-    *,
-    is_window: bool,
-    is_multi_hop: bool,
-) -> bool:
-    """WP8's first landing: exact single-hop cohort subjects only."""
-    return (not is_window) and (not is_multi_hop)
```

```diff
@@ def build_prepared_runtime_bundle(...):
+    del p_conditioning_direct_cohort
@@
-        temporal_family=(
-            p_conditioning_temporal_family
-            or ('window' if mode == 'window' else 'cohort')
-        ),
+        temporal_family=(p_conditioning_temporal_family or 'window'),
         source=p_conditioning_source,
-        direct_cohort_enabled=p_conditioning_direct_cohort,
```

```diff
@@ def serialise_runtime_bundle(...):
-            'direct_cohort_enabled': (
-                bundle.p_conditioning_evidence.direct_cohort_enabled
-            ),
```

```diff
@@
+def should_enable_direct_cohort_p_conditioning(
+    *,
+    is_window: bool,
+    is_multi_hop: bool,
+) -> bool:
+    del is_window, is_multi_hop
+    return False
+
+@dataclass
+class PreparedForecastSolveInputs:
+    ...
+
+def _resolve_subject_temporal_mode(...):
+    if is_window:
+        return 'window'
+    if anchor_node_id and query_from_node and anchor_node_id != query_from_node:
+        return 'cohort'
+    return 'window'
+
+def prepare_forecast_runtime_inputs(...):
+    result.subject_temporal_mode = _resolve_subject_temporal_mode(...)
+    ...
+    return result
```

## `graph-editor/lib/runner/forecast_state.py`

```diff
@@ def compute_forecast_trajectory(...):
-        if not np.any(_x_median > 1e-9):
-            rate = p_draws[:S, None] * cdf_arr[:S]
+        _needs_fallback = _x_median <= 1e-9
+        if np.any(_needs_fallback):
+            fallback_cdf = cdf_arr[:S].copy()
+            if upstream_cdf_mc is not None and reach > 0:
+                ...
+                fallback_cdf[s, :] = np.clip(
+                    np.convolve(upstream_pdf[s], cdf_arr[s, :T], mode='full')[:T],
+                    0.0,
+                    1.0,
+                )
+            rate[:, _needs_fallback] = (
+                p_draws[:S, None] * fallback_cdf[:, _needs_fallback]
+            )
@@
-    rate_conditioned, ... = _run_cohort_loop(apply_is=True)
+    apply_rate_conditioning = not bool(
+        getattr(resolved, 'alpha_beta_query_scoped', False)
+    )
+    rate_conditioned, ... = _run_cohort_loop(
+        apply_is=apply_rate_conditioning,
+    )
@@
-        if c.eval_age is not None and c.x_frozen > 0:
-            t_i = min(c.eval_age, T - 1)
-            _comp_draws += c.x_frozen * cdf_arr[:S, t_i]
-            _comp_n += c.x_frozen
+        if c.eval_age is None:
+            continue
+        _comp_weight = float(c.x_frozen) if c.x_frozen > 0 else float(c.a_pop or 0.0)
+        if _comp_weight <= 0:
+            continue
+        t_i = min(c.eval_age, T - 1)
+        _comp_draws += _comp_weight * cdf_arr[:S, t_i]
+        _comp_n += _comp_weight
```

## Tests

```diff
@@ test_cf_query_scoped_degradation.py
+    # NOTE: ... dedicated degraded latency-row branch was deleted ...
-                direct_cohort_enabled=captured.setdefault(
-                    'p_conditioning_direct_cohort',
-                    kwargs.get('p_conditioning_direct_cohort'),
-                ),
-    assert captured['p_conditioning_source'] == 'direct_cohort_exact_subject'
-    assert captured['p_conditioning_direct_cohort'] is True
+    assert captured['p_conditioning_source'] == 'aggregate_evidence'
```

```diff
@@ test_v2_v3_parity.py
-        subject_is_window=False,
+        subject_is_window=True,
@@
-            'p_conditioning_direct_cohort': kwargs.get('p_conditioning_direct_cohort'),
@@
-    assert captured['p_conditioning_source'] == 'direct_cohort_exact_subject'
-    assert captured['p_conditioning_direct_cohort'] is True
+    assert captured['p_conditioning_source'] == 'snapshot_frames'
```

## `docs/current/project-bayes/66-shared-cf-runtime-and-wp8-admission-plan.md`

```diff
@@
- centralise `carrier_to_x` and `subject_span`
- centralise degrade-versus-sweep eligibility
- centralise WP8 admission and evidence selection
+ centralise prepared `subject_span` execution inputs, including the
+   deterministic-versus-MC span-kernel setup
+ centralise `carrier_to_x` and `x_provider`
+ centralise any multi-hop last-edge helper CDF still required by the
+   projection layer
+ centralise degrade-versus-sweep eligibility
+ centralise WP8 admission and evidence selection
+ assemble one authoritative `PreparedForecastRuntimeBundle`
+ extract the duplicated runtime-assembly block out of
+   `_handle_cohort_maturity_v3` and the scoped path inside
+   `handle_conditioned_forecast`
@@
+The immediate next implementation cut for v3-versus-CF unification is
+that handler extraction.
@@
+In practical terms, both handlers should then do only four things:
+
+- perform shared subject and frame preparation
+- call the authoritative runtime builder
+- call `compute_cohort_maturity_rows_v3`
+- project the returned solve into consumer-specific outputs
@@
-Reduce `cohort_forecast_v3` to projection logic over prepared inputs.
+Reduce `cohort_forecast_v3` to projection logic over the authoritative
+prepared inputs.
@@
+- stop assembling span-kernel inputs, `carrier_to_x`, `x_provider`, or
+  helper CDFs inside the row builder
+This stage should follow immediately after the Stage 2 extraction.
```
