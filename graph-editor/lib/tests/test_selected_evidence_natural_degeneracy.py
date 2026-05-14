"""Selected-evidence builder — natural-degeneracy unit tests (atom 2a).

These tests pin sub-stage 2a of the atom 2 plan in
``docs/current/cohort-maturity-evidence-coverage-design.md`` §5.2:

* **Chain-of-length-0 (identity carrier)** — when ``population_root ==
  denominator_node`` (the case for ``window()`` and ``cohort(A=X)``),
  the carrier chain is empty. The carrier surface is synthesised from
  the X-rooted subject primitive's row metadata: each row's
  ``(observed_date, retrieved_at, n_weighted)`` becomes a carrier cell
  at ``(anchor=observed_date, τ=retrieved_at-observed_date,
  observed_count=n_weighted)``. The X-day → A-day backmap is identity.

* **Chain-of-length-1 (single-hop window)** — for a single-edge subject
  chain, topology max-flow trivially yields the edge's own ``k_weighted``
  contribution.

* **Cross-cutting natural-degeneracy parity at builder level** — two
  runtimes constructed with identical numerical content but different
  scope/evidence-role metadata must produce numerically-equal
  ``SelectedAClockEvidence``. The 73n invariant pins ``window()`` and
  ``cohort(A=X)`` as the same runtime object; the builder must not
  accidentally distinguish them via metadata (AP58 falsifier). This is
  the builder-level form of the parity test; sub-stage 2c tightens it
  to end-to-end row and chart-render equality.

Tests are deliberately direct-on-the-builder, not end-to-end through
the row builder, per sub-stage 2a's stop condition: the builder accepts
identity-carrier runtimes; production wiring is unchanged.
"""

import os
import sys
from datetime import date as _date, timedelta as _timedelta
from types import SimpleNamespace

import pytest
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


# ─── Helpers (duplicated locally to keep this file self-contained;
# mirror the canonical versions in test_selected_cohort_pop_d_distribution
# and test_active_cohort_display_invariants) ──────────────────────────────


def _span(*, cdf_draws, p_draws):
    cdf_arr = np.asarray(cdf_draws, dtype=np.float64)
    return SimpleNamespace(
        cdf_draws=cdf_arr,
        cdf_mean=cdf_arr.mean(axis=0),
        span_p_draws=np.asarray(p_draws, dtype=np.float64),
    )


def _weighted_primitive(*, edge_id, source, dest, rows, evidence_role='subject_helper'):
    from runner.primitives import (
        ConditionedTransitionPrimitive,
        ConditioningStatus,
        PrimitiveScope,
        TimingFamily,
        TransitionIdentity,
        WeightedEvidenceRow,
        WeightedPrimitiveEvidenceView,
    )

    weighted_rows = tuple(
        WeightedEvidenceRow(
            observed_date=str(row['observed_date']),
            retrieved_at=row.get('retrieved_at'),
            n=int(row.get('n', 0)),
            k=int(row.get('k', 0)),
            arrival_weight=float(row.get('arrival_weight', 1.0)),
            n_weighted=float(row.get('n_weighted', row.get('n', 0))),
            k_weighted=float(row.get('k_weighted', row.get('k', 0))),
            root_day_shares=dict(row.get('root_day_shares', {})),
        )
        for row in rows
    )
    weighted = WeightedPrimitiveEvidenceView(
        n_weighted_total=float(sum(r.n_weighted for r in weighted_rows)),
        k_weighted_total=float(sum(r.k_weighted for r in weighted_rows)),
        rows=weighted_rows,
        arrival_weight_summary={'topology_case': 'test'},
        binding_policy='test_binding',
        evidence_scope_key=f'scope:{edge_id}:{evidence_role}',
    )
    return ConditionedTransitionPrimitive(
        transition=TransitionIdentity(
            source_node=source,
            destination_node=dest,
            edge_id=edge_id,
        ),
        scope=PrimitiveScope(
            scenario_id='test',
            evidence_role=evidence_role,
            date_from='2026-03-01',
            date_to='2026-03-31',
            as_at=None,
            context_key=None,
            regime_key=None,
            model_source_preference='best_available',
            resolved_source_identity='test',
        ),
        draw_count=1,
        status=ConditioningStatus.CONDITIONED,
        timing_family=TimingFamily.LATENT,
        raw_evidence_scope_key=f'scope:{edge_id}:{evidence_role}',
        weighted_evidence=weighted,
        effective_evidence_totals=(
            weighted.n_weighted_total, weighted.k_weighted_total,
        ),
        subset_policy=None,
        compatibility_blend=None,
        residual_policy=None,
        probability_posterior=None,
        timing_posterior=None,
        probability_prior=None,
        timing_prior=None,
        draw_family_key=None,
        prior_source='test',
    )


def _select_source_day_mass_at_x(
    *, denominator_node, n_cohort_by_anchor, carrier_cdf,
):
    """Construct M_select(X, ·, ·) directly from N_cohort and a carrier CDF.

    For identity carrier (A == X), the carrier CDF is a delta at offset 0
    — ``[1.0, 1.0, 1.0, ...]`` — so per-day mass collapses to ``N_cohort``
    on the anchor day itself.
    """
    from runner.cohort_forecast_v3 import _SelectedSourceDayMass

    cdf = [float(v) for v in carrier_cdf]
    pmf = [max(cdf[0], 0.0)] + [
        max(cdf[i] - cdf[i - 1], 0.0) for i in range(1, len(cdf))
    ]
    by_node = {str(denominator_node): {}}
    for anchor, n_cohort in n_cohort_by_anchor.items():
        n_c = float(n_cohort or 0.0)
        if n_c <= 0:
            continue
        anchor_d = _date.fromisoformat(str(anchor)[:10])
        per_day = {}
        for tau, w in enumerate(pmf):
            if w <= 0:
                continue
            per_day[(anchor_d + _timedelta(days=tau)).isoformat()] = n_c * w
        if per_day:
            by_node[str(denominator_node)][str(anchor)[:10]] = per_day
    return _SelectedSourceDayMass(
        by_node=by_node,
        endpoint_cdf_by_node={str(denominator_node): tuple(cdf)},
        n_cohort_by_anchor=dict(n_cohort_by_anchor),
        anchor_days=tuple(str(a)[:10] for a in n_cohort_by_anchor.keys()),
        provenance={'source': 'test_fixture_at_x_identity_carrier'},
    )


