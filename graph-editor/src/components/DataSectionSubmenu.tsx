/**
 * Data Section Submenu
 * 
 * Reusable submenu component for rendering a single data operation section.
 * Used by NodeContextMenu and EdgeContextMenu.
 */

import React from 'react';
import { ChevronRight, Camera, Database, DatabaseZap, Folders, TrendingUpDown, X, Trash2, FileText } from 'lucide-react';
import type { DataOperationSection } from './DataOperationsSections';
import '../styles/popup-menu.css';

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
  /** Snapshot count for this section (optional, only for parameters) */
  snapshotCount?: number;
  /** Handler to open Snapshot Manager for this param (optional) */
  onManageSnapshots?: (section: DataOperationSection) => void;
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
  snapshotCount,
  onManageSnapshots,
}) => {
  const hasSnapshots = (snapshotCount ?? 0) > 0;

  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="dagnet-popup-item" style={{ background: isOpen ? undefined : undefined }}>
        <span>{section.label}</span>
        <ChevronRight size={14} className="dagnet-popup-arrow" />
      </div>
      
      {isOpen && (
        <div
          className="dagnet-popup"
          style={{
            position: 'absolute',
            left: '100%',
            top: 0,
            minWidth: '200px',
            zIndex: 99999,
            marginLeft: '4px',
            whiteSpace: 'nowrap'
          }}
          onMouseEnter={onSubmenuContentEnter}
          onMouseLeave={onSubmenuContentLeave}
        >
          {/* Open file */}
          <div className="dagnet-popup-item" onClick={() => onOpenFile(section)}>
            <span>Open file</span>
            <FileText size={12} className="dagnet-popup-hint" />
          </div>
          
          {/* Divider after Open file */}
          <div style={{ height: '1px', background: '#eee', margin: '6px 0' }} />
          
          {/* Get from Source (direct) */}
          {section.operations.getFromSourceDirect && (
            <div
              onClick={() => onGetFromSourceDirect(section)}
            className="dagnet-popup-item"
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
            className="dagnet-popup-item"
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
            className="dagnet-popup-item"
            >
              <span>Get from file</span>
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
            className="dagnet-popup-item"
            >
              <span>Put to file</span>
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
            className="dagnet-popup-item"
            >
              <span>Unsign file cache</span>
              <X size={12} style={{ color: '#666' }} />
            </div>
          )}
          
          {/* Clear data file - only show for parameters and cases with files */}
          {section.operations.clearDataFile && (
            <div
              onClick={() => onClearDataFile(section)}
            className="dagnet-popup-item"
            >
              <span>Clear data file</span>
              <Trash2 size={12} style={{ color: '#666' }} />
            </div>
          )}
          
          {/* Snapshot Manager shortcut */}
          {onManageSnapshots && (
            <div
              className="dagnet-popup-item"
              onClick={() => onManageSnapshots(section)}
              style={{ justifyContent: 'space-between', gap: '16px' }}
            >
              <span>Manage{hasSnapshots ? ` (${snapshotCount})` : ''} matching snapshots…</span>
              <Camera size={12} style={{ color: '#666' }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

