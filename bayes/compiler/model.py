"""
Model builder: TopologyAnalysis + BoundEvidence → pm.Model.

Model structure:
  - Graph-level σ_temporal (learned temporal volatility)
  - Per-edge independent onset priors (no graph-level sharing)
  - Per-edge κ (overdispersion concentration: BetaBinomial/DM)
  - Per-edge onset (latent, doc 18; or fixed when latent_onset=False)
  - Solo edges: p ~ Beta(α, β)
  - Branch groups: [p_1, ..., p_K, p_dropout] ~ Dirichlet(α_vec)
    - Exhaustive groups omit the dropout component
  - If window + cohort: p_base, p_window (tight), p_cohort (path-informed)
  - Solo edges: window obs → BetaBinomial(n, p·κ, (1-p)·κ)
  - Branch groups: window obs → DirichletMultinomial(n, κ·p_vec)
  - Trajectory obs → Dirichlet-Multinomial logp via pm.Potential
  - Daily cohort obs → BetaBinomial(n, p·κ, (1-p)·κ)

This is the only module that imports PyMC.
"""

from __future__ import annotations

from .types import (
    TopologyAnalysis,
    BoundEvidence,
    EdgeEvidence,
)


def build_model(topology: TopologyAnalysis, evidence: BoundEvidence,
                features: dict | None = None,
                phase2_frozen: dict | None = None):
    """Build a PyMC model from the topology and bound evidence.

    Returns (pm.Model, model_metadata_dict).

    features: optional dict of boolean feature flags for A/B testing:
        latent_latency:    if False, skip latent mu/sigma (Phase S behaviour)
        cohort_latency:    if False, skip cohort-level latency hierarchy
        overdispersion:    if False, use Binomial/Multinomial (no per-edge kappa)

    phase2_frozen: if provided, builds Phase 2 (cohort-only) model.
        Dict maps edge_id → {"p": float, "mu": float, "sigma": float,
        "onset": float}. Edge p values become constants (no free RV).
        Only cohort trajectories are emitted. Free parameters: kappa,
        cohort-level latency (drift from Phase 1 values).
    """
    import pymc as pm
    import pytensor.tensor as pt
    import numpy as np

    features = features or {}
    feat_latent_latency = features.get("latent_latency", True)
    feat_cohort_latency = features.get("cohort_latency", True)
    feat_overdispersion = features.get("overdispersion", True)
    feat_latent_onset = features.get("latent_onset", True)
    feat_window_only = features.get("window_only", False)
    feat_neutral_prior = features.get("neutral_prior", False)
    is_phase2 = phase2_frozen is not None

    diagnostics: list[str] = []
    phase_label = "Phase 2 (cohort, frozen p)" if is_phase2 else "Phase 1 (window)"
    diagnostics.append(f"phase: {phase_label}")
    diagnostics.append(f"features: latent_latency={feat_latent_latency}, "
                       f"cohort_latency={feat_cohort_latency}, "
                       f"overdispersion={feat_overdispersion}, "
                       f"latent_onset={feat_latent_onset}, "
                       f"window_only={feat_window_only}")
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
        # sigma_temporal removed — was only used for p_base/p_cohort
        # hierarchy which is removed in Phase 1 (journal 26-Mar-26).

        # --- Per-edge latent onset (independent priors) ---
        # Each edge gets its own onset prior from its histogram data.
        # No graph-level sharing — onset is a property of each specific
        # business process, not a graph-wide characteristic.
        onset_vars: dict[str, object] = {}
        if feat_latent_onset:
            for edge_id in topology.topo_order:
                et = topology.edges.get(edge_id)
                ev = evidence.edges.get(edge_id)
                if et is None or ev is None or ev.skipped:
                    continue
                if not et.has_latency or ev.latency_prior is None:
                    continue
                safe_id = _safe_var_name(edge_id)
                lp = ev.latency_prior

                if is_phase2:
                    # Phase 2: freeze onset from Phase 1.
                    frozen = phase2_frozen.get(edge_id, {})
                    onset_frozen = frozen.get("onset", max(lp.onset_delta_days, 0.0))
                    onset_var = pt.as_tensor_variable(np.float64(onset_frozen))
                    onset_vars[edge_id] = onset_var
                    diagnostics.append(
                        f"  onset: {edge_id[:8]}… {onset_frozen:.1f}d → frozen (Phase 1)"
                    )
                else:
                    # Independent onset prior per edge, informed by histogram.
                    onset_prior_val = max(lp.onset_delta_days, 0.0)
                    onset_sigma = max(lp.onset_uncertainty, 1.0)

                    eps_onset = pm.Normal(f"eps_onset_{safe_id}", mu=0, sigma=1)
                    onset_var = pm.Deterministic(
                        f"onset_{safe_id}",
                        pt.softplus(onset_prior_val + eps_onset * onset_sigma),
                    )

                    onset_vars[edge_id] = onset_var
                    diagnostics.append(
                        f"  onset: {edge_id[:8]}… histogram={lp.onset_delta_days:.1f}d "
                        f"(±{lp.onset_uncertainty:.1f}) → latent (independent)"
                    )

        # --- Branch group Dirichlet priors (Phase B) ---
        # Emit Dirichlet per branch group. Each sibling gets a component;
        # non-exhaustive groups get a phantom dropout component.
        bg_p_vars: dict[str, object] = {}  # edge_id → Dirichlet component variable

        for group_id, bg in topology.branch_groups.items():
            if is_phase2:
                # Phase 2: Dirichlet on drifted p_cohort for mass conservation.
                # Concentrations centered on Phase 1 frozen p values.
                # See doc 23 §2.2.
                safe_group = _safe_var_name(bg.group_id)
                sibling_edges = []
                concentrations = []
                for sib_id in bg.sibling_edge_ids:
                    ev_sib = evidence.edges.get(sib_id)
                    if ev_sib is None or ev_sib.skipped:
                        continue
                    frozen = phase2_frozen.get(sib_id, {})
                    p_frozen = frozen.get("p", 0.1)
                    sibling_edges.append(sib_id)
                    concentrations.append(p_frozen)

                if sibling_edges:
                    # kappa scales the Dirichlet concentrations. Must be
                    # large enough that min(α_i) > 2, otherwise the mode
                    # drifts toward 0 for low-p edges. See doc 23 §8.
                    min_p = min(concentrations)
                    kappa_dir = max(50.0, 5.0 / max(min_p, 0.01))
                    if not bg.is_exhaustive:
                        dropout_mean = max(1.0 - sum(concentrations), 0.01)
                        concentrations.append(dropout_mean)
                    conc_array = np.array(concentrations, dtype=np.float64) * kappa_dir

                    dir_var = pm.Dirichlet(f"dir_cohort_{safe_group}", a=conc_array)
                    for i, sib_id in enumerate(sibling_edges):
                        sib_safe = _safe_var_name(sib_id)
                        p_sib = pm.Deterministic(f"p_cohort_{sib_safe}", dir_var[i])
                        bg_p_vars[sib_id] = p_sib
                        edge_var_names[sib_id] = f"p_cohort_{sib_safe}"
            else:
                _emit_dirichlet_prior(
                    bg, topology, evidence, bg_p_vars, edge_var_names,
                    model, diagnostics, features=features,
                )

        # --- Per-edge latency variables (Phase D: latent latency) ---
        latency_vars: dict[str, tuple] = {}
        cohort_latency_vars: dict[str, tuple] = {}

        if not feat_latent_latency:
            diagnostics.append("  FEATURE OFF: latent_latency — using fixed priors")

        for edge_id in topology.topo_order:
            et = topology.edges.get(edge_id)
            ev = evidence.edges.get(edge_id)
            if et is None or ev is None or ev.skipped:
                continue
            if feat_latent_latency and ev.latency_prior is not None and ev.latency_prior.sigma > 0.01:
                safe_id = _safe_var_name(edge_id)

                if is_phase2:
                    # Phase 2: freeze edge-level latency from Phase 1.
                    frozen = phase2_frozen.get(edge_id, {})
                    mu_frozen = frozen.get("mu", ev.latency_prior.mu)
                    sigma_frozen = frozen.get("sigma", ev.latency_prior.sigma)
                    mu_var = pt.as_tensor_variable(np.float64(mu_frozen))
                    sigma_var = pt.as_tensor_variable(np.float64(max(sigma_frozen, 0.01)))
                    latency_vars[edge_id] = (mu_var, sigma_var)
                    diagnostics.append(
                        f"  latency: {edge_id[:8]}… mu={mu_frozen:.3f}, "
                        f"sigma={sigma_frozen:.3f} → frozen (Phase 1)"
                    )
                else:
                    mu_prior = ev.latency_prior.mu
                    sigma_prior = ev.latency_prior.sigma
                    # mu_base ~ Normal centred on prior, moderate uncertainty
                    mu_var = pm.Normal(
                        f"mu_lat_{safe_id}",
                        mu=mu_prior,
                        sigma=max(0.5, sigma_prior),
                    )
                    # sigma_base ~ Gamma with mode at observed dispersion.
                    # NOT HalfNormal (mode at 0 biases sigma toward zero,
                    # making the CDF too steep — see doc 6 §Latency model).
                    from .completeness import gamma_params_from_mode
                    gamma_a, gamma_b = gamma_params_from_mode(
                        max(sigma_prior, 0.1), spread=0.5,
                    )
                    sigma_var = pm.Gamma(
                        f"sigma_lat_{safe_id}",
                        alpha=gamma_a, beta=gamma_b,
                    )
                    latency_vars[edge_id] = (mu_var, sigma_var)
                    diagnostics.append(
                        f"  latency: {edge_id[:8]}… mu_prior={mu_prior:.3f}, "
                        f"sigma_prior={sigma_prior:.3f} → latent"
                    )



        # --- Cohort-level latency variables (Phase D step 2.5) ---
        if not feat_cohort_latency:
            diagnostics.append("  FEATURE OFF: cohort_latency — no cohort latency hierarchy")
        # Non-centred parameterisation: cohort latency = FW-composed
        # edge latency + deviation. This keeps the cohort data
        # constraining the edge-level latents (gradients flow through
        # the FW composition) while allowing path-informed divergence.
        # Mirrors the p_cohort = logit(p_base) + eps * tau pattern.
        for edge_id in topology.topo_order:
            if not feat_cohort_latency:
                break
            et = topology.edges.get(edge_id)
            ev = evidence.edges.get(edge_id)
            if et is None or ev is None or ev.skipped:
                continue
            if not ev.has_cohort:
                continue
            # Count latency edges on the path
            path_latency_count = sum(
                1 for eid in et.path_edge_ids
                if topology.edges.get(eid) is not None
                and topology.edges[eid].has_latency
            )
            if path_latency_count == 0:
                continue
            # Phase 1: only create cohort latency vars when path has 2+
            # latency edges (single-latency paths use edge latent vars).
            # Phase 2: always create — edge latency is frozen, so even
            # single-latency paths need free cohort latency to fit data.
            if not is_phase2 and path_latency_count < 2:
                continue

            safe_id = _safe_var_name(edge_id)
            path_sigma_ax = max(et.path_sigma_ax, 0.01)

            # FW-composed path latency from edge-level latents
            path_result = _resolve_path_latency(
                et.path_edge_ids, topology, latency_vars,
                onset_vars=onset_vars,
            )
            if path_result is None:
                continue

            onset_prior, mu_path_composed, sigma_path_composed = path_result

            # onset_cohort, mu_cohort, sigma_cohort: path-level latency
            # that can deviate from edge-level FW composition.
            #
            # Phase 1: tight non-centred around live edge latency (small tau).
            # Phase 2: wide priors centred on frozen values — the frozen
            # latency may be wrong, so the cohort data must be free to pull
            # these parameters to the correct values.
            if is_phase2:
                # Phase 2: wide independent priors centred on frozen values.
                onset_prior_val = float(onset_prior) if not hasattr(onset_prior, 'eval') else float(onset_prior.eval())
                onset_cohort = pm.HalfNormal(
                    f"onset_cohort_{safe_id}",
                    sigma=max(onset_prior_val, 2.0),
                )
                mu_prior_val = float(mu_path_composed) if not hasattr(mu_path_composed, 'eval') else float(mu_path_composed.eval())
                mu_cohort = pm.Normal(
                    f"mu_cohort_{safe_id}",
                    mu=mu_prior_val,
                    sigma=max(1.0, abs(mu_prior_val) * 0.5),
                )
                sigma_prior_val = float(sigma_path_composed) if not hasattr(sigma_path_composed, 'eval') else float(sigma_path_composed.eval())
                from .completeness import gamma_params_from_mode
                gamma_a, gamma_b = gamma_params_from_mode(
                    max(sigma_prior_val, 0.1), spread=1.0,
                )
                sigma_cohort = pm.Gamma(
                    f"sigma_cohort_{safe_id}",
                    alpha=gamma_a, beta=gamma_b,
                )
            else:
                # Phase 1: tight non-centred around live edge latency.
                if feat_latent_onset and hasattr(onset_prior, 'name'):
                    eps_onset_path = pm.Normal(f"eps_onset_path_{safe_id}", mu=0, sigma=1)
                    onset_cohort = pm.Deterministic(
                        f"onset_cohort_{safe_id}",
                        pt.softplus(onset_prior + eps_onset_path * 1.0),
                    )
                else:
                    onset_prior_val = float(onset_prior) if not hasattr(onset_prior, 'name') else 5.0
                    onset_cohort = pm.HalfNormal(
                        f"onset_cohort_{safe_id}",
                        sigma=max(onset_prior_val, 1.0),
                    )

                tau_mu_lat = max(path_sigma_ax * 0.5, 0.1)
                eps_mu_cohort = pm.Normal(f"eps_mu_cohort_{safe_id}", mu=0, sigma=1)
                mu_cohort = pm.Deterministic(
                    f"mu_cohort_{safe_id}",
                    mu_path_composed + eps_mu_cohort * tau_mu_lat,
                )

                tau_sigma_lat = 0.1
                eps_sigma_cohort = pm.Normal(f"eps_sigma_cohort_{safe_id}", mu=0, sigma=1)
                sigma_cohort = pm.Deterministic(
                    f"sigma_cohort_{safe_id}",
                    pt.maximum(sigma_path_composed + eps_sigma_cohort * tau_sigma_lat, 0.01),
                )

            cohort_latency_vars[edge_id] = (onset_cohort, mu_cohort, sigma_cohort)
            if is_phase2:
                diagnostics.append(
                    f"  cohort_latency: {edge_id[:8]}… "
                    f"wide priors (Phase 2), latent_onset=independent"
                )
            else:
                diagnostics.append(
                    f"  cohort_latency: {edge_id[:8]}… "
                    f"mu_path_prior=FW-composed, tau_mu={tau_mu_lat:.3f}, "
                    f"latent_onset={'independent' if feat_latent_onset else 'hardcoded'}"
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
                if feat_neutral_prior:
                    alpha = 1.0
                    beta_param = 1.0
                else:
                    alpha = ev.prob_prior.alpha
                    beta_param = ev.prob_prior.beta
                p_base_var = None  # will be created below per observation type

            # Per-edge overdispersion concentration κ.
            # BetaBinomial / Dirichlet-Multinomial: large κ → Binomial,
            # small κ → heavy overdispersion. Each edge learns its own
            # level from its trajectory data.
            edge_kappa = pm.Gamma(f"kappa_{safe_id}", alpha=3, beta=0.1) if feat_overdispersion else None

            if ev.has_window and ev.has_cohort:
                if is_phase2:
                    # Phase 2: cohort trajectories only, p derived from
                    # Phase 1 with drift. See doc 23 §2.2.
                    if edge_id in bg_p_vars:
                        # Branch group edge — p_cohort from Dirichlet
                        p = bg_p_vars[edge_id]
                    else:
                        # Solo edge — per-edge drift from frozen Phase 1 p
                        frozen = phase2_frozen.get(edge_id, {})
                        p_frozen_val = frozen.get("p", ev.prob_prior.alpha / (ev.prob_prior.alpha + ev.prob_prior.beta))
                        logit_p_frozen = np.log(p_frozen_val / (1.0 - p_frozen_val))

                        tau_drift = max(et.path_sigma_ax, 0.1) if hasattr(et, 'path_sigma_ax') else 0.1
                        eps_drift = pm.Normal(f"eps_drift_{safe_id}", mu=0, sigma=1)
                        p = pm.Deterministic(
                            f"p_cohort_{safe_id}",
                            pm.math.sigmoid(logit_p_frozen + eps_drift * tau_drift),
                        )
                        edge_var_names[edge_id] = f"p_cohort_{safe_id}"

                    # Emit cohort trajectories only (skip window).
                    # p_window_var=None signals Phase 2 → skip window trajs.
                    _emit_cohort_likelihoods(safe_id, p, ev, diagnostics,
                                            topology, edge_var_names, model,
                                            latency_vars=latency_vars,
                                            p_window_var=None,
                                            cohort_latency_vars=cohort_latency_vars,
                                            kappa=edge_kappa,
                                            onset_vars=onset_vars,
                                            skip_cohort_trajectories=False)
                else:
                    # Phase 1: single p per edge, window data only.
                    # No p_base/p_window/p_cohort hierarchy — cohort must
                    # not constrain edge p (journal 25-Mar-26).
                    if p_base_var is not None:
                        p = p_base_var
                    else:
                        p = pm.Beta(f"p_{safe_id}", alpha=alpha, beta=beta_param)

                    if emit_window_binomial:
                        _emit_window_likelihoods(safe_id, p, ev, diagnostics, kappa=edge_kappa)
                    if not feat_window_only:
                        _emit_cohort_likelihoods(safe_id, p, ev, diagnostics,
                                                topology, edge_var_names, model,
                                                latency_vars=latency_vars,
                                                p_window_var=p,
                                                cohort_latency_vars=cohort_latency_vars,
                                                kappa=edge_kappa,
                                                onset_vars=onset_vars,
                                                skip_cohort_trajectories=True)

                if edge_id not in edge_var_names:
                    edge_var_names[edge_id] = f"p_{safe_id}"

            elif ev.has_window:
                if p_base_var is not None:
                    p = p_base_var
                else:
                    p = pm.Beta(f"p_{safe_id}", alpha=alpha, beta=beta_param)
                    edge_var_names[edge_id] = f"p_{safe_id}"
                if emit_window_binomial:
                    _emit_window_likelihoods(safe_id, p, ev, diagnostics, kappa=edge_kappa)

            elif ev.has_cohort:
                if p_base_var is not None:
                    p = p_base_var
                else:
                    p = pm.Beta(f"p_{safe_id}", alpha=alpha, beta=beta_param)
                    edge_var_names[edge_id] = f"p_{safe_id}"
                if not feat_window_only:
                    _emit_cohort_likelihoods(safe_id, p, ev, diagnostics,
                                            topology, edge_var_names, model,
                                            latency_vars=latency_vars,
                                            cohort_latency_vars=cohort_latency_vars,
                                            kappa=edge_kappa,
                                            onset_vars=onset_vars)

            else:
                if p_base_var is None:
                    p = pm.Beta(f"p_{safe_id}", alpha=alpha, beta=beta_param)
                    edge_var_names[edge_id] = f"p_{safe_id}"

        # --- Branch group Multinomial likelihoods (window obs) ---
        # Phase 2 skips — window data must not constrain cohort p.
        if not is_phase2:
            for group_id, bg in topology.branch_groups.items():
                _emit_branch_group_multinomial(
                    bg, topology, evidence, edge_var_names, model, diagnostics,
                )

    metadata = {
        "edge_var_names": edge_var_names,
        "latent_latency_edges": set(latency_vars.keys()),
        "latent_onset_edges": set(onset_vars.keys()),
        "cohort_latency_edges": set(cohort_latency_vars.keys()),
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
    features: dict | None = None,
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
    feat_neutral = features.get("neutral_prior", False) if features else False
    for sib_id, et, ev in sibling_edges:
        if feat_neutral:
            a, b = 1.0, 1.0
        else:
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
      - It has window observations (either window_obs or window trajectories)
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
            if not ev.has_window:
                continue
            # Check both old path (window_obs) and trajectory path
            n_from_obs = sum(w.n for w in ev.window_obs)
            n_from_traj = sum(
                t.n for c in ev.cohort_obs for t in c.trajectories
                if t.obs_type == "window"
            )
            if n_from_obs > 0 or n_from_traj > 0:
                siblings_with_window.append(sib_id)

        if len(siblings_with_window) < 2:
            continue

        # Check count consistency using the best available n
        def _sibling_n_k(sid):
            ev = evidence.edges[sid]
            n_obs = sum(w.n for w in ev.window_obs)
            k_obs = sum(w.k for w in ev.window_obs)
            if n_obs > 0:
                return n_obs, k_obs
            # Trajectory path: sum across window trajectory days
            n_traj = sum(
                t.n for c in ev.cohort_obs for t in c.trajectories
                if t.obs_type == "window"
            )
            k_traj = sum(
                t.cumulative_y[-1] if t.cumulative_y else 0
                for c in ev.cohort_obs for t in c.trajectories
                if t.obs_type == "window"
            )
            return n_traj, k_traj

        shared_n = max(_sibling_n_k(sid)[0] for sid in siblings_with_window)
        total_k = sum(_sibling_n_k(sid)[1] for sid in siblings_with_window)

        if total_k > shared_n:
            diagnostics.append(
                f"WARN: branch group {group_id}: "
                f"Σk={total_k} > n_A={shared_n}, falling back to per-edge Potentials"
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
    kappa=None,
) -> None:
    """Emit BetaBinomial likelihoods for window observations (solo edges only).

    BetaBinomial(n, α=p·κ, β=(1-p)·κ) generalises Binomial to allow
    overdispersion (day-to-day rate variation beyond Binomial noise).
    """
    import pymc as pm

    for i, w_obs in enumerate(ev.window_obs):
        if w_obs.n <= 0:
            continue
        suffix = f"_{i}" if len(ev.window_obs) > 1 else ""
        p_effective = pm.math.clip(p_var * w_obs.completeness, 0.001, 0.999)
        pm.BetaBinomial(
            f"obs_w_{safe_id}{suffix}",
            n=w_obs.n,
            alpha=p_effective * kappa,
            beta=(1.0 - p_effective) * kappa,
            observed=min(w_obs.k, w_obs.n),
        )


def _emit_cohort_likelihoods(
    safe_id: str,
    p_var,
    ev: EdgeEvidence,
    diagnostics: list[str],
    topology=None,
    edge_var_names: dict[str, str] | None = None,
    model=None,
    latency_vars: dict[str, tuple] | None = None,
    p_window_var=None,
    cohort_latency_vars: dict[str, tuple] | None = None,
    kappa=None,
    onset_vars: dict[str, object] | None = None,
    skip_cohort_trajectories: bool = False,
) -> None:
    """Emit cohort likelihoods via pm.Potential (vectorised per obs_type).

    Trajectory Cohort days (multiple retrieval ages) → vectorised
    Multinomial log-probability via pm.Potential (one per obs_type per
    edge). Single-retrieval days → pm.Binomial with completeness.

    p_var is the primary probability variable (p_cohort for hierarchical
    edges, p for solo edges). p_window_var, if provided, is used for
    window-type trajectories instead of p_var — ensuring window data
    constrains p_window (tight pooling) not p_cohort (path-informed).

    cohort_latency_vars: if provided, maps edge_id → (onset_cohort,
    mu_cohort, sigma_cohort) for cohort-level path latency. Cohort
    trajectories use these instead of FW-composed edge latency.

    Phase D: when latency_vars contains latent (mu, sigma) for this edge
    or upstream edges, CDFs are PyTensor expressions and the trajectory
    shape constrains latency jointly with probability.

    See doc 6 § "Efficient emission: pm.Potential vectorisation".
    """
    import pymc as pm
    import numpy as np
    import pytensor.tensor as pt
    from .completeness import shifted_lognormal_cdf

    # Collect all trajectories across CohortObservation objects,
    # grouped by obs_type. Each obs_type gets one Potential.
    window_trajs = []
    cohort_trajs = []
    all_daily = []

    # Determine if this edge has any latency. No-latency edges should
    # NOT go through DM trajectories — there is no maturation curve to
    # trace, so a trajectory of identical y values is informationally
    # equivalent to a single (n, k) observation. Route them to
    # BetaBinomial instead.  See journal 26-Mar-26.
    edge_has_latency = (
        (ev.latency_prior is not None and
         (ev.latency_prior.sigma > 0.01 or
          (ev.latency_prior.onset_delta_days or 0) > 0))
        or (latency_vars and ev.edge_id in (latency_vars or {}))
    )

    for c_obs in ev.cohort_obs:
        for traj in c_obs.trajectories:
            if len(traj.retrieval_ages) < 2 or traj.n <= 0:
                continue
            if not edge_has_latency and traj.obs_type == "window" and p_window_var is not None:
                # No-latency edge (Phase 1 only): convert trajectory to daily obs.
                # Use the final cumulative y as k (all conversions are
                # instantaneous, so the final y IS the total converted).
                from .types import CohortDailyObs
                all_daily.append(CohortDailyObs(
                    date=traj.date,
                    n=traj.n,
                    k=traj.cumulative_y[-1] if traj.cumulative_y else 0,
                    age_days=traj.retrieval_ages[-1] if traj.retrieval_ages else 1.0,
                    completeness=1.0,
                ))
                continue
            if traj.obs_type == "window":
                if p_window_var is not None:
                    window_trajs.append(traj)
                # else: Phase 2 — skip window trajectories entirely
            else:
                cohort_trajs.append(traj)
        # Only include WINDOW daily obs in the BetaBinomial when
        # p_window_var is set (Phase 1). Phase 2 skips window data.
        if c_obs.daily and "window" in c_obs.slice_dsl and p_window_var is not None:
            all_daily.extend(c_obs.daily)

    # --- Emit trajectory Potentials ---
    # See doc 6 § "pm.Potential vectorisation" and § "Phase D: latent latency".
    latency_vars = latency_vars or {}

    for obs_type, trajs in [("window", window_trajs), ("cohort", cohort_trajs)]:
        if not trajs:
            continue
        if skip_cohort_trajectories and obs_type == "cohort":
            continue

        # Resolve p expression and latency for this obs_type.
        #
        # For cohort observations downstream of a join node, the edge
        # may have multiple path_alternatives. In that case, we compute
        # a mixture: Σ_alt [p_alt × CDF_alt(t)] rather than a single
        # p × CDF. The mixture flag controls which DM likelihood path
        # is used below.
        is_mixture = False  # set True for join-downstream cohort
        mixture_components = []  # list of (p_alt, onset_alt, mu_alt, sigma_alt)

        if obs_type == "window":
            p_expr = p_window_var if p_window_var is not None else p_var
        else:
            # Check for join-node mixture (multiple path alternatives)
            et_topo = topology.edges.get(ev.edge_id) if topology else None
            path_alts = et_topo.path_alternatives if et_topo else []

            if len(path_alts) > 1:
                # Join-downstream edge: build mixture components.
                # Each alternative is a complete path from anchor to
                # this edge's target. p_alt = product of p's along
                # the path. CDF_alt = FW-composed latency along the path.
                # stop_p_gradient: cohort DM constrains latency, not p
                # (journal 25-Mar-26: edge.p → path.p is one-way).
                onset_vars = onset_vars or {}
                for alt_path in path_alts:
                    p_alt = _resolve_path_probability(
                        alt_path, ev.edge_id, p_var,
                        topology, edge_var_names, model,
                        # Phase 1: stop gradient (cohort skipped anyway).
                        # Phase 2: gradient flows freely to p_cohort.
                        stop_p_gradient=(p_window_var is not None),
                    )
                    path_result = _resolve_path_latency(
                        alt_path, topology, latency_vars,
                        onset_vars=onset_vars,
                    )
                    if path_result is not None:
                        onset_alt, mu_alt, sigma_alt = path_result
                        mixture_components.append((p_alt, onset_alt, mu_alt, sigma_alt))
                    else:
                        # Non-latency path: CDF = 1.0 at all ages
                        mixture_components.append((p_alt, 0.0, None, None))

                if len(mixture_components) >= 2:
                    is_mixture = True
                    # p_expr not used for mixture — each component has its own p
                    p_expr = None

            if not is_mixture:
                # Single path (no join, or single alternative)
                # Phase 1: stop_p_gradient=True (cohort skipped anyway).
                # Phase 2: gradient flows to p_cohort (doc 23 §2.2).
                p_expr = _resolve_path_probability(
                    trajs[0].path_edge_ids, ev.edge_id, p_var,
                    topology, edge_var_names, model,
                    stop_p_gradient=(p_window_var is not None),
                )

        # Resolve latency: latent (Phase D) or fixed (Phase S)?
        # For window: edge-level latency only.
        # For cohort: path-level composed from per-edge latents.
        # (For mixture cohort, latency is resolved per-component above.)
        has_latent_latency = False
        onset_vars = onset_vars or {}
        if is_mixture:
            # Mixture handles its own latency per component
            has_latent_latency = any(
                comp[2] is not None and hasattr(comp[2], 'name')
                for comp in mixture_components
            ) or any(
                comp[2] is not None
                for comp in mixture_components
            )
        elif obs_type == "window" and ev.edge_id in latency_vars:
            has_latent_latency = True
            mu_var, sigma_var = latency_vars[ev.edge_id]
            # Phase D.O: use latent onset if available
            if ev.edge_id in onset_vars:
                onset = onset_vars[ev.edge_id]
            else:
                onset = ev.latency_prior.onset_delta_days if ev.latency_prior else 0.0
        elif obs_type == "cohort":
            # Phase D step 2.5: use cohort-level latency variables if
            # available (onset_cohort, mu_cohort, sigma_cohort). These
            # have the FW-composed edge latency as prior but are free to
            # deviate — the cohort trajectory data constrains all three.
            cohort_latency_vars = cohort_latency_vars or {}
            if ev.edge_id in cohort_latency_vars:
                has_latent_latency = True
                onset_var, mu_var, sigma_var = cohort_latency_vars[ev.edge_id]
                onset = onset_var  # latent — PyTensor variable
            else:
                # Fallback: FW-composed edge latency (Phase D step 2)
                path_ids = trajs[0].path_edge_ids if trajs else []
                path_result = _resolve_path_latency(
                    path_ids, topology, latency_vars,
                )
                if path_result is not None:
                    has_latent_latency = True
                    onset, mu_var, sigma_var = path_result

        if not has_latent_latency:
            # Phase S fallback: fixed CDFs
            if obs_type == "window":
                onset = ev.latency_prior.onset_delta_days if ev.latency_prior else 0.0
                mu_fixed = ev.latency_prior.mu if ev.latency_prior else 0.0
                sigma_fixed = ev.latency_prior.sigma if ev.latency_prior else 0.01
            else:
                et = topology.edges.get(ev.edge_id) if topology else None
                if et and hasattr(et, 'path_latency') and et.path_latency:
                    onset = et.path_latency.path_delta
                    mu_fixed = et.path_latency.path_mu
                    sigma_fixed = et.path_latency.path_sigma
                elif ev.latency_prior:
                    onset = ev.latency_prior.onset_delta_days
                    mu_fixed = ev.latency_prior.mu
                    sigma_fixed = ev.latency_prior.sigma
                else:
                    onset, mu_fixed, sigma_fixed = 0.0, 0.0, 0.01

        has_any_latency = (has_latent_latency or
                          (ev.latency_prior is not None and
                           (ev.latency_prior.sigma > 0.01 or
                            (ev.latency_prior.onset_delta_days or 0) > 0)))

        if has_latent_latency:
            # Phase D: CDFs are PyTensor expressions of latent (mu, sigma).
            #
            # Dirichlet-Multinomial logp per trajectory-day:
            #   Σ_i [logΓ(count_i + κ·prob_i) − logΓ(κ·prob_i)]
            #   + logΓ(κ) − logΓ(n + κ)
            #
            # For single-path edges:
            #   prob_i = p·cdf_coeff_i (intervals) or 1−p·CDF_final (remainder)
            #
            # For join-downstream edges (mixture):
            #   prob_i = Σ_alt [p_alt · cdf_coeff_alt_i]
            #   remainder = 1 − Σ_alt [p_alt · CDF_alt_final]
            #   Each alternative has its own p (product of edge p's along
            #   that path) and its own CDF (FW-composed latency along that
            #   path). Gradients flow to ALL path parameters through the sum.

            # Step 1: Flatten all ages into one array (numpy)
            all_ages_raw = []
            for traj in trajs:
                all_ages_raw.extend(traj.retrieval_ages)
            ages_raw_np = np.array(all_ages_raw, dtype=np.float64)
            ages_tensor = pt.as_tensor_variable(ages_raw_np)

            # Step 2: Compute CDF at all ages.
            # For mixture: compute one CDF per alternative and weight by p_alt.
            # For single-path: compute one CDF (existing behaviour).
            def _compute_cdf_at_ages(onset_val, mu_val, sigma_val):
                """Compute shifted lognormal CDF at all flattened ages."""
                onset_is_latent = hasattr(onset_val, 'name')
                if onset_is_latent:
                    age_minus_onset = ages_tensor - onset_val
                    effective_ages = pt.softplus(age_minus_onset)
                    log_ages = pt.log(pt.maximum(effective_ages, 1e-30))
                else:
                    effective_ages_np = np.maximum(ages_raw_np - float(onset_val), 1e-6)
                    log_ages = pt.log(pt.as_tensor_variable(effective_ages_np))
                z = (log_ages - mu_val) / (sigma_val * pt.sqrt(2.0))
                return 0.5 * pt.erfc(-z)

            if is_mixture:
                # Mixture CDF: Σ_alt [p_alt × CDF_alt(t)]
                # This is the "effective p×CDF" — already includes p weighting.
                p_cdf_sum = pt.zeros_like(ages_tensor)
                for p_alt, onset_alt, mu_alt, sigma_alt in mixture_components:
                    if mu_alt is not None:
                        cdf_alt = _compute_cdf_at_ages(onset_alt, mu_alt, sigma_alt)
                    else:
                        # Non-latency path: CDF = 1.0 at all ages
                        cdf_alt = pt.ones_like(ages_tensor)
                    p_cdf_sum = p_cdf_sum + p_alt * cdf_alt
                # p_cdf_sum shape: (N,) — weighted mixture of CDFs
            else:
                cdf_all = _compute_cdf_at_ages(onset, mu_var, sigma_var)

            # Step 3: Build index arrays and INTEGER counts (numpy)
            curr_indices = []
            prev_indices = []
            interval_counts = []    # unweighted integer counts
            interval_weights = []   # per-element recency weight
            remainder_indices = []
            remainder_counts_list = []
            remainder_weights = []
            n_per_traj = []

            age_offset = 0
            for traj in trajs:
                n_ages = len(traj.retrieval_ages)
                cum_y = traj.cumulative_y
                w = getattr(traj, 'recency_weight', 1.0)

                # First interval
                curr_indices.append(age_offset)
                prev_indices.append(-1)
                interval_counts.append(float(cum_y[0]))
                interval_weights.append(w)

                # Subsequent intervals
                for j in range(1, n_ages):
                    curr_indices.append(age_offset + j)
                    prev_indices.append(age_offset + j - 1)
                    interval_counts.append(float(max(0, cum_y[j] - cum_y[j - 1])))
                    interval_weights.append(w)

                # Remainder
                remainder_indices.append(age_offset + n_ages - 1)
                remainder_counts_list.append(float(max(0, traj.n - cum_y[-1])))
                remainder_weights.append(w)
                n_per_traj.append(float(traj.n))

                age_offset += n_ages

            # Step 4: Compute interval probabilities via advanced indexing
            curr_idx_np = np.array(curr_indices, dtype=np.int64)
            prev_idx_np = np.array(prev_indices, dtype=np.int64)
            counts_np = np.array(interval_counts, dtype=np.float64)
            weights_np = np.array(interval_weights, dtype=np.float64)
            prev_safe = np.where(prev_idx_np >= 0, prev_idx_np, 0)
            is_first = pt.as_tensor_variable((prev_idx_np < 0).astype(np.float64))

            if is_mixture:
                # Mixture: interval prob = Σ_alt [p_alt × ΔCDF_alt]
                # p_cdf_sum already has the weighted sum at each age point
                pcdf_curr = p_cdf_sum[curr_idx_np]
                pcdf_prev = p_cdf_sum[prev_safe]
                # interval_pcdf = p_cdf(t_i) - p_cdf(t_{i-1})
                interval_pcdf = pcdf_curr - pcdf_prev * (1.0 - is_first)
                interval_pcdf = _soft_floor(interval_pcdf)

                # α_i = κ · interval_pcdf  (p is already folded into p_cdf_sum)
                alpha_interval = kappa * interval_pcdf
            else:
                # Single path: interval prob = p × ΔCDF
                cdf_curr = cdf_all[curr_idx_np]
                cdf_prev = cdf_all[prev_safe]
                cdf_coeffs = cdf_curr - cdf_prev * (1.0 - is_first)
                cdf_coeffs = _soft_floor(cdf_coeffs)
                alpha_interval = kappa * p_expr * cdf_coeffs

            # Step 5: Dirichlet-Multinomial logp — interval terms
            alpha_interval = _soft_floor(alpha_interval)
            logp_intervals = pt.sum(
                weights_np * (pt.gammaln(counts_np + alpha_interval)
                              - pt.gammaln(alpha_interval))
            )

            # Step 6: DM logp — remainder terms
            #
            # The remainder alpha must absorb ALL non-event CDF mass,
            # including any zero-count intervals that were filtered out
            # by the evidence binder. By the DM aggregation property,
            # α_R = κ - Σ(kept interval alphas) per trajectory.
            # This ensures Σα = κ regardless of which bins were kept.
            rem_idx_np = np.array(remainder_indices, dtype=np.int64)
            rem_counts_np = np.array(remainder_counts_list, dtype=np.float64)
            rem_weights_np = np.array(remainder_weights, dtype=np.float64)

            if is_mixture:
                pcdf_finals = p_cdf_sum[rem_idx_np]
                alpha_remainder = kappa * (1.0 - pcdf_finals)
            else:
                cdf_finals = cdf_all[rem_idx_np]
                alpha_remainder = kappa * (1.0 - p_expr * cdf_finals)

            alpha_remainder = _soft_floor(alpha_remainder)
            logp_remainders = pt.sum(
                rem_weights_np * (pt.gammaln(rem_counts_np + alpha_remainder)
                                  - pt.gammaln(alpha_remainder))
            )

            # Step 7: DM logp — per-trajectory normalisation
            n_per_traj_np = np.array(n_per_traj, dtype=np.float64)
            traj_weights_np = np.array(
                [getattr(t, 'recency_weight', 1.0) for t in trajs],
                dtype=np.float64,
            )
            logp_norm = pt.sum(
                traj_weights_np * (pt.gammaln(kappa) - pt.gammaln(n_per_traj_np + kappa))
            )

            logp = logp_intervals + logp_remainders + logp_norm
            n_terms = len(trajs)

        else:
            # Phase S: fixed CDFs — Dirichlet-Multinomial with constant
            # CDF coefficients. Only κ and p flow through as PyTensor.
            interval_counts = []
            interval_alphas = []   # κ · p · cdf_coeff (p is PyTensor, rest constant)
            interval_weights = []
            remainder_counts = []
            remainder_cdf_finals = []
            remainder_weights = []
            n_per_traj = []

            for traj in trajs:
                cum_y = traj.cumulative_y
                w = getattr(traj, 'recency_weight', 1.0)

                if has_any_latency:
                    cdf_vals = [shifted_lognormal_cdf(age, onset, mu_fixed, sigma_fixed)
                                for age in traj.retrieval_ages]
                else:
                    cdf_vals = [1.0] * len(traj.retrieval_ages)

                # First interval
                interval_counts.append(float(cum_y[0]))
                interval_alphas.append(max(cdf_vals[0], 1e-15))
                interval_weights.append(w)

                # Subsequent intervals
                for j in range(1, len(cum_y)):
                    interval_counts.append(float(max(0, cum_y[j] - cum_y[j - 1])))
                    interval_alphas.append(max(cdf_vals[j] - cdf_vals[j - 1], 1e-15))
                    interval_weights.append(w)

                remainder_counts.append(float(max(0, traj.n - cum_y[-1])))
                remainder_cdf_finals.append(min(cdf_vals[-1], 1.0 - 1e-10))
                remainder_weights.append(w)
                n_per_traj.append(float(traj.n))

            counts_np = np.array(interval_counts, dtype=np.float64)
            coeffs_np = np.array(interval_alphas, dtype=np.float64)
            weights_np = np.array(interval_weights, dtype=np.float64)

            # α_interval = κ · p · cdf_coeff (cdf_coeff is constant)
            alpha_interval = kappa * p_expr * pt.as_tensor_variable(coeffs_np)
            alpha_interval = pt.maximum(alpha_interval, 1e-12)
            logp_intervals = pt.sum(
                weights_np * (pt.gammaln(counts_np + alpha_interval)
                              - pt.gammaln(alpha_interval))
            )

            rem_counts_np = np.array(remainder_counts, dtype=np.float64)
            rem_cdf_np = np.array(remainder_cdf_finals, dtype=np.float64)
            rem_weights_np = np.array(remainder_weights, dtype=np.float64)
            alpha_remainder = kappa * (1.0 - p_expr * pt.as_tensor_variable(rem_cdf_np))
            alpha_remainder = _soft_floor(alpha_remainder)
            logp_remainders = pt.sum(
                rem_weights_np * (pt.gammaln(rem_counts_np + alpha_remainder)
                                  - pt.gammaln(alpha_remainder))
            )

            n_per_traj_np = np.array(n_per_traj, dtype=np.float64)
            traj_weights_np = np.array(remainder_weights, dtype=np.float64)
            logp_norm = pt.sum(
                traj_weights_np * (pt.gammaln(kappa) - pt.gammaln(n_per_traj_np + kappa))
            )

            logp = logp_intervals + logp_remainders + logp_norm
            n_terms = len(trajs)

        pm.Potential(f"traj_{obs_type}_{safe_id}", logp)
        mixture_str = f", mixture={len(mixture_components)} paths" if is_mixture else ""
        diagnostics.append(
            f"  Potential traj_{obs_type}_{safe_id}: "
            f"{n_terms} Cohort days, latent_latency={has_latent_latency}, "
            f"p_type={'edge' if obs_type == 'window' else 'path'}{mixture_str}"
        )

    # --- Single-retrieval days (BetaBinomial p-anchor) ---
    # Daily BetaBinomials anchor p to the observed conversion rate,
    # preventing the p-latency tradeoff from drifting to degenerate
    # modes (p≈1, mu→∞). Without them the trajectory Potentials let
    # p and latency trade off freely.
    # Guard: skip when array is very small (≤3 days) — too few
    # points to anchor p, and small BetaBinomial arrays trigger a
    # PyTensor composite rewrite bug (bool→float64 on shape≤2).
    if all_daily and len(all_daily) > 3:
        n_arr = np.array([d.n for d in all_daily], dtype=np.int64)
        k_arr = np.array([min(d.k, d.n) for d in all_daily], dtype=np.int64)
        compl_arr = np.array([d.completeness for d in all_daily], dtype=np.float64)

        mask = n_arr > 0
        if mask.any():
            n_arr = n_arr[mask]
            k_arr = k_arr[mask]
            compl_arr = compl_arr[mask]

            p_effective = pm.math.clip(p_var * compl_arr, 0.001, 0.999)

            pm.BetaBinomial(
                f"obs_daily_{safe_id}",
                n=n_arr,
                alpha=p_effective * kappa,
                beta=(1.0 - p_effective) * kappa,
                observed=k_arr,
            )


def _resolve_path_latency(
    path_edge_ids: list[str],
    topology,
    latency_vars: dict[str, tuple],
    onset_vars: dict[str, object] | None = None,
) -> tuple | None:
    """Compose path-level latency from per-edge latents via FW chain.

    Returns (onset, mu_composed, sigma_composed) or None if no latency.
    Uses latent variables where available, fixed priors otherwise.

    onset_vars: if provided (Phase D.O), edge-level latent onset variables
    are summed instead of fixed onset_delta_days. This makes path_delta
    differentiable — NUTS gradients flow through to edge onset.
    """
    import pytensor.tensor as pt
    from .completeness import pt_fw_chain

    if not path_edge_ids or not topology:
        return None

    onset_vars = onset_vars or {}
    components = []
    onset = 0.0
    onset_is_latent = False
    has_any_latent = False

    for eid in path_edge_ids:
        et = topology.edges.get(eid)
        if et is None or not et.has_latency:
            continue
        # Onset: latent if available (Phase D.O), else fixed
        if eid in onset_vars:
            if not onset_is_latent:
                # First latent onset on path — convert accumulator to tensor
                onset = pt.as_tensor_variable(float(onset)) + onset_vars[eid]
            else:
                onset = onset + onset_vars[eid]
            onset_is_latent = True
        else:
            if onset_is_latent:
                onset = onset + et.onset_delta_days
            else:
                onset += et.onset_delta_days
        if eid in latency_vars:
            components.append(latency_vars[eid])
            has_any_latent = True
        else:
            components.append((et.mu_prior, et.sigma_prior))

    if not components or not has_any_latent:
        return None

    mu_composed, sigma_composed = pt_fw_chain(components)
    return onset, mu_composed, sigma_composed


def _resolve_path_probability(
    path_edge_ids: list[str],
    current_edge_id: str,
    current_p_var,
    topology,
    edge_var_names: dict[str, str] | None,
    model,
    stop_p_gradient: bool = False,
):
    """Compute p_path = product of p variables along the path.

    For the first edge from anchor, p_path = current_p_var.
    For downstream edges, p_path includes upstream p's.

    stop_p_gradient: if True, wrap only the UPSTREAM edges' product
        in disconnected_grad, leaving the current/terminal edge free
        to receive gradient. This means cohort DM constrains the
        terminal edge's p (conditional on upstream estimates) but
        cannot distort upstream edges. See journal 25-Mar-26 (cont.):
        the earlier version wrapped the ENTIRE product, which made
        cohort data unable to constrain ANY edge's p — causing deep
        funnel edges with sparse window data to be prior-dominated.
    """
    from pytensor.gradient import disconnected_grad

    if not path_edge_ids or not topology or not edge_var_names or not model:
        return current_p_var

    # Separate upstream edges from the current edge so we can apply
    # disconnected_grad only to the upstream product.
    upstream_product = None
    current_p = None

    for eid in path_edge_ids:
        if eid == current_edge_id:
            current_p = current_p_var
            continue

        var_name = edge_var_names.get(eid)
        if var_name is None:
            continue
        # Find the variable in the model.
        # For cohort path products (stop_p_gradient=True), prefer
        # p_cohort_ to avoid cross-wiring cohort DM gradient into
        # the window p variable. See journal 25-Mar-26.
        p_var = None
        safe_eid = _safe_var_name(eid)
        if stop_p_gradient:
            prefixes = ("p_cohort_", "p_base_", "p_")
        else:
            prefixes = ("p_window_", "p_base_", "p_")
        for prefix in prefixes:
            candidate = f"{prefix}{safe_eid}"
            for rv in model.deterministics + model.free_RVs:
                if rv.name == candidate:
                    p_var = rv
                    break
            if p_var is not None:
                break
        if p_var is None:
            continue

        if upstream_product is None:
            upstream_product = p_var
        else:
            upstream_product = upstream_product * p_var

    # Current edge must be in the path
    if current_p is None:
        current_p = current_p_var

    # Build the full product: disconnected upstream * live current
    if upstream_product is not None:
        if stop_p_gradient:
            upstream_product = disconnected_grad(upstream_product)
        return upstream_product * current_p
    else:
        # Current edge is the only edge in the path (first from anchor)
        return current_p


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

    # Collect siblings that have window data and a model variable.
    # Check both old path (window_obs) and trajectory path.
    sibling_info = []
    for sib_id in bg.sibling_edge_ids:
        ev = evidence.edges.get(sib_id)
        if ev is None or ev.skipped or not ev.has_window:
            continue
        var_name = edge_var_names.get(sib_id)
        if var_name is None:
            continue

        # Old path: window_obs
        total_k = sum(w.k for w in ev.window_obs)
        total_n = sum(w.n for w in ev.window_obs)
        avg_completeness = (
            sum(w.n * w.completeness for w in ev.window_obs) / total_n
            if total_n > 0 else 1.0
        )

        # Trajectory path: aggregate window trajectories
        if total_n == 0:
            window_trajs = [
                t for c in ev.cohort_obs for t in c.trajectories
                if t.obs_type == "window"
            ]
            if window_trajs:
                total_n = sum(t.n for t in window_trajs)
                total_k = sum(
                    t.cumulative_y[-1] if t.cumulative_y else 0
                    for t in window_trajs
                )
                avg_completeness = 1.0  # trajectory CDF handles completeness

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

    # Use the first sibling's κ for the branch group DM.
    # Siblings share a source node so share overdispersion characteristics.
    first_sib_id = sibling_info[0]["edge_id"]
    first_safe = _safe_var_name(first_sib_id)
    kappa_var = None
    kappa_name = f"kappa_{first_safe}"
    for rv in model.free_RVs:
        if rv.name == kappa_name:
            kappa_var = rv
            break

    if kappa_var is not None:
        pm.DirichletMultinomial(
            f"obs_bg_{safe_group}",
            n=effective_n,
            a=kappa_var * p_full,
            observed=k_full,
        )
    else:
        pm.Multinomial(
            f"obs_bg_{safe_group}",
            n=effective_n,
            p=p_full,
            observed=k_full,
        )

    diagnostics.append(
        f"INFO: branch group {bg.group_id}: DirichletMultinomial emitted, "
        f"{len(sibling_info)} siblings, n_A={effective_n}, Σk={total_k}, "
        f"exhaustive={bg.is_exhaustive}"
    )


# ---------------------------------------------------------------------------
# Numerical helpers
# ---------------------------------------------------------------------------

def _soft_floor(x, floor=1e-12, sharpness=1e6):
    """Smooth approximation to max(x, floor).

    Unlike pt.maximum or pt.clip, the gradient is never exactly zero —
    it approaches zero smoothly as x drops below the floor. This
    prevents dead-gradient regions that disrupt NUTS mass matrix
    adaptation. See doc 20 (trajectory compression briefing) §5.4.

    At sharpness=1e6, indistinguishable from the hard floor for
    values more than ~1e-5 above it. Standard practice in probabilistic
    programming (cf. TFP SoftClip bijector).
    """
    import pytensor.tensor as pt
    return floor + pt.softplus(sharpness * (x - floor)) / sharpness


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _safe_var_name(edge_id: str) -> str:
    """Convert edge UUID to a safe PyMC variable name."""
    return edge_id.replace("-", "_")


