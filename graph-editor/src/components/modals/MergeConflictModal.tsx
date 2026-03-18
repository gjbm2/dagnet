import React, { useEffect, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import './Modal.css';
import './MergeConflictModal.css';

export interface ConflictFile {
  fileId: string;
  fileName: string;
  path: string;
  type: string;
  localContent: string;
  remoteContent: string;
  baseContent: string;
  mergedContent: string;
  hasConflicts: boolean;
}

export type ConflictResolution = 'merged' | 'local' | 'remote' | 'manual';

interface MergeConflictModalProps {
  isOpen: boolean;
  onClose: () => void;
  conflicts: ConflictFile[];
  onResolve: (resolutions: Map<string, ConflictResolution>) => Promise<void>;
}

type DiffView = 'local-merged' | 'local-remote' | 'local-base' | 'remote-base';

/**
 * Merge Conflict Resolution Modal
 *
 * Default view: local vs merged result. The merged content is pre-computed
 * by the structural merge and preserves non-conflicting changes from both sides.
 * The user reviews the merged result and accepts it, or falls back to
 * local/remote/manual if they disagree.
 */
export function MergeConflictModal({
  isOpen,
  onClose,
  conflicts,
  onResolve
}: MergeConflictModalProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [resolutions, setResolutions] = useState<Map<string, ConflictResolution>>(new Map());
  const [isResolving, setIsResolving] = useState(false);
  const [diffView, setDiffView] = useState<DiffView>('local-merged');

  useEffect(() => {
    if (conflicts.length > 0) {
      setSelectedFile(conflicts[0].fileId);
      setResolutions(new Map());
      setDiffView('local-merged');
    }
  }, [conflicts]);

  if (!isOpen) return null;

  const currentFile = conflicts.find(c => c.fileId === selectedFile);
  const allResolved = conflicts.every(c => resolutions.has(c.fileId));

  const getLanguage = (file: ConflictFile) => {
    if (file.type === 'graph') return 'json';
    if (file.path.endsWith('.yaml') || file.path.endsWith('.yml')) return 'yaml';
    if (file.path.endsWith('.md')) return 'markdown';
    return 'plaintext';
  };

  const getDiffContent = (file: ConflictFile) => {
    switch (diffView) {
      case 'local-merged':
        return { original: file.localContent, modified: file.mergedContent };
      case 'local-remote':
        return { original: file.localContent, modified: file.remoteContent };
      case 'local-base':
        return { original: file.baseContent, modified: file.localContent };
      case 'remote-base':
        return { original: file.baseContent, modified: file.remoteContent };
    }
  };

  const handleResolve = (fileId: string, resolution: ConflictResolution) => {
    const next = new Map(resolutions);
    next.set(fileId, resolution);
    setResolutions(next);
  };

  const handleAcceptMergedAll = () => {
    const next = new Map(resolutions);
    for (const c of conflicts) next.set(c.fileId, 'merged');
    setResolutions(next);
  };

  const handleApply = async () => {
    if (!allResolved) return;
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
              {conflicts.length} file{conflicts.length !== 1 ? 's' : ''} changed on both sides.
              Review the proposed merge below — non-conflicting changes from both sides are combined automatically.
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
                      className={`view-button ${diffView === 'local-merged' ? 'active' : ''}`}
                      onClick={() => setDiffView('local-merged')}
                      title="Your version vs proposed merge result"
                    >
                      Local vs Merged
                    </button>
                    <button
                      className={`view-button ${diffView === 'local-remote' ? 'active' : ''}`}
                      onClick={() => setDiffView('local-remote')}
                      title="Your version vs incoming remote version"
                    >
                      Local vs Remote
                    </button>
                    <button
                      className={`view-button ${diffView === 'local-base' ? 'active' : ''}`}
                      onClick={() => setDiffView('local-base')}
                      title="Original vs your changes"
                    >
                      Base vs Local
                    </button>
                    <button
                      className={`view-button ${diffView === 'remote-base' ? 'active' : ''}`}
                      onClick={() => setDiffView('remote-base')}
                      title="Original vs incoming changes"
                    >
                      Base vs Remote
                    </button>
                  </div>
                </div>

                <div className="conflict-options">
                  <button
                    className={`option-button primary ${resolutions.get(currentFile.fileId) === 'merged' ? 'selected' : ''}`}
                    onClick={() => handleResolve(currentFile.fileId, 'merged')}
                    title="Accept the auto-merged result (combines both sides)"
                  >
                    Accept Merged
                  </button>
                  <button
                    className={`option-button ${resolutions.get(currentFile.fileId) === 'local' ? 'selected' : ''}`}
                    onClick={() => handleResolve(currentFile.fileId, 'local')}
                  >
                    Keep Local
                  </button>
                  <button
                    className={`option-button ${resolutions.get(currentFile.fileId) === 'remote' ? 'selected' : ''}`}
                    onClick={() => handleResolve(currentFile.fileId, 'remote')}
                  >
                    Use Remote
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
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <div className="footer-batch-actions">
            <button
              className="button batch primary"
              onClick={handleAcceptMergedAll}
              disabled={isResolving}
              title="Accept the auto-merged result for all files"
            >
              Accept Merged for all
            </button>
            <button
              className="button secondary"
              onClick={() => {
                const dump = conflicts.map(c => ({
                  fileId: c.fileId,
                  fileName: c.fileName,
                  path: c.path,
                  type: c.type,
                  hasConflicts: c.hasConflicts,
                  localContent: c.localContent,
                  remoteContent: c.remoteContent,
                  baseContent: c.baseContent,
                  mergedContent: c.mergedContent,
                }));
                navigator.clipboard.writeText(JSON.stringify(dump, null, 2));
              }}
              title="Copy all conflict data as JSON to clipboard"
            >
              Copy JSON
            </button>
          </div>
          <div className="footer-main-actions">
            <button className="button secondary" onClick={onClose} disabled={isResolving}>
              Cancel
            </button>
            <button
              className="button primary"
              onClick={handleApply}
              disabled={!allResolved || isResolving}
            >
              {isResolving ? 'Applying...' : 'Apply'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
