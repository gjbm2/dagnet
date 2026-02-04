# DagNet Introduction Workshop -- PART 1 (of 3)

**Audience**: New DagNet users  
**Duration**: ~90–120 minutes (flexible based on interactivity)  
**Prerequisites**: Participants should have access to a browser and be able to view the DagNet application  
**Last updated**: 20-Jan-26


---

## Notes (Read This First)

### What you need prepared

- Access to Dagnet: go to https://dagnet-nine.vercel.app/ and use 1password to set yourself up with access to <private-repo> repo
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
   - Right-click the canvas → **Add node**
   - Or use `Objects > Add Node`
   - Or drag node files from Navigator --- let's do that: 
      - delete the default Start node
      - use the navigator on the left to find 'Household created'
      - drag it into the graph
      - mark it 'start' in the props panel (on the right)
      - now do the same with 'household-delegated'; mark it 'terminal' and 'success' from the dropdown
4. **Connect nodes**:
   - Drag from one node to another
   - Edge appears with default probability
   - Right click to create a 2nd node, and drag connect Start to this one as well
5. **Edit edge properties**:
   - Select edge
   - Use Properties panel to set mean/stdev
   - note the way that 'overridden' is set for your change: this means that it won't get changed automatically
      - clear the override by clicking the override icon 
6. **Understand queries**
   - select node, show event
   - click 'event' connect button to show event file
   - return to graph, select edge, look at props
   - note 'amplitude-prod' is selected as the data source
   - note the 'Data retrieval query' which it has automatically generated
   - right click the edge (or choose zap menu) and choose 'Probability parameter > update from source direct'
7. **Attach parameters**:
   - Drag parameter file from Navigator onto edge
   - Or use edge props to type 'gm-create-to-delegated'
8. **Query the data**
   - Change the live query
   - Point at the edge to show the the n / k data retrieved
9. **Inspect the parameter file**
   - right click on the edge, choose 'open file'
   - open it as a form (takes a few seconds)
   - you can see the metadata and values below
   - right click on the tab, open as YAML (easier way to navigate more complex data)


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
   - Practical: drag an **event file** from Navigator onto a node to set `event_id` (or set `event_id` in the Properties panel).

3. **Pick realistic events**
   - For example:
     - Entry: "household-created”
     - Middle: "household-delegated"
     - Late: "switch-registered"
     - Exit: "switch-success"

4. **Attach a parameter to the edge you’ll retrieve**
   - Create a parameter file for each of your edges

5. **Run retrieval**
   - Choose a cohort window (or the default window if the graph is window-mode).
   - Right-click `middle → exit` → **Get from source**
   

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
