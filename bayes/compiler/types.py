"""
Compiler intermediate representations — pure Python dataclasses.

Two-tier IR:
  1. TopologyAnalysis — structural decomposition of the graph
  2. BoundEvidence — evidence mapped to the topology

Both are JSON-serialisable, deterministic, and engine-independent.
Only build_model() (in model.py) imports PyMC.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ESS_CAP = 500           # Max effective sample size for warm-start prior
MIN_N_THRESHOLD = 10    # Edges below this get prior-only treatment
HDI_PROB = 0.90

# Sampling defaults
DEFAULT_DRAWS = 2000
DEFAULT_TUNE = 1000
DEFAULT_CHAINS = 4
DEFAULT_TARGET_ACCEPT = 0.90

# Convergence thresholds
RHAT_THRESHOLD = 1.05
ESS_THRESHOLD = 400


# ---------------------------------------------------------------------------
# Topology IR
# ---------------------------------------------------------------------------

@dataclass
class PathLatency:
    """Composed path latency from anchor to a node (via FW composition).

    In Phase A, these are fixed point estimates (not latent).
    """
    path_delta: float = 0.0       # Σ onset_delta_days along path
    path_mu: float = 0.0          # FW-composed log-mean
    path_sigma: float = 0.01      # FW-composed log-stdev (floor at 0.01)

    @property
    def is_trivial(self) -> bool:
        """True if this represents zero/negligible latency."""
        return self.path_delta == 0.0 and self.path_mu == 0.0 and self.path_sigma <= 0.01


@dataclass
class EdgeTopology:
    """Structural info for one edge in the topology analysis."""
    edge_id: str                   # edge UUID
    from_node: str                 # source node UUID
    to_node: str                   # target node UUID
    param_id: str                  # parameter file reference

    # Structural classification
    is_solo: bool = True
    branch_group_id: str | None = None

    # Edge-level latency (Phase A: fixed point estimates)
    has_latency: bool = False
    onset_delta_days: float = 0.0
    mu_prior: float = 0.0         # derived from lag summaries
    sigma_prior: float = 0.5      # derived from lag summaries

    # Path from anchor to this edge's TARGET node (for cohort completeness)
    path_edge_ids: list[str] = field(default_factory=list)
    path_latency: PathLatency = field(default_factory=PathLatency)

    # σ of A→X path — upstream of this edge (for τ_cohort)
    path_sigma_ax: float = 0.0


@dataclass
class BranchGroup:
    """A set of sibling edges from the same source node."""
    group_id: str
    source_node: str
    sibling_edge_ids: list[str]
    is_exhaustive: bool = False


@dataclass
class JoinNode:
    """A node where multiple paths converge (in-degree > 1).

    Used by the model builder to construct differentiable moment-matched
    collapse of inbound path latencies at join points.
    """
    node_id: str
    inbound_edge_ids: list[str]     # edge UUIDs entering this node


@dataclass
class TopologyAnalysis:
    """Complete structural decomposition of a graph."""
    anchor_node_id: str
    edges: dict[str, EdgeTopology]
    branch_groups: dict[str, BranchGroup]
    topo_order: list[str]                  # edge IDs in topological order
    join_nodes: dict[str, JoinNode] = field(default_factory=dict)
    fingerprint: str = ""
    diagnostics: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Evidence IR
# ---------------------------------------------------------------------------

@dataclass
class WindowObservation:
    """A window-type values[] entry bound to an edge."""
    n: int
    k: int
    slice_dsl: str
    completeness: float = 1.0     # edge-level, pre-computed from fixed latency


@dataclass
class CohortDailyObs:
    """A single day within a cohort observation."""
    date: str
    n: int
    k: int
    age_days: float
    completeness: float = 1.0     # path-level, pre-computed from fixed latency


@dataclass
class CohortDailyTrajectory:
    """A single Cohort day observed at multiple retrieval ages (Phase S).

    Both window() and cohort() slices produce these — same data shape,
    different anchoring. See doc 6 § "End-state compiler approach".

    obs_type determines the compiler's treatment:
      'window'  → denominator is `n` (x, from-node entrants),
                   probability is p_window, CDF is edge-level
      'cohort'  → denominator is `n` (a, anchor entrants),
                   probability is p_path_cohort, CDF is path-level
    """
    date: str
    n: int                                  # denominator: x for window, a for cohort
    obs_type: str = "cohort"                # "window" | "cohort"
    retrieval_ages: list[float] = field(default_factory=list)   # sorted ascending
    cumulative_y: list[int] = field(default_factory=list)       # monotonised target counts
    path_edge_ids: list[str] = field(default_factory=list)      # edges on path (for p_path)
    recency_weight: float = 1.0     # exp(-ln2 * age / half_life), 1.0 = most recent

    @property
    def a(self) -> int:
        """Backward compat — old code references .a"""
        return self.n


@dataclass
class CohortObservation:
    """A cohort-type values[] entry bound to an edge."""
    slice_dsl: str
    daily: list[CohortDailyObs] = field(default_factory=list)
    trajectories: list[CohortDailyTrajectory] = field(default_factory=list)
    anchor_node: str = ""


# ---------------------------------------------------------------------------
# Phase C: Slice IR
# ---------------------------------------------------------------------------

@dataclass
class SliceObservations:
    """Observations for a single context slice of an edge.

    Same structure as the aggregate (window_obs + cohort_obs) but scoped
    to one context_key. Populated by evidence binding when sliceDSL
    contains context() / visited() / case() qualifiers.
    """
    context_key: str                # e.g. "context(channel:google)" or "" (aggregate)
    window_obs: list[WindowObservation] = field(default_factory=list)
    cohort_obs: list[CohortObservation] = field(default_factory=list)
    total_n: int = 0
    has_window: bool = False
    has_cohort: bool = False


@dataclass
class SliceGroup:
    """A grouping of slices along one context dimension.

    All slices share the same dimension(s) — e.g. all context(channel:*)
    slices form a single SliceGroup with dimension_key="channel".
    """
    dimension_key: str              # e.g. "channel" or "channel×device"
    is_mece: bool = True            # context() = MECE, visited() = non-MECE
    is_exhaustive: bool = False     # True if Σ n_slice ≈ n_aggregate
    slices: dict[str, SliceObservations] = field(default_factory=dict)
    residual: SliceObservations | None = None   # non-None for partial MECE


@dataclass
class LatencyPrior:
    """Prior for edge-level latency.

    onset_delta_days: histogram-derived onset. Used as soft observation
    for the latent onset variable (doc 18) or as fixed value when
    latent_onset is disabled.
    onset_uncertainty: estimated uncertainty on the histogram onset.
    Default: max(1.0, onset * 0.3). Used as sigma for the soft
    observation Normal constraint.
    """
    onset_delta_days: float = 0.0
    mu: float = 0.0
    sigma: float = 0.5
    onset_uncertainty: float = 1.0   # sigma for histogram soft observation
    source: str = "lag_summary"   # "lag_summary" | "param_file" | "default"


@dataclass
class ProbabilityPrior:
    """Prior for edge-level probability."""
    alpha: float = 1.0
    beta: float = 1.0
    source: str = "uninformative"  # "warm_start" | "moment_matched" | "uninformative"
    ess_cap_applied: bool = False


@dataclass
class EdgeEvidence:
    """All evidence bound to a single edge."""
    edge_id: str
    param_id: str
    file_path: str

    # Priors
    prob_prior: ProbabilityPrior = field(default_factory=ProbabilityPrior)
    latency_prior: LatencyPrior | None = None

    # Observations
    window_obs: list[WindowObservation] = field(default_factory=list)
    cohort_obs: list[CohortObservation] = field(default_factory=list)

    # Observation type flags
    has_window: bool = False
    has_cohort: bool = False

    # Total observations across all entries
    total_n: int = 0

    # Phase C: context slices
    slice_groups: dict[str, SliceGroup] = field(default_factory=dict)
    has_slices: bool = False

    # Skip state
    skipped: bool = False
    skip_reason: str = ""


@dataclass
class BoundEvidence:
    """Complete evidence binding for all edges."""
    edges: dict[str, EdgeEvidence]
    settings: dict[str, Any] = field(default_factory=dict)
    today: str = ""
    diagnostics: list[str] = field(default_factory=list)
    n_drift_bins: int = 1           # Phase D drift: number of time bins (future)


# ---------------------------------------------------------------------------
# Inference output
# ---------------------------------------------------------------------------

@dataclass
class SamplingConfig:
    draws: int = DEFAULT_DRAWS
    tune: int = DEFAULT_TUNE
    chains: int = DEFAULT_CHAINS
    cores: int | None = None
    target_accept: float = DEFAULT_TARGET_ACCEPT
    random_seed: int | None = None


@dataclass
class PosteriorSummary:
    """Plain-dict posterior for one edge's probability."""
    edge_id: str
    param_id: str
    alpha: float
    beta: float
    mean: float
    stdev: float
    hdi_lower: float
    hdi_upper: float
    hdi_level: float = HDI_PROB
    ess: float = 0.0
    rhat: float = 0.0
    divergences: int = 0
    provenance: str = "bayesian"
    prior_tier: str = "uninformative"

    def to_webhook_dict(self) -> dict[str, Any]:
        """Format for the webhook payload's edge.probability block."""
        return {
            "alpha": round(self.alpha, 4),
            "beta": round(self.beta, 4),
            "mean": round(self.mean, 6),
            "stdev": round(self.stdev, 6),
            "hdi_lower": round(self.hdi_lower, 6),
            "hdi_upper": round(self.hdi_upper, 6),
            "hdi_level": self.hdi_level,
            "ess": round(self.ess, 1),
            "rhat": round(self.rhat, 4) if self.rhat else None,
            "provenance": self.provenance,
        }


