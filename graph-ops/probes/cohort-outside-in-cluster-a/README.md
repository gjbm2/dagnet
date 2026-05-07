# Cluster A — Two-Clock Root-Day Defect Probes

Probes used during the 7-May-26 investigation of the post-73n
Cluster A failures in
`graph-editor/lib/tests/test_cohort_factorised_outside_in.py`.

See `docs/current/cohort-outside-in-post-73n-regression-tracker.md`
§Cluster A "Two-clock root-day defect" for the full forensic record.

## Probes

| File | Purpose |
|---|---|
| `probe_simple_evidence.py` | Run the SIMPLE single-hop test through the daemon `analyse` path with `--diag` and dump carrier/subject surface row_lineage, primitive bindings, emitted cells, and per-row evidence values. The pre-fix output showed all carrier rows with `obs∈{2026-03-01, 2026-03-02}` having `placements=[]` and `clock=no_prefix_arrival_root_day_shares`, with cells emitted only for `anchor_day=2026-03-03`. Post-fix the placements cover all three anchors. |
| `probe_lat4_evidence.py` | Same diagnostic surface for the LAT4 multi-hop fixture. The longer carrier span (A→B→C) pushes the subject scope `date_from` further past the cohort range, so the runtime's pre-fix carrier map dropped even more anchors. |
| `probe_db_rows.py` | Enumerate raw window-family snapshot rows for SIMPLE A→B in the carrier binding scope. Used to derive per-anchor `k_w` time-series and confirm summing the three anchors at τ=8 gives exactly the oracle's 2696. Excludes the supersession hypothesis. |
| `probe_envelope_maps.py` | Inspect the envelope-time `RequestEnvelopePlan.carrier_arrival_map` and `subject_arrival_map` directly. Confirmed pre-fix that the envelope already rooted correctly on the cohort A-anchor range — the runtime's parallel construction was the divergence, not the envelope. |

## Invocation

All probes assume the dev server is running and `graph-editor/venv`
is activated. Run from the repo root:

```
. graph-editor/venv/bin/activate
python graph-ops/probes/cohort-outside-in-cluster-a/probe_simple_evidence.py
```

The first three rely on the dagnet-cli daemon being live (auto-spawn
via `_daemon_client.get_default_client()`). The fourth talks to the
DB directly via `snapshot_service`.
