import React from 'react';
import PropertiesPanel from '../PropertiesPanel';
import { useSelectionContext } from '../editors/GraphEditor';
import { FileText, Plug, ZapOff } from 'lucide-react';
import { useGraphStore } from '../../contexts/GraphStoreContext';
import { getPropertiesPanelHeaderBadges } from '../../services/propertiesPanelHeaderBadgeService';
import { useRemoveOverrides } from '../../hooks/useRemoveOverrides';
import toast from 'react-hot-toast';
import './PropertiesPanelWrapper.css';

interface PropertiesPanelWrapperProps {
  tabId?: string;
}

/**
 * Properties Panel Wrapper
 * Wraps the existing PropertiesPanel for use in rc-dock sidebar
 * Gets selection state from SelectionContext
 */
export default function PropertiesPanelWrapper({ tabId }: PropertiesPanelWrapperProps) {
  // Get current selection from context (updates automatically when selection changes)
  const { selectedNodeId, selectedEdgeId, onSelectedNodeChange, onSelectedEdgeChange } = useSelectionContext();
  const graphStore = useGraphStore();
  const { graph, setGraph, saveHistoryState } = graphStore;
  
  // Determine panel title based on selection
  const title = selectedNodeId 
    ? 'Node Properties'
    : selectedEdgeId 
      ? 'Edge Properties'
      : 'Graph Properties';

  const badges = getPropertiesPanelHeaderBadges(graph, selectedNodeId, selectedEdgeId);

  // Toast is shown only after the graph update succeeds (undoable).
  const pendingRemoveOverridesToastRef = React.useRef<number | null>(null);

  const onUpdateGraph = React.useCallback((nextGraph: any, historyLabel: string, objectId?: string) => {
    const oldGraph = graphStore.getState().graph;
    if (!oldGraph) return;
    void (async () => {
      const { graphMutationService } = await import('../../services/graphMutationService');
      await graphMutationService.updateGraph(oldGraph, nextGraph, setGraph);
      // One undo entry (required)
      saveHistoryState(historyLabel, selectedNodeId || undefined, selectedEdgeId || undefined);

      if (historyLabel === 'Remove overrides') {
        const count = pendingRemoveOverridesToastRef.current;
        pendingRemoveOverridesToastRef.current = null;
        if (typeof count === 'number') {
          const suffix = count === 1 ? '' : 's';
          toast.success(`Removed ${count} override${suffix}`);
        } else {
          toast.success('Removed overrides');
        }
      }
    })();
  }, [graphStore, saveHistoryState, selectedEdgeId, selectedNodeId, setGraph]);

  // Multi-selection aware: clearing overrides should apply to ALL selected nodes/edges,
  // not just the focused selection in the properties panel.
  const { hasOverrides, removeOverrides } = useRemoveOverrides(
    graph,
    onUpdateGraph,
    selectedNodeId,
    selectedEdgeId,
    { includeMultiSelection: true }
  );
  
  return (
    <div className="properties-panel-wrapper">
      <div className="panel-header">
        <FileText size={14} strokeWidth={2} style={{ flexShrink: 0 }} />
        <h3>{title}</h3>
        <div className="properties-panel-header-badges">
          {badges.overrides.visible && (
            <div
              className="properties-panel-badge"
              title={badges.overrides.tooltip}
              onClick={(e) => {
                e.stopPropagation();
                if (hasOverrides) {
                  pendingRemoveOverridesToastRef.current = badges.overrides.count ?? null;
                  removeOverrides();
                }
              }}
              style={{ cursor: hasOverrides ? 'pointer' : 'default' }}
            >
              <span className="properties-panel-badge-icon properties-panel-badge-icon--override">
                <ZapOff size={14} strokeWidth={2} />
              </span>
              <span className="properties-panel-badge-count">{badges.overrides.count ?? 0}</span>
            </div>
          )}
          {badges.connection.visible && (
            <div className="properties-panel-badge" title={badges.connection.tooltip}>
              <span className="properties-panel-badge-icon">
                <Plug size={14} strokeWidth={2} />
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="panel-body">
        <PropertiesPanel
          selectedNodeId={selectedNodeId}
          selectedEdgeId={selectedEdgeId}
          onSelectedNodeChange={onSelectedNodeChange}
          onSelectedEdgeChange={onSelectedEdgeChange}
          tabId={tabId}
        />
      </div>
    </div>
  );
}