@dataclass
class LatencyPosteriorSummary:
    """Plain-dict posterior for one edge's latency.

    Edge-level fields (mu_mean, sigma_mean, onset_delta_days): the
    canonical X→Y model, pinned by window data.

    Path-level fields (path_*): the fitted A→Y cohort application model.
    Directly usable for cohort() rendering — no FW composition needed
    at consumption time. Populated when cohort-level latency variables
    exist (Phase D step 2.5).

    Onset posterior fields (onset_mean, onset_sd, onset_hdi_*): populated
    when latent_onset is enabled (Phase D.O, doc 18). onset_delta_days
    becomes the posterior mean; the HDI and SD give uncertainty.
    """
    mu_mean: float
    mu_sd: float
    sigma_mean: float
    sigma_sd: float
    onset_delta_days: float
    hdi_t95_lower: float
    hdi_t95_upper: float
    hdi_level: float = HDI_PROB
    ess: float = 0.0
    rhat: float = 0.0
    provenance: str = "point-estimate"

    # Edge-level onset posterior (Phase D.O) — None when onset is fixed
    onset_mean: float | None = None
    onset_sd: float | None = None
    onset_hdi_lower: float | None = None
    onset_hdi_upper: float | None = None
    onset_mu_corr: float | None = None    # posterior correlation onset↔mu

    # Path-level (cohort) latency — populated when cohort latency is fitted
    path_onset_delta_days: float | None = None
    path_onset_sd: float | None = None
    path_onset_hdi_lower: float | None = None
    path_onset_hdi_upper: float | None = None
    path_mu_mean: float | None = None
    path_mu_sd: float | None = None
    path_sigma_mean: float | None = None
    path_sigma_sd: float | None = None
    path_provenance: str | None = None

    def to_webhook_dict(self) -> dict[str, Any]:
        """Format for the webhook payload's edge.latency block.

        Flat structure: edge-level fields at root, path-level fields
        with path_ prefix. Mirrors the analytic latency.path_mu pattern.
        """
        result = {
            "mu_mean": round(self.mu_mean, 4),
            "mu_sd": round(self.mu_sd, 4),
            "sigma_mean": round(self.sigma_mean, 4),
            "sigma_sd": round(self.sigma_sd, 4),
            "onset_delta_days": round(self.onset_delta_days, 2),
            "hdi_t95_lower": round(self.hdi_t95_lower, 1),
            "hdi_t95_upper": round(self.hdi_t95_upper, 1),
            "hdi_level": self.hdi_level,
            "ess": round(self.ess, 1),
            "rhat": round(self.rhat, 4) if self.rhat else None,
            "provenance": self.provenance,
        }
        # Edge-level onset posterior (Phase D.O)
        if self.onset_mean is not None:
            result["onset_mean"] = round(self.onset_mean, 2)
            result["onset_sd"] = round(self.onset_sd, 2) if self.onset_sd is not None else None
            result["onset_hdi_lower"] = round(self.onset_hdi_lower, 2) if self.onset_hdi_lower is not None else None
            result["onset_hdi_upper"] = round(self.onset_hdi_upper, 2) if self.onset_hdi_upper is not None else None
            if self.onset_mu_corr is not None:
                result["onset_mu_corr"] = round(self.onset_mu_corr, 3)
        # Path-level (cohort) latency
        if self.path_mu_mean is not None:
            result["path_onset_delta_days"] = round(self.path_onset_delta_days, 2) if self.path_onset_delta_days is not None else None
            result["path_onset_sd"] = round(self.path_onset_sd, 2) if self.path_onset_sd is not None else None
            result["path_onset_hdi_lower"] = round(self.path_onset_hdi_lower, 2) if self.path_onset_hdi_lower is not None else None
            result["path_onset_hdi_upper"] = round(self.path_onset_hdi_upper, 2) if self.path_onset_hdi_upper is not None else None
            result["path_mu_mean"] = round(self.path_mu_mean, 4)
            result["path_mu_sd"] = round(self.path_mu_sd, 4) if self.path_mu_sd is not None else None
            result["path_sigma_mean"] = round(self.path_sigma_mean, 4) if self.path_sigma_mean is not None else None
            result["path_sigma_sd"] = round(self.path_sigma_sd, 4) if self.path_sigma_sd is not None else None
            result["path_provenance"] = self.path_provenance or self.provenance
        return result


@dataclass
class QualityMetrics:
    max_rhat: float = 0.0
    min_ess: float = 0.0
    converged: bool = False
    total_divergences: int = 0
    converged_pct: float = 0.0


@dataclass
class InferenceResult:
    """Complete result of an inference run."""
    posteriors: list[PosteriorSummary]
    latency_posteriors: dict[str, LatencyPosteriorSummary]  # edge_id → summary
    quality: QualityMetrics
    skipped: list[dict[str, str]] = field(default_factory=list)
    diagnostics: list[str] = field(default_factory=list)
