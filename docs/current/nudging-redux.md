## Nudging Redux (Update → Pull → Retrieve) – Proposed Redesign

**Date:** 21-Jan-26  
**Status:** Proposed redesign (needs review/approval before implementation)  
**Scope:** Staleness / update nudges, automation behaviour, and cross-device correctness  

---

## 1. Problem Statement

The current “Updates recommended” nudging behaviour has become brittle and inconsistent because:

- **Decision logic is fragmented** across multiple layers (hook, service, UI defaults), which makes precedence and blocking hard to reason about.
- **Multiple sources of truth compete** (deployed client version, remote git HEAD SHA, graph-level retrieve markers, per-parameter retrieval timestamps, cached runs).
- **Cross-device / multi-client realities** are not modelled explicitly, leading to confusing states such as “Retrieve All due” even though a different machine already ran automation and committed the results.
- **Mode-specific behaviour** (automation via URL, dashboard/unattended, share/live modes) is implemented as ad-hoc branches rather than as a coherent policy.

This document proposes a first-principles redesign that makes the system deterministic, scope-aware (global vs per graph/tab), and testable under realistic multi-client sync states.

---

## 2. Goals

- **Single source of truth** for all nudging decisions: a centralised plan that encodes ordering, blocking, and reasons.
- **Correct cross-device semantics**: if a “cron” machine refreshed and committed, another client should not be nudged to “Retrieve All” until it has pulled (or at least should be told it is blocked by remote-ahead).
- **Explicit scope modelling**:
  - Client update is **global**.
  - Git freshness is **per repository/branch scope** (with a distinct share-live scope) and **has global impact** within that scope (pulling affects all open graphs/charts in that repo/branch).
  - Retrieve freshness is **per graph (and potentially per live chart)** and therefore has **local impact** (refreshing one graph does not imply others are fresh).
- **Mode-aware policy**:
  - Normal interactive use (modal, user choice, snooze/dismiss).
  - Dashboard/unattended (auto actions where safe; avoid blocking modals).
  - Automation mode (`retrieveall` URL workflow): headless, deterministic, and safe (no modals).
- **Production-grade diagnosability**: plan includes structured “why” reasons that can be logged to Session Log for post-hoc analysis.
- **Testability**: design includes a comprehensive test matrix that models interdependent states across multiple clients and partial sync.

---

## 3. Non-Goals (for this redesign)

- Replacing the broader fetch planning / staleness semantics in the lag planner (maturity-based staleness is its own project area).
- Adding new UX surfaces beyond the existing modal / menubar badge unless required for correctness.
- Introducing server-side coordination; this remains a purely client-side behaviour.

---

## 4. Concepts and Scopes

### 4.1 Global vs Scoped Signals

We explicitly distinguish three categories of “freshness”:

- **Client version freshness (Global)**  
  Whether the deployed client (from `public/version.json`) is newer than this client build.

- **Git freshness (Per repo/branch scope; global impact within that scope)**  
  Whether the remote HEAD SHA differs from the local workspace “last synced” SHA for a given `repository/branch`.  
  **Important:** a pull affects the local state for *all* open graphs/charts in the same repo/branch scope (it is “global” within that scope).
  - For share-live scopes, the last-seen SHA is also scope-keyed by `repository/branch/graph` to avoid interfering with normal workspaces.

- **Retrieve freshness (Per graph / per live artefact; local impact)**  
  Whether the graph’s relevant data has been refreshed recently enough.
  - This is inherently tied to the graph’s fetch targets (parameters/cases) and their retrieval metadata.
  - A graph-level marker exists to allow “cached but complete” runs to still count as “fresh enough” without requiring per-parameter timestamps to change.

### 4.2 Entities that can be “nudged”

The user highlighted a key complexity: pull/retrieve status is **not global**, it is per open graph / live chart.

This redesign models nudges per “target entity”:

- **Graph tab**: a graph file opened in an interactive tab (workspace or share-live).
- **Live chart tab**: a chart/artefact that may depend on one or more graphs and potentially distinct pinned DSL.

The service should compute plans per entity, while reusing shared global and repo/branch signals.

