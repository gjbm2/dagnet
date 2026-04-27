# Scenario Seeding Revert (15-Apr-26)

## What was reverted

Commits `2d8b735a` through `a34a1a79` on main (merged from `feature/scenario-seeding-from-graph-json`) introduced a feature that stored scenarios directly on graph JSON objects and round-tripped them through IndexedDB. Fully reverted.

### Code changes removed

1. **TabContext.tsx** -- scenario seeding from `data.scenarios` into IDB on graph load (29 lines)
2. **repositoryOperationsService.ts** -- serialisation of IDB scenarios back into graph JSON on commit (14 lines)
3. **types/index.ts** -- `scenarios?: Scenario[]` field on `ConversionGraph` interface
4. **graph_types.py** -- `scenarios` field on `Graph` Pydantic model
5. **conversion-graph-1.1.0.json** -- `scenarios` property in JSON schema

### Infrastructure changes reverted

6. **gate-check.sh** -- removed a blanket exemption that allowed agents to bypass the git-write gate when operating inside the data repo directory. The gate exists for safety; engineers wanting local exemptions can configure their own environment.
7. **setup-workspace.sh** -- restored the private repo name leak check from advisory back to **blocking**. The pre-commit hook is one line of defence; the setup check is a second. Downgrading it to advisory removed redundancy that exists for good reason.

### Infrastructure change (new, not a revert)

8. **release.sh** -- replaced `sed -i ''` (macOS-only) with `sed -i.bak ... && rm -f *.bak` (portable across GNU sed on Linux/WSL and BSD sed on macOS).

## Rationale

Scenarios should not live on graph objects. They are workspace-level state that belongs in IndexedDB (and potentially in canvas view objects). Storing them on graph JSON:

- Conflates graph structure (the conversion model) with workspace state (user-created what-if scenarios)
- Creates a round-trip serialisation path that mutates the graph file on every commit, even when the graph itself hasn't changed
- Introduces cross-machine collision risks (the implementation used `crypto.randomUUID()` to avoid this, but the fundamental design problem remains)

If scenarios need to be portable across machines, the correct approach is to attach them to **canvas view objects** (which already handle per-view state) rather than to the graph root.

## Version note

The version was bumped from 1.10.3-beta to 1.10.6-beta as part of the scenario seeding work. Left as-is -- the version number is harmless and avoids potential confusion from a version rollback.
