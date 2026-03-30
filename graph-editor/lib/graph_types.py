"""
Graph data type definitions using Pydantic

Generated from: conversion-graph-1.1.0.json
Source: /home/gjbm2/dev/dagnet/graph-editor/public/schemas/conversion-graph-1.1.0.json

These models match the official JSON schema exactly for validation
of all Python graph operations.
"""

from typing import List, Dict, Any, Optional, Literal, Union
from datetime import datetime
from pydantic import BaseModel, Field, ConfigDict, field_validator, model_validator


# ============================================================================
# Core Parameters
# ============================================================================

class Evidence(BaseModel):
    """Observations from data sources (n/k for probabilities)."""
    n: Optional[int] = Field(None, ge=0, description="Sample size (total trials)")
    k: Optional[int] = Field(None, ge=0, description="Number of successes")
    mean: Optional[float] = Field(None, ge=0, description="Evidence probability: raw observed rate = k/n (query-time computed scalar)")
    stdev: Optional[float] = Field(None, ge=0, description="Evidence uncertainty: binomial stdev for the evidence rate (query-time computed scalar)")
    scope_from: Optional[str] = Field(None, description="Temporal scope start — cohort entry dates or window dates (UK format: d-MMM-yy or ISO)")
    scope_to: Optional[str] = Field(None, description="Temporal scope end — cohort entry dates or window dates (UK format: d-MMM-yy or ISO)")
    retrieved_at: Optional[str] = Field(None, description="When this data was retrieved (UK format or ISO)")
    source: Optional[str] = Field(None, description="Connection name used for this retrieval")
    path: Optional[Literal["direct", "file"]] = Field(None, description="How this data was retrieved: 'direct' = fetched directly from connection, 'file' = synced from parameter file")
    full_query: Optional[str] = Field(None, description="Complete DSL query string used for this fetch (includes base query + window + context)")
    debug_trace: Optional[str] = Field(None, description="Complete execution trace as JSON string for debugging/provenance")

    @field_validator('scope_from', 'scope_to', 'retrieved_at', mode='before')
    @classmethod
    def convert_datetime_to_str(cls, v):
        """Accept both datetime and str, convert datetime to ISO string."""
        if isinstance(v, datetime):
            return v.isoformat()
        return v


class DataSource(BaseModel):
    """Provenance information for parameter data."""
    type: str = Field(..., description="Data source type (from connections.yaml, e.g., 'amplitude', 'manual', 'sheets')")
    retrieved_at: Optional[str] = Field(None, description="When data was last aggregated or cached (UK format or ISO)")
    source_retrieved_at: Optional[str] = Field(None, description="When data was originally fetched from the external source (e.g. Amplitude). Preserved through aggregation cycles.")
    edited_at: Optional[str] = Field(None, description="When data was last edited (UK format or ISO)")
    # NOTE: 'query' field removed - was unused and caused type confusion (Dict expected but string stored)
    full_query: Optional[str] = Field(None, description="Complete DSL query string used for retrieval")
    debug_trace: Optional[str] = Field(None, description="Complete execution trace as JSON string for debugging/provenance")
    experiment_id: Optional[str] = Field(None, description="Experiment ID for A/B test sources")
    no_data: Optional[bool] = Field(None, description="True if data source returned no data")


