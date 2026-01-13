# Share Graph Links (Static + Live Mode)

**Status**: Design + implementation plan  
**Last updated**: 13-Jan-26  

## Problem statement

We need a shareable link that renders correctly when embedded in Notion. The current “Copy Shareable URL” feature serialises the graph data into `?data=...`, but:

- It is currently “static”: it does not load the latest graph from GitHub.
- It initially had bugs where the Current layer was not visible and where safety/staleness nudges appeared in share flows.
- A “live” variant must not do a full workspace clone/pull on each view; Notion’s embed context is not durable across app restarts, so we cannot depend on long-lived IndexedDB caches.

We require a design that supports:

- **Static snapshot** links for cheap, deterministic embeds.
- **Live mode** links that fetch the latest graph and a minimal dependency set from GitHub at load time, using a `secret` URL param to unlock Git credentials.
- A path to upgrade a static snapshot view into live mode (“enter live mode”) when a secret is available.

## Constraints and observed behaviour

- **Notion embed storage**:
  - IndexedDB/localStorage persist across Notion tabs (within a running session).
  - IndexedDB/localStorage do **not** persist reliably across Notion app reloads.
  - Therefore, any “live” embed must be correct under cold cache and should minimise remote calls.

- **Repo architecture**:
  - Normal app boot is workspace-centric (Navigator/workspace clone/pull → many files in IndexedDB).
  - A Notion embed “live view” must avoid the workspace clone path and instead load a minimal set of files required for the view.

- **Security requirement**:
  - Live links must include `secret` so the client can unlock Git credentials via `credentialsManager` in the embed environment.

## Goals

- Provide two share link modes:
  - **(A) Static**: `?data=...` is the single source of truth; no GitHub access required.
  - **(C) Live + dependency cache**: fetch latest graph + referenced parameter files (and other required supporting files) from GitHub on load so subsequent user actions can reuse parameter cache (reducing Amplitude/Sheets cost).

- Add an option to enter **“Live mode”** from a static view, using the same underlying mechanism as (C), without requiring a fresh copy/paste of a different link.

- Keep UI entry points as access points only: URL building and live-load logic must live in centralised services/utility modules, not menu files.

## Phasing (implementation order — all features remain planned)

All features in this document are planned. This section defines an explicit implementation order based on dependencies — **not a descope**.

### Phase 1 — Core boot, isolation, and graph share (foundation)

This phase establishes the share infrastructure. Everything else depends on it.

- **Boot resolver**: share-mode decision point before IndexedDB initialisation.
- **Hard IndexedDB isolation**: share-scoped DB names to prevent workspace overwrites and cross-share collisions.
- **URL contracts**: `mode=static` and `mode=live` parsing; identity metadata in static links.
- **Credentials unlock**: `?secret=` validation and `gitService` configuration for live mode.
- **Static share boot**: decode `data=`, seed temp graph, enforce read-only, apply scenario URL params.
- **Live share boot**: minimal GitHub fetch (graph + dependency closure + index resolution), seed share-scoped cache, open tab.
- **Dependency closure**: production TypeScript collector (using script as reference).
- **Read-only enforcement**: centralised signal for static mode restrictions.
- **"Enter live mode"**: upgrade path from static to live.
- **Session logging**: share link generation, live boot steps, credential unlock.

### Phase 2 — Share bundle modal and per-tab actions (UX surfaces)

This phase adds more entry points and multi-tab support, using the Phase 1 infrastructure.

- **`File → Share link…` modal**: checklist of tabs, dashboard mode toggle, live/static toggle, include-scenarios toggle.
- **Per-tab share actions**: tab context menu and navigator context menu items for individual tabs.
- **Tab bundle payload**: URL encoding for multi-tab bundles with deduplication.

### Phase 3 — Chart share and scenario-level actions (view-specific)

This phase extends sharing to chart tabs and adds scenario-level granularity.

- **Chart share**: chart recipe and baked artefact payloads; URL size policy enforcement.
- **Scenario-level share**: scenario context menu items; share a single DSL scenario with graph context.

### Dependency summary

| Phase | Depends on |
|-------|------------|
| Phase 1 | — (foundational) |
| Phase 2 | Phase 1 boot + isolation + URL contracts |
| Phase 3 | Phase 1 + Phase 2 bundle payload structure |

---

## Phase 1 scope (detailed)

Phase 1 is the explicit implementation target for the first rollout. All items below are **required** before we can ship share links to production.

### Included in Phase 1

- **Graph-only share**:
  - Static share link generation (existing `?data=...`), plus v1 contract refinements (see below).
  - Live share link generation (`mode=live`) and live boot that fetches the graph + minimal dependency set.
  - "Enter live mode" from a static share.
- **Scenario URL params support**:
  - Accept and apply existing `?scenarios=...` and `?hidecurrent` behaviour for share links (graph target only).
- **Hard storage isolation**:
  - Share sessions must not read/write the user's normal workspace IndexedDB content (Nous or otherwise).
  - Share sessions must also not collide with each other across different repos/graphs.
- **Static read-only enforcement**:
  - Static share views must be view-first and must not allow data retrieval or repo-mutating actions unless the user enters live mode.
- **Session logging** for share and live boot.

### Deferred to Phase 2

- Share bundles / cross-tab share modal (`File → Share link…`).
- Per-tab share entry points across all UI surfaces (tab context menu, navigator context menus).

### Deferred to Phase 3

- Chart/analysis share payloads and baked artefacts (URL size policy still applies, but implementation is deferred).
- Scenario-level share UI from scenario context menus.

## Non-goals (not planned for any phase)

These items are explicitly **not** part of the share feature roadmap:

- Supporting full repo browsing inside the embed context (Navigator listing, full registry UX, etc.).
- Guaranteeing that all data operations work offline in Notion (Notion reload behaviour prevents durable caching).
- Perfect parity with full workspace mode behaviour (we explicitly create an "embed/live mode" path).

## Existing relevant mechanisms (today)

- **Static graph share**:
  - Graph is encoded into `?data=...`.
  - `TabContext` recognises `?data=` and opens a temporary graph tab.

- **Staleness nudge suppression**:
  - `?nonudge` suppresses nudges for the session and is removed from the URL after processing.

