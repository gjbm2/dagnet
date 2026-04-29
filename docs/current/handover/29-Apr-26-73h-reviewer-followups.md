# 73h follow-ups: external code review items

Date: 29-Apr-26

## Context

Stages 5–7 of 73h are landed; commits replaced the legacy
file-evidence helper with the typed-merge library, added Bayes-side
adapter and CF-side as-at reconstruction, and retired
`file_evidence_supplement.py`. An external code review identified
nine concerns. **Eight were resolved in this workstream**:

- #2, #3, #5, #7, #8 — fixed in the original 73h session
- #1, #4, #6 — fixed in the follow-up session of 29-Apr-26
- #9 — remains pending discussion (preserves byte-equality with
  legacy code; tightening is a behaviour change, not a regression fix)

The sections below document each fix or open issue with file:line
citations.

## Status summary

| # | Status | Location |
|---|---|---|
| 1 | **Fixed** | snapshot adapter wired into typed merge: [forecast_runtime.py:2059-2120](../../graph-editor/lib/runner/forecast_runtime.py#L2059) + [forecast_preparation.py:441-450](../../graph-editor/lib/runner/forecast_preparation.py#L441) |
| 2 | Fixed | `parse_asat_from_dsl` plumbed through both CF call sites; [api_handlers.py:1653](../../graph-editor/lib/api_handlers.py#L1653), [api_handlers.py:2299](../../graph-editor/lib/api_handlers.py#L2299) |
| 3 | Fixed | `_resolve_evidence_role` single decision point at [forecast_runtime.py:1697](../../graph-editor/lib/runner/forecast_runtime.py#L1697) |
| 4 | **Fixed** | `extra_conditioning_evidence` threaded through `_non_latency_rows`: [cohort_forecast_v3.py:69-118](../../graph-editor/lib/runner/cohort_forecast_v3.py#L69) + tests in `test_non_latency_rows.py` |
| 5 | Fixed | tier-1 vs tier-2 marker disambiguation at [evidence_adapters.py:106-131](../../graph-editor/lib/runner/evidence_adapters.py#L106) |
| 6 | **Fixed** | FE population-identity matcher at [fileToGraphSync.ts:55-130](../../graph-editor/src/services/dataOperations/fileToGraphSync.ts#L55) + tests in `fileToGraphSync.asatSliceMatch.test.ts` |
| 7 | Fixed | `role` in dedupe key at [evidence_merge.py:377-400](../../graph-editor/lib/evidence_merge.py#L377) |
| 8 | Fixed | reconstructed cohort defaults to n=x at [evidence_adapters.py:495-506](../../graph-editor/lib/runner/evidence_adapters.py#L495) |
| 9 | Open  | Bayes Phase 2 cross-product covered-set — preserves legacy date-blind behaviour; tightening pending discussion |

## Second-round reviewer follow-ups (29-Apr-26 evening)

A subsequent code review on the #1/#4/#6 fixes flagged four further
issues. Three were defects in the second-round fixes themselves; the
fourth was a tightening opportunity in the original typed merge. All
four are now closed.

### H1 — bundle `p_conditioning_temporal_family` did not match merge role

`build_prepared_runtime_bundle` was called with
`p_conditioning_temporal_family=result.subject_temporal_mode` (the
query's temporal mode). Pre-WP8 every CF subject reads E under
`WINDOW_SUBJECT_HELPER`, so a `cohort()` query had `mode=cohort` but
the merge actually admitted window-helper E. Diagnostics reported one
thing while the merge did another.

Fix at [forecast_runtime.py:2014-2037](../../graph-editor/lib/runner/forecast_runtime.py#L2014):
resolve `evidence_role` once (lifted out of the `bayes_evidence` block
so it's available even when no merge fires), derive
`_role_family(evidence_role)`, and pass the resulting `'window'` /
`'cohort'` string as `p_conditioning_temporal_family`. The bundle and
the merge now report the same family for the same subject.

### H2 — BE-direct snapshot reads were marked `asat_materialised=True`

`reconstructed_asat_to_candidates` always set
`coordinate.asat_materialised=True`. The #1 wiring repointed the
candidates' source to `SourceKind.SNAPSHOT` but preserved the
coordinate, so plain BE-direct snapshot reads bypassed the merge's
`retrieved_at` / `as_at` admission gate. `EvidenceSet.evidence_provenance.asat_materialised_present`
would also have been falsely inflated.

Fix at [evidence_adapters.py:428-477](../../graph-editor/lib/runner/evidence_adapters.py#L428):
add `asat_materialised: bool = True` parameter (defaults preserve the
adapter's original FE-asat-tier-1 contract). The CF wiring at
[forecast_runtime.py:2086-2104](../../graph-editor/lib/runner/forecast_runtime.py#L2086)
passes `asat_materialised=False` because BE-direct snapshot reads are
plain observations, not as-at materialisations.

### M1 — merge admission accepted same-family wrong-role candidates

`_validate_candidate` only checked role family (window vs cohort), not
exact role. Reviewer-#7's fix added role to the dedupe key, but the
admission gate still let cross-role candidates into scope where they
would never merge — `WINDOW_SUBJECT_HELPER` and `BAYES_PHASE1_WINDOW`
are same-family but belong to different consumers' E.

Fix at [evidence_merge.py:454-466](../../graph-editor/lib/evidence_merge.py#L454):
admission now rejects `c.identity.role != scope.role` outright. In
the normal flow this is moot — adapters set `identity.role` from
`scope.role` — but the gate now matches the dedupe-key contract.

### M2 — FE asat matcher was too broad for cohort identity

The first-round #6 fix matched by slice family (context dims +
cohort/window mode). Per 73h population-identity discipline,
`cohort(simple-a, 1-Mar-26:31-Mar-26)` and
`cohort(simple-a, 1-Apr-26:30-Apr-26)` are different populations and
must not be merged. The original test even locked in mutating both.

Fix at [fileToGraphSync.ts:55-130](../../graph-editor/src/services/dataOperations/fileToGraphSync.ts#L55):
the matcher now keys on full population identity — context dims +
mode + cohort anchor + date bounds (or window bounds). The asat
clause is stripped before keying because it is a frontier on a
population, not a population identity. Tests rewritten in
`fileToGraphSync.asatSliceMatch.test.ts` to enforce the population
discipline (different anchors → different keys; different cohort
date bounds → different keys).

## #1 — Snapshot adapter missing: typed `EvidenceSet` only contains file candidates

### Where

`graph-editor/lib/runner/forecast_runtime.py:2020-2120` — the Stage 3
typed-merge call site for the conditioned-forecast latency path.

### Symptom

The merged `evidence_set` stashed on the prepared runtime contains
only file-derived candidates (filtered against
`snapshot_covered_observations` so file rows do not double-count
snapshot rows). Snapshot-tier evidence is **not** represented as
candidates. Callers reading `result.evidence_set` see a partial
picture; the snapshot rows are still present in the engine via the
parallel `frames` → `build_cohort_evidence_from_frames` →
`FrameEvidence` plumbing, but the typed `EvidenceSet` is not the
single source of truth.

### Proposed fix shape

Add a snapshot adapter alongside the existing file/reconstruction
adapters (in `graph-editor/lib/runner/evidence_adapters.py`):

```text
def query_virtual_snapshot_rows_to_candidates(
    rows, *, scope, edge_topology=None
) -> list[EvidenceCandidate]:
    ...
```

It would walk the snapshot DB rows (each carrying `anchor_day`, `x`,
`y`, `retrieved_at`, `slice_key`) and emit one `EvidenceCandidate` per
(anchor_day, retrieved_at) pair with `source_kind=SNAPSHOT`,
`slice_family=COHORT|WINDOW` per the slice key. Then in
`forecast_runtime.py:2059` the typed merge would be fed:

```text
candidates = (
    bayes_file_evidence_to_candidates(bayes_evidence, scope=scope)
    + query_virtual_snapshot_rows_to_candidates(snapshot_rows, scope=scope)
)
```

The `snapshot_covered_observations` filter would then become
redundant (or redundant-but-harmless) since both tiers are
candidates and the merge's existing precedence rules
(SNAPSHOT > FILE for same identity+day) handle dedup.

### Tractability

Medium. The snapshot rows are not currently plumbed to
`prepare_forecast_runtime_inputs`; `last_entry.get('snapshot_covered_days')`
is a covered-day set, not the rows themselves. The plumbing change
spans `api_handlers.py` (caller), `forecast_runtime.py` (input plumbing),
and `evidence_adapters.py` (new adapter). No engine-shape change.

### Non-obvious invariant for future maintainers (29-Apr-26 fix)

`extra_conditioning_evidence` derived from `evidence_set.points` MUST
exclude `SourceKind.SNAPSHOT` points. Snapshot rows reach the engine
twice — once via `fe.cohort_list` (built from snapshot frames in
`build_cohort_evidence_from_frames`) and once if naively included in
extras. Counting both into `_non_latency_rows.sum_x` (post #4 fix)
or `compute_forecast_trajectory.extra_evidence` would double-count.
The runtime filter at [forecast_runtime.py:2126-2131](../../graph-editor/lib/runner/forecast_runtime.py#L2126)
keeps extras to the FILE/RECONSTRUCTED-source residual that snapshots
have not already covered. Snapshot points stay in `result.evidence_set`
for response provenance — only their projection into extras is
suppressed.

### Sub-note: Stage 6 reconstruction adapter has no production caller

`reconstructed_asat_to_candidates` in `evidence_adapters.py` (Stage 6
deliverable, lines 428-546) is defined, fully unit-tested, and has
**no production caller** — `grep -rn "reconstructed_asat_to_candidates"
graph-editor/` returns only the definition and tests. Production as-at
behaviour is correct because the FE writes `_asat_retrieved_at`
markers and the file adapter recognises them via
`_entry_is_asat_reconstructed`, emitting `SourceKind.RECONSTRUCTED`
candidates from the file path. So the standalone reconstruction
adapter is dead code in production until a BE-direct
`query_virtual_snapshot` path is wired. Wire it as part of #1: when
the snapshot adapter lands, callers reaching for
`query_virtual_snapshot` rows get the typed-RECONSTRUCTED candidates
without going through the FE-marker round trip.

## #4 — Non-latency edges report merged E but do not condition on it

### Where

`graph-editor/lib/runner/cohort_forecast_v3.py:69` (`_non_latency_rows`
signature) and `graph-editor/lib/runner/cohort_forecast_v3.py:1009`
(call site in `compute_cohort_maturity_rows_v3`).

### Symptom

`compute_cohort_maturity_rows_v3` already accepts
`extra_conditioning_evidence` (list of `(age_days, n, k)` tuples
derived from the typed `EvidenceSet`) and passes it to the latency-edge
path via `compute_forecast_trajectory(extra_evidence=...)` at
`cohort_forecast_v3.py:1131`. The non-latency-edge path at
`cohort_forecast_v3.py:1009` does **not** pass it: `_non_latency_rows`
only consumes `fe.cohort_list` (snapshot-derived `FrameEvidence`).

The bundle preparation at `cohort_forecast_v3.py:972-983` adds
`_extra_x` / `_extra_y` to the **reported** total, so the response
says we used the merged total. The Beta-Binomial conjugate update at
`cohort_forecast_v3.py:124-125` only sees the snapshot half. Reported
≠ used.

### Proposed fix shape

1. Add `extra_conditioning_evidence: Optional[List[tuple]] = None`
   parameter to `_non_latency_rows`.
2. Inside `_non_latency_rows`, after the `if fe is not None:` block
   that computes `sum_x` / `sum_y`, fold extras in:

   ```text
   if extra_conditioning_evidence:
       sum_x += sum(float(item[1] or 0.0) for item in extra_conditioning_evidence)
       sum_y += sum(float(item[2] or 0.0) for item in extra_conditioning_evidence)
   ```

   The extras are already filtered by `snapshot_covered_observations`
   in the typed merge upstream, so no double-count against `fe`.
3. Update the `evidence_x` / `evidence_y` row reporting condition at
   `cohort_forecast_v3.py:253-254` so non-None values surface when
   either tier is non-empty.
4. Update `conditioned = (fe is not None and sum_x > 0)` to also
   recognise extras-only conditioning (rare but possible when fe is
   absent for non-latency edges).
5. Pass `extra_conditioning_evidence=extra_conditioning_evidence`
   from the caller at line 1009.
6. Add a unit test in `lib/tests/test_non_latency_rows.py`: empty fe
   + non-empty extras → posterior mean reflects extras.

### Tractability

Small. ~10 LOC code + 1 test. Touches scoped path
(`graph-editor/lib/runner/**`) so requires a fresh briefing receipt
covering the be-runner-cluster scope.

## #6 — FE rewrites every `values[]` entry with the same asat reconstruction

### Where

`graph-editor/src/services/dataOperations/fileToGraphSync.ts:224-236`
(Tier 1) and `graph-editor/src/services/dataOperations/fileToGraphSync.ts:264-294`
(Tier 2).

### Symptom

Both tiers use `for (const v of values)` and overwrite **every**
value entry on the parameter file with the reconstructed series
queried for `targetSliceKey`. If a parameter file has multiple slices
(e.g. `context=ios`, `context=android`, bare), the asat result for the
queried slice clobbers the other slices' arrays. Subsequent BE calls
then see the queried-slice numbers attributed to all slices.

### Proposed fix shape

Replace the unconditional `for (const v of values)` loop with a
filter that picks only the value entry whose own slice key matches
the asat query slice. Existing slice-key matching logic is already
elsewhere in `fileToGraphSync.ts` (search for `sliceFamilyKey`); reuse
it. Tier 2 has the same shape — same fix.

Test: extend the existing FE asat unit tests to assert only one
value entry is mutated when the file has multiple values.

### Tractability

Small. ~5 LOC TypeScript + tests. Outside the BE adapter scope of
73h; appropriate as its own small PR or rolled into a future
data-sync workstream.

## #9 — Bayes Phase 2 cross-product covered-set is over-broad

### Where

`bayes/compiler/evidence.py` — the Stage 5 typed-merge call inside
`_supplement_from_param_file` (the function that replaced the legacy
`merge_file_evidence_for_role` helper).

### Symptom

The covered-set is constructed as a cross-product of all candidate
keys × all covered ISO days:

```text
candidate_keys = {evidence_dedupe_key(c.identity) for c in candidates}
snapshot_covered_observations = {
    (key, day) for key in candidate_keys for day in covered_iso
}
```

This means: if a snapshot covers day D for identity-key K1, and there
is another identity-key K2 in the candidates, the merge treats K2 as
also covered on D — even when no snapshot for K2 exists. A K2 file
candidate on day D will then be silently filtered out.

### Why this preserves legacy behaviour

The pre-Stage-5 code (`merge_file_evidence_for_role` + `iter_uncovered_bare_cohort_daily_points`)
took a single `covered_iso` set of dates and skipped any file
evidence on those dates regardless of identity. Date-blind. So the
cross-product preserves byte-equality with the legacy path. It is
**not** a regression — but the typed merge interface invites tighter
per-(key, day) tracking, and shipping the typed library while
emulating the legacy breadth is the load-bearing concession that
should eventually be tightened.

### Proposed fix shape

Plumb per-identity coverage from the upstream callers in the Bayes
compiler. The caller currently has access to the snapshot rows
themselves (the `phase_s` topo build), so it can compute per-key
coverage rather than handing down a flat day-set. The change is:

1. In the Bayes compiler upstream of `_supplement_from_param_file`,
   compute `snapshot_covered_observations` directly from the
   snapshot rows (same shape the typed merge takes).
2. Replace the cross-product fall-back with the precise per-key
   set.
3. Behaviour change: a K2 file row on day D where only K1 is
   snapshot-covered will now correctly survive the merge and be
   treated as additional file evidence.

### Tractability

Medium. Requires understanding the Phase 2 topo build well enough to
identify the right plumbing point for snapshot rows → per-key
coverage. Probably 50–100 LOC including tests. The behaviour change
is real (more file evidence will survive in mixed-coverage scenarios)
and may shift binders' priors slightly — should be validated against
the Bayes adversarial regression suite.

## Summary

| # | Severity | Tractability | Scope |
|---|---|---|---|
| 1 | Critical | Medium | BE: `forecast_runtime.py` + new snapshot adapter |
| 4 | High    | Small  | BE: `cohort_forecast_v3.py` + 1 unit test |
| 6 | High    | Small  | FE: `fileToGraphSync.ts` |
| 9 | Medium  | Medium | Bayes: `bayes/compiler/evidence.py` upstream plumbing |

#4 is the cheapest concrete behaviour fix and should be picked up
first — it is a one-line bug that turns a reported value into an
unreported one. #1 and #6 are next in priority (they are both
"reported ≠ actual" defects). #9 is a tightening, not a regression
fix, and can wait.
