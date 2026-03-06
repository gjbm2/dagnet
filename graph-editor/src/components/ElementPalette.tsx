import React, { useCallback } from 'react';
import { MousePointer2, Hand, SquareIcon, StickyNote, BoxSelect, BarChart3 } from 'lucide-react';
import { useElementTool, type ElementToolType } from '../contexts/ElementToolContext';
import './ElementPalette.css';

export type { ElementToolType };

interface ElementPaletteProps {
  layout: 'horizontal' | 'vertical';
}

const TOOLS = [
  { id: 'select' as const, label: 'Select', icon: MousePointer2, isCreation: false },
  { id: 'pan' as const, label: 'Pan', icon: Hand, isCreation: false },
];

const CREATION_ELEMENTS = [
  { id: 'new-node' as const, label: 'Conversion Node', icon: SquareIcon },
  { id: 'new-postit' as const, label: 'Post-It Note', icon: StickyNote },
  { id: 'new-container' as const, label: 'Container', icon: BoxSelect },
  { id: 'new-analysis' as const, label: 'Canvas Analysis', icon: BarChart3 },
];

export function ElementPalette({ layout }: ElementPaletteProps) {
  const { activeElementTool: activeTool, setActiveElementTool: onToolSelect } = useElementTool();
  const currentTool = activeTool ?? 'select';

  const handleDragStart = useCallback((e: React.DragEvent, elementId: string) => {
    e.dataTransfer.setData('application/json', JSON.stringify({
      type: 'dagnet-drag',
      objectType: elementId,
    }));
    e.dataTransfer.effectAllowed = 'copy';
  }, []);

  const handleToolClick = useCallback((toolId: ElementToolType) => {
    if (onToolSelect) {
      onToolSelect(toolId);
    }
  }, [onToolSelect]);

  const handleCreationClick = useCallback((elementId: ElementToolType) => {
    if (onToolSelect) {
      onToolSelect(currentTool === elementId ? 'select' : elementId);
    } else {
      const events: Record<string, string> = { 'new-node': 'dagnet:addNode', 'new-postit': 'dagnet:addPostit', 'new-container': 'dagnet:addContainer', 'new-analysis': 'dagnet:addAnalysis' };
      if (elementId) window.dispatchEvent(new CustomEvent(events[elementId]));
    }
  }, [onToolSelect, currentTool]);

  const isHorizontal = layout === 'horizontal';

  const iconButton = (
    id: ElementToolType,
    label: string,
    Icon: React.ElementType,
    isActive: boolean,
    onClick: () => void,
    opts?: {
      draggable?: boolean;
      onDragStart?: (e: React.DragEvent) => void;
      kind?: 'tool' | 'object';
    }
  ) => {
    const draggable = opts?.draggable ?? false;
    const kind = opts?.kind ?? 'tool';

    return (
      <button
        key={id}
        type="button"
        className={[
          'element-palette__button',
          isHorizontal ? 'is-horizontal' : 'is-vertical',
          kind === 'object' ? 'is-object' : 'is-tool',
          isActive ? 'is-active' : '',
          draggable ? 'is-draggable' : '',
        ].filter(Boolean).join(' ')}
        draggable={draggable}
        onDragStart={opts?.onDragStart}
        onClick={onClick}
        title={label}
        aria-label={label}
      >
        <Icon
          className="element-palette__icon"
          size={isHorizontal ? 16 : 18}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        />
      </button>
    );
  };

  return (
    <div
      className={[
        'element-palette',
        isHorizontal ? 'is-horizontal' : 'is-vertical',
      ].join(' ')}
    >
      {TOOLS.map((t) =>
        iconButton(
          t.id,
          t.label,
          t.icon,
          currentTool === t.id,
          () => handleToolClick(t.id),
          { kind: 'tool' }
        )
      )}

      <div className="element-palette__divider" />

      {CREATION_ELEMENTS.map((el) =>
        iconButton(
          el.id,
          `${el.label} (click to place, or drag)`,
          el.icon,
          currentTool === el.id,
          () => handleCreationClick(el.id),
          { draggable: true, onDragStart: (e) => handleDragStart(e, el.id), kind: 'object' }
        )
      )}
    </div>
  );
}
