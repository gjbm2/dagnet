---
title: Scenario Seeding from Graph JSON
date: 13-Apr-26
status: draft
---

# Scenario Seeding from Graph JSON

## Problem

DagNet's scenario system stores scenarios exclusively in IndexedDB, keyed by `fileId`. The graph JSON file contains a `scenarios` array, but the editor never reads it on load -- the `ConversionGraph` TypeScript interface does not even declare a `scenarios` property. This creates several problems:

- **No portability**: scenarios created by one user cannot be shared with others via the graph file.
- **No durability**: scenarios do not survive clearing site data or opening the graph on a different machine.
- **No programmatic seeding**: adding scenarios to the JSON (e.g. for experiment monitoring dashboards) has no effect -- the array is write-only orphaned data.
- **Asymmetric persistence**: the JSON `scenarios` array may be populated (e.g. from a prior save path) but is never consumed, creating confusion about what the file actually contains.

The only existing seeding mechanism is for share bundles (`TabContext.tsx` lines 1705--1727), where `item.scenarios` from a share bundle are written to IDB. Normal file opens have no equivalent path.

## Solution

Add a seed-from-file mechanism: when a graph file is opened and IDB has **no** scenarios for that `fileId`, seed IDB from the graph JSON's `scenarios` array (if present). This mirrors the pattern share bundles already use.

### Design principles

1. **Seed, don't sync** -- only seed when IDB is empty for that file. Once the user has scenarios in IDB (including zero scenarios after deliberate deletion), the file's array is not re-applied. IDB remains authoritative at runtime.
2. **Add `scenarios` to `ConversionGraph` interface** -- so TypeScript recognises the field and the loader can extract it without casting.
3. **Write scenarios back to JSON on save** -- so user-created scenarios persist in the file for others to pick up. (Verify whether an existing save path already does this; if so, no new work needed.)
4. **Preserve IDB-first architecture** -- IDB remains the runtime source of truth. The file is a transport/persistence layer only.

### Implementation sketch (prose only)

- **Type change**: add an optional `scenarios?: Scenario[]` property to the `ConversionGraph` interface in `types/index.ts`.
- **Load path**: in `TabContext.tsx` (around the graph-loading block at lines 2119--2160), after the graph is parsed, check whether `db.scenarios` has any rows for the current `fileId`. If the count is zero and the parsed graph has a non-empty `scenarios` array, write those scenarios to IDB via `db.scenarios.bulkPut()`, mirroring the share-bundle seeding logic.
- **Validation**: before writing, validate each scenario entry has at minimum an `id` and `name`. Skip malformed entries with a session log warning rather than failing the entire load.
- **Save path**: verify that the existing file-save logic in `ScenariosContext.tsx` or `fileOperationsService.ts` already serialises scenarios back into the graph JSON. If not, add a step that reads from IDB and attaches to the graph object before writing.

## User Stories

1. **As a graph author**, I want to add scenarios to a graph JSON file so that when another user opens the file for the first time, they see my pre-configured scenarios without manual setup.
2. **As a product analyst**, I want to programmatically insert scenario definitions into a graph JSON (e.g. via a CI script for experiment monitoring) and have them appear in the editor when the file is opened.
3. **As a user who cleared site data**, I want my scenarios to reappear from the graph file when I reopen it, rather than losing all scenario work permanently.
4. **As a user who has customised scenarios locally**, I want my local scenarios to be preserved and not overwritten when I reopen a file that contains different scenarios in its JSON.

## Acceptance Criteria

- [ ] The `ConversionGraph` TypeScript interface includes an optional `scenarios` property typed as `Scenario[]`.
- [ ] When a graph file containing a non-empty `scenarios` array is opened and IDB has zero scenarios for that `fileId`, the file's scenarios are written to IDB and appear in the Scenarios panel.
- [ ] When a graph file containing a non-empty `scenarios` array is opened and IDB already has one or more scenarios for that `fileId`, the file's scenarios are ignored and the existing IDB scenarios are preserved unchanged.
- [ ] When a graph file has no `scenarios` property (or it is an empty array), the load proceeds normally with no IDB writes and no errors.
- [ ] Malformed scenario entries in the JSON (e.g. missing `id` or `name`) are skipped individually; valid entries in the same array are still seeded. A session log warning is emitted for each skipped entry.
- [ ] When a file is saved, the current IDB scenarios for that `fileId` are serialised into the graph JSON's `scenarios` array, so the file always reflects the latest scenario state.
- [ ] The seeding logic is covered by an integration test that: (a) loads a graph with scenarios into an empty IDB and verifies they appear; (b) loads the same graph when IDB already has scenarios and verifies the IDB scenarios are not overwritten.
- [ ] The share-bundle seeding path (`TabContext.tsx` lines 1705--1727) continues to work unchanged.
- [ ] No regressions in existing scenario CRUD operations (create, rename, delete, duplicate, toggle active).

## Edge Cases

