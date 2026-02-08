import React, { useState, useEffect } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { HistoryCommit } from '../../hooks/useViewHistory';
import './Modal.css';
import './MergeConflictModal.css'; // Reuse the diff layout styles

interface HistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  fileName: string | null;
  filePath: string | null;
  isLoading: boolean;
  history: HistoryCommit[];
  currentContent: string | null;
  onLoadHistory: () => Promise<HistoryCommit[]>;
  onGetContentAtCommit: (sha: string) => Promise<string | null>;
  onRollback: (sha: string) => Promise<boolean>;
  /** Open the selected commit as a read-only temporary tab */
  onView?: (sha: string) => Promise<void>;
}

/**
 * File History Modal
 * 
 * Shows commit history for a file and allows:
 * - Viewing diff between versions
 * - Rolling back to a previous version
 * 
 * Reuses styles from Modal.css and MergeConflictModal.css
 */
export function HistoryModal({
  isOpen,
  onClose,
  fileName,
  filePath,
  isLoading,
  history,
  currentContent,
  onLoadHistory,
  onGetContentAtCommit,
  onRollback,
  onView,
}: HistoryModalProps) {
  const [selectedCommit, setSelectedCommit] = useState<HistoryCommit | null>(null);
  const [compareCommit, setCompareCommit] = useState<HistoryCommit | null>(null);
  const [selectedContent, setSelectedContent] = useState<string | null>(null);
  const [compareContent, setCompareContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [loadingCompare, setLoadingCompare] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [diffMode, setDiffMode] = useState<'current' | 'previous'>('current');

  // Load history when modal opens
  useEffect(() => {
    if (isOpen && history.length === 0) {
      onLoadHistory();
    }
  }, [isOpen, history.length, onLoadHistory]);

  // Load content when commit is selected
  useEffect(() => {
    if (!selectedCommit) {
      setSelectedContent(null);
      return;
    }

    const loadContent = async () => {
      setLoadingContent(true);
      const content = await onGetContentAtCommit(selectedCommit.sha);
      setSelectedContent(content);
      setLoadingContent(false);
    };

    loadContent();
  }, [selectedCommit, onGetContentAtCommit]);

  // Load compare content when compare commit changes
  useEffect(() => {
    if (!compareCommit) {
      setCompareContent(null);
      return;
    }

    const loadContent = async () => {
      setLoadingCompare(true);
      const content = await onGetContentAtCommit(compareCommit.sha);
      setCompareContent(content);
      setLoadingCompare(false);
    };

    loadContent();
  }, [compareCommit, onGetContentAtCommit]);

  // Auto-select first commit when history loads
  useEffect(() => {
    if (history.length > 0 && !selectedCommit) {
      setSelectedCommit(history[0]);
    }
  }, [history, selectedCommit]);

  const handleRollback = async () => {
    if (!selectedCommit) return;
    
    setIsRollingBack(true);
    const success = await onRollback(selectedCommit.sha);
    setIsRollingBack(false);
    
    if (success) {
      onClose();
    }
  };

  const [isViewing, setIsViewing] = useState(false);

  const handleView = async () => {
    if (!selectedCommit || !onView) return;
    
    setIsViewing(true);
    await onView(selectedCommit.sha);
    setIsViewing(false);
    onClose();
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

  // Get language for Monaco
  const getLanguage = () => {
    if (!filePath) return 'plaintext';
    if (filePath.endsWith('.json')) return 'json';
    if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) return 'yaml';
    if (filePath.endsWith('.md')) return 'markdown';
    return 'plaintext';
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      {/* Reuse merge-conflict-modal class for the same layout */}
      <div className="merge-conflict-modal">
        <div className="modal-header">
          <h2>History: {fileName}</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        <div className="modal-content">
          {isLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '300px', color: 'var(--color-text-secondary, #666)' }}>
              <p>Loading history...</p>
            </div>
          ) : history.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '300px', color: 'var(--color-text-secondary, #666)' }}>
              <p>No history found for this file.</p>
            </div>
          ) : (
            <div className="conflict-layout">
              {/* Commit list - reuse conflict-file-list styles */}
              <div className="conflict-file-list">
                <h3>Commits ({history.length})</h3>
                {history.map((commit, idx) => (
                  <div
                    key={commit.sha}
                    className={`conflict-file-item ${selectedCommit?.sha === commit.sha ? 'selected' : ''}`}
                    onClick={() => setSelectedCommit(commit)}
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
                          Latest
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '13px', margin: '4px 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {commit.message}
                    </div>
                    <div className="conflict-count">
                      {commit.author} · {formatDate(commit.date)}
                    </div>
                  </div>
                ))}
              </div>

              {/* Diff viewer - reuse conflict-details styles */}
              <div className="conflict-details">
                {selectedCommit && (
                  <>
                    <div className="details-header">
                      <h3>
                        <code style={{ fontFamily: 'monospace', marginRight: '8px' }}>{selectedCommit.shortSha}</code>
                        {selectedCommit.message}
                      </h3>
                      <div className="diff-view-selector">
                        <button
                          className={`view-button ${diffMode === 'current' ? 'active' : ''}`}
                          onClick={() => {
                            setDiffMode('current');
                            setCompareCommit(null);
                          }}
                        >
                          vs Current
                        </button>
                        <button
                          className={`view-button ${diffMode === 'previous' ? 'active' : ''}`}
                          onClick={() => {
                            setDiffMode('previous');
                            const idx = history.findIndex(h => h.sha === selectedCommit.sha);
                            if (idx < history.length - 1) {
                              setCompareCommit(history[idx + 1]);
                            }
                          }}
                          disabled={history.findIndex(h => h.sha === selectedCommit.sha) >= history.length - 1}
                        >
                          vs Previous
                        </button>
                      </div>
                    </div>

                    <div style={{ 
                      display: 'flex', 
                      justifyContent: 'space-between', 
                      padding: '8px 12px', 
                      background: 'var(--color-bg-secondary, #f5f5f5)', 
                      borderRadius: '4px 4px 0 0',
                      fontSize: '12px',
                      color: 'var(--color-text-secondary, #666)'
                    }}>
                      <span style={{ color: 'var(--color-danger, #d32f2f)' }}>
                        {diffMode === 'current' ? 'Current (working copy)' : compareCommit?.shortSha || 'Previous'}
                      </span>
                      <span style={{ color: 'var(--color-success, #4caf50)' }}>
                        Selected: {selectedCommit.shortSha}
                      </span>
                    </div>

                    <div className="monaco-diff-container" style={{ position: 'relative' }}>
                      {/* Loading overlay - show when any content is loading */}
                      {(loadingContent || (diffMode === 'previous' && loadingCompare)) && (
                        <div style={{ 
                          position: 'absolute', 
                          inset: 0, 
                          display: 'flex', 
                          alignItems: 'center', 
                          justifyContent: 'center', 
                          background: 'rgba(255,255,255,0.8)', 
                          zIndex: 10,
                          color: 'var(--color-text-secondary, #666)'
                        }}>
                          <span>Loading content...</span>
                        </div>
                      )}
                      <DiffEditor
                        height="400px"
                        language={getLanguage()}
                        original={diffMode === 'current' ? (currentContent || '') : (compareContent || '')}
                        modified={selectedContent || ''}
                        options={{
                          readOnly: true,
                          renderSideBySide: true,
                          ignoreTrimWhitespace: false,
                          renderOverviewRuler: true,
                          minimap: { enabled: false },
                          scrollBeyondLastLine: false,
                          fontSize: 13,
                          lineNumbers: 'on',
                          folding: true,
                          wordWrap: 'on',
                        }}
                      />
                    </div>

                    {/* Actions: View + Rollback */}
                    {selectedCommit && (
                      <div className="conflict-summary-info" style={{ marginTop: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                        {history[0]?.sha !== selectedCommit.sha ? (
                          <span style={{ fontSize: '12px' }}>
                            ⚠️ Rolling back will replace current content with this version. Commit to save.
                          </span>
                        ) : (
                          <span style={{ fontSize: '12px', color: 'var(--color-text-secondary, #666)' }}>
                            This is the latest committed version.
                          </span>
                        )}
                        <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                          {onView && (
                            <button
                              className="option-button"
                              onClick={handleView}
                              disabled={isViewing || isRollingBack}
                              style={{ 
                                flex: 'none',
                                background: 'var(--color-bg-secondary, #f5f5f5)',
                                color: 'var(--color-text-primary, #333)',
                                border: '1px solid var(--color-border, #ddd)',
                              }}
                            >
                              {isViewing ? 'Opening...' : `View ${selectedCommit.shortSha}`}
                            </button>
                          )}
                          {history[0]?.sha !== selectedCommit.sha && (
                            <button
                              className="option-button"
                              onClick={handleRollback}
                              disabled={isRollingBack || isViewing}
                              style={{ 
                                flex: 'none', 
                                background: 'var(--color-primary, #2196f3)', 
                                color: '#fff',
                                border: 'none'
                              }}
                            >
                              {isRollingBack ? 'Rolling back...' : `Rollback to ${selectedCommit.shortSha}`}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="button secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
