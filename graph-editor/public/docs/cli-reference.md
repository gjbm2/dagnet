# DagNet CLI Reference

DagNet provides a **headless CLI** that runs the same computations as the browser. Every CLI command imports and calls the identical TypeScript modules used by the frontend — there are no reimplementations. This means CLI output matches browser output exactly.

All commands produce structured output (JSON, YAML, or CSV) suitable for piping, scripting, and automation. Diagnostics go to stderr, data goes to stdout.

## Prerequisites

**Node** (required for all commands):
```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && cd graph-editor && nvm use "$(cat .nvmrc)" && cd ..
```

**Python backend** (required for `analyse`, `hydrate`, `bayes`):
```bash
cd graph-editor && . venv/bin/activate && python dev-server.py &
cd ..
```

The CLI reads graph and parameter files from the data repository. The path is resolved from `.private-repos.conf` at the repo root.

---

## Commands

### param-pack

Produces a **parameter pack** for a graph given a query DSL expression — edge probabilities, latency parameters, evidence/forecast values. The same output you get from the browser's window selector.

**Script**: `graph-ops/scripts/param-pack.sh`

```bash
# YAML output (default)
bash graph-ops/scripts/param-pack.sh <graph-name> "<query-dsl>"

# JSON output
bash graph-ops/scripts/param-pack.sh <graph-name> "<query-dsl>" --format json

# CSV output
bash graph-ops/scripts/param-pack.sh <graph-name> "<query-dsl>" --format csv

# Extract a single scalar value
bash graph-ops/scripts/param-pack.sh <graph-name> "<query-dsl>" \
  --get "e.edge-id.p.mean"

# Pipe JSON to jq (suppress diagnostics)
bash graph-ops/scripts/param-pack.sh <graph-name> "<query-dsl>" \
  --format json 2>/dev/null | jq .
```

**Options**:

| Flag | Purpose |
|------|---------|
| `--format yaml\|json\|csv` | Output format (default: yaml) |
| `--get <key>` | Extract a single scalar (bare value to stdout) |
| `--show-signatures` | Show computed hash signatures per edge |

Does not require the Python backend — all data comes from parameter files on disk.

---

### analyse

Runs a graph **analysis** via the Python backend and returns the result JSON — the same payload that feeds charts in the browser.

**Script**: `graph-ops/scripts/analyse.sh`

```bash
# Single scenario — subject in the DSL
bash graph-ops/scripts/analyse.sh <graph-name> \
  "from(x).to(y).window(-30d:)" --type cohort_maturity

# Graph overview
bash graph-ops/scripts/analyse.sh <graph-name> \
  "window(-30d:)" --type graph_overview

# Multi-scenario comparison
bash graph-ops/scripts/analyse.sh <graph-name> \
  --scenario "window(1-Nov-25:30-Nov-25)" \
  --scenario "window(1-Dec-25:31-Dec-25)" \
  --type bridge --subject "from(x).to(y)"

# Extract specific data
bash graph-ops/scripts/analyse.sh <graph-name> \
  "from(x).to(y).window(-30d:)" --type graph_overview \
  --get "result.data.0.probability" --format json
```

**Analysis types**: `graph_overview`, `cohort_maturity`, `cohort_maturity_v2`, `daily_conversions`, `lag_histogram`, `surprise`, `bridge`.

**Options**:

| Flag | Purpose |
|------|---------|
| `--type <type>` | Analysis type (required) |
| `--scenario <spec>` | Scenario specification (repeatable for multi-scenario) |
| `--subject <dsl>` | Analysis subject DSL (e.g. `from(x).to(y)`) — shared across scenarios |
| `--topo-pass` | Run BE topo pass before analysis — populates promoted latency stats |
| `--no-snapshot-cache` | Bypass BE snapshot cache (essential after DB changes) |
| `--get <key>` | Extract a value via dot-path |
| `--format json\|yaml` | Output format (default: json) |

**Multi-scenario mode**: Each `--scenario` flag produces a separately-aggregated graph. The last scenario maps to "Current" in browser terms; earlier ones are stacked scenarios in order. Default names are `Scenario 1`, `Scenario 2`, etc.

**Scenario spec format**: `"<dsl>"` or `"name=<n>,colour=#hex,<dsl>"`. Key=value pairs are named properties; the remaining bare string is the query DSL. Commas inside parentheses are preserved.

Requires the Python backend.

---

### hydrate

Runs FE aggregation + BE topo pass on a graph and writes the **hydrated graph JSON** back to disk. Produces a graph file equivalent to what the browser would have after opening the graph and running the full topo pass.

**Script**: `graph-ops/scripts/hydrate.sh`

```bash
bash graph-ops/scripts/hydrate.sh <graph-name> "<query-dsl>"
```

**When to use**: After generating synthetic data (where the graph JSON has raw posteriors but no `model_vars`, promoted fields, or path-level latency params), or when you need graph JSON in the same state the browser would produce for loading into other tools.

Requires the Python backend.

---

### bayes

Commissions a **Bayes fit** using the same payload construction as the browser.

**Script**: `graph-ops/scripts/bayes.sh`

```bash
# Write payload JSON to stdout (default — inspect before submitting)
bash graph-ops/scripts/bayes.sh <graph-name>

# Write payload to file
bash graph-ops/scripts/bayes.sh <graph-name> --output payload.json

# Dry run — validate payload against BE without fitting
bash graph-ops/scripts/bayes.sh <graph-name> --preflight

# Submit fit and poll for results
bash graph-ops/scripts/bayes.sh <graph-name> --submit
```

| Mode | What it does | Requires BE? |
|------|-------------|-------------|
| Default | Writes payload JSON to stdout | No |
| `--output <file>` | Writes payload to file | No |
| `--preflight` | Validates payload against BE | Yes |
| `--submit` | POSTs payload and polls for results | Yes |

---

### parity-test

Proves that the old analysis path (`snapshot_subjects`) and the new path (`analytics_dsl` + `candidate_regimes_by_edge`) produce **identical normalised responses**. Primarily a validation tool for verifying analysis pipeline changes.

**Script**: `graph-ops/scripts/parity-test.sh`

```bash
bash graph-ops/scripts/parity-test.sh <graph-name> "<query-dsl>" \
  --subject "from(x).to(y)" --type cohort_maturity
```

Tests both single-scenario and multi-scenario modes. Requires the Python backend.

---

## Shared Options

All CLI commands support:

| Flag | Purpose |
|------|---------|
| `--no-cache` | Bypass disk bundle cache (re-parse all YAML from data repo) |
| `--verbose` / `-v` | Show all internal debug logging |
| `--session-log` | Show session log output |

**Environment**: `PYTHON_API_URL` overrides the Python backend URL (default: `http://localhost:9000`).

**Output discipline**: Diagnostics go to stderr, data goes to stdout. Use `2>/dev/null` to suppress diagnostics when piping.

---

## Disk Bundle Cache

The first CLI invocation parses all YAML files from the data repository and writes a JSON cache to `~/.cache/dagnet-cli/`. Subsequent calls check source file modification times — if unchanged, the cached bundle is loaded instead. This significantly speeds up repeated invocations.

Pass `--no-cache` to bypass the cache (useful after editing data repo files outside of DagNet).
