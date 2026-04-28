# CLI: Analyse

Run a graph analysis from the command line — the same JSON payload
that feeds ECharts in the browser. Supports single and multi-scenario
analysis with any analysis type the Python BE supports.

## Prerequisites

- Node 22+ (via nvm, resolved from `graph-editor/.nvmrc`)
- Data repo cloned (path in `.private-repos.conf`)
- **Python BE running** (`python dev-server.py` on localhost:9000, or
  set `PYTHON_API_URL` for a remote instance)
- Parameter files populated by prior browser fetches or retrieveAll
  (or use `--allow-external-fetch` to fetch from Amplitude on the fly;
  credentials auto-loaded from `.env.amplitude.local`)

## Quick start

```bash
# From the dagnet root:

# Graph overview
bash graph-ops/scripts/analyse.sh my-graph "window(-30d:)" --type graph_overview

# Specific edge — subject in the DSL
bash graph-ops/scripts/analyse.sh my-graph \
  "from(landing-page).to(household-created).window(-90d:)" \
  --type cohort_maturity

# JSON output piped to jq
bash graph-ops/scripts/analyse.sh my-graph "window(-30d:)" \
  --type graph_overview --format json 2>/dev/null | jq '.result.data'
```

## Multi-scenario analysis

Some analysis types (e.g. bridge) compare across scenarios. Each
`--scenario` flag produces a separately-aggregated graph.

```bash
bash graph-ops/scripts/analyse.sh my-graph \
  --scenario "window(1-Nov-25:30-Nov-25)" \
  --scenario "window(1-Dec-25:31-Dec-25)" \
  --type bridge \
  --subject "from(landing-page).to(household-created)"
```

### Scenario ordering

Scenarios map to the FE's stack. The **last** scenario is always
"Current" in FE terms; earlier ones are stacked scenarios in order:

| CLI position | FE equivalent |
|-------------|---------------|
| Last `--scenario` | Current |
| Second-to-last | Scenario A |
| Third-to-last | Scenario B |

### Naming and spec format

Each `--scenario` value is a spec string. Key=value pairs set
properties; the bare remainder is the query DSL:

```bash
# Minimal — name defaults to "Scenario 1", "Scenario 2", etc.
--scenario "window(1-Nov-25:30-Nov-25)"

# Named
--scenario "name=Before,window(1-Nov-25:30-Nov-25)"

# Named with colour
--scenario "name=Before,colour=#ff0000,window(1-Nov-25:30-Nov-25)"
```

Commas inside parentheses are preserved — `context(a,b).window(...)`
works correctly.

### `--query` shorthand

`--query` (or the second positional argument) is shorthand for a
single scenario named "Scenario 1". These are equivalent:

```bash
bash graph-ops/scripts/analyse.sh my-graph "window(-30d:)" --type graph_overview
bash graph-ops/scripts/analyse.sh my-graph --scenario "window(-30d:)" --type graph_overview
```

## Analysis subject

The subject identifies which edge or path to analyse. Two ways to
specify it:

**In the DSL** (single scenario — convenient):
```bash
bash graph-ops/scripts/analyse.sh my-graph \
  "from(landing-page).to(household-created).window(-90d:)" \
  --type cohort_maturity
```

**As a separate flag** (multi-scenario — avoids repetition):
```bash
bash graph-ops/scripts/analyse.sh my-graph \
  --scenario "window(1-Nov-25:30-Nov-25)" \
  --scenario "window(1-Dec-25:31-Dec-25)" \
  --type bridge \
  --subject "from(landing-page).to(household-created)"
```

The `--subject` DSL is joined with the first scenario's DSL to form
the `query_dsl` sent to the BE. It's constant across scenarios.

### Historical analysis with `asat()`

Add `.asat(d-MMM-yy)` to the DSL to analyse using historical snapshot
data (doc 42). Evidence is filtered to snapshots retrieved on or before
the asat date. Read-only — no file writes.

```bash
bash graph-ops/scripts/analyse.sh my-graph \
  "from(landing-page).to(household-created).cohort(1-Jan-26:1-Mar-26).asat(15-Jan-26)" \
  --type cohort_maturity --no-snapshot-cache
```

`at()` is accepted as sugar for `asat()`.

## Extracting values

Use `--get` with dot-path notation to extract specific values:

```bash
# Single scalar
bash graph-ops/scripts/analyse.sh my-graph "window(-30d:)" \
  --type graph_overview \
  --get "result.data.0.probability" 2>/dev/null

# Nested object (returns JSON)
bash graph-ops/scripts/analyse.sh my-graph "window(-30d:)" \
  --type graph_overview \
  --get "result.dimension_values" 2>/dev/null

# Array indexing
bash graph-ops/scripts/analyse.sh my-graph "window(-30d:)" \
  --type graph_overview \
  --get "result.data.2" 2>/dev/null
```

## Options

