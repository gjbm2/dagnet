# Validate a Graph Before Committing

How to run quality checks on a graph and its entity files before committing to the data repo. These checks catch structural errors, broken references, stale data, impossible evidence, and other defects that cause silent failures at runtime.

**Run these checks before every commit.** Both tiers exit non-zero on failure, so they can be chained with `&&`.

---

## Two-Tier Validation

| Tier | Command | Speed | What it checks |
|------|---------|-------|----------------|
| **Structural** | `bash graph-ops/scripts/validate-graph.sh graphs/<name>.json` | < 1s | Python-based structural checks against graph JSON + entity files on disk |
| **Deep** | `bash graph-ops/scripts/validate-graph.sh graphs/<name>.json --deep` | ~10s | Everything above, plus production IntegrityCheckService via Vitest (same engine as the app's Graph Issues panel) |

Use **structural** for fast iteration during development. Use **deep** (`--deep`) before every commit and merge.

### Full pre-commit sequence

```bash
# From the dagnet workspace root:
bash graph-ops/scripts/validate-indexes.sh
bash graph-ops/scripts/validate-graph.sh graphs/<name>.json --deep
```

If both pass, commit:
```bash
bash graph-ops/scripts/commit-and-push.sh "<commit message>"
```

---

## Structural Checks (Tier 1)

The structural tier runs 15 Python checks directly against the graph JSON and entity YAML files on disk:

| # | Check | Severity |
|---|-------|----------|
| 1 | Valid JSON | error |
| 2 | Every node has a non-empty `id` (bound to registry) | error |
| 3 | Every measurable node has `event_id` on graph node | error |
| 4 | `event_id` on graph node matches `event_id` in node file | error |
| 5 | Every `event_id` references an existing event file | error |
| 6 | Every node `id` references an existing node file | error |
| 7 | Terminal nodes (no outgoing edges) are marked `absorbing: true` | warning |
| 8 | Edge `from`/`to` reference valid node UUIDs | error |
| 9 | Edge queries use node IDs, not UUIDs | error |
| 10 | Node and edge UUIDs are unique | error |
| 11 | Data connections are set correctly (fetchable edges have connection, unfetchable don't) | error |
| 12 | Unfetchable parameter files have no `query` field | error |
| 13 | No spurious `_overridden` flags | warning |
| 14 | Fetchable edges have `p.id` binding; unfetchable edges don't | error |
| 15 | Queries present on fetchable edges, absent on unfetchable | error/warning |

Plus `validate-indexes.sh` checks:
- Every entity file has an index entry
- Every index entry has a matching entity file

---

## Deep Checks (Tier 2 — `--deep`)

The deep tier runs the production `IntegrityCheckService` — the same code that powers the **Graph Issues** panel in the DagNet app. It loads the graph and all referenced entities into a test database and runs comprehensive validation.

Issues are grouped into quality gates. Each gate must pass (zero errors + zero warnings in blocking categories) for the check to succeed.

| Quality Gate | What it catches |
|---|---|
| **Structural integrity** | Missing UUIDs, disconnected nodes, absorbing violations, dead-code edges |
| **Duplicate IDs/UUIDs** | Duplicate node or edge UUIDs within a graph |
| **Referential integrity** | Broken references to nodes, events, parameters, cases, contexts |
| **Schema compliance** | Missing required fields, invalid ID formats, empty data |
| **Data consistency** | Graph ↔ parameter/case file drift (e.g. `p.mean` on graph doesn't match parameter file) |
| **Semantic evidence** | Impossible evidence (`k > n`), denominator incoherence across sibling edges, unfetchable edge bindings |
| **Value validity** | Outgoing edge probabilities summing > 100%, out-of-range parameter values |
| **Connection validity** | Unknown or misconfigured data connections |
| **Naming & metadata** | File ID / data ID mismatches, missing metadata blocks |

### Interpreting deep check output

The output prints a per-gate report. Each issue shows:
- **Severity**: `✖` error (blocks), `⚠` warning (blocks), `ℹ` info (advisory)
- **File ID**: which file the issue is on (graph, parameter, node, etc.)
- **Category and message**: what's wrong
- **Suggestion**: how to fix it (when available)

A full summary grouped by category is printed at the end regardless of pass/fail.

---

## Relationship to the App

The deep check runs the **same `IntegrityCheckService`** that the app uses to populate the Graph Issues panel. If you see issues in the app's Graph Issues view, the deep check will catch them too — and vice versa.

The filtering logic is also shared: the test uses `IntegrityCheckService.extractGraphReferences()` to identify entity files referenced by the graph, then filters issues to only those relevant to the graph under test.

---

## Common Failures and Fixes

| Failure | Cause | Fix |
|---------|-------|-----|
| "Node file has event_id but graph node is missing event_id" | Graph node wasn't updated when node file was created | Add `event_id` to the graph node JSON |
| "Unfetchable edge has p.id / query" | Edge connects nodes without events but was given a parameter binding | Remove `p.id` and `query` from the edge; delete or unbind the parameter file |
| "Outgoing probabilities sum > 100%" | Edge `p.mean` values are stale or incorrect | Re-fetch data, or manually correct `p.mean` values |
| "Evidence has k > n" | Corrupted or stale evidence data on graph edge | Re-fetch the edge; check query construction |
| "Graph ↔ parameter file drift" | Graph's inline data doesn't match what's in the parameter YAML | Re-fetch to sync, or manually align the values |
| "Index entry has no file" / "File has no index entry" | Entity file added/removed without updating the index | Run the app's index rebuild, or manually edit the index YAML |

See also: [Common Pitfalls](../reference/common-pitfalls.md) and the troubleshooting table in [Iterate on a Graph](iterate-on-graph.md).

---

## Running for AI Agents

The output format is designed to be parseable by AI agents. When running validation in an automated or agent-assisted workflow:

```bash
# Structural only (fast feedback loop):
bash graph-ops/scripts/validate-graph.sh graphs/<name>.json

# Full validation (before commit):
bash graph-ops/scripts/validate-graph.sh graphs/<name>.json --deep
```

Both tiers:
- Print categorised, line-by-line issue reports
- Exit with code 0 on success, non-zero on failure
- Can be chained: `validate-indexes.sh && validate-graph.sh graphs/x.json --deep && commit-and-push.sh "msg"`

The deep check's quality gate output groups issues by concern (structural, referential, semantic, etc.) so an agent can target fixes at the right category without parsing unstructured text.
