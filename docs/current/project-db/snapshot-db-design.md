# Snapshot DB: High-Level Design

**Status**: Draft  
**Date**: 1-Feb-26  
**Companion document**: [Initial Thinking](./initial-thinking.md)

---

## 1. Objectives

Enable two commercial requirements that require **longitudinal snapshot history**:

1. **Conversion Lag Histogram**: Distribution of time from cohort entry to conversion, derived from successive daily snapshots
2. **Daily Conversions Bar Chart**: Count of conversions attributed to each calendar date within the query timeframe

These cannot be served from parameter files alone, which implement "latest wins" semantics and do not preserve snapshot history.

---

## 2. Core Architectural Principle

> **Frontend does ALL logical resolution. Python is told what to retrieve and derives the result.**

| Layer | Responsibility |
|-------|----------------|
| **Frontend (TypeScript)** | DSL parsing, signature computation, slice resolution, MECE verification, date coverage analysis, segment construction |
| **Backend (Python)** | DB query execution, MECE aggregation (sum), histogram/daily derivation |
| **Database (Postgres)** | Append-only snapshot storage, indexed by signature + slice + date |

This separation ensures:
- No replication of complex signature/MECE logic in Python
- Python never queries parameter files directly
- Frontend passes explicit coordinates; Python executes

---

## 3. Data Model

### 3.1 Single Table Design

One table serves ALL parameters from ALL workspaces. This is sufficient because:

1. **Workspace isolation**: `param_id` is prefixed with workspace (repo-branch), ensuring no cross-workspace collisions
2. **Signature-based sharing**: Within a workspace, parameters shared across graphs use the same `core_hash` when querying identical events — this is correct behaviour
3. **Simple operations**: No joins, no per-workspace tables, easy backups

### 3.2 DB Schema

```sql
CREATE TABLE snapshots (
    -- Identity (4 columns)
    param_id            TEXT NOT NULL,
    core_hash           TEXT NOT NULL,
    context_def_hashes  TEXT,               -- JSON object; see §3.7.6
    slice_key           TEXT NOT NULL,
    
    -- Time dimensions (2 columns)
    anchor_day          DATE NOT NULL,
    retrieved_at        TIMESTAMPTZ NOT NULL,   -- UTC; see §3.2.1
    
    -- Counts (3 columns)
    A                   INTEGER,
    X                   INTEGER,
    Y                   INTEGER,
    
    -- Latency (4 columns)
    median_lag_days         REAL,
    mean_lag_days           REAL,
    anchor_median_lag_days  REAL,
    anchor_mean_lag_days    REAL,
    
    PRIMARY KEY (param_id, core_hash, slice_key, anchor_day, retrieved_at)
);

CREATE INDEX idx_snapshots_lookup 
    ON snapshots (param_id, core_hash, slice_key, anchor_day);
```

**Total: 13 columns** (5 PK + 1 audit + 3 counts + 4 latency)

**Note on `context_def_hashes`:**
- Stores the `x` portion of the structured signature as JSON: `{"channel":"hash1","device":"hash2"}`
- NOT part of the primary key (V1 matching uses `core_hash` only)
- Allows future strict matching and audit of context definition evolution
- Nullable for backward compatibility (rows written before this decision)
- See §3.7.6 for decision rationale

#### 3.2.1 Timestamp Semantics (Blocker D Resolved)

**`retrieved_at` uses `TIMESTAMPTZ` with explicit UTC semantics.**

| Aspect | Specification |
|--------|--------------|
| **Storage type** | `TIMESTAMPTZ` (Postgres stores internally as UTC) |
| **Write format** | ISO 8601 with Z suffix: `2025-11-15T00:00:00Z` |
| **Read for derivation** | `(retrieved_at AT TIME ZONE 'UTC')::DATE` |
| **Display to user** | Convert to `d-MMM-yy` format in Python handler |

**Why TIMESTAMPTZ?**
- Avoids timezone ambiguity when computing per-day attribution
- `retrieved_at.date()` derivation is explicit and portable
- Postgres handles DST and timezone conversions correctly

**Write path (frontend → Python):**
```typescript
// Frontend sends ISO string
retrieved_at: new Date().toISOString()  // "2025-11-15T14:30:00.000Z"
```

**Read path (Python → frontend):**
```python
# Python formats for display (if needed)
from datetime import datetime
def format_date_uk(dt: datetime) -> str:
    return dt.strftime('%-d-%b-%y')  # "15-Nov-25"
```

**Date derivation (histogram/daily conversions):**
```sql
-- Attribution to calendar date (UTC)
SELECT (retrieved_at AT TIME ZONE 'UTC')::DATE AS attribution_date
```

### 3.3 Column Semantics

| Column | Source | Description |
|--------|--------|-------------|
| `param_id` | `${repo}-${branch}-${edge.p.id}` | Workspace-prefixed parameter identity |
| `core_hash` | `StructuredSignature.coreHash` | Semantic identity (includes cohort/window mode) |
| `slice_key` | `sliceDSL` | Context slice: `context(channel:google)` or `''` for uncontexted |
| `anchor_day` | Fetched data | Anchor date: A-entry (cohort) or X-entry (window) |
| `retrieved_at` | Fetch timestamp | When this snapshot was taken |
| `A` | Amplitude response | Anchor entrants (cohort mode; null for window) |
| `X` | Amplitude response | From-step count |
| `Y` | Amplitude response | To-step count (conversions) |
| `median_lag_days` | Amplitude `dayMedianTransTimes` | Median transition time to Y (days) |
| `mean_lag_days` | Amplitude `dayAvgTransTimes` | Mean transition time to Y (days) |
| `anchor_median_lag_days` | Amplitude `dayMedianTransTimes` | Median A→X time (days); null for 2-step funnel |
| `anchor_mean_lag_days` | Amplitude `dayAvgTransTimes` | Mean A→X time (days); null for 2-step funnel |

### 3.4 Why Store Latency?

Latency data (median/mean lag) is stored per row because:

1. **Not redundant**: Values differ per (anchor_day, retrieved_at) — later snapshots capture late converters, shifting the median
2. **Cheap**: 4 × REAL = 16 bytes/row
3. **Enables drift analysis**: Compare Amplitude's reported latency vs our ΔY-derived latency over time
4. **Latency trends**: Track whether conversion lag is increasing/decreasing across cohorts

Note: Lag histogram can also be **derived** from ΔY between successive snapshots (day-level granularity). Storing Amplitude's values provides sub-day precision and a reference for validation.

### 3.5 Why Signature Handles Intra-Workspace Sharing

Parameters are shared across graphs within a workspace. The signature system correctly handles this:

- `core_hash` is computed from **event IDs** (semantic identity), not node IDs (graph-local names)
- If two graphs reference the same parameter with the same underlying events, they produce identical signatures
- They correctly share snapshot data — it's the same Amplitude query

Cross-workspace isolation is achieved by the workspace prefix on `param_id`, not by signature differences.

### 3.6 Alignment with Structured Signatures

The `core_hash` is the same value computed by `computeQuerySignature()` in TypeScript. This ensures:
- Same signature logic for files and DB
- Frontend can pass pre-computed signature to Python
- No signature computation needed in Python

### 3.7 Context Definition Stability

**⚠️ DESIGN DECISION REQUIRED**

The serialised signature from `computeQuerySignature()` is a JSON structure:

```json
{"c":"coreHash","x":{"channel":"ch-def-hash","device":"dv-def-hash"}}
```

Where:
- `c` = `coreHash` — the hash of query semantics (events, path, mode, etc.)
- `x` = `contextDefHashes` — map of context dimension → definition hash

**The question:** What should we store in the DB `core_hash` column?

See **§3.7.1 Strategic Options** below for full analysis.

#### 3.7.1 Strategic Options for Context Definition Handling

**Background:** The current signature system splits query identity into:
1. `coreHash` — semantic inputs (events, path, cohort/window mode, event definitions)
2. `contextDefHashes` — per-context-dimension definition hashes

The question is what to store in the DB when writing snapshots.

---

**OPTION A: Store Full Serialised Signature**

Store `{"c":"...","x":{...}}` as the `core_hash` column.

| Pro | Con |
|-----|-----|
| Strict validation — only match when context defs identical | Change context def → orphans ALL historical data |
| Can detect when definitions changed | Add new context dimension → orphans ALL historical data |
| Semantically precise | Trivial context def changes break history |

**When this matters:**
- "google" channel definition adds pmax campaigns → all "google" snapshots orphaned
- Add "device" dimension to graph → all snapshots orphaned

---

**OPTION B: Store Only `coreHash` (exclude `contextDefHashes`)**

Extract `parseSignature(sig).coreHash` and store only that.

| Pro | Con |
|-----|-----|
| Context evolution doesn't orphan data | Cannot validate context definitions match |
| Add context dimensions freely | User must understand slice semantics may have evolved |
| Resilient to trivial changes | "google" from 6 months ago may have different definition |

**What's preserved:**
- Event definitions (event file changes → different coreHash)
- Query path (from/to/visited)
- Cohort vs window mode

**What's NOT validated:**
- Whether "google" means the same thing now as 6 months ago

---

**OPTION C: Store Both Separately**

Two columns: `core_hash` (just `c`) + `context_def_hashes` (the `x` object as JSON).

| Pro | Con |
|-----|-----|
| Flexible: can query with or without context validation | Schema complexity |
| Audit: can detect when definitions changed | Query complexity |
| Future-proof: supports strict mode later | More data per row |

**Query patterns:**
```sql
-- Flexible (ignore context def changes):
WHERE core_hash = 'abc123...'

-- Strict (require context defs match):
WHERE core_hash = 'abc123...' 
  AND context_def_hashes = '{"channel":"ch-hash"}'
```

---

**OPTION D: Store `coreHash` + Context Def Audit Table**

Store only `coreHash` in snapshots, but maintain separate audit table tracking context definition evolution.

```sql
CREATE TABLE context_def_history (
    param_id TEXT NOT NULL,
    slice_key TEXT NOT NULL,
    context_def_hash TEXT NOT NULL,
    first_seen TIMESTAMP,
    last_seen TIMESTAMP,
    PRIMARY KEY (param_id, slice_key, context_def_hash)
);
```

| Pro | Con |
|-----|-----|
| Snapshots table stays simple | Additional table to maintain |
| Full audit trail of definition evolution | More complex write path |
| Can warn when definitions changed | Two tables to query for full picture |
| Doesn't break matching | |

---

#### 3.7.2 Impact Analysis by Change Type

| Change Type | Option A | Option B | Option C | Option D |
|-------------|----------|----------|----------|----------|
| Change context definition | ❌ Orphans | ✅ Matches | ✅/⚠️ Choice | ✅ + Audit |
| Add new context dimension | ❌ Orphans | ✅ Matches | ✅/⚠️ Choice | ✅ + Audit |
| Add new context VALUE | ✅ New slice | ✅ New slice | ✅ New slice | ✅ New slice |
| Change event definition | ❌ Correct | ❌ Correct | ❌ Correct | ❌ Correct |
| Change query path | ❌ Correct | ❌ Correct | ❌ Correct | ❌ Correct |

**Note:** "Correct" means correctly identifies as different query. "Orphans" means data becomes inaccessible.

---

#### 3.7.3 MECE Aggregation Implications

MECE (Mutually Exclusive, Collectively Exhaustive) aggregation sums slice data to produce uncontexted totals.

**Key insight:** MECE validity depends on the PARTITION STRUCTURE, not the individual slice definitions.

| Scenario | MECE Valid? |
|----------|-------------|
| "google" definition changes (still one channel) | ✅ Still MECE — sum = total |
| Add new channel "tiktok" to partition | ✅ Still MECE — need new slice data |
| Remove channel from partition | ⚠️ Historical sum ≠ new total |

**Implication:** Even if "google" definition changes, the SUM of all channel slices still equals the total population. Individual slice semantics changed, but aggregate integrity preserved.

---

#### 3.7.4 Considerations

1. **How often do context definitions change?**
   - Trivial changes (whitespace, comments): Should NOT orphan data
   - Semantic changes (google adds pmax): Debatable — is old data still valid?
   - Structural changes (add dimension): Should NOT orphan existing data

2. **What does the user actually want to know?**
   - "What did we see for google channel?" → Option B suffices
   - "What did we see for google AS THEN DEFINED?" → Needs Option A or C

3. **Audit vs Validation**
   - Audit: "I want to know when definitions changed" → Option D
   - Validation: "I want to enforce definitions match" → Option A or C

4. **Implementation complexity**
   - Option A: Simplest write, strictest match
   - Option B: Simple write, flexible match
   - Option C: More complex schema
   - Option D: Additional table

---

#### 3.7.5 Byte Cost Analysis

**SHA-256 hash = 64 hex characters (64 bytes)**

**Serialised signature format:**
```json
{"c":"<64-char-hash>","x":{"channel":"<64-char-hash>","device":"<64-char-hash>"}}
```

**Byte sizes by context count:**

| Contexts | Full Serialised Sig | CoreHash Only | Difference |
|----------|--------------------:|---------------:|------------:|
| 0 | ~77 bytes | 64 bytes | +13 bytes |
| 1 | ~92 bytes | 64 bytes | +28 bytes |
| 2 | ~158 bytes | 64 bytes | +94 bytes |
| 3 | ~224 bytes | 64 bytes | +160 bytes |

**Daily data volume (typical usage):**

Assumptions:
- 10 parameters × 4 context slices × 2 modes = 80 slices
- ~10 days of gap data per fetch = **800 rows/day typical**

| Storage Option | Per Row | Daily | Monthly |
|----------------|--------:|------:|--------:|
| Full sig (2 ctx) | 158 bytes | 126 KB | 3.8 MB |
| CoreHash only | 64 bytes | 51 KB | 1.5 MB |
| **Difference** | 94 bytes | **75 KB/day** | **2.3 MB/month** |

**Verdict:** Storage cost is negligible at these volumes. Neon free tier (0.5GB) would take years to exhaust from signature overhead alone.

**The choice should be driven by semantic requirements, not storage costs.**

---

#### 3.7.6 Decision: Option C Selected

**Decision:** Store both `core_hash` and `context_def_hashes` as separate columns.

