"""
Evidence binder: TopologyAnalysis + parameter files → BoundEvidence.

Responsibilities:
  - Parse values[] entries, classify as window vs cohort
  - Extract (n, k) for window; (n_daily, k_daily, dates) for cohort
  - Compute pre-baked completeness per observation (Phase A: fixed latency)
  - Derive warm-start priors from previous posteriors (ESS-capped)
  - Resolve file_path from parameters index
  - Apply minimum-n threshold
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta

from .types import (
    TopologyAnalysis,
    BoundEvidence,
    EdgeEvidence,
    WindowObservation,
    CohortObservation,
    CohortDailyObs,
    CohortDailyTrajectory,
    ProbabilityPrior,
    LatencyPrior,
    SliceObservations,
    SliceGroup,
    ESS_CAP,
    MIN_N_THRESHOLD,
)
from .completeness import shifted_lognormal_cdf
from .slices import context_key, dimension_key, is_mece_dimension


def bind_evidence(
    topology: TopologyAnalysis,
    param_files: dict[str, dict],
    params_index: dict | None = None,
    settings: dict | None = None,
    today: str | None = None,
) -> BoundEvidence:
    """Bind evidence from parameter files to the topology.

    param_files: dict of param_id → param file data (as parsed YAML/dict).
    params_index: the parameters-index file data (for file_path resolution).
    settings: user settings from the submit payload.
    today: reference date string (d-MMM-yy or ISO). Defaults to now.
    """
    diagnostics: list[str] = []
    settings = settings or {}
    today_date = _parse_today(today)

    # Build param_id → file_path lookup from index
    param_id_to_path = _build_path_lookup(params_index)

    edges_evidence: dict[str, EdgeEvidence] = {}

    for edge_id, et in topology.edges.items():
        param_id = et.param_id
        if not param_id:
            diagnostics.append(f"SKIP edge {edge_id[:8]}…: no param_id")
            continue

        # Find the parameter file data
        pf_data = _resolve_param_file(param_id, param_files)
        if pf_data is None:
            diagnostics.append(f"SKIP edge {edge_id[:8]}…: param file not found for '{param_id}'")
            continue

        # Resolve file path
        file_path = param_id_to_path.get(param_id, "")
        if not file_path:
            bare_id = param_id
            if bare_id.startswith("parameter-"):
                bare_id = bare_id[len("parameter-"):]
            file_path = f"parameters/{bare_id}.yaml"

        # Build evidence for this edge
        ev = EdgeEvidence(
            edge_id=edge_id,
            param_id=param_id,
            file_path=file_path,
        )

        # --- Prior ---
        ev.prob_prior = _resolve_prior(pf_data, topology.fingerprint)

        # --- Latency prior (doc 21: warm-start from previous posterior) ---
        if et.has_latency:
            ev.latency_prior = _resolve_latency_prior(et, pf_data)

        # --- Warm-start: kappa, kappa_p, cohort latency ---
        _resolve_warm_start_extras(ev, et, pf_data)

        # --- Parse values[] entries ---
        values = pf_data.get("values") or []
        for v in values:
            if not isinstance(v, dict):
                continue
            slice_dsl = v.get("sliceDSL", "") or ""
            n = _safe_int(v.get("n"))
            k = _safe_int(v.get("k"))

            if _is_cohort(slice_dsl):
                # Cohort observation — use daily arrays
                n_daily = v.get("n_daily") or []
                k_daily = v.get("k_daily") or []
                dates = v.get("dates") or []

                if n_daily and k_daily and dates and len(n_daily) == len(k_daily) == len(dates):
                    daily_obs = _build_cohort_daily(
                        n_daily, k_daily, dates, today_date,
                        et.path_latency.path_delta,
                        et.path_latency.path_mu,
                        et.path_latency.path_sigma,
                        et.has_latency,
                    )
                    if daily_obs:
                        ev.cohort_obs.append(CohortObservation(
                            slice_dsl=slice_dsl,
                            daily=daily_obs,
                        ))
                        ev.has_cohort = True
                        ev.total_n += sum(d.n for d in daily_obs)
                elif n is not None and k is not None and n > 0:
                    # Fallback: no daily arrays, use aggregate as single "day"
                    cohort_age = _estimate_cohort_age(slice_dsl, today_date)
                    compl = _compute_cohort_completeness(
                        cohort_age,
                        et.path_latency.path_delta,
                        et.path_latency.path_mu,
                        et.path_latency.path_sigma,
                        et.has_latency,
                    )
                    ev.cohort_obs.append(CohortObservation(
                        slice_dsl=slice_dsl,
                        daily=[CohortDailyObs(
                            date="aggregate",
                            n=n, k=k,
                            age_days=cohort_age,
                            completeness=compl,
                        )],
                    ))
                    ev.has_cohort = True
                    ev.total_n += n

            elif _is_window(slice_dsl) or (n is not None and k is not None):
                # Window observation (or unqualified entry treated as window)
                if n is not None and k is not None and n > 0:
                    compl = _compute_window_completeness(
                        slice_dsl, today_date,
                        et.onset_delta_days, et.mu_prior, et.sigma_prior,
                        et.has_latency,
                    )
                    ev.window_obs.append(WindowObservation(
                        n=n, k=k,
                        slice_dsl=slice_dsl,
                        completeness=compl,
                    ))
                    ev.has_window = True
                    ev.total_n += n

        # --- Phase C: route sliced observations to SliceGroups ---
        _route_slices(ev, settings, diagnostics)

        # --- Minimum-n gate ---
        min_n = settings.get("min_n_threshold", MIN_N_THRESHOLD)
        if ev.total_n < min_n and ev.total_n > 0:
            ev.skipped = True
            ev.skip_reason = f"total_n={ev.total_n} < min_n={min_n}"
            ev.prob_prior = ProbabilityPrior(source="prior-only")
            diagnostics.append(f"PRIOR-ONLY edge {edge_id[:8]}…: {ev.skip_reason}")
        elif ev.total_n == 0:
            ev.skipped = True
            ev.skip_reason = "no observations"
            diagnostics.append(f"SKIP edge {edge_id[:8]}…: no observations")

        edges_evidence[edge_id] = ev

    return BoundEvidence(
        edges=edges_evidence,
        settings=settings,
        today=today_date.strftime("%-d-%b-%y"),
        diagnostics=diagnostics,
    )


# ---------------------------------------------------------------------------
# Snapshot-based evidence binding (Phase S)
# ---------------------------------------------------------------------------

def bind_snapshot_evidence(
    topology: TopologyAnalysis,
    snapshot_rows: dict[str, list[dict]],
    param_files: dict[str, dict],
    params_index: dict | None = None,
    settings: dict | None = None,
    today: str | None = None,
) -> BoundEvidence:
    """Bind evidence from snapshot DB rows, falling back to parameter files.

    snapshot_rows: dict of edge_id → list of DB row dicts. Each row has:
        param_id, core_hash, slice_key, anchor_day, retrieved_at,
        a (anchor entrants), x (from-step), y (to-step),
        median_lag_days, mean_lag_days, onset_delta_days.

    For each edge:
      - If snapshot_rows has data: convert to observations (latest per
        anchor_day for cohort, latest for window). Ignore param file values[].
      - If no snapshot data: fall back to param file values[] (existing path).
      - Priors always come from param files (warm-start / moment-matched).
    """
    diagnostics: list[str] = []
    settings = settings or {}
    today_date = _parse_today(today)

    param_id_to_path = _build_path_lookup(params_index)
    edges_evidence: dict[str, EdgeEvidence] = {}

    for edge_id, et in topology.edges.items():
        param_id = et.param_id
        if not param_id:
            diagnostics.append(f"SKIP edge {edge_id[:8]}…: no param_id")
            continue

        pf_data = _resolve_param_file(param_id, param_files)

        file_path = param_id_to_path.get(param_id, "")
        if not file_path:
            bare_id = param_id
            if bare_id.startswith("parameter-"):
                bare_id = bare_id[len("parameter-"):]
            file_path = f"parameters/{bare_id}.yaml"

        ev = EdgeEvidence(
            edge_id=edge_id,
            param_id=param_id,
            file_path=file_path,
        )

        # --- Prior (always from param file) ---
        if pf_data:
            ev.prob_prior = _resolve_prior(pf_data, topology.fingerprint)
        else:
            ev.prob_prior = ProbabilityPrior(alpha=1.0, beta=1.0, source="uninformative")

        # --- Latency prior (doc 21: warm-start from previous posterior) ---
        if et.has_latency:
            ev.latency_prior = _resolve_latency_prior(et, pf_data)

        # --- Warm-start: kappa, kappa_p, cohort latency ---
        _resolve_warm_start_extras(ev, et, pf_data)

        # --- Evidence: merge snapshot rows + param file ---
        #
        # Snapshot rows provide rich multi-retrieval trajectories per
        # anchor_day.  Param-file values[] provide single-point observations
        # (latest snapshot) for each anchor_day.  They originate from the
        # same fetch pipeline so they almost always overlap, but may diverge
        # after hash migrations, DB purges, or failed writes.
        #
        # Strategy:
        #   1. Bind snapshot rows as trajectories (richer signal).
        #   2. Supplement with param-file cohort daily points for any
        #      anchor_days NOT already covered by snapshot trajectories.
        #   3. Window aggregates from param files are NOT supplemented when
        #      snapshot window trajectories exist — the per-day trajectories
        #      are strictly richer than the aggregate.
        #   4. When no snapshot rows exist at all, fall back entirely to
        #      param-file evidence (preserving existing behaviour).
        rows = snapshot_rows.get(edge_id, [])

        if rows:
            snapshot_covered_days = _bind_from_snapshot_rows(
                ev, et, rows, today_date, diagnostics,
                settings=settings,
            )
            diagnostics.append(
                f"INFO edge {edge_id[:8]}…: {len(rows)} snapshot rows "
                f"→ {len(ev.window_obs)} window obs, "
                f"{sum(len(c.daily) for c in ev.cohort_obs)} cohort daily obs"
            )

            # Supplement with param-file data for uncovered anchor_days.
            if pf_data:
                n_supplemented = _supplement_from_param_file(
                    ev, et, pf_data, today_date, settings,
                    snapshot_covered_days, diagnostics,
                )
                if n_supplemented > 0:
                    diagnostics.append(
                        f"INFO edge {edge_id[:8]}…: supplemented {n_supplemented} "
                        f"daily obs from param file (anchor_days not in snapshot DB)"
                    )
        elif pf_data:
            _bind_from_param_file(
                ev, et, pf_data, today_date, settings, diagnostics,
            )
            diagnostics.append(
                f"INFO edge {edge_id[:8]}…: no snapshot data, using param file"
            )
        else:
            diagnostics.append(f"SKIP edge {edge_id[:8]}…: no snapshot data and no param file")

        # --- Minimum-n gate ---
        min_n = settings.get("min_n_threshold", MIN_N_THRESHOLD)
        if ev.total_n < min_n and ev.total_n > 0:
            ev.skipped = True
            ev.skip_reason = f"total_n={ev.total_n} < min_n={min_n}"
            ev.prob_prior = ProbabilityPrior(source="prior-only")
            diagnostics.append(f"PRIOR-ONLY edge {edge_id[:8]}…: {ev.skip_reason}")
        elif ev.total_n == 0:
            ev.skipped = True
            ev.skip_reason = "no observations"
            diagnostics.append(f"SKIP edge {edge_id[:8]}…: no observations")

        edges_evidence[edge_id] = ev

    result = BoundEvidence(
        edges=edges_evidence,
        settings=settings,
        today=today_date.strftime("%-d-%b-%y"),
        diagnostics=diagnostics,
    )

    # Recency weighting: recent trajectories contribute more to the likelihood
    half_life = float(settings.get("RECENCY_HALF_LIFE_DAYS", 30))
    _apply_recency_weights(result, today_date, half_life, diagnostics)

    return result


def _apply_recency_weights(
    evidence: BoundEvidence,
    today: datetime,
    half_life_days: float,
    diagnostics: list[str],
) -> None:
    """Set recency_weight on each trajectory based on anchor_day age.

    weight = exp(-ln2 * age_days / half_life_days)
    Recent trajectories ≈ 1.0, old ones decay toward 0.
    """
    import math
    ln2 = math.log(2)
    n_weighted = 0
    for ev in evidence.edges.values():
        if ev.skipped:
            continue
        for co in ev.cohort_obs:
            for traj in co.trajectories:
                age = _date_age(traj.date, today)
                traj.recency_weight = math.exp(-ln2 * age / half_life_days)
                n_weighted += 1
    if n_weighted > 0:
        diagnostics.append(
            f"INFO recency: {n_weighted} trajectories weighted "
            f"(half_life={half_life_days:.0f}d)"
        )


def _bind_from_snapshot_rows(
    ev: EdgeEvidence,
    et,
    rows: list[dict],
    today: datetime,
    diagnostics: list[str],
    settings: dict | None = None,
) -> set[str]:
    """Convert snapshot DB rows to Cohort-first trajectory objects.

    Both window() and cohort() slices produce Cohorts (independent
    experiment groups indexed by anchor_day). They differ in anchoring:
      - window(): denominator x (from-node), edge-level CDF
      - cohort(): denominator a (anchor entrants), path-level CDF

    See doc 6 § "End-state compiler approach for snapshot evidence".

    Grouping is by (obs_type, anchor_day) — rows from different
    slice_keys for the same anchor_day are merged into one Cohort,
    deduplicated by retrieved_at.

    Returns the set of anchor_day strings that produced observations,
    used by the caller to deduplicate param-file supplementation.
    """
    from collections import defaultdict

    # Step 1: Classify each row and group by (obs_type, anchor_day).
    # Rows from different slice_keys for the same anchor_day are the
    # same Cohort observed via different queries — merge them.
    window_by_day: dict[str, list[dict]] = defaultdict(list)
    cohort_by_day: dict[str, list[dict]] = defaultdict(list)

    # Aggregate context-prefixed rows into bare window()/cohort().
    # Context slices are MECE — summing their x and y values for the
    # same (anchor_day, retrieved_at) recovers the aggregate row.
    # Until Phase C per-context modelling is built, the compiler
    # operates on aggregate data only. If a bare aggregate row already
    # exists, it takes precedence (context rows for that retrieval are
    # dropped). See doc 25.
    agg_window: dict[str, dict[str, dict]] = defaultdict(dict)  # anchor → ret → row
    agg_cohort: dict[str, dict[str, dict]] = defaultdict(dict)
    n_ctx_aggregated = 0

    for row in rows:
        anchor_day = str(row.get("anchor_day", ""))
        slice_key = str(row.get("slice_key", ""))
        ret_key = str(row.get("retrieved_at", ""))
        is_ctx = "context(" in slice_key

        if _is_cohort(slice_key):
            bucket = agg_cohort
        elif _is_window(slice_key):
            bucket = agg_window
        else:
            continue

        day_bucket = bucket[anchor_day]
        if ret_key in day_bucket:
            existing = day_bucket[ret_key]
            if is_ctx and "context(" not in str(existing.get("slice_key", "")):
                # Bare aggregate already present — skip context row
                n_ctx_aggregated += 1
                continue
            if is_ctx:
                # Sum into existing context-aggregated row
                existing["x"] = (existing.get("x") or 0) + (row.get("x") or 0)
                existing["y"] = (existing.get("y") or 0) + (row.get("y") or 0)
                if row.get("a") is not None and existing.get("a") is not None:
                    existing["a"] = existing["a"] + row["a"]
                n_ctx_aggregated += 1
                continue
            else:
                # Bare aggregate replaces any prior context-aggregated row
                day_bucket[ret_key] = dict(row)
                n_ctx_aggregated += 1
                continue
        else:
            day_bucket[ret_key] = dict(row)
            if is_ctx:
                n_ctx_aggregated += 1

    # Flatten aggregated rows back into per-day lists
    for anchor_day, ret_map in agg_window.items():
        window_by_day[anchor_day].extend(ret_map.values())
    for anchor_day, ret_map in agg_cohort.items():
        cohort_by_day[anchor_day].extend(ret_map.values())

    if n_ctx_aggregated > 0:
        diagnostics.append(
            f"INFO edge {ev.edge_id[:8]}…: aggregated {n_ctx_aggregated} "
            f"context-prefixed rows into bare window()/cohort()"
        )

    # Step 2: Build trajectories for each obs_type.
    _settings = settings or {}
    zcf = _settings.get("features", {}).get("zero_count_filter", True)
    # zero_count_filter feature flag: --feature zero_count_filter=false
    window_trajs, window_daily = _build_trajectories_for_obs_type(
        window_by_day, "window", et, today, diagnostics,
        zero_count_filter=zcf,
    )
    cohort_trajs, cohort_daily = _build_trajectories_for_obs_type(
        cohort_by_day, "cohort", et, today, diagnostics,
        zero_count_filter=zcf,
    )

    # Step 3: Attach to EdgeEvidence.
    if window_trajs or window_daily:
        ev.cohort_obs.append(CohortObservation(
            slice_dsl="window(snapshot)",
            daily=window_daily,
            trajectories=window_trajs,
        ))
        ev.has_window = True
        for t in window_trajs:
            ev.total_n += t.n
        for d in window_daily:
            ev.total_n += d.n

    if cohort_trajs or cohort_daily:
        ev.cohort_obs.append(CohortObservation(
            slice_dsl="cohort(snapshot)",
            daily=cohort_daily,
            trajectories=cohort_trajs,
        ))
        ev.has_cohort = True
        for t in cohort_trajs:
            ev.total_n += t.n
        for d in cohort_daily:
            ev.total_n += d.n

    # Step 4: Collect per-retrieval-date onset observations.
    # onset_delta_days is derived once per retrieval date per edge from
    # the Amplitude lag histogram (1% mass point). Each DB row carries
    # the same onset for that retrieval — rows are NOT independent.
    # Deduplicate by retrieval date to get one observation per date.
    if et.has_latency and ev.latency_prior is not None:
        seen_dates: set[str] = set()
        onset_obs: list[float] = []
        for row in rows:
            onset_val = row.get("onset_delta_days")
            if onset_val is None:
                continue
            ret_date = str(row.get("retrieved_at", ""))[:10]
            if ret_date in seen_dates:
                continue
            seen_dates.add(ret_date)
            onset_obs.append(float(onset_val))
        if onset_obs:
            ev.latency_prior.onset_observations = onset_obs

    # Return covered anchor_days so the caller can deduplicate
    # param-file supplementation.
    covered: set[str] = set()
    covered.update(window_by_day.keys())
    covered.update(cohort_by_day.keys())
    return covered


def _build_trajectories_for_obs_type(
    by_day: dict[str, list[dict]],
    obs_type: str,
    et,
    today: datetime,
    diagnostics: list[str],
    *,
    zero_count_filter: bool = True,
) -> tuple[list[CohortDailyTrajectory], list[CohortDailyObs]]:
    """Build trajectory and fallback objects for one observation type.

    Groups rows by anchor_day (already done by caller), deduplicates
    by retrieved_at, and produces CohortDailyTrajectory for multi-
    retrieval days, CohortDailyObs for single-retrieval days.
    """
    trajectories: list[CohortDailyTrajectory] = []
    daily_fallback: list[CohortDailyObs] = []

    for anchor_day in sorted(by_day.keys()):
        day_rows = by_day[anchor_day]

        # Deduplicate by retrieved_at (same observation from overlapping slices)
        seen_ret: dict[str, dict] = {}
        for r in day_rows:
            ret_key = str(r.get("retrieved_at", ""))
            if ret_key not in seen_ret:
                seen_ret[ret_key] = r
        deduped = sorted(seen_ret.values(), key=lambda r: str(r.get("retrieved_at", "")))

        # Resolve denominator: always use x (from-node count).
        # Both window and cohort observations are edge-level: y/x
        # is the edge conversion rate. The anchor count (a) is only
        # relevant for display (path rate y/a), not for modelling.
        # For first edges, a = x (anchor IS the from-node).
        denom = max((_safe_int(r.get("x")) or 0 for r in deduped), default=0)
        denom = denom if denom > 0 else None

        if denom is None or denom <= 0:
            continue

        if len(deduped) >= 2:
            # Multiple retrievals → trajectory
            retrieval_ages: list[float] = []
            cumulative_y: list[int] = []
            cumulative_x: list[int] = []
            prev_y = 0
            prev_x = 0

            for r in deduped:
                retrieved_at = str(r.get("retrieved_at", ""))
                y = _safe_int(r.get("y"))
                if y is None:
                    y = 0
                x = _safe_int(r.get("x"))
                if x is None:
                    x = 0

                age = _retrieval_age(anchor_day, retrieved_at, today)
                if age <= 0:
                    continue

                # Monotonise y and cap at denominator
                y = max(y, prev_y)
                y = min(y, denom)
                # Monotonise x (from-node arrivals can only grow)
                x = max(x, prev_x)
                prev_y = y
                prev_x = x

                retrieval_ages.append(age)
                cumulative_y.append(y)
                cumulative_x.append(x)

            # Merge consecutive zero-count intervals ONLY after the curve
            # has started maturing (after first non-zero y). Pre-onset
            # zero-count ages are preserved — they constrain onset location.
            # Post-maturity zero-count ages (after the last y increment)
            # are merged — they carry no new information.
            #
            # The DM logp for a zero-count bin is gammaln(0+α) - gammaln(α) = 0
            # mathematically. But empirically, preserving pre-onset density
            # is critical for NUTS geometry on edges with onset-mu correlation.
            if zero_count_filter and len(retrieval_ages) >= 2:
                # Zero-count bin filter: drop ages where neither y nor x
                # changed from the previous kept point. A trajectory of
                # identical y values (e.g. old anchor days observed twice
                # post-maturation) collapses to a single point → daily obs.
                # Likelihood-lossless: gammaln(0+α)-gammaln(α)=0.
                # See journal 26-Mar-26: post-maturation trajectory fix.
                keep = [False] * len(retrieval_ages)
                keep[0] = True  # always keep the first point

                for i in range(1, len(retrieval_ages)):
                    y_changed = cumulative_y[i] != cumulative_y[i - 1]
                    x_changed = cumulative_x[i] != cumulative_x[i - 1]
                    if y_changed or x_changed:
                        keep[i] = True
                        keep[i - 1] = True  # keep the point before a change too

                retrieval_ages = [a for a, k in zip(retrieval_ages, keep) if k]
                cumulative_y = [y for y, k in zip(cumulative_y, keep) if k]
                cumulative_x = [x for x, k in zip(cumulative_x, keep) if k]

            if len(retrieval_ages) >= 2:
                trajectories.append(CohortDailyTrajectory(
                    date=anchor_day,
                    n=denom,
                    obs_type=obs_type,
                    retrieval_ages=retrieval_ages,
                    cumulative_y=cumulative_y,
                    cumulative_x=cumulative_x,
                    path_edge_ids=et.path_edge_ids,
                ))
            elif len(retrieval_ages) == 1:
                _append_single_obs(
                    daily_fallback, anchor_day, denom,
                    cumulative_y[0], retrieval_ages[0],
                    obs_type, et,
                )
        else:
            # Single retrieval → CohortDailyObs
            r = deduped[0]
            y = _safe_int(r.get("y")) or 0
            retrieved_at = str(r.get("retrieved_at", ""))
            age = _retrieval_age(anchor_day, retrieved_at, today)
            _append_single_obs(
                daily_fallback, anchor_day, denom,
                min(y, denom), age,
                obs_type, et,
            )

    return trajectories, daily_fallback


def _append_single_obs(
    daily_list: list[CohortDailyObs],
    anchor_day: str,
    n: int,
    k: int,
    age: float,
    obs_type: str,
    et,
) -> None:
    """Append a single-retrieval CohortDailyObs with appropriate completeness."""
    if not et.has_latency:
        # No-latency edge: conversion is instant, completeness=1.0 at all ages.
        compl = 1.0
    elif obs_type == "window":
        compl = _compute_cohort_completeness(
            age,
            et.onset_delta_days, et.mu_prior, et.sigma_prior,
            et.has_latency,
        )
    else:
        compl = _compute_cohort_completeness(
            age,
            et.path_latency.path_delta,
            et.path_latency.path_mu,
            et.path_latency.path_sigma,
            et.has_latency,
        )
    daily_list.append(CohortDailyObs(
        date=anchor_day,
        n=n,
        k=k,
        age_days=age,
        completeness=compl,
    ))


def _resolve_value_retrieved_at(v: dict, fallback: datetime) -> datetime:
    """Extract data_source.retrieved_at from a values[] entry.

    Returns the parsed datetime if present and parseable, otherwise
    the fallback (typically wall-clock today). This ensures age and
    completeness computations use the actual observation timestamp
    rather than the time the model happens to run.
    """
    ds = v.get("data_source")
    if not isinstance(ds, dict):
        return fallback
    raw = ds.get("retrieved_at")
    if not raw or not isinstance(raw, str):
        return fallback
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ",
                "%Y-%m-%d %H:%M:%S", "%Y-%m-%d",
                "%d-%b-%y", "%d-%b-%Y"):
        try:
            return datetime.strptime(raw[:19], fmt)
        except ValueError:
            continue
    return fallback


def _bind_from_param_file(
    ev: EdgeEvidence,
    et,
    pf_data: dict,
    today: datetime,
    settings: dict,
    diagnostics: list[str],
) -> None:
    """Bind evidence from parameter file values[] (existing Phase A path).

    Extracted from bind_evidence() so both paths can share this logic.

    Each values[] entry's age/completeness is computed relative to its
    data_source.retrieved_at timestamp (the moment the data was fetched
    from source), falling back to wall-clock today when absent.
    """
    values = pf_data.get("values") or []
    for v in values:
        if not isinstance(v, dict):
            continue
        slice_dsl = v.get("sliceDSL", "") or ""
        n = _safe_int(v.get("n"))
        k = _safe_int(v.get("k"))

        # Use the actual retrieval timestamp for age/completeness,
        # falling back to today if the entry predates this field.
        ref_date = _resolve_value_retrieved_at(v, today)

        if _is_cohort(slice_dsl):
            n_daily = v.get("n_daily") or []
            k_daily = v.get("k_daily") or []
            dates = v.get("dates") or []

            if n_daily and k_daily and dates and len(n_daily) == len(k_daily) == len(dates):
                daily_obs = _build_cohort_daily(
                    n_daily, k_daily, dates, ref_date,
                    et.path_latency.path_delta,
                    et.path_latency.path_mu,
                    et.path_latency.path_sigma,
                    et.has_latency,
                )
                if daily_obs:
                    ev.cohort_obs.append(CohortObservation(
                        slice_dsl=slice_dsl,
                        daily=daily_obs,
                    ))
                    ev.has_cohort = True
                    ev.total_n += sum(d.n for d in daily_obs)
            elif n is not None and k is not None and n > 0:
                cohort_age = _estimate_cohort_age(slice_dsl, ref_date)
                compl = _compute_cohort_completeness(
                    cohort_age,
                    et.path_latency.path_delta,
                    et.path_latency.path_mu,
                    et.path_latency.path_sigma,
                    et.has_latency,
                )
                ev.cohort_obs.append(CohortObservation(
                    slice_dsl=slice_dsl,
                    daily=[CohortDailyObs(
                        date="aggregate",
                        n=n, k=k,
                        age_days=cohort_age,
                        completeness=compl,
                    )],
                ))
                ev.has_cohort = True
                ev.total_n += n

        elif _is_window(slice_dsl) or (n is not None and k is not None):
            if n is not None and k is not None and n > 0:
                compl = _compute_window_completeness(
                    slice_dsl, ref_date,
                    et.onset_delta_days, et.mu_prior, et.sigma_prior,
                    et.has_latency,
                )
                ev.window_obs.append(WindowObservation(
                    n=n, k=k,
                    slice_dsl=slice_dsl,
                    completeness=compl,
                ))
                ev.has_window = True
                ev.total_n += n


def _normalise_date_key(date_str: str) -> str:
    """Normalise a date string to ISO YYYY-MM-DD for dedup keying.

    Snapshot DB rows use ISO dates; param-file dates[] may use UK
    (d-MMM-yy) or ISO format.  Returns the original string if
    parsing fails — this is safe because the dedup is conservative:
    an unparseable key simply won't match, so the point is kept
    rather than incorrectly deduplicated.
    """
    for fmt in ("%Y-%m-%d", "%d-%b-%y", "%d-%b-%Y"):
        try:
            return datetime.strptime(date_str, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return date_str


def _supplement_from_param_file(
    ev: EdgeEvidence,
    et,
    pf_data: dict,
    today: datetime,
    settings: dict,
    snapshot_covered_days: set[str],
    diagnostics: list[str],
) -> int:
    """Supplement snapshot evidence with param-file data for uncovered days.

    For each cohort values[] entry with daily arrays (n_daily, k_daily,
    dates), injects observations for anchor_days NOT already covered by
    snapshot trajectories.  Window aggregates and cohort aggregates are
    skipped — the snapshot trajectories are strictly richer.

    Returns the number of supplemented daily observations.
    """
    # Normalise the snapshot-covered set to ISO keys for cross-format matching.
    covered_iso = {_normalise_date_key(d) for d in snapshot_covered_days}

    values = pf_data.get("values") or []
    n_supplemented = 0

    for v in values:
        if not isinstance(v, dict):
            continue
        slice_dsl = v.get("sliceDSL", "") or ""

        # Only supplement cohort daily arrays — these have per-anchor_day
        # granularity that can be precisely deduplicated against snapshot
        # trajectories.  Window aggregates (sum across window period) and
        # cohort aggregates cannot be deduplicated at the anchor_day level.
        if not _is_cohort(slice_dsl):
            continue

        n_daily = v.get("n_daily") or []
        k_daily = v.get("k_daily") or []
        dates = v.get("dates") or []

        if not (n_daily and k_daily and dates
                and len(n_daily) == len(k_daily) == len(dates)):
            continue

        ref_date = _resolve_value_retrieved_at(v, today)

        # Filter to anchor_days not already covered by snapshot data.
        supplemented_obs: list[CohortDailyObs] = []
        for i in range(len(n_daily)):
            date_str = str(dates[i]) if i < len(dates) else ""
            if _normalise_date_key(date_str) in covered_iso:
                continue  # snapshot trajectory exists for this day

            n = _safe_int(n_daily[i])
            k = _safe_int(k_daily[i])
            if n is None or n <= 0:
                continue

            age = _date_age(date_str, ref_date)
            compl = _compute_cohort_completeness(
                age,
                et.path_latency.path_delta,
                et.path_latency.path_mu,
                et.path_latency.path_sigma,
                et.has_latency,
            )
            supplemented_obs.append(CohortDailyObs(
                date=date_str,
                n=n,
                k=k if k is not None else 0,
                age_days=age,
                completeness=compl,
            ))

        if supplemented_obs:
            ev.cohort_obs.append(CohortObservation(
                slice_dsl=slice_dsl,
                daily=supplemented_obs,
            ))
            ev.has_cohort = True
            ev.total_n += sum(d.n for d in supplemented_obs)
            n_supplemented += len(supplemented_obs)

    return n_supplemented


def _retrieval_age(anchor_day: str, retrieved_at: str, today: datetime) -> float:
    """Compute age in days between anchor_day and retrieved_at."""
    anchor_dt = None
    for fmt in ("%Y-%m-%d", "%d-%b-%y", "%d-%b-%Y"):
        try:
            anchor_dt = datetime.strptime(anchor_day, fmt)
            break
        except ValueError:
            continue

    retrieval_dt = None
    # retrieved_at may be a full datetime or just a date
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d",
                "%d-%b-%y", "%d-%b-%Y"):
        try:
            retrieval_dt = datetime.strptime(retrieved_at[:19], fmt)
            break
        except ValueError:
            continue

    if anchor_dt and retrieval_dt:
        return max(0.0, (retrieval_dt - anchor_dt).days)

    # Fallback: use today - anchor_day
    if anchor_dt:
        return max(0.0, (today - anchor_dt).days)

    return 30.0  # conservative default


# ---------------------------------------------------------------------------
# Prior resolution
# ---------------------------------------------------------------------------

# Warm-start quality gates.  If the previous posterior didn't converge,
# using it as a prior can poison subsequent runs.  Only accept warm-start
# when rhat is acceptable AND ESS is non-trivial.
_WARM_START_RHAT_MAX = 1.10
_WARM_START_ESS_MIN = 100


def _warm_start_acceptable(slice_data: dict) -> bool:
    """Return True if the posterior slice meets quality gates for warm-start."""
    rhat = slice_data.get("rhat")
    ess = slice_data.get("ess")
    if rhat is not None and float(rhat) > _WARM_START_RHAT_MAX:
        return False
    if ess is not None and float(ess) < _WARM_START_ESS_MIN:
        return False
    return True


def _resolve_latency_prior(et, pf_data: dict | None) -> LatencyPrior:
    """Resolve latency prior for an edge (doc 21: warm-start from posterior).

    Priority:
      1. Previous Bayesian posterior (posterior.slices["window()"].mu_mean/sigma_mean)
      2. Topology-derived from graph edge (mu_prior/sigma_prior from stats pass)
    """
    onset = et.onset_delta_days
    lat_mu = et.mu_prior
    lat_sigma = et.sigma_prior
    lat_source = "topology"

    if isinstance(pf_data, dict):
        posterior = pf_data.get("posterior")
        if isinstance(posterior, dict):
            slices = posterior.get("slices")
            if isinstance(slices, dict):
                ws = slices.get("window()", {})
                prev_mu = ws.get("mu_mean")
                prev_sigma = ws.get("sigma_mean")
                if (prev_mu is not None and prev_sigma is not None
                        and _warm_start_acceptable(ws)):
                    lat_mu = float(prev_mu)
                    lat_sigma = float(prev_sigma)
                    lat_source = "warm_start"
                    prev_onset = ws.get("onset_mean")
                    if prev_onset is not None:
                        onset = float(prev_onset)

    return LatencyPrior(
        onset_delta_days=onset,
        mu=lat_mu,
        sigma=lat_sigma,
        onset_uncertainty=max(1.0, onset * 0.3),
        source=lat_source,
    )


def _resolve_prior(pf_data: dict, topo_fingerprint: str) -> ProbabilityPrior:
    """Resolve the probability prior for an edge.

    Priority:
      1. Warm-start from previous posterior (if structurally compatible)
      2. Moment-matched from current point estimates
      3. Uninformative Beta(1, 1)
    """
    # Doc 21: read warm-start alpha/beta from posterior.slices["window()"]
    # (unified schema) or fall back to _model_state p_base, then legacy
    # top-level posterior.alpha/beta for backwards compatibility.
    posterior = pf_data.get("posterior")
    alpha_raw = None
    beta_raw = None
    if isinstance(posterior, dict):
        # Unified schema (doc 21): slices["window()"].alpha/beta
        slices = posterior.get("slices")
        if isinstance(slices, dict):
            window_slice = slices.get("window()", {})
            if (window_slice.get("alpha") and window_slice.get("beta")
                    and _warm_start_acceptable(window_slice)):
                alpha_raw = window_slice["alpha"]
                beta_raw = window_slice["beta"]
        # Fallback: _model_state.p_base_alpha/beta (hierarchy anchor)
        if alpha_raw is None:
            ms = posterior.get("_model_state") or {}
            # _model_state keys are edge-keyed; we don't have edge_id here,
            # so we skip this fallback for now. Phase C can add it.
        # Legacy fallback: top-level alpha/beta (pre-doc-21 schema)
        if alpha_raw is None and posterior.get("alpha") and posterior.get("beta"):
            alpha_raw = posterior["alpha"]
            beta_raw = posterior["beta"]
    if alpha_raw is not None and beta_raw is not None:
        alpha = float(alpha_raw)
        beta = float(beta_raw)
        # ESS cap: if prior is too informative, scale down
        ess = alpha + beta
        capped = False
        if ess > ESS_CAP:
            scale = ESS_CAP / ess
            alpha *= scale
            beta *= scale
            capped = True
        if alpha > 0 and beta > 0:
            return ProbabilityPrior(
                alpha=alpha, beta=beta,
                source="warm_start",
                ess_cap_applied=capped,
            )

    # Moment-matched from point estimates
    values = pf_data.get("values") or []
    if values and isinstance(values[0], dict):
        mean = values[0].get("mean")
        stdev = values[0].get("stdev")
        if (mean is not None and stdev is not None
                and 0 < float(mean) < 1 and float(stdev) > 0):
            m = float(mean)
            s = float(stdev)
            v = s * s
            if v < m * (1 - m):
                common = (m * (1 - m) / v) - 1
                if common > 0:
                    alpha = m * common
                    beta = (1 - m) * common
                    ess = alpha + beta
                    if ess > ESS_CAP:
                        scale = ESS_CAP / ess
                        alpha *= scale
                        beta *= scale
                    return ProbabilityPrior(
                        alpha=max(alpha, 0.5),
                        beta=max(beta, 0.5),
                        source="moment_matched",
                    )

        # Fallback: derive from k/n when stdev is missing
        n_val = values[0].get("n")
        k_val = values[0].get("k")
        if (n_val is not None and k_val is not None
                and int(n_val) > 0 and 0 <= int(k_val) <= int(n_val)):
            n_int = int(n_val)
            k_int = int(k_val)
            # Use k/n as the mean, with a moderate pseudo-count.
            # Don't use the full n (would be massively overconfident);
            # use a capped ESS that gives the sampler a sensible
            # starting region without over-constraining.
            pseudo_n = min(n_int, ESS_CAP)
            alpha = max((k_int / n_int) * pseudo_n, 0.5)
            beta = max((1 - k_int / n_int) * pseudo_n, 0.5)
            return ProbabilityPrior(
                alpha=alpha,
                beta=beta,
                source="kn_derived",
            )

    return ProbabilityPrior(alpha=1.0, beta=1.0, source="uninformative")


def _resolve_warm_start_extras(ev, et, pf_data: dict | None) -> None:
    """Populate kappa, kappa_p, and cohort latency warm-start from previous posterior.

    Reads from posterior._model_state (kappa, kappa_p) and
    posterior.slices["cohort()"] (path latency).  All values are
    quality-gated via the window() slice — if the previous run didn't
    converge, none of these warm-starts are used.
    """
    if not isinstance(pf_data, dict):
        return
    posterior = pf_data.get("posterior")
    if not isinstance(posterior, dict):
        return

    # Quality gate: check window() slice convergence.
    # All warm-start extras are gated on the same quality check as
    # p and latency — if the previous run was bad, skip everything.
    slices = posterior.get("slices")
    if isinstance(slices, dict):
        ws = slices.get("window()", {})
        if not _warm_start_acceptable(ws):
            return
    else:
        return

    # kappa and kappa_p from _model_state
    ms = posterior.get("_model_state") or {}
    safe_eid = ev.edge_id.replace("-", "_")

    kappa_key = f"kappa_{safe_eid}"
    if kappa_key in ms:
        val = float(ms[kappa_key])
        if val > 0:
            ev.kappa_warm = val

    kappa_p_key = f"kappa_p_{safe_eid}"
    if kappa_p_key in ms:
        val = float(ms[kappa_p_key])
        if val > 0:
            ev.kappa_p_warm = val

    # Cohort (path) latency from cohort() slice
    cs = slices.get("cohort()", {})
    if cs and _warm_start_acceptable(cs):
        c_mu = cs.get("mu_mean")
        c_sigma = cs.get("sigma_mean")
        c_onset = cs.get("onset_mean")
        if c_mu is not None and c_sigma is not None:
            ev.cohort_latency_warm = {
                "mu": float(c_mu),
                "sigma": float(c_sigma),
                "onset": float(c_onset) if c_onset is not None else None,
            }


# ---------------------------------------------------------------------------
# Observation classification
# ---------------------------------------------------------------------------

_COHORT_RE = re.compile(r"cohort\(", re.IGNORECASE)
_WINDOW_RE = re.compile(r"window\(", re.IGNORECASE)


def _is_cohort(slice_dsl: str) -> bool:
    return bool(_COHORT_RE.search(slice_dsl))


def _is_window(slice_dsl: str) -> bool:
    return bool(_WINDOW_RE.search(slice_dsl))


# ---------------------------------------------------------------------------
# Phase C: slice routing
# ---------------------------------------------------------------------------

def _route_slices(
    ev: EdgeEvidence,
    settings: dict,
    diagnostics: list[str],
) -> None:
    """Route sliced observations from aggregate lists into SliceGroups.

    After the main binding loop, window_obs and cohort_obs contain ALL
    observations (aggregate + sliced). This function:
    1. Identifies sliced observations (non-empty context_key)
    2. Groups them by dimension
    3. Moves them into ev.slice_groups
    4. Leaves aggregate observations (empty context_key) in place
    5. Detects exhaustiveness for MECE dimensions
    6. Computes residuals for partial MECE dimensions

    Modifies ev in place. No-op if no sliced observations exist.
    """
    min_n_slice = settings.get("min_n_slice", MIN_N_THRESHOLD)

    # Collect all sliceDSL strings to discover dimensions
    all_dsls: list[str] = []
    for w in ev.window_obs:
        all_dsls.append(w.slice_dsl)
    for c in ev.cohort_obs:
        all_dsls.append(c.slice_dsl)

    # Build dimension → [context_key, ...] mapping
    from .slices import extract_dimensions
    dim_map = extract_dimensions(all_dsls)
    if not dim_map:
        return  # no sliced observations

    # Partition window_obs and cohort_obs into aggregate vs sliced
    agg_window: list[WindowObservation] = []
    sliced_window: dict[str, list[WindowObservation]] = {}  # context_key → [obs]
    for w in ev.window_obs:
        ctx = context_key(w.slice_dsl)
        if ctx:
            sliced_window.setdefault(ctx, []).append(w)
        else:
            agg_window.append(w)

    agg_cohort: list[CohortObservation] = []
    sliced_cohort: dict[str, list[CohortObservation]] = {}
    for c in ev.cohort_obs:
        ctx = context_key(c.slice_dsl)
        if ctx:
            sliced_cohort.setdefault(ctx, []).append(c)
        else:
            agg_cohort.append(c)

    if not sliced_window and not sliced_cohort:
        return  # all observations are aggregate

    # Replace aggregate lists with only the true aggregates
    ev.window_obs = agg_window
    ev.cohort_obs = agg_cohort

    # Build SliceGroups
    for dim_key_str, ctx_keys in dim_map.items():
        mece = is_mece_dimension(dim_key_str)
        group = SliceGroup(
            dimension_key=dim_key_str,
            is_mece=mece,
        )

        total_slice_n = 0
        for ctx in ctx_keys:
            s_obs = SliceObservations(context_key=ctx)

            # Window observations for this slice
            for w in sliced_window.get(ctx, []):
                s_obs.window_obs.append(w)
                s_obs.total_n += w.n
                s_obs.has_window = True

            # Cohort observations for this slice
            for c in sliced_cohort.get(ctx, []):
                s_obs.cohort_obs.append(c)
                n_from_cohort = sum(d.n for d in c.daily)
                n_from_cohort += sum(
                    t.n for t in c.trajectories
                )
                s_obs.total_n += n_from_cohort
                s_obs.has_cohort = True

            # Per-slice min-n gate
            if s_obs.total_n < min_n_slice:
                continue  # too sparse — fold into residual

            total_slice_n += s_obs.total_n
            group.slices[ctx] = s_obs

        if not group.slices:
            continue  # all slices below min-n

        # Exhaustiveness check for MECE dimensions
        agg_n = sum(w.n for w in agg_window) + sum(
            sum(d.n for d in c.daily) + sum(t.n for t in c.trajectories)
            for c in agg_cohort
        )
        if mece and agg_n > 0:
            coverage = total_slice_n / agg_n if agg_n > 0 else 0
            group.is_exhaustive = coverage > 0.85
            # For partial MECE: compute residual
            if not group.is_exhaustive:
                residual_n = max(0, agg_n - total_slice_n)
                if residual_n > min_n_slice:
                    # Residual gets the aggregate obs as-is (represents
                    # the unsliced remainder)
                    group.residual = SliceObservations(
                        context_key="__residual__",
                        window_obs=list(agg_window),
                        cohort_obs=list(agg_cohort),
                        total_n=residual_n,
                        has_window=bool(agg_window),
                        has_cohort=bool(agg_cohort),
                    )

        ev.slice_groups[dim_key_str] = group
        ev.has_slices = True

        n_slices = len(group.slices)
        diagnostics.append(
            f"  slices: {ev.edge_id[:8]}… dim={dim_key_str}, "
            f"{n_slices} slices, mece={mece}, "
            f"exhaustive={group.is_exhaustive}"
        )


# ---------------------------------------------------------------------------
# Completeness computation
# ---------------------------------------------------------------------------

def _compute_window_completeness(
    slice_dsl: str,
    today: datetime,
    onset: float,
    mu: float,
    sigma: float,
    has_latency: bool,
) -> float:
    """Compute edge-level completeness for a window observation.

    Window completeness = CDF(obs_time, onset, mu, sigma) where
    obs_time ≈ days since window midpoint (conservative estimate).
    """
    if not has_latency:
        return 1.0

    # Extract window end date from DSL if possible
    window_end = _extract_date_from_dsl(slice_dsl, position="end")
    if window_end:
        obs_time = (today - window_end).days
    else:
        obs_time = 30.0  # conservative default

    return shifted_lognormal_cdf(obs_time, onset, mu, sigma)


def _compute_cohort_completeness(
    age_days: float,
    path_delta: float,
    path_mu: float,
    path_sigma: float,
    has_latency: bool,
) -> float:
    """Compute path-level completeness for a cohort observation.

    Uses path-level latency even for non-latency edges: a non-latency
    edge downstream of a latency edge inherits upstream path immaturity.
    The path_delta/mu/sigma already reflect the upstream composition
    (topology.py line 281: non-latency edges inherit source node's path).
    Completeness = 1.0 only when the entire path has trivial latency.
    """
    if path_sigma <= 0.01 and path_delta == 0.0:
        return 1.0
    return shifted_lognormal_cdf(age_days, path_delta, path_mu, path_sigma)


def _build_cohort_daily(
    n_daily: list,
    k_daily: list,
    dates: list,
    today: datetime,
    path_delta: float,
    path_mu: float,
    path_sigma: float,
    has_latency: bool,
) -> list[CohortDailyObs]:
    """Build per-day cohort observations with age and completeness."""
    result = []
    for i in range(len(n_daily)):
        n = _safe_int(n_daily[i])
        k = _safe_int(k_daily[i])
        date_str = str(dates[i]) if i < len(dates) else ""

        if n is None or n <= 0:
            continue

        age = _date_age(date_str, today)
        compl = _compute_cohort_completeness(
            age, path_delta, path_mu, path_sigma, has_latency,
        )

        result.append(CohortDailyObs(
            date=date_str,
            n=n,
            k=k if k is not None else 0,
            age_days=age,
            completeness=compl,
        ))

    return result


# ---------------------------------------------------------------------------
# Date helpers
# ---------------------------------------------------------------------------

def _parse_today(today: str | None) -> datetime:
    if today is None:
        return datetime.utcnow()
    for fmt in ("%d-%b-%y", "%Y-%m-%d", "%d-%b-%Y"):
        try:
            return datetime.strptime(today, fmt)
        except ValueError:
            continue
    return datetime.utcnow()


def _date_age(date_str: str, today: datetime) -> float:
    """Days between date_str and today."""
    for fmt in ("%Y-%m-%d", "%d-%b-%y", "%d-%b-%Y"):
        try:
            dt = datetime.strptime(date_str, fmt)
            return max(0.0, (today - dt).days)
        except ValueError:
            continue
    return 30.0  # fallback


_DATE_RANGE_RE = re.compile(
    r"(\d{1,2}-[A-Za-z]{3}-\d{2,4})\s*:\s*(\d{1,2}-[A-Za-z]{3}-\d{2,4})"
)
_ISO_DATE_RANGE_RE = re.compile(
    r"(\d{4}-\d{2}-\d{2})\s*:\s*(\d{4}-\d{2}-\d{2})"
)


def _extract_date_from_dsl(dsl: str, position: str = "end") -> datetime | None:
    """Extract a date from a slice DSL string."""
    # Try UK format first (d-MMM-yy)
    m = _DATE_RANGE_RE.search(dsl)
    if m:
        date_str = m.group(2) if position == "end" else m.group(1)
        return _parse_today(date_str)

    # Try ISO format
    m = _ISO_DATE_RANGE_RE.search(dsl)
    if m:
        date_str = m.group(2) if position == "end" else m.group(1)
        return _parse_today(date_str)

    return None


def _estimate_cohort_age(slice_dsl: str, today: datetime) -> float:
    """Estimate cohort age from the DSL's date range."""
    end_date = _extract_date_from_dsl(slice_dsl, position="end")
    if end_date:
        return max(0.0, (today - end_date).days)
    return 60.0  # conservative default


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def _safe_int(v) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except (ValueError, TypeError):
        return None


def _resolve_param_file(param_id: str, param_files: dict[str, dict]) -> dict | None:
    """Look up param file data, trying various ID formats."""
    # Direct match
    if param_id in param_files:
        return param_files[param_id]

    # Try with/without "parameter-" prefix
    if param_id.startswith("parameter-"):
        bare = param_id[len("parameter-"):]
        if bare in param_files:
            return param_files[bare]
    else:
        prefixed = f"parameter-{param_id}"
        if prefixed in param_files:
            return param_files[prefixed]

    return None


def _build_path_lookup(params_index: dict | None) -> dict[str, str]:
    """Build param_id → file_path lookup from parameters index."""
    if not params_index:
        return {}

    result: dict[str, str] = {}
    entries = params_index.get("parameters", [])
    if not isinstance(entries, list):
        return {}

    for entry in entries:
        pid = entry.get("id", "")
        fpath = entry.get("file", "")
        if pid and fpath:
            result[pid] = fpath
            result[f"parameter-{pid}"] = fpath

    return result
