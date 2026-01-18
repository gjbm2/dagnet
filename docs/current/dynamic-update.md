# Dynamic update (dependency signatures for scenarios, analysis, and charts)

**Status**: Proposal  
**Last updated**: 16-Jan-26

## Problem statement

DagNet currently has an ergonomic and correctness problem:

- **Scenarios** can drift from the latest underlying graph/parameter data depending on sequencing and when regeneration occurs.
- **Charts** are often stored as **disconnected static artefacts** (`chart.payload.analysis_result`) and do not update unless an explicit recompute path runs.

This is already problematic for scenario workflows, and becomes materially worse for charts (especially in “auto-update” contexts like live share and dashboard embeds).

We need a design where **derived artefacts are self-invalidating**: if the underlying data or intent changes, the derived artefact becomes stale and is recomputed (automatically when appropriate, manually otherwise).

This document proposes a **dependency signature** approach (Option B): scenarios, analyses, and charts record the signature of the inputs they were computed from, and refresh when that signature no longer matches the current world.

## Goals (what must hold)

- **G1 — Correctness under change**: if underlying data changes, derived artefacts (scenarios → analysis → charts) must converge to the latest correct results.
- **G2 — Minimal reliance on explicit triggers**: avoid an ever-growing list of “if X happens, force refresh” call sites.
- **G3 — Mode-aware behaviour**:
  - In *auto-update contexts* (live share, dashboard mode, or explicit `auto-update=true`), refresh should be automatic and non-blocking.
  - Outside auto-update contexts, refresh should be user-controllable (opt-in toggle + manual refresh) while still exposing staleness clearly.
- **G4 — Deterministic within a fixed input snapshot**: given identical repo inputs and identical resolved DSL intent, results must be repeatable (no sequencing-driven drift).
- **G5 — Performance safety**: auto-updating must be bounded, debounced, and batchable; it must be possible to disable if it proves too expensive.
- **G6 — Session logging**: refresh and recompute activity must be observable via `sessionLogService` with enough detail to diagnose “why did this recompute?” and “why did it not?”

## Non-goals (for this proposal)

- Building a general-purpose reactive build system. We only need enough structure to keep scenarios/analysis/charts coherent.
- Introducing new repo persistence formats for charts (charts remain local derived artefacts).
- Solving all determinism issues (e.g. Stage‑2 horizon drift) here; the design must be compatible with the determinism work, not replace it.

## Key concepts

### Auto-update context (policy)

Define a single policy decision: **should this runtime automatically reconcile derived artefacts when inputs change?**

**Auto-update is enabled when any of the following are true**:

- **Live share mode** (share boot resolver indicates `mode=live`)
- **Dashboard mode** (e.g. `dashboard=1`)
- **Explicit user/runtime setting** (e.g. `auto-update=true` or a UI toggle persisted per workspace)

Auto-update should be treated as a *policy*, not a set of special-case triggers. Code should ask the policy at the point of deciding whether to recompute or merely mark stale.

### Dependency signature (stamp)

A **dependency signature** is a compact, stable representation of “the authoritative inputs and intent that produced this derived artefact”.

If the signature changes, the artefact is stale.

We will use a structured “stamp” internally (for logging and inspection), and derive a stable string/hash signature from it (for equality checks).

### Three-tier derived chain

We want an explicit chain of dependency, even if the runtime mechanics are event-driven:

1. **Graph / inputs change** ⇒ scenarios become stale
2. **Scenario graphs change** ⇒ analysis becomes stale
3. **Analysis recipe + scenario graphs change** ⇒ chart artefact becomes stale

The core insight is that charts should not be “special”; they are merely cached views over analysis results.

## What counts as “inputs changed” (staleness causes)

The following list is intentionally broader than “explicit triggers”; it is the design target for invalidation.

### A) Intent changes (DSL / recipe changes)

