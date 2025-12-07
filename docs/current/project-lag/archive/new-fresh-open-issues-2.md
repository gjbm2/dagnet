## Project LAG: Fresh Open Issues Registry (New)

**Status:** Draft registry  
**Based on:** `design.md`, `open-issues.md`, `implementation-open-issues.md`, new implementation plans  
**Scope:** Tracks remaining ambiguities, deferred decisions, and implementation risks that are not already fully resolved in the design documents. Items here should either be resolved before implementation of the relevant phase or explicitly documented as out-of-scope.

---

### FOI-1: Lag Distribution Family and Fitting Strategy (Phase B1)

- **Design references:** `design.md §5.1–5.3`, `open-issues.md §Remaining Significant Open Design Areas (1, 2)`, `new-implementation-bayesian.md §1`.
- **Issue:** The design specifies candidate distribution families and high-level fitting behaviour but allows some flexibility in the exact choice and tuning (for example, choice between log-normal, Weibull, or Gamma, and how strongly to regularise across contexts).
- **Open questions:**
  - Which family or families should be implemented first in practice for production use?
  - What default priors and hyperparameters should be used for the hierarchical model, and how do they relate to existing statistical conventions in the codebase?
  - How should the system behave when data is too sparse for robust fitting (fallback strategies and thresholds)?
- **Phase impact:** This affects Phase B1 and any subsequent work that depends on posterior lag distributions; core Phase C work can proceed using the retrieval-time summaries already defined.

---

### FOI-2: Time-Varying Behaviour and Drift Detection

- **Design references:** `design.md §5.0.2 (recency weighting)`, `open-issues.md §Remaining Significant Open Design Areas (5)`.
- **Issue:** The design introduces recency weighting and bounded windows to reduce the impact of drift but leaves a fuller drift detection and alerting strategy to future work.
- **Open questions:**
  - How should the system formally detect statistically significant changes in lag or conversion rates over time?
  - What is the user-facing behaviour when drift is detected (for example, warnings in the UI, flags on edges, or changes in default analysis windows)?
  - How should long-term historical data be retained or down-weighted without confusing users about which cohorts are contributing to current forecasts?
- **Phase impact:** Primarily affects later Bayesian and analytics phases; core implementation can proceed using the simpler recency-weighted policies, but the UX around drift will need a more explicit design when those phases are scheduled.

---

### FOI-3: Multi-Edge Path Timing and DAG Runner Convolution

- **Design references:** `design.md §6`, `open-issues.md §Remaining Significant Open Design Areas (6)`, `new-implementation-bayesian.md §3`.
- **Issue:** The design lays out the conceptual approach for convolving lag distributions along multi-edge paths but leaves many details of the runner integration open.
- **Open questions:**
  - How should the system handle paths with mixed latency quality (some edges with fitted distributions, others with only coarse summaries)?
  - What default time horizon should be used for time-indexed projections, and how should users control or override it?
  - How should performance constraints influence the level of detail in time-indexed outputs, especially for large graphs?
- **Phase impact:** This does not block core latency or basic per-edge analytics but is critical for delivering full time-indexed DAG projections and their uncertainty bands.

---

### FOI-4: Integrity Rules for Latency Configuration

- **Design references:** `design.md §3.1`, `design.md §9.2.G`, `open-issues.md GAP-13`, `new-implementation-core.md §1.4`.
- **Issue:** The high-level validity constraints for latency configuration are clear (for example, non-negative maturity days), but the exact behaviour for borderline cases remains to be finalised.
- **Open questions:**
  - ~~Should zero `maturity_days` be allowed as a way of explicitly disabling maturity-based splitting on a latency-tracked edge?~~ **RESOLVED:** `maturity_days = 0` or `undefined` means latency tracking is disabled. No separate `track` boolean. See `design.md §3.1`.
  - How should completeness values be clamped or corrected when inconsistent data is encountered from upstream sources?
  - What severity levels should be used for different integrity failures (warnings vs blocking errors), and how should they surface in `graphIssuesService`?
