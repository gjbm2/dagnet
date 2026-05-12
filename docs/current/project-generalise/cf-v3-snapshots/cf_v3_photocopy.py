"""
cohort_forecast_v3 — request-scoped primitive runtime row builder.

The v3 row path builds one ``ResolvedCFRuntime`` per request and reads
every public field — per-tau rate draws, fan bands, ``p_infinity_*``,
``completeness_*`` — from that runtime's composed primitive objects.
There is no aggregate carrier timing path, no ``XProvider`` carrier
solve, no ``cdf_mean`` execution surface, no tiled timing fallback, and
no projection-time semantic decision.

``window()`` and ``cohort(A = X)`` are data cases of the same runtime
object: their carrier composition is identity. Active cohort
(A != X) carries a real composed carrier built from the same primitive
registry the subject span consumes. Conditioning is owned by
``primitive_conditioning.condition_primitive`` — never by row builders,
projection helpers, or trajectory engines (single-locus invariant).
"""

import math
import numpy as np
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date as _date, timedelta as _timedelta
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .model_resolver import resolve_model_params
from .prefix_arrival import PrefixArrivalMap
from .primitive_evidence import RequestPrimitiveRegistry
from .primitives import ConditionedTransitionPrimitive
from .subject_span_composer import ComposedPrimitiveSpan
from .primitive_readout import (
    ComposedUnconditionedOverlay,
    _resolved_to_timing_transition,
)
from .timing_span import (
    TimingTransitionPrimitive,
    compose_timing_span_from_transition_primitives,
)


@dataclass(frozen=True)
class SelectedAClockEvidenceCell:
    """One selected-Cohort observation on the A-clock.

    Per docs/current/cohort-maturity-evidence-coverage-design.md §3:
    `x_at_query_x` / `y_at_subject_end` carry cumulative observed mass
    (forward-fill semantics); `*_landing_coverage` carry the freshness
    signal at exact τ (capped sum of placement shares from rows landing
    at exactly this (anchor_day, τ) for the named role's edge chain).
    Forward-fill applies to value, never to coverage.
    """

    anchor_day: str
    tau: int
    x_at_query_x: float
    y_at_subject_end: float
    source: str = 'selected_a_clock_frames'
    provenance: Mapping[str, Any] = field(default_factory=dict)
    data_retrieved_at: Optional[str] = None
    carrier_landing_coverage: float = 0.0
    subject_landing_coverage: float = 0.0


@dataclass(frozen=True)
class SelectedAClockCohortPrefix:
    """Reducer-ready selected A-clock prefix for one selected Cohort."""

    anchor_day: str
    obs_x: List[float]
    obs_y: List[float]
    frontier_age: int
    x_frozen: float
    y_frozen: float


@dataclass(frozen=True)
class _SelectedRoleSupport:
    """Strict observation-support frontier per role for one anchor day.

    Per docs/current/selected-a-clock-retrieval-frontier-provenance-proposal.md:
    strict support comes only from real retrieved rows landing at exact τ.
    Forward-filled display cells are not support. Each anchor day has its
    own A-clock age, so support is per-Cohort, not a group-wide scalar.

    For active ``cohort(A != X)`` there are two carrier frontiers:

    - ``carrier_fresh_tau``: the last exact-τ carrier landing. This is
      an observation-freshness signal, not the denominator-value frontier.
    - ``carrier_value_tau``: the last τ where the selected X prefix exists
      as an observed/carry-forward value. This is the carrier side used for
      the A/B frontier because a known carrier value remains evidence-backed
      after the last fresh carrier increment.

    ``carrier_tau`` is retained as a compatibility alias for
    ``carrier_fresh_tau`` in existing diagnostics. For identity-carrier
    (``window()`` or ``cohort(A = X)``), the carrier is structural identity,
    so the subject side is the only retrieval-bearing role and
    ``paired_tau`` equals ``subject_tau`` when present.
    """

    carrier_tau: Optional[int] = None
    carrier_fresh_tau: Optional[int] = None
    carrier_value_tau: Optional[int] = None
    subject_tau: Optional[int] = None
    paired_tau: Optional[int] = None


@dataclass(frozen=True)
class ObservedSpanEvidenceCell:
    """One topology-composed observed span count on the selected A-clock.

    `observed_count` is the topology max-flow of forward-filled per-edge
    capacities at τ (cumulative observed value, can be 0).
    `landing_coverage` is the chain's freshness signal at exactly τ for
    this anchor — min over edges of capped placement-share sums for
    rows landing at exactly this τ. `landing_coverage = 0` means no
    fresh row landed (e.g. forward-fill carry past the cohort's last
    snapshot in epoch B); positive means rows landed at this τ.
    """

    anchor_day: str
    tau: int
    observed_count: float
    edge_capacities: Mapping[str, float] = field(default_factory=dict)
    provenance: Mapping[str, Any] = field(default_factory=dict)
    landing_coverage: float = 0.0


@dataclass(frozen=True)
class ObservedSpanEvidenceSurface:
    """Primitive-bound observed evidence for one runtime role span.

    Carrier surfaces answer ``A -> X``. Subject surfaces answer
    ``X -> end`` after their X-clock primitive rows have been placed onto
    the selected A-clock.
    """

    role: str
    root_node: str
    end_node: str
    cells_by_anchor_day: Dict[str, Dict[int, ObservedSpanEvidenceCell]]
    edge_ids: Tuple[str, ...] = ()
    provenance: Mapping[str, Any] = field(default_factory=dict)

    def has_cells(self) -> bool:
        return any(bool(v) for v in self.cells_by_anchor_day.values())

    def cell_at_or_before(
        self,
        anchor_day: str,
        tau: int,
    ) -> Optional[ObservedSpanEvidenceCell]:
        tau_values = self.cells_by_anchor_day.get(str(anchor_day)[:10], {})
        eligible = [int(t) for t in tau_values.keys() if int(t) <= int(tau)]
        if not eligible:
            return None
        return tau_values[max(eligible)]

    def tau_values_for_anchor(self, anchor_day: str) -> Tuple[int, ...]:
        return tuple(sorted(self.cells_by_anchor_day.get(str(anchor_day)[:10], {})))


@dataclass
class SelectedAClockEvidence:
    """Selected A-clock count-flow evidence for cohort maturity rows.

    This is the observed count-flow object for active
    ``cohort(A, X -> end)`` chart display. It deliberately carries paired
    denominator and numerator masses so row projection cannot splice a
    denominator from one evidence clock onto a numerator from another.
    """

    cells_by_anchor_day: Dict[str, Dict[int, SelectedAClockEvidenceCell]]
    anchor_from: str
    anchor_to: str
    source: str = 'selected_a_clock_frames'
    # Diagnostic-only side-channel populated when --diag is set. Carries
    # the rate-attributed Y_prefix evaluated under three conventions so
    # the probe in cohort-outside-in-post-73n-regression-tracker.md can
    # compare them without changing production semantics. Empty in
    # production. Shape: {edge_id: {anchor_day:
    # {'production'|'midpoint'|'integer': {tau: value}}}}.
    rate_attributed_dual_eval_by_edge: Mapping[
        str, Mapping[str, Mapping[str, Mapping[int, float]]],
    ] = field(default_factory=dict)
    # Per-anchor strict observation-support frontier. Populated by
    # `_build_selected_a_clock_evidence_from_runtime` from per-role
    # `ObservedSpanEvidenceCell.landing_coverage > 0`; the test-constructed
    # `from_frames` path leaves this empty and falls back to the legacy
    # `data_retrieved_at` branch in `_observation_frontier`. See
    # docs/current/selected-a-clock-retrieval-frontier-provenance-proposal.md
    # for the "strict support only", "support is per Cohort", and
    # "pair support requires required roles" invariants.
    strict_support_by_anchor: Mapping[str, _SelectedRoleSupport] = field(
        default_factory=dict,
    )

    @staticmethod
    def _anchor_day_key(anchor_day: Any) -> str:
        return (
            anchor_day.isoformat() if hasattr(anchor_day, 'isoformat')
            else str(anchor_day or '')[:10]
        )

    def has_cells(self) -> bool:
        return any(bool(v) for v in self.cells_by_anchor_day.values())

    @classmethod
    def from_frames(
        cls,
        *,
        selected_evidence_frames: Optional[Sequence[Mapping[str, Any]]],
        anchor_from: str,
        anchor_to: str,
        source: str = 'selected_a_clock_frames',
    ) -> 'SelectedAClockEvidence':
        cells: Dict[str, Dict[int, SelectedAClockEvidenceCell]] = defaultdict(dict)
        if not selected_evidence_frames:
            return cls(
                cells_by_anchor_day={},
                anchor_from=str(anchor_from),
                anchor_to=str(anchor_to),
                source=source,
            )
        for frame in selected_evidence_frames:
            snapshot_date = str(frame.get('snapshot_date') or '')[:10]
            if not snapshot_date:
                continue
            try:
                snapshot_d = _date.fromisoformat(snapshot_date)
            except (TypeError, ValueError):
                continue
            for dp in frame.get('data_points') or ():
                anchor_day = str(dp.get('anchor_day') or '')[:10]
                if not _selected_anchor_day(anchor_day, anchor_from, anchor_to):
                    continue
                try:
                    anchor_d = _date.fromisoformat(anchor_day)
                    x_val = float(dp.get('x') or 0.0)
                    y_val = float(dp.get('y') or 0.0)
                except (TypeError, ValueError):
                    continue
                tau = (snapshot_d - anchor_d).days
                if tau < 0:
                    continue
                raw_ret = dp.get('data_retrieved_at')
                ret_str = (
                    str(raw_ret)[:10]
                    if raw_ret is not None and str(raw_ret).strip()
                    else None
                )
                cells[anchor_day][int(tau)] = SelectedAClockEvidenceCell(
                    anchor_day=anchor_day,
                    tau=int(tau),
                    x_at_query_x=x_val,
                    y_at_subject_end=y_val,
                    source=source,
                    data_retrieved_at=ret_str,
                )
        return cls(
            cells_by_anchor_day={k: dict(v) for k, v in cells.items()},
            anchor_from=str(anchor_from),
            anchor_to=str(anchor_to),
            source=source,
        )

    def _cell_at_or_before(
        self,
        tau_values: Mapping[int, SelectedAClockEvidenceCell],
        tau: int,
    ) -> Optional[SelectedAClockEvidenceCell]:
        eligible = [int(t) for t in tau_values.keys() if int(t) <= tau]
        if not eligible:
            return None
        return tau_values[max(eligible)]

    def aggregate_by_tau(
        self,
        *,
        tau_solid_max: Optional[int] = None,
        max_tau: Optional[int] = None,
        n_cohorts_in_scope: Optional[int] = None,
    ) -> Dict[int, Dict[str, float]]:
        """Aggregate per-(anchor, τ) cells into per-τ buckets.

        Per docs/current/cohort-maturity-evidence-coverage-design.md:
        Buckets are emitted whenever any cohort has a forward-filled cell
        at-or-before τ — including covered-with-zero-mass (sum_x = 0)
        which is distinct from "not yet observed" (no cell). The chart
        layer relies on bucket presence as the "observed" signal.

        `n_cohorts_in_scope` is the admissible-cohort denominator for
        the coverage signal (per design §2.2 — the count of cohorts
        whose base mass admits them, **not** `len(cells_by_anchor_day)`
        which excludes cohorts with zero base mass that are nevertheless
        in scope). When omitted, falls back to the count of cohorts with
        any cell — preserves backwards compatibility for tests that
        construct SelectedAClockEvidence directly.
        """
        result: Dict[int, Dict[str, float]] = {}
        all_taus = [
            int(tau)
            for tau_values in self.cells_by_anchor_day.values()
            for tau in tau_values.keys()
        ]
        if not all_taus:
            return result
        tau_max = (
            max(int(max_tau), 0)
            if max_tau is not None
            else max(all_taus)
        )
        boundary_tau = (
            int(tau_solid_max)
            if tau_solid_max is not None and int(tau_solid_max) >= 0
            else None
        )
        # Admissible-cohort denominator for the coverage signal. The
        # caller passes `n_cohorts_in_scope` (count of admissible
        # engine_cohorts post _root_window_carrier_n_by_anchor_day);
        # when absent, fall back to the number of cohorts producing
        # cells. The fallback is safe because aggregate_by_tau is
        # called from one production path (_project_runtime_rows) that
        # supplies the parameter; tests constructing the object
        # directly get a sensible default.
        cohort_denom = (
            int(n_cohorts_in_scope)
            if n_cohorts_in_scope is not None and int(n_cohorts_in_scope) > 0
            else len([k for k, v in self.cells_by_anchor_day.items() if v])
        )

        boundary_x_by_anchor: Dict[str, float] = {}
        if boundary_tau is not None:
            for anchor_day, tau_values in self.cells_by_anchor_day.items():
                boundary_cell = self._cell_at_or_before(tau_values, boundary_tau)
                # Boundary captures the seam value for denominator_pure
                # past tau_solid_max. A boundary cell with x_at_query_x = 0
                # is a legitimate covered-zero-mass observation; record
                # it. The denominator_pure-freezes-past-seam behaviour
                # then runs whenever any anchor reached the seam, even
                # at zero mass.
                if boundary_cell is None:
                    continue
                boundary_x_by_anchor[anchor_day] = float(
                    boundary_cell.x_at_query_x,
                )
            boundary_x = sum(boundary_x_by_anchor.values())
            boundary_n = float(len(boundary_x_by_anchor))
        else:
            boundary_x = 0.0
            boundary_n = 0.0

        for tau in range(tau_max + 1):
            sum_x = 0.0
            sum_y = 0.0
            n_cohorts = 0.0
            sum_carrier_coverage = 0.0
            sum_subject_coverage = 0.0
            for anchor_day, tau_values in self.cells_by_anchor_day.items():
                # Evidence rows are CDF observations: latest cumulative
                # value as-of τ, not the sum of all snapshots up to τ.
                cell = self._cell_at_or_before(tau_values, tau)
                if cell is None:
                    continue
                sum_x += float(cell.x_at_query_x)
                sum_y += float(cell.y_at_subject_end)
                n_cohorts += 1.0
                # Per-role coverage sum (design §2.2): only cells at
                # *exactly* this τ contribute (forward-fill is for value,
                # not for the freshness term `1[exact-τ landing]`). Each
                # role's `landing_coverage` is the cohort's capped
                # placement-share sum from the surface builder — already
                # encodes the carrier backmap fractionation on the subject
                # side per §2.4 property 4. We pass these values through
                # untouched; aggregation across cohorts and division by
                # |admissible| happens below.
                exact_cell = tau_values.get(int(tau))
                if exact_cell is not None:
                    sum_carrier_coverage += float(exact_cell.carrier_landing_coverage)
                    sum_subject_coverage += float(exact_cell.subject_landing_coverage)
            if n_cohorts <= 0:
                # No cohort has yet produced any observation at-or-before
                # τ. Genuinely absent — no bucket.
                continue
            bucket = result.setdefault(
                int(tau),
                {'sum_x': 0.0, 'sum_y': 0.0, 'n_cohorts': 0.0},
            )
            bucket['sum_x'] = sum_x
            bucket['sum_y'] = sum_y
            bucket['n_cohorts'] = n_cohorts
            bucket['sum_carrier_coverage'] = sum_carrier_coverage
            bucket['sum_subject_coverage'] = sum_subject_coverage
            bucket['n_cohorts_in_scope'] = float(cohort_denom)
            if boundary_tau is None:
                continue
            if tau <= boundary_tau:
                bucket['denominator_fe'] = sum_x
                bucket['denominator_pure'] = sum_x
            else:
                # Pure E mode holds the selected-group denominator fixed
                # at the A/B boundary; E+F evidence uses the cumulative
                # selected denominator observed by τ.
                bucket['denominator_fe'] = sum_x
                bucket['denominator_pure'] = boundary_x
                bucket['n_cohorts'] = boundary_n
        return result

    def _observation_frontier(
        self,
        tau_data: Dict[int, 'SelectedAClockEvidenceCell'],
        anchor_day_str: str,
    ) -> int:
        """Derive the true observation frontier from strict support.

        The sweep grid carry-forward creates cells at every τ up to the
        sweep end, but only cells whose underlying retrieval landings are
        real represent observation support. Forward-filled display cells
        are not support and must not extend the frontier (per docs/current/
        selected-a-clock-retrieval-frontier-provenance-proposal.md).

        Preference order:
          1. `strict_support_by_anchor[anchor].paired_tau` when the runtime
             builder has populated it. This is the post-fix authoritative
             path for active-carrier requests built from primitive evidence.
          2. Legacy `data_retrieved_at`-derived τ on the cells themselves —
             used by `SelectedAClockEvidence.from_frames` test paths.
          3. `max(tau)` as a final legacy/malformed-input fallback.
        """
        strict = self.strict_support_by_anchor.get(anchor_day_str)
        if strict is not None and strict.paired_tau is not None:
            return int(strict.paired_tau)
        try:
            anchor_d = _date.fromisoformat(anchor_day_str)
        except (TypeError, ValueError):
            return max(int(t) for t in tau_data.keys())
        max_retrieved_tau: Optional[int] = None
        for cell in tau_data.values():
            if cell.data_retrieved_at is None:
                continue
            try:
                ret_d = _date.fromisoformat(cell.data_retrieved_at)
            except (TypeError, ValueError):
                continue
            ret_tau = (ret_d - anchor_d).days
            if max_retrieved_tau is None or ret_tau > max_retrieved_tau:
                max_retrieved_tau = ret_tau
        if max_retrieved_tau is not None and max_retrieved_tau >= 0:
            return max_retrieved_tau
        return max(int(t) for t in tau_data.keys())

    def prefix_for_anchor_day(
        self,
        anchor_day: Any,
        *,
        horizon: int,
        use_retrieval_frontier: bool = False,
    ) -> Optional[SelectedAClockCohortPrefix]:
        """Return a forward-filled selected prefix without mutating cohorts."""
        ad_str = self._anchor_day_key(anchor_day)
        tau_data = self.cells_by_anchor_day.get(ad_str)
        if not tau_data:
            return None
        T = max(int(horizon), 0) + 1
        obs_x = [0.0] * T
        obs_y = [0.0] * T
        last_x = 0.0
        last_y = 0.0
        if use_retrieval_frontier:
            frontier = self._observation_frontier(tau_data, ad_str)
        else:
            frontier = max(int(t) for t in tau_data.keys())
        for tau in range(T):
            cell = tau_data.get(tau)
            if cell is not None:
                last_x = float(cell.x_at_query_x)
                last_y = float(cell.y_at_subject_end)
            obs_x[tau] = last_x
            obs_y[tau] = last_y
        f_idx = min(max(int(frontier), 0), T - 1)
        return SelectedAClockCohortPrefix(
            anchor_day=ad_str,
            obs_x=obs_x,
            obs_y=obs_y,
            frontier_age=int(frontier),
            x_frozen=float(obs_x[f_idx]),
            y_frozen=float(obs_y[f_idx]),
        )

    def prefixes_for_cohorts(
        self,
        cohort_list: Sequence[Mapping[str, Any]],
        *,
        horizon: int,
        use_retrieval_frontier: bool = False,
    ) -> List[Optional[SelectedAClockCohortPrefix]]:
        prefixes: List[Optional[SelectedAClockCohortPrefix]] = []
        for ci in cohort_list:
            prefixes.append(
                self.prefix_for_anchor_day(
                    ci.get('anchor_day'),
                    horizon=horizon,
                    use_retrieval_frontier=use_retrieval_frontier,
                ),
            )
        return prefixes

    def min_frontier_tau(
        self,
        cohort_list: Optional[Sequence[Mapping[str, Any]]] = None,
        *,
        use_retrieval_frontier: bool = False,
    ) -> Optional[int]:
        def _frontier(ad_str: str, tau_data: Dict[int, 'SelectedAClockEvidenceCell']) -> int:
            if use_retrieval_frontier:
                return self._observation_frontier(tau_data, ad_str)
            return max(int(t) for t in tau_data.keys())

        if cohort_list is not None:
            frontiers: List[int] = []
            for ci in cohort_list:
                ad_str = self._anchor_day_key(ci.get('anchor_day'))
                tau_data = self.cells_by_anchor_day.get(ad_str)
                if tau_data:
                    frontiers.append(_frontier(ad_str, tau_data))
            return min(frontiers) if frontiers else None
        frontiers = [
            _frontier(ad_str, tau_data)
            for ad_str, tau_data in self.cells_by_anchor_day.items()
            if tau_data
        ]
        return min(frontiers) if frontiers else None


@dataclass(frozen=True)
class _SelectedSourceDayMass:
    """M_select(U, C, u): selected-cohort mass at subject primitive
    source nodes per source day, attributed per anchor.

    Per docs/current/cohort-1apr-falling-k-problem-statement.md A.1
    and §10 (no-branch directive). For each subject primitive source
    node U, M_select(U, C=a, u_U) = N_cohort[a] × g_{A→U}[u_U − a],
    where g_{A→U} is the per-day reach-preserving arrival increment
    of the A → U arrival distribution (Σ_τ g_{A→U}[τ] = reach_A→U)
    produced by composing A → U over the union of carrier and
    subject source-layer transitions through the shared timing-span
    composer (the same algebra `prefix_arrival.build_prefix_arrival
    _map` uses for the existing carrier and subject arrival maps).
    Therefore Σ_τ M_select(U, C, τ) = N_cohort × reach_A→U — the
    actual physical selected-cohort mass arriving at U, consistent
    across single-hop and multi-hop subject spans.

    U = X is one element of the iterated source-node set, not a
    separate code path: the composer naturally walks A → X via
    carrier transitions only because subject transitions begin at X
    and so do not reach X from A. Single-hop is the case where the
    only iterated U is X plus the terminal subject destination, both
    produced by the same call site with the same formula. Multi-hop
    is the case where intermediate U nodes are also iterated — the
    construction does not branch on path length.

    Used by the rate-attributed Y prefix per row at (observed_date u,
    retrieved_at r) on edge U → V:

        contribution = M_select(U, C, u) × k(u, r) / n(u, r)
    """

    by_node: Mapping[str, Mapping[str, Mapping[str, float]]]
    endpoint_cdf_by_node: Mapping[str, Tuple[float, ...]]
    n_cohort_by_anchor: Mapping[str, float]
    anchor_days: Tuple[str, ...]
    provenance: Mapping[str, Any] = field(default_factory=dict)

    def mass_at(
        self,
        node_id: str,
        anchor_day: str,
        source_day: str,
    ) -> float:
        return float(
            self.by_node
            .get(str(node_id), {})
            .get(str(anchor_day)[:10], {})
            .get(str(source_day)[:10], 0.0)
        )

    def source_days(
        self,
        node_id: str,
        anchor_day: str,
    ) -> Tuple[str, ...]:
        return tuple(sorted(
            self.by_node
            .get(str(node_id), {})
            .get(str(anchor_day)[:10], {})
            .keys()
        ))

    def has_node(self, node_id: str) -> bool:
        return str(node_id) in self.by_node


@dataclass(frozen=True)
class _SelectedEvidencePropagationLedger:
    """Evidence-local selected mass propagated through observed rate kernels.

    This is distinct from `_SelectedSourceDayMass`: it is a value ledger for
    evidence display, not a source-layer timing object. Downstream subject
    source nodes receive mass only by deterministic push-forward through
    admitted local evidence rates.
    """

    by_node: Mapping[str, Mapping[str, Mapping[str, float]]]
    edge_provenance: Tuple[Mapping[str, Any], ...] = ()

    def mass_at(self, node_id: str, anchor_day: str, source_day: str) -> float:
        return float(
            self.by_node
            .get(str(node_id), {})
            .get(str(anchor_day)[:10], {})
            .get(str(source_day)[:10], 0.0)
        )

    def has_node(self, node_id: str) -> bool:
        return str(node_id) in self.by_node


@dataclass(frozen=True)
class _CarrierOnlyDenominatorPrefix:
    """X_prefix(C, tau) = N_cohort(C) × G_carrier(C, tau).

    Carrier-only denominator prefix per docs/current/cohort-1apr-
    falling-k-problem-statement.md A.1: not rate-attributed; sourced
    from carrier-only primitive-conditioning (composed_carrier.cdf_
    mean) and the observed root-window N_cohort per anchor (via
    _root_window_carrier_n_by_anchor_day). Must not be sourced from
    A_pop, posterior, or the joint A-clock backmap.
    """

    cumulative_by_anchor: Mapping[str, Tuple[float, ...]]
    n_cohort_by_anchor: Mapping[str, float]
    carrier_cdf_mean: Tuple[float, ...]
    provenance: Mapping[str, Any] = field(default_factory=dict)

    def value_at(self, anchor_day: str, tau: int) -> float:
        cdf = self.cumulative_by_anchor.get(str(anchor_day)[:10], ())
        if not cdf:
            return 0.0
        idx = max(0, min(int(tau), len(cdf) - 1))
        return float(cdf[idx])

    def horizon(self, anchor_day: str) -> int:
        cdf = self.cumulative_by_anchor.get(str(anchor_day)[:10], ())
        return max(0, len(cdf) - 1)


@dataclass(frozen=True)
class _RateAttributedSubjectPrefix:
    """Y_prefix(C, tau) — terminal subject primitive's per-source-day
    rate-attributed cumulative count, summed across source days after
    per-source-day carry-forward.

    Built layer-by-layer in subject-chain topology order per docs A.1
    §159: each subject primitive U -> V accumulates per-(C, source_day,
    tau) buckets of (n_weighted, k_weighted) carried forward within
    source_day; the per-cell contribution is M_select(U, C, u) ×
    k_atorbef(u, tau) / n_atorbef(u, tau). The terminal primitive's
    per-(C, tau) cumulative is the chart's Y_prefix.

    Single-hop is the chain-of-length-1 degeneracy: the first primitive
    is also the terminal one. The composition pattern is uniform.
    """

    cumulative_by_anchor: Mapping[str, Mapping[int, float]]
    landing_coverage_by_anchor: Mapping[str, Mapping[int, float]]
    edge_provenance: Tuple[Mapping[str, Any], ...] = ()
    aggregate_provenance: Mapping[str, Any] = field(default_factory=dict)
    # Diagnostic-only side-channel populated when --diag is set. Each
    # entry is a per-edge mapping {edge_id: {anchor_day: {tau: value}}}
    # carrying the alternate evaluation of the rate-attributed cumulative
    # used to triangulate the half-bin compensation point. The tracker
    # `cohort-outside-in-post-73n-regression-tracker.md` documents why.
    diagnostic_dual_eval_by_edge: Mapping[
        str, Mapping[str, Mapping[str, Mapping[int, float]]],
    ] = field(default_factory=dict)

    def value_at(self, anchor_day: str, tau: int) -> float:
        """Y_prefix(C, tau): forward-fill at-or-before tau.

        Y_prefix is a CDF (rate-attributed cumulative count). When a
        carrier-only X cell exists at a tau where Y has no exact
        entry, we want the latest observed Y at-or-before tau so the
        cell carries `(X(tau), Y(<=tau))` rather than `(X(tau), 0)`.
        Returning 0 at non-exact taus would let later carrier cells
        reset Y and reintroduce the falling/non-cumulative behaviour
        the dual-prefix object exists to prevent.
        """
        per_anchor = self.cumulative_by_anchor.get(str(anchor_day)[:10], {})
        if not per_anchor:
            return 0.0
        eligible = [int(t) for t in per_anchor.keys() if int(t) <= int(tau)]
        if not eligible:
            return 0.0
        return float(per_anchor[max(eligible)])

    def coverage_at(self, anchor_day: str, tau: int) -> float:
        """Coverage at exact tau (freshness signal — not forward-filled).

        Coverage marks "did a fresh row land at exactly this tau"; it
        is intentionally NOT forward-filled here. Forward-fill of the
        coverage signal happens at the SelectedAClockEvidence cell
        level via `_cell_at_or_before` so cells past the last fresh
        landing still expose the latest observed coverage.
        """
        return float(
            self.landing_coverage_by_anchor
            .get(str(anchor_day)[:10], {})
            .get(int(tau), 0.0)
        )

    def taus_for_anchor(self, anchor_day: str) -> Tuple[int, ...]:
        return tuple(sorted(
            self.cumulative_by_anchor.get(str(anchor_day)[:10], {}).keys()
        ))


@dataclass(frozen=True)
class SelectedCohortProjection:
    """Per-particle selected-Cohort mass projection on the row clock."""

    rate_draws: np.ndarray
    x_draws: np.ndarray
    y_draws: np.ndarray
    diagnostics: Dict[str, Any]

    @property
    def shape(self):
        """Compatibility for callers that treated this as a draw array."""
        return self.rate_draws.shape

    def __getitem__(self, key):
        """Compatibility for callers that index rate draws directly."""
        return self.rate_draws[key]


@dataclass(frozen=True)
class SelectedCohortProjectionBasis:
    """Reducer input separating observed-count basis from model-rate basis.

    ``model_mass`` is a projection measure, not evidence. When observed
    selected mass exists it matches that mass; when count mass is absent it
    may be a neutral unit so the model-rate algebra can evaluate without
    inventing evidence-named counts.
    """

    anchor_day: str
    has_observed_frontier: bool
    model_mass: float
    model_mass_source: str
    provenance: Mapping[str, Any] = field(default_factory=dict)


def _beta_sd(alpha: float, beta: float) -> float:
    s = alpha + beta
    return math.sqrt(alpha * beta / (s * s * (s + 1.0)))


def build_carrier_superset_candidates_by_edge(
    *,
    graph: Dict[str, Any],
    anchor_node_id: Optional[str],
    query_from_node: Optional[str],
    per_edge_results_by_uuid: Dict[str, Dict[str, Any]],
    anchor_from: str,
    sweep_to: str,
    as_at: Optional[str],
    scenario_id: str,
) -> Dict[str, Tuple[Any, ...]]:
    """Translate fetched superset rows for active carrier primitives."""
    return build_superset_candidates_by_edge(
        graph=graph,
        from_node=anchor_node_id,
        to_node=query_from_node,
        per_edge_results_by_uuid=per_edge_results_by_uuid,
        anchor_from=anchor_from,
        sweep_to=sweep_to,
        as_at=as_at,
        scenario_id=scenario_id,
        is_carrier=True,
    )


