/**
 * PinnedQueryModal - dailyFetch Tests
 * 
 * Tests that the dailyFetch checkbox:
 * - Displays correctly based on prop
 * - Can be toggled
 * - Is included in onSave callback
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PinnedQueryModal } from '../PinnedQueryModal';

// Mock dependencies
vi.mock('../../../lib/dslExplosion', () => ({
  explodeDSL: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../services/slicePlanValidationService', () => ({
  validatePinnedDataInterestsDSL: vi.fn().mockResolvedValue({ warnings: [] }),
}));

vi.mock('../../../lib/queryDSL', () => ({
  QUERY_FUNCTIONS: ['window', 'context', 'cohort'],
}));

vi.mock('../../QueryExpressionEditor', () => ({
  QueryExpressionEditor: ({ value, onChange }: any) => (
    <input
      data-testid="query-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

describe('PinnedQueryModal - dailyFetch', () => {
  const mockOnSave = vi.fn();
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should display checkbox unchecked when dailyFetch is false', () => {
    render(
      <PinnedQueryModal
        isOpen={true}
        currentDSL="context(x)"
        dailyFetch={false}
        onSave={mockOnSave}
        onClose={mockOnClose}
      />
    );

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).not.toBeChecked();
  });

  it('should display checkbox checked when dailyFetch is true', () => {
    render(
      <PinnedQueryModal
        isOpen={true}
        currentDSL="context(x)"
        dailyFetch={true}
        onSave={mockOnSave}
        onClose={mockOnClose}
      />
    );

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeChecked();
  });

  it('should toggle checkbox when clicked', () => {
    render(
      <PinnedQueryModal
        isOpen={true}
        currentDSL="context(x)"
        dailyFetch={false}
        onSave={mockOnSave}
        onClose={mockOnClose}
      />
    );

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  it('should call onSave with dailyFetch=true when checkbox is checked and saved', async () => {
    render(
      <PinnedQueryModal
        isOpen={true}
        currentDSL="context(x)"
        dailyFetch={false}
        onSave={mockOnSave}
        onClose={mockOnClose}
      />
    );

    // Check the checkbox
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);

    // Click save
    const saveButton = screen.getByText('Save');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledWith('context(x)', true);
    });
  });

  it('should call onSave with dailyFetch=false when checkbox is unchecked and saved', async () => {
    render(
      <PinnedQueryModal
        isOpen={true}
        currentDSL="context(x)"
        dailyFetch={true}
        onSave={mockOnSave}
        onClose={mockOnClose}
      />
    );

    // Uncheck the checkbox
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);

    // Click save
    const saveButton = screen.getByText('Save');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledWith('context(x)', false);
    });
  });

  it('should preserve dailyFetch value when only DSL changes', async () => {
    render(
      <PinnedQueryModal
        isOpen={true}
        currentDSL="context(x)"
        dailyFetch={true}
        onSave={mockOnSave}
        onClose={mockOnClose}
      />
    );

    // Change DSL
    const editor = screen.getByTestId('query-editor');
    fireEvent.change(editor, { target: { value: 'context(y)' } });

    // Click save (checkbox still checked)
    const saveButton = screen.getByText('Save');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledWith('context(y)', true);
    });
  });

  it('should reset to prop value when modal reopens', async () => {
    const { rerender } = render(
      <PinnedQueryModal
        isOpen={true}
        currentDSL="context(x)"
        dailyFetch={false}
        onSave={mockOnSave}
        onClose={mockOnClose}
      />
    );

    // Toggle checkbox
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    // Close modal
    rerender(
      <PinnedQueryModal
        isOpen={false}
        currentDSL="context(x)"
        dailyFetch={false}
        onSave={mockOnSave}
        onClose={mockOnClose}
      />
    );

    // Reopen modal
    rerender(
      <PinnedQueryModal
        isOpen={true}
        currentDSL="context(x)"
        dailyFetch={false}
        onSave={mockOnSave}
        onClose={mockOnClose}
      />
    );

    // Should reset to prop value (false)
    const resetCheckbox = screen.getByRole('checkbox');
    expect(resetCheckbox).not.toBeChecked();
  });

  it('should display "Fetch daily" label', () => {
    render(
      <PinnedQueryModal
        isOpen={true}
        currentDSL="context(x)"
        dailyFetch={false}
        onSave={mockOnSave}
        onClose={mockOnClose}
      />
    );

    expect(screen.getByText('Fetch daily')).toBeInTheDocument();
  });
});
