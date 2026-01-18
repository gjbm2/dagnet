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

**Critical requirement (supports linked↔pinned fallback): charts must persist both link + fallback**

To support the rule “linked when parent context is available, pinned when it is not”, a chart artefact must always persist:

- **A parent linkage pointer** (for linked view):
  - at minimum: parent graph file ID (and optionally parent tab ID if needed to resolve scenario view state)
- **A pinned fallback recipe** (for orphaned operation):
  - flattened/effective per-scenario DSL mapping sufficient to rehydrate the intended scenario definitions for compute
  - plus any recipe inputs that materially affect analysis (analysis type, query DSL, visibility modes, what‑if DSL where applicable)

This lets the runtime choose the best semantic at render/reconcile time without losing correctness when tabs are closed/reopened.

**Important clarification: scenario view state is per tab (not per graph)**

In the current app, scenario visibility/order/modes live under `TabState.editorState.scenarioState` and are therefore **tab-scoped**. Tabs are persisted in IndexedDB (`db.tabs`), but when a tab is closed it is deleted. Reopening a graph creates a new tab with default scenario state (typically just `current` visible).

Therefore:

- A chart cannot safely “re-link” to *any* graph tab for the same graph fileId after its original parent tab was closed.
- Linked-view semantics must resolve against a **specific parent tab identity** when available, and must fall back to pinned when that tab context is not resolvable.

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

#### Chart file schema decisions (see Locked decisions)

Chart schema shape and the “do not pipe recipe/DSL through analysis outputs” rationalisation are recorded under:

- `Locked decisions → Chart file schema decisions (recipe block + no DSL injection)`

## Canonical “revision” sources (what the stamp is allowed to depend on)

To avoid expensive hashing or ambiguous “last modified” behaviour, the stamp should be built from **explicit revision sources**.

### File revision (for parameter/context/settings/graph files)

Define a stable notion of “file revision” suitable for dependency tracking:

- **Preferred**: repository SHA (when the file is sourced from git and has a SHA).
- **Otherwise (decision)**: use `lastModified` as the local revision token (treated as “revision” when SHA is unavailable).

Notes:

- Earlier we considered a monotonic local counter and/or lightweight content hash. We are not adopting those for now to minimise surface area; `lastModified` is sufficient as long as all content-changing writes update it.

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

**Clarification (addresses “why do we need triggers?”):**

The dependency rules define **what makes a chart stale**. The app still needs **when/where to evaluate** those rules.

Design decision (minimal v1):

- Always evaluate staleness on **chart tab activation/render** (cheap signature comparison).
- Evaluate on **explicit Refresh**.
- In auto-update mode, also evaluate when the **parent tab’s scenarioState changes** (order/visibility/modes) *for linked charts*.
- Day-boundary invalidation is handled by a periodic check only when dynamic DSL is involved (Step 6).

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

### Auto-update control surfaces (explicit UI requirement)

Auto-update must be user-visible in workspace mode via **two access points**, both calling the same central service/hook (no business logic in menu/UI files):

- **Data menu**: `Data → Auto-update charts` (checkbox / toggle)
- **Tools panel**: a dedicated toggle (mirrors the Data menu state)

In share-live and dashboard contexts, auto-update remains enabled by default regardless of the workspace toggle (policy override).

### “Live vs pinned” visibility and user control (explicit UX requirement)

It must be visible to the user whether a chart is operating as:

- **Linked (live)**: chart depends on a specific parent graph tab context (scenario order/visibility/modes + authoritative Current DSL).
- **Pinned**: chart depends only on its persisted recipe + cached artefact (and can operate while orphaned).

**UI requirement:**

- Show a small status indicator on chart tabs/views (e.g. `Linked` / `Pinned`), with a tooltip explaining what it means.

**Disconnect requirement (user-controlled pinning):**

- Provide a `Disconnect` action for linked charts that converts the chart to pinned mode by:
  - clearing the parent-tab linkage used for linked resolution, and
  - treating the chart as pinned going forward.

**Important**: if Step 2.2a is implemented correctly, the chart’s pinned fallback recipe is **already persisted and up-to-date at chart creation/update time**, so disconnect is a cheap metadata change (not an additional “snapshotting” step).

