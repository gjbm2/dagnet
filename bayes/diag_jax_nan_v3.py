#!/usr/bin/env python3
"""Diagnostic v3: reproduce NaN through nutpie's actual compilation path.

v2 showed: pytensor direct gradient at x=0 = 0 NaN.
But nutpie uses a FLAT TRANSFORMED vector — x=0 in nutpie ≠ x=0 in pytensor.
nutpie applies backward transforms: exp(0)=1 for Gamma, logistic(0)=0.5 for Beta, etc.

This script goes through nutpie's actual path.
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

    print(f"Model: {len(model.free_RVs)} free RVs")

    # === nutpie compilation ===
    print("\n=== nutpie JAX compilation ===")
    import nutpie

    compiled = nutpie.compile_pymc_model(model, backend='jax', gradient_backend='jax')
    n_dim = compiled.n_dim
    print(f"  n_dim = {n_dim}")

    # Inspect the compiled object
    print(f"  type = {type(compiled)}")
    print(f"  dir = {[x for x in dir(compiled) if not x.startswith('__')]}")

    import jax
    import jax.numpy as jnp

    # Get the raw logp+grad function from nutpie
    # nutpie.compile_pymc_model returns a CompiledPyMCModel which has
    # _logp_fn (returns logp) and _dlogp_fn (returns grad)
    # or _raw_logp_fn which returns (logp, grad) tuple
    print(f"\n  Checking available logp functions...")
    for attr in ['_raw_logp_fn', '_logp_fn', 'logp', 'logp_fn',
                 '_dlogp_fn', 'logp_and_grad', '_expand_draw']:
        if hasattr(compiled, attr):
            print(f"    {attr}: {type(getattr(compiled, attr))}")

    # Get logp function
    if hasattr(compiled, '_raw_logp_fn'):
        raw_fn = compiled._raw_logp_fn
        # Check signature - does it return (logp,) or (logp, grad)?
        x0 = jnp.zeros(n_dim)
        result = raw_fn(x0)
        print(f"\n  _raw_logp_fn(x0) type: {type(result)}")
        if isinstance(result, tuple):
            print(f"  _raw_logp_fn returns tuple of length {len(result)}")
            for i, r in enumerate(result):
                print(f"    [{i}]: shape={getattr(r, 'shape', 'scalar')}, "
                      f"dtype={getattr(r, 'dtype', type(r))}, "
                      f"value={float(np.asarray(r)) if np.asarray(r).ndim == 0 else np.asarray(r)[:5]}")
        else:
            print(f"  _raw_logp_fn returns: {result}")

    # Now compute gradient via jax.grad
    print("\n=== Gradient via jax.grad at x=0 ===")

    def logp_scalar(x):
        out = raw_fn(x)
        if isinstance(out, tuple):
            return out[0]
        return out

    x0 = jnp.zeros(n_dim)

    # Forward value
    lp = logp_scalar(x0)
    print(f"  logp(0) = {float(np.asarray(lp))}")

    # Gradient
    g = jax.grad(logp_scalar)(x0)
    g_np = np.asarray(g)
    nan_mask = np.isnan(g_np)
    nan_count = nan_mask.sum()
    inf_mask = np.isinf(g_np)
    inf_count = inf_mask.sum()
    print(f"  NaN count: {nan_count}")
    print(f"  Inf count: {inf_count}")

    if nan_count > 0:
        nan_indices = np.where(nan_mask)[0]
        print(f"  NaN indices: {nan_indices.tolist()}")

        # Map indices back to variable names
        # nutpie flattens variables in order. Need to figure out the mapping.
        if hasattr(compiled, '_expand_draw'):
            print(f"\n  Expanding x=0 to see variable mapping...")
            try:
                expanded = compiled._expand_draw(x0)
                print(f"  Expanded keys: {list(expanded.keys()) if isinstance(expanded, dict) else type(expanded)}")
            except Exception as e:
                print(f"  _expand_draw failed: {e}")

        # Numerical gradient at NaN indices
        print(f"\n  --- Numerical gradient at NaN indices ---")
        eps = 1e-7
        for idx in nan_indices:
            x_plus = x0.at[idx].set(eps)
            x_minus = x0.at[idx].set(-eps)
            lp_plus = float(np.asarray(logp_scalar(x_plus)))
            lp_minus = float(np.asarray(logp_scalar(x_minus)))
            num_grad = (lp_plus - lp_minus) / (2 * eps)
            print(f"    [{idx}] numerical grad = {num_grad:.4f}, "
                  f"logp(+eps)={lp_plus:.2f}, logp(-eps)={lp_minus:.2f}")

        # Binary search: which x[nan_idx] value makes the NaN disappear?
        print(f"\n  --- Binary search: at what offset does NaN disappear? ---")
        for idx in nan_indices[:2]:  # just first 2
            for shift in [0.001, 0.01, 0.05, 0.1, 0.5, 1.0]:
                x_test = x0.at[idx].set(shift)
                g_test = jax.grad(logp_scalar)(x_test)
                still_nan = np.isnan(np.asarray(g_test)[idx])
                print(f"    [{idx}] x={shift:.3f}: NaN={still_nan}")
                if not still_nan:
                    break

        # JAX debug_nans to get the exact op
        print(f"\n  --- JAX debug_nans trace ---")
        try:
            with jax.debug_nans(True):
                g_debug = jax.grad(logp_scalar)(x0)
        except FloatingPointError as e:
            err_str = str(e)
            # Print first 500 chars
            print(f"  FloatingPointError: {err_str[:500]}")
            if len(err_str) > 500:
                print(f"  ... ({len(err_str)} chars total)")

    elif nan_count == 0:
        print("\n  *** No NaN at x=0! The bug may have been fixed. ***")
        print("  Checking a wider range of init points...")

        # Test at various points to see if NaN appears anywhere
        import jax.random as jrandom
        key = jrandom.PRNGKey(42)
        for trial in range(10):
            key, subkey = jrandom.split(key)
            x_test = jrandom.normal(subkey, shape=(n_dim,)) * 0.5
            try:
                g_test = jax.grad(logp_scalar)(x_test)
                nans = np.isnan(np.asarray(g_test)).sum()
                if nans > 0:
                    print(f"    Trial {trial}: {nans} NaN at random point")
                    # Show which indices
                    nan_idx = np.where(np.isnan(np.asarray(g_test)))[0]
                    print(f"    NaN indices: {nan_idx.tolist()[:10]}")
                    break
            except Exception as e:
                print(f"    Trial {trial}: error: {e}")
        else:
            print("    No NaN found in 10 random trials either.")

    # === Sanity: what does the nutpie init strategy actually do? ===
    print("\n=== nutpie init strategy ===")
    if hasattr(compiled, 'make_initial_point'):
        try:
            ip = compiled.make_initial_point()
            print(f"  make_initial_point: {ip[:5]}... (len={len(ip)})")
        except Exception as e:
            print(f"  make_initial_point failed: {e}")

    # Check if nutpie's init uses zeros or something else
    print("\n  (nutpie typically starts NUTS from x=0 in unconstrained space,")
    print("   then uses jitter. The init gradient check is at x=0.)")


if __name__ == '__main__':
    main()