| Flag | Purpose |
|------|---------|
| `--type <type>` | Analysis type (graph_overview, cohort_maturity, cohort_maturity_v2, daily_conversions, lag_histogram, surprise, bridge, etc.) |
| `--scenario <spec>` | Scenario specification (repeatable) |
| `--subject <dsl>` | Analysis subject (`from(x).to(y)`) — shared across scenarios |
| `--no-snapshot-cache` | Bypass the BE snapshot service in-memory cache. Essential after `synth_gen.py` or any DB repopulation — without this, the BE may return stale cached empty results. |
| `--no-be` | Suppress every BE-bound call in the run (offline equivalence on demand). For FE-only analysis types (`edge_info`, `node_info`) the run completes against FE-topo provisional state. For analyses that require BE compute (`cohort_maturity_v3`, `conditioned_forecast`, runner-analyze types) the command exits non-zero with a clear message naming the analysis type. Diagnostic affordance for distinguishing BE arithmetic divergence from FE/materialisation divergence (doc 73e §8.3 Stage 6). |
| `--get <key>` | Extract a value via dot-path |
| `--format json\|yaml` | Output format (default: yaml) |
| `--no-cache` | Bypass disk bundle cache |
| `--verbose, -v` | Show all internal debug logging |

## Synthetic graph testing

End-to-end workflow for running v2 analyses on synthetic graphs:

```bash
# 1. Generate synth data (param files + snapshot DB rows + graph JSON)
cd graph-editor && . venv/bin/activate
DB_CONNECTION="$(grep DB_CONNECTION .env.local | cut -d= -f2-)" \
  python ../bayes/synth_gen.py --graph synth-simple-abc --write-files

# 1b. Generate + enrich (adds model_vars via the Stage 2 enrichment
#     pipeline — needed for tests that check bayesian posteriors).
#     Requires Python BE running on localhost:9000.
DB_CONNECTION="$(grep DB_CONNECTION .env.local | cut -d= -f2-)" \
  python ../bayes/synth_gen.py --graph synth-simple-abc --write-files --enrich

# 2. Run v2 analysis with cache bypass
cd .. && bash graph-ops/scripts/analyse.sh synth-simple-abc \
  "from(simple-a).to(simple-c).cohort(simple-a,12-Dec-25:21-Mar-26)" \
  --type cohort_maturity_v2 --no-snapshot-cache --format json
```

**Freshness checking**: `synth_gen.py` performs a comprehensive
freshness check before regenerating. It verifies truth file hash,
graph JSON hash, event definition hashes, DB row integrity (non-empty
`core_hash`), param file `query_signature` consistency, and enrichment
state. Use `--bust-cache` to bypass the check and force regeneration.

**Automated regen in tests**: Python tests using `@requires_synth`
(from `graph-editor/lib/tests/conftest.py`) automatically trigger
regen when the freshness check fails. See `bayes/TESTING_PLAYBOOK.md`
for details.

**Why `--no-snapshot-cache` is needed**: the BE's snapshot service
caches query results in memory. After `synth_gen.py` writes new rows
to the DB, the BE may still return previously-cached empty results.
This flag sets the `__dagnetComputeNoCache` global, which causes
`graphComputeClient` to append `?no-cache=1` to BE requests — the
BE middleware then sets a per-thread cache bypass flag.

## FE equivalence

Each CLI scenario is equivalent to a **fresh live scenario in the FE
with its own query DSL and no what-if overlays**. No scenario
composition or stacking is applied — each scenario aggregates
independently from the clean graph. This is fully reproducible in the
FE by creating a live scenario with the same DSL.

`cli analyse` shares the **prepared-analysis dispatch path** with the
browser (doc 73e Stage 2): both call `prepareAnalysisComputeInputs` →
`runPreparedAnalysis`, which routes `conditioned_forecast` to
`/api/forecast/conditioned` and every other registered analysis type
to `/api/runner/analyze`. The CLI no longer hand-rolls a CF payload;
`display_settings` (including `axis_tau_max`) resolve identically
across FE and CLI. CLI standard `analyse` runs the same FE topo
materialisation step (`enhanceGraphLatencies` + Step 2 promotion +
current-answer derivation) that the browser does (doc 73e Stage 5),
so `model_vars[analytic]` and the layered probability surface are
present at transport time.

When materialisation cannot complete for one or more scenarios (a
parameter file is absent, a slice is missing for the effective DSL,
…) the CLI emits per-scenario warnings and exits **non-zero with code
2** AFTER printing the best-effort analysis output, listing the
affected scenario ids. The session-log entry (`MATERIALISATION_INCOMPLETE`)
is the contract; the CLI exit is its rendering.

## Troubleshooting

**"Could not reach Python BE"** — ensure the Python backend is
running. Start with `cd graph-editor && python dev-server.py`, or
set `PYTHON_API_URL` for a remote instance.

**"Analysis failed — Not Found"** — check the `--type` value matches
a supported analysis type on the BE.

**Empty or unexpected results** — run with `--verbose` to see the
full aggregation and LAG pass output. Check whether parameter files
have data for the requested window.
