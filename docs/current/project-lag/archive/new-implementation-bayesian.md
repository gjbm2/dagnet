## Project LAG: Bayesian and Hierarchical Latency Implementation Plan (New)

**Status:** Draft planning document  
**Based on:** `design.md §5.1–5.3`, `open-issues.md (Remaining Significant Open Design Areas)`, `CONDITIONAL_PROBABILITY_ARCHITECTURE.md`  
**Scope:** Phase B work to fit parametric lag distributions, introduce hierarchical Bayesian inference, and expose uncertainty bands for latency, building on the core latency implementation.

This document is prose-only and assumes all core phases in `new-implementation-core.md` are complete.

---

## 1. Python Inference Engine and Distribution Fitting

**Design reference:** `design.md §5.1–5.3`, `open-issues.md (lag CDF fitting and Formula A validation)`.

### 1.1 Core fitting routines

**Code files to touch or extend:**

- `graph-editor/lib/stats_enhancement.py`  
  (implement parametric lag fitting functions and any survival-analysis utilities outlined in the design)
- `graph-editor/lib/algorithms/` (relevant modules)  
  (factor out generic optimisation or sampling helpers if needed)

### 1.2 Hierarchical model wiring

**Code files to touch or extend:**

- `graph-editor/lib/stats_enhancement.py`  
  (introduce hierarchical model definitions for pooling lag information across contexts)
- `graph-editor/lib/api_handlers.py`  
  (expose endpoints or background tasks to trigger fitting runs and retrieve posterior summaries)

### 1.3 Tests and validation

**Code files to touch or extend:**

- `graph-editor/lib/tests/` (add or extend tests that validate fitted parameters and derived quantities against synthetic cohorts)
- Any performance or stability tests that check fitting behaviour under realistic data volumes

The emphasis here is on making the implementation match the families and summary outputs described in the design, rather than inventing new modelling approaches.

---

## 2. Storage of Fitted Parameters and Integration with Parameters

**Design reference:** `design.md §5.3`, `design.md §3.2`, `open-issues.md DATA ARCHITECTURE`.

### 2.1 Parameter file extensions for posterior summaries

**Code files to touch or extend:**

- `graph-editor/public/param-schemas/parameter-schema.yaml`  
  (add fields for fitted distribution families, parameter estimates, and credible intervals under latency-related blocks)
- `graph-editor/public/ui-schemas/parameter-ui-schema.json`  
  (expose fitted latency summaries in a read-friendly way, while keeping them clearly distinct from user-editable settings)

### 2.2 TS types and UpdateManager mappings

**Code files to touch or extend:**

- `graph-editor/src/types/index.ts`  
  (extend latency-related types with fitted-parameter fields)
- `graph-editor/src/services/UpdateManager.ts`  
  (map new param-file latency summaries to display-only edge fields where needed)

### 2.3 Tests and consistency checks

**Code files to touch or extend:**

- `graph-editor/src/services/__tests__/schemaTypescriptParity.test.ts`
- `graph-editor/src/services/__tests__/schemaTypesConsistency.test.ts`
- `graph-editor/src/services/__tests__/sampleDataIntegrity.test.ts`

These checks ensure that fitted-parameter storage remains in lockstep across schemas, TS types, and sample data.

---

## 3. Time-Indexed DAG Runner and Uncertainty Bands

**Design reference:** `design.md §6`, `open-issues.md (multi-edge path timing and Monte Carlo bands)`.

### 3.1 Runner integration of lag distributions

**Code files to touch or extend:**

- `graph-editor/lib/runner/runners.py`
- `graph-editor/lib/runner/graph_builder.py`
- `graph-editor/lib/runner/path_runner.py`

The work here is to integrate edge-level lag distributions into time-indexed flow computation, so that node arrivals can be projected by day and combined with fitted probabilities.

### 3.2 Uncertainty quantification and Monte Carlo sampling

**Code files to touch or extend:**

- `graph-editor/lib/stats_enhancement.py`  
  (sampling from fitted lag and probability distributions)
- `graph-editor/lib/runner/runners.py`  
  (run multiple samples through the DAG and aggregate statistics)

### 3.3 Tests and correctness checks

**Code files to touch or extend:**

- `graph-editor/tests/test_runners.py`
- Any additional tests in `graph-editor/lib/tests/` that validate time-indexed projections and uncertainty bands

These tests should confirm that the runner integrates the fitted latency distributions as described in the design and that uncertainty summaries behave sensibly across scenarios.

---

## 4. UI Exposure of Bayesian Latency and Uncertainty

**Design reference:** `design.md §6.2`, `design.md §7.1–7.4`.

### 4.1 Edge-level uncertainty visuals

**Code files to touch or extend:**

- `graph-editor/src/components/edges/ConversionEdge.tsx`  
  (extend existing confidence-band rendering to accommodate posterior uncertainty for both probabilities and latencies)
- `graph-editor/src/lib/nodeEdgeConstants.ts`  
  (add any additional visual constants or thresholds related to posterior bands)

### 4.2 Analytics panel enhancements

**Code files to touch or extend:**

- `graph-editor/src/components/AnalyticsPanel/`  
  (add or extend charts that display posterior latency distributions and derived quantiles)

### 4.3 Documentation updates

**Code and docs to touch or extend:**

- `graph-editor/public/docs/user-guide.md`  
  (document the qualitative meaning of uncertainty bands and posterior latency summaries)
- `graph-editor/public/docs/api-reference.md`  
  (describe any additional outputs that expose Bayesian latency results)

These UI and documentation changes are restricted to presenting and explaining the modelling outputs already defined by the design and the Python inference engine.


