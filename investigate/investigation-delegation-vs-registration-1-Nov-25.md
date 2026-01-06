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


