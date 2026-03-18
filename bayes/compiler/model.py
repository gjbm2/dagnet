"""
Model builder: TopologyAnalysis + BoundEvidence → pm.Model.

Phase B model structure:
  - Graph-level σ_temporal (learned temporal volatility)
  - Solo edges: p ~ Beta(α, β)
  - Branch groups: [p_1, ..., p_K, p_dropout] ~ Dirichlet(α_vec)
    - Exhaustive groups omit the dropout component
  - If window + cohort: p_base from Dirichlet/Beta, p_window (tight), p_cohort (path-informed)
  - If window only: p from Dirichlet/Beta
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

    # Pre-compute which edges belong to branch groups (for Dirichlet emission)
    bg_edge_ids: set[str] = set()
    for bg in topology.branch_groups.values():
        for sib_id in bg.sibling_edge_ids:
            bg_edge_ids.add(sib_id)

    with pm.Model() as model:
        # --- Graph-level σ_temporal ---
        sigma_temporal = pm.HalfNormal("sigma_temporal", sigma=0.5)

        # --- Branch group Dirichlet priors (Phase B) ---
        # Emit Dirichlet per branch group. Each sibling gets a component;
        # non-exhaustive groups get a phantom dropout component.
        bg_p_vars: dict[str, object] = {}  # edge_id → Dirichlet component variable

        for group_id, bg in topology.branch_groups.items():
            _emit_dirichlet_prior(
                bg, topology, evidence, bg_p_vars, edge_var_names,
                model, diagnostics,
            )

        # --- Per-edge variables and likelihoods ---
        for edge_id in topology.topo_order:
            et = topology.edges.get(edge_id)
            ev = evidence.edges.get(edge_id)

            if et is None or ev is None:
                continue
            if ev.skipped:
                continue

            safe_id = _safe_var_name(edge_id)

            # Should this edge's window obs be emitted per-edge, or will
            # the branch group Multinomial handle them?
            emit_window_binomial = edge_id not in bg_window_edges

            # Determine the base p variable for this edge
            if edge_id in bg_p_vars:
                # Branch group edge — p comes from the Dirichlet
                p_base_var = bg_p_vars[edge_id]
            else:
                # Solo edge — independent Beta prior
                alpha = ev.prob_prior.alpha
                beta_param = ev.prob_prior.beta
                p_base_var = None  # will be created below per observation type

            if ev.has_window and ev.has_cohort:
                if p_base_var is not None:
                    # Branch group edge — Dirichlet component is the base
                    p_base = p_base_var
                else:
                    # Solo edge
                    p_base = pm.Beta(f"p_base_{safe_id}", alpha=ev.prob_prior.alpha, beta=ev.prob_prior.beta)

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

                if edge_id not in edge_var_names:
                    edge_var_names[edge_id] = f"p_base_{safe_id}"

            elif ev.has_window:
                if p_base_var is not None:
                    p = p_base_var
                else:
                    p = pm.Beta(f"p_{safe_id}", alpha=ev.prob_prior.alpha, beta=ev.prob_prior.beta)
                    edge_var_names[edge_id] = f"p_{safe_id}"
                if emit_window_binomial:
                    _emit_window_likelihoods(safe_id, p, ev, diagnostics)

            elif ev.has_cohort:
                if p_base_var is not None:
                    p = p_base_var
                else:
                    p = pm.Beta(f"p_{safe_id}", alpha=ev.prob_prior.alpha, beta=ev.prob_prior.beta)
                    edge_var_names[edge_id] = f"p_{safe_id}"
                _emit_cohort_likelihoods(safe_id, p, ev, diagnostics)

            else:
                if p_base_var is None:
                    p = pm.Beta(f"p_{safe_id}", alpha=ev.prob_prior.alpha, beta=ev.prob_prior.beta)
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
# Dirichlet prior emission (Phase B)
# ---------------------------------------------------------------------------

def _emit_dirichlet_prior(
    bg,
    topology: TopologyAnalysis,
    evidence: BoundEvidence,
    bg_p_vars: dict[str, object],
    edge_var_names: dict[str, str],
    model,
    diagnostics: list[str],
) -> None:
    """Emit a Dirichlet prior for a branch group.

    For non-exhaustive groups: K siblings + 1 dropout component.
    For exhaustive groups: K siblings, no dropout.

    Each sibling's probability is a Deterministic slice of the Dirichlet
    draw, stored in bg_p_vars[edge_id] and edge_var_names[edge_id].

    The Dirichlet concentration vector is derived from each sibling's
    evidence-based prior (alpha, beta → concentration for that component).
    """
    import pymc as pm

    safe_group = _safe_var_name(bg.group_id)

    # Collect siblings with evidence (skip those without param files)
    sibling_edges = []
    for sib_id in bg.sibling_edge_ids:
        ev = evidence.edges.get(sib_id)
        if ev is None or ev.skipped:
            continue
        et = topology.edges.get(sib_id)
        if et is None:
            continue
        sibling_edges.append((sib_id, et, ev))

    if len(sibling_edges) < 2:
        # Not enough siblings — fall back to independent Betas (solo treatment)
        return

    # Build concentration vector from per-edge priors.
    # Each edge's Beta(α, β) implies a marginal mean of α/(α+β).
    # For the Dirichlet, we want the concentration to reflect both the
    # expected proportion and the confidence. We use the prior means
    # scaled by a shared concentration parameter κ.
    #
    # κ controls overall confidence. We derive it from the geometric
    # mean of the per-edge prior ESS (α+β), capped to avoid
    # over-concentration.
    import numpy as np

    prior_means = []
    prior_ess_values = []
    for sib_id, et, ev in sibling_edges:
        a = ev.prob_prior.alpha
        b = ev.prob_prior.beta
        prior_means.append(a / (a + b))
        prior_ess_values.append(a + b)

    # Estimate dropout from prior means (1 - Σ means)
    sum_means = sum(prior_means)
    if bg.is_exhaustive:
        # Normalise means to sum to 1
        if sum_means > 0:
            prior_means = [m / sum_means for m in prior_means]
        else:
            prior_means = [1.0 / len(prior_means)] * len(prior_means)
    else:
        # Add dropout component
        dropout_mean = max(1.0 - sum_means, 0.01)
        prior_means.append(dropout_mean)

    # Shared concentration: moderate κ that encodes prior proportions
    # without over-concentrating. The Dirichlet's job is the simplex
    # constraint + rough shape; the Multinomial likelihood provides the
    # real information. High κ creates funnel geometry with large-n data.
    # Use a modest κ that scales gently with the number of components.
    n_components = len(prior_means)
    kappa = max(float(n_components) * 2.0, 4.0)

    # Build Dirichlet concentration vector
    alpha_vec = [m * kappa for m in prior_means]

    # Floor each component at 0.5 to avoid degenerate Dirichlet
    alpha_vec = [max(a, 0.5) for a in alpha_vec]

    weights = pm.Dirichlet(f"weights_{safe_group}", a=alpha_vec)

    # Extract per-sibling components as named Deterministics
    for i, (sib_id, et, ev) in enumerate(sibling_edges):
        safe_id = _safe_var_name(sib_id)
        p_var = pm.Deterministic(f"p_{safe_id}", weights[i])
        bg_p_vars[sib_id] = p_var
        edge_var_names[sib_id] = f"p_{safe_id}"

    n_components = len(sibling_edges) + (0 if bg.is_exhaustive else 1)
    diagnostics.append(
        f"INFO: branch group {bg.group_id}: Dirichlet({n_components} components, "
        f"κ={kappa:.1f}, exhaustive={bg.is_exhaustive})"
    )


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

    Phase B: siblings are Dirichlet components (simplex-constrained).
    The Multinomial enforces shared-denominator mass conservation.
    Each sibling's p_window (or p if window-only) is a component.
    The dropout component comes from the Dirichlet (non-exhaustive) or
    is absent (exhaustive).

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
        diagnostics.append(
            f"WARN: branch group {bg.group_id}: "
            f"Σk={total_k} > n_A={shared_n}, skipping Multinomial"
        )
        return

    # Resolve the p variable for each sibling from the model
    sibling_p_vars = []
    for s in sibling_info:
        safe_id = _safe_var_name(s["edge_id"])
        # Try p_window first (hierarchical case), then p (Dirichlet/Beta case)
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

    p_stack = pt.stack(p_components)

    if bg.is_exhaustive:
        # Exhaustive: no dropout component. Normalise to sum to 1.
        p_full = p_stack / pt.sum(p_stack)
        k_full = np.array(k_observed, dtype=np.int64)
        # For exhaustive, shared_n must equal total_k
        effective_n = total_k
    else:
        # Non-exhaustive: dropout comes from the Dirichlet's last component
        # (structurally guaranteed to be 1 - Σ sibling components).
        # The Dirichlet already constrains Σ p_i + p_dropout = 1,
        # so dropout = 1 - Σ p_effective_siblings (adjusted for completeness).
        p_dropout = 1.0 - pt.sum(p_stack)
        p_dropout_safe = pt.maximum(p_dropout, 0.001)
        p_full = pt.concatenate([p_stack, pt.stack([p_dropout_safe])])
        dropout_k = shared_n - total_k
        k_full = np.array(k_observed + [dropout_k], dtype=np.int64)
        effective_n = shared_n

    safe_group = _safe_var_name(bg.group_id)
    pm.Multinomial(
        f"obs_bg_{safe_group}",
        n=effective_n,
        p=p_full,
        observed=k_full,
    )

    diagnostics.append(
        f"INFO: branch group {bg.group_id}: Multinomial emitted, "
        f"{len(sibling_info)} siblings, n_A={effective_n}, Σk={total_k}, "
        f"exhaustive={bg.is_exhaustive}"
    )


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _safe_var_name(edge_id: str) -> str:
    """Convert edge UUID to a safe PyMC variable name."""
    return edge_id.replace("-", "_")
