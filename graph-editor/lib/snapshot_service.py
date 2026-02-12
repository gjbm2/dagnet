"""
Snapshot DB Service

Handles all database operations for the snapshot feature.
Provides shadow-write capability to persist time-series data to Neon PostgreSQL.

Design reference: docs/current/project-db/snapshot-db-design.md
"""

import os
import json
import hashlib
import base64
import psycopg2
from psycopg2.extras import execute_values
from typing import List, Dict, Any, Optional
from datetime import date, datetime, timedelta
import re

from slice_key_normalisation import normalise_slice_key_for_matching


def get_db_connection():
    """
    Get database connection from environment.
    
    Uses DB_CONNECTION env var which should contain a full PostgreSQL connection string.
    For Neon, this typically looks like:
    postgresql://user:password@host/database?sslmode=require
    """
    conn_string = os.environ.get('DB_CONNECTION')
    if not conn_string:
        raise ValueError("DB_CONNECTION environment variable not set")
    return psycopg2.connect(conn_string)


def short_core_hash_from_canonical_signature(canonical_signature: str) -> str:
    """
    TEST-ONLY. Compute core_hash from canonical_signature.

    The frontend is the sole producer of core_hash in production (hash-fixes.md).
    This function is retained ONLY for:
    - Golden parity tests (test_core_hash_parity.py)
    - Test helpers that need to compute expected hashes
    - Legacy test-compat fallback in append_snapshots()

    DO NOT call this from production code paths.

    Algorithm (must match coreHashService.ts):
    - sha256(UTF-8 bytes of canonical_signature.strip())
    - take first 16 bytes (128 bits)
    - base64url encode (no padding) -> ~22 chars
    """
    if canonical_signature is None:
        raise ValueError("canonical_signature is required")
    if not isinstance(canonical_signature, str):
        raise ValueError("canonical_signature must be a string")
    sig = canonical_signature.strip()
    if sig == "":
        raise ValueError("canonical_signature must be non-empty")
    digest = hashlib.sha256(sig.encode("utf-8")).digest()[:16]
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _ensure_flexi_sig_tables(cur) -> None:
    """
    Ensure flexi-sigs tables exist.

    This is intentionally lazy (on demand) so local dev + integration tests
    do not require a separate migration step.
    """
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS signature_registry (
          param_id                TEXT NOT NULL,
          core_hash               TEXT NOT NULL,
          canonical_signature     TEXT NOT NULL,
          inputs_json             JSONB NOT NULL,
          canonical_sig_hash_full TEXT NOT NULL,
          sig_algo                TEXT NOT NULL,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (param_id, core_hash)
        )
        """
    )
    cur.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_sigreg_param_created
          ON signature_registry (param_id, created_at DESC)
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS signature_equivalence (
          param_id       TEXT NOT NULL,
          core_hash      TEXT NOT NULL,
          equivalent_to  TEXT NOT NULL,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by     TEXT,
          reason         TEXT,
          active         BOOLEAN NOT NULL DEFAULT true,
          operation      TEXT NOT NULL DEFAULT 'equivalent',
          weight         DOUBLE PRECISION DEFAULT 1.0,
          source_param_id TEXT,
          UNIQUE (param_id, core_hash, equivalent_to)
        )
        """
    )
    cur.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_sigeq_param_active
          ON signature_equivalence (param_id, created_at DESC)
        """
    )

    # ── Schema migration: add columns if missing (idempotent) ────────────
    for col, typedef in [
        ("operation", "TEXT NOT NULL DEFAULT 'equivalent'"),
        ("weight", "DOUBLE PRECISION DEFAULT 1.0"),
        ("source_param_id", "TEXT"),
    ]:
        try:
            cur.execute(
                f"""
                ALTER TABLE signature_equivalence
                  ADD COLUMN IF NOT EXISTS {col} {typedef}
                """
            )
        except Exception:
            pass  # Column already exists or not supported — safe to ignore

    # Extended unique index including source_param_id for cross-param transforms
    cur.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sigeq_unique_v2
          ON signature_equivalence (param_id, core_hash, equivalent_to, COALESCE(source_param_id, param_id))
        """
    )


def _require_core_hash(core_hash: Optional[str], context: str = "") -> str:
    """
    Require frontend-provided core_hash. The backend NEVER derives hashes.

    See hash-fixes.md: frontend is the sole producer of core_hash.
    """
    if core_hash and isinstance(core_hash, str) and core_hash.strip():
        return core_hash.strip()
    raise ValueError(f"core_hash is required (frontend must provide it) ({context})")


def append_snapshots(
    param_id: str,
    canonical_signature: str,
    inputs_json: Dict[str, Any],
    sig_algo: str,
    slice_key: str,
    retrieved_at: datetime,
    rows: List[Dict[str, Any]],
    diagnostic: bool = False,
    core_hash: Optional[str] = None,  # Required in production; Optional only for test compat
) -> Dict[str, Any]:
    """
    Append snapshot rows to the database.
    
    This is the primary write operation for shadow-writing time-series data
    after successful fetches from Amplitude or other data sources.
    
    Args:
        param_id: Workspace-prefixed parameter ID (e.g., 'repo-branch-param-id')
        canonical_signature: Canonical semantic signature string (frontend `query_signature`)
        inputs_json: Minimal evidence blob for audit + diff UI
        sig_algo: Signature algorithm identifier (e.g. "sig_v1_sha256_trunc128_b64url")
        slice_key: Context slice DSL or '' for uncontexted
        retrieved_at: Timestamp of data retrieval (UTC)
        rows: List of daily data points, each containing:
            - anchor_day: ISO date string (required)
            - A: Anchor entrants (optional, null for window mode)
            - X: From-step count (optional)
            - Y: To-step count / conversions (optional)
            - median_lag_days: Median conversion lag (optional)
            - mean_lag_days: Mean conversion lag (optional)
            - anchor_median_lag_days: Anchor-relative median lag (optional)
            - anchor_mean_lag_days: Anchor-relative mean lag (optional)
            - onset_delta_days: Onset delay from histogram (optional)
        diagnostic: If True, return detailed diagnostic info about the operation
    
    Returns:
        Dict with:
            - success: bool
            - inserted: int (rows inserted, excludes duplicates)
            - diagnostic: dict (only if diagnostic=True) containing:
                - rows_attempted: int
                - sql_time_ms: float
                - date_range: str (first to last anchor_day)
                - has_latency: bool (whether any latency columns populated)
                - has_anchor: bool (whether A column populated - cohort mode)
    
    Example:
        >>> rows = [
        ...     {'anchor_day': '2025-12-01', 'X': 100, 'Y': 15, 'median_lag_days': 5.2},
        ...     {'anchor_day': '2025-12-02', 'X': 110, 'Y': 17, 'median_lag_days': 5.1},
        ... ]
        >>> result = append_snapshots('repo-main-my-param', '{"c":"...","x":{}}', {}, 'sig_v1_sha256_trunc128_b64url', '', now, rows, diagnostic=True)
        >>> print(result)
        {'success': True, 'inserted': 2, 'diagnostic': {'rows_attempted': 2, 'sql_time_ms': 12.5, ...}}
    """
    import time
    
    if not rows:
        result = {"success": True, "inserted": 0}
        if diagnostic:
            result["diagnostic"] = {
                "rows_attempted": 0,
                "sql_time_ms": 0,
                "reason": "empty_rows"
            }
        return result
    
    conn = get_db_connection()
    start_time = time.time()
    
    try:
        cur = conn.cursor()

        if not param_id:
            raise ValueError("param_id is required")
        if not canonical_signature:
            raise ValueError("canonical_signature is required")
        if inputs_json is None or not isinstance(inputs_json, dict):
            raise ValueError("inputs_json is required and must be a JSON object")
        if not sig_algo or not isinstance(sig_algo, str):
            raise ValueError("sig_algo is required and must be a string")

        # Frontend must provide core_hash. Fall back to derivation ONLY for legacy test callers.
        if core_hash and isinstance(core_hash, str) and core_hash.strip():
            core_hash = core_hash.strip()
        else:
            # Legacy test compat only — production callers MUST provide core_hash
            core_hash = short_core_hash_from_canonical_signature(canonical_signature)
        canonical_sig_hash_full = hashlib.sha256(canonical_signature.strip().encode("utf-8")).hexdigest()

        # Insert registry row once per unique (param_id, core_hash).
        # This is intentionally part of the append path (simple; always send inputs_json).
        cur.execute(
            """
            INSERT INTO signature_registry
              (param_id, core_hash, canonical_signature, inputs_json, canonical_sig_hash_full, sig_algo)
            VALUES (%s, %s, %s, %s::jsonb, %s, %s)
            ON CONFLICT (param_id, core_hash) DO NOTHING
            """,
            (param_id, core_hash, canonical_signature, json.dumps(inputs_json), canonical_sig_hash_full, sig_algo)
        )
        
        values = [
            (
                param_id,
                core_hash,
                None,  # context_def_hashes (deprecated for V1 flexi-sigs; canonical_signature is in registry)
                slice_key,
                row['anchor_day'],
                retrieved_at,
                row.get('A'),
                row.get('X'),
                row.get('Y'),
                row.get('median_lag_days'),
                row.get('mean_lag_days'),
                row.get('anchor_median_lag_days'),
                row.get('anchor_mean_lag_days'),
                row.get('onset_delta_days'),
                json.dumps(inputs_json),
            )
            for row in rows
        ]
        
        # Use RETURNING with fetch=True to get accurate insert count
        # (rowcount is unreliable with execute_values + ON CONFLICT DO NOTHING)
        result_rows = execute_values(
            cur,
            """
            INSERT INTO snapshots (
                param_id, core_hash, context_def_hashes, slice_key, anchor_day, retrieved_at,
                A, X, Y,
                median_lag_days, mean_lag_days,
                anchor_median_lag_days, anchor_mean_lag_days,
                onset_delta_days,
                write_inputs_json
            ) VALUES %s
            ON CONFLICT (param_id, core_hash, slice_key, anchor_day, retrieved_at)
            DO NOTHING
            RETURNING 1
            """,
            values,
            template="(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)",
            fetch=True
        )
        
        inserted = len(result_rows) if result_rows else 0
        conn.commit()
        
        sql_time_ms = (time.time() - start_time) * 1000
        
        result = {"success": True, "inserted": inserted, "core_hash": core_hash}
        
        if diagnostic:
            # Compute diagnostic details
            anchor_days = [row['anchor_day'] for row in rows]
            anchor_days_sorted = sorted(anchor_days)
            
            has_latency = any(
                row.get('median_lag_days') is not None or 
                row.get('mean_lag_days') is not None
                for row in rows
            )
            has_anchor = any(row.get('A') is not None for row in rows)
            
            result["diagnostic"] = {
                "rows_attempted": len(rows),
                "rows_inserted": inserted,
                "duplicates_skipped": len(rows) - inserted,
                "sql_time_ms": round(sql_time_ms, 2),
                "date_range": f"{anchor_days_sorted[0]} to {anchor_days_sorted[-1]}",
                "has_latency": has_latency,
                "has_anchor": has_anchor,
                "slice_key": slice_key or "(uncontexted)",
            }
        
        return result
        
    finally:
        conn.close()


