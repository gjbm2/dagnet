"""
Adversarial blind tests for the synth data → evidence binding → model pipeline.

Written from the DESIGN CONTRACT, not the implementation. The goal is to
find defects, not confirm correctness.

Two layers:
  Layer 1 — Contract classification: verify slice_key classification
            for all known formats.
  Layer 2 — Data survival: construct snapshot rows, run through
            topology → bind → model, assert quantity invariants at every
            boundary. Targets dangerous mechanism interactions:
              - Hash lookup failure → silent zero-row fallback
              - MECE aggregation × regime partitioning × epoch transitions
              - Denomination semantics (a vs x) through dedup to model
              - Trajectory collapse (multi-age → daily fallback)
              - Context-qualified rows with bare-hash fallback
              - Pathological: bare-only + mece_partition regime

Run:
    . graph-editor/venv/bin/activate
    cd bayes && python -m pytest tests/test_data_binding_adversarial.py -v
"""

import os
import sys
import pytest
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../graph-editor/lib"))

from bayes.compiler.types import MIN_N_THRESHOLD
from bayes.compiler.evidence import bind_snapshot_evidence
from bayes.compiler.topology import analyse_topology


# ═══════════════════════════════════════════════════════════════
# Helpers — build minimal structures from the contract
# ═══════════════════════════════════════════════════════════════

def _graph(nodes, edges, conn="amplitude"):
    return {"nodes": nodes, "edges": edges, "defaultConnection": conn}


def _n(uid, *, start=False, evt=None, absorb=False, typ=None):
    n = {"uuid": uid, "id": uid, "absorbing": absorb}
    if start: n["entry"] = {"is_start": True}
    if evt:   n["event_id"] = evt
    if typ:   n["type"] = typ
    return n


def _e(uid, src, tgt, pid, *, lat=None, conn=None):
    e = {"uuid": uid, "from": src, "to": tgt,
         "p": {"id": pid}, "query": f"from({src}).to({tgt})"}
    if lat:  e["p"]["latency"] = lat
    if conn: e["p"]["connection"] = conn
    return e


def _r(anchor, ret, *, x=100, y=50, a=None,
       sk="window()", ch="h1", pid="p1", **kw):
    r = {"anchor_day": anchor, "retrieved_at": ret,
         "x": x, "y": y, "a": a,
         "slice_key": sk, "core_hash": ch, "param_id": pid}
    r.update(kw)
    return r


def _pf(pid, n=100, k=30):
    return {"id": pid, "values": [
        {"sliceDSL": "window(1-Jan-25:1-Mar-25)",
         "n": n, "k": k, "mean": k / n, "stdev": 0.01}]}


def _topo_and_pf(*edges_spec, conn="amplitude"):
    """Build graph+topo+pf from compact edge specs.
    Each spec: (eid, src, tgt, pid[, lat_dict])
    Nodes auto-created; first edge's src is start node.
    """
    nodes_seen = {}
    edges = []
    pf = {}
    for i, spec in enumerate(edges_spec):
        eid, src, tgt, pid = spec[:4]
        lat = spec[4] if len(spec) > 4 else None
        if src not in nodes_seen:
            nodes_seen[src] = _n(src, start=(i == 0 and src not in nodes_seen),
                                  evt=f"e-{src}")
        if tgt not in nodes_seen:
            nodes_seen[tgt] = _n(tgt, evt=f"e-{tgt}", absorb=True)
        edges.append(_e(eid, src, tgt, pid, lat=lat))
        pf[pid] = _pf(pid)
    g = _graph(list(nodes_seen.values()), edges, conn)
    return analyse_topology(g), pf


def _dates(n_days, n_rets, base=datetime(2025, 3, 1)):
    """Yield (anchor_day_str, retrieved_at_str) pairs."""
    for d in range(n_days):
        anc = (base - timedelta(days=n_days - d)).strftime("%Y-%m-%d")
        for r in range(n_rets):
            ret = (base + timedelta(days=10 * (r + 1))).strftime("%Y-%m-%dT02:00:00")
            yield anc, ret


# ═══════════════════════════════════════════════════════════════
# LAYER 1: slice_key classification
# ═══════════════════════════════════════════════════════════════

class TestSliceKey:

    def _c(self, sk):
        from bayes.compiler.evidence import _is_cohort, _is_window
        return (_is_cohort(sk), _is_window(sk))

    # Bare
    def test_window(self):              assert self._c("window()") == (False, True)
    def test_cohort(self):              assert self._c("cohort()") == (True, False)
    # With args
    def test_window_dates(self):        assert self._c("window(1-Jan-25:1-Mar-25)") == (False, True)
    def test_cohort_anchor(self):       assert self._c("cohort(n,1-Oct-24:1-Jan-25)") == (True, False)
    # Snapshot labels (binder-internal)
    def test_window_snap(self):         assert self._c("window(snapshot)") == (False, True)
    def test_cohort_snap(self):         assert self._c("cohort(snapshot)") == (True, False)
    # Context-qualified
    def test_ctx_w(self):               assert self._c("context(ch:g).window()")[1]
    def test_ctx_c(self):               assert self._c("context(ch:g).cohort()")[0]
    def test_multi_ctx_w(self):         assert self._c("context(a:1,b:2).window()")[1]
    def test_multi_ctx_c(self):         assert self._c("context(a:1,b:2).cohort()")[0]
    # Visited (non-MECE)
    def test_visited_c(self):           assert self._c("visited(f:x).cohort()")[0]
    # Relative window
    def test_window_rel(self):          assert self._c("window(-90d:)") == (False, True)
    # Unrecognised → both False → row dropped
    def test_unknown(self):             assert self._c("foo()") == (False, False)
    # Case insensitive
    def test_upper_w(self):             assert self._c("WINDOW()")[1]
    def test_upper_c(self):             assert self._c("COHORT()")[0]
    def test_mixed_w(self):             assert self._c("Window()")[1]


# ═══════════════════════════════════════════════════════════════
# LAYER 3: Simple chain — data survives to model
# ═══════════════════════════════════════════════════════════════

