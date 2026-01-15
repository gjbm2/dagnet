# DagNet Introduction Workshop

**Audience**: New DagNet users  
**Duration**: ~90–120 minutes (flexible based on interactivity)  
**Prerequisites**: Participants should have access to a browser and be able to view the DagNet application  
**Last updated**: 15-Jan-26

---

## Facilitator Notes (Read This First)

### Intended tone

- This is a **working session**, not a lecture. Keep the pace brisk and default to hands-on.
- Encourage participants to ask “what does DagNet believe?” at each stage (probabilities, evidence, forecast, assumptions).

### What you need prepared

- A repository with:
  - at least one “real” graph that matches your domain
  - parameter files connected to Amplitude (or a test dataset)
  - one known Statsig gate that appears in Amplitude as an `activeGates.*` user property
- A Notion page for the final share/embed step (or a placeholder doc if Notion isn’t available)

### Conventions used in this doc

- **Graph**: DAG structure (nodes/edges/layout) stored in `graphs/*.json`
- **Parameter**: evidence + forecast inputs stored in `parameters/*.yaml`
- **Context**: a dimension for slicing evidence via `context(key:value)` in DSL, defined in `contexts/*.yaml`
- **Case**: experiment allocation modelling and variant branching, defined in `cases/*.yaml`

## Workshop Goals

By the end of this session, participants will:
1. Understand what a DAG is and why probabilistic graph analysis matters
2. Know where data lives in DagNet and how the system works
3. Be able to create and edit graphs
4. Understand evidence vs. forecast modes
5. Know how to use cases for A/B test modelling
6. Be able to create and compare scenarios
7. Run analyses and create charts
8. Complete an end-to-end workflow adding a case to a real graph

---

## Agenda Overview

| Section | Topic | Duration | Mode |
|---------|-------|----------|------|
| 1 | What is a DAG? Why DagNet? | 10 min | Presentation |
| 2 | Tool Architecture & Data Flow | 15 min | Presentation |
| 3 | Build a graph: nodes, edges, **events**, first retrieval | 20 min | **Interactive** |
| 4 | Evidence & Forecasts (LAG) | 15 min | Demo + Discussion |
| 5 | Cases & A/B Tests | 10 min | Demo |
| 6 | Scenarios as layers + What‑If + conditional probabilities | 25 min | **Interactive** |
| 7 | Analysis & Charting | 15 min | **Interactive** |
| 8 | Putting It Together | 25 min | **Interactive Walkthrough** |

---

## Section 1: What is a DAG? Why DagNet?

**Duration**: ~10 minutes  
**Mode**: Presentation

### Learning objectives

- Understand DAGs as a modelling tool for user journeys and uncertain transitions
- Understand what DagNet adds beyond standard analytics tools
- Build an intuition for “probability flow” and “latency-aware conversion”

### What is a DAG?

A **Directed Acyclic Graph** is a network of nodes connected by one-way edges with no cycles. In DagNet's context:

- **Nodes** represent states, events, or decision points in a user journey
- **Edges** represent probabilistic transitions between nodes
- **Direction** indicates flow (users move from one state to another)
- **Acyclic** means no loops — users don't go backwards in the same path

### What DagNet is (in one sentence)

DagNet is a **probabilistic, latency-aware funnel simulator** that lets you model user journeys as graphs, attach evidence from live sources, and compare scenarios in a way that stays shareable and reproducible.

### Why Not Just Use Amplitude/Looker/etc.?

| Capability | Traditional BI | DagNet |
|------------|----------------|--------|
| Static conversion rates | ✅ | ✅ |
| Time-indexed flow (latency) | ❌ | ✅ |
| Evidence vs. Forecast split | ❌ | ✅ |
| What-if scenario comparison | Limited | ✅ |
| A/B test allocation modelling | Manual | ✅ |
| Conditional probabilities | ❌ | ✅ |
| Path-aware reach analysis | ❌ | ✅ |
| Shareable live dashboards | ❌ | ✅ |

