# Scripts

This directory contains small, developer-facing utilities used during DagNet development and operations.

## `export-graph-bundle.js` – export a graph + dependencies into a new folder

This script copies one (or more) graph JSON files and all referenced supporting files into a new directory.

It is useful for:
- **Debugging / investigation**: extracting the smallest possible repro repo containing the graph(s) and the data they depend on.
- **Sharing**: exporting a subset of a larger repo into a new folder that can be turned into a standalone repo.

### What it copies (best-effort)

Given one or more graph files under `graphs/*.json`, it:
- Copies the graph file(s)
- Copies referenced **parameter** files:
  - `edge.p.id`
  - `edge.cost_gbp.id`
  - `edge.labour_cost.id`
  - `edge.conditional_p[*].p.id`
- Copies referenced **event** files:
  - `node.event_id` or `node.event.id`
- Copies referenced **case** files:
  - `node.type === 'case'` and `node.case.id`
- Copies referenced **context** definitions:
  - Context keys found in `graph.dataInterestsDSL`, `graph.currentQueryDSL`, `graph.baseDSL`
- Copies **node** files when present:
  - If `nodes-index.yaml` exists and maps the node ID → file path, it copies that file.
  - If no index mapping exists, it will copy `nodes/<id>.yaml` only if it exists on disk (graph-local nodes are common).
- Writes **filtered index files** at repo root (when present in the source repo), containing only the copied entries:
  - `parameters-index.yaml`, `events-index.yaml`, `cases-index.yaml`, `contexts-index.yaml`, `nodes-index.yaml`

### What it deliberately does NOT copy

This exporter is for **content repo slicing**, not app configuration:
- It does **not** copy `connections.yaml`, `settings.yaml`, `credentials.yaml`, or any tokens/secrets.

### Usage

Export a single graph (by ID):

```bash
node graph-editor/scripts/export-graph-bundle.js \
  --repo /abs/path/to/source-repo \
  --graph conversion-flow-account-success-v2 \
  --out /abs/path/to/output-dir
```

Export a single graph (explicit path):

```bash
node graph-editor/scripts/export-graph-bundle.js \
  --repo /abs/path/to/source-repo \
  --graph graphs/conversion-flow-account-success-v2.json \
  --out /abs/path/to/output-dir
```

Export multiple graphs (comma-separated):

```bash
node graph-editor/scripts/export-graph-bundle.js \
  --repo /abs/path/to/source-repo \
  --graphs "conversion-flow-account-success-v2,gm-rebuild-jan-25" \
  --out /abs/path/to/output-dir
```

Or multiple `--graph` flags:

```bash
node graph-editor/scripts/export-graph-bundle.js \
  --repo /abs/path/to/source-repo \
  --graph conversion-flow-account-success-v2 \
  --graph gm-rebuild-jan-25 \
  --out /abs/path/to/output-dir
```

### Optional: initialise a git repo

If you want the output directory to be ready to push as a new repo:

```bash
node graph-editor/scripts/export-graph-bundle.js \
  --repo /abs/path/to/source-repo \
  --graph conversion-flow-account-success-v2 \
  --out /abs/path/to/output-dir \
  --init-git
```

To also create an initial commit:

```bash
node graph-editor/scripts/export-graph-bundle.js \
  --repo /abs/path/to/source-repo \
  --graph conversion-flow-account-success-v2 \
  --out /abs/path/to/output-dir \
  --init-git \
  --commit \
  --commit-message "Initial import (6-Jan-26)"
```

### Exit codes

- `0`: exported successfully (no missing referenced files)
- `2`: exported, but one or more referenced files were missing (warnings printed)
- `1`: fatal error (e.g. graph file not found)


