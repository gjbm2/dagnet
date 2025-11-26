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
# Response Types
# ============================================================================

class AnalysisResult(BaseModel):
    """Analysis result for a single scenario."""
    scenario_id: str = Field(description="Scenario identifier")
    analysis_type: str = Field(description="Matched analysis type ID")
    analysis_name: str = Field(description="Human-readable analysis name")
    analysis_description: str = Field(default="", description="Analysis description")
    data: dict[str, Any] = Field(
        default_factory=dict,
        description="Analysis-specific result data (JSON)"
    )


class AnalysisResponse(BaseModel):
    """Response from analytics computation."""
    success: bool = Field(default=True, description="Whether analysis succeeded")
    results: list[AnalysisResult] = Field(
        default_factory=list,
        description="Results per scenario"
    )
    query_dsl: Optional[str] = Field(default=None, description="The DSL query used")
    error: Optional[dict[str, Any]] = Field(
        default=None,
        description="Error details if success=False"
    )


# ============================================================================
# Legacy Types (for backwards compatibility)
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

