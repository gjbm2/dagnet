import React, { useState, useRef, useEffect } from 'react';
import './CollapsibleSection.css';

interface CollapsibleSectionProps {
  title: string | React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  isOpen?: boolean;
  onToggle?: () => void;
  icon?: string;
  badge?: string;
}

export default function CollapsibleSection({ 
  title, 
  defaultOpen = true, 
  children, 
  isOpen: externalIsOpen, 
  onToggle,
  icon,
  badge
}: CollapsibleSectionProps) {
  const [internalIsOpen, setInternalIsOpen] = useState(defaultOpen);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);
  
  // Use external state if provided, otherwise use internal state
  const isOpen = externalIsOpen !== undefined ? externalIsOpen : internalIsOpen;
  const handleToggle = onToggle || (() => setInternalIsOpen(!internalIsOpen));

  // Measure content height for smooth animation
  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight);
    }
  }, [children, isOpen]);

  return (
    <div className="collapsible-section">
      {/* Header */}
      <div
        className="collapsible-section-header"
        onClick={handleToggle}
      >
        <div className="collapsible-section-header-left">
          <span className={`collapsible-section-expand-icon ${isOpen ? 'open' : ''}`}>
            ▶
          </span>
          
          {icon && (
            <span className="collapsible-section-icon">{icon}</span>
          )}
          
          <div className="collapsible-section-title">
            {title}
          </div>
          
          {badge && (
            <span className="collapsible-section-badge">{badge}</span>
          )}
        </div>
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

