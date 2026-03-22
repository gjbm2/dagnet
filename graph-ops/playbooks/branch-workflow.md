# Branch Workflow Playbook

Standard workflow for developing graph changes in the data repo.

## Lifecycle

```
branch → build → validate → commit → load in app → fetch data → business validation → merge
```

All graph development happens on **feature branches**. Never commit directly to `main`.

---

## 1. Use or Create a Feature Branch

### Resuming an existing branch

```bash
cd <data-dir>
git checkout feature/<branch-name>
git pull origin feature/<branch-name>
```

### Starting fresh

```bash
cd <data-dir>
git checkout main
git pull origin main
git checkout -b feature/<descriptive-name>
```

Or use the helper:
```bash
bash graph-ops/scripts/new-branch.sh <branch-name>
```

**Branch naming**: `feature/<short-description>` — e.g. `feature/add-broadband-funnel`, `feature/update-energy-blueprint-params`.

---

## 2. Build Graphs, Entities, and Parameter Files

Create or edit graphs, nodes, events, parameters as needed. Follow the relevant playbook:

- [Create Graph](create-graph.md) — new graph from scratch
- [Create Entities](create-entities.md) — individual entity files (nodes, events, parameters, contexts)
- [Edit Existing Graph](edit-existing-graph.md) — modifying an existing graph (add/remove nodes, rename, re-wire)

---

## 3. Validate Before Committing

Run the validation tools before every commit. Both scripts exit non-zero on failure, so they can be chained with `&&`.

```bash
bash graph-ops/scripts/validate-indexes.sh && \
bash graph-ops/scripts/validate-graph.sh graphs/<graph-name>.json --deep
```

This catches:
- **Index consistency** — every entity file has an index entry and vice versa
- **Structural integrity** — node bindings, event references, edge references, UUID uniqueness, data connections, parameter bindings, query correctness, probability sums
- **Deep production checks** (`--deep`) — schema compliance, data drift, semantic evidence, value validity, naming/metadata — the same engine as the app's Graph Issues panel

If either script fails, fix the reported issues and re-run before committing. See [Validate a Graph](validate-graph.md) for full details on interpreting output and fixing common failures.

---

## 4. Commit and Push

Once validation passes:

```bash
bash graph-ops/scripts/commit-and-push.sh "Add broadband conversion funnel"
```

Or manually:
```bash
cd <data-dir>
git add -A
git commit -m "Add broadband conversion funnel"
git push -u origin feature/<branch-name>
```

**Commit message conventions**:
- `Add <thing>` — new graph/entity
- `Update <thing>` — edit existing
- `Fix <thing>` — correct an error
- `Refactor <thing>` — restructure without changing behaviour
- `Daily data refresh (<graph>) - <date>` — automated data updates

---

## 5. Load in App and Populate with Data

1. Open DagNet graph editor
2. Clone or switch to the data repo at your feature branch
3. Open the graph
4. Run **Retrieve All** to fetch data from Amplitude for all measurable edges
5. Check the session log for errors or warnings during fetch

If edges return zero data, wrong data, or planner warnings, you're in the **fetch → validate → fix** loop. See [Iterate on a Graph](iterate-on-graph.md) for the full troubleshooting workflow.

Each fix cycle is: fix files → validate (`validate-graph.sh --deep`) → commit & push → fetch again → repeat until clean.

---

## 6. Business Validation

Once data is flowing correctly, verify the graph makes business sense:

- [ ] All measurable edges return data (no zero-data edges that should have data)
- [ ] Conversion rates are within expected ranges — compare against Amplitude funnels for the same date range
- [ ] Denominator (N) values are in the right ballpark — not orders of magnitude off
- [ ] Edge probabilities from each node sum to ≤ 1.0
- [ ] `dailyFetch: true` is set if the graph should be in the automated overnight run
- [ ] At least one full fetch cycle has completed cleanly on the feature branch

---

## 7. Merge to Main

Once structural validation passes and business validation confirms the graph is correct:

1. Create a PR on GitHub (the data repo)
2. Review the diff — check for accidental changes, stale data, leftover `_overridden` flags
3. Merge to `main`
4. Delete the feature branch

After merging, the graph is automatically included in the main-branch daily fetch automation. No further action needed.

---

## Quick Reference

| Action              | Command                                                     |
|---------------------|-------------------------------------------------------------|
| New branch          | `bash graph-ops/scripts/new-branch.sh <name>`              |
| Resume branch       | `cd <data-dir> && git checkout feature/<name> && git pull`  |
| Validate indexes    | `bash graph-ops/scripts/validate-indexes.sh`                |
| Validate graph      | `bash graph-ops/scripts/validate-graph.sh graphs/<name>.json --deep` |
| Commit & push       | `bash graph-ops/scripts/commit-and-push.sh "<message>"`     |
| Switch to main      | `cd <data-dir> && git checkout main && git pull`            |
| List branches       | `cd <data-dir> && git branch -a`                            |
| Delete local branch | `cd <data-dir> && git branch -d feature/<name>`             |
