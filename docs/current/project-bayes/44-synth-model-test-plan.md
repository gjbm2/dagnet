# Doc 44 -- Synthesised Model Test Plan

**Status**: Draft, 16-Apr-26

## Purpose

Comprehensive test plan for the Bayes compiler across the cartesian product of graph dimensions (context, topology, sparsity, epoch structure). Identifies what is tested, what is not, and what tooling exists.

---

## 1. Dimension Taxonomy

| Dimension | Levels |
|-----------|--------|
| **Context** | Uncontexted (bare), single-dimension MECE, two-dimension orthogonal, conditional_p |
| **Topology** | Solo edge, linear chain, branch group (Dirichlet), diamond (join), fan-out, skip (3-way join), lattice, mirror-4step |
| **Epoch** | Single epoch, mixed (bare + context), staggered (dimension introduction over time) |
| **Sparsity** | Abundant (n>1000), moderate (n~200), sparse (n<100), frame-drop, toggle-rate |
| **Evidence type** | Window only, cohort only, window+cohort, snapshot trajectory, param-file fallback |

Full cartesian is ~320 cells. We test a pragmatic subset that covers each dimension at least twice and all critical intersections.

---

## 2. Coverage Matrix

### Current state (26 graphs + 6 proposed)

| Topology | Bare | 1-dim | 2-dim | Mixed-epoch | Staggered | Sparse bare | Sparse+ctx | Sparse+2-dim |
|----------|------|-------|-------|-------------|-----------|-------------|------------|--------------|
| Solo edge | -- | Y | Y | Y | Y | -- | -- | **NEW** |
| Linear (abc) | Y | Y | **NEW** | **NEW** | -- | **NEW** | -- | -- |
| Diamond | Y | Y | **NEW** | **NEW** | -- | -- | Y | -- |
| Skip | Y | Y | -- | -- | -- | -- | Y | -- |
| Fan-out | Y | Y | -- | Y | -- | -- | -- | -- |
| Mirror-4step | Y | Y | -- | -- | -- | -- | -- | -- |
| Join-branch | Y | Y | -- | -- | -- | -- | -- | -- |
| 3-way-join | Y | Y | -- | -- | -- | -- | -- | -- |
| Lattice | Y | Y | -- | -- | -- | -- | -- | -- |

**NEW** = proposed new graph (truth YAML drafted in `bayes/plans/new-graph-drafts/`).

### Existing graphs (26)

**Uncontexted (10)**: synth-simple-abc, synth-diamond-test, synth-skip-test, synth-3way-join-test, synth-join-branch-test, synth-fanout-test, synth-mirror-4step, synth-drift3d10d, synth-drift10d10d, synth-forecast-test

**1-dim contexted (9)**: synth-context-solo, synth-simple-abc-context, synth-diamond-context, synth-skip-context, synth-fanout-context, synth-mirror-4step-context, synth-join-branch-context, synth-3way-join-context, synth-lattice-context

**2-dim orthogonal (1)**: synth-context-two-dim (solo edge only)

**Mixed-epoch (2)**: synth-context-solo-mixed, synth-fanout-context-mixed

**Staggered (1)**: synth-context-staggered

**Sparse (2)**: synth-diamond-context-sparse, synth-skip-context-sparse

**Lattice (1)**: synth-lattice-test

### Proposed new graphs (6)

| Graph | Gap filled | Topology | Context | Sparsity |
|-------|-----------|----------|---------|----------|
| synth-diamond-context-two-dim | 2-dim × join | Diamond | 2-dim (channel + device) | -- |
| synth-diamond-context-mixed | mixed-epoch × join | Diamond | mixed-epoch | -- |
| synth-abc-context-two-dim | 2-dim × chain | Linear | 2-dim (channel + device) | -- |
| synth-abc-context-mixed | mixed-epoch × chain | Linear | mixed-epoch | -- |
| synth-abc-sparse | sparse × bare baseline | Linear | bare | frame_drop=0.20 |
| synth-context-two-dim-sparse | sparse × 2-dim (hardest combo) | Solo | 2-dim | frame_drop=0.20 |

