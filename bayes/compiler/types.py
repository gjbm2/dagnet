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
# Ridge diagnostic: |corr(a_slice, sigma)| above this triggers a warning
RIDGE_CORR_THRESHOLD = 0.8


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
    t95_days: float | None = None  # from stats pass: onset + exp(mu + 1.645*sigma)
    path_t95_days: float | None = None  # cumulative path horizon from topo pass

    # Bayesian prior reset flag (doc 19): when True, compiler ignores
    # previous bayesian posterior and falls back to analytic-derived priors.
    bayes_reset: bool = False

    # Path from anchor to this edge's TARGET node (for cohort completeness)
    path_edge_ids: list[str] = field(default_factory=list)
    path_latency: PathLatency = field(default_factory=PathLatency)

    # Join-node mixture: all alternative paths from anchor to this edge's
    # target node. Empty for non-join paths (use path_edge_ids as single
    # path). Each entry is a list of edge_ids forming a complete path.
    # Populated when the path passes through a join node.
    path_alternatives: list[list[str]] = field(default_factory=list)

    # σ of A→X path — upstream of this edge (for τ_cohort)
    path_sigma_ax: float = 0.0

    # conditional_p: independent probability populations (doc 14 §6).
    # Each entry is a ConditionalPop with its own param file, evidence,
    # and latency. Conditions use visited() / case() / exclude() qualifiers.
    # Model emits separate (non-pooled) priors per condition.
    conditional_p: list["ConditionalPop"] = field(default_factory=list)


@dataclass
class ConditionalPop:
    """An independent population defined by a conditional_p entry.

    Each conditional is structurally a parallel edge — its own param file,
    its own snapshot data, its own core_hash, its own latency. The condition
    (visited/exclude/case) is baked into the MSMDC query at data retrieval
    time; the compiler treats it as an independent evidence stream.

    Supervenes on the graph: shares upstream topology but has fully
    independent probability, latency, and evidence.
    """
    condition: str              # "visited(gave-bds-in-onboarding)"
    param_id: str               # FK to this conditional's param file
    p_mean: float               # prior from conditional's p.mean
    # Latency priors (from conditional's p.latency block)
    has_latency: bool = False
    onset_delta_days: float = 0.0
    mu_prior: float = 0.0
    sigma_prior: float = 0.5
    # Evidence bound from this conditional's own param file / snapshot rows.
    # Populated by the worker after binding. None until then.
    evidence: "EdgeEvidence | None" = None


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
    recency_weight: float = 1.0   # exp(-ln2 * age / half_life), 1.0 = most recent


@dataclass
class CohortDailyObs:
    """A single day within a cohort observation."""
    date: str
    n: int
    k: int
    age_days: float
    completeness: float = 1.0     # path-level, pre-computed from fixed latency
    recency_weight: float = 1.0   # exp(-ln2 * age / half_life), 1.0 = most recent


@dataclass
class CohortDailyTrajectory:
    """A single Cohort day observed at multiple retrieval ages (Phase S).

    Both window() and cohort() slices produce these — same data shape,
    different anchoring. See doc 6 § "End-state compiler approach".

    obs_type determines the compiler's treatment:
      'window'  → denominator is `n` (x, from-node entrants on anchor_day),
                   x is fixed for the anchor_day. CDF is edge-level.
      'cohort'  → denominator is `n` (a, anchor entrants on anchor_day),
                   x(t) grows as upstream conversions arrive. CDF is path-level.
                   cumulative_x tracks from-node arrivals per retrieval age.

    For join nodes, x(t) is the TOTAL arrivals from all incoming edges
    to the from-node (sum across all paths into that node).
    """
    date: str
    n: int                                  # denominator: x for window, a for cohort
    obs_type: str = "cohort"                # "window" | "cohort"
    retrieval_ages: list[float] = field(default_factory=list)   # sorted ascending (post-filter)
    cumulative_y: list[int] = field(default_factory=list)       # monotonised target counts
    max_retrieval_age: float | None = None  # unfiltered max age (for maturity calc)
    cumulative_x: list[int] = field(default_factory=list)       # from-node arrivals per age (cohort)
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
    onset_observations: list[float] | None = None  # per-slice onset (doc 41a)


