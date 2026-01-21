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
- If remote check is not possible (missing creds/network), pull is Unknown.
  - **Default (conservative cascade)**: retrieve is Blocked because a prerequisite is Unknown.
  - **Decision override (see §13)**: do **not** hard-block retrieve purely because git is Unknown. In that case, retrieve may be allowed, but must be explicitly labelled as “retrieve without pull”, and the execution path must not attempt any git operations.

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
  - **Remote-wins detail (current implementation)**: unattended auto-pull uses `pullLatestRemoteWins`, which:
    - auto-OKs any `force_replace_at_ms` requests (overwrite local with remote for those files; skip merge)
    - resolves any remaining merge conflicts by accepting the remote version (and logs the fact to Session Log)
- Else if retrieve is Due:
  - surface a non-blocking banner (or equivalent) and keep the plan available in Session Log.
  - **Do not auto-run retrieve** in dashboard mode (see §13 decision) to avoid thundering herd behaviour.

### 9.3 Automation mode (URL `retrieveall`)

Automation is already “pull → retrieve → commit”. It should:

- **Bypass the modal entirely**.
- Enforce the cascade deterministically:
  - ensure client update is not required
    - **Decision (automation safety)**: if a client update is Due, log a clear “update required” reason into Session Log and abort the automation run (do not attempt pull/retrieve on an out-of-date client).
  - then pull (remote-wins strategy is already specified)
  - then retrieve
  - then commit + push if changes exist
- Record a structured plan summary into Session Log at start so it is auditable.

Clarifications (current implementation):

- The pull step in `retrieveall` uses `pullLatestRemoteWins` (same semantics as dashboard auto-pull).
- The “commit” step is an actual **commit + push** via `gitService.commitAndPushFiles`, and it is conditional:
  - if there are no committable changes after retrieve, commit/push is skipped
  - if remote becomes ahead during commit, the automation performs one extra remote-wins pull and retries once

### 9.4 Force replace on pull (remote “force” flag + 10s countdown)

There is an additional, separate “nudge-like” flow that can appear during **git pull**:

- Certain derived-data files (currently **parameter** and **case** files, excluding index files) may carry a remote field `force_replace_at_ms`.
- If the local file is **dirty** and the remote `force_replace_at_ms` is newer than the local one, a pull may require a **one-shot force replace decision**:
  - **Interactive pull (“Pull All Latest”)**: a modal appears with a **10 second countdown**; if the user does nothing the default is **auto-OK** (overwrite local with remote; skip merge).
  - **Headless/unattended pull (dashboard mode / `pullLatestRemoteWins` used by automation)**: the system **auto-OKs immediately** (no modal), logs the decision, and continues.

Related clarification:

- **Normal interactive pull is not “remote wins” globally**. Outside unattended/automation contexts, we still do 3-way merges and surface conflicts for user resolution; only the explicit force-replace subset is “remote wins” (when confirmed/auto-confirmed).

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

### 9.5 Share mode (static / live)

Share mode policies should prioritise safety:

- Static share (isolated DB, often read-only): git pull and retrieve operations should typically be Not applicable or Blocked.
- Live share: git pull may be allowed, but commit is not.
  - **Decision (Option B)**: retrieve is **allowed** in live share, but it must be **local-only**:
    - it may write updated derived-data files into the local store (e.g. IndexedDB) so the app can function
    - it must **not** commit or push (and should not present any UI that implies it will)
    - it must be **non-automated**:
      - the nudging system must not auto-run retrieve in share contexts
      - retrieve in share is user-initiated only (or explicitly triggered by a dedicated share workflow, if one exists)
    - the plan must label this explicitly as “retrieve (local-only; not committed)”
    - Session Log must include a clear audit entry that retrieve ran in “local-only share” mode
  - **Definition**: “does not persist to git” means **no commit/push** and **no attempt** to mutate the remote repository; local state may still change to support interactive use.

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

### 10.1.3 Concrete write-site inventory + tracing checklist (COMPLETED)

This section is the “Phase‑0 safety inventory” deliverable: every persisted value that can influence nudging decisions is listed here with its **owner**, **scope**, and **audit trail**.

#### 10.1.3.1 Write-site inventory table (concrete)

