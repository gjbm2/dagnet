# Multi-Signature Matching: Battle Test Scenarios

This document systematically works through 15 orthogonal scenarios to validate the robustness of the signature matching, slice selection, and aggregation logic defined in `multi-sig-matching.md`.

Each scenario isolates a distinct failure mode or decision point and traces through the full pipeline:

- **Step A**: Signature compatibility filter (`canCacheSatisfyQuery`)
- **Step B**: Slice eligibility filter (exclude `case()`, `contextAny()`, malformed)
- **Step C**: Dimension grouping (`groupByDimensionSet`)
- **Step D**: Per-date satisfaction evaluation (`analyzePerDateGroupCoverage`)
- **Step E**: Aggregation (`aggregateWithTemporalGroupSwitching`)

---

## Design Clarifications (Pre-Implementation)

Before testing, the following ambiguities in the main spec are resolved here:

### C1. Recency Definition: Stalest Member

**Rule**: Group recency = `min(retrieved_at)` across all slices in the group for the relevant dates.

**Rationale**: A set is only as fresh as its oldest member. Using `max` would incorrectly favour sets with one very new slice and several stale slices.

```typescript
function getGroupRecency(slices: ParameterValue[]): number {
  let minTs = Number.POSITIVE_INFINITY;
  for (const slice of slices) {
    const ts = slice.retrieved_at ? new Date(slice.retrieved_at).getTime() : 0;
    if (ts < minTs) minTs = ts;
  }
  return Number.isFinite(minTs) ? minTs : 0;
}
```

**Tie-break**: "Most recent wins" means "largest min-ts wins".

### C2. Deterministic Final Tie-Break

When two groups have identical priority AND identical recency, use lexicographic ordering:

1. Sort by `dimensionKeys.sort().join('|')` ascending
2. If still tied, sort by `querySignature` string ascending

This ensures reproducible behaviour regardless of iteration order.

### C3. `missing`/`error` Context Hashes: Non-Match

**Rule**: If `cache.contextDefHashes[key]` is `'missing'` or `'error'`, treat as **incompatible** with any query that specifies that key.

**Rationale**: We cannot validate correctness without the actual hash. Fail-safe > false positive.

```typescript
// In signatureCanSatisfy:
if (cacheDefHash === 'missing' || cacheDefHash === 'error') {
  return { compatible: false, reason: `context_hash_unavailable:${key}` };
}
```

### C4. Dedupe Rule Before Aggregation

**Rule**: Before summing slices, dedupe by `(sliceDSL, query_signature, window_from, window_to)`.

If duplicates exist (e.g. file corruption), keep the one with most recent `retrieved_at`.

---

## Scenario Index

| # | Name | Tests |
|---|------|-------|
| 1 | Core hash mismatch | Signature gate correctness |
| 2 | Structured subset match | Compatibility ≠ usability |
| 3 | Missing query dimension in group | Hard fail |
| 4 | Sparse Cartesian false-positive | Combinations check |
| 5 | Union pattern epoch | No double-count |
| 6 | Mixed pattern epoch | Unusable partial multi-dim |
| 7 | Three-epoch query | Full temporal heterogeneity |
| 8 | Overlapping coverage | Prefer exact cache |
| 9 | Gap detection | Refuse to paper over |
| 10 | Recency tie-break | Most recent wins |
| 11 | Stale member in group | Stalest member rule |
| 12 | Context definition changes | Intentional invalidation |
| 13 | Event definition changes | coreHash invalidation |
| 14 | missing/error hashes | Fail-safe |
| 15 | Duplicate slices | Double-count prevention |

---

## Scenario 1: Core Hash Mismatch (Signature Gate Correctness)

### Purpose
Prove we never aggregate semantically incompatible data even if it "looks MECE".

### Setup

**Context definitions**:
```yaml
channel: [google, meta, other]
```

**Cache state** (complete MECE):
```
Slice 1: context(channel:google), dates: [1-Nov, 2-Nov, 3-Nov]
         query_signature: {"c":"OLD-CORE-HASH","x":{"channel":"ch-v1"}}
         
Slice 2: context(channel:meta), dates: [1-Nov, 2-Nov, 3-Nov]
         query_signature: {"c":"OLD-CORE-HASH","x":{"channel":"ch-v1"}}
         
Slice 3: context(channel:other), dates: [1-Nov, 2-Nov, 3-Nov]
         query_signature: {"c":"OLD-CORE-HASH","x":{"channel":"ch-v1"}}
```

**Query**:
```
DSL: window(1-Nov-25:3-Nov-25)  // uncontexted
Current signature: {"c":"NEW-CORE-HASH","x":{}}
```

The core hash differs because (any of):
- Different latency anchor event
- Different event definitions
- Different connection

### Pipeline Trace

