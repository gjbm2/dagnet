# DagNet DSL: Graph Queries & Parameter Addressing

**Version:** 2.0  
**Last Updated:** November 2025

---

## Overview

DagNet uses a family of closely related DSLs to:

- **Select graph structure** (paths, subgraphs, cases)
- **Address parameters** on those structures (probabilities, costs, case variant weights)
- **Drive external data retrieval** (Amplitude, Sheets, etc.)
- **Apply overlays** for scenarios and what‑if analysis

This document defines a unified view of that DSL family and the architectural standards around it. It **replaces** the previous “Query Expression Syntax & Semantics” doc.

At a high level, all DSLs follow the same pattern:

1. **Select a scope (subgraph / elements)** – e.g. `from(a).visited(m).to(z)`
2. **Talk about an aspect of that scope** – e.g. `p.mean`, conditional probability, case variant weight, or external query settings like `window(...)`.

The **identity and structure layer** (how `a`, `z`, `from(a).to(z)` and HRNs like `e.edge-id.p.mean` resolve) is shared across:

- Scenarios (scenario params / overlays)
- Sheets (param packs)
- Analytics queries (Amplitude, dagCalc)
- What‑if / path analysis

Downstream behavior (render vs. query vs. update) is determined by the **consumer**, not by the DSL itself.

---

## Layered Architecture

To keep semantics and implementation clean, we treat the DSL as three layers:

1. **Graph Identity & HRN Layer** – names for nodes, edges, cases, and params
2. **Param Pack DSL Layer** – HRN keys that address *which parameter fields* you are setting/reading
3. **Structural Query Layer** – expressions like `from(...)`, `visited(...)`, `to(...)`, `minus(...)`, `window(...)` that define path/subgraph scopes and query modifiers

### Layer 0: Graph Identity & HRNs

This layer defines how we refer to graph entities in a stable, human‑readable way.

#### Node identifiers

- `node-id` in the graph (e.g. `homepage`, `product-page`)
- Typically:
  - Lowercase with hyphens: `checkout-page`
  - Descriptive: `abandoned-cart-email`
- Must be consistent across:
  - Graph definitions
  - Registry entries
  - External systems (Amplitude event mappings, Sheets, etc.)

#### Edge identifiers & HRNs

Edges can be referenced in multiple equivalent ways:

- **Direct edge ID**:
  - `e.edge-id`
- **By endpoints**:
  - `e.from(node-a).to(node-b)`
  - Resolves to the unique edge from `node-a` to `node-b` (or is rejected/ambiguous if multiple exist).
- **By UUID** (rare in user-facing UI, useful internally):
  - `e.uuid(<uuid>)`

All of these resolve to the same **edge UUID** via the shared `HRNResolver`.

#### Case / node identifiers

Nodes (including case nodes) use:

- `n.node-id`
- `n.uuid(<uuid>)`

Case variants on case nodes are addressed via param‑pack keys (see below).

---

## Layer 1: Param Pack DSL (HRN → Parameter Fields)

The **param pack DSL** is how we refer to specific *parameter fields* on graph entities. It underpins:

- Scenario params (`ScenarioParams`)
- Sheets `param_pack` objects
- Any other external source that wants to “speak in param packs”

### 1.1 HRN prefixes

Param pack keys are always **flat strings** with HRN prefixes:

- `e.<edgeId>.<path>` – edge‑level params
- `n.<nodeId>.<path>` – node‑level/case params

Examples:

- `e.checkout-to-purchase.p.mean`
- `e.checkout-to-purchase.conditional_p.visited(promo).p.mean`
- `n.case-checkout.case(checkout-experiment:control).weight`

### 1.2 Edge param keys

Common paths for edges:

- **Probability parameter**:
  - `e.edge-id.p.mean`
  - `e.edge-id.p.stdev`
- **Conditional probabilities**:
  - `e.edge-id.conditional_p.<condition>.p.mean`
  - `e.edge-id.conditional_p.<condition>.p.stdev`
  - `condition` is a string DSL (e.g. `visited(promo)`), and is the same string used in:
    - Scenario param packs
    - Graph’s `edge.conditional_p[].condition`
- **Costs**:
  - `e.edge-id.cost_gbp.mean`
  - `e.edge-id.cost_time.mean`

The **canonical interpretation** of these keys is implemented by a single DSL/param-pack engine:

- `ScenarioFormatConverter.unflattenParams(flat: Record<string, any>): ScenarioParams`  
  (conceptually this service will be renamed to a more general name like `ParamPackDSLService`, but the function already exists today).
  - It parses flat HRN keys into structured `ScenarioParams`:
    - `edges[edgeId].p`, `edges[edgeId].conditional_p[condition]`, `edges[edgeId].cost_gbp`, etc.

