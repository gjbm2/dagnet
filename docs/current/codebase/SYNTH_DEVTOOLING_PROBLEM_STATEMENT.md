# Synth Graph Devtooling — Problem Statement and Implementation

**Date**: 17-Apr-26
**Status**: Implemented (Phase 1-3 complete)
**Severity**: Critical — blocks reliable testing, causes repeated multi-hour debugging sessions

---

## The Problem

The synth graph lifecycle — from truth file to working test fixture — requires multiple manual steps, has shallow integrity checks, and provides no mechanism for tests to declare what state they need. When anything in the chain breaks (a connection string typo, a stale hash, a missing enrichment step), the failure manifests as inscrutable test errors far downstream. Diagnosing and repairing these failures is disproportionately expensive and has become a recurring drain.

---

## What the Pipeline Looks Like Today

A synth graph goes through these stages to become a usable test fixture:

| Stage | Tool | What it does | Automated? |
|-------|------|-------------|------------|
| 1. Graph generation | `synth_gen.py --write-files` | Generates graph JSON + entity files from `.truth.yaml` | Yes |
| 2. Simulation | `synth_gen.py --write-files` | Monte Carlo simulation → snapshot rows with placeholder hashes | Yes |
| 3. Hash computation | `synth_gen.py --write-files` | Calls FE CLI per DSL clause → authoritative `core_hash` values | Yes |
| 4. DB write | `synth_gen.py --write-files` | Rehashes rows, writes to snapshot DB, writes param files | Yes |
| 5. Enrichment (Stage 2) | `hydrate.sh` | FE aggregation + FE topo pass + promotion + CF → `model_vars`, posteriors, forecast mean | **Manual** |
| 6. Index rebuild | `synth_gen.py` (partial) | Updates `parameters-index.yaml` | Partial (`nodes-index.yaml` not handled) |
| 7. Verification | `synth_gen.py` | Checks truth hash + row count in DB | **Shallow** |

### What's missing

**No enrichment automation.** `synth_gen.py` explicitly clears analytical params (`forecast`, `mean`, `evidence`, posteriors) from the graph JSON (line 2810-2815). These are populated by `hydrate.sh`, which must be run separately, requires the Python BE on localhost:9000, and is not called by any test setup. Tests that need `model_vars` simply skip with a message telling the developer to run a manual command.

**No declared fixture requirements.** Tests cannot express "I need synth-diamond-test with valid DB hashes and enriched model_vars." Each test independently discovers graphs, queries the DB, and hopes the data is in the right state. When it isn't, the failures are opaque (e.g. `core_hash required`, empty maturity rows, hash mismatches).

**Shallow freshness checks.** `verify_synth_data()` checks:
- Does the truth file hash match the meta sidecar? ✓
- Do rows exist in the DB for the stored hashes? ✓ (count > 0)

It does **not** check:
- Whether `core_hash` values on DB rows are non-empty or correct
- Whether param files exist and contain matching `query_signature` values
- Whether the graph JSON's `defaultConnection` matches what was used for hash computation
- Whether event definition files have changed since generation (these affect `core_hash`)
- Whether enrichment has been performed (no `model_vars` check)
- Whether the workspace prefix (repo + branch) matches the current environment
- Whether `nodes-index.yaml` is up to date

**No idempotent regen.** There is no single call that says "ensure this synth graph is ready for testing." Instead there is `synth_gen.py --write-files` (stages 1-4), `hydrate.sh` (stage 5), and manual verification. `--bust-cache` bypasses the freshness check entirely; without it, stale-but-counted data passes.

---

## Concrete Failures This Has Caused

### 1. Empty `core_hash` — 254k corrupt rows (16-Apr-26)

`graph_from_truth.py` had `defaultConnection: "amplitude"` changed to `"amplitude-prod"`. The connection name is part of the hash canonical. The FE CLI's `snapshotRetrievalsService.ts` had a hardcoded `'amplitude'` fallback that didn't read `graph.defaultConnection`, so the CLI (called by synth_gen Step 2) computed hashes using `"amplitude"` while the graph said `"amplitude-prod"`. This inconsistency caused `buildCandidateRegimesByEdge` to silently fail (bare `catch {}`), producing subjects with empty `core_hash`. 254k rows were written with `core_hash = ''`.

**What should have caught it**: A post-write verification that checks `core_hash != ''` on every written row. Or a freshness check that validates DB rows against meta hashes rather than just counting.

### 2. Hash parity divergence (16-Apr-26)

After regenerating synth data, `synthHashParity.test.ts` failed because the FE runtime computed different hashes from what Python wrote to param files. Root cause: three FE call sites (`snapshotRetrievalsService.ts`, `commitHashGuardService.ts`, `integrityCheckService.ts`) didn't follow the `edge.p.connection → graph.defaultConnection` inheritance pattern used everywhere else.

**What should have caught it**: A post-generation parity check that runs the FE hash computation against every param file's `query_signature` and asserts they match.

### 3. Missing enrichment (recurring)

