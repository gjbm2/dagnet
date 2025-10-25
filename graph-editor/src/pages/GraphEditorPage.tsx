import React, { useEffect, useMemo, useState, useRef } from 'react';
import GraphCanvas from '../components/GraphCanvas';
import PropertiesPanel from '../components/PropertiesPanel';
import WhatIfAnalysisControl from '../components/WhatIfAnalysisControl';
import WhatIfAnalysisHeader from '../components/WhatIfAnalysisHeader';
import JsonSection from '../components/JsonSection';
import JsonSectionHeader from '../components/JsonSectionHeader';
import CollapsibleSection from '../components/CollapsibleSection';
import LoadGraphModal from '../components/LoadGraphModal';
import * as Menubar from '@radix-ui/react-menubar';
import { loadFromSheet, saveToSheet } from '../lib/sheetsClient';
import { decodeStateFromUrl, encodeStateToUrl } from '../lib/shareUrl';
import { useGraphStore } from '../lib/useGraphStore';
import { getValidator } from '../lib/schema';
import '../custom-reactflow.css';
import { useNavigate } from 'react-router-dom';

export default function GraphEditorPage() {
  const navigate = useNavigate();
  const { graph, setGraph, canUndo, canRedo, undo, redo, saveHistoryState } = useGraphStore();
  const [ajvValidate, setAjvValidate] = useState<any>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [useUniformScaling, setUseUniformScaling] = useState(false);
  const [massGenerosity, setMassGenerosity] = useState(0.5);
  const [autoReroute, setAutoReroute] = useState(true);
  const [showLoadModal, setShowLoadModal] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveGraphName, setSaveGraphName] = useState('');
  const [saveCommitMessage, setSaveCommitMessage] = useState('');
  const [graphKey, setGraphKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  
  const [whatIfOpen, setWhatIfOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const [jsonOpen, setJsonOpen] = useState(false);
  const lastLoadedGraphRef = useRef<string | null>(null);
  const addNodeRef = useRef<(() => void) | null>(null);
  const deleteSelectedRef = useRef<(() => void) | null>(null);
  const autoLayoutRef = useRef<((direction: 'LR' | 'RL' | 'TB' | 'BT') => void) | null>(null);
  const forceRerouteRef = useRef<(() => void) | null>(null);

  // Load graph from repository
  const handleLoadGraph = async (graphName: string) => {
    try {
      const { graphGitService } = await import('../services/graphGitService');
      const result = await graphGitService.getGraph(graphName, 'main');
      
      if (result.success && result.data) {
        lastLoadedGraphRef.current = JSON.stringify(result.data.content);
        
        const graphData = {
          ...result.data.content,
          metadata: {
            ...result.data.content.metadata,
            name: graphName,
            source: 'git',
            branch: 'main'
          }
        };
        setGraphKey(prev => prev + 1);
        setGraph(graphData);
        saveHistoryState('Load graph from repository');
        
        setSaveGraphName(graphName);
        setSaveCommitMessage(`Update ${graphName}`);
        
        setShowLoadModal(false);
      } else {
        console.error('Failed to load graph:', result.error);
      }
    } catch (error) {
      console.error('Error loading graph:', error);
    }
  };

  // Save graph to repository
  const handleSaveToRepository = async () => {
    if (!graph) {
      console.error('No graph to save');
      return;
    }

    if (!saveGraphName.trim()) {
      console.error('Please enter a graph name');
      return;
    }

    if (!saveCommitMessage.trim()) {
      console.error('Please enter a commit message');
      return;
    }

    try {
      const { graphGitService } = await import('../services/graphGitService');
      const result = await graphGitService.saveGraph(
        saveGraphName,
        graph,
        saveCommitMessage,
        'main'
      );
      
      if (result.success) {
        console.log(`✅ Successfully saved graph "${saveGraphName}" to repository`);
        setShowSaveDialog(false);
      } else {
        console.error('Failed to save graph:', result.error);
      }
    } catch (error) {
      console.error('Error saving graph:', error);
    }
  };

  // Load schema validator once
  useEffect(() => {
    getValidator().then(setAjvValidate).catch(e => setErrors([String(e)]));
  }, []);

  // Initial load: from ?data, ?graph, or from Sheet
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const getData = urlParams.get('getdata');
    const sessionId = urlParams.get('session');
    const graphParam = urlParams.get('graph');
    
    if (getData === 'true' && sessionId) {
      const currentData = localStorage.getItem('dagnet_graph_data_' + sessionId);
      if (currentData) {
        document.body.innerHTML = currentData;
        return;
      } else {
        document.body.innerHTML = 'null';
        return;
      }
    }
    
    if (graphParam) {
      loadGraphFromRepository(graphParam).then(g => {
        if (g) {
          setGraph(g);
          lastLoadedGraphRef.current = JSON.stringify(g);
          setSaveGraphName(graphParam);
          setSaveCommitMessage(`Update ${graphParam}`);
        } else {
          console.error('Failed to load graph from repository:', graphParam);
          loadDefaultGraph();
        }
      });
      return;
    }
    
    const decoded = decodeStateFromUrl();
    if (decoded) { 
      setGraph(decoded); 
      lastLoadedGraphRef.current = JSON.stringify(decoded);
      if (decoded.metadata?.name) {
        setSaveGraphName(decoded.metadata.name);
        setSaveCommitMessage(`Update ${decoded.metadata.name}`);
      }
      return; 
    }
    
    loadFromSheet().then(g => {
      if (g) {
        setGraph(g);
        lastLoadedGraphRef.current = JSON.stringify(g);
        if (g.metadata?.name) {
          setSaveGraphName(g.metadata.name);
          setSaveCommitMessage(`Update ${g.metadata.name}`);
        }
      } else {
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
          default_outcome: "abandon" as const,
          overflow_policy: "error" as const,
          free_edge_policy: "complement" as const
        },
        metadata: {
          version: "1.0.0",
          created_at: new Date().toISOString(),
          author: "Graph Editor",
          description: "Default empty graph"
        }
      };
      setGraph(defaultGraph);
      lastLoadedGraphRef.current = JSON.stringify(defaultGraph);
      }
    }).catch(e => {
      console.warn('Failed to load from sheet, using default graph:', e);
      loadDefaultGraph();
    });
  }, [setGraph]);

  const revertToLastLoaded = () => {
    if (lastLoadedGraphRef.current) {
      try {
        saveHistoryState('Revert to last loaded');
        
        const graphData = JSON.parse(lastLoadedGraphRef.current);
        setGraphKey(prev => prev + 1);
        setGraph(graphData);
        console.log('Reverted to last loaded graph');
      } catch (error) {
        console.error('Failed to parse last loaded graph:', error);
      }
    } else {
      console.log('No last loaded graph to revert to');
    }
  };

  const loadGraphFromFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const content = e.target?.result as string;
            const graphData = JSON.parse(content);
            
            lastLoadedGraphRef.current = content;
            
            setGraph(graphData);
            console.log('Graph loaded from file:', file.name);
          } catch (error) {
            console.error('Failed to parse graph file:', error);
            alert('Failed to load graph file. Please ensure it\'s a valid JSON file.');
          }
        };
        reader.readAsText(file);
      }
    };
    input.click();
  };

  const loadDefaultGraph = () => {
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
        default_outcome: "abandon" as const,
        overflow_policy: "error" as const,
        free_edge_policy: "complement" as const
      },
      metadata: {
        version: "1.0.0",
        created_at: new Date().toISOString(),
        author: "Graph Editor",
        description: "Default empty graph"
      }
    };
    setGraph(defaultGraph);
    lastLoadedGraphRef.current = JSON.stringify(defaultGraph);
    console.log('Loading default graph, saving initial state');
    saveHistoryState('Initial empty graph');
  };

  const loadGraphFromRepository = async (graphName: string) => {
    try {
      console.log('Loading graph from repository:', graphName);
      
      const { graphGitService } = await import('../services/graphGitService');
      
      const result = await graphGitService.getGraph(graphName, 'main');
      
      console.log('Graph loading result:', result);
      
      if (result.success && result.data) {
        console.log('Successfully loaded graph:', result.data);
        return result.data.content;
      } else {
        console.error('Failed to load graph:', result.error || result.message);
        return null;
      }
    } catch (error) {
      console.error('Error loading graph from repository:', error);
      return null;
    }
  };

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
    
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('session');
    const outputCell = urlParams.get('outputCell');
    const sheetId = urlParams.get('sheetId');
    const appsScriptUrl = urlParams.get('appsScriptUrl');
    
    if (sessionId && outputCell && sheetId && appsScriptUrl) {
      if (!graph) {
        console.error('Cannot save: graph is null');
        return;
      }
      try {
        const reorderedGraph = {
          metadata: {
            description: graph.metadata?.description || 'Graph created in Dagnet',
            ...graph.metadata
          },
          nodes: graph.nodes,
          edges: graph.edges,
          policies: graph.policies
        };
        
        const updatedJson = JSON.stringify(reorderedGraph);

        console.log('Form POST to:', appsScriptUrl);
        console.log('Data length:', updatedJson.length);

        const form = document.createElement('form');
        form.method = 'POST';
        form.action = appsScriptUrl;
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
        
        form.submit();

        setTimeout(() => window.close(), 1000);
        return;
      } catch (error) {
        alert('Save failed: ' + error);
        return;
      }
    }
    
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'b') {
        event.preventDefault();
        setSidebarOpen(prev => !prev);
      }
      
      if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey) {
        event.preventDefault();
        if (canUndo) {
          undo();
        }
      }
      
      if (((event.ctrlKey || event.metaKey) && event.key === 'y') || 
          ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'Z')) {
        event.preventDefault();
        if (canRedo) {
          redo();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canUndo, canRedo, undo, redo]);

  return (
    <div style={{ 
      display: 'grid', 
      gridTemplateColumns: sidebarOpen ? '1fr 350px' : '1fr', 
      height: '100vh',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      transition: 'grid-template-columns 0.3s ease-in-out',
      overflow: 'hidden'
    }}>
      {/* Main Graph Area */}
      <div style={{ 
        position: 'relative', 
        marginTop: '40px',
        height: 'calc(100vh - 40px)',
        overflow: 'hidden'
      }}>
        
        <GraphCanvas 
          key={graphKey}
          onSelectedNodeChange={setSelectedNodeId}
          onSelectedEdgeChange={setSelectedEdgeId}
          onDoubleClickNode={handleDoubleClickNode}
          onDoubleClickEdge={handleDoubleClickEdge}
          onSelectEdge={handleSelectEdge}
          useUniformScaling={useUniformScaling}
          massGenerosity={massGenerosity}
          autoReroute={autoReroute}
          onAddNodeRef={addNodeRef}
          onDeleteSelectedRef={deleteSelectedRef}
          onAutoLayoutRef={autoLayoutRef}
          onForceRerouteRef={forceRerouteRef}
        />
      </div>

      {/* Right Sidebar */}
      {sidebarOpen && (
      <div style={{ 
        display: 'flex', 
        flexDirection: 'column', 
        height: 'calc(100vh - 40px)',
        background: '#fff',
        borderLeft: '1px solid #e9ecef',
        marginTop: '40px',
        animation: 'slideInFromRight 0.3s ease-out',
        position: 'relative',
        overflow: 'hidden'
      }}>
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
              transition: 'all 0.2s ease'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#f8f9fa';
              e.currentTarget.style.borderColor = '#007bff';
              e.currentTarget.style.color = '#007bff';
              e.currentTarget.style.transform = 'translateY(-50%) scale(1.1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#fff';
              e.currentTarget.style.borderColor = '#e9ecef';
              e.currentTarget.style.color = '#666';
              e.currentTarget.style.transform = 'translateY(-50%) scale(1)';
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
          <CollapsibleSection 
            title={<WhatIfAnalysisHeader />} 
            isOpen={whatIfOpen}
            onToggle={() => setWhatIfOpen(!whatIfOpen)}
          >
            <div style={{ padding: '16px' }}>
              <WhatIfAnalysisControl />
            </div>
          </CollapsibleSection>

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

      {!sidebarOpen && (
        <button
          onClick={() => setSidebarOpen(true)}
          style={{
        position: 'fixed',
            right: '10px',
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
            transition: 'all 0.2s ease'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#f8f9fa';
            e.currentTarget.style.borderColor = '#007bff';
            e.currentTarget.style.color = '#007bff';
            e.currentTarget.style.transform = 'translateY(-50%) scale(1.1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#fff';
            e.currentTarget.style.borderColor = '#e9ecef';
            e.currentTarget.style.color = '#666';
            e.currentTarget.style.transform = 'translateY(-50%) scale(1)';
          }}
          title="Show Sidebar (Ctrl/Cmd + B)"
        >
          ▶
        </button>
      )}

      {/* Menu Bar */}
      <Menubar.Root style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1000,
        display: 'flex',
        background: '#f8f9fa',
        borderBottom: '1px solid #dee2e6',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
        alignItems: 'stretch',
        height: '40px',
      }}>
        
        {/* Graph Menu */}
        <Menubar.Menu>
          <Menubar.Trigger
            style={{
                padding: '0 16px',
                background: 'transparent',
                color: '#333',
                border: 'none',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: '500',
                transition: 'background-color 0.2s',
                display: 'flex',
                alignItems: 'center',
                height: '100%',
                borderRight: '1px solid #dee2e6'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#e9ecef';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              Graph
          </Menubar.Trigger>
          
          <Menubar.Portal>
            <Menubar.Content
            style={{
              background: 'white',
                border: '1px solid #ddd',
              borderRadius: '4px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                minWidth: '160px',
                padding: '4px'
              }}
                    sideOffset={4}
            >
              <Menubar.Item
                onClick={() => {
                  console.log('New graph clicked');
                  loadDefaultGraph();
                }}
                style={{
                  padding: '8px 12px',
              cursor: 'pointer',
                  fontSize: '13px',
                  color: '#333',
                  borderRadius: '2px',
                  outline: 'none'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
              >
                🆕 New
              </Menubar.Item>
              
              <Menubar.Separator style={{
                height: '1px',
                background: '#e9ecef',
                margin: '4px 0'
              }} />
              
              
              <Menubar.Item
                onClick={() => {
                  console.log('Open from repository clicked');
                  setShowLoadModal(true);
                }}
            style={{
                  padding: '8px 12px',
              cursor: 'pointer',
                  fontSize: '13px',
                  color: '#333',
                  borderRadius: '2px',
                  outline: 'none'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
              >
                📁 Open from repository...
              </Menubar.Item>
              
              <Menubar.Item
                onClick={() => {
                  console.log('Open from file clicked');
                  loadGraphFromFile();
                }}
          style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#333',
                  borderRadius: '2px',
                  outline: 'none'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
              >
                📄 Open from file...
              </Menubar.Item>
              
              <Menubar.Item
                onClick={() => {
                  console.log('Revert clicked');
                  revertToLastLoaded();
                }}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#333',
                  borderRadius: '2px',
                  outline: 'none'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
              >
                🔄 Revert
              </Menubar.Item>
              
              <Menubar.Separator style={{
                height: '1px',
                background: '#e9ecef',
                margin: '4px 0'
              }} />
              
              <Menubar.Item
                onClick={() => {
                  console.log('Save to calling app clicked');
                  onSave();
                }}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#333',
                  borderRadius: '2px',
                  outline: 'none'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
              >
                📤 Save to calling app
              </Menubar.Item>
              
              <Menubar.Item
                onClick={() => {
                  console.log('Save to repository clicked');
                  setShowSaveDialog(true);
                }}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#333',
                  borderRadius: '2px',
                  outline: 'none'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
              >
                🗂️ Save to repository...
              </Menubar.Item>
              
              <Menubar.Item
                onClick={() => {
                  console.log('Save to file clicked');
                  onDownload();
                }}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#333',
                  borderRadius: '2px',
                  outline: 'none'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
              >
                💾 Save to file...
              </Menubar.Item>
              
              <Menubar.Item
                onClick={() => {
                  console.log('Save as shareable URL clicked');
                  onShare();
                }}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#333',
                  borderRadius: '2px',
                  outline: 'none'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
              >
                🔗 Save as shareable URL
              </Menubar.Item>

              <Menubar.Separator style={{
                height: '1px',
                background: '#e9ecef',
                margin: '4px 0'
              }} />

            </Menubar.Content>
          </Menubar.Portal>
        </Menubar.Menu>
        
        {/* Registry Menu */}
        <Menubar.Menu>
          <Menubar.Trigger
            style={{
              padding: '0 16px',
              background: 'transparent',
              color: '#333',
              border: 'none',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: '500',
              transition: 'background-color 0.2s',
              display: 'flex',
              alignItems: 'center',
              height: '100%',
              borderRight: '1px solid #dee2e6'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#e9ecef';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            Registry
          </Menubar.Trigger>
          
          <Menubar.Portal>
            <Menubar.Content
              style={{
                background: 'white',
                border: '1px solid #dee2e6',
                borderRadius: '6px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                minWidth: '200px',
                padding: '4px'
              }}
            >
              <Menubar.Item
                onClick={() => navigate('/params')}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#333',
                  borderRadius: '2px',
                  outline: 'none'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
              >
                📝 Open registry...
              </Menubar.Item>
            </Menubar.Content>
          </Menubar.Portal>
        </Menubar.Menu>
        
        {/* Edit Menu */}
        <Menubar.Menu>
          <Menubar.Trigger
            style={{
                padding: '0 16px',
                background: 'transparent',
                color: '#333',
            border: 'none',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: '500',
            transition: 'background-color 0.2s',
                display: 'flex',
                alignItems: 'center',
                height: '100%',
                borderRight: '1px solid #dee2e6'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#e9ecef';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              Edit
          </Menubar.Trigger>
          
          <Menubar.Portal>
            <Menubar.Content
          style={{
              background: 'white',
              border: '1px solid #dee2e6',
              borderRadius: '6px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              minWidth: '160px',
              padding: '4px'
            }}
                    sideOffset={4}
            >
              <Menubar.Item
                onClick={() => {
                  if (canUndo) {
                    undo();
                  }
                }}
                style={{
                  padding: '8px 12px',
                  cursor: canUndo ? 'pointer' : 'not-allowed',
                  fontSize: '13px',
                  color: canUndo ? '#333' : '#999',
                  borderRadius: '2px',
                  outline: 'none',
                  opacity: canUndo ? 1 : 0.5
                }}
                onMouseEnter={(e) => {
                  if (canUndo) {
                    e.currentTarget.style.background = '#f8f9fa';
                  }
                }}
                onMouseLeave={(e) => {
                  if (canUndo) {
                    e.currentTarget.style.background = 'white';
                  }
                }}
              >
                ↶ Undo {canUndo ? '(Ctrl+Z)' : ''}
              </Menubar.Item>
              
              <Menubar.Item
                onClick={() => {
                  if (canRedo) {
                    redo();
                  }
                }}
                style={{
                  padding: '8px 12px',
                  cursor: canRedo ? 'pointer' : 'not-allowed',
                  fontSize: '13px',
                  color: canRedo ? '#333' : '#999',
                  borderRadius: '2px',
                  outline: 'none',
                  opacity: canRedo ? 1 : 0.5
                }}
                onMouseEnter={(e) => {
                  if (canRedo) {
                    e.currentTarget.style.background = '#f8f9fa';
                  }
                }}
                onMouseLeave={(e) => {
                  if (canRedo) {
                    e.currentTarget.style.background = 'white';
                  }
                }}
              >
                ↷ Redo {canRedo ? '(Ctrl+Y)' : ''}
              </Menubar.Item>
            </Menubar.Content>
          </Menubar.Portal>
        </Menubar.Menu>
        
        {/* View Menu */}
        <Menubar.Menu>
          <Menubar.Trigger
          style={{
                padding: '0 16px',
                background: 'transparent',
                color: '#333',
            border: 'none',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: '500',
            transition: 'background-color 0.2s',
                display: 'flex',
                alignItems: 'center',
                height: '100%',
                borderRight: '1px solid #dee2e6'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#e9ecef';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              View
          </Menubar.Trigger>
          
          <Menubar.Portal>
            <Menubar.Content
          style={{
                background: 'white',
                border: '1px solid #ddd',
            borderRadius: '4px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                minWidth: '200px',
                padding: '4px'
              }}
                    sideOffset={4}
            >
              <Menubar.Sub>
                <Menubar.SubTrigger
                  style={{
                    padding: '8px 12px',
            cursor: 'pointer',
                    fontSize: '13px',
                    color: '#333',
                    borderRadius: '2px',
                    outline: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
                >
                  📏 Edge Scaling
                  <span style={{ fontSize: '10px' }}>▶</span>
                </Menubar.SubTrigger>
                
                <Menubar.Portal>
                  <Menubar.SubContent
          style={{
                      background: 'white',
                      border: '1px solid #ddd',
            borderRadius: '4px',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                      minWidth: '160px',
                      padding: '4px'
                    }}
                    sideOffset={4}
                  >
                    <div style={{
                      padding: '8px 12px',
                      fontSize: '13px',
                      color: '#333',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      cursor: 'pointer'
                    }}
                    onClick={() => setUseUniformScaling(!useUniformScaling)}
                    >
                      <input 
                        type="checkbox" 
                        checked={useUniformScaling} 
                        onChange={(e) => setUseUniformScaling(e.target.checked)}
                        style={{ cursor: 'pointer' }}
                      />
                      <span>Uniform</span>
                    </div>
                    
                    <div style={{
                      borderTop: '1px solid #eee',
                      margin: '4px 0'
                    }} />
                    
                    <div style={{
                      padding: '8px 12px',
                      fontSize: '13px',
                      color: '#333'
                    }}>
                      <div style={{ 
                        marginBottom: '6px',
                        fontSize: '12px',
                        color: '#666',
                        display: 'flex',
                        justifyContent: 'space-between'
                      }}>
                        <span>Global</span>
                        <span>Local</span>
                      </div>
                      <input 
                        type="range" 
                        min="0" 
                        max="1" 
                        step="0.1"
                        value={massGenerosity}
                        onChange={(e) => setMassGenerosity(parseFloat(e.target.value))}
                        disabled={useUniformScaling}
                        style={{ 
                          width: '100%',
                          cursor: useUniformScaling ? 'not-allowed' : 'pointer',
                          opacity: useUniformScaling ? 0.5 : 1
                        }}
                      />
                      <div style={{
                        fontSize: '11px',
                        color: '#999',
                        textAlign: 'center',
                        marginTop: '4px'
                      }}>
                        {(massGenerosity * 100).toFixed(0)}%
                      </div>
                    </div>
                  </Menubar.SubContent>
                </Menubar.Portal>
              </Menubar.Sub>
              
              <Menubar.Separator style={{
                height: '1px',
                background: '#e9ecef',
                margin: '4px 0'
              }} />
              
              <Menubar.Item
                onClick={() => {
                  console.log('Re-route clicked');
                  if (forceRerouteRef.current) {
                    forceRerouteRef.current();
                  }
                }}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#333',
                  borderRadius: '2px',
                  outline: 'none'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
              >
                🔄 Re-route
              </Menubar.Item>
              
              <Menubar.Item
                onClick={() => setAutoReroute(!autoReroute)}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#333',
                  borderRadius: '2px',
                  outline: 'none',
                  background: autoReroute ? '#e3f2fd' : 'transparent'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                onMouseLeave={(e) => e.currentTarget.style.background = autoReroute ? '#e3f2fd' : 'white'}
              >
                {autoReroute ? '✓' : ''} Auto Re-route
              </Menubar.Item>
              
              <Menubar.Separator style={{
                height: '1px',
                background: '#e9ecef',
                margin: '4px 0'
              }} />
              
              <Menubar.Sub>
                <Menubar.SubTrigger
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    fontSize: '13px',
                    color: '#333',
                    borderRadius: '2px',
                    outline: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
                >
                  📐 Auto Layout
                  <span style={{ fontSize: '10px' }}>▶</span>
                </Menubar.SubTrigger>
                
                <Menubar.Portal>
                  <Menubar.SubContent
                    style={{
                      background: 'white',
                      border: '1px solid #ddd',
                      borderRadius: '4px',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                      minWidth: '160px',
                      padding: '4px'
                    }}
                    sideOffset={4}
                  >
                    <Menubar.Item
                      onClick={() => {
                        console.log('Left-to-right layout clicked');
                        if (autoLayoutRef.current) {
                          autoLayoutRef.current('LR');
                        }
                      }}
                      style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        color: '#333',
                        borderRadius: '2px',
                        outline: 'none'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
                    >
                      ➡️ Left-to-right
                    </Menubar.Item>
                    
                    <Menubar.Item
                      onClick={() => {
                        console.log('Right-to-left layout clicked');
                        if (autoLayoutRef.current) {
                          autoLayoutRef.current('RL');
                        }
                      }}
                      style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        color: '#333',
                        borderRadius: '2px',
                        outline: 'none'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
                    >
                      ⬅️ Right-to-left
                    </Menubar.Item>
                    
                    <Menubar.Item
                      onClick={() => {
                        console.log('Top-to-bottom layout clicked');
                        if (autoLayoutRef.current) {
                          autoLayoutRef.current('TB');
                        }
                      }}
                      style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        color: '#333',
                        borderRadius: '2px',
                        outline: 'none'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
                    >
                      ⬇️ Top-to-bottom
                    </Menubar.Item>
                    
                    <Menubar.Item
                      onClick={() => {
                        console.log('Bottom-to-top layout clicked');
                        if (autoLayoutRef.current) {
                          autoLayoutRef.current('BT');
                        }
                      }}
                      style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        color: '#333',
                        borderRadius: '2px',
                        outline: 'none'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
                    >
                      ⬆️ Bottom-to-top
                    </Menubar.Item>
                  </Menubar.SubContent>
                </Menubar.Portal>
              </Menubar.Sub>
              
            </Menubar.Content>
          </Menubar.Portal>
        </Menubar.Menu>
        
        {/* Objects Menu */}
        <Menubar.Menu>
          <Menubar.Trigger
          style={{
                padding: '0 16px',
                background: 'transparent',
                color: '#333',
            border: 'none',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: '500',
            transition: 'background-color 0.2s',
                display: 'flex',
                alignItems: 'center',
                height: '100%',
                borderRight: '1px solid #dee2e6'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#e9ecef';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              Objects
          </Menubar.Trigger>
          
          <Menubar.Portal>
            <Menubar.Content
              style={{
                background: 'white',
                border: '1px solid #ddd',
                borderRadius: '4px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                minWidth: '160px',
                padding: '4px'
              }}
                    sideOffset={4}
            >
              <Menubar.Item
                onClick={() => {
                  console.log('Add node clicked');
                  console.log('addNodeRef.current:', addNodeRef.current);
                  if (addNodeRef.current) {
                    addNodeRef.current();
                  } else {
                    console.log('addNodeRef.current is null');
                  }
                }}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#333',
                  borderRadius: '2px',
                  outline: 'none'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
              >
                ➕ Add node
              </Menubar.Item>
              
              <Menubar.Item
                onClick={() => {
                  console.log('Delete selected clicked');
                  if (deleteSelectedRef.current) {
                    deleteSelectedRef.current();
                  }
                }}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#333',
                  borderRadius: '2px',
                  outline: 'none'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#f8f9fa'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'white'}
              >
                🗑️ Delete selected
              </Menubar.Item>
            </Menubar.Content>
          </Menubar.Portal>
        </Menubar.Menu>
      </Menubar.Root>

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
      
      {/* Load Graph Modal */}
      <LoadGraphModal
        isOpen={showLoadModal}
        onClose={() => setShowLoadModal(false)}
        onLoadGraph={handleLoadGraph}
        selectedBranch="main"
        isLoading={false}
      />

      {/* Save Dialog */}
      {showSaveDialog && (
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
            width: '400px',
            maxWidth: '90vw'
          }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '16px' }}>Save Graph to Repository</h3>
            
            <div style={{ marginBottom: '12px' }}>
              <label style={{ 
                display: 'block', 
                fontSize: '12px', 
                fontWeight: '600', 
                marginBottom: '4px' 
              }}>
                Graph Name:
              </label>
              <input
                type="text"
                value={saveGraphName}
                onChange={(e) => setSaveGraphName(e.target.value)}
                placeholder="my-graph"
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '12px',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ 
                display: 'block', 
                fontSize: '12px', 
                fontWeight: '600', 
                marginBottom: '4px' 
              }}>
                Commit Message:
              </label>
              <textarea
                value={saveCommitMessage}
                onChange={(e) => setSaveCommitMessage(e.target.value)}
                placeholder="Add new conversion funnel"
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '12px',
                  minHeight: '60px',
                  resize: 'vertical',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            <div style={{ 
              display: 'flex', 
              gap: '8px', 
              justifyContent: 'flex-end' 
            }}>
              <button
                onClick={() => setShowSaveDialog(false)}
                style={{
                  background: '#6c757d',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '6px 12px',
                  fontSize: '12px',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveToRepository}
                disabled={!saveGraphName.trim() || !saveCommitMessage.trim()}
                style={{
                  background: '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  padding: '6px 12px',
                  fontSize: '12px',
                  cursor: (!saveGraphName.trim() || !saveCommitMessage.trim()) ? 'not-allowed' : 'pointer',
                  opacity: (!saveGraphName.trim() || !saveCommitMessage.trim()) ? 0.6 : 1
                }}
              >
                💾 Save to Repository
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

