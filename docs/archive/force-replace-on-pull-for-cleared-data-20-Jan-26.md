## Proposal: Force-replace-on-pull for “Clear Data” (one-shot, per-file)

**Date**: 20-Jan-26  
**Status**: Draft proposal  
**Owner**: (TBD)  

### Problem statement

Users need a reliable way to “clear data” (e.g. wipe retrieved time-series / schedules) such that the clear:

- **Propagates across machines** via Git pull.
- **Does not get undone** by other clients with dirty local files during pull.
- Avoids “debugging custom merge logic” for YAML arrays (e.g. `values[]`).

Current behaviour: when a client has a dirty local parameter/case file, `pullLatest()` performs a **line-based 3‑way merge**. If the remote version has *deleted* data blocks but the local dirty version still contains them, the merge may preserve those blocks, effectively “resurrecting” stale data and reintroducing repo bloat on subsequent commits.

### Design goals

- **One-shot** mechanism: once applied, normal pull behaviour resumes automatically (no manual clean-up).
- **Scoped**: only affects files that explicitly opt into this behaviour, and only when needed.
- **User-controlled overwrite**: if overwrite would discard local uncommitted changes, the user must be able to choose (default “OK” with countdown; secondary “Cancel” to keep merge).
- **Service/UI separation**: business logic stays in services; UI remains an access point.
- **Minimal blast radius**: apply only to derived-data-bearing files (parameters/cases), not graphs/nodes.

### Proposed mechanism: per-file `force_replace_at_ms` epoch

Add an optional root-level field to parameter and case files:

- `force_replace_at_ms` (number; epoch milliseconds)

Semantics:

- The value represents a **one-time “force replace” request** for that file.
- When the remote has a newer `force_replace_at_ms` than the local file, and the local file is dirty, the client may choose to **skip 3‑way merge** and **overwrite local with remote** for that file.
- Because the remote content is applied (including the new timestamp), after replacement the local and remote timestamps match, so the condition does not trigger again. This makes it **one-shot** by construction.

### When the flag is set

The flag is set automatically as part of the user action **Clear Data**:

- **Parameter files**: clear `values[]` to empty and set `force_replace_at_ms = now`.
- **Case files**: clear schedules (or equivalent case payload) and set `force_replace_at_ms = now`.

The intent is: “I am explicitly clearing derived data and I want this clear to be respected across devices, even if other devices have local dirty versions.”

### Pull-time behaviour (high level)

During `pullLatest()` for a parameter/case file where the local is dirty:

- If remote does **not** request force replace (no timestamp, or not newer): use existing behaviour (3‑way merge / conflicts).
- If remote **does** request force replace (timestamp newer than local):
  - The client must make a **user-visible decision**:
    - **OK (default)**: skip merge and overwrite local with remote for that file.
    - **Cancel**: proceed with normal 3‑way merge for that file (no force replace).

This decision is per pull, and only affects the subset of files that request it.

### UX proposal: modal with countdown (default OK)

When pull detects one or more dirty param/case files requesting force replace:

- Show a modal:
  - Title: “Force replace requested”
  - Body: “N file(s) request force replace. This will overwrite your uncommitted local changes for those files.”
  - List the affected files (file IDs and/or paths) for clarity.
- Actions:
  - **OK** (default)
  - **Cancel**
- Countdown:
  - 10s countdown visible in modal.
  - When countdown reaches 0, behave as if OK was clicked.

Cancel semantics (explicit):

- **Cancel does not abort pull**.
- Cancel means: “Do not force replace; proceed with normal pull behaviour (3‑way merge/conflicts) for those files.”

### Orchestration approach (two-step pull)

Because `workspaceService.pullLatest()` must remain UI-free, the pull flow is orchestrated in the hook layer (e.g. `usePullAll()`), with services returning structured information.

Two-step flow:

- **Step A: Preflight pull**
  - Run a “detect-only” pull pass that identifies `forceReplaceRequests` (dirty local + remote timestamp newer).
  - This step must not apply force replace yet; it either:
    - (Preferred) performs no file mutations at all, only detection, or
    - defers only the affected files while applying non-affected files (choose one and implement consistently).

