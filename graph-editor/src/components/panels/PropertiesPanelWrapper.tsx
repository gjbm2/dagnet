import React from 'react';
import PropertiesPanel from '../PropertiesPanel';
import { useSelectionContext } from '../editors/GraphEditor';
import { Camera, FileText, Plug, ZapOff } from 'lucide-react';
import { useGraphStore } from '../../contexts/GraphStoreContext';
import { getPropertiesPanelHeaderBadges } from '../../services/propertiesPanelHeaderBadgeService';
import { useRemoveOverrides } from '../../hooks/useRemoveOverrides';
import { useSnapshotsMenu } from '../../hooks/useSnapshotsMenu';
import toast from 'react-hot-toast';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
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

  // ---------------------------------------------------------------------------
  // Snapshots badge (edge only): show if ANY param on that edge has snapshot DB rows.
  // ---------------------------------------------------------------------------

  const edgeSnapshotParamIds = React.useMemo(() => {
    if (!graph || !selectedEdgeId) return [];
    const edge = graph.edges?.find((e: any) => e.uuid === selectedEdgeId || e.id === selectedEdgeId);
    if (!edge) return [];
    const ids: string[] = [];
    if (typeof edge?.p?.id === 'string' && edge.p.id.trim()) ids.push(edge.p.id.trim());
    if (typeof edge?.cost_gbp?.id === 'string' && edge.cost_gbp.id.trim()) ids.push(edge.cost_gbp.id.trim());
    if (typeof edge?.labour_cost?.id === 'string' && edge.labour_cost.id.trim()) ids.push(edge.labour_cost.id.trim());
    if (Array.isArray(edge?.conditional_p)) {
      for (const cp of edge.conditional_p) {
        const pid = cp?.p?.id;
        if (typeof pid === 'string' && pid.trim()) ids.push(pid.trim());
      }
    }
    return Array.from(new Set(ids));
  }, [graph, selectedEdgeId]);

  const snapshots = useSnapshotsMenu(edgeSnapshotParamIds);

  const snapshotParamIdsWithData = React.useMemo(() => {
    return edgeSnapshotParamIds.filter((id) => (snapshots.inventories[id]?.row_count ?? 0) > 0);
  }, [edgeSnapshotParamIds.join(','), snapshots.inventories]);

  const fmtDate = (d: string) => {
    const date = new Date(d);
    return `${date.getDate()}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getMonth()]}-${date.getFullYear().toString().slice(-2)}`;
  };

  const snapshotsTooltip = React.useMemo(() => {
    if (!selectedEdgeId || snapshotParamIdsWithData.length === 0) return 'No snapshots';
    const lines: string[] = ['Snapshots (retrieved):'];
    for (const pid of snapshotParamIdsWithData) {
      const inv = snapshots.inventories[pid];
      if (!inv) continue;
      const count = snapshots.snapshotCounts[pid] ?? 0;
      const range = inv.earliest && inv.latest ? `${fmtDate(inv.earliest)} — ${fmtDate(inv.latest)}` : '(range unknown)';
      const countSuffix = count > 0 ? ` (${count}d)` : '';
      lines.push(`- ${pid}: ${range}${countSuffix}`);
    }
    return lines.join('\n');
  }, [selectedEdgeId, snapshotParamIdsWithData.join(','), snapshots.inventories, snapshots.snapshotCounts]);

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
          {selectedEdgeId && edgeSnapshotParamIds.length > 0 && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <div
                  className="properties-panel-badge"
                  data-testid="edge-snapshots-badge"
                  title={snapshotsTooltip}
                  onClick={(e) => e.stopPropagation()}
                  style={{ cursor: 'pointer', opacity: snapshotParamIdsWithData.length > 0 ? 1 : 0.4 }}
                >
                  <span className="properties-panel-badge-icon">
                    <Camera size={14} strokeWidth={2} />
                  </span>
                </div>
              </DropdownMenu.Trigger>

              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="properties-snapshots-menu"
                  data-testid="edge-snapshots-menu"
                  sideOffset={6}
                  align="end"
                  onClick={(e) => e.stopPropagation()}
                >
                  {edgeSnapshotParamIds.map((paramId) => {
                    const count = snapshots.snapshotCounts[paramId] ?? 0;
                    const hasRows = (snapshots.inventories[paramId]?.row_count ?? 0) > 0;
                    return (
                      <DropdownMenu.Sub key={paramId}>
                        <DropdownMenu.SubTrigger className="properties-snapshots-item">
                          {paramId}
                          <div className="properties-snapshots-right-slot">›</div>
                        </DropdownMenu.SubTrigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.SubContent className="properties-snapshots-menu" sideOffset={0} alignOffset={0}>
                            <DropdownMenu.Item
                              className="properties-snapshots-item"
                              disabled={!hasRows}
                              onSelect={() => void snapshots.downloadSnapshotData(paramId)}
                            >
                              Download snapshot data
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              className="properties-snapshots-item properties-snapshots-item--danger"
                              disabled={count === 0}
                              onSelect={() => void snapshots.deleteSnapshots(paramId)}
                            >
                              Delete {count} snapshot{count !== 1 ? 's' : ''}
                            </DropdownMenu.Item>
                          </DropdownMenu.SubContent>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Sub>
                    );
                  })}

                  <DropdownMenu.Separator className="properties-snapshots-separator" />

                  <DropdownMenu.Item
                    className="properties-snapshots-item"
                    disabled={snapshotParamIdsWithData.length === 0}
                    onSelect={() => void snapshots.downloadSnapshotDataMany(snapshotParamIdsWithData, `edge-${selectedEdgeId}-snapshots`)}
                  >
                    Download all
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="properties-snapshots-item properties-snapshots-item--danger"
                    disabled={snapshotParamIdsWithData.length === 0}
                    onSelect={() => void snapshots.deleteSnapshotsMany(snapshotParamIdsWithData)}
                  >
                    Delete all
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
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
          onSelectedNodeChange={onSelectedNodeChange}
          onSelectedEdgeChange={onSelectedEdgeChange}
          tabId={tabId}
        />
      </div>
    </div>
  );
}