def _identity_carrier_runtime(*, evidence_role='subject_helper'):
    """Build a window-mode (identity-carrier) runtime with a single
    X→Y subject primitive and one snapshot at τ=3.

    ``population_root == denominator_node == 'node-x'`` — the identity-
    carrier condition. Subject end is 'node-y'. One subject row at
    ``observed_date=2026-03-01`` (the anchor day = X-arrival day),
    ``retrieved_at=2026-03-04`` (τ=3), ``n_weighted=100``, ``k_weighted=20``.
    Identity carrier CDF (delta at offset 0).
    """
    from runner.cohort_forecast_v3 import (
        _build_carrier_only_denominator_prefix,
    )

    subject = _weighted_primitive(
        edge_id='x-to-y',
        source='node-x',
        dest='node-y',
        rows=[{
            'observed_date': '2026-03-01',
            'retrieved_at': '2026-03-04',
            'n': 100,
            'k': 20,
            'n_weighted': 100.0,
            'k_weighted': 20.0,
            'root_day_shares': {'2026-03-01': 1.0},
        }],
        evidence_role=evidence_role,
    )
    runtime = SimpleNamespace(
        graph={
            'nodes': [{'id': 'node-x'}, {'id': 'node-y'}],
            'edges': [{'from': 'node-x', 'to': 'node-y', 'id': 'x-to-y'}],
        },
        population_root='node-x',
        denominator_node='node-x',
        subject_end='node-y',
        composed_carrier=None,
        composed_subject=_span(
            cdf_draws=[[0.0, 0.0, 0.0, 0.2, 0.2]],
            p_draws=[0.2],
        ),
        conditioned_primitive_map={'subject': subject},
        runtime_provenance={
            'primitives': {
                'carrier': [],
                'subject': [{'edge_id': 'x-to-y'}],
            },
        },
    )
    runtime.selected_source_day_mass = _select_source_day_mass_at_x(
        denominator_node='node-x',
        n_cohort_by_anchor={'2026-03-01': 100.0},
        carrier_cdf=[1.0, 1.0, 1.0, 1.0, 1.0],
    )
    runtime.selected_x_prefix = _build_carrier_only_denominator_prefix(
        runtime=runtime,
        anchor_days=['2026-03-01'],
        n_cohort_by_anchor={'2026-03-01': 100.0},
        max_tau=4,
    )
    runtime.selected_y_prefix = None
    return runtime


# ─── Tests ────────────────────────────────────────────────────────────


def test_unified_builder_identity_carrier_synthesises_carrier_surface_from_subject_primitive():
    """Chain-of-length-0 degeneracy: identity carrier.

    For ``window(X→end)`` or ``cohort(A=X, X→end)`` the carrier chain is
    length-0 (no edges between A and X because A == X). The builder must
    synthesise the carrier surface from the X-rooted subject primitive's
    row metadata: each row's ``(observed_date, retrieved_at, n_weighted)``
    becomes a carrier cell at ``(anchor=observed_date,
    τ=retrieved_at-observed_date, observed_count=n_weighted)``. The
    carrier backmap from X-day onto A-day is identity (no convolution
    needed because A == X).

    The builder must accept this configuration and emit a
    ``SelectedAClockEvidence`` with cells at the snapshot τ. Today the
    builder refuses identity-carrier at the explicit gate
    ``if str(pop_root) == str(denom_node): return None`` and this test
    fails; sub-stage 2a removes that gate.
    """
    from runner.cohort_forecast_v3 import (
        _build_selected_a_clock_evidence_from_runtime,
    )

    runtime = _identity_carrier_runtime()
    selected = _build_selected_a_clock_evidence_from_runtime(
        runtime,
        cohort_list=[{'anchor_day': '2026-03-01'}],
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        max_tau=4,
    )

    assert selected is not None, (
        'Identity-carrier runtime (pop_root == denom_node) must yield a '
        'SelectedAClockEvidence by chain-of-length-0 degeneracy of the '
        'carrier composition. Today the builder refuses identity carrier '
        'at line 3191; sub-stage 2a removes that gate and synthesises the '
        'carrier surface from the X-rooted subject primitive.'
    )

    # Carrier surface must be populated and reflect the subject row's
    # n_weighted at the snapshot τ.
    carrier_surface = getattr(runtime, 'observed_carrier_a_to_x', None)
    assert carrier_surface is not None and carrier_surface.has_cells(), (
        'Identity-carrier mode must produce a non-empty carrier surface '
        "synthesised from the X-rooted subject primitive's rows."
    )
    carrier_cells = carrier_surface.cells_by_anchor_day.get('2026-03-01', {})
    assert 3 in carrier_cells, (
        'Carrier surface must record a cell at τ=3 (the subject row\'s '
        'retrieved_at − observed_date).'
    )
    assert float(carrier_cells[3].observed_count) == pytest.approx(100.0), (
        'Carrier cell observed_count must equal the subject row\'s '
        'n_weighted in identity-carrier mode (the X-cohort base mass).'
    )

    # Selected evidence aggregate must emit a τ=3 bucket with the
    # expected X (carrier-only N × G_carrier_identity = 100 × 1.0) and
    # Y (rate-attributed: N × (k/n at u=0) = 100 × 0.2 = 20).
    aggregate = selected.aggregate_by_tau()
    assert 3 in aggregate, (
        'Identity-carrier degeneracy must emit a τ=3 bucket whenever the '
        'subject primitive has a snapshot at retrieved_at − anchor = 3.'
    )
    assert float(aggregate[3]['sum_x']) == pytest.approx(100.0)
    assert float(aggregate[3]['sum_y']) == pytest.approx(20.0)


