import React, { useState, useEffect } from 'react';
import { RepoCommit } from '../../hooks/useRollbackRepository';
import './Modal.css';
import './MergeConflictModal.css'; // Reuse the layout styles

interface RepositoryHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  repoName: string;
  branch: string;
  isLoading: boolean;
  history: RepoCommit[];
  onLoadHistory: () => Promise<RepoCommit[]>;
  onRollback: (sha: string) => Promise<boolean>;
}

/**
 * Repository History Modal
 * 
 * Shows commit history for the entire repository and allows
 * rolling back to a previous commit.
 * 
 * Simpler than HistoryModal - no diff view, just commit list.
 */
export function RepositoryHistoryModal({
  isOpen,
  onClose,
  repoName,
  branch,
  isLoading,
  history,
  onLoadHistory,
  onRollback
}: RepositoryHistoryModalProps) {
  const [selectedCommit, setSelectedCommit] = useState<RepoCommit | null>(null);
  const [isRollingBack, setIsRollingBack] = useState(false);

  // Load history when modal opens
  useEffect(() => {
    if (isOpen && history.length === 0) {
      onLoadHistory();
    }
  }, [isOpen, history.length, onLoadHistory]);

  // Auto-select first commit when history loads
  useEffect(() => {
    if (history.length > 0 && !selectedCommit) {
      setSelectedCommit(history[0]);
    }
  }, [history, selectedCommit]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setSelectedCommit(null);
    }
  }, [isOpen]);

  const handleRollback = async () => {
    if (!selectedCommit) return;
    
    setIsRollingBack(true);
    const success = await onRollback(selectedCommit.sha);
    setIsRollingBack(false);
    
    if (success) {
      onClose();
    }
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-container" style={{ maxWidth: '700px', maxHeight: '80vh' }}>
        <div className="modal-header">
          <h2 className="modal-title">Repository History: {repoName}/{branch}</h2>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body" style={{ padding: 0 }}>
          {isLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '300px', color: 'var(--color-text-secondary, #666)' }}>
              <p>Loading repository history...</p>
            </div>
          ) : history.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '300px', color: 'var(--color-text-secondary, #666)' }}>
              <p>No commit history found.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              {/* Commit list */}
              <div style={{ flex: 1, overflow: 'auto', padding: '12px' }}>
                <p style={{ fontSize: '13px', color: 'var(--color-text-secondary, #666)', margin: '0 0 12px 0' }}>
                  Select a commit to rollback to. This will replace all local files with versions from that commit.
                </p>
                
                {history.map((commit, idx) => (
                  <div
                    key={commit.sha}
                    className={`conflict-file-item ${selectedCommit?.sha === commit.sha ? 'selected' : ''}`}
                    onClick={() => setSelectedCommit(commit)}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className="file-name" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <code style={{ 
                        fontSize: '11px', 
                        background: 'var(--color-bg-secondary, #f5f5f5)', 
                        padding: '2px 6px', 
                        borderRadius: '3px',
                        fontFamily: 'monospace'
                      }}>
                        {commit.shortSha}
                      </code>
                      {idx === 0 && (
                        <span style={{ 
                          fontSize: '10px', 
                          fontWeight: 600, 
                          color: '#fff', 
                          background: 'var(--color-primary, #2196f3)', 
                          padding: '2px 6px', 
                          borderRadius: '3px',
                          textTransform: 'uppercase'
                        }}>
                          Current
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '13px', margin: '6px 0 4px 0' }}>
                      {commit.message}
                    </div>
                    <div className="conflict-count">
                      {commit.author} · {formatDate(commit.date)}
                    </div>
                  </div>
                ))}
              </div>

            </div>
          )}
        </div>

        <div className="modal-footer" style={{ flexDirection: 'column', gap: '12px' }}>
          {/* Warning message when rollback is available */}
          {selectedCommit && history[0]?.sha !== selectedCommit.sha && (
            <div style={{ 
              width: '100%',
              padding: '8px 12px', 
              background: 'var(--color-warning-bg, #fff3cd)',
              borderRadius: '4px',
              fontSize: '13px', 
              color: 'var(--color-warning-text, #856404)'
            }}>
              ⚠️ This will replace ALL local files. Commit All to save, or Pull All to revert.
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', width: '100%' }}>
            <button className="modal-btn modal-btn-secondary" onClick={onClose}>
              Close
            </button>
            <button
              className="modal-btn modal-btn-primary"
              onClick={handleRollback}
              disabled={isRollingBack || !selectedCommit || history[0]?.sha === selectedCommit?.sha}
            >
              {isRollingBack 
                ? 'Rolling back...' 
                : selectedCommit && history[0]?.sha !== selectedCommit.sha
                  ? `Rollback to ${selectedCommit.shortSha}`
                  : 'Select a commit to rollback'
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

