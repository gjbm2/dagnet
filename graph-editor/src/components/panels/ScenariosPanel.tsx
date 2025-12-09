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
import { ContextMenu, ContextMenuItem } from '../ContextMenu';
import { ColourSelector } from '../ColourSelector';
import WhatIfAnalysisControl from '../WhatIfAnalysisControl';
import { parseConstraints } from '@/lib/queryDSL';
import { computeInheritedDSL, computeEffectiveFetchDSL } from '../../services/scenarioRegenerationService';
import { fetchDataService } from '../../services/fetchDataService';
import { 
  Eye, 
  EyeOff,
  Images,
  Image,
  Square,
  Edit2, 
  Trash2, 
  Plus,
  X, 
  Camera,
  ChevronDown,
  Check,
  ArrowDownToLine,
  Layers,
  Zap,
  RefreshCw,
  ArrowDownFromLine
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
  
  const { scenarios, listScenarios, renameScenario, updateScenarioColour, deleteScenario, createSnapshot, createBlank, openInEditor, closeEditor, editorOpenScenarioId, flatten, setCurrentParams, baseParams, currentParams, composeVisibleParams, currentColour, baseColour, setCurrentColour, setBaseColour, createLiveScenario, regenerateScenario, regenerateAllLive, putToBase, baseDSL } = scenariosContext;
  
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [editingScenarioId, setEditingScenarioId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [draggedScenarioId, setDraggedScenarioId] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [pendingBlankScenarioId, setPendingBlankScenarioId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; scenarioId: string } | null>(null);
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
   * Get eye icon for simple visibility (bool)
   */
  const getVisibilityIcon = useCallback((isVisible: boolean, size: number = 14) => {
    return isVisible ? <Eye size={size} /> : <EyeOff size={size} />;
  }, []);
  
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
    switch (mode) {
      case 'f+e':
        // Smooth gradient: solid left → striped right (evidence → forecast)
        // Stripe overlay fades in from left to right
        return {
          position: 'absolute',
          inset: 0,
          borderRadius: 'inherit',
          background: 'repeating-linear-gradient(45deg, transparent 0px, transparent 2px, rgba(255,255,255,0.5) 2px, rgba(255,255,255,0.5) 4px)',
          maskImage: 'linear-gradient(90deg, transparent 0%, transparent 20%, black 80%, black 100%)',
          WebkitMaskImage: 'linear-gradient(90deg, transparent 0%, transparent 20%, black 80%, black 100%)',
          pointerEvents: 'none',
        } as React.CSSProperties;
      case 'f':
        // Striped background (forecast only)
        return {
          position: 'absolute',
          inset: 0,
          borderRadius: 'inherit',
          background: 'repeating-linear-gradient(45deg, transparent 0px, transparent 2px, rgba(255,255,255,0.5) 2px, rgba(255,255,255,0.5) 4px)',
          pointerEvents: 'none',
        };
      case 'e':
        // Solid background (evidence only) - no overlay needed
        return null;
      default:
        return null;
    }
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
   * Start editing scenario name
   */
  const handleStartEdit = useCallback((scenario: Scenario) => {
    setEditingScenarioId(scenario.id);
    setEditingName(scenario.name);
  }, []);
  
  /**
   * Save edited scenario name
   */
  const handleSaveEdit = useCallback(async () => {
    if (!editingScenarioId || !editingName.trim()) {
      setEditingScenarioId(null);
      return;
    }
    
    try {
      await renameScenario(editingScenarioId, editingName.trim());
      setEditingScenarioId(null);
      toast.success('Scenario renamed');
    } catch (error) {
      console.error('Failed to rename scenario:', error);
      toast.error('Failed to rename scenario');
    }
  }, [editingScenarioId, editingName, renameScenario]);
  
  /**
   * Cancel editing scenario name
   */
  const handleCancelEdit = useCallback(() => {
    setEditingScenarioId(null);
    setEditingName('');
  }, []);
  
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
   * Open scenario in editor
   */
  const handleOpenEditor = useCallback((scenarioId: string) => {
    openInEditor(scenarioId);
  }, [openInEditor]);
  
  /**
   * Create snapshot with timestamp as default name
   */
  const handleCreateSnapshot = useCallback(async (type: 'all' | 'differences', source: 'visible' | 'base') => {
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
      
      const newScenario = await createSnapshot({
        name: timestamp,
        type,
        source,
        diffThreshold: 1e-6
      }, tabId, whatIfDSL, whatIfSummary, window, context);
      
      // Make the new snapshot visible by default
      await operations.toggleScenarioVisibility(tabId, newScenario.id);
      
      toast.success('Snapshot created');
      setShowCreateMenu(false);
    } catch (error) {
      console.error('Failed to create snapshot:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to create snapshot';
      toast.error(errorMessage);
    }
  }, [tabId, createSnapshot, tabs, operations]);
  
  // Listen for new scenario event from legend
  useEffect(() => {
    const handleNewScenarioEvent = (e: CustomEvent) => {
      // Only respond if the event is for this tab
      const eventTabId = (e.detail as any)?.tabId;
      if (!tabId || eventTabId !== tabId) {
        return;
      }
      // Directly create snapshot everything (no menu)
      handleCreateSnapshot('all', 'visible');
    };
    
    const handleScenarioContextMenu = (e: CustomEvent) => {
      const { x, y, scenarioId } = e.detail;
      setContextMenu({ x, y, scenarioId });
    };
    
    window.addEventListener('dagnet:newScenario', handleNewScenarioEvent as EventListener);
    window.addEventListener('dagnet:scenarioContextMenu', handleScenarioContextMenu as EventListener);
    
    return () => {
      window.removeEventListener('dagnet:newScenario', handleNewScenarioEvent as EventListener);
      window.removeEventListener('dagnet:scenarioContextMenu', handleScenarioContextMenu as EventListener);
    };
  }, [handleCreateSnapshot]);
  
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
   * Create a live scenario from the current query DSL
   */
  const handleCreateFromCurrentQuery = useCallback(async () => {
    if (!tabId) {
      toast.error('No active tab');
      return;
    }
    
    // Get current DSL from graphStore
    const currentDSL = graphStore?.getState().currentDSL || '';
    
    if (!currentDSL || !currentDSL.trim()) {
      toast.error('No query DSL set. Select a window or context first.');
      return;
    }
    
    try {
      const newScenario = await createLiveScenario(currentDSL, undefined, tabId);
      
      // Make the new scenario visible by default
      await operations.toggleScenarioVisibility(tabId, newScenario.id);
      
      toast.success('Live scenario created');
      setShowCreateMenu(false);
    } catch (error) {
      console.error('Failed to create live scenario:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to create live scenario';
      toast.error(errorMessage);
    }
  }, [tabId, graphStore, createLiveScenario, operations]);

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
  }, [regenerateAllLive]);

  /**
   * "To Base" - push current DSL to base and regenerate all live scenarios
   * Shows confirmation modal if any scenarios need data fetch.
   */
  const handlePutToBase = useCallback(async () => {
    const graph = graphStore?.getState().graph;
    const currentDSL = graphStore?.getState().currentDSL || '';
    
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
      const inheritedDSL = computeInheritedDSL(scenarioIndex, scenarios, currentDSL);
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
        newBaseDSL: currentDSL,
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
  }, [graphStore, scenarios, putToBase]);
  
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
  }, [putToBase]);
  
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
   * Show only this scenario (hide all others)
   */
  const handleShowOnly = useCallback(async (scenarioId: string) => {
    if (!tabId) return;
    
    try {
      console.log(`[ScenariosPanel] Show only: ${scenarioId}`);
      const currentState = operations.getScenarioState(tabId);
      console.log(`[ScenariosPanel] Current visible IDs:`, currentState?.visibleScenarioIds);
      
      await operations.setVisibleScenarios(tabId, [scenarioId]);
      
      const newState = operations.getScenarioState(tabId);
      console.log(`[ScenariosPanel] New visible IDs:`, newState?.visibleScenarioIds);
      
      toast.success('Showing only this scenario');
    } catch (error) {
      console.error('Failed to show only:', error);
      toast.error('Failed to show only');
    }
  }, [tabId, operations]);
  
  /**
   * Use as current - copies this scenario to current, overwriting and resetting whatifs
   */
  const handleUseAsCurrent = useCallback(async (scenarioId: string) => {
    if (!tabId) return;
    
    try {
      if (scenarioId === 'base') {
        // Use base params as current
        setCurrentParams(baseParams);
      } else if (scenarioId === 'current') {
        // Already current, nothing to do
        return;
      } else {
        // Find the scenario
        const scenario = scenarios.find(s => s.id === scenarioId);
        if (!scenario) {
          toast.error('Scenario not found');
          return;
        }
        
        // Compose all layers up to and including this scenario
        const scenarioState = operations.getScenarioState(tabId);
        const visibleScenarioIds = scenarioState?.visibleScenarioIds || [];
        const scenarioIndex = visibleScenarioIds.indexOf(scenarioId);
        
        // Get all visible scenarios up to this one
        const layersUpToThis = scenarioIndex >= 0 
          ? visibleScenarioIds.slice(0, scenarioIndex + 1).filter(id => id !== 'current' && id !== 'base')
          : [scenarioId];
        
        // Compose params: base + all layers up to this one
        const composedParams = composeVisibleParams(layersUpToThis);
        setCurrentParams(composedParams);
      }
      
      // Clear any whatIfDSL
      await operations.updateTabState(tabId, { whatIfDSL: null });
      
      // Make current visible if it's not already
      const scenarioState = operations.getScenarioState(tabId);
      if (scenarioState && !scenarioState.visibleScenarioIds.includes('current')) {
        await operations.toggleScenarioVisibility(tabId, 'current');
      }
      
      toast.success('Copied to current');
    } catch (error) {
      console.error('Failed to use as current:', error);
      toast.error('Failed to use as current');
    }
  }, [tabId, operations, scenarios, baseParams, setCurrentParams, composeVisibleParams]);
  
  /**
   * Merge down - applies this scenario to the next visible layer down in the stack
   */
  const handleMergeDown = useCallback(async (scenarioId: string) => {
    if (!tabId) return;
    
    try {
      // TODO: Implement merge down logic properly
      // This should compose this scenario's params onto the next visible layer below
      console.log(`[ScenariosPanel] Merge down: ${scenarioId}`);
      toast.error('Merge down - not yet implemented');
    } catch (error) {
      console.error('Failed to merge down:', error);
      toast.error('Failed to merge down');
    }
  }, [tabId]);
  
  /**
   * Build context menu items for a scenario
   */
  const buildContextMenuItems = useCallback((scenarioId: string): ContextMenuItem[] => {
    const isVisible = visibleScenarioIds.includes(scenarioId);
    const scenario = scenarios.find(s => s.id === scenarioId);
    const isUserScenario = scenario !== undefined; // Not 'current' or 'base'
    
    // Find next visible layer down in stack
    // visibleScenarioIds order: [top layer, ..., bottom layer] 
    // Typically: ['current', 'scenario-n', ..., 'scenario-1', 'base']
    const currentIndex = visibleScenarioIds.indexOf(scenarioId);
    // Can merge down if this layer is not 'base' (original)
    // Even if there's no visible layer below, we can always merge to 'base' (original)
    // Exception: 'current' shouldn't merge down (it's ephemeral, use "use as current" instead)
    const hasLayerBelow = scenarioId !== 'base' && scenarioId !== 'current';
    
    const items: ContextMenuItem[] = [];
    
    // Show/Hide
    items.push({
      label: isVisible ? 'Hide' : 'Show',
      onClick: () => handleToggleVisibility(scenarioId)
    });
    
    // Show only
    items.push({
      label: 'Show only',
      onClick: () => handleShowOnly(scenarioId)
    });
    
    items.push({ label: '', onClick: () => {}, divider: true });
    
    // Edit
    items.push({
      label: 'Edit',
      onClick: () => handleOpenEditor(scenarioId)
    });
    
    // Use as current (not for current itself)
    if (scenarioId !== 'current') {
      items.push({
        label: 'Use as current',
        onClick: () => handleUseAsCurrent(scenarioId)
      });
    }
    
    // Merge down (only if there's a layer below)
    if (hasLayerBelow) {
      items.push({
        label: 'Merge down',
        onClick: () => handleMergeDown(scenarioId)
      });
    }
    
    // Delete (not for current or base)
    if (isUserScenario) {
      items.push({ label: '', onClick: () => {}, divider: true });
      items.push({
        label: 'Delete',
        onClick: () => handleDelete(scenarioId)
      });
    }
    
    return items;
  }, [visibleScenarioIds, scenarios, handleToggleVisibility, handleShowOnly, handleOpenEditor, handleUseAsCurrent, handleMergeDown, handleDelete]);
  
  /**
   * Handle context menu on scenario
   */
  const handleContextMenu = useCallback((e: React.MouseEvent, scenarioId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, scenarioId });
  }, []);
  
  /**
   * Drag handlers
   *
   * NOTE: We no longer rely on the native `drop` event, because in some
   * environments the browser reports `dropEffect=none` even when we've
   * correctly prevented default on drag-over. Instead, we:
   *   - track the last row index the cursor was over (dragOverIndex)
   *   - commit the reorder in `handleDragEnd` using that index.
   */
  const handleDragStart = useCallback((e: React.DragEvent, scenarioId: string) => {
    console.log(`[D&D] START: dragging scenario ${scenarioId}`);
    console.log(`[D&D] Current visible order:`, visibleScenarioIds);
    console.log(`[D&D] All scenarios:`, scenarios.map(s => s.id));
    setDraggedScenarioId(scenarioId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', scenarioId); // Required for DnD in some browsers
  }, [visibleScenarioIds, scenarios]);
  
  const handleDragOverRow = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverIndex !== index) {
      console.log(`[D&D] OVER: row index ${index}`);
    }
    setDragOverIndex(index);
  }, [dragOverIndex]);

  /**
   * Core reorder logic, shared by drag-end (and could be reused by drop if needed)
   */
  const performReorder = useCallback(async (targetIndex: number) => {
    if (!draggedScenarioId || !tabId) {
      console.log(`[D&D] REORDER: Aborting - no draggedScenarioId or tabId`);
      return;
    }
    
    const currentState = operations.getScenarioState(tabId);
    if (!currentState) {
      console.log(`[D&D] REORDER: No current state found`);
      return;
    }

    // Panel order is tab-specific scenarioOrder
    const orderedScenarios = scenarioOrder.length > 0
      ? scenarioOrder
          .map(id => scenarios.find(s => s.id === id))
          .filter((s): s is Scenario => s !== undefined)
      : scenarios;

    console.log(`[D&D] REORDER: Ordered scenarios in panel:`, orderedScenarios.map(s => s.id));
    console.log(`[D&D] REORDER: Target index in panel: ${targetIndex}, target scenario:`, orderedScenarios[targetIndex]?.id);

    const targetScenario = orderedScenarios[targetIndex];
    if (!targetScenario) {
      console.log(`[D&D] REORDER: No target scenario at index ${targetIndex}`);
      return;
    }

    // Get current visible order from tab state (includes 'current' and 'base')
    const currentVisibleOrder = currentState.visibleScenarioIds;
    console.log(`[D&D] REORDER: Current visible order (full):`, currentVisibleOrder);

    // Work ONLY on user scenarios (exclude 'current' and 'base') so the panel order
    // maps 1:1 to this subset.
    const visibleUserIds = currentVisibleOrder.filter(
      id => id !== 'current' && id !== 'base'
    );

    const draggedUserIndex = visibleUserIds.indexOf(draggedScenarioId);
    if (draggedUserIndex === -1) {
      console.log(
        `[D&D] REORDER: Dragged scenario ${draggedScenarioId} is not in visible user subset, ignoring`
      );
      return;
    }
    
    // Target may be hidden; if so, treat as "drop at end" of visible user subset
    let targetUserIndex = visibleUserIds.indexOf(targetScenario.id);
    if (targetUserIndex === -1) {
      console.log(
        `[D&D] REORDER: Target scenario ${targetScenario.id} not in visible user subset, treating as drop at end`
      );
      targetUserIndex = visibleUserIds.length - 1;
    }

    console.log(
      `[D&D] REORDER: User subset before:`,
      visibleUserIds,
      `draggedUserIndex=${draggedUserIndex}, targetUserIndex=${targetUserIndex}`
    );

    // Build new user-only order: remove dragged, then insert at targetUserIndex
    const newUserOrder = [...visibleUserIds];
    newUserOrder.splice(draggedUserIndex, 1);
    newUserOrder.splice(targetUserIndex, 0, draggedScenarioId);

    console.log(`[D&D] REORDER: User subset after:`, newUserOrder);

    // Rebuild full visible order by preserving the positions of 'current'/'base'
    // and filling user slots with the newUserOrder in sequence.
    const newVisibleOrder: string[] = [];
    let userCursor = 0;
    for (const id of currentVisibleOrder) {
      if (id === 'current' || id === 'base') {
        newVisibleOrder.push(id);
      } else {
        newVisibleOrder.push(newUserOrder[userCursor++]);
      }
    }

    console.log(`[D&D] REORDER: Final new visible order:`, newVisibleOrder);

    try {
      // Rebuild full scenarioOrder by reordering only the user scenarios
      const newScenarioOrder: string[] = [];
      let userCursor = 0;
      
      // If scenarioOrder includes 'current' or 'base', preserve their positions
      const oldScenarioOrder = currentState.scenarioOrder || currentVisibleOrder;
      for (const id of oldScenarioOrder) {
        if (id === 'current' || id === 'base') {
          newScenarioOrder.push(id);
        } else if (userCursor < newUserOrder.length) {
          newScenarioOrder.push(newUserOrder[userCursor++]);
        }
      }
      
      // Add any remaining user scenarios
      while (userCursor < newUserOrder.length) {
        newScenarioOrder.push(newUserOrder[userCursor++]);
      }
      
      console.log(`[D&D] REORDER: New scenarioOrder (full):`, newScenarioOrder);
      
      // Update tab state with new orders
      await operations.updateTabState(tabId, {
        // Cast to any to align with extended TabScenarioState shape (includes scenarioOrder)
        scenarioState: {
          ...currentState,
          scenarioOrder: newScenarioOrder,
          visibleScenarioIds: newVisibleOrder,
          visibleColourOrderIds: currentState.visibleColourOrderIds
        } as any
      });
      console.log(`[D&D] REORDER: Successfully updated tab state`);
    } catch (error) {
      console.error('[D&D] REORDER: Failed to reorder scenarios:', error);
      toast.error('Failed to reorder scenarios');
    }
  }, [draggedScenarioId, tabId, operations, scenarioOrder, visibleScenarioIds, scenarios]);

  const handleDragEnd = useCallback(() => {
    console.log(`[D&D] END: drag operation ended. draggedScenarioId=${draggedScenarioId}, dragOverIndex=${dragOverIndex}`);

    if (draggedScenarioId && dragOverIndex !== null) {
      console.log(`[D&D] END: committing reorder to index ${dragOverIndex} (using last hovered row)`);
      // Fire and forget; errors are logged inside performReorder
      void performReorder(dragOverIndex);
    } else {
      console.log(`[D&D] END: no valid dragOverIndex, not reordering`);
    }
    
    setDraggedScenarioId(null);
    setDragOverIndex(null);
  }, [draggedScenarioId, dragOverIndex, performReorder]);
  
  return (
    <>
      <div className="scenarios-panel">
      {/* Header */}
      {!hideHeader && (
        <div className="scenarios-header">
          <Layers size={14} strokeWidth={2} style={{ flexShrink: 0 }} />
          <h3 className="scenarios-title">Scenarios</h3>
          {/* Refresh All button - only shown if there are live scenarios */}
          {hasLiveScenarios && (
            <button
              className="scenarios-header-btn"
              onClick={handleRefreshAllLive}
              title="Refresh all live scenarios"
              style={{ marginLeft: 'auto' }}
            >
              <RefreshCw size={14} />
            </button>
          )}
        </div>
      )}
      
      {/* Scenario List */}
      <div 
        className="scenarios-list"
      >
        {/* Current (pinned at TOP, non-draggable, toggleable) */}
        <div className="scenario-row scenario-current">
          {/* Swatch - show empty placeholder if not visible, clickable to change colour */}
          {currentVisible ? (
            <div className="scenario-colour-swatch-wrapper" style={{ position: 'relative' }}>
              <ColourSelector
                compact={true}
                value={getScenarioColour('current', currentVisible)}
                onChange={(colour) => handleColourChange('current', colour)}
              />
              {getSwatchOverlayStyle('current') && (
                <div style={getSwatchOverlayStyle('current') as React.CSSProperties} />
              )}
            </div>
          ) : (
            <div className="scenario-colour-swatch-placeholder"></div>
          )}
          
          {/* Current label and What-If chip/tab grouped together */}
          <div className="current-label-group">
            <div 
              className="scenario-name"
              onContextMenu={(e) => handleContextMenu(e, 'current')}
            >
              Current
            </div>
            
            {/* What-If chip/tab button */}
            {whatIfPanelExpanded ? (
              <div 
                className="current-whatif-button tab"
                onClick={(e) => {
                  // Only toggle if clicking the text, not the X button
                  if ((e.target as HTMLElement).closest('.tab-close-btn')) {
                    return; // X button handles its own click
                  }
                  e.stopPropagation();
                  console.log('[ScenariosPanel] Tab clicked, toggling panel');
                  userManuallyClosed.current = true; // Mark as manually closed
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
                    console.log('[ScenariosPanel] X button clicked, clearing What-If');
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
                    console.log('[ScenariosPanel] Chip clicked, opening panel');
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
                      console.log('[ScenariosPanel] X button clicked on chip, clearing What-If');
                      handleClearWhatIf();
                    }}
                    title="Clear What-If conditions"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            )}
          </div>
          
          {/* Right-aligned action buttons (order: edit > mode > visible) */}
          <button
            className="scenario-action-btn"
            onClick={() => handleOpenEditor('current')}
            title="Open Current in editor"
          >
            <Edit2 size={14} />
          </button>
          <button
            className="scenario-action-btn"
            onClick={() => handleCycleVisibilityMode('current')}
            title={getModeTooltip('current')}
          >
            {getModeIcon('current')}
          </button>
          <button
            className="scenario-action-btn"
            onClick={() => operations.toggleScenarioVisibility(tabId!, 'current')}
            title={currentVisible ? 'Hide Current' : 'Show Current'}
          >
            {getVisibilityIcon(currentVisible)}
          </button>
          
          {/* What-If Panel (rendered INSIDE Current card when expanded) */}
          {whatIfPanelExpanded && (
            <div className="variant-card current-whatif-panel" style={{ padding: '12px', boxSizing: 'border-box' }}>
              <div style={{ margin: 0, padding: 0 }}>
                <WhatIfAnalysisControl tabId={tabId} />
              </div>
            </div>
          )}
        </div>
        
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
        
        {/* User Scenarios (draggable) */}
        {/* Display ALL scenarios in tab-specific layer order */}
        {/* Invisible scenarios stay in place, just faded - they retain their palette position */}
        {(() => {
          // Get all scenarios in tab-specific order (scenarioOrder tracks position of ALL scenarios)
          // If scenarioOrder is empty/missing, fall back to scenarios creation order
          const orderedScenarios = scenarioOrder.length > 0
            ? scenarioOrder
                .map(id => scenarios.find(s => s.id === id))
                .filter((s): s is Scenario => s !== undefined)
            : scenarios;

          // For sliding/shuffling effect during drag, we work in PANEL order
          const draggedPanelIndex = draggedScenarioId
            ? orderedScenarios.findIndex(s => s.id === draggedScenarioId)
            : -1;
          const targetPanelIndex = dragOverIndex ?? -1;
          
          return orderedScenarios.map((scenario, index) => {
          const isVisible = visibleScenarioIds.includes(scenario.id);
          const isSelected = selectedScenarioId === scenario.id;
            const scenarioColour = getScenarioColour(scenario.id, isVisible);
          const isEditing = editingScenarioId === scenario.id;
          const isDragging = draggedScenarioId === scenario.id;
          const isDragOver = dragOverIndex === index;

            // Default: no offset
            let transform = '';

            // While dragging, slide rows between original and target positions
            if (
              draggedPanelIndex !== -1 &&
              targetPanelIndex !== -1 &&
              !isDragging // the dragged row itself stays under the cursor
            ) {
              // Dragging downwards
              if (draggedPanelIndex < targetPanelIndex) {
                if (index > draggedPanelIndex && index <= targetPanelIndex) {
                  transform = 'translateY(-32px)';
                }
              }
              // Dragging upwards
              else if (draggedPanelIndex > targetPanelIndex) {
                if (index >= targetPanelIndex && index < draggedPanelIndex) {
                  transform = 'translateY(32px)';
                }
              }
            }
          
          return (
            <div
              key={scenario.id}
              className={`scenario-row ${isSelected ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
                style={{
                  transform,
                  transition: isDragging ? 'none' : 'transform 0.15s ease'
                }}
                onDragOver={(e) => handleDragOverRow(e, index)}
                onContextMenu={(e) => handleContextMenu(e, scenario.id)}
            >
              {/* Swatch - draggable, always show, faded if not visible, clickable to change colour */}
              <div
                className="scenario-colour-swatch-wrapper"
                style={{ opacity: isVisible ? 1 : 0.3, position: 'relative' }}
                title="Drag to reorder, click to change colour"
                draggable={!isEditing}
                onDragStart={(e) => {
                  if (isEditing) {
                    e.preventDefault();
                    return;
                  }
                  e.stopPropagation();
                  handleDragStart(e, scenario.id);
                }}
                onDragEnd={handleDragEnd}
              >
                <ColourSelector
                  compact={true}
                  value={scenarioColour}
                  onChange={(colour) => handleColourChange(scenario.id, colour)}
                />
                {getSwatchOverlayStyle(scenario.id) && (
                  <div style={getSwatchOverlayStyle(scenario.id) as React.CSSProperties} />
                )}
              </div>
              
              {/* Name - clickable to edit, or input when editing */}
              {isEditing ? (
                <input
                  type="text"
                  className="scenario-name-input"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveEdit();
                    if (e.key === 'Escape') handleCancelEdit();
                  }}
                  autoFocus
                />
              ) : (
                <div
                  className="scenario-name scenario-name-editable"
                  title={getScenarioTooltip(scenario)}
                  onClick={() => handleStartEdit(scenario)}
                >
                  {scenario.name}
                  {/* Live scenario indicator - appended to label if space */}
                  {scenario.meta?.isLive && (
                    <span title="Live scenario">
                      <Zap 
                        size={11} 
                        style={{ 
                          color: '#374151', 
                          marginLeft: '4px',
                          verticalAlign: 'middle',
                          flexShrink: 0
                        }}
                      />
                    </span>
                  )}
                </div>
              )}
              
              {/* Right-aligned action buttons */}
              {isEditing ? (
                <>
                  {/* While editing: show commit and cancel buttons */}
              <button
                className="scenario-action-btn"
                    onClick={handleCancelEdit}
                    title="Cancel"
              >
                    <X size={14} />
              </button>
              <button
                className="scenario-action-btn"
                    onClick={handleSaveEdit}
                    title="Save"
                  >
                    <Check size={14} />
                  </button>
                </>
              ) : (
                <>
                  {/* Normal mode: refresh (live only), then delete > edit > mode > visible */}
                  {scenario.meta?.isLive && (
                    <button
                      className="scenario-action-btn"
                      onClick={() => handleRefreshScenario(scenario.id)}
                      title="Refresh from source"
                    >
                      <RefreshCw size={14} />
                    </button>
                  )}
                  <button
                    className="scenario-action-btn danger"
                    onClick={() => handleDelete(scenario.id)}
                    title="Delete scenario"
              >
                    <Trash2 size={14} />
              </button>
              <button
                className="scenario-action-btn"
                onClick={() => scenario.meta?.isLive 
                  ? handleOpenQueryEdit(scenario.id) 
                  : handleOpenEditor(scenario.id)
                }
                title={scenario.meta?.isLive ? "Edit query DSL" : "Open in editor"}
              >
                <Edit2 size={14} />
              </button>
              <button
                className="scenario-action-btn"
                onClick={() => handleCycleVisibilityMode(scenario.id)}
                title={getModeTooltip(scenario.id)}
              >
                {getModeIcon(scenario.id)}
              </button>
              <button
                className="scenario-action-btn"
                onClick={() => operations.toggleScenarioVisibility(tabId!, scenario.id)}
                title={visibleScenarioIds.includes(scenario.id) ? 'Hide scenario' : 'Show scenario'}
              >
                {getVisibilityIcon(visibleScenarioIds.includes(scenario.id))}
              </button>
                </>
              )}
            </div>
          );
        });
        })()}
        
        {/* Divider before Base */}
        <div className="scenarios-divider" />
        
        {/* Base - pinned at BOTTOM, non-draggable, toggleable */}
        <div className="scenario-row scenario-base">
          {/* Swatch - show empty placeholder if not visible, clickable to change colour */}
          {baseVisible ? (
            <div className="scenario-colour-swatch-wrapper" style={{ position: 'relative' }}>
              <ColourSelector
                compact={true}
                value={getScenarioColour('base', baseVisible)}
                onChange={(colour) => handleColourChange('base', colour)}
              />
              {getSwatchOverlayStyle('base') && (
                <div style={getSwatchOverlayStyle('base') as React.CSSProperties} />
              )}
            </div>
          ) : (
            <div className="scenario-colour-swatch-placeholder"></div>
          )}
          
          <div 
            className="scenario-name"
            onContextMenu={(e) => handleContextMenu(e, 'base')}
            title={baseDSL ? `Base DSL: ${baseDSL}` : "Base parameters — inherited by all scenarios unless overridden"}
          >
            Base
          </div>
          
          {/* Right-aligned action buttons */}
          {/* Refresh button - refreshes all live scenarios using base DSL */}
          {hasLiveScenarios && (
            <button
              className="scenario-action-btn"
              onClick={handleRefreshAllLive}
              title="Refresh all live scenarios"
            >
              <RefreshCw size={14} />
            </button>
          )}
          <button
            className="scenario-action-btn"
            onClick={() => handleOpenEditor('base')}
            title="Edit Base (params and DSL)"
          >
            <Edit2 size={14} />
          </button>
          <button
            className="scenario-action-btn"
            onClick={() => handleCycleVisibilityMode('base')}
            title={getModeTooltip('base')}
          >
            {getModeIcon('base')}
          </button>
          <button
            className="scenario-action-btn"
            onClick={() => operations.toggleScenarioVisibility(tabId!, 'base')}
            title={baseVisible ? 'Hide Base' : 'Show Base'}
          >
            {getVisibilityIcon(baseVisible)}
          </button>
        </div>
      </div>
              </div>
    
    {/* Context Menu */}
    {contextMenu && (
      <ContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        items={buildContextMenuItems(contextMenu.scenarioId)}
        onClose={() => setContextMenu(null)}
      />
    )}
    
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
      if (!scenario?.meta?.queryDSL) return null;
      
      // Compute inherited DSL for this scenario's position in the stack
      const scenarioIndex = scenarios.findIndex(s => s.id === queryEditModalScenarioId);
      const inheritedDSL = computeInheritedDSL(scenarioIndex, scenarios, baseDSL);
      
      return (
        <ScenarioQueryEditModal
          isOpen={true}
          scenarioName={scenario.name}
          currentDSL={scenario.meta.queryDSL}
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
        <button
          onClick={() => {
            handleCreateSnapshot('all', 'visible');
            setShowCreateMenu(false);
          }}
          style={{
            display: 'block',
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
          Snapshot everything
        </button>
        <button
          onClick={() => {
            handleCreateSnapshot('differences', 'visible');
            setShowCreateMenu(false);
          }}
          style={{
            display: 'block',
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
          Snapshot differences
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
            color: '#374151',
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
        {/* Divider */}
        <div style={{ height: '1px', background: '#e5e7eb', margin: '4px 0' }} />
        <button
          onClick={handleCreateFromCurrentQuery}
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
          From current query <Zap size={12} style={{ color: 'currentColor', marginLeft: '4px' }} />
        </button>
      </div>
    )}
  </>
  );
}

