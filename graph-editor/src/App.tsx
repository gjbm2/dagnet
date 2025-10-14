import React, { useEffect, useMemo, useState } from 'react';
import GraphCanvas from './components/GraphCanvas';
import PropertiesPanel from './components/PropertiesPanel';
import { loadFromSheet, saveToSheet } from './lib/sheetsClient';
import { decodeStateFromUrl, encodeStateToUrl } from './lib/shareUrl';
import { useGraphStore } from './lib/useGraphStore';
import { getValidator } from './lib/schema';

export default function App() {
  const { graph, setGraph } = useGraphStore();
  const [ajvValidate, setAjvValidate] = useState<any>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);


  // Load schema validator once
  useEffect(() => {
    getValidator().then(setAjvValidate).catch(e => setErrors([String(e)]));
  }, []);

  // Initial load: from ?data or from Sheet
  useEffect(() => {
    // Check if this is a data request from Apps Script
    const urlParams = new URLSearchParams(window.location.search);
    const getData = urlParams.get('getdata');
    const sessionId = urlParams.get('session');
    
    if (getData === 'true' && sessionId) {
      // This is a request from Apps Script to get the current data
      const currentData = localStorage.getItem('dagnet_graph_data_' + sessionId);
      if (currentData) {
        // Return the data as plain text
        document.body.innerHTML = currentData;
        return;
      } else {
        document.body.innerHTML = 'null';
        return;
      }
    }
    
    const decoded = decodeStateFromUrl();
    if (decoded) { 
      setGraph(decoded); 
      return; 
    }
    
    loadFromSheet().then(g => {
      if (g) {
        setGraph(g);
      } else {
        // Create a default empty graph if no data is available
        const defaultGraph = {
          nodes: [
            {
              id: "550e8400-e29b-41d4-a716-446655440001",
              slug: "start",
              label: "Start",
              absorbing: false,
              entry: { is_start: true, entry_weight: 1.0 },
              layout: { x: 100, y: 100, rank: 0 }
            }
          ],
          edges: [],
          policies: {
            default_outcome: "abandon",
            overflow_policy: "error",
            free_edge_policy: "complement"
          },
          metadata: {
            version: "1.0.0",
            created_at: new Date().toISOString(),
            author: "Graph Editor",
            description: "Default empty graph"
          }
        };
        setGraph(defaultGraph);
      }
    }).catch(e => {
      console.warn('Failed to load from sheet, using default graph:', e);
      // Create default graph on error too
      const defaultGraph = {
        nodes: [
          {
            id: "550e8400-e29b-41d4-a716-446655440001",
            slug: "start",
            label: "Start",
            absorbing: false,
            entry: { is_start: true, entry_weight: 1.0 },
            layout: { x: 100, y: 100, rank: 0 }
          }
        ],
        edges: [],
        policies: {
          default_outcome: "abandon",
          overflow_policy: "error",
          free_edge_policy: "complement"
        },
        metadata: {
          version: "1.0.0",
          created_at: new Date().toISOString(),
          author: "Graph Editor",
          description: "Default empty graph"
        }
      };
      setGraph(defaultGraph);
    });
  }, [setGraph]);

  const validateNow = useMemo(() => {
    return () => {
      if (!ajvValidate || !graph) return [];
      const ok = ajvValidate(graph);
      const errs = ok ? [] : (ajvValidate.errors || []).map((e: any) => `${e.instancePath} ${e.message}`);
      setErrors(errs);
      return errs;
    };
  }, [ajvValidate, graph]);

  const onSave = async () => {
    const errs = validateNow();
    if (errs.length) { 
      alert('Fix schema errors before save.'); 
      return; 
    }
    
    // Check if we're being used from Apps Script
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('session');
    const outputCell = urlParams.get('outputCell');
    const sheetId = urlParams.get('sheetId');
    const appsScriptUrl = urlParams.get('appsScriptUrl');
    
    if (sessionId && outputCell && sheetId && appsScriptUrl) {
      // We're being used from Apps Script - save automatically via form POST (bypasses CORS)
      try {
        const updatedJson = JSON.stringify(graph, null, 2);

        console.log('Form POST to:', appsScriptUrl);
        console.log('Data length:', updatedJson.length);

        // Build a hidden form that POSTs to Apps Script
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = appsScriptUrl; // doPost in Apps Script
        form.style.display = 'none';

        const addField = (name: string, value: string) => {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = name;
          input.value = value;
          form.appendChild(input);
        };

        addField('sessionId', sessionId);
        addField('sheetId', sheetId);
        addField('outputCell', outputCell);
        addField('graphData', updatedJson);

        document.body.appendChild(form);
        
        // Submit the form (this will POST to Apps Script and update the cell)
        form.submit();

        // Close the window after a short delay to allow the POST to complete
        setTimeout(() => window.close(), 1000);
        return;
      } catch (error) {
        alert('Save failed: ' + error);
        return;
      }
    }
    
    // Original save logic for normal usage
    try {
      await saveToSheet(graph);
      alert('Saved to Sheet.');
    } catch (error) {
      alert('Save failed: ' + error);
    }
  };

  const onShare = () => {
    const url = encodeStateToUrl(graph);
    navigator.clipboard.writeText(url);
    alert('Shareable URL copied to clipboard.');
  };

  const onDownload = () => {
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (graph?.metadata?.version || 'graph') + '.json';
    a.click();
  };

  const handleDoubleClickNode = (id: string, field: string) => {
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    // Focus the field after a short delay to ensure the properties panel has updated
    setTimeout(() => {
      const input = document.querySelector(`input[data-field="${field}"]`) as HTMLInputElement;
      if (input) {
        input.focus();
        input.select();
      }
    }, 100);
  };

  const handleDoubleClickEdge = (id: string, field: string) => {
    setSelectedEdgeId(id);
    setSelectedNodeId(null);
    // Focus the field after a short delay to ensure the properties panel has updated
    setTimeout(() => {
      const input = document.querySelector(`input[data-field="${field}"]`) as HTMLInputElement;
      if (input) {
        input.focus();
        input.select();
      }
    }, 100);
  };

  const handleSelectEdge = (id: string) => {
    setSelectedEdgeId(id);
    setSelectedNodeId(null);
  };

  return (
    <div style={{ 
      display: 'grid', 
      gridTemplateColumns: '1fr 350px', 
      height: '100vh',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    }}>
      {/* Main Graph Area */}
      <div style={{ position: 'relative' }}>
        <GraphCanvas 
          onSelectedNodeChange={setSelectedNodeId}
          onSelectedEdgeChange={setSelectedEdgeId}
          onDoubleClickNode={handleDoubleClickNode}
          onDoubleClickEdge={handleDoubleClickEdge}
          onSelectEdge={handleSelectEdge}
        />
      </div>

      {/* Properties Panel */}
        <PropertiesPanel 
          selectedNodeId={selectedNodeId} 
          onSelectedNodeChange={setSelectedNodeId}
          selectedEdgeId={selectedEdgeId}
          onSelectedEdgeChange={setSelectedEdgeId}
        />

      {/* Floating Action Bar */}
      <div style={{
        position: 'fixed',
        top: '20px',
        right: '370px',
        zIndex: 1000,
        display: 'flex',
        gap: '8px',
        background: 'rgba(255, 255, 255, 0.95)',
        padding: '8px 12px',
        borderRadius: '8px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        backdropFilter: 'blur(10px)',
      }}>
        <button
          onClick={onSave}
          style={{
            padding: '8px 16px',
            background: '#007bff',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: '500',
            transition: 'background-color 0.2s',
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = '#0056b3'}
          onMouseLeave={(e) => e.currentTarget.style.background = '#007bff'}
        >
          Save
        </button>
        <button
          onClick={onDownload}
          style={{
            padding: '8px 16px',
            background: '#28a745',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: '500',
            transition: 'background-color 0.2s',
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = '#1e7e34'}
          onMouseLeave={(e) => e.currentTarget.style.background = '#28a745'}
        >
          Download
        </button>
        <button
          onClick={onShare}
          style={{
            padding: '8px 16px',
            background: '#6c757d',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: '500',
            transition: 'background-color 0.2s',
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = '#545b62'}
          onMouseLeave={(e) => e.currentTarget.style.background = '#6c757d'}
        >
          Share
        </button>
      </div>

      {/* Schema Errors Overlay */}
      {errors.length > 0 && (
        <div style={{
          position: 'fixed',
          bottom: '20px',
          left: '20px',
          right: '370px',
          zIndex: 1000,
          background: '#f8d7da',
          border: '1px solid #f5c6cb',
          borderRadius: '8px',
          padding: '12px 16px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>
          <div style={{ 
            fontWeight: '600', 
            color: '#721c24', 
            marginBottom: '8px',
            fontSize: '14px'
          }}>
            Schema Errors:
          </div>
          <ul style={{ 
            margin: 0, 
            paddingLeft: '16px', 
            color: '#721c24',
            fontSize: '12px',
            lineHeight: '1.4'
          }}>
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}