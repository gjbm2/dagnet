# Doc 10 — Topology Signatures for Posterior Staleness

**Status**: Design sketch — principles and structure. Full implementation
spec to follow when Phase A nears completion.
**Date**: 17-Mar-26
**Depends on**: Doc 6 (compiler IR, topology fingerprint, model
fingerprint), doc 8 (phase definitions).
**Not a Phase A blocker**: Phase A delivers without staleness detection.
This doc designs the resilience layer that tells users when posteriors
are stale because the graph structure changed after the last fit.

---

## 1. Problem

A Bayes fit is computed against a specific graph topology. If the user
edits the graph after the fit — adds a node, rewires an edge, changes
branch group membership — the posteriors in parameter files were
conditioned on a different DAG. Without detection, the FE displays
posteriors that silently don't match the current graph.

A graph-level hash is too coarse: adding an unrelated edge downstream
should not invalidate upstream posteriors. The signature must be
**per-fit-unit** — scoped to exactly the structural inputs the compiler
used when fitting each edge (or group of edges).

---

## 2. Two-tier fingerprint model (from doc 6)

The compiler already defines two tiers:

1. **Topology fingerprint** = hash of `TopologyAnalysis`. Captures the
   structural shape of the model: connectivity, branch groups, joins,
   latency chains. Used for warm-start eligibility.

2. **Model fingerprint** = hash of topology + bound evidence +
   structural settings. Full cache identity for a specific inference
   run.

This doc concerns **tier 1 only** — the topology fingerprint. It
answers: "Has the structural context of this edge's fit changed since
the posteriors were written?"

The model fingerprint (tier 2) is a superset. A topology change implies
a model fingerprint change, but not vice versa — evidence changes
(new observations, different training window) change the model
fingerprint without changing topology.

---

## 3. What is a fit unit?

A fit unit is the atomic group of edges that share a posterior
computation. Its scope widens across compiler phases:

| Phase | Fit unit | Why |
|---|---|---|
| A | Single edge | Independent Beta per edge |
| B | Branch group (sibling edges sharing a source node) | Dirichlet couples siblings; changing one sibling invalidates all |
| C | Branch group + slice structure | Hierarchical Dirichlet pools across slices |
| D | Coupled probability + latency edges on same hop | Joint model; probability and latency posteriors are interdependent |

The topology signature is stored **per parameter file** (i.e. per edge),
but when the fit unit is wider than one edge (Phase B+), all edges in
the fit unit share the same signature value. If any member's structural
context changes, all members are stale.

---

## 4. Structural inputs (what enters the hash)

These are the features captured by `analyse_topology()` in the compiler.
They define the structural context of a fit unit.

### 4.1 Connectivity

- Edge source and target node IDs (UUIDs)
- Edge UUID
- Direction of the edge

This is the baseline. Rewiring an edge, adding or removing an edge —
all change connectivity.

### 4.2 Branch group composition

For each branching node (out-degree > 1):
- The sorted set of sibling edge UUIDs

Adding a sibling changes the Dirichlet dimensionality. Removing one
does the same. Both invalidate the entire branch group.

For solo edges (source out-degree = 1), the relevant structural fact
is that the edge IS solo. If a new sibling appears, the edge is no
longer solo — its fit unit changes from independent Beta to Dirichlet.

### 4.3 Join structure

For each join node (in-degree > 1):
- The sorted set of inbound edge UUIDs
- Whether the join is terminal (no outgoing event-driven edges) or
  non-terminal (requires a join recipe for path composition)

Adding an inbound edge to a join changes the mixture components for
path composition. Changing terminal status changes whether a join
recipe is generated.

### 4.4 Latency chain topology

For each edge with `latency_parameter: true`:
- The ordered sequence of edge UUIDs from the anchor node to the
  edge's source node
- The anchor node UUID

Adding or removing edges on the path from anchor to source changes
the latency chain. The onset accumulation (`path_delta`) is a
function of this chain.

### 4.5 Structural settings

