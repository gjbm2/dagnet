import React, { useState, useEffect } from 'react';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { repositoryOperationsService } from '../../services/repositoryOperationsService';
import type { FileState } from '../../types';
import './Modal.css';

interface SwitchBranchModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Pre-select a target branch (e.g. from URL ?branch= param) */
  targetBranch?: string;
  /** Called after a successful branch switch (e.g. to open a graph from the new branch) */
  onSwitchComplete?: () => void;
  /** Called when user chooses "Commit First" — parent should close this modal and open CommitModal */
  onCommitFirst?: () => void;
}

/**
 * Switch Branch Modal
 *
 * Guarded operation to switch to a different branch.
 * Uses SHA-based content comparison (via getCommittableFiles) to reliably
 * detect local edits — not just in-memory dirty flags.
 *
 * Warns user about uncommitted files and offers options to:
 * - Commit changes to current branch before switching
 * - Discard changes and switch
 * - Cancel the operation
 */
export function SwitchBranchModal({ isOpen, onClose, targetBranch, onSwitchComplete, onCommitFirst }: SwitchBranchModalProps) {
  const { state: navState, operations: navOps } = useNavigatorContext();
  const [selectedBranch, setSelectedBranch] = useState(targetBranch || navState.selectedBranch);

  // Committable files state (loaded async from IDB via SHA comparison)
  const [committableFiles, setCommittableFiles] = useState<FileState[]>([]);
  const [isCheckingFiles, setIsCheckingFiles] = useState(false);

  // Update selected branch when targetBranch changes (e.g. URL-driven)
  useEffect(() => {
    if (targetBranch) setSelectedBranch(targetBranch);
  }, [targetBranch]);

  // Refresh branch list and check for committable files each time modal opens
  useEffect(() => {
    if (isOpen) {
      navOps.refreshBranches();

      // Check for uncommitted local edits via SHA-based comparison (IDB source of truth)
      setIsCheckingFiles(true);
      repositoryOperationsService.getCommittableFiles(
        navState.selectedRepo,
        navState.selectedBranch
      ).then(files => {
        setCommittableFiles(files);
      }).catch(err => {
        console.error('SwitchBranchModal: Failed to check committable files:', err);
        setCommittableFiles([]);
      }).finally(() => {
        setIsCheckingFiles(false);
      });
    } else {
      // Reset state when modal closes
      setCommittableFiles([]);
      setIsCheckingFiles(false);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const hasDirtyFiles = committableFiles.length > 0;
  const availableBranches = navState.availableBranches.filter(branch => branch !== navState.selectedBranch);

  const handleSwitch = async (action: 'commit' | 'discard' | 'cancel') => {
    if (action === 'cancel') {
      onClose();
      return;
    }

    if (action === 'commit') {
      if (onCommitFirst) {
        onClose();
        onCommitFirst();
      } else {
        setError('Please commit or discard changes first using the Repository menu.');
      }
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      // Switch branch — workspace replacement handles cleanup of old branch data
      console.log(`Switching to branch: ${selectedBranch}`);
      await navOps.selectBranch(selectedBranch);

      // Close modal and notify caller
      onClose();
      onSwitchComplete?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch branch');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Switch Branch</h2>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {/* Loading state while checking for uncommitted files */}
          {isCheckingFiles && (
            <div className="modal-info">
              <p>Checking for uncommitted changes…</p>
            </div>
          )}

          {/* Warning about dirty files */}
          {!isCheckingFiles && hasDirtyFiles && (
            <div className="modal-warning">
              <div className="warning-icon">⚠️</div>
              <div className="warning-content">
                <strong>You have {committableFiles.length} uncommitted file{committableFiles.length === 1 ? '' : 's'}</strong>
                <p>Switching branches will replace your workspace. These changes will be <strong>permanently lost</strong> unless you commit first:</p>
                <ul style={{ margin: '8px 0 0 0', padding: '0 0 0 20px', fontSize: '0.9em' }}>
                  {committableFiles.slice(0, 10).map(f => (
                    <li key={f.fileId}>{f.name || f.fileId}</li>
                  ))}
                  {committableFiles.length > 10 && (
                    <li style={{ fontStyle: 'italic' }}>…and {committableFiles.length - 10} more</li>
                  )}
                </ul>
              </div>
            </div>
          )}

          {/* Branch selector */}
          <div className="modal-field">
            <label className="modal-label">Select Branch</label>
            <select
              className="modal-select"
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
              disabled={isProcessing}
            >
              <option value={navState.selectedBranch}>{navState.selectedBranch} (current)</option>
              {availableBranches.map(branch => (
                <option key={branch} value={branch}>{branch}</option>
              ))}
            </select>
          </div>

          {/* Error message */}
          {error && (
            <div className="modal-error">
              {error}
            </div>
          )}

          {/* Info — only show when no dirty files (dirty warning already explains consequences) */}
          {!isCheckingFiles && !hasDirtyFiles && (
            <div className="modal-info">
              <p><strong>What happens when you switch:</strong></p>
              <ul>
                <li>Local workspace will be updated to reflect the new branch</li>
                <li>All open tabs will remain, but content may change</li>
              </ul>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            className="modal-btn modal-btn-secondary"
            onClick={() => handleSwitch('cancel')}
            disabled={isProcessing}
          >
            Cancel
          </button>

          {hasDirtyFiles ? (
            <>
              <button
                className="modal-btn modal-btn-danger"
                onClick={() => handleSwitch('discard')}
                disabled={isProcessing || isCheckingFiles || selectedBranch === navState.selectedBranch}
              >
                {isProcessing ? 'Switching…' : 'Discard Changes & Switch'}
              </button>
              <button
                className="modal-btn modal-btn-primary"
                onClick={() => handleSwitch('commit')}
                disabled={isProcessing || isCheckingFiles}
              >
                Commit First
              </button>
            </>
          ) : (
            <button
              className="modal-btn modal-btn-primary"
              onClick={() => handleSwitch('discard')}
              disabled={isProcessing || isCheckingFiles || selectedBranch === navState.selectedBranch}
            >
              {isProcessing ? 'Switching…' : 'Switch Branch'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
