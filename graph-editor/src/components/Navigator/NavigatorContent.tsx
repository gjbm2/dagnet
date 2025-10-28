import React, { useState } from 'react';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { useTabContext } from '../../contexts/TabContext';
import { NavigatorHeader } from './NavigatorHeader';
import { ObjectTypeSection } from './ObjectTypeSection';
import { NavigatorItemContextMenu } from '../NavigatorItemContextMenu';
import { RepositoryItem } from '../../types';
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
  const [contextMenu, setContextMenu] = useState<{ item: RepositoryItem; x: number; y: number } | null>(null);

  // Group items by type
  const graphItems = items.filter(item => item.type === 'graph');
  const paramItems = items.filter(item => item.type === 'parameter');
  const contextItems = items.filter(item => item.type === 'context');
  const caseItems = items.filter(item => item.type === 'case');

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
            />

            <ObjectTypeSection
              title="Parameters"
              icon="📋"
              items={paramItems}
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
            />

            <ObjectTypeSection
              title="Contexts"
              icon="📄"
              items={contextItems}
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
            />

            <ObjectTypeSection
              title="Cases"
              icon="🗂"
              items={caseItems}
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
    </div>
  );
}