### 4.3 Mode Flags / Context

The nudging system must consider:

- **Automation mode**: initiated via URL parameters (e.g. `retrieveall`) and intended to run headlessly.
- **Dashboard mode**: multi-pane view, often unattended (“kiosk” style).
- **Share mode**: static share or live share modes which may be read-only and have different safe actions.
- **Read-only contexts**: even outside share mode, there may be states where git actions are not permitted.

---

## 5. First-Principles Decision Cascade

The user-provided cascade is the foundation:

1) **If we don’t have the latest client, we need it.**  
2) **Only then: if remote is ahead, we should pull from git.**  
3) **Only then: if Retrieve All hasn’t happened recently, we should do that.**

### 5.1 Why this cascade matters

This ordering prevents pathological states:

- Running Retrieve All on an out-of-date client can generate inconsistent artefacts (different fetch semantics, missing logging, etc.).
- Running Retrieve All when remote is ahead risks writing on top of stale local files and producing non-mergeable diffs (or unnecessary churn).
- Treating Retrieve All as “due” before pull is complete causes the exact cross-device confusion observed: the cron machine committed, but this client hasn’t pulled yet.

### 5.2 “Due”, “Blocked”, “Unknown” and “Not Due”

Each step in the cascade must have one of the following statuses:

- **Due**: should be performed now.
- **Blocked**: would be desirable, but a prerequisite step is Due/Unknown.
- **Unknown**: cannot determine due-ness (offline, missing credentials, missing repo selection, etc.).
- **Not due**: no action needed.

The UI should never silently translate “Unknown” into “Due”.

---

## 6. Proposed Architecture

### 6.1 Single Central Service: Nudging Plan Service

Create or evolve a single central service (likely by refactoring/extending `stalenessNudgeService`) to own:

- Collecting signals (remote version, remote SHA, retrieve freshness)
- Computing a deterministic plan per target entity
- Enforcing cascade ordering and blocking
- Applying mode-specific policy
- Producing structured explanation strings + context objects for Session Log

The hook (`useStalenessNudges`) becomes a thin orchestration layer:

- Determine “current target entity” (active graph tab, active live chart tab)
- Ask the service for a plan for that entity
- Render modal based on plan
- Execute actions by delegating back to service APIs (still respecting “no logic in UI”)

### 6.2 Plan Shape (conceptual)

The plan must represent:

- **Global client update step**
  - local client version
  - last seen deployed version
  - update status + reason

- **Git pull step (scoped)**
  - scope key (workspace or share-live)
  - local SHA (last-synced)
  - remote SHA (remote head)
  - pull status + reason

- **Retrieve step (entity-scoped)**
  - entity identity (graph file id, optional chart identity)
  - most recent retrieval timestamp (derived)
  - last successful retrieve marker timestamp (if present)
  - staleness status + reason

- **Action ordering and blocking**
  - explicit prerequisites and “blocked-by” relationships

- **Recommended defaults**
  - which boxes are pre-selected in interactive mode
  - whether to auto-run anything in unattended/automation modes

---

## 7. Data Sources and Invariants

### 7.1 Client version (global)

- **Local**: `APP_VERSION` (build-time package version).
- **Remote**: cached value from `public/version.json`.
- **Invariants**
  - If remote is newer, “Update client” is Due.
  - If remote is older (staged rollout), “Update client” is Not due and must not claim otherwise.
  - If remote is unknown, status is Unknown (but policy may choose to proceed with other steps).

### 7.2 Git freshness (repo/branch or share-live scope)

- **Workspace mode**:
  - local: workspace metadata “last synced” SHA from IndexedDB workspace records
  - remote: remote head SHA from GitHub API
- **Share-live mode**:
  - local: scope-keyed “last seen remote head” (since there may not be a durable workspace commit SHA)
  - remote: remote head SHA from GitHub API

**Invariants**
- If remote is ahead, pull is Due and retrieve is Blocked.
- If remote check is not possible (missing creds/network), pull is Unknown and retrieve should be Blocked (strict cascade) or explicitly policy-driven (see §9).

