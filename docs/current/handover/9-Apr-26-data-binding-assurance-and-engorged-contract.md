# Handover: Data Binding Assurance & Engorged Graph Contract

**Date**: 9-Apr-26
**Branch**: `feature/snapshot-db-phase0`
**Status**: R1 (data binding assurance) COMPLETE. R2 (model work) ready to begin.

---

### Objective

Doc 14 (Phase C: slice pooling and hierarchical Dirichlet) identified two sequential risks:

1. **Risk 1**: right data gets into the model — hash computation, DB query, regime selection, dedup, slice routing, observation assembly
2. **Risk 2**: we do the right things with the data — hierarchical shrinkage, Dirichlet, per-date routing, posterior summarisation

This session built the infrastructure to retire Risk 1 (binding receipt, CLI tool, engorged graph contract) and verified it across the full regression set. R1 gate passed. The session then created the first contexted synthetic graph (`synth-context-solo`) as the gate test for R2 — it stays red until the Phase C model routes per-slice data.

The programme is documented in `docs/current/project-bayes/14-phase-c-slice-pooling-design.md` §11 (R1/R2 phasing) and §16 (binding receipt design).

---

### Current State

**DONE — Binding receipt infrastructure (R1a)**
- `EdgeBindingReceipt` and `BindingReceipt` dataclasses in `bayes/compiler/types.py`
- `_build_binding_receipt()` in `bayes/worker.py` — compares FE expectations (snapshot subjects, candidate regimes) against BE reality (rows fetched, regime selection, observations bound)
- Three modes: `"log"` (default, proceed), `"gate"` (halt on failures), `"preflight"` (always halt after receipt)
- `evidence_hash` per edge — SHA-256 of assembled model inputs via `EdgeEvidence.content_hash()`
- 10 contract tests in `bayes/tests/test_binding_receipt.py` (8 §16.11 fixtures + 2 mode tests)

**DONE — CLI bayes command (R1b)**
- `graph-editor/src/cli/bayes.ts` — entry shim
- `graph-editor/src/cli/commands/bayes.ts` — command module using real FE service layer
- `graph-ops/scripts/bayes.sh` — shell wrapper
- `--output` writes payload JSON, `--preflight` submits to Python server and displays receipt
- `--submit` mode exists but untested (not needed — harness handles actual compute)

**DONE — Engorged graph contract (R1c/R1d)**
- `graph-editor/src/lib/bayesEngorge.ts` — FE module that injects `_bayes_evidence` and `_bayes_priors` onto graph edges from param files
- Wired into `graph-editor/src/hooks/useBayesTrigger.ts` and `graph-editor/src/cli/commands/bayes.ts`
- `bind_evidence_from_graph()` in `bayes/compiler/evidence.py` — BE reads engorged edges
- `_bind_from_engorged_edge()` — file-based evidence fallback from engorged edges
- `bind_snapshot_evidence()` accepts optional `graph_snapshot` parameter — reads priors from engorged edges when present, snapshot row handling unchanged
- `engorge_graph_for_test()` — Python-side engorge helper for parity testing
- Worker dispatch in `bayes/worker.py` detects engorged graph and passes it through
- 6 parity tests in `bayes/tests/test_engorged_parity.py` — snapshot + priors combined, warm-start, fallback, observation counts, skip state

**DONE — Certification (R1e) and harness bridge (R1f)**
- CLI preflight regression: all 8 available graphs clean (7 synth + `conversion-flow-v2-recs-collapsed`)
- Parity confirmed via `content_hash()` — legacy and engorged paths produce identical model inputs
- Harness bridge: core hashes match between CLI and harness on `synth-fanout-test` (6/6)

**DONE — DSL explosion fix**
- `graph-editor/src/lib/dslExplosion.ts` — cartesian product syntax `(a;b)(c)` now works (was causing stack overflow). Fix: treat `(...)(...)` same as `(...).(...)` by inserting a dot.
- All 52 existing DSL explosion tests pass.

**DONE — js-yaml Date conversion fix**
- `graph-editor/src/cli/diskLoader.ts` — uses `YAML.JSON_SCHEMA` to prevent js-yaml from converting ISO date strings to `Date` objects. This was corrupting context definition hashes in the CLI (anti-pattern 23).

**DONE — Synth-context-solo graph (R2a partial)**
- `nous-conversion/graphs/synth-context-solo.truth.yaml` — truth file with `context_dimensions` (synth-channel: google/direct/email, different p per channel)
- `nous-conversion/contexts/synth-channel.yaml` — generated context YAML with amplitude source mappings
- `nous-conversion/graphs/synth-context-solo.json` — generated graph (2 nodes, 1 data edge + 1 complement)
- 23,814 snapshot rows in DB (per-context: 3 values × window + cohort)
- `graph_from_truth.py` extended to generate context YAML files and pass through `sources`/`aliases`

