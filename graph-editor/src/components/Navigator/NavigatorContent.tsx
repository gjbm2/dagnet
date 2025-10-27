import React from 'react';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { useTabContext } from '../../contexts/TabContext';
import { NavigatorHeader } from './NavigatorHeader';
import { ObjectTypeSection } from './ObjectTypeSection';
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
  const { operations: tabOps } = useTabContext();

  // Group items by type
  const graphItems = items.filter(item => item.type === 'graph');
  const paramItems = items.filter(item => item.type === 'parameter');
  const contextItems = items.filter(item => item.type === 'context');
  const caseItems = items.filter(item => item.type === 'case');

  const handleItemClick = (item: any) => {
    tabOps.openTab(item);
    // Close navigator if it's unpinned (overlay mode)
    if (!state.isPinned && state.isOpen) {
      operations.toggleNavigator();
    }
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
            <option value="dagnet">dagnet</option>
            <option value="<private-repo>"><private-repo></option>
          </select>
        </div>

        <div className="navigator-selector">
          <label>Branch</label>
          <select 
            value={state.selectedBranch}
            onChange={(e) => operations.selectBranch(e.target.value)}
            className="navigator-select"
          >
            <option value="main">main</option>
            <option value="develop">develop</option>
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
            />
          </>
        )}
      </div>
    </div>
  );
}

