import React from 'react';
import CollapsibleSection from '../CollapsibleSection';
import EdgeScalingControl from '../EdgeScalingControl';
import { Layout, Maximize2, Eye } from 'lucide-react';
import './ToolsPanel.css';
import { useViewPreferencesContext } from '../../contexts/ViewPreferencesContext';

interface ToolsPanelProps {
  // Layout tools
  onAutoLayout?: (direction?: 'LR' | 'RL' | 'TB' | 'BT') => void;
  onForceReroute?: () => void;
  
  // Visibility
  onHideUnselected?: () => void;
  onShowAll?: () => void;
}

/**
 * Tools Panel
 * Canvas manipulation tools for graph editor
 * 
 * All functionality exists in existing menus - this is just convenient access
 */
export default function ToolsPanel({
  onAutoLayout,
  onForceReroute,
  onHideUnselected,
  onShowAll
}: ToolsPanelProps) {
  const viewPrefs = useViewPreferencesContext();
  if (!viewPrefs) {
    // Should never happen since ToolsPanel is always inside GraphEditor with provider
    console.error('ToolsPanel: ViewPreferencesContext not available');
    return <div className="tools-panel"><div className="panel-body">View preferences not available</div></div>;
  }
  
  const {
    useUniformScaling,
    massGenerosity,
    autoReroute,
    setUseUniformScaling,
    setMassGenerosity,
    setAutoReroute
  } = viewPrefs;
  return (
    <div className="tools-panel">
      <div className="panel-body">
        {/* Layout Tools */}
        <CollapsibleSection title="Layout" defaultOpen={true} icon={Layout}>
          <button 
            onClick={() => onAutoLayout?.('LR')} 
            className="tool-button"
            disabled={!onAutoLayout}
          >
            Auto-Layout →
          </button>
          <button 
            onClick={() => onAutoLayout?.('TB')} 
            className="tool-button"
            disabled={!onAutoLayout}
          >
            Auto-Layout ↓
          </button>
          <button 
            onClick={() => onForceReroute?.()} 
            className="tool-button"
            disabled={!onForceReroute}
          >
            Force Re-route
          </button>
          
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={autoReroute}
              onChange={(e) => setAutoReroute(e.target.checked)}
            />
            <span>Auto Re-route</span>
          </label>
        </CollapsibleSection>
        
        {/* Edge Scaling Tools */}
        <CollapsibleSection title="Edge Scaling" defaultOpen={true} icon={Maximize2}>
          <EdgeScalingControl
            useUniformScaling={useUniformScaling}
            massGenerosity={massGenerosity}
            onUniformScalingChange={setUseUniformScaling}
            onMassGenerosityChange={setMassGenerosity}
          />
        </CollapsibleSection>
        
        {/* Visibility Tools */}
        <CollapsibleSection title="Visibility" defaultOpen={true} icon={Eye}>
          <button 
            onClick={() => onHideUnselected?.()} 
            className="tool-button"
            disabled={!onHideUnselected}
          >
            Hide Unselected
          </button>
          <button 
            onClick={() => onShowAll?.()} 
            className="tool-button"
            disabled={!onShowAll}
          >
            Show All
          </button>
        </CollapsibleSection>
      </div>
    </div>
  );
}

