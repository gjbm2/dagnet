#!/usr/bin/env python3
"""Verify the fix: nutpie compile with gradient_backend='pytensor' + JAX backend."""
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
print(f"[{time.time()-t0:.1f}s] Model built")

import nutpie, jax, jax.numpy as jnp

# The fix: gradient_backend='pytensor' instead of 'jax'
compiled = nutpie.compile_pymc_model(
    model, backend='jax', gradient_backend='pytensor')
print(f"[{time.time()-t0:.1f}s] nutpie compiled, n_dim={compiled.n_dim}")

# Get the logp+grad function that nutpie will use for sampling
make_logp = compiled._make_logp_fn
logp_fn = make_logp()
x0 = np.zeros(compiled.n_dim)
lp, grad = logp_fn(x0)
nan_count = int(np.isnan(grad).sum())
print(f"[{time.time()-t0:.1f}s] logp={lp:.2f}, grad NaN count: {nan_count}")

if nan_count == 0:
    print("SUCCESS: gradient_backend='pytensor' eliminates the NaN")
    print(f"  grad range: [{grad.min():.2f}, {grad.max():.2f}]")
    print(f"  grad norm: {np.linalg.norm(grad):.2f}")
else:
    nan_idx = np.where(np.isnan(grad))[0]
    print(f"FAIL: still {nan_count} NaN at indices {nan_idx.tolist()}")

print(f"[{time.time()-t0:.1f}s] Done")
