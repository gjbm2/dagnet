import React, { useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import { useGraphStore } from '../contexts/GraphStoreContext';

export interface JsonSectionRef {
  openJsonEdit: () => void;
}

const JsonSection = forwardRef<JsonSectionRef>((props, ref) => {
  const { graph, setGraph, saveHistoryState } = useGraphStore();
  const [showJsonEdit, setShowJsonEdit] = useState(false);
  const [jsonEditContent, setJsonEditContent] = useState('');
  const [jsonEditError, setJsonEditError] = useState<string | null>(null);

  const openJsonEdit = useCallback(() => {
    setJsonEditContent(JSON.stringify(graph, null, 2));
    setJsonEditError(null);
    setShowJsonEdit(true);
  }, [graph]);


  const closeJsonEdit = useCallback(() => {
    setShowJsonEdit(false);
    setJsonEditContent('');
    setJsonEditError(null);
  }, []);

  const applyJsonEdit = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonEditContent);
      
      // Basic validation - check required fields
      if (!parsed.nodes || !Array.isArray(parsed.nodes)) {
        throw new Error('Missing or invalid "nodes" array');
      }
      if (!parsed.edges || !Array.isArray(parsed.edges)) {
        throw new Error('Missing or invalid "edges" array');
      }
      if (!parsed.policies || typeof parsed.policies !== 'object') {
        throw new Error('Missing or invalid "policies" object');
      }
      if (!parsed.metadata || typeof parsed.metadata !== 'object') {
        throw new Error('Missing or invalid "metadata" object');
      }
      
      // Validate nodes have required fields
      for (let i = 0; i < parsed.nodes.length; i++) {
        const node = parsed.nodes[i];
        if (!node.id || !node.slug) {
          throw new Error(`Node ${i} missing required "id" or "slug" field`);
        }
      }
      
      // Validate edges have required fields
      for (let i = 0; i < parsed.edges.length; i++) {
        const edge = parsed.edges[i];
        if (!edge.id || !edge.from || !edge.to) {
          throw new Error(`Edge ${i} missing required "id", "from", or "to" field`);
        }
      }
      
      setGraph(parsed);
      saveHistoryState('JSON edit');
      closeJsonEdit();
    } catch (error) {
      setJsonEditError(error instanceof Error ? error.message : 'Invalid JSON');
    }
  }, [jsonEditContent, setGraph, closeJsonEdit, saveHistoryState]);

  useImperativeHandle(ref, () => ({
    openJsonEdit
  }), [openJsonEdit]);

  return (
    <>
      <div style={{ padding: '12px' }}>
        <pre style={{ 
          background: '#f8f9fa', 
          padding: '12px', 
          borderRadius: '4px', 
          fontSize: '11px',
          overflow: 'auto',
          maxHeight: '400px',
          border: '1px solid #e9ecef',
          fontFamily: 'monospace',
          lineHeight: '1.5',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          margin: 0
        }}>
          {JSON.stringify(graph, null, 2)}
        </pre>
      </div>

      {/* JSON Edit Modal */}
      {showJsonEdit && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            background: 'white',
            borderRadius: '8px',
            padding: '20px',
            width: '80%',
            maxWidth: '800px',
            maxHeight: '80vh',
            display: 'flex',
            flexDirection: 'column'
          }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '16px'
            }}>
              <h3 style={{ margin: 0, fontSize: '18px' }}>Edit Graph JSON</h3>
              <button
                onClick={closeJsonEdit}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '20px',
                  cursor: 'pointer',
                  color: '#666'
                }}
              >
                ×
              </button>
            </div>
            
            {jsonEditError && (
              <div style={{
                background: '#f8d7da',
                color: '#721c24',
                padding: '8px 12px',
                borderRadius: '4px',
                marginBottom: '12px',
                fontSize: '12px'
              }}>
                Error: {jsonEditError}
              </div>
            )}
            
            <textarea
              value={jsonEditContent}
              onChange={(e) => setJsonEditContent(e.target.value)}
              style={{
                flex: 1,
                fontFamily: 'monospace',
                fontSize: '12px',
                padding: '12px',
                border: '1px solid #ddd',
                borderRadius: '4px',
                resize: 'none',
                minHeight: '400px'
              }}
              placeholder="Paste your JSON here..."
            />
            
            <div style={{
              display: 'flex',
              gap: '8px',
              marginTop: '16px',
              justifyContent: 'flex-end'
            }}>
              <button
                onClick={closeJsonEdit}
                style={{
                  background: '#6c757d',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '8px 16px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={applyJsonEdit}
                style={{
                  background: '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '8px 16px',
                  cursor: 'pointer'
                }}
              >
                Apply Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
});

JsonSection.displayName = 'JsonSection';

export default JsonSection;