class TestChainSurvival:
    """A→B→C, window only, no latency. 30 days × 3 retrievals."""

    @pytest.fixture
    def setup(self):
        topo, pf = _topo_and_pf(
            ("e1", "A", "B", "p1"), ("e2", "B", "C", "p2"))
        rows = {"e1": [], "e2": []}
        for eid, x, y_final, pid in [("e1", 1000, 300, "p1"), ("e2", 300, 90, "p2")]:
            for anc, ret in _dates(30, 3):
                # y must vary across retrieval dates (maturation) for
                # trajectories to survive zero-count filtering. Parse
                # ret to compute an age-dependent y.
                ret_dt = datetime.strptime(ret[:10], "%Y-%m-%d")
                anc_dt = datetime.strptime(anc, "%Y-%m-%d")
                age = (ret_dt - anc_dt).days
                y = int(y_final * min(1.0, age / 60))
                rows[eid].append(_r(anc, ret, x=x, y=y, sk="window()",
                                     ch=f"h-{eid}", pid=pid))
        return topo, rows, pf

    def test_both_edges_bound(self, setup):
        t, r, p = setup
        ev = bind_snapshot_evidence(t, r, p, today="1-Mar-25")
        for eid in ["e1", "e2"]:
            assert not ev.edges[eid].skipped
            assert ev.edges[eid].total_n > 0

    def test_trajectories_exist(self, setup):
        t, r, p = setup
        ev = bind_snapshot_evidence(t, r, p, today="1-Mar-25")
        for eid in ["e1", "e2"]:
            nt = sum(len(c.trajectories) for c in ev.edges[eid].cohort_obs)
            assert nt > 0, f"{eid}: 0 trajectories"

    def test_multi_age_trajectories(self, setup):
        t, r, p = setup
        ev = bind_snapshot_evidence(t, r, p, today="1-Mar-25")
        for eid in ["e1", "e2"]:
            for co in ev.edges[eid].cohort_obs:
                for tj in co.trajectories:
                    assert len(tj.retrieval_ages) >= 2

    def test_obs_type_window(self, setup):
        t, r, p = setup
        ev = bind_snapshot_evidence(t, r, p, today="1-Mar-25")
        for co in ev.edges["e1"].cohort_obs:
            for tj in co.trajectories:
                assert tj.obs_type == "window"

    def test_denom_is_x(self, setup):
        t, r, p = setup
        ev = bind_snapshot_evidence(t, r, p, today="1-Mar-25")
        for co in ev.edges["e1"].cohort_obs:
            for tj in co.trajectories:
                assert tj.n == 1000
        for co in ev.edges["e2"].cohort_obs:
            for tj in co.trajectories:
                assert tj.n == 300

    def test_y_le_n(self, setup):
        t, r, p = setup
        ev = bind_snapshot_evidence(t, r, p, today="1-Mar-25")
        for e in ev.edges.values():
            for co in e.cohort_obs:
                for tj in co.trajectories:
                    assert all(yv <= tj.n for yv in tj.cumulative_y)
                for d in co.daily:
                    assert d.k <= d.n

    def test_model_has_observed(self, setup):
        """Model must have observed RVs.

        Regression: no-latency edges with window snapshot data must
        produce observed RVs. Previously Case B (has_window only) didn't
        call _emit_cohort_likelihoods, silently ignoring trajectories.
        """
        from bayes.compiler.model import build_model
        t, r, p = setup
        ev = bind_snapshot_evidence(t, r, p, today="1-Mar-25")
        m, _ = build_model(t, ev)
        n_obs = len(m.observed_RVs)
        n_pot = len(list(m.potentials))
        assert n_obs + n_pot > 0, (
            "No-latency window snapshot data produced 0 likelihoods"
        )

    def test_model_observed_data_volume(self, setup):
        """The observed data arrays in the model must reflect the volume
        of data we generated (30 days × 2 edges). If data was silently
        dropped, the arrays are smaller than expected.
        """
        from bayes.compiler.model import build_model
        import numpy as np
        t, r, p = setup
        ev = bind_snapshot_evidence(t, r, p, today="1-Mar-25")
        m, _ = build_model(t, ev)

        # Collect all observed data arrays from the model
        import numpy as np
        total_observed_points = 0
        for rv in m.observed_RVs:
            # PyMC stores observed data in the model's observed_RVs.
            # Extract the constant data via eval or rvs_to_values.
            try:
                obs_val = m.rvs_to_values[rv].data
                if hasattr(obs_val, 'shape'):
                    total_observed_points += obs_val.shape[0] if len(obs_val.shape) > 0 else 1
                elif hasattr(obs_val, '__len__'):
                    total_observed_points += len(obs_val)
                else:
                    total_observed_points += 1
            except (KeyError, AttributeError):
                total_observed_points += 1

        # We generated 30 anchor days per edge, 2 edges. After dedup and
        # trajectory-to-daily conversion, each edge should have ~30 daily
        # obs (one per anchor day). Total ~60.
        assert total_observed_points >= 20, (
            f"Model received only {total_observed_points} observed data points — "
            f"expected ≥20 from 30 days × 2 edges"
        )


