# 63 — Investigation Tracker MCP Spec

**Date**: 22-Apr-26  
**Status**: Proposed  
**Audience**: engineers implementing Bayes diagnostic tooling and agents
running regression / defect-isolation work  
**Primary references**: `20-open-issues-register.md`,
`44-synth-model-test-plan.md`,
`../codebase/BAYES_REGRESSION_TOOLING.md`,
`../codebase/AGENT_VERIFICATION_GAP.md`

## 1. What this is

This is a spec for a **tiny investigation tracker with an MCP surface**.

It is not a generic issue tracker. It is not Jira, Linear, or a project
management system. Its job is much narrower:

- keep the reason for each diagnostic run attached to the run
- stop agents treating blocked runs as valid model evidence
- keep the current defect state and next step queryable in a structured
  way
- render a human-readable summary back into
  `20-open-issues-register.md`

The target use-case is the current Bayes sparse-graph investigation, but
the design should also cover similar defect-isolation work in future.

## 2. Problem statement

The current workflow is too easy for agents to mishandle:

1. a run is launched
2. the reason for the run lives mostly in chat or in the operator's head
3. the result comes back hours later as logs and JSON
4. the agent re-interprets the result without a hard record of what the
   run was actually meant to establish
5. broken or blocked runs are analysed as if they had answered the
   intended statistical question

Markdown alone is not enough. It is useful for humans, but it is too easy
for agents to read it partially, mis-sequence it, or fail to keep the run
context up to date.

What is missing is a small structured system that answers, at any moment:

- what are the open defects?
- what run are we about to execute?
- why does that run exist?
- what is it allowed to prove?
- which runs are blocked?
- what is the next action on the current investigation line?

## 3. Decision summary

Build a local-first investigation tracker with three parts:

1. a **structured source of truth** stored next to the current register
2. an **MCP surface** for agents
3. a **rendered markdown summary** in
   `20-open-issues-register.md`

The structured source of truth should live alongside the existing human
register, not in some unrelated location.

### Canonical files

- `docs/current/project-bayes/20-open-issues-register.tracker.yaml`
  — canonical structured state
- `docs/current/project-bayes/20-open-issues-register.md`
  — rendered human-facing view plus any retained narrative sections the
  renderer supports

The YAML file is the source of truth. The markdown file is the human view.

## 4. Goals

The tracker must:

1. require a short reason for every non-trivial run
2. record what that run is intended to prove
3. record what that run is **not** intended to prove
4. force a blocked-versus-answered distinction for returned runs
5. make blocker defects easy to list
6. make the next planned run easy to query
7. link runs and defects directly
8. keep the tracker state inspectable in git
9. be small enough that agents actually use it

## 5. Non-goals

The tracker must not become:

- a generic project-management platform
- a comment thread system
- a ticket assignment / sprint / epic hierarchy
- a second copy of chat history
- a replacement for regression JSON or harness logs
- a broad UI project

The system should stay narrow. If a field is not helping an agent decide
what to run next or how to interpret a returned run, it probably does not
belong here.

## 6. Core model

The tracker only needs three first-class objects:

- the **current line**
- **issues**
- **runs**

No additional abstractions are required.

### 6.1 Current line

The current line is the active investigation focus.

Required fields:

- label
- priority
- blocker_focus
- next_run_goal
- active_run_id (optional)

Purpose:

- gives the agent one current thread to pull on
- avoids scanning the whole register to infer today's priority

### 6.2 Issue

An issue is a defect or significant investigation question.

Required fields:

- id
- title
- state
- severity
- summary
- next_action
- related_run_ids

Optional fields:

- evidence notes
- hypotheses
- diagnosis
- design
- implementation
- verification

The issue model should be compatible with the existing register language
so the rendered markdown can preserve the current human-readable shape.

### 6.3 Run

A run is one concrete execution that asks one concrete question.

Required fields:

- id
- title
- status
- date
- command_or_plan
- related_issue_ids
- why_this_run_exists
- intended_to_prove
- does_not_prove
- blocker_check_first
- outcome_summary
- next_action

Optional fields:

- result_json_path
- harness_log_paths
- plan_name
- plan_overrides
- operator
- started_at
- finished_at
- blocker_category

