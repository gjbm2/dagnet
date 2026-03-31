/**
 * ScenariosPanel
 * 
 * Displays and manages scenarios (parameter overlays) for the active graph tab.
 * Allows users to:
 * - Create snapshots (All/Differences)
 * - Create blank scenarios
 * - Toggle visibility (eye icon)
 * - Reorder scenarios (drag-and-drop)
 * - Rename scenarios (inline edit)
 * - Delete scenarios
 * - Open scenarios in editor
 * - Flatten all overlays into Base
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useScenariosContextOptional } from '../../contexts/ScenariosContext';
import { useTabContext } from '../../contexts/TabContext';
import { useGraphStore } from '../../contexts/GraphStoreContext';
import { Scenario } from '../../types/scenarios';
import { ScenarioEditorModal } from '../modals/ScenarioEditorModal';
import { ScenarioQueryEditModal } from '../modals/ScenarioQueryEditModal';
import { ToBaseConfirmModal } from '../modals/ToBaseConfirmModal';
import { ScenarioLayerList } from './ScenarioLayerList';
import type { ScenarioLayerItem } from '../../types/scenarioLayerList';
import WhatIfAnalysisControl from '../WhatIfAnalysisControl';
import { parseConstraints } from '@/lib/queryDSL';
import { computeInheritedDSL, computeEffectiveFetchDSL, deriveBaseDSLForRebase, LIVE_EMPTY_DIFF_DSL, diffQueryDSLFromBase } from '../../services/scenarioRegenerationService';
import { fetchDataService } from '../../services/fetchDataService';
import { useCopyAllScenarioParamPacks } from '../../hooks/useCopyAllScenarioParamPacks';
import { getScenarioVisibilityOverlayStyle } from '../../lib/scenarioVisibilityModeStyles';
import { 
  Images,
  Image,
  Square,
  Plus,
  X, 
  ChevronDown,
  ArrowDownToLine,
  Layers,
  Zap,
  RefreshCw,
  ArrowDownFromLine,
  ClipboardCopy
} from 'lucide-react';
import type { ScenarioVisibilityMode } from '../../types';
import toast from 'react-hot-toast';
import './ScenariosPanel.css';

interface ScenariosPanelProps {
  tabId?: string;
  hideHeader?: boolean; // Hide header when used in hover preview
}

/**
 * Generate tooltip text for a scenario showing all metadata
 */
function getScenarioTooltip(scenario: Scenario): string {
  const parts: string[] = [];
  
  // Live scenario indicator
  if (scenario.meta?.isLive) {
    parts.push(`⚡ Live Scenario`);
    if (scenario.meta.queryDSL) {
      parts.push(`Query DSL: ${scenario.meta.queryDSL}`);
    }
    if (scenario.meta.lastEffectiveDSL) {
      parts.push(`Effective DSL: ${scenario.meta.lastEffectiveDSL}`);
    }
    if (scenario.meta.lastRegeneratedAt) {
      parts.push(`Last regenerated: ${new Date(scenario.meta.lastRegeneratedAt).toLocaleString()}`);
    }
  }
  
  if (scenario.meta?.window) {
    const start = new Date(scenario.meta.window.start).toLocaleDateString();
    const end = new Date(scenario.meta.window.end).toLocaleDateString();
    parts.push(`Window: ${start} → ${end}`);
  }
  
  if (scenario.meta?.whatIfSummary || scenario.meta?.whatIfDSL) {
    parts.push(`What-If: ${scenario.meta.whatIfSummary || scenario.meta.whatIfDSL}`);
  }
  
  if (scenario.meta?.context && Object.keys(scenario.meta.context).length > 0) {
    const contextStr = Object.entries(scenario.meta.context)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    parts.push(`Context: ${contextStr}`);
  }
  
  if (scenario.meta?.source) {
    parts.push(`Source: ${scenario.meta.source} (${scenario.meta.sourceDetail || 'unknown'})`);
  }
  
  parts.push(`Created: ${new Date(scenario.createdAt).toLocaleString()}`);
  
  if (scenario.meta?.note) {
    parts.push(`Note: ${scenario.meta.note}`);
  }
  
  return parts.join('\n');
}

