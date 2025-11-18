/**
 * Lightning Menu Component
 * 
 * Dropdown menu triggered by ⚡ button in EnhancedSelector.
 * Shows data operations (Get/Put) with pathway visualizations.
 * 
 * Visual Language:
 * - Zap (filled): Connected to file
 * - Zap (stroke): Not connected to file
 * - Pathway icons: DatabaseZap → TrendingUpDown (source → graph)
 */

import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Zap } from 'lucide-react';
import { DataOperationsMenu } from './DataOperationsMenu';
import './LightningMenu.css';

interface LightningMenuProps {
  objectType: 'parameter' | 'case' | 'node' | 'event';
  objectId: string;
  hasFile: boolean;
  targetId?: string; // graph element ID (edge, node)
  graph: any; // Tab-specific graph
  setGraph: (graph: any) => void; // Tab-specific graph setter
  // For direct parameter references (no param file)
  paramSlot?: 'p' | 'cost_gbp' | 'cost_time'; // Which parameter on edge
  conditionalIndex?: number; // Which conditional_p in array
  window?: { start: string; end: string } | null; // Window selector state
}

export const LightningMenu: React.FC<LightningMenuProps> = ({
  objectType,
  objectId,
  hasFile,
  targetId,
  graph,
  setGraph,
  paramSlot,
  conditionalIndex,
  window
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  
  // Update dropdown position when opened
  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + 4,
        left: rect.right
      });
    }
  }, [isOpen]);
  
  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node) &&
          buttonRef.current && !buttonRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);
  
  const dropdownContent = isOpen && (
    <div 
      ref={menuRef}
      style={{
        position: 'fixed',
        top: `${dropdownPosition.top}px`,
        left: `${dropdownPosition.left}px`,
        transform: 'translateX(-100%)',
        zIndex: 99999
      }}
    >
      <DataOperationsMenu
        objectType={objectType}
        objectId={objectId}
        hasFile={hasFile}
        targetId={targetId}
        graph={graph}
        setGraph={setGraph}
        paramSlot={paramSlot}
        conditionalIndex={conditionalIndex}
        window={window}
        mode="dropdown"
        showConnectionSettings={true}
        showSyncStatus={true}
        onClose={() => setIsOpen(false)}
      />
    </div>
  );
  
  return (
    <>
      <button
        ref={buttonRef}
        className="lightning-menu-button"
        onClick={() => setIsOpen(!isOpen)}
        title="Data operations"
      >
        {hasFile ? (
          <Zap size={14} fill="currentColor" />
        ) : (
          <Zap size={14} strokeWidth={2} />
        )}
      </button>
      
      {isOpen && createPortal(dropdownContent, document.body)}
    </>
  );
};

