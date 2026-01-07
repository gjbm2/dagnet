## Investigation: delegation vs registration graph discrepancy (cohort 1-Nov-25)

**Dates covered:** 6–7-Jan-26  
**Scope:** Explain, on an evidential basis, why **reach probability at success** differs between two graphs when running `cohort(1-Nov-25:1-Nov-25)`, and document the follow-on checks we used to narrow/validate hypotheses (including 1–10 Nov and 1–30 Nov windows where relevant).

### Question being answered

You observed that two graphs (one “delegation”/rebuild view and one “registration”/success-v2 view) produce discrepant reach-at-success numbers for the same cohort.

This document records what we’ve checked so far, exactly what evidence we used, and what the findings imply.

---

## Executive summary (current understanding)

### What we can now explain with evidence

- **The two graphs are not modelling the same conditional middle section**:
  - Rebuild measures \(P(registered \mid delegated)\) directly.
  - `success-v2` forces registration to occur *after* `recommendation-offered`, i.e. it measures \(P(registered \mid recommendation\_offered)\).
  - Therefore denominators differ; reach-to-success can legitimately differ even when the terminal event is the same.

- **A prior “reach probability wildly differs” failure mode was real and is now addressed in code**:
  - Runner analytics were previously being polluted by `conditional_p` in a way that could inflate Evidence-mode reach vs \(k/N\).
  - The runner now ignores `conditional_p` by default (outside explicit What‑If activation), per the agreed Layer 1 decision.

- **A cache-selection defect was real and is now addressed in code**:
  - For uncontexted queries, the system could satisfy the query via a MECE context slice-set even when an explicit uncontexted slice had been freshly fetched.
  - The cache-selection logic now implements “most recent matching slice-set wins” with “context transparent iff MECE”.

### What remains open / not yet fully diagnosed

- **Tail-step evidence mismatch** between `success-v2` (Σ MECE context slices) and rebuild (explicit uncontexted slice) persists on a small number of days over 1–10 Nov.
- **`n_query` semantics risk** (especially window vs cohort) remains an open design/logic concern; we have not yet proven it as the root cause of any remaining discrepancy.

---

## Artefacts (inputs)

Primary referenced files are from the manually attached snapshot under `investigate/` (plus local session logs used to validate fetch/caching behaviour):

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
- **Session logs (fetch/caching evidence)**
  - `tmp.log`
  - `tmp2.log`
  - `tmp3.log`
  - `tmp5.log`

---

## Method (what we did)

We treated this as a **trace + compare** problem, with an explicit separation between:

- what is true in the exported graphs,
- what is true in the cached parameter slices,
- and what the runtime system actually does when selecting/aggregating slices.

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

5. **Reconstruct daily evidence from cached parameter time series (1–10 Nov)**
   - For the most disputed edges, we compared:
     - daily totals from cached parameter `values[].dates/n_daily/k_daily` (Σ MECE channels where applicable),
     - to the exported per-day evidence embedded in the graph snapshots.

6. **Cross-check runtime behaviour using session logs**
   - We inspected `tmp*.log` to confirm:
     - which slices were fetched (window vs cohort),
     - which `conversion_window_days` (`cs`) was used for cohort-mode queries,
     - and whether uncontexted queries were being satisfied by uncontexted slices vs MECE context slice-sets.

7. **Use the Python runner to reproduce analysis discrepancies from extracted assets**
   - Where a discrepancy was suspected to be runner-side (not provider-side), we reproduced it from the extracted graphs using the runner, so we could separate “data” vs “math/selection” issues.

### Reproducibility notes (how numbers were derived)

To keep the investigation reproducible (and avoid “hand-wavy” comparisons), we used the following conventions consistently:

- **Dates**: all human-facing dates are in DagNet’s UK `d-MMM-yy` format; when comparing across codepaths we normalised to date-only semantics (UTC midnight) as used by the app’s parsing utilities.
- **Daily evidence**:
  - For cached parameters, we derived per-day `n/k` from `values[].dates`, `n_daily[]`, `k_daily[]` inside the relevant `values[]` entry.
  - For graph-export evidence, we used the embedded per-day or per-slice evidence values included in the exported graph snapshot.
- **Uncontexted vs contexted**:
  - “Uncontexted” means `extractSliceDimensions(sliceDSL)===''` (no `context(...)` / `case(...)`), not merely “sliceDSL is empty/non-empty”.
  - “Contexted” means a non-empty slice dimension key (e.g. `context(channel:...)`).
