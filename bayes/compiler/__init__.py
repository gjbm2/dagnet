"""
DagNet Bayes compiler — graph-to-model pipeline.

Three-function boundary:
  1. analyse_topology(graph_snapshot) → TopologyAnalysis
  2. bind_evidence(topology, param_files, settings) → BoundEvidence
  3. build_model(topology, evidence) → pm.Model

Only build_model imports PyMC. Everything else is pure Python.
"""

from .topology import analyse_topology
from .evidence import bind_evidence, bind_snapshot_evidence
from .model import build_model
from .inspect_model import inspect_model
from .inference import run_inference, summarise_posteriors
from .types import (
    TopologyAnalysis,
    BoundEvidence,
    EdgeTopology,
    BranchGroup,
    PathLatency,
    EdgeEvidence,
    WindowObservation,
    CohortObservation,
    CohortDailyObs,
    CohortDailyTrajectory,
    ProbabilityPrior,
    LatencyPrior,
    PosteriorSummary,
    LatencyPosteriorSummary,
    InferenceResult,
    QualityMetrics,
)

__all__ = [
    "analyse_topology",
    "bind_evidence",
    "bind_snapshot_evidence",
    "build_model",
    "inspect_model",
    "run_inference",
    "summarise_posteriors",
    "TopologyAnalysis",
    "BoundEvidence",
    "EdgeTopology",
    "BranchGroup",
    "PathLatency",
    "EdgeEvidence",
    "WindowObservation",
    "CohortObservation",
    "CohortDailyObs",
    "CohortDailyTrajectory",
    "ProbabilityPrior",
    "LatencyPrior",
    "PosteriorSummary",
    "LatencyPosteriorSummary",
    "InferenceResult",
    "QualityMetrics",
]
