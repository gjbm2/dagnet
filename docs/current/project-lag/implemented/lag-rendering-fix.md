## LAG Rendering Refactor – Single Code Path (E / F / F+E, Sankey, CI)

### 0. Goals and Non‑Goals

**Goals**

- Replace the current split rendering logic for edges with a **single LAG‑aware code path** that:
  - Drives **all** probability visual modes: **E**, **F**, **F+E**.
  - Covers both **standard** edges and **Sankey** ribbons.
  - Incorporates **confidence intervals** as a visual overlay on top of the same probability semantics.
  - Correctly handles:
    - `p.mean` (blended probability lane).
    - `p.evidence.mean` (observed lane).
    - `p.forecast.mean` (forecast lane).
    - Latency: `p.latency.{median_lag_days, completeness, t95, path_t95}`.

- Eliminate the legacy “plain” rendering path that:
  - Knows nothing about evidence vs forecast.
  - Uses `effectiveWeight === 0` as the only gate for dashed styling.
  - Ignores `NO_EVIDENCE_E_MODE_OPACITY` and the LAG semantics.

- Make behaviour **predictable and testable**:
  - Any given edge in E / F / F+E view follows the **same logic**, regardless of whether Sankey / CI is enabled.
  - Styling for pathological cases (no evidence, zero evidence, no forecast) is handled consistently.

**Non‑Goals**

- Do **not** change the underlying **LAG statistics** or blending formulae (that is already centralised and tested).
- Do **not** change DSL or query semantics.
- Do **not** change how `p.mean`, `p.evidence`, `p.forecast`, or latency values are computed or persisted.
  - Only how they are **mapped to visuals**.


### 1. Current Situation (Problems)

#### 1.1 Two Competing Rendering Paths

**Path A – LAG‑Aware Rendering (Desired)**

- Triggered when:
  - LAG data is present via `edgeLatencyDisplay` (i.e. `buildScenarioRenderEdges` populated it), and
  - We are **not** in CI mode, and
  - We are **not** in “plain” Sankey mode.
- Uses a dedicated data object (currently `EdgeLatencyDisplay` + `lagLayerData`) to drive:
  - Which lane(s) to show (E / F / F+E).
  - How wide each lane is (evidence vs forecast vs blended mean).
  - Where to place latency beads and completeness chevrons.
- Obeys the LAG design semantics for:
  - `p.evidence.mean = Σk/Σn` (query evidence).
  - `p.forecast.mean` (window baseline / LAG p∞).
  - `p.mean` (forecast lane, pure forecast or blended).

**Path B – Legacy / Plain Rendering (Undesired for E/F/F+E)**

- Triggered when **any** of the following is true:
  - `edgeLatencyDisplay` is absent for this edge/layer.
  - Confidence interval view is active.
  - Sankey ribbons are active (non‑F/E aware mode).

- Uses only:
  - `effectiveWeight` (flow from entry node) to decide dashing (dashed when flow = 0).
  - `data.strokeOpacity` or a hardcoded literal for opacity.

- Deficiencies:
  - Does **not** inspect `p.evidence` or `p.forecast` at all.
  - Does **not** know about `NO_EVIDENCE_E_MODE_OPACITY`.
  - In E mode, cannot distinguish:
    - **No evidence block** vs
    - **Evidence block with `mean = 0`**.
  - Leads to inconsistent behaviour:
    - Edges like `switch-registered-to-switch-success` in E mode show as “normal flow” (solid, non‑dashed) even when `p.evidence.mean = 0` and completeness \< 1.
    - Rebalanced edges with no `p.evidence` block ignore `NO_EVIDENCE_E_MODE_OPACITY` in some views.


### 2. Target Model – Single LAG Rendering Pipeline

We want **ONE** conceptual pipeline for edge visualisation, with the following responsibilities:

1. **Data assembly (per edge, per layer)** – a single function builds a **render model** from graph + params:
   - Input: `graphEdge`, composed scenario params (`edgeParams.p`), viewer mode (E / F / F+E), and LAG statistics.
   - Output: a canonical object (call it **`EdgeLagRenderModel`**) containing:
     - Probabilities:
       - `mean` (blended / p.mean).
       - `evidence` (p.evidence.mean or `undefined`).
       - `forecast` (p.forecast.mean or `undefined`).
     - Latency:
       - `median_days`, `completeness_pct`, `t95`.
     - Derived booleans and style hints:
       - `hasEvidence` – `true` when `evidence` is a number.
       - `evidenceIsZero` – `true` when `hasEvidence` and `evidence === 0`.
       - `hasForecast` – `true` when `forecast` is a number.
       - `hasLatency` – `true` when `median_days` or `t95` or `completeness_pct` is present.
       - `mode` – `'e' | 'f' | 'f+e'` (final, after scenario visibility + data availability).
       - **Latency bead policy (by query mode and edge type):**
         - In **window() mode**:
           - Show latency beads only for edges with local latency configuration (`maturity_days` / `t95` on the edge).
           - Suppress beads on non‑latency edges, even if completeness can be inferred from upstream path lag; an instantaneous edge in pure window view should not look like it has its own lag.
         - In **cohort() mode**:
           - For edges with local latency config, show beads with both completeness and median‑lag (existing behaviour).
           - For edges that have no local latency but are downstream of lagged paths (path_t95 > 0):
             - Completeness is still meaningful (fraction of expected conversions that have arrived), even though the edge itself completes instantaneously.
             - Show beads for these edges with **completeness only** (no median‑lag label), so the user sees maturity without implying edge‑local lag.

2. **Geometry computation** – from `EdgeLagRenderModel`, derive:
   - For **standard edges**:
     - `evidenceWidth`, `forecastWidth`, `anchorWidth` (and how they relate to `p.mean`).
   - For **Sankey**:
     - Outer ribbon path (forecast), inner ribbon path (evidence), completeness marker location.
   - For **CI mode**:
     - Upper/middle/lower band widths and opacities as FUNCTIONS of the same `mean` / `evidence` semantics (i.e. CI is a specialisation, not a separate world).

3. **Styling decisions** (dashes, opacity, beads):
   - `p.evidence.mean === 0` → **dashed** just like `p.mean = 0` (but only in E‑driven views).
   - `p.evidence` **missing** but `p.mean > 0` → full‑flow but **reduced opacity**, using `NO_EVIDENCE_E_MODE_OPACITY`.
   - Latency bead and completeness chevron:
     - Presence and geometry driven strictly by latency fields (`median_lag_days`, `completeness_pct`, `t95`), not by the existence of path_t95 branches in rendering.

4. **Rendering specialisations**:
   - **Standard LAG edges** – stroked paths, stripes for forecast, solid for evidence, anchor for `p.mean`.
   - **Sankey LAG edges** – filled ribbons (outer forecast, inner evidence), but using **the same `EdgeLagRenderModel`** and the same E/F/F+E semantics for widths/opacities/dashes.
   - **CI view** – replaces striping with CI bands **but retains** the same decisions about:
     - Whether this edge is “evidence‑zero but forecast>0”.
     - Whether we are in E / F / F+E from the user’s perspective.

In this target model, there is **no separate “plain” path** for E/F/F+E. All such rendering goes through the LAG pipeline. Plain paths remain **only** for:

- Edges that truly have **no p.latency and no LAG data** and no desire for E/F/F+E semantics.
  - This should not be the case in LAG workspaces once initialisation is complete.


### 3. Refactor Plan (Step‑by‑Step)

#### 3.1 Define a Canonical Render Model (Type‑Level, No Logic Yet)

In prose:

- Introduce a single conceptual type (name: **`EdgeLagRenderModel`**) whose responsibility is to capture everything the renderer needs for LAG/E/F/F+E/Sankey/CI, including:
  - **Raw fields (canonical):**
    - `mean` – derived from `p.mean` on the graph (blended or evidence).
    - `evidence` – derived from `p.evidence.mean` when present; `undefined` otherwise.
    - `forecast` – derived from `p.forecast.mean` when present; `undefined` otherwise.
    - `latency` – `{ median_days?: number, completeness_pct?: number, t95?: number }` from `p.latency`.
  - **Derived, pre‑render semantics:**
    - `hasEvidence` – `true` when `evidence` is a number.
    - `evidenceIsZero` – `true` when `hasEvidence` and `evidence === 0`.
    - `hasForecast` – `true` when `forecast` is a number.
    - `hasLatency` – `true` when `median_days` or `t95` or `completeness_pct` is present.
    - `mode` – `'e' | 'f' | 'f+e'` after combining:
      - User’s scenario visibility mode (E / F / F+E).
      - Actual availability of evidence/forecast for this edge.
        - E with no evidence but forecast present → degrade to an **E‑mode + “no evidence”** styling (faint or dashed as per rules).
        - F with no forecast but evidence present → degrade gracefully or mark as not supported (explicit decision required).

This render model should be **constructed in one place** (see 3.2), and then handed down to all edge renderers, including Sankey and CI.


#### 3.2 Single Builder Function – From Graph + Params → `EdgeLagRenderModel`

In prose:

- Replace ad‑hoc construction of `EdgeLatencyDisplay` + `lagLayerData` scattered across `buildScenarioRenderEdges` and `ConversionEdge` with a **single builder** in `buildScenarioRenderEdges` that:

1. Looks up `graphEdge` and `edgeParams` (as today).
2. Extracts `baseP` (from graph) and `scenarioProb` (composed params).
3. Applies the agreed precedence for raw fields:
   - Evidence:
     - Prefer scenario override `scenarioProb.evidence.mean` when present.
     - Else fall back to `baseP.evidence.mean`.
     - Else `undefined` (no evidence block).
   - Forecast:
     - Prefer scenario override `scenarioProb.forecast.mean` when present.
     - Else fall back to `baseP.forecast.mean`.
     - Else `undefined` (no forecast baseline).
   - Mean:
     - Prefer scenario override `scenarioProb.mean` when present.
     - Else `baseP.mean`.
4. Extracts latency fields from scenario override first, then base:
   - `median_days`, `completeness_pct`, `t95` from `p.latency`.
5. Computes derived booleans (`hasEvidence`, `evidenceIsZero`, `hasForecast`, `hasLatency`).
6. Combines this with **scenario visibility mode** (E/F/F+E) to produce a final `mode`:
   - E mode:
     - If `hasEvidence`:
       - Use evidence lane directly, with special styling when `evidenceIsZero`.
     - If **no evidence block at all** (for example rebalanced edges) but `mean > 0`:
       - E‑mode “no evidence” semantics:
         - Use `mean` as the probability for width and labels (not `forecast`), because there is no separate evidence lane to distinguish from forecast.
         - Render with reduced opacity using `NO_EVIDENCE_E_MODE_OPACITY` to signal “modelled but not yet evidenced”.
     - If neither evidence nor forecast:
       - Edge is effectively un‑renderable in E mode; may show as dashed with zero width or fade out completely.
   - F mode:
     - Equivalent reasoning but for forecast; decide behaviour when forecast missing but evidence present.
   - F+E mode:
     - Combine both lanes; treat `evidenceIsZero` as 0‑width evidence but still show forecast lane and completeness chevrons.

- The builder assigns this `EdgeLagRenderModel` to **every edge in every layer**, not just “latency” edges, so there is no “non‑LAG workspace” concept in rendering code.


#### 3.3 Collapse All Edge Drawing into the Single Pipeline

In prose:

- In `ConversionEdge`, switch to a **single entry point** for drawing:
  - Accept or compute `EdgeLagRenderModel` for the edge (current layer).
  - Based on `renderModel.mode` and viewer toggles:
    - **Standard (non‑Sankey, non‑CI):**
      - Compute evidence/forecast/anchor widths from `renderModel` only.
      - Apply dashing/opacity rules:
        - `renderModel.evidenceIsZero` in E or F+E mode → dashed like `p.mean = 0`, with 0‑width evidence lane but still drawn anchor and completeness chevron.
        - `!renderModel.hasEvidence && renderModel.mean > 0` in E mode → full‑flow but multiplied by `NO_EVIDENCE_E_MODE_OPACITY`.
      - Draw:
        - Anchor path (mean) as base interaction path.
        - Forecast stripes (F/F+E) and evidence stripe/solid (E/F+E) as overlays.
        - Completeness chevron and latency bead driven only by `renderModel.latency`.
    - **Sankey mode:**
      - Use the same `renderModel` to derive:
        - Outer ribbon width (forecast or mean) and inner ribbon width (evidence).
        - Sankey completeness line and bead placement, computed from the same `completeness_pct` and `median_days`.
      - Keep CI and E/F toggles applying to the same underlying lanes; Sankey is purely a **geometry specialisation**, not a semantic branch.
    - **CI mode:**
      - Continue to compute CI bands (upper/middle/lower widths/opacity), but:
        - Attach them to the same `renderModel.mean` lane.
        - Honour E/F/F+E mode when deciding stripe overlays vs solid (or when to show bands vs lanes).
      - Any special behaviour for `evidenceIsZero` or “no evidence block” should still derive from `renderModel`; CI does **not** get its own dash/opacity rules.

- Delete or inline all legacy “plain probability” branches that:
  - Decide dashes exclusively from `effectiveWeight === 0`.
  - Ignore `p.evidence`, `p.forecast`, and latency fields.


#### 3.4 Remove / Migrate Legacy Flags and Literals

In prose:

- Audit `ConversionEdge` and related components for:
  - Any **hardcoded opacity literals** related to “no evidence” or “hidden current”.
  - Any **dash decisions** that rely solely on `effectiveWeight` and not on the render model.
  - Any separate “Sankey F/E” logic that bypasses the LAG render model.