- **IDB has scenarios, file has different scenarios**: IDB wins. The file's scenarios are not merged or compared -- they are simply ignored. This avoids complex conflict resolution.
- **User deletes all scenarios, then reopens the file**: IDB is now empty for that `fileId`, so the file's scenarios seed again. This is acceptable -- the user can delete them again. A future enhancement could track "user explicitly cleared scenarios" but that is out of scope.
- **Multiple tabs with the same file**: standard IDB concurrency applies. The seeding check (`count === 0`) is not atomic with the write, but the worst case is double-seeding with identical data, which `bulkPut` handles idempotently.
- **Very large scenario arrays**: no artificial limit, but scenarios are lightweight (sparse param overlays). A graph with hundreds of scenarios would be unusual and is not expected to cause performance issues.
- **File scenarios reference parameters or nodes that don't exist in the graph**: the scenarios are seeded as-is. Invalid references will surface naturally when the user tries to render/compute the scenario, matching existing behaviour for manually created scenarios with stale references.

## Out of Scope

- **Real-time scenario sync between users** -- that is a collaboration feature requiring conflict resolution and live transport.
- **Merging IDB scenarios with file scenarios** -- adds significant complexity (duplicate detection, conflict UI) for minimal gain. Seed-or-skip is sufficient.
- **Changing runtime scenario storage** -- IDB remains the authoritative store. This PRD only adds a file-to-IDB seeding path and an IDB-to-file persistence path.
- **Share bundle changes** -- the existing share-bundle seeding logic already works and is not modified.
- **Migration of existing orphaned `scenarios` arrays** -- old graph files with `scenarios` arrays will naturally be consumed by the new seeding logic when opened.

## Technical Considerations

- **Precedent**: the share-bundle seeding path in `TabContext.tsx` (lines 1705--1727) is the direct precedent. The implementation should mirror its structure and error handling.
- **IDB schema**: the `db.scenarios` table already has the required schema (`'id, fileId, createdAt, updatedAt'`). No migration needed.
- **Scenario data model**: each scenario has `id`, `name`, `colour`, `params` (sparse parameter overlay), and `meta` (containing `queryDSL`, `isLive`, provenance timestamps). The seeding logic should preserve all fields from the JSON without transformation.
- **Save-path verification needed**: it is unclear whether the existing save logic already writes scenarios to the graph JSON. If it does, only the load-path seeding is new work. If it does not, a save-path change is also required. This should be verified during implementation.
- **Session logging**: seeding events should be logged via `sessionLogService` at `info` level (e.g. "Seeded 3 scenarios from graph file for fileId X"). Skipped malformed entries should be logged at `warning` level.
- **`ScenariosContext` coordination**: the seeding must happen before `ScenariosContext` reads from IDB (or `ScenariosContext` must re-read after seeding). The simplest approach is to seed in `TabContext.tsx` during file load, before the scenarios context initialises for that file.

## Review Findings (Codex, 13-Apr-26)

### Resolved — incorporated into design above

1. **Scenario ID collisions (HIGH)**: `db.scenarios` is keyed globally by `id`, not `(fileId, id)`. Two graph files with a scenario called `"baseline"` would overwrite each other. **Resolution**: on seeding, regenerate UUIDs for all seeded scenarios (preserve the original `id` in a `sourceId` field for debugging). This matches how share bundle seeding works.

2. **Save path does not exist (HIGH)**: scenarios are never written back to the graph JSON. The commit pipeline only serialises `file.data`; IDB scenarios are invisible to git. **Resolution**: add a pre-commit hook in the graph serialisation path (`repositoryOperationsService.ts:885`) that reads scenarios from IDB and attaches them to the graph object before serialisation. This must be in the central serialisation path used by both SHA comparison and commit content.

3. **Delete-all vs empty-IDB ambiguity (MEDIUM)**: `count === 0` cannot distinguish "never loaded" from "user intentionally cleared". **Resolution**: accept re-seeding on reopen as the simpler design. Add a `scenariosSeedSuppressed` flag in IDB per fileId only if user feedback indicates this is a real annoyance. For now, the user can delete re-seeded scenarios — they are lightweight.

4. **Validation too weak (MEDIUM)**: `Scenario` type requires `colour`, `createdAt`, `version`, `params`, not just `id` and `name`. **Resolution**: normalise defaults on seed — generate `createdAt` if absent, default `colour` from palette, default `version: 1`, default `params: {}`. Only `id` and `name` are truly required in the JSON; everything else gets sensible defaults.

5. **Load-order race (MEDIUM)**: seeding must complete before `ScenariosProvider` mounts for the file. **Resolution**: seed in the graph-loading block of `TabContext.tsx` (synchronously before the tab state is set), matching the share bundle precedent. The share bundle code already documents this race in `useShareBundleFromUrl.ts:131`.

## Open Questions

1. ~~Does the existing save path already write scenarios to the graph JSON?~~ **Answered: No.** Verified by Codex review — `repositoryOperationsService.ts:885` serialises `file.data` directly. A new serialisation hook is required (see Review Finding #2).
2. **Should seeded scenario IDs be deterministic?** Using `crypto.randomUUID()` means the same file produces different IDB IDs on each seed. This is fine for correctness but means scenarios can't be referenced by stable ID from canvas analyses in the JSON. Alternative: hash-based deterministic IDs from `fileId + sourceId`. Leaning towards random UUIDs (simpler, matches share bundle behaviour).
3. **Should the save-path serialisation include scenario `params`?** Params can be large (12 edges × N scenarios). Including them ensures round-trip fidelity. Excluding them keeps the JSON smaller but breaks seeding for pre-populated scenarios. Leaning towards including them — the data is already in the file via retrieve-all automation.
