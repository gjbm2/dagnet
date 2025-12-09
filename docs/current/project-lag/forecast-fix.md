Forecast Blending Fix – Using Window Forecasts in p.mean
========================================================

Context
-------

Latency-enabled edges currently expose three probability concepts in the param pack and rendering:

- Blended probability (`p.mean`) – what the graph currently uses as the main edge probability.
- Evidence probability (`p.evidence.mean`) – raw observed rate for the current query window (k / n).
- Forecast probability (`p.forecast.mean`) – baseline long-run conversion probability, typically derived from a broader window() slice or from LAG’s p∞.

The original design intent for F/E/F+E mode was:

- **Evidence**: show what has actually happened so far in the queried window.
- **Forecast**: show where things are likely to end up once all lagged conversions have arrived.
- **Blended p.mean**: a principled combination of evidence and forecast, weighted by lag maturity and sample size.

In practice, the current implementation often collapses to:

- `p.mean ≈ p.evidence.mean` even when completeness is clearly < 1 and a strong forecast baseline exists (for example, shipped-to-delivered with completeness ≈ 0.6 and forecast ≈ 0.98).
- `p.forecast.mean` is present in the param pack but is **not** used in the final p.mean when LAG deems “no mature cohorts” for the specific window.

This makes the F+E rendering largely cosmetic in exactly the immature regimes it was designed to illuminate.

Current Behaviour (High Level)
------------------------------

For a latency-enabled edge and a query such as `cohort(9-Nov-25:15-Nov-25)`:

1. **Evidence path**
   - Daily counts are sliced to the requested window.
   - Evidence scalars are computed:
     - `p.evidence.mean` = total k / total n for the sliced window.
     - `p.evidence.stdev` from the usual binomial approximation.

2. **Forecast path**
   - A broader window() slice in the parameter file provides a baseline forecast:
     - This is currently stored as the parameter value’s `forecast` field and surfaced as `p.forecast.mean` in the param pack.

3. **LAG / latency path**
   - Cohort data (date, n, k, age) for the requested window are passed into the LAG engine.
   - The engine:
     - Fits a lag distribution.
     - Computes t95 and completeness.
     - Attempts to estimate an asymptotic p∞ (`p_infinity`) based on **mature cohorts** relative to t95/maturity_days.
   - If LAG can find sufficient mature cohorts:
     - It computes an internal `p_mean` using Formula A and returns that as part of the latency stats.
   - If it **cannot** find mature cohorts for this window:
     - It returns `forecast_available = false`.
     - It falls back to:
       - `p_infinity = p.evidence.mean`.
       - `p_mean = p.evidence.mean`.

4. **Edge p.mean**
   - `dataOperationsService` currently takes the LAG `p_mean` and persists it as the edge’s `p.mean`, overriding the earlier window-based `mean` in most interesting cases.
   - When LAG falls back to evidence, `p.mean` on the edge ends up effectively equal to `p.evidence.mean`.
   - `p.forecast.mean` remains available in the param pack, but is not part of the persisted `p.mean`.

Net effect: in immature regimes where completeness is materially below 1 and a strong window-level forecast baseline exists, the main edge probability is still essentially **just evidence**. The extra signal from the window forecast is ignored whenever LAG does not succeed in estimating p∞ from cohorts alone.

Design Correction – Blended p.mean Using Window Forecast
--------------------------------------------------------

We already know three key quantities for each latency edge and query window:

1. **Evidence**: `p.evidence.mean` and `p.evidence.stdev` for the specific query window (from slice headers and daily data).
2. **Baseline forecast**: `p.forecast.mean` derived from a broader window() slice (or from LAG’s p∞ when reliable).
3. **Lag maturity**: completeness and t95 from the LAG engine (and the underlying cohort ages).

The corrected design should:

- Treat `p.forecast.mean` as a legitimate **baseline p∞** for the edge, not just an informational scalar.
- Define `p.mean` explicitly as a **blend** of evidence and forecast:

  - `p.evidence.mean` answers: “What have we seen so far in this window?”
  - `p.forecast.mean` answers: “What should we expect eventually, based on mature data and/or broader windows?”
  - `p.mean` answers: “Given lag and what we’ve seen, where do we think this window will land?”

Blending Strategy (Conceptual)
------------------------------

Define:

- \( p_\text{evidence} \) – evidence mean for the query window.
- \( p_\text{forecast} \) – baseline forecast (either LAG p∞ when available, or the file’s window-level forecast).
- \( c \in [0, 1] \) – completeness for the query window from the LAG engine.
- \( n \) – effective sample size in the query window (total n across cohorts).

Then define a weight \( w_\text{evidence}(c, n) \in [0, 1] \) with the following properties:

- For low completeness, the weight on evidence should be small and p.mean should be pulled **towards forecast**.
- As completeness approaches 1 (and n is reasonable), the weight on evidence should approach 1 so that p.mean converges to p.evidence.
- For extremely small n, even at moderate completeness, the weight on evidence should be down-weighted to avoid over-trusting noise.

A simple, monotone scheme that obeys these properties:

- Base weight on completeness:

  - \( w_0 = c^\alpha \) with \( \alpha > 1 \) (for example, \( \alpha = 2 \)).
  - This makes evidence contribute slowly at low c and accelerate as cohorts mature.

