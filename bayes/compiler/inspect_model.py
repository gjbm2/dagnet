"""
Model inspection: structured dump of the compiled pm.Model.

Runs AFTER build_model(), BEFORE MCMC. Produces a human-readable
report of every free RV, deterministic, potential, and observed node,
plus evidence binding confirmation. Designed to be the "what are we
actually sending into the sampler?" checkpoint.

Usage:
    model, metadata = build_model(topology, evidence, features=features)
    report = inspect_model(model, metadata, topology, evidence)
    for line in report:
        print(line)
"""

from __future__ import annotations

from .types import TopologyAnalysis, BoundEvidence


def inspect_model(
    model,
    metadata: dict,
    topology: TopologyAnalysis,
    evidence: BoundEvidence,
) -> list[str]:
    """Produce a structured inspection report of the compiled model.

    Returns a list of lines (no trailing newlines).
    """
    lines: list[str] = []

    def _h(title: str) -> None:
        lines.append("")
        lines.append(f"{'─' * 60}")
        lines.append(f"  {title}")
        lines.append(f"{'─' * 60}")

    # ── 1. Summary ──
    _h("MODEL SUMMARY")
    lines.append(f"  Free RVs:       {len(model.free_RVs)}")
    lines.append(f"  Deterministics:  {len(model.deterministics)}")
    lines.append(f"  Potentials:      {len(model.potentials)}")
    lines.append(f"  Observed RVs:    {len(model.observed_RVs)}")

    # ── 2. Free RVs with distribution info ──
    _h("FREE RANDOM VARIABLES")
    for rv in sorted(model.free_RVs, key=lambda v: v.name):
        dist_name = _get_dist_name(rv)
        params = _get_dist_params(rv)
        lines.append(f"  {rv.name:<40s}  {dist_name}({params})")

    # ── 3. Deterministics ──
    _h("DETERMINISTICS")
    for det in sorted(model.deterministics, key=lambda v: v.name):
        lines.append(f"  {det.name}")

    # ── 4. Potentials (likelihood terms) ──
    _h("POTENTIALS (likelihood terms)")
    if model.potentials:
        for pot in model.potentials:
            lines.append(f"  {pot.name}")
    else:
        lines.append("  (none)")

    # ── 5. Observed RVs ──
    _h("OBSERVED RVs")
    if model.observed_RVs:
        for obs in sorted(model.observed_RVs, key=lambda v: v.name):
            dist_name = _get_dist_name(obs)
            obs_val = _get_observed_summary(obs)
            lines.append(f"  {obs.name:<40s}  {dist_name}  obs={obs_val}")
    else:
        lines.append("  (none)")

    # ── 6. Features / flags ──
    _h("FEATURES")
    for d in metadata.get("diagnostics", []):
        if d.startswith("features:"):
            lines.append(f"  {d}")
            break
    latent_lat = metadata.get("latent_latency_edges", set())
    latent_onset = metadata.get("latent_onset_edges", set())
    cohort_lat = metadata.get("cohort_latency_edges", set())
    lines.append(f"  latent_latency edges: {len(latent_lat)}")
    lines.append(f"  latent_onset edges:   {len(latent_onset)}")
    lines.append(f"  cohort_latency edges: {len(cohort_lat)}")

    # ── 7. Per-edge evidence binding confirmation ──
    _h("EVIDENCE BINDING")
    for edge_id in topology.topo_order:
        et = topology.edges.get(edge_id)
        ev = evidence.edges.get(edge_id)
        if et is None or ev is None:
            continue

        pid = et.param_id or "(no param_id)"
        short_id = edge_id[:8]

        if ev.skipped:
            lines.append(f"  {short_id}… {pid:<40s}  SKIPPED: {ev.skip_reason}")
            continue

        # Count observations
        n_window_obs = len(ev.window_obs)
        total_window_n = sum(w.n for w in ev.window_obs)
        total_window_k = sum(w.k for w in ev.window_obs)

        n_window_traj = 0
        n_cohort_traj = 0
        max_traj_ages = 0
        for co in ev.cohort_obs:
            for t in co.trajectories:
                if t.obs_type == "window":
                    n_window_traj += 1
                else:
                    n_cohort_traj += 1
                max_traj_ages = max(max_traj_ages, len(t.retrieval_ages))

        # Priors
        prob_src = ev.prob_prior.source if ev.prob_prior else "?"
        prob_a = ev.prob_prior.alpha if ev.prob_prior else "?"
        prob_b = ev.prob_prior.beta if ev.prob_prior else "?"

        lat_str = ""
        if ev.latency_prior:
            lp = ev.latency_prior
            lat_str = (f"  latency: mu={lp.mu:.3f} sigma={lp.sigma:.3f} "
                       f"onset={lp.onset_delta_days:.1f} (±{lp.onset_uncertainty:.1f}) "
                       f"src={lp.source}")

        # Topology info
        topo_str = ""
        if not et.is_solo:
            topo_str = f"  group={et.branch_group_id}"
        if et.has_latency:
            topo_str += "  has_latency"
        path_len = len(et.path_edge_ids)
        if path_len > 1:
            n_lat_on_path = sum(
                1 for eid in et.path_edge_ids
                if topology.edges.get(eid) and topology.edges[eid].has_latency
            )
            topo_str += f"  path={path_len} edges ({n_lat_on_path} latency)"

        lines.append(
            f"  {short_id}… {pid:<35s}  "
            f"w_obs={n_window_obs}(n={total_window_n},k={total_window_k}) "
            f"w_traj={n_window_traj} c_traj={n_cohort_traj} "
            f"max_ages={max_traj_ages}"
        )
        lines.append(
            f"           {'':35s}  "
            f"prior=Beta({prob_a:.1f},{prob_b:.1f}) [{prob_src}]"
            f"{topo_str}"
        )
        if lat_str:
            lines.append(f"           {'':35s} {lat_str}")

    # ── 8. Variable-to-edge mapping ──
    _h("VARIABLE → EDGE MAPPING")
    edge_var_names = metadata.get("edge_var_names", {})
    for edge_id, var_name in sorted(edge_var_names.items(), key=lambda x: x[1]):
        pid = topology.edges[edge_id].param_id if edge_id in topology.edges else "?"
        lines.append(f"  {var_name:<40s}  → {edge_id[:8]}… ({pid})")

    lines.append("")
    return lines


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_dist_name(rv) -> str:
    """Extract distribution name from a PyMC RV."""
    try:
        owner = rv.owner
        if owner is not None:
            return owner.op.__class__.__name__
    except Exception:
        pass
    return "?"