def test_unified_builder_single_hop_subject_max_flow_equals_primitive_k():
    """Chain-of-length-1 degeneracy: single-hop subject.

    For a single-edge subject chain (X→end is one edge), topology
    max-flow trivially yields that edge's own ``k_weighted`` contribution.
    No special-case logic should be needed — single-hop is the
    chain-of-length-1 case of the same composition machinery.

    Tested on the same fixture as the chain-of-length-0 test (single-hop
    window has both degeneracies); the assertion here shifts to the
    subject (Y) side.
    """
    from runner.cohort_forecast_v3 import (
        _build_selected_a_clock_evidence_from_runtime,
    )

    runtime = _identity_carrier_runtime()
    selected = _build_selected_a_clock_evidence_from_runtime(
        runtime,
        cohort_list=[{'anchor_day': '2026-03-01'}],
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        max_tau=4,
    )

    assert selected is not None, (
        'Single-hop window runtime must yield SelectedAClockEvidence by '
        'chain-of-length-1 degeneracy of the subject composition.'
    )

    # Subject chain has one edge X→Y. Subject row has k_weighted=20,
    # n_weighted=100. Y_prefix at (anchor=2026-03-01, τ=3) reads the
    # rate-attributed per-source-day composition: at u=0 (anchor day),
    # M_select(X, anchor, anchor_day) = N_cohort = 100. The per-edge
    # rate at u=0 is k/n = 20/100 = 0.2. So Y_prefix(τ=3) = M_select × 0.2
    # = 100 × 0.2 = 20.
    aggregate = selected.aggregate_by_tau()
    assert float(aggregate[3]['sum_y']) == pytest.approx(20.0), (
        'Single-hop subject max-flow over one edge X→Y must equal the '
        'edge\'s rate-attributed k contribution = 20 (k_weighted=20, '
        'n_weighted=100, M_select=100 → rate 0.2 × M_select = 20). '
        'No special-case logic — natural degeneracy of the same machinery.'
    )


def test_unified_builder_natural_degeneracy_parity_window_vs_cohort_a_equals_x():
    """Cross-cutting natural-degeneracy parity test (builder-level form).

    Two runtimes constructed with identical numerical content but
    different scope/evidence-role metadata must produce numerically-
    equal ``SelectedAClockEvidence``. The 73n invariant pins ``window()``
    and ``cohort(A=X)`` as the same runtime object; the builder must not
    accidentally distinguish them via metadata.

    This is the falsifier for AP58 ("forking by case instead of
    degenerating one path") at the builder level. If the builder branches
    on metadata fields (evidence_role, scope identity, etc.) that should
    be numerically inert, this test catches it.

    Sub-stage 2c tightens this assertion to end-to-end row and chart-
    render equality on a representative fixture.
    """
    from runner.cohort_forecast_v3 import (
        _build_selected_a_clock_evidence_from_runtime,
    )

    window_runtime = _identity_carrier_runtime(
        evidence_role='window_subject_helper',
    )
    cohort_runtime = _identity_carrier_runtime(
        evidence_role='cohort_a_equals_x_subject_helper',
    )

    window_evidence = _build_selected_a_clock_evidence_from_runtime(
        window_runtime,
        cohort_list=[{'anchor_day': '2026-03-01'}],
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        max_tau=4,
    )
    cohort_evidence = _build_selected_a_clock_evidence_from_runtime(
        cohort_runtime,
        cohort_list=[{'anchor_day': '2026-03-01'}],
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        max_tau=4,
    )

    assert window_evidence is not None and cohort_evidence is not None, (
        'Both window-mode and cohort(A=X)-mode runtimes must yield '
        'SelectedAClockEvidence via identity-carrier degeneracy.'
    )

    window_agg = window_evidence.aggregate_by_tau()
    cohort_agg = cohort_evidence.aggregate_by_tau()

    assert set(window_agg.keys()) == set(cohort_agg.keys()), (
        'Window-mode and cohort(A=X)-mode aggregates must have identical '
        'τ buckets — they are the same runtime object per the 73n '
        'invariant.'
    )
    for tau in window_agg:
        for field in ('sum_x', 'sum_y', 'n_cohorts'):
            window_v = float(window_agg[tau].get(field, 0.0))
            cohort_v = float(cohort_agg[tau].get(field, 0.0))
            assert window_v == pytest.approx(cohort_v), (
                f'Natural-degeneracy parity violated at τ={tau}, '
                f'field={field}: window={window_v}, cohort(A=X)={cohort_v}. '
                'The builder must not distinguish window from cohort(A=X) '
                'via metadata; identity carrier is data, not a route '
                '(AP58 falsifier).'
            )


# ─── Sub-stage 2b — shadow-parity diagnostic ─────────────────────────────


