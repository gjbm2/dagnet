# t95 HDI Data Flow Trace

Exhaustive trace of how edge t95 HDI and path t95 HDI flow from MCMC to
every consumer. For each stage: file, line, field name read, field name
written, and fallback behaviour when missing.

---

## Stage 1: MCMC Inference

**File:** `bayes/compiler/inference.py`

**Edge t95 HDI** (lines 603-606):
```
t95_samples = exp(mu_samples + 1.645 * sigma_samples) + onset_for_t95
t95_hdi = az.hdi(t95_samples, hdi_prob=0.9)
```
→ `hdi_t95_lower`, `hdi_t95_upper` on `LatencyPosteriorSummary`

**Path t95 HDI** (lines 747-752):
```
path_t95_samples = exp(mu_c_samples + 1.645 * sigma_c_samples) + onset_for_path_t95
path_t95_hdi = az.hdi(path_t95_samples, hdi_prob=0.9)
```
→ `path_hdi_t95_lower`, `path_hdi_t95_upper` on `LatencyPosteriorSummary`

**Fallback (Phase S, no MCMC):** lines 700-701 compute fixed
`t95_lower = exp(mu + 1.28σ) + onset`, `t95_upper = exp(mu + 2.0σ) + onset`.
No path t95 computed (remains None).

---

## Stage 2: Type Definition

**File:** `bayes/compiler/types.py` lines 383-407

| Field | Type | Default |
|---|---|---|
| `hdi_t95_lower` | `float` | required |
| `hdi_t95_upper` | `float` | required |
| `path_hdi_t95_lower` | `float \| None` | `None` |
| `path_hdi_t95_upper` | `float \| None` | `None` |

**Serialisation (`to_webhook_dict`, lines 422-448):**
- Edge: always written (`round(self.hdi_t95_lower, 1)`)
- Path: written only when not None, inside the `if self.path_mu_mean is not None` block

---

## Stage 3: Phase 2 Merge

**File:** `bayes/worker.py` lines 845-862

Phase 2's `path_hdi_t95_lower/upper` overwrite Phase 1's values via
attribute list at line 856:
```python
'path_hdi_t95_lower', 'path_hdi_t95_upper',
```
Copies only when not None (`if val is not None`).

---

## Stage 4: Unified Slice Construction

**File:** `bayes/worker.py` lines 1088-1128

**Window slice** (line 1090-1091):
```python
window["hdi_t95_lower"] = round(lat.hdi_t95_lower, 1)
window["hdi_t95_upper"] = round(lat.hdi_t95_upper, 1)
```
Always uses edge-level values.

**Cohort slice** (lines 1121-1122):
```python
"hdi_t95_lower": round(lat.path_hdi_t95_lower if lat.path_hdi_t95_lower is not None else lat.hdi_t95_lower, 1),
"hdi_t95_upper": round(lat.path_hdi_t95_upper if lat.path_hdi_t95_upper is not None else lat.hdi_t95_upper, 1),
```

**⚠ FALLBACK:** When `path_hdi_t95_lower` is None, the cohort slice gets
the EDGE value. This is the root cause of the "same t95 in both columns"
bug — it's correct fallback behaviour when path t95 isn't computed, but
misleading to the user.

---

## Stage 5: Webhook → Parameter File

**File:** `bayes/worker.py` line 878 → webhook JSON
**File:** `graph-editor/src/services/bayesPatchService.ts` lines 410-418

Slices dict passed through verbatim. No transformation of t95 fields.
Parameter file receives:
```yaml
posterior:
  slices:
    window():
      hdi_t95_lower: 14.4
      hdi_t95_upper: 16.1
    cohort():
      hdi_t95_lower: <path value or edge fallback>
      hdi_t95_upper: <path value or edge fallback>
```

---

## Stage 6: File → Graph Cascade

**File:** `graph-editor/src/services/updateManager/mappingConfigurations.ts`
lines 802-810

Cascade calls `projectLatencyPosterior(value, '')` → result lands on
`p.latency.posterior`.

---

## Stage 7: Posterior Slice Resolution

**File:** `graph-editor/src/services/posteriorSliceResolution.ts`
lines 168-214

**Edge t95** (from window slice, lines 192-193):
```typescript
hdi_t95_lower: edgeSlice.hdi_t95_lower,
hdi_t95_upper: edgeSlice.hdi_t95_upper,
```

**Path t95** (from cohort slice, line 210):
```typescript
...(cohortSlice.hdi_t95_lower != null
  ? { path_hdi_t95_lower: cohortSlice.hdi_t95_lower,
      path_hdi_t95_upper: cohortSlice.hdi_t95_upper }
  : {}),
```

**⚠ NO FALLBACK:** If `cohortSlice.hdi_t95_lower` is null, no
`path_hdi_t95` fields are emitted. The card won't show the row.

---

## Consumer 1: BayesPosteriorCard (Edge Info → Model tab)