| Step | Action | Result |
|------|--------|--------|
| A | `canCacheSatisfyQuery` for each slice | **FAIL** — `coreHash` mismatch (`OLD ≠ NEW`) |
| B | (not reached) | — |
| C | (not reached) | — |
| D | (not reached) | — |
| E | (not reached) | — |

### Expected Outcome

```
{
  fullyCovered: false,
  uncoveredDates: ['1-Nov-25', '2-Nov-25', '3-Nov-25'],
  reason: 'signature_incompatible:core_hash_mismatch'
}
```

### Verification

- [ ] All 3 slices rejected at Step A
- [ ] No aggregation attempted
- [ ] System reports needs_fetch

---

## Scenario 2: Structured Subset Match (Compatibility ≠ Usability)

### Purpose
Validate "compatibility first, then completeness" — passing Step A does not guarantee coverage.

### Setup

**Context definitions**:
```yaml
channel: [google, meta]
device: [mobile, desktop]
```

**Cache state** (partial — only google×device):
```
Slice 1: context(channel:google).context(device:mobile), dates: [1-Nov, 2-Nov]
         query_signature: {"c":"ABC","x":{"channel":"ch1","device":"dv1"}}
         
Slice 2: context(channel:google).context(device:desktop), dates: [1-Nov, 2-Nov]
         query_signature: {"c":"ABC","x":{"channel":"ch1","device":"dv1"}}
```

**Query**:
```
DSL: window(1-Nov-25:2-Nov-25)  // uncontexted
Current signature: {"c":"ABC","x":{}}
```

### Pipeline Trace

| Step | Action | Result |
|------|--------|--------|
| A | `canCacheSatisfyQuery` | **PASS** — empty `x` ⊆ any `x` |
| B | Eligibility check | **PASS** — both are valid multi-context slices |
| C | Group by dimension set | 1 group: `{channel, device}` with 2 slices |
| D | Evaluate for uncontexted query | **FAIL** — channel incomplete (only `google`, missing `meta`) |
| E | (not reached) | — |

### Expected Outcome

```
{
  fullyCovered: false,
  uncoveredDates: ['1-Nov-25', '2-Nov-25'],
  reason: 'dimension_not_mece:channel',
  detail: { valuesPresent: ['google'], missingValues: ['meta'] }
}
```

### Verification

- [ ] Step A passes (signature structurally compatible)
- [ ] Step D fails (MECE check for channel fails)
- [ ] No false coverage claim

---

## Scenario 3: Missing Query Dimension in Group (Hard Fail)

### Purpose
Prevent bogus "partial dimension" answers when cache doesn't have the requested dimension at all.

### Setup

**Context definitions**:
```yaml
channel: [google, meta, other]
device: [mobile, desktop, tablet]
```

**Cache state** (complete MECE for channel):
```
Slice 1: context(channel:google), dates: [1-Nov, 2-Nov]
Slice 2: context(channel:meta), dates: [1-Nov, 2-Nov]
Slice 3: context(channel:other), dates: [1-Nov, 2-Nov]
All with signature: {"c":"ABC","x":{"channel":"ch1"}}
```

**Query**:
```
DSL: context(device:mobile).window(1-Nov-25:2-Nov-25)
Current signature: {"c":"ABC","x":{"device":"dv1"}}
```

### Pipeline Trace

| Step | Action | Result |
|------|--------|--------|
| A | `canCacheSatisfyQuery` | **FAIL** — cache has `channel` key, query has `device` key; query requires `device` but cache doesn't have it |
| B | (not reached) | — |
| C | (not reached) | — |
| D | (not reached) | — |
| E | (not reached) | — |

**Alternative interpretation** (if signature matching is looser):

| Step | Action | Result |
|------|--------|--------|
| A | (assuming it somehow passes) | — |
| C | Group: `{channel}` | 3 slices |
| D | Query specifies `device`, group lacks `device` | **FAIL** — `group_missing_query_dimension:device` |

### Expected Outcome

```
{
  fullyCovered: false,
  uncoveredDates: ['1-Nov-25', '2-Nov-25'],
  reason: 'group_missing_query_dimension:device'
}
```

### Verification

- [ ] No group can satisfy a query for a dimension it doesn't contain
- [ ] System does not fabricate data

---

## Scenario 4: Sparse Cartesian False-Positive Prevention (Combinations Check)

### Purpose
Validate we don't undercount by aggregating sparse matrices where per-dimension MECE passes but combinations are missing.

### Setup

**Context definitions**:
```yaml
channel: [google, meta, tiktok, other]  # 4 values
device: [mobile, desktop, tablet, ios, android]  # 5 values
```

**Cache state** (9 slices, NOT complete 4×5=20):
```
google×mobile, google×desktop, google×tablet, google×ios, google×android  (5)
meta×mobile  (1)
tiktok×mobile  (1)
other×mobile, other×desktop  (2)

All with signature: {"c":"ABC","x":{"channel":"ch1","device":"dv1"}}
```