**Key insight**: Traditional tools answer "What is the conversion rate?" DagNet answers "When will users convert, and what happens if we change X?"

### The Core Question DagNet Answers

> "Given the current state of the funnel and historical patterns, what is the probability of reaching outcome Y by time T, and how would changes to X affect that?"

### Talking points (script)

- “A funnel in Amplitude is a query; a funnel in DagNet is a **model**.”
- “Models can be versioned, reviewed, and shared as a first-class artefact.”
- “DagNet separates: what we **saw** (evidence) vs what we **expect** (forecast) — and forces us to be explicit about uncertainty.”
- “The moment you have branching, experiments, or time-to-convert effects, a single conversion rate is an incomplete story.”

### Quick check for understanding (1 minute)

Ask:
- “Where is the uncertainty in your funnel today?”
- “Which step is most time-delayed (latency)?”
- “Which decisions are experiment-driven (cases) vs naturally segmented (contexts)?”

---

## Section 2: Tool Architecture & Data Flow

**Duration**: ~15 minutes  
**Mode**: Presentation

### Learning objectives

- Know which files represent which pieces of the model (graph vs parameters vs contexts vs cases)
- Understand how DagNet stays reproducible (Git as source of truth, IndexedDB as working store)
- Understand what “fetching evidence” actually does

### Where Does Data Live?

```
┌─────────────────────────────────────────────────────────┐
│                    GitHub Repository                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │
│  │   graphs/   │  │ parameters/ │  │  contexts/  │      │
│  │  *.json     │  │   *.yaml    │  │   *.yaml    │      │
│  └─────────────┘  └─────────────┘  └─────────────┘      │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐                       │
│  │   cases/    │  │   nodes/    │                       │
│  │   *.yaml    │  │   *.yaml    │                       │
│  └─────────────┘  └─────────────┘                       │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼ Pull / Push
┌─────────────────────────────────────────────────────────┐
│                      DagNet App                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │                   IndexedDB                      │    │
│  │  (Local cache, dirty state, workspace state)    │    │
│  └─────────────────────────────────────────────────┘    │
│                          │                              │
│                          ▼                              │
│  ┌─────────────────────────────────────────────────┐    │
│  │              FileRegistry (in-memory)            │    │
│  │      (Fast access for open tabs & editors)       │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼ Fetch Evidence
┌─────────────────────────────────────────────────────────┐
│              External Data Sources                       │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ Amplitude │  │ Google Sheets │  │   Statsig    │       │
│  │ (Funnels) │  │ (Parameters)  │  │   (Cases)    │       │
│  └──────────┘  └──────────────┘  └──────────────┘       │
└─────────────────────────────────────────────────────────┘
```

### Key Concepts

1. **Graphs** (`.json`) — The visual DAG structure: nodes, edges, layout
2. **Parameters** (`.yaml`) — Edge probability data, evidence, latency settings
3. **Contexts** (`.yaml`) — Dimensions for slicing data (e.g., channel, device)
4. **Cases** (`.yaml`) — A/B test / experiment definitions
5. **Nodes** (`.yaml`) — Reusable node definitions

### Data Flow Principle

**GitHub is the source of truth** for definitions. **IndexedDB** holds local working state. **External sources** provide evidence (n/k/probability data).

### How to think about “saving” in DagNet

- **Editing** writes to **IndexedDB immediately** (fast iteration, offline-first).
- **Sharing and collaboration** happens when you **commit** back to the repo.
- **Fetching evidence** updates parameter/case files (depending on configuration), then the graph reads from those files.

### Mental model: three layers

- **Definition layer (repo)**: what the model is (graph, parameter definitions, context mappings, cases)
- **Working layer (IndexedDB)**: your local state (open tabs, dirty changes, cached slices)
- **Evidence layer (external)**: Amplitude/Statsig/Sheets provide the measured or configured values

