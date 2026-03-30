#!/usr/bin/env python3
"""
Phase A diagnostic: validate synth gen produces correct overdispersion.

Runs mirror-4step synth gen at 10x traffic, captures the raw per-day p draws,
and checks whether the empirical variance matches Beta(μκ, (1-μ)κ) prediction.

Also computes empirical kappa from the generated (n, k) per day using both
method-of-moments and MLE, comparing to truth.
"""
from __future__ import annotations

import sys
import os
import numpy as np
from scipy import optimize, stats

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))


def beta_binom_mle(n_arr, k_arr):
    """Simple BetaBinomial MLE on (n, k) vectors. Returns (mu, kappa) or None."""
    mu_hat = k_arr.sum() / n_arr.sum()
    if mu_hat <= 0 or mu_hat >= 1:
        return None

    def neg_ll(params):
        mu, log_kappa = params
        kappa = np.exp(log_kappa)
        alpha = mu * kappa
        beta = (1 - mu) * kappa
        if alpha <= 0 or beta <= 0:
            return 1e12
        ll = 0.0
        for ni, ki in zip(n_arr, k_arr):
            ll += stats.betabinom.logpmf(ki, ni, alpha, beta)
        return -ll

    result = optimize.minimize(
        neg_ll, [mu_hat, np.log(50.0)],
        method="Nelder-Mead",
        options={"maxiter": 5000, "xatol": 1e-6, "fatol": 1e-8},
    )
    if not result.success:
        return None
    mu_est = result.x[0]
    kappa_est = np.exp(result.x[1])
    return mu_est, kappa_est


def williams_mom(n_arr, k_arr):
    """Williams method-of-moments kappa estimate."""
    p_arr = k_arr / np.maximum(n_arr, 1)
    p_bar = k_arr.sum() / n_arr.sum()
    K = len(n_arr)
    if K < 3 or p_bar <= 0 or p_bar >= 1:
        return None

    w = n_arr.astype(float)
    w_sum = w.sum()
    ssq = np.sum(w * (p_arr - p_bar) ** 2) / (K - 1)
    n_tilde = (w_sum - np.sum(w ** 2) / w_sum) / (K - 1)

    rho_num = ssq - p_bar * (1 - p_bar)
    rho_den = p_bar * (1 - p_bar) * (n_tilde - 1)
    if rho_den <= 0:
        return None

    rho = rho_num / rho_den
    if rho <= 0:
        return None  # no overdispersion detected

    kappa = (1 - rho) / rho
    return kappa


