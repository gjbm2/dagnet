# Cohort maturity v1 / v2 retirement (soft-migration to v3)

**Status**: Draft, pending review
**Date opened**: 1-May-26
**Author**: Claude (scoped by greg@nous.co)
**Successor analysis**: `cohort_maturity` (internally `cohort_maturity_v3`)

## Purpose

Retire the legacy `cohort_maturity_v1` and `cohort_maturity_v2` analysis types from the live UI, the BE handlers, the supporting modules, and the test suite, while preserving compatibility for any persisted artefact (saved analysis, exported JSON, bookmarked CLI invocation, fixture, downstream tool) that still references those identifiers. The unversioned `cohort_maturity` analysis (v3 internally) is the live successor and has been since v3 was promoted; v1 and v2 are flagged `devOnly: true` in the FE registry and exist primarily for parity testing and historical compatibility.

The shape of the soft-migration is two thin alias boundaries:

- A **dispatch alias** in the BE so that an incoming `analysis_type` of `cohort_maturity_v1` or `cohort_maturity_v2` is normalised to `cohort_maturity` and routed to the v3 handler.
- A **load-time normalisation** in the FE so that any saved analysis carrying a v1 or v2 identifier is rewritten to `cohort_maturity` at the loader boundary, before the analysis-type resolution service is consulted.

With those two alias boundaries in place, every other v1/v2 reference in the live runtime becomes dead code. The remainder of the plan deletes the dead code, retires the dedicated tests and registry entries, and updates the developer-facing documentation and CLI shortcuts to advertise the canonical identifier.

This is not a feature change. The displayed analysis behaviour after the soft-migration is identical to the current v3 behaviour for any caller. Callers that currently send v1 or v2 will get v3 results — which, given the v1/v2 dispatch table already exists alongside v3 and v3 has been the production analysis for some time, is the intended modern semantics. The cost of the migration is borne by the codebase, not by users.

## Non-Goals

This plan does not modify any v3 behaviour, signature, or public contract. Any change required inside `cohort_maturity_v3` to accept legacy `analysis_type` strings must be limited to the dispatch surface; no semantics inside the v3 handler change.

This plan does not migrate or rewrite persisted user data eagerly. Saved analyses that still encode `cohort_maturity_v1` or `cohort_maturity_v2` continue to load, are normalised at the loader boundary, and are rewritten to the canonical identifier opportunistically on next save. There is no separate migration script and no IDB sweep.

This plan does not delete any historical or design documentation that mentions v1 or v2 in a retrospective context. Plan docs, design docs, and handover notes that record why v2 was built or why it was frozen are kept intact as a record of the project history. Only documentation that presents v1 or v2 to current users or developers as a live choice is rewritten.

This plan does not remove `cohort_forecast.py`, `cohort_maturity_derivation.py`, `span_kernel.py`, `span_adapter.py`, or `span_evidence.py`. Those modules are shared with v3 and remain live. The only candidate orphan is `cohort_forecast_v2.py`, which is verified for residual callers and deleted only if the verification confirms zero remaining references.

This plan does not touch the snapshot-DB workstream or the 73n primitive-conditioning workstream. The retirement is independent of both and must not regress either.

## Approach overview

The retirement proceeds in six stages after a baseline. The ordering is chosen so that the soft-migration alias boundaries are in place before any deletion, so at no point during execution does a saved analysis or CLI invocation referencing v1 or v2 fail to resolve.

Stage 0 records the current state — every live reference, every test, every fixture, every doc that mentions v1 or v2 — and verifies the scoping report's findings against the codebase. Stage 1 puts the BE dispatch alias in place. Stage 2 puts the FE load-time normalisation in place and removes the v1/v2 entries from the FE registry and dispatch tables, so users no longer see them as choices. Stage 3 deletes the v2 handler and the v1-specific conditional logic from the BE, then verifies and deletes any module that has become an orphan. Stage 4 updates the test suite. Stage 5 rewrites the developer-facing documentation and the CLI shortcuts. Stage 6 is an acceptance sweep and a final orphan check.

After Stage 1 and Stage 2 land, the codebase is in a stable interim state where the user-facing surface no longer offers v1 or v2 but the backend handler code for v2 still exists; this is intentional, so each later stage is independently revertible without breaking the soft-migration.

## Preconditions

The plan assumes the v3 handler is the live, production cohort-maturity implementation and has been for long enough that no active development relies on v1 or v2 being independently dispatchable. The Stage 0 baseline must verify this assumption against the codebase before any code change. If Stage 0 finds active production callers that depend on v1 or v2 having distinct semantics from v3, the plan halts and is reconsidered as a deprecation rather than a retirement.