**Rationale:**
- For V1: Use `core_hash` only for matching (flexible, resilient to context evolution)
- Future: Can add stricter matching using `context_def_hashes` when needed
- Audit: Can detect when context definitions changed over time
- Data cost: Negligible (~75 KB/day extra; see §3.7.5)

**Implications:**
1. Schema adds `context_def_hashes TEXT` column (JSON object)
2. Write path stores both values
3. Read path queries by `core_hash` only (V1)
4. Future: optional strict mode can AND on `context_def_hashes`

**Query patterns (V1):**
```sql
-- V1: Flexible matching (ignore context def changes)
WHERE param_id = %s AND core_hash = %s

-- Future strict mode (if needed):
WHERE param_id = %s AND core_hash = %s 
  AND context_def_hashes = %s
```

---

## 4. Data Flow Overview

**Key principle: Python is the sole DB interface.** Frontend never connects to Postgres directly.

### 4.1 Write Path (Shadow-Write)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ FRONTEND                                                                 │
│                                                                          │
│  1. dataOperationsService fetches from Amplitude                         │
│                         ↓                                                │
│  2. Receives response (dates[], n_daily[], k_daily[], A_daily[])         │
│                         ↓                                                │
│  3. Persists to parameter file (mergeTimeSeriesIntoParameter)            │
│                         ↓                                                │
│  4. Calls Python: POST /api/snapshots/append                             │
│     {                                                                    │
│       param_id: "repo-branch-param-a-to-b",                              │
│       core_hash: "abc123def456...",                                      │
│       context_def_hashes: {"channel":"ch-hash"},                         │
│       slice_key: "context(channel:google)",                              │
│       retrieved_at: "2025-11-15T00:00:00Z",                              │
│       rows: [{ anchor_day, A, X, Y,                                      │
│                median_lag_days, mean_lag_days,                           │
│                anchor_median_lag_days, anchor_mean_lag_days }, ...]      │
│     }                                                                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ PYTHON BACKEND                                                           │
│                                                                          │
│  5. Inserts rows into Postgres (ON CONFLICT DO NOTHING)                  │
│                         ↓                                                │
│  6. Returns { success: true }                                            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ FRONTEND                                                                 │
│                                                                          │
│  7. Continues (shadow-write is fire-and-forget; doesn't block main flow) │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Read Path (Analysis)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ FRONTEND                                                                 │
│                                                                          │
│  1. User selects analysis type (histogram / daily conversions)           │
│                         ↓                                                │
│  2. Resolves slices using existing machinery                             │
│     (signature matching, MECE verification, date coverage)               │
│                         ↓                                                │
│  3. Constructs snapshot query specification                              │
│     {                                                                    │
│       param_id: "repo-branch-param-a-to-b",                              │
│       segments: [{ core_hash, slice_keys, cohort_range, is_mece }]       │
│     }                                                                    │
│                         ↓                                                │
│  4. Calls Python: POST /api/runner/analyze                               │
│     {                                                                    │
│       analysis_type: "histogram",                                        │
│       snapshot_query: { ... },                                           │
│       query_dsl: "from(A).to(B).cohort(...)",                            │
│       scenarios: [...]                                                   │
│     }                                                                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ PYTHON BACKEND                                                           │
│                                                                          │
│  5. Queries Postgres for matching snapshot rows                          │
│                         ↓                                                │
│  6. Aggregates if MECE (sum across slices by anchor_day, retrieved_at)   │
│                         ↓                                                │
│  7. Derives histogram or daily conversions from ΔY                       │
│                         ↓                                                │
│  8. Returns AnalysisResult with declarative schema                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ FRONTEND                                                                 │
│                                                                          │
│  9. Renders chart using existing AnalyticsPanel rendering                │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Responsibility Summary

| Operation | Frontend | Python |
|-----------|----------|--------|
| **Fetch from Amplitude** | ✓ | — |
| **Persist to file** | ✓ | — |
| **Write to DB** | Calls endpoint | Inserts to Postgres |
| **Signature computation** | ✓ | — |
| **MECE verification** | ✓ | — |
| **Query DB** | Calls endpoint | Queries Postgres |
| **Histogram derivation** | — | ✓ |
| **Chart rendering** | ✓ | — |

### 4.4 Idempotency

Write operations use `ON CONFLICT DO NOTHING` to handle duplicate writes (same `param_id, core_hash, slice_key, anchor_day, retrieved_at`).

---

## 5. Read Path (Analysis)

### 5.1 Frontend Constructs Snapshot Query

Frontend uses **existing machinery** (signature matching, MECE verification, date coverage) to determine:
- Which `param_id`
- Which `core_hash` (computed signature)
- Which `slice_keys` (resolved slices, possibly MECE partition)
- Which `cohort_range`

For complex cases (heterogeneous date coverage), frontend produces **segments**:

```typescript
interface SnapshotQuerySegment {
    cohort_range: { from: string; to: string };
    core_hash: string;
    slice_keys: string[];
    is_mece: boolean;
}

interface SnapshotQuery {
    param_id: string;
    segments: SnapshotQuerySegment[];
}
```

### 5.2 Extended Analysis Request

```typescript
// graphComputeClient.ts

interface AnalysisRequest {
    scenarios: ScenarioData[];
    query_dsl?: string;
    analysis_type?: string;
    snapshot_query?: SnapshotQuery;  // NEW
}
```

### 5.3 Python Receives and Queries DB

```python
# lib/runner/snapshot_queries.py

def query_snapshots(snapshot_query: dict) -> list[dict]:
    """Query DB for snapshot rows matching the specification."""
    
    all_rows = []
    for segment in snapshot_query['segments']:
        rows = db.execute("""
            SELECT slice_key, anchor_day, retrieved_at,
                   A, X, Y,
                   median_lag_days, mean_lag_days,
                   anchor_median_lag_days, anchor_mean_lag_days
            FROM snapshots
            WHERE param_id = %s
              AND core_hash = %s
              AND slice_key = ANY(%s)
              AND anchor_day BETWEEN %s AND %s
            ORDER BY anchor_day, retrieved_at
        """, [
            snapshot_query['param_id'],
            segment['core_hash'],
            segment['slice_keys'],
            segment['cohort_range']['from'],
            segment['cohort_range']['to'],
        ])
        
        if segment['is_mece'] and len(segment['slice_keys']) > 1:
            rows = aggregate_mece_rows(rows)
        
        all_rows.extend(rows)
    
    return all_rows
```

### 5.4 Python Derives Histogram

```python
# lib/runner/histogram_derivation.py

def derive_histogram(rows: list[dict]) -> AnalysisResult:
    """
    Derive lag histogram from snapshot rows.
    
    For each anchor_day, successive snapshots show Y (conversions) accumulating.
    ΔY between snapshots = conversions at that lag.
    """
    
    # Group by anchor_day
    by_anchor = group_by(rows, key=lambda r: r['anchor_day'])
    
    lag_bins: dict[int, int] = defaultdict(int)
    
    for anchor_day, snapshots in by_anchor.items():
        snapshots_sorted = sorted(snapshots, key=lambda r: r['retrieved_at'])
        prev_Y = 0
        
        for snap in snapshots_sorted:
            lag = (snap['retrieved_at'].date() - anchor_day).days
            delta_Y = snap['Y'] - prev_Y
            
            if delta_Y > 0:
                lag_bins[lag] += delta_Y
            
            prev_Y = snap['Y']
    
    # Format result
    total = sum(lag_bins.values())
    data = [
        {
            'lag_days': lag,
            'conversions': count,
            'pct': count / total if total > 0 else 0,
        }
        for lag, count in sorted(lag_bins.items())
    ]
    
    return AnalysisResult(
        analysis_type='histogram',
        analysis_name='Conversion Lag Distribution',
        semantics=ResultSemantics(
            dimensions=[DimensionSpec(id='lag_days', name='Lag (days)', type='ordinal')],
            metrics=[
                MetricSpec(id='conversions', name='Conversions', type='count'),
                MetricSpec(id='pct', name='%', type='ratio', format='percent'),
            ],
            chart=ChartSpec(recommended='bar'),
        ),
        data=data,
    )
```

### 5.5 Python Derives Daily Conversions

```python
# lib/runner/daily_conversions_derivation.py

def derive_daily_conversions(rows: list[dict]) -> AnalysisResult:
    """
    Derive daily conversion counts (conversions attributed to each calendar date).
    
    For each anchor_day, ΔY between snapshots represents conversions that occurred
    (or were attributed) on the snapshot date.
    """
    
    daily_totals: dict[date, int] = defaultdict(int)
    
    by_anchor = group_by(rows, key=lambda r: r['anchor_day'])
    
    for anchor_day, snapshots in by_anchor.items():
        snapshots_sorted = sorted(snapshots, key=lambda r: r['retrieved_at'])
        prev_Y = 0
        
        for snap in snapshots_sorted:
            delta_Y = snap['Y'] - prev_Y
            if delta_Y > 0:
                daily_totals[snap['retrieved_at'].date()] += delta_Y
            prev_Y = snap['Y']
    
    data = [
        {'date': d.isoformat(), 'conversions': count}
        for d, count in sorted(daily_totals.items())
    ]
    
    return AnalysisResult(
        analysis_type='daily_conversions',
        analysis_name='Daily Conversions',
        semantics=ResultSemantics(
            dimensions=[DimensionSpec(id='date', name='Date', type='time')],
            metrics=[MetricSpec(id='conversions', name='Conversions', type='count')],
            chart=ChartSpec(recommended='bar'),
        ),
        data=data,
    )
```

---

## 6. Frontend Resolution Flow

### 6.1 Single Contexted Slice

User query: `from(A).to(B).cohort(1-Nov-25:14-Nov-25).context(channel:google)`

1. Parse DSL → extract cohort range, context
2. Compute signature → `{coreHash: 'abc123', contextDefHashes: {channel: 'def456'}}`
3. Slice key directly from DSL → `context(channel:google)`
4. Construct snapshot query (param_id is workspace-prefixed):

```typescript
{
    param_id: 'acme/analytics-main-param-a-to-b',  // Workspace-prefixed
    segments: [{
        cohort_range: { from: '2025-11-01', to: '2025-11-14' },
        core_hash: 'abc123',
        slice_keys: ['context(channel:google)'],
        is_mece: false,
    }],
}
```

### 6.2 Uncontexted Query over MECE Partition

User query: `from(A).to(B).cohort(1-Nov-25:14-Nov-25)` (no context)

1. Parse DSL → cohort range, no context
2. Compute signature → `{coreHash: 'abc123', contextDefHashes: {}}`
3. Load parameter file → check signature compatibility for all slices
4. MECE verification → slices `[google, meta, organic]` form complete partition
5. Construct snapshot query:

```typescript
{
    param_id: 'acme/analytics-main-param-a-to-b',  // Workspace-prefixed
    segments: [{
        cohort_range: { from: '2025-11-01', to: '2025-11-14' },
        core_hash: 'abc123',
        slice_keys: [
            'context(channel:google)',
            'context(channel:meta)',
            'context(channel:organic)',
        ],
        is_mece: true,
    }],
}
```

### 6.3 Heterogeneous Date Coverage

User query spans dates with different slice coverage:
- Oct 15-31: Uncontexted data only
- Nov 1-14: Contexted MECE data

1. Frontend analyses date coverage per slice
2. Constructs multiple segments:

```typescript
{
    param_id: 'acme/analytics-main-param-a-to-b',  // Workspace-prefixed
    segments: [
        {
            cohort_range: { from: '2025-10-15', to: '2025-10-31' },
            core_hash: 'abc123',
            slice_keys: [''],  // Uncontexted
            is_mece: false,
        },
        {
            cohort_range: { from: '2025-11-01', to: '2025-11-14' },
            core_hash: 'abc123',
            slice_keys: ['context(channel:google)', 'context(channel:meta)', 'context(channel:organic)'],
            is_mece: true,
        },
    ],
}
```

---

## 7. Gap Handling (Sparse Snapshots)

Daily fetches are expected, but gaps may occur (server failures, weekends, etc.).

### 7.1 Policy

For V1, use **uniform distribution** for gaps:
- If snapshots exist for days 15 and 18 but not 16-17
- ΔY is distributed evenly across lags 16, 17, 18

### 7.2 Metadata

Python returns coverage information:

```python
metadata={
    'snapshot_coverage_pct': 0.92,
    'max_gap_days': 2,
    'gap_policy': 'uniform_distribution',
}
```

Frontend displays warning if coverage is below threshold.

---

## 8. Multi-Edge Paths

For path queries like `from(A).to(C).visited(B)`:

- Amplitude returns full-path data (A, X=B, Y=C) anchored on A-entry
- Y column is path endpoint, not per-edge
- Histogram derived directly from Y maturation
- No convolution or composition needed

The signature captures the full path (from/to/visited events), so data fetched with the path query is distinguishable from per-edge data.

---

## 9. DB Hosting

### 9.1 Selected Provider: Neon

**Neon** selected for serverless Postgres hosting.

| Aspect | Details |
|--------|---------|
| **Provider** | Neon (neon.tech) |
| **Region** | AWS Europe West 2 (London) |
| **Postgres Version** | 17.7 |
| **Connection** | Pooled (`-pooler` endpoint) |
| **Plan** | Free tier (0.5GB storage, sufficient for V1) |

### 9.2 Infrastructure Status

| Component | Status |
|-----------|--------|
| Neon project created | ✅ |
| `psycopg2-binary` in requirements.txt | ✅ |
| `DB_CONNECTION` env var pattern | ✅ |
| Local dev integration (`dev-start.sh`) | ✅ |
| `/api/snapshots/health` endpoint | ✅ |
| Vercel env var (`DB_CONNECTION`) | ✅ |

### 9.3 Why Neon

- Purpose-built for serverless (Vercel partnership)
- Built-in connection pooling (no extra setup)
- Standard Postgres (no lock-in, easy migration)
- Branching available for dev/staging if needed
- Free tier sufficient for initial deployment

---

## 10. Credentials

DB credentials integrate with the **existing credentials pathway** using the `providers` structure.

### 10.1 Current: Dedicated Environment Variable

For V1, all users share the same DB via the `DB_CONNECTION` environment variable:

```bash
# Vercel env var / local .env
DB_CONNECTION=postgresql://user:pass@host-pooler.region.aws.neon.tech/dbname?sslmode=require
```

This is simpler than integrating with the user credential system and sufficient while all users share one DB.

### 10.2 Future: User Credential Integration

If per-user/per-workspace DBs are needed, add `snapshot_db` to the `providers` section:

```yaml
# In credentials JSON (via INIT_CREDENTIALS_JSON flow)
providers:
  amplitude:
    api_key: "..."
    secret_key: "..."
  snapshot_db:                                    # FUTURE
    connection_string: "postgresql://..."
```

Frontend would load via existing credential system, pass to Python in request body.

### 10.3 Python Access

Python uses a hybrid approach: request-provided credentials first, then fallback to environment.

```python
# lib/snapshot_db.py

import os

def get_db_connection_string(request_credentials: dict = None) -> str:
    """
    Get DB connection string with precedence:
    1. Request body - credentials passed from frontend (user credential system)
    2. Environment (DB_CONNECTION) - fallback for local dev / direct access
    """
    
    # 1. Primary: credentials passed from frontend via user credential system
    if request_credentials:
        conn = request_credentials.get('connection_string')
        if conn:
            return conn
    
    # 2. Fallback: dedicated env var
    conn = os.environ.get('DB_CONNECTION')
    if conn:
        return conn
    
    raise ValueError("No snapshot_db credentials available")
```

### 10.4 Deployment Configuration

**Vercel (Production):**
- `DB_CONNECTION` env var set in Vercel dashboard
- Neon pooled connection string

**Local Development:**
- Add `DB_CONNECTION` to `graph-editor/.env.local` (gitignored)
- Template in `graph-editor/env.local.template`
- `dev-start.sh` exports `DB_CONNECTION` to the Python pane
- Test via `/api/snapshots/health` endpoint

### 10.5 Future: User Credential Integration

Current design uses **shared DB credentials** via `DB_CONNECTION` env var.

If per-user DBs are needed later:
1. Add `snapshot_db` to `providers` section of user credentials (INIT_CREDENTIALS_JSON flow)
2. Frontend loads credentials, passes `providers.snapshot_db` to Python in request
3. Python uses request credentials (primary path in hybrid approach)

No architectural changes needed — the hybrid approach already supports this.

---

## 11. Service Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         FRONTEND                                 │
│                                                                  │
│  dataOperationsService                                           │
│         │                                                        │
│         ▼                                                        │
│  snapshotWriteService ──────────► POST /api/snapshots/append     │
│  (new TypeScript service)                                        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                                            │
                                            ▼
┌───────────────────────────────────────────────────────────────────┐
│                    SERVERLESS / API LAYER                         │
│                                                                   │
│  /api/snapshots/append  (write endpoint)                          │
│         │                                                         │
│         ▼                                                         │
│      Postgres DB                                                  │
│         ▲                                                         │
│         │                                                         │
│  /api/runner/analyze  (existing Python, extended)                 │
│  (reads DB directly for histogram/daily analysis)                 │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### 11.1 Frontend Write Service

**New service**: `services/snapshotWriteService.ts`

- Called from `dataOperationsService` after successful Amplitude fetch
- Posts snapshot rows to serverless endpoint
- Fails silently (shadow-write should not block main fetch flow)

### 11.2 Write Endpoint

**New endpoint**: `/api/snapshots/append`

- Receives snapshot rows from frontend
- Inserts to Postgres with idempotency (`ON CONFLICT DO NOTHING`)
- Could be Vercel serverless function or FastAPI endpoint

### 11.3 Python Read Service

**Extended**: `lib/runner/snapshot_queries.py`

- Connection pooling for serverless environment
- `SNAPSHOT_DB_URL` environment variable
- Query functions as specified in Section 5

---

## 12. API Routes (Canonical)

All routes are implemented in **Python backend**. Frontend never connects to Postgres directly.

### 12.0 Design Decisions (Resolved)

**Blocker A — No duplicate analysis endpoints:**
- ✅ Extend existing `/api/runner/analyze` with `snapshot_query` parameter
- ❌ Do NOT create separate `/api/snapshots/analyze`
- Rationale: Single analysis pathway; avoids duplicate code paths

**Blocker B — Batch inventory only:**
- ✅ `POST /api/snapshots/inventory` with `{param_ids: [...]}` 
- ❌ No per-param GET endpoint
- Rationale: Primary use case (edge tooltips) requires batching; single-param is batch of one

### 12.1 V1 Core Routes

| Route | Method | Purpose | SQL Operation |
|-------|--------|---------|---------------|
| `/api/snapshots/append` | POST | Write snapshots after fetch | INSERT |
| `/api/snapshots/inventory` | POST | What data exists for params? (batch) | SELECT (aggregate) |
| `/api/runner/analyze` | POST | Run histogram/daily analysis | SELECT + derive |

#### `/api/snapshots/append`

**Input:**
```json
{
  "param_id": "repo-branch-param-a-to-b",
  "core_hash": "abc123def456...",
  "context_def_hashes": {"channel": "ch-hash-def"},
  "slice_key": "context(channel:google)",
  "retrieved_at": "2025-11-15T00:00:00Z",
  "rows": [
    {
      "anchor_day": "2025-11-01",
      "A": 1200, "X": 1000, "Y": 50,
      "median_lag_days": 6.02, "mean_lag_days": 6.96,
      "anchor_median_lag_days": 11.4, "anchor_mean_lag_days": 12.3
    },
    {
      "anchor_day": "2025-11-02",
      "A": 1150, "X": 980, "Y": 48,
      "median_lag_days": 6.0, "mean_lag_days": 7.0,
      "anchor_median_lag_days": 11.2, "anchor_mean_lag_days": 12.1
    }
  ]
}
```

**Output:**
```json
{ "success": true, "rows_written": 14 }
```

**SQL:**
```sql
INSERT INTO snapshots (
  param_id, core_hash, context_def_hashes, slice_key, anchor_day, retrieved_at,
  A, X, Y,
  median_lag_days, mean_lag_days, anchor_median_lag_days, anchor_mean_lag_days
)
VALUES (...)
ON CONFLICT DO NOTHING
```

#### `/api/snapshots/inventory` (Batch POST)

**Input:**
```json
{
  "param_ids": [
    "repo-branch-param-a-to-b",
    "repo-branch-param-c-to-d"
  ]
}
```

**Output:**
```json
{
  "inventory": [
    {
      "param_id": "repo-branch-param-a-to-b",
      "earliest_anchor": "2025-10-15",
      "latest_anchor": "2025-11-14",
      "total_days": 28,
      "expected_days": 31,
      "row_count": 392
    },
    {
      "param_id": "repo-branch-param-c-to-d",
      "earliest_anchor": "2025-10-01",
      "latest_anchor": "2025-10-31",
      "total_days": 31,
      "expected_days": 31,
      "row_count": 310
    }
  ]
}
```

**Note:** `total_days < expected_days` indicates gaps in snapshot coverage.

**SQL:**
```sql
SELECT 
  param_id,
  MIN(anchor_day) AS earliest_anchor,
  MAX(anchor_day) AS latest_anchor,
  COUNT(DISTINCT anchor_day) AS total_days,
  (MAX(anchor_day) - MIN(anchor_day) + 1) AS expected_days,
  COUNT(*) AS row_count
FROM snapshots
WHERE param_id = ANY(%s)
GROUP BY param_id
```

#### `/api/runner/analyze` (extended)

Existing endpoint, extended to accept `snapshot_query`. See Section 5 for query and derivation details.

### 12.2 V1 Lifecycle Routes

| Route | Method | Purpose | SQL Operation |
|-------|--------|---------|---------------|
| `/api/snapshots/rename` | POST | Param was renamed in graph | UPDATE |
| `/api/snapshots/purge` | POST | Delete param's snapshots | DELETE |

#### `/api/snapshots/rename`

**Input:**
```json
{
  "old_param_id": "repo-branch-old-param-name",
  "new_param_id": "repo-branch-new-param-name"
}
```

**Output:**
```json
{ "success": true, "rows_updated": 392 }
```

**SQL:**
```sql
UPDATE snapshots
SET param_id = %(new_param_id)s
WHERE param_id = %(old_param_id)s
```

**When to call:** When `fileOperationsService.renameFile()` renames a parameter file.

#### `/api/snapshots/purge`

**Input:**
```json
{
  "param_id": "repo-branch-param-a-to-b"
}
```

**Output:**
```json
{ "success": true, "rows_deleted": 392 }
```

**SQL:**
```sql
DELETE FROM snapshots WHERE param_id = %(param_id)s
```

**When to call:** When `fileOperationsService.deleteFile()` deletes a parameter file.

### 12.3 V1 Operational Routes

| Route | Method | Purpose | SQL Operation |
|-------|--------|---------|---------------|
| `/api/snapshots/health` | GET | Is DB reachable? | SELECT 1 |

#### `/api/snapshots/health`

**Input:** None

**Output:**
```json
{ "status": "ok", "latency_ms": 12 }
```

**SQL:**
```sql
SELECT 1
```

### 12.4 Future Routes (Not V1)

| Route | Purpose | Notes |
|-------|---------|-------|
| `/api/snapshots/purge-workspace` | Delete all data for a workspace | Input: `{workspace_prefix}` |
| `/api/snapshots/purge-aged` | Delete data older than N days | Data retention; could be cron instead |
| `/api/snapshots/stats` | Total rows, size, oldest/newest | Monitoring dashboard |
| `/api/snapshots/raw` | Read raw rows for debugging | Low priority; inventory usually sufficient |

### 12.5 Lifecycle Integration Points

| Graph Event | Frontend Action | Route Called |
|-------------|-----------------|--------------|
| Data fetched from Amplitude | After `mergeTimeSeriesIntoParameter` | `POST /api/snapshots/append` |
| User requests histogram | AnalyticsPanel submits analysis | `POST /api/runner/analyze` (with `snapshot_query`) |
| Graph loads / edge tooltips | Batch check for visible edges | `POST /api/snapshots/inventory` (batch) |
| Parameter renamed | After file rename completes | `POST /api/snapshots/rename` |
| Parameter deleted | After file delete completes | `POST /api/snapshots/purge` |

### 12.6 What Routes Are NOT Needed

| Scenario | Why No Route |
|----------|--------------|
| **Update counts** | Append-only; just write correct data, old remains |
| **Undo a write** | Append-only; bad data ages out or use purge |
| **Signature changed** | Old data orphaned under old `core_hash`; new fetches use new hash |
| **Bulk import** | No retroactive backfill possible (files don't preserve history) |

### 12.7 Route Ownership Pattern (Blocker C Resolved)

**Handler logic lives in `lib/`, routing in server files.**

| Component | Location | Responsibility |
|-----------|----------|----------------|
| **Handler functions** | `lib/snapshot_handlers.py` (new) | Pure logic: receive data, return response |
| **Local dev routing** | `dev-server.py` | FastAPI decorators; imports and calls handlers |
| **Production routing** | `api/python-api.py` | Vercel serverless; imports and calls handlers |

**Handler functions to create:**

```python
# lib/snapshot_handlers.py

def handle_snapshots_health(data: dict) -> dict:
    """Test DB connectivity."""
    ...

def handle_snapshots_append(data: dict) -> dict:
    """Insert snapshot rows."""
    ...

def handle_snapshots_inventory(data: dict) -> dict:
    """Query inventory for batch of param_ids."""
    ...

def handle_snapshots_rename(data: dict) -> dict:
    """Rename param_id in all rows."""
    ...

def handle_snapshots_purge(data: dict) -> dict:
    """Delete all rows for param_id."""
    ...
```

**Integration with `api/python-api.py`:**

Add endpoint routing (similar to existing pattern):

```python
elif endpoint == 'snapshots-health':
    path = '/api/snapshots/health'
elif endpoint == 'snapshots-append':
    path = '/api/snapshots/append'
elif endpoint == 'snapshots-inventory':
    path = '/api/snapshots/inventory'
# ... etc
```

**Note:** The existing `/api/snapshots/health` in `dev-server.py` (lines 50-77) must be refactored to use this pattern. Currently it is inline-only and won't work in production.

---

## 13. Prerequisite: Latency Data Preservation Fix

Latency data is **lost during query combination** in dual-query and composite scenarios. This is a pre-existing defect.

| Path | Latency preserved? |
|------|-------------------|
| Simple query | ✅ Works |
| Dual-query (n_query) | ❌ Lost in combination |
| Composite query | ❌ Lost in combination |

**Fix required:** Preserve latency fields from k_query through combination.

- [ ] Fix dual-query combination in `dataOperationsService.ts` (~line 6323)
- [ ] Fix composite combination in `compositeQueryExecutor.ts` (~line 320)

---

## 14. Write Point Specification

Write to snapshot DB at same point as file write: after `mergeTimeSeriesIntoParameter()` in `getFromSourceDirect()`.

| DB Column | Source |
|-----------|--------|
| `param_id` | `${workspace.repository}-${workspace.branch}-${paramId}` |
| `core_hash` | `querySignature` |
| `slice_key` | `sliceDSL` |
| `retrieved_at` | `new Date().toISOString()` |
| `anchor_day` | `gapTimeSeries[i].date` |
| `A` | `gapTimeSeries[i].anchor_n` |
| `X` | `gapTimeSeries[i].n` |
| `Y` | `gapTimeSeries[i].k` |
| `median_lag_days` | `gapTimeSeries[i].median_lag_days` |
| `mean_lag_days` | `gapTimeSeries[i].mean_lag_days` |
| `anchor_*_lag_days` | `gapTimeSeries[i].anchor_*_lag_days` |

Only write when `writeToFile === true`.

---

## 15. Implementation Phases

**Canonical reference:** See `implementation-plan.md` for detailed breakdowns, code paths, and completion checklists.

### Phase 0: Prerequisites (1-2 days)
- [ ] Fix latency preservation in dual-query/composite paths (§13)

### Phase 1: Foundation — Write Path (3-4 days)
- [ ] Select and configure DB hosting provider (Neon)
- [ ] Add `DB_CONNECTION` credentials to env/credentials pathway
- [ ] Create `snapshots` table with final schema (§2)
- [ ] Implement `snapshotWriteService.ts` (frontend)
- [ ] Implement `lib/snapshot_handlers.py` with `handle_snapshots_append()`
- [ ] Implement `lib/snapshot_service.py` with DB operations
- [ ] Wire up routes in `dev-server.py` and `api/python-api.py`
- [ ] `/api/snapshots/health` endpoint working

### Phase 2: Read Path — Analytics (2-3 days)
- [ ] Histogram derivation (ΔY by lag) in Python
- [ ] Daily conversions derivation in Python
- [ ] MECE aggregation in Python (sum across slices)
- [ ] Segment support for heterogeneous date coverage
- [ ] Gap handling with coverage metadata
- [ ] `POST /api/snapshots/inventory` endpoint (batch)
- [ ] `/api/snapshots/rename` endpoint (integrate with file rename)
- [ ] `/api/snapshots/purge` endpoint (integrate with file delete)
- [ ] Extend `/api/runner/analyze` with `snapshot_query` (not separate endpoint)

### Phase 3: UI Integration (2-3 days)
- [ ] Analysis type selector integration
- [ ] Coverage warnings in UI for sparse data
- [ ] `snapshotInventoryCache.ts` with batch fetching
- [ ] Edge tooltips show snapshot availability ("N days of history available")
- [ ] Gap-aware tooltip display

### Phase 4: Historical Queries — asAt (2-3 days)
- [ ] See `asat.md` for detailed design and implementation plan
- [ ] DSL parsing for `asAt(date)`
- [ ] DB fork in `dataOperationsService.ts`
- [ ] Signature validation against DB
- [ ] UI for asAt mode in `WindowSelector.tsx`
- [ ] Scenario badge and regeneration disable for asAt

### Phase 5: Advanced Time-Series Charting (Deferred)
- [ ] See `time-series-charting.md` for scope
- [ ] Fan charts, funnel time series, latency drift analysis

---

## 16. Explicit Scope Exclusions

### 16.1 DB is NOT a Fetch Cache

The DB serves **analytics only** — it is not a secondary cache for fetch operations.

**What this means:**
- Frontend fetch logic continues to check **parameter files** for cache status
- The DB is never queried to determine "do I need to fetch from Amplitude?"
- The DB is never used to populate parameter files or satisfy fetch requests
- If parameter files are empty (e.g., fresh clone), Amplitude is queried — not the DB

**Why this exclusion:**
- Keeps fetch logic unchanged and well-tested
- Avoids complexity of "latest wins" derivation from DB snapshots
- Preserves clear separation: files = cache, DB = analytics
- The commercial requirements (histogram, daily conversions) don't need this

**Future consideration:** If reducing Amplitude API pressure becomes important, DB-as-secondary-cache could be added later. This would require a "latest wins" query pattern and changes to fetch decision logic. Out of scope for this design.

---

## 17. Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Signature computation | Frontend only | Avoid replicating complex logic in Python |
| MECE verification | Frontend only | Existing machinery; Python just sums |
| DB query construction | Frontend provides coordinates | Python is execution layer, not logic layer |
| Write path | Shadow-write (file + DB) | Preserves offline-first; DB is analytics layer |
| Gap handling | Uniform distribution | Produces clean visualisation; metadata for transparency |
| DB as fetch cache | Excluded | DB is for analytics; files remain sole fetch cache |
| Store latency columns | Yes (4 REAL columns) | Enables trend analysis; cheap; allows drift validation |
| Latency units | Days (REAL) | Matches DagNet conventions; Amplitude ms converted at write |
| Window mode snapshots | Supported | Same derivation logic as cohort; anchor_day = X-entry date |
| `asAt` does not change signature | `core_hash` unchanged | asAt is retrieval filter, not query identity |
| `asAt` queries are read-only | No file/DB writes | Historical views don't mutate state |
| Result shape identical for asAt | Same TimeSeriesPoint | Frontend doesn't need to know data source |

---

## 18. Window Mode Clarification

Window mode snapshots work identically to cohort mode for derivation purposes:

| Aspect | Cohort Mode | Window Mode |
|--------|-------------|-------------|
| `anchor_day` meaning | A-entry (cohort start) | X-entry (from-step date) |
| `A` column | Anchor entrants | NULL (no anchor concept) |
| `X` column | From-step count | From-step count |
| `Y` column | Conversions | Conversions |
| Histogram derivation | ΔY between snapshots | ΔY between snapshots |
| Daily conversions | ΔY attributed to `retrieved_at` | ΔY attributed to `retrieved_at` |

**Window mode is NOT problematic.** The derivation algorithm is identical:
- For each `anchor_day`, successive `retrieved_at` snapshots show Y accumulating
- ΔY between snapshots = conversions in that time interval
- `lag = retrieved_at - anchor_day` works for both modes

The only difference is that window mode typically has less informative lag histograms (since X-entry date is less semantically meaningful than cohort entry).

---

## 19. Historical Query Mode (`asAt`)

### 19.1 Concept

A future DSL extension allows querying "what did we know at time T?" rather than "what is the current state?".

**Example DSL:**
```
from(A).to(B).window(1-Oct-25:31-Oct-25).asAt(15-Oct-25)
```

**Semantics:** Return the time-series data for the specified window/cohort **as it was known on 15-Oct-25** — i.e., retrieve from the snapshot DB with `retrieved_at <= 15-Oct-25`, not from Amplitude.

### 19.2 Use Cases

| Use Case | DSL Example | Why Valuable |
|----------|-------------|--------------|
| **Audit trail** | `.asAt(1-Nov-25)` | "What did the dashboard show on 1-Nov?" |
| **Debugging** | `.asAt(report_date)` | "Why did the report show X on that day?" |
| **Trend analysis** | Compare `.asAt(T1)` vs `.asAt(T2)` | "How did our view of the same cohort evolve?" |
| **Immature cohort replay** | `.asAt(cohort_date + 7d)` | "What did we know about this cohort after 1 week?" |

### 19.3 Data Flow with `asAt`

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ WITHOUT asAt (current behaviour)                                             │
│                                                                              │
│   DSL: from(A).to(B).window(1-Oct:31-Oct)                                   │
│   → Fetch from Amplitude (live data)                                        │
│   → Write to file + shadow-write to DB                                      │
│   → Return current state                                                    │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ WITH asAt (new behaviour)                                                    │
│                                                                              │
│   DSL: from(A).to(B).window(1-Oct:31-Oct).asAt(15-Oct-25)                   │
│   → Parse DSL, extract asAt date                                            │
│   → Compute signature (same as live query)                                  │
│   → Query DB: WHERE retrieved_at <= '2025-10-15' ORDER BY retrieved_at DESC │
│   → Return most recent snapshot per anchor_day as of that date              │
│   → NO write to file, NO shadow-write to DB (read-only)                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 19.4 Signature-Based Validation

**Critical:** `asAt` queries MUST compute the signature and match against DB.

#### 19.4.1 Why Signature Matching is Required

The signature captures the *semantic identity* of a query. We must verify it matches because:

1. **Query definitions evolve** — event definitions, filters, or path may have changed since snapshots were stored
2. **Semantic consistency** — we should only return data that answers the *same* question
3. **Safety** — returning data for a different query configuration would be silently wrong

#### 19.4.2 `asAt` Query Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ CORRECT: Signature-validated historical query                               │
│                                                                              │
│   1. Parse DSL: from(A).to(B).window(1-Oct:31-Oct).asAt(15-Oct)             │
│   2. Compute core_hash using CURRENT query definition (same as live query)  │
│   3. Query DB: WHERE core_hash = %s AND retrieved_at <= '2025-10-15'        │
│   4. If rows found → return time-series                                     │
│   5. If no rows → "No historical data matching current query configuration" │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**The signature computation is IDENTICAL to live queries.** The only difference is:
- Live: fetch from Amplitude, write to file + DB
- asAt: query DB with computed signature, read-only

#### 19.4.3 Signature Unchanged

- `from(A).to(B).window(1-Oct:31-Oct)` → `core_hash = abc123`
- `from(A).to(B).window(1-Oct:31-Oct).asAt(15-Oct)` → `core_hash = abc123` (same)

The `asAt` date is a **retrieval filter**, not a query identity component.

#### 19.4.4 Mismatch Handling

If the computed `core_hash` doesn't match any stored data:

| Scenario | Likely Cause | User Message |
|----------|--------------|--------------|
| No rows at all | Query never fetched, or param_id wrong | "No snapshot history for this parameter" |
| Rows exist but different hash | Query definition changed since snapshots | "Historical data exists but query configuration has changed. Snapshots were stored with a different query definition." |

The second case is particularly important — it prevents silently returning data for a different query.

#### 19.4.5 Implementation in Frontend

```typescript
// In dataOperationsService for asAt queries:

async function getFromSnapshotDB(
  edge: Edge,
  parsed: ParsedQuery,
  workspace: Workspace
): Promise<TimeSeriesResult> {
  
  // 1. Compute signature EXACTLY as for live queries
  const signature = await computeQuerySignature(edge, parsed, workspace);
  
  // 2. Build DB query with signature
  const snapshotQuery = {
    param_id: `${workspace.repository}-${workspace.branch}-${edge.p.id}`,
    core_hash: signature.coreHash,  // <-- MUST match
    slice_key: parsed.context || '',
    anchor_range: { from: parsed.window.start, to: parsed.window.end },
    as_at: parsed.asAt,
  };
  
  // 3. Call Python endpoint
  const response = await fetch('/api/snapshots/query', {
    method: 'POST',
    body: JSON.stringify(snapshotQuery),
  });
  
  // 4. Handle mismatch
  if (response.data.length === 0) {
    // Check if ANY data exists for this param
    const inventory = await getInventory(snapshotQuery.param_id);
    if (inventory.rowCount > 0) {
      throw new Error('Historical data exists but query configuration has changed');
    } else {
      throw new Error('No snapshot history for this parameter');
    }
  }
  
  return response.data;
}
```

This ensures we only return historical data when it's semantically appropriate.

### 19.5 DB Query for `asAt`

```sql
-- Get most recent snapshot per anchor_day as of the asAt date
WITH ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY param_id, core_hash, slice_key, anchor_day
      ORDER BY retrieved_at DESC
    ) AS rn
  FROM snapshots
  WHERE param_id = %s
    AND core_hash = %s
    AND slice_key = ANY(%s)
    AND anchor_day BETWEEN %s AND %s
    AND retrieved_at <= %s  -- asAt filter
)
SELECT * FROM ranked WHERE rn = 1
```

This returns **one row per anchor_day** — the most recent snapshot as of the `asAt` date.

### 19.6 Result Shape

The result should match the existing time-series structure exactly:

```typescript
interface TimeSeriesPoint {
  date: string;           // anchor_day
  n: number;              // X count
  k: number;              // Y count
  p: number;              // k/n
  median_lag_days?: number;
  mean_lag_days?: number;
  anchor_n?: number;      // A count (cohort mode)
  anchor_median_lag_days?: number;
  anchor_mean_lag_days?: number;
}
```

**Frontend should NOT need to know** whether data came from Amplitude or DB. The shape is identical.

### 19.7 Frontend Integration

**Option A: Transparent substitution**

DSL parsing detects `asAt`, routes to DB instead of DAS, returns identical shape.

```typescript
// In dataOperationsService.getFromSource():
const parsed = parseDSL(dsl);

if (parsed.asAt) {
  // Historical query - retrieve from DB via Python
  return await getFromSnapshotDB(edge, parsed, workspace);
} else {
  // Live query - fetch from Amplitude
  return await getFromAmplitude(edge, parsed, workspace);
}
```

**Option B: Explicit mode switch**

UI offers "View as at..." option that rewrites DSL with `asAt` modifier.

### 19.8 Caching Interaction

| Query Type | File Cache | Memory Cache | DB |
|------------|------------|--------------|-----|
| Live (no asAt) | Write | Write | Shadow-write |
| Historical (asAt) | Read-only | Read-only | Read-only |

Historical queries are **read-only** — they don't update file or memory caches.

### 19.9 UI Indication

When viewing historical data, UI should clearly indicate:

- "Viewing data as at 15-Oct-25"
- Visual distinction (e.g., sepia tint, timestamp badge)
- Option to "Return to live data"

### 19.10 Implementation Phases

| Phase | Scope |
|-------|-------|
| **V1** (current) | Write path + analytics read path (no asAt) |
| **V2** | Add `asAt` DSL parsing + DB read path |
| **V3** | UI for historical mode selection |

### 19.11 Schema Implications

**No schema changes required.** The existing schema supports `asAt` queries:

- `retrieved_at` is already stored per row
- Query filters by `retrieved_at <= asAt_date`
- `ROW_NUMBER()` window function selects latest-as-of

### 19.12 Data Availability Validation

**Prerequisite:** Signature validation (§19.4) must pass first. Only then do we check data availability.

**Critical question:** Given a matching `core_hash`, can the DB yield the data in the required form?

#### 19.12.1 Column Mapping

| TimeSeriesPoint field | DB column | Available? |
|-----------------------|-----------|------------|
| `date` | `anchor_day` | ✅ |
| `n` | `X` | ✅ |
| `k` | `Y` | ✅ |
| `p` | Derived: `Y/X` | ✅ (compute at read) |
| `anchor_n` | `A` | ✅ |
| `median_lag_days` | `median_lag_days` | ✅ |
| `mean_lag_days` | `mean_lag_days` | ✅ |
| `anchor_median_lag_days` | `anchor_median_lag_days` | ✅ |
| `anchor_mean_lag_days` | `anchor_mean_lag_days` | ✅ |

**Verdict:** All required fields are stored. Schema is sufficient.

#### 19.12.2 Coverage Scenarios

| Scenario | Query | What Happens |
|----------|-------|--------------|
| **Full coverage** | `window(1-Oct:31-Oct).asAt(15-Nov)` with daily snapshots | One row per anchor_day returned |
| **Partial coverage** | `window(1-Oct:31-Oct).asAt(15-Oct)` but snapshots started 10-Oct | Rows only for anchor_days with snapshots ≤ 15-Oct |
| **No coverage** | `asAt(9-Oct)` but snapshots started 10-Oct | Empty result |
| **Sparse snapshots** | `asAt(15-Oct)` with snapshots on 10th, 12th, 15th | For each anchor_day, returns most recent snapshot ≤ 15-Oct |

**Partial coverage is semantically correct** — it reflects what we would have known at that time. But we must handle it gracefully.

#### 19.12.3 Edge Cases

| Edge Case | Handling |
|-----------|----------|
| Signature mismatch (§19.4) | Error: "Query configuration has changed since snapshots stored" |
| No snapshots for param at all | Error: "No snapshot history available" |
| asAt date before first snapshot | Error: "No data as of {date}" |
| asAt date in future | Behave as live query (use latest available) |
| Anchor_day range extends beyond available data | Return partial result with coverage metadata |

**Order of checks:**
1. Compute signature → match against DB
2. If no match → appropriate error (see §19.4.4)
3. If match → check coverage and return data

#### 19.12.4 Coverage Metadata

The response should include coverage information:

```typescript
interface AsAtResult {
  timeSeries: TimeSeriesPoint[];
  coverage: {
    requestedRange: { from: string; to: string };
    actualRange: { from: string | null; to: string | null };
    daysRequested: number;
    daysReturned: number;
    oldestSnapshot: string;  // earliest retrieved_at in result
    newestSnapshot: string;  // latest retrieved_at in result (should be ≤ asAt)
  };
  warnings?: string[];  // e.g., "Partial coverage: 25/31 days"
}
```

---

### 19.13 UI Extension: AsAt Selector

#### 19.13.1 Design Principle

`asAt` is conceptually **separate** from the query window:
- **Query window** = what dates are we analysing
- **View date** = when are we viewing from

These should be independent controls.

#### 19.13.2 UI Location Options

| Option | Location | Pros | Cons |
|--------|----------|------|------|
| A | WindowComponent extension | Co-located with dates | Clutters main UI |
| B | Separate toggle/picker | Clear separation | Discoverability |
| C | Analytics panel only | Non-invasive | Limited scope |

**Recommendation: Option B** — separate control near WindowComponent but visually distinct.

#### 19.13.3 Component Design

```
┌────────────────────────────────────────────────────────────────────┐
│ WindowSelector (existing)                                          │
│ ┌─────────────────────────────────────────────────────────────┐   │
│ │  window(1-Oct-25:31-Oct-25)              [📅] [📅]          │   │
│ └─────────────────────────────────────────────────────────────┘   │
│                                                                    │
│ ┌─────────────────────────────────────────────────────────────┐   │
│ │  ☐ View historical data as at: [         ] [📅]             │   │
│ └─────────────────────────────────────────────────────────────┘   │
│      ↑ checkbox enables/disables         ↑ date picker            │
│                                                                    │
│ When enabled, shows indicator:                                     │
│ ┌─────────────────────────────────────────────────────────────┐   │
│ │  ⏱️ HISTORICAL VIEW: as at 15-Oct-25                [✕ Live] │   │
│ └─────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

#### 19.13.4 Component: `AsAtSelector`

```typescript
// graph-editor/src/components/AsAtSelector.tsx

interface AsAtSelectorProps {
  enabled: boolean;
  asAtDate: string | null;
  onEnabledChange: (enabled: boolean) => void;
  onDateChange: (date: string | null) => void;
  availableRange?: { earliest: string; latest: string };  // from inventory
}

export function AsAtSelector({
  enabled,
  asAtDate,
  onEnabledChange,
  onDateChange,
  availableRange,
}: AsAtSelectorProps) {
  return (
    <div className="as-at-selector">
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
        />
        View historical data as at:
      </label>
      
      <DatePicker
        value={asAtDate}
        onChange={onDateChange}
        disabled={!enabled}
        minDate={availableRange?.earliest}
        maxDate={availableRange?.latest}
      />
      
      {enabled && asAtDate && (
        <div className="as-at-indicator">
          ⏱️ HISTORICAL VIEW: as at {formatDate(asAtDate)}
          <button onClick={() => onEnabledChange(false)}>✕ Return to live</button>
        </div>
      )}
    </div>
  );
}
```

#### 19.13.5 State Management

The `asAt` state should be:
- **Per-tab** (not global) — different tabs can view different points in time
- **Persisted to TabContext** — survives tab switches
- **NOT persisted to file** — it's a view setting, not graph data

```typescript
// In TabContext / EditorState:
interface EditorState {
  // ... existing fields ...
  asAtEnabled?: boolean;
  asAtDate?: string | null;
}
```

#### 19.13.6 DSL Integration

When `asAtEnabled && asAtDate`:

```typescript
// In WindowSelector or wherever DSL is constructed:
const baseDSL = `from(${from}).to(${to}).${mode}(${start}:${end})`;

const finalDSL = asAtEnabled && asAtDate
  ? `${baseDSL}.asAt(${asAtDate})`
  : baseDSL;
```

#### 19.13.7 Visual Differentiation

When viewing historical data, the UI should clearly indicate:

| Element | Normal | Historical |
|---------|--------|------------|
| Background | Normal | Subtle sepia/amber tint |
| Badge | None | "⏱️ Historical: 15-Oct-25" |
| Data freshness indicator | "Updated: 10 mins ago" | "Viewing as at: 15-Oct-25" |
| Fetch button | "Refresh" | Hidden (can't fetch historical) |

---

### 19.14 Precise Fork Point in Fetch Code Path

**This section traces the ACTUAL code to identify exactly where `asAt` queries would diverge.**

#### 19.14.1 Current Fetch Flow (Amplitude)

```
fetchItem() / fetchItems()
    └── fetchSingleItemInternal()
            └── dataOperationsService.getFromSource()
                    └── dataOperationsService.getFromSourceDirect()
                            │
                            ├── [~line 4909-4947] Compute querySignature (core_hash)
                            │
                            ├── [~line 5914-5926] executeDAS() → runner.execute()
                            │                      ↑ THIS IS THE FORK POINT
                            │
                            └── [~line 7031+] mergeTimeSeriesIntoParameter()
```

**File:** `graph-editor/src/services/dataOperationsService.ts`

#### 19.14.2 Data Available at Fork Point

By line ~5900, the following are in scope:

| Variable | DB Column | Example Value |
|----------|-----------|---------------|
| `objectId` | `param_id` (base) | `"param-a-to-b"` |
| `querySignature` | `core_hash` | `"abc123def456..."` |
| `sliceDSL` | `slice_key` | `"context(channel:google)"` or `""` |
| `fetchWindow` | `anchor_day` range | `{ start: "2025-10-01", end: "2025-10-31" }` |
| `isCohortQuery` | (mode inference) | `true` or `false` |
| workspace (from file) | `param_id` prefix | `{ repository: "acme/analytics", branch: "main" }` |

**All data needed for DB query is available before DAS execution.**

#### 19.14.3 Fork Implementation

```typescript
// In getFromSourceDirect(), BEFORE the DAS execution block (~line 5910):

// NEW: Check for asAt mode
const asAtDate = parsedDSL?.asAt;  // Extracted earlier during DSL parsing

if (asAtDate) {
  // ═══════════════════════════════════════════════════════════════
  // HISTORICAL QUERY: Retrieve from snapshot DB instead of Amplitude
  // ═══════════════════════════════════════════════════════════════
  
  const dbParamId = `${workspace.repository}-${workspace.branch}-${objectId}`;
  
  const snapshotResult = await fetchFromSnapshotDB({
    param_id: dbParamId,
    core_hash: querySignature,
    slice_key: sliceDSL || '',
    anchor_range: { from: fetchWindow.start, to: fetchWindow.end },
    as_at: asAtDate,
  });
  
  if (!snapshotResult.success) {
    // Handle no data / signature mismatch per §19.4.4
    throw new Error(snapshotResult.errorMessage);
  }
  
  // snapshotResult.timeSeries has IDENTICAL shape to DAS response
  // → Continue to mergeTimeSeriesIntoParameter as normal
  allTimeSeriesData.push(...snapshotResult.timeSeries);
  
  // Skip the live DAS execution
  shouldSkipFetch = true;
}

// ... existing DAS execution code (only runs if !shouldSkipFetch) ...
```

#### 19.14.4 Result Shape Compatibility

**DAS returns:**
```typescript
interface TimeSeriesPointWithLatency {
  date: string;           // anchor_day
  n: number;              // X count
  k: number;              // Y count
  p: number;              // k/n (computed)
  median_lag_days?: number;
  mean_lag_days?: number;
  anchor_n?: number;      // A count (cohort mode)
  anchor_median_lag_days?: number;
  anchor_mean_lag_days?: number;
}
```

**DB query returns:**
```sql
SELECT 
  anchor_day AS date,
  X AS n,
  Y AS k,
  CASE WHEN X > 0 THEN Y::float / X ELSE 0 END AS p,
  A AS anchor_n,
  median_lag_days,
  mean_lag_days,
  anchor_median_lag_days,
  anchor_mean_lag_days
FROM snapshots
WHERE param_id = %s AND core_hash = %s ...
```

**Shapes are IDENTICAL.** The downstream code (`mergeTimeSeriesIntoParameter`, graph update, etc.) doesn't need to know the data source.

#### 19.14.5 What Changes for asAt

| Aspect | Live (Amplitude) | Historical (asAt) |
|--------|------------------|-------------------|
| Data source | `runner.execute()` → HTTP | Python → Postgres |
| Signature computation | Yes | Yes (same) |
| `mergeTimeSeriesIntoParameter` | Yes | Yes (same) |
| Write to file | Yes | **NO** (read-only) |
| Write to DB | Yes (shadow-write) | **NO** (read-only) |
| Update graph | Yes | Yes (same) |

The ONLY differences are:
1. Data source (DB vs Amplitude)
2. No writes (file or DB)

#### 19.14.6 Python Endpoint for asAt

```python
# graph-editor/lib/api_handlers.py

@app.post("/api/snapshots/query")
async def query_snapshots(request: SnapshotQueryRequest) -> SnapshotQueryResponse:
    """
    Query snapshot DB for historical data.
    
    Returns time-series in same shape as DAS response.
    """
    conn = get_db_connection()
    
    rows = conn.execute("""
        WITH ranked AS (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY anchor_day
              ORDER BY retrieved_at DESC
            ) AS rn
          FROM snapshots
          WHERE param_id = %(param_id)s
            AND core_hash = %(core_hash)s
            AND slice_key = %(slice_key)s
            AND anchor_day BETWEEN %(from)s AND %(to)s
            AND retrieved_at <= %(as_at)s
        )
        SELECT 
          anchor_day AS date,
          X AS n,
          Y AS k,
          A AS anchor_n,
          median_lag_days,
          mean_lag_days,
          anchor_median_lag_days,
          anchor_mean_lag_days
        FROM ranked 
        WHERE rn = 1
        ORDER BY anchor_day
    """, {
        'param_id': request.param_id,
        'core_hash': request.core_hash,
        'slice_key': request.slice_key,
        'from': request.anchor_range['from'],
        'to': request.anchor_range['to'],
        'as_at': request.as_at,
    })
    
    time_series = [
        {
            'date': row['date'].isoformat(),
            'n': row['n'],
            'k': row['k'],
            'p': row['k'] / row['n'] if row['n'] > 0 else 0,
            'anchor_n': row['anchor_n'],
            'median_lag_days': row['median_lag_days'],
            'mean_lag_days': row['mean_lag_days'],
            'anchor_median_lag_days': row['anchor_median_lag_days'],
            'anchor_mean_lag_days': row['anchor_mean_lag_days'],
        }
        for row in rows
    ]
    
    return SnapshotQueryResponse(
        success=True,
        time_series=time_series,
        coverage={
            'days_requested': (request.anchor_range['to'] - request.anchor_range['from']).days + 1,
            'days_returned': len(time_series),
        }
    )
```

---

### 19.15 Complete Code Path Trace: asAt DSL Extension

**This section traces EVERY code location that would need modification for `asAt()` support.**

---

#### 19.15.1 DSL Parsing: TypeScript (`queryDSL.ts`)

**File:** `graph-editor/src/lib/queryDSL.ts`

**Current State:**
- `QUERY_FUNCTIONS` array (line 28-41): Defines valid function names
- `ParsedConstraints` interface (line 69-78): Defines parsed structure
- `parseConstraints()` function (line 162-346): Parses DSL string

**Changes Required:**

```typescript
// 1. Add to QUERY_FUNCTIONS array (line 38)
export const QUERY_FUNCTIONS = [
  'from',
  'to', 
  'visited',
  'visitedAny',
  'exclude',
  'context',
  'contextAny',
  'case',
  'window',
  'cohort',
  'minus',
  'plus',
  'asAt'  // ← NEW
] as const;

// 2. Extend ParsedConstraints interface (line 77)
export interface ParsedConstraints {
  visited: string[];
  exclude: string[];
  context: Array<{key: string; value: string}>;
  cases: Array<{key: string; value: string}>;
  visitedAny: string[][];
  contextAny: Array<{ pairs: Array<{key: string; value: string}> }>;
  window: { start?: string; end?: string } | null;
  cohort: { anchor?: string; start?: string; end?: string } | null;
  asAt: string | null;  // ← NEW: ISO date string or null
}

// 3. Add parsing logic in parseConstraints() (~line 295)
// Match asAt(date)
const asAtMatch = constraint.match(/asAt\(([^)]+)\)/);
let asAt: string | null = null;
if (asAtMatch) {
  asAt = asAtMatch[1].trim();
}

// 4. Update normalizeConstraintString() (~line 530)
if (parsed.asAt) {
  parts.push(`asAt(${parsed.asAt})`);
}

// 5. Update augmentDSLWithConstraint() (~line 610)
// asAt: new overrides existing (like window/cohort)
const mergedAsAt = newParsed.asAt || existing.asAt;
```

---

#### 19.15.2 DSL Parsing: Python (`query_dsl.py`)

**File:** `graph-editor/lib/query_dsl.py`

**Current State:**
- `ParsedQuery` dataclass (line 74-97)
- `parse_query()` function (line 164-243)
- `_extract_window()` helper (line 385-408)

**Changes Required:**

```python
# 1. Add to grammar comment (line 11)
#     asAt-clause       ::= ".asAt(" date-or-offset ")"

# 2. Extend ParsedQuery dataclass (line 94)
@dataclass
class ParsedQuery:
    # ... existing fields ...
    as_at: Optional[str] = None  # ← NEW: Historical query date

# 3. Add extraction helper (~line 410)
def _extract_as_at(query: str) -> Optional[str]:
    """
    Extract asAt constraint from query.
    
    Examples:
        _extract_as_at("...asAt(1-Jan-25)...") → "1-Jan-25"
        _extract_as_at("...asAt(2025-01-01)...") → "2025-01-01"
    """
    pattern = r'asAt\(([^)]+)\)'
    match = re.search(pattern, query)
    return match.group(1).strip() if match else None

# 4. Update parse_query() (~line 225)
as_at = _extract_as_at(query)

# 5. Include in ParsedQuery return (~line 242)
return ParsedQuery(
    # ... existing fields ...
    as_at=as_at,
)

# 6. Update ParsedQuery.raw property (~line 139)
if self.as_at:
    parts.append(f"asAt({self.as_at})")
```

---

#### 19.15.3 Scenario DSL Composition

**File:** `graph-editor/src/services/scenarioRegenerationService.ts`

**Current State:**
- `FetchParts` interface (line 20-25): window, cohort, context, contextAny
- `splitDSLParts()` function (line 73-97): Splits DSL into fetch/what-if

**Changes Required:**

```typescript
// 1. Extend FetchParts interface (line 20)
export interface FetchParts {
  window: { start?: string; end?: string } | null;
  cohort: { start?: string; end?: string } | null;
  context: Array<{ key: string; value: string }>;
  contextAny: Array<{ pairs: Array<{ key: string; value: string }> }>;
  asAt: string | null;  // ← NEW
}

// 2. Update splitDSLParts() (~line 84)
return {
  fetchParts: {
    window: parsed.window,
    cohort: parsed.cohort,
    context: parsed.context,
    contextAny: parsed.contextAny,
    asAt: parsed.asAt,  // ← NEW
  },
  // ... whatIfParts unchanged
};

// 3. Update buildFetchDSL() (~line 141)
// asAt
if (parts.asAt) {
  segments.push(`asAt(${parts.asAt})`);
}
```

**CRITICAL INTERACTION:** When a scenario has `asAt` in its queryDSL:
- Inherited DSL with `asAt` propagates to effective DSL
- `asAt` in a HIGHER layer OVERRIDES `asAt` from a LOWER layer (same as window/cohort)
- Live scenarios with `asAt` become "frozen" at that historical date

---

#### 19.15.4 WindowSelector UI

**File:** `graph-editor/src/components/WindowSelector.tsx`

**Current State:**
- `queryMode` state: 'cohort' | 'window' (line 104)
- Mode toggle renders (line ~350)
- DateRangePicker for date selection

**Changes Required:**

1. **New state for asAt mode:**
```typescript
const [queryMode, setQueryMode] = useState<'cohort' | 'window' | 'asAt'>('cohort');
const [asAtDate, setAsAtDate] = useState<string | null>(null);
```

2. **Mode detection on DSL parse:**
```typescript
// In initialization effect (~line 169)
const existingMode = authoritativeDSL.includes('asAt(') ? 'asAt' 
  : authoritativeDSL.includes('cohort(') ? 'cohort' 
  : 'window';
setQueryMode(existingMode);

// Extract asAt date if present
const asAtMatch = authoritativeDSL.match(/asAt\(([^)]+)\)/);
if (asAtMatch) {
  setAsAtDate(asAtMatch[1]);
}
```

3. **UI for asAt mode:**
```typescript
// New toggle option in mode selector
{queryMode === 'asAt' && (
  <div className="ws-as-at-selector">
    <label>View as at:</label>
    <input 
      type="date" 
      value={asAtDate ? formatISO(asAtDate) : ''}
      onChange={(e) => setAsAtDate(e.target.value)}
    />
    <span className="ws-as-at-indicator">Historical view</span>
  </div>
)}
```

4. **DSL construction:**
```typescript
// When building DSL string (~line 400)
if (queryMode === 'asAt' && asAtDate) {
  // Keep the underlying window/cohort, but add asAt
  const baseDSL = `${dateMode}(${start}:${end})`;
  return `${baseDSL}.asAt(${asAtDate})`;
}
```

---

#### 19.15.5 Scenarios Panel: asAt Scenarios

**File:** `graph-editor/src/components/panels/ScenariosPanel.tsx`

**Current Scenario Display:**
- Shows scenario name, colour, queryDSL
- "Regenerate" button for live scenarios

**Changes Required:**

1. **Visual indicator for asAt scenarios:**
```typescript
// In scenario card rendering
{scenario.meta?.queryDSL?.includes('asAt(') && (
  <span className="scenario-asAt-badge" title="Historical snapshot">
    📅 As at {extractAsAtDate(scenario.meta.queryDSL)}
  </span>
)}
```

2. **Disable "Regenerate" for asAt scenarios:**
```typescript
// asAt scenarios are read-only from DB
const isAsAtScenario = scenario.meta?.queryDSL?.includes('asAt(');
<button 
  disabled={isAsAtScenario}
  title={isAsAtScenario ? 'Historical scenarios cannot be regenerated' : 'Regenerate from source'}
