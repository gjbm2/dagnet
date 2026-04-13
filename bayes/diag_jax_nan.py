#!/usr/bin/env python3
"""Diagnostic script: identify the pytensor node causing JAX gradient NaN.

Follows doc 39 next steps:
  1. Identify the exact pytensor node that compiles to `pad` in JAX
  2. Compare JAX vs C backend gradients
  3. Minimal subgraph isolation

Usage:
  cd dagnet && . graph-editor/venv/bin/activate
  python bayes/diag_jax_nan.py
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


def step1_identify_pad_node():
    """Step 1: Build model, get logp graph, find the pad-producing node."""
    print("=" * 70)
    print("STEP 1: Identify pytensor nodes that could compile to JAX `pad`")
    print("=" * 70)

    topo, evidence, phase2_frozen, sb = load_dump()

    from compiler.model import build_model
    model, diag = build_model(
        topo, evidence,
        features=sb['features'],
        phase2_frozen=phase2_frozen,
        settings=sb['settings'],
    )

    import pytensor
    import pytensor.tensor as pt

    # Get the logp graph
    logp = model.logp()
    print(f"\nModel logp graph: {type(logp)}")

    # Get all free RVs and their value variables
    rvs = model.free_RVs
    value_vars = [model.rvs_to_values[rv] for rv in rvs]
    print(f"Free RVs: {len(rvs)}")

    # Compute symbolic gradient
    print("\nComputing symbolic gradient...")
    grads = pytensor.gradient.grad(logp, value_vars)

    # Walk the gradient graph and find all ops
    from collections import Counter
    op_counts = Counter()

    def walk_graph(var, visited=None):
        if visited is None:
            visited = set()
        if var in visited:
            return
        visited.add(var)
        if var.owner is not None:
            op_name = type(var.owner.op).__name__
            op_counts[op_name] += 1
            for inp in var.owner.inputs:
                walk_graph(inp, visited)

    visited = set()
    for g in grads:
        walk_graph(g, visited)

    print(f"\nTotal unique ops in gradient graph: {len(op_counts)}")
    print("\nOps sorted by count (top 30):")
    for op, count in op_counts.most_common(30):
        print(f"  {op}: {count}")

    # Look for ops likely to compile to `pad` in JAX
    pad_suspects = [
        'AdvancedSubtensor', 'AdvancedSubtensor1',
        'AdvancedIncSubtensor', 'AdvancedIncSubtensor1',
        'Pad', 'Join', 'Concatenate',
        'IncSubtensor', 'SetSubtensor',
    ]
    print("\n--- Pad-suspect ops in gradient graph ---")
    for op in pad_suspects:
        if op in op_counts:
            print(f"  {op}: {op_counts[op]} instances")

    # Find the NaN-producing variables
    print("\n--- Identifying NaN-producing gradient variables ---")
    nan_var_names = ['eps_onset_cohort_31c26576', 'eps_onset_cohort_395d3cb6']
    nan_indices = []
    for i, rv in enumerate(rvs):
        if rv.name in nan_var_names:
            nan_indices.append(i)
            print(f"  RV {i}: {rv.name}")

    # Print the gradient subgraph for the NaN variables
    for idx in nan_indices[:1]:  # just the first one to keep output manageable
        print(f"\n--- dprint of gradient for {rvs[idx].name} ---")
        pytensor.dprint(grads[idx], depth=8)

    return model, grads, value_vars, nan_indices


def step2_compare_backends(model, grads, value_vars, nan_indices):
    """Step 2: Compile gradient with JAX and C, compare at x=0."""
    print("\n" + "=" * 70)
    print("STEP 2: Compare JAX vs C backend gradients at x=0")
    print("=" * 70)

    import pytensor
    import pytensor.tensor as pt

    # Get initial point
    ip = model.initial_point()
    print(f"\nInitial point has {len(ip)} variables")

    # Build a single function that returns all gradients
    # Use the value variables as inputs

    # --- C backend ---
    print("\n--- Compiling gradient function with C backend ---")
    try:
        grad_fn_c = pytensor.function(
            value_vars, grads,
            mode='FAST_RUN',
            on_unused_input='ignore',
        )
        # Evaluate at initial point
        ip_values = [ip[v.name] for v in value_vars]
        grads_c = grad_fn_c(*ip_values)
        nan_count_c = sum(np.isnan(g).sum() for g in grads_c)
        print(f"  C backend NaN count: {nan_count_c}")
        for idx in nan_indices:
            g = grads_c[idx]
            print(f"  grad[{idx}] ({value_vars[idx].name}): {g}")
    except Exception as e:
        print(f"  C backend failed: {e}")
        grads_c = None

    # --- JAX backend ---
    print("\n--- Compiling gradient function with JAX backend ---")
    try:
        grad_fn_jax = pytensor.function(
            value_vars, grads,
            mode='JAX',
            on_unused_input='ignore',
        )
        ip_values_jax = [ip[v.name] for v in value_vars]
        grads_jax = grad_fn_jax(*ip_values_jax)
        nan_count_jax = sum(np.isnan(np.asarray(g)).sum() for g in grads_jax)
        print(f"  JAX backend NaN count: {nan_count_jax}")
        for idx in nan_indices:
            g = np.asarray(grads_jax[idx])
            print(f"  grad[{idx}] ({value_vars[idx].name}): {g}")
    except Exception as e:
        print(f"  JAX backend failed: {e}")
        grads_jax = None

    if grads_c is not None and grads_jax is not None:
        print("\n--- Comparison ---")
        for i in range(len(grads)):
            gc = np.asarray(grads_c[i])
            gj = np.asarray(grads_jax[i])
            if np.any(np.isnan(gj)) and not np.any(np.isnan(gc)):
                print(f"  MISMATCH at [{i}] {value_vars[i].name}: C={gc}, JAX={gj}")

    return grads_c, grads_jax


def step3_isolate_subgraph(model, nan_indices, value_vars):
    """Step 3: Trace the gradient of just the NaN variable to find minimal subgraph."""
    print("\n" + "=" * 70)
    print("STEP 3: Isolate minimal NaN-producing subgraph")
    print("=" * 70)

    import pytensor
    import pytensor.tensor as pt

    # Get the logp contributions per observed variable
    for obs_rv in model.observed_RVs:
        print(f"  Observed: {obs_rv.name}")

    # Try to get individual logp terms
    logp_terms = model.logp(sum=False)
    print(f"\n  logp has {len(logp_terms)} individual terms")

    # For each term, check if the NaN variables appear in its inputs
    for idx in nan_indices[:1]:
        target_var = value_vars[idx]
        print(f"\n  Checking which logp terms involve {target_var.name}...")

        for i, term in enumerate(logp_terms):
            try:
                g = pytensor.gradient.grad(term, target_var, disconnected_inputs='ignore')
                # Check if gradient is actually connected (not zero)
                if g is not None and not isinstance(g.type, pytensor.gradient.DisconnectedType):
                    print(f"    Term {i} ({model.observed_RVs[i].name if i < len(model.observed_RVs) else '?'}): connected")

                    # Compile just this term's gradient with JAX
                    try:
                        fn = pytensor.function(
                            value_vars, [g],
                            mode='JAX',
                            on_unused_input='ignore',
                        )
                        ip = model.initial_point()
                        ip_values = [ip[v.name] for v in value_vars]
                        result = fn(*ip_values)
                        val = np.asarray(result[0])
                        if np.isnan(val):
                            print(f"      *** NaN in JAX gradient for this term! ***")
                            # Print the subgraph
                            print(f"      Term dprint (depth=5):")
                            pytensor.dprint(term, depth=5)
                        else:
                            print(f"      JAX gradient: {val}")
                    except Exception as e:
                        print(f"      JAX compile failed: {e}")
            except (ValueError, pytensor.gradient.DisconnectedInputError):
                pass  # not connected


def step4_test_fix_matmul_gather():
    """Step 4: Test if replacing AdvancedSubtensor with matmul fixes the NaN.

    Instead of cdf_all[idx_np] (gather), use a one-hot matrix multiply:
      one_hot @ cdf_all
    This avoids AdvancedSubtensor entirely and should have clean JAX gradients.
    """
    print("\n" + "=" * 70)
    print("STEP 4: Test matmul-gather replacement")
    print("=" * 70)

    import pytensor
    import pytensor.tensor as pt
    import jax
    import jax.numpy as jnp

    # Minimal reproduction: softplus -> log -> erfc -> gather -> likelihood
    # Mimics the _compute_cdf_at_ages -> interval decomposition chain

    k = 8.0  # softplus sharpness
    ages = np.array([1.0, 3.0, 7.0, 14.0, 30.0])  # retrieval ages
    onset_true = 5.9  # large onset (path B)
    mu_true = 2.5
    sigma_true = 1.0

    # Interval indices (2 intervals: [0→1], [1→2])
    curr_idx = np.array([1, 2], dtype=np.int64)
    prev_idx = np.array([0, 1], dtype=np.int64)
    d_np = np.array([5.0, 3.0])
    n_np = np.array([100.0, 95.0])

    # --- Original: AdvancedSubtensor (gather) ---
    print("\n--- Original (AdvancedSubtensor gather) ---")
    eps_var = pt.dscalar('eps')
    onset = pt.softplus(onset_true + eps_var * 0.5)
    age_minus_onset = pt.as_tensor_variable(ages) - onset
    eff = pt.softplus(k * age_minus_onset) / k
    log_ages = pt.log(pt.maximum(eff, 1e-30))
    z = (log_ages - mu_true) / (sigma_true * np.sqrt(2.0))
    z = pt.maximum(z, -25.0)
    cdf = 0.5 * pt.erfc(-z)

    cdf_curr = cdf[curr_idx]  # AdvancedSubtensor
    cdf_prev = cdf[prev_idx]  # AdvancedSubtensor
    delta_F = pt.maximum(cdf_curr - cdf_prev, 1e-15)
    surv = pt.maximum(1.0 - 0.3 * cdf_prev, 1e-10)
    q_j = pt.clip(0.3 * delta_F / surv, 1e-10, 1 - 1e-10)
    ll = pt.sum(d_np * pt.log(q_j) + (n_np - d_np) * pt.log(1 - q_j))

    grad_orig = pytensor.gradient.grad(ll, eps_var)

    try:
        fn_jax = pytensor.function([eps_var], [ll, grad_orig], mode='JAX')
        ll_val, g_val = fn_jax(0.0)
        print(f"  JAX: ll={float(np.asarray(ll_val)):.4f}, grad={float(np.asarray(g_val))}")
    except Exception as e:
        print(f"  JAX failed: {e}")

    try:
        fn_c = pytensor.function([eps_var], [ll, grad_orig], mode='FAST_RUN')
        ll_val_c, g_val_c = fn_c(0.0)
        print(f"  C:   ll={float(g_val_c):.4f}, grad={float(g_val_c)}")
    except Exception as e:
        print(f"  C failed: {e}")

    # --- Alternative: one-hot matmul (no AdvancedSubtensor) ---
    print("\n--- Alternative (one-hot matmul, no AdvancedSubtensor) ---")
    n_ages = len(ages)
    n_intervals = len(curr_idx)

    # Build one-hot selection matrices as numpy constants
    sel_curr = np.zeros((n_intervals, n_ages), dtype=np.float64)
    sel_prev = np.zeros((n_intervals, n_ages), dtype=np.float64)
    for i in range(n_intervals):
        sel_curr[i, curr_idx[i]] = 1.0
        sel_prev[i, prev_idx[i]] = 1.0

    eps_var2 = pt.dscalar('eps2')
    onset2 = pt.softplus(onset_true + eps_var2 * 0.5)
    age_minus_onset2 = pt.as_tensor_variable(ages) - onset2
    eff2 = pt.softplus(k * age_minus_onset2) / k
    log_ages2 = pt.log(pt.maximum(eff2, 1e-30))
    z2 = (log_ages2 - mu_true) / (sigma_true * np.sqrt(2.0))
    z2 = pt.maximum(z2, -25.0)
    cdf2 = 0.5 * pt.erfc(-z2)

    # Matmul gather instead of index gather
    cdf_curr2 = pt.dot(pt.as_tensor_variable(sel_curr), cdf2)
    cdf_prev2 = pt.dot(pt.as_tensor_variable(sel_prev), cdf2)
    delta_F2 = pt.maximum(cdf_curr2 - cdf_prev2, 1e-15)
    surv2 = pt.maximum(1.0 - 0.3 * cdf_prev2, 1e-10)
    q_j2 = pt.clip(0.3 * delta_F2 / surv2, 1e-10, 1 - 1e-10)
    ll2 = pt.sum(d_np * pt.log(q_j2) + (n_np - d_np) * pt.log(1 - q_j2))

    grad_alt = pytensor.gradient.grad(ll2, eps_var2)

    try:
        fn_jax2 = pytensor.function([eps_var2], [ll2, grad_alt], mode='JAX')
        ll_val2, g_val2 = fn_jax2(0.0)
        print(f"  JAX: ll={float(np.asarray(ll_val2)):.4f}, grad={float(np.asarray(g_val2))}")
    except Exception as e:
        print(f"  JAX failed: {e}")

    try:
        fn_c2 = pytensor.function([eps_var2], [ll2, grad_alt], mode='FAST_RUN')
        ll_val_c2, g_val_c2 = fn_c2(0.0)
        print(f"  C:   ll={float(np.asarray(ll_val_c2)):.4f}, grad={float(np.asarray(g_val_c2))}")
    except Exception as e:
        print(f"  C failed: {e}")


if __name__ == '__main__':
    print("JAX gradient NaN diagnostic — doc 39")
    print()

    model, grads, value_vars, nan_indices = step1_identify_pad_node()
    step2_compare_backends(model, grads, value_vars, nan_indices)
    step3_isolate_subgraph(model, nan_indices, value_vars)
    step4_test_fix_matmul_gather()