### Common confusion to pre-empt

- “If I change a graph edge probability in the UI, does that update Amplitude?”
  - No. DagNet is **one-way** from external sources into your model. Your model can be used for reasoning and planning; you still ship changes via product/engineering systems.

---

## Section 3: Creating & Editing Graphs

**Duration**: ~20 minutes  
**Mode**: Interactive

### Learning objectives

- Create and edit a graph quickly (nodes/edges/layout)
- Understand how node identity and edge identity matter for evidence attachment
- Learn the “fast paths”: drag/drop, copy/paste from Navigator
- Understand the concept of **events** (how nodes map to provider events) and how retrieval works at a high level

### Demo Walkthrough

1. **Open the Navigator** (`Ctrl/Cmd + B`)
2. **Create a new graph** (`File > New Graph`)
3. **Add nodes**:
   - Double-click canvas to create
   - Or drag node files from Navigator
4. **Connect nodes**:
   - Drag from one node to another
   - Edge appears with default probability
5. **Edit edge properties**:
   - Select edge
   - Use Properties panel to set mean/stdev
6. **Attach parameters**:
   - Drag parameter file from Navigator onto edge
   - Or right-click edge → Attach parameter

### Hands-On Exercise 1 (core): Build a small graph and run a first retrieval

> **Task**: Create a simple 3-node funnel: Entry → Middle → Exit, then wire it to real provider events and retrieve evidence for one edge.
>
> - Build the graph on the canvas.
> - Assign a concrete event to each node (see steps below).
> - Connect a parameter to one edge and run **Get from source**.

#### Step-by-step (facilitator script)

1. **Create the graph**
   - Nodes: `entry`, `middle`, `exit`
   - Edges: `entry → middle`, `middle → exit`

2. **Assign events to nodes (conceptual model)**
   - Each conversion node corresponds to a provider event definition (e.g., an Amplitude event + optional property filters).
   - In DagNet, those are stored as **event files** (`events/*.yaml`) and attached/selected in the node’s properties.

3. **Pick realistic events**
   - For example:
     - Entry: “Signed Up”
     - Middle: “Viewed Pricing”
     - Exit: “Purchased”

4. **Attach a parameter to the edge you’ll retrieve**
   - Attach a parameter file to `middle → exit` (this is where evidence `(n,k)` will land).

5. **Run retrieval**
   - Right-click `middle → exit` → **Get from source**
   - Choose a cohort window (or the default window if the graph is window-mode).

#### What retrieval is actually doing (explain in plain English)

- DagNet takes the events on the nodes, plus the edge you asked for, and constructs a provider query (for Amplitude this is typically a funnel).
- The query produces counts:
  - \(n\): users who reached the source step
  - \(k\): users who reached the next step
- DagNet stores those values (and sometimes daily arrays for LAG) into the **parameter file**, then displays the derived probability on the edge.

#### Expected outcome (for facilitator)

- Participants should see the edge tooltip populated with **evidence** (`n`, `k`) and a corresponding probability.
- Use this moment to stress: “the graph is a model, but evidence is coming from real tracked events”.

#### Expected outcome (for facilitator)

Participants should compute \(0.6 \times 0.4 = 0.24\) and then confirm DagNet reports ~24% reach.

> Note: this probability is just a toy baseline. After retrieval, the real edge p.mean will be driven by evidence/forecast depending on the edge type and maturity.

### Practical tips (what to emphasise)

- **Naming**: pick stable IDs; renames have downstream impact (queries, contexts, parameter references).
- **Layout**: keep flow left-to-right where possible; it makes later analysis easier.
- **Small steps**: build a correct small DAG first, then expand.

### Key Takeaways

- Nodes represent states, edges represent probabilistic transitions
- Parameters can be attached to edges for live data updates
- The Properties panel shows and edits all element properties
- Events are the bridge between a visual node and “what the data source can measure”

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

*Document version: 1.0 | Created: 15-Jan-26*

