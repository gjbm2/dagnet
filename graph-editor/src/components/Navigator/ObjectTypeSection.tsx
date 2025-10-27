import React from 'react';
import { RepositoryItem } from '../../types';
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
  isExpanded: boolean;
  onToggle: () => void;
  onItemClick: (item: RepositoryItem) => void;
}

export function ObjectTypeSection({
  title,
  icon,
  items,
  isExpanded,
  onToggle,
  onItemClick
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
        onClick={onToggle}
      >
        <span className="section-expand-icon">
          {isExpanded ? '▼' : '▶'}
        </span>
        <span className="section-icon">{icon}</span>
        <span className="section-title">{title}</span>
        <span className="section-count">({items.length})</span>
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
                  className={`section-item ${status.isOpen ? 'active' : ''} ${status.isDirty ? 'dirty' : ''}`}
                  onClick={() => onItemClick(item)}
                  title={item.description || item.name}
                >
                  <span className="item-name">{item.name}</span>
                  
                  <span className="item-status">
                    {status.isDirty && (
                      <span className="item-dirty" title="Modified">●</span>
                    )}
                    {status.isOpen && (
                      <>
                        {status.tabCount > 1 ? (
                          <span className="item-multi-tab">●{status.tabCount}</span>
                        ) : (
                          <span className="item-open">●</span>
                        )}
                      </>
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

