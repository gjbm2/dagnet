import React, { useEffect, ReactNode, useRef, useState } from 'react';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  divider?: boolean;
  submenu?: ContextMenuItem[];
  keepMenuOpen?: boolean; // If true, don't close menu after onClick
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
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Calculate constrained position on mount
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const menuWidth = rect.width;
      const menuHeight = rect.height;
      
      let left = x;
      let top = y;
      
      // Constrain horizontally
      const viewportWidth = window.innerWidth;
      if (left + menuWidth > viewportWidth - 20) {
        left = Math.max(20, viewportWidth - menuWidth - 20);
      }
      if (left < 20) {
        left = 20;
      }
      
      // Constrain vertically
      const viewportHeight = window.innerHeight;
      if (top + menuHeight > viewportHeight - 20) {
        // Try to show above the cursor position
        const aboveY = y - menuHeight - 4;
        if (aboveY > 20) {
          top = aboveY;
        } else {
          top = Math.max(20, viewportHeight - menuHeight - 20);
        }
      }
      if (top < 20) {
        top = 20;
      }
      
      setPosition({ left, top });
    }
  }, [x, y]);

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
            if (!item.keepMenuOpen) {
              onClose();
            }
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
      ref={menuRef}
      style={{
        position: 'fixed',
        left: position.left,
        top: position.top,
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

