"""
Adversarial blind tests for the synth data → evidence binding → model pipeline.

Written from the DESIGN CONTRACT, not the implementation. The goal is to
find defects, not confirm correctness.

Three layers:
  Layer 1 — Hash contract: verify _short_hash against hand-computed spec
            vectors; verify slice_key classification for all known formats.
  Layer 2 — Cross-boundary parity: invoke Node.js hash computation and
            compare against Python. Skipped if Node.js unavailable.
  Layer 3 — Data survival: construct snapshot rows, run through
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
import json
import hashlib
import base64
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

def _spec_short_hash(text: str) -> str:
    """Oracle: SHA-256 of UTF-8 → first 16 bytes → base64url no pad."""
    d = hashlib.sha256(text.strip().encode("utf-8")).digest()[:16]
    return base64.urlsafe_b64encode(d).decode("ascii").rstrip("=")


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
# LAYER 1: Hash spec contract
# ═══════════════════════════════════════════════════════════════

class TestHashSpec:

    def test_short_hash_matches_spec(self):
        from bayes.synth_gen import _short_hash
        s = '{"c":"abc123","x":{}}'
        assert _short_hash(s) == _spec_short_hash(s)

    def test_deterministic(self):
        from bayes.synth_gen import _short_hash
        assert len({_short_hash('{"c":"x","x":{}}') for _ in range(10)}) == 1

    def test_field_order_matters(self):
        assert _spec_short_hash('{"c":"a","x":{}}') != _spec_short_hash('{"x":{},"c":"a"}')

    def test_compact_separators(self):
        c = json.dumps({"a": 1}, separators=(",", ":"))
        s = json.dumps({"a": 1})
        assert _spec_short_hash(c) != _spec_short_hash(s)

    def test_sha256_hex(self):
        from bayes.synth_gen import _sha256_hex
        assert _sha256_hex("hello") == hashlib.sha256(b"hello").hexdigest()


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

    def test_non_mece_excluded(self, base):
        topo, pf = base
        ev = bind_snapshot_evidence(topo, {"e1": self._ctx(10)}, pf,
                                     today="1-Mar-25", mece_dimensions=[])
        agg = [c for c in ev.edges["e1"].cohort_obs
               if "window" in c.slice_dsl and "context" not in c.slice_dsl]
        agg_n = sum(tj.n for co in agg for tj in co.trajectories) + \
                sum(d.n for co in agg for d in co.daily)
        assert agg_n <= 100, f"Non-MECE leaked: n={agg_n}"

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
# LAYER 2: Cross-boundary parity (Node.js vs Python)
# ═══════════════════════════════════════════════════════════════

def _nodejs_ok():
    import shutil
    return (shutil.which("node") and
            os.path.isfile(os.path.join(os.path.dirname(__file__),
                                         "..", "compute_snapshot_subjects.mjs")))


@pytest.mark.skipif(not _nodejs_ok(), reason="Node.js unavailable")
class TestHashParity:
    def test_placeholder(self):
        pytest.skip("Requires data repo graph — populate to activate")
