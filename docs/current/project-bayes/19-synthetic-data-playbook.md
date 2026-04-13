# Doc 19: Synthetic Data Playbook

**Created**: 22-Mar-26
**Purpose**: Step-by-step guide for creating synthetic test graphs,
generating data, inspecting in the FE, and running Bayes parameter
recovery fits.

---

## 1. Prerequisites

- Data repo checked out on a feature branch (e.g. `feature/bayes-test-graph`)
- Python venv activated: `. graph-editor/venv/bin/activate`
- DB tunnel running (for snapshot writes)
- Node available via nvm for vitest

---

## 2. Create a New Synthetic Graph

### 2.1 Graph JSON

Create `graphs/synth-{name}.json` in the data repo. Required structure:

```
nodes:
  - Anchor node: entry.is_start: true, event_id: "synth-{name}-anchor-event"
  - Intermediate nodes: event_id set, absorbing: false
  - Absorbing dropout: absorbing: true, NO event_id

edges:
  - Evented edges: p.id, p.latency.latency_parameter: true,
    p.latency.anchor_node_id, p.cohort_anchor_event_id, query,
    fromHandle: "{dir}-out", toHandle: "{dir}"
  - Dropout edges: fromHandle: "bottom-out", toHandle: "top",
    p.mean set to complement probability
```

**Critical structural requirements**:
- Every non-absorbing node needs a complement edge to an absorbing node
- `fromHandle` must have `-out` suffix (e.g. `right-out`, `bottom-out`)
- `toHandle` must NOT have `-out` suffix (e.g. `left`, `top`)
- `p.cohort_anchor_event_id` must be set on all evented edges
- `p.latency.anchor_node_id` must reference the start node's ID
- Edge UUIDs must be valid v4 format
- ALL UUIDs (nodes + edges) must be unique across all synth graphs —
  shared UUIDs cause DB data collisions between graphs
- Dropout edge `p.mean` must equal `1 - truth_p` for the sibling
  main edge (mass conservation)

**Validating structural integrity** (MANDATORY before generating data):
```bash
bash graph-ops/scripts/validate-graph.sh graphs/synth-{name}.json
bash graph-ops/scripts/validate-graph.sh graphs/synth-{name}.json --deep  # also runs production IntegrityCheckService via Vitest
```
This runs 23 structural checks (JSON validity, node/event bindings,
edge references, UUID uniqueness, handle format, mass conservation,
parameter bindings, simulation guard, etc.). Fix ALL errors before
proceeding to data generation.

**Do NOT set** on graph edges: `mu`, `sigma`, `onset_delta_days`, `t95`,
`path_t95`, `forecast.mean`, `p.mean`, `p.n`. These are derived by the
FE stats pass after data is loaded.

### 2.2 Truth sidecar

Create `graphs/synth-{name}.truth.yaml`:

```yaml
simulation:
  mean_daily_traffic: 5000
  n_days: 100
  kappa_sim_default: 50.0
  failure_rate: 0.05
  drift_sigma: 0.0
  growth_rate_mom: 0.0
  seed: 42

edges:
  {param-id}:
    p: 0.7
    onset: 1.0
    mu: 2.3
    sigma: 0.5
```

**Choosing latency parameters**: use onset 1-3d, mu 2.0-2.5, sigma 0.4-0.6
for realistic 5-15 day per-edge latencies. Avoid very fast latency
(mu < 1.5) as it produces insufficient maturation signal.

### 2.3 Supporting files

Create event YAMLs in `events/` and node YAMLs in `nodes/` for each
node/event. Minimal format:

```yaml
id: "synth-{name}-event"
name: "Synth {name} Event"
category: synthetic
tags: [synthetic]
provider_event_names:
  amplitude: "Synth {name} Event"
```

### 2.4 Register in GRAPH_CONFIGS

Add an entry to `GRAPH_CONFIGS` in `bayes/synth_gen.py`:

```python
"my-graph": {
    "graph_file": "synth-{name}.json",
    "graph_id": "graph-synth-{name}",
    "edges": [
        ("param-id", "edge-uuid", "SYNTH-w", "SYNTH-c"),
    ],
    "base_date": "2025-12-12",
},
```

The hash placeholders (`SYNTH-*`) are replaced by real computed hashes
at runtime.

---

## 3. Generate Synthetic Data

```bash
. graph-editor/venv/bin/activate

# Dry run (verify topology, no writes)
python bayes/synth_gen.py --graph {name} --dry-run

# Full generation (DB + files)
python bayes/synth_gen.py --graph {name} --write-files

# With options
python bayes/synth_gen.py --graph {name} --write-files \
  --people 10000 --days 200 --kappa 20 --drift 0.02 --growth 0.05
```

