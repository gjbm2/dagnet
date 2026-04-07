# Snapshot DB: Architecture and Data Model

**Source**: `docs/current/project-db/completed/00-snapshot-db-design.md`
**Last reviewed**: 17-Mar-26

---

## 1. Objectives

The snapshot DB enables two classes of analysis:

1. **Snapshot-history-derived attribution** (requires longitudinal snapshot history):
   - Conversion lag histogram (empirical): distribution of lag from ΔY between successive snapshots
   - Calendar-day attributed conversions: attributed to `retrieved_at` UTC day

2. **Single-snapshot, maturity-aware views** (available immediately from latest time-series):
   - Anchor-day series: conversions Y by `anchor_day`
   - Evidence + forecast delta: split into observed evidence vs expected "late arrivals" using latency model

---

## 2. Core Architectural Principle

> **Frontend does ALL logical resolution. Python is told what to retrieve and derives the result.**

| Layer | Responsibility |
|-------|----------------|
| **Frontend (TypeScript)** | DSL parsing, signature computation, slice resolution, MECE verification, date coverage analysis, segment construction |
| **Backend (Python)** | DB query execution, MECE aggregation (sum), histogram/daily derivation |
| **Database (Postgres)** | Append-only snapshot storage, indexed by signature + slice + date |

---

## 3. Data Model

### Single Table Design

One table serves ALL parameters from ALL workspaces. Workspace isolation via `param_id` prefix (`repo-branch-edge.p.id`). Signature-based sharing within a workspace is correct behaviour.

### DB Schema

```sql
CREATE TABLE snapshots (
    param_id            TEXT NOT NULL,
    core_hash           TEXT NOT NULL,
    context_def_hashes  TEXT,               -- JSON object (V1: not in PK)
    slice_key           TEXT NOT NULL,
    anchor_day          DATE NOT NULL,
    retrieved_at        TIMESTAMPTZ NOT NULL,   -- UTC
    A                   INTEGER,    -- Anchor entrants (cohort; null for window)
    X                   INTEGER,    -- From-step count
    Y                   INTEGER,    -- To-step count (conversions)
    median_lag_days         REAL,
    mean_lag_days           REAL,
    anchor_median_lag_days  REAL,
    anchor_mean_lag_days    REAL,
    onset_delta_days        REAL,
    PRIMARY KEY (param_id, core_hash, slice_key, anchor_day, retrieved_at)
);
```

**14 columns**: 5 PK + 1 audit + 3 counts + 5 latency.

### Timestamp Semantics

- Storage: `TIMESTAMPTZ` (Postgres stores as UTC)
- Write: ISO 8601 with Z suffix from frontend
- Read for derivation: `(retrieved_at AT TIME ZONE 'UTC')::DATE`
- Display: convert to `d-MMM-yy` format

---

## 4. Virtual Snapshot Reconstruction

**Critical concept:** We do NOT store complete snapshots every day. We store **partial fetches** (the "gap" data) and reconstruct complete views on demand.

### Partial Fetch Pattern

Typical daily fetch: DSL says `cohort(-100d:)` but we only FETCH ~14 days (the "gap" — data likely to change due to latency). Older anchor_days are mature and stable.

### Reconstructing a Virtual Snapshot

To answer "what did we know on date X about the full cohort range?":

```sql
WITH ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY anchor_day
      ORDER BY retrieved_at DESC
    ) AS rn
  FROM snapshots
  WHERE param_id = %s AND core_hash = %s
    AND anchor_day BETWEEN %s AND %s  -- full cohort range
    AND retrieved_at <= %s            -- target date X
)
SELECT * FROM ranked WHERE rn = 1
```

Returns one row per anchor_day — the latest snapshot as of date X.

### Two Query Modes

| Mode | Returns | Used by |
|------|---------|---------|
| **Raw snapshots** | Multiple rows per anchor_day (full history) | Lag histogram, calendar-day attribution |
| **Virtual snapshot** | One row per anchor_day (latest as of X) | Anchor-day series, `asAt(date)` queries |

---

## 5. Cold Start and Graceful Coverage

**Principle:** Do the best we can with available data. Only show gaps where data truly cannot be inferred.

- **Mature cohorts** (age > t95): current file data IS the final truth — no snapshots needed
- **Non-latency edges**: current data IS final (lag ≈ 0)
- **Immature cohorts without snapshots**: marked as gap, coverage message shown to user

Coverage improves over time as snapshots accumulate.

---

## 6. Signature System

`core_hash` is the short content-address of the canonical `query_signature` string. Same value computed by `computeQuerySignature()` in TypeScript and `computeShortCoreHash()` in `coreHashService.ts`.

For the full signature architecture (registry, equivalence links, families), see `SNAPSHOT_DB_SIGNATURES.md`.

For context-epoch handling (regime-safe cohort maturity), see `SNAPSHOT_DB_CONTEXT_EPOCHS.md`.

---

## 7. Key Source Locations

**Frontend:**
- `src/services/snapshotWriteService.ts` — append, inventory, retrieval calendar
- `src/services/snapshotDependencyPlanService.ts` — fetch plan → snapshot subjects
- `src/services/coreHashService.ts` — `computeShortCoreHash()`
- `src/lib/graphComputeClient.ts` — analysis request/response handling

**Backend:**
- `lib/snapshot_service.py` — all DB operations (append, query-virtual, query-full, retrievals, inventory, equivalence) plus module-level connection pool and TTL result cache
- `lib/api_handlers.py` — API route handlers

## 8. Connection Pooling and Result Cache

Added 7-Apr-26. All DB operations go through a module-level `psycopg2` connection pool and a 15-minute TTL result cache, both scoped to a single Vercel function instance. See `PYTHON_BACKEND_ARCHITECTURE.md` § "Connection Pooling and Result Cache" for full details.

Key points:
- All read functions are cached; write functions (`append_snapshots`, `delete_snapshots`) clear the entire cache after successful commit.
- Vercel has no sticky routing — each instance has its own isolated cache. Fluid Compute (enabled by default) maximises reuse of a single instance for concurrent requests.
- Explicit cache bust via `/api/cache/clear` for dev/testing. FE does not need to trigger cache busting in normal workflows.
