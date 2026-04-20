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
Multiple graphs can run in parallel — each gets its own lock file
and log file. Use `scripts/bayes-monitor.sh` to watch all active runs.

### Common Commands

```bash
# ── Model inspection (fast, ~5s) ──
python bayes/test_harness.py --graph simple --no-mcmc --no-webhook
# Shows full model structure (free RVs, potentials, evidence binding)
# then stops before MCMC. Always prints model structure even without --no-mcmc.

# ── MCMC on production data ──
python bayes/test_harness.py --graph simple --no-webhook        # 4-step prod (~60s)
python bayes/test_harness.py --graph branch --no-webhook --timeout 900  # complex (~5-10min)

# ── Feature flag A/B (no code changes) ──
python bayes/test_harness.py --graph X --feature latent_onset=false
python bayes/test_harness.py --graph X --feature overdispersion=false
python bayes/test_harness.py --graph X --feature jax_backend=false  # force numba (JAX is default)

# ── Parameter recovery (single graph) ──
python bayes/param_recovery.py --graph synth-simple-abc          # 2-step (~101s with JAX)
python bayes/param_recovery.py --graph synth-mirror-4step        # 4-step (~81s with JAX)
python bayes/param_recovery.py --graph synth-simple-abc --chains 3  # reduced chain count
python bayes/param_recovery.py --graph synth-fanout-context      # contexted (JAX default)
python bayes/param_recovery.py --graph synth-diamond-context \
  --phase2-from-dump /tmp/bayes_debug-graph-synth-diamond-context \
  --chains 2 --draws 500 --tune 1000 --timeout 0                # Phase 2 replay
# Reads .truth.yaml, runs MCMC, prints structured truth vs posterior comparison.
# JAX backend is the default since 13-Apr-26 — no --feature flag needed.
# NOT for production data — use test_harness.py directly.
# --clean: clear __pycache__ only. --rebuild: also delete .synth-meta.json (heavy DB re-insert).
# --phase2-from-dump: skip Phase 1, load artefacts from dump dir, run Phase 2 only.

# ── Regression suite (preferred — discovery, bootstrap, core-aware parallel, assertions) ──
python bayes/run_regression.py                                   # full suite, all discovered graphs
python bayes/run_regression.py --graph synth-fanout-test         # single graph
python bayes/run_regression.py --preflight-only                  # check data integrity only
python bayes/run_regression.py --chains 2 --max-parallel 2       # ceiling — JAX fans across cores
python bayes/run_regression.py --include context --max-parallel 1 --no-timeout
# Auto-discovers synth-*.truth.yaml, bootstraps missing data, manages
# parallel execution with core awareness, asserts z-score recovery.
# Writes to /tmp/bayes_harness-{graph}.log — bayes-monitor compatible.
# --no-timeout: disable all timeout layers (for large/novel graphs).

# ── Monitor active runs ──
scripts/bayes-monitor.sh                                         # auto-discover active runs
scripts/bayes-monitor.sh synth-simple-abc synth-mirror-4step     # specific graphs
scripts/bayes-monitor.sh --all                                   # include finished runs
# Opens a tmux session: status summary (top) + tailed logs (bottom).
# Works for any harness run — manual, param recovery, or regression.

# ── Regression tests (pytest wrapper) ──
pytest bayes/tests/test_param_recovery.py -v -s --timeout=600   # all synth graphs
pytest bayes/tests/test_param_recovery.py -k "synth-simple-abc" -v -s  # single
# Thin wrapper around run_regression.py — same execution pipeline.

# ── Synthetic data generation ──
python bayes/synth_gen.py --graph simple --write-files           # regen DB + param files
python bayes/synth_gen.py --graph simple --write-files --enrich  # regen + hydrate (topo pass)
python bayes/synth_gen.py --graph simple --dry-run               # preview only
python bayes/synth_gen.py --clean --graph simple                 # remove synth rows from DB
python bayes/synth_gen.py --graph simple --write-files --bust-cache  # force regen even if fresh
# IMPORTANT: --write-files is required to update param files on disk.
# synth_gen FAILS without a .truth.yaml sidecar (no silent defaults).
# --enrich runs hydrate.sh after generation (requires Python BE on localhost:9000).
# --bust-cache skips the freshness check and regenerates unconditionally.

# ── Graph validation (before committing data repo changes) ──
bash graph-ops/scripts/validate-graph.sh graphs/<name>.json       # structural (~1s)
bash graph-ops/scripts/validate-graph.sh graphs/<name>.json --deep  # + IntegrityCheckService (~10s)

# ── Diagnostics ──
python bayes/diag_run.py                                         # per-variable rhat/ESS
python bayes/diag_run.py --no-latency                            # fixed latency (Phase S)
python bayes/diag_run.py --exclude delegation-straight           # exclude edge
```

