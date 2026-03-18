"""
Model builder: TopologyAnalysis + BoundEvidence → pm.Model.

Phase A model structure:
  - Graph-level σ_temporal (learned temporal volatility)
  - Per edge: p_base ~ Beta(α, β)
  - If window + cohort: p_window (tight to base), p_cohort (path-informed divergence)
  - If window only: p = p_base
  - If cohort only: p = p_base
  - Solo edges: window obs → Binomial(n, p * completeness, k)
  - Branch groups: window obs → Multinomial(n_A, [p_siblings..., dropout], [k_siblings..., residual])
  - All edges: cohort obs → per-day Binomial(n_daily, p * path_completeness, k_daily)

This is the only module that imports PyMC.
"""

from __future__ import annotations

from .types import (
    TopologyAnalysis,
    BoundEvidence,
    EdgeEvidence,
)


def build_model(topology: TopologyAnalysis, evidence: BoundEvidence):
    """Build a PyMC model from the topology and bound evidence.

    Returns (pm.Model, model_metadata_dict).
    """
    import pymc as pm
    import pytensor.tensor as pt
    import numpy as np

    diagnostics: list[str] = []
    edge_var_names: dict[str, str] = {}  # edge_id → primary p variable name

    # Identify which edges will have their window obs handled by a branch
    # group Multinomial instead of per-edge Binomials.
    bg_window_edges = _identify_branch_group_window_edges(
        topology, evidence, diagnostics,
    )

    with pm.Model() as model:
        # --- Graph-level σ_temporal ---
        sigma_temporal = pm.HalfNormal("sigma_temporal", sigma=0.5)

        # --- Per-edge variables and likelihoods ---
        for edge_id in topology.topo_order:
            et = topology.edges.get(edge_id)
            ev = evidence.edges.get(edge_id)

            if et is None or ev is None:
                continue
            if ev.skipped:
                continue

            safe_id = _safe_var_name(edge_id)
            alpha = ev.prob_prior.alpha
            beta_param = ev.prob_prior.beta

            # Should this edge's window obs be emitted per-edge, or will
            # the branch group Multinomial handle them?
            emit_window_binomial = edge_id not in bg_window_edges

            if ev.has_window and ev.has_cohort:
                # Hierarchical: p_base, p_window (tight), p_cohort (path-informed)
                # Non-centred parameterisation to avoid funnel geometry with
                # concentrated posteriors (high-n data).
                p_base = pm.Beta(f"p_base_{safe_id}", alpha=alpha, beta=beta_param)
                logit_p_base = pm.math.log(p_base / (1 - p_base))

                # Window: tight pooling around base (non-centred)
                tau_window = 0.1
                eps_window = pm.Normal(f"eps_window_{safe_id}", mu=0, sigma=1)
                logit_p_window = pm.Deterministic(
                    f"logit_p_window_{safe_id}",
                    logit_p_base + eps_window * tau_window,
                )
                p_window = pm.Deterministic(
                    f"p_window_{safe_id}",
                    pm.math.sigmoid(logit_p_window),
                )

                # Cohort: path-informed divergence (non-centred)
                path_sigma_ax = max(et.path_sigma_ax, 0.01)
                tau_cohort = pm.Deterministic(
                    f"tau_cohort_{safe_id}",
                    sigma_temporal * path_sigma_ax,
                )
                tau_cohort_safe = pm.math.maximum(tau_cohort, 0.01)
                eps_cohort = pm.Normal(f"eps_cohort_{safe_id}", mu=0, sigma=1)
                logit_p_cohort = pm.Deterministic(
                    f"logit_p_cohort_{safe_id}",
                    logit_p_base + eps_cohort * tau_cohort_safe,
                )
                p_cohort = pm.Deterministic(
                    f"p_cohort_{safe_id}",
                    pm.math.sigmoid(logit_p_cohort),
                )

                if emit_window_binomial:
                    _emit_window_likelihoods(safe_id, p_window, ev, diagnostics)
                _emit_cohort_likelihoods(safe_id, p_cohort, ev, diagnostics)

                edge_var_names[edge_id] = f"p_base_{safe_id}"

            elif ev.has_window:
                p = pm.Beta(f"p_{safe_id}", alpha=alpha, beta=beta_param)
                if emit_window_binomial:
                    _emit_window_likelihoods(safe_id, p, ev, diagnostics)
                edge_var_names[edge_id] = f"p_{safe_id}"

            elif ev.has_cohort:
                p = pm.Beta(f"p_{safe_id}", alpha=alpha, beta=beta_param)
                _emit_cohort_likelihoods(safe_id, p, ev, diagnostics)
                edge_var_names[edge_id] = f"p_{safe_id}"

            else:
                p = pm.Beta(f"p_{safe_id}", alpha=alpha, beta=beta_param)
                edge_var_names[edge_id] = f"p_{safe_id}"

        # --- Branch group Multinomial likelihoods (window obs) ---
        for group_id, bg in topology.branch_groups.items():
            _emit_branch_group_multinomial(
                bg, topology, evidence, edge_var_names, model, diagnostics,
            )

    metadata = {
        "edge_var_names": edge_var_names,
        "diagnostics": diagnostics,
    }

    return model, metadata