- Optionally modulate by sample size:

  - Clamp an evidence confidence factor based on n:
    - \( w_n = \min(1, n / n_0) \) with \( n_0 \) a tuning constant (e.g. around 100).

- Combined weight:

  - \( w_\text{evidence} = w_0 \times w_n \).

Then:

- When a meaningful forecast is available:

  - \( p_\text{mean} = w_\text{evidence} \cdot p_\text{evidence} + (1 - w_\text{evidence}) \cdot p_\text{forecast} \).

- When no usable forecast exists (no window forecast and no reliable p∞ from LAG):

  - Fall back to the current behaviour:
    - \( p_\text{mean} = p_\text{evidence} \) (or the simple aggregate mean from the enhancement step).

Interpretation:

- Immature, low completeness queries (e.g. completeness ≈ 0.4–0.6) with solid forecast baselines will have p.mean **materially above** p.evidence.mean and **below** p.forecast.mean.
- Fully mature regimes (completeness ≈ 1, good n) will bring p.mean back in line with p.evidence.mean.

Intended Behaviour for Sample Data
----------------------------------

Using the shipped-to-delivered latency sample as a concrete example:

- For `cohort(9-Nov-25:15-Nov-25)` the current pipeline yields approximately:

  - `p.evidence.mean ≈ 0.71` (from n=97, k=69).
  - `completeness ≈ 0.60`.
  - `p.forecast.mean ≈ 0.98` (from the 14-day window slice).

Under the new blending scheme:

- With \( c = 0.6 \) and a moderate n, we might have \( w_\text{evidence} \approx 0.36 \) (for example).
- Then:

  - \( p_\text{mean} \approx 0.36 \times 0.71 + 0.64 \times 0.98 \).
  - This yields a p.mean **significantly above 0.71** and meaningfully below 0.98.

This matches the intuitive story:

- The evidence in this narrow window is clearly immature (completeness 0.6 on a long-lag edge).
- The broader window forecast tells us the edge tends to be ~98% in the long run.
- Our best estimate for the eventual conversion for this specific window should be much closer to the forecast than to the raw 71%, but still moderated by the fact that some of the tail may differ for this cohort range.

Concrete Implementation Changes (High Level)
-------------------------------------------

1. **DataOperationsService – replace LAG p_mean as the source of edge p.mean**

   - In the window/cohort aggregation branch of `getParameterFromFile`:
     - Stop persisting `latencyStats.p_mean` directly as `aggregatedValue.mean`.
     - Treat `latencyStats` as:
       - A source of lag diagnostics (`t95`, completeness).
       - An optional source of a baseline p∞ (when it has enough mature cohorts).

   - Introduce a clear blending step when building `aggregatedValue`:
     - Compute or reuse:
       - Evidence mean (`p_evidence`).
       - Forecast baseline (`p_forecast`), choosing from:
         - LAG’s `p_infinity` if `forecast_available` is true.
         - The parameter file’s window-level `forecast` if present.
     - Compute completeness (`c`) and effective n from the aggregation results.
     - Combine them via the blending function described above to obtain the final `p.mean` for this query.

2. **StatisticalEnhancementService – keep p_mean internal**

   - `computeEdgeLatencyStats` should continue to compute:
     - `p_evidence` (cohort-level evidence for the query).
     - `completeness`, `t95`, `p_infinity`.
     - Its own internal `p_mean` from Formula A.
   - However, this `p_mean` should be treated as an internal diagnostic:
     - We no longer use it directly as the graph’s `p.mean`.
     - We may still log it and use it as a cross-check or for debugging, but the canonical `p.mean` for the edge comes from the explicit blend in `dataOperationsService`.

3. **Param Pack Semantics – unchanged at the interface**

   - The external meaning of the param pack keys remains:
     - `p.mean` – blended probability (now explicitly “evidence–forecast blend”).
     - `p.evidence.mean` – raw observed rate for the query window.
     - `p.forecast.mean` – baseline long-run probability, typically from window slices.
   - F+E mode and tooltips automatically benefit:
     - F-only: stripes at `p.forecast.mean`.
     - E-only: solid at `p.evidence.mean`.
     - F+E: contrasting layers at both evidence and forecast, with the anchor still using completeness.

4. **Tests**

   - Update `sampleFileQueryFlow.e2e.test.ts` to:
     - Expect `p.mean` to sit strictly between `p.evidence.mean` and `p.forecast.mean` for incomplete windows where forecast is available.
     - Keep the existing checks on `p.evidence.*` and `p.forecast.*`.
   - Keep `statisticalEnhancementService` tests focused on internal LAG properties (bounds, completeness, monotonicity), not on the final edge p.mean.

Summary
-------

The essence of this fix is to **promote the window-based forecast to a first-class participant in p.mean**, rather than letting the LAG engine silently discard it whenever it cannot infer p∞ from the same immature cohorts. By explicitly defining `p.mean` as a completeness- and n-aware blend of `p.evidence` and `p.forecast`, we:

- Make F+E mode meaningfully expressive in exactly the immature regimes it was designed for.
- Preserve the interpretation of evidence and forecast as distinct but complementary signals.
- Keep the LAG machinery focused on what it does best: lag-aware completeness, t95, and quality-gated estimates of p∞, without overloading it as the sole arbiter of the final edge probability.


