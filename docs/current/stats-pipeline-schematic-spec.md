# Stats pipeline schematic — problem statement and spec

**Date**: 1-May-26
**Status**: Implemented 1-May-26
**Audience**: Engineers and agents reasoning about where statistical fields come from; reviewers of any change that touches a writer or reader of `edge.p.*`, `model_vars[*]`, or `posterior.*`.

**Implementation**: [stats-pipeline-schematic.md](codebase/stats-pipeline-schematic.md)

## Problem

The codebase has two clearly named pipelines — **model-vars generation** (Bayes compiler offline + FE topo Step 1) and **projection / forecasting** (FE topo Step 2 + BE CF + analysis runners) — and several docs that describe each side well in isolation. There is no single page that shows both on one canvas.

Today the picture is reconstructed every time it's needed by reading at least four docs in sequence:

- [TOPOLOGY.md](codebase/TOPOLOGY.md) for where the stats compute layer sits in the wider app.
- [STATS_SUBSYSTEMS.md](codebase/STATS_SUBSYSTEMS.md) for the four-subsystem map and the field-write table.
- [FORECAST_STACK_DATA_FLOW.md](codebase/FORECAST_STACK_DATA_FLOW.md) §B.1 for the Bayesian-vs-analytic pipeline diagram and the `I1`–`I17` interface labels.
- [FE_BE_STATS_PARALLELISM.md](codebase/FE_BE_STATS_PARALLELISM.md) for the Step 1 / Step 2 model-vars-vs-current-answer split.

Each is correct for its own slice. None answers the question that debuggers, onboarding engineers, and refactor reviewers actually have: *for any field on `edge.p.*` or `model_vars[*]`, which subsystem produced it, on which clock, persisted to which surface, and consumed by which downstream reader?*

The information exists; the **picture** does not.

## Why it matters

**Debugging.** When the FE topo blend and the CF result disagree, the engineer needs to know which writer touched which field on which surface. The field-write table lives in STATS_SUBSYSTEMS §2; the writer-relationship picture lives in FORECAST_STACK_DATA_FLOW §B.1; the aggregate-vs-scoped layer split lives in FE_BE_STATS_PARALLELISM. Three docs, one bug.

**Onboarding.** New engineers and new agent sessions both re-derive the picture. Even with the warm-start docs read, the schematic still has to be assembled mentally before any architectural conversation can begin.

**Refactor reviews.** The 73n implementation plan moves the conditioning locus out of the trajectory solver and into a request-scoped primitive registry. The plan is 858 lines partly because no shared diagram exists for "where conditioning happens today" vs "where it should happen". A shared canvas would replace prose preamble in 73h, 73m, and 73n.

**Doc maintenance.** Every architectural change to a stats writer or reader currently touches three to five docs. A schematic those docs cite (rather than re-derive) reduces the surface that has to move in lockstep.

## Scope

The spec is for **one new doc**, working title `stats-pipeline-schematic.md`, lodged in `docs/current/codebase/` once written. It is reference material, not an open investigation.

### What the doc must contain

1. **One canvas showing both flows.** A single ASCII (or, where readability requires, mermaid) diagram with model-vars generation on one side and projection / forecasting on the other, sharing the persistence and consumption boundaries. The Bayes compiler, FE topo Step 1, FE topo Step 2, BE CF, and analysis runners all appear on the same picture.

2. **Layer bands.** The canvas is divided into four bands so the aggregate-vs-scoped distinction is visually unambiguous:
   - source-ledger / aggregate (`model_vars[bayesian]`, `model_vars[analytic]`)
   - current-evidence / scoped (`p.evidence.*`)
   - current-answer / scoped (`p.mean`, `p.sd`, `latency.completeness`, `latency.completeness_stdev`)
   - promoted / model field (`p.posterior.*`, `p.forecast.*`, `p.latency.{mu,sigma,t95,...}`)

   Every box sits in exactly one band. Cross-band movement appears only as an explicit arrow (e.g. `applyPromotion`).

3. **Field annotations.** Each writer box names the fields it writes; each reader box names the fields it consumes. Use the existing field names verbatim — no synonyms, no informal renames.

4. **Interface boundaries.** Reuse the `I1`–`I17` labels from FORECAST_STACK_DATA_FLOW so cross-referencing is one step. Where the canvas introduces a new boundary not currently labelled, propose the next free `I` label and add it to FORECAST_STACK in the same change.

5. **Trigger column.** For each writer, mark its trigger: offline / per-fetch / per-query / per-promotion. The parent docs scatter this across paragraphs.

6. **Persistence column.** For each output, mark whether it survives a fetch (graph), a session (IDB), or a commit (parameter file / git). This is the answer to "why is this value still here after a refresh".