- **Base DSL changes** (explicit change by user, or via “put to base” semantics).
- **Scenario DSL changes** (including any inherited/effective DSL changes).
- **Current DSL changes** (window selector / query editor).
- **Analysis recipe changes**:
  - analysis type
  - query DSL
  - what‑if DSL (if used in analysis inputs)
  - visibility mode inputs (forecast/evidence/both) when they affect compute

### B) Dynamic DSL resolution changes (time-based)

If any of the DSLs are dynamic (relative/open-ended), then the *resolved* intent changes when the reference day changes.

Examples:

- `window(-60d:)` changes when “today” changes
- `cohort(-1w:)` changes when “today” changes
- Any *effective/composed* scenario DSL that omits an end date and therefore resolves against “today” (for example, a live scenario whose inherited DSL includes a `window(...:)` or `cohort(...:)` form)

#### Design tension: chart semantics (linked view vs pinned recipe)

There is an intentional dependency chain:

- chart ⇒ analysis ⇒ scenarios (tab context) ⇒ graph

However, **scenario order and visibility can affect the effective (composed) DSL** for a scenario (via inheritance rules). That creates a key question:

- Should a chart recompute when the user changes scenario order/visibility in the parent graph tab (because the scenario’s effective DSL may change)?

This proposal supports two coherent chart semantics:

- **Linked view (workspace authoring default)**:
  - A chart is a *view over* a parent graph tab’s scenario state.
  - The chart’s dependency stamp must include the parent tab’s scenario view state (order + visibility modes), or equivalently include the effective scenario stamps for the scenarios used.
  - Consequence: changing scenario order/visibility can legitimately invalidate the chart and trigger recompute (in auto-update contexts) or mark stale (manual mode).

- **Pinned recipe (share/dashboard default)**:
  - A chart is a *recipe* that carries an explicit ordered scenario definition (DSL fragments + display metadata + visibility modes), and does not consult an external graph tab’s evolving scenario stack.
  - Consequence: scenario order/visibility changes in some other UI session do not affect the chart unless the recipe itself changes.

**Why live share currently flattens/encodes scenario DSL definitions**:

- In chart-only live share boot there may be **no visible parent graph tab**, so there is no authoritative “tab scenario state” to depend on.
- Therefore, live share must treat the chart as a pinned recipe and rehydrate/regenerate scenarios from those definitions.

If we adopt dependency stamps generally, we should keep the distinction explicit (linked vs pinned) rather than rely on ad-hoc “special handling”. Long term, we may be able to reduce complexity by expressing *both* behaviours through one stamp model by recording:

- which semantics a chart is using (linked vs pinned), and
- the appropriate dependency fields for that semantic.

This implies a time-based staleness cause:

- **Reference day changed** (UK day boundary) ⇒ any artefact whose inputs include dynamic DSL is stale.

### C) Underlying data changes (files / caches)

We need to treat “data changed” as a first-class cause, not only “git pull happened”.

Examples include but are not limited to:

- **Repo advance** (git pull / remote-ahead refresh in live share).
- **Parameter file updates** (from-file append, restore, merge resolution, rollback).
- **Contexts/settings updates** (e.g. `settings/settings.yaml` affecting forecasting, or context definitions affecting MECE/slice selection).
- **Graph structure/topology changes** (authored edits, or graph file changes from remote).
- **Scenario inheritance state changes** that alter effective/composed DSL (for linked-view charts, this is captured by scenario stamps and/or parent tab scenario state)

## Proposed mechanism: self-invalidating artefacts

### Overview

Each tier stores:

- the last computed **dependency stamp** (and a derived signature string)
- minimal metadata about when/why it was computed (for user-facing display and session logs)

At runtime:

- When a consumer needs the artefact (render, tab activation, or a scheduled reconcile), it compares the stored signature to the current computed signature.
- If equal: use the cached artefact.
- If different:
  - If auto-update policy is enabled: **recompute and update in place**.
  - If auto-update is disabled: mark stale and surface a “Refresh” affordance (manual recompute).

