import React, { useState, useCallback, useRef, useEffect, createContext, useContext, useMemo } from 'react';
import { ObjectType } from '../../types';
import { useTabContext, useFileRegistry } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { getObjectTypeTheme } from '../../theme/objectTypeTheme';
import { AtSign, ChevronRight, FileText, TrendingUp, Coins, Clock, Package, LucideIcon } from 'lucide-react';
import { WhereUsedService } from '../../services/whereUsedService';
import { historicalFileService } from '../../services/historicalFileService';
import '../../styles/file-state-indicators.css';

/**
 * Navigator Entry - Internal representation
 */
export interface NavigatorEntry {
  id: string;
  fileId: string; // Full fileId (e.g., 'node-household-created') used as unique key
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
  lastModified?: number;
  lastOpened?: number;
  // Type-specific properties for sub-categorization
  parameter_type?: 'probability' | 'cost_gbp' | 'labour_cost' | 'standard_deviation';
  node_type?: string;
  case_type?: string;
}

// ============================================================================
// ENTRIES REGISTRY - Single source of truth for all navigator entries
// ============================================================================

/**
 * Context to provide stable entry lookup.
 * This avoids passing entries through props/closures which can become stale.
 */
interface EntriesRegistryContextValue {
  getEntry: (fileId: string) => NavigatorEntry | undefined;
  onItemClick: (fileId: string) => void;
  onItemContextMenu: (fileId: string, event: React.MouseEvent) => void;
}

const EntriesRegistryContext = createContext<EntriesRegistryContextValue | null>(null);

