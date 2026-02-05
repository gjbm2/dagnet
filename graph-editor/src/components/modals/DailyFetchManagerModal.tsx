/**
 * Daily Fetch Manager Modal
 * 
 * Transfer-list style modal for bulk management of which graphs have dailyFetch=true.
 * 
 * - Left panel: Available graphs (dailyFetch=false or undefined)
 * - Right panel: Daily Fetch enabled (dailyFetch=true)
 * - Transfer buttons to move selected graphs between panels
 * - Workspace-scoped: only shows graphs from current repo/branch
 */

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronRight, ChevronLeft } from 'lucide-react';
import { dailyFetchService, type GraphListItem, type DailyFetchChange } from '../../services/dailyFetchService';
import './Modal.css';

interface DailyFetchManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  workspace: { repository: string; branch: string } | null;
}

export function DailyFetchManagerModal({ isOpen, onClose, workspace }: DailyFetchManagerModalProps) {
  const [allGraphs, setAllGraphs] = useState<GraphListItem[]>([]);
  const [selectedLeft, setSelectedLeft] = useState<Set<string>>(new Set());
  const [selectedRight, setSelectedRight] = useState<Set<string>>(new Set());
  const [pendingChanges, setPendingChanges] = useState<Map<string, boolean>>(new Map());
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  // Load all graphs from IDB on open
  useEffect(() => {
    if (!isOpen || !workspace) {
      setAllGraphs([]);
      setPendingChanges(new Map());
      setSelectedLeft(new Set());
      setSelectedRight(new Set());
      return;
    }

    setLoading(true);
    dailyFetchService.getGraphsForWorkspace(workspace)
      .then((items) => {
        setAllGraphs(items);
        setPendingChanges(new Map());
        setSelectedLeft(new Set());
        setSelectedRight(new Set());
      })
      .catch((err) => {
        console.error('[DailyFetchManagerModal] Failed to load graphs:', err);
        setAllGraphs([]);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [isOpen, workspace]);

  // Derive current state (original + pending changes)
  const getEffectiveDailyFetch = (item: GraphListItem): boolean => {
    return pendingChanges.has(item.fileId) 
      ? pendingChanges.get(item.fileId)! 
      : item.dailyFetch;
  };

  const availableGraphs = allGraphs.filter(g => !getEffectiveDailyFetch(g));
  const enabledGraphs = allGraphs.filter(g => getEffectiveDailyFetch(g));

  const moveToEnabled = () => {
    const newChanges = new Map(pendingChanges);
    selectedLeft.forEach(fileId => newChanges.set(fileId, true));
    setPendingChanges(newChanges);
    setSelectedLeft(new Set());
  };

  const moveToAvailable = () => {
    const newChanges = new Map(pendingChanges);
    selectedRight.forEach(fileId => newChanges.set(fileId, false));
    setPendingChanges(newChanges);
    setSelectedRight(new Set());
  };

  const handleSave = async () => {
    if (pendingChanges.size === 0) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      const changes: DailyFetchChange[] = Array.from(pendingChanges.entries()).map(([fileId, dailyFetch]) => ({
        graphFileId: fileId,
        dailyFetch,
      }));
      await dailyFetchService.applyChanges(changes);
      onClose();
    } catch (err) {
      console.error('[DailyFetchManagerModal] Failed to save:', err);
    } finally {
      setSaving(false);
    }
  };

  const toggleLeftSelection = (fileId: string) => {
    const newSet = new Set(selectedLeft);
    if (newSet.has(fileId)) {
      newSet.delete(fileId);
    } else {
      newSet.add(fileId);
    }
    setSelectedLeft(newSet);
  };

  const toggleRightSelection = (fileId: string) => {
    const newSet = new Set(selectedRight);
    if (newSet.has(fileId)) {
      newSet.delete(fileId);
    } else {
      newSet.add(fileId);
    }
    setSelectedRight(newSet);
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={e => e.stopPropagation()} style={{ maxWidth: '750px' }}>
        <div className="modal-header">
          <h2 className="modal-title">Automated Daily Fetches</h2>
          <button onClick={onClose} className="modal-close-btn"><X size={20} /></button>
        </div>

        <div className="modal-body">
          {!workspace ? (
            <p style={{ color: '#6B7280', textAlign: 'center', padding: '32px' }}>
              No workspace selected. Please select a repository and branch first.
            </p>
          ) : loading ? (
            <p style={{ color: '#6B7280', textAlign: 'center', padding: '32px' }}>
              Loading graphs...
            </p>
          ) : allGraphs.length === 0 ? (
            <p style={{ color: '#6B7280', textAlign: 'center', padding: '32px' }}>
              No graphs found in this workspace.
            </p>
          ) : (
            <>
              <div style={{ display: 'flex', gap: '16px', alignItems: 'stretch' }}>
                {/* Left: Available graphs */}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, marginBottom: '8px', fontSize: '13px', color: '#374151' }}>
                    Available Graphs ({availableGraphs.length})
                  </div>
                  <div style={{
                    border: '1px solid #E5E7EB',
                    borderRadius: '4px',
                    height: '280px',
                    overflowY: 'auto',
                    background: '#F9FAFB'
                  }}>
                    {availableGraphs.length === 0 ? (
                      <div style={{ padding: '16px', color: '#6B7280', fontSize: '12px', textAlign: 'center' }}>
                        All graphs are enabled for daily fetch
                      </div>
                    ) : (
                      availableGraphs.map(g => (
                        <label
                          key={g.fileId}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '8px 12px',
                            cursor: 'pointer',
                            borderBottom: '1px solid #E5E7EB',
                            background: selectedLeft.has(g.fileId) ? '#DBEAFE' : 'transparent'
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={selectedLeft.has(g.fileId)}
                            onChange={() => toggleLeftSelection(g.fileId)}
                            style={{ width: '14px', height: '14px' }}
                          />
                          <span style={{ fontSize: '13px', flex: 1 }}>{g.name}</span>
                          {!g.hasPinnedQuery && (
                            <span title="No pinned query set" style={{ color: '#F59E0B', fontSize: '12px' }}>⚠️</span>
                          )}
                        </label>
                      ))
                    )}
                  </div>
                </div>

                {/* Center: Transfer buttons */}
                <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '8px' }}>
                  <button
                    onClick={moveToEnabled}
                    disabled={selectedLeft.size === 0}
                    style={{
                      padding: '8px 12px',
                      borderRadius: '4px',
                      border: '1px solid #D1D5DB',
                      background: selectedLeft.size > 0 ? '#3B82F6' : '#F3F4F6',
                      color: selectedLeft.size > 0 ? 'white' : '#9CA3AF',
                      cursor: selectedLeft.size > 0 ? 'pointer' : 'not-allowed',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                    title="Move selected to Daily Fetch"
                  >
                    <ChevronRight size={16} />
                  </button>
                  <button
                    onClick={moveToAvailable}
                    disabled={selectedRight.size === 0}
                    style={{
                      padding: '8px 12px',
                      borderRadius: '4px',
                      border: '1px solid #D1D5DB',
                      background: selectedRight.size > 0 ? '#3B82F6' : '#F3F4F6',
                      color: selectedRight.size > 0 ? 'white' : '#9CA3AF',
                      cursor: selectedRight.size > 0 ? 'pointer' : 'not-allowed',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                    title="Remove from Daily Fetch"
                  >
                    <ChevronLeft size={16} />
                  </button>
                </div>

                {/* Right: Enabled graphs */}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, marginBottom: '8px', fontSize: '13px', color: '#374151' }}>
                    Daily Fetch Enabled ({enabledGraphs.length})
                  </div>
                  <div style={{
                    border: '1px solid #E5E7EB',
                    borderRadius: '4px',
                    height: '280px',
                    overflowY: 'auto',
                    background: '#F0FDF4'
                  }}>
                    {enabledGraphs.length === 0 ? (
                      <div style={{ padding: '16px', color: '#6B7280', fontSize: '12px', textAlign: 'center' }}>
                        No graphs enabled for daily fetch
                      </div>
                    ) : (
                      enabledGraphs.map(g => (
                        <label
                          key={g.fileId}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '8px 12px',
                            cursor: 'pointer',
                            borderBottom: '1px solid #D1FAE5',
                            background: selectedRight.has(g.fileId) ? '#DBEAFE' : 'transparent'
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={selectedRight.has(g.fileId)}
                            onChange={() => toggleRightSelection(g.fileId)}
                            style={{ width: '14px', height: '14px' }}
                          />
                          <span style={{ fontSize: '13px', flex: 1 }}>{g.name}</span>
                          {!g.hasPinnedQuery && (
                            <span title="No pinned query set" style={{ color: '#F59E0B', fontSize: '12px' }}>⚠️</span>
                          )}
                        </label>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <p style={{ marginTop: '16px', fontSize: '12px', color: '#6B7280', lineHeight: '1.5' }}>
                ℹ️ Graphs with Daily Fetch enabled will be processed automatically when using{' '}
                <code style={{ background: '#F3F4F6', padding: '2px 4px', borderRadius: '2px' }}>?retrieveall</code>{' '}
                (without specifying graph names). Graphs without a pinned query (⚠️) will still run but skip the retrieve step.
              </p>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="modal-btn modal-btn-secondary">
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="modal-btn modal-btn-primary"
            disabled={saving || pendingChanges.size === 0}
          >
            {saving ? 'Saving...' : `Save Changes${pendingChanges.size > 0 ? ` (${pendingChanges.size})` : ''}`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
