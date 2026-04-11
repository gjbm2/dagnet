"""
Model builder: TopologyAnalysis + BoundEvidence → pm.Model.

PURPOSE
-------
This module is the statistical core of the Bayes compiler. It takes a
graph structure (which edges exist, how they branch and join) and
observed data (how many users converted along each edge, measured at
various points in time), and builds a probabilistic model that can be
"fitted" to learn the true underlying conversion rates and timing.

The model is expressed in PyMC, a probabilistic programming library.
PyMC uses MCMC sampling (specifically the NUTS algorithm) to explore
the space of plausible paramueter values given the data. The output is
a posterior distribution: not a single "answer" but a cloud of
plausible values for every parameter, capturing uncertainty.

This is the only module that imports PyMC.

GLOSSARY OF STATISTICAL TERMS
------------------------------
The code uses statistical shorthand throughout. Here is a plain-English
guide to the key terms:

  p (probability / conversion rate)
      The fraction of users who take a particular edge. E.g. if 100
      users see a signup page and 30 sign up, p ≈ 0.30.

  Beta(α, β)
      A probability distribution over values between 0 and 1 — perfect
      for modelling conversion rates. α and β encode prior belief:
      α = "pseudo-successes", β = "pseudo-failures". Higher values =
      more confident prior. Beta(1, 1) = "I have no idea" (uniform).

  Dirichlet(α_vec)
      The multi-way generalisation of Beta. Used when a user can take
      one of K mutually exclusive edges from the same node (a "branch
      group"). Produces K probabilities that sum to 1. Each α_i
      encodes prior belief about the i-th branch's share.

  onset (delay before any conversions can occur)
      Many business processes have a minimum waiting time. E.g. a
      subscription trial lasts 7 days — no one can convert before
      day 7. Onset is that minimum delay, in days. "Latent onset"
      means we let the model learn the true onset from data rather
      than fixing it.

  latency (the timing distribution of conversions)
      After onset, conversions don't all happen instantly — they
      spread out over time following a shifted lognormal distribution.
      Two parameters control the shape:
        mu (μ)    — log-scale centre. exp(μ) ≈ median delay after onset.
        sigma (σ) — log-scale spread. Larger σ = more spread out.
      "Latent latency" means we let the model learn μ and σ from data.

  CDF (cumulative distribution function) / completeness
      CDF(t) = the fraction of eventual conversions that have happened
      by time t. At t = onset, CDF = 0. As t → ∞, CDF → 1.
      "Completeness" is CDF evaluated at the retrieval age — it tells
      us what fraction of conversions we expect to have observed so far.

  Fenton-Wilkinson (FW) composition
      When a user must traverse multiple edges in sequence (a path),
      the total delay is the sum of individual delays. The FW method
      approximates the sum of lognormal delays as a single lognormal,
      giving us (μ_path, σ_path) for the whole path.

  κ (kappa / overdispersion concentration)
      Real data is "noisier" than a simple coin-flip model predicts —
      conversion rates vary day-to-day. κ controls how much extra
      noise to allow. Higher κ = less overdispersion (closer to
      idealized coin flips). Used in BetaBinomial and
      DirichletMultinomial likelihoods.

  BetaBinomial(n, α, β)
      Like Binomial (n coin flips) but the coin's bias itself varies.
      Models day-to-day variation in conversion rate. α = p·κ,
      β = (1-p)·κ, so the mean is still p but with extra variance.

  DirichletMultinomial(n, α_vec)
      Multi-way BetaBinomial — for branch groups where users choose
      one of K options. Accounts for overdispersion across branches.

  Binomial(n, p)
      The simplest count model: n independent trials, each succeeding
      with probability p. Used where overdispersion is not needed
      (e.g. window observations, daily anchoring).

  pm.Potential(logp)
      A way to add a custom log-probability term to the model. Used
      for the product-of-conditional-Binomials likelihood (see below)
      because PyMC has no built-in distribution for that shape.

  Product-of-conditional-Binomials
      The key likelihood for trajectory data (a cohort observed at
      multiple ages). Instead of treating the whole trajectory as one
      observation, we decompose it into intervals:
        - At each age t_j, some new conversions d_j occurred
        - The "at-risk" population n_j is those who haven't converted yet
        - The conditional probability q_j = p × ΔF_j / (1 − p × F_{j−1})
          where ΔF_j is the CDF increment over the interval
        - Each interval is an independent Binomial(n_j, q_j)
      This decomposition lets the shape of the maturation curve
      (when conversions happen over time) constrain both p and the
      latency parameters simultaneously.

  Non-centred parameterisation
      A numerical trick for MCMC sampling. Instead of sampling
      x ~ Normal(μ, σ) directly (which creates a "funnel" that NUTS
      struggles with), we sample eps ~ Normal(0, 1) and compute
      x = μ + eps × σ. Mathematically identical, but much easier for
      the sampler to explore.

  softplus(x) = log(1 + exp(x))
      A smooth approximation to max(0, x). Used to enforce positivity
      (e.g. onset must be ≥ 0) without creating a hard boundary that
      would block MCMC gradients.

  disconnected_grad / stop_p_gradient
      Tells the MCMC sampler "don't let this data influence that
      parameter". Used to prevent cohort observations from distorting
      upstream edge probabilities — cohort data should constrain the
      terminal edge's p, not every edge on the path.

  Phase 1 vs Phase 2
      Phase 1 fits the model to "window" data (recent, high-quality
      aggregate observations). Phase 2 then uses Phase 1's learned
      values as priors and fits to "cohort" data (longitudinal
      per-cohort trajectories that are noisier but richer).

  posterior-as-prior
      Phase 2's approach: take Phase 1's learned distribution (the
      posterior) and use it directly as Phase 2's prior. This carries
      Phase 1's evidence forward without double-counting.

MODEL STRUCTURE SUMMARY
-----------------------
  1. Per-edge onset priors (independent, from histogram data)
  2. Per-edge probability priors:
     - Solo edges: p ~ Beta(α, β)
     - Branch groups: [p_1, ..., p_K, p_dropout] ~ Dirichlet(α_vec)
       (exhaustive groups omit the dropout component)
  3. Per-edge latency priors: μ ~ Normal, σ ~ Gamma
  4. Per-edge overdispersion: κ ~ Gamma
  5. Cohort-level latency (path-composed, can deviate from edge-level)
  6. Likelihoods:
     - Window observations → Binomial(n, p × completeness)
     - Branch group window → DirichletMultinomial(n, κ × p_vec)
     - Trajectory cohort → product-of-conditional-Binomials via Potential
     - Daily cohort → Binomial(n, p × completeness) or BetaBinomial
"""

from __future__ import annotations

from .types import (
    TopologyAnalysis,
    BoundEvidence,
    EdgeEvidence,
)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Statistical ---
# 95th percentile of the standard normal distribution.  Exact value:
# scipy.stats.norm.ppf(0.95).  Used to compute t95, the time by which
# 95% of conversions have occurred under a shifted lognormal latency
# model:  t95 = onset + exp(μ + Z_95 × σ).
Z_95 = 1.645

# Numerical floors ---
# Gradient-safe minimum values that prevent log(0), division by zero,
# or degenerate distributions in the PyTensor computation graph.
# Chosen to be small enough to never affect real results but large
# enough for float64 stability.  The exact values are not critical —
# anything in the same order-of-magnitude neighbourhood works.
LOG_ARG_FLOOR = 1e-30       # argument to pt.log()
CDF_INCREMENT_FLOOR = 1e-15  # ΔF (CDF change over a trajectory interval)
SURVIVAL_FLOOR = 1e-10       # 1 − p×F (fraction not yet converted)
EFFECTIVE_AGE_FLOOR = 1e-6   # age − onset on fixed-onset path (numpy)

# Softplus sharpness for onset boundary ---
# Standard softplus(x) = ln(1 + eˣ) leaks mass below onset: at x=-2.5
# softplus = 0.079, and with large sigma the CDF is non-trivially > 0.
# This creates a degenerate mode on the (onset, mu, sigma) ridge.
# Sharpened softplus: softplus(k·x) / k → same shape but leakage
# drops exponentially with k. At k=5, softplus(-2.5) → ~7e-7.
# See journal 30-Mar-26 "Softplus onset leakage".
#
# Raised from 5→8 on 2-Apr-26: sensitivity sweep showed k=8 has lower
# NUTS warmup failure rate on prod data (~0/9 vs ~1/3 at k=5). The
# onset-mu ridge causes stochastic convergence failures; higher k
# reduces but does not eliminate this. See journal 2-Apr-26.
SOFTPLUS_SHARPNESS = 8.0  # fallback; canonical default in settings.yaml & FE constants

# Probability clipping ---
# Bounds for effective probabilities passed to Binomial / BetaBinomial
# likelihoods and Multinomial dropout.  Prevents log(0) in the
# log-likelihood and avoids numerical issues at the boundaries.
# The exact values are a judgment call — 0.001 is safely below any
# realistic conversion rate at sample sizes of hundreds/thousands.
P_CLIP_LO = 0.001
P_CLIP_HI = 0.999

# Overdispersion (kappa) prior ---
# Per-edge κ controls how "noisy" daily conversion rates are beyond
# simple coin-flip variance.  Higher κ = less noise.
#
# LogNormal prior on κ (Normal on log κ):
#   log(κ) ~ Normal(LOG_KAPPA_MU, LOG_KAPPA_SIGMA)
#   Centre ≈ 30, 95% CI ≈ [2, 500].
# LogNormal has better gradient geometry than Gamma for NUTS and
# naturally covers orders of magnitude. Stan community consensus.
# See journal 30-Mar-26 "Dispersion estimation".
import math as _math
LOG_KAPPA_MU = _math.log(30.0)     # centre at κ ≈ 30
LOG_KAPPA_SIGMA = 1.5               # 95% CI: [2, 500]
# Legacy constants kept for reference / warm-start fallback
KAPPA_ALPHA = 3.0
KAPPA_BETA_WINDOW = 0.1
KAPPA_BETA_COHORT = 0.05

# Dirichlet / Beta concentration floor ---
# Minimum concentration parameter for Dirichlet and Beta priors.
# At 0.5 the distribution is slightly "spiky" (favours extremes);
# 1.0 would be uniform.  0.5 is a standard weakly-informative
# choice in Bayesian practice.  Must be > 0.
DIRICHLET_CONC_FLOOR = 0.5

# Latency sigma floor ---
# Minimum meaningful log-scale spread for a lognormal latency
# distribution.  Below this the lognormal is effectively a point
# mass — there is no timing distribution to learn.  Not arbitrary:
# 0.01 in log-scale ≈ 1% relative spread around the median.
SIGMA_FLOOR = 0.01

# Maturity floor ---
# Minimum CDF completeness for a daily observation to enter drift
# or dispersion estimation.  Below this threshold, dividing by F
# amplifies noise (at F=0.5, 2× amplification; at F=0.1, 10×).
# 0.9 means ≤1.11× amplification — effectively no noise injection.
# PROVISIONAL: to be surfaced as an FE setting via fit guidance.
MATURITY_FLOOR = 0.9

# Mu prior sigma floor ---
# Minimum uncertainty on the mu (latency centre) prior.  Ensures the
# sampler has enough room to explore even when the histogram-derived
# estimate looks confident.
MU_PRIOR_SIGMA_FLOOR = 0.5

# Fallback prior effective sample size ---
# When no Phase 1 posterior is available, we construct a weakly
# informative Beta prior: Beta(p × ESS, (1−p) × ESS).
# ARBITRARY: 20 pseudo-observations.  10 or 50 would change how
# quickly observed data overwhelms the prior.  20 is a conventional
# weak-prior choice.
FALLBACK_PRIOR_ESS = 20.0


def _ess_decay_scale(
    p_alpha: float, p_beta: float,
    elapsed_days: float,
    drift_sigma2: float,
) -> float:
    """Compute ESS decay scale for posterior-as-prior.

    scale = 1 / (1 + elapsed × σ²_drift / V₁)

    Where V₁ = p(1-p) / (α+β) is Phase 1 posterior variance.
    Returns a scale factor in (0, 1] to multiply α and β by.
    See doc 24 §3.1.
    """
    if drift_sigma2 <= 0 or elapsed_days <= 0:
        return 1.0
    ess = p_alpha + p_beta
    if ess <= 0:
        return 1.0
    p_mean = p_alpha / ess
    v_phase1 = p_mean * (1.0 - p_mean) / ess
    if v_phase1 <= 0:
        return 1.0
    return 1.0 / (1.0 + elapsed_days * drift_sigma2 / v_phase1)


