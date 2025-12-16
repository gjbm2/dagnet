## E/F Rendering Fix (Derived Sibling Semantics)

**Created:** 16-Dec-25  
**Status:** Design note — to be implemented after review  

---

### Purpose

In “E mode” (evidence view) and “F mode” (forecast view), the UI currently becomes semantically inconsistent when an outgoing sibling set contains a mix of edges that do and do not have explicit evidence/forecast data. This is especially visible after rebalancing, where siblings may lack an evidence block but must still participate in an evidence/forecast-based sibling PMF that sums to 1.

This document specifies a single, coherent rendering approach for:

- Edge widths (lane widths) in E/F modes
- Probability bead values (“E …” / “F …”)
- Clear signalling of derived (implied) values without changing persisted schema

This is a prose-only design record (no code).

---

### Current behaviour (problem statement)

- In **E mode**, if an edge has no evidence object/block, the UI falls back to showing **`p.mean`** (often with reduced opacity). This makes an evidential sibling set show a mixture of “observed evidence” on some edges and “mean” on others, which is conceptually confusing.
- In **F mode**, forecast handling is more consistent in practice, but there is concern that sibling forecasts may be implicitly tied to `p.mean` in a way that can also be confusing or incorrect in mixed-data situations.

The main symptom: in an outgoing sibling set where one edge has evidence, a sibling without evidence should usually display something like **\(1-e\)** (or a residual allocation), rather than the unrelated blended mean.

---

### Design goals

- **Single source of truth for E/F rendering values**: widths and beads must be driven from the same computed basis.
- **Sibling-PMF coherence**: in E and F modes, outgoing sibling sets should behave like a probability mass function (sum approximately to 1, subject to clamping rules).
- **No persisted schema change**: do not add new stored fields solely to mark derived values.
- **Transparent UI signalling**: derived values must be visibly distinguishable from directly sourced values.
- **Minimise logic duplication**: compute once and reuse everywhere that needs the basis value.

---

### Definitions

- **Sibling group**: the set of edges that compete as alternatives from the same source node, using the same grouping rules as existing rebalancing logic (including case-variant constraints where applicable).
- **Layer**: the scenario layer being rendered (current/base/scenario overlays). The authoritative values may come from different stores depending on layer.
- **Known value**: a basis value (evidence or forecast) that exists explicitly for the edge in the authoritative layer data.
- **Missing value**: no explicit basis value exists for the edge in the authoritative layer data.
- **Derived value**: a value computed solely to maintain sibling-PMF coherence in the selected view mode.

---

### Proposed behaviour (high-level)

#### 1) Evidence mode (E)

Within a sibling group for a given layer:

- If **no edge** in the sibling group has any explicit evidence value, treat the group as **non-evidential** for that layer; keep the existing “no evidence” presentation (faint rendering and bead behaviour consistent with current semantics).
- If **at least one edge** has explicit evidence in that layer:
  - Treat the sibling group as an **evidential PMF**.
  - For edges with explicit evidence: use that value as the E basis value.
  - For edges without explicit evidence: compute an **implied evidence share** by allocating the residual mass \(R\) across missing edges.

Residual allocation:

- Let \(S\) be the sum of explicit evidence values within the sibling group for that layer.
- Let \(R = \max(0, 1 - S)\).
- Allocate \(R\) across missing-evidence edges proportionally to their authoritative `p.mean` weights for that layer (the same weights that rebalancing operates on).
- If all missing edges have zero weight, fall back to an equal split of \(R\) among missing edges.

Derived signalling:

- Any E basis value produced by residual allocation is **derived** and must be displayed as such (see “UI signalling” below).

#### 2) Forecast mode (F)

Within a sibling group for a given layer:

- If at least one edge has an explicit forecast value for that layer, treat the group as a forecast PMF and allocate missing forecast residual analogously to evidence mode.
- If no explicit forecasts exist for that layer, treat the group as forecast-absent (and fall back to the current presentation rules for that mode, if any).

Note: even if forecasts are conceptually “derived”, the UI should still indicate when a displayed forecast value is derived from residual allocation rather than explicitly present in layer data.

#### 3) F+E mode

This change is scoped primarily to E and F modes (the modes where a single basis is shown). For F+E mode:

- The existing two-lane approach remains, but it must be clarified whether the inner evidence lane should use derived allocation in mixed-data sibling sets.
- Default recommendation: do not introduce derived evidence lanes in F+E unless the product intent explicitly calls for a sibling-PMF view inside the combined mode. This can be revisited after E/F are fixed.

---

### UI signalling for derived values

Derived values should be visibly distinct without needing schema additions.

