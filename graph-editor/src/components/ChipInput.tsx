/**
 * ChipInput — a simple tag/chip editor with autocomplete suggestions.
 *
 * Features:
 *  - Displays current values as removable chips
 *  - Text input for adding new values (Enter or comma to confirm)
 *  - Optional autocomplete dropdown from a suggestions list
 *  - Tag icon and helper text for discoverability
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { X, Tag } from 'lucide-react';

export interface ChipInputProps {
  /** Current chip values */
  values: string[];
  /** Called when chips change (add or remove) */
  onChange: (values: string[]) => void;
  /** Optional autocomplete suggestions */
  suggestions?: string[];
  /** Placeholder when empty */
  placeholder?: string;
  /** Accent colour for chips (defaults to grey) */
  accentColour?: string;
}

export function ChipInput({
  values,
  onChange,
  suggestions = [],
  placeholder = 'Add tag…',
  accentColour = '#9CA3AF',
}: ChipInputProps) {
  const [inputValue, setInputValue] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Filter suggestions: not already selected, matches input
  const filteredSuggestions = suggestions.filter(
    s => !values.includes(s) && s.toLowerCase().includes(inputValue.toLowerCase())
  );

  const addChip = useCallback((value: string) => {
    const trimmed = value.trim().toLowerCase();
    if (trimmed && !values.includes(trimmed)) {
      onChange([...values, trimmed]);
    }
    setInputValue('');
    setSelectedIndex(-1);
  }, [values, onChange]);

  const removeChip = useCallback((value: string) => {
    onChange(values.filter(v => v !== value));
  }, [values, onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (selectedIndex >= 0 && selectedIndex < filteredSuggestions.length) {
        addChip(filteredSuggestions[selectedIndex]);
      } else if (inputValue.trim()) {
        addChip(inputValue);
      }
    } else if (e.key === 'Backspace' && !inputValue && values.length > 0) {
      removeChip(values[values.length - 1]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, filteredSuggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, -1));
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setSelectedIndex(-1);
    }
  }, [inputValue, values, filteredSuggestions, selectedIndex, addChip, removeChip]);

  // Close suggestions on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
        setIsFocused(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const chipBg = accentColour + '20'; // 12% opacity

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <div
        className="chip-input-container"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '3px',
          padding: '3px 6px',
          border: `1px solid ${isFocused ? '#0066cc' : '#d1d5db'}`,
          borderRadius: '4px',
          background: '#fff',
          cursor: 'text',
          minHeight: '28px',
          alignItems: 'center',
          boxShadow: isFocused ? '0 0 0 3px rgba(0, 102, 204, 0.1)' : 'none',
          transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
        }}
        onClick={() => inputRef.current?.focus()}
      >
        {/* Tag icon when empty to visually distinguish from a text input */}
        {values.length === 0 && !isFocused && (
          <Tag size={12} strokeWidth={2} style={{ color: '#bbb', flexShrink: 0 }} />
        )}
        {values.map(v => (
          <span
            key={v}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '2px',
              padding: '1px 6px',
              borderRadius: '10px',
              background: chipBg,
              color: accentColour,
              fontSize: '11px',
              fontWeight: 500,
              lineHeight: '16px',
              whiteSpace: 'nowrap',
              border: `1px solid ${accentColour}40`,
            }}
          >
            {v}
            <X
              size={10}
              strokeWidth={2.5}
              style={{ cursor: 'pointer', marginLeft: '1px', opacity: 0.7 }}
              onClick={(e) => { e.stopPropagation(); removeChip(v); }}
            />
          </span>
        ))}
        <input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            setShowSuggestions(true);
            setSelectedIndex(-1);
          }}
          onFocus={() => { setIsFocused(true); setShowSuggestions(true); }}
          onBlur={() => setIsFocused(false)}
          onKeyDown={handleKeyDown}
          placeholder={values.length === 0 ? placeholder : ''}
          style={{
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontSize: '12px',
            fontFamily: 'inherit',
            flex: 1,
            minWidth: '60px',
            padding: '1px 0',
            boxShadow: 'none',
          }}
        />
      </div>

      {/* Helper text */}
      <div style={{ fontSize: '10px', color: '#999', marginTop: '2px', paddingLeft: '2px' }}>
        Type and press Enter or comma to add
      </div>

      {/* Autocomplete dropdown */}
      {showSuggestions && filteredSuggestions.length > 0 && inputValue.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 100,
            background: '#fff',
            border: '1px solid #d1d5db',
            borderRadius: '4px',
            marginTop: '2px',
            maxHeight: '140px',
            overflowY: 'auto',
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          }}
        >
          {filteredSuggestions.map((s, i) => (
            <div
              key={s}
              style={{
                padding: '4px 8px',
                fontSize: '12px',
                cursor: 'pointer',
                background: i === selectedIndex ? '#f3f4f6' : 'transparent',
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                addChip(s);
              }}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
