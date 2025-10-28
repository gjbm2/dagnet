import React, { useCallback } from 'react';
import ProbabilityInput from './ProbabilityInput';
import { useSnapToSlider } from '@/hooks/useSnapToSlider';

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
  const { shouldAutoRebalance } = useSnapToSlider();
  
  const handleRebalance = useCallback((newValue: number) => {
    onRebalance(newValue, conditionIndex, allConditions);
  }, [onRebalance, conditionIndex, allConditions]);
  
  const handleCommit = useCallback((newValue: number) => {
    // If CTRL is held, skip commit - rebalance will handle everything
    if (shouldAutoRebalance()) {
      console.log('ConditionalProbabilityInput: Skipping commit, rebalance will handle it');
      return;
    }
    onCommit(newValue);
  }, [onCommit, shouldAutoRebalance]);

  return (
    <ProbabilityInput
      value={value}
      onChange={onChange}
      onCommit={handleCommit}
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