def test_shadow_parity_single_hop_window_aggregate_matches_legacy_engine_cohort():
    """Sub-stage 2b shadow-parity diagnostic: single-hop window.

    For a single-hop window fixture the unified ``SelectedAClockEvidence``
    builder's ``aggregate_by_tau()`` must numerically agree with the
    legacy ``engine_cohort.obs_x`` / ``obs_y`` forward-fill at every τ.
    This parity is the falsifier that gates sub-stage 2c — flipping the
    row builder to read the unified evidence for window mode.

    The fixture is identical to the chain-of-length-0 / chain-of-length-1
    tests: one anchor day, one X-rooted subject snapshot at retrieved_at
    = anchor + 3 reporting (n=100, k=20). The legacy engine_cohort path
    would forward-fill this snapshot as ``obs_x[τ>=3]=100``,
    ``obs_y[τ>=3]=20``, with zeros before τ=3 (no observation yet).

    The unified builder emits a cell at τ=3 (the snapshot's tau) with
    ``x_at_query_x=100`` (carrier reach × N_cohort, identity carrier =
    full reach) and ``y_at_subject_end=20`` (rate-attributed subject
    contribution, k/n × M_select = 0.2 × 100 = 20). Aggregate cells
    forward-fill via ``cell_at_or_before``, so τ=4 also carries the
    τ=3 values.

    Both paths must agree byte-for-byte on numerical content for sub-
    stage 2b to declare single-hop parity. Any drift here is a bug in
    the new composition and must be diagnosed before sub-stage 2c.
    """
    from runner.cohort_forecast_v3 import (
        _build_selected_a_clock_evidence_from_runtime,
    )

    runtime = _identity_carrier_runtime()
    unified = _build_selected_a_clock_evidence_from_runtime(
        runtime,
        cohort_list=[{'anchor_day': '2026-03-01'}],
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        max_tau=4,
    )
    assert unified is not None
    aggregate = unified.aggregate_by_tau(tau_solid_max=3, max_tau=4)

    # Legacy engine_cohort.obs_x / obs_y for the same observation
    # timeline (anchor=2026-03-01, snapshot at τ=3 reporting n=100,
    # k=20). build_cohort_evidence_from_frames forward-fills the
    # snapshot's cumulative counts past its retrieval τ.
    legacy_obs_x = [0.0, 0.0, 0.0, 100.0, 100.0]
    legacy_obs_y = [0.0, 0.0, 0.0, 20.0, 20.0]

    for tau in range(5):
        bucket = aggregate.get(tau)
        if bucket is None:
            # The unified aggregate emits a bucket whenever the carrier
            # surface has a cell at-or-before τ. For τ < the snapshot τ
            # the unified result correctly omits the bucket (the
            # Absent state of §3.1). Legacy obs_x/obs_y are 0 at the
            # same τ values — both paths agree on "no evidence yet"
            # via different encodings (omission vs zero). This is the
            # natural-degeneracy boundary and is accepted parity.
            assert legacy_obs_x[tau] == 0.0, (
                f'τ={tau}: unified absent but legacy '
                f'obs_x={legacy_obs_x[tau]} — both paths must agree on '
                'the no-evidence boundary.'
            )
            assert legacy_obs_y[tau] == 0.0
            continue
        # Both paths produced a value at this τ — must agree numerically.
        assert float(bucket['sum_x']) == pytest.approx(legacy_obs_x[tau]), (
            f'τ={tau}: unified sum_x={bucket["sum_x"]} legacy '
            f'obs_x={legacy_obs_x[tau]} — single-hop window parity '
            'broken; sub-stage 2c blocked until this is diagnosed.'
        )
        assert float(bucket['sum_y']) == pytest.approx(legacy_obs_y[tau]), (
            f'τ={tau}: unified sum_y={bucket["sum_y"]} legacy '
            f'obs_y={legacy_obs_y[tau]} — single-hop window parity '
            'broken; sub-stage 2c blocked until this is diagnosed.'
        )