- **Probability beads**:
  - Explicit values: show as `E 37%` or `F 37%` (existing style).
  - Derived values: show with brackets: `E [37%]` / `F [37%]`.
- **Edge lane rendering**:
  - Keep the existing faint-edge behaviour as a *secondary* signal, but apply it with a precise meaning:
    - “No basis exists and the sibling group is non-evidential/forecast-absent”: render using the existing fallback rules (today this tends to mean “use `p.mean` and fade it” in E mode).
    - “Sibling group is evidential/forecasted and this edge’s basis value is derived”: render a *sensible* basis-driven width (so the edge visually participates in the sibling PMF), and optionally apply a mild “derived” treatment (e.g. reduced opacity) so the user can tell “this number came from residual allocation”.
  - The key intent: **width must be coherent; opacity is only a hint**. Brackets on the bead are the primary truthfulness indicator.

The brackets are the primary “truthfulness” signal for beads; the faint style is a secondary signal for the edge itself.

---

### Sankey mode (ribbons)

Sankey view changes the geometry (filled ribbons rather than stroked paths), but it does not change the semantic requirement: in E and F modes, sibling sets should still form a coherent PMF on the chosen basis, and beads should match what the geometry implies.

How Sankey width actually works here:

- The ribbon geometry is generated directly from the **edge’s computed width** (the same value that would be used as `strokeWidth` in non-Sankey rendering), just drawn as a filled shape instead of a stroked path.
- When LAG F/E rendering is active in Sankey, the code already uses `lagLayerData.meanWidth` / `lagLayerData.evidenceWidth` to choose the ribbon width for the selected mode, and those widths are derived from the same base width.

Therefore, the requirement for this fix in Sankey is straightforward:

- Derived basis values must feed into the **same width computation** that produces `lagLayerData.*Width`, so the **ribbon width you see** in E/F modes matches the E/F basis (including derived residual allocations).
- Beads must use the same resolver so the displayed `E …` / `F …` matches the ribbon width semantics.

No special “anchor thickness” behaviour is introduced: Sankey is simply a different rendering style for the same edge width semantics.

---

### Data sourcing and “reliability” (where values come from)

This design does not require new persisted data. Instead, it relies on authoritative layer values already available at render time:

- **Sibling weights for allocation**: use `p.mean` for the relevant layer.
  - Current layer: from the graph edge’s probability.
  - Base/scenario layers: from composed layer params, with fallback to graph if absent.
- **Known evidence/forecast values**: use whichever evidence/forecast value exists in the layer’s authoritative data.

Derived values are computed at render time and carried only as UI-level metadata (e.g. “isDerived”) to drive brackets and styling.

---

### Consistency requirement: one shared resolver

To avoid beads and widths diverging, the system must have one shared way to compute basis values and derivation flags:

- A single “basis resolver” should, for a given layer and sibling group, produce:
  - the basis value per edge (evidence or forecast)
  - a flag per edge indicating whether the basis value is derived

Both of these must be consumed by:

- Edge width / lane width computation for E/F modes
- Probability bead value computation for E/F modes

---

### Where “late derivation” can be problematic (and how we avoid it)

Computing derived basis values “late” (at render time / view-projection time) should not affect any downstream graph maths, because the derived values are display-only. The real risk is **inconsistent or stale UI** if memoisation keys/dependency arrays don’t include the full set of inputs that can change derived values.

Potential pitfalls (UI correctness only):

- **Memoisation dependencies**: the derived value for one edge depends on sibling-group state. If we memoise per-edge results without a sibling-group signature (e.g. “sum of known evidence in the group” + “which edges are missing”), we can show stale derived values when a sibling’s evidence/forecast changes.
- **Multiple render paths**: if widths are computed in one place and beads in another, both must call the same resolver (or consume the same computed object), otherwise “E/F number” and “E/F width” can disagree.
- **Scenario re-composition**: derived values are layer-specific; memoisation must include the layer ID and the layer’s authoritative inputs, otherwise scenario toggles can leave stale derived flags/values.
- **Persistence boundaries**: derived values must remain view-only unless explicitly decided otherwise; they should not leak into stored graph/parameter data.

Mitigation principle: **treat derived basis values as a view-layer projection**, and route all E/F display (geometry + beads + tooltips) through the same shared resolver.

---

### Scenario layers (will this work correctly?)

Yes, provided we are explicit about two things: (1) how we identify sibling groups, and (2) which layer’s values are authoritative for the computation.

Sibling grouping:

- Sibling group membership must follow the same grouping rules as rebalancing (same source node, and case-variant constraints where applicable). This grouping is a function of the graph topology and edge identity, not of the layer.

Authoritative values by layer:

- **Sibling weights for residual allocation** come from `p.mean` of the current layer:
  - Current layer: from the live graph’s edge probability.
  - Base/scenario overlays: from the composed params for that layer, with fallback to the graph edge if absent (to ensure edges not explicitly present in params still participate).
- **Known evidence/forecast basis values** must come from the same layer’s authoritative data (composed params for overlays; current params / graph fields for current).

Key requirement:

- The resolver must run **per layer**, because “which edges have explicit evidence/forecast” can differ between scenarios. As a result, derived flags are layer-specific as well (an edge can be explicit in one scenario and derived in another).

### Edge cases and clamping rules

- **Sum of known basis values exceeds 1**:
  - Default rule: set \(R=0\) (no residual to allocate) and treat missing edges as 0 basis value (derived or absent depending on signalling policy).
  - Optional follow-up: surface a warning/diagnostic as this indicates inconsistent inputs.
- **Negative or non-numeric values**:
  - Treat as absent and do not include in \(S\).
- **All missing-edge weights are zero**:
  - Allocate residual equally among missing edges (to preserve PMF coherence).

---

### Interaction with UpdateManager rebalancing

This design intentionally separates:

- **Persisted probability rebalancing** (`p.mean`), which should remain the canonical sibling PMF constraint.
- **Display basis derivation** for evidence/forecast in E/F modes, which should not require persisted updates.

Forecast-specific note:

- If the system currently writes `p.forecast.mean` during rebalance as a fallback, ensure it does not mask the “missing forecast” case in a way that breaks the semantics above. The resolver must be able to distinguish “explicit forecast present” from “fallback forecast written only for convenience”.

---

### Forecast rebalancing policy (make it explicit)

This design assumes we **do not** “formally rebalance forecasts” as a persisted graph operation.

Concretely:

- We continue to **formally rebalance only `p.mean`** (the canonical sibling PMF that the graph stores).
- In F mode, the forecast values shown for siblings (including residual \(1-\sum f\) allocations) are treated as a **view-layer projection** computed by the shared resolver.
- Therefore, we should **not rely on UpdateManager rebalance to write forecast values** (e.g. `p.forecast.mean = p.mean`) as the mechanism for sibling forecast coherence.

Implication for implementation:

- Audit `UpdateManager` logic that currently writes `p.forecast.mean` during rebalancing of `p.mean`.
- Decide one of:
  - Stop writing `p.forecast.mean` in rebalance entirely (preferred, to avoid conflating “forecast basis” with “mean basis”).
  - Or constrain it to a narrow fallback-only case where it cannot be mistaken for an explicit forecast (requires a reliable discriminant, otherwise it will confuse the resolver).

Either way, the **source of truth for F-mode sibling forecasts is the resolver**, not persisted rebalance side-effects.

---

### Implementation plan (code sites and changes)

This section identifies the concrete code sites that must be updated so that:

- E/F basis values are computed once (shared resolver)
- Edge widths and probability beads consume the same basis and derived flags
- Sankey and non-Sankey rendering remain consistent (Sankey is just a different style)

No code is included here; this is an execution map only.

#### 1) Introduce a shared E/F basis resolver (new module)

Create a new shared helper module in one place that both the edge rendering pipeline and bead construction can call. Candidate locations:

- `graph-editor/src/services/` (preferred if we want this treated as business logic)
- or `graph-editor/src/lib/` (acceptable if treated as a pure deterministic computation)

Responsibilities:

- Given a graph + a layer’s authoritative params, compute sibling groups using the same grouping rules as rebalancing.
- For a given mode (E or F) compute, per edge in the sibling group:
  - the **basis value** used for display (explicit or derived)
  - whether it is **derived**
  - any per-edge precomputations needed by rendering (e.g. ratios/clamps used by width computation)
- Provide outputs in a form that is stable for memoisation (e.g. a per-group signature).

#### 2) Wire the resolver into the main edge rendering pipeline

Primary site:

- `graph-editor/src/components/canvas/buildScenarioRenderEdges.ts`

Changes:

- Before building `EdgeLatencyDisplay` for a given layer, compute the sibling-group basis outputs for that layer (E and F).
- Use resolver outputs to populate UI-only fields on the per-edge display structure for that layer (see next section).
- Ensure the width decisions in E/F modes use the resolver’s basis values for edges missing explicit evidence/forecast when the sibling set is evidential/forecasted.

Why here:

- This file already computes and attaches `edgeLatencyDisplay` to each rendered edge’s `data`, and it already performs per-layer work (which is required for scenario correctness).

#### 3) Extend the UI-only `EdgeLatencyDisplay` to carry derived metadata

Primary site:

- `graph-editor/src/types/index.ts` (`EdgeLatencyDisplay`)

Add fields (UI-only) so `ConversionEdge` can render correctly without recomputing:

- Basis values actually used for E and F display (explicit or derived)
- Derived flags for E and F (so E/F ribbons and/or opacity rules can reflect “derived”)
- Any “basis signature” needed to ensure memoised computations re-run when sibling context changes

Constraint:

- This must remain UI-only; do not write these fields back to persisted graph data or parameter packs.

#### 4) Update `ConversionEdge` to consume the precomputed display data (no new derivation in UI)

Primary site:

- `graph-editor/src/components/edges/ConversionEdge.tsx`

Changes:

- Ensure Sankey and non-Sankey LAG rendering uses the updated `edgeLatencyDisplay` values/widths/flags.
- Do not add any sibling-derivation logic here; `ConversionEdge` should only interpret precomputed decisions.
- Confirm that memoised computations are keyed off the updated `data.edgeLatencyDisplay` such that changes in sibling context (and therefore derived values) trigger re-rendering.

Note:

- Sankey ribbons already use `lagLayerData.*Width` and `edgeLatencyDisplay.useNoEvidenceOpacity`. The plan is to keep that structure but ensure the values reflect derived basis when required.

#### 5) Update probability bead construction to use the same resolver outputs (and show brackets)

Primary sites:

- `graph-editor/src/components/edges/edgeBeadHelpers.tsx`
- `graph-editor/src/components/edges/BeadLabelBuilder.tsx`
- `graph-editor/src/components/edges/EdgeBeads.tsx` (rendering of the text produced by the builder)

Changes:

- Replace ad-hoc “pick evidence/forecast/mean” logic for E/F modes with calls to the shared resolver, so the bead’s E/F value matches what widths/ribbons represent.
- Extend the bead value model to carry whether the value is derived, so the formatter can render brackets (`[ ]`) without hacking the numeric value.
- Ensure derived brackets are applied consistently for both evidence and forecast.

Scenario correctness note:

- Beads display values across multiple visible layers; the resolver must be invoked per layer (base/current/scenario) using that layer’s authoritative inputs.

#### 6) Update memoisation/dependency signatures (prevent stale derived values)

Primary sites to audit:

- `graph-editor/src/components/canvas/buildScenarioRenderEdges.ts` (per-layer computation)
- `graph-editor/src/components/edges/ConversionEdge.tsx` (useMemo dependencies that consume `edgeLatencyDisplay`)
- `graph-editor/src/components/edges/EdgeBeads.tsx` and `edgeBeadHelpers.tsx` (memoised bead definitions)

Goal:

- Derived values depend on sibling-group state, so ensure the computed objects that carry derived basis values change when any sibling’s relevant inputs change (evidence/forecast presence or value, and `p.mean` weights used for allocation).

Implementation constraint:

- Prefer a compact “basis signature” (computed once per sibling group) rather than expanding dependency arrays to include large serialised blobs.

#### 7) Tests to add (no test edits assumed)

Add new focused tests in:

- `graph-editor/src/components/edges/__tests__/` for bead rendering behaviour (derived brackets, per-layer differences)
- `graph-editor/src/components/canvas/` test area (or a new focused integration-style test) for width semantics in E/F modes, including Sankey style if that path is testable without a browser

Test scenarios should mirror the “Test plan” section above, plus:

- A case where only one scenario layer has explicit evidence (derived applies only in that layer)
- A case where derived basis changes when a sibling’s evidence toggles on/off (ensures memoisation is correct)

---

### Test plan (scenarios to cover)

Add/extend tests to cover the following behaviour end-to-end for both widths and beads:

- **Two-sibling evidential set**: one edge has explicit evidence \(e\), sibling missing evidence shows derived \(1-e\) and brackets.
- **Three-sibling evidential set**: two edges have explicit evidence, third missing; residual allocation by `p.mean` weights.
- **Non-evidential set**: no edges have evidence; E mode falls back to current non-evidential behaviour (no derived brackets).
- **Forecast sets**: analogous cases for forecast mode, including mixed explicit/missing forecasts.
- **Overfull evidence**: known evidence sums > 1; residual is 0 and missing edges show 0 (derived signalling policy applied).
- **Zero-weight missing edges**: residual split evenly.

---

### Non-goals

- Changing persisted graph schema for evidence/forecast fields solely to support UI rendering.
- Altering the semantics of `p.mean` rebalancing.
- Changing scenario composition logic beyond what is required to ensure consistent inputs to the resolver.

---

### Rollout notes

- Implement as a contained change in the rendering pipeline with a shared resolver feeding both beads and widths.
- Add targeted tests before enabling any broader refactors.
- Validate on known problematic graphs (rebalanced siblings in E mode) and ensure the bracket signalling is consistently applied.


