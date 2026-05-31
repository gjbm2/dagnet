# CF Refactor Trackers

**Status**: Active reference, 12-May-26
**Scope**: index of the in-flight design-doc trackers in `docs/current/` (NOT in `docs/current/codebase/`) that the CF machinery code cites by `§`-number. The codebase-reference docs are stable; the trackers are live design memory of refactors that are partly landed and partly outstanding.

A CF code comment that says "see `docs/current/cohort-1apr-falling-k-problem-statement.md` §A.4" is referencing one of these. This index resolves the references — what each tracker decides, what's still open, when it was active.

The substrate's design contract is captured in the codebase docs ([CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md), [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md), [CF_RESIDUAL_GUARD.md](CF_RESIDUAL_GUARD.md), [DRAW_FAMILY_KEYING.md](DRAW_FAMILY_KEYING.md), [INVARIANTS.md](INVARIANTS.md) I-45/46/47/48). The trackers below record decisions made during the substrate refactor that are still actively being resolved — they are working documents, not the authoritative reference.

---

## The active trackers

### `cf-defensive-coding-audit.md` — 12-May-26

The 21-finding defensive-code audit ([source](../project-generalise/cf-defensive-coding-audit.md)). Executive summary: [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md). Source for [INVARIANTS.md](INVARIANTS.md) I-47 / I-48.

| Decides | Open |
|---|---|
| H-1 through H-7 (HIGH-severity defensive patterns); M-1 through M-9 (MEDIUM); L-1 through L-5 (LOW); F-1 through F-5 (parallel code paths). Each finding has location, category, "why it corrupts", remediation. | None of the HIGH findings remediated yet. Priority order: H-5 → H-2 → H-1 → H-7 → H-6. |

### `cohort-1apr-falling-k-problem-statement.md`

The dual-prefix object design (§A.1, §A.3, §A.4, §A.6). These were the `_SelectedSourceDayMass` / `_CarrierOnlyDenominatorPrefix` / `_RateAttributedSubjectPrefix` classes in `cohort_forecast_v3.py`; that quadrature-prefix family was deleted at Stage 4 Atom 4.2 and bucket-K placement is now owned by the empirical operator (`runner/bucket_transition.py`). The §A invariants the tracker decided still hold; the classes that once carried them are gone.

| Decides | Open |
|---|---|
| `M_select(U, C, u) = N_cohort(C) × g_{A→U}[u − C]` for every subject primitive source node U (§A.1); reach-preserving density-form mass semantics (§A.3); seam invariant — reducer and row builder must read the same prefix object (§A.4); M_select is a runtime-resolved object, not projection-layer (§A.6 phase 1); midpoint shift compensates for bucket-day integration (§A.6 phase 6 — no display-layer Y ≤ X cap). | F-1 unification (extract one mass-first reducer interface across funnel/daily/maturity/canonical). |

### `selected-a-clock-retrieval-frontier-provenance-proposal.md`

Strict observation-support frontiers per anchor. The live surface is now `SelectedRetrievalFrontier` / `_build_selected_retrieval_frontier` in `cohort_forecast_v3.py`, with the query-wide datum from `_analysis_observation_frontier_date`. (The earlier `SelectedAClockEvidence.strict_support_by_anchor` / `_observation_frontier` surface was deleted as legacy authority.)

| Decides | Open |
|---|---|
| Strict support comes only from real retrieved rows landing at exact τ (forward-filled display cells are not support). Per-cohort, not group-wide. Active carrier needs both carrier-fresh and subject-tau; identity carrier needs only subject. `analysis_observation_frontier_date` is the single query-wide as-of datum. | Design decision 6 (per-anchor strict support frontiers in diagnostics) is implemented; ongoing refinement of fallback behaviour for malformed-input cases. |

### `snapshot-fetch-envelope-design.md`

Fetch-envelope construction at the preparation layer. `request_envelope.build_request_envelope_plan` is the implementation. Replaced the 73n second-fetch widening in `build_resolved_cf_runtime` and the carrier-side `lookback_days` heuristic.

| Decides | Open |
|---|---|
| Two-clocks split for envelopes: subject map rooted at X with X-day root weights derived from carrier's reach to X; carrier map rooted at A on the cohort A-anchor range. Donor lookback is diagnostic, not extensional. `as_at` is a retrieval-time admissibility gate, not an envelope clip. Per-primitive binding filters off-clock rows at admission — overfetch is harmless. | None major — design is stable; one of the better-converged trackers. |

### `cohort-outside-in-post-73n-regression-tracker.md`

Post-73n regression triangulation around the half-bin / midpoint-shift / curvature-correction decisions. The "rising flank +3%" symptom and its layered fixes.