def _get_dist_params(rv) -> str:
    """Extract distribution parameters as a compact string."""
    try:
        owner = rv.owner
        if owner is None:
            return ""
        # Try to get parameter values from the owner's inputs
        params = []
        for inp in owner.inputs[3:]:  # skip rng, size, dtype
            try:
                val = inp.eval()
                if hasattr(val, 'shape') and val.shape == ():
                    params.append(f"{float(val):.3g}")
                elif hasattr(val, '__len__') and len(val) <= 4:
                    params.append(str([round(float(v), 3) for v in val]))
                else:
                    params.append(f"shape={getattr(val, 'shape', '?')}")
            except Exception:
                params.append("…")
        return ", ".join(params)
    except Exception:
        return ""


def _get_observed_summary(obs) -> str:
    """Summarise observed data attached to an RV."""
    try:
        import numpy as np
        tag = obs.tag
        if hasattr(tag, 'observations'):
            data = tag.observations
        else:
            # PyMC 5.x: observed data in model.rvs_to_values
            data = obs.owner.inputs[-1] if obs.owner else None
        if data is not None:
            val = data.eval() if hasattr(data, 'eval') else data
            if hasattr(val, 'shape'):
                return f"shape={val.shape}, sum={np.sum(val):.0f}"
            return str(val)
    except Exception:
        pass
    return "?"
