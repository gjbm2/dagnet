#!/usr/bin/env python3
"""
Bayes wiring verification harness — checks every integration boundary.

Usage:
    cd dagnet
    . graph-editor/venv/bin/activate
    python bayes/test_wiring.py                  # full pipeline, fast MCMC (200 draws)
    python bayes/test_wiring.py --no-mcmc        # stop after model build (no sampling)
    python bayes/test_wiring.py --full            # full MCMC (2000 draws, 4 chains)

Runs the compiler pipeline stage by stage, inspecting intermediate state
at each boundary. Reports PASS/FAIL for each wiring assertion. No browser
or webhook needed — pure in-process execution.

Assertion categories:
  [TOPO]  Topology analysis: anchor, edges, branch groups, paths, latency
  [EVID]  Evidence binding: snapshot rows → observations, window/cohort split
  [MODEL] Model building: variables, Potentials, p_window wiring
  [INFER] Inference: convergence, latency posteriors, probability posteriors
  [PATCH] Webhook payload: correct fields, provenance, non-stale values
"""

import sys
import os
import json
import time
import math
import traceback

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "graph-editor", "lib"))
sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))


# ---------------------------------------------------------------------------
# Test infrastructure
# ---------------------------------------------------------------------------

class WiringResults:
    def __init__(self):
        self.checks: list[tuple[str, str, bool, str]] = []  # (category, name, passed, detail)

    def check(self, category: str, name: str, condition: bool, detail: str = ""):
        self.checks.append((category, name, condition, detail))
        status = "PASS" if condition else "FAIL"
        print(f"  [{category:5s}] {status}: {name}" + (f" — {detail}" if detail else ""))

    def summary(self):
        total = len(self.checks)
        passed = sum(1 for _, _, ok, _ in self.checks if ok)
        failed = total - passed
        print(f"\n{'='*60}")
        if failed == 0:
            print(f"ALL {total} CHECKS PASSED")
        else:
            print(f"{failed} FAILED / {total} total")
            for cat, name, ok, detail in self.checks:
                if not ok:
                    print(f"  [{cat:5s}] FAIL: {name}" + (f" — {detail}" if detail else ""))
        print(f"{'='*60}")
        return failed == 0


# ---------------------------------------------------------------------------
# Data loading (shared with test_harness.py)
# ---------------------------------------------------------------------------

def _read_conf():
    conf = {}
    conf_path = os.path.join(REPO_ROOT, ".private-repos.conf")
    if os.path.isfile(conf_path):
        with open(conf_path) as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    conf[k.strip()] = v.strip()
    return conf


def _load_env(path):
    env = {}
    if not os.path.isfile(path):
        return env
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            eq = line.find("=")
            if eq < 0:
                continue
            env[line[:eq]] = line[eq + 1:]
    return env


def load_test_data():
    """Load graph, param files, and build snapshot subjects."""
    import yaml

    conf = _read_conf()
    data_repo = conf.get("DATA_REPO_DIR", "nous-conversion")
    data_repo_path = os.path.join(REPO_ROOT, data_repo)

    env = _load_env(os.path.join(REPO_ROOT, "graph-editor", ".env.local"))
    db_connection = env.get("DB_CONNECTION", "")

    graph_path = os.path.join(data_repo_path, "graphs", "bayes-test-gm-rebuild.json")
    if not os.path.isfile(graph_path):
        print(f"ERROR: Graph not found: {graph_path}")
        sys.exit(1)
    with open(graph_path) as f:
        graph = json.load(f)

    param_files = {}
    params_dir = os.path.join(data_repo_path, "parameters")
    for fname in os.listdir(params_dir):
        if fname.endswith(".yaml") and "index" not in fname:
            with open(os.path.join(params_dir, fname)) as f:
                param_id = fname.replace(".yaml", "")
                param_files[f"parameter-{param_id}"] = yaml.safe_load(f)

    _edges = [
        ("bayes-test-create-to-delegated",      "c64ddc4d-c369-4ae8-a44a-398a63a46ab1", "UaWTiPJp1kTXTlkigKzBAQ", "1npRXxdOjD56XTgKnZKbsw"),
        ("bayes-test-delegated-to-registered",   "7bb83fbf-3ac6-4152-a395-a8b64a12506a", "ES2r-ClxqBl4VQQqYdfYYg", "YSX41CZhnZKsP49i80jjTg"),
        ("bayes-test-landing-to-created",        "b91c2820-7a1d-4498-9082-5967b5027d76", "SXVK13yfsOIpXc4RQSv2GA", "yHCQevqcdyITym82h-uwdQ"),
        ("bayes-test-registered-to-success",     "97b11265-1242-4fa8-a097-359f2384665a", "VTgXES1p_XdQoHMZ7VsEoA", "XiDhZpbnp535eBHiPu614w"),
    ]
    snapshot_subjects = []
    for param_id, edge_id, window_hash, cohort_hash in _edges:
        base = {
            "param_id": param_id,
            "edge_id": edge_id,
            "equivalent_hashes": [],
            "slice_keys": [""],
            "anchor_from": "2025-11-19",
            "anchor_to": "2026-03-19",
            "sweep_from": "2025-11-19",
            "sweep_to": "2026-03-19",
        }
        snapshot_subjects.append({**base, "core_hash": window_hash})
        snapshot_subjects.append({**base, "core_hash": cohort_hash})

    return graph, param_files, snapshot_subjects, db_connection


