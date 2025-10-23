import React from 'react';
import { useGraphStore } from '@/lib/useGraphStore';

export default function WhatIfAnalysisHeader() {
  const { whatIfAnalysis, whatIfOverrides, setWhatIfAnalysis, clearAllOverrides } = useGraphStore();

  // Count active overrides (including legacy whatIfAnalysis)
  const activeCount = (whatIfAnalysis ? 1 : 0) + 
                     (whatIfOverrides?.caseOverrides?.size || 0) +
                     (whatIfOverrides?.conditionalOverrides?.size || 0);

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
      <span>
        What-If Analysis{activeCount > 0 && ` (${activeCount} active)`}
      </span>
      {activeCount > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation(); // Prevent section from collapsing
            setWhatIfAnalysis(null);
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