### Tier 1: scenario derived state

**Scenario artefact** (per live scenario) conceptually depends on:

- parent graph identity/revision
- effective scenario DSL (including inheritance)
- resolved DSL window/cohort bounds (if dynamic)
- underlying data inputs consulted during regeneration (parameter/context/settings files and their revisions)
- compute policy knobs that affect outputs (e.g. allow fetch from source, stage‑2 enabled, determinism reference day)

**Proposal**:

- Store the stamp on the scenario record (`Scenario.meta`) for live scenarios:
  - “computed from” stamp for the most recent successful regeneration
  - whether the scenario’s DSL is dynamic (so the day-boundary policy is cheap)
  - a compact “inputs observed” list (file IDs + revisions) captured during regeneration (see below)

**Capturing data dependencies without precomputing the full closure**:

- During regeneration, the system already touches a concrete set of inputs (parameter files, contexts, settings).
- Record the set of file IDs consulted (and their revisions) as part of the stamp.
- This avoids trying to infer a dependency closure from graph topology upfront, and prevents both under- and over-invalidation.

This is the key “subtlety”: we do not guess dependencies; we observe them and persist them as provenance.

### Tier 2: analysis derived state

**Analysis derived state** is typically not persisted as a first-class file; it is computed for display (and sometimes cached in-memory).

Conceptually, an analysis result depends on:

- the **analysis recipe** (analysis type, query DSL, what‑if DSL, selection inputs, visibility modes)
- the **scenario graphs** (the fully composed graph per scenario layer), not merely scenario IDs
- the **reference day** policy used for DSL resolution (when relevant)

**Proposal**:

- Treat “analysis staleness” as a function of the same stamp inputs used for charts:
  - analysis recipe stamp
  - scenario graph signatures (or scenario stamps, if those can be deterministically mapped to scenario graphs)
- Continue to allow fast in-memory caching keyed by these signatures, but ensure the cache key is derived from canonical stamp fields (so “what changed?” is explainable in logs).

**Existing behaviour (already close to this)**:

- Multi-scenario analysis is already cached based on scenario graph signatures + query DSL + analysis type.
- The dynamic-update work should make the dependency key explicit, inspectable, and consistent with chart invalidation.

### Tier 3: chart artefacts (persisted derived state)

Charts are local derived artefacts. That is correct and desirable, but the artefact must record “what it was derived from”.

**Chart artefact** conceptually depends on:

- the analysis recipe (type + query DSL + other recipe inputs)
- the scenario set definition and ordering (including visibility modes when they affect compute)
- the scenario graphs (or their signatures)
- the parent graph identity (when applicable)
- the reference day / resolved DSL windows (when dynamic DSL is in play)
- the underlying data inputs that fed the scenario graphs (parameter/context/settings files and their revisions)

**Proposal**:

- Extend the chart artefact schema to store a **dependency stamp** and derived **deps signature**.
- On chart view (and on chart tab activation), compute the current deps signature and compare:
  - If equal: render cached results immediately.
  - If different:
    - In auto-update context: recompute the chart and update in place.
    - Otherwise: show a clear “stale” indicator and offer a manual Refresh action.

This turns “charts are disconnected” into “charts are cached views that can reconcile themselves”.

## Canonical “revision” sources (what the stamp is allowed to depend on)

To avoid expensive hashing or ambiguous “last modified” behaviour, the stamp should be built from **explicit revision sources**.

### File revision (for parameter/context/settings/graph files)

Define a stable notion of “file revision” suitable for dependency tracking:

- **Preferred**: repository SHA (when the file is sourced from git and has a SHA).
- **Otherwise**: a monotonic local revision token that increments on each in-app write (including merges/resolutions), plus an optional lightweight content hash if cross-session stability is required for local-only files.

The important property is:

- if the file’s effective content changes, its revision must change
- comparing revisions must be cheap (no repeated full content hashing in the hot path)

### Graph revision (graph store vs graph file)

