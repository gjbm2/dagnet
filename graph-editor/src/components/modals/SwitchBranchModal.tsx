import React, { useState } from 'react';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { useTabContext } from '../../contexts/TabContext';
import './Modal.css';

interface SwitchBranchModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Pre-select a target branch (e.g. from URL ?branch= param) */
  targetBranch?: string;
  /** Called after a successful branch switch (e.g. to open a graph from the new branch) */
  onSwitchComplete?: () => void;
}

/**
 * Switch Branch Modal
 * 
 * Guarded operation to switch to a different branch.
 * Warns user about dirty files and offers options to:
 * - Commit changes to current branch before switching
 * - Discard changes and switch
 * - Cancel the operation
 */
export function SwitchBranchModal({ isOpen, onClose, targetBranch, onSwitchComplete }: SwitchBranchModalProps) {
  const { state: navState, operations: navOps } = useNavigatorContext();
  const { operations: tabOps } = useTabContext();
  const [selectedBranch, setSelectedBranch] = useState(targetBranch || navState.selectedBranch);
  
  // Update selected branch when targetBranch changes (e.g. URL-driven)
  React.useEffect(() => {
    if (targetBranch) setSelectedBranch(targetBranch);
  }, [targetBranch]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const dirtyTabs = tabOps.getDirtyTabs();
  const hasDirtyFiles = dirtyTabs.length > 0;
  const availableBranches = navState.availableBranches.filter(branch => branch !== navState.selectedBranch);

  const handleSwitch = async (action: 'commit' | 'discard' | 'cancel') => {
    if (action === 'cancel') {
      onClose();
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      if (action === 'commit') {
        // TODO: Trigger commit modal and wait for completion
        // For now, just show an error that commit must be done first
        setError('Please commit or discard changes first using the Navigator commit button.');
        setIsProcessing(false);
        return;
      }

      if (action === 'discard') {
        // Discard all dirty files
        // TODO: Implement bulk discard operation in TabContext
        console.log('Discarding all dirty files...');
        // For now, just proceed with the switch
      }

      // Switch branch
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
          {/* Warning about dirty files */}
          {hasDirtyFiles && (
            <div className="modal-warning">
              <div className="warning-icon">⚠️</div>
              <div className="warning-content">
                <strong>You have {dirtyTabs.length} unsaved file{dirtyTabs.length === 1 ? '' : 's'}</strong>
                <p>Switching branches will replace your workspace. You must commit or discard changes before proceeding.</p>
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

          {/* Info */}
          <div className="modal-info">
            <p><strong>What happens when you switch:</strong></p>
            <ul>
              <li>Local workspace will be updated to reflect the new branch</li>
              <li>All open tabs will remain, but content may change</li>
              <li>Your current uncommitted changes will be lost (unless committed)</li>
            </ul>
          </div>
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
                disabled={isProcessing || selectedBranch === navState.selectedBranch}
              >
                Discard Changes & Switch
              </button>
              <button
                className="modal-btn modal-btn-primary"
                onClick={() => handleSwitch('commit')}
                disabled={isProcessing || selectedBranch === navState.selectedBranch}
              >
                Commit First
              </button>
            </>
          ) : (
            <button
              className="modal-btn modal-btn-primary"
              onClick={() => handleSwitch('discard')}
              disabled={isProcessing || selectedBranch === navState.selectedBranch}
            >
              {isProcessing ? 'Switching...' : 'Switch Branch'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}



