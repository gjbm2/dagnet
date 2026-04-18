/**
 * Tests for ScenarioLayerList shared component.
 *
 * Verifies:
 * - Renders all item types (current, base, user)
 * - Absent callbacks suppress corresponding UI affordances
 * - DnD reorder fires onReorder with correct indices
 * - Edit inline name fires onRename
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScenarioLayerList } from '../ScenarioLayerList';
import type { ScenarioLayerItem } from '../../../types/scenarioLayerList';

const baseItems: ScenarioLayerItem[] = [
  { id: 'current', name: 'Current', colour: '#3B82F6', visible: true, visibilityMode: 'f+e', kind: 'current' },
  { id: 'sc-1', name: 'Google Channel', colour: '#EC4899', visible: true, visibilityMode: 'f+e', isLive: true, kind: 'user' },
  { id: 'sc-2', name: 'Meta Channel', colour: '#F59E0B', visible: false, visibilityMode: 'f', kind: 'user' },
  { id: 'base', name: 'Base', colour: '#A3A3A3', visible: true, visibilityMode: 'f+e', kind: 'base' },
];

describe('ScenarioLayerList', () => {
  it('should render all scenario names', () => {
    render(<ScenarioLayerList items={baseItems} />);

    expect(screen.getByText('Current')).toBeDefined();
    expect(screen.getByText('Google Channel')).toBeDefined();
    expect(screen.getByText('Meta Channel')).toBeDefined();
    expect(screen.getByText('Base')).toBeDefined();
  });

  it('should render delete buttons only when onDelete is provided', () => {
    const { container, rerender } = render(<ScenarioLayerList items={baseItems} />);
    const trashButtons = container.querySelectorAll('.scenario-action-btn.danger');
    expect(trashButtons.length).toBe(0);

    rerender(<ScenarioLayerList items={baseItems} onDelete={vi.fn()} />);
    const trashButtonsAfter = container.querySelectorAll('.scenario-action-btn.danger');
    expect(trashButtonsAfter.length).toBe(2); // 2 user scenarios
  });

  it('should render edit buttons only when onEdit is provided', () => {
    const { container, rerender } = render(<ScenarioLayerList items={baseItems} />);
    // Count edit icons — Edit2 renders as an SVG, check by title
    const editButtons = container.querySelectorAll('[aria-label="Edit"]');
    expect(editButtons.length).toBe(0);

    rerender(<ScenarioLayerList items={baseItems} onEdit={vi.fn()} />);
    const editButtonsAfter = container.querySelectorAll('[aria-label="Edit"]');
    expect(editButtonsAfter.length).toBe(3); // current + 2 user (base excluded — editing base DSL is meaningless)
  });

  it('should render visibility toggle only when onToggleVisibility is provided', () => {
    const { container, rerender } = render(<ScenarioLayerList items={baseItems} />);
    const visButtons = container.querySelectorAll('[aria-label="Hide"], [aria-label="Show"]');
    expect(visButtons.length).toBe(0);

    rerender(<ScenarioLayerList items={baseItems} onToggleVisibility={vi.fn()} />);
    const visButtonsAfter = container.querySelectorAll('[aria-label="Hide"], [aria-label="Show"]');
    expect(visButtonsAfter.length).toBe(4);
  });

  it('should call onDelete with correct id when trash button clicked', () => {
    const onDelete = vi.fn();
    const { container } = render(<ScenarioLayerList items={baseItems} onDelete={onDelete} />);

    const trashButtons = container.querySelectorAll('.scenario-action-btn.danger');
    fireEvent.click(trashButtons[0]);

    expect(onDelete).toHaveBeenCalledWith('sc-1');
  });

  it('should call onToggleVisibility with correct id', () => {
    const onToggle = vi.fn();
    render(<ScenarioLayerList items={baseItems} onToggleVisibility={onToggle} />);

    const showButton = screen.getByLabelText('Show');
    fireEvent.click(showButton);

    expect(onToggle).toHaveBeenCalledWith('sc-2');
  });

  it('should not render refresh button for non-live user scenarios', () => {
    const onRefresh = vi.fn();
    const items: ScenarioLayerItem[] = [
      { id: 'sc-static', name: 'Static', colour: '#ccc', visible: true, visibilityMode: 'f+e', isLive: false, kind: 'user' },
    ];

    const { container } = render(<ScenarioLayerList items={items} onRefresh={onRefresh} />);
    const refreshButtons = container.querySelectorAll('[aria-label="Refresh from source"]');
    expect(refreshButtons.length).toBe(0);
  });

  it('should render refresh button for live user scenarios when onRefresh provided', () => {
    const onRefresh = vi.fn();
    const { container } = render(<ScenarioLayerList items={baseItems} onRefresh={onRefresh} />);

    const refreshButtons = container.querySelectorAll('[aria-label="Refresh from source"]');
    expect(refreshButtons.length).toBe(1); // sc-1 is live
  });

  it('should keep user swatch visible when row is hidden', () => {
    const hiddenUser: ScenarioLayerItem[] = [
      { id: 'sc-hidden', name: 'Hidden', colour: '#123456', visible: false, visibilityMode: 'f+e', kind: 'user' },
    ];
    const { container } = render(<ScenarioLayerList items={hiddenUser} />);

    expect(container.querySelectorAll('.scenario-colour-swatch-wrapper').length).toBe(1);
    expect(container.querySelectorAll('.scenario-colour-swatch-placeholder').length).toBe(0);
  });

  it('should allow dragging from the whole user row', () => {
    const onReorder = vi.fn();
    const { container } = render(<ScenarioLayerList items={baseItems} onReorder={onReorder} />);
    const rows = container.querySelectorAll('.scenario-row');
    const dataTransfer = { effectAllowed: 'move', dropEffect: 'move', setData: vi.fn(), getData: vi.fn() };

    fireEvent.dragStart(rows[1], { dataTransfer });
    fireEvent.dragOver(rows[2], { dataTransfer });
    fireEvent.dragEnd(rows[1], { dataTransfer });

    expect(onReorder).toHaveBeenCalledWith(0, 1);
  });

  it('should render user scenario names as editable when onRename is provided', () => {
    const onRename = vi.fn();
    render(<ScenarioLayerList items={baseItems} onRename={onRename} />);

    const editableNames = document.querySelectorAll('.scenario-name-editable');
    expect(editableNames.length).toBe(2); // 2 user scenarios
  });

  it('should NOT render current/base names as editable', () => {
    const onRename = vi.fn();
    render(<ScenarioLayerList items={baseItems} onRename={onRename} />);

    const currentName = screen.getByText('Current');
    expect(currentName.classList.contains('scenario-name-editable')).toBe(false);

    const baseName = screen.getByText('Base');
    expect(baseName.classList.contains('scenario-name-editable')).toBe(false);
  });

  it('should render currentSlot inside the Current row', () => {
    render(
      <ScenarioLayerList
        items={baseItems}
        currentSlot={<span data-testid="what-if-slot">What-If</span>}
      />
    );

    expect(screen.getByTestId('what-if-slot')).toBeDefined();
  });

  it('should render user-only lists without synthetic top divider', () => {
    const userOnly: ScenarioLayerItem[] = [
      { id: 'sc-1', name: 'One', colour: '#111111', visible: true, visibilityMode: 'f+e', kind: 'user' },
      { id: 'sc-2', name: 'Two', colour: '#222222', visible: true, visibilityMode: 'f', kind: 'user' },
    ];

    const { container } = render(<ScenarioLayerList items={userOnly} />);
    expect(container.querySelectorAll('.scenario-row').length).toBe(2);
    expect(container.querySelectorAll('.scenarios-divider').length).toBe(0);
  });

  it('should call onRowContextMenu with the row id', () => {
    const onRowContextMenu = vi.fn();
    render(<ScenarioLayerList items={baseItems} onRowContextMenu={onRowContextMenu} />);

    fireEvent.contextMenu(screen.getByText('Google Channel'));
    expect(onRowContextMenu).toHaveBeenCalled();
    expect(onRowContextMenu.mock.calls[0][1]).toBe('sc-1');
  });

  it('should apply selected class when isSelected matches row id', () => {
    const { container } = render(
      <ScenarioLayerList
        items={baseItems}
        isSelected={(id) => id === 'sc-2'}
      />
    );

    const selectedRows = container.querySelectorAll('.scenario-row.selected');
    expect(selectedRows.length).toBe(1);
    expect(selectedRows[0].textContent || '').toContain('Meta Channel');
  });

  it('should use custom edit tooltip when provided', () => {
    const { container } = render(
      <ScenarioLayerList
        items={baseItems}
        onEdit={vi.fn()}
        getEditTooltip={(id) => id === 'sc-1' ? 'Edit query DSL' : 'Open in editor'}
      />
    );

    const customTooltipButtons = container.querySelectorAll('[aria-label="Edit query DSL"]');
    expect(customTooltipButtons.length).toBe(1);
  });

  it('should allow custom refresh visibility predicate', () => {
    const onRefresh = vi.fn();
    const { container } = render(
      <ScenarioLayerList
        items={baseItems}
        onRefresh={onRefresh}
        shouldShowRefresh={(item) => item.id === 'base'}
      />
    );

    const refreshButtons = container.querySelectorAll('[aria-label="Refresh from source"]');
    expect(refreshButtons.length).toBe(1);
  });

  it('should render afterCurrentSlot between current and user rows', () => {
    render(
      <ScenarioLayerList
        items={baseItems}
        afterCurrentSlot={<div data-testid="after-current">Controls</div>}
      />
    );

    expect(screen.getByTestId('after-current')).toBeDefined();
  });

  it('should render currentSlotAfterActions content in current row', () => {
    render(
      <ScenarioLayerList
        items={baseItems}
        currentSlotAfterActions={<div data-testid="current-inline-panel">Panel</div>}
      />
    );

    expect(screen.getByTestId('current-inline-panel')).toBeDefined();
  });
});