**Query**:
```
DSL: window(1-Nov-25:7-Nov-25)  // uncontexted
Current signature: {"c":"ABC","x":{}}
```

### Pipeline Trace

| Step | Action | Result |
|------|--------|--------|
| A | `canCacheSatisfyQuery` | **PASS** — empty ⊆ any |
| B | Eligibility check | **PASS** — all valid multi-context |
| C | Group: `{channel, device}` | 9 slices |
| D.1 | Per-dim MECE for channel | **PASS** — all 4 present |
| D.2 | Per-dim MECE for device | **PASS** — all 5 present |
| D.3 | Combinations check | **FAIL** — only 9/20 combinations exist |
| E | (not reached) | — |

### Expected Outcome

```
{
  fullyCovered: false,
  uncoveredDates: ['1-Nov-25', ..., '7-Nov-25'],
  reason: 'missing_combinations',
  detail: {
    expectedCombinations: 20,
    actualCombinations: 9,
    missingExamples: ['meta×desktop', 'meta×tablet', ...]
  }
}
```

### Verification

- [ ] Per-dimension MECE checks pass (necessary condition)
- [ ] Combinations check fails (sufficient condition not met)
- [ ] No aggregation of incomplete Cartesian product

---

## Scenario 5: Union Pattern Epoch (No Double-Count)

### Purpose
Confirm the "choose-one" invariant for union-shaped caches where multiple groups satisfy.

### Setup

**Context definitions**:
```yaml
channel: [google, meta]
device: [mobile, desktop]
```

**Cache state** (from pinned DSL: `context(channel);context(device)`):
```
# {channel} group
context(channel:google), dates: [1-Nov], n_daily: [100], retrieved_at: 2025-11-01T10:00:00Z
context(channel:meta), dates: [1-Nov], n_daily: [150], retrieved_at: 2025-11-01T10:00:00Z

# {device} group
context(device:mobile), dates: [1-Nov], n_daily: [120], retrieved_at: 2025-11-01T12:00:00Z
context(device:desktop), dates: [1-Nov], n_daily: [130], retrieved_at: 2025-11-01T12:00:00Z

All with signature: {"c":"ABC","x":{}} (uncontexted-compatible)
```

**Query**:
```
DSL: window(1-Nov-25:1-Nov-25)  // uncontexted
```

### Pipeline Trace

| Step | Action | Result |
|------|--------|--------|
| A | `canCacheSatisfyQuery` | **PASS** for all 4 slices |
| B | Eligibility | **PASS** for all |
| C | Groups | `{channel}`: 2 slices, `{device}`: 2 slices |
| D | For date 1-Nov: | |
| | — `{channel}` MECE? | **PASS** (google + meta) |
| | — `{device}` MECE? | **PASS** (mobile + desktop) |
| | — Both satisfy | Choose by recency |
| | — Recency: `{channel}` min=10:00, `{device}` min=12:00 | `{device}` wins (12:00 > 10:00) |
| E | Aggregate `{device}` only | n_daily = [120 + 130] = [250] |

### Expected Outcome

```
{
  fullyCovered: true,
  dates: ['1-Nov-25'],
  n_daily: [250],  // NOT 100+150+120+130=500 (double-count)
  selectedGroup: { dimensionKeys: ['device'] }
}
```

### Verification

- [ ] Only ONE group contributes to each date
- [ ] Recency tie-break selects fresher group
- [ ] Total matches sum of selected group only (250, not 500)

---

## Scenario 6: Mixed Pattern Epoch (Unusable Partial Multi-Dim)

### Purpose
Prove we do not get seduced into using partial multi-dim slices when a complete single-dim group exists.

### Setup

**Context definitions**:
```yaml
channel: [google, meta, other]
device: [mobile, desktop, tablet]
```

**Cache state** (from pinned DSL: `context(channel);context(device:mobile).context(channel)`):
```
# {channel} group — complete MECE
context(channel:google), dates: [1-Nov], n_daily: [100]
context(channel:meta), dates: [1-Nov], n_daily: [80]
context(channel:other), dates: [1-Nov], n_daily: [50]

# {channel, device} group — only mobile row (incomplete for device)
context(channel:google).context(device:mobile), dates: [1-Nov], n_daily: [60]
context(channel:meta).context(device:mobile), dates: [1-Nov], n_daily: [45]
context(channel:other).context(device:mobile), dates: [1-Nov], n_daily: [30]

All with matching signature.
```

**Query**:
```
DSL: window(1-Nov-25:1-Nov-25)  // uncontexted
```

### Pipeline Trace

| Step | Action | Result |
|------|--------|--------|
| A | `canCacheSatisfyQuery` | **PASS** for all 6 slices |
| B | Eligibility | **PASS** |
| C | Groups | `{channel}`: 3 slices, `{channel,device}`: 3 slices |
| D | For date 1-Nov: | |
| | — `{channel}` MECE for channel? | **PASS** |
| | — `{channel,device}` MECE for channel? | **PASS** |
| | — `{channel,device}` MECE for device? | **FAIL** (only `mobile`, missing `desktop`, `tablet`) |
| | — Satisfying groups | Only `{channel}` |
| E | Aggregate `{channel}` | n_daily = [100 + 80 + 50] = [230] |

