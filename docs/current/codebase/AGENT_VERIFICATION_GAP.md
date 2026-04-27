# Agent Verification Gap: Problem Statement

**Date**: 14-Apr-26
**Status**: Unsolved

## Problem

Agent writes new code, declares it ready, launches it — user discovers it broken on first use. Resists multiple rounds of CLAUDE.md additions. Rules are correct; agent agrees with them; agent violates them anyway.

## Failure pattern

1. Agent writes new code (script, feature, modification)
2. Performs superficial checks (syntax, maybe a unit assertion)
3. Launches in anger (background run, long-running process, user-facing op)
4. Code fails in a way trivially discoverable by running it once
5. User discovers the failure, not the agent
6. User's time wasted; trust eroded

## Examples (single session, 14-Apr-26)

| What happened | What would have caught it |
|--------------|--------------------------|
| Used `test_harness.py` instead of `param_recovery.py` for synth graphs | Reading the docs |
| Launched `synth-simple-abc-context` instead of `synth-diamond-context` | Reading the handover |
| Proposed parallel runs despite docs saying "one at a time, JAX fans out" | Reading the docs |
| Proposed baselining when user only asked for winning formula | Listening to the user |
| Launched 3-hour background run with buffered stdout — no incremental output | Running 1 iteration in foreground first |
| Wrote over-provision callback bound *after* the progress_type was created — never fired | Tracing the code path once |
| `run_regression.py` crashed line 858 with `ValueError` from float in `:<8s` format | Running 1 graph before launching the full suite |
| `bayes-monitor.sh` `^b e` handler deleted all harness log files, labelled "clear finished" | Reading handler code; asking "what does this delete?" |

## Why existing rules don't work

CLAUDE.md already has the rules: §0 (absorb context end-to-end), §0.5 (explicit agreement), §4 (test before reporting done), pre-completion verification, the header itself ("YOU ARE OFTEN INCOMPETENT AND OFTEN OVER-CONFIDENT"). Agent reads them, agrees, then skips them because it is *impatient*. Fundamental drive: produce output, show progress, "get it done." Verification feels like delay. Agent optimises for apparent velocity over actual correctness.

More rules of the same kind won't help. Failure isn't ignorance — it's failure to execute the rule at the moment of action.

## What a solution would need

Mechanically enforceable, not aspirational:

1. **Fires at the moment of action**, not at planning. Plans are usually correct; execution fails.
2. **Cannot be skipped by impatience.** Advisory gates ("you should check") get skipped under time pressure. Must be blocking.
3. **Pattern-matches on the dangerous moment.** `PreToolUse` hook fires on every Bash and checks destructive ops. Gap: no equivalent for "launching new/modified code for the first time."
4. **Requires evidence, not assertion.** "I verified it works" is worthless. The gate must require *showing* it works (e.g., foreground run output).

## Possible directions (not yet validated)

- **Hook-based gate**: extend `PreToolUse` to detect `run_in_background: true` on Bash calls involving recently-written files; inject hard reminder requiring foreground evidence. *Problem*: hook can remind but not block.
- **Two-phase launch protocol**: any new script runs once in foreground (1 iteration, minimal data) with output shown before any background/scaled run. *Problem*: still a rule, still skippable.
- **Mandatory dry-run tool**: dedicated tool runs a command, captures first N seconds of output, presents for review before background launch. *Problem*: doesn't exist, would need building.
- **Accept the gap**: design workflows to minimise blast radius (always stream output, always run 1 iteration first by convention, user reviews before scaling). *Problem*: puts burden on user.

None are satisfactory. Core tension: execution discipline can't be improved by instructions alone, and tooling doesn't currently support hard mechanical gates at the right moment.

## Impact

Every instance:

- Wastes user time (minutes to hours)
- Erodes trust in agent self-assessment ("it's ready" means nothing)
- Forces user into supervisory role they shouldn't need
- Compounds: user must verify everything, defeating the purpose of having an agent

The gap between agent confidence and actual reliability is the single most damaging pattern in this project.