This allows a user to intentionally “freeze” a chart even if the parent graph tab remains open and dynamic.

### Behaviour by context

- **Live share mode**:
  - auto-update enabled by default
  - failures should keep the previous cached artefact visible (dashboard must not go blank), but show a non-blocking “update failed” indicator
- **Dashboard mode**:
  - auto-update enabled by default
  - avoid intrusive modals; prefer lightweight indicators/toasts
- **Normal authoring**:
  - auto-update is enabled by default, but must be user-controllable (Data menu + Tools panel toggle)
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
- **R4 — Graph edit semantics**: authored topo edits trigger refresh; the risk is only performance/churn, which must be managed by debounce + single-flight + scope limits.
- **R5 — Share vs workspace parity**: the same stamp concepts must apply in share-scoped DBs; the reconcile orchestrator must not assume a visible graph tab exists.

## Locked decisions (for implementation; no migration/backfill)

This section holds **all design/decision material that the step-by-step plan depends on**. The step-by-step plan should reference this section instead of re-stating decisions inline.

### Chart semantics and share/bundle behaviour (linked vs pinned)

**Step 0.1 decision (share/bundle semantics):**

- **Charts shared without their parent graph present**: use **pinned recipe** semantics.
  - Meaning: the chart tab is self-sufficient; it rehydrates from its embedded scenario definitions/recipe and does not depend on a graph tab’s evolving scenario stack.
- **Charts shared with their parent graph present in the same bundle**: use **linked view** semantics (dynamic).
  - Meaning: the chart’s dependency stamp is allowed to depend on the parent graph tab’s scenario view state (order/visibility) and will reconcile based on that, rather than on a flattened recipe.
  - Required: the bundle format must include an explicit linkage so the chart can deterministically identify the parent graph tab/fileId.
  - Fail-safe: if the parent graph cannot be resolved at runtime (missing tab/file), fall back to pinned recipe semantics rather than failing.

### Tab-scoped scenario state (why charts must resolve a specific tabId)

**Important clarification: scenario view state is per tab (not per graph)**

In the current app, scenario visibility/order/modes live under `TabState.editorState.scenarioState` and are therefore **tab-scoped**. Tabs are persisted in IndexedDB (`db.tabs`), but when a tab is closed it is deleted. Reopening a graph creates a new tab with default scenario state (typically just `current` visible).

Therefore:

- A chart cannot safely “re-link” to *any* graph tab for the same graph fileId after its original parent tab was closed.
- Linked-view semantics must resolve against a **specific parent tab identity** when available, and must fall back to pinned when that tab context is not resolvable.

**Bundle/share resolution rule (linked charts):**

- When generating a multi-tab share/bundle that includes both graph tab(s) and chart tab(s), the bundle must preserve a stable mapping so that a chart can resolve its intended parent **tabId** on boot.
- Minimal requirement: the chart recipe must carry `recipe.parent.parent_tab_id` equal to the graph tab id created/restored by the bundle boot path.

**No re-link in scope (this workstream):**

- We do not implement an explicit “Re-link” action in this scope. The only requirement is the fail-safe rule: do not auto-bind across reopened tabs.

### Canonical revision decisions

**File revision token (0.2)**:

- `FileState` supports `sha` and `lastSynced` (see `src/types/index.ts`).
- Share/live seeding and refresh paths overwrite-seed files with SHA (`fileRegistry.upsertFileClean(..., opts.sha)`), so SHA is available in those contexts.
- Workspace clone also persists `sha` (treeItem SHA) for files.
- **Decision**: file revision token for stamps is:
  - `sha` when present
  - otherwise `lastModified` (treated as a local revision token)
- Therefore: revision used in stamps is `sha ?? String(lastModified ?? '')`.

**UK reference day source (0.3)**:

- Current code often derives “today” via `formatDateUK(new Date())` and sometimes normalises via `parseUKDate(formatDateUK(new Date()))`.
- **Decision**:
  - Canonical “reference day” is the existing UTC-normalised day string: `formatDateUK(new Date())`.
  - This must be routed through a single injectable provider for tests (Step 6.1), rather than calling `new Date()` ad-hoc inside stamp logic.