These are per-node or per-edge flags that affect the model structure
(not the topology per se, but the compiler's structural interpretation):

- **Exhaustiveness flag** (per branching node): determines whether a
  phantom dropout component is added to the Dirichlet. Changing this
  changes the model dimensionality.
- **Latency parameter flag** (per edge): determines whether the edge
  participates in latency chains. Toggling this changes what the
  compiler enumerates.

These are included because they affect `TopologyAnalysis` output, even
though they are node/edge metadata rather than pure connectivity.

---

## 5. What does NOT enter the hash

### 5.1 Cosmetic properties

Node labels, descriptions, positions, colours, visual settings. These
are display concerns. The compiler never reads them.

### 5.2 Evidence and observations

All `values[]` entries in parameter files — `(n, k)` observations,
cohort dates, window dates, latency histograms, `fit_history`. These
are the compiler's **evidence** inputs (`BoundEvidence`), not its
structural inputs. A topology signature that changed when new
observations arrived would be useless — it would flag every posterior
as stale after every data fetch.

### 5.3 Context dimensions and slices

Which context dimensions exist (`dataInterestsDSL`), how many slices,
MECE classification. The topology is slice-agnostic — a solo edge is
a solo edge regardless of slice count. Slices are layered on during
`bind_evidence`, not during `analyse_topology`.

**Note**: Context *definitions* (the schema of a context dimension)
already have their own hash system (`contextDefHashes` in
`querySignature.ts`). If a context definition changes, the existing
data hash infrastructure handles cache invalidation. The topology
signature does not need to duplicate this.

### 5.4 Event definitions

What events map to nodes, provider event names, event filters. These
affect **query signatures** and **evidence binding**, not topology.
They already have their own hash (`eventDefHashes` in
`querySignature.ts`).

### 5.5 Training window and observation filters

Which date range to train on, recency weighting, observation inclusion
criteria. These filter evidence, not structure.

### 5.6 Distribution family tags

`latency_family`, `prob_family` per edge. These dispatch different
model code in `build_model` but don't change the topology IR. They
belong in the model fingerprint (tier 2), not the topology fingerprint.

### 5.7 Conditional probabilities (future)

`conditional_p` entries create virtual forks (separate simplexes per
condition). The compiler's topology analysis is conditional-agnostic —
conditionals are resolved in `build_model`, not `analyse_topology`.
The topology signature should remain stable when conditions are
added or removed. (Phase A doesn't support conditionals.)

---

## 6. Relationship to existing hash infrastructure

The codebase has extensive data hashing (`coreHashService`,
`querySignature`, `signatureMatchingService`, `hashMappingsService`).
The topology signature is a **new, parallel layer** — not an extension
of the existing data hash.

| Concern | Existing data hash | Topology signature |
|---|---|---|
| What it answers | "Is cached observation data still valid for this query?" | "Were posteriors fitted against the current graph structure?" |
| Scope | Per parameter × slice × query | Per fit unit (edge or branch group) |
| Inputs | Connection, event IDs, event defs, context defs, query DSL | Connectivity, branch groups, joins, latency chains, structural flags |
| Where stored | Snapshot DB rows, parameter file headers | `posterior.topology_hash` on parameter file |
| Where computed | FE (`querySignature.ts`) | FE (new service, TBD) |
| Equivalence links | Yes (`hash-mappings.json`) | No — identity is structural; evidence inheritance annotations (doc 6) handle cross-version linking |

The two layers are independent. A graph can have:
- Same topology signature, different data hash (new observations fetched)
- Same data hash, different topology signature (graph rewired but same
  events)
- Both changed (rewired graph with different events)

### 6.1 No equivalence machinery needed

The data hash system needs equivalence links because event renames
change the query identity. The topology signature uses structural
features (edge UUIDs, connectivity) — renaming a node label doesn't
change any hash input. Cross-topology-version linking (e.g. "this
edge in graph v2 corresponds to that edge in graph v1") is handled by
**evidence inheritance annotations** (doc 6), which are explicit
user/compiler declarations, not inferred from hash equivalence.

### 6.2 Reuse of hashing primitives

The topology signature should reuse:
- `stableStringify()` from `lib/stableSignature.ts` for canonical
  serialisation
- `computeShortCoreHash()` from `coreHashService.ts` for SHA-256
  truncation

It does NOT need to reuse `querySignature.ts` or
`signatureMatchingService.ts` — those serve data caching, not
structural staleness.

---

## 7. Where computed, where stored

### 7.1 Computation: FE-side

Consistent with the principle that **FE is the sole producer of
hashes** (see `hash-fixes.md`). The FE has access to the graph, all
parameter files, and all structural metadata needed to compute the
topology signature.

The signature is computed:
- **At submission time**: when the user triggers a Bayes fit, the
  submission service computes the topology signature for every edge in
  the graph and includes it in the submission payload.
- **On graph load / after topology mutation**: the FE recomputes the
  current topology signature and compares against stored values.

New service: `topologySignatureService.ts` (or extend the existing
`graphTopologySignatureService.ts`, which currently computes a
lightweight `n:...|e:...` string).

### 7.2 Storage: parameter file, `posterior.topology_hash`

The topology signature is written alongside posteriors by the webhook
handler. Each parameter file's `posterior` block gains a
`topology_hash` field — the hash that was current when this posterior
was computed.

The FE computes the *current* topology hash on load and compares it
against the stored value. If they differ, the posterior is stale.

### 7.3 Graph-level summary: `_bayes.topology_hash`

The graph metadata `_bayes` block (written by webhook) also stores
the graph-wide topology hash at fit time. This enables a quick
graph-level staleness check without reading every parameter file.

---

## 8. Staleness detection

### 8.1 When to check

- **On graph load**: compare stored `_bayes.topology_hash` against
  current. If different, at least one edge is stale.
- **On topology mutation**: after any node/edge add, remove, or rewire,
  recompute the per-edge signatures for affected fit units and compare
  against stored.
- **Before manual Bayes trigger**: warn if any edges are stale (user
  is about to refit anyway, but the warning confirms why).

### 8.2 Granularity of detection

Two levels:

1. **Graph-level** (cheap): compare `_bayes.topology_hash` against
   current full-graph topology hash. Binary: "something changed" or
   "nothing changed". Displayed as a graph-level badge.

2. **Per-edge** (detailed): compare each parameter file's
   `posterior.topology_hash` against the current fit-unit signature.
   Identifies which specific edges are stale. Displayed as per-edge
   indicators.

Graph-level is a fast screen. Per-edge is computed on demand (e.g. when
user opens fit quality view or when the graph-level check is positive).

### 8.3 What "stale" means to the user

Stale posteriors are not *wrong* — they're *conditioned on a different
graph*. The user might choose to:
- Refit (re-trigger Bayes run)
- Ignore (the structural change was cosmetic or irrelevant to this edge)
- Investigate (which edges changed?)

The FE should surface staleness as an **informational indicator**, not
a blocking error.

---

## 9. Phased delivery

### Phase 1 (post-compiler Phase A)

- Compute topology signature at submission time
- Store in `posterior.topology_hash` and `_bayes.topology_hash`
- On graph load, compare and surface warning badge on stale edges
- Fit unit = single edge (Phase A compiler)

### Phase 2 (post-compiler Phase B)

- Fit unit widens to branch group — all Dirichlet siblings share a
  signature
- Adding/removing a sibling flags the entire group as stale

### Phase 3 (post-compiler Phase D)

- Fit unit widens to coupled probability + latency pair
- Latency chain changes flag both probability and latency posteriors

### Each phase reuses the same hashing service — only the fit-unit
definition and the set of structural inputs change.

---

## 10. Edge case analysis

### Adding a sibling edge to a branch group

Node A has edges A→B, A→C. User adds A→D.

- Branch group composition changes: `{B, C}` → `{B, C, D}`
- Topology signature for A→B and A→C changes (new sibling)
- Both are flagged stale — correct, because the Dirichlet dimensionality
  changed (Phase B+) or the solo/branch classification changed (Phase A)
- A→D has no posterior yet — not flagged (nothing to be stale)

### Removing a sibling edge

Node A has A→B, A→C, A→D. User removes A→D.

- Branch group shrinks: `{B, C, D}` → `{B, C}`
- A→B and A→C flagged stale — correct

### Rewiring an edge

Edge A→B changed to A→X.

- Connectivity changes for the rewired edge
- If A→B was in a branch group, the group composition changes — all
  siblings flagged stale
- If A→B was on a latency chain for a downstream edge, that chain
  changes — downstream edge flagged stale

### Changing exhaustiveness flag

Node A's `exhaustive` flag toggled.

- Topology signature changes (structural setting)
- All outgoing edges from A flagged stale — correct, because the
  Dirichlet gains or loses a dropout component

### Adding an unrelated edge elsewhere

New edge X→Y added, not connected to any existing fit units.

- Per-edge topology signatures for existing edges unchanged
- Graph-level topology hash changes (connectivity changed)
- Graph-level badge shows "topology changed" but per-edge drill-down
  shows no individual edge is stale
- This is the intended behaviour — graph-level is a coarse screen,
  per-edge is authoritative

### Adding a latency parameter to a non-latency edge

Edge A→B gains `latency_parameter: true`.

- A→B's structural context changes (now participates in latency chains)
- Downstream edges whose latency chains pass through A→B are also
  affected
- A→B flagged stale (previous posterior didn't include latency params)

### Changing `onset_delta_days` on an edge

Edge A→B's onset changes from 3 to 5.

- Topology signature unchanged — onset is a fixed scalar, not
  connectivity. It affects `path_delta` computation but this is
  evidence-adjacent, not structural.
- Model fingerprint (tier 2) changes — but that's the compiler's
  concern, not FE staleness detection.
- **Open question**: should onset be included in the topology hash?
  Argument for: it affects completeness CDF shape, which is structural.
  Argument against: it's a continuous parameter, not a discrete
  structural feature; including it would flag stale on every onset
  tweak. Current recommendation: exclude from topology hash. If onset
  sensitivity matters, surface it via model fingerprint comparison in
  a future iteration.

---

## 11. Testing strategy

The topology signature requires the same rigour as the existing data
hash infrastructure (~195 tests). Categories:

### 11.1 Determinism

Same graph → byte-identical signature, every time. Golden fixture with
representative graphs and expected signatures, consumed by both TS
tests and (when the compiler uses it) Python tests.

### 11.2 Canonical ordering

Node/edge enumeration order must not affect the signature. Test with
permuted node arrays, permuted edge arrays — same signature.

### 11.3 Cosmetic invariance

Changes to labels, descriptions, positions, colours, visual metadata
must not change the signature. Test: mutate every cosmetic field, verify
signature unchanged.

### 11.4 Structural sensitivity

Every structural change must change the signature. Test matrix:
- Add edge, remove edge, rewire edge
- Add node, remove node
- Change solo→branch (add sibling), branch→solo (remove siblings)
- Change exhaustiveness flag
- Toggle latency parameter flag
- Add/remove inbound edge to join
- Change terminal→non-terminal join status

### 11.5 Fit-unit boundary correctness

When a structural change affects one fit unit but not another, only the
affected unit's signature changes. Test: two independent branch groups;
modify one; verify the other's signature is unchanged.

### 11.6 Integration with graph mutations

Real graph store, real mutations (add node, add edge, rewire), verify
signature recomputation produces the correct staleness flags.

### 11.7 Round-trip serialisation

Compute → serialise → deserialise → verify equality.

### 11.8 Fail-safe behaviour

When signature computation fails or inputs are malformed (missing node
references, broken edge connectivity), the service should return an
error/sentinel, not a valid-looking hash. Posteriors with no stored
topology hash should be treated as "unknown staleness", not "fresh".

---

## 12. Open questions

1. **Onset in topology hash**: see §10 edge case. Current recommendation
   is exclude. Revisit if onset sensitivity proves important in practice.

2. **Conditional probabilities**: when conditionals are supported
   (post-Phase A), do they enter the topology hash? Current
   recommendation: no — conditionals are resolved in `build_model`, not
   `analyse_topology`. Revisit when conditionals are implemented.

3. **Per-edge vs per-fit-unit storage**: should each parameter file
   store its own topology hash, or should a separate fit-unit registry
   map fit units to signatures? Current recommendation: per-parameter
   file (simpler, no new storage layer). Fit-unit grouping is the FE's
   concern when interpreting staleness.

4. **Eager vs lazy per-edge recomputation**: should per-edge signatures
   be recomputed on every topology mutation, or only when the user
   requests staleness information? Current recommendation: lazy (on
   demand) for per-edge, eager for graph-level.
