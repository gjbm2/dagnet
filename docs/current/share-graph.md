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

## Non-goals (for the first rollout)

- Supporting full repo browsing inside the embed context (Navigator listing, full registry UX, etc.).
- Guaranteeing that all data operations work offline in Notion (Notion reload behaviour prevents durable caching).
- Perfect parity with full workspace mode behaviour (we explicitly create an “embed/live mode” path).

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
  - This is the intended single source of truth for “graph → referenced files” dependency detection.

## Proposed user-facing UX

### 0) Share link (new, preferred over “Export”)

We should treat sharing as a first-class interaction, not a file export:

- Prefer `File → Share link…` (instead of burying under Export).
- Support both:
  - **Per-tab sharing** (share just one tab’s view).
  - **Cross-tab sharing** (a deliberate bundle of multiple tabs).

This removes “guessing” which tabs are included: the user explicitly selects the scope.

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
  - It updates the URL to the live-mode form (and removes the bulky `data` payload, to avoid leaking it and to keep the URL stable).

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
    - (Future) analysis view tab/panel → `target=analysis`
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

### Live mode (C)

- Parameters:
  - `mode=live`: indicates “live mode” (mode applies to the view, not the graph)
  - `repo`: repository name (must match a git credential entry name) *** OPTIONAL: USE DEFAULT IN CREDS IF NOT PROVIDED ***
  - `branch`: branch name *** LIKEWISE OPTIONAL ***
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

### C) Live mode path (`mode=live`)

Implement a new branch in the URL boot flow that:

1. Validates required parameters are present (`repo`, `branch`, `graph`, `secret`).
2. Loads credentials using the existing `credentialsManager` precedence rules, so `?secret` unlocks system credentials.
3. Configures `gitService` with the selected repo credential.
4. Fetches the latest graph file content from GitHub using a single-file fetch primitive (not workspace clone).
5. Computes the dependency closure for that graph and fetches the required supporting files from GitHub.
6. Seeds the fetched files into IndexedDB and FileRegistry using normal `FileState` shapes so downstream services behave consistently.
7. Opens the graph tab from the seeded graph file with a well-formed `editorState` (Current visible, etc.).
8. Cleans URL parameters that should not persist in the address bar if appropriate (note: we may keep `mode=live&repo=...&branch=...&graph=...` stable, but `nonudge` is safe to remove after first use; `secret` should be handled deliberately per security policy).

#### Starting directly in live mode

Live mode must work when the user starts there (Notion embed opening a live link directly), not only as an upgrade path from static mode. The loader therefore needs to be entirely self-contained from URL parameters:

- It must not depend on a pre-existing workspace clone.
- It must be able to build the dependency set and seed the minimal cache on first load.
- It must apply the same UI restrictions policy as the normal app once live mode is active (i.e. restore full WindowSelector and query editing semantics).

## Dependency closure (“graph bundle”) logic

We should reuse the `export-graph-bundle.js` dependency detection logic, not re-invent it:

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
  - Mitigation: keep `secret` short-lived if possible; consider removing it from the URL after credentials load (but ensure the view can still refresh if needed).

- `nonudge=1` should be present for share flows to avoid UI interruptions.

## Testing plan (prose only)

- **Static share**:
  - Copy share URL; open in a fresh browser profile; ensure Current layer is visible and no staleness modal appears.

- **Live share**:
  - Generate live link; open in a fresh browser profile; ensure it loads without workspace clone and shows the correct graph.
  - Validate that parameter files referenced by the graph are present in the cache and that “fetch” operations reuse them.

- **Notion embed**:
  - Embed both static and live URLs.
  - Verify behaviour across:
    - opening a new Notion tab (storage persists)
    - restarting the Notion app (storage resets)
  - Confirm cold-cache live load remains performant and does not pull the whole repo.

- **Regression checks**:
  - Existing workspace mode boot remains unchanged.
  - No business logic added to menu files; only service/hook calls.



## Share payload v1 (graphs + scenarios + analysis/chart)

This section defines a single conceptual “share payload” shape that can recreate the intended view in **static** or **live** mode, while aligning to today’s state model:

- Analysis view state is stored in `TabState.editorState` (e.g. `analyticsQueryDSL`, and scenario selection/modes).
- Chart view state is stored as a persisted “chart file” (`chart_kind`, `source.query_dsl`, `source.analysis_type`, and baked `payload.analysis_result`).

