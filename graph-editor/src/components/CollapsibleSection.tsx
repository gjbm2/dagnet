import React, { useState } from 'react';

interface CollapsibleSectionProps {
  title: string | React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  isOpen?: boolean;
  onToggle?: () => void;
}

export default function CollapsibleSection({ 
  title, 
  defaultOpen = true, 
  children, 
  isOpen: externalIsOpen, 
  onToggle 
}: CollapsibleSectionProps) {
  const [internalIsOpen, setInternalIsOpen] = useState(defaultOpen);
  
  // Use external state if provided, otherwise use internal state
  const isOpen = externalIsOpen !== undefined ? externalIsOpen : internalIsOpen;
  const handleToggle = onToggle || (() => setInternalIsOpen(!internalIsOpen));

  return (
    <div style={{ borderBottom: '1px solid #e9ecef' }}>
      {/* Header */}
      <button
        onClick={handleToggle}
        style={{
          width: '100%',
          padding: '12px 16px',
          background: '#f8f9fa',
          border: 'none',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: 'pointer',
          fontSize: '14px',
          fontWeight: '600',
          color: '#212529',
          textAlign: 'left'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
          {title}
        </div>
        <span style={{ 
          fontSize: '18px',
          transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform 0.2s'
        }}>
          ▼
        </span>
      </button>

      {/* Content */}
      {isOpen && (
        <div>
          {children}
        </div>
      )}
    </div>
  );
}

