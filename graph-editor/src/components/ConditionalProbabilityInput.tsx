import React from 'react';
import ProbabilityInput from './ProbabilityInput';

interface ConditionalProbabilityInputProps {
  value: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
  onRebalance: (value: number, conditionIndex: number, allConditions: any[]) => void;
  onClose?: () => void;
  conditionIndex: number;
  allConditions: any[];
  style?: React.CSSProperties;
  className?: string;
  showSlider?: boolean;
  inputType?: 'number' | 'range';
  disabled?: boolean;
}

export default function ConditionalProbabilityInput({
  value,
  onChange,
  onCommit,
  onRebalance,
  onClose,
  conditionIndex,
  allConditions,
  style = {},
  className = "",
  showSlider = true,
  inputType = 'number',
  disabled = false
}: ConditionalProbabilityInputProps) {
  
  const handleRebalance = (newValue: number) => {
    onRebalance(newValue, conditionIndex, allConditions);
  };

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
    />
  );
}