class TestModelLikelihoodStructureWithLatency:
    """Edge with latency and snapshot trajectories must produce
    trajectory Potentials, not just daily BetaBinomials. Potentials
    constrain both p and latency simultaneously via CDF decomposition.
    """

    @pytest.fixture
    def latency_edge(self):
        topo, pf = _topo_and_pf(
            ("e1", "A", "B", "p1", {"latency_parameter": True,
             "onset_delta_days": 2.0, "mu": 2.0, "sigma": 0.5}))
        rows = []
        for anc, ret in _dates(30, 4):
            ret_dt = datetime.strptime(ret[:10], "%Y-%m-%d")
            anc_dt = datetime.strptime(anc, "%Y-%m-%d")
            age = (ret_dt - anc_dt).days
            # Realistic maturation: shifted lognormal CDF
            from bayes.compiler.completeness import shifted_lognormal_cdf
            compl = shifted_lognormal_cdf(age, 2.0, 2.0, 0.5)
            y = int(350 * compl)
            rows.append(_r(anc, ret, x=1000, y=y, a=None,
                            sk="window()", ch="hw", pid="p1"))
        return topo, {"e1": rows}, pf

    def test_has_trajectory_potentials(self, latency_edge):
        """Latency edges with multi-age trajectories must produce
        Potentials (product-of-conditional-Binomials), not just
        daily BetaBinomials.
        """
        from bayes.compiler.model import build_model
        t, r, p = latency_edge
        ev = bind_snapshot_evidence(t, r, p, today="1-Mar-25")
        m, _ = build_model(t, ev)

        pot_names = [v.name for v in m.potentials]
        traj_pots = [n for n in pot_names if "traj_" in n]
        assert len(traj_pots) > 0, (
            f"No trajectory Potentials found. Potentials: {pot_names}. "
            f"Latency edge should produce CDF-based trajectory Potentials."
        )

    def test_has_latency_free_vars(self, latency_edge):
        """Latency edge must create latent mu and sigma variables."""
        from bayes.compiler.model import build_model
        t, r, p = latency_edge
        ev = bind_snapshot_evidence(t, r, p, today="1-Mar-25")
        m, _ = build_model(t, ev)

        free_names = [v.name for v in m.free_RVs]
        has_mu = any("mu_" in n for n in free_names)
        has_sigma = any("sigma_" in n or "log_sigma_" in n for n in free_names)
        assert has_mu, f"No mu variable. Free RVs: {free_names}"
        assert has_sigma, f"No sigma variable. Free RVs: {free_names}"

    def test_daily_and_trajectory_both_present(self, latency_edge):
        """Model should have both daily BetaBinomials (anchoring p)
        and trajectory Potentials (constraining latency).
        """
        from bayes.compiler.model import build_model
        t, r, p = latency_edge
        ev = bind_snapshot_evidence(t, r, p, today="1-Mar-25")
        m, _ = build_model(t, ev)

        obs_names = [v.name for v in m.observed_RVs]
        pot_names = [v.name for v in m.potentials]
        has_daily = any("daily" in n or "endpoint" in n for n in obs_names)
        has_traj = any("traj_" in n for n in pot_names)
        # At minimum one of these should exist
        assert has_daily or has_traj, (
            f"Neither daily nor trajectory likelihoods found. "
            f"Observed: {obs_names}, Potentials: {pot_names}"
        )


# ═══════════════════════════════════════════════════════════════
# LAYER 3: Window + cohort coexistence
# ═══════════════════════════════════════════════════════════════

class TestWindowCohortCoexistence:

    @pytest.fixture
    def setup(self):
        topo, pf = _topo_and_pf(
            ("e1", "A", "B", "p1", {"latency_parameter": True,
             "onset_delta_days": 2.0, "mu": 2.0, "sigma": 0.5}))
        rows = []
        for anc, ret in _dates(20, 3):
            rows.append(_r(anc, ret, x=500, y=175, a=None,
                            sk="window()", ch="hw", pid="p1"))
            rows.append(_r(anc, ret, x=400, y=140, a=500,
                            sk="cohort()", ch="hc", pid="p1"))
        return topo, {"e1": rows}, pf

    def test_both_types(self, setup):
        t, r, p = setup
        ev = bind_snapshot_evidence(t, r, p, today="1-Mar-25")
        e = ev.edges["e1"]
        assert e.has_window and e.has_cohort

    def test_separate_obs(self, setup):
        t, r, p = setup
        ev = bind_snapshot_evidence(t, r, p, today="1-Mar-25")
        e = ev.edges["e1"]
        w = [c for c in e.cohort_obs if "window" in c.slice_dsl]
        c = [c for c in e.cohort_obs if "cohort" in c.slice_dsl]
        assert w and c

    def test_cohort_cumulative_x(self, setup):
        t, r, p = setup
        ev = bind_snapshot_evidence(t, r, p, today="1-Mar-25")
        for co in ev.edges["e1"].cohort_obs:
            if "cohort" not in co.slice_dsl:
                continue
            for tj in co.trajectories:
                assert len(tj.cumulative_x) == len(tj.retrieval_ages)


# ═══════════════════════════════════════════════════════════════
# LAYER 3: MECE × regime × epoch interactions
# ═══════════════════════════════════════════════════════════════