The run model is the critical part of the design. It is the thing that
prevents a result from becoming detached from its reason.

### 6.4 Field schema

The YAML schema is concrete. Unknown keys are rejected on load so the
file does not silently accept drift.

**IDs.** Use the existing register convention:

- issues: `I-NNN` (zero-padded three-digit serial)
- runs: `R-NNN` (zero-padded three-digit serial)

IDs are assigned by the tracker, not supplied by the caller.

**Current line**:

| Field | Type | Required | Notes |
|---|---|---|---|
| `label` | string | yes | active investigation focus |
| `priority` | string | yes | one line |
| `blocker_focus` | string | yes | what is currently blocking progress |
| `next_run_goal` | string | yes | what the next run must establish |
| `active_run_id` | `R-NNN` | no | present while a run is `running` |

**Issue**:

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | `I-NNN` | yes | assigned |
| `title` | string | yes | ≤120 chars |
| `state` | enum | yes | values in §7.1 |
| `severity` | enum | yes | `blocker` \| `quality` \| `paper-cut` |
| `summary` | string | yes | one paragraph |
| `next_action` | string | yes | one line |
| `related_run_ids` | list[`R-NNN`] | yes | may be empty |
| `updated` | date (`d-MMM-yy`) | yes | |
| `owner` | string | no | defaults to `unclaimed` |
| `evidence` | list[string] | no | free-form observations |
| `hypotheses` | list[object] | no | `{label, state, text, falsified_by?, supporting?}` |
| `diagnosis` | string | no | required when state ≥ diagnosed |
| `design` | string | no | required when state ≥ designed |
| `implementation` | string | no | required when state ≥ implemented |
| `verification` | string | no | required when state ∈ {verified, resolved} |

**Run**:

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | `R-NNN` | yes | assigned |
| `title` | string | yes | ≤120 chars |
| `status` | enum | yes | values in §7.2 |
| `date` | date (`d-MMM-yy`) | yes | creation date |
| `command_or_plan` | string | yes | exact command or plan name |
| `related_issue_ids` | list[`I-NNN`] | yes | may be empty |
| `why_this_run_exists` | string | yes | one paragraph |
| `intended_to_prove` | string | yes | one paragraph |
| `does_not_prove` | string | yes | one paragraph |
| `blocker_check_first` | string | yes | expected blocker categories to verify |
| `outcome_summary` | string | yes | `pending` until completion |
| `next_action` | string | yes | one line |
| `result_json_path` | string | no | stamped by runner on completion |
| `harness_log_paths` | list[string] | no | |
| `plan_name` | string | no | |
| `plan_overrides` | object | no | |
| `operator` | string | no | free text |
| `started_at` | ISO-8601 | no | set by `Start run` |
| `finished_at` | ISO-8601 | no | set by `Complete run` |
| `blocker_category` | enum | conditional | required when `status = blocked`; values in §14 |

Human-editable fields use the project date format (`d-MMM-yy`). Machine
timestamps use ISO-8601. The mixture is deliberate: human fields stay
human, machine fields stay machine.

## 7. Status model

### 7.1 Issue states

The tracker should preserve the current issue-state vocabulary already in
`20-open-issues-register.md`:

- observed
- hypothesis
- rejected
- diagnosed
- designed
- implemented
- regressed
- verified
- resolved
- deferred

### 7.2 Run states

Runs need a separate, smaller state machine:

- planned
- running
- returned
- blocked
- answered
- abandoned

Key distinction:

- **blocked** means the run returned but could not legitimately answer the
  intended question
- **answered** means the run legitimately answered the intended question

This distinction is the core behavioural guardrail.

## 8. Minimal MCP surface

The MCP surface should be small and opinionated.

### 8.0 Runtime and transport

The MCP server is Python, stdio transport, single process. The code lives
in `bayes/tracker/` and runs via `python -m bayes.tracker.mcp_server`.

Rationale:

- The existing Bayes toolchain is Python; Phase 2 runner integration is
  Python. A Python server shares the run-envelope code directly.
- stdio keeps the tracker local-first and process-isolated per agent
  session, matching the private-data posture of the rest of the repo.
- A single-process server eliminates the distributed-locking surface;
  see §13 for the in-process locking model.

