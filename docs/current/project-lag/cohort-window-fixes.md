## Cohort & Window Query Fixes – Required Edits

### 1. Scope and Goals

- **Purpose**: Specify the concrete test and code changes needed to bring `window()` and `cohort()` behaviour into line with the LAG design:
  - `window()` evidence must be computed **only from dates inside the requested window**.
  - `cohort()` evidence must be computed **only from cohorts inside the requested cohort window**.
  - `p.forecast.*` may use the **best available baseline window** in the param file and is **not** restricted by the evidence window.
- **Surfaces impacted**:
  - Test file `sampleFileQueryFlow.e2e.test.ts`.
  - Service layer: `dataOperationsService` and `windowAggregationService`.
  - No changes to UI/menu files; all logic remains in services.

---

## 2. `window()` Queries – Evidence vs Forecast

### 2.1 Test Changes for `window()`

- **New window coverage tests in `sampleFileQueryFlow.e2e.test.ts`**  
  Extend the existing “Window Query” describe block with explicit coverage of **non-exact windows**:

  - **Exact stored window (baseline)**  
    - Keep the existing test that uses the canonical stored slice:
      - DSL: `window(25-Nov-25:1-Dec-25)` for `checkout-to-payment`.
      - Expected evidence:
        - Numerator: 265.
        - Denominator: 385.
        - Mean: 265 ÷ 385.
        - Standard deviation: binomial formula using that mean and denominator.
      - Expected forecast:
        - Equal to the stored `forecast` scalar on the window slice.

  - **Narrower window fully inside the stored slice**  
    - Add a test case with a DSL window strictly inside the stored window, for example:
      - DSL: `window(26-Nov-25:30-Nov-25)`.
    - Use the daily arrays from the sample parameter file to compute expected evidence:
      - Restrict to dates between 26‑Nov‑25 and 30‑Nov‑25 inclusive.
      - Sum the corresponding `n_daily` entries to obtain the expected denominator.
      - Sum the corresponding `k_daily` entries to obtain the expected numerator.
      - Compute mean and standard deviation from those totals.
    - Assertions:
      - `p.evidence.mean` on the edge must match this sub‑window mean (not the full 25‑Nov‑25 to 1‑Dec‑25 mean).
      - `p.evidence.stdev` must match the sub‑window binomial standard deviation.
      - `p.forecast.mean` is allowed to stay at the full‐window baseline and should not be constrained by the narrower evidence window.

  - **Window wider than stored coverage**  
    - Add a test case with a DSL window that starts before and ends after the stored slice, for example:
      - DSL: `window(24-Nov-25:2-Dec-25)`.
    - Expected evidence:
      - Only dates where data exists (25‑Nov‑25 to 1‑Dec‑25) contribute.
      - Totals must still equal the full stored slice (265 and 385 in the fixture).
    - Assertions:
      - Evidence mean and standard deviation must match the full stored slice numbers.
      - Logically, days with no data must **not** change the totals; missing days are handled as gaps rather than zero‑weight data.

  - **Context‑sensitive window test (optional but recommended)**  
    - For the google context slice, add a parallel test that uses a window narrower than the stored context window:
      - DSL: `window(26-Nov-25:30-Nov-25).context(channel:google)`.
    - Compute expected evidence from the context‑specific daily arrays in the param file.
    - Assert that `p.evidence.*` is based only on those dates, while `p.forecast.mean` comes from the best available window baseline for that context.

### 2.2 Code Changes for `window()` Evidence

- **Single source of truth: parse window from DSL for from‑file path**  
  - Ensure `getParameterFromFile` **always** parses the `window()` clause from the `targetSlice` DSL, even when the optional `window` argument is not provided.
  - This parsed window must be used consistently through:
    - Time‑series construction from `values[].dates`, `n_daily`, `k_daily`.
    - The call into the aggregation helper in `windowAggregationService`.

- **Always run window aggregation for `window()` queries**  
  - For any call where the parsed constraints contain a `window` clause and no `cohort` clause:
    - Execute the full aggregation path:
      - Build a combined time series for the selected slice(s).
      - Filter time‑series points to the requested window.
      - Aggregate totals using the existing aggregation helper in `windowAggregationService`.
  - Avoid skipping aggregation based on “exact slice” matches; even when the stored window exactly matches the DSL, running through the aggregation step is both cheap and guarantees consistency.

- **Ensure aggregated `n` and `k` are used for evidence**  
  - After aggregation completes, the per‑slice structure used for `UpdateManager` needs to:
    - Store the aggregated `n` and `k` for the current window in the `values[]` entry that will be treated as “latest”.
    - Ensure any subsequent computation of `evidence.mean` and `evidence.stdev` is derived from these aggregated totals, not from stale `n` and `k` copied from the original slice header.
  - This can be achieved by:
    - Letting the aggregation step populate the `n` and `k` fields on the “aggregated value” record.
    - Having the evidence helper read from these fields when computing evidence scalars.

- **Preserve forecast baseline semantics**  
  - `p.forecast.mean` should **not** be tied to the evidence window.
  - For `window()` queries:
    - The forecast baseline can come from:
      - The canonical window slice used as a baseline (for example, the pinned DSL window for that edge).
      - Or, when required by the design, an implicit baseline window derived from `maturity_days`.
    - The aggregation for forecast should use the rules in the LAG design (recent history, mature days, etc.), independent of the evidence window used in the current query.
  - Implementation detail: the helper that injects forecast into the aggregated value should look up the best baseline window slice in the file and copy its `forecast` scalar, rather than recomputing it from the current evidence window.

---

## 3. `cohort()` Queries – Evidence vs Forecast

