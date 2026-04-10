# Handover: Phase C Commissioning Contract + R2d Planning

**Date**: 10-Apr-26
**Branch**: `feature/snapshot-db-phase0`

---

## Objective

Implement Phase C (contexted data binding and modelling) for the Bayesian engine, following doc 14. This session completed the FE commissioning contract (R2-prereq-i), fixed the synth generator hash pipeline (R2-prereq-ii), fixed per-slice branch-group Multinomial emission (R2c), and planned R2d (per-date regime routing for mixed-epoch data).

The overarching constraint: the pinnedDSL is the single source of truth for what slices to model. No context modelling happens without explicit FE commission. MECE aggregation only happens when `mece_dimensions` declares the dimension MECE.

---

## Current State

### DONE — Commissioning contract (R2-prereq-i)

- Worker extracts `commissioned_slices: dict[str, set[str]]` from subject `slice_keys` and passes to `bind_snapshot_evidence` — `bayes/worker.py` around line 509
- `_bind_from_snapshot_rows` only collects per-context rows for commissioned keys — `bayes/compiler/evidence.py` around line 513
- `_route_slices` only creates SliceGroups for commissioned keys. When `commissioned` is None, no slices are created — `bayes/compiler/evidence.py` around line 1460
- `mece_dimensions` flows from payload through worker to binder. Only MECE-declared context rows are aggregated into the parent. Non-MECE context rows are skipped — `bayes/compiler/evidence.py` around line 514 (`mece_set`)
- `computeMeceDimensions` in FE now scans all context definitions in the registry, not just DSL-mentioned ones — `graph-editor/src/services/candidateRegimeService.ts:136`
- `contextRegistry.getCachedIds()` added — `graph-editor/src/services/contextRegistry.ts`
- diskLoader cache key fix: `preloadContexts` now passes workspace — `graph-editor/src/cli/diskLoader.ts:273`

### DONE — Synth generator hash pipeline (R2-prereq-ii)

- `_build_payload_via_cli` in test harness accepts optional `graph_dir` for non-data-repo graphs — `bayes/test_harness.py:122`
- `--fe-payload` and `--payload` flags on `test_harness.py` — lines 395-510
- `synth_gen.py` Step 2 now calls CLI (`bayes.ts`) twice (window DSL, cohort DSL) instead of `compute_snapshot_subjects.mjs` — `bayes/synth_gen.py` around line 2686
- Step 1b writes context YAML files from truth file `context_dimensions` with correct `otherPolicy` — `write_context_files()` around line 2006
- `param_files`, `graph_path`, `truth` correctly resolved in payload mode — around line 499
- synth-channel context definition has `otherPolicy: "null"` (was `none`) — `nous-conversion/contexts/synth-channel.yaml`

### DONE — Per-slice branch-group Multinomial (R2c fix)

- `_emit_branch_group_multinomial` now called per context key when slices are exhaustive — `bayes/compiler/model.py` Section 6, around line 1226
- Accepts `slice_ctx_key` and `bg_slice_p_vars` parameters — uses per-slice observations, per-slice kappa, per-slice Dirichlet p vars
- `has_window` detection fix in `_route_slices`: CohortObservation with window-type trajectories now correctly sets `has_window=True` — `bayes/compiler/evidence.py` around line 1558
- Per-slice return vars denominated as `context(...).window()` and `context(...).cohort()` in `_build_unified_slices` — `bayes/worker.py` around line 1706

### DONE — Return vars flow (R2e)

- `_build_unified_slices` copies all per-slice vars (p, kappa, mu, sigma, onset) into webhook payload
- Slice keys correctly denominated: `context(synth-channel:google).window()`
- `posteriorSliceResolution.ts` `_findSliceByMode` already handles context-qualified keys
- `bayesPatchService.ts` writes full `slices` dict to `paramDoc.posterior.slices`

### DONE — Control vs treatment test

- Verified on synth-fanout-context (branch group Dirichlet):
  - **Control** (uncontexted DSL): MECE aggregation, parent-only model, 3 edges bound, PASS
  - **Treatment** (contexted DSL, same data): per-slice DirichletMultinomials, correct slice differentiation (google favours fast, email favours slow), all z-scores under 2.5

### NOT STARTED — R2d (per-date regime routing)

- Plan approved: `/home/reg/.claude/plans/vivid-waddling-ripple.md`
- Core approach: partition rows by regime at bind time, not model time
- Need: `regime_per_date` on EdgeEvidence, row-level filtering in binder, synth generator epoch support, two mixed-epoch test graphs (S3, S4)

### NOT STARTED — R2f (real data validation)

### NOT STARTED — R2g (multi-dimension, conditional_p)

---

## Key Decisions & Rationale

### No backward compatibility fallback for commissioned slices

