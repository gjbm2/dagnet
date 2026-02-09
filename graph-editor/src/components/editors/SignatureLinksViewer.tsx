/**
 * SignatureLinksViewer — Snapshot Manager orchestrator.
 *
 * Layout: fixed 3-area grid (header, primary browse half, right pane).
 * Comparison is a floating pop-up overlay (bottom sheet), not a grid row.
 *
 *   ┌──────────────────── shared header ──────────────────────────────┐
 *   │ Title · repo/branch · Graph dropdown                           │
 *   ├──── primary (param list + sig cards) ──┬── right pane ────────┤
 *   │                                        │ Detail / Links / Data │
 *   ├── action bar (Compare buttons) ────────┤                      │
 *   └────────────────────────────────────────┴──────────────────────┘
 *         ┌─── comparison pop-up (overlay) ───────────────────┐
 *         │ param list + sig cards (secondary)                │
 *         └───────────────────────────────────────────────────┘
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DiffEditor, Editor } from '@monaco-editor/react';
import toast from 'react-hot-toast';
import { Search, Link2, BarChart3 } from 'lucide-react';
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
  type SigEquivalenceLinkRow,
  type SigLinkOperation,
  type SigParamSummary,
  type SigRegistryRow,
} from '../../services/signatureLinksApi';
import { getGraphStore } from '../../contexts/GraphStoreContext';
import { augmentDSLWithConstraint } from '../../lib/queryDSL';
import {
  deleteSnapshots as deleteSnapshotsApi,
  querySnapshotsFull,
  querySnapshotRetrievals,
  type SnapshotRetrievalSummaryRow,
} from '../../services/snapshotWriteService';
import { downloadTextFile } from '../../services/downloadService';
import { historicalFileService } from '../../services/historicalFileService';
import { fileRegistry } from '../../contexts/TabContext';
import type { GraphEdge } from '../../types';

import { useParamSigBrowser } from '../../hooks/useParamSigBrowser';
import { ParamSigBrowser, truncateHash, formatDate, formatDateTime, safeJsonStringify } from './ParamSigBrowser';
import './SignatureLinksViewer.css';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a tooltip string for a hash chip from a registry row (or just a raw hash). */
function hashChipTitle(row: SigRegistryRow | null | undefined, hash?: string): string {
  if (!row && !hash) return '';
  if (!row) return hash ?? '';
  const lines: string[] = [row.core_hash];
  if (row.param_id) lines.push(`Param: ${row.param_id}`);
  if (row.created_at) lines.push(`Created: ${formatDateTime(row.created_at)}`);
  if (row.sig_algo) lines.push(`Algorithm: ${row.sig_algo}`);
  return lines.join('\n');
}

