import React, { useState } from 'react';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { useTabContext } from '../../contexts/TabContext';
import './Modal.css';

interface SwitchRepositoryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Switch Repository Modal
 * 
 * Guarded operation to switch to a different repository.
 * Warns user about dirty files and offers options to:
 * - Commit changes before switching
 * - Discard changes and switch
 * - Cancel the operation
 */
export function SwitchRepositoryModal({ isOpen, onClose }: SwitchRepositoryModalProps) {
  const { state: navState, operations: navOps } = useNavigatorContext();
  const { operations: tabOps } = useTabContext();
  const [selectedRepo, setSelectedRepo] = useState(navState.selectedRepo);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const dirtyTabs = tabOps.getDirtyTabs();
  const hasDirtyFiles = dirtyTabs.length > 0;
  const availableRepos = navState.availableRepos.filter(repo => repo !== navState.selectedRepo);

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

      // Switch repository
      console.log(`Switching to repository: ${selectedRepo}`);
      await navOps.selectRepository(selectedRepo);

      // Close modal
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch repository');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Switch Repository</h2>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {/* Warning about dirty files */}
          {hasDirtyFiles && (
            <div className="modal-warning">
              <div className="warning-icon">⚠️</div>
              <div className="warning-content">
                <strong>You have {dirtyTabs.length} unsaved file{dirtyTabs.length === 1 ? '' : 's'}</strong>
                <p>Switching repositories will close all open files. You must commit or discard changes before proceeding.</p>
              </div>
            </div>
          )}

          {/* Repository selector */}
          <div className="modal-field">
            <label className="modal-label">Select Repository</label>
            <select
              className="modal-select"
              value={selectedRepo}
              onChange={(e) => setSelectedRepo(e.target.value)}
              disabled={isProcessing}
            >
              <option value={navState.selectedRepo}>{navState.selectedRepo} (current)</option>
              {availableRepos.map(repo => (
                <option key={repo} value={repo}>{repo}</option>
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
              <li>All open tabs will be closed</li>
              <li>Local workspace will be cloned from the new repository</li>
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
                disabled={isProcessing || selectedRepo === navState.selectedRepo}
              >
                Discard Changes & Switch
              </button>
              <button
                className="modal-btn modal-btn-primary"
                onClick={() => handleSwitch('commit')}
                disabled={isProcessing || selectedRepo === navState.selectedRepo}
              >
                Commit First
              </button>
            </>
          ) : (
            <button
              className="modal-btn modal-btn-primary"
              onClick={() => handleSwitch('discard')}
              disabled={isProcessing || selectedRepo === navState.selectedRepo}
            >
              {isProcessing ? 'Switching...' : 'Switch Repository'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}