### Log and Output Files

| File | Purpose |
|------|---------|
| `/tmp/bayes_harness-{graph}.log` | Per-graph harness log (progress, diagnostics, posteriors) |
| `/tmp/bayes_recovery-{graph}.log` | Per-graph param recovery output (truth comparison, PASS/FAIL) |
| `/tmp/bayes_diagnostics.txt` | Per-variable diagnostic report from diag_run |

### Two workflows: param recovery vs production

| | Param recovery | Production |
|---|---|---|
| **Purpose** | Does the model recover known parameters? | Does the model converge on real data? |
| **Tool** | `param_recovery.py` / `run-param-recovery.sh` | `test_harness.py` |
| **Data** | Synthetic (synth_gen.py) | Real (snapshot DB) |
| **Ground truth** | .truth.yaml sidecar | None (no ground truth) |
| **Output** | Structured comparison (z-scores, PASS/MISS) | Quality metrics (rhat, ESS, divergences) |
| **Parallel** | `run-param-recovery.sh` (N graphs at once) | Run multiple harness instances manually |
| **Monitor** | `scripts/bayes-monitor.sh` | `scripts/bayes-monitor.sh` |
| **When** | Before merging model changes | After model changes, on production graphs |
| **Graphs** | `--list` shows all available synth graphs | bayes-test-gm-rebuild, branch |

---

## 1. Test Graphs

### Available graphs

| Name | Flag | Edges | Structure | Tests |
|------|------|-------|-----------|-------|
| simple | `--graph simple` | 4 | Linear chain | Basic convergence, latency, Phase D |
| branch | `--graph branch` | 10 (17 total) | Branch groups, 4 joins, diamonds | Branches, joins, DM, Phase C/D |

Both live in the data repo as full artefact sets (graph JSON, node
YAMLs, event YAMLs, param YAMLs, indexes).

### Truth file formats

All synth graphs use the new-format truth file (with `graph:`,
`nodes:`, and `edges:` sections containing `from`/`to`). Ten older
graphs were migrated from the old format (edges-only) on 17-Apr-26
using `bayes/migrate_truth_files.py`. These carry `raw_ids: true` in
the `graph:` section, which tells `graph_from_truth.py` to use node
and edge IDs as-is without prefixing.

New graphs created from scratch do NOT need `raw_ids` — the default
prefixing convention (short keys prefixed with the graph name) is
correct for them.

