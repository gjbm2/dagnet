/**
 * Data Section Submenu
 * 
 * Reusable submenu component for rendering a single data operation section.
 * Used by NodeContextMenu and EdgeContextMenu.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Camera, Database, DatabaseZap, Download, Folders, TrendingUpDown, X, Trash2, FileText } from 'lucide-react';
import type { DataOperationSection } from './DataOperationsSections';

interface DataSectionSubmenuProps {
  section: DataOperationSection;
  isOpen: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onSubmenuContentEnter: () => void;
  onSubmenuContentLeave: () => void;
  onGetFromFile: (section: DataOperationSection) => void;
  onPutToFile: (section: DataOperationSection) => void;
  onGetFromSource: (section: DataOperationSection) => void;
  onGetFromSourceDirect: (section: DataOperationSection) => void;
  onClearCache: (section: DataOperationSection) => void;
  onClearDataFile: (section: DataOperationSection) => void;
  onOpenFile: (section: DataOperationSection) => void;
  /** Snapshot count for this section (optional, only for parameters) */
  snapshotCount?: number;
  /** Handler to download snapshot data as CSV (optional) */
  onDownloadSnapshotData?: (section: DataOperationSection) => void;
  /** Handler to delete snapshots (optional) */
  onDeleteSnapshots?: (section: DataOperationSection) => void;
}