- **Credentials unlock**:
  - `?secret=<value>` can unlock credentials from environment (`SHARE_JSON`) when the secret matches `SHARE_SECRET`.
  - These env vars are dedicated to the share/embed context (i.e. distinct from init-credentials flows).

- **Dependency closure logic (offline script)**:
  - `graph-editor/scripts/export-graph-bundle.js` can compute the dependency closure of a graph and (optionally) write filtered root index files.
  - Treat this as a **reference implementation** for dependency detection. v1 must implement equivalent detection in production app code.

## Proposed user-facing UX

> **Phasing note**: This section describes the full UX vision. Implementation is phased:
> - **Phase 1**: §1 (static snapshot improved), §2 (live mode link), §3 (enter live mode from static)
> - **Phase 2**: §0 (share link philosophy), §4 (per-tab share), §5 (cross-tab share bundle modal)
> - **Phase 3**: §4.1 (scenario-level share), chart share payloads

### 0) Share link (new, preferred over "Export")

We should treat sharing as a first-class interaction, not a file export:

- Prefer `File → Share link…` (instead of burying under Export).
- Support both:
  - **Per-tab sharing** (share just one tab’s view).
  - **Cross-tab sharing** (a deliberate bundle of multiple tabs).

This removes “guessing” which tabs are included: the user explicitly selects the scope.

Note: the share-bundle UX is **Phase 2** (see Phasing section). Phase 1 focuses on graph-only share via the existing Export menu and the new live-mode link variant.

### 1) Share static snapshot (existing, improved)

- **Menu**: `File → Export → Copy Shareable URL` (existing)
- Behaviour: encodes the current graph JSON into `?data=...` and includes `nonudge=1`.

#### Static mode UI restrictions (read-only by default)

Static snapshot mode is intentionally “view-first”:

- The user **can see** the currently displayed query/DSL (useful for understanding what they are looking at).
- The user **cannot change** the query/DSL, window, or any controls that would imply fresh data retrieval or repository edits.
- The user **cannot trigger** data operations that would be meaningful only with repository context (e.g. actions that depend on parameter files being present in the workspace cache).

The intended interaction pattern is:

- Static mode is for inspection and discussion.
- If the user wants to interact meaningfully (change query/window, regenerate scenarios, fetch or re-fetch data), they must explicitly **enter live mode**.

### 2) Share live mode link (new)

- **Menu**: `File → Export → Copy Shareable URL (Live mode)`
- Behaviour: builds a URL that indicates “live mode” and includes `secret`, `repo`, `branch`, `graph`, and `nonudge=1`.

### 3) Enter live mode from a static share (new)

- When a user is viewing a static `?data=...` shared graph, provide an action “Enter live mode” (button or menu item).
- If `secret` is present (or can be supplied), the app transitions to live mode:
  - It fetches the latest graph and dependencies from GitHub.
  - It replaces the temporary “url-data” graph with a “url-live” graph (or updates the same tab’s backing file in FileRegistry/IDB).
  - It updates the URL to the live-mode form and removes the bulky `data` payload (live mode has an independent source of truth).

#### Static → live transition: identity and rename/move handling

Static shares (`?data=...`) are self-contained and, by default, do not encode repository identity. That creates a practical requirement for the transition:

- To enter live mode, we need enough information to locate the canonical graph file in GitHub:
  - repository name
  - branch
  - graph identifier (graph “name” or file path)

We should treat this as a deliberate design surface:

- When a live share link is generated from an authored graph in the workspace, the link includes `repo`, `branch`, and `graph` explicitly.
- When starting from a static link, we need one of:
  - the static share link also includes `repo/branch/graph` metadata at creation time (recommended if we want “one link that can be upgraded”), or
  - the user is prompted for `repo/branch/graph` at the moment they click “Enter live mode”.

Rename/move behaviour:

- If the graph file is renamed or moved in the repo, `graph` resolution may fail.
- In that case, the live-mode transition must degrade gracefully:
  - show a clear error explaining that the graph could not be found under the specified identifier, and
  - offer a recovery path (e.g. choose a different graph identifier) rather than silently falling back to the static snapshot.

### 4) Per-tab share (new)

Each tab should offer a share action that produces a link for **that tab only**.

- **Where**:
  - Tab context menu items: “Share link (static)" and "Share link (live)"
  - File Navigator: same on context menu for graphs

- **Behaviour**:
  - The share link captures the **target view** implied by that tab:
    - Graph tab → `target=graph`
    - Chart tab → `target=chart`
  - It captures the **tab-specific view state** needed to reconstruct what the user sees (scenarios, visibility modes, selected scenario, etc.).
  - Dashboard mode: on by default

### 4.1) Scenario-level share (new: share a single scenario)

We should also support sharing from the scenario UI itself:

- **Where**:
  - Scenario right-click context menu items: “Share link for this scenario (static)” and “Share link for this scenario (live)”.

- **Intent**:
  - Share **only that scenario definition** (not “all scenarios currently visible”), while still providing enough context for the receiver to see something meaningful.

- **Behaviour**:
  - The link should open a graph view with:
    - only the chosen scenario visible and selected, and
    - `include scenarios` implicitly on, but scoped to **just that scenario**.

- **Graph context requirement**:
  - A scenario share is not meaningful without a graph context to apply it to.
  - Therefore, scenario-level shares must include either:
    - a static graph snapshot (`data=`), or
    - a live graph reference (`mode=live` + repo/branch/graph + `secret`).

- **Scenario representation**:
  - Prefer DSL-backed live scenarios (share the DSL for that one scenario, plus its label/colour and any subtitle metadata required for charts/legends).
  - Non-live scenarios are not compact/regenerable today; treat “share single non-live scenario” as out of scope until we define a repo-backed scenario representation.

### 5) Cross-tab share (new: share bundle modal)

Provide a modal that allows explicit selection of which tabs are included in the share link.

- **Where**:
  - `File → Share link…`

- **UI**:
  - Checklist of all applicable [graph editors, chart] open tabs (title + type icon), with:
    - select all / clear all
    - a radio/selector for which included tab should be the **initial active view** on load