def test_shadow_multi_hop_window_unified_builder_composes_without_error():
    """Sub-stage 2b multi-hop catalogue smoke: the unified builder
    accepts a chain-of-length-2 window-mode subject configuration and
    produces a non-empty ``SelectedAClockEvidence``.

    Per the design (§5.2 risk paragraph + §6.4): multi-hop window
    drift between the unified composition and the legacy frame-derived
    ``compose_path_maturity_frames`` path is **expected, not a
    regression**. The legacy path reads frame ``dp.x``/``dp.y`` which
    may not faithfully reflect topology composition for chains; the
    unified path runs max-flow on the calendar-date axis (the
    principled mixed-cohort interpretation per Appendix A). The
    canonical multi-hop drift catalogue is the outside-in oracle
    suite — its multi-hop window pinning tests will reveal drift
    case-by-case when sub-stage 2c flips the row builder.

    This unit-level smoke test asserts only that the unified builder's
    chain-of-length-2 composition machinery functions on a multi-hop
    window runtime — i.e. the natural-degeneracy framing extends from
    single-hop (length-1 subject) to multi-hop (length-2+ subject)
    without structural failure. Numerical correctness is owned by the
    outside-in suite.
    """
    from runner.cohort_forecast_v3 import (
        _build_carrier_only_denominator_prefix,
        _build_selected_a_clock_evidence_from_runtime,
    )

    # Two subject primitives in series: X→I→Y. Identity carrier
    # (population_root == denominator_node == 'node-x').
    subject_xi = _weighted_primitive(
        edge_id='x-to-i',
        source='node-x',
        dest='node-i',
        rows=[{
            'observed_date': '2026-03-01',
            'retrieved_at': '2026-03-03',
            'n': 100,
            'k': 80,
            'n_weighted': 100.0,
            'k_weighted': 80.0,
            'root_day_shares': {'2026-03-01': 1.0},
        }],
    )
    subject_iy = _weighted_primitive(
        edge_id='i-to-y',
        source='node-i',
        dest='node-y',
        rows=[{
            'observed_date': '2026-03-02',
            'retrieved_at': '2026-03-04',
            'n': 80,
            'k': 20,
            'n_weighted': 80.0,
            'k_weighted': 20.0,
            'root_day_shares': {'2026-03-02': 1.0},
        }],
    )
    runtime = SimpleNamespace(
        graph={
            'nodes': [
                {'id': 'node-x'}, {'id': 'node-i'}, {'id': 'node-y'},
            ],
            'edges': [
                {'from': 'node-x', 'to': 'node-i', 'id': 'x-to-i'},
                {'from': 'node-i', 'to': 'node-y', 'id': 'i-to-y'},
            ],
        },
        population_root='node-x',
        denominator_node='node-x',
        subject_end='node-y',
        composed_carrier=None,
        composed_subject=_span(
            cdf_draws=[[0.0, 0.0, 0.0, 0.16, 0.16]],
            p_draws=[0.16],
        ),
        conditioned_primitive_map={
            'subject_xi': subject_xi,
            'subject_iy': subject_iy,
        },
        runtime_provenance={
            'primitives': {
                'carrier': [],
                'subject': [
                    {'edge_id': 'x-to-i'},
                    {'edge_id': 'i-to-y'},
                ],
            },
        },
    )
    runtime.selected_source_day_mass = _select_source_day_mass_at_x(
        denominator_node='node-x',
        n_cohort_by_anchor={'2026-03-01': 100.0},
        carrier_cdf=[1.0, 1.0, 1.0, 1.0, 1.0],
    )
    runtime.selected_x_prefix = _build_carrier_only_denominator_prefix(
        runtime=runtime,
        anchor_days=['2026-03-01'],
        n_cohort_by_anchor={'2026-03-01': 100.0},
        max_tau=4,
    )
    runtime.selected_y_prefix = None

    unified = _build_selected_a_clock_evidence_from_runtime(
        runtime,
        cohort_list=[{'anchor_day': '2026-03-01'}],
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        max_tau=4,
    )

    # Chain-of-length-2 subject composition must produce evidence —
    # the structural assertion. Numerical comparison against legacy
    # is delegated to the outside-in oracle.
    assert unified is not None, (
        'Multi-hop window runtime (chain-of-length-2 subject) must '
        'flow through the unified builder; the natural-degeneracy '
        'framing of sub-stage 2a/2b extends from length-1 to '
        'length-2+ subjects without structural failure.'
    )
    # The carrier surface (chain-of-length-0, identity) is synthesised
    # from the X-rooted subject primitive (X→I), confirming that the
    # carrier-side natural degeneracy is independent of subject chain
    # length.
    carrier_surface = getattr(runtime, 'observed_carrier_a_to_x', None)
    assert carrier_surface is not None and carrier_surface.has_cells(), (
        'Identity-carrier synthesis must read from the X-rooted '
        'subject primitive (X→I in this chain) regardless of how '
        'many subject hops follow it.'
    )


# ─── Sub-stage 2c — end-to-end parity (tightened from 2a builder-level) ──


def _identity_carrier_engine_cohort(*, a_pop=100.0, frontier_age=3):
    """Engine cohort for an identity-carrier (window or cohort(A=X))
    fixture. After 2c the row builder reads evidence from the unified
    ``SelectedAClockEvidence`` for both modes, but engine_cohorts still
    feed ``a_pop`` and the reducer's identity-carrier prefix; the
    fields are populated for that consumer.
    """
    from runner.forecast_state import CohortEvidence

    return CohortEvidence(
        obs_x=[0.0] * (frontier_age + 1),
        obs_y=[0.0] * (frontier_age + 1),
        x_frozen=0.0,
        y_frozen=0.0,
        frontier_age=frontier_age,
        a_pop=a_pop,
    )