**RED — synth-context-solo preflight receipt**
- Receipt shows verdict `fail` on the data edge: expected slices `[context(synth-channel:google), ...]` but observed `[""]` (aggregate only)
- This is correct behaviour — the Phase A/B evidence binder aggregates context rows into uncontexted. The Phase C model (R2b) will route per-slice data.
- This is the **R2 gate test** — it stays red until the model work is done.

**NOT STARTED — R2b onwards**
- Solo-edge slice pooling (τ_slice, logit-offset deviations, per-date routing)
- Branch-group hierarchical Dirichlet
- Per-date routing validation
- Posterior summarisation
- Real data validation

**NOT STARTED — Snapshot query batching (doc 33)**
- Problem statement written at `docs/current/project-bayes/33-snapshot-query-batching.md`
- User simplified the design: one query with all hashes, group by core_hash in Python
- Not blocking model work

---

### Key Decisions & Rationale

- **Two tools for two risks**: CLI certifies data binding (FE codepath). Harness certifies the model (parallel compute). One-time bridge check confirms harness honours the same contract. The user was emphatic that these serve different purposes and must not be conflated. See §16.12 in doc 14.

- **Receipt compares at the BE, not round-tripped to FE**: the FE sends expectations in the payload, the BE compares after binding, fails fast before MCMC. This was the user's original design insight — "calculate expectation at the call site, compare at the bind site."

- **Engorged graph is additive, not replacing**: `bind_snapshot_evidence` accepts the engorged graph as an optional parameter. When present, priors come from `_bayes_priors` on edges instead of param files. Snapshot row handling is completely unchanged. The user corrected an initial design that treated snapshots and file-based evidence as mutually exclusive branches — they always work together.

- **Parity uses `content_hash()`**: SHA-256 of assembled model inputs (priors, observations, warm-start, skip state). Excludes diagnostic metadata. Added to `EdgeEvidence` in `compiler/types.py`. Populated on `EdgeBindingReceipt` as `evidence_hash`. This was added specifically for the engorged graph parity gate.

- **Slice comparison extracts context keys**: `_extract_context_key()` in `worker.py` strips temporal qualifiers (window/cohort/asat) from both expected and observed sliceDSL strings before comparison. Both sides are normalised to context-only keys like `context(channel:google)` or `""` (aggregate). The aggregate `""` is excluded from unexpected_slices since it's always present.

- **`YAML.JSON_SCHEMA` in CLI disk loader**: prevents js-yaml from converting ISO date strings to `Date` objects, which corrupted context definition hashes. The FE browser stores context definitions in IDB as serialised JSON where dates are already strings. Documented as anti-pattern 23.

- **Cartesian product DSL syntax**: `(a;b)(c)` is valid DSL (same as `(a;b).c`). The parser treated the second paren group as a separate expression. Fix inserts a dot: `(a;b).(c)`. The synth generator uses this format.

- **synth-context-solo is the R2 gate test**: it deliberately stays red (receipt shows fail) until the Phase C model routes per-slice data. This is by design — the receipt correctly reports that expected context slices aren't being routed because the model doesn't route them yet.

---

### Discoveries & Gotchas

- **js-yaml Date conversion**: `YAML.load()` with default schema converts ISO date strings to `Date` objects. `normalizeObjectKeys` in `querySignature.ts` treats `Date` as a plain object (`typeof date === 'object'`), but `Object.keys(new Date())` returns `[]`, producing `{}`. Different canonical JSON, different hash. The FE browser doesn't hit this because IDB stores strings. Only affects CLI/Node.js context.

- **`Date.toISOString()` adds milliseconds**: converting a `Date` back via `toISOString()` produces `2025-11-24T00:00:00.000Z` while the original YAML string was `2025-11-24T00:00:00Z`. Different strings, different hashes. Using `JSON_SCHEMA` avoids both issues by keeping the original string.

- **Snapshot query performance**: `_query_snapshot_subjects` in `worker.py` makes one DB round-trip per snapshot subject. For `li-cohort-segmentation-v2` (31 edges × 2 slices = 62 subjects), this is 62 sequential queries. Problem statement in doc 33. Fix: batch all hashes into one query.

- **`buildCandidateRegimesByEdge` crashes on contexts without amplitude source mappings**: the `buildQueryPayload` function requires `sources.amplitude.filter` on context values to build context filters. Synthetic contexts need these mappings even though they're arbitrary.

- **The evidence binder aggregates context rows**: `_bind_from_snapshot_rows` in `evidence.py` sums context-prefixed rows into bare aggregate observations (lines 407-466). This is Phase A/B behaviour — correct for the current model, but it means the receipt shows "missing slices" for contexted graphs until Phase C routing is built.

- **Skipped edges shouldn't bypass verdict when they have subjects**: a skipped edge with snapshot subjects (data expected but not found) is a real problem. Only skip verdict bypass when the edge has no subjects (no param, no pinnedDSL). Fixed in `worker.py`.

- **Hash equivalence via data doesn't mean hash equality**: when all expected hashes are empty but data arrived via equivalent hashes (`rows_raw > 0`, `total_n > 0`), it's a warn not a fail. The primary hash being absent is informational when equivalence bridged the gap.