- **Standard options**:
  - **dashboard mode**: on/off
    - On: open in dashboard presentation with the selected tabs as the “dashboard set”.
    - Off: open as normal tabs, with an explicit active tab.
  - **live mode**: on/off
    - On: bundle is recipe-driven and fetches latest graph/dependencies (requires `secret` and repo identity where needed).
    - Off: bundle is static snapshots / baked artefacts.
  - **include scenarios**: on/off (**default: on**)
    - On: include all scenarios
    - Off: only Current layer

## URL contracts

### Static snapshot (A)

- Parameters:
  - `data`: compressed graph JSON payload
  - `nonudge=1`: suppress nudges for share flows 
  - `mode=static`: v1 explicit mode marker for newly-generated links
  - `repo`, `branch`, `graph`: v1 identity metadata (included when sharing from a workspace graph to enable deterministic upgrade-to-live)

### Live mode (C)

- Parameters:
  - `mode=live`: indicates “live mode” (mode applies to the view, not the graph)
  - `repo`: repository name (must match a git credential entry name) (**required in v1**)
  - `branch`: branch name (**required in v1**)
  - `graph`: graph identifier (same meaning as existing `?graph=` usage)
  - `secret`: required to unlock credentials for private repos in embed environments
  - `nonudge=1`: suppress nudges for share flows

- Optional parameters (conditional in v1; not always required):
  - `scenarios`: scenario DSL list (for live scenarios)
    - **Default behaviour**: include scenarios in share links unless explicitly disabled (see “include scenarios” option in the share modal).
  - `hidecurrent`: hide current layer
  - Additional view state (window/viewport) if we want parity with authoring sessions

## Boot behaviour changes (implementation plan)

### A) Static `?data=` path

- Ensure the URL-loaded tab is initialised with a well-formed graph `editorState`, including:
  - Current layer visible by default (`visibleScenarioIds` contains `current`).
- Ensure `nonudge` is set for share URLs and respected by boot.
  - v1 decision: in share mode, do **not** remove `data` from the address bar after processing, so static links remain reloadable under cold-cache conditions (Notion embed).

### C) Live mode path (`mode=live`)

Implement a new branch in the URL boot flow that:

1. Validates required parameters are present (`repo`, `branch`, `graph`, `secret`).
2. Loads credentials using the share/embed contract: `?secret` unlocks system credentials from `SHARE_JSON` gated by `SHARE_SECRET`.
3. Configures `gitService` with the selected repo credential.
4. Fetches the latest graph file content from GitHub using a single-file fetch primitive (not workspace clone).
5. Computes the dependency closure for that graph and fetches the required supporting files from GitHub.
6. Seeds the fetched files into IndexedDB and FileRegistry using normal `FileState` shapes so downstream services behave consistently.
7. Opens the graph tab from the seeded graph file with a well-formed `editorState` (Current visible, etc.).
8. URL clean-up policy (v1):
   - Remove `nonudge` after persisting session suppression (as today).
   - Keep `mode`, `repo`, `branch`, `graph` stable in the address bar so the link remains meaningful and debuggable.
   - Keep `secret` in the URL in v1 so reloads under cold-cache conditions can re-auth. This is a deliberate security trade-off; mitigation is operational (short-lived secrets, rotation, avoid sharing secrets broadly).

#### Starting directly in live mode

Live mode must work when the user starts there (Notion embed opening a live link directly), not only as an upgrade path from static mode. The loader therefore needs to be entirely self-contained from URL parameters:

- It must not depend on a pre-existing workspace clone.
- It must be able to build the dependency set and seed the minimal cache on first load.
- It must apply the same UI restrictions policy as the normal app once live mode is active (i.e. restore full WindowSelector and query editing semantics).

## Dependency closure (“graph bundle”) logic

We should treat `export-graph-bundle.js` as a behaviour reference and implement equivalent detection in production code:

- **Inputs**:
  - Graph JSON.
- **Outputs**:
  - Referenced parameter IDs (edge param pointers including conditional params).
  - Referenced event IDs.
  - Referenced case IDs.
  - Referenced context keys (from graph DSL fields).
  - Referenced node IDs.

### Minimal closure for mode (C)

For “live + dependency param cache”, the minimum viable closure is:

- Graph file itself.
- Parameter files referenced by the graph (including conditional parameter references).

Whether to include events/cases/contexts/nodes depends on what the “live embed” must support:

- If we only need “parameter cache reuse” and basic rendering, we can start with parameters only.
- If live scenarios / DSL resolution requires these supporting files, add them as needed.

## Index files: strategy options

The export script supports index files as an optimisation and for non-standard paths. In-app live mode must decide how to handle them.

### Option 1: No index files (simplest)

- Fetch graph file.
- Fetch parameter files directly via conventional paths (`parameters/<id>.yaml`).
- Pros: simplest implementation and minimal bytes.
- Cons: fails if repo uses non-standard file paths or relies on index-based resolution.

### Option 2: Fetch full root indexes (simple + robust)

- Fetch `parameters-index.yaml` (and other index files if needed) unfiltered.
- Use it to resolve ID → file path correctly.
- Pros: robust against non-standard paths; avoids needing to build filtered YAML.
- Cons: higher bytes than necessary per view.

### Option 3: Fetch indexes, then write filtered indexes into the live cache (script-aligned)

- Fetch index files once per live view.
- Filter to just the referenced IDs and persist the filtered index YAML into the local cache.
- Pros: minimal content footprint while maintaining correct resolution.
- Cons: additional complexity; requires YAML write/parse in the client.

Recommendation for MVP: start with Option 2 if any repos use non-standard paths; otherwise Option 1.

v1 decision: use **Option 2** (fetch full root indexes) for correctness and to avoid assuming conventional paths.
Later optimisation (post-v1): filter indexes inside the isolated share storage if we need to reduce bytes, but never write filtered indexes into the user’s normal workspace storage.

## “Enter live mode” from static snapshot

Implement a transition that:

- Detects that the current tab was loaded from `?data=...`.
- If `secret` is present, uses the live-mode loader to fetch:
  - latest graph (by `graph` id, which must be known or derivable), and
  - dependency closure files,
  - then swaps the tab’s backing file to the fetched live file.

This requires that the static share flow either:

