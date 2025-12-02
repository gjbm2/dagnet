/**
 * Data Section Submenu
 * 
 * Reusable submenu component for rendering a single data operation section.
 * Used by NodeContextMenu and EdgeContextMenu.
 */

import React from 'react';
import { ChevronRight, Database, DatabaseZap, Folders, TrendingUpDown, X, Trash2, FileText } from 'lucide-react';
import type { DataOperationSection } from './DataOperationsSections';

interface DataSectionSubmenuProps {
  section: DataOperationSection;
  isOpen: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onSubmenuContentEnter: () => void;
  onSubmenuContentLeave: () => void;
  onGetFromFile: (section: DataOperationSection) => void;
  onPutToFile: (section: DataOperationSection) => void;
  onGetFromSource: (section: DataOperationSection) => void;
  onGetFromSourceDirect: (section: DataOperationSection) => void;
  onClearCache: (section: DataOperationSection) => void;
  onClearDataFile: (section: DataOperationSection) => void;
  onOpenFile: (section: DataOperationSection) => void;
}

export const DataSectionSubmenu: React.FC<DataSectionSubmenuProps> = ({
  section,
  isOpen,
  onMouseEnter,
  onMouseLeave,
  onSubmenuContentEnter,
  onSubmenuContentLeave,
  onGetFromFile,
  onPutToFile,
  onGetFromSource,
  onGetFromSourceDirect,
  onClearCache,
  onClearDataFile,
  onOpenFile,
}) => {
  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div
        style={{
          padding: '8px 12px',
          cursor: 'pointer',
          fontSize: '13px',
          borderRadius: '2px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: isOpen ? '#f8f9fa' : 'white'
        }}
      >
        <span>{section.label}</span>
        <ChevronRight size={14} style={{ color: '#666' }} />
      </div>
      
      {isOpen && (
        <div
          style={{
            position: 'absolute',
            left: '100%',
            top: 0,
            background: 'white',
            border: '1px solid #ddd',
            borderRadius: '4px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            minWidth: '200px',
            padding: '4px',
            zIndex: 99999,
            marginLeft: '4px',
            whiteSpace: 'nowrap'
          }}
          onMouseEnter={onSubmenuContentEnter}
          onMouseLeave={onSubmenuContentLeave}
        >
          {/* Open file */}
          <div
            onClick={() => onOpenFile(section)}
            style={{
              padding: '6px 12px',
              cursor: 'pointer',
              fontSize: '13px',
              borderRadius: '2px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '16px'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
          >
            <span>Open file</span>
            <FileText size={12} style={{ color: '#666' }} />
          </div>
          
          {/* Divider after Open file */}
          <div style={{ height: '1px', background: '#eee', margin: '6px 0' }} />
          
          {/* Get from Source (direct) */}
          {section.operations.getFromSourceDirect && (
            <div
              onClick={() => onGetFromSourceDirect(section)}
              style={{
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                borderRadius: '2px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
            >
              <span>Get from Source (direct)</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                <Database size={12} />
                <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                <TrendingUpDown size={12} />
              </div>
            </div>
          )}
          
          {/* Get from Source (versioned) */}
          {section.operations.getFromSource && (
            <div
              onClick={() => onGetFromSource(section)}
              style={{
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                borderRadius: '2px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
            >
              <span>Get from Source</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                <DatabaseZap size={12} />
                <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                <Folders size={12} />
                <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>+</span>
                <TrendingUpDown size={12} />
              </div>
            </div>
          )}
          
          {/* Get from File */}
          {section.operations.getFromFile && (
            <div
              onClick={() => onGetFromFile(section)}
              style={{
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                borderRadius: '2px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
            >
              <span>Get data from file</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                <Folders size={12} />
                <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                <TrendingUpDown size={12} />
              </div>
            </div>
          )}
          
          {/* Put to File */}
          {section.operations.putToFile && (
            <div
              onClick={() => onPutToFile(section)}
              style={{
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                borderRadius: '2px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
            >
              <span>Put data to file</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                <TrendingUpDown size={12} />
                <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                <Folders size={12} />
              </div>
            </div>
          )}
          
          {/* Divider before Unsign cache */}
          {section.operations.clearCache && (
            <div style={{ height: '1px', background: '#eee', margin: '6px 0' }} />
          )}
          
          {/* Unsign cache - only show for parameters with files */}
          {section.operations.clearCache && (
            <div
              onClick={() => onClearCache(section)}
              style={{
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                borderRadius: '2px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
            >
              <span>Unsign file cache</span>
              <X size={12} style={{ color: '#666' }} />
            </div>
          )}
          
          {/* Clear data file - only show for parameters and cases with files */}
          {section.operations.clearDataFile && (
            <div
              onClick={() => onClearDataFile(section)}
              style={{
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                borderRadius: '2px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
            >
              <span>Clear data file</span>
              <Trash2 size={12} style={{ color: '#666' }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

