"""
Shared API handlers for Python endpoints.

Used by both:
- dev-server.py (FastAPI)
- python-api.py (Vercel serverless)

This ensures dev and prod use identical handler logic.
"""
from typing import Dict, Any, Optional, List


def handle_generate_all_parameters(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle generate-all-parameters endpoint.
    
    Args:
        data: Request body containing:
            - graph: Graph data (required)
            - paramTypes: Optional filter by type
            - downstream_of: Optional incremental updates
            - edge_id: Optional filter to single edge (returns base p, cost_gbp, labour_cost)
            - conditional_index: Optional filter to specific conditional (requires edge_id)
            - maxChecks: Optional (default 200)
            - literal_weights: Optional
            - preserve_condition: Optional (default True)
            - preserveCaseContext: Optional (default True)
    
    Returns:
        Response dict with parameters and stats
    """
    graph_data = data.get('graph')
    param_types = data.get('paramTypes')  # Optional: filter by type
    downstream_of = data.get('downstream_of')  # Optional: incremental updates
    edge_id = data.get('edge_id')  # Optional: filter to single edge
    conditional_index = data.get('conditional_index')  # Optional: filter to specific conditional
    max_checks = data.get('maxChecks', 200)
    literal_weights = data.get('literal_weights')
    preserve_condition = data.get('preserve_condition', True)
    preserve_case_context = data.get('preserveCaseContext', True)
    
    if not graph_data:
        raise ValueError("Missing 'graph' field")
    
    from msmdc import generate_all_parameter_queries, generate_queries_by_type
    from graph_types import Graph
    
    graph = Graph.model_validate(graph_data)
    
    # Generate all parameters or filter by type/downstream/edge
    # Pass edge_id and conditional_index directly to MSMDC for efficiency
    if param_types:
        params_by_type = generate_queries_by_type(
            graph, param_types, max_checks, downstream_of, literal_weights, preserve_condition, preserve_case_context
        )
        all_params = []
        for ptype, params in params_by_type.items():
            all_params.extend(params)
    else:
        all_params = generate_all_parameter_queries(
            graph, max_checks, downstream_of, literal_weights, preserve_condition, preserve_case_context,
            edge_uuid=edge_id,  # Pass edge filter directly to MSMDC
            conditional_index=conditional_index  # Pass conditional filter directly to MSMDC
        )
    
    # Compute anchor_node_id for all edges (furthest upstream START node)
    from msmdc import compute_all_anchor_nodes
    anchor_map = compute_all_anchor_nodes(graph)
    
    # Format response
    parameters = []
    stats_by_type = {}
    
    for param in all_params:
        parameters.append({
            "paramType": param.param_type,
            "paramId": param.param_id,
            "edgeUuid": getattr(param, "edge_uuid", None),
            "edgeKey": param.edge_key,
            "condition": param.condition,
            "query": param.query,
            "nQuery": getattr(param, "n_query", None),
            "stats": param.stats
        })
        
        # Count by type
        if param.param_type not in stats_by_type:
            stats_by_type[param.param_type] = 0
        stats_by_type[param.param_type] += 1
    
    return {
        "parameters": parameters,
        "anchors": anchor_map,  # Edge UUID → anchor_node_id (for cohort queries)
        "stats": {
            "total": len(parameters),
            "byType": stats_by_type
        },
        "success": True
    }


def handle_stats_enhance(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle stats-enhance endpoint.
    
    Args:
        data: Request body containing:
            - raw: Raw aggregation data (required)
            - method: Enhancement method (required)
    
    Returns:
        Enhanced aggregation response
    """
    raw_data = data.get('raw')
    method = data.get('method')
    
    if not raw_data:
        raise ValueError("Missing 'raw' field")
    if not method:
        raise ValueError("Missing 'method' field")
    
    from stats_enhancement import enhance_aggregation
    
    enhanced = enhance_aggregation(raw_data, method)
    
    return {
        **enhanced,
        "success": True
    }


def handle_parse_query(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle parse-query endpoint.
    
    Args:
        data: Request body containing:
            - query: Query DSL string (required)
    
    Returns:
        Parsed query structure
    """
    query_str = data.get('query')
    
    if not query_str:
        raise ValueError("Missing 'query' field")
    
    from query_dsl import parse_query_strict, validate_query
    
    # Validate (require endpoints for data retrieval)
    is_valid, error = validate_query(query_str, require_endpoints=True)
    if not is_valid:
        raise ValueError(f"Invalid query: {error}")
    
    # Parse (strict - requires from/to for data retrieval)
    parsed = parse_query_strict(query_str)
    
    # Return structured response
    return {
        "query": query_str,
        "parsed": {
            "from_node": parsed.from_node,
            "to_node": parsed.to_node,
            "exclude": parsed.exclude,
            "visited": parsed.visited,
            "visited_any": getattr(parsed, "visited_any", []),
            "context": [{"key": c.key, "value": c.value} for c in parsed.context],
            "cases": [{"key": c.key, "value": c.value} for c in parsed.cases]
        },
        "valid": True,
        "reconstructed": parsed.raw
    }


def handle_runner_analyze(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle runner/analyze endpoint.
    
    Args:
        data: Request body containing EITHER:
            Scenario-based analysis (with optional per-scenario snapshot_subjects):
                - scenarios: List of scenario data (required)
                  Each scenario may carry snapshot_subjects[] (per-scenario DB coordinates)
                - query_dsl: DSL query string (optional)
                - analysis_type: Override analysis type (optional)
            
            Legacy snapshot-based analysis:
                - snapshot_query: {param_id, core_hash, anchor_from, anchor_to, slice_keys?}
                - analysis_type: 'lag_histogram' | 'daily_conversions'
    
    Returns:
        Analysis results
    """
    # New path: per-scenario snapshot_subjects
    # Check if any scenario carries snapshot_subjects (per-scenario architecture)
    scenarios_with_snapshots = [
        s for s in data.get('scenarios', [])
        if s.get('snapshot_subjects')
    ]
    if scenarios_with_snapshots:
        return _handle_snapshot_analyze_subjects(data)

    # Legacy path: snapshot_query (single subject)
    snapshot_query = data.get('snapshot_query')
    if snapshot_query:
        return _handle_snapshot_analyze_legacy(data)
    
    # Standard scenario-based analysis (no snapshot data needed)
    from runner import analyze
    from runner.types import AnalysisRequest, ScenarioData
    
    if 'scenarios' not in data or not data['scenarios']:
        raise ValueError("Missing 'scenarios' field")
    
    # Build request
    scenarios = [
        ScenarioData(
            scenario_id=s.get('scenario_id', f'scenario_{i}'),
            name=s.get('name'),
            colour=s.get('colour'),
            visibility_mode=s.get('visibility_mode', 'f+e'),
            graph=s.get('graph', {}),
        )
        for i, s in enumerate(data['scenarios'])
    ]
    
    request_obj = AnalysisRequest(
        scenarios=scenarios,
        query_dsl=data.get('query_dsl'),
        analysis_type=data.get('analysis_type'),
    )
    
    # Run analysis
    response = analyze(request_obj)
    
    # Return JSON-serializable response
    return response.model_dump()


def _handle_snapshot_analyze_subjects(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle snapshot-based analysis using per-scenario snapshot_subjects.
    
    Each scenario may carry its own `snapshot_subjects` array (derived from that
    scenario's effective DSL).  The backend processes each scenario's subjects
    independently and returns results grouped by scenario.
    
    See: docs/current/project-db/1-reads.md §9
    """
    from datetime import date, datetime, timedelta
    import math
    from snapshot_service import query_snapshots, query_snapshots_for_sweep
    from runner.histogram_derivation import derive_lag_histogram
    from runner.daily_conversions_derivation import derive_daily_conversions
    from runner.cohort_maturity_derivation import derive_cohort_maturity
    from runner.lag_fit_derivation import derive_lag_fit
    from runner.forecast_application import annotate_rows, compute_completeness
    from runner.lag_distribution_utils import log_normal_cdf, log_normal_inverse_cdf, standard_normal_inverse_cdf

    analysis_type = data.get('analysis_type', 'lag_histogram')
    scenarios = data.get('scenarios', [])

    def _resolve_completeness_params(model_params: Dict[str, Any], is_window: bool) -> tuple:
        """Select mu/sigma/onset based on query mode and path param availability.

        Returns (mu, sigma, onset, mode_tag).
        See doc 1 §16.1 truth table and §17.1 shared helper.
        """
        if is_window:
            return (model_params['mu'], model_params['sigma'],
                    model_params['onset_delta_days'], 'window')
        # cohort mode
        path_mu = model_params.get('path_mu')
        path_sigma = model_params.get('path_sigma')
        if path_mu is not None and path_sigma is not None:
            # Use path_delta if available, fall back to edge onset (Phase 1 interim)
            path_delta = model_params.get('path_delta',
                                           model_params['onset_delta_days'])
            return (path_mu, path_sigma, path_delta, 'cohort_path')
        return (model_params['mu'], model_params['sigma'],
                model_params['onset_delta_days'], 'cohort_edge_fallback')

    def _read_edge_model_params(graph: Any, target_id: str) -> Optional[Dict[str, float]]:
        """Read mu/sigma/onset/t95/path_t95 and forecast.mean from graph edge."""
        if not graph or not target_id:
            return None
        edges = graph.get('edges', []) if isinstance(graph, dict) else []
        edge = next(
            (e for e in edges
             if str(e.get('uuid') or e.get('id') or '') == str(target_id)),
            None,
        )
        if not edge:
            return None
        p = edge.get('p') or {}
        latency = p.get('latency') or {}
        mu = latency.get('mu')
        sigma = latency.get('sigma')
        if not isinstance(mu, (int, float)) or not isinstance(sigma, (int, float)):
            return None
        onset = latency.get('onset_delta_days') or 0
        forecast = p.get('forecast') or {}
        forecast_mean = forecast.get('mean')
        t95 = latency.get('t95')
        path_t95 = latency.get('path_t95')
        result: Dict[str, Any] = {
            'mu': float(mu),
            'sigma': float(sigma),
            'onset_delta_days': float(onset) if isinstance(onset, (int, float)) else 0.0,
        }
        if isinstance(forecast_mean, (int, float)) and math.isfinite(forecast_mean) and forecast_mean > 0:
            result['forecast_mean'] = float(forecast_mean)
        # Probability posterior uncertainty (for confidence bands)
        p_stdev = p.get('stdev')
        if isinstance(p_stdev, (int, float)) and math.isfinite(p_stdev) and p_stdev > 0:
            result['p_stdev'] = float(p_stdev)
        if isinstance(t95, (int, float)) and math.isfinite(t95) and t95 > 0:
            result['t95'] = float(t95)
        if isinstance(path_t95, (int, float)) and math.isfinite(path_t95) and path_t95 > 0:
            result['path_t95'] = float(path_t95)
        path_mu = latency.get('path_mu')
        path_sigma = latency.get('path_sigma')
        if isinstance(path_mu, (int, float)) and math.isfinite(path_mu):
            result['path_mu'] = float(path_mu)
        if isinstance(path_sigma, (int, float)) and math.isfinite(path_sigma) and path_sigma > 0:
            result['path_sigma'] = float(path_sigma)
        path_delta = latency.get('path_delta')
        if isinstance(path_delta, (int, float)) and math.isfinite(path_delta) and path_delta >= 0:
            result['path_delta'] = float(path_delta)
        # Bayesian latency posterior — edge-level (window)
        lat_posterior = latency.get('posterior') or {}
        bayes_mu = lat_posterior.get('mu_mean')
        bayes_sigma = lat_posterior.get('sigma_mean')
        if (isinstance(bayes_mu, (int, float)) and math.isfinite(bayes_mu)
                and isinstance(bayes_sigma, (int, float)) and math.isfinite(bayes_sigma) and bayes_sigma > 0):
            result['bayes_mu'] = float(bayes_mu)
            result['bayes_sigma'] = float(bayes_sigma)
            bayes_onset = lat_posterior.get('onset_delta_days')
            result['bayes_onset'] = float(bayes_onset) if isinstance(bayes_onset, (int, float)) and math.isfinite(bayes_onset) else 0.0
        # Bayesian latency posterior — uncertainty (for confidence bands)
        bayes_mu_sd = lat_posterior.get('mu_sd')
        bayes_sigma_sd = lat_posterior.get('sigma_sd')
        if (isinstance(bayes_mu_sd, (int, float)) and math.isfinite(bayes_mu_sd) and bayes_mu_sd > 0):
            result['bayes_mu_sd'] = float(bayes_mu_sd)
        if (isinstance(bayes_sigma_sd, (int, float)) and math.isfinite(bayes_sigma_sd) and bayes_sigma_sd > 0):
            result['bayes_sigma_sd'] = float(bayes_sigma_sd)
        # Bayesian latency posterior — path-level (cohort)
        bayes_path_mu = lat_posterior.get('path_mu_mean')
        bayes_path_sigma = lat_posterior.get('path_sigma_mean')
        if (isinstance(bayes_path_mu, (int, float)) and math.isfinite(bayes_path_mu)
                and isinstance(bayes_path_sigma, (int, float)) and math.isfinite(bayes_path_sigma) and bayes_path_sigma > 0):
            result['bayes_path_mu'] = float(bayes_path_mu)
            result['bayes_path_sigma'] = float(bayes_path_sigma)
            bayes_path_onset = lat_posterior.get('path_onset_delta_days')
            result['bayes_path_onset'] = float(bayes_path_onset) if isinstance(bayes_path_onset, (int, float)) and math.isfinite(bayes_path_onset) else 0.0
            # Path-level uncertainty
            bayes_path_mu_sd = lat_posterior.get('path_mu_sd')
            bayes_path_sigma_sd = lat_posterior.get('path_sigma_sd')
            if (isinstance(bayes_path_mu_sd, (int, float)) and math.isfinite(bayes_path_mu_sd) and bayes_path_mu_sd > 0):
                result['bayes_path_mu_sd'] = float(bayes_path_mu_sd)
            if (isinstance(bayes_path_sigma_sd, (int, float)) and math.isfinite(bayes_path_sigma_sd) and bayes_path_sigma_sd > 0):
                result['bayes_path_sigma_sd'] = float(bayes_path_sigma_sd)
        return result

    def _append_synthetic_cohort_maturity_frames(args: Dict[str, Any]) -> None:
        """
        Phase 2 (cohort maturity): append synthetic future frames (forecast-only tail).

        This does NOT change the meaning of existing (real) frames. It simply extends
        `result['frames']` with additional frames beyond the latest real as_at_date so
        the frontend can plot a forecast-only tail.

        Contract:
        - Synthetic frames are tagged with `is_synthetic: true`.
        - Each synthetic frame uses the same `data_points` shape as real frames.
        - Data points are re-annotated using annotate_rows with retrieved_at_override set
          to the synthetic as_at_date.
        """
        result = args.get('result') or {}
        frames = result.get('frames') if isinstance(result, dict) else None
        if not isinstance(frames, list) or len(frames) == 0:
            return

        mu = float(args['mu'])
        sigma = float(args['sigma'])
        onset = float(args.get('onset_delta_days') or 0.0)
        anchor_to = args.get('anchor_to')
        if not isinstance(anchor_to, str) or not anchor_to:
            return

        # Only append tail when there is at least one real frame with data points
        # and those points have projected_y (requires completeness annotation).
        real_frames = [f for f in frames if not f.get('is_synthetic')]
        if not real_frames:
            return

        # Last real frame with any data points.
        last_real = None
        for f in reversed(real_frames):
            if isinstance(f, dict) and isinstance(f.get('data_points'), list) and len(f.get('data_points')) > 0:
                last_real = f
                break
        if not last_real:
            return

        last_as_at = str(last_real.get('as_at_date') or '')[:10]
        if not last_as_at:
            return

        try:
            last_as_at_d = date.fromisoformat(last_as_at)
            anchor_to_d = date.fromisoformat(anchor_to[:10])
        except ValueError:
            return

        # Determine tail horizon: extend until the latest cohort (anchor_to) reaches ~t95
        # under the fitted lognormal model.
        #
        # We use 0.95 here (Phase 2). If/when forecasting_settings.t95_percentile is threaded
        # into snapshot_analyze, swap to that request value.
        try:
            t95_model = log_normal_inverse_cdf(0.95, mu, sigma)
        except Exception:
            return
        if not isinstance(t95_model, (int, float)) or not math.isfinite(t95_model) or t95_model <= 0:
            return

        tail_days = int(math.ceil(float(t95_model) + onset))
        if tail_days <= 0:
            return

        tail_to_d = anchor_to_d + timedelta(days=tail_days)
        start_d = last_as_at_d + timedelta(days=1)
        if start_d > tail_to_d:
            return

        base_points = last_real.get('data_points') or []
        if not isinstance(base_points, list) or len(base_points) == 0:
            return

        # Build tail frames at daily cadence.
        new_frames: List[Dict[str, Any]] = []
        d = start_d
        while d <= tail_to_d:
            as_at_iso = d.isoformat()
            synth_points: List[Dict[str, Any]] = []
            total_y = 0.0

            for p in base_points:
                if not isinstance(p, dict):
                    continue
                anchor_day = str(p.get('anchor_day') or '')[:10]
                if not anchor_day:
                    continue
                x = p.get('x') or 0
                a = p.get('a') or 0
                try:
                    x = float(x)
                except (ValueError, TypeError):
                    x = 0.0
                try:
                    a = float(a)
                except (ValueError, TypeError):
                    a = 0.0

                # Synthetic tail must respect cohort size invariants:
                # - 0 <= y <= x (expected conversions cannot exceed cohort size)
                # - 0 <= rate <= 1
                if not math.isfinite(x) or x <= 0:
                    continue

                # Use projected_y (final matured estimate) from the last real frame.
                # Clamp to x to avoid impossible projections (projected_y is an estimate, not a guarantee).
                y_inf = p.get('projected_y')
                try:
                    y_inf = float(y_inf) if y_inf is not None else None
                except (ValueError, TypeError):
                    y_inf = None
                if y_inf is None or not math.isfinite(y_inf) or y_inf < 0:
                    # If we can't establish a final-y estimate, we can't extend a future tail.
                    continue
                y_inf = min(y_inf, x)

                # Compute expected observed conversions by future date: y(t) = y_inf * completeness(t).
                try:
                    cohort_age_days = (d - date.fromisoformat(anchor_day)).days
                except ValueError:
                    cohort_age_days = 0
                c_future = compute_completeness(float(cohort_age_days), mu, sigma, onset)
                c_future = max(0.0, min(1.0, float(c_future)))
                y_future = max(0.0, y_inf * c_future)
                y_future = min(y_future, x)

                rate = (y_future / x) if x > 0 else 0.0
                rate = max(0.0, min(1.0, rate))
                total_y += y_future
                synth_points.append({
                    "anchor_day": anchor_day,
                    "y": y_future,
                    "x": x,
                    "a": a,
                    "rate": rate,
                })

            if synth_points:
                synth_points = annotate_rows(
                    synth_points,
                    mu, sigma, onset,
                    retrieved_at_override=as_at_iso,
                )

            new_frames.append({
                "as_at_date": as_at_iso,
                "is_synthetic": True,
                "data_points": synth_points,
                "total_y": total_y,
            })
            d += timedelta(days=1)

        # Append and keep chronological ordering.
        # We preserve the original (real) frames as-is and append the future tail.
        result['frames'] = frames + new_frames
        result['forecast_tail'] = {
            "from": start_d.isoformat(),
            "to": tail_to_d.isoformat(),
            "t95_model_days": float(t95_model),
            "onset_delta_days": float(onset),
        }

    per_scenario_results: List[Dict[str, Any]] = []
    total_rows = 0

    for scenario in scenarios:
        scenario_id = scenario.get('scenario_id', 'unknown')
        subjects = scenario.get('snapshot_subjects')
        if not subjects:
            # No snapshot subjects for this scenario — skip snapshot analysis
            per_scenario_results.append({
                "scenario_id": scenario_id,
                "success": True,
                "subjects": [],
                "rows_analysed": 0,
            })
            continue

        per_subject_results: List[Dict[str, Any]] = []
        scenario_rows = 0

        for subj in subjects:
            # Validate required fields (all frontend-computed)
            if not subj.get('param_id'):
                raise ValueError(f"snapshot_subjects[].param_id required (scenario={scenario_id}, subject_id={subj.get('subject_id')})")
            if not subj.get('core_hash'):
                raise ValueError(f"snapshot_subjects[].core_hash required (scenario={scenario_id}, subject_id={subj.get('subject_id')})")
            if not subj.get('anchor_from'):
                raise ValueError(f"snapshot_subjects[].anchor_from required (scenario={scenario_id}, subject_id={subj.get('subject_id')})")
            if not subj.get('anchor_to'):
                raise ValueError(f"snapshot_subjects[].anchor_to required (scenario={scenario_id}, subject_id={subj.get('subject_id')})")

            read_mode = subj.get('read_mode', 'raw_snapshots')

            if read_mode == 'cohort_maturity':
                # Cohort maturity: use sweep query
                sweep_from = date.fromisoformat(subj['sweep_from']) if subj.get('sweep_from') else None
                sweep_to = date.fromisoformat(subj['sweep_to']) if subj.get('sweep_to') else None

                print(f"[snapshot_analyze] cohort_maturity query: "
                      f"param_id={subj['param_id']}, core_hash={subj['core_hash']}, "
                      f"slice_keys={subj.get('slice_keys', [''])}, "
                      f"anchor_from={subj['anchor_from']}, anchor_to={subj['anchor_to']}, "
                      f"sweep_from={sweep_from}, sweep_to={sweep_to}")

                rows = query_snapshots_for_sweep(
                    param_id=subj['param_id'],
                    core_hash=subj['core_hash'],
                    slice_keys=subj.get('slice_keys', ['']),
                    anchor_from=date.fromisoformat(subj['anchor_from']),
                    anchor_to=date.fromisoformat(subj['anchor_to']),
                    sweep_from=sweep_from,
                    sweep_to=sweep_to,
                )

                print(f"[snapshot_analyze] cohort_maturity result: {len(rows)} rows")

                scenario_rows += len(rows)

                if not rows:
                    # IMPORTANT:
                    # Cohort maturity sweep may intentionally yield no rows for an epoch
                    # (e.g. a planned "gap" epoch, or days before the first retrieval).
                    # This must be treated as a successful empty result, not an error.
                    result = derive_cohort_maturity(
                        [],
                        sweep_from=subj.get('sweep_from'),
                        sweep_to=subj.get('sweep_to'),
                    )
                    per_subject_results.append({
                        "subject_id": subj.get('subject_id'),
                        "success": True,
                        "result": result,
                        "rows_analysed": 0,
                    })
                    continue

                result = derive_cohort_maturity(
                    rows,
                    sweep_from=subj.get('sweep_from'),
                    sweep_to=subj.get('sweep_to'),
                )
            elif read_mode == 'sweep_simple':
                # Simple sweep (no epoch splitting) — used by lag_fit
                sweep_from = date.fromisoformat(subj['sweep_from']) if subj.get('sweep_from') else None
                sweep_to = date.fromisoformat(subj['sweep_to']) if subj.get('sweep_to') else None

                rows = query_snapshots_for_sweep(
                    param_id=subj['param_id'],
                    core_hash=subj['core_hash'],
                    slice_keys=subj.get('slice_keys', ['']),
                    anchor_from=date.fromisoformat(subj['anchor_from']),
                    anchor_to=date.fromisoformat(subj['anchor_to']),
                    sweep_from=sweep_from,
                    sweep_to=sweep_to,
                )

                scenario_rows += len(rows)

                if analysis_type == 'lag_fit':
                    graph_data = scenario.get('graph') or {}
                    target_id = (subj.get('target') or {}).get('targetId')
                    edge_model = _read_edge_model_params(graph_data, target_id)

                    result = derive_lag_fit(
                        rows,
                        t95_constraint=edge_model.get('t95') if edge_model else None,
                        onset_override=edge_model.get('onset_delta_days') if edge_model else None,
                        from_node=subj.get('from_node', ''),
                        to_node=subj.get('to_node', ''),
                        edge_label=subj.get('edge_label', ''),
                    )
                else:
                    result = {'analysis_type': analysis_type, 'data': [], 'error': f'sweep_simple does not support analysis_type={analysis_type}'}
            else:
                # raw_snapshots / virtual_snapshot: existing query path
                as_at = None
                if subj.get('as_at'):
                    as_at = datetime.fromisoformat(str(subj['as_at']).replace('Z', '+00:00'))

                rows = query_snapshots(
                    param_id=subj['param_id'],
                    core_hash=subj['core_hash'],
                    slice_keys=subj.get('slice_keys', ['']),
                    anchor_from=date.fromisoformat(subj['anchor_from']),
                    anchor_to=date.fromisoformat(subj['anchor_to']),
                    as_at=as_at,
                )

                scenario_rows += len(rows)

                if not rows:
                    per_subject_results.append({
                        "subject_id": subj.get('subject_id'),
                        "success": False,
                        "error": "No snapshot data found",
                    })
                    continue

                # Route to appropriate derivation
                if analysis_type == 'lag_histogram':
                    result = derive_lag_histogram(rows)
                elif analysis_type == 'daily_conversions':
                    result = derive_daily_conversions(rows)
                elif analysis_type == 'branch_comparison':
                    result = derive_daily_conversions(rows)
                elif analysis_type == 'cohort_maturity':
                    # Fallback: cohort_maturity without cohort_maturity read_mode
                    result = derive_cohort_maturity(rows)
                else:
                    raise ValueError(f"Unknown analysis_type for snapshot: {analysis_type}")

            # ── Completeness annotation (Phase 6) ──────────────
            # If the graph edge has mu/sigma (from a prior recompute),
            # annotate each data point with completeness and layer.
            # This is naturally dormant until Phase 7 persists mu/sigma.
            graph = scenario.get('graph') or {}
            target_id = (subj.get('target') or {}).get('targetId')
            model_params = _read_edge_model_params(graph, target_id)
            if model_params and result:
                # Determine query mode once — used by both annotation and chart CDF.
                # See doc 1 §16.1 truth table: annotation and chart must use the
                # same resolved params (Divergence 1 fix).
                subj_slice_keys = subj.get('slice_keys') or []
                has_window_slice = any('window(' in str(sk) for sk in subj_slice_keys)
                has_cohort_slice = any('cohort(' in str(sk) for sk in subj_slice_keys)
                if has_window_slice or has_cohort_slice:
                    is_window = has_window_slice and not has_cohort_slice
                else:
                    query_dsl = data.get('query_dsl') or ''
                    is_window = 'window(' in query_dsl or '.window(' in query_dsl

                mu, sigma, onset, cdf_mode = _resolve_completeness_params(model_params, is_window)

                if analysis_type == 'cohort_maturity' and 'frames' in result:
                    for frame in result['frames']:
                        as_at_date = frame.get('as_at_date', '')
                        if frame.get('data_points'):
                            frame['data_points'] = annotate_rows(
                                frame['data_points'], mu, sigma, onset,
                                retrieved_at_override=as_at_date,
                            )
                    # Phase 2: append synthetic future frames (forecast-only tail).
                    _append_synthetic_cohort_maturity_frames({
                        'result': result,
                        'mu': mu,
                        'sigma': sigma,
                        'onset_delta_days': onset,
                        'anchor_to': subj.get('anchor_to'),
                    })
                elif analysis_type == 'daily_conversions' and 'rate_by_cohort' in result:
                    result['rate_by_cohort'] = annotate_rows(
                        result['rate_by_cohort'], mu, sigma, onset,
                    )

                # ── Model CDF curve (cohort maturity only) ──────────────
                # Generate the theoretical cumulative lognormal curve so the
                # frontend can overlay it on the empirical maturity chart.
                # Uses the same resolved params as annotation (doc 1 §17.1).
                is_gap_epoch = any(str(sk) == '__epoch_gap__' for sk in subj_slice_keys)

                if analysis_type == 'cohort_maturity' and 'forecast_mean' in model_params and not is_gap_epoch:
                    forecast_mean = model_params['forecast_mean']

                    cdf_mu = mu
                    cdf_sigma = sigma
                    cdf_onset = onset

                    # Extend curve well beyond t95 so it covers the full displayed
                    # chart axis. Use sweep_to − anchor_from as a baseline, and
                    # ensure at least 2× the t95 horizon so the plateau is visible.
                    anchor_from_str = subj.get('anchor_from', '')
                    sweep_to_str = subj.get('sweep_to', '')
                    sweep_span = None
                    try:
                        if anchor_from_str and sweep_to_str:
                            af = date.fromisoformat(str(anchor_from_str)[:10])
                            st = date.fromisoformat(str(sweep_to_str)[:10])
                            sweep_span = (st - af).days
                    except (ValueError, TypeError):
                        pass

                    t95_extent = None
                    try:
                        t95_model = log_normal_inverse_cdf(0.95, cdf_mu, cdf_sigma)
                        t95_extent = int(math.ceil((t95_model + cdf_onset) * 2)) + 1
                    except Exception:
                        pass

                    # Also include path_t95 — the frontend may use it for the axis
                    # extent (when it detects cohort mode from query_dsl).
                    edge_path_t95_extent = model_params.get('path_t95')
                    if not isinstance(edge_path_t95_extent, (int, float)) or not math.isfinite(edge_path_t95_extent) or edge_path_t95_extent <= 0:
                        edge_path_t95_extent = None

                    candidates = [c for c in [sweep_span, t95_extent, edge_path_t95_extent] if c and c > 0]
                    axis_tau_max = int(math.ceil(max(candidates))) if candidates else None

                    if axis_tau_max and axis_tau_max > 0:
                        curve = []
                        for tau in range(0, axis_tau_max + 1):
                            c = compute_completeness(float(tau), cdf_mu, cdf_sigma, cdf_onset)
                            c = max(0.0, min(1.0, float(c)))
                            curve.append({
                                'tau_days': tau,
                                'model_rate': round(forecast_mean * c, 8),
                            })
                        result['model_curve'] = curve
                        result['model_curve_params'] = {
                            'mu': cdf_mu,
                            'sigma': cdf_sigma,
                            'onset_delta_days': cdf_onset,
                            'forecast_mean': forecast_mean,
                            'mode': cdf_mode,
                        }

                        # Bayesian posterior overlay — second model curve if posteriors exist.
                        # For cohort_path mode, use path-level Bayesian params if available;
                        # for window mode, use edge-level Bayesian params.
                        if 'bayes_mu' in model_params:
                            if cdf_mode == 'cohort_path' and 'bayes_path_mu' in model_params:
                                b_mu = model_params['bayes_path_mu']
                                b_sigma = model_params['bayes_path_sigma']
                                b_onset = model_params['bayes_path_onset']
                                b_mode = 'bayesian_path'
                            else:
                                b_mu = model_params['bayes_mu']
                                b_sigma = model_params['bayes_sigma']
                                b_onset = model_params['bayes_onset']
                                b_mode = 'bayesian'
                            bayes_curve = []
                            for tau in range(0, axis_tau_max + 1):
                                bc = compute_completeness(
                                    float(tau), b_mu, b_sigma, b_onset,
                                )
                                bc = max(0.0, min(1.0, float(bc)))
                                bayes_curve.append({
                                    'tau_days': tau,
                                    'model_rate': round(forecast_mean * bc, 8),
                                })
                            result['model_curve_bayes'] = bayes_curve
                            result['model_curve_bayes_params'] = {
                                'mu': b_mu,
                                'sigma': b_sigma,
                                'onset_delta_days': b_onset,
                                'forecast_mean': forecast_mean,
                                'mode': b_mode,
                            }

                            # Bayesian confidence band (99.9%) via delta method.
                            # model_rate(τ) = p × CDF(τ; mu, sigma, onset)
                            # Three independent axes of uncertainty: p, mu, sigma.
                            # Partial derivatives:
                            #   ∂rate/∂p     = CDF(τ)
                            #   ∂rate/∂mu    = p × ∂CDF/∂mu
                            #   ∂rate/∂sigma = p × ∂CDF/∂sigma
                            # var(rate) = CDF²·p_sd² + p²·[(∂CDF/∂mu)²·mu_sd²
                            #             + (∂CDF/∂sigma)²·sigma_sd²]
                            if cdf_mode == 'cohort_path' and 'bayes_path_mu_sd' in model_params:
                                band_mu_sd = model_params['bayes_path_mu_sd']
                                band_sigma_sd = model_params.get('bayes_path_sigma_sd', 0.0)
                            else:
                                band_mu_sd = model_params.get('bayes_mu_sd')
                                band_sigma_sd = model_params.get('bayes_sigma_sd', 0.0)
                            band_p_sd = model_params.get('p_stdev', 0.0)

                            if band_mu_sd is not None and band_mu_sd > 0:
                                band_k = 3.291  # 99.9% band
                                sqrt_2pi = math.sqrt(2.0 * math.pi)
                                p_val = forecast_mean  # posterior mean of p

                                bayes_band_upper = []
                                bayes_band_lower = []
                                for tau in range(0, axis_tau_max + 1):
                                    cdf_val = compute_completeness(float(tau), b_mu, b_sigma, b_onset)
                                    cdf_val = max(0.0, min(1.0, float(cdf_val)))
                                    rate = p_val * cdf_val

                                    model_age = float(tau) - b_onset
                                    if model_age > 0 and b_sigma > 0:
                                        z = (math.log(model_age) - b_mu) / b_sigma
                                        phi_z = math.exp(-0.5 * z * z) / sqrt_2pi

                                        dcdf_dmu = -phi_z / b_sigma
                                        dcdf_dsigma = -phi_z * z / b_sigma

                                        # var(rate) from all three axes
                                        var_rate = 0.0
                                        # p uncertainty: ∂rate/∂p = CDF
                                        if band_p_sd > 0:
                                            var_rate += (cdf_val ** 2) * (band_p_sd ** 2)
                                        # mu uncertainty: ∂rate/∂mu = p × ∂CDF/∂mu
                                        var_rate += (p_val * dcdf_dmu) ** 2 * (band_mu_sd ** 2)
                                        # sigma uncertainty: ∂rate/∂sigma = p × ∂CDF/∂sigma
                                        if band_sigma_sd > 0:
                                            var_rate += (p_val * dcdf_dsigma) ** 2 * (band_sigma_sd ** 2)

                                        sd_rate = math.sqrt(var_rate)
                                        ru = rate + band_k * sd_rate
                                        rl = max(0.0, rate - band_k * sd_rate)
                                    else:
                                        # Before onset: only p uncertainty matters
                                        if band_p_sd > 0 and cdf_val > 0:
                                            sd_rate = cdf_val * band_p_sd
                                            ru = rate + band_k * sd_rate
                                            rl = max(0.0, rate - band_k * sd_rate)
                                        else:
                                            ru = rate
                                            rl = rate

                                    bayes_band_upper.append({
                                        'tau_days': tau,
                                        'model_rate': round(ru, 8),
                                    })
                                    bayes_band_lower.append({
                                        'tau_days': tau,
                                        'model_rate': round(rl, 8),
                                    })
                                result['model_curve_bayes_band_upper'] = bayes_band_upper
                                result['model_curve_bayes_band_lower'] = bayes_band_lower

            per_subject_results.append({
                "subject_id": subj.get('subject_id'),
                "success": True,
                "result": result,
                "rows_analysed": len(rows),
            })

        total_rows += scenario_rows
        per_scenario_results.append({
            "scenario_id": scenario_id,
            "success": any(s.get("success") for s in per_subject_results) if per_subject_results else True,
            "subjects": per_subject_results,
            "rows_analysed": scenario_rows,
        })

    # Simplify response for single-scenario / single-subject cases
    if len(per_scenario_results) == 1:
        single_scenario = per_scenario_results[0]
        subjects_list = single_scenario.get("subjects", [])
        if len(subjects_list) == 1:
            # Single scenario, single subject — flatten fully
            single = subjects_list[0]
            return {
                "success": single.get("success", False),
                "result": single.get("result"),
                "error": single.get("error"),
                "rows_analysed": single.get("rows_analysed", 0),
                "subject_id": single.get("subject_id"),
                "scenario_id": single_scenario.get("scenario_id"),
            }
        # Single scenario, multiple subjects
        return {
            "success": single_scenario.get("success", False),
            "scenario_id": single_scenario.get("scenario_id"),
            "subjects": subjects_list,
            "rows_analysed": single_scenario.get("rows_analysed", 0),
        }

    # Multi-scenario: return grouped by scenario
    any_success = any(s.get("success") for s in per_scenario_results)
    return {
        "success": any_success,
        "scenarios": per_scenario_results,
        "rows_analysed": total_rows,
    }


def _handle_snapshot_analyze_legacy(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Legacy handler: snapshot_query (single-subject, used by older callers).
    
    Queries snapshot DB and derives analytics (histogram, daily conversions).
    """
    from datetime import date, datetime
    from snapshot_service import query_snapshots
    from runner.histogram_derivation import derive_lag_histogram
    from runner.daily_conversions_derivation import derive_daily_conversions
    
    snapshot_query = data['snapshot_query']
    analysis_type = data.get('analysis_type', 'lag_histogram')
    
    # Validate required fields
    if not snapshot_query.get('param_id'):
        raise ValueError("snapshot_query.param_id required")
    if not snapshot_query.get('anchor_from'):
        raise ValueError("snapshot_query.anchor_from required")
    if not snapshot_query.get('anchor_to'):
        raise ValueError("snapshot_query.anchor_to required")
    
    # Optional point-in-time cut-off (supports serial cron-run simulation)
    as_at = None
    if snapshot_query.get('as_at'):
        as_at = datetime.fromisoformat(str(snapshot_query['as_at']).replace('Z', '+00:00'))

    # Query snapshots
    rows = query_snapshots(
        param_id=snapshot_query['param_id'],
        core_hash=snapshot_query.get('core_hash'),
        slice_keys=snapshot_query.get('slice_keys', ['']),
        anchor_from=date.fromisoformat(snapshot_query['anchor_from']),
        anchor_to=date.fromisoformat(snapshot_query['anchor_to']),
        as_at=as_at,
    )
    
    if not rows:
        return {
            "success": False,
            "error": "No snapshot data found for query",
            "query": snapshot_query,
        }
    
    # Route to appropriate derivation
    if analysis_type == 'lag_histogram':
        result = derive_lag_histogram(rows)
    elif analysis_type == 'daily_conversions':
        result = derive_daily_conversions(rows)
    else:
        raise ValueError(f"Unknown analysis_type for snapshot: {analysis_type}")
    
    return {
        "success": True,
        "result": result,
        "rows_analysed": len(rows),
    }


# ----------------------------------------------------------------------------
# Test compatibility shim
# ----------------------------------------------------------------------------
def _handle_snapshot_analyze(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Backwards-compatible helper retained for existing tests.

    Historically tests imported `_handle_snapshot_analyze` directly and passed a legacy
    `snapshot_query` payload. The production entrypoint is `handle_runner_analyze()`,
    which now dispatches between per-scenario snapshot_subjects and the legacy single
    snapshot_query format.

    This wrapper preserves the older test import without changing runtime behaviour.
    """
    return _handle_snapshot_analyze_legacy(data)


def handle_runner_available_analyses(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle runner/available-analyses endpoint.
    
    Args:
        data: Request body containing:
            - graph: Graph data (optional)
            - query_dsl: DSL query string (optional)
            - scenario_count: Number of scenarios (optional, default 1)
    
    Returns:
        List of available analyses
    """
    from runner import get_available_analyses
    
    graph_data = data.get('graph', {})
    scenario_count = data.get('scenario_count', 1)
    query_dsl = data.get('query_dsl')
    
    available = get_available_analyses(
        graph_data=graph_data,
        query_dsl=query_dsl,
        scenario_count=scenario_count,
    )
    
    return {"analyses": available}


def handle_compile_exclude(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle compile-exclude endpoint.
    
    Compiles a query with excludes() terms to minus/plus form for providers
    that don't support native excludes (like Amplitude).
    
    Args:
        data: Request body containing:
            - query: Query DSL string with excludes() (required)
            - graph: Graph data for topology analysis (required)
    
    Returns:
        Response dict with compiled_query
    """
    import re
    query_str = data.get('query')
    graph_data = data.get('graph')
    
    print(f"[compile_exclude] Received request with query: {query_str[:200] if query_str else 'None'}...")
    
    if not query_str:
        raise ValueError("Missing 'query' field")
    if not graph_data:
        raise ValueError("Missing 'graph' field")
    
    # Parse the query to extract from, to, and excludes
    from query_dsl import parse_query_strict
    from graph_types import Graph
    
    try:
        parsed = parse_query_strict(query_str)
        print(f"[compile_exclude] Parsed query: from={parsed.from_node}, to={parsed.to_node}, exclude={parsed.exclude}, visited={parsed.visited}")
    except Exception as e:
        print(f"[compile_exclude] Failed to parse query: {e}")
        return {
            "compiled_query": query_str,
            "was_compiled": False,
            "error": f"Query parse failed: {str(e)}",
            "success": False
        }
    
    if not parsed.exclude:
        # No excludes, return original query
        print(f"[compile_exclude] No excludes found in parsed query")
        return {
            "compiled_query": query_str,
            "was_compiled": False,
            "success": True
        }
    
    # Build graph for topology analysis
    try:
        graph = Graph.model_validate(graph_data)
        print(f"[compile_exclude] Graph validated: {len(graph.nodes)} nodes, {len(graph.edges)} edges")
    except Exception as e:
        print(f"[compile_exclude] Failed to validate graph: {e}")
        return {
            "compiled_query": query_str,
            "was_compiled": False,
            "error": f"Graph validation failed: {str(e)}",
            "success": False
        }
    
    # Import the inclusion-exclusion compiler
    import sys
    from pathlib import Path
    algorithms_path = Path(__file__).parent / 'algorithms'
    sys.path.insert(0, str(algorithms_path))
    
    from connection_capabilities import supports_native_exclude
    
    # Check if we need to compile (Amplitude doesn't support native excludes)
    # For this endpoint, we assume caller has already determined compilation is needed
    
    # Build networkx graph for the compiler
    import networkx as nx
    G = nx.DiGraph()
    
    # Add nodes
    for node in graph.nodes:
        node_id = node.id or node.uuid
        G.add_node(node_id)
    
    # Add edges
    for edge in graph.edges:
        from_id = edge.from_node
        to_id = edge.to
        # Resolve from/to to node IDs
        from_node_match = next((n for n in graph.nodes if n.uuid == from_id or n.id == from_id), None)
        to_node_match = next((n for n in graph.nodes if n.uuid == to_id or n.id == to_id), None)
        if from_node_match and to_node_match:
            from_node_id = from_node_match.id or from_node_match.uuid
            to_node_id = to_node_match.id or to_node_match.uuid
            G.add_edge(from_node_id, to_node_id)
    
    print(f"[compile_exclude] Built networkx graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")
    
    # Get from/to nodes
    from_node = parsed.from_node
    to_node = parsed.to_node
    exclude_nodes = parsed.exclude
    
    print(f"[compile_exclude] Compiling: from={from_node}, to={to_node}, exclude={exclude_nodes}")
    
    # Check if nodes exist in graph
    missing_nodes = []
    for node_id in [from_node, to_node] + exclude_nodes:
        if node_id and node_id not in G.nodes():
            missing_nodes.append(node_id)
    
    if missing_nodes:
        print(f"[compile_exclude] WARNING: Nodes not found in graph: {missing_nodes}")
        print(f"[compile_exclude] Available nodes: {list(G.nodes())[:20]}...")  # First 20 nodes
    
    # Import the optimized inclusion-exclusion compiler
    from optimized_inclusion_exclusion import compile_optimized_inclusion_exclusion
    
    try:
        compiled_query, terms = compile_optimized_inclusion_exclusion(
            G, from_node, to_node, to_node, exclude_nodes
        )
        
        print(f"[compile_exclude] Successfully compiled: {len(terms)} terms")
        print(f"[compile_exclude] Compiled query: {compiled_query[:200]}...")
        
        # Prepend any visited() terms from original query
        if parsed.visited:
            visited_str = f".visited({','.join(parsed.visited)})"
            # Insert visited after to() but before minus()
            if '.minus(' in compiled_query:
                parts = compiled_query.split('.minus(', 1)
                compiled_query = f"{parts[0]}{visited_str}.minus({parts[1]}"
            else:
                compiled_query = f"{compiled_query}{visited_str}"
        
        return {
            "compiled_query": compiled_query,
            "was_compiled": True,
            "terms_count": len(terms),
            "success": True
        }
    except Exception as e:
        import traceback
        print(f"[compile_exclude] Compilation failed: {e}")
        print(f"[compile_exclude] Traceback: {traceback.format_exc()}")
        return {
            "compiled_query": query_str,
            "was_compiled": False,
            "error": str(e),
            "success": False
        }


def handle_snapshots_append(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle append-snapshots endpoint.
    
    Shadow-writes time-series data to the snapshot database after successful fetches.
    
    Args:
        data: Request body containing:
            - param_id: Workspace-prefixed parameter ID (required)
            - canonical_signature: Canonical semantic signature string (required; frontend `query_signature`)
            - inputs_json: Evidence blob for audit + diff UI (required; JSON object)
            - sig_algo: Signature algorithm identifier (required)
            - slice_key: Context slice DSL or '' (required)
            - retrieved_at: ISO timestamp string (required)
            - rows: List of daily data points (required)
            - diagnostic: bool (optional) - if true, return detailed diagnostic info
    
    Returns:
        Response dict with:
            - success: bool
            - inserted: int
            - diagnostic: dict (only if diagnostic=true in request)
    """
    from datetime import datetime
    from snapshot_service import append_snapshots
    
    param_id = data.get('param_id')
    canonical_signature = data.get('canonical_signature')
    inputs_json = data.get('inputs_json')
    sig_algo = data.get('sig_algo')
    slice_key = data.get('slice_key', '')
    retrieved_at_str = data.get('retrieved_at')
    rows = data.get('rows', [])
    diagnostic = data.get('diagnostic', False)
    
    if not param_id:
        raise ValueError("Missing 'param_id' field")
    if not canonical_signature:
        raise ValueError("Missing 'canonical_signature' field")
    if inputs_json is None or not isinstance(inputs_json, dict):
        raise ValueError("Missing/invalid 'inputs_json' field (must be a JSON object)")
    if not sig_algo:
        raise ValueError("Missing 'sig_algo' field")
    if not retrieved_at_str:
        raise ValueError("Missing 'retrieved_at' field")
    
    # Parse ISO timestamp
    retrieved_at = datetime.fromisoformat(retrieved_at_str.replace('Z', '+00:00'))
    
    result = append_snapshots(
        param_id=param_id,
        canonical_signature=canonical_signature,
        inputs_json=inputs_json,
        sig_algo=sig_algo,
        slice_key=slice_key,
        retrieved_at=retrieved_at,
        rows=rows,
        diagnostic=diagnostic,
        core_hash=data.get('core_hash'),  # Frontend-computed (hash-fixes.md)
    )
    
    return result


def handle_snapshots_health(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle snapshots health check endpoint.
    
    Returns database connectivity status for feature flag decisions.
    """
    from snapshot_service import health_check
    return health_check()


def handle_snapshots_query(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle snapshots query endpoint.
    
    Query snapshots from the database for a given param_id.
    Used for integration testing verification.
    
    Args:
        data: Request body containing:
            - param_id: Parameter ID to query (required)
    
    Returns:
        Response dict with rows
    """
    from snapshot_service import get_db_connection
    
    param_id = data.get('param_id')
    if not param_id:
        raise ValueError("Missing 'param_id' field")
    
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT param_id, core_hash, slice_key, anchor_day, retrieved_at,
                   A as a, X as x, Y as y, 
                   median_lag_days, mean_lag_days,
                   anchor_median_lag_days, anchor_mean_lag_days,
                   onset_delta_days
            FROM snapshots
            WHERE param_id = %s
            ORDER BY anchor_day, slice_key
        """, (param_id,))
        columns = [desc[0] for desc in cur.description]
        rows = [dict(zip(columns, row)) for row in cur.fetchall()]
        return {
            'success': True,
            'rows': rows,
            'count': len(rows)
        }
    finally:
        conn.close()


def handle_snapshots_delete_test(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle delete-test-snapshots endpoint.
    
    Delete test data from the snapshot database by param_id prefix.
    ONLY for integration testing cleanup - requires prefix starting with 'pytest-'.
    
    Args:
        data: Request body containing:
            - param_id_prefix: Prefix to match for deletion (required, must start with 'pytest-')
    
    Returns:
        Response dict with deleted count
    """
    from snapshot_service import get_db_connection
    
    prefix = data.get('param_id_prefix')
    if not prefix:
        raise ValueError("Missing 'param_id_prefix' field")
    
    # Safety: only allow deletion of test data
    if not prefix.startswith('pytest-'):
        raise ValueError("param_id_prefix must start with 'pytest-' for safety")
    
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM snapshots WHERE param_id LIKE %s", (f'{prefix}%',))
        deleted = cur.rowcount
        conn.commit()
        return {
            'success': True,
            'deleted': deleted
        }
    finally:
        conn.close()


# =============================================================================
# Phase 2: Read Path — Query Endpoints
# =============================================================================

def handle_snapshots_query_full(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle full snapshot query endpoint.
    
    Query snapshots with filtering by date range, signature, slices.
    
    Args:
        data: Request body containing:
            - param_id: Parameter ID (required)
            - core_hash: Query signature (optional)
            - slice_keys: List of slice keys (optional)
            - anchor_from: Start date ISO string (optional)
            - anchor_to: End date ISO string (optional)
            - as_at: Timestamp ISO string for point-in-time query (optional)
            - limit: Max rows (optional, default 10000)
    
    Returns:
        Response dict with rows
    """
    from datetime import date, datetime
    from snapshot_service import query_snapshots
    
    param_id = data.get('param_id')
    if not param_id:
        raise ValueError("Missing 'param_id' field")
    
    # Parse optional date filters
    anchor_from = None
    if data.get('anchor_from'):
        anchor_from = date.fromisoformat(data['anchor_from'])
    
    anchor_to = None
    if data.get('anchor_to'):
        anchor_to = date.fromisoformat(data['anchor_to'])
    
    as_at = None
    if data.get('as_at'):
        as_at = datetime.fromisoformat(data['as_at'].replace('Z', '+00:00'))

    retrieved_ats = None
    if data.get('retrieved_ats') is not None:
        if not isinstance(data.get('retrieved_ats'), list):
            raise ValueError("'retrieved_ats' must be a list of ISO datetime strings")
        parsed = []
        for ts in data.get('retrieved_ats') or []:
            if not isinstance(ts, str) or not ts:
                continue
            parsed.append(datetime.fromisoformat(ts.replace('Z', '+00:00')))
        retrieved_ats = parsed
    
    rows = query_snapshots(
        param_id=param_id,
        core_hash=data.get('core_hash'),
        slice_keys=data.get('slice_keys'),
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        as_at=as_at,
        retrieved_ats=retrieved_ats,
        equivalent_hashes=data.get('equivalent_hashes'),
        limit=data.get('limit', 10000)
    )
    
    return {
        'success': True,
        'rows': rows,
        'count': len(rows)
    }


def handle_snapshots_inventory(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle batch inventory endpoint.
    
    Get snapshot inventory for multiple parameters in a single request.
    
    Args:
        data: Request body containing:
            - param_ids: List of parameter IDs (required)
    
    Returns:
        Response dict with inventory per param_id (V2: signature families).
    """
    param_ids = data.get("param_ids")
    if not param_ids:
        raise ValueError("Missing 'param_ids' field")

    if not isinstance(param_ids, list):
        raise ValueError("'param_ids' must be a list")

    from snapshot_service import get_batch_inventory_v2
    inventory = get_batch_inventory_v2(
        param_ids=param_ids,
        current_signatures=data.get("current_signatures") or None,
        current_core_hashes=data.get("current_core_hashes") or None,  # Frontend-computed (hash-fixes.md)
        slice_keys_by_param=data.get("slice_keys") or None,
        equivalent_hashes_by_param=data.get("equivalent_hashes_by_param") or None,
        limit_families_per_param=int(data.get("limit_families_per_param", 50)),
        limit_slices_per_family=int(data.get("limit_slices_per_family", 200)),
    )
    return {"success": True, "inventory_version": 2, "inventory": inventory}


def handle_snapshots_batch_retrieval_days(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle batch retrieval days endpoint.

    Return distinct retrieved_day per param_id in a single query.
    Used by the aggregate as-at calendar when no edge is selected.

    Args:
        data: Request body containing:
            - param_ids: List of parameter IDs (required)
            - limit_per_param: Max days per param (optional, default 200)

    Returns:
        Response dict with per-param retrieved_days lists.
    """
    param_ids = data.get("param_ids")
    if not param_ids:
        raise ValueError("Missing 'param_ids' field")
    if not isinstance(param_ids, list):
        raise ValueError("'param_ids' must be a list")

    from snapshot_service import query_batch_retrieval_days
    days_by_param = query_batch_retrieval_days(
        param_ids=param_ids,
        limit_per_param=int(data.get("limit_per_param", 200)),
    )
    return {"success": True, "days_by_param": days_by_param}


def handle_snapshots_retrievals(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle snapshot retrievals endpoint.

    Return distinct snapshot retrieval timestamps (`retrieved_at`) for a given subject.
    Used by Phase 2 `@` UI to highlight available snapshot days.

    Args:
        data: Request body containing:
            - param_id: Parameter ID (required)
            - canonical_signature: Canonical signature (optional; frontend `query_signature`)
            - slice_keys: List of slice keys (optional)
            - anchor_from: Start date ISO string (optional)
            - anchor_to: End date ISO string (optional)
            - limit: Max timestamps (optional, default 200)

    Returns:
        Response dict with retrieved_at + derived retrieved_days.
    """
    from datetime import date
    from snapshot_service import query_snapshot_retrievals, _require_core_hash

    param_id = data.get('param_id')
    if not param_id:
        raise ValueError("Missing 'param_id' field")

    anchor_from = None
    if data.get('anchor_from'):
        anchor_from = date.fromisoformat(data['anchor_from'])

    anchor_to = None
    if data.get('anchor_to'):
        anchor_to = date.fromisoformat(data['anchor_to'])

    # Frontend must provide core_hash. None means "query all hashes for this param" (hash-fixes.md)
    req_core_hash = data.get('core_hash')
    core_hash = _require_core_hash(req_core_hash, context="retrievals") if req_core_hash else None

    return query_snapshot_retrievals(
        param_id=param_id,
        core_hash=core_hash,
        slice_keys=data.get('slice_keys'),
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        equivalent_hashes=data.get('equivalent_hashes'),
        include_summary=bool(data.get('include_summary', False)),
        limit=data.get('limit', 200)
    )


def handle_snapshots_delete(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle snapshot delete endpoint.
    
    Delete snapshots for a specific parameter, optionally scoped to core_hashes.
    Used by "Delete snapshots (X)" UI feature.
    
    Args:
        data: Request body containing:
            - param_id: Exact parameter ID to delete (required)
            - core_hashes: Optional list of core_hash values to scope the delete
    
    Returns:
        Response dict with deleted count
    """
    from datetime import datetime
    from snapshot_service import delete_snapshots
    
    param_id = data.get('param_id')
    if not param_id:
        raise ValueError("Missing 'param_id' field")
    
    core_hashes = data.get('core_hashes')
    if core_hashes is not None and not isinstance(core_hashes, list):
        raise ValueError("'core_hashes' must be a list of strings")

    retrieved_ats = data.get('retrieved_ats')
    if retrieved_ats is not None:
        if not isinstance(retrieved_ats, list):
            raise ValueError("'retrieved_ats' must be a list of ISO datetime strings")
        parsed = []
        for ts in retrieved_ats:
            if not isinstance(ts, str) or not ts:
                continue
            parsed.append(datetime.fromisoformat(ts.replace('Z', '+00:00')))
        retrieved_ats = parsed

    return delete_snapshots(param_id, core_hashes=core_hashes, retrieved_ats=retrieved_ats)


def handle_snapshots_query_virtual(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle virtual snapshot query endpoint for asat() DSL.
    
    Returns the "virtual snapshot": latest row per anchor_day (and slice_key)
    as-of a given timestamp. This supports historical queries without
    returning raw snapshot rows.
    
    Performance invariant: executes at most ONE SQL query per param_id.
    
    Args:
        data: Request body containing:
            - param_id: Parameter ID (required)
            - as_at: ISO datetime string for point-in-time (required)
            - anchor_from: Start date ISO string (required)
            - anchor_to: End date ISO string (required)
            - canonical_signature: Canonical semantic signature string (REQUIRED; frontend `query_signature`)
            - slice_keys: List of slice keys (optional)
            - limit: Max rows (optional, default 10000)
    
    Returns:
        Response dict with:
        - success: bool
        - rows: List of virtual snapshot rows
        - count: int
        - latest_retrieved_at_used: str | None
        - has_anchor_to: bool
        - error: str (if failed)
    """
    from datetime import date, datetime
    from snapshot_service import query_virtual_snapshot, _require_core_hash
    
    param_id = data.get('param_id')
    if not param_id:
        raise ValueError("Missing 'param_id' field")

    # Semantic integrity requirement: historical reads MUST be keyed by the canonical signature.
    canonical_signature = data.get('canonical_signature')
    if not canonical_signature:
        raise ValueError("Missing 'canonical_signature' field (required for semantic integrity)")
    # Frontend must provide core_hash — backend never derives hashes (hash-fixes.md)
    core_hash = _require_core_hash(data.get('core_hash'), context="query-virtual")
    
    as_at_str = data.get('as_at')
    if not as_at_str:
        raise ValueError("Missing 'as_at' field")
    
    anchor_from_str = data.get('anchor_from')
    if not anchor_from_str:
        raise ValueError("Missing 'anchor_from' field")
    
    anchor_to_str = data.get('anchor_to')
    if not anchor_to_str:
        raise ValueError("Missing 'anchor_to' field")
    
    # Parse dates
    as_at = datetime.fromisoformat(as_at_str.replace('Z', '+00:00'))
    anchor_from = date.fromisoformat(anchor_from_str)
    anchor_to = date.fromisoformat(anchor_to_str)
    
    return query_virtual_snapshot(
        param_id=param_id,
        as_at=as_at,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        core_hash=core_hash,
        slice_keys=data.get('slice_keys'),
        equivalent_hashes=data.get('equivalent_hashes'),
        limit=data.get('limit', 10000)
    )


# =============================================================================
# Batch Anchor Coverage — missing anchor-day ranges for Retrieve All preflight
# =============================================================================


def handle_snapshots_batch_anchor_coverage(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle batch anchor coverage endpoint.

    For each subject, compute which anchor-day ranges are missing from the
    snapshot DB within [anchor_from, anchor_to], considering equivalence closure.

    Args:
        data: Request body containing:
            - subjects: List of dicts, each with:
                - param_id (str, required)
                - core_hash (str, required)
                - slice_keys (list[str], required)
                - anchor_from (ISO date str, required)
                - anchor_to (ISO date str, required)


    Returns:
        Response dict with:
            - success: bool
            - results: list of per-subject coverage results
    """
    from datetime import date as date_type
    from snapshot_service import batch_anchor_coverage
    diagnostic = bool(data.get("diagnostic", False))

    subjects_raw = data.get("subjects")
    if not subjects_raw:
        raise ValueError("Missing 'subjects' field")
    if not isinstance(subjects_raw, list):
        raise ValueError("'subjects' must be a list")

    # Parse and validate each subject
    subjects = []
    for i, s in enumerate(subjects_raw):
        if not isinstance(s, dict):
            raise ValueError(f"subjects[{i}] must be a dict")
        param_id = s.get("param_id")
        if not param_id:
            raise ValueError(f"subjects[{i}] missing 'param_id'")
        core_hash = s.get("core_hash")
        if not core_hash:
            raise ValueError(f"subjects[{i}] missing 'core_hash'")
        anchor_from_str = s.get("anchor_from")
        if not anchor_from_str:
            raise ValueError(f"subjects[{i}] missing 'anchor_from'")
        anchor_to_str = s.get("anchor_to")
        if not anchor_to_str:
            raise ValueError(f"subjects[{i}] missing 'anchor_to'")
        subjects.append({
            "param_id": param_id,
            "core_hash": core_hash,
            "slice_keys": s.get("slice_keys") or [],
            "anchor_from": date_type.fromisoformat(anchor_from_str),
            "anchor_to": date_type.fromisoformat(anchor_to_str),
            "equivalent_hashes": s.get("equivalent_hashes"),
        })

    results = batch_anchor_coverage(subjects, diagnostic=diagnostic)
    return {"success": True, "results": results}


# =============================================================================
# Flexible signatures: Signature Links UI routes
# =============================================================================


def handle_sigs_list(data: Dict[str, Any]) -> Dict[str, Any]:
    """List signature registry rows for a param_id, or list distinct param_ids.

    Modes:
    - param_id set: list signatures for that param (original behaviour)
    - list_params=True: list distinct param_ids with summary counts
    Filters: param_id_prefix (workspace scoping), graph_name (provenance)
    """
    from snapshot_service import list_signatures
    param_id = data.get("param_id")
    list_params = bool(data.get("list_params", False))
    if not param_id and not list_params:
        raise ValueError("Either 'param_id' or 'list_params' must be provided")
    limit = data.get("limit", 200)
    include_inputs = bool(data.get("include_inputs", False))
    param_id_prefix = data.get("param_id_prefix")
    graph_name = data.get("graph_name")
    return list_signatures(
        param_id=param_id,
        param_id_prefix=param_id_prefix,
        graph_name=graph_name,
        list_params=list_params,
        limit=limit,
        include_inputs=include_inputs,
    )


def handle_sigs_get(data: Dict[str, Any]) -> Dict[str, Any]:
    """Get a single signature registry row."""
    from snapshot_service import get_signature
    param_id = data.get("param_id")
    core_hash = data.get("core_hash")
    if not param_id:
        raise ValueError("Missing 'param_id' field")
    if not core_hash:
        raise ValueError("Missing 'core_hash' field")
    return get_signature(param_id=param_id, core_hash=core_hash)


# REMOVED: handle_sigs_links_list, handle_sigs_links_create,
# handle_sigs_links_deactivate, handle_sigs_resolve
# Equivalence is now FE-owned via hash-mappings.json.
# See: docs/current/project-db/hash-mappings-table-location-be-contract-12-Feb-26.md


def handle_lag_recompute_models(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Recompute lag models for a set of subjects using snapshot DB evidence.

    Request shape (see analysis-forecasting.md §5.2):
      - subjects: array of {subject_id, param_id, core_hash, slice_keys,
                             anchor_from, anchor_to, target: {targetId, ...}}
      - forecasting_settings: required settings object (see §4.5)
      - graph: scenario graph (for reading t95 constraint from edge)
      - training_anchor_from/to: ISO dates (optional; defaults to subject anchor range)
      - as_at: ISO datetime (optional; for as-at evidence selection)

    Returns per-subject fitted model params.
    """
    from datetime import date, datetime
    from snapshot_service import query_snapshots
    from runner.lag_model_fitter import fit_model_from_evidence
    from runner.forecasting_settings import settings_from_dict, compute_settings_signature

    # ── Validate required fields ──────────────────────────────
    forecasting_settings_raw = data.get('forecasting_settings')
    if not forecasting_settings_raw:
        raise ValueError("Missing required 'forecasting_settings' field")
    settings = settings_from_dict(forecasting_settings_raw)
    sig = compute_settings_signature(settings)

    subjects = data.get('subjects', [])
    if not subjects:
        raise ValueError("Missing or empty 'subjects' array")

    graph = data.get('graph', {})
    edges = graph.get('edges', []) if isinstance(graph, dict) else []
    as_at_str = data.get('as_at')
    diagnostic = bool(data.get('diagnostic', False))
    # Accept both ISO with offset and Zulu suffix.
    as_at = datetime.fromisoformat(as_at_str.replace('Z', '+00:00')) if as_at_str else None

    # UK date for model_trained_at provenance.
    from datetime import date as _date
    today = _date.today()
    model_trained_at = today.strftime('%-d-%b-%y')

    # ── Process each subject ──────────────────────────────────
    results = []
    for subj in subjects:
        subject_id = subj.get('subject_id', '')
        param_id = subj.get('param_id')
        core_hash = subj.get('core_hash')
        if not param_id or not core_hash:
            results.append({
                'subject_id': subject_id,
                'success': False,
                'error': 'Missing param_id or core_hash',
            })
            continue

        slice_keys = subj.get('slice_keys', [''])
        anchor_from_str = data.get('training_anchor_from') or subj.get('anchor_from')
        anchor_to_str = data.get('training_anchor_to') or subj.get('anchor_to')

        print(f"[lag_recompute] subject={subject_id}, param_id={param_id}, core_hash={core_hash[:12]}..., slice_keys={slice_keys}, anchor_from={anchor_from_str}, anchor_to={anchor_to_str}")

        try:
            anchor_from = date.fromisoformat(anchor_from_str) if anchor_from_str else None
            anchor_to = date.fromisoformat(anchor_to_str) if anchor_to_str else None
        except (ValueError, TypeError):
            anchor_from = None
            anchor_to = None

        # Read t95 constraint from graph edge (one-way sigma constraint).
        target = subj.get('target', {})
        target_id = target.get('targetId')
        t95_constraint = None
        if target_id and edges:
            edge = next(
                (e for e in edges
                 if str(e.get('uuid') or e.get('id') or '') == str(target_id)),
                None,
            )
            if edge:
                p = edge.get('p') or {}
                latency = p.get('latency') or {}
                t95_val = latency.get('t95') or p.get('t95')
                if isinstance(t95_val, (int, float)) and t95_val > 0:
                    t95_constraint = float(t95_val)

        # Onset: prefer the explicit FE fitting onset sent per-subject.
        # This is the onset the FE actually used when computing mu/sigma
        # (derived from window() histogram data). The graph edge's
        # onset_delta_days may be stale; do NOT read it from the edge.
        # In future the BE may independently derive onset from historic
        # snapshots, but for now the FE value is authoritative.
        onset_override = None
        subj_onset = subj.get('onset_delta_days')
        if isinstance(subj_onset, (int, float)) and subj_onset >= 0:
            onset_override = float(subj_onset)

        # Query DB evidence.
        subj_equiv_hashes = subj.get('equivalent_hashes')
        try:
            rows = query_snapshots(
                param_id=param_id,
                core_hash=core_hash,
                slice_keys=slice_keys,
                anchor_from=anchor_from,
                anchor_to=anchor_to,
                as_at=as_at,
                equivalent_hashes=subj_equiv_hashes,
            )
        except Exception as e:
            results.append({
                'subject_id': subject_id,
                'success': False,
                'error': f'DB query failed: {e}',
            })
            continue

        # Fit model from evidence.
        training_window = {}
        if anchor_from_str:
            training_window['anchor_from'] = anchor_from_str
        if anchor_to_str:
            training_window['anchor_to'] = anchor_to_str

        fit = fit_model_from_evidence(
            rows=rows,
            settings=settings,
            t95_constraint=t95_constraint,
            onset_override=onset_override,
            use_authoritative_t95=True,
            model_trained_at=model_trained_at,
            training_window=training_window or None,
            settings_signature=sig,
            reference_datetime=as_at,
            diagnostic=diagnostic,
        )

        result_entry: Dict[str, Any] = {
            'subject_id': subject_id,
            'success': True,
            'mu': fit.mu,
            'sigma': fit.sigma,
            'model_trained_at': fit.model_trained_at,
            't95_days': fit.t95_days,
            'onset_delta_days': fit.onset_delta_days,
            'quality_ok': fit.quality_ok,
            'total_k': fit.total_k,
            'quality_failure_reason': fit.quality_failure_reason,
            'training_window': fit.training_window,
            'settings_signature': fit.settings_signature,
            'evidence_anchor_days': fit.evidence_anchor_days,
        }
        if diagnostic and fit.diagnostic_evidence is not None:
            result_entry['diagnostic_evidence'] = fit.diagnostic_evidence
        results.append(result_entry)

    return {
        'success': True,
        'subjects': results,
    }
