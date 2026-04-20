# Synth Context File Sharing Contract

## Why this doc exists

Synth truth YAMLs in `bayes/truth/` declare `context_dimensions[]` with a
`id:` field. During bootstrap, `bayes/synth_gen.py:write_context_files`
renders each dim to a YAML file at `<data-repo>/contexts/<dim_id>.yaml`.

**Context files are keyed by dim id, not by truth name.** Multiple truths
that declare the same dim id share the same rendered file. Bootstrapping
one truth can change the file another truth depends on. Without
governance this produces silent data corruption — DB rows registered
under one dim-definition hash outlive the file that produced them.

This doc is the contract that makes sharing safe.

## The sharing model

Legitimate cases:
1. **Identical definitions**: many truths declare the dim with the same
   values, labels, and sources. Bootstrap of any of them is a no-op for
   the file. This is the common case within a family (e.g. all
   `synth-*-sparse-*` graphs share `synth-channel` because they want
   comparable regime structure).
2. **Deliberate redefinition**: a newer truth changes the dim
   (new labels, new sources). The file overwrite is intentional; every
   graph previously bootstrapped against the old definition is now
   stale and must re-bootstrap before being trusted.

Illegitimate case — prevented by the assurance chain:
- A truth silently overwrites a sibling's file and nobody notices,
  causing regression runs to bind against DB rows that no longer
  correspond to the on-disk dim. This is exactly the defect that
  motivated this contract.

## Assurance chain

Three layers, each load-bearing:

1. **Bootstrap warning** (`write_context_files`). On a content-changing
   overwrite, prints a prominent warning listing every graph whose
   `synth-meta.json` had pinned the old file hash. Those graphs must
   re-bootstrap before they can be used.
2. **Meta sidecar pin** (`save_synth_meta`). Every bootstrap records
   `context_file_hashes: {<dim_id>: sha256}` in the graph's
   `synth-meta.json`. This is the anchor the freshness check compares
   against.
3. **Freshness check** (`verify_synth_data`). Re-hashes every context
   file referenced in meta and returns `stale` if any pinned hash no
   longer matches, with reason "Context definition changed". The
   regression runner calls this before any fit; stale graphs are
   refused at the door, not mid-run.

Additionally, an **FE-parity probe** in `verify_synth_data` runs the FE
CLI against the current graph state and checks that every computed
`core_hash` retrieves DB rows. This catches drift sources the file-hash
layer cannot see (e.g. FE canonicalisation rule changes).

## When to share vs namespace a dim id

Share the same dim id when truths want to be **semantically comparable**
on that dimension — the values mean the same thing, the sources are the
same, and a joint analysis across those truths would be meaningful.

Namespace the dim id (e.g. `synth-channel-lifecycle` instead of
`synth-channel`) when the semantics genuinely differ — different
labels, different weights, different temporal lifecycles. Sharing a dim
id across semantically distinct definitions is a modelling error that
will produce confusing results even once the assurance chain flags it.

Convention for synth sweeps: one dim id per intended semantic group.
The sparsity sweep has two groups:
- `synth-channel` — sparse/mixed/two-dim variants, stable
  `{Google, Direct, Email}` labelset.
- `synth-channel-lifecycle` — lifecycle variants, labels
  `{Baseline (A), Treatment B, Treatment C}` with per-value
  `active_from_day`/`active_to_day`.

## Operational flow after a redefinition

1. Run bootstrap on the redefining truth. Note the warning block —
   which graphs it names.
2. Re-bootstrap each named graph so its DB rows re-anchor to the new
   definition.
3. Run the regression plan. `verify_synth_data` will no longer report
   stale for any of them.

If a graph is missed in step 2, the plan runner will refuse to fit it
and print the stale reason, not produce misleading results.

## What can still go wrong

The three layers above cover every file-level cause of drift we've seen.
The known residual risk is FE-level drift: a change in how the FE
canonicalises context definitions that produces a different dim hash
for identical file content. The FE-parity probe is the only catch for
this, and it runs at regression start — not in CI. A targeted unit test
that pins a fixture context def to an expected dim hash (in
`graph-editor/src/services/__tests__/`) would move that catch earlier.
That's a separate piece of work.
