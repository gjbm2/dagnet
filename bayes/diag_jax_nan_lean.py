#!/usr/bin/env python3
"""Lean diagnostic: reproduce NaN and test fix via gradient_backend='pytensor'."""
import pickle, json, sys, os, time
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'graph-editor', 'lib'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'bayes'))

DUMP = '/tmp/bayes_debug-graph-synth-diamond-context'
t0 = time.time()

with open(f'{DUMP}/topology.pkl', 'rb') as f: topo = pickle.load(f)
with open(f'{DUMP}/evidence.pkl', 'rb') as f: evidence = pickle.load(f)
with open(f'{DUMP}/phase2_frozen.json') as f: phase2_frozen = json.load(f)
with open(f'{DUMP}/settings.json') as f: sb = json.load(f)

from compiler.model import build_model
model, _ = build_model(topo, evidence, features=sb['features'],
                       phase2_frozen=phase2_frozen, settings=sb['settings'])
print(f"[{time.time()-t0:.1f}s] Model built: {len(model.free_RVs)} free RVs")

from nutpie.compile_pymc import _make_functions
from pymc.model.transform.optimization import freeze_dims_and_data
from pymc.initial_point import make_initial_point_fn
import jax, jax.numpy as jnp

model_frozen = freeze_dims_and_data(model)
ip_fn = make_initial_point_fn(
    model=model_frozen, default_strategy="support_point",
    jitter_rvs=set(model_frozen.free_RVs), return_transformed=True,
)

# === PATH A: gradient_backend='jax' (the broken path) ===
print(f"\n=== PATH A: jax.value_and_grad (nutpie gradient_backend='jax') ===")
n_dim, _, logp_fn_pt, _, ip_fn_out, shape_info = _make_functions(
    model_frozen, mode="JAX", compute_grad=False,
    join_expanded=False, pymc_initial_point_fn=ip_fn, var_names=None,
)

orig_logp_fn = logp_fn_pt.vm.jit_fn._fun
shared_vals = tuple(jnp.asarray(v.get_value()) for v in logp_fn_pt.get_shared())

def logp_jax_grad(x):
    return jax.value_and_grad(lambda x: orig_logp_fn(x, *shared_vals)[0])(x)
logp_jax_grad = jax.jit(logp_jax_grad)

x0 = jnp.zeros(n_dim)
lp, g = logp_jax_grad(x0)
g_np = np.asarray(g)
nan_idx = np.where(np.isnan(g_np))[0]
print(f"[{time.time()-t0:.1f}s] logp={float(np.asarray(lp)):.2f}, NaN count: {len(nan_idx)}")

if len(nan_idx) > 0:
    print(f"  NaN indices: {nan_idx.tolist()}")
    # Map to variable names
    names, slices, shapes = shape_info
    offset = 0
    for name, shape in zip(names, shapes):
        size = max(int(np.prod(shape)), 1)
        overlap = set(nan_idx.tolist()) & set(range(offset, offset + size))
        if overlap:
            print(f"    -> {name} (offset {offset})")
        offset += size

    # Numerical gradient
    eps = 1e-7
    for idx in nan_idx:
        xp, xm = x0.at[idx].set(eps), x0.at[idx].set(-eps)
        lpp = float(np.asarray(orig_logp_fn(xp, *shared_vals)[0]))
        lpm = float(np.asarray(orig_logp_fn(xm, *shared_vals)[0]))
        print(f"    [{idx}] num_grad={(lpp-lpm)/(2*eps):.4f}")

# === PATH B: gradient_backend='pytensor' (the potential fix) ===
print(f"\n=== PATH B: pytensor symbolic gradient compiled to JAX ===")
n2, _, logp_fn_pt2, _, _, _ = _make_functions(
    model_frozen, mode="JAX", compute_grad=True,
    join_expanded=False, pymc_initial_point_fn=ip_fn, var_names=None,
)
print(f"[{time.time()-t0:.1f}s] pytensor grad compiled")

pt_fn = logp_fn_pt2.vm.jit_fn._fun
shared2 = tuple(jnp.asarray(v.get_value()) for v in logp_fn_pt2.get_shared())
result = pt_fn(x0, *shared2)
pt_lp = float(np.asarray(result[0]))
pt_grad = np.asarray(result[1])
pt_nan = int(np.isnan(pt_grad).sum())
print(f"[{time.time()-t0:.1f}s] logp={pt_lp:.2f}, NaN count: {pt_nan}")

if pt_nan == 0 and len(nan_idx) > 0:
    print(f"\n  *** FIX CONFIRMED: gradient_backend='pytensor' eliminates the NaN ***")
    # Show the gradient values at the previously-NaN indices
    for idx in nan_idx:
        print(f"    [{idx}] pytensor grad = {float(pt_grad[idx]):.4f}")

    # Verify both paths agree on non-NaN gradients
    mask = ~np.isnan(g_np)
    max_diff = np.max(np.abs(g_np[mask] - pt_grad[mask]))
    print(f"\n  Max gradient diff (non-NaN indices): {max_diff:.6e}")

print(f"\n[{time.time()-t0:.1f}s] Done")
