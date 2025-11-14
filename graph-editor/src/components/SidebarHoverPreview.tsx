import React from 'react';
import ScenariosPanel from './panels/ScenariosPanel';
import PropertiesPanel from './PropertiesPanel';
import './SidebarHoverPreview.css';

interface SidebarHoverPreviewProps {
  panel: 'what-if' | 'properties' | 'tools' | null;
  tabId?: string;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectedNodeChange: (id: string | null) => void;
  onSelectedEdgeChange: (id: string | null) => void;
  // Tools panel props (Phase 5)
  onAutoLayout?: () => void;
  onForceReroute?: () => void;
  massGenerosity?: number;
  onMassGenerosityChange?: (value: number) => void;
  useUniformScaling?: boolean;
  onUniformScalingChange?: (value: boolean) => void;
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
  onForceReroute,
  massGenerosity = 0.5,
  onMassGenerosityChange,
  useUniformScaling = false,
  onUniformScalingChange,
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
              Scenarios
            </div>
            <div className="preview-body">
              <ScenariosPanel tabId={tabId} />
            </div>
          </div>
        )}
        
        {panel === 'properties' && (
          <div className="preview-panel">
            <div className="preview-header">
              {selectedNodeId 
                ? 'Node Properties'
                : selectedEdgeId 
                  ? 'Edge Properties'
                  : 'Graph Properties'
              }
            </div>
            <div className="preview-body">
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
            <div className="preview-header">🛠️ Tools</div>
            <div className="preview-body">
              {/* Tools Panel - Phase 5 */}
              <div className="tools-section">
                <h3>Layout</h3>
                <button onClick={onAutoLayout} className="tool-button">
                  Auto-Layout
                </button>
                <button onClick={onForceReroute} className="tool-button">
                  Force Re-route
                </button>
                
                <div className="tool-control">
                  <label>Mass Generosity:</label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={massGenerosity}
                    onChange={(e) => onMassGenerosityChange?.(parseFloat(e.target.value))}
                  />
                  <span>{(massGenerosity * 100).toFixed(0)}%</span>
                </div>
              </div>
              
              <div className="tools-section">
                <h3>Scaling</h3>
                <label className="tool-checkbox">
                  <input
                    type="checkbox"
                    checked={useUniformScaling}
                    onChange={(e) => onUniformScalingChange?.(e.target.checked)}
                  />
                  <span>Uniform Edge Width</span>
                </label>
              </div>
              
              <div className="tools-section">
                <h3>Visibility</h3>
                <button onClick={onHideUnselected} className="tool-button">
                  Hide Unselected
                </button>
                <button onClick={onShowAll} className="tool-button">
                  Show All
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