@dataclass
class SliceGroup:
    """A grouping of slices along one context dimension.

    All slices share the same dimension(s) — e.g. all context(channel:*)
    slices form a single SliceGroup with dimension_key="channel".
    """
    dimension_key: str              # e.g. "channel" or "channel×device"
    is_mece: bool = True            # context() = MECE, visited() = non-MECE
    is_exhaustive: bool = False     # True if Σ n_slice ≈ n_aggregate
    independent: bool = False       # True → no pooling (doc 14 §15A.5)
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
    onset_observations: list[float] | None = None  # per-retrieval-date onset values from Amplitude histograms


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

    # Warm-start hints from previous posterior (quality-gated).
    # None = no warm-start available; model uses default hyperparameters.
    # Unified κ per edge (journal 30-Mar-26).
    kappa_warm: float | None = None

    # Cohort (path) latency warm-start from previous posterior.
    cohort_latency_warm: dict | None = None  # {mu, sigma, onset} or None

    # Phase C: context slices
    slice_groups: dict[str, SliceGroup] = field(default_factory=dict)
    has_slices: bool = False

    # Phase C §5.7: per-date regime classification.
    # Maps retrieved_at date (ISO prefix, e.g. "2026-01-15") to regime
    # kind: "mece_partition" or "uncontexted". Populated by evidence
    # binder from RegimeSelection. Used to partition rows so aggregate
    # and per-slice likelihoods cover disjoint date sets.
    regime_per_date: dict[str, str] = field(default_factory=dict)

    # Suppression counts (populated by _bind_from_snapshot_rows)
    rows_received: int = 0           # rows entering _bind_from_snapshot_rows
    rows_post_aggregation: int = 0   # rows after context aggregation
    rows_aggregated: int = 0         # rows removed by context aggregation

    # Skip state
    skipped: bool = False
    skip_reason: str = ""

    def content_hash(self) -> str:
        """SHA-256 of model-input fields for parity comparison.

        Covers everything that affects the model: priors, observations,
        warm-start hints, skip state. Excludes diagnostic metadata
        (rows_received, rows_aggregated, file_path) that doesn't enter
        the likelihood.
        """
        import hashlib, json

        def _prior_dict(p: 'ProbabilityPrior') -> dict:
            return {"alpha": p.alpha, "beta": p.beta, "source": p.source}

        def _lat_dict(lp: 'LatencyPrior | None') -> dict | None:
            if lp is None:
                return None
            return {
                "onset": lp.onset_delta_days, "mu": lp.mu, "sigma": lp.sigma,
                "onset_uncertainty": lp.onset_uncertainty, "source": lp.source,
                "onset_obs": lp.onset_observations,
            }

        def _traj_dict(t: 'CohortDailyTrajectory') -> dict:
            return {
                "date": t.date, "n": t.n, "obs_type": t.obs_type,
                "ages": t.retrieval_ages, "cum_y": t.cumulative_y,
                "cum_x": t.cumulative_x, "path": t.path_edge_ids,
                "recency": round(t.recency_weight, 6),
            }

        def _daily_dict(d: 'CohortDailyObs') -> dict:
            return {"date": d.date, "n": d.n, "k": d.k, "age": d.age_days,
                    "compl": round(d.completeness, 6),
                    "recency": round(d.recency_weight, 6)}

        def _co_dict(co: 'CohortObservation') -> dict:
            return {
                "dsl": co.slice_dsl,
                "trajs": [_traj_dict(t) for t in co.trajectories],
                "daily": [_daily_dict(d) for d in co.daily],
            }

        def _wo_dict(wo: 'WindowObservation') -> dict:
            return {"n": wo.n, "k": wo.k, "dsl": wo.slice_dsl,
                    "compl": round(wo.completeness, 6),
                    "recency": round(wo.recency_weight, 6)}

        canonical = {
            "edge_id": self.edge_id,
            "param_id": self.param_id,
            "prior": _prior_dict(self.prob_prior),
            "latency_prior": _lat_dict(self.latency_prior),
            "window_obs": [_wo_dict(wo) for wo in self.window_obs],
            "cohort_obs": [_co_dict(co) for co in self.cohort_obs],
            "total_n": self.total_n,
            "kappa_warm": self.kappa_warm,
            "cohort_latency_warm": self.cohort_latency_warm,
            "skipped": self.skipped,
        }
        blob = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode()).hexdigest()[:16]


@dataclass
class BoundEvidence:
    """Complete evidence binding for all edges."""
    edges: dict[str, EdgeEvidence]
    settings: dict[str, Any] = field(default_factory=dict)
    today: str = ""
    diagnostics: list[str] = field(default_factory=list)
    n_drift_bins: int = 1           # Phase D drift: number of time bins (future)


# ---------------------------------------------------------------------------
# Binding receipt — diagnostic audit trail for evidence binding
# ---------------------------------------------------------------------------

