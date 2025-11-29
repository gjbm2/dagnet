import React from 'react';
import CollapsibleSection from '../CollapsibleSection';
import EdgeScalingControl from '../EdgeScalingControl';
import { Layout, Maximize2, Eye, Wrench } from 'lucide-react';
import './ToolsPanel.css';
import { useViewPreferencesContext } from '../../contexts/ViewPreferencesContext';

interface ToolsPanelProps {
  // Layout tools
  onAutoLayout?: (direction?: 'LR' | 'RL' | 'TB' | 'BT') => void;
  onSankeyLayout?: () => void;
  onForceReroute?: () => void;
  
  // Visibility
  onHideUnselected?: () => void;
  onShowAll?: () => void;
  
  // Hide header when used in hover preview
  hideHeader?: boolean;
}

/**
 * Tools Panel
 * Canvas manipulation tools for graph editor
 * 
 * All functionality exists in existing menus - this is just convenient access
 */
export default function ToolsPanel({
  onAutoLayout,
  onSankeyLayout,
  onForceReroute,
  onHideUnselected,
  onShowAll,
  hideHeader = false
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
    useSankeyView,
    confidenceIntervalLevel,
    animateFlow,
    setUseUniformScaling,
    setMassGenerosity,
    setAutoReroute,
    setUseSankeyView,
    setConfidenceIntervalLevel,
    setAnimateFlow
  } = viewPrefs;
  return (
    <div className="tools-panel">
      {!hideHeader && (
        <div className="panel-header">
          <Wrench size={14} strokeWidth={2} style={{ flexShrink: 0 }} />
          <span>Tools</span>
        </div>
      )}
      <div className="panel-body">
        {/* Layout Tools */}
        <CollapsibleSection title="Layout" defaultOpen={true} icon={Layout}>
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={useSankeyView}
              onChange={(e) => setUseSankeyView(e.target.checked)}
            />
            <span>Sankey View</span>
          </label>
          
          <label className="tool-checkbox">
            <input
              type="checkbox"
              checked={animateFlow}
              onChange={(e) => setAnimateFlow(e.target.checked)}
            />
            <span>Animate Flow</span>
          </label>
          
          {useSankeyView ? (
            <button 
              onClick={() => onSankeyLayout?.()} 
              className="tool-button"
              disabled={!onSankeyLayout}
            >
              Sankey Layout
            </button>
          ) : (
            <>
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
            </>
          )}
          
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
        
        {/* Confidence Intervals */}
        <CollapsibleSection title="Confidence Intervals" defaultOpen={true} icon={Eye}>
          <div className="confidence-intervals-control">
            <label className="tool-radio">
              <input
                type="radio"
                name="confidence-interval"
                value="none"
                checked={confidenceIntervalLevel === 'none'}
                onChange={() => setConfidenceIntervalLevel('none')}
              />
              <span>None</span>
            </label>
            <label className="tool-radio">
              <input
                type="radio"
                name="confidence-interval"
                value="80"
                checked={confidenceIntervalLevel === '80'}
                onChange={() => setConfidenceIntervalLevel('80')}
              />
              <span>80%</span>
            </label>
            <label className="tool-radio">
              <input
                type="radio"
                name="confidence-interval"
                value="90"
                checked={confidenceIntervalLevel === '90'}
                onChange={() => setConfidenceIntervalLevel('90')}
              />
              <span>90%</span>
            </label>
            <label className="tool-radio">
              <input
                type="radio"
                name="confidence-interval"
                value="95"
                checked={confidenceIntervalLevel === '95'}
                onChange={() => setConfidenceIntervalLevel('95')}
              />
              <span>95%</span>
            </label>
            <label className="tool-radio">
              <input
                type="radio"
                name="confidence-interval"
                value="99"
                checked={confidenceIntervalLevel === '99'}
                onChange={() => setConfidenceIntervalLevel('99')}
              />
              <span>99%</span>
            </label>
          </div>
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