class LatencyConfig(BaseModel):
    """
    Latency configuration for edges with time-delayed conversions.
    
    SEMANTICS:
    - latency_parameter == True: Latency tracking ENABLED (cohort queries, forecasting, latency UI)
    - latency_parameter == False or None: Latency tracking DISABLED (standard window() behaviour)
    """
    latency_parameter: Optional[bool] = Field(None, description="Explicit enablement flag. True = latency tracking enabled.")
    latency_parameter_overridden: bool = Field(False, description="If true, user manually set latency_parameter")
    anchor_node_id: Optional[str] = Field(None, description="Anchor node for cohort queries (furthest upstream START)")
    anchor_node_id_overridden: bool = Field(False, description="If true, user manually set anchor_node_id")
    t95: Optional[float] = Field(None, ge=0, description="95th percentile lag in days (computed from fitted CDF)")
    t95_overridden: bool = Field(False, description="If true, user manually set t95")
    path_t95: Optional[float] = Field(None, ge=0, description="Critical path t95 in days (max t95 from anchor to this edge)")
    path_t95_overridden: bool = Field(False, description="If true, user manually set path_t95")
    promoted_t95: Optional[float] = Field(None, ge=0, description="Winning model's t95 (written by applyPromotion, read-only for consumption)")
    promoted_path_t95: Optional[float] = Field(None, ge=0, description="Winning model's path_t95 (written by applyPromotion, read-only for consumption)")
    promoted_onset_delta_days: Optional[float] = Field(None, ge=0, description="Winning model's onset_delta_days (written by applyPromotion, read-only for consumption)")
    onset_delta_days: Optional[float] = Field(None, ge=0, description="Onset delay in days - minimum time before conversions begin (aggregated from window slices)")
    onset_delta_days_overridden: bool = Field(False, description="If true, user manually set onset_delta_days")
    median_lag_days: Optional[float] = Field(None, ge=0, description="Weighted median lag in days (display only)")
    mean_lag_days: Optional[float] = Field(None, ge=0, description="Weighted mean lag in days (used with median to compute t95)")
    completeness: Optional[float] = Field(None, ge=0, le=1, description="Maturity progress 0-1 (display only)")
    mu: Optional[float] = Field(None, description="Fitted log-normal mu parameter (internal, not UI-exposed)")
    sigma: Optional[float] = Field(None, ge=0, description="Fitted log-normal sigma parameter (internal, not UI-exposed)")
    path_mu: Optional[float] = Field(None, description="Path-level A→Y log-normal mu (Fenton–Wilkinson, internal)")
    path_sigma: Optional[float] = Field(None, ge=0, description="Path-level A→Y log-normal sigma (Fenton–Wilkinson, internal)")
    path_onset_delta_days: Optional[float] = Field(None, ge=0, description="Path-level Σ onset_delta_days along path (DP sum, internal)")
    model_trained_at: Optional[str] = Field(None, description="UK date (d-MMM-yy) when the model was last fitted (staleness detection)")
    # NOTE: Bayesian latency posterior no longer lives here (doc 21).
    # It is in the file-level Posterior.slices. No posterior field on LatencyConfig.


# ── Model variable provenance (doc 15) ──────────────────────────────────────

class ModelVarsQuality(BaseModel):
    """Quality metrics from a Bayesian model_vars entry (evaluated once at write time)."""
    rhat: float
    ess: float
    divergences: int = Field(0, ge=0)
    evidence_grade: int = Field(..., ge=0, le=3, description="0=cold start, 1=weak, 2=mature, 3=full Bayesian")
    gate_passed: bool = Field(..., description="meetsQualityGate() result at write time")


class ModelVarsLatency(BaseModel):
    """Latency sub-block within a ModelVarsEntry."""
    mu: float
    sigma: float = Field(..., ge=0)
    t95: float = Field(..., ge=0)
    onset_delta_days: float = Field(..., ge=0)
    path_mu: Optional[float] = None
    path_sigma: Optional[float] = Field(None, ge=0)
    path_t95: Optional[float] = Field(None, ge=0)
    path_onset_delta_days: Optional[float] = Field(None, ge=0)


class ModelVarsProbability(BaseModel):
    """Probability sub-block within a ModelVarsEntry."""
    mean: float = Field(..., ge=0, le=1)
    stdev: float = Field(..., ge=0)


class ModelVarsEntry(BaseModel):
    """Provenance-tagged set of model variables from one source (doc 15 §2.1).

    Each entry is a complete snapshot — no sparse entries, no per-field mixing.
    """
    source: Literal['analytic', 'analytic_be', 'bayesian', 'manual']
    source_at: str = Field(..., description="UK date (d-MMM-yy) when this entry was last updated")
    probability: ModelVarsProbability
    latency: Optional[ModelVarsLatency] = None
    quality: Optional[ModelVarsQuality] = Field(None, description="Bayesian-specific quality metadata (present only when source == 'bayesian')")


# ── Bayesian posterior types (doc 21: unified posterior schema) ─────────────
#
# FILE-LEVEL types (Posterior, SlicePosteriorEntry, FitHistoryEntry):
#   Shape of `posterior` on parameter files. Per-slice entries carry both
#   probability and latency fields. Written by compiler, read by warm-start.
#
# The old ProbabilityPosterior / LatencyPosterior graph-edge shapes are NOT
# Pydantic models — they exist only in TS types. The cascade projects from
# file-level Posterior into those shapes for UI consumption.

class SlicePosteriorEntry(BaseModel):
    """Per-slice posterior entry — unified probability + latency (doc 21 §3.2).
    Keyed by slice DSL string (e.g. "window()", "cohort()").
    """
    # Probability
    alpha: float
    beta_param: float = Field(..., alias='beta')
    p_hdi_lower: float
    p_hdi_upper: float
    # Latency (present when edge has latency fitted for this slice)
    mu_mean: Optional[float] = None
    mu_sd: Optional[float] = None
    sigma_mean: Optional[float] = None
    sigma_sd: Optional[float] = None
    onset_mean: Optional[float] = None
    onset_sd: Optional[float] = None
    hdi_t95_lower: Optional[float] = None
    hdi_t95_upper: Optional[float] = None
    onset_mu_corr: Optional[float] = None
    # Quality (per-slice)
    ess: float
    rhat: float
    divergences: int = Field(0, ge=0)
    evidence_grade: int = Field(0, ge=0, le=3)
    provenance: Literal['bayesian', 'pooled-fallback', 'point-estimate', 'skipped'] = 'bayesian'

    model_config = ConfigDict(populate_by_name=True)


