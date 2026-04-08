# Doc 30 — Snapshot Regime Selection Contract

**Status**: Design — partially implemented (utility + wiring done,
FE candidate construction not started).
See `30b-regime-selection-worked-examples.md` for worked examples.
**Date**: 7-Apr-26
**Purpose**: Define the FE/BE contract for selecting one coherent set
of snapshot rows per retrieval date when multiple candidate hash
families could satisfy a query. Eliminates the FE preflight
round-trip and moves regime selection to the BE where DB availability
is known.

**Related**: `11-snapshot-evidence-assembly.md` (Phase S evidence
binder), `../project-db/1-reads.md` (snapshot read architecture),
`../project-db/context-epochs.md` (epoch evolution),
`../project-contexts/mece-context-aggregation-design.md` (MECE
fulfilment), `6-compiler-and-worker-pipeline.md` (Layer 4 evidence)

---

## 1. Problem statement

### 1.1 The double-counting bug

A pinned DSL like `context(channel);context(device).window(-90d:)`
produces two independent MECE context dimensions. Each dimension has
its own query signature and therefore its own `core_hash`. Both fetch
the same underlying conversions sliced differently:

- Hash H_channel: `context(channel:google).window()` x=60,
  `context(channel:meta).window()` x=40. Sum = 100.
- Hash H_device: `context(device:mobile).window()` x=55,
  `context(device:desktop).window()` x=45. Sum = 100.

Both are correct MECE representations of the same aggregate (x=100).
But if the BE retrieves rows from both hashes and sums them, it gets
x=200. This is double-counting.

The same problem arises with:
- **DSL evolution**: pinned DSL changes over time, producing different
  hashes for different date ranges. Old and new hashes may coexist for
  transition dates.
- **Hash mappings**: event/context renames produce equivalent hashes.
  Multiple equivalents may have rows for the same date.
- **Combinations**: all of the above interacting.

### 1.2 Where double-counting currently occurs

**BE analysis path**: `derive_cohort_maturity()` groups by
`(anchor_day, slice_key)` and sums `y` across all slice keys per
anchor day per retrieval date. No per-hash deduplication.

**Bayes evidence binder**: `_bind_from_snapshot_rows()` groups by
`(anchor_day, retrieved_at)` and sums any row containing `"context("`.
No dimension-awareness.

**Lag model fitter**: `select_latest_evidence()` takes latest per
`(anchor_day, slice_family)` then sums across slices. Same risk.

### 1.3 The unnecessary FE preflight

The current `cohort_maturity` path in `snapshotDependencyPlanService`
makes a network round-trip (`querySnapshotRetrievals` with broad
`slice_keys: ['']`) to discover what slice families exist per
retrieval date in the DB. It then uses this to pick a regime per day
via `selectLeastAggregationSliceKeysForDay` and segments the sweep
into epochs with specific `slice_keys`.

This is the FE doing the BE's job. The FE does not naturally know
what is in the DB — it must ask. The BE has the DB — it should do
the selection. The preflight adds latency, complexity, and a contract
that is hard to reason about (the FE pre-decides, the BE blindly
executes).

---

## 2. Core invariant

**For a given (edge, anchor_day, retrieved_at) triple, the BE must
select rows from exactly one observation regime.** Regimes are not
additive — they are alternative representations of the same
underlying conversion event. Summing across regimes double-counts.

Within a single regime, context slices from one MECE dimension ARE
additive: `context(channel:google) + context(channel:meta)` recovers
the aggregate. But slices from different dimensions are NOT additive:
`context(channel:google) + context(device:mobile)` double-counts.

---

## 3. How hashing works (essential context)

The `core_hash` used as the DB lookup key is derived from a
**structured signature** containing two parts:

- **`c` (core)**: hash of the edge's query identity — connection,
  event IDs, event definition hashes, latency config, normalised
  query string. **Context values are stripped.** This is the same
  for all values within a MECE dimension.
- **`x` (context definitions)**: hash of each context **definition**
  (the MECE value list), keyed by context key name. Not the specific
  value — the definition.

`core_hash = shortHash(JSON.stringify({c, x}))`.

Consequences:

- `context(channel:google).window()` and `context(channel:meta).window()`
  produce the **same** core_hash. All values within one MECE dimension
  share one hash.
- `context(channel).window()` and `context(device).window()` produce
  **different** core_hashes — different `x` fields.
- `context(channel).window()` and `window()` produce **different**
  core_hashes — `x: {channel: "abc"}` vs `x: {}`.
- A cross-product `context(channel).context(device).window()` produces
  yet another core_hash — `x: {channel: "abc", device: "def"}`.

A **regime** is therefore one core_hash — which corresponds to one
set of context dimensions (or none). All rows under that hash are
part of the same MECE partition. Rows from different hashes are
alternative representations of the same aggregate and must NOT be
summed.

Summing rows within one hash to recover the aggregate is safe only
if all dimensions in those rows are MECE. The BE checks this via
`mece_dimensions` (§4.1) — a flat list of MECE dimension names
sent by the FE.

---

## 4. Contract

### 4.1 What the FE sends

The FE sends two things:

**Per query (FE analysis) or per edge (Bayes aggregate)**:
an ordered list of candidate hashes. Each entry is a core_hash
plus its equivalents via hash mappings. The ordering encodes
preference (more granular first, uncontexted last).

```
CandidateRegime {
  core_hash: string           // FE-computed from pinned DSL explosion
  equivalent_hashes: string[] // from hash mappings
}
```

**Per graph**: a flat list of which context dimensions are MECE.

```
mece_dimensions: string[]     // e.g. ["channel", "onboarding_variant"]
```

#### Candidate construction

The FE explodes the current pinned DSL into atomic slices, extracts
the distinct context key-sets that the explosion produces (each
key-set maps to one core_hash), computes the hash for each, and
adds hash-mapping closures. This mirrors what the daily fetch
pipeline does when writing data.

For a pinned DSL `(context(channel);context(device)).window(-90d:)`,
the explosion produces key-sets `{channel}` and `{device}`. The
candidates per edge (for an aggregate query) are:

```
candidate_regimes: [
  { core_hash: H_channel, equivalent_hashes: [...] },
  { core_hash: H_device,  equivalent_hashes: [...] },
]
```

For a query targeting a specific dimension
(`context(product_variant:basic).window()`), the FE filters the
candidate list to only hashes whose key-set includes the queried
dimension. If no candidate qualifies, the query cannot be satisfied
(the data was never fetched at that granularity).

No DB round-trip required. The FE describes what COULD have data;
the BE determines what DOES.

#### MECE dimensions

`mece_dimensions` is a property of the graph's context registry —
not per-hash, not per-query. It tells the BE which dimensions are
safe to sum over when aggregating rows under a hash.

The BE uses it as follows: after regime selection returns rows from
one hash, the BE inspects the `slice_key` strings on those rows to
extract dimension names. If it needs to aggregate (e.g. sum over
channel values to get the aggregate), it checks that the dimension
being summed over is in `mece_dimensions`. If yes, the sum is safe.