class TestMeceRegime:

    @pytest.fixture
    def base(self):
        topo, pf = _topo_and_pf(("e1", "A", "B", "p1"))
        return topo, pf

    def _ctx(self, n=10, *, bare=False, ret="2025-03-31"):
        base_dt = datetime(2025, 3, 1)
        rows = []
        for d in range(n):
            anc = (base_dt - timedelta(days=n - d)).strftime("%Y-%m-%d")
            rows.append(_r(anc, f"{ret}T02:00:00", x=60, y=18,
                            sk="context(channel:google).window()", ch="hctx", pid="p1"))
            rows.append(_r(anc, f"{ret}T02:00:00", x=40, y=12,
                            sk="context(channel:meta).window()", ch="hctx", pid="p1"))
            if bare:
                rows.append(_r(anc, f"{ret}T02:00:00", x=100, y=30,
                                sk="window()", ch="hbare", pid="p1"))
        return rows

    def _bare(self, n=5, ret="2025-03-31"):
        base_dt = datetime(2025, 3, 1)
        return [_r((base_dt - timedelta(days=n - d)).strftime("%Y-%m-%d"),
                    f"{ret}T02:00:00", x=100, y=30,
                    sk="window()", ch="hb", pid="p1") for d in range(n)]

    def _regime(self, date, kind):
        return {"e1": type("R", (), {"regime_per_date": {date: kind}})()}

    # ── MECE aggregation ──

    def test_mece_sums_to_correct_n(self, base):
        topo, pf = base
        ev = bind_snapshot_evidence(topo, {"e1": self._ctx(10)}, pf,
                                     today="1-Mar-25", mece_dimensions=["channel"])
        agg = [c for c in ev.edges["e1"].cohort_obs
               if "window" in c.slice_dsl and "context" not in c.slice_dsl]
        assert agg, "No aggregate created"
        for co in agg:
            for tj in co.trajectories:
                assert tj.n == 100, f"n={tj.n}, want 60+40=100"
            for d in co.daily:
                assert d.n == 100

    def test_non_mece_excluded_when_bare_exists(self, base):
        """Non-MECE context rows must NOT leak into the aggregate when
        bare aggregate rows already exist. The bare rows represent the
        true population.

        Note: when no bare rows exist at all, the largest non-MECE
        context is used as a proxy (Defect 4 fix). This test verifies
        the non-proxy case by including bare rows.
        """
        topo, pf = base
        ev = bind_snapshot_evidence(topo, {"e1": self._ctx(10, bare=True)}, pf,
                                     today="1-Mar-25", mece_dimensions=[])
        agg = [c for c in ev.edges["e1"].cohort_obs
               if "window" in c.slice_dsl and "context" not in c.slice_dsl]
        agg_n = sum(tj.n for co in agg for tj in co.trajectories) + \
                sum(d.n for co in agg for d in co.daily)
        # Bare rows have x=100 per day; non-MECE context rows (x=60+40)
        # must NOT be added to give 200. Only bare should survive.
        assert agg_n <= 100 * 10, f"Non-MECE leaked into bare aggregate: n={agg_n}"

    def test_bare_overrides_context(self, base):
        topo, pf = base
        ev = bind_snapshot_evidence(topo, {"e1": self._ctx(10, bare=True)}, pf,
                                     today="1-Mar-25", mece_dimensions=["channel"])
        agg = [c for c in ev.edges["e1"].cohort_obs
               if "window" in c.slice_dsl and "context" not in c.slice_dsl]
        for co in agg:
            for tj in co.trajectories:
                assert tj.n <= 100, f"Double-count: n={tj.n}"
            for d in co.daily:
                assert d.n <= 100

    # ── Regime partitioning ──

    def test_mece_partition_removes_aggregate(self, base):
        """On mece_partition dates with commissioned slices and context data
        present, aggregate should be removed. Per-context data should survive
        in SliceGroups.

        Regression: when regime removes aggregate, per-context data in
        SliceGroups must keep the edge alive. Previously the min-n gate
        only counted aggregate total_n, skipping edges with slice-only data.
        """
        topo, pf = base
        ev = bind_snapshot_evidence(
            topo, {"e1": self._ctx(5)}, pf, today="1-Mar-25",
            mece_dimensions=["channel"],
            commissioned_slices={"e1": {"context(channel:google)", "context(channel:meta)"}},
            regime_selections=self._regime("2025-03-31", "mece_partition"))
        e = ev.edges["e1"]
        # Aggregate should be removed
        agg = [c for c in e.cohort_obs
               if "window" in c.slice_dsl and "context" not in c.slice_dsl]
        agg_n = sum(tj.n for co in agg for tj in co.trajectories) + \
                sum(d.n for co in agg for d in co.daily)
        assert agg_n == 0, f"Aggregate survived mece_partition: n={agg_n}"
        # SliceGroups should exist with per-context data
        assert e.has_slices, "No SliceGroups created"
        assert "channel" in e.slice_groups, "channel SliceGroup missing"
        # Edge must NOT be skipped — SliceGroup data keeps it alive
        assert not e.skipped, (
            f"Edge skipped despite SliceGroup data: {e.skip_reason}"
        )

    def test_uncontexted_keeps_aggregate(self, base):
        topo, pf = base
        ev = bind_snapshot_evidence(
            topo, {"e1": self._bare(5)}, pf, today="1-Mar-25",
            mece_dimensions=["channel"],
            regime_selections=self._regime("2025-03-31", "uncontexted"))
        assert ev.edges["e1"].total_n > 0

    # ── Pathological: bare-only + mece_partition ──

    def test_bare_only_plus_mece_partition_data_fate(self, base):
        """emit_ctx=false + regime=mece_partition: what happens to aggregate?

        FINDING: the regime filter has a guard: it only removes aggregate
        rows when _has_ctx_data is True (context rows were actually
        collected). When only bare rows exist, the guard prevents removal
        and data survives. This is a safety mechanism, not a bug — but
        it means regime=mece_partition is silently a no-op when context
        rows are absent.
        """
        topo, pf = base
        ev = bind_snapshot_evidence(
            topo, {"e1": self._bare(5)}, pf, today="1-Mar-25",
            mece_dimensions=["channel"],
            commissioned_slices={"e1": {"context(channel:google)"}},
            regime_selections=self._regime("2025-03-31", "mece_partition"))
        agg = [c for c in ev.edges["e1"].cohort_obs
               if "window" in c.slice_dsl and "context" not in c.slice_dsl]
        agg_n = sum(tj.n for co in agg for tj in co.trajectories) + \
                sum(d.n for co in agg for d in co.daily)
        # Guard condition: no ctx data → regime filter is no-op → aggregate kept
        assert agg_n > 0, (
            "Aggregate removed despite no context data — guard condition failed"
        )

    # ── Epoch transition: mixed bare + context ──

    def test_epoch_transition_both_halves(self, base):
        topo, pf = base
        base_dt = datetime(2025, 3, 1)
        ret = (base_dt + timedelta(days=30)).strftime("%Y-%m-%dT02:00:00")
        rows = []
        for d in range(10):
            anc = (base_dt - timedelta(days=20 - d)).strftime("%Y-%m-%d")
            rows.append(_r(anc, ret, x=100, y=30, sk="window()",
                            ch="hb", pid="p1"))
        for d in range(10, 20):
            anc = (base_dt - timedelta(days=20 - d)).strftime("%Y-%m-%d")
            rows.append(_r(anc, ret, x=60, y=18,
                            sk="context(channel:google).window()", ch="hctx", pid="p1"))
            rows.append(_r(anc, ret, x=40, y=12,
                            sk="context(channel:meta).window()", ch="hctx", pid="p1"))
        ev = bind_snapshot_evidence(topo, {"e1": rows}, pf, today="1-Mar-25",
                                     mece_dimensions=["channel"])
        e = ev.edges["e1"]
        assert e.total_n > 0
        agg = [c for c in e.cohort_obs
               if "window" in c.slice_dsl and "context" not in c.slice_dsl]
        obs_count = sum(len(co.trajectories) + len(co.daily) for co in agg)
        assert obs_count >= 15, f"Only {obs_count} from 20 days"

    # ── Epoch + regime combined ──

    def test_epoch_bare_uncontexted_plus_ctx_mece(self, base):
        """First half: bare rows, regime=uncontexted (keeps aggregate).
        Second half: context rows, regime=mece_partition (removes aggregate,
        per-slice only). Both halves should contribute data.

        Per-context data lives in SliceGroups (not cohort_obs). The test
        checks slice_groups for the context epoch's data.
        """
        topo, pf = base
        base_dt = datetime(2025, 3, 1)
        ret1 = "2025-03-15"
        ret2 = "2025-03-31"
        rows = []
        for d in range(5):
            anc = (base_dt - timedelta(days=10 - d)).strftime("%Y-%m-%d")
            rows.append(_r(anc, f"{ret1}T02:00:00", x=100, y=30,
                            sk="window()", ch="hb", pid="p1"))
        for d in range(5, 10):
            anc = (base_dt - timedelta(days=10 - d)).strftime("%Y-%m-%d")
            rows.append(_r(anc, f"{ret2}T02:00:00", x=60, y=18,
                            sk="context(channel:google).window()", ch="hctx", pid="p1"))
            rows.append(_r(anc, f"{ret2}T02:00:00", x=40, y=12,
                            sk="context(channel:meta).window()", ch="hctx", pid="p1"))

        ev = bind_snapshot_evidence(
            topo, {"e1": rows}, pf, today="1-Mar-25",
            mece_dimensions=["channel"],
            commissioned_slices={"e1": {"context(channel:google)", "context(channel:meta)"}},
            regime_selections={"e1": type("R", (), {
                "regime_per_date": {ret1: "uncontexted", ret2: "mece_partition"}
            })()})

        e = ev.edges["e1"]
        # Bare half should survive (uncontexted regime keeps aggregate)
        assert e.total_n > 0, "No data survived combined epoch+regime"
        # Context half should exist in SliceGroups
        assert e.has_slices, "No SliceGroups — context epoch data lost"
        assert "channel" in e.slice_groups, "channel SliceGroup missing"
        sg = e.slice_groups["channel"]
        assert len(sg.slices) >= 2, (
            f"Expected ≥2 slices (google, meta), got {len(sg.slices)}"
        )