Graph structure/topology change must be representable in the stamp.

Two distinct cases matter:

- **Graph file changed** (git pull / restore / overwrite-seed): captured by the graph file’s revision.
- **In-memory authored edits** (node/edge edits): captured by a graph-store revision that changes on meaningful topology edits.

This proposal intentionally does not force “every tiny edit triggers regeneration”; it only ensures the system can tell that “the graph changed relative to the artefact”.

### Reference day (dynamic DSL)

If a scenario/analysis/chart depends on a dynamic DSL, the stamp must include:

- the **resolved reference day** (UK day boundary), in `d-MMM-yy`

This is what makes “day changes” an explicit, inspectable dependency rather than implicit wall-clock coupling.

## Stamp composition (what we include, at a high level)

The stamp should be structured for logging, with a derived signature for equality checks.

### Scenario stamp (live scenarios)

Include:

- **graph identity**: graph file ID + graph revision (file revision or store revision depending on source)
- **DSL intent**:
  - base DSL used
  - scenario query DSL
  - effective/inherited DSL (the string that actually drove regeneration)
  - resolved window/cohort bounds (when dynamic)
- **inputs observed**: list of file IDs consulted during regeneration, each with a file revision token
- **compute policy**: the knobs that materially affect the scenario graph (stage‑2 enabled, fetch-from-source permitted/forbidden)
- **reference day**: only when dynamic DSL is present (avoid stamp churn for fixed DSL)

### Analysis stamp

Include:

- **analysis recipe**:
  - analysis type
  - query DSL
  - what‑if DSL (if applicable)
  - selection inputs (if analysis depends on selection)
  - per-scenario visibility modes (if they affect compute)
- **scenario graph signatures** (or scenario stamps mapped to graph signatures)
- **reference day** when relevant

### Chart stamp

Include:

- **chart kind** (funnel/bridge/etc.)
- **analysis stamp** (or a stable summary of it)
- **parent linkage** (parent graph file ID when known)

## Reconciling behaviour (how refresh happens without scattered triggers)

The design still needs a place where reconciliation happens, but it should be:

- centralised (single orchestrator)
- policy-aware (auto-update vs manual)
- driven by signature comparisons rather than “operation happened” triggers

### When to check

Recommended check points (cheap, local decisions):

- **On chart tab activation**: compute “is stale?” and either auto-recompute (auto-update) or surface stale UI (manual mode).
- **On scenario regeneration completion**: update scenario stamps; this naturally changes analysis/chart signatures downstream.
- **On file revision changes**: schedule a debounced “reconcile pass” for affected open graphs/charts.
- **On UK day boundary tick** (only if any open artefact depends on dynamic DSL): schedule reconcile for those artefacts.

This is not an explicit trigger list of “operations”; it is a small set of structural “revision sources changed” events plus on-demand checks.

### What to recompute (bounded scope)

To keep cost controlled:

- Only recompute **visible live scenarios** for the relevant graph tab (do not guess a scenario set if it cannot be resolved).
- Only recompute **open chart tabs** that are linked to the relevant parent graph (or are in a known share/dashboard context).
- Debounce/coalesce multiple revision changes into a single reconcile batch per graph.
- Deduplicate recompute requests by (graph, signature) so repeated events cannot cause repeated heavy compute.

### Order of operations (sequencing contract)

To avoid sequencing drift (notably between normal mode and live share), reconciliation must follow a consistent order:

- **Hydrate Current inputs deterministically** (from-file cache as the default in auto-update contexts; avoid uncontrolled network fetch unless explicitly permitted).
- **Regenerate live scenarios** (respect inheritance ordering and visibility ordering).
- **Compute analysis** (keyed by scenario graph signatures + recipe).
- **Update chart artefacts** (in place) and signal UI to re-render.

The ordering should be logged as a single parent operation with child steps so differences are observable.

## UX and controls

### Required affordances

