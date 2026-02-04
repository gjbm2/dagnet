# Historical Query Mode: `asat()` — Design and Implementation

**Status**: Phase 1 plan (stepping stone)  
**Prerequisite**: Snapshot write path working; snapshot DB reachable from python-api  
**Date**: 4-Feb-26

---

## 1. Overview

The `asat()` DSL extension enables **historical queries** — viewing conversion data "as it was known at a specific past date" rather than the current state.

**Example:**
```
from(A).to(B).window(1-Oct-25:31-Oct-25).asat(15-Oct-25)
```

**Semantics:** Return time-series data for the window, but **as it would have appeared on 15-Oct-25** — i.e., retrieve from the snapshot DB with `retrieved_at <= 15-Oct-25`, not from Amplitude.

### 1.1 Requirements (Phase 1)

This Phase 1 plan incorporates the clarified requirements:

1. **Canonical function name** is `asat` (lowercase). We may also permit `at` as sugar.
2. `asat(5-Nov-25)` takes a **UK-style** date token (`d-MMM-yy`) at the DSL layer.
3. DSL is **order-indifferent** for constraints: `asat(...)` may appear anywhere in the chain.
4. Phase 1 can ship **without any dedicated UI**: users can manually type the `asat` clause.
5. The Monaco query editors must handle the syntax properly (no “unknown function” diagnostics; sensible chips).
6. When dedicated UI is added later, we must surface “available snapshots” by date/time (requires a route that returns distinct retrieval times).
7. The Python “virtual snapshot” read must scope over the full requested anchor range and select **latest-per-anchor_day as-of** `as_at` (not be biased to a single incremental retrieval session).

### 1.2 Naming + sugar

- **Canonical**: `asat(...)`
- **Alias**: `at(...)` is accepted as sugar for `asat(...)`
- **Normalisation**: `normalizeConstraintString()` should emit `asat(...)` only (never `at(...)`), so there is one canonical form.

### 1.3 Date literal format + boundary conversion

- DSL accepts UK tokens: `asat(5-Nov-25)`
- At the API/DB boundary we use ISO:
  - `anchor_from` / `anchor_to`: ISO dates (`YYYY-MM-DD`)
  - `as_at`: ISO datetime (what python currently parses)
- Interpretation policy for a **date-only** `asat(d-MMM-yy)` literal:
  - Treat it as “as at the end of that day” and convert to ISO as `YYYY-MM-DDT23:59:59Z` (or `...59.999Z` if we want inclusive end-of-day).
  - The “no snapshot within 24 hours” warning window is computed relative to this `as_at` timestamp.

### 1.4 Terminology note (legacy)

Some existing sections below still refer to `asAt` (camelCase) in examples/headings. In Phase 1 the canonical DSL function is `asat` (lowercase); treat any `asAt` mention as legacy spelling to be migrated.

---

## 2. Use Cases

| Use Case | DSL Example | Business Value |
|----------|-------------|----------------|
| **Audit trail** | `.asat(1-Nov-25)` | "What did the dashboard show on 1-Nov?" |
| **Debugging** | `.asat(report_date)` | "Why did the report show X on that day?" |
| **Trend analysis** | Compare `.asat(T1)` vs `.asat(T2)` | "How did our view evolve?" |
| **Immature cohort replay** | `.asat(cohort_date + 7d)` | "What did we know after 1 week?" |
| **Scenario comparison** | Live vs asat(T) side-by-side | "How much has our view changed?" |

---

## 3. Core Principles

### 3.1 `asat` is a Retrieval Filter, Not a Query Identity

```
from(A).to(B).window(1-Oct:31-Oct)              → core_hash = abc123
from(A).to(B).window(1-Oct:31-Oct).asat(15-Oct) → core_hash = abc123 (SAME)
```

The `asat` date filters **which snapshots to return**, not **what the query means**.

### 3.2 Signature Validation is MANDATORY

Before returning historical data, we MUST verify the computed `core_hash` matches stored data:

1. **Query definitions evolve** — event filters may have changed
2. **Safety** — returning data for a different query would be silently wrong
3. **Semantic consistency** — only return data that answers the *same* question

### 3.3 Historical Queries are Read-Only

| Query Type | File Cache | Memory Cache | DB |
|------------|------------|--------------|-----|
| Live (no asat) | Write | Write | Shadow-write |
| Historical (asat) | **Read-only** | **Read-only** | **Read-only** |

No writes to files, IndexedDB, or snapshot DB for `asat` queries.

### 3.4 Uses Current Graph for Signature

For V1, `asat` queries compute signatures using the **current** graph definition:

- If query definition has changed since snapshots were stored → signature mismatch
- Clear error message: "Query configuration has changed since snapshots were stored"
- Historical graph retrieval is deferred (complex; requires Git integration)

---

## 4. Data Flow

### 4.1 Without `asat` (Current Behaviour)

```
DSL: from(A).to(B).window(1-Oct:31-Oct)
    → Fetch from Amplitude (live data)
    → Write to file + shadow-write to DB
    → Return current state
```

### 4.2 With `asat` (New Behaviour)

```
DSL: from(A).to(B).window(1-Oct:31-Oct).asat(15-Oct-25)
    → Parse DSL, extract asat date
    → Compute signature (same as live query)
    → Query DB: WHERE core_hash = %s AND retrieved_at <= '2025-10-15'
    → Return a virtual snapshot: latest-per-anchor_day as-of that date
    → NO write to file, NO shadow-write to DB (read-only)
```

### 4.3 Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SIGNATURE-VALIDATED HISTORICAL QUERY                                         │
│                                                                              │
│   1. Parse DSL: from(A).to(B).window(1-Oct:31-Oct).asat(15-Oct)            │
│                                                                              │
│   2. Compute core_hash using CURRENT query definition (same as live query)  │
│                                                                              │
│   3. Query DB:                                                              │
│      WHERE param_id = %s                                                    │
│        AND core_hash = %s        ←── SIGNATURE MATCH                        │
│        AND slice_key = %s                                                   │
│        AND anchor_day BETWEEN %s AND %s                                     │
│        AND retrieved_at <= %s    ←── AS-AT FILTER                           │
│                                                                              │
│   4. Reduce to virtual snapshot (latest-per-anchor_day as-of `as_at`)       │
│   5. If rows found → return time-series                                     │
│   6. If no rows → "No historical data matching current query configuration" │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Error Handling

