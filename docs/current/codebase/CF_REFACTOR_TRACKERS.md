# CF Refactor Trackers

**Status**: Active reference, 12-May-26
**Scope**: index of the in-flight design-doc trackers in `docs/current/` (NOT in `docs/current/codebase/`) that the CF machinery code cites by `§`-number. The codebase-reference docs are stable; the trackers are live design memory of refactors that are partly landed and partly outstanding.

A CF code comment that says "see `docs/current/cohort-1apr-falling-k-problem-statement.md` §A.4" is referencing one of these. This index resolves the references — what each tracker decides, what's still open, when it was active.

The substrate's design contract is captured in the codebase docs ([CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md), [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md), [CF_RESIDUAL_GUARD.md](CF_RESIDUAL_GUARD.md), [DRAW_FAMILY_KEYING.md](DRAW_FAMILY_KEYING.md), [INVARIANTS.md](INVARIANTS.md) I-45/46/47/48). The trackers below record decisions made during the substrate refactor that are still actively being resolved — they are working documents, not the authoritative reference.

---

## The active trackers

### `cf-defensive-coding-audit.md` — 12-May-26

The 21-finding defensive-code audit. Executive summary in [CF_DEFENSIVE_FINDINGS.md](CF_DEFENSIVE_FINDINGS.md). Source for [INVARIANTS.md](INVARIANTS.md) I-47 / I-48.

| Decides | Open |
|---|---|
| H-1 through H-7 (HIGH-severity defensive patterns); M-1 through M-9 (MEDIUM); L-1 through L-5 (LOW); F-1 through F-5 (parallel code paths). Each finding has location, category, "why it corrupts", remediation. | None of the HIGH findings remediated yet. Priority order: H-5 → H-2 → H-1 → H-7 → H-6. |

### `cohort-1apr-falling-k-problem-statement.md`

The dual-prefix object design (§A.1, §A.3, §A.4, §A.6). Cited extensively from `cohort_forecast_v3.py` (`_SelectedSourceDayMass`, `_CarrierOnlyDenominatorPrefix`, `_RateAttributedSubjectPrefix`).

| Decides | Open |
|---|---|
| `M_select(U, C, u) = N_cohort(C) × g_{A→U}[u − C]` for every subject primitive source node U (§A.1); reach-preserving density-form mass semantics (§A.3); seam invariant — reducer and row builder must read the same prefix object (§A.4); M_select is a runtime-resolved object, not projection-layer (§A.6 phase 1); midpoint shift compensates for bucket-day integration (§A.6 phase 6 — no display-layer Y ≤ X cap). | F-1 unification (extract one mass-first reducer interface across funnel/daily/maturity/canonical). |

### `cohort-maturity-evidence-coverage-design.md`

The coverage signal in row buckets — what `evidence_x_coverage`, `evidence_y_coverage`, `coverage` mean and how they're computed. Cited from `_project_runtime_rows` and the surface builders.

| Decides | Open |
|---|---|
| Three-state contract for cells (§3.1): Present-with-positive-mass / Covered-with-zero-mass / Absent. Coverage = capped per-cohort placement-share sum / admissible-cohort count (§2.2). Forward-fill is for value, never for coverage. Subject placement via carrier backmap (§2.4 property 4). | None major — design is stable. |

### `selected-a-clock-retrieval-frontier-provenance-proposal.md`

Strict observation-support frontiers per anchor. Used by `SelectedAClockEvidence.strict_support_by_anchor` and `_observation_frontier`.

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
| Midpoint shift `0.5` ONLY at the first subject layer ONLY when M_select places mass at multiple source days (`_build_rate_attributed_subject_prefix:3816`). Three-point central curvature correction in `_interpolated_rate_at` (`:3232-3251`). Production source-clock rule chosen against the dual-eval side-channel (`production`/`midpoint`/`integer`/`ff_integer` conventions). | Dual-eval `diagnostic_dual_eval_by_edge` is preserved in `_RateAttributedSubjectPrefix` for future triangulation. AP60 (cumulative-MC drift mistaken for structural bug) is documented; further fixture engineering for `SIMPLE-flat` is the standing follow-up. |

### `cohort-maturity-selected-cohort-projection-pattern.md`

The selected-cohort projection pattern — Phase 3 admission rule (`a_pop` from root-window carrier `n`, not frame-bundle `a`). Underlies `_root_window_carrier_n_by_anchor_day` and `_build_selected_cohort_projection_bases`.

| Decides | Open |
|---|---|
| Active selected base mass `a_pop` per anchor day must come from candidate whose `subject_from == population_root` AND `slice_family == WINDOW`. Frame-bundle `a` is not admissible. Anchors without admissible root-window carrier evidence get `a_pop = 0` and are excluded from active projection. Empty-frames synthesis (`tau_observed = -1` sentinel) preserves `a_pop = 1.0` as the natural Bayesian degeneracy. | Atom 3 retires residual `engine_cohorts` responsibilities in the row builder. |

### `cohort-maturity-selected-a-clock-evidence-clock-adapter-plan.md`

The selected A-clock clock adapter — how subject rows in the X clock get placed onto selected A-days via `_join_conditioned_carrier_backmap`.

| Decides | Open |
|---|---|
| Subject row placement uses the **prior** carrier-only A→X composition (M_select(X)), not the joint-conditioned carrier — the join-conditioned object would re-smooth evidence with the posterior it's meant to inform. `_PriorCarrierBackmap.root_day_shares_on` is the mass-attribution path; `coverage_root_day_shares_on` is the transpose (per-anchor support fraction). | None major — the design landed. |

### `post-cf-rebuild-batch-pipeline.md` and `post-cf-rebuild-py-test-audit-7-may-26.md`

The post-73n test audit and batch-pipeline retirement plan. Not active-design — historical record of what landed and what remained.

| Decides | Open |
|---|---|
| Twelve "strict-xfail" test markers that named the substrate as their flip-to-green target. Per-test status as of 7-May-26. | KNOWN_ANTI_PATTERNS.md AP59 captures the recurring failure mode (stages closing flag-OFF without delivering parity). |

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

When a tracker's content stabilises, the codebase-reference docs (this one, [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md), [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md), [CF_DEFENSIVE_FINDINGS.md](CF_DEFENSIVE_FINDINGS.md)) absorb the stable parts; the tracker retains the forensic detail.

---

## Cross-references

- [CF_PRIMITIVE_SUBSTRATE.md](CF_PRIMITIVE_SUBSTRATE.md) — stable view of the substrate that consumes these decisions.
- [CF_ROW_PIPELINE.md](CF_ROW_PIPELINE.md) — stable view of the row pipeline that cites the trackers throughout.
- [CF_DEFENSIVE_FINDINGS.md](CF_DEFENSIVE_FINDINGS.md) — the audit summary.
- [DOCUMENTATION_STRUCTURE.md](DOCUMENTATION_STRUCTURE.md) — the rules for `docs/current/` vs `docs/current/codebase/` placement.
- [KNOWN_ANTI_PATTERNS.md](KNOWN_ANTI_PATTERNS.md) AP59 — "architecturally complete stage closure with the new path default-OFF" — the failure mode that produces the gap between plans and trackers.
