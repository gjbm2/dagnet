# DagNet Introduction Workshop -- PART 2 (of 2)

**Audience**: New DagNet users  
**Duration**: ~90–120 minutes (flexible based on interactivity)  
**Prerequisites**: Participants should have access to a browser and be able to view the DagNet application  
**Last updated**: 20-Jan-26


---

## Section 4: Evidence & Forecasts (LAG)

**Duration**: ~15 minutes  
**Mode**: Demo + Discussion

### Learning objectives

- Understand why evidence is incomplete for recent cohorts
- Understand the meaning of forecast in DagNet (and what assumptions drive it)
- Learn to choose the correct visibility mode for the question you’re answering

### The Problem with Static Conversion Rates

Traditional funnels show: "45% of users convert."

But this hides: "Convert by when? Are recent cohorts still converting?"

### Latency-Aware Graphs (LAG)

**Evidence** = What we've observed (users who already converted)  
**Forecast** = What we expect (projected conversions based on historical patterns)

### Edge Display

On LAG-enabled edges:
- **Solid bar** = Evidence (observed)
- **Faded/striped bar** = Forecast (projected)
- **Median lag** = Typical time to convert (e.g., "~5d")

### Completeness indicator (what the app actually shows today)

In the UI, the “maturity” concept is currently expressed as **completeness**:

- A **completeness marker** is drawn on LAG-enabled edges (in both normal and Sankey views).
- The edge tooltip shows `completeness: NN%` when latency tracking is enabled.


### Visibility Modes

| Mode | Description | When to Use |
|------|-------------|-------------|
| **F+E** | Evidence + Forecast blended | Best overall estimate |
| **F only** | Forecast probabilities only | Long-term baseline |
| **E only** | Evidence probabilities only | What's actually happened |

### Demo

Show the same graph with:
1. A mature cohort (mostly evidence)
2. A recent cohort (significant forecast component)

### Discussion prompts

- “Which part of this result is measured vs modelled?”
- “Would you ship a product decision based on E-only? F-only? Why?”
- “What would you need to trust the forecast more?”

### Practical guidance

- Use **E-only** for “what actually happened for a defined cohort window”.
- Use **F+E** for “best estimate of eventual conversion for that cohort”.
- Use **F-only** when you’re comparing long-run baselines or doing planning independent of current maturity.


*** Fair warning: forecast mode needs some debugging partly due to weirdness over xmas and partly to do with some statistical circularities which I have designed a solution for but haven't yet implemented... ***

---

## Section 5: Cases & A/B Tests

**Duration**: ~10 minutes  
**Mode**: Demo

### What Are Cases?

Cases model **experiment allocations** — branching paths where users are randomly assigned to variants.

**Important distinction (for this workshop)**:

- **Cases** are best for modelling the *graph topology* of an experiment (variant branches, allocation weights, counterfactual modelling).
- **Contexts** are best for slicing *evidence* (Amplitude queries) by “in gate” vs “not in gate”.
  - In practice, for Statsig gates instrumented into Amplitude, we often model “gate on/off” as a **context** keyed off an `activeGates.*` user property.

### Learning objectives

- Understand when to use a case node vs a context slice
- Understand how case weights (allocation) relate to analysis results
- Know what “counterfactual” means in DagNet and when it’s appropriate

### Case Node Structure

```
       ┌─────────────┐
       │   Gate Node  │
       │  (Case Node) │
       └─────┬───────┘
             │
    ┌────────┴────────┐
    ▼                 ▼
┌──────────┐   ┌──────────┐
│ Control  │   │ Treatment│
│  (50%)   │   │  (50%)   │
└──────────┘   └──────────┘
```

### Connecting to Statsig

Case files can sync variant weights from Statsig:
- Weights update automatically when experiment allocations change
- Treatment/control splits stay in sync with production

### Demo

Show a case node with:
1. Two variants (control/treatment)
2. Different downstream conversion rates
3. How reach probability changes based on variant weights

### Facilitator prompts (keep it practical)

- “If treatment is 10% traffic today, what does DagNet say happens if we ramp to 50%?”
- “Is that a forecast of the real world, or a modelled counterfactual? What assumptions did we just make?”

