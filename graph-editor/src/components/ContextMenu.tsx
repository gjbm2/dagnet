import React, { useEffect, ReactNode } from 'react';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  divider?: boolean;
  submenu?: ContextMenuItem[];
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * Generic Context Menu Component
 * Reusable for tabs, navigator items, etc.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  // Close on click outside or escape
  useEffect(() => {
    const handleClick = () => onClose();
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    
    setTimeout(() => {
      document.addEventListener('click', handleClick);
      document.addEventListener('contextmenu', handleClick);
      document.addEventListener('keydown', handleEscape);
    }, 0);

    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('contextmenu', handleClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const renderItem = (item: ContextMenuItem, index: number) => {
    if (item.divider) {
      return (
        <div 
          key={`divider-${index}`}
          style={{ height: '1px', background: '#e9ecef', margin: '4px 0' }} 
        />
      );
    }

    if (item.submenu) {
      return (
        <div
          key={index}
          style={{
            padding: '8px 12px',
            cursor: item.disabled ? 'not-allowed' : 'pointer',
            borderRadius: '2px',
            opacity: item.disabled ? 0.5 : 1,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}
          onMouseEnter={(e) => !item.disabled && (e.currentTarget.style.background = '#f8f9fa')}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          <span>{item.label}</span>
          <span>›</span>
        </div>
      );
    }

    return (
      <div
        key={index}
        onClick={(e) => {
          if (!item.disabled) {
            e.stopPropagation();
            item.onClick();
            onClose();
          }
        }}
        style={{
          padding: '8px 12px',
          cursor: item.disabled ? 'not-allowed' : 'pointer',
          borderRadius: '2px',
          opacity: item.disabled ? 0.5 : 1
        }}
        onMouseEnter={(e) => !item.disabled && (e.currentTarget.style.background = '#f8f9fa')}
        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
      >
        {item.label}
      </div>
    );
  };

  return (
    <div
      style={{
        position: 'fixed',
        left: x,
        top: y,
        background: '#fff',
        border: '1px solid #dee2e6',
        borderRadius: '6px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        minWidth: '200px',
        padding: '4px',
        zIndex: 10000,
        fontSize: '13px'
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, index) => renderItem(item, index))}
    </div>
  );
}

