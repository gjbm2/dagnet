/**
 * ScenarioLayerList — shared scenario layer rendering component.
 *
 * Renders Base, user scenario, and Current rows with consistent visual language.
 * Used by both ScenariosPanel (sidebar, tab-sourced) and canvas analysis
 * properties (chart-owned scenarios).
 *
 * Affordances are callback-driven: absent callbacks suppress corresponding UI.
 */

import React, { useState, useCallback } from 'react';
import { ColourSelector } from '../ColourSelector';
import {
  Eye,
  EyeOff,
  Images,
  Image,
  Square,
  Edit2,
  Trash2,
  X,
  Check,
  Zap,
  RefreshCw,
} from 'lucide-react';
import type { ScenarioLayerItem } from '../../types/scenarioLayerList';

export interface ScenarioLayerListProps {
  items: ScenarioLayerItem[];
  containerClassName?: string;

  onToggleVisibility?: (id: string) => void;
  onCycleMode?: (id: string) => void;
  onRename?: (id: string, newName: string) => void;
  onColourChange?: (id: string, colour: string) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  onDelete?: (id: string) => void;
  onEdit?: (id: string) => void;
  onRefresh?: (id: string) => void;
  shouldShowRefresh?: (item: ScenarioLayerItem) => boolean;
  onRowContextMenu?: (e: React.MouseEvent, id: string) => void;
  isSelected?: (id: string) => boolean;
  getEditTooltip?: (id: string) => string;
  /** When true, rename is allowed on current/base rows (not just user rows). Used by chart props where all rows are peers in Custom mode. */
  allowRenameAll?: boolean;

  /** Render prop for extra content inside the Current row (e.g. What-If panel) */
  currentSlot?: React.ReactNode;
  /** Render prop for content injected right after Current row (e.g. divider + controls) */
  afterCurrentSlot?: React.ReactNode;
  /** Render prop for extra content after Current row actions (e.g. inline panel) */
  currentSlotAfterActions?: React.ReactNode;

  /** Swatch overlay style callback for visibility mode indicators */
  getSwatchOverlayStyle?: (id: string) => React.CSSProperties | null;
  /** Mode icon callback */
  getModeIcon?: (id: string, size?: number) => React.ReactNode;
  /** Mode tooltip callback */
  getModeTooltip?: (id: string) => string;
}