**Impact note**
- A successful pull mutates the local working set for *all* open graphs/charts in the same `repository/branch` scope. The nudging plan must therefore treat pull as a scoped-global prerequisite that can invalidate downstream “retrieve freshness” assessments across many entities.

### 7.3 Retrieve freshness (graph / chart entity)

There are two relevant signals:

- **Graph-level cross-device marker**: last successful Retrieve All completion timestamp.
- **Per-parameter retrieval timestamps**: the most recent `retrieved_at` across fetch targets.

**Invariants**
- A “fresh enough” graph marker suppresses retrieve nudges even if per-parameter timestamps are older (cached runs still count).
- A stale marker must not suppress fresh per-parameter timestamps.
- For display (“Last”), we should show the **newest** meaningful timestamp available.

---

## 8. Multi-Target Reality: Graph Tabs vs Live Charts

### 8.1 Why charts are different

A live chart can be:
- dependent on a graph file (and therefore the graph’s retrieve freshness),
- dependent on a pinned DSL that differs from the graph tab’s current view,
- potentially aggregating across multiple graphs (future-facing).

### 8.2 Proposed rule

Treat charts as first-class entities:

- The plan service should accept an entity descriptor that includes:
  - entity type (graph or chart)
  - underlying repository/branch scope
  - one or more graph dependencies (for charts)
  - effective DSL / slice requirements (if available)

If chart dependencies span multiple graphs/scopes, the service must:
- compute the plan per dependency
- merge them into a safe composite plan where “blocked” is conservative

---

## 9. Mode-Specific Policy

### 9.1 Normal interactive mode

- Modal can be shown when any step is Due (subject to rate limiting and snooze).
- Defaults should respect the cascade:
  - if update is Due → only update step selected; downstream blocked
  - else if pull is Due → pull selected; retrieve blocked
  - else if retrieve is Due → retrieve selected

### 9.2 Dashboard / unattended mode

Goal: avoid modal reliance.

- If update is Due:
  - auto-reload once per remote version (guarded against loops)
  - log to Session Log that an unattended auto-reload occurred
- Else if pull is Due:
  - auto-pull with a visible countdown and a way to snooze/dismiss (current behaviour can be formalised)
- Else if retrieve is Due:
  - in dashboard mode, policy must be conservative:
    - if retrieve is safe and non-destructive, allow auto-run with strong logging
    - otherwise surface a non-blocking banner and keep the plan available in Session Log

### 9.3 Automation mode (URL `retrieveall`)

Automation is already “pull → retrieve → commit”. It should:

- **Bypass the modal entirely**.
- Enforce the cascade deterministically:
  - ensure client update is not required (if it is, log and abort or retry later depending on desired semantics)
  - then pull (remote-wins strategy is already specified)
  - then retrieve
  - then commit if changes exist
- Record a structured plan summary into Session Log at start so it is auditable.

### 9.4 Force replace on pull (remote “force” flag + 10s countdown)

There is an additional, separate “nudge-like” flow that can appear during **git pull**:

- Certain derived-data files (currently **parameter** and **case** files, excluding index files) may carry a remote field `force_replace_at_ms`.
- If the local file is **dirty** and the remote `force_replace_at_ms` is newer than the local one, a pull may require a **one-shot force replace decision**:
  - **Interactive pull (“Pull All Latest”)**: a modal appears with a **10 second countdown**; if the user does nothing the default is **auto-OK** (overwrite local with remote; skip merge).
  - **Headless/unattended pull (dashboard mode / `pullLatestRemoteWins` used by automation)**: the system **auto-OKs immediately** (no modal), logs the decision, and continues.

Design implications for the consolidated nudging service:

- This is not a “freshness” decision; it is a **merge safety mechanism** to prevent stale data resurrection after “Clear Data” commits.
- However, it *does* interact with the cascade because “Pull” may be Due and the pull may be blocked on a force-replace decision in interactive mode.
- Therefore, the consolidated service should treat “Pull” as potentially requiring **user confirmation** for force-replace requests when not in unattended mode, and surface that requirement explicitly in the plan.

Minimum correctness requirements:

- In **automation (`retrieveall`) mode**, force-replace must never deadlock on UI:
  - it must auto-OK (current behaviour) and emit Session Log entries for request + auto-apply.
- In **interactive mode**, the countdown modal must:
  - correctly list the affected files (paths + IDs),
  - auto-confirm at 0 seconds,
  - write Session Log entries for prompt + final choice,
  - and result in a pull outcome that is consistent with the decision (apply vs merge normally).

### 9.4 Share mode (static / live)

Share mode policies should prioritise safety:

- Static share (isolated DB, often read-only): git pull and retrieve operations should typically be Not applicable or Blocked.
- Live share: git pull may be allowed, but commit is not; retrieve may be allowed only if it does not persist to git.

This implies the plan service must have explicit “capabilities” for the current mode (canPull, canRetrieve, canWriteFiles, canCommit).

---

## 10. Proposed Rate-Limiting and Nudging Policy

We should separate:

- **Signal refresh cadence** (how often we fetch remote version / remote sha)
- **Prompt cadence** (how often we show the modal)
- **Action cadence** (how often unattended auto-actions may run)

The plan service should own these as policy knobs rather than scattering them across hooks.

Key requirement: prompts should be suppressed during automation runs and should never fight with automated flows.

---

## 10.1 Auditability: where flags and timestamps are written (and how we ensure they stay correct)

The redesigned service must be hardened by explicitly auditing *every* write site that affects nudging decisions. This prevents “invisible coupling” where a timestamp is updated in one path but not another.

### 10.1.1 Categories of writes

- **Client update / deployed-version tracking (global)**
  - Cached deployed version and the time it was last checked (localStorage).
  - Any “auto-reloaded for version X” loop guards (localStorage).

- **Git freshness tracking (scoped)**
  - “Last synced” workspace SHA and related metadata (IndexedDB workspace records).
  - Share-live scope “last seen remote head” markers (localStorage or other scope-keyed storage).

- **Retrieve freshness tracking (entity-scoped)**
  - Graph-level “last successful Retrieve All Slices” marker (graph file metadata; must round-trip through git when committed).
  - Per-parameter retrieval timestamps (inside parameter files; must round-trip through git when committed).

- **Prompting / throttling state (global and scoped)**
  - Last prompted timestamps, snooze windows, and dismiss markers (localStorage / sessionStorage).

### 10.1.2 Required invariants across write sites

The consolidated service logic assumes:

- **No write without an audit trail**: any change that affects future plans must emit a structured Session Log entry (or a child entry of a top-level operation) describing:
  - what was written
  - the scope (global / repo-branch / entity)
  - the reason (what decision it supports)

- **No “UI-only” shadow state**: the plan must not rely on transient UI stamps when a durable source of truth exists (e.g. workspace lastSynced, graph marker, per-parameter retrieved_at).

- **One path, many callers**: automation, dashboard behaviours, menus, and interactive modals must execute the same service method(s) so they cannot diverge in what they write.

### 10.1.3 Concrete tracing checklist (to be completed during implementation)

Before implementing the consolidated service, trace and list the exact write sites and keys/fields for:

- Deployed version caching and rate-limit timestamps.
- Auto-reload guard values.
- Remote-ahead “last checked” and “last seen” values (workspace vs share-live scopes).
- Graph marker stamping for Retrieve All completion.
- Per-parameter `retrieved_at` stamping and how it is persisted/committed.
- Snooze/dismiss/prompt timestamps and their scope keys.

Then ensure each is either:
- removed as redundant, or
- owned by the consolidated service and covered by tests in §11.

---

## 11. Testing Strategy (First-Principles)

We need tests that model **interdependent complexities across different clients in different sync states**.

### 11.1 Unit-level plan computation tests

Add a matrix-driven suite for plan computation that covers combinations of:

- client version:
  - remote newer
  - remote equal
  - remote older (staged rollout)
  - remote unknown

- git state (per scope):
  - remote ahead
  - remote equal
  - remote unknown (offline/creds missing)

- retrieve state (per entity):
  - marker fresh
  - marker stale
  - parameter timestamps fresh
  - parameter timestamps stale
  - timestamps missing (new graph)

