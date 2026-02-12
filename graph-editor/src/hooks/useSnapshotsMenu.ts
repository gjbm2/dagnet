/**
 * useSnapshotsMenu Hook
 *
 * Centralised hook for snapshot inventory + delete + download operations.
 * UI components should only call this hook and render results.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useDialog } from '../contexts/DialogContext';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import {
  deleteSnapshots as deleteSnapshotsApi,
  getBatchInventoryV2,
  querySnapshotsFull,
  type SnapshotInventory,
  type SnapshotInventoryV2Param,
  type SnapshotQueryRow,
} from '../services/snapshotWriteService';
import type { ClosureEntry } from '../services/hashMappingsService';
import { getClosureSet } from '../services/hashMappingsService';
import { downloadTextFile } from '../services/downloadService';
import { sessionLogService } from '../services/sessionLogService';
import { invalidateInventoryCache } from './useEdgeSnapshotInventory';
import { fileRegistry } from '../contexts/TabContext';

// -----------------------------------------------------------------------------
// Hover-driven inventory caching (menu + tooltip)
// -----------------------------------------------------------------------------
// Without caching, pointer jitter can spam the backend with inventory calls.
// We cache per (dbParamId, current_signature) and de-dupe in-flight fetches.
const INVENTORY_TTL_MS = 15_000;
type InventoryCacheEntry = { atMs: number; inv: SnapshotInventoryV2Param | undefined };
const inventoryV2CacheByKey = new Map<string, InventoryCacheEntry>();
const inventoryV2PendingByKey = new Map<string, Promise<SnapshotInventoryV2Param | undefined>>();

function cacheKeyForInventory(dbParamId: string, currentSignature: string | undefined): string {
  return `${dbParamId}::${(currentSignature || '').trim()}`;
}

function getCachedInventoryV2(dbParamId: string, currentSignature: string | undefined): SnapshotInventoryV2Param | undefined | null {
  const key = cacheKeyForInventory(dbParamId, currentSignature);
  const hit = inventoryV2CacheByKey.get(key);
  if (!hit) return null;
  if (Date.now() - hit.atMs > INVENTORY_TTL_MS) {
    inventoryV2CacheByKey.delete(key);
    return null;
  }
  return hit.inv;
}

function invalidateSnapshotsMenuInventory(dbParamId: string) {
  // Invalidate all signatures for this param id (cohort/window etc.)
  for (const k of Array.from(inventoryV2CacheByKey.keys())) {
    if (k.startsWith(`${dbParamId}::`)) inventoryV2CacheByKey.delete(k);
  }
  for (const k of Array.from(inventoryV2PendingByKey.keys())) {
    if (k.startsWith(`${dbParamId}::`)) inventoryV2PendingByKey.delete(k);
  }
}

/** Test/support helper: clear hover inventory caches. */
export function clearSnapshotsMenuInventoryCache(): void {
  inventoryV2CacheByKey.clear();
  inventoryV2PendingByKey.clear();
}

export interface UseSnapshotsMenuResult {
  /** Snapshot inventories keyed by objectId (unprefixed, e.g. parameter ID) */
  inventories: Record<string, SnapshotInventory>;
  /** Snapshot counts (distinct retrieval DAYS) keyed by objectId */
  snapshotCounts: Record<string, number>;
  /** Matched core_hashes per objectId (from current signature's family). Empty array if no match. */
  matchedCoreHashes: Record<string, string[]>;
  /** Whether a delete operation is in flight */
  isDeleting: boolean;
  /** Whether a download operation is in flight */
  isDownloading: boolean;
  /** Refresh all inventories and counts */
  refresh: () => Promise<void>;
  /** Delete snapshots for a single objectId, optionally scoped to core_hashes (with confirm) */
  deleteSnapshots: (objectId: string, core_hashes?: string[]) => Promise<boolean>;
  /** Delete snapshots for multiple objectIds param-wide (single confirm) */
  deleteSnapshotsMany: (objectIds: string[]) => Promise<boolean>;
  /** Download a CSV for an objectId, optionally scoped to core_hashes */
  downloadSnapshotData: (objectId: string, core_hashes?: string[]) => Promise<boolean>;
  /** Download a single CSV for multiple objectIds param-wide (concatenated rows) */
  downloadSnapshotDataMany: (objectIds: string[], filenameHint: string) => Promise<boolean>;
}