| Decides | Open |
|---|---|
| Midpoint-shift `0.5`-only-at-the-first-subject-layer and the three-point central curvature correction were decided here; the `_build_rate_attributed_subject_prefix` / `_interpolated_rate_at` helpers and the `_RateAttributedSubjectPrefix` dual-eval channel that once carried them were deleted at Stage 4 Atom 4.2. The production source-clock conventions (`production`/`midpoint`/`integer`/`ff_integer`) are the surviving decision. | The `diagnostic_dual_eval_by_edge` side-channel was removed with the prefix family. AP60 (cumulative-MC drift mistaken for structural bug) is documented; further fixture engineering for `SIMPLE-flat` is the standing follow-up. |

### `cohort-maturity-selected-cohort-projection-pattern.md`

The selected-cohort projection pattern — Phase 3 admission rule (`a_pop` from root-window carrier `n`, not frame-bundle `a`). Underlies `_root_window_carrier_n_by_anchor_day`; the a_pop bases are applied over the `engine_cohorts` (`CohortEvidence`) sequence. (The earlier `_build_selected_cohort_projection_bases` helper was removed.)

| Decides | Open |
|---|---|
| Active selected base mass `a_pop` per anchor day must come from candidate whose `subject_from == population_root` AND `slice_family == WINDOW`. Frame-bundle `a` is not admissible. Anchors without admissible root-window carrier evidence get `a_pop = 0` and are excluded from active projection. Empty-frames synthesis (`tau_observed = -1` sentinel) preserves `a_pop = 1.0` as the natural Bayesian degeneracy. | Atom 3 retires residual `engine_cohorts` responsibilities in the row builder. |

### `cohort-maturity-selected-a-clock-evidence-clock-adapter-plan.md`

The selected A-clock clock adapter — how subject rows in the X clock get placed onto selected A-days. The mass-attribution method `root_day_shares_on` now lives on `NodeArrivalWeights` (`prefix_arrival.py`); the earlier `_PriorCarrierBackmap` / `_join_conditioned_carrier_backmap` wrappers and the `coverage_root_day_shares_on` transpose were removed in the refactor.

| Decides | Open |
|---|---|
| Subject row placement uses the **prior** carrier-only A→X composition (M_select(X)), not the joint-conditioned carrier — the join-conditioned object would re-smooth evidence with the posterior it's meant to inform. `NodeArrivalWeights.root_day_shares_on` (`prefix_arrival.py`) is the mass-attribution path. (The earlier `_PriorCarrierBackmap` wrapper and its `coverage_root_day_shares_on` transpose were removed.) | None major — the design landed. |

### `post-cf-rebuild-batch-pipeline.md` and `post-cf-rebuild-py-test-audit-7-may-26.md`

The post-73n test audit and batch-pipeline retirement plan. Not active-design — historical record of what landed and what remained.

| Decides | Open |
|---|---|
| Twelve "strict-xfail" test markers that named the substrate as their flip-to-green target. Per-test status as of 7-May-26. | KNOWN_ANTI_PATTERNS.md AP59 captures the recurring failure mode (stages closing flag-OFF without delivering parity). |

---

## Promotion status

Each tracker is in one of three states. Trackers in **ready-to-promote** carry stable invariants that can be absorbed into a codebase doc; the tracker itself can then be archived to `docs/archive/`. **Near-ready** trackers have stable core decisions but one or two open follow-ups; they should be reviewed for partial promotion (absorb the stable §s, keep the tracker for the open parts). **Active** trackers must stay.

| Tracker | Status | Promotion target / open items |
|---|---|---|
| `cf-defensive-coding-audit.md` | Active | None of H-1…H-7 remediated; the audit is the live source of [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md). Stays. |
| `cohort-1apr-falling-k-problem-statement.md` | Active | F-1 unification still open; §A.1 / §A.3 / §A.4 / §A.6 widely cited by code. Stays until F-1 lands; then absorb §A invariants into [`CF_ROW_PIPELINE.md`](CF_ROW_PIPELINE.md) §2/§3. |
| `cohort-maturity-evidence-coverage-design.md` | **Ready to promote** | Design stable; three-state cell contract and coverage formula are referenced inline from [`CF_ROW_PIPELINE.md`](CF_ROW_PIPELINE.md) §5. Absorb into that doc and archive tracker. |
| `selected-a-clock-retrieval-frontier-provenance-proposal.md` | Near-ready | Strict support invariants implemented; "fallback for malformed inputs" still being refined. Absorb the invariant section into [`CF_ROW_PIPELINE.md`](CF_ROW_PIPELINE.md) §2.4 / [`INVARIANTS.md`](INVARIANTS.md); keep tracker for the open follow-up. |
| `snapshot-fetch-envelope-design.md` | **Ready to promote** | Best-converged tracker; cited from runtime, preparation, and `FORECAST_PREPARATION.md`. Promote to `docs/current/codebase/SNAPSHOT_FETCH_ENVELOPE.md` (or absorb into [`FORECAST_PREPARATION.md`](FORECAST_PREPARATION.md) §5 — the design is already summarised there). |
| `cohort-outside-in-post-73n-regression-tracker.md` | Active (forensic) | AP60 fixture engineering still underway. Forensic narrative form must be preserved — do not promote. Cited from row pipeline (midpoint shift, curvature correction). |
| `cohort-maturity-selected-cohort-projection-pattern.md` | Near-ready | Phase 3 admission rule implemented; Atom 3 (retire residual `engine_cohorts` responsibilities) still open. Absorb Phase 3 rule into [`CF_ROW_PIPELINE.md`](CF_ROW_PIPELINE.md) §7; keep tracker for Atom 3. |
| `cohort-maturity-selected-a-clock-evidence-clock-adapter-plan.md` | **Ready to promote** | "The design landed." Cited from [`FORECAST_RUNTIME_ARCHITECTURE.md`](FORECAST_RUNTIME_ARCHITECTURE.md) §5. Absorb the carrier-backmap algebra into that section and archive. |
| `post-cf-rebuild-batch-pipeline.md` / `post-cf-rebuild-py-test-audit-7-may-26.md` | Historical | Already a record, not a working tracker. Move to `docs/archive/` when convenient; nothing actively cites them by `§`-number. |