### 1.3 Node / case param keys

Case variant weights on case nodes use a dedicated HRN form:

- `n.<nodeId>.case(<caseId>:<variantName>).weight`

Interpretation:

- “On node `<nodeId>`, inside case `<caseId>`, set the weight for variant `<variantName>`”

`unflattenParams()` turns this into:

- `nodes[nodeId].case.variants = [{ name: variantName, weight: value }, ...]`

### 1.4 Structured representation: `ScenarioParams`

After unflattening, all param packs (from scenarios, Sheets, etc.) share the same **structured representation**:

```ts
type ScenarioParams = {
  edges?: {
    [edgeId: string]: {
      p?: { mean?: number; stdev?: number; /* ... */ };
      conditional_p?: {
        [condition: string]: { mean?: number; stdev?: number; /* ... */ };
      };
      cost_gbp?: { mean?: number; /* ... */ };
      cost_time?: { mean?: number; /* ... */ };
      weight_default?: number;
      // ...
    };
  };
  nodes?: {
    [nodeId: string]: {
      entry?: { entry_weight?: number };
      costs?: { monetary?: number; time?: number };
      case?: {
        variants: Array<{ name: string; weight: number }>;
      };
      // ...
    };
  };
};
```

This is the **single canonical format** used by:

- Scenario overlays (`composeParams`)
- Sheets param packs after ingestion
- Any other HRN‑speaking source

### 1.5 Scope

The **param‑pack engine** (built around `unflattenParams` + composition helpers) supports an optional **scope**:

- Examples of scopes:
  - “This edge + this param slot” (e.g. edge UUID + `p` or `cost_gbp`)
  - “This edge + this condition” (conditional `p` at a specific `condition` string)
  - “This case node” (case variant weights)
- When **scope is provided** (e.g. Sheets direct pull):
  - Params **inside scope** are retained and turned into a structured diff.
  - Params **outside scope** are excluded from this operation (but may be logged as skipped).
- When **no scope is provided** (e.g. scenario overlays):
  - The entire param pack is interpreted; scope is effectively the whole graph parameter space.

---

## Layer 2: Structural Query DSL (Paths & Flows)

The structural DSL answers: **“Which paths / subgraph / users are we talking about?”**

It is primarily used for:

- Analytics queries (e.g. Amplitude funnels, dagCalc)
- Conditional probabilities (“probability of B→C given visited A”)
- Path/journey analysis (“user clicked A, then M, then Z”)

### 2.1 Core verbs

Basic structural query:

```text
from(node-id).to(node-id)
```

Extended with constraints:

- `.visited(node-id)` – paths must visit this node at least once
- `.exclude(node-id)` – paths must **not** visit this node
- `.case(case-id:variant)` – constrain by experiment variant (e.g. Statsig/Amplitude gates)

Example:

```text
from(cart).visited(checkout).to(purchase)
```

Meaning:

- “Paths from `cart` to `purchase` that go through `checkout` at least once.”

### 2.2 Composite queries (`plus` / `minus`)

Composite queries let you build inclusion–exclusion logic:

```text
from(a).to(c)
  .minus( visited(x) )
  .plus( visited(y) )
```

Interpretation:

- Base scope: all paths from `a` to `c`
- Subtract those that visit `x`
- Add those that visit `y`

In the implementation, these are parsed into an AST and executed via a composite query executor (e.g. for Amplitude).

### 2.3 Query modifiers: `window`, `segment`, `context`

These extend the **same structural selector** with additional filters:

- `window(start, end)` – time window for analytics data:
  - E.g. `window(2025-01-01, 2025-12-31)`
- `segment(...)` – cohort/segment constraints (e.g. mobile users only)
- `context(...)` – additional metadata (e.g. scenario, environment, feature flags)

Example:

```text
from(homepage).to(purchase)
  .visited(checkout)
  .window(2025-01-01, 2025-03-31)
```

Meaning:

- “Conversions from homepage to purchase, via checkout, during Q1 2025.”

These modifiers are interpreted by the **analytics adapters** (e.g. Amplitude connector) when building HTTP requests.

---

## Relationships Between Layers

The **identity/HRN layer** and **structural query layer** share the same vocabulary:

- `node-id` and `edge-id` are the same in:
  - HRNs (`e.edge-id`, `n.node-id`)
  - Structural queries (`from(node-id)`, `visited(node-id)`)
- `condition` strings in `conditional_p`:
  - Are the same strings used in:
    - Scenario param packs (HRN keys)
    - Graph `edge.conditional_p[].condition`
    - Conditional probability UIs.

The **param‑pack layer** then uses HRNs to say:

- “Within this scope (possibly implicit), **set these fields**.”

The **query layer** uses the same graph vocabulary to say:

- “Within this scope, **compute / retrieve these metrics**.”

Examples:

- **Scenario overlay**:
  - HRN param pack only:
    - `e.edge-1.p.mean = 0.4`
    - `e.edge-1.conditional_p.visited(promo).p.mean = 0.6`
  - Applied as an overlay (`composeParams`) and not written to graph unless flattened.

- **Sheets param pack (direct edge pull)**:
  - HRN param pack + optional `scalar_value`:
    - Flat HRN map from Sheets → `ScenarioParams` via `unflattenParams(...)`, scoped to the selected edge/param.
  - Structured diff → `{ mean, stdev, n, k, ... }` payload → `UpdateManager.handleExternalToGraph`.

- **Analytics query**:
  - Structural selector + modifiers:
    - `from(cart).to(checkout).window(2025-01-01, 2025-01-31)`
  - Compiled into a provider‑specific HTTP request (e.g. Amplitude funnels API).

---

## Architectural Standards

1. **Single HRN / param‑pack engine**:
   - All DSLs that refer to parameters by HRN must:
     - Use the canonical engine (`ScenarioFormatConverter` today, to be renamed to a general `ParamPackDSLService`) for `flattenParams/unflattenParams`.
     - Use `ScenarioParams` as the canonical structured representation.
   - No second ad‑hoc HRN parsers for Sheets or any other source.

2. **Separation of parsing vs. application**:
   - Parsing/interpretation (HRN → structured diff) is **shared**.
   - Application of diffs is **context‑specific**:
     - Scenarios: overlays via `composeParams`, no graph mutation until flatten.
     - Sheets / external sources: diffs → external payloads → `UpdateManager.external_to_graph` / `external_to_file`.

3. **Scope‑aware ingestion for external sources**:
   - When ingesting from Sheets or similar:
     - Always pass a **scope** (edge/param, node/case, conditional) to `applyScopeToParams`.
     - Only apply params inside scope; log out‑of‑scope keys as skipped/non‑fatal.

4. **Shared condition DSL**:
   - `conditional_p` keys must use the same `condition` strings across:
     - Graph, scenarios, Sheets, and any other DSLs.

5. **Extensibility**:
   - New features (e.g. richer journey DSL, additional query modifiers) must:
     - Reuse the same identity/HRN layer for nodes/edges/cases.
     - Plug into the structural query layer without duplicating core parsing logic.

---

## Runtime Flows & Component Responsibilities

This section ties the DSL layers to the actual runtime components and data flows in DagNet.

### Unified Flow Diagram: Single Canonical DSL Parser for Scenarios and Sheets