### Chart file schema decisions (recipe block + no DSL injection)

We should not “stuff everything through analysis and hope it comes back out”.

- **Analysis** should receive the narrow compute inputs it truly needs (scenario graphs + analysis recipe).
- **Chart artefacts** should persist any additional supporting information required for:
  - pinned/orphaned operation (recompute eligibility + pinned recipe), and
  - linked operation (parent tab resolution), and
  - UX (names/colours/modes/visibility intent).

**Decision (schema shape)**:

- Extend the chart file with a dedicated, explicit **`recipe`** block (distinct from `payload.analysis_result`):
  - `recipe.parent`: `parent_file_id`, `parent_tab_id`
  - `recipe.analysis`: `analysis_type`, `query_dsl`, optional `whatIfDSL` (only if applicable)
  - `recipe.scenarios`: ordered list of “participating scenarios”, each with:
    - `scenario_id` (including `current`/`base` when they participate)
    - `name`, `colour`
    - `visibility_mode` (`f+e`/`f`/`e`)
    - `effective_dsl` (flattened/composed DSL; required for pinned recompute)
    - `is_live` flag (so pinned recompute eligibility is checkable without guessing)
  - `recipe.display`: intent such as `hideCurrent` (when relevant)
  - `recipe.pinned_recompute_eligible`: boolean (true iff all participating scenarios are regenerable from the recipe)
  - `recipe.created_from`: lightweight provenance (optional; for logging only)

The existing `payload.analysis_result` remains the cached output.

**Decision (rationalisation):**

- Treat `payload.analysis_result` as **compute output only**:
  - no injected scenario DSL fields
  - no chart-recipe metadata
- Persist chart recipe and display metadata exclusively in `chart.recipe`, and have chart rendering read from that.

**Implementation consequences (in scope for this workstream):**

- Remove DSL injection from chart creation/update paths (remove the equivalent of `injectScenarioDslIntoAnalysisResult` behaviour).
- Update chart rendering services to read DSL subtitles from `chart.recipe.scenarios[*].effective_dsl`, not from `analysis_result`.
- Update tests that currently assert analysis-result DSL injection so they assert recipe fields instead.

### Chart staleness semantics (rules, not steps)

**Step 4.1 explicit requirement (supports graph-tab close / orphaning):**

- Linked-view derivation must use parent graph tab scenario state **when resolvable**.
- If the parent graph tab context is not resolvable, derivation must fall back to pinned-recipe derivation using the **pinned fallback recipe persisted on the chart artefact** (not by guessing).

**Step 4.1 explicit requirement (tab resolution; do not guess across re-opened tabs):**

- Linked-view derivation must resolve scenario state against a **specific tab**.
  - Prefer `source.parent_tab_id` when it refers to an existing tab in `db.tabs`.
  - If the referenced tab does not exist (tab was closed), treat the chart as **orphaned** and use pinned fallback.
- Do **not** automatically bind the chart to a newly reopened graph tab for the same fileId without an explicit user action, because the scenario state is tab-scoped and the newly opened tab will not have the same scenario configuration.

**Step 4 semantic rule (must hold): “graph tab closed after chart creation”**

- If a chart was created from a graph tab (linked-view eligible) and the user later closes the parent graph tab, the chart must **fail-safe to pinned behaviour** rather than breaking:
  - The chart remains viewable using its cached artefact.
  - The chart’s “current deps stamp” derivation must treat the parent context as unavailable and fall back to a pinned-recipe-style stamp derived from the chart’s stored recipe fields.
  - If/when the parent graph is reopened, the chart must **remain pinned** unless the original parent tab can be resolved (same tabId still exists).

### Scenario types: live vs snapshot (pinned eligibility)

Static scenarios (non-live overlays) are not DSL-backed and therefore cannot be deterministically regenerated from a compact recipe.

Policy:

