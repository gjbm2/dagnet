import React, { useState, useMemo } from 'react';
import './Modal.css';

interface MissingIndexEntry {
  id: string;
  type: 'node' | 'case' | 'parameter' | 'context';
  referencedIn: string[];  // Graph files that reference this ID
}

interface SyncIndexModalProps {
  isOpen: boolean;
  onClose: () => void;
  graphFiles: Array<{ id: string; name: string }>;
}

/**
 * Sync Index from Graph Modal
 * 
 * Allows user to:
 * 1. Select a graph file
 * 2. Scan it for references to nodes/cases/parameters/contexts
 * 3. Identify which IDs are missing from their respective indexes
 * 4. Batch-create index entries for selected missing IDs
 */
export function SyncIndexModal({ isOpen, onClose, graphFiles }: SyncIndexModalProps) {
  const [selectedGraphId, setSelectedGraphId] = useState<string>('');
  const [isScanning, setIsScanning] = useState(false);
  const [missingEntries, setMissingEntries] = useState<MissingIndexEntry[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(['nodes', 'cases', 'parameters', 'contexts'])
  );

  if (!isOpen) return null;

  const handleScan = async () => {
    if (!selectedGraphId) return;

    setIsScanning(true);
    try {
      // TODO: Implement graph scanning logic
      // 1. Load graph file content
      // 2. Parse for node_id, case_id, parameter references, context references
      // 3. Check each against existing indexes
      // 4. Populate missingEntries with IDs not found in indexes
      
      // Placeholder: simulate scan
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const mockMissingEntries: MissingIndexEntry[] = [
        { id: 'email-conversion', type: 'node', referencedIn: [selectedGraphId] },
        { id: 'abandoned-cart', type: 'case', referencedIn: [selectedGraphId] },
        { id: 'conversion-rate', type: 'parameter', referencedIn: [selectedGraphId] },
      ];
      
      setMissingEntries(mockMissingEntries);
      setSelectedIds(new Set(mockMissingEntries.map(e => e.id)));
    } catch (error) {
      console.error('Failed to scan graph:', error);
    } finally {
      setIsScanning(false);
    }
  };

  const handleCreateIndexEntries = async () => {
    if (selectedIds.size === 0) return;

    try {
      // TODO: Implement index entry creation
      // For each selected ID:
      // 1. Load the appropriate index file (e.g., parameters-index.yaml)
      // 2. Add new entry with minimal metadata
      // 3. Mark index file as dirty
      // 4. Save to FileRegistry
      
      console.log('Creating index entries for:', Array.from(selectedIds));
      
      // Close modal after successful creation
      onClose();
    } catch (error) {
      console.error('Failed to create index entries:', error);
    }
  };

  const toggleCategory = (category: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const toggleSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAll = (type: string) => {
    const entriesOfType = missingEntries.filter(e => e.type === type);
    const allSelected = entriesOfType.every(e => selectedIds.has(e.id));
    
    setSelectedIds(prev => {
      const next = new Set(prev);
      entriesOfType.forEach(entry => {
        if (allSelected) {
          next.delete(entry.id);
        } else {
          next.add(entry.id);
        }
      });
      return next;
    });
  };

  const groupedEntries = useMemo(() => {
    const filtered = missingEntries.filter(entry => 
      entry.id.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return {
      nodes: filtered.filter(e => e.type === 'node'),
      cases: filtered.filter(e => e.type === 'case'),
      parameters: filtered.filter(e => e.type === 'parameter'),
      contexts: filtered.filter(e => e.type === 'context'),
    };
  }, [missingEntries, searchQuery]);

  const totalCount = missingEntries.length;
  const selectedCount = selectedIds.size;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '700px' }}>
        <div className="modal-header">
          <h2 className="modal-title">Sync Index from Graph</h2>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {/* Graph selector */}
          <div className="modal-field">
            <label className="modal-label">Select Graph to Scan</label>
            <select
              className="modal-select"
              value={selectedGraphId}
              onChange={(e) => setSelectedGraphId(e.target.value)}
              disabled={isScanning}
            >
              <option value="">Choose a graph...</option>
              {graphFiles.map(file => (
                <option key={file.id} value={file.id}>{file.name}</option>
              ))}
            </select>
          </div>

          <button
            className="modal-btn modal-btn-primary"
            onClick={handleScan}
            disabled={!selectedGraphId || isScanning}
            style={{ marginBottom: '16px', width: '100%' }}
          >
            {isScanning ? 'Scanning...' : 'Scan for Missing Index Entries'}
          </button>

          {/* Results */}
          {missingEntries.length > 0 && (
            <>
              <div className="modal-info">
                <p><strong>Found {totalCount} missing index {totalCount === 1 ? 'entry' : 'entries'}</strong></p>
                <p>Select which items to add to their respective indexes.</p>
              </div>

              {/* Search */}
              <div className="modal-field">
                <input
                  type="text"
                  className="modal-input"
                  placeholder="🔍 Search missing entries..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>

              {/* Grouped list */}
              <div style={{ maxHeight: '400px', overflowY: 'auto', border: '1px solid #e0e0e0', borderRadius: '4px' }}>
                {/* Nodes */}
                {groupedEntries.nodes.length > 0 && (
                  <div className="sync-category">
                    <div 
                      className="sync-category-header"
                      onClick={() => toggleCategory('nodes')}
                      style={{
                        padding: '12px',
                        background: '#f8f9fa',
                        borderBottom: '1px solid #e0e0e0',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span>{expandedCategories.has('nodes') ? '▼' : '▶'}</span>
                        <strong>Nodes ({groupedEntries.nodes.length})</strong>
                      </div>
                      <button
                        className="modal-btn modal-btn-secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelectAll('node');
                        }}
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                      >
                        {groupedEntries.nodes.every(e => selectedIds.has(e.id)) ? 'Deselect All' : 'Select All'}
                      </button>
                    </div>
                    {expandedCategories.has('nodes') && (
                      <div>
                        {groupedEntries.nodes.map(entry => (
                          <label 
                            key={entry.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              padding: '8px 12px',
                              borderBottom: '1px solid #f0f0f0',
                              cursor: 'pointer'
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={selectedIds.has(entry.id)}
                              onChange={() => toggleSelection(entry.id)}
                              style={{ marginRight: '8px' }}
                            />
                            <span style={{ flex: 1, fontFamily: 'monospace', fontSize: '13px' }}>
                              {entry.id}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Cases */}
                {groupedEntries.cases.length > 0 && (
                  <div className="sync-category">
                    <div 
                      className="sync-category-header"
                      onClick={() => toggleCategory('cases')}
                      style={{
                        padding: '12px',
                        background: '#f8f9fa',
                        borderBottom: '1px solid #e0e0e0',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span>{expandedCategories.has('cases') ? '▼' : '▶'}</span>
                        <strong>Cases ({groupedEntries.cases.length})</strong>
                      </div>
                      <button
                        className="modal-btn modal-btn-secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelectAll('case');
                        }}
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                      >
                        {groupedEntries.cases.every(e => selectedIds.has(e.id)) ? 'Deselect All' : 'Select All'}
                      </button>
                    </div>
                    {expandedCategories.has('cases') && (
                      <div>
                        {groupedEntries.cases.map(entry => (
                          <label 
                            key={entry.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              padding: '8px 12px',
                              borderBottom: '1px solid #f0f0f0',
                              cursor: 'pointer'
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={selectedIds.has(entry.id)}
                              onChange={() => toggleSelection(entry.id)}
                              style={{ marginRight: '8px' }}
                            />
                            <span style={{ flex: 1, fontFamily: 'monospace', fontSize: '13px' }}>
                              {entry.id}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Parameters */}
                {groupedEntries.parameters.length > 0 && (
                  <div className="sync-category">
                    <div 
                      className="sync-category-header"
                      onClick={() => toggleCategory('parameters')}
                      style={{
                        padding: '12px',
                        background: '#f8f9fa',
                        borderBottom: '1px solid #e0e0e0',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span>{expandedCategories.has('parameters') ? '▼' : '▶'}</span>
                        <strong>Parameters ({groupedEntries.parameters.length})</strong>
                      </div>
                      <button
                        className="modal-btn modal-btn-secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelectAll('parameter');
                        }}
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                      >
                        {groupedEntries.parameters.every(e => selectedIds.has(e.id)) ? 'Deselect All' : 'Select All'}
                      </button>
                    </div>
                    {expandedCategories.has('parameters') && (
                      <div>
                        {groupedEntries.parameters.map(entry => (
                          <label 
                            key={entry.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              padding: '8px 12px',
                              borderBottom: '1px solid #f0f0f0',
                              cursor: 'pointer'
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={selectedIds.has(entry.id)}
                              onChange={() => toggleSelection(entry.id)}
                              style={{ marginRight: '8px' }}
                            />
                            <span style={{ flex: 1, fontFamily: 'monospace', fontSize: '13px' }}>
                              {entry.id}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Contexts */}
                {groupedEntries.contexts.length > 0 && (
                  <div className="sync-category">
                    <div 
                      className="sync-category-header"
                      onClick={() => toggleCategory('contexts')}
                      style={{
                        padding: '12px',
                        background: '#f8f9fa',
                        borderBottom: '1px solid #e0e0e0',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span>{expandedCategories.has('contexts') ? '▼' : '▶'}</span>
                        <strong>Contexts ({groupedEntries.contexts.length})</strong>
                      </div>
                      <button
                        className="modal-btn modal-btn-secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelectAll('context');
                        }}
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                      >
                        {groupedEntries.contexts.every(e => selectedIds.has(e.id)) ? 'Deselect All' : 'Select All'}
                      </button>
                    </div>
                    {expandedCategories.has('contexts') && (
                      <div>
                        {groupedEntries.contexts.map(entry => (
                          <label 
                            key={entry.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              padding: '8px 12px',
                              borderBottom: '1px solid #f0f0f0',
                              cursor: 'pointer'
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={selectedIds.has(entry.id)}
                              onChange={() => toggleSelection(entry.id)}
                              style={{ marginRight: '8px' }}
                            />
                            <span style={{ flex: 1, fontFamily: 'monospace', fontSize: '13px' }}>
                              {entry.id}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {missingEntries.length === 0 && selectedGraphId && !isScanning && (
            <div className="modal-info">
              <p>No missing index entries found. All referenced IDs are already in their indexes!</p>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            className="modal-btn modal-btn-secondary"
            onClick={onClose}
          >
            Cancel
          </button>

          {missingEntries.length > 0 && (
            <button
              className="modal-btn modal-btn-primary"
              onClick={handleCreateIndexEntries}
              disabled={selectedCount === 0}
            >
              Create {selectedCount} Index {selectedCount === 1 ? 'Entry' : 'Entries'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}


