# DagNet Introduction Workshop -- PART 3 (of 3)

**Audience**: DagNet users who have completed Parts 1 & 2  
**Duration**: ~60–90 minutes  
**Prerequisites**: Familiarity with scenarios, evidence/forecast modes, and basic graph navigation  
**Last updated**: 4-Feb-26

---

## Section 9: What‑If and Conditional Probabilities

**Duration**: ~20 minutes  
**Mode**: Demo + Mini-lab

This is where DagNet goes beyond "segmenting a funnel".

### Learning objectives

- Understand what conditional probabilities mean and when to use them
- Understand what What‑If analysis does (and how it differs from slicing evidence)
- Learn to combine conditionals with What‑If to model counterfactual scenarios

### Conditional Probabilities (what they mean)

Sometimes an edge behaves differently depending on what the user did earlier. Example:

- "Conversion from `pricing → signup` is higher if the user visited `promo`."

In DagNet this is expressed as a conditional probability on an edge, using conditions like:

- `visited(node-id)`
- `exclude(node-id)`
- `context(key:value)` (slice behaviour by a context)
- `case(experiment:variant)` (model behaviour by experiment variant)

### What‑If (what it means)

What‑If lets you answer questions like:

- "What if everyone went through node X?"
- "What if we force the path to include Y (and exclude alternative siblings)?"

Practically, What‑If can:

- **activate conditionals** (treat as if `visited(...)` were true)
- **prune and renormalise** the graph (re-route probability mass through the forced path)

### Important distinction

| Mechanism | What it does | Evidence changes? |
|-----------|--------------|-------------------|
| **Context/cohort slice** | Filters Amplitude evidence to a subset of users | Yes |
| **What‑If** | Modifies the model to assume a path/condition | No (model only) |

What‑If is a **modelling tool**, not an evidence filter. It answers "what would the model say if..." without re-querying Amplitude.

### Hands-on mini‑lab: conditional + what‑if

> **Task**:
>
> - Pick one edge (e.g., `middle → exit`) and add a conditional probability:
>   - Base p.mean = baseline
>   - Conditional p.mean when `visited(entry)` (or another upstream node) = higher
> - Use the What‑If panel to force the visited condition on/off and observe:
>   - the edge probability changes
>   - downstream reach changes
>
> **Discussion**: "Is this slicing evidence, or changing the model?"

---

## Section 10: Graph Issues (Integrity Checking)

**Duration**: ~10 minutes  
**Mode**: Demo + Mini-lab

### Learning objectives

- Understand what "Graph Issues" is (and what it is not)
- Learn how issues are discovered and kept up to date
- Learn how to use the Issues viewer to navigate straight to the broken node/edge/file
- Learn a practical "fix loop": make a change → check issues → fix → refresh → repeat

### What Graph Issues is

Graph Issues is DagNet's built-in **integrity checker** — an IDE-style linter for your workspace.

It scans graphs and related files (nodes, parameters, contexts, cases, etc.) and surfaces problems as:
- **Errors**: things that will likely break analysis/retrieval or make the graph invalid
- **Warnings**: suspicious or inconsistent states that might still "work" but are risky
- **Info**: helpful notices and hygiene checks

### Mass conservation (the biggest thing to internalise)

If participants remember only one "graph correctness" concept, it should be **mass conservation**:

- At each node, the outgoing edges represent a partition of what happens next, so the outgoing probabilities/weights should be well-defined and interpretable.
- In practice, problems show up as:
  - **Leak**: outgoing probabilities/weights sum to less than expected (missing "exit/other" path, or missing an edge entirely).
  - **Over-commit**: outgoing probabilities/weights sum to more than expected (double counting, overlapping conditionals, or inconsistent evidence).

Graph Issues is designed to catch the common mass-conservation failures early. Two particularly important messages it can surface:

- **Sibling edges sum over 100% (evidence)**: reported as an **Error** (this should never happen under standard funnel semantics).
- **Sibling edges sum over 100% (mean)**: reported as **Info** when it's likely a **forecasting artefact for immature data** (the modelled \(p\) can temporarily look "too high" even when evidence is coherent).

Practical fixes to teach:

- If you see a leak: add or verify an explicit **exit / other** edge so the node's outcomes are complete.
- If you see over-commit: look for overlapping edges/conditionals, and ensure sibling edges are mutually exclusive and collectively exhaustive (MECE) at the user level.
- If conditionals are involved: ensure sibling edges from the same node define the same conditional groups (otherwise interpretation/conservation silently breaks).

### What Graph Issues is not

- It is **not** a data-quality or statistical validity judgement ("this conversion rate is wrong").
- It does **not** replace domain review; it focuses on **structure, references, and integrity**.

### Where to find it in the UI

- Open it from **View → Graph Issues**.
- Optional: when a graph has debugging enabled, you may also see an **issues indicator overlay** on the graph canvas (top-right). Clicking it opens Graph Issues scoped to that graph.

### How it works (simple mental model)

- It runs a workspace integrity scan in the background and updates the viewer as results change.
- It is **debounced** (changes are grouped) to avoid re-checking on every single keystroke.
- You can always hit **Refresh** in the Graph Issues viewer to force a re-check.

### How to use it (the "three filters" habit)

When something looks wrong, teach participants to do these three steps first:

1. **Filter to the graph** they care about (Graph dropdown).
2. Keep **Include refs** on (so you see issues in referenced files, not just the graph YAML).
3. Start with **Errors only**, then expand to Warnings/Info once errors are cleared.