/** Single-line version for CSS hover card (newlines become ' · '). */
function hashChipTip(row: SigRegistryRow | null | undefined, hash?: string): string {
  return hashChipTitle(row, hash).replace(/\n/g, ' · ');
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

// ─── Component ───────────────────────────────────────────────────────────────

export const SignatureLinksViewer: React.FC = () => {
  const { state: navState, items } = useNavigatorContext();
  const { showConfirm } = useDialog();

  const repo = navState.selectedRepo;
  const branch = navState.selectedBranch || 'main';
  const workspacePrefix = `${repo}-${branch}-`;

  // ── Context from tab service ─────────────────────────────────────────────
  const [context, setContext] = useState<SignatureLinksContext | null>(null);

  useEffect(() => {
    const pending = signatureLinksTabService.consumeContext();
    if (pending) setContext(pending);
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SignatureLinksContext>).detail;
      if (detail) setContext(detail);
    };
    window.addEventListener(SIG_LINKS_CONTEXT_EVENT, handler as EventListener);
    return () => window.removeEventListener(SIG_LINKS_CONTEXT_EVENT, handler as EventListener);
  }, []);

  // ── Shared state (loaded once, shared by both halves) ────────────────────
  const [selectedGraphName, setSelectedGraphName] = useState<string | null>(null);
  const [secondaryGraphName, setSecondaryGraphName] = useState<string | null>(null);
  const [dbParams, setDbParams] = useState<SigParamSummary[]>([]);

  const graphItems = useMemo(() => items.filter((i) => i.type === 'graph'), [items]);

  const navigatorParams = useMemo(() => {
    const paramItems = items.filter((i) => i.type === 'parameter');
    return paramItems.map((i) => ({ id: i.id, dbId: `${workspacePrefix}${i.id}` }));
  }, [items, workspacePrefix]);

  // Load all workspace params from DB (graph filtering is local)
  const loadParams = useCallback(async () => {
    try {
      const res = await listSignatures({
        list_params: true,
        param_id_prefix: workspacePrefix,
        limit: 500,
      });
      if (res.success && res.params) setDbParams(res.params);
    } catch (err) {
      console.error('[SignatureLinksViewer] loadParams failed:', err);
    }
  }, [workspacePrefix]);

  useEffect(() => { void loadParams(); }, [loadParams]);

  // Graph → paramIds mapping (shared helper)
  const resolveGraphParamIds = useCallback((graphName: string | null): Set<string> | null => {
    if (!graphName) return null;
    const graphItem = graphItems.find((g) => g.id === graphName);
    if (!graphItem) return null;
    const graphFileId = `graph-${graphItem.id}`;
    const graphFile = fileRegistry.getFile(graphFileId);
    if (!graphFile?.data?.edges) return null;
    const paramIds = extractParamIdsFromEdges(graphFile.data.edges as GraphEdge[]);
    return new Set(paramIds.map((id) => `${workspacePrefix}${id}`));
  }, [graphItems, workspacePrefix]);

  const graphParamIds = useMemo(() => resolveGraphParamIds(selectedGraphName), [selectedGraphName, resolveGraphParamIds]);
  const secondaryGraphParamIds = useMemo(() => resolveGraphParamIds(secondaryGraphName), [secondaryGraphName, resolveGraphParamIds]);

  const currentCoreHash = context?.currentCoreHash ?? null;

  // ── Two browser instances ────────────────────────────────────────────────
  const primary = useParamSigBrowser({ workspacePrefix, dbParams, graphParamIds, currentCoreHash });
  const secondary = useParamSigBrowser({ workspacePrefix, dbParams, graphParamIds: secondaryGraphParamIds });

  // Auto-select graph + param from context (primary only)
  useEffect(() => {
    if ((context?.graphName || context?.graphId) && graphItems.length > 0) {
      const gn = context?.graphName || '';
      const gi = context?.graphId || '';
      const match = graphItems.find(
        (g) => (gi && (g.id === gi || g.name === gi)) || (gn && (g.id === gn || g.name === gn)),
      );
      if (match) setSelectedGraphName(match.id);
    }
    if (context?.dbParamId) primary.setSelectedParamId(context.dbParamId);
    if (context?.desiredQueryMode === 'cohort' || context?.desiredQueryMode === 'window') {
      primary.setQueryModeFilter(context.desiredQueryMode);
    }
  }, [context?.graphName, context?.graphId, context?.dbParamId, graphItems]);

  // ── Right pane state ─────────────────────────────────────────────────────
  const [rightTab, setRightTab] = useState<'detail' | 'links' | 'data'>('detail');
  const [linkSuccessFlash, setLinkSuccessFlash] = useState(false);

  // ── Grid-level column resize (primary ↔ right) ───────────────────────────
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridDragging, setGridDragging] = useState(false);

  const onGridHandleDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setGridDragging(true);
  }, []);

  useEffect(() => {
    if (!gridDragging) return;
    const onMove = (e: MouseEvent) => {
      const grid = gridRef.current;
      if (!grid) return;
      const rect = grid.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.max(25, Math.min(65, pct));
      grid.style.gridTemplateColumns = `${clamped}% 5px 1fr`;
    };
    const onUp = () => setGridDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [gridDragging]);

  // Data tab state
  const [dataRows, setDataRows] = useState<SnapshotRetrievalSummaryRow[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataFilter, setDataFilter] = useState('');
  const [dataSortField, setDataSortField] = useState<'retrieved_at' | 'slice_key' | 'anchor_from' | 'anchor_to' | 'row_count' | 'sum_x' | 'sum_y'>('retrieved_at');
  const [dataSortDir, setDataSortDir] = useState<'desc' | 'asc'>('desc');
  const [dataSelected, setDataSelected] = useState<Set<string>>(new Set());

  // Compare hash data rows (Data tab — when compare target is active)
  const [compareDataRows, setCompareDataRows] = useState<SnapshotRetrievalSummaryRow[]>([]);
  const [compareDataLoading, setCompareDataLoading] = useState(false);
  const [dataSourceFilter, setDataSourceFilter] = useState<'both' | 'primary' | 'compare'>('both');

  // Linked data sections (Data tab)
  const [linkedDataSections, setLinkedDataSections] = useState<Array<{
    paramId: string;
    coreHash: string;
    label: string;
    rows: SnapshotRetrievalSummaryRow[];
  }>>([]);
  const [linkedDataLoading, setLinkedDataLoading] = useState(false);
  const [collapsedLinkedSections, setCollapsedLinkedSections] = useState<Set<string>>(new Set());

  const toggleLinkedSection = useCallback((key: string) => {
    setCollapsedLinkedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  // Compare hash linked data sections (Data tab)
  const [compareLinkedSections, setCompareLinkedSections] = useState<Array<{
    paramId: string;
    coreHash: string;
    label: string;
    rows: SnapshotRetrievalSummaryRow[];
  }>>([]);
  const [compareLinkedLoading, setCompareLinkedLoading] = useState(false);

  // Link creation state (cross-panel)
  const [linkOperation, setLinkOperation] = useState<string>('equivalent');
  const [linkWeight, setLinkWeight] = useState(1.0);
  const [linkReason, setLinkReason] = useState('');
  const [linkCreatedBy, setLinkCreatedBy] = useState('user');

  // ── Comparison modes ─────────────────────────────────────────────────────
  // Same-param compare: click two cards in the primary list (no pop-up).
  // Cross-param compare: floating pop-up with a secondary browser.
  const [secondaryMode, setSecondaryMode] = useState<'hidden' | 'cross-param'>('hidden');
  const secondaryOpen = secondaryMode === 'cross-param';

  // Same-param compare hash (set by clicking a second card in the primary list)
  const [compareHash, setCompareHash] = useState<string | null>(null);

  // Clear compare hash when primary param changes
  useEffect(() => { setCompareHash(null); }, [primary.selectedParamId]);

  // Clear compare if user selects the compare card as the new primary
  useEffect(() => {
    if (compareHash && primary.selectedHash === compareHash) {
      setCompareHash(null);
    }
  }, [primary.selectedHash, compareHash]);

  // Auto-sync secondary param in cross-param mode when first opened
  useEffect(() => {
    if (secondaryMode === 'cross-param' && !secondary.selectedParamId && primary.selectedParamId) {
      secondary.setSelectedParamId(primary.selectedParamId);
    }
  }, [secondaryMode]);

  // ── Effective compare row (unifies same-param and cross-param) ──────────
  const effectiveCompareRow = useMemo(() => {
    if (compareHash) {
      return primary.registryRows.find((r) => r.core_hash === compareHash) ?? null;
    }
    if (secondaryMode === 'cross-param' && secondary.selectedRow) {
      return secondary.selectedRow;
    }
    return null;
  }, [compareHash, secondaryMode, primary.registryRows, secondary.selectedRow]);

  const effectiveCompareHash = compareHash ?? (secondaryMode === 'cross-param' ? secondary.selectedHash : null);
  const effectiveCompareParamId = compareHash ? primary.selectedParamId : (secondaryMode === 'cross-param' ? secondary.selectedParamId : null);

  // Reset data source filter when compare target changes
  useEffect(() => { setDataSourceFilter('both'); }, [effectiveCompareHash]);

  // ── Navigation history ───────────────────────────────────────────────────
  interface NavEntry { paramId: string | null; hash: string | null; tab: 'detail' | 'links' | 'data' }
  const navHistory = useRef<NavEntry[]>([]);

  const pushNav = useCallback(() => {
    navHistory.current.push({ paramId: primary.selectedParamId, hash: primary.selectedHash, tab: rightTab });
  }, [primary.selectedParamId, primary.selectedHash, rightTab]);

  const handleBack = useCallback(() => {
    const entry = navHistory.current.pop();
    if (!entry) return;
    if (entry.paramId !== primary.selectedParamId) {
      if (entry.hash) primary.setPendingHash(entry.hash);
      primary.setSelectedParamId(entry.paramId);
    } else {
      primary.setSelectedHash(entry.hash);
    }
    setRightTab(entry.tab);
  }, [primary.selectedParamId]);

  const canGoBack = navHistory.current.length > 0;

  // ── Convenience aliases ──────────────────────────────────────────────────
  const selectedRow = primary.selectedRow;

  // ── Cross-panel state ────────────────────────────────────────────────────
  const bothSelected = !!(primary.selectedRow && effectiveCompareRow);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleDeleteSnapshots = useCallback(async (coreHash: string) => {
    if (!primary.selectedParamId) return;
    const stats = primary.sigStatsMap.get(coreHash);
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
      const result = await deleteSnapshotsApi(primary.selectedParamId, [coreHash]);
      if (!result.success) {
        toast.error(`Delete failed: ${result.error || 'unknown error'}`);
        sessionLogService.endOperation(opId, 'error', result.error || 'unknown');
        return;
      }
      toast.success(`Deleted ${result.deleted || 0} snapshot rows`);
      sessionLogService.endOperation(opId, 'success', `Deleted ${result.deleted || 0} rows`);
      await primary.loadSignatures();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Delete failed: ${msg}`);
      sessionLogService.endOperation(opId, 'error', msg);
    }
  }, [primary.selectedParamId, primary.sigStatsMap, showConfirm, primary.loadSignatures]);

  const handleDownloadSnapshots = useCallback(async (coreHash: string) => {
    if (!primary.selectedParamId) return;
    const opId = sessionLogService.startOperation('info', 'data-fetch', 'SNAPSHOT_DOWNLOAD_SIG', `Downloading snapshots for ${truncateHash(coreHash)}`);
    try {
      const result = await querySnapshotsFull({
        param_id: primary.selectedParamId,
        core_hash: coreHash,
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
      const filename = `${primary.selectedParamId}_${truncateHash(coreHash, 12)}.csv`;
      downloadTextFile({ content: csvRows.join('\n'), filename, mimeType: 'text/csv' });
      toast.success(`Downloaded ${result.rows.length} rows`);
      sessionLogService.endOperation(opId, 'success', `Downloaded ${result.rows.length} rows`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Download failed: ${msg}`);
      sessionLogService.endOperation(opId, 'error', msg);
    }
  }, [primary.selectedParamId]);

  const handleViewGraphWithAsat = useCallback(async (row: { core_hash: string; created_at: string; inputs_json?: any }) => {
    const graphName = row.inputs_json?.provenance?.graph_name ?? selectedGraphName;
    if (!graphName) {
      toast.error('No graph name available — select a graph in the header');
      return;
    }
    const fileId = `graph-${graphName}`;
    const asatDate = formatDate(row.created_at);

    if (!historicalFileService.canOpenHistorical(fileId)) {
      toast.error(`Cannot open historical version of "${graphName}" — file may be local-only or not synced`);
      return;
    }

    const toastId = toast.loading(`Opening historical graph ${graphName} with asat(${asatDate})…`);
    try {
      const commitDates = await historicalFileService.getCommitDates(
        fileId, navState.selectedRepo, navState.selectedBranch,
      );
      if (commitDates.size === 0) {
        toast.error('No historical commits found for this graph', { id: toastId });
        return;
      }
      const commit = historicalFileService.findCommitAtOrBefore(commitDates, row.created_at);
      if (!commit) {
        toast.error(`No commit found at or before ${asatDate}`, { id: toastId });
        return;
      }
      const tabId = await historicalFileService.openHistoricalVersion(fileId, commit, navState.selectedRepo);
      if (!tabId) {
        toast.error('Failed to open historical graph version', { id: toastId });
        return;
      }
      const file = fileRegistry.getFile(fileId);
      const displayName = (file?.name || graphName).replace(/\.(json|yaml|yml)$/i, '');
      const tempFileId = `temp-historical-graph-${displayName}-${commit.shortSha}`;
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
          if (state.graph) state.setGraph({ ...state.graph, currentQueryDSL: newDSL });
          injected = true;
          break;
        }
      }
      if (injected) {
        toast.success(`Opened ${graphName} at ${commit.dateUK} with ${asatClause}`, { id: toastId });
      } else {
        toast.success(`Opened ${graphName} at ${commit.dateUK} — could not inject ${asatClause}`, { id: toastId });
      }
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : 'unknown error'}`, { id: toastId });
    }
  }, [selectedGraphName, navState.selectedRepo, navState.selectedBranch]);

  // ── Link creation (works with both same-param compare and cross-param popup)
  const handleCreateLink = useCallback(async () => {
    if (!primary.selectedParamId || !primary.selectedHash || !effectiveCompareHash) return;

    const targetParamId = effectiveCompareParamId || primary.selectedParamId;
    const isSameParam = targetParamId === primary.selectedParamId;
    const opLabel = linkOperation === 'equivalent' ? '≡' : linkOperation;
    const targetDisplay = targetParamId.startsWith(workspacePrefix) ? targetParamId.slice(workspacePrefix.length) : targetParamId;

    const confirmed = await showConfirm({
      title: 'Create link',
      message: `Create ${opLabel} link:\n\nSource: ${truncateHash(primary.selectedHash, 16)}\nTarget: ${truncateHash(effectiveCompareHash, 16)}${!isSameParam ? `\nTarget param: ${targetDisplay}` : ''}\n\nOperation: ${linkOperation}${linkOperation === 'weighted_average' ? `\nWeight: ${linkWeight}` : ''}\nReason: ${linkReason || '(none)'}`,
      confirmLabel: 'Create link',
      cancelLabel: 'Cancel',
      confirmVariant: 'primary',
    });
    if (!confirmed) return;

    const opId = sessionLogService.startOperation('info', 'session', 'SIGS_LINK_CREATE', 'Creating link');
    const res = await createEquivalenceLink({
      param_id: primary.selectedParamId,
      core_hash: primary.selectedHash,
      equivalent_to: effectiveCompareHash,
      created_by: linkCreatedBy,
      reason: linkReason,
      ...(isSameParam && linkOperation === 'equivalent' ? {} : {
        operation: linkOperation as SigLinkOperation,
        weight: linkWeight,
        source_param_id: targetParamId,
      }),
    });
    if (!res.success) {
      toast.error(`Link failed: ${res.error || 'unknown error'}`);
      sessionLogService.endOperation(opId, 'error', res.error || 'unknown');
      return;
    }
    toast.success('Link created');
    sessionLogService.endOperation(opId, 'success', 'Link created');
    setLinkReason('');
    setLinkSuccessFlash(true);
    setTimeout(() => setLinkSuccessFlash(false), 2000);
    await primary.loadSignatures();
  }, [primary.selectedParamId, primary.selectedHash, effectiveCompareHash, effectiveCompareParamId, linkOperation, linkWeight, linkReason, linkCreatedBy, workspacePrefix, showConfirm, primary.loadSignatures]);

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
    await primary.loadSignatures();
  }, [showConfirm, primary.loadSignatures]);

  // ── Swap / card-click handlers ───────────────────────────────────────────

  const handleSwap = useCallback(() => {
    if (compareHash) {
      // Same-param: swap primary and compare hashes
      const pHash = primary.selectedHash;
      primary.setSelectedHash(compareHash);
      setCompareHash(pHash);
    } else if (secondaryMode === 'cross-param') {
      // Cross-param: swap everything
      const pParam = primary.selectedParamId;
      const pHash = primary.selectedHash;
      const sParam = secondary.selectedParamId;
      const sHash = secondary.selectedHash;
      primary.setSelectedParamId(sParam);
      if (sHash) primary.setPendingHash(sHash); else primary.setSelectedHash(null);
      secondary.setSelectedParamId(pParam);
      if (pHash) secondary.setPendingHash(pHash); else secondary.setSelectedHash(null);
    }
  }, [compareHash, secondaryMode, primary.selectedParamId, primary.selectedHash, secondary.selectedParamId, secondary.selectedHash]);

  // Compare button handler — clicking "vs" on a card sets/clears compare target
  const handleCompareClick = useCallback((hash: string) => {
    // Empty string = clear compare (toggled off)
    setCompareHash(hash || null);
    // Close cross-param pop-up — user is comparing within the same param now
    if (hash) {
      setSecondaryMode('hidden');
    }
  }, []);

  // ── Data tab: per-retrieval summaries ────────────────────────────────────
  const loadDataRows = useCallback(async (coreHash: string) => {
    if (!primary.selectedParamId) return;
    setDataLoading(true);
    try {
      const res = await querySnapshotRetrievals({
        param_id: primary.selectedParamId,
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
  }, [primary.selectedParamId]);

  useEffect(() => {
    if (rightTab !== 'data' || !selectedRow) return;
    void loadDataRows(selectedRow.core_hash);
  }, [rightTab, selectedRow?.core_hash, loadDataRows]);

  // Load compare-hash data rows
  useEffect(() => {
    if (rightTab !== 'data' || !effectiveCompareHash) {
      setCompareDataRows([]);
      return;
    }
    const compareParamId = effectiveCompareParamId || primary.selectedParamId;
    if (!compareParamId) { setCompareDataRows([]); return; }
    setCompareDataLoading(true);
    void (async () => {
      try {
        const res = await querySnapshotRetrievals({
          param_id: compareParamId,
          core_hash: effectiveCompareHash,
          include_equivalents: false,
          include_summary: true,
          limit: 500,
        });
        setCompareDataRows(res.success && Array.isArray(res.summary) ? res.summary : []);
      } catch {
        setCompareDataRows([]);
      } finally {
        setCompareDataLoading(false);
      }
    })();
  }, [rightTab, effectiveCompareHash, effectiveCompareParamId, primary.selectedParamId]);

  // Linked data sections
  useEffect(() => {
    if (rightTab !== 'data' || !selectedRow || !primary.selectedParamId) {
      setLinkedDataSections([]);
      return;
    }
    const pairs: Array<{ paramId: string; coreHash: string }> = [];
    const seen = new Set<string>();
    seen.add(`${primary.selectedParamId}|${selectedRow.core_hash}`);

    for (const l of primary.linkRows) {
      if (l.operation !== 'equivalent') continue;
      if (l.core_hash !== selectedRow.core_hash && l.equivalent_to !== selectedRow.core_hash) continue;
      const otherHash = l.core_hash === selectedRow.core_hash ? l.equivalent_to : l.core_hash;
      const otherParam = l.core_hash === selectedRow.core_hash ? (l.source_param_id || l.param_id) : l.param_id;
      const key = `${otherParam}|${otherHash}`;
      if (!seen.has(key)) { seen.add(key); pairs.push({ paramId: otherParam, coreHash: otherHash }); }
    }
    for (const h of primary.resolvedClosure) {
      if (h === selectedRow.core_hash) continue;
      const key = `${primary.selectedParamId}|${h}`;
      if (!seen.has(key)) { seen.add(key); pairs.push({ paramId: primary.selectedParamId, coreHash: h }); }
    }
    if (pairs.length === 0) { setLinkedDataSections([]); return; }

    setLinkedDataLoading(true);
    void (async () => {
      try {
        const results = await Promise.all(
          pairs.map(async (p) => {
            try {
              const res = await querySnapshotRetrievals({
                param_id: p.paramId, core_hash: p.coreHash,
                include_equivalents: false, include_summary: true, limit: 500,
              });
              const rows = res.success && Array.isArray(res.summary) ? res.summary : [];
              const paramDisplay = p.paramId === primary.selectedParamId
                ? '' : (p.paramId.startsWith(workspacePrefix) ? p.paramId.slice(workspacePrefix.length) : p.paramId);
              return {
                paramId: p.paramId, coreHash: p.coreHash,
                label: `${truncateHash(p.coreHash, 16)}${paramDisplay ? ` · ${paramDisplay}` : ''}`,
                rows,
              };
            } catch {
              return { paramId: p.paramId, coreHash: p.coreHash, label: truncateHash(p.coreHash, 16), rows: [] as SnapshotRetrievalSummaryRow[] };
            }
          }),
        );
        setLinkedDataSections(results);
      } finally {
        setLinkedDataLoading(false);
      }
    })();
  }, [rightTab, selectedRow?.core_hash, primary.selectedParamId, primary.linkRows, primary.resolvedClosure, workspacePrefix]);

  // Compare hash linked data sections
  useEffect(() => {
    if (rightTab !== 'data' || !effectiveCompareHash || !effectiveCompareParamId) {
      setCompareLinkedSections([]);
      return;
    }
    // Skip if compare hash is already shown in primary linked sections or is the primary hash itself
    const skipHashes = new Set<string>([selectedRow?.core_hash ?? '']);
    for (const s of linkedDataSections) skipHashes.add(s.coreHash);

    setCompareLinkedLoading(true);
    void (async () => {
      try {
        // Fetch equivalence links for the compare hash
        const linkRes = await listEquivalenceLinks({ param_id: effectiveCompareParamId, core_hash: effectiveCompareHash });
        const links = linkRes.success ? (linkRes.rows || []) : [];

        const pairs: Array<{ paramId: string; coreHash: string }> = [];
        const seen = new Set<string>();
        seen.add(`${effectiveCompareParamId}|${effectiveCompareHash}`);

        for (const l of links) {
          if (l.operation !== 'equivalent' || !l.active) continue;
          if (l.core_hash !== effectiveCompareHash && l.equivalent_to !== effectiveCompareHash) continue;
          const otherHash = l.core_hash === effectiveCompareHash ? l.equivalent_to : l.core_hash;
          const otherParam = l.core_hash === effectiveCompareHash ? (l.source_param_id || l.param_id) : l.param_id;
          const key = `${otherParam}|${otherHash}`;
          if (!seen.has(key) && !skipHashes.has(otherHash)) {
            seen.add(key);
            pairs.push({ paramId: otherParam, coreHash: otherHash });
          }
        }

        if (pairs.length === 0) { setCompareLinkedSections([]); return; }

        const results = await Promise.all(
          pairs.map(async (p) => {
            try {
              const res = await querySnapshotRetrievals({
                param_id: p.paramId, core_hash: p.coreHash,
                include_equivalents: false, include_summary: true, limit: 500,
              });
              const rows = res.success && Array.isArray(res.summary) ? res.summary : [];
              const paramDisplay = p.paramId === effectiveCompareParamId
                ? '' : (p.paramId.startsWith(workspacePrefix) ? p.paramId.slice(workspacePrefix.length) : p.paramId);
              return {
                paramId: p.paramId, coreHash: p.coreHash,
                label: `${truncateHash(p.coreHash, 16)}${paramDisplay ? ` · ${paramDisplay}` : ''}`,
                rows,
              };
            } catch {
              return { paramId: p.paramId, coreHash: p.coreHash, label: truncateHash(p.coreHash, 16), rows: [] as SnapshotRetrievalSummaryRow[] };
            }
          }),
        );
        setCompareLinkedSections(results);
      } catch {
        setCompareLinkedSections([]);
      } finally {
        setCompareLinkedLoading(false);
      }
    })();
  }, [rightTab, effectiveCompareHash, effectiveCompareParamId, selectedRow?.core_hash, linkedDataSections, workspacePrefix]);

  type TaggedDataRow = SnapshotRetrievalSummaryRow & { _source: 'primary' | 'compare' };

  const dataDisplayRows = useMemo(() => {
    const primaryTagged: TaggedDataRow[] = dataRows.map((r) => ({ ...r, _source: 'primary' as const }));
    const compareTagged: TaggedDataRow[] = compareDataRows.map((r) => ({ ...r, _source: 'compare' as const }));

    let rows: TaggedDataRow[] =
      dataSourceFilter === 'primary' ? primaryTagged
        : dataSourceFilter === 'compare' ? compareTagged
          : [...primaryTagged, ...compareTagged];

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
        case 'retrieved_at':
          return dir * (new Date(a.retrieved_at).getTime() - new Date(b.retrieved_at).getTime());
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
  }, [dataRows, compareDataRows, dataSourceFilter, dataFilter, dataSortField, dataSortDir]);

  const dataRowKey = useCallback((r: TaggedDataRow) => `${r._source}|${r.retrieved_at}|${r.slice_key}`, []);

  const toggleDataRow = useCallback((key: string) => {
    setDataSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
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
      if (all) { for (const r of dataDisplayRows) next.delete(dataRowKey(r)); }
      else { for (const r of dataDisplayRows) next.add(dataRowKey(r)); }
      return next;
    });
  }, [dataDisplayRows, dataRowKey]);

  const handleDataDownloadSelected = useCallback(async () => {
    if (!primary.selectedParamId || !selectedRow) return;
    const retrievedAts = [...new Set(Array.from(dataSelected).map((k) => k.split('|')[0]))];
    if (retrievedAts.length === 0) return;
    const opId = sessionLogService.startOperation('info', 'data-fetch', 'SNAPSHOT_DOWNLOAD_RETRIEVALS', `Downloading ${retrievedAts.length} retrieval batch${retrievedAts.length !== 1 ? 'es' : ''}`);
    try {
      const result = await querySnapshotsFull({
        param_id: primary.selectedParamId,
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
      const filename = `${primary.selectedParamId}_${truncateHash(selectedRow.core_hash, 12)}_${retrievedAts.length}retrievals.csv`;
      downloadTextFile({ content: csvRows.join('\n'), filename, mimeType: 'text/csv' });
      toast.success(`Downloaded ${result.rows.length} rows`);
      sessionLogService.endOperation(opId, 'success', `Downloaded ${result.rows.length} rows`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Download failed: ${msg}`);
      sessionLogService.endOperation(opId, 'error', msg);
    }
  }, [primary.selectedParamId, selectedRow, dataSelected]);

  const handleDataDeleteSelected = useCallback(async () => {
    if (!primary.selectedParamId || !selectedRow) return;
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
    const opId = sessionLogService.startOperation('info', 'data-update', 'SNAPSHOT_DELETE_RETRIEVALS', `Deleting ${retrievedAts.length} retrieval batches`);
    try {
      const result = await deleteSnapshotsApi(primary.selectedParamId, [selectedRow.core_hash], retrievedAts);
      if (!result.success) {
        toast.error(`Delete failed: ${result.error || 'unknown error'}`);
        sessionLogService.endOperation(opId, 'error', result.error || 'unknown');
        return;
      }
      toast.success(`Deleted ${result.deleted || 0} snapshot rows`);
      sessionLogService.endOperation(opId, 'success', `Deleted ${result.deleted || 0} rows`);
      await primary.loadSignatures();
      await loadDataRows(selectedRow.core_hash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Delete failed: ${msg}`);
      sessionLogService.endOperation(opId, 'error', msg);
    }
  }, [primary.selectedParamId, selectedRow, dataSelected, showConfirm, primary.loadSignatures, loadDataRows]);


  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="sig-links-viewer" ref={gridRef}>
      {/* ── Shared header ──────────────────────────────────────────────── */}
      <div className="sig-header">
        <h3>Snapshot Manager</h3>
        <span className="sig-header-workspace">{repo}/{branch}</span>
      </div>

      {/* ── Primary browse half ─────────────────────────────────────── */}
      <ParamSigBrowser
        browser={primary}
        variant="primary"
        workspacePrefix={workspacePrefix}
        navigatorParams={navigatorParams}
        graphParamIds={graphParamIds}
        dbParams={dbParams}
        currentCoreHash={currentCoreHash}
        compareHash={compareHash}
        onCompareClick={handleCompareClick}
        graphItems={graphItems}
        selectedGraphName={selectedGraphName}
        onGraphChange={setSelectedGraphName}
        floatingAction={primary.selectedHash && !secondaryOpen ? (
          <button
            className={`sig-floating-pill${compareHash ? ' muted' : ' secondary'}`}
            onClick={() => { setCompareHash(null); setSecondaryMode('cross-param'); }}
            title="Compare against a hash from a different parameter"
          >
            Compare to another param
          </button>
        ) : undefined}
      />

      {/* ── Grid resize handle ────────────────────────────────────────── */}
      <div
        className={`sig-grid-handle${gridDragging ? ' active' : ''}`}
        onMouseDown={onGridHandleDown}
      />

      {/* ── Right pane (grid: right column, spans rows 2-4) ─────────── */}
      <div className="sig-links-right">
        {/* ── Subject strip (always visible above tabs) ─────────────── */}
        {selectedRow && (
          <div className="sig-subject-strip">
            <span className="sig-subject-param">
              {primary.selectedParamId?.startsWith(workspacePrefix)
                ? primary.selectedParamId.slice(workspacePrefix.length)
                : primary.selectedParamId}
            </span>
            <span className="sig-hash-chip primary" data-tip={hashChipTip(selectedRow)}>{truncateHash(selectedRow.core_hash)}</span>
            {effectiveCompareRow && (
              <>
                <span className="sig-subject-vs">vs</span>
                <span className="sig-hash-chip secondary" data-tip={hashChipTip(effectiveCompareRow)}>{truncateHash(effectiveCompareRow.core_hash)}</span>
                {effectiveCompareParamId && effectiveCompareParamId !== primary.selectedParamId && (
                  <span className="sig-subject-param" style={{ fontSize: 10, color: '#888' }}>
                    ({effectiveCompareParamId.startsWith(workspacePrefix) ? effectiveCompareParamId.slice(workspacePrefix.length) : effectiveCompareParamId})
                  </span>
                )}
              </>
            )}
          </div>
        )}
        <div className="sig-right-tab-bar">
          <button
            className="sig-right-tab sig-back-btn"
            disabled={!canGoBack}
            onClick={handleBack}
            title="Back to previous view"
          >
            ←
          </button>
          <button className={`sig-right-tab${rightTab === 'detail' ? ' active' : ''}`} onClick={() => setRightTab('detail')}>
            Detail
          </button>
          <button className={`sig-right-tab${rightTab === 'data' ? ' active' : ''}`} onClick={() => setRightTab('data')}>
            Data
          </button>
          <button className={`sig-right-tab${rightTab === 'links' ? ' active' : ''}${effectiveCompareRow ? ' has-compare' : ''}${linkSuccessFlash ? ' link-success' : ''}`} onClick={() => setRightTab('links')}>
            {linkSuccessFlash ? '✓ Linked' : 'Links'}
          </button>
        </div>

        <div className={`sig-links-right-body${rightTab === 'detail' && (selectedRow || bothSelected) ? ' sig-detail-flex' : ''}`}>
          {/* ── DETAIL TAB ─────────────────────────────────────────────── */}
          {rightTab === 'detail' && (
            <>
              {!selectedRow && !effectiveCompareRow && (
                <div className="sig-links-right-empty">
                  <Search className="sig-empty-icon" size={28} strokeWidth={1.5} />
                  <span>Select a signature from the left to view its detail, data, or links</span>
                </div>
              )}

              {/* Auto diff: shown whenever both primary and compare are selected */}
              {bothSelected && primary.selectedRow && effectiveCompareRow && (
                <>
                  <div className="sig-detail-strip">
                    <div className="sig-detail-toolbar">
                      <button
                        className="sig-action-btn"
                        disabled={!(primary.selectedRow.inputs_json?.provenance?.graph_name || selectedGraphName)}
                        title={
                          (primary.selectedRow.inputs_json?.provenance?.graph_name || selectedGraphName)
                            ? `Open historical graph at ${formatDate(primary.selectedRow.created_at)} with asat() clause`
                            : 'Select a graph in the header to use this'
                        }
                        onClick={() => void handleViewGraphWithAsat(primary.selectedRow!)}
                      >
                        View graph at {formatDate(primary.selectedRow.created_at)}
                      </button>
                      {(compareHash || secondaryOpen) && (
                        <button
                          className="sig-action-btn"
                          disabled={!effectiveCompareHash}
                          onClick={handleSwap}
                          title="Swap primary ↔ compare"
                        >
                          Swap ↕
                        </button>
                      )}
                      <button
                        className="sig-action-btn sig-btn-secondary"
                        onClick={() => setRightTab('links')}
                        title="Create an equivalence or directional link between these two signatures"
                      >
                        Create link →
                      </button>
                    </div>
                  </div>
                  <div className="sig-detail-editor-region">
                    <div className="sig-detail-editor-label">
                      <span style={{ color: 'var(--clr-primary)' }}>Primary</span>
                      {' (left) vs '}
                      <span style={{ color: 'var(--clr-secondary)' }}>Compare</span>
                      {' (right)'}
                    </div>
                    <div className="sig-detail-editor-wrap">
                      <DiffEditor
                        original={safeJsonStringify(primary.selectedRow.inputs_json ?? primary.selectedRow.canonical_signature)}
                        modified={safeJsonStringify(effectiveCompareRow.inputs_json ?? effectiveCompareRow.canonical_signature)}
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
                  </div>
                </>
              )}

              {/* Single-selection detail (only when no compare target) */}
              {selectedRow && !effectiveCompareRow && (
                <>
                  <div className="sig-detail-strip">
                    <div className="sig-detail-strip-row">
                      <span className="sig-detail-label">Created</span>
                      <span className="sig-detail-value">{formatDate(selectedRow.created_at)}</span>
                      {(() => {
                        const stats = primary.sigStatsMap.get(selectedRow.core_hash);
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
                    {primary.resolvedClosure.length > 1 && (
                      <div className="sig-detail-strip-row">
                        <span className="sig-detail-label">Equiv</span>
                        <div className="sig-closure-chips">
                          {primary.resolvedClosure.map((h) => (
                            <span key={h} className="sig-hash-chip" title={h} data-tip={h}>{truncateHash(h)}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="sig-detail-toolbar">
                      <button
                        className="sig-action-btn"
                        disabled={!(selectedRow.inputs_json?.provenance?.graph_name || selectedGraphName)}
                        title={
                          (selectedRow.inputs_json?.provenance?.graph_name || selectedGraphName)
                            ? `Open historical graph at ${formatDate(selectedRow.created_at)} with asat() clause`
                            : 'Select a graph in the header to use this'
                        }
                        onClick={() => void handleViewGraphWithAsat(selectedRow)}
                      >
                        View graph at {formatDate(selectedRow.created_at)}
                      </button>
                      {(() => {
                        const stats = primary.sigStatsMap.get(selectedRow.core_hash);
                        return stats && stats.snapshots > 0 ? (
                          <button className="sig-action-btn" onClick={() => void handleDownloadSnapshots(selectedRow.core_hash)}>
                            Download ({stats.snapshots})
                          </button>
                        ) : null;
                      })()}
                      {(() => {
                        const stats = primary.sigStatsMap.get(selectedRow.core_hash);
                        return stats && stats.snapshots > 0 ? (
                          <button className="sig-action-btn danger" onClick={() => void handleDeleteSnapshots(selectedRow.core_hash)}>
                            Delete
                          </button>
                        ) : null;
                      })()}
                    </div>
                  </div>
                  <div className="sig-detail-editor-region">
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
                  </div>
                </>
              )}
            </>
          )}

          {/* ── LINKS TAB ──────────────────────────────────────────────── */}
          {rightTab === 'links' && (
            <>
              {!selectedRow && (
                <div className="sig-links-right-empty">
                  <Link2 className="sig-empty-icon" size={28} strokeWidth={1.5} />
                  <span>Select a signature to view and manage its equivalence links</span>
                </div>
              )}
              {selectedRow && (
                <>
                  {/* ── Existing links ── */}
                  <div className="sig-links-section-title">Existing links</div>
                  {primary.linkRows.filter((l) => l.core_hash === selectedRow.core_hash || l.equivalent_to === selectedRow.core_hash).length === 0 && (
                    <div style={{ padding: '8px 0', color: '#999', fontSize: 11 }}>No links for this signature</div>
                  )}
                  {primary.linkRows
                    .filter((l) => l.core_hash === selectedRow.core_hash || l.equivalent_to === selectedRow.core_hash)
                    .map((l) => {
                      const otherHash = l.core_hash === selectedRow.core_hash ? l.equivalent_to : l.core_hash;
                      const otherParamId = l.core_hash === selectedRow.core_hash
                        ? (l.source_param_id || l.param_id)
                        : l.param_id;
                      const isSameParam = !otherParamId || otherParamId === primary.selectedParamId;
                      const isEquivalent = !l.operation || l.operation === 'equivalent';
                      const opLabel = isEquivalent ? '≡' : l.operation;
                      const otherParamDisplay = otherParamId && !isSameParam
                        ? (otherParamId.startsWith(workspacePrefix) ? otherParamId.slice(workspacePrefix.length) : otherParamId)
                        : null;

                      const handleNavigateToLink = isEquivalent
                        ? () => {
                            pushNav();
                            if (isSameParam) {
                              primary.setSelectedHash(otherHash);
                            } else {
                              primary.setPendingHash(otherHash);
                              primary.setSelectedParamId(otherParamId);
                            }
                          }
                        : undefined;

                      return (
                        <div key={`${l.core_hash}:${l.equivalent_to}`} className="sig-existing-link">
                          <span
                            className="sig-existing-link-label"
                            title={isEquivalent
                              ? `${otherHash}${otherParamDisplay ? ` (${otherParamDisplay})` : ''}\nClick to navigate`
                              : `${otherHash}${otherParamDisplay ? ` (${otherParamDisplay})` : ''}\nDirectional link (${opLabel}) — not used for equivalence resolution`}
                          >
                            {opLabel}{' '}
                            {handleNavigateToLink ? (
                              <a
                                className="sig-existing-link-hash sig-hash-chip"
                                role="button"
                                tabIndex={0}
                                title={`${otherHash}${otherParamDisplay ? `\nParam: ${otherParamDisplay}` : ''}\nClick to navigate`}
                                data-tip={`${otherHash}${otherParamDisplay ? ` · Param: ${otherParamDisplay}` : ''}`}
                                onClick={(e) => { e.stopPropagation(); handleNavigateToLink(); }}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); handleNavigateToLink(); } }}
                              >
                                {truncateHash(otherHash, 16)}
                              </a>
                            ) : (
                              <span className="sig-hash-chip" title={`${otherHash}${otherParamDisplay ? `\nParam: ${otherParamDisplay}` : ''}`} data-tip={`${otherHash}${otherParamDisplay ? ` · Param: ${otherParamDisplay}` : ''}`}>{truncateHash(otherHash, 16)}</span>
                            )}
                            {otherParamDisplay && (
                              handleNavigateToLink ? (
                                <a
                                  className="sig-existing-link-param"
                                  role="button"
                                  tabIndex={0}
                                  onClick={(e) => { e.stopPropagation(); handleNavigateToLink(); }}
                                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); handleNavigateToLink(); } }}
                                >
                                  {' '}({otherParamDisplay})
                                </a>
                              ) : (
                                <span className="sig-existing-link-param" style={{ cursor: 'default' }}>
                                  {' '}({otherParamDisplay})
                                </span>
                              )
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

                  {/* ── Create link from compare target ── */}
                  <div className="sig-links-section-title" style={{ marginTop: 16 }}>
                    Create new link
                  </div>

                  {!effectiveCompareRow && (
                    <div style={{ padding: '8px 0', color: '#999', fontSize: 11 }}>
                      Click a second signature card to set a compare target, or use <strong>Compare to another param</strong> below.
                    </div>
                  )}

                  {effectiveCompareRow && (
                    <div className="sig-link-form">
                      <div style={{ marginBottom: 8, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="sig-hash-chip primary" data-tip={hashChipTip(selectedRow)}>{truncateHash(selectedRow.core_hash, 16)}</span>
                        <span style={{ color: '#888' }}>→</span>
                        <span className="sig-hash-chip secondary" data-tip={hashChipTip(effectiveCompareRow)}>{truncateHash(effectiveCompareRow.core_hash, 16)}</span>
                        {effectiveCompareParamId && effectiveCompareParamId !== primary.selectedParamId && (
                          <span style={{ fontSize: 10, color: '#666', marginLeft: 6 }}>
                            ({effectiveCompareParamId.startsWith(workspacePrefix) ? effectiveCompareParamId.slice(workspacePrefix.length) : effectiveCompareParamId})
                          </span>
                        )}
                      </div>

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
                        <button className="sig-action-btn sig-btn-secondary" onClick={() => void handleCreateLink()}>
                          Create link
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* ── DATA TAB ──────────────────────────────────────────────── */}
          {rightTab === 'data' && (
            <>
              {!selectedRow && (
                <div className="sig-links-right-empty">
                  <BarChart3 className="sig-empty-icon" size={28} strokeWidth={1.5} />
                  <span>Select a signature to view its snapshot retrievals</span>
                </div>
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
                        <input type="checkbox" checked={dataAllSelected} onChange={toggleDataSelectAll} />
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
                      <select className="sig-filter-select" value={dataSortField} onChange={(e) => setDataSortField(e.target.value as any)}>
                        <option value="retrieved_at">Retrieved</option>
                        <option value="anchor_from">Anchor from</option>
                        <option value="anchor_to">Anchor to</option>
                        <option value="row_count">Rows</option>
                        <option value="sum_x">Σ n</option>
                        <option value="sum_y">Σ k</option>
                        <option value="slice_key">Slice</option>
                      </select>
                      <select className="sig-filter-select" value={dataSortDir} onChange={(e) => setDataSortDir(e.target.value as any)}>
                        <option value="desc">Desc</option>
                        <option value="asc">Asc</option>
                      </select>
                      {effectiveCompareRow && (
                        <span className="sig-data-source-toggle">
                          <button className={`sig-source-btn${dataSourceFilter === 'both' ? ' active' : ''}`} onClick={() => setDataSourceFilter('both')}>Both</button>
                          <button className={`sig-source-btn primary${dataSourceFilter === 'primary' ? ' active' : ''}`} onClick={() => setDataSourceFilter('primary')}>Primary ({dataRows.length})</button>
                          <button className={`sig-source-btn secondary${dataSourceFilter === 'compare' ? ' active' : ''}`} onClick={() => setDataSourceFilter('compare')}>Compare ({compareDataRows.length})</button>
                        </span>
                      )}
                      <span className="sig-data-count">{dataDisplayRows.length} retrieval{dataDisplayRows.length !== 1 ? 's' : ''}</span>
                    </div>
                  </div>

                  {(dataLoading || compareDataLoading) && <div className="sig-links-loading">Loading…</div>}

                  {!dataLoading && !compareDataLoading && (
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
                            const sourceClass = effectiveCompareRow ? ` data-src-${r._source}` : '';
                            return (
                              <tr key={key} className={`${isSel ? 'selected' : ''}${sourceClass}`} onClick={() => toggleDataRow(key)}>
                                <td>
                                  <input type="checkbox" checked={isSel} onChange={() => toggleDataRow(key)} onClick={(e) => e.stopPropagation()} />
                                </td>
                                <td className="mono">{formatDateTime(r.retrieved_at)}</td>
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
                              <td colSpan={7}>
                                <div className="sig-links-right-empty" style={{ padding: '24px 0' }}>
                                  <BarChart3 className="sig-empty-icon" size={22} strokeWidth={1.5} />
                                  <span>No retrievals for this signature yet</span>
                                </div>
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* ── Linked signature data ── */}
                  {linkedDataLoading && linkedDataSections.length === 0 && (
                    <div style={{ padding: '12px 0', color: '#999', fontSize: 11 }}>Loading linked data…</div>
                  )}
                  {linkedDataSections.map((section) => {
                    const sectionKey = `primary|${section.paramId}|${section.coreHash}`;
                    const isCollapsed = collapsedLinkedSections.has(sectionKey);
                    return (
                    <div key={sectionKey} style={{ marginTop: 16 }}>
                      <div
                        className="sig-links-section-title sig-section-collapsible"
                        style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}
                        onClick={() => toggleLinkedSection(sectionKey)}
                      >
                        <span className="sig-section-caret">{isCollapsed ? '▸' : '▾'}</span>
                        <span>Linked:{' '}
                          <a
                            className="sig-existing-link-hash sig-hash-chip"
                            role="button"
                            tabIndex={0}
                            title={`${section.coreHash}${section.paramId !== primary.selectedParamId ? `\nParam: ${section.paramId}` : ''}\nClick to navigate`}
                            onClick={(e) => {
                              e.stopPropagation();
                              pushNav();
                              if (section.paramId === primary.selectedParamId) {
                                primary.setSelectedHash(section.coreHash);
                              } else {
                                primary.setPendingHash(section.coreHash);
                                primary.setSelectedParamId(section.paramId);
                              }
                              setRightTab('data');
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.stopPropagation();
                                pushNav();
                                if (section.paramId === primary.selectedParamId) {
                                  primary.setSelectedHash(section.coreHash);
                                } else {
                                  primary.setPendingHash(section.coreHash);
                                  primary.setSelectedParamId(section.paramId);
                                }
                                setRightTab('data');
                              }
                            }}
                          >
                            {section.label}
                          </a>
                        </span>
                        <span style={{ fontWeight: 400, color: '#888', fontSize: 10 }}>
                          {section.rows.length} retrieval{section.rows.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      {!isCollapsed && (
                        section.rows.length === 0 ? (
                          <div style={{ padding: '6px 0', color: '#999', fontSize: 11 }}>No retrievals</div>
                        ) : (
                          <div className="sig-data-table-wrap">
                            <table className="sig-data-table">
                              <thead>
                                <tr>
                                  <th>Retrieved</th>
                                  <th>Slice</th>
                                  <th>Anchor range</th>
                                  <th style={{ textAlign: 'right' }}>Rows</th>
                                  <th style={{ textAlign: 'right' }}>Σ n</th>
                                  <th style={{ textAlign: 'right' }}>Σ k</th>
                                </tr>
                              </thead>
                              <tbody>
                                {section.rows.map((r) => {
                                  const anchorRange = r.anchor_from && r.anchor_to
                                    ? `${formatDate(r.anchor_from)} – ${formatDate(r.anchor_to)}`
                                    : (r.anchor_from ? `${formatDate(r.anchor_from)} – ?` : (r.anchor_to ? `? – ${formatDate(r.anchor_to)}` : '—'));
                                  return (
                                    <tr key={`${r.retrieved_at}|${r.slice_key}`}>
                                      <td className="mono">{formatDateTime(r.retrieved_at)}</td>
                                      <td className="mono" title={r.slice_key}>{r.slice_key || '—'}</td>
                                      <td>{anchorRange}</td>
                                      <td style={{ textAlign: 'right' }}>{(r.row_count ?? 0).toLocaleString()}</td>
                                      <td style={{ textAlign: 'right' }}>{(r.sum_x ?? 0).toLocaleString()}</td>
                                      <td style={{ textAlign: 'right' }}>{(r.sum_y ?? 0).toLocaleString()}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )
                      )}
                    </div>
                    );
                  })}

                  {/* ── Compare hash linked signature data ── */}
                  {effectiveCompareRow && (
                    <>
                      {compareLinkedLoading && compareLinkedSections.length === 0 && (
                        <div style={{ padding: '12px 0', color: '#b45309', fontSize: 11 }}>Loading compare linked data…</div>
                      )}
                      {compareLinkedSections.map((section) => {
                        const sectionKey = `compare|${section.paramId}|${section.coreHash}`;
                        const isCollapsed = collapsedLinkedSections.has(sectionKey);
                        return (
                        <div key={sectionKey} style={{ marginTop: 16, borderLeft: '3px solid var(--clr-secondary)', paddingLeft: 8 }}>
                          <div
                            className="sig-links-section-title sig-section-collapsible"
                            style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}
                            onClick={() => toggleLinkedSection(sectionKey)}
                          >
                            <span className="sig-section-caret">{isCollapsed ? '▸' : '▾'}</span>
                            <span style={{ color: '#b45309' }}>Compare linked:{' '}
                              <a
                                className="sig-existing-link-hash sig-hash-chip secondary"
                                role="button"
                                tabIndex={0}
                                title={`${section.coreHash}${section.paramId !== (effectiveCompareParamId || '') ? `\nParam: ${section.paramId}` : ''}\nClick to navigate`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  pushNav();
                                  primary.setPendingHash(section.coreHash);
                                  primary.setSelectedParamId(section.paramId);
                                  setRightTab('data');
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.stopPropagation();
                                    pushNav();
                                    primary.setPendingHash(section.coreHash);
                                    primary.setSelectedParamId(section.paramId);
                                    setRightTab('data');
                                  }
                                }}
                              >
                                {section.label}
                              </a>
                            </span>
                            <span style={{ fontWeight: 400, color: '#888', fontSize: 10 }}>
                              {section.rows.length} retrieval{section.rows.length !== 1 ? 's' : ''}
                            </span>
                          </div>
                          {!isCollapsed && (
                            section.rows.length === 0 ? (
                              <div style={{ padding: '6px 0', color: '#999', fontSize: 11 }}>No retrievals</div>
                            ) : (
                              <div className="sig-data-table-wrap" style={{ borderColor: 'var(--clr-secondary-border)' }}>
                                <table className="sig-data-table">
                                  <thead>
                                    <tr>
                                      <th>Retrieved</th>
                                      <th>Slice</th>
                                      <th>Anchor range</th>
                                      <th style={{ textAlign: 'right' }}>Rows</th>
                                      <th style={{ textAlign: 'right' }}>Σ n</th>
                                      <th style={{ textAlign: 'right' }}>Σ k</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {section.rows.map((r) => {
                                      const anchorRange = r.anchor_from && r.anchor_to
                                        ? `${formatDate(r.anchor_from)} – ${formatDate(r.anchor_to)}`
                                        : (r.anchor_from ? `${formatDate(r.anchor_from)} – ?` : (r.anchor_to ? `? – ${formatDate(r.anchor_to)}` : '—'));
                                      return (
                                        <tr key={`${r.retrieved_at}|${r.slice_key}`} style={{ background: '#fffbeb' }}>
                                          <td className="mono">{formatDateTime(r.retrieved_at)}</td>
                                          <td className="mono" title={r.slice_key}>{r.slice_key || '—'}</td>
                                          <td>{anchorRange}</td>
                                          <td style={{ textAlign: 'right' }}>{(r.row_count ?? 0).toLocaleString()}</td>
                                          <td style={{ textAlign: 'right' }}>{(r.sum_x ?? 0).toLocaleString()}</td>
                                          <td style={{ textAlign: 'right' }}>{(r.sum_y ?? 0).toLocaleString()}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )
                          )}
                        </div>
                        );
                      })}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>{/* end sig-links-right */}

      {/* ── Cross-param comparison pop-up (bottom-left overlay) ────── */}
      {secondaryOpen && (
        <div className="sig-compare-popup">
          <div className="sig-compare-popup-header">
            <span className="sig-compare-popup-label">Cross-param compare</span>
            <div style={{ flex: 1 }} />
            <button
              className="sig-action-btn"
              disabled={!secondary.selectedHash}
              onClick={handleSwap}
              title="Swap primary ↔ compare"
              style={{ fontSize: 10, padding: '3px 8px' }}
            >
              Swap ↕
            </button>
            <button
              className="sig-action-btn"
              onClick={() => { setSecondaryMode('hidden'); secondary.setSelectedHash(null); }}
              title="Close"
              style={{ fontWeight: 600, padding: '4px 10px' }}
            >
              ✕
            </button>
          </div>
          <div className="sig-compare-popup-body">
            <ParamSigBrowser
              browser={secondary}
              variant="secondary"
              workspacePrefix={workspacePrefix}
              navigatorParams={navigatorParams}
              graphParamIds={secondaryGraphParamIds}
              dbParams={dbParams}
              graphItems={graphItems}
              selectedGraphName={secondaryGraphName}
              onGraphChange={setSecondaryGraphName}
            />
          </div>
        </div>
      )}
    </div>
  );
};