def health_check() -> Dict[str, Any]:
    """
    Health check for snapshot DB features.
    
    Frontend uses this to enable/disable DB-dependent UI.
    
    Returns:
        Dict with status ('ok' or 'error') and additional info
    """
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT 1")
        cur.fetchone()
        conn.close()
        return {"status": "ok", "db": "connected"}
    except ValueError as e:
        # DB_CONNECTION not set
        return {"status": "error", "db": "not_configured", "error": str(e)}
    except Exception as e:
        return {"status": "error", "db": "unavailable", "error": str(e)}


# =============================================================================
# Phase 2: Read Path — Query Functions
# =============================================================================

def _slice_key_match_sql_expr() -> str:
    """
    SQL expression that canonicalises snapshots.slice_key for matching.

    Semantics:
    - strip arguments from window(...) / cohort(...)
    - treat clause order as irrelevant for constraint DSL by sorting non-mode clauses,
      then appending the mode clause(s) (window()/cohort()) last

    NOTE:
    This is intentionally a pure-SQL canonicaliser so we can match legacy rows where
    equivalent slice_key strings were written with different clause orders.
    """
    return r"""
      COALESCE((
        SELECT array_to_string(
          COALESCE(
            (
              SELECT array_agg(seg ORDER BY seg)
              FROM unnest(
                string_to_array(
                  regexp_replace(slice_key, '(window|cohort)\([^)]*\)', '\1()', 'g'),
                  '.'
                )
              ) seg
              WHERE seg <> '' AND seg NOT IN ('window()', 'cohort()')
            ),
            ARRAY[]::text[]
          )
          ||
          COALESCE(
            (
              SELECT array_agg(DISTINCT seg ORDER BY seg)
              FROM unnest(
                string_to_array(
                  regexp_replace(slice_key, '(window|cohort)\([^)]*\)', '\1()', 'g'),
                  '.'
                )
              ) seg
              WHERE seg IN ('window()', 'cohort()')
            ),
            ARRAY[]::text[]
          ),
          '.'
        )
      ), '')
    """

def _partition_key_match_sql_expr() -> str:
    """
    SQL expression used as the "logical slice family" partition key.

    This is the same as the match expression: context/case dims are preserved,
    and window/cohort arguments are stripped.
    """
    return _slice_key_match_sql_expr()


def _split_slice_selectors(norm: List[str]) -> tuple[List[str], List[str]]:
    """
    Split normalised slice selector strings into:
    - family selectors (include context/case dims, e.g. "context(x).cohort()")
    - mode-only selectors (legacy; no longer used)

    IMPORTANT CONTRACT (context-epochs.md §3.5):
    - "cohort()" / "window()" MUST mean *uncontexted-only* (no context/case dims),
      not "any context in this mode".
    - Broad reads across all slices remain available via the empty selector "" which
      means "no slice filter" (back-compat).
    """
    families = [s for s in norm if s]
    return families, []


def _append_slice_filter_sql(*, sql_parts: List[str], params: List[Any], slice_keys: List[str]) -> None:
    """
    Append a slice filter to an existing SQL where clause builder.

    Semantics:
    - A selector with context/case dims matches by full normalised family equality.
      e.g. "context(channel:google).cohort()"
    - A selector of "cohort()" / "window()" matches the uncontexted-only family (no dims).

    Broad reads (all slices) are expressed by including "" in slice_keys (back-compat).
    """
    norm = [normalise_slice_key_for_matching(sk) for sk in slice_keys]
    # Back-compat: empty selector historically meant "no slice filter" (broad / MECE-capable).
    if "" in norm:
        return
    families, mode_only = _split_slice_selectors(norm)

    sub: List[str] = []
    if families:
        sub.append(f"{_slice_key_match_sql_expr()} = ANY(%s)")
        params.append(families)

    if sub:
        sql_parts.append("(" + " OR ".join(sub) + ")")


def query_snapshots(
    param_id: str,
    core_hash: Optional[str] = None,
    slice_keys: Optional[List[str]] = None,
    anchor_from: Optional[date] = None,
    anchor_to: Optional[date] = None,
    as_at: Optional[datetime] = None,
    retrieved_ats: Optional[List[datetime]] = None,
    include_equivalents: bool = True,
    limit: int = 10000
) -> List[Dict[str, Any]]:
    """
    Query snapshot rows from the database.
    
    Args:
        param_id: Workspace-prefixed parameter ID (required)
        core_hash: Query signature hash (optional filter)
        slice_keys: List of slice keys to include (optional, None = all)
        anchor_from: Start of anchor date range (optional)
        anchor_to: End of anchor date range (optional)
        as_at: If provided, only return snapshots retrieved before this timestamp
        include_equivalents: If True, expand core_hash via equivalence links (default True)
        limit: Maximum rows to return (default 10000)
    
    Returns:
        List of snapshot rows as dicts with columns:
        - param_id, core_hash, slice_key, anchor_day, retrieved_at
        - a, x, y (lowercase for JSON serialization)
        - median_lag_days, mean_lag_days
        - anchor_median_lag_days, anchor_mean_lag_days
        - onset_delta_days
    """
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        
        query = """
            SELECT 
                param_id, core_hash, slice_key, anchor_day, retrieved_at,
                A as a, X as x, Y as y,
                median_lag_days, mean_lag_days,
                anchor_median_lag_days, anchor_mean_lag_days,
                onset_delta_days
            FROM snapshots
        """
        params: List[Any] = []
        
        if core_hash is not None:
            if include_equivalents:
                # Expand via equivalence closure before filtering — includes cross-param sources.
                # When core_hash is provided, it is the logical key — param_id is NOT
                # required for filtering. This allows cross-branch queries: data written
                # on main is findable from feature branches (same core_hash, same query).
                resolved = resolve_equivalent_hashes(
                    param_id=param_id,
                    core_hash=core_hash,
                    include_equivalents=True,
                )
                hashes = resolved.get("core_hashes", [core_hash])
                query += " WHERE core_hash = ANY(%s)"
                params.append(hashes)
            else:
                # Without equivalence expansion, use core_hash alone (not param_id).
                query += " WHERE core_hash = %s"
                params.append(core_hash)
        else:
            # No core_hash filter → strict param_id scoping (historical behaviour)
            query += " WHERE param_id = %s"
            params.append(param_id)
        
        if slice_keys is not None:
            parts: List[str] = []
            _append_slice_filter_sql(sql_parts=parts, params=params, slice_keys=slice_keys)
            if parts:
                query += " AND " + " AND ".join(parts)
        
        if anchor_from is not None:
            query += " AND anchor_day >= %s"
            params.append(anchor_from)
        
        if anchor_to is not None:
            query += " AND anchor_day <= %s"
            params.append(anchor_to)
        
        if as_at is not None:
            query += " AND retrieved_at <= %s"
            params.append(as_at)

        if retrieved_ats is not None and len(retrieved_ats) > 0:
            query += " AND retrieved_at = ANY(%s)"
            params.append(retrieved_ats)
        
        query += " ORDER BY anchor_day, slice_key, retrieved_at"
        query += f" LIMIT {int(limit)}"
        
        cur.execute(query, params)
        columns = [desc[0] for desc in cur.description]
        rows = [dict(zip(columns, row)) for row in cur.fetchall()]
        
        # Convert date/datetime to ISO strings for JSON serialization
        for row in rows:
            if row.get('anchor_day') and hasattr(row['anchor_day'], 'isoformat'):
                row['anchor_day'] = row['anchor_day'].isoformat()
            if row.get('retrieved_at') and hasattr(row['retrieved_at'], 'isoformat'):
                row['retrieved_at'] = row['retrieved_at'].isoformat()
        
        return rows
        
    finally:
        conn.close()


def query_snapshots_for_sweep(
    param_id: str,
    core_hash: str,
    slice_keys: Optional[List[str]] = None,
    anchor_from: Optional[date] = None,
    anchor_to: Optional[date] = None,
    sweep_from: Optional[date] = None,
    sweep_to: Optional[date] = None,
    include_equivalents: bool = True,
    limit: int = 50000,
) -> List[Dict[str, Any]]:
    """
    Query snapshot rows for cohort maturity sweep.

    Returns ALL raw rows in the anchor range whose ``retrieved_at`` falls
    between ``sweep_from`` and ``sweep_to`` (inclusive, date-level).  The
    derivation layer uses these to reconstruct virtual snapshots at each
    distinct retrieval boundary.

    This is functionally identical to ``query_snapshots`` but:
    - requires ``core_hash`` (never optional for sweep)
    - filters ``retrieved_at`` by a **date range** (sweep window), not a
      single ``as_at`` ceiling
    - uses a higher default limit (sweep may span many retrieval dates)

    See: docs/current/project-db/1-reads.md §5.1
    """
    conn = get_db_connection()
    try:
        cur = conn.cursor()

        # core_hash is mandatory for sweep.
        #
        # DESIGN (docs/current/project-db/completed/key-fixes.md §2.2):
        # Snapshot reads must NOT depend on param_id bucketing (repo/branch).
        # param_id remains useful for audit + write identity, but read identity is:
        #   core_hash family × logical slice family × retrieved_at.
        if include_equivalents:
            resolved = resolve_equivalent_hashes(
                param_id=param_id,
                core_hash=core_hash,
                include_equivalents=True,
            )
            hashes = resolved.get("core_hashes", [core_hash])
        else:
            hashes = [core_hash]

        query = """
            SELECT 
                param_id, core_hash, slice_key, anchor_day, retrieved_at,
                A as a, X as x, Y as y,
                median_lag_days, mean_lag_days,
                anchor_median_lag_days, anchor_mean_lag_days,
                onset_delta_days
            FROM snapshots
            WHERE core_hash = ANY(%s)
        """
        params: List[Any] = [hashes]

        if slice_keys is not None:
            parts: List[str] = []
            _append_slice_filter_sql(sql_parts=parts, params=params, slice_keys=slice_keys)
            if parts:
                query += " AND " + " AND ".join(parts)

        if anchor_from is not None:
            query += " AND anchor_day >= %s"
            params.append(anchor_from)
        if anchor_to is not None:
            query += " AND anchor_day <= %s"
            params.append(anchor_to)

        # Sweep date range on retrieved_at (date-level comparison)
        if sweep_from is not None:
            query += " AND retrieved_at >= %s"
            params.append(datetime.combine(sweep_from, datetime.min.time()))
        if sweep_to is not None:
            query += " AND retrieved_at < %s"
            # sweep_to is inclusive at date level: < start of next day
            from datetime import timedelta
            params.append(datetime.combine(sweep_to + timedelta(days=1), datetime.min.time()))

        query += " ORDER BY anchor_day, slice_key, retrieved_at"
        query += f" LIMIT {int(limit)}"

        cur.execute(query, params)
        columns = [desc[0] for desc in cur.description]
        rows = [dict(zip(columns, row)) for row in cur.fetchall()]

        # Convert date/datetime to ISO strings for JSON serialisation
        for row in rows:
            if row.get('anchor_day') and hasattr(row['anchor_day'], 'isoformat'):
                row['anchor_day'] = row['anchor_day'].isoformat()
            if row.get('retrieved_at') and hasattr(row['retrieved_at'], 'isoformat'):
                row['retrieved_at'] = row['retrieved_at'].isoformat()

        return rows
    finally:
        conn.close()