Client registration lives in a project-level `.mcp.json` at the repo
root. Dependencies are dev-only and belong in
`graph-editor/requirements-local.txt`, not production `requirements.txt`.

### 8.1 Required write operations

1. **Set current line**
   - updates the active investigation focus

2. **Create run**
   - requires the core run-reason fields before launch

3. **Start run**
   - marks a planned run as running and records execution metadata

4. **Complete run**
   - marks the run as blocked, answered, or abandoned
   - records short outcome and next action

5. **Upsert issue**
   - create or update an issue without forcing full-field replacement

6. **Link run and issue**
   - ensure cross-reference integrity

7. **Render register**
   - updates `20-open-issues-register.md` from the structured source

### 8.2 Required read operations

1. **Get overview**
   - current line, open blockers, next planned run

2. **Get issue**
   - full issue plus related runs

3. **List blockers**
   - all blocked runs and blocker-category summary

4. **Get next run**
   - the next planned run under the current line

5. **Get run**
   - full run context and linked issues

These operations are enough to drive the investigation loop without
forcing the agent to read a large markdown file and infer state from it.

## 9. Enforced fields

The tracker should only enforce a few things, but those things must be
hard requirements.

### 9.1 Before launch

`Create run` must require:

- `why_this_run_exists`
- `intended_to_prove`
- `does_not_prove`
- `related_issue_ids`
- `command_or_plan`

If those fields are missing, the run should not be creatable.

### 9.2 Before marking a run answered

`Complete run` with status `answered` must require:

- `outcome_summary`
- `next_action`
- explicit blocker check outcome

That blocker check should at least capture:

- completion status
- evidence-trustworthiness status
- binding/tooling status

### 9.3 Before marking a run blocked

`Complete run` with status `blocked` must require:

- blocker_category
- short blocker summary
- next action

Blocked runs are not second-class failures; they are first-class evidence
that the completion path still needs work.

## 10. Integration with Bayes run tooling

The tracker only becomes effective if it is tied to the actual run flow.

### 10.1 Required CLI integration

`regression_plans.py` and `run_regression.py` should accept a
`tracker_run_id` input.

That ID should be written into the structured results envelope for any run
launched through the tracked path.

### 10.2 Enforcement policy

Per `AGENT_VERIFICATION_GAP.md`, advisory rules do not hold under
impatience. The runner must refuse, not remind.

- `run_regression.py` and `regression_plans.py` accept
  `--tracker-run-id <id>` (Phase 2).
- When the env var `BAYES_REQUIRE_TRACKER=1` is set, both runners
  refuse to start without a `--tracker-run-id`. This is the default
  for interactive developer and agent shells (exported from
  `graph-editor/venv/bin/activate` or the session-start hook).
- `BAYES_REQUIRE_TRACKER=0` remains available for CI, param-recovery
  quick sweeps, and other non-investigation runs.

The tracker stays advisory for ad-hoc Python calls; the guardrail
lives at the CLI entry points, where the damage pattern described in
the verification-gap doc actually occurs.

A thin wrapper (`bayes/bayes-run`) that creates the tracker entry and
launches the runner in one step may be added in Phase 3 as ergonomics,
but enforcement always lives in the runners themselves.

### 10.3 Results linkage

When a tracked run finishes, the result envelope should carry:

- `tracker_run_id`
- `related_issue_ids`
- `why_this_run_exists`
- `intended_to_prove`
- `does_not_prove`

The tracker should also record the result JSON path back onto the run
entry.

This makes the run self-describing when opened later.

## 11. Rendering strategy

Rendering is one-way, with marker-fenced regions. The YAML is the source
of truth; the markdown is a generated view plus human prose that lives
outside the marker regions.

Marker format:

    <!-- tracker:current-line:start -->
    …generated content…
    <!-- tracker:current-line:end -->

The renderer owns the content inside each marker region and rewrites it
on every `Render register` call. Content outside marker regions is
preserved byte-for-byte.

Required marker regions:

- `tracker:current-line` — active investigation focus
- `tracker:run-log` — run entries in reverse-chronological order
- `tracker:issues` — issue entries grouped by state

Free-form narrative (how-to-use preamble, state-model diagram, issue
templates, cross-references to other docs) lives outside marker regions
and is never rewritten.