- **Pinned recompute eligibility**:
  - A chart is eligible for pinned-mode recompute only if **every scenario that participates in the compute** is represented by a pinned, regenerable recipe.
  - **Base** and **Current** are treated as live/regenerable for these purposes, but they still need pinned recipe inputs when they participate (notably a pinned Current DSL, and a pinned Base DSL if Base participates).
  - Any snapshot/non-live overlay scenario is not regenerable from DSL and therefore makes pinned recompute ineligible.
  - If any involved scenario is static/non-live, pinned-mode recompute is **not permitted** (it would require persisting full overlay param packs, which is out of scope and likely too large).
- **Linked mode with static scenarios**:
  - When the parent graph tab is available, linked-mode recompute may include static scenarios because their params exist in IndexedDB and are part of the live tab context.
- **Orphaning with static scenarios**:
  - If a chart that depends on any static scenario becomes orphaned (parent tab closed/unresolvable), it must fall back to:
    - showing the last cached artefact, and
    - surfacing a clear stale/blocked reason (“Reopen the parent graph tab to refresh; this chart depends on a static scenario overlay”).

### “Current” layer — pinned fallback semantics (must be explicit)

“Current” behaves like a live scenario in that it is DSL-backed and can change as the user edits the window/query, but it is also a **special layer** with unique authority and UX semantics. We must make it explicit to avoid the prior live chart failures.

#### Authority rules

- **Linked view**:
  - The authoritative Current DSL is the graph tab’s current DSL (the same source used by WindowSelector / GraphStore), not any historic `graph.currentQueryDSL` field.
  - Therefore, linked-view charts depend on the parent tab’s Current DSL state as part of the parent tab context.

- **Pinned fallback**:
  - The chart artefact must persist a pinned Current DSL (flattened/effective) at chart creation/update time.
  - This pinned Current DSL is the single source of truth for recomputing “Current” in pinned mode.

#### Visibility and “hideCurrent”

- Charts may compute using Current even when Current is not visible in the authoring tab (e.g. comparisons where Current is an implicit scenario in the analysis metadata).
- Therefore:
  - Pinned fallback must always persist `scenario_dsl_subtitle_by_id.current` when Current participates in the chart compute (even if hidden).
  - The chart artefact should also persist whether Current was intended to be hidden for display purposes (so the pinned view can match the authoring UI).

#### What‑If and Current

- If the analysis/chart computation includes a what‑if DSL that applies to Current, then the chart recipe must persist it explicitly (pinned mode cannot infer it from a missing parent tab).
- If what‑if DSL is not part of the chart recipe, pinned recompute must not invent it.

#### Dynamic DSL and reference day

- If the pinned Current DSL is dynamic (open-ended/relative), it is subject to the UK reference-day invalidation rules (Step 6).

### Auto-update policy (precedence + storage)

**Storage decision (workspace toggle):**

- Persist the “Auto-update charts” preference into IndexedDB `appState` (local-only, not in repo), alongside other app-level state.

**Policy precedence (decision):**

- If **live share** (`mode=live`) OR **dashboard mode** (`dashboard=1`) is active: auto-update is **forced ON**.
- Otherwise (normal workspace): auto-update follows the user preference toggles:
  - Data → Auto-update charts
  - Tools panel toggle
- **Normal authoring default (decision)**: auto-update is **ON by default**.
- URL `auto-update=true` may force ON in workspace mode (debugging convenience).
- URL must not force OFF in live share/dashboard (embed correctness guard).

### Graph topology edits (decision)

- Authored graph topology/structure edits **trigger refresh** (scenario regeneration + downstream staleness checks) subject to debounce/single-flight and scope limits.

## Proposed implementation plan (prose-only; no code)

### TDD strategy (this workstream’s contract-first approach)

We will treat “dynamic update” as a semantic contract and lock it down with tests before (and throughout) implementation. The tests must encode:

- what constitutes a dependency (stamp contents)
- what constitutes staleness (signature mismatch rules)
- what the runtime does when stale (auto-recompute vs manual stale indicator)
- mode gating (live share / dashboard / explicit toggle)
- safety properties (batching, single-flight, fail-safe behaviour)

#### Test pyramid (where to prove what)

- **Pure/unit tests (fastest, most deterministic)**:
  - stamp construction rules and signature equality/inequality semantics
  - linked-view vs pinned-recipe chart semantics (explicitly)
  - “dynamic DSL depends on UK reference day” rules

