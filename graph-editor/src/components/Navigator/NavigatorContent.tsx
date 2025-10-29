import React, { useState } from 'react';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { useTabContext, useFileRegistry } from '../../contexts/TabContext';
import { NavigatorHeader } from './NavigatorHeader';
import { ObjectTypeSection } from './ObjectTypeSection';
import { NavigatorItemContextMenu } from '../NavigatorItemContextMenu';
import { NavigatorSectionContextMenu } from '../NavigatorSectionContextMenu';
import { RepositoryItem, ObjectType } from '../../types';
import './Navigator.css';

/**
 * Navigator Content
 * 
 * Full-height panel showing:
 * - Header with search and controls
 * - Repository/Branch selectors
 * - Object tree (Graphs, Parameters, Contexts, Cases)
 */
export function NavigatorContent() {
  const { state, operations, items, isLoading } = useNavigatorContext();
  const { tabs, activeTabId, operations: tabOps } = useTabContext();
  const fileRegistry = useFileRegistry();
  const [contextMenu, setContextMenu] = useState<{ item: RepositoryItem; x: number; y: number } | null>(null);
  const [sectionContextMenu, setSectionContextMenu] = useState<{ type: ObjectType; x: number; y: number } | null>(null);

  // Group items by type
  const graphItems = items.filter(item => item.type === 'graph');
  const paramItems = items.filter(item => item.type === 'parameter');
  const contextItems = items.filter(item => item.type === 'context');
  const caseItems = items.filter(item => item.type === 'case');
  const nodeItems = items.filter(item => item.type === 'node');

  const handleItemClick = (item: any) => {
    const fileId = `${item.type}-${item.id}`;
    
    // Check if there's already a tab open for this file
    const existingTab = tabs.find(t => t.fileId === fileId);
    
    if (existingTab) {
      // Navigate to existing tab instead of opening new one
      console.log(`Navigator: File ${fileId} already open in tab ${existingTab.id}, switching to it`);
      tabOps.switchTab(existingTab.id);
    } else {
      // No existing tab, open new one
      console.log(`Navigator: Opening new tab for ${fileId}`);
      tabOps.openTab(item);
      
      // Signal to open in same panel as focused tab
      const focusedTab = tabs.find(t => t.id === activeTabId);
      if (focusedTab) {
        window.dispatchEvent(new CustomEvent('dagnet:openInFocusedPanel', {
          detail: { newTabFileId: fileId }
        }));
      }
    }
    
    // Close navigator if it's unpinned (overlay mode)
    if (!state.isPinned && state.isOpen) {
      operations.toggleNavigator();
    }
  };

  const handleItemContextMenu = (item: RepositoryItem, x: number, y: number) => {
    setContextMenu({ item, x, y });
  };

  const handleSectionContextMenu = (type: ObjectType, x: number, y: number) => {
    setSectionContextMenu({ type, x, y });
  };

  const handleIndexClick = (type: ObjectType) => {
    // Open the index file for this type
    const indexFileId = `${type}-index`;
    const indexFileName = `${type}s-index.yaml`;
    
    // Check if already open
    const existingTab = tabs.find(t => t.fileId === indexFileId);
    if (existingTab) {
      tabOps.switchTab(existingTab.id);
    } else {
      // Open new tab for index file
      const indexItem: RepositoryItem = {
        id: 'index',
        type: type,
        name: indexFileName,
        path: `${type}s/${indexFileName}`,
        description: `${type.charAt(0).toUpperCase() + type.slice(1)}s Registry Index`
      };
      tabOps.openTab(indexItem);
    }
  };

  const getIndexIsDirty = (type: ObjectType): boolean => {
    const indexFileId = `${type}-index`;
    // Check if index file exists in registry and is dirty
    const indexFile = fileRegistry.getFile(indexFileId);
    return indexFile?.isDirty || false;
  };

  return (
    <div className="navigator-content">
      {/* Search at top */}
      <div className="navigator-search-box">
        <input
          type="text"
          placeholder="🔍 Search..."
          value={state.searchQuery}
          onChange={(e) => operations.setSearchQuery(e.target.value)}
          className="navigator-search-input"
        />
      </div>
      
      {/* Repository and Branch selectors */}
      <div className="navigator-selectors">
        <div className="navigator-selector">
          <label>Repository</label>
          <select 
            value={state.selectedRepo}
            onChange={(e) => operations.selectRepository(e.target.value)}
            className="navigator-select"
          >
            <option value="">Select repository...</option>
            {state.availableRepos?.map(repo => (
              <option key={repo} value={repo}>{repo}</option>
            ))}
          </select>
        </div>

        <div className="navigator-selector">
          <label>Branch</label>
          <select 
            value={state.selectedBranch}
            onChange={(e) => operations.selectBranch(e.target.value)}
            className="navigator-select"
            disabled={!state.selectedRepo || !state.availableBranches || state.availableBranches.length === 0}
          >
            <option value="">Select branch...</option>
            {state.availableBranches?.map(branch => (
              <option key={branch} value={branch}>{branch}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="navigator-divider" />

      {/* Object tree */}
      <div className="navigator-tree">
        {isLoading ? (
          <div className="navigator-loading">Loading...</div>
        ) : (
          <>
            <ObjectTypeSection
              title="Graphs"
              icon="📊"
              items={graphItems}
              sectionType="graph"
              isExpanded={state.expandedSections.includes('graphs')}
              onToggle={() => {
                if (state.expandedSections.includes('graphs')) {
                  operations.collapseSection('graphs');
                } else {
                  operations.expandSection('graphs');
                }
              }}
              onItemClick={handleItemClick}
              onItemContextMenu={handleItemContextMenu}
              onSectionContextMenu={handleSectionContextMenu}
            />

            <ObjectTypeSection
              title="Parameters"
              icon="📋"
              items={paramItems}
              sectionType="parameter"
              isExpanded={state.expandedSections.includes('parameters')}
              onToggle={() => {
                if (state.expandedSections.includes('parameters')) {
                  operations.collapseSection('parameters');
                } else {
                  operations.expandSection('parameters');
                }
              }}
              onItemClick={handleItemClick}
              onItemContextMenu={handleItemContextMenu}
              onSectionContextMenu={handleSectionContextMenu}
              onIndexClick={() => handleIndexClick('parameter')}
              indexIsDirty={getIndexIsDirty('parameter')}
            />

            <ObjectTypeSection
              title="Contexts"
              icon="📄"
              items={contextItems}
              sectionType="context"
              isExpanded={state.expandedSections.includes('contexts')}
              onToggle={() => {
                if (state.expandedSections.includes('contexts')) {
                  operations.collapseSection('contexts');
                } else {
                  operations.expandSection('contexts');
                }
              }}
              onItemClick={handleItemClick}
              onItemContextMenu={handleItemContextMenu}
              onSectionContextMenu={handleSectionContextMenu}
              onIndexClick={() => handleIndexClick('context')}
              indexIsDirty={getIndexIsDirty('context')}
            />

            <ObjectTypeSection
              title="Cases"
              icon="🗂"
              items={caseItems}
              sectionType="case"
              isExpanded={state.expandedSections.includes('cases')}
              onToggle={() => {
                if (state.expandedSections.includes('cases')) {
                  operations.collapseSection('cases');
                } else {
                  operations.expandSection('cases');
                }
              }}
              onItemClick={handleItemClick}
              onItemContextMenu={handleItemContextMenu}
              onSectionContextMenu={handleSectionContextMenu}
              onIndexClick={() => handleIndexClick('case')}
              indexIsDirty={getIndexIsDirty('case')}
            />

            <ObjectTypeSection
              title="Nodes"
              icon="🔵"
              items={nodeItems}
              sectionType="node"
              isExpanded={state.expandedSections.includes('nodes')}
              onToggle={() => {
                if (state.expandedSections.includes('nodes')) {
                  operations.collapseSection('nodes');
                } else {
                  operations.expandSection('nodes');
                }
              }}
              onItemClick={handleItemClick}
              onItemContextMenu={handleItemContextMenu}
              onSectionContextMenu={handleSectionContextMenu}
              onIndexClick={() => handleIndexClick('node')}
              indexIsDirty={getIndexIsDirty('node')}
            />
          </>
        )}
      </div>

      {/* Navigator item context menu */}
      {contextMenu && (
        <NavigatorItemContextMenu
          item={contextMenu.item}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}
      
      {/* Navigator section context menu */}
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