Truth YAMLs are drafted in `bayes/plans/new-graph-drafts/`. To activate: copy to data repo graphs dir, run `synth_gen.py --graph <name> --write-files` to generate the graph JSON and snapshot data.

---

## 3. What Is Tested (MCMC recovery)

The test harness (`test_harness.py`) + `test_param_recovery.py` auto-discovers all synth graphs and runs MCMC recovery with per-graph z-score assertions from truth files. This gives **broad coverage** -- every synth graph with a `.truth.yaml` gets tested.

Below is the status of **targeted, assertion-bearing unit tests** (independent of the recovery harness).

### Phase A -- Solo edges (Beta+Binomial)
| Scenario | Test | Status |
|----------|------|--------|
| Abundant window (n=10k) | `test_compiler_phase_a::A1` | DONE |
| Sparse window (n=50) | `test_compiler_phase_a::A2` | DONE |
| Window + cohort | `test_compiler_phase_a::A3` | DONE |
| Immature cohort only | `test_compiler_phase_a::A4` | XFAIL (known) |
| Linear chain (3 solo) | `test_compiler_phase_a::A5` | DONE |

### Phase B -- Branch groups (Dirichlet)
| Scenario | Test | Status |
|----------|------|--------|
| Symmetric 3-way | `test_compiler_phase_b::B1` | DONE |
| Asymmetric 3-way | `test_compiler_phase_b::B2` | DONE |
| Near-exhaustive | `test_compiler_phase_b::B3` | DONE |
| Exhaustive | `test_compiler_phase_b::B4` | DONE |
| Large dropout | `test_compiler_phase_b::B5` | DONE |
| Solo edge regression | `test_compiler_phase_b::B6` | DONE |
| Sparse branch | `test_compiler_phase_b::B7` | DONE |

### Phase S -- Snapshot evidence
| Scenario | Test | Status |
|----------|------|--------|
| Trajectory binding | `test_compiler_phase_s::S1` | DONE (model build) |
| Fallback to param file | `test_compiler_phase_s::S3` | DONE (model build) |
| No double-counting | `test_compiler_phase_s` | DONE |

### Phase C -- Context routing
| Scenario | Test | Status |
|----------|------|--------|
| Single-dim MECE slices | `test_compiler_phase_s::contexted` | DONE (model build) |
| Two-dim orthogonal | `test_compiler_phase_s::two_dimension` | DONE (model build) |
| Staggered epoch | `test_compiler_phase_s::staggered` | DONE (model build) |
| conditional_p | `test_compiler_phase_s::conditional_p` | DONE (topology + binding) |
| Per-slice tau | `test_compiler_phase_s` | DONE |

### Evidence binding invariants
| Scenario | Test | Status |
|----------|------|--------|
| Volume conservation (MECE) | `test_data_binding_parity` | DONE |
| Symmetry (row order, hash label) | `test_data_binding_parity` | DONE |
| Regime grouping | `test_data_binding_parity` | DONE |
| Adversarial slice_key formats | `test_data_binding_adversarial` | DONE |
| Chain survival | `test_data_binding_adversarial` | DONE |
| Hash failure fallback | `test_data_binding_adversarial` | DONE |

### Other
| Scenario | Test | Status |
|----------|------|--------|
| DSL explosion | `test_dsl_explosion` (9 classes) | DONE |
| LOO-ELPD scoring | `test_loo` | DONE |
| Model wiring (no MCMC) | `test_model_wiring` | DONE |
| Binding receipts | `test_binding_receipt` | DONE |
| Serialisation | `test_serialisation` | DONE |
| Engorged parity | `test_engorged_parity` | DONE |
| Stall detector | `test_stall_detector` | DONE |
| Warm-start roundtrip | `test_model_wiring::warm_start` | DONE |
| Phase 2 debug dump | `test_worker_phase2_dump` | DONE |
| Core hash parity | `querySignature.contextParity.test.ts` | DONE |
| asat blind test | `test_asat_contract.py` + `asat-blind-test.sh` | DONE |

