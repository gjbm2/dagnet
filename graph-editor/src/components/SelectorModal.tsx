import React, { useState, useMemo } from 'react';
import { X, ExternalLink, ArrowUp, ArrowDown } from 'lucide-react';
import { useItemFiltering, FilterMode, SortMode, GroupMode, ItemBase } from '../hooks/useItemFiltering';
import { NavigatorControls } from './Navigator/NavigatorControls';
import { getObjectTypeTheme } from '../theme/objectTypeTheme';
import './SelectorModal.css';

interface SelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  type: 'parameter' | 'context' | 'case' | 'node' | 'event';
  items: ItemBase[];
  currentValue: string;
  onSelect: (value: string) => void;
  onOpenItem?: (itemId: string) => void;
}

type ColumnSortKey = 'id' | 'label' | 'type' | 'description';

export function SelectorModal({
  isOpen,
  onClose,
  type,
  items,
  currentValue,
  onSelect,
  onOpenItem
}: SelectorModalProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [sortBy, setSortBy] = useState<SortMode>('name');
  const [groupBy, setGroupBy] = useState<GroupMode>('type');
  
  // Column sorting state
  const [columnSort, setColumnSort] = useState<{ key: ColumnSortKey; direction: 'asc' | 'desc' }>({
    key: 'id',
    direction: 'asc'
  });
  
  // Selected item state (for preview before confirming)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(currentValue || null);

  // Get theme for this type
  const theme = getObjectTypeTheme(type);
  const IconComponent = theme.icon;

  // Apply filtering, sorting, and grouping
  const { groupedItems, stats } = useItemFiltering(
    items,
    { searchQuery, filterMode },
    sortBy,
    groupBy
  );

  // Flatten grouped items for table view
  const flatItems = useMemo(() => {
    return groupedItems.flatMap(group => group.items);
  }, [groupedItems]);

  // Sort items by column
  const sortedItems = useMemo(() => {
    const sorted = [...flatItems];
    sorted.sort((a, b) => {
      let aVal: string | number | undefined;
      let bVal: string | number | undefined;

      switch (columnSort.key) {
        case 'id':
          aVal = a.id;
          bVal = b.id;
          break;
        case 'label':
          aVal = a.name;
          bVal = b.name;
          break;
        case 'type':
          aVal = a.type;
          bVal = b.type;
          break;
        case 'description':
          aVal = a.description || '';
          bVal = b.description || '';
          break;
      }

      if (aVal === undefined) return 1;
      if (bVal === undefined) return -1;

      const comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return columnSort.direction === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [flatItems, columnSort]);

  if (!isOpen) return null;

  const handleRowClick = (itemId: string) => {
    setSelectedItemId(itemId);
  };
  
  const handleConfirmSelect = () => {
    if (selectedItemId) {
      onSelect(selectedItemId);
      onClose();
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleColumnSort = (key: ColumnSortKey) => {
    setColumnSort(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const SortIcon = ({ columnKey }: { columnKey: ColumnSortKey }) => {
    if (columnSort.key !== columnKey) return null;
    return columnSort.direction === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />;
  };

  return (
    <div className="selector-modal-overlay" onClick={handleOverlayClick}>
      <div className="selector-modal-container">
        {/* Header */}
        <div className="selector-modal-header">
          <div className="selector-modal-title">
            <IconComponent size={20} style={{ color: theme.accentColour }} />
            <h3>Select {type.charAt(0).toUpperCase() + type.slice(1)}</h3>
          </div>
          <button
            className="selector-modal-close"
            onClick={onClose}
            title="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Search and Controls */}
        <div className="selector-modal-controls">
          <input
            type="text"
            className="selector-modal-search"
            placeholder={`Search ${type}s...`}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus
          />
          <NavigatorControls
            filter={filterMode}
            sortBy={sortBy}
            onFilterChange={setFilterMode}
            onSortChange={setSortBy}
            availableTags={[]}
            selectedTags={[]}
            onTagToggle={() => {}}
            onTagsClear={() => {}}
          />
        </div>

        {/* Stats */}
        <div className="selector-modal-stats">
          Showing {stats.filtered} of {stats.total} items
          {searchQuery && ` matching "${searchQuery}"`}
        </div>

        {/* Items Table */}
        <div className="selector-modal-body">
          {sortedItems.length === 0 ? (
            <div className="selector-modal-empty">
              No items found
              {searchQuery && ` matching "${searchQuery}"`}
            </div>
          ) : (
            <table className="selector-modal-table">
              <thead>
                <tr>
                  <th onClick={() => handleColumnSort('id')} className="sortable">
                    ID <SortIcon columnKey="id" />
                  </th>
                  <th onClick={() => handleColumnSort('label')} className="sortable">
                    Label <SortIcon columnKey="label" />
                  </th>
                  <th onClick={() => handleColumnSort('type')} className="sortable">
                    Type <SortIcon columnKey="type" />
                  </th>
                  <th>Stored</th>
                  <th onClick={() => handleColumnSort('description')} className="sortable">
                    Description <SortIcon columnKey="description" />
                  </th>
                  {onOpenItem && <th className="actions-column"></th>}
                </tr>
              </thead>
              <tbody>
                {sortedItems.map(item => {
                  const isCurrent = item.id === currentValue;
                  const isSelected = item.id === selectedItemId;
                  
                  // Determine storage chips
                  const storageChips: string[] = [];
                  if (item.isLocal) storageChips.push('graph');
                  if (item.hasFile) storageChips.push('file');
                  if (!item.isLocal && !item.hasFile) storageChips.push('registry');
                  if (item.isDirty) storageChips.push('dirty');
                  if (item.isOpen) storageChips.push('open');
                  
                  return (
                    <tr
                      key={item.id}
                      className={`selector-modal-table-row ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleRowClick(item.id)}
                    >
                      <td className="id-column">
                        {item.id}
                        {isCurrent && (
                          <span className="current-badge">current</span>
                        )}
                      </td>
                      <td className="label-column">{item.name}</td>
                      <td className="type-column">{item.type}</td>
                      <td className="stored-column">
                        {storageChips.map(chip => (
                          <span key={chip} className={`storage-chip ${chip}`}>
                            {chip}
                          </span>
                        ))}
                      </td>
                      <td className="description-column">
                        {item.description || '-'}
                      </td>
                      {onOpenItem && (
                        <td className="actions-column">
                          <button
                            className="selector-modal-table-action"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenItem(item.id);
                            }}
                            title="Open in editor"
                          >
                            <ExternalLink size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="selector-modal-footer">
          <button
            className="selector-modal-button secondary"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="selector-modal-button primary"
            onClick={handleConfirmSelect}
            disabled={!selectedItemId}
          >
            Select
          </button>
        </div>
      </div>
    </div>
  );
}

