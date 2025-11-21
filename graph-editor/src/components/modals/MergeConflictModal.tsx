import React, { useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import './MergeConflictModal.css';

export interface ConflictFile {
  fileId: string;
  fileName: string;
  path: string;
  type: string;
  localContent: string;
  remoteContent: string;
  baseContent: string;
  mergedContent: string; // Content with conflict markers
  hasConflicts: boolean;
}

interface MergeConflictModalProps {
  isOpen: boolean;
  onClose: () => void;
  conflicts: ConflictFile[];
  onResolve: (resolutions: Map<string, 'local' | 'remote' | 'manual'>) => Promise<void>;
}

/**
 * Merge Conflict Resolution Modal
 * 
 * Shows conflicts from pull operation and lets user choose:
 * - Use local version (keep your changes)
 * - Use remote version (accept incoming changes)
 * - Manual merge (edit to resolve)
 */
export function MergeConflictModal({ 
  isOpen, 
  onClose, 
  conflicts, 
  onResolve 
}: MergeConflictModalProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(
    conflicts.length > 0 ? conflicts[0].fileId : null
  );
  const [resolutions, setResolutions] = useState<Map<string, 'local' | 'remote' | 'manual'>>(
    new Map()
  );
  const [isResolving, setIsResolving] = useState(false);
  const [diffView, setDiffView] = useState<'local-remote' | 'local-base' | 'remote-base'>('local-remote');

  if (!isOpen) return null;

  const currentFile = conflicts.find(c => c.fileId === selectedFile);
  const allResolved = conflicts.every(c => resolutions.has(c.fileId));

  // Get language for Monaco based on file type
  const getLanguage = (file: ConflictFile) => {
    if (file.type === 'graph') return 'json';
    if (file.path.endsWith('.yaml') || file.path.endsWith('.yml')) return 'yaml';
    if (file.path.endsWith('.md')) return 'markdown';
    return 'plaintext';
  };

  // Get left and right content for diff based on current view
  const getDiffContent = (file: ConflictFile) => {
    switch (diffView) {
      case 'local-remote':
        return { original: file.localContent, modified: file.remoteContent, label: 'Local vs Remote' };
      case 'local-base':
        return { original: file.baseContent, modified: file.localContent, label: 'Base vs Local (Your changes)' };
      case 'remote-base':
        return { original: file.baseContent, modified: file.remoteContent, label: 'Base vs Remote (Incoming)' };
    }
  };

  const handleResolve = (fileId: string, resolution: 'local' | 'remote' | 'manual') => {
    const newResolutions = new Map(resolutions);
    newResolutions.set(fileId, resolution);
    setResolutions(newResolutions);
  };

  const handleApply = async () => {
    if (!allResolved) {
      alert('Please resolve all conflicts before applying');
      return;
    }

    setIsResolving(true);
    try {
      await onResolve(resolutions);
      onClose();
    } catch (error) {
      alert(`Failed to apply resolutions: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsResolving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="merge-conflict-modal">
        <div className="modal-header">
          <h2>Merge Conflicts</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        <div className="modal-content">
          <div className="conflict-summary">
            <p>
              {conflicts.length} file{conflicts.length !== 1 ? 's' : ''} with conflicts.
              Both you and the remote repository modified the same lines.
            </p>
          </div>

          <div className="conflict-layout">
            {/* File list */}
            <div className="conflict-file-list">
              <h3>Files</h3>
              {conflicts.map(file => (
                <div
                  key={file.fileId}
                  className={`conflict-file-item ${selectedFile === file.fileId ? 'selected' : ''} ${resolutions.has(file.fileId) ? 'resolved' : ''}`}
                  onClick={() => setSelectedFile(file.fileId)}
                >
                  <div className="file-name">{file.fileName}</div>
                  <div className="conflict-count">
                    Conflict
                  </div>
                  {resolutions.has(file.fileId) && (
                    <div className="resolution-badge">
                      {resolutions.get(file.fileId)?.toUpperCase()}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Conflict details */}
            {currentFile && (
              <div className="conflict-details">
                <div className="details-header">
                  <h3>{currentFile.fileName}</h3>
                  <div className="diff-view-selector">
                    <button
                      className={`view-button ${diffView === 'local-remote' ? 'active' : ''}`}
                      onClick={() => setDiffView('local-remote')}
                      title="Compare your changes with incoming changes"
                    >
                      Local ↔ Remote
                    </button>
                    <button
                      className={`view-button ${diffView === 'local-base' ? 'active' : ''}`}
                      onClick={() => setDiffView('local-base')}
                      title="See your changes from the original"
                    >
                      Local vs Base
                    </button>
                    <button
                      className={`view-button ${diffView === 'remote-base' ? 'active' : ''}`}
                      onClick={() => setDiffView('remote-base')}
                      title="See incoming changes from the original"
                    >
                      Remote vs Base
                    </button>
                  </div>
                </div>
                
                <div className="conflict-options">
                  <button
                    className={`option-button ${resolutions.get(currentFile.fileId) === 'local' ? 'selected' : ''}`}
                    onClick={() => handleResolve(currentFile.fileId, 'local')}
                  >
                    Keep Local (Your Changes)
                  </button>
                  <button
                    className={`option-button ${resolutions.get(currentFile.fileId) === 'remote' ? 'selected' : ''}`}
                    onClick={() => handleResolve(currentFile.fileId, 'remote')}
                  >
                    Use Remote (Incoming)
                  </button>
                  <button
                    className={`option-button ${resolutions.get(currentFile.fileId) === 'manual' ? 'selected' : ''}`}
                    onClick={() => handleResolve(currentFile.fileId, 'manual')}
                    title="Edit the file manually to resolve conflicts"
                  >
                    Manual Merge
                  </button>
                </div>

                <div className="monaco-diff-container">
                  <DiffEditor
                    height="500px"
                    language={getLanguage(currentFile)}
                    original={getDiffContent(currentFile).original}
                    modified={getDiffContent(currentFile).modified}
                    options={{
                      readOnly: true,
                      renderSideBySide: true,
                      ignoreTrimWhitespace: false,
                      renderOverviewRuler: true,
                      minimap: { enabled: true },
                      scrollBeyondLastLine: false,
                      fontSize: 13,
                      lineNumbers: 'on',
                      folding: true,
                      wordWrap: 'on',
                    }}
                  />
                </div>

                <div className="conflict-summary-info">
                  <strong>Merge conflict</strong> detected - choose resolution
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button className="button secondary" onClick={onClose} disabled={isResolving}>
            Cancel
          </button>
          <button
            className="button primary"
            onClick={handleApply}
            disabled={!allResolved || isResolving}
          >
            {isResolving ? 'Applying...' : 'Apply Resolutions'}
          </button>
        </div>
      </div>
    </div>
  );
}

