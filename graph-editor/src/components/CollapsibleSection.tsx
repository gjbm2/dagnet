import React, { useState, useRef, useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import './CollapsibleSection.css';

interface CollapsibleSectionProps {
  title: string | React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  isOpen?: boolean;
  onToggle?: () => void;
  icon?: React.ElementType; // Changed from string to Lucide icon component
  badge?: string;
  // Checkbox-enabled variant
  withCheckbox?: boolean;
  checkboxChecked?: boolean;
  onCheckboxChange?: (checked: boolean) => void;
}

export default function CollapsibleSection({ 
  title, 
  defaultOpen = true, 
  children, 
  isOpen: externalIsOpen, 
  onToggle,
  icon,
  badge,
  withCheckbox = false,
  checkboxChecked = false,
  onCheckboxChange
}: CollapsibleSectionProps) {
  const [internalIsOpen, setInternalIsOpen] = useState(defaultOpen);
  const contentRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);
  
  // Use external state if provided, otherwise use internal state
  const isOpen = externalIsOpen !== undefined ? externalIsOpen : internalIsOpen;
  const handleToggle = onToggle || (() => setInternalIsOpen(!internalIsOpen));

  // Measure content height for smooth animation
  useEffect(() => {
    const updateHeight = () => {
      if (contentRef.current) {
        setContentHeight(contentRef.current.scrollHeight);
      }
    };
    
    updateHeight();
    
    // Use ResizeObserver to detect when content changes size (e.g., nested sections expanding)
    if (contentRef.current) {
      const resizeObserver = new ResizeObserver(() => {
        updateHeight();
      });
      
      resizeObserver.observe(contentRef.current);
      
      return () => {
        resizeObserver.disconnect();
      };
    }
  }, [children, isOpen]);

  // Auto-expand when checkbox is first enabled (not when it stays enabled)
  const prevCheckboxCheckedRef = useRef(checkboxChecked);
  useEffect(() => {
    // Only auto-open if checkbox just became checked (transition from false to true)
    if (withCheckbox && checkboxChecked && !prevCheckboxCheckedRef.current && !isOpen) {
      // Auto-open the section when checkbox is enabled
      if (onToggle) {
        onToggle();
      } else {
        setInternalIsOpen(true);
      }
    }
    prevCheckboxCheckedRef.current = checkboxChecked;
  }, [withCheckbox, checkboxChecked, isOpen, onToggle]);

  // Scroll section into view when opened (with smooth scrolling)
  useEffect(() => {
    if (isOpen && sectionRef.current) {
      // Small delay to allow animation to start
      setTimeout(() => {
        if (sectionRef.current) {
          const rect = sectionRef.current.getBoundingClientRect();
          const isVisible = (
            rect.top >= 0 &&
            rect.bottom <= window.innerHeight
          );
          
          // Only scroll if the section is not fully visible
          if (!isVisible) {
            sectionRef.current.scrollIntoView({ 
              behavior: 'smooth', 
              block: 'nearest'
            });
          }
        }
      }, 50);
    }
  }, [isOpen]);

  // Handle checkbox click separately from header toggle
  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onCheckboxChange) {
      onCheckboxChange(!checkboxChecked);
    }
  };

  return (
    <div ref={sectionRef} className="collapsible-section">
      {/* Header */}
      <div
        className={`collapsible-section-header ${withCheckbox ? 'with-checkbox' : ''} ${isOpen ? 'is-open' : ''}`}
        onClick={handleToggle}
      >
        <div className="collapsible-section-header-left">
          <ChevronRight 
            className={`collapsible-section-expand-icon ${isOpen ? 'open' : ''}`}
            size={14}
            strokeWidth={2}
          />
          
          {icon && React.createElement(icon, { 
            className: "collapsible-section-icon",
            size: 16,
            strokeWidth: 2
          })}
          
          <div className="collapsible-section-title">
            {title}
          </div>
          
          {badge && (
            <span className="collapsible-section-badge">{badge}</span>
          )}
        </div>
        
        {/* Checkbox in top right corner when enabled */}
        {withCheckbox && (
          <input
            type="checkbox"
            className="collapsible-section-checkbox"
            checked={checkboxChecked}
            onChange={() => {}}
            onClick={handleCheckboxClick}
            title={checkboxChecked ? "Disable" : "Enable"}
          />
        )}
      </div>

      {/* Content (animated) */}
      <div 
        className={`collapsible-section-content ${isOpen ? 'open' : ''}`}
        style={{
          maxHeight: isOpen ? `${contentHeight}px` : '0px'
        }}
      >
        <div ref={contentRef} className="collapsible-section-content-inner">
          {children}
        </div>
      </div>
    </div>
  );
}

