import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { useTabContext, useFileRegistry } from '../../contexts/TabContext';
import { NavigatorHeader } from './NavigatorHeader';
import { NavigatorControls, FilterMode, SortMode, GroupMode } from './NavigatorControls';
import { ObjectTypeSection, NavigatorEntry } from './ObjectTypeSection';
import { NavigatorItemContextMenu } from '../NavigatorItemContextMenu';
import { NavigatorSectionContextMenu } from '../NavigatorSectionContextMenu';
import { HistoricalCalendarPicker } from '../HistoricalCalendarPicker';
import { historicalFileService, type CommitDateMap, type HistoricalCommit } from '../../services/historicalFileService';
import toast from 'react-hot-toast';
import { RepositoryItem, ObjectType } from '../../types';
import { registryService, RegistryItem } from '../../services/registryService';
import { getObjectTypeTheme } from '../../theme/objectTypeTheme';
import './Navigator.css';

// NavigatorEntry is imported from ObjectTypeSection
// Extended locally with lastModified/lastOpened for sorting
interface NavigatorEntryWithMeta extends NavigatorEntry {
  lastModified?: number;
  lastOpened?: number;
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

  // Historical calendar — single instance shared across all navigator items
  const [historicalCalState, setHistoricalCalState] = useState<{
    fileId: string;
    isLoading: boolean;
    commitDates: CommitDateMap;
  } | null>(null);
  const historicalAnchorRef = useRef<HTMLElement | null>(null);

  const handleHistoricalCommitSelected = useCallback(async (commit: HistoricalCommit) => {
    if (!historicalCalState) return;
    const toastId = toast.loading(`Opening at ${commit.dateUK}…`);
    try {
      const tabId = await historicalFileService.openHistoricalVersion(
        historicalCalState.fileId,
        commit,
        state.selectedRepo,
      );
      if (tabId) {
        toast.success(`Opened historical version (${commit.dateUK})`, { id: toastId });
      } else {
        toast.error('Failed to open historical version', { id: toastId });
      }
    } catch (error) {
      toast.error(`Failed: ${error instanceof Error ? error.message : 'Unknown error'}`, { id: toastId });
    }
    setHistoricalCalState(null);
    // Clean up virtual anchor
    if (historicalAnchorRef.current) {
      try { document.body.removeChild(historicalAnchorRef.current); } catch { /* ok */ }
      historicalAnchorRef.current = null;
    }
  }, [historicalCalState, state.selectedRepo]);

  // Listen for the dagnet:openHistoricalCalendar event from NavigatorItem @ buttons
  useEffect(() => {
    const handleOpenHistorical = async (event: CustomEvent<{ fileId: string; anchorRect: DOMRect | null }>) => {
      const { fileId, anchorRect } = event.detail;

      // Position the anchor
      if (anchorRect) {
        const virtualAnchor = document.createElement('div');
        virtualAnchor.style.cssText = `position:fixed;left:${anchorRect.left}px;top:${anchorRect.top}px;width:${anchorRect.width}px;height:${anchorRect.height}px;pointer-events:none;`;
        document.body.appendChild(virtualAnchor);
        historicalAnchorRef.current = virtualAnchor;
        // Keep it around until calendar closes (cleaned up below)
      }

      // Open with loading state
      setHistoricalCalState({ fileId, isLoading: true, commitDates: new Map() });

      try {
        const dates = await historicalFileService.getCommitDates(
          fileId,
          state.selectedRepo,
          state.selectedBranch,
        );
        if (dates.size === 0) {
          toast('No historical versions found', { icon: 'ℹ️' });
          setHistoricalCalState(null);
          cleanupVirtualAnchor();
          return;
        }
        setHistoricalCalState({ fileId, isLoading: false, commitDates: dates });
      } catch (error) {
        toast.error(`Failed to load history: ${error instanceof Error ? error.message : 'Unknown error'}`);
        setHistoricalCalState(null);
        cleanupVirtualAnchor();
      }
    };

    const cleanupVirtualAnchor = () => {
      if (historicalAnchorRef.current) {
        try { document.body.removeChild(historicalAnchorRef.current); } catch { /* already removed */ }
        historicalAnchorRef.current = null;
      }
    };

    const handler = ((event: Event) => handleOpenHistorical(event as CustomEvent<{ fileId: string; anchorRect: DOMRect | null }>)) as EventListener;
    window.addEventListener('dagnet:openHistoricalCalendar', handler);
    return () => {
      window.removeEventListener('dagnet:openHistoricalCalendar', handler);
      cleanupVirtualAnchor();
    };
  }, [state.selectedRepo, state.selectedBranch]);
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
  
  // Track a unique load ID to prevent race conditions
  const loadIdRef = useRef(0);
  const [isRegistryLoading, setIsRegistryLoading] = useState(true);

  // Load registry items from central service
  useEffect(() => {
    const currentLoadId = ++loadIdRef.current;
    setIsRegistryLoading(true);
    
    const loadAllItems = async () => {
      try {
        const [parameters, contexts, cases, nodes, events] = await Promise.all([
          registryService.getParameters(tabs),
          registryService.getContexts(tabs),
          registryService.getCases(tabs),
          registryService.getNodes(tabs),
          registryService.getEvents(tabs)
        ]);
        
        // Only update state if this is still the latest load request
        // This prevents race conditions where old loads overwrite newer data
        if (currentLoadId === loadIdRef.current) {
          setRegistryItems({ parameters, contexts, cases, nodes, events });
          setIsRegistryLoading(false);
        }
      } catch (error) {
        console.error('Failed to load registry items:', error);
        if (currentLoadId === loadIdRef.current) {
          setIsRegistryLoading(false);
        }
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
          name: item.id, // Always use id for consistency (friendly name goes in tooltip)
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
          isLocal: file?.isLocal ?? item.isLocal ?? false, // Prefer FileRegistry (updates on commit)
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
            isLocal: file?.isLocal ?? item.isLocal ?? false, // Prefer FileRegistry (updates on commit)
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
      chart: [],
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
      image: [],
      'signature-links': [],
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

  // Entry is passed directly from the component
  const handleItemContextMenu = (entry: NavigatorEntry, event: React.MouseEvent) => {
    const item = convertToRepositoryItem(entry);
    setContextMenu({ item, x: event.clientX, y: event.clientY });
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
              key={`graphs-${groupedEntries.graph.map(e => e.id).join(',')}`}
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
              key={`parameters-${groupedEntries.parameter.map(e => e.id).join(',')}`}
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
              key={`contexts-${groupedEntries.context.map(e => e.id).join(',')}`}
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
              key={`cases-${groupedEntries.case.map(e => e.id).join(',')}`}
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
              key={`nodes-${groupedEntries.node.map(e => e.id).join(',')}`}
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
              key={`events-${groupedEntries.event.map(e => e.id).join(',')}`}
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

      {/* Historical calendar picker — single shared instance for all navigator items */}
      {historicalCalState && (
        <HistoricalCalendarPicker
          commitDates={historicalCalState.commitDates}
          isLoading={historicalCalState.isLoading}
          onCommitSelected={handleHistoricalCommitSelected}
          onClose={() => {
            setHistoricalCalState(null);
            // Clean up virtual anchor
            if (historicalAnchorRef.current) {
              try { document.body.removeChild(historicalAnchorRef.current); } catch { /* ok */ }
              historicalAnchorRef.current = null;
            }
          }}
          anchorRef={historicalAnchorRef}
        />
      )}
    </div>
  );
}
