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
  disabled = false
}: ColorSelectorProps) {
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customColor, setCustomColor] = useState(value);
  const colorInputRef = useRef<HTMLInputElement>(null);

  // Update customColor when value changes externally
  useEffect(() => {
    setCustomColor(value);
  }, [value]);

  const handlePresetClick = (presetValue: string) => {
    onChange(presetValue);
    setShowCustomPicker(false);
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
  };

  // Check if current value is a preset
  const isPreset = PRESET_COLORS.some(preset => preset.value === value);

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

        {/* Hidden HTML5 color input */}
        <input
          ref={colorInputRef}
          type="color"
          value={customColor}
          onChange={handleCustomColorChange}
          style={{ display: 'none' }}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

