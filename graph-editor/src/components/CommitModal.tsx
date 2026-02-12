import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTabContext, fileRegistry } from '../contexts/TabContext';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { gitService } from '../services/gitService';
import { repositoryOperationsService } from '../services/repositoryOperationsService';
import { ObjectType } from '../types';

export type CommitProgressCallback = (completed: number, total: number, phase: 'uploading' | 'finalising') => void;

interface CommitModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCommit: (files: CommitFile[], message: string, branch: string, onProgress?: CommitProgressCallback) => Promise<void>;
  preselectedFiles?: string[]; // File IDs to pre-select
}

interface CommitFile {
  fileId: string;
  name: string;
  type: ObjectType;
  path: string;
  content: string;
  sha?: string;
}

/**
 * Commit Modal
 * 
 * Allows users to:
 * - Select files to commit (from dirty files)
 * - Choose branch (current branch by default)
 * - Enter commit message
 * - Commit & push changes
 */
export function CommitModal({ isOpen, onClose, onCommit, preselectedFiles = [] }: CommitModalProps) {
  const { operations } = useTabContext();
  const { state } = useNavigatorContext();
  
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState('');
  const [selectedBranch, setSelectedBranch] = useState(state.selectedBranch || 'main');
  const [availableBranches, setAvailableBranches] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number; phase: 'uploading' | 'finalising' } | null>(null);
  
  // Track if we've initialized the selected files
  const initializedRef = useRef(false);
  const hasInitializedSelectionRef = useRef(false);
  const [forceUpdate, setForceUpdate] = useState(0);

  // Get committable files using content-based detection (more reliable than isDirty flag)
  const [dirtyFiles, setDirtyFiles] = useState<any[]>([]);
  
  useEffect(() => {
    if (!isOpen) {
      setDirtyFiles([]);
      return;
    }
    
    const loadCommittableFiles = async () => {
      // Use content-based detection which compares data to originalData
      // This works reliably across page refreshes
      const filesFromDB = await repositoryOperationsService.getCommittableFiles(
        state.selectedRepo,
        state.selectedBranch
      );
      setDirtyFiles(filesFromDB);
    };
    
    loadCommittableFiles();
  }, [isOpen, forceUpdate, state.selectedRepo, state.selectedBranch]);
  
  // Memoize committable files to prevent re-computation on every render
  const commitableFiles = useMemo(() => {
    if (!isOpen) return [];
    
    // dirtyFiles already filtered by getCommittableFiles() service
    // which uses content-based detection
    return dirtyFiles.map(file => {
      // Strip workspace prefix if present (e.g., "repo-branch-parameter-test" -> "parameter-test")
      let fileId = file.fileId;
      const prefix = `${state.selectedRepo}-${state.selectedBranch}-`;
      if (fileId.startsWith(prefix)) {
        fileId = fileId.substring(prefix.length);
      }
      
      const type = file.type;
      
      // Handle index files specially
      if (fileId.endsWith('-index')) {
        return {
          fileId,
          name: `${type}s-index`,
          type,
          path: file.source?.path || file.path || `${type}s-index.yaml`,
          content: file.data ? JSON.stringify(file.data, null, 2) : '',
          sha: file.sha
        };
      }
      
      // Regular data files
      const name = fileId.split('-').slice(1).join('-');
      const extension = type === 'graph' ? 'json' : 'yaml';
      const nameWithoutExt = name.replace(/\.(json|yaml|yml)$/, '');
      const fileName = `${nameWithoutExt}.${extension}`;
      
      // Determine correct path - ensure graphs always use .json extension
      let filePath = file.source?.path || file.path || `${type}s/${fileName}`;
      if (type === 'graph' && filePath.endsWith('.yaml')) {
        filePath = filePath.replace(/\.yaml$/, '.json');
      }
      
      return {
        fileId,
        name: nameWithoutExt,
        type,
        path: filePath,
        content: file.data ? JSON.stringify(file.data, null, 2) : '',
        sha: file.sha
      };
    });
  }, [isOpen, dirtyFiles, state.selectedRepo, state.selectedBranch]);
  
  // Get pending deletions
  const pendingDeletions = isOpen ? fileRegistry.getPendingDeletions() : [];
  
  // Listen for pending deletion changes
  useEffect(() => {
    const handlePendingChange = () => setForceUpdate(prev => prev + 1);
    window.addEventListener('dagnet:pendingDeletionChanged', handlePendingChange);
    return () => window.removeEventListener('dagnet:pendingDeletionChanged', handlePendingChange);
  }, []);

  // Initialize selected files when modal opens - use a separate effect for modal state
  useEffect(() => {
    if (isOpen && !initializedRef.current) {
      initializedRef.current = true;
      hasInitializedSelectionRef.current = false;
    } else if (!isOpen) {
      // Reset when modal closes
      initializedRef.current = false;
      hasInitializedSelectionRef.current = false;
      setSelectedFiles(new Set());
      setCommitMessage('');
      setError(null);
      setSuccess(false);
      setProgress(null);
    }
  }, [isOpen]);

  // Initialize selected files when commitableFiles change (but only once on initial load)
  useEffect(() => {
    if (isOpen && initializedRef.current && !hasInitializedSelectionRef.current && commitableFiles.length > 0) {
      hasInitializedSelectionRef.current = true;
      if (preselectedFiles.length > 0) {
        setSelectedFiles(new Set(preselectedFiles));
      } else {
        // Select all commitable files by default
        const fileIds = commitableFiles.map(f => f.fileId);
        setSelectedFiles(new Set(fileIds));
      }
    }
  }, [commitableFiles, preselectedFiles, isOpen]);

  // Load available branches
  useEffect(() => {
    if (isOpen) {
      loadBranches();
    }
  }, [isOpen]);

  const loadBranches = async () => {
    try {
      // For now, just use the current branch from navigator state
      // Full branch switching will be implemented in Phase 1b
      const currentBranch = state.selectedBranch || 'main';
      setAvailableBranches([currentBranch]);
      setSelectedBranch(currentBranch);
    } catch (error) {
      console.error('Failed to load branches:', error);
      setAvailableBranches(['main']); // Fallback
      setSelectedBranch('main');
    }
  };

  const handleFileToggle = (fileId: string) => {
    const newSelected = new Set(selectedFiles);
    if (newSelected.has(fileId)) {
      newSelected.delete(fileId);
    } else {
      newSelected.add(fileId);
    }
    setSelectedFiles(newSelected);
  };

  const handleSelectAll = () => {
    setSelectedFiles(new Set(commitableFiles.map(f => f.fileId)));
  };

  const handleSelectNone = () => {
    setSelectedFiles(new Set());
  };

  const handleCommit = async () => {
    if (selectedFiles.size === 0) {
      setError('Please select at least one file to commit');
      return;
    }

    if (!commitMessage.trim()) {
      setError('Please enter a commit message');
      return;
    }

    setIsLoading(true);
    setError(null);
    setSuccess(false);
    setProgress(null);

    try {
      const filesToCommit = commitableFiles.filter(f => selectedFiles.has(f.fileId));
      await onCommit(filesToCommit, commitMessage.trim(), selectedBranch, (completed, total, phase) => {
        setProgress({ completed, total, phase });
      });
      
      // Show success message
      setProgress(null);
      setSuccess(true);
      setIsLoading(false);
      
      // Close modal after a short delay to let user see success
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (error) {
      setProgress(null);
      setError(error instanceof Error ? error.message : 'Failed to commit changes');
      setIsLoading(false);
      setSuccess(false);
    }
  };

  const handleCancel = () => {
    setSelectedFiles(new Set());
    setCommitMessage('');
    setError(null);
    setSuccess(false);
    setProgress(null);
    onClose();
  };

  if (!isOpen) return null;

  const modalContent = (
    <div 
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000
      }}
      onClick={handleCancel}
    >
      <div 
        style={{
          background: '#fff',
          borderRadius: '8px',
          boxShadow: '0 4px 24px rgba(0, 0, 0, 0.2)',
          minWidth: '500px',
          maxWidth: '600px',
          width: '90%',
          maxHeight: '80vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '20px 24px',
          borderBottom: '1px solid #e0e0e0'
        }}>
          <h3 style={{
            margin: 0,
            fontSize: '18px',
            fontWeight: 600,
            color: '#333'
          }}>Commit Changes</h3>
        </div>

        {/* Body */}
        <div style={{
          padding: '24px',
          overflowY: 'auto',
          flex: 1
        }}>
          {/* Files to commit */}
          <div style={{ marginBottom: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <label style={{ fontWeight: '500', fontSize: '14px' }}>Files to commit:</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  onClick={handleSelectAll}
                  style={{
                    padding: '4px 8px',
                    fontSize: '12px',
                    border: '1px solid #ccc',
                    borderRadius: '4px',
                    background: 'white',
                    cursor: 'pointer'
                  }}
                >
                  Select All
                </button>
                <button
                  type="button"
                  onClick={handleSelectNone}
                  style={{
                    padding: '4px 8px',
                    fontSize: '12px',
                    border: '1px solid #ccc',
                    borderRadius: '4px',
                    background: 'white',
                    cursor: 'pointer'
                  }}
                >
                  Select None
                </button>
              </div>
            </div>
            
            <div style={{ 
              border: '1px solid #e0e0e0', 
              borderRadius: '6px', 
              maxHeight: '200px', 
              overflowY: 'auto',
              padding: '8px'
            }}>
              {commitableFiles.length === 0 && pendingDeletions.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
                  No changes to commit
                </div>
              ) : (
                <>
                  {/* Modified Files */}
                  {commitableFiles.length > 0 && (
                    <>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: '#64748b', marginBottom: '8px' }}>
                        Modified Files ({commitableFiles.length})
                      </div>
                      {commitableFiles.map(file => (
                  <label
                    key={file.fileId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      padding: '8px',
                      cursor: 'pointer',
                      borderRadius: '4px',
                      marginBottom: '2px'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = '#f5f5f5';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedFiles.has(file.fileId)}
                      onChange={() => handleFileToggle(file.fileId)}
                      style={{ marginRight: '8px' }}
                    />
                    <span style={{ fontSize: '14px' }}>
                      {file.name} ({file.type})
                    </span>
                  </label>
                ))}
                    </>
                  )}
                  
                  {/* Pending Deletions */}
                  {pendingDeletions.length > 0 && (
                    <>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: '#dc2626', marginTop: '16px', marginBottom: '8px' }}>
                        Files to Delete ({pendingDeletions.length})
                      </div>
                      {pendingDeletions.map(deletion => (
                        <div
                          key={deletion.fileId}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '8px',
                            background: '#fee2e2',
                            borderRadius: '4px',
                            marginBottom: '4px'
                          }}
                        >
                          <span style={{ fontSize: '14px', color: '#dc2626' }}>
                            {deletion.fileId.replace(/^[^-]+-/, '')} ({deletion.type})
                          </span>
                          <button
                            onClick={() => fileRegistry.clearPendingDeletion(deletion.fileId)}
                            style={{
                              padding: '4px 8px',
                              fontSize: '12px',
                              border: '1px solid #fca5a5',
                              borderRadius: '4px',
                              background: 'white',
                              color: '#dc2626',
                              cursor: 'pointer'
                            }}
                            title="Unstage deletion"
                          >
                            Unstage
                          </button>
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Branch selection */}
          <div style={{ marginBottom: '20px' }}>
            <label style={{ fontWeight: '500', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
              Branch:
            </label>
            <select
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
              style={{
                width: '100%',
                padding: '8px',
                border: '1px solid #ccc',
                borderRadius: '4px',
                fontSize: '14px'
              }}
            >
              {availableBranches.map(branch => (
                <option key={branch} value={branch}>{branch}</option>
              ))}
            </select>
          </div>

          {/* Commit message */}
          <div style={{ marginBottom: '20px' }}>
            <label style={{ fontWeight: '500', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
              Commit message:
            </label>
            <textarea
              value={commitMessage}
              onChange={(e) => {
                console.log('[CommitModal] onChange:', e.target.value);
                setCommitMessage(e.target.value);
              }}
              onKeyDown={(e) => {
                console.log('[CommitModal] onKeyDown:', e.key, 'defaultPrevented:', e.defaultPrevented);
              }}
              onInput={(e) => {
                console.log('[CommitModal] onInput:', (e.target as HTMLTextAreaElement).value);
              }}
              onFocus={() => console.log('[CommitModal] textarea focused')}
              onBlur={() => console.log('[CommitModal] textarea blurred')}
              placeholder="Enter commit message..."
              className="commit-modal-textarea"
              style={{
                width: '100%',
                padding: '8px',
                border: '1px solid #ccc',
                borderRadius: '4px',
                fontSize: '14px',
                minHeight: '80px',
                resize: 'vertical'
              }}
            />
          </div>

          {/* Progress indicator */}
          {isLoading && progress && (
            <div style={{ marginBottom: '20px' }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '6px',
                fontSize: '13px',
                color: '#555'
              }}>
                <span>
                  {progress.phase === 'uploading'
                    ? `Uploading ${progress.completed} / ${progress.total} files…`
                    : 'Finalising commit…'}
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0}%
                </span>
              </div>
              <div style={{
                height: '6px',
                backgroundColor: '#e0e0e0',
                borderRadius: '3px',
                overflow: 'hidden'
              }}>
                <div style={{
                  height: '100%',
                  backgroundColor: progress.phase === 'finalising' ? '#f59e0b' : '#0066cc',
                  borderRadius: '3px',
                  width: `${progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0}%`,
                  transition: 'width 0.15s ease-out'
                }} />
              </div>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div style={{
              padding: '12px',
              backgroundColor: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: '6px',
              color: '#dc2626',
              fontSize: '14px',
              marginBottom: '20px',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '8px'
            }}>
              <span style={{ fontSize: '16px', lineHeight: '1.4', flexShrink: 0 }}>✗</span>
              <div>
                <div style={{ fontWeight: 600, marginBottom: '2px' }}>Commit failed</div>
                <div style={{ fontSize: '13px', color: '#b91c1c' }}>{error}</div>
              </div>
            </div>
          )}

          {/* Success message */}
          {success && (
            <div style={{
              padding: '12px',
              backgroundColor: '#f0fdf4',
              border: '1px solid #86efac',
              borderRadius: '6px',
              color: '#16a34a',
              fontSize: '14px',
              marginBottom: '20px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}>
              <span style={{ fontSize: '18px' }}>✓</span>
              <span>Successfully committed {selectedFiles.size} file{selectedFiles.size !== 1 ? 's' : ''} and pushed to <strong>{selectedBranch}</strong></span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid #e0e0e0',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '8px'
        }}>
          <button
            type="button"
            onClick={handleCancel}
            disabled={isLoading || success}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: 500,
              cursor: (isLoading || success) ? 'not-allowed' : 'pointer',
              border: 'none',
              backgroundColor: '#f0f0f0',
              color: '#333',
              opacity: (isLoading || success) ? 0.5 : 1
            }}
          >
            {success ? 'Closing...' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={handleCommit}
            disabled={isLoading || success || selectedFiles.size === 0 || !commitMessage.trim()}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: 500,
              cursor: (isLoading || success || selectedFiles.size === 0 || !commitMessage.trim()) ? 'not-allowed' : 'pointer',
              border: 'none',
              backgroundColor: success ? '#2e7d32' : '#0066cc',
              color: 'white',
              opacity: (isLoading || success || selectedFiles.size === 0 || !commitMessage.trim()) ? 0.5 : 1
            }}
          >
            {isLoading
              ? (progress
                  ? (progress.phase === 'finalising'
                      ? 'Finalising…'
                      : `Uploading ${progress.completed}/${progress.total}…`)
                  : 'Preparing…')
              : success
                ? 'Committed ✓'
                : 'Commit & Push'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
