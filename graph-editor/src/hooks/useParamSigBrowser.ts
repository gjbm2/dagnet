/**
 * useParamSigBrowser — encapsulates one "half" of the Snapshot Manager's
 * param + signature browsing state.  Called twice in the orchestrator
 * (primary and secondary panels).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { sessionLogService } from '../services/sessionLogService';
import {
  listEquivalenceLinks,
  listSignatures,
  resolveEquivalentHashes,
  type SigEquivalenceLinkRow,
  type SigParamSummary,
  type SigRegistryRow,
} from '../services/signatureLinksApi';
import {
  getBatchInventoryV2,
  type SnapshotInventoryV2Param,
} from '../services/snapshotWriteService';

// ─── Shared types & helpers ──────────────────────────────────────────────────

/** Per-core_hash stats derived from inventory data. */
export interface SigStats {
  snapshots: number;
  earliest: string | null;
  latest: string | null;
  rowCount: number;
  slices: number;
}

/** Detect query mode from canonical signature or inputs_json. */
export function detectQueryMode(row: SigRegistryRow): 'cohort' | 'window' | 'unknown' {
  const sig = row.canonical_signature || '';
  const sliceKey = row.inputs_json?.summary?.slice_key || '';
  const text = `${sig} ${sliceKey}`;
  if (text.includes('cohort(') || text.includes('"cohort"')) return 'cohort';
  if (text.includes('window(') || text.includes('"window"')) return 'window';
  return 'unknown';
}

// ─── Hook interface ──────────────────────────────────────────────────────────

export interface ParamSigBrowserOptions {
  workspacePrefix: string;
  dbParams: SigParamSummary[];
  graphParamIds: Set<string> | null;
  currentCoreHash?: string | null;
}

export interface ParamSigBrowserState {
  paramFilter: string;
  setParamFilter: (v: string) => void;
  selectedParamId: string | null;
  setSelectedParamId: (v: string | null) => void;
  isLoading: boolean;
  filteredParams: SigParamSummary[];

  registryRows: SigRegistryRow[];
  linkRows: SigEquivalenceLinkRow[];
  sigStatsMap: Map<string, SigStats>;
  displayRows: SigRegistryRow[];
  summary: { totalSnapshots: number; linkedSnapshots: number; unlinkedCount: number; unlinkedSnapshots: number };

  queryModeFilter: 'all' | 'cohort' | 'window';
  setQueryModeFilter: (v: 'all' | 'cohort' | 'window') => void;
  sortOrder: 'newest' | 'oldest' | 'most-data';
  setSortOrder: (v: 'newest' | 'oldest' | 'most-data') => void;

  selectedHash: string | null;
  setSelectedHash: (v: string | null) => void;
  selectedRow: SigRegistryRow | null;
  resolvedClosure: string[];
  linkedHashes: Set<string>;

  /** Queue a hash to be auto-selected once signatures finish loading. */
  setPendingHash: (hash: string) => void;