7. **Conditioning-locus marker.** A visible annotation showing where evidence conditioning happens today (inside `compute_forecast_trajectory`) and where 73n moves it (a request-scoped primitive registry consumed by `window` / `subject_span` / `carrier_to_x`). Two states, same diagram, before/after.

8. **Reader-side dispatch tail.** A short branch showing how analysis runners pick up the enriched graph: graph-consumer runners read `edge.p.*` directly; direct CF consumers call `handle_conditioned_forecast`; in-band forecast consumers invoke `compute_forecast_trajectory` / `compute_forecast_summary`.

9. **Cross-reference block.** Explicit pointers to the four parent docs so the schematic does not duplicate their content; readers go to the parent for any detail the canvas elides.

### What the doc must not contain

- Per-field algorithmic detail. That lives in [STATISTICAL_DOMAIN_SUMMARY.md](codebase/STATISTICAL_DOMAIN_SUMMARY.md), [LAG_ANALYSIS_SUBSYSTEM.md](codebase/LAG_ANALYSIS_SUBSYSTEM.md), [COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md](codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md).
- Per-subsystem narrative. That lives in STATS_SUBSYSTEMS §3.1–§3.4.
- Race mechanics or the 500 ms CF deadline detail. That lives in FE_BE_STATS_PARALLELISM.
- Prose duplicating any of the above. The schematic exists because the prose answers exist; it must not become a fifth prose answer.
- Implementation steps for 73n or any other refactor. The before/after marker shows *where* the locus moves; *how* it moves remains in 73n.

## Acceptance criteria

The doc closes when:

1. A reader can answer "where does field X come from, on which clock, persisted to where, consumed by whom?" from the canvas alone, for every field listed in STATS_SUBSYSTEMS §2.
2. The aggregate-vs-scoped distinction is visually unambiguous: no field appears in two layer bands without an explicit promotion arrow between them.
3. The conditioning-locus marker shows both today's location and 73n's target location. When 73n lands, the marker is **moved**, not deleted, so the doc continues to record the prior locus until the next release cycle.
4. STATS_SUBSYSTEMS, FORECAST_STACK_DATA_FLOW, FE_BE_STATS_PARALLELISM, and BE_RUNNER_CLUSTER each link to the new doc as their canonical schematic, and each removes any prose that the schematic now carries.
5. A new engineer or agent with warm-start docs read can navigate from the schematic to any of the four parent docs in one step, and never the reverse.

## Non-goals

- Replacing any of the four parent docs. They remain authoritative for narrative, field-level mechanics, and race details.
- Documenting non-stats subsystems (DSL, sync, mutation, persistence). TOPOLOGY remains the cross-cutting overview.
- Documenting analysis runners individually. The schematic shows the dispatch surface; [ANALYSIS_TYPES_CATALOGUE.md](codebase/ANALYSIS_TYPES_CATALOGUE.md) owns the inventory.
- Snapshot DB internal structure. [SNAPSHOT_DB_ARCHITECTURE.md](codebase/SNAPSHOT_DB_ARCHITECTURE.md) owns that; the schematic shows it as a single persistence box.

## Open questions

- **Format.** ASCII matches the rest of `docs/current/codebase/`, but the canvas this spec describes is dense. If an ASCII rendering exceeds roughly 80 columns or becomes unreadable, fall back to mermaid and accept the rendering-parity cost. The doc author chooses.
- **Conditioning-locus marker after 73n.** Once primitive conditioning is the live path, the "today" state becomes historical. Decide at 73n acceptance whether to (a) delete the historical state, (b) move it to an archive note, or (c) keep both for at least one release cycle for cross-reference value.
- **Manual overrides as a third writer column.** `model_vars[manual]` bypasses both generation pipelines. The schematic must show *that* they bypass and *which* fields they pin, but not the manual-edit UI itself.
- **`model_vars[analytic]` post-73b Stage 2.** The D20 synthesis path that derived `α, β` from scoped `p.evidence.{n, k}` for analytic sources has been removed. The schematic must show analytic α, β as flowing only from `model_vars[analytic].probability.*` per the §3.9 mirror contract, not from any scoped synthesis.

## Provenance and follow-up

This spec was opened against an observation from a session reviewing the [73n carrier-evidence-conditioning implementation plan](project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md): the absence of a single-canvas schematic forces every architectural conversation about stats writers and readers to reconstruct the picture from at least three docs, and forces refactor plans to carry that reconstruction in prose.

No owner is named yet. The natural owner is the author of the next change that touches more than one of {STATS_SUBSYSTEMS, FORECAST_STACK_DATA_FLOW, FE_BE_STATS_PARALLELISM, BE_RUNNER_CLUSTER}, since that author is the one who would otherwise have to update each parent doc independently.