- already knows the graph identifier (graph name) and includes it in the static URL, or
- provides a user prompt to select the target graph identifier when entering live mode.

State continuity across the transition:

- The user’s current view state should be preserved across the upgrade where it makes sense (e.g. which layer is visible, current selection).
- The loaded live graph may differ from the embedded snapshot (because it is “latest”); the UI should treat this as an intentional upgrade rather than a silent mutation:
  - communicate that the graph was refreshed from the repo, and
  - ensure the tab remains coherent (no partial state from a different graph instance).

## Caching and request minimisation

Because Notion does not preserve storage across app restarts, “cold cache” must be the default assumption. To reduce GitHub traffic:

- Use a two-step fetch where possible:
  - a cheap metadata request (ETag / SHA) to detect changes
  - only download full content when changed

Note: GitHub’s contents API exposes file SHA; we can treat “unchanged SHA” as “no download needed”.

## Security considerations

- `secret` in URL is sensitive:
  - It can leak via screenshots, referrers, logs, and Notion itself.
  - v1 mitigation: keep `secret` short-lived and rotate it. We intentionally keep it in the URL for reloadability under cold-cache conditions.

- `nonudge=1` should be present for share flows to avoid UI interruptions.

## Testing plan (prose only)

### Phase 1 tests

- **Static share**:
  - Copy share URL; open in a fresh browser profile; ensure Current layer is visible and no staleness modal appears.
  - Verify read-only enforcement: query/window editing disabled, data retrieval actions disabled.
  - Verify "Enter live mode" action is available and functional (when identity metadata is present).

- **Live share**:
  - Generate live link; open in a fresh browser profile; ensure it loads without workspace clone and shows the correct graph.
  - Validate that parameter files referenced by the graph are present in the cache and that "fetch" operations reuse them.
  - Verify credentials unlock via `?secret=` against `SHARE_SECRET` and `SHARE_JSON`.

- **Storage isolation**:
  - Open a share link in a browser session that already has a Nous workspace.
  - Verify that the share link does not restore workspace tabs.
  - Verify that share link cache seeding does not overwrite any files in the workspace DB.
  - Open two different live share links (different repos/graphs); verify they do not collide (each uses its own share-scoped DB).

- **Notion embed**:
  - Embed both static and live URLs.
  - Verify behaviour across:
    - opening a new Notion tab (storage persists within session)
    - restarting the Notion app (storage resets)
  - Confirm cold-cache live load remains performant and does not pull the whole repo.

- **Dependency closure**:
  - For representative graphs, verify the in-app dependency collector finds the same parameter IDs as the reference script.
  - Verify conditional probability param references are included.

- **Regression checks**:
  - Existing workspace mode boot remains unchanged.
  - No business logic added to menu files; only service/hook calls.

### Phase 2 tests

- **Share bundle modal**:
  - Open modal; verify all open tabs are listed with correct icons.
  - Select subset of tabs; generate link; open in fresh profile; verify only selected tabs appear.
  - Verify initial active tab respects modal selection.
  - Verify dashboard mode toggle produces correct presentation on load.

- **Per-tab share actions**:
  - Verify tab context menu and navigator context menu items are present.
  - Verify they produce correct single-tab share links.

- **Tab bundle deduplication**:
  - Share two tabs referencing the same graph; verify URL does not duplicate graph content.

### Phase 3 tests

- **Chart share**:
  - Share static chart; open in fresh profile; verify baked chart is displayed.
  - Share live chart; open in fresh profile; verify chart is recomputed.
  - Verify URL size policy: attempt to share oversized baked payload; verify refusal and alternative offer.

- **Scenario-level share**:
  - Share single scenario from context menu; open in fresh profile; verify only that scenario is visible.



## Share payload (graphs + scenarios + analysis/chart)

> **Phasing note**: This section defines the full share payload architecture. Implementation is phased:
> - **Phase 1**: §1–2 (mode/target, graph identity), §3–4 (scenario definitions and view state for graph-only share)
> - **Phase 2**: tab bundles, deduplication, bundle-level presentation
> - **Phase 3**: §5–6 (analysis/chart recipe and baked artefacts)

This section defines a single conceptual "share payload" shape that can recreate the intended view in **static** or **live** mode, while aligning to today's state model:

- Analysis view state is stored in `TabState.editorState` (e.g. `analyticsQueryDSL`, and scenario selection/modes).
- Chart view state is stored as a persisted “chart file” (`chart_kind`, `source.query_dsl`, `source.analysis_type`, and baked `payload.analysis_result`).

### Why we need an explicit payload (beyond `data=`)

Today’s `?data=` is effectively “just a graph snapshot”. That is insufficient to reliably land on:

- a specific analysis view (analysis type + query DSL + scenario selection), or
- a specific chart view (chart kind + scenario IDs + baked analysis result).

Therefore, we need a **separate view payload** that describes what the share link is trying to show.

### Payload fields (conceptual)

A share payload should include the following groups (Phase 1 implements §1–4; Phase 3 implements §5–6).

#### 1) Mode and target view

- **mode**: `static` or `live`.
- **target**:
  - graph
  - analysis
  - chart

#### 2) Graph identity

- **static graph snapshot**:
  - embedded graph JSON (current `data` mechanism remains the source of truth for static content).

- **live graph reference**:
  - repository identity (`repo`, `branch`)
  - graph identifier/path (same meaning as existing `?graph=`)
  - `secret` (required to unlock credentials in embed environments)

Design note: the graph reference is a *graph identifier*, not a “livegraph specialisation”. Live is a mode that changes *how we load*, not what the graph fundamentally is.

#### 3) Scenario definitions (what scenarios exist)

- **Current/base** are implicit.
- **Live scenarios** should be represented by DSL:
  - ordered list of scenario DSL fragments.
  - optional per-scenario subtitle strings (today charts already support `scenario_dsl_subtitle_by_id`).

Non-live scenario overlays are not compact/regenerable today; treat them as out of scope for live links until we define a repo-backed representation.

#### 4) Scenario view state (how scenarios are displayed)

This corresponds directly to today’s `editorState.scenarioState`:

