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
cd bayes

# Dry run (verify topology, no writes)
python synth_gen.py --graph {name} --dry-run

# Full generation (DB + files)
python synth_gen.py --graph {name} --write-files

# With options
python synth_gen.py --graph {name} --write-files \
  --people 10000 --days 200 --kappa 20 --drift 0.02 --growth 0.05
```

**What `--write-files` does**:
1. Runs Monte Carlo simulation (with burn-in warm-up)
2. Writes snapshot rows to DB (window + cohort, both hashes)
3. Updates graph JSON (structural fields only)
4. Writes parameter YAML files (with empirical lag stats)
5. Updates parameters-index.yaml
6. Sets simulation guard (simulation=true, dailyFetch=false, pinnedDSL)

### 3.1 Verify hash parity

```bash
cd graph-editor
npm test -- --run src/services/__tests__/synthHashParity.test.ts
```

This runs the FE's `computeCurrentSignatureForEdge` against the synth
graph and verifies the computed hashes match what's in the param files
and DB.

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
| `simple` | A→B→C linear | 2 | Basic recovery, no joins |
| `diamond` | A→{B,C}→D→E | 6 | Splits, joins, branch groups |

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
