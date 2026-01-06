## Investigation: delegation vs registration graph discrepancy (cohort 1-Nov-25)

**Date:** 6-Jan-26  
**Scope:** Explain, on an evidential basis, why **reach probability at success** differs between two graphs when running `cohort(1-Nov-25:1-Nov-25)`.

### Question being answered

You observed that two graphs (one “delegation”/rebuild view and one “registration”/success-v2 view) produce discrepant reach-at-success numbers for the same cohort.

This document records what we’ve checked so far, exactly what evidence we used, and what the findings imply.

---

## Artefacts (inputs)

All referenced files are from the manually attached snapshot under `investigate/`:

- **Graphs**
  - `investigate/graphs/gm-rebuild-jan-25.json`
  - `investigate/graphs/conversion-flow-account-success-v2.json`
- **Parameters (cached evidence)**
  - `investigate/parameters/household-delegation-rate.yaml`
  - `investigate/parameters/gm-registered-to-success.yaml`
  - `investigate/parameters/registration-to-success.yaml`
  - `investigate/parameters/gm-delegated-to-registered.yaml`
- **Compute semantics (repo code)**
  - `graph-editor/lib/runner/graph_builder.py`

---

## Method (what we did)

We treated this as a **trace + compare** problem:

1. **Confirm both graphs are running the same cohort filter**
   - Both graph exports contain `currentQueryDSL: "cohort(1-Nov-25:1-Nov-25)"`.

2. **Identify the “success” endpoint and the immediate edge into success**
   - In both graphs, the success node is `switch-success`, reached from `switch-registered` via:
     - `query: from(switch-registered).to(switch-success)`

3. **Compare the “middle section” definitions**
   - We compared the upstream transition(s) that feed `switch-registered` (registration) in each graph.

4. **Check whether “channel context is MECE” for a representative upstream step**
   - Specifically: `household-created → household-delegated` for **1-Nov-25**.
   - We compared:
     - baseline uncontexted `n/k` (from the graph export evidence)
     - Σ contexted channel `n/k` (from the cached parameter slices)

---

## Findings (with evidence)

### 1) Absorbing/terminal semantics are not the driver

Potential hypothesis: One graph marks `switch-success` as absorbing and the other does not, causing analysis to treat “reach to success” differently.

Evidence/Check:

The Python runner defines absorbing/end nodes as:

- If any nodes have explicit `absorbing: true`, use those
- Otherwise, fall back to nodes with **no successors** (out-degree 0)

So even if a node has `absorbing: false`, it will be treated as an end node when it has no outgoing edges.

Source: `graph-editor/lib/runner/graph_builder.py` (`find_absorbing_nodes`).

Conclusion:

This means the discrepancy is **unlikely** to be caused by `absorbing: false` on `switch-success` in `gm-rebuild-jan-25.json` *alone*.

---

### 2) The success step itself is similar between graphs for 1-Nov-25

Both graphs include the edge:

- `switch-registered → switch-success`
- `query: from(switch-registered).to(switch-success)`

Evidence in `gm-rebuild-jan-25.json` (edge `switch-registered-to-switch-success`):

- `full_query`: `from(switch-registered).to(switch-success)`
- `evidence`: `n = 23`, `k = 16` (for `1-Nov-25`)

Evidence in `conversion-flow-account-success-v2.json` (edge `switch-registered-to-switch-success`):

- `full_query`: `from(switch-registered).to(switch-success)`
- `evidence`: `n = 22`, `k = 15` (for `1-Nov-25`)

Conclusion:

If reach-to-success differs materially between the graphs, the main divergence is likely **upstream of registration**, not in “success given registered”.

---

### 2.1) Open issue: tail-step evidence mismatch between `success-v2` and rebuild (1–10 Nov)

Even for an “old” cohort window, we observed a small but real mismatch between:

- **`success-v2` tail evidence**: derived from summing the four MECE `context(channel:...)` cohort slices in `investigate/parameters/registration-to-success.yaml`
- **rebuild tail evidence**: taken from the uncontexted cohort slice in `investigate/parameters/gm-registered-to-success.yaml`

Both correspond to the same DSL query:

- `from(switch-registered).to(switch-success)`

However, comparing **1-Nov-25 → 10-Nov-25** day-by-day shows occasional differences:

| date | Σ contexted n | Σ contexted k | gm n | gm k | Δn | Δk |
|---|---:|---:|---:|---:|---:|---:|
| 1-Nov-25 | 22 | 15 | 23 | 16 | -1 | -1 |
| 2-Nov-25 | 21 | 16 | 21 | 20 | 0 | -4 |
| 3-Nov-25 | 12 | 9 | 12 | 9 | 0 | 0 |
| 4-Nov-25 | 21 | 21 | 22 | 21 | -1 | 0 |
| 5-Nov-25 | 23 | 18 | 24 | 18 | -1 | 0 |
| 6-Nov-25 | 8 | 5 | 8 | 5 | 0 | 0 |
| 7-Nov-25 | 3 | 1 | 3 | 2 | 0 | -1 |
| 8-Nov-25 | 3 | 3 | 3 | 3 | 0 | 0 |
| 9-Nov-25 | 5 | 3 | 5 | 3 | 0 | 0 |
| 10-Nov-25 | 37 | 25 | 37 | 25 | 0 | 0 |

Summary:

- max \(|Δn|\) = 1, max \(|Δk|\) = 4 (within the 10-day window checked)
- differences occur on a minority of days (3/10 for n, 3/10 for k)

**What we have effectively ruled out as an explanation**

1. **Channel MECE partitioning is broken**:
   - For the tail step, within `registration-to-success.yaml`, the four channel slices sum cleanly (e.g. on 1-Nov-25, Σ n/k = 22/15).
   - For an upstream step (`household-created → household-delegated`) MECE also holds (Σ n/k = 246/145 on 1-Nov-25).

2. **Contexted vs uncontexted timezone parsing differences in core query construction**:
   - Cohort/window bounds are resolved via UTC-midnight “date-only” semantics (see `graph-editor/src/lib/das/buildDslFromEdge.ts` + `parseUKDate`).
   - Context filters are added as `context_filters` and should not affect date bound parsing.

**Why it remains unexplained**

- The two datasets were retrieved at different times on 6-Jan-26 and have different `query_signature` values.
- A timezone/UI date-selection bug was fixed earlier on 6-Jan-26, which may have straddled runs; however, RetrieveAll consumes already-formed DSL strings and uses the shared UK-date parsing path.
- This remains an open data anomaly pending deeper inspection of the exact provider request specs used for each cached slice (e.g. excluded cohorts config, conversion window / cs parameter, adapter options).

Status: **Open issue** (tail evidence mismatch between caches persists across 1–10 Nov; small magnitude but not yet explained).

---

### 3) The “middle section” is not logically identical: the graphs condition registration on different denominators

This is the key evidential break.

#### 3.1 `gm-rebuild-jan-25` measures registration directly from delegation

Edge: `household-delegated → switch-registered`

Evidence (for 1-Nov-25):

- `query`: `from(household-delegated).to(switch-registered)`
- `evidence`: `n = 145`, `k = 23`

#### 3.2 `success-v2` measures registration from “recommendation offered”, not from delegation

Edge: `recommendation-offered → switch-registered`

Evidence (for 1-Nov-25):

- `query`: `from(recommendation-offered).to(switch-registered)`
- `evidence`: `n = 113`, `k = 22`

Conclusion:

These are different populations:

- `n=145` is “delegated on 1-Nov-25”
- `n=113` is “recommendation-offered on 1-Nov-25” (itself a filtered subset of delegated, and shaped by additional path structure such as coffee/BDS flows and explicit excludes/minus in other edges)

Therefore, `gm-rebuild-jan-25` is **not** a pure “simplification” of `success-v2` as exported here: it collapses/omits intermediate gating, which changes denominators.

#### 3.3 Structural fact: `success-v2` has exactly one inbound edge into `switch-registered`

We explicitly enumerated inbound edges to `switch-registered` in `conversion-flow-account-success-v2.json` and found **exactly one**:

- `recommendation-offered → switch-registered` (`from(recommendation-offered).to(switch-registered)`)

