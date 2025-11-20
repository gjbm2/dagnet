import React from 'react';
import PropertiesPanel from '../PropertiesPanel';
import { useSelectionContext } from '../editors/GraphEditor';
import { FileText } from 'lucide-react';
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
  
  // Determine panel title based on selection
  const title = selectedNodeId 
    ? 'Node Properties'
    : selectedEdgeId 
      ? 'Edge Properties'
      : 'Graph Properties';
  
  return (
    <div className="properties-panel-wrapper">
      <div className="panel-header">
        <FileText size={14} strokeWidth={2} style={{ flexShrink: 0 }} />
        <h3>{title}</h3>
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

