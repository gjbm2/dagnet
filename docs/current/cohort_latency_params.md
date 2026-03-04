# Persist path-level CDF params (path_mu, path_sigma)

## Background

The cohort maturity chart overlays a theoretical model CDF curve so users can
visually inspect how well the fitted lognormal model matches the empirical
maturity data.

For **window()** queries, the relevant latency is edge-level (X→Y), and the
existing `mu`/`sigma` on the edge parameterise the CDF directly. This works.

For **cohort()** queries, the relevant latency is the full A→Y path from anchor
to target. The A→Y distribution is the convolution of upstream A→X and edge X→Y
latencies. The LAG pass already approximates this via Fenton–Wilkinson
(`approximateLogNormalSumFit`), producing `ayFit.mu` and `ayFit.sigma`. These
are used transiently for cohort completeness calculations and then discarded.
Without them, the backend cannot construct a correct model CDF for cohort mode.

## Goal

Persist `path_mu` and `path_sigma` alongside the existing `path_t95` so the
backend can use them directly for the cohort-mode model CDF overlay.

## When path_mu/path_sigma are meaningful

Any edge downstream of the anchor has a **path-level maturity distribution** in
cohort mode. This is true regardless of the `latency_parameter` flag or whether
the edge itself has intrinsic latency:

- **Latency edge with upstream path**: A→Y distribution is the convolution of
  A→X upstream latency and X→Y edge latency. `path_mu`/`path_sigma` come from
  Fenton–Wilkinson (`approximateLogNormalSumFit`).

- **Non-latency edge (instant X→Y conversion)**: Even though the edge converts
  instantly, cohort members arrive at X at different times due to upstream path
  latency. The A→Y distribution IS the A→X distribution (convolution with a
  delta at zero = upstream unchanged). `path_mu`/`path_sigma` equal the
  upstream A→X params.

- **Edge adjacent to anchor (no upstream hops)**: Anchor lag is near-zero, so
  `path_mu ≈ mu` and `path_sigma ≈ sigma`. Redundant but harmless — consumers
  can use path params uniformly without special-casing.

The `latency_parameter` flag controls other behaviours (retrieval horizons,
bead display) but is irrelevant to whether the edge exhibits cohort-type
maturity behaviour.

---

## LAG pass topo DP: propagating path (mu, sigma)

### Current state