### Demo (recommended flow)

1. Make a small "controlled mistake":
   - Example: rename a node/case/context file (or change an ID) without updating the graph references.
2. Open **View → Graph Issues**.
3. Filter to the current graph and show:
   - The issue grouping by file
   - The category icon + severity counts
   - The suggestion/detail text (when present)
4. Click an issue row to **jump directly** to the affected node/edge in the graph (when deep linking is available).
5. Fix the issue, refresh, and show the issue disappearing.

### Mini-lab (2–3 minutes)

> **Task**: Each participant should introduce one tiny break and recover using Graph Issues.
>
> - Break something small (a missing reference, a naming mismatch, a schema typo).
> - Find the issue, navigate to it, and fix it.
> - Confirm Graph Issues returns to "✅ No issues found".

### Discussion prompts

- "If the issue is on a referenced file, why might the graph still 'look fine' until you run retrieval/analysis?"
- "Which issues would you treat as a 'hard stop' before sharing a chart?"
- "What patterns of edits tend to create issues? (renames, copy/paste, changing IDs, moving files)"

---

## Section 11: Session Log

**Duration**: ~10 minutes  
**Mode**: Demo

### Learning objectives

- Understand what gets logged and why
- Learn to use the Session Log to diagnose problems
- Know when to export/share a session log for support

### What the Session Log captures

The Session Log records all significant operations during your session:

- **Data operations**: Fetch requests, retrieval results, cache hits/misses
- **Git operations**: Pull, push, commit activity
- **File operations**: Create, save, delete
- **Errors and warnings**: Failed requests, validation issues, integrity problems

### Where to find it

- Open from **View → Session Log**
- The log persists for your current session (cleared on page refresh)

### Reading the log

Each entry shows:
- **Timestamp**
- **Operation type** (git, data-fetch, file, etc.)
- **Status** (info, success, warning, error)
- **Message** and optional details

Entries can be **hierarchical** — a parent operation (e.g., "Retrieve All Slices") contains child entries for each individual fetch.

### When to use it

- **Debugging retrieval issues**: "Why didn't my data update?" — check for errors or cache behaviour
- **Verifying operations completed**: "Did my commit go through?" — look for success/error status
- **Sharing with support**: Export the log to share diagnostic information

### Demo

1. Trigger a data fetch
2. Open Session Log
3. Find the fetch operation and expand it
4. Show the child entries (individual edge fetches, snapshot writes, etc.)

---

## Section 12: Snapshot History & As-At Queries

**Duration**: ~15 minutes  
**Mode**: Demo

*This section covers features being released this week.*

### Learning objectives

- Understand how snapshot history enables "time travel" queries
- Learn to use `.asAt()` DSL syntax to view historical states
- Know the limitations of as-at queries

### Recap: What Snapshots Store

Every successful data retrieval stores a snapshot containing:
- Daily time-series values (n, k, latency stats)
- Retrieval timestamp
- Query signature (to match the query definition)

### As-At Queries

The `.asAt()` DSL extension lets you view data **as it was known at a specific past date**.

**Syntax**:
```
from(A).to(B).window(1-Oct-25:31-Oct-25).asAt(15-Oct-25)
```

**Meaning**: "Show me the October window data, but using only snapshots that existed on 15-Oct-25."

### Use cases

| Use case | Example |
|----------|---------|
| **Audit trail** | "What did the dashboard show on 1-Nov?" |
| **Debugging** | "Why did the report show X on that day?" |
| **Immature cohort replay** | "What did we know about this cohort after 7 days?" |

### Limitations

- Requires snapshots to exist for the requested date range
- Uses current graph definition for signature matching — if query config has changed, historical data may not match

### Demo

1. Select a parameter with snapshot history
2. Add `.asAt(date)` to the query DSL
3. Show how values reflect the historical state
4. Compare with current (live) values

---

## Section 13: Time-Series Charting

**Duration**: ~15 minutes  
**Mode**: Demo

*This section covers features being released this week.*

### Learning objectives

- Understand what time-series charting shows
- Learn to create and interpret cohort trend charts
- Know when to use time-series vs point-in-time analysis

### What Time-Series Charting Shows

Time-series charts visualise **how parameter values have changed over time**:

- Track conversion rates across cohorts
- Spot trends, seasonality, or anomalies
- Compare historical performance to current state

### Creating a Time-Series Chart

*(UI details to be confirmed when feature ships)*

### Interpreting the Chart

- **X-axis**: Cohort date (or anchor day)
- **Y-axis**: Metric value (conversion rate, count, etc.)
- **Multiple series**: Compare scenarios or slices

### Use cases

| Use case | What to look for |
|----------|-----------------|
| **Trend detection** | Is conversion improving or declining over time? |
| **Seasonality** | Are there weekly/monthly patterns? |
| **Experiment impact** | Did the metric shift when the experiment launched? |
| **Data quality** | Are there unexpected gaps or spikes? |

### Demo

1. Open a parameter with historical data
2. Create a time-series chart
3. Interpret the trend
4. Add a second scenario to compare

---

## Follow-Up Resources

- [What‑If + Conditionals Reference](../what-ifs-with-conditionals.md)
- [User Guide](../user-guide.md)
- [Query DSL Reference](../query-expressions.md)

---

## Session Feedback

After the workshop, collect feedback on:

1. Which sections were most valuable?
2. Which sections need more depth?
3. Were the demos effective?
4. What additional topics should be covered?

---

*Document version: 1.0 | Created: 4-Feb-26*