# ---------------------------------------------------------------------------
# Known edge properties for assertions
# ---------------------------------------------------------------------------

# Edges that should have latency (from the graph's edge.p.latency block)
LATENCY_EDGES = {
    "7bb83fbf-3ac6-4152-a395-a8b64a12506a",  # delegated-to-registered
    "97b11265-1242-4fa8-a097-359f2384665a",  # registered-to-success
}

# Edges that should be fitted (have param files)
FITTED_EDGES = {
    "b91c2820-7a1d-4498-9082-5967b5027d76",  # landing-to-created
    "c64ddc4d-c369-4ae8-a44a-398a63a46ab1",  # create-to-delegated
    "7bb83fbf-3ac6-4152-a395-a8b64a12506a",  # delegated-to-registered
    "97b11265-1242-4fa8-a097-359f2384665a",  # registered-to-success
}

EDGE_NAMES = {
    "b91c2820-7a1d-4498-9082-5967b5027d76": "landing→created",
    "c64ddc4d-c369-4ae8-a44a-398a63a46ab1": "created→delegated",
    "7bb83fbf-3ac6-4152-a395-a8b64a12506a": "delegated→registered",
    "97b11265-1242-4fa8-a097-359f2384665a": "registered→success",
}


# ---------------------------------------------------------------------------
# Stage checks
# ---------------------------------------------------------------------------

def check_topology(topology, r: WiringResults):
    """Check topology analysis output."""
    print("\n── TOPOLOGY ──")

    r.check("TOPO", "has anchor node", bool(topology.anchor_node_id))
    r.check("TOPO", f"edge count ({len(topology.edges)})", len(topology.edges) >= 4)
    r.check("TOPO", f"topo_order has entries", len(topology.topo_order) >= 4)

    # Fitted edges present
    for eid in FITTED_EDGES:
        name = EDGE_NAMES.get(eid, eid[:8])
        r.check("TOPO", f"edge {name} in topology", eid in topology.edges)

    # Latency edges have latency data
    for eid in LATENCY_EDGES:
        et = topology.edges.get(eid)
        name = EDGE_NAMES.get(eid, eid[:8])
        if et:
            r.check("TOPO", f"{name} has_latency", et.has_latency)
            r.check("TOPO", f"{name} mu_prior > 0", et.mu_prior > 0,
                    f"mu_prior={et.mu_prior:.3f}")
            r.check("TOPO", f"{name} sigma_prior > 0.01", et.sigma_prior > 0.01,
                    f"sigma_prior={et.sigma_prior:.3f}")

    # Non-latency edges
    for eid in FITTED_EDGES - LATENCY_EDGES:
        et = topology.edges.get(eid)
        name = EDGE_NAMES.get(eid, eid[:8])
        if et:
            r.check("TOPO", f"{name} has_latency=False", not et.has_latency)

    # Path latency composition
    for eid in FITTED_EDGES:
        et = topology.edges.get(eid)
        name = EDGE_NAMES.get(eid, eid[:8])
        if et:
            r.check("TOPO", f"{name} has path_edge_ids",
                    len(et.path_edge_ids) >= 1,
                    f"path={len(et.path_edge_ids)} edges")


