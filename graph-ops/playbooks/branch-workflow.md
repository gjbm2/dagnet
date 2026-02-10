# Branch Workflow Playbook

Standard git workflow for developing graph changes in `<private-repo>`.

## Lifecycle

```
main ──branch──→ feature/xxx ──commit──→ push ──→ test in app ──→ merge PR
```

All graph development happens on **feature branches**. Never commit directly to `main`.

---

## 1. Create a Feature Branch

```bash
cd <private-repo>
git checkout main
git pull origin main
git checkout -b feature/<descriptive-name>
```

**Branch naming**: `feature/<short-description>` — e.g. `feature/add-broadband-funnel`, `feature/update-energy-blueprint-params`.

Use the helper script:
```bash
bash ../graph-ops/scripts/new-branch.sh <branch-name>
```

---

## 2. Do the Work

Create/edit graphs, nodes, events, parameters as needed. Follow:
- [create-graph.md](create-graph.md) — new graph from scratch
- [create-entities.md](create-entities.md) — individual entity files
- [edit-existing-graph.md](edit-existing-graph.md) — modifying existing graphs

---

## 3. Validate Before Committing

Run the validation script to check consistency:
```bash
bash ../graph-ops/scripts/validate-indexes.sh
```

This checks:
- Every entity file has an index entry
- Every index entry has a matching entity file
- Graph node IDs reference valid node files
- Parameter queries reference valid node IDs

---

## 4. Commit and Push

Stage, commit, and push:
```bash
bash ../graph-ops/scripts/commit-and-push.sh "Add broadband conversion funnel"
```

Or manually:
```bash
cd <private-repo>
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

## 5. Test in the App

1. Open DagNet graph editor
2. Clone or switch to the `<private-repo>` repo at the feature branch
3. Open the graph and verify:
   - All nodes render correctly
   - All edges have valid connections
   - Parameters load and display expected values
   - Data fetch works (if events/queries are configured)
   - No orphaned entities or broken references

---

## 6. Merge

Once testing confirms everything works:

1. Create a PR on GitHub (`gjbm2/<private-repo>`)
2. Review the diff — check for accidental changes, stale data, etc.
3. Merge to `main`
4. Delete the feature branch

---

## Quick Reference

| Action              | Command                                                     |
|---------------------|-------------------------------------------------------------|
| New branch          | `bash ../graph-ops/scripts/new-branch.sh <name>`           |
| Validate            | `bash ../graph-ops/scripts/validate-indexes.sh`            |
| Commit & push       | `bash ../graph-ops/scripts/commit-and-push.sh "<message>"` |
| Switch to main      | `cd <private-repo> && git checkout main && git pull`       |
| List branches       | `cd <private-repo> && git branch -a`                       |
| Delete local branch | `cd <private-repo> && git branch -d feature/<name>`        |