def get_snapshot_inventory(
    param_id: str,
    core_hash: Optional[str] = None
) -> Dict[str, Any]:
    """
    Get inventory summary of available snapshots for a parameter.
    
    Args:
        param_id: Workspace-prefixed parameter ID
        core_hash: Optional filter by query signature
    
    Returns:
        Dict with:
        - has_data: bool
        - earliest: ISO date string or None
        - latest: ISO date string or None
        - row_count: int
        - unique_days: int
        - unique_slices: int
        - unique_hashes: int (distinct core_hash values)
    """
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        
        # Build WHERE clause
        where_clause = "WHERE param_id = %s"
        params: List[Any] = [param_id]
        if core_hash is not None:
            where_clause += " AND core_hash = %s"
            params.append(core_hash)
        
        # Get basic stats
        cur.execute(f"""
            SELECT 
                MIN(anchor_day) as earliest,
                MAX(anchor_day) as latest,
                COUNT(*) as row_count,
                COUNT(DISTINCT anchor_day) as unique_days,
                COUNT(DISTINCT slice_key) as unique_slices,
                COUNT(DISTINCT core_hash) as unique_hashes
            FROM snapshots
            {where_clause}
        """, params)
        row = cur.fetchone()
        
        if not row or row[0] is None:
            return {
                'has_data': False,
                'param_id': param_id,
                'earliest': None,
                'latest': None,
                'row_count': 0,
                'unique_days': 0,
                'unique_slices': 0,
                'unique_hashes': 0,
                'unique_retrievals': 0,
            }
        
        # Get unique retrievals using gap detection
        cur.execute(f"""
            WITH distinct_times AS (
                SELECT retrieved_at
                FROM snapshots
                {where_clause}
                GROUP BY retrieved_at
            ),
            marked AS (
                SELECT
                    CASE
                        WHEN LAG(retrieved_at) OVER (ORDER BY retrieved_at) IS NULL THEN 1
                        WHEN retrieved_at - LAG(retrieved_at) OVER (ORDER BY retrieved_at) > INTERVAL '5 minutes' THEN 1
                        ELSE 0
                    END AS is_new_group
                FROM distinct_times
            )
            SELECT COALESCE(SUM(is_new_group), 0) AS unique_retrievals
            FROM marked
        """, params)
        retrieval_row = cur.fetchone()
        unique_retrievals = retrieval_row[0] if retrieval_row else 0
        
        return {
            'has_data': True,
            'param_id': param_id,
            'earliest': row[0].isoformat() if row[0] else None,
            'latest': row[1].isoformat() if row[1] else None,
            'row_count': row[2],
            'unique_days': row[3],
            'unique_slices': row[4],
            'unique_hashes': row[5],
            'unique_retrievals': unique_retrievals,
        }
        
    finally:
        conn.close()


