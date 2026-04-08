# DSL Syntax Reference

**Date**: 2-Apr-26
**Purpose**: Complete grammar, operators, composition rules, and semantics for
DagNet's query DSL. Companion to `DSL_PARSING_ARCHITECTURE.md` (which covers
the code modules) and `DATA_RETRIEVAL_QUERIES.md` (which covers the three
purposes of queries).

**Canonical schemas**: `public/schemas/query-dsl-1.0.0.json` (v1.0),
`public/schemas/query-dsl-1.1.0.json` (v1.1, current).

**User-facing guide**: `public/docs/query-expressions.md` (parameter addressing
subset only).

---

## Core Pattern

All queries follow a dot-notation function-call syntax:

```
function(arg1, arg2, ...).function(arg3).function(arg4:value)...
```

Function order is normalised internally — the canonical ordering is:

```
visited → visitedAny → exclude → case → context → contextAny → window → cohort → asat
```

This means `context(key:val).visited(a)` and `visited(a).context(key:val)` are
equivalent after normalisation.

---

## Query Functions (14 total)

### Path Definition

| Function | Args | Semantics |
|---|---|---|
| `from(node-id)` | Single node ID | Starting node for path analysis |
| `to(node-id)` | Single node ID | Ending node for path analysis |

Both required for complete queries. Order-indifferent:
`from(a).to(b)` ≡ `to(b).from(a)`.

### Path Constraints (Graph Topology)

| Function | Args | Semantics |
|---|---|---|
| `visited(a, b, ...)` | Comma-separated node IDs | Must visit **all** listed nodes (AND). Multiple calls AND together. |
| `visitedAny(a, b, ...)` | Comma-separated node IDs | Must visit **at least one** (OR). Multiple calls create independent OR groups that AND together. |
| `exclude(a, b, ...)` | Comma-separated node IDs | Must **not** visit any listed node (AND negation). |

Examples:
- `visited(a).visited(b)` = "visit both a and b"
- `visitedAny(a,b).visitedAny(c,d)` = "(a OR b) AND (c OR d)"

### Experiment & Segmentation

| Function | Args | Semantics |
|---|---|---|
| `case(key:variant)` | Colon-separated key:value | A/B test variant filter. Multiple case calls AND together. |
| `context(key:value)` | Colon-separated key:value | Segment filter (e.g. `context(channel:google)`). |
| `context(key)` | Key only (no value) | **Enumerate** all values — triggers Cartesian expansion in `explodeDSL`. |
| `context(key:)` | Key with empty value | **Per-key clear** — removes inherited context for this key in scenario layering. |
| `context()` | Empty | **Whole clear** in scenario layering. **Uncontexted slice** in pinned DSL — see below. |
| `contextAny(k1:v1, k2:v2, ...)` | Comma-separated key:value pairs | OR over context segments. |

### Time Windows

| Function | Args | Semantics |
|---|---|---|
| `window(start:end)` | Colon-separated dates (`d-MMM-yy` or relative like `-90d`) | **Edge-local** time window (X-anchored). Cohort defined at the edge's `from_node`. Latency is edge-level only. |
| `cohort(start:end)` | Colon-separated dates | **Anchor-based** cohort (A-anchored). Cohort defined at anchor node. Latency is path-level (accumulated from anchor). |
| `cohort(anchor, start:end)` | Anchor node ID, then dates | Explicit anchor node specification. |

Window and cohort are **mutually exclusive**. In scenario layering, the
uppermost layer wins.

### Historical Query

| Function | Args | Semantics |
|---|---|---|
| `asat(date)` | Date in `d-MMM-yy` format | Point-in-time query: data as known on that date. `at(date)` is an accepted alias. |

### Inclusion-Exclusion (Composite Queries)

| Function | Args | Semantics |
|---|---|---|
| `minus(a, b, ...)` | Comma-separated node IDs | Subtract paths visiting these nodes. Inherits base from/to. **Deprecated** as of 4-Dec-25 in favour of native segment filters; retained for backwards compatibility. |
| `plus(a, b, ...)` | Comma-separated node IDs | Add back paths (inclusion-exclusion). Inherits base from/to. |

