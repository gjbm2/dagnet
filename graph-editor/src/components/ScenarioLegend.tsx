/**
 * ScenarioLegend
 * 
 * Floating legend showing all scenarios with visibility toggles and delete buttons.
 * Positioned below the window panel on the graph canvas.
 */

import React, { useCallback } from 'react';
import { Scenario } from '../types/scenarios';
import { Eye, EyeOff, X } from 'lucide-react';
import './ScenarioLegend.css';

interface ScenarioLegendProps {
  scenarios: Scenario[];
  visibleScenarioIds: string[];
  colorMap: Map<string, string>;
  showCurrent: boolean;
  onToggleVisibility: (scenarioId: string) => void;
  onDelete: (scenarioId: string) => void;
}

export function ScenarioLegend({
  scenarios,
  visibleScenarioIds,
  colorMap,
  showCurrent,
  onToggleVisibility,
  onDelete
}: ScenarioLegendProps) {
  // Don't show if no scenarios (excluding Base and Current)
  if (scenarios.length === 0) {
    return null;
  }

  return (
    <div className="scenario-legend">
      {/* Show Current chip if requested (when >1 user-created scenario) */}
      {showCurrent && (
        <div
          className={`scenario-legend-chip ${!visibleScenarioIds.includes('current') ? 'invisible' : ''}`}
          style={{
            backgroundColor: colorMap.get('current') || '#808080',
            opacity: visibleScenarioIds.includes('current') ? 1 : 0.2
          }}
        >
          <button
            className="scenario-legend-toggle"
            onClick={() => onToggleVisibility('current')}
            title={visibleScenarioIds.includes('current') ? 'Hide Current' : 'Show Current'}
          >
            {visibleScenarioIds.includes('current') ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
          
          <span className="scenario-legend-name">Current</span>
          
          {/* No delete button for Current */}
          <div style={{ width: 20 }} />
        </div>
      )}
      
      {scenarios.map(scenario => {
        const isVisible = visibleScenarioIds.includes(scenario.id);
        const color = colorMap.get(scenario.id) || scenario.color;
        
        return (
          <div
            key={scenario.id}
            className={`scenario-legend-chip ${!isVisible ? 'invisible' : ''}`}
            style={{
              backgroundColor: color,
              opacity: isVisible ? 1 : 0.2
            }}
          >
            <button
              className="scenario-legend-toggle"
              onClick={() => onToggleVisibility(scenario.id)}
              title={isVisible ? 'Hide scenario' : 'Show scenario'}
            >
              {isVisible ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
            
            <span className="scenario-legend-name">{scenario.name}</span>
            
            <button
              className="scenario-legend-delete"
              onClick={() => onDelete(scenario.id)}
              title="Delete scenario"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