- **Phase impact:** Needs resolution during Phase C1/C3 implementation so that integrity checks and error messaging are consistent.

---

### FOI-8: Sibling Edge Probability Constraint and Forecasting Artefact

- **Design references:** `design.md §5.0.4`.
- **Issue:** Formula A applies independently to each edge, which can cause `Σ p.mean > 1` for sibling edges as a forecasting artefact. The design now documents this behaviour but some implementation details remain open.
- **Resolved:**
  - The constraint is always valid for `p.evidence` (observed k cannot exceed n).
  - Case (a) both parameterised: artefact is expected; inform user if sum exceeds 1.0 but evidence ≤ 1.0.
  - Case (b) one rebalanced: rebalancing from `p.mean` absorbs the artefact; constraint satisfied.
  - Case (c) neither parameterised: no forecasting, no artefact.
- **Open questions:**
  - What is the exact threshold for surfacing an info-level message about forecasting artefact?
  - Should the DAG runner use `p.evidence` (always valid) or a normalised `p.mean` for flow calculations?
  - How should the normalisation (if used) be presented to users in tooltips or analytics?
- **Phase impact:** Affects Phase C4 (rendering and runner integration). Core data retrieval (C2/C3) is unaffected.

---

### FOI-5: Param File Size, In-Memory Footprint, and Cohort Detail

- **Design references:** `design.md §3.2`, `implementation-open-issues.md §3.1`, `data-retrieval-detailed-flow.md`.
- **Issue:** The design uses flat arrays to represent detailed cohort data, which is efficient structurally but may still be heavy in memory and on disk for large, long-lived edges.
- **Open questions:**
  - Do we need additional summarisation or down-sampling mechanisms for very long history windows to keep param files manageable?
  - Should there be configurable limits on the number of cohorts or date range retained for latency analysis?
  - How should the system behave when limits are reached (for example, dropping oldest cohorts vs truncating detail)?
- **Phase impact:** Primarily an implementation risk for Phase C3; the basic schema can remain as designed, but practical safeguards may be required during implementation.

---

### FOI-6: ReactFlow Performance for Two-Layer Edges

- **Design references:** `design.md §7.1`, `implementation-open-issues.md §4.1`, `new-implementation-core.md §4.1`.
- **Issue:** The design calls for dual-layer rendering (inner and outer edge bands) with stripe patterns; there is a risk that naive implementations could negatively impact ReactFlow performance on dense graphs.
- **Open questions:**
  - Do we need adaptive rendering strategies (for example, simplifying or eliding layered visuals at certain zoom levels or graph sizes)?
  - Can a single path with carefully designed patterns and masks achieve the desired visual effect more cheaply than multiple SVG elements?
  - How should performance trade-offs be tested and monitored over time?
- **Phase impact:** Needs to be considered during Phase C4 so that the latency visuals are performant on realistic graphs.

---

### FOI-7: Test Data and Amplitude Mocks for Latency Scenarios

- **Design references:** `design.md §5.0`, `design.md Appendix A–B`, `implementation-open-issues.md §5.1`, `new-implementation-core.md §3.1, §5.1`.
- **Issue:** Comprehensive testing of latency inference and cohort handling requires realistic mock data that exercises long lags, partial maturity, and data quality quirks described in the design.
- **Open questions:**
  - What minimum set of synthetic cohort scenarios should be standardised for tests (short-lag, long-lag, mixed maturity, sparse data, drift)?
  - Should there be a shared fixture generator for Amplitude-style responses to keep tests consistent across TS and Python?
  - How should we validate that mocks remain representative of real Amplitude behaviour as upstream APIs evolve?
- **Phase impact:** Affects test implementation across Phases C3, analytics extensions, and Bayesian work; the core design is unaffected, but test quality depends on clear decisions here.

---

This registry is intended to stay in sync with the implementation work: items should either be resolved (and removed or marked as such) or explicitly accepted as future work when relevant phases are scheduled.