>
  Regenerate
</button>
```

---

#### 19.15.6 Data Operations Service: Fork Point

**File:** `graph-editor/src/services/dataOperationsService.ts`

**Current State:**
- `getFromSourceDirect()` (line 3654+): Main fetch function
- DAS execution (line 5914): Calls Amplitude API

**Changes Required (detailed in §19.14):**

```typescript
// In getFromSourceDirect(), after signature computation (~line 4947)
// and BEFORE DAS execution (~line 5910)

// Extract asAt from effective DSL
const effectiveDSL = targetSlice || currentDSL || '';
const parsedDSL = parseConstraints(effectiveDSL);
const asAtDate = parsedDSL.asAt;

if (asAtDate) {
  // ═══════════════════════════════════════════════════════════════
  // HISTORICAL QUERY: Retrieve from snapshot DB instead of Amplitude
  // ═══════════════════════════════════════════════════════════════
  
  const dbParamId = `${workspace.repository}-${workspace.branch}-${objectId}`;
  
  // Call Python endpoint
  const snapshotResult = await graphComputeClient.querySnapshots({
    param_id: dbParamId,
    core_hash: querySignature,
    slice_key: sliceDSL || '',
    anchor_range: { from: requestedWindow.start, to: requestedWindow.end },
    as_at: asAtDate,
  });
  
  if (!snapshotResult.success) {
    // Error handling per §19.4.4
    const errorType = snapshotResult.errorType;
    if (errorType === 'signature_mismatch') {
      throw new Error('Query configuration has changed since snapshots were stored');
    } else if (errorType === 'no_data') {
      throw new Error('No snapshot history available for this parameter');
    }
    throw new Error(snapshotResult.errorMessage);
  }
  
  // Convert DB result to time-series format
  allTimeSeriesData.push(...snapshotResult.timeSeries.map(row => ({
    date: row.date,
    n: row.n,
    k: row.k,
    p: row.n > 0 ? row.k / row.n : 0,
    anchor_n: row.anchor_n,
    median_lag_days: row.median_lag_days,
    mean_lag_days: row.mean_lag_days,
    anchor_median_lag_days: row.anchor_median_lag_days,
    anchor_mean_lag_days: row.anchor_mean_lag_days,
  })));
  
  // CRITICAL: Skip DAS execution AND file writes
  shouldSkipFetch = true;
  writeToFile = false;  // asAt queries are read-only
  
  sessionLogService.addChild(logOpId, 'info', 'ASAT_QUERY',
    `Retrieved ${snapshotResult.timeSeries.length} days from snapshot DB as at ${asAtDate}`
  );
}
```

---

#### 19.15.7 Graph Compute Client: New Endpoint

**File:** `graph-editor/src/lib/graphComputeClient.ts`

**Changes Required:**

```typescript
// New method for snapshot queries
async querySnapshots(params: {
  param_id: string;
  core_hash: string;
  slice_key: string;
  anchor_range: { from: string; to: string };
  as_at: string;
}): Promise<{
  success: boolean;
  errorType?: 'signature_mismatch' | 'no_data' | 'partial_coverage' | 'error';
  errorMessage?: string;
  timeSeries: Array<{
    date: string;
    n: number;
    k: number;
    anchor_n?: number;
    median_lag_days?: number;
    mean_lag_days?: number;
    anchor_median_lag_days?: number;
    anchor_mean_lag_days?: number;
  }>;
  coverage?: {
    days_requested: number;
    days_returned: number;
  };
}> {
  const response = await fetch(`${this.baseUrl}/api/snapshots/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  
  return response.json();
}
```

---

#### 19.15.8 Python API Handler

**File:** `graph-editor/lib/api_handlers.py`

**New endpoint (detailed in §19.14.6):**

```python
@app.post("/api/snapshots/query")
async def query_snapshots(request: SnapshotQueryRequest) -> SnapshotQueryResponse:
    """Query snapshot DB for historical data with signature validation."""
    # Implementation per §19.14.6
```

---

#### 19.15.9 Scenario Stacking with asAt: Comparison Use Case

**Problem:** User wants to compare "Current" with "As at 1-Dec-25".

**Solution:**

1. **Current view** (WindowSelector):
   - `cohort(1-Nov-25:30-Nov-25)` → fetches from Amplitude

2. **Create asAt scenario:**
   - User clicks "Create Scenario" → "Historical Snapshot"
   - Enters date: 1-Dec-25
   - Scenario created with `queryDSL: "asAt(1-Dec-25)"`

3. **Scenario composition:**
   ```
   Base DSL:     cohort(1-Nov-25:30-Nov-25)
   Scenario DSL: asAt(1-Dec-25)
   Effective:    cohort(1-Nov-25:30-Nov-25).asAt(1-Dec-25)
   ```

4. **When scenario is visible:**
   - `regenerateScenario()` calls `getFromSourceDirect()`
   - `getFromSourceDirect()` detects `asAt` → queries DB
   - DB returns historical values for that cohort range AS OF 1-Dec-25
   - Scenario params populated with historical data
   - Graph renders both Current (fresh) and scenario (historical) overlays

**CRITICAL:** The `asAt` scenario inherits the **window/cohort date range** from the base DSL, but retrieves data **as it was known on the asAt date**.

---

#### 19.15.10 Edge Cases and Validation

| Scenario | Handling |
|----------|----------|
| `asAt` date before any snapshots | Error: "No snapshot data available before {date}" |
| `asAt` date in future | Error: "Cannot query future dates" |
| `asAt` with different core_hash | Error: "Query configuration changed since snapshots" |
| `asAt` with partial coverage | Warning + return available data with metadata |
| `asAt` scenario + live regeneration | Disabled - asAt scenarios are read-only |
| `asAt` in base DSL | All scenarios inherit asAt → all queries go to DB |
| Multiple `asAt` in stack | Topmost `asAt` wins (override semantics) |

---

#### 19.15.11 Graph Evolution and Signature Validity

**Problem:** Graphs evolve over time (new branches, modified queries, added/removed edges). Historical snapshots were stored with signatures computed from the graph AS IT WAS at storage time. How do we handle mismatches?

##### Change Scenarios

| Graph Change | Impact on `asAt` |
|--------------|------------------|
| **New edge added** | No historical data exists → "No snapshots for this parameter" |
| **Edge deleted** | Data orphaned in DB → edge doesn't appear in current graph |
| **Query modified** | Signature mismatch → "Query configuration changed" |
| **Edge unchanged** | ✅ Signature matches → data retrieved |

##### Branch Scenario Example

```
main (December):     A → B → C
                     (snapshots with signatures S1, S2)

feature (January):   A → B → C
                          ↘
                           D → E
                           (new edges, no snapshots)
```

When `asAt(1-Dec-25)` on **feature** branch:
- A→B, B→C: ✅ Retrieve historical data (signatures match)
- B→D, D→E: ❌ "No snapshots" (edges didn't exist then)

**This is semantically correct.** Partial historical view reflects reality.

##### Query Modification Scenario

```
December:  A→B query: from(a).to(b).visited(x)      → signature ABC123
January:   A→B query: from(a).to(b).visited(x,y)   → signature DEF456
```

When `asAt(1-Dec-25)` with CURRENT graph:
- Current signature: DEF456
- DB has: ABC123
- **Mismatch** → Error with explanation

##### Design Decision: Current Graph Only (V1)

**V1 Approach:**
```
asAt(date)
    ↓
Compute signature from CURRENT graph
    ↓
Query DB: WHERE core_hash = {current_signature} AND retrieved_at <= {date}
    ↓
Match → return data
No match → error message explaining why
```

**Rationale:**
- Simple, clear semantics: "Current graph viewed with historical data"
- No git integration required
- Partial results are meaningful
- Error messages guide user to alternatives

**NOT supported in V1:**
- Retrieving historical graph topology from git
- Computing signatures from historical graph versions
- "Time machine" to see exactly what graph looked like on date X

##### Error Messages for Signature Issues

| Situation | Message |
|-----------|---------|
| No data at all | "No snapshot history exists for parameter {id}" |
| Data exists, different hash | "Historical data exists but query configuration has changed. Current query hash: {cur}, stored: {old}. The query definition was modified after snapshots were taken." |
| Edge added after asAt date | "Parameter {id} was added after {date}. No historical data available." |
| Partial graph coverage | "Historical data available for {N} of {M} edges. {missing} have no snapshots for this date range." |

##### Future Enhancement: Signature History Table (V2)

To enable retrieval even when signatures change:

```sql
CREATE TABLE signature_history (
    param_id        TEXT NOT NULL,
    core_hash       TEXT NOT NULL,
    valid_from      TIMESTAMP NOT NULL,  -- When this signature started being used
    valid_to        TIMESTAMP,           -- NULL = still current
    query_summary   TEXT,                -- Human-readable: "from(a).to(b).visited(x)"
    PRIMARY KEY (param_id, core_hash, valid_from)
);
```

This would allow:
1. Look up which signature was valid on asAt date
2. Query DB with THAT signature
3. No need to retrieve historical graph — just historical signature mapping

**Deferred to V2** — adds complexity, not essential for initial use cases.

##### User Workaround for Full Historical View

If user needs to see exactly what was visible on a historical date:

1. `git checkout {commit-from-that-date}`
2. Load graph
3. Use `asAt(date)` — signatures will match because graph is from that era
4. View historical data with historical graph topology

This is manual but complete. Consider automating only if clear demand.

---

#### 19.15.11 Test Files Requiring Updates

| File | Changes |
|------|---------|
| `src/lib/__tests__/queryDSL.test.ts` | Add asAt parsing tests |
| `lib/query_dsl.py` tests | Add asAt extraction tests |
| `src/services/__tests__/dataOperationsService.integration.test.ts` | Add asAt fork tests |
| `src/contexts/__tests__/ScenariosContext.liveScenarios.test.tsx` | Add asAt scenario tests |
| `src/components/__tests__/WindowSelector.coverage.test.ts` | Add asAt mode tests |

---

### 19.16 Implementation Validation Checklist

Before implementing `asAt`:

**DSL Parsing:**
- [ ] Add `asAt` to `QUERY_FUNCTIONS` in `queryDSL.ts`
- [ ] Add `asAt` field to `ParsedConstraints` interface
- [ ] Add regex parsing for `asAt(date)` in `parseConstraints()`
- [ ] Update `normalizeConstraintString()` to include `asAt`
- [ ] Update `augmentDSLWithConstraint()` for `asAt` override semantics
- [ ] Mirror all changes in Python `query_dsl.py`

**Scenario Integration:**
- [ ] Update `FetchParts` interface with `asAt` field
- [ ] Update `splitDSLParts()` to extract `asAt`
- [ ] Update `buildFetchDSL()` to reconstruct `asAt`
- [ ] Update `computeInheritedDSL()` for `asAt` inheritance

**UI:**
- [ ] Add `asAt` mode to WindowSelector
- [ ] Add date picker for asAt date
- [ ] Add visual indicator for asAt scenarios
- [ ] Disable regeneration for asAt scenarios

**Data Flow:**
- [ ] Add asAt detection in `getFromSourceDirect()`
- [ ] Implement DB query fork before DAS execution
- [ ] Add `querySnapshots()` method to `graphComputeClient`
- [ ] Implement `/api/snapshots/query` Python endpoint
- [ ] Suppress file writes for asAt queries

**Testing:**
- [ ] Unit tests for DSL parsing
- [ ] Integration tests for scenario composition
- [ ] E2E tests for asAt data retrieval
- [ ] Edge case tests (no data, signature mismatch, partial coverage)

---

## 20. Snapshot-Based Analysis Types

### 20.1 Daily Conversions Chart

**Purpose:** Show a bar chart of conversions per calendar date for a selected edge.

**Trigger:** `from(X).to(Y)` DSL with analysis type `daily_conversions_snapshot`.

**Frontend request:**
```typescript
const request: AnalysisRequest = {
  scenarios: [{ scenario_id: 'current', graph }],
  query_dsl: 'from(A).to(B).window(1-Oct-25:31-Oct-25)',
  analysis_type: 'daily_conversions_snapshot',
  snapshot_query: {
    param_id: 'acme/analytics-main-param-a-to-b',
    segments: [{
      core_hash: 'abc123...',
      slice_keys: [''],  // uncontexted
      anchor_range: { from: '2025-10-01', to: '2025-10-31' },
      is_mece: true,
    }],
  },
};
```

**Python derivation:**

```python
def derive_daily_conversions(rows: list[dict]) -> AnalysisResult:
    """
    Derive daily conversion counts from snapshot history.
    
    For each anchor_day, ΔY between snapshots = conversions attributed
    to the retrieved_at date.
    """
    daily_totals: dict[date, int] = defaultdict(int)
    
    by_anchor = group_by(rows, key=lambda r: r['anchor_day'])
    
    for anchor_day, snapshots in by_anchor.items():
        snapshots_sorted = sorted(snapshots, key=lambda r: r['retrieved_at'])
        prev_Y = 0
        
        for snap in snapshots_sorted:
            delta_Y = snap['Y'] - prev_Y
            if delta_Y > 0:
                daily_totals[snap['retrieved_at'].date()] += delta_Y
            prev_Y = snap['Y']
    
    data = [
        {'date': d.isoformat(), 'conversions': count}
        for d, count in sorted(daily_totals.items())
    ]
    
    return AnalysisResult(
        analysis_type='daily_conversions_snapshot',
        analysis_name='Daily Conversions',
        semantics=ResultSemantics(
            dimensions=[DimensionSpec(id='date', name='Date', type='time', role='primary')],
            metrics=[MetricSpec(id='conversions', name='Conversions', type='count')],
            chart=ChartSpec(recommended='bar', alternatives=['line']),
        ),
        data=data,
    )
```

**Frontend rendering:**

Uses existing chart infrastructure with `recommended='bar'`. Requires adding a bar chart renderer to `AnalysisChartContainer` (currently only funnel/bridge).

### 20.2 Lag Histogram Chart

**Purpose:** Show distribution of conversion lag times for a selected edge.

**Trigger:** `from(X).to(Y)` DSL with analysis type `lag_histogram`.

**Derivation:** As specified in §5.4 (`derive_histogram`).

**Frontend rendering:** Bar chart with lag_days on X axis, conversions on Y axis.

---

## 21. Gap Specifications

### 21.1 Edge Selection → DSL Propagation

**Gap:** When user selects a single edge, AnalyticsPanel DSL is not populated.

**Current flow (nodes only):**
```
GraphCanvas → selectedNodeIds → AnalyticsPanel.querySelection() → constructQueryDSL()
```

**Specification:**

1. **Extend `AnalyticsPanel.tsx`** to also query edge selection:

```typescript
// In AnalyticsPanel.tsx, extend querySelection()
const querySelection = useCallback(() => {
  // ... existing node selection logic ...
  
  // NEW: Also check for edge selection
  const selectedEdges = reactFlowInstance?.getEdges().filter(e => e.selected) || [];
  
  if (selectedEdges.length === 1 && selectedNodeIds.length === 0) {
    // Single edge selected, no nodes → generate from(X).to(Y)
    const edge = selectedEdges[0];
    const fromNode = nodes.find(n => n.uuid === edge.source || n.id === edge.source);
    const toNode = nodes.find(n => n.uuid === edge.target || n.id === edge.target);
    if (fromNode && toNode) {
      return { type: 'edge', dsl: `from(${fromNode.id}).to(${toNode.id})`, edgeId: edge.id };
    }
  }
  
  return { type: 'nodes', nodeIds: selectedNodeIds };
}, []);
```

2. **Update auto-generated DSL logic:**

```typescript
const autoGeneratedDSL = useMemo(() => {
  const selection = querySelection();
  if (selection.type === 'edge') {
    return selection.dsl;  // Already constructed
  }
  if (selection.nodeIds.length === 0) return '';
  return constructQueryDSL(selection.nodeIds, nodes, edges);
}, [querySelection, nodes, edges]);
```

3. **Track selected edge for snapshot queries:**

```typescript
const selectedEdgeId = useMemo(() => {
  const selection = querySelection();
  return selection.type === 'edge' ? selection.edgeId : null;
}, [querySelection]);
```

**Files to modify:**
- `graph-editor/src/components/panels/AnalyticsPanel.tsx`

---

### 21.2 Charting (Deferred)

**Priority:** LOW — charting can iterate once data flow is robust.

**V1 approach:** Simple table or basic bar chart showing raw snapshot data. Fancy visualisations are deferred.

**Future enhancements (post-V1):**
- Line chart showing conversion % by stage over time
- Evidence vs forecast distinction for immature cohorts
- Configurable aggregation (daily/weekly/monthly)

**Key insight:** Charting complexity should NOT block the core write/read path. Get data flowing first; iterate on presentation later.
// X-axis: date
// Y-axis: conversion_pct (0-100%)
// Lines: one per stage, styled by layer (solid=evidence, dashed=forecast)
```

**Evidence vs Forecast distinction:**

For immature cohorts (where completeness < 100%):
- `layer: 'evidence'` = raw observed conversion
- `layer: 'forecast'` = projected final conversion (using t95 extrapolation)
- `layer: 'blended'` = weighted blend based on completeness

The derivation needs access to latency columns to compute completeness and split layers.

**Files to create/modify:**
- `graph-editor/src/components/charts/TimeSeriesLineChart.tsx` (new)
- `graph-editor/src/components/charts/AnalysisChartContainer.tsx` (add line chart routing)
- `graph-editor/lib/runner/snapshot_derivations.py` (new)

---

### 21.3 Analysis Type Registration

**Gap:** New snapshot-based analysis types need registration in both Python and frontend.

**Specification:**

**Frontend (`analysisTypes.ts`):**

```typescript
// Add to ANALYSIS_TYPES array:
{
  id: 'daily_conversions_snapshot',
  name: 'Daily Conversions (History)',
  shortDescription: 'Conversions per day from snapshot history',
  selectionHint: 'Select single edge with from().to()',
  icon: Calendar,  // from lucide-react
},
{
  id: 'lag_histogram',
  name: 'Conversion Lag Distribution',
  shortDescription: 'Time from entry to conversion',
  selectionHint: 'Select single edge with from().to()',
  icon: BarChart3,
},
{
  id: 'funnel_time_series',
  name: 'Funnel Over Time',
  shortDescription: 'Conversion % trends from snapshot history',
  selectionHint: 'Select from().to() path',
  icon: TrendingUp,
},
```

**Python (`adaptor.py`):**

```python
# Snapshot-based analysis types are NOT matched by predicates.
# They are triggered ONLY by explicit analysis_type parameter.
# The adaptor should pass through to dedicated handlers.

# In analyzer.py:
if analysis_type_override in ('daily_conversions_snapshot', 'lag_histogram', 'funnel_time_series'):
    # These require snapshot_query - route to snapshot derivation
    if not request.snapshot_query:
        raise ValueError(f"{analysis_type_override} requires snapshot_query parameter")
    return derive_from_snapshots(analysis_type_override, request.snapshot_query)
```

**Files to modify:**
- `graph-editor/src/components/panels/analysisTypes.ts`
- `graph-editor/lib/runner/analyzer.py`
- `graph-editor/lib/runner/snapshot_derivations.py` (new)

---

### 21.4 Snapshot Query Construction Service

**Gap:** Frontend needs to build `snapshot_query` object from edge selection and DSL.

**Specification:**

**New service:** `snapshotQueryService.ts`

```typescript
// graph-editor/src/services/snapshotQueryService.ts

interface SnapshotQuerySegment {
  core_hash: string;
  slice_keys: string[];
  anchor_range: { from: string; to: string };
  is_mece: boolean;
}

interface SnapshotQuery {
  param_id: string;
  segments: SnapshotQuerySegment[];
}

export async function buildSnapshotQuery(
  graph: Graph,
  edgeId: string,
  dsl: string,
  workspace: { repository: string; branch: string }
): Promise<SnapshotQuery | null> {
  // 1. Find the edge and its parameter
  const edge = graph.edges.find(e => e.uuid === edgeId || e.id === edgeId);
  if (!edge?.p?.id) return null;
  
  const paramId = edge.p.id;
  const dbParamId = `${workspace.repository}-${workspace.branch}-${paramId}`;
  
  // 2. Get parameter file to extract signature
  const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
  if (!paramFile?.data) return null;
  
  // 3. Parse DSL for date range
  const parsed = parseDSL(dsl);
  const anchorRange = extractAnchorRange(parsed);  // from cohort() or window()
  
  // 4. Extract signature and slice info from parameter
  const signature = paramFile.data.signature;
  if (!signature?.coreHash) return null;
  
  // 5. Determine slice keys
  // If DSL has context(), use specific slice_key
  // If uncontexted, check if parameter has MECE slices
  const sliceKeys = resolveSliceKeys(parsed, paramFile.data);
  const isMECE = sliceKeys.length > 1 && checkMECE(sliceKeys, paramFile.data);
  
  return {
    param_id: dbParamId,
    segments: [{
      core_hash: signature.coreHash,
      slice_keys: sliceKeys,
      anchor_range: anchorRange,
      is_mece: isMECE,
    }],
  };
}

function extractAnchorRange(parsed: ParsedQuery): { from: string; to: string } {
  // Extract from cohort(start:end) or window(start:end)
  if (parsed.cohort) {
    return { from: parsed.cohort.start, to: parsed.cohort.end };
  }
  if (parsed.window) {
    return { from: parsed.window.start, to: parsed.window.end };
  }
  // Default: last 30 days
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);
  return { from: formatDate(start), to: formatDate(end) };
}
```

**Integration with AnalyticsPanel:**

```typescript
// In AnalyticsPanel.tsx runAnalysis():
if (selectedAnalysisId?.includes('snapshot')) {
  const snapshotQuery = await buildSnapshotQuery(graph, selectedEdgeId, queryDSL, workspace);
  if (!snapshotQuery) {
    setError('No snapshot data available for this edge');
    return;
  }
  
  response = await graphComputeClient.analyzeSelection(
    graph, queryDSL, scenarioId, scenarioName, scenarioColour,
    selectedAnalysisId,
    visibilityMode,
    snapshotQuery  // NEW parameter
  );
}
```

**Files to create/modify:**
- `graph-editor/src/services/snapshotQueryService.ts` (new)
- `graph-editor/src/components/panels/AnalyticsPanel.tsx`
- `graph-editor/src/lib/graphComputeClient.ts` (add snapshotQuery param)

---

### 21.5 Snapshot Availability in Edge Tooltips

**Gap:** No visibility into what snapshot history exists for each edge.

**User requirement:** Show snapshot coverage in edge tooltips. Must be memoised. Must handle gaps within range.

**Display format examples:**
- `Snapshots: 1-Sep-25 – 15-Sep-25 (15 days)` — contiguous
- `Snapshots: 1-Sep-25 – 15-Sep-25 (12/15 days)` — has gaps
- `Snapshots: none` — no data

**Specification:**

**1. Inventory response includes gap info:**

```typescript
interface SnapshotInventoryCacheEntry {
  paramId: string;
  earliest: string | null;     // ISO date
  latest: string | null;
  totalDays: number;           // Count of unique anchor_days with data
  expectedDays: number;        // Days in range (latest - earliest + 1)
  rowCount: number;
  fetchedAt: number;  // timestamp
}

const CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes

class SnapshotInventoryCache {
  private cache = new Map<string, SnapshotInventoryCacheEntry>();
  private pendingRequests = new Map<string, Promise<SnapshotInventoryCacheEntry>>();
  
  async getInventory(paramIds: string[]): Promise<Map<string, SnapshotInventoryCacheEntry>> {
    const results = new Map<string, SnapshotInventoryCacheEntry>();
    const missing: string[] = [];
    
    // Check cache first
    for (const id of paramIds) {
      const cached = this.cache.get(id);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        results.set(id, cached);
      } else {
        missing.push(id);
      }
    }
    
    // Batch fetch missing
    if (missing.length > 0) {
      const fetched = await this.fetchInventory(missing);
      for (const [id, entry] of fetched) {
        this.cache.set(id, entry);
        results.set(id, entry);
      }
    }
    
    return results;
  }
  
  private async fetchInventory(paramIds: string[]): Promise<Map<string, SnapshotInventoryCacheEntry>> {
    // Batch request to Python
    const response = await fetch('/api/snapshots/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ param_ids: paramIds }),
    });
    
    const data = await response.json();
    const results = new Map<string, SnapshotInventoryCacheEntry>();
    
    for (const item of data.inventory) {
      results.set(item.param_id, {
        paramId: item.param_id,
        earliest: item.earliest_anchor,
        latest: item.latest_anchor,
        rowCount: item.row_count,
        fetchedAt: Date.now(),
      });
    }
    
    return results;
  }
}

