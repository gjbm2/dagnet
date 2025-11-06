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
import { 
  Zap, 
  DatabaseZap, 
  TrendingUpDown, 
  Folders,
  Settings,
  Activity
} from 'lucide-react';
import { dataOperationsService } from '../services/dataOperationsService';
import './LightningMenu.css';

interface LightningMenuProps {
  objectType: 'parameter' | 'case' | 'node';
  objectId: string;
  hasFile: boolean;
  targetId?: string; // graph element ID (edge, node)
}

export const LightningMenu: React.FC<LightningMenuProps> = ({
  objectType,
  objectId,
  hasFile,
  targetId
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
  
  const handleGetFromFile = () => {
    setIsOpen(false);
    if (objectType === 'parameter') {
      dataOperationsService.getParameterFromFile({ paramId: objectId, edgeId: targetId });
    } else if (objectType === 'case') {
      dataOperationsService.getCaseFromFile({ caseId: objectId, nodeId: targetId });
    } else if (objectType === 'node') {
      dataOperationsService.getNodeFromFile({ nodeId: objectId });
    }
  };
  
  const handlePutToFile = () => {
    setIsOpen(false);
    if (objectType === 'parameter') {
      dataOperationsService.putParameterToFile({ paramId: objectId, edgeId: targetId });
    } else if (objectType === 'case') {
      dataOperationsService.putCaseToFile({ caseId: objectId, nodeId: targetId });
    } else if (objectType === 'node') {
      dataOperationsService.putNodeToFile({ nodeId: objectId });
    }
  };
  
  const handleGetFromSource = () => {
    setIsOpen(false);
    dataOperationsService.getFromSource({ objectType, objectId, targetId });
  };
  
  const handleGetFromSourceDirect = () => {
    setIsOpen(false);
    dataOperationsService.getFromSourceDirect({ objectType, objectId, targetId });
  };
  
  const handleConnectionSettings = () => {
    setIsOpen(false);
    if (objectType === 'parameter' || objectType === 'case') {
      dataOperationsService.openConnectionSettings(objectType, objectId);
    }
  };
  
  const handleSyncStatus = () => {
    setIsOpen(false);
    dataOperationsService.openSyncStatus(objectType, objectId);
  };
  
  const dropdownContent = isOpen && (
    <div 
      ref={menuRef}
      className="lightning-menu-dropdown"
      style={{
        position: 'fixed',
        top: `${dropdownPosition.top}px`,
        left: `${dropdownPosition.left}px`,
        transform: 'translateX(-100%)'
      }}
    >
              {/* Get from File → Graph */}
              <button
                className="lightning-menu-item"
                onClick={handleGetFromFile}
                disabled={!hasFile}
                title={hasFile ? "Get data from file" : "No file connected"}
              >
                <span>Get data from file</span>
            <div className="lightning-menu-item-pathway">
              <Folders size={12} />
              <span className="lightning-menu-pathway">→</span>
              <TrendingUpDown size={12} />
            </div>
          </button>
          
          {/* Get from Source → File + Graph */}
          <button
            className="lightning-menu-item"
            onClick={handleGetFromSource}
            disabled={!hasFile}
            title={hasFile ? "Get data from source (versioned)" : "No file connected"}
          >
            <span>Get data from source</span>
            <div className="lightning-menu-item-pathway">
              <DatabaseZap size={12} />
              <span className="lightning-menu-pathway">→</span>
              <Folders size={12} />
              <span className="lightning-menu-pathway">+</span>
              <TrendingUpDown size={12} />
            </div>
          </button>
          
          {/* Get from Source → Graph (Direct) */}
          <button
            className="lightning-menu-item"
            onClick={handleGetFromSourceDirect}
            title="Get data from source (direct, not versioned)"
          >
            <span>Get data from source (direct)</span>
            <div className="lightning-menu-item-pathway">
              <DatabaseZap size={12} />
              <span className="lightning-menu-pathway">→</span>
              <TrendingUpDown size={12} />
            </div>
          </button>
          
          {/* Put Graph → File */}
          <button
            className="lightning-menu-item"
            onClick={handlePutToFile}
            disabled={!hasFile}
            title={hasFile ? "Put data to file" : "No file connected"}
          >
            <span>Put data to file</span>
            <div className="lightning-menu-item-pathway">
              <TrendingUpDown size={12} />
              <span className="lightning-menu-pathway">→</span>
              <Folders size={12} />
            </div>
          </button>
          
          <div className="lightning-menu-divider" />
          
          {/* Connection Settings (only for param and case) */}
          {(objectType === 'parameter' || objectType === 'case') && (
            <button
              className="lightning-menu-item"
              onClick={handleConnectionSettings}
              disabled={!hasFile}
              title={hasFile ? "Edit connection settings" : "No file connected"}
            >
              <span>Connection settings...</span>
            </button>
          )}
          
          {/* Sync Status */}
          <button
            className="lightning-menu-item"
            onClick={handleSyncStatus}
            title="View sync status"
          >
            <span>Sync status...</span>
          </button>
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