### 5.1 Signature Mismatch

| Scenario | Likely Cause | User Message |
|----------|--------------|--------------|
| No rows at all | Query never fetched, or param_id wrong | "No snapshot history for this parameter" |
| Rows exist but different hash | Query definition changed | "Historical data exists but query configuration has changed. Snapshots were stored with a different query definition." |

### 5.2 Coverage Scenarios

| Scenario | What Happens |
|----------|--------------|
| **Full coverage** | `window(1-Oct:31-Oct).asat(15-Nov)` with daily snapshots → One row per anchor_day |
| **Partial coverage** | `asat(15-Oct)` but snapshots started 10-Oct → Rows only for available dates |
| **No coverage** | `asat(9-Oct)` but snapshots started 10-Oct → Empty result |
| **Sparse snapshots** | `asat(15-Oct)` with snapshots on 10th, 12th, 15th → Most recent per anchor ≤ 15-Oct |

### 5.3 Edge Cases

| Edge Case | Handling |
|-----------|----------|
| asat date before first snapshot | Error: "No data as of {date}" |
| asat date in future | Behave as live query (use latest available) |
| Anchor range extends beyond data | Return partial result with coverage metadata |
| DB unavailable | Error: "Historical data requires database connection" |
| Python server unavailable | Error: "Historical data unavailable" |

---

## 6. Result Shape

### 6.1 Time-Series Format (Unchanged)

```typescript
interface TimeSeriesPoint {
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

**Frontend should NOT need to know** whether data came from Amplitude or DB.

### 6.2 Coverage Metadata (New)

```typescript
interface AsAtResult {
  timeSeries: TimeSeriesPoint[];
  coverage: {
    requestedRange: { from: string; to: string };
    actualRange: { from: string | null; to: string | null };
    daysRequested: number;
    daysReturned: number;
    oldestSnapshot: string;  // earliest retrieved_at
    newestSnapshot: string;  // latest retrieved_at (≤ asat)
  };
  warnings?: string[];  // e.g., "Partial coverage: 25/31 days"
}
```

### 6.3 Warning policy (Phase 1)

We distinguish between:

- **Missing days inside the daily series**: do **not** warn by default.
- **Staleness vs the requested `asat`**: warn if no snapshot within 24 hours of the requested `asat` timestamp.
- **Missing coverage of the requested window end (`anchor_to`)**: warn if the virtual snapshot does not include a point for the requested `anchor_to` day.

This yields two warnings in the motivating example:

- Warn A: “No snapshot within 24 hours of \[asat date\]”
- Warn B: “Missing data for \[anchor_to\] (requested window end not covered)”

---

## 7. DB Query

```sql
-- Get most recent snapshot per anchor_day as of the asat date
WITH ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY param_id, core_hash, slice_key, anchor_day
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
```

Returns **one row per anchor_day** — the most recent snapshot as of the `asat` date.

---

## 8. Legacy (superseded) file-by-file trace

This section and the downstream impact-analysis tables were written against an earlier camelCase `asAt(...)` draft and earlier endpoint naming.

For implementation, treat **§12 (Phases 1–2)** as authoritative. We will either migrate or remove the legacy material below as the implementation proceeds.

### 8.1 DSL Parsing — TypeScript

**File:** `graph-editor/src/lib/queryDSL.ts`

**Changes:**

```typescript
// 1. Add to QUERY_FUNCTIONS array (~line 38)
export const QUERY_FUNCTIONS = [
  'from', 'to', 'visited', 'visitedAny', 'exclude',
  'context', 'contextAny', 'case', 'window', 'cohort',
  'minus', 'plus',
  'asAt'  // ← NEW
] as const;

// 2. Extend ParsedConstraints interface (~line 77)
export interface ParsedConstraints {
  // ... existing fields ...
  asAt: string | null;  // ← NEW: ISO date string or null
}

// 3. Add parsing logic in parseConstraints() (~line 295)
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
const mergedAsAt = newParsed.asAt || existing.asAt;
```

### 8.2 DSL Parsing — Python

**File:** `graph-editor/lib/query_dsl.py`

**Changes:**

```python
# 1. Extend ParsedQuery dataclass (~line 94)
@dataclass
class ParsedQuery:
    # ... existing fields ...
    as_at: Optional[str] = None  # ← NEW

# 2. Add extraction helper (~line 410)
def _extract_as_at(query: str) -> Optional[str]:
    pattern = r'asAt\(([^)]+)\)'
    match = re.search(pattern, query)
    return match.group(1).strip() if match else None

# 3. Update parse_query() (~line 225)
as_at = _extract_as_at(query)

# 4. Include in ParsedQuery return (~line 242)
return ParsedQuery(
    # ... existing fields ...
    as_at=as_at,
)

# 5. Update ParsedQuery.raw property (~line 139)
if self.as_at:
    parts.append(f"asAt({self.as_at})")
```

### 8.3 Scenario Composition

**File:** `graph-editor/src/services/scenarioRegenerationService.ts`

**Changes:**

```typescript
// 1. Extend FetchParts interface (~line 20)
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
    // ... existing fields ...
    asAt: parsed.asAt,  // ← NEW
  },
  // whatIfParts unchanged
};

// 3. Update buildFetchDSL() (~line 141)
if (parts.asAt) {
  segments.push(`asAt(${parts.asAt})`);
}
```

**Inheritance rule:** `asAt` in a HIGHER layer OVERRIDES `asAt` from a LOWER layer (same as window/cohort).

### 8.4 WindowSelector UI

**File:** `graph-editor/src/components/WindowSelector.tsx`

**Changes:**

```typescript
// 1. New state for asAt
const [asAtEnabled, setAsAtEnabled] = useState(false);
const [asAtDate, setAsAtDate] = useState<string | null>(null);

// 2. Parse existing DSL for asAt
useEffect(() => {
  if (authoritativeDSL.includes('asAt(')) {
    const match = authoritativeDSL.match(/asAt\(([^)]+)\)/);
    if (match) {
      setAsAtEnabled(true);
      setAsAtDate(match[1]);
    }
  }
}, [authoritativeDSL]);

