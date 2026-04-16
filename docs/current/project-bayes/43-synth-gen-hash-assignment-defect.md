# Doc 43 — Synth Generator Hash Assignment Defect

**Date**: 16-Apr-26
**Status**: Resolved — symptom fixed (silent fallback removed,
verification added). Root cause is doc 43b (context hash parity).
**Severity**: High — masks hash-family bugs in test data; may affect
production graphs with mixed-epoch context structures
**Found during**: asat() blind testing (doc 42b)

---

## Problem

The synth generator (`bayes/synth_gen.py`) assigns bare and contexted
snapshot rows to the **same `core_hash`** for mixed-epoch graphs. This
is incorrect. Per the hash infrastructure design
(`HASH_SIGNATURE_INFRASTRUCTURE.md` §Structured Signatures), a bare
query (`x: {}`) and a contexted query (`x: {"channel": "<def_hash>"}`)
produce different structured signatures and therefore different
`core_hash` values.

## Evidence

`synth-context-solo-mixed` (S3 — mixed-epoch solo edge):

```
synth-meta.json:
  window_hash     = 6VkCjvjrAgKxFlQCo6yJ6g
  ctx_window_hash = ""              ← should be a distinct hash
```

Because `ctx_window_hash` is empty, `_rehash_snapshot_rows()` (line
2001) falls back to `w_hash` for contexted window rows:

```python
ctx_h = (hashes.get(f"ctx_window_hash_{dim_id}")
         or hashes.get("ctx_window_hash", "")
         or w_hash)     # ← fallback assigns bare hash to contexted rows
```

Result in the snapshot DB:

| core_hash | slice_key | anchor range | epoch |
|-----------|-----------|-------------|-------|
| `6VkCjvjr..` | `window()` | 12-Dec-25..25-Jan-26 | 1 (bare) |
| `6VkCjvjr..` | `context(synth-channel:google).window()` | 26-Jan-26..11-Mar-26 | 2 (contexted) |

Both under the same hash. They should be under different hashes.

## Why this is wrong

1. **Hash semantics violated.** The `core_hash` is a hash of the full
   structured signature `{"c":"...","x":{...}}`. A bare query has
   `x: {}`. A contexted query has `x: {"synth-channel": "<hash>"}`.
   These are different inputs and must produce different `core_hash`
   values.

2. **Test data masks bugs.** Any code that relies on hash-family
   separation to distinguish bare from contexted data will appear to
   work on this test data (both are under the same hash) but fail on
   production data where the hashes are correctly distinct.

3. **Slice-key filtering becomes the only discriminator.** With bare
   and contexted rows under the same hash, a query filtering by
   `core_hash` alone gets both families. The `slice_key` filter must
   then separate them. This works accidentally but violates the
   two-level filtering design (hash for dimension, slice for value).

4. **Regime selection affected.** `select_regime_rows()` expects
   different `core_hash` values per context dimension. If bare and
   contexted share a hash, the regime selector cannot distinguish them
   by hash — it must fall back to slice_key parsing, which it may not
   do.

## Root Cause (probable)

The CLI call logic in `synth_gen.py` (lines 3226–3303) splits the
DSL into clauses and makes one CLI call per clause. For S3, the DSL
is `(window(...);cohort(...))(context(synth-channel))`, which should
expand to four clauses:

1. `window(...)` — bare window → `window_hash`
2. `cohort(...)` — bare cohort → `cohort_hash`
3. `context(synth-channel).window(...)` — contexted window → `ctx_window_hash`
4. `context(synth-channel).cohort(...)` — contexted cohort → `ctx_cohort_hash`

If clause 3 is not generated (DSL expansion issue) or the CLI call
for it fails/returns no subjects, `ctx_window_hash` stays empty.

The `_need_bare` logic at line 3279 handles the case where bare
hashes are missing but contexted ones exist. There is no
corresponding logic for the reverse (contexted hashes missing when
bare ones exist) — which is this case.

## Impact

- `synth-context-solo-mixed` (S3) — confirmed affected
- `synth-fanout-context-mixed` (S4) — likely affected (same epoch
  structure)
- `synth-context-staggered` — may be affected (has epochs with
  `emit_dimensions` lists)
- Any future mixed-epoch synth graph

## Suggested Fix

1. Ensure the CLI call loop generates a contexted window clause for
   every context dimension that appears in any epoch
2. If a CLI call returns no subjects for a clause, log an error
   rather than silently leaving the hash empty
3. Make `_rehash_snapshot_rows` fail hard (not fall back to `w_hash`)
   when a contexted row has no matching contexted hash — this turns a
   silent data corruption into a visible error
4. Add a verification step that checks: for every (hash, slice_key)
   combination in the generated rows, the hash family is correct for
   the slice_key family (bare hash ↔ bare slice, contexted hash ↔
   contexted slice)
