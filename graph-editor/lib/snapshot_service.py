"""
Snapshot DB Service

Handles all database operations for the snapshot feature.
Provides shadow-write capability to persist time-series data to Neon PostgreSQL.

Design reference: docs/current/project-db/snapshot-db-design.md
"""

import os
import json
import psycopg2
from psycopg2.extras import execute_values
from typing import List, Dict, Any, Optional
from datetime import date, datetime


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


def append_snapshots(
    param_id: str,
    core_hash: str,
    context_def_hashes: Optional[str],  # JSON string or None
    slice_key: str,
    retrieved_at: datetime,
    rows: List[Dict[str, Any]],
    diagnostic: bool = False
) -> Dict[str, Any]:
    """
    Append snapshot rows to the database.
    
    This is the primary write operation for shadow-writing time-series data
    after successful fetches from Amplitude or other data sources.
    
    Args:
        param_id: Workspace-prefixed parameter ID (e.g., 'repo-branch-param-id')
        core_hash: Query signature hash for semantic matching
        context_def_hashes: JSON string of context def hashes (for audit/future strict matching)
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
        >>> result = append_snapshots('repo-main-my-param', 'abc123', None, '', now, rows, diagnostic=True)
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
        
        values = [
            (
                param_id,
                core_hash,
                context_def_hashes,
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
                onset_delta_days
            ) VALUES %s
            ON CONFLICT (param_id, core_hash, slice_key, anchor_day, retrieved_at)
            DO NOTHING
            RETURNING 1
            """,
            values,
            fetch=True
        )
        
        inserted = len(result_rows) if result_rows else 0
        conn.commit()
        
        sql_time_ms = (time.time() - start_time) * 1000
        
        result = {"success": True, "inserted": inserted}
        
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

def query_snapshots(
    param_id: str,
    core_hash: Optional[str] = None,
    slice_keys: Optional[List[str]] = None,
    anchor_from: Optional[date] = None,
    anchor_to: Optional[date] = None,
    as_at: Optional[datetime] = None,
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
            WHERE param_id = %s
        """
        params: List[Any] = [param_id]
        
        if core_hash is not None:
            query += " AND core_hash = %s"
            params.append(core_hash)
        
        if slice_keys is not None:
            query += " AND slice_key = ANY(%s)"
            params.append(slice_keys)
        
        if anchor_from is not None:
            query += " AND anchor_day >= %s"
            params.append(anchor_from)
        
        if anchor_to is not None:
            query += " AND anchor_day <= %s"
            params.append(anchor_to)
        
        if as_at is not None:
            query += " AND retrieved_at <= %s"
            params.append(as_at)
        
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


def delete_snapshots(param_id: str) -> Dict[str, Any]:
    """
    Delete all snapshots for a specific parameter.
    
    Used by the "Delete snapshots (X)" UI feature.
    
    Args:
        param_id: Exact workspace-prefixed parameter ID to delete
    
    Returns:
        Dict with:
        - success: bool
        - deleted: int (rows deleted)
        - error: str (if success=False)
    """
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM snapshots WHERE param_id = %s", (param_id,))
        deleted = cur.rowcount
        conn.commit()
        return {'success': True, 'deleted': deleted}
    except Exception as e:
        return {'success': False, 'deleted': 0, 'error': str(e)}
    finally:
        conn.close()