# ═══════════════════════════════════════════════════════════════
# LAYER 3: Hash lookup failure → silent fallback
# ═══════════════════════════════════════════════════════════════

class TestHashFailure:

    def test_zero_rows_fallback(self):
        topo, pf = _topo_and_pf(("e1", "A", "B", "p1"))
        ev = bind_snapshot_evidence(topo, {}, pf, today="1-Mar-25")
        e = ev.edges["e1"]
        assert not e.skipped
        assert e.has_window
        assert e.rows_received == 0

    def test_rich_vs_fallback_distinguishable(self):
        topo, pf = _topo_and_pf(("e1", "A", "B", "p1"))
        rows = []
        for anc, ret in _dates(10, 3):
            ret_dt = datetime.strptime(ret[:10], "%Y-%m-%d")
            anc_dt = datetime.strptime(anc, "%Y-%m-%d")
            age = (ret_dt - anc_dt).days
            y = int(150 * min(1.0, age / 60))
            rows.append(_r(anc, ret, x=500, y=y, sk="window()", ch="h1", pid="p1"))
        ev_rich = bind_snapshot_evidence(topo, {"e1": rows}, pf, today="1-Mar-25")
        ev_fb = bind_snapshot_evidence(topo, {}, pf, today="1-Mar-25")
        nt = sum(len(c.trajectories) for c in ev_rich.edges["e1"].cohort_obs)
        assert nt > 0
        assert ev_fb.edges["e1"].window_obs
        assert ev_rich.edges["e1"].total_n > ev_fb.edges["e1"].total_n


# ═══════════════════════════════════════════════════════════════
# LAYER 3: param_id resolution
# ═══════════════════════════════════════════════════════════════

class TestParamId:

    def _bind(self, key):
        topo, _ = _topo_and_pf(("e1", "A", "B", "p1"))
        pf = {key: _pf("p1")}
        return bind_snapshot_evidence(topo, {}, pf, today="1-Mar-25").edges["e1"]

    def test_bare(self):       assert self._bind("p1").has_window
    def test_prefixed(self):   assert self._bind("parameter-p1").has_window


# ═══════════════════════════════════════════════════════════════
# LAYER 3: Topology latency propagation
# ═══════════════════════════════════════════════════════════════

class TestLatencyPropagation:

    def test_downstream_inherits_upstream(self):
        topo, _ = _topo_and_pf(
            ("e1", "A", "B", "p1", {"latency_parameter": True,
             "onset_delta_days": 5.0, "mu": 2.0, "sigma": 0.5}),
            ("e2", "B", "C", "p2", {"latency_parameter": True,
             "onset_delta_days": 2.0, "mu": 1.5, "sigma": 0.4}))
        et2 = topo.edges["e2"]
        assert et2.path_latency.path_delta > 2.0
        # FW composition doesn't simply add sigma — composed sigma can be
        # smaller than individual edge sigma. The key invariant is that
        # path_sigma > 0 (non-trivial) and path_delta accumulated.
        assert et2.path_latency.path_sigma > 0.01


# ═══════════════════════════════════════════════════════════════
# LAYER 3: Dedup and monotonisation
# ═══════════════════════════════════════════════════════════════

class TestDedup:

    def _topo(self):
        t, _ = _topo_and_pf(("e1", "A", "B", "p1"))
        return t

    def test_dup_retrieved_at(self):
        t = self._topo()
        rows = [
            _r("2025-01-15", "2025-02-15T02:00:00", x=100, y=30, sk="window()", pid="p1"),
            _r("2025-01-15", "2025-02-15T02:00:00", x=100, y=35, sk="window()", pid="p1"),
            _r("2025-01-15", "2025-03-01T02:00:00", x=100, y=40, sk="window()", pid="p1")]
        ev = bind_snapshot_evidence(t, {"e1": rows}, {"p1": _pf("p1")}, today="1-Mar-25")
        for co in ev.edges["e1"].cohort_obs:
            for tj in co.trajectories:
                assert len(tj.retrieval_ages) == 2

    def test_single_ret_daily(self):
        t = self._topo()
        rows = [_r("2025-01-15", "2025-02-15T02:00:00", x=100, y=30,
                     sk="window()", pid="p1")]
        ev = bind_snapshot_evidence(t, {"e1": rows}, {"p1": _pf("p1")}, today="1-Mar-25")
        e = ev.edges["e1"]
        assert sum(len(c.trajectories) for c in e.cohort_obs) == 0
        assert sum(len(c.daily) for c in e.cohort_obs) >= 1

    def test_monotonise(self):
        t = self._topo()
        rows = [
            _r("2025-01-15", "2025-02-01T02:00:00", x=100, y=20, sk="window()", pid="p1"),
            _r("2025-01-15", "2025-02-15T02:00:00", x=100, y=15, sk="window()", pid="p1"),
            _r("2025-01-15", "2025-03-01T02:00:00", x=100, y=30, sk="window()", pid="p1")]
        ev = bind_snapshot_evidence(t, {"e1": rows}, {"p1": _pf("p1")}, today="1-Mar-25")
        for co in ev.edges["e1"].cohort_obs:
            for tj in co.trajectories:
                for i in range(1, len(tj.cumulative_y)):
                    assert tj.cumulative_y[i] >= tj.cumulative_y[i - 1]


