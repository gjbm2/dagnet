"""
Carrier resolver, legacy-fallback warning, and CohortEvidence container.

What survived the 73q Phase 7 cleanup:

- `_resolve_edge_p` / `_warn_legacy_pmean_carrier`: the documented
  pre-Stage-4 fallback that fires when a graph edge carries only legacy
  `p.mean` rather than a promoted-baseline source (doc 73b §6.5 / §3.8).
  Used by `path_runner._effective_edge_probability` and `graph_builder`.

- `CohortEvidence`: per-Cohort evidence data container consumed by the
  v3 conditioned-forecast runtime (`cohort_forecast_v3`).

The legacy trajectory engine (`compute_forecast_trajectory` and its
support cast — `ForecastState`, `TrajectoryPoint`, `ForecastTrajectory`,
`CohortForecastAtEval`, `build_node_arrival_cache`, `NodeArrivalState`,
`_convolve_completeness_at_age`, `_compose_rate_sd`,
`compute_completeness_with_sd`, `_compute_completeness_at_age`,
`Dispersions`, `_trajectory_fallback_draw_family_key`,
`_evaluate_cohort`, `_mass_from_cohorts`, `_compute_blend_params`,
`_carrier_runtime_diagnostics`) was retired by 73q Phase 7 once the
daily-conversions and surprise-gauge paths migrated to the shared CF
projection bundle.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import numpy as np


_LEGACY_PMEAN_CARRIER_WARNED: set = set()


def _warn_legacy_pmean_carrier(edge: Dict[str, Any], context: str = '') -> None:
    """One-line warning when a carrier read falls back to legacy `p.mean`.

    Doc 73b §6.5 requires carrier consumers to read the promoted-baseline
    model probability via `resolve_model_params`, never the L5
    current-answer scalar `p.mean`. The fallback below is a documented,
    transitional degrade for pre-Stage 4 graphs / synthetic fixtures that
    have only `p.mean` populated — no `model_vars`, no `posterior`, no
    `forecast.mean`. To be removed once all fixtures populate the
    promoted layer (cf. §3.8 fallback register).
    """
    edge_id = edge.get('id') or edge.get('uuid') or '?'
    key = (edge_id, context)
    if key in _LEGACY_PMEAN_CARRIER_WARNED:
        return
    _LEGACY_PMEAN_CARRIER_WARNED.add(key)
    logging.getLogger(__name__).warning(
        "doc 73b §6.5: edge %r%s falling back to legacy p.mean for carrier "
        "read (no promoted-baseline model — check FE topo / applyPromotion)",
        edge_id,
        f' [{context}]' if context else '',
    )


def _resolve_edge_p(edge: Dict[str, Any]) -> float:
    """Resolve carrier probability via the shared resolver (doc 73b §6.5).

    Carriers MUST read the promoted-baseline model probability through
    `resolve_model_params`, not the L5 current-answer scalar `p.mean`
    (the §3.3.3 layer-isolation invariant — changing only a current
    query-owned scalar must not alter carrier behaviour).

    The fallback to legacy `p.mean` (with one-line WARNING log) is the
    §3.8 documented degrade for pre-Stage 4 graphs / synthetic fixtures
    that lack a promoted-baseline source. Provenance:
    `_warn_legacy_pmean_carrier`. Owner: Stage 4(d) transition.
    """
    from .model_resolver import resolve_model_params

    result = resolve_model_params(edge, scope='edge', temporal_mode='window')
    if result is not None and result.p_mean > 0:
        return float(result.p_mean)
    p_obj = edge.get('p') or {}
    legacy = p_obj.get('mean')
    if isinstance(legacy, (int, float)) and legacy > 0:
        _warn_legacy_pmean_carrier(edge, context='_resolve_edge_p')
        return float(legacy)
    return 0.0


@dataclass
class CohortEvidence:
    """Per-Cohort evidence for the v3 conditioned-forecast runtime.

    Each Cohort is one anchor-day's worth of evidence: observed x/y
    trajectories up to the frontier age, plus frozen frontier values.

    Coordinate B (per-Cohort evaluation at a specific date):
    Set anchor_day + eval_date and the engine computes eval_age
    internally. Or set eval_age directly for consumers that work
    in τ coordinates (cohort maturity chart).
    """
    obs_x: List[float]     # x at each τ from 0..frontier_age
    obs_y: List[float]     # y at each τ from 0..frontier_age
    x_frozen: float        # N_i — x at frontier
    y_frozen: float        # k_i — y at frontier
    frontier_age: int      # a_i — last observed age (days)
    a_pop: float           # population for upstream scaling
    # Subject-rate evidence counts for IS/blend. In cohort mode with a
    # real carrier, x_frozen/y_frozen may be carrier-projected population
    # state; these fields remain the raw subject evidence counts.
    evidence_n: Optional[float] = None
    evidence_k: Optional[float] = None
    eval_age: Optional[int] = None  # coordinate B: τᵢ at which to
    # stash per-Cohort draws. When set, the sweep retains (S,) draws
    # at this column for this Cohort. When None (cohort maturity),
    # no per-Cohort stashing — only aggregate Y_total/X_total.
    anchor_day: Optional[str] = None   # ISO date string (e.g. '2026-03-07')
    eval_date: Optional[str] = None    # ISO date string — asat or today

    def __post_init__(self):
        """Compute eval_age from anchor_day + eval_date when not set."""
        if self.evidence_n is None:
            self.evidence_n = self.x_frozen
        if self.evidence_k is None:
            self.evidence_k = self.y_frozen
        if self.eval_age is None and self.anchor_day and self.eval_date:
            from datetime import date as _date
            try:
                a = _date.fromisoformat(str(self.anchor_day)[:10])
                e = _date.fromisoformat(str(self.eval_date)[:10])
                age = (e - a).days
                if age >= 0:
                    self.eval_age = age
            except (ValueError, TypeError):
                pass
