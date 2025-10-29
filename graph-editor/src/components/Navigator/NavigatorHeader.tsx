import React, { useState, useRef, useEffect } from 'react';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { useTabContext, fileRegistry } from '../../contexts/TabContext';
import { gitService } from '../../services/gitService';
import { CommitModal } from '../CommitModal';

/**
 * Navigator Header
 * 
 * Appears inline with tab bar when navigator is open
 * Contains:
 * - Full-width search input with filter dropdown
 * - Pin button
 * - Close button
 * 
 * NOTE: Repository/Branch switching has been moved to Repository menu
 * for safe, guarded operations with dirty file checks
 */
export function NavigatorHeader() {
  const { state, operations } = useNavigatorContext();
  const { operations: tabOps } = useTabContext();
  
  const [isCommitModalOpen, setIsCommitModalOpen] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [isFilterDropdownOpen, setIsFilterDropdownOpen] = useState(false);
  const filterDropdownRef = useRef<HTMLDivElement>(null);

  const dirtyTabs = tabOps.getDirtyTabs();
  const hasDirtyFiles = dirtyTabs.length > 0;

  // Close filter dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(event.target as Node)) {
        setIsFilterDropdownOpen(false);
      }
    };

    if (isFilterDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isFilterDropdownOpen]);

  const handlePull = async () => {
    setIsPulling(true);
    setPullError(null);
    
    try {
      const result = await gitService.pullLatest(state.selectedBranch || 'main');
      if (result.success) {
        console.log('Pull successful:', result.message);
        // TODO: Refresh navigator content
        operations.refreshItems();
      } else {
        setPullError(result.error || 'Failed to pull latest changes');
      }
    } catch (error) {
      setPullError(error instanceof Error ? error.message : 'Failed to pull latest changes');
    } finally {
      setIsPulling(false);
    }
  };

  const handleCommit = () => {
    setIsCommitModalOpen(true);
  };

  const handleCommitFiles = async (files: any[], message: string, branch: string) => {
    try {
      // Load credentials to get repo info
      const { credentialsManager } = await import('../../lib/credentials');
      const credentialsResult = await credentialsManager.loadCredentials();
      
      if (!credentialsResult.success || !credentialsResult.credentials) {
        throw new Error('No credentials available. Please configure credentials first.');
      }

      // Get credentials for selected repo
      const selectedRepo = state.selectedRepo;
      const gitCreds = credentialsResult.credentials.git.find(cred => cred.name === selectedRepo);
      
      if (!gitCreds) {
        throw new Error(`No credentials found for repository ${selectedRepo}`);
      }

      // Set credentials on gitService with selected repo as default
      const credentialsWithRepo = {
        ...credentialsResult.credentials,
        defaultGitRepo: selectedRepo
      };
      gitService.setCredentials(credentialsWithRepo);

      // Prepare files with proper paths including basePath
      const filesToCommit = files.map(file => {
        const basePath = gitCreds.basePath || '';
        const fullPath = basePath ? `${basePath}/${file.path}` : file.path;
        return {
          path: fullPath,
          content: file.content,
          sha: file.sha
        };
      });

      const result = await gitService.commitAndPushFiles(filesToCommit, message, branch);
      if (result.success) {
        console.log('Commit successful:', result.message);
        // Mark files as saved
        for (const file of files) {
          const fileId = file.fileId;
          await fileRegistry.markSaved(fileId);
        }
        // TODO: Refresh navigator - for now just log success
      } else {
        throw new Error(result.error || 'Failed to commit files');
      }
    } catch (error) {
      throw error; // Re-throw to be handled by CommitModal
    }
  };

  return (
    <>
      <div className="navigator-header">
        {/* Full-width search bar with filter dropdown */}
        <div className="navigator-search-container">
          <input
            type="text"
            placeholder="🔍 Search parameters, contexts, cases..."
            value={state.searchQuery}
            onChange={(e) => operations.setSearchQuery(e.target.value)}
            className="navigator-search-input"
          />
          
          {/* Filter dropdown button */}
          <div className="navigator-filter-dropdown" ref={filterDropdownRef}>
            <button
              className="navigator-filter-btn"
              onClick={() => setIsFilterDropdownOpen(!isFilterDropdownOpen)}
              title="Filter and Sort Options"
            >
              ⚙️
            </button>
            
            {/* Dropdown menu */}
            {isFilterDropdownOpen && (
              <div className="navigator-filter-menu">
                {/* View Mode */}
                <div className="filter-section">
                  <label className="filter-section-label">View Mode</label>
                  <div className="filter-radio-group">
                    <label>
                      <input
                        type="radio"
                        name="viewMode"
                        checked={state.viewMode === 'all'}
                        onChange={() => operations.setViewMode('all')}
                      />
                      <span>All (Index + Files)</span>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="viewMode"
                        checked={state.viewMode === 'files-only'}
                        onChange={() => operations.setViewMode('files-only')}
                      />
                      <span>Files Only</span>
                    </label>
                  </div>
                </div>

                <div className="filter-divider" />

                {/* Filters */}
                <div className="filter-section">
                  <label className="filter-section-label">Show</label>
                  <label className="filter-checkbox">
                    <input
                      type="checkbox"
                      checked={state.showLocalOnly}
                      onChange={(e) => operations.setShowLocalOnly(e.target.checked)}
                    />
                    <span>Local Only</span>
                  </label>
                  <label className="filter-checkbox">
                    <input
                      type="checkbox"
                      checked={state.showDirtyOnly}
                      onChange={(e) => operations.setShowDirtyOnly(e.target.checked)}
                    />
                    <span>Dirty Only</span>
                  </label>
                  <label className="filter-checkbox">
                    <input
                      type="checkbox"
                      checked={state.showOpenOnly}
                      onChange={(e) => operations.setShowOpenOnly(e.target.checked)}
                    />
                    <span>Open Only</span>
                  </label>
                </div>

                <div className="filter-divider" />

                {/* Sort Options */}
                <div className="filter-section">
                  <label className="filter-section-label">Sort By</label>
                  <select
                    value={state.sortBy || 'name'}
                    onChange={(e) => operations.setSortBy(e.target.value as any)}
                    className="filter-select"
                  >
                    <option value="name">Name</option>
                    <option value="modified">Recently Modified</option>
                    <option value="opened">Recently Opened</option>
                    <option value="status">Status</option>
                    <option value="type">Type</option>
                  </select>
                </div>

                <div className="filter-divider" />

                {/* Grouping Options */}
                <div className="filter-section">
                  <label className="filter-checkbox">
                    <input
                      type="checkbox"
                      checked={state.groupBySubCategories}
                      onChange={(e) => operations.setGroupBySubCategories(e.target.checked)}
                    />
                    <span>Group by Sub-categories</span>
                  </label>
                  <label className="filter-checkbox">
                    <input
                      type="checkbox"
                      checked={state.groupByTags}
                      onChange={(e) => operations.setGroupByTags(e.target.checked)}
                    />
                    <span>Group by Tags</span>
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Control buttons */}
        <div className="navigator-controls">
          <button
            className={`navigator-control-btn ${state.isPinned ? 'active' : ''}`}
            onClick={operations.togglePin}
            title={state.isPinned ? 'Unpin Navigator' : 'Pin Navigator'}
          >
            📌
          </button>

          <button
            className="navigator-control-btn"
            onClick={operations.toggleNavigator}
            title="Close Navigator"
          >
            ×
          </button>
        </div>
      </div>

      {/* Pull error message */}
      {pullError && (
        <div style={{
          padding: '8px 12px',
          backgroundColor: '#fee',
          border: '1px solid #fcc',
          color: '#c33',
          fontSize: '12px',
          margin: '4px 0'
        }}>
          Pull failed: {pullError}
          <button
            onClick={() => setPullError(null)}
            style={{
              float: 'right',
              background: 'none',
              border: 'none',
              color: '#c33',
              cursor: 'pointer'
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Commit Modal */}
      <CommitModal
        isOpen={isCommitModalOpen}
        onClose={() => setIsCommitModalOpen(false)}
        onCommit={handleCommitFiles}
      />
    </>
  );
}