export function EntriesRegistryProvider({ 
  entries, 
  onEntryClick, 
  onEntryContextMenu,
  children 
}: { 
  entries: NavigatorEntry[];
  onEntryClick: (entry: NavigatorEntry) => void;
  onEntryContextMenu?: (entry: NavigatorEntry, event: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  // IMPORTANT:
  // Build the lookup map synchronously during render.
  // Doing this in useEffect causes a transient render where NavigatorItem can't find any entries
  // (it returns null), which manifests as "navigator empties then reappears" during init.
  const entriesMap = useMemo(() => {
    const m = new Map<string, NavigatorEntry>();
    for (const entry of entries) {
      m.set(entry.fileId, entry);
    }
    return m;
  }, [entries]);
  
  const getEntry = useCallback((fileId: string): NavigatorEntry | undefined => {
    return entriesMap.get(fileId);
  }, [entriesMap]);
  
  const handleItemClick = useCallback((fileId: string) => {
    const entry = entriesMap.get(fileId);
    if (entry) {
      onEntryClick(entry);
    } else {
      // This can happen transiently during initial loads / navigator refresh.
      // Avoid spamming console.error (it looks like a crash when it isn't).
      console.warn(`[EntriesRegistry] No entry found for fileId: ${fileId}`);
    }
  }, [onEntryClick, entriesMap]);
  
  const handleItemContextMenu = useCallback((fileId: string, event: React.MouseEvent) => {
    const entry = entriesMap.get(fileId);
    if (entry && onEntryContextMenu) {
      onEntryContextMenu(entry, event);
    }
  }, [onEntryContextMenu, entriesMap]);
  
  const value: EntriesRegistryContextValue = {
    getEntry,
    onItemClick: handleItemClick,
    onItemContextMenu: handleItemContextMenu,
  };
  
  return (
    <EntriesRegistryContext.Provider value={value}>
      {children}
    </EntriesRegistryContext.Provider>
  );
}

function useEntriesRegistry() {
  const ctx = useContext(EntriesRegistryContext);
  if (!ctx) {
    throw new Error('useEntriesRegistry must be used within EntriesRegistryProvider');
  }
  return ctx;
}

// ============================================================================
// NAVIGATOR ITEM - Simple component that only knows its fileId
// ============================================================================

interface NavigatorItemProps {
  fileId: string;
  isActive: boolean;
  tabCount: number;
}

// Cache for where-used tooltips to avoid repeated fetches
const tooltipCache = new Map<string, string>();
const missingEntryWarned = new Set<string>();

function NavigatorItem({ fileId, isActive, tabCount }: NavigatorItemProps) {
  const { getEntry, onItemClick, onItemContextMenu } = useEntriesRegistry();
  const { operations: navOps } = useNavigatorContext();
  const [tooltip, setTooltip] = useState<string | null>(null);
  const [isHovering, setIsHovering] = useState(false);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const fetchedRef = useRef(false);
  const fileRegistry = useFileRegistry();
  
  // Get entry data fresh from the registry
  const entry = getEntry(fileId);
  
  // Compute values that depend on entry (but hooks must still be called)
  const baseTooltip = entry ? `${entry.name}${entry.path ? `\n${entry.path}` : ''}` : '';
  
  // Function to fetch where-used information
  const fetchWhereUsed = useCallback(async () => {
    if (fetchedRef.current) return;
    if (!entry) return;
    
    // Only fetch for parameters, nodes, and events
    if (!['parameter', 'node', 'event'].includes(entry.type)) return;
    
    // Check cache first
    if (tooltipCache.has(fileId)) {
      setTooltip(tooltipCache.get(fileId)!);
      return;
    }
    
    try {
      const result = await WhereUsedService.getTooltipSummary(fileId);
      const currentBaseTooltip = `${entry.name}${entry.path ? `\n${entry.path}` : ''}`;
      
      // getTooltipSummary already includes the usage info in result.tooltip
      // Prepend the entry name/path to it
      const newTooltip = `${currentBaseTooltip}\n\n${result.tooltip}`;
      tooltipCache.set(fileId, newTooltip);
      setTooltip(newTooltip);
    } catch (error) {
      // Silently fail - use base tooltip
    }
    
    fetchedRef.current = true;
  }, [fileId, entry, fileRegistry]);
  
  const handleMouseEnter = useCallback(() => {
    setIsHovering(true);
    
    // Delay fetch to avoid unnecessary API calls on quick hovers
    if (!fetchedRef.current && !hoverTimeoutRef.current) {
      hoverTimeoutRef.current = setTimeout(() => {
        fetchWhereUsed();
        hoverTimeoutRef.current = null;
      }, 300);
    }
  }, [fetchWhereUsed]);
  
  const handleMouseLeave = useCallback(() => {
    setIsHovering(false);
    
    // Cancel pending fetch if user leaves quickly
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  }, []);
  
  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);
  
  // Click handler uses fileId to look up entry from registry
  const handleClick = useCallback(() => {
    onItemClick(fileId);
  }, [fileId, onItemClick]);
  
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onItemContextMenu(fileId, e);
  }, [fileId, onItemContextMenu]);
  
  // Drag support for nodes, parameters, cases, and events (can be dropped onto graph canvas/nodes)
  // Must be before early return to maintain consistent hook count
  const isDraggable = entry ? (entry.type === 'node' || entry.type === 'parameter' || entry.type === 'case' || entry.type === 'event') : false;
  
  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (!entry || !isDraggable) return;
    
    // Set drag data - same format as clipboard
    const dragData = {
      type: 'dagnet-drag',
      objectType: entry.type,
      objectId: entry.id,
    };
    
    e.dataTransfer.setData('application/json', JSON.stringify(dragData));
    e.dataTransfer.effectAllowed = 'copy';
    
    // Set a custom drag image (optional - uses default if not set)
    const dragIcon = document.createElement('div');
    dragIcon.textContent = `📄 ${entry.name}`;
    dragIcon.style.cssText = 'position: absolute; top: -1000px; background: #fff; padding: 4px 8px; border-radius: 4px; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.2);';
    document.body.appendChild(dragIcon);
    e.dataTransfer.setDragImage(dragIcon, 0, 0);
    setTimeout(() => document.body.removeChild(dragIcon), 0);
  }, [entry, isDraggable]);
  
  // Check if this file can show historical versions (lightweight — no hook needed)
  const canShowHistory = useMemo(() => {
    if (!entry || entry.isLocal || !entry.hasFile) return false;
    return historicalFileService.canOpenHistorical(fileId);
  }, [fileId, entry]);

  const itemRef = useRef<HTMLDivElement>(null);

  const handleHistoryClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // Dispatch event for NavigatorContent to handle (single calendar instance)
    const rect = itemRef.current?.getBoundingClientRect();
    window.dispatchEvent(new CustomEvent('dagnet:openHistoricalCalendar', {
      detail: { fileId, anchorRect: rect || null },
    }));
  }, [fileId]);

  // Early return AFTER all hooks
  if (!entry) {
    if (!missingEntryWarned.has(fileId)) {
      missingEntryWarned.add(fileId);
      // This can happen transiently during initial loads / navigator refresh.
      // Avoid spamming console.error (it looks like a crash when it isn't).
      console.warn(`[NavigatorItem] No entry found for fileId: ${fileId}`);
    }
    return null;
  }
  
  // Use cached/fetched tooltip if available, otherwise base tooltip
  const displayTooltip = tooltip || baseTooltip;
  
  return (
    <div
      ref={itemRef}
      className={`navigator-item ${isActive ? 'active' : ''}`}
      data-file-id={fileId}
      draggable={isDraggable}
      onDragStart={handleDragStart}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      title={displayTooltip}
      style={{ cursor: isDraggable ? 'grab' : 'pointer' }}
    >
      <span className={`navigator-item-name ${entry.isLocal ? 'local-only' : ''} ${!entry.hasFile ? 'in-index-only' : ''} ${entry.isDirty ? 'is-dirty' : entry.isOpen ? 'is-open' : ''}`}>
        {entry.name}
        {entry.tags && entry.tags.length > 0 && (
          <span className="navigator-item-tags">
            {entry.tags.slice(0, 2).map(t => (
              <span
                key={t}
                className="navigator-tag-chip navigator-tag-clickable"
                onClick={(e) => { e.stopPropagation(); navOps.setSearchQuery(t); }}
                title={`Filter by tag: ${t}`}
              >{t}</span>
            ))}
            {entry.tags.length > 2 && (
              <span className="navigator-tag-chip navigator-tag-overflow">+{entry.tags.length - 2}</span>
            )}
          </span>
        )}
      </span>
      <span className="navigator-item-actions">
        {isHovering && canShowHistory && (
          <button
            type="button"
            className="navigator-item-history-btn"
            onClick={handleHistoryClick}
            title="Open historical version"
          >
            <AtSign size={13} />
          </button>
        )}
        {tabCount > 1 && (
          <span className="navigator-tab-count">{tabCount}</span>
        )}
      </span>
    </div>
  );
}

