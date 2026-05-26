"""Per-edge per-draw timing particles — Phase 6 §3.2 / §4.9 single source
of truth for arrival-map weighting.

The same ``(mu, sigma, onset)_s`` particles drive both:

  - prefix-arrival composition of root→U latency on the ``S`` axis
    (per-draw arrival weights at U for evidence admission), and
  - the primitive-conditioning proposal CDFs used by the joint
    importance-sampling likelihood over ``(p, F)``.

Sampling uses the request-scoped keyed RNG seam (``make_rng`` from
``primitives.py``) keyed by per-edge ``DrawFamilyKey``, so identical
inputs produce identical particles in both consumption sites. The
particles themselves are sampled from each edge's prior latency
parameters (``mu, mu_sd``), (``sigma, sigma_sd``), (``onset, onset_sd``)
with the cross-correlation ``onset_mu_corr``; they are not drawn from
the conditioned posterior, so admission weights do not condition on the
evidence they are about to weight (circular-dependency avoidance).
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Tuple

import numpy as np

from .primitives import DrawFamilyKey, PrimitiveScope, TransitionIdentity, make_rng
from .timing_span import TimingTransitionPrimitive
from .bucket_transition import cdf_to_bucket_transition


__all__ = [
    'EdgeTimingParticles',
    'RequestTimingParticles',
    'sample_edge_timing_particles',
    'sample_timing_particles_from_params',
    'build_request_timing_particles',
    'build_per_draw_edge_cdf',
    'build_endpoint_lognormal_cdf_from_draws',
    'build_row_aligned_lognormal_cdf_from_draws',
]


def build_request_timing_particles(
    *,
    transitions: Mapping[Tuple[str, str], TimingTransitionPrimitive],
    primitive_scopes: Mapping[Tuple[str, str], PrimitiveScope],
    transition_identities: Mapping[Tuple[str, str], TransitionIdentity],
    scenario_seed: int,
    draw_count: int,
) -> 'RequestTimingParticles':
    """Build the request-scoped per-edge timing-particle mapping.

    For every edge, constructs the per-edge ``DrawFamilyKey`` from the
    primitive scope + transition identity and samples particles via the
    keyed-RNG seam — identical to the conditioning proposal stage.
    Same edge under same scope ⇒ identical particles, satisfying the
    Phase 6 §3.2 single-source-of-truth invariant between prefix-
    arrival composition and primitive conditioning.
    """
    particles_by_edge: dict[Tuple[str, str], EdgeTimingParticles] = {}
    for edge_key, primitive in transitions.items():
        scope = primitive_scopes[edge_key]
        identity = transition_identities[edge_key]
        draw_family_key = DrawFamilyKey(
            transition_identity=identity,
            scope=scope,
            draw_count=int(draw_count),
            scenario_seed=int(scenario_seed),
        )
        particles_by_edge[edge_key] = sample_edge_timing_particles(
            primitive=primitive,
            draw_family_key=draw_family_key,
            draw_count=int(draw_count),
        )
    return RequestTimingParticles(
        particles_by_edge=particles_by_edge,
        draw_count=int(draw_count),
    )


def sample_timing_particles_from_params(
    *,
    mu: float,
    sigma: float,
    onset: float,
    mu_sd: float,
    sigma_sd: float,
    onset_sd: float,
    onset_mu_corr: float,
    draw_family_key: DrawFamilyKey,
    draw_count: int,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Sample ``(mu, sigma, onset)`` particles directly from scalar params.

    Used by primitive conditioning's proposal stage so the same keyed
    RNG seam — ``make_rng(draw_family_key, 'primitive_timing_draws')``
    — that prefix-arrival uses also drives conditioning. Identical
    inputs ⇒ identical particles. The clipping discipline
    (``sigma_draws >= 0.01``, ``onset_draws >= 0``) is the same
    legacy invariant the conditioning code applied inline; it lives
    once here so both sites stay aligned.

    Returns ``(mu_draws, sigma_draws, onset_draws)`` each of shape
    ``(S,)``.
    """
    timing_rng = make_rng(draw_family_key, 'primitive_timing_draws')
    means = np.array([float(mu), float(sigma), float(onset)], dtype=np.float64)
    sds = np.array(
        [float(mu_sd), float(sigma_sd), float(onset_sd)],
        dtype=np.float64,
    )
    cov = np.diag(sds ** 2)
    cov[2, 0] = cov[0, 2] = float(onset_mu_corr) * sds[2] * sds[0]
    particles = timing_rng.multivariate_normal(
        means, cov, size=int(draw_count), method='svd',
    )
    mu_draws = particles[:, 0]
    sigma_draws = np.clip(particles[:, 1], 0.01, 20.0)
    onset_draws = np.maximum(particles[:, 2], 0.0)
    return mu_draws, sigma_draws, onset_draws


