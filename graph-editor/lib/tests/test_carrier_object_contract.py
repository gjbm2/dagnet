"""Carrier-object contract tests (73m Stages 1–2).

These tests pin the post-Stage-3 carrier-object contract documented in
``docs/current/project-bayes/73m-carrier-composition-and-router-unification-implementation-plan.md``
sections "Core design contract" and "Mathematical invariants".

Two surfaces are exercised:

1. **Legacy v3 factory** (``forecast_runtime.build_x_provider_from_graph`` +
   ``forecast_runtime.build_upstream_carrier``). Tests against this surface
   document the current behaviour. Cases where the legacy factory does not
   yet satisfy the contract — because the gate is still
   ``has_semantic_upstream_latency`` rather than the structural
   ``A != X and reach > 0`` — remain ``xfail(strict=True)`` until Stage 3
   wires the new primitive in. Stage 3 is responsible for removing those
   xfail markers.

2. **The Stage-2 carrier composition primitive** in
   ``runner.carrier_composition``. The composer takes ``transitions``
   directly so callers (and tests) can supply explicit
   ``TransitionPrimitive`` objects without going through the default
   resolver. Tests against the composer prove that 73m §"Stage 1"
   bullets 2/3/4 and the horizon-adequacy rule are satisfied by the
   primitive itself, even though no live caller uses it yet.

Scope: v3 only. ``cohort_forecast.py``'s legacy XProvider/factory and the
inline ``XProvider`` construction inside ``_handle_cohort_maturity_v2`` at
``api_handlers.py:1380`` are out of scope (v2 is code-frozen).

Stage 0 baseline note ``73m-stage-0-baseline.md`` records the current state
of the two factories (one v2-frozen, one v3) and the gate semantics.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest


# ── Fixtures ────────────────────────────────────────────────────────────────


def _make_carrier_graph(edges):
    """Build a minimal graph for carrier-contract testing.

    Each ``spec`` is a tuple
        (uuid, from_uuid, to_uuid, from_id, to_id, p_mean, mu, sigma, onset)

    A ``sigma`` of 0 marks an edge as structurally non-latency (no timing
    shape). The synth fixture populates both the legacy ``p.mean`` /
    ``p.latency.{mu,sigma,onset_delta_days}`` and the analytic
    ``model_vars`` block so ``resolve_model_params`` succeeds.
    """
    nodes_by_uuid = {}
    edge_list = []
    for uuid, from_u, to_u, from_id, to_id, p_mean, mu, sigma, onset in edges:
        nodes_by_uuid[from_u] = {'uuid': from_u, 'id': from_id}
        nodes_by_uuid[to_u] = {'uuid': to_u, 'id': to_id}
        is_latency = sigma > 0
        edge_list.append({
            'uuid': uuid,
            'from': from_u,
            'to': to_u,
            'p': {
                'id': f'param-{uuid}',
                'mean': p_mean,
                'stdev': 0.05,
                'forecast': {'mean': p_mean},
                'latency': {
                    'latency_parameter': is_latency,
                    'mu': mu,
                    'sigma': sigma,
                    'onset_delta_days': onset,
                    'promoted_mu': mu,
                    'promoted_sigma': sigma,
                    'promoted_onset_delta_days': onset,
                    'promoted_mu_sd': 0.1 if is_latency else 0.0,
                    'promoted_sigma_sd': 0.05 if is_latency else 0.0,
                    'promoted_onset_sd': 0.2 if is_latency else 0.0,
                    'promoted_onset_mu_corr': -0.3 if is_latency else 0.0,
                },
                'model_vars': [{
                    'source': 'analytic',
                    'probability': {'mean': p_mean, 'stdev': 0.05},
                    'latency': {'mu': mu, 'sigma': sigma, 'onset_delta_days': onset},
                }],
            },
        })
    return {'nodes': list(nodes_by_uuid.values()), 'edges': edge_list}


def _build_provider(graph, target_edge_uuid, anchor_id, *, is_window):
    from runner.forecast_runtime import (
        build_x_provider_from_graph,
        find_edge_by_id,
    )

    target_edge = find_edge_by_id(graph, target_edge_uuid)
    assert target_edge is not None, f"target edge {target_edge_uuid!r} not found"
    return build_x_provider_from_graph(
        graph,
        target_edge,
        anchor_node_id=anchor_id,
        is_window=is_window,
    )


# ── GREEN: identity-carrier degeneracies ────────────────────────────────────
#
# 73m §"Stage 1" first bullet: window() and cohort() with A=X must produce
# identity carrier semantics. The current implementation already disables
# the carrier in both cases (window short-circuits in the factory; A=X is
# rejected by has_semantic_upstream_latency).


def test_window_mode_returns_inactive_carrier():
    """Window mode must short-circuit the carrier regardless of upstream shape.

    The factory's first guard (``if is_window or target_edge is None``)
    returns an XProvider with ``reach=0`` and ``enabled=False``. This is
    the identity-carrier degeneration for window mode (carrier collapses
    to no-op; row builder treats X as the population root).
    """
    graph = _make_carrier_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.6, 1.5, 0.4, 0.0),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C', 0.5, 2.0, 0.5, 0.0),
    ])
    provider = _build_provider(graph, 'e-b-c', anchor_id='A', is_window=True)

    assert provider.enabled is False
    assert provider.reach == 0.0
    assert provider.upstream_params_list == []
    assert provider.ingress_carrier is None


def test_a_equals_x_cohort_returns_inactive_carrier():
    """cohort() with A=X must produce identity carrier semantics.

    The semantic gate ``has_semantic_upstream_latency`` returns False
    when ``anchor == target`` (forecast_runtime.py:799-800), so the
    factory disables the carrier. The row builder then runs without an
    upstream dependency — equivalent to window for the denominator.
    """
    graph = _make_carrier_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.6, 1.5, 0.4, 0.0),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C', 0.5, 2.0, 0.5, 0.0),
    ])
    # cohort(B, …) on edge B→C: anchor == target_edge.from_node.
    provider = _build_provider(graph, 'e-b-c', anchor_id='B', is_window=False)

    assert provider.enabled is False, (
        "A=X cohort must produce identity carrier (enabled=False); "
        f"got enabled={provider.enabled!r}"
    )


def test_a_not_x_topological_reach_is_product_of_upstream_probabilities():
    """Multi-edge upstream path must compute reach topologically.

    73m §"Stage 1" fifth bullet: a multi-edge upstream path computes
    reach as the topological product of edge probabilities along
    A → … → X. The current ``build_x_provider_from_graph`` already does
    this via a topo walk using ``_resolve_edge_p`` — independent of
    whether the chain is latency-bearing. This test pins the contract.
    """
    # A → B (p=0.6, latent) → C (p=0.5, latent) → D (target.from = C)
    graph = _make_carrier_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.6, 1.5, 0.4, 0.0),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C', 0.5, 2.0, 0.5, 0.0),
        ('e-c-d', 'u-c', 'u-d', 'C', 'D', 0.7, 2.2, 0.6, 0.0),
    ])
    provider = _build_provider(graph, 'e-c-d', anchor_id='A', is_window=False)

    expected_reach = 0.6 * 0.5
    assert provider.reach == pytest.approx(expected_reach, abs=1e-9), (
        f"expected topological reach A→C = 0.6 × 0.5 = {expected_reach}, "
        f"got {provider.reach}"
    )
    assert provider.enabled is True, (
        "all-latent A!=X chain should enable the carrier under any "
        "post-Stage-3 gate (reach > 0 and A != X)"
    )


def test_carrier_conditional_cdf_saturates_to_one_for_latent_chain():
    """Carrier conditional CDF and reach must not be double-multiplied.

    73m §"Mathematical invariants": "The carrier CDF stored on runtime
    objects is conditional on reaching X. It should saturate to one over
    a sufficiently large horizon. Reach remains a separate scalar."

    Run ``build_upstream_carrier`` with a tight-lognormal upstream params
    list and check the deterministic CDF saturates to ~1.0 at the horizon
    end. If the carrier reach were folded into the CDF, the saturation
    target would be ``reach`` (here 0.6) rather than 1.0 — which would
    break the displayed-rate semantics described in §"Core design contract".
    """
    import numpy as np

    from runner.forecast_runtime import build_upstream_carrier

    upstream_params = [{
        'p': 0.6,
        'mu': 1.0,        # t50 ≈ exp(1.0) ≈ 2.7 days
        'sigma': 0.3,     # tight lognormal
        'onset': 0.0,
    }]
    rng = np.random.default_rng(seed=42)
    det_cdf, _mc_cdf, tier = build_upstream_carrier(
        upstream_params_list=upstream_params,
        upstream_obs=None,
        cohort_list=[],
        reach=0.6,
        is_window=False,
        max_tau=50,
        num_draws=64,
        rng=rng,
    )
    assert det_cdf is not None, f"carrier returned no det_cdf (tier={tier})"
    assert det_cdf[-1] == pytest.approx(1.0, abs=1e-2), (
        "conditional CDF must saturate to 1.0 at horizon, not to reach. "
        f"det_cdf[-1]={det_cdf[-1]} reach=0.6"
    )


# ── RED-expected: Stage 2 (primitive) and Stage 3 (gate) targets ────────────
#
# Each test below pins a contract bullet from 73m §"Stage 1" that the
# current v3 implementation does not yet satisfy. The xfail(strict=True)
# marker ensures the test fails the build if it spuriously starts passing —
# at which point the responsible later stage should remove the marker as
# part of its own delivery.


def test_a_not_x_all_non_latency_chain_must_enable_carrier():
    """73m §"Stage 1" second bullet: cohort() with A != X and positive reach
    must produce an active carrier even when every upstream edge is
    non-latency.

    Post-Stage-3 the gate is ``reach > 0 and A != X``, independent of
    whether any upstream edge is latency-bearing — implemented via
    ``carrier.is_active`` from the new composition primitive.
    """
    # All edges non-latency (sigma = 0). Topological reach A → C is
    # 0.8 × 0.7 = 0.56, which is positive. Plan-mandated post-Stage-3 result:
    # carrier is enabled because A != X and reach > 0.
    graph = _make_carrier_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.8, 0.0, 0.0, 0.0),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C', 0.7, 0.0, 0.0, 0.0),
        ('e-c-d', 'u-c', 'u-d', 'C', 'D', 0.5, 1.5, 0.4, 0.0),
    ])
    provider = _build_provider(graph, 'e-c-d', anchor_id='A', is_window=False)

    assert provider.reach == pytest.approx(0.8 * 0.7, abs=1e-9)
    assert provider.enabled is True, (
        "all-non-latency A != X chain must enable the carrier "
        "(post-Stage-3 gate); reach > 0 and A != X is the only requirement"
    )


def test_all_non_latency_chain_carrier_cdf_is_dirac_at_zero():
    """73m §"Stage 1" bullet 3 / §"Stage 2": an all-non-latency A → X
    carrier must have a Dirac-at-zero conditional CDF and reach equal
    to the topological product.

    Driven through the Stage-2 composer (``compose_carrier_to_x``) so
    the test passes once Stage 2 is in place, even though the legacy
    factory's σ ≤ 0 gate has not yet been changed (that's Stage 3).
    """
    from runner.carrier_composition import compose_carrier_to_x

    graph = _make_carrier_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.8, 0.0, 0.0, 0.0),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C', 0.7, 0.0, 0.0, 0.0),
        ('e-c-d', 'u-c', 'u-d', 'C', 'D', 0.5, 1.5, 0.4, 0.0),
    ])
    carrier = compose_carrier_to_x(
        graph=graph,
        anchor_node_id='A',
        denominator_node_id='C',
        is_window=False,
        max_tau=20,
    )
    assert carrier.is_active, (
        f"composer must enable an active carrier for an all-non-latency "
        f"A != X chain; got tier={carrier.diagnostics.tier!r} "
        f"note={carrier.diagnostics.note!r}"
    )
    assert carrier.reach == pytest.approx(0.8 * 0.7, abs=1e-9)
    assert carrier.deterministic_cdf is not None
    # Dirac-at-zero: every τ ≥ 0 has the full conditional mass.
    assert carrier.deterministic_cdf[0] == pytest.approx(1.0, abs=1e-9), (
        f"all-non-latency A → X carrier must be Dirac-at-zero; "
        f"det_cdf[0]={carrier.deterministic_cdf[0]}"
    )
    assert float(carrier.deterministic_cdf.min()) == pytest.approx(1.0, abs=1e-9)
    assert carrier.diagnostics.has_latency_edge is False


def test_mixed_latency_then_non_latency_chain_carrier_reflects_latency_edge_timing():
    """73m §"Stage 1" bullet 4: a mixed latency/non-latency upstream path
    composes to the latency edge's timing shape with the non-latency
    edge as identity.

    Topology: A → B (latency, μ=2.0, σ=0.4) → C (non-latency).
    Target subject: C → D (anchor A).

    Driven through the Stage-2 composer. The composer walks the full
    A → X subgraph (not just immediate incoming edges), so the A → B
    lognormal shape comes through with B → C contributing identity.
    Median lag through the carrier ≈ exp(2.0) ≈ 7 days.
    """
    from runner.carrier_composition import compose_carrier_to_x

    graph = _make_carrier_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.8, 2.0, 0.4, 0.0),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C', 0.7, 0.0, 0.0, 0.0),
        ('e-c-d', 'u-c', 'u-d', 'C', 'D', 0.5, 1.5, 0.4, 0.0),
    ])
    carrier = compose_carrier_to_x(
        graph=graph,
        anchor_node_id='A',
        denominator_node_id='C',
        is_window=False,
        max_tau=60,
    )
    assert carrier.is_active, (
        f"composer must build an active carrier for the mixed chain; "
        f"got tier={carrier.diagnostics.tier!r} "
        f"note={carrier.diagnostics.note!r}"
    )
    assert carrier.deterministic_cdf is not None
    median_tau = next(
        (tau for tau, value in enumerate(carrier.deterministic_cdf) if value >= 0.5),
        None,
    )
    assert median_tau is not None, "carrier CDF never reaches 0.5"
    expected_median = 7  # round(exp(2.0))
    assert abs(median_tau - expected_median) <= 2, (
        f"mixed-latency carrier median should reflect A → B lognormal "
        f"(t50 ≈ {expected_median} days); got median_tau={median_tau}"
    )
    assert carrier.diagnostics.has_latency_edge is True


# ── Horizon adequacy ────────────────────────────────────────────────────────
#
# 73m §"Mathematical invariants" (horizon paragraph): "For synthetic/unit
# fixtures, K[max_tau] / reach must be at least 0.99 whenever reach is
# positive and the topology is expected to saturate inside the test
# horizon. … any ratio below `0.95` is a blocking failure for this
# implementation plan until the horizon rule is revised."
#
# The conditional CDF returned by build_upstream_carrier already represents
# K(τ) / reach (it goes to 1.0 at large τ). The horizon-adequacy contract
# is therefore: det_cdf[-1] >= 0.99 for fixtures where saturation is
# expected; det_cdf[-1] >= 0.95 is the blocking floor — below that, the
# primitive must refuse or surface a horizon-inadequate diagnostic rather
# than return a silently truncated carrier.


def test_horizon_adequacy_returns_at_least_99_percent_saturation_when_horizon_is_sufficient():
    """K[max_tau] / reach must be >= 0.99 for a fixture sized to saturate."""
    import numpy as np

    from runner.forecast_runtime import build_upstream_carrier

    # Tight lognormal: t99 ≈ exp(0.5 + 0.3·2.33) ≈ exp(1.2) ≈ 3.3 days.
    # max_tau = 50 leaves plenty of headroom.
    rng = np.random.default_rng(seed=42)
    det_cdf, _mc, tier = build_upstream_carrier(
        upstream_params_list=[{
            'p': 0.7, 'mu': 0.5, 'sigma': 0.3, 'onset': 0.0,
        }],
        upstream_obs=None,
        cohort_list=[],
        reach=0.7,
        is_window=False,
        max_tau=50,
        num_draws=64,
        rng=rng,
    )
    assert det_cdf is not None, f"carrier returned no det_cdf (tier={tier})"
    assert det_cdf[-1] >= 0.99, (
        f"horizon-adequacy: K[max_tau]/reach must be >= 0.99 for a fixture "
        f"sized to saturate (mu=0.5, sigma=0.3, max_tau=50); "
        f"got det_cdf[-1]={det_cdf[-1]}"
    )


def test_horizon_inadequacy_below_95_percent_must_be_refused_or_diagnosed():
    """Inadequate horizon must not yield a silently-truncated carrier.

    Multi-hop chain where the convolved A → X latency genuinely cannot
    fit inside ``max_tau``. Each edge has median ≈ 7.4 days; the
    3-hop sum has median ≈ 22 days, so max_tau = 8 truncates most of
    the eventual mass. The composer must return
    ``tier='horizon_inadequate'`` with ``deterministic_cdf = None``
    rather than a silently-truncated carrier.

    (Single-edge horizon tests don't bite because
    ``_edge_sub_probability_density`` re-normalises the per-edge PDF
    to total ``p``; the truncation only manifests after convolution
    on multi-hop chains.)
    """
    from runner.carrier_composition import compose_carrier_to_x

    graph = _make_carrier_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.7, 2.0, 0.4, 0.0),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C', 0.7, 2.0, 0.4, 0.0),
        ('e-c-d', 'u-c', 'u-d', 'C', 'D', 0.7, 2.0, 0.4, 0.0),
        ('e-d-y', 'u-d', 'u-y', 'D', 'Y', 0.5, 1.5, 0.4, 0.0),
    ])
    carrier = compose_carrier_to_x(
        graph=graph,
        anchor_node_id='A',
        denominator_node_id='D',
        is_window=False,
        max_tau=8,
    )
    assert carrier.is_horizon_inadequate, (
        f"composer must refuse a max_tau=8 horizon against a 3-hop "
        f"lognormal-sum chain (median ≈ 22 days); got "
        f"tier={carrier.diagnostics.tier!r} "
        f"horizon_ratio={carrier.diagnostics.horizon_ratio:.4f}"
    )
    assert carrier.deterministic_cdf is None
    assert carrier.diagnostics.horizon_ratio < 0.95
    assert 'blocking floor' in carrier.diagnostics.note
    return  # the legacy-surface assertions below are now obsolete

    # ---- legacy assertions, retained as comment for diff legibility ----
    # Acceptable post-Stage-2 outcomes:
    #   (a) det_cdf is None and tier marks the inadequacy explicitly, or
    #   (b) det_cdf is returned but K[max_tau]/reach >= 0.95.
    if det_cdf is None:
        assert tier in ('horizon_inadequate', 'none'), (
            f"primitive refused but tier={tier!r} does not mark horizon "
            "inadequacy; expected 'horizon_inadequate' or similar"
        )
    else:
        assert det_cdf[-1] >= 0.95, (
            f"horizon below blocking floor: K[max_tau]/reach="
            f"{det_cdf[-1]:.4f} (< 0.95) — primitive must refuse rather "
            f"than return a truncated carrier (tier={tier!r})"
        )


# ── Stage 2 composer direct contract tests ────────────────────────────────────
#
# 73m §"Stage 2" review-checklist gate: "Is the Stage 2 primitive written
# as a composer of supplied transition primitives rather than as a
# prior-only edge-field reader?" These tests pass synthetic
# TransitionPrimitive objects directly so no graph-resolver call happens
# inside the composer — proving the contract surface is composition,
# not resolution.


def test_composer_accepts_synthetic_transitions_without_invoking_resolver():
    """The composer must accept ``transitions=...`` directly.

    Phase 2 (73n) will rely on this seam to inject posterior-conditioned
    transition primitives; Phase 1 tests prove the seam is real by
    bypassing the default resolver entirely.
    """
    from runner.carrier_composition import (
        compose_carrier_to_x,
        TransitionPrimitive,
    )

    graph = _make_carrier_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.5, 1.0, 0.3, 0.0),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C', 0.4, 1.2, 0.3, 0.0),
        ('e-c-d', 'u-c', 'u-d', 'C', 'D', 0.5, 1.5, 0.4, 0.0),
    ])
    # Synthetic transitions — different probabilities and timings than the
    # graph carries, to prove the composer reads only what we pass in.
    transitions = {
        ('A', 'B'): TransitionPrimitive(
            p=0.9, mu=0.0, sigma=0.0, onset=0.0,
            source='posterior_synthetic',
        ),
        ('B', 'C'): TransitionPrimitive(
            p=0.8, mu=0.0, sigma=0.0, onset=0.0,
            source='posterior_synthetic',
        ),
    }
    carrier = compose_carrier_to_x(
        graph=graph,
        anchor_node_id='A',
        denominator_node_id='C',
        is_window=False,
        transitions=transitions,
        max_tau=20,
    )
    assert carrier.is_active
    # Reach reflects the SYNTHETIC probabilities, not the graph's.
    assert carrier.reach == pytest.approx(0.9 * 0.8, abs=1e-9)
    assert carrier.diagnostics.transition_source == 'posterior_synthetic'


def test_composer_returns_identity_for_window_mode():
    from runner.carrier_composition import compose_carrier_to_x

    graph = _make_carrier_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.5, 1.5, 0.4, 0.0),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C', 0.4, 1.5, 0.4, 0.0),
    ])
    carrier = compose_carrier_to_x(
        graph=graph,
        anchor_node_id='A',
        denominator_node_id='B',
        is_window=True,
        max_tau=20,
    )
    assert carrier.is_identity
    assert carrier.reach == 1.0
    assert carrier.deterministic_cdf is None


def test_composer_returns_identity_when_anchor_equals_denominator():
    from runner.carrier_composition import compose_carrier_to_x

    graph = _make_carrier_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.5, 1.5, 0.4, 0.0),
    ])
    carrier = compose_carrier_to_x(
        graph=graph,
        anchor_node_id='A',
        denominator_node_id='A',
        is_window=False,
        max_tau=20,
    )
    assert carrier.is_identity
    assert 'A = X' in carrier.diagnostics.note


def test_composer_returns_no_path_when_chain_is_disconnected():
    from runner.carrier_composition import compose_carrier_to_x

    # Two disconnected components: A → B and X → Y. Anchor=A, X=X has
    # no path between them.
    graph = _make_carrier_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.5, 1.0, 0.3, 0.0),
        ('e-x-y', 'u-x', 'u-y', 'X', 'Y', 0.4, 1.5, 0.4, 0.0),
    ])
    carrier = compose_carrier_to_x(
        graph=graph,
        anchor_node_id='A',
        denominator_node_id='X',
        is_window=False,
        max_tau=20,
    )
    assert carrier.diagnostics.tier == 'no_path'
    assert carrier.deterministic_cdf is None
    assert carrier.reach == 0.0


def test_composer_populates_mc_cdf_when_rng_provided():
    """Per-draw MC CDFs are populated when (rng, num_draws) are given.

    Confirms the composer's MC path reuses ``span_kernel.mc_span_cdfs``
    correctly and that each row is a [0, 1] conditional CDF.
    """
    import numpy as np

    from runner.carrier_composition import compose_carrier_to_x

    graph = _make_carrier_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.7, 1.0, 0.3, 0.0),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C', 0.5, 1.5, 0.4, 0.0),
    ])
    rng = np.random.default_rng(seed=42)
    carrier = compose_carrier_to_x(
        graph=graph,
        anchor_node_id='A',
        denominator_node_id='B',
        is_window=False,
        max_tau=40,
        num_draws=32,
        rng=rng,
    )
    assert carrier.is_active
    assert carrier.mc_cdf is not None
    assert carrier.mc_cdf.shape == (32, 41)
    assert float(carrier.mc_cdf.min()) >= 0.0
    assert float(carrier.mc_cdf.max()) <= 1.0


def test_composer_diagnostics_carry_default_resolver_provenance():
    """When the default resolver is used, the diagnostics' transition_source
    starts with 'prior_' so a downstream consumer can tell prior from
    posterior at a glance (the latter labelled by 73n).
    """
    from runner.carrier_composition import compose_carrier_to_x

    graph = _make_carrier_graph([
        ('e-a-b', 'u-a', 'u-b', 'A', 'B', 0.6, 1.5, 0.4, 0.0),
        ('e-b-c', 'u-b', 'u-c', 'B', 'C', 0.5, 1.5, 0.4, 0.0),
    ])
    carrier = compose_carrier_to_x(
        graph=graph,
        anchor_node_id='A',
        denominator_node_id='B',
        is_window=False,
        max_tau=40,
    )
    assert carrier.is_active
    assert carrier.diagnostics.transition_source.startswith('prior_'), (
        f"default resolver must label transitions with a 'prior_' prefix; "
        f"got transition_source={carrier.diagnostics.transition_source!r}"
    )