// 3. UI component
{/* AsAt Selector */}
<div className="ws-as-at-section">
  <label>
    <input
      type="checkbox"
      checked={asAtEnabled}
      onChange={(e) => setAsAtEnabled(e.target.checked)}
    />
    View historical data as at:
  </label>
  {asAtEnabled && (
    <input
      type="date"
      value={asAtDate || ''}
      onChange={(e) => setAsAtDate(e.target.value)}
    />
  )}
  {asAtEnabled && asAtDate && (
    <div className="ws-as-at-indicator">
      ⏱️ Historical view: {asAtDate}
    </div>
  )}
</div>

// 4. DSL construction
const buildDSL = () => {
  const baseDSL = `${modePrefix}(${start}:${end})`;
  return asAtEnabled && asAtDate
    ? `${baseDSL}.asAt(${asAtDate})`
    : baseDSL;
};
```

### 8.5 Scenarios Panel

**File:** `graph-editor/src/components/panels/ScenariosPanel.tsx`

**Changes:**

```typescript
// 1. Visual indicator for asAt scenarios
const isAsAtScenario = scenario.meta?.queryDSL?.includes('asAt(');

{isAsAtScenario && (
  <span className="scenario-asAt-badge">
    📅 {extractAsAtDate(scenario.meta.queryDSL)}
  </span>
)}

// 2. Disable regeneration
<button
  disabled={isAsAtScenario}
  title={isAsAtScenario
    ? 'Historical scenarios cannot be regenerated'
    : 'Regenerate from source'
  }
>
  Regenerate
</button>
```

### 8.6 Data Operations Service — Fork Point

**File:** `graph-editor/src/services/dataOperationsService.ts`

**Location:** `getFromSourceDirect()`, after signature computation (~line 4947), BEFORE DAS execution (~line 5910)

**Changes:**

```typescript
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
    // Error handling per §5
    if (snapshotResult.errorType === 'signature_mismatch') {
      throw new Error('Query configuration has changed since snapshots were stored');
    } else if (snapshotResult.errorType === 'no_data') {
      throw new Error('No snapshot history available for this parameter');
    }
    throw new Error(snapshotResult.errorMessage);
  }
  
  // Convert to time-series format
  allTimeSeriesData.push(...snapshotResult.timeSeries);
  
  // CRITICAL: Skip DAS and file writes
  shouldSkipFetch = true;
  writeToFile = false;  // asAt queries are read-only
  
  sessionLogService.addChild(logOpId, 'info', 'ASAT_QUERY',
    `Retrieved ${snapshotResult.timeSeries.length} days from DB as at ${asAtDate}`
  );
}

