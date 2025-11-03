/**
 * NavigatorControls
 * 
 * Compact control bar for filtering, sorting, and grouping Navigator items
 */

import React, { useState, useRef, useEffect } from 'react';
import { List, Circle, CircleDot, HardDrive } from 'lucide-react';
import './NavigatorControls.css';

export type FilterMode = 'all' | 'dirty' | 'open' | 'local';
export type SortMode = 'name' | 'modified' | 'opened' | 'status' | 'type';
export type GroupMode = 'type' | 'tags' | 'status' | 'none';

interface NavigatorControlsProps {
  filter: FilterMode;
  sortBy: SortMode;
  groupBy: GroupMode;
  onFilterChange: (filter: FilterMode) => void;
  onSortChange: (sort: SortMode) => void;
  onGroupChange: (group: GroupMode) => void;
}

interface DropdownOption<T> {
  value: T;
  label: string;
  icon?: string;
}

const FILTER_OPTIONS: DropdownOption<FilterMode>[] = [
  { value: 'all', label: 'All', icon: '☑' },
  { value: 'dirty', label: 'Dirty', icon: '○' },
  { value: 'open', label: 'Open', icon: '○' },
  { value: 'local', label: 'Local', icon: '○' },
];

const SORT_OPTIONS: DropdownOption<SortMode>[] = [
  { value: 'name', label: 'Name (A→Z)' },
  { value: 'modified', label: 'Modified (Recent)' },
  { value: 'opened', label: 'Opened (Recent)' },
  { value: 'status', label: 'Status (Dirty first)' },
  { value: 'type', label: 'Type (A→Z)' },
];

const GROUP_OPTIONS: DropdownOption<GroupMode>[] = [
  { value: 'type', label: 'By Type', icon: '☑' },
  { value: 'tags', label: 'By Tags', icon: '○' },
  { value: 'status', label: 'By Status', icon: '○' },
  { value: 'none', label: 'Flat list', icon: '○' },
];

function getFilterLabel(filter: FilterMode): string {
  return FILTER_OPTIONS.find(o => o.value === filter)?.label || 'All';
}

function getSortLabel(sort: SortMode): string {
  const option = SORT_OPTIONS.find(o => o.value === sort);
  // Show short labels
  switch (sort) {
    case 'name': return 'Name';
    case 'modified': return 'Modified';
    case 'opened': return 'Opened';
    case 'status': return 'Status';
    case 'type': return 'Type';
    default: return option?.label || 'Name';
  }
}

function getGroupLabel(group: GroupMode): string {
  switch (group) {
    case 'type': return 'Type';
    case 'tags': return 'Tags';
    case 'status': return 'Status';
    case 'none': return 'Flat';
    default: return 'Type';
  }
}

interface ControlDropdownProps<T extends string> {
  icon: string;
  label: string;
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
}

function ControlDropdown<T extends string>({
  icon,
  label,
  value,
  options,
  onChange
}: ControlDropdownProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  // Calculate dropdown position when opening
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

  // Close dropdown when clicking outside
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
          <span className="control-button-icon">{icon}</span>
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
              {option.icon && <span className="dropdown-item-icon">{option.icon}</span>}
              <span className="dropdown-item-label">{option.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function NavigatorControls({
  filter,
  sortBy,
  groupBy,
  onFilterChange,
  onSortChange,
  onGroupChange
}: NavigatorControlsProps) {
  return (
    <div className="navigator-controls">
      <ControlDropdown
        icon="🎯"
        label={getFilterLabel(filter)}
        value={filter}
        options={FILTER_OPTIONS}
        onChange={onFilterChange}
      />
      
      <ControlDropdown
        icon="↕"
        label={getSortLabel(sortBy)}
        value={sortBy}
        options={SORT_OPTIONS}
        onChange={onSortChange}
      />
      
      <ControlDropdown
        icon="📁"
        label={getGroupLabel(groupBy)}
        value={groupBy}
        options={GROUP_OPTIONS}
        onChange={onGroupChange}
      />
    </div>
  );
}

