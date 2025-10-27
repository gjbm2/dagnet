import React from 'react';
import { useNavigatorContext } from '../../contexts/NavigatorContext';

/**
 * Navigator Header
 * 
 * Appears inline with tab bar when navigator is open
 * Contains:
 * - Search input
 * - Pin button
 * - Close button
 * - Collapse/Expand button
 */
export function NavigatorHeader() {
  const { state, operations } = useNavigatorContext();

  return (
    <div className="navigator-header">
      <div className="navigator-search">
        <input
          type="text"
          placeholder="🔍 Search..."
          value={state.searchQuery}
          onChange={(e) => operations.setSearchQuery(e.target.value)}
          className="navigator-search-input"
        />
      </div>

      <div className="navigator-controls">
        <button
          className={`navigator-control-btn ${state.isPinned ? 'active' : ''}`}
          onClick={operations.togglePin}
          title={state.isPinned ? 'Unpin Navigator' : 'Pin Navigator'}
        >
          📌
        </button>

        <button
          className="navigator-control-btn"
          onClick={operations.toggleNavigator}
          title="Close Navigator"
        >
          ×
        </button>
      </div>
    </div>
  );
}