The plan also assumes that the analysis-type resolution service is the single FE boundary at which a saved analysis's `analysis_type` is consulted to choose a chart kind and a request shape. If Stage 0 finds that `analysis_type` is consulted in additional FE locations not routed through that service, the load-time normalisation is repositioned upstream of all such locations.

## Stage 0 — Baseline and verification

Stage 0 is documentation-only. No code or test change is made.

Required record:

- every BE call site at which `analysis_type` is matched against `cohort_maturity_v1` or `cohort_maturity_v2`, with file paths and line numbers, distinguishing dispatch-table entries from inline string comparisons that gate behaviour;
- every FE registry entry, chart-kind mapping, resolution-service mapping, and inline string comparison for `cohort_maturity_v1` or `cohort_maturity_v2`, with file paths and line numbers;
- every test file that mentions either identifier, classified as one of: dedicated v1/v2 test (delete entirely in Stage 4), v1/v2 incidental mention alongside v3 (audit and update in Stage 4), or fixture file containing the literal string (verify whether the fixture pins behaviour or merely records a request shape);
- every documentation file that mentions either identifier, classified as one of: live documentation presenting v1/v2 as a current choice (rewrite in Stage 5), retrospective design or plan doc (leave as-is);
- every `.claude/settings*.json` shortcut that includes either identifier, with the count of affected lines;
- the import graph rooted at `cohort_forecast_v2.py`, `_handle_cohort_maturity_v2`, and any other v2-only symbol, with the names of modules that would become orphans if those symbols are deleted;
- the import graph rooted at `cohort_forecast.py`, `cohort_maturity_derivation.py`, `span_kernel.py`, `span_adapter.py`, and `span_evidence.py` from the v3 handler side, confirming each remains live;
- the canonical FE loader boundary at which a saved analysis's `analysis_type` is first consulted, identified precisely so that Stage 2's normalisation helper sits upstream of every consumer;
- the BE deprecation-log mechanism currently in use for analysis-type dispatch, if any, so Stage 1's deprecation log is consistent with existing log channels;
- a confirmation, by direct read of the v3 handler, that v3 accepts the canonical request shape that v1 and v2 currently send, and a list of any field-level differences that the dispatch alias would need to translate (the expectation is that there are none, since v1 and v2 already use the same snapshot contract; the verification is required rather than assumed);
- a confirmation, by inspection of the two locally modified parity fixtures `doc31_parity_old_response.json` and `doc31_parity_new_response.json`, of whether their current content pins v1/v2-specific output shape that would need to be regenerated against v3 once v1/v2 are aliased.

Stop condition: a Stage 0 baseline note records every item above with file paths and line numbers, distinguishes live references from historical mentions, and states whether any precondition assumption has failed.

## Stage 1 — Backend dispatch alias

Stage 1 establishes the soft-migration on the BE. The dispatch surface in `api_handlers.py` is changed so that `cohort_maturity_v1` and `cohort_maturity_v2` are normalised to `cohort_maturity` and routed to the v3 handler. A single deprecation log line is emitted on each request that arrives with a legacy identifier, recording the legacy identifier, the resolved canonical identifier, and the request scope, so that production usage of the legacy identifiers can be observed and quantified.

The v2 handler function and the v1-specific conditional logic are not deleted in Stage 1. They become unreachable from the dispatch table but remain in the file as dead code, to be removed in Stage 3. This separation is deliberate: Stage 1 is a pure dispatch change with no semantic risk, and Stage 3 is a pure deletion.

The dispatch alias must accept any request shape that v1 or v2 currently accept and forward it to v3 unchanged, except for the `analysis_type` field itself, which is rewritten to the canonical identifier before the v3 handler is invoked. The Stage 0 baseline must have confirmed that no field-level translation is required; if it found one, the dispatch alias performs that translation in a single named helper, not inline.

Stop condition: a request carrying `analysis_type: cohort_maturity_v1` or `analysis_type: cohort_maturity_v2` produces a response whose body, status code, and analysis identity match the response that the same request with `analysis_type: cohort_maturity` would produce. A new BE test exercises this against a representative request for each legacy identifier. The deprecation log is verified to fire exactly once per request and to carry the legacy identifier as a structured field.

## Stage 2 — Frontend normalisation and registry retirement

Stage 2 establishes the soft-migration on the FE and retires the user-visible v1/v2 surfaces.

A normalisation helper is introduced at the loader boundary identified in Stage 0. The helper takes an analysis-type identifier and returns the canonical identifier — `cohort_maturity_v1` and `cohort_maturity_v2` map to `cohort_maturity`; every other identifier passes through unchanged. The helper is invoked at every loader boundary at which a saved analysis's `analysis_type` is first consulted, and the rewritten identifier is what is stored back into memory and persisted on next save. This is the lazy migration: any saved analysis that still encodes a legacy identifier is rewritten the next time it is loaded and saved.

