import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import '../styles/popup-menu.css';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  divider?: boolean;
  submenu?: ContextMenuItem[];
  keepMenuOpen?: boolean;
  onHover?: () => void;
  /** Optional Lucide icon (14px recommended) */
  icon?: React.ReactNode;
  /** Show a check mark to the left, indicating the active/selected option */
  checked?: boolean;
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
  /** For submenus: the parent item rect, so we can flip to its left side */
  parentAnchorRect?: DOMRect | null;
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
  parentAnchorRect,
}) => {
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const localRef = useRef<HTMLDivElement>(null);
  const effectiveRef = menuRef || localRef;

  // Self-correct position after render (useLayoutEffect = before paint, no flash)
  const [adjustedPos, setAdjustedPos] = useState(position);
  useLayoutEffect(() => {
    const el = effectiveRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { left, top } = position;

    // Horizontal: if right edge overflows, flip to left of parent anchor
    if (rect.right > vw - 20) {
      if (parentAnchorRect) {
        left = parentAnchorRect.left - rect.width - 4;
      } else {
        left -= (rect.right - (vw - 20));
      }
      if (left < 20) left = 20;
    }

    // Vertical: nudge up if bottom overflows
    if (rect.bottom > vh - 20) {
      top -= (rect.bottom - (vh - 20));
      if (top < 20) top = 20;
    }

    if (left !== position.left || top !== position.top) {
      setAdjustedPos({ left, top });
    } else {
      setAdjustedPos(position);
    }
  }, [position.left, position.top]);

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

  // Unconstrained submenu position — child will self-correct via useLayoutEffect
  const submenuPosition = useMemo(() => {
    if (!activeSubmenu || !activeAnchorRect) return null;
    const viewportHeight = window.innerHeight;
    const estHeight = estimateMenuHeight(activeSubmenu);
    const left = activeAnchorRect.right + 4;
    let top = activeAnchorRect.top;

    if (top + estHeight > viewportHeight - 20) {
      top = Math.max(20, viewportHeight - estHeight - 20);
    }
    if (top < 20) top = 20;
    return { left, top };
  }, [activeSubmenu, activeAnchorRect]);

  const hasAnyChecked = levelItems.some(i => !i.divider && i.checked !== undefined);

  return (
    <>
      <div
        ref={effectiveRef}
        className="dagnet-popup"
        style={{
          position: 'fixed',
          left: adjustedPos.left,
          top: adjustedPos.top,
          minWidth: `${MIN_WIDTH_PX}px`,
          maxWidth: `min(${MAX_WIDTH_PX}px, calc(100vw - 40px))`,
          zIndex: 10000 + level,
        }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {levelItems.map((item, index) => {
          if (item.divider) {
            return (
              <div
                key={`divider-${level}-${index}`}
                className="dagnet-popup-divider"
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
              className={`dagnet-popup-item${isActive ? ' dagnet-popup-item--active' : ''}`}
              data-disabled={item.disabled ? 'true' : undefined}
              onMouseEnter={() => {
                if (item.disabled) return;
                item.onHover?.();
                if (hasSubmenu) {
                  setOpenPath([...prefix, index]);
                } else {
                  setOpenPath(prefix);
                }
              }}
              onClick={(e) => {
                if (item.disabled) return;
                if (hasSubmenu) return;
                e.stopPropagation();
                item.onClick();
                if (!item.keepMenuOpen) onClose();
              }}
              style={{
                cursor: item.disabled ? 'not-allowed' : hasSubmenu ? 'default' : 'pointer',
                opacity: item.disabled ? 0.5 : 1,
              }}
            >
              {hasAnyChecked && (
                <span className="dagnet-popup-check" aria-hidden="true">
                  {item.checked ? '✓' : ''}
                </span>
              )}
              <span
                title={item.label}
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: '320px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                {item.icon}
                {item.label}
              </span>
              {hasSubmenu ? <span className="dagnet-popup-arrow">›</span> : null}
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
          parentAnchorRect={activeAnchorRect}
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
        // Show to the left of the cursor (standard OS behaviour)
        left = x - menuWidth;
        if (left < 20) left = 20;
      }

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