- **Step B: Apply pull**
  - Show modal if requests exist.
  - Based on user choice (OK vs Cancel), rerun pull with:
    - `forceReplaceFileIds = [requested ids]` for OK / countdown expiry, or
    - `forceReplaceFileIds = []` for Cancel.
  - In apply mode, `pullLatest()`:
    - For `forceReplaceFileIds`: overwrites local with remote (skip merge).
    - For other dirty files: continues existing 3‑way merge/conflict behaviour.

This keeps the decision in UI, while keeping all data and sync logic in services.

### Data model / schema impact

Parameter schema currently declares `additionalProperties: false`, so we must explicitly add:

- `force_replace_at_ms` to `graph-editor/public/param-schemas/parameter-schema.yaml`

Case schema must be updated similarly (locate the corresponding schema file and add the field).

Types / validation:

- Update TypeScript types/interfaces that represent parameter/case file shapes (where they exist).
- Update any Python/Pydantic models that parse these YAML files (if applicable).
- Ensure any YAML normalisation / editors do not drop the field on save.

### Service changes (prose)

#### Clear Data operation

File: `graph-editor/src/hooks/useClearDataFile.ts`

- When clearing parameter data:
  - Ensure the clear is a full clear (no stub entries).
  - Set `force_replace_at_ms` to the current epoch ms.
- When clearing case data:
  - Clear schedules/payload.
  - Set `force_replace_at_ms` similarly.
- Add session logging for:
  - Which file(s) were cleared
  - The timestamp applied

#### Pull behaviour

File: `graph-editor/src/services/workspaceService.ts`

In the “local is dirty” path for parameter/case files:

- Parse local and remote YAML to read `force_replace_at_ms` (best-effort; failure should fall back to existing merge behaviour).
- In detect-only mode:
  - Do not apply replacement.
  - Record the request (file id/path, local timestamp, remote timestamp).
- In apply mode:
  - If the file is in `forceReplaceFileIds`, overwrite local with remote for that file (skip merge).
  - Otherwise, run existing 3‑way merge/conflict logic unchanged.

Return value:

- Extend the pull result to include `forceReplaceRequests` and `forceReplaceApplied` (for logging/UI).

#### Pull hook + modal

Files:

- `graph-editor/src/hooks/usePullAll.ts`
- New UI component under `graph-editor/src/components/modals/` for “ForceReplaceOnPullModal” (UI-only)

Behaviour:

- Run Step A preflight.
- If no requests: proceed as today.
- If requests:
  - Show modal with 10s countdown and OK default.
  - On OK / countdown expiry: run Step B with allow-list populated.
  - On Cancel: run Step B with empty allow-list (normal merge).
- Session log:
  - Record that a force-replace prompt occurred, the number of files, and user choice.

Reuse:

- Countdown mechanics already exist in `useStalenessNudges.ts` and can be mirrored (not necessarily reused directly).

### Testing plan (prose)

Extend existing suites (no new test files unless there is no sensible home):

- `graph-editor/src/services/__tests__/workspaceService.integration.test.ts`
  - Dirty local parameter file with old data, remote has newer `force_replace_at_ms`:
    - Detect-only pass returns request without modifying file.
  - Apply pass with allow-list includes that file:
    - File content becomes remote version (overwrite; no merge markers; dirty cleared appropriately).
  - Apply pass with empty allow-list:
    - Existing 3‑way merge behaviour occurs (merged or conflicts) and force-replace is not applied.

- Hook/UI tests (existing pull hook tests, or add to the most relevant current pull hook test file):
  - When `forceReplaceRequests` returned:
    - Modal appears with countdown.
    - Countdown expiry triggers “OK” path.
    - Cancel triggers merge path.

### Risks and mitigations

- **Risk: overwriting genuine local edits**: This is the point of force replace, but the modal + Cancel provides an escape hatch.
- **Risk: schema strictness**: must update schema(s) or the field may be rejected/dropped.
- **Risk: unexpected “pull mutates files”**: preflight vs apply must be implemented carefully to avoid partial side effects; prefer preflight that performs no mutations.
- **Risk: automation/headless runs**: automation should default to OK (apply force replace) to converge reliably; log the action.

### Open decisions

- **Preflight purity**: should detect-only do zero mutations (preferred) vs apply non-affected files immediately?
- **Scope**: confirm whether cases should participate exactly like parameters.
- **Naming**: confirm final field name (`force_replace_at_ms`) and whether it should live at root or under `metadata`.