  loadSignatures: () => Promise<void>;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useParamSigBrowser(options: ParamSigBrowserOptions): ParamSigBrowserState {
  const { workspacePrefix, dbParams, graphParamIds, currentCoreHash = null } = options;

  const [paramFilter, setParamFilter] = useState('');
  const [selectedParamId, setSelectedParamId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [registryRows, setRegistryRows] = useState<SigRegistryRow[]>([]);
  const [linkRows, setLinkRows] = useState<SigEquivalenceLinkRow[]>([]);
  const [sigStatsMap, setSigStatsMap] = useState<Map<string, SigStats>>(new Map());
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [resolvedClosure, setResolvedClosure] = useState<string[]>([]);
  const [queryModeFilter, setQueryModeFilter] = useState<'all' | 'cohort' | 'window'>('all');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest' | 'most-data'>('newest');

  // Pending hash (for selecting a hash after a param switch triggers a reload)
  const pendingSelectHash = useRef<string | null>(null);
  const setPendingHash = useCallback((hash: string) => { pendingSelectHash.current = hash; }, []);

  useEffect(() => {
    if (!pendingSelectHash.current) return;
    const match = registryRows.find((r) => r.core_hash === pendingSelectHash.current);
    if (match) {
      setSelectedHash(match.core_hash);
      pendingSelectHash.current = null;
    }
  }, [registryRows]);

  // Filtered param list
  const filteredParams = useMemo(() => {
    let result = dbParams;
    if (graphParamIds) {
      result = result.filter((p) => graphParamIds.has(p.param_id));
    }
    const q = paramFilter.trim().toLowerCase();
    if (q) {
      result = result.filter((p) => p.param_id.toLowerCase().includes(q));
    }
    return result;
  }, [dbParams, paramFilter, graphParamIds]);

  // Load signatures + links + inventory for selected param
  const loadSignatures = useCallback(async () => {
    if (!selectedParamId) return;
    setIsLoading(true);
    const opId = sessionLogService.startOperation('info', 'session', 'SIGS_REFRESH', `Loading signatures for ${selectedParamId}`);
    try {
      const [regRes, linksRes, inventoryRes] = await Promise.all([
        listSignatures({ param_id: selectedParamId, include_inputs: true, limit: 500 }),
        listEquivalenceLinks({ param_id: selectedParamId, include_inactive: false, limit: 2000 }),
        getBatchInventoryV2([selectedParamId]).catch(() => ({} as Record<string, SnapshotInventoryV2Param>)),
      ]);
      if (!regRes.success) throw new Error(regRes.error || 'listSignatures failed');
      if (!linksRes.success) throw new Error(linksRes.error || 'listEquivalenceLinks failed');

      setRegistryRows(regRes.rows);
      setLinkRows(linksRes.rows);

      const statsMap = new Map<string, SigStats>();
      const inv = inventoryRes[selectedParamId];
      if (inv) {
        for (const family of inv.families) {
          for (const hash of family.member_core_hashes) {
            statsMap.set(hash, {
              snapshots: family.overall.unique_retrieved_days,
              earliest: family.overall.earliest_retrieved_at,
              latest: family.overall.latest_retrieved_at,
              rowCount: family.overall.row_count,
              slices: (family.by_slice_key || []).length,
            });
          }
        }
      }
      setSigStatsMap(statsMap);
      sessionLogService.endOperation(opId, 'success', `Loaded ${regRes.count} sigs + ${linksRes.count} links`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to load signatures: ${msg}`);
      sessionLogService.endOperation(opId, 'error', msg);
    } finally {
      setIsLoading(false);
    }
  }, [selectedParamId]);

  // Reset selection on param change, then load
  useEffect(() => {
    setSelectedHash(null);
    setResolvedClosure([]);
    void loadSignatures();
  }, [loadSignatures]);

  // Resolve equivalence closure for selected hash
  useEffect(() => {
    if (!selectedParamId || !selectedHash) {
      setResolvedClosure([]);
      return;
    }
    void (async () => {
      const res = await resolveEquivalentHashes({ param_id: selectedParamId, core_hash: selectedHash, include_equivalents: true });
      if (res.success) setResolvedClosure(res.core_hashes);
    })();
  }, [selectedParamId, selectedHash]);

  // BFS through equivalence links from currentCoreHash
  const linkedHashes = useMemo(() => {
    const linked = new Set<string>();
    if (!currentCoreHash || !linkRows.length) return linked;
    const queue = [currentCoreHash];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const h = queue.pop()!;
      if (visited.has(h)) continue;
      visited.add(h);
      linked.add(h);
      for (const link of linkRows) {
        if (link.core_hash === h && !visited.has(link.equivalent_to)) queue.push(link.equivalent_to);
        if (link.equivalent_to === h && !visited.has(link.core_hash)) queue.push(link.core_hash);
      }
    }
    return linked;
  }, [linkRows, currentCoreHash]);

  // Sorted/filtered display rows
  const displayRows = useMemo(() => {
    let rows = [...registryRows];
    if (queryModeFilter !== 'all') {
      rows = rows.filter((r) => detectQueryMode(r) === queryModeFilter);
    }
    if (sortOrder === 'newest') {
      rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } else if (sortOrder === 'oldest') {
      rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    } else if (sortOrder === 'most-data') {
      rows.sort((a, b) => (sigStatsMap.get(b.core_hash)?.snapshots ?? 0) - (sigStatsMap.get(a.core_hash)?.snapshots ?? 0));
    }
    return rows;
  }, [registryRows, queryModeFilter, sortOrder, sigStatsMap]);

  // Summary stats
  const summary = useMemo(() => {
    let totalSnapshots = 0, linkedSnapshots = 0, unlinkedCount = 0, unlinkedSnapshots = 0;
    for (const row of registryRows) {
      const snaps = sigStatsMap.get(row.core_hash)?.snapshots ?? 0;
      totalSnapshots += snaps;
      if (currentCoreHash && linkedHashes.has(row.core_hash)) linkedSnapshots += snaps;
      else if (currentCoreHash && row.core_hash !== currentCoreHash) { unlinkedCount++; unlinkedSnapshots += snaps; }
    }
    return { totalSnapshots, linkedSnapshots, unlinkedCount, unlinkedSnapshots };
  }, [registryRows, sigStatsMap, currentCoreHash, linkedHashes]);

  const selectedRow = useMemo(() => registryRows.find((r) => r.core_hash === selectedHash) ?? null, [registryRows, selectedHash]);

  return {
    paramFilter, setParamFilter,
    selectedParamId, setSelectedParamId,
    isLoading, filteredParams,
    registryRows, linkRows, sigStatsMap,
    displayRows, summary,
    queryModeFilter, setQueryModeFilter,
    sortOrder, setSortOrder,
    selectedHash, setSelectedHash,
    selectedRow, resolvedClosure, linkedHashes,
    setPendingHash,
    loadSignatures,
  };
}
