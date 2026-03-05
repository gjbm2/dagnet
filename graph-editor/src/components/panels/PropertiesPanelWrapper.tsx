import React from 'react';
import PropertiesPanel from '../PropertiesPanel';
import { useSelectionContext } from '../editors/GraphEditor';
import { Camera, FileText, Plug, ZapOff } from 'lucide-react';
import { useGraphStore } from '../../contexts/GraphStoreContext';
import { useTabContext } from '../../contexts/TabContext';
import { getPropertiesPanelHeaderBadges } from '../../services/propertiesPanelHeaderBadgeService';
import { useRemoveOverrides } from '../../hooks/useRemoveOverrides';
import { useSnapshotsMenu } from '../../hooks/useSnapshotsMenu';
import { useOpenSnapshotManagerForEdge } from '../../hooks/useOpenSnapshotManagerForEdge';
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
  const { selectedNodeId, selectedEdgeId, selectedPostitId, onSelectedNodeChange, onSelectedEdgeChange } = useSelectionContext();
  const graphStore = useGraphStore();
  const { graph, setGraph, saveHistoryState, currentDSL } = graphStore;
  const { tabs } = useTabContext();
  const graphFileId = tabId ? tabs.find(t => t.id === tabId)?.fileId ?? null : null;
  
  // Determine panel title based on selection
  const title = selectedPostitId
    ? 'Post-It Properties'
    : selectedNodeId 
    ? 'Node Properties'
    : selectedEdgeId 
      ? 'Edge Properties'
      : 'Graph Properties';

  const badges = getPropertiesPanelHeaderBadges(graph, selectedNodeId, selectedEdgeId);

  // ---------------------------------------------------------------------------
  // Snapshots badge (edge only): show if ANY param on that edge has snapshot DB rows.
  // ---------------------------------------------------------------------------

  const edgeData = React.useMemo(() => {
    if (!graph || !selectedEdgeId) return null;
    return graph.edges?.find((e: any) => e.uuid === selectedEdgeId || e.id === selectedEdgeId) ?? null;
  }, [graph, selectedEdgeId]);

  const edgeSnapshotParamIds = React.useMemo(() => {
    if (!edgeData) return [];
    const ids: string[] = [];
    if (typeof edgeData?.p?.id === 'string' && edgeData.p.id.trim()) ids.push(edgeData.p.id.trim());
    if (typeof edgeData?.cost_gbp?.id === 'string' && edgeData.cost_gbp.id.trim()) ids.push(edgeData.cost_gbp.id.trim());
    if (typeof edgeData?.labour_cost?.id === 'string' && edgeData.labour_cost.id.trim()) ids.push(edgeData.labour_cost.id.trim());
    if (Array.isArray(edgeData?.conditional_p)) {
      for (const cp of edgeData.conditional_p) {
        const pid = cp?.p?.id;
        if (typeof pid === 'string' && pid.trim()) ids.push(pid.trim());
      }
    }
    return Array.from(new Set(ids));
  }, [edgeData]);

  const { inventories, snapshotCounts } = useSnapshotsMenu(edgeSnapshotParamIds);

  const snapshotParamIdsWithData = React.useMemo(() => {
    return edgeSnapshotParamIds.filter((id) => (inventories[id]?.row_count ?? 0) > 0);
  }, [edgeSnapshotParamIds.join(','), inventories]);

  const fmtDate = (d: string) => {
    const date = new Date(d);
    return `${date.getDate()}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getMonth()]}-${date.getFullYear().toString().slice(-2)}`;
  };

  const snapshotsTooltip = React.useMemo(() => {
    if (!selectedEdgeId || snapshotParamIdsWithData.length === 0) return 'No snapshots';
    const lines: string[] = ['Snapshots (retrieved):'];
    for (const pid of snapshotParamIdsWithData) {
      const inv = inventories[pid];
      if (!inv) continue;
      const count = snapshotCounts[pid] ?? 0;
      const range = inv.earliest && inv.latest ? `${fmtDate(inv.earliest)} — ${fmtDate(inv.latest)}` : '(range unknown)';
      const countSuffix = count > 0 ? ` (${count}d)` : '';
      lines.push(`- ${pid}: ${range}${countSuffix}`);
    }
    return lines.join('\n');
  }, [selectedEdgeId, snapshotParamIdsWithData.join(','), inventories, snapshotCounts]);

  // Snapshot Manager: determine primary parameter slot for the selected edge
  const primarySnapshotParam = React.useMemo<{ paramId: string; slot: 'p' | 'cost_gbp' | 'labour_cost' } | null>(() => {
    if (!edgeData) return null;
    if (typeof edgeData?.p?.id === 'string' && edgeData.p.id.trim()) return { paramId: edgeData.p.id.trim(), slot: 'p' };
    if (typeof edgeData?.cost_gbp?.id === 'string' && edgeData.cost_gbp.id.trim()) return { paramId: edgeData.cost_gbp.id.trim(), slot: 'cost_gbp' };
    if (typeof edgeData?.labour_cost?.id === 'string' && edgeData.labour_cost.id.trim()) return { paramId: edgeData.labour_cost.id.trim(), slot: 'labour_cost' };
    return null;
  }, [edgeData]);

  const openSnapshotManagerForEdge = useOpenSnapshotManagerForEdge({
    graph: graph!,
    graphFileId,
    currentDsl: currentDSL || '',
  });

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
          {selectedEdgeId && edgeSnapshotParamIds.length > 0 && primarySnapshotParam && (
            <div
              className="properties-panel-badge"
              data-testid="edge-snapshots-badge"
              title={snapshotsTooltip}
              onClick={(e) => {
                e.stopPropagation();
                void openSnapshotManagerForEdge({
                  edgeId: selectedEdgeId,
                  paramId: primarySnapshotParam.paramId,
                  slot: primarySnapshotParam.slot,
                });
              }}
              style={{ cursor: 'pointer', opacity: snapshotParamIdsWithData.length > 0 ? 1 : 0.4 }}
            >
              <span className="properties-panel-badge-icon">
                <Camera size={14} strokeWidth={2} />
              </span>
            </div>
          )}
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
          selectedPostitId={selectedPostitId}
          onSelectedNodeChange={onSelectedNodeChange}
          onSelectedEdgeChange={onSelectedEdgeChange}
          tabId={tabId}
        />
      </div>
    </div>
  );
}