### Expected Outcome

```
{
  fullyCovered: true,
  dates: ['1-Nov-25'],
  n_daily: [230],
  selectedGroup: { dimensionKeys: ['channel'] },
  rejectedGroups: [
    { dimensionKeys: ['channel', 'device'], reason: 'dimension_not_mece:device' }
  ]
}
```

### Verification

- [ ] `{channel,device}` group rejected due to incomplete device
- [ ] `{channel}` group selected
- [ ] Aggregation uses only the complete group

---

## Scenario 7: Three-Epoch Query (Full Temporal Heterogeneity)

### Purpose
Validate the entire temporal heterogeneity story end-to-end, with group switching across epochs.

### Setup

**Context definitions**:
```yaml
channel: [google, meta]
device: [mobile, desktop]
```

**Cache state** (6 weeks, 3 different pinned DSL patterns):

**Epoch 1 (1-Nov to 14-Nov)**: Cartesian `context(channel).context(device)`
```
google×mobile: dates=[1-Nov,7-Nov,14-Nov], n_daily=[100,110,120]
google×desktop: dates=[1-Nov,7-Nov,14-Nov], n_daily=[150,160,170]
meta×mobile: dates=[1-Nov,7-Nov,14-Nov], n_daily=[80,85,90]
meta×desktop: dates=[1-Nov,7-Nov,14-Nov], n_daily=[120,125,130]
```

**Epoch 2 (15-Nov to 28-Nov)**: Union `context(channel);context(device)`
```
# {channel} group
google: dates=[15-Nov,21-Nov,28-Nov], n_daily=[250,270,290], retrieved_at=T1
meta: dates=[15-Nov,21-Nov,28-Nov], n_daily=[200,210,220], retrieved_at=T1

# {device} group
mobile: dates=[15-Nov,21-Nov,28-Nov], n_daily=[180,190,200], retrieved_at=T2 (T2 > T1)
desktop: dates=[15-Nov,21-Nov,28-Nov], n_daily=[270,290,310], retrieved_at=T2
```

**Epoch 3 (29-Nov to 12-Dec)**: Mixed `context(channel);context(device:mobile).context(channel)`
```
# {channel} group
google: dates=[29-Nov,5-Dec,12-Dec], n_daily=[300,320,340]
meta: dates=[29-Nov,5-Dec,12-Dec], n_daily=[220,230,240]

# {channel, device} group — only mobile row
google×mobile: dates=[29-Nov,5-Dec,12-Dec], n_daily=[130,140,150]
meta×mobile: dates=[29-Nov,5-Dec,12-Dec], n_daily=[100,105,110]
```

**Query**:
```
DSL: window(1-Nov-25:12-Dec-25)  // uncontexted, 9 sample dates
```

### Pipeline Trace

| Date | Available Groups | Satisfying Groups | Selected | n_daily |
|------|-----------------|-------------------|----------|---------|
| 1-Nov | `{ch,dev}` | `{ch,dev}` ✓ | `{ch,dev}` | 100+150+80+120=450 |
| 7-Nov | `{ch,dev}` | `{ch,dev}` ✓ | `{ch,dev}` | 110+160+85+125=480 |
| 14-Nov | `{ch,dev}` | `{ch,dev}` ✓ | `{ch,dev}` | 120+170+90+130=510 |
| 15-Nov | `{ch}`, `{dev}` | Both ✓ | `{dev}` (fresher) | 180+270=450 |
| 21-Nov | `{ch}`, `{dev}` | Both ✓ | `{dev}` (fresher) | 190+290=480 |
| 28-Nov | `{ch}`, `{dev}` | Both ✓ | `{dev}` (fresher) | 200+310=510 |
| 29-Nov | `{ch}`, `{ch,dev}` | `{ch}` ✓, `{ch,dev}` ✗ | `{ch}` | 300+220=520 |
| 5-Dec | `{ch}`, `{ch,dev}` | `{ch}` ✓, `{ch,dev}` ✗ | `{ch}` | 320+230=550 |
| 12-Dec | `{ch}`, `{ch,dev}` | `{ch}` ✓, `{ch,dev}` ✗ | `{ch}` | 340+240=580 |

### Expected Outcome

