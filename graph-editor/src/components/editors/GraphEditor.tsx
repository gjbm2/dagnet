import React, { useState, useEffect } from 'react';
import { EditorProps, GraphData } from '../../types';
import { useFileState } from '../../contexts/TabContext';
import { GraphStoreProvider, useGraphStore } from '../../contexts/GraphStoreContext';
import GraphCanvas from '../GraphCanvas';
import PropertiesPanel from '../PropertiesPanel';
import WhatIfAnalysisControl from '../WhatIfAnalysisControl';
import WhatIfAnalysisHeader from '../WhatIfAnalysisHeader';
import JsonSection from '../JsonSection';
import JsonSectionHeader from '../JsonSectionHeader';
import CollapsibleSection from '../CollapsibleSection';

/**
 * Graph Editor Inner Component
 * Assumes it's wrapped in GraphStoreProvider
 */
function GraphEditorInner({ fileId, readonly = false }: EditorProps<GraphData>) {
  const { data, isDirty, updateData } = useFileState<GraphData>(fileId);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [whatIfOpen, setWhatIfOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const [jsonOpen, setJsonOpen] = useState(false);
  const store = useGraphStore();
  const { setGraph, graph, undo, redo, canUndo, canRedo } = store;

  console.log('GraphEditor render:', { 
    fileId, 
    hasData: !!data, 
    hasNodes: !!data?.nodes,
    nodeCount: data?.nodes?.length,
    isDirty,
    graphInStore: !!graph,
    graphNodeCount: graph?.nodes?.length
  });

  // Bidirectional sync with loop prevention
  const syncingRef = React.useRef(false);
  
  // Sync file data TO graph store when file changes (from JSON editor, etc.)
  useEffect(() => {
    if (!data || !data.nodes || syncingRef.current) return;
    
    syncingRef.current = true;
    console.log('GraphEditor: Syncing file → store');
    setGraph(data);
    setTimeout(() => { syncingRef.current = false; }, 100);
  }, [data, setGraph]);

  // Sync graph store changes BACK to file (from interactive edits)
  useEffect(() => {
    if (!graph || !graph.nodes) {
      console.log('GraphEditor: Store→file sync skipped (no graph or nodes)');
      return;
    }
    
    if (syncingRef.current) {
      console.log('GraphEditor: Store→file sync skipped (syncingRef is true)');
      return;
    }
    
    const graphStr = JSON.stringify(graph);
    const dataStr = data ? JSON.stringify(data) : '';
    
    if (graphStr !== dataStr) {
      syncingRef.current = true;
      console.log('GraphEditor: Syncing store → file, nodeCount:', graph.nodes.length);
      updateData(graph);
      setTimeout(() => { 
        syncingRef.current = false;
        console.log('GraphEditor: syncingRef reset');
      }, 100);
    } else {
      console.log('GraphEditor: Store→file sync skipped (data matches)');
    }
  }, [graph, data, updateData]);

  // Keyboard shortcuts for undo/redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if this graph editor is the active tab
      // and user isn't typing in an input field
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modifier = isMac ? e.metaKey : e.ctrlKey;

      // Undo: Cmd/Ctrl+Z
      if (modifier && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (canUndo) {
          console.log('GraphEditor: Undo triggered, canUndo:', canUndo, 'historyIndex:', store.getState().historyIndex);
          // Reset sync flag before undo so the store→file sync can happen
          syncingRef.current = false;
          undo();
        }
      }

      // Redo: Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y
      if ((modifier && e.shiftKey && e.key === 'z') || (modifier && e.key === 'y')) {
        e.preventDefault();
        if (canRedo) {
          console.log('GraphEditor: Redo triggered, canRedo:', canRedo, 'historyIndex:', store.getState().historyIndex);
          // Reset sync flag before redo so the store→file sync can happen
          syncingRef.current = false;
          redo();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo, canUndo, canRedo, store]);

  if (!data) {
    console.log('GraphEditor: No data yet, showing loading...');
    return (
      <div className="editor-loading" style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        height: '100%',
        fontSize: '14px',
        color: '#666'
      }}>
        Loading graph... (fileId: {fileId})
      </div>
    );
  }

  if (!data.nodes) {
    return (
      <div className="editor-error" style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        height: '100%',
        fontSize: '14px',
        color: '#d32f2f'
      }}>
        Error: Invalid graph data
      </div>
    );
  }

  console.log('GraphEditor: About to render GraphCanvas with', data.nodes?.length, 'nodes');
  console.log('GraphEditor: Rendering with props:', {
    sidebarOpen,
    selectedNodeId,
    selectedEdgeId
  });

  return (
    <div style={{ 
      display: 'grid', 
      gridTemplateColumns: sidebarOpen ? '1fr 350px' : '1fr', 
      height: '100%',
      transition: 'grid-template-columns 0.3s ease-in-out',
      overflow: 'hidden',
      background: '#f0f0f0' // Debug: add background to see if container renders
    }}>
      {/* Main Graph Canvas */}
      <div style={{ 
        position: 'relative',
        height: '100%',
        overflow: 'hidden',
        background: '#e0e0e0' // Debug: add background to see canvas container
      }}>
        {console.log('GraphEditor: Rendering GraphCanvas component now...')}
        <GraphCanvas
          onSelectedNodeChange={setSelectedNodeId}
          onSelectedEdgeChange={setSelectedEdgeId}
          useUniformScaling={false}
          massGenerosity={0.5}
          autoReroute={true}
        />
      </div>

      {/* Right Sidebar */}
      {sidebarOpen && (
        <div style={{ 
          display: 'flex', 
          flexDirection: 'column', 
          height: '100%',
          background: '#fff',
          borderLeft: '1px solid #e9ecef',
          position: 'relative',
          overflow: 'hidden'
        }}>
          {/* Hide sidebar button */}
          <button
            onClick={() => setSidebarOpen(false)}
            style={{
              position: 'absolute',
              left: '-12px',
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 1000,
              width: '24px',
              height: '24px',
              background: '#fff',
              border: '1px solid #e9ecef',
              borderRadius: '50%',
              cursor: 'pointer',
              fontSize: '12px',
              color: '#666',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
            }}
            title="Hide Sidebar (Ctrl/Cmd + B)"
          >
            ◀
          </button>

          <div style={{ 
            flex: 1, 
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column'
          }}>
            {/* What-If Analysis */}
            <CollapsibleSection 
              title={<WhatIfAnalysisHeader />} 
              isOpen={whatIfOpen}
              onToggle={() => setWhatIfOpen(!whatIfOpen)}
            >
              <div style={{ padding: '16px' }}>
                <WhatIfAnalysisControl />
              </div>
            </CollapsibleSection>

            {/* Properties Panel */}
            <CollapsibleSection 
              title={
                selectedNodeId 
                  ? (() => {
                      const selectedNodes = graph?.nodes?.filter((n: any) => n.selected) || [];
                      return selectedNodes.length > 1 
                        ? `${selectedNodes.length} nodes selected`
                        : 'Node Properties';
                    })()
                  : selectedEdgeId 
                    ? 'Edge Properties'
                    : 'Graph Properties'
              } 
              isOpen={propertiesOpen}
              onToggle={() => setPropertiesOpen(!propertiesOpen)}
            >
              <PropertiesPanel 
                selectedNodeId={selectedNodeId} 
                onSelectedNodeChange={setSelectedNodeId}
                selectedEdgeId={selectedEdgeId}
                onSelectedEdgeChange={setSelectedEdgeId}
              />
            </CollapsibleSection>

            {/* JSON Section */}
            <CollapsibleSection 
              title={<JsonSectionHeader />} 
              isOpen={jsonOpen}
              onToggle={() => setJsonOpen(!jsonOpen)}
            >
              <JsonSection />
            </CollapsibleSection>
          </div>
        </div>
      )}

      {/* Show sidebar button (when hidden) */}
      {!sidebarOpen && (
        <button
          onClick={() => setSidebarOpen(true)}
          style={{
            position: 'absolute',
            right: '12px',
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 1000,
            width: '24px',
            height: '24px',
            background: '#fff',
            border: '1px solid #e9ecef',
            borderRadius: '50%',
            cursor: 'pointer',
            fontSize: '12px',
            color: '#666',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          }}
          title="Show Sidebar (Ctrl/Cmd + B)"
        >
          ▶
        </button>
      )}
    </div>
  );
}

/**
 * Graph Editor
 * Wraps GraphEditorInner with isolated store provider
 */
export function GraphEditor(props: EditorProps<GraphData>) {
  return (
    <GraphStoreProvider fileId={props.fileId}>
      <GraphEditorInner {...props} />
    </GraphStoreProvider>
  );
}
