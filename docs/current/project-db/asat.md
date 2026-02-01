# Historical Query Mode: `asAt()` — Design and Implementation

**Status**: Phase 4 (Deferred until Phases 1-3 complete)  
**Prerequisite**: Snapshot write/read path working  
**Date**: 1-Feb-26

---

## 1. Overview

The `asAt()` DSL extension enables **historical queries** — viewing conversion data "as it was known at a specific past date" rather than the current state.

**Example:**
```
from(A).to(B).window(1-Oct-25:31-Oct-25).asAt(15-Oct-25)
```

**Semantics:** Return time-series data for the window, but **as it would have appeared on 15-Oct-25** — i.e., retrieve from the snapshot DB with `retrieved_at <= 15-Oct-25`, not from Amplitude.

---

## 2. Use Cases

| Use Case | DSL Example | Business Value |
|----------|-------------|----------------|
| **Audit trail** | `.asAt(1-Nov-25)` | "What did the dashboard show on 1-Nov?" |
| **Debugging** | `.asAt(report_date)` | "Why did the report show X on that day?" |
| **Trend analysis** | Compare `.asAt(T1)` vs `.asAt(T2)` | "How did our view evolve?" |
| **Immature cohort replay** | `.asAt(cohort_date + 7d)` | "What did we know after 1 week?" |
| **Scenario comparison** | Live vs asAt(T) side-by-side | "How much has our view changed?" |

---

## 3. Core Principles

### 3.1 `asAt` is a Retrieval Filter, Not a Query Identity

```
from(A).to(B).window(1-Oct:31-Oct)              → core_hash = abc123
from(A).to(B).window(1-Oct:31-Oct).asAt(15-Oct) → core_hash = abc123 (SAME)
```

The `asAt` date filters **which snapshots to return**, not **what the query means**.

### 3.2 Signature Validation is MANDATORY

Before returning historical data, we MUST verify the computed `core_hash` matches stored data:

1. **Query definitions evolve** — event filters may have changed
2. **Safety** — returning data for a different query would be silently wrong
3. **Semantic consistency** — only return data that answers the *same* question

### 3.3 Historical Queries are Read-Only

| Query Type | File Cache | Memory Cache | DB |
|------------|------------|--------------|-----|
| Live (no asAt) | Write | Write | Shadow-write |
| Historical (asAt) | **Read-only** | **Read-only** | **Read-only** |

No writes to files, IndexedDB, or snapshot DB for `asAt` queries.

### 3.4 Uses Current Graph for Signature

For V1, `asAt` queries compute signatures using the **current** graph definition:

- If query definition has changed since snapshots were stored → signature mismatch
- Clear error message: "Query configuration has changed since snapshots were stored"
- Historical graph retrieval is deferred (complex; requires Git integration)

---

## 4. Data Flow

### 4.1 Without `asAt` (Current Behaviour)

```
DSL: from(A).to(B).window(1-Oct:31-Oct)
    → Fetch from Amplitude (live data)
    → Write to file + shadow-write to DB
    → Return current state
```

### 4.2 With `asAt` (New Behaviour)

```
DSL: from(A).to(B).window(1-Oct:31-Oct).asAt(15-Oct-25)
    → Parse DSL, extract asAt date
    → Compute signature (same as live query)
    → Query DB: WHERE core_hash = %s AND retrieved_at <= '2025-10-15'
    → Return most recent snapshot per anchor_day as of that date
    → NO write to file, NO shadow-write to DB (read-only)
```

### 4.3 Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SIGNATURE-VALIDATED HISTORICAL QUERY                                         │
│                                                                              │
│   1. Parse DSL: from(A).to(B).window(1-Oct:31-Oct).asAt(15-Oct)             │
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
│   4. If rows found → return time-series                                     │
│   5. If no rows → "No historical data matching current query configuration" │
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
| **Full coverage** | `window(1-Oct:31-Oct).asAt(15-Nov)` with daily snapshots → One row per anchor_day |
| **Partial coverage** | `asAt(15-Oct)` but snapshots started 10-Oct → Rows only for available dates |
| **No coverage** | `asAt(9-Oct)` but snapshots started 10-Oct → Empty result |
| **Sparse snapshots** | `asAt(15-Oct)` with snapshots on 10th, 12th, 15th → Most recent per anchor ≤ 15-Oct |

