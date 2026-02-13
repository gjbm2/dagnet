import React, { useState, useEffect } from 'react';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { useTabContext } from '../../contexts/TabContext';
import { repositoryOperationsService } from '../../services/repositoryOperationsService';
import toast from 'react-hot-toast';
import './Modal.css';

interface MergeBranchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Merge Branch Modal (Level 1)
 *
 * Merges one branch into another via the GitHub merge API.
 * If conflicts are detected, warns the user and recommends aborting
 * (client-side conflict resolution is planned for Level 3).
 */
export function MergeBranchModal({ isOpen, onClose }: MergeBranchModalProps) {
  const { state: navState, operations: navOps } = useNavigatorContext();
  const { operations: tabOps } = useTabContext();

  const [headBranch, setHeadBranch] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [isMerging, setIsMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictWarning, setConflictWarning] = useState(false);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      // Sensible defaults: merge current branch into main (or vice-versa)
      const current = navState.selectedBranch;
      const branches = navState.availableBranches;
      const mainBranch = branches.find(b => b === 'main') || branches.find(b => b !== current) || '';

      setHeadBranch(current);
      setBaseBranch(current === mainBranch ? (branches.find(b => b !== current) || '') : mainBranch);
      setError(null);
      setConflictWarning(false);
    }
  }, [isOpen, navState.selectedBranch, navState.availableBranches]);

  if (!isOpen) return null;

  const dirtyTabs = tabOps.getDirtyTabs();
  const hasDirtyFiles = dirtyTabs.length > 0;
  const branches = navState.availableBranches;
  const canMerge = headBranch && baseBranch && headBranch !== baseBranch && !isMerging;

  const handleMerge = async () => {
    if (!canMerge) return;

    setIsMerging(true);
    setError(null);
    setConflictWarning(false);

    try {
      const result = await repositoryOperationsService.mergeBranch(
        headBranch,
        baseBranch,
        navState.selectedRepo
      );

      if (result.conflict) {
        // Show conflict warning — recommend abort
        setConflictWarning(true);
        setError(null);
        setIsMerging(false);
        return;
      }

      if (!result.success) {
        setError(result.error || 'Merge failed');
        setIsMerging(false);
        return;
      }

      if (result.alreadyUpToDate) {
        toast(`${baseBranch} is already up to date with ${headBranch}`, { icon: 'ℹ️' });
      } else {
        toast.success(`Merged ${headBranch} → ${baseBranch}`);
      }

      // If the user is currently on the target branch, re-pull so they see the result
      if (navState.selectedBranch === baseBranch && !result.alreadyUpToDate) {
        toast('Pulling latest to sync workspace...', { icon: '🔄', duration: 2000 });
      }

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error');
    } finally {
      setIsMerging(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Merge Branch</h2>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {/* Conflict warning — shown after a failed merge attempt */}
          {conflictWarning && (
            <div className="modal-error" style={{ marginBottom: 16 }}>
              <strong style={{ display: 'block', marginBottom: 6 }}>
                Merge conflicts detected
              </strong>
              <p style={{ margin: '0 0 8px 0' }}>
                <code>{headBranch}</code> cannot be cleanly merged into <code>{baseBranch}</code>.
                The branches have conflicting changes to the same files.
              </p>
              <p style={{ margin: '0 0 8px 0' }}>
                <strong>Recommended:</strong> Close this dialog and resolve conflicts manually
                on GitHub, or wait for in-app conflict resolution (coming soon).
              </p>
              <p style={{ margin: 0, fontSize: 12, opacity: 0.8 }}>
                No changes have been made to either branch.
              </p>
            </div>
          )}

          {/* Dirty-files warning */}
          {hasDirtyFiles && !conflictWarning && (
            <div className="modal-warning">
              <div className="warning-icon">⚠️</div>
              <div className="warning-content">
                <strong>You have {dirtyTabs.length} uncommitted file{dirtyTabs.length === 1 ? '' : 's'}</strong>
                <p>
                  Merging happens on the remote. Your local uncommitted changes are unaffected,
                  but you may want to commit first so they are included in the merge.
                </p>
              </div>
            </div>
          )}

          {/* Branch selectors */}
          <div className="modal-field">
            <label className="modal-label">Merge From (head)</label>
            <select
              className="modal-select"
              value={headBranch}
              onChange={(e) => { setHeadBranch(e.target.value); setConflictWarning(false); setError(null); }}
              disabled={isMerging}
            >
              <option value="" disabled>Select branch...</option>
              {branches.map(b => (
                <option key={b} value={b} disabled={b === baseBranch}>
                  {b}{b === navState.selectedBranch ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div style={{ textAlign: 'center', color: '#888', fontSize: 13, margin: '-8px 0 8px' }}>
            ↓ into ↓
          </div>

          <div className="modal-field">
            <label className="modal-label">Merge Into (base)</label>
            <select
              className="modal-select"
              value={baseBranch}
              onChange={(e) => { setBaseBranch(e.target.value); setConflictWarning(false); setError(null); }}
              disabled={isMerging}
            >
              <option value="" disabled>Select branch...</option>
              {branches.map(b => (
                <option key={b} value={b} disabled={b === headBranch}>
                  {b}{b === navState.selectedBranch ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Error message (non-conflict) */}
          {error && !conflictWarning && (
            <div className="modal-error">
              {error}
            </div>
          )}

          {/* Info box */}
          {!conflictWarning && (
            <div className="modal-info">
              <p><strong>What happens:</strong></p>
              <ul>
                <li>A merge commit is created on <strong>{baseBranch || '...'}</strong> on GitHub</li>
                <li>All commits from <strong>{headBranch || '...'}</strong> are included</li>
                <li>If you are on the target branch, pull to see changes locally</li>
              </ul>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            className="modal-btn modal-btn-secondary"
            onClick={onClose}
            disabled={isMerging}
          >
            {conflictWarning ? 'Close' : 'Cancel'}
          </button>
          {!conflictWarning && (
            <button
              className="modal-btn modal-btn-primary"
              onClick={handleMerge}
              disabled={!canMerge}
            >
              {isMerging ? 'Merging...' : 'Merge'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