// ============================================================================
// OBJECT TYPE SECTION - Groups entries by type
// ============================================================================

interface ObjectTypeSectionProps {
  title: string;
  icon: LucideIcon;
  entries: NavigatorEntry[];
  sectionType: ObjectType;
  isExpanded: boolean;
  onToggle: () => void;
  onEntryClick: (entry: NavigatorEntry) => void;
  onEntryContextMenu?: (entry: NavigatorEntry, event: React.MouseEvent) => void;
  onSectionContextMenu?: (type: ObjectType, x: number, y: number) => void;
  onIndexClick?: () => void;
  indexIsDirty?: boolean;
  groupBySubCategories?: boolean;
  groupByTags?: boolean;
}

// Sub-category configuration for parameters
const subCategoryConfig: Record<string, { name: string; icon: LucideIcon }> = {
  probability: { name: 'Probability', icon: TrendingUp },
  cost_gbp: { name: 'Cost (GBP)', icon: Coins },
  labour_cost: { name: 'Labour Cost', icon: Clock },
  standard_deviation: { name: 'Std Dev', icon: Package },
};

export function ObjectTypeSection({
  title,
  icon: Icon,
  entries,
  sectionType,
  isExpanded,
  onToggle,
  onEntryClick,
  onEntryContextMenu,
  onSectionContextMenu,
  onIndexClick,
  indexIsDirty,
  groupBySubCategories = false,
  groupByTags = false,
}: ObjectTypeSectionProps) {
  const { tabs, activeTabId } = useTabContext();
  const [expandedSubCategories, setExpandedSubCategories] = useState<Set<string>>(new Set(['probability', 'cost_gbp', 'labour_cost', 'standard_deviation']));
  
  // Auto-expand tag groups when they first appear
  const prevTagGroupsRef = useRef<string[]>([]);
  useEffect(() => {
    if (!groupByTags) return;
    const tagKeys = entries
      .flatMap(e => e.tags || [])
      .filter((v, i, a) => a.indexOf(v) === i)
      .map(t => `tag:${t}`);
    tagKeys.push('tag:Untagged');
    const newKeys = tagKeys.filter(k => !prevTagGroupsRef.current.includes(k));
    if (newKeys.length > 0) {
      setExpandedSubCategories(prev => {
        const next = new Set(prev);
        newKeys.forEach(k => next.add(k));
        return next;
      });
      prevTagGroupsRef.current = tagKeys;
    }
  }, [groupByTags, entries]);
  
  const theme = getObjectTypeTheme(sectionType);
  
  // Get active file ID
  const activeFileId = tabs.find(t => t.id === activeTabId)?.fileId || null;
  
  const toggleSubCategory = useCallback((key: string) => {
    setExpandedSubCategories(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);
  
  // Get tab count for an entry
  const getTabCount = useCallback((entry: NavigatorEntry) => {
    return tabs.filter(t => t.fileId === entry.fileId).length;
  }, [tabs]);
  
  // Handle section right-click
  const handleSectionContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onSectionContextMenu) {
      onSectionContextMenu(sectionType, e.clientX, e.clientY);
    }
  }, [onSectionContextMenu, sectionType]);
  
  // Group entries by sub-category if enabled
  const groupedBySubCategory = groupBySubCategories && sectionType === 'parameter'
    ? Object.keys(subCategoryConfig).reduce((acc, key) => {
        acc[key] = entries.filter(e => e.parameter_type === key);
        return acc;
      }, {} as Record<string, NavigatorEntry[]>)
    : null;

  // Group entries by tag if enabled (works for all section types)
  const groupedByTag = useMemo(() => {
    if (!groupByTags || groupedBySubCategory) return null; // sub-categories take precedence
    const tagGroups: Record<string, NavigatorEntry[]> = {};
    let hasAnyTag = false;
    for (const entry of entries) {
      if (entry.tags && entry.tags.length > 0) {
        hasAnyTag = true;
        for (const tag of entry.tags) {
          if (!tagGroups[tag]) tagGroups[tag] = [];
          tagGroups[tag].push(entry);
        }
      } else {
        if (!tagGroups['Untagged']) tagGroups['Untagged'] = [];
        tagGroups['Untagged'].push(entry);
      }
    }
    return hasAnyTag ? tagGroups : null;
  }, [groupByTags, groupedBySubCategory, entries]);
  
  return (
    <div 
      className="object-type-section" 
      data-type={sectionType}
      style={{ borderLeftColor: theme.accentColour }}
    >
      <div 
        className={`section-header ${isExpanded ? 'is-expanded' : ''}`}
        onContextMenu={handleSectionContextMenu}
      >
        <div className="section-header-left" onClick={onToggle}>
          <ChevronRight 
            size={14} 
            className={`chevron ${isExpanded ? 'expanded' : ''}`}
            style={{ color: theme.accentColour }}
          />
          <Icon 
            size={16} 
            strokeWidth={2}
            style={{ color: theme.accentColour, marginRight: '6px' }}
          />
          <span className="section-title" style={{ color: theme.accentColour }}>{title}</span>
          <span className="section-count">{entries.length}</span>
        </div>
        
        {onIndexClick && (
          <div className="section-header-right">
            <button 
              className={`index-button ${indexIsDirty ? 'is-dirty' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onIndexClick();
              }}
              title={`Open ${sectionType}s index file`}
            >
              <FileText size={14} />
            </button>
          </div>
        )}
      </div>
      
      <div className={`section-content ${isExpanded ? 'expanded' : ''}`}>
        <EntriesRegistryProvider
          entries={entries}
          onEntryClick={onEntryClick}
          onEntryContextMenu={onEntryContextMenu}
        >
          {!isExpanded ? null : groupedBySubCategory ? (
            // Render with sub-categories (for parameters)
            Object.entries(groupedBySubCategory).map(([subCatKey, subCatEntries]) => {
              if (subCatEntries.length === 0) return null;
              
              const isSubCatExpanded = expandedSubCategories.has(subCatKey);
              const SubCatIcon = subCategoryConfig[subCatKey].icon;
              
              return (
                <div key={subCatKey} className="sub-category">
                  <div 
                    className="sub-category-header"
                    onClick={() => toggleSubCategory(subCatKey)}
                  >
                    <ChevronRight 
                      size={12} 
                      className={`chevron ${isSubCatExpanded ? 'expanded' : ''}`}
                      style={{ color: theme.accentColour, opacity: 0.7 }}
                    />
                    {React.createElement(SubCatIcon, { 
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
                        const isActive = activeFileId === entry.fileId;
                        
                        return (
                          <NavigatorItem
                            key={entry.fileId}
                            fileId={entry.fileId}
                            isActive={isActive}
                            tabCount={tabCount}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          ) : groupedByTag ? (
            // Render grouped by tags
            Object.entries(groupedByTag).sort(([a], [b]) => a === 'Untagged' ? 1 : b === 'Untagged' ? -1 : a.localeCompare(b)).map(([tagKey, tagEntries]) => {
              if (tagEntries.length === 0) return null;
              const isTagExpanded = expandedSubCategories.has(`tag:${tagKey}`);
              
              return (
                <div key={`tag-${tagKey}`} className="sub-category">
                  <div 
                    className="sub-category-header"
                    onClick={() => toggleSubCategory(`tag:${tagKey}`)}
                  >
                    <ChevronRight 
                      size={12} 
                      className={`chevron ${isTagExpanded ? 'expanded' : ''}`}
                      style={{ color: theme.accentColour, opacity: 0.7 }}
                    />
                    <span className="navigator-tag-chip" style={{ marginRight: '4px' }}>{tagKey}</span>
                    <span className="section-count">{tagEntries.length}</span>
                  </div>
                  
                  {isTagExpanded && (
                    <div className="sub-category-items">
                      {tagEntries.map(entry => {
                        const tabCount = getTabCount(entry);
                        const isActive = activeFileId === entry.fileId;
                        
                        return (
                          <NavigatorItem
                            key={entry.fileId}
                            fileId={entry.fileId}
                            isActive={isActive}
                            tabCount={tabCount}
                          />
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
              const isActive = activeFileId === entry.fileId;
              
              return (
                <NavigatorItem
                  key={entry.fileId}
                  fileId={entry.fileId}
                  isActive={isActive}
                  tabCount={tabCount}
                />
              );
            })
          )}
        </EntriesRegistryProvider>
      </div>
    </div>
  );
}