---

## Section 6: Scenarios & What-If Analysis

**Duration**: ~25 minutes  
**Mode**: Interactive

### What Are Scenarios?

Scenarios are **parameter overlays** that let you compare different "what if" states.

Note: In the current UI, scenario creation/editing happens in the **Scenarios panel**. What‑If controls are separate UI controls (not a separate “What‑If panel”).

### Learning objectives

- Learn the difference between “slice evidence” (contexts, cohorts) and “override the model” (what-if)
- Learn how scenario stacking works conceptually (base + deltas)
- Learn to choose visibility modes per scenario for the question you’re answering

### Scenarios as layers (the mental model that makes everything click)

DagNet always has:

- **Base**: a baseline snapshot (what “normal” means right now)
- **Current**: your working state on top of Base
- **Scenarios**: named overlays that can be shown/hidden and stacked

**Composition order (important)**:

1. Start from **Base**
2. Apply visible scenario overlays in stack order
3. Apply **Current** on top

Rule: **the last overlay wins** for a given parameter.

### “Snapshot” vs “Live” scenarios (how to explain to users)

- **Snapshot scenario**: “store these parameter overrides explicitly”
  - Great for capturing a plan or a set of changes you want to preserve
- **Live scenario (DSL-backed)**: “define a slice of evidence to fetch and display”
  - Great for cohort/context comparisons where you want the scenario to refresh as new evidence arrives

### Built-in Scenarios

- **Current** — The base state from parameter files
- **Base** — A reference point for comparison

### Live Scenarios (DSL-backed)

Create scenarios using DSL expressions:
- `cohort(1-Dec-25:7-Dec-25)` — Users who entered in a date range
- `context(channel:organic)` — Filter by context dimension
- Compound: `cohort(-7d:-1d).context(device:mobile)`

Note: DagNet’s DSL also supports `case(...)`, but in the current live-scenario design it behaves as a **what-if overlay** (counterfactual), not an evidence slice. For “filter Amplitude evidence to only gate-exposed users”, use `context(...)` as shown below.

### Practical scenario patterns to teach

- **Cohort comparison** (change only time window)
  - Example: `cohort(-7d:-1d)` vs `cohort(-14d:-8d)`
- **Segment comparison** (change only context)
  - Example: `context(channel:paid-search)` vs `context(channel:other)`
- **Gate exposure comparison** (context backed by `activeGates.*`)
  - Example: `context(whatsapp-journey:on)` vs `context(whatsapp-journey:other)`
- **Counterfactual overlay** (what-if)
  - Example: “treatment becomes 100%” as a modelling exercise (does not re-slice evidence)

### Visibility Modes per Scenario

Each scenario can show:
- **F+E** — Blended (default)
- **F only** — Forecast basis
- **E only** — Evidence basis
- **Hidden** — Excluded from analysis

### Hands-On Exercise

> **Task A (layering)**: Create one snapshot scenario and prove “last overlay wins”.
>
> - Create a snapshot scenario called “Higher conversion (toy)”.
> - Override one edge probability in the scenario (e.g., set `middle → exit` higher).
> - Create a second snapshot scenario called “Lower conversion (toy)” that overrides the same edge lower.
> - Toggle visibility and re-order them. Observe that the last visible overlay wins.
>
> **Task B (live evidence slices)**: Create two cohort scenarios
> 
> 1. Last week: `cohort(-7d:-1d)`
> 2. Two weeks ago: `cohort(-14d:-8d)`
> 
> Compare the reach probabilities. What changed?

#### Expected discussion

- If participants see a change: “Is it a real behavioural difference or a maturity/forecast difference?”
- If they don’t: “What would you change to make a difference detectable? (window length, context slice, target node)”

### What‑If and conditional probabilities (first-class)

This is where DagNet goes beyond “segmenting a funnel”.

#### Conditional probabilities (what they mean)

Sometimes an edge behaves differently depending on what the user did earlier. Example:

- “Conversion from `pricing → signup` is higher if the user visited `promo`.”

