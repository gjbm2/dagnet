---
name: implement-carefully
description: Self-administering stage runner for multi-stage implementation plans. Picks the first incomplete stage from the plan's progress section, executes it with strict discipline (briefing receipt, atoms, commits, tests, schema parity), records completion in the plan, and returns control. Use when the user wants to advance a plan one stage at a time without manually specifying which stage. Triggered by `/implement-carefully <plan-path>`, `/implement-carefully warm-up <plan-path>` (preparation only — briefing receipt and recon report, then halts before any edits), or by the user asking to "run the next stage", "advance the plan", or "do the next bit of <plan>".
---

# Implement Carefully

You are about to execute ONE incomplete stage of a multi-stage plan, end to end, then update the plan to record completion and return control to the user. The user wants serial, fresh-session-per-stage execution; this skill picks the next stage automatically.

## Args

The invocation should name the plan doc path (e.g. `/implement-carefully docs/current/project-bayes/73b-be-topo-removal-and-forecast-state-separation-plan.md`). If the path is missing, ambiguous, or does not resolve on disk, **STOP and ASK** the user. Do not guess.

**Warm-up mode**: if the invocation includes the literal token `warm-up` or `warm up` (in either order, e.g. `/implement-carefully warm-up <plan>` or `/implement-carefully <plan> warm up`), or the user phrases the invocation as "warm up <plan>" / "prep <plan>" / "get ready to run <plan>" without asking you to start, treat the session as **preparation only**. See the "Warm-up mode" section below. If you are unsure whether the user wants warm-up or full execution, ASK once — the difference matters.

## Step 1 — Locate the progress section in the plan

Look for a heading `## Implementation progress` in the plan. The block underneath is a markdown checkbox list, one item per stage:

```
## Implementation progress

<!-- managed by /implement-carefully — edit checkboxes manually only when the skill is not running -->

- [x] Stage 0 — completed 26-Apr-26 — commits: abc1234, def5678
- [x] Stage 1 — completed 27-Apr-26 — commits: ghi9012
- [ ] Stage 2
- [ ] Stage 3
- [ ] Stage 4(a)
...
```

**If the progress section is absent**: do NOT auto-scaffold. Read the plan's stages-of-delivery section (commonly `§8` or a section titled "Delivery stages", "Implementation stages", "Stages"), enumerate the stage IDs verbatim (preserve sub-stage notation like `4(a)`, `4(b)`), and propose the section to the user as a single Edit. **Stop and ask for confirmation** before applying the edit. Once applied, continue.

## Step 2 — Pick the next stage

The next stage is the **first** `- [ ]` item in the progress block (top to bottom). Quote the stage ID and the plan path back to the user in one line:

> "Next incomplete stage: `<id>` in `<plan-path>`. Beginning briefing."

Do not pause for confirmation here unless one of the **stop conditions** below fires.

**Warm-up exception**: warm-up can be triggered while a prior stage is still in progress (e.g. another session is mid-execution, or the user has not yet committed/marked it done) so that context-loading runs in parallel. Two cases:
- If the user named a specific stage in their message (e.g. "warm up stage 3"), use that ID, even if an earlier stage is still `- [ ]`.
- Otherwise, pick the first `- [ ]` as usual. Do not block on the fact that another session may be touching it; warm-up only reads.

## Step 3 — Stop conditions (check before doing any work)

If any of these is true, **STOP and ASK**:

1. The next stage's section in the plan declares prerequisites or entry preconditions (e.g. "doc 73a §15A gates must pass", "Stage 4(b) entry condition: …"). Verify or have the user confirm they hold. Do not assume.
2. `git status` shows uncommitted modifications **to files this stage will edit**. Genuinely conflicting WIP — ask the user how to proceed. Uncommitted changes elsewhere (e.g. leftover from the previous stage that the user hasn't committed yet) are fine; just note them in the kickoff line and proceed.
3. The plan section for this stage cross-references file paths or §-numbers that don't resolve. Plan-vs-reality drift; ask before acting.
4. The plan and the current code disagree on a load-bearing field shape, contract, or invariant.

**Warm-up relaxation**: in warm-up mode, condition (2) does not block — warm-up performs no edits, so concurrent WIP on those files is fine. Note the WIP in the warm-up report so the user is aware. Conditions (1), (3), (4) still apply: surface them in the warm-up report rather than as a hard stop, since the user may want to continue prep work while resolving them in parallel. If they look fatal, ask.

## Step 4 — Session start procedure

Before your first edit:

1. Read the warm-start docs named in CLAUDE.md.
2. Read `.claude/context-manifest.yaml`. For every path you intend to edit, read its `required_reads`.
3. Read the plan: §1–2 (objective, decisions), the §3 layers your stage touches, your stage's section in the delivery-stages list, the acceptance criteria, the cross-doc conflicts section, the schema-change ledger rows your stage owns. **Do not preload sections owned by other stages.**
4. Read companion doc(s) only for sections cross-referenced from your stage.
5. Emit the briefing-receipt block per CLAUDE.md, then STOP. The Stop hook records it. Continue editing in your next turn.

Quote 3–7 load-bearing invariants from the stage's section in the briefing receipt, with §-numbers. These survive auto-compaction; they are your contract for the session.

## Step 4a — Warm-up mode (preparation only, no edits)

If the invocation is a warm-up (see Args), execute Steps 1–4 to fully load context, then **stop before any edits** and print a warm-up report. The intent is to absorb the cost of briefing and recon now so that, when the user authorises execution later, work begins immediately. Warm-up is also designed to run in parallel with other in-flight stages — it must not interfere with another session's edits or commits.

What warm-up does:

1. Steps 1–4 in full: locate the progress section, pick the stage (honouring an explicit stage hint from the user), surface stop-condition concerns per the warm-up relaxation above, read the warm-start docs and per-path required reads, read the relevant plan sections, emit the briefing receipt as a standalone message. The Stop hook records the receipt; it remains valid for later edits in this conversation.
2. **Recon, not edits**: enumerate the atoms the stage will land (using `TodoWrite` is fine — but keep all rows pending), the file surfaces it will touch, the schema rows it owns, the test files it will exercise, and the suggested commit boundaries. Open files in read-only fashion to confirm they exist and look as the plan describes; do not modify them. Dispatch the **Explore** subagent for any broader recon you would do at session start.
3. **Cross-doc prerequisites**: walk the plan's stop-condition prerequisites (entry conditions, gates from companion docs) and report each as "verified", "unverified", or "blocked". Do not assume.
4. **Print the warm-up report** and stop. The report should include:
   - Stage ID, plan path, warm-up timestamp.
   - Stop-condition summary (especially WIP noted on stage-touched files; cite paths).
   - Atoms enumerated (one bullet each), with the suggested commit message for each.
   - Surfaces to be edited (file paths) and schema rows owned.
   - Acceptance criteria the stage will be measured against, quoted.
   - Tests planned to run (per atom and at stage end).
   - Open questions or risks that need user input before execution.
   - The literal line: **"Warm-up complete. Reply 'go' (or `/implement-carefully <plan-path>`) to begin execution. Reply with concerns or course corrections to refine before starting."**

What warm-up must NOT do:

- Any Edit or Write tool call against source code, schemas, tests, or the plan's progress block.
- Any git write (the standard prohibition still applies).
- Marking the stage in progress or complete.
- Starting a TodoWrite atom as `in_progress` — atoms stay pending.
- Modifying or committing on behalf of another in-flight session, even if its WIP overlaps.

**Resuming after warm-up**: when the user replies "go" / "proceed" / "start" / `/implement-carefully <plan-path>` (without `warm-up`) in the same conversation, continue from Step 5 directly. The briefing receipt is already on file and reusable; do not re-emit unless the receipt's `read:` paths have since changed (e.g. a manifest update or a new path added to the stage's surfaces). If the user resumes in a fresh session instead, the new session re-runs the full warm-up itself — the recorded receipt does not carry across sessions.

## Step 5 — Stage execution discipline

