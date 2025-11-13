import React from 'react';
import ScenariosPanel from './ScenariosPanel';
import './WhatIfPanel.css';

interface WhatIfPanelProps {
  tabId?: string;
}

/**
 * What-If Panel (now only contains Scenarios)
 * What-If Analysis controls moved to WhatIfContextToolbar (floating toolbar)
 */
export default function WhatIfPanel({ tabId }: WhatIfPanelProps) {
  return (
    <div className="what-if-panel">
      <ScenariosPanel tabId={tabId} />
    </div>
  );
}