- **visibleScenarioIds** (render order)
- **scenarioOrder** (full layer order including hidden/special layers) if we need it for parity
- **selectedScenarioId** (used today for single-scenario chart rendering in some flows)
- **visibilityMode by scenario ID** (forecast/evidence/both), because Analytics recomputation keys depend on it

#### 5) Analysis recipe (for target=analysis or target=chart)

This corresponds to today's tab state and compute inputs:

- **query DSL** (the string to run)
- **analysis type** identifier

Optional:

- whether the query was user-overridden (today `analyticsQueryOverridden`) if we want identical UI behaviour on load.

#### 6) Chart recipe and/or baked artefact (for target=chart)

Charts are already modelled as a file with a schema that includes:

- `chart_kind` (currently `analysis_funnel` / `analysis_bridge`)
- `source.query_dsl` and `source.analysis_type`
- baked `payload.analysis_result`
- `payload.scenario_ids`
- optional `payload.scenario_dsl_subtitle_by_id`

Therefore, a share link that targets a chart should include either:

- **chart recipe only** (live mode): chart kind + analysis recipe + scenario IDs, and then recompute on load, or
- **baked chart artefact** (static mode): enough to materialise the chart file payload directly.

### Encoding strategy (URL)

We should treat URL encoding as an implementation detail of the payload, but v1 needs a practical approach.

- Keep `data=` as the static graph snapshot mechanism.
- Add a separate compressed view payload parameter (e.g. `view=` or `share=`) that describes target/scenarios/analysis/chart.

This allows:

- Backwards compatibility for old `data=` links (no `view=` means “target=graph”).
- Sharing a chart view without altering the graph snapshot format.

### Share payload extension: tab bundles (per-tab and cross-tab)

To support per-tab sharing and explicit cross-tab bundles, the share payload must be able to represent a **set of tabs** rather than implicitly assuming “the current graph”.

#### Bundle shape (conceptual)

- **tabs[]**: ordered list of tab descriptors to include in the share bundle.
- **activeTabIndex** (or equivalent): which included tab should be initially focused on load.
- **presentation**:
  - `dashboard`: boolean (or a small enum) to indicate dashboard mode vs normal tabs.

Each tab descriptor must include:

- **kind**: graph / chart / analysis (aligned to editor type).
- **mode**: static vs live behaviour for that tab (for v1 we should treat mode as global for the link; per-tab overrides are future work).
- **payload**:
  - for static chart tabs: baked chart artefact (matching the chart file schema)
  - for static graph tabs: graph snapshot (`data`) or a reference to a shared graph snapshot within the bundle
  - for live tabs: recipe fields (graph identity + scenario/analysis recipe)

#### Deduplication requirement (avoid “graph + chart” bloat when sharing chart-only)

When sharing a chart-only tab, we should not automatically include a graph snapshot unless the user explicitly opts in.

When sharing a bundle containing multiple tabs that refer to the same graph, we should avoid duplication:

- Allow the bundle to carry shared file artefacts once (e.g. one graph snapshot) and have multiple tab descriptors reference it.

#### “Guessing tabs” becomes impossible by design

The share entry point must never infer which tabs to include:

- Per-tab share includes exactly one tab descriptor.
- Cross-tab share includes exactly the user-selected checklist set.

### Boot reconstruction behaviour (by target)

#### Target = graph

- Static:
  - load graph from `data=`
  - seed default `scenarioState` (Current visible)
  - apply static read-only restrictions

- Live:
  - fetch graph + dependency bundle (parameters at minimum)
  - seed files into local cache
  - materialise live scenarios from DSL (if provided)
  - apply scenario view state

#### Target = analysis

- Static:
  - load graph from `data=`
  - apply scenario view state
  - show analysis UI seeded with the analysis recipe, but do not allow changes unless entering live mode

- Live:
  - load graph + bundle
  - apply scenario definitions and view state
  - run analysis using the recipe and display results

#### Target = chart

- Static:
  - load graph from `data=`
  - materialise a temporary chart file using the baked artefact fields that match the current chart file schema
  - open the chart tab as the active tab
  - keep view read-only unless entering live mode

- Live:
  - load graph + bundle
  - apply scenario definitions and view state
  - compute analysis using the recipe
  - materialise a chart file (or open a chart tab using the existing chart operations service path) and open it as active

### Static → live upgrade (chart + analysis)

On "Enter live mode", preserve intent:

- Keep target view (analysis/chart).
- Keep scenario order/visibility/modes.
- Keep analysis recipe (query DSL + analysis type) and chart kind.

Then:

- Load live graph bundle.
- Recreate live scenarios from DSL.
- Re-run analysis.
- Refresh the chart/analysis view to the latest results.

### Explicit limitations and decision points (Phase 1 and beyond)

- **URL size**: baked analysis results may be too large for reliable links/embeds.
  - v1 must define a policy: refuse baked chart share when too large and offer live share instead.

- **Read-only enforcement**: today, read-only is implemented per-editor (e.g. GraphEditor accepts `readonly`).
  - v1 needs an explicit mechanism for “static share mode” so Analytics/WindowSelector/etc. can reliably disable writes and retrievals.
  - This should be implemented centrally (service/context flag) rather than scattered conditionals.

- **Non-live scenarios**: until scenarios have a repo-backed representation, live links should focus on DSL-backed live scenarios.


## Notion embed mechanics (iframes, headers, auth)

This document so far focuses on DagNet’s internal loading modes. For Notion embeds, there are additional practical constraints that shape what is feasible.

### How Notion renders embeds (relevant constraints)

Notion embeds are effectively iframe-based (often mediated by Notion’s embedding pipeline). Therefore:

- The hosted page must allow embedding:
  - `X-Frame-Options` must not block framing (avoid `DENY` / `SAMEORIGIN`).
  - `Content-Security-Policy` must permit Notion as a framing ancestor (configure `frame-ancestors` appropriately).

- Authentication UX is constrained:
  - Notion desktop/mobile embeds are not a reliable place to complete interactive logins.
  - Third-party cookie/storage behaviour can be restrictive/unreliable.

This is why the “live mode” design assumes **URL-delivered credential unlocking** (via `secret`) rather than “log in inside the embed”.

### Hosting implication: we need an embed-friendly HTTP surface

