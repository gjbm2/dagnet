import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from 'react';
import GraphCanvas from './components/GraphCanvas';
import PropertiesPanel from './components/PropertiesPanel';
import GitOperations from './components/GitOperations';
import WhatIfAnalysisControl from './components/WhatIfAnalysisControl';
import { loadFromSheet, saveToSheet } from './lib/sheetsClient';
import { decodeStateFromUrl, encodeStateToUrl } from './lib/shareUrl';
import { useGraphStore } from './lib/useGraphStore';
import { getValidator } from './lib/schema';
import './custom-reactflow.css';
export default function App() {
    const { graph, setGraph } = useGraphStore();
    const [ajvValidate, setAjvValidate] = useState(null);
    const [errors, setErrors] = useState([]);
    const [selectedNodeId, setSelectedNodeId] = useState(null);
    const [selectedEdgeId, setSelectedEdgeId] = useState(null);
    const [edgeScalingMode, setEdgeScalingMode] = useState('global-log-mass');
    const [autoReroute, setAutoReroute] = useState(false);
    // Load schema validator once
    useEffect(() => {
        getValidator().then(setAjvValidate).catch(e => setErrors([String(e)]));
    }, []);
    // Initial load: from ?data, ?graph, or from Sheet
    useEffect(() => {
        // Check if this is a data request from Apps Script
        const urlParams = new URLSearchParams(window.location.search);
        const getData = urlParams.get('getdata');
        const sessionId = urlParams.get('session');
        const graphParam = urlParams.get('graph');
        if (getData === 'true' && sessionId) {
            // This is a request from Apps Script to get the current data
            const currentData = localStorage.getItem('dagnet_graph_data_' + sessionId);
            if (currentData) {
                // Return the data as plain text
                document.body.innerHTML = currentData;
                return;
            }
            else {
                document.body.innerHTML = 'null';
                return;
            }
        }
        // Check for graph parameter to load from repository
        if (graphParam) {
            loadGraphFromRepository(graphParam).then(g => {
                if (g) {
                    setGraph(g);
                }
                else {
                    console.error('Failed to load graph from repository:', graphParam);
                    // Fall back to default graph
                    loadDefaultGraph();
                }
            });
            return;
        }
        const decoded = decodeStateFromUrl();
        if (decoded) {
            setGraph(decoded);
            return;
        }
        loadFromSheet().then(g => {
            if (g) {
                setGraph(g);
            }
            else {
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
            loadDefaultGraph();
        });
    }, [setGraph]);
    // Helper function to load default graph
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
    };
    // Helper function to load graph from repository
    const loadGraphFromRepository = async (graphName) => {
        try {
            console.log('Loading graph from repository:', graphName);
            // Import the Git service
            const { graphGitService } = await import('./services/graphGitService');
            // Load the graph from the default repository
            const result = await graphGitService.getGraph(graphName, 'main');
            console.log('Graph loading result:', result);
            if (result.success && result.data) {
                console.log('Successfully loaded graph:', result.data);
                return result.data;
            }
            else {
                console.error('Failed to load graph:', result.error || result.message);
                return null;
            }
        }
        catch (error) {
            console.error('Error loading graph from repository:', error);
            return null;
        }
    };
    const validateNow = useMemo(() => {
        return () => {
            if (!ajvValidate || !graph)
                return [];
            const ok = ajvValidate(graph);
            const errs = ok ? [] : (ajvValidate.errors || []).map((e) => `${e.instancePath} ${e.message}`);
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
            if (!graph) {
                console.error('Cannot save: graph is null');
                return;
            }
            try {
                // Reorder JSON to put metadata first with description at the top
                const reorderedGraph = {
                    metadata: {
                        description: graph.metadata?.description || 'Graph created in Dagnet',
                        ...graph.metadata
                    },
                    nodes: graph.nodes,
                    edges: graph.edges,
                    policies: graph.policies
                };
                // Stringify without line breaks for better cell readability
                const updatedJson = JSON.stringify(reorderedGraph);
                console.log('Form POST to:', appsScriptUrl);
                console.log('Data length:', updatedJson.length);
                // Build a hidden form that POSTs to Apps Script
                const form = document.createElement('form');
                form.method = 'POST';
                form.action = appsScriptUrl; // doPost in Apps Script
                form.style.display = 'none';
                const addField = (name, value) => {
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
            }
            catch (error) {
                alert('Save failed: ' + error);
                return;
            }
        }
        // Original save logic for normal usage
        try {
            await saveToSheet(graph);
            alert('Saved to Sheet.');
        }
        catch (error) {
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
    const handleDoubleClickNode = (id, field) => {
        setSelectedNodeId(id);
        setSelectedEdgeId(null);
        // Focus the field after a short delay to ensure the properties panel has updated
        setTimeout(() => {
            const input = document.querySelector(`input[data-field="${field}"]`);
            if (input) {
                input.focus();
                input.select();
            }
        }, 100);
    };
    const handleDoubleClickEdge = (id, field) => {
        setSelectedEdgeId(id);
        setSelectedNodeId(null);
        // Focus the field after a short delay to ensure the properties panel has updated
        setTimeout(() => {
            const input = document.querySelector(`input[data-field="${field}"]`);
            if (input) {
                input.focus();
                input.select();
            }
        }, 100);
    };
    const handleSelectEdge = (id) => {
        setSelectedEdgeId(id);
        setSelectedNodeId(null);
    };
    return (_jsxs("div", { style: {
            display: 'grid',
            gridTemplateColumns: '1fr 350px',
            height: '100vh',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
        }, children: [_jsx("div", { style: { position: 'relative' }, children: _jsx(GraphCanvas, { onSelectedNodeChange: setSelectedNodeId, onSelectedEdgeChange: setSelectedEdgeId, onDoubleClickNode: handleDoubleClickNode, onDoubleClickEdge: handleDoubleClickEdge, onSelectEdge: handleSelectEdge, edgeScalingMode: edgeScalingMode, autoReroute: autoReroute }) }), _jsxs("div", { style: {
                    display: 'flex',
                    flexDirection: 'column',
                    height: '100vh',
                    background: '#fff',
                    borderLeft: '1px solid #e9ecef'
                }, children: [_jsx("div", { style: { padding: '16px', borderBottom: '1px solid #e9ecef' }, children: _jsx(GitOperations, { onGraphLoad: setGraph, onGraphSave: async (graphName, graphData) => {
                                // This is a placeholder - the actual save is handled in GitOperations
                                return true;
                            }, currentGraph: graph, currentGraphName: graph?.metadata?.description || 'untitled' }) }), _jsx("div", { style: { padding: '16px', borderBottom: '1px solid #e9ecef' }, children: _jsx(WhatIfAnalysisControl, {}) }), _jsx("div", { style: { flex: 1, overflow: 'hidden' }, children: _jsx(PropertiesPanel, { selectedNodeId: selectedNodeId, onSelectedNodeChange: setSelectedNodeId, selectedEdgeId: selectedEdgeId, onSelectedEdgeChange: setSelectedEdgeId }) })] }), _jsxs("div", { style: {
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
                    alignItems: 'center',
                }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '8px' }, children: [_jsx("label", { style: { fontSize: '12px', fontWeight: '500', color: '#495057' }, children: "Edge Scaling:" }), _jsxs("select", { value: edgeScalingMode, onChange: (e) => setEdgeScalingMode(e.target.value), style: {
                                    padding: '4px 8px',
                                    border: '1px solid #ced4da',
                                    borderRadius: '4px',
                                    fontSize: '12px',
                                    background: 'white',
                                    cursor: 'pointer',
                                }, children: [_jsx("option", { value: "uniform", children: "Uniform" }), _jsx("option", { value: "local-mass", children: "Local Mass" }), _jsx("option", { value: "global-mass", children: "Global Mass" }), _jsx("option", { value: "global-log-mass", children: "Global Log Mass" })] })] }), _jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '8px' }, children: [_jsx("label", { style: { fontSize: '12px', fontWeight: '500', color: '#495057' }, children: "Auto Re-route:" }), _jsx("input", { type: "checkbox", checked: autoReroute, onChange: (e) => setAutoReroute(e.target.checked), style: {
                                    width: '16px',
                                    height: '16px',
                                    cursor: 'pointer',
                                } })] }), _jsx("button", { onClick: onSave, style: {
                            padding: '8px 16px',
                            background: '#007bff',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '14px',
                            fontWeight: '500',
                            transition: 'background-color 0.2s',
                        }, onMouseEnter: (e) => e.currentTarget.style.background = '#0056b3', onMouseLeave: (e) => e.currentTarget.style.background = '#007bff', children: "Save" }), _jsx("button", { onClick: onDownload, style: {
                            padding: '8px 16px',
                            background: '#28a745',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '14px',
                            fontWeight: '500',
                            transition: 'background-color 0.2s',
                        }, onMouseEnter: (e) => e.currentTarget.style.background = '#1e7e34', onMouseLeave: (e) => e.currentTarget.style.background = '#28a745', children: "Download" }), _jsx("button", { onClick: onShare, style: {
                            padding: '8px 16px',
                            background: '#6c757d',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '14px',
                            fontWeight: '500',
                            transition: 'background-color 0.2s',
                        }, onMouseEnter: (e) => e.currentTarget.style.background = '#545b62', onMouseLeave: (e) => e.currentTarget.style.background = '#6c757d', children: "Share" })] }), errors.length > 0 && (_jsxs("div", { style: {
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
                }, children: [_jsx("div", { style: {
                            fontWeight: '600',
                            color: '#721c24',
                            marginBottom: '8px',
                            fontSize: '14px'
                        }, children: "Schema Errors:" }), _jsx("ul", { style: {
                            margin: 0,
                            paddingLeft: '16px',
                            color: '#721c24',
                            fontSize: '12px',
                            lineHeight: '1.4'
                        }, children: errors.map((e, i) => (_jsx("li", { children: e }, i))) })] }))] }));
}