### 3.1 Test Changes for `cohort()`

- **Baseline full‑cohort test**  
  - Keep the existing test that uses the full stored cohort:
    - DSL: `cohort(landing-page,1-Sep-25:30-Nov-25)`.
    - Evidence expectation:
      - Use the header `n` and `k` in the cohort slice as the authoritative totals for the full window in the sample file.
    - This test functions as a sanity check for the happy path where the DSL exactly matches the stored cohort bounds.

- **Narrower cohort sub‑window test (critical)**  
  - Add a test where the DSL selects a sub‑cohort range strictly within the stored slice, for example:
    - DSL: `cohort(landing-page,1-Oct-25:15-Oct-25)`.
  - Use the cohort slice’s daily arrays (from the sample parameter file) to build expectations:
    - Restrict the `dates`, `n_daily`, `k_daily` arrays to those where the date lies between 1‑Oct‑25 and 15‑Oct‑25 inclusive.
    - Sum the restricted `n_daily` to get the expected denominator.
    - Sum the restricted `k_daily` to get the expected numerator.
    - Compute evidence mean and standard deviation from these totals.
  - Assertions:
    - `p.evidence.mean` on the edge must equal the computed sub‑window evidence mean.
    - `p.evidence.stdev` must equal the sub‑window binomial standard deviation.
    - `p.mean` (blended) is allowed to differ from `p.evidence.mean` according to the forecasting formula; the test should only assert they are “close” for mature cohorts as per the design (for example, absolute difference less than 0.01).

- **Contextual cohort test**  
  - Extend the existing context cohort test to include a **narrower** `cohort()` window with context, for example:
    - DSL: `cohort(landing-page,1-Oct-25:15-Oct-25).context(channel:google)`.
  - Use the context‑specific cohort slice’s daily arrays to compute expectations in the same way as for the base cohort.
  - Assertions:
    - Evidence mean and standard deviation must reflect only the cohorts in the requested date range for that context.

### 3.2 Code Changes for `cohort()` Evidence

- **Parse `cohort()` from the DSL in `getParameterFromFile`**  
  - Whenever `targetSlice` contains a `cohort()` clause:
    - Parse the cohort anchor and date bounds from the DSL using the existing constraint parser.
    - Treat these dates as the **authoritative cohort evidence window** for this call.
  - This parsing must be done alongside (not instead of) window parsing, since the same DSL may include both `window()` and `cohort()` parts in more complex flows.

- **Build cohort data for the requested window**  
  - Use the existing helpers in the window aggregation service to work with cohort data:
    - For the relevant `values[]` entries (selected by slice isolation logic), convert each entry’s daily arrays into a flat list of cohorts, where each cohort has:
      - A date (cohort entry date).
      - `n` and `k` counts.
      - An age in days (for forecasting).
    - Combine cohorts from all relevant values, preferring more recent data where there are overlaps for the same cohort date, using the stored `retrieved_at` timestamp as the tiebreaker.
  - After this aggregation, filter the combined cohort list so that **only cohorts whose dates lie within the `cohort(start:end)` window are included** in the evidence computation.

- **Compute cohort evidence from the filtered cohorts**  
  - For the filtered set of cohorts:
    - Sum all `n` to obtain the evidence denominator.
    - Sum all `k` to obtain the evidence numerator.
    - Compute:
      - Evidence mean as numerator divided by denominator.
      - Evidence standard deviation using the binomial formula.
  - Inject these scalars into the parameter‑shaped data passed to `UpdateManager`:
    - Use a dedicated evidence block on the “latest” value entry, ensuring that the mapping rules in `UpdateManager` copy these numbers into `edge.p.evidence.mean` and `edge.p.evidence.stdev`.
  - Special case:
    - When the cohort DSL bounds exactly match the stored `cohort_from` and `cohort_to` for the slice, it is acceptable to fall back to the header `n` and `k` as the total counts, to avoid sample truncation issues in fixtures.

- **Keep forecast baseline independent from the cohort evidence window**  
  - For `cohort()` queries, `p.forecast.mean` should:
    - Continue to be derived from the best window slice available for that edge and context.
    - Not be re‑derived from the cohort evidence sub‑window.
  - Implementation guideline:
    - The helper that injects forecast into the aggregated value should:
      - Find the appropriate window slice(s) for the edge and context, using canonical `sliceDSL` matching as already designed.
      - Compute or copy the baseline `forecast` scalar from those slices.
      - Leave that scalar unchanged regardless of the `cohort()` date window used for evidence.

---

## 4. Cross‑Cutting Considerations

- **Slice isolation and exact `sliceDSL` matching**  
  - For both `window()` and `cohort()`:
    - Retain canonical slice isolation based on `sliceDSL` and the context/case dimensions, so the correct slice rows are used for each query.
    - Do **not** use the existence of a matching `sliceDSL` as a reason to bypass evidence window slicing; evidence must always respect the query’s date bounds.

- **Shared evidence helper for both flows**  
  - The logic that computes `p.evidence.*` from daily data should be centralised in a single helper inside `dataOperationsService`, so:
    - `getFromSource` (versioned) and `getFromSourceDirect` (direct) both run through the same path.
    - Any future changes to evidence semantics are made once and apply to all call sites.

- **Tests as specification**  
  - The new `window()` and `cohort()` tests in `sampleFileQueryFlow.e2e.test.ts` should be treated as **executable specification**:
    - They must fail if evidence is ever computed from full slices when a narrower DSL window is requested.
    - They must continue to pass when internal implementation details (for example, the exact helper structure) change, as long as the externally visible semantics remain correct.


