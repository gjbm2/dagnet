/**
 * WindowSelector Component
 * 
 * Graph-level date range picker for data fetching window selection.
 * Automatically checks data coverage when window changes.
 * Shows "Fetch data" button if data is missing for connected parameters/cases.
 */

import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useGraphStore } from '../contexts/GraphStoreContext';
import type { DateRange } from '../types';
import { fileRegistry, useTabContext } from '../contexts/TabContext';
import { DateRangePicker } from './DateRangePicker';
import { AtSign, ChevronLeft, ChevronRight, FileText, X, Zap, ToggleLeft, ToggleRight } from 'lucide-react';
import { parseConstraints } from '../lib/queryDSL';
import { formatDateUK, resolveRelativeDate, normalizeToUK, parseUKDate, toISO } from '../lib/dateFormat';
import toast from 'react-hot-toast';
import { validatePinnedDataInterestsDSL } from '../services/slicePlanValidationService';
import './WindowSelector.css';
import { ContextValueSelector } from './ContextValueSelector';
import { contextRegistry } from '../services/contextRegistry';
import { QueryExpressionEditor } from './QueryExpressionEditor';
import { PinnedQueryModal } from './modals/PinnedQueryModal';
import { BulkScenarioCreationModal } from './modals/BulkScenarioCreationModal';
import { useFetchData, createFetchItem } from '../hooks/useFetchData';
import { useBulkScenarioCreation } from '../hooks/useBulkScenarioCreation';
import { windowFetchPlannerService, type PlannerResult } from '../services/windowFetchPlannerService';
import { useIsReadOnlyShare } from '../contexts/ShareModeContext';
import { getSnapshotRetrievalsForEdge, getSnapshotCoverageForEdges } from '../services/snapshotRetrievalsService';
import { querySelectionUuids } from '../hooks/useQuerySelectionUuids';
import { parseDate } from '../services/windowAggregationService';


interface WindowSelectorProps {
  tabId?: string;
}

