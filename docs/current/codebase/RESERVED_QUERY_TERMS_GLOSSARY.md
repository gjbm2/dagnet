# Reserved Query Terms Glossary

**Status**: Living reference  
**Date**: 1-Apr-26

This note defines reserved terms that must be used consistently across
the FE, BE, tests, and docs. Capitalisation is semantic here.

## Core terms

**Cohort**

A dated group of users defined by "did the relevant thing on this date".
The defining thing depends on query mode:

- In `window()`, the Cohort is users who reached the edge's `from_node`
  on that date.
- In `cohort()`, the Cohort is users who entered the anchor node `a` on
  that date.

Use **Cohort** when you mean the dated population itself, not the query
clause.

**`cohort()`**

A QueryDSL clause selecting `a-x-y` semantics for an edge. The group is
anchor-anchored at `a`, `x` is a moving quantity because upstream
arrivals are still maturing, and path-level latency from `a` into the
edge matters. `cohort()` is a query mode, not the population name.

**`window()`**

A QueryDSL clause selecting edge-local semantics. The relevant Cohort is
defined at the edge's `from_node`, `x` is fixed within that
window-anchored subject, and edge-local latency is sufficient to define
maturity for the edge.

**`asat()`**

A QueryDSL clause asking a point-in-time question: "what would the user
have seen on or before this date?" It is an evidence and posterior
frontier, not just a chart label.

The system must therefore treat `asat()` as affecting:

- snapshot evidence selection
- sweep upper bounds where a sweep is used
- posterior selection or fit-history selection

The system must not mix historical evidence with a posterior fitted
after the requested `asat()` date.

## Query modes

**Window mode**

The query semantics selected by a `window()` clause. In window mode:
- The Cohort is defined at the edge's `from_node` (users who arrived on that date)
- `x` is **fixed** within the window-anchored subject
- Latency is **edge-level** (time from `from_node` to `to_node` only)
- Completeness is evaluated against the edge's own lag distribution

**Cohort mode**

The query semantics selected by a `cohort()` clause. In cohort mode:
- The Cohort is defined at the anchor node `a` (users who entered `a` on that date)
- `x` is **growing** — upstream arrivals are still maturing, so `x` increases with age
- Latency is **path-level** (accumulated from anchor `a` through all upstream edges to `to_node`)
- Completeness is evaluated against the path-level lag distribution (Fenton-Wilkinson composition of upstream edges)

## Latency semantics

**Edge-level latency**

The time-to-conversion for a single X→Y transition. Measured by the edge's own lag distribution.

Fields: `t95`, `mu`, `sigma`, `median_lag_days`, `mean_lag_days`, `onset_delta_days`

**Path-level latency**

The accumulated time-to-conversion from anchor A through all upstream edges to Y. Derived via Fenton-Wilkinson log-normal convolution of upstream edge-level distributions. Not directly observed — always computed.

Fields: `path_t95`, `path_mu`, `path_sigma`, `path_onset_delta_days`

**`anchor_median_lag_days`**

The upstream path lag from anchor `a` to the edge's `from_node` (A→X), **NOT** from anchor to `to_node` (A→Y). This is the single most important semantic distinction in the snapshot field model. It represents how long it took the Cohort to reach the edge's starting point, which determines:
- The age offset when evaluating cohort-mode completeness for this edge
- The path-adjusted CDF: `P(reach to_node by age t | entered anchor) = F_edge(t - anchor_median_lag_days)`

See SNAPSHOT_FIELD_SEMANTICS.md for full field-by-field semantics.

## Data-shape terms

**`anchor_day`**

The date that defines the Cohort. In `window()` it is the date users
reached the `from_node`. In `cohort()` it is the date users entered the
anchor node `a`.

**`retrieved_at`**

The observation timestamp in the snapshot DB. Multiple `retrieved_at`
values for the same `anchor_day` show the same Cohort measured again at
later ages.

**`a`, `x`, `y`**

- `a`: anchor entrants
- `x`: arrivals at the current edge's `from_node`
- `y`: conversions at the current edge's `to_node`

For `cohort()` semantics, `a` is the anchor population, but the edge's
displayed rate remains `y/x`, not `y/a`.

## Slice and binding terms

**Contexted query**

A query whose DSL includes `context(...)`, `contextAny(...)`, case
constraints, or other slice-defining clauses. Context is part of the
read identity. The BE must not widen, drop, or silently merge contexted
slices beyond what the FE planner explicitly requested.

**`slice_keys`**

The explicit slice families the FE planned for evidence binding. These
are part of the snapshot read contract and must flow through unchanged.

**`core_hash`**

The FE-computed seed snapshot identity for a canonical query signature.
The backend consumes it as an opaque key and must not derive a new one.

**`equivalent_hashes`**

The FE-computed closure set of hashes linked through `hash-mappings`.
These are part of the snapshot family for reads. If the FE provides
them, the BE must use them for evidence binding rather than reading only
the seed `core_hash`.
