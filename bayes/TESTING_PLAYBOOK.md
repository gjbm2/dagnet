# Bayes Testing Playbook

Operational guide for running, debugging, and extending the Bayes
compiler test apparatus. Covers the full workflow from graph creation
through synthetic data generation to parameter recovery validation.

**Audience**: Anyone working on the Bayes compiler. Read this before
running tests, creating test data, or investigating convergence issues.

---

## Quick Reference

### Prerequisites

```bash
cd dagnet
. graph-editor/venv/bin/activate
```

All tools read `DB_CONNECTION` from `graph-editor/.env.local`.
Data repo path resolved from `.private-repos.conf`.
Only one tool should run at a time (shared DB connections).

### Common Commands

```bash
# Structural checks (fast, ~2s)
python bayes/test_wiring.py --no-mcmc

# Full MCMC on simple graph (~90s)
python bayes/test_harness.py --no-webhook

# Full MCMC on branch graph (5-10min)
python bayes/test_harness.py --graph branch --no-webhook --timeout 900

# Diagnostic run with per-variable rhat/ESS breakdown
python bayes/diag_run.py

# Diagnostic with feature flags
python bayes/diag_run.py --no-latency          # Fixed latency (Phase S mode)
python bayes/diag_run.py --no-overdispersion   # Binomial instead of BetaBinomial

# Diagnostic excluding specific edge
python bayes/diag_run.py --exclude delegation-straight

# Diagnostic with synthetic data (bypasses snapshot DB)
python bayes/diag_run.py --synth

# Generate synthetic snapshot data
python bayes/synth_gen.py --graph branch --dry-run   # Preview
python bayes/synth_gen.py --graph branch              # Write to DB
python bayes/synth_gen.py --clean                     # Remove synthetic data

# Monitor any running tool
tail -f /tmp/bayes_harness.log
```

### Log and Output Files

| File | Purpose |
|------|---------|
| `/tmp/bayes_harness.log` | All tools write here (tail -f to watch) |
| `/tmp/bayes_diagnostics.txt` | Per-variable diagnostic report from diag_run |

---

## 1. Test Graphs

### Available graphs

| Name | Flag | Edges | Structure | Tests |
|------|------|-------|-----------|-------|
| simple | `--graph simple` | 4 | Linear chain | Basic convergence, latency, Phase D |
| branch | `--graph branch` | 10 (17 total) | Branch groups, 4 joins, diamonds | Branches, joins, DM, Phase C/D |

Both live in the data repo as full artefact sets (graph JSON, node
YAMLs, event YAMLs, param YAMLs, indexes).

### Creating new test graphs

New test graphs must be proper data repo artefacts. This means:

1. **Graph JSON** in `graphs/` — nodes with event_id, edges with p
   block including id (param_id), connection, DSL, latency config
2. **Node YAMLs** in `nodes/` — each node references an event
3. **Event YAMLs** in `events/` — event definitions (provider event
   names, filters). These are hashed into the core_hash.
4. **Parameter YAMLs** in `parameters/` — per edge: values[], latency
   block, probability
5. **Context YAMLs** in `contexts/` — if testing context slices
6. **Index files** — `nodes-index.yaml`, `parameters-index.yaml`
7. Run the data repo's integrity checks
8. Follow the branch workflow in `graph-ops/playbooks/branch-workflow.md`

**Why full artefacts?** The FE computes core hashes from event
definitions and connection details. Without proper artefacts, the FE
can't display the data, and we can't inspect the synthetic data shapes
through analysis views.

### Simulation guard

Test graphs with synthetic data should have `"simulation": true` in
the graph JSON. This prevents the FE's fetch plan builder from
querying external data sources and overwriting synthetic snapshots.

---

## 2. Synthetic Data Generator

### Purpose

Generate known-good snapshot trajectory data for a graph with
ground-truth parameters. Enables parameter recovery testing — fit the
model, verify it recovers the known truth.

### Ground truth config

Each test graph has a sidecar `{graph-name}.truth.yaml` defining:
- Simulation parameters (n_people/day, n_days, failure_rate, seed)
- Per-edge ground-truth values (p, onset, mu, sigma, kappa_sim)
- Core hashes (from test harness edge config — must match what FE
  computes)
- Context slices (Phase 2: per-context weights and overrides)

### Noise levels

| Level | κ_sim | Traffic | Failures | Drift | Use |
|-------|-------|---------|----------|-------|-----|
| 0 | 50 | Fixed 5000 | 0% | None | Does the model work at all? |
| 1 | 15 | Poisson(5000) | 5% | None | κ recovery, gap handling |
| 2 | 5 | Poisson(3000) | 10% | None | Heavy overdispersion |
| 3 | 15 | Poisson(5000) | 5% | Linear 10% | Drift detection |
| 4 | 3 | Poisson(1000) | 15% | Seasonal | Pathological |

Start with Level 0 (clean, well-behaved). If the model converges,
move to Level 1 to test noise handling. Higher levels are for stress
testing.

### Data format

The generator produces snapshot DB rows matching the real format:
- `anchor_day`: ISO date (cohort day)
- `retrieved_at`: ISO datetime (simulated nightly fetch timestamp)
- `slice_key`: `"window()"` or `"cohort()"` (Phase 2: with context
  qualifiers)