export const snapshotInventoryCache = new SnapshotInventoryCache();
```

**2. Hook for edge tooltip:**

```typescript
// graph-editor/src/hooks/useSnapshotAvailability.ts

export function useSnapshotAvailability(
  edges: Edge[],
  workspace: { repository: string; branch: string }
): Map<string, { earliest: string | null; latest: string | null }> {
  const [availability, setAvailability] = useState(new Map());
  
  useEffect(() => {
    // Collect param IDs for edges with parameters
    const paramIds = edges
      .filter(e => e.p?.id)
      .map(e => `${workspace.repository}-${workspace.branch}-${e.p.id}`);
    
    if (paramIds.length === 0) return;
    
    // Dedupe
    const uniqueIds = [...new Set(paramIds)];
    
    // Fetch with caching
    snapshotInventoryCache.getInventory(uniqueIds).then(inventory => {
      const result = new Map();
      for (const edge of edges) {
        if (edge.p?.id) {
          const dbParamId = `${workspace.repository}-${workspace.branch}-${edge.p.id}`;
          const entry = inventory.get(dbParamId);
          if (entry) {
            result.set(edge.uuid || edge.id, {
              earliest: entry.earliest,
              latest: entry.latest,
            });
          }
        }
      }
      setAvailability(result);
    });
  }, [edges, workspace]);
  
  return availability;
}
```

**3. Edge tooltip integration:**

```typescript
// In edge tooltip component (e.g., EdgeBeads or CustomEdge)

