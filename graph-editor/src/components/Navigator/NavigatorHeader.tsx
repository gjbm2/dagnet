import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { fileRegistry } from '../../contexts/TabContext';
import { Search, Settings, Tag } from 'lucide-react';
import './Navigator.css';

/**
 * Navigator Header
 * 
 * Clean search bar with filter dropdown.
 * No repo/branch selectors here - they're in Repository menu.
 */
export function NavigatorHeader() {
  const { state, operations } = useNavigatorContext();
  const [isFilterDropdownOpen, setIsFilterDropdownOpen] = useState(false);
  const filterDropdownRef = useRef<HTMLDivElement>(null);

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

  // Collect all tags across workspace — re-scan periodically via a counter
  const [tagScanCounter, setTagScanCounter] = useState(0);
  // Rescan tags when dropdown opens or navigator regains focus (picks up newly added tags)
  useEffect(() => {
    if (isFilterDropdownOpen) setTagScanCounter(c => c + 1);
  }, [isFilterDropdownOpen]);

  // Also rescan on any click within the navigator header (catches post-tag-edit)
  const handleTagRescan = useCallback(() => {
    setTagScanCounter(c => c + 1);
  }, []);

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    try {
      for (const file of fileRegistry.getAllFiles?.() ?? []) {
        const data = file?.data as any;
        data?.tags?.forEach?.((t: string) => tagSet.add(t));
        data?.metadata?.tags?.forEach?.((t: string) => tagSet.add(t));
      }
    } catch { /* ignore */ }
    return Array.from(tagSet).sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagScanCounter]);

  // Count active filters for badge
  const activeFilterCount = [
    state.showLocalOnly,
    state.showDirtyOnly,
    state.showOpenOnly
  ].filter(Boolean).length;

  return (
    <div className="navigator-header" onMouseEnter={handleTagRescan}>
      {/* Full-width search bar with filter dropdown */}
      <div className="navigator-search-container">
        <div className="search-input-container">
          <Search className="search-icon" size={16} strokeWidth={2} />
          <input
            type="text"
            placeholder="Search parameters, contexts, cases..."
            value={state.searchQuery}
            onChange={(e) => operations.setSearchQuery(e.target.value)}
            className="navigator-search-input"
          />
          {state.searchQuery && (
            <button
              className="search-clear-btn"
              onClick={() => operations.setSearchQuery('')}
              title="Clear search"
            >
              ×
            </button>
          )}
        </div>
        
        {/* Filter dropdown button */}
        <div className="navigator-filter-dropdown" ref={filterDropdownRef}>
          <button
            className="navigator-filter-btn"
            onClick={() => setIsFilterDropdownOpen(!isFilterDropdownOpen)}
            title="Filter and Sort Options"
          >
            <Settings size={16} strokeWidth={2} />
            {activeFilterCount > 0 && (
              <span className="filter-badge">{activeFilterCount}</span>
            )}
          </button>
          
          {/* Filter dropdown menu */}
          {isFilterDropdownOpen && (
            <div className="navigator-filter-menu">
              {/* Show Mode */}
              <div className="filter-section">
                <label className="filter-section-label">Show Mode</label>
                <div className="filter-radio-group">
                  <label>
                    <input
                      type="radio"
                      name="viewMode"
                      value="all"
                      checked={state.viewMode === 'all'}
                      onChange={() => operations.setViewMode('all')}
                    />
                    <span>All (index + files)</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="viewMode"
                      value="files-only"
                      checked={state.viewMode === 'files-only'}
                      onChange={() => operations.setViewMode('files-only')}
                    />
                    <span>Files Only</span>
                  </label>
                </div>
              </div>

              <div className="filter-divider" />

              {/* Filter by State */}
              <div className="filter-section">
                <label className="filter-section-label">Filter by State</label>
                <label className="filter-checkbox">
                  <input
                    type="checkbox"
                    checked={state.showLocalOnly}
                    onChange={(e) => operations.setShowLocalOnly(e.target.checked)}
                  />
                  <span>Local only</span>
                </label>
                <label className="filter-checkbox">
                  <input
                    type="checkbox"
                    checked={state.showDirtyOnly}
                    onChange={(e) => operations.setShowDirtyOnly(e.target.checked)}
                  />
                  <span>Dirty only</span>
                </label>
                <label className="filter-checkbox">
                  <input
                    type="checkbox"
                    checked={state.showOpenOnly}
                    onChange={(e) => operations.setShowOpenOnly(e.target.checked)}
                  />
                  <span>Open only</span>
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
                  <option value="name">Name (A-Z)</option>
                  <option value="modified">Recently Modified</option>
                  <option value="opened">Recently Opened</option>
                  <option value="status">Status (Dirty first)</option>
                  <option value="type">Type</option>
                </select>
              </div>

              <div className="filter-divider" />

              {/* Grouping Options */}
              <div className="filter-section">
                <label className="filter-section-label">Group By</label>
                <label className="filter-checkbox">
                  <input
                    type="checkbox"
                    checked={state.groupBySubCategories}
                    onChange={(e) => operations.setGroupBySubCategories(e.target.checked)}
                  />
                  <span>Sub-categories</span>
                </label>
                <label className="filter-checkbox">
                  <input
                    type="checkbox"
                    checked={state.groupByTags}
                    onChange={(e) => operations.setGroupByTags(e.target.checked)}
                  />
                  <span>Tags</span>
                </label>
              </div>

              {/* Tag Filter */}
              {allTags.length > 0 && (
                <>
                  <div className="filter-divider" />
                  <div className="filter-section">
                    <label className="filter-section-label">
                      <Tag size={11} strokeWidth={2} style={{ marginRight: '4px', verticalAlign: '-1px' }} />
                      Filter by Tag
                    </label>
                    <div className="tag-filter-chips">
                      {allTags.map(tag => (
                        <span
                          key={tag}
                          className={`tag-filter-chip ${state.searchQuery === tag ? 'active' : ''}`}
                          onClick={() => {
                            operations.setSearchQuery(state.searchQuery === tag ? '' : tag);
                          }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                </>
              )}

            </div>
          )}
        </div>
      </div>
    </div>
  );
}