```text
                    ┌──────────────────────────────────────────┐
                    │  TWO DIFFERENT ENTRY POINTS:             │
                    │                                          │
                    │  [A] User edits scenario (YAML/JSON)     │
                    │  [B] User imports Sheets range           │
                    └──────────────────────────────────────────┘
                                      │
                 ┌────────────────────┴────────────────────┐
                 │                                         │
                 ▼                                         ▼
    ┌─────────────────────────┐          ┌─────────────────────────────┐
    │ [A] SCENARIO PATH       │          │ [B] SHEETS PATH             │
    └─────────────────────────┘          └─────────────────────────────┘
                 │                                         │
                 │                                         │
    User creates/edits YAML:                  Sheets API returns:
      edges:                                    { scalar_value: 0.7,
        edge-1:                                   param_pack: {
          p:                                        "e.edge-1.p.mean": 0.7,
            mean: 0.7                                "p.stdev": 0.05 },
                                                  errors: [] }
                 │                                         │
                 │                                         │
                 ▼                                         ▼
    ScenarioFormatConverter         DataOperationsService merges
    .fromYAML(content)              scalar + param_pack into flat:
      │                               { "e.edge-1.p.mean": 0.7,
      │                                 "p.stdev": 0.05,
      ├─ Parse YAML → object            "mean": 0.7 }
      ├─ If nested: flatten                      │
      │   to HRN keys                             │
      │                                           ▼
      │                            (ingestion helper normalizes
      │                             relative keys like \"mean\" to
      │                             full HRNs such as
      │                             \"e.edge-1.p.mean\")
      │                                           │
      ▼                                           ▼
    flat HRN map:                   flat HRN map (Sheets-normalized):
    { "e.edge-1.p.mean": 0.7 }      { "e.edge-1.p.mean": 0.7,
                                      "e.edge-1.p.stdev": 0.05 }
                 │                                         │
                 │                                         │
                 └─────────────────┬─────────────────────┘
                                   │
                                   ▼
              ╔═════════════════════════════════════════════════════╗
              ║  ★ CANONICAL DSL PARSER (SINGLE CODE PATH) ★       ║
              ║                                                     ║
              ║  ScenarioFormatConverter.unflattenParams(flat)      ║
              ║                                                     ║
              ║  Parses ALL HRN keys:                               ║
              ║    • e.<edgeId>.<path> → edges[edgeId].<path>       ║
              ║    • n.<nodeId>.<path> → nodes[nodeId].<path>       ║
              ║    • n.<nodeId>.case(<id>:<var>).weight             ║
              ║      → nodes[nodeId].case.variants[{name, weight}]  ║
              ║    • e.<edgeId>.conditional_p.<cond>.p.<field>      ║
              ║      → edges[edgeId].conditional_p[{condition, p}]  ║
              ║                                                     ║
              ║  Returns: ScenarioParams                            ║
              ║    { edges: {...}, nodes: {...} }                   ║
              ╚═════════════════════════════════════════════════════╝
                                   │
                                   │
                 ┌─────────────────┴─────────────────┐
                 │                                   │
                 ▼                                   ▼
    ┌─────────────────────────┐      ┌─────────────────────────────┐
    │ [A] SCENARIO PATH       │      │ [B] SHEETS PATH             │
    │     (continued)         │      │     (continued)             │
    └─────────────────────────┘      └─────────────────────────────┘
                 │                                   │
                 │                                   │
                 ▼                                   ▼
    Full ScenarioParams           ScenarioFormatConverter.applyScopeToParams
    (all edges + nodes)           with scope={kind:'edge-param',edge,slot}
                 │                                   │
                 ▼                                   ▼
    ScenariosContext stores       Extract payload for UpdateManager:
    overlayParams                   { mean: 0.7, stdev: 0.05 }
                 │                                   │
                 ▼                                   ▼
    composeParams(base, overlays) UpdateManager.handleExternalToGraph
    → composed ScenarioParams       (updateData, edge, 'UPDATE', 'parameter')
                 │                                   │
                 ▼                                   ▼
    ScenarioRenderer uses         Write to edge.parameter.p.mean, .stdev
    composed params for           Set provenance: data_source.type='sheets'
    edge widths/beads             Trigger sibling rebalance
                 │                                   │
                 ▼                                   ▼
    ★ NO GRAPH MUTATION ★         ★ GRAPH MUTATION + REBALANCE ★
    (overlay only)                (permanent update)
```

---

### Implementation Status & Outstanding Work (DSL Engine Perspective)

From the DSL perspective, the remaining implementation work to fully realize this design is:

- **Engine generalization & naming**
  - [ ] Rename `ScenarioFormatConverter` to a neutral DSL/param-pack service (e.g. `ParamPackDSLService`) and update all references.
  - [ ] Clearly document in code and docs that this service is the *only* place where HRN param-pack keys are parsed (`unflattenParams`) and scoped (`applyScopeToParams`).

- **Scoping semantics (all relevant situations)**
  - [ ] Implement and test `applyScopeToParams` scope kinds:
    - `graph` → no narrowing (scenario overlays).
    - `edge-param` → a single edge+param slot (`p`, `cost_gbp`, `cost_time`, etc.).
    - `edge-conditional` → a single conditional entry: (edge + `condition` string) narrowing to `conditional_p[condition].p.*`.
    - `node` → node-level params (`entry`, `costs`, etc.).
    - `case` → case variant weights on a specific case node (`n.node.case(<caseId>:<variant>).weight`).
  - [ ] Ensure event-linked params (where used) are resolved via the same HRN/registry identity and can be included/excluded by scope.

- **Sheets and other ingestion flows on top of the engine**
  - [ ] For Sheets edge params:
    - Normalize relative keys (`mean`, `p.mean`, `cost_gbp.mean`) into HRNs.
    - Call `unflattenParams` once, then `applyScopeToParams(scope={edge-param})`.
  - [ ] For Sheets conditional ps:
    - Accept HRN keys like `e.edge-id.conditional_p.visited(promo).p.mean`.
    - Scope to `{kind:'edge-conditional', edge, condition}` and feed the resulting diff into `UpdateManager` as `conditional_p[i].p`.
  - [ ] For Sheets node/case params:
    - Accept HRN keys like `n.case-node.case(exp:control).weight` and node params like `n.node.entry.weight`.
    - Scope to `{kind:'case'}` / `{kind:'node'}` and reuse the existing `external_to_graph('case' | 'node')` codepaths.