def check_snapshot_query(snapshot_rows, r: WiringResults):
    """Check snapshot DB query results."""
    print("\n── SNAPSHOT QUERY ──")

    total_rows = sum(len(v) for v in snapshot_rows.values())
    r.check("EVID", f"total rows > 0 ({total_rows})", total_rows > 0)

    for eid in FITTED_EDGES:
        name = EDGE_NAMES.get(eid, eid[:8])
        rows = snapshot_rows.get(eid, [])
        r.check("EVID", f"{name} has snapshot rows", len(rows) > 0,
                f"{len(rows)} rows")


def check_evidence(evidence, topology, r: WiringResults):
    """Check evidence binding — the critical wiring stage."""
    print("\n── EVIDENCE BINDING ──")

    for eid in FITTED_EDGES:
        ev = evidence.edges.get(eid)
        name = EDGE_NAMES.get(eid, eid[:8])
        if ev is None:
            r.check("EVID", f"{name} has evidence", False, "missing")
            continue

        r.check("EVID", f"{name} not skipped", not ev.skipped,
                ev.skip_reason if ev.skipped else "")
        r.check("EVID", f"{name} total_n > 0", ev.total_n > 0,
                f"total_n={ev.total_n}")

        # Both obs types should be present for snapshot data
        r.check("EVID", f"{name} has_window", ev.has_window)
        r.check("EVID", f"{name} has_cohort", ev.has_cohort)

        # Count trajectories by obs_type
        n_window_traj = 0
        n_cohort_traj = 0
        n_window_daily = 0
        n_cohort_daily = 0
        for co in ev.cohort_obs:
            for t in co.trajectories:
                if t.obs_type == "window":
                    n_window_traj += 1
                else:
                    n_cohort_traj += 1
            for d in co.daily:
                if "window" in co.slice_dsl:
                    n_window_daily += 1
                else:
                    n_cohort_daily += 1

        r.check("EVID", f"{name} window trajectories > 0", n_window_traj > 0,
                f"{n_window_traj} trajectories")
        r.check("EVID", f"{name} cohort trajectories > 0", n_cohort_traj > 0,
                f"{n_cohort_traj} trajectories")

        # Trajectory quality: ages > 0, cumulative_y monotonic, n > 0
        bad_trajs = 0
        for co in ev.cohort_obs:
            for t in co.trajectories:
                if any(a <= 0 for a in t.retrieval_ages):
                    bad_trajs += 1
                if any(t.cumulative_y[i] < t.cumulative_y[i - 1]
                       for i in range(1, len(t.cumulative_y))):
                    bad_trajs += 1
                if t.n <= 0:
                    bad_trajs += 1
        r.check("EVID", f"{name} no bad trajectories", bad_trajs == 0,
                f"{bad_trajs} bad" if bad_trajs else "")

    # Latency priors present for latency edges
    for eid in LATENCY_EDGES:
        ev = evidence.edges.get(eid)
        name = EDGE_NAMES.get(eid, eid[:8])
        if ev:
            r.check("EVID", f"{name} has latency_prior", ev.latency_prior is not None)
            if ev.latency_prior:
                r.check("EVID", f"{name} latency sigma > 0.01",
                        ev.latency_prior.sigma > 0.01,
                        f"sigma={ev.latency_prior.sigma:.3f}")