**What**: when `commissioned` is None (no FE subjects), `_route_slices` creates no slices. No "discover from DB rows" fallback.

**Why**: the user explicitly rejected backward compatibility as unnecessary complexity. The FE always provides subjects in production. The old harness path is legacy.

**Where**: `_route_slices` in `evidence.py` — early return when `not commissioned`.

### MECE is a property of the data, not the query

**What**: `computeMeceDimensions` scans all context definitions in the registry, not just those mentioned in the pinnedDSL.

**Why**: the user pointed out that context rows should be aggregatable into the parent even when the DSL doesn't commission context slices. An uncontexted DSL running against a DB with MECE context rows must still aggregate them.

**Where**: `candidateRegimeService.ts:136` — sources context keys from `contextRegistry.getCachedIds()` in addition to DSL.

### CLI replaces compute_snapshot_subjects.mjs for hash computation

**What**: synth_gen Step 2 calls `bayes.ts` (the CLI) instead of the hand-rolled `compute_snapshot_subjects.mjs`.

**Why**: three independent hash computation paths produced three different hashes for the same graph. The CLI uses the real FE service layer. Anti-pattern 28 documents the root causes (YAML date handling, event definition loading rules, visited/exclude arrays).

**Where**: `synth_gen.py` `_cli_hashes_for_dsl()` around line 2700. Creates a temp directory with DSL-overridden graph JSON and symlinked supporting dirs.

### synth_gen writes context YAML files from truth

**What**: Step 1b in the generator writes `contexts/{dim-id}.yaml` with `otherPolicy` derived from `mece: true/false` in the truth file.

**Why**: context definitions affect hash computation (context_def_hashes is part of core_hash). Manual context files with wrong `otherPolicy` caused persistent hash mismatches. The generator must own the full artefact chain.

**Where**: `write_context_files()` in `synth_gen.py` around line 2006.

### Per-slice Multinomial emission for branch groups

**What**: `_emit_branch_group_multinomial` is called once per context key (not once per branch group) when slices are exhaustive.

**Why**: the original code emitted ONE aggregate Multinomial using `evidence.edges[sib_id]` (global aggregate). Per-slice p vars from the Dirichlet had no data driving them — they collapsed to the parent mean. The user caught this: "per-slice posteriors identical to parent".

**Where**: `model.py` Section 6 around line 1226 — loop over context keys calling `_emit_branch_group_multinomial` with `slice_ctx_key` and `bg_slice_p_vars`. The function uses per-slice observations, kappa, and p vars.

### R2d: partition at bind time, not model time

**What**: the per-date regime routing fix goes in the evidence binder (`_bind_from_snapshot_rows`), not the model compiler.

**Why**: by filtering aggregate buckets to only include uncontexted-regime rows before trajectory construction, the existing model compiler logic works unchanged. Aggregate and per-slice observations cover disjoint date sets. `_all_exhaustive=False` correctly fires both emissions on different dates.

**Where**: plan at `/home/reg/.claude/plans/vivid-waddling-ripple.md`.

---

## Discoveries & Gotchas

### CohortObservation carries window-type data

Per-context window observations created in Step 3b of `_bind_from_snapshot_rows` are stored as `CohortObservation` objects with `slice_dsl=window(snapshot).context(...)`. When `_route_slices` partitions them, they go into `sliced_cohort` (not `sliced_window`). `SliceObservations.has_window` must be set by checking trajectory `obs_type`, not just which list the observation came from. Anti-pattern 30.

### Hash computation depends on context definition content

Changing `otherPolicy: none` to `otherPolicy: "null"` in a context YAML changes the context_def_hash, which changes the core_hash, which invalidates all DB data. Regeneration required after any context definition change.

### Regime selection rows vs regime_per_date

`regime_per_date` maps `retrieved_at` dates (not `anchor_day`). A single trajectory aggregates multiple `retrieved_at` dates for one `anchor_day`. Per-date regime partitioning must happen at the ROW level (before trajectory construction), not at the trajectory level.

### Empty `mece_dimensions` from CLI

`computeMeceDimensions` was returning empty because: (a) it only scanned DSL-mentioned context keys, and (b) `diskLoader.ts` preloaded contexts without workspace prefix, but lookups used workspace prefix → cache miss. Both fixed.

### Binding receipt missed slice_groups

The receipt at `_build_binding_receipt` in `worker.py` scanned `edge_ev.cohort_obs` and `edge_ev.window_obs` for observed slices — but after `_route_slices`, per-context observations are in `edge_ev.slice_groups`. Added scan of `slice_groups` around line 1288.

---

## Relevant Files

### Backend (Bayes compiler)