- **Tests**
  - [ ] Unit tests for the DSL engine itself:
    - `unflattenParams` round-trips for all key shapes (edges, conditionals, nodes, cases, events).
    - `applyScopeToParams` for all scope kinds (graph, edge-param, edge-conditional, node, case).
  - [ ] Integration tests for:
    - Scenarios: ensure existing scenario flows still use `unflattenParams` and overlays behave identically after the rename/refactor.
    - Sheets: ensure all of the above scope types are correctly honored when ingesting param packs (edge p/cost, node, case, conditional p).
    - Negative cases: invalid HRNs, out-of-scope keys, and conflicting scalar/pack combinations.

These TODOs should be kept in sync with the more detailed, connector-specific checklist in `GOOGLE_SHEETS_HRN_INTEGRATION.md`.

---

### Critical Architecture Point

**The diagram above shows that there is ONE AND ONLY ONE place where HRN/DSL keys are parsed:**

```
ScenarioFormatConverter.unflattenParams(flat: Record<string, any>): ScenarioParams
```

**Both scenarios and Sheets call this same function.** The differences are:

1. **Input preparation:**
   - Scenarios: YAML/JSON → object → flatten to HRN map → `unflattenParams`
   - Sheets: raw range → scalar/param_pack → merge + normalize relative keys → `unflattenParams`

2. **Output usage:**
- Scenarios: full `ScenarioParams` → store as overlay → compose for rendering (no mutation).
- Sheets (and other external sources): full `ScenarioParams` → `ScenarioFormatConverter.applyScopeToParams` to narrow to a specific scope (edge/slot, node/case, conditional, etc.) → extract `{mean, stdev, variants, ...}` → `UpdateManager` (mutation).

**There is no second DSL parser.** Ingestion helpers do **not** parse HRN semantics; they only normalize shorthand keys (e.g. `mean` → `e.edge-1.p.mean`) and decide which `applyScopeToParams` scope to use before handing the result to `UpdateManager`.

### Scenarios (Overlays / What‑If)

**Goal**: Let users define param overlays (including conditionals and case variants) without mutating the live graph until they explicitly flatten.

**Flow**:

1. **Graph → base ScenarioParams**
   - Component: `GraphParamExtractor.extractParamsFromGraph(graph)`
   - Output: `baseParams: ScenarioParams` (edges + nodes + conditional_p + case variants).

2. **Scenario content (YAML/JSON) → ScenarioParams**
   - Components: `ScenarioFormatConverter.fromYAML` / `fromJSON`
   - Internals:
     - Parse YAML/JSON into an object.
     - If structure is `nested`, call `parseNestedHRN()` to produce a flat HRN map.
     - Call `unflattenParams(flat)` to get a structured `ScenarioParams`.
   - Validation: `ScenarioValidator.validateScenarioParams(params, graph)` uses `HRNResolver` to check all `e.*` / `n.*` keys against the graph.

3. **Store overlays**
   - Component: `ScenariosContext`
   - Keeps:
     - `baseParams: ScenarioParams`
     - `scenarios[i].params: ScenarioParams` (overlays)

4. **Compose overlays for rendering**
   - Components: `CompositionService.composeParams`, `mergeEdgeParams`, `mergeNodeParams`
   - For a given visible scenario (or the combined What‑If view):

     ```ts
     const composed = composeParams(baseParams, [overlay1, overlay2, ...]);
     ```

   - Semantics:
     - Edge `p`, `conditional_p`, `cost_gbp`, `cost_time`, etc. are merged deterministically.
     - Node `case.variants` and other node params merge per `mergeNodeParams`.

5. **Render, without mutating graph**
   - Components: `ScenarioRenderer`, `GraphCanvas`, bead/label helpers
   - Use `composed` to compute:
     - Edge widths / colors
     - Conditional beads
     - Case variant weights for visualization
   - The live `Graph` stays untouched until/unless the user explicitly invokes flatten or a sync operation that writes back via `UpdateManager`.

### Sheets (External Data Ingestion)

**Goal**: Let Sheets provide param updates (including HRN param packs) while reusing the same DSL/HRN semantics as scenarios, but applying them through the ingestion pipeline.

**Flow**:

1. **Sheets API → DASRunner**
   - Components:
     - `DASRunner` with `sheets-readonly` connection.
     - Adapter uses `parseSheetsRange(values)` to emit:
       - `scalar_value` (Pattern A)
       - `param_pack` (Patterns B/C, flat HRN-like map)
       - `errors`.

2. **DataOperationsService entry point**
   - Component: `DataOperationsService.getFromSourceDirect`
   - Context:
     - `objectType: 'parameter'` (for now)
     - `targetId: edgeId`
     - `paramSlot: 'p' | 'cost_gbp' | 'cost_time'`
   - Receives:
     - `result.raw.scalar_value`
     - `result.raw.param_pack`
     - `result.raw.errors`

