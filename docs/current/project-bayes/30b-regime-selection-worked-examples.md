# Doc 30b — Regime Selection: Worked Examples

**Status**: Working document — reasoning through edge cases
**Date**: 7-Apr-26
**Purpose**: Concrete examples to tease out exactly what the FE→BE
contract needs to support, before finalising the contract design.

---

## 0. Background: how the snapshot system works

This section provides the essential context for understanding the
regime selection problem. Readers unfamiliar with the snapshot DB,
hashing, or DSL semantics should read this before the worked
examples.

### 0.1 The snapshot DB: what is stored

The `snapshots` table (PostgreSQL in Neon) stores time-series
conversion evidence. Each row is one observation of a single cohort
day at a specific retrieval date:

| Column | Meaning |
|---|---|
| `param_id` | Workspace-prefixed parameter ID (`repo-branch-objectId`) |
| `core_hash` | Content-address of the query semantics (see §0.2) |
| `slice_key` | Full DSL string identifying the specific context+temporal slice (e.g. `context(channel:google).window(1-Jan-26:1-Apr-26)`) |
| `anchor_day` | ISO date — the cohort start date |
| `retrieved_at` | UTC timestamp — when the data was fetched from source |
| `a` | Anchor entrants (cohort population entering the anchor node) |
| `x` | From-step count (entrants reaching the edge's source node) |
| `y` | To-step count (converters reaching the edge's target node) |
| `median_lag_days` / `mean_lag_days` | Per-row lag statistics |
| `onset_delta_days` | Onset delay |

The unique constraint is `(param_id, core_hash, slice_key,
anchor_day, retrieved_at)`. Multiple rows for the same
`(anchor_day, slice_key)` at different `retrieved_at` dates form a
**maturation trajectory** — how cumulative conversion count `y` grew
as late converters arrived.

### 0.2 What goes into the hash

The `core_hash` is the DB lookup key. It is computed by the FE as
`computeShortCoreHash(canonical_signature)` where the canonical
signature is a JSON string with two parts:

```json
{
  "c": "<core_hash>",
  "x": { "<context_key>": "<context_definition_hash>", ... }
}
```

**The `c` (core) field** is a SHA-256 hash of the edge's query
identity:
- Connection name (e.g. "amplitude")
- From-node and to-node event IDs
- Event definition hashes (detect event file changes)
- Event filters
- Case constraints
- `cohort_mode: true|false` (window vs cohort)
- Cohort anchor event ID (if cohort mode)
- Latency parameter config
- Normalised query string — with **context clauses and
  window/cohort date bounds stripped** (lines 250-256 of
  `querySignature.ts`)

**The `x` (context definitions) field** contains a hash of each
context **definition** YAML file, keyed by context key name. This
is the hash of the MECE value list (all values, their aliases,
their sources), NOT the specific value being queried.

**What is NOT in the hash**:
- **Context values** — `context(channel:google)` and
  `context(channel:meta)` produce the **same** core_hash. The
  value is in the `slice_key`, not the hash.
- **Date bounds** — `window(1-Jan:1-Apr)` and `window(1-Feb:1-Mar)`
  produce the same hash. Bounds are in the `slice_key`.

**Consequences**:
- All values within one MECE dimension share one `core_hash`.
  Querying by `core_hash` returns rows for ALL values.
- Different context dimensions produce different `core_hash` values
  (different `x` fields).
- Window mode and cohort mode produce different `core_hash` values
  (different `cohort_mode` in `c`).
- The same edge with no context (`x: {}`) has a different
  `core_hash` from the same edge with context (`x: {channel: "..."}`).

The `core_hash` is computed by the FE (sole producer) and treated
as an opaque key by the BE. The BE never recomputes it.

### 0.3 Pinned DSL and daily fetch

Each graph has a `dataInterestsDSL` — the "pinned DSL" — which
drives the daily fetch pipeline. It specifies what data to retrieve
for all edges in the graph.

A typical pinned DSL:
```
(window(-90d:);cohort(-90d:)).context(channel)
```

This means: "for every fetchable edge, fetch 90-day window AND
90-day cohort data, broken out by channel."

**Explosion**: the pinned DSL is exploded into atomic slices before
fetching. The above explodes to (assuming channel values google,
meta, other):
```
context(channel:google).window(-90d:)
context(channel:meta).window(-90d:)
context(channel:other).window(-90d:)
context(channel:google).cohort(-90d:)
context(channel:meta).cohort(-90d:)
context(channel:other).cohort(-90d:)
```

Each atomic slice is fetched independently. Each fetch writes rows
to the snapshot DB with the same `core_hash` (per mode) but
different `slice_key` values.

**Bayes runs** also use the pinned DSL. The Bayes compiler explodes
it to determine what evidence to query from the snapshot DB.

The pinned DSL can change over time. When it changes, new fetches
write under new hashes (different context dimensions → different
`x` fields → different `core_hash`). Old data remains in the DB
under old hashes. This creates **epochs** — different date ranges
with data under different hashes.

### 0.4 How epochs vary

The `core_hash` for an edge's data can change due to:

1. **Pinned DSL changes**: user adds or removes context dimensions.
   - Before: `window(-90d:)` → hash with `x: {}`
   - After: `window(-90d:).context(channel)` → hash with
     `x: {channel: "..."}`

2. **Context definition changes**: user adds/removes values in a
   context definition (e.g. adds "other" to channel).
   - The `x` field changes because the definition hash changes.
   - New core_hash, but the old one is linked via hash mapping.

3. **Event definition changes**: user renames an event.
   - The `c` field changes (different event definition hash).
   - New core_hash, linked via hash mapping.

4. **Multiple context dimensions added at different times**:
   - Jan: `window(-90d:)` — H_bare
   - Feb: `window(-90d:).context(channel)` — H_ch
   - Mar: `(window(-90d:)).(context(channel);context(device))` — H_ch (unchanged) + H_dev (new)

A query spanning multiple epochs must stitch evidence from
different hashes without double-counting on any date.

### 0.5 Query DSL vs pinned DSL

The **pinned DSL** drives fetching. It determines what data EXISTS
in the snapshot DB. It is graph-level configuration, set by the
user in the automation panel.

The **query DSL** drives analysis. It determines what data is
REQUESTED for a specific analysis. It is constructed by the FE from
user selections (edge clicks, node picks, DSL editor) and may or
may not match the pinned DSL.

Examples of how they can differ:
- Pinned DSL: `(window(-90d:);cohort(-90d:)).context(channel)`
  Query DSL: `from(signup).to(purchase).window(-90d:)` —
  uncontexted aggregate (no channel breakdown)
- Pinned DSL: `(window(-90d:);cohort(-90d:)).context(channel)`
  Query DSL: `from(signup).to(purchase).cohort(-90d:).context(channel:google)` —
  specific channel value in cohort mode

The query DSL may ask for:
- The **aggregate** (no context) — satisfied by summing any MECE
  partition
- A **specific value** (e.g. channel:google) — must filter rows
  by slice_key
- A **dimension not in the pinned DSL** — cannot be satisfied (data
  doesn't exist at that granularity)
- A **dimension that was in a previous pinned DSL** — may be
  satisfiable from historical epoch data

### 0.6 Hash mappings

When event or context definitions change, the core_hash changes.
Historical data under the old hash becomes unreachable under the
new hash. **Hash mappings** bridge this gap.

A mapping links an old hash to a new hash as equivalent:
```json
{
  "core_hash": "old_hash",
  "equivalent_to": "new_hash",
  "operation": "equivalent"
}
```

Mappings are **transparent** to the read path:
- The FE computes a **closure set** via BFS over mappings from the
  current hash. This produces all equivalent hashes.
- The BE query uses `WHERE core_hash = ANY(closure_set)` — finding
  rows under any equivalent hash.
- Mappings are undirected: old→new and new→old are equivalent.
- Each fetch writes under whichever hash was current at fetch time.
  No fetch writes under both old and new hashes. So equivalent
  hashes naturally partition by date — no overlap, no
  deduplication needed.

Mappings are created manually (via the commit hash guard workflow)
when event/context definition changes are detected.

---

## 1. What we are designing for

### 1.1 Use cases the contract must support

**Use case A: FE analysis query (single query DSL)**

A user runs an analysis (cohort maturity, lag fit, daily conversions,
etc.) from the UI. The FE constructs a query DSL from the user's
selections. The BE retrieves snapshot data and computes the analysis.

Examples:
- `from(signup).to(purchase).window(-90d:)` — uncontexted aggregate
- `from(signup).to(purchase).cohort(-90d:).context(channel:google)` — specific context value
- `from(signup).to(purchase).window(-90d:).context(channel)` — per-channel breakdown

The FE knows the exact query. It can compute which hashes satisfy it.

**Use case B: Bayes fit (exploded pinned DSL)**

The Bayes compiler needs evidence for each edge. The pinned DSL is
exploded into atomic slices. Each slice was fetched under a known
hash. The compiler processes each slice independently.

The FE sends the full set of exploded slices. The BE (worker)
queries the DB for each slice's data.

**Use case C: Bayes aggregate evidence (pre-Phase C)**

The Bayes compiler (pre-Phase C) works at the aggregate level — it
wants total x, y per anchor_day, not per-context-value. It needs
to derive aggregate evidence from whatever per-context data exists
in the DB.

**Use case D: Bayes Phase C hierarchical model**

The compiler needs both aggregate evidence (parent) and per-context
evidence (children per MECE dimension). For each date, it needs to
know whether the evidence is aggregate (parent likelihood term) or
per-context (child likelihood terms, parent via Dirichlet).

**Use case E: Historical epoch transition**

The pinned DSL changed over time. Old dates have data under hash
H_old (e.g. uncontexted), new dates under H_new (e.g. channel-
contexted). A query spanning both eras must stitch evidence from
both hashes without double-counting on any date.

**Use case F: Hash mapping (event/context rename)**

An event was renamed. Old hash H_old has data for dates before the
rename, new hash H_new has data after. They're linked by a mapping.
The query must find data under both.

### 1.2 What the contract must prevent

- **Double-counting**: never sum rows from two different MECE
  partitions of the same aggregate for the same (anchor_day,
  retrieved_at)
- **Data loss**: don't discard rows that could legitimately satisfy
  the query
- **Wrong aggregation**: don't sum rows that aren't MECE-complete

---

## 2. Setup for all examples

### 2.1 Graph

Single edge: `signup → purchase`.

### 2.2 Context definitions

- `channel`: google, meta, other (MECE, otherPolicy=null)
- `onboarding_variant`: v1, v2 (MECE)
- `product_variant`: basic, premium (MECE)

### 2.3 Pinned DSL

`(window(-90d:);cohort(-90d:)).((context(onboarding_variant);context(product_variant)).context(channel))`

### 2.4 What this produces on daily fetch

The DSL explodes to 24 atomic slices (12 window + 12 cohort). For
window mode only (cohort is symmetric):

```
context(channel:google).context(onboarding_variant:v1).window(...)
context(channel:meta).context(onboarding_variant:v1).window(...)
context(channel:other).context(onboarding_variant:v1).window(...)
context(channel:google).context(onboarding_variant:v2).window(...)
context(channel:meta).context(onboarding_variant:v2).window(...)
context(channel:other).context(onboarding_variant:v2).window(...)
context(channel:google).context(product_variant:basic).window(...)
context(channel:meta).context(product_variant:basic).window(...)
context(channel:other).context(product_variant:basic).window(...)
context(channel:google).context(product_variant:premium).window(...)
context(channel:meta).context(product_variant:premium).window(...)
context(channel:other).context(product_variant:premium).window(...)
```

### 2.5 Hashing — what core_hash is produced

The core_hash includes:
- `c`: hash of (connection, event IDs, event def hashes, cohort_mode,
  latency config, normalised query string with context stripped)
- `x`: hash of each context **definition** (value list), keyed by
  context key name. NOT the specific value.

So `context(channel:google).context(onboarding_variant:v1).window()`
and `context(channel:meta).context(onboarding_variant:v2).window()`
produce the **same** core_hash — because:
- Same `c` (same edge, same connection, same events, same mode)
- Same `x`: `{channel: "def_hash_ch", onboarding_variant: "def_hash_ov"}`

All 6 onboarding_variant × channel window rows share one hash.
All 6 product_variant × channel window rows share a different hash.

**Window hashes for this edge:**

| Label | `x` field | Rows under this hash |
|---|---|---|
| H_ov_ch | `{channel: "...", onboarding_variant: "..."}` | 6 rows (2 ov × 3 ch) |
| H_pv_ch | `{channel: "...", product_variant: "..."}` | 6 rows (2 pv × 3 ch) |

(Cohort hashes H_ov_ch_coh, H_pv_ch_coh are analogous but with
`cohort_mode: true` in `c`.)

**No uncontexted hash exists** — the pinned DSL doesn't include
uncontexted fetches.

**No single-dimension hash exists** — there's no `context(channel)`
alone in the DSL; it's always crossed with onboarding_variant or
product_variant.

### 2.6 DB state (one day's fetch, one anchor_day for brevity)

| core_hash | slice_key | anchor_day | retrieved_at | x | y |
|---|---|---|---|---|---|
| H_ov_ch | `context(channel:google).context(onboarding_variant:v1).window(...)` | 2026-01-15 | 2026-02-01 | 30 | 6 |
| H_ov_ch | `context(channel:meta).context(onboarding_variant:v1).window(...)` | 2026-01-15 | 2026-02-01 | 20 | 4 |
| H_ov_ch | `context(channel:other).context(onboarding_variant:v1).window(...)` | 2026-01-15 | 2026-02-01 | 10 | 2 |
| H_ov_ch | `context(channel:google).context(onboarding_variant:v2).window(...)` | 2026-01-15 | 2026-02-01 | 25 | 5 |
| H_ov_ch | `context(channel:meta).context(onboarding_variant:v2).window(...)` | 2026-01-15 | 2026-02-01 | 10 | 2 |
| H_ov_ch | `context(channel:other).context(onboarding_variant:v2).window(...)` | 2026-01-15 | 2026-02-01 | 5 | 1 |
| H_pv_ch | `context(channel:google).context(product_variant:basic).window(...)` | 2026-01-15 | 2026-02-01 | 40 | 8 |
| H_pv_ch | `context(channel:meta).context(product_variant:basic).window(...)` | 2026-01-15 | 2026-02-01 | 20 | 4 |
| H_pv_ch | `context(channel:other).context(product_variant:basic).window(...)` | 2026-01-15 | 2026-02-01 | 10 | 2 |
| H_pv_ch | `context(channel:google).context(product_variant:premium).window(...)` | 2026-01-15 | 2026-02-01 | 15 | 3 |
| H_pv_ch | `context(channel:meta).context(product_variant:premium).window(...)` | 2026-01-15 | 2026-02-01 | 10 | 2 |
| H_pv_ch | `context(channel:other).context(product_variant:premium).window(...)` | 2026-01-15 | 2026-02-01 | 5 | 1 |

Aggregate: x=100, y=20 (summing either H_ov_ch or H_pv_ch gives
the same total — both are complete MECE cross-products).

---

## 3. Use case A: FE analysis — uncontexted aggregate

**Query DSL**: `from(signup).to(purchase).window(-90d:)`

No context specified. The consumer wants aggregate x, y.

### 3.1 What the FE knows

- The pinned DSL has two cross-product groups: ov×ch and pv×ch
- Both are MECE (all dimensions are MECE)
- Both cross-products are complete (all cells fetched)
- Summing all rows under either hash recovers the aggregate
- No uncontexted hash exists

### 3.2 What the FE sends

```
candidate_regimes: [H_ov_ch, H_pv_ch]  // either works
mece_dimensions: ["channel", "onboarding_variant", "product_variant"]
```

### 3.3 What the BE does

1. Query: `WHERE core_hash IN (H_ov_ch, H_pv_ch)`
   → 12 rows returned
2. Regime selection: for retrieved_at 2026-02-01, H_ov_ch is first
   in list and has data → wins. Keep 6 H_ov_ch rows, discard 6
   H_pv_ch rows.
3. Consumer sums all 6 rows: x=100, y=20. ✓

### 3.4 Does the BE need anything beyond core_hash + mece_dimensions?

No. It selected one hash, got its rows, all dimensions are MECE,
summed them. Correct aggregate.

---

## 4. Use case A variant: FE analysis — specific context value

**Query DSL**: `from(signup).to(purchase).window(-90d:).context(channel:google)`

### 4.1 What the FE knows

- The query asks for channel:google specifically
- Both H_ov_ch and H_pv_ch contain channel as a dimension
- Either hash has rows for channel:google
- Summing over the other dimension (ov or pv) within google gives
  the channel:google aggregate

### 4.2 What the FE sends

Same as §3.2 — the candidate list is per-edge, the query
determines how to filter.

### 4.3 What the BE does

1. Regime selection: H_ov_ch wins (same as §3.3).
2. Filter rows by slice_key: keep only rows where
   `channel:google` appears in slice_key:
   - ov:v1 × ch:google — x=30, y=6
   - ov:v2 × ch:google — x=25, y=5
3. Remaining dimension (onboarding_variant) is in mece_dimensions.
   Sum: x=55, y=11. ✓

### 4.4 Does the BE need anything beyond core_hash + mece_dimensions?

It needs to parse the query DSL to extract `channel:google` as a
filter. It can do this — the DSL is in the request. It then needs
to match `channel:google` against slice_key strings — which
requires parsing slice_keys. The normalisation code exists in
Python (`slice_key_normalisation.py`).

It also needs to know that `onboarding_variant` (the remaining
dimension after filtering) is MECE — from `mece_dimensions`. ✓

---

## 5. Use case A variant: FE analysis — dimension not in the winning hash

**Query DSL**: `from(signup).to(purchase).window(-90d:).context(product_variant:basic)`

### 5.1 What happens with the §3.2 contract

1. Regime selection: H_ov_ch wins (first in list, has data).
2. Filter rows by slice_key: keep rows with `product_variant:basic`.
   **No matches.** H_ov_ch has onboarding_variant × channel, not
   product_variant.

The query fails — returns no data. But the data IS in the DB under
H_pv_ch.

### 5.2 What went wrong

The candidate list `[H_ov_ch, H_pv_ch]` was ordered for an
uncontexted query. For a product_variant query, H_pv_ch is the
only eligible candidate — H_ov_ch can't satisfy it.

### 5.3 Fix: FE must order candidates per query

For this specific query, the FE should send `[H_pv_ch]` (or
`[H_pv_ch, H_ov_ch]` with H_pv_ch first). H_ov_ch is not eligible
because it doesn't contain the queried dimension.

**But**: the FE knows the query DSL. It can compute which hashes
have the right dimensions. This is a straightforward filter:
"keep candidates whose dimensions include all dimensions mentioned
in the query context clause."

For this query (`context(product_variant:basic)`), the FE filters
to candidates containing `product_variant` in their dimensions →
only H_pv_ch.

### 5.4 Does this mean per-query candidate lists?

**For FE analysis: yes.** The FE constructs the query, knows the
context clause, and filters the per-edge candidate list to eligible
hashes. This is cheap — just a set intersection on dimension names.

The FE already does this implicitly today (it builds per-slice
subjects with the right hash). The new contract just makes it
explicit.

---

## 6. Use case B: Bayes fit — exploded slices

**Each exploded slice is fetched under a known hash.** The compiler
processes each independently.

### 6.1 Example: `context(channel:google).context(onboarding_variant:v1).window(...)`

This was fetched under H_ov_ch. The Bayes worker needs the rows for
this specific cell.

**What the FE sends** (per exploded slice):

The FE knows exactly which hash this slice was fetched under —
H_ov_ch. It sends:

```
{
  edge_id: "...",
  core_hash: H_ov_ch,
  equivalent_hashes: [...],  // hash mappings
  slice_key_filter: "context(channel:google).context(onboarding_variant:v1).window()"
}
```

**What the BE does**:

1. Query: `WHERE core_hash IN (H_ov_ch, ...equivalents) AND
   normalised(slice_key) = 'context(channel:google).context(onboarding_variant:v1).window()'`
2. Gets 1 row: x=30, y=6.

No regime selection needed. No ambiguity. The hash is known, the
slice_key is known.

### 6.2 But what about historical epochs?

If the event was renamed, H_ov_ch_old has data for old dates and
H_ov_ch_new for new dates. The `equivalent_hashes` links them. The
query finds rows under both via the closure. Different dates, no
overlap, no regime selection needed.

### 6.3 Conclusion for use case B

For explicit per-slice Bayes queries, the contract is trivial:
- `core_hash` + `equivalent_hashes` for the specific hash
- `slice_key` filter for the specific cell
- No regime selection needed
- No MECE concerns — we're reading one cell, not aggregating

---

## 7. Use case C: Bayes aggregate evidence (pre-Phase C)

The compiler wants aggregate x, y per (anchor_day, retrieved_at) for
the edge. It doesn't care about per-context breakdowns.

### 7.1 How does it get aggregate from per-context data?

Same as use case A (§3): pick one hash, sum all rows under it. Both
H_ov_ch and H_pv_ch give the same aggregate.

### 7.2 What the FE sends

```
candidate_regimes: [H_ov_ch, H_pv_ch]
mece_dimensions: ["channel", "onboarding_variant", "product_variant"]
```

The Bayes submission includes this per edge, alongside the
per-slice subjects from use case B.

### 7.3 What the worker does

1. Query all candidate hashes (broad query).
2. Regime selection: pick one per retrieved_at.
3. Sum rows under winning hash → aggregate.

Same logic as FE analysis uncontexted (§3). The utility works. ✓

### 7.4 But wait — the worker already queries per-slice (use case B)

The worker iterates exploded slices and queries per slice. It
already has all the rows. For aggregate evidence, it doesn't need a
separate query — it can sum the per-slice results.

The question is: which per-slice results to sum? If the explosion
produced both ov×ch and pv×ch slices, summing ALL of them
double-counts. It must sum only one cross-product group.

**This is the same regime selection problem**, just happening over
already-fetched rows rather than at query time. The worker groups
its per-slice results by core_hash, picks one hash per
retrieved_at, sums within that hash. Same utility, same logic.

### 7.5 Conclusion for use case C

Regime selection IS needed for Bayes aggregate evidence. The
utility works. The FE sends `candidate_regimes` per edge so the
worker knows the preference order.

---

## 8. Use case D: Bayes Phase C — hierarchical model

The compiler needs:
- **Parent (aggregate)**: total x, y per (anchor_day, retrieved_at)
- **Children per dimension**: per-value x, y for each MECE dimension

### 8.1 Which children does the compiler want?

For the pinned DSL
`(window();cohort()).((context(ov);context(pv)).context(channel))`,
the compiler wants children for:
- onboarding_variant (v1, v2) — each with channel summed out
- product_variant (basic, premium) — each with channel summed out
- channel (google, meta, other) — each with ov or pv summed out

But these are derived from different hashes:
- ov values come from H_ov_ch rows (sum over channel within each ov)
- pv values come from H_pv_ch rows (sum over channel within each pv)
- channel values come from either hash (sum over ov or pv)

### 8.2 Does the compiler need rows from BOTH hashes?

**Yes.** For the onboarding_variant Dirichlet, it needs per-ov-value
evidence. That's in H_ov_ch. For the product_variant Dirichlet, it
needs per-pv-value evidence. That's in H_pv_ch.

**Regime selection (pick ONE hash per date) would discard one set of
children.** If H_ov_ch wins, the pv children have no evidence.

### 8.3 Resolution

For the parent (aggregate), pick one hash — regime selection is
correct, prevents double-counting.

For the children, the compiler needs rows from the SPECIFIC hash
that contains that dimension. This is per-dimension, not per-date:
- ov children always use H_ov_ch rows
- pv children always use H_pv_ch rows
- channel children can use either (channel is in both hashes)

This is use case B — each dimension's children are read via
per-slice queries with the correct hash. No regime selection
needed for per-dimension reads.

The regime selection only applies to the **parent aggregate** —
where the compiler must choose ONE hash to avoid double-counting.

### 8.4 Per-date likelihood routing (§11.5 of doc 30)

For a given (anchor_day, retrieved_at):
- The parent's evidence comes from the regime-selected hash
  (say H_ov_ch). The parent gets no direct likelihood term — it's
  informed through the ov Dirichlet.
- The ov children get per-value likelihood terms from H_ov_ch.
- The pv children get per-value likelihood terms from H_pv_ch.
- The channel children get per-value likelihood terms from either
  hash (they appear in both; use the same one as the parent for
  consistency).

The parent is constrained by TWO independent Dirichlets (ov and
pv). Each Dirichlet's children have evidence from their own hash.
No double-counting — each hash's rows are used for its own
dimension's children only.

### 8.5 Conclusion for use case D

Phase C needs:
- Regime selection for the parent aggregate (use case C)
- Per-hash, per-slice reads for each dimension's children (use case B)
- Both happen independently, no conflict

The contract supports this with:
- `candidate_regimes` per edge (for parent aggregate)
- Per-slice subjects with specific hash + slice_key (for children)
- `mece_dimensions` (for aggregation safety)

---

## 9. Use case E: historical epoch transition

### 9.1 Setup

Until 15-Jan, the pinned DSL was `window(-90d:)` (uncontexted).
From 16-Jan, the pinned DSL changed to
`window(-90d:).context(channel)`.

DB state:
- Dates 1-Jan to 15-Jan: rows under H_bare (`x: {}`)
  with slice_key `window(...)`, x=100, y=20 per day.
- Dates 16-Jan onwards: rows under H_ch (`x: {channel: "..."}`)
  with slice_keys `context(channel:google).window(...)` etc.

No H_bare data after 15-Jan. No H_ch data before 16-Jan.

### 9.2 Uncontexted aggregate query spanning both eras

**Query**: `from(signup).to(purchase).window(-90d:)` with sweep
covering 1-Jan to 28-Feb.

**Candidates**: `[H_ch, H_bare]` (prefer channel — current DSL).

**Regime selection per retrieved_at**:
- 1-Jan to 15-Jan: only H_bare has data → H_bare wins.
  Returns bare rows. Consumer uses x, y directly.
- 16-Jan onwards: only H_ch has data → H_ch wins.
  Returns channel rows. Consumer sums them → aggregate.

Clean transition. No overlap. No double-counting. ✓

### 9.3 Channel-specific query spanning both eras

**Query**: `...window(-90d:).context(channel:google)`

**Candidates**: `[H_ch]` (H_bare can't satisfy a channel-specific
query — no channel breakdown in its rows).

**Regime selection**:
- 1-Jan to 15-Jan: H_ch has no data → no rows for these dates.
- 16-Jan onwards: H_ch has data → returns channel rows.
  Filter to google. ✓

**Data loss for 1-Jan to 15-Jan.** The DB has uncontexted data
(H_bare) for those dates, but it can't be used for a
channel-specific query — there's no way to extract google's share
from the aggregate.

This is correct behaviour — not a bug. The data simply doesn't
exist at the required granularity for those dates.

---

## 10. Use case F: hash mapping

### 10.1 Setup

On 15-Feb, the `signup` event was renamed to `register`. This
changes the event definition hash → changes the core hash.

- Before 15-Feb: data under H_ch_old
- After 15-Feb: data under H_ch_new
- Mapping: H_ch_old ↔ H_ch_new (equivalent)

### 10.2 Query

**Candidates**: `[{core_hash: H_ch_new, equivalent_hashes: [H_ch_old]}]`

**BE query**: `WHERE core_hash IN (H_ch_new, H_ch_old)`

Gets rows from both hashes. Different dates (no overlap — each
fetch writes under whichever hash was current). Regime selection:
both belong to the same candidate (they're in the same equivalence
set). Both kept. ✓

This is RS-004 from the test suite — already tested and working.

---

## 11. Combined: epoch transition + hash mapping + multiple dimensions

### 11.1 Setup

Timeline:
- Jan: pinned DSL was `window(-90d:)` (uncontexted). Data under
  H_bare.
- Feb: pinned DSL changed to `window(-90d:).context(channel)`.
  Data under H_ch.
- Mar: `signup` event renamed to `register`. H_ch changes to
  H_ch_new. Mapping created: H_ch ↔ H_ch_new.
- Apr: pinned DSL changed to
  `window(-90d:).(context(channel);context(device))`.
  Data under H_ch_new (channel) and H_dev (device).

### 11.2 Uncontexted aggregate query spanning Jan-Apr

**Candidates**: `[{core_hash: H_ch_new, equiv: [H_ch]}, {core_hash: H_dev}, {core_hash: H_bare}]`

**Regime selection per retrieved_at**:
- Jan dates: only H_bare → H_bare wins. Aggregate directly.
- Feb dates: only H_ch → matches H_ch_new candidate via
  equivalent. Channel rows, sum → aggregate.
- Mar dates: only H_ch_new → matches directly. Sum → aggregate.
- Apr dates: H_ch_new and H_dev both have data. H_ch_new is first
  → wins. Sum channel rows → aggregate. H_dev discarded.

Every date gets one regime. No double-counting. Correct aggregate
throughout. ✓

### 11.3 Channel-specific query spanning Jan-Apr

**Candidates**: `[{core_hash: H_ch_new, equiv: [H_ch]}]`
(H_dev and H_bare can't satisfy channel:google)

- Jan dates: no data under H_ch or H_ch_new → no rows. Correct
  (channel data didn't exist then).
- Feb onwards: data exists. Filter to google. ✓

---

## 12. What the contract needs — summary from examples

### 12.1 For FE analysis (use cases A, E, F)

The FE constructs the query. It knows:
- Which context dimensions the query mentions
- Which hashes contain those dimensions
- Which hashes are eligible (dimensions ⊇ query dimensions)
- Hash mapping closures

The FE sends **per query** (not per edge):
- Ordered `candidate_regimes` filtered to eligible hashes
- `mece_dimensions` list

The BE does:
- Broad query with all candidate hashes
- Per-date regime selection (first match wins)
- Filter rows by query's context values (from DSL)
- Sum over remaining MECE dimensions

### 12.2 For Bayes per-slice reads (use case B)

Each exploded slice has a known hash. No ambiguity, no regime
selection.

The FE sends per slice:
- `core_hash` + `equivalent_hashes`
- The slice_key (from the exploded DSL)

The BE queries by hash + slice_key filter. Returns one cell's rows.

### 12.3 For Bayes aggregate evidence (use case C)

Same as FE analysis uncontexted (§12.1). The worker uses regime
selection to pick one hash per date, sums to aggregate.

The FE sends per edge:
- Ordered `candidate_regimes` (all hashes for this edge, any order
  since all give the same aggregate)
- `mece_dimensions`

### 12.4 For Bayes Phase C children (use case D)

Each dimension's children are read via per-slice queries (§12.2).
Different dimensions use different hashes. No conflict with regime
selection (which only applies to the parent aggregate).

### 12.5 What `mece_dimensions` enables

The BE uses it to decide:
- "Can I sum all rows under this hash to get the aggregate?" —
  yes, if all dimensions in the rows are in mece_dimensions.
- "After filtering to a specific value, can I sum over the
  remaining dimensions?" — yes, if those dimensions are in
  mece_dimensions.

It does NOT enumerate values. It doesn't validate completeness
(that's an integrity concern, not a selection concern).

---

## 13. Remaining questions

### 13.1 Does the BE need dimensions per hash?

In §5 (use case A variant), the FE needs to filter candidates to
those whose dimensions include the query's dimensions. The FE can
do this filtering because it knows which dimensions each hash
covers (it computed the signatures).

But does the BE also need this? If the FE sends pre-filtered
candidates per query, the BE doesn't need to know dimensions — it
just tries each candidate in order.

For Bayes (use case C), the candidate list is for aggregate queries
— all hashes are eligible (any MECE cross-product sums to the
aggregate). No filtering needed.

**Conclusion**: dimensions per hash are an FE concern for candidate
filtering. The BE doesn't need them. The FE does the filtering
before sending.

### 13.2 Per-query vs per-edge candidate lists

FE analysis: per-query (filtered by query dimensions). Cheap to
compute — just set intersection.

Bayes: per-edge for aggregate evidence. Per-slice for children
(trivial — one hash per slice). The per-edge list doesn't need
filtering because it's always for aggregate queries.

**Conclusion**: the FE sends the right list for the right purpose.
The contract doesn't need to support "per-edge list that works for
all queries" — that was the design error in the earlier draft.

### 13.3 Can the Bayes worker derive aggregate evidence without a separate query?

The worker already fetches per-slice rows (use case B). For
aggregate evidence (use case C), it could sum the appropriate
subset of already-fetched rows instead of doing a separate query.

This is equivalent to regime selection over the fetched rows: group
by hash, pick one hash per date, sum. The utility
`select_regime_rows` works on any row list — it doesn't need to be
at query time.

**Conclusion**: yes. The worker fetches per-slice, then applies
`select_regime_rows` over the collected rows to derive aggregate
evidence. No separate aggregate query needed.

---

## 14. Candidate generation: from the pinned DSL, not a superset of it

### 14.1 Anti-pattern 11 — hash construction, not source-of-truth

`KNOWN_ANTI_PATTERNS.md` §11 documents a class of bug where a read
path computes a signature from ALL context dimensions in the graph
config, producing a hash that was never stored. The fix is about
**correct hash construction** — understanding that the pinned DSL
produces specific cross-product key-sets, not a flat union of all
dimensions.

Example: pinned DSL
`(window();cohort()).((context(ov);context(pv)).context(channel))`
produces two cross-products:
- `{channel, onboarding_variant}` — one hash
- `{channel, product_variant}` — another hash

It does NOT produce `{channel, onboarding_variant, product_variant}`
— that would be a 3-way cross-product nobody asked for.

### 14.2 The pinned DSL is the authority

The candidate list comes from **exploding the current pinned DSL**
and extracting the distinct context key-sets that the explosion
produces. Each key-set maps to one core_hash. Hash mappings extend
each hash's reach to renamed equivalents.

The pinned DSL is the user's stated data interests. It determines
what data EXISTS (via daily fetch) and what data we WANT (for
analysis and Bayes). Historical data from previous DSL eras that
the user has moved on from is not a concern for regime selection.
If an event was renamed, hash mappings handle continuity.

### 14.3 The one way candidate generation can go wrong

**Inventing a hash that never existed**: naively merging all
context keys from the pinned DSL into a single key-set and
computing one hash. The explosion step prevents this — it produces
the correct per-cross-product key-sets.

The candidate generation path is: explode → group by key-set →
compute hash per key-set → add closures. This mirrors what the
daily fetch pipeline does when writing data.

---

## 15. Phase C concern: overconstrained parent with independent Dirichlets

### 15.1 The problem

If the pinned DSL is `context(a);context(b).window()`, the Phase C
model would have:

```
Parent (aggregate p_base)
  ├── Dimension A children (Dirichlet: Σ p_ai = p_base)
  └── Dimension B children (Dirichlet: Σ p_bj = p_base)
```

Both Dirichlets independently constrain `p_base` — each says "my
children's probabilities sum to the parent". But dimensions A and B
are orthogonal slicings of the **same** set of conversions. Their
evidence is not independent — it's the same data sliced two ways.

Treating them as independent Dirichlets means the parent is informed
by the same evidence twice (once via the A decomposition, once via
the B decomposition). This overcounts evidence at the parent level,
making the parent posterior artificially tight.

### 15.2 When this matters

This is NOT a regime selection concern — regime selection correctly
picks one hash per date and prevents double-counting at the row
level. The overconstrained parent is a **model specification**
concern that arises in Phase C when building the hierarchical
likelihood.

### 15.3 Possible resolutions (deferred to Phase C design)

1. **Only one Dirichlet per date**: for each date, only the
   regime-selected dimension contributes child likelihood terms.
   The other dimension's children have no evidence for that date
   (informed only through the hierarchy). This avoids double-
   counting but wastes evidence from the non-selected dimension.

2. **Shared parent via mixture**: model the parent as informed by
   a mixture of both decompositions, with explicit modelling of
   the shared-evidence correlation. More complex but statistically
   correct.

3. **One Dirichlet at a time**: fit dimension A's Dirichlet first,
   then dimension B's, each with the parent fixed from the
   previous step. Sequential, not joint.

This is a Phase C model design decision, not a Phase 1–3 concern.
Noted here for programme.md tracking.

---

## Appendix A: Tentative conclusions

These are the design conclusions we believe follow from the worked
examples. They are tentative — pending review and challenge.

### A.1 The contract has three distinct shapes

The regime selection problem is not one problem — it is three,
each with different requirements:

| Use case | Who constructs candidates | Candidate scope | Regime selection needed? |
|---|---|---|---|
| FE analysis (single query) | FE, per query | Filtered: only hashes whose dimensions ⊇ query's context dimensions | Yes — pick one hash per retrieved_at date |
| Bayes per-slice reads | FE, per exploded slice | Trivial: one hash per slice (the hash it was fetched under) | No — hash is known, no ambiguity |
| Bayes aggregate evidence | FE, per edge | All hashes for that edge (any MECE cross-product sums to aggregate) | Yes — pick one hash per retrieved_at to avoid double-counting |

Trying to unify these into a single contract shape (e.g. "per-edge
candidate list for all purposes") was the design error in the
earlier draft. Each use case sends the right structure for its
purpose.

### A.2 The `CandidateRegime` type is minimal

```
CandidateRegime {
  core_hash: string
  equivalent_hashes: string[]
}
```

No `slice_keys`, no `regime_kind`, no `dimensions`. The selection
utility only needs to match `core_hash` against rows. Everything
else (dimensional filtering, MECE validation, slice_key filtering)
is handled by other layers.

### A.3 `mece_dimensions` is a separate, flat, per-graph field

```
mece_dimensions: string[]   // e.g. ["channel", "onboarding_variant", "product_variant"]
```

Not per-hash, not per-query. A property of the graph's context
registry. Tells the BE which dimensions are safe to sum over when
aggregating rows under a hash. The BE extracts dimension names from
`slice_key` strings on returned rows and checks them against this
list.

### A.4 The FE does dimensional eligibility filtering

For FE analysis queries, the FE knows the query DSL and can
determine which hashes' dimensions are a superset of the query's
context dimensions. It filters the candidate list before sending.
The BE receives only eligible candidates and doesn't need to know
about dimensions.

For Bayes aggregate queries, all hashes are eligible (any complete
MECE cross-product sums to the aggregate), so no filtering is
needed. The candidate list is all hashes for that edge.

### A.5 The BE's role is simple

The BE does:
1. Query `WHERE core_hash = ANY(all hashes from all candidates)`
2. Call `select_regime_rows(rows, candidates)` → one hash per
   retrieved_at date
3. Pass filtered rows to the consumer

The consumer then:
- For aggregate: sums all rows per anchor_day (safe because all
  dimensions are MECE and the cross-product is from one hash)
- For specific value: filters by slice_key (parses the context
  value from the query DSL), then sums over remaining MECE
  dimensions

### A.6 Regime selection and slice_key filtering are orthogonal

Regime selection answers: "which hash's rows do I keep for this
retrieved_at date?" It operates on `core_hash` only.

Slice_key filtering answers: "within the kept rows, which specific
context values do I want?" It operates on `slice_key` strings.

These are independent operations. Regime selection happens first
(discard rows from non-winning hashes). Slice_key filtering happens
second (narrow to the queried value within the winning hash). Both
are needed, neither depends on the other's implementation.

### A.7 Phase C hierarchical model is compatible

Phase C needs:
- **Parent aggregate**: regime selection picks one hash per date,
  sums to aggregate. Same as use case C.
- **Per-dimension children**: each dimension's children are read
  from the hash that contains that dimension. This is a per-slice
  read (use case B), not regime selection.
- **Per-date likelihood routing**: for dates where per-context
  evidence exists, the parent has no direct likelihood term (it's
  informed through the Dirichlet). For dates where only aggregate
  evidence exists, the parent gets a direct likelihood term. The
  `regime_per_date` output from `select_regime_rows()` enables
  this — the consumer checks whether the winning hash is
  uncontexted (direct parent term) or contexted (children only).

The three use cases (parent, children, likelihood routing) compose
without conflict.

### A.8 The Bayes worker doesn't need a separate aggregate query

The worker already fetches per-slice rows (use case B). All the
data is in memory. To derive aggregate evidence (use case C), it
applies `select_regime_rows()` over the collected per-slice rows —
grouping by hash, picking one per date, summing. No extra DB
round-trip.

### A.9 Hash mappings are transparent throughout

Mappings are folded into `equivalent_hashes` on each
`CandidateRegime`. The selection utility treats
`{core_hash} ∪ {equivalent_hashes}` as one set. No special
handling needed — equivalent hashes naturally partition by date
(each fetch writes under one hash only).

### A.10 The existing `select_regime_rows()` utility is correct

The utility as implemented (15 tests passing) correctly handles:
- Per-retrieved_at date selection
- First-match-wins ordering
- Equivalent hash grouping within one regime
- Date-level grouping of timestamps
- Empty candidates, single regime, multi-regime overlap

No changes needed to the utility. The contract simplification
(removing `slice_keys` and `regime_kind` from `CandidateRegime`)
has already been applied and all tests pass.

### A.11 What still needs building

| Item | Status | Blocking? |
|---|---|---|
| `select_regime_rows()` utility | **DONE** — 15 tests | — |
| Consumer integration tests | **DONE** — 5 tests | — |
| Wired into API handler | **DONE** — 3 query sites, opt-in | — |
| Wired into Bayes worker | **DONE** — per-edge, opt-in | — |
| FE candidate regime construction | **NOT STARTED** | Yes — activates the BE code |
| FE `mece_dimensions` computation | **NOT STARTED** | Yes — needed for aggregation |
| DSL parsing: `context()` / trailing separators | **NOT STARTED** | No — nice-to-have |
| Remove FE preflight + epoch machinery | **NOT STARTED** | No — cleanup |
| Doc 30 update to match simplified contract | **NOT STARTED** | No — doc only |

### A.12 Open items and uncertainties

1. **Do we need `regime_per_date` for Phase C likelihood routing?**
   Currently `select_regime_rows()` returns it. If Phase C uses it,
   the BE needs to know whether the winning hash is "uncontexted"
   (no context dims in `x`) or "contexted". The BE could derive
   this from the returned rows' `slice_key` strings — if they
   contain `context(...)`, it's contexted. No FE input needed.
   But this is Phase C work; we can defer the decision.

2. **Per-query vs per-edge candidate lists for FE analysis:**
   the examples show per-query is needed (§5). But the current
   FE architecture sends per-subject (which is per-edge-per-query).
   The migration from `snapshot_subjects` to
   `candidate_regimes` + query DSL (doc 31) would naturally make
   this per-query. For now, the existing per-subject structure
   works — each subject already has the right hash for its query.

3. **Bayes aggregate evidence and the "which hash to prefer"
   ordering:** for aggregate queries, any MECE hash gives the same
   total. The ordering doesn't matter for correctness — only for
   consistency (use the same hash across dates when possible, to
   avoid artefacts from small floating-point differences in
   per-value rounding). In practice, "first in the candidate list"
   is fine.

### A.13 Candidates come from exploding the current pinned DSL

See §14. The candidate list is produced by exploding the current
pinned DSL and extracting the distinct context key-sets. Each
key-set maps to one core_hash. Hash mappings extend each hash's
reach to renamed equivalents.

The critical constraint is **correct hash construction**: the
explosion produces specific cross-product key-sets, not a flat
union of all dimensions. Anti-pattern 11 (`KNOWN_ANTI_PATTERNS.md`
§11) documents the bug class where a read path merges all
dimensions into one hash that was never stored.

Historical data from previous DSL eras is not a concern for regime
selection. If the user changed the pinned DSL, they moved on. If
an event/context was renamed, hash mappings handle continuity.

### A.14 Phase C: multiple independent Dirichlets risk overcounting

When a pinned DSL has `context(a);context(b)`, dimensions A and B
are orthogonal slicings of the same conversions. Representing
them as independent Dirichlets (each constraining the parent)
overcounts evidence at the parent level. See §15.

This is a model specification concern for Phase C, not a regime
selection concern. The regime selection utility correctly prevents
double-counting at the row level. The overconstrained parent is a
downstream issue for the Bayes compiler's likelihood construction.

Three possible resolutions are identified in §15.3. This should
be tracked in programme.md as a Phase C design prerequisite.
