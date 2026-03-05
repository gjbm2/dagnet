import React, { createContext, useContext } from 'react';

export type ElementToolType = 'select' | 'pan' | 'new-node' | 'new-postit' | 'new-container' | null;

export interface ElementToolContextType {
  activeElementTool: ElementToolType;
  setActiveElementTool: (tool: ElementToolType) => void;
  clearElementTool: () => void;
}

const ElementToolContext = createContext<ElementToolContextType>({
  activeElementTool: null,
  setActiveElementTool: () => {},
  clearElementTool: () => {},
});

export function useElementTool(): ElementToolContextType {
  return useContext(ElementToolContext);
}

export function ElementToolProvider({
  value,
  children,
}: {
  value: ElementToolContextType;
  children: React.ReactNode;
}) {
  return <ElementToolContext.Provider value={value}>{children}</ElementToolContext.Provider>;
}

