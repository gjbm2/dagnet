---
name: dispatch-stage
description: Load disciplined per-stage execution instructions for working through ONE stage of a multi-stage implementation plan. Use when the user is starting a session to implement a specific stage and wants strict stage-by-stage discipline (bounded scope, deliberate context budget, explicit stop conditions, briefing-receipt compliance, schema parity, no scope creep). Triggered by `/dispatch-stage <stage-id> [<plan-path>] [<companion-paths>...]` or by the user explicitly asking to "dispatch a stage agent" or "load the stage skill".
---

# Stage Dispatch

You are about to implement ONE STAGE of a multi-stage plan. The user invoked this skill because that work needs strict per-stage discipline — bounded scope, deliberate context budget, and explicit stop conditions.

## Args

The invocation should name (a) the stage identifier, (b) the path to the plan doc, and optionally (c) one or more companion doc paths. Examples:

- `/dispatch-stage 4b docs/current/project-bayes/73b-be-topo-removal-and-forecast-state-separation-plan.md`
- `/dispatch-stage 2 docs/current/<plan>.md docs/current/<companion>.md`
- `/dispatch-stage 4b` — only valid if the plan path is unambiguous from the conversation context

If the args are missing, ambiguous, or the named files do not resolve on disk, **STOP and ASK** the user before doing anything else. Do not guess the plan or the stage.

Once args are resolved, state back to the user in one line: "Dispatching stage `<id>` against `<plan-path>` (companions: `<list or none>`). Beginning session start procedure." Then proceed.

## Session start procedure (do all of this before your first edit)

1. Read the warm-start docs named in CLAUDE.md.
2. Read `.claude/context-manifest.yaml`. For every path you intend to edit during this stage, read its `required_reads`.
3. Read the plan: §1–2 (objective, decisions), the §3 layers your stage touches, your stage's section in the delivery-stages list, the acceptance criteria, the cross-doc conflicts section, the schema-change ledger rows your stage owns. **Do not preload sections owned by other stages.**
4. Read the companion doc(s) only for sections cross-referenced from your stage (typically the pack contract and the apply mapping).
5. Emit the briefing-receipt block per CLAUDE.md, then STOP. The Stop hook records it. Continue editing in your next turn.

## Treat the plan as a contract under revision

- If a referenced §/line/file does not match reality, STOP and ASK.
- If two parts of the plan contradict each other, STOP and ASK.
- If the plan and current code disagree on field shape, STOP and ASK.
- Do not invent a synthesis. Do not silently pick "what looks right".

## Invariants discipline

- In your briefing receipt, quote 3–7 load-bearing invariants from your stage's section, with §-numbers. These are the things that survive auto-compaction; treat them as your contract for the session.
- If your stage cites Decisions or Open Points as binding, list them.

## Stage execution discipline

- Use `TodoWrite` at session start to enumerate the atoms in your stage. Mark each complete as it lands; do not batch.
- **You do not run `git commit` (or any other git write).** When committing happens, and at what granularity, is the user's call. Just complete the atoms.
- For each atom, note a suggested commit message naming the §-section and any schema-row identifier (e.g. `<plan-id> stage <N>(<x>): <atom> (<row>)`) when announcing the atom is done. Do not halt to wait for a commit; carry on.
- Schema changes per the plan's schema-change procedure: JSON Schema + Pydantic + TypeScript + parity tests in lockstep. After **each row** (not at end of stage), run both:
  - `cd graph-editor && npm test -- --run schemaParityAutomated`
  - `cd graph-editor && pytest lib/tests/test_schema_parity.py`
- Tests-first per CLAUDE.md §4: any new code path requires a test BEFORE you call the work done. HARD BLOCK.
- Run only relevant tests. Never head/tail test output.

## Known baseline failures

- If the plan documents a Stage 0 / handoff baseline of pre-existing failing tests, those are owned by other stages. Do not try to fix them. Compare your delta against the documented baseline.
- Any failure NOT in that baseline is yours to triage *before* writing more code.

## Forbidden

- Running `git commit` yourself. **You recommend; the user commits.** Same for `git add`, `git stash`, `git checkout`, or any other git write.
- Backwards-compat shims, deprecated aliases, "just in case" code, legacy wrappers.
- Scope creep beyond your stage's atoms ("while I'm here").
- Mocking the database in integration tests.
- `npm run build` (per CLAUDE.md).
- Writing or proposing a handover unprompted — only `/handover` literally typed by the user triggers it.
- Pushing to remote, opening PRs, creating branches.
- Marking work done before relevant tests pass.
- Editing files outside this stage's enumerated surfaces. If your edit needs to, STOP and ASK.

## Context budget

- Aim to keep total session well under ~250–300k tokens. Briefing alone on a large plan often costs 80–120k.
- For broad codebase reconnaissance, dispatch the **Explore** subagent. Reserve inline file reads for the specific functions you will edit.
- For non-trivial implementation order inside a multi-atom stage, dispatch the **Plan** subagent before executing.
- Do not re-read whole large docs that are already in context. Re-read only the specific §-section you need.

## Say-it-out-loud moments

Write a short user-facing line, then continue:

- When you finish reading the briefing materials.
- When you start an atom.
- When you finish an atom (with the commit hash).
- When a test failure is unexpected.
- When you hit any STOP-and-ASK condition.

## When stage is done

- Walk through the plan's acceptance criteria for your stage and quote each as pass/fail.
- Confirm schema parity tests pass (if any rows landed).
- Report: what landed, which acceptance criteria are now green, which schema rows are committed, which tests ran, baseline-failure delta.
- Do **NOT** write a handover. Do **NOT** push to remote. Do **NOT** open a PR.

## Ask before acting if

- The plan references a §/file/line that does not exist or has moved.
- Two parts of the plan contradict each other.
- A test failure is not in the documented baseline.
- A schema row touches a file outside the plan's enumerated surfaces.
- A cross-doc prerequisite (companion-doc acceptance gate, etc.) is listed as required but you cannot verify it has actually passed.
- You believe the plan is wrong.
