import React from 'react';
import ProbabilityInput from './ProbabilityInput';

interface VariantWeightInputProps {
  value: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
  onRebalance: (value: number, currentIndex: number, allVariants: any[]) => void;
  onClose?: () => void;
  currentIndex: number;
  allVariants: any[];
  style?: React.CSSProperties;
  className?: string;
  showSlider?: boolean;
  showBalanceButton?: boolean;
  inputType?: 'number' | 'range';
  disabled?: boolean;
  autoFocus?: boolean;
  autoSelect?: boolean;
}

export default function VariantWeightInput({
  value,
  onChange,
  onCommit,
  onRebalance,
  onClose,
  currentIndex,
  allVariants,
  style = {},
  className = "",
  showSlider = true,
  showBalanceButton = false,
  inputType = 'number',
  disabled = false,
  autoFocus = false,
  autoSelect = false
}: VariantWeightInputProps) {
  
  const handleRebalance = (newValue: number) => {
    onRebalance(newValue, currentIndex, allVariants);
  };
  
  // Calculate if weights are unbalanced (don't sum to 1.0 within tolerance)
  const totalWeight = allVariants.reduce((sum, v) => sum + (v.weight || 0), 0);
  const isUnbalanced = Math.abs(totalWeight - 1.0) > 0.001;

  return (
    <ProbabilityInput
      value={value}
      onChange={onChange}
      onCommit={onCommit}
      onRebalance={handleRebalance}
      onClose={onClose}
      min={0}
      max={1}
      step={0.01}
      placeholder="0.5"
      style={style}
      className={className}
      showSlider={showSlider}
      inputType={inputType}
      disabled={disabled}
      autoFocus={autoFocus}
      autoSelect={autoSelect}
      showBalanceButton={showBalanceButton}
      isUnbalanced={isUnbalanced}
    />
  );
}