**Net**: three trackers are ready to promote, two near-ready, three stay active, two are archivable. The codebase docs they would absorb into already exist; promotion is a copy-edit pass plus archive move, not new doc creation.

Promotion criterion (per [`DOCUMENTATION_STRUCTURE.md`](DOCUMENTATION_STRUCTURE.md)): the content describes a now-stable invariant that an agent would navigate to as "what is true", not "how we got here". Tracker prose that retains forensic shape (the regression tracker; the audit) cannot be promoted without losing what makes it useful.

---

## How the trackers cross-cite

The trackers reference each other via shorthand. A few common ones:

- "§A.1" — `cohort-1apr-falling-k-problem-statement.md` §A.1 (the M_select formula).
- "§A.4" — same doc §A.4 (the seam invariant).
- "§A.6 phase 1" — same doc §A.6 phase 1 (M_select as runtime-resolved object).
- "design §2.2" — `cohort-maturity-evidence-coverage-design.md` §2.2 (coverage formula).
- "design §3.1" — same doc §3.1 (three-state contract).
- "Phase 3" — `cohort-maturity-selected-cohort-projection-pattern.md` Phase 3 (admission rule).

When you encounter a `§`-reference in CF code or in another tracker, the rules of thumb:

- `§A.*`, `§N.M phase K` → `cohort-1apr-falling-k-problem-statement.md`
- "design §" → `cohort-maturity-evidence-coverage-design.md`
- "Phase 3" / "atom 2 sub-stage 2a/2b" → `cohort-maturity-selected-cohort-projection-pattern.md`
- "support invariants" → `selected-a-clock-retrieval-frontier-provenance-proposal.md`
- "envelope plan" / "donor lookback" → `snapshot-fetch-envelope-design.md`

---

## When to read a tracker vs a codebase doc

Read a **codebase doc** when:

- You're trying to understand what the code does.
- You're trying to extract invariants for a briefing receipt.
- You want a stable reference that won't move under you.

Read a **tracker** when:

- A code comment cites it by `§`-number — the citation is load-bearing for the surrounding code.
- The codebase doc references it as the design source.
- You're working on a refactor that the tracker scopes.

Codebase docs are curated, indexed, slow-changing. Trackers are live, dated, fast-changing. The codebase docs distil what the trackers decided after the dust settled; the trackers retain context the codebase docs deliberately omit.

---

## Why these aren't promoted to `docs/current/codebase/`

Three reasons:

1. **Still active.** Some trackers (the audit, AP60 triangulation) are still accumulating decisions. Promoting them now would freeze design memory.
2. **Forensic.** `cohort-outside-in-post-73n-regression-tracker.md` is a record of fixes attempted, abandoned, and replaced. The narrative shape is important for the next person who hits a similar symptom; a codebase-style "what is true now" summary loses it.
3. **Plan-adjacent.** They sit next to the plan they execute. The promotion criterion for `docs/current/codebase/` is "agent navigates here for stable reference" — trackers are inappropriate there because they're working documents.

When a tracker's content stabilises, the codebase-reference docs (this one, [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md), [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md)) absorb the stable parts; the tracker retains the forensic detail.

---

## Cross-references

- [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md) — stable view of the substrate that consumes these decisions.
- [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md) — stable view of the row pipeline that cites the trackers throughout.
- [`cf-defensive-findings.md`](../project-generalise/cf-defensive-findings.md) — the audit summary tracker.
- [DOCUMENTATION_STRUCTURE.md](DOCUMENTATION_STRUCTURE.md) — the rules for `docs/current/` vs `docs/current/codebase/` placement.
- [KNOWN_ANTI_PATTERNS.md](KNOWN_ANTI_PATTERNS.md) AP59 — "architecturally complete stage closure with the new path default-OFF" — the failure mode that produces the gap between plans and trackers.
