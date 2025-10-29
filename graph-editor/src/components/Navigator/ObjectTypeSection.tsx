import React from 'react';
import { RepositoryItem, ObjectType } from '../../types';
import { useTabContext, useFileRegistry } from '../../contexts/TabContext';

/**
 * Object Type Section
 * 
 * Accordion section for each object type (Graphs, Parameters, etc.)
 * Shows:
 * - Section header with icon and count
 * - Expand/collapse indicator
 * - List of items when expanded
 */
interface ObjectTypeSectionProps {
  title: string;
  icon: string;
  items: RepositoryItem[];
  sectionType: ObjectType;
  isExpanded: boolean;
  onToggle: () => void;
  onItemClick: (item: RepositoryItem) => void;
  onItemContextMenu?: (item: RepositoryItem, x: number, y: number) => void;
  onSectionContextMenu?: (type: ObjectType, x: number, y: number) => void;
  onIndexClick?: () => void;  // Callback to open index file
  indexIsDirty?: boolean;      // Whether index file is dirty
}

export function ObjectTypeSection({
  title,
  icon,
  items,
  sectionType,
  isExpanded,
  onToggle,
  onItemClick,
  onItemContextMenu,
  onSectionContextMenu,
  onIndexClick,
  indexIsDirty = false
}: ObjectTypeSectionProps) {
  const { tabs } = useTabContext();
  const fileRegistry = useFileRegistry();
  const [, forceUpdate] = React.useReducer(x => x + 1, 0);

  // Subscribe to file changes for all items in this section
  React.useEffect(() => {
    const unsubscribes = items.map(item => {
      const fileId = `${item.type}-${item.id}`;
      return fileRegistry.subscribe(fileId, () => {
        // File changed, force re-render
        forceUpdate();
      });
    });

    return () => {
      unsubscribes.forEach(unsub => unsub());
    };
  }, [items, fileRegistry]);

  // Re-render when tabs change (tabs open/close)
  // This ensures the active/dirty state updates immediately
  React.useEffect(() => {
    // Tabs changed, component will automatically re-render
  }, [tabs]);

  // Check if an item has open tabs
  const getItemStatus = (item: RepositoryItem): { isOpen: boolean; isDirty: boolean; tabCount: number} => {
    const fileId = `${item.type}-${item.id}`;
    const itemTabs = tabs.filter(tab => tab.fileId === fileId);
    const file = fileRegistry.getFile(fileId);
    
    return {
      isOpen: itemTabs.length > 0,
      isDirty: file?.isDirty || false,
      tabCount: itemTabs.length
    };
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
          <span className="section-count">({items.length})</span>
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
              🔍
            </span>
          </div>
        )}
      </div>

      {isExpanded && (
        <div className="section-items">
          {items.length === 0 ? (
            <div className="section-empty">No {title.toLowerCase()} found</div>
          ) : (
            items.map(item => {
              const status = getItemStatus(item);
              return (
                <div
                  key={item.id}
                  className={`navigator-item ${status.isOpen ? 'active' : ''}`}
                  onClick={() => onItemClick(item)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (onItemContextMenu) {
                      onItemContextMenu(item, e.clientX, e.clientY);
                    }
                  }}
                  title={item.isLocal ? `${item.description || item.name} (not committed)` : (item.description || item.name)}
                >
                  <span className={`navigator-item-name ${item.isLocal ? 'local-only' : ''}`}>
                    {item.name.replace(/\.(yaml|yml|json)$/, '')}
                  </span>
                  
                  <span className="navigator-item-status">
                    {/* Visual state indicators */}
                    <span className="status-dots">
                      {status.isDirty && (
                        <span className="status-dot dirty" title="Modified" />
                      )}
                      {status.isOpen && (
                        <span className="status-dot open" title="Open" />
                      )}
                    </span>
                    
                    {/* Tab count for multiple tabs */}
                    {status.tabCount > 1 && (
                      <span style={{ fontSize: '11px', color: '#0066cc', fontWeight: 600 }}>
                        {status.tabCount}
                      </span>
                    )}
                    
                    {/* Local-only badge */}
                    {item.isLocal && (
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

