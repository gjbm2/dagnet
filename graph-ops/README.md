# graph-ops — Graph Creation & Editing

Playbooks, reference docs, and scripts for creating, editing, and maintaining conversion graphs.

## Playbooks

- **[Branch Workflow](playbooks/branch-workflow.md)** — the full git lifecycle: branch, commit, push, test, merge
- **[Create Graph](playbooks/create-graph.md)** — step-by-step for building a new conversion funnel from scratch
- **[Build Funnel Graph](playbooks/build-funnel-graph.md)** — end-to-end guide: audit, entity creation, wiring, validation
- **[Create Entities](playbooks/create-entities.md)** — how to create individual nodes, events, parameters, contexts
- **[Edit Existing Graph](playbooks/edit-existing-graph.md)** — modifying an existing graph (add/remove nodes, rename, re-wire)
- **[Iterate on a Graph](playbooks/iterate-on-graph.md)** — fetch data, validate, fix in a tight loop
- **[Validate a Graph](playbooks/validate-graph.md)** — how to run quality checks before committing (structural + deep integrity)
- **[Manage Hash Mappings](playbooks/manage-hash-mappings.md)** — hash mapping workflow for event/context renames
- **[Common Pitfalls](reference/common-pitfalls.md)** — known pitfalls and how to avoid them

## CLI Tools

DagNet ships command-line tools that produce the same outputs as the browser UI — useful for automation, scripting, and validating graphs without opening the app.

| Tool | What it does | Playbook |
|---|---|---|
| `scripts/param-pack.sh` | Compute edge probabilities, evidence, forecast, and latency for a graph+window/cohort — identical to the browser's WindowSelector output | [CLI: Param Pack](playbooks/cli-param-pack.md) |
| `scripts/analyse.sh` | Run any analysis type (graph overview, cohort maturity, etc.) and get the JSON payload that feeds ECharts | [CLI: Analyse](playbooks/cli-analyse.md) |
| `scripts/parity-test.sh` | Regression test: old path vs new path, single + multi-scenario, all snapshot types | — |
| `scripts/golden-regression.sh` | Compare current analyse output against golden baselines | — |

## Reference

- **[Data Model](reference/data-model.md)** — complete data model reference (graphs, nodes, edges, events, parameters, contexts)

## Scripts

All scripts read directory names from `.private-repos.conf` at the dagnet root. Run from the dagnet workspace root, e.g.:
```bash
bash graph-ops/scripts/status.sh
```

### Git operations

| Script | Purpose |
|---|---|
| `scripts/status.sh` | Quick overview: branch, changes, ahead/behind, recent commits |
| `scripts/pull-latest.sh` | Fetch and pull latest from origin for current branch |
| `scripts/new-branch.sh <name>` | Create a feature branch from latest main |
| `scripts/commit-and-push.sh "<msg>"` | Stage all, commit, push (refuses to commit to main) |

### Data operations

| Script | Purpose |
|---|---|
| `scripts/validate-graph.sh <file> [--deep]` | Pre-commit graph validation ([details](playbooks/validate-graph.md)) |
| `scripts/validate-indexes.sh` | Check index files match entity files |
| `scripts/list-graph.sh <file>` | Print human-readable summary of a graph JSON |

## Key Conventions

- **Date format**: `d-MMM-yy` (e.g. `10-Feb-26`) — never ISO or US format in data
- **IDs**: lowercase kebab-case (`a-zA-Z0-9_-`), max 64 chars
- **UUIDs**: Graph nodes/edges use v4 UUIDs; human `id` is separate
- **Schemas**: `graph-editor/public/param-schemas/` (in dagnet repo)
- **Types**: `graph-editor/src/types/index.ts` (in dagnet repo)
- **Never commit to main directly** — always use feature branches
