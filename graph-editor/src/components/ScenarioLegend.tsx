/**
 * ScenarioLegend
 * 
 * Floating legend showing all scenarios with visibility toggles and delete buttons.
 * Positioned below the window panel on the graph canvas.
 * 
 * Now rendered INSIDE the canvas panel content, so it naturally uses the canvas width
 * without needing complex JavaScript width calculations.
 */

import React, { useCallback, useState } from 'react';
import { Scenario } from '../types/scenarios';
import { Eye, EyeOff, X, Plus } from 'lucide-react';
import './ScenarioLegend.css';

interface ScenarioLegendProps {
  scenarios: Scenario[];
  scenarioOrder: string[];
  visibleScenarioIds: string[];
  currentColour: string;
  baseColour: string;
  showCurrent: boolean;
  showBase: boolean;
  onToggleVisibility: (scenarioId: string) => void;
  onDelete: (scenarioId: string) => void;
  onNewScenario?: () => void;
}

export function ScenarioLegend({
  scenarios,
  scenarioOrder,
  visibleScenarioIds,
  currentColour,
  baseColour,
  showCurrent,
  showBase,
  onToggleVisibility,
  onDelete,
  onNewScenario
}: ScenarioLegendProps) {
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  
  // Count visible scenarios (user scenarios + current/base if visible)
  const visibleCount = visibleScenarioIds.length;
  // Show chips if there are any scenarios (visible or not) or if current/base are shown
  const shouldShowChips = scenarios.length > 0 || visibleCount > 0;
  
  /**
   * Get effective colour for a scenario (with single-layer grey override)
   * Only the sole VISIBLE layer is shown in grey; hidden layers retain their assigned colour.
   */
  const getScenarioColour = useCallback((scenarioId: string, isVisible: boolean = true): string => {
    // Single-layer grey override: ONLY apply to the visible layer when exactly 1 layer is visible
    if (isVisible && visibleScenarioIds.length === 1) {
      return '#808080';
    }
    
    // Get stored colour (for both visible and hidden layers)
    if (scenarioId === 'current') {
      return currentColour;
    } else if (scenarioId === 'base') {
      return baseColour;
    } else {
      const scenario = scenarios.find(s => s.id === scenarioId);
      return scenario?.colour || '#808080';
  }
  }, [visibleScenarioIds.length, currentColour, baseColour, scenarios]);
  
  // Derive tab-specific order for user scenarios (excluding base/current)
  const orderedUserScenarios: Scenario[] = (scenarioOrder.length > 0
    ? scenarioOrder
        .filter(id => id !== 'current' && id !== 'base')
        .map(id => scenarios.find(s => s.id === id))
        .filter((s): s is Scenario => s !== undefined)
    : scenarios
  );

  // Width is now handled by CSS - legend is inside canvas panel so it uses parent width naturally
  return (
    <div className="scenario-legend">
      {/* Order chips from bottom of stack (left) to top of stack (right) */}
      {/* Bottom: Original -> User Scenarios (reverse order) -> Current (top) */}
      
      {/* 1. Original (base) - bottom of stack, leftmost */}
      {shouldShowChips && showBase && (
        <div
          key="base"
          className={`scenario-legend-chip ${!visibleScenarioIds.includes('base') ? 'invisible' : ''}`}
          style={{
            backgroundColor: getScenarioColour('base', visibleScenarioIds.includes('base')),
            opacity: visibleScenarioIds.includes('base') ? 1 : 0.3
          }}
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent('dagnet:openScenariosPanel'));
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('dagnet:scenarioContextMenu', {
              detail: { x: e.clientX, y: e.clientY, scenarioId: 'base' }
            }));
          }}
        >
          <button
            className="scenario-legend-toggle"
            onClick={(e) => {
              e.stopPropagation();
              onToggleVisibility('base');
            }}
            title={visibleScenarioIds.includes('base') ? 'Hide Original' : 'Show Original'}
          >
            {visibleScenarioIds.includes('base') ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
          
          <span className="scenario-legend-name">Original</span>
          
          <div style={{ width: 20 }} />
        </div>
      )}
      
      {/* 2. User Scenarios - show ALL scenarios in tab-specific layer order */}
      {/* Use scenarioOrder (per-tab), reversed so left = bottom of stack, right = top */}
      {shouldShowChips && [...orderedUserScenarios]
        .reverse()
        .map(scenario => {
        const isVisible = visibleScenarioIds.includes(scenario.id);
        const colour = getScenarioColour(scenario.id, isVisible);
        
        return (
          <div
            key={scenario.id}
            className={`scenario-legend-chip ${!isVisible ? 'invisible' : ''} ${deletingIds.includes(scenario.id) ? 'deleting' : ''}`}
            style={{
              backgroundColor: colour,
              opacity: isVisible ? 1 : 0.3
            }}
            onClick={(e) => {
              e.stopPropagation();
              // Focus scenarios panel (same pattern as properties panel)
              window.dispatchEvent(new CustomEvent('dagnet:openScenariosPanel'));
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              window.dispatchEvent(new CustomEvent('dagnet:scenarioContextMenu', {
                detail: { x: e.clientX, y: e.clientY, scenarioId: scenario.id }
              }));
            }}
          >
            <button
              className="scenario-legend-toggle"
              onClick={(e) => {
                e.stopPropagation();
                onToggleVisibility(scenario.id);
              }}
              title={isVisible ? 'Hide scenario' : 'Show scenario'}
            >
              {isVisible ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
            
            <span className="scenario-legend-name">{scenario.name}</span>
            
            <button
              className="scenario-legend-delete"
              onClick={(e) => {
                e.stopPropagation();
                // Mark as deleting to trigger shrink animation, then actually delete
                setDeletingIds(prev => prev.includes(scenario.id) ? prev : [...prev, scenario.id]);
                setTimeout(() => {
                  onDelete(scenario.id);
                }, 280);
              }}
              title="Delete scenario"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
      
      {/* 3. Current - top of stack, rightmost (before new button) */}
      {shouldShowChips && showCurrent && (
        <div
          key="current"
          className={`scenario-legend-chip ${!visibleScenarioIds.includes('current') ? 'invisible' : ''}`}
          style={{
            backgroundColor: getScenarioColour('current', visibleScenarioIds.includes('current')),
            opacity: visibleScenarioIds.includes('current') ? 1 : 0.3
          }}
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent('dagnet:openScenariosPanel'));
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('dagnet:scenarioContextMenu', {
              detail: { x: e.clientX, y: e.clientY, scenarioId: 'current' }
            }));
          }}
        >
          <button
            className="scenario-legend-toggle"
            onClick={(e) => {
              e.stopPropagation();
              onToggleVisibility('current');
            }}
            title={visibleScenarioIds.includes('current') ? 'Hide Current' : 'Show Current'}
          >
            {visibleScenarioIds.includes('current') ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
          
          <span className="scenario-legend-name">Current</span>
          
          <div style={{ width: 20 }} />
        </div>
      )}
      
      {/* New Scenario button - wrapper reserves expanded width, chip visually expands on hover */}
      {onNewScenario && (
        <span className="scenario-legend-new-wrapper">
          {/* Invisible spacer to reserve full expanded width */}
          <span className="scenario-legend-new-spacer" aria-hidden="true">
            <Plus size={16} />
            <span>New scenario</span>
          </span>
          {/* Actual visible button */}
          <button
            className="scenario-legend-chip scenario-legend-new"
            onClick={onNewScenario}
            title={scenarios.length >= 15 ? 'Maximum scenarios reached' : 'New scenario'}
            disabled={scenarios.length >= 15}
            style={{ opacity: scenarios.length >= 15 ? 0.5 : 1 }}
          >
            <Plus size={16} />
            <span className="scenario-legend-new-text">New scenario</span>
          </button>
        </span>
      )}
    </div>
  );
}

