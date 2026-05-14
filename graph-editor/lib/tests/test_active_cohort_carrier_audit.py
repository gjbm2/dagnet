"""
Stage 6/9 dead-code audit / reachability test (73n closure).

Plan: docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md
§"Stage 6 — Carrier Consumer" lines 715-727:

    Once Stages 5a, 5b, 5c, and 6 are all at acceptance, identify
    every aggregate-IS, window evidence-admission, and trajectory-
    local conditioning site that no longer has a live caller. Each
    such site must be either deleted or relabelled and proven to be
    an internal helper called only by primitive construction. A
    leftover code path that could be reached under any flag
    combination must be deleted, not gated, and the reachability
    test must be recorded.

This file is the recorded reachability test after the Stage 9 closure
event. The legacy ``build_upstream_carrier`` / ``_build_tier2_empirical`` /
``_build_tier3_weak_prior`` / ``_resolve_frame_carrier_state`` surface must
be absent from the live v3 runner cluster. Carrier timing is now owned by
primitive-backed composition, not by empirical Tier 2 / weak-prior tiers.
"""

from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# ─── Path utilities ────────────────────────────────────────────────────


_RUNNER_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), '..', 'runner')
)


def _read(name: str) -> str:
    with open(os.path.join(_RUNNER_DIR, name), encoding='utf-8') as fh:
        return fh.read()


def _runner_files() -> list[str]:
    """Source files in graph-editor/lib/runner/ excluding legacy v1/v2
    cohort_forecast files (those are dev-only per
    BE_RUNNER_CLUSTER §4)."""
    out: list[str] = []
    for entry in sorted(os.listdir(_RUNNER_DIR)):
        if not entry.endswith('.py'):
            continue
        if entry in (
            'cohort_forecast.py',          # v1, dev-only
            'cohort_forecast_v2.py',       # v2, dev-only
            '__init__.py',
        ):
            continue
        out.append(entry)
    return out


def _file_contains_pattern(filename: str, pattern: str) -> bool:
    src = _read(filename)
    return re.search(pattern, src) is not None


# ─── Reachability map: build_upstream_carrier ──────────────────────────


def test_build_upstream_carrier_definition_is_retired():
    """Stage 9 closure deletes the legacy carrier dispatcher."""
    src = _read('forecast_runtime.py')
    assert re.search(
        r'^def build_upstream_carrier\(', src, re.MULTILINE,
    ) is None


def test_build_upstream_carrier_has_no_live_runner_callers():
    """No live v3 runner module may call the retired carrier dispatcher."""
    callers: list[str] = []
    for filename in _runner_files():
        src = _read(filename)
        if re.search(r'\bbuild_upstream_carrier\s*\(', src):
            callers.append(filename)
    assert callers == [], (
        f'build_upstream_carrier is retired; got live callers {callers!r}.'
    )


def test_resolve_frame_carrier_state_definition_is_retired():
    """The scoped frame carrier compatibility helper is no longer live."""
    src = _read('cohort_forecast_v3.py')
    match = re.search(
        r'def _resolve_frame_carrier_state\b.*?'
        r'(?=\n(?:def |class )|\Z)',
        src,
        re.DOTALL,
    )
    assert match is None


def test_resolve_frame_carrier_state_has_no_live_callers():
    """The retired helper must not remain as a callable compatibility path."""
    callers: list[str] = []
    for filename in _runner_files():
        src = _read(filename)
        if re.search(r'\b_resolve_frame_carrier_state\s*\(', src):
            callers.append(filename)
    assert callers == [], (
        f'_resolve_frame_carrier_state is retired; got callers {callers!r}.'
    )


# ─── Reachability map: tier-2 / tier-3 helpers ─────────────────────────


def test_tier2_empirical_helper_is_retired():
    """Empirical Tier 2 must not remain as a live carrier timing owner."""
    mentions: list[str] = []
    for filename in _runner_files():
        src = _read(filename)
        if '_build_tier2_empirical' in src:
            mentions.append(filename)
    assert mentions == [], (
        f'_build_tier2_empirical is retired; got mentions {mentions!r}.'
    )


