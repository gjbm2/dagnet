"""
Analytics Runner Types

Pydantic models for analytics API request/response.

Design Reference: /docs/current/project-analysis/PHASE_1_DESIGN.md
"""

from typing import Optional, Any
from pydantic import BaseModel, Field


# ============================================================================
# Request Types
# ============================================================================

class ScenarioData(BaseModel):
    """Graph data for a single scenario."""
    scenario_id: str = Field(default="base", description="Unique scenario identifier")
    name: Optional[str] = Field(default=None, description="Human-readable scenario name")
    colour: Optional[str] = Field(default=None, description="Hex colour code for scenario")
    graph: dict[str, Any] = Field(description="Full graph data (nodes, edges, policies, metadata)")
    param_overrides: dict[str, Any] = Field(
        default_factory=dict,
        description="Parameter overrides for this scenario"
    )


class AnalysisRequest(BaseModel):
    """Request to analyze a graph.
    
    The query DSL determines what to analyze:
    - Full path: "from(a).to(b).visited(c)"
    - Partial: "from(a).visitedAny(b,c)"
    - Constraints only: "visited(x).visited(y)"
    - Empty: graph overview
    """
    scenarios: list[ScenarioData] = Field(
        description="Scenarios to analyze (each contains its own graph data)"
    )
    query_dsl: Optional[str] = Field(
        default=None,
        description="DSL query string (determines analysis type)"
    )
    analysis_type: Optional[str] = Field(
        default=None,
        description="Override automatic analysis type selection"
    )


# ============================================================================
# Response Types - Declarative Schema
# See: /docs/current/project-analysis/ANALYSIS_RETURN_SCHEMA.md
# ============================================================================

class DimensionSpec(BaseModel):
    """Specification for a data dimension."""
    id: str = Field(description="Field name in data rows")
    name: str = Field(description="Human-readable label")
    type: str = Field(description="Semantic type: scenario, stage, outcome, node, time, categorical, ordinal")
    role: str = Field(default="primary", description="Role: primary, secondary, filter")


class MetricSpec(BaseModel):
    """Specification for a metric."""
    id: str = Field(description="Field name in data rows")
    name: str = Field(description="Human-readable label")
    type: str = Field(description="Semantic type: probability, currency, duration, count, ratio, delta")
    format: Optional[str] = Field(default=None, description="Display format: percent, currency_gbp, number")
    role: Optional[str] = Field(default=None, description="Visual role: primary, secondary")


class ChartSpec(BaseModel):
    """Chart rendering specification."""
    recommended: str = Field(description="Recommended chart type: funnel, bar, bar_grouped, line, table, comparison, single_value")
    alternatives: list[str] = Field(default_factory=list, description="Alternative valid chart types")
    hints: dict[str, Any] = Field(default_factory=dict, description="Chart-specific hints")


class ResultSemantics(BaseModel):
    """How to interpret and render the data."""
    dimensions: list[DimensionSpec] = Field(description="Data dimensions")
    metrics: list[MetricSpec] = Field(description="Data metrics")
    chart: ChartSpec = Field(description="Chart specification")


class DimensionValueMeta(BaseModel):
    """Metadata for a dimension value."""
    name: str = Field(description="Human-readable label")
    colour: Optional[str] = Field(default=None, description="Hex colour code")
    order: Optional[int] = Field(default=None, description="Sort order")


class AnalysisResult(BaseModel):
    """Analysis result with declarative schema.
    
    See: /docs/current/project-analysis/ANALYSIS_RETURN_SCHEMA.md
    """
    # Identity
    analysis_type: str = Field(description="Matched analysis type ID")
    analysis_name: str = Field(description="Human-readable analysis name")
    analysis_description: str = Field(default="", description="Analysis description")
    
    # Static context
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Analysis-specific context that doesn't vary by dimension"
    )
    
    # How to interpret the data
    semantics: Optional[ResultSemantics] = Field(
        default=None,
        description="Declarative schema for rendering"
    )
    
    # Per-dimension-value metadata
    dimension_values: dict[str, dict[str, DimensionValueMeta]] = Field(
        default_factory=dict,
        description="Metadata per dimension value (labels, colours, order)"
    )
    
    # The actual data
    data: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Data rows with dimension and metric values"
    )


class AnalysisResponse(BaseModel):
    """Response from analytics computation."""
    success: bool = Field(default=True, description="Whether analysis succeeded")
    result: Optional[AnalysisResult] = Field(
        default=None,
        description="Analysis result"
    )
    query_dsl: Optional[str] = Field(default=None, description="The DSL query used")
    error: Optional[dict[str, Any]] = Field(
        default=None,
        description="Error details if success=False"
    )


# ============================================================================
# Supporting Types (used by what-if and path analysis)
# ============================================================================

class CostResult(BaseModel):
    """Cost breakdown for a path or selection."""
    monetary: float = Field(default=0.0, description="Monetary cost (GBP)")
    time: float = Field(default=0.0, description="Time cost")
    units: str = Field(default="days", description="Time units")


class WhatIfOverrides(BaseModel):
    """What-if override structure for analytics."""
    case_overrides: dict[str, str] = Field(
        default_factory=dict,
        description="Case node ID -> variant name mapping"
    )
    conditional_overrides: dict[str, dict[str, Any]] = Field(
        default_factory=dict,
        description="Edge ID -> {condition, active} mapping"
    )
    probability_overrides: dict[str, float] = Field(
        default_factory=dict,
        description="Edge ID -> probability override"
    )


class AnalysisError(BaseModel):
    """Error response from analytics."""
    error: bool = Field(default=True)
    error_type: str = Field(description="Error category: validation_error, parse_error, compute_error")
    message: str = Field(description="Human-readable error message")
    details: dict[str, Any] = Field(
        default_factory=dict,
        description="Additional error context"
    )

