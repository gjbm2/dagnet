import React from 'react';
import './EdgeScalingControl.css';

interface EdgeScalingControlProps {
  useUniformScaling: boolean;
  massGenerosity: number;
  onUniformScalingChange: (value: boolean) => void;
  onMassGenerosityChange: (value: number) => void;
  className?: string;
}

/**
 * Shared Edge Scaling Control
 * Used in both View Menu and Tools Panel
 * 
 * Controls:
 * - Uniform checkbox: enables/disables uniform edge width
 * - Slider: controls mass generosity (0 = global/Sankey, 1 = local)
 */
export default function EdgeScalingControl({
  useUniformScaling,
  massGenerosity,
  onUniformScalingChange,
  onMassGenerosityChange,
  className = ''
}: EdgeScalingControlProps) {
  
  console.log('[EdgeScalingControl] render:', { useUniformScaling, massGenerosity, className });
  
  return (
    <div className={`edge-scaling-control ${className}`}>
      {/* Uniform Checkbox */}
      <label className="edge-scaling-uniform">
        <input 
          type="checkbox" 
          checked={useUniformScaling} 
          onChange={(e) => {
            console.log('[EdgeScalingControl] checkbox changed to:', e.target.checked);
            onUniformScalingChange(e.target.checked);
          }}
        />
        <span>Uniform</span>
      </label>
      
      <div className="edge-scaling-divider" />
      
      {/* Slider */}
      <div className="edge-scaling-slider">
        <div className="edge-scaling-labels">
          <span>Global</span>
          <span>Local</span>
        </div>
        <input 
          type="range" 
          min="0" 
          max="1" 
          step="0.1"
          value={massGenerosity}
          onChange={(e) => {
            const newValue = parseFloat(e.target.value);
            console.log('[EdgeScalingControl] slider changed to:', newValue);
            onMassGenerosityChange(newValue);
          }}
          disabled={useUniformScaling}
        />
        <div className="edge-scaling-value">
          {(massGenerosity * 100).toFixed(0)}%
        </div>
      </div>
    </div>
  );
}