### Why we need an explicit payload (beyond `data=`)

Today’s `?data=` is effectively “just a graph snapshot”. That is insufficient to reliably land on:

- a specific analysis view (analysis type + query DSL + scenario selection), or
- a specific chart view (chart kind + scenario IDs + baked analysis result).

Therefore, we need a **separate view payload** that describes what the share link is trying to show.

### Payload fields (conceptual)

A v1 payload should include the following groups.

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

This corresponds to today’s tab state and compute inputs:

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

On “Enter live mode”, preserve intent:

- Keep target view (analysis/chart).
- Keep scenario order/visibility/modes.
- Keep analysis recipe (query DSL + analysis type) and chart kind.

Then:

- Load live graph bundle.
- Recreate live scenarios from DSL.
- Re-run analysis.
- Refresh the chart/analysis view to the latest results.

### Explicit limitations and decision points (v1)

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

## Open questions / design issues (grounded in current code)

This section flags concrete design questions and implementation risks based on the current repo state (as of **13-Jan-26**) and the traced URL/share/credentials codepaths.

### 1) “Live mode” URL contract is not implemented anywhere yet

- **Current reality**: There is **no** `mode=live` branch in the URL boot flow. The only URL-driven graph loaders in `TabContext` today are:
  - `?data=...` → decode and create a temporary `graph-url-data-<timestamp>` file (and a tab).
  - `?graph=...` → load from GitHub via `graphGitService.getGraph()` (but this uses Navigator-selected repo/branch or `credentials.defaultGitRepo`, not explicit URL repo/branch).
- **Implication**: The proposed live-mode URL parameters (`mode=live`, `repo`, `branch`, `graph`) are currently **documentation-only**. The first “live mode” rollout will need a new central boot handler and cannot be “just a new share URL builder”.

*** THAT'S WHY WE WROTE THIS DESIGN DOC.... IS THERE ANYTHING _MISSING_ FROM THE DESIGN DOC ? ***_

### 2) Credentials unlock env var names are inconsistent between doc and client implementation

- **Doc claim**: `?secret=<value>` unlocks credentials from `SHARE_JSON` / `SHARE_SECRET`.
- **Client reality** (`credentialsManager` in `graph-editor/src/lib/credentials.ts`):
  - `?secret=...` triggers “system secret” load.
  - The system secret loader reads from **`VITE_CREDENTIALS_JSON` / `VITE_CREDENTIALS_SECRET`** (via `import.meta.env` in the browser and `process.env` in Node contexts).
  - `SHARE_JSON` / `SHARE_SECRET` are *not* the primary variables used by the client loader today (even though the repo does define them in Vite config and in serverless contexts).
- **Design issue**: We need to decide whether the embed/share environment is keyed off `SHARE_*` or `VITE_CREDENTIALS_*` (or both, with a single canonical precedence rule). Right now, the document does not match the client’s source of truth.

*** SHARE_* IS CORRECT FOR THESE NEW SHARING FEATURE ***


### 3) There are currently two “share credential” mechanisms, and they target different threat models

- **Static graph share** (`File → Export → Copy Shareable URL`): encodes graph JSON into `?data=...` and adds `nonudge=1`.
- **Creds share link** (`CredsShareLinkModal` + `credentialsShareLinkService`): generates a link with **`?creds=<json>`** (explicitly described in UI as “token-in-URL” and “unsafe”).

*** REMIND ME WHERE THIS IS EXPOSED TO USER? ***

- **Secret-based unlock** (`?secret=...`): intended to unlock credentials from deployment environment without embedding tokens in the link.

Open question:
- **Which share flow is the intended Notion embed path?**
  - If it’s secret-based, we should be careful not to “accidentally” rely on `?creds=` for live embeds (it is a materially different security posture).
  - If it’s creds-in-URL, then the doc should explicitly acknowledge the risk and explain mitigation and operational practices (time-limited read-only tokens, rotation, etc.).


  *** HOW IS THIS AN 'OPEN QUESTION'? WHY WOULD IT USE CREDS? THAT'S NOT SPECIFIED ANYWHERE IN THIS DOC. ***

### 4) Static share “read-only restrictions” are not centrally enforced today

