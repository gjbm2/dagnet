import React, { useState, useEffect, useRef } from 'react';
import { useSnapToSlider } from '@/hooks/useSnapToSlider';

interface ProbabilityInputProps {
  value: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  onRebalance?: (value: number) => void;
  onHistorySave?: (value: number, action: string) => void;
  onClose?: () => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  style?: React.CSSProperties;
  className?: string;
  showSlider?: boolean;
  showBalanceButton?: boolean;
  inputType?: 'number' | 'range';
  disabled?: boolean;
  autoFocus?: boolean;
  autoSelect?: boolean;
  balanceButtonStyle?: React.CSSProperties;
}

export default function ProbabilityInput({
  value,
  onChange,
  onCommit,
  onRebalance,
  onHistorySave,
  onClose,
  min = 0,
  max = 1,
  step = 0.01,
  placeholder = "0.5",
  style = {},
  className = "",
  showSlider = true,
  showBalanceButton = false,
  inputType = 'number',
  disabled = false,
  autoFocus = false,
  autoSelect = false,
  balanceButtonStyle = {}
}: ProbabilityInputProps) {
  const { snapValue, shouldAutoRebalance, scheduleRebalance, handleMouseDown } = useSnapToSlider();
  const [displayValue, setDisplayValue] = useState<string>(String(value));
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Update display value when external value changes (but not while editing)
  useEffect(() => {
    if (!isEditing) {
      setDisplayValue(String(value));
    }
  }, [value, isEditing]);

  // Auto-focus and select text when component mounts or autoFocus changes
  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
      if (autoSelect) {
        inputRef.current.select();
      }
    }
  }, [autoFocus, autoSelect]);

  // Parse input value with flexible parsing (handles ".2", "20%", "0.2", etc.)
  const parseInputValue = (input: string): number | null => {
    if (!input.trim()) return null;
    
    // Handle percentage
    if (input.includes('%')) {
      const percentValue = parseFloat(input.replace('%', ''));
      if (!isNaN(percentValue)) {
        return percentValue / 100;
      }
    }
    
    // Handle decimal
    const decimalValue = parseFloat(input);
    if (!isNaN(decimalValue)) {
      return decimalValue;
    }
    
    return null;
  };

  // Validate if input is a valid number
  const isValidInput = (input: string): boolean => {
    const parsed = parseInputValue(input);
    return parsed !== null && parsed >= min && parsed <= max;
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const inputValue = e.target.value;
    setDisplayValue(inputValue);
    setIsEditing(true);
    
    // Only update slider and graph if input is valid
    const parsed = parseInputValue(inputValue);
    if (parsed !== null) {
      const snappedValue = snapValue(parsed);
      onChange(snappedValue);
    }
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = parseFloat(e.target.value);
    const snappedValue = snapValue(rawValue);
    onChange(snappedValue);
    
    // Update display value to match slider
    setDisplayValue(String(snappedValue));
    
    // Debounce the expensive operations but DON'T commit yet (no history save)
    clearTimeout((window as any).probabilitySliderTimeout);
    (window as any).probabilitySliderTimeout = setTimeout(() => {
      if (onCommit) {
        onCommit(snappedValue);
      }
      
      // Auto-rebalance if CTRL is held (but still no history save)
      if (onRebalance) {
        scheduleRebalance(() => onRebalance(snappedValue));
      }
    }, 50);
  };
  
  const handleSliderCommit = () => {
    // Called on mouseup/blur - this is when we save history
    if (onHistorySave) {
      onHistorySave(value, shouldAutoRebalance() ? 'Update and balance' : 'Update');
    }
  };

  const handleCommit = (inputValue: string, shouldSaveHistory: boolean = true) => {
    const parsed = parseInputValue(inputValue);
    if (parsed !== null) {
      const snappedValue = snapValue(parsed);
      
      // Update display value to show the committed value
      setDisplayValue(String(snappedValue));
      setIsEditing(false);
      
      if (onCommit) {
        onCommit(snappedValue);
      }
      
      // Auto-rebalance if CTRL is held
      if (onRebalance) {
        scheduleRebalance(() => onRebalance(snappedValue));
      }
      
      // Save history ONLY when explicitly requested (blur, ENTER, CTRL+ENTER)
      if (shouldSaveHistory && onHistorySave) {
        onHistorySave(snappedValue, shouldAutoRebalance() ? 'Update and balance' : 'Update');
      }
      
      return true; // Success
    }
    
    // Invalid input - revert to original value
    setDisplayValue(String(value));
    setIsEditing(false);
    return false; // Failed
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const success = handleCommit(e.currentTarget.value, true); // Save history on ENTER
      
      // If CTRL is held, also trigger rebalance
      if (success && e.ctrlKey && onRebalance) {
        const parsed = parseInputValue(e.currentTarget.value);
        if (parsed !== null) {
          const snappedValue = snapValue(parsed);
          onRebalance(snappedValue);
        }
      }
      
      if (success && onClose) {
        onClose();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (onClose) {
        onClose();
      }
    }
  };

  const handleBlur = () => {
    const success = handleCommit(displayValue, true); // Save history on blur
    if (!success) {
      // Invalid input - revert gracefully
      setDisplayValue(String(value));
      setIsEditing(false);
    }
  };

  const handleFocus = () => {
    setIsEditing(true);
  };

  const commonInputProps = {
    min,
    max,
    step,
    disabled,
    onMouseDown: handleMouseDown,
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    style: {
      ...style,
      ...(inputType === 'number' ? { width: '60px', padding: '4px' } : { flex: 1, minWidth: '300px', height: '4px' })
    }
  };

  return (
    <div className={`probability-input ${className}`} style={{ display: 'flex', gap: '6px', alignItems: 'center', width: '100%' }}>
      {inputType === 'number' && (
        <input
          ref={inputRef}
          type="text" // Use text instead of number for better control
          value={displayValue}
          onChange={handleNumberChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onFocus={handleFocus}
          placeholder={placeholder}
          {...commonInputProps}
        />
      )}
      
      {showSlider && (
        <input
          type="range"
          value={value}
          onChange={handleSliderChange}
          onMouseUp={handleSliderCommit}
          {...commonInputProps}
        />
      )}
      
      <span style={{ fontSize: '10px', color: '#666', minWidth: '25px' }}>
        {(value * 100).toFixed(0)}%
      </span>
      
      {showBalanceButton && onRebalance && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRebalance(value);
          }}
          style={{
            padding: '4px 8px',
            fontSize: '11px',
            background: '#f8f9fa',
            border: '1px solid #ddd',
            borderRadius: '3px',
            cursor: 'pointer',
            ...balanceButtonStyle
          }}
          title="Rebalance siblings proportionally"
        >
          ⚖️
        </button>
      )}
    </div>
  );
}