This matters because it means **registration is only modelled as reachable after recommendation-offered** in `success-v2`. There is no direct edge from `household-delegated` into `switch-registered` in `success-v2`.

#### 3.4 Evidence comparison over 1–10 Nov: rebuild direct vs success-v2 components

To quantify how “massive” the difference is (and show where it comes from), we compared daily evidence for **1-Nov-25 → 10-Nov-25**:

- **Rebuild direct**: `gm-delegated-to-registered` (uncontexted cohort slice)
  - `from(household-delegated).to(switch-registered)`
- **success-v2 upstream components** (contexted-only, summed across MECE channels):
  - `delegation-straight-to-energy-rec` interpreted as `household-delegated → recommendation-offered`
    - `from(household-delegated).to(recommendation-offered).exclude(viewed-coffee-screen)`
  - `rec-with-bdos-to-registration` interpreted as `recommendation-offered → switch-registered`
    - `from(recommendation-offered).to(switch-registered)`

Daily comparison table:

| date | rebuild delegated→registered (n) | rebuild delegated→registered (k) | success-v2 delegated→recommendation-offered Σ channels (n) | success-v2 delegated→recommendation-offered Σ channels (k) | success-v2 recommendation-offered→registered Σ channels (n) | success-v2 recommendation-offered→registered Σ channels (k) |
|---|---:|---:|---:|---:|---:|---:|
| 1-Nov-25 | 145 | 23 | 145 | 59 | 113 | 22 |
| 2-Nov-25 | 128 | 21 | 127 | 40 | 98 | 21 |
| 3-Nov-25 | 147 | 12 | 146 | 48 | 110 | 12 |
| 4-Nov-25 | 111 | 22 | 111 | 37 | 87 | 21 |
| 5-Nov-25 | 264 | 24 | 263 | 85 | 173 | 23 |
| 6-Nov-25 | 75 | 8 | 75 | 33 | 64 | 8 |
| 7-Nov-25 | 82 | 3 | 81 | 25 | 38 | 3 |
| 8-Nov-25 | 40 | 3 | 40 | 32 | 34 | 3 |
| 9-Nov-25 | 58 | 5 | 58 | 39 | 39 | 5 |
| 10-Nov-25 | 237 | 37 | 237 | 97 | 171 | 37 |

Key observations:

1. **The rebuild `k` (registered count) is often close to success-v2’s `k` (registered count)**, but the denominators differ:
   - Example 1-Nov-25: rebuild `k=23` vs success-v2 `k=22` (close), but rebuild denominator is delegated `n=145`, while success-v2’s registration evidence is conditioned on `recommendation-offered n=113`.

2. `success-v2` is explicitly modelling substantial drop-off before recommendation-offered:
   - Example 1-Nov-25: delegated→recommendation-offered has `k=59` out of `n=145` in this parameter, while recommendation-offered→registered uses `n=113` (not 59), implying additional upstream paths into recommendation-offered (e.g. coffee/BDS route) contribute to the recommendation-offered population used for registration.

3. **Therefore the two graphs are not expressing the same conditional probability**:
   - rebuild measures \(P(registered \mid delegated)\)
   - success-v2 measures \(P(registered \mid recommendation\_offered)\) and forces all registration to pass through recommendation-offered.

Open question (middle section):

- The edge evidence in `conversion-flow-account-success-v2.json` shows `household-delegated → viewed-coffee-screen` has `n=145, k=59` on 1-Nov-25, and `household-delegated → recommendation-offered (exclude coffee)` also has **the same** `n=145, k=59`. If correct, those two edges imply identical event sets despite mutually exclusive intent, which is suspicious and needs direct Amplitude query inspection for those two parameters.

---

#### 3.5 Hypothesis ruled out: “coffee parity” with `recommendation-offered.exclude(coffee)` (1–10 Nov)

We tested whether the apparent parity in the exported graph for 1-Nov-25:

- `household-delegated → viewed-coffee-screen` (shown as `145/59` in `conversion-flow-account-success-v2.json`)
- `household-delegated → recommendation-offered.exclude(viewed-coffee-screen)` (shown as `145/59` in `conversion-flow-account-success-v2.json`)

holds consistently across dates.