| Category | Key / field | Scope | Storage | Write owner (single path) | Primary reads | Session Log audit |
|---|---|---|---|---|---|---|
| Client update | `dagnet:staleness:lastAppVersionCheckAtMs` | Global | localStorage | `stalenessNudgeService.markRemoteAppVersionChecked()` (via `refreshRemoteAppVersionIfDue`) | `stalenessNudgeService.shouldCheckRemoteAppVersion()` | `STALENESS_APP_VERSION_CHECK_STAMP` |
| Client update | `dagnet:staleness:lastSeenRemoteAppVersion` | Global | localStorage | `stalenessNudgeService.cacheRemoteAppVersion()` | `stalenessNudgeService.getCachedRemoteAppVersion()`, `isRemoteAppVersionNewerThanLocal()` | `STALENESS_APP_VERSION_CACHE_SET` |
| Client update | `dagnet:staleness:lastAutoReloadedRemoteAppVersion` | Global | localStorage | `stalenessNudgeService.recordAutoReloadedForRemoteVersion()` | `stalenessNudgeService.getLastAutoReloadedRemoteAppVersion()` | `STALENESS_APP_AUTO_RELOAD_GUARD_SET` |
| Git (workspace) | `dagnet:staleness:lastRemoteCheckAtMs:${repo}-${branch}` | Repo/branch | localStorage | `stalenessNudgeService.markRemoteHeadChecked()` | `stalenessNudgeService.shouldCheckRemoteHead()` | `GIT_REMOTE_HEAD_CHECK_STAMP` |
| Git (workspace) | `dagnet:staleness:dismissedRemoteSha:${repo}-${branch}` | Repo/branch | localStorage | `stalenessNudgeService.dismissRemoteSha()` / `clearDismissedRemoteSha()` | `stalenessNudgeService.isRemoteShaDismissed()` | `STALENESS_REMOTE_SHA_DISMISS`, `STALENESS_REMOTE_SHA_CLEAR` |
| Git (share-live) | `dagnet:share:staleness:lastRemoteCheckAtMs:${repo}-${branch}-${graph}` | Repo/branch/graph | localStorage | `stalenessNudgeService.markShareRemoteHeadChecked()` | `stalenessNudgeService.shouldCheckShareRemoteHead()` | `GIT_SHARE_REMOTE_HEAD_CHECK_STAMP` |
| Git (share-live) | `dagnet:share:staleness:lastSeenRemoteHeadSha:${repo}-${branch}-${graph}` | Repo/branch/graph | localStorage | `stalenessNudgeService.recordShareLastSeenRemoteHeadSha()` | `stalenessNudgeService.getShareLastSeenRemoteHeadSha()` | `GIT_SHARE_LAST_SEEN_HEAD_SET` |
| Git (share-live) | `dagnet:share:staleness:dismissedRemoteSha:${repo}-${branch}-${graph}` | Repo/branch/graph | localStorage | `stalenessNudgeService.dismissShareRemoteSha()` / `clearShareDismissedRemoteSha()` | `stalenessNudgeService.isShareRemoteShaDismissed()` | `STALENESS_SHARE_REMOTE_SHA_DISMISS`, `STALENESS_SHARE_REMOTE_SHA_CLEAR` |
| Prompt throttling | `dagnet:staleness:lastPromptedAtMs:${kind}` | Global (per kind) | localStorage | `stalenessNudgeService.markPrompted()` | `stalenessNudgeService.canPrompt()` | `STALENESS_PROMPTED_STAMP` |
| Snooze throttling | `dagnet:staleness:snoozedUntilMs:${kind}:${scopeKey}` | Scoped | localStorage | `stalenessNudgeService.snooze()` | `stalenessNudgeService.isSnoozed()` | `STALENESS_SNOOZE_SET` |
| Pending UI plan | `dagnet:staleness:pendingPlan` | Global | localStorage | `stalenessNudgeService.setPendingPlan()` / `clearPendingPlan()` | `stalenessNudgeService.getPendingPlan()` | `STALENESS_PENDING_PLAN_SET`, `STALENESS_PENDING_PLAN_CLEAR` |
| Automatic-mode flag | `dagnet:staleness:automaticMode` | Global | localStorage | `stalenessNudgeService.setAutomaticMode()` / `clearVolatileFlags()` | `stalenessNudgeService.getAutomaticMode()` | `STALENESS_AUTOMATIC_MODE_SET`, `STALENESS_VOLATILE_FLAGS_CLEAR` |
| Retrieve freshness | `graph.metadata.last_retrieve_all_slices_success_at_ms` | Entity (graph) | Graph file (git‑tracked) | `retrieveAllSlicesService` stamps marker on success | `stalenessNudgeService.getRetrieveAllSlicesStalenessStatus()` | `RETRIEVE_MARKER_STAMPED` (child entry on retrieve op) |
| Retrieve freshness | `parameter.values[*].data_source.retrieved_at` | Entity (parameter) | Parameter file (git‑tracked) | `dataOperationsService` writes retrieval provenance during fetch | `stalenessNudgeService.getRetrieveAllSlicesStalenessStatus()` | Covered by Retrieve All op detail; keep per‑item logs + DAS failure details |
| Force replace | `parameter.force_replace_at_ms` | Entity (parameter) | Parameter file (git‑tracked) | Written externally (remote flag), read by pull flow | `workspaceService` pull/force‑replace detection | Surfaced via force-replace modal + countdown logs |

Notes:
- `retrieved_at` values are currently ISO strings; they are treated as machine timestamps and are not shown directly to users without formatting.
- Workspace “last synced” timestamps live in IndexedDB workspace metadata and are treated as authoritative for “pull last done”; this doc focuses on nudging‑decision writes (not all workspace persistence).

