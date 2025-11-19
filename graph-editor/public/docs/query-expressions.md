# DagNet DSL: Graph Queries & Parameter Addressing

**Version:** 2.0  
**Last Updated:** November 2025

---

## Overview

This document defines the **unified DSL (Domain Specific Language)** used throughout DagNet for:

1. **Identifying graph entities** (edges, nodes, cases) via Human-Readable Names (HRNs)
2. **Addressing parameters** on those entities (e.g., `e.edge-id.p.mean`, `n.node-id.case(exp:ctrl).weight`)
3. **Querying analytics data** via structural path expressions (e.g., `from(a).visited(m).to(z).window(...)`)

The DSL operates in **layers**, with a shared identity/HRN foundation and context‑specific extensions for param packs vs analytics queries.

**Critical architectural principle**: There is **one canonical parser** for HRN param packs (`ParamPackDSLService.unflattenParams`), used by both scenarios and external data sources (e.g., Google Sheets). No duplicate DSL parsing logic exists.

---

## Layers

### Layer 0: Graph Identity & HRNs

**Purpose**: Provide unambiguous, human-readable references to graph entities.

**Syntax**:
- Edges: `e.<edge-id>` or `e.from(<node-id>).to(<node-id>)`
- Nodes: `n.<node-id>`
- Cases (A/B tests): `n.<case-node-id>.case(<case-id>:<variant-name>)`

**Examples**:
- `e.checkout-to-purchase` → edge by id
- `e.from(cart).to(purchase)` → edge by topology
- `n.homepage` → node by id
- `n.promo-gate.case(pricing-test:treatment)` → case variant

**Resolver**: `HRNResolver` provides `resolveEdgeHRN`, `resolveNodeHRN`, `resolveAllHRNs` to map HRNs to UUIDs.

---

### Layer 1: Param Pack DSL (Parameters & Overlays)

**Purpose**: Address specific parameter fields on graph entities for reading/writing values (scenarios, Sheets, etc.).

**Syntax**:
- Edge probability: `e.<edge-id>.p.mean`, `e.<edge-id>.p.stdev`
- Edge costs: `e.<edge-id>.cost_gbp.mean`, `e.<edge-id>.cost_time.mean`
- Conditional probabilities: `e.<edge-id>.conditional_p.<condition>.p.mean`
- Case variant weights: `n.<node-id>.case(<case-id>:<variant>).weight`
- Node entry weights: `n.<node-id>.entry.weight`

**Structure**: Param packs are internally represented as `ScenarioParams`:
```typescript
{
  edges: { [edgeId: string]: { p?: {mean, stdev, ...}, conditional_p?: [...], cost_gbp?: {...}, ... } },
  nodes: { [nodeId: string]: { case?: { variants: [{name, weight}] }, ... } }
}
```

**Canonical parser**:
```typescript
ParamPackDSLService.unflattenParams(flat: Record<string, any>): ScenarioParams
```

This function is the **single source of truth** for all HRN→param mapping. It handles:
- `e.*` (edges, including nested paths like `e.edge-id.p.mean`)
- `n.*` (nodes, including `case(...)` syntax)
- `conditional_p` condition strings

**Scope support**: When ingesting from external sources (e.g., Sheets), a **scope** (edge+slot, node/case, conditional) is applied to drop out-of-scope params, preventing unintended updates.

**Consumers**:
- **Scenarios**: use param packs as overlays (non-mutating) via `CompositionService.composeParams`
- **Sheets / external data**: use param packs to build ingestion payloads, then apply via `UpdateManager.handleExternalToGraph` (mutating)

---

### Layer 2: Structural Query DSL (Analytics & Path Selection)

**Purpose**: Describe path constraints and filters for analytics queries (Amplitude, etc.) and journey analysis.

**Syntax**:
- **Core**: `from(<node-id>).to(<node-id>)`
- **Path constraints**: `.visited(<node-id>)`, `.exclude(<node-id>)`
- **Case filters**: `.case(<case-id>:<variant>)`
- **Set operations**: `.plus(...)`, `.minus(...)`
- **Analytics modifiers**: `.window(<start>, <end>)`, `.segment(<segment-id>)`, `.context(<key>:<value>)`

**Examples**:
- `from(product).to(checkout)` → all paths from product to checkout
- `from(product).to(checkout).visited(promo)` → conditional probability (paths via promo node)
- `from(homepage).to(purchase).case(pricing-test:treatment)` → paths for a specific A/B test variant
- `from(cart).to(purchase).window(2025-01-01, 2025-12-31)` → time-filtered analytics query

**Parser**: `parseDSL` (AST-based) for composite queries; `CompositeQueryExecutor` for set operations.