- Use `TodoWrite` at session start to enumerate the atoms in your stage (one row per logical commit unit). Mark each complete as it lands; do not batch.
- **You do not run `git commit` (or any other git write).** When committing happens, and at what granularity, is the user's call. Just complete the atoms.
- For each atom, note a suggested commit message naming the §-section and any schema-row identifier (e.g. `<plan-id> stage <N>(<x>): <atom> (<row>)`) when announcing the atom is done. Do not halt to wait for a commit; carry on to the next atom.
- Schema changes per the plan's procedure: JSON Schema + Pydantic + TypeScript + parity tests in lockstep. After **each row** (not at end of stage), run both:
  - `cd graph-editor && npm test -- --run schemaParityAutomated`
  - `cd graph-editor && pytest lib/tests/test_schema_parity.py`
- Tests-first per CLAUDE.md §4: any new code path needs a test BEFORE you call the work done. HARD BLOCK.
- Run only relevant tests. Never head/tail test output.

## Step 6 — Forbidden behaviours

- Running `git commit` yourself. **You recommend; the user commits.** Same for `git add`, `git stash`, `git checkout`, or any other git write.
- Backwards-compat shims, deprecated aliases, "just in case" code, legacy wrappers.
- Scope creep beyond your stage's atoms ("while I'm here").
- Mocking the database in integration tests.
- `npm run build` (per CLAUDE.md).
- Writing or proposing a handover unprompted — only `/handover` literally typed by the user triggers it.
- Pushing to remote, opening PRs, creating branches.
- Marking a stage complete in the progress block before all its atoms are landed (committed by the user, or explicitly acknowledged) and acceptance criteria pass.
- Editing files outside this stage's enumerated surfaces. If your edit needs to, STOP and ASK.
- Advancing to the next stage automatically. **One stage per invocation; full stop.**

## Step 7 — Mark stage complete

Once every atom is landed in the working tree and the stage's acceptance criteria pass:

1. Walk through the plan's acceptance criteria for this stage and quote each as pass/fail. All must pass; if any fail, the stage is not done — STOP and ASK before marking.
2. Confirm schema parity tests pass (if any rows landed).
3. Edit the progress block: change `- [ ] Stage <id>` to `- [x] Stage <id> — completed <d-MMM-yy>`. Use the project date format (UK English month, e.g. `27-Apr-26`). Do not include commit SHAs — the skill does not own commit state.
4. Note a suggested commit message for the progress-block edit (e.g. `<plan-id>: mark stage <id> complete in progress block`) in the final report. Do not run the commit.

## Step 8 — Final report and stop

Print a tight summary and stop. Do **NOT** invoke this skill again, do **NOT** start the next stage, do **NOT** push, do **NOT** open a PR, do **NOT** write a handover.

The summary should include:

- Stage ID and plan path.
- What landed (atoms, files touched, schema rows).
- Acceptance criteria walked, each marked pass/fail (all should be pass).
- Tests run and their results.
- Baseline-failure delta vs the plan's documented baseline.
- For each atom and the progress-block edit: the suggested commit message. Whether to commit, when, and at what granularity is the user's call.
- Next stage according to the progress block (just name it; do not act on it).

## Context budget

- Aim to keep total session under ~250–300k tokens. Briefing alone on a large plan is often 80–120k.
- For broad codebase reconnaissance, dispatch the **Explore** subagent.
- For non-trivial implementation order inside a multi-atom stage, dispatch the **Plan** subagent before executing.
- Do not re-read whole large docs that are already in context. Re-read only the specific §-section you need.

## Say-it-out-loud moments

Write a short user-facing line, then continue:

- After resolving the next stage from the progress block.
- When you finish reading the briefing materials.
- When warm-up is complete and you are halting before edits (use the literal "Warm-up complete" line from Step 4a so the user can spot the boundary).
- When the user resumes after warm-up and you transition into Step 5.
- When you start an atom.
- When you finish an atom (with the commit SHA).
- When a test failure is unexpected.
- When you hit any STOP-and-ASK condition.
- After marking the stage complete.

## Ask before acting if

- The plan references a §/file/line that does not exist or has moved.
- Two parts of the plan contradict each other.
- A test failure is not in the documented baseline.
- A schema row touches a file outside the plan's enumerated surfaces.
- A cross-doc prerequisite is listed as required but you cannot verify it has actually passed.
- You believe the plan is wrong.
