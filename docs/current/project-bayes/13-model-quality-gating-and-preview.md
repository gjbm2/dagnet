# Doc 13 — Model Quality Gating and Preview

**Status**: Draft
**Date**: 19-Mar-26

---

## Purpose

When a Bayes fit completes, the model may have converged poorly —
edges with `rhat > 1.05`, `ESS < 400`, high divergence counts, or
`provenance: pooled-fallback`. Today the system applies posteriors
unconditionally. This document specifies:

1. Quality signalling (progress indicator, session log, Graph Issues)
2. Auto-enable Forecast Quality view for poor fits
3. Accept/reject preview workflow before committing posteriors to files

---

## 1. Quality signalling

### 1.1 Quality tier classification

Reuse existing `bayesQualityTier.ts` tiers for per-edge classification.
For graph-level summary, derive a composite quality word from
`_bayes.quality`:

| Condition | Tier word |
|---|---|
| `converged_pct >= 90` and `max_rhat < 1.02` | **good** |
| `converged_pct >= 70` and `max_rhat < 1.05` | **fair** |
| `converged_pct >= 50` and `max_rhat < 1.10` | **poor** |
| Otherwise | **very poor** |

These thresholds are indicative and may be tuned with experience.

### 1.2 Progress indicator completion message

When the Bayes operation completes (via `operationRegistryService`),
the completion label should include the quality tier:

> "Bayes complete — 62% converged, max rhat 2.1 (**poor**)"

For good quality:

> "Bayes complete — 100% converged (**good**)"

Implementation: in `useBayesTrigger.ts`, after patch apply, read
`_bayes.quality` from the updated graph and format the completion
message with the tier word.

### 1.3 Session log

On Bayes completion, log a structured entry via `sessionLogService`:

- **Operation type**: `bayes`
- **Summary line**: same as progress indicator (tier word + metrics)
- **Detail block** (hierarchical children):
  - Per-edge breakdown for non-converged edges: edge name, rhat, ESS,
    provenance
  - Count of edges by provenance (`bayesian` vs `pooled-fallback` vs
    `point-estimate`)
  - Total divergences

On accept/reject (§3), log the decision:

- Accept: "Bayes update accepted — N edges updated, quality: {tier}"
- Reject: "Bayes update rejected"

### 1.4 Graph Issues

Add a graph issue type for low-quality Bayes fits. Issued per edge
where the posterior has `provenance === 'pooled-fallback'` or
`rhat > RHAT_THRESHOLD` (1.05).

**Issue text**: "{edge name}: Bayes model did not converge
(rhat={value}, ESS={value})"

**Severity**: warning (not error — the system falls back to prior or
analytic, so the graph is still usable).

**Lifecycle**: issue clears when a subsequent Bayes run produces a
converged posterior for that edge, or when the user manually dismisses.

**Implementation**: extend the existing graph issues infrastructure
(if present) or add to the quality overlay metadata. The issue should
reference the edge ID so clicking it navigates to the edge.

---

## 2. Auto-enable Forecast Quality view

When Bayes completes with **poor** or **very poor** quality (per §1.1),
automatically switch the analysis info card to Forecast Quality mode.
This ensures the user sees the quality overlay on the graph without
needing to know to look for it.

**Trigger**: after patch apply, if quality tier is poor or very poor.

**Behaviour**:
- Switch overlay mode to forecast-quality (edge colour-coding by tier)
- If analysis info card is open, switch its tab to Forecast

**Does not apply**: if quality is good or fair — the user doesn't need
to be interrupted.

---

## 3. Accept/reject preview workflow

### 3.1 Design intent

The user should see the Bayes result in context — on the actual graph,
with real edges colour-coded by quality tier — before the system writes
posteriors to parameter files. This allows rejecting a poor fit without
polluting fit_history or requiring file-level rollback.

### 3.2 Flow

On Bayes job completion (patch fetched from git):

1. **Save viewport state** — current zoom, pan position, selected node
2. **Zoom to fit** — show entire graph so user sees all edges
3. **Save graph history state** — checkpoint for undo on reject
4. **Apply posteriors to graph only** — update edge posterior fields in
   GraphStore (the graph-portion of `applyPatch`). Do NOT update
   parameter files. Do NOT delete the patch from git.
5. **Enter Forecast Quality mode** — switch overlay to quality tier
   colour-coding
