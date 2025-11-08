"""
Graph data type definitions using Pydantic

Generated from: conversion-graph-1.0.0.json
Source: /home/reg/dev/dagnet/graph-editor/public/schemas/schema/conversion-graph-1.0.0.json

These models match the official JSON schema exactly for validation
of all Python graph operations.
"""

from typing import List, Dict, Any, Optional, Literal
from pydantic import BaseModel, Field
from datetime import datetime


# ============================================================================
# Core Parameters
# ============================================================================

class Evidence(BaseModel):
    """Observations from data sources (n/k for probabilities)."""
    n: Optional[int] = Field(None, ge=0, description="Sample size (total trials)")
    k: Optional[int] = Field(None, ge=0, description="Number of successes")
    window_from: Optional[datetime] = Field(None, description="Time window start")
    window_to: Optional[datetime] = Field(None, description="Time window end")
    retrieved_at: datetime = Field(..., description="When this data was retrieved")
    source: Literal["amplitude", "sheets", "manual", "computed", "api"]
    query: Optional[Dict[str, Any]] = Field(None, description="Query that produced this data")


class DataSource(BaseModel):
    """Connection settings for external data retrieval."""
    source_type: str
    connection_settings: Optional[str] = Field(None, description="JSON blob with source-specific settings")
    connection_overridden: bool = Field(False, description="If true, these settings override parameter file")


class ProbabilityParam(BaseModel):
    """Probability parameter: p.mean is P(to|from)."""
    mean: Optional[float] = Field(None, ge=0, le=1, description="Probability value")
    mean_overridden: bool = Field(False, description="If true, mean was manually edited")
    stdev: Optional[float] = Field(None, ge=0, description="Standard deviation")
    stdev_overridden: bool = Field(False, description="If true, stdev was manually edited")
    distribution: Optional[Literal["normal", "beta", "uniform"]] = Field("beta", description="Distribution type")
    distribution_overridden: bool = Field(False, description="If true, distribution was manually edited")
    evidence: Optional[Evidence] = None
    id: Optional[str] = Field(None, description="Reference to parameter file (FK to parameter-{id}.yaml)")
    locked: Optional[bool] = Field(None, deprecated=True, description="DEPRECATED: Use mean_overridden instead")
    data_source: Optional[DataSource] = None


class CostParam(BaseModel):
    """Cost parameter (monetary or time)."""
    mean: float = Field(..., ge=0)
    mean_overridden: bool = Field(False, description="If true, mean was manually edited")
    stdev: Optional[float] = Field(None, ge=0)
    stdev_overridden: bool = Field(False, description="If true, stdev was manually edited")
    distribution: Optional[Literal["normal", "lognormal", "gamma", "uniform", "beta"]] = Field("normal")
    distribution_overridden: bool = Field(False, description="If true, distribution was manually edited")
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
    query: Optional[str] = Field(None, pattern=r"^from\([a-z0-9_-]+\)\.to\([a-z0-9_-]+\)", description="Full data retrieval query")
    query_overridden: bool = Field(False, description="If true, query was manually edited")
    p: ProbabilityParam


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
    uuid: str
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
    color: Optional[str] = Field(None, pattern=r"^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$")


class Node(BaseModel):
    """
    Graph node representing a state in the conversion funnel.
    """
    uuid: str
    id: str = Field(..., min_length=1, max_length=128)
    label: Optional[str] = Field(None, max_length=256)
    label_overridden: bool = Field(False, description="If true, label was manually edited")
    description: Optional[str] = None
    description_overridden: bool = Field(False, description="If true, description was manually edited")
    event: Optional[EventReference] = None
    tags: Optional[List[str]] = None
    absorbing: bool = Field(False, description="If true, node is terminal (zero outgoing edges)")
    outcome_type: Optional[Literal["success", "failure", "error", "neutral", "other"]] = None
    entry: Optional[Entry] = None
    costs: Optional[Dict[str, Any]] = Field(None, deprecated=True, description="DEPRECATED: Use edge costs")
    residual_behavior: Optional[ResidualBehavior] = None
    case: Optional[Case] = None
    layout: Optional[Layout] = None


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
    uuid: str
    id: Optional[str] = Field(None, min_length=1, max_length=128)
    from_node: str = Field(..., alias='from', min_length=1, description="Source node uuid or id")
    to: str = Field(..., min_length=1, description="Target node uuid or id")
    fromHandle: Optional[Literal["left", "right", "top", "bottom", "left-out", "right-out", "top-out", "bottom-out"]] = None
    toHandle: Optional[Literal["left", "right", "top", "bottom"]] = None
    label: Optional[str] = Field(None, max_length=256)
    label_overridden: bool = Field(False, description="If true, label was manually edited")
    description: Optional[str] = None
    description_overridden: bool = Field(False, description="If true, description was manually edited")
    query: Optional[str] = Field(None, pattern=r"^from\([a-z0-9_-]+\)\.to\([a-z0-9_-]+\)", description="Query expression for data retrieval")
    query_overridden: bool = Field(False, description="If true, query was manually edited")
    p: ProbabilityParam = Field(..., description="Base probability (fallback when no conditionals match)")
    conditional_p: Optional[List[ConditionalProbability]] = Field(None, description="Conditional probabilities (first match wins)")
    weight_default: Optional[float] = Field(None, ge=0, description="Weight for distributing residual probability")
    cost_gbp: Optional[CostParam] = None
    cost_time: Optional[CostParam] = None
    case_variant: Optional[str] = Field(None, max_length=128, description="Variant name (case edges only)")
    case_id: Optional[str] = Field(None, description="Parent case node ID (case edges only)")
    display: Optional[EdgeDisplay] = None
    
    class Config:
        populate_by_name = True


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
    created_at: datetime
    updated_at: Optional[datetime] = None
    author: Optional[str] = Field(None, max_length=256)
    description: Optional[str] = None
    tags: Optional[List[str]] = None


class Graph(BaseModel):
    """Complete conversion funnel graph."""
    nodes: List[Node] = Field(..., min_items=1)
    edges: List[Edge]
    policies: Policies
    metadata: Metadata
    
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
