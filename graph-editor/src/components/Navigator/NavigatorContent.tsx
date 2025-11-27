import React, { useState, useMemo, useEffect } from 'react';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { useTabContext, useFileRegistry } from '../../contexts/TabContext';
import { NavigatorHeader } from './NavigatorHeader';
import { NavigatorControls, FilterMode, SortMode, GroupMode } from './NavigatorControls';
import { ObjectTypeSection } from './ObjectTypeSection';
import { NavigatorItemContextMenu } from '../NavigatorItemContextMenu';
import { NavigatorSectionContextMenu } from '../NavigatorSectionContextMenu';
import { RepositoryItem, ObjectType } from '../../types';
import { registryService, RegistryItem } from '../../services/registryService';
import { getObjectTypeTheme } from '../../theme/objectTypeTheme';
import './Navigator.css';

/**
 * Navigator Entry - Internal representation with all state flags
 */
interface NavigatorEntry {
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
  // Type-specific metadata for sub-categorization
  parameter_type?: 'probability' | 'cost_gbp' | 'cost_time' | 'standard_deviation';
  node_type?: string;
  case_type?: string;
}

/**
 * Navigator Content
 * 
 * Rebuilt from scratch according to design docs.
 * Properly builds entries from index + files, applies filters/sorting.
 */