export function WindowSelector({ tabId }: WindowSelectorProps = {}) {
  const graphStore = useGraphStore();
  const { graph, window, setWindow, setGraph, lastAggregatedWindow, setLastAggregatedWindow, currentDSL, setCurrentDSL } = graphStore;
  // Use getState() in callbacks to avoid stale closure issues
  const getLatestGraph = () => (graphStore as any).getState?.()?.graph ?? graph;
  const { tabs, operations } = useTabContext();
  
  // Share mode: disable all data operations in static share mode
  const isReadOnlyShare = useIsReadOnlyShare();

  // Workspace scoping for context loading (avoid mixing contexts across repos/branches in IndexedDB).
  const workspaceForContextRegistry = useMemo(() => {
    const tab = tabId ? tabs.find(t => t.id === tabId) : undefined;
    if (!tab) return undefined;
    const file = fileRegistry.getFile(tab.fileId);
    const repository = file?.source?.repository;
    const branch = file?.source?.branch;
    return repository && branch ? { repository, branch } : undefined;
  }, [tabId, tabs]);
  
  // CRITICAL: These refs must be defined BEFORE useFetchData hook since it uses them
  const isInitialMountRef = useRef(true);
  const isAggregatingRef = useRef(false); // Track if we're currently aggregating to prevent loops
  const lastAggregatedDSLRef = useRef<string | null>(null); // Track DSL used for explicit/user fetch
  const lastAutoAggregatedDSLRef = useRef<string | null>(null); // Track DSL we have already auto-aggregated for
  const lastAnalysedDSLRef = useRef<string | null>(null); // Track DSL we have already analysed to avoid duplicate planner runs
  const graphRef = useRef<typeof graph>(graph); // Track graph to avoid dependency loop
  const prevDSLRef = useRef<string | null>(null); // Track previous DSL for shimmer trigger
  
  // Centralized fetch hook - uses refs for batch operations
  // The ref-based setGraph prevents effect re-triggering during auto-aggregation
  // CRITICAL: Uses graphStore.currentDSL as AUTHORITATIVE source, NOT graph.currentQueryDSL!
  const { fetchItem, fetchItems, getItemsNeedingFetch } = useFetchData({
    graph: () => graphRef.current,  // Getter for fresh state during batch
    setGraph: (g) => {
      if (g) {
        graphRef.current = g;  // Update ref immediately
        // Only trigger real setGraph if not in batch mode
        if (!isAggregatingRef.current) {
          setGraph(g);
        }
      }
    },
    currentDSL: () => (graphStore as any).getState?.()?.currentDSL || '',  // AUTHORITATIVE DSL from graphStore
  });
  const [isFetching, setIsFetching] = useState(false);
  const [showShimmer, setShowShimmer] = useState(false); // Track shimmer animation
  
  // Planner-based state
  const [plannerResult, setPlannerResult] = useState<PlannerResult | null>(null);
  const [isExecutingPlanner, setIsExecutingPlanner] = useState(false);
  
  // Derive UI state from planner result
  const plannerOutcome = plannerResult?.outcome ?? 'covered_stable';
  const buttonLabel = plannerOutcome === 'not_covered' ? 'Fetch data' 
                    : plannerOutcome === 'covered_stale' ? 'Refresh' 
                    : 'Up to date';
  const buttonTooltip = plannerResult?.summaries.buttonTooltip ?? 'All data is up to date.';
  const buttonNeedsAttention = plannerOutcome === 'not_covered' || plannerOutcome === 'covered_stale';
  const isAnalysing = plannerResult?.status === 'pending';
  
  // Context dropdown and unroll states
  const [showContextDropdown, setShowContextDropdown] = useState(false);
  const [availableKeySections, setAvailableKeySections] = useState<any[]>([]);
  const [isContextLoading, setIsContextLoading] = useState(false);
  const [contextLoadError, setContextLoadError] = useState<string | null>(null);
  
  // Cohort/Window mode toggle - determines DSL function: cohort() vs window()
  // Default to cohort mode as per design (§7.5)
  const [queryMode, setQueryMode] = useState<'cohort' | 'window'>('cohort');
  const [isUnrolled, setIsUnrolled] = useState(false);
  const [showPinnedQueryModal, setShowPinnedQueryModal] = useState(false);

  // Phase 2: asat() `@` UI
  const [isAsatDropdownOpen, setIsAsatDropdownOpen] = useState(false);
  const [isAsatLoading, setIsAsatLoading] = useState(false);
  const [asatDays, setAsatDays] = useState<string[]>([]);
  const [asatCoverageByDay, setAsatCoverageByDay] = useState<Record<string, number>>({});
  const [asatError, setAsatError] = useState<string | null>(null);
  /** Label describing what the calendar is showing (e.g. "for e.A->B.p" or "For 10 edges") */
  const [asatScopeLabel, setAsatScopeLabel] = useState<string>('');
  const [asatMonthCursor, setAsatMonthCursor] = useState<Date>(() => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  });
  const asatButtonRef = useRef<HTMLButtonElement>(null);
  const asatDropdownRef = useRef<HTMLDivElement>(null);
  
  // Preset context menu state
  const [presetContextMenu, setPresetContextMenu] = useState<{
    x: number;
    y: number;
    preset: 7 | 30 | 90;
  } | null>(null);
  const presetContextMenuRef = useRef<HTMLDivElement>(null);
  
  // Bulk scenario creation hook
  const {
    createWindowScenario,
    createMultipleWindowScenarios,
    getWindowDSLForPreset,
    openBulkCreateForContext,
    bulkCreateModal,
    closeBulkCreateModal,
    createScenariosForContext
  } = useBulkScenarioCreation(tabId);
  const [showingAllContexts, setShowingAllContexts] = useState(false);
  
  const contextButtonRef = useRef<HTMLButtonElement>(null);
  const contextDropdownRef = useRef<HTMLDivElement>(null);
  const windowSelectorRef = useRef<HTMLDivElement>(null);

  // NOTE: editorState.selectedEdgeId is a stale "last clicked" value that
  // persists after deselection.  We rely on querySelectionUuids() (ReactFlow
  // .selected state) inside loadAsatDays instead — see comment there.

  const parsedAuthoritative = useMemo(() => {
    try {
      return parseConstraints(currentDSL || '');
    } catch {
      return parseConstraints('');
    }
  }, [currentDSL]);

  const activeAsat = parsedAuthoritative.asat || null;

  // Calculate default window dates (last 7 days) - needed early for initialization
  // NOTE: Must be declared before any callbacks that reference it.
  const defaultWindowDates = useMemo(() => {
    const defaultEnd = new Date();
    const defaultStart = new Date();
    defaultStart.setDate(defaultEnd.getDate() - 7);
    return {
      start: formatDateUK(defaultStart),
      end: formatDateUK(defaultEnd)
    };
  }, []);

  // Keep the calendar month cursor aligned to the active asat date.
  useEffect(() => {
    if (!activeAsat) return;
    try {
      const uk = resolveRelativeDate(activeAsat);
      const d = parseUKDate(uk);
      const cursor = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
      setAsatMonthCursor(cursor);
    } catch {
      // ignore
    }
  }, [activeAsat]);

  const stripAsatClause = useCallback((dsl: string): string => {
    return (dsl || '').replace(/\.?(?:asat|at)\([^)]+\)/g, '').replace(/^\./, '');
  }, []);

  // Build DSL from AUTHORITATIVE sources: window state + context from UI
  // NEVER use graph.currentQueryDSL directly for queries - it's just a record
  // Uses queryMode to determine cohort() vs window() function
  const buildDSLFromState = useCallback((windowState: DateRange, mode?: 'cohort' | 'window'): string => {
    // Get context from graph.currentQueryDSL (this IS where user's selection is stored)
    const parsed = parseConstraints(graph?.currentQueryDSL || '');

    const contextParts: string[] = [];
    for (const ctx of parsed.context) {
      contextParts.push(`context(${ctx.key}:${ctx.value})`);
    }
    for (const ctxAny of parsed.contextAny) {
      const pairs = ctxAny.pairs.map(p => `${p.key}:${p.value}`).join(',');
      contextParts.push(`contextAny(${pairs})`);
    }

    // Build window/cohort from AUTHORITATIVE window state (not from graph.currentQueryDSL)
    // Use provided mode or fall back to current queryMode state
    const effectiveMode = mode ?? queryMode;
    const dateRangePart = `${effectiveMode}(${formatDateUK(windowState.start)}:${formatDateUK(windowState.end)})`;

    // Preserve asat clause if present in current DSL
    const asatPart = parsed.asat ? `asat(${parsed.asat})` : '';

    const parts = [contextParts.join('.'), dateRangePart, asatPart].filter(p => p);
    return parts.join('.');
  }, [graph?.currentQueryDSL, queryMode]);

  const applyAsatToDSL = useCallback((selectedAsatUK: string) => {
    if (!graph || !setGraph) return;

    const base = stripAsatClause(currentDSL || '');
    const parsedBase = parseConstraints(base);
    const range = parsedBase.cohort ?? parsedBase.window;

    // Compute updated window end (one-way truncation policy).
    const currentWindow = window || defaultWindowDates;
    let nextEnd = currentWindow.end;
    try {
      const chosenISO = toISO(selectedAsatUK);
      const curEndResolved = resolveRelativeDate(currentWindow.end);
      const endISO = parseDate(curEndResolved).toISOString().split('T')[0];

      // Truncate only when the chosen day is strictly before the current end day.
      if (chosenISO < endISO) {
        // Keep end values in ISO-with-time form (GraphStore normalises end-of-day).
        nextEnd = `${chosenISO}T23:59:59Z`;
      }
    } catch {
      // best-effort truncation only
    }

    // Keep start as-is (authoritative window state), update end if truncated.
    const nextWindow = { start: currentWindow.start, end: nextEnd };
    if (setWindow) setWindow(nextWindow);

    // Rebuild DSL core from state (contexts + window/cohort), then append asat.
    const core = stripAsatClause(buildDSLFromState(nextWindow));
    const finalDSL = `${core}.asat(${selectedAsatUK})`.replace(/^\./, '');

    setCurrentDSL(finalDSL);
    const currentGraph = getLatestGraph();
    if (currentGraph && setGraph) {
      setGraph({ ...currentGraph, currentQueryDSL: finalDSL });
    }

    // Keep month cursor in sync for UX.
    try {
      const d = parseUKDate(selectedAsatUK);
      const cursor = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
      setAsatMonthCursor(cursor);
    } catch {
      // ignore
    }
  }, [currentDSL, defaultWindowDates, getLatestGraph, graph, setCurrentDSL, setGraph, setWindow, stripAsatClause, window, buildDSLFromState]);

  const clearAsatFromDSL = useCallback(() => {
    if (!graph || !setGraph) return;
    const base = stripAsatClause(currentDSL || '');
    setCurrentDSL(base);
    const currentGraph = getLatestGraph();
    if (currentGraph && setGraph) {
      setGraph({ ...currentGraph, currentQueryDSL: base });
    }
  }, [currentDSL, getLatestGraph, graph, setCurrentDSL, setGraph, stripAsatClause]);

  // Close asat dropdown on outside click
  useEffect(() => {
    if (!isAsatDropdownOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        asatDropdownRef.current &&
        !asatDropdownRef.current.contains(target) &&
        asatButtonRef.current &&
        !asatButtonRef.current.contains(target)
      ) {
        setIsAsatDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isAsatDropdownOpen]);

  const loadAsatDays = useCallback(async () => {
    if (!graph) return;
    setIsAsatLoading(true);
    setAsatError(null);
    try {
      // Determine which edges to query based on canvas selection state.
      // querySelectionUuids() is the source of truth — it reflects ReactFlow's
      // .selected property which correctly tracks single clicks AND clears on
      // deselection.  Do NOT fall back to selectedEdgeId (stale "last clicked"
      // value from editorState that persists after deselection).
      const multiSel = querySelectionUuids();
      const effectiveEdgeIds = multiSel.selectedEdgeUuids || [];

      // Build a human-readable scope label.
      // Helper: resolve a node reference (uuid or id) to its human-readable id/name.
      const resolveNodeName = (ref: string | undefined): string => {
        if (!ref) return '?';
        const node = (graph.nodes || []).find((n: any) => n.uuid === ref || n.id === ref);
        return node?.id || ref;
      };

      // Count only connected edges (those with p.id) — edges without a
      // connection can never have snapshots so shouldn't inflate the count.
      const connectedCount = (graph.edges || [])
        .filter((e: any) => e?.p?.id || e?.p?.parameter_id).length;

      if (effectiveEdgeIds.length === 1) {
        const eid = effectiveEdgeIds[0];
        const edge = graph.edges?.find((e: any) => e.uuid === eid || e.id === eid) as any;
        const edgeName = edge
          ? `e.${resolveNodeName(edge.from)}→${resolveNodeName(edge.to)}`
          : eid;
        setAsatScopeLabel(`for ${edgeName}`);
      } else if (effectiveEdgeIds.length > 1) {
        // Filter the selected set to connected edges for an accurate count.
        const connectedSelected = effectiveEdgeIds.filter((eid) => {
          const edge: any = graph.edges?.find((e: any) => e.uuid === eid || e.id === eid);
          return edge?.p?.id || edge?.p?.parameter_id;
        });
        setAsatScopeLabel(`for ${connectedSelected.length} params`);
      } else {
        setAsatScopeLabel(`for all ${connectedCount} params`);
      }

      if (effectiveEdgeIds.length === 1) {
        // Single edge: signature-filtered precision (existing path).
        const res = await getSnapshotRetrievalsForEdge({
          graph,
          edgeId: effectiveEdgeIds[0],
          effectiveDSL: currentDSL || '',
          workspace: workspaceForContextRegistry,
        });
        if (!res.success) {
          setAsatDays([]);
          setAsatCoverageByDay({});
          setAsatError(res.error || 'Failed to load snapshots');
          return;
        }
        const fullCoverage: Record<string, number> = {};
        for (const day of res.retrieved_days || []) fullCoverage[day] = 1.0;
        setAsatDays(res.retrieved_days || []);
        setAsatCoverageByDay(fullCoverage);
      } else {
        // Multiple or all edges: signature-filtered per-edge, then aggregate.
        const res = await getSnapshotCoverageForEdges({
          graph,
          effectiveDSL: currentDSL || '',
          workspace: workspaceForContextRegistry,
          edgeIds: effectiveEdgeIds.length > 0 ? effectiveEdgeIds : undefined,
        });
        if (!res.success) {
          setAsatDays([]);
          setAsatCoverageByDay({});
          setAsatError(res.error || 'Failed to load aggregate snapshots');
          return;
        }
        setAsatDays(res.allDays);
        setAsatCoverageByDay(res.coverageByDay);
      }
    } catch (e) {
      setAsatDays([]);
      setAsatCoverageByDay({});
      setAsatError(String(e));
    } finally {
      setIsAsatLoading(false);
    }
  }, [graph, currentDSL, workspaceForContextRegistry]);

  const openAsatDropdown = useCallback(async () => {
    if (isReadOnlyShare) return;
    setIsAsatDropdownOpen((v) => {
      const next = !v;
      if (next && !activeAsat) {
        try {
          const w = window || defaultWindowDates;
          const endUK = resolveRelativeDate(w.end);
          const d = parseUKDate(endUK);
          setAsatMonthCursor(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
        } catch {
          // ignore
        }
      }
      return next;
    });
  }, [isReadOnlyShare, activeAsat, window, defaultWindowDates]);

  // When dropdown opens, fetch availability
  useEffect(() => {
    if (!isAsatDropdownOpen) return;
    void loadAsatDays();
  }, [isAsatDropdownOpen, loadAsatDays]);

  const asatDaysSet = useMemo(() => new Set(asatDays), [asatDays]);

  const calendarCells = useMemo(() => {
    // Build a 6x7 grid for the current UTC month cursor.
    const year = asatMonthCursor.getUTCFullYear();
    const month = asatMonthCursor.getUTCMonth();
    const firstOfMonth = new Date(Date.UTC(year, month, 1));
    const firstWeekday = firstOfMonth.getUTCDay(); // 0=Sun
    const start = new Date(Date.UTC(year, month, 1 - firstWeekday));

    const cells: Array<{ iso: string; day: number; inMonth: boolean; hasSnapshot: boolean; coverage: number }> = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      const iso = d.toISOString().split('T')[0];
      const inMonth = d.getUTCMonth() === month;
      const coverage = asatCoverageByDay[iso] ?? 0;
      cells.push({
        iso,
        day: d.getUTCDate(),
        inMonth,
        hasSnapshot: inMonth && asatDaysSet.has(iso),
        coverage,
      });
    }
    return cells;
  }, [asatMonthCursor, asatDaysSet, asatCoverageByDay]);

  // DEBUG: Log core state whenever WindowSelector renders
  useEffect(() => {
    const authoritativeDSL = (graphStore as any).getState?.()?.currentDSL || '';
    console.log('[WindowSelector] RENDER snapshot:', {
      authoritativeDSL,
      graphCurrentQueryDSL: graph?.currentQueryDSL,
      window,
      lastAggregatedWindow,
    });
  }, [graphStore, graph?.currentQueryDSL, window, lastAggregatedWindow]);
  
  // Initialize window state in store if not set
  useEffect(() => {
    if (!window && setWindow) {
      console.log('[WindowSelector] Initializing default window:', defaultWindowDates);
      setWindow(defaultWindowDates);
    }
  }, [window, setWindow, defaultWindowDates]);
  
  // Initialize DSL on first load.
  // Priority:
  // 1) If graphStore.currentDSL already set, just derive mode from it.
  // 2) Else, if graph.currentQueryDSL exists, promote it to authoritative DSL.
  // 3) Else, fall back to window-based default DSL.
  // Also detects existing query mode (cohort vs window) from existing DSL.
  const isInitializedRef = useRef(false);
  useEffect(() => {
    if (isInitializedRef.current) return;

    const authoritativeDSL = (graphStore as any).getState?.()?.currentDSL || '';
    
    // 1) If store already has a DSL (e.g. scenarios/other code set it), just derive mode
    if (authoritativeDSL) {
      const existingMode = authoritativeDSL.includes('cohort(') ? 'cohort' : 'window';
      setQueryMode(existingMode);
      isInitializedRef.current = true;
      return;
    }

    // 2) If graph has a historic DSL, promote it to authoritative DSL
    if (graph?.currentQueryDSL) {
      const graphDSL = graph.currentQueryDSL;
      const existingMode = graphDSL.includes('cohort(') ? 'cohort' : 'window';
      setQueryMode(existingMode);
      console.log('[WindowSelector] Initializing AUTHORITATIVE DSL from graph.currentQueryDSL:', graphDSL);
      setCurrentDSL(graphDSL);
      isInitializedRef.current = true;
      return;
    }

    // 3) Fallback: build DSL from window (persisted or default)
    if (graph) {
      const windowToUse = window || defaultWindowDates;
      const defaultDSL = `${queryMode}(${formatDateUK(windowToUse.start)}:${formatDateUK(windowToUse.end)})`;
      console.log('[WindowSelector] Initializing AUTHORITATIVE DSL from window:', defaultDSL);
      setCurrentDSL(defaultDSL);
      isInitializedRef.current = true;
    }
  }, [graph, window, setGraph, setCurrentDSL, defaultWindowDates, graphStore, queryMode]); // Dependencies
  
  // Parse current context values and key from currentQueryDSL
  const currentContextValues = useMemo(() => {
    if (!graph?.currentQueryDSL) return [];
    const parsed = parseConstraints(graph.currentQueryDSL);
    
    const valueIds: string[] = [];
    for (const ctx of parsed.context) {
      valueIds.push(ctx.value);
    }
    for (const ctxAny of parsed.contextAny) {
      for (const pair of ctxAny.pairs) {
        valueIds.push(pair.value);
      }
    }
    return valueIds;
  }, [graph?.currentQueryDSL]);
  
  const currentContextKey = useMemo(() => {
    if (!graph?.currentQueryDSL) return undefined;
    const parsed = parseConstraints(graph.currentQueryDSL);
    
    if (parsed.context.length > 0) return parsed.context[0].key;
    if (parsed.contextAny.length > 0 && parsed.contextAny[0].pairs.length > 0) {
      return parsed.contextAny[0].pairs[0].key;
    }
    return undefined;
  }, [graph?.currentQueryDSL]);
  
    // Update CSS variable for scenario legend positioning when height changes
  // Set on the container element (not document root) so it's scoped to this tab
  useEffect(() => {
    const updatePosition = () => {
      if (windowSelectorRef.current) {
        const height = windowSelectorRef.current.offsetHeight;
        const gap = 16; // Gap between WindowSelector bottom and scenario legend top
        const topOffset = 16; // WindowSelector's top position
        const bottomPosition = topOffset + height + gap;
        
        // Set on the closest .graph-editor-dock-container (scoped to this tab)
        const container = windowSelectorRef.current.closest('.graph-editor-dock-container') as HTMLElement;
        if (container) {
          container.style.setProperty('--window-selector-bottom', `${bottomPosition}px`);
        }
      }
    };
    
    // Update on mount and when dependencies change
    updatePosition();
    
    // Use ResizeObserver to catch all size changes (context chips expanding, etc.)
    const observer = new ResizeObserver(() => {
      updatePosition();
    });
    
    if (windowSelectorRef.current) {
      observer.observe(windowSelectorRef.current);
    }
    
    return () => observer.disconnect();
  }, [isUnrolled, graph?.currentQueryDSL, showContextDropdown, buttonNeedsAttention]);
  
  // Load context keys from graph.dataInterestsDSL when dropdown opens
  // Also reload when graph changes (e.g., after F5)
  useEffect(() => {
    // Skip if in "show all" mode - don't overwrite the full list with pinned DSL
    if (showingAllContexts) {
      console.log('[WindowSelector] Skipping context load - in "show all" mode');
      return;
    }
    
    // Always reload contexts when dropdown opens (don't cache stale data)
    if (showContextDropdown) {
      const loadContextsFromPinnedQuery = async () => {
        setIsContextLoading(true);
        setContextLoadError(null);
        // Clear cache to get fresh data
        contextRegistry.clearCache();
        // Parse dataInterestsDSL to get pinned context keys
        const pinnedDSL = graph?.dataInterestsDSL || '';
        console.log('[WindowSelector] Pinned DSL:', pinnedDSL);
        
        if (!pinnedDSL) {
          console.warn('[WindowSelector] No dataInterestsDSL set on graph - showing all available contexts');
          // Fall back to showing all available contexts
          const keys = await contextRegistry.getAllContextKeys({ workspace: workspaceForContextRegistry });
          console.log('[WindowSelector] All available context keys:', keys);
          const sections = await contextRegistry.getContextSections(keys, { workspace: workspaceForContextRegistry });
          setAvailableKeySections(sections);
          return;
        }
        
        // Parse pinned DSL to extract context keys
        const { parseConstraints } = await import('../lib/queryDSL');
        const clauses = pinnedDSL.split(';').map(c => c.trim()).filter(c => c);
        const contextKeySet = new Set<string>();
        
        for (const clause of clauses) {
          const parsed = parseConstraints(clause);
          for (const ctx of parsed.context) {
            contextKeySet.add(ctx.key);
          }
          for (const ctxAny of parsed.contextAny) {
            for (const pair of ctxAny.pairs) {
              contextKeySet.add(pair.key);
            }
          }
        }
        
        console.log('[WindowSelector] Context keys from pinned DSL:', Array.from(contextKeySet));
        
        // If no context keys in pinned DSL, fall back to showing all available
        if (contextKeySet.size === 0) {
          console.log('[WindowSelector] No context keys in pinned DSL - showing all available contexts');
          const keys = await contextRegistry.getAllContextKeys({ workspace: workspaceForContextRegistry });
          console.log('[WindowSelector] All available context keys:', keys);
          const allSections = await contextRegistry.getContextSections(keys, { workspace: workspaceForContextRegistry });
          setAvailableKeySections(allSections);
          return;
        }
        
        // Load values for each pinned key (resilient to malformed contexts)
        const sections = await contextRegistry.getContextSections(
          Array.from(contextKeySet).map(id => ({ id })),
          { workspace: workspaceForContextRegistry }
        );
        
        console.log('[WindowSelector] Sections from pinned query:', sections);
        setAvailableKeySections(sections);
      };
      
      loadContextsFromPinnedQuery().catch(err => {
        console.error('Failed to load contexts from pinned query:', err);
        setAvailableKeySections([]);
        setContextLoadError(err instanceof Error ? err.message : 'Failed to load contexts');
      }).finally(() => {
        setIsContextLoading(false);
      });
    }
  }, [showContextDropdown, showingAllContexts, graph?.dataInterestsDSL, workspaceForContextRegistry]);
  
  // Close context dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        showContextDropdown &&
        contextButtonRef.current &&
        contextDropdownRef.current &&
        !contextButtonRef.current.contains(event.target as Node) &&
        !contextDropdownRef.current.contains(event.target as Node)
      ) {
        setShowContextDropdown(false);
        setShowingAllContexts(false); // Reset for next open
      }
    }
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showContextDropdown]);
  
  // Close preset context menu when clicking outside
  useEffect(() => {
    if (!presetContextMenu) return;
    
    function handleClickOutside(event: MouseEvent) {
      if (presetContextMenuRef.current && !presetContextMenuRef.current.contains(event.target as Node)) {
        setPresetContextMenu(null);
      }
    }
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [presetContextMenu]);
  
  // Sync refs with state (separate effects to avoid triggering aggregation)
  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);
  
  // Sync lastAggregatedDSL from persisted state on load
  useEffect(() => {
    if (!lastAggregatedWindow) {
      lastAggregatedDSLRef.current = null;
    }
    // Note: lastAggregatedDSLRef is set directly when aggregation happens
  }, [lastAggregatedWindow]);
  
  
  // Show if graph has any edges with parameter files (for windowed aggregation)
  // This includes both external connections and file-based parameters
  const hasParameterFiles = useMemo(() => {
    return graph?.edges?.some(e => e.p?.id || e.cost_gbp?.id || e.labour_cost?.id) || false;
  }, [graph]);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // PLANNER-BASED ANALYSIS
  // Analyse coverage and staleness whenever DSL changes.
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (isExecutingPlanner || isAggregatingRef.current) return;
    
    const authoritativeDSL = (graphStore as any).getState?.()?.currentDSL || '';
    if (!authoritativeDSL || !graph) return;

    // Only run planner when the AUTHORITATIVE DSL actually changes.
    // This prevents repeated PLANNER_ANALYSIS calls for the same DSL
    // during workspace/graph load and other non-DSL updates.
    if (lastAnalysedDSLRef.current === authoritativeDSL) {
      return;
    }
    lastAnalysedDSLRef.current = authoritativeDSL;
    
    const trigger = isInitialMountRef.current ? 'initial_load' : 'dsl_change';
    
    windowFetchPlannerService.analyse(graph, authoritativeDSL, trigger)
      .then(result => {
        setPlannerResult(result);
        isInitialMountRef.current = false;
        
        // Show toast if planner says to
        if (result.summaries.showToast && result.summaries.toastMessage) {
          toast(result.summaries.toastMessage, { icon: '⚠️', duration: 4000 });
        }
      })
      .catch(err => {
        console.error('[WindowSelector] Planner analysis failed:', err);
      });
      
  }, [graph, (graphStore as any).getState?.()?.currentDSL, isExecutingPlanner]);
  
  // Shimmer effect when button needs attention
  useEffect(() => {
    if (buttonNeedsAttention) {
      setTimeout(() => {
        setShowShimmer(true);
        setTimeout(() => setShowShimmer(false), 600);
      }, 100);
    } else {
      setShowShimmer(false);
    }
  }, [buttonNeedsAttention]);
  
  // Re-trigger shimmer on DSL change when button needs attention
  useEffect(() => {
    const authoritativeDSL = (graphStore as any).getState?.()?.currentDSL || '';
    if (!authoritativeDSL) {
      prevDSLRef.current = null;
      return;
    }
    
    const dslChanged = authoritativeDSL !== prevDSLRef.current;
    prevDSLRef.current = authoritativeDSL;
    
    if (dslChanged && buttonNeedsAttention) {
      setShowShimmer(false);
      setTimeout(() => {
        setShowShimmer(true);
        setTimeout(() => setShowShimmer(false), 600);
      }, 50);
    }
  }, [(graphStore as any).getState?.()?.currentDSL, buttonNeedsAttention]);
  
  // Always show - window selector is useful for any parameter-based aggregation
  
  // Use window from store, falling back to defaults calculated earlier
  const startDate = window?.start || defaultWindowDates.start;
  const endDate = window?.end || defaultWindowDates.end;
  
  const currentWindow: DateRange = useMemo(() => ({
    start: startDate,
    end: endDate,
  }), [startDate, endDate]);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // AUTO-AGGREGATION (planner-driven)
  // When planner says covered (stable or stale), aggregate from cache.
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!plannerResult || plannerResult.status !== 'complete') return;
    // On initial load we trust the persisted graph state (graph already reflects
    // the last aggregation for its stored DSL). Do NOT auto-aggregate on
    // initial_load, otherwise we risk noisy from-file fetches before the user
    // has changed the query in any way.
    if (plannerResult.analysisContext?.trigger === 'initial_load') return;
    // Auto-aggregate for BOTH stable and stale (not for not_covered)
    if (plannerResult.outcome === 'not_covered') return;
    if (plannerResult.autoAggregationItems.length === 0) return;
    if (isAggregatingRef.current) return;

    const authoritativeDSL = (graphStore as any).getState?.()?.currentDSL || '';
    if (!authoritativeDSL) return;

    // Avoid repeated auto-aggregation loops for the same DSL
    if (lastAutoAggregatedDSLRef.current === authoritativeDSL) {
        return;
      }
      
    // Trigger auto-aggregation using existing fetchItems with 'from-file' mode
          isAggregatingRef.current = true;
    
    const items = plannerResult.autoAggregationItems.map(i => 
      createFetchItem(i.type, i.objectId, i.targetId, { paramSlot: i.paramSlot })
    );
    
    fetchItems(items, { mode: 'from-file' })
      .then(() => {
        // CRITICAL: Apply accumulated graph changes to React state
        // fetchItems updates graphRef.current, we must trigger re-render
            const updatedGraph = graphRef.current;
        
        // DEBUG: Log what we're about to set as the graph
        const latencyEdges = (updatedGraph?.edges || []).filter((e: any) => e.p?.latency?.completeness !== undefined);
        console.log('[WindowSelector] fetchItems completed, about to setGraph:', {
          hasGraph: !!updatedGraph,
          latencyEdgeCount: latencyEdges.length,
          sample: latencyEdges.slice(0, 3).map((e: any) => ({
            id: e.uuid || e.id,
            pMean: e.p?.mean,
            completeness: e.p?.latency?.completeness,
            forecastMean: e.p?.forecast?.mean,
          })),
        });
        
        if (updatedGraph && setGraph) {
              setGraph(updatedGraph);
            }
            
        setLastAggregatedWindow(currentWindow);
        // Track both auto-aggregation DSL and last aggregated DSL
        lastAutoAggregatedDSLRef.current = authoritativeDSL;
        lastAggregatedDSLRef.current = authoritativeDSL;
      })
      .finally(() => {
              isAggregatingRef.current = false;
      });
      
  }, [plannerResult, graphStore, currentWindow, setGraph, fetchItems]);
  
  // Helper: Update window state, currentQueryDSL (historic), AND authoritative DSL
  const updateWindowAndDSL = (start: string, end: string) => {
    console.log('[WindowSelector] updateWindowAndDSL called:', { start, end });
    // Treat these as date-only strings (UK or ISO). Normalise to UK without re-parsing
    // UK dates through the JS Date parser (timezone-dependent).
    const startUK = normalizeToUK(start);
    const endUK = normalizeToUK(end);
    setWindow({ start: startUK, end: endUK });
    
    // Use getLatestGraph() to avoid stale closure
    const currentGraph = getLatestGraph();
    
    // Build context part from AUTHORITATIVE DSL (NOT graph.currentQueryDSL, which is historic only).
    // This ensures changing the window preserves the same slice/context dimensions that Retrieve All and the planner use.
    const authoritativeDSL = (graphStore as any).getState?.()?.currentDSL || '';
    const parsed = parseConstraints(authoritativeDSL || '');
    
    const contextParts: string[] = [];
    for (const ctx of parsed.context) {
      contextParts.push(`context(${ctx.key}:${ctx.value})`);
    }
    for (const ctxAny of parsed.contextAny) {
      const pairs = ctxAny.pairs.map(p => `${p.key}:${p.value}`).join(',');
      contextParts.push(`contextAny(${pairs})`);
    }
    
    // Build window/cohort part with d-MMM-yy format (using current queryMode)
    const dateRangePart = `${queryMode}(${startUK}:${endUK})`;
    
    // Preserve asat clause if present in current DSL
    const asatPart = parsed.asat ? `asat(${parsed.asat})` : '';
    
    // Combine
    const parts = [contextParts.join('.'), dateRangePart, asatPart].filter(p => p);
    const newDSL = parts.join('.');
    
    console.log('[WindowSelector] DSL update:', {
      previousGraphDSL: currentGraph?.currentQueryDSL,
      newDSL,
    });
    
    // CRITICAL: Update AUTHORITATIVE DSL on graphStore (for all fetch operations)
    setCurrentDSL(newDSL);
    
    // Also update graph.currentQueryDSL for historic record (NOT for live queries!)
    if (setGraph && currentGraph) {
      setGraph({ ...currentGraph, currentQueryDSL: newDSL });
    }
  };
  
  const handleDateRangeChange = (start: string, end: string) => {
    updateWindowAndDSL(start, end);
  };
  
  const handlePreset = (days: number | 'today') => {
    const today = new Date();
    
    if (days === 'today') {
      // Today only (start and end are same day)
      const todayStr = formatDateUK(today);
      const newWindow: DateRange = { start: todayStr, end: todayStr };
      
      // Skip if window unchanged
      if (window && window.start === todayStr && window.end === todayStr) {
        console.log(`[WindowSelector] Preset today skipped (window unchanged)`);
        return;
      }
      
      console.log('[WindowSelector] Preset today:', todayStr);
      setWindow?.(newWindow);
      return;
    }
    
    // Last N days (excluding today - end on yesterday)
    const end = new Date(today);
    end.setDate(end.getDate() - 1); // Yesterday
    
    // Clone end and subtract days for start
    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    
    const startStr = formatDateUK(start);
    const endStr = formatDateUK(end);
    const newWindow: DateRange = { start: startStr, end: endStr };
    
    // Skip if window unchanged
    if (window && window.start === startStr && window.end === endStr) {
      console.log(`[WindowSelector] Preset ${days} days skipped (window unchanged)`);
      return;
    }
    
    console.log(`[WindowSelector] Preset ${days} days:`, { start: startStr, end: endStr });
    
    // IMPORTANT: Update BOTH window state and graph.currentQueryDSL
    updateWindowAndDSL(startStr, endStr);
  };
  
  // Right-click handler for preset buttons
  const handlePresetContextMenu = useCallback((preset: 7 | 30 | 90, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPresetContextMenu({ x: e.clientX, y: e.clientY, preset });
  }, []);
  
  // Create live scenario from window preset (using hook)
  const handleCreateWindowScenario = useCallback(async (preset: 7 | 30 | 90, offset: number = 0) => {
    const windowDSL = getWindowDSLForPreset(preset, offset);
    await createWindowScenario(windowDSL);
    setPresetContextMenu(null);
  }, [createWindowScenario, getWindowDSLForPreset]);
  
  // Create multiple window scenarios (using hook)
  const handleCreateMultipleWindowScenarios = useCallback(async (preset: 7 | 30 | 90, count: number) => {
    const dsls = Array.from({ length: count }, (_, i) => getWindowDSLForPreset(preset, i));
    await createMultipleWindowScenarios(dsls);
    setPresetContextMenu(null);
  }, [createMultipleWindowScenarios, getWindowDSLForPreset]);
  
  // Helper to check if current window matches a preset
  const getActivePreset = (): number | 'today' | null => {
    if (!window) return null;
    
    const today = new Date();
    const todayStr = formatDateUK(today);
    
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatDateUK(yesterday);
    
    // Check if it's "today" preset (start and end are same day, and it's today)
    if (window.start === window.end && window.start === todayStr) {
      return 'today';
    }
    
    // Check if it's "7d" preset (end is yesterday, start is 7 days before)
    const sevenDaysAgo = new Date(yesterday);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    if (window.end === yesterdayStr && window.start === formatDateUK(sevenDaysAgo)) {
      return 7;
    }
    
    // Check if it's "30d" preset (end is yesterday, start is 30 days before)
    const thirtyDaysAgo = new Date(yesterday);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
    if (window.end === yesterdayStr && window.start === formatDateUK(thirtyDaysAgo)) {
      return 30;
    }
    
    // Check if it's "90d" preset (end is yesterday, start is 90 days before)
    const ninetyDaysAgo = new Date(yesterday);
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 89);
    if (window.end === yesterdayStr && window.start === formatDateUK(ninetyDaysAgo)) {
      return 90;
    }
    
    return null;
  };
  
  const activePreset = getActivePreset();
  
  const handleFetchData = async () => {
    if (!graph) return;
    
    const authoritativeDSL = (graphStore as any).getState?.()?.currentDSL || '';
    if (!authoritativeDSL) {
      toast.error('No query DSL set');
      return;
    }
    
    setIsExecutingPlanner(true);
    setIsFetching(true);
    
    try {
      const result = await windowFetchPlannerService.executeFetchPlan(
        graph,
        (g) => { if (g) setGraph(g); },
        authoritativeDSL
      );
      setPlannerResult(result);
      
      // Update lastAggregatedWindow after successful fetch
        setLastAggregatedWindow(currentWindow);
      lastAggregatedDSLRef.current = authoritativeDSL;
      
      toast.success('Data fetched successfully');
    } catch (err: any) {
      console.error('[WindowSelector] Planner fetch failed:', err);
      toast.error(`Fetch failed: ${err.message}`);
    } finally {
      setIsExecutingPlanner(false);
      setIsFetching(false);
    }
  };
  
  return (
    <div ref={windowSelectorRef} className={`window-selector ${!buttonNeedsAttention ? 'window-selector-compact' : ''}`}>
      {/* Main area (left side) */}
      <div className="window-selector-main">
      <div className="window-selector-content">
        {/* Cohort/Window mode toggle - leftmost element per design §7.5 */}
        <button
          type="button"
          className={`window-selector-mode-toggle ${queryMode === 'cohort' ? 'cohort' : 'window'}`}
          onClick={() => {
            const newMode = queryMode === 'cohort' ? 'window' : 'cohort';
            setQueryMode(newMode);
            
            // Update DSL with new mode, preserving date range
            if (window) {
              const newDSL = buildDSLFromState(window, newMode);
              setCurrentDSL(newDSL);
              const currentGraph = getLatestGraph();
              if (currentGraph && setGraph) {
                setGraph({ ...currentGraph, currentQueryDSL: newDSL });
              }
            }
            
            toast.success(`Switched to ${newMode} mode`, { duration: 1500 });
          }}
          title={queryMode === 'cohort' 
            ? 'Cohort mode: dates refer to when users entered the funnel' 
            : 'Window mode: dates refer to when events occurred'}
        >
          {queryMode === 'cohort' ? <ToggleLeft size={16} /> : <ToggleRight size={16} />}
          <span className="mode-label">{queryMode === 'cohort' ? 'Cohort' : 'Window'}</span>
        </button>
        
        <div className="window-selector-presets">
          <button
            type="button"
            onClick={() => handlePreset('today')}
            className={`window-selector-preset ${activePreset === 'today' ? 'active' : ''}`}
            title="Today only"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => handlePreset(7)}
            onContextMenu={(e) => handlePresetContextMenu(7, e)}
            className={`window-selector-preset ${activePreset === 7 ? 'active' : ''}`}
            title="Last 7 days (right-click for scenarios)"
          >
            7d
          </button>
          <button
            type="button"
            onClick={() => handlePreset(30)}
            onContextMenu={(e) => handlePresetContextMenu(30, e)}
            className={`window-selector-preset ${activePreset === 30 ? 'active' : ''}`}
            title="Last 30 days (right-click for scenarios)"
          >
            30d
          </button>
          <button
            type="button"
            onClick={() => handlePreset(90)}
            onContextMenu={(e) => handlePresetContextMenu(90, e)}
            className={`window-selector-preset ${activePreset === 90 ? 'active' : ''}`}
            title="Last 90 days (right-click for scenarios)"
          >
            90d
          </button>
        </div>
        <DateRangePicker
          startDate={startDate}
          endDate={endDate}
          onChange={handleDateRangeChange}
          maxDate={formatDateUK(new Date())}
        />

        {/* Phase 2: `@` asat() picker */}
        <div className="window-selector-asat">
          <button
            ref={asatButtonRef}
            type="button"
            data-testid="asat-toggle"
            className={`window-selector-asat-toggle ${activeAsat ? 'active' : ''}`}
            onClick={() => {
              void openAsatDropdown();
            }}
            disabled={isReadOnlyShare}
            title={
              isReadOnlyShare
                ? 'Disabled in static share mode'
                : activeAsat
                  ? `asat(${activeAsat})`
                  : 'Choose as-at snapshot date'
            }
            aria-pressed={!!activeAsat}
          >
            <AtSign size={16} />
          </button>

          {isAsatDropdownOpen && (
            <div
              ref={asatDropdownRef}
              className="window-selector-asat-dropdown"
              data-testid="asat-dropdown"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="asat-dropdown-header">
                <div className="asat-dropdown-title">
                  As-at snapshot{asatScopeLabel ? ` ${asatScopeLabel}` : ''}
                </div>
                <div className="asat-dropdown-actions">
                  {activeAsat && (
                    <button
                      type="button"
                      data-testid="asat-remove"
                      className="asat-dropdown-remove"
                      onClick={() => {
                        clearAsatFromDSL();
                        setIsAsatDropdownOpen(false);
                      }}
                      title="Remove asat(...) clause"
                    >
                      <X size={14} />
                      Remove @
                    </button>
                  )}
                </div>
              </div>

              <>
                  {isAsatLoading && <div className="asat-dropdown-message">Loading snapshot days…</div>}
                  {!isAsatLoading && asatError && (
                    <div className="asat-dropdown-error">{asatError}</div>
                  )}

                  {!isAsatLoading && !asatError && (
                    <>
                      <div className="asat-calendar-nav">
                        <button
                          type="button"
                          className="asat-calendar-nav-btn"
                          onClick={() => {
                            const d = new Date(asatMonthCursor.getTime());
                            d.setUTCMonth(d.getUTCMonth() - 1);
                            d.setUTCDate(1);
                            setAsatMonthCursor(d);
                          }}
                          title="Previous month"
                        >
                          <ChevronLeft size={14} />
                        </button>
                        <div className="asat-calendar-month">
                          {asatMonthCursor.toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })}
                        </div>
                        <button
                          type="button"
                          className="asat-calendar-nav-btn"
                          onClick={() => {
                            const d = new Date(asatMonthCursor.getTime());
                            d.setUTCMonth(d.getUTCMonth() + 1);
                            d.setUTCDate(1);
                            setAsatMonthCursor(d);
                          }}
                          title="Next month"
                        >
                          <ChevronRight size={14} />
                        </button>
                      </div>

                      <div className="asat-calendar-grid">
                        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label, idx) => (
                          <div key={`${label}-${idx}`} className="asat-calendar-dow">{label}</div>
                        ))}
                        {calendarCells.map((c) => {
                          const coveragePct = Math.round(c.coverage * 100);
                          const title = c.hasSnapshot
                            ? (c.coverage >= 1 ? 'Snapshot available (all params)'
                               : `Snapshot available (${coveragePct}% of params)`)
                            : 'No snapshot recorded for this day';
                          return (
                          <button
                            key={c.iso}
                            type="button"
                            data-testid={`asat-day-${c.iso}`}
                            className={[
                              'asat-calendar-day',
                              c.inMonth ? 'in-month' : 'out-month',
                              c.hasSnapshot ? 'has-snapshot' : '',
                              activeAsat && (() => {
                                try {
                                  const iso = parseUKDate(resolveRelativeDate(activeAsat)).toISOString().split('T')[0];
                                  return iso === c.iso ? 'selected' : '';
                                } catch {
                                  return '';
                                }
                              })(),
                            ].filter(Boolean).join(' ')}
                            style={c.hasSnapshot && c.coverage < 1 ? {
                              // Variable intensity via opacity on the background colour.
                              // Coverage 0→1 maps to opacity 0.2→1.0 for visible gradient.
                              '--snapshot-opacity': String(0.2 + c.coverage * 0.8),
                            } as React.CSSProperties : undefined}
                            onClick={() => {
                              const selectedUK = formatDateUK(new Date(`${c.iso}T00:00:00Z`));
                              applyAsatToDSL(selectedUK);
                              setIsAsatDropdownOpen(false);
                            }}
                            title={title}
                          >
                            {c.day}
                          </button>
                          );
                        })}
                      </div>

                      <div className="asat-dropdown-footnote">
                        {asatScopeLabel.startsWith('for all') || asatScopeLabel.match(/for \d+ params/)
                          ? 'Highlight intensity shows the fraction of params with snapshots on that day.'
                          : 'Highlighted days have at least one snapshot under the current effective query.'}
                      </div>
                    </>
                  )}
              </>
            </div>
          )}
        </div>
        
        {/* Context area: chips + add button - wrapped together to prevent line break between them */}
        <div className="window-selector-context-group">
        {/* Context chips area using QueryExpressionEditor - CONTEXTS ONLY (window shown in unrolled state) */}
        {(() => {
          const parsed = parseConstraints(graph?.currentQueryDSL || '');
          const hasContexts = parsed.context.length > 0 || parsed.contextAny.length > 0;
          
          if (!hasContexts) return null;
          
          // Build context-only DSL (strip window)
          const contextParts: string[] = [];
          for (const ctx of parsed.context) {
            contextParts.push(`context(${ctx.key}:${ctx.value})`);
          }
          for (const ctxAny of parsed.contextAny) {
            const pairs = ctxAny.pairs.map(p => `${p.key}:${p.value}`).join(',');
            contextParts.push(`contextAny(${pairs})`);
          }
          const contextOnlyDSL = contextParts.join('.');
          
          return (
            <div className="window-selector-context-chips" style={{ 
              minWidth: '120px',
              width: 'auto',
              maxWidth: 'min(450px, 40vw)'
            }}>
              <QueryExpressionEditor
                value={contextOnlyDSL}
                onChange={(newContextDSL) => {
                  // Use getLatestGraph() to avoid stale closure
                  const currentGraph = getLatestGraph();
                  if (!setGraph || !currentGraph) return;
                  
                  // Parse to get new contexts
                  const newParsed = parseConstraints(newContextDSL);
                  const oldParsed = parseConstraints(currentGraph.currentQueryDSL || '');
                  
                  // Rebuild DSL with new contexts + old window
                  const newContextParts: string[] = [];
                  for (const ctx of newParsed.context) {
                    newContextParts.push(`context(${ctx.key}:${ctx.value})`);
                  }
                  for (const ctxAny of newParsed.contextAny) {
                    const pairs = ctxAny.pairs.map(p => `${p.key}:${p.value}`).join(',');
                    newContextParts.push(`contextAny(${pairs})`);
                  }
                  
                  // Preserve window/cohort (using current queryMode)
                  let dateRangePart = '';
                  if (oldParsed.window) {
                    dateRangePart = `${queryMode}(${oldParsed.window.start || ''}:${oldParsed.window.end || ''})`;
                  } else if (oldParsed.cohort) {
                    dateRangePart = `${queryMode}(${oldParsed.cohort.start || ''}:${oldParsed.cohort.end || ''})`;
                  } else if (window) {
                    dateRangePart = `${queryMode}(${normalizeToUK(window.start)}:${normalizeToUK(window.end)})`;
                  }
                  
                  // Preserve asat clause if present in old DSL
                  const asatPart = oldParsed.asat ? `asat(${oldParsed.asat})` : '';
                  
                  const fullDSL = [newContextParts.join('.'), dateRangePart, asatPart].filter(p => p).join('.');
                  
                  // CRITICAL: Update AUTHORITATIVE DSL on graphStore
                  setCurrentDSL(fullDSL || '');
                  
                  // Also update historic record (NOT for live queries!)
                  setGraph({ ...currentGraph, currentQueryDSL: fullDSL || undefined });
                }}
                graph={graph}
                height="32px"
                placeholder=""
              />
            </div>
          );
        })()}
        
        {/* Add Context button */}
        <div className="window-selector-toolbar-button" style={{ position: 'relative', marginLeft: '8px' }}>
          <button
            ref={contextButtonRef}
            className="window-selector-preset"
            onClick={() => setShowContextDropdown(!showContextDropdown)}
            title="Add context filter"
            style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
          >
            <span>+</span>
            <FileText size={14} />
            {(() => {
              // Show "Context" label when no contexts are selected
              const parsed = parseConstraints(graph?.currentQueryDSL || '');
              const hasContexts = parsed.context.length > 0 || parsed.contextAny.length > 0;
              return !hasContexts ? <span>Context</span> : null;
            })()}
          </button>
          
          {showContextDropdown && availableKeySections.length > 0 && (
            <div ref={contextDropdownRef} className="window-selector-dropdown context-dropdown">
              <ContextValueSelector
                mode="multi-key"
                availableKeys={availableKeySections}
                currentValues={currentContextValues}
                currentContextKey={currentContextKey}
                showingAll={showingAllContexts}
                onCreateScenarios={(contextKey, values) => {
                  if (values) {
                    // Create scenarios for specific values immediately
                    createScenariosForContext(contextKey, values);
                    // Keep dropdown open to allow creating more? Or close?
                    // If user clicked "+", they probably want to see the scenario created.
                    // Let's keep it open for multi-creation workflow.
                  } else {
                    // Open bulk creation modal
                    setShowContextDropdown(false);
                    openBulkCreateForContext(contextKey);
                  }
                }}
                onShowAll={async () => {
                  // Load ALL contexts from registry (not just pinned)
                  contextRegistry.clearCache();
                  const keys = await contextRegistry.getAllContextKeys({ workspace: workspaceForContextRegistry });
                  console.log('[WindowSelector] Loading ALL context keys:', keys);
                  const sections = await Promise.all(
                    keys.map(async key => {
                      const context = await contextRegistry.getContext(key.id, { workspace: workspaceForContextRegistry });
                      const values = await contextRegistry.getValuesForContext(key.id);
                      return {
                        id: key.id,
                        name: key.id.replace(/_/g, ' ').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                        values,
                        otherPolicy: context?.otherPolicy
                      };
                    })
                  );
                  setAvailableKeySections(sections);
                  setShowingAllContexts(true);
                  return sections;
                }}
                onApply={async (key, values) => {
                  setShowContextDropdown(false);
                  setShowingAllContexts(false); // Reset for next open
                  
                  // Use getLatestGraph() to avoid stale closure
                  const currentGraph = getLatestGraph();
                  if (!setGraph || !currentGraph) return;
                  
                  // Parse existing DSL to preserve window
                  const parsed = parseConstraints(currentGraph.currentQueryDSL || '');
                  const existingWindow = parsed.window;
                  
                  // Check if all values selected AND key is MECE (should remove context)
                  const keySection = availableKeySections.find(s => s.id === key);
                  const allValues = keySection?.values || [];
                  const allSelected = allValues.length > 0 && values.length === allValues.length;
                  const isMECE = keySection?.otherPolicy !== 'undefined';
                  
                  // Build new context part
                  let contextPart = '';
                  if (values.length > 0 && !(allSelected && isMECE)) {
                    if (values.length === 1) {
                      contextPart = `context(${key}:${values[0]})`;
                    } else {
                      const valuePairs = values.map(v => `${key}:${v}`).join(',');
                      contextPart = `contextAny(${valuePairs})`;
                    }
                  }
                  
                  // Build window/cohort part (preserve existing or use current window state)
                  let dateRangePart = '';
                  if (existingWindow) {
                    dateRangePart = `${queryMode}(${existingWindow.start || ''}:${existingWindow.end || ''})`;
                  } else if (window) {
                    dateRangePart = `${queryMode}(${normalizeToUK(window.start)}:${normalizeToUK(window.end)})`;
                  }
                  
                  // Preserve asat clause if present in existing DSL
                  const existingParsed = parseConstraints(currentGraph.currentQueryDSL || '');
                  const asatPart = existingParsed.asat ? `asat(${existingParsed.asat})` : '';
                  
                  // Combine
                  const newDSL = [contextPart, dateRangePart, asatPart].filter(p => p).join('.');
                  
                  // CRITICAL: Update AUTHORITATIVE DSL on graphStore
                  setCurrentDSL(newDSL || '');
                  
                  // Also update historic record (NOT for live queries!)
                  setGraph({ ...currentGraph, currentQueryDSL: newDSL || undefined });
                  
                  if (allSelected && isMECE) {
                    toast.success('All values selected = no filter', { duration: 2000 });
                  }
                }}
                onCancel={() => {
                  setShowContextDropdown(false);
                  setShowingAllContexts(false); // Reset for next open
                }}
                anchorEl={contextButtonRef.current}
              />
            </div>
          )}
          
          {showContextDropdown && availableKeySections.length === 0 && (
            <div ref={contextDropdownRef} className="window-selector-dropdown context-dropdown">
              <div className="dropdown-message">
                {isContextLoading ? 'Loading contexts...' : (contextLoadError ? `Failed to load contexts: ${contextLoadError}` : 'No contexts found')}
              </div>
            </div>
          )}
        </div>
        </div>{/* End context group */}
      </div>
      
      {/* Unrolled state - shows full DSL and pinned query access */}
      {isUnrolled && (
        <div 
          className="window-selector-extended"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <span style={{ fontSize: '12px', color: '#6B7280', fontWeight: 500 }}>Full query:</span>
          <div style={{ flex: 1 }}>
            <QueryExpressionEditor
              value={(() => {
                // Parse current DSL to extract contexts (strip any window)
                const parsed = parseConstraints(graph?.currentQueryDSL || '');
                
                const contextParts: string[] = [];
                for (const ctx of parsed.context) {
                  contextParts.push(`context(${ctx.key}:${ctx.value})`);
                }
                for (const ctxAny of parsed.contextAny) {
                  const pairs = ctxAny.pairs.map(p => `${p.key}:${p.value}`).join(',');
                  contextParts.push(`contextAny(${pairs})`);
                }
                
                // Add current window/cohort (using queryMode)
                const dateRangePart = window 
                  ? `${queryMode}(${normalizeToUK(window.start)}:${normalizeToUK(window.end)})` 
                  : '';
                
                // Preserve asat clause if present in the current DSL
                const asatPart = parsed.asat ? `asat(${parsed.asat})` : '';
                
                // Combine
                const parts = [...contextParts, dateRangePart, asatPart].filter(p => p);
                return parts.join('.');
              })()}
              readonly={false}
              onChange={(newDSL) => {
                // During editing, just let it update (don't persist yet)
              }}
              onBlur={(finalDSL) => {
                // CRITICAL: Update AUTHORITATIVE DSL on graphStore
                setCurrentDSL(finalDSL || '');
                
                // Also update historic record (NOT for live queries!)
                if (setGraph && graph) {
                  setGraph({ ...graph, currentQueryDSL: finalDSL });
                }
                
                // Also update window state separately for DateRangePicker
                // Resolve relative dates (like -60d) to absolute dates for display
                const parsed = parseConstraints(finalDSL);
                const dateRange = parsed.window || parsed.cohort;
                if (dateRange && setWindow) {
                  // Resolve relative dates (e.g., -60d → 11-Oct-25)
                  const resolvedStart = dateRange.start ? resolveRelativeDate(dateRange.start) : '';
                  const resolvedEnd = dateRange.end ? resolveRelativeDate(dateRange.end) : formatDateUK(new Date());
                  setWindow({
                    start: resolvedStart || window?.start || '',
                    end: resolvedEnd || window?.end || '',
                  });
                }
                
                // Update query mode based on DSL
                if (parsed.cohort) {
                  setQueryMode('cohort');
                } else if (parsed.window) {
                  setQueryMode('window');
                }
              }}
              graph={graph}
              height="32px"
              placeholder="No filters applied"
            />
          </div>
          <span style={{ color: '#ccc', fontSize: '18px' }}>│</span>
          <button
            className="window-selector-preset"
            onClick={() => setShowPinnedQueryModal(true)}
            title={graph?.dataInterestsDSL || 'Click to set pinned query'}
            style={{
              padding: '4px 12px',
              background: graph?.dataInterestsDSL ? '#e3f2fd' : '#f5f5f5',
              border: graph?.dataInterestsDSL ? '1px solid #90caf9' : '1px solid #d0d0d0',
              whiteSpace: 'nowrap'
            }}
          >
            Pinned query {graph?.dataInterestsDSL && '✓'}
          </button>
        </div>
      )}
      </div>{/* End window-selector-main */}
      
      {/* Fetch button column (right side) - spans full height */}
      {/* Always show when graph has parameter files. If there are no fetchable items,
          clicking the button will surface an explicit toast instead of doing nothing. */}
      {hasParameterFiles && (
        <div className="window-selector-fetch-column">
          <button
            onClick={handleFetchData}
            disabled={isAnalysing || isFetching || isReadOnlyShare}
            className={`window-selector-button ${showShimmer && buttonNeedsAttention ? 'shimmer' : ''}`}
            title={
              isReadOnlyShare
                ? "Data operations disabled in static share mode"
                : isAnalysing
                  ? "Checking data coverage..."
                  : isFetching
                    ? "Fetching data..."
                    : buttonTooltip
            }
          >
            {isAnalysing ? 'Checking...' : isFetching ? 'Fetching...' : buttonLabel}
          </button>
        </div>
      )}
      
      {/* Unroll toggle - triangle corner */}
      <button
        className={`window-selector-unroll-toggle ${isUnrolled ? 'expanded' : ''}`}
        onClick={() => setIsUnrolled(!isUnrolled)}
        title={isUnrolled ? "Hide full query" : "Show full query DSL"}
      />
      
      {/* Pinned Query Modal */}
      <PinnedQueryModal
        isOpen={showPinnedQueryModal}
        currentDSL={graph?.dataInterestsDSL || ''}
        onSave={(newDSL) => {
          if (setGraph && graph) {
            setGraph({ ...graph, dataInterestsDSL: newDSL });
            toast.success('Pinned query updated');
            // Non-blocking warnings on save
            validatePinnedDataInterestsDSL(newDSL)
              .then((res) => {
                for (const w of res.warnings) {
                  toast(w, { icon: '⚠️', duration: 6000 });
                }
              })
              .catch((e) => {
                console.warn('[WindowSelector] Failed to validate pinned DSL:', e);
              });
            // Reload context sections if dropdown is open
            setAvailableKeySections([]);
          }
        }}
        onClose={() => setShowPinnedQueryModal(false)}
      />
      
      {/* Preset context menu */}
      {presetContextMenu && (
        <div
          ref={presetContextMenuRef}
          style={{
            position: 'fixed',
            left: presetContextMenu.x,
            top: presetContextMenu.y,
            background: '#fff',
            border: '1px solid #dee2e6',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            zIndex: 10000,
            minWidth: '200px',
            padding: '4px 0'
          }}
        >
          {/* Current period */}
          <button
            onClick={() => handleCreateWindowScenario(presetContextMenu.preset, 0)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '8px 12px',
              border: 'none',
              background: 'transparent',
              color: '#374151',
              fontSize: '13px',
              textAlign: 'left',
              cursor: 'pointer'
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            Create scenario ({getWindowDSLForPreset(presetContextMenu.preset, 0)})
            <Zap size={12} style={{ color: 'currentColor', marginLeft: 'auto' }} />
          </button>
          
          {/* Previous period */}
          <button
            onClick={() => handleCreateWindowScenario(presetContextMenu.preset, 1)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '8px 12px',
              border: 'none',
              background: 'transparent',
              color: '#374151',
              fontSize: '13px',
              textAlign: 'left',
              cursor: 'pointer'
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            Create scenario ({getWindowDSLForPreset(presetContextMenu.preset, 1)})
            <Zap size={12} style={{ color: 'currentColor', marginLeft: 'auto' }} />
          </button>
          
          {/* Two periods ago */}
          <button
            onClick={() => handleCreateWindowScenario(presetContextMenu.preset, 2)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '8px 12px',
              border: 'none',
              background: 'transparent',
              color: '#374151',
              fontSize: '13px',
              textAlign: 'left',
              cursor: 'pointer'
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            Create scenario ({getWindowDSLForPreset(presetContextMenu.preset, 2)})
            <Zap size={12} style={{ color: 'currentColor', marginLeft: 'auto' }} />
          </button>
          
          {/* Separator */}
          <div style={{ height: '1px', background: '#e5e7eb', margin: '4px 0' }} />
          
          {/* Create 4 periods */}
          <button
            onClick={() => handleCreateMultipleWindowScenarios(presetContextMenu.preset, 4)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '8px 12px',
              border: 'none',
              background: 'transparent',
              color: '#374151',
              fontSize: '13px',
              textAlign: 'left',
              cursor: 'pointer'
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
          >
            Create 4 scenarios ({presetContextMenu.preset === 7 ? 'weekly' : presetContextMenu.preset === 30 ? 'monthly' : 'quarterly'})
            <Zap size={12} style={{ color: 'currentColor', marginLeft: 'auto' }} />
          </button>
        </div>
      )}
      
      {/* Bulk scenario creation modal */}
      {bulkCreateModal && (
        <BulkScenarioCreationModal
          isOpen={true}
          contextKey={bulkCreateModal.contextKey}
          values={bulkCreateModal.values}
          onClose={closeBulkCreateModal}
          onCreate={async (selectedValues) => {
            await createScenariosForContext(bulkCreateModal.contextKey, selectedValues);
          }}
        />
      )}
    </div>
  );
}

