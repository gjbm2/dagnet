# Event-Mode Queries: Right-Aligned Funnel Attribution

**Status**: Early design thinking — not yet scoped for implementation  
**Date**: 8-Apr-26

---

## The Gap

DagNet's query system currently supports two temporal anchoring modes:

| Mode | Anchor | Question |
|------|--------|----------|
| `window(x)` | x — observation date at from-node | "Of users who arrived at X on date x, how many transitioned to Y?" |
| `cohort(a)` | a — entry date at anchor node | "Of users who entered at A on date a, how many eventually reached X→Y?" |

Neither directly answers: **"What actually converted at Y on date y?"**

This is the natural question for outcome-oriented analysis — revenue recognition, fulfilment, operational throughput. The user doesn't care when someone entered the funnel or when they were last observed at X; they care what *landed* at Y and when.

We call this **event mode**, anchored at y.

---

## Core Insight: No New Fetching Required

Event-mode data is already latent within existing window-mode snapshots. A window snapshot records cumulative state: "as of observation date x, N users from arrival-day have reached Y." The delta between consecutive snapshots reveals new conversions:

> delta(x) = snapshot(x) - snapshot(x-1) = conversions first observed in interval [x-1, x]

To produce event-mode output, we sweep backward from today by the maturity horizon and aggregate these deltas, re-indexed by when the conversion was observed (or, with more sophistication, by when it likely occurred).

This is **right-aligned aggregation**: instead of grouping by the left edge of the funnel (when users entered X), we group by the right edge (when they arrived at Y).

---

## The Delta Problem

The central complexity. A conversion at Y on date y is not directly recorded anywhere — it must be derived from snapshot deltas. This raises several challenges:

### 1. What the Delta Actually Represents

A snapshot at x-date says "cumulative conversions as of x." The delta between x-1 and x tells you "new conversions *first observed* between x-1 and x." But "first observed" is not the same as "actually occurred on date x":

- A user might have converted at Y on date x-2, but the data pipeline only captured it on date x
- The actual event date y is smeared across the lag distribution within the observation interval
- At daily snapshot granularity, the best you can say is "this conversion was observed in the [x-1, x] window"

### 2. Observation Date vs Event Date

This gives rise to two possible definitions of event mode, with very different implementation costs:

**Definition A — Observation-anchored** ("when was the conversion first seen?"):
- y = x (the snapshot date on which the delta appeared)
- Simple: pure snapshot arithmetic, no model dependency
- Answers: "How many conversions were first recorded on this date?"
- Limitation: subject to pipeline lag — a spike on date y might reflect delayed processing, not a real surge

**Definition B — Event-anchored** ("when did the conversion actually happen?"):
- y = estimated actual event date, derived by deconvolving the lag distribution from the delta
- Requires trusting the lag model for back-attribution
- Answers: "How many conversions actually occurred on this date?"
- Richer, but introduces model dependency and is harder to validate

**Recommendation**: start with Definition A. It is robust, directly computable, and already useful. Definition B is a refinement that can be layered on once the basic infrastructure exists.

### 3. Non-Monotonicity and Corrections

