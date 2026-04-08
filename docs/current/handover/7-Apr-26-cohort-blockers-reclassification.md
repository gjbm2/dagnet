# Handover: Cohort Blockers Reclassification & Fallback Anchor Fix

**Date**: 7-Apr-26
**Branch**: `feature/snapshot-db-phase0`

---

## Objective

The user authored `docs/current/project-bayes/29-generalised-forecast-engine-design.md` — a design for generalising the cohort maturity forecast engine to serve multiple consumers (cohort maturity, surprise gauge, edge cards, overlays) through a shared forecast-state contract, and extending cohort maturity to work across multi-hop A→Z paths (not just single edges).

The design doc identified 6 "remaining cohort() blockers". The user challenged whether these were genuinely blockers or merely potential enhancements. The session's goal was to:

1. Assess each item as **required vs desired**
2. Fix the one that was a genuine bug (#4 — fallback path missing `anchor_node_id`)
3. Document all 5 remaining items with proper pros/cons reasoning so future decisions can be made carefully

The underlying constraint: **do not let "the maths could be better" paralyse shipping**. Phase A (A→Z multi-hop maturity) and the forecast-state contract design can proceed without resolving any of the 5 remaining items.

---

## Current State

| Item | Status |
|------|--------|
| **#4 fix** (fallback anchor_node_id) | DONE — code change + tests passing |
| **INDEX.md reclassification** | DONE — all 5 items have full pros/cons |
| **cohort-maturity-full-bayes-design.md §11** | DONE — §11.2 marked RESOLVED, §11.8 updated |
| **29-generalised-forecast-engine-design.md Step 4** | DONE — reframed as known approximations |
| **Design notes for items 2 & 3** | NOT STARTED — identified as gaps needing short design notes before anyone attempts implementation |
| **Phase A implementation** (A→Z maturity) | NOT STARTED — design is in the doc, ready to begin |

---

## Key Decisions & Rationale

### All 6 items reclassified from "blockers" to "known approximations / enhancements"

- **What**: The INDEX.md section previously titled "Remaining specific cohort() blockers" is now "Known approximations and potential enhancements". The 29-design-doc's "Still true, and still blocking reuse" is now "Known approximations".
- **Why**: The user identified that framing these as blockers conflated "the maths could be better" with "the current approach is wrong". Analysis showed that none produce visibly wrong results for current use cases. Treating them as blockers risks paralysing the project — particularly Phase A (A→Z maturity) which has no dependency on any of them.
- **Where**: `docs/current/project-bayes/cohort-maturity/INDEX.md` lines 81–210 (approx), `docs/current/project-bayes/29-generalised-forecast-engine-design.md` Step 4 section.

### Item #4 was the only genuine bug — fixed immediately

- **What**: The no-Bayes fallback path in `api_handlers.py` called `compute_cohort_maturity_rows()` without resolving `anchor_node_id`. The primary Bayes path (lines 1784–1796) already did this resolution.
- **Why**: This was a simple omission, not a design trade-off. Without it, cohort-mode reach computation in degraded mode (no Bayes params available) could use a wrong anchor, producing incorrect denominator values.
- **Where**: `graph-editor/lib/api_handlers.py` lines 1869–1895 (approx) — added the same `compute_anchor_node_id()` resolution pattern used by the primary path.

### Two items need design notes before anyone attempts them

- **What**: Items 2 (probability-basis mismatch) and 3 (Y_C convolution) are identified as needing short design notes with options and trade-offs before implementation.
- **Why**: Item 2 is flagged as an inconsistency but no resolution options are documented — should both sides use graph-path probability? Posterior basis? A hybrid? Item 3 has the problem well-described but the correct formulation (`Y_C(τ) = ∫ dX_C(t') × p × CDF(τ - t')`) is not worked through to an implementable discrete form.
- **Where**: Noted in the verdict sections of INDEX.md items 2 and 3.

### The 5 remaining items have natural groupings for when to address them

- **Items 1, 2, 5** (propagation engine, basis mismatch, epoch orchestration) are companions — best done together as part of the generalised forecast engine (Phases 2–4).
- **Item 3** (Y_C convolution) is independent mathematical work that can be done any time.
- **Item 4** (frontier semantics) is only relevant when the shared forecast-state contract is actively being designed (Phase 0).

---

## Discoveries & Gotchas

- **The anchor resolution logic sits inside the `if model_params and result:` guard** (line 1432 of `api_handlers.py`). The fallback path fires when `model_params` is falsy. This means you can't simply "move the anchor resolution earlier" without also moving the `is_window` detection — the fallback has its own `_is_win` check at line 1872. The cleanest fix was duplicating the anchor resolution in the fallback rather than refactoring the guard structure.

- **The `is_window` detection differs between the two paths**: the primary path uses slice key inspection (`has_window_slice`/`has_cohort_slice` at lines 1437–1443), the fallback uses a simple string check on `query_dsl` (line 1872). This is a minor inconsistency but not worth fixing now — the fallback only fires when there are no Bayes params, which is already a degraded mode.

---

## Relevant Files

### Backend (changed)
- `graph-editor/lib/api_handlers.py` — Main handler; lines 1869–1895 contain the fixed fallback path with anchor resolution

### Backend (read for context)
- `graph-editor/lib/runner/cohort_forecast.py` — Core forecast computation; `compute_cohort_maturity_rows()` signature at line 321 already accepts optional `anchor_node_id`
- `graph-editor/lib/msmdc.py` — Contains `compute_anchor_node_id()` used by both paths

### Docs (changed)
- `docs/current/project-bayes/cohort-maturity/INDEX.md` — Master index; lines 81+ now contain full pros/cons for all 5 items
- `docs/current/project-bayes/cohort-maturity/cohort-maturity-full-bayes-design.md` — §11.2 marked RESOLVED, §11.8 summary updated
- `docs/current/project-bayes/29-generalised-forecast-engine-design.md` — Step 4 reframed; item 5 struck through as resolved

### Docs (read for context)
- `docs/current/project-bayes/cohort-maturity/cohort-backend-propagation-engine-design.md` — 32KB design for the propagation engine (item 1)
- `docs/current/project-bayes/cohort-maturity/cohort-x-per-date-estimation.md` — Options 1/1b/2 for x(s,τ) estimation
- `docs/current/codebase/DATE_MODEL_COHORT_MATURITY.md` — Canonical reference for frontier/epoch concepts

### Tests (run, not changed)
- `graph-editor/lib/tests/test_cohort_forecast.py` — 38 tests, all passing
- `graph-editor/lib/tests/test_cohort_fan_harness.py` — 39 tests, all passing

---

## Next Steps

1. **Write a short design note for item 2 (probability-basis mismatch)** — document the resolution options (both use graph-path p? both use posterior? hybrid with explicit conversion?) with trade-offs for each. This is a prerequisite for anyone attempting the fix. Suggested location: a new section in `cohort-x-per-date-estimation.md` or a standalone note.

2. **Write a mathematical design note for item 3 (Y_C convolution)** — work through the discretised form of `Y_C(τ) = ∫ dX_C(t') × p × CDF(τ - t')` to an implementable formula. Consider whether a closed-form exists for the shifted-lognormal or whether numerical integration on the existing tau grid is sufficient. Suggested location: new section in `cohort-maturity-full-bayes-design.md` §7.5 or standalone note.

3. **Begin Phase A implementation (A→Z multi-hop maturity)** — the design is complete in `29-generalised-forecast-engine-design.md` §"Generalised Cohort Maturity (A→Z Traversal)". Start with Steps A.0–A.2 (additive fields + two pure functions). None of the 5 remaining items block this work. **Sequencing choice**: if docs 30+31 land first, Steps A.0 and A.6 are eliminated (BE resolves path natively from DSL) but regime coherence check is required — see doc 29 §"Post-doc-31 variant". If Phase A goes first, use `from_node_uuid`/`to_node_uuid` patch (replaced later).

4. **Complexity assessment for Phase A is available** in this conversation: roughly 1 week of implementation total, with the main risk being frame join alignment on `(anchor_day, snapshot_date)` between first-edge and last-edge frames.

5. **Docs 30+31 (regime selection + BE subject resolution)** — **IMPLEMENTED 8-Apr-26**. Doc 30 prevents double-counting across context dimensions. Doc 31 moves DSL resolution to BE. Post-doc-31 variant is now the active Phase A path: Steps A.0/A.6 eliminated, BE resolves path natively. CLI analyse tooling available for cohort maturity testing during development (`graph-ops/scripts/analyse.sh --type cohort_maturity`). Programme doc updated with both.

---

## Open Questions

- **Should items 1+2+5 be treated as a single project?** They're natural companions (propagation engine, basis consistency, epoch unification). Doing them together avoids rework but makes the project larger. **Non-blocking** — Phase A proceeds regardless.

- **Is the Y_C convolution (item 3) worth the complexity?** The empirical evidence (§7.5 of the full-bayes design doc) suggests the current approximation works well in practice. The correct formulation may add meaningful complexity for marginal accuracy gain. **Non-blocking** — needs the mathematical design note (next step 2) before this can be properly evaluated.

- ~~**Phase A before or after docs 30+31?**~~ **RESOLVED 8-Apr-26** — docs 30+31 implemented. Post-doc-31 variant is the active path. No throwaway patch fields needed.