#### 10.1.3.2 Tracing checklist (what to verify when changing nudging semantics)

For each row above, confirm:
- **Single owner**: there is exactly one service method responsible for writing it (or it is explicitly “external input” like `force_replace_at_ms`).
- **Correct scoping**: global vs `repo-branch` vs `repo-branch-graph` vs entity is consistent with the decision that reads it.
- **Session Log audit exists**: start/end/child entries carry enough metadata to reconstruct *why* the value changed.
- **Tests cover it**: at least one existing suite asserts the write and the audit emission for the key/field.

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
  - **Decision**: do **not** hard-block retrieve purely because git pull is unknown. It is plausible (even if uncommon) that a machine can retrieve from an external data source but cannot pull/push git. In that case, retrieve should be allowed, but must be clearly labelled as "retrieve without pull" and must not attempt any git operations.

- **Live chart dependency model**:
  - Do charts always depend on a single graph today, or do we need to support multi-graph charts now?

  - **Decision**: a chart always derives from a **single graph**. If the chart is pinned, it may rely on its own query DSL (distinct from the currently active graph tab DSL), and its retrieve freshness must be computed against that chart’s effective DSL.

- **Unattended retrieve policy**:
  - In dashboard mode, should retrieve auto-run by default, or only after explicit opt-in?
  - **Decision**: retrieve should **not** auto-run in dashboard/kiosk unattended contexts because it risks a thundering herd if the scheduler fails (multiple kiosks would separately hit upstream providers). The only exception is explicit automation via `retrieveall` mode.

- **Staleness semantics for retrieve**:
  - Today’s retrieve nudge uses a simple 24h threshold.
  - Longer-term, we may want maturity-based staleness (see lag planner docs), but this redesign does not change those semantics; it only makes the nudging pipeline coherent.
  - **Decision**: keep a single constant value for now (current: **24h**). Longer-term, we may introduce per-graph/per-scope policy, but this redesign keeps the semantics stable and focuses on robustness.

---

## 14. Summary

This redesign makes nudging:

- deterministic via an explicit cascade (update → pull → retrieve),
- scope-aware (global vs per repo/branch vs per graph/chart),
- mode-aware (interactive vs dashboard vs automation vs share),
- and testable under real multi-client drift.

The next step is to confirm the remaining policy details (notably share-mode capabilities and any intentionally allowed “retrieve without pull” situations) before implementing the service refactor.


---

## 15. Countdown and Unattended Operation UX (Consolidation)

DagNet currently has several independently implemented countdowns and “settling” delays:

- **Automation start delay**: ~30s delay before `retrieveall` automation begins (good; prevents fighting early init/layout).
- **Staleness nudge countdown**: ~30s countdown used for unattended-ish refresh flows (currently used around auto-pull behaviour).
- **Force replace on pull**: 10s countdown modal that defaults to auto-OK (overwrite local with remote) if the user does nothing.

This sprawl risks inconsistent behaviour and duplicated logic. We should centralise and generalise all “automated operation” countdown behaviour.

### 15.1 Two UI expressions for countdowns

All countdowns should have two presentation modes:

- **Normal use**: show countdown in a **modal**.
  - User is present; affordances should be clear and explicit.
  - Default action may still exist, but should never feel surprising.

- **Unattended mode** (dashboard mode, automation runs): show countdown in a **top banner**.
  - User is not expected to be present, but can cancel if they are.
  - The banner should be non-blocking and should not require interaction to proceed.

### 15.2 Centralised countdown policy

Introduce a single policy surface that defines:

- **Durations** (constants, with rationale):
  - automation “settle” delay (currently 30s)
  - staleness auto-pull countdown (currently 30s)
  - force-replace-on-pull default countdown (currently 10s)

- **Default action** when the timer elapses (per operation):
  - force-replace: default OK (auto-apply) supports unattended convergence.
  - auto-pull: default proceed makes sense in unattended contexts, but must be cancellable.
  - automation start delay: default proceed, but abortable via automation stop control.

- **Cancel semantics**:
  - Cancel should be safe and should result in a stable system state (no partial side effects).
  - Cancel must be logged (Session Log) so unattended runs are auditable.

### 15.3 Centralised orchestration and UI surface

To avoid timer sprawl, define a single “Automated Operation Behaviour Pattern”:

- A central service owns:
  - starting a countdown with metadata (operation type, scope/entity, default action, duration)
  - cancellation and completion
  - Session Log audit entries

- A single UI surface renders the current countdown:
  - in **modal** form when in normal interactive contexts
  - in **banner** form when in unattended contexts

The nudging plan service should request countdowns (as part of executing a plan), rather than implementing independent timers.

### 15.4 Interaction with `retrieveall` mode

In `retrieveall` automation:

- Countdown UX must render as **banner**, never modal.
- The 30s “start delay” should be treated as the same pattern:
  - show a banner “Starting automation in Ns (Cancel)”
  - allow cancellation via automation controls
  - log countdown start and cancellation/completion to Session Log

