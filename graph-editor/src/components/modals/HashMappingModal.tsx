/**
 * HashMappingModal — Commit-time hash guard UI.
 *
 * Presents a three-level tree (changed file → graph → parameter) with
 * tri-state checkboxes. The user selects which parameters should get
 * hash mappings to preserve historical snapshot access.
 *
 * @see docs/current/project-contexts/VARIANT_CONTEXTS_DESIGN.md
 */

import React, { useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { HashGuardResult, HashChangeItem } from '../../services/commitHashGuardService';

interface HashMappingModalProps {
  result: HashGuardResult;
  onConfirm: (selectedItems: HashChangeItem[]) => void;
  onCancel: () => void;
}

type CheckState = 'checked' | 'unchecked' | 'indeterminate';

export function HashMappingModal({ result, onConfirm, onCancel }: HashMappingModalProps) {
  // Track selection state per item key (paramId)
  const allItems = useMemo(() => {
    const items: HashChangeItem[] = [];
    for (const file of result.changedFiles) {
      for (const graph of file.graphs) {
        items.push(...graph.items);
      }
    }
    return items;
  }, [result]);

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(allItems.map(item => item.paramId))
  );

  // ─────────────────────────────────────────────────────────────────
  // Selection logic
  // ─────────────────────────────────────────────────────────────────

  const toggleItem = useCallback((paramId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(paramId)) next.delete(paramId);
      else next.add(paramId);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((items: HashChangeItem[]) => {
    setSelected(prev => {
      const next = new Set(prev);
      const allSelected = items.every(item => next.has(item.paramId));
      for (const item of items) {
        if (allSelected) next.delete(item.paramId);
        else next.add(item.paramId);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(allItems.map(item => item.paramId)));
  }, [allItems]);

  const selectNone = useCallback(() => {
    setSelected(new Set());
  }, []);

  const getGroupState = useCallback((items: HashChangeItem[]): CheckState => {
    const count = items.filter(item => selected.has(item.paramId)).length;
    if (count === 0) return 'unchecked';
    if (count === items.length) return 'checked';
    return 'indeterminate';
  }, [selected]);

  // ─────────────────────────────────────────────────────────────────
  // Expand/collapse state
  // ─────────────────────────────────────────────────────────────────

  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [expandedGraphs, setExpandedGraphs] = useState<Set<string>>(new Set());

  const toggleFileExpand = useCallback((fileId: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }, []);

  const toggleGraphExpand = useCallback((key: string) => {
    setExpandedGraphs(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ─────────────────────────────────────────────────────────────────
  // Handlers
  // ─────────────────────────────────────────────────────────────────

  const handleConfirm = useCallback(() => {
    const selectedItems = allItems.filter(item => selected.has(item.paramId));
    onConfirm(selectedItems);
  }, [allItems, selected, onConfirm]);

  const selectedCount = selected.size;
  const totalCount = allItems.length;

  // ─────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────

  return createPortal(
    <div style={overlayStyle}>
      <div style={modalStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <span style={{ fontWeight: 600, fontSize: '14px' }}>Snapshot Hash Mappings</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={selectAll} style={linkButtonStyle}>✓ All</button>
            <button onClick={selectNone} style={linkButtonStyle}>☐ None</button>
          </div>
        </div>

        {/* Tree */}
        <div style={treeContainerStyle}>
          {result.changedFiles.map(file => {
            const fileItems = file.graphs.flatMap(g => g.items);
            const fileState = getGroupState(fileItems);
            const fileExpanded = expandedFiles.has(file.fileId);
            const paramCount = fileItems.length;

            return (
              <div key={file.fileId}>
                {/* File level */}
                <div style={rowStyle}>
                  <TriStateCheckbox
                    state={fileState}
                    onChange={() => toggleGroup(fileItems)}
                  />
                  <button
                    onClick={() => toggleFileExpand(file.fileId)}
                    style={expandButtonStyle}
                  >
                    {fileExpanded ? '▼' : '▶'}
                  </button>
                  <span style={fileLabelStyle}>
                    {file.fileName}
                  </span>
                  <span style={countStyle}>{paramCount} params</span>
                </div>

                {/* Graph level */}
                {fileExpanded && file.graphs.map(graph => {
                  const graphKey = `${file.fileId}::${graph.graphFileId}`;
                  const graphState = getGroupState(graph.items);
                  const graphExpanded = expandedGraphs.has(graphKey);

                  return (
                    <div key={graphKey}>
                      <div style={{ ...rowStyle, paddingLeft: '24px' }}>
                        <TriStateCheckbox
                          state={graphState}
                          onChange={() => toggleGroup(graph.items)}
                        />
                        <button
                          onClick={() => toggleGraphExpand(graphKey)}
                          style={expandButtonStyle}
                        >
                          {graphExpanded ? '▼' : '▶'}
                        </button>
                        <span style={graphLabelStyle}>{graph.graphName}</span>
                        <span style={countStyle}>{graph.items.length} params</span>
                      </div>

                      {/* Parameter level */}
                      {graphExpanded && graph.items.map(item => (
                        <div key={item.paramId} style={{ ...rowStyle, paddingLeft: '48px' }}>
                          <TriStateCheckbox
                            state={selected.has(item.paramId) ? 'checked' : 'unchecked'}
                            onChange={() => toggleItem(item.paramId)}
                          />
                          <span style={paramLabelStyle}>{item.paramLabel}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          <span style={footerTextStyle}>
            {selectedCount === 0
              ? 'No mappings will be created.'
              : `${selectedCount} of ${totalCount} params selected (${selectedCount * 2} hash mappings).`
            }
          </span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={onCancel} style={cancelButtonStyle}>Cancel</button>
            <button onClick={handleConfirm} style={commitButtonStyle}>
              {selectedCount > 0 ? 'Commit' : 'Commit (no mappings)'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tri-state checkbox
// ─────────────────────────────────────────────────────────────────────────────

function TriStateCheckbox({ state, onChange }: { state: CheckState; onChange: () => void }) {
  const ref = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = state === 'indeterminate';
    }
  }, [state]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'checked'}
      onChange={onChange}
      style={{ cursor: 'pointer', margin: '0 4px 0 0', flexShrink: 0 }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles (inline, consistent with existing modal patterns)
// ─────────────────────────────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0, left: 0, right: 0, bottom: 0,
  backgroundColor: 'rgba(0, 0, 0, 0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 10001,
};

const modalStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-primary, #fff)',
  borderRadius: '8px',
  boxShadow: '0 4px 24px rgba(0, 0, 0, 0.2)',
  width: '520px',
  maxHeight: '70vh',
  display: 'flex',
  flexDirection: 'column',
  color: 'var(--text-primary, #1a1a1a)',
  fontSize: '13px',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '16px 20px 12px',
  borderBottom: '1px solid var(--border-color, #e5e7eb)',
};

const treeContainerStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '8px 12px',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '4px 8px',
  borderRadius: '4px',
  gap: '4px',
};

const expandButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: '0 2px',
  fontSize: '10px',
  color: 'var(--text-secondary, #6b7280)',
  lineHeight: 1,
  flexShrink: 0,
};

const fileLabelStyle: React.CSSProperties = {
  fontWeight: 500,
  fontFamily: 'var(--font-mono, monospace)',
  fontSize: '12px',
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const graphLabelStyle: React.CSSProperties = {
  fontWeight: 500,
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const paramLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono, monospace)',
  fontSize: '12px',
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--text-secondary, #6b7280)',
};

const countStyle: React.CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-tertiary, #9ca3af)',
  flexShrink: 0,
  marginLeft: '8px',
};

const linkButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: '12px',
  color: 'var(--text-link, #4f46e5)',
  padding: '2px 4px',
};

const footerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '12px 20px 16px',
  borderTop: '1px solid var(--border-color, #e5e7eb)',
  gap: '12px',
};

const footerTextStyle: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-secondary, #6b7280)',
  flex: 1,
};

const cancelButtonStyle: React.CSSProperties = {
  padding: '6px 16px',
  border: '1px solid var(--border-color, #d1d5db)',
  borderRadius: '6px',
  background: 'var(--bg-primary, #fff)',
  cursor: 'pointer',
  fontSize: '13px',
  color: 'var(--text-primary, #374151)',
};

const commitButtonStyle: React.CSSProperties = {
  padding: '6px 16px',
  border: 'none',
  borderRadius: '6px',
  background: 'var(--accent-primary, #4f46e5)',
  color: '#fff',
  cursor: 'pointer',
  fontSize: '13px',
  fontWeight: 500,
};