Even though DagNet is browser-first and has no persistent server for graph rendering, the Notion use case still requires that we host the SPA at an HTTPS origin whose response headers permit framing.

This is an infrastructure/configuration requirement (headers), not a DagNet logic requirement.

### Storage implication: cold-cache must be first-class

Empirically, Notion’s embed context does not provide durable IndexedDB across app restarts. Therefore:

- Live mode must work under cold cache.
- We should still minimise GitHub traffic using SHA/ETag checks and only download changed files within a session.

## Session logging requirements for share + live mode

Per repo guidelines, the new operations introduced by these proposals must have session logging:

- Building share links (static and live) should log as a user action (session operation).
- Live mode boot should log:
  - start (repo/branch/graph)
  - each major step (credential unlock, graph fetch, dependency closure, file seeding)
  - success and failure outcomes

This is important because Notion embeds are hard to debug without a reliable audit trail.

## Read-only enforcement in static share mode (explicit design)

Static mode restrictions must be enforceable without sprinkling ad hoc conditionals across UI components.

Therefore, the static-share design should introduce a single authoritative “share mode” / “readonly” signal that:

- is derived during URL boot,
- is available to editors/panels,
- disables mutations and external data retrieval triggers consistently.

In particular, the following must be governed:

- graph editing mutations
- query/window editing
- scenario edits/regeneration
- actions that would pull from GitHub or external providers

The only state transition allowed from static mode is: **Enter live mode**.

## URL size policy (baked analysis/chart artefacts)

Static chart sharing relies on embedding a baked analysis result. We must explicitly define a product policy for when the encoded URL becomes too large to be robust in:

- Notion embeds
- browsers that impose practical URL limits
- copy/paste channels

The policy should be:

- If baked payload exceeds a defined threshold, the UI should refuse “static chart share” and instead offer:
  - a live share link (recipe-only), or
  - a static graph-only share.

The threshold is an implementation detail but must exist so share links are predictable rather than flaky.

## Impacted code files (Phase 1)

This is the exhaustive list of code files that will be modified or created for Phase 1.

### Files to MODIFY

| File | Impact |
|------|--------|
| `graph-editor/src/main.tsx` | Add boot resolver call before App renders; DB init must happen after share mode detection |
| `graph-editor/src/db/appDatabase.ts` | Parameterise `AppDatabase` constructor to accept DB name; export factory instead of singleton |
| `graph-editor/src/lib/shareUrl.ts` | Update `encodeStateToUrl()` to add `mode=static`, `repo`, `branch`, `graph` identity metadata |
| `graph-editor/src/contexts/TabContext.tsx` | Update `loadFromURLData()` to detect `mode=live` and dispatch to live boot; pass read-only signal; skip workspace tab restore in share mode |
| `graph-editor/src/lib/credentials.ts` | Possibly minor updates to clarify share mode credential flow (already handles `?secret=`) |
| `graph-editor/src/hooks/useStalenessNudges.ts` | Already handles `?nonudge`; verify no changes needed |
| `graph-editor/src/services/gitService.ts` | Already has `getFileContent()`; verify it works for minimal fetch use case |
| `graph-editor/src/services/graphGitService.ts` | Already has `getGraph()`; may need minor updates for share boot |
| `graph-editor/src/components/editors/GraphEditor.tsx` | Already accepts `readonly` prop; wire to share mode context |
| `graph-editor/src/components/editors/FormEditor.tsx` | Already accepts `readonly` prop; wire to share mode context |
| `graph-editor/src/components/editors/RawView.tsx` | Already accepts `readonly` prop; wire to share mode context |
| `graph-editor/src/components/WindowSelector.tsx` | Disable date/context/fetch controls in static share mode |
| `graph-editor/src/components/panels/AnalyticsPanel.tsx` | Disable analysis operations in static share mode |
| `graph-editor/src/components/PropertiesPanel.tsx` | Disable mutations in static share mode |
| `graph-editor/src/components/MenuBar/FileMenu.tsx` | Update `handleShareURL()` for new URL contract; add "Enter live mode" action; add "Copy live share link" |
| `graph-editor/src/services/sessionLogService.ts` | Add share-specific log operations (share link generation, live boot steps) |
| `graph-editor/src/hooks/useURLScenarios.ts` | Verify works in share mode; may need awareness of share context |
| `graph-editor/src/AppShell.tsx` | Wire share mode context to component tree |
| `graph-editor/src/contexts/DashboardModeContext.tsx` | Verify `?dashboard` param works in share links (likely no changes needed) |
| `graph-editor/src/lib/urlSettings.ts` | Verify URL settings parsing doesn't conflict with share params (likely no changes needed) |
| `graph-editor/src/hooks/useURLDailyRetrieveAllQueue.ts` | Must be disabled/no-op in share mode (no automation in embeds) |
| `graph-editor/src/contexts/NavigatorContext.tsx` | May need to skip workspace loading in share mode |

### Files to CREATE (new)

| File | Purpose |
|------|---------|
| `graph-editor/src/lib/shareBootResolver.ts` | Detect share mode from URL; compute scoped DB name; return boot config |
| `graph-editor/src/contexts/ShareModeContext.tsx` | Centralised share mode signal (`none` / `static` / `live`); consumed by editors and panels for read-only enforcement |
| `graph-editor/src/services/liveShareBootService.ts` | Orchestrate live boot: credential unlock → graph fetch → dependency closure → cache seeding → tab open |
| `graph-editor/src/lib/dependencyClosure.ts` | Production TypeScript dependency collector (mirrors `scripts/export-graph-bundle.js` logic) |
| `graph-editor/src/hooks/useEnterLiveMode.ts` | Hook for "Enter live mode" transition from static share |
| `graph-editor/src/services/shareLinkService.ts` | Centralised share URL building (static + live); called by menus |

### Reference files (not modified, used for behaviour spec)

| File | Purpose |
|------|---------|
| `graph-editor/scripts/export-graph-bundle.js` | Reference implementation for dependency closure logic |
| `graph-editor/scripts/__tests__/export-graph-bundle.test.ts` | Test cases for dependency detection edge cases |

---

## Implementation plan (Phase 1) — complete and thorough

This section provides the step-by-step implementation plan for Phase 1. It is prose-only by design and covers all Phase 1 scope items.

