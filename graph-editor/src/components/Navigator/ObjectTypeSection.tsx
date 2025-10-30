import React from 'react';
import { ObjectType } from '../../types';
import { useTabContext, useFileRegistry } from '../../contexts/TabContext';
import '../../styles/file-state-indicators.css';

/**
 * Navigator Entry - Internal representation
 */
interface NavigatorEntry {
  id: string;
  name: string;
  type: ObjectType;
  hasFile: boolean;
  isLocal: boolean;
  inIndex: boolean;
  isDirty: boolean;
  isOpen: boolean;
  isOrphan: boolean;
  tags?: string[];
  path?: string;
}

interface ObjectTypeSectionProps {
  title: string;
  icon: string;
  entries: NavigatorEntry[];
  sectionType: ObjectType;
  isExpanded: boolean;
  onToggle: () => void;
  onEntryClick: (entry: NavigatorEntry) => void;
  onEntryContextMenu?: (entry: NavigatorEntry, x: number, y: number) => void;
  onSectionContextMenu?: (type: ObjectType, x: number, y: number) => void;
  onIndexClick?: () => void;
  indexIsDirty?: boolean;
}

/**
 * Object Type Section
 * 
 * Renders a collapsible section for each object type with proper visual indicators.
 */
export function ObjectTypeSection({
  title,
  icon,
  entries,
  sectionType,
  isExpanded,
  onToggle,
  onEntryClick,
  onEntryContextMenu,
  onSectionContextMenu,
  onIndexClick,
  indexIsDirty = false
}: ObjectTypeSectionProps) {
  const { tabs } = useTabContext();
  const fileRegistry = useFileRegistry();

  // Get tab count for an entry
  const getTabCount = (entry: NavigatorEntry): number => {
    const fileId = `${entry.type}-${entry.id}`;
    return tabs.filter(t => t.fileId === fileId).length;
  };

  return (
    <div className="object-type-section">
      <div 
        className="section-header"
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (onSectionContextMenu) {
            onSectionContextMenu(sectionType, e.clientX, e.clientY);
          }
        }}
      >
        <div className="section-header-left" onClick={onToggle}>
          <span className="section-expand-icon">
            {isExpanded ? '▼' : '▶'}
          </span>
          <span className="section-icon">{icon}</span>
          <span className="section-title">{title}</span>
          <span className="section-count">({entries.length})</span>
        </div>
        
        {/* Index file icon - only for types that have indexes */}
        {(sectionType === 'parameter' || sectionType === 'context' || sectionType === 'case' || sectionType === 'node') && onIndexClick && (
          <div className="section-header-right">
            <span 
              className={`section-index-icon ${indexIsDirty ? 'dirty' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onIndexClick();
              }}
              title={`Open ${title} Index${indexIsDirty ? ' (modified)' : ''}`}
            >
              📑
            </span>
            {indexIsDirty && <span className="status-dot dirty" style={{ marginLeft: '4px' }} />}
          </div>
        )}
      </div>

      {isExpanded && (
        <div className="section-items">
          {entries.length === 0 ? (
            <div className="section-empty">No {title.toLowerCase()} found</div>
          ) : (
            entries.map(entry => {
              const tabCount = getTabCount(entry);
              const isActive = entry.isOpen && tabs.some(t => t.fileId === `${entry.type}-${entry.id}` && t.id === tabs.find(t => t.fileId === `${entry.type}-${entry.id}`)?.id);
              
              return (
                <div
                  key={`${entry.type}-${entry.id}`}
                  className={`navigator-item ${isActive ? 'active' : ''}`}
                  onClick={() => onEntryClick(entry)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (onEntryContextMenu) {
                      onEntryContextMenu(entry, e.clientX, e.clientY);
                    }
                  }}
                  title={entry.isOrphan ? '⚠️ Orphan file (not in index)' : entry.isLocal ? `${entry.name} (local only)` : entry.name}
                >
                  <span className={`navigator-item-name ${entry.isLocal ? 'local-only' : ''} ${!entry.hasFile ? 'in-index-only' : ''}`}>
                    {entry.name}
                  </span>
                  
                  <span className="navigator-item-status">
                    {/* Status dots */}
                    <span className="status-dots">
                      {entry.isDirty && (
                        <span className="status-dot dirty" title="Modified" />
                      )}
                      {entry.isOpen && (
                        <span className="status-dot open" title="Open" />
                      )}
                    </span>
                    
                    {/* Tab count for multiple tabs */}
                    {tabCount > 1 && (
                      <span className="tab-count" title={`${tabCount} tabs open`}>
                        {tabCount}
                      </span>
                    )}
                    
                    {/* Badges */}
                    {!entry.hasFile && entry.inIndex && (
                      <span className="file-badge create" title="Create file">[create]</span>
                    )}
                    {entry.isOrphan && (
                      <span className="file-badge orphan" title="Orphan file (not in index)">⚠️</span>
                    )}
                    {entry.isLocal && entry.hasFile && (
                      <span className="file-badge local">local</span>
                    )}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