After the normalisation helper is in place and exercised, the v1 and v2 entries are deleted from the analysis-type registry, the chart-kind container's explicit v1/v2 mappings, and the analysis-type resolution service. Users no longer see v1 or v2 in any UI list of analysis choices. Any saved analysis that still loads with a legacy identifier is normalised by the loader-boundary helper before the resolution service is consulted, so the deletion of the resolution-service entries does not break loading.

The registry deletions and the helper introduction must land in a single commit, so that no interim state exists in which the registry has been emptied but the normalisation helper is not yet reachable.

Stop condition: a saved analysis that encodes `cohort_maturity_v1` or `cohort_maturity_v2` continues to load and render in the FE, displays as a `cohort_maturity` analysis in every UI surface, and is persisted with the canonical identifier on next save. The FE registry, chart-kind container, and resolution service no longer contain any v1- or v2-specific entry. A new FE test exercises the loader-boundary normalisation against a fixture that encodes each legacy identifier.

## Stage 3 — Delete the v2 handler, v1 conditional logic, and orphan modules

Stage 3 deletes the BE code that is now unreachable.

The v2 handler function in `api_handlers.py` is deleted in full. The v1-specific conditional logic — the inline `analysis_type in ('cohort_maturity', 'cohort_maturity_v1')` check and any branch it gates — is simplified to assume the canonical identifier, since the dispatch alias from Stage 1 guarantees no v1 string can reach this code. Any branch that was reachable only through the v1 path is deleted; any branch shared with v3 is preserved unchanged.

After the deletion, every import that the v2 handler held is examined. Any module that was imported only by the v2 handler is a candidate orphan. Each candidate is verified: a repo-wide search confirms it has no remaining caller. If verified, the orphan module is deleted in the same Stage 3 commit. The only candidate orphan identified by Stage 0 is `cohort_forecast_v2.py`; if Stage 0 found additional candidates, each is verified and deleted on the same basis.

Stage 3 must not delete any module shared with the v3 handler or with any unrelated analysis. The Stage 0 import-graph record is the authoritative list of shared modules; deletion outside that list is forbidden in this stage.

Stop condition: the v2 handler function and the v1-specific conditional logic are removed from `api_handlers.py`. Every orphan module identified and verified in this stage is removed from the codebase. The full BE test suite passes. A repo-wide search for `_handle_cohort_maturity_v2`, `cohort_forecast_v2`, and any other deleted symbol returns zero hits.

## Stage 4 — Test cleanup and alias-dispatch coverage

Stage 4 updates the test suite.

The dedicated v1/v2 tests are deleted: the parity test class in `test_doc31_parity.py`, the v2 contract test in `analysisRequestContract.test.ts`, and any other test identified by Stage 0 as dedicated to v1 or v2. The two alias-dispatch tests introduced in Stage 1 (BE) and Stage 2 (FE) are kept and form the regression guard for the soft-migration.

The incidental mentions identified by Stage 0 — tests that mention v1 or v2 alongside v3 — are audited individually. Each is classified as one of: still meaningful as a v3 test once v1/v2 are aliased (rewrite to use the canonical identifier and remove the v1/v2 reference); trivially passing once v1/v2 are aliased (delete, since the test no longer exercises a real distinction); or part of an unrelated test that happened to use a legacy identifier as a string (rewrite to use the canonical identifier). The two locally modified parity fixtures `doc31_parity_old_response.json` and `doc31_parity_new_response.json` are regenerated against v3 if Stage 0 found that they pin v1/v2-specific shape; otherwise they are updated only to use the canonical identifier in any embedded `analysis_type` field.

Any test that synthesises a request payload by hand and embeds `cohort_maturity_v2` or `cohort_maturity_v1` as a literal string is rewritten to use `cohort_maturity`, except for the alias-dispatch tests, which exist precisely to exercise the legacy strings.

Stop condition: the BE and FE test suites pass. No test mentions `cohort_maturity_v1` or `cohort_maturity_v2` except the alias-dispatch tests. A coverage check confirms the v3 handler is exercised by every test that previously exercised v2.

## Stage 5 — Documentation, config, and CLI shortcut rewrite

Stage 5 updates developer-facing surfaces.

The live documentation files identified by Stage 0 — currently expected to be the public CLI reference, the graph-ops CLI playbook, and the graph-ops tooling reference — are rewritten so that every example uses the canonical `cohort_maturity` identifier. A short note is added to each rewritten example block recording that `cohort_maturity_v1` and `cohort_maturity_v2` are accepted as deprecated aliases and route to `cohort_maturity`. The architecture diagram in `FORECAST_STACK_DATA_FLOW.md` is updated to collapse the v1/v2/v3 flow into a single canonical path with a footnote noting the alias.