- **MECE aggregation**:
  - We only treated context as transparent for uncontexted queries when a complete MECE partition exists (as declared by context definitions / otherPolicy), and we summed per-day totals across the MECE slice-set.
  - We explicitly validated MECE behaviour on at least one upstream step/date to avoid assuming it.

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

---

## Solutions (proposed / design specs)

**Important note on status:**

- This section lists **design intentions and structural fixes** we believe are required for correctness and long-term robustness.
- Some items are marked as “implemented in code (local)” because we applied minimal fixes to unblock investigation and restore internal consistency / tests. These are **not yet production-validated**.

### A (proposed). Normal form: `n_query` should not explicitly encode anchors (match `query` semantics)

For consistency (and to reduce semantic foot-guns), it would be better if `n_query` strings typically did **not** encode the anchor explicitly, in the same way that `query` strings do not.

Proposed convention:

- Store `n_query` in an **anchor-free** form such as `to(X)` (read: “denominator population is arrivals at X”).
- When executing:
  - For **cohort() slices**, the execution layer prepends the cohort anchor (from the cohort DSL / cohort anchor field) so the realised denominator query becomes **A→X** before calling DAS.
  - For **window() slices**, we do **not** prepend an anchor; we execute an X-anchored single-event count for X.

This ensures `query` and `n_query` share the same implied semantics:

- neither string explicitly includes the anchor;
- where anchoring is relevant, the anchor is drawn from the **cohort anchor field**, not duplicated into per-edge strings.

### B (proposed). Window() + dual-query `n_query`: treat denominator as “single-event arrivals at X within the window”

**Problem:** In window mode, the DSL semantics are explicitly **X-anchored** (window bounds apply to the `from()` step). However, our current `n_query` pattern is often **A→X** (anchor→from). When the same `window(...)` bounds are applied to that `n_query`, it becomes **A-anchored**, which is *not* equivalent to “arrivals at X in-window”.

**Proposed fix (Option 1):** For **window() slices**, when we are in dual-query mode due to `n_query`, we should **ignore the `from(...)` in `n_query`** and compute the denominator using a **true single-event query on X**:

- Let X be the `to(...)` node in the stored `n_query` (i.e. the “from-node arrivals” target).
- Execute a single-event count for X under the same window/context/case constraints.
- Use that as the denominator `N(X)` for the edge probability.

This is the most stable and lowest-risk approach for window mode because:

- It matches the intended meaning from `docs/current/nqueryfixes.md`: “all users at the from-node within the window bounds”.
- It avoids mixing A-anchored and X-anchored semantics in the same slice.
- It decouples the window denominator from any upstream anchor choices or path structure.

**Implementation note (high-level):** Today our DAS layer is funnel-oriented and always constructs at least a 2-step funnel (from+to). Implementing this requires adding a provider-supported “single event count” execution path (Amplitude supports this conceptually, but we do not currently construct it in DagNet).

### This likely improves forecast stability, but does not explain the observed Evidence reach drift

The “reach drift” we’re investigating is primarily an **Evidence-mode** inconsistency, and the earlier `nqueryfixes.md` diagnosis for drift (denominator shrinkage + inconsistent conversion windows) is framed around **cohort() semantics** (anchor identity + `cs`).

Window() issues like the one above should mainly affect:

- window-based evidence slices, and
- forecast baselines derived from window slices,

but the core “reach drift” failure mode we observed in Evidence mode was tied to **cohort-mode denominator/horizon coherence**.

Code-level confirmation (current implementation):

- In `dataOperationsService.addEvidenceAndForecastScalars`, **cohort() queries** are treated specially: `p.forecast` is copied from the corresponding **window()** slice in the same parameter file, while evidence is derived from the cohort-sliced n/k.
- In `statisticalEnhancementService`, the forecast blend logic explicitly states: **forecast comes from WINDOW slices** and **evidence comes from COHORT slices** in cohort mode.
- There is one important exception: in cohort-view fetch orchestration, some “simple” edges may be overridden to fetch/aggregate as **window()** even when the tab DSL is cohort-shaped (see the “cohort() mode: simple edges fetch/aggregate as window()” test).

So: the proposed window-mode `n_query` fix should improve window-slice reliability (and therefore forecast baselines), but **it is unlikely to explain cohort-mode Evidence drift** on the edges where cohort semantics (`cs`, anchor identity, denominator coherence at split nodes) dominate.