```
{
  fullyCovered: true,
  dates: ['1-Nov', '7-Nov', '14-Nov', '15-Nov', '21-Nov', '28-Nov', '29-Nov', '5-Dec', '12-Dec'],
  n_daily: [450, 480, 510, 450, 480, 510, 520, 550, 580],
  perDateSelection: [
    { date: '1-Nov', group: '{ch,dev}', type: 'multi_dim_reduction' },
    { date: '7-Nov', group: '{ch,dev}', type: 'multi_dim_reduction' },
    { date: '14-Nov', group: '{ch,dev}', type: 'multi_dim_reduction' },
    { date: '15-Nov', group: '{dev}', type: 'single_dim_mece' },
    { date: '21-Nov', group: '{dev}', type: 'single_dim_mece' },
    { date: '28-Nov', group: '{dev}', type: 'single_dim_mece' },
    { date: '29-Nov', group: '{ch}', type: 'single_dim_mece' },
    { date: '5-Dec', group: '{ch}', type: 'single_dim_mece' },
    { date: '12-Dec', group: '{ch}', type: 'single_dim_mece' },
  ]
}
```

### Verification

- [ ] Epoch 1: `{ch,dev}` used (only option with slices for those dates)
- [ ] Epoch 2: `{dev}` used (fresher than `{ch}`)
- [ ] Epoch 3: `{ch}` used (`{ch,dev}` rejected for incomplete device)
- [ ] Group switching occurs at epoch boundaries
- [ ] No double-count at any date

---

## Scenario 8: Overlapping Coverage (Prefer Exact Cache)

### Purpose
Ensure the system prefers simplest exact cache over reduction, but remains robust to partial overlaps.

### Setup

**Context definitions**:
```yaml
channel: [google, meta]
```

**Cache state** (same dates, different granularities):
```
# {} group — uncontexted exact
<uncontexted>: dates=[1-Nov,2-Nov,3-Nov,4-Nov], n_daily=[300,310,320,330]

# {channel} group — complete MECE
google: dates=[1-Nov,2-Nov,3-Nov,4-Nov,5-Nov,6-Nov,7-Nov], n_daily=[150,155,160,165,170,175,180]
meta: dates=[1-Nov,2-Nov,3-Nov,4-Nov,5-Nov,6-Nov,7-Nov], n_daily=[150,155,160,165,170,175,180]
```

**Query**:
```
DSL: window(1-Nov-25:7-Nov-25)  // uncontexted
```

### Pipeline Trace

| Date | Available Groups | Satisfying Groups | Priority | Selected |
|------|-----------------|-------------------|----------|----------|
| 1-Nov | `{}`, `{ch}` | `{}` exact, `{ch}` MECE | exact > MECE | `{}` |
| 2-Nov | `{}`, `{ch}` | `{}` exact, `{ch}` MECE | exact > MECE | `{}` |
| 3-Nov | `{}`, `{ch}` | `{}` exact, `{ch}` MECE | exact > MECE | `{}` |
| 4-Nov | `{}`, `{ch}` | `{}` exact, `{ch}` MECE | exact > MECE | `{}` |
| 5-Nov | `{ch}` | `{ch}` MECE | only option | `{ch}` |
| 6-Nov | `{ch}` | `{ch}` MECE | only option | `{ch}` |
| 7-Nov | `{ch}` | `{ch}` MECE | only option | `{ch}` |

### Expected Outcome

```
{
  fullyCovered: true,
  dates: ['1-Nov', '2-Nov', '3-Nov', '4-Nov', '5-Nov', '6-Nov', '7-Nov'],
  n_daily: [300, 310, 320, 330, 340, 350, 360],  // 340=170+170, etc.
  perDateSelection: [
    { date: '1-Nov', group: '{}', type: 'exact' },
    { date: '2-Nov', group: '{}', type: 'exact' },
    { date: '3-Nov', group: '{}', type: 'exact' },
    { date: '4-Nov', group: '{}', type: 'exact' },
    { date: '5-Nov', group: '{ch}', type: 'single_dim_mece' },
    { date: '6-Nov', group: '{ch}', type: 'single_dim_mece' },
    { date: '7-Nov', group: '{ch}', type: 'single_dim_mece' },
  ]
}
```

### Verification

- [ ] Exact uncontexted cache preferred when available
- [ ] Falls back to MECE reduction for dates without exact cache
- [ ] Seamless transition between coverage sources

---

## Scenario 9: Gap Detection (Refuse to Paper Over)

### Purpose
Prove correctness over convenience — never fabricate coverage for missing dates.

### Setup

**Context definitions**:
```yaml
channel: [google, meta]
```

**Cache state** (epochs 1 and 3 present, epoch 2 missing):

**Epoch 1 (1-Nov to 7-Nov)**: Complete
```
google: dates=[1-Nov,7-Nov], n_daily=[100,110]
meta: dates=[1-Nov,7-Nov], n_daily=[80,85]
```

**Epoch 2 (8-Nov to 14-Nov)**: MISSING — no slices at all

**Epoch 3 (15-Nov to 21-Nov)**: Complete
```
google: dates=[15-Nov,21-Nov], n_daily=[150,160]
meta: dates=[15-Nov,21-Nov], n_daily=[120,125]
```

