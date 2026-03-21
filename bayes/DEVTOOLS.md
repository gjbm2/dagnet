# Bayes Development Tools

Tools for developing, testing, and debugging the Bayes compiler and inference pipeline. All tools live in `bayes/` and run in-process — no browser, dev server, or Modal deployment needed.

## Prerequisites

All tools require:

```bash
cd dagnet
. graph-editor/venv/bin/activate
```

The venv contains PyMC, nutpie, PyTensor, arviz, and all other dependencies. All tools read `DB_CONNECTION` from `graph-editor/.env.local` (the Neon snapshot DB connection string). The data repo path is resolved from `.private-repos.conf` at the repo root.

**Important**: Only one tool should run at a time (they share DB connections and some use lock files).

---

## Test Graphs

Two test graphs are available, each in the data repo:

| Name | Flag | File | Edges | Structure | Use for |
|------|------|------|-------|-----------|---------|
| **simple** | `--graph simple` | (linear chain graph in data repo) | 4 | Linear chain, no branches or joins | Basic convergence, latency, Phase D |
| **branch** | `--graph branch` | (complex graph in data repo) | 10 (17 total inc. unevented) | Branch groups, 4 join nodes, diamond patterns | Branch/join handling, DM, Phase C/D |

The **simple** graph is the default for all tools. Use `--graph branch` when testing structural features (branch groups, Dirichlet-Multinomial, join nodes).

---

## 1. Wiring Harness (`test_wiring.py`)

**Purpose**: Stage-by-stage verification of every integration boundary in the compiler pipeline. No MCMC required (though it can optionally run a fast fit).

```bash
# Quick structural checks only (~2s)
python bayes/test_wiring.py --no-mcmc

# Fast MCMC (200 draws, 2 chains) — checks convergence too (~30s)
python bayes/test_wiring.py

# Full MCMC (2000 draws, 4 chains) — production-like
python bayes/test_wiring.py --full
```

**Assertion categories**:
- `[TOPO]` — Topology analysis: anchor, edges, branch groups, paths, latency priors
- `[EVID]` — Evidence binding: snapshot rows → observations, window/cohort split
- `[MODEL]` — Model building: variables, Potentials, p_window wiring, latency var ancestry
- `[INFER]` — Inference: convergence (rhat, ESS), latency posteriors, probability posteriors
- `[PATCH]` — Webhook payload: correct fields, provenance, non-stale values

**When to use**: After any change to the compiler pipeline (topology, evidence, model, inference). The `--no-mcmc` mode is fast enough to run after every edit. Run the full mode before declaring a phase complete.

---

## 2. Test Harness (`test_harness.py`)

**Purpose**: Full end-to-end fit via `fit_graph()` (the same entry point the worker uses). Produces the complete webhook payload and logs every stage. This is the closest thing to a production run without deploying.

```bash
# Simple graph, no webhook, compiler mode (default)
python bayes/test_harness.py --no-webhook

# Branch graph, longer timeout
python bayes/test_harness.py --graph branch --no-webhook --timeout 900

# Placeholder mode (skip MCMC, test pipeline wiring only)
python bayes/test_harness.py --placeholder --no-webhook

# Warm-start: run twice, feeding posteriors from pass 1 as priors for pass 2
python bayes/test_harness.py --warmstart --no-webhook
```

**Flags**:
- `--graph {simple,branch}` — which test graph
- `--no-webhook` — skip the webhook POST (usual for dev)
- `--placeholder` — skip MCMC entirely, return shifted placeholder posteriors
- `--warmstart` — two-pass: fit, patch posteriors onto graph, fit again
- `--timeout N` — hard timeout in seconds (default 600)

**Log output**: All progress is dual-written to stdout and `/tmp/bayes_harness.log`. Use `tail -f /tmp/bayes_harness.log` to monitor. All tools write to this same log file.

**Lock file**: `/tmp/bayes-harness.lock` — only one harness runs at a time. A new invocation kills any existing run.

**Output**: Prints the full result log including per-edge posteriors, quality metrics (rhat, ESS, divergences, convergence %), latency posteriors, kappa values, and timing breakdown.

---

## 3. Diagnostic Run (`diag_run.py`)

**Purpose**: Short MCMC fit with detailed per-variable diagnostics. Dumps a comprehensive report to help identify convergence problems: per-variable rhat/ESS, per-chain step sizes, energy diagnostics, tree depth, and per-chain means for problematic variables.

```bash
python bayes/diag_run.py
```

Currently hardcoded to the **branch** graph with 500 draws / 500 tune / 4 chains.

**Log output**: Dual stdout + `/tmp/bayes_harness.log` (same file as test_harness). Use `tail -f /tmp/bayes_harness.log` to monitor.

**Diagnostic report**: Written to `/tmp/bayes_diagnostics.txt`. Contains:

- Per-variable rhat and ESS (sorted worst-first, flagged if rhat > 1.05 or ESS < 400)
- Per-chain step sizes (mean and final adapted)
- Per-chain divergence counts
- Per-chain energy statistics (mean, sd, range)
- Per-chain tree depth (mean, max, % hitting max depth)
- Per-chain means for worst variables (rhat > 1.02) — shows chain disagreement
- Available sample_stats keys

**When to use**: When a model run fails to converge and you need to understand *which* variables are problematic and *why* (step size mismatch, chain disagreement, divergences concentrated in specific variables, etc.).

---

## Typical Development Workflow

### 1. After editing compiler code

```bash
# Quick structural check
python bayes/test_wiring.py --no-mcmc
```

### 2. Verify convergence on simple graph

```bash
python bayes/test_harness.py --no-webhook
# Should: 0 divergences, rhat < 1.05, ESS > 400, ~90s
```

### 3. Test on branch graph (structural features)

```bash
python bayes/test_harness.py --graph branch --no-webhook --timeout 900
# Monitor: tail -f /tmp/bayes_harness.log
```

### 4. Investigate convergence problems

```bash
python bayes/diag_run.py
# Then inspect: cat /tmp/bayes_diagnostics.txt
```

### 5. Full end-to-end with webhook (rare, pre-deploy)

```bash
# Start dev server first, then:
python bayes/test_harness.py
```

---

## Key Files

| File | Purpose |
|------|---------|
| `bayes/worker.py` | `fit_graph()` — the compute kernel (topology → evidence → model → inference → webhook) |
| `bayes/app.py` | Modal deployment wrapper |
| `bayes/compiler/topology.py` | Graph structural analysis (paths, joins, branch groups, latency priors) |
| `bayes/compiler/evidence.py` | Evidence binding (param files → observations) |
| `bayes/compiler/model.py` | PyMC model builder (the only file that imports PyMC) |
| `bayes/compiler/inference.py` | NUTS sampling (via nutpie) and posterior summarisation |
| `bayes/compiler/completeness.py` | CDF math: lognormal CDF, FW composition, moment-matched collapse |
| `bayes/compiler/types.py` | IR dataclasses (TopologyAnalysis, BoundEvidence, etc.) |
| `bayes/compiler/slices.py` | Slice DSL parsing (Phase C, not yet active) |

---

## Environment Notes

- **nutpie**: Rust-based NUTS sampler, significantly faster than PyMC's default. Installed in the venv. Falls back to PyMC NUTS if not available.
- **Snapshot DB**: Remote Neon PostgreSQL. Connection string in `graph-editor/.env.local`. All snapshot queries go through `snapshot_service.query_snapshots_for_sweep()`.
- **Data repo**: Contains test graphs, parameter files, and hash mappings. Path resolved from `.private-repos.conf`. Never committed to dagnet.
