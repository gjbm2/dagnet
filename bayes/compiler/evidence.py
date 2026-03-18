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
    ESS_CAP,
    MIN_N_THRESHOLD,
)
from .completeness import shifted_lognormal_cdf


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

        # --- Latency prior (for completeness computation, not latent in Phase A) ---
        if et.has_latency:
            ev.latency_prior = LatencyPrior(
                onset_delta_days=et.onset_delta_days,
                mu=et.mu_prior,
                sigma=et.sigma_prior,
                source="topology",
            )

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

        # --- Latency prior ---
        if et.has_latency:
            ev.latency_prior = LatencyPrior(
                onset_delta_days=et.onset_delta_days,
                mu=et.mu_prior,
                sigma=et.sigma_prior,
                source="topology",
            )

        # --- Evidence: snapshot rows if available, else param file ---
        rows = snapshot_rows.get(edge_id, [])

        if rows:
            _bind_from_snapshot_rows(
                ev, et, rows, today_date, diagnostics,
            )
            diagnostics.append(
                f"INFO edge {edge_id[:8]}…: {len(rows)} snapshot rows "
                f"→ {len(ev.window_obs)} window obs, "
                f"{sum(len(c.daily) for c in ev.cohort_obs)} cohort daily obs"
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

    return BoundEvidence(
        edges=edges_evidence,
        settings=settings,
        today=today_date.strftime("%-d-%b-%y"),
        diagnostics=diagnostics,
    )


def _bind_from_snapshot_rows(
    ev: EdgeEvidence,
    et,
    rows: list[dict],
    today: datetime,
    diagnostics: list[str],
) -> None:
    """Convert snapshot DB rows to observations on an EdgeEvidence.

    Each row has: anchor_day, retrieved_at, slice_key, a, x, y, and lag cols.

    Cohort rows: builds CohortDailyTrajectory per (anchor_day, slice_key)
    — multiple retrieval ages per day form the trajectory Multinomial
    (doc 6, Layer 3 § "Maturation trajectory likelihood"). Uses `a`
    (anchor entrants) as denominator, `y` as cumulative target count.
    Falls back to single-retrieval CohortDailyObs when only one
    retrieval exists for a day.

    Window rows: latest retrieval per (anchor_day, slice_key), aggregated
    across days within each slice.
    """
    from collections import defaultdict

    # Group rows by (slice_key, anchor_day) → list of rows (all retrievals)
    by_slice_day: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in rows:
        anchor_day = str(row.get("anchor_day", ""))
        slice_key = str(row.get("slice_key", ""))
        by_slice_day[(slice_key, anchor_day)].append(row)

    # Reorganise by slice_key
    by_slice: dict[str, dict[str, list[dict]]] = defaultdict(dict)
    for (slice_key, anchor_day), day_rows in by_slice_day.items():
        by_slice[slice_key][anchor_day] = day_rows

    for slice_key, days in by_slice.items():
        if _is_cohort(slice_key):
            trajectories: list[CohortDailyTrajectory] = []
            daily_fallback: list[CohortDailyObs] = []

            for anchor_day in sorted(days.keys()):
                day_rows = days[anchor_day]

                # Sort by retrieved_at ascending
                day_rows.sort(key=lambda r: str(r.get("retrieved_at", "")))

                # Get anchor entrants (a). Should be consistent across
                # retrievals for the same day; use the first non-null.
                a_val = None
                for r in day_rows:
                    a_candidate = _safe_int(r.get("a"))
                    if a_candidate is not None and a_candidate > 0:
                        a_val = a_candidate
                        break

                if a_val is None or a_val <= 0:
                    continue

                if len(day_rows) >= 2:
                    # Multiple retrievals → trajectory
                    retrieval_ages: list[float] = []
                    cumulative_y: list[int] = []
                    prev_y = 0

                    for r in day_rows:
                        retrieved_at = str(r.get("retrieved_at", ""))
                        y = _safe_int(r.get("y"))
                        if y is None:
                            y = 0

                        age = _retrieval_age(anchor_day, retrieved_at, today)
                        if age <= 0:
                            continue

                        # Monotonise: y must not decrease
                        y = max(y, prev_y)
                        # Cap at anchor entrants
                        y = min(y, a_val)
                        prev_y = y

                        retrieval_ages.append(age)
                        cumulative_y.append(y)

                    if len(retrieval_ages) >= 2:
                        trajectories.append(CohortDailyTrajectory(
                            date=anchor_day,
                            a=a_val,
                            retrieval_ages=retrieval_ages,
                            cumulative_y=cumulative_y,
                            path_edge_ids=et.path_edge_ids,
                        ))
                        ev.total_n += a_val
                    elif len(retrieval_ages) == 1:
                        # Only one valid retrieval after filtering
                        daily_fallback.append(CohortDailyObs(
                            date=anchor_day,
                            n=a_val,
                            k=cumulative_y[0],
                            age_days=retrieval_ages[0],
                            completeness=_compute_cohort_completeness(
                                retrieval_ages[0],
                                et.path_latency.path_delta,
                                et.path_latency.path_mu,
                                et.path_latency.path_sigma,
                                et.has_latency,
                            ),
                        ))
                        ev.total_n += a_val

                else:
                    # Single retrieval → standard CohortDailyObs
                    r = day_rows[0]
                    y = _safe_int(r.get("y")) or 0
                    retrieved_at = str(r.get("retrieved_at", ""))
                    age = _retrieval_age(anchor_day, retrieved_at, today)

                    daily_fallback.append(CohortDailyObs(
                        date=anchor_day,
                        n=a_val,
                        k=min(y, a_val),
                        age_days=age,
                        completeness=_compute_cohort_completeness(
                            age,
                            et.path_latency.path_delta,
                            et.path_latency.path_mu,
                            et.path_latency.path_sigma,
                            et.has_latency,
                        ),
                    ))
                    ev.total_n += a_val

            if trajectories or daily_fallback:
                ev.cohort_obs.append(CohortObservation(
                    slice_dsl=slice_key,
                    daily=daily_fallback,
                    trajectories=trajectories,
                ))
                ev.has_cohort = True

        else:
            # Window observation — latest retrieval per anchor_day,
            # aggregated across days for this slice.
            total_x = 0
            total_y = 0
            for anchor_day, day_rows in days.items():
                # Use latest retrieval
                latest = max(day_rows, key=lambda r: str(r.get("retrieved_at", "")))
                x = _safe_int(latest.get("x"))
                y = _safe_int(latest.get("y"))
                if x is not None and x > 0:
                    total_x += x
                    total_y += min(y if y is not None else 0, x)

            if total_x > 0:
                compl = _compute_window_completeness(
                    slice_key, today,
                    et.onset_delta_days, et.mu_prior, et.sigma_prior,
                    et.has_latency,
                )
                ev.window_obs.append(WindowObservation(
                    n=total_x,
                    k=total_y,
                    slice_dsl=slice_key,
                    completeness=compl,
                ))
                ev.has_window = True
                ev.total_n += total_x


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
    """
    values = pf_data.get("values") or []
    for v in values:
        if not isinstance(v, dict):
            continue
        slice_dsl = v.get("sliceDSL", "") or ""
        n = _safe_int(v.get("n"))
        k = _safe_int(v.get("k"))

        if _is_cohort(slice_dsl):
            n_daily = v.get("n_daily") or []
            k_daily = v.get("k_daily") or []
            dates = v.get("dates") or []

            if n_daily and k_daily and dates and len(n_daily) == len(k_daily) == len(dates):
                daily_obs = _build_cohort_daily(
                    n_daily, k_daily, dates, today,
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
                cohort_age = _estimate_cohort_age(slice_dsl, today)
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
                    slice_dsl, today,
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

def _resolve_prior(pf_data: dict, topo_fingerprint: str) -> ProbabilityPrior:
    """Resolve the probability prior for an edge.

    Priority:
      1. Warm-start from previous posterior (if structurally compatible)
      2. Moment-matched from current point estimates
      3. Uninformative Beta(1, 1)
    """
    posterior = pf_data.get("posterior")
    if isinstance(posterior, dict) and posterior.get("alpha") and posterior.get("beta"):
        alpha = float(posterior["alpha"])
        beta = float(posterior["beta"])
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

    return ProbabilityPrior(alpha=1.0, beta=1.0, source="uninformative")


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
