# Change Checklist

## Before Submitting Changes

- [ ] Traced the full code path and identified all call sites
- [ ] No business logic in UI/menu files — all in services
- [ ] No duplicate code paths — centralised in one canonical function
- [ ] IndexedDB is source of truth for git operations (`db.getDirtyFiles()`)
- [ ] Workspace prefixes handled correctly (IDB: `repo-branch-fileId`, FileRegistry: `fileId`)
- [ ] Index files at root with plural names (`nodes-index.yaml`, `parameters-index.yaml`)
- [ ] Tests updated, new tests for bug fixes, relevant tests passing
- [ ] All UI entry points use the same code path

## Pre-Completion Verification (MANDATORY before saying "done" or "fixed")

Do NOT claim a fix is complete until you have verified it. "I changed the code" is not "it works". The most expensive failure mode is premature "done" — it wastes a full round-trip when the user discovers it's still broken.

**Before reporting completion**:
1. **Run the relevant test(s)** — not the full suite, but the specific test file(s) covering the changed behaviour. **If no test exists for the new code path, write one first — this is a hard block, not a suggestion.** See rule 4 in "ALWAYS UPDATE TESTS" in CLAUDE.md. A `NameError` or `UnboundLocalError` in untested code that could have been caught by a 10-second pytest is an unacceptable failure mode.
2. **Check all call sites** — grep for the function/field you changed and verify every caller still works with the new behaviour.
3. **Verify state in all affected layers** — if you changed something that touches persistence, verify in IDB, FileRegistry, AND GraphStore (not just the one you modified). See SYNC_SYSTEM_OVERVIEW.md for the 4-layer model.
4. **Test the "already clean" case** — if your fix clears/deletes state, verify it also works when the state is already absent. Idempotency failures are the #1 cause of "worked once, fails on second run" bugs.
5. **State what you verified and how** — tell the user: "Verified by running [test]. Checked [N] call sites. Confirmed state cleared in [layers]." If you can't state what you verified, you didn't verify it.

## Adding New Fields or Features - FULL IMPACT ASSESSMENT

**CRITICAL**: When adding a new field (e.g., `n_query`), you MUST check ALL places where similar fields are handled.

**Required checklist for new fields:**
- [ ] **TypeScript types** (`src/types/index.ts`) - Add to relevant interfaces
- [ ] **Python Pydantic models** (`lib/graph_types.py`) - Add to relevant models
- [ ] **YAML schemas** (`public/param-schemas/`) - Add field definitions
- [ ] **Service types** (`src/services/*Service.ts`) - Add to any service-specific interfaces
- [ ] **UI components** - PropertiesPanel, editors that display/edit the field
- [ ] **UpdateManager** - If field contains node references, update on node ID rename
- [ ] **Services** - Storage, retrieval, sync logic (dataOperationsService, etc.)
- [ ] **Override patterns** - If field has `_overridden` companion, mirror the pattern
- [ ] **Bayes posterior fields** - If adding to `PosteriorSummary` or `LatencyPosteriorSummary`, also add to `_build_unified_slices()` in `worker.py` (both window and cohort dicts) AND to `bayesPatchService.ts` projection. See anti-pattern 14.

**Finding companion fields**: grep for a similar field (e.g. `query_overridden`, `.query\b`) across `.ts`, `.tsx`, `.py`, `.yaml` to find all places where the pattern is used, then replicate for the new field.

**Patterns to mirror**: `field` + `field_overridden` pair, UpdateManager node ID replacement, PropertiesPanel blur-to-save, service layer push/fallback. Add tests for storage/retrieval, override behaviour, and UpdateManager replacement if the field contains node references.