The BE derives everything else from the query DSL and the slice_key
strings: which dimensions to group by (from the query), which to
sum over (the remainder), and which specific values to filter to
(from the query's context clause).

### 4.2 What the BE does

1. Query: `WHERE core_hash = ANY(all hashes from all candidates)`.
   Single broad query, full sweep range.
2. Call `select_regime_rows(rows, candidates)`: for each distinct
   `retrieved_at` date, try candidates in order, keep only rows
   from the first hash that has data. Returns filtered rows.
3. Pass filtered rows to the consumer (derivation function or
   evidence binder).

The consumer then:
- For aggregate queries: sums all rows per anchor_day (safe because
  all dimensions in the rows are checked against `mece_dimensions`)
- For specific-value queries: filters by slice_key (from query DSL),
  then sums over remaining MECE dimensions
- For per-dimension breakdowns: groups by the queried dimension,
  sums over the others

**Selection granularity is per `retrieved_at`, not per
`anchor_day`.** A single fetch writes all anchor_days under one
hash. The regime is consistent within a retrieval.

**The BE does NOT verify MECE completeness.** It trusts that data
under a given hash was complete at fetch time.

### 4.3 Epoch segmentation becomes unnecessary

The FE no longer segments the sweep into epochs. It sends one
request per edge with the full sweep range and the candidate list.
Different `retrieved_at` dates naturally resolve to different
candidates — epoch boundaries emerge from the data.

---

## 5. Bayes evidence assembly

### 5.1 Three read patterns

The Bayes compiler has three distinct read patterns:

- **Per-slice reads**: each exploded DSL slice has a known hash
  (from the pinned DSL explosion). The worker queries by that hash
  + slice_key filter. No regime selection needed — no ambiguity.

- **Aggregate evidence** (pre-Phase C): the compiler wants
  aggregate `(x, y)` per edge. The worker applies
  `select_regime_rows()` over the collected per-slice rows to pick
  one hash per date and sums to aggregate. Same logic as FE
  uncontexted analysis. Uses `mece_dimensions` to confirm the sum
  is safe.

- **Phase C children**: each dimension's children are read from the
  specific hash that contains that dimension. Per-slice reads, no
  regime selection. Different dimensions use different hashes —
  no conflict with the aggregate's regime selection.

### 5.2 The uncontexted aggregate problem

Consider a pinned DSL: `(window(-90d:);cohort(-90d:)).context(channel)`

This explodes to contexted slices only:
- `context(channel:google).window(-90d:)`
- `context(channel:meta).window(-90d:)`
- `context(channel:google).cohort(-90d:)`
- `context(channel:meta).cohort(-90d:)`

The explosion does NOT include an uncontexted `window(-90d:)` or
`cohort(-90d:)`. So the Bayes compiler has model variables only at
the per-channel level. Deriving uncontexted aggregate model variables
(needed for uncontexted analyses, overlay comparisons, and any
consumer that doesn't specify a context) requires summing across the
MECE partition — which is feasible but adds complexity and fragility.

The cleaner solution: **fetch uncontexted data too.** The pinned DSL
should be:

```
(window(-90d:);cohort(-90d:)).(context(channel);context())
```

Where `context()` means "also fetch the uncontexted aggregate". This
produces an additional fetch per edge (uncontexted alongside the
channel partition), but the price is worth paying:

- The compiler gets direct aggregate observations without
  MECE-summing
- Model variables exist at both the per-context and aggregate levels
- Uncontexted analyses work without aggregation logic
- A single pinned DSL drives both fetching and modelling

### 5.3 DSL syntax: `context()` as "uncontexted"

**Current state**: `context()` in `queryDSL.ts` means "explicit clear"
— a scenario delta mechanism for removing context from an inherited
query. It has `contextClausePresent: true` with no key/value. The
explosion code in `dslExplosion.ts` treats bare keys (e.g.
`context(channel)`) as "expand via Cartesian product over registered
values" but does not handle `context()` as "include uncontexted".

**Needed**: `context()` in a semicolon position within a pinned DSL
should mean "also fetch the uncontexted slice". When exploded:

```
(window(-90d:)).context(channel);context()
```

explodes to:
- `context(channel:google).window(-90d:)`
- `context(channel:meta).window(-90d:)`
- `window(-90d:)` ← uncontexted

This requires a small extension to `explodeDSL`: when a semicolon
part is `context()` (no key), emit the temporal clause without any
context qualifier. The scenario-delta "clear" semantics of
`context()` would remain unchanged in `composeConstraints` — the
disambiguation is by position (pinned DSL semicolon part vs scenario
delta clause).

**Resolved**: `context()` is the syntax. Empty elements in any
separator position — trailing (`context(channel);`), leading
(`;context(channel)`), trailing comma in or (`or(context(channel),)`),
leading comma (`or(,context(channel))`), or explicit `context()` —
all mean "include the uncontexted slice". No new keyword.

### 5.4 Regime selection in the Bayes path

Per-slice reads (§5.1) don't need regime selection — each has a
known hash.

For aggregate evidence, the worker applies `select_regime_rows()`
over the collected per-slice rows. All values within one dimension
share one core_hash (§3), so the candidates are dimension-level
hashes. The worker picks one per date, sums the winning hash's
rows, checks `mece_dimensions` to confirm the sum is safe.

### 5.5 Mixed epochs are handled implicitly

The FE does not know — and does not need to know — whether the
sweep span requires mixed epochs (different regimes for different
dates). It cannot know this because it has no visibility into which
hashes have data for which dates. That is DB state.

The FE's job is purely: **enumerate all hashes that could ever
satisfy this query, across all DSL eras and hash mappings, in
preference order.** This is a static computation from graph
topology + pinned DSL history + hash mapping closures. No DB
round-trip needed.

The BE handles mixed epochs as a natural consequence of per-date
selection:

1. **One broad SQL query**: `core_hash = ANY(all hashes from all
   candidate regimes)`, full sweep range. Returns rows from every
   hash that has data anywhere in the sweep.
2. **Python post-filter**: `select_regime_rows()` groups rows by
   `retrieved_at` date, iterates candidate regimes in preference
   order per group, keeps only the winning regime's rows.

Different `retrieved_at` dates naturally resolve to different
regimes. For example, across a 90-day sweep:

- Jan dates → only H_bare (uncontexted) has data (pre-context era)
  → regime 2 wins
- Feb dates → H_channel has data (context added to pinned DSL)
  → regime 0 wins (closest match)
- Mar dates → H_channel_v2 has data (event rename, mapped to
  H_channel) → regime 0 still wins (via equivalent hash)

The BE does not need epoch boundary detection, epoch segmentation,
or any notion of "which DSL era produced which data". It simply
asks, per date: "which of my preferred regimes has rows here?" The
epoch structure emerges from the data.

This eliminates the FE preflight entirely. The current
`querySnapshotRetrievals` call + `selectLeastAggregationSliceKeys
ForDay` + `segmentSweepIntoEpochs` machinery is replaced by a
static candidate list on the FE side and a post-filter on the BE
side.

### 5.6 What the compiler receives

After regime selection, the compiler gets per edge:

- **Uncontexted window observations**: aggregate `(x, y)` per
  `(anchor_day, retrieved_at)`. Used for Phase 1 probability.
- **Uncontexted cohort observations**: aggregate `(a, y)` per
  `(anchor_day, retrieved_at)`. Used for Phase 2 probability.
- **Per-context observations** (Phase C): per-slice `(x, y)` for
  each context value. Not summed — kept separate for hierarchical
  modelling.
- **Maturation trajectories**: multiple `retrieved_at` per
  `anchor_day`, showing y growth over time.
- **Per-retrieval onset observations**: `onset_delta_days` per
  `retrieved_at` (deduplicated).

Pre-Phase C, the compiler uses only the uncontexted observations.
Phase C adds per-context observations as additional likelihood
terms with shrinkage toward the aggregate.

---

## 6. Shared Python utility: regime selection

### 6.1 Interface

```python
@dataclass
class CandidateRegime:
    core_hash: str
    equivalent_hashes: list[str] = []

@dataclass
class RegimeSelection:
    rows: list[dict]
    regime_per_date: dict[str, CandidateRegime]
    # retrieved_at (date-level ISO string) → winning regime.

def select_regime_rows(
    rows: list[dict],
    candidate_regimes: list[CandidateRegime],
) -> RegimeSelection:
    """Filter rows to one regime per retrieved_at date.

    For each distinct retrieved_at in the input rows:
    1. Try each candidate regime in order.
    2. A regime "matches" if any row has core_hash in
       {regime.core_hash} ∪ {regime.equivalent_hashes}.
    3. Keep only rows from the first matching regime.
    4. Discard rows from all other regimes for that date.
    """
```

The `regime_per_date` output is informational — the utility doesn't
use it for selection. Phase C consumers can inspect the winning
regime's rows' `slice_key` strings to determine whether the data is
contexted (contains `context(...)`) or uncontexted, and route
likelihood terms accordingly.

### 6.2 Consumers

- `derive_cohort_maturity()` — called before building virtual
  snapshots
- `_bind_from_snapshot_rows()` — called before building trajectories
  in the Bayes evidence binder
- `select_latest_evidence()` — called before lag model fitting
- Any future derivation that aggregates across slices

### 6.3 Implementation notes

- Group input rows by `retrieved_at` (date-level, not datetime —
  multiple retrievals on the same calendar day belong to the same
  regime decision).
- For each group, iterate candidate regimes in order. Build a set of
  all hashes for the regime (core + equivalents). Check if any row in
  the group has `core_hash` in that set. First match wins.
- Filter: keep only rows whose `core_hash` is in the winning regime's
  hash set for that `retrieved_at` group.
- Rows from `retrieved_at` dates where no regime matches are
  discarded (should not happen if candidates are correctly
  constructed, but fail-safe).

---

## 7. What changes

### 7.1 FE changes

- **Remove preflight round-trip** from `snapshotDependencyPlanService`
  for `cohort_maturity` read mode. The FE no longer queries
  `querySnapshotRetrievals` to discover available families.
- **Build `candidate_regimes` per edge** from DSL explosion + hash
  mappings + context registry. No DB access needed.
- **Simplify epoch handling**: the FE sends one subject per edge with
  the full sweep range and the candidate regimes list. Epoch
  segmentation (if still useful for UI) becomes a post-hoc
  annotation of the BE response, not a pre-hoc request structure.
- **Bayes trigger**: `useBayesTrigger.ts` and
  `bayesReconnectService.ts` build candidate regimes per edge. The
  Bayes case is a loop over the analysis case — for each exploded
  DSL instance, apply the same regime selection.
- **`context()` in pinned DSL**: extend `explodeDSL` to treat
  `context()` in a semicolon position as "include the uncontexted
  aggregate slice". This ensures both contexted and uncontexted data
  are fetched, giving the compiler direct aggregate observations
  without requiring MECE-summation. See §5.3 for syntax discussion.

### 7.2 BE changes (Python)

- **New utility**: `select_regime_rows()` in a shared module
  (e.g. `lib/snapshot_regime_selection.py`).
- **Integrate into derivation paths**: `derive_cohort_maturity`,
  evidence binder, lag fitter all call `select_regime_rows` before
  aggregation.
- **API handler**: accept `candidate_regimes` on snapshot subject
  requests. Pass through to the selection utility.
- **Bayes worker**: same — accept candidate regimes, call selection
  utility before evidence binding.

### 7.3 Test design

The regime selection utility is consumed by every BE path that
aggregates snapshot rows. Tests must cover the utility itself AND
verify that each consumer produces correct results when regimes are
mixed. All tests are red-first: write the test, verify it fails
against the current code, then implement the fix.

**Implementation note**: `CandidateRegime` has been simplified to
`{core_hash, equivalent_hashes}` only. The test implementation
(RS-001 to RS-012, RC-001 to RC-006) uses this simplified type
and all 20 tests pass. `mece_dimensions` is part of the contract
(§4.1) but not yet tested — the consumer tests verify regime
selection prevents double-counting, but do not yet verify that
the BE checks `mece_dimensions` before aggregating. This is
Phase 3 work (FE sends `mece_dimensions` alongside candidates).

#### 7.3.1 Scope of the double-counting bug

Eight BE consumers aggregate snapshot rows across slices. All are
vulnerable:

| Consumer | File | Aggregation pattern | Risk |
|---|---|---|---|
| `derive_cohort_maturity()` | `runner/cohort_maturity_derivation.py` | Sum y/x/a across slices per (anchor_day, retrieved_at) | CRITICAL |
| `select_latest_evidence()` | `runner/lag_model_fitter.py` | Latest per (anchor_day, slice_family), then sum across families | CRITICAL |
| `derive_lag_fit()` | `runner/lag_fit_derivation.py` | Delegates to `select_latest_evidence()` | CRITICAL |
| `derive_daily_conversions()` | `runner/daily_conversions_derivation.py` | Delta-y between consecutive retrieved_at per series | CRITICAL |
| `derive_lag_histogram()` | `runner/histogram_derivation.py` | Delta-y binned by lag days | CRITICAL |
| `_bind_from_snapshot_rows()` | `bayes/compiler/evidence.py` | Sum context-prefixed x/y/a per (anchor_day, retrieved_at) | CRITICAL |
| `handle_snapshots_query_full()` | `api_handlers.py` | Pass-through (caller aggregates) | MEDIUM |
| `handle_lag_recompute_models()` | `api_handlers.py` | Delegates to `select_latest_evidence()` | CRITICAL |

Three distinct aggregation patterns, each with a different failure
mode:

**Pattern A — Sum across slices**: `derive_cohort_maturity`,
`_bind_from_snapshot_rows`. If two regimes' rows are summed for the
same (anchor_day, retrieved_at), values double-count.

**Pattern B — Delta computation**: `derive_daily_conversions`,
`derive_lag_histogram`. If a (anchor_day, slice_key) series mixes
rows from different regimes across retrieved_at, deltas are computed
across regime boundaries, producing artefact values.

**Pattern C — Latest-per-anchor_day**: `select_latest_evidence`. If
multiple regimes' rows exist for the same anchor_day, "latest"
selection picks across regime boundaries, mixing evidence.

#### 7.3.2 Test file structure

Three new Python test files, plus additions to existing files:

```
lib/tests/
  test_snapshot_regime_selection.py       # NEW — utility unit tests
  test_regime_consumer_integration.py     # NEW — per-consumer integration
  test_regime_bayes_evidence.py           # NEW — Bayes evidence binder
```

Plus additions to existing:
- `test_snapshot_read_integrity.py` — new CE-series tests for
  regime-aware queries
- `test_cohort_maturity_derivation.py` — regime-mixed input
- `test_lag_model_fitter.py` — regime-mixed input

#### 7.3.3 Utility tests: `test_snapshot_regime_selection.py`

Tests for `select_regime_rows()` in isolation. Pure function: rows
in, `RegimeSelection` out. No DB, no network.

**Fixture**: helper to build synthetic rows:
```python
def row(anchor_day, retrieved_at, core_hash, slice_key, x, y, a=0):
    return dict(anchor_day=anchor_day, retrieved_at=retrieved_at,
                core_hash=core_hash, slice_key=slice_key,
                x=x, y=y, a=a)
```

**RS-001: Two MECE dimensions, same (anchor_day, retrieved_at)**

Rows from H_channel (`context(channel:google).window()` x=60,
`context(channel:meta).window()` x=40) and H_device
(`context(device:mobile).window()` x=55,
`context(device:desktop).window()` x=45) for the same retrieval
date. Candidate order: [H_channel, H_device].

Assert: only H_channel rows returned (2 rows, x=60+40). H_device
rows discarded. `regime_per_date` maps that date to the channel
regime.

**RS-002: Regime transition across retrieved_at dates**

- retrieved_at 1-Jan: only H_bare has rows (window() x=100)
- retrieved_at 15-Jan: only H_channel has rows
- retrieved_at 1-Feb: both H_channel and H_device have rows

Candidates: [H_channel, H_device, H_bare].

Assert:
- 1-Jan → H_bare (only match, despite being last in preference)
- 15-Jan → H_channel (first match)
- 1-Feb → H_channel (preferred over H_device)

`regime_per_date` maps each date to the correct regime.

**RS-003: Uncontexted fallback**

H_channel has no data for a date. H_bare does. Candidates:
[H_channel, H_bare].

Assert: H_bare rows returned for that date.

**RS-004: Hash mapping within one regime**

H_channel_old and H_channel_new are equivalents (same regime, both
listed in `equivalent_hashes`). Both have rows for same
retrieved_at.

Assert: both rows kept (they are the same regime). Not
double-counted — the regime is one entry with both hashes in its
equivalence set.

**RS-005: Hash mapping across regimes**

H_channel_old (regime 0, with equivalent H_channel_new) and
H_device (regime 1) both have rows for same date. Regime 0 matches
via equivalent hash.

Assert: regime 0 wins (via H_channel_new match). H_device rows
discarded.

**RS-006: Empty candidates**

No regimes match any rows. Assert: empty rows, empty
`regime_per_date`.

**RS-007: Single regime pass-through**

Only one candidate. All rows match. Assert: all rows returned
unchanged. `regime_per_date` maps every date to that regime.

**RS-008: Three dimensions + uncontexted**

Channel (2 values), device (2 values), geo (3 values), plus bare.
Various availability per date:
- Date A: all four regimes have data → channel wins (first)
- Date B: only geo and bare → geo wins (before bare)
- Date C: only bare → bare wins
- Date D: nothing → no rows

Assert correct selection per date.

**RS-009: Closest-match ordering (superset preference)**

Query is for `context(channel:google).window()`. Candidates:
- Regime 0: exact hash for `context(channel:google).window()`
- Regime 1: cross-product hash for
  `context(channel:google).context(device).window()` (superset —
  requires summing over device)

Both have data. Assert: regime 0 wins (exact match, zero
aggregation).

**RS-010: Superset is only option**

Same as RS-009 but regime 0 has no data. Assert: regime 1 selected.
Rows include all cross-product slices for channel:google.

**RS-011: Date-level grouping (multiple retrieved_at same day)**

Two retrievals on the same calendar day (different timestamps).
Assert: both belong to the same regime decision (grouped by date,
not datetime).

**RS-012: regime_per_date correctness**

Verify `regime_per_date` dict:
- Keys are date-level strings (not datetimes)
- Values are the actual CandidateRegime objects from the input list
- Every date that has rows in the output appears in the dict
- No extra dates

#### 7.3.4 Consumer integration tests

For each consumer, feed regime-mixed rows (pre-`select_regime_rows`)
and verify the output is wrong (red test), then feed regime-selected
rows and verify correctness.

**Test file: `test_regime_consumer_integration.py`**

**RC-001: `derive_cohort_maturity` with mixed regimes (Pattern A)**

Fixture: 3 anchor days, 5 retrieval dates. Retrieval dates 1-3 have
H_channel rows, dates 4-5 have both H_channel and H_device rows.

Without regime selection: assert y values are inflated on dates 4-5
(double-counted). This is the red test.

With regime selection: assert y values correct on all dates. Virtual
snapshot curves are smooth across the regime boundary.

**RC-002: `derive_cohort_maturity` with regime transition**

Fixture: retrieved_at dates 1-15 have H_bare (uncontexted),
dates 16-30 have H_channel (contexted). No overlap.

Assert: frames for dates 1-15 use aggregate values. Frames for
dates 16-30 use channel-summed values (should equal aggregate).
No discontinuity at the boundary (both regimes represent the same
truth).

**RC-003: `select_latest_evidence` with mixed regimes (Pattern C)**

Fixture: same anchor_day, two retrieved_at dates from different
regimes. H_channel at day 10 (y=50), H_device at day 12 (y=55).

Without regime selection: `select_latest_evidence` picks H_device
(latest), giving y=55 from one regime plus y=50 from the other on
the same anchor_day if slice_keys differ. Depending on
normalisation, this may or may not sum — verify the failure mode.

With regime selection: only one regime's rows present. Latest
selection is unambiguous.

**RC-004: `derive_daily_conversions` with mixed regimes (Pattern B)**

Fixture: anchor_day=1-Jan. Retrieval sequence:
- Day 1: H_channel rows, y=10
- Day 2: H_device rows, y=8
- Day 3: H_channel rows, y=15

Without regime selection: delta sequence is [10, -2, +7]. The
y=8→y=15 delta (+7) spans a regime boundary and is an artefact.

With regime selection (assuming H_channel preferred): only days 1
and 3 remain. Delta sequence is [10, +5]. Correct.

**RC-005: `derive_lag_histogram` with mixed regimes (Pattern B)**

Same fixture as RC-004 adapted to lag bins. Verify that lag bins
don't contain artefact deltas from regime boundary crossings.

**RC-006: `select_latest_evidence` for lag fit — weighted averages**

Fixture: two regimes with different `median_lag_days` values on
the same anchor_day. Verify that the weighted average uses only one
regime's values, not a mixture.

#### 7.3.5 Bayes evidence binder tests

**Test file: `test_regime_bayes_evidence.py`**

**RB-001: `_bind_from_snapshot_rows` with two MECE dimensions**

Fixture: rows from H_channel and H_device for same edge, same
anchor_days, same retrieved_at dates.

Without regime selection: x/y values doubled (context rows from
both dimensions summed). Assert total_n is 2× expected.

With regime selection: only one regime's rows. Assert total_n
matches expected aggregate.

**RB-002: Mixed-epoch evidence binding**

Fixture: Jan retrieved_at dates have H_bare rows, Feb have
H_channel rows.

Assert: Jan trajectories use aggregate values. Feb trajectories
use channel-summed values. Both are correct. Trajectory continuity
across the boundary (no artefact jumps in cumulative y).

**RB-003: Regime tag drives likelihood structure (Phase C prep)**

Fixture: same as RB-002. Check `regime_per_date` output.

Assert:
- Jan dates → regime_kind='uncontexted' → evidence binder should
  emit parent likelihood terms
- Feb dates → regime_kind='mece_partition' → evidence binder should
  emit child likelihood terms, no parent term

(This test can be written now as a contract test on the
`RegimeSelection` output, even though the Phase C evidence binder
doesn't exist yet.)

**RB-004: Onset observations deduplicated per regime**

Fixture: H_channel and H_device both have onset_delta_days values
for the same retrieved_at.

Assert: only one regime's onset observations used. No duplicate
onset values from mixed regimes.

**RB-005: Cross-product regime for contexted query**

Fixture: query is `context(channel:google).window()`. Data exists
under cross-product hash
`context(channel:google).context(device:*).window()` but not under
direct channel hash.

Assert: cross-product rows selected. Evidence binder sums over
device dimension to produce channel:google aggregate observations.

#### 7.3.6 Snapshot read integrity additions

**Add to `test_snapshot_read_integrity.py`**:

**CE-014: Two MECE dimensions, same retrieved_at, broad query**

Write rows under H_channel and H_device for same (anchor_day,
retrieved_at). Query with `slice_keys=['']` (broad).

Assert: all rows returned (the DB layer doesn't do regime
selection — that's the Python utility's job). This establishes that
the raw query returns the full set, confirming that regime selection
must happen post-query.

**CE-015: Hash mapping equivalents in same query**

Write rows under H_old and H_new (equivalent via mapping). Query
with `equivalent_hashes`. Assert: rows from both hashes returned.
Confirms the utility must handle deduplication, not the DB.

#### 7.3.7 FE test additions

**Add to `snapshotDependencyPlanService.test.ts`**:

**EP-001: Candidate regime construction from multi-dimension DSL**

Input: pinned DSL `(window(-90d:);cohort(-90d:)).(context(channel);context(device))`
Graph with 2 edges.

Assert per edge:
- `candidate_regimes` has entries for channel hash, device hash
  (and bare hash if §10 DSL fix is in place)
- Each entry has correct `slice_keys`
- Order is closest-match-first (channel before device if channel
  has fewer values)
- `equivalent_hashes` populated from hash mappings

**EP-002: Candidate regime construction with hash mappings**

Same DSL but edge has been renamed (old hash → new hash mapping).

Assert: candidate regimes include both old and new hashes in
`equivalent_hashes`. Order preserved.

**EP-003: No preflight round-trip**

Mock `querySnapshotRetrievals`. Assert it is NOT called during
subject construction. (Red test against current code — currently
it IS called for cohort_maturity mode.)

#### 7.3.8 Test data patterns

All tests should use a shared fixture builder that produces
realistic multi-regime row sets. Key patterns to cover:

| Pattern | Description | Tests |
|---|---|---|
| **Stable regime** | One hash, full sweep coverage | RS-007 |
| **Clean transition** | H_old for dates 1-15, H_new for 16-30, no overlap | RS-002, RC-002, RB-002 |
| **Overlap** | Two regimes both have data for same dates | RS-001, RC-001, RB-001 |
| **Sparse** | One regime covers some dates, another covers others, some dates uncovered | RS-008 |
| **Mapping chain** | H_old → H_mid → H_new, data under each for different date ranges | RS-005 |
| **Cross-product** | Data under channel×device hash, queried for channel-only | RS-009, RS-010, RB-005 |
| **Three+ dimensions** | Channel + device + geo + bare, varying availability | RS-008 |
| **Delta-sensitive** | Specific y-value sequences designed to expose regime-boundary artefacts | RC-004, RC-005 |

#### 7.3.9 What a false pass looks like

For each test category, document the false-pass scenario to guard
against:

- **Utility tests**: a test that only uses one regime's rows as
  input (no regime conflict) passes trivially. Every utility test
  MUST have rows from multiple regimes in the input.

- **Consumer integration**: a test that mocks `select_regime_rows`
  to return pre-filtered rows tests the mock, not the system. The
  red test must feed raw (unfiltered) rows to the consumer and
  assert the wrong answer, then feed filtered rows and assert the
  right answer.

- **Bayes evidence**: a test that uses only window() observations
  (no context rows) sidesteps the aggregation bug entirely. Every
  Bayes test MUST include context-prefixed rows from at least two
  dimensions.

- **FE candidate construction**: a test with a single-context
  pinned DSL (e.g. `context(channel).window(-90d:)`) has only one
  candidate regime — no selection needed. Every FE test MUST use
  multi-dimension or multi-era DSLs.

#### 7.3.10 Existing tests to verify are not weakened

The following existing test files cover behaviour that must remain
correct after regime selection is introduced:

- `test_mece_aggregation.py` — DR-005/DR-006: single-dimension MECE
  sum and weighted-average. These should pass unchanged (single
  regime = no filtering needed).
- `test_cohort_maturity_derivation.py` — existing virtual-snapshot
  tests. Should pass unchanged for single-regime inputs.
- `test_lag_model_fitter.py` — existing fit tests. Should pass
  unchanged for single-regime inputs.
- `test_snapshot_read_integrity.py` CE-001 through CE-013 — existing
  slice selector contracts. Must remain correct.
- `test_fe_closure_consumption.py` FC-001 through FC-011 — hash
  expansion tests. Must remain correct (expansion happens before
  regime selection).

#### 7.3.11 Adversarial review: why tests might fail to catch bugs

**Gap 1: The utility tests are pure-function unit tests. They don't
hit the DB.**

`select_regime_rows()` operates on an in-memory row list. The tests
in RS-001 to RS-012 verify the selection logic in isolation. But the
real double-counting bug lives in the gap BETWEEN the DB query and
the utility call — if a consumer forgets to call the utility, or
calls it with the wrong candidate list, or calls it after partial
aggregation has already happened, the utility tests all pass but the
bug persists.

**Mitigation**: RC-series consumer integration tests are essential.
They must feed raw (unfiltered) rows directly to each consumer
function and assert the wrong answer. This proves the bug exists
without the utility. Then feed utility-filtered rows and assert the
right answer. Without the red-test-first discipline, a passing
integration test proves nothing — the consumer might never have had
the bug in the first place for that specific input.

**Gap 2: Tests use synthetic rows, not real DB data.**

All RS/RC/RB tests construct rows in-memory with known x/y values.
This sidesteps:
- SQL query behaviour (does `core_hash = ANY(...)` with equivalents
  actually return the rows we expect?)
- Slice key normalisation differences between what the test builds
  and what the DB stores
- Date/datetime truncation (the utility groups by date-level, but
  `retrieved_at` in the DB is a full timestamp — does the truncation
  match?)

**Mitigation**: CE-014 and CE-015 (snapshot read integrity) hit the
real DB and verify the raw query returns the expected multi-regime
row set. But there is no end-to-end test that writes multi-regime
data to the real DB, queries it via the API handler, and verifies
the response is correct after regime selection. Add:

**RC-E2E-001: End-to-end cohort maturity with real DB**

Write rows under two hashes (H_channel, H_device) for the same
edge, overlapping dates. Call the cohort maturity API endpoint
with `candidate_regimes`. Assert the response frames have correct
(non-doubled) y values. This test requires the Python dev server
and a test DB — mark it accordingly.

**Gap 3: Consumer integration tests mock nothing but also don't
verify the wiring.**

RC-001 through RC-006 call the derivation functions directly with
crafted row lists. They prove the derivation functions produce
correct output given correct input. But they don't prove that the
API handler actually calls `select_regime_rows()` before the
derivation function. The handler could skip the call and the
RC tests would still pass.

**Mitigation**: Add handler-level integration tests:

**RC-H-001: API handler calls select_regime_rows**

Call `_handle_snapshot_analyze_subjects()` with a request
containing `candidate_regimes` and multi-regime data in the DB.
Assert the response is correct (not doubled). This proves the
handler wires the utility into the derivation path.

**RC-H-002: API handler without candidate_regimes (backward compat)**

Same data, but no `candidate_regimes` on the request. Assert the
response is the OLD (wrong, doubled) behaviour. This proves
backward compatibility and confirms the guard is opt-in.

**Gap 4: The "closest match" ordering is computed by the FE but
tested on the BE.**

The BE tests (RS-009, RS-010) verify that the utility respects
ordering. But the ordering itself is computed by the FE — the BE
just trusts it. If the FE computes the wrong order (e.g., puts
a cross-product regime before the exact match), the utility
faithfully selects the wrong regime. The BE tests pass; the system
produces wrong results.

**Mitigation**: EP-001 already tests FE candidate construction
ordering. But it should include an adversarial case:

**EP-004: FE ordering with cross-product vs single-dimension**

Pinned DSL has `context(channel).context(device)` (cross-product)
AND `context(channel)` (single-dimension) in its history (via DSL
evolution). For an uncontexted query, the candidates should be:
[H_bare, H_channel (2 slices), H_device (2 slices),
H_channel_x_device (4 slices)]. Verify cross-product is LAST (most
aggregation needed), not first.

For a `context(channel:google)` query, the candidates should be:
[H_channel_google (exact), H_channel_google_x_device (superset,
2 extra slices)]. Verify exact is first.

**Gap 5: No test for the Phase C likelihood routing (§11.5).**

RB-003 tests that `regime_per_date` correctly reports
`mece_partition` vs `uncontexted`. But no test verifies that the
evidence binder USES this information to route observations to
parent vs child likelihood terms. The `regime_per_date` could be
correct but ignored by the binder. Since Phase C isn't built yet,
this is a contract test only — but the contract must be
enforceable.

**Mitigation**: RB-003 is correctly scoped as a contract test on
the `RegimeSelection` output. When Phase C is built, a
corresponding test must verify the binder consumes
`regime_per_date` and emits the correct likelihood structure. Flag
this as a Phase C test prerequisite in the doc.

**~~Gap 6: RS-004 — NOT A REAL RISK.~~**

Each fetch writes under exactly one hash (whichever is current at
fetch time). Hash mappings widen the read query but don't duplicate
data. Equivalent hashes naturally partition by date — H_old covers
pre-rename dates, H_new covers post-rename dates. No overlap, no
deduplication needed. RS-004 as written is correct.

**Gap 7: No test for the "FE sends wrong candidates" scenario.**

The contract trusts the FE to produce correct candidates. But the
FE could:
- Omit a regime that has data (→ data loss for those dates)
- Include a regime that doesn't actually satisfy the query
  (→ wrong data selected)
- Send regimes in wrong order (→ less-preferred regime wins)

These are FE bugs, but the BE has no way to detect them. The
system silently produces wrong results.

**Mitigation**: This is inherent in the contract design (§4.2: "the
BE does NOT verify MECE completeness"). Partial mitigation:
- The BE could log which regime was selected per date (already in
  `regime_per_date`). The FE can surface this in dev mode for
  human inspection.
- Integration tests that wire FE candidate construction → BE
  selection → derivation → output, using real graph data, would
  catch end-to-end contract violations. Add:

**E2E-001: Full pipeline with real graph data**

Use a test graph with a multi-dimension pinned DSL and real
snapshot data (from the test DB). Run the full pipeline: FE
candidate construction → submit to BE → regime selection →
derive_cohort_maturity → verify output frames match expected
values computed independently.

This is expensive but is the only test that catches contract
violations between FE and BE. Run it as a gated test (requires
dev server + DB), not in the fast suite.

**Gap 8: Tests don't cover the `derive_daily_conversions` /
`derive_lag_histogram` failure mode precisely enough.**

RC-004 describes the delta artefact but the fixture is simplified
(three data points). The real failure mode is subtler: the delta
computation uses carry-forward (last-known value on non-retrieval
days). If regime A's carry-forward value is still "active" when
regime B's row arrives, the delta is computed against A's value,
not B's previous value. The fixture must include carry-forward
gaps to expose this.

**Mitigation**: Extend RC-004:

**RC-004b: Delta with carry-forward across regime boundary**

Fixture: anchor_day=1-Jan. Retrieval sequence:
- Day 1: H_channel, y=10
- Day 2: (no retrieval — carry-forward of y=10)
- Day 3: H_device, y=8
- Day 4: (no retrieval)
- Day 5: H_channel, y=15

On day 3, the carry-forward from day 2 is H_channel's y=10.
The new row is H_device's y=8. Delta = -2 (artefact). Without
regime selection, this produces a spurious negative conversion.

With regime selection (H_channel preferred): day 3 is discarded.
Carry-forward remains y=10 through day 4. Day 5: delta = +5.

~~**Gap 9: Same-day multi-regime grouping**~~ — **ACCEPTED
LIMITATION.** Within a single hash, fetches on the same day are
deduplicated at fetch time. Cross-regime same-day collision (pinned
DSL changed mid-day with immediate re-fetch) is vanishingly rare
and both retrievals observe the same underlying truth. Not worth
engineering around. No test needed.

---

## 7.4 Known code issues (post-implementation)

Logged 8-Apr-26. These should be addressed before production use.

**Missing tests:**

1. ~~**Consumer integration**~~: RC-004 and RC-005 now implemented
   (8-Apr-26). RC-002 removed (tested a scenario that doesn't arise
   in real code paths — see session notes).

2. **Bayes evidence binder**: RB-001 through RB-005 (§7.3.5) do
   not exist. `test_regime_bayes_evidence.py` is specified but not
   created.

3. ~~**Handler-level integration**~~: RC-H-001 and RC-H-002
   implemented 8-Apr-26 in `test_regime_handler_integration.py`.
   Uses real snapshot DB data. Proves regime selection reduces
   multi-hash rows to one hash, and opt-in guard works.

4. ~~**FE candidate construction**~~: `candidateRegimeService.test.ts`
   implemented 8-Apr-26 — 5 tests for `computeMeceDimensions`
   (MECE vs non-MECE identification, empty DSL cases) and
   `buildCandidateRegimesByEdge` (empty/blank DSL guards). Full
   EP-001/003/004 integration tests (multi-dimension DSL → per-edge
   hash computation) require production connection providers and
   remain as documented integration test targets.

**Code quality:**

5. ~~`from collections import defaultdict` inside function body~~.
   Fixed 8-Apr-26 — moved to module-level imports.

6. ~~`import re` inside function body~~. Fixed 8-Apr-26 — moved
   to module-level imports.

7. ~~Duplicate step numbering in `useBayesTrigger.ts`~~. Fixed
   8-Apr-26.

8. ~~`(graph as any).dataInterestsDSL` in
   `candidateRegimeService.ts`~~. Fixed 8-Apr-26 — `Graph` type
   includes `dataInterestsDSL`, cast removed.

**Reviewed and not a bug:**

9. ~~`createPreparedSignature()` cache key staleness~~. Reviewed:
   `candidate_regimes` changes only when hash mappings change
   (which also changes `equivalent_hashes`, already in the
   signature) or when the pinned DSL changes (which changes
   subjects themselves). No action needed.

---

## 8. Migration path

### 8.1 Phase 1: BE selection utility + red tests — DONE

`select_regime_rows()` implemented with 15 unit tests and 5
consumer integration tests. Pure function, no dependencies on
request format. All 20 tests passing.

### 8.2 Phase 2: Wire into existing BE paths — DONE

`_apply_regime_selection()` added to `api_handlers.py` at all 3
query sites (cohort_maturity epoch path, sweep_simple path,
raw_snapshots path). Per-edge regime selection added to Bayes
worker. Both opt-in: activate when `candidate_regimes` is present
on the request. Backward compatible when absent.

### 8.3 Phase 3: FE candidate construction + mece_dimensions

Two pieces:

**a) Candidate regime construction per edge**: explode the current
pinned DSL, extract distinct context key-sets, compute core_hash
for each, add hash-mapping closures. For FE analysis queries,
filter candidates to those whose dimensions include the query's
context dimensions. For Bayes aggregate, send all candidates.

**b) `mece_dimensions` computation**: read the graph's context
registry, collect dimension names where the context definition has
MECE status (`otherPolicy: null` or `otherPolicy: computed`).
Send as a flat list alongside candidates.

Both are FE-side. Neither requires DB access. This phase activates
the BE regime selection in production.

### 8.4 Phase 4: Bayes worker integration

Update the Bayes submission payload to include
`candidate_regimes_by_edge` (per-edge candidate lists for aggregate
evidence) and `mece_dimensions`. The worker uses these with
`select_regime_rows()` before evidence binding.

### 8.5 Phase 5: Remove legacy epoch machinery

Once Phase 3 is deployed, the FE's `querySnapshotRetrievals`
preflight, `selectLeastAggregationSliceKeysForDay`,
`segmentSweepIntoEpochs`, and related epoch code become dead.
Remove.

---

## 9. Open questions

1. **Regime preference order**: "first in candidate list wins" is
   the selection rule. The FE controls the ordering. For aggregate
   queries, any MECE hash gives the same total so ordering doesn't
   matter for correctness. For consistency across dates (avoid
   floating-point artefacts from switching regimes), prefer a stable
   ordering. Policy TBD.

2. **Phase C overconstrained parent**: when the pinned DSL has
   `context(a);context(b)`, both dimensions independently constrain
   the parent via Dirichlet. Since A and B are orthogonal slicings
   of the same conversions, this overcounts evidence at the parent
   level. See doc 30b §15 for discussion. This is a Phase C model
   design concern, not a regime selection concern.

---

## 10. DSL parsing gap: expressing "contexted + uncontexted"

### 10.1 The problem

There is currently no way in a pinned DSL to express "fetch both
contexted slices AND the uncontexted aggregate". All three natural
syntactic forms fail:

| Form | Expected | Actual |
|---|---|---|
| `context(channel);context()` | Expand channel + bare slice | `context()` treated as "clear" (scenario delta semantics), not handled by `expandBareKeys` |
| `context(channel);` | Expand channel + bare slice (trailing `;` = empty = uncontexted) | `smartSplit` discards empty parts (falsy check at line 228) |
| `or(context(channel),)` | Same via `or()` | `smartSplit` with `,` separator, same empty-part discard |

### 10.2 The general rule

An **empty element** in a semicolon-separated or comma-separated
context list means "also include the uncontexted slice". This applies
uniformly:

- Trailing separator: `context(channel);` or `or(context(channel),)`
- Explicit empty: `context()` in a semicolon/or position
- These are all semantically identical

When distributing the suffix (the temporal clause), the empty part
produces the temporal clause without any context qualifier:

```
(window(-90d:);cohort(-90d:)).(context(channel);context())

explodes to:
  context(channel:google).window(-90d:)
  context(channel:meta).window(-90d:)
  window(-90d:)                          ← uncontexted
  context(channel:google).cohort(-90d:)
  context(channel:meta).cohort(-90d:)
  cohort(-90d:)                          ← uncontexted
```

### 10.3 Implementation

The fix is localised to `dslExplosion.ts`:

1. `smartSplit`: preserve empty parts (don't discard when `trim()`
   is empty). Return `''` as a valid element.
2. `expandBareKeys`: when a branch has no context clauses at all
   (empty string or bare temporal clause), return it as-is — it is
   the uncontexted slice.
3. `parseExpression` suffix distribution: when distributing a suffix
   onto an empty prefix, emit the suffix alone (no dot separator).

The scenario-delta semantics of `context()` ("explicit clear") in
`composeConstraints` remain unchanged — that code path operates on
`ParsedConstraints` objects, not on raw DSL strings going through
`explodeDSL`.

### 10.4 Scope

This is a separate piece of work from regime selection. It is needed
regardless of Bayes — any consumer that wants both contexted and
uncontexted data from a single pinned DSL needs this. But it is not
blocking for Bayes (see §11 for why).

---

## 11. Hierarchical model implications for uncontexted data

### 11.1 The hierarchical Dirichlet model produces aggregate vars

The Phase C Bayes model is hierarchical:

```
Parent (base rate p_base)                 ← aggregate / uncontexted
  ├── Child: channel:google (p_google)    ← deviation from parent
  ├── Child: channel:meta (p_meta)        ← deviation from parent
  └── ...
```

The parent IS the uncontexted aggregate. Its posterior is the
aggregate model variable (p, mu, sigma, t95). The children's
posteriors are per-context model variables. The hierarchy enforces
that if the children are MECE, their traffic-weighted probabilities
compose to the parent.

**The model naturally produces uncontexted model variables without
needing direct uncontexted observations.** The parent's posterior is
informed by the children's evidence flowing up through the hierarchy.

### 11.2 Multiple independent MECE dimensions

A pinned DSL like:

```
(window(-90d:);cohort(-90d:)).(context(channel);context(browser_type))
```

produces two independent MECE context dimensions. The hierarchical
model has:

```
Parent (p_base)                                ← aggregate
  ├── Channel children (Dirichlet)             ← one MECE group
  │     ├── channel:google (p_ch_google)
  │     └── channel:meta (p_ch_meta)
  └── Browser children (Dirichlet)             ← separate MECE group
        ├── browser_type:chrome (p_bt_chrome)
        ├── browser_type:safari (p_bt_safari)
        └── browser_type:firefox (p_bt_firefox)
```

Each context dimension is an **independent Dirichlet** — the channel
values sum to the parent, and the browser_type values separately sum
to the parent. They are NOT jointly Dirichlet across the combined
group (channel:google + browser_type:chrome + ... would not sum to
the parent — that would be a different model).

Each dimension provides an independent view of how the parent rate
decomposes. The parent's posterior is informed by BOTH sets of
children — two independent constraints that the parent must be
consistent with.

### 11.3 Evidence routing for multiple dimensions

For each `(anchor_day, retrieved_at)`, the compiler needs:

- **Parent evidence**: aggregate `(x, y)`. Regime selection picks
  one hash per date, sums to aggregate. Checks `mece_dimensions`
  to confirm the sum is safe.
- **Per-dimension children evidence**: per-value `(x, y)` from the
  specific hash that contains that dimension. Per-slice reads —
  each dimension uses its own hash. No regime selection needed for
  children.

### 11.4 Does the parent need direct observations?

**No — but they help.**

- **Without uncontexted fetch**: the parent's posterior is determined
  entirely by the children. Each MECE dimension independently
  constrains the parent. With two dimensions, the parent has two
  independent sets of constraints — this is actually MORE informative
  than a single uncontexted observation, because it reveals whether
  the two decompositions agree.

- **With uncontexted fetch**: the parent has a direct observation
  that anchors it independently of the children. This is useful when:
  - Context coverage is sparse (some values have few observations)
  - There's a temporal gap (uncontexted data exists for dates before
    context was added to the pinned DSL)
  - As a consistency check (parent obs vs MECE summation)

**For pre-Phase C** (aggregate model, no hierarchy): the compiler
runs at aggregate level only. Regime selection (§4) gives it
aggregate observations by picking one MECE partition and summing.
No DSL change needed.

**For Phase C** (hierarchical model): the parent doesn't strictly
need direct observations — the hierarchy handles it. But the DSL
fix (§10) is still valuable for other consumers and for the temporal
coverage benefit.

### 11.5 Mixed epochs and the per-date likelihood structure

Consider modelling on 28-Feb with a 60-day training window:

- Jan: context(a) was the pinned DSL. Only a-partition data exists.
- Feb: context(b) is the current pinned DSL. b-partition data exists.

The regime selection gives:
- Jan dates → a-partition rows (aggregate via summation)
- Feb dates → b-partition rows (per-slice)

**The critical constraint**: in Feb, the b-children have direct
per-slice evidence. Their likelihood terms use the per-slice rows.
The parent must be informed **only through the Dirichlet** for Feb
dates — there must be NO separate aggregate likelihood term on the
parent for Feb, otherwise the same observations feed both the
children's likelihood and the parent's likelihood. That would be
double-counting.

In Jan, no b-children evidence exists. The aggregate evidence (from
a-partition sum) feeds the parent directly as a likelihood term.

The per-date rule:

| Regime selected for this date | Child likelihood terms | Parent likelihood term |
|---|---|---|
| MECE partition (per-slice rows) | **Yes** — per-slice on children | **No** — parent informed only through Dirichlet |
| Uncontexted (aggregate rows) | **No** — no per-child data | **Yes** — direct aggregate term |

This means the regime tag per `retrieved_at` is not just a filtering
decision — it determines the **likelihood structure** per
observation. The evidence binder must know which regime was selected
for each date so it can emit the correct likelihood terms.

**Implication for `select_regime_rows()`**: the utility must return
not just the filtered rows but also the regime decision per
`retrieved_at` date, so the evidence binder can route observations
to parent vs child likelihood terms correctly.

```python
@dataclass
class RegimeSelection:
    rows: list[dict]                              # filtered rows
    regime_per_date: dict[str, CandidateRegime]   # retrieved_at → winning regime
```

**Consistency check**: if context(a) is also still in the model
(still in the pinned DSL), then for Jan the a-children get per-slice
likelihood terms and the parent is linked through the a-Dirichlet —
no aggregate parent term for Jan either. The parent's posterior for
the full Jan-Feb window is informed entirely through the Dirichlet
links to whichever children have evidence on each date. Direct
parent likelihood terms only appear for dates where the regime is
uncontexted (no per-child data at all).

### 11.6 Summary

| Concern | Pre-Phase C | Phase C |
|---|---|---|
| Aggregate model vars | Regime selection picks one MECE partition, sums to aggregate | Parent posterior derived from hierarchy — no direct obs needed |
| Per-context model vars | Not produced | Children posteriors per dimension |
| Uncontexted fetch needed? | No (regime selection suffices) | No (hierarchy suffices), but useful for coverage + consistency |
| DSL fix (§10) blocking? | No | No, but valuable for other consumers |
| Regime selection (§4) blocking? | **Yes** — current code double-counts | **Yes** — parent evidence must come from one regime |