3. **Merge scalar and param_pack into flat pack**

   ```ts
   const mergedFlat: Record<string, unknown> = {
     ...(param_pack || {}),
     // In single/auto modes, treat scalar_value as mean if no explicit mean present
     ...(shouldUseScalar ? { mean: scalar_value } : {})
   };
   ```

   - This is the same flat HRN map shape that scenarios use, plus some **relative** keys (`mean`, `p.mean`, etc.) that are interpreted in context.

4. **Canonical HRN parsing + scoping**
   - Components:
     - Ingestion helper inside `DataOperationsService` (normalizes relative keys like `mean` → `e.edge-1.p.mean`).
     - `ScenarioFormatConverter.unflattenParams(flat)` (canonical DSL parser).
     - `ScenarioFormatConverter.applyScopeToParams(params, scope, graph)` (canonical scoping).

   ```ts
   const fullParams = ScenarioFormatConverter.unflattenParams(mergedFlat);
   const scopedParams = ScenarioFormatConverter.applyScopeToParams(
     fullParams,
     { kind: 'edge-param', edgeUuid: edge.uuid, edgeId: edge.id, slot: paramSlot || 'p' },
     graph
   );
   ```

   - Responsibilities:
     - Normalize relative keys (`mean`, `p.mean`, `cost_gbp.mean`) into full HRNs for the current edge+slot.
     - Parse all HRNs into a full `ScenarioParams` object via `unflattenParams`.
     - Narrow that `ScenarioParams` to the requested scope (here, one edge+slot) via `applyScopeToParams`.

5. **Scoped ScenarioParams diff → ingestion payload**
   - Component: `extractSheetsUpdateData`
   - Reads the scoped `ScenarioParams` and converts to schema terms:

   ```ts
   const edgeParams = scopedParams.edges?.[edgeKey];
   if (slot === 'p' && edgeParams.p) {
     update.mean = edgeParams.p.mean;
     update.stdev = edgeParams.p.stdev;
   }
   // similarly for cost slots and future extensions like n/k
   ```

   - Output: `{ mean?, stdev?, n?, k? }` — the same shape Amplitude and other sources use.

6. **Apply via UpdateManager (same as other external sources)**
   - Component: `UpdateManager.handleExternalToGraph('parameter')`

   ```ts
   const updateResult = await updateManager.handleExternalToGraph(
     updateData,
     targetEdge,
     'UPDATE',
     'parameter',
     { interactive: false }
   );
   ```

   - Responsibilities:
     - Map `mean`, `stdev`, `n`, `k` into:
       - `edge.p.mean`, `edge.p.stdev`
       - `edge.p.evidence.n`, `edge.p.evidence.k`
       - `edge.p.data_source`, etc.
     - Handle overrides, conflicts, and provenance.
     - Trigger sibling rebalance where appropriate.

### Shared vs Distinct Responsibilities

- **Shared, canonical path (DSL & param packs)**:
  - `ScenarioFormatConverter.flattenParams / unflattenParams`
  - `ScenarioParams` and `CompositionService` merge semantics
  - HRN and condition string interpretation for:
    - `e.*` (edges, including `conditional_p`)
    - `n.*` (nodes, including case variants)

- **Scenario-specific behavior**:
  - Uses `ScenarioParams` purely as overlays for rendering and what‑if analysis.
  - Does **not** mutate the graph until an explicit flatten or sync operation is invoked.

- **Sheets/external-specific behavior**:
  - Uses the same `ScenarioParams` representation to build **ingestion payloads**.
  - Mutates graph/files only via `UpdateManager.external_to_graph` / `external_to_file`.
  - Must always specify a **scope** (edge/slot, and in future conditional/case scopes) so that out‑of‑scope params in a pack are excluded for that operation.

from(homepage).to(purchase).case(pricing-test:treatment, ui-redesign:variant-b)
```
*Meaning:* Users in BOTH the pricing treatment AND UI variant B.

**Real-world scenario:**
```
Experiment: "checkout-flow-v2"
Variants: control, simplified, express

Query: from(cart).to(purchase).case(checkout-flow-v2:simplified)
Result: Conversion rate for simplified checkout variant only
```

---

## Semantics & Evaluation

### Path Matching

A query expression defines a **filter** over all possible paths in the graph.

**Matching Algorithm:**
```
1. Find all paths from source to target
2. For each path P:
   a. If any node in .exclude() is in P → reject
   b. If any node in .visited() is NOT in P → reject
   c. If case variant doesn't match → reject
   d. Otherwise → accept
