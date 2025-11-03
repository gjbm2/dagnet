import React, { useState, useRef, useEffect } from 'react';
import './ColorSelector.css';

interface ColorSelectorProps {
  /** Current color value */
  value: string;
  /** Callback when color changes */
  onChange: (color: string) => void;
  /** Optional label */
  label?: string;
  /** Whether the selector is disabled */
  disabled?: boolean;
  /** Compact mode: shows only current color swatch, opens popup on click */
  compact?: boolean;
}

// Standard preset colors (9 options)
const PRESET_COLORS = [
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
 * ColorSelector Component
 * 
 * Color picker with standard presets and custom option.
 * Features:
 * - 9 preset colors in a grid
 * - Custom color option using HTML5 color picker
 * - Clean visual design
 */
export function ColorSelector({
  value,
  onChange,
  label = 'Color',
  disabled = false,
  compact = false
}: ColorSelectorProps) {
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customColor, setCustomColor] = useState(value);
  const [showPopup, setShowPopup] = useState(false);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const compactSwatchRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Update customColor when value changes externally
  useEffect(() => {
    setCustomColor(value);
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
    // Trigger native color picker
    setTimeout(() => {
      colorInputRef.current?.click();
    }, 0);
  };

  const handleCustomColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newColor = e.target.value;
    setCustomColor(newColor);
    onChange(newColor);
    if (compact) {
      setShowPopup(false);
    }
  };

  // Check if current value is a preset
  const isPreset = PRESET_COLORS.some(preset => preset.value === value);

  // Compact mode: just show a small color swatch
  if (compact) {
    return (
      <div className="color-selector-compact">
        <div
          ref={compactSwatchRef}
          className="color-selector-compact-swatch"
          style={{ backgroundColor: value }}
          onClick={() => !disabled && setShowPopup(!showPopup)}
          title="Change color"
        />
        {showPopup && (
          <div ref={popupRef} className="color-selector-compact-popup">
            {/* Preset colors grid */}
            <div className="color-selector-presets">
              {PRESET_COLORS.map(preset => (
                <button
                  key={preset.value}
                  type="button"
                  className={`color-selector-preset ${value === preset.value ? 'selected' : ''}`}
                  style={{ backgroundColor: preset.value }}
                  onClick={() => handlePresetClick(preset.value)}
                  disabled={disabled}
                  title={preset.name}
                >
                  {value === preset.value && (
                    <span className="color-selector-checkmark">✓</span>
                  )}
                </button>
              ))}

              {/* Custom color button */}
              <button
                type="button"
                className={`color-selector-preset custom ${!isPreset ? 'selected' : ''}`}
                style={{ 
                  backgroundColor: !isPreset ? value : '#fff',
                  border: '2px dashed #9CA3AF'
                }}
                onClick={handleCustomClick}
                disabled={disabled}
                title="Custom color"
              >
                {!isPreset && (
                  <span className="color-selector-checkmark">✓</span>
                )}
                {isPreset && <span style={{ fontSize: '16px' }}>+</span>}
              </button>
            </div>

            {/* Hidden HTML5 color input - positioned near popup for better picker placement */}
            <input
              ref={colorInputRef}
              type="color"
              value={customColor}
              onChange={handleCustomColorChange}
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
    <div className="color-selector">
      {/* Label */}
      <label className="color-selector-label">
        {label}:
      </label>

      {/* Preset colors grid */}
      <div className="color-selector-presets">
        {PRESET_COLORS.map(preset => (
          <button
            key={preset.value}
            type="button"
            className={`color-selector-preset ${value === preset.value ? 'selected' : ''}`}
            style={{ backgroundColor: preset.value }}
            onClick={() => handlePresetClick(preset.value)}
            disabled={disabled}
            title={preset.name}
          >
            {value === preset.value && (
              <span className="color-selector-checkmark">✓</span>
            )}
          </button>
        ))}

        {/* Custom color button */}
        <button
          type="button"
          className={`color-selector-preset custom ${!isPreset ? 'selected' : ''}`}
          style={{ 
            backgroundColor: !isPreset ? value : '#fff',
            border: '2px dashed #9CA3AF'
          }}
          onClick={handleCustomClick}
          disabled={disabled}
          title="Custom color"
        >
          {!isPreset && (
            <span className="color-selector-checkmark">✓</span>
          )}
          {isPreset && <span style={{ fontSize: '16px' }}>+</span>}
        </button>

        {/* Hidden HTML5 color input - positioned for better picker placement */}
        <input
          ref={colorInputRef}
          type="color"
          value={customColor}
          onChange={handleCustomColorChange}
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
    </div>
  );
}