### 3.1 Pipeline steps

The generator pipeline is strictly ordered. Each step depends on
artefacts from previous steps.

**Step 0 — Monte Carlo simulation** (always runs):
- Reads truth file and graph topology
- Simulates daily user cohorts with known parameters
- For contexted graphs: allocates users across context values by
  weight, applies per-slice `p_mult`/`mu_offset`/`onset_offset`
- Produces in-memory snapshot rows (not yet hashed)

**Step 1 — Update graph structural metadata** (`--write-files` only):
- Writes `query`, `latency_parameter`, `cohort_anchor_event_id`
  on graph edges
- Sets simulation guard (`simulation=true`, `dailyFetch=false`,
  `dataInterestsDSL` with context qualifiers if applicable)

**Step 1b — Write context definitions** (contexted graphs only):
- Reads `context_dimensions` from truth file
- Writes `contexts/{dim-id}.yaml` with correct `otherPolicy`
  (`"null"` for MECE, `"undefined"` otherwise)
- Must happen before Step 2 because context definitions affect
  the core_hash computation

**Step 2 — Compute FE-authoritative hashes** (always runs):
- Calls the CLI (`graph-editor/src/cli/bayes.ts`) twice: once
  with `window(…)` DSL, once with `cohort(…)` DSL
- Each call uses the full FE service layer: `loadGraphFromDisk`
  → `seedFileRegistry` → `buildFetchPlanProduction` →
  `mapFetchPlanToSnapshotSubjects` → `computeQuerySignature`
- Returns `{edge_uuid → core_hash}` for window and cohort
  separately, mapped to param_ids via the graph edge structure
- Creates a temp directory with the graph JSON (DSL overridden)
  and symlinks to the data repo's supporting dirs

**Step 3 — Write to snapshot DB** (when `DB_CONNECTION` available):
- Re-hashes in-memory snapshot rows with the authoritative hashes
  from Step 2
- Calls `write_to_snapshot_db()` with workspace prefix

**Step 4 — Write parameter files** (`--write-files` only):
- Writes parameter YAML files with empirical lag stats
- Updates `parameters-index.yaml`

**Step 5 — Verify DB data** (when DB available):
- Queries DB with the same hashes and confirms data exists
- Sanity check that the round-trip is clean

**Synth-meta sidecar** — writes `.synth-meta.json` alongside the
graph JSON, recording truth hash, generation timestamp, row count,
and per-edge hashes. Used for integrity checking.

### 3.2 Hash computation architecture

**Single source of truth**: all hashes are computed via the CLI
(`bayes.ts`), which uses the real FE service layer. This guarantees
hashes match what the FE would send in a live Bayes commission.

**Why not `compute_snapshot_subjects.mjs`**: an earlier Node.js
script (`bayes/compute_snapshot_subjects.mjs`) hand-rolled hash
computation that diverged from the real FE code in multiple ways:
different event definition loading rules, different YAML date
handling (`js-yaml` default vs `JSON_SCHEMA`), hardcoded
visited/exclude arrays. This produced hashes that didn't match the
CLI or FE, causing persistent data-not-found failures. The
generator now bypasses this script entirely.

**Hash-affecting inputs**: the core_hash depends on graph edge
structure (from/to event IDs, connection name), event definitions
(provider_event_names), context definitions (normalised and hashed),
and query normalisation. Changing ANY of these invalidates existing
DB data — regeneration required.

**Context definitions affect hashes**: the `otherPolicy` field on
a context YAML is included in the context definition hash. A
mismatch between `otherPolicy: none` and `otherPolicy: "null"`
produces different hashes. The generator writes context files from
the truth file to prevent this class of mismatch.

### 3.3 Verify hash parity

After generation, verify FE hash computation matches DB:

```bash
cd graph-editor
npm test -- --run src/services/__tests__/synthHashParity.test.ts
```

---

## 4. Inspect in FE

### 4.1 Load the graph

1. Open the data repo workspace in the FE
2. Navigate to the synth graph
3. **Force Full Reload** if the graph was updated since last load

### 4.2 Trigger stats pass

The graph edges are clean (no analytical params). To get model curves:

1. Select an edge
2. In the data menu, click "Fetch" → "From Cache"
3. This triggers `enhanceGraphLatencies` which derives mu/sigma/t95/
   path_t95/forecast.mean from the parameter file evidence
4. The graph edge is now populated with analytical params

### 4.3 View cohort maturity