export function ScenarioLayerList({
  items,
  containerClassName = 'scenarios-list',
  onToggleVisibility,
  onCycleMode,
  onRename,
  onColourChange,
  onReorder,
  onDelete,
  onEdit,
  onRefresh,
  shouldShowRefresh,
  onRowContextMenu,
  isSelected,
  getEditTooltip,
  allowRenameAll = false,
  currentSlot,
  afterCurrentSlot,
  currentSlotAfterActions,
  getSwatchOverlayStyle,
  getModeIcon,
  getModeTooltip,
}: ScenarioLayerListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const currentItem = items.find(i => i.kind === 'current');
  const baseItem = items.find(i => i.kind === 'base');
  const userItems = items.filter(i => i.kind === 'user');

  const handleStartEdit = useCallback((item: ScenarioLayerItem) => {
    if (!onRename) return;
    setEditingId(item.id);
    setEditingName(item.name);
  }, [onRename]);

  const handleSaveEdit = useCallback(() => {
    if (editingId && editingName.trim() && onRename) {
      onRename(editingId, editingName.trim());
    }
    setEditingId(null);
    setEditingName('');
  }, [editingId, editingName, onRename]);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingName('');
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    if (!onReorder) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, textarea, select, .scenario-colour-swatch-wrapper, .colour-selector-compact, .colour-selector-compact-popup')) {
      e.preventDefault();
      return;
    }
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }, [onReorder]);

  const handleDragOverRow = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDragEnd = useCallback(() => {
    if (draggedId && dragOverIndex !== null && onReorder) {
      const fromIndex = userItems.findIndex(i => i.id === draggedId);
      if (fromIndex !== -1 && fromIndex !== dragOverIndex) {
        onReorder(fromIndex, dragOverIndex);
      }
    }
    setDraggedId(null);
    setDragOverIndex(null);
  }, [draggedId, dragOverIndex, onReorder, userItems]);

  const defaultModeIcon = (id: string, size: number = 14) => {
    const item = items.find(i => i.id === id);
    if (!item) return <Images size={size} />;
    switch (item.visibilityMode) {
      case 'f+e': return <Images size={size} />;
      case 'f': return <Image size={size} />;
      case 'e': return <Square size={size} />;
      default: return <Images size={size} />;
    }
  };

  const defaultModeTooltip = (id: string): string => {
    const item = items.find(i => i.id === id);
    switch (item?.visibilityMode) {
      case 'f+e': return 'Forecast + evidence (click to cycle)';
      case 'f': return 'Forecast only (click to cycle)';
      case 'e': return 'Evidence only (click to cycle)';
      default: return 'Cycle forecast/evidence display';
    }
  };

  const modeIcon = getModeIcon || defaultModeIcon;
  const modeTooltip = getModeTooltip || defaultModeTooltip;

  const renderVisibilityIcon = (visible: boolean, size: number = 14) =>
    visible ? <Eye size={size} /> : <EyeOff size={size} />;

  const renderRow = (item: ScenarioLayerItem, index?: number) => {
    const isEditing = editingId === item.id;
    const isDragging = draggedId === item.id;
    const isDragOver = index !== undefined && dragOverIndex === index;
    const isUser = item.kind === 'user';
    const canDrag = isUser && !!onReorder;
    const selected = isSelected?.(item.id) ?? false;
    const showSwatch = item.visible || isUser;
    const refreshVisible = shouldShowRefresh
      ? shouldShowRefresh(item)
      : Boolean(item.isLive && isUser);

    let transform = '';
    if (isUser && index !== undefined && !isDragging && draggedId && dragOverIndex !== null) {
      const draggedPanelIndex = userItems.findIndex(i => i.id === draggedId);
      const targetPanelIndex = dragOverIndex;
      if (draggedPanelIndex !== -1) {
        if (draggedPanelIndex < targetPanelIndex) {
          if (index > draggedPanelIndex && index <= targetPanelIndex) {
            transform = 'translateY(-32px)';
          }
        } else if (draggedPanelIndex > targetPanelIndex) {
          if (index >= targetPanelIndex && index < draggedPanelIndex) {
            transform = 'translateY(32px)';
          }
        }
      }
    }

    const nameContent = isEditing ? (
      <input
        type="text"
        className="scenario-name-input"
        value={editingName}
        onChange={(e) => setEditingName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSaveEdit();
          if (e.key === 'Escape') handleCancelEdit();
        }}
        autoFocus
      />
    ) : (
      <div
        className={`scenario-name ${onRename && (isUser || allowRenameAll) ? 'scenario-name-editable' : ''}`}
        title={item.tooltip}
        onClick={onRename && (isUser || allowRenameAll) ? () => handleStartEdit(item) : undefined}
      >
        {item.name}
        {item.isLive && (
          <span title="Live scenario">
            <Zap size={11} style={{ color: '#374151', marginLeft: '4px', verticalAlign: 'middle', flexShrink: 0 }} />
          </span>
        )}
      </div>
    );

    return (
      <div
        key={item.id}
        className={`scenario-row ${item.kind === 'current' ? 'scenario-current' : ''} ${item.kind === 'base' ? 'scenario-base' : ''} ${canDrag ? 'scenario-row-draggable' : ''} ${selected ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
        style={isUser ? {
          transform,
          transition: isDragging ? 'none' : 'transform 0.15s ease',
        } : undefined}
        draggable={canDrag && !isEditing}
        onDragStart={canDrag ? (e) => handleDragStart(e, item.id) : undefined}
        onDragEnd={canDrag ? handleDragEnd : undefined}
        onDragOver={canDrag ? (e) => handleDragOverRow(e, index!) : undefined}
        onContextMenu={onRowContextMenu ? (e) => onRowContextMenu(e, item.id) : undefined}
        title={canDrag ? 'Drag to reorder' : undefined}
      >
        {/* Colour swatch */}
        {showSwatch ? (
          <div
            className="scenario-colour-swatch-wrapper"
            style={{ position: 'relative', opacity: item.visible ? 1 : 0.3 }}
            title={onColourChange ? 'Click to change colour' : undefined}
          >
            {onColourChange ? (
              <ColourSelector
                compact={true}
                value={item.colour}
                onChange={(colour) => onColourChange(item.id, colour)}
              />
            ) : (
              <div className="scenario-colour-swatch" style={{ backgroundColor: item.colour }} />
            )}
            {getSwatchOverlayStyle?.(item.id) && (
              <div style={getSwatchOverlayStyle(item.id) as React.CSSProperties} />
            )}
          </div>
        ) : (
          <div className="scenario-colour-swatch-placeholder" />
        )}

        {/* Name + Current slot share left cluster for stable icon alignment */}
        {item.kind === 'current' ? (
          <div className="current-label-group">
            {nameContent}
            {currentSlot}
          </div>
        ) : (
          nameContent
        )}

        {/* Action buttons */}
        {isEditing ? (
          <>
            <button className="scenario-action-btn" onClick={handleCancelEdit} title="Cancel">
              <X size={14} />
            </button>
            <button className="scenario-action-btn" onClick={handleSaveEdit} title="Save">
              <Check size={14} />
            </button>
          </>
        ) : (
          <>
            {onRefresh && refreshVisible && (
              <button className="scenario-action-btn" onClick={() => onRefresh(item.id)} title="Refresh from source">
                <RefreshCw size={14} />
              </button>
            )}
            {onDelete && isUser && (
              <button className="scenario-action-btn danger" onClick={() => onDelete(item.id)} title="Delete scenario">
                <Trash2 size={14} />
              </button>
            )}
            {onEdit && (
              <button className="scenario-action-btn" onClick={() => onEdit(item.id)} title={getEditTooltip?.(item.id) || 'Edit'}>
                <Edit2 size={14} />
              </button>
            )}
            {onCycleMode && (
              <button className="scenario-action-btn" onClick={() => onCycleMode(item.id)} title={modeTooltip(item.id)}>
                {modeIcon(item.id)}
              </button>
            )}
            {onToggleVisibility && (
              <button className="scenario-action-btn" onClick={() => onToggleVisibility(item.id)} title={item.visible ? 'Hide' : 'Show'}>
                {renderVisibilityIcon(item.visible)}
              </button>
            )}
          </>
        )}
        {item.kind === 'current' && currentSlotAfterActions}
      </div>
    );
  };

  return (
    <div className={containerClassName}>
      {/* Current — pinned at top */}
      {currentItem && renderRow(currentItem)}
      {currentItem && afterCurrentSlot}

      {/* Divider */}
      {currentItem && userItems.length > 0 && !afterCurrentSlot && <div className="scenarios-divider" />}

      {/* User scenarios */}
      {userItems.map((item, index) => renderRow(item, index))}

      {/* Divider before Base */}
      {baseItem && (currentItem || userItems.length > 0) && <div className="scenarios-divider" />}

      {/* Base — pinned at bottom */}
      {baseItem && renderRow(baseItem)}
    </div>
  );
}