class SlimSlice(BaseModel):
    """Slim per-slice snapshot within a fit_history entry (drift tracking)."""
    alpha: float
    beta_param: float = Field(..., alias='beta')
    mu_mean: Optional[float] = None
    sigma_mean: Optional[float] = None

    model_config = ConfigDict(populate_by_name=True)


class FitHistoryEntry(BaseModel):
    """Unified fit_history entry — one per fit date (doc 21 §3.4)."""
    fitted_at: str
    fingerprint: str
    slices: Dict[str, SlimSlice]


class Posterior(BaseModel):
    """File-level unified posterior (doc 21 §3.3).
    Lives at `posterior` on the parameter file. Carries both probability and
    latency posteriors via per-slice entries.
    """
    fitted_at: str = Field(..., description="UK date (d-MMM-yy) of most recent fit")
    fingerprint: str = Field(..., description="Deterministic model hash")
    hdi_level: float = Field(..., description="HDI level used (e.g. 0.9)")
    prior_tier: Literal['direct_history', 'trajectory_calibrated', 'inherited', 'sibling_pooled', 'uninformative']
    surprise_z: Optional[float] = Field(None, description="Trajectory surprise z-score")
    slices: Dict[str, SlicePosteriorEntry] = Field(..., description="Per-slice posteriors keyed by DSL")
    model_state: Optional[Dict[str, float]] = Field(None, alias='_model_state', description="Model internals for warm-start")
    fit_history: Optional[List[FitHistoryEntry]] = None

    model_config = ConfigDict(populate_by_name=True)


class BayesQuality(BaseModel):
    """Quality metrics from a Bayesian fitting run."""
    max_rhat: float
    min_ess: float
    converged_pct: float = Field(..., ge=0, le=1, description="Fraction of params meeting convergence criteria")
    edges_fitted: int = Field(..., ge=0)
    edges_skipped: int = Field(..., ge=0)
    total_divergences: int = Field(0, ge=0, description="Sum of divergences across all fitted edges")
    edges_with_surprise: int = Field(0, ge=0, description="Count of edges with trajectory surprise |z| > 2")
    edges_by_tier: Dict[str, int] = Field(default_factory=dict, description="Prior cascade tier distribution")


class BayesRunMetadata(BaseModel):
    """Graph-level metadata from the most recent Bayesian fitting run."""
    fitted_at: str = Field(..., description="UK date (d-MMM-yy)")
    duration_ms: float = Field(..., ge=0, description="Wall-clock elapsed time")
    fingerprint: str = Field(..., description="Deterministic hash of (graph + policy + evidence)")
    model_version: int = Field(..., ge=1, description="Schema version (starts at 1)")
    settings_signature: str = Field(..., description="Hash of ForecastingSettings used")
    quality: BayesQuality


# No forward reference rebuild needed — LatencyConfig no longer has a
# posterior field (doc 21: posterior lives at file top level, not under latency).


class ForecastParams(BaseModel):
    """Forecast probability parameters from mature cohorts."""
    # NOTE: mean can exceed 1.0 in edge cases when extrapolating from sparse/immature data.
    # The forecast is still useful as an indicator even if > 1.0 (will be clamped at display time).
    mean: Optional[float] = Field(None, ge=0, description="Forecast mean probability (p_∞)")
    stdev: Optional[float] = Field(None, ge=0, description="Forecast standard deviation")
    # Expected converters: p.mean * p.n - used for propagating population downstream
    k: Optional[float] = Field(None, ge=0, description="Expected converters on this edge (p.mean * p.n)")