- **Integration tests (Vitest; real services and IndexedDB where appropriate)**:
  - scenario regeneration updates provenance (stamp fields + observed inputs)
  - chart artefact staleness detection and in-place recompute behaviour
  - auto-update policy gating (recompute vs mark stale)
  - batching/single-flight coalescing (no thundering herd)

- **E2E tests (Playwright; minimal, high-signal)**:
  - one end-to-end auto-update-context flow that proves the chain: inputs change ⇒ scenarios reconcile ⇒ chart updates without manual action

#### Prefer extending existing test files (avoid new test files)

The intent is to extend the most relevant existing suites (no new test files unless there is manifestly no sensible home):

- **Scenario/live-scenario behaviour**:
  - `graph-editor/src/contexts/__tests__/ScenariosContext.liveScenarios.test.tsx`
  - `graph-editor/src/services/__tests__/liveScenarios.integration.test.ts`
  - `graph-editor/src/services/__tests__/scenarioRegenerationService.test.ts`

- **Chart artefact behaviour (create/update-in-place + deps tracking)**:
  - `graph-editor/src/services/__tests__/chartOperationsService.bridgeDslInjection.test.ts`

- **Live share / chart refresh orchestration semantics**:
  - `graph-editor/src/hooks/__tests__/useShareChartFromUrl.test.tsx`
  - `graph-editor/src/services/__tests__/shareLinkService.test.ts`

- **Repo advance / pull-driven file revision changes** (only if needed to prove revision wiring):
  - `graph-editor/src/services/__tests__/pullOperations.test.ts`
  - `graph-editor/src/services/__tests__/workspaceService.integration.test.ts` (use sparingly; prefer higher-level service tests when possible)

#### Contract scenarios (must be encoded as tests)

- **Stamps/signatures**:
  - Given identical inputs, stamp/signature is stable.
  - Changing one dependency (file revision, effective DSL, reference day, visibility mode, analysis recipe) changes the signature.

- **Linked view vs pinned recipe**:
  - Linked-view charts become stale when scenario inheritance inputs change (including order/visibility changes that affect effective DSL).
  - Pinned-recipe charts do not become stale from unrelated parent-tab state changes (only recipe/inputs change).

- **Auto-update policy**:
  - In live share and dashboard contexts, stale charts reconcile automatically (non-blocking).
  - In normal authoring (when auto-update disabled), stale charts do not auto-recompute but do expose staleness and allow manual refresh.

- **Fail-safe behaviour**:
  - Recompute failures retain the last known artefact and surface an error/stale indicator (no blanking).

- **Dynamic DSL day boundary**:
  - Artefacts whose dependencies include dynamic DSL become stale on UK day boundary change.
  - Artefacts based purely on fixed windows do not churn on day boundary.

- **Batching/single-flight**:
  - Multiple upstream changes coalesce into one reconcile batch per graph.
  - Reconcile requests deduplicate by (graph, target signature) to prevent repeated compute.

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

---

## Specific implementation plan (step-by-step; this section is the authoritative checklist)

This section is the single source of truth for execution. I will **update the status of each step in this section as I complete it**, and I will not “jump ahead” without updating statuses.

### Step 0 — Baseline and guardrails

**Depends on / see**: `Locked decisions → Chart semantics and share/bundle behaviour`, `Locked decisions → Canonical revision decisions`, `Locked decisions → Auto-update policy`

- **0.1 (done)**: Confirm which chart semantics are the default in workspace authoring:
  - linked view (depends on parent tab scenario state) vs pinned recipe (depends only on stored recipe)
- **0.2 (done)**: Identify the minimal “file revision” token we can depend on across:
  - workspace mode (git SHA when available; otherwise a local revision token)
  - share mode (share-scoped SHA / overwrite-seed semantics)
- **0.3 (done)**: Confirm the “UK reference day” source we will use for dynamic DSL invalidation (single provider; testable).
 
Notes:

- Step 0 decisions are recorded in **Locked decisions (for implementation; no migration/backfill)**.