- Migrate:
  - All “no evidence” opacity logic to use `NO_EVIDENCE_E_MODE_OPACITY` from `nodeEdgeConstants` and the `renderModel.hasEvidence` flag.
  - All dash logic to use either:
    - `renderModel.evidenceIsZero` in E/F+E modes, or
    - `renderModel.mean === 0` when genuinely no flow at this edge (e.g. unreachable in the graph).
  - `HIDDEN_CURRENT_OPACITY` should remain a **separate concern** about hidden current layer visibility, orthogonal to evidence semantics.


### 4. Testing and Verification Plan

All tests should be updated or added under the existing testing structure (`src/components/**/__tests__` and `src/services/**/__tests__`), but described here in English only.

**Scenarios to cover:**

1. **Latency edge with both forecast and evidence:**
   - E mode:
     - Non‑zero evidence → solid edge at evidence width, anchor at mean width, completeness chevron visible when completeness \< 1.
     - Evidence exactly zero (k=0) but forecast present → anchor dashed, evidence lane 0‑width, completeness chevron visible at fractional completeness.
   - F mode:
     - Forecast lane rendered, independent of evidence; no evidence stripe.
   - F+E mode:
     - Forecast outer lane + inner evidence lane with correct widths; evidence lane collapses to 0‑width when evidence=0.

2. **Non‑latency edge with forecast only (no `p.latency` but has `p.forecast`):**
   - E mode:
     - No evidence block → faint full‑width edge using `NO_EVIDENCE_E_MODE_OPACITY`, no completeness chevron.
   - F mode:
     - Forecast lane rendered; no changes from current design except code path simplification.

3. **Rebalanced edges (no evidence block, p.mean > 0):**
   - In E mode, _always_ rendered via LAG pipeline:
     - Full‑width faint edge (opacity driven by `NO_EVIDENCE_E_MODE_OPACITY`).
     - No completeness chevron or latency bead unless latency has been configured.
   - In F/F+E modes, same behaviour as other edges with the same `p.mean` / `p.forecast`.

4. **Sankey mode:**
   - Ensure that toggling between E / F / F+E:
     - Modifies outer vs inner ribbon widths consistent with `renderModel`.
     - Keeps the completeness line exact with the non‑Sankey anchor chevron.
   - Ensure zero‑evidence edges in E mode behave visually like “p.mean=0” edges in Sankey (dashed or 0‑width inner ribbon as per the agreed visual language).

5. **Confidence interval mode:**
   - Verify CI bands render for the same set of edges that would normally use LAG rendering in F/F+E/E.
   - Verify that enabling/disabling CI does **not** change E/F/F+E semantics for:
     - When edges become dashed.
     - When `NO_EVIDENCE_E_MODE_OPACITY` kicks in.
     - Where completeness chevrons and beads appear.


### 5. Migration and Rollout

**Implementation sequencing:**

1. Introduce `EdgeLagRenderModel` concept and builder in `buildScenarioRenderEdges` **in parallel** with existing `EdgeLatencyDisplay`, but have the builder populate both from the same source of truth.
2. Incrementally refactor `ConversionEdge` to:
   - First, consume `EdgeLagRenderModel` to drive the existing LAG path.
   - Then, fold CI and Sankey branches into the same decision logic.
3. Once tests confirm parity for all modes (E/F/F+E/Sankey/CI), remove:
   - Legacy dash/opacity decisions that are based solely on `effectiveWeight`.
   - Any redundant LAG vs non‑LAG toggles that no longer serve a purpose.

**Risk mitigation:**

- Keep changes behind an internal feature flag (e.g. `LAG_UNIFIED_RENDER`), toggled in configuration for early validation on selected workspaces.
- Provide a temporary debug overlay or logging option to print `EdgeLagRenderModel` for a specific edge (e.g. via devtools command) to manually verify behaviour on complex flows like `switch-registered-to-switch-success`.


### 6. Summary

- The current split between a LAG‑aware rendering path and a legacy “plain” path is the root cause of inconsistent behaviour in E/F/F+E modes, particularly for:
  - Edges with `p.evidence.mean = 0` but non‑zero forecast.
  - Edges with no evidence block but non‑zero `p.mean` (rebalanced edges).

- The refactor defined here:
  - Introduces a **single canonical render model** (`EdgeLagRenderModel`) governed by LAG semantics.
  - Routes **all** E/F/F+E behaviour (including Sankey and CI) through this model.
  - Uses `NO_EVIDENCE_E_MODE_OPACITY` and `evidenceIsZero` in a uniform way to control dashing and opacity.

- After this change, there is effectively **one code path** for probability rendering; differences between standard, Sankey, and CI views are purely **geometry and overlay** specialisations, not separate probability semantics.


