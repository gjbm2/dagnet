import React from 'react';
import { ObjectType } from '../../types';
import { useTabContext, useFileRegistry } from '../../contexts/TabContext';
import { getObjectTypeTheme } from '../../theme/objectTypeTheme';
import { ChevronRight, FileText, TrendingUp, Coins, Clock, Package, LucideIcon } from 'lucide-react';
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
  // Type-specific properties for sub-categorization
  parameter_type?: 'probability' | 'cost_gbp' | 'cost_time' | 'standard_deviation';
  node_type?: string;
  case_type?: string;
}

interface ObjectTypeSectionProps {
  title: string;
  icon: LucideIcon;
  entries: NavigatorEntry[];
  sectionType: ObjectType;
  isExpanded: boolean;
  onToggle: () => void;
  onEntryClick: (entry: NavigatorEntry) => void;
  onEntryContextMenu?: (entry: NavigatorEntry, x: number, y: number) => void;
  onSectionContextMenu?: (type: ObjectType, x: number, y: number) => void;
  onIndexClick?: () => void;
  indexIsDirty?: boolean;
  groupBySubCategories?: boolean;
}

/**
 * Object Type Section
 * 
 * Renders a collapsible section for each object type with proper visual indicators.
 */
export function ObjectTypeSection({
  title,
  icon: IconComponent,
  entries,
  sectionType,
  isExpanded,
  onToggle,
  onEntryClick,
  onEntryContextMenu,
  onSectionContextMenu,
  onIndexClick,
  indexIsDirty = false,
  groupBySubCategories = false
}: ObjectTypeSectionProps) {
  const { tabs, activeTabId } = useTabContext();
  const fileRegistry = useFileRegistry();
  const [subCategoryStates, setSubCategoryStates] = React.useState<Record<string, boolean>>({});
  const contentRef = React.useRef<HTMLDivElement>(null);
  const sectionRef = React.useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = React.useState<number>(0);
  
  // Get theme colors for this object type
  const theme = getObjectTypeTheme(sectionType);
  
  // Get the fileId of the active tab for comparison
  const activeTab = tabs.find(t => t.id === activeTabId);
  const activeFileId = activeTab?.fileId;
  
  // Scroll to active item when it changes
  React.useEffect(() => {
    if (!activeFileId || !isExpanded) return;
    
    setTimeout(() => {
      // Find the active item element
      const activeElement = sectionRef.current?.querySelector('.navigator-item.active');
      if (!activeElement) return;
      
      // Find the actual scrollable container (the one with overflow: auto)
      let scrollContainer = sectionRef.current?.parentElement;
      while (scrollContainer && scrollContainer !== document.body) {
        const overflowY = window.getComputedStyle(scrollContainer).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') {
          break;
        }
        scrollContainer = scrollContainer.parentElement;
      }
      
      if (!scrollContainer || scrollContainer === document.body) return;
      
      const containerRect = scrollContainer.getBoundingClientRect();
      const elementRect = activeElement.getBoundingClientRect();
      
      // Account for sticky header height (approx 45px)
      const stickyHeaderHeight = 45;
      const effectiveTop = containerRect.top + stickyHeaderHeight;
      
      // Check if element is out of view (accounting for sticky header)
      const isOutOfView = elementRect.top < effectiveTop || 
                         elementRect.bottom > containerRect.bottom;
      
      if (isOutOfView) {
        // Calculate scroll position needed
        const scrollOffset = elementRect.top - effectiveTop;
        scrollContainer.scrollBy({ 
          top: scrollOffset,
          behavior: 'smooth'
        });
      }
    }, 100); // Small delay to ensure DOM is ready
  }, [activeFileId, isExpanded]);

  // Load sub-category collapse states from localStorage
  React.useEffect(() => {
    const saved = localStorage.getItem(`navigator-subcategory-${sectionType}`);
    if (saved) {
      setSubCategoryStates(JSON.parse(saved));
    }
  }, [sectionType]);

  // Measure content height for smooth animation
  React.useEffect(() => {
    if (contentRef.current && isExpanded) {
      // Use a small delay to ensure DOM has updated
      const timeoutId = setTimeout(() => {
        if (contentRef.current) {
          const height = contentRef.current.scrollHeight;
          setContentHeight(height);
          console.log(`[Navigator] ${sectionType} content height:`, height);
        }
      }, 10);
      return () => clearTimeout(timeoutId);
    }
  }, [entries, isExpanded, subCategoryStates, sectionType]);

  // Scroll section into view when expanded
  React.useEffect(() => {
    if (isExpanded && sectionRef.current) {
      // Small delay to allow animation to start
      setTimeout(() => {
        if (sectionRef.current) {
          const rect = sectionRef.current.getBoundingClientRect();
          const isVisible = (
            rect.top >= 0 &&
            rect.bottom <= window.innerHeight
          );
          
          // Only scroll if the section is not fully visible
          if (!isVisible) {
            sectionRef.current.scrollIntoView({ 
              behavior: 'smooth', 
              block: 'nearest'
            });
          }
        }
      }, 50);
    }
  }, [isExpanded]);

  // Save sub-category collapse states to localStorage
  const toggleSubCategory = (subCatName: string) => {
    setSubCategoryStates(prev => {
      const newState = { ...prev, [subCatName]: !prev[subCatName] };
      localStorage.setItem(`navigator-subcategory-${sectionType}`, JSON.stringify(newState));
      return newState;
    });
  };

  // Get tab count for an entry
  const getTabCount = (entry: NavigatorEntry): number => {
    const fileId = `${entry.type}-${entry.id}`;
    return tabs.filter(t => t.fileId === fileId).length;
  };

  // Group entries by sub-category
  const groupedEntries = React.useMemo(() => {
    if (!groupBySubCategories || sectionType !== 'parameter') {
      return { 'all': entries };
    }

    const groups: Record<string, NavigatorEntry[]> = {
      'probability': [],
      'cost_gbp': [],
      'cost_time': [],
      'other': []
    };

    for (const entry of entries) {
      if (entry.parameter_type === 'probability') {
        groups.probability.push(entry);
      } else if (entry.parameter_type === 'cost_gbp') {
        groups.cost_gbp.push(entry);
      } else if (entry.parameter_type === 'cost_time') {
        groups.cost_time.push(entry);
      } else {
        groups.other.push(entry);
      }
    }

    return groups;
  }, [entries, groupBySubCategories, sectionType]);

  // Sub-category display names with icons
  const subCategoryConfig: Record<string, { name: string; icon: React.ElementType }> = {
    'probability': { name: 'Probability', icon: TrendingUp },
    'cost_gbp': { name: 'Cost (GBP)', icon: Coins },
    'cost_time': { name: 'Cost (Time)', icon: Clock },
    'other': { name: 'Other', icon: Package }
  };

  return (
    <div 
      ref={sectionRef} 
      className="object-type-section"
      data-type={sectionType}
      style={{
        '--section-accent-color': theme.accentColor,
        '--section-light-color': theme.lightColor
      } as React.CSSProperties}
    >
      <div 
        className={`section-header ${isExpanded ? 'is-expanded' : ''}`}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (onSectionContextMenu) {
            onSectionContextMenu(sectionType, e.clientX, e.clientY);
          }
        }}
      >
        <div className="section-header-left" onClick={onToggle}>
          <ChevronRight 
            className={`section-expand-icon ${isExpanded ? 'expanded' : ''}`}
            size={14}
            strokeWidth={2}
          />
          <IconComponent 
            className="section-icon" 
            size={16} 
            strokeWidth={2}
            style={{ color: theme.accentColor }}
          />
          <span className="section-title">{title}</span>
          <span className="section-count">{entries.length}</span>
        </div>
        
        {/* Index file icon - only for types that have indexes */}
        {(sectionType === 'parameter' || sectionType === 'context' || sectionType === 'case' || sectionType === 'node') && onIndexClick && (
          <div className="section-header-right">
            <FileText 
              className={`section-index-icon ${indexIsDirty ? 'dirty' : ''}`}
              size={16}
              strokeWidth={2}
              onClick={(e) => {
                e.stopPropagation();
                onIndexClick();
              }}
              aria-label={`Open ${title} Index${indexIsDirty ? ' (modified)' : ''}`}
            />
            {indexIsDirty && <span className="status-dot dirty" style={{ marginLeft: '4px' }} />}
          </div>
        )}
      </div>

      <div 
        ref={contentRef}
        className={`section-items ${isExpanded ? 'expanded' : 'collapsed'}`}
        style={{
          maxHeight: isExpanded ? `${contentHeight}px` : '0px'
        }}
      >
          {entries.length === 0 ? (
            <div className="section-empty">No {title.toLowerCase()} found</div>
          ) : groupBySubCategories && sectionType === 'parameter' ? (
            // Render with sub-categories
            Object.entries(groupedEntries).map(([subCatKey, subCatEntries]) => {
              if (subCatEntries.length === 0) return null;
              const isSubCatExpanded = subCategoryStates[subCatKey] !== false; // Default: expanded
              
              return (
                <div key={subCatKey} className="sub-category">
                  <div 
                    className="sub-category-header"
                    onClick={() => toggleSubCategory(subCatKey)}
                  >
                    <ChevronRight 
                      className={`section-expand-icon ${isSubCatExpanded ? 'expanded' : ''}`}
                      size={14}
                      strokeWidth={2}
                    />
                    {React.createElement(subCategoryConfig[subCatKey].icon, { 
                      size: 14,
                      strokeWidth: 2,
                      style: { flexShrink: 0, marginRight: '4px' }
                    })}
                    <span>{subCategoryConfig[subCatKey].name}</span>
                    <span className="section-count">{subCatEntries.length}</span>
                  </div>
                  
                  {isSubCatExpanded && (
                    <div className="sub-category-items">
                      {subCatEntries.map(entry => {
                        const tabCount = getTabCount(entry);
                        const entryFileId = `${entry.type}-${entry.id}`;
                        const isActive = activeFileId === entryFileId;
                        
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
                            <span className={`navigator-item-name ${entry.isLocal ? 'local-only' : ''} ${!entry.hasFile ? 'in-index-only' : ''} ${entry.isDirty ? 'is-dirty' : entry.isOpen ? 'is-open' : ''}`}>
                              {entry.name}
                            </span>
                            
                            <span className="navigator-item-status">
                              {tabCount > 1 && <span className="tab-count" title={`${tabCount} tabs open`}>{tabCount}</span>}
                              {!entry.hasFile && entry.inIndex && <span className="file-badge create" title="Create file">[create]</span>}
                              {entry.isOrphan && <span className="file-badge orphan" title="Orphan file (not in index)">⚠️</span>}
                              {entry.isLocal && entry.hasFile && <span className="file-badge local">local</span>}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            // Render flat list (no sub-categories)
            entries.map(entry => {
              const tabCount = getTabCount(entry);
              const entryFileId = `${entry.type}-${entry.id}`;
              const isActive = activeFileId === entryFileId;
              
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
                  <span className={`navigator-item-name ${entry.isLocal ? 'local-only' : ''} ${!entry.hasFile ? 'in-index-only' : ''} ${entry.isDirty ? 'is-dirty' : entry.isOpen ? 'is-open' : ''}`}>
                    {entry.name}
                  </span>
                  
                  <span className="navigator-item-status">
                    {tabCount > 1 && <span className="tab-count" title={`${tabCount} tabs open`}>{tabCount}</span>}
                    {!entry.hasFile && entry.inIndex && <span className="file-badge create" title="Create file">[create]</span>}
                    {entry.isOrphan && <span className="file-badge orphan" title="Orphan file (not in index)">⚠️</span>}
                    {entry.isLocal && entry.hasFile && <span className="file-badge local">local</span>}
                  </span>
                </div>
              );
            })
          )}
      </div>
    </div>
  );
}
