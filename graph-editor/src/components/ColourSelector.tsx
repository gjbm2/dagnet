import React, { useState, useRef, useEffect } from 'react';
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
}

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

/**
 * ColourSelector Component
 * 
 * Colour picker with standard presets and custom option.
 * Features:
 * - Configurable preset colours in a grid
 * - Custom colour option using HTML5 colour picker
 * - Clean visual design
 * - Optional clear/reset button
 */
export function ColourSelector({
  value,
  onChange,
  label = 'Colour',
  disabled = false,
  compact = false,
  presetColours = PRESET_COLOURS,
  onClear,
  showClear = false
}: ColourSelectorProps) {
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customColour, setCustomColour] = useState(value);
  const [showPopup, setShowPopup] = useState(false);
  const colourInputRef = useRef<HTMLInputElement>(null);
  const compactSwatchRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Update customColour when value changes externally
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

  const handlePresetClick = (presetValue: string) => {
    onChange(presetValue);
    setShowCustomPicker(false);
    if (compact) {
      setShowPopup(false);
    }
  };

  const handleCustomClick = () => {
    setShowCustomPicker(true);
    // Trigger native colour picker
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

  // Check if current value is a preset
  const isPreset = presetColours.some(preset => preset.value === value);

  // Compact mode: just show a small colour swatch
  if (compact) {
    return (
      <div className="colour-selector-compact">
        <div
          ref={compactSwatchRef}
          className="colour-selector-compact-swatch"
          style={{ backgroundColor: value }}
          onClick={() => !disabled && setShowPopup(!showPopup)}
          title="Change colour"
        />
        {showPopup && (
          <div ref={popupRef} className="colour-selector-compact-popup">
            {/* Preset colours grid */}
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

              {/* Custom colour button */}
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

            {/* Hidden HTML5 colour input - positioned near popup for better picker placement */}
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
        )}
      </div>
    );
  }

  // Normal mode
  return (
    <div className="colour-selector">
      {/* Label */}
      <label className="colour-selector-label">
        {label}:
      </label>

      {/* Preset colours grid */}
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

        {/* Custom colour button */}
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

        {/* Hidden HTML5 colour input - positioned for better picker placement */}
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
      
      {/* Clear button (if enabled) */}
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

