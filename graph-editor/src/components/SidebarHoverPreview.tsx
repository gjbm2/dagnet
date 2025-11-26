import React from 'react';
import ScenariosPanel from './panels/ScenariosPanel';
import PropertiesPanel from './PropertiesPanel';
import ToolsPanel from './panels/ToolsPanel';
import AnalyticsPanel from './panels/AnalyticsPanel';
import { Layers, FileText, Wrench, BarChart3 } from 'lucide-react';
import './SidebarHoverPreview.css';

interface SidebarHoverPreviewProps {
  panel: 'what-if' | 'properties' | 'tools' | 'analytics' | null;
  tabId?: string;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectedNodeChange: (id: string | null) => void;
  onSelectedEdgeChange: (id: string | null) => void;
  // Tools panel props
  onAutoLayout?: (direction?: 'LR' | 'RL' | 'TB' | 'BT') => void;
  onSankeyLayout?: () => void;
  onForceReroute?: () => void;
  onHideUnselected?: () => void;
  onShowAll?: () => void;
}

/**
 * Sidebar Hover Preview Component
 * 
 * Shows panel content as an overlay when hovering over icon bar
 * Positioned to the left of the icon bar
 * 
 * Does not change state - just provides quick preview access
 */
export default function SidebarHoverPreview({
  panel,
  tabId,
  selectedNodeId,
  selectedEdgeId,
  onSelectedNodeChange,
  onSelectedEdgeChange,
  // Tools props
  onAutoLayout,
  onSankeyLayout,
  onForceReroute,
  onHideUnselected,
  onShowAll
}: SidebarHoverPreviewProps) {
  if (!panel) {
    return null;
  }
  
  return (
    <div className="sidebar-hover-preview">
      <div className="preview-content">
        {panel === 'what-if' && (
          <div className="preview-panel">
            <div className="preview-header">
              <Layers size={14} strokeWidth={2} style={{ flexShrink: 0 }} />
              <span>Scenarios</span>
            </div>
            <div className="preview-body" style={{ padding: 0 }}>
              <ScenariosPanel tabId={tabId} hideHeader={true} />
            </div>
          </div>
        )}
        
        {panel === 'properties' && (
          <div className="preview-panel">
            <div className="preview-header">
              <FileText size={14} strokeWidth={2} style={{ flexShrink: 0 }} />
              <span>
                {selectedNodeId 
                  ? 'Node Properties'
                  : selectedEdgeId 
                    ? 'Edge Properties'
                    : 'Graph Properties'
                }
              </span>
            </div>
            <div className="preview-body" style={{ padding: 0 }}>
              <PropertiesPanel
                selectedNodeId={selectedNodeId}
                onSelectedNodeChange={onSelectedNodeChange}
                selectedEdgeId={selectedEdgeId}
                onSelectedEdgeChange={onSelectedEdgeChange}
                tabId={tabId}
              />
            </div>
          </div>
        )}
        
        {panel === 'tools' && (
          <div className="preview-panel">
            <div className="preview-header">
              <Wrench size={14} strokeWidth={2} style={{ flexShrink: 0 }} />
              <span>Tools</span>
            </div>
            <div className="preview-body" style={{ padding: 0 }}>
              <ToolsPanel
                onAutoLayout={onAutoLayout}
                onSankeyLayout={onSankeyLayout}
                onForceReroute={onForceReroute}
                onHideUnselected={onHideUnselected}
                onShowAll={onShowAll}
                hideHeader={true}
              />
            </div>
          </div>
        )}
        
        {panel === 'analytics' && (
          <div className="preview-panel">
            <div className="preview-header">
              <BarChart3 size={14} strokeWidth={2} style={{ flexShrink: 0 }} />
              <span>Analytics</span>
            </div>
            <div className="preview-body" style={{ padding: 0 }}>
              <AnalyticsPanel tabId={tabId} hideHeader={true} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