def main():
    # ---- Configuration ----
    truth_kappa_entry = 50.0
    truth_kappa_step = 30.0
    n_days = 100
    seed = 42

    # Edge truths from synth-mirror-4step.truth.yaml
    edges = {
        "m4-landing-to-created":     {"p": 0.18, "onset": 0.0, "mu": 0.0, "sigma": 0.0},
        "m4-created-to-delegated":   {"p": 0.55, "onset": 0.0, "mu": 0.0, "sigma": 0.0},
        "m4-delegated-to-registered":{"p": 0.11, "onset": 5.5, "mu": 1.5, "sigma": 0.57},
        "m4-registered-to-success":  {"p": 0.70, "onset": 3.2, "mu": 1.3, "sigma": 0.19},
    }

    for traffic_label, mean_daily_traffic in [("1x", 1600), ("10x", 16000)]:
        print(f"\n{'='*70}")
        print(f"  TRAFFIC: {traffic_label} ({mean_daily_traffic}/day)")
        print(f"  Truth: entry_kappa={truth_kappa_entry}, step_kappa={truth_kappa_step}")
        print(f"{'='*70}")

        rng = np.random.default_rng(seed)

        for edge_id, ep in edges.items():
            p_true = ep["p"]
            has_latency = ep["onset"] > 0 or ep["sigma"] > 0

            print(f"\n  --- {edge_id} (p={p_true}, latency={'yes' if has_latency else 'no'}) ---")

            # Simulate raw daily draws
            entry_p_draws = []
            step_p_draws = []
            eff_p_draws = []
            n_per_day = []
            k_per_day = []

            for day in range(n_days):
                # Entry-day draw
                alpha_e = p_true * truth_kappa_entry
                beta_e = (1 - p_true) * truth_kappa_entry
                p_entry = rng.beta(alpha_e, beta_e)

                # Step-day draw (independent)
                alpha_s = p_true * truth_kappa_step
                beta_s = (1 - p_true) * truth_kappa_step
                p_step = rng.beta(alpha_s, beta_s)

                # Effective p (multiplicative composition)
                p_eff = p_entry * (p_step / p_true)
                p_eff = min(max(p_eff, 0.001), 0.999)

                entry_p_draws.append(p_entry)
                step_p_draws.append(p_step)
                eff_p_draws.append(p_eff)

                # Generate daily n, k (simplified: no latency/path effects)
                n_day = rng.poisson(mean_daily_traffic)
                k_day = rng.binomial(n_day, p_eff)
                n_per_day.append(n_day)
                k_per_day.append(k_day)

            entry_p_arr = np.array(entry_p_draws)
            step_p_arr = np.array(step_p_draws)
            eff_p_arr = np.array(eff_p_draws)
            n_arr = np.array(n_per_day)
            k_arr = np.array(k_per_day)

            # Empirical statistics on the p draws themselves
            print(f"    Entry p: mean={entry_p_arr.mean():.4f}, std={entry_p_arr.std():.4f}")
            print(f"    Step  p: mean={step_p_arr.mean():.4f}, std={step_p_arr.std():.4f}")
            print(f"    Eff   p: mean={eff_p_arr.mean():.4f}, std={eff_p_arr.std():.4f}")

            # Theoretical variance for single Beta(μκ, (1-μ)κ)
            var_entry_theory = p_true * (1 - p_true) / (truth_kappa_entry + 1)
            var_step_theory = p_true * (1 - p_true) / (truth_kappa_step + 1)
            print(f"    Theoretical entry std = {np.sqrt(var_entry_theory):.4f}")
            print(f"    Theoretical step  std = {np.sqrt(var_step_theory):.4f}")

            # For the composite: Var(p_eff) ≈ Var(entry) + Var(step) (if independent, first-order)
            # More precisely: p_eff = p_entry * p_step / p_true
            # Var(p_eff) ≈ (1/p_true^2) * (E[p_step]^2 * Var(p_entry) + E[p_entry]^2 * Var(p_step))
            #            ≈ Var(p_entry) + Var(p_step)  (since E[p] = p_true)
            var_composite_approx = var_entry_theory + var_step_theory
            print(f"    Approx composite std  = {np.sqrt(var_composite_approx):.4f}")
            print(f"    Empirical eff p std   = {eff_p_arr.std():.4f}")

            # What effective single kappa would produce this variance?
            # Var = p(1-p)/(κ_eff+1)  →  κ_eff = p(1-p)/Var - 1
            var_eff_empirical = eff_p_arr.var()
            if var_eff_empirical > 0:
                kappa_eff_from_p = p_true * (1 - p_true) / var_eff_empirical - 1
                print(f"    Effective κ from p-draw variance = {kappa_eff_from_p:.1f}")
            # Theoretical: 1/κ_eff = 1/κ_entry + 1/κ_step (harmonic-like)
            kappa_eff_theory = 1.0 / (1.0 / truth_kappa_entry + 1.0 / truth_kappa_step)
            print(f"    Theoretical κ_eff (harmonic)      = {kappa_eff_theory:.1f}")

            # Now: MLE and MoM on the (n, k) data
            print(f"\n    n: median={np.median(n_arr):.0f}, mean={n_arr.mean():.0f}")
            print(f"    k/n rates: mean={k_arr.sum()/n_arr.sum():.4f}")

            mom = williams_mom(n_arr, k_arr)
            mle = beta_binom_mle(n_arr, k_arr)

            if mom is not None:
                print(f"    Williams MoM κ = {mom:.1f}")
            else:
                print(f"    Williams MoM κ = FAILED (no overdispersion detected)")

            if mle is not None:
                print(f"    BetaBinom MLE  κ = {mle[1]:.1f}  (μ={mle[0]:.4f})")
            else:
                print(f"    BetaBinom MLE  κ = FAILED (did not converge)")

            print(f"    Truth κ_eff (harmonic) = {kappa_eff_theory:.1f}")

    # ---- Phase A bonus: pure BetaBinomial recovery (no synth gen pipeline) ----
    print(f"\n\n{'='*70}")
    print(f"  PHASE C PREVIEW: Pure BetaBinomial MLE recovery")
    print(f"  (no pipeline, no composition — just single-source BB data)")
    print(f"{'='*70}")

    for kappa_true in [20, 50, 100]:
        for mu in [0.1, 0.3, 0.7]:
            for n_per in [20, 200]:
                rng2 = np.random.default_rng(42)
                K = 100
                n_arr = np.full(K, n_per)
                p_draws = rng2.beta(mu * kappa_true, (1 - mu) * kappa_true, size=K)
                k_arr = np.array([rng2.binomial(n, p) for n, p in zip(n_arr, p_draws)])

                mle = beta_binom_mle(n_arr, k_arr)
                mom = williams_mom(n_arr, k_arr)

                mle_str = f"{mle[1]:.1f}" if mle else "FAIL"
                mom_str = f"{mom:.1f}" if mom else "FAIL"
                print(f"    κ={kappa_true:3d}  μ={mu:.1f}  n={n_per:4d}  K={K}  "
                      f"→  MLE={mle_str:>7s}  MoM={mom_str:>7s}")


if __name__ == "__main__":
    main()
