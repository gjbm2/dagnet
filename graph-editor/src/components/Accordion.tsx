import React, { useState, useRef, useEffect } from 'react';
import './Accordion.css';

interface AccordionProps {
  /** Section title */
  title: string;
  /** Whether the section is open by default */
  defaultOpen?: boolean;
  /** Whether the section is currently open (controlled mode) */
  isOpen?: boolean;
  /** Callback when open state changes (controlled mode) */
  onToggle?: (isOpen: boolean) => void;
  /** Section content */
  children: React.ReactNode;
  /** Optional icon/emoji to show before title */
  icon?: string;
  /** Optional badge text (e.g., count) */
  badge?: string;
}

/**
 * Accordion Component
 * 
 * Collapsible section for the Properties panel.
 * Features:
 * - Smooth animated expand/collapse
 * - Per-section state persistence
 * - Multiple sections can be open at once
 * - Clean visual design
 */
export function Accordion({
  title,
  defaultOpen = false,
  isOpen: controlledIsOpen,
  onToggle,
  children,
  icon,
  badge
}: AccordionProps) {
  // Controlled vs uncontrolled mode
  const isControlled = controlledIsOpen !== undefined;
  const [internalIsOpen, setInternalIsOpen] = useState(defaultOpen);
  const isOpen = isControlled ? controlledIsOpen! : internalIsOpen;
  
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);

  // Measure content height for animation
  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight);
    }
  }, [children, isOpen]);

  const handleToggle = () => {
    const newIsOpen = !isOpen;
    
    if (isControlled && onToggle) {
      onToggle(newIsOpen);
    } else {
      setInternalIsOpen(newIsOpen);
    }
  };

  return (
    <div className="accordion-section">
      {/* Header */}
      <div 
        className="accordion-header"
        onClick={handleToggle}
      >
        <div className="accordion-header-left">
          {/* Expand/collapse icon */}
          <span className={`accordion-expand-icon ${isOpen ? 'open' : ''}`}>
            ▶
          </span>
          
          {/* Optional icon */}
          {icon && (
            <span className="accordion-icon">{icon}</span>
          )}
          
          {/* Title */}
          <span className="accordion-title">{title}</span>
          
          {/* Optional badge */}
          {badge && (
            <span className="accordion-badge">{badge}</span>
          )}
        </div>
      </div>

      {/* Content (animated) */}
      <div 
        className={`accordion-content ${isOpen ? 'open' : ''}`}
        style={{
          maxHeight: isOpen ? `${contentHeight}px` : '0px'
        }}
      >
        <div ref={contentRef} className="accordion-content-inner">
          {children}
        </div>
      </div>
    </div>
  );
}

