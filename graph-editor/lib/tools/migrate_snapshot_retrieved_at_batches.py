"""
Migration: coalesce snapshots.retrieved_at into atomic batch timestamps.

Purpose
-------
Historic snapshot rows were written with per-subwrite retrieved_at timestamps.
We want retrieved_at to be a batch discriminator: stable across all writes for a
single retrieval batch.

This script:
- clusters retrieved_at values into Δ windows per (param_id, core_hash, slice_family)
- computes target batch timestamp = cluster MIN(retrieved_at)
- deletes post-coalesce duplicates that would violate the unique key
  (keep latest original retrieved_at within each would-collide set)
- updates remaining rows to the target batch timestamp

Safety posture
--------------
- DRY RUN by default (no writes)
- requires bounded scope (param_id prefix or explicit param_id) to commit
- supports retrieved_at time bounds to run in small segments
- runs each segment in a single transaction
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime
from typing import Optional, Tuple


def _parse_dt(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    # Accept either "2026-02-09T10:17:17Z" or "+00:00" forms
    text = str(s).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text)


def _require_bounded_scope(args: argparse.Namespace) -> None:
    if args.param_id or args.param_id_prefix:
        return
    raise SystemExit("Refusing to run without bounded scope: provide --param-id or --param-id-prefix")


def _build_where_filters(args: argparse.Namespace) -> Tuple[str, list]:
    parts = []
    params = []

    if args.param_id:
        parts.append("param_id = %s")
        params.append(args.param_id)
    elif args.param_id_prefix:
        parts.append("param_id LIKE %s")
        params.append(args.param_id_prefix + "%")

    if args.retrieved_from:
        parts.append("retrieved_at >= %s")
        params.append(args.retrieved_from)
    if args.retrieved_to:
        parts.append("retrieved_at < %s")
        params.append(args.retrieved_to)

    where_sql = " AND ".join(parts) if parts else "TRUE"
    return where_sql, params


def _list_param_ids(*, conn, args: argparse.Namespace) -> list[str]:
    """
    Resolve the set of param_ids to process.

    Safety rule:
    - In COMMIT mode, we process FULL HISTORY per param_id (no retrieved_at windowing),
      because windowing can split clusters across segment boundaries and break idempotence.
    - retrieved-from/to are only used as an optional *selector* for which param_ids to include.
    """
    cur = conn.cursor()

    if args.param_id:
        return [args.param_id]

    if not args.param_id_prefix:
        return []

    # Candidate selection query (may use retrieved_at bounds to reduce the set).
    parts = ["param_id LIKE %s"]
    params: list = [args.param_id_prefix + "%"]
    if args.retrieved_from:
        parts.append("retrieved_at >= %s")
        params.append(args.retrieved_from)
    if args.retrieved_to:
        parts.append("retrieved_at < %s")
        params.append(args.retrieved_to)
    where_sql = " AND ".join(parts)

    cur.execute(
        f"""
        SELECT DISTINCT param_id
        FROM snapshots
        WHERE {where_sql}
        ORDER BY param_id
        """,
        tuple(params),
    )
    return [str(r[0]) for r in cur.fetchall() if r and r[0]]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Coalesce snapshots.retrieved_at to atomic batch timestamps (Δ-window clustering)."
    )
    parser.add_argument("--param-id", dest="param_id", default=None, help="Exact param_id to migrate")
    parser.add_argument(
        "--param-id-prefix",
        dest="param_id_prefix",
        default=None,
        help="Prefix for param_id (e.g. 'nous-conversion-main-')",
    )
    parser.add_argument(
        "--retrieved-from",
        dest="retrieved_from",
        type=_parse_dt,
        default=None,
        help="Lower bound on retrieved_at (inclusive), ISO datetime",
    )
    parser.add_argument(
        "--retrieved-to",
        dest="retrieved_to",
        type=_parse_dt,
        default=None,
        help="Upper bound on retrieved_at (exclusive), ISO datetime",
    )
    parser.add_argument(
        "--window-seconds",
        dest="window_seconds",
        type=int,
        default=120,
        help="Δ window in seconds for clustering (default 120s)",
    )
    parser.add_argument(
        "--commit",
        dest="commit",
        action="store_true",
        help="Apply changes (default is dry-run)",
    )
    parser.add_argument(
        "--lock-timeout-ms",
        dest="lock_timeout_ms",
        type=int,
        default=2000,
        help="DB lock_timeout in ms (default 2000)",
    )
    parser.add_argument(
        "--statement-timeout-ms",
        dest="statement_timeout_ms",
        type=int,
        default=0,
        help="DB statement_timeout in ms (0 means no timeout)",
    )
    parser.add_argument(
        "--allow-delete-identical",
        dest="allow_delete_identical",
        action="store_true",
        help="Allow deleting post-coalesce duplicates ONLY when payload is identical. "
             "If not set, any required deletion will abort COMMIT.",
    )
    args = parser.parse_args()

    _require_bounded_scope(args)

    if args.window_seconds < 1 or args.window_seconds > 3600:
        raise SystemExit("--window-seconds must be between 1 and 3600")

    # Import inside main so this script can be referenced without importing psycopg2 at import time.
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from snapshot_service import get_db_connection, _slice_key_match_sql_expr  # type: ignore

    # The slice-family normalisation used for matching/partitioning (must match read path).
    slice_norm_sql = _slice_key_match_sql_expr()

    # The clustering logic:
    # - partition by (param_id, core_hash, slice_norm)
    # - order by retrieved_at
    # - start new cluster when gap > Δ
    # - cluster_min = MIN(retrieved_at) over cluster
    #
    # Collision handling:
    # - if multiple rows would map to the same (param_id, core_hash, slice_key, anchor_day, cluster_min),
    #   delete all but the latest original retrieved_at row (keep rn_keep=1 ordering by retrieved_at DESC).
    #
    # NOTE: We join back on the current unique key including retrieved_at to ensure 1:1 mapping.

    # Payload identity key used to validate that any deletions are true duplicates.
    # This must cover every semantic column in snapshots, excluding retrieved_at itself.
    payload_sql = (
        "md5("
        "COALESCE(context_def_hashes::text,'') || '|' || "
        "COALESCE(A::text,'') || '|' || COALESCE(X::text,'') || '|' || COALESCE(Y::text,'') || '|' || "
        "COALESCE(median_lag_days::text,'') || '|' || COALESCE(mean_lag_days::text,'') || '|' || "
        "COALESCE(anchor_median_lag_days::text,'') || '|' || COALESCE(anchor_mean_lag_days::text,'') || '|' || "
        "COALESCE(onset_delta_days::text,'')"
        ")"
    )

    analysis_sql = f"""
    WITH base AS (
      SELECT
        param_id,
        core_hash,
        slice_key,
        {slice_norm_sql} AS slice_norm,
        anchor_day,
        retrieved_at,
        {payload_sql} AS payload_key
      FROM snapshots
      WHERE {{where_sql}}
    ),
    marked AS (
      SELECT
        *,
        CASE
          WHEN LAG(retrieved_at) OVER (PARTITION BY param_id, core_hash, slice_norm ORDER BY retrieved_at) IS NULL THEN 1
          WHEN retrieved_at - LAG(retrieved_at) OVER (PARTITION BY param_id, core_hash, slice_norm ORDER BY retrieved_at)
               > (%s * INTERVAL '1 second') THEN 1
          ELSE 0
        END AS is_new_cluster
      FROM base
    ),
    clustered AS (
      SELECT
        *,
        SUM(is_new_cluster) OVER (PARTITION BY param_id, core_hash, slice_norm ORDER BY retrieved_at) AS cluster_id
      FROM marked
    ),
    mapped AS (
      SELECT
        param_id,
        core_hash,
        slice_key,
        slice_norm,
        anchor_day,
        retrieved_at AS old_retrieved_at,
        payload_key,
        MIN(retrieved_at) OVER (PARTITION BY param_id, core_hash, slice_norm, cluster_id) AS new_retrieved_at
      FROM clustered
    ),
    duped AS (
      SELECT
        *,
        ROW_NUMBER() OVER (
          PARTITION BY param_id, core_hash, slice_key, anchor_day, new_retrieved_at
          ORDER BY old_retrieved_at DESC
        ) AS rn_keep
      FROM mapped
    ),
    collisions AS (
      SELECT
        param_id, core_hash, slice_key, anchor_day, new_retrieved_at,
        COUNT(*) AS n,
        COUNT(DISTINCT payload_key) AS payload_variants
      FROM duped
      GROUP BY 1,2,3,4,5
      HAVING COUNT(*) > 1
    )
    SELECT
      COUNT(*)::bigint AS total_rows_in_scope,
      COUNT(*) FILTER (WHERE old_retrieved_at <> new_retrieved_at)::bigint AS rows_to_update,
      COUNT(*) FILTER (WHERE rn_keep > 1)::bigint AS rows_to_delete,
      COUNT(*) FILTER (WHERE payload_variants > 1)::bigint AS collision_sets_payload_diff,
      COUNT(DISTINCT (param_id, core_hash, slice_norm))::bigint AS groups_touched,
      COUNT(DISTINCT old_retrieved_at)::bigint AS distinct_retrieved_at_before,
      COUNT(DISTINCT new_retrieved_at)::bigint AS distinct_retrieved_at_after
    FROM duped
    LEFT JOIN collisions USING (param_id, core_hash, slice_key, anchor_day, new_retrieved_at)
    """

    payload_diff_check_sql = f"""
    WITH base AS (
      SELECT
        param_id,
        core_hash,
        slice_key,
        {slice_norm_sql} AS slice_norm,
        anchor_day,
        retrieved_at,
        {payload_sql} AS payload_key
      FROM snapshots
      WHERE {{where_sql}}
    ),
    marked AS (
      SELECT
        *,
        CASE
          WHEN LAG(retrieved_at) OVER (PARTITION BY param_id, core_hash, slice_norm ORDER BY retrieved_at) IS NULL THEN 1
          WHEN retrieved_at - LAG(retrieved_at) OVER (PARTITION BY param_id, core_hash, slice_norm ORDER BY retrieved_at)
               > (%s * INTERVAL '1 second') THEN 1
          ELSE 0
        END AS is_new_cluster
      FROM base
    ),
    clustered AS (
      SELECT
        *,
        SUM(is_new_cluster) OVER (PARTITION BY param_id, core_hash, slice_norm ORDER BY retrieved_at) AS cluster_id
      FROM marked
    ),
    mapped AS (
      SELECT
        param_id,
        core_hash,
        slice_key,
        slice_norm,
        anchor_day,
        retrieved_at AS old_retrieved_at,
        payload_key,
        MIN(retrieved_at) OVER (PARTITION BY param_id, core_hash, slice_norm, cluster_id) AS new_retrieved_at
      FROM clustered
    ),
    collisions AS (
      SELECT
        param_id, core_hash, slice_key, anchor_day, new_retrieved_at,
        COUNT(*) AS n,
        COUNT(DISTINCT payload_key) AS payload_variants
      FROM mapped
      GROUP BY 1,2,3,4,5
      HAVING COUNT(*) > 1
    )
    SELECT
      COUNT(*)::bigint AS collision_sets,
      COUNT(*) FILTER (WHERE payload_variants > 1)::bigint AS collision_sets_payload_diff
    FROM collisions;
    """

    delete_sql = f"""
    WITH base AS (
      SELECT
        param_id,
        core_hash,
        slice_key,
        {slice_norm_sql} AS slice_norm,
        anchor_day,
        retrieved_at,
        {payload_sql} AS payload_key
      FROM snapshots
      WHERE {{where_sql}}
    ),
    marked AS (
      SELECT
        *,
        CASE
          WHEN LAG(retrieved_at) OVER (PARTITION BY param_id, core_hash, slice_norm ORDER BY retrieved_at) IS NULL THEN 1
          WHEN retrieved_at - LAG(retrieved_at) OVER (PARTITION BY param_id, core_hash, slice_norm ORDER BY retrieved_at)
               > (%s * INTERVAL '1 second') THEN 1
          ELSE 0
        END AS is_new_cluster
      FROM base
    ),
    clustered AS (
      SELECT
        *,
        SUM(is_new_cluster) OVER (PARTITION BY param_id, core_hash, slice_norm ORDER BY retrieved_at) AS cluster_id
      FROM marked
    ),
    mapped AS (
      SELECT
        param_id,
        core_hash,
        slice_key,
        slice_norm,
        anchor_day,
        retrieved_at AS old_retrieved_at,
        payload_key,
        MIN(retrieved_at) OVER (PARTITION BY param_id, core_hash, slice_norm, cluster_id) AS new_retrieved_at
      FROM clustered
    ),
    duped AS (
      SELECT
        *,
        ROW_NUMBER() OVER (
          PARTITION BY param_id, core_hash, slice_key, anchor_day, new_retrieved_at
          ORDER BY old_retrieved_at DESC
        ) AS rn_keep
      FROM mapped
    ),
    collisions AS (
      SELECT
        param_id, core_hash, slice_key, anchor_day, new_retrieved_at,
        COUNT(*) AS n,
        COUNT(DISTINCT payload_key) AS payload_variants
      FROM duped
      GROUP BY 1,2,3,4,5
      HAVING COUNT(*) > 1
    ),
    to_delete AS (
      SELECT duped.param_id, duped.core_hash, duped.slice_key, duped.anchor_day, duped.old_retrieved_at
      FROM duped
      JOIN collisions c
        ON c.param_id = duped.param_id
       AND c.core_hash = duped.core_hash
       AND c.slice_key = duped.slice_key
       AND c.anchor_day = duped.anchor_day
       AND c.new_retrieved_at = duped.new_retrieved_at
      WHERE rn_keep > 1 AND c.payload_variants = 1
    )
    DELETE FROM snapshots s
    USING to_delete d
    WHERE s.param_id = d.param_id
      AND s.core_hash = d.core_hash
      AND s.slice_key = d.slice_key
      AND s.anchor_day = d.anchor_day
      AND s.retrieved_at = d.old_retrieved_at
    """

    update_sql = f"""
    WITH base AS (
      SELECT
        param_id,
        core_hash,
        slice_key,
        {slice_norm_sql} AS slice_norm,
        anchor_day,
        retrieved_at
      FROM snapshots
      WHERE {{where_sql}}
    ),
    marked AS (
      SELECT
        *,
        CASE
          WHEN LAG(retrieved_at) OVER (PARTITION BY param_id, core_hash, slice_norm ORDER BY retrieved_at) IS NULL THEN 1
          WHEN retrieved_at - LAG(retrieved_at) OVER (PARTITION BY param_id, core_hash, slice_norm ORDER BY retrieved_at)
               > (%s * INTERVAL '1 second') THEN 1
          ELSE 0
        END AS is_new_cluster
      FROM base
    ),
    clustered AS (
      SELECT
        *,
        SUM(is_new_cluster) OVER (PARTITION BY param_id, core_hash, slice_norm ORDER BY retrieved_at) AS cluster_id
      FROM marked
    ),
    mapped AS (
      SELECT
        param_id,
        core_hash,
        slice_key,
        slice_norm,
        anchor_day,
        retrieved_at AS old_retrieved_at,
        MIN(retrieved_at) OVER (PARTITION BY param_id, core_hash, slice_norm, cluster_id) AS new_retrieved_at
      FROM clustered
    ),
    to_update AS (
      SELECT param_id, core_hash, slice_key, anchor_day, old_retrieved_at, new_retrieved_at
      FROM mapped
      WHERE old_retrieved_at <> new_retrieved_at
    )
    UPDATE snapshots s
    SET retrieved_at = u.new_retrieved_at
    FROM to_update u
    WHERE s.param_id = u.param_id
      AND s.core_hash = u.core_hash
      AND s.slice_key = u.slice_key
      AND s.anchor_day = u.anchor_day
      AND s.retrieved_at = u.old_retrieved_at
    """

    conn = get_db_connection()
    try:
        conn.autocommit = False
        cur = conn.cursor()

        # Tight lock timeout to avoid wedging production; caller can override.
        cur.execute("SET lock_timeout = %s", (f"{int(args.lock_timeout_ms)}ms",))
        if args.statement_timeout_ms and int(args.statement_timeout_ms) > 0:
            cur.execute("SET statement_timeout = %s", (f"{int(args.statement_timeout_ms)}ms",))

        param_ids = _list_param_ids(conn=conn, args=args)
        if not param_ids:
            print("No param_ids matched scope.")
            conn.rollback()
            return 0

        print("=== migrate_snapshot_retrieved_at_batches ===")
        print(f"param_ids: {len(param_ids)}")
        if args.param_id_prefix:
            print(f"param_id_prefix: {args.param_id_prefix}")
        if args.retrieved_from or args.retrieved_to:
            print("NOTE: retrieved-from/to are only used to SELECT param_ids; COMMIT always processes full history per param_id.")
            print(f"retrieved_from: {args.retrieved_from}")
            print(f"retrieved_to:   {args.retrieved_to}")
        print(f"window_seconds: {args.window_seconds}")
        print(f"mode: {'COMMIT' if args.commit else 'DRY_RUN'}")

        total_deleted = 0
        total_updated = 0

        for pid in param_ids:
            # Per-param transaction: safer and avoids time-window cluster-splitting.
            where_sql, where_params = "param_id = %s", [pid]

            # Analyse first (always).
            cur.execute(analysis_sql.format(where_sql=where_sql), tuple(where_params + [args.window_seconds]))
            row = cur.fetchone()
            if not row or int(row[0] or 0) == 0:
                conn.rollback()
                continue

            (
                total_rows,
                rows_to_update,
                rows_to_delete,
                collision_sets_payload_diff,
                groups_touched,
                distinct_before,
                distinct_after,
            ) = row

            print("---")
            print(f"param_id: {pid}")
            print(f"total_rows_in_scope: {total_rows}")
            print(f"groups_touched: {groups_touched}")
            print(f"distinct_retrieved_at_before: {distinct_before}")
            print(f"distinct_retrieved_at_after:  {distinct_after}")
            print(f"rows_to_delete: {rows_to_delete}")
            print(f"rows_to_update: {rows_to_update}")
            if collision_sets_payload_diff:
                print(f"collision_sets_payload_diff: {collision_sets_payload_diff}")

            if not args.commit:
                conn.rollback()
                continue

            # Hard safety: do not proceed if any would-delete collision set has payload variance.
            cur.execute(
                payload_diff_check_sql.format(where_sql=where_sql),
                tuple(where_params + [args.window_seconds]),
            )
            chk = cur.fetchone()
            collision_sets = int(chk[0] or 0) if chk else 0
            payload_diff_sets = int(chk[1] or 0) if chk else 0
            if payload_diff_sets != 0:
                raise RuntimeError(
                    f"Refusing to commit for param_id={pid}: {payload_diff_sets}/{collision_sets} collision set(s) have payload variance"
                )

            if int(rows_to_delete or 0) > 0 and not args.allow_delete_identical:
                raise RuntimeError(
                    f"Refusing to commit for param_id={pid}: would delete {rows_to_delete} row(s). "
                    f"Re-run with --allow-delete-identical after reviewing."
                )

            # Delete duplicates, then update timestamps.
            cur.execute(delete_sql.format(where_sql=where_sql), tuple(where_params + [args.window_seconds]))
            deleted = int(cur.rowcount or 0)
            cur.execute(update_sql.format(where_sql=where_sql), tuple(where_params + [args.window_seconds]))
            updated = int(cur.rowcount or 0)

            # Re-run analysis to ensure fully canonicalised.
            cur.execute(analysis_sql.format(where_sql=where_sql), tuple(where_params + [args.window_seconds]))
            row2 = cur.fetchone()
            if not row2:
                raise RuntimeError(f"Post-migration analysis unexpectedly returned no row (param_id={pid})")
            rows_to_update_after = int(row2[1] or 0)
            rows_to_delete_after = int(row2[2] or 0)
            if rows_to_update_after != 0 or rows_to_delete_after != 0:
                raise RuntimeError(
                    f"Post-migration param not fully canonicalised (param_id={pid}): "
                    f"rows_to_update={rows_to_update_after}, rows_to_delete={rows_to_delete_after}"
                )

            conn.commit()
            total_deleted += deleted
            total_updated += updated
            print(f"committed_deleted_rows: {deleted}")
            print(f"committed_updated_rows: {updated}")

        if args.commit:
            print("===")
            print(f"TOTAL committed_deleted_rows: {total_deleted}")
            print(f"TOTAL committed_updated_rows: {total_updated}")
        return 0
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    finally:
        try:
            conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())

