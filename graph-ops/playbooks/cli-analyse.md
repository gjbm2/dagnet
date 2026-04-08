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
| `--type <type>` | Analysis type (graph_overview, cohort_maturity, daily_conversions, lag_histogram, surprise, bridge, etc.) |
| `--scenario <spec>` | Scenario specification (repeatable) |
| `--subject <dsl>` | Analysis subject (`from(x).to(y)`) — shared across scenarios |
| `--get <key>` | Extract a value via dot-path |
| `--format json\|yaml` | Output format (default: yaml) |
| `--no-cache` | Bypass disk bundle cache |
| `--verbose, -v` | Show all internal debug logging |

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
