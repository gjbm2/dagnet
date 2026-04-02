---
name: handover
description: Write a detailed handover note so a fresh Claude Code session can pick up cognitively dense work without context loss. Captures decisions, rationale, discoveries, and next steps.
---

# Handover Note

Write a detailed handover note for a fresh Claude Code session to pick up this work without context loss. This is for cognitively dense work where decisions, rationale, and discoveries are expensive to re-derive.

## Instructions

1. **Review the full conversation** — scan all turns, not just recent ones. Identify decisions, pivots, corrections, discoveries, and current state.

2. **Write the handover note** to `docs/current/handover/` as a markdown file. Use the current date and a short slug for the filename (e.g. `2-Apr-26-cohort-forecast-conditioning.md`). Use d-MMM-yy date format per project conventions.

3. **Structure the note using these sections** (all required):

### Objective
What we are trying to achieve and *why*. Not just the task name — the underlying goal, the problem being solved, and any constraints or scope boundaries agreed with the user.

### Current State
What is done, what is partially done, what is untouched. Be specific — name files changed, tests written, features working/broken. Use a status indicator for each item: DONE / IN PROGRESS / NOT STARTED / BLOCKED.

### Key Decisions & Rationale
Decisions made during the session that a fresh agent would not derive from reading the code alone. For each decision, state:
- **What** was decided
- **Why** (the reasoning, trade-offs considered, alternatives rejected)
- **Where** it manifests in the code (file paths, line numbers if relevant)

This is the most important section. A fresh agent will re-derive naive solutions unless told what was already considered and rejected.

### Discoveries & Gotchas
Things learned during the session that are not obvious from the codebase:
- Surprising behaviours in dependencies or subsystems
- Edge cases that bit us
- Assumptions that turned out to be wrong
- Performance or compatibility issues encountered

### Relevant Files
A map of the files that matter for this work, with a one-line description of each file's role. Group by area (e.g. "Backend", "Frontend", "Tests", "Docs"). Include files that were *read* for context, not just files that were *changed*.

### Next Steps
Concrete, ordered, actionable steps for the next session. Each step should be specific enough that a fresh agent can execute it without asking clarifying questions. Include:
- What to do
- Which files to touch
- Any known risks or dependencies between steps

### Open Questions
Unresolved questions that need the user's input or further investigation. Flag whether each is blocking or non-blocking.

## Quality checks

- **No code snippets** — this is prose, not a patch. Reference file paths and line numbers instead.
- **No vague language** — "fix the bug" is useless; "the forecast array is transposed in `cohort_forecast.py:245` — rows and columns are swapped when n_periods > horizon" is useful.
- **Preserve the user's intent** — if the user corrected the agent's approach, capture what the user wanted, not what the agent initially proposed.
- **Date-stamp properly** — use absolute dates (d-MMM-yy), never relative ("yesterday", "earlier").
- **Keep it scannable** — use bullet points and bold key terms. A fresh agent should be able to skim the headings and know where to look.

## After writing

4. Tell the user the file path and suggest they start their next session with: "Read docs/current/handover/<filename> and continue from where it left off."