**Query**:
```
DSL: window(1-Nov-25:21-Nov-25)  // uncontexted
Dates requested: [1-Nov, 7-Nov, 8-Nov, 14-Nov, 15-Nov, 21-Nov]
```

### Pipeline Trace

| Date | Available Groups | Result |
|------|-----------------|--------|
| 1-Nov | `{ch}` | ✓ Satisfied |
| 7-Nov | `{ch}` | ✓ Satisfied |
| 8-Nov | (none) | ✗ **UNCOVERED** |
| 14-Nov | (none) | ✗ **UNCOVERED** |
| 15-Nov | `{ch}` | ✓ Satisfied |
| 21-Nov | `{ch}` | ✓ Satisfied |

### Expected Outcome

```
{
  fullyCovered: false,
  uncoveredDates: ['8-Nov-25', '14-Nov-25'],
  reason: 'gap_in_coverage',
  coveredDates: ['1-Nov-25', '7-Nov-25', '15-Nov-25', '21-Nov-25']
}
```

### Verification

- [ ] Gap detected and reported
- [ ] No partial aggregation returned
- [ ] System reports needs_fetch for gap dates

---

## Scenario 10: Recency Tie-Break (Most Recent Wins)

### Purpose
Validate the tie-break rule when multiple groups have identical priority.

### Setup

**Context definitions**:
```yaml
channel: [google, meta]
device: [mobile, desktop]
```

**Cache state** (union pattern, different recency):
```
# {channel} group — OLD (retrieved 2 days ago)
google: dates=[1-Nov], n_daily=[100], retrieved_at=2025-10-30T10:00:00Z
meta: dates=[1-Nov], n_daily=[80], retrieved_at=2025-10-30T10:00:00Z

# {device} group — NEW (retrieved today)
mobile: dates=[1-Nov], n_daily=[90], retrieved_at=2025-11-01T10:00:00Z
desktop: dates=[1-Nov], n_daily=[90], retrieved_at=2025-11-01T10:00:00Z
```

**Query**:
```
DSL: window(1-Nov-25:1-Nov-25)  // uncontexted
```

### Pipeline Trace

| Step | Action | Result |
|------|--------|--------|
| D | Both groups satisfy | |
| | — `{ch}` priority: single_dim_mece | |
| | — `{dev}` priority: single_dim_mece | |
| | — Same priority, check recency | |
| | — `{ch}` recency: min(Oct30) = Oct30 | |
| | — `{dev}` recency: min(Nov1) = Nov1 | |
| | — Nov1 > Oct30 | `{dev}` wins |

### Expected Outcome

```
{
  fullyCovered: true,
  dates: ['1-Nov-25'],
  n_daily: [180],  // 90+90 from {dev}
  selectedGroup: { dimensionKeys: ['device'], recency: '2025-11-01T10:00:00Z' }
}
```

### Verification

- [ ] Same priority leads to recency comparison
- [ ] More recent group selected
- [ ] Aggregation uses selected group only

---

## Scenario 11: Stale Member in Group (Stalest Member Rule)

### Purpose
Force the spec to use correct recency definition (min, not max).

### Setup

**Context definitions**:
```yaml
channel: [google, meta]
device: [mobile, desktop]
```

**Cache state** (union pattern, mixed recency within groups):
```
# {channel} group — MIXED (one very old, one very new)
google: dates=[1-Nov], n_daily=[100], retrieved_at=2025-10-01T10:00:00Z  # VERY OLD
meta: dates=[1-Nov], n_daily=[80], retrieved_at=2025-11-01T10:00:00Z    # VERY NEW

# {device} group — UNIFORM (moderately new)
mobile: dates=[1-Nov], n_daily=[90], retrieved_at=2025-10-25T10:00:00Z
desktop: dates=[1-Nov], n_daily=[90], retrieved_at=2025-10-25T10:00:00Z
```

**Query**: uncontexted

### Pipeline Trace

With **CORRECT** recency (min of members):
- `{ch}` recency: min(Oct1, Nov1) = **Oct1** (very stale)
- `{dev}` recency: min(Oct25, Oct25) = **Oct25** (moderately fresh)
- Oct25 > Oct1 → `{dev}` wins ✓

With **INCORRECT** recency (max of members):
- `{ch}` recency: max(Oct1, Nov1) = **Nov1** (looks fresh!)
- `{dev}` recency: max(Oct25, Oct25) = **Oct25**
- Nov1 > Oct25 → `{ch}` wins ✗ (but has stale data!)

### Expected Outcome (CORRECT)

```
{
  fullyCovered: true,
  selectedGroup: { dimensionKeys: ['device'] },
  n_daily: [180]  // from {dev}
}
```

### Verification

- [ ] Group recency = stalest member
- [ ] Group with uniformly fresh data beats group with mixed recency
- [ ] No aggregation of potentially stale + fresh data

---

## Scenario 12: Context Definition Changes (Intentional Invalidation)