---

## 4. Gaps and Priorities

### Gap 1: 2-dim / cross-product on non-trivial topologies
**What**: Cross-product DSL exists on exactly one graph (solo edge). No topology coverage.
**Risk**: Wiring bugs in cross-product slices on join nodes would go undetected.
**Fix**: synth-diamond-context-two-dim + synth-abc-context-two-dim (drafted).
**Priority**: HIGH

### Gap 2: Mixed-epoch on non-trivial topologies
**What**: Mixed-epoch exists on solo edge + fanout only. No join/chain coverage.
**Risk**: Epoch boundary routing interacting with join topology untested. Regression risk from doc 43b fix.
**Fix**: synth-diamond-context-mixed + synth-abc-context-mixed (drafted).
**Priority**: HIGH

### Gap 3: Bare sparse baseline
**What**: Both existing sparse graphs are contexted. No isolated sparsity test.
**Risk**: Can't distinguish sparsity-caused failures from context-caused failures.
**Fix**: synth-abc-sparse (drafted).
**Priority**: MEDIUM

### Gap 4: Sparse + 2-dim
**What**: Hardest combination for the compiler. Does not exist.
**Risk**: Sparse × cross-product is the most fragile regime.
**Fix**: synth-context-two-dim-sparse (drafted).
**Priority**: MEDIUM

### Gap 5: conditional_p model emission
**What**: Topology and binding tested but model doesn't emit conditional_p variables.
**Priority**: MEDIUM (blocked on implementation)

### Gap 6: Subsumption hierarchy
**What**: No builder or test for hierarchical context.
**Priority**: LOW (not designed)

### Gap 7: asat evidence filtering under MCMC
**What**: DB-level filtering tested but no full pipeline test.
**Priority**: HIGH (blocked on D2/D5 -- doc 42b)

### Gap 8: FE synth end-to-end
**What**: No test from synth data through forecast engine to chart output.
**Priority**: MEDIUM (blocked on Phase G.1 -- doc 29f)

---

## 5. Config-Driven Regression Runner

### Overview

`bayes/regression_plans.py` wraps `run_regression.py` with JSON plan files. Plans define graph selections (glob patterns), sampling parameters, feature flags, worker settings, and optional **variants** for A/B model comparisons.

### Usage

```bash
. graph-editor/venv/bin/activate

# List plans
python bayes/regression_plans.py --list

# Run a plan
python bayes/regression_plans.py --plan overnight-full
python bayes/regression_plans.py --plan smoke --chains 2

# Dry run (show what would execute)
python bayes/regression_plans.py --plan context-focus --dry-run

# Custom plan file
python bayes/regression_plans.py --plan-file path/to/custom.json
```

### Plan schema

```json
{
    "name": "plan-name",
    "description": "Human-readable description",
    "graphs": {
        "include": ["synth-*-context*"],
        "exclude": ["*-forecast-*"]
    },
    "sampling": {
        "chains": 3,
        "draws": 1000,
        "tune": 500,
        "max_parallel": null,
        "no_timeout": false
    },
    "features": ["latency_dispersion=true"],
    "settings": {"target_accept": 0.95},
    "tags": ["context"],
    "variants": [
        {
            "name": "baseline",
            "features": [],
            "settings": {}
        },
        {
            "name": "with-kappa-lat",
            "features": ["latency_dispersion=true"],
            "settings": {"target_accept": 0.95}
        }
    ]
}
```

Key fields:
- **graphs.include / exclude**: Glob patterns against graph names. `["*"]` = all discovered.
- **features**: List of `KEY=VALUE` strings passed as `--feature` flags to the harness.
- **settings**: Arbitrary JSON merged into the worker settings payload (e.g. `target_accept`, `overprovision_chains`).
- **variants**: When present, the plan runs once per variant with that variant's features/settings layered on top of the plan-level ones. Produces a cross-variant comparison table.

### Built-in plans (`bayes/plans/`)