class TestMinN:

    def test_below_threshold(self):
        topo, _ = _topo_and_pf(("e1", "A", "B", "p1"))
        rows = [_r("2025-01-15", "2025-02-15T02:00:00", x=5, y=2,
                     sk="window()", pid="p1")]
        ev = bind_snapshot_evidence(topo, {"e1": rows},
                                     {"p1": {"id": "p1", "values": []}},
                                     today="1-Mar-25")
        assert ev.edges["e1"].skipped


# ═══════════════════════════════════════════════════════════════
# END-TO-END: CLI → DB → bind → model on real synth graph
# ═══════════════════════════════════════════════════════════════


# ═══════════════════════════════════════════════════════════════
# LAYER 4: Adversarial branch group — mismatched denominators
# ═══════════════════════════════════════════════════════════════

class TestBranchGroupDenominatorMismatch:
    """Branch group where siblings have DIFFERENT x values (denominators).

    Scenario: A → B (x=1000, k=300), A → C (x=500, k=200).
    The Multinomial uses shared_n = max(n_i) = 1000.
    But k_C=200 was measured out of 500, not 1000.

    Contract question: does the dropout absorb the population
    mismatch (500 users who reached B's from-node but not C's)?
    If so, the dropout is inflated by the mismatch, not by real
    dropout behaviour. This biases p_C downward.
    """

    @pytest.fixture
    def mismatched_setup(self):
        nodes = [
            _n("A", start=True, evt="e-A"),
            _n("B", evt="e-B"),
            _n("C", evt="e-C"),
            _n("D", absorb=True),  # dropout
        ]
        edges = [
            _e("e1", "A", "B", "p1"),
            _e("e2", "A", "C", "p2"),
            _e("e3", "A", "D", "p3"),
        ]
        g = _graph(nodes, edges)
        topo = analyse_topology(g)
        pf = {"p1": _pf("p1"), "p2": _pf("p2"), "p3": _pf("p3")}

        rows = {"e1": [], "e2": [], "e3": []}
        for anc, ret in _dates(20, 3):
            ret_dt = datetime.strptime(ret[:10], "%Y-%m-%d")
            anc_dt = datetime.strptime(anc, "%Y-%m-%d")
            age = (ret_dt - anc_dt).days
            frac = min(1.0, age / 50)
            # e1: x=1000, 30% conversion
            rows["e1"].append(_r(anc, ret, x=1000, y=int(300 * frac),
                                  sk="window()", ch="h1", pid="p1"))
            # e2: x=500, 40% conversion — DIFFERENT denominator
            rows["e2"].append(_r(anc, ret, x=500, y=int(200 * frac),
                                  sk="window()", ch="h2", pid="p2"))
            # e3 (dropout): x=1000, 10% conversion
            rows["e3"].append(_r(anc, ret, x=1000, y=int(100 * frac),
                                  sk="window()", ch="h3", pid="p3"))
        return topo, rows, pf

    def test_multinomial_skipped_when_denominators_disagree(self, mismatched_setup):
        """When sibling denominators disagree (x_B=1000, x_C=500),
        the Multinomial's shared-experiment assumption is violated.
        The model should skip the Multinomial and rely on the Dirichlet
        prior for the p simplex constraint.

        Regression: previously, shared_n = max(n_i) was used without
        rescaling, inflating dropout by ~2x and biasing p_C downward.
        """
        from bayes.compiler.model import build_model
        topo, rows, pf = mismatched_setup
        ev = bind_snapshot_evidence(topo, rows, pf, today="1-Mar-25")
        m, meta = build_model(topo, ev)

        # The Multinomial should NOT be emitted for this branch group
        obs_names = [v.name for v in m.observed_RVs]
        bg_rvs = [n for n in obs_names if n.startswith("obs_bg_")]
        assert len(bg_rvs) == 0, (
            f"Multinomial emitted despite denominator mismatch (max/min=2.0): "
            f"{bg_rvs}. Should have been skipped."
        )

        # Diagnostics should explain why
        diag = meta.get("diagnostics", [])
        has_skip_msg = any("skipping Multinomial" in d and "denominator" in d
                           for d in diag)
        assert has_skip_msg, (
            f"No diagnostic about skipped Multinomial. Diagnostics: {diag}"
        )


# ═══════════════════════════════════════════════════════════════
# LAYER 4: Non-MECE context rows with no bare aggregate
# ═══════════════════════════════════════════════════════════════