3. Query results = union of all accepted paths
```

### Logical Interpretation

**Constraints are ANDed:**
```
from(a).to(b).exclude(c).visited(d)
```
Means: 
- Start at A AND
- End at B AND
- NOT visit C AND
- DO visit D

**Multiple items in one constraint are ORed:**
```
.exclude(c, d)  →  NOT (visit C OR visit D)
.visited(c, d)  →  visit C AND visit D  (both required)
```

---

## Minimality & Validation

### Minimal Constraints

**Principle:** Use the **minimum** number of constraints needed to uniquely identify your path.

**Why:**
- Simpler queries are easier to understand
- Less brittle when graph structure changes
- Better for debugging

**Example:**

```
Graph: A → B → C → D
       A → E → D

Query 1 (over-specified):
  from(a).to(d).visited(b).visited(c).exclude(e)

Query 2 (minimal):
  from(a).to(d).exclude(e)

Both identify the same path, but Query 2 is better.
```

**DagNet's MSMDC Algorithm:** Automatically generates minimal queries for you.

### Validation

**Queries are validated on:**

1. **Ambiguity:** Does the query match multiple paths?
   - ⚠️ Warning: "Query matches 3 paths. Consider adding `.exclude(node-x)`"
   
2. **Empty Results:** Does the query match NO paths?
   - ❌ Error: "No path matches this query. Check node IDs."
   
3. **Missing Nodes:** Are all referenced nodes in the graph?
   - ❌ Error: "`node-xyz` not found in graph or registry."

4. **Redundancy:** Are there unnecessary constraints?
   - 💡 Info: "`.visited(b)` is redundant (only one path through B)."

---

## Common Patterns

### 1. Direct vs. Indirect Paths

**Scenario:** Users can checkout directly or go through cart first.

```
Graph:
  product → checkout → purchase
  product → cart → checkout → purchase
```

**Direct conversions:**
```
from(product).to(purchase).exclude(cart)
```

**Cart-based conversions:**
```
from(product).to(purchase).visited(cart)
```

---

### 2. Email Campaign Effectiveness

**Scenario:** Measure conversions driven by email clicks.

```
Graph:
  homepage → product → purchase
  email-click → product → purchase
```

**Email-driven conversions:**
```
from(product).to(purchase).visited(email-click)
```

**Organic conversions (no email):**
```
from(product).to(purchase).exclude(email-click)
```

---

### 3. Experiment Analysis

**Scenario:** A/B test with different landing pages.

```
Experiment: "hero-image-test"
Variants: control, lifestyle, product-focus
```

**Treatment group conversion:**
```
from(landing-page).to(signup).case(hero-image-test:lifestyle)
```

**Control group conversion:**
```
from(landing-page).to(signup).case(hero-image-test:control)
```

---

### 4. Sequential Engagement

**Scenario:** Users who engaged with content before converting.

```
Graph:
  homepage → blog-post → product → purchase
  homepage → product → purchase
```

**Content-engaged conversions:**
```
from(product).to(purchase).visited(blog-post)
```

---

## Advanced Usage

### Combining Multiple Constraints

**Complex filtering:**
```
from(homepage).to(purchase)
  .visited(product-page, reviews-page)
  .exclude(support-chat, help-center)
  .case(pricing-test:treatment)
```

**Meaning:**
- Users who viewed product page AND reviews
- But didn't visit support
- And were in the pricing test treatment

---

### Parameter Packs

**Group related parameters with shared constraints:**

```yaml
# parameter-pack.yaml
pack_id: checkout-funnel-treatment
base_query: "from(cart).case(checkout-flow-v2:simplified)"
parameters:
  - param_id: cart-to-shipping
    query: "${base_query}.to(shipping)"
  - param_id: shipping-to-payment
    query: "${base_query}.to(payment)"
  - param_id: payment-to-complete
    query: "${base_query}.to(purchase)"
```

This retrieves all three parameters with consistent case filtering.

---

### Python Integration (dagCalc, Bayesian Models)

**Use the same syntax in Python:**

```python
# dagcalc/query_parser.py
from dagnet.query import parse_query

query = parse_query("from(a).to(b).exclude(c)")

# Execute against Amplitude
results = amplitude_client.query(
    start_event=query.from_node,
    end_event=query.to_node,
    exclude_events=query.excluded_nodes
)

# Use in Bayesian models
prior = get_parameter("conversion-rate")
likelihood = query_results_to_likelihood(results, query)
posterior = bayesian_update(prior, likelihood)
```

---

## Reference Implementation

### TypeScript

```typescript
interface QueryExpression {
  from: string;
  to: string;
  exclude?: string[];
  visited?: string[];
  cases?: Array<{ caseId: string; variant: string }>;
}

function parseQuery(expr: string): QueryExpression {
  // Parse "from(a).to(b).exclude(c).visited(d).case(e:f)"
  // Returns structured object
}

