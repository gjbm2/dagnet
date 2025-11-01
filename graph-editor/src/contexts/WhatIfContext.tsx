import React, { createContext, useContext } from 'react';

export interface WhatIfState {
  whatIfAnalysis?: any;
  caseOverrides?: Record<string, string>;
  conditionalOverrides?: Record<string, Set<string>>;
  // Optional mutators (provided by provider owner)
  setWhatIfAnalysis?: (analysis: any) => void;
  setCaseOverride?: (nodeId: string, variantName: string | null) => void;
  setConditionalOverride?: (edgeId: string, value: Set<string> | null) => void;
  clearAllOverrides?: () => void;
}

const WhatIfContext = createContext<WhatIfState | null>(null);

export function WhatIfProvider({ value, children }: { value: WhatIfState; children: React.ReactNode }) {
  return (
    <WhatIfContext.Provider value={value}>
      {children}
    </WhatIfContext.Provider>
  );
}

export function useWhatIfContext(): WhatIfState | null {
  return useContext(WhatIfContext);
}


