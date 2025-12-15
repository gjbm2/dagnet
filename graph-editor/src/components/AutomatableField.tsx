import React, { useState, useEffect, useRef } from 'react';
import { ZapOff } from 'lucide-react';
import { useGraphStore } from '../contexts/GraphStoreContext';
import './AutomatableField.css';

interface AutomatableFieldProps {
  // Value & state
  value: any;
  overridden: boolean;
  
  // Handlers
  onChange?: (newValue: any) => void;  // Optional - children handle their own onChange
  onClearOverride: () => void;  // Just clears the flag, no sync
  
  // Animation trigger (managed by parent)
  justUpdated?: boolean;  // Triggers expand/shrink animation
  
  // Display
  label: string;
  children: React.ReactNode;  // The actual input component
  tooltip?: string;  // Optional tooltip to display on hover
  
  // New: Layout options
  labelExtra?: React.ReactNode;  // Additional content in label row (e.g., Info icon)
  layout?: 'default' | 'label-above';  // default = inline label+icon, label-above = row above input
  
  // Optional
  disabled?: boolean;
  className?: string;
}

/**
 * AutomatableField - Wrapper for fields that can be auto-synced
 * 
 * Features:
 * - Always shows ZapOff icon (disabled when not overridden, enabled when overridden OR dirty)
 * - Tracks dirty state internally (icon lights up immediately when user types)
 * - Click ZapOff when enabled to clear override flag
 * - Animate when value changes from automated update
 * 
 * Usage:
 * <AutomatableField
 *   label="Label"
 *   value={node.label}
 *   overridden={node.label_overridden || false}
 *   onClearOverride={() => updateNode('label_overridden', false)}
 *   justUpdated={recentlyUpdatedFields.has('label')}
 * >
 *   <input value={node.label} onChange={...} />
 * </AutomatableField>
 */