- `core_hash`: the real hash from the edge's DSL/connection (not a
  synthetic prefix)
- `a`: anchor entrants (cohort denominator)
- `x`: from-node entrants (window denominator)
- `y`: to-node arrivals by this retrieval age
- Lag columns: None (not used by evidence binder)

### DB write

Data is written to the snapshot DB under the edge's real core hashes.
Branch isolation in the data repo provides separation from production.
The FE sees the data natively — analysis views, cohort maturity,
snapshot manager all work.

### FE inspection

After generating synthetic data:
1. Open the test graph in the graph editor (from the test branch)
2. Navigate to an edge's analysis views
3. Cohort maturity, daily conversions, and snapshot charts should
   render the synthetic data shapes
4. Verify the CDF curve shape matches the ground truth's latency
   parameters
5. Verify the conversion rates match the ground truth's p values

---

## 3. Diagnostic Workflow

### When a model run fails to converge

1. **Run diag_run.py** to get per-variable diagnostics:
   ```bash
   python bayes/diag_run.py
   ```
   Check `/tmp/bayes_diagnostics.txt` for:
   - Which variables have rhat > 1.05 (worst first)
   - Per-chain means — do chains disagree?
   - Per-chain step sizes — are they similar?
   - Divergence count per chain

2. **Isolate the problem** using feature flags:
   ```bash
   python bayes/diag_run.py --no-latency    # Is it latency coupling?
   python bayes/diag_run.py --no-overdispersion  # Is it κ?
   ```

3. **Exclude specific edges** to test if one edge is the culprit:
   ```bash
   python bayes/diag_run.py --exclude delegation-straight
   ```

4. **Test against synthetic data** to distinguish model vs data issues:
   ```bash
   python bayes/diag_run.py --synth
   ```
   If synthetic data converges but real data doesn't → data quality
   issue. If both fail → model structure issue.

### Interpreting diagnostics

| Symptom | Likely cause | Action |
|---------|-------------|--------|
| One variable rhat >> 1, chains disagree | p-latency bimodality on that edge | Stronger priors or exclude edge |
| All latency vars have high rhat | Latency model geometry | Try `--no-latency` to confirm |
| Many divergences | Step size too large / gradient discontinuity | Check onset handling, target_accept |
| ESS low but rhat OK | Slow mixing, correlations | More draws, check tau parameters |
| 0 potentials / 0 observed | Data not binding | Check evidence path, snapshot query |

### Key lesson (21-Mar-26)

Always check `potentials` and `observed` count in the model output
before interpreting MCMC results. A model with 0 likelihood terms
samples from priors and converges perfectly — but tells you nothing.

---

## 4. Compiler Journal

All experiments, failures, and design decisions are recorded in
[doc 18: Compiler Journal](../project-bayes/18-compiler-journal.md).

**Before trying a new approach**: check the journal to see if it's
been tried before and why it failed.

**After completing an experiment**: update the journal with results.

---

## 5. Test Graph Topologies Needed

As the compiler matures, we'll need test graphs covering:

| Topology | Purpose | Status |
|----------|---------|--------|
| Linear chain (4-5 nodes) | Baseline, solo edges | EXISTS: simple graph in data repo |
| Complex (branches + joins) | Full structural features | EXISTS: branch graph in data repo |
| Diamond (5 nodes, 1 join) | Isolate join behaviour | NEEDED |
| Fan-out (5 nodes, 1 branch group) | Isolate Dirichlet | NEEDED |
| Deep cascade (8+ nodes) | Multi-hop FW composition | NEEDED |
| Context-sliced (5 nodes) | Phase C: per-context variation | NEEDED for Phase C |

Create new graphs as proper data repo artefacts with integrity checks.
Don't hand-wave graph structures — use the data repo tooling.

---

## 6. Phase C Testing (Context Slices)

### What's different

Context slices add a dimension of variation: each person has a context
(e.g., `channel=google`) and edge parameters can vary per context.

### What the generator must do (Phase 2)

1. Assign each person a context vector from the truth config's weight
   distribution
2. Override edge parameters per context where specified
3. Produce rows with context-qualified slice_keys:
   `context(channel:google).window()`
4. Also produce aggregate rows: `window()`, `cohort()`
5. All context values share the SAME `core_hash` per edge
6. MECE invariant: `Σ n_slice ≈ n_aggregate`

### Artefact requirements

- Context YAML files in data repo (one per dimension)
- Context definitions in truth config must match context YAML values
- Graph edges' DSL must include context qualifiers

---

## 7. Design Documents

| Doc | Purpose |
|-----|---------|
| [17: Synthetic Data Generator](17-synthetic-data-generator.md) | Full design: noise model, fetch simulation, context slices, FE visibility |
| [18: Compiler Journal](18-compiler-journal.md) | What was tried, what worked, what failed |
| [DEVTOOLS.md](../../bayes/DEVTOOLS.md) | Tool reference: test_wiring, test_harness, diag_run |
| [6: Compiler + Worker](6-compiler-and-worker-pipeline.md) | Compiler IR, model structure, evidence assembly |
| [8: Compiler Phases](8-compiler-implementation-phases.md) | Phase delivery plan (A→B→S→D→C) |
| [14: Phase C Design](14-phase-c-slice-pooling-design.md) | Context slice pooling design |