def build_superset_candidates_by_edge(
    *,
    graph: Dict[str, Any],
    from_node: Optional[str],
    to_node: Optional[str],
    per_edge_results_by_uuid: Dict[str, Dict[str, Any]],
    anchor_from: str,
    sweep_to: str,
    as_at: Optional[str],
    scenario_id: str,
    is_carrier: bool = False,
) -> Dict[str, Tuple[Any, ...]]:
    """Translate fetched evidence-superset rows into candidates by edge.

    Walks the topology between ``from_node`` and ``to_node`` and for every
    parameterised edge translates rows already returned by the evidence
    superset/envelope interface. This helper performs no evidence fetch,
    no source-family read, no deduplication, and no merge.

    The returned map is keyed by both ``edge_id`` and ``uuid`` so readout
    call sites resolve the entry under either identifier.

    Edges with no supplied superset rows are absent from the map; primitive
    preparation then binds empty candidates and naturally degenerates to
    PRIOR_ONLY.
    """
    from .edge_binding_descriptor import (
        build_candidates_for_descriptor,
        enumerate_per_edge_descriptors,
    )

    descriptors = enumerate_per_edge_descriptors(
        graph=graph,
        from_node=str(from_node) if from_node else '',
        to_node=str(to_node) if to_node else '',
        is_carrier=is_carrier,
        target_edge_uuid=None,
        anchor_from=anchor_from,
        sweep_to=sweep_to,
        as_at=as_at,
        scenario_id=scenario_id,
        anchor_node_id=None,
    )
    if not descriptors:
        return {}

    candidates_by_edge: Dict[str, Tuple[Any, ...]] = {}
    for d in descriptors:
        entry = (
            per_edge_results_by_uuid.get(d.edge_uuid)
            or per_edge_results_by_uuid.get(d.edge_id)
        )
        superset_rows: Optional[List[Dict[str, Any]]] = None
        if entry:
            rows = entry.get('evidence_superset_rows') or []
            if rows:
                superset_rows = list(rows)

        candidates = build_candidates_for_descriptor(
            d,
            superset_rows=superset_rows,
        )
        if not candidates:
            continue
        raw = tuple(candidates)
        candidates_by_edge[d.edge_id] = raw
        candidates_by_edge[d.edge_uuid] = raw
    return candidates_by_edge


def _aggregate_request_candidates(
    *,
    target_candidates: Optional[Sequence[Any]],
    per_edge_subject_candidates: Optional[Dict[str, Sequence[Any]]] = None,
    per_edge_upstream_candidates: Optional[Dict[str, Sequence[Any]]] = None,
) -> List[Any]:
    """Union of every parameterised primitive's candidate material.

    Returns a flat list of ``EvidenceCandidate`` objects spanning the
    target subject, every non-target subject edge, and every carrier
    edge in the request topology. Per-primitive merge in the readout
    filters by ``(subject_from, subject_to)`` so each primitive only
    sees the rows that belong to its own edge.

    The per-edge candidate dicts arrive keyed by both ``edge_id`` and
    ``uuid`` (see ``build_superset_candidates_by_edge``); deduplication
    by object identity prevents the same tuple's rows from contributing
    twice to the pool.
    """
    pool: List[Any] = []
    seen_candidates: set = set()
    seen_sequences: set = set()

    def _candidate_key(candidate: Any) -> tuple:
        return (
            getattr(candidate, 'source', None),
            getattr(candidate, 'identity', None),
            getattr(candidate, 'coordinate', None),
            int(getattr(candidate, 'n', 0) or 0),
            int(getattr(candidate, 'k', 0) or 0),
        )

    def _extend(candidates: Optional[Sequence[Any]]) -> None:
        if not candidates:
            return
        for candidate in candidates:
            if candidate is None:
                continue
            key = _candidate_key(candidate)
            if key in seen_candidates:
                continue
            seen_candidates.add(key)
            pool.append(candidate)

    def _extend_candidate_map(candidate_map: Optional[Dict[str, Sequence[Any]]]) -> None:
        if not candidate_map:
            return
        for candidates in candidate_map.values():
            if candidates is None or id(candidates) in seen_sequences:
                continue
            seen_sequences.add(id(candidates))
            _extend(candidates)

    _extend(target_candidates)

    _extend_candidate_map(per_edge_subject_candidates)
    _extend_candidate_map(per_edge_upstream_candidates)
    return pool


