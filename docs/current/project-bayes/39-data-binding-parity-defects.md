# Doc 39: Data Binding Parity Defects — Problem Statement

## The problem

The Bayes data binding pipeline has no end-to-end parity tests. It has multiple code paths that are meant to produce equivalent results under different configurations (contexted vs bare DSL, FE CLI vs harness, with/without regime selection, with/without MECE aggregation). These paths drift silently because nothing checks that the same underlying DB rows produce the same modelled data volume regardless of which path processes them.

Every defect found during the 12-Apr-26 investigation was a data binding parity failure — the same DB rows produced different `total_n`, different trajectory counts, different numbers of subjects, or different regime selection outcomes depending on configuration. None of these were caught by existing tests.

## Defects found (12-Apr-26)

1. **"Largest non-MECE context as aggregate proxy"** (`evidence.py`). When all DB rows were context-qualified and the dimension wasn't declared MECE, the binder silently substituted a single context slice as the aggregate. The model ran on ~1/3 of the data. No test caught this.

2. **Harness duplicate payload builder** (`test_harness.py`). The `--graph` mode built its own subjects, omitting `mece_dimensions`, `candidate_regimes_by_edge`, and supplementary hash discovery. The FE CLI had all of these. Both paths claimed to produce valid payloads. No test compared them.

3. **Step 5 supplementary hash discovery: window only** (`candidateRegimeService.ts`). `bareTemporal` was set to `explodedSlices[0]` — the first exploded slice only. For `window(...);cohort(...)`, this was always `window(...)`. Cohort hashes were never discovered. The bare-DSL path fetched half the data. No test checked that supplementary discovery finds both temporal modes.

4. **Step 5 window/cohort as competing regimes** (`candidateRegimeService.ts`). Supplementary candidates were added as separate entries per temporal mode. Regime selection picked one and dropped the other, discarding half the rows post-fetch. No test checked that candidate regimes group temporal modes correctly.

5. **`total_n` counted regime-stripped aggregate, not modelled data** (`evidence.py`). When slices were exhaustive and the aggregate was suppressed, `total_n` reported the gutted aggregate total. The per-slice data (which is what the model actually uses) was not reflected. The binding receipt showed `total_n=50,260` when the model used `total_n=100,520`. No test checked that `total_n` reflects actual modelled volume.

## The pattern

Every defect has the same shape: **two code paths that should produce equivalent results don't, and nothing checks**.

- FE CLI builds payload → harness builds payload → different subjects
- Contexted DSL binds data → bare DSL binds same data → different `total_n`
- Step 3 discovers hashes (window+cohort grouped) → Step 5 discovers hashes (window only, ungrouped) → different regime selection
- Aggregate `total_n` → per-slice `total_n` → different numbers for same data

The root cause is not any individual bug. It is the absence of **parity invariants** that assert: "given identical DB rows, these two configurations must produce the same modelled data volume."

## What parity tests must cover

The following invariants should hold and should be tested with real data (not mocks):

### Invariant 1: total_n parity
Given the same DB rows for an edge, `ev.total_n` must be the same regardless of whether the DSL is contexted or bare. The model may decompose the data differently (per-slice vs aggregate), but the total observation volume entering the model must be identical.

### Invariant 2: subject completeness
Given a graph with contexted data in the DB, the FE CLI must produce subjects that cover ALL hashes under which data is stored — both window and cohort, both bare and contexted. No hash with data in the DB should be missing from the subject list.

### Invariant 3: candidate regime grouping
Window and cohort hashes for the same context key-set must be grouped into one candidate regime (primary + equivalents). They must never appear as separate competing candidates. This must hold for DSL-derived candidates (Step 2-3) AND supplementary candidates (Step 5).

### Invariant 4: regime selection preservation
Regime selection must not reduce `db_rows` post-regime when the candidate regimes are correctly grouped. If window and cohort are equivalents of the same candidate, regime selection should retain both.

### Invariant 5: MECE aggregation completeness  
When a dimension is declared MECE and all context values are present in the data, MECE aggregation must produce the same aggregate totals as the bare (uncontexted) path would. No context rows should be silently dropped or replaced with a single-channel proxy.

### Invariant 6: payload equivalence
The FE CLI payload and any alternative payload builder (harness, tests) must produce identical `snapshot_subjects`, `mece_dimensions`, and `candidate_regimes_by_edge` for the same graph and DSL. There must be ONE canonical code path, not parallel implementations.

## Test approach

These tests must be **blind** (written from the invariants above, not from reading the current implementation) and must use **real data** (the synth-simple-abc-context graph with its 58,500 DB rows). They must hit the real snapshot DB, not mocks.

Each test runs two configurations on the same underlying data and asserts the parity invariant holds. If the invariant fails, the test names which configuration produced which value — making the defect immediately diagnosable.
