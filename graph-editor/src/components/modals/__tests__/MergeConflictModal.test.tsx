/**
 * Component tests for MergeConflictModal
 * 
 * Tests that the UI:
 * - Displays conflicts correctly
 * - Allows selecting resolutions
 * - Calls onResolve with correct data
 * - Shows proper diff views
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MergeConflictModal, ConflictFile } from '../MergeConflictModal';
import '@testing-library/jest-dom';

// Mock Monaco Editor (heavy dependency)
vi.mock('@monaco-editor/react', () => ({
  DiffEditor: vi.fn(({ modified, original }) => (
    <div data-testid="monaco-diff-editor">
      <div data-testid="original-content">{original}</div>
      <div data-testid="modified-content">{modified}</div>
    </div>
  ))
}));

describe('MergeConflictModal', () => {
  const mockOnClose = vi.fn();
  const mockOnResolve = vi.fn();

  const sampleConflicts: ConflictFile[] = [
    {
      fileId: 'parameter-test1',
      fileName: 'test1.yaml',
      path: 'parameters/test1.yaml',
      type: 'parameter',
      localContent: 'id: test1\nvalue: 150\ndescription: local',
      remoteContent: 'id: test1\nvalue: 200\ndescription: remote',
      baseContent: 'id: test1\nvalue: 100',
      mergedContent: '<<<<<<< LOCAL\nvalue: 150\n=======\nvalue: 200\n>>>>>>> REMOTE',
      hasConflicts: true
    },
    {
      fileId: 'parameter-test2',
      fileName: 'test2.yaml',
      path: 'parameters/test2.yaml',
      type: 'parameter',
      localContent: 'id: test2\nvalue: 250',
      remoteContent: 'id: test2\nvalue: 300',
      baseContent: 'id: test2\nvalue: 200',
      mergedContent: '<<<<<<< LOCAL\nvalue: 250\n=======\nvalue: 300\n>>>>>>> REMOTE',
      hasConflicts: true
    }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render when open', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    expect(screen.getByText('Merge Conflicts')).toBeInTheDocument();
    expect(screen.getByText(/2 files with conflicts\./)).toBeInTheDocument();
  });

  it('should not render when closed', () => {
    const { container } = render(
      <MergeConflictModal
        isOpen={false}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it('should display all conflicted files', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    const file1Items = screen.getAllByText('test1.yaml');
    const file2Items = screen.getAllByText('test2.yaml');
    expect(file1Items.length).toBeGreaterThan(0);
    expect(file2Items.length).toBeGreaterThan(0);
  });

  it('should select first file by default', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    const firstFiles = screen.getAllByText('test1.yaml');
    const firstFile = firstFiles[0].closest('.conflict-file-item');
    expect(firstFile).toHaveClass('selected');
  });

  it('should allow selecting different files', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    const secondFiles = screen.getAllByText('test2.yaml');
    const secondFile = secondFiles[0];
    fireEvent.click(secondFile);

    const secondFileContainer = secondFile.closest('.conflict-file-item');
    expect(secondFileContainer).toHaveClass('selected');
  });

  it('should show "Keep Local" option', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    expect(screen.getByText(/Keep Local/)).toBeInTheDocument();
  });

  it('should show "Use Remote" option', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    expect(screen.getByText(/Use Remote/)).toBeInTheDocument();
  });

  it('should show "Manual Merge" option', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    expect(screen.getByText('Manual Merge')).toBeInTheDocument();
  });

  it('should mark file as resolved when option is selected', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    const keepLocalButton = screen.getByText(/Keep Local/);
    fireEvent.click(keepLocalButton);

    expect(keepLocalButton).toHaveClass('selected');
    
    const fileItems = screen.getAllByText('test1.yaml');
    const firstFile = fileItems[0].closest('.conflict-file-item');
    expect(firstFile).toHaveClass('resolved');
  });

  it('should display Monaco DiffEditor', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    expect(screen.getByTestId('monaco-diff-editor')).toBeInTheDocument();
  });

  it('should pass correct content to DiffEditor', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    const originalContent = screen.getByTestId('original-content');
    const modifiedContent = screen.getByTestId('modified-content');

    expect(originalContent.textContent).toContain('value: 150');
    expect(modifiedContent.textContent).toContain('value: 200');
  });

  it('should disable Apply button when no resolutions selected', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    const applyButton = screen.getByText('Apply Resolutions');
    expect(applyButton).toBeDisabled();
  });

  it('should enable Apply button when all conflicts resolved', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    // Resolve first file
    fireEvent.click(screen.getByText(/Keep Local/));
    
    // Select and resolve second file
    const file2Items = screen.getAllByText('test2.yaml');
    fireEvent.click(file2Items[0]);
    fireEvent.click(screen.getByText(/Use Remote/));

    const applyButton = screen.getByText('Apply Resolutions');
    expect(applyButton).not.toBeDisabled();
  });

  it('should call onResolve with correct resolutions when Apply is clicked', async () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    // Resolve first file: Keep Local
    fireEvent.click(screen.getByText(/Keep Local/));
    
    // Select and resolve second file: Use Remote
    const file2Items = screen.getAllByText('test2.yaml');
    fireEvent.click(file2Items[0]);
    fireEvent.click(screen.getByText(/Use Remote/));

    // Click Apply
    const applyButton = screen.getByText('Apply Resolutions');
    fireEvent.click(applyButton);

    await waitFor(() => {
      expect(mockOnResolve).toHaveBeenCalledTimes(1);
    });

    const resolutionMap = mockOnResolve.mock.calls[0][0];
    expect(resolutionMap.get('parameter-test1')).toBe('local');
    expect(resolutionMap.get('parameter-test2')).toBe('remote');
  });

  it('should call onClose when Cancel is clicked', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    const cancelButton = screen.getByText('Cancel');
    fireEvent.click(cancelButton);

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('should call onClose when X button is clicked', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    const closeButton = screen.getByText('×');
    fireEvent.click(closeButton);

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('should show correct count in summary when single conflict', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={[sampleConflicts[0]]}
        onResolve={mockOnResolve}
      />
    );

    expect(screen.getByText(/1 file with conflicts\./)).toBeInTheDocument();
  });

  it('should show correct count in summary when multiple conflicts', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    expect(screen.getByText(/2 files with conflicts\./)).toBeInTheDocument();
  });

  it('should allow changing resolution after selection', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    // First select "Keep Local"
    const keepLocalButton = screen.getByText(/Keep Local/);
    fireEvent.click(keepLocalButton);
    expect(keepLocalButton).toHaveClass('selected');

    // Then change to "Use Remote"
    const useRemoteButton = screen.getByText(/Use Remote/);
    fireEvent.click(useRemoteButton);
    expect(useRemoteButton).toHaveClass('selected');
    expect(keepLocalButton).not.toHaveClass('selected');
  });

  it('should persist resolution when switching between files', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    // Resolve first file
    fireEvent.click(screen.getByText(/Keep Local/));
    
    // Switch to second file
    const file2Items = screen.getAllByText('test2.yaml');
    fireEvent.click(file2Items[0]);
    
    // Switch back to first file
    const file1Items = screen.getAllByText('test1.yaml');
    fireEvent.click(file1Items[0]);

    // Resolution should still be selected
    const keepLocalButton = screen.getByText(/Keep Local/);
    expect(keepLocalButton).toHaveClass('selected');
  });

  it('should show Local for all and Remote for all batch buttons', () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    expect(screen.getByText('Local for all')).toBeInTheDocument();
    expect(screen.getByText('Remote for all')).toBeInTheDocument();
  });

  it('should resolve all conflicts to local when Local for all is clicked', async () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    fireEvent.click(screen.getByText('Local for all'));

    const applyButton = screen.getByText('Apply Resolutions');
    expect(applyButton).not.toBeDisabled();
    fireEvent.click(applyButton);

    await waitFor(() => {
      expect(mockOnResolve).toHaveBeenCalledTimes(1);
    });

    const resolutionMap = mockOnResolve.mock.calls[0][0];
    expect(resolutionMap.get('parameter-test1')).toBe('local');
    expect(resolutionMap.get('parameter-test2')).toBe('local');
  });

  it('should auto-select first file when conflicts prop changes from empty to populated', () => {
    // This tests the fix for the bug where the modal opened with no file selected
    // because useState initializer only runs on mount (when conflicts was []).
    const { rerender } = render(
      <MergeConflictModal
        isOpen={false}
        onClose={mockOnClose}
        conflicts={[]}
        onResolve={mockOnResolve}
      />
    );

    // Re-render with conflicts and open
    rerender(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    // First file should be auto-selected
    const firstFiles = screen.getAllByText('test1.yaml');
    const firstFile = firstFiles[0].closest('.conflict-file-item');
    expect(firstFile).toHaveClass('selected');

    // Diff editor should be visible (right panel renders)
    expect(screen.getByTestId('monaco-diff-editor')).toBeInTheDocument();
  });

  it('should reset resolutions when conflicts change (modal reopened with new conflicts)', () => {
    const { rerender } = render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    // Resolve first file
    fireEvent.click(screen.getByText(/Keep Local/));
    const keepLocalButton = screen.getByText(/Keep Local/);
    expect(keepLocalButton).toHaveClass('selected');

    // Close and reopen with different conflicts
    const newConflicts: ConflictFile[] = [{
      fileId: 'parameter-new',
      fileName: 'new.yaml',
      path: 'parameters/new.yaml',
      type: 'parameter',
      localContent: 'id: new\nvalue: 1',
      remoteContent: 'id: new\nvalue: 2',
      baseContent: 'id: new',
      mergedContent: '<<<<<<< LOCAL\nvalue: 1\n=======\nvalue: 2\n>>>>>>> REMOTE',
      hasConflicts: true
    }];

    rerender(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={newConflicts}
        onResolve={mockOnResolve}
      />
    );

    // New file should be selected, no stale resolution badges
    expect(screen.getAllByText('new.yaml').length).toBeGreaterThan(0);
    const applyButton = screen.getByText('Apply Resolutions');
    expect(applyButton).toBeDisabled(); // No resolutions yet
  });

  it('should resolve all conflicts to remote when Remote for all is clicked', async () => {
    render(
      <MergeConflictModal
        isOpen={true}
        onClose={mockOnClose}
        conflicts={sampleConflicts}
        onResolve={mockOnResolve}
      />
    );

    fireEvent.click(screen.getByText('Remote for all'));

    const applyButton = screen.getByText('Apply Resolutions');
    expect(applyButton).not.toBeDisabled();
    fireEvent.click(applyButton);

    await waitFor(() => {
      expect(mockOnResolve).toHaveBeenCalledTimes(1);
    });

    const resolutionMap = mockOnResolve.mock.calls[0][0];
    expect(resolutionMap.get('parameter-test1')).toBe('remote');
    expect(resolutionMap.get('parameter-test2')).toBe('remote');
  });
});

