import React, { useState } from 'react';
import { CommitRequest } from '../../types';
import { useTabContext } from '../../contexts/TabContext';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import './Dialog.css';
import './CommitDialog.css';

/**
 * Commit Dialog
 * 
 * Multi-file commit interface:
 * - Shows all dirty files with checkboxes
 * - Branch selection (new or existing)
 * - Commit message input
 * - Diff viewer per file
 */
interface CommitDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCommit: (request: CommitRequest) => Promise<void>;
}

export function CommitDialog({ isOpen, onClose, onCommit }: CommitDialogProps) {
  const { operations } = useTabContext();
  const { state } = useNavigatorContext();
  
  const dirtyTabs = operations.getDirtyTabs();
  
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(
    new Set(dirtyTabs.map(tab => tab.fileId))
  );
  const [useNewBranch, setUseNewBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);

  if (!isOpen) return null;

  const handleToggleFile = (fileId: string) => {
    const newSelected = new Set(selectedFileIds);
    if (newSelected.has(fileId)) {
      newSelected.delete(fileId);
    } else {
      newSelected.add(fileId);
    }
    setSelectedFileIds(newSelected);
  };

  const handleSelectAll = () => {
    setSelectedFileIds(new Set(dirtyTabs.map(tab => tab.fileId)));
  };

  const handleDeselectAll = () => {
    setSelectedFileIds(new Set());
  };

  const handleCommit = async () => {
    if (selectedFileIds.size === 0) {
      alert('Please select at least one file to commit');
      return;
    }

    if (!commitMessage.trim()) {
      alert('Please enter a commit message');
      return;
    }

    if (useNewBranch && !newBranchName.trim()) {
      alert('Please enter a branch name');
      return;
    }

    setIsCommitting(true);

    try {
      const request: CommitRequest = {
        files: Array.from(selectedFileIds).map(fileId => ({
          fileId,
          path: 'TODO', // TODO: Get actual path from file registry
          content: 'TODO' // TODO: Get actual content from file registry
        })),
        commit: {
          message: commitMessage,
          branch: useNewBranch ? newBranchName : state.selectedBranch,
          timestamp: Date.now()
        },
        createNewBranch: useNewBranch,
        newBranchName: useNewBranch ? newBranchName : undefined
      };

      await onCommit(request);
      onClose();
    } catch (error) {
      console.error('Commit failed:', error);
      alert('Commit failed. See console for details.');
    } finally {
      setIsCommitting(false);
    }
  };

  // Group tabs by fileId (multiple tabs can view same file)
  const uniqueFiles = Array.from(new Set(dirtyTabs.map(tab => tab.fileId)));

  return (
    <div className="dialog-overlay">
      <div className="dialog-content commit-dialog">
        <div className="dialog-header">
          <h2 className="dialog-title">Commit Changes</h2>
        </div>

        <div className="dialog-body">
          {/* File Selection */}
          <div className="commit-section">
            <div className="commit-section-header">
              <h3>Select Files ({selectedFileIds.size} of {uniqueFiles.length})</h3>
              <div className="commit-section-actions">
                <button 
                  className="commit-link-button"
                  onClick={handleSelectAll}
                >
                  Select All
                </button>
                <button 
                  className="commit-link-button"
                  onClick={handleDeselectAll}
                >
                  Deselect All
                </button>
              </div>
            </div>

            <div className="commit-file-list">
              {uniqueFiles.length === 0 ? (
                <div className="commit-empty">No modified files</div>
              ) : (
                uniqueFiles.map(fileId => {
                  const tab = dirtyTabs.find(t => t.fileId === fileId);
                  if (!tab) return null;

                  return (
                    <div key={fileId} className="commit-file-item">
                      <label className="commit-checkbox-label">
                        <input
                          type="checkbox"
                          checked={selectedFileIds.has(fileId)}
                          onChange={() => handleToggleFile(fileId)}
                        />
                        <span className="commit-file-icon">{tab.icon}</span>
                        <span className="commit-file-name">{tab.title}</span>
                      </label>
                      <button 
                        className="commit-link-button"
                        onClick={() => {
                          // TODO: Show diff viewer
                          console.log('Show diff for', fileId);
                        }}
                      >
                        Diff
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Branch Selection */}
          <div className="commit-section">
            <h3>Target Branch</h3>
            
            <label className="commit-radio-label">
              <input
                type="radio"
                checked={!useNewBranch}
                onChange={() => setUseNewBranch(false)}
              />
              <span>Commit to existing branch:</span>
              <select 
                disabled={useNewBranch}
                value={state.selectedBranch}
                onChange={(e) => {
                  // TODO: Update selected branch
                }}
                className="commit-select"
              >
                <option value="main">main</option>
                <option value="develop">develop</option>
              </select>
            </label>

            <label className="commit-radio-label">
              <input
                type="radio"
                checked={useNewBranch}
                onChange={() => setUseNewBranch(true)}
              />
              <span>Create new branch:</span>
              <input
                type="text"
                disabled={!useNewBranch}
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                placeholder="feature/my-changes"
                className="commit-input"
              />
            </label>
          </div>

          {/* Commit Message */}
          <div className="commit-section">
            <h3>Commit Message</h3>
            <textarea
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Describe your changes..."
              className="commit-textarea"
              rows={4}
            />
          </div>
        </div>

        <div className="dialog-footer">
          <button 
            className="dialog-button dialog-button-secondary"
            onClick={onClose}
            disabled={isCommitting}
          >
            Cancel
          </button>

          <button 
            className="dialog-button dialog-button-primary"
            onClick={handleCommit}
            disabled={isCommitting || selectedFileIds.size === 0}
          >
            {isCommitting ? 'Committing...' : 'Commit'}
          </button>
        </div>
      </div>
    </div>
  );
}