### Step 1 — Introduce dependency stamps and signatures (pure, test-driven)

**Depends on / see**: `Locked decisions → Canonical revision decisions`, `Locked decisions → Chart semantics and share/bundle behaviour`, `Locked decisions → Scenario types: live vs snapshot`, `Locked decisions → “Current” layer`

- **1.1 (pending)**: Add a small pure module that defines:
  - chart deps stamp type(s)
  - canonicalisation rules (ordering, whitespace, redaction)
  - deps signature function (stable, cheap change detection)
- **1.2 (pending)**: Add unit tests that lock:
  - “same stamp inputs ⇒ same signature”
  - “one input changes ⇒ signature changes”
  - linked-view vs pinned-recipe semantics produce different dependency surfaces

### Step 2 — Persist chart deps signature on chart artefacts (TDD via existing chart tests)

**Depends on / see**: `Locked decisions → Chart file schema decisions (recipe block)`, `Locked decisions → Scenario types: live vs snapshot`, `Locked decisions → “Current” layer`

- **2.1 (pending)**: Extend `graph-editor/src/services/__tests__/chartOperationsService.bridgeDslInjection.test.ts` to assert:
  - `deps_signature` exists on persisted chart artefacts
  - `deps_signature` changes when recipe-relevant inputs change (e.g. scenario DSL subtitle mapping)
- **2.2 (pending)**: Update `graph-editor/src/services/chartOperationsService.ts` to write:
  - `deps` (stamp) and `deps_signature` alongside existing chart fields
- **2.2a (pending)**: Ensure the chart artefact always persists both:
  - **parent linkage**: `source.parent_file_id` (and `source.parent_tab_id` when available)
  - **pinned fallback recipe**: pin the scenario set and display/render inputs required to recompute *without* a graph tab:
    - pinned visible scenario set (ordered IDs)
    - pinned per-scenario visibility mode (`f+e`/`f`/`e`)
    - pinned per-scenario display metadata (name + colour)
    - flattened per-scenario effective DSL mapping (e.g. `scenario_dsl_subtitle_by_id`)
    - analysis recipe fields (analysis type, query DSL, what‑if DSL if applicable)
    - **Current handling**:
      - persist a pinned Current DSL (`scenario_dsl_subtitle_by_id.current`) when Current participates in the compute (even if `hideCurrent` is true)
      - persist display intent for Current visibility (so the pinned view can match authoring)
  - **eligibility metadata**: record whether pinned recompute is permitted (i.e. all scenarios are live/DSL-backed), so orphaned static-scenario charts can surface a clear “cannot refresh while orphaned” reason.
- **2.3 (pending)**: Enforce invariant: chart artefacts must always be created with the pinned fallback recipe + deps stamp/signature.
  - No migration/backfill logic: if required pinned fields are missing, the chart is not eligible for refresh and must be recreated (or recomputed from an active parent tab context using the normal pipeline).

- **2.4 (pending)**: Rationalise chart creation: remove “recipe/DSL injection into analysis outputs”.
  - Remove injection of scenario DSL into `payload.analysis_result` fields.
  - Ensure chart legend/tooltip DSL display reads from `chart.recipe` only.
  - Update existing tests that asserted injected analysis DSL to assert recipe fields instead.

### Step 3 — Central chart recompute primitive (no UI logic; best-effort)

**Depends on / see**: `Locked decisions → Chart semantics and share/bundle behaviour`, `Locked decisions → Tab-scoped scenario state`, `Locked decisions → Auto-update policy`

- **3.1 (pending)**: Extract a central service entry point that can:
  - find open chart tabs for a given parent graph
  - recompute analysis for each chart using existing recipes/metadata
  - update chart files in place (same fileId; no duplicate tabs)
- **3.2 (pending)**: Add/extend integration tests (prefer existing suites) to assert:
  - recompute updates the chart artefact in place
  - recompute is deduplicated per chart fileId

### Step 4 — Staleness checking (only recompute when stale)

**Depends on / see**: `Locked decisions → Chart staleness semantics`, `Locked decisions → Scenario types: live vs snapshot`, `Locked decisions → “Current” layer`, `Locked decisions → Tab-scoped scenario state`