export function AutomatableField({
  value,
  overridden,
  onChange,
  onClearOverride,
  justUpdated = false, // DEPRECATED: Not used, animation now automatic
  label,
  children,
  tooltip,
  labelExtra,
  layout = 'default',
  disabled = false,
  className = ''
}: AutomatableFieldProps) {
  const { isAutoUpdating } = useGraphStore();
  const [isDirty, setIsDirty] = useState(false);
  const [shouldAnimate, setShouldAnimate] = useState(false);
  const [shouldPulseOverrideIcon, setShouldPulseOverrideIcon] = useState(false);
  const [hasFocus, setHasFocus] = useState(false);
  const [isInteracting, setIsInteracting] = useState(false);
  const prevValueRef = useRef(value);
  const prevOverriddenRef = useRef(overridden);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const animationTimeoutRef = useRef<NodeJS.Timeout>();
  const overridePulseTimeoutRef = useRef<NodeJS.Timeout>();
  
  // Reset dirty when override changes (clear action or external set)
  useEffect(() => {
    if (overridden) {
      setIsDirty(false);
    }
  }, [overridden]);

  // Pulse when a field becomes overridden (user manual edit commits)
  useEffect(() => {
    const prev = prevOverriddenRef.current;
    const curr = overridden;
    prevOverriddenRef.current = curr;

    if (!prev && curr) {
      if (animationTimeoutRef.current) {
        clearTimeout(animationTimeoutRef.current);
      }
      if (overridePulseTimeoutRef.current) {
        clearTimeout(overridePulseTimeoutRef.current);
      }
      setShouldAnimate(true);
      setShouldPulseOverrideIcon(true);
      overridePulseTimeoutRef.current = setTimeout(() => {
        setShouldAnimate(false);
        setShouldPulseOverrideIcon(false);
        animationTimeoutRef.current = undefined;
        overridePulseTimeoutRef.current = undefined;
      }, 600);
    }
  }, [overridden]);
  
  // Track mouse/touch interactions AND focus on any descendant element
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    
    const handleInteractionStart = () => setIsInteracting(true);
    const handleInteractionEnd = () => setIsInteracting(false);
    
    // Use focusin/focusout which bubble (unlike focus/blur)
    const handleFocusIn = () => setHasFocus(true);
    const handleFocusOut = () => setHasFocus(false);
    
    // Track mouse/touch interactions
    wrapper.addEventListener('mousedown', handleInteractionStart);
    wrapper.addEventListener('touchstart', handleInteractionStart);
    document.addEventListener('mouseup', handleInteractionEnd);
    document.addEventListener('touchend', handleInteractionEnd);
    
    // Track focus on any descendant
    wrapper.addEventListener('focusin', handleFocusIn);
    wrapper.addEventListener('focusout', handleFocusOut);
    
    return () => {
      wrapper.removeEventListener('mousedown', handleInteractionStart);
      wrapper.removeEventListener('touchstart', handleInteractionStart);
      document.removeEventListener('mouseup', handleInteractionEnd);
      document.removeEventListener('touchend', handleInteractionEnd);
      wrapper.removeEventListener('focusin', handleFocusIn);
      wrapper.removeEventListener('focusout', handleFocusOut);
    };
  }, []);
  
  // Detect external value changes (from GET operations)
  // Simplified: only animate when isAutoUpdating is true
  useEffect(() => {
    const valueChanged = value !== prevValueRef.current;
    
    console.log('[AutomatableField] Animation check:', {
      valueChanged,
      hasFocus,
      isInteracting,
      isAutoUpdating,
      oldValue: prevValueRef.current,
      newValue: value,
      willAnimate: valueChanged && !hasFocus && !isInteracting && isAutoUpdating
    });
    
    // Only animate if:
    // 1. Value actually changed
    // 2. User isn't interacting (no focus, no mouse/touch)  
    // 3. isAutoUpdating flag is set (GET operation is running)
    if (valueChanged && !hasFocus && !isInteracting && isAutoUpdating) {
      console.log('🎬 [AutomatableField] ANIMATING!');
      // Clear any existing animation timeout
      if (animationTimeoutRef.current) {
        clearTimeout(animationTimeoutRef.current);
      }
      
      setShouldAnimate(true);
      // Clear animation after it completes
      animationTimeoutRef.current = setTimeout(() => {
        setShouldAnimate(false);
        animationTimeoutRef.current = undefined;
      }, 600);
    }
    
    // Update value ref to track changes
    prevValueRef.current = value;
    
    // Cleanup on unmount
    return () => {
      if (animationTimeoutRef.current) {
        clearTimeout(animationTimeoutRef.current);
      }
    };
  }, [value, hasFocus, isInteracting, isAutoUpdating]);
  
  // Enhanced children with dirty tracking and focus detection
  const enhancedChildren = React.Children.map(children, child => {
    if (React.isValidElement(child)) {
      const originalOnChange = (child.props as any).onChange;
      const originalOnBlur = (child.props as any).onBlur;
      const originalOnFocus = (child.props as any).onFocus;
      
      return React.cloneElement(child as React.ReactElement<any>, {
        title: tooltip,  // Pass tooltip to child input element
        onFocus: (e: any) => {
          setHasFocus(true);
          if (originalOnFocus) {
            originalOnFocus(e);
          }
        },
        onChange: (e: any) => {
          // Mark as dirty when user edits (if not already overridden)
          if (!overridden) {
            setIsDirty(true);
          }
          // Call original onChange
          if (originalOnChange) {
            originalOnChange(e);
          }
        },
        onBlur: (e: any) => {
          setHasFocus(false);
          // Call original onBlur first (this will set overridden flag)
          if (originalOnBlur) {
            originalOnBlur(e);
          }
          // Clear dirty state after commit
          setIsDirty(false);
        }
      });
    }
    return child;
  });
  
  const showAsEnabled = overridden || isDirty;
  
  // Render ZapOff button
  const renderZapOffButton = () => (
    <button
      className={`override-toggle ${!showAsEnabled ? 'disabled' : ''} ${shouldPulseOverrideIcon ? 'pulse-override' : ''}`}
      onClick={() => {
        onClearOverride();
        setIsDirty(false);
      }}
      disabled={!showAsEnabled || disabled}
      aria-label={showAsEnabled ? "Clear manual override" : "Auto-sync enabled"}
      title={showAsEnabled ? "Click to clear override" : "Auto-sync enabled"}
      type="button"
    >
      <ZapOff size={12} />
    </button>
  );
  
  if (layout === 'label-above') {
    return (
      <div className={`automatable-field-container ${className}`}>
        {/* Label row: label + labelExtra + ZapOff */}
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '6px', 
          marginBottom: '8px'
        }}>
          <label style={{ 
            fontSize: '12px', 
            fontWeight: '600', 
            color: '#333',
            margin: 0
          }}>
            {label}
          </label>
          {labelExtra}
          {renderZapOffButton()}
        </div>
        
        {/* Input row: just the input field (with animation) */}
        <div 
          ref={wrapperRef}
          className={`automatable-field-input ${shouldAnimate ? 'animate-update' : ''}`}
        >
          {enhancedChildren}
        </div>
      </div>
    );
  }
  
  // Default layout: inline (existing behavior)
  return (
    <div 
      ref={wrapperRef}
      className={`automatable-field-wrapper ${shouldAnimate ? 'animate-update' : ''} ${className}`}
    >
      {/* User's input component with enhanced handlers */}
      {enhancedChildren}
      
      {/* ZapOff icon button - always present, right side */}
      {renderZapOffButton()}
    </div>
  );
}