The renderer must never emit a partial write: render to a temp file in
the same directory, fsync, then rename. A failed render leaves the
previous markdown intact.

Round-trip editing of the rendered blocks is explicitly unsupported.
Edits inside a marker region are overwritten on the next render. Edit
the YAML.

## 12. Agent workflow

The intended agent workflow is:

1. query overview
2. inspect current blockers and next planned run
3. if no suitable planned run exists, create one with the required reason
   fields
4. start the run
5. execute the Bayes command with the returned `tracker_run_id`
6. when the result returns, complete the run as blocked or answered
7. update the linked issue if needed
8. render the markdown register

This is deliberately simple. The agent should not have to improvise the
shape of the work from prose.

## 13. Storage format

The canonical tracker file should be YAML, not SQLite.

Rationale:

- inspectable in the repo
- diffable in git
- easy to back up
- easy to recover manually if the MCP tool misbehaves
- small enough for the expected scale

Concrete locking and write model:

- Reads and writes acquire an exclusive `fcntl.flock` on the YAML file
  for the duration of the operation.
- Writes go through a temp file in the same directory, fsynced, then
  renamed over the canonical path. Partial writes cannot be observed.
- On every load, the YAML is re-validated against the schema in §6.4.
  Unknown keys, missing required fields, and enum violations raise a
  hard error — the MCP server refuses to serve reads or writes on a
  malformed file rather than silently normalising it. This tolerates
  manual edits provided they remain valid.
- The tracker is a single-process server. Multiple concurrent agent
  sessions pointing at the same YAML is an unsupported configuration.

If the tracker later outgrows YAML, migration to SQLite can happen then.
It should not be the starting point.

## 14. Blocker categories

Blocked runs should use one of a small set of categories:

- tooling
- evidence_integrity
- binding
- compile_runtime
- sampling_geometry
- external
- unknown

This is enough to answer "what sort of blocker is dominating right now?"
without introducing a large taxonomy.

## 15. Rollout

### Phase 0 — migration of existing state

Before Phase 1 begins, transcribe the current contents of
`20-open-issues-register.md` into the first tracker YAML. This is a
one-off operation performed by a throw-away script
(`bayes/tracker/scripts/seed_from_doc20.py`) kept in the repo only for
reproducibility.

The migration produces:

- one `current_line` entry reflecting the existing active-line block
- one run entry per existing `R-NNN` block with all required fields
  populated (pending entries keep `outcome_summary: pending`)
- one issue entry per existing `I-NNN` block preserving state,
  severity, and any diagnosis / design / implementation / verification
  prose

After migration, `20-open-issues-register.md` is regenerated once by
the new renderer. The resulting diff must be reviewed by a human —
anything lost in transcription belongs in the YAML, not restored by
editing the markdown.

### Phase 1 — tracker core

Build:

- YAML source of truth
- MCP read/write surface
- markdown renderer

No runner integration yet. Human users and agents can still launch the
run manually, but the tracker state becomes structured.

### Phase 2 — run linkage

Add:

- `tracker_run_id` support in `regression_plans.py` and
  `run_regression.py`
- result-envelope stamping

This is the point where run context stops drifting away from the result.

### Phase 3 — ergonomic wrapper

Add a thin supported launch path so agents use the tracked workflow by
default rather than raw commands.

## 16. Acceptance criteria

This spec is successful only if all of the following become true:

1. every non-trivial investigation run has a tracker entry before launch
2. every tracked run records why it exists and what it is meant to prove
3. agents can query the current blockers without reading markdown
4. agents can query the next planned run without reading markdown
5. a returned run can be marked blocked rather than forcing a false
   answered/not-answered binary
6. the result JSON carries enough context that it can be read later
   without consulting chat history
7. `20-open-issues-register.md` remains useful to humans but is no longer
   the sole structured control surface for agents

## 17. Why this is the minimum sensible tool

The key design constraint is restraint.

If this becomes a broad process platform, agents will choke on it just as
badly as they choke on a large markdown tracker. The point is to give them
exactly the structured state they keep failing to reconstruct:

- what is broken
- what run are we doing
- why are we doing it
- did it answer the question or get blocked
- what is next

That is the whole product.
