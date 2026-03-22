# Integrity Check Additions (Mar-26)

**Created**: 22-Mar-26
**Context**: Checks added during synthetic data generator development to
catch structural issues that prevented FE rendering.

---

## New Checks Added

### 1. Mass Conservation Warning (#4)

**Severity**: Warning
**Category**: semantic

**Condition**: A non-absorbing node has ALL outgoing edges targeting nodes
with event_ids (all fetchable), and NONE targeting an absorbing node.

**Problem**: The residual probability (1 − Σp_fetched) has nowhere to go.
The complement algorithm can't assign the dropout fraction because there's
no unfetchable edge to an absorbing node.

**Fix**: Add an edge from the node to an absorbing "dropout" node. The
dropout edge needs no `p.id` or event_id — it's automatically treated as
the complement.

**Graph impact**: Without this, the FE shows "Missing X%" warnings on every
node face and the graph doesn't properly conserve probability mass.

### 2. Missing cohort_anchor_event_id (#5)

**Severity**: Warning
**Category**: semantic

**Condition**: A fetchable edge (both source and target have event_ids) is
missing `p.cohort_anchor_event_id`.

**Problem**: The FE uses this field to derive the cohort anchor for snapshot
queries. Without it, the snapshot dependency plan can't resolve the anchor
event and cohort-mode analyses (including cohort maturity charts) fail
silently — returning empty results or falling back to incorrect query modes.

**Fix**: Set `p.cohort_anchor_event_id` to the start node's `event_id` on
every evented edge.

### 3. Source Handle Missing "-out" Suffix

**Severity**: Warning
**Category**: id-format

**Condition**: An edge's `fromHandle` doesn't end with `-out` (e.g. `bottom`
instead of `bottom-out`).

**Problem**: ReactFlow source handles use the `{direction}-out` naming
convention. Without the suffix, the edge can't connect to the handle and
doesn't render visually — the edge exists in the data but is invisible on
the canvas.

**Fix**: Use `right-out`, `bottom-out`, `left-out`, or `top-out` for
`fromHandle`. Target handles (`toHandle`) do NOT use the `-out` suffix.

---

## Existing Checks (for reference)

| # | Check | Severity | Category |
|---|-------|----------|----------|
| 1 | Absorbing node with outgoing edges | Error | graph-structure |
| 2 | Non-absorbing terminal node (no outgoing, not absorbing) | Warning | graph-structure |
| 3 | All outgoing targets lack event_id | Warning | semantic |
| 4 | **Missing complement edge (mass conservation)** | Warning | semantic |
| 5 | **Missing cohort_anchor_event_id** | Warning | semantic |
| 6 | Invalid UUID format on edge | Warning | id-format |
| 7 | **Source handle missing "-out" suffix** | Warning | id-format |
| 8 | Outgoing probabilities sum > 1.0 | Warning/Info | value |