def _sample_via_params(primitive: TimingTransitionPrimitive,
                       draw_family_key: DrawFamilyKey,
                       draw_count: int,
                       ) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    return sample_timing_particles_from_params(
        mu=float(primitive.mu),
        sigma=float(primitive.sigma),
        onset=float(primitive.onset),
        mu_sd=float(getattr(primitive, 'mu_sd', 0.0) or 0.0),
        sigma_sd=float(getattr(primitive, 'sigma_sd', 0.0) or 0.0),
        onset_sd=float(getattr(primitive, 'onset_sd', 0.0) or 0.0),
        onset_mu_corr=float(getattr(primitive, 'onset_mu_corr', 0.0) or 0.0),
        draw_family_key=draw_family_key,
        draw_count=draw_count,
    )


@dataclass(frozen=True)
class EdgeTimingParticles:
    """Per-edge per-draw timing-parameter particles.

    ``mu_draws``, ``sigma_draws``, ``onset_draws`` are shape ``(S,)``.
    ``draw_count`` is ``S``. The dataclass is frozen so the same instance
    can be shared by prefix-arrival composition and primitive
    conditioning without risk of in-place mutation.
    """
    mu_draws: np.ndarray
    sigma_draws: np.ndarray
    onset_draws: np.ndarray
    draw_count: int


@dataclass(frozen=True)
class RequestTimingParticles:
    """Request-scoped mapping ``(from_id, to_id) → EdgeTimingParticles``.

    Built once at the request boundary alongside the prefix-arrival map
    so prefix-arrival composition and primitive conditioning consume
    identical particles per edge. Two requests sharing the same
    underlying ``DrawFamilyKey`` values across edges will produce
    identical particles (deterministic via the keyed-RNG seam).
    """
    particles_by_edge: Mapping[Tuple[str, str], EdgeTimingParticles]
    draw_count: int


def sample_edge_timing_particles(
    *,
    primitive: TimingTransitionPrimitive,
    draw_family_key: DrawFamilyKey,
    draw_count: int,
) -> EdgeTimingParticles:
    """Sample one edge's per-draw timing-parameter particles.

    Uses the same multivariate normal sampling that the conditioning
    proposal currently performs (with ``onset_mu_corr`` honoured when
    present on the primitive). When all dispersions are zero the
    covariance matrix is the zero matrix; numpy's default-SVD path
    returns the mean exactly, so the zero-dispersion case is an
    algebraic degeneracy of the same sampling call — no branch.
    """
    mu_draws, sigma_draws, onset_draws = _sample_via_params(
        primitive, draw_family_key, draw_count,
    )
    return EdgeTimingParticles(
        mu_draws=mu_draws,
        sigma_draws=sigma_draws,
        onset_draws=onset_draws,
        draw_count=int(draw_count),
    )