export interface UseSnapshotsMenuOptions {
  /**
   * If true (default), inventories are fetched automatically when inputs change.
   * If false, caller must invoke `refresh()` (e.g. on hover).
   */
  autoFetch?: boolean;
}

function buildDbParamId(objectId: string, repo: string, branch: string): string {
  return `${repo}-${branch}-${objectId}`;
}

function resolveWorkspaceForParam(objectId: string, fallbackRepo: string, fallbackBranch: string): { repo: string; branch: string } {
  // Source of truth: parameter file source (matches snapshot write path in dataOperationsService).
  const pf = fileRegistry.getFile(`parameter-${objectId}`) as any;
  const repo = String(pf?.source?.repository || fallbackRepo || '').trim();
  const branch = String(pf?.source?.branch || fallbackBranch || '').trim();
  return {
    repo,
    branch: branch || 'main',
  };
}

function latestQuerySignatureForParam(objectId: string): string | undefined {
  const pf = fileRegistry.getFile(`parameter-${objectId}`) as any;
  const values: any[] = Array.isArray(pf?.data?.values) ? pf.data.values : [];
  const withSig = values.filter((v) => typeof v?.query_signature === 'string' && v.query_signature.trim());
  if (withSig.length === 0) return undefined;
  const getTs = (v: any) => String(v?.data_source?.retrieved_at || v?.window_to || v?.window_from || '');
  withSig.sort((a, b) => getTs(b).localeCompare(getTs(a)));
  return String(withSig[0].query_signature);
}