`test_be_topo_pass_parity.py` skips when `model_vars` are absent, with a message directing the developer to run `test_harness.py --enrich`. This is a manual step with no automation, no freshness tracking, and no way for CI to handle it.

**What should have caught it**: Tests declaring their enrichment requirements, with fixture setup that commissions enrichment if the graph isn't in the required state.

---

## What the Pipeline Should Look Like

### Principle: test declares, tooling provides

A test that depends on a synth graph should declare what it needs:

```python
@requires_synth("synth-diamond-test", enriched=True)
```

or in TS:

```typescript
const graph = await ensureSynthGraph("synth-diamond-test", { enriched: true });
```

The fixture helper (`ensureSynthGraph` / `@requires_synth`) then:

1. **Checks freshness** — comprehensively:
   - Truth file hash matches meta
   - Graph JSON hash matches meta
   - Event definition hashes match meta
   - DB rows exist under each hash in meta, with non-empty `core_hash`
   - Param files exist with matching `query_signature`
   - If `enriched=True`: graph JSON has `model_vars` on relevant edges
   - Workspace prefix matches current environment

2. **If stale or missing** — regenerates idempotently:
   - Runs `synth_gen.py --write-files --bust-cache`
   - If `enriched=True`: runs hydrate/enrichment
   - Verifies post-generation state

3. **If fresh** — returns immediately (sub-second, no DB hit needed if meta checks pass)

### Principle: meta sidecar is the complete record

`.synth-meta.json` should record everything needed to determine freshness without hitting the DB:

```json
{
  "truth_sha256": "...",
  "graph_json_sha256": "...",
  "event_def_hashes": { "event-id": "sha256..." },
  "context_def_hashes": { "dim-id": "sha256..." },
  "connection_name": "amplitude",
  "workspace_prefix": "nous-conversion-feature/bayes-test-graph",
  "edge_hashes": { ... },
  "row_count": 57024,
  "enriched": false,
  "enriched_at": null,
  "generated_at": "17-Apr-26 10:30:00"
}
```

### Principle: one command, full lifecycle

```bash
python -m bayes.synth_gen --graph synth-diamond-test --write-files --enrich
```

This single command handles generation, hash computation, DB write, param files, enrichment, and verification. `--enrich` commissions the topo pass / hydrate step. Without `--enrich`, the graph is generated but not enriched (meta records `enriched: false`).

### Principle: disposable and adaptive

Because regen is idempotent and fast (freshness check is sub-second when clean), synth graphs become disposable. A developer can delete a `.synth-meta.json`, run the tests, and everything rebuilds. A truth file change triggers automatic regen on next test run. No manual steps, no tribal knowledge.

---

## Consumer Audit

Full audit of every test and script that consumes synth graph data: what they need, whether they need enrichment, and how they handle missing prerequisites.

### Tests that consume synth graphs from the data repo

| Consumer | Graph(s) | Enriched? | DB rows? | Param YAML? | Event YAML? | Servers? | Missing prereq |
|---|---|---|---|---|---|---|---|
| `test_doc31_parity.py` | Auto-discover (synth-first) | Yes (forecast.mean + latency) | Yes (valid core_hash) | No | No | None | Clean skip |
| `test_be_topo_pass_parity.py` | `synth-simple-abc` | Yes (model_vars from hydrate) | Yes | No | No | None | `@requires_synth` |
| `test_v2_v3_parity.py` | `synth-simple-abc` | Yes (model_vars from hydrate) | Yes | No | No | None | `@requires_synth` |
| `synthHashParity.test.ts` | `synth-diamond-test` | No | No | Yes (query_signature) | Yes | None | Clean skip |
| `v2-v3-parity-test.sh` | `synth-mirror-4step` (default) | Yes | Yes | Implicit | Implicit | Python BE + Node | Hard fail |
| `asat-blind-test.sh` | `synth-simple-abc` | No | Yes | Yes | Yes | Python BE + Node | Structured PASS/FAIL |
| `window-cohort-convergence-test.sh` | `synth-mirror-4step` (default) | Yes | Yes | Implicit | Implicit | Python BE + Node | Partial reporting |
| `chart-graph-agreement-test.sh` | `synth-mirror-4step` (default) | Yes | Yes | Implicit | Implicit | Python BE + Node | Hard fail |
| `run_regression.py` | All synth (auto-discover) | No (self-enriches) | Yes | Yes | Yes | None | **Self-healing** (auto-bootstrap) |
| `param_recovery.py` | Single (`--graph` arg) | No (harness enriches) | Yes | Yes | Yes | None | Hard fail w/ message |

### Tests that do NOT consume synth graphs (pure unit or self-seeded)

These need no synth tooling: `test_forecast_state_cohort.py` (inline graphs), `test_synth_gen.py` (inline), `test_param_recovery.py` (unit), `test_regression_plans.py` (unit), `test_recency_weighting.py` (unit), `test_results_schema.py` (unit), `test_regression_audit.py` (unit), `snapshotEpochResolution.integration.test.ts` (self-seeded, needs Python BE), `snapshotWritePath.fixture.test.ts` (fixtures, needs Python BE).

### Key synth graphs and their consumers

