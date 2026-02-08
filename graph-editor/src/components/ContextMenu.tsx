import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  divider?: boolean;
  submenu?: ContextMenuItem[];
  keepMenuOpen?: boolean; // If true, don't close menu after onClick
  onHover?: () => void; // Called when the item is hovered (useful for lazy-loading submenus)
}

const MIN_WIDTH_PX = 200;
const MAX_WIDTH_PX = 420;

function estimateMenuHeight(menuItems: ContextMenuItem[]) {
  const itemHeight = 30;
  const dividerHeight = 9;
  const nDividers = menuItems.filter(i => i.divider).length;
  return Math.min(600, (menuItems.length - nDividers) * itemHeight + nDividers * dividerHeight + 12);
}

function isPrefix(prefix: number[], path: number[]) {
  return prefix.every((v, i) => path[i] === v);
}

/**
 * A single level of the context menu tree.
 *
 * IMPORTANT: This component is defined at module scope (not inside ContextMenu)
 * so that React preserves its identity across parent re-renders.  Defining it
 * inside ContextMenu created a new component type on every render, which
 * unmounted/remounted the tree and reset openPath — closing submenus whenever
 * items changed (e.g. when async data arrived).
 */
interface MenuLevelProps {
  level: number;
  prefix: number[];
  levelItems: ContextMenuItem[];
  position: { left: number; top: number };
  menuRef?: React.RefObject<HTMLDivElement>;
  openPath: number[];
  setOpenPath: React.Dispatch<React.SetStateAction<number[]>>;
  onClose: () => void;
}

const MenuLevel: React.FC<MenuLevelProps> = ({
  level,
  prefix,
  levelItems,
  position,
  menuRef,
  openPath,
  setOpenPath,
  onClose,
}) => {
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);

  const prefixKey = prefix.join(',');
  const pathKey = openPath.join(',');

  const activeIndex = useMemo(() => {
    if (!isPrefix(prefix, openPath)) return undefined;
    return openPath[level];
  }, [prefixKey, pathKey, level]);

  const activeSubmenu =
    typeof activeIndex === 'number' && levelItems[activeIndex]?.submenu
      ? levelItems[activeIndex]!.submenu!
      : null;

  const activeAnchorRect = useMemo(() => {
    if (typeof activeIndex !== 'number') return null;
    const el = itemRefs.current[activeIndex];
    if (!el) return null;
    return el.getBoundingClientRect();
  }, [activeIndex, levelItems.length, pathKey]);

  const submenuPosition = useMemo(() => {
    if (!activeSubmenu || !activeAnchorRect) return null;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const estHeight = estimateMenuHeight(activeSubmenu);
    let left = activeAnchorRect.right + 4;
    let top = activeAnchorRect.top;

    if (left + MAX_WIDTH_PX > viewportWidth - 20) {
      left = Math.max(20, activeAnchorRect.left - MAX_WIDTH_PX - 4);
    }
    if (top + estHeight > viewportHeight - 20) {
      top = Math.max(20, viewportHeight - estHeight - 20);
    }
    if (top < 20) top = 20;
    return { left, top };
  }, [activeSubmenu, activeAnchorRect]);

  return (
    <>
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
          minWidth: `${MIN_WIDTH_PX}px`,
          maxWidth: `min(${MAX_WIDTH_PX}px, calc(100vw - 40px))`,
          padding: '4px',
          zIndex: 10000 + level,
          fontSize: '13px',
        }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {levelItems.map((item, index) => {
          if (item.divider) {
            return (
              <div
                key={`divider-${level}-${index}`}
                style={{ height: '1px', background: '#e9ecef', margin: '4px 0' }}
              />
            );
          }

          const isActive = typeof activeIndex === 'number' && index === activeIndex;
          const hasSubmenu = Array.isArray(item.submenu) && item.submenu.length > 0;

          return (
            <div
              key={`${level}-${index}`}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              onMouseEnter={(e) => {
                if (item.disabled) return;
                item.onHover?.();
                if (hasSubmenu) {
                  setOpenPath([...prefix, index]);
                } else {
                  setOpenPath(prefix);
                }
                e.currentTarget.style.background = '#f8f9fa';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = isActive ? '#f8f9fa' : 'transparent';
              }}
              onClick={(e) => {
                if (item.disabled) return;
                if (hasSubmenu) return;
                e.stopPropagation();
                item.onClick();
                if (!item.keepMenuOpen) onClose();
              }}
              style={{
                padding: '8px 12px',
                cursor: item.disabled ? 'not-allowed' : hasSubmenu ? 'default' : 'pointer',
                borderRadius: '2px',
                opacity: item.disabled ? 0.5 : 1,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: isActive ? '#f8f9fa' : 'transparent',
              }}
            >
              <span
                title={item.label}
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: '320px',
                }}
              >
                {item.label}
              </span>
              {hasSubmenu ? <span style={{ color: '#6B7280' }}>›</span> : null}
            </div>
          );
        })}
      </div>

      {activeSubmenu && submenuPosition && (
        <MenuLevel
          level={level + 1}
          prefix={[...prefix, activeIndex!]}
          levelItems={activeSubmenu}
          position={submenuPosition}
          openPath={openPath}
          setOpenPath={setOpenPath}
          onClose={onClose}
        />
      )}
    </>
  );
};

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
  const rootMenuRef = useRef<HTMLDivElement>(null);
  const [rootPosition, setRootPosition] = useState({ left: x, top: y });
  const [openPath, setOpenPath] = useState<number[]>([]);

  // Calculate constrained position on mount
  useEffect(() => {
    if (rootMenuRef.current) {
      const rect = rootMenuRef.current.getBoundingClientRect();
      const menuWidth = rect.width;
      const menuHeight = rect.height;

      let left = x;
      let top = y;

      const viewportWidth = window.innerWidth;
      if (left + menuWidth > viewportWidth - 20) {
        left = Math.max(20, viewportWidth - menuWidth - 20);
      }
      if (left < 20) left = 20;

      const viewportHeight = window.innerHeight;
      if (top + menuHeight > viewportHeight - 20) {
        const aboveY = y - menuHeight - 4;
        if (aboveY > 20) {
          top = aboveY;
        } else {
          top = Math.max(20, viewportHeight - menuHeight - 20);
        }
      }
      if (top < 20) top = 20;

      setRootPosition({ left, top });
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

  return (
    <MenuLevel
      level={0}
      prefix={[]}
      levelItems={items}
      position={rootPosition}
      menuRef={rootMenuRef}
      openPath={openPath}
      setOpenPath={setOpenPath}
      onClose={onClose}
    />
  );
}