### 15.5 Testing requirements for countdown consolidation

Add coverage that proves:

- Countdown durations and defaults come from one policy source (no duplicated timers).
- Normal vs unattended UI switching works deterministically:
  - normal → modal
  - unattended → banner
- Default actions fire on expiry and are logged.
- Cancel prevents the action and is logged.

---


## 16. Testing Coverage and Strategy (Detailed)

This section is intentionally specific about what to test, where tests should live, and how to model cross-client interdependencies without creating slow or flaky suites.

### 16.1 Principles for this test surface

- **Prefer service-level tests over UI tests** for decision correctness.
  - The plan engine should be testable without rendering React.
- **UI tests verify wiring, not semantics**:
  - the modal/banner renders the plan correctly
  - user interactions call the correct service entry points
  - countdown rendering switches modes correctly
- **Model multi-client drift explicitly**:
  - do not rely on “real” localStorage/IndexedDB state bleeding across tests
  - use isolated in-memory storages per logical client
- **No global-suite scans**:
  - tests should be runnable by explicit file path (Vitest `--run path/to/test.ts`).
- **Avoid time-flakiness**:
  - use fake timers for countdown logic and for “now” computations
  - keep all “now” values injectable into services
- **Audit writes**:
  - every persisted key/field used by plan computation must have a corresponding test that proves it is written by the consolidated path and is scope-keyed correctly.

### 16.2 Test suite map (where each concern belongs)

Add/extend tests in these existing locations (avoid new test files unless there is no sensible home):

- **Plan computation and invariants (service-level)**:
  - `graph-editor/src/services/__tests__/stalenessNudgeService.test.ts`
  - If the plan engine is split into a new service file, extend the nearest existing suite in `graph-editor/src/services/__tests__/`.

- **Hook/UI wiring (React-level)**:
  - `graph-editor/src/hooks/__tests__/useStalenessNudges.test.tsx`
  - `graph-editor/src/hooks/__tests__/useURLDailyRetrieveAll.test.ts`

- **Automation pipeline correctness**:
  - `graph-editor/src/services/__tests__/dailyRetrieveAllAutomationService.test.ts`

- **Force-replace-on-pull detection and behaviour**:
  - `graph-editor/src/services/__tests__/workspaceService.integration.test.ts`
  - If we add a pull-all hook test, it should live under `graph-editor/src/hooks/__tests__/` and remain focused.

### 16.3 Plan computation test matrix (what to cover)

For a single target entity (graph tab) under a single repo/branch scope, cover combinations of:

- **Client update signal**
  - remote deployed version newer than local
  - remote equal to local
  - remote older than local (staged rollout)
  - remote unknown (fetch not yet performed / offline)

- **Git scope signal**
  - remote ahead
  - remote equal
  - remote unknown (missing credentials, network error, or not yet checked)

- **Retrieve freshness inputs**
  - graph marker fresh (within 24h)
  - graph marker stale (older than 24h)
  - per-parameter retrieved_at present and fresh
  - per-parameter retrieved_at present and stale
  - no retrieved_at timestamps present (brand new / never retrieved)

Assertions per combination:

- **Cascade status**
  - update due blocks downstream
  - if update not due, pull due blocks retrieve
  - retrieve due only when:
    - update not due, and
    - pull not due, and
    - retrieve freshness is stale by policy
- **Unknown handling**
  - unknown does not silently become due
  - retrieve may be allowed when git is unknown (per §13 decision), but must be labelled clearly in the plan as “retrieve without pull” and must not schedule any git operations
- **Reason strings and context**
  - every due/blocked/unknown state must carry a reason suitable for Session Log

### 16.4 Multi-entity and scoped-global behaviour tests

These tests must prove that pull is “scoped-global” and invalidates downstream decisions for many entities.

Scenarios:

- **Two graph tabs open in the same repo/branch**
  - remote ahead → pull due for the scope
  - both entities’ plans show pull due (or show retrieve blocked by pull)
  - after a simulated pull completes, both plans recompute to reflect new scope state

- **One chart entity and one graph entity**
  - chart derives from a single graph but may use its own pinned DSL
  - plan for the chart uses the chart’s effective DSL for retrieve freshness inputs
  - pull due blocks chart retrieve the same way it blocks graph retrieve (scope is shared)

### 16.5 Mode-specific behaviour tests (interactive vs dashboard vs automation vs share)

#### Interactive mode

Verify:

- the modal renders the plan steps and statuses correctly
- default checkbox selection matches the cascade (update > pull > retrieve)
- clicking “Run selected” calls only the allowed service entry points in the correct order
- retrieve is never executed automatically without user confirmation

#### Dashboard / unattended mode

Verify:

- update due triggers auto-reload behaviour with appropriate loop guards
- pull due uses countdown behaviour rendered as banner, and is cancellable
- retrieve due does not auto-run (per §13 decision); it should surface as a banner/plan item only

#### `retrieveall` automation mode

Verify:

- no nudging modal appears
- the 30s start delay is driven by the central countdown mechanism and renders as banner
- the pipeline ordering is deterministic (pull → retrieve → commit)
- force-replace-on-pull never blocks on UI and is auto-OK
- cancellation (automation stop) prevents the next step and logs an audit entry

#### Share mode (static / live)

Verify:

- the plan correctly reflects capabilities (read-only constraints)
- blocked actions are labelled as such (not silently hidden)
- share-live scope uses scope-keyed remote-ahead tracking distinct from workspace tracking

### 16.6 Countdown consolidation tests (single mechanism, two UI expressions)

For each countdown-bearing operation (automation start delay, auto-pull countdown, force-replace countdown), verify:

- **Single source of duration**: duration comes from the consolidated policy (not duplicated constants scattered across hooks).
- **Presentation mode switch**:
  - interactive → modal
  - unattended → banner
- **Expiry semantics**:
  - expiry triggers the configured default action
  - expiry is logged to Session Log with operation type and scope/entity
- **Cancel semantics**:
  - cancel prevents the default action
  - cancel is logged to Session Log with operation type and scope/entity

### 16.7 Force-replace-on-pull tests (10s modal + unattended auto-OK)

There are two distinct correctness surfaces:

- **Detection (service-level)**:
  - `workspaceService` correctly emits force-replace requests only when:
    - the local file is dirty, and
    - remote `force_replace_at_ms` is present and newer than local
  - apply mode overwrites and clears dirty state for allowed file IDs, and does not 3-way merge those files

- **Interactive confirmation (hook/UI-level)**:
  - the modal countdown defaults to OK at 0 seconds
  - the user can explicitly cancel (merge normally)
  - the final choice is logged to Session Log

- **Automation path**:
  - headless pulls auto-OK immediately and log the decision

### 16.8 Audit/write-site assurance tests

For every persisted value that affects plan computation, add tests that prove:

- it is written only via the consolidated service path
- it is scoped correctly (global vs repo/branch vs entity)
- it is accompanied by Session Log audit entries where appropriate

Minimum list to cover:

- deployed version cache and its “last checked” timestamp
- auto-reload guard for deployed version (avoid loops)
- remote-ahead “last checked” timestamps per repo/branch and per share-live scope
- graph marker stamping for retrieve success
- per-parameter retrieved_at updates (as observed via files loaded into IndexedDB after pull/commit)
- snooze/dismiss state keys and their scoping rules

### 16.9 Performance and flake control

Guardrails:

- Keep plan computation tests pure and fast (no network, no real IndexedDB; use mocks/in-memory).
- Keep UI tests minimal:
  - render only enough to assert correct wiring and display
  - avoid expensive end-to-end graph loading unless the scenario cannot be represented otherwise
- Use fake timers for all countdown-related tests; never sleep real time.
- Ensure all tests are runnable by explicit file paths, and document those file paths in the implementation plan during rollout.


---

## 17. Detailed Implementation Plan (Prose)

This plan is intentionally prose-only. It describes what to change and what to test, without code snippets.

### 17.1 Implementation principles and invariants (must hold throughout)

- **Single source of truth**: all nudging decisions come from one central service. Hooks and UI components are access points only.
- **Deterministic cascade**: update → pull → retrieve, with explicit statuses: due / blocked / unknown / not due.
- **Scope correctness**:
  - Client update is global.
  - Git pull is scoped-global per repo/branch (one pull affects all open entities in that scope).
  - Retrieve freshness is per entity (graph tab or live chart tab), and must never be treated as global.
- **Safety**:
  - Retrieve All must **never auto-run** outside explicit `retrieveall` automation mode.
  - In unattended contexts, default actions are allowed only for safe operations (e.g. pull countdown, force-replace default OK), and must be cancellable and logged.
- **Auditability**: any write that affects future plan computation must be accompanied by Session Log entries with scope, reason, and the affected key(s)/field(s).
- **No duplicate countdown logic**: countdown behaviour is centralised and rendered via a single UI surface in modal or banner form.

### 17.2 Phase 0 – Baseline trace and inventory (no behaviour change)

Goal: enumerate all existing decision and write sites so we can migrate safely without missing hidden coupling.

- **Create a write-site inventory table** in this doc (or a sibling appendix) listing:
  - client update caching keys (localStorage): deployed version, last checked time, auto-reload guards
  - remote-ahead tracking keys (workspace vs share-live scope) and where they are read/written
  - retrieve freshness writes: graph marker, per-parameter retrieved_at stamping, and any other “last done” sources
  - prompt cadence keys: last prompted, snooze windows, dismiss markers
  - countdown state currently held in hooks (staleness countdown, pull force-replace countdown, automation start delay)
- **Trace all entry points** that currently trigger these operations:
  - staleness modal flow (focus/visibility and other triggers)
  - menubar “update available” badge and reload trigger
  - Pull All Latest UI paths
  - automation `retrieveall` queue and daily automation service
  - any share-live refresh mechanisms

Deliverable: a complete inventory that can be used as an implementation checklist during migration.

