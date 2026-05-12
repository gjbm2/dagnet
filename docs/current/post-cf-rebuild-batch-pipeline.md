# Post-CF-Rebuild Test Audit Batch Pipeline

**Date opened**: 7-May-26
**Driver**: triage and clear the 76 lib-suite failures catalogued in
[`post-cf-rebuild-py-test-audit-7-may-26.md`](post-cf-rebuild-py-test-audit-7-may-26.md)
without losing per-test discipline or letting recipe-driven work paper over real
regressions.

This document defines the **pipeline**, not the work. The audit is the
ground-truth diagnosis; this pipeline is how diagnosis becomes approved actions
and verified outcomes.

---

## When to use

When a single audit categorises tens of failures and most are recipe-application
(STALE-CONTRACT, RETIRE, TEST-INFRA, DEFER-Nq) but a non-trivial minority are
NEEDS-INVESTIGATION or possible REAL-REGRESSION. The pipeline is opt-out review:
the agent applies the audit's prescribed action by default; the user marks
items to hold.

If the failure population is small (< 10) or the categorisation is uncertain,
handle case-by-case in conversation — the manifest overhead isn't worth it.

---

## Inputs

A completed audit document with per-file diagnosis and category badges. The
audit must already have:

- A per-file failure pattern,
- A category (RETIRE-V2, STALE-CONTRACT, STALE-73N, NEEDS-INVESTIGATION,
  TEST-INFRA, CASCADE, MERGE-OUTSIDE-IN, etc.),
- A specific recommendation per file (or per test, for mixed-confidence files).

The pipeline does not re-derive diagnoses. If the audit is incomplete or
ambiguous, fix the audit first.

---

## Outputs

- `docs/current/post-cf-rebuild-batches/phase-N-batch-X-<cluster>.md` — one
  triage manifest per batch.
- `docs/current/post-cf-rebuild-batches/phase-N-exceptions.md` — accumulated
  held / dropped items at the end of each phase.
- One git commit per executed batch (or per test for mixed-confidence batches).
- A final paragraph appended to the audit doc linking to all manifests as the
  historical record.

---

## Phase structure

Phases run **sequentially**. Batches within a phase may run in parallel where
the daemon-contention rule below allows.

- **Phase 1 — sequential, mechanical**. High-volume work that shrinks the
  suite: sweep-deletes of RETIRE-V2 files, tombstone removals, defer-xfails
  with clearance lines into the relevant Nq plan. Done first because it
  reduces daemon-cascade noise and false-positive volume in subsequent
  verify runs.
- **Phase 2 — parallel-eligible recipe batches**. Each batch is a cluster of
  tests with the same prescribed action (e.g. all `metadata.model_curves`
  rewrites). Touches independent test files. Parallel by cluster, capped by
  daemon contention.
- **Phase 3 — solo / careful**. Real-regression work and wallclock-flakiness
  fixes that need sustained context, not a recipe. Single agent, single thread.

---

## Confidence / risk taxonomy

Every test row in a manifest carries a Confidence and Risk label.

**Confidence** — how dictated the fix is by the audit:

- **H** — audit names exact replacement (field rename, kwarg add, file delete).
  Mechanical.
- **M** — audit names category; one short code read is needed before applying
  the fix (e.g. resolve the new field name in the response shape).
- **L** — NEEDS-INVESTIGATION territory. Could still be a real bug. Default to
  held until reviewed in conversation.

**Risk** — blast radius of the proposed action:

- **L** — test-only edit, fully reversible by git.
- **M** — deletes test coverage (RETIRE / TOMBSTONE / strict-to-xfail
  conversion).
- **H** — would change runtime, or could silently mask a real defect.

Anything Confidence:L or Risk:H is held by default; the agent does not auto-process
those without explicit user proceed.

---

## Manifest format

One markdown file per batch. Skeleton:

```
# Phase N / Batch X — <cluster name>

**Cluster:** <one-line summary>.
**Audit refs:** <links to audit sections / regression-tracker entries>.
**Verify command:** <exact pytest command, batch-scoped, not full suite>.
**Touches:** <test files only | runtime | golden fixtures>.
**Predicted Δ:** <N fails → 0 fails>.

| ✓ | Conf | Risk | Test | Action | Rationale |
|---|------|------|------|--------|-----------|
| [ ] | H | L | `<file>::<test>` | <one-line proposed change> | <why per audit + code citation> |
```

Optional appended sections after execution:

- **Verify run — <date>**: before/after counts, command run, daemon state.
- **Open questions**: anywhere the agent flagged uncertainty for the user.

The manifest is the immutable record of what was proposed and what executed.
Once a batch is processed and verified, the manifest is not edited further;
amendments go in the exceptions file.

---

## Tick semantics