export const DataSectionSubmenu: React.FC<DataSectionSubmenuProps> = ({
  section,
  isOpen,
  onMouseEnter,
  onMouseLeave,
  onSubmenuContentEnter,
  onSubmenuContentLeave,
  onGetFromFile,
  onPutToFile,
  onGetFromSource,
  onGetFromSourceDirect,
  onClearCache,
  onClearDataFile,
  onOpenFile,
  snapshotCount,
  onDownloadSnapshotData,
  onDeleteSnapshots,
}) => {
  const [isSnapshotsSubmenuOpen, setIsSnapshotsSubmenuOpen] = useState(false);
  const closeTimeoutRef = useRef<number | null>(null);
  const snapshotsTriggerRef = useRef<HTMLDivElement>(null);
  const snapshotsMenuRef = useRef<HTMLDivElement>(null);
  const [snapshotsMenuPos, setSnapshotsMenuPos] = useState<{ left: number; top: number } | null>(null);
  const hasSnapshotsActions = !!onDeleteSnapshots || !!onDownloadSnapshotData;
  const hasSnapshots = (snapshotCount ?? 0) > 0;
  const pointerMoveListenerInstalledRef = useRef(false);

  const computeFixedSubmenuPos = useMemo(() => {
    return () => {
      const trigger = snapshotsTriggerRef.current;
      const menu = snapshotsMenuRef.current;
      if (!trigger || !menu) return;

      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();

      const viewportWidth = globalThis.innerWidth;
      const viewportHeight = globalThis.innerHeight;

      let left = triggerRect.right + 4;
      let top = triggerRect.top;

      // Flip left if needed
      if (left + menuRect.width > viewportWidth - 20) {
        left = Math.max(20, triggerRect.left - menuRect.width - 4);
      }

      // Clamp vertically
      if (top + menuRect.height > viewportHeight - 20) {
        top = Math.max(20, viewportHeight - menuRect.height - 20);
      }
      if (top < 20) top = 20;

      setSnapshotsMenuPos({ left, top });
    };
  }, []);

  useEffect(() => {
    if (!isSnapshotsSubmenuOpen) return;
    // Position after menu mounts
    requestAnimationFrame(() => {
      computeFixedSubmenuPos();
    });
  }, [isSnapshotsSubmenuOpen, computeFixedSubmenuPos]);

  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) {
        globalThis.clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
    };
  }, []);

  const openSnapshotsSubmenu = () => {
    if (closeTimeoutRef.current) {
      globalThis.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    setIsSnapshotsSubmenuOpen(true);
  };

  const scheduleCloseSnapshotsSubmenu = () => {
    if (closeTimeoutRef.current) {
      globalThis.clearTimeout(closeTimeoutRef.current);
    }
    closeTimeoutRef.current = globalThis.setTimeout(() => {
      setIsSnapshotsSubmenuOpen(false);
      closeTimeoutRef.current = null;
    }, 300) as unknown as number;
  };

  const cancelScheduledClose = () => {
    if (closeTimeoutRef.current) {
      globalThis.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  };

  const isPointerInsideTriggerOrMenu = (clientX: number, clientY: number): boolean => {
    const trigger = snapshotsTriggerRef.current;
    const menu = snapshotsMenuRef.current;
    const pad = 6;

    const inRect = (r: DOMRect) =>
      clientX >= (r.left - pad) &&
      clientX <= (r.right + pad) &&
      clientY >= (r.top - pad) &&
      clientY <= (r.bottom + pad);

    const triggerRect = trigger ? trigger.getBoundingClientRect() : null;
    const menuRect = menu ? menu.getBoundingClientRect() : null;

    if (triggerRect && inRect(triggerRect)) return true;
    if (menuRect && inRect(menuRect)) return true;

    // Bridge/corridor between trigger and menu to avoid premature closes when the menu is
    // fixed-positioned and slightly offset/clamped.
    if (triggerRect && menuRect) {
      const isMenuOnRight = menuRect.left >= triggerRect.right;
      const isMenuOnLeft = triggerRect.left >= menuRect.right;

      if (isMenuOnRight) {
        const bridge = new DOMRect(
          triggerRect.right,
          Math.min(triggerRect.top, menuRect.top),
          Math.max(0, menuRect.left - triggerRect.right),
          Math.max(triggerRect.bottom, menuRect.bottom) - Math.min(triggerRect.top, menuRect.top)
        );
        if (inRect(bridge)) return true;
      } else if (isMenuOnLeft) {
        const bridge = new DOMRect(
          menuRect.right,
          Math.min(triggerRect.top, menuRect.top),
          Math.max(0, triggerRect.left - menuRect.right),
          Math.max(triggerRect.bottom, menuRect.bottom) - Math.min(triggerRect.top, menuRect.top)
        );
        if (inRect(bridge)) return true;
      }
    }

    return false;
  };

  useEffect(() => {
    if (!isSnapshotsSubmenuOpen) return;

    const onPointerMove = (e: PointerEvent) => {
      // Keep open while pointer is over trigger OR menu (even if menu is fixed-positioned outside)
      if (isPointerInsideTriggerOrMenu(e.clientX, e.clientY)) {
        cancelScheduledClose();
      } else {
        scheduleCloseSnapshotsSubmenu();
      }
    };

    if (!pointerMoveListenerInstalledRef.current) {
      pointerMoveListenerInstalledRef.current = true;
      document.addEventListener('pointermove', onPointerMove);
    }

    return () => {
      if (pointerMoveListenerInstalledRef.current) {
        pointerMoveListenerInstalledRef.current = false;
        document.removeEventListener('pointermove', onPointerMove);
      }
    };
  }, [isSnapshotsSubmenuOpen]);

  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div
        style={{
          padding: '8px 12px',
          cursor: 'pointer',
          fontSize: '13px',
          borderRadius: '2px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: isOpen ? '#f8f9fa' : 'white'
        }}
      >
        <span>{section.label}</span>
        <ChevronRight size={14} style={{ color: '#666' }} />
      </div>
      
      {isOpen && (
        <div
          style={{
            position: 'absolute',
            left: '100%',
            top: 0,
            background: 'white',
            border: '1px solid #ddd',
            borderRadius: '4px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            minWidth: '200px',
            padding: '4px',
            zIndex: 99999,
            marginLeft: '4px',
            whiteSpace: 'nowrap'
          }}
          onMouseEnter={onSubmenuContentEnter}
          onMouseLeave={onSubmenuContentLeave}
        >
          {/* Open file */}
          <div
            onClick={() => onOpenFile(section)}
            style={{
              padding: '6px 12px',
              cursor: 'pointer',
              fontSize: '13px',
              borderRadius: '2px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '16px'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
          >
            <span>Open file</span>
            <FileText size={12} style={{ color: '#666' }} />
          </div>
          
          {/* Divider after Open file */}
          <div style={{ height: '1px', background: '#eee', margin: '6px 0' }} />
          
          {/* Get from Source (direct) */}
          {section.operations.getFromSourceDirect && (
            <div
              onClick={() => onGetFromSourceDirect(section)}
              style={{
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                borderRadius: '2px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
            >
              <span>Get from Source (direct)</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                <Database size={12} />
                <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                <TrendingUpDown size={12} />
              </div>
            </div>
          )}
          
          {/* Get from Source (versioned) */}
          {section.operations.getFromSource && (
            <div
              onClick={() => onGetFromSource(section)}
              style={{
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                borderRadius: '2px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
            >
              <span>Get from Source</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                <DatabaseZap size={12} />
                <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                <Folders size={12} />
                <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>+</span>
                <TrendingUpDown size={12} />
              </div>
            </div>
          )}
          
          {/* Get from File */}
          {section.operations.getFromFile && (
            <div
              onClick={() => onGetFromFile(section)}
              style={{
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                borderRadius: '2px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
            >
              <span>Get from file</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                <Folders size={12} />
                <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                <TrendingUpDown size={12} />
              </div>
            </div>
          )}
          
          {/* Put to File */}
          {section.operations.putToFile && (
            <div
              onClick={() => onPutToFile(section)}
              style={{
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                borderRadius: '2px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
            >
              <span>Put to file</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#666', flexShrink: 0 }}>
                <TrendingUpDown size={12} />
                <span style={{ fontSize: '10px', fontWeight: '600', color: '#999' }}>→</span>
                <Folders size={12} />
              </div>
            </div>
          )}
          
          {/* Divider before Unsign cache */}
          {section.operations.clearCache && (
            <div style={{ height: '1px', background: '#eee', margin: '6px 0' }} />
          )}
          
          {/* Unsign cache - only show for parameters with files */}
          {section.operations.clearCache && (
            <div
              onClick={() => onClearCache(section)}
              style={{
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                borderRadius: '2px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
            >
              <span>Unsign file cache</span>
              <X size={12} style={{ color: '#666' }} />
            </div>
          )}
          
          {/* Clear data file - only show for parameters and cases with files */}
          {section.operations.clearDataFile && (
            <div
              onClick={() => onClearDataFile(section)}
              style={{
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                borderRadius: '2px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#f8f9fa')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
            >
              <span>Clear data file</span>
              <Trash2 size={12} style={{ color: '#666' }} />
            </div>
          )}
          
          {/* Snapshots submenu - show for parameters (disabled when count is 0) */}
          {hasSnapshotsActions && (
            <div
              style={{ position: 'relative' }}
              onMouseEnter={openSnapshotsSubmenu}
            >
              <div
                ref={snapshotsTriggerRef}
                style={{
                  padding: '6px 12px',
                  cursor: hasSnapshots ? 'pointer' : 'default',
                  fontSize: '13px',
                  borderRadius: '2px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '16px',
                  opacity: hasSnapshots ? 1 : 0.4,
                }}
                onMouseEnter={(e) => hasSnapshots && (e.currentTarget.style.background = '#f8f9fa')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
              >
                <span>Snapshots</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#666', flexShrink: 0 }}>
                  <Camera size={12} style={{ color: hasSnapshots ? '#666' : '#999' }} />
                  <ChevronRight size={14} style={{ color: '#666' }} />
                </div>
              </div>

              {isSnapshotsSubmenuOpen && (
                <div
                  ref={snapshotsMenuRef}
                  data-testid="snapshots-flyout"
                  onMouseEnter={onSubmenuContentEnter}
                  onMouseLeave={onSubmenuContentLeave}
                  style={{
                    position: 'fixed',
                    left: `${snapshotsMenuPos?.left ?? 0}px`,
                    top: `${snapshotsMenuPos?.top ?? 0}px`,
                    background: 'white',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    minWidth: '220px',
                    maxWidth: 'min(420px, calc(100vw - 40px))',
                    padding: '4px',
                    zIndex: 99999,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {/* Download snapshot data */}
                  {onDownloadSnapshotData && (
                    <div
                      onClick={hasSnapshots ? () => onDownloadSnapshotData(section) : undefined}
                      style={{
                        padding: '6px 12px',
                        cursor: hasSnapshots ? 'pointer' : 'default',
                        fontSize: '13px',
                        borderRadius: '2px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px',
                        opacity: hasSnapshots ? 1 : 0.4,
                      }}
                      onMouseEnter={(e) => hasSnapshots && (e.currentTarget.style.background = '#f8f9fa')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                    >
                      <span style={{ maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis' }}>Download snapshot data</span>
                      <Download size={12} style={{ color: '#666' }} />
                    </div>
                  )}

                  {/* Delete X snapshots */}
                  {onDeleteSnapshots && (
                    <div
                      onClick={hasSnapshots ? () => onDeleteSnapshots(section) : undefined}
                      style={{
                        padding: '6px 12px',
                        cursor: hasSnapshots ? 'pointer' : 'default',
                        fontSize: '13px',
                        borderRadius: '2px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px',
                        opacity: hasSnapshots ? 1 : 0.4,
                      }}
                      onMouseEnter={(e) => hasSnapshots && (e.currentTarget.style.background = '#f8f9fa')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'white')}
                    >
                      <span style={{ maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        Delete {snapshotCount ?? 0} snapshot{(snapshotCount ?? 0) !== 1 ? 's' : ''}
                      </span>
                      <Database size={12} style={{ color: hasSnapshots ? '#dc2626' : '#999' }} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