Testing deliverables (Phase 0):

- Extend existing tests only to the extent needed to support later phases:
  - Add or update minimal “harness” helpers (in existing test files) for:
    - isolated in-memory storage per logical client
    - deterministic “now” injection and fake-timer usage conventions
  - Do not change behaviour yet; these are scaffolding changes to prevent flakiness later.

### 17.3 Phase 1 – Introduce plan computation (service-only, no UI wiring yet)

Goal: create a central “plan” computation API that expresses what is due/blocked/unknown/not due for a target entity.

- **Create or extend a central service**:
  - Preferred: evolve `graph-editor/src/services/stalenessNudgeService.ts` into the single “nudging plan service”.
  - If the file becomes too large, split into a new service file, but keep a single exported public API and delete old paths (no parallel logic).
- **Define a plan model** that includes:
  - global client update step (local version, cached deployed version, status, reason)
  - scoped-global git step (repo/branch or share-live scope, remote-ahead status, reason)
  - entity retrieve step (graph/tab or chart entity, freshness inputs, status, reason)
  - explicit dependency links (blocked-by), and a structured explanation suitable for Session Log
- **Explicitly encode the policy decisions from §13**:
  - retrieve is allowed even if git is unknown (machine can retrieve without git), but must be clearly indicated and must not attempt git operations
  - charts derive from a single graph, but may use their own pinned DSL for freshness computation
  - retrieve never auto-runs outside `retrieveall` mode
  - retrieve staleness uses a constant 24h threshold for now
- **Add a pure “plan computation” test suite**:
  - Extend `graph-editor/src/services/__tests__/stalenessNudgeService.test.ts` (or the most appropriate existing suite) to include a matrix of states:
    - remote client newer / equal / older / unknown
    - remote git ahead / equal / unknown
    - retrieve marker fresh / stale; parameter timestamps fresh / stale / missing
  - Add multi-entity tests:
    - two graph entities in same repo/branch: ensure the plan reflects scoped-global nature of pull
    - chart entity with pinned DSL: ensure the plan records the chart’s effective DSL separately from the graph tab

Testing gates (Phase 1):

- The plan matrix tests must cover:
  - staged rollout case (remote deployed version older than local)
  - git unknown case where retrieve remains *allowed* but explicitly labelled “retrieve without pull”
  - retrieve freshness precedence (marker vs per-parameter retrieved_at) and correct “Last” derivation
- The multi-entity tests must demonstrate scoped-global pull invalidation across two entities in the same repo/branch.

Success criteria: plan computation is deterministic and tested, but nothing user-facing changes yet.

### 17.4 Phase 2 – Centralise execution (service executes plans; hooks/UI only call into service)

Goal: eliminate duplicated business logic in hooks and ensure all entry points go through the same execution path.

- **Add a plan execution API** to the central service:
  - It should accept:
    - current mode flags (interactive, dashboard, automation)
    - target entity identity (graph or chart)
    - selected actions (if interactive) or a computed default (if automation)
  - It should enforce the cascade ordering and blocked states.
- **Refactor `graph-editor/src/hooks/useStalenessNudges.ts`** to:
  - call the plan service to get the plan
  - render the modal from the plan (no bespoke logic for due-ness in the hook)
  - invoke the plan execution API when “Run selected” is clicked
- **Automation wiring**:
  - In `graph-editor/src/hooks/useURLDailyRetrieveAllQueue.ts` and `graph-editor/src/services/dailyRetrieveAllAutomationService.ts`, ensure:
    - retrieve is executed only in `retrieveall` mode (already true)
    - plan/execution service is used for countdown/banner and for structured logging (see Phase 3/4)
    - force-replace-on-pull remains auto-OK via `pullLatestRemoteWins` and emits audit logs

Testing deliverables (Phase 2):

- Extend `graph-editor/src/hooks/__tests__/useStalenessNudges.test.tsx` to verify:
  - the hook renders the plan-provided statuses (due/blocked/unknown/not due) without re-deriving them
  - clicking “Run selected” calls a single service entry point and respects cascade ordering
  - retrieve does not run without explicit user confirmation in interactive mode
- Extend `graph-editor/src/services/__tests__/dailyRetrieveAllAutomationService.test.ts` to verify:
  - automation still runs pull → retrieve → commit in order
  - force-replace-on-pull is auto-OK (no UI dependency) and emits audit log entries

Testing gates (Phase 2):

- There must be no remaining test that depends on the old hook-level decision branches; tests should assert against the new central service boundary.

Success criteria: there is one execution path for nudging decisions. The hook no longer contains business logic beyond orchestration.

### 17.5 Phase 3 – Centralise countdown/timer behaviour (modal vs banner)

Goal: remove timer sprawl and implement the “Automated Operation Behaviour Pattern”.

- **Introduce a central countdown/orchestration service** responsible for:
  - starting countdowns with metadata (operation type, scope/entity, duration, default action)
  - cancellation and completion
  - emitting Session Log entries for start/expire/cancel