6. **Show accept/reject modal** — lightweight, non-blocking:
   - Positioned centre-bottom of the canvas
   - No backdrop blur or darkening — the graph IS the preview
   - Contains: quality summary line (tier word + metrics), Accept
     button, Reject button
   - Optionally: brief per-edge quality breakdown (expandable)

### 3.3 User interaction during preview

**Permitted (if simple to implement)**:
- Pan and zoom (standard canvas navigation)
- Edge hover → shows forecast quality popover (existing
  PosteriorIndicator)

**Blocked**:
- All other operations are implicitly blocked by the modal being
  present (standard modal focus behaviour). The modal is not
  dismissable except via Accept or Reject.

The key insight is that because the modal doesn't blur/darken, the user
can visually inspect the graph behind it. Pan/zoom support is desirable
but not essential for MVP — if it adds complexity, the static
zoomed-to-fit view is sufficient.

### 3.4 Accept path

User clicks Accept:

1. Apply file-portion of patch — update parameter files in FileRegistry
   (mergePosteriorsIntoParam for each edge), mark dirty
2. Run the existing cascade (getParameterFromFile per edge → sync
   GraphStore → FileRegistry)
3. Delete patch file from git
4. Restore viewport state (zoom, pan, selection)
5. Exit Forecast Quality mode (return to previous overlay mode)
6. Dismiss modal
7. Session log: "Bayes update accepted — N edges updated, quality:
   {tier}"
8. Mark operation complete in operationRegistryService

### 3.5 Reject path

User clicks Reject:

1. Undo graph to pre-preview checkpoint (existing history undo)
2. Restore viewport state
3. Exit Forecast Quality mode
4. Dismiss modal
5. Delete patch file from git (the fit is discarded — user can re-run
   with different settings if desired)
6. Session log: "Bayes update rejected"
7. Mark operation complete in operationRegistryService

### 3.6 Edge cases

**Browser refresh during preview**: Graph state is lost (history not
persisted across reloads). Patch is still on git. On next session,
the system should detect the unprocessed patch and re-enter preview.
This is part of the deferred browser-closed rehydration work
(programme.md §known limitations) — not in scope for this phase.

**Multiple Bayes runs**: Only one preview at a time. If a second
Bayes job completes while a preview is active, queue it. The user
must accept or reject the current preview before seeing the next.

### 3.7 Implementation boundary

The accept/reject flow splits `applyPatch()` into two independently
callable phases:

- **Phase 1 (graph-only)**: lines 201–280 of current `applyPatch` —
  upsert `_bayes` metadata, update edge posteriors in graph document.
  Called on job completion.
- **Phase 2 (files)**: lines 177–198 of current `applyPatch` —
  update parameter files via `mergePosteriorsIntoParam`, mark dirty.
  Called on accept.

The patch file deletion (currently done immediately after fetch)
moves to accept/reject — delete on accept after file writes, delete
on reject as cleanup.

---

## 4. Implementation sequence

These items are independent of each other except where noted.

### 4.1 Quality signalling (no accept/reject dependency)

Can be built and shipped immediately. Does not require the preview
workflow.

1. Add graph-level quality tier derivation (§1.1)
2. Update completion message in `useBayesTrigger.ts` (§1.2)
3. Add session log entry on Bayes completion (§1.3)
4. Add Graph Issues for non-converged edges (§1.4)
5. Auto-enable Forecast Quality view on poor/very poor (§2)

### 4.2 Accept/reject preview (builds on §4.1)

Requires quality signalling for the modal content.

1. Split `applyPatch` into graph-only and file-only phases (§3.7)
2. Implement viewport save/restore
3. Build accept/reject modal component (§3.2, §3.6)
4. Wire flow: job completion → preview entry → accept/reject → cleanup
5. Add session log entries for accept/reject decisions (§1.3)

---

## 5. Relationship to other docs

- **Doc 9** (FE posterior consumption): covers the rendering and
  display of posteriors. This doc covers the *gating* of whether
  posteriors are applied at all.
- **Programme.md**: the accept/reject workflow is part of the posterior
  consumption workstream. Quality signalling items should be added to
  the Phase A overlay progress notes.
- **Doc 4** (async roundtrip): the patch file lifecycle changes —
  deletion moves from "immediate after fetch" to "on accept/reject".