def get_batch_inventory(param_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    """
    Get inventory summary for multiple parameters in a single query.
    
    More efficient than calling get_snapshot_inventory() multiple times.
    
    Args:
        param_ids: List of workspace-prefixed parameter IDs
    
    Returns:
        Dict mapping param_id -> inventory dict (same format as get_snapshot_inventory)
    """
    if not param_ids:
        return {}
    
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        
        # Get basic stats
        cur.execute("""
            SELECT 
                param_id,
                MIN(anchor_day) as earliest,
                MAX(anchor_day) as latest,
                COUNT(*) as row_count,
                COUNT(DISTINCT anchor_day) as unique_days,
                COUNT(DISTINCT slice_key) as unique_slices,
                COUNT(DISTINCT core_hash) as unique_hashes
            FROM snapshots
            WHERE param_id = ANY(%s)
            GROUP BY param_id
        """, (param_ids,))
        
        basic_stats = {row[0]: row for row in cur.fetchall()}
        
        # Get unique retrievals using gap detection (sessions separated by >5 min)
        cur.execute("""
            WITH distinct_times AS (
                SELECT param_id, retrieved_at
                FROM snapshots
                WHERE param_id = ANY(%s)
                GROUP BY param_id, retrieved_at
            ),
            marked AS (
                SELECT
                    param_id,
                    CASE
                        WHEN LAG(retrieved_at) OVER (PARTITION BY param_id ORDER BY retrieved_at) IS NULL THEN 1
                        WHEN retrieved_at - LAG(retrieved_at) OVER (PARTITION BY param_id ORDER BY retrieved_at) > INTERVAL '5 minutes' THEN 1
                        ELSE 0
                    END AS is_new_group
                FROM distinct_times
            )
            SELECT param_id, SUM(is_new_group) AS unique_retrievals
            FROM marked
            GROUP BY param_id
        """, (param_ids,))
        
        retrieval_counts = {row[0]: row[1] for row in cur.fetchall()}
        
        results = {}
        
        # Initialize all requested param_ids with empty inventory
        for pid in param_ids:
            results[pid] = {
                'has_data': False,
                'param_id': pid,
                'earliest': None,
                'latest': None,
                'row_count': 0,
                'unique_days': 0,
                'unique_slices': 0,
                'unique_hashes': 0,
                'unique_retrievals': 0,
            }
        
        # Fill in actual data for params that have snapshots
        for pid, row in basic_stats.items():
            results[pid] = {
                'has_data': True,
                'param_id': pid,
                'earliest': row[1].isoformat() if row[1] else None,
                'latest': row[2].isoformat() if row[2] else None,
                'row_count': row[3],
                'unique_days': row[4],
                'unique_slices': row[5],
                'unique_hashes': row[6],
                'unique_retrievals': retrieval_counts.get(pid, 0),
            }
        
        return results
        
    finally:
        conn.close()


def get_batch_inventory_rich(param_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    """
    Rich inventory for debugging + UI flexibility.

    Returns BOTH:
    - overall: the existing aggregate inventory (same shape as get_batch_inventory)
    - by_core_hash: per-signature aggregates, each with per-slice aggregates

    This intentionally does NOT decide what is "relevant" for a given UI surface.
    The frontend can choose:
    - general view: overall.unique_days across overall.unique_slices
    - relevant view: pick a signature (e.g. latest query_signature) and slice(s)
    """
    if not param_ids:
        return {}

    overall = get_batch_inventory(param_ids)

    conn = get_db_connection()
    try:
        cur = conn.cursor()

        # Distinct retrieval days (UTC) per param_id, and per (param_id, core_hash).
        cur.execute(
            """
            SELECT
                param_id,
                COUNT(DISTINCT (retrieved_at AT TIME ZONE 'UTC')::date) AS unique_retrieved_days
            FROM snapshots
            WHERE param_id = ANY(%s)
            GROUP BY param_id
            """,
            (param_ids,),
        )
        overall_retrieved_days = {row[0]: int(row[1] or 0) for row in cur.fetchall()}

        cur.execute(
            """
            SELECT
                param_id,
                core_hash,
                COUNT(DISTINCT (retrieved_at AT TIME ZONE 'UTC')::date) AS unique_retrieved_days
            FROM snapshots
            WHERE param_id = ANY(%s)
            GROUP BY param_id, core_hash
            """,
            (param_ids,),
        )
        sig_retrieved_days = {(row[0], row[1]): int(row[2] or 0) for row in cur.fetchall()}

        # Per-(param_id, core_hash) aggregates.
        cur.execute(
            """
            SELECT
                param_id,
                core_hash,
                MIN(anchor_day) AS earliest,
                MAX(anchor_day) AS latest,
                COUNT(*) AS row_count,
                COUNT(DISTINCT anchor_day) AS unique_days,
                COUNT(DISTINCT slice_key) AS unique_slices
            FROM snapshots
            WHERE param_id = ANY(%s)
            GROUP BY param_id, core_hash
            """,
            (param_ids,),
        )
        core_rows = cur.fetchall()

        # Per-(param_id, core_hash, slice_key) aggregates.
        cur.execute(
            """
            SELECT
                param_id,
                core_hash,
                slice_key,
                MIN(anchor_day) AS earliest,
                MAX(anchor_day) AS latest,
                COUNT(*) AS row_count,
                COUNT(DISTINCT anchor_day) AS unique_days
            FROM snapshots
            WHERE param_id = ANY(%s)
            GROUP BY param_id, core_hash, slice_key
            """,
            (param_ids,),
        )
        slice_rows = cur.fetchall()

        # Assemble.
        by_param: Dict[str, Dict[str, Any]] = {}
        for pid in param_ids:
            # Augment overall with unique_retrieved_days (one "snapshot" per retrieved day).
            ov = overall.get(
                pid,
                {
                    "has_data": False,
                    "param_id": pid,
                    "earliest": None,
                    "latest": None,
                    "row_count": 0,
                    "unique_days": 0,
                    "unique_slices": 0,
                    "unique_hashes": 0,
                    "unique_retrievals": 0,
                },
            )
            try:
                ov["unique_retrieved_days"] = overall_retrieved_days.get(pid, 0)
            except Exception:
                pass
            by_param[pid] = {
                "overall": ov,
                "by_core_hash": [],
            }

        # Index slice aggregates by (pid, core_hash).
        slices_by_sig: Dict[str, List[Dict[str, Any]]] = {}
        for pid, ch, slice_key, earliest, latest, row_count, unique_days in slice_rows:
            key = f"{pid}\n{ch}"
            if key not in slices_by_sig:
                slices_by_sig[key] = []
            slices_by_sig[key].append(
                {
                    "slice_key": slice_key,
                    "earliest": earliest.isoformat() if earliest else None,
                    "latest": latest.isoformat() if latest else None,
                    "row_count": int(row_count or 0),
                    "unique_days": int(unique_days or 0),
                }
            )

        # Build by_core_hash list.
        for pid, ch, earliest, latest, row_count, unique_days, unique_slices in core_rows:
            sig_key = f"{pid}\n{ch}"
            by_param[pid]["by_core_hash"].append(
                {
                    "core_hash": ch,
                    "earliest": earliest.isoformat() if earliest else None,
                    "latest": latest.isoformat() if latest else None,
                    "row_count": int(row_count or 0),
                    "unique_days": int(unique_days or 0),
                    "unique_slices": int(unique_slices or 0),
                    # The user-facing "snapshot count": number of distinct retrieval days for this signature,
                    # deduped across slice keys.
                    "unique_retrieved_days": sig_retrieved_days.get((pid, ch), 0),
                    "by_slice_key": sorted(
                        slices_by_sig.get(sig_key, []),
                        key=lambda x: str(x.get("slice_key") or ""),
                    ),
                }
            )

        # Stable ordering: biggest row_count first (most relevant to humans when debugging).
        for pid in by_param.keys():
            by_param[pid]["by_core_hash"].sort(key=lambda x: int(x.get("row_count") or 0), reverse=True)

        return by_param

    finally:
        conn.close()


# =============================================================================
# Flexible signatures: Inventory V2 (signature families)
# =============================================================================


class _UnionFind:
    def __init__(self):
        self.parent: Dict[str, str] = {}
        self.rank: Dict[str, int] = {}

    def add(self, x: str) -> None:
        if x not in self.parent:
            self.parent[x] = x
            self.rank[x] = 0

    def find(self, x: str) -> str:
        # Path compression
        p = self.parent.get(x)
        if p is None:
            self.add(x)
            return x
        if p != x:
            self.parent[x] = self.find(p)
        return self.parent[x]

    def union(self, a: str, b: str) -> None:
        ra = self.find(a)
        rb = self.find(b)
        if ra == rb:
            return
        # Union by rank
        if self.rank[ra] < self.rank[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        if self.rank[ra] == self.rank[rb]:
            self.rank[ra] += 1

    def components(self) -> Dict[str, List[str]]:
        out: Dict[str, List[str]] = {}
        for x in list(self.parent.keys()):
            r = self.find(x)
            out.setdefault(r, []).append(x)
        return out


def get_batch_inventory_v2(
    *,
    param_ids: List[str],
    current_signatures: Optional[Dict[str, str]] = None,
    current_core_hashes: Optional[Dict[str, str]] = None,
    slice_keys_by_param: Optional[Dict[str, List[str]]] = None,
    include_equivalents: bool = True,
    limit_families_per_param: int = 50,
    limit_slices_per_family: int = 200,
) -> Dict[str, Any]:
    """
    Inventory V2: group snapshot inventory by signature families (equivalence closure).

    See docs/current/project-db/flexi_sigs.md §8.
    """
    if not param_ids:
        return {}

    # Defensive clamps.
    limit_families_per_param = max(1, min(int(limit_families_per_param or 50), 500))
    limit_slices_per_family = max(1, min(int(limit_slices_per_family or 200), 2000))

    current_signatures = current_signatures or {}
    slice_keys_by_param = slice_keys_by_param or {}

    conn = get_db_connection()
    try:
        cur = conn.cursor()

        # 1) Load snapshot aggregates by (param_id, core_hash, slice_key).
        #
        # NOTE: per-param slice filtering is handled in Python after the query to avoid
        # generating dynamic SQL with many OR clauses. This is acceptable because we
        # are aggregating, not returning raw rows.
        cur.execute(
            """
            SELECT
              param_id,
              core_hash,
              slice_key,
              COUNT(*) AS row_count,
              COUNT(DISTINCT anchor_day) AS unique_anchor_days,
              COUNT(DISTINCT retrieved_at) AS unique_retrievals,
              COUNT(DISTINCT (retrieved_at AT TIME ZONE 'UTC')::date) AS unique_retrieved_days,
              MIN(anchor_day) AS earliest_anchor_day,
              MAX(anchor_day) AS latest_anchor_day,
              MIN(retrieved_at) AS earliest_retrieved_at,
              MAX(retrieved_at) AS latest_retrieved_at
            FROM snapshots
            WHERE param_id = ANY(%s)
            GROUP BY param_id, core_hash, slice_key
            """,
            (param_ids,),
        )
        agg_rows = cur.fetchall()

        # 2) Load overall-all-families aggregates per param_id (independent of core_hash).
        cur.execute(
            """
            SELECT
              param_id,
              COUNT(*) AS row_count,
              COUNT(DISTINCT anchor_day) AS unique_anchor_days,
              COUNT(DISTINCT retrieved_at) AS unique_retrievals,
              COUNT(DISTINCT (retrieved_at AT TIME ZONE 'UTC')::date) AS unique_retrieved_days,
              MIN(anchor_day) AS earliest_anchor_day,
              MAX(anchor_day) AS latest_anchor_day,
              MIN(retrieved_at) AS earliest_retrieved_at,
              MAX(retrieved_at) AS latest_retrieved_at
            FROM snapshots
            WHERE param_id = ANY(%s)
            GROUP BY param_id
            """,
            (param_ids,),
        )
        overall_rows = cur.fetchall()
        overall_by_param: Dict[str, Dict[str, Any]] = {}
        for row in overall_rows:
            pid = row[0]
            overall_by_param[pid] = {
                "row_count": int(row[1] or 0),
                "unique_anchor_days": int(row[2] or 0),
                "unique_retrievals": int(row[3] or 0),
                "unique_retrieved_days": int(row[4] or 0),
                "earliest_anchor_day": row[5].isoformat() if row[5] else None,
                "latest_anchor_day": row[6].isoformat() if row[6] else None,
                "earliest_retrieved_at": row[7].isoformat() if row[7] else None,
                "latest_retrieved_at": row[8].isoformat() if row[8] else None,
            }

        # 3) Load active equivalence edges for these params (if enabled).
        edges_by_param: Dict[str, List[tuple[str, str]]] = {pid: [] for pid in param_ids}
        edge_endpoints_by_param: Dict[str, set[str]] = {pid: set() for pid in param_ids}
        if include_equivalents:
            cur.execute(
                """
                SELECT param_id, core_hash, equivalent_to
                FROM signature_equivalence
                WHERE param_id = ANY(%s) AND active = true AND operation = 'equivalent'
                """,
                (param_ids,),
            )
            for (pid, a, b) in cur.fetchall():
                if pid not in edges_by_param:
                    continue
                a = str(a)
                b = str(b)
                edges_by_param[pid].append((a, b))
                edge_endpoints_by_param[pid].add(a)
                edge_endpoints_by_param[pid].add(b)

        # 4) Load signature_registry created_at for stability (family_id selection).
        cur.execute(
            """
            SELECT param_id, core_hash, created_at
            FROM signature_registry
            WHERE param_id = ANY(%s)
            """,
            (param_ids,),
        )
        created_at_by_param_hash: Dict[tuple[str, str], datetime] = {}
        for (pid, ch, created_at) in cur.fetchall():
            if pid and ch and created_at:
                created_at_by_param_hash[(str(pid), str(ch))] = created_at

        # 5) Build per-param union-find components across hashes.
        #
        # Nodes include:
        # - hashes present in snapshots (from agg_rows)
        # - hashes referenced in edges
        # - provided current signature hashes (even if no snapshots yet)
        uf_by_param: Dict[str, _UnionFind] = {pid: _UnionFind() for pid in param_ids}
        hashes_in_snapshots_by_param: Dict[str, set[str]] = {pid: set() for pid in param_ids}

        for (pid, core_hash, slice_key, *_rest) in agg_rows:
            pid_s = str(pid)
            ch_s = str(core_hash)
            if pid_s in uf_by_param:
                uf_by_param[pid_s].add(ch_s)
                hashes_in_snapshots_by_param[pid_s].add(ch_s)

        for pid in param_ids:
            uf = uf_by_param[pid]
            for (a, b) in edges_by_param.get(pid, []):
                uf.add(a)
                uf.add(b)
                uf.union(a, b)

        # Add current signature nodes
        # Frontend MUST provide current_core_hashes — backend never derives hashes (hash-fixes.md)
        current_core_hashes = current_core_hashes or {}
        current_core_hash_by_param: Dict[str, Optional[str]] = {}
        for pid in param_ids:
            ch = current_core_hashes.get(pid)
            current_core_hash_by_param[pid] = ch if ch else None
            if ch:
                uf_by_param[pid].add(ch)

        # 6) Build a lookup of aggregates by (param_id, core_hash, slice_key), with optional slice filtering.
        agg_by_param_hash_slice: Dict[tuple[str, str, str], Dict[str, Any]] = {}
        for row in agg_rows:
            pid, ch, sk = str(row[0]), str(row[1]), str(row[2])
            if pid not in uf_by_param:
                continue
            # Apply per-param slice filter if provided.
            allowed = slice_keys_by_param.get(pid)
            if allowed is not None:
                allowed_norm = {normalise_slice_key_for_matching(a) for a in allowed}
                # Back-compat: empty selector means "no slice filtering" for inventory.
                if "" in allowed_norm:
                    pass
                else:
                    sk_norm = normalise_slice_key_for_matching(sk)
                    if sk_norm not in allowed_norm:
                        continue
            agg_by_param_hash_slice[(pid, ch, sk)] = {
                "slice_key": sk,
                "row_count": int(row[3] or 0),
                "unique_anchor_days": int(row[4] or 0),
                "unique_retrievals": int(row[5] or 0),
                "unique_retrieved_days": int(row[6] or 0),
                "earliest_anchor_day": row[7].isoformat() if row[7] else None,
                "latest_anchor_day": row[8].isoformat() if row[8] else None,
                "earliest_retrieved_at": row[9].isoformat() if row[9] else None,
                "latest_retrieved_at": row[10].isoformat() if row[10] else None,
            }

        # 7) Assemble response.
        inventory: Dict[str, Any] = {}
        for pid in param_ids:
            uf = uf_by_param[pid]
            comps = uf.components()

            # Determine family_id per component.
            families: List[Dict[str, Any]] = []
            for _root, members in comps.items():
                members_sorted = sorted(set(members))
                # Choose family_id by earliest created_at, tie-break lexicographic.
                best = None
                best_created = None
                for ch in members_sorted:
                    created = created_at_by_param_hash.get((pid, ch))
                    if created is None:
                        continue
                    if best_created is None or created < best_created or (created == best_created and ch < (best or ch)):
                        best_created = created
                        best = ch
                family_id = best if best is not None else (members_sorted[0] if members_sorted else "")

                # Aggregate stats across member hashes (only those present in snapshots).
                by_slice: Dict[str, Dict[str, Any]] = {}
                overall = {
                    "row_count": 0,
                    "unique_anchor_days": 0,
                    "unique_retrievals": 0,
                    "unique_retrieved_days": 0,
                    "earliest_anchor_day": None,
                    "latest_anchor_day": None,
                    "earliest_retrieved_at": None,
                    "latest_retrieved_at": None,
                }

                # Helper for min/max on ISO-like strings.
                def _min_str(a: Optional[str], b: Optional[str]) -> Optional[str]:
                    if a is None:
                        return b
                    if b is None:
                        return a
                    return a if a < b else b

                def _max_str(a: Optional[str], b: Optional[str]) -> Optional[str]:
                    if a is None:
                        return b
                    if b is None:
                        return a
                    return a if a > b else b

                for ch in members_sorted:
                    if ch not in hashes_in_snapshots_by_param.get(pid, set()):
                        continue
                    # Collect slice aggregates
                    for (p2, ch2, sk), agg in agg_by_param_hash_slice.items():
                        if p2 != pid or ch2 != ch:
                            continue
                        # Merge per-slice (sum counts; min/max ranges)
                        existing = by_slice.get(sk)
                        if existing is None:
                            by_slice[sk] = dict(agg)
                        else:
                            existing["row_count"] += agg["row_count"]
                            existing["unique_anchor_days"] = max(existing["unique_anchor_days"], agg["unique_anchor_days"])
                            existing["unique_retrievals"] = max(existing["unique_retrievals"], agg["unique_retrievals"])
                            existing["unique_retrieved_days"] = max(existing["unique_retrieved_days"], agg["unique_retrieved_days"])
                            existing["earliest_anchor_day"] = _min_str(existing["earliest_anchor_day"], agg["earliest_anchor_day"])
                            existing["latest_anchor_day"] = _max_str(existing["latest_anchor_day"], agg["latest_anchor_day"])
                            existing["earliest_retrieved_at"] = _min_str(existing["earliest_retrieved_at"], agg["earliest_retrieved_at"])
                            existing["latest_retrieved_at"] = _max_str(existing["latest_retrieved_at"], agg["latest_retrieved_at"])

                        # Merge into family overall
                        overall["row_count"] += agg["row_count"]
                        overall["unique_anchor_days"] = max(overall["unique_anchor_days"], agg["unique_anchor_days"])
                        overall["unique_retrievals"] = max(overall["unique_retrievals"], agg["unique_retrievals"])
                        overall["unique_retrieved_days"] = max(overall["unique_retrieved_days"], agg["unique_retrieved_days"])
                        overall["earliest_anchor_day"] = _min_str(overall["earliest_anchor_day"], agg["earliest_anchor_day"])
                        overall["latest_anchor_day"] = _max_str(overall["latest_anchor_day"], agg["latest_anchor_day"])
                        overall["earliest_retrieved_at"] = _min_str(overall["earliest_retrieved_at"], agg["earliest_retrieved_at"])
                        overall["latest_retrieved_at"] = _max_str(overall["latest_retrieved_at"], agg["latest_retrieved_at"])

                by_slice_list = list(by_slice.values())
                # Cap number of slices returned.
                by_slice_list.sort(key=lambda x: (x.get("slice_key") or ""))
                if len(by_slice_list) > limit_slices_per_family:
                    by_slice_list = by_slice_list[:limit_slices_per_family]

                families.append(
                    {
                        "family_id": family_id,
                        "family_size": len(members_sorted),
                        "member_core_hashes": members_sorted,
                        "created_at_min": (min([created_at_by_param_hash.get((pid, h)) for h in members_sorted if created_at_by_param_hash.get((pid, h))]) or None).isoformat().replace("+00:00", "Z")
                        if any(created_at_by_param_hash.get((pid, h)) for h in members_sorted)
                        else None,
                        "created_at_max": (max([created_at_by_param_hash.get((pid, h)) for h in members_sorted if created_at_by_param_hash.get((pid, h))]) or None).isoformat().replace("+00:00", "Z")
                        if any(created_at_by_param_hash.get((pid, h)) for h in members_sorted)
                        else None,
                        "overall": overall,
                        "by_slice_key": by_slice_list,
                    }
                )

            # Cap families (newest-first by created_at_max where available).
            def _family_sort_key(f: Dict[str, Any]) -> str:
                return str(f.get("created_at_max") or "") + "|" + str(f.get("family_id") or "")

            families.sort(key=_family_sort_key, reverse=True)
            if len(families) > limit_families_per_param:
                families = families[:limit_families_per_param]

            # Unlinked hashes = those in snapshots that are not endpoints of any active edge.
            endpoints = edge_endpoints_by_param.get(pid, set())
            unlinked = sorted([h for h in hashes_in_snapshots_by_param.get(pid, set()) if h not in endpoints])

            # Current mapping annotation.
            provided_sig = current_signatures.get(pid)
            provided_core_hash = current_core_hash_by_param.get(pid)
            matched_family_id = None
            match_mode = "none"
            matched_hashes: List[str] = []
            if provided_core_hash:
                # Find the family containing this hash (if any).
                fam_root = uf.find(provided_core_hash)
                members = sorted(set(comps.get(fam_root, [])))
                if members:
                    matched_family_id = None
                    # locate family_id by membership
                    for f in families:
                        if provided_core_hash in f.get("member_core_hashes", []):
                            matched_family_id = f.get("family_id")
                            break
                    match_mode = "strict" if provided_core_hash in hashes_in_snapshots_by_param.get(pid, set()) else "equivalent"
                    matched_hashes = [provided_core_hash]

            inventory[pid] = {
                "param_id": pid,
                "overall_all_families": overall_by_param.get(pid) or {
                    "row_count": 0,
                    "unique_anchor_days": 0,
                    "unique_retrievals": 0,
                    "unique_retrieved_days": 0,
                    "earliest_anchor_day": None,
                    "latest_anchor_day": None,
                    "earliest_retrieved_at": None,
                    "latest_retrieved_at": None,
                },
                "current": {
                    "provided_signature": provided_sig,
                    "provided_core_hash": provided_core_hash,
                    "matched_family_id": matched_family_id,
                    "match_mode": match_mode,
                    "matched_core_hashes": matched_hashes,
                },
                "families": families,
                "unlinked_core_hashes": unlinked,
                "warnings": [],
            }

        return inventory
    finally:
        conn.close()


# =============================================================================
# Phase 2b+: Batch Anchor Coverage — missing anchor-day ranges per subject
# =============================================================================

def batch_anchor_coverage(
    subjects: List[Dict[str, Any]],
    diagnostic: bool = False,
) -> List[Dict[str, Any]]:
    """
    For each subject, compute which anchor-day ranges within [anchor_from, anchor_to]
    are missing from the snapshot DB, considering equivalence closure.

    This is the "Tier B" preflight used by Retrieve All to detect DB gaps that
    file-cache planning cannot see (hash drift, late-start snapshotting).

    Args:
        subjects: List of dicts, each with:
            - param_id (str, required)
            - core_hash (str, required)
            - slice_keys (list[str], required)
            - anchor_from (date, required)
            - anchor_to (date, required)
            - include_equivalents (bool, default True)

    Returns:
        List of result dicts (same order as subjects), each with:
            - subject_index (int)
            - coverage_ok (bool)
            - missing_anchor_ranges (list of {start, end} ISO date strings, inclusive)
            - present_anchor_ranges (list of {start, end} ISO date strings, inclusive) [diagnostic only]
            - present_anchor_day_count (int)
            - expected_anchor_day_count (int)
            - equivalence_resolution (dict with core_hashes and param_ids lists)
            - slice_keys_normalised (list[str]) [diagnostic only]
            - slice_filter_kind ("none" | "families" | "empty") [diagnostic only]
    """
    if not subjects:
        return []

    conn = get_db_connection()
    try:
        cur = conn.cursor()
        results: List[Dict[str, Any]] = []

        for idx, subj in enumerate(subjects):
            param_id = subj["param_id"]
            core_hash = subj["core_hash"]
            slice_keys = subj.get("slice_keys") or []
            anchor_from = subj["anchor_from"]
            anchor_to = subj["anchor_to"]
            include_equivalents = subj.get("include_equivalents", True)

            # --- Resolve equivalence closure ---
            if include_equivalents and core_hash:
                cur.execute(
                    """
                    WITH RECURSIVE eq(core_hash, source_param_id) AS (
                      SELECT %s::text, %s::text
                      UNION
                      SELECT
                        CASE WHEN e.core_hash = eq.core_hash THEN e.equivalent_to ELSE e.core_hash END,
                        COALESCE(e.source_param_id, e.param_id)
                      FROM signature_equivalence e
                      JOIN eq ON (e.core_hash = eq.core_hash OR e.equivalent_to = eq.core_hash)
                      WHERE e.param_id = %s AND e.active = true AND e.operation = 'equivalent'
                    )
                    SELECT DISTINCT core_hash, source_param_id FROM eq
                    """,
                    (core_hash, param_id, param_id),
                )
                eq_rows = cur.fetchall()
                resolved_hashes = sorted({str(r[0]) for r in eq_rows if r and r[0]})
                resolved_pids = sorted({str(r[1]) for r in eq_rows if r and r[1]})
                if core_hash not in resolved_hashes:
                    resolved_hashes = [core_hash] + resolved_hashes
                if param_id not in resolved_pids:
                    resolved_pids = [param_id] + resolved_pids
            else:
                resolved_hashes = [core_hash]
                resolved_pids = [param_id]

            # --- Query distinct anchor_day present in DB ---
            where_clauses: List[str] = [
                "param_id = ANY(%s)",
                "core_hash = ANY(%s)",
                "anchor_day >= %s",
                "anchor_day <= %s",
            ]
            params: List[Any] = [resolved_pids, resolved_hashes, anchor_from, anchor_to]

            # Diagnostic evidence for slice-key normalisation + filter semantics
            slice_keys_normalised: List[str] = [normalise_slice_key_for_matching(sk) for sk in slice_keys] if slice_keys else []
            if not slice_keys:
                slice_filter_kind = "empty"
            elif "" in slice_keys_normalised:
                slice_filter_kind = "none"
            else:
                slice_filter_kind = "families"

            if slice_keys:
                slice_parts: List[str] = []
                _append_slice_filter_sql(sql_parts=slice_parts, params=params, slice_keys=slice_keys)
                if slice_parts:
                    where_clauses.extend(slice_parts)

            where_sql = " AND ".join(where_clauses)
            cur.execute(
                f"SELECT DISTINCT anchor_day FROM snapshots WHERE {where_sql} ORDER BY anchor_day",
                tuple(params),
            )
            present_days = {r[0] for r in cur.fetchall() if r and r[0]}

            # --- Compute expected day set and missing ranges ---
            expected_days: List[date] = []
            d = anchor_from
            one_day = timedelta(days=1)
            while d <= anchor_to:
                expected_days.append(d)
                d += one_day

            missing_ranges: List[Dict[str, str]] = []
            range_start: Optional[date] = None
            range_end: Optional[date] = None

            for day in expected_days:
                if day not in present_days:
                    if range_start is None:
                        range_start = day
                    range_end = day
                else:
                    if range_start is not None and range_end is not None:
                        missing_ranges.append({
                            "start": range_start.isoformat(),
                            "end": range_end.isoformat(),
                        })
                        range_start = None
                        range_end = None

            # Flush final open range
            if range_start is not None and range_end is not None:
                missing_ranges.append({
                    "start": range_start.isoformat(),
                    "end": range_end.isoformat(),
                })

            out = {
                "subject_index": idx,
                "coverage_ok": len(missing_ranges) == 0,
                "missing_anchor_ranges": missing_ranges,
                "present_anchor_day_count": len(present_days),
                "expected_anchor_day_count": len(expected_days),
                "equivalence_resolution": {
                    "core_hashes": resolved_hashes,
                    "param_ids": resolved_pids,
                },
            }

            if diagnostic:
                # Present anchor evidence as a normalised union of ranges (bounded by gaps).
                present_ranges: List[Dict[str, str]] = []
                pr_start: Optional[date] = None
                pr_end: Optional[date] = None
                for day in expected_days:
                    if day in present_days:
                        if pr_start is None:
                            pr_start = day
                        pr_end = day
                    else:
                        if pr_start is not None and pr_end is not None:
                            present_ranges.append({"start": pr_start.isoformat(), "end": pr_end.isoformat()})
                            pr_start = None
                            pr_end = None
                if pr_start is not None and pr_end is not None:
                    present_ranges.append({"start": pr_start.isoformat(), "end": pr_end.isoformat()})

                out["present_anchor_ranges"] = present_ranges
                out["slice_keys_normalised"] = slice_keys_normalised
                out["slice_filter_kind"] = slice_filter_kind

            results.append(out)

        return results
    except Exception as e:
        # Return per-subject error for all subjects
        return [
            {
                "subject_index": i,
                "coverage_ok": False,
                "missing_anchor_ranges": [],
                "present_anchor_ranges": [] if diagnostic else None,
                "present_anchor_day_count": 0,
                "expected_anchor_day_count": 0,
                "equivalence_resolution": {"core_hashes": [], "param_ids": []},
                "slice_keys_normalised": [] if diagnostic else None,
                "slice_filter_kind": None,
                "error": str(e),
            }
            for i in range(len(subjects))
        ]
    finally:
        conn.close()


# =============================================================================
# Phase 2: Read Path — Smart Inventory (overall + signature/slice matching)
# =============================================================================

# NOTE: We intentionally removed the old "smart matching inventory" helper.
# Inventory is now reported as a rich breakdown keyed by param_id; the frontend
# decides what it considers "relevant" for display and debugging.


def delete_snapshots(
    param_id: str,
    core_hashes: Optional[List[str]] = None,
    retrieved_ats: Optional[List[datetime]] = None,
) -> Dict[str, Any]:
    """
    Delete snapshots for a specific parameter, optionally scoped to specific core_hashes.
    
    When core_hashes is None, deletes ALL rows for the param_id (param-wide).
    When core_hashes is provided, deletes only rows matching those core_hashes.
    
    Args:
        param_id: Exact workspace-prefixed parameter ID to delete
        core_hashes: Optional list of core_hash values to scope the delete
    
    Returns:
        Dict with:
        - success: bool
        - deleted: int (rows deleted)
        - error: str (if success=False)
    """
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        where = ["param_id = %s"]
        params: List[Any] = [param_id]

        if core_hashes is not None and len(core_hashes) > 0:
            where.append("core_hash = ANY(%s)")
            params.append(core_hashes)

        if retrieved_ats is not None and len(retrieved_ats) > 0:
            where.append("retrieved_at = ANY(%s)")
            params.append(retrieved_ats)

        sql = "DELETE FROM snapshots WHERE " + " AND ".join(where)
        cur.execute(sql, tuple(params))
        deleted = cur.rowcount
        conn.commit()
        return {'success': True, 'deleted': deleted}
    except Exception as e:
        return {'success': False, 'deleted': 0, 'error': str(e)}
    finally:
        conn.close()


# =============================================================================
# Phase 2: Snapshot Retrieval Inventory — Distinct retrieved_at values
# =============================================================================

def query_snapshot_retrievals(
    param_id: str,
    core_hash: Optional[str] = None,
    slice_keys: Optional[List[str]] = None,
    anchor_from: Optional[date] = None,
    anchor_to: Optional[date] = None,
    include_equivalents: bool = True,
    include_summary: bool = False,
    limit: int = 200
) -> Dict[str, Any]:
    """
    Return available snapshot retrieval timestamps for a given subject.

    This backs the Phase 2 `@` UI: highlight calendar days where a snapshot exists
    for the currently effective coordinates.

    Performance invariant: ONE SQL query per param_id per call (never per slice).

    Args:
        param_id: Workspace-prefixed parameter ID (required)
        core_hash: Structured signature string (optional filter)
        slice_keys: Slice key filters (optional, None = all slices)
        anchor_from: Optional anchor_day lower bound (inclusive)
        anchor_to: Optional anchor_day upper bound (inclusive)
        limit: Hard cap on distinct timestamps (default 200)

    Returns:
        Dict with:
        - success: bool
        - retrieved_at: List[str] (distinct ISO datetimes, descending)
        - retrieved_days: List[str] (distinct ISO dates, descending; derived from retrieved_at)
        - latest_retrieved_at: str | None
        - count: int (number of retrieved_at values)
        - error: str (if success=False)
    """
    # Defensive clamp: avoid pathological result sizes.
    try:
        limit_i = int(limit)
    except Exception:
        limit_i = 200
    limit_i = max(1, min(limit_i, 2000))

    conn = get_db_connection()
    try:
        cur = conn.cursor()

        # Defensive: treat inverted anchor bounds as unordered.
        if anchor_from is not None and anchor_to is not None and anchor_from > anchor_to:
            anchor_from, anchor_to = anchor_to, anchor_from

        # READ CONTRACT (key-fixes.md §2.2):
        # - When core_hash is provided, snapshot read identity must NOT depend on param_id
        #   bucketing (repo/branch). The logical key is:
        #     normalised slice family × core_hash (optionally expanded by equivalence) × retrieved_at.
        # - param_id remains meaningful for:
        #   - write identity / audit
        #   - scoping WHICH equivalence links apply (the link graph is per param_id)
        #
        # Therefore:
        # - If core_hash is provided: we NEVER filter snapshots by param_id.
        # - If core_hash is omitted: we fall back to strict param_id scoping (inventory-by-param).
        where_clauses: List[str] = []
        params: List[Any] = []

        if core_hash:
            if include_equivalents:
                where_clauses.append("core_hash IN (SELECT core_hash FROM eq)")
            else:
                where_clauses.append("core_hash = %s")
                params.append(core_hash)
        else:
            where_clauses.append("param_id = %s")
            params.append(param_id)

        if slice_keys is not None:
            _append_slice_filter_sql(sql_parts=where_clauses, params=params, slice_keys=slice_keys)

        if anchor_from is not None:
            where_clauses.append("anchor_day >= %s")
            params.append(anchor_from)

        if anchor_to is not None:
            where_clauses.append("anchor_day <= %s")
            params.append(anchor_to)

        where_sql = " AND ".join(where_clauses)

        if core_hash and include_equivalents:
            if include_summary:
                select_sql = f"""
                SELECT
                  retrieved_at,
                  slice_key,
                  MIN(anchor_day) AS anchor_from,
                  MAX(anchor_day) AS anchor_to,
                  COUNT(*) AS row_count,
                  COALESCE(SUM(X), 0) AS sum_x,
                  COALESCE(SUM(Y), 0) AS sum_y
                FROM snapshots
                WHERE {where_sql}
                GROUP BY retrieved_at, slice_key
                ORDER BY retrieved_at DESC, slice_key
                LIMIT %s
                """
            else:
                select_sql = f"""
                SELECT DISTINCT retrieved_at
                FROM snapshots
                WHERE {where_sql}
                ORDER BY retrieved_at DESC
                LIMIT %s
                """
            query = f"""
            WITH RECURSIVE eq(core_hash) AS (
              SELECT %s::text
              UNION
              SELECT
                CASE WHEN e.core_hash = eq.core_hash THEN e.equivalent_to ELSE e.core_hash END
              FROM signature_equivalence e
              JOIN eq ON (e.core_hash = eq.core_hash OR e.equivalent_to = eq.core_hash)
              WHERE e.active = true AND e.operation = 'equivalent'
            )
            {select_sql}
            """
            params2 = [core_hash] + params + [limit_i]
            cur.execute(query, tuple(params2))
        else:
            if include_summary:
                cur.execute(
                    f"""
                    SELECT
                      retrieved_at,
                      slice_key,
                      MIN(anchor_day) AS anchor_from,
                      MAX(anchor_day) AS anchor_to,
                      COUNT(*) AS row_count,
                      COALESCE(SUM(X), 0) AS sum_x,
                      COALESCE(SUM(Y), 0) AS sum_y
                    FROM snapshots
                    WHERE {where_sql}
                    GROUP BY retrieved_at, slice_key
                    ORDER BY retrieved_at DESC, slice_key
                    LIMIT %s
                    """,
                    tuple(params + [limit_i])
                )
            else:
                # Distinct retrievals bounded by limit, most recent first.
                cur.execute(
                    f"""
                    SELECT DISTINCT retrieved_at
                    FROM snapshots
                    WHERE {where_sql}
                    ORDER BY retrieved_at DESC
                    LIMIT %s
                    """,
                    tuple(params + [limit_i])
                )

        rows = cur.fetchall()
        if include_summary:
            summary = []
            for r in rows:
                if not r or r[0] is None:
                    continue
                summary.append({
                    "retrieved_at": r[0].isoformat(),
                    "slice_key": r[1] or '',
                    "anchor_from": r[2].isoformat() if r[2] else None,
                    "anchor_to": r[3].isoformat() if r[3] else None,
                    "row_count": int(r[4] or 0),
                    "sum_x": int(r[5] or 0),
                    "sum_y": int(r[6] or 0),
                })
            retrieved_ats = [s["retrieved_at"] for s in summary]
        else:
            retrieved_ats = [r[0].isoformat() for r in rows if r and r[0] is not None]
            summary = None

        retrieved_days = sorted({ts.split('T')[0] for ts in retrieved_ats}, reverse=True)

        out = {
            'success': True,
            'retrieved_at': retrieved_ats,
            'retrieved_days': retrieved_days,
            'latest_retrieved_at': retrieved_ats[0] if retrieved_ats else None,
            'count': len(retrieved_ats),
        }
        if summary is not None:
            out["summary"] = summary
        return out
    except Exception as e:
        return {
            'success': False,
            'retrieved_at': [],
            'retrieved_days': [],
            'latest_retrieved_at': None,
            'count': 0,
            'error': str(e),
        }
    finally:
        conn.close()


# =============================================================================
# Phase 2b: Batch Retrieval Days — per-param retrieved_day list in one query
# =============================================================================

def query_batch_retrieval_days(
    param_ids: List[str],
    limit_per_param: int = 200,
) -> Dict[str, List[str]]:
    """
    Return distinct retrieved_day (UTC date) per param_id in a single query.

    Used by the aggregate as-at calendar when no edge is selected: the frontend
    computes per-day coverage = (params with data) / (total params).

    No core_hash filtering — this gives the broadest "any snapshots exist?" view.

    Args:
        param_ids: Workspace-prefixed parameter IDs
        limit_per_param: Hard cap on distinct days per param (default 200)

    Returns:
        Dict keyed by param_id → sorted list of ISO date strings (descending).
    """
    if not param_ids:
        return {}

    limit_per_param = max(1, min(int(limit_per_param or 200), 2000))

    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT param_id,
                   (retrieved_at AT TIME ZONE 'UTC')::date AS retrieved_day
            FROM snapshots
            WHERE param_id = ANY(%s)
            GROUP BY param_id, (retrieved_at AT TIME ZONE 'UTC')::date
            ORDER BY param_id, retrieved_day DESC
            """,
            (param_ids,),
        )
        result: Dict[str, List[str]] = {pid: [] for pid in param_ids}
        for row in cur.fetchall():
            pid = str(row[0])
            day_iso = row[1].isoformat() if row[1] else None
            if pid in result and day_iso and len(result[pid]) < limit_per_param:
                result[pid].append(day_iso)
        return result
    except Exception as e:
        print(f"[query_batch_retrieval_days] Error: {e}")
        return {pid: [] for pid in param_ids}
    finally:
        conn.close()


# =============================================================================
# Phase 3: Virtual Snapshot (asat) — Latest-per-anchor_day as-of
# =============================================================================

def query_virtual_snapshot(
    param_id: str,
    as_at: datetime,
    anchor_from: date,
    anchor_to: date,
    core_hash: str,
    slice_keys: Optional[List[str]] = None,
    include_equivalents: bool = True,
    limit: int = 10000
) -> Dict[str, Any]:
    """
    Query a "virtual snapshot" from the database: the latest row per anchor_day
    (and per slice_key) as-of a given timestamp.
    
    This implements the asat() DSL function for historical queries.
    
    Performance invariant: executes at most ONE SQL query per param_id (not per slice).
    
    Args:
        param_id: Workspace-prefixed parameter ID (required)
        as_at: Point-in-time for snapshot retrieval (required)
        anchor_from: Start of anchor date range (required)
        anchor_to: End of anchor date range (required)
        core_hash: Short signature key (REQUIRED for semantic integrity)
        slice_keys: List of slice keys to include (optional, None = all)
        include_equivalents: If True, expand equivalence links before matching core_hash
        limit: Maximum rows to return (default 10000)
    
    Returns:
        Dict with:
        - success: bool
        - rows: List of virtual snapshot rows (one per anchor_day × slice_key)
        - count: int (number of rows)
        - latest_retrieved_at_used: str | None (max retrieved_at among selected rows)
        - has_anchor_to: bool (whether anchor_to is covered in the result)
        - error: str (if success=False)
    """
    # Defensive: treat inverted anchor bounds as unordered.
    if anchor_from > anchor_to:
        anchor_from, anchor_to = anchor_to, anchor_from

    conn = get_db_connection()
    try:
        cur = conn.cursor()
        
        # Build WHERE clause for base filter.
        #
        # DESIGN (docs/current/project-db/completed/key-fixes.md §2.2):
        # Read identity must not depend on param_id (repo/branch). When core_hash is
        # provided, we match by hash family (optionally with equivalence) + slice family
        # + retrieved_at discriminator.
        where_clauses = [
            "retrieved_at <= %s",
            "anchor_day >= %s",
            "anchor_day <= %s"
        ]
        params: List[Any] = [as_at, anchor_from, anchor_to]

        if slice_keys is not None:
            _append_slice_filter_sql(sql_parts=where_clauses, params=params, slice_keys=slice_keys)

        where_sql = " AND ".join(where_clauses)

        if include_equivalents:
            # Equivalence closure (undirected graph) is resolved inside the same SQL query.
            where_match_sql = where_sql + " AND core_hash IN (SELECT core_hash FROM eq)"
        else:
            where_match_sql = where_sql + " AND core_hash = %s"

        # Single-query virtual snapshot + mismatch detection.
        # ranked: latest row per (anchor_day, LOGICAL slice family) as-of as_at.
        #
        # IMPORTANT:
        # We match slice_keys by normalising window/cohort args, so the "latest wins" ranking
        # must also be applied across that same logical slice key; otherwise multiple historic
        # window/cohort argument variants can yield multiple rows for the same slice family.
        # We then select only rows matching the requested core_hash, but we also compute:
        # - has_any_rows: whether ANY virtual rows exist for this param/window (any core_hash)
        # - has_matching_core_hash: whether ANY virtual rows exist for the requested core_hash
        # This allows the caller to treat signature mismatch as a hard failure.
        if include_equivalents:
            query = f"""
            WITH RECURSIVE eq(core_hash) AS (
              SELECT %s::text
              UNION
              SELECT
                CASE WHEN e.core_hash = eq.core_hash THEN e.equivalent_to ELSE e.core_hash END
              FROM signature_equivalence e
              JOIN eq ON (e.core_hash = eq.core_hash OR e.equivalent_to = eq.core_hash)
              WHERE e.active = true AND e.operation = 'equivalent'
            ),
            ranked_match AS (
                SELECT
                    anchor_day,
                    slice_key,
                    core_hash,
                    retrieved_at,
                    A as a, X as x, Y as y,
                    median_lag_days,
                    mean_lag_days,
                    anchor_median_lag_days,
                    anchor_mean_lag_days,
                    onset_delta_days,
                    ROW_NUMBER() OVER (
                        PARTITION BY anchor_day, {_partition_key_match_sql_expr()}
                        ORDER BY retrieved_at DESC, param_id DESC
                    ) AS rn
                FROM snapshots
                WHERE {where_match_sql}
            )
            SELECT
                COALESCE(
                    jsonb_agg((to_jsonb(rm) - 'rn') ORDER BY rm.anchor_day, rm.slice_key)
                        FILTER (WHERE rm.rn = 1),
                    '[]'::jsonb
                ) AS rows,
                (SELECT COUNT(*) > 0 FROM snapshots WHERE {where_sql}) AS has_any_rows,
                (SELECT COUNT(*) > 0 FROM snapshots WHERE {where_match_sql}) AS has_matching_core_hash,
                MAX(rm.retrieved_at) FILTER (WHERE rm.rn = 1) AS latest_retrieved_at_used,
                COALESCE(BOOL_OR(rm.rn = 1 AND rm.anchor_day = %s), false) AS has_anchor_to
            FROM ranked_match rm
            """
        else:
            query = f"""
            WITH ranked_match AS (
                SELECT
                    anchor_day,
                    slice_key,
                    core_hash,
                    retrieved_at,
                    A as a, X as x, Y as y,
                    median_lag_days,
                    mean_lag_days,
                    anchor_median_lag_days,
                    anchor_mean_lag_days,
                    onset_delta_days,
                    ROW_NUMBER() OVER (
                        PARTITION BY anchor_day, {_partition_key_match_sql_expr()}
                        ORDER BY retrieved_at DESC, param_id DESC
                    ) AS rn
                FROM snapshots
                WHERE {where_match_sql}
            )
            SELECT
                COALESCE(
                    jsonb_agg((to_jsonb(rm) - 'rn') ORDER BY rm.anchor_day, rm.slice_key)
                        FILTER (WHERE rm.rn = 1),
                    '[]'::jsonb
                ) AS rows,
                (SELECT COUNT(*) > 0 FROM snapshots WHERE {where_sql}) AS has_any_rows,
                (SELECT COUNT(*) > 0 FROM snapshots WHERE {where_match_sql}) AS has_matching_core_hash,
                MAX(rm.retrieved_at) FILTER (WHERE rm.rn = 1) AS latest_retrieved_at_used,
                COALESCE(BOOL_OR(rm.rn = 1 AND rm.anchor_day = %s), false) AS has_anchor_to
            FROM ranked_match rm
            """

        # Params:
        # - ranked_match WHERE: base params + core_hash
        # - has_any_rows subquery: base params
        # - has_matching_core_hash subquery: base params + core_hash
        # - has_anchor_to comparison: anchor_to
        if include_equivalents:
            # eq CTE needs: seed core_hash
            # ranked_match WHERE: base params
            # has_any_rows: base params
            # has_matching_core_hash: base params
            # has_anchor_to: anchor_to
            params2 = (
                [core_hash] +
                params +
                params +
                params +
                [anchor_to]
            )
        else:
            params2 = (
                params + [core_hash] +
                params +
                params + [core_hash] +
                [anchor_to]
            )

        cur.execute(query, params2)
        row = cur.fetchone()
        if not row:
            return {
                'success': True,
                'rows': [],
                'count': 0,
                'latest_retrieved_at_used': None,
                'has_anchor_to': False,
                'has_any_rows': False,
                'has_matching_core_hash': False,
            }

        rows_json, has_any_rows, has_matching_core_hash, latest_retrieved_at_used, has_anchor_to = row
        # psycopg2 may return jsonb as str unless JSON adapters are registered.
        if isinstance(rows_json, (bytes, bytearray)):
            rows_json = rows_json.decode('utf-8')
        if isinstance(rows_json, str):
            try:
                rows_out = json.loads(rows_json)
            except Exception:
                rows_out = []
        elif isinstance(rows_json, list):
            rows_out = rows_json
        else:
            rows_out = rows_json or []

        return {
            'success': True,
            'rows': rows_out,
            'count': len(rows_out),
            'latest_retrieved_at_used': latest_retrieved_at_used.isoformat() if hasattr(latest_retrieved_at_used, 'isoformat') else latest_retrieved_at_used,
            'has_anchor_to': bool(has_anchor_to),
            'has_any_rows': bool(has_any_rows),
            'has_matching_core_hash': bool(has_matching_core_hash),
        }
        
    except Exception as e:
        return {
            'success': False,
            'rows': [],
            'count': 0,
            'latest_retrieved_at_used': None,
            'has_anchor_to': False,
            'error': str(e)
        }
    finally:
        conn.close()


# =============================================================================
# Flexible signatures: signature registry + equivalence link routes
# =============================================================================


def list_signatures(
    *,
    param_id: Optional[str] = None,
    param_id_prefix: Optional[str] = None,
    graph_name: Optional[str] = None,
    list_params: bool = False,
    limit: int = 200,
    include_inputs: bool = False
) -> Dict[str, Any]:
    """List signature_registry rows for a param_id (newest first).

    Extended modes:
    - list_params=True: return distinct param_ids with summary counts instead of individual rows.
      Supports param_id_prefix for workspace scoping and graph_name for provenance filtering.
    - graph_name: filter by inputs_json->'provenance'->>'graph_name' (JSONB).
    """
    limit_i = max(1, min(int(limit or 200), 2000))
    conn = get_db_connection()
    try:
        cur = conn.cursor()

        # ── Mode: list distinct param_ids ────────────────────────────────────
        if list_params:
            where_clauses: List[str] = []
            params_list: List[Any] = []

            if param_id_prefix:
                where_clauses.append("param_id LIKE %s")
                params_list.append(param_id_prefix + "%")
            if graph_name:
                where_clauses.append("inputs_json->'provenance'->>'graph_name' = %s")
                params_list.append(graph_name)

            where_sql = (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
            cur.execute(
                f"""
                SELECT param_id,
                       COUNT(*) AS signature_count,
                       MAX(created_at) AS latest_created_at,
                       MIN(created_at) AS earliest_created_at
                FROM signature_registry
                {where_sql}
                GROUP BY param_id
                ORDER BY MAX(created_at) DESC
                LIMIT %s
                """,
                tuple(params_list + [limit_i]),
            )
            rows = cur.fetchall()
            out = []
            for (pid, sig_count, latest, earliest) in rows:
                out.append({
                    "param_id": str(pid),
                    "signature_count": int(sig_count),
                    "latest_created_at": latest.isoformat().replace("+00:00", "Z") if hasattr(latest, "isoformat") else str(latest),
                    "earliest_created_at": earliest.isoformat().replace("+00:00", "Z") if hasattr(earliest, "isoformat") else str(earliest),
                })
            return {"success": True, "params": out, "count": len(out)}

        # ── Mode: list signatures for a specific param_id ────────────────────
        if not param_id:
            raise ValueError("Either param_id or list_params=True is required")

        where_clauses = ["param_id = %s"]
        params_list = [param_id]

        if graph_name:
            where_clauses.append("inputs_json->'provenance'->>'graph_name' = %s")
            params_list.append(graph_name)

        where_sql = " AND ".join(where_clauses)

        if include_inputs:
            cur.execute(
                f"""
                SELECT param_id, core_hash, created_at, canonical_signature, canonical_sig_hash_full, sig_algo, inputs_json
                FROM signature_registry
                WHERE {where_sql}
                ORDER BY created_at DESC
                LIMIT %s
                """,
                tuple(params_list + [limit_i]),
            )
        else:
            cur.execute(
                f"""
                SELECT param_id, core_hash, created_at, canonical_signature, canonical_sig_hash_full, sig_algo
                FROM signature_registry
                WHERE {where_sql}
                ORDER BY created_at DESC
                LIMIT %s
                """,
                tuple(params_list + [limit_i]),
            )
        rows = cur.fetchall()
        out = []
        for row in rows:
            if include_inputs:
                pid, ch, created_at, canonical_signature, full_hash, sig_algo, inputs_json = row
            else:
                pid, ch, created_at, canonical_signature, full_hash, sig_algo = row
                inputs_json = None
            out.append(
                {
                    "param_id": str(pid),
                    "core_hash": str(ch),
                    "created_at": created_at.isoformat().replace("+00:00", "Z") if hasattr(created_at, "isoformat") else str(created_at),
                    "canonical_signature": canonical_signature,
                    "canonical_sig_hash_full": full_hash,
                    "sig_algo": sig_algo,
                    "inputs_json": inputs_json,
                }
            )
        return {"success": True, "rows": out, "count": len(out)}
    except Exception as e:
        return {"success": False, "rows": [], "count": 0, "error": str(e)}
    finally:
        conn.close()


def get_signature(
    *,
    param_id: str,
    core_hash: str
) -> Dict[str, Any]:
    """Get a single signature_registry row."""
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT param_id, core_hash, created_at, canonical_signature, canonical_sig_hash_full, sig_algo, inputs_json
            FROM signature_registry
            WHERE param_id = %s AND core_hash = %s
            """,
            (param_id, core_hash),
        )
        row = cur.fetchone()
        if not row:
            return {"success": False, "error": "not_found"}
        pid, ch, created_at, canonical_signature, full_hash, sig_algo, inputs_json = row
        return {
            "success": True,
            "row": {
                "param_id": str(pid),
                "core_hash": str(ch),
                "created_at": created_at.isoformat().replace("+00:00", "Z") if hasattr(created_at, "isoformat") else str(created_at),
                "canonical_signature": canonical_signature,
                "canonical_sig_hash_full": full_hash,
                "sig_algo": sig_algo,
                "inputs_json": inputs_json,
            },
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        conn.close()


def list_equivalence_links(
    *,
    param_id: str,
    core_hash: Optional[str] = None,
    include_inactive: bool = False,
    limit: int = 500
) -> Dict[str, Any]:
    """List signature_equivalence edges for a param_id (optionally filtered to touching core_hash)."""
    limit_i = max(1, min(int(limit or 500), 5000))
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        where = ["param_id = %s"]
        params: List[Any] = [param_id]
        if core_hash:
            where.append("(core_hash = %s OR equivalent_to = %s)")
            params.extend([core_hash, core_hash])
        if not include_inactive:
            where.append("active = true")
        where_sql = " AND ".join(where)
        cur.execute(
            f"""
            SELECT param_id, core_hash, equivalent_to, created_at, created_by, reason, active,
                   operation, weight, source_param_id
            FROM signature_equivalence
            WHERE {where_sql}
            ORDER BY created_at DESC
            LIMIT %s
            """,
            tuple(params + [limit_i]),
        )
        rows = cur.fetchall()
        out = []
        for row in rows:
            pid, ch, eq, created_at, created_by, reason, active, operation, weight, source_pid = row
            out.append(
                {
                    "param_id": str(pid),
                    "core_hash": str(ch),
                    "equivalent_to": str(eq),
                    "created_at": created_at.isoformat().replace("+00:00", "Z") if hasattr(created_at, "isoformat") else str(created_at),
                    "created_by": created_by,
                    "reason": reason,
                    "active": bool(active),
                    "operation": str(operation) if operation else "equivalent",
                    "weight": float(weight) if weight is not None else 1.0,
                    "source_param_id": str(source_pid) if source_pid else None,
                }
            )
        return {"success": True, "rows": out, "count": len(out)}
    except Exception as e:
        return {"success": False, "rows": [], "count": 0, "error": str(e)}
    finally:
        conn.close()


def create_equivalence_link(
    *,
    param_id: str,
    core_hash: str,
    equivalent_to: str,
    created_by: str,
    reason: str,
    operation: str = "equivalent",
    weight: float = 1.0,
    source_param_id: Optional[str] = None
) -> Dict[str, Any]:
    """Create/activate an equivalence or transform link (idempotent).

    Args:
        operation: 'equivalent' (default, undirected identity), 'sum', 'average',
                   'weighted_average', 'first', 'last'.
        weight: For weighted operations; ignored for 'equivalent'.
        source_param_id: For cross-param transforms; NULL means same as param_id.
    """
    if core_hash == equivalent_to and (source_param_id is None or source_param_id == param_id):
        return {"success": False, "error": "self_link_not_allowed"}
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO signature_equivalence
              (param_id, core_hash, equivalent_to, created_by, reason, active, operation, weight, source_param_id)
            VALUES (%s, %s, %s, %s, %s, true, %s, %s, %s)
            ON CONFLICT (param_id, core_hash, equivalent_to)
            DO UPDATE SET active = true, reason = EXCLUDED.reason, created_by = EXCLUDED.created_by,
                          operation = EXCLUDED.operation, weight = EXCLUDED.weight, source_param_id = EXCLUDED.source_param_id
            """,
            (param_id, core_hash, equivalent_to, created_by, reason, operation, weight, source_param_id),
        )
        conn.commit()
        return {"success": True}
    except Exception as e:
        conn.rollback()
        return {"success": False, "error": str(e)}
    finally:
        conn.close()


def deactivate_equivalence_link(
    *,
    param_id: str,
    core_hash: str,
    equivalent_to: str,
    created_by: str,
    reason: str
) -> Dict[str, Any]:
    """Deactivate an equivalence link (soft delete, audit preserved)."""
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE signature_equivalence
            SET active = false, created_by = %s, reason = %s
            WHERE param_id = %s AND core_hash = %s AND equivalent_to = %s
            """,
            (created_by, reason, param_id, core_hash, equivalent_to),
        )
        conn.commit()
        return {"success": True}
    except Exception as e:
        conn.rollback()
        return {"success": False, "error": str(e)}
    finally:
        conn.close()


def resolve_equivalent_hashes(
    *,
    param_id: str,
    core_hash: str,
    include_equivalents: bool = True
) -> Dict[str, Any]:
    """Resolve equivalence closure for a (param_id, core_hash).

    Returns:
        Dict with:
        - core_hashes: list of core_hash strings in the closure
        - param_ids: list of param_id strings to search (seed + any source_param_ids)
        - count: number of core_hashes
    """
    if not include_equivalents:
        return {"success": True, "core_hashes": [core_hash], "param_ids": [param_id], "count": 1}
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            WITH RECURSIVE eq(core_hash, source_param_id) AS (
              SELECT %s::text, %s::text
              UNION
              SELECT
                CASE WHEN e.core_hash = eq.core_hash THEN e.equivalent_to ELSE e.core_hash END,
                COALESCE(e.source_param_id, e.param_id)
              FROM signature_equivalence e
              JOIN eq ON (e.core_hash = eq.core_hash OR e.equivalent_to = eq.core_hash)
              WHERE e.active = true AND e.operation = 'equivalent'
            )
            SELECT DISTINCT core_hash, source_param_id FROM eq
            """,
            (core_hash, param_id),
        )
        rows = cur.fetchall()
        hashes = sorted({str(r[0]) for r in rows if r and r[0]})
        param_ids = sorted({str(r[1]) for r in rows if r and r[1]})
        if core_hash not in hashes:
            hashes = [core_hash] + hashes
        if param_id not in param_ids:
            param_ids = [param_id] + param_ids
        return {"success": True, "core_hashes": hashes, "param_ids": param_ids, "count": len(hashes)}
    except Exception as e:
        return {"success": False, "core_hashes": [core_hash], "param_ids": [param_id], "count": 1, "error": str(e)}
    finally:
        conn.close()