def test_end_to_end_parity_window_vs_cohort_a_equals_x_row_dicts():
    """Builder-and-row-builder parity check (NOT end-to-end production wiring).

    Equivalent ``window(X→end)`` and ``cohort(A=X, X→end)`` runtimes —
    same observation timeline, same X, same subject end, same date
    range, identical numerical content modulo evidence-role metadata —
    must produce identical row dicts when projected through
    ``_project_runtime_rows`` after the selected-evidence builder runs.

    **Scope honesty (atom-3 plan stage 1)**: this test fixture
    pre-populates ``runtime.selected_source_day_mass`` and
    ``runtime.selected_x_prefix`` directly (see
    ``_identity_carrier_runtime``), bypassing the production wiring
    step ``_root_window_carrier_n_by_anchor_day`` and the
    n_by_anchor-gated assignment in ``compute_cohort_maturity_rows_v3``
    that contain the slice-family filter at ``cohort_forecast_v3.py:1799``.
    The audit recorded in ``docs/current/cohort-maturity-atom-3-plan.md``
    §1 flagged this as the AP59 fixture bypass: this test passing does
    NOT prove the unified path traverses the production wiring on real
    queries. The true end-to-end provenance gate lives in
    ``test_cohort_factorised_outside_in.py``
    (``test_a_equals_x_provenance_uses_unified_path_not_rescue``).

    What this test does prove, with the provenance assertions added at
    stage 1, is that **given** a runtime whose carrier-side wiring has
    been satisfied (by whatever means), the unified builder accepts it
    for both ``window`` and ``cohort(A=X)`` and emits cells with
    refusal='ok' for both modes, and the row builder emits identical
    row dicts. That is a necessary-but-not-sufficient closure check.
    """
    from runner.cohort_forecast_v3 import (
        _build_selected_a_clock_evidence_from_runtime,
        _project_runtime_rows,
    )

    def _project_rows(*, evidence_role: str):
        runtime = _identity_carrier_runtime(evidence_role=evidence_role)
        cohort_list = [{'anchor_day': '2026-03-01'}]
        selected = _build_selected_a_clock_evidence_from_runtime(
            runtime,
            cohort_list=cohort_list,
            anchor_from='2026-03-01',
            anchor_to='2026-03-01',
            max_tau=4,
        )

        # Atom-3 stage 1 provenance assertions. The unified builder
        # must succeed (refusal='ok') and emit cells for both modes;
        # absence of these would mean the builder refused, which on
        # the production wiring path triggers the AP59 silent rescue
        # in the reducer (cohort_forecast_v3.py:4796-4801).
        assert selected is not None and selected.has_cells(), (
            f"Selected-evidence builder must succeed and emit cells "
            f"for evidence_role={evidence_role!r}; got "
            f"selected={selected!r}"
        )
        diag = getattr(
            runtime, 'selected_a_clock_evidence_diagnostics', None,
        )
        assert diag is not None and diag.get('refusal') == 'ok', (
            f"Selected-evidence diagnostics must report refusal='ok' "
            f"for evidence_role={evidence_role!r}; got {diag!r}. "
            f"Any other refusal token means the builder degenerated "
            f"and the reducer would silently rescue via "
            f"engine_cohort.obs_x/obs_y (AP59)."
        )

        engine_cohort = _identity_carrier_engine_cohort(
            a_pop=100.0, frontier_age=3,
        )
        # Public moments + unconditioned overlays are required by
        # `_project_runtime_rows` for the model/F surfaces. Use the
        # same content for both runtimes so we are testing the
        # evidence-emission path, not the model overlay.
        runtime.public_moments = SimpleNamespace(
            p_mean=0.2, p_sd=0.05, p_sd_epistemic=0.03,
        )
        runtime.unconditioned_overlays = {}
        return _project_runtime_rows(
            runtime=runtime,
            engine_cohorts=[engine_cohort],
            cohort_list=cohort_list,
            cohort_eval_ages=[3],
            cohort_weights=[100.0],
            max_tau=4,
            tau_solid_max=3,
            tau_future_max=4,
            sweep_to='2026-03-06',
            band_level=0.90,
            selected_a_clock_evidence=selected,
        )

    window_rows = _project_rows(evidence_role='window_subject_helper')
    cohort_rows = _project_rows(
        evidence_role='cohort_a_equals_x_subject_helper',
    )

    assert len(window_rows) == len(cohort_rows), (
        f'Row counts must match: window={len(window_rows)} '
        f'cohort(A=X)={len(cohort_rows)}'
    )

    # Evidence-emission fields are the load-bearing parity targets for
    # sub-stage 2c. Provenance / diagnostic / model-overlay metadata
    # may legitimately differ in serialised form (scope strings,
    # source labels) without affecting chart-visible semantics; the
    # contract is identical numerical content on the evidence side.
    parity_fields = (
        'tau_days',
        'evidence_x',
        'evidence_y',
        'evidence_x_coverage',
        'evidence_y_coverage',
        'coverage',
        'rate',
        'rate_pure',
    )
    for idx, (w_row, c_row) in enumerate(zip(window_rows, cohort_rows)):
        for field in parity_fields:
            w_val = w_row.get(field)
            c_val = c_row.get(field)
            if w_val is None and c_val is None:
                continue
            assert w_val == pytest.approx(c_val) if (
                isinstance(w_val, (int, float))
                and isinstance(c_val, (int, float))
            ) else w_val == c_val, (
                f'End-to-end parity violated at row idx={idx}, '
                f'field={field!r}: window={w_val!r} '
                f'cohort(A=X)={c_val!r}. The row builder must not '
                'distinguish window from cohort(A=X) for evidence '
                'emission — identity carrier is data, not a route '
                '(canonical invariant 6).'
            )


# ─── Strict observation-support frontier tests ─────────────────────────────
# Per docs/current/selected-a-clock-retrieval-frontier-provenance-proposal.md:
# active `cohort(A != X)` projection must derive its per-Cohort frontier
# from real retrieval landings, never from forward-filled display cells at
# the chart horizon. Forward-filled `x_at_query_x` / `y_at_subject_end`
# values exist so the chart line stays continuous; they are not support
# for the projection's observed/future split.


def _selected_cell(anchor_day, tau, x, y, data_retrieved_at=None):
    from runner.cohort_forecast_v3 import SelectedAClockEvidenceCell
    return SelectedAClockEvidenceCell(
        anchor_day=anchor_day,
        tau=int(tau),
        x_at_query_x=float(x),
        y_at_subject_end=float(y),
        data_retrieved_at=data_retrieved_at,
    )


def test_strict_support_paired_frontier_supersedes_forward_fill():
    """Active mode: forward-fill past real landings does not extend frontier.

    Cells exist at τ ∈ {0..6} (sweep-grid carry-forward), but the carrier
    role had its last real exact-τ landing at τ=3 and the subject role at
    τ=4. Paired support is min(3, 4) = 3. `prefix_for_anchor_day` with
    `use_retrieval_frontier=True` must return frontier_age=3, not τ=6.
    """
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        _SelectedRoleSupport,
    )

    cells = {
        '2026-03-01': {
            tau: _selected_cell('2026-03-01', tau, 10.0 + tau, 1.0 + tau)
            for tau in range(7)
        },
    }
    strict = {
        '2026-03-01': _SelectedRoleSupport(
            carrier_tau=3, subject_tau=4, paired_tau=3,
        ),
    }
    selected = SelectedAClockEvidence(
        cells_by_anchor_day=cells,
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        source='test_strict_support',
        strict_support_by_anchor=strict,
    )

    prefix = selected.prefix_for_anchor_day(
        '2026-03-01', horizon=10, use_retrieval_frontier=True,
    )
    assert prefix is not None
    assert prefix.frontier_age == 3, (
        f'Strict-support paired_tau=3 must override forward-fill max τ=6; '
        f'got frontier_age={prefix.frontier_age}. Forward-filled display '
        f'cells beyond the real retrieval frontier are not observation '
        f'support — see proposal §"Display Forward-Fill Is Not Support".'
    )
    # x_frozen / y_frozen freeze at the strict frontier, not the chart
    # horizon. Otherwise the row reducer integrates stale forward-filled
    # mass into the observed prefix and Pop D/Pop C have no future
    # interval to project into.
    assert prefix.x_frozen == 13.0
    assert prefix.y_frozen == 4.0