function sanitiseFilenamePart(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const SNAPSHOT_EXPORT_COLUMNS: Array<keyof SnapshotQueryRow> = [
  'param_id',
  'core_hash',
  'slice_key',
  'anchor_day',
  'retrieved_at',
  'a',
  'x',
  'y',
  'median_lag_days',
  'mean_lag_days',
  'anchor_median_lag_days',
  'anchor_mean_lag_days',
  'onset_delta_days',
];

function rowsToCsv(rows: SnapshotQueryRow[]): string {
  const header = SNAPSHOT_EXPORT_COLUMNS.join(',');
  const lines = rows.map((row) => SNAPSHOT_EXPORT_COLUMNS.map((k) => csvCell((row as any)[k])).join(','));
  return [header, ...lines].join('\n');
}

async function queryAllRowsForParam(
  dbParamId: string,
  expectedRowCount: number,
  core_hash?: string,
  equivalent_hashes?: ClosureEntry[],
): Promise<{
  ok: boolean;
  rows: SnapshotQueryRow[];
  truncated: boolean;
  error?: string;
}> {
  // Safety: keep downloads bounded in the browser.
  const hardCap = 500_000;
  const limit = Math.max(0, Math.min(expectedRowCount || 0, hardCap));
  const truncated = (expectedRowCount || 0) > hardCap;

  const resp = await querySnapshotsFull({
    param_id: dbParamId,
    core_hash,
    limit: limit > 0 ? limit : undefined,
    ...(equivalent_hashes && equivalent_hashes.length > 0
      ? { equivalent_hashes }
      : {}),
  });

  if (!resp.success) {
    return { ok: false, rows: [], truncated: false, error: resp.error || 'query failed' };
  }
  return { ok: true, rows: resp.rows, truncated };
}

/**
 * Hook to manage snapshot operations for multiple object IDs (typically parameter IDs).
 */
export function useSnapshotsMenu(objectIds: string[], options: UseSnapshotsMenuOptions = {}): UseSnapshotsMenuResult {
  const ids = useMemo(() => Array.from(new Set(objectIds.filter(Boolean))), [objectIds.join(',')]);
  const autoFetch = options.autoFetch !== false;

  const [inventories, setInventories] = useState<Record<string, SnapshotInventory>>({});
  const [snapshotCounts, setSnapshotCounts] = useState<Record<string, number>>({});
  const [matchedCoreHashes, setMatchedCoreHashes] = useState<Record<string, string[]>>({});
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  const { showConfirm } = useDialog();
  const { state: navState } = useNavigatorContext();
  const repo = navState.selectedRepo;
  const branch = navState.selectedBranch || 'main';

  const refresh = useCallback(async () => {
    if (ids.length === 0) {
      setInventories({});
      setSnapshotCounts({});
      return;
    }

    const workspaceById = Object.fromEntries(
      ids.map((id) => [id, resolveWorkspaceForParam(id, repo, branch)] as const)
    ) as Record<string, { repo: string; branch: string }>;

    const dbParamIds = ids
      .map((id) => {
        const ws = workspaceById[id];
        return ws?.repo ? buildDbParamId(id, ws.repo, ws.branch) : null;
      })
      .filter(Boolean) as string[];

    if (dbParamIds.length === 0) {
      setInventories({});
      setSnapshotCounts({});
      return;
    }
    try {
      const current_signatures: Record<string, string> = {};
      const sigByDbParamId: Record<string, string | undefined> = {};
      for (const objectId of ids) {
        const ws = workspaceById[objectId] || resolveWorkspaceForParam(objectId, repo, branch);
        if (!ws?.repo) continue;
        const dbParamId = buildDbParamId(objectId, ws.repo, ws.branch);
        const sig = latestQuerySignatureForParam(objectId);
        sigByDbParamId[dbParamId] = sig;
        if (sig) current_signatures[dbParamId] = sig;
      }

      // Cache + in-flight de-dupe: fetch only for cache misses / expired entries.
      const invByDbParamId: Record<string, SnapshotInventoryV2Param | undefined> = {};
      const awaited: Array<Promise<void>> = [];
      const backendFetchedDbParamIds = new Set<string>();

      for (const dbParamId of dbParamIds) {
        const sig = sigByDbParamId[dbParamId];
        const cached = getCachedInventoryV2(dbParamId, sig);
        if (cached !== null) {
          invByDbParamId[dbParamId] = cached || undefined;
          continue;
        }

        const key = cacheKeyForInventory(dbParamId, sig);
        const pending = inventoryV2PendingByKey.get(key);
        if (pending) {
          awaited.push(
            pending.then((inv) => {
              invByDbParamId[dbParamId] = inv;
            })
          );
          continue;
        }

        backendFetchedDbParamIds.add(dbParamId);
        const p = (async () => {
          const res = await getBatchInventoryV2([dbParamId], { current_signatures: sig ? { [dbParamId]: sig } : {} });
          return res[dbParamId] as SnapshotInventoryV2Param | undefined;
        })();
        inventoryV2PendingByKey.set(key, p);
        awaited.push(
          p.then((inv) => {
            inventoryV2CacheByKey.set(key, { atMs: Date.now(), inv });
            inventoryV2PendingByKey.delete(key);
            invByDbParamId[dbParamId] = inv;
          }).catch(() => {
            inventoryV2PendingByKey.delete(key);
          })
        );
      }

      if (awaited.length > 0) {
        await Promise.all(awaited);
      }
      const nextInventories: Record<string, SnapshotInventory> = {};
      const nextCounts: Record<string, number> = {};
      const nextMatchedCoreHashes: Record<string, string[]> = {};

      for (const objectId of ids) {
        const ws = workspaceById[objectId] || resolveWorkspaceForParam(objectId, repo, branch);
        if (!ws?.repo) continue;
        const dbParamId = buildDbParamId(objectId, ws.repo, ws.branch);
        const inv = invByDbParamId[dbParamId] as SnapshotInventoryV2Param | undefined;
        const overallAll = inv?.overall_all_families;
        if (overallAll) {
          // Prefer the matched family (current query signature) over overall-all-families.
          const current = inv?.current;
          const matchedFamilyId = current?.matched_family_id || null;
          const families = Array.isArray(inv?.families) ? inv!.families : [];
          const matchedFamily = matchedFamilyId ? families.find((f) => f.family_id === matchedFamilyId) : undefined;

          // Source for inventory: matched family *only when it actually has data*.
          //
          // Rationale:
          // - It's common for "current signature" to point at a hash that is not yet present in snapshots
          //   (e.g. user changes context/window before any snapshot write for that exact signature).
          // - In that case we MUST still show that snapshots exist for the parameter overall.
          const matchedFamilyWithData =
            matchedFamily && (matchedFamily.overall?.row_count ?? 0) > 0 ? matchedFamily : undefined;
          const matchedHasData = !!matchedFamilyWithData;
          const source = matchedFamilyWithData ? matchedFamilyWithData.overall : overallAll;

          // Session logging:
          // - By default, hover inventory should be a single-line log with no huge context payload.
          // - Full debug payload is ONLY appropriate when diagnostic logging is enabled (?sessionlogdiag).
          //
          // Also, avoid spamming logs on pure cache hits.
          const diag =
            typeof (sessionLogService as any).getDiagnosticLoggingEnabled === 'function'
              ? sessionLogService.getDiagnosticLoggingEnabled()
              : false;
          const fetchedThisRefresh = backendFetchedDbParamIds.has(dbParamId);
          if (diag || fetchedThisRefresh) {
            try {
              if (diag) {
                const debugPayload = {
                  objectId,
                  dbParamId,
                  cached: !fetchedThisRefresh,
                  workspace: { repo: ws.repo, branch: ws.branch },
                  current: inv?.current || null,
                  overall_all_families: overallAll,
                  matched_family_id: inv?.current?.matched_family_id || null,
                  matched_family_overall: matchedFamily?.overall || null,
                  matchedHasData,
                  chosen: matchedHasData ? 'matched_family' : 'overall_all_families',
                  chosen_row_count: source.row_count,
                  chosen_unique_retrieved_days: source.unique_retrieved_days,
                };
                // eslint-disable-next-line no-console
                console.log('[SnapshotsMenu] inventory', debugPayload);
                sessionLogService.info(
                  'data-fetch',
                  'SNAPSHOT_INVENTORY_MENU',
                  `Snapshot inventory: ${objectId} → ${source.unique_retrieved_days ?? 0} day(s)`,
                  undefined,
                  debugPayload as any
                );
              } else {
                sessionLogService.info(
                  'data-fetch',
                  'SNAPSHOT_INVENTORY_MENU',
                  `Snapshot inventory: ${objectId} → ${source.unique_retrieved_days ?? 0} day(s)`
                );
              }
            } catch {
              // ignore
            }
          }

          nextInventories[objectId] = {
            has_data: source.row_count > 0,
            param_id: dbParamId,
            // Show retrieved_at range (when snapshots were taken), not anchor_day range.
            earliest: source.earliest_retrieved_at,
            latest: source.latest_retrieved_at,
            row_count: source.row_count,
            unique_days: source.unique_anchor_days,
            unique_slices: 0,
            unique_hashes: 0,
            unique_retrievals: source.unique_retrievals,
            unique_retrieved_days: source.unique_retrieved_days,
          };

          // User meaning of "snapshots": one per retrieved DAY.
          if (matchedHasData) {
            nextCounts[objectId] = matchedFamilyWithData?.overall?.unique_retrieved_days ?? 0;
            // Expose the family's core_hashes for scoped delete/download.
            nextMatchedCoreHashes[objectId] = Array.isArray(matchedFamilyWithData?.member_core_hashes)
              ? matchedFamilyWithData!.member_core_hashes
              : [];
          } else {
            // If we have history but current signature does not match, do NOT show 0.
            nextCounts[objectId] = overallAll.unique_retrieved_days ?? 0;
            nextMatchedCoreHashes[objectId] = [];
          }
        } else {
          nextInventories[objectId] = {
            has_data: false,
            param_id: dbParamId,
            earliest: null,
            latest: null,
            row_count: 0,
            unique_days: 0,
            unique_slices: 0,
            unique_hashes: 0,
            unique_retrievals: 0,
          };
          nextCounts[objectId] = 0;
          nextMatchedCoreHashes[objectId] = [];
        }
      }

      setInventories(nextInventories);
      setSnapshotCounts(nextCounts);
      setMatchedCoreHashes(nextMatchedCoreHashes);
    } catch (error) {
      console.error('[useSnapshotsMenu] Failed to fetch inventory:', error);
    }
  }, [repo, branch, ids.join(',')]);

  useEffect(() => {
    if (!autoFetch) return;
    void refresh();
  }, [refresh, autoFetch]);

  const deleteSnapshotsMany = useCallback(
    async (toDelete: string[]): Promise<boolean> => {
      if (!repo) return false;
      const unique = Array.from(new Set((toDelete || []).filter(Boolean)));
      if (unique.length === 0) return false;

      const counts = unique.map((id) => snapshotCounts[id] ?? 0);
      const totalRetrievals = counts.reduce((a, b) => a + b, 0);
      const anyWithData = counts.some((c) => c > 0);
      if (!anyWithData) return false;

      const messageLines: string[] = [];
      for (let i = 0; i < unique.length; i++) {
        const id = unique[i];
        const c = counts[i];
        if (c > 0) {
          messageLines.push(`- ${id}: ${c} snapshot retrieval${c !== 1 ? 's' : ''}`);
        }
      }

      const confirmed = await showConfirm({
        title: unique.length === 1 ? 'Delete Snapshots' : 'Delete All Snapshots',
        message:
          (unique.length === 1
            ? `Delete ${totalRetrievals} snapshot retrieval${totalRetrievals !== 1 ? 's' : ''} for "${unique[0]}"?\n\n`
            : `Delete ${totalRetrievals} snapshot retrieval${totalRetrievals !== 1 ? 's' : ''} across ${unique.length} parameter${unique.length !== 1 ? 's' : ''}?\n\n`) +
          messageLines.join('\n') +
          `\n\nThis removes historical time-series data and cannot be undone.`,
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
        confirmVariant: 'danger',
      });

      if (!confirmed) return false;

      setIsDeleting(true);
      const opId = sessionLogService.startOperation(
        'info',
        'data-update',
        unique.length === 1 ? 'SNAPSHOT_DELETE' : 'SNAPSHOT_DELETE_ALL',
        unique.length === 1 ? `Deleting snapshots for ${unique[0]}` : `Deleting snapshots for ${unique.length} parameters`
      );

      try {
        let deletedTotal = 0;
        for (const objectId of unique) {
          const expected = snapshotCounts[objectId] ?? 0;
          if (!expected) continue;

          const ws = resolveWorkspaceForParam(objectId, repo, branch);
          const dbParamId = buildDbParamId(objectId, ws.repo, ws.branch);
          sessionLogService.addChild(opId, 'info', 'SNAPSHOT_DELETE_PARAM', `Deleting snapshots for ${objectId}`, undefined, {
            dbParamId,
            expectedCount: expected,
          });

          const result = await deleteSnapshotsApi(dbParamId); // param-wide: no core_hash filter
          if (!result.success) {
            sessionLogService.addChild(opId, 'error', 'SNAPSHOT_DELETE_PARAM_FAILED', `Failed to delete snapshots for ${objectId}`, result.error, {
              dbParamId,
            });
            toast.error(`Failed to delete snapshots for ${objectId}: ${result.error || 'unknown error'}`);
            continue;
          }

          deletedTotal += result.deleted || 0;
          invalidateInventoryCache(dbParamId);
          invalidateSnapshotsMenuInventory(dbParamId);
          setSnapshotCounts((prev) => ({ ...prev, [objectId]: 0 }));
        }

        // Refresh inventories so badges/menus update cleanly
        await refresh();

        toast.success(
          unique.length === 1
            ? `Deleted snapshots for ${unique[0]}`
            : `Deleted snapshots for ${unique.length} parameters`
        );

        sessionLogService.endOperation(opId, 'success', `Deleted ${deletedTotal} snapshot row${deletedTotal !== 1 ? 's' : ''}`);
        return true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        sessionLogService.endOperation(opId, 'error', `Snapshot delete error: ${errorMessage}`);
        toast.error(`Failed to delete snapshots: ${errorMessage}`);
        return false;
      } finally {
        setIsDeleting(false);
      }
    },
    [repo, branch, snapshotCounts, showConfirm, refresh]
  );

  const deleteSnapshots = useCallback(
    async (objectId: string, core_hashes?: string[]): Promise<boolean> => {
      if (!repo) return false;
      if (!objectId) return false;

      const count = snapshotCounts[objectId] ?? 0;
      if (count <= 0) return false;

      const scoped = core_hashes && core_hashes.length > 0;
      const confirmed = await showConfirm({
        title: 'Delete Snapshots',
        message:
          `Delete ${count} snapshot retrieval${count !== 1 ? 's' : ''} for "${objectId}"${scoped ? ' (current signature)' : ''}?\n\n` +
          `This removes historical time-series data and cannot be undone.`,
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
        confirmVariant: 'danger',
      });

      if (!confirmed) return false;

      setIsDeleting(true);
      const opId = sessionLogService.startOperation('info', 'data-update', 'SNAPSHOT_DELETE', `Deleting snapshots for ${objectId}`);

      try {
        const ws = resolveWorkspaceForParam(objectId, repo, branch);
        const dbParamId = buildDbParamId(objectId, ws.repo, ws.branch);
        sessionLogService.addChild(opId, 'info', 'SNAPSHOT_DELETE_PARAM', `Deleting snapshots for ${objectId}`, undefined, {
          dbParamId,
          scoped,
          core_hashes: core_hashes ?? null,
        });

        const result = scoped
          ? await deleteSnapshotsApi(dbParamId, core_hashes!)
          : await deleteSnapshotsApi(dbParamId);
        if (!result.success) {
          sessionLogService.addChild(opId, 'error', 'SNAPSHOT_DELETE_PARAM_FAILED', `Failed to delete snapshots for ${objectId}`, result.error, { dbParamId });
          toast.error(`Failed to delete snapshots for ${objectId}: ${result.error || 'unknown error'}`);
          sessionLogService.endOperation(opId, 'error', result.error || 'unknown');
          return false;
        }

        invalidateInventoryCache(dbParamId);
        invalidateSnapshotsMenuInventory(dbParamId);
        setSnapshotCounts((prev) => ({ ...prev, [objectId]: 0 }));
        await refresh();
        toast.success(`Deleted snapshots for ${objectId}`);
        sessionLogService.endOperation(opId, 'success', `Deleted ${result.deleted || 0} snapshot row${(result.deleted || 0) !== 1 ? 's' : ''}`);
        return true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        sessionLogService.endOperation(opId, 'error', `Snapshot delete error: ${errorMessage}`);
        toast.error(`Failed to delete snapshots: ${errorMessage}`);
        return false;
      } finally {
        setIsDeleting(false);
      }
    },
    [repo, branch, snapshotCounts, showConfirm, refresh]
  );

  const downloadSnapshotDataMany = useCallback(
    async (toDownload: string[], filenameHint: string): Promise<boolean> => {
      if (!repo) return false;
      const unique = Array.from(new Set((toDownload || []).filter(Boolean)));
      if (unique.length === 0) return false;

      // Only download params that actually have data
      const candidates = unique.filter((id) => (inventories[id]?.row_count ?? 0) > 0);
      if (candidates.length === 0) return false;

      setIsDownloading(true);
      const opId = sessionLogService.startOperation(
        'info',
        'data-fetch',
        unique.length === 1 ? 'SNAPSHOT_DOWNLOAD' : 'SNAPSHOT_DOWNLOAD_ALL',
        unique.length === 1 ? `Downloading snapshots for ${unique[0]}` : `Downloading snapshots for ${candidates.length} parameters`
      );

      try {
        const allRows: SnapshotQueryRow[] = [];
        let anyTruncated = false;

        for (const objectId of candidates) {
          const inv = inventories[objectId];
          const expectedRows = inv?.row_count ?? 0;
          const ws = resolveWorkspaceForParam(objectId, repo, branch);
          const dbParamId = buildDbParamId(objectId, ws.repo, ws.branch);

          sessionLogService.addChild(opId, 'info', 'SNAPSHOT_QUERY_FULL', `Querying snapshot rows for ${objectId}`, undefined, {
            dbParamId,
            expectedRows,
          });

          const q = await queryAllRowsForParam(dbParamId, expectedRows);
          if (!q.ok) {
            sessionLogService.addChild(opId, 'error', 'SNAPSHOT_QUERY_FULL_FAILED', `Query failed for ${objectId}`, q.error, {
              dbParamId,
            });
            toast.error(`Failed to download snapshots for ${objectId}: ${q.error || 'query failed'}`);
            continue;
          }

          allRows.push(...q.rows);
          anyTruncated = anyTruncated || q.truncated;
        }

        const csv = rowsToCsv(allRows);
        const safeHint = sanitiseFilenamePart(filenameHint) || 'snapshots';
        const safeRepo = sanitiseFilenamePart(repo);
        const safeBranch = sanitiseFilenamePart(branch);
        const filename = `${safeRepo}-${safeBranch}-${safeHint}.csv`;

        downloadTextFile({ filename, content: csv, mimeType: 'text/csv' });

        if (anyTruncated) {
          toast.error('Snapshot export truncated (too many rows)');
          sessionLogService.addChild(opId, 'warning', 'SNAPSHOT_DOWNLOAD_TRUNCATED', 'Snapshot export truncated due to row cap');
        } else {
          toast.success('Downloaded snapshot CSV');
        }

        sessionLogService.endOperation(opId, 'success', `Downloaded ${allRows.length} row${allRows.length !== 1 ? 's' : ''}`);
        return true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        sessionLogService.endOperation(opId, 'error', `Snapshot download error: ${errorMessage}`);
        toast.error(`Failed to download snapshot CSV: ${errorMessage}`);
        return false;
      } finally {
        setIsDownloading(false);
      }
    },
    [repo, branch, inventories]
  );

  const downloadSnapshotData = useCallback(
    async (objectId: string, core_hashes?: string[]): Promise<boolean> => {
      if (!repo) return false;
      if (!objectId) return false;

      const inv = inventories[objectId];
      const expectedRows = inv?.row_count ?? 0;
      if (expectedRows <= 0) return false;

      const scoped = core_hashes && core_hashes.length > 0;

      // If downloading for a specific hash that has equivalents, offer the user a choice.
      let closureForDownload: ClosureEntry[] | undefined;
      if (scoped && core_hashes!.length === 1) {
        const closure = getClosureSet(core_hashes![0]);
        if (closure.length > 0) {
          const includeEquivalents = await showConfirm({
            title: 'Include equivalent signatures?',
            message: `This signature has ${closure.length} equivalent hash${closure.length === 1 ? '' : 'es'}.\n\nInclude rows from equivalent signatures in the download?`,
            confirmLabel: 'Include equivalents',
            cancelLabel: 'Seed hash only',
          });
          if (includeEquivalents) {
            closureForDownload = closure;
          }
        }
      }

      setIsDownloading(true);
      const opId = sessionLogService.startOperation('info', 'data-fetch', 'SNAPSHOT_DOWNLOAD', `Downloading snapshots for ${objectId}`);

      try {
        const ws = resolveWorkspaceForParam(objectId, repo, branch);
        const dbParamId = buildDbParamId(objectId, ws.repo, ws.branch);
        const allRows: SnapshotQueryRow[] = [];
        let anyTruncated = false;

        if (scoped) {
          // Download rows for each core_hash in the family separately (query-full takes single core_hash).
          for (const ch of core_hashes!) {
            sessionLogService.addChild(opId, 'info', 'SNAPSHOT_QUERY_FULL', `Querying snapshot rows for ${objectId} (core_hash=${ch.substring(0, 8)}…)`, undefined, {
              dbParamId,
              core_hash: ch,
            });
            const q = await queryAllRowsForParam(dbParamId, expectedRows, ch, closureForDownload);
            if (!q.ok) {
              sessionLogService.addChild(opId, 'error', 'SNAPSHOT_QUERY_FULL_FAILED', `Query failed for ${objectId}`, q.error, { dbParamId });
              toast.error(`Failed to download snapshots for ${objectId}: ${q.error || 'query failed'}`);
              continue;
            }
            allRows.push(...q.rows);
            anyTruncated = anyTruncated || q.truncated;
          }
        } else {
          // Param-wide download: no core_hash filter.
          sessionLogService.addChild(opId, 'info', 'SNAPSHOT_QUERY_FULL', `Querying all snapshot rows for ${objectId}`, undefined, {
            dbParamId,
            expectedRows,
          });
          const q = await queryAllRowsForParam(dbParamId, expectedRows);
          if (!q.ok) {
            sessionLogService.addChild(opId, 'error', 'SNAPSHOT_QUERY_FULL_FAILED', `Query failed for ${objectId}`, q.error, { dbParamId });
            toast.error(`Failed to download snapshots for ${objectId}: ${q.error || 'query failed'}`);
            sessionLogService.endOperation(opId, 'error', q.error || 'query failed');
            return false;
          }
          allRows.push(...q.rows);
          anyTruncated = q.truncated;
        }

        const safeId = sanitiseFilenamePart(objectId) || 'param';
        const safeRepo = sanitiseFilenamePart(repo);
        const safeBranch = sanitiseFilenamePart(branch);
        const filename = `${safeRepo}-${safeBranch}-snapshots-${safeId}.csv`;

        const csv = rowsToCsv(allRows);
        downloadTextFile({ filename, content: csv, mimeType: 'text/csv' });

        if (anyTruncated) {
          toast.error('Snapshot export truncated (too many rows)');
          sessionLogService.addChild(opId, 'warning', 'SNAPSHOT_DOWNLOAD_TRUNCATED', 'Snapshot export truncated due to row cap');
        } else {
          toast.success('Downloaded snapshot CSV');
        }

        sessionLogService.endOperation(opId, 'success', `Downloaded ${allRows.length} row${allRows.length !== 1 ? 's' : ''}`);
        return true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        sessionLogService.endOperation(opId, 'error', `Snapshot download error: ${errorMessage}`);
        toast.error(`Failed to download snapshot CSV: ${errorMessage}`);
        return false;
      } finally {
        setIsDownloading(false);
      }
    },
    [repo, branch, inventories]
  );

  return {
    inventories,
    snapshotCounts,
    matchedCoreHashes,
    isDeleting,
    isDownloading,
    refresh,
    deleteSnapshots,
    deleteSnapshotsMany,
    downloadSnapshotData,
    downloadSnapshotDataMany,
  };
}