- `bayes/compiler/evidence.py` — evidence binder: `_bind_from_snapshot_rows` (row routing, MECE aggregation, commissioned slices), `_route_slices` (slice partitioning, exhaustiveness), `bind_snapshot_evidence` (entry point)
- `bayes/compiler/model.py` — model builder: Section 2b (per-slice Dirichlet), Section 6 (per-slice Multinomials), `_emit_edge_likelihoods` (single code path)
- `bayes/compiler/inference.py` — posterior extraction: per-slice p/kappa/mu/sigma/onset
- `bayes/compiler/types.py` — `EdgeEvidence`, `SliceGroup`, `SliceObservations`, `PosteriorSummary.slice_posteriors`
- `bayes/worker.py` — orchestrator: commissioned_slices extraction, mece_dimensions, `_build_unified_slices` (return vars), binding receipt
- `bayes/synth_gen.py` — synth data generator: Step 1b context files, Step 2 CLI hashes, `write_context_files()`, `_cli_hashes_for_dsl()`
- `bayes/test_harness.py` — `--fe-payload`, `--payload`, `_build_payload_via_cli()`
- `bayes/param_recovery.py` — per-slice comparison with truth

### Frontend (CLI + services)

- `graph-editor/src/cli/commands/bayes.ts` — CLI payload construction
- `graph-editor/src/cli/diskLoader.ts` — `seedFileRegistry` (workspace key fix at line 273)
- `graph-editor/src/cli/bootstrap.ts` — CLI shared infrastructure
- `graph-editor/src/services/candidateRegimeService.ts` — `computeMeceDimensions` (scans all registry keys)
- `graph-editor/src/services/contextRegistry.ts` — `getCachedIds()`, `preloadContexts()`
- `graph-editor/src/services/posteriorSliceResolution.ts` — `_findSliceByMode` (context-qualified key resolution)
- `graph-editor/src/services/bayesPatchService.ts` — writes `posterior.slices` to param files
- `graph-editor/lib/snapshot_regime_selection.py` — `select_regime_rows`, `RegimeSelection.regime_per_date`

### Test data

- `nous-conversion/graphs/synth-context-solo.json` — solo edge contexted graph
- `nous-conversion/graphs/synth-context-solo.truth.yaml` — truth with context_dimensions
- `nous-conversion/graphs/synth-fanout-context.json` — branch group contexted graph
- `nous-conversion/graphs/synth-fanout-context.truth.yaml` — truth with p_mult per context
- `nous-conversion/contexts/synth-channel.yaml` — context definition (`otherPolicy: "null"`)

### Docs

- `docs/current/project-bayes/14-phase-c-slice-pooling-design.md` — R2 status updates, critical path
- `docs/current/project-bayes/19-synthetic-data-playbook.md` — pipeline steps, hash architecture, contexted graphs
- `docs/current/codebase/KNOWN_ANTI_PATTERNS.md` — anti-patterns 28-30

---

## Next Steps

1. **Read the approved R2d plan**: `/home/reg/.claude/plans/vivid-waddling-ripple.md`

2. **Step 1 — Wire regime_per_date into the binder**: add `regime_per_date: dict[str, str]` to `EdgeEvidence` in `types.py`. Pass `regime_selections` from `worker.py` to `bind_snapshot_evidence`. Derive regime classification per `retrieved_at` date.

3. **Step 2 — Row-level partitioning in binder**: in `_bind_from_snapshot_rows`, after the row loop, filter `agg_window`/`agg_cohort` to exclude rows from `mece_partition`-regime dates (they're already in `ctx_window_rows`/`ctx_cohort_rows`). Add date-disjointness assertion.

4. **Step 3 — Exhaustiveness override**: when `regime_per_date` has MECE entries, set `SliceGroup.is_exhaustive = True` unconditionally.

5. **Step 4 — Synth generator epoch support**: add `epochs` truth schema, per-epoch row emission in `_generate_observations_nightly`, multi-hash computation via CLI.

6. **Step 5 — Create test graphs**: `synth-context-solo-mixed.truth.yaml` (S3) and `synth-fanout-context-mixed.truth.yaml` (S4), days 0-44 bare, days 45-89 contexted.

7. **Step 6 — Run param_recovery on mixed-epoch graphs**: verify no double-counting (posterior width check), all z-scores under threshold.

8. **After R2d**: proceed to R2f (real data validation on prod graph).

---

## Open Questions

- **Non-blocking**: should `compute_snapshot_subjects.mjs` be deleted now? It's bypassed by the CLI path but still exists. Low priority cleanup.

- **Non-blocking**: the predictive latency uncertainty issue (raw MCMC SDs overstate certainty) is documented in `programme.md` but unfixed. Affects both uncontexted and per-slice posteriors. Not blocking R2d.

- **Non-blocking**: the `_tau_slice` entry in the webhook payload shows `p=0.0, alpha=0.0` — it's a diagnostic, not a proper slice. The FE should ignore it but it's messy. Consider removing or formatting differently.
