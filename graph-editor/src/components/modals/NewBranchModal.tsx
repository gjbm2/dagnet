import React, { useState, useRef, useEffect } from 'react';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { useTabContext } from '../../contexts/TabContext';
import { repositoryOperationsService } from '../../services/repositoryOperationsService';
import toast from 'react-hot-toast';
import './Modal.css';

interface NewBranchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Validate a git branch name (simplified rules) */
function validateBranchName(name: string): string | null {
  if (!name.trim()) return 'Branch name is required';
  if (/\s/.test(name)) return 'Branch name cannot contain spaces';
  if (/\.\./.test(name)) return 'Branch name cannot contain ".."';
  if (/[~^:?*\[\\]/.test(name)) return 'Branch name contains invalid characters';
  if (name.startsWith('-') || name.startsWith('.')) return 'Branch name cannot start with "-" or "."';
  if (name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) return 'Branch name has an invalid ending';
  return null;
}

/**
 * New Branch Modal
 *
 * Creates a new branch on the remote from a selected source branch,
 * then switches to it.
 */
export function NewBranchModal({ isOpen, onClose }: NewBranchModalProps) {
  const { state: navState, operations: navOps } = useNavigatorContext();
  const { operations: tabOps } = useTabContext();
  const [branchName, setBranchName] = useState('');
  const [sourceBranch, setSourceBranch] = useState(navState.selectedBranch);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input when modal opens
  useEffect(() => {
    if (isOpen) {
      setBranchName('');
      setError(null);
      setSourceBranch(navState.selectedBranch);
      // Small delay so the DOM is ready
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, navState.selectedBranch]);

  if (!isOpen) return null;

  const dirtyTabs = tabOps.getDirtyTabs();
  const hasDirtyFiles = dirtyTabs.length > 0;
  const validationError = validateBranchName(branchName);
  const canCreate = !validationError && !isCreating;

  const handleCreate = async () => {
    if (!canCreate) return;

    setIsCreating(true);
    setError(null);

    try {
      const result = await repositoryOperationsService.createBranch(
        branchName.trim(),
        sourceBranch,
        navState.selectedRepo
      );

      if (!result.success) {
        setError(result.error || 'Failed to create branch');
        setIsCreating(false);
        return;
      }

      toast.success(`Created branch ${branchName}`);

      // Refresh the branch list so the new branch appears everywhere
      await navOps.refreshBranches();

      // Switch to the new branch
      await navOps.selectBranch(branchName.trim());

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error');
    } finally {
      setIsCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && canCreate) {
      handleCreate();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">New Branch</h2>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {/* Warning about dirty files */}
          {hasDirtyFiles && (
            <div className="modal-warning">
              <div className="warning-icon">⚠️</div>
              <div className="warning-content">
                <strong>You have {dirtyTabs.length} uncommitted file{dirtyTabs.length === 1 ? '' : 's'}</strong>
                <p>
                  The new branch will be created from the remote head of the source branch.
                  Your uncommitted local changes will remain on the current branch until you switch.
                </p>
              </div>
            </div>
          )}

          {/* Branch name input */}
          <div className="modal-field">
            <label className="modal-label">Branch Name</label>
            <input
              ref={inputRef}
              className="modal-input"
              type="text"
              value={branchName}
              onChange={(e) => { setBranchName(e.target.value); setError(null); }}
              onKeyDown={handleKeyDown}
              placeholder="e.g. feature/my-feature"
              disabled={isCreating}
              autoComplete="off"
              spellCheck={false}
            />
            {branchName && validationError && (
              <div style={{ color: '#c62828', fontSize: 12, marginTop: 4 }}>{validationError}</div>
            )}
          </div>

          {/* Source branch selector */}
          <div className="modal-field">
            <label className="modal-label">Create From</label>
            <select
              className="modal-select"
              value={sourceBranch}
              onChange={(e) => setSourceBranch(e.target.value)}
              disabled={isCreating}
            >
              {navState.availableBranches.map(branch => (
                <option key={branch} value={branch}>
                  {branch}{branch === navState.selectedBranch ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Error message */}
          {error && (
            <div className="modal-error">
              {error}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            className="modal-btn modal-btn-secondary"
            onClick={onClose}
            disabled={isCreating}
          >
            Cancel
          </button>
          <button
            className="modal-btn modal-btn-primary"
            onClick={handleCreate}
            disabled={!canCreate}
          >
            {isCreating ? 'Creating...' : 'Create & Switch'}
          </button>
        </div>
      </div>
    </div>
  );
}