**Relationship to param packs**: The query DSL and param DSL **share the same node/edge identity layer** (HRNs), but serve different purposes:
- **Query DSL**: "which paths / users / events?" (temporal/behavioral constraints)
- **Param DSL**: "which fields / values?" (parameter addressing)

---

## Architectural Standards

1. **Single canonical HRN/param-pack engine**:
   - `ParamPackDSLService.unflattenParams` is the only place where HRN keys are parsed into `ScenarioParams`.
   - No ad hoc DSL parsers are allowed.

2. **Separation of parsing vs. application**:
   - Parsing/interpretation (HRN → structured diff) is **shared**.
   - Application of diffs is **context‑specific**:
     - Scenarios: overlays via `composeParams`, no graph mutation until flatten.
     - Sheets / external sources: diffs → external payloads → `UpdateManager.external_to_graph` / `external_to_file`.

3. **Scope‑aware ingestion for external sources**:
   - When ingesting from Sheets or similar:
     - Always pass a **scope** (edge/param, node/case, conditional) to the param‑pack engine.
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
    ParamPackDSLService             DataOperationsService merges
    .fromYAML(content)              scalar + param_pack into flat:
      │                               { "e.edge-1.p.mean": 0.7,
      │                                 "p.stdev": 0.05,
      ├─ Parse YAML → object            "mean": 0.7 }
      ├─ If nested: flatten                      │
      │   to HRN keys                             │
      │                                           ▼
      │                            (ingestion helper normalizes
      │                             relative keys like "mean" to
      │                             full HRNs such as
      │                             "e.edge-1.p.mean")
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
              ║  ParamPackDSLService.unflattenParams(flat)          ║
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
    Full ScenarioParams           ParamPackDSLService.applyScopeToParams
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

### Critical Architecture Point

**The diagram above shows that there is ONE AND ONLY ONE place where HRN/DSL keys are parsed:**

```
ParamPackDSLService.unflattenParams(flat: Record<string, any>): ScenarioParams
```

**Both scenarios and Sheets call this same function.** The differences are:

1. **Input preparation:**
   - Scenarios: YAML/JSON → object → flatten to HRN map → `unflattenParams`
   - Sheets: raw range → scalar/param_pack → merge + normalize relative keys → `unflattenParams`

2. **Output usage:**
- Scenarios: full `ScenarioParams` → store as overlay → compose for rendering (no mutation)
- Sheets: full `ScenarioParams` → `ParamPackDSLService.applyScopeToParams` to narrow to a specific scope (edge/slot, node/case, conditional, etc.) → extract `{mean, stdev, ...}` → `UpdateManager` (mutation)

**There is no second DSL parser.** Ingestion helpers do **not** parse HRN semantics; they only normalize shorthand keys (e.g. `mean` → `e.edge-1.p.mean`) and decide which `applyScopeToParams` scope to use before handing the result to `UpdateManager`.

---

## Future Extensions

1. **Richer journey DSL**:
   - Per-user path tracking: `from(a).then(b).then(c)` with sequencing
   - Repeat/loop constraints

2. **Param-aware queries**:
   - Filter paths by param values: `from(a).to(b).where(p.mean > 0.5)`
   - Return aggregated params for a query: `from(a).to(b).params(['p.mean', 'cost_gbp.mean'])`

3. **Named query templates**:
   - Reusable query fragments: `template funnel_engaged = visited(email-click).exclude(support-chat)`
   - Compose: `from(product).to(purchase).apply(funnel_engaged)`

4. **Multi-variant case filters**:
   - Union of variants: `.case(pricing-test:[treatment, control])`
   - Negative case filters: `.exclude_case(feature-gate:disabled)`

---

## Related Documentation

- **[SCENARIOS_MANAGER_SPEC.md](../../../docs/current/SCENARIOS_MANAGER_SPEC.md)**: Full spec for scenario system (HRN addressing is in Appendix A.1)
- **[GOOGLE_SHEETS_HRN_INTEGRATION.md](../../../docs/current/GOOGLE_SHEETS_HRN_INTEGRATION.md)**: Implementation plan for Sheets param pack ingestion
- **[MSMDC Algorithm](./query-algorithms-white-paper.md#1-msmdc-minimal-set-of-maximally-discriminating-constraints)**: Technical deep-dive on automatic query generation
- **[Query Factorization](./query-algorithms-white-paper.md#2-query-factorization-for-batch-optimization)**: Batch optimization for efficient API calls
- **[Parameter Schema](../../public/param-schemas/parameter-schema.yaml)**: Full parameter file structure

---

**Version History:**
- **2.0** (Nov 2025): Unified DSL doc (replaces "Query Expression Syntax & Semantics"), added architecture flows
- **1.0** (Nov 2025): Initial query expression doc

**Maintained by:** DagNet Team  
**Questions?** See [DATA_CONNECTIONS_README.md](../../../DATA_CONNECTIONS_README.md)