@dataclass
class EdgeBindingReceipt:
    """Per-edge audit receipt produced after evidence binding.

    Captures what data was expected, what arrived, what was filtered,
    and whether the binding is healthy enough for inference.
    """
    edge_id: str = ""
    param_id: str = ""

    # Verdict: pass / warn / fail
    verdict: str = "pass"

    # Hash coverage
    expected_hashes: list[str] = field(default_factory=list)
    hashes_with_data: list[str] = field(default_factory=list)
    hashes_empty: list[str] = field(default_factory=list)

    # Row counts through the pipeline
    rows_raw: int = 0
    rows_post_regime: int = 0
    regimes_seen: int = 0
    regime_selected: str = ""

    # Suppression
    rows_post_suppression: int = 0
    rows_suppressed: int = 0

    # Slice coverage
    expected_slices: list[str] = field(default_factory=list)
    observed_slices: list[str] = field(default_factory=list)
    missing_slices: list[str] = field(default_factory=list)
    unexpected_slices: list[str] = field(default_factory=list)
    orphan_rows: int = 0

    # Per-slice row counts: ctx_key → {total_n, window_n, cohort_n}
    slice_row_counts: dict[str, dict[str, int]] = field(default_factory=dict)

    # Evidence source classification
    evidence_source: str = "none"   # snapshot / param_file / mixed / none

    # Observation counts
    window_trajectories: int = 0
    window_daily: int = 0
    cohort_trajectories: int = 0
    cohort_daily: int = 0
    total_n: int = 0

    # Anchor range
    expected_anchor_from: str = ""
    expected_anchor_to: str = ""
    actual_anchor_from: str = ""
    actual_anchor_to: str = ""
    anchor_days_covered: int = 0

    # Skip state
    skipped: bool = False
    skip_reason: str = ""

    # Content hash of the assembled EdgeEvidence (model inputs).
    # Used for parity comparison between different payload contracts
    # (e.g. param-file path vs engorged-graph path). If two paths
    # produce the same evidence_hash for the same edge, the model
    # inputs are identical.
    evidence_hash: str = ""

    # Human-readable divergence notes
    divergences: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Serialise to a plain dict for JSON output."""
        return {
            "edge_id": self.edge_id,
            "param_id": self.param_id,
            "verdict": self.verdict,
            "expected_hashes": self.expected_hashes,
            "hashes_with_data": list(self.hashes_with_data),
            "hashes_empty": list(self.hashes_empty),
            "rows_raw": self.rows_raw,
            "rows_post_regime": self.rows_post_regime,
            "regimes_seen": self.regimes_seen,
            "regime_selected": self.regime_selected,
            "rows_post_suppression": self.rows_post_suppression,
            "rows_suppressed": self.rows_suppressed,
            "expected_slices": self.expected_slices,
            "observed_slices": self.observed_slices,
            "missing_slices": self.missing_slices,
            "unexpected_slices": self.unexpected_slices,
            "orphan_rows": self.orphan_rows,
            "slice_row_counts": self.slice_row_counts,
            "evidence_source": self.evidence_source,
            "window_trajectories": self.window_trajectories,
            "window_daily": self.window_daily,
            "cohort_trajectories": self.cohort_trajectories,
            "cohort_daily": self.cohort_daily,
            "total_n": self.total_n,
            "expected_anchor_from": self.expected_anchor_from,
            "expected_anchor_to": self.expected_anchor_to,
            "actual_anchor_from": self.actual_anchor_from,
            "actual_anchor_to": self.actual_anchor_to,
            "anchor_days_covered": self.anchor_days_covered,
            "skipped": self.skipped,
            "skip_reason": self.skip_reason,
            "evidence_hash": self.evidence_hash,
            "divergences": self.divergences,
        }


@dataclass
class BindingReceipt:
    """Graph-level summary of evidence binding outcomes.

    Aggregates per-edge receipts into a single diagnostic object
    that can be logged, returned in the result payload, or used
    to gate inference (mode='gate').
    """
    edge_receipts: dict[str, EdgeBindingReceipt] = field(default_factory=dict)

    # Graph-level summary counts
    edges_expected: int = 0
    edges_bound: int = 0
    edges_fallback: int = 0
    edges_skipped: int = 0
    edges_no_subjects: int = 0
    edges_warned: int = 0
    edges_failed: int = 0

    # Mode and halt state
    mode: str = "log"           # log / gate
    halted: bool = False

    def to_dict(self) -> dict[str, Any]:
        """Serialise to a plain dict for JSON output."""
        return {
            "edge_receipts": {
                eid: r.to_dict() for eid, r in self.edge_receipts.items()
            },
            "edges_expected": self.edges_expected,
            "edges_bound": self.edges_bound,
            "edges_fallback": self.edges_fallback,
            "edges_skipped": self.edges_skipped,
            "edges_no_subjects": self.edges_no_subjects,
            "edges_warned": self.edges_warned,
            "edges_failed": self.edges_failed,
            "mode": self.mode,
            "halted": self.halted,
        }


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
    lowrank_mass_matrix: bool = False
    jax_backend: bool = True


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

    # Per-observation-type posteriors (doc 21, doc 49) — separate from p_base.
    # Epistemic: moment-matched from raw p_window / p_cohort MCMC trace samples.
    # These represent uncertainty about the true population rate parameter.
    window_alpha: float | None = None
    window_beta: float | None = None
    window_hdi_lower: float | None = None
    window_hdi_upper: float | None = None
    cohort_alpha: float | None = None
    cohort_beta: float | None = None
    cohort_hdi_lower: float | None = None
    cohort_hdi_upper: float | None = None

    # Predictive: kappa-inflated (doc 49 §A.6.1). Represent expected range
    # of observed rates across future cohort days. None when kappa absent
    # (in which case epistemic and predictive are identical).
    window_alpha_pred: float | None = None
    window_beta_pred: float | None = None
    window_hdi_lower_pred: float | None = None
    window_hdi_upper_pred: float | None = None
    cohort_alpha_pred: float | None = None
    cohort_beta_pred: float | None = None
    cohort_hdi_lower_pred: float | None = None
    cohort_hdi_upper_pred: float | None = None

    # Subset-conditioning mass (doc 52) — total raw observation count
    # used to fit each mode's posterior. Consumers use these to compute
    # the engine-level blend ratio r = m_S / m_G when re-conditioning
    # the aggregate on a query-scoped Cohort set. See doc 52 §14.2.
    window_n_effective: float | None = None
    cohort_n_effective: float | None = None

    # Phase C: per-context-slice posteriors (doc 14 §5.2, doc 49 §A.6.1)
    # context_key → {mean, stdev, alpha, beta, hdi_lower, hdi_upper,
    #                 alpha_pred, beta_pred, hdi_lower_pred, hdi_upper_pred}
    slice_posteriors: dict[str, dict[str, float]] = field(default_factory=dict)
    # Phase 2 per-slice cohort posteriors
    # context_key → {alpha, beta, p_mean, p_sd, hdi_lower, hdi_upper}
    cohort_slice_posteriors: dict[str, dict[str, float]] = field(default_factory=dict)
    tau_slice_mean: float | None = None
    tau_slice_sd: float | None = None

    # LOO-ELPD model adequacy scoring (doc 32)
    elpd: float | None = None
    elpd_se: float | None = None
    elpd_null: float | None = None
    delta_elpd: float | None = None
    pareto_k_max: float | None = None
    n_loo_obs: int | None = None

    # PPC calibration (doc 38) — are predictive intervals honest?
    ppc_coverage_90: float | None = None      # endpoint/daily: empirical coverage at 90% nominal
    ppc_n_obs: int | None = None              # endpoint/daily: observation count
    ppc_traj_coverage_90: float | None = None  # trajectory: empirical coverage at 90% nominal
    ppc_traj_n_obs: int | None = None          # trajectory: observation count

    def to_webhook_dict(self) -> dict[str, Any]:
        """Format for the webhook payload's edge.probability block."""
        result = {
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
        if self.delta_elpd is not None:
            result["delta_elpd"] = round(self.delta_elpd, 3)
            result["pareto_k_max"] = round(self.pareto_k_max, 3) if self.pareto_k_max is not None else None
            result["n_loo_obs"] = self.n_loo_obs
        if self.ppc_coverage_90 is not None:
            result["ppc_coverage_90"] = round(self.ppc_coverage_90, 3)
            result["ppc_n_obs"] = self.ppc_n_obs
        if self.ppc_traj_coverage_90 is not None:
            result["ppc_traj_coverage_90"] = round(self.ppc_traj_coverage_90, 3)
            result["ppc_traj_n_obs"] = self.ppc_traj_n_obs
        return result


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
    mu_sd: float                      # predictive when kappa_lat exists (doc 49 §A.6.2)
    sigma_mean: float
    sigma_sd: float                   # epistemic (posterior SD, no predictive mechanism)
    onset_delta_days: float
    hdi_t95_lower: float
    hdi_t95_upper: float
    hdi_level: float = HDI_PROB
    ess: float = 0.0
    rhat: float = 0.0
    provenance: str = "point-estimate"

    # Epistemic mu_sd — always np.std(mu_samples) from the MCMC trace,
    # before any kappa_lat predictive overwrite. See doc 49 §A.6.2.
    mu_sd_epist: float | None = None

    # Edge-level onset posterior (Phase D.O) — None when onset is fixed
    onset_mean: float | None = None
    onset_sd: float | None = None     # epistemic (posterior SD)
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
    path_mu_sd_epist: float | None = None   # epistemic path mu_sd (doc 49)
    path_sigma_mean: float | None = None
    path_sigma_sd: float | None = None
    path_hdi_t95_lower: float | None = None
    path_hdi_t95_upper: float | None = None
    path_provenance: str | None = None

    # Latency dispersion (doc 34) — per-interval timing overdispersion
    kappa_lat_mean: float | None = None   # posterior mean of kappa_lat
    kappa_lat_sd: float | None = None     # posterior SD of kappa_lat

    # LOO-ELPD model adequacy scoring (doc 32)
    elpd: float | None = None
    elpd_se: float | None = None
    elpd_null: float | None = None
    delta_elpd: float | None = None
    pareto_k_max: float | None = None
    n_loo_obs: int | None = None

    # PPC calibration (doc 38)
    ppc_traj_coverage_90: float | None = None
    ppc_traj_n_obs: int | None = None

    def to_webhook_dict(self) -> dict[str, Any]:
        """Format for the webhook payload's edge.latency block.

        Flat structure: edge-level fields at root, path-level fields
        with path_ prefix. Mirrors the analytic latency.path_mu pattern.
        """
        result = {
            "mu_mean": round(self.mu_mean, 4),
            "mu_sd": round(self.mu_sd, 4),                # predictive when kappa_lat
            "mu_sd_epist": round(self.mu_sd_epist, 4) if self.mu_sd_epist is not None else None,
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
            result["path_mu_sd_epist"] = round(self.path_mu_sd_epist, 4) if self.path_mu_sd_epist is not None else None
            result["path_sigma_mean"] = round(self.path_sigma_mean, 4) if self.path_sigma_mean is not None else None
            result["path_sigma_sd"] = round(self.path_sigma_sd, 4) if self.path_sigma_sd is not None else None
            result["path_hdi_t95_lower"] = round(self.path_hdi_t95_lower, 1) if self.path_hdi_t95_lower is not None else None
            result["path_hdi_t95_upper"] = round(self.path_hdi_t95_upper, 1) if self.path_hdi_t95_upper is not None else None
            result["path_provenance"] = self.path_provenance or self.provenance
        # Latency dispersion (doc 34)
        if self.kappa_lat_mean is not None:
            result["kappa_lat_mean"] = round(self.kappa_lat_mean, 1)
            result["kappa_lat_sd"] = round(self.kappa_lat_sd, 1) if self.kappa_lat_sd is not None else None
        # LOO-ELPD (doc 32)
        if self.delta_elpd is not None:
            result["delta_elpd"] = round(self.delta_elpd, 3)
            result["pareto_k_max"] = round(self.pareto_k_max, 3) if self.pareto_k_max is not None else None
            result["n_loo_obs"] = self.n_loo_obs
        # PPC calibration (doc 38)
        if self.ppc_traj_coverage_90 is not None:
            result["ppc_traj_coverage_90"] = round(self.ppc_traj_coverage_90, 3)
            result["ppc_traj_n_obs"] = self.ppc_traj_n_obs
        return result


@dataclass
class QualityMetrics:
    max_rhat: float = 0.0
    min_ess: float = 0.0
    converged: bool = False
    total_divergences: int = 0
    converged_pct: float = 0.0
    # LOO-ELPD graph-level summary (doc 32)
    total_delta_elpd: float = 0.0
    worst_pareto_k: float = 0.0
    n_high_k: int = 0


@dataclass
class InferenceResult:
    """Complete result of an inference run."""
    posteriors: list[PosteriorSummary]
    latency_posteriors: dict[str, LatencyPosteriorSummary]  # edge_id → summary
    quality: QualityMetrics
    model_state: dict[str, float] = field(default_factory=dict)  # doc 21: warm-start internals
    skipped: list[dict[str, str]] = field(default_factory=list)
    diagnostics: list[str] = field(default_factory=list)
