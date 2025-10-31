import React from 'react';
import './ToolsPanel.css';

interface ToolsPanelProps {
  // Layout tools
  onAutoLayout?: (direction?: 'LR' | 'RL' | 'TB' | 'BT') => void;
  onForceReroute?: () => void;
  
  // Mass generosity
  massGenerosity: number;
  onMassGenerosityChange: (value: number) => void;
  
  // Scaling
  useUniformScaling: boolean;
  onUniformScalingChange: (value: boolean) => void;
  
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
  massGenerosity,
  onMassGenerosityChange,
  useUniformScaling,
  onUniformScalingChange,
  onHideUnselected,
  onShowAll
}: ToolsPanelProps) {
  return (
    <div className="tools-panel">
      <div className="panel-body">
        {/* Layout Tools */}
        <div className="tools-section">
          <h3>Layout</h3>
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
          
          <div className="tool-control">
            <label htmlFor="mass-generosity">Mass Generosity:</label>
            <input
              id="mass-generosity"
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={massGenerosity}
              onChange={(e) => onMassGenerosityChange(parseFloat(e.target.value))}
            />
            <span className="tool-value">{(massGenerosity * 100).toFixed(0)}%</span>
          </div>
        </div>
        
        {/* Scaling Tools */}
        <div className="tools-section">
          <h3>Scaling</h3>
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={useUniformScaling}
              onChange={(e) => onUniformScalingChange(e.target.checked)}
            />
            <span>Uniform Edge Width</span>
          </label>
        </div>
        
        {/* Visibility Tools */}
        <div className="tools-section">
          <h3>Visibility</h3>
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
        </div>
      </div>
    </div>
  );
}