const snapshotAvailability = useSnapshotAvailability(edges, workspace);

// In tooltip render:
const availability = snapshotAvailability.get(edge.uuid || edge.id);

function formatSnapshotAvailability(a: SnapshotAvailability): string {
  if (!a.earliest || !a.latest) return 'Snapshots: none';
  const range = `${formatDate(a.earliest)} – ${formatDate(a.latest)}`;
  if (a.totalDays === a.expectedDays) {
    return `Snapshots: ${range} (${a.totalDays} days)`;
  }
  return `Snapshots: ${range} (${a.totalDays}/${a.expectedDays} days)`;
}
```

**4. Batch inventory endpoint (Python):**

The `/api/snapshots/inventory` route returns gap-aware data:

```sql
-- Query to compute inventory with gap detection
SELECT 
  param_id,
  MIN(anchor_day) AS earliest_anchor,
  MAX(anchor_day) AS latest_anchor,
  COUNT(DISTINCT anchor_day) AS total_days,
  (MAX(anchor_day) - MIN(anchor_day) + 1) AS expected_days,
  COUNT(*) AS row_count
FROM snapshots
WHERE param_id = ANY(%s)
GROUP BY param_id
```

Response shape:

```json
{
  "inventory": [
    {
      "param_id": "acme/analytics-main-param-a-to-b",
      "earliest_anchor": "2025-09-01",
      "latest_anchor": "2025-10-15",
      "total_days": 40,
      "expected_days": 45,
      "row_count": 450
    }
  ]
}
```

**Performance considerations:**
- Cache TTL: 5 minutes (snapshots don't change rapidly)
- Batch requests: Collect all visible edge param IDs, single request
- Trigger: On graph load and on manual refresh, NOT on every render
- Memory: Cache grows with unique param_ids seen; prune if > 1000 entries

**Files to create/modify:**
- `graph-editor/src/services/snapshotInventoryCache.ts` (new)
- `graph-editor/src/hooks/useSnapshotAvailability.ts` (new)
- Edge tooltip component (modify to include availability)

---

## 22. Critical Path for Daily Conversions

To enable the daily conversions use case end-to-end:

1. **Phase 0** (Prerequisite)
   - [ ] Fix latency preservation in dual-query/composite paths (§13)

2. **Phase 1** (Write Path)
   - [ ] Implement `snapshotWriteService` in frontend
   - [ ] Implement `/api/snapshots/append` in Python
   - [ ] Wire shadow-write at `getFromSourceDirect()` (§14)

3. **Phase 2** (Read Path)
   - [ ] Add `snapshot_query` parameter to `AnalysisRequest`
   - [ ] Implement `derive_daily_conversions()` in Python (§19.1)
   - [ ] Implement `query_snapshots()` DB query function

4. **Phase 3** (Frontend Integration)
   - [ ] Edge selection → DSL propagation (§20.1)
   - [ ] Add bar chart renderer (§20.2)
   - [ ] Register `daily_conversions_snapshot` analysis type (§20.3)
   - [ ] Build snapshot query construction service (§20.4)

5. **Phase 4** (Polish)
   - [ ] Coverage warnings for sparse data
   - [ ] Snapshot inventory UI (§20.5)

---

## 23. Testing Strategy

**The interplay between signatures, files, dual-query composition, and DB writes is complex. Testing must be ROBUST, BROAD, COMPLETE, and SOPHISTICATED.**

### 23.0 Test Infrastructure (Blocker E Resolved)

**Test DB:** Neon test branch (separate from production)

| Aspect | Specification |
|--------|--------------|
| **DB location** | Neon project, dedicated `test` branch |
| **Reset** | Truncate tables before each test suite run |
| **TS ↔ Python** | TS tests mock Python responses; Python tests hit real DB |
| **CI** | Python tests run with `DB_CONNECTION` pointing to test branch |

**Phase 1 required tests:**

| Test Category | Required for Phase 1? | Notes |
|---------------|----------------------|-------|
| Python unit (handler functions) | ✅ Yes | Mock DB for unit tests |
| Python integration (real DB) | ✅ Yes | Real Neon test branch |
| TS unit (snapshotWriteService) | ✅ Yes | Mock Python responses |
| TS → Python round-trip | ⚠️ Phase 2 | Requires running dev-server |
| Graceful degradation | ✅ Yes | Critical for production safety |

**Test file locations:**

| File | Scope |
|------|-------|
| `lib/tests/test_snapshot_handlers.py` | Python handler unit tests |
| `lib/tests/test_snapshot_integration.py` | Python integration tests (real DB) |
| `lib/tests/test_snapshot_derivations.py` | Histogram/daily conversions derivation tests |
| `src/services/__tests__/snapshotWriteService.test.ts` | TS service tests (mock Python) |
| `src/services/__tests__/snapshotGracefulDegradation.test.ts` | DB unavailable scenarios |

**Test DB setup:**

```bash
# Before test suite
psql $TEST_DB_CONNECTION -c "TRUNCATE TABLE snapshots;"