Using the cached parameter time series and summing MECE `context(channel:...)` cohort slices for **1-Nov-25 → 10-Nov-25**:

- Coffee path (parameter `delegated-to-coffee`): `from(household-delegated).to(viewed-coffee-screen)`
- Excluding-coffee path (parameter `delegation-straight-to-energy-rec`): `from(household-delegated).to(recommendation-offered).exclude(viewed-coffee-screen)`

We found:

- **n matches exactly every day** (both are conditioned on the same delegated denominator)
- **k does not match**; parity holds on **0/10** days

Day-by-day:

| date | coffee n | coffee k | excl-coffee n | excl-coffee k | Δn | Δk |
|---|---:|---:|---:|---:|---:|---:|
| 1-Nov-25 | 145 | 58 | 145 | 59 | 0 | -1 |
| 2-Nov-25 | 127 | 59 | 127 | 40 | 0 | 19 |
| 3-Nov-25 | 146 | 69 | 146 | 48 | 0 | 21 |
| 4-Nov-25 | 111 | 51 | 111 | 37 | 0 | 14 |
| 5-Nov-25 | 263 | 99 | 263 | 85 | 0 | 14 |
| 6-Nov-25 | 75 | 32 | 75 | 33 | 0 | -1 |
| 7-Nov-25 | 81 | 35 | 81 | 25 | 0 | 10 |
| 8-Nov-25 | 40 | 1 | 40 | 32 | 0 | -31 |
| 9-Nov-25 | 58 | 0 | 58 | 39 | 0 | -39 |
| 10-Nov-25 | 237 | 82 | 237 | 97 | 0 | -15 |

Conclusion:

- The “145/59 vs 145/59” equality in the exported graph does **not** reflect a stable empirical identity between these two transitions.
- For 1-Nov-25 specifically, the cache-based reconstruction yields **coffee 145/58** vs **excl-coffee 145/59**, i.e. it is not exactly equal on that day in these cached series.
- This rules out the hypothesis that the two edges are generally querying the same event stream.

---

### 4) MECE channel contexting holds for `household-created → household-delegated` on 1-Nov-25

You asked to verify that channel context is MECE for the 1-Nov cohort for a concrete step.

We checked the cached parameter `investigate/parameters/household-delegation-rate.yaml`, which includes four cohort slices:

- `cohort(household-created,8-Oct-25:6-Jan-26).context(channel:paid-search)`
- `cohort(household-created,8-Oct-25:6-Jan-26).context(channel:influencer)`
- `cohort(household-created,8-Oct-25:6-Jan-26).context(channel:paid-social)`
- `cohort(household-created,8-Oct-25:6-Jan-26).context(channel:other)`

For the date **1-Nov-25** the per-channel daily counts were:

- paid-search: `n=11`, `k=7`
- influencer: `n=0`, `k=0`
- paid-social: `n=29`, `k=18`
- other: `n=206`, `k=120`

Sum across channels:

- Σn = `246`
- Σk = `145`

Baseline comparison:

From the graph export evidence for `household-created → household-delegated` on 1-Nov-25 we have:

- baseline `n=246`, `k=145`

Conclusion:

For this step and date, **channel is behaving MECE**, i.e. **Σ per-channel n/k equals the baseline n/k**.

---

## Implications (what this means for the original discrepancy)

1. **The MECE property of channel slices is real** (at least for the tested step/date) and is not the source of discrepancy by itself.

2. **The two graphs do not currently encode the same conditional “middle section”**:
   - `gm-rebuild-jan-25` models `delegated → registered` directly.
   - `success-v2` models `delegated → (recommendation/coffee/BDS paths) → recommendation-offered → registered`.

3. Even if the end event (“success”) is the same, reach-to-success will differ if:
   - the model conditions registration on a narrower upstream node (different denominator), or
   - intermediate edges apply additional constraints (`exclude(...)`, `minus(...)`, `visited(...)`), or
   - the “simplified” graph implicitly assumes those intermediate transitions are probability-preserving (which they aren’t unless proven).

---

## Next investigations (concrete)

To determine whether `gm-rebuild-jan-25` *can* be made a true simplification of `success-v2` (or to explain precisely why it cannot), the next evidential checks should be:

1. **Compare `P(registered | delegated)` definitions**
   - In `success-v2`, derive an implied `P(registered | delegated)` by multiplying along the relevant paths (including branch splits and excludes) and compare to the direct `from(household-delegated).to(switch-registered)` used in rebuild.
   - If they match (within sampling noise) then rebuild may be a faithful reduction; if not, the reduction is changing semantics.

2. **Check whether `recommendation-offered` is truly downstream of `household-delegated` in a way that preserves denominators**
   - Identify whether `success-v2` contains any edges that cause “recommendation-offered” to exclude some delegated users by construction (e.g. coffee/BDS conditions).

3. **Run the same MECE check on the “middle section” nodes**
   - E.g. verify channel MECE holds for:
     - `household-delegated → recommendation-offered` (and/or the coffee/BDS splits)
     - `recommendation-offered → switch-registered`
   - This ensures that scenario aggregation is not the source of divergence in the middle section for 1-Nov-25.

---

## Status

At this point we have a clear, evidence-backed explanation for *why a discrepancy is plausible*:

- the “middle section” is not the same conditional definition between graphs, and the denominators (`n`) differ at the registration step for 1-Nov-25.

### 6-Jan-26: MSMDC defect discovered and fixed (native `exclude()` incorrectly compiled to `minus()`)

We confirmed a **real MSMDC defect**: MSMDC was **incorrectly generating `minus()`** queries even when the edge was configured with `connection: amplitude-prod` (which has `supports_native_exclude: true`).

- **Observed behaviour (pre-fix)**: a direct edge that requires an exclusion (because an alternate path exists) would compile:
  - expected: `from(a).to(c).exclude(b)`
  - observed: `from(a).to(c).minus(b)`
- **Root cause (code-level)**: `graph-editor/lib/msmdc.py`’s capability detection was reading non-existent fields on `graph_types.DataSource` (`connection_settings`, `source_type`), so it failed to identify the connection/provider and fell back to “no native exclude support”.
- **Fix implemented**: MSMDC now reads capability inputs from the schema-correct fields:
  - connection name from `ProbabilityParam.connection` / `CostParam.connection`
  - provider type from `DataSource.type`
  (while retaining legacy fallbacks for older shapes)
- **Regression test added**: `graph-editor/tests/test_msmdc_native_exclude_amplitude_prod.py` asserts that for `amplitude-prod`, MSMDC emits `exclude(...)` and never emits `minus()`/`plus()` when excludes are required.

This defect **may not explain the delegation-vs-registration discrepancy**, but it *does* matter for correctness/safety because any generated `minus()` queries can be unsupported and/or semantically wrong now that Amplitude uses native segment filters.

### 6-Jan-26: `n_query` (denominator) semantics — why window() vs cohort() needs extra caution

We started a focused audit of **`n_query` construction + maths**, because the `success-v2` “middle section” uses MECE-style split mechanics (excludes) and therefore relies on stable denominator definitions to remain mass-conserving.

#### What `n_query` is for (design intent)

From `docs/current/nqueryfixes.md` (22-Dec-25), `n_query` exists to address **denominator shrinkage** caused by MECE split mechanics:

- For split edges, the query often contains `.exclude(...)` / `.minus(...)` / `.plus(...)`.
- With Amplitude’s native segment filters, an `exclude(...)` can shrink the returned **from-step** population (`from_count`) even when the intended denominator is “all arrivals at the from-node”.
- `n_query` is intended to provide an **unrestricted arrivals denominator** so the split probabilities can be treated as partitions of the same population.

#### What MSMDC generates today

MSMDC only auto-generates `n_query` for an edge when the generated edge query contains an exclusion/composite term (exclude/minus/plus). The current generation rule (in words):

- If the edge query contains `.exclude(` or `.minus(` or `.plus(`, and the edge has a usable upstream anchor different from the from-node, then generate:
  - `n_query = from(anchor_node_id).to(from_node_id)`

This is the cohort-style “anchor → from” form described in `nqueryfixes.md`.

#### What the fetch-time maths does today (critical)