### 0) Guiding constraints (non-negotiable)

- **Hard storage isolation**: share/live sessions must not be able to overwrite any existing workspace content (especially index files) when a user opens a share link in a browser where they already use DagNet normally (e.g. Nous).
- **No workspace clone/pull for live mode**: live shares must use single-file and minimal-set GitHub fetches only.
- **Menus are access points**: share URL building and boot logic must be in services/modules, not menu files.

### 1) Finalise URL contracts (explicit mode; backwards compatible)

#### Static share (Phase 1)

- Continue to use `data=` as the source of truth for content.
- Add `mode=static` to all newly generated static share links.
- Continue to include `nonudge=1` in share links.
- Include identity metadata (`repo`, `branch`, `graph`) in static links generated from a real workspace graph so "Enter live mode" can be deterministic.
  - This identity metadata is *not* used to load static content; it exists to enable upgrade-to-live.

Backwards compatibility:
- Treat legacy links that have `data=` but no `mode=` as `mode=static`.

#### Live share (Phase 1)

- Use `mode=live` plus identity params `repo`, `branch`, `graph`, and `secret`.
- Treat `repo` and `branch` as optional only if there is a clear, deterministic default rule; otherwise require them. For Notion embeds, prefer explicit values.

### 2) Decide the boot pipeline order for share sessions (and keep workspace boot unchanged)

Current boot restores tabs from IndexedDB before URL handling. For share sessions, we need deterministic URL-driven boot without interacting with the user’s workspace.

Proposal:
- Introduce a distinct “share boot mode” decision point that happens as early as possible during app initialisation.
- If the URL indicates share mode (`mode=static`/`mode=live`, or legacy `data=`), then:
  - do not restore normal workspace tabs,
  - do not reuse the normal workspace IndexedDB database,
  - perform share boot as a self-contained path.
- If the URL does not indicate share mode, keep existing boot behaviour unchanged.

Concrete placement (Phase 1):
- The share-mode decision must occur **before** the IndexedDB/Dexie instance is initialised and before Tab restoration begins.
- Implement this as a small “boot resolver” module that:
  - inspects `window.location.search`,
  - determines share mode (none/static/live),
  - determines the correct DB name to use (workspace vs share-scoped),
  - then initialises the rest of the app against that DB.

### 3) Hard isolation boundary (IndexedDB) — per-share scope to avoid collisions

We need *two* layers of protection:
- isolation from the user’s normal workspace (Nous), and
- avoidance of collisions *between* different share links opened in the same browser origin (because `fileId` is a primary key, and IDs like `parameter-foo` can exist in multiple repos).

Proposal:
- Use a separate IndexedDB database name for share mode, chosen at startup.
- Make the share DB name **scoped**, not global, so different live shares cannot collide:
  - Normal workspace DB: `DagNetGraphEditor`
  - Live share DB: `DagNetGraphEditorShare:<scopeKey>`
    - `scopeKey` is a deterministic identifier derived from `repo`, `branch`, and `graph` with these rules:
      - it must be stable across reloads for the same link,
      - it must not contain raw secrets,
      - it must be safe for use as part of an IndexedDB database name,
      - it must not exceed practical length limits.
    - v1 proposal: compute `scopeKey` as a short stable hash of the normalised identity tuple (repo/branch/graph), and include a short human-readable prefix for debugging.
    - This ensures that opening two different live shares does not mix their caches.
  - Static share DB: optional; either:
    - use `DagNetGraphEditorShareStatic:<scopeKey>` if static links have identity metadata, or
    - keep static shares ephemeral in memory only (no persistence), depending on desired UX.

v1 decision:
- Use the scoped DB for **live shares**.
- For **static shares**, keep content in-memory (no persistence) until we have a clear reason to persist static share state; static shares already embed their full source of truth in `data=`.

Garbage collection policy (v1):
- Keep it simple: no automatic deletion in v1 unless we observe runaway storage.
- If needed, add a small retention policy later (e.g. delete older share DBs beyond a small cap).

### 4) Credentials unlock and Git configuration (share/embed contract)

Proposal:
- In share mode, credential unlock is driven by `?secret=...` validated against `SHARE_SECRET`, and credentials loaded from `SHARE_JSON`.
- Configure `gitService` using the selected git credential entry (matching `repo`) and the requested `branch`.
- Do not persist `secret` anywhere (not in IndexedDB, not in logs). Treat it as a sensitive input.
- Add session logging for:
  - credential unlock start/success/failure,
  - selected repo/branch,
  - any refusal to proceed due to missing/invalid secret.

### 5) Static share boot (mode=static)

Steps:
- Decode the graph from `data=`.
- Seed a temporary graph file into the share session storage (or keep in-memory if static shares are ephemeral in v1).
- Open a graph tab with a well-formed default editor state (Current visible).
- Enforce static read-only restrictions (see §8).
- Apply URL scenario params (`scenarios`, `hidecurrent`) if present, using the existing scenario URL processing pattern.

URL clean-up policy (static):
- Always remove `nonudge` after persisting session suppression (as today).
- Do **not** automatically remove `data` in share mode, because Notion embeds often face cold-cache conditions and must remain reloadable from the URL.

### 6) Live share boot (mode=live) — minimal fetch + cache seeding

Steps:
- Validate required params: `graph`, `secret`, and enough identity to resolve repository/branch.
- Unlock credentials and configure `gitService`.
- Fetch the latest graph file using a single-file GitHub fetch (no workspace clone).
- Compute dependency closure from the fetched graph (see §7).
- Resolve dependency file paths:
  - v1 recommendation: fetch the relevant root index files (at least `parameters-index.yaml`) unfiltered, and use them to map IDs to file paths where present.
  - If an index file does not exist, fall back to conventional paths (e.g. `parameters/<id>.yaml`).
- Fetch the minimal required supporting files:
  - v1 minimum: parameter files referenced by the graph (including conditional probability param references).
  - Expand later as needed (events/cases/contexts/nodes) only when required for correctness.
- Seed the fetched files into share session storage as normal `FileState` records so downstream services behave consistently.
- Open the graph tab from the seeded live graph file with a well-formed editor state (Current visible).

