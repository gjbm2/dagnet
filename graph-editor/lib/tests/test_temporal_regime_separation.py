"""
Temporal Regime Separation — Blind Tests

Window and cohort observations are fundamentally different evidence
families (x-anchored vs a-anchored). They produce different core_hashes
(cohort_mode is a hash input). They must NEVER be grouped as equivalents
within one CandidateRegime — doing so makes regime selection unable to
separate them, and downstream derivation sums a-anchored x with
x-anchored x into meaningless totals.

ALL tests in this file encode the correct design and MUST FAIL against
the current system. They will turn green once:
  1. candidateRegimeService.ts emits separate candidates per temporal mode
  2. v2/v3 cohort maturity handlers call _apply_regime_selection
  3. Candidate ordering respects the requested temporal mode

Run with: pytest lib/tests/test_temporal_regime_separation.py -v
"""

import os
import sys
import copy
import functools

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '../../.env.local'))

import json
import pytest

from conftest import (
    load_candidate_regimes_by_mode,
    load_db_hashes_by_mode,
    load_graph_json,
    requires_db,
    requires_data_repo,
    requires_synth,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_synth_graph():
    return load_graph_json('synth-simple-abc')


def _get_db_hashes_by_mode(graph):
    return load_db_hashes_by_mode('synth-simple-abc')


def _get_current_candidate_regimes(graph):
    return load_candidate_regimes_by_mode('synth-simple-abc')


@functools.lru_cache(maxsize=None)
def _run_v3_cached(dsl, query_dsl):
    from api_handlers import _handle_cohort_maturity_v3
    result = _handle_cohort_maturity_v3({
        'scenarios': [{
            'scenario_id': 'test',
            'graph': _load_synth_graph(),
            'analytics_dsl': dsl,
            'effective_query_dsl': query_dsl,
            'candidate_regimes_by_edge': _get_current_candidate_regimes(None),
        }],
    })
    for s in (result.get('subjects') or
              result.get('scenarios', [{}])[0].get('subjects', [])):
        rows = s.get('result', {}).get('maturity_rows', [])
        if rows:
            return rows
    if 'result' in result and isinstance(result['result'], dict):
        return result['result'].get('maturity_rows', [])
    return []


def _run_v3(graph, regimes, dsl, query_dsl):
    return copy.deepcopy(_run_v3_cached(dsl, query_dsl))


# ---------------------------------------------------------------------------
# §1 — Candidate regime structure: window and cohort must be separate
# ---------------------------------------------------------------------------

@requires_db
@requires_data_repo
@requires_synth("synth-simple-abc", enriched=True)
class TestCandidateRegimeStructure:
    """The candidate regime list for each edge must have window and
    cohort hashes in SEPARATE CandidateRegime entries, never as
    equivalents within one. This test asserts the correct structure
    and fails because the current system groups them."""

    def test_synth_edge_has_both_temporal_modes_in_db(self):
        """Precondition: the synth DB has both window and cohort rows
        for each edge, under different core_hashes."""
        graph = _load_synth_graph()
        by_mode = _get_db_hashes_by_mode(graph)
        assert len(by_mode) > 0, 'No edges found in DB'
        for edge_uuid, modes in by_mode.items():
            assert len(modes['window']) > 0, (
                f'Edge {edge_uuid} has no window hashes in DB')
            assert len(modes['cohort']) > 0, (
                f'Edge {edge_uuid} has no cohort hashes in DB')
            # Window and cohort hashes must be DIFFERENT
            assert set(modes['window']).isdisjoint(set(modes['cohort'])), (
                f'Edge {edge_uuid}: window and cohort share a hash — '
                f'cohort_mode must be a hash input')

    def test_current_regimes_separate_temporal_modes(self):
        """Each edge's candidate regime list must contain at least two
        entries: one whose hashes are all window-mode, one whose hashes
        are all cohort-mode. No single candidate may contain hashes
        from both modes."""
        graph = _load_synth_graph()
        regimes = _get_current_candidate_regimes(graph)
        by_mode = _get_db_hashes_by_mode(graph)

        for edge_uuid, candidates in regimes.items():
            modes_in_db = by_mode.get(edge_uuid, {})
            window_hashes = set(modes_in_db.get('window', []))
            cohort_hashes = set(modes_in_db.get('cohort', []))

            if not window_hashes or not cohort_hashes:
                continue  # edge only has one mode — nothing to separate

            # Check no single candidate mixes modes
            for i, cand in enumerate(candidates):
                all_h = {cand['core_hash']} | set(cand.get('equivalent_hashes', []))
                has_window = bool(all_h & window_hashes)
                has_cohort = bool(all_h & cohort_hashes)
                assert not (has_window and has_cohort), (
                    f'Edge {edge_uuid} candidate[{i}] mixes temporal modes: '
                    f'contains window hash(es) {all_h & window_hashes} AND '
                    f'cohort hash(es) {all_h & cohort_hashes}. '
                    f'Window and cohort must be separate candidates.')

            # Check both modes are represented as separate candidates
            any_window_cand = any(
                ({c['core_hash']} | set(c.get('equivalent_hashes', []))) & window_hashes
                for c in candidates
            )
            any_cohort_cand = any(
                ({c['core_hash']} | set(c.get('equivalent_hashes', []))) & cohort_hashes
                for c in candidates
            )
            assert any_window_cand and any_cohort_cand, (
                f'Edge {edge_uuid}: must have separate candidates for '
                f'window and cohort modes')


# ---------------------------------------------------------------------------
# §2 — Handler evidence: window and cohort must produce different evidence
# ---------------------------------------------------------------------------

@requires_db
@requires_data_repo
@requires_synth("synth-simple-abc", enriched=True)
class TestV3TemporalModeEvidence:
    """v3 cohort maturity must produce different evidence when the
    query DSL switches between window() and cohort(). This requires
    the full pipeline to separate temporal modes: candidate construction,
    regime selection, and derivation.

    Uses synth-simple-abc B→C (downstream edge with upstream latency)
    where the distinction matters most."""

    def test_evidence_differs_between_modes(self):
        """evidence_x at an early tau must differ between window and
        cohort for a downstream edge. Window x is flat from tau=0
        (all from-node arrivals present). Cohort x grows from near-zero
        (anchor entrants haven't reached the from-node yet)."""
        graph = _load_synth_graph()
        regimes = _get_current_candidate_regimes(graph)

        dsl = 'from(simple-b).to(simple-c)'

        w_rows = _run_v3(graph, regimes, dsl, 'window(-90d:)')
        c_rows = _run_v3(graph, regimes, dsl, 'cohort(-90d:)')

        assert len(w_rows) > 0, 'v3 window returned no rows'
        assert len(c_rows) > 0, 'v3 cohort returned no rows'

        # Find evidence_x at an early tau where the modes should diverge
        test_tau = 5
        w_ev = next((r for r in w_rows if r['tau_days'] == test_tau), None)
        c_ev = next((r for r in c_rows if r['tau_days'] == test_tau), None)

        assert w_ev is not None, f'No window row at tau={test_tau}'
        assert c_ev is not None, f'No cohort row at tau={test_tau}'

        w_x = w_ev.get('evidence_x')
        c_x = c_ev.get('evidence_x')

        assert w_x is not None and w_x > 0, (
            f'Window evidence_x at tau={test_tau} should be positive, got {w_x}')
        assert c_x is not None and c_x > 0, (
            f'Cohort evidence_x at tau={test_tau} should be positive, got {c_x}')

        # They must differ — same value means modes are mixed
        assert w_x != c_x, (
            f'evidence_x at tau={test_tau} is identical for window ({w_x}) '
            f'and cohort ({c_x}) — temporal modes are not separated')

    # p@infinity convergence coverage moved to
    # `test_cohort_factorised_outside_in.py` where it is asserted as part of
    # the dedicated factorised cohort outside-in contract.