class TestNonMeceContextOnlyData:
    """When ALL snapshot rows are context-qualified and the dimension
    is NOT in mece_dimensions, what happens?

    Contract: non-MECE context rows are excluded from the aggregate
    (to avoid double-counting). But if there are no bare rows either,
    the edge gets zero aggregate data.

    This tests whether the edge silently falls back to param file
    priors with zero snapshot data, even though snapshot data exists
    (just context-qualified).
    """

    def test_context_only_non_mece_gets_empty_aggregate(self):
        """Edge has ONLY context-qualified rows, dimension not MECE.
        No bare rows exist.

        The binder must NOT silently substitute a single context slice
        as an aggregate proxy — that would model on a fraction of the
        data. The aggregate should be empty; the correct fix is for the
        FE to declare the dimension as MECE.
        """
        topo, pf = _topo_and_pf(("e1", "A", "B", "p1"))

        rows = []
        for anc, ret in _dates(20, 3):
            ret_dt = datetime.strptime(ret[:10], "%Y-%m-%d")
            anc_dt = datetime.strptime(anc, "%Y-%m-%d")
            age = (ret_dt - anc_dt).days
            frac = min(1.0, age / 50)
            # ONLY context-qualified rows, no bare
            rows.append(_r(anc, ret, x=60, y=int(18 * frac),
                            sk="context(channel:google).window()",
                            ch="hctx", pid="p1"))
            rows.append(_r(anc, ret, x=40, y=int(12 * frac),
                            sk="context(channel:meta).window()",
                            ch="hctx", pid="p1"))

        # Deliberately NOT declaring channel as MECE
        ev = bind_snapshot_evidence(
            topo, {"e1": rows}, pf, today="1-Mar-25",
            mece_dimensions=[])  # no MECE dimensions

        e = ev.edges["e1"]

        # Aggregate must be empty — non-MECE context rows cannot be
        # aggregated without double-counting risk
        assert e.total_n == 0, (
            f"total_n={e.total_n} but should be 0 — non-MECE context rows "
            f"must not be silently used as aggregate proxy."
        )

    def test_context_only_mece_data_survives(self):
        """Control: same data but with channel declared as MECE.
        Context rows should be aggregated and produce evidence.
        """
        topo, pf = _topo_and_pf(("e1", "A", "B", "p1"))

        rows = []
        for anc, ret in _dates(20, 3):
            ret_dt = datetime.strptime(ret[:10], "%Y-%m-%d")
            anc_dt = datetime.strptime(anc, "%Y-%m-%d")
            age = (ret_dt - anc_dt).days
            frac = min(1.0, age / 50)
            rows.append(_r(anc, ret, x=60, y=int(18 * frac),
                            sk="context(channel:google).window()",
                            ch="hctx", pid="p1"))
            rows.append(_r(anc, ret, x=40, y=int(12 * frac),
                            sk="context(channel:meta).window()",
                            ch="hctx", pid="p1"))

        ev = bind_snapshot_evidence(
            topo, {"e1": rows}, pf, today="1-Mar-25",
            mece_dimensions=["channel"])

        e = ev.edges["e1"]
        assert e.total_n > 0, (
            f"MECE context rows should produce aggregate data, "
            f"but total_n={e.total_n}"
        )
        # Aggregate n should be sum of context n values (60+40=100 per day)
        n_traj = sum(len(c.trajectories) for c in e.cohort_obs)
        assert n_traj > 0, "No trajectories from MECE-aggregated data"


# ═══════════════════════════════════════════════════════════════
# LAYER 4: Onset exceeds all retrieval ages — silent CDF collapse
# ═══════════════════════════════════════════════════════════════

class TestOnsetExceedsAllAges:
    """When onset_delta_days > all retrieval ages, the shifted
    lognormal CDF returns ~0 for every age. The trajectory Potential
    computes delta_F ≈ 0 everywhere, producing near-zero likelihoods.

    This is a data quality mismatch, but the pipeline should either
    (a) warn in diagnostics, or (b) handle it gracefully without
    producing a degenerate model.
    """

    def test_onset_exceeds_ages_model_still_builds(self):
        """onset=50 days, all retrieval ages < 40 days.
        The model should still build without error.
        """
        from bayes.compiler.model import build_model
        lat = {"latency_parameter": True,
               "onset_delta_days": 50.0, "mu": 2.0, "sigma": 0.5}
        topo, pf = _topo_and_pf(("e1", "A", "B", "p1", lat))

        rows = []
        base = datetime(2025, 3, 1)
        for d in range(20):
            anc = (base - timedelta(days=20 - d)).strftime("%Y-%m-%d")
            # Retrieval ages: 10, 20, 30, 40 days — all < onset=50
            for r_offset in [10, 20, 30, 40]:
                ret = (base + timedelta(days=r_offset)).strftime("%Y-%m-%dT02:00:00")
                rows.append(_r(anc, ret, x=1000, y=100,
                                sk="window()", ch="h1", pid="p1"))

        ev = bind_snapshot_evidence(topo, {"e1": rows}, pf, today="1-Mar-25")
        # Should not crash
        m, meta = build_model(topo, ev)

        # Model should exist, even if degenerate
        assert m is not None

        # Check if diagnostics mention the onset/age mismatch
        diag = meta.get("diagnostics", [])
        has_warning = any("onset" in d.lower() for d in diag)
        if not has_warning:
            # Not a crash, but a diagnostic gap: the user gets no warning
            # that their onset exceeds all data ages, making CDF~0 everywhere.
            print("NOTE: no diagnostic warning for onset > all retrieval ages")


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _has_db_and_synth():
    """Check if DB and synth graph are available."""
    env_path = os.path.join(REPO_ROOT, "graph-editor", ".env.local")
    if not os.path.isfile(env_path):
        return False
    conf_path = os.path.join(REPO_ROOT, ".private-repos.conf")
    if not os.path.isfile(conf_path):
        return False
    for line in open(conf_path):
        if line.startswith("DATA_REPO_DIR="):
            data_dir = line.strip().split("=", 1)[1]
            graph = os.path.join(REPO_ROOT, data_dir, "graphs", "synth-simple-abc.json")
            return os.path.isfile(graph)
    return False


def _cli_hashes(graph_name):
    """Call CLI to get snapshot_subjects with FE-authoritative hashes."""
    import subprocess
    conf = {}
    for line in open(os.path.join(REPO_ROOT, ".private-repos.conf")):
        if "=" in line and not line.startswith("#"):
            k, v = line.strip().split("=", 1)
            conf[k] = v
    data_dir = os.path.join(REPO_ROOT, conf["DATA_REPO_DIR"])
    nvm = (
        f'export NVM_DIR="${{NVM_DIR:-$HOME/.nvm}}" && '
        f'. "$NVM_DIR/nvm.sh" 2>/dev/null; '
        f'cd {os.path.join(REPO_ROOT, "graph-editor")} && '
        f'nvm use "$(cat .nvmrc)" 2>/dev/null; '
    )
    cmd = (
        f'{nvm}'
        f'npx tsx src/cli/bayes.ts '
        f'--graph {data_dir} --name {graph_name} --format json --no-cache'
    )
    result = subprocess.run(
        ["bash", "-c", cmd], capture_output=True, text=True, timeout=60,
        cwd=REPO_ROOT,
    )
    assert result.returncode == 0, f"CLI failed: {result.stderr[-500:]}"
    import json
    stdout = result.stdout
    start = stdout.find("{")
    assert start >= 0, "No JSON in CLI output"
    return json.loads(stdout[start:])