export function NavigatorContent() {
  const { state, operations, items, isLoading } = useNavigatorContext();
  const { tabs, activeTabId, operations: tabOps } = useTabContext();
  const fileRegistry = useFileRegistry();
  const [contextMenu, setContextMenu] = useState<{ item: RepositoryItem; x: number; y: number } | null>(null);
  const [sectionContextMenu, setSectionContextMenu] = useState<{ type: ObjectType; x: number; y: number } | null>(null);
  const [dirtyStateVersion, setDirtyStateVersion] = useState(0); // Force re-render on dirty state changes
  const [registryItems, setRegistryItems] = useState<{
    parameters: RegistryItem[];
    contexts: RegistryItem[];
    cases: RegistryItem[];
    nodes: RegistryItem[];
    events: RegistryItem[];
  }>({
    parameters: [],
    contexts: [],
    cases: [],
    nodes: [],
    events: []
  });

  // Load registry items from central service
  useEffect(() => {
    const loadAllItems = async () => {
      try {
        const [parameters, contexts, cases, nodes, events] = await Promise.all([
          registryService.getParameters(tabs),
          registryService.getContexts(tabs),
          registryService.getCases(tabs),
          registryService.getNodes(tabs),
          registryService.getEvents(tabs)
        ]);
        
        setRegistryItems({ parameters, contexts, cases, nodes, events });
      } catch (error) {
        console.error('Failed to load registry items:', error);
      }
    };
    
    loadAllItems();
  }, [state.selectedRepo, state.selectedBranch, items, tabs.length, state.registryIndexes]); // Reload when repo/branch changes OR when files/tabs change OR when indexes load

  // Listen for file dirty state changes and refresh registry items + force re-render
  useEffect(() => {
    const handleFileDirtyChanged = () => {
      
      // Force re-render by incrementing version (this will trigger navigatorEntries useMemo)
      setDirtyStateVersion(v => v + 1);
      
      // Trigger a refresh of registry items
      const loadAllItems = async () => {
        try {
          const [parameters, contexts, cases, nodes, events] = await Promise.all([
            registryService.getParameters(tabs),
            registryService.getContexts(tabs),
            registryService.getCases(tabs),
            registryService.getNodes(tabs),
            registryService.getEvents(tabs)
          ]);
          
          setRegistryItems({ parameters, contexts, cases, nodes, events });
        } catch (error) {
          console.error('Failed to refresh registry items:', error);
        }
      };
      
      loadAllItems();
    };

    window.addEventListener('dagnet:fileDirtyChanged', handleFileDirtyChanged);
    return () => {
      window.removeEventListener('dagnet:fileDirtyChanged', handleFileDirtyChanged);
    };
  }, [tabs]);

  // Build NavigatorEntry objects from registry service + graph files
  const navigatorEntries = useMemo(() => {
    const entriesMap = new Map<string, NavigatorEntry>();
    
    // 1. Convert RegistryItem to NavigatorEntry for parameters, contexts, cases, nodes
    const addRegistryItems = (items: RegistryItem[]) => {
      for (const item of items) {
        const fileId = `${item.type}-${item.id}`; // CRITICAL: Construct fileId for registry items
        entriesMap.set(fileId, { // CRITICAL: Use fileId as map key to avoid type collisions
          id: item.id,
          fileId: fileId,
          name: item.name || item.id,
          type: item.type,
          hasFile: item.hasFile,
          isLocal: item.isLocal,
          inIndex: item.inIndex,
          isDirty: item.isDirty,
          isOpen: item.isOpen,
          isOrphan: item.isOrphan,
          tags: item.tags,
          path: item.file_path,
          lastModified: item.lastModified,
          lastOpened: item.lastOpened,
          // Type-specific metadata for sub-categorization
          parameter_type: item.parameter_type,
          node_type: item.node_type,
          case_type: item.case_type
        });
      }
    };
    
    addRegistryItems(registryItems.parameters);
    addRegistryItems(registryItems.contexts);
    addRegistryItems(registryItems.cases);
    
    addRegistryItems(registryItems.nodes);
    
    addRegistryItems(registryItems.events);
    
    // 2. Add graph files from NavigatorContext (graphs don't have indexes)
    // Also add node files from NavigatorContext that aren't already in entriesMap (orphans)
    for (const item of items) {
      if (item.type === 'graph') {
        const fileId = `graph-${item.id}`;
        const file = fileRegistry.getFile(fileId);
        const itemTabs = tabs.filter(t => t.fileId === fileId);
        
        entriesMap.set(fileId, { // Use fileId as map key
          id: item.id,
          fileId: fileId,
          name: item.name.replace(/\.(yaml|yml|json)$/, ''),
          type: 'graph',
          hasFile: true,
          isLocal: item.isLocal || false,
          inIndex: false, // Graphs don't have indexes
          isDirty: file?.isDirty || false,
          isOpen: itemTabs.length > 0,
          isOrphan: false,
          path: item.path,
          lastModified: file?.lastModified,
          lastOpened: file?.lastOpened
        });
      } else if (item.type === 'node') {
        // Add node files from NavigatorContext that aren't already in entriesMap
        // This handles orphan nodes (files that exist but aren't in the index)
        const fileId = `node-${item.id}`;
        const file = fileRegistry.getFile(fileId);
        const itemTabs = tabs.filter(t => t.fileId === fileId);
        const existingEntry = entriesMap.get(fileId); // Check by fileId
        
        // Only add if not already present (registry items take precedence)
        if (!existingEntry) {
          entriesMap.set(fileId, { // Use fileId as map key
            id: item.id,
            fileId: fileId,
            name: item.name || item.id,
            type: 'node',
            hasFile: true,
            isLocal: item.isLocal || false,
            inIndex: false, // Not in index (orphan)
            isDirty: file?.isDirty || false,
            isOpen: itemTabs.length > 0,
            isOrphan: true,
            path: item.path,
            lastModified: file?.lastModified,
            lastOpened: file?.lastOpened
          });
        }
      }
    }
    
    return Array.from(entriesMap.values());
  }, [items, tabs, registryItems, dirtyStateVersion]);

  // Apply filters and sorting
  const filteredAndSortedEntries = useMemo(() => {
    let filtered = navigatorEntries.filter(entry => {
      // Mode filter
      if (state.viewMode === 'files-only' && !entry.hasFile) {
        return false;
      }
      
      // State filters
      if (state.showLocalOnly && !entry.isLocal) {
        return false;
      }
      
      if (state.showDirtyOnly && !entry.isDirty) {
        return false;
      }
      
      if (state.showOpenOnly && !entry.isOpen) {
        return false;
      }
      
      // Search filter
      if (state.searchQuery) {
        const query = state.searchQuery.toLowerCase();
        return entry.name.toLowerCase().includes(query) ||
               entry.id.toLowerCase().includes(query) ||
               entry.tags?.some(t => t.toLowerCase().includes(query)) ||
               entry.path?.toLowerCase().includes(query);
      }
      
      return true;
    });
    
    // Sort
    filtered.sort((a, b) => {
      switch (state.sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'modified':
          return (b.lastModified || 0) - (a.lastModified || 0);
        case 'opened':
          return (b.lastOpened || 0) - (a.lastOpened || 0);
        case 'status':
          if (a.isDirty !== b.isDirty) return a.isDirty ? -1 : 1;
          if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
          return 0;
        case 'type':
          return a.type.localeCompare(b.type);
        default:
          return 0;
      }
    });
    
    return filtered;
  }, [navigatorEntries, state.viewMode, state.showLocalOnly, state.showDirtyOnly, state.showOpenOnly, state.searchQuery, state.sortBy]);

  // Group by type
  const groupedEntries = useMemo(() => {
    const groups: Record<ObjectType, NavigatorEntry[]> = {
      graph: [],
      parameter: [],
      context: [],
      case: [],
      node: [],
      event: [],
      credentials: [],
      settings: [],
      about: [],
      markdown: [],
      connections: [],
      image: []
    };
    
    for (const entry of filteredAndSortedEntries) {
      if (groups[entry.type]) {
        groups[entry.type].push(entry);
      } else {
        console.warn(`Unknown entry type: ${entry.type}`, entry);
      }
    }
    
    return groups;
  }, [filteredAndSortedEntries]);

  // Convert NavigatorEntry to RepositoryItem for compatibility
  const convertToRepositoryItem = (entry: NavigatorEntry): RepositoryItem => {
    return {
      id: entry.id,
      type: entry.type,
      name: entry.name,
      path: entry.path || `${entry.type}s/${entry.name}.${entry.type === 'graph' ? 'json' : 'yaml'}`,
      isLocal: entry.isLocal,
      description: entry.isOrphan ? '⚠️ Orphan file (not in index)' : undefined
    };
  };

  const handleItemClick = (entry: NavigatorEntry) => {
    const item = convertToRepositoryItem(entry);
    const fileId = `${entry.type}-${entry.id}`;
    
    // Check if there's already a tab open
    const existingTab = tabs.find(t => t.fileId === fileId);
    
    if (existingTab) {
      tabOps.switchTab(existingTab.id);
    } else {
      // If no file exists, create it
      if (!entry.hasFile) {
        // Open new file modal or create immediately
        tabOps.openTab(item);
      } else {
      tabOps.openTab(item);
      }
      
      // Signal to open in same panel as focused tab
      const focusedTab = tabs.find(t => t.id === activeTabId);
      if (focusedTab) {
        window.dispatchEvent(new CustomEvent('dagnet:openInFocusedPanel', {
          detail: { newTabFileId: fileId }
        }));
      }
    }
    
    // Close navigator if unpinned
    if (!state.isPinned && state.isOpen) {
      operations.toggleNavigator();
    }
  };

  const handleItemContextMenu = (entry: NavigatorEntry, x: number, y: number) => {
    setContextMenu({ item: convertToRepositoryItem(entry), x, y });
  };

  const handleSectionContextMenu = (type: ObjectType, x: number, y: number) => {
    setSectionContextMenu({ type, x, y });
  };

  const handleIndexClick = (type: ObjectType) => {
    const indexFileId = `${type}-index`; // FileIds use singular form
    
    // Check if already open
    const existingTab = tabs.find(t => t.fileId === indexFileId);
    if (existingTab) {
      tabOps.switchTab(existingTab.id);
      return;
    }
    
    // Get the actual file from registry
    const indexFile = fileRegistry.getFile(indexFileId);
    if (!indexFile) {
      console.error(`Index file ${indexFileId} not found in registry`);
      return;
    }
    
    // Create RepositoryItem that will construct correct fileId
    // openTab does: fileId = `${type}-${id}` = `parameter-index`
    const indexItem: RepositoryItem = {
      id: 'index', // So openTab constructs: parameter-index ✓
      type: type,  // Use base type (parameter, context, etc)
      name: indexFile.name || `${type}s-index.yaml`,
      path: indexFile.path || `${type}s-index.yaml`,
      description: `${type.charAt(0).toUpperCase() + type.slice(1)}s Registry Index`
    };
    
    tabOps.openTab(indexItem, 'interactive');
  };

  const getIndexIsDirty = (type: ObjectType): boolean => {
    const indexFileId = `${type}-index`; // FileIds use singular form
    const indexFile = fileRegistry.getFile(indexFileId);
    return indexFile?.isDirty || false;
  };

  // Map state to control props
  const filterMode: FilterMode = state.showDirtyOnly ? 'dirty' 
    : state.showOpenOnly ? 'open' 
    : state.showLocalOnly ? 'local' 
    : 'all';
  
  const sortMode: SortMode = (state.sortBy || 'name') as SortMode;
  
  const groupMode: GroupMode = state.groupByTags ? 'tags' 
    : state.groupBySubCategories ? 'type' 
    : 'none';
  
  // Handlers for control changes
  const handleFilterChange = (filter: FilterMode) => {
    operations.setShowDirtyOnly(filter === 'dirty');
    operations.setShowOpenOnly(filter === 'open');
    operations.setShowLocalOnly(filter === 'local');
  };
  
  const handleSortChange = (sort: SortMode) => {
    operations.setSortBy(sort);
  };
  
  const handleGroupChange = (group: GroupMode) => {
    operations.setGroupByTags(group === 'tags');
    operations.setGroupBySubCategories(group === 'type');
  };

  return (
    <div className="navigator-content">
      {/* Header with search and filters */}
      <NavigatorHeader />
      
      {/* Filter/Sort/Group Controls */}
      <NavigatorControls
        filter={filterMode}
        sortBy={sortMode}
        groupBy={groupMode}
        onFilterChange={handleFilterChange}
        onSortChange={handleSortChange}
        onGroupChange={handleGroupChange}
      />

      {/* Object tree */}
      <div className="navigator-tree">
        {isLoading ? (
          <div className="navigator-loading">Loading...</div>
        ) : (
          <>
            <ObjectTypeSection
              title="Graphs"
              icon={getObjectTypeTheme('graph').icon}
              entries={groupedEntries.graph}
              sectionType="graph"
              isExpanded={state.expandedSections.includes('graphs')}
              onToggle={() => {
                if (state.expandedSections.includes('graphs')) {
                  operations.collapseSection('graphs');
                } else {
                  operations.expandSection('graphs');
                }
              }}
              onEntryClick={handleItemClick}
              onEntryContextMenu={handleItemContextMenu}
              onSectionContextMenu={handleSectionContextMenu}
            />

            <ObjectTypeSection
              title="Parameters"
              icon={getObjectTypeTheme('parameter').icon}
              entries={groupedEntries.parameter}
              sectionType="parameter"
              isExpanded={state.expandedSections.includes('parameters')}
              onToggle={() => {
                if (state.expandedSections.includes('parameters')) {
                  operations.collapseSection('parameters');
                } else {
                  operations.expandSection('parameters');
                }
              }}
              onEntryClick={handleItemClick}
              onEntryContextMenu={handleItemContextMenu}
              onSectionContextMenu={handleSectionContextMenu}
              onIndexClick={() => handleIndexClick('parameter')}
              indexIsDirty={getIndexIsDirty('parameter')}
              groupBySubCategories={state.groupBySubCategories}
            />

            <ObjectTypeSection
              title="Contexts"
              icon={getObjectTypeTheme('context').icon}
              entries={groupedEntries.context}
              sectionType="context"
              isExpanded={state.expandedSections.includes('contexts')}
              onToggle={() => {
                if (state.expandedSections.includes('contexts')) {
                  operations.collapseSection('contexts');
                } else {
                  operations.expandSection('contexts');
                }
              }}
              onEntryClick={handleItemClick}
              onEntryContextMenu={handleItemContextMenu}
              onSectionContextMenu={handleSectionContextMenu}
              onIndexClick={() => handleIndexClick('context')}
              indexIsDirty={getIndexIsDirty('context')}
            />

            <ObjectTypeSection
              title="Cases"
              icon={getObjectTypeTheme('case').icon}
              entries={groupedEntries.case}
              sectionType="case"
              isExpanded={state.expandedSections.includes('cases')}
              onToggle={() => {
                if (state.expandedSections.includes('cases')) {
                  operations.collapseSection('cases');
                } else {
                  operations.expandSection('cases');
                }
              }}
              onEntryClick={handleItemClick}
              onEntryContextMenu={handleItemContextMenu}
              onSectionContextMenu={handleSectionContextMenu}
              onIndexClick={() => handleIndexClick('case')}
              indexIsDirty={getIndexIsDirty('case')}
            />

            <ObjectTypeSection
              title="Nodes"
              icon={getObjectTypeTheme('node').icon}
              entries={groupedEntries.node}
              sectionType="node"
              isExpanded={state.expandedSections.includes('nodes')}
              onToggle={() => {
                if (state.expandedSections.includes('nodes')) {
                  operations.collapseSection('nodes');
                } else {
                  operations.expandSection('nodes');
                }
              }}
              onEntryClick={handleItemClick}
              onEntryContextMenu={handleItemContextMenu}
              onSectionContextMenu={handleSectionContextMenu}
              onIndexClick={() => handleIndexClick('node')}
              indexIsDirty={getIndexIsDirty('node')}
            />

            <ObjectTypeSection
              title="Events"
              icon={getObjectTypeTheme('event').icon}
              entries={groupedEntries.event}
              sectionType="event"
              isExpanded={state.expandedSections.includes('events')}
              onToggle={() => {
                if (state.expandedSections.includes('events')) {
                  operations.collapseSection('events');
                } else {
                  operations.expandSection('events');
                }
              }}
              onEntryClick={handleItemClick}
              onEntryContextMenu={handleItemContextMenu}
              onSectionContextMenu={handleSectionContextMenu}
              onIndexClick={() => handleIndexClick('event')}
              indexIsDirty={getIndexIsDirty('event')}
            />
          </>
        )}
      </div>

      {/* Context menus */}
      {contextMenu && (
        <NavigatorItemContextMenu
          item={contextMenu.item}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}
      
      {sectionContextMenu && (
        <NavigatorSectionContextMenu
          sectionType={sectionContextMenu.type}
          x={sectionContextMenu.x}
          y={sectionContextMenu.y}
          onClose={() => setSectionContextMenu(null)}
        />
      )}
    </div>
  );
}