// ... existing DAS execution (only runs if !shouldSkipFetch) ...
```

### 8.7 Graph Compute Client

**File:** `graph-editor/src/lib/graphComputeClient.ts`

**New method:**

```typescript
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
  timeSeries: TimeSeriesPoint[];
  coverage?: {
    daysRequested: number;
    daysReturned: number;
  };
}> {
  const response = await fetch(`${this.baseUrl}/api/snapshots/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  
  if (!response.ok) {
    return {
      success: false,
      errorType: 'error',
      errorMessage: `HTTP ${response.status}`,
      timeSeries: [],
    };
  }
  
  return await response.json();
}
```

### 8.8 Python API Endpoint

**File:** `graph-editor/lib/api_handlers.py`

**New endpoint:**

```python
class SnapshotQueryRequest(BaseModel):
    param_id: str
    core_hash: str
    slice_key: str
    anchor_range: Dict[str, str]  # { from: str, to: str }
    as_at: str


@app.post("/api/snapshots/query")
async def query_snapshots(request: SnapshotQueryRequest):
    """
    Query snapshot DB for historical data.
    Returns time-series in same shape as DAS response.
    """
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        
        # Check if ANY data exists for this param
        cur.execute("""
            SELECT COUNT(*), COUNT(DISTINCT core_hash) 
            FROM snapshots 
            WHERE param_id = %s
        """, [request.param_id])
        total_rows, distinct_hashes = cur.fetchone()
        
        if total_rows == 0:
            return {
                "success": False,
                "errorType": "no_data",
                "errorMessage": "No snapshot history for this parameter",
                "timeSeries": [],
            }
        
        # Query with signature match and as_at filter
        cur.execute("""
            WITH ranked AS (
              SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY anchor_day
                  ORDER BY retrieved_at DESC
                ) AS rn
              FROM snapshots
              WHERE param_id = %s
                AND core_hash = %s
                AND slice_key = %s
                AND anchor_day BETWEEN %s AND %s
                AND retrieved_at <= %s
            )
            SELECT 
              anchor_day AS date,
              X AS n, Y AS k, A AS anchor_n,
              median_lag_days, mean_lag_days,
              anchor_median_lag_days, anchor_mean_lag_days
            FROM ranked WHERE rn = 1
            ORDER BY anchor_day
        """, [
            request.param_id,
            request.core_hash,
            request.slice_key,
            request.anchor_range['from'],
            request.anchor_range['to'],
            request.as_at,
        ])
        
        rows = cur.fetchall()
        
        if len(rows) == 0 and distinct_hashes > 0:
            # Data exists but different hash
            return {
                "success": False,
                "errorType": "signature_mismatch",
                "errorMessage": "Historical data exists but query configuration has changed",
                "timeSeries": [],
            }
        
        time_series = [
            {
                "date": row[0].isoformat(),
                "n": row[1],
                "k": row[2],
                "p": row[2] / row[1] if row[1] > 0 else 0,
                "anchor_n": row[3],
                "median_lag_days": row[4],
                "mean_lag_days": row[5],
                "anchor_median_lag_days": row[6],
                "anchor_mean_lag_days": row[7],
            }
            for row in rows
        ]
        
        conn.close()
        
        return {
            "success": True,
            "timeSeries": time_series,
            "coverage": {
                "daysRequested": (
                    parse_date(request.anchor_range['to']) -
                    parse_date(request.anchor_range['from'])
                ).days + 1,
                "daysReturned": len(time_series),
            },
        }
        
    except Exception as e:
        return {
            "success": False,
            "errorType": "error",
            "errorMessage": str(e),
            "timeSeries": [],
        }
```

---

## 9. Files That Import queryDSL (Impact Analysis)

These files use `ParsedConstraints` and may need review for `asAt` handling.

### 9.1 MUST MODIFY

| File | Change |
|------|--------|
| `src/lib/queryDSL.ts` | Add asAt to types and parsing |
| `lib/query_dsl.py` | Add asAt to Python parsing |
| `src/services/dataOperationsService.ts` | Fork to DB for asAt queries |
| `src/services/scenarioRegenerationService.ts` | Handle asAt in composition |
| `src/components/WindowSelector.tsx` | Add asAt mode UI |
| `src/components/panels/ScenariosPanel.tsx` | Show asAt badge, disable regeneration |
| `src/lib/graphComputeClient.ts` | Add querySnapshots method |
| `lib/snapshot_handlers.py` | Add `handle_snapshots_query()` endpoint |

### 9.2 MUST REVIEW (Likely No Changes)

| File | Reason |
|------|--------|
| `src/services/querySignatureService.ts` | **CRITICAL**: Signature must EXCLUDE asAt |
| `src/services/windowAggregationService.ts` | Aggregation unchanged for asAt |
| `src/services/fetchDataService.ts` | May need asAt awareness |
| `src/services/meceSliceService.ts` | MECE resolution unchanged |
| `src/services/sliceIsolation.ts` | Slice isolation unchanged |
| `src/contexts/ScenariosContext.tsx` | Handle asAt scenarios |

### 9.3 Signature MUST Exclude asAt

**File:** `src/services/querySignatureService.ts` or `src/services/dataOperationsService.ts`

```typescript
// When computing coreCanonical for hash, asAt MUST be excluded:
const coreCanonical = JSON.stringify({
  connection: connectionName || '',
  from_event_id: from_event_id || '',
  to_event_id: to_event_id || '',
  // ... other fields ...
  // NOTE: asAt is NOT included — it's a retrieval filter, not query identity
});
```

---

## 10. UI Visual Distinction

When viewing historical data, the UI should clearly indicate:

| Element | Normal | Historical |
|---------|--------|------------|
| Background | Normal | Subtle sepia/amber tint |
| Badge | None | "⏱️ Historical: 15-Oct-25" |
| Data freshness | "Updated: 10 mins ago" | "Viewing as at: 15-Oct-25" |
| Fetch button | "Refresh" | Hidden or disabled |
| Scenario card | Normal | "📅 As at 15-Oct-25" badge |

---

## 11. Graceful Degradation

### 11.1 When DB Unavailable

```typescript
if (asAtDate) {
  try {
    const snapshotResult = await graphComputeClient.querySnapshots({ ... });
    // ... use result
  } catch (error) {
    if (error.message.includes('fetch') || error.message.includes('network')) {
      throw new Error('Historical data requires database connection. Please check your network.');
    }
    throw error;
  }
}
```

### 11.2 UI Handling

- Toast error: "Historical data unavailable — database connection required"
- Scenario panel: asAt scenarios show "⚠️ DB unavailable" badge
- WindowSelector: asAt mode disabled if Python health check fails

---

## 12. Implementation Phases

### Phase 1: Manual `asat(...)` + central fork to DB virtual snapshot (no dedicated UI)

#### 12.1 Frontend: DSL parsing + normalisation (TypeScript)

- **File**: `graph-editor/src/lib/queryDSL.ts`
- **Changes**:
  - Add `asat` and `at` to recognised function names
  - Extend `ParsedConstraints` with `asat: string | null`
  - Update `parseConstraints()` to extract `asat(...)` / `at(...)` regardless of ordering
  - Update `normalizeConstraintString()` to emit canonical `asat(...)` only (never `at(...)`)
  - Ensure any structure validators / patterns do not reject `asat(...)` and do not require it to be last
- **Date policy**:
  - Keep the DSL literal as UK token (`d-MMM-yy`)
  - Convert to ISO at the boundary when building the python request payload

#### 12.2 Frontend: Monaco query editors (required because Phase 1 has no UI)

- **File**: `graph-editor/src/components/QueryExpressionEditor.tsx`
- **Changes**:
  - Extend chip parsing to recognise `asat(...)` and `at(...)`
  - Add chip config so the clause is rendered and not flagged as unknown
  - Ensure allowed function lists include `asat`/`at` via `QUERY_FUNCTIONS`
- **Acceptance**:
  - Typing `.asat(5-Nov-25)` does not produce “Unknown function” warnings
  - Editor parsing/chips are order-indifferent (clause may appear anywhere)

#### 12.3 Frontend: Centralised fork point (DB instead of DAS)

- **File**: `graph-editor/src/services/dataOperationsService.ts`
- **Location**: inside `getFromSourceDirect()`, after signature computation and slice planning, before DAS execution
- **Behaviour**:
  - Detect `asat` in the effective DSL
  - Compute the query signature (`core_hash`) exactly as today, ensuring `asat` is excluded
  - Resolve slice set exactly as today (explicit slice or MECE fulfilment set)
  - If `asat` present:
    - Call python “virtual snapshot” read (see 12.4) with:
      - `param_id` (workspace-prefixed)
      - `core_hash` (mandatory for signature validation)
      - `slice_key` (explicit) or slice key set (MECE)
      - `anchor_from` / `anchor_to`
      - `as_at` (ISO datetime derived from the UK token)
    - Convert returned rows to the standard time-series shape
    - Enforce read-only: skip file writes, skip IDB writes, skip snapshot append

- **Frontend client location (Phase 1)**:
  - Add a dedicated client helper alongside the existing snapshot clients:
    - **File**: `graph-editor/src/services/snapshotWriteService.ts`
    - **New function**: `querySnapshotsVirtual(...)` calling `POST /api/snapshots/query-virtual`
  - This avoids introducing a second parallel HTTP client surface unless we explicitly decide to.

#### 12.4 Backend: Virtual snapshot query (requirement #7)

Today, `/api/snapshots/query-full` returns raw rows and is suitable for export/debug. Phase 1 requires a “virtual snapshot” shape:

- **New route** (recommended): `POST /api/snapshots/query-virtual`
  - Purpose: return the virtual snapshot “as of” a given `as_at`
  - Query must:
    - filter by `retrieved_at <= as_at`
    - select the **latest** row per `anchor_day` (and per `slice_key`) within the requested `anchor_from` / `anchor_to` range
    - therefore scope over all incremental retrieval sessions up to `as_at` (not just the last incremental window)
  - Response must include:
    - the virtual snapshot rows
    - `latest_retrieved_at_used` (max `retrieved_at` used by the virtual snapshot)
    - `has_anchor_to` (whether the virtual snapshot contains `anchor_day == anchor_to`)

- **Performance invariant (Phase 1)**:
  - The backend must execute **at most one SQL query per `param_id` per request** (per endpoint call).
  - The SQL must support multiple slices in one query via `slice_key = ANY(%s)` (or equivalent).
  - Explicitly: **do not** execute one query per slice key, or one query per `(param_id × slice_key)`; this would add unacceptable latency.

- **Backend implementation locations (Phase 1)**:
  - HTTP routing:
    - `graph-editor/api/python-api.py` (prod routing)
    - `graph-editor/dev-server.py` (dev routing)
  - Handler:
    - `graph-editor/lib/api_handlers.py` (new `handle_snapshots_query_virtual(...)`)
  - DB query function:
    - `graph-editor/lib/snapshot_service.py` (new `query_virtual_snapshot(...)`)

This supports the warning policy in §6.3 without needing any interpolation or “fill missing days”.

#### 12.5 Warnings (two toasts)

Using the backend metadata from 12.4:

- **Warn A** if `latest_retrieved_at_used < as_at - 24 hours`
- **Warn B** if `has_anchor_to` is false (requested window end not covered)

Do not warn for other missing anchor-day points in the returned series.

#### 12.6 Future UI (not required for Phase 1): snapshot availability by date/time (requirement #6)

When we add dedicated UI, we will need an endpoint that returns the set of available snapshot retrieval times (distinct `retrieved_at`) for a subject so the UI can present an “available snapshots” picker and explain freshness precisely.

The existing `/api/snapshots/inventory` is summary-only (counts/min/max) and is not sufficient for that UI by itself.

When we implement dedicated UI, we should add a bounded endpoint that returns available retrieval times, for example:

- `POST /api/snapshots/retrievals`
  - Inputs: `param_id`, optional `core_hash`, optional `slice_keys`, optional `anchor_from/anchor_to`, optional `limit`
  - Output: distinct `retrieved_at` timestamps (descending), plus a “latest within 24h of as_at” convenience boolean if useful for UI.

### Phase 2: Dedicated `@` UI + “available snapshots” routing

Phase 2 adds a dedicated UX for selecting and clearing the `asat(...)` clause, backed by a python route that returns the set of available snapshot retrieval dates for the **currently effective slice set**.

#### 12.7 Backend: route to return available snapshots (by date/time)

We need a route that returns “what snapshots are available” for the *current* request coordinates. This is distinct from `/api/snapshots/inventory` (summary-only).

- **New route**: `POST /api/snapshots/retrievals`
  - **Purpose**: return a bounded set of available snapshot retrieval timestamps (and/or retrieval days) for the subject currently being edited in the WindowSelector.
  - **Inputs** (minimum viable):
    - `param_id` (workspace-prefixed)
    - `core_hash` (recommended when signature policy is enabled; optional if not)
    - `slice_keys` (must reflect the currently effective contexts; for MECE fulfilment this can be a set)
    - optional `anchor_from` / `anchor_to` (so the calendar can be scoped to the visible window/cohort range)
    - optional `limit` (hard cap for safety)
  - **Output**:
    - `retrieved_at` values (distinct, sorted descending) and/or retrieval “days” derived from those timestamps (for calendar highlighting)
    - include a `latest_retrieved_at` convenience field
  - **Implementation locations**:
    - HTTP routing: `graph-editor/api/python-api.py` and `graph-editor/dev-server.py`
    - Handler: `graph-editor/lib/api_handlers.py`
    - DB query: `graph-editor/lib/snapshot_service.py` (distinct retrieval times; bounded; indexed-friendly)

- **Performance invariant (Phase 2)**:
  - **One SQL query per `param_id`** (per call), returning distinct retrieval times (bounded by `limit`).
  - Never query once per slice to discover retrievals; if slice filtering is needed, filter with `slice_key = ANY(%s)` in a single query.

#### 12.8 Frontend: WindowSelector `@` control (date picker companion)

We add a dedicated icon immediately to the right of the date selector in the WindowSelector.

- **File**: `graph-editor/src/components/WindowSelector.tsx`
- **UI element**: an `@` icon/button (visually treated as a toggle)
  - **Highlighted state**: when `asat` is active in the effective DSL
  - **Opens**: a dropdown (similar interaction model to existing date selection UI), containing a calendar view
  - **Calendar highlighting**:
    - each day is visually highlighted when a snapshot exists for the currently effective coordinates
    - “currently effective coordinates” means:
      - effective `param_id` for the subject
      - effective `slice_keys` derived from current context constraints (including the current selection/MECE policy used by the fetch path)
      - optional `core_hash` if enforced
    - the dropdown retrieves these via `POST /api/snapshots/retrievals`

#### 12.9 Frontend: `@` dropdown behaviours

- **Selecting a date**:
  - adds `asat(<selected date>)` to the effective query (UK date token; `d-MMM-yy`)
  - `@` icon becomes highlighted
  - if the selected `asat` date is **before** the current window/cohort end date, the window/cohort end date is truncated to the selected date.
    - Example: user has `window(1-Nov-25:30-Nov-25)`, clicks `@`, selects `15-Nov-25`
      - resulting query is `window(1-Nov-25:15-Nov-25).asat(15-Nov-25)`
  - The full query remains editable in the extended view of the WindowSelector (no restrictions vs today).

- **Cancel / remove `@` clause**:
  - the dropdown must include a clear “Cancel” / “Remove @” affordance which removes the `asat(...)` clause entirely
  - removing `asat` also removes the highlighted state from `@`
  - **Policy**: do not restore the prior window/cohort end date on removal.
    - Truncation is intentionally one-way: it is rarely meaningful to request an `asat` date that is earlier than the window/cohort upper bound.
    - Removing `asat` therefore only removes the clause; the window/cohort end date remains as currently set.

#### 12.10 Phase 2 tests (high level)

- **Backend**:
  - retrieval list is bounded, stable ordering, and respects the current effective coordinates (`param_id` + `slice_keys` + optional `core_hash` + optional anchor range)
  - query count invariant: one SQL query per `param_id`

- **Frontend**:
  - `@` icon highlights iff `asat(...)` is present
  - calendar highlights days with available snapshots for the currently effective coordinates
  - selecting an `@` date inserts `asat(d-MMM-yy)` and truncates window/cohort end if needed
  - remove action clears `asat` and unhighlights `@` (no restoration of prior end date)
  - extended query editor remains fully editable and round-trips correctly

#### 12.11 Phase 1–2 hardening tests (robustness)

These are “must-have” tests to catch the subtle regressions that are easy to introduce when wiring `asat` through the central fetch path.

- **Date boundary semantics**:
  - `asat(5-Nov-25)` is interpreted as end-of-day for `as_at` (ISO `...T23:59:59Z` per policy), and warning windows are computed relative to that.

- **Order-indifference (real-world constraint mixes)**:
  - `...context(...).asat(...)` and `...asat(...).context(...)` behave identically
  - combinations involving `contextAny`, `visitedAny`, and `minus/plus` still parse and normalise correctly

- **Slice-set correctness**:
  - explicit contexted slice → `slice_keys` contains exactly that slice key
  - uncontexted semantic series fulfilled by MECE → `slice_keys` is the MECE set (not empty, and not one-by-one queries)

- **Virtual snapshot row-shape guard**:
  - `query-virtual` returns at most one row per `(anchor_day, slice_key)` (catches regressions back to “raw rows”)

- **Warning correctness (no noisy UX)**:
  - Warn A triggers only when `latest_retrieved_at_used < as_at - 24h`
  - Warn B triggers only when `anchor_to` is not covered
  - internal gaps in daily series do not produce warnings

- **Read-only invariants**:
  - `asat` fetch produces no file writes, no IDB writes, and no snapshot append writes

---

## 13. Testing Requirements

### 13.1 Unit Tests

| Test | Description |
|------|-------------|
| `asat_parsing_typescript` | Parse `asat(15-Oct-25)` and `at(15-Oct-25)` correctly |
| `asat_parsing_python` | Parse asat/at in Python (only if Python-side parsing is required) |
| `asat_excluded_from_signature` | core_hash unchanged with/without asat |
| `asat_dsl_roundtrip` | Parse → normalise → canonical `asat(...)` |

### 13.2 Integration Tests

| Test | Description |
|------|-------------|
| `asat_returns_historical` | Query with asat returns virtual snapshot with `retrieved_at <= as_at` |
| `asat_latest_per_anchor` | Multiple retrieval sessions → latest-per-anchor_day as-of asat |
| `asat_no_data` | asat before any snapshots → graceful error |
| `asat_signature_mismatch` | Data exists but different hash → clear error |
| `asat_no_side_effects` | Historical query → no file writes, no DB writes |

### 13.3 E2E Tests

| Test | Description |
|------|-------------|
| `asat_ui_toggle` | (Future UI) Enable asat mode via dedicated UI |
| `asat_scenario_badge` | (Future UI) Scenario shows asat visual indicator |
| `asat_regeneration_disabled` | (If enforced) Cannot regenerate asat scenario |
| `asat_shape_matches_live` | Result shape identical to live query |

### 13.4 Test File Locations

| File | Contents |
|------|----------|
| `src/lib/__tests__/queryDSL.asat.test.ts` | TypeScript parsing |
| `lib/tests/test_query_dsl_asat.py` | Python parsing (if needed) |
| `src/services/__tests__/dataOperations.asat.test.ts` | Fork logic |
| `lib/tests/test_snapshot_handlers.py` | Python endpoint tests (add asat cases) |

---

## 14. Schema Implications

**No schema changes required.**

The existing schema supports `asat` queries:
- `retrieved_at` is already stored per row
- Query filters by `retrieved_at <= as_at`
- `ROW_NUMBER()` window function selects latest-as-of

---

## 14A. Graph Evolution and Signature Validity

### 14A.1 The Problem

User creates a new branch with modified graph pathways:
- Some historic signatures remain valid
- Others are invalidated by query changes

### 14A.2 V1 Decision: Use Current Graph

For V1, `asAt` queries compute signatures using the **current** graph definition:

- **Pros:** Simple; no Git integration needed
- **Cons:** Historical data inaccessible if query changed

### 14A.3 Error Handling

If current signature doesn't match stored data:

```
"Historical data exists but query configuration has changed.
Snapshots were stored with a different query definition."
```

### 14A.4 Future: Historical Graph Retrieval (V2+)

Options for future versions:

1. **Signature history table:** Map dates to valid signatures
2. **Git-based graph retrieval:** Load graph definition from Git at asAt date
3. **Store graph definition with snapshots:** Include query definition in DB

Deferred due to complexity.

---

## 15. File Impact Analysis

### 15.1 DSL Parsing (CRITICAL - affects many downstream files)

| File | Current Behaviour | Required Change |
|------|-------------------|-----------------|
| `graph-editor/src/lib/queryDSL.ts` | No asAt function | Add to `QUERY_FUNCTIONS`, `ParsedConstraints`, `parseConstraints()`, `normalizeConstraintString()`, `augmentDSLWithConstraint()` |
| `graph-editor/lib/query_dsl.py` | No asAt function | Add to `ParsedQuery`, `parse_query()`, `_extract_as_at()` |

### 15.2 Scenario Composition

| File | Current Behaviour | Required Change |
|------|-------------------|-----------------|
| `graph-editor/src/services/scenarioRegenerationService.ts` | `FetchParts` has window/cohort | Add `asAt` field, update `splitDSLParts()`, `buildFetchDSL()` |
| `graph-editor/src/contexts/ScenariosContext.tsx` | Regenerates from Amplitude | Detect asAt in scenario DSL, skip regeneration for asAt scenarios |
| `graph-editor/src/components/panels/ScenariosPanel.tsx` | All scenarios regenerable | Show asAt badge, disable regeneration button for asAt scenarios |

### 15.3 WindowSelector UI

| File | Current Behaviour | Required Change |
|------|-------------------|-----------------|
| `graph-editor/src/components/WindowSelector.tsx` | `queryMode: 'cohort' \| 'window'` | Add `'asAt'` mode, date picker, DSL construction with asAt |
| `graph-editor/src/contexts/GraphStoreContext.tsx` | No asAt state | May need to track asAt state if persisted to graph |

### 15.4 Data Operations Fork

| File | Current Behaviour | Required Change |
|------|-------------------|-----------------|
| `graph-editor/src/services/dataOperationsService.ts` | Always calls DAS | Detect asAt in DSL, fork to DB query before DAS execution (~line 5910) |
| `graph-editor/src/lib/graphComputeClient.ts` | No querySnapshots | Add `querySnapshots()` method for asAt DB retrieval |
| `graph-editor/lib/snapshot_service.py` | Phase 1-2 handlers | Add `query_snapshots_asat()` with signature validation |

### 15.5 Files That Import queryDSL (Review Required)

These files import from `queryDSL.ts` and use `ParsedConstraints`. **Review each to ensure asAt field is handled or ignored as appropriate.**

#### Services (High Priority - Core Logic)

| File | Uses | Impact |
|------|------|--------|
| `src/services/dataOperationsService.ts` | `parseConstraints` | **MODIFY**: Detect asAt for DB fork |
| `src/services/scenarioRegenerationService.ts` | `parseConstraints`, `augmentDSLWithConstraint` | **MODIFY**: Handle asAt in composition |
| `src/services/windowAggregationService.ts` | `parseConstraints` | Review: May ignore asAt (aggregation doesn't change) |
| `src/services/fetchDataService.ts` | `parseConstraints` | Review: Orchestrates fetch, may need asAt awareness |
| `src/services/fetchOrchestratorService.ts` | `parseConstraints` | Review: May ignore asAt |
| `src/services/windowFetchPlannerService.ts` | `parseConstraints` | Review: Planner may need asAt awareness |
| `src/services/fetchPlanBuilderService.ts` | `parseConstraints` | Review: Plan building may ignore asAt |
| `src/services/meceSliceService.ts` | `parseConstraints` | Review: MECE resolution may ignore asAt |
| `src/services/sliceIsolation.ts` | `parseConstraints` | Review: Slice isolation may ignore asAt |
| `src/services/querySignatureService.ts` | `parseConstraints` | **CRITICAL**: Signature computation - asAt should NOT affect signature |
| `src/services/contextAggregationService.ts` | `parseConstraints` | Review: May ignore asAt |
| `src/services/slicePlanValidationService.ts` | `parseConstraints` | Review: Validation may ignore asAt |
| `src/services/contextRegistry.ts` | `parseConstraints` | Review: Context extraction may ignore asAt |
| `src/services/dimensionalReductionService.ts` | `parseConstraints` | Review: May ignore asAt |
| `src/services/retrieveAllSlicesService.ts` | `parseConstraints` | Review: Bulk retrieval may ignore asAt |
| `src/services/lagHorizonsService.ts` | `parseConstraints` | Review: May ignore asAt |
| `src/services/plannerQuerySignatureService.ts` | `parseConstraints` | Review: May ignore asAt |
| `src/services/variableAggregationCache.ts` | `parseConstraints` | Review: Cache key may ignore asAt |

#### Libraries

| File | Uses | Impact |
|------|------|--------|
| `src/lib/dslDynamics.ts` | `parseConstraints` | Review: Dynamic DSL may ignore asAt |
| `src/lib/dslExplosion.ts` | `parseConstraints` | Review: Explosion may ignore asAt |
| `src/lib/whatIf.ts` | `parseConstraints` | Review: What-if may ignore asAt |
| `src/lib/graphPruning.ts` | `parseConstraints` | Review: Pruning may ignore asAt |
| `src/lib/conditionalReferences.ts` | `parseConstraints` | Review: May ignore asAt |
| `src/lib/das/buildDslFromEdge.ts` | `parseConstraints` | Review: DSL building may ignore asAt |
| `src/lib/das/compositeQueryParser.ts` | `parseConstraints` | Review: Composite parsing may ignore asAt |
| `src/lib/das/buildDataQuerySpec.ts` | `parseConstraints` | Review: Query spec may ignore asAt |

#### Components

| File | Uses | Impact |
|------|------|--------|
| `src/components/WindowSelector.tsx` | `parseConstraints` | **MODIFY**: Add asAt mode UI |
| `src/components/QueryExpressionEditor.tsx` | `parseConstraints` | Review: May need asAt autocomplete |
| `src/components/WhatIfAnalysisControl.tsx` | `parseConstraints` | Review: May ignore asAt |
| `src/components/PropertiesPanel.tsx` | `parseConstraints` | Review: May display asAt info |
| `src/components/panels/ScenariosPanel.tsx` | `parseConstraints` | **MODIFY**: Show asAt badge |
| `src/components/edges/ConversionEdge.tsx` | `parseConstraints` | Review: May show snapshot availability |
| `src/components/modals/PinnedQueryModal.tsx` | `parseConstraints` | Review: May ignore asAt |

#### Contexts

| File | Uses | Impact |
|------|------|--------|
| `src/contexts/GraphStoreContext.tsx` | `parseConstraints` | Review: State management |
| `src/contexts/ScenariosContext.tsx` | `parseConstraints` | **MODIFY**: Handle asAt scenarios |

### 15.6 Python Files

| File | Uses | Impact |
|------|------|--------|
| `lib/query_dsl.py` | Defines `ParsedQuery` | **MODIFY**: Add `as_at` field |
| `lib/api_handlers.py` | `handle_runner_analyze` | **MODIFY**: Add asAt query handling |
| `lib/snapshot_service.py` | DB operations | **MODIFY**: Add `query_snapshots_asat()` |
| `lib/graph_select.py` | `parse_query` | Review: Selection may ignore asAt |
| `lib/graph_types.py` | Types | Review: May need asAt type |
| `lib/runner/analyzer.py` | `parse_query` | Review: Analysis may ignore asAt |

---

## 16. Signature Computation — asAt Exclusion

**CRITICAL:** `asAt` MUST NOT affect query signature.

The signature identifies the **query semantics** (from/to/visited/context/etc.), not the retrieval mode.

```typescript
// In querySignatureService.ts → computeQuerySignature()

// asAt is NOT included in coreCanonical:
const coreCanonical = JSON.stringify({
  connection: connectionName || '',
  from_event_id: from_event_id || '',
  to_event_id: to_event_id || '',
  visited_event_ids: visited_event_ids.sort(),
  exclude_event_ids: exclude_event_ids.sort(),
  event_def_hashes: eventDefHashes,
  event_filters: queryPayload.event_filters || {},
  case: (queryPayload.case || []).sort(),
  cohort_mode: !!queryPayload.cohort,
  cohort_anchor_event_id: queryPayload?.cohort?.anchor_event_id || '',
  latency_parameter: edgeLatency?.latency_parameter === true,
  latency_anchor_event_id: latencyAnchorEventId,
  original_query: normalizedOriginalQuery,
  // NO asAt here — asAt changes retrieval source, not query semantics
});
```

This ensures:
- Historical data with same query definition has matching signature
- asAt queries can retrieve data stored by live queries
- Signature mismatch indicates actual query change, not just asAt toggle

---

## 17. Code Path Traces

### 17.1 asAt Path: Historical Query Fork

```
User sets asAt date in WindowSelector
    ↓
WindowSelector.tsx
    └── setQueryMode('asAt')
    └── setAsAtDate('2025-12-01')
    └── buildDSL() → "cohort(...).asAt(1-Dec-25)"
    └── setCurrentDSL()
    ↓
User triggers fetch (or scenario regeneration)
    ↓
dataOperationsService.ts → getFromSourceDirect()
    │
    ├── [LINE ~4850] Parse DSL
    │   └── queryDSL.ts → parseConstraints()
    │       └── Extract asAt: "1-Dec-25"
    │
    ├── [NEW: ~LINE 5900] asAt DETECTION
    │   │
    │   └── IF asAt is set:
    │       │
    │       ├── Build DB query params
    │       │   └── snapshotQueryService.ts → buildSnapshotQuery()
    │       │
    │       ├── Call Python endpoint
    │       │   └── graphComputeClient.ts → querySnapshots()
    │       │       └── HTTP POST /api/snapshots/query
    │       │           └── snapshot_service.py → query_snapshots_asat()
    │       │               └── psycopg2 SELECT with retrieved_at <= asAt
    │       │
    │       ├── Validate signature match
    │       │   └── IF no match → throw Error("Query configuration changed")
    │       │
    │       ├── Convert to time-series format
    │       │   └── Same shape as DAS response
    │       │
    │       └── SKIP DAS execution, SKIP file write
    │
    └── ELSE: Normal DAS execution path
```

### 17.2 Scenario Composition with asAt

```
User creates scenario with queryDSL: "asAt(1-Dec-25)"
    ↓
ScenariosContext.tsx → createLiveScenario()
    └── scenario.meta.queryDSL = "asAt(1-Dec-25)"
    ↓
User makes scenario visible
    ↓
ScenariosContext.tsx → regenerateScenario()
    │
    ├── scenarioRegenerationService.ts → splitDSLParts()
    │   └── Extract: fetchParts.asAt = "1-Dec-25"
    │
    ├── computeInheritedDSL()
    │   └── baseDSL + lower scenarios → "cohort(-30d:)"
    │
    ├── computeEffectiveFetchDSL()
    │   └── inherited + scenario → "cohort(-30d:).asAt(1-Dec-25)"
    │
    └── dataOperationsService.ts → getFromSourceDirect()
        └── asAt detected → DB query path (not Amplitude)
```

---

## 18. Test Files to Update

| Test File | Scope | Updates Needed |
|-----------|-------|----------------|
| `src/lib/__tests__/queryDSL.test.ts` | DSL parsing | Add asat/at parsing + normalisation tests |
| `src/components/__tests__/QueryExpressionEditor.test.tsx` | Monaco editor | Ensure `asat(...)` / `at(...)` are recognised (chips/diagnostics) |
| `src/services/__tests__/dataOperationsService.integration.test.ts` | Data ops | Add asat fork tests (read-only; no DAS; no writes) |
| `lib/tests/test_snapshot_read_integrity.py` (or similar existing suite) | Python | Add tests for `query-virtual` latest-per-anchor_day-as-of |
| `e2e/*` | UI | Phase 2 `@` UI behaviour (calendar highlight + truncate + remove) |

---

## 19. Completion Checklist

| Item | Status | Date | Notes |
|------|--------|------|-------|
| `queryDSL.ts`: asat/at parsing + canonical normalisation | `[ ]` | | |
| `QueryExpressionEditor.tsx`: chips/diagnostics recognise asat/at | `[ ]` | | |
| `snapshotWriteService.ts`: `querySnapshotsVirtual(...)` client | `[ ]` | | |
| Python: `POST /api/snapshots/query-virtual` implemented | `[ ]` | | latest-per-anchor_day-as-of + metadata |
| `dataOperationsService.ts`: asat fork (DB virtual snapshot, read-only) | `[ ]` | | no writes (files/IDB/DB append) |
| Warning A (no snapshot within 24h) wired to toast | `[ ]` | | uses `latest_retrieved_at_used` |
| Warning B (missing anchor_to) wired to toast | `[ ]` | | based on `has_anchor_to` |
| Phase 2: `POST /api/snapshots/retrievals` implemented | `[ ]` | | distinct retrieval times for highlighting |
| Phase 2: WindowSelector `@` calendar + truncate + remove | `[ ]` | | one-way truncation; removal does not restore |
| Unit/integration tests updated and passing | `[ ]` | | see §13 + §18 |
| User docs updated (`asat`, `at`, `@` UI) | `[ ]` | | see §20 |

---

## 20. Documentation Updates

### 20.1 User Documentation

**File:** `graph-editor/public/docs/user-guide.md`

Add new section: "Viewing Historical Data (`asat` / `@`)" with examples

### 20.2 Query Reference

**File:** `graph-editor/public/docs/query-expressions.md`

- Add `asat(date)` function documentation with syntax and examples
- Document `at(date)` as sugar (canonical normalisation is `asat`)
- Add "Historical Queries" section explaining signature validation

### 20.3 API Reference

**File:** `graph-editor/public/docs/api-reference.md`

- Add `/api/snapshots/query-virtual` endpoint documentation (virtual snapshot as-of)
- Add `/api/snapshots/retrievals` endpoint documentation (available snapshots by retrieval time)

### 20.4 CHANGELOG

**File:** `graph-editor/public/docs/CHANGELOG.md`

Add entry: "Added: Historical queries via `asat()` (`@` selector UI in Phase 2)"

---

## 21. References

- [Snapshot DB Design](./00-snapshot-db-design.md) — §19
- [Implementation Plan](./implementation-plan.md) — Phases 0-3
- [Query Expressions Docs](../../graph-editor/public/docs/query-expressions.md) — DSL reference
