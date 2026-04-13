#!/usr/bin/env python3
"""Diagnostic v2: reproduce NaN through nutpie, then compare pytensor at x=0.

Key finding from v1: pytensor's own gradient function at initial_point()
produces 0 NaN. But doc 39 says nutpie at x=0 produces 2 NaN. Two hypotheses:
  A) The NaN is at x=0 specifically (not at model.initial_point())
  B) nutpie compiles differently from pytensor.function()

This script tests both.
"""

import pickle, json, sys, os
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'graph-editor', 'lib'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'bayes'))

DUMP = '/tmp/bayes_debug-graph-synth-diamond-context'


def load_dump():
    with open(f'{DUMP}/topology.pkl', 'rb') as f:
        topo = pickle.load(f)
    with open(f'{DUMP}/evidence.pkl', 'rb') as f:
        evidence = pickle.load(f)
    with open(f'{DUMP}/phase2_frozen.json') as f:
        phase2_frozen = json.load(f)
    with open(f'{DUMP}/settings.json') as f:
        sb = json.load(f)
    return topo, evidence, phase2_frozen, sb


def main():
    topo, evidence, phase2_frozen, sb = load_dump()

    from compiler.model import build_model
    model, diag = build_model(
        topo, evidence,
        features=sb['features'],
        phase2_frozen=phase2_frozen,
        settings=sb['settings'],
    )

    # List all free RVs to find the eps_onset_cohort variables
    print("=== Free RVs ===")
    for i, rv in enumerate(model.free_RVs):
        print(f"  [{i:2d}] {rv.name}")

    # Find eps_onset_cohort variables
    onset_indices = []
    for i, rv in enumerate(model.free_RVs):
        if 'eps_onset_cohort' in rv.name:
            onset_indices.append(i)
    print(f"\neps_onset_cohort indices: {onset_indices}")

    # === Test 1: nutpie compilation (the actual failing path) ===
    print("\n=== Test 1: nutpie JAX compilation ===")
    import nutpie
    try:
        compiled = nutpie.compile_pymc_model(model, backend='jax', gradient_backend='jax')
        print(f"  n_dim = {compiled.n_dim}")
        print(f"  var_names = {compiled.var_names}")

        import jax
        import jax.numpy as jnp

        raw_fn = compiled._raw_logp_fn
        def logp_scalar(x):
            return raw_fn(x)[0]

        # Test at x = 0 (nutpie's default init starting point)
        x0 = jnp.zeros(compiled.n_dim)
        logp_val = raw_fn(x0)
        print(f"  logp(0) = {logp_val[0]}")

        # Gradient at x=0
        g = jax.grad(logp_scalar)(x0)
        g_np = np.asarray(g)
        nan_mask = np.isnan(g_np)
        nan_count = nan_mask.sum()
        print(f"  NaN count at x=0: {nan_count}")

        if nan_count > 0:
            nan_indices = np.where(nan_mask)[0]
            print(f"  NaN indices: {nan_indices}")
            for idx in nan_indices:
                print(f"    [{idx}] value at x=0: {float(x0[idx])}")

            # Test numerical gradient at the NaN indices
            print("\n  --- Numerical gradient at NaN indices ---")
            eps = 1e-7
            for idx in nan_indices:
                x_plus = x0.at[idx].set(eps)
                x_minus = x0.at[idx].set(-eps)
                lp_plus = raw_fn(x_plus)[0]
                lp_minus = raw_fn(x_minus)[0]
                num_grad = (lp_plus - lp_minus) / (2 * eps)
                print(f"    [{idx}] numerical grad = {num_grad:.4f}")

            # Test at x = 0.01 instead of exactly 0
            print("\n  --- Gradient at x = 0.01 (all elements) ---")
            x_shift = jnp.ones(compiled.n_dim) * 0.01
            g_shift = jax.grad(logp_scalar)(x_shift)
            nan_shift = np.isnan(np.asarray(g_shift)).sum()
            print(f"  NaN count at x=0.01: {nan_shift}")

            # Test at x = 0 but with NaN indices perturbed
            print("\n  --- Gradient at x=0 with NaN indices = 0.1 ---")
            x_fix = x0.at[nan_indices].set(0.1)
            g_fix = jax.grad(logp_scalar)(x_fix)
            nan_fix = np.isnan(np.asarray(g_fix)).sum()
            print(f"  NaN count: {nan_fix}")

            # Use JAX debug_nans to identify the exact op
            print("\n  --- JAX debug_nans trace ---")
            with jax.debug_nans(True):
                try:
                    g_debug = jax.grad(logp_scalar)(x0)
                except FloatingPointError as e:
                    print(f"  FloatingPointError: {e}")

        else:
            print("  No NaN at x=0 — the bug may have been fixed already!")

    except Exception as e:
        import traceback
        print(f"  nutpie compilation failed: {e}")
        traceback.print_exc()

    # === Test 2: pytensor direct gradient at x=0 ===
    print("\n=== Test 2: pytensor direct gradient at x=0 ===")
    import pytensor

    value_vars = [model.rvs_to_values[rv] for rv in model.free_RVs]
    logp = model.logp()
    grads_sym = pytensor.gradient.grad(logp, value_vars)

    # Compile with JAX
    fn_jax = pytensor.function(
        value_vars, grads_sym,
        mode='JAX',
        on_unused_input='ignore',
    )

    # Evaluate at zeros
    zero_vals = [np.zeros_like(model.initial_point()[v.name]) for v in value_vars]
    grads_at_zero = fn_jax(*zero_vals)
    nan_count_pt = sum(np.isnan(np.asarray(g)).sum() for g in grads_at_zero)
    print(f"  pytensor JAX gradient NaN count at x=0: {nan_count_pt}")

    if nan_count_pt > 0:
        for i, g in enumerate(grads_at_zero):
            if np.any(np.isnan(np.asarray(g))):
                print(f"    [{i}] {value_vars[i].name}: NaN")

    # Also check: does model.initial_point() differ from zeros?
    print("\n=== Model initial_point vs zeros ===")
    ip = model.initial_point()
    for v in value_vars:
        val = ip[v.name]
        if not np.allclose(val, 0.0):
            print(f"  {v.name}: init={val} (NOT zero)")


if __name__ == '__main__':
    main()