def build_per_draw_edge_cdf(
    particles: EdgeTimingParticles,
    horizon_len: int,
) -> np.ndarray:
    """Bucket-centred shifted log-normal cumulative on the ``(S, T)`` grid.

    This surface is for output-path composition. It samples the
    continuous CDF into the shared bucket-K placement convention, so
    downstream ``diff`` sees the same bucket-centred transition mass as
    the model and empirical operators. The primitive likelihood builds
    its own endpoint CDF for snapshot-row likelihood evaluation.
    """
    endpoint_cdf = build_endpoint_lognormal_cdf_from_draws(
        mu_draws=particles.mu_draws,
        sigma_draws=particles.sigma_draws,
        onset_draws=particles.onset_draws,
        horizon_len=horizon_len,
    )
    return np.cumsum(
        cdf_to_bucket_transition(
            "timing_particles",
            endpoint_cdf,
            family="timing_particles",
        ).value,
        axis=1,
    )


def build_endpoint_lognormal_cdf_from_draws(
    *,
    mu_draws: np.ndarray,
    sigma_draws: np.ndarray,
    onset_draws: np.ndarray,
    horizon_len: int,
) -> np.ndarray:
    """Evaluate shifted log-normal CDF at integer endpoints per draw."""
    sigma_arr = np.asarray(sigma_draws, dtype=np.float64)
    if np.any(sigma_arr <= 0.0):
        raise ValueError('endpoint lognormal CDF requires sigma > 0')

    mu_arr = np.asarray(mu_draws, dtype=np.float64)[:, None]
    onset_arr = np.asarray(onset_draws, dtype=np.float64)[:, None]
    sigma_grid = sigma_arr[:, None]
    age_grid = np.arange(int(horizon_len), dtype=np.float64)[None, :]
    model_age = age_grid - onset_arr

    cdf_values = np.zeros_like(model_age, dtype=np.float64)
    positive = model_age > 0.0
    mu_b = np.broadcast_to(mu_arr, model_age.shape)
    sigma_b = np.broadcast_to(sigma_grid, model_age.shape)
    z_positive = (np.log(model_age[positive]) - mu_b[positive]) / sigma_b[positive]
    from .numpy_stats import normal_cdf

    cdf_values[positive] = normal_cdf(z_positive)
    return cdf_values


def build_row_aligned_lognormal_cdf_from_draws(
    *,
    mu_draws: np.ndarray,
    sigma_draws: np.ndarray,
    onset_draws: np.ndarray,
    horizon_len: int,
    quadrature_order: int = 16,
) -> np.ndarray:
    """Numerically integrate row-aligned cumulative timing per draw.

    Returns ``B[s, τ] = ∫_τ^{τ+1} G_s(v) dv`` for τ on
    ``[0, horizon_len)``. Gaussian-Legendre quadrature keeps the
    implementation family-agnostic while making the contract explicit.
    """
    sigma_arr = np.asarray(sigma_draws, dtype=np.float64)
    if np.any(sigma_arr <= 0.0):
        raise ValueError('row-aligned lognormal CDF requires sigma > 0')

    mu_arr = np.asarray(mu_draws, dtype=np.float64)[:, None, None]
    onset_arr = np.asarray(onset_draws, dtype=np.float64)[:, None, None]
    sigma_grid = sigma_arr[:, None, None]
    T = int(horizon_len)

    nodes, weights = np.polynomial.legendre.leggauss(int(quadrature_order))
    offsets = 0.5 * (nodes + 1.0)
    scaled_weights = 0.5 * weights
    tau_grid = np.arange(T, dtype=np.float64)[None, :, None]
    sample_age = tau_grid + offsets[None, None, :]
    model_age = sample_age - onset_arr

    cdf_values = np.zeros_like(model_age, dtype=np.float64)
    positive = model_age > 0.0
    mu_b = np.broadcast_to(mu_arr, model_age.shape)
    sigma_b = np.broadcast_to(sigma_grid, model_age.shape)
    z_positive = (np.log(model_age[positive]) - mu_b[positive]) / sigma_b[positive]
    from .numpy_stats import normal_cdf

    cdf_values[positive] = normal_cdf(z_positive)
    return np.sum(cdf_values * scaled_weights[None, None, :], axis=2)