- **Introduce a single UI surface** that renders countdown state in two modes:
  - modal (normal interactive contexts)
  - top banner (unattended contexts, including `retrieveall` automation mode)
- **Migrate existing countdowns to the central mechanism**:
  - automation start delay (~30s) in `useURLDailyRetrieveAllQueue`
  - staleness auto-pull countdown (~30s) in staleness nudges flow
  - force-replace-on-pull countdown (10s) in `usePullAll` interactive path
- **Consolidate durations** into a single constants module (or a single service policy object) so they are not duplicated.

Testing:
- Extend the existing test suites (prefer `useURLDailyRetrieveAll.test.ts`, `useStalenessNudges.test.tsx`, and a pull-all hook test if present) to verify:
  - the countdown starts with the configured duration
  - it renders in modal vs banner depending on mode
  - expiry triggers the correct default action
  - cancel prevents the action and logs the cancel event

Testing gates (Phase 3):

- Countdown-bearing flows must have tests that prove:
  - duration comes from a single policy source (no duplicated countdown constants)
  - interactive contexts render countdowns as modal; unattended contexts render as banner
  - expiry triggers the configured default action and logs a Session Log audit event
  - cancel prevents the default action and logs a cancellation audit event

Success criteria: there are no independent `setInterval` countdowns for these flows outside the central countdown mechanism.

### 17.6 Phase 4 – Audit hardening (ensure write sites match plan assumptions)

Goal: ensure all state that affects plan computation is written consistently, and is observable in prod via Session Log.

- For each write site identified in Phase 0, ensure:
  - it is performed only via the central service APIs (or a single clearly owned internal helper)
  - it is scope-keyed correctly (global vs repo/branch vs entity)
  - it emits Session Log entries with enough detail to debug post hoc without console logs
- Explicitly verify (and test) the following high-risk couplings:
  - deployed version cache and auto-reload guard behaviour
  - remote-ahead tracking (workspace vs share-live) and how it interacts with pull and retrieve blocking
  - retrieve marker vs per-parameter retrieved_at precedence and “Last” display correctness
  - force-replace-on-pull request detection and apply behaviour, including unattended auto-OK

Testing deliverables (Phase 4):

- Add “write site audit” assertions for every persisted value that plan computation reads:
  - deployed version cache and last-checked timestamps
  - auto-reload loop guards (per remote version)
  - remote-ahead last-checked and last-seen markers (workspace scope and share-live scope)
  - retrieve marker stamping and per-parameter retrieved_at updates
  - snooze/dismiss/prompt keys and their scoping rules
- Each audit test should prove:
  - the value is written by the consolidated service path (not UI ad-hoc code)
  - it is scoped correctly (global vs repo/branch vs entity)
  - it has a Session Log audit entry where appropriate

Testing gates (Phase 4):

- A multi-client drift scenario must be represented as a deterministic test:
  - Client A (automation) commits refresh results.
  - Client B (viewer) initially sees remote ahead and is not encouraged to retrieve before pull.
  - After simulated pull, Client B no longer shows retrieve due if freshness is within the 24h policy window.

Success criteria: the plan’s “reason” fields can be reconstructed from durable state and Session Log, even in prod.

### 17.7 Phase 5 – Delete legacy paths and tighten invariants

Goal: remove old branching logic and ensure there is no duplicate code path.

- Delete or inline obsolete helpers in hooks/services that are superseded by the plan service.
- Remove backwards-compatibility fallbacks that allow old behaviour to survive (unless explicitly required for a transitional release).
- Ensure all menu components remain access points only (no business logic).

### 17.8 Risk management and rollout strategy

- Implement behind a single internal “plan engine” switch if needed for development, but do not ship long-lived dual paths.
- Roll out in the following order:
  - plan computation + tests
  - execution path centralisation
  - countdown centralisation
  - audit hardening and cleanup
- Add Session Log events that clearly label which plan engine version produced decisions during the rollout window.

### 17.9 Acceptance criteria (what “done” means)

- The modal/banner behaviour follows the cascade deterministically.
- Pull is correctly treated as scoped-global; retrieve remains entity-local.
- Retrieve never auto-runs outside `retrieveall` automation mode.
- All countdowns are served by one central mechanism and render as modal vs banner appropriately.
- A multi-client scenario (cron machine commits; viewer has not pulled) yields:
  - pull due, retrieve blocked (or “not due” depending on chosen policy), and after pull the retrieve status updates correctly.
- Prod session logs contain enough information to debug failures without relying on console logs.

### 17.10 Implementation plan completeness note

This implementation plan is complete only if the test work is delivered alongside the code in each phase. Use §16 as a detailed reference for scenario coverage, but do not treat testing as a separate phase that can be deferred “until later”.

---

## 18. Implementation Status Checklist (as of 21-Jan-26)

This section is an explicit forensic mapping of **each design element** in this document to the current codebase, and marks it **DONE** only when it is wholly implemented (including tests where required).