def test_analysis_observation_frontier_date_overrides_forward_fill_globally():
    """The projection frontier is one analysis-wide as-of date.

    The selected cells may exist through τ=8 and role support may report a
    later frontier, but the query-wide observation frontier date is the datum
    the reducer must consume. It is converted to per-Cohort τ only after the
    global date has been chosen.
    """
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        _SelectedRoleSupport,
    )

    cells = {
        '2026-03-01': {
            tau: _selected_cell('2026-03-01', tau, 10.0 + tau, 1.0 + tau)
            for tau in range(9)
        },
        '2026-03-03': {
            tau: _selected_cell('2026-03-03', tau, 20.0 + tau, 5.0 + tau)
            for tau in range(9)
        },
    }
    strict = {
        '2026-03-01': _SelectedRoleSupport(
            carrier_tau=8, subject_tau=8, paired_tau=8,
        ),
        '2026-03-03': _SelectedRoleSupport(
            carrier_tau=8, subject_tau=8, paired_tau=8,
        ),
    }
    selected = SelectedAClockEvidence(
        cells_by_anchor_day=cells,
        anchor_from='2026-03-01',
        anchor_to='2026-03-03',
        source='test_analysis_frontier',
        strict_support_by_anchor=strict,
        analysis_observation_frontier_date='2026-03-05',
    )

    prefixes = selected.prefixes_for_cohorts(
        [
            {'anchor_day': '2026-03-01'},
            {'anchor_day': '2026-03-03'},
        ],
        horizon=10,
        use_retrieval_frontier=True,
    )

    assert prefixes[0] is not None and prefixes[1] is not None
    assert prefixes[0].frontier_age == 4
    assert prefixes[0].x_frozen == 14.0
    assert prefixes[0].y_frozen == 5.0
    assert prefixes[1].frontier_age == 2
    assert prefixes[1].x_frozen == 22.0
    assert prefixes[1].y_frozen == 7.0
    assert selected.min_frontier_tau(
        [
            {'anchor_day': '2026-03-01'},
            {'anchor_day': '2026-03-03'},
        ],
        use_retrieval_frontier=True,
    ) == 2
    assert selected.frontier_tau_bounds(
        [
            {'anchor_day': '2026-03-01'},
            {'anchor_day': '2026-03-03'},
        ],
        use_retrieval_frontier=True,
    ) == (2, 4)


def test_analysis_observation_frontier_bounds_do_not_spread_for_single_cohort():
    """A single selected Cohort maps one frontier date to one τ."""
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        _SelectedRoleSupport,
    )

    cells = {
        '2026-03-03': {
            tau: _selected_cell('2026-03-03', tau, 20.0 + tau, 5.0 + tau)
            for tau in range(9)
        },
    }
    strict = {
        '2026-03-03': _SelectedRoleSupport(
            carrier_tau=8, subject_tau=8, paired_tau=8,
        ),
    }
    selected = SelectedAClockEvidence(
        cells_by_anchor_day=cells,
        anchor_from='2026-03-03',
        anchor_to='2026-03-03',
        source='test_single_analysis_frontier',
        strict_support_by_anchor=strict,
        analysis_observation_frontier_date='2026-03-05',
    )

    assert selected.frontier_tau_bounds(
        [{'anchor_day': '2026-03-03'}],
        use_retrieval_frontier=True,
    ) == (2, 2)


def test_analysis_observation_frontier_date_uses_superset_max_then_asat_cap():
    """Frontier date is max(superset dates), capped by asat afterwards."""
    from runner.cohort_forecast_v3 import _analysis_observation_frontier_date

    frontier = _analysis_observation_frontier_date(
        per_edge_results_by_uuid={
            'edge-a': {
                'evidence_superset_rows': [
                    {
                        'snapshot_date': '2026-03-06',
                        'data_retrieved_at': '2026-03-04',
                        'retrieved_at': '2026-03-05T12:00:00',
                    },
                    {
                        'snapshot_date': '2026-03-08',
                        'data_retrieved_at': '2026-03-09',
                        'retrieved_at': '2026-03-07',
                    },
                ],
            },
        },
        as_at='2026-03-07',
    )

    assert frontier == '2026-03-07'


def test_analysis_observation_frontier_date_ignores_virtual_frames():
    """Virtual/carry-forward frames must not manufacture observation support."""
    from runner.cohort_forecast_v3 import _analysis_observation_frontier_date

    frontier = _analysis_observation_frontier_date(
        per_edge_results_by_uuid={
            'edge-a': {
                'evidence_superset_rows': [
                    {
                        'snapshot_date': '2026-03-02',
                        'data_retrieved_at': '2026-03-03',
                        'retrieved_at': '2026-03-04',
                    },
                ],
                'derivation_result': {
                    'frames': [
                        {
                            'snapshot_date': '2026-03-20',
                            'data_points': [
                                {
                                    'anchor_day': '2026-03-01',
                                    'data_retrieved_at': '2026-03-19',
                                },
                            ],
                        },
                    ],
                },
            },
        },
        as_at='2026-03-31',
    )

    assert frontier == '2026-03-04'


