import React, { useState, useEffect, useRef } from 'react';
import { useSnapToSlider } from '@/hooks/useSnapToSlider';
import { roundTo4DP } from '@/utils/rounding';

interface ProbabilityInputProps {
  value: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  onRebalance?: (value: number) => void;
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
      // Don't snap typed values - only snap slider values, but round to 4dp
      onChange(roundTo4DP(parsed));
    }
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = parseFloat(e.target.value);
    const snappedValue = snapValue(rawValue);
    onChange(roundTo4DP(snappedValue));
    
    // Update display value to match slider
    setDisplayValue(String(snappedValue));
    
    // NO onCommit here - only onChange for real-time updates
    // onCommit should only be called on mouseUp
    
    // Auto-rebalance if CTRL is held (but no history save)
    if (onRebalance) {
      scheduleRebalance(() => onRebalance(roundTo4DP(snappedValue)));
    }
  };
  
  const handleSliderMouseUp = () => {
    // If CTRL was held during drag, rebalance should have been scheduled
    // Wait for it to complete before committing
    if (shouldAutoRebalance()) {
      // Rebalance is scheduled, it will call setGraph and saveHistoryState
      // Don't call onCommit here as rebalance handles the graph update
      return;
    }
    
    // No CTRL held - normal commit
    if (onCommit) {
      onCommit(value);
    }
  };

  const handleCommit = (inputValue: string) => {
    const parsed = parseInputValue(inputValue);
    if (parsed !== null) {
      // Don't snap typed values - only snap slider values, but round to 4dp
      const finalValue = roundTo4DP(parsed);
      
      // Update display value to show the committed value
      setDisplayValue(String(finalValue));
      setIsEditing(false);
      
      if (onCommit) {
        onCommit(finalValue);
      }
      
      // Auto-rebalance if CTRL is held
      if (onRebalance) {
        scheduleRebalance(() => onRebalance(roundTo4DP(finalValue)));
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
      const success = handleCommit(e.currentTarget.value);
      
      // If CTRL is held, also trigger rebalance
      if (success && e.ctrlKey && onRebalance) {
        const parsed = parseInputValue(e.currentTarget.value);
        if (parsed !== null) {
          // Use exact typed value for rebalance, not snapped value, but round to 4dp
          onRebalance(roundTo4DP(parsed));
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
    const success = handleCommit(displayValue);
    if (!success) {
      // Invalid input - revert gracefully
      setDisplayValue(String(value));
      setIsEditing(false);
    }
  };

  const handleFocus = () => {
    setIsEditing(true);
  };

  const numberInputProps = {
    min,
    max,
    step,
    disabled,
    onMouseDown: handleMouseDown,
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    style: {
      ...style,
      width: '50px',
      padding: '4px'
    }
  };

  const sliderProps = {
    min,
    max,
    step,
    disabled,
    onMouseDown: handleMouseDown,
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    style: {
      ...style,
      flex: 1,
      minWidth: '168px',
      height: '4px'
    }
  };

  return (
    <div className={`probability-input ${className}`} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
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
          {...numberInputProps}
        />
      )}
      
      {showSlider && (
        <input
          type="range"
          value={value}
          onChange={handleSliderChange}
          onMouseUp={handleSliderMouseUp}
          onTouchEnd={handleSliderMouseUp}
          {...sliderProps}
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