1. Right-click canvas → Add Analysis → Cohort Maturity
2. Set analytics_dsl to e.g. `from(simple-a).to(simple-b)`
3. The chart should show:
   - Evidence data points (from snapshot DB)
   - Model CDF curve (from stats-pass-derived params)
   - Evidence/forecast layer split

### 4.4 Troubleshooting

If the chart shows "No snapshot data":
- Check the analysis dump in `debug/analysis-dumps/`
- Verify `core_hash` in the dump matches what's in the DB
- Check `slice_keys` — cohort charts need cohort() rows
- Check the preflight log for retrieval summary

If the model curve is offset from evidence:
- Check `anchor_median_lag_days` semantics (must be A→X, not A→Y)
- Check onset values in param file vs what stats pass derives
- Compare `mode` in model_curve_params: should be `cohort_path` not
  `cohort_edge_fallback`

---

## 5. Run Bayes Parameter Recovery

### 5.1 Using the test harness

```bash
. graph-editor/venv/bin/activate
cd bayes
python test_harness.py --graph {name} --edges all
```

This runs the full Bayes compiler pipeline:
1. Topology analysis
2. Evidence binding (from snapshot DB)
3. Model construction
4. MCMC inference (NUTS via NumPyro)
5. Posterior summary

### 5.2 Evaluating recovery

Compare posterior summaries against truth config:

| Parameter | Truth | Posterior Mean | 90% CI |
|-----------|-------|---------------|--------|
| p(A→B) | 0.70 | ? | [?, ?] |
| p(B→C) | 0.60 | ? | [?, ?] |
| mu(A→B) | 2.30 | ? | [?, ?] |
| sigma(A→B) | 0.50 | ? | [?, ?] |

**Good recovery**: posterior mean within 1 posterior SD of truth, truth
within 90% CI.

**Poor recovery** suggests:
- Model geometry issues (check divergences, ESS, R-hat)
- Data insufficiency (increase n_days or mean_daily_traffic)
- Evidence binding bugs (check trajectory counts, denominator source)

### 5.3 Using the FE Bayes trigger

Alternatively, trigger a Bayes fit from the FE:
1. Open the graph
2. Use the dev Bayes harness button
3. Results are committed back to the data repo by the worker
4. Inspect posteriors in the edge properties panel

---

## 6. Available Test Graphs

| Name | Topology | Edges | Purpose |
|------|----------|-------|---------|
| `simple-abc` | A→B→C linear | 2 | Basic recovery, solo edges, no joins |
| `fanout-test` | Anchor→Gate→{Fast,Slow} | 3 | Branch group Dirichlet, uncontexted |
| `context-solo` | Anchor→Target (solo, MECE context) | 1 | Phase C: per-slice p/kappa/latency, solo edge |
| `fanout-context` | Anchor→Gate→{Fast,Slow} (MECE context) | 3 | Phase C: per-slice Dirichlet, branch group |
| `diamond-test` | A→{B,C}→D→E | 6 | Splits, joins, branch groups |
| `skip-test` | Linear with skip edge | 3 | Non-adjacent edges |
| `3way-join-test` | Three paths joining | 5 | Multiple join points |
| `join-branch-test` | Branch + join | 4 | Branch group with downstream join |
| `lattice-test` | 2×2 lattice | 4 | Multiple paths, shared nodes |
| `mirror-4step` | 4-step linear | 4 | Deep path latency accumulation |

Graphs prefixed `synth-` in `nous-conversion/graphs/`. Each has a `.truth.yaml`
sidecar, a `.synth-meta.json` (written by the generator), and supporting
event/node/context/parameter files in the data repo.

---

## 6b. Contexted Synthetic Graphs (Phase C)

Phase C graphs test per-slice modelling. They extend the truth file
with context dimensions that define how conversion rates vary by
segment.

### 6b.1 Truth file extensions for context

```yaml
emit_context_slices: true

context_dimensions:
  - id: synth-channel
    mece: true
    values:
      - id: google
        label: Google
        weight: 0.60          # traffic share
        sources:
          amplitude:
            field: utm_medium
            filter: utm_medium == 'google'
        edges:
          {edge-param-id}:
            p_mult: 1.22       # per-slice p = base_p * p_mult
            mu_offset: -0.3    # per-slice mu = base_mu + mu_offset
            onset_offset: -0.3 # per-slice onset = base_onset + onset_offset
```

- `emit_context_slices: true` tells the generator to produce
  context-qualified snapshot rows (e.g.
  `context(synth-channel:google).window()`)
- `mece: true` means the values are mutually exclusive and collectively
  exhaustive — all traffic is assigned to exactly one value
