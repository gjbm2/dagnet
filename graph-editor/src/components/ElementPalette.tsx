import React, { useCallback } from 'react';
import { MousePointer2, Hand, SquareIcon, StickyNote } from 'lucide-react';
import { useElementTool, type ElementToolType } from '../contexts/ElementToolContext';

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
      const events: Record<string, string> = { 'new-node': 'dagnet:addNode', 'new-postit': 'dagnet:addPostit' };
      if (elementId) window.dispatchEvent(new CustomEvent(events[elementId]));
    }
  }, [onToolSelect, currentTool]);

  const isHorizontal = layout === 'horizontal';

  const iconButton = (id: ElementToolType, label: string, Icon: React.ElementType, isActive: boolean, onClick: () => void, draggable?: boolean, onDragStart?: (e: React.DragEvent) => void) => (
    <div
      key={id}
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onClick}
      title={label}
      tabIndex={0}
      aria-label={label}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      style={{
        width: isHorizontal ? '34px' : '30px',
        height: isHorizontal ? '34px' : '30px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '5px',
        cursor: draggable ? 'grab' : 'pointer',
        border: isActive ? '1.5px solid #3b82f6' : '1px solid transparent',
        background: isActive ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
        transition: 'background 0.1s, border-color 0.1s',
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.background = 'rgba(0,0,0,0.05)';
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.background = 'transparent';
      }}
    >
      <Icon size={isHorizontal ? 18 : 16} strokeWidth={1.5} />
    </div>
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isHorizontal ? 'row' : 'column',
        gap: '2px',
        padding: '3px',
        alignItems: 'center',
      }}
    >
      {TOOLS.map((t) => iconButton(t.id, t.label, t.icon, currentTool === t.id, () => handleToolClick(t.id)))}

      <div style={isHorizontal
        ? { width: '1px', height: '20px', background: 'rgba(0,0,0,0.1)', margin: '0 2px' }
        : { height: '1px', width: '20px', background: 'rgba(0,0,0,0.1)', margin: '2px 0' }
      } />

      {CREATION_ELEMENTS.map((el) =>
        iconButton(
          el.id, `${el.label} (click to place, or drag)`, el.icon,
          currentTool === el.id,
          () => handleCreationClick(el.id),
          true,
          (e) => handleDragStart(e, el.id),
        )
      )}
    </div>
  );
}
