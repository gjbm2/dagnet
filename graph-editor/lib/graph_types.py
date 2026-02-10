"""
Graph data type definitions using Pydantic

Generated from: conversion-graph-1.1.0.json
Source: /home/gjbm2/dev/dagnet/graph-editor/public/schemas/conversion-graph-1.1.0.json

These models match the official JSON schema exactly for validation
of all Python graph operations.
"""

from typing import List, Dict, Any, Optional, Literal, Union
from datetime import datetime
from pydantic import BaseModel, Field, ConfigDict, field_validator


# ============================================================================
# Core Parameters
# ============================================================================

class Evidence(BaseModel):
    """Observations from data sources (n/k for probabilities)."""
    n: Optional[int] = Field(None, ge=0, description="Sample size (total trials)")
    k: Optional[int] = Field(None, ge=0, description="Number of successes")
    mean: Optional[float] = Field(None, ge=0, description="Evidence probability: raw observed rate = k/n (query-time computed scalar)")
    stdev: Optional[float] = Field(None, ge=0, description="Evidence uncertainty: binomial stdev for the evidence rate (query-time computed scalar)")
    window_from: Optional[str] = Field(None, description="Time window start (UK format: d-MMM-yy or ISO)")
    window_to: Optional[str] = Field(None, description="Time window end (UK format: d-MMM-yy or ISO)")
    retrieved_at: Optional[str] = Field(None, description="When this data was retrieved (UK format or ISO)")
    source: Optional[str] = Field(None, description="Connection name used for this retrieval")
    path: Optional[Literal["direct", "file"]] = Field(None, description="How this data was retrieved: 'direct' = fetched directly from connection, 'file' = synced from parameter file")
    full_query: Optional[str] = Field(None, description="Complete DSL query string used for this fetch (includes base query + window + context)")
    debug_trace: Optional[str] = Field(None, description="Complete execution trace as JSON string for debugging/provenance")
    
    @field_validator('window_from', 'window_to', 'retrieved_at', mode='before')
    @classmethod
    def convert_datetime_to_str(cls, v):
        """Accept both datetime and str, convert datetime to ISO string."""
        if isinstance(v, datetime):
            return v.isoformat()
        return v


class DataSource(BaseModel):
    """Provenance information for parameter data."""
    type: str = Field(..., description="Data source type (from connections.yaml, e.g., 'amplitude', 'manual', 'sheets')")
    retrieved_at: Optional[str] = Field(None, description="When data was retrieved (UK format or ISO)")
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
    onset_delta_days: Optional[float] = Field(None, ge=0, description="Onset delay in days - minimum time before conversions begin (aggregated from window slices)")
    onset_delta_days_overridden: bool = Field(False, description="If true, user manually set onset_delta_days")
    median_lag_days: Optional[float] = Field(None, ge=0, description="Weighted median lag in days (display only)")
    mean_lag_days: Optional[float] = Field(None, ge=0, description="Weighted mean lag in days (used with median to compute t95)")
    completeness: Optional[float] = Field(None, ge=0, le=1, description="Maturity progress 0-1 (display only)")
    mu: Optional[float] = Field(None, description="Fitted log-normal mu parameter (internal, not UI-exposed)")
    sigma: Optional[float] = Field(None, ge=0, description="Fitted log-normal sigma parameter (internal, not UI-exposed)")
    model_trained_at: Optional[str] = Field(None, description="UK date (d-MMM-yy) when the model was last fitted (staleness detection)")


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


class Graph(BaseModel):
    """Complete conversion funnel graph."""
    nodes: List[Node] = Field(..., min_length=1)
    edges: List[Edge]
    policies: Policies
    metadata: Metadata
    baseDSL: Optional[str] = Field(None, description="Base DSL that is always applied (e.g. global context filters)")
    currentQueryDSL: Optional[str] = Field(None, description="Current user query DSL for UI persistence")
    dataInterestsDSL: Optional[str] = Field(None, description="Pinned DSL for batch/overnight fetches")
    debugging: Optional[bool] = Field(None, description="If true, run Graph Issues checks while this graph is open and show an Issues indicator overlay.")
    dailyFetch: Optional[bool] = Field(None, description="If true, this graph is included in unattended daily automation runs when ?retrieveall is used without an explicit graph list.")
    
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
