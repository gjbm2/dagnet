import React, { useState } from 'react';
import { SidebarState } from '../hooks/useSidebarState';
import './SidebarIconBar.css';

interface SidebarIconBarProps {
  state: SidebarState;
  onIconClick: (panel: 'what-if' | 'properties' | 'tools') => void;
  onIconHover: (panel: 'what-if' | 'properties' | 'tools' | null) => void;
}

/**
 * Sidebar Icon Bar Component
 * 
 * 48px wide vertical bar on right edge showing 3 icons
 * Visible only when sidebar is in 'minimized' mode
 */
export default function SidebarIconBar({ state, onIconClick, onIconHover }: SidebarIconBarProps) {
  const [hoveredIcon, setHoveredIcon] = useState<'what-if' | 'properties' | 'tools' | null>(null);
  
  const handleMouseEnter = (panel: 'what-if' | 'properties' | 'tools') => {
    // Only allow hover when actually minimized (not transitioning, not maximized)
    if (state.mode !== 'minimized' || state.isTransitioning) return;
    
    setHoveredIcon(panel);
    onIconHover(panel);
  };
  
  const handleMouseLeave = () => {
    // Clear hover state when mouse leaves icon bar
    setHoveredIcon(null);
    onIconHover(null);
  };
  
  // Clear hover when sidebar is not minimized
  React.useEffect(() => {
    if (state.mode !== 'minimized' && hoveredIcon) {
      setHoveredIcon(null);
      onIconHover(null);
    }
  }, [state.mode, hoveredIcon, onIconHover]);
  
  const handleClick = (panel: 'what-if' | 'properties' | 'tools') => {
    onIconClick(panel);
  };
  
  const getIconState = (panel: 'what-if' | 'properties' | 'tools') => {
    const isFloating = state.floatingPanels.includes(panel);
    const isHovered = hoveredIcon === panel;
    
    return {
      isFloating,
      isHovered,
      className: `sidebar-icon ${isFloating ? 'floating' : ''} ${isHovered ? 'hovered' : ''}`
    };
  };
  
  return (
    <div className="sidebar-icon-bar">
      {/* What-If Icon */}
      <button
        className={getIconState('what-if').className}
        onClick={() => handleClick('what-if')}
        onMouseEnter={() => handleMouseEnter('what-if')}
        onMouseLeave={handleMouseLeave}
        title="What-If Analysis (Ctrl/Cmd + Shift + W)"
        aria-label="Open What-If Analysis"
      >
        <span className="icon">🎭</span>
        {state.floatingPanels.includes('what-if') && (
          <span className="floating-indicator">↗</span>
        )}
      </button>
      
      {/* Properties Icon */}
      <button
        className={getIconState('properties').className}
        onClick={() => handleClick('properties')}
        onMouseEnter={() => handleMouseEnter('properties')}
        onMouseLeave={handleMouseLeave}
        title="Props (Ctrl/Cmd + Shift + P)"
        aria-label="Open Properties Panel"
      >
        <span className="icon">📝</span>
        {state.floatingPanels.includes('properties') && (
          <span className="floating-indicator">↗</span>
        )}
      </button>
      
      {/* Tools Icon */}
      <button
        className={getIconState('tools').className}
        onClick={() => handleClick('tools')}
        onMouseEnter={() => handleMouseEnter('tools')}
        onMouseLeave={handleMouseLeave}
        title="Tools (Ctrl/Cmd + Shift + T)"
        aria-label="Open Tools Panel"
      >
        <span className="icon">🛠️</span>
        {state.floatingPanels.includes('tools') && (
          <span className="floating-indicator">↗</span>
        )}
      </button>
    </div>
  );
}

