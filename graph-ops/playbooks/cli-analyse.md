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
| `--topo-pass` | Run BE topo pass before analysis. Populates promoted latency stats (`promoted_mu_sd`, `promoted_t95`, etc.) needed for v2 fan charts. Builds cohort data from parameter files on disk and sends it to `/api/lag/topo-pass`. |
| `--no-snapshot-cache` | Bypass the BE snapshot service in-memory cache. Essential after `synth_gen.py` or any DB repopulation — without this, the BE may return stale cached empty results. |
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

# 2. Run v2 analysis with topo pass and cache bypass
cd .. && bash graph-ops/scripts/analyse.sh synth-simple-abc \
  "from(simple-a).to(simple-c).cohort(simple-a,12-Dec-25:21-Mar-26)" \
  --type cohort_maturity_v2 --topo-pass --no-snapshot-cache --format json
```

**Why `--topo-pass` is needed**: the CLI's aggregate step calls the
same `fetchDataService.fetchItems` as the browser, but IDB is
unavailable in Node — `getParameterFromFile` fails silently when
`fileRegistry.restoreFile()` hits the missing IDB layer. The FE topo
pass (Stage 2) never fires, so `model_vars` and `promoted_*` fields
are never populated. The `--topo-pass` flag bypasses this by reading
cohort evidence directly from the disk-loaded parameter files
(`bundle.parameters`) and calling the BE `/api/lag/topo-pass` endpoint.

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

## Troubleshooting

**"Could not reach Python BE"** — ensure the Python backend is
running. Start with `cd graph-editor && python dev-server.py`, or
set `PYTHON_API_URL` for a remote instance.

**"Analysis failed — Not Found"** — check the `--type` value matches
a supported analysis type on the BE.

**Empty or unexpected results** — run with `--verbose` to see the
full aggregation and LAG pass output. Check whether parameter files
have data for the requested window.