### Purpose
Validate that edits to context definition files bust caches.

### Setup

**Context definition v1** (before edit):
```yaml
channel:
  values: [google, meta, other]
  # hash: "ch-v1"
```

**Context definition v2** (after edit — added 'tiktok'):
```yaml
channel:
  values: [google, meta, other, tiktok]
  # hash: "ch-v2"
```

**Cache state** (created under v1):
```
Epoch 1 (1-Nov to 7-Nov): created under v1
  google: dates=[1-Nov,7-Nov], query_signature={"c":"ABC","x":{"channel":"ch-v1"}}
  meta: dates=[1-Nov,7-Nov], query_signature={"c":"ABC","x":{"channel":"ch-v1"}}
  other: dates=[1-Nov,7-Nov], query_signature={"c":"ABC","x":{"channel":"ch-v1"}}

Epoch 2 (8-Nov to 14-Nov): created under v2
  google: dates=[8-Nov,14-Nov], query_signature={"c":"ABC","x":{"channel":"ch-v2"}}
  meta: dates=[8-Nov,14-Nov], query_signature={"c":"ABC","x":{"channel":"ch-v2"}}
  other: dates=[8-Nov,14-Nov], query_signature={"c":"ABC","x":{"channel":"ch-v2"}}
  tiktok: dates=[8-Nov,14-Nov], query_signature={"c":"ABC","x":{"channel":"ch-v2"}}
```

**Query** (executed under v2):
```
DSL: context(channel:google).window(1-Nov-25:14-Nov-25)
Current signature: {"c":"ABC","x":{"channel":"ch-v2"}}
```

### Pipeline Trace

| Step | Epoch 1 Slices | Epoch 2 Slices |
|------|---------------|----------------|
| A | `canCacheSatisfyQuery`: query has `channel:ch-v2`, cache has `channel:ch-v1` → **FAIL** | `channel:ch-v2` = `channel:ch-v2` → **PASS** |

Result: Only epoch 2 slices pass signature gate.

| Date | Available Groups | Result |
|------|-----------------|--------|
| 1-Nov | (none pass sig filter) | ✗ **UNCOVERED** |
| 7-Nov | (none pass sig filter) | ✗ **UNCOVERED** |
| 8-Nov | `{ch}` | ✓ Exact match |
| 14-Nov | `{ch}` | ✓ Exact match |

### Expected Outcome

```
{
  fullyCovered: false,
  uncoveredDates: ['1-Nov-25', '7-Nov-25'],
  reason: 'context_definition_changed',
  detail: 'Epoch 1 slices invalidated by contextDefHash mismatch'
}
```

### Verification

- [ ] Old-definition slices rejected at Step A
- [ ] New-definition slices usable
- [ ] Partial coverage reported, triggering refetch for old dates

---

## Scenario 13: Event Definition Changes (coreHash Invalidation)

### Purpose
Ensure `coreHash` changes when event definitions are edited.

### Setup

**Event definition v1**:
```yaml
event-conversion:
  provider_event_names:
    amplitude: "OldConversionEvent"
```

**Event definition v2** (edited):
```yaml
event-conversion:
  provider_event_names:
    amplitude: "NewConversionEvent"
```

**Cache state**:
```
Epoch 1 (under v1): coreHash includes hash of v1 event def
  google: query_signature={"c":"CORE-V1","x":{"channel":"ch1"}}

Epoch 2 (under v2): coreHash includes hash of v2 event def
  google: query_signature={"c":"CORE-V2","x":{"channel":"ch1"}}
```

**Query** (executed under v2):
```
Current signature: {"c":"CORE-V2","x":{}}
```

### Pipeline Trace

| Slice | coreHash Match? | Result |
|-------|----------------|--------|
| Epoch 1 | CORE-V1 ≠ CORE-V2 | **REJECTED** |
| Epoch 2 | CORE-V2 = CORE-V2 | **PASS** |

### Expected Outcome

```
{
  fullyCovered: false,  // if query spans both epochs
  reason: 'event_definition_changed',
  detail: 'Epoch 1 invalidated by coreHash mismatch (event def hash changed)'
}
```

### Verification

- [ ] Event definition changes reflected in coreHash
- [ ] Old caches with different event definitions rejected
- [ ] No stale data served after semantic changes

---

## Scenario 14: `missing`/`error` Context Hashes (Fail-Safe)

### Purpose
Prevent silent incorrect reuse when we can't validate correctness.

### Setup

**Cache state** (context hash load failed):
```
google: query_signature={"c":"ABC","x":{"channel":"missing"}}  # load failure
meta: query_signature={"c":"ABC","x":{"channel":"missing"}}
```

**Query**:
```
DSL: context(channel:google).window(1-Nov-25:7-Nov-25)
Current signature: {"c":"ABC","x":{"channel":"ch-real-hash"}}
```

### Pipeline Trace

