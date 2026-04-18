# Doc 47 — Prose Test Designs

**Date**: 18-Apr-26
**Gate**: These designs must be reviewed before any test or implementation
code is written.

## Testing foundation

The primary testing tool is the CLI `analyse.sh` command, which already
has a `conditioned_forecast` dispatch path (analyse.ts lines 320–344).
This exercises the full FE preparation pipeline (aggregation, candidate
regime building, subject/temporal DSL splitting) and dispatches to the
real BE endpoint — same code path as the browser.

Shell-script parity tests (following the pattern of `v2-v3-parity-test.sh`
and `chart-graph-agreement-test.sh`) are the established integration
testing pattern in this project. They use `analyse.sh` and `param-pack.sh`
as building blocks, compare outputs with inline Python or jq, and
produce a pass/fail tally.

Tests 1–4 below form a single shell script:
`graph-ops/scripts/conditioned-forecast-parity-test.sh`

Test 5 is a TypeScript unit test exercising the FE application path.

---

## Test 1: Contract — temporal-only request yields edges

**Real bug**: the current handler receives no `analytics_dsl` from the FE
caller, fails to resolve any subjects, and returns zero edges.

**What is real**: everything. CLI analyse → FE preparation → candidate
regime building → BE handler → subject resolution → snapshot DB.

**What is mocked**: nothing.

**Shape**: run `analyse.sh` with `--type conditioned_forecast` and
`--topo-pass`, providing only a temporal DSL (no `--subject` flag).
Extract the response with `--get scenarios` or pipe the full JSON.
Assert:

- The response has `success: true`.
- At least one edge result exists with a non-null `p_mean`.
- Every parameterised edge that has snapshot data in the DB appears in
  the edges list (compare against the graph's edge count or a known
  edge UUID).

