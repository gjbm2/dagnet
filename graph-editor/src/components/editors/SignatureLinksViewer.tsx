import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { DiffEditor, Editor } from '@monaco-editor/react';
import toast from 'react-hot-toast';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { useDialog } from '../../contexts/DialogContext';
import { sessionLogService } from '../../services/sessionLogService';
import {
  signatureLinksTabService,
  SIG_LINKS_CONTEXT_EVENT,
  type SignatureLinksContext,
} from '../../services/signatureLinksTabService';
import {
  createEquivalenceLink,
  deactivateEquivalenceLink,
  listEquivalenceLinks,
  listSignatures,
  resolveEquivalentHashes,
  type SigEquivalenceLinkRow,
  type SigLinkOperation,
  type SigParamSummary,
  type SigRegistryRow,
} from '../../services/signatureLinksApi';
import { getGraphStore } from '../../contexts/GraphStoreContext';
import { augmentDSLWithConstraint } from '../../lib/queryDSL';
import {
  getBatchInventoryV2,
  deleteSnapshots as deleteSnapshotsApi,
  querySnapshotsFull,
  querySnapshotRetrievals,
  type SnapshotInventoryV2Param,
  type SnapshotRetrievalSummaryRow,
} from '../../services/snapshotWriteService';
import { downloadTextFile } from '../../services/downloadService';
import { historicalFileService } from '../../services/historicalFileService';
import { fileRegistry } from '../../contexts/TabContext';
import type { GraphEdge } from '../../types';
import './SignatureLinksViewer.css';

// ─── Helpers ────────────────────────────────────────────────────────────────