`graph-editor/src/services/dataOperationsService.ts` implements “dual query” behaviour whenever an explicit `n_query` exists.

- **If explicit `n_query` is present**:
  - It runs the `n_query` funnel and uses **the completion count** (`to_count`, i.e. `k`) as the base denominator: `baseN = baseRaw.k`.
- **If no explicit `n_query`**:
  - It uses the main query’s **from-step count** (`from_count`, i.e. `n`) as the denominator: `baseN = condRaw.n`.

This distinction is deliberate in the current code, but it means:

- Adding an explicit `n_query` can change the denominator even when the main query has no excludes.
- Window() and cohort() can behave differently depending on how anchor/cohort/window constraints are merged into the n_query execution payload.

#### Why this raises a specific concern for window() slices

For cohort() slices, “anchor → from” has a clear interpretation: “users in the anchor cohort who reached from within the cohort conversion window (`cs`)”. That matches the document’s stated intent.

For window() slices, “anchor → from” is *not obviously equivalent* to “arrivals at from within the window”, because:

- Window mode is step-event-time bounded (X-event dates), not anchor-entry-time bounded.
- Cohort mode introduces a conversion horizon (`cs`) that can differ from a window’s implicit horizon.
- Therefore, an “anchor → from” denominator can mix semantics if it is used to stand in for “all arrivals at from in this window”.

This is an **open risk**: if the system accidentally uses an anchor-style `n_query` as the denominator in window mode (or mixes constraints inconsistently), we can get systematic “middle section” drift even when the underlying event definitions are correct.

#### Concrete local observations (1-Nov-25 window slices)

For 1-Nov-25 (window-mode parameter slices we have cached):

- `delegated-to-coffee` (query: delegated→coffee; explicit n_query anchor→delegated): `n_day=145`, `k_day=59`
- `delegation-straight-to-energy-rec` (delegated→recommendation-offered.exclude(coffee); explicit n_query anchor→delegated): `n_day=145`, `k_day=113`
- `rec-with-bdos-to-registration` (recommendation-offered→registered; no n_query): `n_day=123`, `k_day=11`
- `gm-delegated-to-registered` (delegated→registered; no n_query): `n_day=146`, `k_day=23`

This does **not** by itself prove an n_query maths defect, but it demonstrates the exact places where denominators can diverge (and therefore where drift can be introduced).

#### What remains open / next checks

To decide whether `n_query` maths (or construction) is a plausible root cause for the middle-section discrepancy, we still need to:

- Verify, for each middle-section parameter fetch in window mode, whether `baseRaw.k` (from n_query) equals the “true arrivals at from” concept we intend for that slice.
- Compare the effective provider request semantics for:
  - the main query and the n_query (window bounds, cohort bounds if any, conversion window/cs if any, excluded cohorts, context filters),
  - and confirm they are not “apples and pears”.
- Check whether a graph using window() slices should ever apply an anchor-style `n_query` denominator at all, or whether window mode needs a distinct n_query construction rule.

### Pause point / open questions to resolve next

The remaining discrepancies still “don’t make sense” under the naive mental model (“same events → same answers”) because the system is mixing:

- different conditional denominators (delegated vs recommendation-offered), and
- different cached query signatures / retrieval runs (even for the same high-level DSL), and
- potentially different provider request specs (conversion window/cs, excluded cohorts, context filter compilation).

To get to the bottom of it, next session should:

1. Inspect the **exact provider request payloads** (Amplitude query params) used for:
   - `delegated-to-coffee`
   - `delegation-straight-to-energy-rec`
   - `rec-with-bdos-to-registration`
   - `gm-delegated-to-registered`
   and confirm they match the intended funnel step definitions (especially exclude/visited semantics).

2. Explain why `success-v2` embeds edge evidence that differs from cache reconstruction (e.g. 1-Nov coffee k=59 in graph export vs k=58 from channel-summed cache):
   - confirm which parameter `values[]` entries were embedded during export (signature selection / “latest signature” logic).

3. Validate that the **missing event files** in this snapshot (e.g. failures / no-recommendation) are either:
   - true absorbing nodes without events, or
   - absent from the bundle and need to be included for a complete funnel audit.


