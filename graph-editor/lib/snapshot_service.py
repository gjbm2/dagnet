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
        
        execute_values(
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
            """,
            values
        )
        
        inserted = cur.rowcount
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