class ProbabilityParam(BaseModel):
    """Probability parameter: p.mean is P(to|from)."""
    mean: Optional[float] = Field(None, ge=0, le=1, description="Probability value")
    mean_overridden: bool = Field(False, description="If true, mean was manually edited")
    stdev: Optional[float] = Field(None, ge=0, description="Standard deviation")
    stdev_overridden: bool = Field(False, description="If true, stdev was manually edited")
    distribution: Optional[Literal["normal", "beta", "uniform"]] = Field("beta", description="Distribution type")
    distribution_overridden: bool = Field(False, description="If true, distribution was manually edited")
    connection: Optional[str] = Field(None, description="Connection name from connections.yaml")
    connection_overridden: bool = Field(False, description="If true, connection was manually edited")
    connection_string: Optional[str] = Field(None, description="JSON blob of provider-specific settings")
    evidence: Optional[Evidence] = None
    id: Optional[str] = Field(None, description="Reference to parameter file (FK to parameter-{id}.yaml)")
    data_source: Optional[DataSource] = None
    posterior: Optional[Posterior] = Field(None, description="Unified Bayesian posterior (doc 21) — file-level; cascade projects onto graph edge")
    # Model variable provenance (doc 15)
    model_vars: Optional[List[ModelVarsEntry]] = Field(None, description="Candidate model variable sets from different sources")
    model_source_preference: Optional[Literal['best_available', 'bayesian', 'analytic_be', 'analytic', 'manual']] = Field(None, description="Per-edge override of graph.model_source_preference")
    model_source_preference_overridden: bool = Field(False, description="True when model_source_preference was explicitly set by user")
    # LAG fields
    latency: Optional[LatencyConfig] = Field(None, description="Latency configuration for this probability")
    forecast: Optional[ForecastParams] = Field(None, description="Forecast probability from mature cohorts")
    # Inbound-n: Forecast population (see inbound-n-fix.md)
    n: Optional[float] = Field(None, ge=0, description="Forecast population for this edge under current DSL. NOT evidence.n. Derived via step-wise convolution of upstream p.mean values.")


class CostParam(BaseModel):
    """Cost parameter (monetary or time)."""
    mean: Optional[float] = Field(None, ge=0)
    mean_overridden: bool = Field(False, description="If true, mean was manually edited")
    stdev: Optional[float] = Field(None, ge=0)
    stdev_overridden: bool = Field(False, description="If true, stdev was manually edited")
    distribution: Optional[Literal["normal", "lognormal", "gamma", "uniform", "beta"]] = Field("normal")
    distribution_overridden: bool = Field(False, description="If true, distribution was manually edited")
    connection: Optional[str] = Field(None, description="Connection name from connections.yaml")
    connection_overridden: bool = Field(False, description="If true, connection was manually edited")
    connection_string: Optional[str] = Field(None, description="JSON blob of provider-specific settings")
    evidence: Optional[Evidence] = None
    id: Optional[str] = Field(None, description="Reference to cost parameter file")
    data_source: Optional[DataSource] = None


# ============================================================================
# Conditional Probabilities
# ============================================================================

class ConditionalProbability(BaseModel):
    """
    Conditional probability that applies when specific condition is met.
    
    - condition: semantic (WHEN it applies) - uses constraint syntax
    - query: full retrieval path (HOW to fetch data) - auto-derived via MSMDC
    """
    condition: str = Field(..., description="Constraint expression using query DSL")
    query: Optional[str] = Field(None, description="Full data retrieval query")
    query_overridden: bool = Field(False, description="If true, query was manually edited")
    p: ProbabilityParam
    colour: Optional[str] = Field(None, description="Display colour for this condition (hex)")


# ============================================================================
# Node Structure
# ============================================================================

class EventReference(BaseModel):
    """Event reference for a node."""
    id: str = Field(..., pattern=r"^[a-z0-9_-]+$", description="Reference to event in events registry")
    id_overridden: bool = Field(False, description="If true, event ID was manually edited")


class Entry(BaseModel):
    """Entry point configuration."""
    is_start: bool = Field(False)
    entry_weight: Optional[float] = Field(None, ge=0)


class ResidualBehavior(BaseModel):
    """Residual probability routing behavior."""
    default_outcome: Optional[str] = Field(None, min_length=1)
    overflow_policy: Optional[Literal["error", "normalize", "cap"]] = Field("error")


class CaseDataSource(BaseModel):
    """Connection settings for external experiment data."""
    source_type: Literal["statsig", "optimizely", "api", "manual"]
    connection_settings: Optional[str] = Field(None, description="JSON blob with source-specific settings")
    connection_overridden: bool = Field(False, description="If true, overrides parameter file settings")


class CaseVariant(BaseModel):
    """A/B test or experiment variant."""
    name: str
    name_overridden: bool = Field(False, description="If true, name was manually edited")
    weight: float = Field(..., ge=0, le=1)
    weight_overridden: bool = Field(False, description="If true, weight was manually edited")


class Case(BaseModel):
    """Case/experiment node metadata."""
    uuid: Optional[str] = None  # Optional for backwards compatibility
    id: str
    status: Optional[Literal["active", "paused", "completed"]] = Field("active")
    variants: Optional[List[CaseVariant]] = None
    data_source: Optional[CaseDataSource] = None


