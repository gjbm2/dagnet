import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import './ColourSelector.css';

interface ColourSelectorProps {
  /** Current colour value */
  value: string;
  /** Callback when colour changes */
  onChange: (colour: string) => void;
  /** Optional label */
  label?: string;
  /** Whether the selector is disabled */
  disabled?: boolean;
  /** Compact mode: shows only current colour swatch, opens popup on click */
  compact?: boolean;
  /** Custom preset colours array (defaults to standard presets) */
  presetColours?: Array<{ name: string; value: string }>;
  /** Optional callback when colour is cleared/reset */
  onClear?: () => void;
  /** Show clear/reset button */
  showClear?: boolean;
  /** Extra content rendered at the bottom of the compact popup */
  extraContent?: React.ReactNode;
}

/** Overlay connector preset colours — shared across toolbar, props panel, and context menu. */
export const OVERLAY_PRESET_COLOURS: Array<{ name: string; value: string }> = [
  { name: 'Amber', value: '#f59e0b' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Purple', value: '#8b5cf6' },
  { name: 'Pink', value: '#ec4899' },
];

// Standard preset colours (9 options)
const PRESET_COLOURS = [
  { name: 'Blue', value: '#3B82F6' },
  { name: 'Green', value: '#10B981' },
  { name: 'Red', value: '#EF4444' },
  { name: 'Yellow', value: '#F59E0B' },
  { name: 'Purple', value: '#8B5CF6' },
  { name: 'Pink', value: '#EC4899' },
  { name: 'Indigo', value: '#6366F1' },
  { name: 'Teal', value: '#14B8A6' },
  { name: 'Orange', value: '#F97316' },
];

export function ColourSelector({
  value,
  onChange,
  label = 'Colour',
  disabled = false,
  compact = false,
  presetColours = PRESET_COLOURS,
  onClear,
  showClear = false,
  extraContent,
}: ColourSelectorProps) {
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customColour, setCustomColour] = useState(value);
  const [showPopup, setShowPopup] = useState(false);
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({});
  const colourInputRef = useRef<HTMLInputElement>(null);
  const compactSwatchRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCustomColour(value);
  }, [value]);

  // Click outside to close popup
  useEffect(() => {
    if (!compact || !showPopup) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node) &&
          compactSwatchRef.current && !compactSwatchRef.current.contains(e.target as Node)) {
        setShowPopup(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [compact, showPopup]);

  const handleSwatchClick = () => {
    if (disabled) return;
    if (showPopup) {
      setShowPopup(false);
      return;
    }
    if (!compactSwatchRef.current) return;

    const rect = compactSwatchRef.current.getBoundingClientRect();
    const top = rect.bottom + 4;
    const left = rect.left;

    setPopupStyle({
      position: 'fixed',
      top,
      left,
      zIndex: 10000,
    });
    setShowPopup(true);
  };

  const handlePresetClick = (presetValue: string) => {
    onChange(presetValue);
    setShowCustomPicker(false);
    if (compact) {
      setShowPopup(false);
    }
  };

  const handleCustomClick = () => {
    setShowCustomPicker(true);
    setTimeout(() => {
      colourInputRef.current?.click();
    }, 0);
  };

  const handleCustomColourChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newColour = e.target.value;
    setCustomColour(newColour);
    onChange(newColour);
    if (compact) {
      setShowPopup(false);
    }
  };

  const isPreset = presetColours.some(preset => preset.value === value);

  const popupContent = (
    <div
      ref={popupRef}
      className="colour-selector-compact-popup"
      style={popupStyle}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="colour-selector-presets">
        {presetColours.map(preset => (
          <button
            key={preset.value}
            type="button"
            className={`colour-selector-preset ${value === preset.value ? 'selected' : ''}`}
            style={{ backgroundColor: preset.value }}
            onClick={() => handlePresetClick(preset.value)}
            disabled={disabled}
            title={preset.name}
          >
            {value === preset.value && (
              <span className="colour-selector-checkmark">✓</span>
            )}
          </button>
        ))}
        <button
          type="button"
          className={`colour-selector-preset custom ${!isPreset ? 'selected' : ''}`}
          style={{
            backgroundColor: !isPreset ? value : '#fff',
            border: '2px dashed #9CA3AF'
          }}
          onClick={handleCustomClick}
          disabled={disabled}
          title="Custom colour"
        >
          {!isPreset && (
            <span className="colour-selector-checkmark">✓</span>
          )}
          {isPreset && <span style={{ fontSize: '16px' }}>+</span>}
        </button>
      </div>
      {extraContent}
      <input
        ref={colourInputRef}
        type="color"
        value={customColour}
        onChange={handleCustomColourChange}
        style={{
          position: 'absolute',
          bottom: '0',
          left: '0',
          width: '1px',
          height: '1px',
          opacity: 0,
          pointerEvents: 'none'
        }}
        disabled={disabled}
      />
    </div>
  );

  if (compact) {
    return (
      <div className="colour-selector-compact">
        <div
          ref={compactSwatchRef}
          className="colour-selector-compact-swatch"
          style={{ backgroundColor: value }}
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => e.preventDefault()}
          onClick={handleSwatchClick}
          title="Change colour"
        />
        {showPopup && createPortal(popupContent, document.body)}
      </div>
    );
  }

  // Normal mode
  return (
    <div className="colour-selector">
      <label className="colour-selector-label">
        {label}:
      </label>
      <div className="colour-selector-presets">
        {presetColours.map(preset => (
          <button
            key={preset.value}
            type="button"
            className={`colour-selector-preset ${value === preset.value ? 'selected' : ''}`}
            style={{ backgroundColor: preset.value }}
            onClick={() => handlePresetClick(preset.value)}
            disabled={disabled}
            title={preset.name}
          >
            {value === preset.value && (
              <span className="colour-selector-checkmark">✓</span>
            )}
          </button>
        ))}
        <button
          type="button"
          className={`colour-selector-preset custom ${!isPreset ? 'selected' : ''}`}
          style={{
            backgroundColor: !isPreset ? value : '#fff',
            border: '2px dashed #9CA3AF'
          }}
          onClick={handleCustomClick}
          disabled={disabled}
          title="Custom colour"
        >
          {!isPreset && (
            <span className="colour-selector-checkmark">✓</span>
          )}
          {isPreset && <span style={{ fontSize: '16px' }}>+</span>}
        </button>
        <input
          ref={colourInputRef}
          type="color"
          value={customColour}
          onChange={handleCustomColourChange}
          style={{
            position: 'absolute',
            bottom: '0',
            left: '0',
            width: '1px',
            height: '1px',
            opacity: 0,
            pointerEvents: 'none'
          }}
          disabled={disabled}
        />
      </div>
      {showClear && value && onClear && (
        <button
          type="button"
          onClick={onClear}
          className="colour-selector-clear"
          disabled={disabled}
          title="Reset to default"
        >
          Reset
        </button>
      )}
    </div>
  );
}