- `weight` controls traffic allocation across values (must sum to 1.0)
- `p_mult` scales the base edge probability per slice (simplex
  maintained for branch groups)
- `mu_offset` / `onset_offset` shift latency parameters per slice

### 6b.2 Context definition files

The generator writes context YAML files to `contexts/` in Step 1b,
derived from the truth file. When `mece: true`, the context definition
gets `otherPolicy: "null"` — this is how the FE identifies MECE
dimensions for the `mece_dimensions` payload field.

Previously context files were created manually. This caused hash
mismatches when the `otherPolicy` value was wrong (e.g. `none` instead
of `null`), because the context definition hash is part of the
core_hash computation.

### 6b.3 What the generator produces for contexted graphs

For a graph with 1 MECE dimension × 3 context values:

- **Snapshot rows**: each `(anchor_day, retrieved_at)` produces 3
  context-qualified rows per obs type (e.g.
  `context(synth-channel:google).window()`). No bare aggregate rows.
- **MECE aggregation**: the evidence binder sums the 3 context rows
  per `(anchor_day, retrieved_at)` to recover the aggregate — this
  only happens when `mece_dimensions` declares the dimension MECE.
- **Context file**: `contexts/synth-channel.yaml` with
  `otherPolicy: "null"`.
- **Graph DSL**: `(window(…);cohort(…))(context(synth-channel))` — the
  FE explodes this into per-context subjects.

### 6b.4 Control vs treatment testing

The definitive test for the commissioning contract: run the same
graph twice via `--fe-payload`, varying ONLY the pinnedDSL:

1. **Control**: strip context from DSL → `window(…);cohort(…)`.
   Context rows in DB are aggregated via MECE into parent.
   Model produces parent-only vars. No per-slice Multinomials.

2. **Treatment**: original DSL with context → `(window(…);cohort(…))(context(…))`.
   FE commissions per-slice subjects. Model produces parent + per-slice
   vars. Per-slice DirichletMultinomials emitted.

Both use the same data, same graph, same hashes. The ONLY difference
is the `dataInterestsDSL`. Build the control by copying the graph
JSON to a temp directory with the stripped DSL (symlink supporting
dirs).

---

## 7. Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No snapshot data" | Stale hashes in DB from prior runs | `DELETE FROM snapshots WHERE param_id LIKE '%synth-%'` then regenerate |
| 0 edges resolved in hash step | Missing param files | Must run with `--write-files` to create param YAMLs before hashes can be computed |
| Two graphs produce identical hashes | Shared event names / node structure | Every graph needs unique event IDs — hashes are derived from event `provider_event_names`, not edge UUIDs |
| DB data collision between graphs | Shared UUIDs across graphs | NEVER copy a graph JSON and only rename `p.id` — generate fresh UUIDs for ALL nodes and edges |
| Phase 1 p recovery matches wrong truth | DB data from another graph | Check hashes are unique per graph. If two graphs share hashes, the last `synth_gen` run wins |
| Model curve right-shifted | `anchor_median_lag` computed as A→Y instead of A→X | Fix in synth_gen: use `from_node_arrival` not `to_node_arrival` |
| `x: 0` on all cohort points | Cohort rows missing `x` field | Ensure synth_gen writes `x = count_by_age(from_times, age)` on cohort rows |
| `cohort_edge_fallback` mode | `path_mu`/`path_sigma` not derived | Stats pass needs `anchor_median_lag_days` in param file cohort values[] |
| `Missing X%` on every node | No complement edges to absorbing node | Add dropout edges from every non-absorbing node |
| Handles not connecting | Wrong handle format | Source: `{dir}-out`, Target: `{dir}` (no -out) |
| Pull gate blocking updates | IDB holding stale graph version | Force Full Reload, or close and reopen workspace |
| `--fe-payload` returns 0 rows | CLI hashes don't match DB | Regenerate with `--write-files` — hashes depend on graph+events+contexts on disk. Any change invalidates. |
| `mece_dimensions` empty in payload | Context YAML has `otherPolicy: none` instead of `"null"` | Regenerate — Step 1b writes correct `otherPolicy` from truth `mece: true` |
| Context rows skipped as "non-MECE" | `mece_dimensions` not populated in payload | Check `otherPolicy` in context YAML. Must be `"null"` or `"computed"` for MECE. Generator handles this automatically. |
| Per-slice posteriors identical to parent | Branch group Multinomials not emitted per-slice | Fixed 10-Apr-26. Check `obs_bg_*__context(*)` in OBSERVED RVs section of model summary. |
| `dataInterestsDSL` missing after gen | Ran without `--write-files` after a previous run wiped it | Always run with `--write-files` for the final generation pass |