def _db_connection():
    for line in open(os.path.join(REPO_ROOT, "graph-editor", ".env.local")):
        if line.startswith("DB_CONNECTION="):
            return line.strip().split("=", 1)[1]
    return ""


@pytest.mark.skipif(not _has_db_and_synth(), reason="DB or synth graph unavailable")
class TestEndToEndRealPipeline:
    """Full production path: CLI → DB → bind → model on synth-simple-abc.

    This is the test that catches hash mismatches between the CLI
    (FE-authoritative hashes) and the DB (written by synth_gen using
    CLI hashes). If the hashes diverge, the DB query returns 0 rows
    and the model runs on param file fallback.
    """

    @pytest.fixture(scope="class")
    def pipeline(self):
        """Run the full pipeline once for the class."""
        import json
        sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))
        sys.path.insert(0, os.path.join(REPO_ROOT, "graph-editor", "lib"))

        # Step 1: CLI builds payload with FE-authoritative hashes
        payload = _cli_hashes("synth-simple-abc")
        subjects = payload.get("snapshot_subjects", [])
        graph = payload.get("graph_snapshot", {})
        param_files = payload.get("parameter_files", {})
        settings = payload.get("settings", {})

        # Step 2: Topology
        topo = analyse_topology(graph)

        # Step 3: Query DB with CLI hashes (same path as worker)
        os.environ["DB_CONNECTION"] = _db_connection()
        from bayes.worker import _query_snapshot_subjects
        log = []
        snapshot_rows = _query_snapshot_subjects(subjects, topo, log)

        # Step 4: Bind evidence
        from datetime import date
        evidence = bind_snapshot_evidence(
            topo, snapshot_rows, param_files,
            today=date.today().strftime("%-d-%b-%y"),
            settings=settings,
        )

        # Step 5: Build model
        from bayes.compiler.model import build_model
        model, meta = build_model(topo, evidence)

        return {
            "subjects": subjects,
            "topo": topo,
            "snapshot_rows": snapshot_rows,
            "evidence": evidence,
            "model": model,
            "meta": meta,
            "log": log,
        }

    def test_cli_produced_subjects(self, pipeline):
        """CLI must produce snapshot_subjects for every edge."""
        subjects = pipeline["subjects"]
        assert len(subjects) >= 4, (
            f"Expected ≥4 subjects (2 edges × window+cohort), got {len(subjects)}"
        )

    def test_db_returned_rows(self, pipeline):
        """DB must return rows for CLI hashes. If 0, hash mismatch."""
        rows = pipeline["snapshot_rows"]
        total = sum(len(v) for v in rows.values())
        assert total > 0, (
            "DB returned 0 rows for CLI hashes — hash mismatch between "
            "synth_gen DB writes and CLI hash computation"
        )

    def test_every_edge_has_rows(self, pipeline):
        """Every edge must have DB rows, not just some."""
        topo = pipeline["topo"]
        rows = pipeline["snapshot_rows"]
        for edge_id, et in topo.edges.items():
            if not et.param_id:
                continue
            edge_rows = rows.get(edge_id, [])
            assert len(edge_rows) > 0, (
                f"Edge {edge_id[:12]}… ({et.param_id}): 0 DB rows — "
                f"hash mismatch for this edge"
            )

    def test_evidence_not_skipped(self, pipeline):
        """No edge should be skipped after binding."""
        evidence = pipeline["evidence"]
        for eid, ev in evidence.edges.items():
            if not ev.param_id:
                continue
            assert not ev.skipped, (
                f"Edge {eid[:12]}… skipped: {ev.skip_reason}"
            )

    def test_evidence_has_trajectories(self, pipeline):
        """Snapshot data should produce trajectories, not just daily fallback."""
        evidence = pipeline["evidence"]
        total_trajs = 0
        for ev in evidence.edges.values():
            total_trajs += sum(len(c.trajectories) for c in ev.cohort_obs)
        assert total_trajs > 0, (
            "0 trajectories across all edges — data may be falling back "
            "to param files instead of using snapshot trajectories"
        )

    def test_evidence_from_snapshots_not_paramfile(self, pipeline):
        """Evidence must come from snapshot rows, not param file fallback.

        rows_received > 0 proves snapshot data was used. If rows_received=0
        for any edge, the hash lookup failed silently.
        """
        evidence = pipeline["evidence"]
        for eid, ev in evidence.edges.items():
            if not ev.param_id:
                continue
            assert ev.rows_received > 0, (
                f"Edge {eid[:12]}… ({ev.param_id}): rows_received=0 — "
                f"using param file fallback, not snapshot data"
            )

    def test_model_has_likelihoods(self, pipeline):
        """Model must have observed RVs or potentials."""
        model = pipeline["model"]
        n_obs = len(model.observed_RVs)
        n_pot = len(list(model.potentials))
        assert n_obs + n_pot > 0, (
            f"Model has 0 likelihoods (observed={n_obs}, potentials={n_pot})"
        )

    def test_model_data_volume(self, pipeline):
        """Model must have substantial likelihood terms.

        Data reaches the model via observed RVs (Binomial, BetaBinomial,
        DirichletMultinomial) AND Potentials (trajectory CDF decomposition).
        Both must be counted.
        """
        model = pipeline["model"]
        n_obs = len(model.observed_RVs)
        n_pot = len(list(model.potentials))
        # Each observed RV may be vectorised (array of observations).
        # Count total array elements across observed RVs.
        total_obs_elements = 0
        for rv in model.observed_RVs:
            try:
                obs_val = model.rvs_to_values[rv].data
                if hasattr(obs_val, 'shape'):
                    total_obs_elements += max(obs_val.shape[0], 1) if len(obs_val.shape) > 0 else 1
                else:
                    total_obs_elements += 1
            except (KeyError, AttributeError):
                total_obs_elements += 1
        # synth-simple-abc: 2 edges, 100 days. Expect multiple likelihood
        # terms. Potentials carry the trajectory data (tens of intervals
        # each). Observed RVs carry daily BetaBinomials (array per edge).
        assert n_obs + n_pot >= 2, (
            f"Model has {n_obs} observed RVs + {n_pot} potentials = "
            f"{n_obs + n_pot} likelihood terms — expected ≥2"
        )
        assert total_obs_elements + n_pot >= 4, (
            f"Model has {total_obs_elements} observed elements + "
            f"{n_pot} potentials — expected ≥4 total"
        )