| Graph | Consumers | Needs enrichment? |
|---|---|---|
| `synth-simple-abc` | test_be_topo_pass_parity, test_v2_v3_parity, asat-blind-test.sh | Yes |
| `synth-diamond-test` | synthHashParity.test.ts | No |
| `synth-mirror-4step` | v2-v3-parity-test.sh, window-cohort-convergence-test.sh, chart-graph-agreement-test.sh | Yes |
| All synth graphs | run_regression.py (auto-discover), test_doc31_parity.py (auto-discover) | run_regression: no (self-enriches); test_doc31: yes |

### Enrichment requirements summary

Three Python tests require enriched graphs: `test_doc31_parity.py`, `test_be_topo_pass_parity.py`, `test_v2_v3_parity.py`. All three check for `model_vars` or `forecast.mean` and skip if absent. The enrichment is produced by `hydrate.sh` (or `test_harness.py --enrich`), which requires the Python BE running. There is no automated path from "graph needs enrichment" to "enrichment happens".

Three shell scripts require enriched graphs: `v2-v3-parity-test.sh`, `window-cohort-convergence-test.sh`, `chart-graph-agreement-test.sh`. They hard-fail if the graph isn't enriched.

`run_regression.py` is the only consumer with self-healing: it auto-bootstraps missing synth data via `verify_synth_data()` + `synth_gen.py`. But even it doesn't handle enrichment — it doesn't need to because the harness enriches as part of the MCMC pipeline.

---

## Scope of Work

### Phase 1: Comprehensive freshness checking

- Extend `.synth-meta.json` to record graph JSON hash, event def hashes, connection name, workspace prefix, enrichment state
- Extend `verify_synth_data()` to check all of the above
- Add post-write verification: every DB row has non-empty `core_hash`, every param file has `query_signature` matching the authoritative hash
- Add hash parity check: FE runtime hash matches param file `query_signature` for at least one edge

### Phase 2: Declarative test fixtures

- Python: `@requires_synth(graph_name, enriched=bool)` decorator / pytest fixture
- TypeScript: `ensureSynthGraph(name, opts)` helper
- Both call `synth_gen.py` with appropriate flags if freshness check fails
- Both skip gracefully if prerequisites (DB_CONNECTION, data repo) are unavailable

### Phase 3: Integrated enrichment

- Add `--enrich` flag to `synth_gen.py` that runs the hydrate / FE-topo pipeline (the historical reference here was to the quick BE topo pass, removed by [project-bayes/73b](../project-bayes/73b-be-topo-removal-and-forecast-state-separation-plan.md); the enrichment now runs through the FE topo pass plus CF only)
- Record enrichment state in meta sidecar
- Tests that need enrichment declare it; fixture helper commissions it if missing

---

## Immediate Actions

1. **Fix the FE connection resolution bug**: three call sites in `snapshotRetrievalsService.ts`, `commitHashGuardService.ts`, `integrityCheckService.ts` need to read `graph.defaultConnection` (matching the pattern used by `fetchPlanBuilderService`, `plannerQuerySignatureService`, and `getFromSourceDirect`). This is the only production code fix.

2. **Build the devtooling** (Phases 1-3 above). The devtooling handles regen, freshness, enrichment, and stale data cleanup. Do not manually rebuild synth graphs — that's what the tooling is for.

---

## Testing Strategy

The devtooling itself requires test coverage, written **blind** (before implementation) to define the contract.

### Freshness checker tests

- Truth file changes → status `stale`
- Graph JSON changes (e.g. connection string) → status `stale`
- Event definition changes → status `stale`
- DB rows with empty `core_hash` → status `corrupt`
- DB rows under wrong hash (not in meta `edge_hashes`) → status `corrupt`
- Param files missing `query_signature` → status `incomplete`
- Param file `query_signature` doesn't match meta hash → status `stale`
- Enrichment required but `model_vars` absent → status `needs_enrichment`
- Everything consistent → status `fresh`
- No DB connection available → status `unknown` (not `fresh`)
- No data repo → graceful skip (not crash)

### Regen pipeline tests

- Regen from clean state produces valid meta sidecar with all fields
- Regen is idempotent: running twice produces identical output
- Regen with `--enrich` produces graph with `model_vars` on relevant edges
- Regen after truth file change updates all downstream artefacts (graph JSON, DB rows, param files, hashes)
- Regen after event definition change recomputes hashes
- Post-regen freshness check returns `fresh`
- Post-regen DB has zero rows with empty `core_hash`
- Post-regen param files all have `query_signature` matching meta hashes

### Declarative fixture tests

- `@requires_synth("X")` on fresh graph → test runs, no regen triggered
- `@requires_synth("X")` on stale graph → regen triggered, then test runs
- `@requires_synth("X", enriched=True)` on unenriched graph → enrichment triggered, then test runs
- `@requires_synth("X")` with no DB_CONNECTION → test skipped cleanly
- `@requires_synth("X")` with no data repo → test skipped cleanly
- `@requires_synth("nonexistent")` → test skipped with clear message
- Multiple tests requiring the same graph → regen happens once (session-scoped)
