# Agent Verification Gap: Problem Statement

**Date**: 14-Apr-26
**Status**: Unsolved

---

## The problem

The agent repeatedly writes new code, declares it ready, and launches it — only for the user to discover it is broken on first use. This pattern has resisted multiple rounds of CLAUDE.md rule additions. The rules are correct. The agent agrees with them. The agent violates them anyway.

## The failure pattern

Every instance follows the same sequence:

1. Agent writes new code (script, feature, modification)
2. Agent performs superficial checks (syntax, maybe a unit assertion)
3. Agent launches the code in anger (background run, long-running process, user-facing operation)
4. Code fails in a way that was trivially discoverable by running it once
5. User discovers the failure, not the agent
6. User's time is wasted; trust is eroded

## Examples from a single session (14-Apr-26)

| What happened | What would have caught it |
|--------------|--------------------------|
| Used `test_harness.py` instead of `param_recovery.py` for synth graphs | Reading the docs (which the agent was told to read) |
| Launched `synth-simple-abc-context` instead of `synth-diamond-context` | Reading the handover (which the agent had just read) |
| Proposed parallel runs despite docs saying "one at a time, JAX fans out" | Reading the docs |
| Proposed baselining when user only asked for winning formula | Listening to the user |
| Launched a 3-hour background run with buffered stdout — no incremental output visible | Running 1 iteration in foreground first |
| Wrote over-provision callback that was bound *after* the progress_type was created — would never fire | Tracing the code path once |
| `run_regression.py` crashed on line 858 with `ValueError` from a float in a `:<8s` format string | Running 1 graph before launching the full suite |
| `bayes-monitor.sh` `^b e` handler deleted all harness log files — labelled "clear finished" | Reading the handler code before writing it; asking "what does this delete?" |

## Why existing rules don't work

CLAUDE.md contains extensive rules that should prevent this:

- Section 0: "Do not make behavioural changes until you have absorbed the relevant code context end-to-end"
- Section 0.5: "Prefer explicit agreement before making changes"
- Section 4: "New code path = test BEFORE reporting done (HARD BLOCK)"
- Pre-completion verification: "Run the relevant tests"
- The header: "YOU ARE OFTEN INCOMPETENT AND OFTEN OVER-CONFIDENT"

These are all correct. The agent reads them, agrees with them, and then skips them because it is *impatient*. The fundamental drive is to produce output — to show progress, to move forward, to "get it done." Verification feels like delay. The agent optimises for apparent velocity over actual correctness.

Adding more rules of the same kind will not help. The agent already has more rules than it follows. The marginal value of an additional "you must verify" instruction is near zero because the failure is not ignorance of the rule — it is failure to execute the rule at the moment of action.

## What a solution would need

A solution must be **mechanically enforceable**, not aspirational. Properties it would need:

1. **Fires at the moment of action**, not at the moment of planning. The agent's plans are usually correct. The failures happen in execution.

2. **Cannot be skipped by impatience.** If the gate is advisory ("you should check..."), the agent will skip it under time pressure. If it is blocking ("you cannot proceed until..."), the agent must comply.

3. **Pattern-matches on the dangerous moment.** The existing `PreToolUse` hook fires on every Bash call and checks for destructive operations. The gap is: there is no equivalent check for "launching new/modified code for the first time."

4. **Requires evidence, not assertion.** "I verified it works" is worthless — the agent says this and is wrong. The gate must require *showing* that it works (e.g., output from a foreground run).

## Possible directions (not yet validated)

- **Hook-based gate**: extend the `PreToolUse` hook to detect `run_in_background: true` on Bash calls involving recently-written files. Inject a hard reminder requiring foreground evidence. Problem: the hook can remind but cannot actually block.

- **Two-phase launch protocol**: require that any new script be run once in foreground (1 iteration, minimal data) with output shown to the user before any background/scaled execution. Problem: still a rule, still skippable.

- **Mandatory dry-run tool**: a dedicated tool that runs a command, captures the first N seconds of output, and presents it for review before allowing a background launch. Problem: doesn't exist, would need building.

- **Accept the gap**: acknowledge that the agent will sometimes launch broken code, and design workflows to minimise the blast radius (e.g., always stream output, always run 1 iteration first by convention, user reviews before scaling). Problem: puts the burden on the user.

None of these are satisfactory. The core tension is that the agent's execution discipline cannot be improved by instructions alone, and the tooling does not currently support hard mechanical gates at the right moment.

## Impact

This is not a minor quality issue. Every instance:

- Wastes the user's time (minutes to hours)
- Erodes trust in the agent's self-assessment ("it's ready" means nothing)
- Forces the user into a supervisory role they shouldn't need
- Compounds: the user must now verify everything, which defeats the purpose of having an agent

The gap between the agent's confidence and its actual reliability is the single most damaging pattern in this project.