# ---------------------------------------------------------------------------
# Branch group identification
# ---------------------------------------------------------------------------

def _identify_branch_group_window_edges(
    topology: TopologyAnalysis,
    evidence: BoundEvidence,
    diagnostics: list[str],
) -> set[str]:
    """Identify edges whose window obs will be handled by a Multinomial.

    An edge qualifies if:
      - It's in a branch group
      - It has window observations
      - At least one sibling also has window observations
      - Total sibling k doesn't exceed shared n (counts are consistent)

    Returns the set of edge IDs whose window Binomials should NOT be
    emitted per-edge (the Multinomial covers them).
    """
    result: set[str] = set()

    for group_id, bg in topology.branch_groups.items():
        siblings_with_window = []
        for sib_id in bg.sibling_edge_ids:
            ev = evidence.edges.get(sib_id)
            if ev is None or ev.skipped:
                continue
            if ev.has_window and sum(w.n for w in ev.window_obs) > 0:
                siblings_with_window.append(sib_id)

        if len(siblings_with_window) < 2:
            continue

        # Check count consistency
        shared_n = max(
            sum(w.n for w in evidence.edges[sid].window_obs)
            for sid in siblings_with_window
        )
        total_k = sum(
            sum(w.k for w in evidence.edges[sid].window_obs)
            for sid in siblings_with_window
        )
        if total_k > shared_n:
            diagnostics.append(
                f"WARN: branch group {group_id}: "
                f"Σk={total_k} > n_A={shared_n}, falling back to per-edge Binomials"
            )
            continue

        for sib_id in siblings_with_window:
            result.add(sib_id)

    return result


# ---------------------------------------------------------------------------
# Likelihood emission helpers
# ---------------------------------------------------------------------------

def _emit_window_likelihoods(
    safe_id: str,
    p_var,
    ev: EdgeEvidence,
    diagnostics: list[str],
) -> None:
    """Emit Binomial likelihoods for window observations (solo edges only)."""
    import pymc as pm

    for i, w_obs in enumerate(ev.window_obs):
        if w_obs.n <= 0:
            continue
        suffix = f"_{i}" if len(ev.window_obs) > 1 else ""
        p_effective = p_var * w_obs.completeness
        pm.Binomial(
            f"obs_w_{safe_id}{suffix}",
            n=w_obs.n,
            p=pm.math.clip(p_effective, 0.001, 0.999),
            observed=min(w_obs.k, w_obs.n),
        )


def _emit_cohort_likelihoods(
    safe_id: str,
    p_var,
    ev: EdgeEvidence,
    diagnostics: list[str],
) -> None:
    """Emit per-day Binomial likelihoods for cohort observations."""
    import pymc as pm
    import numpy as np

    for c_idx, c_obs in enumerate(ev.cohort_obs):
        if not c_obs.daily:
            continue

        c_suffix = f"_c{c_idx}" if len(ev.cohort_obs) > 1 else ""

        n_arr = np.array([d.n for d in c_obs.daily], dtype=np.int64)
        k_arr = np.array([min(d.k, d.n) for d in c_obs.daily], dtype=np.int64)
        compl_arr = np.array([d.completeness for d in c_obs.daily], dtype=np.float64)

        mask = n_arr > 0
        if not mask.any():
            continue

        n_arr = n_arr[mask]
        k_arr = k_arr[mask]
        compl_arr = compl_arr[mask]

        p_effective = pm.math.clip(p_var * compl_arr, 0.001, 0.999)

        pm.Binomial(
            f"obs_c_{safe_id}{c_suffix}",
            n=n_arr,
            p=p_effective,
            observed=k_arr,
        )