class Layout(BaseModel):
    """Node layout/positioning information."""
    x: Optional[float] = None
    y: Optional[float] = None
    rank: Optional[int] = Field(None, ge=0)
    group: Optional[str] = Field(None, max_length=128)
    colour: Optional[str] = Field(None, pattern=r"^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$")


class NodeImage(BaseModel):
    """
    Node-attached image metadata (graph-level).
    
    NOTE: This matches the JSON schema `Node.images.items` shape:
    - required: image_id, caption
    - optional: caption_overridden, file_extension
    """
    image_id: str = Field(..., pattern=r"^[a-zA-Z0-9_-]+$")
    caption: str = Field(..., max_length=256)
    caption_overridden: bool = Field(False, description="If true, caption was manually edited at graph level")
    file_extension: Optional[Literal["png", "jpg", "jpeg"]] = None


class Node(BaseModel):
    """
    Graph node representing a state in the conversion funnel.
    """
    uuid: str
    id: str = Field("", max_length=128)  # Allow empty ID (not yet assigned)
    type: Optional[Literal["normal", "case"]] = Field("normal", description="Node type. Use 'case' for A/B test nodes.")
    label: Optional[str] = Field(None, max_length=256)
    label_overridden: bool = Field(False, description="If true, label was manually edited")
    description: Optional[str] = None
    description_overridden: bool = Field(False, description="If true, description was manually edited")
    event_id: Optional[str] = Field(None, description="Direct event ID for DAS queries")
    event_id_overridden: bool = Field(False, description="If true, event_id was manually edited")
    event: Optional[EventReference] = None
    tags: Optional[List[str]] = None
    absorbing: bool = Field(False, description="If true, node is terminal (zero outgoing edges)")
    outcome_type: Optional[Literal["success", "failure", "error", "neutral", "other"]] = None
    outcome_type_overridden: bool = Field(False, description="If true, outcome_type was manually edited")
    entry: Optional[Entry] = None
    costs: Optional[Dict[str, Any]] = Field(None, deprecated=True, description="DEPRECATED: Use edge costs")
    residual_behavior: Optional[ResidualBehavior] = None
    case: Optional[Case] = None
    layout: Optional[Layout] = None
    url: Optional[str] = Field(None, description="URL associated with this node")
    url_overridden: bool = Field(False, description="If true, url was manually edited")
    images: Optional[List[NodeImage]] = Field(None, description="Images for node display")
    images_overridden: bool = Field(False, description="If true, images were manually edited")


# ============================================================================
# Edge Structure
# ============================================================================

class EdgeDisplay(BaseModel):
    """Display parameters for edges (editor use only)."""
    conditional_color: Optional[str] = Field(None, pattern=r"^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$")
    conditional_group: Optional[str] = Field(None, max_length=128)


class Edge(BaseModel):
    """
    Graph edge representing a conditional transition between states.
    """
    model_config = ConfigDict(populate_by_name=True)
    
    uuid: str
    id: Optional[str] = Field(None, min_length=1, max_length=128)
    from_node: str = Field(..., alias='from', min_length=1, description="Source node uuid or id")
    to: str = Field(..., min_length=1, description="Target node uuid or id")
    fromHandle: Optional[Literal["left", "right", "top", "bottom", "left-out", "right-out", "top-out", "bottom-out"]] = None
    toHandle: Optional[Literal["left", "right", "top", "bottom", "left-out", "right-out", "top-out", "bottom-out"]] = None
    label: Optional[str] = Field(None, max_length=256)
    label_overridden: bool = Field(False, description="If true, label was manually edited")
    description: Optional[str] = None
    description_overridden: bool = Field(False, description="If true, description was manually edited")
    query: Optional[str] = Field(None, description="Query expression for data retrieval")
    query_overridden: bool = Field(False, description="If true, query was manually edited")
    n_query: Optional[str] = Field(None, description="Explicit query for n (denominator) when it differs from k query")
    n_query_overridden: bool = Field(False, description="If true, n_query was manually edited")
    p: ProbabilityParam = Field(..., description="Base probability (fallback when no conditionals match)")
    conditional_p: Optional[List[ConditionalProbability]] = Field(None, description="Conditional probabilities (first match wins)")
    weight_default: Optional[float] = Field(None, ge=0, description="Weight for distributing residual probability")
    cost_gbp: Optional[CostParam] = None
    labour_cost: Optional[CostParam] = None
    case_variant: Optional[str] = Field(None, max_length=128, description="Variant name (case edges only)")
    case_id: Optional[str] = Field(None, description="Parent case node ID (case edges only)")
    display: Optional[EdgeDisplay] = None


# ============================================================================
# Graph Structure
# ============================================================================