def test_tier3_weak_prior_helper_is_retired():
    """Weak-prior carrier timing must not remain as a live fallback."""
    mentions: list[str] = []
    for filename in _runner_files():
        src = _read(filename)
        if '_build_tier3_weak_prior' in src:
            mentions.append(filename)
    assert mentions == [], (
        f'_build_tier3_weak_prior is retired; got mentions {mentions!r}.'
    )


# ─── Reachability map: Stage 6 readout does NOT reach the legacy path ─


def test_active_cohort_carrier_readout_does_not_call_build_upstream_carrier():
    """Plan §717: Stage 6 "uses the completed composer from 73m. It
    should not add carrier evidence roles. It should feed the composer
    the same primitive posterior objects used by other consumers."

    The active-cohort readout module must NOT route any composition
    through ``build_upstream_carrier``.
    """
    src = _read('primitive_readout.py')
    # Comments and docstrings reference the name; allow those, but
    # disallow function-call syntax.
    bad_call = re.search(r'(?<!\.)build_upstream_carrier\s*\(', src)
    assert bad_call is None, (
        'primitive_readout.py contains a call to build_upstream_carrier; '
        'active-cohort carrier composition must use the primitive-span path.'
    )


def test_active_cohort_carrier_readout_uses_primitive_span_composer():
    """The active-cohort carrier path uses the same primitive-span composer
    as the subject span. Post-5.5 the composer call lives in
    ``model_span_spine.resolve_request_spans`` which ``primitive_readout``
    drives via the perimeter wrapper."""
    readout_src = _read('primitive_readout.py')
    assert 'compose_carrier_to_x(' not in readout_src, (
        'primitive_readout.py should not invoke compose_carrier_to_x for '
        'active-cohort carrier readout.'
    )
    spine_src = _read('model_span_spine.py')
    assert 'compose_primitive_span(' in spine_src, (
        'model_span_spine.py should use the shared primitive-span composer '
        'for active-cohort carrier and subject spans.'
    )
    assert 'resolve_request_spans' in readout_src, (
        'primitive_readout.py should drive the spine composer via '
        'resolve_request_spans.'
    )


# ─── Reachability map: legacy v1/v2 cohort_forecast modules ────────────


def test_cohort_forecast_v1_v2_not_imported_from_runner_cluster():
    """``cohort_forecast.py`` (v1) and ``cohort_forecast_v2.py`` (v2)
    are dev-only per BE_RUNNER_CLUSTER §4. No live module in the v3
    runner cluster imports them.
    """
    for legacy in ('cohort_forecast', 'cohort_forecast_v2'):
        importers: list[str] = []
        for filename in _runner_files():
            src = _read(filename)
            if re.search(
                rf'(?:from\s+\.{legacy}\b|from\s+runner\.{legacy}\b'
                rf'|import\s+\.{legacy}\b)',
                src,
            ):
                importers.append(filename)
        assert importers == [], (
            f'{legacy} is dev-only (BE_RUNNER_CLUSTER §4); no live '
            f'runner module should import it. Got importers: '
            f'{importers!r}.'
        )


# ─── Stage 5 readouts do NOT reach the legacy path either ──────────────


def test_subject_span_composer_does_not_reach_build_upstream_carrier():
    """The Stage 5b / 5c subject-span composer composes via
    ``span_kernel`` — it must not call the legacy carrier
    dispatcher."""
    src = _read('subject_span_composer.py')
    bad_call = re.search(r'(?<!\.)build_upstream_carrier\s*\(', src)
    assert bad_call is None, (
        'subject_span_composer.py must not invoke '
        'build_upstream_carrier; the subject span uses span_kernel '
        'composition exclusively.'
    )


# ─── Headline reachability summary (informational) ─────────────────────


def test_forecast_runtime_no_longer_documents_tiered_carrier_as_live():
    """The live runtime docs should not point readers to the deleted tiers."""
    src = _read('forecast_runtime.py')
    assert '73n Stage 6 retirement status' not in src
    assert re.search(
        r'^def build_upstream_carrier\(', src, re.MULTILINE,
    ) is None
