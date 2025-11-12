import React, { useState } from 'react';
import WhatIfAnalysisControl from '../WhatIfAnalysisControl';
import WhatIfAnalysisHeader from '../WhatIfAnalysisHeader';
import ScenariosPanel from './ScenariosPanel';
import CollapsibleSection from '../CollapsibleSection';
import './WhatIfPanel.css';

interface WhatIfPanelProps {
  tabId?: string;
}

/**
 * What-If Analysis Panel
 * Wrapper for WhatIfAnalysisControl and ScenariosPanel for use in rc-dock sidebar
 */
export default function WhatIfPanel({ tabId }: WhatIfPanelProps) {
  const [scenariosExpanded, setScenariosExpanded] = useState(true);
  const [whatIfExpanded, setWhatIfExpanded] = useState(true);
  
  return (
    <div className="what-if-panel">
      {/* Scenarios Section */}
      <CollapsibleSection
        title="Scenarios"
        isOpen={scenariosExpanded}
        onToggle={() => setScenariosExpanded(!scenariosExpanded)}
      >
        <ScenariosPanel tabId={tabId} />
      </CollapsibleSection>
      
      {/* What-If Section */}
      <CollapsibleSection
        title="What-If Analysis"
        isOpen={whatIfExpanded}
        onToggle={() => setWhatIfExpanded(!whatIfExpanded)}
      >
        <div className="panel-header">
          <WhatIfAnalysisHeader tabId={tabId} />
        </div>
        <div className="panel-body">
          <WhatIfAnalysisControl tabId={tabId} />
        </div>
      </CollapsibleSection>
    </div>
  );
}