- `[ ]` — default. Proceed.
- `[~]` — hold. Skip this batch; revisit at end of phase.
- Strikethrough on the row — drop entirely (user disagrees with the action).

After user review, anything still `[ ]` is processed without further
confirmation. The agent never escalates a `[~]` or struck row on its own.

---

## Process loop per batch

1. Agent generates the manifest only, reports the path, waits.
2. User reviews; marks `[~]` or strikes through; types `proceed`.
3. Agent applies only `[ ]` items. **One commit per cluster** is the default;
   one commit per test for mixed-confidence batches where some rows might
   bounce.
4. Agent runs the batch-scoped verify command — never the full suite at this
   stage.
5. Agent appends a Verify-run section to the manifest with before/after
   counts.
6. Held and dropped items are mirrored into `phase-N-exceptions.md` with
   original Conf / Risk / Rationale preserved.
7. Agent reports completion and waits for the next batch's go-ahead.

---

## Verify discipline

- Batch-scoped verify after every executed batch. Heavy outside-in oracle is
  excluded with `--ignore` unless the batch specifically targets it.
- Full-suite verify once per phase, after all that phase's batches complete.
- Never claim a fix until the verify command shows the count change predicted
  in `Predicted Δ`.
- If verify shows unexpected new failures: stop, do not commit, report. The
  manifest is wrong, the audit is wrong, or there's a cross-batch interaction.

---

## Daemon contention rule

The analyse daemon (`graph-editor/src/cli/daemon.ts`) is a shared resource. Even
with the auto-restart and idle-timeout extension landed on `_daemon_client.py`,
parallel verify runs that hit the daemon will produce false-positive cascade
failures.

Therefore:

- Phase 2 parallelism applies only to **direct-Python** test batches.
- Batches that exercise the daemon (outside-in CLI files) run **serially**,
  one batch at a time.
- A batch that mixes both runs solo.

If you're unsure whether a batch hits the daemon, grep for `_daemon_client` or
`analyse.sh` in the touched test files. If either appears, it's daemon-using.

---

## Held / dropped items at end of each phase

Each phase ends with a rollup written to `phase-N-exceptions.md`:

- Every held item with its original row data.
- A one-line note per item: escalate to next phase, defer to a tracked plan
  (with link), or open a regression-tracker entry.

The exceptions file is the input to the next pass — whether that's the next
phase or a later sweep. Held items do not silently age out.

---

## End-of-pipeline rollup

After all phases complete:

- Single full-suite pytest run with the canonical command from the audit.
- Net counts: starting fail/error count → ending fail/error count, alongside
  the audit's predicted breakdown.
- Every held item is either resolved, deferred (with a tracked-plan link), or
  accepted as known-red (with a regression-tracker citation).
- The audit doc is updated with a closing paragraph linking to every batch
  manifest and the exceptions file. The audit becomes the historical index;
  the manifests are the receipts.

---

## Reusability

This pipeline is generic to *post-large-refactor test triage*. Re-use by:

1. Producing a new audit doc (per-file, categorised, with recommendations).
2. Creating a new `post-<event>-batches/` directory.
3. Following the phase / batch / verify structure here, replacing
   `post-cf-rebuild-batches` with the new event name.

The confidence / risk taxonomy and tick semantics are stable across episodes.
The phase split (mechanical → recipe-parallel → solo-careful) is the only thing
that changes shape with the audit's category mix.

---

## Open questions / decisions to record

- **Pre-fix output column.** Should the manifest include a one-line truncated
  current failure message per row, alongside the proposed action? Pro: useful
  forensic record if anything resurfaces months later. Con: noisier table on
  ~30-row Phase 1 batches. Decision: not yet taken — record per batch in the
  manifest header if included.
- **Scope of daemon serialisation rule.** Currently treats any
  `_daemon_client` import as daemon-using. May be too conservative if a test
  file imports the client but doesn't actually spawn the daemon under the
  selected test selectors. Decision: revisit if Phase 2 parallelism turns out
  to be the bottleneck.

---

## Cross-references

- Audit (input): [`post-cf-rebuild-py-test-audit-7-may-26.md`](post-cf-rebuild-py-test-audit-7-may-26.md)
- Outside-in oracle (excluded from suite during this work):
  [`graph-editor/lib/tests/test_cohort_factorised_outside_in.py`](../../graph-editor/lib/tests/test_cohort_factorised_outside_in.py)
- Outside-in regression tracker (home for any real-regression residue):
  [`cohort-outside-in-post-73n-regression-tracker.md`](cohort-outside-in-post-73n-regression-tracker.md)
- 73q plan (target for DEFER-73Q clearance lines):
  [`project-bayes/73q-daily-conversions-shared-runtime-cutover-plan.md`](project-bayes/73q-daily-conversions-shared-runtime-cutover-plan.md)