class Policies(BaseModel):
    """Graph-level policies."""
    default_outcome: str = Field(..., min_length=1)
    overflow_policy: Literal["error", "normalize", "cap"] = Field("error")
    free_edge_policy: Literal["complement", "uniform", "weighted"] = Field("complement")


class Metadata(BaseModel):
    """Graph metadata."""
    version: str = Field(..., pattern=r"^\d+\.\d+\.\d+$")
    name: Optional[str] = Field(None, max_length=256, description="Human-readable graph name for display in UI")
    created_at: str = Field(..., description="Creation timestamp (UK format or ISO)")
    updated_at: Optional[str] = Field(None, description="Last update timestamp (UK format or ISO)")
    last_retrieve_all_slices_success_at_ms: Optional[float] = Field(
        None,
        ge=0,
        description="Cross-device marker: epoch ms when a full Retrieve All Slices run completed successfully for this graph.",
    )
    author: Optional[str] = Field(None, max_length=256)
    description: Optional[str] = None
    tags: Optional[List[str]] = None
    
    @field_validator('created_at', 'updated_at', mode='before')
    @classmethod
    def convert_datetime_to_str(cls, v):
        """Accept both datetime and str, convert datetime to ISO string."""
        if isinstance(v, datetime):
            return v.isoformat()
        return v


class PostIt(BaseModel):
    """Canvas annotation: sticky note (visual only, not graph semantics)."""
    id: str
    text: str = Field("", max_length=4096)
    colour: str = Field(..., pattern=r"^#([0-9A-Fa-f]{6})$")
    fontSize: Optional[Literal["S", "M", "L", "XL"]] = Field(None, description="Font size preset")
    width: float = Field(..., gt=0)
    height: float = Field(..., gt=0)
    x: float
    y: float
    minimised: Optional[bool] = None
    minimised_anchor: Optional[Literal["tl", "tr", "bl", "br"]] = None
    createdBy: Optional[str] = Field(None, description="Git username of the creator")
    createdAt: Optional[str] = Field(None, description="ISO-8601 timestamp of creation")


class Container(BaseModel):
    """Canvas annotation: labelled grouping rectangle (visual only, not graph semantics)."""
    id: str
    label: str = Field("Group", max_length=256)
    colour: str = Field(..., pattern=r"^#([0-9A-Fa-f]{6})$")
    width: float = Field(..., gt=0)
    height: float = Field(..., gt=0)
    x: float
    y: float


class ChartRecipeAnalysis(BaseModel):
    """Shared chart recipe: what to compute — analysis identity. Used by both canvas analyses and chart files."""
    analysis_type: Optional[str] = None
    analytics_dsl: Optional[str] = None
    query_dsl: Optional[str] = Field(None, description="Deprecated alias for analytics_dsl (backward compat)")
    what_if_dsl: Optional[str] = None


class ChartRecipeScenario(BaseModel):
    """Shared chart recipe: scenario entry. Used by both canvas analyses and chart files."""
    scenario_id: str
    effective_dsl: Optional[str] = None
    name: Optional[str] = None
    colour: Optional[str] = None
    visibility_mode: Optional[str] = None
    is_live: Optional[bool] = None


class ChartRecipeCore(BaseModel):
    """Shared chart recipe core — defines what to compute. Used by canvas analyses (directly) and chart files (wrapped)."""
    analysis: ChartRecipeAnalysis
    scenarios: Optional[List[ChartRecipeScenario]] = None


class CanvasAnalysisDisplay(BaseModel, extra='allow'):
    """Display settings for a canvas analysis — extensible, preserves unknown fields."""
    hide_current: Optional[bool] = None
    hidden_scenarios: Optional[List[str]] = None


class ContentItem(BaseModel, extra='allow'):
    """A single content tab inside a canvas analysis container.
    Content items are the unit of authority — they own all analysis, display,
    and scenario state. The container owns only placement."""
    id: str
    analysis_type: str = ''
    view_type: str = 'chart'
    kind: Optional[str] = None
    title: Optional[str] = None
    display: Optional[CanvasAnalysisDisplay] = None
    analysis_type_overridden: Optional[bool] = None
    analytics_dsl: Optional[str] = None
    chart_current_layer_dsl: Optional[str] = None
    mode: str = Field('live', pattern=r"^(live|custom|fixed)$")
    scenarios: Optional[List[dict]] = None
    what_if_dsl: Optional[str] = None

    @model_validator(mode='before')
    @classmethod
    def migrate_legacy_fields(cls, data: Any) -> Any:
        """Migrate legacy chart_kind / facet → kind."""
        if isinstance(data, dict):
            if 'kind' not in data or data['kind'] is None:
                data['kind'] = data.pop('facet', None) or data.pop('chart_kind', None)
            else:
                data.pop('facet', None)
                data.pop('chart_kind', None)
            if 'mode' not in data:
                data['mode'] = 'live'
        return data