### 18.1 Status legend

- **DONE**: implemented end-to-end, including relevant tests, and no known duplicate paths remain.
- **PARTIAL**: some parts implemented, but at least one requirement or invariant in this section is still missing.
- **NOT DONE**: not implemented (or implemented in a way that contradicts the design).
- **N/A**: informational/design context only (no direct implementation work required).

### 18.2 Section-by-section status

- **§1 Problem Statement**: **N/A**
- **§2 Goals**: **DONE**
- **§3 Non-Goals**: **N/A**
- **§4 Concepts and Scopes**: **DONE**
- **§5 First-Principles Decision Cascade**: **DONE**
  - Cascade is enforced strictly: update due blocks pull/retrieve; pull due blocks retrieve; retrieve is never pre-selected.
- **§6 Proposed Architecture**: **DONE**
  - A central plan + orchestration API exists in `stalenessNudgeService`.
  - `useStalenessNudges` is a thin adapter: signal gathering + execution are delegated into the service (no duplicated logic in the hook).
- **§7 Data Sources and Invariants**: **DONE**
  - **Client version (global)**: **DONE** for staged-rollout messaging and cached remote version behaviour.
  - **Git freshness (scoped)**: **DONE** for workspace vs share-live remote-ahead checks and “remote ahead blocks retrieve”.
  - **Retrieve freshness (entity-local)**: **DONE** for marker vs per-parameter precedence and correct “Last” derivation.
- **§8 Multi-Target Reality: Graph Tabs vs Live Charts**: **DONE**
  - Chart identity is represented in the plan model.
  - Chart retrieve freshness is computed against the **parent graph** plus the chart’s effective DSL (slice filtering).
- **§9 Mode-Specific Policy**: **DONE**
  - **Interactive**: **DONE** (retrieve is never auto-run; retrieve is never pre-selected).
  - **Dashboard / unattended**: **DONE**
    - Auto-pull countdown exists and uses remote-wins in dashboard mode.
    - Retrieve does not auto-run (as decided).
    - A single coordinated banner surface exists (central banner manager + host; no ad-hoc per-hook stacking).
  - **Automation (`retrieveall`)**: **DONE**
    - Pull (remote-wins) → Retrieve All (headless) → Commit is implemented.
    - Automation aborts (with Session Log reason) when client update is due.
  - **Force replace on pull**: **DONE** for countdown consolidation and unattended auto-OK behaviour.
  - **Share mode (Option B)**: **DONE**
    - Retrieve remains permitted but non-automated; no automated git commit/push is attempted in share/static flows (verified by inspection).
- **§10 Rate-Limiting and Nudging Policy**: **DONE**
  - 24h threshold remains constant (as decided).
  - “Unknown must not silently become Due” is respected by plan statuses.
- **§10.1 Auditability: where flags and timestamps are written**: **DONE**
  - Write-site inventory + tracing checklist are completed (§10.1.3).
- **§11 Testing Strategy (First-Principles)**: **DONE**
  - Plan matrix tests exist for update/pull/retrieve combinations and git-unknown override.
  - Multi-client drift is represented deterministically for graphs.
  - Chart entity coverage exists (service-level slice filtering + hook wiring test).
- **§12 Migration / Refactor Plan (High Level)**: **DONE**
  - Execution, countdown consolidation, and banner consolidation are implemented.
- **§13 Open Questions / Decisions Needed**: **PARTIAL**
  - Git-unknown “retrieve without pull” override: **DONE**
  - No auto-retrieve in unattended contexts (except explicit `retrieveall`): **DONE**
  - 24h constant policy: **DONE**
  - Chart pinned DSL semantics (freshness computation) : **DONE**
- **§14 Summary**: **N/A**
- **§15 Countdown and Unattended Operation UX (Consolidation)**: **DONE**
  - Countdown mechanism is shared (no bespoke countdown `setInterval` for the nudging flows).
  - Centralised Session Log audit events exist for countdown start/cancel/expiry (via countdown primitive).
  - Unattended banner presentation is a first-class UI surface (shared `CountdownBanner` used by automation and share-live refresh).
- **§16 Testing Coverage and Strategy (Detailed)**: **DONE**
  - Countdown and force-replace tests exist.
  - Plan computation + orchestration tests exist for the cascade and key edge cases (including chart DSL staleness).
- **§17 Detailed Implementation Plan (Prose)**: **DONE**
  - Implemented end-to-end; this section is now historical record.
- **§17.9 Acceptance criteria**: **DONE**
  - Retrieve is not auto-run outside `retrieveall`: **DONE**
  - Pull is scoped-global vs retrieve entity-local: **DONE** for graphs and charts
  - Prod session logs are materially improved for nudging-related state: **DONE**

### 18.3 Residual / remedial work (must be implemented to claim “fully done”)

- **None (as of 21-Jan-26).**

---

## 19. Remaining implementation items (as of 21-Jan-26)

- **None.** §18.2 and §18.3 have been updated to reflect the current, fully-implemented state.