function validateQuery(
  query: QueryExpression, 
  graph: Graph
): ValidationResult {
  // Check ambiguity, empty results, missing nodes
}

function matchesPath(query: QueryExpression, path: string[]): boolean {
  // Returns true if path satisfies query constraints
}
```

---

## Grammar (Formal)

```ebnf
query ::= from-clause to-clause modifier*

from-clause ::= "from(" node-id ")"
to-clause   ::= "to(" node-id ")"

modifier ::= exclude-clause | visited-clause | case-clause

exclude-clause ::= ".exclude(" node-list ")"
visited-clause ::= ".visited(" node-list ")"
case-clause    ::= ".case(" case-list ")"

node-list ::= node-id ("," node-id)*
case-list ::= case-spec ("," case-spec)*
case-spec ::= case-id ":" variant-id

node-id    ::= [a-z0-9] [a-z0-9-]*
case-id    ::= [a-z0-9] [a-z0-9-]*
variant-id ::= [a-z0-9] [a-z0-9-]*
```

**Key Rules:**
- Whitespace is ignored
- IDs are lowercase alphanumeric with hyphens
- Order of clauses doesn't matter (except for readability)
- Duplicate clauses are invalid (e.g., two `.from()` calls)

---

## FAQ

### Q: Can I use event names instead of node IDs?

**A:** No. Query expressions use `node_id` (graph-level identifiers). Events are mapped to nodes via `node.event_id`, but queries operate at the graph topology level.

**Why:** This keeps param files self-contained and graph-centric.

---

### Q: What if I delete a node that's referenced in a query?

**A:** The query becomes invalid. DagNet's graph validation service will:
1. Detect the broken reference on save
2. Show a warning: "Query references deleted node `xyz`"
3. Suggest either updating the query or reconnecting the node

---

### Q: Can I specify "OR" logic (e.g., visit A or B)?

**A:** Not in v1. Constraints are always ANDed. If you need OR logic, create separate parameters with different queries.

**Future:** May add `visited(a | b)` syntax if use cases emerge.

---

### Q: How do I know if my query is minimal?

**A:** DagNet's MSMDC algorithm automatically generates minimal queries. If you edit manually, the validator will show an info hint if it detects redundant constraints.

---

### Q: Can I test a query without retrieving data?

**A:** Yes! The query editor shows real-time validation:
- ✅ Green: Valid, unambiguous
- ⚠️ Yellow: Valid but ambiguous (suggests fixes)
- ❌ Red: Invalid (broken references, syntax errors)

---

## Best Practices

### 1. Let Auto-Generation Do Its Job

**Default behavior:** When you connect a parameter to an edge, DagNet auto-generates the query.

**When to override:**
- You want a specific conditional probability
- You're analyzing a particular experiment variant
- You need custom filtering beyond topology

**Track state:** Queries are marked `query_auto_generated: true/false` so you know which are manual.

---

### 2. Use Descriptive Node IDs

**Good:**
```
from(product-detail-page).to(add-to-cart)
```

**Bad:**
```
from(pdp).to(atc)
```

Readable queries are easier to debug and share with teammates.

---

### 3. Avoid Over-Specification

**Over-specified:**
```
from(a).to(d).visited(b).visited(c).exclude(e)
```

**Minimal:**
```
from(a).to(d).exclude(e)
```

If there's only one path through B and C, specifying them is redundant.

---

### 4. Document Complex Queries

If a query has multiple constraints, add a comment in the parameter file:

```yaml
# parameters/conversion-rate-email-engaged.yaml
query: "from(product).to(purchase).visited(email-click).exclude(support-chat)"
description: "Conversion rate for email-driven users who didn't need support"
```

---

### 5. Test Before Committing

Before committing parameter changes:
1. Use "Validate Graph" to check all queries
2. Review warnings/suggestions
3. Test data retrieval on a single param
4. Then batch-update

---

## Related Documentation

- **[MSMDC Algorithm](./query-algorithms-white-paper.md#1-msmdc-minimal-set-of-maximally-discriminating-constraints):** Technical deep-dive on automatic query generation
- **[Query Factorization](./query-algorithms-white-paper.md#2-query-factorization-for-batch-optimization):** Batch optimization for efficient API calls
- **[Implementation Plan](../../../DATA_CONNECTIONS_IMPLEMENTATION_PLAN.md):** Roadmap for data connections system
- **[Parameter Schema](../../public/param-schemas/parameter-schema.yaml):** Full parameter file structure

---

**Version History:**
- **1.0** (Nov 2025): Initial release

**Maintained by:** DagNet Team  
**Questions?** See [DATA_CONNECTIONS_README.md](../../../DATA_CONNECTIONS_README.md)