**Connection string**: all synth graphs use `defaultConnection: "amplitude"`
(a fake name that can't trigger real Amplitude fetches). Do NOT use
`"amplitude-prod"` — that's the real connection and could cause
accidental live data queries.

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

### Freshness checking

`verify_synth_data(graph_name, data_repo)` performs a comprehensive
v2 freshness check across all dimensions:

- Truth file SHA256 matches `.synth-meta.json`
- Graph JSON SHA256 matches meta
- Event definition hashes match meta
- DB rows exist for each stored hash with non-empty `core_hash`
- Parameter files exist with matching `query_signature` (when `check_param_files=True`)
- Enrichment state (bayesian `model_vars` present, when `check_enrichment=True`)
- Connection string consistency (`graph.defaultConnection` vs meta)
- Meta sidecar schema version (v1 → forces regen)

Returns `{status, reason, reasons, row_count, truth_sha256, graph_sha256, enriched, meta}`.

### Declarative test fixtures

Tests that depend on synth graphs use the `@requires_synth` decorator
from `graph-editor/lib/tests/conftest.py`:

```python
from conftest import requires_synth, requires_db, requires_data_repo

@requires_db
@requires_data_repo
class TestMyFeature:
    @requires_synth("synth-simple-abc", enriched=True)
    def test_something(self):
        # Graph is guaranteed to be fresh + enriched at this point.
        # If it was stale, synth_gen.py ran automatically.
        # If it wasn't enriched, hydrate.sh ran automatically.
        ...
```

The decorator:
- Calls `verify_synth_data()` with comprehensive checks
- If stale/missing: runs `synth_gen.py --write-files` as subprocess
- If `enriched=True` and not enriched: runs `synth_gen.py --enrich`
- If no data repo or DB: skips the test cleanly
- Session-scoped: regen happens at most once per graph per session

Shared fixtures also available: `requires_db`, `requires_data_repo`,
`_resolve_data_repo_dir()`, `_resolve_db_url()`.

### Enrichment

Enrichment populates analytical params (`model_vars`, promoted
posteriors, forecast mean) via the FE topo pass pipeline. This is
what `hydrate.sh` does, and what `synth_gen.py --enrich` commissions.

Tests that need enriched graphs (e.g. `test_be_topo_pass_parity.py`,
`test_v2_v3_parity.py`) should use `@requires_synth(name, enriched=True)`.
Enrichment requires the Python BE running on localhost:9000.

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

## 5. Regression Test Suite

### Architecture

The regression pipeline has three layers, all sharing the same
execution path (`param_recovery.py` → `test_harness.py`):

| Layer | Tool | Purpose |
|---|---|---|
| **Orchestrator** | `bayes/run_regression.py` | Discovery, bootstrap, core-aware parallel, assertions |
| **pytest wrapper** | `bayes/tests/test_param_recovery.py` | Thin wrapper for CI/pytest reporting |
| **Single-graph tools** | `test_harness.py`, `param_recovery.py` | Direct execution (prod or synth) |

The orchestrator is the primary entry point. It auto-discovers synth
graphs from truth files, bootstraps missing data, manages parallel
execution respecting available cores, and applies z-score assertions.

### Running

```bash
. graph-editor/venv/bin/activate

# Full regression (preferred — parallel, core-aware, bayes-monitor visible):
python bayes/run_regression.py
scripts/bayes-monitor.sh   # in another terminal

# Single graph:
python bayes/run_regression.py --graph synth-fanout-test

# Preflight only (check data integrity, no MCMC):
python bayes/run_regression.py --preflight-only

# Override core budget (max-parallel hard-capped at 2 — JAX fans across CPU cores):
python bayes/run_regression.py --chains 2 --max-parallel 2

# Via pytest (sequential, same pipeline):
pytest bayes/tests/test_param_recovery.py -v -s --timeout=600
pytest bayes/tests/test_param_recovery.py -k "synth-simple-abc" -v -s
```

### What it tests

Tests are auto-discovered from `synth-*.truth.yaml` files in the data
repo. Adding a new graph requires only a truth file — no code changes.

| Graph | Topology | Edges | Status |
|---|---|---|---|
| synth-simple-abc | Chain (all latency) | 2 | PASS |
| synth-mirror-4step | Chain (mixed latency) | 4 | PASS |
| synth-fanout-test | Fan-out (Dirichlet) | 2 | PASS |
| synth-skip-test | Skip edge (unequal paths) | 4 | PASS |
| synth-diamond-test | Diamond (branch + join) | 6 | xfail |
| synth-3way-join-test | 3-way join | 7 | xfail |
| synth-join-branch-test | Join → branch | 6 | xfail |
| synth-lattice-test | Lattice (cross-connected) | 8 | xfail |

Default sampling: 1000 draws, 500 tune, 3 chains. Thread-pinning
(`OMP_NUM_THREADS=1`, etc.) prevents BLAS/OpenMP oversubscription.

### Assertion strategy

Based on simulation-based calibration (SBC) best practice. Z-scores
are the primary metric — scale-free, accounts for posterior uncertainty.

**Per-parameter thresholds** (stratified by parameter type, not topology):

| Parameter | z threshold | Rationale |
|---|---|---|
| Probability (p) | \|z\| < 2.5 | Well-identified |
| Latency mean (mu) | \|z\| < 2.5 | Well-identified |
| Latency stdev (sigma) | \|z\| < 3.0 | Variance-like, harder |
| Onset | \|z\| < 3.0 | Variance-like, harder |
| Kappa (overdispersion) | Not tested | Known noise model limitation |

**Global convergence gates** (must pass before parameter checks):
- rhat < 1.05, ESS > 200, 0 divergences, convergence ≥ 90%

**Per-graph overrides**: truth files can include a `testing:` section
with custom thresholds, xfail reasons, and timeouts.

### Data integrity

Synth data is expensive to generate. The pipeline preserves it across
sessions and validates freshness via checksums:

1. After generation, `synth_gen.py` writes a `.synth-meta.json` sidecar
   containing the truth file SHA-256, DB row counts, and edge hashes.
2. On subsequent runs, `run_regression.py` verifies the truth file hash
   matches the meta. If stale (truth changed), it regenerates.
3. DB row counts are verified against stored hashes. If 0 rows found,
   it regenerates.
4. Data is never deleted after a run — only regenerated when stale.

### Prerequisites

- DB_CONNECTION in `graph-editor/.env.local`
- Node.js available (for FE hash computation during bootstrap)
- Data repo with truth files (synth data auto-generated if missing)

### Adding new test graphs

1. Create a `synth-{name}.truth.yaml` in `data-repo/graphs/` with:
   - `graph:` section (name, description)
   - `nodes:` section (topology structure)
   - `edges:` section (from/to + ground-truth p, onset, mu, sigma)
   - `simulation:` section (traffic, days, seed)
   - Optional `testing:` section (xfail_reason, thresholds, timeout)
2. Run `python bayes/run_regression.py --graph synth-{name}`
   — bootstraps automatically (generates graph JSON, entity files, DB data)
3. That's it. The graph is now part of the regression suite.

For new-format truth files (with `graph:` + `nodes:` sections),
`graph_from_truth.py` generates all artefacts automatically. No need
to hand-craft graph JSON or entity files.

### Known issues (25-Mar-26)

- **Kappa recovery not testable (Phase 1 noise model)**: posterior κ is
  10-45x truth because synth_gen applies overdispersion per-day (one Beta
  draw shared by all users), creating no within-trajectory overdispersion.
  The model correctly finds large κ. Real overdispersion comes from
  population heterogeneity (contexts). κ recovery requires the Phase C
  three-layer noise model (contexts + per-user variation + drift).
  See doc 17 §3.1 for the full noise model design.
- **Join-node convergence**: diamond, 3-way-join, join-branch, and
  lattice graphs are xfail. The p-latency identifiability coupling at
  joins creates difficult posterior geometry for NUTS.
- **Slow-latency trajectory density**: truth mu > 2.0 produces 50-80
  ages per trajectory after dedup, causing long compilation and slow
  sampling. Truth files use mu ≤ 1.5 where possible.
- **Latency posterior SDs overstate predictive certainty** (9-Apr-26):
  `mu_sd`, `sigma_sd`, `onset_sd` are raw MCMC posterior SDs — they
  measure parameter estimation precision, not predictive spread.
  With many trajectories, these shrink to ±0.005 (mu) or ±0.010
  (onset), implying we can predict conversion timing to sub-day
  precision. In reality, individual conversion times vary with
  spread `sigma` (the LogNormal scale parameter). The fix: derive
  predictive latency uncertainty that incorporates sigma, analogous
  to how predictive p incorporates kappa via `Beta(p*κ, (1-p)*κ)`.
  Applies to both uncontexted and per-slice latency posteriors.
  Pre-existing issue — not specific to Phase C.

---

## 6. Test Graph Topologies — Structural Canon

Every fundamental DAG shape must be proven with param recovery before
moving to Phase C (contexts). Each shape isolates a specific model
feature. If a test fails, we know exactly which feature is broken.

All 8 shapes have truth files and are auto-discovered by
`run_regression.py`. Adding a new shape requires only a truth file.

| # | Shape | Graph | Structure | Tests | Status |
|---|---|---|---|---|---|
| 1 | Chain | synth-simple-abc | A→B→C (all latency) | FW composition, onset-mu | PASS |
| 2 | Chain (mixed) | synth-mirror-4step | A→B→C→D→E (2 no-lat + 2 lat) | Mixed model, cohort hierarchy | PASS |
| 3 | Fan-out | synth-fanout-test | A→{B,C,dropout} (asymmetric latency) | Dirichlet, per-sibling completeness | PASS |
| 4 | Diamond | synth-diamond-test | A→{B,C}→D→E | Branch + join, mixture CDF | xfail |
| 5 | Skip edge | synth-skip-test | A→B→C + A→C (shortcut) | Join with different path lengths | IN SUITE |
| 6 | Join→branch | synth-join-branch-test | A→{B,C}→D→{E,F} | Mixture CDF flowing into Dirichlet | xfail |
| 7 | 3-way join | synth-3way-join-test | A→{B,C,D}→E | Mixture with 3+ components | xfail |
| 8 | Lattice | synth-lattice-test | A→{B,C}→{D,E}→F (cross-connections) | Combinatorial paths, nested joins | xfail |
| 9 | Asymmetric diamond | (variant of #4) | A→{B(95%),C(5%)}→D | Weak-path identifiability | NEEDED |
| 10 | Case node | synth-case-test | A→case→{variant,control} | Exhaustive Dirichlet (no dropout) | NEEDED |

Shapes 1-3 and 5 are expected to pass. Shapes 4, 6-8 are xfail
(join-node geometry). Shapes 9-10 are future work.

**Principles**:
- One graph per structural feature for isolation
- 500/day traffic (geometry, not performance)
- Fast latencies (mu ≤ 1.5) to keep trajectories sparse
- New-format truth files (with `graph:` + `nodes:` sections) so
  `graph_from_truth.py` generates all artefacts automatically
- Data integrity tracked via `.synth-meta.json` sidecars

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