def check_model(model, metadata, topology, evidence, r: WiringResults):
    """Check model structure — variables, Potentials, wiring."""
    print("\n── MODEL BUILDING ──")

    free_vars = [rv.name for rv in model.free_RVs]
    deterministics = [d.name for d in model.deterministics]
    potentials = [p.name for p in model.potentials]

    r.check("MODEL", "sigma_temporal exists", "sigma_temporal" in free_vars)

    n_free = len(free_vars)
    r.check("MODEL", f"free vars count reasonable ({n_free})",
            10 <= n_free <= 30, f"vars: {free_vars}")

    # Latent latency variables
    latent_edges = metadata.get("latent_latency_edges", set())
    for eid in LATENCY_EDGES:
        name = EDGE_NAMES.get(eid, eid[:8])
        safe = eid.replace("-", "_")
        mu_name = f"mu_lat_{safe}"
        sigma_name = f"sigma_lat_{safe}"
        r.check("MODEL", f"{name} mu_lat in free_RVs", mu_name in free_vars)
        r.check("MODEL", f"{name} sigma_lat in free_RVs", sigma_name in free_vars)
        r.check("MODEL", f"{name} in latent_latency_edges", eid in latent_edges)

    # Non-latency edges should NOT have latent latency
    for eid in FITTED_EDGES - LATENCY_EDGES:
        name = EDGE_NAMES.get(eid, eid[:8])
        safe = eid.replace("-", "_")
        r.check("MODEL", f"{name} no mu_lat", f"mu_lat_{safe}" not in free_vars)

    # Hierarchical edges (has_window + has_cohort) should have p_base, p_window, p_cohort
    for eid in FITTED_EDGES:
        ev = evidence.edges.get(eid)
        name = EDGE_NAMES.get(eid, eid[:8])
        safe = eid.replace("-", "_")
        if ev and ev.has_window and ev.has_cohort:
            r.check("MODEL", f"{name} p_window deterministic",
                    f"p_window_{safe}" in deterministics)
            r.check("MODEL", f"{name} p_cohort deterministic",
                    f"p_cohort_{safe}" in deterministics)
            r.check("MODEL", f"{name} eps_window free",
                    f"eps_window_{safe}" in free_vars)
            r.check("MODEL", f"{name} eps_cohort free",
                    f"eps_cohort_{safe}" in free_vars)

    # Potentials: each fitted edge should have window and cohort Potentials
    for eid in FITTED_EDGES:
        name = EDGE_NAMES.get(eid, eid[:8])
        safe = eid.replace("-", "_")
        has_window_potential = f"traj_window_{safe}" in potentials
        has_cohort_potential = f"traj_cohort_{safe}" in potentials
        r.check("MODEL", f"{name} window Potential", has_window_potential)
        r.check("MODEL", f"{name} cohort Potential", has_cohort_potential)

    # CRITICAL WIRING CHECK: window Potentials depend on p_window, not p_cohort
    # Inspect the PyTensor graph for each window Potential
    for eid in FITTED_EDGES:
        ev = evidence.edges.get(eid)
        if not ev or not (ev.has_window and ev.has_cohort):
            continue

        name = EDGE_NAMES.get(eid, eid[:8])
        safe = eid.replace("-", "_")
        window_pot_name = f"traj_window_{safe}"
        cohort_pot_name = f"traj_cohort_{safe}"

        # Find the Potential nodes
        window_pot = None
        cohort_pot = None
        for p in model.potentials:
            if p.name == window_pot_name:
                window_pot = p
            elif p.name == cohort_pot_name:
                cohort_pot = p

        if window_pot is not None:
            deps = _collect_named_ancestors(window_pot)
            has_p_window = f"p_window_{safe}" in deps
            has_p_cohort = f"p_cohort_{safe}" in deps
            r.check("MODEL", f"{name} window Potential uses p_window",
                    has_p_window,
                    f"deps include p_window={has_p_window}, p_cohort={has_p_cohort}")
            r.check("MODEL", f"{name} window Potential does NOT use p_cohort",
                    not has_p_cohort,
                    f"deps: {[d for d in deps if 'p_' in d]}")

        if cohort_pot is not None:
            deps = _collect_named_ancestors(cohort_pot)
            has_p_cohort = f"p_cohort_{safe}" in deps
            r.check("MODEL", f"{name} cohort Potential uses p_cohort",
                    has_p_cohort,
                    f"deps: {[d for d in deps if 'p_' in d]}")

    # Latent latency wiring: window Potentials for latency edges should
    # depend on mu_lat and sigma_lat
    for eid in LATENCY_EDGES:
        name = EDGE_NAMES.get(eid, eid[:8])
        safe = eid.replace("-", "_")
        window_pot = None
        for p in model.potentials:
            if p.name == f"traj_window_{safe}":
                window_pot = p
                break
        if window_pot is not None:
            deps = _collect_named_ancestors(window_pot)
            r.check("MODEL", f"{name} window Potential uses mu_lat",
                    f"mu_lat_{safe}" in deps)
            r.check("MODEL", f"{name} window Potential uses sigma_lat",
                    f"sigma_lat_{safe}" in deps)

    # CRITICAL: Path composition wiring for cohort Potentials
    # registered→success (4-hop path) has 2 latency edges: delegated→registered
    # AND registered→success. Its cohort Potential must depend on BOTH.
    reg_success_id = "97b11265-1242-4fa8-a097-359f2384665a"
    del_reg_id = "7bb83fbf-3ac6-4152-a395-a8b64a12506a"
    reg_success_safe = reg_success_id.replace("-", "_")
    del_reg_safe = del_reg_id.replace("-", "_")

    # Find cohort Potentials
    for p in model.potentials:
        if p.name == f"traj_cohort_{reg_success_safe}":
            deps = _collect_named_ancestors(p)
            r.check("MODEL", "registered→success cohort uses own mu_lat",
                    f"mu_lat_{reg_success_safe}" in deps)
            r.check("MODEL", "registered→success cohort uses UPSTREAM mu_lat (delegated→registered)",
                    f"mu_lat_{del_reg_safe}" in deps,
                    "FW path composition wiring")
            r.check("MODEL", "registered→success cohort uses UPSTREAM sigma_lat (delegated→registered)",
                    f"sigma_lat_{del_reg_safe}" in deps,
                    "FW path composition wiring")
        elif p.name == f"traj_cohort_{del_reg_safe}":
            deps = _collect_named_ancestors(p)
            r.check("MODEL", "delegated→registered cohort uses own mu_lat",
                    f"mu_lat_{del_reg_safe}" in deps)
            # Should NOT depend on downstream edge's latency
            r.check("MODEL", "delegated→registered cohort does NOT use registered→success mu_lat",
                    f"mu_lat_{reg_success_safe}" not in deps)