Snapshot deltas should be non-negative (conversions don't un-happen). In practice:
- Data corrections or restatements can make delta(x) negative
- Late-arriving data can cause a large positive delta on a single day, followed by near-zero deltas
- Policy needed: clamp negatives to zero? Carry forward? Flag as data quality issue?

### 4. Missing Snapshots

If snapshot x is missing, the delta between x-1 and x+1 lumps two days of conversions together. Event-date resolution degrades to the coarsest gap in snapshot history. This isn't a new problem (window mode has it too), but it matters more when the output is explicitly date-attributed.

### 5. Multi-Edge Composition

For a path A→...→X→Y, the delta at X→Y tells you about the final hop only. If you want event-mode for the whole path, you need to compose deltas across edges — and each edge may have different snapshot cadences and maturity profiles.

This is a later concern. Single-edge event mode is the right starting point.

---

## Maturity Model (Inverted)

Event mode has an inverted maturity profile compared to window mode:

**Window mode**: recent x-dates are immature because future conversions haven't happened yet. A snapshot from yesterday is incomplete — some users who arrived at X yesterday haven't converted yet.

**Event mode**: recent y-dates are immature because *slow-path past conversions haven't been observed yet*. A y-date from 3 days ago has only captured fast converters. A y-date from 30 days ago has captured contributions from x-dates going back up to t95 days before it — it's fully mature.

The maturity horizon for a y-date is: **y is fully mature when today - y >= t95 for the edge**.

Within the immature zone, you could:
- Show raw (incomplete) values with a maturity indicator
- Apply the lag distribution to estimate the "mature" value (analogous to projection, but backward)
- Cut off display at the maturity frontier

---

## Lookback Policy

To compute event-mode for today, you need snapshots going back `max(path_t95)` days — that's the maximum time a conversion could take and still be captured.

Policy decisions:
- **Depth**: t95? t99? Fixed cap? Configurable per edge?
- **Diminishing returns**: beyond t95, the incremental contribution is tiny but non-zero. Truncation introduces small systematic undercounting.
- **Storage**: this doesn't require new data — just reading existing window snapshots from the lookback window. The question is whether they're all in the snapshot DB or need fetching.

---

## Relationship to Existing Machinery

### Projection Mode
Projection already performs a forward convolution: "given arrivals at X and a lag distribution, what will future flow into Y look like?" Event mode is the same convolution used descriptively — "what *did* flow into Y?" — with a maturity cutoff instead of a forecast horizon.

The maths is identical; the bounds differ. There may be significant code reuse here.

### Lag Analysis
The lag distribution (fitted or empirical) is the key ingredient for Definition B (event-anchored attribution) and for the maturity model. The lag analysis subsystem already produces this — event mode is a consumer, not a modifier.

### Snapshot DB
No new families or slice_key types are needed if event mode is purely a derived view. The snapshot DB stores window-mode data; event mode reads and re-aggregates it. If we later want to cache event-mode results, that's an optimisation, not a prerequisite.

---

## Sketch of the Computation

For a single edge X→Y, producing event-mode output for y-dates in range [today - lookback, today]:

```
For each y in [today - lookback, today]:
    total_conversions(y) = 0
    For each x in [y - t95, y]:
        delta(x) = snapshot(x) - snapshot(x-1)   // new conversions observed at x
        total_conversions(y) += delta(x)          // Definition A: y = x
        // OR: total_conversions(y) += delta(x) * P(lag = y - x)  // Definition B
    maturity(y) = min(1.0, (today - y) / t95)
```

Definition A collapses to: total_conversions(y) = delta(y) — trivially simple. The lookback sweep only matters for Definition B.

This is important: **Definition A doesn't even need the sweep.** It's just the snapshot delta series, re-labelled. The complexity of right-aligned aggregation only kicks in when you want true event-date attribution (Definition B).

---

## Open Questions

1. **Is Definition A sufficient for the use cases we have in mind?** If so, the implementation is remarkably simple — it's a view over snapshot deltas.

2. **How should event mode interact with scenarios and what-if analysis?** A scenario that changes a probability at X→Y would change the expected event-mode output at Y. Is this meaningful to show?

3. **Should event mode be an analysis type, a query modifier, or a display option?** It could be:
   - A new DSL clause `event()` — parallel to `window()` and `cohort()`
   - An analysis type that consumes window-mode data and re-aggregates
   - A chart display option ("show by observation date" vs "show by event date")

4. **Multi-edge composition**: when/if needed, how do you compose edge deltas into path-level event attribution? This is non-trivial because edges have different lag profiles.

5. **What does forecasting mean in event mode?** Window/cohort modes forecast by projecting immature snapshots forward. Event mode's "immature zone" is recent y-dates. Forecasting would mean "estimating the mature value of recent y-dates" — which is projection, viewed from the other end.

---

## Suggested Next Steps

1. **Clarify use cases**: what specific questions should event mode answer? Revenue recognition? Operational throughput? Marketing attribution? The use case shapes whether Definition A or B is needed.
2. **Prototype Definition A**: compute snapshot delta series for a real edge. Verify it produces sensible numbers. This is near-zero implementation cost.
3. **Evaluate whether Definition B adds meaningful signal**: compare Definition A output to Definition B (using existing lag distributions) on real data. If they're similar at daily granularity, Definition A wins on simplicity.
4. **Design the maturity indicator**: how to communicate to users that recent y-dates are incomplete.
