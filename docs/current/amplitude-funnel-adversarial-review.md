# Amplitude funnel export — adversarial review + resolved decisions

## Why this note exists

Structured stress-test of the "DagNet → Amplitude draft funnel" logic. Covers:

1. Every DSL clause type — how it maps (or doesn't) to the Amplitude front-end chart definition, traced through the full DAS adapter path (`buildDslFromEdge` → `connections.yaml` pre_request) as the reference implementation.
2. Every What-If operation — whether it changes the funnel definition and how.
3. Out-of-scope / deprecated clauses (`minus()`, `plus()`) and bare-key context handling.
4. Resolved product decisions at each boundary.
5. Adversarial test matrix specific enough to transcribe directly into `amplitudeFunnelBuilder.conformance.test.ts`.

Reference: `docs/current/amplitude-funnel-popup-design.md` (main design doc).

---

## Part A: complete DSL clause inventory and funnel mapping

For each clause we trace: **DSL syntax → `parseDSL()` output → `buildDslFromEdge()` QueryPayload field → `connections.yaml` pre_request consumption → Amplitude API parameter**. Then we state how the funnel builder currently handles it and whether that's correct.

### A1. `from(nodeId)` / `to(nodeId)`

**DAS path**: `from(nodeId)` → `ParsedFullQuery.from` → node lookup → `node.event_id` → `QueryPayload.from` → `buildEventStepFromId(from)` → Amplitude `e=` parameter (event step with `event_type` = provider name, optional `filters` from `amplitude_filters`).

Same for `to()` — always the last funnel step.

**Funnel builder**: resolves `from`/`to` from the node selection (topologically sorted), not from the DSL's `from()/to()`. The DSL's `from`/`to` are informational — the funnel steps come from the selected nodes. This is correct because a multi-step funnel has N steps, not just from/to.

**Status**: ✅ Handled. Event resolution (`event_id` → provider name + `amplitude_filters`) matches DAS adapter.

---

### A2. `visited(nodeId, ...)`

**DAS path**: each visited node ID → node lookup → `event_id`. Nodes categorised by topology:

- **Upstream** (before `from` in graph, via BFS reachability) → `QueryPayload.visited_upstream[]` → pre_request converts each to a **behavioural segment condition**: `{ type: "event", event_type: providerName, filters, op: ">=", value: 1, time_type: "rolling", time_value: 366 }`. The array is then cleared (no funnel step).
- **Between** (`from` and `to` in graph) → `QueryPayload.visited[]` → pre_request adds each as an **additional funnel step** between `from` and `to` in the `events[]` array.

**Funnel builder (current)**: does NOT distinguish upstream vs between. If the visited node is in the funnel selection, it's dropped (redundant). If not in the selection, it becomes a behavioural segment `>= 1, rolling 366`.

**Gap**: the DAS adapter adds "between" visited nodes as funnel steps, not behavioural segments. The funnel builder treats all non-selected visited nodes as behavioural segments. For the funnel use case (where the user explicitly selected the funnel steps), this is arguably correct — the user's selection defines the steps, and `visited()` constraints from the DSL are enforced via segments. But it differs from the DAS adapter's behaviour.

*** DECISION: for funnel export, treat all `visited()` nodes NOT in the selection as behavioural segments (`>= 1, rolling 366`). This is correct because the user's node selection defines funnel steps; `visited()` from the composited DSL adds additional constraints. ***

**Status**: ✅ Handled (with documented difference from DAS "between" behaviour).

---

### A3. `visitedAny(nodeId, nodeId, ...)`

**DAS path**: each group resolved to event_ids. Categorised as upstream (all nodes upstream) or between. Goes to `QueryPayload.visitedAny[]` or `QueryPayload.visitedAny_upstream[]`. **However**: the `connections.yaml` pre_request script does NOT consume `visitedAny` or `visitedAny_upstream`. These fields are present on the payload but ignored by the Amplitude adapter. This is a gap in the DAS adapter itself.

**Funnel builder (current)**: does NOT handle `visitedAny()` at all. The `parsed.visitedAny` field is ignored.

**Gap**: `visitedAny()` is silently dropped by both the DAS adapter and the funnel builder. If a user's effective DSL contains `visitedAny()`, those constraints are lost in both paths.

*** DECISION: warn if `visitedAny()` is present. It cannot be faithfully represented as a single Amplitude segment condition (Amplitude segments are AND, not OR-within-group). For now, emit a warning: "visitedAny() cannot be represented in Amplitude funnels and has been ignored." Future: could be decomposed into multiple funnels or use Amplitude's OR segment logic if available. ***

**Status**: ⚠️ GAP — must add warning. Currently silently dropped.

---

### A4. `exclude(nodeId, ...)`

**DAS path**: each exclude node ID → `event_id` → `QueryPayload.exclude[]` → pre_request converts each to a **behavioural segment condition**: `{ type: "event", event_type: providerName, filters, op: "=", value: 0, time_type: "rolling", time_value: 366 }`. Array then cleared.

**Funnel builder (current)**: matches DAS adapter behaviour. Each excluded node → behavioural segment `= 0, rolling 366`.

**Edge case**: `exclude(X)` where X is also a funnel step. This is contradictory — the funnel requires step X but the segment excludes it. Result: zero users.

*** DECISION: warn "contradictory: exclude(X) applied to funnel step X" but proceed. The zero-user result is a correct reflection of the contradiction. ***

**Status**: ⚠️ Partial — core mapping handled; contradictory-case warning is pending.

---

### A5. `context(key:value)`

**DAS path**: two parallel representations on QueryPayload:

1. **`QueryPayload.context[]`** — raw `{key, value}` pairs pass-through from DSL parse. Not consumed directly by Amplitude pre_request.
2. **`QueryPayload.context_filters[]`** — resolved via `buildContextFilters(constraints, connectionProvider)`:
   - Looks up `contextRegistry.getSourceMapping(provider, key, value)` for each context pair.
   - Registry returns the **provider-specific property name** (e.g. `channel` → `utm_medium`), operator, values, and optionally a regex pattern.
   - `normalizeProp()` applies `gp:` prefix for custom properties, bare name for built-ins.
   - Produces `ContextFilterObject { field, op, values, pattern?, patternFlags? }`.
   - Pre_request converts each to a segment condition: `{ prop: "gp:utm_medium", op: "is", values: ["cpc"] }`.

**Funnel builder (current)**: does NOT use context registry. Maps `context(key:value)` directly to `{ prop: normalizeProp(key), values: [value] }`. This produces **wrong property names** for any context key that doesn't match the Amplitude property name (e.g. `context(channel:paid-search)` → `gp:channel` instead of `gp:utm_medium`).

**This is the known divergence** that motivated the `buildDslFromEdge()` rewrite decision. The current conformance tests cover `normalizeProp()` correctness for the raw key, but NOT registry resolution.

*** DECISION: the `buildDslFromEdge()` rewrite must resolve context through the registry. Until then, context mapping is incorrect for registry-mapped keys. Post-rewrite test CTX-3 (below) verifies registry resolution. ***

**Bare key `context(key)`**: parsed with `value: ''`. In the DAS path, bare keys are NOT compiled into filters — they trigger Cartesian expansion via `dslExplosion.ts`. The funnel builder correctly skips bare keys (`if (!ctx.value) continue`).

**Empty `context()`**: explicit clear (removes inherited context). The funnel builder should not emit any context conditions if the effective DSL has an empty context clause with no values. Current behaviour: correct (no values → no conditions).

**Status**: ❌ BROKEN for registry-mapped keys (pre-rewrite). ✅ Correct for direct-name keys and bare keys.

---

### A6. `contextAny(key:val, key:val, ...)`

**DAS path**: pairs grouped by key → `buildContextFilters()` produces one `ContextFilterObject` per key with multiple values. The `other` value triggers special handling:
- `otherPolicy: 'null'` → entire context_filters returned as `undefined` (no filtering).
- `otherPolicy: 'computed'` → build NOT filter from all explicit values.
- `otherPolicy: 'explicit'` → use mapping's own filter/pattern.

Pre_request converts to segment conditions with `values: [multiple]`.

**Funnel builder (current)**: handles grouping by key and emits multi-value conditions. Does NOT handle `other` policy at all. Does NOT use context registry for field name resolution (same gap as `context()`).

**Status**: ⚠️ Partial — grouping works, but `other` handling and registry resolution are missing.

---

### A7. `case(key:variant)`

**DAS path**: `QueryPayload.case[]` → pre_request processes each:
- `key` → `gate_id` (hyphens → underscores).
- `variant` → boolean via `dasHelpers.resolveVariantToBool()` → `"true"` or `"false"` (string).
- Segment condition: `{ prop: "activeGates.{gate_id}", op: "is", values: ["{bool}"] }`.

**Funnel builder (current)**: matches DAS adapter. Uses the same `resolveVariantToBool()` from `caseVariantHelpers.ts`. Hyphen-to-underscore and `activeGates.` prefix applied correctly.

**Status**: ✅ Handled. Shared code path for variant resolution.

---

### A8. `window(start:end)`

**DAS path**: `constraints.window` → `resolveWindowDates()` → ISO strings on `QueryPayload.start`/`QueryPayload.end`. Pre_request formats to `YYYYMMDD` for `start=` / `end=` parameters. Default conversion window: 30 days (`cs=2592000`).

**Funnel builder (current)**: parses window dates via `toEpochSeconds()` which handles UK format (`parseUKDate`), relative offsets (`-30d`), and ISO fallback. Sets `definition.params.start` and `definition.params.end` as epoch seconds.

**Difference**: DAS adapter produces `YYYYMMDD` strings for the REST API; funnel builder produces epoch seconds for the front-end chart definition API. Both are correct for their respective targets.

**Status**: ✅ Handled.

---

### A9. `cohort(start:end)` or `cohort(anchor, start:end)`

**DAS path**: `constraints.cohort` → `resolveCohortDates()` + anchor resolution:
- Anchor source: explicit `cohort(anchor, ...)` DSL OR `edge.p.latency.anchor_node_id` from graph config.
- If anchor != from → anchor event prepended as step 0, `fromStepIndex` shifted.
- Conversion window: computed from graph-level max `path_t95` / `t95`, clamped to 90 days max. Falls back to 30 days.
- `QueryPayload.cohort = { start, end, anchor_event_id, conversion_window_days }`.
- Pre_request: uses `cohort.start`/`cohort.end` for dates, `cohort.conversion_window_days * 86400` for `cs=`, prepends anchor event if present.

**Funnel builder (current)**: handles cohort dates and anchor prepending. However:
- Does NOT compute `conversion_window_days` from graph config — hardcodes 30 days.
- Does NOT resolve anchor from `edge.p.latency.anchor_node_id` — only from `parsed.cohort.anchor`.

**Gaps**:
1. `conversion_window_days` should come from graph config (path_t95). Known TODO.
2. Anchor fallback from edge config not implemented (lower priority — explicit DSL anchor is the common case for funnel export).

*** DECISION: toast if anchor prepended. Default 30-day conversion window is acceptable for now; TODO to resolve from config. ***

**Status**: ⚠️ Partial — dates and anchor work, conversion window and edge-config anchor are TODOs.

---

### A10. `minus(nodeId, ...)` / `plus(nodeId, ...)`

Substantively deprecated (4-Dec-25) in favour of native Amplitude segment filters. The composite query parser still accepts them syntactically, but they are not used in production DSL construction. `parseDSL()` does not extract them — they are invisible to the funnel builder by design. No support required.

**Status**: N/A — deprecated, no action needed.

---

### A11. `asat(date)` / `at(date)`

**DAS path**: NOT consumed by `buildDslFromEdge()` or the pre_request script. Handled by the snapshot retrieval system (`dataOperationsService.ts` → `querySnapshotsVirtual`). `asat()` is orthogonal to the Amplitude query — it controls which DagNet snapshot data to show, not which Amplitude events to query.

**Funnel builder (current)**: detects `parsed.asatClausePresent`, adds a warning ("asat() removed — Amplitude can't represent historical snapshot mode"), nulls `parsed.asat`, and proceeds. Already implemented and tested.

**Status**: ✅ Handled.

---

## Part B: out-of-scope / deprecated query forms

### B1. Bare context keys `context(key)` — Cartesian expansion trigger

**Syntax**: `context(channel)` — no value. Used in pinned DSL to trigger expansion into all registered values for that context dimension.

Bare keys are part of the explosive resolution system. They can theoretically appear in user-edited DSL in the analytics panel, but the funnel builder correctly skips them (`if (!ctx.value) continue`) — a bare key is a data-interest declaration, not a filter.

**Status**: ✅ Handled (skipped, not an error).

---

## Part C: What-If operations and funnel impact

What-If operations modify graph probabilities/weights for scenario analysis. The What-If DSL is split into **fetch parts** (context, contextAny, window, cohort, asat) and **what-if parts** (case, visited, visitedAny, exclude) by `splitDSLParts()` in `scenarioRegenerationService.ts`.

### Why What-If doesn't change the funnel definition

No What-If operation changes `event_id`, node existence/visibility, or edge existence. They only modify probabilities and variant weights. Therefore What-If operations do NOT change which Amplitude events appear in the funnel or which event filters apply.

**However**, What-If's primary purpose is to **explicitly enforce `visited()`, `exclude()`, and `case()` semantics on downstream journey steps**. When a user sets `visited(X)` in a What-If scenario, they are asserting "the user visited node X" — this activates `conditional_p` entries on downstream edges, changing which probabilities DagNet uses for those edges. The What-If system propagates these assertions through the graph: a `case(ab:treatment)` override forces variant weights to 1/0, which implicitly makes certain downstream nodes "visited" (through `getImplicitlyVisitedNodes()`), which in turn can activate further conditional probabilities.

**The funnel export must preserve these assertions as Amplitude segment conditions**, because that is how Amplitude constrains the population to match the What-If scenario. If the What-If says "visited node X" and the Amplitude funnel doesn't filter for users who performed event X, the funnel will show a broader population than the What-If scenario models.

The flow is:
1. What-If DSL (`case(ab:treatment).visited(X).exclude(Y)`) is composed into the effective DSL via `augmentDSLWithConstraint()`.
2. The composited effective DSL reaches the funnel builder.
3. The funnel builder translates each clause to the corresponding Amplitude segment condition.

This means the funnel builder doesn't need to understand What-If internals (conditional_p activation, variant weight propagation, implicit visitation). It just needs to faithfully translate the DSL clauses that What-If contributes to the composited effective DSL.

### C1. `case(key:variant)` as What-If

**Graph effect**: sets selected variant weight to 1.0, all others to 0.0. Propagates through case-routing edges (selected variant gets full probability, others get zero). Can trigger implicit activation of `conditional_p` on downstream edges by making downstream nodes implicitly visited.

**Funnel export**: the `case()` clause from the effective DSL becomes an `activeGates` segment condition. This constrains the Amplitude population to users in the same experiment variant.

**Status**: ✅ Handled.

### C2. `visited(nodes)` as What-If

**Graph effect**: explicitly asserts that specific nodes have been visited. Activates `conditional_p` entries on downstream edges whose conditions match. Replaces base `p.mean` with conditional `p.mean`. "Most specific wins" when multiple conditions match. Also affects graph pruning: visited nodes become "forced nodes", and sibling edges leading to non-visited nodes are excluded.

**Funnel export**: `visited()` nodes not in the funnel selection become behavioural segment conditions (`>= 1, rolling 366`). `visited()` nodes in the selection are dropped (redundant — the funnel step already requires the event).

This is the critical link between What-If and the funnel: the What-If says "user went through X on their journey", the funnel says "only include users who performed event X at least once". Both constrain to the same sub-population.

**Status**: ✅ Handled.

### C3. `visitedAny(nodes)` as What-If

**Graph effect**: OR logic within each group. Activates `conditional_p` with lower specificity than `visited()`. Less commonly used — primarily for outcome/sibling comparison scenarios where any one of several nodes satisfies the condition.

**Funnel export**: NOT TRANSLATED. The funnel builder ignores `visitedAny()`.

**Why this is a gap**: if a What-If scenario uses `visitedAny(X,Y)` to assert "user visited at least one of X or Y", the corresponding Amplitude funnel should constrain to users who performed at least one of those events. Amplitude segments don't natively support OR across behavioural conditions within a single segment — each condition is AND-combined. Representing OR would require multiple segments or a more complex chart structure.

*** DECISION: warn if `visitedAny()` is present. It cannot be faithfully represented as a single Amplitude segment condition. ***

**Status**: ⚠️ GAP — must add warning.

### C4. `exclude(nodes)` as What-If

**Graph effect**: explicitly asserts that specific nodes have NOT been visited. Activates `conditional_p` conditions that require non-visitation. Affects graph pruning (excluded nodes get probability 0, remaining edges renormalised).

**Funnel export**: `exclude()` nodes become behavioural segment conditions (`= 0, rolling 366`). This constrains the Amplitude population to users who did NOT perform those events — matching the What-If assertion.

**Status**: ✅ Handled.

### C5. Scenario layer DSL composition

The effective DSL that reaches the funnel builder is composited by `computeInheritedDSL()` + `computeEffectiveFetchDSL()` from `scenarioRegenerationService.ts`. This merges base DSL, scenario deltas, and the What-If DSL. The composition uses `augmentDSLWithConstraint()` which handles:

- **Context**: same key overrides value; different keys combine. Empty `context()` clears all.
- **Case**: same key overrides variant.
- **Window/cohort**: mutually exclusive — new cohort clears inherited window and vice versa.
- **Visited/exclude**: accumulate (union).
- **Asat**: MECE axis — new asat replaces inherited.

The composited DSL is what the funnel builder parses. All merging has already happened. The funnel builder does not need to understand scenario layering — it just processes the final effective DSL.

If two scenario layers both set `context()` on different keys, the composited DSL will have both. The funnel builder emits both as AND-combined segment conditions. This is correct — Amplitude AND-combines segment conditions within a segment.

**Status**: ✅ No action needed in the funnel builder (composition is upstream).

---

## Part D: semantics divergence and the `buildDslFromEdge()` rewrite

### The core problem

The current funnel builder re-implements DSL-to-Amplitude mapping in parallel to the DAS adapter (`connections.yaml` pre_request script). The following fields diverge:

| Field | DAS adapter | Funnel builder (current) | Risk |
|---|---|---|---|
| Context property name | Registry lookup → provider-specific name | `normalizeProp(key)` — direct key | ❌ Wrong for mapped keys |
| Context value | Registry value mapping | Direct pass-through | ⚠️ Wrong if registry maps values |
| `BUILT_IN_USER_PROPS` | Set in pre_request script | Duplicated set in funnel builder | ⚠️ Can drift |
| Visited upstream/between | Topology-aware categorisation | All external → behavioural segment | ✅ Acceptable for funnel use case |
| Conversion window (cohort) | Graph-level max t95, clamped to 90d | Hardcoded 30d | ⚠️ Known TODO |
| `visitedAny` | Present on payload but not consumed | Not handled | ⚠️ Both paths have this gap |
| Operator mapping | `mapOperator()` in pre_request | `mapOperator()` in funnel builder | ✅ Same table (can drift) |

### Architectural approach: shared resolution, split format translation

The goal is maximum code reuse where the TypeScript module system allows it, and explicit conformance tests where code paths are forced to split (because the `connections.yaml` pre_request script runs in a sandboxed JS context that can't import TypeScript modules).

#### What currently exists

There are three layers of resolution logic, currently in three different places:

| Layer | DAS adapter location | Funnel builder location | Shareable? |
|---|---|---|---|
| **DSL parsing** | `queryDSL.ts` → `parseDSL()` | Same | ✅ Already shared |
| **Constraint resolution** (context registry, date resolution, variant resolution) | `buildDslFromEdge.ts` → private functions `buildContextFilters()`, `resolveWindowDates()`, `resolveCohortDates()` | Duplicated/missing in `amplitudeFunnelBuilderService.ts` | 🔧 Shareable — export the functions |
| **Amplitude-specific translation** (event step assembly, segment condition assembly, property normalisation, operator mapping) | `connections.yaml` pre_request script (sandboxed JS) | Duplicated in `amplitudeFunnelBuilderService.ts` | ❌ Cannot import from YAML sandbox |

#### The architecture

**Layer 1: shared resolution (TypeScript, single source of truth)**

Export the resolution subfunctions from `buildDslFromEdge.ts` so both the DAS adapter path and the funnel builder can call them:

- `buildContextFilters(constraints, provider)` — context registry lookup → `ContextFilterObject[]`. Currently private, needs `export`.
- `resolveWindowDates(window)` — UK dates / relative offsets → `{ startDate, endDate }`. Currently private, needs `export`.
- `resolveCohortDates(cohort)` — same for cohort dates. Currently private, needs `export`.

Already shared (no changes needed):
- `parseDSL()` / `parseConstraints()` from `queryDSL.ts`
- `resolveVariantToBool()` from `caseVariantHelpers.ts`
- `parseUKDate()` from `dateFormat.ts`

**Layer 2: shared Amplitude helpers (new module)**

Extract the Amplitude-specific translation logic that is currently duplicated between the pre_request script and the funnel builder into a new shared module (`lib/das/amplitudeHelpers.ts` or similar):

- `normalizeProp(prop)` — `BUILT_IN_USER_PROPS` check + `gp:` prefixing. Currently duplicated in both the pre_request script and `amplitudeFunnelBuilderService.ts`.
- `mapOperator(op)` — operator table. Currently duplicated.
- `resolveAmplitudeEvent(eventId, fileRegistry)` — event_id → `{ amplitudeName, filters }`. Currently `getEventInfo` + `buildEventStepFromId` in the pre_request script, and `resolveEvent` in the funnel builder.

The pre_request script **cannot import this module** (sandbox). It keeps its own copies. But:
- The funnel builder imports from the shared module (single source of truth for the TypeScript side).
- Conformance tests verify the pre_request script's copies produce identical output to the shared module for every constraint type.

**Layer 3: path-specific assembly (inherently split)**

The two consumers produce fundamentally different output formats:

| | DAS adapter (pre_request) | Funnel builder |
|---|---|---|
| **Input** | `QueryPayload` (per-edge, from/to pair) | N selected nodes + composited DSL |
| **Output** | REST API URL: `e=...&s=...&start=YYYYMMDD` | Chart definition JSON: `{ type: "funnels", params: { events, segments } }` |
| **Event assembly** | `e=` URL params (JSON-encoded event steps) | `params.events[]` array (event objects) |
| **Segment assembly** | `s=` URL param (JSON-encoded segment array) | `params.segments[].conditions[]` array |
| **Date format** | `YYYYMMDD` strings | Epoch seconds |
| **Visited semantics** | Upstream → segment, between → funnel step | All non-selected → segment (no between concept) |

This split is irreducible: the output formats serve different APIs, and the funnel's multi-step nature means it can't be modelled as a single `buildDslFromEdge()` call.

#### What the funnel builder does post-refactor

1. **Parse** the composited effective DSL via `parseDSL()` (shared).
2. **Strip** `asat()` with warning (funnel-specific).
3. **Warn** if `visitedAny()` present (funnel-specific — can't be represented).
4. **Topologically sort** selected nodes → funnel step order (funnel-specific).
5. **Resolve events** for each step via `resolveAmplitudeEvent()` (shared helper).
6. **Resolve context** via `buildContextFilters(constraints, 'amplitude')` (shared, exported from `buildDslFromEdge.ts`). This goes through the context registry — eliminates the `gp:channel` bug.
7. **Resolve dates** via `resolveWindowDates()` or `resolveCohortDates()` (shared, exported from `buildDslFromEdge.ts`). Convert to epoch seconds (funnel-specific format).
8. **Resolve case variants** via `resolveVariantToBool()` (shared).
9. **Build segment conditions** from resolved context_filters, exclude, visited, case, cohort exclusions. Uses `normalizeProp()` and `mapOperator()` from the shared Amplitude helpers module.
10. **Assemble chart definition** (funnel-specific format translation).
11. **Handle cohort anchor** prepending + toast (funnel-specific).

Steps 1, 5, 6, 7, 8, 9 (partially) use shared code. Steps 2, 3, 4, 10, 11 are funnel-specific. Step 9's *format* (chart definition conditions vs URL segment params) is funnel-specific, but the *values* come from shared resolution.

#### Where conformance tests are needed

Conformance tests are needed only at the **format translation boundary** — where the funnel builder takes resolved values from the shared layer and assembles them into the chart definition format. The resolved values themselves are guaranteed correct by code sharing.

| What to test | Why it can diverge | Test approach |
|---|---|---|
| `normalizeProp()` output | Pre_request has its own copy | Unit test: same inputs → same outputs for both copies |
| `mapOperator()` output | Pre_request has its own copy | Unit test: same inputs → same outputs |
| Event step assembly | Different output format (event object vs `e=` URL param) | Verify funnel builder's event objects have correct `event_type` and `filters` structure |
| Segment condition assembly | Different output format | Verify each condition type (cohort exclusion, behavioural, property, gate) has correct shape |
| Date format | Epoch seconds vs YYYYMMDD | Verify epoch values are correct for known dates |

The critical insight: **after the refactor, the conformance tests are verifying format translation (structural), not semantic resolution (logical)**. The semantic resolution is shared code, so it can't diverge.

#### What does NOT need to go through `buildDslFromEdge()` as a whole

`buildDslFromEdge()` is per-edge: it takes an edge with `from`/`to`, does visited upstream/between categorisation (BFS reachability), and builds a `QueryPayload` shaped for the REST API. The funnel builder works with N selected nodes, not a single edge, and doesn't need upstream/between categorisation.

Calling `buildDslFromEdge()` with a "synthetic edge" would mean:
- Inventing a fake `from`/`to` (the first/last funnel steps), which misrepresents the funnel.
- Getting upstream/between categorisation that the funnel doesn't use.
- Getting back a `QueryPayload` shaped for the REST API that then needs to be re-translated.
- Making the funnel builder async (because `buildContextFilters` calls the async context registry).

It's cleaner to call the resolution subfunctions directly. The async boundary for `buildContextFilters` is the only one, and the funnel builder's `handleOpenInAmplitude` is already async.

---

## Part E: resolved decisions (summary)

| # | Question | Decision |
|---|---|---|
| 1 | Non-linear graph selection | Warn but permit. Deterministic alpha tie-break. |
| 2 | `visited(step)` in selection | Drop silently (semantically redundant). |
| 3 | `exclude(step)` in selection | Warn "contradictory", proceed. |
| 4 | `visitedAny()` in DSL | Warn "cannot be represented", ignore. |
| 5 | `minus()`/`plus()` in DSL | Deprecated — invisible to funnel builder. No action. |
| 6 | `asat()`/`at()` in DSL | Strip, warn via toast, proceed. |
| 7 | Compound DSL (`;`, `or()`) | Not relevant to funnel export scope. |
| 8 | Bare context key `context(key)` | Skip (not a filter). Already handled. |
| 9 | Behavioural constraint time scope | Rolling 366 days (matches DAS adapter). |
| 10 | Cohort anchor prepending | Toast if prepended. |
| 11 | Conversion window | Default 30d. TODO: resolve from graph config. |
| 12 | Context property resolution | Resolve through shared context registry path (`buildContextFilters`). |
| 13 | Contradictory constraints | Warn, proceed. Let Amplitude return zero if contradictory. |

---

## Part F: implementation status snapshot (as of today)

This table separates **agreed behaviour** from **currently shipped behaviour** so the document does not over-claim implementation completeness.

| Area | Agreed behaviour | Current implementation |
|---|---|---|
| `asat()` / `at()` | Strip + warn + proceed | ✅ Shipped |
| `visited(step)` | Drop as redundant | ✅ Shipped |
| `exclude(step)` contradiction | Warn + proceed | ✅ Shipped |
| `visitedAny()` | Warn as unrepresentable + ignore | ✅ Shipped |
| `context()` registry mapping | Resolve via context registry | ✅ Shipped |
| `contextAny()` `otherPolicy` handling | Match DAS semantics | ✅ Shipped (via shared `buildContextFilters`) |
| `cohort` conversion window from graph config | Use `path_t95/t95`-derived value | ❌ Not shipped (currently 30d default) |
| Non-linear selection warning | Warn + proceed | ✅ Shipped |
| Cohort anchor-prepend warning | Warn when anchor added as step 0 | ✅ Shipped |

---

## Part G: complete adversarial test matrix

Each row is a named test case. Grouped by category.

### G1. Graph shape

| ID | Input | Expected steps | Warning? |
|---|---|---|---|
| GS-1 | Linear `A→B→C`, select `[C,A,B]` | `[A,B,C]` | No |
| GS-2 | Branch `A→B, A→C`, select `[A,B,C]` | `[A,B,C]` (alpha tie-break) | Yes: non-linear |
| GS-3 | Branch reversed input `[C,B,A]` | `[A,B,C]` (deterministic) | Yes: non-linear |
| GS-4 | Diamond `A→B, A→C, B→D, C→D`, select all | `[A,B,C,D]` (alpha) | Yes: non-linear |
| GS-5 | Disconnected `A→B` + `X→Y` | `[A,B,X,Y]` (alpha) | Yes: disconnected |
| GS-6 | Single node `[A]` | `[A]` | No |

### G2. `visited()` / `exclude()` interaction

| ID | Selection | DSL | Expected segment | Warning? |
|---|---|---|---|---|
| VE-1 | `[A,B,C]` | `visited(B)` | None (dropped — B is a step) | No |
| VE-2 | `[B,C]` | `visited(A)` | A `>= 1`, rolling 366 | No |
| VE-3 | `[A,B]` | `exclude(X)` | X `= 0`, rolling 366 | No |
| VE-4 | `[A,B]` | `exclude(B)` | B `= 0`, rolling 366 | Yes: contradictory |
| VE-5 | `[A,B]` | `visited(X).exclude(X)` | X `>= 1` AND X `= 0` | Yes: contradictory |

### G3. `visitedAny()`

| ID | DSL | Expected | Warning? |
|---|---|---|---|
| VA-1 | `visitedAny(X,Y)` | No segment condition | Yes: "visitedAny() cannot be represented" |
| VA-2 | `visitedAny(A,B)` where A,B both in selection | No segment condition | Yes (same) |

### G4. `context()` / `contextAny()`

| ID | DSL / config | Expected segment condition | Notes |
|---|---|---|---|
| CTX-1 | `context(utm_medium:cpc)` | `{ prop: "gp:utm_medium", values: ["cpc"] }` | Direct key, custom prop |
| CTX-2 | `context(country:United Kingdom)` | `{ prop: "country", values: ["United Kingdom"] }` | Built-in, no `gp:` |
| CTX-3 | `context(channel:paid-search)` | `{ prop: "gp:utm_medium", values: ["paid-search"] }` | **Registry-mapped** — only correct post-rewrite |
| CTX-4 | `context(channel)` (bare key) | No condition emitted | Bare key = expansion trigger, not a filter |
| CTX-5 | `context()` (empty clear) | No conditions | Explicit clear |
| CTX-6 | `contextAny(channel:google,channel:meta)` | `{ prop: "gp:...", values: ["google","meta"] }` | OR values grouped by key |
| CTX-7 | `contextAny()` with `other` value | Depends on `otherPolicy` | NOT HANDLED pre-rewrite |

### G5. `case()`

| ID | DSL | Expected segment condition |
|---|---|---|
| CASE-1 | `case(coffee-promotion:treatment)` | `{ prop: "activeGates.coffee_promotion", values: ["true"] }` |
| CASE-2 | `case(coffee-promotion:control)` | `{ prop: "activeGates.coffee_promotion", values: ["false"] }` |
| CASE-3 | `case(ab-test-v2:treatment)` | `{ prop: "activeGates.ab_test_v2", values: ["true"] }` |

### G6. Cohort exclusion

| ID | Config | Expected segment condition |
|---|---|---|
| CE-1 | `excluded_cohorts: ["9z057h6i"]` | `{ prop: "userdata_cohort", op: "is not", values: ["9z057h6i"] }` |
| CE-2 | `excluded_cohorts: ["a","b"]` | Two conditions, one per cohort ID |
| CE-3 | `excludeTestAccounts: false` | No cohort exclusion conditions |

### G7. `window()` dates

| ID | DSL | Expected chart params |
|---|---|---|
| WIN-1 | `window(1-Jan-25:31-Mar-25)` | `start` and `end` as epoch seconds. No `range`. |
| WIN-2 | `window(-30d:)` | `start` = 30 days ago (epoch). `end` = now (epoch). |
| WIN-3 | No window or cohort | `range: "Last 30 Days"`. No `start`/`end`. |

### G8. `cohort()` dates + anchor

| ID | DSL | Selection | Expected | Warning? |
|---|---|---|---|---|
| CO-1 | `cohort(anchor,1-Oct-25:31-Oct-25)` | `[anchor,B,C]` | Steps `[anchor,B,C]`. Dates set. | No |
| CO-2 | `cohort(anchor,1-Oct-25:31-Oct-25)` | `[B,C]` | Steps `[anchor,B,C]` (anchor prepended). Dates set. | Yes: anchor prepended |
| CO-3 | `cohort(1-Oct-25:31-Oct-25)` (no anchor) | `[A,B]` | Steps `[A,B]`. Dates set. `conversionSeconds` = 30d default. | No |

### G9. `asat()` / `at()` stripping

| ID | DSL | Expected |
|---|---|---|
| AS-1 | `from(A).to(B).window(1-Jan-25:31-Mar-25).asat(15-Feb-25)` | Warning in `warnings[]`. Funnel built with window dates. |
| AS-2 | `from(A).to(B).at(15-Feb-25)` | Same (parser normalises `at` → `asat`). |
| AS-3 | `from(A).to(B).window(1-Jan-25:31-Mar-25)` | No warning. Normal. |

### G10. Time scoping for behavioural constraints

| ID | DSL | Chart date range | Segment time scope |
|---|---|---|---|
| TS-1 | `window(1-Jan-25:31-Mar-25).visited(X)` | Jan–Mar epoch | X: rolling 366 |
| TS-2 | `window(1-Jan-25:31-Mar-25).exclude(X)` | Jan–Mar epoch | X: rolling 366 |
| TS-3 | `visited(X)` (no dates) | "Last 30 Days" | X: rolling 366 |

### G11. What-If scenario integration

| ID | Scenario | Expected |
|---|---|---|
| WI-1 | What-If DSL `case(ab:treatment)` on current layer | `case()` appears in composited effective DSL → `activeGates` segment condition. |
| WI-2 | What-If DSL `visited(X)` on current layer | `visited(X)` in composited DSL → behavioural segment (if X not in selection). |
| WI-3 | What-If DSL `exclude(Y)` on current layer | `exclude(Y)` in composited DSL → behavioural segment `= 0`. |
| WI-4 | What-If DSL `visitedAny(X,Y)` on current layer | Warning: "visitedAny() cannot be represented". |
| WI-5 | Scenario layer with `context(channel:google)` | Composited DSL includes `context(channel:google)` → property segment. |
| WI-6 | Scenario layer overrides `window()` with `cohort()` | Cohort replaces window in composited DSL. Funnel uses cohort dates + anchor. |
| WI-7 | Scenario layer adds `asat()` | Stripped with warning. Funnel proceeds without it. |

### G12. Event resolution edge cases

| ID | Scenario | Expected |
|---|---|---|
| EV-1 | Node has `event_id` with event file in FileRegistry | Provider name from `provider_event_names.amplitude`. Event filters from `amplitude_filters`. |
| EV-2 | Node has `event_id` but no event file | Falls back to `event_id` as event name. No filters. |
| EV-3 | Node has no `event_id` | Skipped. Warning: "Node X has no event_id." |
| EV-4 | Event file has `amplitude_filters` with `"is any of"` operator | Mapped to `"is"` with array values (matches DAS adapter `mapOperator`). |