# Or in Python test setup
@pytest.fixture(autouse=True)
def clean_db():
    conn = get_test_connection()
    conn.execute("TRUNCATE TABLE snapshots")
    conn.commit()
    yield
```

### 23.1 Test Categories

| Category | Focus | Mock/Real |
|----------|-------|-----------|
| **Unit** | Individual functions (signature computation, row formatting) | All mocked |
| **Integration** | Python handler → DB round-trip | Real DB (Neon test branch) |
| **E2E** | Full fetch → file + DB write → read path | Phase 2 (requires running servers) |

### 23.2 Write Path Tests

#### 22.2.1 Basic Write

| Test | Description | Assertions |
|------|-------------|------------|
| `write_simple_timeseries` | Single uncontexted query, 10 days | 10 rows written; all columns populated |
| `write_with_latency` | Include all 4 latency columns | Latency values preserved correctly |
| `write_contexted_slice` | `context(channel:google)` | `slice_key` = `context(channel:google)` |
| `write_idempotent` | Same data twice | Second write creates no duplicates (ON CONFLICT) |

#### 22.2.2 Signature Integrity

| Test | Description | Assertions |
|------|-------------|------------|
| `signature_matches_file` | Write via DAS, verify `core_hash` in DB matches file signature | DB `core_hash` === file `signature.coreHash` |
| `signature_includes_cohort_mode` | Cohort vs window same edge | Different `core_hash` values |
| `signature_includes_event_defs` | Same path, different event definitions | Different `core_hash` values |
| `signature_stable_across_writes` | Multiple fetches same query | Same `core_hash` each time |

#### 22.2.3 Dual-Query / Composite

| Test | Description | Assertions |
|------|-------------|------------|
| `dual_query_latency_preserved` | n_query + k_query combined | Latency from k_query reaches DB |
| `dual_query_n_from_base` | n uses base query, k uses composite | `X` column from n_query, `Y` from k_query |
| `composite_minus_query` | `from(A).to(B).minus(from(A).to(C).to(B))` | Synthesised Y reaches DB |
| `composite_latency_preserved` | Composite query | Latency from base query reaches DB |

#### 22.2.4 Multi-Slice / MECE

| Test | Description | Assertions |
|------|-------------|------------|
| `write_multiple_slices` | 3 context slices in one fetch | 3 × N rows (one set per slice) |
| `mece_slices_all_written` | MECE partition fetch | All slices present in DB |

### 23.3 Read Path Tests

#### 22.3.1 Basic Read

| Test | Description | Assertions |
|------|-------------|------------|
| `read_single_param` | Query by param_id + core_hash | Returns expected rows |
| `read_date_range` | Filter by anchor_day range | Only dates in range returned |
| `read_empty` | Query non-existent param | Returns empty array, no error |

#### 22.3.2 Derivation

| Test | Description | Assertions |
|------|-------------|------------|
| `derive_daily_conversions_simple` | 5 snapshots, same cohort | ΔY correctly attributed to each date |
| `derive_daily_conversions_multi_cohort` | 10 cohorts × 5 snapshots | Daily totals aggregated correctly |
| `derive_histogram_simple` | 5 snapshots, increasing Y | Lag bins computed correctly |
| `derive_histogram_gaps` | Snapshots with missing dates | Gap interpolation applied |

#### 22.3.3 MECE Aggregation

| Test | Description | Assertions |
|------|-------------|------------|
| `mece_aggregation_sum` | 3 slices, is_mece=true | X, Y summed across slices |
| `mece_aggregation_latency` | Aggregating latency | Weighted average (by X) not simple average |
| `non_mece_no_aggregation` | is_mece=false | Each slice returned separately |

### 23.4 Round-Trip Tests

| Test | Description | Assertions |
|------|-------------|------------|
| `roundtrip_simple` | Fetch → write → read → derive | Derived result matches expected |
| `roundtrip_dual_query` | Dual-query fetch → write → read | All columns intact |
| `roundtrip_composite` | Composite fetch → write → read | Synthesised data retrievable |
| `roundtrip_contexted_mece` | MECE fetch → write → read → aggregate | Aggregated sum correct |

### 23.5 Error Handling Tests

| Test | Description | Assertions |
|------|-------------|------------|
| `write_db_unavailable` | DB connection fails | Graceful failure; file write succeeds |
| `write_partial_data` | Some rows missing columns | Nullable columns handled; non-null enforced |
| `read_invalid_hash` | core_hash doesn't exist | Empty result, no crash |
| `read_db_timeout` | DB query times out | Appropriate error returned |

### 23.6 Test Infrastructure

**Test Database:**
- Separate Neon branch or local Postgres for testing
- Schema identical to production
- Truncated before each test suite run

**Fixtures:**
```typescript
// Sample fixture data
const FIXTURE_SIMPLE_TIMESERIES = {
  param_id: 'test-repo-test-branch-param-a-to-b',
  core_hash: 'abc123...',
  slice_key: '',
  rows: [
    { anchor_day: '2025-10-01', A: 100, X: 80, Y: 10, ... },
    { anchor_day: '2025-10-02', A: 95, X: 75, Y: 12, ... },
    ...
  ],
};