### C (proposed). Conditional probabilities (`conditional_p`): required structural fixes (new Layer 4 only)

Limit scope: this section only covers the **new Layer 4** concern we explicitly agreed — **runner conditional branch matching must support the full constraint DSL**, not just `visited()`. It intentionally does **not** assume or depend on unresolved Layer 3 (slice/anchor retrieval) questions.

#### 1) Implement full constraint evaluation for `conditional_p[i].condition` in the Python runner

Current mismatch:

- TS has `evaluateConstraint()` which supports constraint-only DSL: `visited`, `exclude`, `visitedAny`, `context`, `case`.
- Python runner currently matches conditional branches by extracting only `visited(...)`, so conditions that include `exclude(...)` / `context(...)` / `case(...)` / `visitedAny(...)` are silently ignored.

Required fix:

- Port the same constraint parsing/evaluation semantics into the Python runner so `conditional_p[i].condition` is evaluated consistently with TS.

#### 2) Make unsupported/invalid conditional conditions explicit (no silent “never matches”)

Required behaviour:

- If a `conditional_p[i].condition` contains an unsupported DSL construct (or is malformed), runner analytics must not silently treat it as non-matching.
- Instead, it should surface an explicit warning/error that the condition cannot be evaluated, so analytics results are not misleading.

#### 3) Required test coverage (was missing)

We need explicit regression coverage for this, otherwise we will reintroduce silent semantic drift.

At minimum:

- Tests that assert Python runner conditional matching honours the same constraint semantics as TS (`visited`, `exclude`, `visitedAny`, `context`, `case`).
- Tests that assert malformed/unsupported condition DSL is surfaced explicitly (warning/error), not silently ignored.

#### 4) Semantic lint: conditional group alignment across siblings

Even if sibling alignment is “mostly managed in UI”, it is important enough to lint explicitly because partial conditional coverage across siblings can silently break conservation.

Add a semantic lint check (surfaced in the issues viewer) that flags:

- A conditional group (by normalised condition string) exists on some outgoing edges from a node, but is missing on one or more sibling edges from that same node.

### D (proposed). Conditional probabilities: per-conditional anchors (MSMDC + query machinery) for cohort() clarity

Layer 3a diagnosis (current behaviour):

- `buildDslFromEdge()` selects the cohort anchor from `constraints.cohort.anchor || edge.p.latency.anchor_node_id`.
- `dataOperationsService.getFromSourceDirect()` builds an edge-like object for conditional fetches by overriding `query`, but it still passes `p: edge.p` into `buildDslFromEdge()` (so anchoring comes from the base edge).
- `queryRegenerationService.applyRegeneratedQueries()` applies MSMDC anchors only to `edge.p.latency.anchor_node_id` (base probability) and does not propagate anchors to `edge.conditional_p[i].p.latency.anchor_node_id`.

This means conditional branch queries can still *work* in cohort() mode (because they inherit the base anchor), but it is **confusing** and easy to misinterpret when debugging drift.

Proposed solution:

- Treat conditional probabilities as first-class anchored entities:
  - MSMDC should compute and return an anchor node for each conditional branch (e.g. keyed by synthetic field like `synthetic:{edge.uuid}:conditional_p[i]`), not only per-edge base `p`.
  - Apply these anchors into `edge.conditional_p[i].p.latency.anchor_node_id` (with an override flag if needed, mirroring the base pattern).
- Update the query machinery so that when `conditionalIndex` is used, the “edge-like” object passed to `buildDslFromEdge()` uses the **conditional** latency anchor (i.e. `edge.conditional_p[i].p.latency.anchor_node_id`) rather than implicitly inheriting from the base edge.

Outcome:

- Cohort anchoring for conditional branch retrieval becomes explicit and auditable.
- Debugging and signature reasoning becomes simpler (no “hidden inheritance” from base edge state).

### E (proposed). Conditional probabilities must be fetched and planned as first-class citizens (Layer 3b defect)

Layer 3b diagnosis (confirmed defect):

- `fetchDataService.getItemsNeedingFetch()` only collects `edge.p`, `edge.cost_gbp`, and `edge.labour_cost`.
- It does **not** include `edge.conditional_p[i].p` entries at all, so planner-driven workflows (coverage check, “retrieve all”, staleness checks) can fail to fetch conditional branch slices.

Required fix:

- Extend fetch planning/coverage/execution to include `conditional_p` entries exactly like base probabilities:
  - add `FetchItem`s for each `conditional_p[i]` with `conditionalIndex: i`,
  - ensure slice matching uses `conditional_p[i].query`,
  - ensure retrieval uses the same connection fallback rules as today (conditional connection else base connection).

#### Required test coverage audit (conditional_p parity across the app)

We have some conditional_p tests (e.g. query selection for `conditionalIndex`, metadata writing on conditional evidence). However, the above Layer 3b defect demonstrates coverage is not yet sufficient.

We should explicitly review and extend tests to cover:

- fetch planning includes conditional_p items (planner + `getItemsNeedingFetch`),
- versioned fetch / retrieve-all includes conditionalIndex items,
- query regeneration applies anchors to conditional branches if/when Solution D is implemented.

### F (proposed). What‑If semantics: “most specific wins” as the uniform matching rule + dedicated review/tests

#### 1) Standardise matching semantics: most specific wins

Adopt “most specific wins” as the norm throughout the app for What‑If matching whenever multiple conditional groups could match simultaneously.

This should apply consistently across:

- What‑If application (`computeEffectiveEdgeProbability`),
- runner logic (TS and Python),
- any UI previews/analytics that use conditional matching.

#### 2) Review and harden What‑If handling across the app (with good test coverage)

Perform a focused review of What‑If logic end-to-end and ensure we have strong regression coverage for:

- condition normalisation,
- matching precedence (“most specific wins”),
- sibling alignment interactions,
- and any scenario/override threading (especially for `conditionalIndex` flows).

### G (implemented in code (local); not yet production-validated). Implicit uncontexted cache selection: “most recent matching slice-set” (recency wins; context is transparent iff MECE)

This is the specific defect that explains why an **uncontexted** query like `cohort(1-Nov-25:10-Nov-25)` can be satisfied by a **contexted** MECE slice-set (e.g. four `context(channel:*)` slices) *even when an explicit uncontexted slice was just fetched*.

Observed symptom (from session logs):

- For `cohort(1-Nov-25:10-Nov-25)` on `registration-to-success`, the system aggregated from 4 channel slices and produced `n=155, k=116`, rather than using the newly fetched uncontexted cohort slice.

Required semantics (agreed):

- **Context is transparent iff MECE**: an uncontexted query may be satisfied by a contexted slice-set only when that slice-set is a **complete, aggregatable MECE partition** over exactly one context key.
- **Recency wins**: if both an explicit uncontexted slice and a valid MECE partition exist, choose whichever dataset is **more recent**.

Concrete rule (deterministic and auditable):

- Define two candidate “slice-sets” within the same mode family (cohort vs window):
  - **Explicit uncontexted candidate**: values whose slice dimensions are empty (no `context(...)` / `case(...)`).
  - **MECE candidate**: the best complete MECE partition (e.g. `channel`) and its component slices.
- Define **dataset recency** from the stored `data_source.retrieved_at` timestamps:
  - **Uncontexted recency**: max `retrieved_at` among uncontexted candidates.
  - **MECE recency**: min `retrieved_at` across the MECE slices (the set is only as fresh as its stalest member).
- Choose the candidate with the higher dataset recency.

Implementation scope (to prevent “planner vs execution” disagreement):

- Apply the same selection rule in both:
  - **Get-from-file slice selection** (what determines what you see on the graph / in analysis), and
  - **cache cutting / incremental fetch** (what determines whether the system thinks it is covered or needs fetch).

Status:

- Implemented in code (local) on **7-Jan-26** (selection now compares explicit-uncontexted vs MECE slice-sets by recency, rather than always preferring MECE whenever a partition exists). Not yet production-validated.

Further robustness work (recommended before we rely on this in production):

- **Select a coherent MECE “generation” (avoid cross-generation mixing)**:
  - In practice, a parameter file can contain multiple generations of the same MECE slices (e.g. different `query_signature`s, or historical duplicates caused by non-canonical sliceDSL / legacy writes).
  - The selection logic should treat a MECE dataset as a *set* keyed by:
    - mode (cohort vs window),
    - MECE key (e.g. `channel`),
    - and (when present) `query_signature`.
  - Then choose the most recent complete set (recency = min `retrieved_at` across the set) and aggregate only within that chosen set.

- **Canonicalise at write-time to minimise duplicates**:
  - Ensure persistence always writes `data_source.retrieved_at` and uses canonical slice identifiers so repeated fetches merge into existing entries rather than creating near-duplicates.
  - Where possible, keep one canonical entry per (mode + slice dims) for uncontexted, and one per (mode + slice dims) per context value for MECE.

