# Variant Contexts and Commit-Time Hash Guard

**Date**: 30-Mar-26
**Status**: Design agreed, not yet implemented

## Problem

Event filters defined in event files (e.g. for A/B test variants I, II, III) break the hash chain on every variant transition. This makes it impossible to:
- Compare performance across variants (II vs III)
- Add new variants without invalidating all cached data

Changing any event or context definition file changes the `core_hash`, orphaning historical snapshots in the snapshot DB. This data cannot be re-fetched (Amplitude retention is finite, snapshots are point-in-time observations). Diachronic analytics breaks silently.

## Solution

Two independent features that together solve the problem:

1. **Commit-time hash guard** — a generic pre-commit gate that detects hash-breaking changes to event/context files, identifies affected parameters across all graphs, and offers to create `hash-mappings.json` entries to preserve access to historical snapshots. This is not variant-specific; it protects against ALL hash-breaking changes.

2. **Behavioural segment filters** — a new context source mapping type that uses Amplitude's behavioural segment filters ("user has done event X where property = Y") to implement variant contexts. This lifts variant filters out of event files and into context definitions, where they can coexist as separate sliceDSL values.

**No changes to the hashing algorithm.** The existing whole-file context definition hashing is unchanged. When a user adds variant IV, the hash changes — and the commit guard catches it, offers a mapping, and the closure set bridges old to new. Old snapshots remain accessible. New snapshots accumulate under the new hash.

**No new fields on context definitions.** No `valueHashing`. No `strictHashMatching`. No schema evolution. Context files are untouched.

## Design Decisions

### 1. Commit-Time Hash Guard

**Problem**: Any edit to an event or context definition that changes hash-relevant fields produces a different `core_hash`. Without intervention, historical snapshots are orphaned.

**Solution**: A generic pre-commit gate that detects hash-breaking changes and offers to bridge old → new hashes via `hash-mappings.json`.

**During editing — soft warning**:

When a user dirties an event or context file, the app shows a visible warning in the **header section of the affected file's tab**: "Event/context definition changed — snapshot hashes will be checked on commit." Informational only; no blocking.

**On commit — hash-change guard flow**:

The guard runs as a pre-commit gate (like merge conflict resolution). It may dirty additional files (`hash-mappings.json`) before the commit finalises.

1. Identify dirty event/context files in the changeset
2. For each: compute old hash (from last committed version via git HEAD — unambiguous baseline) and new hash (from current IDB state)
3. If any hashes changed:
   a. Scan all graphs in the repository for edges/parameters that reference the changed files (directly or indirectly via node event_id or context key in queries/dataInterestsDSL)
   b. For each affected parameter: read current `core_hash` from the stored `query_signature` (the OLD hash matching snapshots in the DB). Compute new `core_hash` by running `computeQuerySignature` with the updated definitions.
   c. Present the mapping UI: "These definition changes affect snapshot hashes in N parameters across M graphs. Select which to preserve historical snapshot access for." Checkbox list grouped by graph, select all by default, with select all / select none.
   d. User confirms selections
4. For selected parameters: write `hash-mappings.json` entries (old `core_hash` ↔ new `core_hash`). This dirties `hash-mappings.json`.
5. For unselected parameters: user acknowledges the break. Old snapshots become orphaned (still recoverable via Signature Links UI if needed later).
6. Commit proceeds with the full changeset: edited event/context files + updated `hash-mappings.json`. Single atomic commit.

**This handles all hash-breaking changes uniformly**: adding context values, changing event filters, modifying source mappings, changing `otherPolicy`, renaming provider event names — any edit that changes what goes into the hash.

**Why commit-time is the right trigger**:

- **Captures all edit paths**: YAML, form editor, bulk edits, script-generated changes — anything dirty at commit time.
- **Fires once after all editing is complete**: no re-triggering on intermediate saves. Edit five files, resolve once.
- **Atomic**: mappings and definition changes are committed together. No window of inconsistency.
- **Old hash baseline is unambiguous**: "last committed version" is always available from git HEAD.
- **Familiar pattern**: analogous to merge conflict resolution — a pre-commit gate that may modify the changeset.
- **Extensible**: could later apply the same guard to incoming pulls, or allow comparison against arbitrary committed versions.

**Edge cases**:

- File created (no git HEAD version) → skip guard, nothing to preserve
- File deleted → guard fires for affected parameters (hash effectively removed)
- Multiple dirty files in one commit → guard finds affected parameters for all, produces separate mapping entries
- Parameter with no stored `query_signature` (never fetched) → skip mapping, nothing to preserve
- Shared parameter referenced by multiple edges → deduplicate, produce one mapping entry
- No affected graphs → guard is silent

### 2. Behavioural Segment Filters for Variant Contexts

**Problem**: Variant contexts apply to specific events (c, d) but the graph contains other events (a, b, e, f) that are not variant-scoped.

**Solution**: Use Amplitude's behavioural segment filters (user-level, not event-level). The segment filter "user has done event_c where variant_property = II within N days" restricts the entire funnel to variant:II users. All funnel steps see the same user population.

- `variant:I/II/III` → segment filter: "user has done event_c where property = [value]"
- `variant:other` → segment filter: "user has NOT done event_c" (complement)
- No context selected → no segment filter → total population

I + II + III + other = total. MECE holds globally at the user-population level.

**`otherPolicy` for variant contexts must be `'computed'`**, not `'null'`. `otherPolicy: 'null'` means "no other bucket — values are asserted exhaustive" and the existing registry excludes the "other" value under this policy. Variant contexts need a complement bucket (users who haven't reached the discriminating event). `otherPolicy: 'computed'` means "other exists and is defined as NOT(all explicit values)" — the correct semantics for the behavioural complement.

#### Amplitude API Mechanism

Amplitude's `s=` parameter supports two kinds of segment filter:

- **Property-based**: `{prop, op, values}` — filters by user property (e.g. `utm_medium = "cpc"`). Current context filter mechanism.
- **Behavioural**: `{type: "event", event_type, filters, op, value, time_type, time_value}` — filters by "user has/hasn't performed event X". Already used for `visited_upstream` and `exclude()`.

Variant contexts use the behavioural form. The source mapping shape:

```yaml
id: variant
otherPolicy: "computed"
values:
  - id: "II"
    sources:
      amplitude:
        type: behavioral
        event_type: "EventC"
        filter_property: "variant_property"
        filter_value: "II"
        time_type: rolling
        time_value: 366
```

**Amplitude payload for `context(variant:II)`**:

```json
{
  "type": "event",
  "event_type": "EventC",
  "filters": [
    {
      "subprop_type": "event",
      "subprop_key": "variant_property",
      "subprop_op": "is",
      "subprop_value": ["II"]
    }
  ],
  "op": ">=",
  "value": 1,
  "time_type": "rolling",
  "time_value": 366
}
```

**Amplitude payload for `context(variant:other)`** (complement):

```json
{
  "type": "event",
  "event_type": "EventC",
  "filters": [],
  "op": "=",
  "value": 0,
  "time_type": "rolling",
  "time_value": 366
}
```

**Key design points**:

- **`time_value` defaults to 366** (~one year). For time-bounded experiments, the source mapping can specify a shorter lookback.
- **Two code paths must stay in sync**: the DAS adapter (`connections.yaml` pre_request) and the frontend funnel builder (`amplitudeFunnelBuilderService`). Conformance tests enforce parity.
- **New source mapping shape**: `type: behavioral`, `event_type`, `filter_property`, `filter_value`, `time_type`, `time_value`. Absence of `type` (or `type: property`) implies existing property-based behaviour. Backward compatible.

### 3. Late-Binding Temporal Constraint

**Critical limitation**: Variant contexts are late-binding — a user's variant is determined when they reach the discriminating event (c), not at funnel entry. This means:

- A user who has done event_a but not yet event_c is classified as `variant:other`.
- Once they reach event_c, they migrate into `variant:I/II/III`.
- Historical snapshots can shift if re-queried after more users have reached c.

**This invalidates diachronic analytics if the discriminating event occurs significantly after funnel entry.** Comparing "variant:I conversion in January" pulled on 1-Feb vs 1-Apr may yield different results because the variant:I population grew.

**Current mitigation**: In the present use case, the discriminating event occurs within minutes of account creation, making population drift negligible. This assumption must be validated for any future variant context.

**Design constraint**: If a variant context's discriminating event has significant latency from funnel entry, this design is not suitable for diachronic analysis without additional mechanisms (e.g. cohort-anchoring on the discriminating event, or pinning the observation window).

## CLI Hashing Tool

### Purpose

A Node.js CLI tool that calls the **actual production TypeScript code** for signature/hash computation. Serves three purposes:

1. **Gating during implementation**: fast sanity checks ("did my code change break any hashes?") before running the full test suite.
2. **Automated testing**: oracle for test assertions — compute expected hashes from known inputs and hard-code as frozen fixtures.
3. **Agentic graph-ops workflow**: Claude and other agents use it when editing event/context files in the data repo.

### Why not Python?

The canonical signature computation lives in TypeScript. Reimplementing in Python would create a duplicate code path. The CLI must import and call the real TS functions.

### Commands

**`compute-hash`** — compute core_hash for an edge in a graph

```
scripts/compute-hash.ts \
  --graph path/to/graph.json \
  --edge edge-id \
  --events-dir path/to/events/ \
  --contexts-dir path/to/contexts/ \
  [--connection amplitude]
```

**`diff-hash`** — compare hashes before and after a file change

```
scripts/diff-hash.ts \
  --file path/to/event-x.yaml \
  --graph path/to/graph.json \
  --events-dir path/to/events/ \
  --contexts-dir path/to/contexts/ \
  [--baseline HEAD]
```

**`add-mapping`** — write a hash-mappings.json entry

```
scripts/add-mapping.ts \
  --mappings path/to/hash-mappings.json \
  --old <old_core_hash> \
  --new <new_core_hash> \
  --reason "description of change"
```

### Implementation approach

Runs via `tsx`. Imports from `graph-editor/src/services/` and `graph-editor/src/lib/`. Needs a filesystem-based loader for context/event definitions (thin adapter over the same YAML parsing library and normalisation functions the app uses).

**Code path divergence risk**: The filesystem loader must use the same YAML library (`js-yaml`) and normalisation functions as the app. CLI golden fixture tests validate that filesystem-loaded definitions produce identical hashes to IDB-loaded definitions.

**Shared code between CLI and commit guard**: Both use `computeQuerySignature` and downstream functions. Only the I/O layer differs (filesystem vs IDB/git).

## Graph-Ops Playbook Additions

### New playbook: `manage-hash-mappings.md`

**Core workflow for any event/context file edit**:

1. Before editing: note you're editing a hash-affecting file
2. Make the edit
3. Run `scripts/diff-hash.ts` to identify affected edges and old/new hash pairs
4. If hashes changed: run `scripts/add-mapping.ts` for each affected edge
5. Commit: changeset includes edited file(s) AND updated `hash-mappings.json`

**Agentic workflow (for Claude / AI assistants)**:

When an agent edits event or context files in the data repo, it MUST:

1. Run `scripts/diff-hash.ts` before editing to capture current hashes
2. Make the edit
3. Run `scripts/diff-hash.ts` again to detect hash changes
4. For each changed hash: run `scripts/add-mapping.ts` with old/new core_hash and a descriptive reason
5. Include `hash-mappings.json` in the commit alongside edited files
6. If uncertain whether a change is hash-breaking, run `diff-hash` anyway — it will confirm "unchanged"

**What NOT to do**:
- Never edit `hash-mappings.json` by hand (use `add-mapping`)
- Never skip diff-hash because "it's just a small change"
- Never create mappings speculatively — only when `diff-hash` confirms a change

### Updates to existing playbooks

**`edit-existing-graph.md`** — add hash impact section referencing `manage-hash-mappings.md`.

**`create-entities.md`** — note: new files don't need hash mappings (no historical snapshots to preserve).

### Validation script: `validate-hashes.sh`

Checks `hash-mappings.json` for: valid base64url format, no duplicates, no self-links, valid `operation` fields. Runs alongside `validate-indexes.sh`.

## Testing Strategy

### Guiding Principle

The design has one overriding risk: **silently orphaning historical snapshot data**. The commit-time guard is the primary defence. If the guard fails to detect a hash-breaking change, or computes wrong old/new hash pairs, or misses affected parameters, snapshots are orphaned without the user's knowledge. Testing is organised around guard reliability.

### Risk Tiers

**Catastrophic** (silent, irreversible data loss):
- Guard misses affected parameters, letting hash-breaking changes through without offering mappings
- Guard computes wrong old/new `core_hash` pair (mapping points to wrong hash, snapshots not found)

**Severe** (wrong analytical results, user-visible):
- Behavioural segment filter produces wrong Amplitude payload (wrong user population)
- "Other" complement is wrong (MECE breaks, aggregation produces incorrect totals)

**Moderate** (degraded experience, recoverable):
- DAS adapter / funnel builder conformance breaks for behavioural filters
- Context registry fails to load behavioural source mappings

### Test Areas

#### Area 1: Commit-Time Hash Guard (CATASTROPHIC)

**Invariant**: The guard must detect every hash-breaking change to event/context files, find every affected parameter, compute correct old/new `core_hash` pairs, and produce valid `hash-mappings.json` entries.

**Tier**: Integration. Real IDB, real FileRegistry, real `computeQuerySignature`, real graph structures.

**New file**: `commitHashGuard.integration.test.ts` — no existing suite covers this flow.

**Scenarios**:

- Event file change detected as hash-breaking: graph with edge referencing event X. Store parameter with known `query_signature`. Edit event X's `amplitude_filters`. Run guard. Assert: identifies affected parameter, computes correct old `core_hash` (from stored signature) and new `core_hash` (recomputed with updated definition), produces valid mapping entry.
- Context file change detected as hash-breaking: same pattern for context definition change.
- Non-hash-breaking change is silent: change only `name` field on context. Run guard. Assert: no affected parameters (hash unchanged).
- Adding a context value IS hash-breaking (whole-file hash): add variant IV. Run guard. Assert: guard fires, offers mapping for all affected parameters.
- Multi-graph, indirect reference: event X referenced by nodes in graphs A, B, C. Edit event X. Assert guard finds affected parameters in all three.
- New file (no git HEAD version) skips guard: create brand new event file. Assert: no comparison attempted.
- Multiple dirty files in one commit: edit event X and context Y. Assert guard finds affected parameters for both, produces separate mapping entries.
- Guard produces correct `hash-mappings.json` structure: after "select all", assert written file has `core_hash`, `equivalent_to`, `operation: "equivalent"`, `reason` includes changed filename.
- Old `core_hash` matches stored signature: guard reads old `core_hash` from parameter's stored `query_signature`. Assert this is the actual hash under which data was stored, not a recomputed approximation.
- Parameter with no stored `query_signature` (never fetched): skip mapping, nothing to preserve.
- Shared parameter deduplication: same parameter referenced by multiple edges. Assert exactly one mapping entry.

**Mock decisions**: Real IDB, real FileRegistry, real `computeQuerySignature`, real `hashMappingsService`. Mock git operations (reading HEAD version).

#### Area 2: Behavioural Segment Filter Construction (SEVERE)

**Invariant**: Variant context values with `type: behavioral` source mappings must produce correct Amplitude payloads. "Other" complement must produce correct "did NOT perform" payload. DAS adapter and funnel builder must agree.

**Tier**: Focused integration for filter construction; conformance test for adapter/builder parity.

**Extends**: `buildDslFromEdge.contexts.test.ts` + `amplitudeFunnelBuilder.conformance.test.ts`

**Scenarios**:

- Behavioural source mapping produces `ContextFilterObject` with `type: 'behavioral'`, `event_type`, `filter_property`, `filter_value`, `time_type`, `time_value`.
- Property-based source mapping is unchanged (backward compat): no `type` field in output.
- "Other" complement for behavioural context: `context(variant:other)` with `otherPolicy: 'computed'` produces "did NOT perform event" shape.
- Missing `type` field defaults to property-based.
- Mixed property + behavioural filters: one of each in same QueryPayload. Both code paths handle the mix.
- Conformance: DAS adapter and funnel builder produce identical segment objects for behavioural filters.

**Mock decisions**: Context registry: real. Amplitude API: mocked.

#### Area 3: CLI Tool Validation (MODERATE)

**Invariant**: CLI tool produces identical hashes to the app's IDB-based code path.

**Tier**: Integration. Validates the filesystem adapter doesn't diverge.

**Extends**: golden fixture tests (`core-hash-golden.json`)

**Scenarios**:

- `compute-hash` against golden fixture inputs produces matching output.
- `diff-hash` correctly identifies changed vs unchanged edges after a file edit.
- `add-mapping` produces valid `hash-mappings.json` entries (no duplicates, no self-links, correct format).

#### Area 4: MECE Aggregation with Variants (MODERATE)

**Invariant**: Variant slices with `otherPolicy: 'computed'` must be detected as MECE. Uncontexted queries must aggregate correctly.

**Tier**: Integration. Real context registry, real aggregation service.

**Extends**: `contextAggregation.test.ts` + `contextRegistry.test.ts`

**Scenarios**:

- MECE detected for variant with `otherPolicy: 'computed'`: values I, II, III plus auto-created "other". Assert `isMECE: true, canAggregate: true`.
- Aggregation produces correct totals: three slices with known n/k. Assert sum.
- Incomplete variant set: only I and II. Assert `isComplete: false, canAggregate: false`.

### Test Locations Summary

| Area | Risk | Suite | New file? |
|------|------|-------|-----------|
| 1. Hash guard | Catastrophic | — | Yes: `commitHashGuard.integration.test.ts` |
| 2. Behavioural filters | Severe | `buildDslFromEdge.contexts.test.ts` + conformance | No |
| 3. CLI tool | Moderate | Golden fixture tests | No |
| 4. MECE aggregation | Moderate | `contextAggregation.test.ts` + `contextRegistry.test.ts` | No |

### Implementation Order

1. Area 2 first (behavioural filters) — can be developed independently.
2. Area 3 (CLI tool) — needed for Area 1 development and agentic workflow.
3. Area 1 (hash guard) — most implementation-heavy; uses CLI tool for validation.
4. Area 4 (MECE) — depends on variant contexts being loadable.

## Implementation Plan

### Phase 0: Amplitude Spike (1 session)

**Goal**: Validate that behavioural segment filters work in the Amplitude API.

**Approach**: Create a spike script that:

1. Constructs a funnel query (e.g. b→c where c is the variant-discriminating event)
2. Adds a behavioural segment filter: "user has done EventC where variant_property = II within 366 days"
3. Executes against the Amplitude API with real credentials
4. Verifies: response contains data, user counts are plausible, segment restricts population
5. Constructs the "did NOT perform" complement and verifies complementary population
6. Confirms I + II + III + other ≈ total (within Amplitude's sampling tolerance)
7. Tests mixed filters: BOTH a property-based filter (channel:google) AND a behavioural filter (variant:II) on the same query. Verifies they AND correctly.

**Why first**: If behavioural segment filters don't work as expected, the design needs revisiting before building anything.

**Deliverable**: Spike script committed to `scripts/spikes/`, with output demonstrating correct behaviour.

### Phase 1: CLI Hashing Tool (1–2 sessions)

**Goal**: Build the CLI tool and establish hash regression anchors.

**Steps**:

1. Implement `scripts/compute-hash.ts` — import production TS modules, add filesystem-based context/event loader
2. Run against real data repo files to generate golden hash fixtures
3. Implement `scripts/diff-hash.ts` and `scripts/add-mapping.ts`
4. Validate CLI against existing golden fixture (`core-hash-golden.json`) — confirm filesystem loader produces identical results to IDB loader
5. Test manually against data repo

### Phase 2: Behavioural Segment Filters (2–3 sessions)

**Goal**: Implement `type: behavioral` source mapping and Amplitude payload construction.

**Steps**:

1. Define behavioural source mapping schema in context value types
2. Update `buildContextFilters` to produce behavioural `ContextFilterObject`
3. Update DAS adapter (`connections.yaml` pre_request) for behavioural segment construction
4. Update `amplitudeFunnelBuilderService` for matching segment conditions
5. Write and run filter construction tests (Area 2)
6. Write and run conformance tests
7. Validate against real Amplitude API using adapted Phase 0 spike

### Phase 3: Commit-Time Hash Guard (2–3 sessions)

**Goal**: Implement the pre-commit guard.

**Steps**:

1. Implement hash-change detection (compare git HEAD vs IDB state for dirty event/context files)
2. Implement graph scanning to find affected parameters
3. Implement pre-commit gate in commit flow (block, present UI, modify changeset)
4. Implement tab header warning for dirty event/context files
5. Write and run guard integration tests (Area 1)
6. Manual testing: edit event file, commit, verify guard fires and produces correct mappings

### Phase 4: Graph-Ops Playbook + Agentic Workflow (1 session)

**Goal**: Document workflow and validate with a real agentic editing session.

**Steps**:

1. Write `manage-hash-mappings.md` playbook in graph-ops
2. Update existing playbooks with hash impact notes
3. Write `validate-hashes.sh` script
4. Test full agentic workflow: Claude edits event file, runs diff-hash, adds mappings, commits

---

## Appendix: Design Discovery Journey

This appendix records the reasoning path that led to the final design. Preserved for future reference — the dead ends are as instructive as the conclusions.

### Starting point: per-value hashing

The initial approach was to change the hashing algorithm so that adding a new context value wouldn't change the hash for existing values. This led to a proposed `valueHashing: true` flag on context definitions that would hash only structural fields plus the specific value's source mapping for each slice.

### Complication 1: per-slice signatures

Per-value hashing meant different slices of the same edge would need different context definition hashes, and therefore different `core_hash` values. This conflicted with the current model where all slices share one `core_hash` and differ by `slice_key`. It would have required `computeQuerySignature` to accept a `sliceDSL` parameter and be called once per slice — a significant architectural change to the signature/snapshot model.

### Complication 2: `strictHashMatching`

The question of whether adding a new value should invalidate the "other" slice led to a proposed `strictHashMatching` boolean. For variant contexts (additive values), "other" shouldn't be invalidated. For channel contexts (discovered values), it should. This added a second flag and complex interaction logic between the two flags.

### Complication 3: migration

Changing the hashing algorithm for existing contexts would orphan their historical snapshots. This led to increasingly complex migration strategies:

1. **Compatibility hash via closure set**: compute both old (whole-file) and new (per-value) hashes, inject the old hash into the closure set. Failed because the compatibility hash would drift as the context definition evolved (adding values under permissive hashing).

2. **`hash-mappings.json` entry at transition time**: create a mapping when switching from `valueHashing: false` to `true`. Simpler but still required tracking the transition.

3. **Dual-hash generation**: FE computes both old and new hashes and sends both to the BE. Would require the old hash to be computed excluding the new fields (`valueHashing`, `strictHashMatching`) to reproduce the pre-existing hash. Fragile as the definition drifts.

### Complication 4: backend matching

The signature matching doesn't just happen in the frontend — the fetch planner generates hashes that are matched in the backend. Context definition files aren't always available at match time. This ruled out any approach requiring context definitions during matching.

### Key realisation: structural-only hashing

If per-value source mapping hashes aren't needed (because mapping changes are naturally superseded by new fetches under the same `core_hash`), then the context definition hash only needs structural fields. This would make `core_hash` stable when values are added or mappings change. Only structural changes (`otherPolicy`, etc.) would break the hash.

This eliminated the need for `strictHashMatching` (no per-value hashes to selectively invalidate) and simplified the model significantly.

### Final realisation: no hashing changes needed at all

The commit-time hash guard with `hash-mappings.json` handles everything. When a user adds variant IV, the whole-file hash changes, the guard catches it, the user creates a mapping, and old snapshots remain accessible via the closure set. No hashing algorithm change required. No new fields on context definitions. No migration.

The guard is generic — it protects against ALL hash-breaking changes (not just variant-related ones), making it valuable independently. The behavioural segment filter support is the only variant-specific feature.

### Lessons

1. **The existing equivalence infrastructure (`hash-mappings.json` + closure sets) was already the right tool.** The complexity of per-value hashing was solving a problem that the mapping system already solved.

2. **Schema changes have cascading costs.** Each new field (`valueHashing`, `strictHashMatching`) created interaction complexity, migration requirements, and testing surface. Eliminating them eliminated entire categories of bugs.

3. **"Let it break and bridge it" is simpler than "prevent it from breaking."** The guard + mapping approach is operationally clearer (the user sees and approves each transition) and architecturally simpler (no hashing changes, no format changes, no migration).

4. **The snapshot DB's append-only model with `retrieved_at` ordering means mapping changes are naturally superseded.** This key property made structural-only hashing viable — but ultimately made NO hashing changes the right answer, because the guard handles the bridging.