function truncateHash(hash: string, len = 10): string {
  return hash.length > len ? hash.slice(0, len) + '…' : hash;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const day = d.getUTCDate();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mon = months[d.getUTCMonth()];
    const yr = String(d.getUTCFullYear()).slice(2);
    return `${day}-${mon}-${yr}`;
  } catch {
    return iso;
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Detect query mode from canonical signature or inputs_json. */
function detectQueryMode(row: SigRegistryRow): 'cohort' | 'window' | 'unknown' {
  const sig = row.canonical_signature || '';
  const sliceKey = row.inputs_json?.summary?.slice_key || '';
  const text = `${sig} ${sliceKey}`;
  if (text.includes('cohort(') || text.includes('"cohort"')) return 'cohort';
  if (text.includes('window(') || text.includes('"window"')) return 'window';
  return 'unknown';
}

/** Per-core_hash stats derived from inventory data. */
interface SigStats {
  snapshots: number;    // unique_retrieved_days (how many times snapshotted)
  earliest: string | null;  // earliest_retrieved_at
  latest: string | null;    // latest_retrieved_at
  rowCount: number;
  slices: number;
}

/** Extract all parameter IDs referenced by a graph's edges. */
function extractParamIdsFromEdges(edges: GraphEdge[]): string[] {
  const ids = new Set<string>();
  for (const edge of edges) {
    if (edge.p?.id) ids.add(edge.p.id);
    if (edge.cost_gbp?.id) ids.add(edge.cost_gbp.id);
    if (edge.labour_cost?.id) ids.add(edge.labour_cost.id);
    if (edge.conditional_p) {
      for (const cp of edge.conditional_p) {
        if (cp.p?.id) ids.add(cp.p.id);
      }
    }
  }
  return Array.from(ids);
}

// ─── Component ──────────────────────────────────────────────────────────────

export const SignatureLinksViewer: React.FC = () => {
  const { state: navState, items } = useNavigatorContext();
  const { showConfirm } = useDialog();

  const repo = navState.selectedRepo;
  const branch = navState.selectedBranch || 'main';
  const workspacePrefix = `${repo}-${branch}-`;

  // ── Context from tab service (graph-context entry) ──────────────────────
  const [context, setContext] = useState<SignatureLinksContext | null>(null);

  useEffect(() => {
    // Consume any pending context from the tab service on mount
    const pending = signatureLinksTabService.consumeContext();
    if (pending) setContext(pending);

    // Listen for context updates when already mounted
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SignatureLinksContext>).detail;
      if (detail) setContext(detail);
    };
    window.addEventListener(SIG_LINKS_CONTEXT_EVENT, handler as EventListener);
    return () => window.removeEventListener(SIG_LINKS_CONTEXT_EVENT, handler as EventListener);
  }, []);

  // ── State ───────────────────────────────────────────────────────────────
  const [isLoading, setIsLoading] = useState(false);
  const [paramFilter, setParamFilter] = useState('');

  // Graph selection (step 1 when no context) — resolved from context in useEffect
  const [selectedGraphName, setSelectedGraphName] = useState<string | null>(null);

  // Param discovery (from DB)
  const [dbParams, setDbParams] = useState<SigParamSummary[]>([]);
  const [selectedParamId, setSelectedParamId] = useState<string | null>(null);

  // Signatures for selected param
  const [registryRows, setRegistryRows] = useState<SigRegistryRow[]>([]);
  const [linkRows, setLinkRows] = useState<SigEquivalenceLinkRow[]>([]);

  // Selection
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [compareHash, setCompareHash] = useState<string | null>(null);
  const [resolvedClosure, setResolvedClosure] = useState<string[]>([]);

  // Right pane tab
  const [rightTab, setRightTab] = useState<'detail' | 'links' | 'data'>('detail');

  // Data tab (retrieved_at batches for the selected core_hash)
  const [dataRows, setDataRows] = useState<SnapshotRetrievalSummaryRow[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataFilter, setDataFilter] = useState('');
  const [dataSortField, setDataSortField] = useState<'retrieved_at' | 'slice_key' | 'anchor_from' | 'anchor_to' | 'row_count' | 'sum_x' | 'sum_y'>('retrieved_at');
  const [dataSortDir, setDataSortDir] = useState<'desc' | 'asc'>('desc');
  const [dataSelected, setDataSelected] = useState<Set<string>>(new Set());

  // Link creation flow (Links tab)
  const [linkTargetParamId, setLinkTargetParamId] = useState<string | null>(null);
  const [linkTargetParamFilter, setLinkTargetParamFilter] = useState('');
  const [linkTargetSigs, setLinkTargetSigs] = useState<SigRegistryRow[]>([]);
  const [linkTargetStatsMap, setLinkTargetStatsMap] = useState<Map<string, SigStats>>(new Map());
  const [linkTargetSelectedHash, setLinkTargetSelectedHash] = useState<string | null>(null);
  const [linkTargetQueryFilter, setLinkTargetQueryFilter] = useState<'all' | 'cohort' | 'window'>('all');
  const [linkTargetSortOrder, setLinkTargetSortOrder] = useState<'newest' | 'oldest' | 'most-data'>('newest');
  const [linkOperation, setLinkOperation] = useState<string>('equivalent');
  const [linkWeight, setLinkWeight] = useState(1.0);
  const [linkReason, setLinkReason] = useState('');
  const [linkCreatedBy, setLinkCreatedBy] = useState('user');

  // Inventory stats (per-core_hash data volume)
  const [sigStatsMap, setSigStatsMap] = useState<Map<string, SigStats>>(new Map());

  // Centre pane filters
  const [queryModeFilter, setQueryModeFilter] = useState<'all' | 'cohort' | 'window'>('all');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest' | 'most-data'>('newest');

  // Current core_hash from context
  const currentCoreHash = context?.currentCoreHash ?? null;

  // Graph list from navigator (id has no .json suffix) — declared early for use in effects
  const graphItems = useMemo(() => {
    return items.filter((i) => i.type === 'graph');
  }, [items]);

  // ── Load param list from DB (all workspace params — graph filtering is local) ──
  const loadParams = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await listSignatures({
        list_params: true,
        param_id_prefix: workspacePrefix,
        limit: 500,
      });
      if (res.success && res.params) {
        setDbParams(res.params);
      }
    } catch (err) {
      console.error('[SignatureLinksViewer] loadParams failed:', err);
    } finally {
      setIsLoading(false);
    }
  }, [workspacePrefix]);

  useEffect(() => {
    void loadParams();
  }, [loadParams]);

  // Auto-select graph + param from context
  useEffect(() => {
    if ((context?.graphName || context?.graphId) && graphItems.length > 0) {
      const gn = context.graphName || '';
      const gi = context.graphId || '';
      const match = graphItems.find(
        (g) => (gi && (g.id === gi || g.name === gi))
            || (gn && (g.id === gn || g.name === gn))
      );
      if (match) {
        setSelectedGraphName(match.id);
      }
    }
    if (context?.dbParamId) {
      setSelectedParamId(context.dbParamId);
    }
  }, [context?.graphName, context?.graphId, context?.dbParamId, graphItems]);

  // ── Load signatures + links + inventory for selected param ──────────────
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

      // Build per-core_hash stats from inventory families
      const statsMap = new Map<string, SigStats>();
      const inv = inventoryRes[selectedParamId];
      if (inv) {
        for (const family of inv.families) {
          // Each family has overall stats and member hashes
          // Distribute family-level stats to each member hash
          // (For single-hash families this is exact; for multi-hash it's an approximation)
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

  useEffect(() => {
    setSelectedHash(null);
    setCompareHash(null);
    setResolvedClosure([]);
    setRightTab('detail');
    setLinkTargetParamId(null);
    setLinkTargetSelectedHash(null);
    void loadSignatures();
  }, [loadSignatures]);

  // ── Resolve equivalence closure for selected hash ───────────────────────
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

  // ── Derived: equivalence closure (which hashes are linked to current) ───
  const linkedHashes = useMemo(() => {
    const linked = new Set<string>();
    if (!currentCoreHash || !linkRows.length) return linked;
    // BFS through equivalence links from currentCoreHash
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

  // ── Sorted/filtered signatures for centre pane ─────────────────────────
  const displayRows = useMemo(() => {
    let rows = [...registryRows];
    // Query mode filter
    if (queryModeFilter !== 'all') {
      rows = rows.filter((r) => detectQueryMode(r) === queryModeFilter);
    }
    // Sort
    if (sortOrder === 'newest') {
      rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } else if (sortOrder === 'oldest') {
      rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    } else if (sortOrder === 'most-data') {
      rows.sort((a, b) => (sigStatsMap.get(b.core_hash)?.snapshots ?? 0) - (sigStatsMap.get(a.core_hash)?.snapshots ?? 0));
    }
    return rows;
  }, [registryRows, queryModeFilter, sortOrder, sigStatsMap]);

  // Summary stats for the centre header
  const summary = useMemo(() => {
    let totalSnapshots = 0;
    let linkedSnapshots = 0;
    let unlinkedCount = 0;
    let unlinkedSnapshots = 0;
    for (const row of registryRows) {
      const snaps = sigStatsMap.get(row.core_hash)?.snapshots ?? 0;
      totalSnapshots += snaps;
      if (currentCoreHash && linkedHashes.has(row.core_hash)) {
        linkedSnapshots += snaps;
      } else if (currentCoreHash && row.core_hash !== currentCoreHash) {
        unlinkedCount++;
        unlinkedSnapshots += snaps;
      }
    }
    return { totalSnapshots, linkedSnapshots, unlinkedCount, unlinkedSnapshots };
  }, [registryRows, sigStatsMap, currentCoreHash, linkedHashes]);

  // When a graph is selected, extract its parameter IDs from edges (local data, not DB)
  const graphParamIds = useMemo(() => {
    if (!selectedGraphName) return null; // null = no filter (show all)
    // Find the graph in navigator items
    const graphItem = graphItems.find((g) => g.id === selectedGraphName);
    if (!graphItem) return null;
    // Read graph data from FileRegistry
    const graphFileId = `graph-${graphItem.id}`;
    const graphFile = fileRegistry.getFile(graphFileId);
    if (!graphFile?.data?.edges) return null;
    const paramIds = extractParamIdsFromEdges(graphFile.data.edges as GraphEdge[]);
    // Return the full DB param IDs (workspace-prefixed)
    return new Set(paramIds.map((id) => `${workspacePrefix}${id}`));
  }, [selectedGraphName, graphItems, workspacePrefix]);

  // ── Filtered param list (graph filter from edges + text filter) ─────────
  const filteredParams = useMemo(() => {
    let result = dbParams;
    // If a graph is selected, only show params referenced by that graph's edges
    if (graphParamIds) {
      result = result.filter((p) => graphParamIds.has(p.param_id));
    }
    const q = paramFilter.trim().toLowerCase();
    if (q) {
      result = result.filter((p) => p.param_id.toLowerCase().includes(q));
    }
    return result;
  }, [dbParams, paramFilter, graphParamIds]);

  // Also include navigator params that might not have signatures yet
  const navigatorParams = useMemo(() => {
    const paramItems = items.filter((i) => i.type === 'parameter');
    return paramItems.map((i) => ({ id: i.id, dbId: `${workspacePrefix}${i.id}` }));
  }, [items, workspacePrefix]);

  // ── Handlers ────────────────────────────────────────────────────────────

  const handleSelectSignature = useCallback((hash: string) => {
    // Single click always selects (replaces previous). Clears compare.
    setSelectedHash(hash);
    setCompareHash(null);
  }, []);

  const handleCompareSignature = useCallback((hash: string) => {
    // Explicitly set as compare target (for diff view)
    setCompareHash(hash);
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedHash(null);
    setCompareHash(null);
  }, []);

  // ── Delete snapshots for a specific core_hash ─────────────────────────
  const handleDeleteSnapshots = useCallback(async (coreHash: string) => {
    if (!selectedParamId) return;
    const stats = sigStatsMap.get(coreHash);
    const count = stats?.snapshots ?? 0;

    const confirmed = await showConfirm({
      title: 'Delete snapshots',
      message: `Delete ${count} snapshot${count !== 1 ? 's' : ''} for signature ${truncateHash(coreHash, 16)}?\n\nThis removes historical time-series data and cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      confirmVariant: 'danger',
    });
    if (!confirmed) return;

    const opId = sessionLogService.startOperation('info', 'data-update', 'SNAPSHOT_DELETE_SIG', `Deleting snapshots for ${truncateHash(coreHash)}`);
    try {
      const result = await deleteSnapshotsApi(selectedParamId, [coreHash]);
      if (!result.success) {
        toast.error(`Delete failed: ${result.error || 'unknown error'}`);
        sessionLogService.endOperation(opId, 'error', result.error || 'unknown');
        return;
      }
      toast.success(`Deleted ${result.deleted || 0} snapshot rows`);
      sessionLogService.endOperation(opId, 'success', `Deleted ${result.deleted || 0} rows`);
      await loadSignatures(); // Refresh
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Delete failed: ${msg}`);
      sessionLogService.endOperation(opId, 'error', msg);
    }
  }, [selectedParamId, sigStatsMap, showConfirm, loadSignatures]);

  // ── Download snapshots for a specific core_hash ───────────────────────
  const handleDownloadSnapshots = useCallback(async (coreHash: string) => {
    if (!selectedParamId) return;
    const opId = sessionLogService.startOperation('info', 'data-fetch', 'SNAPSHOT_DOWNLOAD_SIG', `Downloading snapshots for ${truncateHash(coreHash)}`);
    try {
      const result = await querySnapshotsFull({
        param_id: selectedParamId,
        core_hash: coreHash,
      });
      if (!result.success || !result.rows?.length) {
        toast.error('No snapshot data to download');
        sessionLogService.endOperation(opId, 'error', 'No data');
        return;
      }
      // Build CSV
      const headers = Object.keys(result.rows[0]);
      const csvRows = [headers.join(',')];
      for (const row of result.rows) {
        csvRows.push(headers.map((h) => {
          const v = (row as unknown as Record<string, unknown>)[h];
          const s = v == null ? '' : String(v);
          return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(','));
      }
      const filename = `${selectedParamId}_${truncateHash(coreHash, 12)}.csv`;
      downloadTextFile({ content: csvRows.join('\n'), filename, mimeType: 'text/csv' });
      toast.success(`Downloaded ${result.rows.length} rows`);
      sessionLogService.endOperation(opId, 'success', `Downloaded ${result.rows.length} rows`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Download failed: ${msg}`);
      sessionLogService.endOperation(opId, 'error', msg);
    }
  }, [selectedParamId]);

  // ── Load signatures + inventory for link target param ───────────────────
  const loadLinkTargetSigs = useCallback(async (paramId: string) => {
    try {
      const [regRes, invRes] = await Promise.all([
        listSignatures({ param_id: paramId, include_inputs: true, limit: 500 }),
        getBatchInventoryV2([paramId]).catch(() => ({} as Record<string, SnapshotInventoryV2Param>)),
      ]);
      if (regRes.success) setLinkTargetSigs(regRes.rows);
      // Build stats map
      const statsMap = new Map<string, SigStats>();
      const inv = invRes[paramId];
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
      setLinkTargetStatsMap(statsMap);
    } catch (err) {
      console.error('[SignatureLinksViewer] loadLinkTargetSigs failed:', err);
    }
  }, []);

  useEffect(() => {
    if (!linkTargetParamId) {
      setLinkTargetSigs([]);
      setLinkTargetStatsMap(new Map());
      setLinkTargetSelectedHash(null);
      return;
    }
    void loadLinkTargetSigs(linkTargetParamId);
  }, [linkTargetParamId, loadLinkTargetSigs]);

  // ── Unified link creation handler ─────────────────────────────────────
  const handleCreateLink = useCallback(async () => {
    if (!selectedParamId || !selectedHash || !linkTargetSelectedHash || !linkTargetParamId) return;

    const isSameParam = linkTargetParamId === selectedParamId;
    const opLabel = linkOperation === 'equivalent' ? '≡' : linkOperation;
    const targetDisplay = linkTargetParamId.startsWith(workspacePrefix) ? linkTargetParamId.slice(workspacePrefix.length) : linkTargetParamId;

    const confirmed = await showConfirm({
      title: 'Create link',
      message: `Create ${opLabel} link:\n\nSource: ${truncateHash(selectedHash, 16)}\nTarget: ${truncateHash(linkTargetSelectedHash, 16)}${!isSameParam ? `\nTarget param: ${targetDisplay}` : ''}\n\nOperation: ${linkOperation}${linkOperation === 'weighted_average' ? `\nWeight: ${linkWeight}` : ''}\nReason: ${linkReason || '(none)'}`,
      confirmLabel: 'Create link',
      cancelLabel: 'Cancel',
      confirmVariant: 'primary',
    });
    if (!confirmed) return;

    const opId = sessionLogService.startOperation('info', 'session', 'SIGS_LINK_CREATE', 'Creating link');
    const res = await createEquivalenceLink({
      param_id: selectedParamId,
      core_hash: selectedHash,
      equivalent_to: linkTargetSelectedHash,
      created_by: linkCreatedBy,
      reason: linkReason,
      ...(isSameParam && linkOperation === 'equivalent' ? {} : {
        operation: linkOperation as SigLinkOperation,
        weight: linkWeight,
        source_param_id: linkTargetParamId,
      }),
    });
    if (!res.success) {
      toast.error(`Link failed: ${res.error || 'unknown error'}`);
      sessionLogService.endOperation(opId, 'error', res.error || 'unknown');
      return;
    }
    toast.success('Link created');
    sessionLogService.endOperation(opId, 'success', 'Link created');
    setLinkTargetSelectedHash(null);
    setLinkReason('');
    await loadSignatures();
  }, [selectedParamId, selectedHash, linkTargetSelectedHash, linkTargetParamId, linkOperation, linkWeight, linkReason, linkCreatedBy, workspacePrefix, showConfirm, loadSignatures]);

  const handleDeactivateLink = useCallback(async (link: SigEquivalenceLinkRow) => {
    const confirmed = await showConfirm({
      title: 'Deactivate link',
      message: `Deactivate link?\n\n${truncateHash(link.core_hash, 16)} ≡ ${truncateHash(link.equivalent_to, 16)}\n\nfor: ${link.param_id}`,
      confirmLabel: 'Deactivate',
      cancelLabel: 'Cancel',
      confirmVariant: 'danger',
    });
    if (!confirmed) return;

    const opId = sessionLogService.startOperation('info', 'session', 'SIGS_LINK_DEACTIVATE', 'Deactivating link');
    const res = await deactivateEquivalenceLink({
      param_id: link.param_id,
      core_hash: link.core_hash,
      equivalent_to: link.equivalent_to,
      created_by: 'user',
      reason: 'Deactivated via Snapshot Manager',
    });
    if (!res.success) {
      toast.error(`Deactivation failed: ${res.error || 'unknown error'}`);
      sessionLogService.endOperation(opId, 'error', res.error || 'unknown');
      return;
    }
    toast.success('Link deactivated');
    sessionLogService.endOperation(opId, 'success', 'Link deactivated');
    await loadSignatures();
  }, [showConfirm, loadSignatures]);

  const handleViewGraphWithAsat = useCallback(async (row: SigRegistryRow) => {
    // Use provenance graph name if available, otherwise fall back to left-pane selection
    const graphName = row.inputs_json?.provenance?.graph_name ?? selectedGraphName;
    if (!graphName) {
      toast.error('No graph name available — select a graph in the left pane');
      return;
    }
    const fileId = `graph-${graphName}`;
    const asatDate = formatDate(row.created_at); // UK format e.g. "1-Dec-25"

    // Check the graph file exists and can have historical versions
    if (!historicalFileService.canOpenHistorical(fileId)) {
      toast.error(`Cannot open historical version of "${graphName}" — file may be local-only or not synced`);
      return;
    }

    const toastId = toast.loading(`Opening historical graph ${graphName} with asat(${asatDate})…`);

    try {
      // Fetch commit dates for this graph file
      const commitDates = await historicalFileService.getCommitDates(
        fileId,
        navState.selectedRepo,
        navState.selectedBranch,
      );

      if (commitDates.size === 0) {
        toast.error('No historical commits found for this graph', { id: toastId });
        return;
      }

      // Find the commit closest to (but not after) the signature creation date
      const commit = historicalFileService.findCommitAtOrBefore(commitDates, row.created_at);
      if (!commit) {
        toast.error(`No commit found at or before ${asatDate}`, { id: toastId });
        return;
      }

      // Open the historical graph version as a temporary tab
      const tabId = await historicalFileService.openHistoricalVersion(
        fileId,
        commit,
        navState.selectedRepo,
      );

      if (!tabId) {
        toast.error('Failed to open historical graph version', { id: toastId });
        return;
      }

      // Derive the temp file ID the same way historicalFileService does (strip file extensions)
      const file = fileRegistry.getFile(fileId);
      const displayName = (file?.name || graphName).replace(/\.(json|yaml|yml)$/i, '');
      const tempFileId = `temp-historical-graph-${displayName}-${commit.shortSha}`;

      // Poll for the graph store to appear (the graph editor creates it asynchronously)
      const asatClause = `asat(${asatDate})`;
      let injected = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const store = getGraphStore(tempFileId);
        if (store) {
          const state = store.getState();
          const currentDSL = state.currentDSL || '';
          const newDSL = augmentDSLWithConstraint(currentDSL, asatClause);
          state.setCurrentDSL(newDSL);
          if (state.graph) {
            state.setGraph({ ...state.graph, currentQueryDSL: newDSL });
          }
          injected = true;
          break;
        }
      }

      if (injected) {
        toast.success(`Opened ${graphName} at ${commit.dateUK} with ${asatClause}`, { id: toastId });
      } else {
        toast.success(`Opened ${graphName} at ${commit.dateUK} — could not inject ${asatClause} (graph store not ready)`, { id: toastId });
      }
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : 'unknown error'}`, { id: toastId });
    }
  }, [selectedGraphName, navState.selectedRepo, navState.selectedBranch]);

  // ── Filtered/sorted link target sigs ────────────────────────────────────
  const linkTargetDisplayRows = useMemo(() => {
    let rows = [...linkTargetSigs];
    if (linkTargetQueryFilter !== 'all') {
      rows = rows.filter((r) => detectQueryMode(r) === linkTargetQueryFilter);
    }
    if (linkTargetSortOrder === 'newest') {
      rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } else if (linkTargetSortOrder === 'oldest') {
      rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    } else if (linkTargetSortOrder === 'most-data') {
      rows.sort((a, b) => (linkTargetStatsMap.get(b.core_hash)?.snapshots ?? 0) - (linkTargetStatsMap.get(a.core_hash)?.snapshots ?? 0));
    }
    return rows;
  }, [linkTargetSigs, linkTargetQueryFilter, linkTargetSortOrder, linkTargetStatsMap]);

  // ── Selected / compare signature data ───────────────────────────────────
  const selectedRow = useMemo(() => registryRows.find((r) => r.core_hash === selectedHash) ?? null, [registryRows, selectedHash]);
  const compareRow = useMemo(() => registryRows.find((r) => r.core_hash === compareHash) ?? null, [registryRows, compareHash]);

  // ── Data tab: per-retrieval summaries for selectedRow ───────────────────
  const loadDataRows = useCallback(async (coreHash: string) => {
    if (!selectedParamId) return;
    setDataLoading(true);
    try {
      const res = await querySnapshotRetrievals({
        param_id: selectedParamId,
        core_hash: coreHash,
        include_equivalents: false,
        include_summary: true,
        limit: 500,
      });
      if (!res.success) {
        toast.error(`Failed to load retrievals: ${res.error || 'unknown error'}`);
        setDataRows([]);
        setDataSelected(new Set());
        return;
      }
      setDataRows(Array.isArray(res.summary) ? res.summary : []);
      setDataSelected(new Set());
    } finally {
      setDataLoading(false);
    }
  }, [selectedParamId]);

  // Load (or refresh) data tab rows when tab selected / signature changes
  useEffect(() => {
    if (rightTab !== 'data') return;
    if (!selectedRow) return;
    void loadDataRows(selectedRow.core_hash);
  }, [rightTab, selectedRow?.core_hash, loadDataRows]);

  const dataDisplayRows = useMemo(() => {
    let rows = [...dataRows];
    if (dataFilter.trim()) {
      const q = dataFilter.trim().toLowerCase();
      rows = rows.filter((r) => {
        const ra = (r.retrieved_at || '').toLowerCase();
        const sk = (r.slice_key || '').toLowerCase();
        const af = (r.anchor_from || '').toLowerCase();
        const at = (r.anchor_to || '').toLowerCase();
        return ra.includes(q) || sk.includes(q) || af.includes(q) || at.includes(q);
      });
    }
    const dir = dataSortDir === 'asc' ? 1 : -1;
    const getNum = (v: unknown) => (typeof v === 'number' ? v : Number(v || 0));
    rows.sort((a, b) => {
      switch (dataSortField) {
        case 'retrieved_at': {
          const ta = new Date(a.retrieved_at).getTime();
          const tb = new Date(b.retrieved_at).getTime();
          return dir * (ta - tb);
        }
        case 'anchor_from':
          return dir * (new Date(a.anchor_from || 0).getTime() - new Date(b.anchor_from || 0).getTime());
        case 'anchor_to':
          return dir * (new Date(a.anchor_to || 0).getTime() - new Date(b.anchor_to || 0).getTime());
        case 'row_count':
          return dir * (getNum(a.row_count) - getNum(b.row_count));
        case 'sum_x':
          return dir * (getNum(a.sum_x) - getNum(b.sum_x));
        case 'sum_y':
          return dir * (getNum(a.sum_y) - getNum(b.sum_y));
        case 'slice_key':
          return dir * (a.slice_key || '').localeCompare(b.slice_key || '');
        default:
          return 0;
      }
    });
    return rows;
  }, [dataRows, dataFilter, dataSortField, dataSortDir]);

  const dataRowKey = useCallback((r: SnapshotRetrievalSummaryRow) => `${r.retrieved_at}|${r.slice_key}`, []);

  const toggleDataRow = useCallback((key: string) => {
    setDataSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const dataAllSelected = useMemo(() => {
    return dataDisplayRows.length > 0 && dataDisplayRows.every((r) => dataSelected.has(dataRowKey(r)));
  }, [dataDisplayRows, dataSelected, dataRowKey]);

  const toggleDataSelectAll = useCallback(() => {
    setDataSelected((prev) => {
      const next = new Set(prev);
      const all = dataDisplayRows.length > 0 && dataDisplayRows.every((r) => next.has(dataRowKey(r)));
      if (all) {
        for (const r of dataDisplayRows) next.delete(dataRowKey(r));
      } else {
        for (const r of dataDisplayRows) next.add(dataRowKey(r));
      }
      return next;
    });
  }, [dataDisplayRows, dataRowKey]);

  const handleDataDownloadSelected = useCallback(async () => {
    if (!selectedParamId || !selectedRow) return;
    const retrievedAts = [...new Set(Array.from(dataSelected).map((k) => k.split('|')[0]))];
    if (retrievedAts.length === 0) return;

    const opId = sessionLogService.startOperation(
      'info',
      'data-fetch',
      'SNAPSHOT_DOWNLOAD_RETRIEVALS',
      `Downloading ${retrievedAts.length} retrieval batch${retrievedAts.length !== 1 ? 'es' : ''} for ${truncateHash(selectedRow.core_hash)}`,
    );
    try {
      const result = await querySnapshotsFull({
        param_id: selectedParamId,
        core_hash: selectedRow.core_hash,
        retrieved_ats: retrievedAts,
      });
      if (!result.success || !result.rows?.length) {
        toast.error('No snapshot data to download');
        sessionLogService.endOperation(opId, 'error', 'No data');
        return;
      }

      const headers = Object.keys(result.rows[0]);
      const csvRows = [headers.join(',')];
      for (const row of result.rows) {
        csvRows.push(headers.map((h) => {
          const v = (row as unknown as Record<string, unknown>)[h];
          const s = v == null ? '' : String(v);
          return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(','));
      }
      const filename = `${selectedParamId}_${truncateHash(selectedRow.core_hash, 12)}_${retrievedAts.length}retrievals.csv`;
      downloadTextFile({ content: csvRows.join('\n'), filename, mimeType: 'text/csv' });
      toast.success(`Downloaded ${result.rows.length} rows`);
      sessionLogService.endOperation(opId, 'success', `Downloaded ${result.rows.length} rows`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Download failed: ${msg}`);
      sessionLogService.endOperation(opId, 'error', msg);
    }
  }, [selectedParamId, selectedRow, dataSelected]);

  const handleDataDeleteSelected = useCallback(async () => {
    if (!selectedParamId || !selectedRow) return;
    const retrievedAts = [...new Set(Array.from(dataSelected).map((k) => k.split('|')[0]))];
    if (retrievedAts.length === 0) return;

    const confirmed = await showConfirm({
      title: 'Delete snapshot retrievals',
      message: `Delete ${retrievedAts.length} retrieval batch${retrievedAts.length !== 1 ? 'es' : ''} for signature ${truncateHash(selectedRow.core_hash, 16)}?\n\nThis removes historical time-series data and cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      confirmVariant: 'danger',
    });
    if (!confirmed) return;

    const opId = sessionLogService.startOperation(
      'info',
      'data-update',
      'SNAPSHOT_DELETE_RETRIEVALS',
      `Deleting ${retrievedAts.length} retrieval batch${retrievedAts.length !== 1 ? 'es' : ''} for ${truncateHash(selectedRow.core_hash)}`,
    );
    try {
      const result = await deleteSnapshotsApi(selectedParamId, [selectedRow.core_hash], retrievedAts);
      if (!result.success) {
        toast.error(`Delete failed: ${result.error || 'unknown error'}`);
        sessionLogService.endOperation(opId, 'error', result.error || 'unknown');
        return;
      }
      toast.success(`Deleted ${result.deleted || 0} snapshot rows`);
      sessionLogService.endOperation(opId, 'success', `Deleted ${result.deleted || 0} rows`);
      await loadSignatures();
      await loadDataRows(selectedRow.core_hash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Delete failed: ${msg}`);
      sessionLogService.endOperation(opId, 'error', msg);
    }
  }, [selectedParamId, selectedRow, dataSelected, showConfirm, loadSignatures, loadDataRows]);

  // ── Render helpers ──────────────────────────────────────────────────────

  const renderSigCard = (row: SigRegistryRow) => {
    const isSelected = row.core_hash === selectedHash;
    const isCompare = row.core_hash === compareHash;
    const isCurrent = currentCoreHash ? row.core_hash === currentCoreHash : false;
    const isLinked = currentCoreHash ? linkedHashes.has(row.core_hash) : false;
    const isNewest = displayRows.length > 0 && row.core_hash === displayRows[0]?.core_hash && sortOrder === 'newest';
    const stats = sigStatsMap.get(row.core_hash);
    const queryMode = detectQueryMode(row);
    const canCompare = selectedHash && selectedHash !== row.core_hash;

    // Determine badge
    let badge: string | null = null;
    let badgeClass = '';
    if (isCurrent) { badge = 'Current'; badgeClass = 'current'; }
    else if (isLinked) { badge = 'Linked'; badgeClass = 'linked'; }
    else if (currentCoreHash) { badge = 'Unlinked'; badgeClass = 'unlinked'; }
    else if (isNewest) { badge = 'Latest'; badgeClass = 'current'; }

    return (
      <div
        key={row.core_hash}
        className={`sig-card${isSelected ? ' selected' : ''}${isCompare ? ' compare' : ''}${isCurrent ? ' current' : ''}`}
        onClick={() => handleSelectSignature(row.core_hash)}
      >
        <div className="sig-card-left">
          <div className="sig-card-hash">{truncateHash(row.core_hash)}</div>
          <div className="sig-card-mode">{queryMode === 'cohort' ? 'cohort' : queryMode === 'window' ? 'window' : ''}</div>
        </div>
        <div className="sig-card-info">
          <div className="sig-card-date">Registered {formatDate(row.created_at)}</div>
          {stats ? (
            <div className="sig-card-stats">
              <strong>{stats.snapshots}</strong> snapshot{stats.snapshots !== 1 ? 's' : ''}
              {stats.earliest && stats.latest && (
                <span className="sig-card-range"> ({formatDate(stats.earliest)} – {formatDate(stats.latest)})</span>
              )}
              {stats.slices > 1 && <span> · {stats.slices} slices</span>}
            </div>
          ) : (
            <div className="sig-card-stats muted">no snapshot data</div>
          )}
        </div>
        {badge && (
          <div className={`sig-card-badge ${badgeClass}`}>{badge}</div>
        )}
        <div className="sig-card-actions">
          {canCompare && (
            <button
              className="sig-action-btn"
              style={{ padding: '3px 8px', fontSize: '10px' }}
              onClick={(e) => { e.stopPropagation(); handleCompareSignature(row.core_hash); }}
              title="Diff this signature against the selected one"
            >
              Diff
            </button>
          )}
        </div>
      </div>
    );
  };

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="sig-links-viewer">
      {/* ── Left pane: graph selector + param list ────────────────────── */}
      <div className="sig-links-left">
        <div className="sig-links-left-header">
          <h3>Snapshot Manager</h3>
          <div className="sig-links-workspace">{repo}/{branch}</div>
          <select
            className="sig-links-search"
            style={{ marginTop: 8 }}
            value={selectedGraphName ?? ''}
            onChange={(e) => {
              const v = e.target.value || null;
              setSelectedGraphName(v);
              setSelectedParamId(null);
            }}
          >
            <option value="">All graphs</option>
            {graphItems.map((g) => (
              <option key={g.id} value={g.id}>{g.id}</option>
            ))}
          </select>
          <input
            className="sig-links-search"
            placeholder="Filter parameters…"
            value={paramFilter}
            onChange={(e) => setParamFilter(e.target.value)}
          />
        </div>
        <div className="sig-links-param-list">
          {isLoading && (
            <div style={{ padding: '12px', color: '#999', fontSize: '12px' }}>Loading…</div>
          )}
          {!isLoading && filteredParams.length === 0 && (
            <div style={{ padding: '12px', color: '#999', fontSize: '12px' }}>
              {dbParams.length === 0 ? 'No parameters with signatures found' : 'No matches'}
            </div>
          )}
          {filteredParams.map((p) => {
            // Strip workspace prefix + "parameter-" for display
            let displayName = p.param_id;
            if (displayName.startsWith(workspacePrefix)) displayName = displayName.slice(workspacePrefix.length);
            if (displayName.startsWith('parameter-')) displayName = displayName.slice('parameter-'.length);
            return (
              <div
                key={p.param_id}
                className={`sig-links-param-item${selectedParamId === p.param_id ? ' selected' : ''}`}
                onClick={() => setSelectedParamId(p.param_id)}
              >
                <div className="param-name" title={p.param_id}>{displayName}</div>
                <div className="param-badge">{p.signature_count}</div>
              </div>
            );
          })}
          {/* Show navigator params that might not have sigs yet */}
          {navigatorParams
            .filter((np) => !dbParams.some((dp) => dp.param_id === np.dbId))
            .filter((np) => !graphParamIds || graphParamIds.has(np.dbId))
            .filter((np) => !paramFilter || np.id.toLowerCase().includes(paramFilter.toLowerCase()))
            .length > 0 && (
            <>
              <div className="sig-links-param-group">No signatures yet</div>
              {navigatorParams
                .filter((np) => !dbParams.some((dp) => dp.param_id === np.dbId))
                .filter((np) => !graphParamIds || graphParamIds.has(np.dbId))
                .filter((np) => !paramFilter || np.id.toLowerCase().includes(paramFilter.toLowerCase()))
                .map((np) => (
                  <div
                    key={np.dbId}
                    className={`sig-links-param-item${selectedParamId === np.dbId ? ' selected' : ''}`}
                    onClick={() => setSelectedParamId(np.dbId)}
                    style={{ opacity: 0.6 }}
                  >
                    <div className="param-name">{np.id}</div>
                  </div>
                ))}
            </>
          )}
        </div>
      </div>

      {/* ── Centre pane: signature list ───────────────────────────────── */}
      <div className="sig-links-centre">
        <div className="sig-links-centre-header">
          <h3>
            {selectedParamId
              ? selectedParamId.startsWith(workspacePrefix)
                ? selectedParamId.slice(workspacePrefix.length)
                : selectedParamId
              : 'Select a parameter'}
          </h3>
          {selectedParamId && (
            <button className="sig-refresh-btn" onClick={() => void loadSignatures()} disabled={isLoading}>
              Refresh
            </button>
          )}
        </div>

        {/* Filter/sort controls */}
        {selectedParamId && registryRows.length > 0 && (
          <div className="sig-centre-controls">
            <select
              className="sig-filter-select"
              value={queryModeFilter}
              onChange={(e) => setQueryModeFilter(e.target.value as 'all' | 'cohort' | 'window')}
            >
              <option value="all">All modes</option>
              <option value="window">window()</option>
              <option value="cohort">cohort()</option>
            </select>
            <select
              className="sig-filter-select"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as 'newest' | 'oldest' | 'most-data')}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="most-data">Most snapshots first</option>
            </select>
          </div>
        )}

        {/* Summary bar */}
        {selectedParamId && !isLoading && registryRows.length > 0 && (
          <div className="sig-summary-bar">
            <span>{registryRows.length} signature{registryRows.length !== 1 ? 's' : ''}</span>
            <span className="sig-summary-sep">·</span>
            <span>{summary.totalSnapshots} total snapshots</span>
            {currentCoreHash && summary.unlinkedCount > 0 && (
              <>
                <span className="sig-summary-sep">·</span>
                <span className="sig-summary-warn">
                  {summary.unlinkedCount} unlinked ({summary.unlinkedSnapshots} snapshots not in current queries)
                </span>
              </>
            )}
          </div>
        )}

        <div className="sig-links-centre-body">
          {!selectedParamId && (
            <div className="sig-links-empty">Select a parameter from the left pane</div>
          )}
          {selectedParamId && isLoading && (
            <div className="sig-links-loading">Loading…</div>
          )}
          {selectedParamId && !isLoading && registryRows.length === 0 && (
            <div className="sig-links-empty">No signatures found for this parameter</div>
          )}

          {displayRows.length > 0 && displayRows.map((row) => renderSigCard(row))}
        </div>
      </div>

      {/* ── Right pane: tabbed (Detail / Links / Data) ────────────────── */}
      <div className="sig-links-right">
        <div className="sig-right-tab-bar">
          <button
            className={`sig-right-tab${rightTab === 'detail' ? ' active' : ''}`}
            onClick={() => setRightTab('detail')}
          >
            Detail
          </button>
          <button
            className={`sig-right-tab${rightTab === 'links' ? ' active' : ''}`}
            onClick={() => setRightTab('links')}
          >
            Links
          </button>
          <button
            className={`sig-right-tab${rightTab === 'data' ? ' active' : ''}`}
            onClick={() => setRightTab('data')}
          >
            Data
          </button>
        </div>
        <div className={`sig-links-right-body${rightTab === 'detail' && selectedRow ? ' sig-detail-flex' : ''}`}>
          {/* ── DETAIL TAB ─────────────────────────────────────────────── */}
          {rightTab === 'detail' && (
            <>
              {!selectedRow && (
                <div className="sig-links-right-empty">Click a signature to view details</div>
              )}

              {selectedRow && (
                <>
                  {/* ── Compact metadata strip ── */}
                  <div className="sig-detail-strip">
                    <div className="sig-detail-strip-row">
                      <span className="sig-detail-label">Hash</span>
                      <span className="sig-detail-value mono">{truncateHash(selectedRow.core_hash)}</span>
                      <span className="sig-detail-sep">·</span>
                      <span className="sig-detail-label">Created</span>
                      <span className="sig-detail-value">{formatDate(selectedRow.created_at)}</span>
                      {(() => {
                        const stats = sigStatsMap.get(selectedRow.core_hash);
                        return stats ? (
                          <>
                            <span className="sig-detail-sep">·</span>
                            <span className="sig-detail-value">
                              <strong>{stats.snapshots}</strong> snap{stats.snapshots !== 1 ? 's' : ''}
                              {stats.rowCount > 0 && <span> · {stats.rowCount.toLocaleString()} rows</span>}
                              {stats.slices > 1 && <span> · {stats.slices} slices</span>}
                              {stats.earliest && stats.latest && (
                                <span className="sig-card-range"> ({formatDate(stats.earliest)} – {formatDate(stats.latest)})</span>
                              )}
                            </span>
                          </>
                        ) : null;
                      })()}
                    </div>

                    <div className="sig-detail-strip-row">
                      <span className="sig-detail-label">Sig</span>
                      <span className="sig-detail-value mono sig-detail-sig-text">{selectedRow.canonical_signature}</span>
                    </div>

                    {resolvedClosure.length > 1 && (
                      <div className="sig-detail-strip-row">
                        <span className="sig-detail-label">Equiv</span>
                        <div className="sig-closure-chips">
                          {resolvedClosure.map((h) => (
                            <span key={h} className="sig-closure-chip">{truncateHash(h)}</span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ── Action toolbar ── */}
                    <div className="sig-detail-toolbar">
                      <button
                        className="sig-action-btn"
                        disabled={!(selectedRow.inputs_json?.provenance?.graph_name || selectedGraphName)}
                        title={
                          (selectedRow.inputs_json?.provenance?.graph_name || selectedGraphName)
                            ? `Open historical graph at ${formatDate(selectedRow.created_at)} with asat() clause`
                            : 'Select a graph in the left pane to use this'
                        }
                        onClick={() => void handleViewGraphWithAsat(selectedRow)}
                      >
                        View graph at {formatDate(selectedRow.created_at)}
                      </button>
                      {(() => {
                        const stats = sigStatsMap.get(selectedRow.core_hash);
                        return stats && stats.snapshots > 0 ? (
                          <button
                            className="sig-action-btn"
                            onClick={() => void handleDownloadSnapshots(selectedRow.core_hash)}
                          >
                            Download ({stats.snapshots})
                          </button>
                        ) : null;
                      })()}
                      {(() => {
                        const stats = sigStatsMap.get(selectedRow.core_hash);
                        return stats && stats.snapshots > 0 ? (
                          <button
                            className="sig-action-btn danger"
                            onClick={() => void handleDeleteSnapshots(selectedRow.core_hash)}
                          >
                            Delete
                          </button>
                        ) : null;
                      })()}
                      <button
                        className="sig-action-btn primary"
                        onClick={() => setRightTab('links')}
                      >
                        Create link…
                      </button>
                      {compareRow && (
                        <button
                          className="sig-action-btn"
                          style={{ marginLeft: 'auto' }}
                          onClick={handleClearSelection}
                        >
                          Clear diff
                        </button>
                      )}
                    </div>
                  </div>

                  {/* ── Monaco editor region (fills remaining space) ── */}
                  <div className="sig-detail-editor-region">
                    {compareRow ? (
                      <>
                        <div className="sig-detail-editor-label">
                          Diff: {truncateHash(selectedRow.core_hash)} vs {truncateHash(compareRow.core_hash)}
                        </div>
                        <div className="sig-detail-editor-wrap">
                          <DiffEditor
                            original={safeJsonStringify(selectedRow.inputs_json ?? selectedRow.canonical_signature)}
                            modified={safeJsonStringify(compareRow.inputs_json ?? compareRow.canonical_signature)}
                            language="json"
                            theme="vs"
                            options={{
                              readOnly: true,
                              renderSideBySide: true,
                              minimap: { enabled: false },
                              scrollBeyondLastLine: false,
                              fontSize: 11,
                              lineNumbers: 'off',
                            }}
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="sig-detail-editor-label">
                          {selectedRow.inputs_json ? 'Inputs JSON' : 'Canonical signature'}
                        </div>
                        <div className="sig-detail-editor-wrap">
                          <Editor
                            value={safeJsonStringify(selectedRow.inputs_json ?? selectedRow.canonical_signature)}
                            language="json"
                            theme="vs"
                            options={{
                              readOnly: true,
                              minimap: { enabled: false },
                              scrollBeyondLastLine: false,
                              fontSize: 11,
                              lineNumbers: 'off',
                              wordWrap: 'on',
                              folding: true,
                            }}
                          />
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {/* ── LINKS TAB ──────────────────────────────────────────────── */}
          {rightTab === 'links' && (
            <>
              {!selectedRow && (
                <div className="sig-links-right-empty">Select a signature in the centre pane first</div>
              )}

              {selectedRow && (
                <>
                  <div className="sig-detail-field" style={{ marginBottom: 4 }}>
                    <div className="sig-detail-label">Source signature</div>
                    <div className="sig-detail-value mono" style={{ fontSize: 11 }}>{truncateHash(selectedRow.core_hash, 20)}</div>
                  </div>

                  {/* ── Existing links ──────────────────────────────── */}
                  <div className="sig-links-section-title">Existing links</div>
                  {linkRows.filter((l) => l.core_hash === selectedRow.core_hash || l.equivalent_to === selectedRow.core_hash).length === 0 && (
                    <div style={{ padding: '8px 0', color: '#999', fontSize: 11 }}>No links for this signature</div>
                  )}
                  {linkRows
                    .filter((l) => l.core_hash === selectedRow.core_hash || l.equivalent_to === selectedRow.core_hash)
                    .map((l) => {
                      const otherHash = l.core_hash === selectedRow.core_hash ? l.equivalent_to : l.core_hash;
                      const opLabel = l.operation && l.operation !== 'equivalent' ? l.operation : '≡';
                      return (
                        <div key={`${l.core_hash}:${l.equivalent_to}`} className="sig-existing-link">
                          <span className="sig-existing-link-label" title={otherHash}>
                            {opLabel} {truncateHash(otherHash, 16)}
                            {l.source_param_id && l.source_param_id !== selectedParamId && (
                              <span className="sig-existing-link-param"> ({l.source_param_id.startsWith(workspacePrefix) ? l.source_param_id.slice(workspacePrefix.length) : l.source_param_id})</span>
                            )}
                          </span>
                          <button
                            className="sig-action-btn danger"
                            style={{ padding: '2px 6px', fontSize: 10 }}
                            onClick={() => void handleDeactivateLink(l)}
                          >
                            Unlink
                          </button>
                        </div>
                      );
                    })}

                  {/* ── Create new link ─────────────────────────────── */}
                  <div className="sig-links-section-title" style={{ marginTop: 16 }}>Create new link</div>

                  {/* Target parameter selection */}
                  <label className="sig-link-label">Target parameter</label>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                    <button
                      className={`sig-action-btn${linkTargetParamId === selectedParamId ? ' primary' : ''}`}
                      style={{ fontSize: 11, padding: '4px 10px' }}
                      onClick={() => {
                        setLinkTargetParamId(selectedParamId);
                        setLinkTargetParamFilter('');
                        setLinkTargetSelectedHash(null);
                      }}
                    >
                      Same parameter
                    </button>
                    <span style={{ fontSize: 11, color: '#999', alignSelf: 'center' }}>or search:</span>
                  </div>
                  <input
                    className="sig-links-search"
                    placeholder="Type to find another parameter…"
                    value={linkTargetParamFilter}
                    onChange={(e) => {
                      setLinkTargetParamFilter(e.target.value);
                      // Always clear target when user types, so typeahead results appear
                      if (linkTargetParamId) {
                        setLinkTargetParamId(null);
                        setLinkTargetSelectedHash(null);
                      }
                    }}
                  />

                  {/* Param search results (typeahead from dbParams) */}
                  {linkTargetParamFilter.trim() && !linkTargetParamId && (
                    <div className="sig-link-param-results">
                      {dbParams
                        .filter((p) => p.param_id !== selectedParamId && p.param_id.toLowerCase().includes(linkTargetParamFilter.toLowerCase()))
                        .slice(0, 10)
                        .map((p) => {
                          let display = p.param_id;
                          if (display.startsWith(workspacePrefix)) display = display.slice(workspacePrefix.length);
                          return (
                            <div
                              key={p.param_id}
                              className="sig-links-param-item"
                              onClick={() => {
                                setLinkTargetParamId(p.param_id);
                                setLinkTargetParamFilter(display);
                                setLinkTargetSelectedHash(null);
                              }}
                            >
                              <div className="param-name">{display}</div>
                              <div className="param-badge">{p.signature_count}</div>
                            </div>
                          );
                        })}
                      {dbParams.filter((p) => p.param_id !== selectedParamId && p.param_id.toLowerCase().includes(linkTargetParamFilter.toLowerCase())).length === 0 && (
                        <div style={{ padding: 8, color: '#999', fontSize: 11 }}>No matching parameters</div>
                      )}
                    </div>
                  )}

                  {/* Once target param is chosen, show its signatures */}
                  {linkTargetParamId && (
                    <>
                      <div style={{ marginTop: 8, marginBottom: 4, fontSize: 11, color: '#666' }}>
                        Target: <strong>{linkTargetParamId.startsWith(workspacePrefix) ? linkTargetParamId.slice(workspacePrefix.length) : linkTargetParamId}</strong>
                        {linkTargetParamId !== selectedParamId && (
                          <button
                            className="sig-refresh-btn"
                            style={{ fontSize: 10, marginLeft: 8 }}
                            onClick={() => { setLinkTargetParamId(null); setLinkTargetParamFilter(''); setLinkTargetSelectedHash(null); }}
                          >
                            Change
                          </button>
                        )}
                      </div>

                      {/* Filter/sort for target sigs */}
                      {linkTargetSigs.length > 1 && (
                        <div className="sig-centre-controls" style={{ marginBottom: 4 }}>
                          <select
                            className="sig-filter-select"
                            value={linkTargetQueryFilter}
                            onChange={(e) => setLinkTargetQueryFilter(e.target.value as 'all' | 'cohort' | 'window')}
                          >
                            <option value="all">All</option>
                            <option value="window">window()</option>
                            <option value="cohort">cohort()</option>
                          </select>
                          <select
                            className="sig-filter-select"
                            value={linkTargetSortOrder}
                            onChange={(e) => setLinkTargetSortOrder(e.target.value as 'newest' | 'oldest' | 'most-data')}
                          >
                            <option value="newest">Newest</option>
                            <option value="oldest">Oldest</option>
                            <option value="most-data">Most data</option>
                          </select>
                        </div>
                      )}

                      {/* Target signature cards */}
                      <div className="sig-link-target-sigs">
                        {linkTargetSigs.length === 0 && (
                          <div style={{ padding: 8, color: '#999', fontSize: 11 }}>No signatures for this parameter</div>
                        )}
                        {linkTargetDisplayRows.map((row) => {
                          const isTarget = row.core_hash === linkTargetSelectedHash;
                          const tStats = linkTargetStatsMap.get(row.core_hash);
                          const qm = detectQueryMode(row);
                          return (
                            <div
                              key={row.core_hash}
                              className={`sig-card${isTarget ? ' selected' : ''}`}
                              onClick={() => setLinkTargetSelectedHash(row.core_hash)}
                            >
                              <div className="sig-card-left">
                                <div className="sig-card-hash">{truncateHash(row.core_hash)}</div>
                                <div className="sig-card-mode">{qm === 'cohort' ? 'cohort' : qm === 'window' ? 'window' : ''}</div>
                              </div>
                              <div className="sig-card-info">
                                <div className="sig-card-date">Registered {formatDate(row.created_at)}</div>
                                {tStats ? (
                                  <div className="sig-card-stats">
                                    <strong>{tStats.snapshots}</strong> snapshot{tStats.snapshots !== 1 ? 's' : ''}
                                    {tStats.earliest && tStats.latest && (
                                      <span className="sig-card-range"> ({formatDate(tStats.earliest)} – {formatDate(tStats.latest)})</span>
                                    )}
                                  </div>
                                ) : (
                                  <div className="sig-card-stats muted">no snapshot data</div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Link form */}
                      {linkTargetSelectedHash && (
                        <div className="sig-link-form" style={{ marginTop: 12 }}>
                          <label>Operation</label>
                          <select value={linkOperation} onChange={(e) => setLinkOperation(e.target.value)}>
                            <option value="equivalent">Equivalent (1:1)</option>
                            <option value="sum">Sum</option>
                            <option value="average">Average</option>
                            <option value="weighted_average">Weighted average</option>
                            <option value="first">First (prefer newer)</option>
                            <option value="last">Last (prefer older)</option>
                          </select>

                          {linkOperation === 'weighted_average' && (
                            <>
                              <label>Weight</label>
                              <input
                                type="number"
                                step="0.1"
                                min="0"
                                max="10"
                                value={linkWeight}
                                onChange={(e) => setLinkWeight(parseFloat(e.target.value) || 1.0)}
                              />
                            </>
                          )}

                          <label>Reason</label>
                          <textarea
                            value={linkReason}
                            onChange={(e) => setLinkReason(e.target.value)}
                            placeholder="e.g. Context definition changed, data still MECE"
                          />

                          <div className="sig-link-form-actions">
                            <button
                              className="sig-action-btn"
                              onClick={() => { setLinkTargetSelectedHash(null); }}
                            >
                              Cancel
                            </button>
                            <button
                              className="sig-action-btn primary"
                              onClick={() => void handleCreateLink()}
                            >
                              Create link
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}

          {/* ── DATA TAB ──────────────────────────────────────────────── */}
          {rightTab === 'data' && (
            <>
              {!selectedRow && (
                <div className="sig-links-right-empty">Select a signature in the centre pane first</div>
              )}

              {selectedRow && (
                <>
                  <div className="sig-data-controls">
                    <div className="sig-data-actions">
                      <button
                        className="sig-action-btn"
                        disabled={dataSelected.size === 0}
                        onClick={() => void handleDataDownloadSelected()}
                      >
                        Download{dataSelected.size ? ` (${dataSelected.size})` : ''}
                      </button>
                      <button
                        className="sig-action-btn danger"
                        disabled={dataSelected.size === 0}
                        onClick={() => void handleDataDeleteSelected()}
                      >
                        Delete{dataSelected.size ? ` (${dataSelected.size})` : ''}
                      </button>
                      <label className="sig-data-select-all">
                        <input
                          type="checkbox"
                          checked={dataAllSelected}
                          onChange={toggleDataSelectAll}
                        />
                        <span>Select all</span>
                      </label>
                    </div>

                    <div className="sig-data-filters">
                      <input
                        className="sig-links-search"
                        placeholder="Filter…"
                        value={dataFilter}
                        onChange={(e) => setDataFilter(e.target.value)}
                      />
                      <select
                        className="sig-filter-select"
                        value={dataSortField}
                        onChange={(e) => setDataSortField(e.target.value as any)}
                      >
                        <option value="retrieved_at">Retrieved</option>
                        <option value="anchor_from">Anchor from</option>
                        <option value="anchor_to">Anchor to</option>
                        <option value="row_count">Rows</option>
                        <option value="sum_x">Σ n</option>
                        <option value="sum_y">Σ k</option>
                        <option value="slice_key">Slice</option>
                      </select>
                      <select
                        className="sig-filter-select"
                        value={dataSortDir}
                        onChange={(e) => setDataSortDir(e.target.value as any)}
                      >
                        <option value="desc">Desc</option>
                        <option value="asc">Asc</option>
                      </select>
                      <span className="sig-data-count">
                        {dataDisplayRows.length} retrieval{dataDisplayRows.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>

                  {dataLoading && (
                    <div className="sig-links-loading">Loading…</div>
                  )}

                  {!dataLoading && (
                    <div className="sig-data-table-wrap">
                      <table className="sig-data-table">
                        <thead>
                          <tr>
                            <th style={{ width: 28 }} />
                            <th>Retrieved</th>
                            <th>Slice</th>
                            <th>Anchor range</th>
                            <th style={{ textAlign: 'right' }}>Rows</th>
                            <th style={{ textAlign: 'right' }}>Σ n</th>
                            <th style={{ textAlign: 'right' }}>Σ k</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dataDisplayRows.map((r) => {
                            const key = dataRowKey(r);
                            const isSel = dataSelected.has(key);
                            const anchorRange = r.anchor_from && r.anchor_to
                              ? `${formatDate(r.anchor_from)} – ${formatDate(r.anchor_to)}`
                              : (r.anchor_from ? `${formatDate(r.anchor_from)} – ?` : (r.anchor_to ? `? – ${formatDate(r.anchor_to)}` : '—'));
                            return (
                              <tr
                                key={key}
                                className={isSel ? 'selected' : ''}
                                onClick={() => toggleDataRow(key)}
                              >
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={isSel}
                                    onChange={() => toggleDataRow(key)}
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                </td>
                                <td className="mono">{formatDate(r.retrieved_at)}</td>
                                <td className="mono" title={r.slice_key}>{r.slice_key || '—'}</td>
                                <td>{anchorRange}</td>
                                <td style={{ textAlign: 'right' }}>{(r.row_count ?? 0).toLocaleString()}</td>
                                <td style={{ textAlign: 'right' }}>{(r.sum_x ?? 0).toLocaleString()}</td>
                                <td style={{ textAlign: 'right' }}>{(r.sum_y ?? 0).toLocaleString()}</td>
                              </tr>
                            );
                          })}
                          {dataDisplayRows.length === 0 && (
                            <tr>
                              <td colSpan={7} style={{ padding: 12, color: '#999', fontSize: 11 }}>
                                No retrievals
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