- **Doc intent**: Static share mode should be view-only and should disable query/window edits and external operations unless entering live mode.
- **Current reality**:
  - `GraphEditor` supports a `readonly` prop, but `TabContext` does not set any “share/static readonly” flag when loading from `?data=`.
  - `?nonudge` suppresses staleness nudges, but it does **not** enforce read-only behaviour; it only disables the nudge modal for that browser session.
- **Design issue**: We need a single authoritative “share mode” signal (context/service) and an inventory of all operations it must gate (graph mutations, scenario edits, query/window changes, retrieve flows, git ops, etc.). Otherwise static links will remain “editable” in practice.

*** AGREE. PROPOSE ONE. I DON'T THINK WE NEED CANONICAL CONTROLS, JUST DISABLE THE NAVIGATIONAL ASPECTSE OF THE WINDOWCOMPONENT IN STATIC MODE AS IN PRACTICE NONE OF THEM WILL WORK ***

### 5) URL clean-up behaviour differs per parameter family (and can affect share-link stability)

- `TabContext` removes `data` from the URL after loading a static share.
- `useStalenessNudges` removes `nonudge` from the URL after persisting the suppression bit into `sessionStorage`.
- `useURLScenarios` removes `scenarios` and `hidecurrent` after applying them.

Open questions:
- For live links, which parameters should be **stable** (kept in the address bar) vs **one-shot** (removed after processing)?
- Security trade-off: should `secret` be removed after credential load, and if so how do we handle subsequent refreshes in Notion (cold cache is common)?

*** CURRETNLY THE APP DOESN'T ATTEMPT TO HOLD STATE IN URLS. WHY WOULD WE CHANGE THAT? IS THERE ANY ACTUAL RISK HERE? ***

### 6) Dependency closure: the “single source of truth” is currently a Node script, not a shared library

- The dependency closure logic (`collectGraphDependencies`) lives in `graph-editor/scripts/export-graph-bundle.js` and is tested in `graph-editor/scripts/__tests__/export-graph-bundle.test.ts`.
- The app (browser) code does not currently import/reuse this logic.

Design issue:
- If we truly want this to be the single source of truth, do we:
  - extract the dependency collector into a shared module usable by both the Node script and the browser bundle, or
  - treat the script as “reference” and re-implement carefully in the client (with explicit parity tests)?

  *** THE LATTTER. THE SCRIPT WAS JUST A DESIGN REFERENCE FOR THE EXTRACTION LOGIC; WE WILL OBVIOUSLY NEED TO IMPLEMENTE THIS PROPERLY AND ROBUSTLY IN PRODUCTION CODE ***

### 7) “Live mode should not clone/pull” must avoid existing workspace-centric assumptions in tab loading

- Today, non-graph files (`parameter`, `context`, `case`, `node`) opened via `TabContext.openTab` are **workspace-only**: it expects them to exist in IndexedDB/FileRegistry already and will throw if they don’t.
- Many services (e.g. staleness checks and planners) assume file IDs like `parameter-<id>` and will consult IndexedDB as source of truth when FileRegistry misses entries.

Design issues:
- For live embeds, what is the canonical “workspace scope” in IndexedDB for the seeded minimal cache?
  - Do we seed unprefixed IDs (`parameter-foo`) with `source.repository/source.branch` set appropriately?
  - Do we seed prefixed IDs (`<repo>-<branch>-parameter-foo`) and rely on fallback queries?
  - Whatever we choose must be consistent with existing services’ lookup logic.

*** DO NOT FOLLOW ***

### 8) Graph identity for “Enter live mode” from `?data=` is not derivable today

- `?data=` creates a temporary file with `source.repository='url'` and `path='url-data'`.
- No repository/branch/graph metadata is stored alongside that payload today.

Open question:
- When upgrading from static to live, do we require the static link to already carry `repo/branch/graph`, or do we prompt?
- If we want “one link that can be upgraded”, we need to decide where to store/encode the canonical graph identity in static shares.

*** YOU'LL NEED TO, OTHERWISE THOSE DATA CAN'T BE INFERRED. ***

### 9) Share URL base path / routing assumptions

- `encodeStateToUrl()` builds the share URL as `${origin}${pathname}?data=...`, not necessarily the app root (`/`).
- Other share URL builders (e.g. `buildCredsShareUrl`) explicitly force `pathname='/'`.

Open question:
- For Notion embeds, should share links always land on app root to minimise routing edge cases?

*** APP TODAY IS ALWAYS AT SAME PLACE SO THIS IS A BIT ACADEMIC. ***