**How it runs**:

    RESULT=$(bash graph-ops/scripts/analyse.sh "$GRAPH" "window(-90d:)" \
      --type conditioned_forecast --topo-pass --format json 2>/dev/null)
    N_EDGES=$(echo "$RESULT" | python3 -c "
    import json, sys
    r = json.load(sys.stdin)
    edges = r.get('scenarios', [{}])[0].get('edges', [])
    print(len([e for e in edges if e.get('p_mean') is not None]))
    ")
    # Assert N_EDGES > 0

**False pass**: a stub returning hardcoded scalars. Guarded by Test 3.

---

## Test 2: Regime selection — broad read survives the batch path

**Real bug**: the batched snapshot query narrows by primary `core_hash`
only, missing rows under equivalent hashes or fallback families.

**What is real**: everything via CLI.

**What is mocked**: nothing.

**Shape**: for each edge in the conditioned forecast result, compare
`n_cohorts` against the value from the single-edge v3 chart path for
the same edge. The v3 path already does the broad read correctly. If
the batch path drops equivalent-hash rows, `n_cohorts` will be lower.

    # Run conditioned forecast (whole-graph, no subject)
    WG=$(bash graph-ops/scripts/analyse.sh "$GRAPH" "$DSL" \
      --type conditioned_forecast --topo-pass --format json 2>/dev/null)

    # Run v3 chart for each edge (single-edge, with subject)
    for each edge (from_id, to_id):
      V3=$(bash graph-ops/scripts/analyse.sh "$GRAPH" \
        "from($from_id).to($to_id).$DSL" \
        --type cohort_maturity --topo-pass --format json 2>/dev/null)
      # Compare n_cohorts

If the synth data has no genuine equivalent-hash rows, the test should
report SKIP rather than a vacuous PASS.

**False pass**: single-hash-family data. Guarded by skip detection.

---

## Test 3: Parity — whole-graph p_mean matches v3 chart reference

**Real bug**: the whole-graph pass computes a different `p_mean` than
the v3 chart for the same edge, temporal mode, and date range.

**What is real**: everything via CLI — both paths exercise the full
end-to-end pipeline.

**What is mocked**: nothing.

**Shape**: for each parameterised edge with snapshot data:

1. Run the v3 chart path via `analyse.sh --type cohort_maturity` with
   an explicit `--subject "from(X).to(Y)"` and the same temporal DSL.
   Extract `midpoint` at `max_tau` from the last maturity row — this
   is the v3 conditioned asymptotic rate.

2. Run the whole-graph conditioned forecast via `analyse.sh
   --type conditioned_forecast` with temporal DSL only (no subject).
   Extract `p_mean` for the same edge UUID.

3. Assert `abs(whole_graph_p_mean - v3_midpoint) < tolerance`.

The reference value is the v3 chart midpoint at max_tau (the IS-
conditioned asymptotic rate), not the topo pass p.mean (which is the
unconditioned blended rate). The tolerance should be tight (0.005) to
catch systematic errors while allowing for MC sampling variance.

**Degenerate case**: also compare on synth-simple-abc (2 edges, linear
chain) where the whole-graph pass should produce near-identical results
to the single-edge path, isolating the outer loop from the carrier cache.

**How it runs** (per edge, inside a loop):

    V3_MIDPOINT=$(bash graph-ops/scripts/analyse.sh "$GRAPH" \
      "from($FROM).to($TO).$DSL" --type cohort_maturity \
      --topo-pass --format json 2>/dev/null \
      | python3 -c "
    import json, sys
    r = json.load(sys.stdin)
    rows = r.get('result', {}).get('maturity_rows', [])
    last = rows[-1] if rows else {}
    print(last.get('midpoint', 'null'))
    ")

    WG_PMEAN=$(echo "$WG_RESULT" | python3 -c "
    import json, sys
    r = json.load(sys.stdin)
    edges = r.get('scenarios', [{}])[0].get('edges', [])
    for e in edges:
        if e.get('edge_uuid') == '$EDGE_UUID':
            print(e.get('p_mean', 'null'))
            break
    ")

    # Compare within tolerance

**False pass**: path that copies from v3 cache. Not realistic since
paths are structurally different.

---

## Test 4: Carrier fidelity — empirical upstream evidence preserved

**Real bug**: the node arrival cache uses `upstream_obs=None`, silently
downgrading edges that currently get Tier 2 empirical carriers. The
resulting p_mean would be shifted.

**What is real**: everything via CLI.

**What is mocked**: nothing.

**Shape**: this is a diagnostic extension of Test 3 — it identifies
*which* edges diverge and *why*. On a multi-edge graph (at least
A→B→C), the parity comparison for the downstream edge B→C is the key
signal. If the carrier is wrong, B→C's p_mean will diverge from the
v3 reference even when A→B's p_mean matches.

Rather than a separate test, this is implemented as a diagnostic table
in the Test 3 output. For each edge:

    edge_id | v3_midpoint | wg_p_mean | delta | is_downstream | PASS/FAIL

If a downstream edge fails parity while its upstream edge passes, the
diagnostic points directly at the carrier cache.

**False pass**: on a graph where every edge's from-node is a START node,
no carrier propagation occurs. Guarded by using synth-simple-abc which
has intermediate nodes.

---

## Test 5: FE integration — canonical batch apply path

**Real bug**: `applyConditionedForecastToGraph` mutates `graphEdge.p.mean`
directly, bypassing `UpdateManager.applyBatchLAGValues`. This skips
sibling rebalancing, graph cloning, and derived field updates.

**What is real**: TypeScript service code, realistic graph structure with
sibling edges.

**What is mocked**: the BE response (the bug is in the FE application
logic, not the BE computation).

**Shape**: construct a graph with node A having two sibling edges A→B
(p.mean=0.6) and A→C (p.mean=0.4). Apply a conditioned forecast result
that sets A→B p_mean=0.7. Assert:

1. A→B.p.mean is 0.7 (applied).
2. A→C.p.mean has been rebalanced (should be 0.3, not still 0.4).
3. The graph object is a new reference (cloned, not mutated in place).
4. Derived fields (p.forecast.mean, etc.) are consistent.

**Placement**: Vitest test in
`graph-editor/src/services/__tests__/conditionedForecastService.test.ts`.

**False pass**: checking only A→B without checking sibling consistency.
The sibling sum assertion is the key discriminator.

---

## Script structure

`graph-ops/scripts/conditioned-forecast-parity-test.sh`:

    Phase 0: Data health checks
      - Graph JSON exists with expected edges
      - Snapshot DB has rows for each edge (reuse existing helpers)
      - Hydrate graph if not already enriched

    Phase 1: Contract test (Test 1)
      - analyse.sh --type conditioned_forecast, temporal only
      - Assert edges returned > 0

    Phase 2: Parity comparison (Tests 2, 3, 4)
      - For each edge: run v3 chart reference, extract midpoint
      - Run whole-graph conditioned forecast, extract per-edge p_mean
      - Compare field by field, produce diagnostic table
      - Report PASS/FAIL per edge and overall

    Summary: N tests, M passed, K failed

Prerequisites:
  - Python BE running on localhost:9000
  - Synth graph generated and hydrated