def _collect_named_ancestors(var, max_depth=200) -> set[str]:
    """Walk the PyTensor computation graph and collect named variable names."""
    names = set()
    visited = set()
    stack = [(var, 0)]
    while stack:
        node, depth = stack.pop()
        node_id = id(node)
        if node_id in visited or depth > max_depth:
            continue
        visited.add(node_id)
        if hasattr(node, 'name') and node.name:
            names.add(node.name)
        # Walk inputs (PyTensor Apply nodes)
        owner = getattr(node, 'owner', None)
        if owner:
            for inp in owner.inputs:
                stack.append((inp, depth + 1))
    return names


def check_inference(result, topology, evidence, metadata, r: WiringResults):
    """Check inference results — posteriors, latency, convergence."""
    print("\n── INFERENCE ──")

    q = result.quality
    r.check("INFER", f"rhat < 1.05 ({q.max_rhat:.3f})", q.max_rhat < 1.05)
    r.check("INFER", f"ESS > 400 ({q.min_ess:.0f})", q.min_ess >= 400)
    r.check("INFER", f"0 divergences ({q.total_divergences})",
            q.total_divergences == 0)
    r.check("INFER", f"converged 100% ({q.converged_pct}%)",
            q.converged_pct == 100.0)

    # Probability posteriors for all fitted edges
    fitted_param_ids = {evidence.edges[eid].param_id
                       for eid in FITTED_EDGES
                       if eid in evidence.edges}
    posterior_edges = {p.edge_id for p in result.posteriors}
    for eid in FITTED_EDGES:
        name = EDGE_NAMES.get(eid, eid[:8])
        r.check("INFER", f"{name} has probability posterior", eid in posterior_edges)

    # Probability posteriors are sensible
    for post in result.posteriors:
        name = EDGE_NAMES.get(post.edge_id, post.edge_id[:8])
        r.check("INFER", f"{name} p mean in (0,1)", 0 < post.mean < 1,
                f"mean={post.mean:.4f}")
        r.check("INFER", f"{name} p stdev > 0", post.stdev > 0,
                f"stdev={post.stdev:.6f}")
        r.check("INFER", f"{name} HDI lower < upper",
                post.hdi_lower < post.hdi_upper,
                f"HDI=[{post.hdi_lower:.4f}, {post.hdi_upper:.4f}]")
        r.check("INFER", f"{name} provenance=bayesian",
                post.provenance == "bayesian",
                f"provenance={post.provenance}")

    # CRITICAL: Latency posteriors for latency edges must be from real samples
    for eid in LATENCY_EDGES:
        name = EDGE_NAMES.get(eid, eid[:8])
        lat = result.latency_posteriors.get(eid)
        ev = evidence.edges.get(eid)

        r.check("INFER", f"{name} has latency posterior", lat is not None)
        if lat is None or ev is None or ev.latency_prior is None:
            continue

        prior = ev.latency_prior
        r.check("INFER", f"{name} latency provenance=bayesian",
                lat.provenance == "bayesian",
                f"provenance={lat.provenance}")
        r.check("INFER", f"{name} latency NOT echoing prior mu",
                abs(lat.mu_mean - prior.mu) > 0.001 or lat.mu_sd > 0.01,
                f"posterior_mu={lat.mu_mean:.3f} prior_mu={prior.mu:.3f} "
                f"mu_sd={lat.mu_sd:.3f}")
        r.check("INFER", f"{name} latency mu_sd > 0 (real uncertainty)",
                lat.mu_sd > 0.001,
                f"mu_sd={lat.mu_sd:.4f}")
        r.check("INFER", f"{name} latency sigma_sd > 0 (real uncertainty)",
                lat.sigma_sd > 0.001,
                f"sigma_sd={lat.sigma_sd:.4f}")
        r.check("INFER", f"{name} latency rhat < 1.05",
                lat.rhat < 1.05,
                f"rhat={lat.rhat:.3f}")
        r.check("INFER", f"{name} latency ESS > 100",
                lat.ess > 100,
                f"ess={lat.ess:.0f}")
        r.check("INFER", f"{name} t95 HDI lower < upper",
                lat.hdi_t95_lower < lat.hdi_t95_upper,
                f"t95=[{lat.hdi_t95_lower:.1f}, {lat.hdi_t95_upper:.1f}]")

        # Summary: show how much the model moved from the prior
        print(f"    {name} latency: mu {prior.mu:.3f} → {lat.mu_mean:.3f} "
              f"(Δ={lat.mu_mean - prior.mu:+.3f}), "
              f"sigma {prior.sigma:.3f} → {lat.sigma_mean:.3f} "
              f"(Δ={lat.sigma_mean - prior.sigma:+.3f})")

        # Cohort-level (path) latency posterior
        r.check("INFER", f"{name} has path_mu_mean",
                lat.path_mu_mean is not None,
                f"path_mu_mean={lat.path_mu_mean}")
        if lat.path_mu_mean is not None:
            r.check("INFER", f"{name} path_onset >= 0",
                    lat.path_onset_delta_days is not None and lat.path_onset_delta_days >= 0,
                    f"path_onset={lat.path_onset_delta_days}")
            r.check("INFER", f"{name} path_sigma > 0",
                    lat.path_sigma_mean is not None and lat.path_sigma_mean > 0,
                    f"path_sigma={lat.path_sigma_mean}")
            r.check("INFER", f"{name} path_provenance=bayesian",
                    lat.path_provenance == "bayesian",
                    f"path_provenance={lat.path_provenance}")
            print(f"    {name} cohort: onset={lat.path_onset_delta_days:.1f}, "
                  f"mu={lat.path_mu_mean:.3f}±{lat.path_mu_sd:.3f}, "
                  f"sigma={lat.path_sigma_mean:.3f}±{lat.path_sigma_sd:.3f}")

    # Non-latency edges should NOT have latency posteriors (or should be point-estimate)
    for eid in FITTED_EDGES - LATENCY_EDGES:
        name = EDGE_NAMES.get(eid, eid[:8])
        lat = result.latency_posteriors.get(eid)
        if lat:
            r.check("INFER", f"{name} latency provenance=point-estimate",
                    lat.provenance == "point-estimate",
                    f"provenance={lat.provenance}")