Example: `from(a).to(m).minus(b).plus(e)` = (A→M) − (A→M via B) + (A→M via E).

---

## Composition Rules

### Dot-Notation

All constraints compose via dots. Order is normalised during parsing.

### Semicolon Expansion

Semicolons create multiple atomic slices (handled by `dslExplosion.ts`):

```
a;b;c → [a, b, c]
```

### Parenthetical Distribution

Parentheses with suffixes distribute to each branch:

```
(a;b).c → a.c;b.c
c.(a;b) → c.a;c.b
```

### `or()` Function

Explicit OR grouping (equivalent to semicolons):

```
or(a,b,c) → a;b;c
or(a,b).context(key:val) → a.context(key:val);b.context(key:val)
```

Nested OR flattens: `or(a,or(b,c))` → `a;b;c`.

### Bare Key Expansion

`context(key)` (no value) triggers Cartesian expansion across all known
values for that key:

```
context(channel).context(browser) →
  context(channel:google).context(browser:chrome);
  context(channel:google).context(browser:safari);
  context(channel:bing).context(browser:chrome);
  context(channel:bing).context(browser:safari)
```

### Uncontexted Slice in Pinned DSL

In a pinned DSL (graph `dataInterestsDSL`), an empty element in a
semicolon or `or()` list means "also fetch the uncontexted
aggregate". All of the following forms are equivalent:

```
(window(-90d:)).(context(channel);context())    → 3 channel + 1 bare
(window(-90d:)).(context(channel);)             → same (trailing ;)
(window(-90d:)).(;context(channel))             → same (leading ;)
(window(-90d:)).or(context(channel),)            → same (trailing ,)
(window(-90d:)).or(,context(channel))            → same (leading ,)
```

`context()` in a semicolon/or position is treated as "include the
uncontexted slice" — the temporal clause is emitted without any
context qualifier. This is handled by `explodeDSL` in
`dslExplosion.ts`.

Note: `context()` retains its "whole clear" meaning in scenario
delta layering (`composeConstraints`). The disambiguation is by
context — pinned DSL explosion vs scenario composition use
different code paths.

### Context Merging in Scenario Layers

Context supports set/enumerate/clear operations during scenario stacking
via `augmentDSLWithConstraint()`:

- **Set**: `context(key:value)` — apply specific value
- **Per-key clear**: `context(key:)` — remove key from inherited context
- **Whole clear**: `context()` — remove all inherited context

---

## Addressing Modes

### By Edge ID (Direct)

```
e.edge-id.p.mean
e.checkout-to-purchase.cost_gbp.mean
```

### By Endpoints (Query-Style)

```
e.from(checkout).to(purchase).p.mean
e.from(a).to(b).visited(promo).p.mean: 0.72
```

Equivalent to edge ID form. Preferred when edge ID is unknown or query
conditions apply.

### Node Addressing

```
n.node-id.entry.weight: 1000
n.promo-gate.case(promo-experiment:treatment).weight: 0.6
```

Always direct by node ID.

---

## Three Purposes of Queries

Queries serve three distinct purposes (see `DATA_RETRIEVAL_QUERIES.md` for
detail):

1. **Topology filtering** — prune graph to subgraph matching path
   constraints.
2. **Conditional metadata** — semantic constraint defining when an edge's
   probability applies (the `condition` field on `conditional_p` entries).
3. **Data retrieval** — construct queries for external data sources to fetch
   n/k counts. Critical for multi-parent edges where `exclude()` isolates
   the direct path.

---

## Examples

```
# Basic path
from(homepage).to(checkout)

# With constraints
from(product-view).to(checkout).visited(add-to-cart).exclude(abandoned-cart)

# OR semantics
from(start).to(end).visitedAny(marketing, sales).visited(confirmation)

# Cohort analysis
from(household-created).to(success).cohort(-90d:)

# Explicit anchor
from(switch-registered).to(success).cohort(delegated-household, 1-Nov-25:30-Nov-25)

# Historical query
from(homepage).to(checkout).asat(5-Nov-25)

# Context segmentation
from(a).to(b).context(channel:google).context(device:mobile)

# Compound expansion
or(cohort(-30d:), window(1-Jan-25:31-Jan-25)).context(channel)
```