### 5.3 Edge Cases

| Edge Case | Handling |
|-----------|----------|
| asAt date before first snapshot | Error: "No data as of {date}" |
| asAt date in future | Behave as live query (use latest available) |
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
    newestSnapshot: string;  // latest retrieved_at (≤ asAt)
  };
  warnings?: string[];  // e.g., "Partial coverage: 25/31 days"
}
```

---

## 7. DB Query

```sql
-- Get most recent snapshot per anchor_day as of the asAt date
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

Returns **one row per anchor_day** — the most recent snapshot as of the `asAt` date.

---

## 8. Implementation: File-by-File Trace

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

### Phase 4A: Core DSL Support (1 day)

- [ ] Update `queryDSL.ts`: QUERY_FUNCTIONS, ParsedConstraints, parseConstraints()
- [ ] Update `query_dsl.py`: ParsedQuery, parse_query()
- [ ] Unit tests for DSL parsing

### Phase 4B: Python Endpoint (0.5 day)

- [ ] Add `/api/snapshots/query` endpoint
- [ ] Integration tests with test DB

### Phase 4C: Data Operations Fork (1 day)

- [ ] Add `querySnapshots()` to graphComputeClient
- [ ] Implement fork in `getFromSourceDirect()`
- [ ] Verify signature exclusion
- [ ] Integration tests

### Phase 4D: UI Integration (0.5 day)

- [ ] Add asAt mode to WindowSelector
- [ ] Add visual indicators to ScenariosPanel
- [ ] E2E tests

### Phase 4E: Scenario Composition (0.5 day)

- [ ] Update FetchParts and related functions
- [ ] Test scenario inheritance with asAt

### Phase 4F: Documentation (0.5 day)

- [ ] Update user-guide.md
- [ ] Update query-expressions.md
- [ ] Add CHANGELOG entry

**Total: 4 days**

---

## 13. Testing Requirements

### 13.1 Unit Tests

| Test | Description |
|------|-------------|
| `asAt_parsing_typescript` | Parse `asAt(15-Oct-25)` correctly |
| `asAt_parsing_python` | Parse asAt in Python |
| `asAt_excluded_from_signature` | core_hash unchanged with/without asAt |
| `asAt_dsl_roundtrip` | Parse → normalize → same DSL |

### 13.2 Integration Tests

| Test | Description |
|------|-------------|
| `asAt_returns_historical` | Query with asAt returns snapshot with `retrieved_at <= asAt` |
| `asAt_latest_per_anchor` | Multiple snapshots per anchor_day → returns most recent as of asAt |
| `asAt_no_data` | asAt before any snapshots → graceful error |
| `asAt_signature_mismatch` | Data exists but different hash → clear error |
| `asAt_no_side_effects` | Historical query → no file writes, no DB writes |

### 13.3 E2E Tests

| Test | Description |
|------|-------------|
| `asAt_ui_toggle` | Enable asAt mode in WindowSelector |
| `asAt_scenario_badge` | asAt scenario shows visual indicator |
| `asAt_regeneration_disabled` | Cannot regenerate asAt scenario |
| `asAt_shape_matches_live` | Result shape identical to live query |

### 13.4 Test File Locations

| File | Contents |
|------|----------|
| `src/lib/__tests__/queryDSL.asAt.test.ts` | TypeScript parsing |
| `lib/tests/test_query_dsl_asat.py` | Python parsing |
| `src/services/__tests__/dataOperations.asAt.test.ts` | Fork logic |
| `lib/tests/test_snapshot_handlers.py` | Python endpoint tests (add asAt cases) |

---

## 14. Schema Implications

**No schema changes required.**

The existing schema supports `asAt` queries:
- `retrieved_at` is already stored per row
- Query filters by `retrieved_at <= asAt_date`
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

## 15. References

- [Snapshot DB Design](./snapshot-db-design.md) — §19
- [Implementation Plan](./implementation-plan.md) — Phase 4
- [Query Expressions Docs](../../graph-editor/public/docs/query-expressions.md) — DSL reference