def _attach_cf_row_metadata(
    rows: List[Dict[str, Any]],
    *,
    conditioning: Dict[str, Any],
    conditioned: bool,
    cf_mode: str,
    cf_reason: Optional[str],
    runtime_provenance: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Stash per-call CF metadata on the first row sentinel.

    The runtime provenance block is role-labelled (`carrier_span`,
    `subject_span`, `primitives`, `projection`) so API projection does
    not preserve staged readout labels as public runtime semantics.
    """
    if rows:
        rows[0]['_conditioning'] = conditioning
        rows[0]['_conditioned'] = conditioned
        rows[0]['_cf_mode'] = cf_mode
        rows[0]['_cf_reason'] = cf_reason
        if runtime_provenance is not None:
            rows[0]['_runtime_provenance'] = runtime_provenance
    return rows


@dataclass
class _PrimitiveRuntimeResult:
    p_mean: Optional[float]
    p_sd: Optional[float]
    p_sd_epistemic: Optional[float]
    runtime_provenance: Optional[Dict[str, Any]]


@dataclass
class ResolvedCFRuntime:
    graph: Optional[Mapping[str, Any]]
    population_root: Optional[str]
    denominator_node: Optional[str]
    subject_end: Optional[str]
    public_moments: _PrimitiveRuntimeResult
    runtime_provenance: Optional[Mapping[str, Any]]
    numerator_representation: str = 'factorised'
    admission_policy: Optional[Mapping[str, Any]] = None
    arrival_map: Optional[PrefixArrivalMap] = None
    carrier_arrival_map: Optional[PrefixArrivalMap] = None
    request_evidence_candidates: Optional[Sequence[Any]] = None
    evidence_resolution_registry: Optional[RequestPrimitiveRegistry] = None
    conditioned_primitive_map: Optional[Mapping[str, ConditionedTransitionPrimitive]] = None
    carrier_span: Optional[Mapping[str, Any]] = None
    subject_span: Optional[Mapping[str, Any]] = None
    projection_provenance: Optional[Mapping[str, Any]] = None
    composed_subject: Optional[ComposedPrimitiveSpan] = None
    composed_carrier: Optional[ComposedPrimitiveSpan] = None
    observed_carrier_a_to_x: Optional[ObservedSpanEvidenceSurface] = None
    observed_subject_x_to_end: Optional[ObservedSpanEvidenceSurface] = None
    # Active-cohort dual-prefix object (docs/current/cohort-1apr-falling-
    # k-problem-statement.md A.4 seam invariant). When the active path
    # builder runs, both surfaces (chart row builder, reducer's x_frozen/
    # y_frozen) read these. Absent in window/cohort(A=X) modes.
    selected_x_prefix: Optional['_CarrierOnlyDenominatorPrefix'] = None
    selected_y_prefix: Optional['_RateAttributedSubjectPrefix'] = None
    selected_source_day_mass: Optional['_SelectedSourceDayMass'] = None
    # Union of carrier + subject source-layer transitions, keyed by
    # (source_node, destination_node). Same primitives the carrier/
    # subject arrival maps consume — populated once at runtime build
    # time so the M_select construction can call the shared timing
    # composer rooted at A end-to-end without re-deriving source-layer
    # input from the conditioned posteriors. Per docs/current/cohort-
    # 1apr-falling-k-problem-statement.md A.1 §153: the same resolved
    # carrier/subject-span prefix machinery produces M_select for every
    # primitive source node U.
    source_layer_transitions: Optional[
        Mapping[Tuple[str, str], TimingTransitionPrimitive]
    ] = None
    eligible: bool = True
    skip_reason: Optional[str] = None
    # Unconditioned overlays keyed by dispersion basis (e.g.
    # 'predictive' for F-mode bands, 'epistemic' for the optional
    # model_curve_* bands). Bases not requested by the caller are absent.
    unconditioned_overlays: Mapping[
        str, ComposedUnconditionedOverlay
    ] = field(default_factory=dict)

    def project_public_moments(
        self,
        *,
        p_mean: Optional[float],
        p_sd: Optional[float],
        p_sd_epistemic: Optional[float],
    ) -> tuple[Optional[float], Optional[float], Optional[float]]:
        """Project public scalar moments from the resolved runtime object.

        Projection may use the trajectory values only when the runtime has
        no primitive-backed value for that moment. It must not inspect
        lower-level primitive helper internals.
        """
        return (
            self.public_moments.p_mean
            if self.public_moments.p_mean is not None else p_mean,
            self.public_moments.p_sd
            if self.public_moments.p_sd is not None else p_sd,
            self.public_moments.p_sd_epistemic
            if self.public_moments.p_sd_epistemic is not None
            else p_sd_epistemic,
        )

    def project_runtime_provenance(self) -> Optional[Dict[str, Any]]:
        """Projection-facing provenance for row/scalar consumers.

        Build the public block from the resolved runtime fields. The
        lower-level diagnostic blob remains available under
        ``diagnostics`` for forensics, but projection does not derive
        carrier/subject/projection roles by scraping it.
        """
        registry_provenance = None
        if self.evidence_resolution_registry is not None:
            to_prov = getattr(
                self.evidence_resolution_registry,
                'to_provenance_dict',
                None,
            )
            if callable(to_prov):
                registry_provenance = to_prov()
        projection = dict(self.projection_provenance or {})
        if 'substituted' not in projection:
            projection['substituted'] = self.public_moments.p_mean is not None
        return {
            'carrier_span': self.carrier_span,
            'subject_span': self.subject_span,
            'numerator_representation': self.numerator_representation,
            'admission_policy': self.admission_policy,
            'primitives': {
                'registry': registry_provenance,
                'conditioned_primitive_count': len(
                    self.conditioned_primitive_map or {}
                ),
            },
            'projection': projection,
            'diagnostics': (
                self.runtime_provenance.get('diagnostics')
                if isinstance(self.runtime_provenance, dict)
                else None
            ),
        }


def _runtime_seed(scenario_id: Optional[str], role: str) -> int:
    import hashlib as _hashlib
    return (
        int(_hashlib.sha256(
            (str(scenario_id) + f'|{role}').encode('utf-8')
        ).hexdigest()[:16], 16)
        if scenario_id else 0
    )


def _runtime_scope(
    *,
    scenario_id: str,
    from_node: str,
    to_node: str,
    edge_id: str,
    date_from: str,
    date_to: str,
    as_at: Optional[str],
    resolved_source: Optional[str],
):
    from .primitives import (
        PrimitiveScope as _PrimitiveScope,
        TransitionIdentity as _TransitionIdentity,
    )
    return (
        _TransitionIdentity(
            source_node=str(from_node),
            destination_node=str(to_node),
            edge_id=str(edge_id),
        ),
        _PrimitiveScope(
            scenario_id=str(scenario_id),
            evidence_role='window_subject_helper',
            date_from=str(date_from or ''),
            date_to=str(date_to or date_from or ''),
            as_at=as_at,
            context_key=None,
            regime_key=None,
            model_source_preference='best_available',
            resolved_source_identity=resolved_source,
        ),
    )


def _build_span_resolutions(
    *,
    graph: Dict[str, Any],
    from_node: str,
    to_node: str,
    target_edge_id: str,
    target_resolved: Any,
    temporal_mode: str,
    scenario_id: str,
    anchor_from: str,
    anchor_to: str,
    as_at: Optional[str],
    resolution_class: Any,
    mark_target: bool,
) -> tuple[Optional[list], Optional[str]]:
    from .span_kernel import _build_span_topology

    topo = _build_span_topology(
        graph,
        x_node_id=str(from_node),
        y_node_id=str(to_node),
    )
    if topo is None or not topo.edge_list:
        return None, 'no_span_topology'

    resolutions = []
    for edge_from, edge_to, edge_dict in topo.edge_list:
        edge_id = (
            edge_dict.get('edge_id')
            or edge_dict.get('id')
            or f"{edge_from}->{edge_to}"
        )
        edge_uuid = edge_dict.get('uuid')
        is_target = bool(
            mark_target and (
                str(edge_id) == str(target_edge_id)
                or str(edge_uuid or '') == str(target_edge_id)
            )
        )
        edge_resolved = (
            target_resolved
            if is_target else
            resolve_model_params(
                edge_dict,
                scope='edge',
                temporal_mode=temporal_mode,
            )
        )
        if not edge_resolved:
            return None, f'edge_resolve_failed:{edge_id}'
        emit_edge_id = str(target_edge_id) if is_target else str(edge_id)
        transition, primitive_scope = _runtime_scope(
            scenario_id=scenario_id,
            from_node=str(edge_from),
            to_node=str(edge_to),
            edge_id=emit_edge_id,
            date_from=str(anchor_from or ''),
            date_to=str(anchor_to or anchor_from or ''),
            as_at=as_at,
            resolved_source=getattr(edge_resolved, 'source', None),
        )
        kwargs = dict(
            transition=transition,
            primitive_scope=primitive_scope,
            resolved_model=edge_resolved,
            evidence_set=None,
        )
        if mark_target:
            kwargs['is_target'] = is_target
        resolutions.append(resolution_class(**kwargs))
    return resolutions, None


def build_resolved_cf_runtime(
    *,
    graph: Dict[str, Any],
    target_edge_id: str,
    query_from_node: str,
    query_to_node: str,
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
    as_at: Optional[str],
    scenario_id: Optional[str],
    is_window: bool,
    is_multi_hop: bool,
    anchor_node_id: Optional[str],
    resolved: Any,
    legacy_p_mean: Optional[float],
    legacy_p_sd: Optional[float],
    legacy_p_sd_epistemic: Optional[float],
    unconditioned_overlay_bases: Sequence[str] = ('predictive',),
    evidence_candidates: Optional[List[Any]] = None,
    envelope_plan: Optional[Any] = None,
) -> Optional[ResolvedCFRuntime]:
    """Build the primitive-backed runtime object for row/scalar projection.

    `envelope_plan` carries the per-request `RequestEnvelopePlan` whose
    arrival maps the runtime consumes. In active mode (`A != X`) the
    plan's `carrier_arrival_map` is rooted on the cohort A-anchor range
    (per `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` invariant 5)
    and its `subject_arrival_map` is rooted on the carrier's X-arrival
    days. When a caller does not supply a plan, one is built inline so
    legacy/test entry points still work.

    Note: the `target_subject_metadata` parameter that previously gated
    in-runtime widening was removed when fetch-envelope construction
    moved to the preparation layer. See
    docs/current/snapshot-fetch-envelope-design.md.
    """
    if not scenario_id:
        return None

    from .primitive_readout import (
        CarrierEdgeResolution,
        SpanEdgeResolution,
        _build_request_arrival_map,
        _build_resolved_runtime_prefix_arrival_identity,
        compute_resolved_runtime_readout,
    )

    population_root = (
        str(anchor_node_id)
        if (anchor_node_id and not is_window)
        else str(query_from_node)
    )

    subject_resolutions, subject_skip = _build_span_resolutions(
        graph=graph,
        from_node=str(query_from_node),
        to_node=str(query_to_node),
        target_edge_id=str(target_edge_id),
        target_resolved=resolved,
        temporal_mode='window' if is_window else 'cohort',
        scenario_id=str(scenario_id),
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        as_at=as_at,
        resolution_class=SpanEdgeResolution,
        mark_target=True,
    )

    carrier_resolutions = None
    carrier_skip = None
    if (not is_window) and anchor_node_id and str(anchor_node_id) != str(query_from_node):
        carrier_resolutions, carrier_skip = _build_span_resolutions(
            graph=graph,
            from_node=str(anchor_node_id),
            to_node=str(query_from_node),
            target_edge_id=str(target_edge_id),
            target_resolved=resolved,
            temporal_mode='cohort',
            scenario_id=str(scenario_id),
            anchor_from=anchor_from,
            anchor_to=anchor_to,
            as_at=as_at,
            resolution_class=CarrierEdgeResolution,
            mark_target=False,
        )

    # Two-clocks split (per `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
    # invariant 5): the denominator clock is the carrier `A → X` clock; the
    # numerator clock is the subject-span `X → end` clock. They answer
    # different questions ("who has reached X" vs "given mass at X, when
    # does it reach end"), so they require independent arrival maps rooted
    # on different sets of source days.
    #
    # The carrier map's roots are the cohort A-anchor range; the subject
    # map's roots in active mode are the carrier's X-arrival days. The
    # `RequestEnvelopePlan` already builds both maps with these roots
    # (see `runner.request_envelope.build_request_envelope_plan`); the
    # runtime consumes them rather than rebuilding. When a caller does not
    # pass a plan (legacy/test entry points), one is built inline below.
    #
    # Pre-fix the runtime built its own carrier map with root day support
    # taken from the subject target's primitive scope, which excluded
    # cohort A-anchors that fell before the subject's evidence window —
    # silently dropping early anchors from chart evidence. The envelope
    # path is the canonical construction; consuming it here removes the
    # duplicate map and the divergence.
    subject_arrival_map = None
    carrier_arrival_map = None
    is_active = bool(
        carrier_resolutions
        and not is_window
        and anchor_node_id
        and str(anchor_node_id) != str(query_from_node)
    )

    if is_active:
        # Active cohort: maps come from the request envelope plan whose
        # carrier roots are the cohort A-anchor range and whose subject
        # roots are the carrier's X-arrival days. Build inline if the
        # caller did not supply a plan.
        if envelope_plan is None:
            try:
                from .request_envelope import build_request_envelope_plan
                envelope_plan = build_request_envelope_plan(
                    graph=graph,
                    query_from_node=str(query_from_node),
                    query_to_node=str(query_to_node),
                    anchor_node_id=str(anchor_node_id),
                    anchor_from=_date.fromisoformat(str(anchor_from)[:10]),
                    anchor_to=_date.fromisoformat(str(anchor_to)[:10]),
                    is_window=False,
                    graph_preference=str(
                        getattr(resolved, 'source', None) or 'best_available'
                    ),
                    as_at=as_at,
                    scenario_id=scenario_id,
                )
            except Exception as exc:  # noqa: BLE001
                print(
                    f"[cf_runtime] WARNING: inline envelope plan construction "
                    f"failed ({exc!r}); active cohort will degrade",
                    flush=True,
                )
                envelope_plan = None
        if envelope_plan is not None:
            carrier_arrival_map = getattr(envelope_plan, 'carrier_arrival_map', None)
            subject_arrival_map = getattr(envelope_plan, 'subject_arrival_map', None)
    elif subject_resolutions:
        # Window mode and cohort(A = X): no carrier; subject map is
        # X-rooted identity over the public window. The envelope plan
        # leaves arrival maps unset for window mode (per Appendix A's
        # local-clock binding contract), so build the subject map here.
        target_resolution = next(
            (r for r in subject_resolutions if getattr(r, 'is_target', False)),
            subject_resolutions[0],
        )
        subject_arrival_identity = _build_resolved_runtime_prefix_arrival_identity(
            primitive_scope=target_resolution.primitive_scope,
            request_root=str(query_from_node),
        )
        subject_arrival_map = _build_request_arrival_map(
            graph=graph,
            root_node_id=str(query_from_node),
            primitive_scope_for_window=target_resolution.primitive_scope,
            edge_resolutions=[
                (r.transition, r.resolved_model) for r in subject_resolutions
            ],
            identity=subject_arrival_identity,
            max_tau=400,
        )

    # 73n in-runtime widening REMOVED. The fetch envelope is now derived
    # at the preparation layer by `runner.request_envelope.build_request_
    # envelope_plan` and applied to the original snapshot fetch in
    # `forecast_preparation.prepare_forecast_subject_entry` (subject
    # side) and `_fetch_upstream_observations` (carrier side). The
    # runtime no longer issues a second DB call and no longer needs
    # `target_subject_metadata`. See
    # docs/current/snapshot-fetch-envelope-design.md.

    result = compute_resolved_runtime_readout(
        graph=graph,
        population_root_node_id=population_root,
        x_node_id=str(query_from_node),
        end_node_id=str(query_to_node),
        subject_edge_resolutions=subject_resolutions,
        carrier_edge_resolutions=carrier_resolutions,
        scenario_seed=_runtime_seed(scenario_id, 'resolved_cf_runtime'),
        legacy_p_mean=legacy_p_mean,
        legacy_p_sd=legacy_p_sd,
        legacy_p_sd_epistemic=legacy_p_sd_epistemic,
        prior_source=getattr(resolved, 'source', None),
        unconditioned_overlay_bases=unconditioned_overlay_bases,
        request_evidence_candidates=evidence_candidates,
        prebuilt_subject_arrival_map=subject_arrival_map,
        prebuilt_carrier_arrival_map=carrier_arrival_map,
        is_window=is_window,
    )

    if subject_skip or carrier_skip:
        diagnostics = dict(result.diagnostics or {})
        inner = dict(diagnostics.get('diagnostics') or {})
        if subject_skip:
            inner['subject_resolution_skip'] = subject_skip
        if carrier_skip:
            inner['carrier_resolution_skip'] = carrier_skip
        diagnostics['diagnostics'] = inner
        runtime_provenance = diagnostics
    else:
        runtime_provenance = result.diagnostics

    if not result.should_substitute:
        moments = _PrimitiveRuntimeResult(
            p_mean=None,
            p_sd=None,
            p_sd_epistemic=None,
            runtime_provenance=runtime_provenance,
        )
    else:
        moments = _PrimitiveRuntimeResult(
            p_mean=result.p_mean_primitive,
            p_sd=result.p_sd_primitive,
            p_sd_epistemic=result.p_sd_epistemic_primitive,
            runtime_provenance=runtime_provenance,
        )
    projection_provenance = (
        runtime_provenance.get('projection')
        if isinstance(runtime_provenance, dict)
        else None
    )
    # Union of source-layer transitions over the request's full A->end
    # subgraph. Same `_resolved_to_timing_transition` conversion the
    # subject and carrier arrival maps already use, just collected on
    # the runtime so the M_select construction (which is rooted at A
    # and spans both spans) reuses the same timing input rather than
    # deriving downstream PMFs from per-edge conditioned posteriors.
    # Window mode has no carrier resolutions; `or ()` covers that.
    source_layer_transitions: Dict[
        Tuple[str, str], TimingTransitionPrimitive
    ] = {}
    for resolution in list(carrier_resolutions or ()) + list(subject_resolutions or ()):
        edge_key = (
            str(resolution.transition.source_node),
            str(resolution.transition.destination_node),
        )
        if edge_key in source_layer_transitions:
            continue
        source_layer_transitions[edge_key] = _resolved_to_timing_transition(
            transition=resolution.transition,
            resolved=resolution.resolved_model,
        )

    return ResolvedCFRuntime(
        graph=graph,
        population_root=population_root,
        denominator_node=query_from_node,
        subject_end=query_to_node,
        public_moments=moments,
        runtime_provenance=moments.runtime_provenance,
        numerator_representation='factorised',
        admission_policy={
            'whole_query_numerator': 'not_admitted',
            'subject_side_helper': 'primitive_edge_composition',
            'rate_evidence_owner': 'primitive_conditioning',
        },
        arrival_map=result.arrival_map,
        carrier_arrival_map=carrier_arrival_map,
        request_evidence_candidates=tuple(evidence_candidates or ()),
        evidence_resolution_registry=result.primitive_registry,
        conditioned_primitive_map=dict(result.conditioned_primitive_map),
        carrier_span=result.carrier_span_role,
        subject_span=result.subject_span_role,
        projection_provenance=projection_provenance,
        composed_subject=result.composed_subject,
        composed_carrier=result.composed_carrier,
        eligible=bool(result.eligible and result.should_substitute),
        skip_reason=result.skip_reason,
        unconditioned_overlays=dict(result.unconditioned_overlays),
        source_layer_transitions=source_layer_transitions,
    )


def _evidence_display_at_tau(
    *,
    evidence_by_tau: Dict[int, Dict],
    tau: int,
    tau_future_max: int,
) -> Optional[Dict[str, Any]]:
    """Observed chart evidence at tau from prepared FrameEvidence."""
    if tau > tau_future_max:
        return None
    ev = evidence_by_tau.get(int(tau))
    if not ev:
        return None
    ev_x = float(ev.get('sum_x') or 0.0)
    if ev_x <= 0:
        return None
    ev_y = float(ev.get('sum_y') or 0.0)
    n_cohorts = int(ev.get('n_cohorts') or 0)
    return {
        'sum_y': ev_y,
        'sum_x': ev_x,
        'sum_y_pure': ev_y,
        'sum_x_pure': ev_x,
        'n_cohorts': n_cohorts,
        'n_mature': n_cohorts,
    }


def _composed_pair_request_cdf_draws(
    subject: Optional[ComposedPrimitiveSpan],
    carrier: Optional[ComposedPrimitiveSpan],
    *,
    horizon: int,
) -> Optional[np.ndarray]:
    """Composed request-rooted CDF draws on the (S, horizon+1) grid for a
    given (subject, carrier) composition pair.

    For carrier=identity (None) the result is the subject CDF directly;
    for active cohort the carrier and subject CDFs are convolved per
    draw. Returns ``None`` when either object is moments-only.
    """
    if subject is None or not subject.is_draw_coherent:
        return None
    subject_cdf = subject.cdf_draws
    if subject_cdf is None:
        return None

    T = int(horizon) + 1
    if subject_cdf.shape[1] >= T:
        subj = subject_cdf[:, :T]
    else:
        last = subject_cdf[:, -1:]
        subj = np.concatenate(
            [
                subject_cdf,
                np.broadcast_to(last, (subject_cdf.shape[0], T - subject_cdf.shape[1])),
            ],
            axis=1,
        )

    if carrier is None:
        return subj
    if not carrier.is_draw_coherent or carrier.cdf_draws is None:
        return None
    car = carrier.cdf_draws
    if car.shape[1] >= T:
        car = car[:, :T]
    else:
        last = car[:, -1:]
        car = np.concatenate(
            [
                car,
                np.broadcast_to(last, (car.shape[0], T - car.shape[1])),
            ],
            axis=1,
        )

    if car.shape[0] != subj.shape[0]:
        return None

    carrier_pdf = np.diff(car, axis=1, prepend=0.0)
    subject_pdf = np.diff(subj, axis=1, prepend=0.0)
    convolved = np.zeros_like(subj)
    for s in range(subj.shape[0]):
        full = np.convolve(carrier_pdf[s], subject_pdf[s])[:T]
        convolved[s, :] = np.cumsum(full)
    return np.clip(convolved, 0.0, 1.0)


def _composed_pair_per_tau_rate_draws(
    subject: Optional[ComposedPrimitiveSpan],
    carrier: Optional[ComposedPrimitiveSpan],
    *,
    horizon: int,
) -> Optional[np.ndarray]:
    """Per-(s, t) rate draws for a (subject, carrier) pair.

    Displayed rate is ``Y_Y(τ) / X_X(τ)`` per
    COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS §"Rate semantics":
    numerator is arrivals at the subject end, denominator is arrivals at X.

    Window mode (``carrier=None``): ``rate = subject_cdf · subject_p``;
    carrier_cdf ≡ 1 collapses out.
    Cohort mode: ``rate = (end_to_end_cdf · subject_p) / carrier_cdf``.
    Where carrier_cdf is ~0 the rate is undefined; emit 0 there.

    This is the primitive/span model-curve readout used by F-mode overlays.
    It is not the cohort-maturity E+F trajectory authority; E+F rows use
    ``_selected_cohort_group_rate_draws`` so selected Cohort observed
    prefixes and frontier continuations remain part of the projected object.
    """
    if subject is None or subject.span_p_draws is None:
        return None
    cdf = _composed_pair_request_cdf_draws(subject, carrier, horizon=horizon)
    if cdf is None:
        return None
    numer = cdf * subject.span_p_draws[:, None]
    if carrier is None:
        return numer
    if not carrier.is_draw_coherent or carrier.cdf_draws is None:
        return None
    T = int(horizon) + 1
    car = carrier.cdf_draws
    if car.shape[1] >= T:
        car = car[:, :T]
    else:
        last = car[:, -1:]
        car = np.concatenate(
            [
                car,
                np.broadcast_to(last, (car.shape[0], T - car.shape[1])),
            ],
            axis=1,
        )
    if car.shape[0] != numer.shape[0]:
        return None
    return np.where(car > 1e-9, numer / np.maximum(car, 1e-9), 0.0)


def _runtime_request_cdf_draws(
    runtime: ResolvedCFRuntime,
    *,
    horizon: int,
) -> Optional[np.ndarray]:
    """Convenience: request-rooted CDF for the conditioned posterior."""
    return _composed_pair_request_cdf_draws(
        runtime.composed_subject,
        runtime.composed_carrier,
        horizon=horizon,
    )


def _build_selected_cohort_projection_bases(
    *,
    engine_cohorts: Sequence[Any],
    cohort_list: Sequence[Mapping[str, Any]],
    is_active_carrier: bool,
    a_pop_provenance: Mapping[str, str],
    selected_a_clock_evidence: Optional[SelectedAClockEvidence],
) -> List[SelectedCohortProjectionBasis]:
    """Prepare explicit model-rate bases for the selected-Cohort reducer."""

    selected_prefixes: List[Optional[SelectedAClockCohortPrefix]] = []
    if selected_a_clock_evidence is not None and selected_a_clock_evidence.has_cells():
        selected_prefixes = selected_a_clock_evidence.prefixes_for_cohorts(
            cohort_list,
            horizon=max(
                (len(getattr(ec, 'obs_x', ()) or ()) for ec in engine_cohorts),
                default=1,
            ) - 1,
            use_retrieval_frontier=is_active_carrier,
        )

    bases: List[SelectedCohortProjectionBasis] = []
    for idx, (ec, ci) in enumerate(zip(engine_cohorts, cohort_list)):
        ad = ci.get('anchor_day')
        ad_str = (
            ad.isoformat() if hasattr(ad, 'isoformat') else str(ad or '')[:10]
        )
        selected_prefix = (
            selected_prefixes[idx]
            if idx < len(selected_prefixes)
            else None
        )
        provenance = a_pop_provenance.get(ad_str)

        if is_active_carrier:
            if selected_prefix is not None:
                bases.append(SelectedCohortProjectionBasis(
                    anchor_day=ad_str,
                    has_observed_frontier=True,
                    model_mass=float(getattr(ec, 'a_pop', 0.0) or 0.0),
                    model_mass_source=provenance or 'selected_a_clock_prefix',
                    provenance={'count_basis': provenance or 'selected_a_clock_prefix'},
                ))
                continue

            model_mass = float(getattr(ec, 'a_pop', 0.0) or 0.0)
            source = provenance or 'active_no_selected_prefix'
            if model_mass <= 0.0:
                model_mass = 1.0
                source = 'unit_no_evidence_rate_basis'
            bases.append(SelectedCohortProjectionBasis(
                anchor_day=ad_str,
                has_observed_frontier=False,
                model_mass=model_mass,
                model_mass_source=source,
                provenance={'count_basis': provenance or 'absent'},
            ))
            continue

        frontier = int(getattr(ec, 'frontier_age', 0) or 0)
        if frontier < 0:
            bases.append(SelectedCohortProjectionBasis(
                anchor_day=ad_str,
                has_observed_frontier=False,
                model_mass=1.0,
                model_mass_source='unit_empty_frames_rate_basis',
                provenance={'count_basis': 'absent_empty_frames'},
            ))
        else:
            bases.append(SelectedCohortProjectionBasis(
                anchor_day=ad_str,
                has_observed_frontier=True,
                model_mass=float(getattr(ec, 'x_frozen', 0.0) or 0.0),
                model_mass_source='identity_observed_x',
                provenance={'count_basis': 'identity_observed_x'},
            ))

    return bases


def _root_window_carrier_n_by_anchor_day(
    per_edge_upstream_candidates: Optional[Mapping[str, Any]],
    anchor_node_id: Optional[str],
) -> Dict[str, float]:
    """Per-anchor-day root-window n from the first carrier primitive
    rooted at A.

    Active `cohort(A, X-end)` selected base mass per Phase 3 of
    `docs/current/cohort-maturity-selected-cohort-projection-pattern.md`:
    the only admissible source for `a_pop` per selected A-anchor day is
    the root-window evidence on the first carrier primitive (the edge
    whose from-node is the anchor `A`). Its `n` per anchor day is the
    count that entered A on that day.

    Iterates the per-carrier-edge raw candidate map, picks candidates whose
    primitive subject starts at the anchor, and groups candidate `n` by
    `coordinate.observed_date` taking the maximum.

    Filters candidates by the semantic slice family only — root-window
    evidence — and does not inspect downstream source family. Evidence
    source/deduping complexity is owned by the superset interface.

    Returns an empty dict when the inputs are missing or no edge has a
    from-node matching the anchor; callers must treat empty (or
    missing-keys) as "no admissible base mass" and exclude that cohort
    from active projection rather than fall back to frame-bundle `a`.
    """
    from evidence_merge import SliceFamily

    result: Dict[str, float] = {}
    if not per_edge_upstream_candidates or not anchor_node_id:
        return result
    anchor_str = str(anchor_node_id)
    seen_inputs: set = set()
    for raw_value in per_edge_upstream_candidates.values():
        if raw_value is None or id(raw_value) in seen_inputs:
            continue
        seen_inputs.add(id(raw_value))
        if isinstance(raw_value, (list, tuple)):
            candidates = tuple(raw_value)
        else:
            candidates = ()
        for cand in candidates:
            if cand is None:
                continue
            ident = getattr(cand, 'identity', None)
            if ident is None:
                continue
            if str(getattr(ident, 'subject_from', '')) != anchor_str:
                continue
            if getattr(ident, 'slice_family', None) is not SliceFamily.WINDOW:
                continue
            coord = getattr(cand, 'coordinate', None)
            if coord is None:
                continue
            obs_date = str(getattr(coord, 'observed_date', '') or '')[:10]
            if not obs_date:
                continue
            try:
                n_float = float(getattr(cand, 'n', 0))
            except (TypeError, ValueError):
                continue
            if n_float <= 0:
                continue
            if n_float > result.get(obs_date, 0.0):
                result[obs_date] = n_float
    return result


def _build_selected_source_day_mass(
    *,
    runtime: ResolvedCFRuntime,
    anchor_days: Sequence[str],
    n_cohort_by_anchor: Mapping[str, float],
    subject_primitives: Sequence[ConditionedTransitionPrimitive],
    max_tau: int,
) -> Optional[_SelectedSourceDayMass]:
    """Selected source-day mass surface for every subject primitive
    source node — one uniform construction, no branch on hops.

    For each U in the set of subject primitive source nodes (U = X is
    just one element of that set), compose A → U via the shared
    timing-span composer over the request's union of carrier and
    subject source-layer transitions. Difference the resulting
    DENSITY CDF (reach-preserving) into a PMF and convolve with
    N_cohort per anchor:

        M_select(U, C, u_U) = N_cohort(C) × g_{A→U}[u_U − C]

    where g_{A→U} is the per-day arrival increment of the un-normalised
    A→U arrival distribution (Σ_τ g_{A→U}[τ] = reach_A→U). Therefore
    Σ_τ M_select(U, C, τ) = N_cohort(C) × reach_A→U, the physical
    selected-cohort mass that actually arrives at U — not the within-
    arrival distribution rescaled by N_cohort.

    Single-hop and multi-hop go through the same call site with the
    same formula. U = X is the case where the composer walks A → X
    via carrier transitions only (subject transitions begin at X and
    so do not lie on any A → X path); downstream U is the case where
    the composer walks A → X via carrier and X → U via subject. The
    reach factor differs across U (reach_A→U decays through subject
    edges) — this is the multi-hop scaling required by §A.3 so that
    Y_prefix per edge picks up the hop's reach attenuation.

    The composer is the same algebra `prefix_arrival.build_prefix_
    arrival_map` uses for the existing carrier and subject arrival
    maps — no second timing implementation
    (see `prefix_arrival.py` module docstring), and no chaining of
    post-conditioning posteriors (which would re-apply conditioning
    layer by layer).

    Per docs/current/cohort-1apr-falling-k-problem-statement.md
    §10 (no-branch), §A.1 (same general prefix object), §A.3 line 153
    (g_carrier is the arrival increment, reach-preserving),
    §A.6 phase 1 (runtime-resolved per-primitive surface), I-45, I-46.
    """
    if not n_cohort_by_anchor or not anchor_days:
        return None
    transitions = getattr(runtime, 'source_layer_transitions', None) or {}
    if not transitions:
        return None
    pop_root = runtime.population_root
    if pop_root is None:
        return None

    # The U set: source nodes of subject primitives. U = X is in this
    # set automatically because the first subject primitive's source
    # IS the denominator node X. There is no special-case "X layer":
    # X is one iteration like every other U.
    source_nodes: List[str] = []
    seen_sources: set[str] = set()
    for primitive in subject_primitives or ():
        u = str(getattr(primitive.transition, 'source_node', '') or '')
        if not u or u in seen_sources:
            continue
        seen_sources.add(u)
        source_nodes.append(u)
    if not source_nodes:
        return None

    anchor_keys = tuple(str(d)[:10] for d in anchor_days)
    by_node: Dict[str, Dict[str, Dict[str, float]]] = {}
    endpoint_cdf_by_node: Dict[str, Tuple[float, ...]] = {}
    composed_nodes: List[str] = []
    degraded_nodes: List[str] = []

    transitions_dict = dict(transitions)
    graph_dict = dict(getattr(runtime, 'graph', None) or {})

    for u_node in source_nodes:
        timing = compose_timing_span_from_transition_primitives(
            graph=graph_dict,
            root_node_id=str(pop_root),
            end_node_id=str(u_node),
            transitions=transitions_dict,
            max_tau=int(max_tau),
            horizon_blocking_floor=0.95,
        )
        # Chain-of-length-0 (identity) degeneracy: when root==end the
        # timing composer returns `topology_case='identity'` with
        # `density_cdf=None` — there is no edge chain to compose. The
        # natural-degeneracy reading is a Dirac at offset 0: A→U is
        # instantaneous (A == U), so reach=1 with all mass on the
        # anchor day itself. Synthesise the equivalent CDF
        # `[0.0, 1.0]` so the floor-day PMF below collapses to
        # `[1.0]` (mass=1 at offset 0, zero elsewhere) and M_select
        # at U=anchor_day reduces to N_cohort. Without this branch
        # window mode (and any `cohort(A=X)` query) hits the degraded
        # path and selected_source_day_mass is None.
        if getattr(timing, 'topology_case', None) == 'identity':
            cdf = np.asarray([0.0, 1.0], dtype=np.float64)
        elif not timing.is_composed or timing.density_cdf is None:
            degraded_nodes.append(str(u_node))
            continue
        else:
            cdf = np.asarray(timing.density_cdf, dtype=np.float64)
            if cdf.size == 0:
                degraded_nodes.append(str(u_node))
                continue
        # Density-CDF projected into a floor-day arrival PMF that
        # PRESERVES per-edge reach. Per spec §A.3 line 153, g_carrier
        # is the carrier-only primitive-conditioned arrival increment
        # at X — i.e. an arrival distribution, not a within-arrival
        # distribution. An arrival distribution carries its reach as
        # total mass: Σ_τ pmf[τ] = reach_A→U.
        #
        # Therefore Σ_τ M_select(U, C, τ) = N_cohort(C) × reach_A→U.
        # This is the actual selected-cohort mass present at U, not
        # the within-reach distribution. For U = X (single-hop) the
        # totals are N_cohort × reach_A→X. For U downstream the totals
        # decay through reach_A→X × reach_X→U, which is exactly the
        # right scaling for Y_prefix = Σ M_select(U) × k_UV/n_UV per
        # subject edge — multi-hop K_eff at hop (U, V) becomes
        # `reach_X→U × E[k_UV/n_UV]`, the local rate weighted by the
        # probability of reaching that hop, which is the §A.3 contract.
        #
        # Source-day buckets in snapshot/window rows use floor
        # semantics (`int(arrival_time)`), so source day τ receives
        # arrivals in [τ, τ+1). With trapezoidal endpoint CDFs, the
        # floor-day PMF is cdf[τ+1] - cdf[τ], except day 0, which must
        # include any atom at time 0 and therefore reads cdf[1].
        #
        # X_prefix is an endpoint readout and is built directly from
        # `endpoint_cdf_by_node` below; do not recover it by integrating
        # this floor-day PMF or it will reintroduce a one-day lead.
        if cdf.size <= 1:
            pmf = np.asarray([max(float(cdf[0]), 0.0)], dtype=np.float64)
        else:
            pmf = np.empty(cdf.size - 1, dtype=np.float64)
            pmf[0] = max(float(cdf[1]), 0.0)
            if pmf.size > 1:
                pmf[1:] = np.maximum(cdf[2:] - cdf[1:-1], 0.0)
        if float(pmf.sum()) <= 0.0:
            degraded_nodes.append(str(u_node))
            continue
        endpoint_cdf_by_node[str(u_node)] = tuple(float(v) for v in cdf)

        per_anchor: Dict[str, Dict[str, float]] = {}
        for anchor_key in anchor_keys:
            n_cohort = float(n_cohort_by_anchor.get(anchor_key, 0.0) or 0.0)
            if n_cohort <= 0.0:
                continue
            try:
                anchor_d = _date.fromisoformat(anchor_key)
            except (TypeError, ValueError):
                continue
            per_day: Dict[str, float] = {}
            for tau in range(int(pmf.size)):
                weight = float(pmf[tau])
                if weight <= 0.0:
                    continue
                source_day = (
                    anchor_d + _timedelta(days=int(tau))
                ).isoformat()
                per_day[source_day] = n_cohort * weight
            if per_day:
                per_anchor[anchor_key] = per_day
        if per_anchor:
            by_node[str(u_node)] = per_anchor
            composed_nodes.append(str(u_node))

    if not by_node:
        return None

    return _SelectedSourceDayMass(
        by_node={
            k: {k2: dict(v2) for k2, v2 in v.items()}
            for k, v in by_node.items()
        },
        endpoint_cdf_by_node=dict(endpoint_cdf_by_node),
        n_cohort_by_anchor=dict(n_cohort_by_anchor),
        anchor_days=anchor_keys,
        provenance={
            'source': 'a_rooted_unified_composer.v1',
            'composition': 'compose_timing_span_from_transition_primitives',
            'cdf_basis': 'density_cdf',
            'mass_semantics': 'physical_reach_preserving',
            'population_root': str(pop_root),
            'composed_nodes': tuple(composed_nodes),
            'degraded_nodes': tuple(degraded_nodes),
            'transition_count': int(len(transitions_dict)),
            'no_hop_branch': True,
        },
    )


def _build_carrier_only_denominator_prefix(
    *,
    runtime: ResolvedCFRuntime,
    anchor_days: Sequence[str],
    n_cohort_by_anchor: Mapping[str, float],
    max_tau: int,
) -> Optional[_CarrierOnlyDenominatorPrefix]:
    """X_prefix(C, tau) = N_cohort(C) × G_carrier(C, tau).

    Carrier-only denominator prefix per docs A.1 §157 / A.3. G_carrier
    is the **prior** carrier-only A→X cumulative arrival distribution
    — reach-preserving, so `G_carrier(C, ∞) = reach_A→X` and the
    plateau of `X_prefix` is `N_cohort × reach_A→X`, the actual
    selected-cohort mass that arrives at the denominator node. This
    is the same primitive-evidence-clock composition that produces
    M_select at U = X (density-form, see `_build_selected_source_
    day_mass`). Sourced by integrating M_select(X, C, ·) per anchor
    day so X_prefix and Y_prefix share one carrier reach reference;
    by construction `Y_prefix(C, tau) ≤ X_prefix(C, tau)` because
    rate-attributed Y is `Σ_u M_select(X, C, u) × k/n` with k/n ≤ 1
    and X_prefix is `Σ_{u ≤ tau} M_select(X, C, u)`.

    Per docs A.3 the evidence-line prefix must use the same primitive-
    local arrival support used when conditioning each primitive, NOT
    the joint-conditioned carrier (`composed_carrier`) which would
    re-smooth the evidence with the very posterior it's meant to
    inform. Reading from `runtime.selected_source_day_mass` enforces
    this — M_select is constructed via the prior prefix-arrival
    machinery, and X_prefix is its anchor-cumulative.
    """
    if not n_cohort_by_anchor or not anchor_days:
        return None
    selected_mass = getattr(runtime, 'selected_source_day_mass', None)
    if selected_mass is None:
        return None
    denom_node = runtime.denominator_node
    if denom_node is None:
        return None
    endpoint_cdf = selected_mass.endpoint_cdf_by_node.get(str(denom_node), ())
    if not endpoint_cdf:
        return None

    horizon = max(int(max_tau), 0) + 1

    cumulative_by_anchor: Dict[str, Tuple[float, ...]] = {}
    for anchor_day in anchor_days:
        ad_str = str(anchor_day)[:10]
        n_cohort = float(n_cohort_by_anchor.get(ad_str, 0.0) or 0.0)
        if n_cohort <= 0.0:
            cumulative_by_anchor[ad_str] = tuple(0.0 for _ in range(horizon))
            continue
        try:
            anchor_d = _date.fromisoformat(ad_str)
        except (TypeError, ValueError):
            cumulative_by_anchor[ad_str] = tuple(0.0 for _ in range(horizon))
            continue
        # X_prefix is an endpoint readout: "how many have reached X by
        # age τ?". Keep it on the timing CDF boundary convention. Do not
        # integrate floor-day M_select, which is for subject source-day
        # attribution (`int(arrival_time)`) and is shifted by design.
        cumulative = [0.0] * horizon
        for tau in range(horizon):
            idx = min(int(tau), len(endpoint_cdf) - 1)
            cumulative[tau] = n_cohort * float(endpoint_cdf[idx])
        cumulative_by_anchor[ad_str] = tuple(cumulative)

    # Derive the per-anchor-normalised CDF surface for forensic record.
    # Each entry is `cumulative / N_cohort` — under density-form
    # M_select this plateaus at reach_A→X (≤ 1), giving G_carrier in
    # the §A.4 sense. Clipped to [0, 1] for defensive bounds only.
    representative_cdf: Tuple[float, ...] = ()
    for ad_str, cum in cumulative_by_anchor.items():
        n_cohort = float(n_cohort_by_anchor.get(ad_str, 0.0) or 0.0)
        if n_cohort > 0.0 and cum:
            representative_cdf = tuple(
                min(1.0, max(0.0, float(c) / n_cohort)) for c in cum
            )
            break

    return _CarrierOnlyDenominatorPrefix(
        cumulative_by_anchor=cumulative_by_anchor,
        n_cohort_by_anchor=dict(n_cohort_by_anchor),
        carrier_cdf_mean=representative_cdf,
        provenance={
            'source': 'integrated_m_select_at_denominator_node.v1',
            'horizon': int(horizon),
            'denominator_node': str(denom_node),
        },
    )


def _selected_anchor_day(
    anchor_day: str,
    anchor_from: str,
    anchor_to: str,
) -> bool:
    try:
        ad = _date.fromisoformat(str(anchor_day)[:10])
        af = _date.fromisoformat(str(anchor_from)[:10])
        at = _date.fromisoformat(str(anchor_to)[:10])
    except (TypeError, ValueError):
        return False
    return af <= ad <= at


def _selected_anchor_day_keys(
    cohort_list: Optional[Sequence[Mapping[str, Any]]],
    *,
    anchor_from: str,
    anchor_to: str,
) -> List[str]:
    days: List[str] = []
    seen: set[str] = set()
    for ci in cohort_list or ():
        ad = SelectedAClockEvidence._anchor_day_key(ci.get('anchor_day'))
        if not ad or ad in seen:
            continue
        if not _selected_anchor_day(ad, anchor_from, anchor_to):
            continue
        seen.add(ad)
        days.append(ad)
    if days:
        return days
    try:
        start = _date.fromisoformat(str(anchor_from)[:10])
        end = _date.fromisoformat(str(anchor_to or anchor_from)[:10])
    except (TypeError, ValueError):
        return []
    cur = start
    while cur <= end:
        days.append(cur.isoformat())
        cur = cur + _timedelta(days=1)
    return days


def _runtime_role_edge_ids(
    runtime: ResolvedCFRuntime,
    role: str,
) -> Optional[set[str]]:
    provenance = runtime.runtime_provenance
    if not isinstance(provenance, Mapping):
        return None
    primitives = provenance.get('primitives')
    if not isinstance(primitives, Mapping):
        return None
    if role not in primitives:
        return None
    entries = primitives.get(role) or ()
    edge_ids: set[str] = set()
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        edge_id = entry.get('edge_id')
        if edge_id:
            edge_ids.add(str(edge_id))
    return edge_ids


def _runtime_primitives_for_role(
    runtime: ResolvedCFRuntime,
    role: str,
) -> List[ConditionedTransitionPrimitive]:
    role_edge_ids = _runtime_role_edge_ids(runtime, role)
    all_primitives = list((runtime.conditioned_primitive_map or {}).values())
    if role_edge_ids is None:
        # Older/fallback diagnostics may omit the role-labelled primitive
        # summaries. The caller still filters by semantic endpoint, so
        # returning the request primitive map preserves one runtime ingress
        # without scraping frame shape.
        return all_primitives
    result: List[ConditionedTransitionPrimitive] = []
    for primitive in all_primitives:
        transition = getattr(primitive, 'transition', None)
        edge_id = getattr(transition, 'edge_id', None)
        if edge_id is not None and str(edge_id) in role_edge_ids:
            result.append(primitive)
    return result


def _terminal_primitive_for_destination(
    primitives: Sequence[ConditionedTransitionPrimitive],
    destination_node: Optional[str],
) -> Optional[ConditionedTransitionPrimitive]:
    if destination_node is None:
        return None
    dest = str(destination_node)
    for primitive in primitives:
        transition = getattr(primitive, 'transition', None)
        if str(getattr(transition, 'destination_node', '')) == dest:
            return primitive
    return None


def _row_snapshot_date(row: Any) -> Optional[_date]:
    coord = getattr(row, 'coordinate', None)
    raw = (
        getattr(coord, 'retrieved_at', None)
        if coord is not None else None
    )
    raw = raw or getattr(row, 'retrieved_at', None)
    raw = raw or (
        getattr(coord, 'observed_date', None)
        if coord is not None else None
    )
    raw = raw or getattr(row, 'observed_date', None)
    if not raw:
        return None
    try:
        return _date.fromisoformat(str(raw)[:10])
    except (TypeError, ValueError):
        return None


def _row_observed_date(row: Any) -> Optional[_date]:
    coord = getattr(row, 'coordinate', None)
    raw = (
        getattr(coord, 'observed_date', None)
        if coord is not None else None
    )
    raw = raw or getattr(row, 'observed_date', None)
    if not raw:
        return None
    try:
        return _date.fromisoformat(str(raw)[:10])
    except (TypeError, ValueError):
        return None


def _primitive_weighted_rows(
    primitive: Optional[ConditionedTransitionPrimitive],
) -> Sequence[Any]:
    if primitive is None:
        return ()
    weighted = getattr(primitive, 'weighted_evidence', None)
    return getattr(weighted, 'rows', ()) if weighted is not None else ()


def _row_selected_a_clock_placements(
    *,
    row: Any,
    anchor_days: Sequence[str],
    max_tau: int,
    root_day_to_anchor_weights: Optional[Any] = None,
) -> Tuple[
    List[tuple[str, str, int, float]],
    List[tuple[str, str, int, float]],
    str,
]:
    """Place one primitive-bound row onto selected A-clock cells.

    Per docs/current/cohort-1apr-falling-k-problem-statement.md A.2:
    the placement preserves the primitive source day (`d_obs`) alongside
    the selected anchor and chart tau. Returning the source day here
    keeps the per-source-day axis live through the surface accumulator
    so per-source-day forward-fill can run before superaddition.

    The primary path uses ``WeightedEvidenceRow.root_day_shares``, which
    is produced by ``PrefixArrivalMap`` during primitive binding. Subject
    rows are X-rooted first; ``root_day_to_anchor_weights`` maps those
    X-days back to selected A-days through the carrier map.

    Returns two placement lists with the same tuple shape:
    - mass placements, used to attribute n/k values without double-counting
      an observed row across competing anchors;
    - coverage placements, used to measure whether the source-day support
      required by a selected anchor was observed. Coverage is row-support
      completeness, not conversion mass.
    """
    snapshot_d = _row_snapshot_date(row)
    observed_d = _row_observed_date(row)
    if snapshot_d is None or observed_d is None:
        return [], [], 'missing_row_dates'

    source_day_key = observed_d.isoformat()
    selected_anchor_days = {str(anchor_day)[:10] for anchor_day in anchor_days}
    root_day_shares = getattr(row, 'root_day_shares', None) or {}
    if root_day_shares:
        anchor_weights: Dict[str, float] = {}
        coverage_weights: Dict[str, float] = {}
        for root_day, root_share in root_day_shares.items():
            if root_share <= 0:
                continue
            root_day_key = str(root_day)[:10]
            if root_day_to_anchor_weights is None:
                if root_day_key in selected_anchor_days:
                    anchor_weights[root_day_key] = (
                        anchor_weights.get(root_day_key, 0.0)
                        + float(root_share)
                    )
                    coverage_weights[root_day_key] = (
                        coverage_weights.get(root_day_key, 0.0)
                        + float(root_share)
                    )
                continue
            to_anchor = getattr(
                root_day_to_anchor_weights,
                'root_day_shares_on',
                None,
            )
            to_anchor_coverage = getattr(
                root_day_to_anchor_weights,
                'coverage_root_day_shares_on',
                None,
            )
            if not callable(to_anchor):
                continue
            for anchor_day, anchor_share in to_anchor(root_day_key).items():
                anchor_key = str(anchor_day)[:10]
                if anchor_key not in selected_anchor_days or anchor_share <= 0:
                    continue
                anchor_weights[anchor_key] = (
                    anchor_weights.get(anchor_key, 0.0)
                    + float(root_share) * float(anchor_share)
                )
            if not callable(to_anchor_coverage):
                continue
            for anchor_day, coverage_share in to_anchor_coverage(
                root_day_key,
                snapshot_d.isoformat(),
            ).items():
                anchor_key = str(anchor_day)[:10]
                if anchor_key not in selected_anchor_days or coverage_share <= 0:
                    continue
                coverage_weights[anchor_key] = (
                    coverage_weights.get(anchor_key, 0.0)
                    + float(root_share) * float(coverage_share)
                )
        placements: List[tuple[str, str, int, float]] = []
        for anchor_day, weight in anchor_weights.items():
            if weight <= 0:
                continue
            try:
                anchor_d = _date.fromisoformat(anchor_day)
            except (TypeError, ValueError):
                continue
            tau = (snapshot_d - anchor_d).days
            if 0 <= tau <= max_tau:
                placements.append(
                    (anchor_day, source_day_key, int(tau), float(weight)),
                )
        if placements:
            coverage_placements: List[tuple[str, str, int, float]] = []
            for anchor_day, weight in coverage_weights.items():
                if weight <= 0:
                    continue
                try:
                    anchor_d = _date.fromisoformat(anchor_day)
                except (TypeError, ValueError):
                    continue
                tau = (snapshot_d - anchor_d).days
                if 0 <= tau <= max_tau:
                    coverage_placements.append(
                        (anchor_day, source_day_key, int(tau), float(weight)),
                    )
            decision = (
                'subject_x_day_mapped_via_carrier_prefix_arrival'
                if root_day_to_anchor_weights is not None
                else 'prefix_arrival_root_day_shares'
            )
            return placements, coverage_placements or placements, decision

    return [], [], 'no_prefix_arrival_root_day_shares'


@dataclass(frozen=True)
class _PriorCarrierBackmap:
    """Map X-clock source days back onto selected A-days using the
    **prior** carrier-only A→X composition — the same primitive-
    evidence-clock composition that produces M_select at U = X.

    Per docs §A.3: evidence placement must use "the same primitive-
    local arrival support used when conditioning each primitive" and
    "should not use the joint-conditioned carrier or subject
    particles to re-place the same evidence after conditioning."
    Sourced from `runtime.selected_source_day_mass` so X_prefix,
    Y_prefix and the placement backmap all share one carrier
    reference.
    """

    anchor_days: Tuple[str, ...]
    carrier_pmf_by_anchor: Mapping[str, Tuple[float, ...]]

    def root_day_shares_on(self, x_day: str) -> Dict[str, float]:
        try:
            x_d = _date.fromisoformat(str(x_day)[:10])
        except (TypeError, ValueError):
            return {}
        weights: Dict[str, float] = {}
        for anchor_day in self.anchor_days:
            try:
                anchor_d = _date.fromisoformat(str(anchor_day)[:10])
            except (TypeError, ValueError):
                continue
            tau = (x_d - anchor_d).days
            if tau < 0:
                continue
            pmf = self.carrier_pmf_by_anchor.get(str(anchor_day)[:10], ())
            if not pmf or tau >= len(pmf):
                continue
            weight = float(pmf[tau])
            if weight > 0.0:
                weights[str(anchor_day)[:10]] = weight

        total = float(sum(weights.values()))
        if total <= 0.0:
            return {}
        return {day: weight / total for day, weight in weights.items()}

    def coverage_root_day_shares_on(
        self,
        x_day: str,
        snapshot_day: str,
    ) -> Dict[str, float]:
        """Anchor-conditioned source-support share for coverage.

        ``root_day_shares_on`` answers a mass-attribution question: for one
        observed X-day row, split the row across all plausible A anchors so
        counts are not duplicated. Coverage asks the transpose question:
        for each selected A anchor at a snapshot age, what fraction of that
        anchor's possible X-source-day support has a row? The denominator is
        therefore the anchor's own support up to the snapshot date, not the
        cross-anchor total for this X-day.
        """
        try:
            x_d = _date.fromisoformat(str(x_day)[:10])
            snapshot_d = _date.fromisoformat(str(snapshot_day)[:10])
        except (TypeError, ValueError):
            return {}

        result: Dict[str, float] = {}
        for anchor_day in self.anchor_days:
            anchor_key = str(anchor_day)[:10]
            try:
                anchor_d = _date.fromisoformat(anchor_key)
            except (TypeError, ValueError):
                continue
            source_offset = (x_d - anchor_d).days
            snapshot_offset = (snapshot_d - anchor_d).days
            if source_offset < 0 or snapshot_offset < 0:
                continue
            pmf = self.carrier_pmf_by_anchor.get(anchor_key, ())
            if not pmf or source_offset >= len(pmf):
                continue
            support_horizon = min(int(snapshot_offset), len(pmf) - 1)
            support_total = float(
                sum(max(float(pmf[i]), 0.0) for i in range(support_horizon + 1))
            )
            if support_total <= 0.0:
                continue
            weight = max(float(pmf[source_offset]), 0.0)
            if weight > 0.0:
                result[anchor_key] = weight / support_total
        return result


def _join_conditioned_carrier_backmap(
    *,
    runtime: ResolvedCFRuntime,
    anchor_days: Sequence[str],
) -> Optional[_PriorCarrierBackmap]:
    """Build the placement backmap from the runtime's prior M_select(X).

    M_select(X, C, u) is `N_cohort(C) × g_carrier_density[u − C]`, so
    dividing by N_cohort recovers the prior carrier per-day arrival
    increment per anchor. Under density-form mass each per-anchor pmf
    sums to `reach_A→X` (not 1) — but `root_day_shares_on` normalises
    cross-anchor by `sum(weights)`, so a global reach rescale cancels
    out and the produced anchor shares are unchanged. Anchors with
    N_cohort = 0 contribute no placement mass — handled by skipping
    them in the per-anchor map.
    """
    selected_mass = getattr(runtime, 'selected_source_day_mass', None)
    if selected_mass is None:
        return None
    denom_node = runtime.denominator_node
    if denom_node is None:
        return None
    by_anchor_at_x = selected_mass.by_node.get(str(denom_node))
    if not by_anchor_at_x:
        return None
    anchors = tuple(str(day)[:10] for day in anchor_days if str(day)[:10])
    if not anchors:
        return None

    carrier_pmf_by_anchor: Dict[str, Tuple[float, ...]] = {}
    for anchor_day in anchors:
        per_day = by_anchor_at_x.get(anchor_day)
        if not per_day:
            continue
        n_cohort = float(
            (selected_mass.n_cohort_by_anchor or {}).get(anchor_day, 0.0)
            or 0.0
        )
        if n_cohort <= 0.0:
            continue
        try:
            anchor_d = _date.fromisoformat(anchor_day)
        except (TypeError, ValueError):
            continue
        # Convert per-day mass to a tau-indexed prior PMF for this
        # anchor by stretching from anchor_d to the latest source day
        # observed for the anchor.
        try:
            max_offset = max(
                (_date.fromisoformat(d) - anchor_d).days
                for d in per_day.keys()
            )
        except (TypeError, ValueError):
            continue
        pmf = [0.0] * (int(max_offset) + 1)
        for d, mass in per_day.items():
            try:
                offset = (_date.fromisoformat(d) - anchor_d).days
            except (TypeError, ValueError):
                continue
            if 0 <= offset < len(pmf):
                pmf[offset] = float(mass) / n_cohort
        carrier_pmf_by_anchor[anchor_day] = tuple(pmf)

    if not carrier_pmf_by_anchor:
        return None
    return _PriorCarrierBackmap(
        anchor_days=anchors,
        carrier_pmf_by_anchor=carrier_pmf_by_anchor,
    )


def _role_topology_edges(
    *,
    graph: Optional[Mapping[str, Any]],
    root_node: str,
    end_node: str,
    primitives: Sequence[ConditionedTransitionPrimitive],
) -> Tuple[Tuple[str, str, str], ...]:
    if graph is not None:
        try:
            from .span_kernel import _build_span_topology

            topo = _build_span_topology(
                dict(graph),
                x_node_id=str(root_node),
                y_node_id=str(end_node),
            )
        except Exception:
            topo = None
        if topo is not None and getattr(topo, 'edge_list', None):
            edges: List[Tuple[str, str, str]] = []
            for from_id, to_id, edge_dict in topo.edge_list:
                edge_id = (
                    edge_dict.get('edge_id')
                    or edge_dict.get('id')
                    or edge_dict.get('uuid')
                    or f'{from_id}->{to_id}'
                )
                edges.append((str(from_id), str(to_id), str(edge_id)))
            if edges:
                return tuple(edges)

    # Unit-test and degraded-diagnostic fallback: preserve primitive order
    # when the runtime-like object does not expose the request graph.
    return tuple(
        (
            str(primitive.transition.source_node),
            str(primitive.transition.destination_node),
            str(primitive.transition.edge_id),
        )
        for primitive in primitives
    )


def _max_flow_for_observed_span(
    *,
    root_node: str,
    end_node: str,
    topology_edges: Sequence[Tuple[str, str, str]],
    edge_capacities: Mapping[str, float],
) -> float:
    """Compose observed edge capacities through the span topology."""
    if str(root_node) == str(end_node):
        return 0.0

    adjacency: Dict[str, List[str]] = defaultdict(list)
    residual: Dict[Tuple[str, str], float] = defaultdict(float)
    for from_id, to_id, edge_id in topology_edges:
        cap = float(edge_capacities.get(edge_id, 0.0) or 0.0)
        if cap <= 0.0:
            continue
        residual[(from_id, to_id)] += cap
        residual[(to_id, from_id)] += 0.0
        if to_id not in adjacency[from_id]:
            adjacency[from_id].append(to_id)
        if from_id not in adjacency[to_id]:
            adjacency[to_id].append(from_id)

    flow = 0.0
    source = str(root_node)
    sink = str(end_node)
    while True:
        parent: Dict[str, Optional[str]] = {source: None}
        queue: List[str] = [source]
        for node in queue:
            if node == sink:
                break
            for nxt in adjacency.get(node, ()):
                if nxt in parent or residual[(node, nxt)] <= 1e-12:
                    continue
                parent[nxt] = node
                queue.append(nxt)
        if sink not in parent:
            break
        path_cap = math.inf
        cur = sink
        while parent[cur] is not None:
            prev = parent[cur]
            path_cap = min(path_cap, residual[(prev, cur)])
            cur = prev
        if not math.isfinite(path_cap) or path_cap <= 0.0:
            break
        cur = sink
        while parent[cur] is not None:
            prev = parent[cur]
            residual[(prev, cur)] -= path_cap
            residual[(cur, prev)] += path_cap
            cur = prev
        flow += float(path_cap)
    return float(flow)


@dataclass(frozen=True)
class _SubjectChainEvidenceBuckets:
    """Per-(edge, anchor, source_day, tau) (n_weighted, k_weighted)
    accumulator returned alongside ``ObservedSpanEvidenceSurface``.

    Per docs/current/cohort-1apr-falling-k-problem-statement.md A.6
    phase 2: the source-day axis must be preserved through to the
    rate-attributed composer. This dataclass holds the per-source-day
    buckets explicitly, returned as part of the surface builder's
    contract — there are no hidden setattr overrides on the public
    surface object.
    """

    edge_nk_by_source_day: Mapping[
        str,
        Mapping[str, Mapping[str, Mapping[int, Tuple[float, float]]]],
    ]
    edge_nk_by_local_source_day: Mapping[
        str,
        Mapping[str, Mapping[int, Tuple[float, float]]],
    ]
    topology_edges: Tuple[Tuple[str, str, str], ...]


def _build_observed_span_evidence_surface(
    *,
    runtime: ResolvedCFRuntime,
    role: str,
    root_node: str,
    end_node: str,
    primitives: Sequence[ConditionedTransitionPrimitive],
    anchor_days: Sequence[str],
    max_tau: int,
    root_day_to_anchor_weights: Optional[Any] = None,
    emit_diagnostics: bool = False,
) -> Tuple[
    Optional[ObservedSpanEvidenceSurface],
    Optional['_SubjectChainEvidenceBuckets'],
]:
    """Build a primitive-bound, topology-composed observed span surface
    used for COVERAGE only (chain freshness signal).

    Per docs/current/cohort-1apr-falling-k-problem-statement.md A.1
    §157: amplitude is no longer carried on this surface in the active
    cohort path. X amplitude comes from `_CarrierOnlyDenominatorPrefix`
    (carrier-only N_cohort × G_carrier). Y amplitude comes from
    `_RateAttributedSubjectPrefix` (per-source-day rate-attributed
    composition). This surface continues to expose `observed_count`
    as the topology max-flow of forward-filled per-edge capacities so
    diagnostic and legacy consumers can still read it; the active
    cohort cell builder ignores it.

    Source-day axis: per A.2 §174, placement returns the source day
    alongside (anchor, tau, share). The surface preserves the source-
    day axis on `edge_share_source_day_surfaces` for downstream
    consumers (e.g. rate-attributed composer); the count side
    `observed_count` retains forward-fill across (edge, anchor, tau)
    only because the chain max-flow is a coverage-style chain check.
    """
    if not primitives:
        return None, None

    topology_edges = _role_topology_edges(
        graph=getattr(runtime, 'graph', None),
        root_node=root_node,
        end_node=end_node,
        primitives=primitives,
    )
    if not topology_edges:
        return None, None

    topology_edge_ids = tuple(edge_id for _u, _v, edge_id in topology_edges)
    primitive_by_edge_id = {
        str(getattr(primitive.transition, 'edge_id', '')): primitive
        for primitive in primitives
    }
    primitive_by_nodes = {
        (
            str(getattr(primitive.transition, 'source_node', '')),
            str(getattr(primitive.transition, 'destination_node', '')),
        ): primitive
        for primitive in primitives
    }
    edge_by_nodes = {
        (str(u), str(v)): str(edge_id)
        for u, v, edge_id in topology_edges
    }
    # Per-(edge, anchor, source_day, tau) accumulator for n_weighted /
    # k_weighted. Per docs A.6 phase 2 / 3: the source-day axis is
    # preserved through to the consumer so per-source-day forward-fill
    # is possible without having collapsed it prematurely.
    edge_nk_surfaces: Dict[
        str,
        Dict[str, Dict[str, Dict[int, Tuple[float, float]]]],
    ] = {}
    # Per-edge local-clock rows independent of selected anchor placement.
    # Used to build age-only downstream window kernels: selected downstream
    # mass is synthetic, so it must not require same-anchor row identity.
    edge_local_nk_surfaces: Dict[
        str,
        Dict[str, Dict[int, Tuple[float, float]]],
    ] = {}
    candidate_backed_local_edges: set[str] = set()
    edge_surfaces: Dict[str, Dict[str, Dict[int, float]]] = {}
    # Parallel share-only accumulator: tracks raw placement-share sum per
    # (edge_id, anchor_day, exact-τ) without multiplying by `value`. Drives
    # the per-cell `landing_coverage` signal — covered-with-zero-mass rows
    # (k_weighted = 0) still contribute their share here, distinguishing
    # "observed but zero" from "not observed" (design §3.1).
    edge_share_surfaces: Dict[str, Dict[str, Dict[int, float]]] = {}
    # Per-row lineage is forensic-only and large enough to overflow V8's max
    # string length on multi-hop active queries. Built only when --diag is on.
    placement_lineage: Optional[List[Mapping[str, Any]]] = (
        [] if emit_diagnostics else None
    )
    raw_row_count = 0
    placed_count = 0
    off_clock_count = 0

    try:
        from evidence_merge import SliceFamily
    except Exception:
        SliceFamily = None  # type: ignore

    # Build local-clock raw rate surfaces from the request candidate pool
    # before primitive arrival-weighting. This supplies downstream window
    # kernels on their own local clock; selected downstream source mass is
    # synthetic, so the value kernel must not be narrowed to the selected
    # upstream anchor days by placement.
    for candidate in getattr(runtime, 'request_evidence_candidates', None) or ():
        ident = getattr(candidate, 'identity', None)
        coord = getattr(candidate, 'coordinate', None)
        if ident is None or coord is None:
            continue
        if SliceFamily is not None and getattr(ident, 'slice_family', None) is not SliceFamily.WINDOW:
            continue
        edge_id = edge_by_nodes.get((
            str(getattr(ident, 'subject_from', '') or ''),
            str(getattr(ident, 'subject_to', '') or ''),
        ))
        if not edge_id:
            continue
        observed_day = str(getattr(coord, 'observed_date', '') or '')[:10]
        retrieved_raw = getattr(coord, 'retrieved_at', None)
        retrieved_day = (
            str(retrieved_raw)[:10] if retrieved_raw is not None
            and str(retrieved_raw).strip() else ''
        )
        if not observed_day or not retrieved_day:
            continue
        try:
            age = (
                _date.fromisoformat(retrieved_day)
                - _date.fromisoformat(observed_day)
            ).days
            n_raw = float(getattr(candidate, 'n', 0) or 0.0)
            k_raw = float(getattr(candidate, 'k', 0) or 0.0)
        except (TypeError, ValueError):
            continue
        if age < 0 or age > int(max_tau) or n_raw <= 0.0:
            continue
        by_edge = edge_local_nk_surfaces.setdefault(edge_id, {})
        by_tau = by_edge.setdefault(observed_day, {})
        prev_n, prev_k = by_tau.get(int(age), (0.0, 0.0))
        by_tau[int(age)] = (prev_n + n_raw, prev_k + k_raw)
        candidate_backed_local_edges.add(edge_id)

    def _primitive_binding_summary(
        primitive: Optional[ConditionedTransitionPrimitive],
    ) -> Optional[Mapping[str, Any]]:
        if primitive is None:
            return None
        try:
            prov = primitive.to_provenance_dict()
        except Exception:
            return None
        weighted = dict(prov.get('weighted_evidence') or {})
        return {
            'transition': dict(prov.get('transition') or {}),
            'scope': dict(prov.get('scope') or {}),
            'status': prov.get('status'),
            'raw_evidence_scope_key': prov.get('raw_evidence_scope_key'),
            'effective_evidence_totals': prov.get('effective_evidence_totals'),
            'weighted_evidence': {
                'binding_policy': weighted.get('binding_policy'),
                'evidence_scope_key': weighted.get('evidence_scope_key'),
                'evidence_scope_date_from': weighted.get('evidence_scope_date_from'),
                'evidence_scope_date_to': weighted.get('evidence_scope_date_to'),
                'row_count': weighted.get('row_count'),
                'arrival_weight_summary': weighted.get('arrival_weight_summary'),
                'skipped_counts_by_reason': weighted.get('skipped_counts_by_reason'),
            },
        }

    for from_id, to_id, edge_id in topology_edges:
        primitive = (
            primitive_by_edge_id.get(edge_id)
            or primitive_by_nodes.get((from_id, to_id))
        )
        rows = _primitive_weighted_rows(primitive)
        raw_row_count += len(rows)
        for row in rows:
            try:
                value = float(getattr(row, 'k_weighted', 0.0) or 0.0)
                n_value = float(getattr(row, 'n_weighted', 0.0) or 0.0)
                raw_k_value = float(getattr(row, 'k', 0.0) or 0.0)
                raw_n_value = float(getattr(row, 'n', 0.0) or 0.0)
            except (TypeError, ValueError):
                off_clock_count += 1
                continue
            observed_day = str(getattr(row, 'observed_date', '') or '')[:10]
            retrieved_raw = getattr(row, 'retrieved_at', None)
            retrieved_day = (
                str(retrieved_raw)[:10] if retrieved_raw is not None
                and str(retrieved_raw).strip() else ''
            )
            if observed_day and retrieved_day and edge_id not in candidate_backed_local_edges:
                try:
                    age = (
                        _date.fromisoformat(retrieved_day)
                        - _date.fromisoformat(observed_day)
                    ).days
                except (TypeError, ValueError):
                    age = -1
                if age >= 0 and age <= int(max_tau):
                    by_edge = edge_local_nk_surfaces.setdefault(edge_id, {})
                    by_tau = by_edge.setdefault(observed_day, {})
                    prev_n, prev_k = by_tau.get(int(age), (0.0, 0.0))
                    by_tau[int(age)] = (
                        prev_n + raw_n_value,
                        prev_k + raw_k_value,
                    )
            (
                placements,
                coverage_placements,
                clock_decision,
            ) = _row_selected_a_clock_placements(
                row=row,
                anchor_days=anchor_days,
                max_tau=max_tau,
                root_day_to_anchor_weights=root_day_to_anchor_weights,
            )
            if placement_lineage is not None:
                placement_lineage.append({
                    'edge_id': edge_id,
                    'observed_date': getattr(row, 'observed_date', None),
                    'retrieved_at': getattr(row, 'retrieved_at', None),
                    'raw_n': int(getattr(row, 'n', 0) or 0),
                    'raw_k': int(getattr(row, 'k', 0) or 0),
                    'arrival_weight': float(getattr(row, 'arrival_weight', 0.0) or 0.0),
                    'n_weighted': n_value,
                    'k_weighted': value,
                    'root_day_shares': dict(getattr(row, 'root_day_shares', None) or {}),
                    'clock_decision': clock_decision,
                    'placements': [
                        {
                            'anchor_day': anchor_day,
                            'source_day': source_day,
                            'tau': int(tau),
                            'share': float(share),
                        }
                        for anchor_day, source_day, tau, share in placements
                    ],
                    'coverage_placements': [
                        {
                            'anchor_day': anchor_day,
                            'source_day': source_day,
                            'tau': int(tau),
                            'share': float(share),
                        }
                        for anchor_day, source_day, tau, share in coverage_placements
                    ],
                })
            if not placements:
                off_clock_count += 1
                continue
            # NB: do NOT skip on `value <= 0`. Covered-with-zero-mass rows
            # (k_weighted = 0 — snapshot taken, no conversions yet) must
            # still contribute placement shares so the cell-emit gate sees
            # them as observed and the landing_coverage signal records
            # them. Design §3.1 three-state contract.
            for anchor_day, source_day, tau, share in placements:
                tau_int = int(tau)
                # Legacy per-(edge, anchor, tau) accumulator (k-only).
                # Retained for the `observed_count` chain-coverage
                # max-flow that diagnostics and legacy consumers still
                # read. Active cell amplitude bypasses this path.
                by_anchor = edge_surfaces.setdefault(edge_id, {})
                by_tau = by_anchor.setdefault(anchor_day, {})
                by_tau[tau_int] = by_tau.get(tau_int, 0.0) + value * share
                # Per-(edge, anchor, source_day, tau) (n_weighted,
                # k_weighted) accumulator. The source-day axis is
                # preserved here per docs A.2 §174 so phase-3 rate-
                # attributed composition can forward-fill per source
                # day before summing across source days.
                nk_by_anchor = edge_nk_surfaces.setdefault(edge_id, {})
                nk_by_source = nk_by_anchor.setdefault(anchor_day, {})
                nk_by_tau = nk_by_source.setdefault(source_day, {})
                prev_n, prev_k = nk_by_tau.get(tau_int, (0.0, 0.0))
                nk_by_tau[tau_int] = (
                    prev_n + n_value * float(share),
                    prev_k + value * float(share),
                )
                placed_count += 1
            for anchor_day, _source_day, tau, share in coverage_placements:
                tau_int = int(tau)
                share_by_anchor = edge_share_surfaces.setdefault(edge_id, {})
                share_by_tau = share_by_anchor.setdefault(anchor_day, {})
                share_by_tau[tau_int] = (
                    share_by_tau.get(tau_int, 0.0) + float(share)
                )

    cells: Dict[str, Dict[int, ObservedSpanEvidenceCell]] = defaultdict(dict)
    emitted_count = 0
    incomplete_count = 0
    anchors = sorted({
        anchor
        for surface in edge_surfaces.values()
        for anchor in surface.keys()
    })
    for anchor_day in anchors:
        tau_union = sorted({
            int(tau)
            for surface in edge_surfaces.values()
            for tau in surface.get(anchor_day, {}).keys()
        })
        for tau in tau_union:
            capacities: Dict[str, float] = {}
            chain_covered = True
            for edge_id in topology_edge_ids:
                value = _latest_value_at_or_before(
                    edge_surfaces.get(edge_id, {}).get(anchor_day, {}),
                    int(tau),
                )
                if value is None:
                    # No row at-or-before τ for this edge — chain is
                    # not yet observed for this (anchor_day, τ). Distinct
                    # from "observed value of zero" (value = 0.0).
                    chain_covered = False
                    break
                capacities[edge_id] = float(value)
            if not chain_covered:
                incomplete_count += 1
                continue
            count = _max_flow_for_observed_span(
                root_node=root_node,
                end_node=end_node,
                topology_edges=topology_edges,
                edge_capacities=capacities,
            )
            # Per-cell landing_coverage: sum across all edges' shares
            # at exactly this τ for this anchor, capped at 1. Per design
            # §2.2 "Σ_row share_row × 1[exact-τ landing for cohort]" —
            # the row sum aggregates across primitives (so across edges
            # in a multi-hop chain). "Any edge refreshed = chain observed
            # at this τ", which is what the chart's freshness signal
            # should communicate. Single-edge: degenerate to that edge's
            # capped share. Forward-fill is for value, not coverage —
            # cells past the last fresh row across all edges have
            # landing_coverage = 0.
            total_share = 0.0
            for edge_id in topology_edge_ids:
                total_share += float(
                    edge_share_surfaces.get(edge_id, {})
                    .get(anchor_day, {})
                    .get(int(tau), 0.0)
                )
            landing_coverage = min(1.0, total_share)
            cells[anchor_day][int(tau)] = ObservedSpanEvidenceCell(
                anchor_day=anchor_day,
                tau=int(tau),
                observed_count=float(count),
                edge_capacities=dict(capacities),
                landing_coverage=landing_coverage,
                provenance={
                    'composition': 'observed_span_topology_max_flow.v1',
                    'role': role,
                    'root_node': str(root_node),
                    'end_node': str(end_node),
                    'selected_a_clock_placement': {
                        'anchor_day': anchor_day,
                        'tau': int(tau),
                    },
                },
            )
            emitted_count += 1

    print(
        f"[evi_diag] surface role={role} edges={len(topology_edges)} "
        f"raw_rows={raw_row_count} placed={placed_count} off_clock={off_clock_count} "
        f"cells_emitted={emitted_count} chain_incomplete={incomplete_count} "
        f"anchors={len(anchors)}",
        flush=True,
    )
    surface = ObservedSpanEvidenceSurface(
        role=role,
        root_node=str(root_node),
        end_node=str(end_node),
        cells_by_anchor_day={k: dict(v) for k, v in cells.items()},
        edge_ids=topology_edge_ids,
        provenance={
            'composition': 'observed_span_topology_max_flow.v1',
            'primitive_source': 'ConditionedTransitionPrimitive.weighted_evidence',
            'clock_authority': 'PrefixArrivalMap.root_day_shares',
            'topology_edges': [
                {'from': u, 'to': v, 'edge_id': edge_id}
                for u, v, edge_id in topology_edges
            ],
            'primitive_bindings': [
                summary for summary in (
                    _primitive_binding_summary(primitive)
                    for primitive in primitives
                )
                if summary is not None
            ],
            'raw_row_count': int(raw_row_count),
            'placed_count': int(placed_count),
            'off_clock_count': int(off_clock_count),
            'emitted_count': int(emitted_count),
            'incomplete_count': int(incomplete_count),
            **(
                {'row_lineage': placement_lineage}
                if placement_lineage is not None else {}
            ),
        },
    )
    buckets = _SubjectChainEvidenceBuckets(
        edge_nk_by_source_day={
            edge_id: {
                anchor_day: {
                    source_day: dict(by_tau)
                    for source_day, by_tau in by_source.items()
                }
                for anchor_day, by_source in by_anchor.items()
            }
            for edge_id, by_anchor in edge_nk_surfaces.items()
        },
        edge_nk_by_local_source_day={
            edge_id: {
                source_day: dict(by_tau)
                for source_day, by_tau in by_source.items()
            }
            for edge_id, by_source in edge_local_nk_surfaces.items()
        },
        topology_edges=tuple(topology_edges),
    )
    return surface, buckets


def _latest_value_at_or_before(
    values_by_tau: Mapping[int, float],
    tau: int,
) -> Optional[float]:
    eligible = [int(t) for t in values_by_tau.keys() if int(t) <= int(tau)]
    if not eligible:
        return None
    return float(values_by_tau[max(eligible)] or 0.0)


def _latest_nk_at_or_before(
    nk_by_tau: Mapping[int, Tuple[float, float]],
    tau: int,
) -> Optional[Tuple[float, float]]:
    """Return latest (n_atorbef, k_atorbef) at tau' ≤ tau within one source day.

    Per docs A.1: forward-fill is per-source-day (within fixed u),
    never on the collapsed cross-source-day sum. The latest (n, k)
    pair at tau' ≤ tau represents the most recent CDF observation
    for this primitive at this source day.
    """
    eligible = [int(t) for t in nk_by_tau.keys() if int(t) <= int(tau)]
    if not eligible:
        return None
    val = nk_by_tau[max(eligible)]
    return float(val[0]), float(val[1])


def _interpolated_rate_at(
    nk_by_tau: Mapping[int, Tuple[float, float]],
    tau_float: float,
) -> Optional[float]:
    """Interpolate the local primitive rate at a fractional A-clock age.

    Source-day mass is bucketed by `int(arrival_time)`, so arrivals assigned
    to one source day are spread through that day. A midpoint read avoids
    giving the whole bucket a full extra day of subject exposure.

    For evaluations exactly at the midpoint of two adjacent integer τ
    values the chart applies a 3-point central curvature correction:
    ``f(a+0.5) ≈ (f(a)+f(a+1))/2 − (1/8)·(f(a+1) − 2·f(a) + f(a-1))``.
    Linear interpolation between two adjacent integer rates overshoots
    the true CDF on convex regions of the lognormal subject CDF (rising
    flank below the inflection) and undershoots on concave regions; the
    central second-difference correction removes the leading curvature
    bias that drove the SIMPLE-flat residual documented in
    ``cohort-outside-in-post-73n-regression-tracker.md``. When fewer
    than three adjacent rates are available (boundary, sparse buckets)
    the function falls back to plain linear interpolation.
    """
    if not nk_by_tau:
        return None
    taus = sorted(int(t) for t in nk_by_tau.keys())
    if not taus:
        return None
    if tau_float < taus[0]:
        return 0.0

    lo_values = [t for t in taus if t <= tau_float]
    hi_values = [t for t in taus if t >= tau_float]
    if not lo_values:
        return 0.0
    lo = max(lo_values)
    hi = min(hi_values) if hi_values else lo

    def _rate_at_tau(tau_key: int) -> float:
        n_val, k_val = nk_by_tau[tau_key]
        n_float = float(n_val)
        if n_float <= 0.0:
            return 0.0
        return float(k_val) / n_float

    if hi == lo:
        return _rate_at_tau(lo)

    r_lo = _rate_at_tau(lo)
    r_hi = _rate_at_tau(hi)
    weight = (float(tau_float) - float(lo)) / float(hi - lo)
    linear = r_lo + weight * (r_hi - r_lo)

    # 3-point central curvature correction at the midpoint of two adjacent
    # integer τ values. The lognormal subject CDF is convex on the rising
    # flank (below inflection at age e^(μ-σ²)+onset) and concave above;
    # plain linear interpolation overshoots the true CDF in the convex
    # region by ≈ (1/8)·f″(c). For evaluations that aren't exactly at the
    # midpoint, the correction is scaled by the linear-interpolation
    # weight's distance from the centre (4·w·(1-w)) so endpoints are
    # untouched and the correction peaks at the midpoint.
    if hi - lo == 1:
        # Need one neighbour outside [lo, hi] to estimate f''. Prefer the
        # one with `lo - 1` (older retrieval) since CDF curvature is
        # better resolved on the convex/concave transition there.
        outer_lo_key = lo - 1
        outer_hi_key = hi + 1
        if outer_lo_key in nk_by_tau and outer_hi_key in nk_by_tau:
            r_outer_lo = _rate_at_tau(outer_lo_key)
            r_outer_hi = _rate_at_tau(outer_hi_key)
            # Central second difference at the midpoint c = (lo + hi)/2
            # using a 4-point stencil. The classical (1/8)·Δ² correction
            # uses second_diff = f(hi+1) − f(hi) − (f(lo) − f(lo-1)) =
            # f(hi+1) − f(hi) − f(lo) + f(lo-1).
            second_diff = (r_outer_hi - r_hi) - (r_lo - r_outer_lo)
            curvature_corr = (1.0 / 8.0) * second_diff
            # Scale by 4·w·(1-w) so the correction is 1.0 at the
            # midpoint (w=0.5) and 0 at the endpoints (w=0 or 1).
            ramp = 4.0 * weight * (1.0 - weight)
            return linear - ramp * curvature_corr
    return linear


def _date_plus_days(day: str, offset: int) -> Optional[str]:
    try:
        return (_date.fromisoformat(str(day)[:10]) + _timedelta(days=int(offset))).isoformat()
    except (TypeError, ValueError):
        return None


def _days_between(start: str, end: str) -> Optional[int]:
    try:
        return (
            _date.fromisoformat(str(end)[:10])
            - _date.fromisoformat(str(start)[:10])
        ).days
    except (TypeError, ValueError):
        return None


def _build_source_day_rate_cache(
    buckets: '_SubjectChainEvidenceBuckets',
    *,
    max_tau: int,
) -> Mapping[str, Mapping[str, Tuple[Optional[float], ...]]]:
    """Precompute source-day-specific latest-at-or-before rates.

    `_latest_nk_at_or_before` scans keys, so calling it inside the
    anchor/source/age loops is catastrophic for wide windows. This cache
    performs the forward-fill once per (edge, source_day).
    """
    horizon = max(int(max_tau), 0) + 1
    cache: Dict[str, Dict[str, Tuple[Optional[float], ...]]] = {}
    for edge_id, by_source_day in buckets.edge_nk_by_local_source_day.items():
        edge_cache: Dict[str, Tuple[Optional[float], ...]] = {}
        for source_day, nk_by_tau in by_source_day.items():
            series: List[Optional[float]] = []
            latest_rate: Optional[float] = None
            for age in range(horizon):
                if int(age) in nk_by_tau:
                    n_val, k_val = nk_by_tau[int(age)]
                    if n_val > 0.0:
                        latest_rate = max(0.0, min(1.0, float(k_val) / float(n_val)))
                series.append(latest_rate)
            edge_cache[str(source_day)[:10]] = tuple(series)
        cache[str(edge_id)] = edge_cache
    return cache


def _build_age_only_rate_cache(
    buckets: '_SubjectChainEvidenceBuckets',
    *,
    max_tau: int,
) -> Mapping[str, Tuple[Optional[float], ...]]:
    """Precompute edge age-only latest-at-or-before rates.

    For each edge and age, aggregate all source-day rows after each source
    day has been forward-filled to that age. This matches the window oracle's
    age-only local kernel and avoids recomputing the same value for every
    selected anchor/source-day pair.
    """
    horizon = max(int(max_tau), 0) + 1
    cache: Dict[str, Tuple[Optional[float], ...]] = {}
    for edge_id, by_source_day in buckets.edge_nk_by_local_source_day.items():
        # Forward-fill raw n/k, not just rates, so pooled Σk / Σn matches the
        # oracle and preserves denominator weighting across local source days.
        source_series: List[Tuple[Tuple[float, float], ...]] = []
        for nk_by_tau in by_source_day.values():
            latest: Optional[Tuple[float, float]] = None
            series: List[Tuple[float, float]] = []
            for age in range(horizon):
                if int(age) in nk_by_tau:
                    n_val, k_val = nk_by_tau[int(age)]
                    if n_val > 0.0:
                        latest = (float(n_val), float(k_val))
                series.append(latest if latest is not None else (0.0, 0.0))
            source_series.append(tuple(series))

        rates: List[Optional[float]] = []
        for age in range(horizon):
            sum_n = 0.0
            sum_k = 0.0
            for series in source_series:
                n_val, k_val = series[age]
                sum_n += n_val
                sum_k += k_val
            rates.append(
                max(0.0, min(1.0, sum_k / sum_n))
                if sum_n > 0.0 else None
            )
        cache[str(edge_id)] = tuple(rates)
    return cache


def _monotone_rate_array(
    rates: Sequence[Optional[float]],
    *,
    horizon: int,
) -> np.ndarray:
    arr = np.zeros(int(horizon), dtype=np.float64)
    limit = min(len(rates), int(horizon))
    for idx in range(limit):
        value = rates[idx]
        if value is not None:
            arr[idx] = max(0.0, min(1.0, float(value)))
    return np.maximum.accumulate(arr)


def _mass_series_for_anchor(
    mass_by_source_day: Mapping[str, float],
    *,
    anchor_day: str,
    horizon: int,
) -> np.ndarray:
    series = np.zeros(int(horizon), dtype=np.float64)
    for source_day, source_mass in mass_by_source_day.items():
        mass = float(source_mass or 0.0)
        if mass <= 0.0:
            continue
        offset = _days_between(anchor_day, source_day)
        if offset is None or offset < 0 or offset >= int(horizon):
            continue
        series[int(offset)] += mass
    return series


def _build_evidence_local_rate_attributed_subject_prefix(
    *,
    buckets: Optional['_SubjectChainEvidenceBuckets'],
    selected_source_day_mass: _SelectedSourceDayMass,
    anchor_days: Sequence[str],
    max_tau: int,
    denominator_node: str,
    end_node: str,
    emit_diagnostics: bool = False,
) -> Optional[_RateAttributedSubjectPrefix]:
    """Build terminal selected evidence by deterministic rate push-forward."""
    if buckets is None:
        return None
    edge_nk = buckets.edge_nk_by_source_day
    topology_edges = list(buckets.topology_edges)
    if not edge_nk or not topology_edges:
        return None

    source_day_rate_cache = _build_source_day_rate_cache(
        buckets,
        max_tau=int(max_tau),
    )
    age_only_rate_cache = _build_age_only_rate_cache(
        buckets,
        max_tau=int(max_tau),
    )
    anchor_keys = tuple(str(d)[:10] for d in anchor_days)
    by_node: Dict[str, Dict[str, Dict[str, float]]] = {
        str(denominator_node): {
            anchor: dict(
                selected_source_day_mass
                .by_node
                .get(str(denominator_node), {})
                .get(anchor, {})
            )
            for anchor in anchor_keys
        }
    }
    terminal_anchor_cum: Dict[str, Dict[int, float]] = {}
    terminal_anchor_cov: Dict[str, Dict[int, float]] = {}
    edge_provenance: List[Mapping[str, Any]] = []
    dual_eval_by_edge: Dict[str, Dict[str, Dict[str, Dict[int, float]]]] = {}

    for from_id, to_id, edge_id in topology_edges:
        from_id_str = str(from_id)
        to_id_str = str(to_id)
        source_mass_by_anchor = by_node.get(from_id_str, {})
        if not source_mass_by_anchor:
            edge_provenance.append({
                'edge_id': edge_id,
                'from_node': from_id_str,
                'to_node': to_id_str,
                'mass_source': 'absent_evidence_local_mass_for_node',
                'anchors_with_cumulative': [],
            })
            continue

        terminal_edge = to_id_str == str(end_node)
        next_node_mass: Dict[str, Dict[str, float]] = {}
        cumulative_by_anchor: Dict[str, Dict[int, float]] = {}
        coverage_by_anchor: Dict[str, Dict[int, float]] = {}
        diagnostic_by_anchor: Dict[str, Dict[str, Dict[int, float]]] = {}
        rate_surface = (
            'source_day_specific'
            if from_id_str == str(denominator_node)
            else 'age_only'
        )

        if rate_surface == 'age_only':
            horizon = int(max_tau) + 1
            edge_rates = _monotone_rate_array(
                age_only_rate_cache.get(str(edge_id), ()),
                horizon=horizon,
            )
            if not np.any(edge_rates > 0.0):
                edge_provenance.append({
                    'edge_id': edge_id,
                    'from_node': from_id_str,
                    'to_node': to_id_str,
                    'mass_source': 'selected_evidence_propagation_ledger',
                    'rate_surface': rate_surface,
                    'anchors_with_cumulative': [],
                    'operator_status': 'missing_age_only_rate',
                })
                continue
            inc_rates = np.empty_like(edge_rates)
            inc_rates[0] = edge_rates[0]
            if inc_rates.size > 1:
                inc_rates[1:] = np.maximum(edge_rates[1:] - edge_rates[:-1], 0.0)
            support_kernel = (inc_rates > 0.0).astype(np.float64)

            if terminal_edge:
                for anchor_day, mass_by_source_day in source_mass_by_anchor.items():
                    mass_series = _mass_series_for_anchor(
                        mass_by_source_day,
                        anchor_day=anchor_day,
                        horizon=horizon,
                    )
                    if not np.any(mass_series > 0.0):
                        continue
                    values = np.convolve(mass_series, edge_rates)[:horizon]
                    coverage = np.convolve(mass_series, support_kernel)[:horizon]
                    compact = {
                        int(tau): float(value)
                        for tau, value in enumerate(values)
                        if float(value) > 0.0
                    }
                    if compact:
                        cumulative_by_anchor[anchor_day] = compact
                        coverage_by_anchor[anchor_day] = {
                            int(tau): float(value)
                            for tau, value in enumerate(coverage)
                            if float(value) > 0.0
                        }
                        if emit_diagnostics:
                            diagnostic_by_anchor[anchor_day] = {
                                'production': dict(compact),
                                'midpoint': {},
                                'integer': dict(compact),
                                'ff_integer': dict(compact),
                            }
            else:
                for anchor_day, mass_by_source_day in source_mass_by_anchor.items():
                    mass_series = _mass_series_for_anchor(
                        mass_by_source_day,
                        anchor_day=anchor_day,
                        horizon=horizon,
                    )
                    if not np.any(mass_series > 0.0):
                        continue
                    propagated = np.convolve(mass_series, inc_rates)[:horizon]
                    for offset, value in enumerate(propagated):
                        if float(value) <= 0.0:
                            continue
                        dest_day = _date_plus_days(anchor_day, int(offset))
                        if dest_day is not None:
                            by_anchor = next_node_mass.setdefault(anchor_day, {})
                            by_anchor[dest_day] = (
                                by_anchor.get(dest_day, 0.0) + float(value)
                            )

            if terminal_edge:
                for anchor_day, by_tau in cumulative_by_anchor.items():
                    sink_cum = terminal_anchor_cum.setdefault(anchor_day, {})
                    for tau, value in by_tau.items():
                        sink_cum[int(tau)] = sink_cum.get(int(tau), 0.0) + float(value)
                for anchor_day, by_tau in coverage_by_anchor.items():
                    sink_cov = terminal_anchor_cov.setdefault(anchor_day, {})
                    for tau, value in by_tau.items():
                        sink_cov[int(tau)] = max(sink_cov.get(int(tau), 0.0), float(value))
                if emit_diagnostics and diagnostic_by_anchor:
                    dual_eval_by_edge[edge_id] = diagnostic_by_anchor
            else:
                existing = by_node.setdefault(to_id_str, {})
                for anchor_day, by_source_day in next_node_mass.items():
                    dest = existing.setdefault(anchor_day, {})
                    for source_day, value in by_source_day.items():
                        dest[source_day] = dest.get(source_day, 0.0) + float(value)

            edge_provenance.append({
                'edge_id': edge_id,
                'from_node': from_id_str,
                'to_node': to_id_str,
                'mass_source': 'selected_evidence_propagation_ledger',
                'rate_surface': rate_surface,
                'anchors_with_cumulative': sorted(cumulative_by_anchor.keys()),
                'operator_status': 'precomputed_age_only',
            })
            continue

        for anchor_day, mass_by_source_day in source_mass_by_anchor.items():
            if not mass_by_source_day:
                continue
            anchor_cum = {tau: 0.0 for tau in range(int(max_tau) + 1)}
            anchor_cov: Dict[int, float] = {}
            production_diag: Dict[int, float] = {}

            for source_day, source_mass in mass_by_source_day.items():
                mass = float(source_mass or 0.0)
                if mass <= 0.0:
                    continue
                offset = _days_between(anchor_day, source_day)
                if offset is None or offset > int(max_tau):
                    continue
                start_age = max(0, -int(offset))
                prev_rate = 0.0
                for age in range(start_age, int(max_tau) + 1):
                    tau = int(offset) + int(age)
                    if tau < 0 or tau > int(max_tau):
                        continue
                    if rate_surface == 'source_day_specific':
                        source_rates = (
                            source_day_rate_cache
                            .get(str(edge_id), {})
                            .get(str(source_day)[:10], ())
                        )
                        rate = (
                            source_rates[int(age)]
                            if int(age) < len(source_rates) else None
                        )
                    else:
                        edge_rates = age_only_rate_cache.get(str(edge_id), ())
                        rate = (
                            edge_rates[int(age)]
                            if int(age) < len(edge_rates) else None
                        )
                    if rate is None:
                        continue
                    # Operator-boundary monotone repair. The evaluator
                    # consumes non-negative increments, not raw noisy diffs.
                    rate = min(1.0, max(prev_rate, max(0.0, float(rate))))
                    if terminal_edge:
                        anchor_cum[tau] += mass * rate
                        production_diag[tau] = anchor_cum[tau]
                    else:
                        inc_rate = max(0.0, rate - prev_rate)
                        if inc_rate > 0.0:
                            dest_day = _date_plus_days(source_day, age)
                            if dest_day is not None:
                                by_anchor = next_node_mass.setdefault(anchor_day, {})
                                by_anchor[dest_day] = (
                                    by_anchor.get(dest_day, 0.0)
                                    + mass * inc_rate
                                )
                    if rate > prev_rate:
                        anchor_cov[tau] = anchor_cov.get(tau, 0.0) + mass
                    prev_rate = rate

            if terminal_edge:
                compact_cum = {
                    tau: float(value)
                    for tau, value in anchor_cum.items()
                    if float(value) > 0.0
                }
                if compact_cum:
                    cumulative_by_anchor[anchor_day] = compact_cum
                    coverage_by_anchor[anchor_day] = dict(anchor_cov)
                    if emit_diagnostics:
                        diagnostic_by_anchor[anchor_day] = {
                            'production': dict(production_diag),
                            'midpoint': {},
                            'integer': dict(production_diag),
                            'ff_integer': dict(production_diag),
                        }

        if terminal_edge:
            for anchor_day, by_tau in cumulative_by_anchor.items():
                sink_cum = terminal_anchor_cum.setdefault(anchor_day, {})
                for tau, value in by_tau.items():
                    sink_cum[int(tau)] = sink_cum.get(int(tau), 0.0) + float(value)
            for anchor_day, by_tau in coverage_by_anchor.items():
                sink_cov = terminal_anchor_cov.setdefault(anchor_day, {})
                for tau, value in by_tau.items():
                    sink_cov[int(tau)] = max(sink_cov.get(int(tau), 0.0), float(value))
            if emit_diagnostics and diagnostic_by_anchor:
                dual_eval_by_edge[edge_id] = diagnostic_by_anchor
        else:
            existing = by_node.setdefault(to_id_str, {})
            for anchor_day, by_source_day in next_node_mass.items():
                dest = existing.setdefault(anchor_day, {})
                for source_day, value in by_source_day.items():
                    dest[source_day] = dest.get(source_day, 0.0) + float(value)

        edge_provenance.append({
            'edge_id': edge_id,
            'from_node': from_id_str,
            'to_node': to_id_str,
            'mass_source': 'selected_evidence_propagation_ledger',
            'rate_surface': rate_surface,
            'anchors_with_cumulative': sorted(cumulative_by_anchor.keys()),
        })

    if not terminal_anchor_cum:
        return None
    ledger = _SelectedEvidencePropagationLedger(
        by_node={
            node: {
                anchor_day: dict(by_source_day)
                for anchor_day, by_source_day in by_anchor.items()
            }
            for node, by_anchor in by_node.items()
        },
        edge_provenance=tuple(edge_provenance),
    )

    return _RateAttributedSubjectPrefix(
        cumulative_by_anchor={
            anchor_day: dict(by_tau)
            for anchor_day, by_tau in terminal_anchor_cum.items()
        },
        landing_coverage_by_anchor={
            anchor_day: dict(by_tau)
            for anchor_day, by_tau in terminal_anchor_cov.items()
        },
        edge_provenance=ledger.edge_provenance,
        aggregate_provenance={
            'composition': 'rate_attributed_local_evidence_propagation.v1',
            'denominator_node': str(denominator_node),
            'end_node': str(end_node),
            'edge_count': len(topology_edges),
            'ledger_node_count': len(ledger.by_node),
        },
        diagnostic_dual_eval_by_edge=dict(dual_eval_by_edge) if emit_diagnostics else {},
    )


def _build_rate_attributed_subject_prefix(
    *,
    buckets: Optional['_SubjectChainEvidenceBuckets'],
    selected_source_day_mass: _SelectedSourceDayMass,
    anchor_days: Sequence[str],
    max_tau: int,
    denominator_node: str,
    end_node: str,
    use_evidence_local_ledger: bool = False,
    emit_diagnostics: bool = False,
) -> Optional[_RateAttributedSubjectPrefix]:
    """Compose Y_prefix(C, tau) by layering through the subject chain.

    Per docs/current/cohort-1apr-falling-k-problem-statement.md A.1
    §159 / A.6 phase 3: iterates subject primitives in topology order
    and, for each primitive U -> V, accumulates per-(C, source_day, tau)
    rate buckets, forward-fills (n, k) within source-day, multiplies
    by M_select(U, C, u) read from the **runtime-resolved** selected
    source-day mass surface, and sums across source days only AFTER
    per-source-day carry-forward. The terminal primitive's cumulative-
    at-target IS Y_prefix.

    M_select(U, C, u) is sourced from `selected_source_day_mass` —
    a runtime-level object (per A.6 phase 1). At U = denominator
    node X, it carries N_cohort(C) × g_carrier(C, u). For downstream
    primitive source nodes the runtime is responsible for populating
    M_select via subject-span prefix machinery (resolved subject
    chain composition); the projection layer must not invent
    downstream M_select from observed evidence increments.

    Single-hop is the chain-of-length-1 degeneracy: the only subject
    primitive's source is X, the runtime exposes M_select(X, *, *),
    and the iteration produces the terminal Y_prefix in one pass.
    For multi-hop subjects whose downstream M_select is not yet
    populated by the runtime, downstream contributions are zero —
    explicit graceful underestimate, recorded in edge_provenance for
    diagnostic visibility, never silently reconstructed from observed
    cumulative-at-target.
    """
    if buckets is None:
        return None
    edge_nk = buckets.edge_nk_by_source_day
    topology_edges = buckets.topology_edges
    if not edge_nk or not topology_edges:
        return None
    if use_evidence_local_ledger:
        return _build_evidence_local_rate_attributed_subject_prefix(
            buckets=buckets,
            selected_source_day_mass=selected_source_day_mass,
            anchor_days=anchor_days,
            max_tau=max_tau,
            denominator_node=denominator_node,
            end_node=end_node,
            emit_diagnostics=emit_diagnostics,
        )

    edges_in_order = list(topology_edges)
    cumulative_by_edge: Dict[
        str, Dict[str, Dict[int, float]],
    ] = {}
    landing_coverage_by_edge: Dict[
        str, Dict[str, Dict[int, float]],
    ] = {}
    edge_provenance: List[Mapping[str, Any]] = []
    # Dual-evaluation side-channel — only populated when --diag is on.
    # For each edge and anchor we record the rate-attributed cumulative
    # computed under both bucket-boundary conventions:
    #   midpoint: rate evaluated at A-clock age (tau - 0.5)
    #   integer:  rate evaluated at A-clock age tau
    # Production chooses between them by source-clock role below.
    dual_eval_by_edge: Dict[
        str, Dict[str, Dict[str, Dict[int, float]]],
    ] = {}

    anchor_keys = tuple(str(d)[:10] for d in anchor_days)

    for from_id, to_id, edge_id in edges_in_order:
        # Read M_select at this primitive's source node from the
        # runtime-level mass surface. NEVER mutate it from a prior
        # edge's observed cumulative — that would be projection-time
        # semantic reconstruction (forbidden per docs A.1 §153 /
        # A.3). Downstream nodes whose M_select has not been
        # populated by the runtime contribute zero (graceful, recorded).
        edge_buckets = edge_nk.get(edge_id, {})
        from_id_str = str(from_id)
        node_has_mass = selected_source_day_mass.has_node(from_id_str)
        if not node_has_mass:
            edge_provenance.append({
                'edge_id': edge_id,
                'from_node': from_id_str,
                'to_node': str(to_id),
                'mass_source': 'absent_runtime_did_not_populate_M_select_for_node',
                'anchors_with_cumulative': [],
            })
            cumulative_by_edge[edge_id] = {}
            landing_coverage_by_edge[edge_id] = {}
            continue

        cumulative_by_anchor: Dict[str, Dict[int, float]] = {}
        landing_coverage_by_anchor: Dict[str, Dict[int, float]] = {}
        for anchor_day in anchor_keys:
            anchor_buckets = edge_buckets.get(anchor_day, {})
            if not anchor_buckets:
                continue
            tau_union = sorted({
                int(t)
                for nk_by_tau in anchor_buckets.values()
                for t in nk_by_tau.keys()
            })
            cumulative_at_tau: Dict[int, float] = {}
            coverage_at_tau: Dict[int, float] = {}
            cumulative_midpoint_at_tau: Dict[int, float] = (
                {} if emit_diagnostics else {}
            )
            cumulative_integer_at_tau: Dict[int, float] = (
                {} if emit_diagnostics else {}
            )
            cumulative_ff_integer_at_tau: Dict[int, float] = (
                {} if emit_diagnostics else {}
            )
            # The midpoint shift compensates for mass spread within the
            # bucket-day axis: when M_select(X, anchor) places mass at
            # multiple source-days the rate-attributed sum integrates
            # rate(τ) over each source-day's [s, s+1) interval and the
            # midpoint approximates the integral (rate(τ-0.5)). When
            # M_select is a Dirac at a single source-day there is no
            # interval to integrate — the contribution is rate(τ) × mass
            # evaluated at the cell's own A-clock τ. This is a natural
            # degeneracy of the integration: Dirac mass means a zero-width
            # bucket, hence zero shift. Computed once per (edge, anchor)
            # from the M_select shape so identity carrier, single-source
            # active fixtures, and dense-spread active fixtures all flow
            # through one expression without mode-flag forks.
            midpoint_shift = (
                0.5 if len(anchor_buckets) > 1 else 0.0
            )
            for tau in tau_union:
                # Per-source-day forward-fill then weighted sum.
                # For the first subject layer (U == query denominator X),
                # M_select is the carrier floor-day bucket; the bucket
                # width is captured by `midpoint_shift` above. Downstream
                # subject layers have already been placed by composed
                # A->U timing; applying the midpoint shift again
                # double-corrects the chain.
                rate_tau = (
                    float(tau) - midpoint_shift
                    if from_id_str == str(denominator_node)
                    else float(tau)
                )
                rate_attributed_sum = 0.0
                rate_attributed_sum_midpoint = 0.0
                rate_attributed_sum_integer = 0.0
                rate_attributed_sum_ff_integer = 0.0
                exact_tau_share = 0.0
                for source_day, nk_by_tau in anchor_buckets.items():
                    rate = _interpolated_rate_at(nk_by_tau, rate_tau)
                    if rate is None:
                        continue
                    mass = selected_source_day_mass.mass_at(
                        from_id_str,
                        anchor_day,
                        source_day,
                    )
                    if mass <= 0.0:
                        continue
                    rate_attributed_sum += mass * rate
                    if emit_diagnostics:
                        # Diagnostic-only: evaluate four conventions using
                        # the same mass and the same nk_by_tau. This keeps
                        # the boundary decision inspectable without changing
                        # the production source-clock rule above.
                        # 1. midpoint   = interpolation at A-clock τ-0.5
                        # 2. integer    = interpolation at integer A-clock τ
                        # 3. ff_integer = forward-fill (latest at-or-before)
                        #                 at integer A-clock τ — the TODO
                        #                 design's strict semantics.
                        rate_midpoint = _interpolated_rate_at(
                            nk_by_tau, float(tau) - 0.5,
                        )
                        if rate_midpoint is not None:
                            rate_attributed_sum_midpoint += mass * rate_midpoint
                        rate_integer = _interpolated_rate_at(nk_by_tau, float(tau))
                        if rate_integer is not None:
                            rate_attributed_sum_integer += mass * rate_integer
                        ff_nk = _latest_nk_at_or_before(nk_by_tau, int(tau))
                        if ff_nk is not None:
                            n_ff, k_ff = ff_nk
                            if n_ff > 0:
                                rate_attributed_sum_ff_integer += mass * (k_ff / n_ff)
                    if int(tau) in nk_by_tau:
                        exact_tau_share += mass
                cumulative_at_tau[int(tau)] = float(rate_attributed_sum)
                if emit_diagnostics:
                    cumulative_midpoint_at_tau[int(tau)] = float(
                        rate_attributed_sum_midpoint
                    )
                    cumulative_integer_at_tau[int(tau)] = float(
                        rate_attributed_sum_integer
                    )
                    cumulative_ff_integer_at_tau[int(tau)] = float(
                        rate_attributed_sum_ff_integer
                    )
                coverage_at_tau[int(tau)] = float(exact_tau_share)
            if emit_diagnostics and cumulative_integer_at_tau:
                edge_dual = dual_eval_by_edge.setdefault(edge_id, {})
                edge_dual[anchor_day] = {
                    'production': dict(cumulative_at_tau),
                    'midpoint': dict(cumulative_midpoint_at_tau),
                    'integer': dict(cumulative_integer_at_tau),
                    'ff_integer': dict(cumulative_ff_integer_at_tau),
                }
            if cumulative_at_tau:
                cumulative_by_anchor[anchor_day] = cumulative_at_tau
                landing_coverage_by_anchor[anchor_day] = coverage_at_tau

        cumulative_by_edge[edge_id] = cumulative_by_anchor
        landing_coverage_by_edge[edge_id] = landing_coverage_by_anchor

        edge_provenance.append({
            'edge_id': edge_id,
            'from_node': from_id_str,
            'to_node': str(to_id),
            'anchors_with_cumulative': sorted(cumulative_by_anchor.keys()),
            'mass_source': 'runtime_selected_source_day_mass',
            'rate_tau_offset': -0.5 if from_id_str == str(denominator_node) else 0.0,
        })

    # Pick the terminal layer's cumulative as Y_prefix. Terminal =
    # any edge whose to_node is end_node. For chains there is exactly
    # one such edge. For multi-merge DAGs, sum across terminal edges.
    terminal_anchor_cum: Dict[str, Dict[int, float]] = {}
    terminal_anchor_cov: Dict[str, Dict[int, float]] = {}
    for from_id, to_id, edge_id in edges_in_order:
        if str(to_id) != str(end_node):
            continue
        edge_cum = cumulative_by_edge.get(edge_id, {})
        edge_cov = landing_coverage_by_edge.get(edge_id, {})
        for anchor_day, by_tau in edge_cum.items():
            sink_cum = terminal_anchor_cum.setdefault(anchor_day, {})
            for tau, value in by_tau.items():
                sink_cum[int(tau)] = sink_cum.get(int(tau), 0.0) + float(value)
        for anchor_day, by_tau in edge_cov.items():
            sink_cov = terminal_anchor_cov.setdefault(anchor_day, {})
            for tau, value in by_tau.items():
                sink_cov[int(tau)] = max(
                    sink_cov.get(int(tau), 0.0),
                    float(value),
                )

    if not terminal_anchor_cum:
        return None

    return _RateAttributedSubjectPrefix(
        cumulative_by_anchor={
            anchor_day: dict(by_tau)
            for anchor_day, by_tau in terminal_anchor_cum.items()
        },
        landing_coverage_by_anchor={
            anchor_day: dict(by_tau)
            for anchor_day, by_tau in terminal_anchor_cov.items()
        },
        edge_provenance=tuple(edge_provenance),
        aggregate_provenance={
            'composition': 'rate_attributed_subject_chain.v1',
            'denominator_node': str(denominator_node),
            'end_node': str(end_node),
            'edge_count': len(edges_in_order),
        },
        diagnostic_dual_eval_by_edge={
            edge_id: {
                anchor_day: {
                    'production': dict(branches['production']),
                    'midpoint': dict(branches['midpoint']),
                    'integer': dict(branches['integer']),
                    'ff_integer': dict(branches['ff_integer']),
                }
                for anchor_day, branches in by_anchor.items()
            }
            for edge_id, by_anchor in dual_eval_by_edge.items()
        } if emit_diagnostics else {},
    )


def _cell_source_provenance(
    *,
    carrier_primitives: Sequence[ConditionedTransitionPrimitive],
    subject_primitives: Sequence[ConditionedTransitionPrimitive],
    diagnostics: Mapping[str, Any],
    pairing_decision: str,
    emit_diagnostics: bool = False,
) -> Mapping[str, Any]:
    def _edge_ids(primitives: Sequence[ConditionedTransitionPrimitive]) -> List[str]:
        return [
            str(getattr(getattr(primitive, 'transition', None), 'edge_id', ''))
            for primitive in primitives
            if getattr(getattr(primitive, 'transition', None), 'edge_id', None)
        ]

    def _binding_policies(
        primitives: Sequence[ConditionedTransitionPrimitive],
    ) -> List[Any]:
        policies: List[Any] = []
        for primitive in primitives:
            weighted = getattr(primitive, 'weighted_evidence', None)
            policies.append(
                getattr(weighted, 'binding_policy', None)
                if weighted is not None else None
            )
        return policies

    return {
        'clock_adapter': 'selected_a_clock.prefix_arrival_topology_composer.v1',
        'denominator_edge_ids': _edge_ids(carrier_primitives),
        'numerator_edge_ids': _edge_ids(subject_primitives),
        'denominator_binding_policies': _binding_policies(carrier_primitives),
        'numerator_binding_policies': _binding_policies(subject_primitives),
        'pairing_decision': pairing_decision,
        # Per-cell diagnostics replicate both surface provenances; large enough
        # to overflow V8's max string length on multi-hop. Emit only with --diag.
        **({'diagnostics': dict(diagnostics)} if emit_diagnostics else {}),
    }


def _synthesize_identity_carrier_observed_surface(
    *,
    subject_primitives: Sequence[ConditionedTransitionPrimitive],
    denominator_node: str,
    anchor_days: Sequence[str],
    max_tau: int,
) -> Optional[ObservedSpanEvidenceSurface]:
    """Chain-of-length-0 degeneracy of the carrier observed surface.

    When ``population_root == denominator_node`` (the identity-carrier
    case: ``window()`` or ``cohort(A=X)``) the carrier chain is empty
    and the carrier surface is sourced from the X-rooted subject
    primitive's row metadata: each row's
    ``(observed_date, retrieved_at, n_weighted)`` becomes a carrier
    cell at ``(anchor=root_day, τ=retrieved_at-observed_date,
    observed_count=n_weighted × share)``. The X-day → A-day backmap is
    identity because A == X. This is invariant 6 in
    `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`: identity
    carrier is data, not a route — and AP58: the new case is a
    degeneracy of the same sub-object, not a parallel pipeline.
    """
    if not subject_primitives:
        return None
    x_rooted: Optional[ConditionedTransitionPrimitive] = None
    for primitive in subject_primitives:
        src = str(getattr(primitive.transition, 'source_node', '') or '')
        if src == str(denominator_node):
            x_rooted = primitive
            break
    if x_rooted is None:
        return None
    anchor_set = {str(a)[:10] for a in anchor_days if str(a)[:10]}
    if not anchor_set:
        return None
    cells: Dict[str, Dict[int, ObservedSpanEvidenceCell]] = defaultdict(dict)
    rows = _primitive_weighted_rows(x_rooted)
    for row in rows:
        observed = str(getattr(row, 'observed_date', '') or '')[:10]
        retrieved_raw = getattr(row, 'retrieved_at', None)
        retrieved = (
            str(retrieved_raw)[:10] if retrieved_raw is not None
            and str(retrieved_raw).strip() else ''
        )
        if not observed or not retrieved:
            continue
        try:
            obs_d = _date.fromisoformat(observed)
            ret_d = _date.fromisoformat(retrieved)
        except (TypeError, ValueError):
            continue
        tau = (ret_d - obs_d).days
        if tau < 0 or tau > int(max_tau):
            continue
        n_w = float(getattr(row, 'n_weighted', 0.0) or 0.0)
        shares = dict(getattr(row, 'root_day_shares', {}) or {})
        # Identity backmap: when no root_day_shares are populated, the
        # row places onto its own observed_date (anchor == observed_date
        # in identity-carrier mode by definition).
        if not shares and observed in anchor_set:
            shares = {observed: 1.0}
        for anchor_key, share in shares.items():
            anchor_str = str(anchor_key)[:10]
            if anchor_str not in anchor_set:
                continue
            share_f = float(share or 0.0)
            if share_f <= 0.0:
                continue
            existing = cells[anchor_str].get(int(tau))
            new_count = (
                (existing.observed_count if existing else 0.0)
                + n_w * share_f
            )
            new_share = (
                (existing.landing_coverage if existing else 0.0)
                + share_f
            )
            cells[anchor_str][int(tau)] = ObservedSpanEvidenceCell(
                anchor_day=anchor_str,
                tau=int(tau),
                observed_count=float(new_count),
                edge_capacities={},
                landing_coverage=float(min(1.0, new_share)),
                provenance={
                    'source': 'identity_carrier_x_rooted_subject_primitive',
                    'x_rooted_edge_id': str(
                        getattr(x_rooted.transition, 'edge_id', '')
                    ),
                },
            )
    if not any(cells.values()):
        return None
    return ObservedSpanEvidenceSurface(
        role='carrier_a_to_x',
        root_node=str(denominator_node),
        end_node=str(denominator_node),
        cells_by_anchor_day={k: dict(v) for k, v in cells.items()},
        edge_ids=(),
        provenance={
            'source': 'identity_carrier_synthesis',
            'x_rooted_edge_id': str(
                getattr(x_rooted.transition, 'edge_id', '')
            ),
        },
    )


def _build_selected_a_clock_evidence_from_runtime(
    runtime: ResolvedCFRuntime,
    *,
    cohort_list: Optional[Sequence[Mapping[str, Any]]],
    anchor_from: str,
    anchor_to: str,
    max_tau: int,
    emit_diagnostics: bool = False,
) -> Optional[SelectedAClockEvidence]:
    """Build SelectedAClockEvidence cells from the runtime's resolved
    dual-prefix object.

    Per docs/current/cohort-1apr-falling-k-problem-statement.md A.1:
    cell amplitudes come from `runtime.selected_x_prefix` (carrier-
    only N_cohort × G_carrier) and a rate-attributed Y_prefix built
    here from `runtime.selected_source_day_mass` (M_select per
    primitive source node) and the subject-side per-source-day
    evidence buckets. The projection layer never invents or mutates
    M_select — it is a runtime-resolved object (A.6 phase 1).

    The carrier and subject observed surfaces are still built and
    provide the role-aware coverage signal; their `observed_count`
    is no longer consulted for cell amplitude.

    Mode-agnostic: serves active cohort `A != X`, `cohort(A=X)`, and
    `window()` uniformly. The identity-carrier degeneracy
    (`population_root == denominator_node`) builds the carrier surface
    via `_synthesize_identity_carrier_observed_surface` — the
    chain-of-length-0 case of carrier composition. Per the
    `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` invariant 6
    ("identity carrier is data, not a route") and atom 2 sub-stage 2a
    of `cohort-maturity-evidence-coverage-design.md`.
    """
    def _record_diag(reason: str, **extra: Any) -> None:
        try:
            runtime.selected_a_clock_evidence_diagnostics = {
                'source': 'runtime_rate_attributed_evidence',
                'refusal': reason,
                **extra,
            }
        except Exception:
            pass

    pop_root = runtime.population_root
    denom_node = runtime.denominator_node
    if pop_root is None or denom_node is None:
        _record_diag('incomplete_population_root_or_denominator')
        return None
    is_identity_carrier = str(pop_root) == str(denom_node)

    anchor_days = _selected_anchor_day_keys(
        cohort_list,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
    )
    if not anchor_days:
        _record_diag('no_selected_anchor_days')
        return None

    carrier_primitives = _runtime_primitives_for_role(runtime, 'carrier')
    subject_primitives = _runtime_primitives_for_role(runtime, 'subject')
    # Identity-carrier mode (window or cohort(A=X)) has an empty carrier
    # chain by construction; the carrier surface is synthesised from the
    # X-rooted subject primitive below. Refuse only when active and no
    # carrier primitives are available — that is the genuine
    # "no carrier observations" state for A != X.
    if not is_identity_carrier and not carrier_primitives:
        _record_diag(
            'no_carrier_primitives',
            conditioned_primitive_count=len(runtime.conditioned_primitive_map or {}),
        )
        return None
    if is_identity_carrier and not subject_primitives:
        _record_diag(
            'identity_carrier_without_subject_primitive',
            conditioned_primitive_count=len(runtime.conditioned_primitive_map or {}),
        )
        return None

    selected_source_day_mass = getattr(
        runtime, 'selected_source_day_mass', None,
    )
    x_prefix = getattr(runtime, 'selected_x_prefix', None)
    if selected_source_day_mass is None:
        _record_diag('runtime_did_not_resolve_selected_source_day_mass')
        return None
    if x_prefix is None:
        _record_diag('runtime_did_not_resolve_selected_x_prefix')
        return None
    # If the carrier delay PMF never reaches the denominator node X
    # (carrier CDF is all-zero), M_select is structurally empty for
    # every anchor and no cell should be emitted. Refuse here rather
    # than emit zero-amplitude cells that would mislead downstream
    # consumers about coverage.
    if not any(
        bool(by_anchor)
        for by_anchor in selected_source_day_mass.by_node.values()
    ):
        _record_diag('selected_source_day_mass_empty_no_carrier_reach')
        return None

    # Backmap: in identity-carrier mode the X-day → A-day mapping is
    # identity (A == X), so callers do not need a join-conditioned
    # carrier CDF. `_join_conditioned_carrier_backmap` naturally produces
    # a trivial single-day map under the identity-carrier
    # selected_source_day_mass (M_select(X, anchor, anchor_day) = N_cohort,
    # zero elsewhere); we pass `None` instead to make the identity
    # explicit and skip the redundant work — the subject placement loop
    # falls back to `root_day_shares` directly.
    carrier_to_x_weights = (
        None if is_identity_carrier
        else _join_conditioned_carrier_backmap(
            runtime=runtime,
            anchor_days=anchor_days,
        )
    )
    if is_identity_carrier:
        # Chain-of-length-0 degeneracy: carrier observed surface is
        # sourced from the X-rooted subject primitive's row metadata,
        # not from a separate carrier composition (there is no carrier
        # chain to compose). See `_synthesize_identity_carrier_observed_surface`.
        carrier_surface = _synthesize_identity_carrier_observed_surface(
            subject_primitives=subject_primitives,
            denominator_node=str(denom_node),
            anchor_days=anchor_days,
            max_tau=max_tau,
        )
        _carrier_buckets = None
    else:
        carrier_surface, _carrier_buckets = _build_observed_span_evidence_surface(
            runtime=runtime,
            role='carrier_a_to_x',
            root_node=str(pop_root),
            end_node=str(denom_node),
            primitives=carrier_primitives,
            anchor_days=anchor_days,
            max_tau=max_tau,
            emit_diagnostics=emit_diagnostics,
        )
    subject_surface = None
    subject_buckets: Optional[_SubjectChainEvidenceBuckets] = None
    if subject_primitives:
        subject_surface, subject_buckets = _build_observed_span_evidence_surface(
            runtime=runtime,
            role='subject_x_to_end_on_a_clock',
            root_node=str(denom_node),
            end_node=str(runtime.subject_end),
            primitives=subject_primitives,
            anchor_days=anchor_days,
            max_tau=max_tau,
            root_day_to_anchor_weights=carrier_to_x_weights,
            emit_diagnostics=emit_diagnostics,
        )
    runtime.observed_carrier_a_to_x = carrier_surface
    runtime.observed_subject_x_to_end = subject_surface

    y_prefix = _build_rate_attributed_subject_prefix(
        buckets=subject_buckets,
        selected_source_day_mass=selected_source_day_mass,
        anchor_days=anchor_days,
        max_tau=int(max_tau),
        denominator_node=str(denom_node),
        end_node=str(runtime.subject_end),
        use_evidence_local_ledger=is_identity_carrier,
        emit_diagnostics=emit_diagnostics,
    )

    if carrier_surface is None or not carrier_surface.has_cells():
        _record_diag(
            'no_carrier_observed_surface',
            carrier_primitive_count=len(carrier_primitives),
            subject_primitive_count=len(subject_primitives),
            carrier_surface=(
                dict(carrier_surface.provenance)
                if carrier_surface is not None else None
            ),
            subject_surface=(
                dict(subject_surface.provenance)
                if subject_surface is not None else None
            ),
        )
        return None

    cells: Dict[str, Dict[int, SelectedAClockEvidenceCell]] = defaultdict(dict)
    invalid_pair_count = 0
    emitted_count = 0
    for anchor_day in anchor_days:
        # Cell-emit gate: presence is observed-evidence-driven (carrier
        # surface or subject surface or y_prefix has a landing for this
        # anchor at some tau). Amplitude — separately — is read from
        # the runtime-resolved dual-prefix object (carrier-only
        # X_prefix and rate-attributed Y_prefix). The two concerns are
        # decoupled per docs/current/cohort-1apr-falling-k-problem-
        # statement.md A.1 §157: "the carrier observed surface gates
        # whether a cell exists; X_prefix carries amplitude".
        tau_values = set(carrier_surface.tau_values_for_anchor(anchor_day))
        if subject_surface is not None:
            tau_values.update(subject_surface.tau_values_for_anchor(anchor_day))
        if y_prefix is not None:
            tau_values.update(y_prefix.taus_for_anchor(anchor_day))
        for tau in sorted(tau_values):
            x_cell = carrier_surface.cell_at_or_before(anchor_day, int(tau))
            # NB: `x_cell is None` (no carrier observation at-or-before τ)
            # is the absent state — chain not yet observed for this anchor
            # at this τ. The amplitude itself comes from x_prefix
            # (carrier-only N_cohort × G_carrier), but the carrier
            # surface gates *whether* a cell exists for this (anchor, τ)
            # via observed-evidence-coverage semantics (design §3.1).
            if x_cell is None:
                continue
            y_cell = (
                subject_surface.cell_at_or_before(anchor_day, int(tau))
                if subject_surface is not None else None
            )
            # Amplitude reads:
            #   X = X_prefix(C, tau) = N_cohort(C) × G_carrier(C, tau)
            #     — carrier-only, not from observed surface (docs A.1 §157).
            #   Y = Y_prefix(C, tau) = rate-attributed sum from terminal
            #     subject layer — per-source-day forward-fill, then
            #     superadd (docs A.1 §159, A.6 phase 3).
            x_val = float(x_prefix.value_at(anchor_day, int(tau)))
            y_val = (
                float(y_prefix.value_at(anchor_day, int(tau)))
                if y_prefix is not None
                else 0.0
            )
            pairing = (
                'rate_attributed_y_prefix_with_carrier_only_x_prefix'
                if y_prefix is not None
                else 'carrier_only_x_prefix_with_zero_y_prefix'
            )
            # No display-layer Y ≤ X cap (docs §A.6 phase 6).
            # X_prefix and Y_prefix share one M_select(X) reference,
            # so by construction Y_prefix is bounded above by X_prefix
            # — every Y contribution is `M_select(X, C, u) × k/n` with
            # k/n ≤ 1 and X_prefix(C, τ) is `Σ_{u≤τ} M_select(X, C, u)`.
            # If a downstream regression reintroduces Y > X, the
            # aggregate must expose it, not silently repair it.
            # Observation support at exactly this τ. Each role's surface
            # cell already encodes the design §2.2 placement-share sum:
            #   - carrier surface cell: capped sum of carrier-edge shares
            #     at exact τ for this anchor.
            #   - subject surface cell: capped sum of subject-edge shares
            #     at exact τ AFTER the join-conditioned carrier backmap
            #     has distributed each subject row across anchor days
            #     proportional to carrier reach (design §2.4 property 4).
            #
            # Values and support answer different questions. X/Y values
            # are selected cumulative prefixes and may legitimately carry
            # forward when the value is flat. Coverage asks whether this
            # paired selected-prefix row had observation support at τ. A
            # fresh subject row proves the selected row was observed even
            # when the carrier prefix itself did not receive a new exact-τ
            # increment, so row support is the union of exact carrier and
            # exact subject support. If both are absent, forward-filled
            # values alone still produce zero coverage.
            carrier_exact_coverage = (
                float(x_cell.landing_coverage)
                if int(x_cell.tau) == int(tau) else 0.0
            )
            subject_exact_coverage = (
                float(y_cell.landing_coverage)
                if y_cell is not None and int(y_cell.tau) == int(tau)
                else 0.0
            )
            row_observation_support = max(
                subject_exact_coverage,
                carrier_exact_coverage,
            )
            carrier_landing_coverage = row_observation_support
            subject_landing_coverage = row_observation_support
            cell_diagnostics: Mapping[str, Any] = (
                {
                    'carrier_cell': {
                        'tau': int(x_cell.tau),
                        'observed_count': float(x_cell.observed_count),
                        'edge_capacities': dict(x_cell.edge_capacities),
                    },
                    'subject_cell': (
                        {
                            'tau': int(y_cell.tau),
                            'observed_count': float(y_cell.observed_count),
                            'edge_capacities': dict(y_cell.edge_capacities),
                        }
                        if y_cell is not None else None
                    ),
                    'invalid_pair_count': int(invalid_pair_count),
                    'final_selected_a_clock_placement': {
                        'anchor_day': anchor_day,
                        'tau': int(tau),
                        'x_at_query_x': float(x_val),
                        'y_at_subject_end': float(y_val),
                    },
                    # `carrier_surface` and `subject_surface` provenance
                    # are attached ONCE on `_selected_a_clock_evidence`
                    # via `_surface_diag(...)` in `_project_runtime_rows`;
                    # do NOT replicate them per cell — at multi-hop scale
                    # (1.5K cells × ~3.85MB each) that produces a
                    # multi-GB JSON payload that wedges FastAPI's
                    # response encoder. The full per-(edge, anchor, tau)
                    # dual evaluation is similarly attached ONCE
                    # (`rate_attributed_dual_eval_by_edge`).
                }
                if emit_diagnostics else {}
            )
            cells[anchor_day][int(tau)] = SelectedAClockEvidenceCell(
                anchor_day=anchor_day,
                tau=int(tau),
                x_at_query_x=float(x_val),
                y_at_subject_end=float(y_val),
                source='runtime_rate_attributed_evidence',
                provenance=_cell_source_provenance(
                    carrier_primitives=carrier_primitives,
                    subject_primitives=subject_primitives,
                    diagnostics=cell_diagnostics,
                    pairing_decision=pairing,
                    emit_diagnostics=emit_diagnostics,
                ),
                carrier_landing_coverage=carrier_landing_coverage,
                subject_landing_coverage=subject_landing_coverage,
            )
            emitted_count += 1
    # Strict observation-support frontier per anchor day. Per
    # docs/current/selected-a-clock-retrieval-frontier-provenance-proposal.md:
    # support comes only from real retrieved landings — concretely, the
    # per-role observed-surface cells where `landing_coverage > 0` (rows
    # that landed at exactly this τ for this anchor, per
    # cohort-maturity-evidence-coverage-design.md §2.2). Forward-fill is
    # not support; observed-date fallbacks are forbidden as support.
    #
    # Active carrier (A != X): paired support requires every required
    # nonzero role to have strict support, and paired_tau = min(carrier,
    # subject). Identity carrier (window or A == X): the carrier is
    # structural identity with no retrieval-bearing role, so paired_tau =
    # subject_tau when present.
    strict_support: Dict[str, _SelectedRoleSupport] = {}
    for anchor_day in anchor_days:
        if carrier_surface is not None:
            carrier_taus = [
                int(tau)
                for tau, cell in carrier_surface
                .cells_by_anchor_day.get(anchor_day, {}).items()
                if float(cell.landing_coverage) > 0.0
            ]
        else:
            carrier_taus = []
        if subject_surface is not None:
            subject_taus = [
                int(tau)
                for tau, cell in subject_surface
                .cells_by_anchor_day.get(anchor_day, {}).items()
                if float(cell.landing_coverage) > 0.0
            ]
        else:
            subject_taus = []
        carrier_fresh_tau = max(carrier_taus) if carrier_taus else None
        # Carrier value support is a carried-forward selected X prefix,
        # not an exact-τ refresh signal. A stale-but-known denominator
        # remains evidence-backed; only the subject side needs fresh selected
        # observation support to advance the paired frontier. This prevents a
        # short upstream carrier refresh horizon (for example A->X ending at
        # τ=15) from incorrectly ending epoch A when selected values exist
        # through a later subject observation horizon.
        carrier_value_candidates = [
            int(tau)
            for tau, cell in cells.get(anchor_day, {}).items()
            if cell.x_at_query_x is not None
        ]
        carrier_value_tau = (
            max(carrier_value_candidates)
            if carrier_value_candidates else None
        )
        subject_tau = max(subject_taus) if subject_taus else None
        if is_identity_carrier:
            paired_tau = subject_tau
        else:
            paired_tau = (
                min(carrier_value_tau, subject_tau)
                if carrier_value_tau is not None and subject_tau is not None
                else None
            )
        if (
            carrier_fresh_tau is None
            and carrier_value_tau is None
            and subject_tau is None
            and paired_tau is None
        ):
            continue
        strict_support[anchor_day] = _SelectedRoleSupport(
            carrier_tau=carrier_fresh_tau,
            carrier_fresh_tau=carrier_fresh_tau,
            carrier_value_tau=carrier_value_tau,
            subject_tau=subject_tau,
            paired_tau=paired_tau,
        )

    selected = SelectedAClockEvidence(
        cells_by_anchor_day={k: dict(v) for k, v in cells.items()},
        anchor_from=str(anchor_from),
        anchor_to=str(anchor_to),
        source='runtime_rate_attributed_evidence',
        rate_attributed_dual_eval_by_edge=(
            dict(y_prefix.diagnostic_dual_eval_by_edge)
            if (emit_diagnostics and y_prefix is not None)
            else {}
        ),
        strict_support_by_anchor=strict_support,
    )
    # Persist Y_prefix on the runtime (X_prefix and the source-day
    # mass surface were resolved during runtime construction). The
    # seam invariant (docs A.4) requires the reducer
    # `_selected_cohort_group_rate_draws` and the row builder to
    # read identical Y/X prefixes.
    try:
        runtime.selected_y_prefix = y_prefix
    except Exception:
        pass
    print(
        f"[evi_diag] selected_a_clock: "
        f"anchor_days={len(anchor_days)} anchor_first={anchor_days[0] if anchor_days else None} "
        f"carrier_has_cells={carrier_surface.has_cells() if carrier_surface else None} "
        f"subject_has_cells={subject_surface.has_cells() if subject_surface else None} "
        f"emitted_cells={emitted_count} invalid_pairs={invalid_pair_count} "
        f"y_prefix_present={y_prefix is not None} "
        f"selected_has_cells={selected.has_cells()}",
        flush=True,
    )
    _record_diag(
        'ok',
        emitted_cell_count=int(emitted_count),
        invalid_pair_count=int(invalid_pair_count),
        subject_clock_backmap=(
            'join_conditioned_carrier_cdf_mean'
            if carrier_to_x_weights is not None else None
        ),
        x_prefix_provenance=dict(x_prefix.provenance),
        y_prefix_provenance=(
            dict(y_prefix.aggregate_provenance) if y_prefix is not None else None
        ),
    )
    if isinstance(getattr(runtime, 'projection_provenance', None), dict):
        runtime.projection_provenance['selected_a_clock_evidence'] = {
            'source': selected.source,
            'emitted_cell_count': int(emitted_count),
            'invalid_pair_count': int(invalid_pair_count),
            'x_prefix_source': dict(x_prefix.provenance).get('source'),
            'y_prefix_source': (
                dict(y_prefix.aggregate_provenance).get('composition')
                if y_prefix is not None
                else None
            ),
            # Per-anchor strict observation support. Required by the
            # proposal's design decision 6: diagnostics expose per-role
            # and paired support frontiers for active selected cohorts.
            'strict_support_frontiers': {
                anchor_day: {
                    'carrier_tau': supp.carrier_tau,
                    'carrier_fresh_tau': supp.carrier_fresh_tau,
                    'carrier_value_tau': supp.carrier_value_tau,
                    'subject_tau': supp.subject_tau,
                    'paired_tau': supp.paired_tau,
                }
                for anchor_day, supp in strict_support.items()
            },
            'identity_carrier': bool(is_identity_carrier),
        }
    return selected if selected.has_cells() else None


def _pad_cdf_to_horizon(
    cdf: np.ndarray, T: int, S: int,
) -> Optional[np.ndarray]:
    """Trim or right-pad a per-particle CDF surface to width T."""
    if cdf is None or cdf.shape[0] != S:
        return None
    if cdf.shape[1] >= T:
        return cdf[:, :T].astype(np.float64, copy=False)
    last = cdf[:, -1:]
    pad = np.broadcast_to(last, (S, T - cdf.shape[1]))
    return np.concatenate([cdf, pad], axis=1).astype(np.float64, copy=False)


def _selected_cohort_group_rate_draws(
    runtime: ResolvedCFRuntime,
    engine_cohorts: Sequence[Any],
    *,
    horizon: int,
    cohort_list: Optional[Sequence[Mapping[str, Any]]] = None,
    selected_a_clock_evidence: Optional[SelectedAClockEvidence] = None,
    projection_bases: Optional[Sequence[SelectedCohortProjectionBasis]] = None,
) -> Optional[SelectedCohortProjection]:
    """Per-particle group rate draws for the selected-Cohort projection.

    Final projection owner for the cohort-maturity E+F rows. Consumes
    already-resolved runtime objects (`composed_carrier`, `composed_subject`)
    and the per-Cohort `engine_cohorts` rows; produces (S, T) rate draws
    for the row builder. Does NOT inspect raw evidence, re-bind,
    re-condition, decide primitive admissibility, special-case window
    vs cohort, collapse multi-hop subjects, produce primitive public
    moments, or become a general CF scalar source.

    Implements the **factorised Pop D / Pop C mass mechanics** specified
    in `docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
    §"Cohort semantics: cohort(A, X-Y)" and §"Window semantics: window(X-Y)".
    The earlier joint-A→end residual formulation (single H = p_car·p_subj·F_conv
    with one R_y per Cohort) collapsed the future fan because it conditioned
    the entire continuation on the **post-IS joint** surface; this helper
    replaces it with two-stream mass accounting on **factorised carrier and
    subject** surfaces, divided once at the end into Y/X.

    For each Cohort `d`, particle `s`, and τ > frontier_d:

      X_d_s(τ) = x_frozen_d                                   # window or A=X
                 + (a_pop_d − x_frozen_d) × R_carrier_s(τ)    # active A≠X

      Y_d_s(τ) = y_frozen_d
                 + (x_frozen_d − y_frozen_d) × R_subject_s(τ; A→X mix)  # Pop D
                 + (a_pop_d − x_frozen_d) × Conv_PopC_s(τ)              # Pop C

    Pop D = (x_frozen − y_frozen) frontier survivors already at X but not
    yet at the subject end. Their continuation is the **subject-only**
    calibrated CDF ratio integrated over the conditioned carrier arrival
    distribution before the frontier. Pop D members arrived at X *before*
    the frontier, so each arrival slice has its own subject-clock age at
    the frontier (`frontier − arrival_age`) and its own residual.

    Pop C = (a_pop − x_frozen) future arrivals at X. Their X-arrival is the
    conditional carrier residual past the frontier. Their Y-arrival is the
    convolution of carrier arrival increments with the **subject-only**
    progression CDF — Pop C members are FRESH at X on arrival, so the
    subject clock starts at zero per arrival and no `lag_d` is applied
    inside the convolution. In window mode (carrier identity) Pop C is
    empty by definition (later arrivals to X belong to later windows).

    Identity carrier (window or cohort A=X): `composed_carrier is None` ⇒
    no Pop C; the Pop D residual reduces to the standard calibrated
    subject-CDF ratio anchored at each Cohort's frontier.

    Bounds: X_d_s(τ) ≤ a_pop_d and Y_d_s(τ) ≤ a_pop_d × p_subject_s, so
    per-Cohort and aggregate rates lie in [0, 1] by construction.

    Returns per-particle denominator, numerator, and rate draws. Rate cells
    are NaN where X_total = 0 (undefined, not zero). Returns None when the
    substrate is moments-only or carrier in active mode is moments-only.
    """
    subject = runtime.composed_subject
    if subject is None or not subject.is_draw_coherent or subject.cdf_draws is None:
        return None
    if subject.span_p_draws is None:
        return None
    if not engine_cohorts:
        return None

    T = int(horizon) + 1
    p_subj = np.asarray(subject.span_p_draws, dtype=np.float64)
    S = p_subj.shape[0]

    F_subj = _pad_cdf_to_horizon(subject.cdf_draws, T, S)
    if F_subj is None:
        return None

    # Carrier surface: identity iff `population_root == denominator_node`
    # (window or cohort A=X — both have selected population already at X,
    # so `carrier_to_x` collapses to the identity per
    # COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md §"Cohort identity
    # case: A = X" and §"Window semantics"). The semantic test is
    # authoritative — if a composed_carrier object exists in window /
    # cohort(A=X) (e.g. from upstream construction), the reducer still
    # treats it as identity to honour the semantics doc.
    pop_root = runtime.population_root
    denom_node = runtime.denominator_node
    roots_equal_at_X = (
        pop_root is not None
        and denom_node is not None
        and str(pop_root) == str(denom_node)
    )
    carrier = runtime.composed_carrier
    if carrier is None or roots_equal_at_X:
        identity_carrier = True
        F_car = None
        p_car = None
        G = None
    else:
        if not carrier.is_draw_coherent or carrier.cdf_draws is None:
            return None
        if carrier.span_p_draws is None:
            return None
        p_car = np.asarray(carrier.span_p_draws, dtype=np.float64)
        if p_car.shape[0] != S:
            return None
        F_car = _pad_cdf_to_horizon(carrier.cdf_draws, T, S)
        if F_car is None:
            return None
        identity_carrier = False
        G = p_car[:, None] * F_car  # joint A→X reach (per particle, per τ)

    Y_total = np.zeros((S, T), dtype=np.float64)
    X_total = np.zeros((S, T), dtype=np.float64)
    _cohort_diags: List[Dict[str, Any]] = []

    # Pre-compute global per-particle subject-only joint conversion (Pop C
    # convolution kernel — unshifted, since arrivals start their subject
    # clock at u and progress through F_subj from there).
    H_subj_unshifted = p_subj[:, None] * F_subj  # (S, T)

    # Active-carrier arrival increments are reused by Pop D (pre-frontier
    # survivor mix). Pop C uses conditional post-frontier increments below.
    if not identity_carrier:
        car_pdf = np.clip(np.diff(F_car, axis=1, prepend=0.0), 0.0, 1.0)
        pair_cdf = _composed_pair_request_cdf_draws(
            subject,
            carrier,
            horizon=T - 1,
        )
        if pair_cdf is None:
            return None
    else:
        pair_cdf = None

    selected_prefixes: List[Optional[SelectedAClockCohortPrefix]] = []
    if (
        selected_a_clock_evidence is not None
        and cohort_list is not None
        and selected_a_clock_evidence.has_cells()
    ):
        selected_prefixes = selected_a_clock_evidence.prefixes_for_cohorts(
            cohort_list,
            horizon=horizon,
            use_retrieval_frontier=not identity_carrier,
        )

    # Seam invariant (docs/current/cohort-1apr-falling-k-problem-
    # statement.md A.4): in active mode the reducer's `x_frozen` /
    # `y_frozen` and the row builder's `aggregate_by_tau` must read
    # the SAME selected prefix object. When `selected_a_clock_evidence`
    # is provided, it is authoritative for every selected cohort; the
    # legacy `engine_cohort.obs_x/obs_y` fallback is refused to prevent
    # the seam from gapping.
    use_selected_evidence = (
        selected_a_clock_evidence is not None
        and selected_a_clock_evidence.has_cells()
    )
    for cohort_idx, ec in enumerate(engine_cohorts):
        projection_basis = (
            projection_bases[cohort_idx]
            if projection_bases is not None and cohort_idx < len(projection_bases)
            else None
        )
        selected_prefix = (
            selected_prefixes[cohort_idx]
            if cohort_idx < len(selected_prefixes)
            else None
        )
        if selected_prefix is not None:
            frontier = int(selected_prefix.frontier_age)
            x_frozen = float(selected_prefix.x_frozen)
            y_frozen = float(selected_prefix.y_frozen)
            obs_x = selected_prefix.obs_x
            obs_y = selected_prefix.obs_y
        elif use_selected_evidence:
            # Active mode but this anchor has no cells. Per the seam
            # invariant, we do NOT fall through to engine_cohort.obs_x/
            # obs_y (the legacy frame-derived path the active builder
            # explicitly supersedes). Instead, treat the cohort as
            # zero-prefix, frontier 0, and let the math project the
            # entire `a_pop` population from the prior via the existing
            # carrier × subject Pop C arm. Skipping the cohort here was
            # the previous behaviour and made the rate surface collapse
            # to NaN whenever no anchor had selected cells — even
            # though the cohort's `a_pop` is known and the conditioned
            # model curve is well-defined.
            frontier = 0
            x_frozen = 0.0
            y_frozen = 0.0
            obs_x = [0.0] * T
            obs_y = [0.0] * T
        else:
            frontier = int(ec.frontier_age)
            x_frozen = float(ec.x_frozen)
            y_frozen = float(ec.y_frozen)
            obs_x = ec.obs_x
            obs_y = ec.obs_y
        a_pop = float(getattr(ec, 'a_pop', 0.0) or 0.0)

        if projection_basis is not None and not projection_basis.has_observed_frontier:
            model_mass = max(float(projection_basis.model_mass or 0.0), 0.0)
            if model_mass <= 1e-12:
                _cohort_diags.append({
                    'i': cohort_idx,
                    'frontier': None,
                    'T': T,
                    'a_pop': round(a_pop, 2),
                    'x_frozen': round(x_frozen, 2),
                    'y_frozen': round(y_frozen, 2),
                    'skipped': True,
                    'reason': 'model_rate_basis_zero',
                    'model_mass_source': projection_basis.model_mass_source,
                    'from_selected': selected_prefix is not None,
                })
                continue
            if identity_carrier:
                X_total[:, :T] += model_mass
                Y_total[:, :T] += model_mass * H_subj_unshifted[:, :T]
            else:
                X_total[:, :T] += model_mass * G[:, :T]
                Y_total[:, :T] += (
                    model_mass
                    * p_car[:, None]
                    * p_subj[:, None]
                    * pair_cdf[:, :T]
                )
            _cohort_diags.append({
                'i': cohort_idx,
                'frontier': None,
                'T': T,
                'a_pop': round(a_pop, 2),
                'x_frozen': round(x_frozen, 2),
                'y_frozen': round(y_frozen, 2),
                'skipped': False,
                'reason': 'model_rate_basis_no_observed_frontier',
                'model_mass': round(model_mass, 4),
                'model_mass_source': projection_basis.model_mass_source,
                'identity_carrier': identity_carrier,
                'from_selected': selected_prefix is not None,
            })
            continue

        # Observed prefix — deterministic across particles.
        observed_end = min(frontier + 1, T)
        for tau in range(observed_end):
            ox = float(obs_x[tau]) if tau < len(obs_x) else x_frozen
            oy = float(obs_y[tau]) if tau < len(obs_y) else y_frozen
            Y_total[:, tau] += oy
            X_total[:, tau] += ox

        if frontier + 1 >= T:
            _cohort_diags.append({
                'i': cohort_idx, 'frontier': frontier, 'T': T,
                'a_pop': round(a_pop, 2), 'x_frozen': round(x_frozen, 2),
                'y_frozen': round(y_frozen, 2),
                'skipped': True, 'reason': 'frontier+1>=T',
                'from_selected': selected_prefix is not None,
            })
            continue

        future_len = T - frontier - 1
        future_slice = slice(frontier + 1, T)
        f_idx = min(max(frontier, 0), T - 1)

        # ── Pop D numerator (subject-only calibrated residual) ──────────
        # Pool D is the unconverted-at-frontier pool that progresses
        # through the subject hazard residual. Use observed `x_frozen`
        # (rather than `a_pop`) as the upper bound: the empirical `rate`
        # row field aggregates Σy/Σx with `obs_x` carry-forward past
        # the frontier, so the per-particle reducer must use the same
        # denominator basis to stay continuous across the epoch A→B
        # boundary. Substituting `a_pop` here was producing a vertical
        # cliff in the conditioned (E+F) midpoint at τ = tau_solid_max + 1
        # when real-data frames carry `a > x` for window cohorts (e.g.
        # multi-hop window where the frame's `a` and `x` accounting
        # diverge). The no-evidence degeneracy where `x_frozen == 0`
        # collapses Pop D to 0 — that case must be handled upstream
        # rather than by silently re-targeting the denominator here.
        pool_y_d = max(x_frozen - y_frozen, 0.0)
        if identity_carrier:
            H_subj_shift = H_subj_unshifted
            anchor_H = H_subj_shift[:, f_idx]
            future_H = H_subj_shift[:, future_slice]
            denom_H = 1.0 - anchor_H
            usable_H = denom_H > 1e-9
            inv_denom_H = np.where(
                usable_H, 1.0 / np.maximum(denom_H, 1e-9), 0.0,
            )
            R_y_d = np.clip(
                (future_H - anchor_H[:, None]) * inv_denom_H[:, None],
                0.0, 1.0,
            )
            Y_pop_d_future = pool_y_d * R_y_d  # (S, future_len)
        else:
            Y_pop_d_future = np.zeros((S, future_len), dtype=np.float64)
            if pool_y_d > 1e-12:
                arrival_idx = np.arange(f_idx + 1, dtype=np.int64)
                anchor_ages = f_idx - arrival_idx
                future_ages = (
                    np.arange(f_idx + 1, T, dtype=np.int64)[:, None]
                    - arrival_idx[None, :]
                )
                for s in range(S):
                    arrival_w = car_pdf[s, :f_idx + 1]
                    anchor_H = H_subj_unshifted[s, anchor_ages]
                    survivor_w = arrival_w * np.clip(
                        1.0 - anchor_H, 0.0, 1.0,
                    )
                    survivor_total = float(survivor_w.sum())
                    if survivor_total <= 1e-12:
                        continue
                    future_H = H_subj_unshifted[s, future_ages]
                    denom_H = np.maximum(1.0 - anchor_H, 1e-9)
                    R_by_arrival = np.clip(
                        (future_H - anchor_H[None, :]) / denom_H[None, :],
                        0.0,
                        1.0,
                    )
                    Y_pop_d_future[s] = (
                        pool_y_d
                        * (R_by_arrival @ survivor_w)
                        / survivor_total
                    )

        # ── Denominator side ────────────────────────────────────────────
        # Identity carrier: denominator past the frontier carries
        # `x_frozen` forward — the same observed-X mass the row builder
        # forward-fills into `ev_x_total` for the empirical `rate`.
        # Substituting `a_pop` here was producing a vertical cliff in
        # the conditioned (E+F) midpoint at τ = tau_solid_max + 1 when
        # real-data frames carry `a > x` for window cohorts: the
        # empirical rate row stayed at Σy/Σx ≈ y/x while the per-
        # particle reducer's denominator jumped to `a_pop`, snapping
        # the dotted midpoint downward at the boundary. The no-evidence
        # degeneracy (`x_frozen == 0`, `a_pop > 0`) must be handled
        # upstream rather than by silently re-targeting the denominator
        # here.
        if identity_carrier:
            X_total[:, future_slice] += x_frozen
            Y_pop_c_future = np.zeros((S, future_len), dtype=np.float64)
        else:
            anchor_G = G[:, f_idx]
            future_G = G[:, future_slice]
            denom_G = 1.0 - anchor_G
            usable_G = denom_G > 1e-9
            inv_denom_G = np.where(
                usable_G, 1.0 / np.maximum(denom_G, 1e-9), 0.0,
            )
            R_x = np.clip(
                (future_G - anchor_G[:, None]) * inv_denom_G[:, None],
                0.0, 1.0,
            )
            pool_x = max(a_pop - x_frozen, 0.0)
            X_total[:, future_slice] += x_frozen + pool_x * R_x

            # ── Pop C numerator (carrier ⊗ subject convolution) ─────────
            # arr_inc[s, k] = conditional fraction of Pop C arriving at X
            # at request τ = frontier+1+k = (G(τ) − G(τ−1))/(1 − G(frontier)).
            # Pop C members are FRESH at X on arrival ⇒ subject clock
            # starts at zero, so the convolution kernel is the UNSHIFTED
            # H_subj_unshifted (no lag offset).
            G_with_anchor = np.concatenate(
                [anchor_G[:, None], future_G], axis=1,
            )
            arr_inc = np.clip(
                np.diff(G_with_anchor, axis=1) * inv_denom_G[:, None],
                0.0, 1.0,
            )
            pool_c = max(a_pop - x_frozen, 0.0)
            Y_pop_c_future = np.zeros((S, future_len), dtype=np.float64)
            if pool_c > 1e-12:
                kernel = H_subj_unshifted[:, :future_len]
                for s in range(S):
                    full = np.convolve(arr_inc[s], kernel[s])[:future_len]
                    Y_pop_c_future[s] = pool_c * full

        _cohort_diags.append({
            'i': cohort_idx, 'frontier': frontier, 'T': T,
            'a_pop': round(a_pop, 2), 'x_frozen': round(x_frozen, 2),
            'y_frozen': round(y_frozen, 2),
            'skipped': False,
            'pool_y_d': round(pool_y_d, 2),
            'identity_carrier': identity_carrier,
            'Y_pop_d_med': round(float(np.median(Y_pop_d_future[:, -1])), 4),
            'Y_pop_c_med': round(float(np.median(Y_pop_c_future[:, -1])), 4),
            'from_selected': selected_prefix is not None,
        })
        Y_total[:, future_slice] += y_frozen + Y_pop_d_future + Y_pop_c_future

    _last_tau = T - 1
    _diag_summary: Dict[str, Any] = {
        'n_cohorts': len(engine_cohorts),
        'n_skipped': sum(1 for d in _cohort_diags if d.get('skipped')),
        'T': T, 'S': S,
        'identity_carrier': identity_carrier,
        'Y_total_last_med': round(float(np.median(Y_total[:, _last_tau])), 4),
        'X_total_last_med': round(float(np.median(X_total[:, _last_tau])), 4),
        'cohorts': _cohort_diags,
    }

    # Y / X with no X is undefined, not zero. NaN here lets the row
    # builder's quantile step (NaN-aware) skip such (s, τ) cells; if all
    # particles at a τ are NaN the row's midpoint/fan come back as None.
    with np.errstate(invalid='ignore', divide='ignore'):
        rate = np.where(
            X_total > 1e-12,
            Y_total / np.maximum(X_total, 1e-12),
            np.nan,
        )
    return SelectedCohortProjection(
        rate_draws=rate,
        x_draws=X_total,
        y_draws=Y_total,
        diagnostics=_diag_summary,
    )


def _runtime_completeness(
    runtime: ResolvedCFRuntime,
    *,
    cohort_eval_ages: Sequence[int],
    cohort_weights: Sequence[float],
    horizon: int,
) -> tuple[Optional[float], Optional[float]]:
    """N-weighted mean and SD of the request-rooted CDF at each cohort's
    observed frontier.

    Pulls completeness from the same composed CDF the row builder uses
    so the public scalar and the rendered curves stay coherent. Returns
    ``(None, None)`` if the runtime has no draw-coherent CDF or every
    cohort has zero weight.
    """
    if not cohort_eval_ages or not cohort_weights:
        return None, None
    cdf = _runtime_request_cdf_draws(runtime, horizon=horizon)
    if cdf is None:
        cdf_mean = (
            runtime.composed_subject.cdf_mean
            if runtime.composed_subject is not None else None
        )
        if cdf_mean is None:
            return None, None
        weights = np.asarray(cohort_weights, dtype=np.float64)
        wsum = float(weights.sum())
        if wsum <= 0:
            return None, None
        ages = np.asarray(cohort_eval_ages, dtype=np.int64)
        ages = np.clip(ages, 0, len(cdf_mean) - 1)
        per_cohort = cdf_mean[ages]
        return float((weights * per_cohort).sum() / wsum), 0.0

    weights = np.asarray(cohort_weights, dtype=np.float64)
    wsum = float(weights.sum())
    if wsum <= 0:
        return None, None
    ages = np.asarray(cohort_eval_ages, dtype=np.int64)
    ages = np.clip(ages, 0, cdf.shape[1] - 1)
    per_cohort_per_draw = cdf[:, ages]
    weighted_per_draw = (weights * per_cohort_per_draw).sum(axis=1) / wsum
    return float(weighted_per_draw.mean()), float(weighted_per_draw.std())


def _project_runtime_rows(
    *,
    runtime: ResolvedCFRuntime,
    evidence_by_tau: Dict[int, Dict],
    engine_cohorts: Sequence[Any],
    cohort_eval_ages: Sequence[int],
    cohort_weights: Sequence[float],
    max_tau: int,
    tau_solid_max: int,
    tau_future_max: int,
    sweep_to: str,
    band_level: float,
    selected_a_clock_evidence: Optional[SelectedAClockEvidence] = None,
    projection_bases: Optional[Sequence[SelectedCohortProjectionBasis]] = None,
    cohort_list: Optional[Sequence[Mapping[str, Any]]] = None,
    emit_diagnostics: bool = False,
) -> List[Dict[str, Any]]:
    """Build chart rows from the runtime's composed objects + observed
    evidence.

    Three composed surfaces feed the row schema:

      - ``midpoint`` / ``fan_*`` / ``fan_bands``: E+F mode — the
        joint-conditioned posterior. ``runtime.composed_subject`` and
        ``runtime.composed_carrier``.
      - ``model_midpoint`` / ``model_fan_*`` / ``model_bands``: F mode —
        the unconditioned ``predictive`` overlay (κ-inflated bands).
        ``runtime.unconditioned_overlays['predictive']``.
      - ``model_curve_midpoint`` / ``model_curve_*`` / ``model_curve_bands``:
        opt-in ``epistemic`` overlay (tight bands).
        ``runtime.unconditioned_overlays.get('epistemic')``. Absent when
        the caller did not request the model curve.

    No trajectory engine, no per-cohort IS splice — the request-scoped
    primitive registry has already conditioned everything that should
    move the rate."""
    band_levels = [0.80, 0.90, 0.95, 0.99]

    def _overlay_rate_draws(basis: str) -> Optional[np.ndarray]:
        overlay = runtime.unconditioned_overlays.get(basis)
        if overlay is None:
            return None
        return _composed_pair_per_tau_rate_draws(
            overlay.subject, overlay.carrier, horizon=max_tau,
        )

    # E+F draws come from the selected-Cohort projection — masses summed
    # across selected Cohorts, divided once per particle/age. The chart's
    # E+F surface is the projection of one resolved runtime object (73g
    # invariant 7); when the substrate cannot speak per-particle the row
    # builder emits None midpoint/fan rather than projecting a different
    # object.
    selected_projection = _selected_cohort_group_rate_draws(
        runtime,
        engine_cohorts,
        horizon=max_tau,
        cohort_list=cohort_list,
        selected_a_clock_evidence=selected_a_clock_evidence,
        projection_bases=projection_bases,
    )
    rate_draws = (
        selected_projection.rate_draws
        if selected_projection is not None else None
    )
    _selected_cohort_diag = (
        selected_projection.diagnostics
        if selected_projection is not None else None
    )
    pred_rate_draws = _overlay_rate_draws('predictive')
    epi_rate_draws = _overlay_rate_draws('epistemic')

    completeness_mean, completeness_sd = _runtime_completeness(
        runtime,
        cohort_eval_ages=cohort_eval_ages,
        cohort_weights=cohort_weights,
        horizon=max_tau,
    )
    p_infinity_mean = (
        runtime.public_moments.p_mean if runtime.public_moments else None
    )
    p_infinity_sd = (
        runtime.public_moments.p_sd if runtime.public_moments else None
    )
    p_infinity_sd_epistemic = (
        runtime.public_moments.p_sd_epistemic
        if runtime.public_moments else None
    )

    def _quantiles(draws_2d: Optional[np.ndarray], tau: int):
        if draws_2d is None or tau >= draws_2d.shape[1]:
            return None, None, None, None, None
        d = draws_2d[:, tau]
        # NaN cells flag (s, τ) where the rate is undefined (X_total = 0).
        # If every particle is NaN, the row contributes None; otherwise
        # the valid particles drive the per-τ quantiles.
        if not np.isfinite(d).any():
            return None, None, None, None, None
        mid = float(np.nanmedian(d))
        upper = float(np.nanquantile(d, (1 + band_level) / 2))
        lower = float(np.nanquantile(d, (1 - band_level) / 2))
        bands = {
            str(int(bl * 100)): [
                float(np.nanquantile(d, (1 - bl) / 2)),
                float(np.nanquantile(d, (1 + bl) / 2)),
            ]
            for bl in band_levels
        }
        return mid, upper, lower, bands, float(np.nanmean(d))

    def _draw_mean(draws_2d: Optional[np.ndarray], tau: int):
        if draws_2d is None or tau >= draws_2d.shape[1]:
            return None
        d = draws_2d[:, tau]
        if not np.isfinite(d).any():
            return None
        return float(np.nanmean(d))

    # Active cohort A!=X: evidence-named fields are populated only from
    # actual selected A-clock observations supplied by
    # selected_a_clock_evidence. Target-window frame prefixes remain
    # forbidden as substitutes. The per-particle reducer's midpoint/fan
    # stay projection-derived from composed carrier + subject surfaces.
    pop_root = runtime.population_root
    denom_node = runtime.denominator_node
    roots_equal_at_X = (
        pop_root is not None
        and denom_node is not None
        and str(pop_root) == str(denom_node)
    )
    is_active_carrier = (
        runtime.composed_carrier is not None
        and not roots_equal_at_X
    )
    # Admissible-cohort denominator for the coverage signal (design §2.2):
    # cohorts with positive a_pop. The formula is identical across active
    # and identity-carrier modes (window: a_pop comes from frame `dp.a`;
    # active: a_pop comes from `_root_window_carrier_n_by_anchor_day`). It
    # is intentionally NOT `len(engine_cohorts)` — that would include
    # zeroed-a_pop anchors and spuriously drop epoch-A coverage below 1.
    n_cohorts_in_scope = sum(
        1 for ec in engine_cohorts
        if float(getattr(ec, 'a_pop', 0.0) or 0.0) > 0.0
    )
    selected_evidence_by_tau = (
        selected_a_clock_evidence.aggregate_by_tau(
            tau_solid_max=tau_solid_max,
            max_tau=max_tau,
            n_cohorts_in_scope=n_cohorts_in_scope,
        )
        if selected_a_clock_evidence is not None
        and selected_a_clock_evidence.has_cells()
        else None
    )
    rows: List[Dict[str, Any]] = []
    for tau in range(max_tau + 1):
        # Evidence is read from the unified `selected_evidence_by_tau`
        # aggregate for both active and identity-carrier modes — the
        # `engine_cohorts.obs_x/obs_y` forward-fill loop that previously
        # drove window-mode evidence has been retired. Identity carrier
        # is data, not a route (canonical invariant 6): the carrier
        # observed surface is synthesised from the X-rooted subject
        # primitive in identity mode and composed via topology max-flow
        # in active mode; both feed `SelectedAClockEvidence.aggregate_by_tau`
        # identically. `engine_cohorts` continues to feed the reducer's
        # identity-carrier prefix and `a_pop` derivation (atom 3 retires
        # those residual responsibilities).
        projected_x = (
            _draw_mean(selected_projection.x_draws, tau)
            if selected_projection is not None else None
        )
        projected_y = (
            _draw_mean(selected_projection.y_draws, tau)
            if selected_projection is not None else None
        )

        # Coverage fields: design §3.2. Surface alongside evidence_x /
        # evidence_y as the chart's freshness signal — drives per-point
        # alpha attenuation in the FE companion (cohortComparisonBuilders
        # evidence-line series only, design §4.3). Numeric in [0, 1] for
        # any covered row; None only in the Absent state.
        evidence_x_coverage_tau: Optional[float] = None
        evidence_y_coverage_tau: Optional[float] = None
        coverage_tau: Optional[float] = None

        bucket = (
            selected_evidence_by_tau.get(tau)
            if selected_evidence_by_tau is not None else None
        )
        if bucket:
            sum_x = float(bucket.get('sum_x', 0.0) or 0.0)
            sum_y = float(bucket.get('sum_y', 0.0) or 0.0)
            if tau <= tau_solid_max:
                rate_x = sum_x
                pure_x = sum_x
            else:
                rate_x = float(
                    bucket.get('denominator_fe', sum_x)
                    if bucket.get('denominator_fe') is not None
                    else sum_x,
                )
                pure_x = float(
                    bucket.get('denominator_pure', sum_x)
                    if bucket.get('denominator_pure') is not None
                    else sum_x,
                )
            # Numeric (may be 0) whenever the bucket exists. Design
            # §3.1 covered-with-zero-mass: evidence_x = 0.0, not None.
            # The single Absent gate is "no bucket" (no cohort has any
            # cell at-or-before τ), preserved by the else branch.
            evidence_x_tau = rate_x
            evidence_y_tau = sum_y
            rate = sum_y / rate_x if rate_x > 0 else None
            rate_pure = sum_y / pure_x if pure_x > 0 else None
            n_mature = int(bucket.get('n_cohorts', 0) or 0)
            # Coverage = capped per-cohort share sum / admissible cohort
            # count (design §2.2). cohort_denom is positive whenever any
            # cohort has cells; min(1, sum/denom) caps against fixture
            # quirks where shares could exceed 1.
            cohort_denom = float(
                bucket.get('n_cohorts_in_scope', 0.0) or 0.0,
            )
            if cohort_denom > 0:
                sum_carrier_cov = float(
                    bucket.get('sum_carrier_coverage', 0.0) or 0.0,
                )
                sum_subject_cov = float(
                    bucket.get('sum_subject_coverage', 0.0) or 0.0,
                )
                evidence_x_coverage_tau = min(
                    1.0, sum_carrier_cov / cohort_denom,
                )
                evidence_y_coverage_tau = min(
                    1.0, sum_subject_cov / cohort_denom,
                )
                coverage_tau = min(
                    evidence_x_coverage_tau,
                    evidence_y_coverage_tau,
                )
            else:
                evidence_x_coverage_tau = 0.0
                evidence_y_coverage_tau = 0.0
                coverage_tau = 0.0
        else:
            evidence_x_tau = None
            evidence_y_tau = None
            rate = None
            rate_pure = None
            n_mature = 0

        midpoint, fan_upper_val, fan_lower_val, fan_bands, projected_rate = (
            _quantiles(rate_draws, tau)
        )
        model_midpoint, model_fan_upper, model_fan_lower, model_bands, _ = (
            _quantiles(pred_rate_draws, tau)
        )
        (
            model_curve_midpoint,
            model_curve_fan_upper,
            model_curve_fan_lower,
            model_curve_bands,
            _,
        ) = _quantiles(epi_rate_draws, tau)

        # forecast_y / forecast_x are future-only residuals per the
        # canonical chart contract (cohort-maturity-forecast-design.md,
        # project-db/2-time-series-charting.md, selected-a-clock-evidence-
        # clock-adapter-plan.md): the FE stacks `forecast_y` above
        # `evidence_y` as the "crown" component, and the tooltip surfaces
        # `forecast n=${forecast_x}, k=${forecast_y} (${rate})` where the
        # forecast rate is meaningful only when both are future-only.
        # Subtract observed evidence from both projection means so the
        # ratio is the conditioned future rate (and converges to
        # p_infinity at saturation when observation is rate-consistent).
        forecast_y_tau = projected_y if is_active_carrier else None
        forecast_x_tau = projected_x if is_active_carrier else None
        if (
            is_active_carrier
            and forecast_y_tau is not None
            and evidence_y_tau is not None
        ):
            forecast_y_tau = max(0.0, float(forecast_y_tau) - float(evidence_y_tau))
        if (
            is_active_carrier
            and forecast_x_tau is not None
            and evidence_x_tau is not None
        ):
            forecast_x_tau = max(0.0, float(forecast_x_tau) - float(evidence_x_tau))

        # Midpoint and fan emit across all epochs (A/B/C) so consumers
        # asserting the per-cohort calibrated E+F surface have values at
        # every τ. Display is owned by the chart layer: the FE filters
        # midpoint+fan draws to τ ≥ tau_solid_max so they only render in
        # epochs B/C where they actually add information (in A they
        # coincide with the solid E line and would double-draw).
        # Reducer emits everything it can compute; the chart picks.

        # E+F-mode E line: applicable-cohort coverage-blend of the
        # empirical rate with the unconditioned-predictive model curve.
        # Single uniform expression — epoch behaviours fall out as
        # algebraic limits, no per-epoch branching:
        #   applicable(τ) = cohorts whose tau_max >= τ
        #   coverage(τ)   = n_admissable_at_τ / applicable(τ), in [0, 1]
        #   blended(τ)    = empirical × coverage + model_midpoint × (1 − coverage)
        # Limits:
        #   coverage=1            → blended = empirical (epoch A all data;
        #                                              epoch B all-mature data)
        #   0 < coverage < 1      → mixed             (data hole in A;
        #                                              partial mature in B)
        #   coverage=0, applicable>0
        #                         → blended = model_midpoint (data hole everywhere)
        #   applicable=0          → blended = None    (epoch C — midpoint owns
        #                                              the curve)
        #
        # The empirical input to the blend is the per-cohort selected-Cohort
        # projection central value (Σ Y_c / Σ X_c with Pop D + Pop C
        # extensions per COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md
        # "Window semantics" / "Cohort semantics" factorised form), exposed
        # as `midpoint` in this scope. The forward-filled `rate`,
        # `rate_pure`, `evidence_x`, `evidence_y` are the E-mode / tooltip
        # empirical surfaces and are deliberately untouched by this block.
        # The reason `rate` is NOT used here:
        # - In window mode Pop C is empty by definition (semantics doc:
        #   "Later arrivals to X are outside the selected window() cohort").
        #   With no Pop C in the data and no Pop D applied to the row-builder
        #   forward-fill, `rate` plateaus past the frontier near
        #   subject_cdf(frontier) · span_p. For multi-hop window subjects the
        #   joint CDF rises slowly, so `rate ≈ span_p` (mature-saturated)
        #   sits *above* `model_midpoint = subject_cdf(τ) · span_p` (still
        #   climbing). Blending those two with cov < 1 produces a step
        #   downward at τ = tau_solid_max + 1 — a category mismatch between
        #   an asymptotic empirical and a trajectory model.
        # - The projection's `midpoint` adds the Pop D residual
        #   `(x_frozen − y_frozen) · R_subj(τ; frontier)` per cohort
        #   (semantics doc Window factorised form), extending the empirical
        #   onto the same `subject_cdf · span_p` trajectory the model lives
        #   on. The blend then mixes commensurate quantities.
        # - In epoch A every cohort is in the observed-prefix branch of the
        #   reducer (no Pop D / Pop C residual added), so per-particle
        #   Y_total/X_total reduces deterministically to Σ obs_y / Σ obs_x —
        #   numerically equal to `rate`. This block is therefore a no-op for
        #   epoch A in both window and cohort modes.
        # - In active cohort mode `rate` was already trajectory-tracking
        #   (via data-driven Pop C in `denominator_fe`); switching to
        #   `midpoint` here matches it to within particle-quantile noise and
        #   preserves the previously-correct epoch-B behaviour.
        # Falls back to `rate` only when the projection is unavailable.
        applicable_count_tau = sum(
            1 for c in (cohort_list or [])
            if int(c.get('tau_max', 0) or 0) >= tau
        )
        if applicable_count_tau <= 0:
            cov_for_blend: Optional[float] = None
        else:
            cov_for_blend = max(
                0.0, min(1.0, n_mature / applicable_count_tau),
            )

        empirical_for_blend: Optional[float] = (
            midpoint if midpoint is not None else rate
        )

        if cov_for_blend is None:
            rate_blended: Optional[float] = None
        elif empirical_for_blend is None:
            # Empirical undefined (zero-mass admissable set, e.g. covered
            # cohorts but x=0, and the projection is also unavailable).
            # Empirical contributes nothing; blend reduces to model.
            rate_blended = model_midpoint
        elif model_midpoint is None:
            rate_blended = empirical_for_blend
        else:
            rate_blended = (
                float(empirical_for_blend) * cov_for_blend
                + float(model_midpoint) * (1.0 - cov_for_blend)
            )

        rows.append({
            'tau_days': tau,
            'rate': rate,
            'rate_pure': rate_pure,
            'rate_blended': rate_blended,
            'applicable_coverage': cov_for_blend,
            'evidence_y': evidence_y_tau,
            'evidence_x': evidence_x_tau,
            'evidence_x_coverage': evidence_x_coverage_tau,
            'evidence_y_coverage': evidence_y_coverage_tau,
            'coverage': coverage_tau,
            'projected_rate': projected_rate,
            'forecast_y': forecast_y_tau,
            'forecast_x': forecast_x_tau,
            'midpoint': midpoint,
            'fan_upper': fan_upper_val,
            'fan_lower': fan_lower_val,
            'fan_bands': fan_bands,
            'model_midpoint': model_midpoint,
            'model_fan_upper': model_fan_upper,
            'model_fan_lower': model_fan_lower,
            'model_bands': model_bands,
            'model_curve_midpoint': model_curve_midpoint,
            'model_curve_fan_upper': model_curve_fan_upper,
            'model_curve_fan_lower': model_curve_fan_lower,
            'model_curve_bands': model_curve_bands,
            'tau_solid_max': tau_solid_max,
            'tau_future_max': tau_future_max,
            'boundary_date': str(sweep_to)[:10],
            'cohorts_covered_base': n_mature,
            'cohorts_covered_projected': n_mature,
            'completeness': completeness_mean,
            'completeness_sd': completeness_sd,
            'p_infinity_mean': p_infinity_mean,
            'p_infinity_sd': p_infinity_sd,
            'p_infinity_sd_epistemic': p_infinity_sd_epistemic,
        })
    if rows and _selected_cohort_diag is not None:
        rows[0]['_selected_cohort_projection'] = _selected_cohort_diag
    selected_evidence_diag = getattr(
        runtime,
        'selected_a_clock_evidence_diagnostics',
        None,
    )
    # The `_selected_a_clock_evidence` row block is forensic-only — large
    # enough to overflow V8's max string length on multi-hop active queries
    # and not consumed by the FE. Emit only with --diag.
    if emit_diagnostics and rows and (
        selected_a_clock_evidence is not None or selected_evidence_diag is not None
    ):
        def _surface_diag(surface: Optional[ObservedSpanEvidenceSurface]):
            if surface is None:
                return None
            return {
                'role': surface.role,
                'root_node': surface.root_node,
                'end_node': surface.end_node,
                'edge_ids': list(surface.edge_ids),
                'provenance': dict(surface.provenance),
            }

        cells_diag: List[Mapping[str, Any]] = []
        if selected_a_clock_evidence is not None:
            for anchor_day, tau_values in selected_a_clock_evidence.cells_by_anchor_day.items():
                for tau, cell in sorted(tau_values.items()):
                    cells_diag.append({
                        'anchor_day': anchor_day,
                        'tau': int(tau),
                        'x_at_query_x': float(cell.x_at_query_x),
                        'y_at_subject_end': float(cell.y_at_subject_end),
                        'source': cell.source,
                        'provenance': dict(cell.provenance),
                    })
        rate_attributed_dual_eval_by_edge: Mapping[str, Any] = {}
        if selected_a_clock_evidence is not None:
            raw = getattr(
                selected_a_clock_evidence,
                'rate_attributed_dual_eval_by_edge',
                {},
            ) or {}
            # JSON-safe shape: top-level edge_id, then anchor_day, then
            # branch name, then a list of {tau, value} pairs (smaller and
            # easier to consume than nested int-keyed dicts).
            rate_attributed_dual_eval_by_edge = {
                str(edge_id): {
                    str(anchor_day): {
                        str(branch): [
                            {'tau': int(t), 'value': float(v)}
                            for t, v in sorted(by_tau.items())
                        ]
                        for branch, by_tau in branches.items()
                    }
                    for anchor_day, branches in by_anchor.items()
                }
                for edge_id, by_anchor in raw.items()
            }
        rows[0]['_selected_a_clock_evidence'] = {
            'source': (
                selected_a_clock_evidence.source
                if selected_a_clock_evidence is not None
                else 'runtime_observed_span_evidence'
            ),
            'anchor_from': (
                selected_a_clock_evidence.anchor_from
                if selected_a_clock_evidence is not None else None
            ),
            'anchor_to': (
                selected_a_clock_evidence.anchor_to
                if selected_a_clock_evidence is not None else None
            ),
            'diagnostics': (
                dict(selected_evidence_diag)
                if isinstance(selected_evidence_diag, Mapping) else None
            ),
            'rate_attributed_dual_eval_by_edge': rate_attributed_dual_eval_by_edge,
            'carrier_surface': _surface_diag(
                getattr(runtime, 'observed_carrier_a_to_x', None),
            ),
            'subject_surface': _surface_diag(
                getattr(runtime, 'observed_subject_x_to_end', None),
            ),
            'cells': cells_diag,
        }
    return rows


# ═══════════════════════════════════════════════════════════════════════
# Shared evidence builder — used by both v3 chart and conditioned forecast
# ═══════════════════════════════════════════════════════════════════════

@dataclass
class FrameEvidence:
    """Intermediate evidence extracted from derived maturity frames.

    Produced by build_cohort_evidence_from_frames() and consumed by
    both the v3 chart builder (compute_cohort_maturity_rows_v3) and
    the conditioned forecast path.

    Design invariant: both consumers call compute_forecast_trajectory with
    the SAME engine_cohorts built from the SAME snapshot DB evidence.
    Public scalar moments are projected separately through ResolvedCFRuntime
    when primitive-backed moments are available; row trajectory fields do
    not force convergence to those scalar moments.
    """
    engine_cohorts: list           # List[CohortEvidence]
    cohort_list: List[Dict]        # sorted cohort_info dicts
    cohort_at_tau: Dict            # per-cohort tau observations
    evidence_by_tau: Dict          # aggregate evidence at each tau
    max_tau: int                   # display range (rows, chart x-axis)
    saturation_tau: int            # internal sweep horizon / fallback support
    tau_solid_max: int
    tau_future_max: int
    last_frame_date: Optional[_date] = None
    x_provider: Optional[Any] = None
    from_node_arrival: Optional[Any] = None
    carrier_tier: str = 'none'


def build_cohort_evidence_from_frames(
    frames: List[Dict[str, Any]],
    target_edge: Dict[str, Any],
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
    is_window: bool,
    resolved: Any,
    axis_tau_max: Optional[int] = None,
    *,
    is_active_carrier: bool = False,
) -> Optional[FrameEvidence]:
    """Build CohortEvidence from derived maturity frames.

    Shared between the v3 chart builder and the topo pass forecast
    sweep. Encapsulates: last-frame extraction, cohort_info, per-tau
    observation building, tau range computation, and materialisation of
    the observed prefix consumed by the shared sweep.

    Observed chart evidence remains the raw frame observations materialised
    onto engine cohorts. Carrier and subject-span semantics are resolved by
    the runtime substrate downstream; this builder must not rebuild an
    upstream carrier or patch row evidence to fit public scalar semantics.

    Returns None only when the request dates are malformed. If no
    observations bind to the selected semantic question, the builder still
    returns zero-observation cohorts so the general carrier/subject solve
    owns the no-evidence limit.
    """
    from .forecast_state import CohortEvidence

    try:
        anchor_from_d = _date.fromisoformat(str(anchor_from)[:10])
        anchor_to_d = _date.fromisoformat(str(anchor_to)[:10])
        sweep_to_d = _date.fromisoformat(str(sweep_to)[:10])
    except (ValueError, TypeError):
        return None

    lat = resolved.latency

    # ── Find last frame ────────────────────────────────────────────
    # DIAG: dump frame anchors to see what the FE/data-layer surfaces
    try:
        import json as _json
        frame_summary = []
        for f in frames[-3:]:
            sd = str(f.get('snapshot_date', ''))[:10]
            anchors = sorted({str(dp.get('anchor_day', ''))[:10] for dp in (f.get('data_points') or [])})
            frame_summary.append({'snapshot_date': sd, 'n_data_points': len(f.get('data_points') or []), 'anchors_first_10': anchors[:10], 'anchors_last_5': anchors[-5:] if len(anchors) > 10 else []})
        with open('/tmp/cov_frames.json', 'w') as _f:
            _json.dump({
                'n_frames': len(frames),
                'first_frame_date': str(frames[0].get('snapshot_date'))[:10] if frames else None,
                'last_frame_date': str(frames[-1].get('snapshot_date'))[:10] if frames else None,
                'last_3_frames': frame_summary,
                'anchor_from': str(anchor_from),
                'anchor_to': str(anchor_to),
            }, _f, indent=2)
    except Exception:
        pass
    last_frame = None
    last_frame_date: Optional[_date] = None
    for f in frames:
        sd_str = str(f.get('snapshot_date', ''))[:10]
        if sd_str and sd_str <= str(sweep_to)[:10]:
            last_frame = f
            try:
                last_frame_date = _date.fromisoformat(sd_str)
            except (ValueError, TypeError):
                pass

    # ── Build per-cohort info from last frame ──────────────────────
    cohort_info: Dict[str, Dict[str, Any]] = {}
    if last_frame and last_frame.get('data_points'):
        for dp in last_frame['data_points']:
            ad_str = str(dp.get('anchor_day', ''))[:10]
            try:
                ad = _date.fromisoformat(ad_str)
            except (ValueError, TypeError):
                continue
            if ad < anchor_from_d or ad > anchor_to_d:
                continue
            x_val = dp.get('x', 0)
            y_val = dp.get('y', 0)
            a_val = dp.get('a', 0)
            if not isinstance(x_val, (int, float)):
                x_val = 0
            if not isinstance(a_val, (int, float)) or a_val <= 0:
                a_val = max(x_val, 1)
            tau_max_c = (last_frame_date - ad).days if last_frame_date else 0
            cohort_info[ad_str] = {
                'x_frozen': float(x_val),
                'y_frozen': float(y_val) if isinstance(y_val, (int, float)) else 0.0,
                'a_frozen': float(a_val),
                'tau_max': max(tau_max_c, 0),
                'anchor_day': ad,
            }

    if not cohort_info:
        if anchor_from_d > anchor_to_d:
            return None
        ad = anchor_from_d
        while ad <= anchor_to_d:
            # Synthesised default: no frame data at all. tau_max is the
            # cohort's calendar age at sweep_to (the question the chart is
            # asking the model to answer). Setting tau_max=0 here would
            # collapse the "applicable at τ" set to zero for every τ>0 in
            # downstream consumers — making the no-evidence chart
            # degenerate to nothing. The right shape is: applicable
            # everywhere up to the cohort's calendar age, observations
            # nowhere (`tau_observed = -1` sentinel; engine_cohort build
            # propagates this as `frontier_age = -1`, which makes the
            # selected-cohort projection's observed-prefix loop iterate
            # zero times and the future arm cover the entire τ range
            # from τ=0 against the prior — natural Bayesian degeneracy).
            cohort_info[ad.isoformat()] = {
                'x_frozen': 0.0,
                'y_frozen': 0.0,
                'a_frozen': 1.0,
                'tau_max': max((sweep_to_d - ad).days, 0),
                'tau_observed': -1,
                'anchor_day': ad,
            }
            ad += _timedelta(days=1)

    # ── Build per-(cohort, τ) observations from all frames ─────────
    cohort_at_tau: Dict[str, Dict[int, tuple]] = defaultdict(dict)

    for f in frames:
        sd_str = str(f.get('snapshot_date', ''))[:10]
        for dp in (f.get('data_points') or []):
            ad_str = str(dp.get('anchor_day', ''))[:10]
            ci = cohort_info.get(ad_str)
            if ci is None:
                continue
            try:
                sd_d = _date.fromisoformat(sd_str)
                ad_d = _date.fromisoformat(ad_str)
            except (ValueError, TypeError):
                continue
            tau = (sd_d - ad_d).days
            if tau < 0:
                continue
            x_val = dp.get('x')
            y_val = dp.get('y')
            if not isinstance(x_val, (int, float)) or x_val <= 0:
                continue
            if not isinstance(y_val, (int, float)) or y_val is None:
                continue
            cohort_at_tau[ad_str][tau] = (
                float(x_val),
                float(y_val),
                dp.get('data_retrieved_at'),
            )

    # evidence_by_tau is built after engine_cohorts so row projection reads
    # the same materialised observed series the trajectory consumes.

    # ── tau_observed per cohort ────────────────────────────────────
    # Canonical formula (DATE_MODEL_COHORT_MATURITY.md §2.3):
    #   tau_observed = min(
    #       max((data_retrieved_at − anchor_day).days
    #           for cells with non-null provenance),
    #       tau_max,
    #   )
    # The per-cell `data_retrieved_at` is the min-across-contributing-
    # slices timestamp produced by cohort_maturity_derivation.py:185-193
    # (conservative least-recent contributor). Per-cohort reduction is
    # the max over that cohort's cells. Forbidden: `last_frame_date −
    # anchor_day` is an alias for `(sweep_to − anchor_to)`, which §2.2
    # of the canonical doc explicitly forbids as a frontier proxy. The
    # no-provenance fallback below is a documented LOSSY lower-bound
    # (see cohort-maturity-frontier-from-data-retrieved-at.md §6).
    for ad_str, ci in cohort_info.items():
        ad_d = ci['anchor_day']
        cells = cohort_at_tau.get(ad_str, {})
        tau_obs = 0
        provenance_seen = False
        for cell in cells.values():
            ret_str = cell[2] if len(cell) >= 3 else None
            if not ret_str:
                continue
            try:
                ret_d = _date.fromisoformat(str(ret_str)[:10])
            except (ValueError, TypeError):
                continue
            provenance_seen = True
            delta = (ret_d - ad_d).days
            if delta > tau_obs:
                tau_obs = delta
        if not provenance_seen and cells:
            # Lossy lower-bound: largest τ where y strictly exceeds the
            # previous y in τ order (treating the implicit pre-first-
            # cell baseline as 0). Documented failure modes:
            #   - all-zero-y cohorts return 0 (frontier under-stated)
            #   - post-conversion plateaus return τ of last conversion,
            #     not τ of last retrieval
            # Both bite covered-zero cohorts. Audit B confirms
            # data_retrieved_at is preserved end-to-end in production;
            # this branch is defensive cover for malformed inputs only.
            prev_y = 0.0
            for tau_c in sorted(cells.keys()):
                y_c = float(cells[tau_c][1])
                if y_c > prev_y and tau_c > tau_obs:
                    tau_obs = tau_c
                prev_y = y_c
        # Empty-frames synthesis sets `tau_observed: -1` upstream as a
        # "no observations recorded" sentinel; with no cells to derive
        # from, preserve that sentinel so the engine_cohort build keeps
        # `frontier_age = -1`. Only overwrite when there is observation
        # signal (cells present) to update from.
        if cells or 'tau_observed' not in ci:
            ci['tau_observed'] = min(tau_obs, ci['tau_max'])

    # ── Build cohort_list and epoch boundaries ─────────────────────
    # tau_solid_max  : right edge of epoch A — the largest τ where every
    #                  selected Cohort is still observed. By definition this
    #                  is min(frontier_age) across cohorts (the shallowest
    #                  observed depth among the selected set). Using the
    #                  youngest cohort's frontier is wrong under per-cohort
    #                  staleness: an older cohort whose data hasn't been
    #                  refreshed lately can have a shallower real frontier
    #                  than the youngest, and the seam-collapse property of
    #                  the projection only holds at min(frontier).
    # tau_future_max : right edge of epoch B — calendar age of the oldest
    #                  cohort up to sweep_to. Owns the chart's epoch
    #                  boundary AND the _evidence_display_at_tau censor;
    #                  must NOT be coupled to per-cohort data_retrieved_at
    #                  (which can lag for individual anchors and would
    #                  invert the tau_solid_max ≤ tau_future_max invariant
    #                  the row builder and chart both rely on).
    cohort_list = sorted(cohort_info.values(), key=lambda c: c['anchor_day'])
    tau_solid_max = 0
    tau_future_max = max(0, (sweep_to_d - anchor_from_d).days)
    if cohort_list:
        tau_solid_max = min(
            int(c.get('tau_observed', c['tau_max']) or 0)
            for c in cohort_list
        )
    tau_future_max = max(tau_future_max, tau_solid_max)

    # ── Determine tau ranges ───────────────────────────────────────
    # max_tau         : display/row range — drives chart x-axis (unchanged).
    # saturation_tau  : internal sweep horizon — extends to 2*t95 (window)
    #                   or 2*path_t95 (cohort) so trajectory evaluation and
    #                   legacy scalar fallback have adequate support. It is
    #                   not a row-projection contract that midpoint equals
    #                   the public p_infinity scalar.
    #                   May exceed max_tau when path-level latency dominates
    #                   A→Y timing (cohort mode, multi-hop).
    max_tau = tau_future_max
    if axis_tau_max is not None and axis_tau_max > max_tau:
        max_tau = axis_tau_max
    if lat.sigma > 0:
        try:
            from .lag_distribution_utils import log_normal_inverse_cdf
            t95 = log_normal_inverse_cdf(
                0.95,
                lat.mu,
                lat.sigma,
            ) + lat.onset_delta_days
            max_tau = max(max_tau, int(math.ceil(t95)))
        except Exception:
            pass
    max_tau = min(max_tau, 400)

    saturation_tau = max_tau
    if lat.sigma > 0:
        try:
            from .lag_distribution_utils import log_normal_inverse_cdf
            mu_s, sigma_s, onset_s = lat.mu, lat.sigma, lat.onset_delta_days
            if not is_window:
                # Cohort mode: fallback scalar support needs the path-level
                # A→Y horizon, not the edge-local one. Re-resolve with
                # scope='path' because build_cohort_evidence receives
                # `resolved` from an earlier scope='edge' call (so
                # resolved.path_latency is None on this side).
                try:
                    path_resolved = resolve_model_params(
                        target_edge,
                        scope='path',
                        temporal_mode='cohort',
                    )
                    pl = (
                        getattr(path_resolved, 'path_latency', None)
                        if path_resolved
                        else None
                    )
                    if pl is not None and pl.sigma > 0:
                        mu_s, sigma_s, onset_s = (
                            pl.mu,
                            pl.sigma,
                            pl.onset_delta_days,
                        )
                except Exception:
                    pass
            t95_sat = log_normal_inverse_cdf(0.95, mu_s, sigma_s) + onset_s
            saturation_tau = max(saturation_tau, int(math.ceil(2.0 * t95_sat)))
        except Exception:
            pass
    saturation_tau = min(saturation_tau, 400)

    # Frame evidence is raw observed chart evidence only. Active A!=X
    # carrier semantics are owned by the primitive-backed runtime span;
    # this builder must not construct a carrier or alter public scalars.
    from_node_arrival = None
    carrier_tier = 'none'

    engine_cohorts: list = []
    materialised_cohort_list: List[Dict[str, Any]] = []
    for ci in cohort_list:
        raw_n_i = float(ci.get('x_frozen', 0.0) or 0.0)
        a_i = int(ci.get('tau_observed', ci['tau_max']) or 0)
        # Upper-bound clamp only — preserve the `tau_observed = -1`
        # sentinel (set by build_cohort_evidence_from_frames's empty-
        # frames synthesis) which encodes "no observations recorded".
        # Under that sentinel, `frontier_age = -1` propagates into the
        # selected-cohort projection: the observed-prefix loop iterates
        # zero times and the future arm covers τ=0..T-1 against the
        # prior, producing the natural Bayesian degeneracy. Loops below
        # gated on `t <= a_i` skip cleanly when a_i is -1.
        a_i = min(a_i, saturation_tau)
        a_pop = float(ci.get('a_frozen', raw_n_i) or raw_n_i or 1.0)
        ad_str = ci['anchor_day'].isoformat()
        tau_data = cohort_at_tau.get(ad_str, {})

        raw_obs_x = [0.0] * (saturation_tau + 1)
        raw_obs_y = [0.0] * (saturation_tau + 1)
        last_x = raw_n_i if is_window else 0.0
        last_y = 0.0
        for t in range(saturation_tau + 1):
            if t <= a_i:
                obs = tau_data.get(t)
                if obs:
                    last_x = float(obs[0])
                    last_y = float(obs[1])
                elif is_window:
                    last_x = raw_n_i
                raw_obs_x[t] = last_x
                raw_obs_y[t] = last_y
            else:
                raw_obs_x[t] = last_x if last_x > 0 else raw_n_i
                raw_obs_y[t] = last_y

        # Active cohort A!=X: window-prepared target frames are X-clocked
        # and must not seed selected A-clock observed prefixes. Exact
        # A-clock observed-prefix pinning is separate future work; keep
        # observed prefixes empty so model projection cannot masquerade
        # as evidence.
        if is_active_carrier:
            raw_obs_x = [0.0] * (saturation_tau + 1)
            raw_obs_y = [0.0] * (saturation_tau + 1)
            a_i = 0

        obs_x = raw_obs_x
        obs_y = raw_obs_y
        x_frozen = float(obs_x[a_i]) if a_i < len(obs_x) else (
            0.0 if is_active_carrier else raw_n_i
        )
        y_frozen = float(obs_y[a_i]) if a_i < len(obs_y) else (
            0.0 if is_active_carrier else float(ci.get('y_frozen', 0.0) or 0.0)
        )
        evidence_n = x_frozen
        evidence_k = y_frozen

        ci_materialised = dict(ci)
        ci_materialised['x_frozen'] = x_frozen
        ci_materialised['y_frozen'] = y_frozen
        ci_materialised['evidence_n'] = evidence_n
        ci_materialised['evidence_k'] = evidence_k
        materialised_cohort_list.append(ci_materialised)

        engine_cohorts.append(CohortEvidence(
            obs_x=obs_x,
            obs_y=obs_y,
            x_frozen=x_frozen,
            y_frozen=y_frozen,
            frontier_age=a_i,
            a_pop=a_pop,
            evidence_n=evidence_n,
            evidence_k=evidence_k,
            # Doc 45 §Response contract: the CF endpoint and the
            # cohort maturity chart share this engine. Setting
            # eval_age = frontier_age tells compute_forecast_trajectory to
            # populate `sweep.completeness_mean` / `completeness_sd`
            # (n-weighted CDF across cohorts at their own frontiers).
            # Without this, the sweep leaves those fields None and
            # downstream consumers (the CF endpoint, maturity rows)
            # have nothing to report — the exact gap that let
            # completeness go AWOL end-to-end.
            #
            # `eval_age` is clamped to >= 0 because completeness "at
            # frontier" is undefined when there is no frontier
            # (`frontier_age == -1` under empty-frames synthesis).
            # Splitting `frontier_age` (may be -1) from `eval_age`
            # (always >= 0) lets the projection's observed-prefix
            # logic see the no-observations sentinel while the
            # completeness consumer still gets a valid age to
            # evaluate against.
            eval_age=max(a_i, 0),
        ))

    if not engine_cohorts:
        return None

    # ── Aggregate evidence_by_tau from engine_cohorts ──────────────
    # Both sum_x and sum_y are observed values drawn from the engine
    # cohorts' obs_x / frame y at each recorded tau. n_cohorts counts
    # cohorts that reported a real observation at this tau.
    evidence_by_tau: Dict[int, Dict] = {}
    for ci, engine_cohort in zip(materialised_cohort_list, engine_cohorts):
        ad_str = ci['anchor_day'].isoformat()
        for tau in cohort_at_tau.get(ad_str, {}):
            if tau < 0 or tau > saturation_tau:
                continue
            bucket = evidence_by_tau.setdefault(
                int(tau),
                {'sum_y': 0.0, 'sum_x': 0.0, 'n_cohorts': 0},
            )
            if tau < len(engine_cohort.obs_x):
                bucket['sum_x'] += float(engine_cohort.obs_x[tau])
            else:
                bucket['sum_x'] += float(engine_cohort.x_frozen)
            if tau < len(engine_cohort.obs_y):
                bucket['sum_y'] += float(engine_cohort.obs_y[tau])
            else:
                bucket['sum_y'] += float(engine_cohort.y_frozen)
            bucket['n_cohorts'] += 1

    return FrameEvidence(
        engine_cohorts=engine_cohorts,
        cohort_list=materialised_cohort_list,
        cohort_at_tau=dict(cohort_at_tau),
        evidence_by_tau=evidence_by_tau,
        max_tau=max_tau,
        saturation_tau=saturation_tau,
        tau_solid_max=tau_solid_max,
        tau_future_max=tau_future_max,
        last_frame_date=last_frame_date,
        x_provider=None,
        from_node_arrival=from_node_arrival,
        carrier_tier=carrier_tier,
    )


def compute_cohort_maturity_rows_v3(
    frames: List[Dict[str, Any]],
    graph: Dict[str, Any],
    target_edge_id: str,
    query_from_node: str,
    query_to_node: str,
    anchor_from: str,
    anchor_to: str,
    sweep_to: str,
    is_window: bool = True,
    axis_tau_max: Optional[int] = None,
    band_level: float = 0.90,
    anchor_node_id: Optional[str] = None,
    is_multi_hop: bool = False,
    resolved_override: Any = None,
    evidence_candidates: Optional[List[Any]] = None,
    scenario_id: Optional[str] = None,
    as_at: Optional[str] = None,
    per_edge_upstream_candidates: Optional[Dict[str, Sequence[Any]]] = None,
    per_edge_subject_candidates: Optional[Dict[str, Sequence[Any]]] = None,
    per_edge_results_by_uuid: Optional[Dict[str, Dict[str, Any]]] = None,
    show_model_curve: bool = False,
    emit_diagnostics: bool = False,
    envelope_plan: Optional[Any] = None,
) -> List[Dict[str, Any]]:
    """Compute per-tau rows for the cohort_maturity v3 chart.

    The row builder is a thin readout of ``ResolvedCFRuntime`` — the one
    request-scoped object that owns conditioning, composition, and
    projection. There is no trajectory-engine call from this path: the
    primitive registry has already conditioned every parameterised edge
    and the span composers have already produced
    ``span_p_draws`` / ``cdf_draws`` for both the carrier (A→X) and the
    subject (X→end). Window and cohort(A=X) are identity-carrier data
    cases of the same object; active cohort uses a real composed
    carrier convolved with the subject CDF.

    When the runtime cannot build a draw-coherent composition the public
    fields are left ``None`` and the row marks itself as degraded; this
    function never substitutes legacy aggregate timing or runs an
    aggregate-IS conditioning step.
    """
    from .forecast_runtime import find_edge_by_id, get_cf_mode_and_reason

    target_edge = find_edge_by_id(graph, target_edge_id)
    if target_edge is None:
        return []

    # ── Resolve model params ────────────────────────────────────────
    # Default: edge-level. ``resolved_override`` carries collapsed
    # shortcuts (e.g. path latency + edge p for multi-hop subjects).
    if resolved_override is not None:
        resolved = resolved_override
    else:
        temporal = 'window' if is_window else 'cohort'
        resolved = resolve_model_params(
            target_edge,
            scope='edge',
            temporal_mode=temporal,
        )
    if not resolved:
        return []
    _cf_mode, _cf_reason = get_cf_mode_and_reason(resolved)

    # ── Observed evidence display (raw frame observation only) ──────
    # The frame evidence carries the chart's per-(τ) observed series and
    # the per-cohort eval ages used for completeness. Carrier reach,
    # subject span, and asymptotic rates come from the runtime, not from
    # this object.
    _is_active_carrier = (
        not is_window
        and bool(anchor_node_id)
        and bool(query_from_node)
        and str(anchor_node_id) != str(query_from_node)
    )
    fe = build_cohort_evidence_from_frames(
        frames=frames,
        target_edge=target_edge,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        sweep_to=sweep_to,
        is_window=is_window,
        resolved=resolved,
        axis_tau_max=axis_tau_max,
        is_active_carrier=_is_active_carrier,
    )
    if fe is None:
        return []

    # 73g §1: one general forecast machinery path. Build a single
    # request-level candidate pool from every parameterised primitive
    # in the request topology — target subject, non-target subject
    # edges, and carrier edges. Per-primitive merge in the readout
    # filters by ``(subject_from, subject_to)`` naturally, so a single
    # pool is correct: each primitive sees only its own rows by
    # subject identity, then admits or rejects them by its local
    # arrival-weight clock support. This avoids the
    # target-vs-carrier branch the readout would otherwise need.
    #
    # The per-edge candidate dicts feed raw candidate material directly
    # into one request pool. Per-primitive merge in the readout is the
    # only authoritative merge/binding boundary.
    request_candidates = _aggregate_request_candidates(
        target_candidates=evidence_candidates,
        per_edge_subject_candidates=per_edge_subject_candidates,
        per_edge_upstream_candidates=per_edge_upstream_candidates,
    )

    runtime = build_resolved_cf_runtime(
        graph=graph,
        target_edge_id=str(target_edge_id),
        query_from_node=str(query_from_node),
        query_to_node=str(query_to_node),
        anchor_from=str(anchor_from or ''),
        anchor_to=str(anchor_to or anchor_from or ''),
        sweep_to=str(sweep_to or anchor_from or ''),
        as_at=as_at,
        scenario_id=scenario_id,
        is_window=is_window,
        is_multi_hop=is_multi_hop,
        anchor_node_id=anchor_node_id,
        resolved=resolved,
        evidence_candidates=request_candidates,
        legacy_p_mean=None,
        legacy_p_sd=None,
        legacy_p_sd_epistemic=None,
        unconditioned_overlay_bases=(
            ('predictive', 'epistemic') if show_model_curve else ('predictive',)
        ),
        envelope_plan=envelope_plan,
    )
    if runtime is None:
        return []

    # Active-cohort base population (a_pop) per anchor day must be
    # available BEFORE the selected A-clock evidence builder runs —
    # the new dual-prefix builder (docs/current/cohort-1apr-falling-k-
    # problem-statement.md A.6 phase 1) consumes N_cohort(C) for both
    # the X_prefix amplitude and the M_select(X, C, u) mass surface.
    # The frame-bundle 'a' value is not consulted for active; anchors
    # without admissible root-window evidence get a_pop = 0 and are
    # excluded from the active projection.
    a_pop_provenance: Dict[str, str] = {}
    n_by_anchor: Dict[str, float] = {}
    # Source N_cohort per anchor day from any candidate whose
    # `subject_from` is the population root. For active `cohort(A!=X)`
    # the matching candidates are the carrier (A-rooted upstream) edges;
    # for identity carrier (`window()` or `cohort(A=X)`) the matching
    # candidate is the X-rooted subject primitive itself — A == X so
    # there is no separate upstream carrier. Same function, same filter,
    # different sub-object degenerates as a property of the data
    # (sub-stage 2b natural-degeneracy framing).
    _pop_root_for_lookup = (
        str(runtime.population_root)
        if getattr(runtime, 'population_root', None)
        else anchor_node_id
    )
    _combined_candidates: Dict[str, Any] = {}
    if per_edge_upstream_candidates:
        _combined_candidates.update(per_edge_upstream_candidates)
    if per_edge_subject_candidates:
        _combined_candidates.update(per_edge_subject_candidates)
    if fe.engine_cohorts:
        n_by_anchor = _root_window_carrier_n_by_anchor_day(
            _combined_candidates,
            _pop_root_for_lookup,
        )
    if _is_active_carrier and fe.engine_cohorts:
        for ec, ci in zip(fe.engine_cohorts, fe.cohort_list):
            ad = ci.get('anchor_day')
            if ad is None:
                ec.a_pop = 0.0
                continue
            ad_str = (
                ad.isoformat() if hasattr(ad, 'isoformat') else str(ad)[:10]
            )
            n_root = n_by_anchor.get(ad_str)
            if n_root is not None and n_root > 0:
                ec.a_pop = float(n_root)
                a_pop_provenance[ad_str] = 'root_window_carrier_n'
            elif int(ci.get('tau_observed', 0) or 0) < 0:
                # Empty-frames synthesis (`tau_observed = -1` sentinel):
                # no frames at all, no expectation of root-window carrier
                # evidence either. Preserve the synthesised `a_pop = 1.0`
                # so the projection produces the natural Bayesian
                # degeneracy (posterior = prior) — i.e. the unconditioned
                # carrier × subject convolution at unit population. The
                # zero-fallback below only fires when frames ARE present
                # but root-window evidence is absent, which is the case
                # the seam invariant excludes from the active projection.
                a_pop_provenance[ad_str] = 'empty_frames_prior'
            else:
                # No admissible root-window carrier evidence for this
                # anchor day under non-empty frames. The frame-bundle 'a'
                # is not an admissible fallback (Phase 3 implementation
                # plan); zero the cohort's base mass so the active
                # projection excludes it and the downstream sum collapses
                # correctly.
                ec.a_pop = 0.0
                a_pop_provenance[ad_str] = 'no_root_window_evidence'

    # Resolve the runtime-level selected source-day mass surface
    # before the display path runs. Per docs/current/cohort-1apr-
    # falling-k-problem-statement.md A.6 phase 1: M_select(U, C, u)
    # is a runtime-resolved object — populated during runtime
    # construction (here, post-`build_resolved_cf_runtime` because
    # `n_by_anchor` is not available earlier). One uniform construction
    # over every subject primitive source node U, including U = X as
    # the natural carrier-only degeneracy of the same A-rooted
    # composer call (§10, A.1, A.6 phase 1). The projection layer
    # never invents or mutates this surface — it reads from
    # `runtime.selected_source_day_mass`.
    # Prefix construction fires whenever we have a per-anchor-day base
    # mass — active and identity carrier flow through the same gate;
    # `_build_selected_source_day_mass` handles the chain-of-length-0
    # carrier composition (A→X is identity in window/cohort(A=X)) as a
    # natural degeneracy of the same A-rooted composer call.
    if n_by_anchor:
        anchor_day_keys = _selected_anchor_day_keys(
            fe.cohort_list,
            anchor_from=anchor_from,
            anchor_to=anchor_to,
        )
        subject_primitives = _runtime_primitives_for_role(runtime, 'subject')
        runtime.selected_source_day_mass = _build_selected_source_day_mass(
            runtime=runtime,
            anchor_days=anchor_day_keys,
            n_cohort_by_anchor=n_by_anchor,
            subject_primitives=subject_primitives,
            max_tau=int(fe.max_tau),
        )
        runtime.selected_x_prefix = _build_carrier_only_denominator_prefix(
            runtime=runtime,
            anchor_days=anchor_day_keys,
            n_cohort_by_anchor=n_by_anchor,
            max_tau=int(fe.max_tau),
        )

    # The mode-agnostic builder produces SelectedAClockEvidence for
    # active and identity-carrier (window or cohort(A=X)) runtimes
    # uniformly. The row builder consumes this object for both modes;
    # `engine_cohorts` continues to feed the reducer's identity-carrier
    # prefix and the `a_pop` derivation (atom 3 retires the residual
    # responsibilities).
    selected_a_clock_evidence = _build_selected_a_clock_evidence_from_runtime(
        runtime,
        cohort_list=fe.cohort_list,
        anchor_from=anchor_from,
        anchor_to=anchor_to,
        max_tau=fe.max_tau,
        emit_diagnostics=emit_diagnostics,
    )

    row_tau_solid_max = int(fe.tau_solid_max)
    if _is_active_carrier and selected_a_clock_evidence is not None:
        selected_tau_solid = selected_a_clock_evidence.min_frontier_tau(
            fe.cohort_list,
            use_retrieval_frontier=True,
        )
        if selected_tau_solid is not None:
            row_tau_solid_max = int(selected_tau_solid)

    if _is_active_carrier:
        # Active completeness inputs read selected A-clock prefixes
        # directly. `CohortEvidence` remains the zero-prefix placeholder
        # for active model projection, so exact selected observations do
        # not disappear behind mutated legacy fields.
        cohort_eval_ages = []
        cohort_weights = []
        selected_prefixes = (
            selected_a_clock_evidence.prefixes_for_cohorts(
                fe.cohort_list,
                horizon=fe.saturation_tau,
                use_retrieval_frontier=True,
            )
            if selected_a_clock_evidence is not None
            and selected_a_clock_evidence.has_cells()
            else []
        )
        for idx, (ec, _ci) in enumerate(zip(fe.engine_cohorts, fe.cohort_list)):
            prefix = (
                selected_prefixes[idx]
                if idx < len(selected_prefixes)
                else None
            )
            # Read `eval_age` on the engine_cohort fallback (always >= 0
            # by construction) rather than `frontier_age`, which carries
            # the `-1` "no observations recorded" sentinel under empty-
            # frames synthesis. Completeness "at frontier" is undefined
            # when there is no frontier, so the consumer needs a >= 0
            # age. The active-prefix path is unaffected (prefix.frontier_age
            # is built from real selected-row data) but the read is
            # clamped defensively.
            cohort_eval_ages.append(
                max(int(prefix.frontier_age if prefix is not None else (
                    getattr(ec, 'eval_age', getattr(ec, 'frontier_age', 0)) or 0
                )), 0),
            )
            cohort_weights.append(
                float(getattr(ec, 'a_pop', 0.0) or 0.0),
            )
    else:
        # Clamp to >= 0 — `tau_observed = -1` is the empty-frames "no
        # observations recorded" sentinel; completeness eval needs a
        # valid age. See engine_cohort `eval_age = max(a_i, 0)` above.
        cohort_eval_ages = [
            max(int(c.get('tau_observed', c.get('tau_max', 0)) or 0), 0)
            for c in fe.cohort_list
        ]
        cohort_weights = [
            float(c.get('evidence_n', c.get('x_frozen', 0.0)) or 0.0)
            for c in fe.cohort_list
        ]

    projection_bases = _build_selected_cohort_projection_bases(
        engine_cohorts=fe.engine_cohorts,
        cohort_list=fe.cohort_list,
        is_active_carrier=_is_active_carrier,
        a_pop_provenance=a_pop_provenance,
        selected_a_clock_evidence=selected_a_clock_evidence,
    )

    rows = _project_runtime_rows(
        runtime=runtime,
        evidence_by_tau=fe.evidence_by_tau,
        engine_cohorts=fe.engine_cohorts,
        cohort_list=fe.cohort_list,
        cohort_eval_ages=cohort_eval_ages,
        cohort_weights=cohort_weights,
        max_tau=fe.max_tau,
        tau_solid_max=row_tau_solid_max,
        tau_future_max=fe.tau_future_max,
        sweep_to=sweep_to,
        band_level=band_level,
        selected_a_clock_evidence=selected_a_clock_evidence,
        projection_bases=projection_bases,
        emit_diagnostics=emit_diagnostics,
    )

    rows = _attach_cf_row_metadata(
        rows,
        conditioning={'owner': 'primitive_conditioning'},
        conditioned=runtime.public_moments.p_mean is not None,
        cf_mode=_cf_mode,
        cf_reason=_cf_reason,
        runtime_provenance=runtime.project_runtime_provenance(),
    )
    if a_pop_provenance and rows:
        rows[0]['_a_pop_provenance'] = a_pop_provenance
    if rows:
        rows[0]['_projection_basis'] = [
            {
                'anchor_day': basis.anchor_day,
                'has_observed_frontier': basis.has_observed_frontier,
                'model_mass': basis.model_mass,
                'model_mass_source': basis.model_mass_source,
                'provenance': dict(basis.provenance),
            }
            for basis in projection_bases
        ]
    return rows
