"""
Bayes inference engine — MCMC/NUTS loop for conversion graph posteriors.

This module owns the three core operations:
  1. build_model()  — EdgeFit[] → pm.Model
  2. run_inference() — pm.Model → InferenceData (NUTS sampling + convergence)
  3. summarise()     — InferenceData → EdgePosterior[] (plain-dict artefacts)

Design principles (from reference implementation notes, doc 2):
  - Variable naming: p_{edge_id} / obs_{edge_id} for traceability
  - Prior overflow guard: cap Beta params at 500, fall back to weak prior
  - Artefact boundary: only plain Python types cross out of this module
  - Convergence gate: max(rhat) < 1.05 and min(ESS) >= 400
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np


# ---------------------------------------------------------------------------
# Types — plain dataclasses, no PyMC dependency
# ---------------------------------------------------------------------------

MAX_PRIOR_COUNTS = 500  # Prior overflow guard (ref impl §2.2)

DEFAULT_DRAWS = 2000
DEFAULT_TUNE = 1000
DEFAULT_CHAINS = 4
DEFAULT_TARGET_ACCEPT = 0.90
HDI_PROB = 0.90

# Convergence thresholds
RHAT_THRESHOLD = 1.05
ESS_THRESHOLD = 400


@dataclass
class BetaPrior:
    alpha: float = 1.0
    beta: float = 1.0

    def __post_init__(self):
        """Apply overflow guard: if prior is too informative, weaken it."""
        if self.alpha + self.beta > MAX_PRIOR_COUNTS:
            self.alpha = 2.0
            self.beta = 2.0


@dataclass
class EdgeFit:
    """Compiler output for a single edge — input to the model builder."""
    edge_id: str
    param_id: str
    prior: BetaPrior
    total_n: int          # observed trials (mature)
    total_k: int          # observed successes (mature)
    completeness: float = 1.0  # completeness weight [0, 1]

    @property
    def effective_n(self) -> int:
        return int(self.total_n * self.completeness)

    @property
    def effective_k(self) -> int:
        return int(self.total_k * self.completeness)


@dataclass
class SamplingConfig:
    draws: int = DEFAULT_DRAWS
    tune: int = DEFAULT_TUNE
    chains: int = DEFAULT_CHAINS
    cores: int = DEFAULT_CHAINS
    target_accept: float = DEFAULT_TARGET_ACCEPT
    random_seed: int | None = None


@dataclass
class QualityMetrics:
    max_rhat: float
    min_ess: float
    converged: bool
    n_divergences: int = 0


@dataclass
class EdgePosterior:
    """Plain-dict artefact for one edge. No PyMC/ArviZ objects."""
    edge_id: str
    param_id: str
    alpha: float
    beta: float
    mean: float
    stdev: float
    hdi_lower: float
    hdi_upper: float
    hdi_level: float
    ess: float
    rhat: float
    provenance: str   # "bayesian" | "pooled-fallback" | "point-estimate"

    def to_dict(self) -> dict[str, Any]:
        return {
            "edge_id": self.edge_id,
            "param_id": self.param_id,
            "alpha": self.alpha,
            "beta": self.beta,
            "mean": self.mean,
            "stdev": self.stdev,
            "hdi_lower": self.hdi_lower,
            "hdi_upper": self.hdi_upper,
            "hdi_level": self.hdi_level,
            "ess": self.ess,
            "rhat": self.rhat,
            "provenance": self.provenance,
        }


@dataclass
class InferenceResult:
    """Complete result of an inference run. Plain Python types only."""
    edges: list[EdgePosterior]
    quality: QualityMetrics
    diagnostics: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "edges": [e.to_dict() for e in self.edges],
            "quality": {
                "max_rhat": self.quality.max_rhat,
                "min_ess": self.quality.min_ess,
                "converged": self.quality.converged,
                "n_divergences": self.quality.n_divergences,
            },
            "diagnostics": self.diagnostics,
        }


# ---------------------------------------------------------------------------
# 1. Model builder — EdgeFit[] → pm.Model
# ---------------------------------------------------------------------------

def build_model(edges: list[EdgeFit]):
    """Build a PyMC model from compiler edge fits.

    Phase A: independent Beta-Binomial per edge.
    Each edge gets:
      p_{edge_id} ~ Beta(alpha, beta)
      obs_{edge_id} ~ Binomial(n=effective_n, p=p_{edge_id}, observed=effective_k)

    Edges with no observations (effective_n == 0) get a prior-only variable —
    the posterior will equal the prior.
    """
    import pymc as pm

    with pm.Model() as model:
        for edge in edges:
            p = pm.Beta(
                f"p_{edge.edge_id}",
                alpha=edge.prior.alpha,
                beta=edge.prior.beta,
            )
            if edge.effective_n > 0:
                pm.Binomial(
                    f"obs_{edge.edge_id}",
                    n=edge.effective_n,
                    p=p,
                    observed=edge.effective_k,
                )

    return model


# ---------------------------------------------------------------------------
# 2. Inference runner — pm.Model → InferenceData
# ---------------------------------------------------------------------------

def run_inference(model, config: SamplingConfig | None = None):
    """Run NUTS sampling on the model. Returns (InferenceData, QualityMetrics).

    The NUTS sampler:
      - Tune phase: adapts step size and mass matrix (not kept in trace)
      - Draw phase: produces posterior samples
      - Multiple chains: run in parallel for convergence diagnostics

    Convergence is assessed via:
      - R-hat < 1.05 for all parameters (chains mixed well)
      - ESS >= 400 for all parameters (enough effective samples)
      - No excessive divergences (sampler didn't hit pathological geometry)
    """
    import pymc as pm
    import arviz as az

    if config is None:
        config = SamplingConfig()

    with model:
        trace = pm.sample(
            draws=config.draws,
            tune=config.tune,
            chains=config.chains,
            cores=config.cores,
            target_accept=config.target_accept,
            return_inferencedata=True,
            random_seed=config.random_seed,
            progressbar=True,
        )

    # --- Convergence diagnostics ---
    rhat_ds = az.rhat(trace)
    ess_ds = az.ess(trace)

    # Extract max rhat and min ESS across all parameters
    rhat_values = []
    ess_values = []
    for var_name in rhat_ds.data_vars:
        rhat_values.append(float(rhat_ds[var_name].values))
        ess_values.append(float(ess_ds[var_name].values))

    max_rhat = max(rhat_values) if rhat_values else 0.0
    min_ess = min(ess_values) if ess_values else 0.0

    # Count divergences
    n_divergences = 0
    if hasattr(trace, "sample_stats") and "diverging" in trace.sample_stats:
        n_divergences = int(trace.sample_stats["diverging"].values.sum())

    converged = max_rhat < RHAT_THRESHOLD and min_ess >= ESS_THRESHOLD

    quality = QualityMetrics(
        max_rhat=max_rhat,
        min_ess=min_ess,
        converged=converged,
        n_divergences=n_divergences,
    )

    return trace, quality


# ---------------------------------------------------------------------------
# 3. Posterior summarisation — InferenceData → EdgePosterior[]
# ---------------------------------------------------------------------------

def _fit_beta_to_samples(samples: np.ndarray) -> tuple[float, float]:
    """Moment-match a Beta distribution to posterior samples.

    Method of moments:
      mean = alpha / (alpha + beta)
      var  = alpha * beta / ((alpha + beta)^2 * (alpha + beta + 1))

    Solving:
      alpha = mean * ((mean * (1 - mean) / var) - 1)
      beta  = (1 - mean) * ((mean * (1 - mean) / var) - 1)
    """
    mean = float(np.mean(samples))
    var = float(np.var(samples))

    if var <= 0 or mean <= 0 or mean >= 1:
        # Degenerate — return weakly informative
        return 1.0, 1.0

    common = (mean * (1 - mean) / var) - 1
    if common <= 0:
        return 1.0, 1.0

    alpha = mean * common
    beta = (1 - mean) * common
    return float(alpha), float(beta)


def summarise(trace, edges: list[EdgeFit], quality: QualityMetrics) -> InferenceResult:
    """Extract plain-dict posteriors from the MCMC trace.

    For each edge:
      - Flatten posterior samples across chains
      - Moment-match a Beta(alpha, beta)
      - Compute 90% HDI
      - Extract per-variable ESS and R-hat
      - Assign provenance based on convergence
    """
    import arviz as az

    rhat_ds = az.rhat(trace)
    ess_ds = az.ess(trace)

    edge_posteriors = []
    diagnostics = []

    for edge in edges:
        var_name = f"p_{edge.edge_id}"

        if var_name not in trace.posterior:
            diagnostics.append(f"SKIP {edge.edge_id}: variable {var_name} not in trace")
            continue

        samples = trace.posterior[var_name].values.flatten()

        # Moment-match Beta
        alpha, beta = _fit_beta_to_samples(samples)

        # HDI
        hdi = az.hdi(trace, var_names=[var_name], hdi_prob=HDI_PROB)
        hdi_lower = float(hdi[var_name].values[0])
        hdi_upper = float(hdi[var_name].values[1])

        # Per-variable diagnostics
        edge_rhat = float(rhat_ds[var_name].values) if var_name in rhat_ds else 0.0
        edge_ess = float(ess_ds[var_name].values) if var_name in ess_ds else 0.0

        # Provenance
        edge_converged = edge_rhat < RHAT_THRESHOLD and edge_ess >= ESS_THRESHOLD
        if edge.effective_n == 0:
            provenance = "point-estimate"
        elif edge_converged:
            provenance = "bayesian"
        else:
            provenance = "pooled-fallback"
            diagnostics.append(
                f"WARN {edge.edge_id}: rhat={edge_rhat:.3f} ess={edge_ess:.0f} — not converged"
            )

        edge_posteriors.append(EdgePosterior(
            edge_id=edge.edge_id,
            param_id=edge.param_id,
            alpha=alpha,
            beta=beta,
            mean=float(np.mean(samples)),
            stdev=float(np.std(samples)),
            hdi_lower=hdi_lower,
            hdi_upper=hdi_upper,
            hdi_level=HDI_PROB,
            ess=edge_ess,
            rhat=edge_rhat,
            provenance=provenance,
        ))

    return InferenceResult(
        edges=edge_posteriors,
        quality=quality,
        diagnostics=diagnostics,
    )


# ---------------------------------------------------------------------------
# Convenience: run full pipeline
# ---------------------------------------------------------------------------

def fit_edges(
    edges: list[EdgeFit],
    config: SamplingConfig | None = None,
) -> InferenceResult:
    """Full pipeline: build → sample → summarise.

    This is the main entry point. Takes compiler output (EdgeFit[]),
    returns plain-dict posteriors ready for the webhook payload.
    """
    model = build_model(edges)
    trace, quality = run_inference(model, config)
    return summarise(trace, edges, quality)