In DagNet this is expressed as a conditional probability on an edge, using conditions like:

- `visited(node-id)`
- `exclude(node-id)`
- `context(key:value)` (slice behaviour by a context)
- `case(experiment:variant)` (model behaviour by experiment variant)

#### What‑If (what it means)

What‑If lets you answer questions like:

- “What if everyone went through node X?”
- “What if we force the path to include Y (and exclude alternative siblings)?”

Practically, What‑If can:

- **activate conditionals** (treat as if `visited(...)` were true)
- **prune and renormalise** the graph (re-route probability mass through the forced path)

#### Hands-on mini‑lab: conditional + what‑if

> **Task**:
>
> - Pick one edge (e.g., `middle → exit`) and add a conditional probability:
>   - Base p.mean = baseline
>   - Conditional p.mean when `visited(entry)` (or another upstream node) = higher
> - Use the What‑If panel to force the visited condition on/off and observe:
>   - the edge probability changes
>   - downstream reach changes
>
> **Discussion**: “Is this slicing evidence, or changing the model?”

---

## Section 7: Analysis & Charting

**Duration**: ~15 minutes  
**Mode**: Interactive

### Learning objectives

- Learn how to express “what you want to know” using query DSL (`to(...)`, `from(...).to(...)`)
- Learn the difference between Reach Probability, Funnel, and Bridge (and when to use each)
- Learn how charts become shareable artefacts (and what “live” means)

### Available Analyses

| Analysis | Description |
|----------|-------------|
| **Reach Probability** | Probability of reaching a node from the anchor |
| **Conversion Funnel** | Step-by-step breakdown through a path |
| **Bridge View** | Attribute reach changes to individual edges |

### Query DSL

Target nodes using expressions:
- `to(node-id)` — Reach probability to a specific node
- `from(a).to(b)` — Path between two nodes

### Creating Charts

1. Select a node (or set query manually)
2. Open Analytics panel
3. Choose analysis type
4. Click "Open as Chart" to create a shareable chart tab

### Bridge Charts

Bridge charts decompose **why** reach changed between two scenarios:
- Start bar = Scenario A reach
- Step bars = Attribution to each edge
- End bar = Scenario B reach

### Hands-On Exercise

> **Task**: Create a bridge chart
> 
> 1. Create two cohort scenarios
> 2. Select the target node
> 3. Run Bridge View analysis
> 4. Open as chart

#### Interpretation prompts (what “good” looks like)

- “Which edges explain most of the delta?”
- “Is the delta driven by a single step, or a broad shift?”
- “If we changed one upstream edge by +1pp, what’s the downstream effect?”

---

## Section 7.5: Graph Issues (Integrity Checking)

**Duration**: ~10 minutes  
**Mode**: Demo + Mini-lab

### Learning objectives

- Understand what “Graph Issues” is (and what it is not)
- Learn how issues are discovered and kept up to date
- Learn how to use the Issues viewer to navigate straight to the broken node/edge/file
- Learn a practical “fix loop”: make a change → check issues → fix → refresh → repeat

### What Graph Issues is

Graph Issues is DagNet’s built-in **integrity checker** — an IDE-style linter for your workspace.

It scans graphs and related files (nodes, parameters, contexts, cases, etc.) and surfaces problems as:
- **Errors**: things that will likely break analysis/retrieval or make the graph invalid
- **Warnings**: suspicious or inconsistent states that might still “work” but are risky
- **Info**: helpful notices and hygiene checks

### Mass conservation (the biggest thing to internalise)

If participants remember only one “graph correctness” concept, it should be **mass conservation**:

- At each node, the outgoing edges represent a partition of what happens next, so the outgoing probabilities/weights should be well-defined and interpretable.
- In practice, problems show up as:
  - **Leak**: outgoing probabilities/weights sum to less than expected (missing “exit/other” path, or missing an edge entirely).
  - **Over-commit**: outgoing probabilities/weights sum to more than expected (double counting, overlapping conditionals, or inconsistent evidence).

Graph Issues is designed to catch the common mass-conservation failures early. Two particularly important messages it can surface:

- **Sibling edges sum over 100% (evidence)**: reported as an **Error** (this should never happen under standard funnel semantics).
- **Sibling edges sum over 100% (mean)**: reported as **Info** when it’s likely a **forecasting artefact for immature data** (the modelled \(p\) can temporarily look “too high” even when evidence is coherent).

Practical fixes to teach:

- If you see a leak: add or verify an explicit **exit / other** edge so the node’s outcomes are complete.
- If you see over-commit: look for overlapping edges/conditionals, and ensure sibling edges are mutually exclusive and collectively exhaustive (MECE) at the user level.
- If conditionals are involved: ensure sibling edges from the same node define the same conditional groups (otherwise interpretation/conservation silently breaks).

### What Graph Issues is not

- It is **not** a data-quality or statistical validity judgement (“this conversion rate is wrong”).
- It does **not** replace domain review; it focuses on **structure, references, and integrity**.

### Where to find it in the UI

- Open it from **View → Graph Issues**.
- Optional: when a graph has debugging enabled, you may also see an **issues indicator overlay** on the graph canvas (top-right). Clicking it opens Graph Issues scoped to that graph.

### How it works (simple mental model)

- It runs a workspace integrity scan in the background and updates the viewer as results change.
- It is **debounced** (changes are grouped) to avoid re-checking on every single keystroke.
- You can always hit **Refresh** in the Graph Issues viewer to force a re-check.

### How to use it (the “three filters” habit)

When something looks wrong, teach participants to do these three steps first:

1. **Filter to the graph** they care about (Graph dropdown).
2. Keep **Include refs** on (so you see issues in referenced files, not just the graph YAML).
3. Start with **Errors only**, then expand to Warnings/Info once errors are cleared.

### Demo (recommended flow)

1. Make a small “controlled mistake”:
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
> - Confirm Graph Issues returns to “✅ No issues found”.

### Discussion prompts

- “If the issue is on a referenced file, why might the graph still ‘look fine’ until you run retrieval/analysis?”
- “Which issues would you treat as a ‘hard stop’ before sharing a chart?”
- “What patterns of edits tend to create issues? (renames, copy/paste, changing IDs, moving files)”

---

## Section 7.7: Snapshots (Data History)

**Duration**: ~5 minutes  
**Mode**: Demo

### What Are Snapshots?

Every time DagNet retrieves data from Amplitude, it stores a **snapshot** — a timestamped record of the daily time-series values at that moment.

### When Snapshots Are Created

Snapshots are created automatically on every successful data retrieval:

- Manual **Fetch** (button or menu)
- **Retrieve All Slices** from the Data menu
- Scheduled automation (if configured)

Each retrieval appends new rows — it does not overwrite previous data.

### Where Snapshots Are Stored

Snapshots are stored in a **server-side database** (not in your browser).

Each snapshot row includes: anchor day, n, k, latency stats (median lag, mean lag, onset), retrieval timestamp, and query signature.

### Managing Snapshots

Access snapshot actions via the **Snapshots** submenu:

- **Edge context menu** → Probability parameter → Snapshots
- **⚡ Lightning menu** (in Properties panel) → Snapshots

| Action | What it does |
|--------|--------------|
| **Download snapshot data** | Export all snapshot rows for this parameter as CSV |
| **Delete snapshots (N)** | Permanently remove all N snapshot retrievals for this parameter |

### Coming Soon

- **As-at queries**: DSL syntax `.asAt(15-Jan-26)` to view evidence as it was known at a historical date
- **Time-series charting**: Visualise how conversion rates have changed over time

---

## Section 8: Putting It Together

**Duration**: ~25 minutes  
**Mode**: Interactive Walkthrough

### Learning objectives

- Add a case node to a real graph and wire variants correctly
- Update parameter files to support new edges/logic
- Define a gate-backed context so scenarios can slice evidence by “in gate” vs “not in gate”
- Create two live scenarios and run a Bridge analysis
- Produce a shareable chart link suitable for embedding

### The Complete Workflow

This section walks through an end-to-end workflow that exercises most of DagNet's key features. We will:

1. Add a case to an existing complex graph
2. Update parameter files accordingly
3. Create a context filter for that case (on vs. off)
4. Update the pinned query to ensure daily updates
5. Build live scenarios to show with/without case traffic
6. Create a reach analysis with bridge chart
7. Share a live link to embed in Notion

### Step 1: Add a Case to the Graph

**What we're doing**: Introducing an A/B test gate node to model an experiment

- Open the target graph
- Add a new case node at the appropriate branch point
- Create two variants (e.g., control/treatment)
- Connect downstream edges from each variant

**Verification needed**: Confirm case node creation and variant wiring works in current build

### Step 2: Update Parameter Files

**What we're doing**: Creating parameter files for the new edges

- Create parameter files for the case variant edges
- Set initial probability estimates
- Attach parameters to the new edges

**Verification needed**: Confirm parameter file creation and edge attachment flow

### Step 3: Create a Context Filter

**What we're doing**: Adding a context dimension that filters Amplitude evidence by whether a Statsig gate was applied to the user (on vs. off).

#### Context file: required syntax + semantics (ActiveGates-backed)

Create a context YAML under `contexts/` in the target repo. Example:

```yaml
id: whatsapp-journey
name: New WhatsApp journey
description: Whether the Statsig gate is on for the user (via Amplitude user property activeGates.*)
type: categorical
otherPolicy: computed
values:
  - id: on
    label: On
    sources:
      amplitude:
        # IMPORTANT: do NOT include "gp:" here. DagNet’s Amplitude adapter will normalise custom user properties
        # to "gp:<field>" automatically.
        #
        # This results in an Amplitude segment like:
        #   { prop: "gp:activeGates.experiment_new_whatsapp_journey", op: "is", values: ["true"] }
        filter: "activeGates.experiment_new_whatsapp_journey == 'true'"

  # With otherPolicy: computed, "other" is defined as NOT(any explicit value).
  # For gates this is the most useful meaning of “off”: includes false + missing/unset.
  - id: other
    label: Off / not in gate
metadata:
  category: behavioral
  data_source: statsig
  created_at: "2026-01-15T00:00:00.000Z"
  version: "1.0.0"
  status: active
```

**Semantics**:

- `context(whatsapp-journey:on)` means “gate flag is true”.
- `context(whatsapp-journey:other)` means “NOT gate flag is true” (including users where the property is absent).

This is intentionally implemented using `otherPolicy: computed` so we don’t need to guess how “false” is represented (and to handle null/unset cleanly).

**Verification needed**: Confirm context file creation and DSL filtering works

#### “Does this really work?” (trainer assurance)

This exact pattern has a local-only real-Amplitude e2e test that proves the end-to-end behaviour:

- context file uses `filter: "activeGates.<gate> == 'true'"` (no `gp:` prefix in YAML)
- DagNet normalises this to an Amplitude segment with `prop: "gp:activeGates.<gate>"`

### Step 4: Update Pinned Query for Daily Updates

**What we're doing**: Ensuring the graph fetches fresh data including case updates

- Review current pinned query configuration
- Ensure case-related edges are included in data fetch scope
- Confirm Statsig connection for case weight updates

**Verification needed**: Confirm scheduled/pinned retrieval includes new edges

### Step 5: Build Live Scenarios

**What we're doing**: Creating scenarios to compare with/without case traffic

- Create scenario: `context(whatsapp-journey:on)` — Shows only in-gate traffic
- Create scenario: `context(whatsapp-journey:other)` — Shows off/not-in-gate traffic
- Set visibility modes appropriately (E only for current behaviour)

**Verification needed**: Confirm context-based scenario DSL filters correctly

#### Suggested scenario naming (helps participants)

- “Gate ON (evidence)” → `context(whatsapp-journey:on)`
- “Gate OFF (evidence)” → `context(whatsapp-journey:other)`

### Step 6: Run Reach Analysis with Bridge Chart

**What we're doing**: Comparing reach between the two case scenarios

- Select the target outcome node
- Run Bridge View analysis with both scenarios visible
- Open the result as a chart tab
- Verify the bridge correctly attributes differences

**Verification needed**: Confirm bridge analysis works with context-based scenarios