const FIXTURE_DUAL_QUERY_RESULT = {
  // n_query provides X, k_query provides Y and latency
  ...
};
```

**Vitest Integration:**
- TS tests in `graph-editor/src/services/__tests__/snapshot*.test.ts`
- Python tests in `graph-editor/lib/tests/test_snapshot_*.py`
- CI runs both with test DB connection

### 23.7 Test File Locations

| File | Contents |
|------|----------|
| `src/services/__tests__/snapshotWriteService.test.ts` | Write path unit tests |
| `src/services/__tests__/snapshotQueryService.test.ts` | Query construction tests |
| `src/services/__tests__/snapshotRoundtrip.e2e.test.ts` | Full round-trip tests |
| `lib/tests/test_snapshot_derivations.py` | Python derivation tests |
| `lib/tests/test_snapshot_integration.py` | Python DB interaction tests |

### 23.8 Critical Test Scenarios

**These MUST pass before any release:**

1. **Signature consistency:** `core_hash` in DB matches file signature for same query
2. **Dual-query latency:** Latency preserved through dual-query combination to DB
3. **Composite write:** Synthesised Y from composite queries written correctly
4. **MECE aggregation:** Sum of MECE slices equals uncontexted query result
5. **Round-trip integrity:** Data written can be read back and derived correctly
6. **Graceful degradation:** DB failure doesn't break file writes

### 23.9 `asAt` Tests (Phase 2)

| Test | Description | Assertions |
|------|-------------|------------|
| `asAt_returns_historical` | Query with `asAt(T)` | Returns snapshot with `retrieved_at <= T` |
| `asAt_latest_per_anchor` | Multiple snapshots per anchor_day | Returns most recent as of `asAt` date |
| `asAt_no_data` | `asAt` before any snapshots | Returns empty/error gracefully |
| `asAt_signature_unchanged` | Same query with/without asAt | `core_hash` identical |
| `asAt_no_side_effects` | Historical query | No file writes, no DB writes |
| `asAt_shape_matches_live` | Compare result shapes | Identical `TimeSeriesPoint` structure |
| `asAt_future_date` | `asAt(tomorrow)` | Behaves like live query (latest available) |