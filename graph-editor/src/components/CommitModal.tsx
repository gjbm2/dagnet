import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTabContext, fileRegistry } from '../contexts/TabContext';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { gitService } from '../services/gitService';
import { ObjectType } from '../types';

interface CommitModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCommit: (files: CommitFile[], message: string, branch: string) => Promise<void>;
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
  
  // Track if we've initialized the selected files
  const initializedRef = useRef(false);

  // Get dirty files that can be committed - calculate directly to avoid infinite loops
  const getCommittableFiles = () => {
    if (!isOpen) return [];
    
    const dirtyFiles = fileRegistry.getDirtyFiles();
    return dirtyFiles
      .filter(file => {
        const type = file.fileId.split('-')[0] as ObjectType;
        // Only allow graph, parameter, context, case files
        return ['graph', 'parameter', 'context', 'case'].includes(type);
      })
      .map(file => {
        const fileId = file.fileId;
        const type = fileId.split('-')[0] as ObjectType;
        const name = fileId.split('-').slice(1).join('-');
        
        // Determine file extension and path
        const extension = type === 'graph' ? 'json' : 'yaml';
        // Remove extension from name if it already has one
        const nameWithoutExt = name.replace(/\.(json|yaml|yml)$/, '');
        const fileName = `${nameWithoutExt}.${extension}`;
        
        return {
          fileId,
          name: nameWithoutExt,
          type,
          path: `${type}s/${fileName}`,
          content: file.data ? JSON.stringify(file.data, null, 2) : '',
          sha: file.sha
        };
      });
  };
  
  const commitableFiles = getCommittableFiles();

  // Initialize selected files when modal opens - use a separate effect for modal state
  useEffect(() => {
    if (isOpen && !initializedRef.current) {
      initializedRef.current = true;
    } else if (!isOpen) {
      // Reset when modal closes
      initializedRef.current = false;
      setSelectedFiles(new Set());
      setCommitMessage('');
      setError(null);
      setSuccess(false);
    }
  }, [isOpen]);

  // Initialize selected files when commitableFiles change (but only if modal is open and not initialized)
  useEffect(() => {
    if (isOpen && initializedRef.current && commitableFiles.length > 0 && selectedFiles.size === 0) {
      if (preselectedFiles.length > 0) {
        setSelectedFiles(new Set(preselectedFiles));
      } else {
        // Select all commitable files by default
        const fileIds = commitableFiles.map(f => f.fileId);
        setSelectedFiles(new Set(fileIds));
      }
    }
  }, [commitableFiles, preselectedFiles, isOpen, selectedFiles.size]);

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

    try {
      const filesToCommit = commitableFiles.filter(f => selectedFiles.has(f.fileId));
      await onCommit(filesToCommit, commitMessage.trim(), selectedBranch);
      
      // Show success message
      setSuccess(true);
      setIsLoading(false);
      
      // Close modal after a short delay to let user see success
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (error) {
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
              {commitableFiles.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
                  No files to commit
                </div>
              ) : (
                commitableFiles.map(file => (
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
                ))
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
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Enter commit message..."
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

          {/* Error message */}
          {error && (
            <div style={{
              padding: '12px',
              backgroundColor: '#fee',
              border: '1px solid #fcc',
              borderRadius: '4px',
              color: '#c33',
              fontSize: '14px',
              marginBottom: '20px'
            }}>
              {error}
            </div>
          )}

          {/* Success message */}
          {success && (
            <div style={{
              padding: '12px',
              backgroundColor: '#e8f5e9',
              border: '1px solid #a5d6a7',
              borderRadius: '4px',
              color: '#2e7d32',
              fontSize: '14px',
              marginBottom: '20px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}>
              <span style={{ fontSize: '18px' }}>✓</span>
              <span>Successfully committed {selectedFiles.size} file{selectedFiles.size !== 1 ? 's' : ''} and pushed to {selectedBranch}</span>
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
            {isLoading ? 'Committing...' : success ? 'Committed ✓' : 'Commit & Push'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
