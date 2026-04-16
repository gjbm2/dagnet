# Doc 43b — Context Hash Parity Defect

**Date**: 16-Apr-26
**Status**: Resolved (16-Apr-26)
**Severity**: High — bare and contexted queries produce identical
`core_hash`, breaking hash-family separation for all contexted graphs
**Found during**: synth-context-solo-mixed regen after doc 43 fix
**Blocks**: regeneration of any mixed-epoch synth graph

## Resolution

Two fixes applied.

### Fix 1: DSL explosion (doc 43)

`explode_dsl()` replaced the naive `;` split in `synth_gen.py`, so
each CLI call receives a properly atomic clause as `dataInterestsDSL`.
The signature pipeline correctly extracts context keys from the
individual clause (bare gets `x: {}`, contexted gets
`x: {"dim": "<hash>"}`). Verified by integration test
(`querySignature.contextParity.test.ts`).

### Fix 2: Filter supplementary subjects in synth_gen hash collection

The actual root cause: `bayes.ts` injects **supplementary subjects**
via `candidateRegimeService` (lines 250-265). These are hash families
discovered from parameter files on disk, added so the worker can query
the DB for historical/alternative regimes. When a contexted CLI call
(e.g. `window(f:t).context(synth-channel)`) runs on a graph whose
param files contain bare signatures, the candidate regime service adds
a supplementary subject with the bare `core_hash` to the contexted
call's output.

`synth_gen.py`'s hash collection loop then processes all subjects from
the contexted call. The supplementary subject (bare hash) passes the
`is_ctx_clause` check (the clause still contains `context(`) and
**overwrites** the correct contexted hash in `ctx_window_hashes`.

Fix: two guards in the hash collection loop:
1. Skip subjects with `subject_id` starting with `supp_`
   (supplementary subjects from candidate regimes)
2. Verify each subject's `canonical_signature` context keys (`x`
   field) match the clause family: contexted clauses only accept
   subjects with non-empty `x`, bare clauses only accept `x: {}`

### Cleanup

- `compute_snapshot_subjects.mjs` deleted (obsolete, anti-pattern #28)
- `_compute_fe_hashes()` dead code removed from `test_harness.py`
- Hash-family separation tests in `coreHashService.test.ts`
- Full pipeline parity test in `querySignature.contextParity.test.ts`
- Diagnostic output in `synth_gen.py` Step 2 showing `x` field per
  subject

---

## Problem

`computeQuerySignature` produces the **same `core_hash`** for a bare
query and a contexted query on the same graph edge. Per the hash
infrastructure design (`HASH_SIGNATURE_INFRASTRUCTURE.md`), these
must be different: the bare query has `x: {}` (no context def hashes)
while the contexted query has `x: {"synth-channel": "<def_hash>"}`.
Different `x` → different canonical signature → different `core_hash`.

## Evidence

Regenerating `synth-context-solo-mixed` with the doc 43 verification
fix produces:

```
CLI call 1 (ctx_window): 4 subjects → ctx_w[synth-channel]=6VkCjvjrAgKxFlQC…
CLI call 3 (bare window): 1 subject → w=6VkCjvjrAgKxFlQC…
```

Both produce `6VkCjvjrAgKxFlQCo6yJ6g`. The verification step then
correctly fails:

```
ValueError: Hash-family verification FAILED:
  bare and contexted rows share core_hash {6VkCjvjrAgKxFlQC…}
```

## Why these should differ

The canonical signature is `{"c":"<identityHash>","x":{<contextDefHashes>}}`.

- **Bare window query** (`window(12-Dec-25:11-Mar-26)`):
  `{"c":"<hash>","x":{}}` — empty context def hashes

- **Contexted window query** (`window(12-Dec-25:11-Mar-26).context(synth-channel)`):
  `{"c":"<hash>","x":{"synth-channel":"<def_hash>"}}` — includes context definition hash

`core_hash = computeShortCoreHash(serialiseSignature(...))`, so
different `x` values → different SHA-256 input → different `core_hash`.

Unless the bare query is somehow picking up context def hashes too,
or the contexted query is not including them.

## Possible Root Causes

1. **`computeQuerySignature` includes context def hashes even for
   bare queries.** If the function reads context definitions from the
   graph's `dataInterestsDSL` rather than from the query's context
   clause, a graph with `dataInterestsDSL` containing
   `context(synth-channel)` would include the def hash even for a bare
   query that doesn't mention context.

2. **`contextRegistry` returns context definitions for all dimensions
   regardless of query.** If `extractContextKeysFromConstraints`
   returns all registered context keys instead of only those in the
   query DSL, the bare query would get the same context def hashes as
   the contexted one.

3. **The CLI's `compute_snapshot_subjects.mjs` (or `bayes.ts`) passes
   context keys from the graph rather than from the DSL clause.** The
   synth generator calls the CLI with a DSL like `window(12-Dec-25:11-Mar-26)` (no context). If the CLI resolves context keys from the
   graph's pinned DSL or from context files on disk rather than from
   the query DSL, the bare hash includes context dimensions it
   shouldn't.

Root cause 1 or 3 is most likely. The anti-pattern is documented as
**AP 11** in `KNOWN_ANTI_PATTERNS.md`: "Signatures from graph config
— Read path uses `dataInterestsDSL` instead of stored slice topology
→ wrong context keys → wrong hash."

## Impact

- **All contexted synth graphs** produce identical bare and contexted
  hashes. The hash-family separation that the signature infrastructure
  is designed to provide does not work.

- **Mixed-epoch synth graphs cannot be regenerated** after the doc 43
  verification fix — they correctly fail the consistency check.

- **Production graphs** may have the same issue. If bare queries on a
  graph with context dimensions produce contexted hashes, the snapshot
  DB has no way to distinguish bare from contexted data by hash.

- **Regime selection** relies on hash-family separation to distinguish
  context dimensions. If all dimensions share one hash, regime
  selection cannot distinguish them (falls back to slice_key parsing).

## Relationship to Doc 43

Doc 43 identified that the synth generator assigned bare and contexted
rows to the same hash. The immediate cause was the fallback to
`w_hash` when `ctx_window_hash` was empty. Doc 43's fix (remove
fallback, add verification) correctly prevents the symptom.

This doc identifies the **upstream cause**: the CLI's hash computation
produces the same hash for bare and contexted queries, so
`ctx_window_hash` equals `w_hash` (not empty — equal). The synth
generator's `_rehash_snapshot_rows` was never the problem — it was
faithfully applying the hashes the CLI computed.

## Suggested Investigation

1. Add a diagnostic to the synth generator's CLI call loop that prints
   the full canonical signature (not just core_hash) for each clause.
   Compare the `{"c":..., "x":...}` objects for bare vs contexted
   calls. If `x` is identical, the bug is in `computeQuerySignature`.

2. Check `extractContextKeysFromConstraints` in `querySignature.ts` —
   does it extract keys from the DSL string, or from the graph/edge
   config? If the latter, bare queries pick up context keys they
   shouldn't have.

3. Check the CLI entry point (`bayes.ts` or `compute_snapshot_subjects.mjs`) — how does it resolve context keys for the query signature? Does it pass the DSL's context clauses, or the graph's registered dimensions?