def _emit_branch_group_multinomial(
    bg,
    topology: TopologyAnalysis,
    evidence: BoundEvidence,
    edge_var_names: dict[str, str],
    model,
    diagnostics: list[str],
) -> None:
    """Emit Multinomial likelihood for a branch group's window observations.

    Phase A: independent Betas per sibling (no Dirichlet).
    The Multinomial enforces shared-denominator mass conservation.
    Each sibling's p_window (or p if window-only) is a component.
    A dropout component absorbs the residual (non-exhaustive).

    Cohort daily observations are handled per-edge via _emit_cohort_likelihoods
    (different completeness per sibling per day makes a shared Multinomial
    impractical for cohort data).
    """
    import pymc as pm
    import pytensor.tensor as pt
    import numpy as np

    # Collect siblings that have window data and a model variable
    sibling_info = []
    for sib_id in bg.sibling_edge_ids:
        ev = evidence.edges.get(sib_id)
        if ev is None or ev.skipped or not ev.has_window:
            continue
        var_name = edge_var_names.get(sib_id)
        if var_name is None:
            continue

        total_k = sum(w.k for w in ev.window_obs)
        total_n = sum(w.n for w in ev.window_obs)
        avg_completeness = (
            sum(w.n * w.completeness for w in ev.window_obs) / total_n
            if total_n > 0 else 1.0
        )

        if total_n > 0:
            sibling_info.append({
                "edge_id": sib_id,
                "var_name": var_name,
                "k": total_k,
                "n": total_n,
                "completeness": avg_completeness,
            })

    if len(sibling_info) < 2:
        return

    # Shared denominator
    shared_n = max(s["n"] for s in sibling_info)
    total_k = sum(s["k"] for s in sibling_info)

    if total_k > shared_n:
        # Counts inconsistent — should have been caught by
        # _identify_branch_group_window_edges, but guard anyway
        diagnostics.append(
            f"WARN: branch group {bg.group_id}: "
            f"Σk={total_k} > n_A={shared_n}, skipping Multinomial"
        )
        return

    # Resolve the p_window variable for each sibling from the model
    sibling_p_vars = []
    for s in sibling_info:
        safe_id = _safe_var_name(s["edge_id"])
        # Try p_window first (hierarchical case), then p (window-only case)
        p_window_name = f"p_window_{safe_id}"
        p_name = f"p_{safe_id}"
        found = False
        for rv in model.deterministics + model.free_RVs:
            if rv.name == p_window_name or rv.name == p_name:
                sibling_p_vars.append((s, rv))
                found = True
                break
        if not found:
            diagnostics.append(
                f"WARN: branch group {bg.group_id}: "
                f"could not find p variable for {s['edge_id'][:8]}…"
            )
            return

    # Build the Multinomial: [p_1 * c_1, p_2 * c_2, ..., dropout]
    # observed: [k_1, k_2, ..., n_A - Σk]
    p_components = []
    k_observed = []
    for s, p_var in sibling_p_vars:
        p_eff = p_var * s["completeness"]
        p_components.append(p_eff)
        k_observed.append(s["k"])

    # Stack into a vector
    p_stack = pt.stack(p_components)

    # Dropout = 1 - sum(p_effective_siblings)
    p_dropout = 1.0 - pt.sum(p_stack)
    # Clamp dropout to avoid negative (Phase A accepts p_B + p_C > 1 is possible)
    p_dropout_safe = pt.maximum(p_dropout, 0.001)

    # Full probability vector: [siblings..., dropout]
    p_full = pt.concatenate([p_stack, pt.stack([p_dropout_safe])])

    # Observed counts: [k_siblings..., residual]
    dropout_k = shared_n - total_k
    k_full = np.array(k_observed + [dropout_k], dtype=np.int64)

    safe_group = _safe_var_name(bg.group_id)
    pm.Multinomial(
        f"obs_bg_{safe_group}",
        n=shared_n,
        p=p_full,
        observed=k_full,
    )

    diagnostics.append(
        f"INFO: branch group {bg.group_id}: Multinomial emitted, "
        f"{len(sibling_info)} siblings, n_A={shared_n}, Σk={total_k}, "
        f"dropout={dropout_k}"
    )


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _safe_var_name(edge_id: str) -> str:
    """Convert edge UUID to a safe PyMC variable name."""
    return edge_id.replace("-", "_")
