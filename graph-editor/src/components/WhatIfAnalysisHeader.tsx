import React from 'react';
import { useTabContext } from '../contexts/TabContext';

interface WhatIfAnalysisHeaderProps {
  tabId?: string;
}

export default function WhatIfAnalysisHeader({ tabId }: WhatIfAnalysisHeaderProps) {
  const { operations, tabs } = useTabContext();
  
  // Use the specific tabId passed as prop, or fall back to activeTabId for backward compatibility
  const targetTabId = tabId || tabs.find(tab => tab.isActive)?.id;
  
  // Get current tab's editor state
  const targetTab = tabs.find(tab => tab.id === targetTabId);
  const editorState = targetTab?.editorState;
  
  const whatIfAnalysis = editorState?.whatIfAnalysis;
  const caseOverrides = editorState?.caseOverrides || {};
  const conditionalOverrides = editorState?.conditionalOverrides || {};

  // Count active overrides (including legacy whatIfAnalysis)
  const activeCount = (whatIfAnalysis ? 1 : 0) + 
                     Object.keys(caseOverrides).length +
                     Object.keys(conditionalOverrides).length;

  const clearAllOverrides = () => {
    if (targetTabId) {
      operations.updateTabState(targetTabId, {
        whatIfAnalysis: null,
        caseOverrides: {},
        conditionalOverrides: {}
      });
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
      <span>
        What-If Analysis{activeCount > 0 && ` (${activeCount} active)`}
      </span>
      {activeCount > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation(); // Prevent section from collapsing
            clearAllOverrides();
          }}
          style={{
            padding: '4px 8px',
            fontSize: '12px',
            background: '#dc3545',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: '500'
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}