- **4.1 (pending)**: Define “current deps stamp” derivation for:
  - linked-view charts (consult parent tab scenario state / effective scenario DSLs as needed)
  - pinned-recipe charts (consult only stored recipe + observed input revisions)
- **4.2 (pending)**: Implement `isChartStale(chartFile, currentStamp)` (pure, test-driven).
- **4.3 (pending)**: Update the recompute pipeline to:
  - skip recompute if not stale
  - assume `deps_signature` exists for all chart artefacts created after Step 2 (no migration/backfill paths)

Notes:

- Step 4 semantic requirements are recorded in **Locked decisions (for implementation; no migration/backfill)**.

### Step 5 — Auto-update policy gating + orchestration

**Depends on / see**: `Locked decisions → Auto-update policy`, `Locked decisions → Chart semantics and share/bundle behaviour`

- **5.1 (pending)**: Implement a single auto-update policy service:
  - enabled for live share mode, dashboard mode, or explicit `auto-update=true`
  - disabled by default for normal authoring unless explicitly enabled
- **5.1a (pending)**: Persist the workspace-mode preference (source of truth):
  - stored centrally (e.g. app state in IndexedDB) so it applies across tabs and survives reload
  - read/write exclusively via a service/hook used by both UI access points
- **5.2 (pending)**: Wire orchestration from the service/context layer (not UI):
  - when live scenarios regenerate successfully, schedule a debounced reconcile pass for affected charts
  - when authored graph topology edits occur, schedule a debounced reconcile pass for the active graph tab (per the locked “Graph topology edits” decision)
  - ensure single-flight per graph
- **5.3 (pending)**: Extend `graph-editor/src/contexts/__tests__/ScenariosContext.liveScenarios.test.tsx` to assert:
  - in auto-update contexts, regenerating a live scenario triggers chart reconcile for open chart tabs
  - in non-auto contexts, it does not auto-recompute (but staleness is detectable)

Notes:

- Step 5 policy precedence and storage decisions are recorded in **Locked decisions (for implementation; no migration/backfill)**.

### Step 6 — Dynamic DSL day-boundary invalidation (deterministic and testable)

**Depends on / see**: `Locked decisions → Canonical revision decisions`

- **6.1 (pending)**: Introduce an injectable “UK reference day provider” (used by DSL resolution and stamps).
- **6.2 (pending)**: Add tests that assert:
  - dynamic DSL charts become stale on day change
  - fixed-window charts do not churn
- **6.3 (pending)**: Add a lightweight day-boundary tick scheduler:
  - only active when at least one open artefact depends on dynamic DSL

### Step 7 — UX (staleness indicator + manual refresh; thin UI)

**Depends on / see**: `Locked decisions → Chart semantics and share/bundle behaviour`, `Locked decisions → Scenario types: live vs snapshot`, `Locked decisions → Auto-update policy`

- **7.1 (pending)**: Add a manual Refresh affordance for charts (always available).
- **7.2 (pending)**: Add a “stale” indicator on chart tabs/views when staleness is detected and auto-update is disabled.
- **7.3 (pending)**: Ensure live share/dashboard remains non-blocking and fail-safe (keep old artefact visible on recompute failure).
- **7.4 (pending)**: Expose auto-update toggle in:
  - Data menu (`Data → Auto-update charts`)
  - Tools panel (mirrors Data menu)
  - Both must call the same central hook/service; UI files remain access points only.
- **7.5 (pending)**: Surface chart semantic state (`Linked` vs `Pinned`) in the chart UI, and implement `Disconnect`:
  - Disconnect clears parent-tab linkage and flips the chart to pinned semantics (pinned recipe should already exist via Step 2.2a).

### Step 8 — Logging and diagnostics (required for parity investigations)

**Depends on / see**: `Locked decisions → Chart staleness semantics`, `Locked decisions → Auto-update policy`

- **8.1 (pending)**: Add session logging for:
  - reconcile start/end
  - reasons (file revision, DSL change, day boundary, manual refresh)
  - targets (graph, scenarios, chart fileIds)
  - prev vs next deps signatures