def build_model(topology: TopologyAnalysis, evidence: BoundEvidence,
                features: dict | None = None,
                phase2_frozen: dict | None = None,
                settings: dict | None = None):
    """Build a PyMC model from the topology and bound evidence.

    This is the main entry point. It walks the graph in topological order
    (upstream edges first) and emits PyMC random variables and likelihoods
    for each edge. The result is a fully specified probabilistic model that
    MCMC can sample from.

    Returns (pm.Model, model_metadata_dict).

    Parameters
    ----------
    topology : TopologyAnalysis
        The graph structure: which edges exist, their latency properties,
        branch groups, join nodes, and topological ordering.

    evidence : BoundEvidence
        Observed data bound to each edge: sample sizes, conversion counts,
        cohort trajectories, and derived priors (from warm-start or analytics).

    features : dict, optional
        Boolean feature flags for A/B testing model variants:
          latent_latency : bool (default True)
              If True, μ and σ are free parameters the model learns.
              If False, they are fixed at their prior values (Phase S).
          cohort_latency : bool (default True)
              If True, create separate path-level latency variables for
              cohort observations (can deviate from edge-level estimates).
          overdispersion : bool (default True)
              If True, add per-edge κ for BetaBinomial/DirichletMultinomial.
              If False, use plain Binomial/Multinomial (no day-to-day noise).
          latent_onset : bool (default True)
              If True, onset is a learned parameter. If False, fixed at prior.
          window_only : bool (default False)
              If True, skip all cohort likelihoods (debug/ablation flag).
          neutral_prior : bool (default False)
              If True, use Beta(1,1) / uniform priors (ignore evidence priors).

    phase2_frozen : dict, optional
        If provided, builds a Phase 2 model. This dict maps
        edge_id → {"p": float, "mu": float, "sigma": float,
        "onset": float, "p_alpha": float, "p_beta": float, ...}.
        Phase 1's learned values become constants or tight priors;
        only cohort trajectories contribute new information.

    Build order
    -----------
    The model is constructed in this sequence (each section is marked
    with a "---" separator in the code below):

      1. Onset priors         — per-edge minimum delay before conversions
      2. Branch group priors  — Dirichlet for sibling edges
      3. Latency priors       — per-edge μ, σ (timing distribution shape)
      4. Cohort latency       — path-level latency for cohort observations
      5. Per-edge p & likelihoods — probability + observed data terms
      6. Branch group Multinomial — shared-denominator constraint for siblings
    """
    import pymc as pm
    import pytensor.tensor as pt
    import numpy as np

    features = features or {}
    _s = settings or {}
    feat_latent_latency = features.get("latent_latency", True)
    feat_cohort_latency = features.get("cohort_latency", True)
    feat_overdispersion = features.get("overdispersion", True)
    feat_latent_onset = features.get("latent_onset", True)
    feat_window_only = features.get("window_only", False)
    feat_neutral_prior = features.get("neutral_prior", False)
    feat_latency_dispersion = features.get("latency_dispersion", False)
    is_phase2 = phase2_frozen is not None

    # Settings-driven model constants (fall back to module-level defaults).
    # Keys match the UPPER_CASE convention used in settings.yaml and the FE.
    _log_kappa_mu_default = float(_s.get("BAYES_LOG_KAPPA_MU", _s.get("bayes_log_kappa_mu", LOG_KAPPA_MU)))
    _log_kappa_sigma_default = float(_s.get("BAYES_LOG_KAPPA_SIGMA", _s.get("bayes_log_kappa_sigma", LOG_KAPPA_SIGMA)))
    _fallback_prior_ess = float(_s.get("BAYES_FALLBACK_PRIOR_ESS", _s.get("bayes_fallback_prior_ess", FALLBACK_PRIOR_ESS)))
    _s_dirichlet_conc_floor = float(_s.get("BAYES_DIRICHLET_CONC_FLOOR", _s.get("bayes_dirichlet_conc_floor", DIRICHLET_CONC_FLOOR)))
    _sigma_floor = float(_s.get("BAYES_SIGMA_FLOOR", _s.get("bayes_sigma_floor", SIGMA_FLOOR)))
    _mu_prior_sigma_floor = float(_s.get("BAYES_MU_PRIOR_SIGMA_FLOOR", _s.get("bayes_mu_prior_sigma_floor", MU_PRIOR_SIGMA_FLOOR)))
    _maturity_floor = float(_s.get("BAYES_MATURITY_FLOOR", _s.get("bayes_maturity_floor", MATURITY_FLOOR)))
    _softplus_k = float(_s.get("BAYES_SOFTPLUS_SHARPNESS", _s.get("bayes_softplus_sharpness", SOFTPLUS_SHARPNESS)))

    diagnostics: list[str] = []
    phase_label = "Phase 2 (cohort, frozen p)" if is_phase2 else "Phase 1 (window)"
    diagnostics.append(f"phase: {phase_label}")
    diagnostics.append(f"features: latent_latency={feat_latent_latency}, "
                       f"cohort_latency={feat_cohort_latency}, "
                       f"overdispersion={feat_overdispersion}, "
                       f"latent_onset={feat_latent_onset}, "
                       f"window_only={feat_window_only}, "
                       f"latency_dispersion={feat_latency_dispersion}")
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

        # =============================================================
        # SECTION 1: PER-EDGE ONSET PRIORS
        # =============================================================
        # Onset = the minimum number of days before any conversion can
        # happen on this edge. Example: a 7-day free trial means
        # onset ≈ 7 — nobody can convert (purchase) before day 7.
        #
        # Each edge gets its own onset, learned independently from its
        # Amplitude histogram data. There is no graph-wide sharing
        # because onset is specific to each business process.
        #
        # The onset variable is constrained to be positive via
        # softplus (a smooth version of max(0, x)) so the sampler
        # never explores negative delays.
        #
        # Phase 2: onset is frozen at the Phase 1 posterior value —
        # cohort data does not re-learn onset.
        # =============================================================
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
                    # Phase 2: onset is a constant (not learned). We take
                    # the value from Phase 1's posterior and lock it in.
                    # Path-level onset is handled separately in Section 4.
                    frozen = phase2_frozen.get(edge_id, {})
                    onset_frozen = frozen.get("onset", max(lp.onset_delta_days, 0.0))
                    onset_var = pt.as_tensor_variable(np.float64(onset_frozen))
                    onset_vars[edge_id] = onset_var
                    diagnostics.append(
                        f"  onset: {edge_id[:8]}… {onset_frozen:.1f}d → frozen (Phase 1)"
                    )
                else:
                    # Phase 1: onset is a free parameter the model learns.
                    #
                    # Non-centred parameterisation (see glossary):
                    #   eps_onset ~ Normal(0, 1)          ← unit noise
                    #   onset = softplus(prior + eps × σ) ← shift & ensure ≥ 0
                    #
                    # onset_prior_val: best guess from Amplitude histogram
                    #   (the 1st-percentile lag — where conversions first appear)
                    # onset_sigma: how uncertain that guess is (in days)
                    onset_prior_val = max(lp.onset_delta_days, 0.0)
                    onset_sigma = max(lp.onset_uncertainty, 1.0)

                    eps_onset = pm.Normal(f"eps_onset_{safe_id}", mu=0, sigma=1)
                    onset_var = pm.Deterministic(
                        f"onset_{safe_id}",
                        pt.softplus(onset_prior_val + eps_onset * onset_sigma),
                    )

                    onset_vars[edge_id] = onset_var

                    # Per-retrieval onset observations from Amplitude histograms.
                    #
                    # We have multiple measurements of onset — one per retrieval
                    # date. Each measurement is the point where 1% of the lag
                    # histogram's mass has accumulated (the "left tail").
                    # These observed values are systematically above the true
                    # onset (because the CDF rises gradually, so the 1% point
                    # is always slightly right of zero), but sigma_obs absorbs
                    # that bias. More observations = tighter constraint on onset.
                    # See journal 26-Mar-26.
                    onset_obs = getattr(lp, 'onset_observations', None)
                    if onset_obs and len(onset_obs) >= 3:
                        onset_obs_np = np.array(onset_obs, dtype=np.float64)
                        raw_std = float(np.std(onset_obs_np))
                        # Floor: if observations have near-zero variance
                        # (e.g. all zero for onset=0 edges), use 1.0 day —
                        # histogram bin resolution, not false precision.
                        # Otherwise keep the original 0.01 floor.
                        sigma_obs = max(raw_std, 1.0 if raw_std < 1e-6 else 0.01)
                        onset_obs_mean = float(np.mean(onset_obs_np))
                        n_obs = len(onset_obs_np)

                        # Effective sample size corrected for autocorrelation.
                        #
                        # Onset genuinely varies over time — nearby dates
                        # have correlated values. Raw N overstates the
                        # independent information, giving √N precision
                        # that is over-confident.
                        #
                        # N_eff = N × (1 - ρ) / (1 + ρ) where ρ is the
                        # lag-1 autocorrelation of the onset series.
                        # σ_eff = σ_obs / √N_eff: the precision of the
                        # mean, corrected for temporal dependence.
                        #
                        # See journal 30-Mar-26 "onset obs over-precision".
                        if n_obs >= 4 and np.std(onset_obs_np) > 1e-9:
                            rho = float(np.corrcoef(onset_obs_np[:-1], onset_obs_np[1:])[0, 1])
                            rho = rho if np.isfinite(rho) else 0.0
                            rho = max(min(rho, 0.99), 0.0)  # clamp to [0, 0.99]
                        else:
                            rho = 0.0
                        n_eff = max(n_obs * (1 - rho) / (1 + rho), 1.0)
                        sigma_eff = sigma_obs / max(n_eff ** 0.5, 1.0)

                        pm.Normal(
                            f"onset_obs_{safe_id}",
                            mu=onset_var,
                            sigma=sigma_eff,
                            observed=np.float64(onset_obs_mean),
                        )
                        diagnostics.append(
                            f"  onset: {edge_id[:8]}… histogram={lp.onset_delta_days:.1f}d "
                            f"(±{lp.onset_uncertainty:.1f}) → latent (independent) "
                            f"+ {n_obs} Amplitude obs (mean={onset_obs_mean:.1f}d, "
                            f"σ_obs={sigma_obs:.1f}d, ρ={rho:.2f}, "
                            f"N_eff={n_eff:.1f}, σ_eff={sigma_eff:.2f}d)"
                        )
                    else:
                        diagnostics.append(
                            f"  onset: {edge_id[:8]}… histogram={lp.onset_delta_days:.1f}d "
                            f"(±{lp.onset_uncertainty:.1f}) → latent (independent)"
                        )

        # =============================================================
        # SECTION 2: BRANCH GROUP DIRICHLET PRIORS
        # =============================================================
        # When a node has multiple outgoing edges (e.g. a user can
        # choose Plan A, Plan B, or leave), those edges form a "branch
        # group". Their probabilities must sum to ≤ 1 (you can only
        # pick one option).
        #
        # A Dirichlet distribution enforces this constraint naturally:
        # it produces K numbers that sum to 1, each representing one
        # branch's share. For non-exhaustive groups (some users don't
        # take any branch), we add a "dropout" component to absorb the
        # remainder.
        #
        # Phase 2: the Dirichlet concentrations come directly from
        # Phase 1's posterior (posterior-as-prior approach). This
        # carries forward Phase 1's learned proportions as the starting
        # point for cohort fitting.
        # =============================================================
        bg_p_vars: dict[str, object] = {}  # edge_id → Dirichlet component variable

        for group_id, bg in topology.branch_groups.items():
            if is_phase2:
                # Phase 2: use Phase 1's learned distribution as Phase 2's
                # starting point (posterior-as-prior).
                #
                # Concretely: if Phase 1 learned that Branch A has p ≈ 0.3
                # with posterior Beta(α=30, β=70), we create a Dirichlet
                # with concentrations [30, 70] — this encodes the same
                # knowledge. The Phase 2 cohort data then updates from there.
                #
                # For a single sibling + dropout: Dir(α, β) is equivalent
                # to Beta(α, β). For multiple siblings: each gets its α_i,
                # and the dropout gets the remainder.
                # See doc 24 §3.1.
                safe_group = _safe_var_name(bg.group_id)
                sibling_edges = []
                dir_alphas = []  # Dirichlet concentration per sibling
                dir_beta_sum = 0.0  # for dropout component
                for sib_id in bg.sibling_edge_ids:
                    ev_sib = evidence.edges.get(sib_id)
                    if ev_sib is None or ev_sib.skipped:
                        continue
                    frozen = phase2_frozen.get(sib_id, {})
                    p_alpha = frozen.get("p_alpha")
                    if p_alpha is not None:
                        p_beta = frozen.get("p_beta", 1.0)
                        # ESS decay: scale α, β by elapsed time × drift rate
                        et_sib = topology.edges.get(sib_id)
                        # Elapsed time = median upstream path latency (a→x),
                        # NOT including this edge's own latency.
                        # For first edges: path has 1 edge → no upstream → elapsed=0.
                        elapsed = 0.0
                        if et_sib and len(et_sib.path_edge_ids) > 1:
                            # Upstream edges exist. Use the edge's onset sum
                            # + median of upstream latency as approximation.
                            upstream_onset = 0.0
                            for uid in et_sib.path_edge_ids[:-1]:
                                ut = topology.edges.get(uid)
                                if ut and ut.has_latency:
                                    uf = phase2_frozen.get(uid, {})
                                    upstream_onset += uf.get("onset", 0.0)
                                    upstream_onset += np.exp(uf.get("mu", 0.0))
                            elapsed = upstream_onset
                        drift_s2 = frozen.get("drift_sigma2", 0.0)
                        scale = _ess_decay_scale(p_alpha, p_beta, elapsed, drift_s2)
                        sibling_edges.append(sib_id)
                        dir_alphas.append(max(p_alpha * scale, _s_dirichlet_conc_floor))
                        dir_beta_sum = max(p_beta * scale, _s_dirichlet_conc_floor)
                    else:
                        # No Phase 1 posterior — use moderate prior
                        p_mean = frozen.get("p", 0.1)
                        sibling_edges.append(sib_id)
                        dir_alphas.append(max(p_mean * _fallback_prior_ess, _s_dirichlet_conc_floor))
                        dir_beta_sum = max((1 - p_mean) * _fallback_prior_ess, _s_dirichlet_conc_floor)

                if sibling_edges:
                    if not bg.is_exhaustive:
                        # Single main + dropout: Dir(α₁, β₁)
                        # Multi-sibling + dropout: Dir(α₁, α₂, ..., remainder)
                        if len(sibling_edges) == 1:
                            dir_alphas.append(dir_beta_sum)
                        else:
                            remainder = max(dir_beta_sum - sum(dir_alphas[1:]), _s_dirichlet_conc_floor)
                            dir_alphas.append(remainder)
                    conc_array = np.array(dir_alphas, dtype=np.float64)

                    dir_var = pm.Dirichlet(f"dir_cohort_{safe_group}", a=conc_array)
                    for i, sib_id in enumerate(sibling_edges):
                        sib_safe = _safe_var_name(sib_id)
                        p_sib = pm.Deterministic(f"p_cohort_{sib_safe}", dir_var[i])
                        bg_p_vars[sib_id] = p_sib
                        edge_var_names[sib_id] = f"p_cohort_{sib_safe}"
                    diagnostics.append(
                        f"  branch_group_cohort {safe_group}: "
                        f"Dir({', '.join(f'{a:.1f}' for a in conc_array)})"
                    )
            else:
                _emit_dirichlet_prior(
                    bg, topology, evidence, bg_p_vars, edge_var_names,
                    model, diagnostics, features=features, settings=_s,
                )

        # =============================================================
        # SECTION 2b: PER-SLICE BRANCH GROUP DIRICHLETS (Phase C, R2c)
        # =============================================================
        # For branch groups with context slices, each slice gets its own
        # Dirichlet-distributed weight vector drawn from the base weights
        # (Section 2) via a learned concentration parameter κ_slice.
        #
        # base_weights come from Section 2's Dirichlet (bg_p_vars).
        # κ_slice_bg ~ Gamma controls how tightly per-slice weights
        # cluster around the base. High κ = slices similar to base.
        #
        # bg_slice_p_vars[edge_id][ctx_key] = per-slice p variable
        bg_slice_p_vars: dict[str, dict[str, object]] = {}

        if not is_phase2:
            for group_id, bg in topology.branch_groups.items():
                # Check if any sibling in this group has slices
                any_slices = False
                group_slice_keys: set[str] = set()
                for sib_id in bg.sibling_edge_ids:
                    ev_sib = evidence.edges.get(sib_id)
                    if ev_sib and ev_sib.has_slices:
                        any_slices = True
                        for sg in ev_sib.slice_groups.values():
                            group_slice_keys.update(sg.slices.keys())

                if not any_slices:
                    continue

                safe_group = _safe_var_name(bg.group_id)

                # Collect base weights from Section 2's Dirichlet
                sibling_edges = []
                base_p_vars = []
                for sib_id in bg.sibling_edge_ids:
                    if sib_id in bg_p_vars:
                        sibling_edges.append(sib_id)
                        base_p_vars.append(bg_p_vars[sib_id])

                if len(sibling_edges) < 2:
                    continue

                # Stack base weights into a vector for Dirichlet parameterisation
                base_weight_vec = pt.stack(base_p_vars)
                if not bg.is_exhaustive:
                    # Add dropout: 1 - sum(siblings)
                    dropout = pt.maximum(1.0 - pt.sum(base_weight_vec), 0.01)
                    base_weight_vec = pt.concatenate([base_weight_vec, dropout.reshape((1,))])

                n_components = len(sibling_edges) + (0 if bg.is_exhaustive else 1)

                # Per-group concentration for slice Dirichlets
                # LogNormal prior: moderate concentration, learned from data
                _log_kappa_bg = pm.Normal(
                    f"log_kappa_slice_bg_{safe_group}",
                    mu=np.log(float(n_components) * 5.0),
                    sigma=1.0,
                )
                kappa_bg = pm.Deterministic(
                    f"kappa_slice_bg_{safe_group}",
                    pt.exp(_log_kappa_bg),
                )

                # Per-slice Dirichlet for each context key
                for ctx_key in sorted(group_slice_keys):
                    ctx_safe = _safe_var_name(ctx_key)
                    conc_vec = kappa_bg * base_weight_vec
                    # Floor concentrations to avoid degenerate Dirichlet
                    conc_vec = pt.maximum(conc_vec, _s_dirichlet_conc_floor)

                    slice_weights = pm.Dirichlet(
                        f"weights_slice_{safe_group}_{ctx_safe}",
                        a=conc_vec,
                    )

                    for i, sib_id in enumerate(sibling_edges):
                        sib_safe = _safe_var_name(sib_id)
                        p_slice_var = pm.Deterministic(
                            f"p_slice_{sib_safe}_{ctx_safe}",
                            slice_weights[i],
                        )
                        bg_slice_p_vars.setdefault(sib_id, {})[ctx_key] = p_slice_var

                    diagnostics.append(
                        f"  branch_group_slice: {safe_group} {ctx_key} → "
                        f"Dir({n_components}, κ_bg)"
                    )

        # =============================================================
        # SECTION 3: PER-EDGE LATENCY VARIABLES
        # =============================================================
        # Latency describes *when* conversions happen after onset.
        # The timing follows a shifted lognormal distribution:
        #
        #   delay = onset + LN(μ, σ)
        #
        # where LN(μ, σ) is a lognormal random variable:
        #   μ (mu) controls the centre: exp(μ) ≈ median delay after onset
        #   σ (sigma) controls the spread: larger σ = longer tail
        #
        # Example: μ = 2.0, σ = 0.8 means median delay ≈ 7.4 days after
        # onset, with a long right tail (some users take much longer).
        #
        # When latent_latency is enabled (the default), μ and σ are free
        # parameters that the model learns from the maturation curve
        # shape. When disabled, they are fixed at their prior values.
        #
        # Phase 2: μ and σ are frozen at Phase 1 posterior values.
        # Cohort-level latency (Section 4) is free to deviate.
        # =============================================================
        latency_vars: dict[str, tuple] = {}
        cohort_latency_vars: dict[str, tuple] = {}

        if not feat_latent_latency:
            diagnostics.append("  FEATURE OFF: latent_latency — using fixed priors")

        for edge_id in topology.topo_order:
            et = topology.edges.get(edge_id)
            ev = evidence.edges.get(edge_id)
            if et is None or ev is None or ev.skipped:
                continue
            if feat_latent_latency and ev.latency_prior is not None and ev.latency_prior.sigma > _sigma_floor:
                safe_id = _safe_var_name(edge_id)

                if is_phase2:
                    # Phase 2: 2.edge.latency is frozen (constants).
                    # 2.path.latency is free (cohort_latency_vars) with
                    # priors from FW-composed 1.edge posteriors.
                    # See journal 28-Mar-26 "approach 3".
                    frozen = phase2_frozen.get(edge_id, {})
                    mu_frozen = frozen.get("mu", ev.latency_prior.mu)
                    sigma_frozen = frozen.get("sigma", ev.latency_prior.sigma)
                    mu_var = pt.as_tensor_variable(np.float64(mu_frozen))
                    sigma_var = pt.as_tensor_variable(np.float64(max(sigma_frozen, _sigma_floor)))
                    latency_vars[edge_id] = (mu_var, sigma_var)
                    diagnostics.append(
                        f"  latency: {edge_id[:8]}… mu={mu_frozen:.3f}, "
                        f"sigma={sigma_frozen:.3f} → frozen (Phase 1)"
                    )
                else:
                    # Phase 1: μ and σ are free parameters the model learns.
                    mu_prior = ev.latency_prior.mu
                    sigma_prior = ev.latency_prior.sigma

                    mu_var = pm.Normal(
                        f"mu_lat_{safe_id}",
                        mu=mu_prior,
                        sigma=max(_mu_prior_sigma_floor, sigma_prior),
                    )
                    # σ ~ Gamma: must be positive, with mode at the observed
                    # dispersion. gamma_params_from_mode converts
                    # (mode, spread) → Gamma(α, β) such that the peak of
                    # the distribution sits at mode.
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

                    # t95 soft constraint: prevents unrealistic timing.
                    #
                    # t95 is the time by which 95% of conversions have
                    # Without this constraint, the sampler can inflate σ
                    # (making the tail very long) to explain low conversion
                    # counts — "conversions are coming, just very slowly".
                    # The t95 observation says "no, 95% of conversions
                    # happen within X days based on the histogram data".
                    # See journal 27-Mar-26 "Per-retrieval onset observations".
                    if et.t95_days is not None and edge_id in onset_vars:
                        t95_analytic = float(et.t95_days)
                        t95_model = onset_vars[edge_id] + pt.exp(mu_var + Z_95 * sigma_var)
                        sigma_t95 = max(t95_analytic * 0.2, 2.0)
                        pm.Normal(
                            f"t95_obs_{safe_id}",
                            mu=t95_model,
                            sigma=sigma_t95,
                            observed=np.float64(t95_analytic),
                        )
                        diagnostics.append(
                            f"  t95: {edge_id[:8]}… analytic={t95_analytic:.1f}d "
                            f"(σ_t95={sigma_t95:.1f}d) → soft constraint"
                        )

        # =============================================================
        # SECTION 4: COHORT-LEVEL LATENCY VARIABLES
        # =============================================================
        # When a user traverses a multi-edge path (e.g. A → B → C),
        # the total delay from A to C is the sum of individual edge
        # delays. Section 3 learned each edge's delay independently.
        # Here we create path-level latency variables for cohort
        # observations that can deviate from the edge-level sum.
        #
        # Why? Because edge-level estimates come from window data
        # (high quality, but edge-by-edge). Cohort data observes the
        # whole path at once — it might reveal that the composed
        # (summed) latency is slightly different from what the
        # individual edges suggest.
        #
        # Implementation: non-centred parameterisation (see glossary).
        # onset_cohort = softplus(onset_path + eps × τ)
        # mu_cohort    = mu_path + eps × τ_mu
        # sigma_cohort = max(sigma_path + eps × τ_sigma, 0.01)
        #
        # The τ values control how far cohort latency can drift from
        # the edge-composed values. Small τ = tight coupling; the
        # cohort data can nudge but not override the edge estimates.
        #
        # Only created when the path has ≥ 2 latency edges. Single-
        # latency paths have path CDF = edge CDF (no composition
        # needed, no room for divergence).
        #
        # Phase 2: wider priors (more room to drift) because the
        # frozen Phase 1 latency may be wrong — cohort data must be
        # free to correct it.
        # =============================================================
        if not feat_cohort_latency:
            diagnostics.append("  FEATURE OFF: cohort_latency — no cohort latency hierarchy")
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
            # Only create cohort latency vars when path has 2+ latency
            # edges. Single-latency paths (no upstream latency) have
            # 2.path.CDF = 2.edge.CDF (frozen), which is correct because
            # elapsed time a→x = 0 means no divergence is possible.
            # See doc 24 §6.4.
            if path_latency_count < 2:
                continue

            safe_id = _safe_var_name(edge_id)
            path_sigma_ax = max(et.path_sigma_ax, _sigma_floor)

            # FW-composed path latency from edge-level latents
            path_result = _resolve_path_latency(
                et.path_edge_ids, topology, latency_vars,
                onset_vars=onset_vars,
            )
            if path_result is None:
                continue

            onset_prior, mu_path_composed, sigma_path_composed = path_result

            # onset_cohort, mu_cohort, sigma_cohort: path-level latency
            # that can deviate from the edge-level composed values.
            #
            # Phase 1: tight coupling — small τ means cohort latency
            #   stays close to the edge-level sum. Cohort data can
            #   nudge the path latency but not override it.
            # Phase 2: wide priors — Phase 1's frozen latency may be
            #   wrong, so cohort data must be free to pull these
            #   parameters to better values.
            if is_phase2:
                # Phase 2: path-level latency with priors derived from
                # Phase 1 edge-level posteriors.
                #
                # The idea: Phase 1 learned each edge's latency. We compose
                # those into a path-level prediction, then let cohort data
                # refine it. The prior width for each path parameter comes
                # from Phase 1's posterior uncertainty — if Phase 1 was
                # confident about an edge, the path prior is tight there.
                #
                # Uncertainty propagation: since path onset = Σ edge onsets,
                # the path onset SD = √(Σ edge_onset_SD²) — uncertainties
                # add in quadrature (Pythagorean theorem for independent
                # errors). Same approach for μ and σ (approximate for FW
                # composition, but conservative — slightly overestimates
                # uncertainty, which is safe).
                # See journal 28-Mar-26 "approach 3".
                onset_prior_val = float(onset_prior) if not hasattr(onset_prior, 'eval') else float(onset_prior.eval())

                path_onset_sd = 0.0
                path_mu_sd = 0.0
                path_sigma_sd = 0.0
                for pid in et.path_edge_ids:
                    pf = phase2_frozen.get(pid, {})
                    path_onset_sd += pf.get("onset_sd", 0.5) ** 2
                    path_mu_sd += pf.get("mu_sd", 0.1) ** 2
                    path_sigma_sd += pf.get("sigma_sd", 0.05) ** 2
                path_onset_sd = max(path_onset_sd ** 0.5, 0.1)
                path_mu_sd = max(path_mu_sd ** 0.5, 0.02)
                path_sigma_sd = max(path_sigma_sd ** 0.5, _sigma_floor)

                # Cohort latency: always use Phase 1 composed values.
                #
                # Doc 26: Phase 2 receives NO priors from external sources
                # (param files). All priors derive from Phase 1 of the
                # current run. The previous cohort_latency_warm path
                # created a self-reinforcing onset drift loop by injecting
                # stale cohort posteriors that bypassed Phase 1 entirely.
                #
                # Centre: FW-composed Phase 1 edge posteriors
                # Width: quadrature-composed Phase 1 SDs (computed above)
                ws_onset = onset_prior_val
                ws_mu = float(mu_path_composed) if not hasattr(mu_path_composed, 'eval') else float(mu_path_composed.eval())
                ws_sigma = float(sigma_path_composed) if not hasattr(sigma_path_composed, 'eval') else float(sigma_path_composed.eval())
                diagnostics.append(
                    f"  cohort_latency: {edge_id[:8]}… "
                    f"phase1_composed (onset={ws_onset:.1f}, mu={ws_mu:.3f}, sigma={ws_sigma:.3f}, "
                    f"sd_onset={path_onset_sd:.2f}, sd_mu={path_mu_sd:.3f}, sd_sigma={path_sigma_sd:.3f})"
                )

                # onset_cohort: softplus(Normal) centred on Phase 1 composed value
                eps_onset_cohort = pm.Normal(f"eps_onset_cohort_{safe_id}", mu=0, sigma=1)
                onset_cohort = pm.Deterministic(
                    f"onset_cohort_{safe_id}",
                    pt.softplus(ws_onset + eps_onset_cohort * path_onset_sd),
                )
                # mu_cohort: Normal centred on FW-composed value
                mu_cohort = pm.Normal(
                    f"mu_cohort_{safe_id}",
                    mu=ws_mu,
                    sigma=path_mu_sd,
                )
                # sigma_cohort: Gamma with mode at FW-composed value
                from .completeness import gamma_params_from_mode
                gamma_a, gamma_b = gamma_params_from_mode(
                    max(ws_sigma, 0.1),
                    spread=max(path_sigma_sd / max(ws_sigma, 0.1), 0.05),
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
                    pt.maximum(sigma_path_composed + eps_sigma_cohort * tau_sigma_lat, _sigma_floor),
                )

            cohort_latency_vars[edge_id] = (onset_cohort, mu_cohort, sigma_cohort)

            # Path-level t95 soft constraint (same role as edge t95 in
            # Phase 1). Prevents onset_cohort from drifting up and
            # sigma_cohort from inflating — the combination produces
            # absurdly long path_t95 (>100d) that doesn't match the data.
            # The user-configured or stats-pass-derived path_t95 acts as
            # a prior on the path's 95th percentile timing.
            # See journal 29-Mar-26 "cohort onset drift".
            if et.path_t95_days is not None:
                path_t95_analytic = float(et.path_t95_days)
                path_t95_model = onset_cohort + pt.exp(mu_cohort + Z_95 * sigma_cohort)
                # Strength from settings (default 0.1 = moderately strong).
                # Window t95 uses 0.2 but also has onset obs anchoring the
                # left end. Path has no onset obs, so needs tighter t95.
                path_t95_strength = features.get("path_t95_prior_strength", 0.1)
                sigma_path_t95 = max(path_t95_analytic * path_t95_strength, 2.0)
                pm.Normal(
                    f"path_t95_obs_{safe_id}",
                    mu=path_t95_model,
                    sigma=sigma_path_t95,
                    observed=np.float64(path_t95_analytic),
                )
                diagnostics.append(
                    f"  path_t95: {edge_id[:8]}… analytic={path_t95_analytic:.1f}d "
                    f"(σ_path_t95={sigma_path_t95:.1f}d) → soft constraint"
                )

            if is_phase2:
                pass  # Phase 2 cohort latency already logged above
            else:
                diagnostics.append(
                    f"  cohort_latency: {edge_id[:8]}… "
                    f"mu_path_prior=FW-composed, tau_mu={tau_mu_lat:.3f}, "
                    f"latent_onset={'independent' if feat_latent_onset else 'hardcoded'}"
                )

        # =============================================================
        # SECTION 5: PER-EDGE PROBABILITY VARIABLES AND LIKELIHOODS
        # =============================================================
        # This is the main loop. For each edge, we:
        #
        #   1. Determine the probability variable (p):
        #      - Branch group edge → p comes from the Dirichlet (Section 2)
        #      - Solo edge → p ~ Beta(α, β) (independent prior)
        #
        #   2. Create an overdispersion parameter κ ~ Gamma if enabled
        #
        #   3. Emit likelihood terms that connect p to observed data:
        #      - Window observations → Binomial (how many converted?)
        #      - Cohort trajectories → product-of-conditional-Binomials
        #        (how did conversions accumulate over time?)
        #      - Daily cohort obs → Binomial or BetaBinomial
        #
        # The code handles four cases based on what data is available:
        #   - has_window AND has_cohort (the richest case)
        #   - has_window only
        #   - has_cohort only
        #   - neither (prior-only edge — no data constrains p)
        #
        # Phase 2: window observations are skipped (already used in
        # Phase 1). Only cohort data provides new information.
        # =============================================================
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
            if feat_neutral_prior:
                alpha = 1.0
                beta_param = 1.0
            else:
                alpha = ev.prob_prior.alpha
                beta_param = ev.prob_prior.beta

            if edge_id in bg_p_vars:
                # Branch group edge — p comes from the Dirichlet
                p_base_var = bg_p_vars[edge_id]
            else:
                # Solo edge — independent Beta prior (alpha/beta set above)
                p_base_var = None  # will be created below per observation type

            if feat_overdispersion:
                # LogNormal prior on κ: log(κ) ~ Normal(mu, sigma).
                # Warm-start centres the prior on the previous posterior;
                # otherwise use default hyperparameters.
                # See journal 30-Mar-26 "Dispersion estimation".
                if ev.kappa_warm is not None:
                    _log_kappa_mu = np.log(max(ev.kappa_warm, 1.0))
                    _log_kappa_sigma = 1.0  # tighter than default — warm-start
                else:
                    _log_kappa_mu = _log_kappa_mu_default
                    _log_kappa_sigma = _log_kappa_sigma_default
                _log_kappa = pm.Normal(f"log_kappa_{safe_id}",
                                       mu=_log_kappa_mu, sigma=_log_kappa_sigma)
                edge_kappa = pm.Deterministic(f"kappa_{safe_id}",
                                              pt.exp(_log_kappa))
            else:
                edge_kappa = None

            # --- Emit likelihoods: unified code path ---
            # Build emission list: one entry per slice, or one entry for
            # the aggregate. _emit_edge_likelihoods handles Cases A-D.
            _emissions = []  # [(safe_suffix, p_var, kappa_var, ev, lv, ov)]

            if ev.has_slices and not is_phase2:
                # Create p_base (hierarchy anchor)
                if p_base_var is not None:
                    p = p_base_var
                else:
                    p = pm.Beta(f"p_{safe_id}", alpha=alpha, beta=beta_param)
                edge_var_names[edge_id] = f"p_{safe_id}"

                # Per-edge p shrinkage (solo edges; branch groups use Dirichlet)
                _is_bg = edge_id in bg_slice_p_vars
                if not _is_bg:
                    tau_slice = pm.HalfNormal(f"tau_slice_{safe_id}", sigma=0.5)
                    logit_p_base = pt.log(p / (1.0 - p))

                # Per-slice latency hierarchy taus (shared across slices of this edge)
                if et.has_latency:
                    _lv_base = latency_vars.get(edge_id)
                    _ov_base = onset_vars.get(edge_id)
                    _mu_base = _lv_base[0] if _lv_base else pt.as_tensor_variable(np.float64(et.mu_prior))
                    _sigma_base = _lv_base[1] if _lv_base else pt.as_tensor_variable(np.float64(max(et.sigma_prior, 0.01)))
                    _onset_base = _ov_base if _ov_base is not None else pt.as_tensor_variable(np.float64(et.onset_delta_days))
                    tau_mu_slice = pm.HalfNormal(f"tau_mu_slice_{safe_id}", sigma=0.3)
                    tau_sigma_slice = pm.HalfNormal(f"tau_sigma_slice_{safe_id}", sigma=0.2)
                    tau_onset_slice = pm.HalfNormal(f"tau_onset_slice_{safe_id}", sigma=0.5)

                for dim_key, group in ev.slice_groups.items():
                    for ctx_key, s_obs in group.slices.items():
                        ctx_safe = _safe_var_name(ctx_key)
                        _sfx = f"{safe_id}__{ctx_safe}"

                        # Per-slice p
                        if _is_bg and ctx_key in bg_slice_p_vars.get(edge_id, {}):
                            p_s = bg_slice_p_vars[edge_id][ctx_key]
                        else:
                            _eps = pm.Normal(f"eps_slice_{safe_id}_{ctx_safe}", mu=0, sigma=1)
                            p_s = pm.Deterministic(
                                f"p_slice_{safe_id}_{ctx_safe}",
                                pm.math.invlogit(logit_p_base + _eps * tau_slice))

                        # Per-slice kappa
                        _lks = pm.Normal(f"log_kappa_slice_{safe_id}_{ctx_safe}",
                                         mu=LOG_KAPPA_MU, sigma=LOG_KAPPA_SIGMA)
                        ks = pm.Deterministic(f"kappa_slice_{safe_id}_{ctx_safe}", pt.exp(_lks))

                        # Per-slice latency
                        if et.has_latency:
                            _em = pm.Normal(f"eps_mu_slice_{safe_id}_{ctx_safe}", mu=0, sigma=1)
                            _es = pm.Normal(f"eps_sigma_slice_{safe_id}_{ctx_safe}", mu=0, sigma=1)
                            _eo = pm.Normal(f"eps_onset_slice_{safe_id}_{ctx_safe}", mu=0, sigma=1)
                            pm.Deterministic(f"mu_slice_{safe_id}_{ctx_safe}", _mu_base + _em * tau_mu_slice)
                            pm.Deterministic(f"sigma_slice_{safe_id}_{ctx_safe}",
                                             pt.maximum(_sigma_base + _es * tau_sigma_slice, 0.01))
                            pm.Deterministic(f"onset_slice_{safe_id}_{ctx_safe}",
                                             pt.maximum(_onset_base + _eo * tau_onset_slice, 0.0))
                            _lv = {edge_id: (model[f"mu_slice_{safe_id}_{ctx_safe}"],
                                             model[f"sigma_slice_{safe_id}_{ctx_safe}"])}
                            _ov = {edge_id: model[f"onset_slice_{safe_id}_{ctx_safe}"]}
                        else:
                            _lv = latency_vars
                            _ov = onset_vars

                        # Slice ev
                        s_ev = EdgeEvidence(
                            edge_id=ev.edge_id, param_id=ev.param_id, file_path=ev.file_path,
                            window_obs=list(s_obs.window_obs), cohort_obs=list(s_obs.cohort_obs),
                            has_window=s_obs.has_window, has_cohort=s_obs.has_cohort,
                            total_n=s_obs.total_n, latency_prior=ev.latency_prior,
                            kappa_warm=ev.kappa_warm, cohort_latency_warm=ev.cohort_latency_warm)
                        _emissions.append((_sfx, p_s, ks, s_ev, _lv, _ov))

                # If not all exhaustive, also emit aggregate
                _all_exhaustive = all(sg.is_exhaustive for sg in ev.slice_groups.values())
                if not _all_exhaustive:
                    _emissions.append((safe_id, p, edge_kappa, ev, latency_vars, onset_vars))
                else:
                    diagnostics.append(f"  slices: {edge_id[:8]}… exhaustive, aggregate suppressed")
            else:
                # No slices or Phase 2: single aggregate emission
                _emissions.append((safe_id, None, edge_kappa, ev, latency_vars, onset_vars))

            for _sfx, _p_ov, _kp, _ev, _lv, _ov in _emissions:
                _emit_edge_likelihoods(
                    _sfx, _p_ov, _kp, _ev, et, edge_id,
                    p_base_var=p_base_var if _p_ov is None else _p_ov,
                    alpha=alpha, beta_param=beta_param,
                    edge_var_names=edge_var_names,
                    emit_window_binomial=emit_window_binomial,
                    is_phase2=is_phase2, phase2_frozen=phase2_frozen,
                    bg_p_vars=bg_p_vars,
                    topology=topology, model=model,
                    latency_vars=_lv, onset_vars=_ov,
                    cohort_latency_vars=cohort_latency_vars,
                    diagnostics=diagnostics, features=features, settings=_s,
                    _softplus_k=_softplus_k,
                    _s_dirichlet_conc_floor=_s_dirichlet_conc_floor,
                    _fallback_prior_ess=_fallback_prior_ess,
                    feat_window_only=feat_window_only,
                )

        # =============================================================
        # SECTION 6: BRANCH GROUP MULTINOMIAL LIKELIHOODS
        # =============================================================
        # For branch groups (sibling edges from the same node), the
        # individual Binomials from Section 5 don't enforce the
        # constraint that sibling conversion counts must sum to ≤ n.
        # The Multinomial (or DirichletMultinomial) enforces this
        # "shared denominator" constraint: given n users at the parent
        # node, k₁ + k₂ + ... + k_dropout = n.
        #
        # Phase 2 skips this — window data was already used in Phase 1.
        if not is_phase2:
            for group_id, bg in topology.branch_groups.items():
                # Check if any sibling has slices
                _any_slices = any(
                    evidence.edges.get(sid) and evidence.edges[sid].slice_groups
                    for sid in bg.sibling_edge_ids
                )
                _all_exhaustive_bg = _any_slices and all(
                    all(sg.is_exhaustive for sg in evidence.edges[sid].slice_groups.values())
                    for sid in bg.sibling_edge_ids
                    if evidence.edges.get(sid) and evidence.edges[sid].slice_groups
                )

                if _any_slices and _all_exhaustive_bg:
                    # Per-slice Multinomials replace the aggregate
                    # Collect context keys from first edge that has slices
                    _ref_ev = next(
                        evidence.edges[sid] for sid in bg.sibling_edge_ids
                        if evidence.edges.get(sid) and evidence.edges[sid].slice_groups
                    )
                    for _dim_key, _sg in _ref_ev.slice_groups.items():
                        for _ctx_key in _sg.slices:
                            _emit_branch_group_multinomial(
                                bg, topology, evidence, edge_var_names, model,
                                diagnostics, slice_ctx_key=_ctx_key,
                                bg_slice_p_vars=bg_slice_p_vars,
                            )
                    diagnostics.append(
                        f"  bg {group_id[:8]}…: {len(_ref_ev.slice_groups)} dims, "
                        f"per-slice Multinomials emitted"
                    )
                else:
                    # Aggregate Multinomial (uncontexted or non-exhaustive)
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
    settings: dict | None = None,
) -> None:
    """Emit a Dirichlet prior for a branch group (Phase 1 only).

    A branch group is a set of sibling edges from the same source node.
    Example: from a "landing page" node, users can go to "signup",
    "pricing", or "leave" — those three edges form a branch group.

    The Dirichlet distribution generates K probabilities that sum to 1,
    naturally enforcing the constraint that a user can only take one path.

    For non-exhaustive groups: K siblings + 1 dropout component.
        The dropout absorbs users who don't take any sibling edge.
    For exhaustive groups: K siblings, no dropout (all users take one).

    The concentration vector α controls the prior shape:
      - α_i = prior_mean_i × κ, where κ is a shared concentration
      - Higher κ = more confident in the prior proportions
      - κ is derived from the number of components (modest, to avoid
        over-concentrating — the real information comes from the data)

    Each sibling's p is stored as a Deterministic slice of the Dirichlet
    draw: p_i = weights[i]. This lets the rest of the model reference
    each sibling's probability individually while maintaining the
    simplex constraint (probabilities sum to 1).
    """
    import pymc as pm

    _s = settings or {}
    _s_conc_floor = float(_s.get("BAYES_DIRICHLET_CONC_FLOOR", _s.get("bayes_dirichlet_conc_floor", DIRICHLET_CONC_FLOOR)))

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

    # Build the Dirichlet concentration vector from per-edge priors.
    #
    # Each edge has a Beta(α, β) prior on its conversion rate.
    # The mean of that Beta is α/(α+β) — the expected proportion.
    # Example: Beta(3, 7) → mean = 0.3 → we expect 30% of users
    # to take this branch.
    #
    # To build the Dirichlet, we scale each mean by a shared κ:
    #   α_dirichlet_i = mean_i × κ
    # κ controls how confident the prior is. We keep it modest
    # (scales gently with the number of branches) so the data
    # dominates. Over-concentrating creates "funnel" geometry
    # that makes MCMC sampling difficult.
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

    alpha_vec = [max(a, _s_conc_floor) for a in alpha_vec]

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
    """Decide which branch-group edges get a shared Multinomial likelihood
    instead of individual per-edge Binomials.

    Background: when sibling edges share a source node, the Multinomial
    enforces mass conservation — the number of users who take Branch A
    plus Branch B plus dropout must equal the total at the source.
    Individual Binomials don't enforce this constraint.

    An edge qualifies for the shared Multinomial if:
      - It's in a branch group (has siblings)
      - It has window observations (conversion counts)
      - At least one sibling also has window observations
      - Total sibling conversions (Σ k_i) don't exceed n (sanity check:
        you can't have more conversions across branches than users)

    Returns the set of edge IDs whose individual window Binomials should
    be suppressed (the shared Multinomial in Section 6 handles them).
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
    """Emit Binomial likelihoods for window observations (solo edges only).

    Window observations are simple aggregate counts: "out of n users who
    reached this node, k converted". This is a textbook Binomial setup:
      k ~ Binomial(n, p × completeness)

    The completeness factor adjusts for maturation: if we're observing
    the edge after only 10 days but 95% of conversions take up to 30 days,
    completeness ≈ 0.6 — we expect to see only 60% of eventual conversions.
    Without this adjustment, incomplete data would underestimate p.

    We use plain Binomial (not BetaBinomial) because BetaBinomial with
    small κ has a systematic upward bias on p: its gammaln terms with
    α = κ×p create monotonic upward pressure. Binomial avoids this.
    See journal 26-Mar-26.
    """
    import pymc as pm

    for i, w_obs in enumerate(ev.window_obs):
        if w_obs.n <= 0:
            continue
        suffix = f"_{i}" if len(ev.window_obs) > 1 else ""
        p_effective = pm.math.clip(p_var * w_obs.completeness, P_CLIP_LO, P_CLIP_HI)
        pm.Binomial(
            f"obs_w_{safe_id}{suffix}",
            n=w_obs.n,
            p=p_effective,
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
    p_cohort_vec=None,
    settings: dict | None = None,
    features: dict | None = None,
) -> None:
    """Emit cohort likelihoods — the most complex likelihood in the model.

    WHAT THIS DOES (plain English)
    ------------------------------
    Cohort data tracks groups of users over time. For each cohort (e.g.
    "users who arrived on 1-Mar"), we observe how many have converted at
    various ages (e.g. after 1 day, 7 days, 14 days, 30 days). This
    creates a "maturation curve" — conversions accumulate over time.

    The shape of this curve tells us TWO things simultaneously:
      1. The conversion rate (p) — what fraction will eventually convert
      2. The timing (onset, μ, σ) — when those conversions happen

    This function emits the likelihood terms that connect these parameters
    to the observed maturation curves.

    TWO TYPES OF COHORT DATA
    -------------------------
    1. Trajectories: a cohort observed at multiple ages → decomposed into
       intervals using the product-of-conditional-Binomials method (see
       glossary). This is the main workhorse — it constrains both p and
       latency simultaneously.

    2. Daily observations: a single (n, k) count per day → simple
       Binomial. Used to anchor p when trajectory data is sparse.

    KEY PARAMETERS
    ---------------
    p_var: the primary probability variable for this edge.
    p_window_var: if provided, used for "window"-type trajectories (which
        should constrain the window p, not the cohort p). Set to None in
        Phase 2 to signal "skip window trajectories entirely".
    cohort_latency_vars: path-level (onset, μ, σ) that can differ from
        edge-level latency — used for "cohort"-type trajectories.
    p_cohort_vec: if provided, per-trajectory p_i variables from the
        hierarchical Beta model (each cohort gets its own p).
    (kappa_p removed — unified into kappa, journal 30-Mar-26)

    See doc 6 § "Efficient emission: pm.Potential vectorisation".
    """
    import pymc as pm
    import numpy as np
    import pytensor.tensor as pt
    from .completeness import shifted_lognormal_cdf

    _s = settings or {}
    _sigma_floor = float(_s.get("BAYES_SIGMA_FLOOR", _s.get("bayes_sigma_floor", SIGMA_FLOOR)))
    _softplus_k = float(_s.get("BAYES_SOFTPLUS_SHARPNESS", _s.get("bayes_softplus_sharpness", SOFTPLUS_SHARPNESS)))

    # ---- STEP 1: Collect and route trajectories ----
    #
    # Trajectories come in two types:
    #   "window" — denominator is the from-node count (edge-level CDF)
    #   "cohort" — denominator grows as upstream conversions arrive (path-level CDF)
    #
    # We also collect "daily" observations: single-age (n, k) counts
    # that anchor p without the complexity of trajectory decomposition.
    window_trajs = []
    cohort_trajs = []
    all_daily = []

    # Check if this edge has meaningful latency (delay > 0). Edges with
    # no latency (e.g. instant redirects) have flat maturation curves —
    # every observation shows the same conversion count regardless of
    # age. There is no curve shape to learn from, so we convert these
    # trajectories into simple daily (n, k) observations instead.
    # See journal 26-Mar-26.
    edge_has_latency = (
        (ev.latency_prior is not None and
         (ev.latency_prior.sigma > _sigma_floor or
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
        # Phase 1: include WINDOW daily obs in BetaBinomial.
        # Phase 2: include COHORT daily obs ONLY for first-edge
        # (where anchor = from_node, so n = x and edge p = path p).
        # Downstream cohort daily obs have anchor denominators —
        # can't use per-edge BetaBinomial without path product.
        if c_obs.daily:
            if p_window_var is not None and "window" in c_obs.slice_dsl:
                all_daily.extend(c_obs.daily)
            elif p_window_var is None and "cohort" in c_obs.slice_dsl:
                # Phase 2: cohort daily obs for first-edge only.
                # First edge: n = x = a, so BetaBinomial with edge p.
                # Downstream: n is mixed (some x, some a) — can't use
                # BetaBinomial safely. Downstream edges are constrained
                # indirectly through path products in latency edge DMs.
                et_topo = topology.edges.get(ev.edge_id) if topology else None
                if et_topo and len(et_topo.path_edge_ids) <= 1:
                    all_daily.extend(c_obs.daily)

    # ---- STEP 2: Emit trajectory Potentials ----
    #
    # For each trajectory (a cohort observed at multiple ages), we
    # compute a log-probability using the product-of-conditional-
    # Binomials decomposition (see glossary). This is added to the
    # model as a pm.Potential — a custom log-probability term.
    #
    # The loop below handles "window" and "cohort" trajectories
    # separately because they use different p expressions and
    # different latency variables:
    #   window → edge-level p and edge-level CDF
    #   cohort → path-level p (product of upstream p's) and path CDF
    #
    # See doc 6 § "pm.Potential vectorisation" and § "Phase D: latent latency".
    latency_vars = latency_vars or {}

    for obs_type, trajs in [("window", window_trajs), ("cohort", cohort_trajs)]:
        if not trajs:
            continue
        if skip_cohort_trajectories and obs_type == "cohort":
            continue

        # ---- STEP 2a: Resolve the p expression for this obs_type ----
        #
        # For window trajectories: p = edge-level p (straightforward).
        # For cohort trajectories: p = product of p's along the path
        #   from anchor to this edge's target node.
        #
        # Special case — join nodes: if a user can reach this edge via
        # multiple paths (e.g. A→B→D or A→C→D), we compute a mixture:
        #   expected_conversions(t) = Σ_alt [p_alt × CDF_alt(t)]
        # where each alternative path has its own p and latency.
        is_mixture = False  # set True for join-downstream cohort
        mixture_components = []  # list of (p_alt, onset_alt, mu_alt, sigma_alt)
        _use_p_cohort_vec = False  # set True for hierarchical Beta window trajs

        # Phase 2 cohort: use the from-node count (x) as denominator
        # instead of the anchor count (a). This is important because
        # for deep edges, a >> y (anchor count is much larger than
        # conversions), which creates bias toward higher p. Using x
        # (the count at the immediately preceding node) avoids this.
        # See doc 23 §10.
        phase2_cohort_use_x = (p_window_var is None and obs_type == "cohort")

        if phase2_cohort_use_x:
            # Phase 2: edge p directly, x denominator.
            #
            # Join-node check: if this edge is downstream of a join
            # (multiple incident paths), we must build a mixture CDF
            # rather than picking one arbitrary path. The x-denominator
            # shortcut does not handle mixtures, so join-downstream
            # edges fall back to the standard mixture approach with
            # anchor denominator and path-product p.
            # See journal 28-Mar-26 "Phase 2 join-node CDF defect".
            et_topo = topology.edges.get(ev.edge_id) if topology else None
            path_alts = et_topo.path_alternatives if et_topo else []

            if len(path_alts) > 1:
                # Join-downstream: build mixture (same as non-Phase-2).
                onset_vars = onset_vars or {}
                for alt_path in path_alts:
                    p_alt = _resolve_path_probability(
                        alt_path, ev.edge_id, p_var,
                        topology, edge_var_names, model,
                        stop_p_gradient=False,  # Phase 2: gradient flows
                    )
                    path_result = _resolve_path_latency(
                        alt_path, topology, latency_vars,
                        onset_vars=onset_vars,
                    )
                    if path_result is not None:
                        onset_alt, mu_alt, sigma_alt = path_result
                        mixture_components.append((p_alt, onset_alt, mu_alt, sigma_alt))
                    else:
                        mixture_components.append((p_alt, 0.0, None, None))

                if len(mixture_components) >= 2:
                    is_mixture = True
                    p_expr = None
                    # Keep original trajs (a-denominator) for mixture

            if not is_mixture:
                # Non-join or collapsed join: x-denominator shortcut.
                p_expr = p_var
                rewritten_trajs = []
                for traj in trajs:
                    cx = getattr(traj, 'cumulative_x', None)
                    if cx and len(cx) > 0 and cx[-1] > 0:
                        # Replace n with x_final (from-node count)
                        import copy
                        t2 = copy.copy(traj)
                        t2.n = cx[-1]
                        rewritten_trajs.append(t2)
                    # else: skip trajectories without cumulative_x
                trajs = rewritten_trajs
        elif obs_type == "window":
            p_expr = p_window_var if p_window_var is not None else p_var
            # Hierarchical Beta: p_cohort_vec has per-trajectory p_i.
            # Build a mapping from interval index → trajectory index
            # so p_per_interval[k] = p_i[traj_of_interval_k].
            _use_p_cohort_vec = (p_cohort_vec is not None and obs_type == "window")
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

        # ---- STEP 2b: Resolve the latency (CDF shape) ----
        #
        # The CDF tells us what fraction of eventual conversions have
        # happened by age t. We need (onset, μ, σ) to compute it.
        #
        # Two modes:
        #   Latent (Phase D): onset, μ, σ are PyTensor variables that the
        #     sampler is learning. The CDF is a differentiable expression,
        #     so the trajectory shape constrains latency AND p jointly.
        #   Fixed (Phase S): onset, μ, σ are constants. Only p is learned.
        #
        # For window obs: use this edge's latency.
        # For cohort obs: use the path-composed latency (from Section 4
        #   or FW-composed from individual edges).
        # For mixture obs: each path component has its own latency
        #   (already resolved in Step 2a above).
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
                sigma_fixed = ev.latency_prior.sigma if ev.latency_prior else _sigma_floor
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
                    onset, mu_fixed, sigma_fixed = 0.0, 0.0, _sigma_floor

        has_any_latency = (has_latent_latency or
                          (ev.latency_prior is not None and
                           (ev.latency_prior.sigma > _sigma_floor or
                            (ev.latency_prior.onset_delta_days or 0) > 0)))

        # ---- STEP 2c: Compute the trajectory likelihood ----
        if has_latent_latency:
            # ============================================================
            # PRODUCT-OF-CONDITIONAL-BINOMIALS LIKELIHOOD
            # ============================================================
            # References: Gamel et al. 2000; Yu et al. 2004.
            # See journal 26-Mar-26.
            #
            # INTUITION (worked example):
            # Suppose 1000 users arrived, and we observe conversions at
            # ages 7d, 14d, 30d:
            #   age  7d: 50 conversions so far  (cum_y[0] = 50)
            #   age 14d: 120 conversions so far (cum_y[1] = 120)
            #   age 30d: 180 conversions so far (cum_y[2] = 180)
            #
            # We decompose into intervals:
            #   Interval 0 (0→7d):  d₀ = 50 new conversions
            #     At risk: n₀ = 1000 (everyone)
            #   Interval 1 (7→14d): d₁ = 70 new conversions
            #     At risk: n₁ = 950 (1000 − 50 already converted)
            #   Interval 2 (14→30d): d₂ = 60 new conversions
            #     At risk: n₂ = 880 (1000 − 120 already converted)
            #
            # For each interval, the conditional probability of converting
            # (given you haven't already) is:
            #   q_j = p × ΔF_j / (1 − p × F_{j−1})
            #
            # Where:
            #   p = the ultimate conversion rate (what we're learning)
            #   F_j = CDF(age_j) = fraction of eventual conversions by age_j
            #   ΔF_j = F_j − F_{j-1} = CDF increment over this interval
            #   p × F_{j-1} = fraction of original population already converted
            #   1 − p × F_{j-1} = fraction still "at risk"
            #
            # Each interval is an independent Binomial:
            #   d_j ~ Binomial(n_j, q_j)
            #   log L_j = d_j × log(q_j) + (n_j − d_j) × log(1 − q_j)
            #
            # The total log-likelihood is Σ log L_j across all intervals
            # across all trajectories, added to the model via pm.Potential.
            #
            # WHY THIS WORKS: the CDF shape constrains the latency
            # parameters (onset, μ, σ) while the overall level constrains
            # p. Both are learned simultaneously. No overdispersion κ is
            # needed — the Binomial has no artificial bias mechanism.
            # ============================================================

            # Flatten all retrieval ages into one array for vectorised CDF.
            all_ages_raw = []
            for traj in trajs:
                all_ages_raw.extend(traj.retrieval_ages)
            ages_raw_np = np.array(all_ages_raw, dtype=np.float64)
            ages_tensor = pt.as_tensor_variable(ages_raw_np)

            def _compute_cdf_at_ages(onset_val, mu_val, sigma_val):
                """Evaluate the shifted lognormal CDF at all retrieval ages.

                CDF(t) = P(delay ≤ t) where delay = onset + LN(μ, σ).

                Steps:
                  1. Subtract onset: effective_age = t − onset
                     (softplus if onset is latent, to keep gradients smooth)
                  2. Take log: log_age = log(effective_age)
                  3. Standardise: z = (log_age − μ) / (σ × √2)
                  4. Apply the complementary error function:
                     CDF = 0.5 × erfc(−z)

                This is mathematically equivalent to the standard lognormal
                CDF but expressed in terms of erfc (which PyTensor handles
                efficiently with stable gradients).
                """
                onset_is_latent = hasattr(onset_val, 'name')
                if onset_is_latent:
                    # Latent onset: sharpened softplus to handle ages
                    # near or below onset. Standard softplus leaks mass
                    # below onset, enabling a degenerate mode on the
                    # (onset, mu, sigma) ridge. Sharpened version
                    # collapses the ridge. See journal 30-Mar-26.
                    age_minus_onset = ages_tensor - onset_val
                    effective_ages = pt.softplus(_softplus_k * age_minus_onset) / _softplus_k
                    log_ages = pt.log(pt.maximum(effective_ages, LOG_ARG_FLOOR))
                else:
                    # Fixed onset: simple subtraction, floor at tiny positive
                    effective_ages_np = np.maximum(ages_raw_np - float(onset_val), EFFECTIVE_AGE_FLOOR)
                    log_ages = pt.log(pt.as_tensor_variable(effective_ages_np))
                z = (log_ages - mu_val) / (sigma_val * pt.sqrt(2.0))
                return 0.5 * pt.erfc(-z)

            if is_mixture:
                # MIXTURE PATH: join-node downstream edge.
                # Multiple paths reach this edge (e.g. A→B→D and A→C→D).
                # The population cumulative incidence is the weighted sum:
                #   p_cdf_sum(t) = Σ_alt p_alt × CDF_alt(t)
                # where p_alt is the path probability and CDF_alt is the
                # path-level maturation curve.
                p_cdf_sum = pt.zeros_like(ages_tensor)
                for p_alt, onset_alt, mu_alt, sigma_alt in mixture_components:
                    if mu_alt is not None:
                        cdf_alt = _compute_cdf_at_ages(onset_alt, mu_alt, sigma_alt)
                    else:
                        # No latency on this path → all conversions instant
                        cdf_alt = pt.ones_like(ages_tensor)
                    p_cdf_sum = p_cdf_sum + p_alt * cdf_alt

                # Decompose each trajectory into intervals.
                # For each interval j within a trajectory:
                #   d_j = new conversions in this interval
                #   n_j = population still at risk (not yet converted)
                #   w   = recency weight (newer cohorts count more)
                #   curr_indices/prev_indices = pointers into the CDF array
                interval_d, interval_n_at_risk, interval_weights = [], [], []
                curr_indices, prev_indices = [], []
                age_offset = 0
                for traj in trajs:
                    n_ages = len(traj.retrieval_ages)
                    cum_y = traj.cumulative_y
                    w = getattr(traj, 'recency_weight', 1.0)
                    for j in range(n_ages):
                        # d_j: new conversions = cum_y[j] − cum_y[j−1]
                        d_j = float(cum_y[0]) if j == 0 else float(max(0, cum_y[j] - cum_y[j-1]))
                        # n_j: at-risk = total − already converted
                        n_j = float(traj.n) if j == 0 else float(max(0, traj.n - cum_y[j-1]))
                        interval_d.append(d_j)
                        interval_n_at_risk.append(n_j)
                        interval_weights.append(w)
                        curr_indices.append(age_offset + j)
                        prev_indices.append(age_offset + j - 1 if j > 0 else -1)
                    age_offset += n_ages

                d_np = np.array(interval_d, dtype=np.float64)
                n_at_risk_np = np.array(interval_n_at_risk, dtype=np.float64)
                weights_np = np.array(interval_weights, dtype=np.float64)
                curr_idx_np = np.array(curr_indices, dtype=np.int64)
                prev_idx_np = np.array(prev_indices, dtype=np.int64)
                prev_safe = np.where(prev_idx_np >= 0, prev_idx_np, 0)
                is_first = (prev_idx_np < 0).astype(np.float64)

                # Look up mixture CDF values at each interval boundary.
                pcdf_curr = p_cdf_sum[curr_idx_np]
                pcdf_prev = p_cdf_sum[prev_safe]

                # ΔpCDF = change in cumulative incidence over this interval.
                # For the first interval (is_first=1), prev is zero.
                delta_pcdf = pcdf_curr - pcdf_prev * (1.0 - is_first)

                # Survival = fraction of population NOT yet converted
                # at the start of this interval.
                surv_prev = 1.0 - pcdf_prev * (1.0 - is_first)
                surv_prev = pt.maximum(surv_prev, SURVIVAL_FLOOR)

                # Conditional hazard: probability of converting in this
                # interval, given you haven't converted yet.
                q_j = pt.clip(delta_pcdf / surv_prev, SURVIVAL_FLOOR, 1.0 - SURVIVAL_FLOOR)

                # Binomial log-likelihood for each interval, weighted by
                # recency, summed across all intervals and trajectories.
                logp = pt.sum(weights_np * (
                    d_np * pt.log(q_j) + (n_at_risk_np - d_np) * pt.log(1.0 - q_j)
                ))
            else:
                # SINGLE-PATH: product-of-conditional-Binomials (common case).
                # Same mathematics as the mixture case above, but with a
                # single (onset, μ, σ) and a single p (or per-cohort p_i).

                # Compute the CDF at every retrieval age (vectorised).
                cdf_all = _compute_cdf_at_ages(onset, mu_var, sigma_var)

                # Decompose trajectories into intervals (same as mixture).
                # traj_idx_per_interval tracks which trajectory each interval
                # belongs to — needed for hierarchical p_i indexing.
                interval_d, interval_n_at_risk, interval_weights = [], [], []
                curr_indices, prev_indices = [], []
                traj_idx_per_interval = []
                age_offset = 0
                for ti, traj in enumerate(trajs):
                    n_ages = len(traj.retrieval_ages)
                    cum_y = traj.cumulative_y
                    w = getattr(traj, 'recency_weight', 1.0)
                    for j in range(n_ages):
                        d_j = float(cum_y[0]) if j == 0 else float(max(0, cum_y[j] - cum_y[j-1]))
                        n_j = float(traj.n) if j == 0 else float(max(0, traj.n - cum_y[j-1]))
                        interval_d.append(d_j)
                        interval_n_at_risk.append(n_j)
                        interval_weights.append(w)
                        curr_indices.append(age_offset + j)
                        prev_indices.append(age_offset + j - 1 if j > 0 else -1)
                        traj_idx_per_interval.append(ti)
                    age_offset += n_ages

                d_np = np.array(interval_d, dtype=np.float64)
                n_at_risk_np = np.array(interval_n_at_risk, dtype=np.float64)
                weights_np = np.array(interval_weights, dtype=np.float64)
                curr_idx_np = np.array(curr_indices, dtype=np.int64)
                prev_idx_np = np.array(prev_indices, dtype=np.int64)
                prev_safe = np.where(prev_idx_np >= 0, prev_idx_np, 0)
                is_first = (prev_idx_np < 0).astype(np.float64)
                traj_idx_np = np.array(traj_idx_per_interval, dtype=np.int64)

                # Resolve p for each interval:
                #   Hierarchical mode: each trajectory has its own p_i
                #   Standard mode: all intervals share the same p
                if _use_p_cohort_vec:
                    p_per_interval = p_cohort_vec[traj_idx_np]
                else:
                    p_per_interval = p_expr

                # Look up CDF values at interval boundaries.
                cdf_curr = cdf_all[curr_idx_np]
                cdf_prev = cdf_all[prev_safe]

                # ΔF = CDF increment over this interval (how much of the
                # maturation curve was "used up" in this time window).
                delta_F = cdf_curr - cdf_prev * (1.0 - is_first)
                delta_F = pt.maximum(delta_F, CDF_INCREMENT_FLOOR)

                # Survival = fraction not yet converted at interval start.
                # p × F_{j-1} = fraction of original pop already converted.
                F_prev = cdf_prev * (1.0 - is_first)
                surv_prev = 1.0 - p_per_interval * F_prev
                surv_prev = pt.maximum(surv_prev, SURVIVAL_FLOOR)

                # Conditional hazard: probability of converting in this
                # interval, given you haven't yet.
                #   q_j = p × ΔF / (1 − p × F_{j−1})
                q_j = pt.clip(p_per_interval * delta_F / surv_prev, SURVIVAL_FLOOR, 1.0 - SURVIVAL_FLOOR)

                # ---- Latency dispersion (doc 34) ----
                # When enabled, replace per-interval Binomial with
                # BetaBinomial. kappa_lat is a single scalar that captures
                # timing overdispersion — the latency analogue of kappa
                # for p. Same mean, inflated variance. One parameter per
                # edge, no per-cohort latents.
                _feat_ld = (features or {}).get("latency_dispersion", False)
                _use_kappa_lat = _feat_ld and has_latent_latency
                if _use_kappa_lat:
                    _ld_suffix = f"{safe_id}_{obs_type}"
                    _log_kl = pm.Normal(f"log_kappa_lat_{_ld_suffix}",
                                        mu=LOG_KAPPA_MU, sigma=LOG_KAPPA_SIGMA)
                    kappa_lat = pm.Deterministic(f"kappa_lat_{_ld_suffix}",
                                                  pt.exp(_log_kl))
                    # BetaBinomial log-likelihood: same mean as Binomial,
                    # variance inflated by (n + kappa_lat) / (1 + kappa_lat).
                    # Use PyMC's native BetaBinomial.dist() + pm.logp() for
                    # optimised PyTensor compilation (avoids manual gammaln
                    # graph that causes compilation timeout on large models).
                    _alpha = q_j * kappa_lat
                    _beta = (1.0 - q_j) * kappa_lat
                    _bb_dist = pm.BetaBinomial.dist(
                        alpha=_alpha, beta=_beta,
                        n=pt.as_tensor_variable(n_at_risk_np))
                    _lp = pm.logp(_bb_dist, pt.as_tensor_variable(d_np))
                    _ll_pointwise = weights_np * _lp
                    logp = pt.sum(_ll_pointwise)
                    diagnostics.append(
                        f"  latency_dispersion {safe_id} ({obs_type}): "
                        f"kappa_lat ~ LogNormal, BetaBinomial intervals")
                else:
                    # Standard Binomial log-likelihood, weighted and summed.
                    _ll_pointwise = weights_np * (
                        d_np * pt.log(q_j) + (n_at_risk_np - d_np) * pt.log(1.0 - q_j)
                    )
                    logp = pt.sum(_ll_pointwise)

            n_terms = len(trajs)

        else:
            # FIXED-CDF PATH (Phase S or no latent latency).
            # Same product-of-conditional-Binomials mathematics, but the
            # CDF values are precomputed as plain floats (not PyTensor
            # variables). Only p flows through as a learnable parameter.
            # This is faster but cannot learn latency from the data.
            interval_d = []
            interval_n_at_risk = []
            interval_cdf_curr = []
            interval_cdf_prev = []
            interval_weights = []

            for traj in trajs:
                cum_y = traj.cumulative_y
                w = getattr(traj, 'recency_weight', 1.0)

                if has_any_latency:
                    cdf_vals = [shifted_lognormal_cdf(age, onset, mu_fixed, sigma_fixed)
                                for age in traj.retrieval_ages]
                else:
                    cdf_vals = [1.0] * len(traj.retrieval_ages)

                for j in range(len(cum_y)):
                    d_j = float(cum_y[0]) if j == 0 else float(max(0, cum_y[j] - cum_y[j-1]))
                    n_j = float(traj.n) if j == 0 else float(max(0, traj.n - cum_y[j-1]))
                    interval_d.append(d_j)
                    interval_n_at_risk.append(n_j)
                    interval_cdf_curr.append(cdf_vals[j])
                    interval_cdf_prev.append(cdf_vals[j-1] if j > 0 else 0.0)
                    interval_weights.append(w)

            d_np = np.array(interval_d, dtype=np.float64)
            n_at_risk_np = np.array(interval_n_at_risk, dtype=np.float64)
            cdf_curr_np = np.array(interval_cdf_curr, dtype=np.float64)
            cdf_prev_np = np.array(interval_cdf_prev, dtype=np.float64)
            weights_np = np.array(interval_weights, dtype=np.float64)

            delta_F = pt.as_tensor_variable(np.maximum(cdf_curr_np - cdf_prev_np, CDF_INCREMENT_FLOOR))
            F_prev = pt.as_tensor_variable(cdf_prev_np)
            surv_prev = pt.maximum(1.0 - p_expr * F_prev, SURVIVAL_FLOOR)
            q_j = pt.clip(p_expr * delta_F / surv_prev, SURVIVAL_FLOOR, 1.0 - SURVIVAL_FLOOR)

            _ll_pointwise = weights_np * (
                d_np * pt.log(q_j) + (n_at_risk_np - d_np) * pt.log(1.0 - q_j)
            )
            logp = pt.sum(_ll_pointwise)
            n_terms = len(trajs)

        # Store per-interval pointwise log-likelihood for LOO-ELPD.
        # pm.Potential doesn't produce log_likelihood entries, so we
        # store via Deterministic and move to log_likelihood post-hoc.
        pm.Deterministic(f"ll_traj_{obs_type}_{safe_id}", _ll_pointwise)
        pm.Potential(f"traj_{obs_type}_{safe_id}", logp)
        mixture_str = f", mixture={len(mixture_components)} paths" if is_mixture else ""
        diagnostics.append(
            f"  Potential traj_{obs_type}_{safe_id}: "
            f"{n_terms} Cohort days, latent_latency={has_latent_latency}, "
            f"p_type={'edge' if obs_type == 'window' else 'path'}{mixture_str}"
        )

    # ---- STEP 3: Daily observations (p-anchor) ----
    #
    # Daily observations are simple (n, k) counts: "on this date, n users
    # arrived and k converted". Unlike trajectories, these are single
    # measurements — no maturation curve, just one snapshot per day.
    #
    # Their purpose is to ANCHOR p to the observed conversion rate.
    # Without them, the trajectory likelihood has a tradeoff between
    # p and latency: the model could explain low observed conversions
    # either as "low p" or as "high p but very slow latency (most
    # conversions haven't happened yet)". The daily anchor breaks this
    # degeneracy by directly constraining p.
    #
    # Daily obs: BetaBinomial with κ to capture between-day rate
    # variation. Each daily obs is an independent draw from
    # Beta(p·κ, (1-p)·κ) — this is the primary data source for
    # constraining κ within the MCMC (journal 30-Mar-26).
    #
    # When κ is not available (feat_overdispersion=False), fall back
    # to plain Binomial.
    #
    # Guard: skip when ≤ 3 days — too few points to anchor p, and
    # small arrays trigger a PyTensor rewrite bug.
    if all_daily and len(all_daily) > 3:
        n_arr = np.array([d.n for d in all_daily], dtype=np.int64)
        k_arr = np.array([min(d.k, d.n) for d in all_daily], dtype=np.int64)
        compl_arr = np.array([d.completeness for d in all_daily], dtype=np.float64)

        mask = n_arr > 0
        if mask.any():
            n_arr = n_arr[mask]
            k_arr = k_arr[mask]
            compl_arr = compl_arr[mask]

            p_effective = pm.math.clip(p_var * compl_arr, P_CLIP_LO, P_CLIP_HI)

            if kappa is not None:
                # BetaBinomial: per-day overdispersion.
                pm.BetaBinomial(
                    f"obs_daily_{safe_id}",
                    n=n_arr,
                    alpha=p_effective * kappa,
                    beta=(1.0 - p_effective) * kappa,
                    observed=k_arr,
                )
            else:
                pm.Binomial(
                    f"obs_daily_{safe_id}",
                    n=n_arr,
                    p=p_effective,
                    observed=k_arr,
                )


def _resolve_path_latency(
    path_edge_ids: list[str],
    topology,
    latency_vars: dict[str, tuple],
    onset_vars: dict[str, object] | None = None,
) -> tuple | None:
    """Compose path-level latency from individual edge latencies.

    When a user traverses edges A → B → C, the total delay is the sum
    of individual edge delays. Since each edge's delay is lognormal,
    the sum is approximately lognormal (via Fenton-Wilkinson composition).

    This function:
      1. Sums onsets: path_onset = onset_A + onset_B + onset_C
      2. Composes (μ, σ) pairs via FW chain: the result is a single
         (μ_path, σ_path) that approximates the sum of lognormals.

    Uses latent (PyTensor) variables where available (the model is
    learning them), and falls back to fixed prior values otherwise.

    Returns (onset, mu_composed, sigma_composed) or None if no
    latency edges exist on the path.

    onset_vars: if provided, edge-level latent onset variables are
    summed (as differentiable PyTensor expressions) instead of fixed
    values. This lets MCMC gradients flow through to edge onsets.
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
    """Compute the path probability: p_path = p_A × p_B × ... × p_current.

    For a cohort observation at edge C on path A → B → C, the fraction
    of anchor-node users who reach C's target is the product of all
    edge probabilities along the path: p_A × p_B × p_C.

    For the first edge from anchor (no upstream edges), p_path = p_current.

    stop_p_gradient: controls whether cohort data can influence upstream
        edges' probabilities via MCMC gradients.

        If True: the upstream product (p_A × p_B) is wrapped in
        disconnected_grad — the sampler treats it as a constant when
        computing gradients for p_A and p_B. Only p_current (the
        terminal edge) receives gradient from this likelihood term.

        Why this matters: without this, a single noisy cohort observation
        at edge C could distort the well-constrained estimates of p_A
        and p_B (which have their own window data). The gradient stop
        says "cohort data constrains the terminal edge, not the whole
        path". See journal 25-Mar-26.
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
        # Search order depends on context:
        # Phase 1 (stop_p_gradient=True, but cohort skipped): p_cohort_, p_base_, p_
        # Phase 2 (stop_p_gradient=False): p_cohort_ first (Phase 2 variables)
        # Phase 1 window: p_window_, p_base_, p_
        prefixes = ("p_cohort_", "p_window_", "p_base_", "p_")
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


def _emit_edge_likelihoods(
    safe_id, p_override, edge_kappa, ev, et, edge_id, *,
    p_base_var, alpha, beta_param,
    edge_var_names, emit_window_binomial,
    is_phase2, phase2_frozen, bg_p_vars,
    topology, model, latency_vars, onset_vars, cohort_latency_vars,
    diagnostics, features, settings,
    _softplus_k, _s_dirichlet_conc_floor, _fallback_prior_ess,
    feat_window_only,
):
    """Emit likelihood terms for one edge emission (aggregate or per-slice).

    This is the single code path for Cases A-D. Called once per aggregate
    emission (uncontexted) or once per slice (contexted). The caller
    resolves p, kappa, latency per emission; this function emits the
    window/cohort likelihoods and endpoint BetaBinomials.
    """
    import pymc as pm
    import pytensor.tensor as pt
    import numpy as np

    _s = settings or {}

    # Resolve p: use override (per-slice) or create from prior
    if p_override is not None:
        p = p_override
    elif p_base_var is not None:
        p = p_base_var
    # Cases A-D below may create p if neither is set

    # --- Case A: edge has BOTH window and cohort data ---
    if ev.has_window and ev.has_cohort:
        if is_phase2:
            if edge_id in bg_p_vars:
                p = bg_p_vars[edge_id]
            else:
                frozen = phase2_frozen.get(edge_id, {})
                p_alpha = frozen.get("p_alpha")
                p_beta = frozen.get("p_beta")
                if p_alpha is not None and p_beta is not None:
                    elapsed = 0.0
                    if len(et.path_edge_ids) > 1:
                        for uid in et.path_edge_ids[:-1]:
                            ut = topology.edges.get(uid)
                            if ut and ut.has_latency:
                                uf = phase2_frozen.get(uid, {})
                                elapsed += uf.get("onset", 0.0)
                                elapsed += np.exp(uf.get("mu", 0.0))
                    drift_s2 = frozen.get("drift_sigma2", 0.0)
                    scale = _ess_decay_scale(p_alpha, p_beta, elapsed, drift_s2)
                    p = pm.Beta(f"p_cohort_{safe_id}",
                                alpha=max(p_alpha * scale, _s_dirichlet_conc_floor),
                                beta=max(p_beta * scale, _s_dirichlet_conc_floor))
                else:
                    p_mean = frozen.get("p", ev.prob_prior.alpha / (ev.prob_prior.alpha + ev.prob_prior.beta))
                    p = pm.Beta(f"p_cohort_{safe_id}",
                                alpha=max(p_mean * _fallback_prior_ess, _s_dirichlet_conc_floor),
                                beta=max((1 - p_mean) * _fallback_prior_ess, _s_dirichlet_conc_floor))
                edge_var_names[edge_id] = f"p_cohort_{safe_id}"

            _emit_cohort_likelihoods(safe_id, p, ev, diagnostics,
                                    topology, edge_var_names, model,
                                    latency_vars=latency_vars,
                                    p_window_var=None,
                                    cohort_latency_vars=cohort_latency_vars,
                                    kappa=edge_kappa,
                                    onset_vars=onset_vars,
                                    skip_cohort_trajectories=False,
                                    settings=_s, features=features)

            # Phase 2 cohort endpoint BB
            if edge_kappa is not None and ev.cohort_obs:
                from .completeness import shifted_lognormal_cdf
                _clv = cohort_latency_vars or {}
                if edge_id in _clv:
                    _ep_onset_var, _ep_mu_var, _ep_sigma_var = _clv[edge_id]
                    _ep_onset_f = et.path_latency.path_delta if et.path_latency else 0.0
                    _ep_mu_f = 0.0
                    _ep_sigma_f = 0.01
                else:
                    _pf = phase2_frozen.get(edge_id, {}) if phase2_frozen else {}
                    if et.path_latency:
                        _ep_onset_f = _pf.get("path_onset", et.path_latency.path_delta)
                        _ep_mu_f = _pf.get("path_mu", et.path_latency.path_mu)
                        _ep_sigma_f = _pf.get("path_sigma", et.path_latency.path_sigma)
                    elif et.has_latency and ev.latency_prior:
                        _ep_onset_f = ev.latency_prior.onset_delta_days or 0.0
                        _ep_mu_f = ev.latency_prior.mu
                        _ep_sigma_f = ev.latency_prior.sigma
                    else:
                        _ep_onset_f = 0.0
                        _ep_mu_f = 0.0
                        _ep_sigma_f = 0.01
                    _ep_onset_var = pt.as_tensor_variable(np.float64(_ep_onset_f))
                    _ep_mu_var = pt.as_tensor_variable(np.float64(_ep_mu_f))
                    _ep_sigma_var = pt.as_tensor_variable(np.float64(_ep_sigma_f))

                _cep_n, _cep_y, _cep_ages, _cep_skipped = [], [], [], 0
                for c_obs in ev.cohort_obs:
                    for traj in c_obs.trajectories:
                        if traj.obs_type != "cohort" or len(traj.retrieval_ages) < 2 or traj.n <= 0:
                            continue
                        if not et.has_latency:
                            _cep_f = 1.0
                        else:
                            _age = getattr(traj, 'max_retrieval_age', None) or traj.retrieval_ages[-1]
                            _cep_f = shifted_lognormal_cdf(_age, _ep_onset_f, _ep_mu_f, _ep_sigma_f)
                        if _cep_f < 0.9:
                            _cep_skipped += 1
                            continue
                        _cep_n.append(traj.n)
                        _cep_y.append(min(traj.cumulative_y[-1], traj.n) if traj.cumulative_y else 0)
                        _cep_ages.append(getattr(traj, 'max_retrieval_age', None) or traj.retrieval_ages[-1])

                if len(_cep_n) >= 3:
                    _cep_n_arr = np.array(_cep_n, dtype=np.int64)
                    _cep_y_arr = np.array(_cep_y, dtype=np.int64)
                    _cep_ages_arr = np.array(_cep_ages, dtype=np.float64)
                    if not et.has_latency:
                        _cep_p_eff = pm.math.clip(p, 1e-6, 1.0 - 1e-6)
                    else:
                        _t = pt.as_tensor_variable(_cep_ages_arr)
                        _eff = pt.softplus(_t - _ep_onset_var)
                        _z = (pt.log(pt.maximum(_eff, 1e-30)) - _ep_mu_var) / (_ep_sigma_var * pt.sqrt(2.0))
                        _cep_p_eff = pm.math.clip(p * 0.5 * pt.erfc(-_z), 1e-6, 1.0 - 1e-6)
                    pm.BetaBinomial(f"cohort_endpoint_bb_{safe_id}", n=_cep_n_arr,
                                    alpha=_cep_p_eff * edge_kappa,
                                    beta=(1.0 - _cep_p_eff) * edge_kappa,
                                    observed=_cep_y_arr)
                    diagnostics.append(
                        f"  cohort_endpoint_bb: {edge_id[:8]}… "
                        f"{len(_cep_n)} mature ({_cep_skipped} immature excluded)")
        else:
            # Phase 1
            if p_override is None:
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
                                        skip_cohort_trajectories=True,
                                        settings=_s, features=features)

            # Endpoint BetaBinomial
            if edge_kappa is not None and ev.cohort_obs:
                from .completeness import shifted_lognormal_cdf
                ep_onset = ev.latency_prior.onset_delta_days if ev.latency_prior else 0.0
                ep_mu = ev.latency_prior.mu if ev.latency_prior else 0.0
                ep_sigma = ev.latency_prior.sigma if ev.latency_prior else 0.01
                if edge_id in (latency_vars or {}):
                    ep_mu_var, ep_sigma_var = latency_vars[edge_id]
                else:
                    ep_mu_var = pt.as_tensor_variable(np.float64(ep_mu))
                    ep_sigma_var = pt.as_tensor_variable(np.float64(ep_sigma))
                if edge_id in (onset_vars or {}):
                    ep_onset_var = onset_vars[edge_id]
                else:
                    ep_onset_var = pt.as_tensor_variable(np.float64(ep_onset))

                ep_n_list, ep_y_list, ep_ages_list, ep_skipped = [], [], [], 0
                for c_obs in ev.cohort_obs:
                    for traj in c_obs.trajectories:
                        if traj.obs_type != "window" or len(traj.retrieval_ages) < 2 or traj.n <= 0:
                            continue
                        ep_f = shifted_lognormal_cdf(traj.retrieval_ages[-1], ep_onset, ep_mu, ep_sigma)
                        if ep_f < 0.9:
                            ep_skipped += 1
                            continue
                        ep_n_list.append(traj.n)
                        ep_y_list.append(min(traj.cumulative_y[-1], traj.n) if traj.cumulative_y else 0)
                        ep_ages_list.append(traj.retrieval_ages[-1])

                if len(ep_n_list) >= 3:
                    ep_n = np.array(ep_n_list, dtype=np.int64)
                    ep_y = np.array(ep_y_list, dtype=np.int64)
                    ep_ages = np.array(ep_ages_list, dtype=np.float64)
                    ages_t = pt.as_tensor_variable(ep_ages)
                    eff_ages = pt.softplus(_softplus_k * (ages_t - ep_onset_var)) / _softplus_k
                    z = (pt.log(pt.maximum(eff_ages, 1e-30)) - ep_mu_var) / (ep_sigma_var * pt.sqrt(2.0))
                    p_eff = pm.math.clip(p * 0.5 * pt.erfc(-z), 1e-6, 1.0 - 1e-6)
                    pm.BetaBinomial(f"endpoint_bb_{safe_id}", n=ep_n,
                                    alpha=p_eff * edge_kappa,
                                    beta=(1.0 - p_eff) * edge_kappa,
                                    observed=ep_y)
                    diagnostics.append(
                        f"  endpoint_bb: {edge_id[:8]}… "
                        f"{len(ep_n_list)} mature ({ep_skipped} immature excluded)")

        if edge_id not in edge_var_names:
            edge_var_names[edge_id] = f"p_{safe_id}"

    # --- Case B: edge has ONLY window data ---
    elif ev.has_window:
        if p_override is None:
            if p_base_var is not None:
                p = p_base_var
            else:
                p = pm.Beta(f"p_{safe_id}", alpha=alpha, beta=beta_param)
                edge_var_names[edge_id] = f"p_{safe_id}"
        if emit_window_binomial:
            _emit_window_likelihoods(safe_id, p, ev, diagnostics, kappa=edge_kappa)
        # Snapshot evidence stores window trajectories in cohort_obs
        # (as CohortObservation with obs_type="window"). When cohort_obs
        # has content, emit cohort likelihoods to consume those trajectories.
        # Mirrors Case A Phase 1 pattern: p_window_var=p, skip_cohort=True.
        if not feat_window_only and ev.cohort_obs:
            _emit_cohort_likelihoods(safe_id, p, ev, diagnostics,
                                    topology, edge_var_names, model,
                                    latency_vars=latency_vars,
                                    p_window_var=p,
                                    cohort_latency_vars=cohort_latency_vars,
                                    kappa=edge_kappa,
                                    onset_vars=onset_vars,
                                    skip_cohort_trajectories=True,
                                    settings=_s, features=features)

    # --- Case C: edge has ONLY cohort data ---
    elif ev.has_cohort:
        if p_override is None:
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
                                    onset_vars=onset_vars,
                                    settings=_s, features=features)

    # --- Case D: no data — prior-only edge ---
    else:
        if p_override is None and p_base_var is None:
            p = pm.Beta(f"p_{safe_id}", alpha=alpha, beta=beta_param)
            edge_var_names[edge_id] = f"p_{safe_id}"


def _emit_branch_group_multinomial(
    bg,
    topology: TopologyAnalysis,
    evidence: BoundEvidence,
    edge_var_names: dict[str, str],
    model,
    diagnostics: list[str],
    slice_ctx_key: str | None = None,
    bg_slice_p_vars: dict | None = None,
) -> None:
    """Emit a shared Multinomial (or DirichletMultinomial) likelihood for
    a branch group's window observations.

    This enforces the "shared denominator" constraint: if 1000 users
    arrived at the source node and 300 took Branch A and 200 took
    Branch B, then at most 500 took any branch (300 + 200 ≤ 1000).
    The Multinomial naturally enforces this — individual per-edge
    Binomials do not.

    Structure of the Multinomial:
      p_vec = [p_A × completeness_A, p_B × completeness_B, ..., dropout]
      observed = [k_A, k_B, ..., n − Σk]

    For exhaustive groups (no dropout), p_vec sums to 1 and
    observed sums to n. For non-exhaustive groups, the dropout
    component absorbs users who didn't take any branch.

    If overdispersion is enabled (κ exists), uses DirichletMultinomial
    instead of plain Multinomial — this allows the observed proportions
    to vary more than a simple coin-flip model would predict.

    slice_ctx_key: when set, emit a per-slice Multinomial using
    observations from that slice's SliceObservations and p vars from
    bg_slice_p_vars. When None, emit the aggregate Multinomial.

    Note: cohort daily observations are NOT handled here — each sibling
    may have different completeness on different days, making a shared
    Multinomial impractical. They are handled per-edge in
    _emit_cohort_likelihoods.
    """
    import pymc as pm
    import pytensor.tensor as pt
    import numpy as np

    # Collect siblings that have window data and a model variable.
    # When slice_ctx_key is set, use per-slice observations instead
    # of the aggregate.
    sibling_info = []
    for sib_id in bg.sibling_edge_ids:
        ev = evidence.edges.get(sib_id)
        if ev is None or ev.skipped:
            continue
        var_name = edge_var_names.get(sib_id)
        if var_name is None:
            continue

        # Select observation source: per-slice or aggregate
        if slice_ctx_key is not None:
            # Per-slice: find SliceObservations for this context key
            s_obs = None
            for _sg in ev.slice_groups.values():
                if slice_ctx_key in _sg.slices:
                    s_obs = _sg.slices[slice_ctx_key]
                    break
            if s_obs is None or not s_obs.has_window:
                continue
            _win_obs = s_obs.window_obs
            _coh_obs = s_obs.cohort_obs
        else:
            if not ev.has_window:
                continue
            _win_obs = ev.window_obs
            _coh_obs = ev.cohort_obs

        # Old path: window_obs
        total_k = sum(w.k for w in _win_obs)
        total_n = sum(w.n for w in _win_obs)
        avg_completeness = (
            sum(w.n * w.completeness for w in _win_obs) / total_n
            if total_n > 0 else 1.0
        )

        # Trajectory path: aggregate window trajectories
        if total_n == 0:
            window_trajs = [
                t for c in _coh_obs for t in c.trajectories
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

    # Shared denominator.
    # Defect 3 fix: when sibling denominators disagree significantly
    # (max/min > 1.5), the Multinomial's shared-experiment assumption
    # is violated. The shortfall between max_n and min_n is not real
    # dropout — it's a data completeness gap. Using max(n_i) inflates
    # the dropout and biases p downward for smaller-n siblings.
    # In this case, skip the Multinomial. The Dirichlet prior (Section 2)
    # still constrains p to the simplex.
    max_n = max(s["n"] for s in sibling_info)
    min_n = min(s["n"] for s in sibling_info)
    if min_n > 0 and max_n / min_n > 1.5:
        diagnostics.append(
            f"WARN: branch group {bg.group_id}: skipping Multinomial — "
            f"sibling denominators disagree (max/min={max_n / min_n:.1f}, "
            f"max_n={max_n}, min_n={min_n}). "
            f"Dirichlet prior still constrains p."
        )
        return

    shared_n = max_n
    total_k = sum(s["k"] for s in sibling_info)

    if total_k > shared_n:
        diagnostics.append(
            f"WARN: branch group {bg.group_id}: "
            f"Σk={total_k} > n_A={shared_n}, skipping Multinomial"
        )
        return

    # Resolve the p variable for each sibling from the model.
    # For per-slice emissions, use bg_slice_p_vars directly.
    sibling_p_vars = []
    for s in sibling_info:
        if slice_ctx_key is not None and bg_slice_p_vars:
            # Per-slice: use the Dirichlet-derived per-slice p
            p_var = (bg_slice_p_vars.get(s["edge_id"]) or {}).get(slice_ctx_key)
            if p_var is not None:
                sibling_p_vars.append((s, p_var))
                continue
            # Fall through to model search if not in bg_slice_p_vars

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
        p_dropout_safe = pt.maximum(p_dropout, P_CLIP_LO)
        p_full = pt.concatenate([p_stack, pt.stack([p_dropout_safe])])
        dropout_k = shared_n - total_k
        k_full = np.array(k_observed + [dropout_k], dtype=np.int64)
        effective_n = shared_n

    safe_group = _safe_var_name(bg.group_id)
    # Suffix for per-slice emissions (unique RV name)
    ctx_suffix = f"__{_safe_var_name(slice_ctx_key)}" if slice_ctx_key else ""

    # Use the first sibling's κ for the entire branch group.
    # For per-slice: use per-slice κ if available.
    first_sib_id = sibling_info[0]["edge_id"]
    first_safe = _safe_var_name(first_sib_id)
    kappa_var = None
    if slice_ctx_key:
        ctx_safe = _safe_var_name(slice_ctx_key)
        kappa_name = f"kappa_slice_{first_safe}_{ctx_safe}"
    else:
        kappa_name = f"kappa_{first_safe}"
    for rv in model.deterministics + model.free_RVs:
        if rv.name == kappa_name:
            kappa_var = rv
            break

    if kappa_var is not None:
        pm.DirichletMultinomial(
            f"obs_bg_{safe_group}{ctx_suffix}",
            n=effective_n,
            a=kappa_var * p_full,
            observed=k_full,
        )
    else:
        pm.Multinomial(
            f"obs_bg_{safe_group}{ctx_suffix}",
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