class CanvasAnalysis(BaseModel):
    """Canvas analysis container — pure placement + tab list.
    All analysis, display, and scenario state lives on content items."""
    id: str
    x: float
    y: float
    width: float = Field(..., gt=0)
    height: float = Field(..., gt=0)
    content_items: List[ContentItem] = Field(..., min_length=1)
    minimised: Optional[bool] = None
    minimised_anchor: Optional[Literal["tl", "tr", "bl", "br"]] = None

    @model_validator(mode='before')
    @classmethod
    def migrate_legacy_flat_fields(cls, data: Any) -> Any:
        """Migrate legacy container flat fields into content_items on load."""
        if not isinstance(data, dict):
            return data

        # Handle legacy live: bool → mode
        if 'live' in data and 'mode' not in data:
            data['mode'] = 'live' if data.pop('live') else 'fixed'

        items = data.get('content_items') or []

        # If no content items, synthesise one from flat fields
        if not items:
            recipe = data.get('recipe') or {}
            analysis = recipe.get('analysis') or {}
            items = [{
                'id': f"{data.get('id', 'unknown')}-content-0",
                'analysis_type': analysis.get('analysis_type', ''),
                'view_type': data.get('view_mode', 'chart'),
                'kind': data.get('chart_kind'),
                'title': data.get('title'),
                'display': data.get('display'),
                'analysis_type_overridden': data.get('analysis_type_overridden'),
                'analytics_dsl': analysis.get('analytics_dsl'),
                'chart_current_layer_dsl': data.get('chart_current_layer_dsl'),
                'mode': data.get('mode', 'live'),
                'scenarios': recipe.get('scenarios'),
                'what_if_dsl': analysis.get('what_if_dsl'),
            }]

        # Backfill defaults and migrate container fields into items[0]
        recipe = data.get('recipe') or {}
        analysis_block = recipe.get('analysis') or {}
        container_dsl = analysis_block.get('analytics_dsl')
        container_layer_dsl = data.get('chart_current_layer_dsl')
        container_mode = data.get('mode', 'live')
        container_scenarios = recipe.get('scenarios')

        for i, item in enumerate(items):
            if not item.get('analytics_dsl') and container_dsl:
                item['analytics_dsl'] = container_dsl
            if not item.get('chart_current_layer_dsl') and container_layer_dsl:
                item['chart_current_layer_dsl'] = container_layer_dsl
            if 'mode' not in item:
                item['mode'] = container_mode if i == 0 else 'live'
            if i == 0 and not item.get('scenarios') and container_scenarios:
                item['scenarios'] = container_scenarios
                if not item.get('what_if_dsl'):
                    item['what_if_dsl'] = analysis_block.get('what_if_dsl')

        data['content_items'] = items

        # Strip legacy flat fields from container
        for key in ['recipe', 'mode', 'view_mode', 'chart_kind', 'title', 'display',
                     'chart_current_layer_dsl', 'analysis_type_overridden', 'live']:
            data.pop(key, None)

        return data


class CanvasViewObjectState(BaseModel):
    """Min/max state of a single canvas object within a saved view."""
    id: str
    type: Literal["postit", "analysis"]
    minimised: bool
    anchor: Optional[Literal["tl", "tr", "bl", "br"]] = None


class CanvasViewViewport(BaseModel):
    """Saved viewport position and zoom for a canvas view."""
    x: float
    y: float
    zoom: float


class CanvasViewLayerVisibility(BaseModel):
    """Visibility and display mode for a pseudo-scenario layer (Current or Base)."""
    visible: bool
    visibility_mode: Optional[Literal["f+e", "f", "e"]] = None


class CanvasViewScenario(BaseModel, extra='allow'):
    """Blueprint for recreating a user scenario from a canvas view."""
    queryDSL: Optional[str] = None
    params: Optional[dict] = None
    name: str
    colour: str
    is_live: bool
    visible: bool
    order: int
    visibility_mode: Optional[Literal["f+e", "f", "e"]] = None
    whatIfDSL: Optional[str] = None


class CanvasView(BaseModel):
    """Named saved layout state for canvas objects."""
    id: str
    name: str
    states: List[CanvasViewObjectState] = Field(default_factory=list)
    viewport: Optional[CanvasViewViewport] = None
    locked: Optional[bool] = None
    viewOverlayMode: Optional[Literal["none", "forecast-quality", "data-depth"]] = None
    sankey: Optional[bool] = None
    currentLayer: Optional[CanvasViewLayerVisibility] = None
    baseLayer: Optional[CanvasViewLayerVisibility] = None
    scenarios: Optional[List[CanvasViewScenario]] = None
    applyScenarios: Optional[bool] = None
    applyLayout: Optional[bool] = None
    applyDisplayMode: Optional[bool] = None


