import React, { useState } from 'react';
import { useTabContext, fileRegistry } from '../../contexts/TabContext';
import { repositoryOperationsService } from '../../services/repositoryOperationsService';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import './Modal.css';

interface GuardedOperationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onProceed: () => Promise<void>;
  title: string;
  description: string;
  proceedButtonText: string;
  warningMessage?: string;
  excludeFromDirtyCheck?: string[]; // File IDs to exclude from dirty check (e.g., credentials file when applying credentials)
}

/**
 * Guarded Operation Modal
 * 
 * Generic modal for operations that might destroy dirty state.
 * Warns user about dirty files and offers options to:
 * - Commit changes before proceeding
 * - Discard changes and proceed
 * - Cancel the operation
 * 
 * This is the single canonical "commit or discard" flow used across the app.
 */
export function GuardedOperationModal({ 
  isOpen, 
  onClose, 
  onProceed,
  title,
  description,
  proceedButtonText,
  warningMessage,
  excludeFromDirtyCheck = []
}: GuardedOperationModalProps) {
  const { state: navState } = useNavigatorContext();
  const { operations: tabOps } = useTabContext();
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const allDirtyTabs = tabOps.getDirtyTabs();
  // Filter out files that should be excluded from dirty check
  // (e.g., credentials file when applying credentials, since we'll save it first)
  const dirtyTabs = excludeFromDirtyCheck.length > 0
    ? allDirtyTabs.filter(tab => !excludeFromDirtyCheck.includes(tab.fileId))
    : allDirtyTabs;
  const hasDirtyFiles = dirtyTabs.length > 0;

  const handleAction = async (action: 'commit' | 'discard' | 'cancel') => {
    if (action === 'cancel') {
      onClose();
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      if (action === 'commit') {
        // Show an error prompting user to commit first
        setError('Please commit or discard changes first using File > Commit Changes.');
        setIsProcessing(false);
        return;
      }

      if (action === 'discard') {
        // Discard all dirty files EXCEPT the ones we're excluding
        // (e.g., for credentials, we exclude the credentials file itself
        // because it will be saved as part of the atomic operation)
        console.log('Discarding dirty files before operation (excluding:', excludeFromDirtyCheck, ')...');
        
        // Get all dirty files
        const allDirtyFiles = fileRegistry.getDirtyFiles();
        const filesToDiscard = allDirtyFiles.filter(
          file => !excludeFromDirtyCheck.includes(file.fileId)
        );
        
        console.log(`Discarding ${filesToDiscard.length} files (${allDirtyFiles.length} total dirty)`);
        
        // Discard each file individually
        for (const file of filesToDiscard) {
          if (file.isLocal) {
            await fileRegistry.deleteFile(file.fileId);
          } else {
            await fileRegistry.revertFile(file.fileId);
          }
        }
      }

      // Proceed with the operation
      await onProceed();

      // Close modal
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {/* Warning about dirty files */}
          {hasDirtyFiles && (
            <div className="modal-warning">
              <div className="warning-icon">⚠️</div>
              <div className="warning-content">
                <strong>You have {dirtyTabs.length} unsaved file{dirtyTabs.length === 1 ? '' : 's'}</strong>
                <p>
                  {warningMessage || 'This operation may affect your unsaved changes. You must commit or discard changes before proceeding.'}
                </p>
              </div>
            </div>
          )}

          {/* Operation description */}
          <div className="modal-info">
            <p>{description}</p>
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
            onClick={() => handleAction('cancel')}
            disabled={isProcessing}
          >
            Cancel
          </button>

          {hasDirtyFiles ? (
            <>
              <button
                className="modal-btn modal-btn-danger"
                onClick={() => handleAction('discard')}
                disabled={isProcessing}
              >
                Discard Changes & Proceed
              </button>
              <button
                className="modal-btn modal-btn-primary"
                onClick={() => handleAction('commit')}
                disabled={isProcessing}
              >
                Commit First
              </button>
            </>
          ) : (
            <button
              className="modal-btn modal-btn-primary"
              onClick={() => handleAction('discard')}
              disabled={isProcessing}
            >
              {isProcessing ? 'Processing...' : proceedButtonText}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