| Step | Action | Result |
|------|--------|--------|
| A | `canCacheSatisfyQuery`: query has `channel:ch-real-hash`, cache has `channel:missing` | **FAIL** (per C3 rule) |

### Expected Outcome

```
{
  fullyCovered: false,
  reason: 'context_hash_unavailable:channel',
  detail: 'Cache has missing/error hash, cannot validate'
}
```

### Verification

- [ ] `missing` hash treated as incompatible
- [ ] `error` hash treated as incompatible
- [ ] No false cache hits when validation impossible

---

## Scenario 15: Duplicate Slices (Double-Count Prevention)

### Purpose
Guard against file corruption or accidental duplication.

### Setup

**Context definitions**:
```yaml
channel: [google, meta]
```

**Cache state** (DUPLICATE google slice):
```
google: dates=[1-Nov], n_daily=[100], retrieved_at=2025-11-01T09:00:00Z
google: dates=[1-Nov], n_daily=[100], retrieved_at=2025-11-01T10:00:00Z  # DUPLICATE
meta: dates=[1-Nov], n_daily=[80], retrieved_at=2025-11-01T10:00:00Z
```

**Query**: uncontexted

### Pipeline Trace (WITHOUT dedupe)

```
Sum: 100 + 100 + 80 = 280  ✗ WRONG (should be 180)
```

### Pipeline Trace (WITH dedupe per C4)

| Step | Action | Result |
|------|--------|--------|
| Pre-D | Dedupe by `(sliceDSL, sig, window)` | |
| | — google@09:00, google@10:00 → keep @10:00 (fresher) | |
| | — Remaining: google@10:00, meta@10:00 | |
| D | MECE check | PASS |
| E | Aggregate | 100 + 80 = 180 ✓ |

### Expected Outcome

```
{
  fullyCovered: true,
  n_daily: [180],  // NOT 280
  dedupeApplied: true,
  duplicatesRemoved: 1
}
```

### Verification

- [ ] Duplicates detected before aggregation
- [ ] Fresher duplicate retained
- [ ] Aggregation correct after dedupe

---

## Summary: Test Coverage Matrix

| Scenario | Step A | Step B | Step C | Step D | Step E | Key Assertion |
|----------|--------|--------|--------|--------|--------|---------------|
| 1 | ✗ FAIL | — | — | — | — | coreHash mismatch blocks |
| 2 | ✓ | ✓ | 1 group | ✗ MECE | — | Compatibility ≠ coverage |
| 3 | ✗/✓ | — | — | ✗ missing dim | — | Can't invent dimensions |
| 4 | ✓ | ✓ | 1 group | ✗ combos | — | Sparse matrix rejected |
| 5 | ✓ | ✓ | 2 groups | ✓ both | ✓ one | No double-count |
| 6 | ✓ | ✓ | 2 groups | ✓ one | ✓ | Partial multi-dim unusable |
| 7 | ✓ | ✓ | varies | ✓ varies | ✓ | Group switching works |
| 8 | ✓ | ✓ | 2 groups | ✓ both | ✓ | Exact preferred |
| 9 | ✓ | ✓ | 1 group | ✗ gap | — | Gap detection |
| 10 | ✓ | ✓ | 2 groups | ✓ both | ✓ | Recency tie-break |
| 11 | ✓ | ✓ | 2 groups | ✓ both | ✓ | Stalest member rule |
| 12 | partial | — | — | partial | — | contextDefHash invalidation |
| 13 | partial | — | — | partial | — | coreHash invalidation |
| 14 | ✗ FAIL | — | — | — | — | missing/error = non-match |
| 15 | ✓ | ✓ | 1 group | ✓ | ✓ | Dedupe prevents double-count |

---

## Implementation Checklist

Before implementation, confirm these rules are codified:

### Design Clarifications (C1-C4)

- [ ] **C1**: `getGroupRecency` uses `min(retrieved_at)` (stalest member)
- [ ] **C2**: Final tie-break is deterministic (lexicographic on dims, then sig)
- [ ] **C3**: `missing`/`error` hashes → non-match
- [ ] **C4**: Dedupe before aggregation

### Hardening Requirements (H1-H6)

- [ ] **H1**: `parseSignature` never throws (defensive parsing for legacy/malformed signatures)
- [ ] **H2**: `extractContextMap` is memoized (module-level cache)
- [ ] **H3**: Module dependency layers respected (no circular imports)
- [ ] **H4**: `verifyAllCombinationsExist` has early exits and bounded iteration
- [ ] **H5**: Session logs include `recencyRule: 'stalest_member'` for diagnostics
- [ ] **H6**: `dedupeSlices` called in `aggregateWithTemporalGroupSwitching` before summing

Each scenario above should become 1–2 test cases in the implementation phase.

---

## Revision History

| Date | Author | Changes |
|------|--------|---------|
| 29-Jan-26 | AI | Initial creation with 15 scenarios |