export default function ScenariosPanel({ tabId, hideHeader = false }: ScenariosPanelProps) {
  const scenariosContext = useScenariosContextOptional();
  const { operations, tabs } = useTabContext();
  const graphStore = useGraphStore();
  const graph = graphStore?.getState().graph || null;
  const { copyAllScenarioParamPacks } = useCopyAllScenarioParamPacks(tabId);
  const [copiedPulse, setCopiedPulse] = useState(false);
  
  // Early return if context not available yet
  if (!scenariosContext) {
    return (
      <div className="scenarios-panel">
        {!hideHeader && (
          <div className="scenarios-header">
            <Layers size={14} strokeWidth={2} style={{ flexShrink: 0 }} />
            <h3 className="scenarios-title">Scenarios</h3>
          </div>
        )}
        <div style={{ padding: '16px', color: '#9CA3AF', fontSize: '13px' }}>
          Loading scenarios...
        </div>
      </div>
    );
  }
  
  const { scenarios, listScenarios, renameScenario, updateScenarioColour, deleteScenario, captureScenario, createBlank, openInEditor, closeEditor, editorOpenScenarioId, flatten, setCurrentParams, baseParams, currentParams, composeVisibleParams, currentColour, baseColour, setCurrentColour, setBaseColour, createLiveScenario, createLiveScenarioFromCurrentDelta, regenerateScenario, regenerateAllLive, putToBase, baseDSL } = scenariosContext;
  
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [pendingBlankScenarioId, setPendingBlankScenarioId] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  
  // Query edit modal state for live scenarios
  const [queryEditModalScenarioId, setQueryEditModalScenarioId] = useState<string | null>(null);
  
  // To Base confirmation modal state
  const [toBaseModalOpen, setToBaseModalOpen] = useState(false);
  const [toBaseModalData, setToBaseModalData] = useState<{
    scenariosNeedingFetch: number;
    totalLiveScenarios: number;
    newBaseDSL: string;
  } | null>(null);
  
  // What-If panel expansion state (independent of DSL)
  const [whatIfPanelExpanded, setWhatIfPanelExpanded] = useState(false);
  const userManuallyClosed = useRef(false);
  
  // Close menu on click outside
  useEffect(() => {
    if (!showCreateMenu) return;
    
    const handleClickOutside = () => setShowCreateMenu(false);
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowCreateMenu(false);
    };
    
    setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }, 0);
    
    return () => {
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showCreateMenu]);
  
  // Get tab's scenario state - use tabs directly to ensure reactivity
  const currentTab = tabs.find(t => t.id === tabId);
  const whatIfDSL = currentTab?.editorState?.whatIfDSL;
  
  // Count active what-if conditions
  const whatIfConditionCount = useMemo(() => {
    if (!whatIfDSL || whatIfDSL.trim().length === 0) return 0;
    try {
      const parsed = parseConstraints(whatIfDSL);
      const caseCount = parsed.cases?.length || 0;
      const visitedCount = parsed.visited?.length || 0;
      const excludeCount = parsed.exclude?.length || 0;
      return caseCount + visitedCount + excludeCount;
    } catch (e) {
      return 0;
    }
  }, [whatIfDSL]);
  
  const scenarioState = currentTab?.editorState?.scenarioState as any;
  const scenarioOrder = scenarioState?.scenarioOrder || [];
  const visibleScenarioIds = scenarioState?.visibleScenarioIds || [];
  const visibleColourOrderIds = scenarioState?.visibleColourOrderIds || [];
  const selectedScenarioId = scenarioState?.selectedScenarioId;
  
  // Special entries: Original (base) and Current
  // Note: These track VISIBILITY state, not list display
  // Original: default HIDDEN (per spec: "default hidden; can be shown/hidden")
  // Current: default VISIBLE (live working state)
  const baseVisible = visibleScenarioIds.includes('base');
  const currentVisible = visibleScenarioIds.includes('current');
  
  /**
   * Get effective colour for a scenario (with single-layer grey override)
   * Only the sole VISIBLE layer is shown in grey; hidden layers retain their assigned colour.
   */
  const getScenarioColour = useCallback((scenarioId: string, isVisible: boolean = true): string => {
    // Single-layer grey override: ONLY apply to the visible layer when exactly 1 layer is visible
    if (isVisible && visibleScenarioIds.length === 1) {
      return '#808080';
    }
    
    // Get stored colour (for both visible and hidden layers)
    if (scenarioId === 'current') {
      return currentColour;
    } else if (scenarioId === 'base') {
      return baseColour;
    } else {
      const scenario = scenarios.find(s => s.id === scenarioId);
      return scenario?.colour || '#808080';
    }
  }, [visibleScenarioIds.length, currentColour, baseColour, scenarios]);
  
  /**
   * Handle colour change for a scenario
   */
  const handleColourChange = useCallback((scenarioId: string, colour: string) => {
    if (scenarioId === 'current') {
      setCurrentColour(colour);
    } else if (scenarioId === 'base') {
      setBaseColour(colour);
    } else {
      updateScenarioColour(scenarioId, colour);
    }
  }, [setCurrentColour, setBaseColour, updateScenarioColour]);
  
  // Auto-expand What-If panel when DSL is applied from elsewhere (e.g., window bar)
  // But don't auto-expand if user manually closed it
  useEffect(() => {
    if (whatIfDSL && whatIfDSL.trim().length > 0 && !whatIfPanelExpanded && !userManuallyClosed.current) {
      console.log('[ScenariosPanel] Auto-expanding panel due to DSL from elsewhere');
      setWhatIfPanelExpanded(true);
      userManuallyClosed.current = false; // Reset flag after auto-expanding
    }
    // Reset flag when DSL becomes empty
    if (!whatIfDSL || whatIfDSL.trim().length === 0) {
      userManuallyClosed.current = false;
    }
  }, [whatIfDSL, whatIfPanelExpanded]);
  
  /**
   * Toggle scenario visibility (legacy - simple show/hide)
   */
  const handleToggleVisibility = useCallback(async (scenarioId: string) => {
    if (!tabId) return;
    
    try {
      await operations.toggleScenarioVisibility(tabId, scenarioId);
    } catch (error) {
      console.error('Failed to toggle scenario visibility:', error);
      toast.error('Failed to toggle visibility');
    }
  }, [tabId, operations]);
  
  /**
   * Cycle visibility mode: F+E → F → E → hidden → F+E
   */
  const handleCycleVisibilityMode = useCallback(async (scenarioId: string) => {
    if (!tabId) return;
    
    try {
      // Calculate next mode before cycling (more reliable than reading state after)
      const currentMode = operations.getScenarioVisibilityMode(tabId, scenarioId);
      const modeOrder: ScenarioVisibilityMode[] = ['f+e', 'f', 'e'];
      const currentIndex = modeOrder.indexOf(currentMode);
      const nextMode = modeOrder[(currentIndex + 1) % modeOrder.length];
      
      await operations.cycleScenarioVisibilityMode(tabId, scenarioId);
      
      // Toast feedback (only tri-state now)
      const modeLabels: Record<ScenarioVisibilityMode, string> = {
        'f+e': 'Forecast + Evidence',
        'f': 'Forecast only',
        'e': 'Evidence only',
      };
      toast.success(modeLabels[nextMode], { duration: 1500 });
    } catch (error) {
      console.error('Failed to cycle visibility mode:', error);
      toast.error('Failed to change visibility');
    }
  }, [tabId, operations]);
  
  /**
   * Get tri-state mode icon for a scenario (F+E / F / E)
   */
  const getModeIcon = useCallback((scenarioId: string, size: number = 14) => {
    if (!tabId) return <Images size={size} />;
    
    const mode = operations.getScenarioVisibilityMode(tabId, scenarioId);
    switch (mode) {
      case 'f+e': return <Images size={size} />;
      case 'f': return <Image size={size} />;
      case 'e': return <Square size={size} />;
      default: return <Images size={size} />;
    }
  }, [tabId, operations]);
  
  /**
   * Get tri-state mode tooltip for a scenario
   */
  const getModeTooltip = useCallback((scenarioId: string): string => {
    if (!tabId) return 'Cycle forecast/evidence display';
    
    const mode = operations.getScenarioVisibilityMode(tabId, scenarioId);
    switch (mode) {
      case 'f+e': return 'Forecast + evidence (click to cycle)';
      case 'f': return 'Forecast only (click to cycle)';
      case 'e': return 'Evidence only (click to cycle)';
      default: return 'Cycle forecast/evidence display';
    }
  }, [tabId, operations]);
  
  /**
   * Get swatch overlay style based on visibility mode
   * Shows stripe patterns matching the design spec
   */
  const getSwatchOverlayStyle = useCallback((scenarioId: string): React.CSSProperties | null => {
    if (!tabId) return null;
    
    const mode = operations.getScenarioVisibilityMode(tabId, scenarioId);
    return getScenarioVisibilityOverlayStyle(mode);
  }, [tabId, operations]);
  
  /**
   * Open What-If panel
   */
  const handleOpenWhatIfPanel = useCallback(() => {
    console.log('[ScenariosPanel] Opening What-If panel');
    setWhatIfPanelExpanded(true);
  }, []);
  
  /**
   * Clear What-If DSL (if any) and close panel
   */
  const handleClearWhatIf = useCallback(async () => {
    console.log('[ScenariosPanel] X clicked - clearing DSL and closing panel');
    
    // Always close panel
    setWhatIfPanelExpanded(false);
    
    // Clear DSL if it exists
    if (tabId && whatIfDSL) {
      try {
        console.log('[ScenariosPanel] Clearing DSL');
        await operations.updateTabState(tabId, { whatIfDSL: null });
      } catch (error) {
        console.error('[ScenariosPanel] Failed to clear What-If:', error);
        toast.error('Failed to clear What-If');
      }
    }
  }, [tabId, whatIfDSL, operations]);
  
  /**
   * Delete scenario (no confirmation needed - it's reversible via graph history)
   */
  const handleDelete = useCallback(async (scenarioId: string) => {
    try {
      await deleteScenario(scenarioId);
      
      // Clean up visibility state if this scenario was visible in the current tab
      if (tabId) {
        const scenarioState = operations.getScenarioState(tabId);
        if (scenarioState?.visibleScenarioIds.includes(scenarioId)) {
          // Remove from both visible IDs and colour order
          const newVisibleIds = scenarioState.visibleScenarioIds.filter(id => id !== scenarioId);
          const newColourOrderIds = scenarioState.visibleColourOrderIds.filter(id => id !== scenarioId);
          
          await operations.updateTabState(tabId, {
            scenarioState: {
              ...scenarioState,
              visibleScenarioIds: newVisibleIds,
              visibleColourOrderIds: newColourOrderIds,
            }
          });
        }
      }
      
      toast.success('Scenario deleted');
    } catch (error) {
      console.error('Failed to delete scenario:', error);
      toast.error('Failed to delete scenario');
    }
  }, [deleteScenario, tabId, operations]);

  /**
   * Rename scenario
   */
  const handleRenameScenario = useCallback(async (scenarioId: string, newName: string) => {
    try {
      await renameScenario(scenarioId, newName);
      toast.success('Scenario renamed');
    } catch (error) {
      console.error('Failed to rename scenario:', error);
      toast.error('Failed to rename scenario');
    }
  }, [renameScenario]);
  
  /**
   * Open scenario in editor
   */
  const handleOpenEditor = useCallback((scenarioId: string) => {
    openInEditor(scenarioId);
  }, [openInEditor]);
  
  /**
   * Capture a static scenario with timestamp as default name
   */
  const handleCaptureScenario = useCallback(async (type: 'all' | 'differences', source: 'visible' | 'base') => {
    if (!tabId) {
      toast.error('No active tab');
      return;
    }
    
    // Generate timestamp name (e.g., "2025-11-12 14:30")
    const now = new Date();
    const timestamp = now.toLocaleString('en-CA', { 
      year: 'numeric', 
      month: '2-digit', 
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).replace(',', '');
    
    try {
      // Get window from tab state
      const tab = tabs.find(t => t.id === tabId);
      const window = tab?.editorState?.window || null;
      
      // Get What-If state from tab
      const whatIfDSL = tab?.editorState?.whatIfDSL || null;
      // TODO: Generate whatIfSummary from DSL
      const whatIfSummary = whatIfDSL || undefined;
      
      // TODO: Get context values (not implemented yet)
      const context = undefined;
      
      const newScenario = await captureScenario({
        name: timestamp,
        type,
        source,
        diffThreshold: 1e-6
      }, tabId, whatIfDSL, whatIfSummary, window, context);
      
      // Make the new scenario visible by default
      await operations.toggleScenarioVisibility(tabId, newScenario.id);
      
      toast.success('Scenario captured');
      setShowCreateMenu(false);
    } catch (error) {
      console.error('Failed to capture scenario:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to capture scenario';
      toast.error(errorMessage);
    }
  }, [tabId, captureScenario, tabs, operations]);

  /**
   * Create a live scenario in one of three modes:
   * 1) Everything: store currentDSL as scenario queryDSL
   * 2) Differences: store diff(currentDSL vs baseDSL) as scenario queryDSL
   * 3) Differences & re-base: set baseDSL from currentDSL first, then store diff (often empty)
   */
  const handleCreateLiveScenario = useCallback(async (mode: 'everything' | 'differences') => {
    if (!tabId) {
      toast.error('No active tab');
      return;
    }
    
    try {
      let newScenario;
      if (mode === 'everything') {
        const scenarioState = operations.getScenarioState(tabId);
        const visibleOrder = scenarioState?.visibleScenarioIds || ['base', 'current'];
        newScenario = await createLiveScenarioFromCurrentDelta(tabId, visibleOrder);
      } else {
        // Differences: store diff(currentDSL vs baseDSL) as scenario queryDSL
        const currentDSL = graphStore?.getState().currentDSL || '';
        if (!currentDSL || !currentDSL.trim()) {
          toast.error('No query DSL set. Select a window or context first.');
          return;
        }
        const effectiveBaseDSL = baseDSL || graph?.baseDSL || '';
        const scenarioQueryDSL = diffQueryDSLFromBase(effectiveBaseDSL, currentDSL);
        newScenario = await createLiveScenario(scenarioQueryDSL || LIVE_EMPTY_DIFF_DSL, undefined, tabId);
      }
      
      // Make the new scenario visible by default
      await operations.toggleScenarioVisibility(tabId, newScenario.id);
      
      toast.success('Live scenario created');
      setShowCreateMenu(false);
    } catch (error) {
      console.error('Failed to create live scenario:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to create live scenario';
      toast.error(errorMessage);
    }
  }, [tabId, graphStore, createLiveScenario, createLiveScenarioFromCurrentDelta, operations, baseDSL, graph]);
  
  // Listen for new scenario event from legend
  useEffect(() => {
    const handleNewScenarioEvent = (e: CustomEvent) => {
      // Only respond if the event is for this tab
      const eventTabId = (e.detail as any)?.tabId;
      if (!tabId || eventTabId !== tabId) {
        return;
      }
      // Default: create "Live scenario (everything)" from current query.
      handleCreateLiveScenario('everything');
    };
    
    window.addEventListener('dagnet:newScenario', handleNewScenarioEvent as EventListener);

    return () => {
      window.removeEventListener('dagnet:newScenario', handleNewScenarioEvent as EventListener);
    };
  }, [handleCreateLiveScenario]);
  
  /**
   * Create blank scenario with timestamp as default name
   * Opens editor automatically for immediate editing
   * Tracks the scenario ID so we can delete it if user cancels
   */
  const handleCreateBlank = useCallback(async () => {
    if (!tabId) {
      toast.error('No active tab');
      return;
    }
    
    // Generate timestamp name (e.g., "2025-11-12 14:30")
    const now = new Date();
    const timestamp = now.toLocaleString('en-CA', { 
      year: 'numeric', 
      month: '2-digit', 
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).replace(',', '');
    
    try {
      const newScenario = await createBlank(timestamp, tabId);
      
      // Make the new blank scenario visible by default
      await operations.toggleScenarioVisibility(tabId, newScenario.id);
      
      // Track this as a pending blank scenario
      setPendingBlankScenarioId(newScenario.id);
      
      toast.success('Blank scenario created');
    } catch (error) {
      console.error('Failed to create scenario:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to create scenario';
      toast.error(errorMessage);
    }
  }, [tabId, createBlank, operations]);
  
  /**
   * Handle modal close
   * If closing a pending blank scenario, delete it
   */
  const handleCloseEditor = useCallback(() => {
    // If we're closing a pending blank scenario, delete it
    if (pendingBlankScenarioId && editorOpenScenarioId === pendingBlankScenarioId) {
      handleDelete(pendingBlankScenarioId);
      setPendingBlankScenarioId(null);
    }
    closeEditor();
  }, [pendingBlankScenarioId, editorOpenScenarioId, handleDelete, closeEditor]);
  
  /**
   * Clear pending blank scenario flag when user saves
   */
  const handleModalSave = useCallback(() => {
    if (pendingBlankScenarioId) {
      setPendingBlankScenarioId(null);
    }
  }, [pendingBlankScenarioId]);
  
  /**
   * Flatten all overlays into Base (no confirmation needed - it's reversible via graph history)
   */
  const handleFlatten = useCallback(async () => {
    try {
      await flatten();
      
      // Update tab visibility: show only Current, hide Base
      if (tabId) {
        await operations.setVisibleScenarios(tabId, ['current']);
      }
      
      toast.success('Flattened: Current copied to Base, all scenarios removed');
    } catch (error) {
      console.error('Failed to flatten:', error);
      toast.error('Failed to flatten');
    }
  }, [flatten, tabId, operations]);

  /**
   * Refresh a live scenario (regenerate from source)
   */
  const handleRefreshScenario = useCallback(async (scenarioId: string) => {
    try {
      await regenerateScenario(scenarioId);
      toast.success('Scenario refreshed');
    } catch (error) {
      console.error('Failed to refresh scenario:', error);
      toast.error('Failed to refresh scenario');
    }
  }, [regenerateScenario]);
  
  /**
   * Open the query edit modal for a live scenario
   */
  const handleOpenQueryEdit = useCallback((scenarioId: string) => {
    setQueryEditModalScenarioId(scenarioId);
  }, []);
  
  /**
   * Close the query edit modal
   */
  const handleCloseQueryEdit = useCallback(() => {
    setQueryEditModalScenarioId(null);
  }, []);
  
  /**
   * Save edited query DSL and regenerate the scenario
   */
  const handleSaveQueryDSL = useCallback(async (newDSL: string) => {
    if (!queryEditModalScenarioId) return;
    
    try {
      // Find the scenario to update
      const scenario = scenarios.find(s => s.id === queryEditModalScenarioId);
      if (!scenario) {
        toast.error('Scenario not found');
        return;
      }
      
      // Update the scenario's queryDSL via context
      // Note: updateScenarioQueryDSL handles both the update and regeneration
      if (scenariosContext.updateScenarioQueryDSL) {
        await scenariosContext.updateScenarioQueryDSL(queryEditModalScenarioId, newDSL);
        toast.success('Query DSL updated and scenario refreshed');
      }
    } catch (error) {
      console.error('Failed to update query DSL:', error);
      toast.error('Failed to update query DSL');
    }
  }, [queryEditModalScenarioId, scenarios, scenariosContext]);

  /**
   * Refresh all live scenarios
   */
  const handleRefreshAllLive = useCallback(async () => {
    try {
      // Pass visible scenario IDs to ensure only visible scenarios contribute to inheritance
      await regenerateAllLive(undefined, visibleScenarioIds);
      toast.success('All live scenarios refreshed');
    } catch (error) {
      console.error('Failed to refresh all live scenarios:', error);
      toast.error('Failed to refresh all live scenarios');
    }
  }, [regenerateAllLive, visibleScenarioIds]);

  const handleCopyAllScenarioParamPacks = useCallback(async () => {
    const res = await copyAllScenarioParamPacks();
    if (!res.ok) {
      if (res.reason === 'no-tab') toast.error('No active tab');
      else if (res.reason === 'no-context') toast.error('Scenarios not ready');
      else toast.error('Clipboard copy failed (permission?)');
      return;
    }

    toast.success(
      `Copied ${res.scenarioCount} visible scenario param pack${res.scenarioCount === 1 ? '' : 's'} (of ${res.totalScenarioCount}) (${Math.round(res.byteLength / 1024)} KB)`
    );
    setCopiedPulse(true);
    window.setTimeout(() => setCopiedPulse(false), 900);
  }, [copyAllScenarioParamPacks]);

  /**
   * "To Base" - push current DSL to base and regenerate all live scenarios
   * Shows confirmation modal if any scenarios need data fetch.
   */
  const handlePutToBase = useCallback(async () => {
    const graph = graphStore?.getState().graph;
    const currentDSL = graphStore?.getState().currentDSL || '';
    const derivedBaseDSL = deriveBaseDSLForRebase(currentDSL);
    
    if (!graph) {
      toast.error('No graph loaded');
      return;
    }
    
    // Get live scenarios
    const liveScenarios = scenarios.filter(s => s.meta?.isLive);
    
    if (liveScenarios.length === 0) {
      // No live scenarios - just update base DSL
      try {
        await putToBase(visibleScenarioIds);
        toast.success('Base DSL updated');
      } catch (error) {
        console.error('Failed to put to base:', error);
        toast.error('Failed to put to base');
      }
      return;
    }
    
    // Build effective DSLs for each live scenario with the NEW base DSL
    const effectiveDSLs = liveScenarios.map((scenario, idx) => {
      // Calculate what the inherited DSL would be with the new base
      const scenarioIndex = scenarios.findIndex(s => s.id === scenario.id);
      const inheritedDSL = computeInheritedDSL(scenarioIndex, scenarios, derivedBaseDSL);
      return computeEffectiveFetchDSL(inheritedDSL, scenario.meta?.queryDSL || '');
    });
    
    // Check cache status for all effective DSLs
    const cacheResults = fetchDataService.checkMultipleDSLsNeedFetch(effectiveDSLs, graph);
    const scenariosNeedingFetch = cacheResults.filter(r => r.needsFetch).length;
    
    // If any need fetch, show confirmation modal
    if (scenariosNeedingFetch > 0) {
      setToBaseModalData({
        scenariosNeedingFetch,
        totalLiveScenarios: liveScenarios.length,
        newBaseDSL: derivedBaseDSL,
      });
      setToBaseModalOpen(true);
      return;
    }
    
    // All cached - proceed immediately
    try {
      await putToBase(visibleScenarioIds);
      toast.success('Base DSL updated and live scenarios refreshed');
    } catch (error) {
      console.error('Failed to put to base:', error);
      toast.error('Failed to put to base');
    }
  }, [graphStore, scenarios, putToBase, visibleScenarioIds]);
  
  /**
   * Confirm "To Base" from modal - proceed with operation
   */
  const handleConfirmPutToBase = useCallback(async () => {
    setToBaseModalOpen(false);
    setToBaseModalData(null);
    
    try {
      const toastId = toast.loading('Updating base and regenerating scenarios...');
      await putToBase(visibleScenarioIds);
      toast.success('Base DSL updated and live scenarios refreshed', { id: toastId });
    } catch (error) {
      console.error('Failed to put to base:', error);
      toast.error('Failed to put to base');
    }
  }, [putToBase, visibleScenarioIds]);
  
  /**
   * Cancel "To Base" from modal
   */
  const handleCancelPutToBase = useCallback(() => {
    setToBaseModalOpen(false);
    setToBaseModalData(null);
  }, []);

  // Check if there are any live scenarios
  const hasLiveScenarios = useMemo(() => {
    return scenarios.some(s => s.meta?.isLive);
  }, [scenarios]);
  
  // Check if "To Base" should be enabled
  // Enable when: current DSL differs from base DSL OR there are live scenarios to regenerate
  const canPutToBase = useMemo(() => {
    const currentDSL = graphStore?.getState().currentDSL || '';
    const baseDSLValue = baseDSL || '';
    const dslDiffers = currentDSL !== baseDSLValue;
    return dslDiffers || hasLiveScenarios;
  }, [graphStore, baseDSL, hasLiveScenarios]);
  
  /**
   * Handle context menu on scenario
   */
  const handleContextMenu = useCallback((e: React.MouseEvent, scenarioId: string) => {
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('dagnet:scenarioContextMenu', {
      detail: { x: e.clientX, y: e.clientY, scenarioId },
    }));
  }, []);
  
  /**
   * Reorder user scenarios using list indices from ScenarioLayerList
   */
  const handleReorderUserScenarios = useCallback(async (fromIndex: number, toIndex: number) => {
    if (!tabId) return;

    const currentState = operations.getScenarioState(tabId);
    if (!currentState) return;

    const orderedScenarios = scenarioOrder.length > 0
      ? scenarioOrder
          .map(id => scenarios.find(s => s.id === id))
          .filter((s): s is Scenario => s !== undefined)
      : scenarios;

    const draggedScenarioId = orderedScenarios[fromIndex]?.id;
    const targetScenario = orderedScenarios[toIndex];
    if (!draggedScenarioId || !targetScenario || draggedScenarioId === targetScenario.id) return;

    const currentVisibleOrder = currentState.visibleScenarioIds;
    const visibleUserIds = currentVisibleOrder.filter(id => id !== 'current' && id !== 'base');

    const draggedUserIndex = visibleUserIds.indexOf(draggedScenarioId);
    if (draggedUserIndex === -1) return;

    let targetUserIndex = visibleUserIds.indexOf(targetScenario.id);
    if (targetUserIndex === -1) {
      targetUserIndex = Math.max(visibleUserIds.length - 1, 0);
    }

    const newUserOrder = [...visibleUserIds];
    newUserOrder.splice(draggedUserIndex, 1);
    newUserOrder.splice(targetUserIndex, 0, draggedScenarioId);

    const newVisibleOrder: string[] = [];
    let userCursor = 0;
    for (const id of currentVisibleOrder) {
      if (id === 'current' || id === 'base') {
        newVisibleOrder.push(id);
      } else {
        newVisibleOrder.push(newUserOrder[userCursor++]);
      }
    }

    try {
      const newScenarioOrder: string[] = [];
      let orderCursor = 0;
      const oldScenarioOrder = currentState.scenarioOrder || currentVisibleOrder;

      for (const id of oldScenarioOrder) {
        if (id === 'current' || id === 'base') {
          newScenarioOrder.push(id);
        } else if (orderCursor < newUserOrder.length) {
          newScenarioOrder.push(newUserOrder[orderCursor++]);
        }
      }
      while (orderCursor < newUserOrder.length) {
        newScenarioOrder.push(newUserOrder[orderCursor++]);
      }

      await operations.updateTabState(tabId, {
        scenarioState: {
          ...currentState,
          scenarioOrder: newScenarioOrder,
          visibleScenarioIds: newVisibleOrder,
          visibleColourOrderIds: currentState.visibleColourOrderIds
        } as any
      });
    } catch (error) {
      console.error('Failed to reorder scenarios:', error);
      toast.error('Failed to reorder scenarios');
    }
  }, [tabId, operations, scenarioOrder, scenarios]);

  const scenarioLayerItems = useMemo((): ScenarioLayerItem[] => {
    const items: ScenarioLayerItem[] = [];

    items.push({
      id: 'current',
      name: 'Current',
      colour: getScenarioColour('current', currentVisible),
      visible: currentVisible,
      visibilityMode: (tabId ? operations.getScenarioVisibilityMode(tabId, 'current') : 'f+e') as 'f+e' | 'f' | 'e',
      kind: 'current',
    });

    const orderedScenarios = scenarioOrder.length > 0
      ? scenarioOrder.map(id => scenarios.find(s => s.id === id)).filter((s): s is Scenario => s !== undefined)
      : scenarios;

    for (const scenario of orderedScenarios) {
      const isVisible = visibleScenarioIds.includes(scenario.id);
      items.push({
        id: scenario.id,
        name: scenario.name,
        colour: getScenarioColour(scenario.id, isVisible),
        visible: isVisible,
        visibilityMode: (tabId ? operations.getScenarioVisibilityMode(tabId, scenario.id) : 'f+e') as 'f+e' | 'f' | 'e',
        isLive: scenario.meta?.isLive,
        tooltip: getScenarioTooltip(scenario),
        kind: 'user',
      });
    }

    items.push({
      id: 'base',
      name: 'Base',
      colour: getScenarioColour('base', baseVisible),
      visible: baseVisible,
      visibilityMode: (tabId ? operations.getScenarioVisibilityMode(tabId, 'base') : 'f+e') as 'f+e' | 'f' | 'e',
      kind: 'base',
      tooltip: baseDSL ? `Base DSL: ${baseDSL}` : 'Base parameters — inherited by all scenarios unless overridden',
    });

    return items;
  }, [scenarios, scenarioOrder, visibleScenarioIds, getScenarioColour, tabId, operations, currentVisible, baseVisible, baseDSL]);
  
  return (
    <>
      <div className="scenarios-panel">
      {/* Header */}
      {!hideHeader && (
        <div className="scenarios-header">
          <Layers size={14} strokeWidth={2} style={{ flexShrink: 0 }} />
          <h3 className="scenarios-title">Scenarios</h3>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button
              className="scenarios-header-btn"
              onClick={handleCopyAllScenarioParamPacks}
              title="Copy ALL scenario param packs as JSON to clipboard"
            >
              <ClipboardCopy size={14} style={copiedPulse ? { color: '#10B981' } : undefined} />
            </button>
            {/* Refresh All button - only shown if there are live scenarios */}
            {hasLiveScenarios && (
              <button
                className="scenarios-header-btn"
                onClick={handleRefreshAllLive}
                title="Refresh all live scenarios"
              >
                <RefreshCw size={14} />
              </button>
            )}
          </div>
        </div>
      )}
      
      {/* Scenario List */}
      <ScenarioLayerList
        items={scenarioLayerItems}
        onRename={handleRenameScenario}
        onColourChange={handleColourChange}
        onDelete={handleDelete}
        onEdit={(scenarioId) => {
          if (scenarioId === 'current' || scenarioId === 'base') {
            handleOpenEditor(scenarioId);
            return;
          }
          const scenario = scenarios.find(s => s.id === scenarioId);
          if (scenario?.meta?.isLive) handleOpenQueryEdit(scenarioId);
          else handleOpenEditor(scenarioId);
        }}
        onRefresh={(scenarioId) => {
          if (scenarioId === 'base') {
            void handleRefreshAllLive();
            return;
          }
          void handleRefreshScenario(scenarioId);
        }}
        shouldShowRefresh={(item) => item.id === 'base'
          ? hasLiveScenarios
          : Boolean(item.isLive && item.kind === 'user')}
        onCycleMode={handleCycleVisibilityMode}
        onToggleVisibility={handleToggleVisibility}
        onReorder={handleReorderUserScenarios}
        getSwatchOverlayStyle={getSwatchOverlayStyle}
        getModeIcon={getModeIcon}
        getModeTooltip={getModeTooltip}
        getEditTooltip={(scenarioId) => {
          if (scenarioId === 'current') return 'Open Current in editor';
          if (scenarioId === 'base') return 'Edit Base (params and DSL)';
          const scenario = scenarios.find(s => s.id === scenarioId);
          return scenario?.meta?.isLive ? 'Edit query DSL' : 'Open in editor';
        }}
        onRowContextMenu={handleContextMenu}
        isSelected={(id) => selectedScenarioId === id}
        currentSlot={whatIfPanelExpanded ? (
          <div
            className="current-whatif-button tab"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('.tab-close-btn')) return;
              e.stopPropagation();
              userManuallyClosed.current = true;
              setWhatIfPanelExpanded(false);
            }}
            style={{ cursor: 'pointer' }}
          >
            <span
              className="tab-text"
              style={{ fontWeight: (whatIfPanelExpanded || whatIfConditionCount > 0) ? '600' : 'normal' }}
            >
              + What if{whatIfConditionCount > 0 && ` (${whatIfConditionCount})`}
            </span>
            <button
              className="tab-close-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleClearWhatIf();
              }}
              title="Clear What-If and close panel"
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <div
            className="current-whatif-button chip"
            style={{ fontWeight: whatIfConditionCount > 0 ? '600' : 'normal', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleOpenWhatIfPanel();
              }}
              title="Open What-If panel"
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
            >
              + What if{whatIfConditionCount > 0 && ` (${whatIfConditionCount})`}
            </button>
            {whatIfConditionCount > 0 && (
              <button
                className="tab-close-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleClearWhatIf();
                }}
                title="Clear What-If conditions"
              >
                <X size={12} />
              </button>
            )}
          </div>
        )}
        currentSlotAfterActions={whatIfPanelExpanded ? (
          <div className="variant-card current-whatif-panel" style={{ padding: '12px', boxSizing: 'border-box' }}>
            <div style={{ margin: 0, padding: 0 }}>
              <WhatIfAnalysisControl tabId={tabId} />
            </div>
          </div>
        ) : null}
        afterCurrentSlot={(
          <>
            {/* Divider before inline controls */}
            <div className="scenarios-divider" />

            {/* Snapshot controls - always shown under Current */}
            <div className="scenarios-controls">
              <div className="scenarios-dropdown-container">
                <button
                  ref={menuButtonRef}
                  className="scenarios-control-btn"
                  onClick={(e) => {
                    if (scenarios.length >= 15) {
                      toast.error('Maximum of 15 scenarios reached');
                      return;
                    }
                    const rect = e.currentTarget.getBoundingClientRect();
                    setMenuPosition({ x: rect.left, y: rect.bottom + 4 });
                    setShowCreateMenu(!showCreateMenu);
                  }}
                  title={scenarios.length >= 15 ? 'Maximum scenarios reached' : 'Create new scenario'}
                  disabled={scenarios.length >= 15}
                  style={{ opacity: scenarios.length >= 15 ? 0.5 : 1 }}
                >
                  <Plus size={14} />
                  <span>New Scenario</span>
                  <ChevronDown size={12} />
                </button>
              </div>

              <button
                className="scenarios-control-btn scenarios-control-btn-flatten"
                onClick={handleFlatten}
                title="Copy Current to Base and remove all scenario overlays"
                disabled={scenarios.length === 0}
                style={{ opacity: scenarios.length === 0 ? 0.5 : 1 }}
              >
                <ArrowDownToLine size={14} />
                <span>Flatten</span>
              </button>

              {/* To Base button - pushes current DSL to base and regenerates all live scenarios */}
              <button
                className="scenarios-control-btn scenarios-control-btn-flatten"
                onClick={handlePutToBase}
                title="Push current query DSL to Base and regenerate all live scenarios"
                disabled={!canPutToBase}
                style={{ opacity: canPutToBase ? 1 : 0.5 }}
              >
                <ArrowDownFromLine size={14} />
                <span>To Base</span>
              </button>
            </div>
          </>
        )}
      />
      </div>
    
    
    {/* Editor Modal */}
    <ScenarioEditorModal
      isOpen={editorOpenScenarioId !== null}
      scenarioId={editorOpenScenarioId}
      tabId={tabId ?? null}
      onClose={handleCloseEditor}
      onSave={handleModalSave}
    />
    
    {/* Query Edit Modal for Live Scenarios */}
    {queryEditModalScenarioId && (() => {
      const scenario = scenarios.find(s => s.id === queryEditModalScenarioId);
      if (!scenario?.meta?.isLive) return null;
      
      // Compute inherited DSL for this scenario's position in the stack
      const scenarioIndex = scenarios.findIndex(s => s.id === queryEditModalScenarioId);
      const inheritedDSL = computeInheritedDSL(scenarioIndex, scenarios, baseDSL);
      
      return (
        <ScenarioQueryEditModal
          isOpen={true}
          scenarioName={scenario.name}
          currentDSL={(scenario.meta.queryDSL === LIVE_EMPTY_DIFF_DSL) ? '' : (scenario.meta.queryDSL || '')}
          inheritedDSL={inheritedDSL}
          onSave={handleSaveQueryDSL}
          onClose={handleCloseQueryEdit}
        />
      );
    })()}
    
    {/* To Base Confirmation Modal */}
    {toBaseModalOpen && toBaseModalData && (
      <ToBaseConfirmModal
        isOpen={true}
        scenariosNeedingFetch={toBaseModalData.scenariosNeedingFetch}
        totalLiveScenarios={toBaseModalData.totalLiveScenarios}
        newBaseDSL={toBaseModalData.newBaseDSL}
        onConfirm={handleConfirmPutToBase}
        onCancel={handleCancelPutToBase}
      />
    )}
    
    {/* Create Menu Dropdown - using fixed positioning like context menus */}
    {showCreateMenu && menuPosition && (
      <div
        style={{
          position: 'fixed',
          left: menuPosition.x,
          top: menuPosition.y,
          background: '#fff',
          border: '1px solid #dee2e6',
          borderRadius: '6px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          minWidth: '200px',
          padding: '4px',
          zIndex: 10000,
          fontSize: '13px'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Live scenario creation modes */}
        <button
          onClick={() => handleCreateLiveScenario('everything')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            width: '100%',
            padding: '8px 12px',
            background: 'transparent',
            border: 'none',
            color: '#374151',
            fontSize: '13px',
            textAlign: 'left',
            cursor: 'pointer',
            borderRadius: '2px'
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          Live scenario (everything) <Zap size={12} style={{ color: '#F59E0B', marginLeft: '4px' }} />
        </button>
        <button
          onClick={() => handleCreateLiveScenario('differences')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            width: '100%',
            padding: '8px 12px',
            background: 'transparent',
            border: 'none',
            color: '#374151',
            fontSize: '13px',
            textAlign: 'left',
            cursor: 'pointer',
            borderRadius: '2px'
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          Live scenario (differences)
        </button>
        {/* Divider */}
        <div style={{ height: '1px', background: '#e5e7eb', margin: '4px 0' }} />
        {/* Static scenarios */}
        <button
          onClick={() => {
            handleCaptureScenario('all', 'visible');
            setShowCreateMenu(false);
          }}
          style={{
            display: 'block',
            width: '100%',
            padding: '8px 12px',
            background: 'transparent',
            border: 'none',
            color: '#6b7280',
            fontSize: '13px',
            textAlign: 'left',
            cursor: 'pointer',
            borderRadius: '2px'
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          Capture everything
        </button>
        <button
          onClick={() => {
            handleCaptureScenario('differences', 'visible');
            setShowCreateMenu(false);
          }}
          style={{
            display: 'block',
            width: '100%',
            padding: '8px 12px',
            background: 'transparent',
            border: 'none',
            color: '#6b7280',
            fontSize: '13px',
            textAlign: 'left',
            cursor: 'pointer',
            borderRadius: '2px'
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          Capture differences
        </button>
        <button
          onClick={() => {
            handleCreateBlank();
            setShowCreateMenu(false);
          }}
          style={{
            display: 'block',
            width: '100%',
            padding: '8px 12px',
            background: 'transparent',
            border: 'none',
            color: '#6b7280',
            fontSize: '13px',
            textAlign: 'left',
            cursor: 'pointer',
            borderRadius: '2px'
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          Blank
        </button>
      </div>
    )}
  </>
  );
}