def test_analysis_observation_frontier_date_absent_without_superset_dates():
    """No admitted superset date means no query-wide frontier override."""
    from runner.cohort_forecast_v3 import _analysis_observation_frontier_date

    frontier = _analysis_observation_frontier_date(
        per_edge_results_by_uuid={
            'edge-a': {
                'evidence_superset_rows': [],
                'derivation_result': {
                    'frames': [{'snapshot_date': '2026-03-20'}],
                },
            },
        },
        as_at='2026-03-31',
    )

    assert frontier is None


def test_strict_support_absent_paired_tau_falls_back_to_legacy():
    """Active mode: when paired support is absent, the legacy fallback
    chain runs (data_retrieved_at, then max τ).

    The proposal classes missing strict support as a legacy/malformed-input
    case. The runtime builder is expected to populate strict support on
    normal active requests; tests that construct SelectedAClockEvidence
    via `from_frames` exercise the data_retrieved_at branch.
    """
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        _SelectedRoleSupport,
    )

    cells = {
        '2026-03-01': {
            0: _selected_cell('2026-03-01', 0, 10.0, 1.0,
                              data_retrieved_at='2026-03-03'),
            1: _selected_cell('2026-03-01', 1, 11.0, 2.0,
                              data_retrieved_at='2026-03-03'),
            2: _selected_cell('2026-03-01', 2, 12.0, 3.0,
                              data_retrieved_at='2026-03-03'),
        },
    }
    # Carrier has strict support at τ=2 but subject has none → paired_tau
    # is absent (active mode requires both required roles).
    strict = {
        '2026-03-01': _SelectedRoleSupport(
            carrier_tau=2, subject_tau=None, paired_tau=None,
        ),
    }
    selected = SelectedAClockEvidence(
        cells_by_anchor_day=cells,
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        source='test_strict_support',
        strict_support_by_anchor=strict,
    )

    prefix = selected.prefix_for_anchor_day(
        '2026-03-01', horizon=5, use_retrieval_frontier=True,
    )
    assert prefix is not None
    # data_retrieved_at='2026-03-03' (anchor=2026-03-01) → τ=2. Legacy
    # fallback honours the real retrieval date even when paired strict
    # support is absent.
    assert prefix.frontier_age == 2


def test_strict_support_per_cohort_not_group_scalar():
    """Two cohorts with different real-landing taus get different frontiers.

    The proposal: "The same calendar retrieval date maps to a different
    tau for each selected Cohort." Verified directly via
    `prefixes_for_cohorts`.
    """
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        _SelectedRoleSupport,
    )

    cells = {
        '2026-03-01': {
            tau: _selected_cell('2026-03-01', tau, 10.0 + tau, 1.0 + tau)
            for tau in range(8)
        },
        '2026-03-05': {
            tau: _selected_cell('2026-03-05', tau, 20.0 + tau, 5.0 + tau)
            for tau in range(8)
        },
    }
    # Same calendar retrieved_at date (2026-03-08) lands at different τ
    # for each anchor (τ=7 for 2026-03-01, τ=3 for 2026-03-05).
    strict = {
        '2026-03-01': _SelectedRoleSupport(
            carrier_tau=7, subject_tau=7, paired_tau=7,
        ),
        '2026-03-05': _SelectedRoleSupport(
            carrier_tau=3, subject_tau=3, paired_tau=3,
        ),
    }
    selected = SelectedAClockEvidence(
        cells_by_anchor_day=cells,
        anchor_from='2026-03-01',
        anchor_to='2026-03-05',
        source='test_strict_support',
        strict_support_by_anchor=strict,
    )

    cohort_list = [
        {'anchor_day': '2026-03-01'},
        {'anchor_day': '2026-03-05'},
    ]
    prefixes = selected.prefixes_for_cohorts(
        cohort_list, horizon=10, use_retrieval_frontier=True,
    )
    assert prefixes[0] is not None and prefixes[1] is not None
    assert prefixes[0].frontier_age == 7
    assert prefixes[1].frontier_age == 3, (
        'Support is per-Cohort, not a group-wide scalar. Same calendar '
        'retrieval date maps to different τ for each anchor — the '
        'frontier must reflect this per cohort.'
    )

    # `min_frontier_tau` aggregates only after each cohort has its own
    # frontier (proposal §"Support Is Per Cohort").
    assert selected.min_frontier_tau(
        cohort_list, use_retrieval_frontier=True,
    ) == 3


def test_strict_support_identity_carrier_subject_only():
    """Identity-carrier mode: paired_tau equals subject_tau.

    Per the proposal: "For identity-carrier cases this degenerates
    naturally: the carrier is structural identity, so the subject side
    is the only retrieval-bearing role." The runtime builder sets
    paired_tau = subject_tau directly in identity mode.
    """
    from runner.cohort_forecast_v3 import (
        SelectedAClockEvidence,
        _SelectedRoleSupport,
    )

    cells = {
        '2026-03-01': {
            tau: _selected_cell('2026-03-01', tau, 10.0, 1.0 + tau)
            for tau in range(6)
        },
    }
    strict = {
        '2026-03-01': _SelectedRoleSupport(
            carrier_tau=None, subject_tau=2, paired_tau=2,
        ),
    }
    selected = SelectedAClockEvidence(
        cells_by_anchor_day=cells,
        anchor_from='2026-03-01',
        anchor_to='2026-03-01',
        source='test_strict_support_identity',
        strict_support_by_anchor=strict,
    )

    prefix = selected.prefix_for_anchor_day(
        '2026-03-01', horizon=10, use_retrieval_frontier=True,
    )
    assert prefix is not None
    assert prefix.frontier_age == 2