The LAG pass (`enhanceGraphLatencies`) traverses active edges in topological
order (Kahn's algorithm). It propagates several quantities through the graph:

| DP map | Semantics | Propagation |
|---|---|---|
| `nodePathT95` | Max A→node cumulative t95 | `max(inbound edgePathT95)` |
| `edgePathT95InPass` | A→Y path t95 per edge | `pathT95ToNode + edge.t95`, or FW override |
| `nodeMedianLagPrior` | Accumulated baseline median lag to node | `max(inbound prior + edgeMedianLag)` |
| `edgeFlowMassInPass` | Effective flow mass per edge | Set per edge during processing |

Three skip conditions currently prevent full processing:

1. **No local latency AND no upstream lag** (~line 1993): `!hasLocalLatency &&
   !isBehindLaggedPath`. Skips entirely; only updates topo state (in-degree,
   queue). Does NOT propagate `edgePathT95InPass`, `nodePathT95`, or
   `nodeMedianLagPrior` for the target node.

2. **No paramLookup entry** (~line 2018): No fetched data. Same skip behaviour.

3. **Empty cohortsScoped** (~line 2049): Propagates `nodeMedianLagPrior` from
   window slice data but skips full LAG computation.

### Required change: propagate (mu, sigma) through all active edges

Add two new DP maps alongside the existing ones:

| New DP map | Semantics |
|---|---|
| `nodePathMu` | Path-level mu to reach each node (from dominant inbound path) |
| `nodePathSigma` | Path-level sigma to reach each node (from dominant inbound path) |

Initialise start nodes: `nodePathMu.set(startId, undefined)`,
`nodePathSigma.set(startId, undefined)` (no upstream distribution at anchor).

### Propagation rules per edge

For each edge (from → to), regardless of whether it is fully processed or
skipped:

**Step 1: Read upstream params from the source node.**

```
fromMu = nodePathMu.get(fromNodeId)     // A→X path mu (may be undefined)
fromSigma = nodePathSigma.get(fromNodeId) // A→X path sigma (may be undefined)
```

**Step 2: Compute this edge's path (mu, sigma).**

Three cases, in priority order:

(a) **Fully processed edge with ayFit** (existing FW computation succeeds):
    `edgePathMu = ayFit.mu`, `edgePathSigma = ayFit.sigma`. This already
    combines A→X and X→Y via Fenton–Wilkinson.

(b) **Fully processed edge with own fit but no ayFit** (no anchor data, or FW
    quality gate fails): If upstream (fromMu, fromSigma) are defined, compute
    FW(upstream, edge fit). Otherwise, fall back to edge-level mu/sigma
    (treating this edge as if it were anchor-adjacent).

(c) **Skipped edge or edge without own fit** (no paramValues, non-latency,
    empty cohorts): Pass through upstream params:
    `edgePathMu = fromMu`, `edgePathSigma = fromSigma`. This models the
    "instant X→Y conversion" case — the path distribution equals the upstream
    distribution.

**Step 3: Store per-edge.**

```
edgePathMuInPass.set(edgeId, edgePathMu)
edgePathSigmaInPass.set(edgeId, edgePathSigma)
```

**Step 4: Update target node.**

At joins (multiple inbound edges), select the (mu, sigma) from the inbound
edge with the **largest `edgePathT95InPass`** (consistent with the "longest
path" semantics used for `nodePathT95`). If `edgePathT95InPass` is not set for
a skipped edge, use the precomputed `path_t95` or 0.

```
if edgePathT95 > (nodePathT95.get(toNodeId) ?? 0):
    nodePathMu.set(toNodeId, edgePathMu)
    nodePathSigma.set(toNodeId, edgePathSigma)
```

(This piggybacks on the existing `nodePathT95` max update at line 2967.)

### Modified skip logic

The three skip paths (~lines 1993, 2018, 2049) currently only update topo state
(in-degree, queue). They must be extended to also:

1. Compute `edgePathMu`/`edgePathSigma` (pass-through from upstream)
2. Store in `edgePathMuInPass`/`edgePathSigmaInPass`
3. Update `nodePathMu`/`nodePathSigma` for the target node

This ensures non-latency edges and edges without param data still propagate
path-level CDF params to downstream edges.

### Persist into EdgeLAGValues

For fully processed edges, the `EdgeLAGValues.latency` construction (~line 2504)
includes `path_mu` and `path_sigma` from the computed values.

For skipped edges, no `EdgeLAGValues` is emitted (they aren't pushed to
`result.edgeValues`). The path params are only used for DP propagation in-pass
and will reach downstream processed edges that DO emit `EdgeLAGValues`.

---

## Schema changes by file

### 1. TypeScript types — `graph-editor/src/types/index.ts`

Add to `LatencyConfig` (after `sigma`, ~line 528):

```
path_mu?: number;
path_sigma?: number;
```

No `_overridden` companions. These are internal model params computed by the LAG
pass, like `mu`/`sigma`.

### 2. EdgeLAGValues interface — `graph-editor/src/services/statisticalEnhancementService.ts`

Add to the `latency` member of `EdgeLAGValues` (~line 1617):

```
path_mu?: number;
path_sigma?: number;
```

### 3. Python Pydantic model — `graph-editor/lib/graph_types.py`

Add after `sigma` (~line 77):

```
path_mu: Optional[float] = Field(None, description="Path-level A→Y log-normal mu (Fenton–Wilkinson, internal)")
path_sigma: Optional[float] = Field(None, ge=0, description="Path-level A→Y log-normal sigma (Fenton–Wilkinson, internal)")
```

### 4. YAML schema — `graph-editor/public/param-schemas/parameter-schema.yaml`

Add after the `sigma` entry (~line 115):

```
path_mu:
  type: number
  description: "Path-level A→Y log-normal mu (Fenton–Wilkinson, internal)"
path_sigma:
  type: number
  minimum: 0
  description: "Path-level A→Y log-normal sigma (Fenton–Wilkinson, internal)"
```

### 5. Python graph builder — `graph-editor/lib/runner/graph_builder.py`

Add to `_extract_latency` return dict (~line 342, after `completeness`):

```
'mu': latency.get('mu'),
'sigma': latency.get('sigma'),
'path_mu': latency.get('path_mu'),
'path_sigma': latency.get('path_sigma'),
```

Note: `mu`/`sigma` are also not currently extracted here. Adding all four keeps
the Python graph builder consistent with the full TS LatencyConfig.

---

## LAG pass changes — `graph-editor/src/services/statisticalEnhancementService.ts`

### New DP state (~line 1902, after `nodeMedianLagPrior` init)

```
const nodePathMu = new Map<string, number | undefined>();
const nodePathSigma = new Map<string, number | undefined>();
for (const startId of startNodes) {
  nodePathMu.set(startId, undefined);
  nodePathSigma.set(startId, undefined);
}
const edgePathMuInPass = new Map<string, number | undefined>();
const edgePathSigmaInPass = new Map<string, number | undefined>();
```

### Skip path 1: no local latency AND no upstream lag (~line 1993)

After the existing topo state update, add path param propagation:

```
// Propagate upstream path (mu, sigma) through non-latency edges
const fromMu = nodePathMu.get(fromNodeId);
const fromSigma = nodePathSigma.get(fromNodeId);
edgePathMuInPass.set(edgeId, fromMu);
edgePathSigmaInPass.set(edgeId, fromSigma);
// Update target node if this is the dominant path
const currentTargetT95 = nodePathT95.get(toNodeId) ?? 0;
const thisEdgeT95 = precomputedPathT95.get(edgeId) ?? 0;
if (thisEdgeT95 >= currentTargetT95) {
  nodePathMu.set(toNodeId, fromMu);
  nodePathSigma.set(toNodeId, fromSigma);
}
```

### Skip path 2: no paramLookup entry (~line 2018)

Same propagation as skip path 1.

### Skip path 3: empty cohortsScoped (~line 2049)

Same propagation as skip path 1 (the `nodeMedianLagPrior` propagation already
happens here; add path mu/sigma alongside it).

### Fully processed edges: capture ayFit (~line 2371)

Declare `pathMu`/`pathSigma` at the same scope as `completenessUsed`:

```
let pathMu: number | undefined;
let pathSigma: number | undefined;
```

**Case (a)** — ayFit succeeds (~line 2441):

```
pathMu = ayFit.mu;
pathSigma = ayFit.sigma;
```

**Case (b)** — ayFit not computed but upstream + edge fit available:

After the `if (!isWindowMode)` block, if `pathMu` is still undefined and the
edge has its own fit and upstream params exist:

```
if (pathMu === undefined) {
  const fromMu = nodePathMu.get(fromNodeId);
  const fromSigma = nodePathSigma.get(fromNodeId);
  if (fromMu !== undefined && fromSigma !== undefined) {
    const upstreamFit = { mu: fromMu, sigma: fromSigma, empirical_quality_ok: true, total_k: 1 };
    const combined = approximateLogNormalSumFit(upstreamFit, latencyStats.fit);
    if (combined) {
      pathMu = combined.mu;
      pathSigma = combined.sigma;
    }
  }
}
```

**Fallback**: if `pathMu` is still undefined, pass through upstream:

```
if (pathMu === undefined) {
  pathMu = nodePathMu.get(fromNodeId);
  pathSigma = nodePathSigma.get(fromNodeId);
}
```

### Store and propagate (~line 2967, after nodePathT95 update)

```
edgePathMuInPass.set(edgeId, pathMu);
edgePathSigmaInPass.set(edgeId, pathSigma);
if (edgePathT95 >= (nodePathT95.get(toNodeId) ?? 0)) {
  nodePathMu.set(toNodeId, pathMu);
  nodePathSigma.set(toNodeId, pathSigma);
}
```

Note: the condition `edgePathT95 >= currentTargetT95` must be evaluated BEFORE
the `nodePathT95.set(...)` at line 2967 overwrites the old value — or use the
saved `currentTargetT95` value.

### EdgeLAGValues construction (~line 2504)

```
const edgeLAGValues: EdgeLAGValues = {
  edgeUuid,
  latency: {
    ...existing fields...
    path_mu: pathMu,
    path_sigma: pathSigma,
  },
  ...
};
```

---

## UpdateManager changes — `graph-editor/src/services/UpdateManager.ts`

### `applyBatchLAGValues` (~line 3608)

Add writes after the existing `mu`/`sigma` block, same pattern:

```
if ((update.latency as any).path_mu !== undefined) {
  targetP.latency.path_mu = (update.latency as any).path_mu;
}
if ((update.latency as any).path_sigma !== undefined) {
  targetP.latency.path_sigma = (update.latency as any).path_sigma;
}
```

### Graph-to-file mappings (~line 1720)

```
{
  sourceField: 'p.latency.path_mu',
  targetField: 'latency.path_mu',
  condition: (source) => source.p?.latency?.path_mu !== undefined && source.p?.id
},
{
  sourceField: 'p.latency.path_sigma',
  targetField: 'latency.path_sigma',
  condition: (source) => source.p?.latency?.path_sigma !== undefined && source.p?.id
},
```

### File-to-graph mappings (~line 2174)

```
{
  sourceField: 'latency.path_mu',
  targetField: 'p.latency.path_mu',
  condition: isProbType
},
{
  sourceField: 'latency.path_sigma',
  targetField: 'p.latency.path_sigma',
  condition: isProbType
},
```

---

## Backend model curve — `graph-editor/lib/api_handlers.py`

### `_read_edge_model_params`

Read `path_mu` and `path_sigma` from the edge:

```
path_mu = latency.get('path_mu')
path_sigma = latency.get('path_sigma')
if isinstance(path_mu, (int, float)) and math.isfinite(path_mu):
    result['path_mu'] = float(path_mu)
if isinstance(path_sigma, (int, float)) and math.isfinite(path_sigma) and path_sigma > 0:
    result['path_sigma'] = float(path_sigma)
```

### Cohort CDF generation

Replace the current `cohort_path` branch (which derives from `path_t95` +
edge sigma) with a direct read:

```
if is_window:
    cdf_mu = mu
    cdf_sigma = sigma
    cdf_onset = onset
    cdf_mode = 'window'
else:
    path_mu_val = model_params.get('path_mu')
    path_sigma_val = model_params.get('path_sigma')
    if path_mu_val is not None and path_sigma_val is not None:
        cdf_mu = path_mu_val
        cdf_sigma = path_sigma_val
        cdf_onset = 0.0   # path params already incorporate upstream delay
        cdf_mode = 'cohort_path'
    else:
        cdf_mu = mu
        cdf_sigma = sigma
        cdf_onset = onset
        cdf_mode = 'cohort_edge_fallback'
```

---

## What does NOT change

- **UI components**: `path_mu`/`path_sigma` are internal, not displayed.
- **Frontend normalisation** (`graphComputeClient.ts`): The backend generates
  the model curve; the frontend passes it through unchanged.
- **Chart component** (`SnapshotCohortMaturityChart.tsx`): Already renders the
  model curve from `result.metadata.model_curves`. No change needed.
- **Node ID rename** (`UpdateManager`): Numeric values, not node references.
- **Cache signatures**: These are display-only fields, not part of analysis
  cache keys.
- **Integrity check** (`integrityCheckService.ts`): No drift check for
  `mu`/`sigma` exists today. Low priority for `path_mu`/`path_sigma`. Add
  later if drift issues surface.
- **Fetch data service** (`fetchDataService.ts`): `path_mu`/`path_sigma` flow
  through `EdgeLAGValues` → `applyBatchLAGValues` which is not gated by
  `shouldWritePath`. No changes needed.

---

## Onset semantics for cohort mode

When using `path_mu`/`path_sigma`, the onset is set to `0.0`. The
Fenton–Wilkinson combined distribution models the full A→Y latency including
upstream delay. The edge-level `onset_delta_days` represents X→Y dead-time
only and is NOT additive with path params.

The combined lognormal CDF(0) = 0 and rises gradually, providing a natural
"soft onset" that reflects the probabilistic upstream delay rather than a hard
cutoff. This matches the empirical data shape better than a shifted edge CDF.

---

## Fallback behaviour

When `path_mu`/`path_sigma` are absent (no upstream path params available,
quality gate failure, or edge hasn't been through a LAG pass), the backend
falls back to edge-level `mu`/`sigma`/`onset` with mode
`cohort_edge_fallback`. This is the same behaviour as before this change —
imperfect for cohort mode, but the best available.

---

## Test coverage

### Existing tests to extend

These files already test related fields and should be extended with
`path_mu`/`path_sigma` assertions:

**`statisticalEnhancementService.test.ts`** — already asserts `t95`,
`path_t95`, `completeness`, `onset_delta_days` in EdgeLAGValues output.

**`lagStatsFlow.integration.test.ts`** — already covers multi-edge chains,
path_t95 accumulation, anchor lag, onset.

**`pathT95JoinWeightedConstraint.test.ts`** — already covers join-weighted
path_t95 at convergent nodes.

**`test_lag_fields.py`** (Python) — already checks latency field extraction.

### New test scenarios

#### 1. LAG pass — path_mu/path_sigma in EdgeLAGValues

Extend `statisticalEnhancementService.test.ts`:

- **Multi-hop chain (A→B→C, both latency)**: After LAG pass, C's EdgeLAGValues
  should have `path_mu` and `path_sigma` defined and distinct from edge-level
  `mu`/`sigma`. Verify FW combination: `path_mu > mu` (path median is larger
  than edge median because it includes upstream delay).

- **Anchor-adjacent edge (A→B, single hop)**: `path_mu ≈ mu` and
  `path_sigma ≈ sigma` (no meaningful upstream delay). Verify they are defined.

- **Window mode**: `path_mu` and `path_sigma` should be `undefined` (the
  `ayFit` block only runs in cohort mode).

#### 2. Topo DP propagation for non-latency edges

Extend `lagStatsFlow.integration.test.ts`:

- **Mixed chain (A→B latency → C non-latency → D latency)**: C has no own
  mu/sigma but should propagate B's path params downstream. D should combine
  C's upstream params with its own edge fit via FW. Verify D has `path_mu`
  and `path_sigma` that reflect the full A→D path.

- **Skipped edge (no paramValues)**: Edge with no fetched data still propagates
  upstream path_mu/path_sigma to its target node. A downstream processed edge
  should inherit those upstream params.

#### 3. Join semantics

Extend `pathT95JoinWeightedConstraint.test.ts`:

- **Convergent paths with different path_t95**: A→U→X (long path) and A→V→X
  (short path). Verify X→Y gets `path_mu`/`path_sigma` from the dominant
  (longest) inbound path (U→X), not the short one (V→X).

#### 4. UpdateManager persistence

Extend existing `applyBatchLAGValues` tests:

- **Write**: `applyBatchLAGValues` with `path_mu`/`path_sigma` in the update;
  verify they appear on `edge.p.latency`.

- **Graph-to-file**: Edge with `path_mu`/`path_sigma` on graph produces
  `latency.path_mu`/`latency.path_sigma` in file output.

- **File-to-graph**: File with `latency.path_mu`/`latency.path_sigma` produces
  `edge.p.latency.path_mu`/`path_sigma` after load.

#### 5. Backend model curve

Extend `test_forecast_application.py` or `test_graceful_degradation.py`:

- **Cohort CDF with path params**: Graph edge has `path_mu`/`path_sigma` and
  `forecast.mean`. Cohort maturity response includes `model_curve` using path
  params (verify curve shape matches path-level timescale, not edge-level).

- **Cohort CDF fallback**: Edge missing `path_mu`/`path_sigma` but has
  `mu`/`sigma`. Verify `model_curve_params.mode` is `cohort_edge_fallback`.

- **Window CDF**: Verify `model_curve_params.mode` is `window` and uses
  edge-level mu/sigma regardless of whether path params exist.

#### 6. Python schema/extraction

Extend `test_lag_fields.py`:

- **LatencyConfig accepts path_mu/path_sigma**: Pydantic model roundtrips.
- **_extract_latency includes path_mu/path_sigma**: Graph builder extracts them.

### Test approach

All new scenarios should extend existing test files (no new test files). Use
real IDB/FileRegistry/GraphStore per the project's integration test standards.
Mock only external APIs. Assert specific values, not just `toBeDefined()`.

---

## Implementation order

1. TypeScript types + EdgeLAGValues interface (schemas)
2. LAG pass: new DP state, propagation in skip paths, ayFit capture
3. UpdateManager: writes + field mappings
4. Python model + YAML schema + graph builder (schemas)
5. Backend model curve: read path_mu/path_sigma, use for cohort CDF
6. Verify: run a fetch, confirm `path_mu`/`path_sigma` propagate through graph
   including non-latency edges; confirm cohort maturity chart overlay uses
   correct timescale for both latency and non-latency edges
