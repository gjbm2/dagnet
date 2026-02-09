/**
 * NavigatorControls
 * 
 * Compact control bar: Filter | Sort | Tags
 */

import React, { useState, useRef, useEffect } from 'react';
import { Filter, ArrowUpDown, Tag, Check, Circle, LucideIcon } from 'lucide-react';
import './NavigatorControls.css';

export type FilterMode = 'all' | 'dirty' | 'open' | 'local';
export type SortMode = 'name' | 'modified' | 'opened' | 'status' | 'type';

interface NavigatorControlsProps {
  filter: FilterMode;
  sortBy: SortMode;
  onFilterChange: (filter: FilterMode) => void;
  onSortChange: (sort: SortMode) => void;
  /** All tags that exist in the workspace */
  availableTags: string[];
  /** Currently selected tags (filter) */
  selectedTags: string[];
  /** Toggle a tag selection */
  onTagToggle: (tag: string) => void;
  /** Clear all tag selections */
  onTagsClear: () => void;
}

interface DropdownOption<T> {
  value: T;
  label: string;
  showCheckmark?: boolean;
}

const FILTER_OPTIONS: DropdownOption<FilterMode>[] = [
  { value: 'all', label: 'All', showCheckmark: true },
  { value: 'dirty', label: 'Dirty', showCheckmark: true },
  { value: 'open', label: 'Open', showCheckmark: true },
  { value: 'local', label: 'Local', showCheckmark: true },
];

const SORT_OPTIONS: DropdownOption<SortMode>[] = [
  { value: 'name', label: 'Name (A→Z)' },
  { value: 'modified', label: 'Modified (Recent)' },
  { value: 'opened', label: 'Opened (Recent)' },
  { value: 'status', label: 'Status (Dirty first)' },
  { value: 'type', label: 'Type (A→Z)' },
];

function getFilterLabel(filter: FilterMode): string {
  return FILTER_OPTIONS.find(o => o.value === filter)?.label || 'All';
}

function getSortLabel(sort: SortMode): string {
  switch (sort) {
    case 'name': return 'Name';
    case 'modified': return 'Modified';
    case 'opened': return 'Opened';
    case 'status': return 'Status';
    case 'type': return 'Type';
    default: return 'Name';
  }
}

interface ControlDropdownProps<T extends string> {
  icon: LucideIcon;
  label: string;
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
}

function ControlDropdown<T extends string>({
  icon: IconComponent,
  label,
  value,
  options,
  onChange
}: ControlDropdownProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownStyle({
        top: `${rect.bottom + 2}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`
      });
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleSelect = (newValue: T) => {
    onChange(newValue);
    setIsOpen(false);
  };

  return (
    <div className="control-dropdown-container" ref={dropdownRef}>
      <button
        ref={buttonRef}
        className={`control-button ${isOpen ? 'active' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title={label}
      >
        <span className="control-button-label">
          <IconComponent className="control-button-icon" size={14} strokeWidth={2} />
          <span className="control-button-text">{label}</span>
        </span>
        <span className="control-button-arrow">▾</span>
      </button>
      
      {isOpen && (
        <div className="control-dropdown" style={dropdownStyle}>
          {options.map(option => (
            <div
              key={option.value}
              className={`control-dropdown-item ${option.value === value ? 'active' : ''}`}
              onClick={() => handleSelect(option.value)}
            >
              {option.showCheckmark && (
                <span className="dropdown-item-icon">
                  {option.value === value ? <Check size={14} strokeWidth={2} /> : <Circle size={14} strokeWidth={2} />}
                </span>
              )}
              <span className="dropdown-item-label">{option.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Tags multi-select dropdown */
function TagsDropdown({
  availableTags,
  selectedTags,
  onTagToggle,
  onTagsClear,
}: {
  availableTags: string[];
  selectedTags: string[];
  onTagToggle: (tag: string) => void;
  onTagsClear: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownStyle({
        top: `${rect.bottom + 2}px`,
        left: `${rect.left}px`,
        minWidth: `${Math.max(rect.width, 140)}px`
      });
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const count = selectedTags.length;
  const label = count === 0 ? 'Tags' : count === 1 ? selectedTags[0] : `${count} tags`;
  const hasSelection = count > 0;

  return (
    <div className="control-dropdown-container" ref={dropdownRef}>
      <button
        ref={buttonRef}
        className={`control-button ${isOpen ? 'active' : ''} ${hasSelection ? 'has-selection' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title={hasSelection ? `Tags: ${selectedTags.join(', ')}` : 'Filter by tags'}
      >
        <span className="control-button-label">
          <Tag className="control-button-icon" size={14} strokeWidth={2} />
          <span className="control-button-text">{label}</span>
        </span>
        <span className="control-button-arrow">▾</span>
      </button>

      {isOpen && (
        <div className="control-dropdown" style={dropdownStyle}>
          {availableTags.length === 0 ? (
            <div className="control-dropdown-item" style={{ color: '#999', fontStyle: 'italic' }}>
              No tags yet
            </div>
          ) : (
            <>
              {availableTags.map(tag => {
                const isSelected = selectedTags.includes(tag);
                return (
                  <div
                    key={tag}
                    className={`control-dropdown-item ${isSelected ? 'active' : ''}`}
                    onClick={() => onTagToggle(tag)}
                  >
                    <span className="dropdown-item-icon">
                      {isSelected ? <Check size={14} strokeWidth={2} /> : <Circle size={14} strokeWidth={2} />}
                    </span>
                    <span className="dropdown-item-label">{tag}</span>
                  </div>
                );
              })}
              {hasSelection && (
                <>
                  <div style={{ height: '1px', background: '#e0e0e0', margin: '4px 0' }} />
                  <div
                    className="control-dropdown-item"
                    onClick={() => { onTagsClear(); setIsOpen(false); }}
                    style={{ color: '#666', fontSize: '12px' }}
                  >
                    <span className="dropdown-item-label">Clear all</span>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function NavigatorControls({
  filter,
  sortBy,
  onFilterChange,
  onSortChange,
  availableTags,
  selectedTags,
  onTagToggle,
  onTagsClear,
}: NavigatorControlsProps) {
  return (
    <div className="navigator-controls">
      <ControlDropdown
        icon={Filter}
        label={getFilterLabel(filter)}
        value={filter}
        options={FILTER_OPTIONS}
        onChange={onFilterChange}
      />
      
      <ControlDropdown
        icon={ArrowUpDown}
        label={getSortLabel(sortBy)}
        value={sortBy}
        options={SORT_OPTIONS}
        onChange={onSortChange}
      />
      
      <TagsDropdown
        availableTags={availableTags}
        selectedTags={selectedTags}
        onTagToggle={onTagToggle}
        onTagsClear={onTagsClear}
      />
    </div>
  );
}