Retrospective and design documents that mention v1 or v2 in a historical context are not modified. The Stage 0 baseline record is the authoritative classification of which files are which.

The `.claude/settings.json` and `.claude/settings.local.json` CLI shortcuts that embed `--type cohort_maturity_v2` are rewritten to use `--type cohort_maturity`. This is cosmetic — they would continue to function via the BE alias — but is done so that future readers of the settings file do not infer that v2 is a separate live analysis.

The help text in `graph-ops/scripts/analyse.sh` is reviewed; if it lists v1 or v2 as separate examples, those examples are removed or replaced with the canonical identifier.

Stop condition: every live documentation file presents `cohort_maturity` as the canonical identifier with v1/v2 noted as accepted deprecated aliases. The `.claude/settings*.json` files no longer reference v1 or v2 in any shortcut. The graph-ops scripts no longer present v1 or v2 as choices in their help text.

## Stage 6 — Acceptance and final orphan sweep

Stage 6 is an acceptance pass.

A repo-wide search is run for every variant of the legacy identifiers: `cohort_maturity_v1`, `cohort_maturity_v2`, `cohortMaturityV1`, `cohortMaturityV2`, `CohortMaturityV1`, `CohortMaturityV2`, `cohort-maturity-v1`, `cohort-maturity-v2`. The expected hits after the retirement are: the alias-dispatch tests; the deprecation log line in the BE; the loader-boundary normalisation helper in the FE; the deprecation aliases noted in rewritten documentation; the retrospective design and plan documents that Stage 0 classified as historical and that Stage 5 left alone. Any other hit is a regression and is investigated and resolved.

A final import-graph check is run from the v3 handler side, confirming that `cohort_forecast.py`, `cohort_maturity_derivation.py`, `span_kernel.py`, `span_adapter.py`, and `span_evidence.py` remain live and that no module other than the verified orphans was deleted in Stage 3.

The full BE and FE test suites are run end to end. The two alias-dispatch tests are confirmed to pass. The two locally modified parity fixtures are confirmed to be in their final state.

A short retirement note is appended to whichever ongoing changelog or release-notes channel the project uses, recording that v1 and v2 have been retired in favour of v3 with deprecated-alias compatibility, and citing this plan and its baseline.

Stop condition: every search-and-test check above passes; the retirement is complete; the soft-migration is in steady state.

## Risk callouts

The dispatch alias must be in place before any v1/v2 surface is removed. Stage 1 lands first for that reason. If Stage 1 is reverted for any reason, Stages 2 onwards must be reverted simultaneously, since the FE registry deletion and the BE handler deletion both depend on the alias being live.

The two locally modified parity fixtures `doc31_parity_old_response.json` and `doc31_parity_new_response.json` are already mid-flight in the user's working tree. Stage 0 must determine whether their current modification is part of a separate workstream that would conflict with this retirement, and the retirement must not silently overwrite that work. If they are part of an unrelated workstream, this plan halts pending coordination.

The 50-or-so test files that mention v1 or v2 incidentally are the largest source of unscoped effort in the plan. Stage 0 must classify every one of them precisely so that Stage 4 has a bounded audit list rather than an open-ended sweep.

The `cohort_forecast_v2.py` orphan-deletion must be performed after a definitive zero-caller verification. A grep against every variant of `cohort_forecast_v2` and against every symbol exported from that module is required, including symbol names that may be re-exported under a different alias. If any caller is found, the deletion is deferred and the caller is investigated.

The deprecation log in Stage 1 is the only mechanism by which production usage of v1 or v2 will be observed after the retirement begins. If Stage 0 finds that the BE has no usable structured-log channel for analysis-type dispatch, the log is added in Stage 1 alongside the dispatch alias rather than retrofitted later.

## Estimated effort

Roughly one focused day for Stages 0 through 4, plus a half-day for Stage 5, plus a half-day for Stage 6 acceptance. The soft-migration shape — alias at BE dispatch and normalisation at FE loader — is the load-bearing piece; the remainder is mechanical deletion and rewrite.

## Progress

- Stage 0 — Baseline and verification: not started
- Stage 1 — Backend dispatch alias: not started
- Stage 2 — Frontend normalisation and registry retirement: not started
- Stage 3 — Delete v2 handler, v1 conditional logic, and orphan modules: not started
- Stage 4 — Test cleanup and alias-dispatch coverage: not started
- Stage 5 — Documentation, config, and CLI shortcut rewrite: not started
- Stage 6 — Acceptance and final orphan sweep: not started