- **Per-chart Refresh**: always present, regardless of auto-update policy (manual override).
- **Staleness indicator**: show when the chart’s deps signature does not match current.
- **Auto-update toggle** (workspace mode): allow disabling if too expensive.

### Behaviour by context

- **Live share mode**:
  - auto-update enabled by default
  - failures should keep the previous cached artefact visible (dashboard must not go blank), but show a non-blocking “update failed” indicator
- **Dashboard mode**:
  - auto-update enabled by default
  - avoid intrusive modals; prefer lightweight indicators/toasts
- **Normal authoring**:
  - default may be manual or auto (to be decided), but must be user-controllable
  - staleness must be visible so users are not unknowingly reading stale results

## Session logging requirements

Every reconcile/recompute should be logged as a single structured operation, including:

- **reason(s)**: file revision change, DSL change, day boundary, manual refresh, etc.
- **targets**: graph file ID, scenario IDs regenerated, chart file IDs updated
- **signatures**: previous vs current deps signature (or a shortened hash), plus a redacted/summary form of the stamp for inspection
- **policy**: auto-update enabled/disabled, fetch policy (from-file only vs source permitted), stage‑2 enabled/disabled
- **outcomes**: success/partial/failed with enough detail to diagnose without reading code

## Performance and safety guardrails

To prevent runaway recomputation:

- **Debounce** file-change-driven reconciles per graph (single batch after a burst).
- **Single-flight** per graph reconcile (if one is in progress, coalesce subsequent requests).
- **Scope limiting**:
  - only visible live scenarios
  - only open charts for that graph
- **Policy gating**:
  - outside auto-update contexts, do not auto-run heavy recompute; show stale UI instead
- **Fail-safe**:
  - on errors, keep the last known artefact and mark stale; never replace with empty unless explicitly requested

## Risks and open questions

- **R1 — Dependency observation completeness**: if regeneration does not correctly record all consulted inputs, stamps may under-invalidate. This must be tested and logged.
- **R2 — Stamp churn**: over-broad dependency recording could cause frequent invalidation and expensive recompute. We need to keep stamps compact and intentional.
- **R3 — Dynamic DSL day-boundary semantics**: deciding the exact UK day boundary and ensuring all subsystems share it is critical (align with determinism work).
- **R4 — Graph edit semantics**: whether authored topo edits should auto-regenerate scenarios by default is a product decision; the stamp mechanism supports either behaviour.
- **R5 — Share vs workspace parity**: the same stamp concepts must apply in share-scoped DBs; the reconcile orchestrator must not assume a visible graph tab exists.

## Proposed implementation plan (prose-only; no code)

- **Phase 1 — Define stamps and signatures**
  - Specify the exact stamp fields for scenarios, analysis, and charts.
  - Decide the canonical “file revision” token source (prefer SHA; otherwise local revision).
  - Define the UK reference-day representation for dynamic DSL dependencies.

- **Phase 2 — Persist stamps**
  - Store scenario stamps after successful regeneration (live scenarios only).
  - Store chart deps stamp/signature when creating or updating chart artefacts.

- **Phase 3 — Central reconcile orchestrator**
  - Add a single orchestrator entry point that can:
    - detect staleness by comparing signatures
    - regenerate scenarios (bounded to visible live)
    - recompute chart artefacts (bounded to open charts)
    - respect auto-update policy and fetch policy
  - Ensure this is centralised (service/context), not duplicated across UI/menu files.

- **Phase 4 — Wiring and UX**
  - Add Refresh button + stale indicator to chart UI.
  - Add auto-update toggle for workspace mode.
  - Add non-blocking failure indicators for dashboard/live share.

- **Phase 5 — Tests and parity verification**
  - Extend existing scenario tests to assert stamps update and that chart artefacts invalidate/recompute when dependent inputs change.
  - Extend repository pull/refresh tests to assert file revision changes drive reconcile (without relying on per-operation triggers).
  - Add at least one parity test covering “dynamic DSL day boundary” invalidation behaviour (freeze reference day).