---

### Relevant Files

**Backend (Python)**
- `bayes/compiler/types.py` — `EdgeBindingReceipt`, `BindingReceipt`, `content_hash()` on `EdgeEvidence`, suppression count fields
- `bayes/compiler/evidence.py` — `bind_evidence_from_graph()`, `_bind_from_engorged_edge()`, `engorge_graph_for_test()`, engorged support in `bind_snapshot_evidence()`
- `bayes/worker.py` — `_build_binding_receipt()`, preflight/gate/log modes, engorged dispatch, log cleanup
- `bayes/compiler/__init__.py` — exports for new functions
- `bayes/graph_from_truth.py` — context YAML generation, source/alias passthrough

**Frontend (TypeScript)**
- `graph-editor/src/lib/bayesEngorge.ts` — FE engorging module (prior resolution, observation extraction)
- `graph-editor/src/hooks/useBayesTrigger.ts` — wired engorging call
- `graph-editor/src/cli/bayes.ts` — CLI entry shim
- `graph-editor/src/cli/commands/bayes.ts` — CLI command module
- `graph-editor/src/cli/diskLoader.ts` — `YAML.JSON_SCHEMA` fix, `_coerceDatesToStrings` helper
- `graph-editor/src/lib/dslExplosion.ts` — cartesian product syntax fix
- `graph-editor/src/services/dataOperations/querySignature.ts` — `normalizeObjectKeys` (read for understanding, not changed)
- `graph-ops/scripts/bayes.sh` — shell wrapper

**Tests**
- `bayes/tests/test_binding_receipt.py` — 10 receipt contract tests
- `bayes/tests/test_engorged_parity.py` — 6 parity tests (snapshot + priors)
- `graph-editor/src/lib/__tests__/dslExplosion.test.ts` — 52 DSL explosion tests (all pass)

**Docs**
- `docs/current/project-bayes/14-phase-c-slice-pooling-design.md` — §11 (R1/R2 phasing, R1 marked complete), §12.2 (synthetic graphs), §12.5 (regression pipeline), §16 (binding receipt)
- `docs/current/project-bayes/33-snapshot-query-batching.md` — problem statement for per-subject query performance
- `docs/current/codebase/KNOWN_ANTI_PATTERNS.md` — anti-pattern 23 (js-yaml Date conversion)
- `docs/current/codebase/HASH_SIGNATURE_INFRASTRUCTURE.md` — CLI/Node.js context section

**Data repo**
- `nous-conversion/graphs/synth-context-solo.truth.yaml` — truth file with context_dimensions
- `nous-conversion/graphs/synth-context-solo.json` — generated graph
- `nous-conversion/contexts/synth-channel.yaml` — generated context YAML with source mappings
- `nous-conversion/parameters/synth-context-solo-synth-ctx1-anchor-to-target.yaml` — generated param file

---

### Next Steps

1. **R2b — Solo-edge slice pooling**: implement per-slice routing in the evidence binder and the hierarchical model in `bayes/compiler/model.py`. The `synth-context-solo` preflight receipt is the gate test — it must turn green (expected context slices observed, not aggregated). Key files: `bayes/compiler/evidence.py` (slice routing in `_bind_from_snapshot_rows`), `bayes/compiler/model.py` (τ_slice, logit-offset deviations, per-slice likelihoods). Read doc 14 §5.2 for the statistical design.

2. **R2a — Extend synthetic data generator**: the existing `synth-context-solo` truth file works. Additional graphs S2-S5 (branch group, multi-dimension, mixed-epoch, cross-product) can be created as the model supports them. Each follows the same pattern: truth file with `context_dimensions` → `synth_gen.py --write-files` → CLI preflight.

3. **R2c — Branch-group hierarchical Dirichlet**: after solo-edge works, add `κ`, `base_weights`, per-slice `Dirichlet(κ * base_weights)`. Needs graph S2 (branch group + context). Read doc 14 §5.3.

4. **R2d — Per-date routing validation**: mixed-epoch synthetic data, verify no double-counting. Satisfies doc 30 RB-003 contract. Read doc 14 §5.7.

---

### Open Questions

- **Snapshot query batching (doc 33)**: not blocking but should be done before intensive model work on large contexted graphs. The user simplified the design to a single-query approach. Non-blocking.

- **`compute_snapshot_subjects.mjs` has its own `normalizeObjectKeys`**: the harness's hash computation script reimplements normalisation outside the FE service layer. It has the same Date-handling vulnerability but was reverted in this session (the fix was to use `JSON_SCHEMA` in the disk loader instead). If the harness's hash computation diverges from the FE in future, this is the likely cause. Non-blocking — harness bridge confirmed matching.

- **Param files still sent in payload during parity phase**: both `useBayesTrigger.ts` and CLI `commands/bayes.ts` send engorged graph AND param files. Once parity is fully confirmed and the engorged path is the default, param files should be dropped from the payload. Non-blocking.