class Graph(BaseModel):
    """Complete conversion funnel graph."""
    model_config = ConfigDict(populate_by_name=True)

    nodes: List[Node] = Field(..., min_length=1)
    edges: List[Edge]
    policies: Policies
    metadata: Metadata
    postits: Optional[List[PostIt]] = Field(None, description="Canvas annotations: sticky notes (visual only, not graph semantics)")
    containers: Optional[List[Container]] = Field(None, description="Canvas annotations: grouping rectangles (visual only, not graph semantics)")
    canvasAnalyses: Optional[List[CanvasAnalysis]] = Field(None, description="Canvas annotations: live analyses pinned to the canvas")
    canvasViews: Optional[List['CanvasView']] = Field(None, description="Named saved layout states for canvas objects (min/max configurations)")
    baseDSL: Optional[str] = Field(None, description="Base DSL that is always applied (e.g. global context filters)")
    currentQueryDSL: Optional[str] = Field(None, description="Current user query DSL for UI persistence")
    dataInterestsDSL: Optional[str] = Field(None, description="Pinned DSL for batch/overnight fetches")
    debugging: Optional[bool] = Field(None, description="If true, run Graph Issues checks while this graph is open and show an Issues indicator overlay.")
    dailyFetch: Optional[bool] = Field(None, description="If true, this graph is included in unattended daily automation runs when ?retrieveall is used without an explicit graph list.")
    defaultConnection: Optional[str] = Field(None, description="Default connection for all edges. Fallback when edge-level connection is not set (e.g. 'amplitude-prod').")
    model_source_preference: Optional[Literal['best_available', 'bayesian', 'analytic_be', 'analytic']] = Field(None, description="Graph-level default for which model var source to promote to scalars (doc 15 §2.3)")
    bayes: Optional[BayesRunMetadata] = Field(None, alias='_bayes', description="Metadata from the most recent Bayesian fitting run")
    
    def get_node_by_id(self, node_id: str) -> Optional[Node]:
        """Get node by ID or UUID."""
        for node in self.nodes:
            if node.id == node_id or node.uuid == node_id:
                return node
        return None
    
    def get_edge_by_id(self, edge_id: str) -> Optional[Edge]:
        """Get edge by ID, UUID, or from->to string."""
        for edge in self.edges:
            if edge.uuid == edge_id:
                return edge
            if edge.id and edge.id == edge_id:
                return edge
            if f"{edge.from_node}->{edge.to}" == edge_id:
                return edge
        return None
    
    def get_outgoing_edges(self, node_id: str) -> List[Edge]:
        """Get all edges leaving a node (by ID or UUID)."""
        return [e for e in self.edges if e.from_node == node_id]
    
    def get_incoming_edges(self, node_id: str) -> List[Edge]:
        """Get all edges entering a node (by ID or UUID)."""
        return [e for e in self.edges if e.to == node_id]


# ============================================================================
# Query DSL Types
# ============================================================================

class QueryFunction(BaseModel):
    """
    Parsed query DSL function.
    
    Query DSL functions:
    - from(node-id): Source node
    - to(node-id): Target node
    - visited(node-a,node-b): Nodes that must be visited
    - exclude(node-c): Nodes that must NOT be visited
    - case(test-id:variant): Case/experiment variant filter
    - context(key:value): Context constraint (e.g., device:mobile)
    """
    function: Literal["from", "to", "visited", "exclude", "case", "context"]
    args: List[str] = Field(..., description="Function arguments (node IDs or key:value pairs)")
    
    @property
    def raw(self) -> str:
        """Get raw DSL string for this function."""
        args_str = ",".join(self.args)
        return f"{self.function}({args_str})"


class ParsedQuery(BaseModel):
    """
    Parsed query DSL expression.
    
    Full query format: from(a).to(b).visited(c).exclude(d)
    Condition format (constraint only): visited(c).exclude(d)
    """
    raw: str = Field(..., description="Original query string")
    functions: List[QueryFunction] = Field(..., description="Parsed functions in order")
    
    def get_function(self, func_type: str) -> Optional[QueryFunction]:
        """Get first function of specified type."""
        for func in self.functions:
            if func.function == func_type:
                return func
        return None
    
    def get_all_functions(self, func_type: str) -> List[QueryFunction]:
        """Get all functions of specified type."""
        return [f for f in self.functions if f.function == func_type]
