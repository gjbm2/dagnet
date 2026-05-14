---
name: photocopy
description: Capture a complete snapshot of the current working tree (modified, deleted, AND untracked files) into a named git stash, then restore the working tree exactly as it was — same files modified, same files deleted, same files untracked, same staged/unstaged layout. Result is a reusable safety net the user can `git stash apply` later if they need to recover, while in the meantime nothing has changed. Triggered when the user types `/photocopy [name]` or asks to "photocopy", "snapshot", or "safety-stash" the current working dir without disturbing it.
---

# Photocopy

Make a named git stash that captures *everything* in the working tree — modifications, deletions, **and untracked files** — then put the working tree back exactly as it was. The user ends with a stash they can recover from later, but the visible state is unchanged.

This is a git-write operation, but the git-write gate has a dedicated, narrow carve-out for the canonical `/photocopy` command (see `gate-check.sh`'s `/photocopy canonical-sequence carve-out` block). The carve-out matches only the exact chained sequence below — any deviation, extra command, or command-substitution inside the stash name falls through to the normal gate and will be blocked. There is no request/confirm dance for canonical `/photocopy`.

## Picking a name

If the user supplied a name, use it verbatim.

Otherwise default to: `photocopy-<branch>-<date>` where:
- `<branch>` is the current branch with `/` replaced by `-`
- `<date>` is today in ISO form (`YYYY-MM-DD`) — git stash messages are an external boundary so ISO is fine here, despite the project's usual `d-MMM-yy` rule

Example: `photocopy-feature-snapshot-db-phase0-2026-05-08`.

## The procedure

The naive `git stash push -u && git stash apply` does **not** restore the original state when there were already-staged changes — `apply` without `--index` drops them into the unstaged bucket. The full-fidelity sequence is:

1. **Save a pre-image** of the status: `git status --short > /tmp/photocopy-pre.txt`. This is your verification baseline.
2. **`git add -A`** — stage everything including untracked. After this, every change is in the index. Working tree content is unchanged.
3. **`git stash push -m "<name>"`** — capture the index (and matching working-tree state) into a named stash. Working tree becomes clean.
4. **`git stash apply --index`** — re-apply with `--index` so both index and working tree are restored to the staged-everything state.
5. **`git reset`** (mixed reset, the default — do **not** use `--hard`) — clears the index back to HEAD. Working tree is untouched. Files that were untracked become untracked again. Files that were modified become unstaged-modified. Files that were deleted become unstaged-deleted.
6. **Save a post-image** and diff: `git status --short > /tmp/photocopy-post.txt && diff /tmp/photocopy-pre.txt /tmp/photocopy-post.txt`. Empty diff = perfect photocopy. Non-empty = report it; do not silently move on.
7. **Report**: confirm the empty diff and show `git stash list` so the user sees the new stash at `stash@{0}`.

## Why each step is load-bearing

- **Why `git add -A` and not `git stash push -u`?** `-u` includes untracked, but the `apply` step needs `--index` to restore staged-vs-unstaged distinctions, and `--index` only works cleanly when the stash was made from a fully-staged tree. Pre-staging eliminates the edge cases.
- **Why `--index` on apply?** Without it, every change comes back as unstaged, even ones the user originally had staged. That is a behavioural change, not a photocopy.
- **Why `git reset` (mixed) and not `git reset --hard`?** Hard reset destroys the working tree. Mixed reset only clears the index. The working tree — the thing we just restored — must be preserved.
- **Why the diff check?** To prove the photocopy worked. A skill that reports success without verifying is worse than one that reports failure honestly.

## Gate handling

Issue the entire sequence as a **single Bash call**, chained with `&&` exactly as below:

```
git status --short > /tmp/photocopy-pre.txt && git add -A && git stash push -m "<name>" && git stash apply --index && git reset && git status --short > /tmp/photocopy-post.txt && diff /tmp/photocopy-pre.txt /tmp/photocopy-post.txt
```

Substitute `<name>` with the chosen stash name (use double quotes; no `$()`, backticks, or shell escapes inside the name — those break the carve-out and the gate will block). The gate's photocopy regex matches this exact shape and lets it through; any deviation — extra commands, splitting the chain across Bash calls, different paths — re-engages the normal gate.

If the working tree is empty, the first `git status --short` produces an empty file. `git add -A` is a no-op and `git stash push` would create an empty stash. **Pre-check yourself**: if `git status --short` (in a separate, ungated call) is empty, tell the user there is nothing to photocopy and exit; do not issue the canonical sequence.

## Edge cases

- **Nothing to stash.** If `git status --short` is empty, tell the user there is nothing to photocopy and exit. Do not create an empty stash.
- **Existing stash with the same name.** Git allows duplicate stash messages — they coexist at different indices. This is fine. Mention it if the user might be confused.
- **Stash apply conflicts.** Should not happen on a freshly-cleaned working tree, but if it does, abort and report. Do not auto-resolve. The user's working tree is at risk.
- **User has untracked files inside `.gitignore`'d paths.** `git add -A` skips ignored files; they will not be in the photocopy. This is normally desired (build artefacts, secrets), but call it out if you suspect the user expected them included.
- **Submodules.** Out of scope. If the repo has submodule changes, mention that the photocopy does not include them and ask whether to proceed.

## How to respond

- Before requesting the gate, state the chosen stash name and the four-step sequence in one sentence.
- After the diff check passes, report two facts: the diff was empty, and the new entry in `git stash list`.
- If the diff is non-empty, show it verbatim and stop. Do not "fix" it without approval — the user needs to know the photocopy is imperfect before further action is taken.