Caching behaviour (within a session):
- Use GitHub file SHA to avoid re-downloading unchanged files during the same share session.
- Do not attempt cross-session caching in Notion beyond what IndexedDB provides; treat cold-cache as the default.

### 7) Dependency closure implementation (production code, script as reference)

Proposal:
- Implement a production TypeScript dependency collector that mirrors the export script’s intent:
  - edge base probability param ID
  - edge conditional probability param IDs
  - edge cost param IDs (`cost_gbp`, `labour_cost`)
  - context keys referenced in persisted DSL fields (`dataInterestsDSL`, `currentQueryDSL`, `baseDSL`)
  - optionally node/event/case references when needed for correctness
- Treat `graph-editor/scripts/export-graph-bundle.js` and its test suite as a reference for behaviour and edge cases, not as reusable production code.

Testing (design requirement):
- Add integration tests in the existing service test suites to ensure the in-app collector finds the same dependency IDs for representative graphs (requires explicit authorisation when we update tests).

### 8) Read-only enforcement in static share mode (minimal, centralised)

Proposal:
- Introduce a single share-mode signal derived during URL boot (e.g. `none`, `static`, `live`).
- In `mode=static`:
  - open editors in read-only mode,
  - disable navigational and data-fetching actions in `WindowSelector` (date changes, context changes, fetch/refresh, bulk scenario creation),
  - disable scenario creation/regeneration and other repo-mutating actions.
- Allow inspection: selection, pan/zoom, viewing current DSL, viewing chart outputs that are already embedded.
- Only permitted transition is explicit **Enter live mode**.

### 9) “Enter live mode” upgrade path (static → live)

Requirements:
- Static shares must include `repo`, `branch`, `graph` identity metadata at creation time (or else the upgrade must prompt).

Proposal (v1):
- The “Enter live mode” action navigates the app to the corresponding `mode=live` URL (carrying identity and `secret`) and performs a hard reload into the live share session.
- Preserve view intent where feasible:
  - scenario visibility/order,
  - selected scenario,
  - target view (graph vs chart vs analysis) via the share payload parameter planned elsewhere in this doc.

### 10) Opening a share link inside an existing browser session (existing Nous IndexedDB workspace)

Problem:
- Without isolation, live-mode cache seeding risks overwriting workspace files (especially index files) when the user opens a share link in an existing DagNet session.

Proposal:
- Share sessions never touch the normal workspace DB.
- Share sessions use a dedicated share-scoped DB name (see §3), so:
  - opening a share link does not restore workspace tabs,
  - seeding abridged/derived files cannot overwrite Nous (or any other workspace) files,
  - multiple share links do not collide with each other.

Return-to-workspace behaviour:
- Navigating back to the normal app (no share params) uses the normal workspace DB and restores the user’s tabs as usual.

Explicit non-overwrite guarantee (Phase 1):
- Live share boot must never write to `DagNetGraphEditor` (the workspace DB), even if the browser already has a populated Nous workspace.
- Any filtered/derived artefacts (including index filtering in future optimisations) must live only in the share-scoped DB for that link.

---

## Implementation plan (Phase 2) — bundle modal and per-tab actions

Phase 2 builds on the Phase 1 infrastructure to add more UX entry points and multi-tab support.

### Prerequisites (Phase 1 must be complete)

- Boot resolver and IndexedDB isolation working.
- URL contracts (`mode`, identity params) established.
- Share link generation and boot flows functional for single-graph share.

### 11) Share bundle modal (`File → Share link…`)

- Create a modal component that:
  - lists all open tabs (graph/chart/analysis) with checkboxes,
  - provides "select all / clear all" controls,
  - provides a radio selector for initial active tab,
  - provides toggles for: dashboard mode, live mode, include scenarios.
- The modal calls a centralised share service to build the URL.
- The URL payload encodes tab bundle structure (see §13).

### 12) Per-tab share actions (tab context menu, navigator context menu)

- Add context menu items "Share link (static)" and "Share link (live)" to:
  - tab context menu,
  - navigator item context menu (for graph files).
- These call the same share service used by the modal but for a single-tab bundle.
- Per-tab actions must reuse Phase 1 infrastructure (share mode signal, URL building, boot flows).

### 13) Tab bundle URL payload structure

- Define a `view=` (or `share=`) URL parameter that encodes:
  - `tabs[]`: array of tab descriptors (kind, mode, payload reference).
  - `activeTabIndex`: which tab to focus on load.
  - `presentation`: dashboard vs normal tabs.
- Implement deduplication: if multiple tabs reference the same graph, encode the graph once and have tab descriptors reference it.
- Implement boot reconstruction: the share boot flow must iterate `tabs[]` and open each tab with correct editor state.

---

## Implementation plan (Phase 3) — chart share and scenario-level actions

Phase 3 extends sharing to chart tabs and adds scenario-level granularity.

### Prerequisites (Phase 2 must be complete)

- Tab bundle payload structure working.
- Multi-tab boot reconstruction functional.

### 14) Chart share (static and live)

- Static chart share:
  - Capture baked chart artefact (matches chart file schema: `chart_kind`, `payload.analysis_result`, `payload.scenario_ids`, etc.).
  - Encode in the tab descriptor payload.
  - On boot, materialise a temporary chart file from the baked payload and open the chart tab.
- Live chart share:
  - Capture chart recipe (chart kind, analysis recipe, scenario IDs).
  - On boot, load graph + dependencies, recreate scenarios, compute analysis, materialise chart, open tab.
- URL size policy enforcement:
  - Define a threshold for baked payload size.
  - If exceeded, refuse static chart share and offer live share (or static graph-only) instead.
  - Surface a clear user-facing message explaining the limitation.

### 15) Scenario-level share (scenario context menu)

- Add context menu items to scenarios: "Share link for this scenario (static)" and "Share link for this scenario (live)".
- Scenario share requires graph context; encode:
  - static graph snapshot (via `data=`) or live graph reference (`mode=live` + identity), and
  - single scenario DSL (plus label/colour metadata for charts).
- On boot, open graph view with only that scenario visible and selected.
- Restriction: only DSL-backed live scenarios are shareable in Phase 3; non-live scenario overlays remain out of scope until we define a repo-backed representation.