Assertions:
- cascade ordering and blocked states are correct
- “Last” timestamps are correct and stable
- reasons are populated (for Session Log clarity)

Additional assertions (audit hardening):
- the plan computation identifies which underlying signals are “authoritative” vs “advisory”
- “unknown” states remain explicit (no implicit coercion to due/not due)

### 11.2 Multi-client integration modelling

Model at least two logical clients:

- **Client A (cron machine)**: runs automation, writes/commits retrieval updates.
- **Client B (viewer)**: has older local workspace state and has not pulled yet.

Key scenario:
- Client A commits fresh retrievals.
- Client B:
  - sees remote ahead → pull Due
  - retrieve Blocked (and must not be shown as Due)
  - after pull, retrieve becomes Not due if freshness is now within policy window

Additional scenario (scope/globality):
- Multiple graph tabs open in the same repo/branch.
  - One pull updates the repo/branch scope.
  - All entity plans must be invalidated/recomputed (no “per-tab stale cache” of pull state).

### 11.3 Mode-specific tests

Explicitly test:
- automation mode suppresses modal prompts and runs deterministic pipeline
- dashboard mode auto-reload/pull behaviours do not loop and are rate-limited
- share mode capabilities block unsafe actions

Add “write site audit” tests:
- For each write that affects plan computation (version cache, remote-ahead markers, retrieve marker, snooze/dismiss), assert:
  - it is written by the consolidated service path (not ad-hoc UI code)
  - it is scoped correctly (global vs repo-branch vs entity)
  - it is accompanied by a Session Log entry where appropriate

---

## 12. Migration / Refactor Plan (High Level)

1) Introduce the plan computation API in the central service (no UI changes yet).
2) Add comprehensive plan computation tests (matrix + multi-client modelling).
3) Refactor `useStalenessNudges` to consume the plan and render the modal purely from it.
4) Refactor automation and dashboard behaviours to use the same plan/execution code path (mode-specific policy hooks inside the service).
5) Delete legacy branching logic and partial fallbacks.

---

## 13. Open Questions / Decisions Needed

- **Strictness of cascade under “unknown”**:
  - If git state is unknown (offline/creds missing), do we block retrieve or allow it?
  - Default in this doc is conservative: block downstream when prerequisites are unknown.
  *** IT IS CONCEIVABLE -- IF UNLIEKLY -- THAT A NON-CREDENTIALLED MACHINE COULD RETRIEVE BUT NOT PULL / PUSH; NO REASON TO PREVENT THAT ***

- **Live chart dependency model**:
  - Do charts always depend on a single graph today, or do we need to support multi-graph charts now?

  *** A CHART ALWAYS DERIVES FROM A SINGLE GRAPH; IF PINNED THEY MAY HOWEVER RELY ON THEIR OWN QUERY DSLS ***

- **Unattended retrieve policy**:
  - In dashboard mode, should retrieve auto-run by default, or only after explicit opt-in? *** THAT'S INTRIGUING. THERE'S NO REASON WHY IT SHOULDN'T AUTO-RUN -- BUT DOING SO OF COURSE ONLY IF REMOTE IS NOT AHEAD *** 

- **Staleness semantics for retrieve**:
  - Today’s retrieve nudge uses a simple 24h threshold.
  - Longer-term, we may want maturity-based staleness (see lag planner docs), but this redesign does not change those semantics; it only makes the nudging pipeline coherent. *** AT PRESERNT WE SHOULD JUST USE A CONST VALUE [CURRENT=24H]. WE MAY LATER WANT TO DO SOMETHING PER GRAPH OR WHATEVER, BUT THAT'S FINE FOR NOW ***

---

## 14. Summary

This redesign makes nudging:

- deterministic via an explicit cascade (update → pull → retrieve),
- scope-aware (global vs per repo/branch vs per graph/chart),
- mode-aware (interactive vs dashboard vs automation vs share),
- and testable under real multi-client drift.

The next step is to agree on the open questions (especially cascade strictness under unknown states) before implementing the service refactor.