| Plan | Description | Graphs | Est. time |
|------|-------------|--------|-----------|
| `smoke` | Quick sanity (3 small graphs, reduced sampling) | 3 | ~10 min |
| `topology-bare` | All bare topologies | 8 | ~45 min |
| `context-focus` | All contexted graphs (1-dim, 2-dim, mixed, staggered) | ~15 | ~3 hr |
| `two-dim` | Two-dimension / cross-product DSL graphs | 2-4 | ~2 hr |
| `mixed-epoch` | Mixed-epoch and staggered | 3-5 | ~2 hr |
| `sparsity-sweep` | Sparse graphs only | 2-4 | ~1.5 hr |
| `overnight-full` | All synth graphs, full sampling, no timeout | ~25 | ~8 hr |
| `model-ab-latdisp` | A/B: baseline vs latency_dispersion | 6 × 2 variants | ~3 hr |

---

## 6. Dev Tooling Inventory

### Test harness (`bayes/test_harness.py`)
- Full CLI for running `fit_graph` with logging, warm-start, timeout, heartbeat
- Auto-discovers synth graphs, bootstraps missing data
- Post-run: posterior summary, ground-truth z-score recovery, analytic comparison
- Flags: `--graph`, `--asat`, `--phase2-from-dump`, `--dump-evidence`, `--enrich`, `--fresh-priors`, `--diag`, `--feature`, `--draws/tune/chains/cores`, `--settings-json`, `--job-label`

### Regression orchestrator (`bayes/run_regression.py`)
- Discover → bootstrap → parallel MCMC → assert → multi-layer audit report
- Incremental summary file (survives crash), bias profile, aggregate cross-graph profile
- Flags: `--graph`, `--include`, `--exclude`, `--preflight-only`, `--feature`, `--no-timeout`, `--clean`, `--rebuild`

### Config-driven plan runner (`bayes/regression_plans.py`)
- JSON plan files with graph globs, sampling overrides, feature flags, settings, variants
- Dry-run mode, plan discovery, CLI override of any sampling param
- Cross-variant comparison table for A/B model testing

### Synth data generator (`bayes/synth_gen.py`)
- Monte Carlo population simulation through any DAG topology
- Supports context dimensions, epochs, drift, sparsity (frame_drop_rate, toggle_rate)
- Auto-verification against DB, `.synth-meta.json` sidecar files

### Synthetic builders (`bayes/tests/synthetic.py`)
- 14 in-memory builders covering Phases A, B, S, C
- Helpers for window/cohort/snapshot data generation

### DSL explosion (`bayes/dsl_explosion.py`)
- Recursive descent parser for compound DSL, tested with 9 test classes

### Graph-ops scripts
| Script | Purpose |
|--------|---------|
| `v2-v3-parity-test.sh` | 17-check v2/v3 cohort maturity parity |
| `asat-blind-test.sh` | asat evidence filtering integration |
| `chart-graph-agreement-test.sh` | Chart-graph agreement validation |
| `analyse.sh` | CLI analyse (same pipeline as browser) |
| `bayes.sh` | Build Bayes payload |
| `param-pack.sh` | Parameter packaging |

---

## 7. Open Issues Cross-Reference

| Issue | Doc | Status | Test impact |
|-------|-----|--------|-------------|
| Context hash parity | 43b | RESOLVED | New mixed-epoch graphs are regression guards |
| Synth hash assignment | 43 | RESOLVED | Synth data now correct |
| CLI topo pass scoping | 29f D18 | RESOLVED | Unblocks CLI-based test runs |
| asat cohort_maturity | 42b D5 | OPEN | Blocks gap 7 |
| asat posterior from fit_history | 42b D2 | OPEN | Blocks gap 7 |
| asat completeness at historical age | 42b D3 | OPEN | Blocks gap 7 |
| MC sweep Y_total flatness | 29f G.4 | OPEN | Blocks gap 8 |
| conditional_p emission | Phase C | NOT STARTED | Blocks gap 5 |