def check_webhook_payload(result_edges, evidence, r: WiringResults):
    """Check the webhook payload edges would be correct."""
    print("\n── WEBHOOK PAYLOAD ──")

    r.check("PATCH", f"edge count ({len(result_edges)})",
            len(result_edges) == len(FITTED_EDGES),
            f"expected {len(FITTED_EDGES)}")

    for edge in result_edges:
        param_id = edge.get("param_id", "")
        prob = edge.get("probability", {})
        lat = edge.get("latency")

        r.check("PATCH", f"{param_id[:20]}… has probability", bool(prob))
        if prob:
            r.check("PATCH", f"{param_id[:20]}… prob has alpha/beta",
                    prob.get("alpha") is not None and prob.get("beta") is not None)
            r.check("PATCH", f"{param_id[:20]}… prob provenance",
                    prob.get("provenance") == "bayesian",
                    f"provenance={prob.get('provenance')}")

        # Latency edges should have latency in payload with provenance=bayesian
        is_latency_edge = any(
            param_id.endswith(name) for name in
            ["delegated-to-registered", "registered-to-success"]
        )
        if is_latency_edge:
            r.check("PATCH", f"{param_id[:20]}… has latency block",
                    lat is not None)
            if lat:
                r.check("PATCH", f"{param_id[:20]}… latency provenance=bayesian",
                        lat.get("provenance") == "bayesian",
                        f"provenance={lat.get('provenance')}")
                r.check("PATCH", f"{param_id[:20]}… latency mu_sd > 0.001",
                        (lat.get("mu_sd") or 0) > 0.001,
                        f"mu_sd={lat.get('mu_sd')}")
                # Path-level (cohort) latency fields
                r.check("PATCH", f"{param_id[:20]}… has path_mu_mean",
                        lat.get("path_mu_mean") is not None,
                        f"path_mu_mean={lat.get('path_mu_mean')}")
                r.check("PATCH", f"{param_id[:20]}… has path_sigma_mean",
                        lat.get("path_sigma_mean") is not None,
                        f"path_sigma_mean={lat.get('path_sigma_mean')}")
                r.check("PATCH", f"{param_id[:20]}… has path_onset_delta_days",
                        lat.get("path_onset_delta_days") is not None,
                        f"path_onset={lat.get('path_onset_delta_days')}")
                r.check("PATCH", f"{param_id[:20]}… path_provenance=bayesian",
                        lat.get("path_provenance") == "bayesian",
                        f"path_provenance={lat.get('path_provenance')}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

LOCK_FILE = "/tmp/bayes-harness.lock"  # shared with test_harness.py


def _acquire_lock():
    """Kill any existing harness/wiring run and take the lock."""
    import signal as sig
    if os.path.exists(LOCK_FILE):
        try:
            with open(LOCK_FILE) as f:
                old_pid = int(f.read().strip())
            os.kill(old_pid, 0)
            print(f"Killing previous run (PID {old_pid})…")
            import subprocess
            subprocess.run(["pkill", "-P", str(old_pid)], capture_output=True)
            try:
                os.kill(old_pid, sig.SIGKILL)
            except ProcessLookupError:
                pass
            time.sleep(0.5)
        except (ProcessLookupError, ValueError):
            pass
        try:
            os.remove(LOCK_FILE)
        except FileNotFoundError:
            pass
    with open(LOCK_FILE, "w") as f:
        f.write(str(os.getpid()))
    import atexit
    atexit.register(lambda: os.remove(LOCK_FILE) if os.path.exists(LOCK_FILE) else None)


def main():
    import argparse

    _acquire_lock()

    parser = argparse.ArgumentParser(description="Bayes wiring verification")
    parser.add_argument("--no-mcmc", action="store_true",
                       help="Stop after model build (skip sampling)")
    parser.add_argument("--full", action="store_true",
                       help="Full MCMC (2000 draws, 4 chains)")
    parser.add_argument("--timeout", type=int, default=300,
                       help="Hard timeout in seconds (default: 300)")
    args = parser.parse_args()

    r = WiringResults()
    t0 = time.time()

    print("Loading test data…")
    graph, param_files, snapshot_subjects, db_connection = load_test_data()
    print(f"  Graph: {len(graph.get('edges', []))} edges")
    print(f"  Param files: {len(param_files)}")
    print(f"  Snapshot subjects: {len(snapshot_subjects)}")
    print(f"  DB connection: {'yes' if db_connection else 'NO'}")

    if not db_connection:
        print("ERROR: No DB_CONNECTION — cannot query snapshots")
        sys.exit(1)

    # ── Stage 1: Topology ──
    print("\n" + "="*60)
    print("Stage 1: Topology analysis")
    print("="*60)

    from compiler import analyse_topology
    topology = analyse_topology(graph)
    check_topology(topology, r)

    # ── Stage 2: Snapshot query ──
    print("\n" + "="*60)
    print("Stage 2: Snapshot DB query")
    print("="*60)

    import psycopg2
    conn = psycopg2.connect(db_connection)
    # Reuse the worker's query logic
    sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))
    from worker import _query_snapshot_subjects
    log = []
    snapshot_rows = _query_snapshot_subjects(conn, snapshot_subjects, topology, log)
    conn.close()
    for l in log:
        print(f"  {l}")
    check_snapshot_query(snapshot_rows, r)

    # ── Stage 3: Evidence binding ──
    print("\n" + "="*60)
    print("Stage 3: Evidence binding")
    print("="*60)

    from compiler import bind_snapshot_evidence
    evidence = bind_snapshot_evidence(
        topology, snapshot_rows, param_files, {}, {},
    )
    for d in evidence.diagnostics:
        print(f"  {d}")
    check_evidence(evidence, topology, r)

    # ── Stage 4: Model building ──
    print("\n" + "="*60)
    print("Stage 4: Model building")
    print("="*60)

    from compiler import build_model
    model, metadata = build_model(topology, evidence)
    print(f"  Free RVs: {[rv.name for rv in model.free_RVs]}")
    print(f"  Potentials: {[p.name for p in model.potentials]}")
    for d in metadata.get("diagnostics", []):
        print(f"  {d}")
    check_model(model, metadata, topology, evidence, r)

    if args.no_mcmc:
        print("\n── Skipping MCMC (--no-mcmc) ──")
        r.summary()
        elapsed = time.time() - t0
        print(f"Elapsed: {elapsed:.1f}s")
        sys.exit(0 if r.summary() else 1)

    # ── Stage 5: Inference ──
    print("\n" + "="*60)
    print("Stage 5: Inference (MCMC)")
    print("="*60)

    from compiler import run_inference, summarise_posteriors
    from compiler.types import SamplingConfig

    if args.full:
        config = SamplingConfig(draws=2000, tune=1000, chains=4, cores=4)
        print("  Config: full (2000 draws, 1000 tune, 4 chains)")
    else:
        config = SamplingConfig(draws=200, tune=200, chains=2, cores=2,
                               target_accept=0.85)
        print("  Config: fast (200 draws, 200 tune, 2 chains)")

    def _progress(stage, pct, detail=""):
        print(f"  [{pct:3d}%] {stage}: {detail}", flush=True)

    t_sample = time.time()
    trace, quality = run_inference(model, config, _progress)
    sample_ms = int((time.time() - t_sample) * 1000)
    print(f"  Sampling: {sample_ms}ms")

    # ── Stage 6: Posterior summarisation ──
    print("\n" + "="*60)
    print("Stage 6: Posterior summarisation")
    print("="*60)

    inference_result = summarise_posteriors(
        trace, topology, evidence, metadata, quality,
    )
    for d in inference_result.diagnostics:
        print(f"  {d}")
    check_inference(inference_result, topology, evidence, metadata, r)

    # ── Stage 7: Webhook payload format ──
    print("\n" + "="*60)
    print("Stage 7: Webhook payload format")
    print("="*60)

    result_edges = []
    for post in inference_result.posteriors:
        entry = {
            "param_id": post.param_id,
            "file_path": f"parameters/{post.param_id}.yaml",
            "probability": post.to_webhook_dict(),
        }
        lat = inference_result.latency_posteriors.get(post.edge_id)
        if lat:
            entry["latency"] = lat.to_webhook_dict()
        result_edges.append(entry)

    check_webhook_payload(result_edges, evidence, r)

    # ── Summary ──
    elapsed = time.time() - t0
    print(f"\nTotal elapsed: {elapsed:.1f}s (sampling: {sample_ms}ms)")
    all_passed = r.summary()
    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()
