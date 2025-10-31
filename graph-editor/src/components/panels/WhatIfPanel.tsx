import React from 'react';
import WhatIfAnalysisControl from '../WhatIfAnalysisControl';
import WhatIfAnalysisHeader from '../WhatIfAnalysisHeader';
import './WhatIfPanel.css';

interface WhatIfPanelProps {
  tabId?: string;
}

/**
 * What-If Analysis Panel
 * Wrapper for WhatIfAnalysisControl for use in rc-dock sidebar
 */
export default function WhatIfPanel({ tabId }: WhatIfPanelProps) {
  return (
    <div className="what-if-panel">
      <div className="panel-header">
        <WhatIfAnalysisHeader tabId={tabId} />
      </div>
      <div className="panel-body">
        <WhatIfAnalysisControl tabId={tabId} />
      </div>
    </div>
  );
}