**File:** `graph-editor/src/components/analytics/BayesPosteriorCard.tsx`

**Edge column** (line 110):
```typescript
{lat!.hdi_t95_lower != null && <Row label="t95 HDI" ... />}
```
Reads: `latency.hdi_t95_lower`, `latency.hdi_t95_upper`

**Path column** (line 121):
```typescript
{(lat as any)?.path_hdi_t95_lower != null && <Row label="t95 HDI" ... />}
```
Reads: `latency.path_hdi_t95_lower`, `latency.path_hdi_t95_upper`

**Result:** Both rows show because both fields are present, but when path
t95 was never computed, both contain the SAME edge value (from Stage 4
fallback).

---

## Consumer 2: LatencyCdfTab Sparkline (Edge Info → Latency tab)

**File:** `graph-editor/src/components/analytics/AnalysisInfoCard.tsx`
lines 385-388

**Does NOT use t95 HDI.** Computes axis extent from params:
```typescript
const edgeT95 = edge ? Math.exp(edge.mu + 1.645 * edge.sigma) + edge.onset : 0;
const pathT95 = path ? Math.exp(path.mu + 1.645 * path.sigma) + path.onset : 0;
const maxDays = Math.ceil(Math.max(edgeT95, pathT95, 5) * 1.3);
```

**⚠ DISCONNECTED** from the posterior HDI values. Uses mean params only.

---

## Consumer 3: BayesModelRateChart Sparkline (Edge Info → Model tab)

**File:** `graph-editor/src/components/analytics/BayesPosteriorCard.tsx`
lines 306-310

**Does NOT use t95 HDI.** Computes axis extent from params:
```typescript
const edgeT95 = hasEdge ? Math.exp(props.edgeMu! + 1.645 * props.edgeSigma!) + (props.edgeOnset ?? 0) : 0;
const pathT95 = hasPath ? Math.exp(props.pathMu! + 1.645 * props.pathSigma!) + (props.pathOnset ?? 0) : 0;
const maxDays = Math.ceil(Math.max(edgeT95, pathT95, 5) * 1.3);
```

**⚠ DISCONNECTED** from the posterior HDI values. Uses mean params only.
The `* 1.3` multiplier is arbitrary.

---

## Consumer 4: Cohort Maturity Chart (BE → FE)

**File:** `graph-editor/lib/api_handlers.py`

**Extraction** (lines 827-833 in `_read_edge_model_params`):
```python
result['bayes_hdi_t95_upper'] = lat_posterior.get('hdi_t95_upper')
result['bayes_path_hdi_t95_upper'] = lat_posterior.get('path_hdi_t95_upper')
```
Only UPPER bounds extracted. Lower bounds not read.

**Axis extent** (lines 1274-1295):
```python
edge_t95_upper = model_params.get('bayes_hdi_t95_upper')
# Fallback: exp(mu + 2.0σ) + onset
path_t95_upper = model_params.get('bayes_path_hdi_t95_upper')
# NO fallback for path
axis_tau_max = max(sweep_span, edge_t95_upper, path_t95_upper)
```

**⚠ ASYMMETRIC FALLBACK:** Edge has formula fallback, path has none.
When `path_hdi_t95_upper` is None (stale data), the axis extent ignores
the path entirely.

---

## Summary of Issues

| # | Issue | Location | Consequence |
|---|---|---|---|
| 1 | Cohort slice copies edge t95 when path t95 is None | worker.py:1121-1122 | Both columns show identical values |
| 2 | Sparkline charts compute t95 from mean params, not HDI | BayesPosteriorCard.tsx:308, AnalysisInfoCard.tsx:386 | Different x-axis extent from BE chart |
| 3 | `* 1.3` multiplier on sparkline extent is arbitrary | BayesPosteriorCard.tsx:310, AnalysisInfoCard.tsx:388 | No principled relationship to data |
| 4 | BE axis computation has asymmetric fallback | api_handlers.py:1274-1295 | Path t95 silently ignored when missing |
| 5 | Only t95 upper bound extracted, not lower | api_handlers.py:827-833 | Lower bound unavailable to any consumer |
| 6 | bayesPatchService projection of path t95 depends on cohort slice | bayesPatchService.ts:306 | Another point where edge values can leak into path |

---

## What Each Consumer Needs

| Consumer | Needs edge t95? | Needs path t95? | Currently reads from |
|---|---|---|---|
| Edge Info card (edge column) | ✓ HDI | — | `lat.hdi_t95_lower/upper` |
| Edge Info card (path column) | — | ✓ HDI | `lat.path_hdi_t95_lower/upper` |
| LatencyCdfTab sparkline | ✓ point est. | ✓ point est. | Computed from mu/sigma/onset |
| BayesModelRateChart sparkline | ✓ point est. | ✓ point est. | Computed from mu/sigma/onset |
| Cohort maturity chart | ✓ upper HDI | ✓ upper HDI | `bayes_hdi_t95_upper` / `bayes_path_hdi_t95_upper` |
