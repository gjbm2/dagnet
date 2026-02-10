# graph-ops — AI-Agent Assisted Graph Creation & Editing

This directory provides playbooks, reference docs, and scripts so that an AI coding agent (or human) can create, edit, and maintain DagNet conversion graphs in the `<private-repo>` data repo following a standard branch-based workflow.

## Quick Start

```bash
# 1. Create a feature branch
bash graph-ops/scripts/new-branch.sh add-my-funnel

# 2. Create/edit graphs, nodes, events, parameters
#    (follow the playbooks below)

# 3. Validate
bash graph-ops/scripts/validate-indexes.sh

# 4. Commit and push
bash graph-ops/scripts/commit-and-push.sh "Add my funnel"

# 5. Test in the app (clone/switch to the branch in DagNet)
# 6. Merge PR on GitHub when happy
```

## Directory Structure

```
graph-ops/
├── README.md
├── playbooks/
│   ├── branch-workflow.md      # Git branch lifecycle (create → commit → push → test → merge)
│   ├── create-graph.md         # Creating a new graph end-to-end
│   ├── create-entities.md      # Creating individual entities (node, event, parameter, context)
│   └── edit-existing-graph.md  # Modifying an existing graph
├── reference/
│   └── data-model.md           # Complete data model reference (graphs, nodes, edges, events, parameters, contexts)
└── scripts/
    ├── new-branch.sh           # Create and checkout a feature branch in <private-repo>
    ├── validate-indexes.sh     # Check index files match entity files
    ├── commit-and-push.sh      # Stage, commit, push (refuses to commit to main)
    └── list-graph.sh           # Print human-readable summary of a graph JSON
```

## Data Repo

The production data repo is cloned at `<private-repo>/` (workspace root). It is **git-ignored** — never commit it to the public dagnet repo.

```
<private-repo>/                # git@github.com:gjbm2/<private-repo>.git
├── graphs/                     # Graph JSON files (the visual DAG definitions)
├── nodes/ + nodes-index.yaml   # Node YAML registry
├── events/ + events-index.yaml # Event YAML registry (Amplitude mappings)
├── parameters/ + parameters-index.yaml  # Parameter YAML registry (probabilities, costs)
├── contexts/ + contexts-index.yaml      # Context YAML registry (segmentation)
├── settings/                   # Connection/workspace settings
├── cases/                      # A/B test definitions
└── archive/                    # Historical files
```

## Standard Workflow

| Step | Action | Tool |
|------|--------|------|
| 1 | Create feature branch | `scripts/new-branch.sh` |
| 2 | Create/edit files | Playbooks in `playbooks/` |
| 3 | Validate consistency | `scripts/validate-indexes.sh` |
| 4 | Commit & push | `scripts/commit-and-push.sh` |
| 5 | Test in DagNet app | Open graph at the feature branch |
| 6 | Merge to main | PR on GitHub |

## Playbooks

- **[Branch Workflow](playbooks/branch-workflow.md)** — the full git lifecycle: branch, commit, push, test, merge
- **[Create Graph](playbooks/create-graph.md)** — step-by-step for building a new conversion funnel from scratch
- **[Create Entities](playbooks/create-entities.md)** — how to create individual nodes, events, parameters, contexts
- **[Edit Existing Graph](playbooks/edit-existing-graph.md)** — modifying an existing graph (add/remove nodes, rename, re-wire)

## Pre-commit Leak Guard

A pre-commit hook prevents accidental commits of commercial data to the public dagnet repo. It blocks:
- Any staged files under `<private-repo>/`
- Staged diffs containing Amplitude `cumulativeRaw` user counts
- Known (revoked) API credentials
- Hardcoded API key/secret patterns

**One-time setup** (per clone):
```bash
git config core.hooksPath .githooks
```

The hook lives at `.githooks/pre-commit`. To bypass in an emergency: `git commit --no-verify`.

## Key Conventions

- **Date format**: `d-MMM-yy` (e.g. `10-Feb-26`) — never ISO or US format in data
- **IDs**: lowercase kebab-case (`a-zA-Z0-9_-`), max 64 chars
- **UUIDs**: Graph nodes/edges use v4 UUIDs; human `id` is separate
- **Schemas**: `graph-editor/public/param-schemas/`
- **Types**: `graph-editor/src/types/index.ts`
- **Never commit to main directly** — always use feature branches