### Step 7: Generate Live Share Link

**What we're doing**: Creating a shareable embed for Notion

- Open the Share modal (`File > Share link...`)
- Select the chart tab
- Enable live mode (for daily updates)
- Enable dashboard mode (for clean embed presentation)
- Copy the generated link
- Paste into a Notion page as embed

**Verification needed**: Confirm live chart share generates correctly and loads in embed

---

## Pre-Workshop Verification Checklist

Before running this workshop, verify each step works in the current build:

- [ ] **Case node creation**: Can add a case node with multiple variants
- [ ] **Parameter file creation**: Can create and attach parameter files to new edges
- [ ] **Context file handling**: Can create/update context files and use in DSL
- [ ] **Scenario DSL with context**: `context(key:value)` filters work in scenarios
- [ ] **ActiveGates context**: A context mapping `activeGates.<gate>` works in Amplitude funnels as a user segment (DagNet emits `gp:activeGates.<gate>`)
- [ ] **Graph Issues**: Can open `View > Graph Issues`, filter to the current graph, and navigate to a deliberately broken reference (then fix it)
- [ ] **Bridge analysis**: Works with context-based scenario pairs
- [ ] **Live chart share**: Generates valid URL and loads in dashboard mode
- [ ] **Notion embed**: Live link loads correctly in Notion iframe

### Test Commands

To verify the workflow can be completed:

1. Run the app locally with a test repository
2. Attempt each step in sequence
3. Note any failures or UX issues
4. Update this checklist with current status

---

## Materials Needed

- [ ] Test repository with a suitable existing graph
- [ ] Amplitude credentials configured (for evidence retrieval)
- [ ] Statsig credentials configured (for case weight sync, if using)
- [ ] Notion page for live share testing
- [ ] Backup static shares in case live share has issues

---

## Troubleshooting Guide

### Common Issues

| Issue | Resolution |
|-------|------------|
| "Cohort too recent" | Use cohorts at least 7 days old to ensure evidence maturity |
| Bridge chart shows no delta | Ensure scenarios have different filter criteria and data differs |
| Live share fails to load | Check secret is included; verify GitHub credentials valid |
| Scenarios don't regenerate | Trigger manual regeneration via scenario context menu |

### Fallback Options

If live share is unavailable:
- Use static share for demonstration
- Skip Notion embed step
- Show screenshot of expected embed appearance

---

## Follow-Up Resources

- [User Guide](../graph-editor/public/docs/user-guide.md)
- [Query DSL Reference](../graph-editor/public/docs/query-expressions.md)
- [Keyboard Shortcuts](../graph-editor/public/docs/keyboard-shortcuts.md)
- [Share Links Design](../docs/current/share-graph.md)

---

## Other key areas to explore (5 minutes)

This workshop covers the “core loop” (model → retrieve → compare → explain → share). DagNet has more depth; here are the next areas most users should explore, depending on their role:

- **Contexts in depth (MECE, otherPolicy, aggregation behaviour)**: `graph-editor/public/docs/contexts.md`
- **Scenarios in depth (snapshot types, YAML/JSON editor, flatten)**: `graph-editor/public/docs/scenarios.md`
- **What‑If + conditionals (semantics, pruning/renormalisation intuition)**: `graph-editor/public/docs/what-ifs-with-conditionals.md`
- **Forecast tuning (repo-wide settings, what the knobs mean)**: `graph-editor/public/docs/forecasting-settings.md`
- **Data connections (how retrieval is configured conceptually)**: `graph-editor/public/docs/data-connections.md`
- **Glossary (shared language for the team)**: `graph-editor/public/docs/glossary.md`

We intentionally did **not** cover admin/ops topics (automation scheduling, deep URL parameters, share boot internals) beyond what’s needed for everyday usage.

## Session Feedback

After the workshop, collect feedback on:

1. Which sections were most valuable?
2. Which sections need more depth?
3. Were the hands-on exercises effective?
4. What additional topics should be covered?
5. Was the pace appropriate?

---

*Document version: 1.1 | Created: 15-Jan-26 | Updated: 4-Feb-26*