- **Diagnostics: log which slice-set won (and why)**:
  - When fulfilling an uncontexted query via cache, log:
    - whether we chose explicit uncontexted vs MECE,
    - the recency values used in the comparison,
    - and (for MECE) which key and which set signature was selected.
  - This turns future “why did it pick that?” debugging into a one-glance answer.

- **Test coverage for the new semantics (explicitly)**:
  - Add focused tests for:
    - explicit uncontexted vs MECE where uncontexted is newer (uncontexted must win),
    - explicit uncontexted vs MECE where MECE set is newer (MECE must win),
    - multiple MECE generations (ensure we pick one complete set, not mix).

--

## Pause point / open questions to resolve next

The remaining discrepancies still “don’t make sense” under the naive mental model (“same events → same answers”) because the system is mixing:

- different conditional denominators (delegated vs recommendation-offered), and
- different cached query signatures / retrieval runs (even for the same high-level DSL), and
- potentially different provider request specs (conversion window/cs, excluded cohorts, context filter compilation).

#### Potential defect: exclude term dropped in persisted evidence `full_query`

In the latest simplified run we observed an alarming mismatch between an edge’s `query` and the persisted evidence `full_query` for the same edge:

- edge `query` indicates: `from(household-delegated).to(recommendation-offered).exclude(gave-bds-in-onboarding,viewed-coffee-screen)`
- but `p.evidence.full_query` appears to show: `from(household-delegated).to(recommendation-offered).exclude(viewed-coffee-screen)` (missing the `gave-bds-in-onboarding` exclusion)

If this is real (and not just selecting a stale cached value entry), it would mean we are **silently changing query semantics** between the graph edge definition and the executed provider request.

Next steps:

- Confirm whether this is a **query construction/adapter bug** (exclude list lost) versus a **cache/signature selection bug** (old evidence value attached to the edge).
- If reproducible, add a regression test around building/executing `exclude(a,b)` for Amplitude and ensure both exclusions survive into the executed request semantics.

#### Root cause for “Reach Probability wildly differs” (SV2, Evidence mode, 1-Nov-25)

We can now reproduce the exact discrepancy purely from the extracted investigation graphs, using the Python analysis runner directly:

- GM: `P(reach success) = 16/246 = 0.06504065`
- SV2: previously showed `P(reach success) = 0.0709446` while `k/N = 15/246 = 0.0609756` (inflated reach vs k/N)

Diagnosis: **SV2’s reach calculation was being polluted by `conditional_p` branches that are not evidence-derived for the slice**.

Specifically, SV2 includes `conditional_p` on `recommendation-offered → switch-registered` (and on `recommendation-offered → post-recommendation-failure`), with conditions like `visited(gave-bds-in-onboarding)`. The path runner treats `conditional_p` as intrinsic graph semantics (not What-If), so it switches to a state-space algorithm whenever any `conditional_p` exists and then prefers `conditional_p.p.mean` over the base edge probability.

However, the stored `conditional_p` branches in SV2 do **not** include slice-specific evidence (`conditional_p.p.evidence.mean` is absent), so in “Evidence Probability” mode they were still injecting non-evidence probabilities. This explains why reach could deviate dramatically from `k/N`.

Mitigation (implemented in the Python runner, per the Layer 1 decision below):

- Runner analytics now **ignore `conditional_p` by default** (outside explicit What‑If activation / constraint-driven conditional evaluation).

Effect:

- This removes the large reach inflation in SV2 Evidence mode that came from applying non-evidence `conditional_p.p.mean` in path calculations.
- In our extracted-graph reproduction, SV2 reach reverted to the unconditional evidence-composed value (and no longer showed a dramatic divergence from \(k/N\)).

Residual note (still important, but much smaller in magnitude):

- Even with `conditional_p` ignored, SV2’s reach can remain slightly above \(k/N\) because SV2’s stored edge evidence means do not telescope perfectly through the topology (the evidence layer is not globally conservative). The **large** discrepancy was driven by conditional leakage; the remaining small gap is “edge-means vs realised k/N” drift.

---

## 7-Jan-26: conditional probabilities (`conditional_p`) — layered investigation plan

We appear to have **multiple issues at different layers**. These need to be investigated separately, otherwise we will keep mixing “design questions” with “implementation bugs”.

### Layer 1 — Should `conditional_p` be used at all for runner analytics (outside What‑If)?

Open question:

- Do runner analytics (e.g. Reach Probability / Bridge View) treat `conditional_p` as intrinsic graph semantics, or should they ignore it unless What‑If is active?

This is a product/semantics decision, but it has direct consequences for whether Reach Probability is expected to telescope to \(k/N\).

Decision (agreed):

- `conditional_p` should **not** be applied “naively” by runner analytics by default.
- Runner analytics should only apply conditional probabilities when they are **explicitly activated** as a What‑If by the analysis DSL (e.g. the analysis query asserts constraints that fully satisfy a conditional group), otherwise the runner should use the unconditional edge probabilities.

### Layer 2 — If `conditional_p` is used: what are the preconditions?

Open questions:

- Must conditional branches be MECE at each application point (mutually exclusive and collectively exhaustive), so probabilities remain conservative?
- Do we require explicit “else” branches, or can missing mass be handled via complements?
- What does “visited(X)” mean for conditioning in cohort vs window slices (anchor-aligned semantics)?

If these preconditions are not met, even correctly retrieved conditional probabilities can create non-conservation.

Current implementation reality (useful for diagnosing what can go wrong):

- The existing validator (`graph-editor/src/lib/conditionalValidation.ts`) enforces:
  - base sibling sums ≈ 1,
  - conditional sibling sums ≈ 1 for each *referenced visited-node* condition,
  - condition node must be upstream,
  - basic circular-dependency checks.
- It currently reasons about conditions via `getVisitedNodeIds(...)` only, so it effectively treats conditions as “visited-node sets” and does **not** validate MECE/exhaustiveness for:
  - multi-clause conditions (`visited(a).exclude(b)`),
  - overlapping conditions that can both be true (ambiguity),
  - combinations of visited nodes (it validates each visited node independently rather than the full state space).
- Rebalancing of conditional siblings (`UpdateManager.rebalanceConditionalProbabilities`) matches siblings by *exact* condition string equality, so “same logical condition, different string form” will not rebalance unless normalised consistently.

### Layer 3 — If `conditional_p` is used in a calc: are slices being retrieved correctly?

Two specific concerns:

- **(a) Missing cohort anchor / conversion window alignment**: conditional branch queries appear to lack cohort anchoring and/or the same conversion window semantics, which could create time-shift inconsistencies and non-conservation. Hypothesis: MSMDC (and/or query construction) is not applying anchor generation logic to conditional branches.
- **(b) Are conditional branches being fetched at all?** If branch probabilities are not slice-retrieved (or are retrieved only as stale/static values), then “Evidence Probability” can silently incorporate non-evidence or wrong-slice data.

### Layer 4 (closed) — Provider query compilation: are `visited()` / `exclude()` semantics honoured?

Status: **Not currently a serious concern** for the specific “window() accidentally becomes B→X→Y (B-anchored super-funnel)” fear.

What we believe is true based on the current implementation:

- Conditional branch queries are fetched using `conditional_p[i].query` (not the base edge query), so `visited(...)` terms are not silently dropped at the fetch entry point.
- `buildDslFromEdge()` classifies `visited(B)` as `visited_upstream` when B is upstream of `from(X)`.
- For **Amplitude**, `visited_upstream` is compiled into native segment filters and then cleared before funnel construction, so we do **not** build a B→X→Y super-funnel in that path.

Remaining caveat (acknowledged but not treated as the core issue here):

- Amplitude’s current `visited_upstream` segment filter uses a rolling lookback window, so it can include some users who visited(B) outside the X→Y observation window. We accept this limitation for now.

### Layer 4 (new) — Runner conditional semantics: conditional branch matching must support full DSL, not just `visited(...)`

This **is** a serious concern.

Current runner behaviour:

- The Python analysis runner’s conditional path logic only recognises `visited(...)` in `conditional_p[i].condition` strings when deciding whether a conditional branch applies.
- Conditions containing other DSL concepts (e.g. `exclude(...)`, `context(...)`, `case(...)`, `visitedAny(...)`) are not evaluated, so those branches can never match in runner analytics even if they are meaningful and correctly retrievable in DAS.

Implication:

- Runner analytics can compute reach/probabilities using a conditional structure that does not match the graph’s intended conditional semantics, which can create misleading results and apparent non-conservation.

Required follow-up:

- Extend runner conditional evaluation to honour the same constraint semantics as the DSL (at minimum: `visited`, `exclude`, `context`, `case`, `visitedAny`, and window/cohort constraints where applicable).

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


